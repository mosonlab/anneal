import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPOSE_DATABASE_DEFAULTS,
  COMPOSE_PUBLISHED_PORT,
  DEFAULT_API_PORT,
  DEFAULT_MERGE_TRAIN_WIDTH,
  DEVELOPER_PREVIEW,
  LOOPBACK_HOST,
  MAX_MERGE_TRAIN_WIDTH,
  StartupConfigError,
  evaluateStartupConfig,
  loadStartupConfig,
  mergeTrainWidth,
} from "./startup-config.js";
import { spawnedSourceEntrypointArgv, spawnedStartupEnvironment } from "./test-startup-environment.js";

const repositoryFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

/** A generated local configuration plus the required read-only GitHub
 *  credential: random, distinct, base64url tokens, a 32-byte base64 key, and a
 *  database URL whose credentials are the same generated value Compose reads. */
const generatedEnvironment = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const password = randomBytes(24).toString("base64url");
  const base: Record<string, string> = {
    POSTGRES_DB: "agentos",
    POSTGRES_USER: "agentos",
    POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgresql://agentos:${password}@127.0.0.1:5432/agentos?schema=public`,
    API_HOST: LOOPBACK_HOST,
    API_PORT: "3000",
    OPERATOR_TOKEN: randomBytes(32).toString("base64url"),
    RUNNER_TOKEN: randomBytes(32).toString("base64url"),
    GITHUB_READ_TOKEN: randomBytes(32).toString("base64url"),
    SESSION_COOKIE_SECRET: randomBytes(32).toString("base64"),
    AGENTOS_SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
  const environment: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
};

const refusalReasons = (environment: NodeJS.ProcessEnv): string[] => {
  const verdict = evaluateStartupConfig(environment);
  assert.equal(verdict.ok, false, "the configuration was accepted");
  return verdict.ok ? [] : verdict.reasons;
};

test("a generated local configuration starts the control plane on loopback", () => {
  const verdict = evaluateStartupConfig(generatedEnvironment());
  assert.ok(verdict.ok, `generated configuration refused: ${verdict.ok ? "" : verdict.reasons.join(", ")}`);
  assert.equal(verdict.config.mode, DEVELOPER_PREVIEW);
  assert.equal(verdict.config.host, LOOPBACK_HOST);
  assert.equal(verdict.config.port, 3000);
  assert.equal(typeof verdict.config.githubReadToken, "string");
  assert.notEqual(verdict.config.githubReadToken, "");
});

test("an unset API_HOST and API_PORT resolve to the loopback default, never the wildcard", () => {
  const verdict = evaluateStartupConfig(generatedEnvironment({ API_HOST: undefined, API_PORT: undefined }));
  assert.ok(verdict.ok);
  assert.equal(verdict.config.host, "127.0.0.1");
  assert.equal(verdict.config.port, DEFAULT_API_PORT);
});

test("every non-loopback listener spelling is refused", () => {
  for (const host of ["0.0.0.0", "::", "::1", "[::1]", "localhost", "127.0.0.2", "192.168.1.10", "", "0"]) {
    assert.deepEqual(
      refusalReasons(generatedEnvironment({ API_HOST: host })),
      ["api-host-not-loopback:API_HOST"],
      `API_HOST=${host} was accepted`,
    );
  }
});

test("port 0 is accepted as the explicit request for an ephemeral loopback port", () => {
  // Refusing it would push the production-shaped harnesses onto fixed ports,
  // and the nearest fixed port is the operator's 3000.
  const verdict = evaluateStartupConfig(generatedEnvironment({ API_PORT: "0" }));
  assert.ok(verdict.ok, `API_PORT=0 refused: ${verdict.ok ? "" : verdict.reasons.join(", ")}`);
  assert.equal(verdict.config.host, LOOPBACK_HOST);
  assert.equal(verdict.config.port, 0);
});

test("an unusable listener port is refused", () => {
  for (const port of ["00", "70000", "03000", "port", "-1", "3000.5"]) {
    assert.deepEqual(
      refusalReasons(generatedEnvironment({ API_PORT: port })),
      ["api-port-invalid:API_PORT"],
      `API_PORT=${port} was accepted`,
    );
  }
});

