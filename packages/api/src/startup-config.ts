/**
 * What the control plane checks about its own configuration before it does
 * anything at all.
 *
 * The failure this exists to prevent is not a crash — it is a control plane that
 * starts successfully while being wrong: listening on every interface, holding a
 * placeholder token that a published document names, or handing the runner the
 * operator's authority because one value was pasted twice. Each of those is
 * silent at startup and expensive afterwards.
 *
 * Two rules shape the implementation:
 *
 * 1. It runs before any I/O. `index.ts` calls it as its first act, before
 *    ownership acquisition, before Prisma is imported, before reconciliation and
 *    long before a socket is bound. A refusal therefore cannot half-start a
 *    control plane.
 * 2. It never echoes a value. Every reason is a stable code plus the variable
 *    name, because these reasons are printed to a terminal, a log file and a
 *    launchd stdout that nobody redacts.
 */

import { decodeStrictBase64 } from "./base64.js";

/** The only deployment shape the developer preview supports. Anything else is refused rather
 *  than silently treated as this one. */
export const DEVELOPER_PREVIEW = "developer-preview";

/** The only address the Developer Preview control plane may listen on. */
export const LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_API_PORT = 3000;

/** Merge readiness keeps its existing single-candidate path until an operator
 * explicitly enables cumulative trains. The small upper bound also bounds the
 * amount of work and lease time one train can hold. */
export const DEFAULT_MERGE_TRAIN_WIDTH = 0;
export const MAX_MERGE_TRAIN_WIDTH = 3;

const MERGE_TRAIN_WIDTH_PATTERN = /^(?:0|[1-3])$/u;

const HIGHEST_PORT = 65_535;

/** Mirrors `scripts/setup-local.mjs`. `startup-config.test.ts` compares the two
 *  by reading that file, so a sentinel added there cannot be accepted here. */
const SENTINEL_VALUES = new Set(["", "CHANGE_ME", "CHANGEME", "TODO", "PLACEHOLDER", "REPLACE_ME", "changeme"]);
const WEAK_SECRET_VALUES = new Set([...SENTINEL_VALUES, "secret", "password", "postgres", "agentos"]);
/** Same floor as the generator, which mints 32 random bytes as base64url. */
const SHORTEST_ACCEPTABLE_SECRET = 24;

const SECRET_VARIABLES = ["OPERATOR_TOKEN", "RUNNER_TOKEN", "SESSION_COOKIE_SECRET", "POSTGRES_PASSWORD"] as const;

/**
 * What `docker-compose.yml` will actually use.
 *
 * Every `POSTGRES_*` there is written `${VAR:-agentos}`, so an unset variable is
 * not an absent value — it is `agentos`, on a published port, as the password of
 * the database this checkout starts. Judging only the variables an operator
 * happens to have set therefore misses the case that matters most: the one where
 * they set none of them.
 *
 * `startup-config.test.ts` reads `docker-compose.yml` and compares, so a change
 * there cannot leave these stale.
 */
export const COMPOSE_DATABASE_DEFAULTS = Object.freeze({
  POSTGRES_DB: "agentos",
  POSTGRES_USER: "agentos",
  POSTGRES_PASSWORD: "agentos",
});

/** The port `docker-compose.yml` publishes Postgres on, and Postgres's own
 *  default — which is what a URL with no port means. */
export const COMPOSE_PUBLISHED_PORT = 5432;

/** Every spelling of "this machine" a database URL can carry. */
const LOOPBACK_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type StartupConfig = {
  mode: typeof DEVELOPER_PREVIEW;
  host: string;
  port: number;
  /** The already-validated read-only GitHub credential for API workers. */
  githubReadToken: string;
  /** Number of candidates a merge-readiness train may contain. */
  mergeTrainWidth: number;
};

export type StartupConfigVerdict =
  | { ok: true; config: StartupConfig }
  | { ok: false; reasons: string[] };

/** Refusal, already reduced to printable reasons. Exit code 78 is `EX_CONFIG`:
 *  a supervisor that restarts on failure learns nothing by restarting this. */
export class StartupConfigError extends Error {
  readonly reasons: string[];
  readonly exitCode = 78;

