/**
 * Tests for the release migration entry point (OSS-B0 plan Step 3).
 *
 * Two properties matter more than any individual refusal:
 *
 *  1. **No mutation before a stop.** Every refusal path asserts that the fake
 *     host was never asked to spawn *anything* — the migration command, and
 *     therefore `prisma migrate deploy`, cannot have run.
 *  2. **The composition cannot be silently removed.** The only mutating command
 *     the orchestrator may spawn is `npm run db:migrate-goal-execution`, and
 *     deleting or short-circuiting that call fails this suite.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  confirmLocalReleaseTarget,
  normaliseComposeProject,
  parseEnvFile,
  parsePublishedPort,
  planLocalReleaseTarget,
  readComposePostgres,
  type PlanInputs,
  type ServerIdentity,
} from "./local-release-target.js";
import { ARCHIVE_MEMBER, ATTESTATION_MEMBER, QUIESCENCE_TOKEN_V1, type BundleFacts } from "./backup-bundle.js";
import {
  DRIFT_CHECK_COMMAND,
  FILES_PRECHECK_COMMAND,
  MIGRATION_STATUS_COMMAND,
  parseArguments,
  RELEASE_CANDIDATE_MIGRATIONS,
  RELEASE_MIGRATION_COMMAND,
  readMigrationTail,
  releaseMigrate,
  type MaintenanceLockState,
  type MigrationState,
  type ReleaseMigrateHost,
  type SchemaCensus,
} from "./release-migrate.js";
import { CENSUS_CATALOGUES, SCHEMA_CENSUS_SQL } from "./schema-census.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/+$/u, "");

const PASSWORD = "gK7-generated-local-value_9xQ";

/**
 * Built through `URL` rather than interpolated, for the same reason
 * `scripts/setup-local.mjs` does it: the structure does the escaping, and no
 * connection-string literal has to exist in a file inside the public snapshot
 * scope.
 */
const urlFor = (parts: {
  protocol?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  schema?: string | null;
} = {}): string => {
  const url = new URL(`${parts.protocol ?? "postgresql"}://${parts.host ?? "127.0.0.1"}:${parts.port ?? 5432}`);
  url.username = parts.user ?? "agentos";
  url.password = parts.password ?? PASSWORD;
  url.pathname = `/${parts.database ?? "agentos"}`;
  const schema = parts.schema === undefined ? "public" : parts.schema;
  if (schema !== null) url.searchParams.set("schema", schema);
  return url.href;
};

const PLACEHOLDER_PASSWORD = ["CHANGE", "ME"].join("_");
const GATED_URL = urlFor();

const COMPOSE_LOOPBACK = `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: \${POSTGRES_DB:-agentos}
      POSTGRES_USER: \${POSTGRES_USER:-agentos}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-agentos}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - agentos_postgres_data:/var/lib/postgresql/data

volumes:
  agentos_postgres_data:
`;

const envFile = (url = GATED_URL): string => `# generated
POSTGRES_DB=agentos
POSTGRES_USER=agentos
POSTGRES_PASSWORD=${PASSWORD}
DATABASE_URL=${url}
`;

const EMPTY_CENSUS: SchemaCensus = { migrationsTable: false, relations: 0, types: 0, routines: 0, others: 0 };
const IDENTITY: ServerIdentity = { database: "agentos", user: "agentos", fingerprint: "0123456789abcdef" };

/**
 * A bundle that should be accepted, and the pieces every refusal below changes
 * exactly one of. The digests are literals rather than computed values: a test
 * that hashed the same bytes the implementation hashes would agree with itself
 * even if both were wrong.
 */
const TARGET_FINGERPRINT = "0123456789abcdef0123456789abcdef";
const WAL_FINGERPRINT = "fedcba9876543210fedcba9876543210";
const ARCHIVE_SHA256 = "ab".repeat(32);
const ARCHIVE_BYTES = 4096;
const NOW_MS = Date.parse("2026-08-19T12:00:00Z");

const attestationText = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  version: 1,
  createdAt: new Date(NOW_MS - 60_000).toISOString(),
  archive: { bytes: ARCHIVE_BYTES, sha256: ARCHIVE_SHA256 },
  targetFingerprint: TARGET_FINGERPRINT,
  walFingerprint: WAL_FINGERPRINT,
  quiescence: QUIESCENCE_TOKEN_V1,
  ...overrides,
});

const bundleFacts = (overrides: Partial<BundleFacts> = {}): BundleFacts => ({
  isDirectory: true,
  directoryMode: 0o700,
  entries: [
    { name: ARCHIVE_MEMBER, kind: "file", mode: 0o600 },
    { name: ATTESTATION_MEMBER, kind: "file", mode: 0o600 },
  ],
  archive: { bytes: ARCHIVE_BYTES, sha256: ARCHIVE_SHA256, magic: "PGDMP" },
  attestationText: attestationText(),
  ...overrides,
});

const APPLIED_TAIL = 12;

interface FakeHost extends ReleaseMigrateHost {
  spawned: Array<{ argv: readonly string[]; env: Readonly<Record<string, string>> }>;
  out: string[];
  err: string[];
  lockReleases: number;
  /** Commands that were still running when the orchestrator aborted them. */
  aborted: string[];
  /** Every host call that touches the database, in the order it happened. The
   *  #155 round-2 review's TOCTOU finding is an ordering claim, so the fake has
   *  to be able to state the order rather than the set. */
  order: string[];
}

interface FakeOptions {
  env?: string | null;
  compose?: string | null;
  processEnv?: Record<string, string | undefined>;
  containers?: readonly string[];
  identity?: ServerIdentity | null;
  census?: SchemaCensus | null;
  migrations?: readonly string[];
  exitCodes?: Record<string, number>;
  /** `true` grants the lock; a string is the refusal reason the client gave. */
  lock?: boolean | string;
  /** What the lock says when the orchestrator re-verifies it before deploying.
   *  Defaults to still held. */
  lockRetained?: boolean;
  /** The lock's backend dies just before this command returns its exit code —
   *  a session terminated while `prisma migrate deploy` was writing. */
  lockDiesBeforeExitOf?: string;
  /** The lock's backend dies as this command starts, and the command then runs
   *  until something aborts it. */
  lockDiesDuring?: string;
  /** How many retention checks the watchdog gets before its clock stops
   *  answering. Zero — the default — means the watchdog only wakes on abort, so
   *  a test that does not exercise it sees no extra verification. */
  watchdogTicks?: number;
  /** Existing mode's lock-state read. `null` is an unreadable state. */
  holders?: MaintenanceLockState | null;
  /** The bundle `--existing` was pointed at. `null` is an unreadable path. */
  bundle?: BundleFacts | null;
  /** What the target answers when asked who it is. */
  targetFingerprint?: string | null;
  /** Where the target's write-ahead log is right now. */
  walFingerprint?: string | null;
  /** `_prisma_migrations`, as existing mode reads it. */
  migrationState?: MigrationState | null;
  /** The clock bundle age is judged against. */
  nowMs?: number;
}