test("merge train width defaults to zero and is included in validated startup config", () => {
  const verdict = evaluateStartupConfig(generatedEnvironment({ MERGE_TRAIN_WIDTH: undefined }));
  assert.ok(verdict.ok);
  assert.equal(verdict.config.mergeTrainWidth, DEFAULT_MERGE_TRAIN_WIDTH);
});

test("merge train width accepts each integer from zero through its configured maximum", () => {
  for (let width = DEFAULT_MERGE_TRAIN_WIDTH; width <= MAX_MERGE_TRAIN_WIDTH; width += 1) {
    const verdict = evaluateStartupConfig(generatedEnvironment({ MERGE_TRAIN_WIDTH: String(width) }));
    assert.ok(verdict.ok, `MERGE_TRAIN_WIDTH=${width} was refused`);
    assert.equal(verdict.config.mergeTrainWidth, width);
  }
});

test("an invalid merge train width is refused with a named startup reason", () => {
  for (const width of ["4", "-1", "1.5", "", "00", "width"]) {
    assert.deepEqual(
      refusalReasons(generatedEnvironment({ MERGE_TRAIN_WIDTH: width })),
      ["merge-train-width-invalid:MERGE_TRAIN_WIDTH"],
      `MERGE_TRAIN_WIDTH=${width} was accepted`,
    );
  }
});

test("the ambient merge train width reader refuses an unparseable value", () => {
  assert.equal(mergeTrainWidth({}), DEFAULT_MERGE_TRAIN_WIDTH);
  assert.equal(mergeTrainWidth({ MERGE_TRAIN_WIDTH: " 2 " }), 2);
  // A width the startup verdict would refuse must never be read as the legacy
  // path: the worker would silently resume per-chain drift recovery.
  for (const width of ["4", "-1", "1.5", "", "00", "width"]) {
    assert.throws(
      () => mergeTrainWidth({ MERGE_TRAIN_WIDTH: width }),
      (error: unknown) => error instanceof StartupConfigError
        && error.message.includes("merge-train-width-invalid:MERGE_TRAIN_WIDTH"),
      `MERGE_TRAIN_WIDTH=${width} was read instead of refused`,
    );
  }
});

test("a missing, placeholder, short or shared principal token is refused", () => {
  assert.deepEqual(refusalReasons(generatedEnvironment({ OPERATOR_TOKEN: undefined })), ["missing:OPERATOR_TOKEN"]);
  assert.deepEqual(refusalReasons(generatedEnvironment({ RUNNER_TOKEN: undefined })), ["missing:RUNNER_TOKEN"]);
  for (const sentinel of ["CHANGE_ME", "changeme", "TODO", "PLACEHOLDER", "REPLACE_ME", "", "password", "agentos"]) {
    assert.ok(
      refusalReasons(generatedEnvironment({ OPERATOR_TOKEN: sentinel })).includes("placeholder-value:OPERATOR_TOKEN"),
      `OPERATOR_TOKEN=${sentinel} was accepted`,
    );
  }
  assert.deepEqual(refusalReasons(generatedEnvironment({ RUNNER_TOKEN: "short-token" })), ["secret-too-short:RUNNER_TOKEN"]);

  // The one that matters most: two principals, one credential. The runner fleet
  // would hold operator authority, and every 403 in auth.ts would be vacuous.
  const shared = randomBytes(32).toString("base64url");
  assert.deepEqual(
    refusalReasons(generatedEnvironment({ OPERATOR_TOKEN: shared, RUNNER_TOKEN: shared })),
    ["operator-runner-token-identical"],
  );
});