  constructor(reasons: string[]) {
    super(`Anneal API refuses to start: ${reasons.join(", ")}`);
    this.name = "StartupConfigError";
    this.reasons = reasons;
  }
}

const isPlaceholder = (variable: string, value: string): boolean =>
  (SECRET_VARIABLES as readonly string[]).includes(variable)
    ? WEAK_SECRET_VALUES.has(value)
    : SENTINEL_VALUES.has(value);

/** A required secret: present, not a sentinel, not trivially short. */
const checkSecret = (reasons: string[], variable: string, value: string | undefined): void => {
  if (value === undefined) {
    reasons.push(`missing:${variable}`);
    return;
  }
  if (isPlaceholder(variable, value)) {
    reasons.push(`placeholder-value:${variable}`);
    return;
  }
  if (value.length < SHORTEST_ACCEPTABLE_SECRET) reasons.push(`secret-too-short:${variable}`);
};

const checkTokens = (reasons: string[], env: NodeJS.ProcessEnv): void => {
  checkSecret(reasons, "OPERATOR_TOKEN", env["OPERATOR_TOKEN"]);
  checkSecret(reasons, "RUNNER_TOKEN", env["RUNNER_TOKEN"]);
  // Distinctness is not a strength property, so it is checked even when both
  // values are otherwise refused: one token for two principals means the runner
  // fleet holds operator authority, which no amount of entropy fixes.
  const operator = env["OPERATOR_TOKEN"];
  if (operator !== undefined && operator === env["RUNNER_TOKEN"]) reasons.push("operator-runner-token-identical");
  // The merge executor authenticates mechanical merges. `auth.ts` already
  // refuses an aliased value at request time; refusing it here too means the
  // deployment learns at startup instead of at the first merge.
  const executor = env["MERGE_EXECUTOR_TOKEN"];
  if (executor !== undefined && executor !== "" && (executor === operator || executor === env["RUNNER_TOKEN"])) {
    reasons.push("merge-executor-token-aliased");
  }
  // Optional in this repository, but a placeholder is never acceptable.
  const cookie = env["SESSION_COOKIE_SECRET"];
  if (cookie !== undefined) checkSecret(reasons, "SESSION_COOKIE_SECRET", cookie);
};

/**
 * GitHub reads are required by the API, but their token format is owned by
 * GitHub and may change. Check only the presence/sentinel contract here; the
 * API must not guess at authorization or impose a token-length policy.
 */
const checkGitHubReadToken = (reasons: string[], env: NodeJS.ProcessEnv): void => {
  const variable = "GITHUB_READ_TOKEN";
  const value = env[variable];
  if (value === undefined) {
    reasons.push(`missing:${variable}`);
    return;
  }
  const normalized = value.trim();
  if (isPlaceholder(variable, normalized)) {
    reasons.push(`placeholder-value:${variable}`);
  }
};

const checkEncryptionKey = (reasons: string[], env: NodeJS.ProcessEnv): void => {
  const variable = "AGENTOS_SECRET_ENCRYPTION_KEY";
  const value = env[variable];
  if (value === undefined) {
    reasons.push(`missing:${variable}`);
    return;
  }
  if (SENTINEL_VALUES.has(value)) {
    reasons.push(`placeholder-value:${variable}`);
    return;
  }
  // The same rule `secrets.ts` applies when a Run first needs a Secret, through
  // the same strict parser. Applying it at startup turns "the key is malformed"
  // from a runtime surprise mid-run into a refusal before anything is encrypted
  // with a key that cannot decrypt.
  //
  // Syntax before length, and both: Node's base64 decoder discards characters
  // outside the alphabet, so `"!!!!" + key` decodes to the same 32 bytes as
  // `key` and a length-only check calls it well-formed.
  const decoded = decodeStrictBase64(value);
  if (decoded === null) {
    reasons.push(`encryption-key-not-base64:${variable}`);
    return;
  }
  if (decoded.length !== 32) reasons.push(`encryption-key-not-32-bytes:${variable}`);
};

