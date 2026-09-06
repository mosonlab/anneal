/**
 * `db:migrate:release` — the release-safe, target-bound migration entry point
 * (OSS-B0 plan Step 3).
 *
 * ## What this is, and what it deliberately is not
 *
 * This is a *thin wrapper*. Its own work is the part that belongs to the
 * release path and nowhere else: prove the target is this checkout's local
 * Compose database, prove the fresh target is empty, prove the migration tail
 * is the recorded release candidate — and then hand the actual migration to
 * `npm run db:migrate-goal-execution` unchanged.
 *
 * It does not implement preflight-then-deploy a second time. `packages/db`
 * already owns exactly one such path (`db:preflight-goal-execution &&
 * prisma migrate deploy`), OSS-F0 Fixed Decision 7 makes it the only migration
 * command permitted on the release path, and a parallel implementation here
 * would be a second way to reach the same migration — which is the bypass the
 * decision exists to remove. `RELEASE_MIGRATION_COMMAND` below is therefore the
 * single mutating command this module may spawn, and a test asserts that no
 * other command it spawns can deploy.
 *
 * (the operator's 2026-08-19 ruling settles the wording conflict between OSS-B0's
 * Step 3, which describes importing the preflight module, and OSS-F0's
 * Decision 7, which requires the wrapper: compose the wrapper, add the
 * release-only prechecks around it, change neither plan.)
 *
 * ## What it does not guard
 *
 * Nothing here makes the preflight unskippable. `npm run db:migrate` and a bare
 * `prisma migrate deploy` still reach the same migrations with no preflight at
 * all. That bypass is procedural, and closing it is Goal 5a0 successor work —
 * not something this file may claim.
 *
 * Diagnostics are stable step names, condition names and counts. No URL,
 * password, database name, container id, path, or raw subprocess output is
 * printed or persisted.
 */
import {
  validateBackupBundle,
  type BackupAttestation,
  type BundleFacts,
} from "./backup-bundle.js";
import { censusObjectCount, describeCensus, schemaIsEmpty, type SchemaCensus } from "./schema-census.js";

import {
  confirmLocalReleaseTarget,
  planLocalReleaseTarget,
  type PlannedTarget,
  type ServerIdentity,
  type TargetStop,
} from "./local-release-target.js";

/**
 * The only command in this module that may change a database, and the exact
 * command OSS-F0 Decision 7 names. Spawned as an argument array, never a shell
 * string.
 */
export const RELEASE_MIGRATION_COMMAND = ["npm", "run", "db:migrate-goal-execution"] as const;
/** Read-only verification, run only after the migration command succeeded. */
export const MIGRATION_STATUS_COMMAND = ["npm", "run", "db:migrate-status"] as const;
export const DRIFT_CHECK_COMMAND = ["npm", "run", "db:drift-check"] as const;
/**
 * Existing mode's own precheck: the files an installation already owns must be
 * consistent before its schema changes under them. Fresh mode has no files to
 * check, which is why this is not in fresh's sequence.
 */
export const FILES_PRECHECK_COMMAND = ["npm", "run", "db:files-precheck"] as const;

/**
 * The migration tail recorded for the release candidate. A checkout whose tail
 * is shorter or longer is not the candidate the preflight's authority evidence
 * describes, so it is a stop rather than a warning. The release-cut commit
 * (the `chore(release): prepare` commit) updates these two values to the
 * migration tail on disk at that commit. Adding a migration does not touch
 * them. Between releases, `db:migrate:release` on a main checkout stops with
 * `migration-tail` by design. A migration created before the recorded terminal
 * but merged after the release cut is the exception: its timestamp changes the
 * terminal's recorded position, so that migration's merge must update the pin.
 */
export const RELEASE_CANDIDATE_MIGRATIONS = {
  count: 55,
  terminal: "20260905140000_run_salvage_parent_sha",
} as const;

/** Stable stop conditions owned by the orchestrator itself. */
export type MigrateCondition =
  | "arguments"
  | "maintenance-lock-unavailable"
  | "backup-bundle"
  | "backup-target"
  | "backup-wal"
  | "target-not-empty"
  | "migration-tail"
  | "migration-state"
  | "files-precheck"
  | "migrate-goal-execution"
  | "migrate-status"
  | "drift-check";


/**
 * OSS-D's maintenance advisory lock, as this orchestrator needs it.
 *
 * Deliberately narrower than the client in `maintenance-lock.ts`: this module
 * decides *when* the lock is taken and what a lost lock means, and stays free
 * of the driver that takes it.
 */