test("a missing, blank, or published placeholder GitHub read token is refused", () => {
  const example = readFileSync(fileURLToPath(new URL("../../../.env.example", import.meta.url)), "utf8");
  const publishedPlaceholder = /^GITHUB_READ_TOKEN=(.*)$/mu.exec(example)?.[1];
  assert.equal(publishedPlaceholder, "CHANGE_ME");
  assert.deepEqual(
    refusalReasons(generatedEnvironment({ GITHUB_READ_TOKEN: undefined })),
    ["missing:GITHUB_READ_TOKEN"],
  );
  assert.deepEqual(
    refusalReasons(generatedEnvironment({ GITHUB_READ_TOKEN: "" })),
    ["placeholder-value:GITHUB_READ_TOKEN"],
  );
  assert.deepEqual(
    refusalReasons(generatedEnvironment({ GITHUB_READ_TOKEN: publishedPlaceholder })),
    ["placeholder-value:GITHUB_READ_TOKEN"],
  );
  assert.deepEqual(
    refusalReasons(generatedEnvironment({ GITHUB_READ_TOKEN: "  PLACEHOLDER  " })),
    ["placeholder-value:GITHUB_READ_TOKEN"],
  );
});

test("a merge-executor credential aliased onto an existing principal is refused at startup", () => {
  const environment = generatedEnvironment();
  assert.deepEqual(
    refusalReasons({ ...environment, MERGE_EXECUTOR_TOKEN: environment["OPERATOR_TOKEN"] }),
    ["merge-executor-token-aliased"],
  );
  assert.deepEqual(
    refusalReasons({ ...environment, MERGE_EXECUTOR_TOKEN: environment["RUNNER_TOKEN"] }),
    ["merge-executor-token-aliased"],
  );
  // A distinct executor credential, and an unconfigured one, both start.
  assert.ok(evaluateStartupConfig({ ...environment, MERGE_EXECUTOR_TOKEN: randomBytes(32).toString("base64url") }).ok);
  assert.ok(evaluateStartupConfig({ ...environment, MERGE_EXECUTOR_TOKEN: "" }).ok);
});

test("a malformed encryption key is refused before anything is encrypted with it", () => {
  assert.deepEqual(
    refusalReasons(generatedEnvironment({ AGENTOS_SECRET_ENCRYPTION_KEY: undefined })),
    ["missing:AGENTOS_SECRET_ENCRYPTION_KEY"],
  );
  assert.deepEqual(
    refusalReasons(generatedEnvironment({ AGENTOS_SECRET_ENCRYPTION_KEY: "CHANGE_ME" })),
    ["placeholder-value:AGENTOS_SECRET_ENCRYPTION_KEY"],
  );
  for (const key of [randomBytes(31).toString("base64"), randomBytes(33).toString("base64")]) {
    assert.deepEqual(
      refusalReasons(generatedEnvironment({ AGENTOS_SECRET_ENCRYPTION_KEY: key })),
      ["encryption-key-not-32-bytes:AGENTOS_SECRET_ENCRYPTION_KEY"],
    );
  }
  // The rule secrets.ts applies at first use: exactly 32 decoded bytes.
  assert.ok(evaluateStartupConfig(generatedEnvironment({
    AGENTOS_SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  })).ok);
});

test("a key that is not base64 is refused even when Node would decode 32 bytes out of it", () => {
  // Node's decoder discards characters outside the alphabet, so every value
  // below decodes to the same 32 bytes as the well-formed key inside it. A
  // check written as "decodes to 32 bytes" calls all of them well-formed.
  const key = randomBytes(32).toString("base64");
  const malformed = [
    `!!!!${key}`,
    `${key}!!!!`,
    `${key.slice(0, 20)} ${key.slice(20)}`,
    `${key.slice(0, 20)}\n${key.slice(20)}`,
    key.replace(/=+$/u, ""),
    randomBytes(32).toString("base64url"),
    "not base64 at all!",
  ];
  for (const value of malformed) {
    assert.deepEqual(
      refusalReasons(generatedEnvironment({ AGENTOS_SECRET_ENCRYPTION_KEY: value })),
      ["encryption-key-not-base64:AGENTOS_SECRET_ENCRYPTION_KEY"],
      `${JSON.stringify(value.slice(0, 16))}… was accepted`,
    );
  }
  // The premise of the test, stated rather than assumed: the loose decoder
  // really does return 32 bytes for the first four of these.
  for (const value of malformed.slice(0, 5)) {
    assert.equal(Buffer.from(value, "base64").length, 32, `${JSON.stringify(value.slice(0, 16))}… is not the 32-byte case`);
  }
});