const checkListener = (reasons: string[], env: NodeJS.ProcessEnv): { host: string; port: number } => {
  const configuredHost = env["API_HOST"];
  const host = configuredHost === undefined ? LOOPBACK_HOST : configuredHost.trim();
  // `0.0.0.0`, `::`, an empty value and a resolvable name are all ways of
  // listening somewhere other than the one address the Developer Preview
  // contract covers. There is no allowlist here on purpose: one literal.
  if (host !== LOOPBACK_HOST) reasons.push("api-host-not-loopback:API_HOST");

  const configuredPort = env["API_PORT"];
  const portText = configuredPort === undefined || configuredPort.trim() === ""
    ? String(DEFAULT_API_PORT)
    : configuredPort.trim();
  const port = Number(portText);
  // `0` is the one non-positive value that means something: ask the kernel for
  // an ephemeral port. The production-shaped tests spawn this entrypoint with
  // it precisely so a test process can never take the operator's port 3000, and
  // an ephemeral port on 127.0.0.1 is no less loopback than a fixed one. Every
  // other spelling — padded, signed, fractional, out of range — is refused.
  if (!/^(?:0|[1-9]\d{0,4})$/u.test(portText) || port > HIGHEST_PORT) reasons.push("api-port-invalid:API_PORT");

  return { host, port: Number.isSafeInteger(port) ? port : DEFAULT_API_PORT };
};

/** Read the validated train width for workers that receive configuration
 * outside the startup verdict. An omitted variable keeps the legacy path. */
export const mergeTrainWidth = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env["MERGE_TRAIN_WIDTH"];
  if (raw === undefined) return DEFAULT_MERGE_TRAIN_WIDTH;
  const normalized = raw.trim();
  return MERGE_TRAIN_WIDTH_PATTERN.test(normalized) ? Number(normalized) : DEFAULT_MERGE_TRAIN_WIDTH;
};

const checkMergeTrainWidth = (reasons: string[], env: NodeJS.ProcessEnv): number => {
  const raw = env["MERGE_TRAIN_WIDTH"];
  if (raw !== undefined && !MERGE_TRAIN_WIDTH_PATTERN.test(raw.trim())) {
    reasons.push("merge-train-width-invalid:MERGE_TRAIN_WIDTH");
  }
  return mergeTrainWidth(env);
};

/** Is this URL pointing at the database `docker-compose.yml` starts? Host and
 *  port only — the credentials are the thing being judged, so they cannot also
 *  be the thing that decides which rules apply. */
const isComposeEndpoint = (parsed: URL): boolean => {
  const port = parsed.port === "" ? COMPOSE_PUBLISHED_PORT : Number(parsed.port);
  return LOOPBACK_DATABASE_HOSTS.has(parsed.hostname) && port === COMPOSE_PUBLISHED_PORT;
};

/** A percent-decoded URL field, or `null` if it will not decode. `%ZZ` makes
 *  `decodeURIComponent` throw a `URIError`, and an exception thrown out of the
 *  verdict is a startup crash that never reaches the stable exit-78 path. */
const decodeField = (reasons: string[], field: string, raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    reasons.push(`database-url-undecodable:${field}`);
    return null;
  }
};