const recordedMigrations = (): readonly string[] => {
  const names: string[] = [];
  for (let index = 0; index < RELEASE_CANDIDATE_MIGRATIONS.count - 1; index += 1) {
    names.push(`2026081${String(index).padStart(7, "0")}_filler_${index}`);
  }
  names.push(RELEASE_CANDIDATE_MIGRATIONS.terminal);
  return names;
};

const fakeHost = (options: FakeOptions = {}): FakeHost => {
  const spawned: Array<{ argv: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const counters = { lockReleases: 0 };
  const order: string[] = [];
  const aborted: string[] = [];
  const state = { lockAlive: true, ticks: options.watchdogTicks ?? 0 };
  return {
    spawned,
    out,
    err,
    order,
    aborted,
    get lockReleases() { return counters.lockReleases; },
    repositoryRoot: "/checkout",
    processEnv: options.processEnv ?? {},
    readTextFile: (absolutePath) => {
      if (absolutePath === "/checkout/.env") return options.env === undefined ? envFile() : options.env;
      if (absolutePath === "/checkout/docker-compose.yml") return options.compose === undefined ? COMPOSE_LOOPBACK : options.compose;
      return null;
    },
    listMigrationDirectories: () => options.migrations ?? recordedMigrations(),
    composeProject: () => "agentos",
    listComposeContainers: async () => options.containers ?? ["c0ffee"],
    readServerIdentity: async () => {
      order.push("readServerIdentity");
      return options.identity === undefined ? IDENTITY : options.identity;
    },
    inspectSchema: async () => {
      order.push("inspectSchema");
      return options.census === undefined ? EMPTY_CENSUS : options.census;
    },
    acquireMaintenanceLock: async () => {
      order.push("acquireMaintenanceLock");
      const requested = options.lock ?? false;
      if (requested !== true) {
        return { ok: false, reason: typeof requested === "string" ? requested : "lock-connection-unavailable" };
      }
      return {
        ok: true,
        lock: {
          verifyStillHeld: async () => {
            order.push("verifyStillHeld");
            return state.lockAlive && (options.lockRetained ?? true);
          },
          release: async () => {
            order.push("release");
            counters.lockReleases += 1;
          },
        },
      };
    },
    inspectMaintenanceLock: async () => {
      order.push("inspectMaintenanceLock");
      return options.holders === undefined ? { exclusive: 0, shared: 0, waiting: 0 } : options.holders;
    },
    inspectBackupBundle: async () => {
      order.push("inspectBackupBundle");
      return options.bundle === undefined ? bundleFacts() : options.bundle;
    },
    readTargetFingerprint: async () => {
      order.push("readTargetFingerprint");
      return options.targetFingerprint === undefined ? TARGET_FINGERPRINT : options.targetFingerprint;
    },
    readWalFingerprint: async () => {
      order.push("readWalFingerprint");
      return options.walFingerprint === undefined ? WAL_FINGERPRINT : options.walFingerprint;
    },
    readMigrationState: async () => {
      order.push("readMigrationState");
      if (options.migrationState !== undefined) return options.migrationState;
      return { present: true, applied: recordedMigrations().slice(0, APPLIED_TAIL), unresolved: [] };
    },
    nowMs: () => options.nowMs ?? NOW_MS,
    run: async (argv, env, runOptions) => {
      const key = argv.join(" ");
      order.push(`run:${key}`);
      spawned.push({ argv, env });
      if (options.lockDiesDuring === key) {
        // The backend is gone, and the child does not know: it keeps running
        // until someone terminates it. That someone is the watchdog.
        state.lockAlive = false;
        await new Promise<void>((resolve) => {
          const signal = runOptions?.signal;
          if (signal === undefined || signal.aborted) { resolve(); return; }
          signal.addEventListener("abort", () => { resolve(); }, { once: true });
        });
        aborted.push(key);
        return 143;
      }
      // The narrower case the review names: the session dies while the command
      // is finishing, and the command still exits 0.
      if (options.lockDiesBeforeExitOf === key) state.lockAlive = false;
      return options.exitCodes?.[key] ?? 0;
    },
    wait: async (_milliseconds, signal) => {
      if (signal.aborted) return;
      if (state.ticks > 0) { state.ticks -= 1; return; }
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { resolve(); }, { once: true });
      });
    },
    log: (line) => { out.push(line); },
    logStop: (line) => { err.push(line); },
  };
};

/** The property the composition-integrity case checks, in one place so the
 *  altered copy below is judged by exactly the assertion the real code passes. */
const assertComposedExactlyOnce = (host: FakeHost): void => {
  assert.equal(
    host.spawned.filter((entry) => entry.argv.join(" ") === RELEASE_MIGRATION_COMMAND.join(" ")).length,
    1,
    "a passing --fresh run must have spawned the composed migration command exactly once",
  );
};

/** The mutation spy: a stop must mean nothing was spawned at all. */
const assertNoMutation = (host: FakeHost): void => {
  assert.deepEqual(host.spawned, [], "a stop must not spawn any command");
};

const stops = (host: FakeHost): string[] =>
  host.err.map((line) => line.replace(/^STOP release-migrate /u, "").split(":")[0] as string);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

describe("parseArguments", () => {
  it("accepts exactly one mode", () => {
    assert.deepEqual(parseArguments(["--fresh"]), { ok: true, mode: { kind: "fresh" } });
    assert.deepEqual(parseArguments(["--existing", "--backup-bundle", "/tmp/bundle"]), {
      ok: true,
      mode: { kind: "existing", backupBundle: "/tmp/bundle" },
    });
  });

  it("refuses no mode, both modes, and a repeated mode", () => {
    assert.equal(parseArguments([]).ok, false);
    assert.deepEqual(parseArguments(["--fresh", "--existing"]), { ok: false, reason: "both-modes-requested" });
    assert.deepEqual(parseArguments(["--fresh", "--fresh"]), { ok: false, reason: "mode-repeated" });
  });

  it("requires an absolute backup bundle for existing mode only", () => {
    assert.deepEqual(parseArguments(["--existing"]), { ok: false, reason: "existing-mode-requires---backup-bundle" });
    assert.deepEqual(parseArguments(["--existing", "--backup-bundle", "relative/dir"]), { ok: false, reason: "backup-bundle-not-absolute" });
    assert.deepEqual(parseArguments(["--existing", "--backup-bundle"]), { ok: false, reason: "backup-bundle-value-missing" });
    assert.deepEqual(parseArguments(["--fresh", "--backup-bundle", "/tmp/bundle"]), {
      ok: false,
      reason: "backup-bundle-is-not-a-fresh-mode-argument",
    });
  });

  it("has no preflight escape and no unknown arguments", () => {
    for (const flag of ["--force", "--skip-preflight", "--no-preflight"]) {
      assert.deepEqual(parseArguments(["--fresh", flag]), { ok: false, reason: "preflight-escape-flags-are-not-supported" });
    }
    assert.deepEqual(parseArguments(["--fresh", "--yes"]), { ok: false, reason: "unsupported-argument" });
  });
});

// ---------------------------------------------------------------------------
// Compose and target resolution
// ---------------------------------------------------------------------------