test("placeholder and inconsistent database configuration is refused", () => {
  assert.deepEqual(refusalReasons(generatedEnvironment({ DATABASE_URL: undefined })), ["missing:DATABASE_URL"]);
  assert.ok(refusalReasons(generatedEnvironment({
    DATABASE_URL: "postgresql://agentos:CHANGE_ME@127.0.0.1:5432/agentos?schema=public",
    POSTGRES_PASSWORD: "CHANGE_ME",
  })).includes("placeholder-value:DATABASE_URL"));
  assert.deepEqual(
    refusalReasons(generatedEnvironment({ DATABASE_URL: "not a url" })),
    ["database-url-unparsable:DATABASE_URL"],
  );
  assert.ok(refusalReasons(generatedEnvironment({
    DATABASE_URL: "mysql://agentos:passwordthatislongenough@127.0.0.1:3306/agentos?schema=public",
    POSTGRES_PASSWORD: "passwordthatislongenough",
  })).includes("database-url-not-postgres:DATABASE_URL"));

  // An unnamed schema fails the release preflight at migration time; refusing it
  // at startup means a fresh install learns before it has any data to lose.
  const unnamed = generatedEnvironment();
  const stripped = String(unnamed["DATABASE_URL"]).replace("?schema=public", "");
  assert.deepEqual(
    refusalReasons({ ...unnamed, DATABASE_URL: stripped }),
    ["database-url-schema-unnamed:DATABASE_URL"],
  );

  // Compose reads POSTGRES_* from the same file. Disagreement means one of the
  // two is wrong and nothing here can say which.
  const mismatched = generatedEnvironment();
  assert.deepEqual(
    refusalReasons({ ...mismatched, POSTGRES_PASSWORD: randomBytes(24).toString("base64url") }),
    ["database-credentials-disagree:POSTGRES_PASSWORD"],
  );
  assert.deepEqual(
    refusalReasons({ ...mismatched, POSTGRES_USER: "someone-else" }),
    ["database-credentials-disagree:POSTGRES_USER"],
  );
  assert.deepEqual(
    refusalReasons({ ...mismatched, POSTGRES_DB: "other-database" }),
    ["database-credentials-disagree:POSTGRES_DB"],
  );
});

test("an unset POSTGRES_* is Compose's default, not an absence to skip over", () => {
  // docker-compose.yml writes every one of these as `${VAR:-agentos}`, so an
  // operator who sets none of them still gets a database with the well-known
  // password `agentos` on the published port. Judging only the variables that
  // happen to be set misses exactly that case.
  const withoutCompose = (databaseUrl: string): NodeJS.ProcessEnv =>
    generatedEnvironment({
      POSTGRES_DB: undefined,
      POSTGRES_USER: undefined,
      POSTGRES_PASSWORD: undefined,
      DATABASE_URL: databaseUrl,
    });

  // Every placeholder the generator knows about, and Compose's own default.
  for (const password of ["TODO", "PLACEHOLDER", "changeme", "REPLACE_ME", "agentos"]) {
    const reasons = refusalReasons(withoutCompose(`postgresql://agentos:${password}@127.0.0.1:5432/agentos?schema=public`));
    assert.ok(
      reasons.includes("placeholder-value:DATABASE_URL_PASSWORD"),
      `password ${password} was accepted: ${reasons.join(", ") || "no reasons"}`,
    );
  }

  // A random password with no POSTGRES_PASSWORD beside it is the other half:
  // Compose will use `agentos`, the URL says something else, and exactly one of
  // them is what the database actually has.
  const random = randomBytes(24).toString("base64url");
  assert.deepEqual(
    refusalReasons(withoutCompose(`postgresql://agentos:${random}@127.0.0.1:5432/agentos?schema=public`)),
    ["database-credentials-disagree:POSTGRES_PASSWORD"],
  );
  // Same for the user and the database name.
  assert.ok(refusalReasons(withoutCompose(`postgresql://someone-else:${random}@127.0.0.1:5432/agentos?schema=public`))
    .includes("database-credentials-disagree:POSTGRES_USER"));
  assert.ok(refusalReasons(withoutCompose(`postgresql://agentos:${random}@127.0.0.1:5432/other?schema=public`))
    .includes("database-credentials-disagree:POSTGRES_DB"));

  // A URL with no port at all is the Compose endpoint too: 5432 is Postgres's
  // default and the port Compose publishes.
  assert.ok(refusalReasons(withoutCompose("postgresql://agentos:agentos@127.0.0.1/agentos?schema=public"))
    .includes("placeholder-value:DATABASE_URL_PASSWORD"));
});