const checkDatabase = (reasons: string[], env: NodeJS.ProcessEnv): void => {
  const password = env["POSTGRES_PASSWORD"];
  // Judged on its own, before the URL: Compose reads this variable directly, so
  // `POSTGRES_PASSWORD=CHANGE_ME` is a placeholder credential on a published
  // port whatever the URL beside it says.
  if (password !== undefined) checkSecret(reasons, "POSTGRES_PASSWORD", password);

  const raw = env["DATABASE_URL"];
  if (raw === undefined) {
    reasons.push("missing:DATABASE_URL");
    return;
  }
  if (SENTINEL_VALUES.has(raw) || /(^|[:@/?=])CHANGE_ME([:@/?&]|$)/u.test(raw)) {
    reasons.push("placeholder-value:DATABASE_URL");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    reasons.push("database-url-unparsable:DATABASE_URL");
    return;
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    reasons.push("database-url-not-postgres:DATABASE_URL");
  }
  // The release preflight stops on a URL that does not name its schema
  // (packages/db/prisma/preflight-goal-execution.ts). A local checkout that
  // starts on such a URL only discovers that at migration time.
  if ((parsed.searchParams.get("schema") ?? "") === "") reasons.push("database-url-schema-unnamed:DATABASE_URL");

  const onComposeEndpoint = isComposeEndpoint(parsed);
  const urlPassword = decodeField(reasons, "DATABASE_URL_PASSWORD", parsed.password);
  const urlUser = decodeField(reasons, "DATABASE_URL_USER", parsed.username);
  const urlDatabase = decodeField(reasons, "DATABASE_URL_DATABASE", parsed.pathname.replace(/^\//u, ""));

  // The password carried inside the URL is a credential in its own right, and
  // an operator who never set `POSTGRES_PASSWORD` has no other value for this
  // check to reach. On the Compose endpoint the full weak set applies, because
  // `agentos` there is the well-known default of the database this repository
  // starts. Elsewhere the API is a client of a server this checkout does not
  // own — its password is that server's business — so only the placeholders
  // that mean "nobody has configured this yet" are refused. The gate's own
  // throwaway Postgres lives in exactly that second case.
  if (urlPassword !== null) {
    const refused = onComposeEndpoint ? WEAK_SECRET_VALUES.has(urlPassword) : SENTINEL_VALUES.has(urlPassword);
    if (refused) reasons.push("placeholder-value:DATABASE_URL_PASSWORD");
  }

  // Compose reads POSTGRES_* from the same file the API reads DATABASE_URL from.
  // When the two disagree, exactly one of them is what the database actually
  // has, and which one is not knowable from here. On the Compose endpoint an
  // unset variable still has an effective value, so the comparison is made
  // against that rather than skipped.
  const compare = (variable: keyof typeof COMPOSE_DATABASE_DEFAULTS, urlValue: string | null): void => {
    const configured = env[variable];
    const effective = configured ?? (onComposeEndpoint ? COMPOSE_DATABASE_DEFAULTS[variable] : undefined);
    if (effective === undefined || urlValue === null) return;
    if (urlValue !== effective) reasons.push(`database-credentials-disagree:${variable}`);
  };
  compare("POSTGRES_PASSWORD", urlPassword);
  compare("POSTGRES_USER", urlUser);
  compare("POSTGRES_DB", urlDatabase);
};

const checkBrowserExposure = (reasons: string[], env: NodeJS.ProcessEnv): void => {
  // Vite inlines every `VITE_*` variable into the bundle it ships to the
  // browser. A credential-shaped one is a credential in the browser whatever it
  // holds, and the preview's browser path is the proxy, which needs none.
  for (const variable of Object.keys(env)) {
    if (/^VITE_.*TOKEN/u.test(variable)) reasons.push(`browser-exposed-token:${variable}`);
  }
};

/**
 * Judge one environment. Pure: no I/O, no process state, no ambient default —
 * pass the environment in and read the verdict out, which is what makes the
 * whole policy testable without starting a control plane.
 */
export const evaluateStartupConfig = (env: NodeJS.ProcessEnv): StartupConfigVerdict => {
  const reasons: string[] = [];

  const mode = env["AGENTOS_MODE"];
  if (mode !== undefined && mode !== DEVELOPER_PREVIEW) reasons.push("mode-unsupported:AGENTOS_MODE");

  checkTokens(reasons, env);
  checkGitHubReadToken(reasons, env);
  checkEncryptionKey(reasons, env);
  const listener = checkListener(reasons, env);
  const configuredMergeTrainWidth = checkMergeTrainWidth(reasons, env);
  checkDatabase(reasons, env);
  checkBrowserExposure(reasons, env);

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    config: {
      mode: DEVELOPER_PREVIEW,
      host: listener.host,
      port: listener.port,
      // `checkGitHubReadToken` above guarantees this is a non-empty string on
      // the success path. Keep the token on the validated config so callers do
      // not re-read an ambient environment after startup has been judged.
      githubReadToken: env["GITHUB_READ_TOKEN"]!.trim(),
      mergeTrainWidth: configuredMergeTrainWidth,
    },
  };
};

/** The startup call. Throws `StartupConfigError`, whose message carries reasons
 *  and no values. */
export const loadStartupConfig = (env: NodeJS.ProcessEnv = process.env): StartupConfig => {
  const verdict = evaluateStartupConfig(env);
  if (!verdict.ok) throw new StartupConfigError(verdict.reasons);
  return verdict.config;
};