export interface MaintenanceLock {
  /** Re-asks the server whether this session still holds the lock. */
  verifyStillHeld(): Promise<boolean>;
  release(): Promise<void>;
}

/** Acquired, or refused with a stable reason the operator can act on. */
export type MaintenanceLockOutcome =
  | { ok: true; lock: MaintenanceLock }
  | { ok: false; reason: string };

/** Who holds the key right now, counted by mode. `null` means unreadable. */
export interface MaintenanceLockState {
  exclusive: number;
  shared: number;
  waiting: number;
}

/**
 * How often the lock is re-verified while a child command is running.
 *
 * The child is a separate process on a separate connection, so the lock can die
 * under it without either noticing. Two seconds bounds how long a migration can
 * keep writing after it stopped being the only writer; the check is one indexed
 * `pg_locks` scan on a connection this process already holds open.
 */
export const LOCK_RETENTION_INTERVAL_MS = 2_000;

/**
 * `_prisma_migrations` as existing mode needs to read it.
 *
 * Prisma's own `migrate status` answers the same questions in prose on stdout;
 * this reads the table instead, so a refusal is a decision about rows rather
 * than about a string that a CLI release is free to reword.
 */
export interface MigrationState {
  /** False when the schema has no `_prisma_migrations` table at all. */
  present: boolean;
  /** Every recorded migration name, in applied order. */
  applied: readonly string[];
  /** Recorded but neither finished nor rolled back: a migration left mid-flight. */
  unresolved: readonly string[];
}

/** Everything this module needs from the world, so every refusal is testable. */
export interface ReleaseMigrateHost {
  repositoryRoot: string;
  processEnv: Readonly<Record<string, string | undefined>>;
  /** Absolute path in, contents out, null when absent or unreadable. */
  readTextFile(absolutePath: string): string | null;
  /** Migration directory names, unsorted. */
  listMigrationDirectories(): readonly string[];
  /** Compose project name for this checkout. */
  composeProject(): string;
  listComposeContainers(project: string, service: string): Promise<readonly string[]>;
  readServerIdentity(url: string): Promise<ServerIdentity | null>;
  inspectSchema(url: string, schema: string): Promise<SchemaCensus | null>;
  /**
   * The exclusive maintenance lock plan Step 3 requires fresh mode to hold
   * across everything it inspects and everything it changes. The client is
   * `packages/db/src/maintenance-lock.ts`; the target is passed in because the
   * lock names the schema, and the schema is only known once this module has
   * proven which target it may connect to at all.
   */
  acquireMaintenanceLock(target: { url: string; schema: string }): Promise<MaintenanceLockOutcome>;
  /**
   * Reads the lock's holders without taking it. `--existing` states the lock
   * situation before it decides anything, which is a different question from
   * "may I have it": a mode that cannot deploy yet still must not be reasoned
   * about as if the database were unattended.
   */
  inspectMaintenanceLock(target: { url: string; schema: string }): Promise<MaintenanceLockState | null>;
  /**
   * The bundle `--existing` was pointed at, as the filesystem describes it:
   * the directory's own mode, its members' kinds and modes, the archive's
   * length/digest/magic, and the attestation's text. Null when the path cannot
   * be inspected at all — which is a refusal, never an empty bundle.
   */
  inspectBackupBundle(absolutePath: string): Promise<BundleFacts | null>;
  /**
   * The server's own identity digest, computed the way the backup computes it:
   * system identifier, database, role. Not the connection's address, because
   * the backup and the migrator reach the same server by different routes.
   */
  readTargetFingerprint(url: string): Promise<string | null>;
  /**
   * The write-ahead-log position, fingerprinted. Equality with the attested
   * post-backup value is how "nothing has been written since the backup" stops
   * being an assumption.
   */
  readWalFingerprint(url: string): Promise<string | null>;
  /** `_prisma_migrations` for this schema, or null when it cannot be read. */
  readMigrationState(url: string, schema: string): Promise<MigrationState | null>;
  /** Wall clock, in epoch milliseconds. Injected so bundle age is testable. */
  nowMs(): number;
  /**
   * Runs an argument array at the repository root; returns its exit code. An
   * aborted signal must terminate the child: the caller aborts when it can no
   * longer prove it holds the lock, and a child that outlives that proof is the
   * concurrency window the lock exists to prevent.
   */
  run(
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    options?: { signal?: AbortSignal },
  ): Promise<number>;
  /** Resolves after the delay, or as soon as the signal aborts — whichever is
   *  first. The retention watchdog's only clock. */
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  log(line: string): void;
  logStop(line: string): void;
}