describe("compose model", () => {
  it("reads the postgres service's environment and published port", () => {
    const service = readComposePostgres(COMPOSE_LOOPBACK, parseEnvFile(envFile()));
    assert.ok(service);
    assert.equal(service.environment.get("POSTGRES_DB"), "agentos");
    assert.equal(service.environment.get("POSTGRES_PASSWORD"), PASSWORD);
    assert.deepEqual(service.ports, ["127.0.0.1:5432:5432"]);
  });

  it("reads the checkout's own docker-compose.yml", () => {
    const text = readFileSync(`${repositoryRoot}/docker-compose.yml`, "utf8");
    const service = readComposePostgres(text, parseEnvFile(envFile()));
    assert.ok(service, "the shipped compose file must expose a postgres service to the target gate");
    assert.equal(service.ports.length, 1);
    assert.ok(parsePublishedPort(service.ports[0] as string), "the shipped port mapping must be resolvable");
  });

  it("parses both published-port spellings and rejects anything else", () => {
    assert.deepEqual(parsePublishedPort("5432:5432"), { bind: null, port: 5432 });
    assert.deepEqual(parsePublishedPort("127.0.0.1:5432:5432"), { bind: "127.0.0.1", port: 5432 });
    assert.equal(parsePublishedPort("5432"), null);
    assert.equal(parsePublishedPort("${PORT}:5432"), null);
  });

  it("normalises the compose project name the way Docker Compose does", () => {
    assert.equal(normaliseComposeProject("Anneal"), "anneal");
    assert.equal(normaliseComposeProject("agentos-worktrees.b0"), "agentos-worktreesb0");
  });
});

describe("planLocalReleaseTarget", () => {
  const inputs = (overrides: Partial<PlanInputs> = {}): PlanInputs => ({
    envFile: envFile(),
    composeFile: COMPOSE_LOOPBACK,
    processEnv: {},
    composeProject: "agentos",
    ...overrides,
  });

  const conditions = (result: ReturnType<typeof planLocalReleaseTarget>): string[] =>
    result.ok ? [] : result.stops.map((stop) => stop.condition);

  it("accepts this checkout's loopback compose target", () => {
    const result = planLocalReleaseTarget(inputs());
    assert.ok(result.ok);
    assert.equal(result.plan.url, GATED_URL);
    assert.equal(result.plan.schema, "public");
    assert.equal(result.plan.compose.publishedPort, 5432);
    assert.deepEqual(result.plan.notices, []);
  });

  it("notices, but does not accept silently, a compose file that publishes on every interface", () => {
    const result = planLocalReleaseTarget(inputs({ composeFile: COMPOSE_LOOPBACK.replace('"127.0.0.1:5432:5432"', '"5432:5432"') }));
    assert.ok(result.ok);
    assert.deepEqual(result.plan.notices, ["compose-publishes-on-every-interface"]);
  });

  it("refuses a compose file that publishes on a named non-loopback address", () => {
    const result = planLocalReleaseTarget(inputs({ composeFile: COMPOSE_LOOPBACK.replace("127.0.0.1:5432:5432", "0.0.0.0:5432:5432") }));
    assert.deepEqual(conditions(result), ["compose-port"]);
  });

  it("refuses missing files, a missing service, and an ambiguous port", () => {
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ envFile: null }))), ["env-file"]);
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ composeFile: null }))), ["compose-file"]);
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ composeFile: "services:\n  api:\n    image: x\n" }))), ["compose-service"]);
    assert.deepEqual(
      conditions(planLocalReleaseTarget(inputs({ composeFile: COMPOSE_LOOPBACK.replace('      - "127.0.0.1:5432:5432"\n', '      - "127.0.0.1:5432:5432"\n      - "127.0.0.1:5433:5432"\n') }))),
      ["compose-port"],
    );
  });

  it("refuses a target that is not the compose database", () => {
    const cases: Array<[string, string]> = [
      ["target-schema", urlFor({ schema: null })],
      ["target-host", urlFor({ host: "localhost" })],
      ["target-host", urlFor({ host: "10.11.12.13" })],
      ["target-port", urlFor({ port: 55777 })],
      ["target-database", urlFor({ database: "other" })],
      ["target-user", urlFor({ user: "someone" })],
    ];
    for (const [condition, url] of cases) {
      assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ envFile: envFile(url) }))), [condition], url);
    }
  });

  it("refuses an unparsable, non-postgres, or absent URL", () => {
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ envFile: "POSTGRES_DB=agentos\nPOSTGRES_USER=agentos\n" }))), ["target-url"]);
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ envFile: envFile("not a url") }))), ["target-url"]);
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ envFile: envFile(urlFor({ protocol: "mysql" })) }))), ["target-url"]);
  });

  it("refuses a placeholder or mismatched credential", () => {
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ envFile: envFile(urlFor({ password: PLACEHOLDER_PASSWORD })) }))), ["target-credential"]);
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ envFile: envFile(urlFor({ password: "agentos" })) }))), ["target-credential"]);
    assert.deepEqual(conditions(planLocalReleaseTarget(inputs({ envFile: envFile(urlFor({ password: "another-strong-value" })) }))), ["target-credential"]);
  });

  it("refuses when an inherited DATABASE_URL disagrees with the checkout's .env", () => {
    const result = planLocalReleaseTarget(inputs({ processEnv: { DATABASE_URL: urlFor({ database: "production" }) } }));
    assert.deepEqual(conditions(result), ["env-conflict"]);
  });

  it("accepts an inherited DATABASE_URL that is the same value", () => {
    assert.equal(planLocalReleaseTarget(inputs({ processEnv: { DATABASE_URL: GATED_URL } })).ok, true);
  });
});

describe("confirmLocalReleaseTarget", () => {
  const plan = (() => {
    const result = planLocalReleaseTarget({ envFile: envFile(), composeFile: COMPOSE_LOOPBACK, processEnv: {}, composeProject: "agentos" });
    assert.ok(result.ok);
    return result.plan;
  })();

  it("requires exactly one running container with this checkout's labels", () => {
    for (const containers of [[], ["a", "b"]]) {
      const result = confirmLocalReleaseTarget(plan, { runningContainers: containers, serverIdentity: IDENTITY });
      assert.equal(result.ok, false);
      assert.deepEqual(result.ok ? [] : result.stops.map((stop) => stop.condition), ["compose-identity"]);
    }
  });

  it("requires the server to agree about which database and role it serves", () => {
    const unreachable = confirmLocalReleaseTarget(plan, { runningContainers: ["c0ffee"], serverIdentity: null });
    assert.deepEqual(unreachable.ok ? [] : unreachable.stops.map((stop) => stop.condition), ["server-identity"]);
    const wrong = confirmLocalReleaseTarget(plan, {
      runningContainers: ["c0ffee"],
      serverIdentity: { database: "production", user: "postgres", fingerprint: "x" },
    });
    assert.deepEqual(wrong.ok ? [] : wrong.stops.map((stop) => stop.condition), ["server-identity", "server-identity"]);
  });
});

// ---------------------------------------------------------------------------
// Migration tail
// ---------------------------------------------------------------------------