test("a database that is not the one Compose starts is judged as a client's, not as Compose's", () => {
  // The gate stands up a throwaway Postgres on an ephemeral port with the
  // password `agentos`, and points DATABASE_URL at it. That server is not this
  // repository's Compose database: its credentials are its own, and comparing
  // them against Compose's defaults would refuse every dbtest run. What still
  // applies is the vocabulary that means "nobody configured this yet".
  const scratch = (url: string): NodeJS.ProcessEnv =>
    generatedEnvironment({
      POSTGRES_DB: undefined,
      POSTGRES_USER: undefined,
      POSTGRES_PASSWORD: undefined,
      DATABASE_URL: url,
    });

  assert.ok(
    evaluateStartupConfig(scratch("postgresql://agentos:agentos@127.0.0.1:55777/agentos_gate?schema=agentos_gate")).ok,
    "the gate's own scratch database was refused",
  );
  assert.deepEqual(
    refusalReasons(scratch("postgresql://agentos:TODO@127.0.0.1:55777/agentos_gate?schema=agentos_gate")),
    ["placeholder-value:DATABASE_URL_PASSWORD"],
  );
});

test("a URL field that will not percent-decode is a refusal, not a thrown URIError", () => {
  // `decodeURIComponent("%ZZ")` throws. Thrown out of the verdict it becomes a
  // startup crash that never reaches the stable exit-78 path this module exists
  // to provide.
  const cases: Array<[string, string]> = [
    ["postgresql://agentos:%ZZ@127.0.0.1:5432/agentos?schema=public", "database-url-undecodable:DATABASE_URL_PASSWORD"],
    ["postgresql://%E0%A4%A:pw@127.0.0.1:5432/agentos?schema=public", "database-url-undecodable:DATABASE_URL_USER"],
    ["postgresql://agentos:pw@127.0.0.1:5432/%ZZ?schema=public", "database-url-undecodable:DATABASE_URL_DATABASE"],
  ];
  for (const [url, expected] of cases) {
    const environment = generatedEnvironment({ DATABASE_URL: url });
    // The verdict is a value, not an exception, on every one of these.
    const verdict = evaluateStartupConfig(environment);
    assert.equal(verdict.ok, false, `${url} was accepted`);
    assert.ok(
      verdict.ok || verdict.reasons.includes(expected),
      `${url}: expected ${expected}, got ${verdict.ok ? "" : verdict.reasons.join(", ")}`,
    );
    // And it arrives through the stable exit-78 path.
    assert.throws(() => loadStartupConfig(environment), (error: unknown) => {
      assert.ok(error instanceof StartupConfigError);
      assert.equal(error.exitCode, 78);
      return true;
    });
  }
});

test("the Compose contract this module compares against is the one docker-compose.yml carries", () => {
  // These constants are a copy of a file that is not imported at startup, on
  // purpose: the check runs before any I/O. A copy that can go stale is only
  // safe if something reads the original.
  const compose = repositoryFile("docker-compose.yml");
  for (const [variable, expected] of Object.entries(COMPOSE_DATABASE_DEFAULTS)) {
    const match = new RegExp(`${variable}: [$][{]${variable}:-([^}]*)[}]`, "u").exec(compose);
    assert.ok(match, `docker-compose.yml no longer gives ${variable} a default`);
    assert.equal(match[1], expected, `${variable}'s Compose default drifted`);
  }
  const published = /- "127\.0\.0\.1:(\d+):(\d+)"/u.exec(compose);
  assert.ok(published, "docker-compose.yml no longer publishes Postgres on loopback");
  assert.equal(Number(published[1]), COMPOSE_PUBLISHED_PORT);
});