export type Mode =
  | { kind: "fresh" }
  | { kind: "existing"; backupBundle: string };

export type ArgumentResolution =
  | { ok: true; mode: Mode }
  | { ok: false; reason: string };

/**
 * Exactly one mode, and no escape. `--force` and `--skip-preflight` are named
 * explicitly so that a reader who tries them learns they were considered and
 * refused, rather than that they were forgotten.
 */
export const parseArguments = (argv: readonly string[]): ArgumentResolution => {
  let mode: "fresh" | "existing" | null = null;
  let backupBundle: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--fresh" || argument === "--existing") {
      const kind = argument === "--fresh" ? "fresh" : "existing";
      if (mode !== null) return { ok: false, reason: mode === kind ? "mode-repeated" : "both-modes-requested" };
      mode = kind;
      continue;
    }
    if (argument === "--backup-bundle") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, reason: "backup-bundle-value-missing" };
      if (!value.startsWith("/")) return { ok: false, reason: "backup-bundle-not-absolute" };
      backupBundle = value;
      index += 1;
      continue;
    }
    if (argument === "--force" || argument === "--skip-preflight" || argument === "--no-preflight") {
      return { ok: false, reason: "preflight-escape-flags-are-not-supported" };
    }
    return { ok: false, reason: "unsupported-argument" };
  }

  if (mode === null) return { ok: false, reason: "exactly-one-of---fresh-or---existing-is-required" };
  if (mode === "fresh") {
    return backupBundle === null ? { ok: true, mode: { kind: "fresh" } } : { ok: false, reason: "backup-bundle-is-not-a-fresh-mode-argument" };
  }
  if (backupBundle === null) return { ok: false, reason: "existing-mode-requires---backup-bundle" };
  return { ok: true, mode: { kind: "existing", backupBundle } };
};

export interface MigrationTail {
  count: number;
  terminal: string | null;
  /** Every migration directory, in applied order. */
  names: readonly string[];
}

/** Applied-order tail: directory names sort lexicographically by timestamp. */
export const readMigrationTail = (directories: readonly string[]): MigrationTail => {
  const sorted = [...directories].filter((name) => /^\d{14}_/u.test(name)).sort();
  return {
    count: sorted.length,
    terminal: sorted.length === 0 ? null : (sorted[sorted.length - 1] as string),
    names: sorted,
  };
};

const joinPath = (root: string, relative: string): string =>
  `${root.replace(/\/+$/u, "")}/${relative}`;