describe("migration tail", () => {
  it("records a release-candidate tail that is a prefix of the tail on disk", () => {
    const onDisk = readdirSync(`${packageRoot}/prisma/migrations`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const tail = readMigrationTail(onDisk);
    assert.ok(
      RELEASE_CANDIDATE_MIGRATIONS.count <= tail.count,
      "the recorded release-candidate tail cannot be longer than the migration tail on disk",
    );
    assert.equal(
      tail.names[RELEASE_CANDIDATE_MIGRATIONS.count - 1],
      RELEASE_CANDIDATE_MIGRATIONS.terminal,
      "the recorded terminal migration must be at its recorded position on disk",
    );
    // The complete set, not only its ends: existing mode subtracts the applied
    // history from this list to state what is still pending.
    assert.equal(tail.names.length, tail.count);
    assert.deepEqual([...tail.names].sort(), [...tail.names]);
  });

  it("orders by the timestamp prefix and ignores non-migration directories", () => {
    assert.deepEqual(readMigrationTail(["20260818210000_b", "20260815000000_a", "notes"]), {
      count: 2,
      terminal: "20260818210000_b",
      names: ["20260815000000_a", "20260818210000_b"],
    });
  });
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe("releaseMigrate --fresh", () => {
  it("gates, then composes db:migrate-goal-execution, then verifies", async () => {
    const host = fakeHost({ lock: true });
    assert.equal(await releaseMigrate(["--fresh"], host), 0);
    assert.deepEqual(host.spawned.map((entry) => entry.argv), [
      RELEASE_MIGRATION_COMMAND,
      MIGRATION_STATUS_COMMAND,
      DRIFT_CHECK_COMMAND,
    ]);
    assert.ok(host.out.includes("release-migrate PASS mode=fresh"));
    assert.ok(host.out.includes("release-migrate step=maintenance-lock result=acquired"));
    assert.ok(host.out.includes("release-migrate step=maintenance-lock result=released"));
    assert.equal(host.lockReleases, 1);
  });

  it("hands the migration command exactly the gated URL", async () => {
    const host = fakeHost({ lock: true, processEnv: { PATH: "/usr/bin" } });
    assert.equal(await releaseMigrate(["--fresh"], host), 0);
    const first = host.spawned[0];
    assert.ok(first);
    assert.equal(first.env["DATABASE_URL"], GATED_URL);
  });

  it("hides Prisma's update banner in every command it composes", async () => {
    // The banner is advisory and goes to stderr, where a deploy log cannot tell
    // it from a migration failure. Added to the child environment, so whatever
    // else the operator exported still reaches the command.
    const host = fakeHost({ lock: true, processEnv: { PATH: "/usr/bin" } });
    assert.equal(await releaseMigrate(["--fresh"], host), 0);
    assert.equal(host.spawned.length, 3);
    for (const entry of host.spawned) {
      assert.equal(entry.env["PRISMA_HIDE_UPDATE_MESSAGE"], "1", entry.argv.join(" "));
      assert.equal(entry.env["PATH"], "/usr/bin");
    }
  });

  it("declares the first run to the composed preflight, naming the schema it proved empty", async () => {
    const host = fakeHost({ lock: true });
    assert.equal(await releaseMigrate(["--fresh"], host), 0);
    for (const entry of host.spawned) {
      assert.equal(
        entry.env["GOAL5A0_FRESH_TARGET"], "public",
        "the declaration names the gated schema, so a stale export cannot follow the operator to another target",
      );
    }
  });

  it("never declares a first run on a target it refused", async () => {
    const host = fakeHost({
      lock: true,
      census: { migrationsTable: false, relations: 1, types: 0, routines: 0, others: 0 },
    });
    assert.notEqual(await releaseMigrate(["--fresh"], host), 0);
    assertNoMutation(host);
  });

  it("refuses a non-empty target before spawning anything", async () => {
    for (const census of [
      { migrationsTable: true, relations: 0, types: 0, routines: 0, others: 0 },
      { migrationsTable: false, relations: 3, types: 0, routines: 0, others: 0 },
      { migrationsTable: false, relations: 0, types: 2, routines: 0, others: 0 },
      { migrationsTable: false, relations: 0, types: 0, routines: 1, others: 0 },
      { migrationsTable: false, relations: 0, types: 0, routines: 0, others: 1 },
    ]) {
      const host = fakeHost({ lock: true, census });
      assert.equal(await releaseMigrate(["--fresh"], host), 1);
      assert.deepEqual(stops(host), ["target-not-empty"]);
      assertNoMutation(host);
    }
  });

  it("refuses a target it could not census", async () => {
    const host = fakeHost({ lock: true, census: null });
    assert.equal(await releaseMigrate(["--fresh"], host), 1);
    assertNoMutation(host);
  });

  it("refuses a checkout whose migration tail is not the recorded release candidate", async () => {
    const short = fakeHost({ lock: true, migrations: recordedMigrations().slice(1) });
    assert.equal(await releaseMigrate(["--fresh"], short), 1);
    assert.deepEqual(stops(short), ["migration-tail"]);
    assertNoMutation(short);

    const extra = fakeHost({ lock: true, migrations: [...recordedMigrations(), "20260901000000_unreleased"] });
    assert.equal(await releaseMigrate(["--fresh"], extra), 1);
    assert.deepEqual(stops(extra), ["migration-tail"]);
    assertNoMutation(extra);
  });

  it("refuses every target-identity failure before spawning anything", async () => {
    const cases: Array<[string, FakeOptions]> = [
      ["env-file", { env: null }],
      ["compose-file", { compose: null }],
      ["target-host", { env: envFile(urlFor({ host: "localhost" })) }],
      ["target-schema", { env: envFile(urlFor({ schema: null })) }],
      ["env-conflict", { processEnv: { DATABASE_URL: urlFor({ database: "other" }) } }],
      ["compose-identity", { containers: [] }],
      ["compose-identity", { containers: ["one", "two"] }],
      ["server-identity", { identity: null }],
      ["server-identity", { identity: { database: "production", user: "agentos", fingerprint: "x" } }],
    ];
    for (const [condition, options] of cases) {
      const host = fakeHost({ ...options, lock: true });
      assert.equal(await releaseMigrate(["--fresh"], host), 1, condition);
      assert.ok(stops(host).includes(condition), `${condition} not in ${stops(host).join(",")}`);
      assertNoMutation(host);
    }
  });

  it("stops at the composed command's own exit code and never verifies afterwards", async () => {
    const host = fakeHost({ lock: true, exitCodes: { [RELEASE_MIGRATION_COMMAND.join(" ")]: 1 } });
    assert.equal(await releaseMigrate(["--fresh"], host), 1);
    assert.deepEqual(host.spawned.map((entry) => entry.argv), [RELEASE_MIGRATION_COMMAND]);
    assert.deepEqual(stops(host), ["migrate-goal-execution"]);
  });

  it("propagates a failing status or drift check", async () => {
    const status = fakeHost({ lock: true, exitCodes: { [MIGRATION_STATUS_COMMAND.join(" ")]: 1 } });
    assert.equal(await releaseMigrate(["--fresh"], status), 1);
    assert.deepEqual(stops(status), ["migrate-status"]);

    const drift = fakeHost({ lock: true, exitCodes: { [DRIFT_CHECK_COMMAND.join(" ")]: 2 } });
    assert.equal(await releaseMigrate(["--fresh"], drift), 1);
    assert.deepEqual(stops(drift), ["drift-check"]);
  });

  it("prints no URL, password, or container id", async () => {
    const host = fakeHost({ lock: true });
    await releaseMigrate(["--fresh"], host);
    for (const line of [...host.out, ...host.err]) {
      assert.ok(!line.includes(PASSWORD), line);
      assert.ok(!line.includes(GATED_URL), line);
      assert.ok(!line.includes("c0ffee"), line);
    }
  });
});

describe("maintenance lock", () => {
  it("is acquired before any schema state is read, and released after the last command", async () => {
    // The #155 round-2 TOCTOU finding, as an assertion. An emptiness proof taken
    // before the lock is a proof about a database another process is still free
    // to write to, so the order — not the presence — is the property.
    const host = fakeHost({ lock: true });
    assert.equal(await releaseMigrate(["--fresh"], host), 0);
    assert.deepEqual(host.order, [
      "readServerIdentity",
      "acquireMaintenanceLock",
      "inspectSchema",
      "verifyStillHeld",
      `run:${RELEASE_MIGRATION_COMMAND.join(" ")}`,
      "verifyStillHeld",
      "verifyStillHeld",
      `run:${MIGRATION_STATUS_COMMAND.join(" ")}`,
      "verifyStillHeld",
      "verifyStillHeld",
      `run:${DRIFT_CHECK_COMMAND.join(" ")}`,
      "verifyStillHeld",
      "release",
    ]);
  });

  it("brackets every child command with a retention check, not just the first", async () => {
    // The structural form of the same claim, so that adding a fourth command
    // cannot quietly leave it unbracketed: every spawn in the order has a
    // verification immediately before it and immediately after it.
    const host = fakeHost({ lock: true });
    assert.equal(await releaseMigrate(["--fresh"], host), 0);
    const commands = host.order
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith("run:"));
    assert.equal(commands.length, 3);
    for (const { entry, index } of commands) {
      assert.equal(host.order[index - 1], "verifyStillHeld", `nothing verified the lock before ${entry}`);
      assert.equal(host.order[index + 1], "verifyStillHeld", `nothing verified the lock after ${entry}`);
    }
  });

  it("does not read the schema at all when the lock is refused", async () => {
    // The negative half of the ordering claim: a refused lock must not be
    // followed by the census "just to report it". Reading unlocked state is the
    // thing the order exists to prevent.
    const host = fakeHost({ lock: "shared-service-lock-held-by-an-active-service" });
    assert.equal(await releaseMigrate(["--fresh"], host), 1);
    assert.deepEqual(stops(host), ["maintenance-lock-unavailable"]);
    assert.deepEqual(host.order, ["readServerIdentity", "acquireMaintenanceLock"]);
    assertNoMutation(host);
  });

  it("names the holder that stood in the way, so the operator knows what to stop", async () => {
    for (const reason of [
      "shared-service-lock-held-by-an-active-service",
      "exclusive-maintenance-lock-held-by-another-session",
      "lock-connection-unavailable",
    ]) {
      const host = fakeHost({ lock: reason });
      assert.equal(await releaseMigrate(["--fresh"], host), 1);
      assert.deepEqual(host.err, [`STOP release-migrate maintenance-lock-unavailable: ${reason}`]);
    }
  });

  it("refuses to deploy under a lock it can no longer prove it holds", async () => {
    // A session lock dies with its connection. If the pool reconnected between
    // the census and the deploy, every proof taken under the lock was taken
    // about an unlocked database — so this stops rather than mutating.
    const host = fakeHost({ lock: true, lockRetained: false });
    assert.equal(await releaseMigrate(["--fresh"], host), 1);
    assert.deepEqual(stops(host), ["maintenance-lock-unavailable"]);
    assert.deepEqual(host.err, [
      "STOP release-migrate maintenance-lock-unavailable: lock-was-not-retained-before-migrate-goal-execution",
    ]);
    assertNoMutation(host);
    // Still released: the session is ours whether or not it still holds the key.
    assert.equal(host.lockReleases, 1);
  });

  it("no longer calls fresh mode preparatory, because the lock client is merged", async () => {
    const host = fakeHost({ lock: true });
    await releaseMigrate(["--fresh"], host);
    assert.ok(!host.out.some((line) => line.startsWith("release-migrate status=preparatory")), host.out.join("\n"));
  });

  it("calls neither mode preparatory, because both interfaces are merged", async () => {
    for (const argv of [["--fresh"], ["--existing", "--backup-bundle", "/tmp/bundle"]]) {
      const host = fakeHost({ lock: true });
      await releaseMigrate(argv, host);
      assert.ok(!host.out.some((line) => line.startsWith("release-migrate status=preparatory")), host.out.join("\n"));
    }
  });

  it("releases the lock even when the composed command fails", async () => {
    const host = fakeHost({ lock: true, exitCodes: { [RELEASE_MIGRATION_COMMAND.join(" ")]: 1 } });
    assert.equal(await releaseMigrate(["--fresh"], host), 1);
    assert.equal(host.lockReleases, 1);
    assert.ok(host.out.includes("release-migrate step=maintenance-lock result=released"));
  });

  it("does not believe a zero exit code from a command that outlived the lock", async () => {
    // The #164 review's reproduction. The migration command succeeds — exit 0,
    // nothing to complain about — but the lock's backend was terminated while
    // it was writing. A single pre-deploy verification would have accepted the
    // whole run: status and drift would follow and `PASS mode=fresh` would be
    // printed about a migration that finished without exclusivity.
    const host = fakeHost({ lock: true, lockDiesBeforeExitOf: RELEASE_MIGRATION_COMMAND.join(" ") });
    assert.equal(await releaseMigrate(["--fresh"], host), 1);
    assert.deepEqual(host.err, [
      "STOP release-migrate maintenance-lock-unavailable: lock-was-not-retained-during-migrate-goal-execution",
    ]);
    assert.deepEqual(
      host.spawned.map((entry) => entry.argv), [RELEASE_MIGRATION_COMMAND],
      "status and drift must not run once the lock is known to be gone",
    );
    assert.ok(!host.out.includes("release-migrate PASS mode=fresh"));
    assert.equal(host.lockReleases, 1);
  });

  it("terminates a still-running command the moment the lock stops being ours", async () => {
    // Detection after the fact is not enough: while the migration keeps
    // writing, a service or a second migrator can take the key it dropped. The
    // watchdog aborts, and the abort is what the host turns into a dead child.
    const host = fakeHost({
      lock: true,
      lockDiesDuring: RELEASE_MIGRATION_COMMAND.join(" "),
      watchdogTicks: 1,
    });
    assert.equal(await releaseMigrate(["--fresh"], host), 1);
    assert.deepEqual(host.aborted, [RELEASE_MIGRATION_COMMAND.join(" ")]);
    assert.deepEqual(host.err, [
      "STOP release-migrate maintenance-lock-unavailable: lock-was-not-retained-during-migrate-goal-execution",
    ]);
    assert.deepEqual(host.spawned.map((entry) => entry.argv), [RELEASE_MIGRATION_COMMAND]);
    assert.equal(host.lockReleases, 1);
  });

  it("stops before status when the lock is lost between two commands", async () => {
    const host = fakeHost({ lock: true, lockDiesBeforeExitOf: MIGRATION_STATUS_COMMAND.join(" ") });
    assert.equal(await releaseMigrate(["--fresh"], host), 1);
    assert.deepEqual(host.err, [
      "STOP release-migrate maintenance-lock-unavailable: lock-was-not-retained-during-migrate-status",
    ]);
    assert.deepEqual(host.spawned.map((entry) => entry.argv), [RELEASE_MIGRATION_COMMAND, MIGRATION_STATUS_COMMAND]);
    assert.ok(!host.out.includes("release-migrate PASS mode=fresh"));
  });
});

describe("releaseMigrate --existing", () => {
  const bundle = ["--existing", "--backup-bundle", "/tmp/bundle"];

  it("migrates an existing installation, under the lock, in plan line 144's order", async () => {
    const host = fakeHost({ lock: true });
    assert.equal(await releaseMigrate(bundle, host), 0);
    assert.deepEqual(host.order, [
      "readServerIdentity",
      // The bundle is judged before anything is locked, and the target it
      // claims is compared against the target that answers.
      "readTargetFingerprint",
      "inspectBackupBundle",
      "inspectMaintenanceLock",
      "acquireMaintenanceLock",
      // Only under the lock: a position read before it could move a
      // millisecond later.
      "readWalFingerprint",
      "readMigrationState",
      "verifyStillHeld", `run:${FILES_PRECHECK_COMMAND.join(" ")}`, "verifyStillHeld", "verifyStillHeld",
      `run:${RELEASE_MIGRATION_COMMAND.join(" ")}`, "verifyStillHeld", "verifyStillHeld",
      `run:${MIGRATION_STATUS_COMMAND.join(" ")}`, "verifyStillHeld", "verifyStillHeld",
      `run:${DRIFT_CHECK_COMMAND.join(" ")}`, "verifyStillHeld",
      "release",
    ]);
    assert.ok(host.out.includes("release-migrate PASS mode=existing"));
    assert.equal(host.lockReleases, 1);
  });

  it("runs the files precheck, which fresh mode has no files for", async () => {
    const existing = fakeHost({ lock: true });
    await releaseMigrate(bundle, existing);
    assert.ok(existing.spawned.some((entry) => entry.argv === FILES_PRECHECK_COMMAND));
    const fresh = fakeHost({ lock: true });
    await releaseMigrate(["--fresh"], fresh);
    assert.ok(!fresh.spawned.some((entry) => entry.argv === FILES_PRECHECK_COMMAND));
  });

  it("propagates a failing files precheck without migrating", async () => {
    const host = fakeHost({ lock: true, exitCodes: { [FILES_PRECHECK_COMMAND.join(" ")]: 3 } });
    assert.equal(await releaseMigrate(bundle, host), 1);
    assert.deepEqual(host.err, ["STOP release-migrate files-precheck: files-precheck-exited-3"]);
    assert.deepEqual(host.spawned.map((entry) => entry.argv), [FILES_PRECHECK_COMMAND]);
  });

  it("does not declare a first run, and clears an inherited declaration", async () => {
    // `GOAL5A0_FRESH_TARGET` tells the composed preflight to treat an empty
    // schema's data conditions as vacuous. An existing installation is not
    // empty and not a first run; inheriting that variable from the operator's
    // environment would hand the preflight a false statement.
    const host = fakeHost({ lock: true, processEnv: { GOAL5A0_FRESH_TARGET: "public" } });
    assert.equal(await releaseMigrate(bundle, host), 0);
    for (const entry of host.spawned) assert.equal(entry.env["GOAL5A0_FRESH_TARGET"], undefined);
  });

  it("still refuses a relative bundle path before anything else", async () => {
    const host = fakeHost();
    assert.equal(await releaseMigrate(["--existing", "--backup-bundle", "bundle"], host), 1);
    assert.deepEqual(stops(host), ["arguments"]);
    assertNoMutation(host);
  });

  it("refuses every structural fault in the bundle, before it locks anything", async () => {
    const cases: Array<[Partial<BundleFacts>, string]> = [
      [{ isDirectory: false }, "bundle-is-not-a-directory"],
      [{ directoryMode: 0o755 }, "bundle-directory-mode-is-not-0700"],
      [{ entries: [
        { name: ARCHIVE_MEMBER, kind: "file", mode: 0o600 },
        { name: ATTESTATION_MEMBER, kind: "file", mode: 0o600 },
        { name: "notes.txt", kind: "file", mode: 0o600 },
      ] }, "bundle-members-are-not-exactly-archive-dump-and-attestation-json"],
      [{ entries: [{ name: ARCHIVE_MEMBER, kind: "file", mode: 0o600 }] },
        "bundle-members-are-not-exactly-archive-dump-and-attestation-json"],
      [{ entries: [
        { name: ARCHIVE_MEMBER, kind: "symlink", mode: 0o600 },
        { name: ATTESTATION_MEMBER, kind: "file", mode: 0o600 },
      ] }, "bundle-member-is-not-a-regular-file"],
      [{ entries: [
        { name: ARCHIVE_MEMBER, kind: "file", mode: 0o644 },
        { name: ATTESTATION_MEMBER, kind: "file", mode: 0o600 },
      ] }, "bundle-member-mode-is-not-0600"],
      [{ archive: null }, "archive-is-unreadable"],
      [{ attestationText: null }, "attestation-is-unreadable"],
      [{ archive: { bytes: ARCHIVE_BYTES, sha256: ARCHIVE_SHA256, magic: "SQLit" } },
        "archive-is-not-a-postgresql-custom-format-dump"],
      [{ archive: { bytes: ARCHIVE_BYTES + 1, sha256: ARCHIVE_SHA256, magic: "PGDMP" } },
        "archive-length-disagrees-with-the-attestation"],
      [{ archive: { bytes: ARCHIVE_BYTES, sha256: "cd".repeat(32), magic: "PGDMP" } },
        "archive-digest-disagrees-with-the-attestation"],
      [{ attestationText: "{" }, "attestation-is-not-json"],
      [{ attestationText: attestationText({ version: 2 }) }, "attestation-version-is-unsupported"],
      [{ attestationText: attestationText({ quiescence: "attacker-controlled-lock-claim" }) },
        "attestation-quiescence-is-unsupported"],
      [{ attestationText: attestationText({ walFingerprint: "short" }) }, "attestation-is-malformed"],
      [{ attestationText: attestationText({ createdAt: "yesterday" }) }, "attestation-created-at-is-unparsable"],
      [{ attestationText: attestationText({ createdAt: new Date(NOW_MS - 16 * 60_000).toISOString() }) },
        "attestation-is-older-than-fifteen-minutes"],
      [{ attestationText: attestationText({ createdAt: new Date(NOW_MS + 61_000).toISOString() }) },
        "attestation-is-more-than-sixty-seconds-in-the-future"],
    ];
    for (const [overrides, reason] of cases) {
      const host = fakeHost({ lock: true, bundle: bundleFacts(overrides) });
      assert.equal(await releaseMigrate(bundle, host), 1);
      assert.deepEqual(host.err, [`STOP release-migrate backup-bundle: ${reason}`]);
      // The negative that makes each of these worth having: nothing was locked,
      // nothing was spawned, and the lock was never even read.
      assert.ok(!host.order.includes("acquireMaintenanceLock"), reason);
      assert.ok(!host.order.includes("inspectMaintenanceLock"), reason);
      assertNoMutation(host);
    }
  });

  it("treats an unreadable bundle path as a refusal, never as an absent one", async () => {
    const host = fakeHost({ lock: true, bundle: null });
    assert.equal(await releaseMigrate(bundle, host), 1);
    assert.deepEqual(host.err, ["STOP release-migrate backup-bundle: bundle-is-unreadable"]);
    assertNoMutation(host);
  });

  it("refuses a bundle taken from another target, and one whose target will not answer", async () => {
    const other = fakeHost({ lock: true, bundle: bundleFacts({ attestationText: attestationText({ targetFingerprint: "f".repeat(32) }) }) });
    assert.equal(await releaseMigrate(bundle, other), 1);
    assert.deepEqual(other.err, ["STOP release-migrate backup-target: attestation-describes-a-different-target"]);
    assertNoMutation(other);

    const silent = fakeHost({ lock: true, targetFingerprint: null });
    assert.equal(await releaseMigrate(bundle, silent), 1);
    assert.deepEqual(silent.err, ["STOP release-migrate backup-target: target-identity-fingerprint-unreadable"]);
    assert.ok(!silent.order.includes("inspectBackupBundle"));
  });

  it("refuses a target that was written to after the backup, and one whose position it cannot read", async () => {
    const written = fakeHost({ lock: true, walFingerprint: "9".repeat(32) });
    assert.equal(await releaseMigrate(bundle, written), 1);
    assert.deepEqual(written.err, ["STOP release-migrate backup-wal: target-was-written-to-after-the-backup"]);
    assertNoMutation(written);
    // The lock was taken before the comparison and released after it: the
    // window this ordering closes is the one where a writer moves the position
    // between the read and the migration.
    assert.equal(written.lockReleases, 1);

    const unreadable = fakeHost({ lock: true, walFingerprint: null });
    assert.equal(await releaseMigrate(bundle, unreadable), 1);
    assert.deepEqual(unreadable.err, ["STOP release-migrate backup-wal: current-wal-position-unreadable"]);
    assertNoMutation(unreadable);
  });

  it("refuses a held key, and refuses an unreadable lock state as if it were held", async () => {
    const cases: Array<[MaintenanceLockState | null, string, string]> = [
      [{ exclusive: 0, shared: 0, waiting: 0 }, "shared-service-lock-held-by-an-active-service",
        "shared-service-lock-held-by-an-active-service"],
      [null, "unused", "lock-state-unreadable"],
    ];
    for (const [holders, refusal, expected] of cases) {
      const host = fakeHost({ lock: holders === null ? true : refusal, holders });
      assert.equal(await releaseMigrate(bundle, host), 1);
      assert.deepEqual(host.err, [`STOP release-migrate maintenance-lock-unavailable: ${expected}`]);
      assertNoMutation(host);
      assert.equal(host.lockReleases, 0);
    }
  });

  it("refuses a migration history it cannot read, and one that is not there at all", async () => {
    const unreadable = fakeHost({ lock: true, migrationState: null });
    assert.equal(await releaseMigrate(bundle, unreadable), 1);
    assert.deepEqual(unreadable.err, ["STOP release-migrate migration-state: migration-history-unreadable"]);
    assertNoMutation(unreadable);

    const absent = fakeHost({ lock: true, migrationState: { present: false, applied: [], unresolved: [] } });
    assert.equal(await releaseMigrate(bundle, absent), 1);
    assert.deepEqual(absent.err, [
      "STOP release-migrate migration-state: target-has-no-migration-history-so-it-is-not-an-existing-installation",
    ]);
    assertNoMutation(absent);
  });

  it("refuses an unresolved migration rather than deploying on top of it", async () => {
    const applied = recordedMigrations().slice(0, APPLIED_TAIL);
    const host = fakeHost({
      lock: true,
      migrationState: { present: true, applied, unresolved: [applied[applied.length - 1] as string] },
    });
    assert.equal(await releaseMigrate(bundle, host), 1);
    assert.deepEqual(host.err, ["STOP release-migrate migration-state: unresolved-migrations-present-1"]);
    assertNoMutation(host);
  });

  it("refuses a history holding migrations this checkout does not contain", async () => {
    const host = fakeHost({
      lock: true,
      migrationState: { present: true, applied: [...recordedMigrations().slice(0, 3), "20250101000000_from_another_lineage"], unresolved: [] },
    });
    assert.equal(await releaseMigrate(bundle, host), 1);
    assert.deepEqual(host.err, [
      "STOP release-migrate migration-state: applied-migrations-absent-from-this-checkout-1",
    ]);
    assertNoMutation(host);
  });

  it("reports the complete pending set, not a count of what it felt like applying", async () => {
    const host = fakeHost({ lock: true });
    await releaseMigrate(bundle, host);
    const pending = RELEASE_CANDIDATE_MIGRATIONS.count - APPLIED_TAIL;
    assert.ok(host.out.includes(
      `release-migrate step=pending count=${pending} applied=${APPLIED_TAIL} terminal=${RELEASE_CANDIDATE_MIGRATIONS.terminal}`,
    ), host.out.join("\n"));
  });

  it("rejects a shorter or longer checkout tail in existing mode too", async () => {
    // Plan Step 3 line 139's seventh case, on the side that already has a
    // history: a checkout whose tail differs in either direction is not the
    // release candidate the authority evidence describes.
    for (const migrations of [
      recordedMigrations().slice(0, -1),
      [...recordedMigrations(), "20260901000000_unreleased"],
    ]) {
      const host = fakeHost({ lock: true, migrations });
      assert.equal(await releaseMigrate(bundle, host), 1);
      assert.deepEqual(host.err, [
        "STOP release-migrate migration-tail: checkout-tail-is-not-the-recorded-release-candidate-tail",
      ]);
      assertNoMutation(host);
      assert.equal(host.lockReleases, 1);
    }
  });

  it("refuses an unproven target before it opens the bundle at all", async () => {
    const host = fakeHost({ lock: true, identity: { database: "production", user: "agentos", fingerprint: "x" } });
    assert.equal(await releaseMigrate(bundle, host), 1);
    assert.ok(stops(host).includes("server-identity"));
    assert.ok(!host.order.includes("inspectBackupBundle"), host.order.join(","));
    assert.ok(!host.order.includes("acquireMaintenanceLock"), host.order.join(","));
  });

  it("prints no path, URL, password, or digest of the archive it accepted", async () => {
    const host = fakeHost({ lock: true });
    await releaseMigrate(bundle, host);
    for (const line of [...host.out, ...host.err]) {
      assert.ok(!line.includes(PASSWORD), line);
      assert.ok(!line.includes("/tmp/bundle"), line);
      assert.ok(!line.includes(ARCHIVE_SHA256), line);
      assert.ok(!line.includes(TARGET_FINGERPRINT), line);
    }
  });
});

// ---------------------------------------------------------------------------
// Composition integrity
// ---------------------------------------------------------------------------

describe("composition integrity", () => {
  it("keeps the release entrypoint inside the CLI typecheck boundary", () => {
    const config = readFileSync(`${packageRoot}/tsconfig.cli.json`, "utf8");
    const include = config.match(/"include"\s*:\s*\[([^\]]*)\]/u)?.[1];
    assert.ok(include, "tsconfig.cli.json must declare its entrypoints");
    assert.match(include, /"prisma\/release-migrate\.ts"/u, "release-migrate.ts is outside the CLI typecheck boundary");
  });

  it("names the exact command OSS-F0 Decision 7 requires", () => {
    assert.deepEqual([...RELEASE_MIGRATION_COMMAND], ["npm", "run", "db:migrate-goal-execution"]);
  });

  it("keeps db:migrate-goal-execution exactly preflight-then-deploy", () => {
    const scripts = JSON.parse(readFileSync(`${packageRoot}/package.json`, "utf8")).scripts as Record<string, string>;
    assert.equal(
      scripts["db:migrate-goal-execution"],
      "npm run db:preflight-goal-execution && dotenv -e ../../.env -- prisma migrate deploy",
      "the release migrator composes this string; changing it changes what every release migration runs",
    );
    assert.equal(scripts["db:migrate:release"], "tsx prisma/release-migrate.ts");
  });

  it("never spawns a deploy of its own", () => {
    const source = readFileSync(`${packageRoot}/src/release-migrate.ts`, "utf8");
    const commands = [...source.matchAll(/^export const [A-Z_]+_COMMAND = \[(.*)\] as const;$/gmu)].map((match) => match[1]);
    assert.deepEqual(commands, [
      '"npm", "run", "db:migrate-goal-execution"',
      '"npm", "run", "db:migrate-status"',
      '"npm", "run", "db:drift-check"',
      '"npm", "run", "db:files-precheck"',
    ], "every command this module can spawn is one of these, and none of them deploys");
    assert.ok(!/"migrate"\s*,\s*"deploy"/u.test(source), "a parallel deploy is the bypass this step exists to remove");
    assert.ok(!/"prisma"/u.test(source), "the orchestrator must reach prisma only through the composed npm scripts");
  });

  it("defines the emptiness census once, and both commands use that one", () => {
    // #158 shipped a second, narrower census inside the preflight, and a lone
    // collation passed as `confirmed-empty`. One module now owns the query;
    // this fails if either entrypoint grows its own again.
    for (const file of ["prisma/release-migrate.ts", "prisma/preflight-goal-execution.ts"]) {
      const source = readFileSync(`${packageRoot}/${file}`, "utf8");
      assert.ok(source.includes("SCHEMA_CENSUS_SQL"), `${file} must ask the shared census`);
      for (const catalogue of ["pg_collation", "pg_statistic_ext", "pg_default_acl", "pg_depend"]) {
        assert.ok(
          !source.includes(catalogue),
          `${file} reads ${catalogue} directly, which is a census of its own`,
        );
      }
    }
  });

  it("keeps every schema-scoped catalogue in that one census", () => {
    for (const catalogue of CENSUS_CATALOGUES) {
      assert.ok(SCHEMA_CENSUS_SQL.includes(catalogue), `the census no longer reads ${catalogue}`);
    }
  });

  it("spawns the composed command exactly once on a passing run", async () => {
    const host = fakeHost({ lock: true });
    await releaseMigrate(["--fresh"], host);
    assertComposedExactlyOnce(host);
  });

  it("fails when the composed call is short-circuited in an altered copy", async () => {
    // An actual altered copy, not a restatement of current behaviour: the
    // removal this guards against is the one a refactor makes by accident —
    // the gates still run, the command still reports success, and nothing was
    // migrated. The copy is compiled and executed, then judged by the same
    // assertion the real module passes.
    const source = readFileSync(`${packageRoot}/src/release-migrate.ts`, "utf8");
    const composedCall = "const outcome = await runUnderLock(host, lock, entry.command, childEnv);";
    assert.ok(source.includes(composedCall), "the composed call must be recognisable in the source to be removable");
    const altered = source
      // Every sibling import, not just one: the copy lives in a temp directory
      // and resolves nothing relative to itself.
      .replace(/from "\.\/([^"]+)"/gu, `from "${packageRoot}/src/$1"`)
      .replace(composedCall, 'const outcome = { kind: "exited" as const, code: 0 };');

    const directory = mkdtempSync(join(tmpdir(), "release-migrate-altered-"));
    try {
      const file = join(directory, "release-migrate.altered.ts");
      writeFileSync(file, altered);
      const module = (await import(pathToFileURL(file).href)) as {
        releaseMigrate: (argv: readonly string[], host: ReleaseMigrateHost) => Promise<number>;
      };
      const host = fakeHost({ lock: true });
      assert.equal(await module.releaseMigrate(["--fresh"], host), 0, "the altered copy still reports success");
      assert.throws(() => { assertComposedExactlyOnce(host); }, "the suite must fail when the composition is removed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves every command it spawns from the repository root", () => {
    // The CLI host runs every command with `cwd` = repository root, so a script
    // that exists only in the workspace package is `Missing script` at runtime.
    const rootScripts = JSON.parse(readFileSync(`${repositoryRoot}/package.json`, "utf8")).scripts as Record<string, string>;
    for (const command of [RELEASE_MIGRATION_COMMAND, MIGRATION_STATUS_COMMAND, DRIFT_CHECK_COMMAND]) {
      assert.deepEqual([command[0], command[1]], ["npm", "run"]);
      const name = command[2] as string;
      assert.ok(name in rootScripts, `root package.json has no "${name}" script, but the migrator runs it from the repository root`);
    }
  });
});

// ---------------------------------------------------------------------------
// The merged preflight's own conditions, asserted against the real script
// ---------------------------------------------------------------------------

describe("composed Goal 5a0 preflight", () => {
  const runPreflight = (env: Record<string, string>): { status: number | null; output: string } => {
    const result = spawnSync("npx", ["tsx", "prisma/preflight-goal-execution.ts"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  it("stops on a DATABASE_URL that does not name its schema, without connecting", () => {
    const result = runPreflight({ DATABASE_URL: urlFor({ port: 1, database: "absent", schema: null }) });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /must name the target schema explicitly/u);
  });

  it("refuses a first-run declaration that names a different schema than the URL", () => {
    const result = runPreflight({
      DATABASE_URL: urlFor({ port: 1, database: "absent", schema: "here" }),
      GOAL5A0_FRESH_TARGET: "elsewhere",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /STOP preflight fresh-declaration/u);
  });

  it("keeps every condition name the migrator's documentation quotes", () => {
    const source = readFileSync(`${packageRoot}/prisma/preflight-goal-execution.ts`, "utf8");
    for (const condition of [
      "pgcrypto",
      "ambiguous-goal",
      "mixed-lineage",
      "orphan-run",
      "active-run",
      "project-disagreement",
      "orphan-goal",
      "session-disagreement",
      // The first-run path is part of the contract, not a convenience: an empty
      // target has to be declared, the declaration has to name this schema, and
      // a declared target that is not empty is a stop.
      "first-run-undeclared",
      "fresh-declaration",
      "fresh-target-not-empty",
    ]) {
      assert.ok(source.includes(`fail("${condition}"`), `the merged preflight no longer raises ${condition}`);
    }
  });
});