test("a percent-encoded password in the URL still counts as agreeing with Compose", () => {
  const password = "a-b/c+d=e?f-and-long-enough-to-pass";
  const url = new URL("postgresql://127.0.0.1:5432/agentos?schema=public");
  url.username = "agentos";
  url.password = encodeURIComponent(password);
  assert.ok(evaluateStartupConfig(generatedEnvironment({
    DATABASE_URL: url.toString(),
    POSTGRES_PASSWORD: password,
  })).ok);
});

test("a browser-exposed token variable is refused however it is spelled", () => {
  for (const variable of ["VITE_API_TOKEN", "VITE_OPERATOR_TOKEN", "VITE_TOKEN_FOR_ANYTHING"]) {
    assert.deepEqual(
      refusalReasons({ ...generatedEnvironment(), [variable]: "anything" }),
      [`browser-exposed-token:${variable}`],
    );
  }
});

test("an unsupported deployment mode is refused rather than treated as Developer Preview", () => {
  assert.deepEqual(refusalReasons(generatedEnvironment({ AGENTOS_MODE: "production" })), ["mode-unsupported:AGENTOS_MODE"]);
  assert.ok(evaluateStartupConfig(generatedEnvironment({ AGENTOS_MODE: DEVELOPER_PREVIEW })).ok);
});

test("no refusal reason ever echoes a configured value", () => {
  const marker = "MARKER-c2f4b1a7-value-that-must-not-be-printed";
  const environments: NodeJS.ProcessEnv[] = [
    generatedEnvironment({ OPERATOR_TOKEN: marker, RUNNER_TOKEN: marker }),
    generatedEnvironment({ API_HOST: marker }),
    generatedEnvironment({ API_PORT: marker }),
    generatedEnvironment({ AGENTOS_SECRET_ENCRYPTION_KEY: marker }),
    generatedEnvironment({ GITHUB_READ_TOKEN: marker, API_HOST: "0.0.0.0" }),
    generatedEnvironment({ DATABASE_URL: `postgresql://agentos:${marker}@127.0.0.1:5432/agentos` }),
    generatedEnvironment({ POSTGRES_PASSWORD: marker }),
    { ...generatedEnvironment(), VITE_API_TOKEN: marker },
    generatedEnvironment({ AGENTOS_MODE: marker }),
  ];
  for (const environment of environments) {
    const reasons = refusalReasons(environment);
    assert.ok(reasons.length > 0);
    for (const reason of reasons) assert.doesNotMatch(reason, /MARKER-/u, `reason echoed a value: ${reason}`);
    // The thrown error is what actually reaches a terminal or a log file.
    try {
      loadStartupConfig(environment);
      assert.fail("loadStartupConfig accepted a refused environment");
    } catch (error: unknown) {
      assert.ok(error instanceof StartupConfigError);
      assert.doesNotMatch(error.message, /MARKER-/u);
      assert.equal(error.exitCode, 78);
    }
  }
});