export const releaseMigrate = async (argv: readonly string[], host: ReleaseMigrateHost): Promise<number> => {
  const stop = (condition: MigrateCondition | TargetStop["condition"], reason: string): number => {
    host.logStop(`STOP release-migrate ${condition}: ${reason}`);
    return 1;
  };
  const stopAll = (stops: readonly TargetStop[]): number => {
    for (const entry of stops) host.logStop(`STOP release-migrate ${entry.condition}: ${entry.reason}`);
    return 1;
  };

  const parsed = parseArguments(argv);
  if (!parsed.ok) return stop("arguments", parsed.reason);
  host.log(`release-migrate mode=${parsed.mode.kind}`);

  const plan = planLocalReleaseTarget({
    envFile: host.readTextFile(joinPath(host.repositoryRoot, ".env")),
    composeFile: host.readTextFile(joinPath(host.repositoryRoot, "docker-compose.yml")),
    processEnv: host.processEnv,
    composeProject: host.composeProject(),
  });
  if (!plan.ok) return stopAll(plan.stops);
  for (const notice of plan.plan.notices) host.log(`release-migrate step=target notice=${notice}`);
  host.log("release-migrate step=target result=pass");

  const confirmed = confirmLocalReleaseTarget(plan.plan, {
    runningContainers: await host.listComposeContainers(plan.plan.compose.project, plan.plan.compose.service),
    serverIdentity: await host.readServerIdentity(plan.plan.url),
  });
  if (!confirmed.ok) return stopAll(confirmed.stops);
  host.log(`release-migrate step=identity result=pass fingerprint=${confirmed.identity.fingerprint}`);

  if (parsed.mode.kind === "existing") return existingMode(host, plan.plan, parsed.mode.backupBundle, stop);

  // ---- The maintenance lock, before anything is inspected -----------------
  //
  // Plan Step 3 line 142 has fresh mode acquire the exclusive lock *first* and
  // retain it across emptiness, preflight, tail, deploy, status and drift. The
  // order is the safety property, not a formality: an emptiness proof taken
  // before the lock is a proof about a database another process is still free
  // to write to, and the round-2 review of #155 named exactly that window.
  //
  // Target resolution and identity confirmation stay ahead of it because they
  // are what decides whether this process may open a connection to this server
  // at all, and the lock needs a connection. Nothing between that decision and
  // this line reads or writes any schema state.
  const acquired = await host.acquireMaintenanceLock({ url: plan.plan.url, schema: plan.plan.schema });
  if (!acquired.ok) return stop("maintenance-lock-unavailable", acquired.reason);
  const lock = acquired.lock;
  host.log("release-migrate step=maintenance-lock result=acquired");

  try {
    const census = await host.inspectSchema(plan.plan.url, plan.plan.schema);
    if (census === null) return stop("target-not-empty", "schema-census-unavailable");
    if (!schemaIsEmpty(census)) {
      host.log(`release-migrate step=emptiness result=stop ${describeCensus(census)}`);
      return stop("target-not-empty", "fresh-mode-requires-a-schema-with-no-migration-history-and-no-user-objects");
    }
    host.log(`release-migrate step=emptiness result=pass objects=${censusObjectCount(census)}`);

    const tail = readMigrationTail(host.listMigrationDirectories());
    host.log(`release-migrate step=tail count=${tail.count} terminal=${tail.terminal ?? "none"}`);
    if (tail.count !== RELEASE_CANDIDATE_MIGRATIONS.count || tail.terminal !== RELEASE_CANDIDATE_MIGRATIONS.terminal) {
      return stop("migration-tail", "checkout-tail-is-not-the-recorded-release-candidate-tail");
    }

    return await deploy(host, plan.plan, lock, stop, "fresh");
  } finally {
    await lock.release();
    host.log("release-migrate step=maintenance-lock result=released");
  }
};

/**
 * `--existing` — migrating an installation that already holds data.
 *
 * The whole mode is an argument about *reversibility*. Fresh mode's safety net
 * is that there is nothing to lose; existing mode has no such net, so the net
 * has to be produced and checked: a bundle taken from this exact server, minutes
 * ago, whose archive is byte-for-byte the one attested, and whose write-ahead-log
 * position is still the one the server is at. Only then is the exclusive lock
 * taken, and only under it does anything run.
 *
 * The order below is plan Step 3 line 144's, and each step is ahead of the next
 * because it is cheaper or because the next one would otherwise be decided on
 * unproven ground:
 *
 *   bundle shape/modes/digest/age -> attested target == this target
 *     -> exclusive lock (refusing any service or competing migrator)
 *     -> attested WAL position == the current one
 *     -> migration history is resolvable and belongs to this checkout
 *     -> tail is the recorded release candidate
 *     -> files precheck, composed preflight+deploy, status, drift
 *
 * The WAL comparison is deliberately *after* the lock: a position read before
 * the lock is a position another writer may move a millisecond later, which is
 * the same time-of-check window the #155 round-2 review named on the fresh side.
 *
 * This mode never restores, never restarts a service, never edits migration
 * history, and never operates on a target outside the exact local Compose
 * identity proven by the caller.
 */
const existingMode = async (
  host: ReleaseMigrateHost,
  plan: PlannedTarget,
  bundlePath: string,
  stop: (condition: MigrateCondition, reason: string) => number,
): Promise<number> => {
  const targetFingerprint = await host.readTargetFingerprint(plan.url);
  if (targetFingerprint === null) return stop("backup-target", "target-identity-fingerprint-unreadable");

  const facts = await host.inspectBackupBundle(bundlePath);
  // Unreadable is not "empty". A bundle this process cannot see is a bundle it
  // cannot judge, and an unjudged bundle authorises nothing.
  if (facts === null) return stop("backup-bundle", "bundle-is-unreadable");

  const validated = validateBackupBundle(facts, { nowMs: host.nowMs(), targetFingerprint });
  if (!validated.ok) {
    const condition: MigrateCondition =
      validated.reason === "attestation-describes-a-different-target" ? "backup-target" : "backup-bundle";
    return stop(condition, validated.reason);
  }
  const attestation: BackupAttestation = validated.attestation;
  const ageSeconds = Math.max(0, Math.round((host.nowMs() - attestation.createdAtMs) / 1_000));
  host.log(
    `release-migrate step=backup-bundle result=pass archive-bytes=${attestation.archiveBytes} age-seconds=${ageSeconds} quiescence=${attestation.quiescence}`,
  );

  // Diagnostics before the decision: the acquisition below refuses with a
  // reason, and this line says how many of each holder that reason was about.
  const holders = await host.inspectMaintenanceLock({ url: plan.url, schema: plan.schema });
  if (holders === null) return stop("maintenance-lock-unavailable", "lock-state-unreadable");
  host.log(
    `release-migrate step=maintenance-lock result=inspected exclusive=${holders.exclusive} shared=${holders.shared} waiting=${holders.waiting}`,
  );

  const acquired = await host.acquireMaintenanceLock({ url: plan.url, schema: plan.schema });
  if (!acquired.ok) return stop("maintenance-lock-unavailable", acquired.reason);
  const lock = acquired.lock;
  host.log("release-migrate step=maintenance-lock result=acquired");

  try {
    const wal = await host.readWalFingerprint(plan.url);
    if (wal === null) return stop("backup-wal", "current-wal-position-unreadable");
    if (wal !== attestation.walFingerprint) {
      return stop("backup-wal", "target-was-written-to-after-the-backup");
    }
    host.log("release-migrate step=backup-wal result=match");

    const state = await host.readMigrationState(plan.url, plan.schema);
    if (state === null) return stop("migration-state", "migration-history-unreadable");
    if (!state.present) {
      return stop("migration-state", "target-has-no-migration-history-so-it-is-not-an-existing-installation");
    }
    if (state.unresolved.length > 0) {
      return stop("migration-state", `unresolved-migrations-present-${state.unresolved.length}`);
    }

    const tail = readMigrationTail(host.listMigrationDirectories());
    const onDisk = new Set(tail.names);
    // A recorded migration this checkout does not contain means the history and
    // the checkout are not the same lineage; deploying would add migrations on
    // top of a schema whose past this tree cannot describe.
    const unknown = state.applied.filter((name) => !onDisk.has(name));
    if (unknown.length > 0) {
      return stop("migration-state", `applied-migrations-absent-from-this-checkout-${unknown.length}`);
    }

    const applied = new Set(state.applied);
    const pending = tail.names.filter((name) => !applied.has(name));
    host.log(
      `release-migrate step=pending count=${pending.length} applied=${state.applied.length} terminal=${pending[pending.length - 1] ?? "none"}`,
    );

    host.log(`release-migrate step=tail count=${tail.count} terminal=${tail.terminal ?? "none"}`);
    if (tail.count !== RELEASE_CANDIDATE_MIGRATIONS.count || tail.terminal !== RELEASE_CANDIDATE_MIGRATIONS.terminal) {
      return stop("migration-tail", "checkout-tail-is-not-the-recorded-release-candidate-tail");
    }

    return await deploy(host, plan, lock, stop, "existing");
  } finally {
    await lock.release();
    host.log("release-migrate step=maintenance-lock result=released");
  }
};

/** One child command, run with the lock watched for as long as it runs. */
type CommandOutcome = { kind: "exited"; code: number } | { kind: "lock-lost" };

/**
 * Runs one child while re-asking the server whether the lock is still ours.
 *
 * The lock lives on this process's connection; the migration lives in a child
 * on its own. Verifying once before the first child and believing it until the
 * last one exits is the assumption this replaces: a backend terminated during
 * `prisma migrate deploy` frees the key while the deploy keeps writing, and a
 * service or a second migrator can take it and start work against a schema that
 * is mid-migration. Detecting that afterwards is better than nothing, but the
 * window is already open by then — so the watchdog aborts, and an aborted
 * signal is what `host.run` turns into a terminated child.
 */