test("the published template is refused, so a copied .env cannot start the control plane", () => {
  // `.env.example` is documentation. Its placeholder values must not be a
  // startable configuration, or step 1's generator is optional in practice.
  const template: NodeJS.ProcessEnv = {};
  for (const line of repositoryFile(".env.example").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    template[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  const reasons = refusalReasons(template);
  assert.ok(reasons.includes("placeholder-value:OPERATOR_TOKEN"), reasons.join(", "));
  assert.ok(reasons.includes("operator-runner-token-identical"), reasons.join(", "));
  assert.ok(reasons.includes("placeholder-value:DATABASE_URL"), reasons.join(", "));
});

test("the sentinel vocabulary is the generator's, read from the generator", () => {
  // Two files decide what a placeholder is: the generator refuses to leave one
  // in `.env`, this module refuses to start on one. If they drift, a value one
  // of them calls a placeholder is a working credential to the other.
  const generator = repositoryFile("scripts/setup-local.mjs");
  const literal = (name: string): string[] => {
    const match = new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\)`, "u").exec(generator);
    assert.ok(match?.[1], `${name} not found in scripts/setup-local.mjs`);
    return JSON.parse(match[1].replace(/\.\.\.SENTINEL_VALUES,\s*/u, "")) as string[];
  };
  const sentinels = literal("SENTINEL_VALUES");
  const weak = [...sentinels, ...literal("WEAK_SECRET_VALUES")];

  const environment = generatedEnvironment();
  for (const value of sentinels) {
    assert.ok(
      refusalReasons({ ...environment, AGENTOS_SECRET_ENCRYPTION_KEY: value })
        .includes("placeholder-value:AGENTOS_SECRET_ENCRYPTION_KEY"),
      `the generator calls ${JSON.stringify(value)} a placeholder and this module does not`,
    );
  }
  for (const value of weak) {
    assert.ok(
      refusalReasons({ ...environment, OPERATOR_TOKEN: value }).includes("placeholder-value:OPERATOR_TOKEN"),
      `the generator calls ${JSON.stringify(value)} a weak secret and this module does not`,
    );
  }
  // And the shortest acceptable secret is the same number on both sides.
  const shortest = /const SHORTEST_ACCEPTABLE_SECRET = (\d+);/u.exec(generator)?.[1];
  assert.equal(shortest, "24");
  assert.ok(refusalReasons({ ...environment, OPERATOR_TOKEN: "x".repeat(23) }).includes("secret-too-short:OPERATOR_TOKEN"));
  assert.ok(evaluateStartupConfig({ ...environment, OPERATOR_TOKEN: "x".repeat(24) }).ok);
});

test("index.ts calls loadStartupConfig before it acquires ownership or reads the database", () => {
  // The value of this module is entirely in when it runs. Pin the order by
  // source: the call must precede the first ownership acquisition, the first
  // Prisma import and the reconciliation call.
  const index = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const startupCall = index.indexOf("loadStartupConfig(");
  assert.ok(startupCall > 0, "index.ts never calls loadStartupConfig");
  for (const later of ["acquireControlPlaneOwnership(", "reconcileAtStartup(", "serve({"]) {
    const position = index.indexOf(later);
    assert.ok(position > 0, `index.ts no longer contains ${later}`);
    assert.ok(startupCall < position, `loadStartupConfig runs after ${later}`);
  }
  // And the listener host comes from the validated config, not from a second
  // read of the environment with its own default.
  assert.doesNotMatch(index, /process\.env\.API_HOST/u);
  assert.doesNotMatch(index, /0\.0\.0\.0/u);
});

test("the real API entrypoint refuses a blank GitHub read token before opening a socket", {
  // The source entrypoint imports the native Files/state guard before the
  // startup verdict. Environments that have not built that optional native
  // test dependency cannot exercise a real child entrypoint here.
  skip: !existsSync(fileURLToPath(new URL("../build/Release/control_plane_directory.node", import.meta.url))),
}, async () => {
  const output: string[] = [];
  const child = spawn(process.execPath, spawnedSourceEntrypointArgv("src/index.ts"), {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      ...spawnedStartupEnvironment({
        DATABASE_URL: "postgresql://invalid:invalid-fixture-password-000000@127.0.0.1:1/never-contact?schema=public",
        // Keep the key present so dotenv cannot refill it from the checkout's
        // root .env before startup validation runs.
        GITHUB_READ_TOKEN: "",
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`API entrypoint did not refuse startup: ${output.join("")}`));
      // Bounded so an entrypoint that never refuses is reported as a failure
      // rather than hanging the suite. What it has to cover is a full
      // `node --import tsx` startup of the production entrypoint, sized for the
      // loaded gate worker rather than an idle host (CONTRIBUTING.md, "Test
      // timing on the gate worker"). The wait ends as soon as the child exits.
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  const diagnostic = output.join("");
  assert.equal(result.code, 78, diagnostic);
  assert.match(diagnostic, /GITHUB_READ_TOKEN/u);
  assert.doesNotMatch(diagnostic, /Anneal API listening|Startup reconciliation|CONTROL_PLANE_OWNERSHIP_ACQUIRED/u);
});