const runUnderLock = async (
  host: ReleaseMigrateHost,
  lock: MaintenanceLock,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<CommandOutcome> => {
  const controller = new AbortController();
  const state = { lost: false, watching: true };

  const watch = (async (): Promise<void> => {
    while (state.watching) {
      await host.wait(LOCK_RETENTION_INTERVAL_MS, controller.signal);
      if (!state.watching || controller.signal.aborted) return;
      if (await lock.verifyStillHeld()) continue;
      state.lost = true;
      controller.abort();
      return;
    }
  })();

  const code = await host.run(argv, env, { signal: controller.signal });
  // Ends the watchdog's wait whichever way the child finished, then joins it:
  // a verification still in flight has to be allowed to record its answer
  // before this function reads it.
  state.watching = false;
  controller.abort();
  await watch;
  if (state.lost) return { kind: "lock-lost" };
  // The last interval is not covered by the loop above — the child may have
  // exited a millisecond after a check. Ask once more, so a zero exit code is
  // never believed on the strength of a stale observation.
  if (!(await lock.verifyStillHeld())) return { kind: "lock-lost" };
  return { kind: "exited", code };
};

/**
 * The sequence that changes the database, and the interval the exclusive lock
 * exists for. Every command is preceded by a retention check, watched by one
 * while it runs, and followed by one before its exit code counts.
 *
 * Existing mode runs one command the fresh path does not: `db:files-precheck`,
 * which is about the files an installation already owns. It runs *inside* the
 * lock and before the migration, because it is a precondition for changing the
 * schema those files belong to — not a report about it afterwards.
 */
const deploy = async (
  host: ReleaseMigrateHost,
  plan: PlannedTarget,
  lock: MaintenanceLock,
  stop: (condition: MigrateCondition, reason: string) => number,
  mode: "fresh" | "existing",
): Promise<number> => {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(host.processEnv)) if (value !== undefined) childEnv[key] = value;
  // The gated URL, passed explicitly: `dotenv -e ../../.env` inside the
  // migration command does not override an inherited value, so the subprocess
  // must be given the same target this function proved, not a similar one.
  childEnv["DATABASE_URL"] = plan.url;
  // Prisma's advisory "update available" box goes to stderr on every CLI
  // invocation these commands make, where it is indistinguishable from a real
  // migration error in a deploy log. Added, never substituted: the child keeps
  // everything else it was given.
  childEnv["PRISMA_HIDE_UPDATE_MESSAGE"] = "1";
  if (mode === "fresh") {
    // The first-run declaration the Goal 5a0 preflight requires before it treats
    // an empty schema's data conditions as vacuous. It is set here and only here,
    // after this function has already proven the schema holds no migration
    // history and no user objects — and the preflight confirms that again itself,
    // so this is a declaration of intent, not a grant of permission. It travels
    // as an environment variable because `RELEASE_MIGRATION_COMMAND` must stay
    // byte-identical (OSS-F0 Fixed Decision 7).
    childEnv["GOAL5A0_FRESH_TARGET"] = plan.schema;
  } else {
    // An existing installation is not a first run, and a stale declaration
    // inherited from the environment must not turn it into one.
    delete childEnv["GOAL5A0_FRESH_TARGET"];
  }

  const filesPrecheck = {
    step: "files-precheck",
    command: FILES_PRECHECK_COMMAND,
    condition: "files-precheck" as const,
    exited: (code: number): string => `files-precheck-exited-${code}`,
  };
  const steps = [
    ...(mode === "existing" ? [filesPrecheck] : []),
    {
      step: "migrate-goal-execution",
      command: RELEASE_MIGRATION_COMMAND,
      condition: "migrate-goal-execution" as const,
      exited: (code: number): string => `composed-migration-command-exited-${code}`,
    },
    {
      step: "migrate-status",
      command: MIGRATION_STATUS_COMMAND,
      condition: "migrate-status" as const,
      exited: (code: number): string => `migrate-status-exited-${code}`,
    },
    {
      step: "drift-check",
      command: DRIFT_CHECK_COMMAND,
      condition: "drift-check" as const,
      exited: (code: number): string => `drift-check-exited-${code}`,
    },
  ];

  for (const entry of steps) {
    // A session lock is only as durable as its connection, and a pool that
    // reconnected would have dropped it silently. Ask before every command,
    // not only before the first: the proofs taken under a lock that is gone are
    // proofs about an unlocked database, and so is the command about to run.
    if (!(await lock.verifyStillHeld())) {
      return stop("maintenance-lock-unavailable", `lock-was-not-retained-before-${entry.step}`);
    }
    host.log(`release-migrate step=maintenance-lock result=retained before=${entry.step}`);

    const outcome = await runUnderLock(host, lock, entry.command, childEnv);
    if (outcome.kind === "lock-lost") {
      return stop("maintenance-lock-unavailable", `lock-was-not-retained-during-${entry.step}`);
    }
    if (outcome.code !== 0) return stop(entry.condition, entry.exited(outcome.code));
    host.log(`release-migrate step=${entry.step} result=pass`);
  }

  host.log(`release-migrate PASS mode=${mode}`);
  return 0;
};

export { type SchemaCensus } from "./schema-census.js";
