import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  acquireControlPlaneOwnership,
  CONTROL_PLANE_OWNERSHIP_EXIT_CODE,
  ControlPlaneOwnershipStartupError,
  type ControlPlaneOwnerRecord,
} from "./control-plane-ownership.js";
import {
  classifyControlStateFilesystem,
  controlPlaneIdFilename,
  controlPlaneOwnerFilename,
} from "./control-plane-state.js";
import { spawnedSourceEntrypointArgv, spawnedStartupEnvironment } from "./test-startup-environment.js";
import { canonicalizeWorkspaceRoot } from "./workspace-root.js";

const allowedFilesystem = async (): Promise<number> => 0x1a;

const fixture = async () => {
  const container = await realpath(await mkdtemp(join(tmpdir(), "agentos-ownership-")));
  const workspace = join(container, "workspace");
  const files = join(container, "files");
  const state = join(container, "state");
  await Promise.all([mkdir(workspace), mkdir(files), mkdir(state, { mode: 0o700 })]);
  await chmod(state, 0o700);
  return { container, workspace, files, state };
};

const acquire = async (paths: Awaited<ReturnType<typeof fixture>>, extra: Parameters<typeof acquireControlPlaneOwnership>[0] = {}) => {
  const markers: string[] = [];
  const ownership = await acquireControlPlaneOwnership({
    workspaceRoot: paths.workspace,
    filesRoot: paths.files,
    stateDir: paths.state,
    filesystemTypeProbe: allowedFilesystem,
    markerWriter: (line) => { markers.push(line); },
    ...extra,
  });
  return { ownership, markers };
};

test("UT-OWN-INTEGRITY classifies only the explicit local filesystem allowlist", () => {
  for (const [raw, expected] of [
    [0x1a, "apfs"], [0x4244, "hfs"], [0xef53, "ext"], [0x58465342, "xfs"],
    [0x9123683e, "btrfs"], [0x01021994, "tmpfs"], [0x794c7630, "overlay"],
  ] as const) assert.equal(classifyControlStateFilesystem(raw), expected);
  for (const raw of [0x6969, 0x517b, 0xff534d42, 0x65735546, 0x12345678]) {
    assert.throws(() => classifyControlStateFilesystem(raw), /control-state-filesystem/u);
  }
});

test("UT-OWN-INTEGRITY canonicalizes symlink and lexical aliases to one physical root", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const aliasParent = join(paths.container, "aliases");
  await mkdir(aliasParent);
  await symlink(paths.workspace, join(aliasParent, "root"));
  const [physical, alias] = await Promise.all([
    canonicalizeWorkspaceRoot(paths.workspace),
    canonicalizeWorkspaceRoot(join(aliasParent, "unused", "..", "root")),
  ]);
  assert.equal(alias.canonicalPath, physical.canonicalPath);
  assert.equal(alias.device, physical.device);
  assert.equal(alias.inode, physical.inode);
});

test("UT-OWN-INTEGRITY refuses direct, nested, parent, and symlink-alias Files/state overlap", async (t) => {
  for (const shape of ["direct", "nested", "parent", "symlink-alias"] as const) {
    await t.test(shape, async () => {
      const paths = await fixture();
      t.after(() => rm(paths.container, { recursive: true, force: true }));
      let filesRoot = paths.state;
      if (shape === "nested") filesRoot = join(paths.state, "files");
      if (shape === "parent") filesRoot = paths.container;
      if (shape === "symlink-alias") {
        const alias = join(paths.container, "state-alias");
        await symlink(paths.state, alias);
        filesRoot = alias;
      }
      await assert.rejects(acquireControlPlaneOwnership({
        workspaceRoot: paths.workspace,
        filesRoot,
        stateDir: paths.state,
        filesystemTypeProbe: allowedFilesystem,
        markerWriter: () => undefined,
      }), /control-state-overlaps-files-root/u);
    });
  }
});

test("UT-OWN-STATE-MATRIX preserves stable identity across clean release and reacquire", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const second = await acquire(paths);
  assert.equal(second.ownership.controlPlaneId, first.ownership.controlPlaneId);
  assert.notEqual(second.ownership.incarnationId, first.ownership.incarnationId);
  assert.match(first.markers.join("\n"), /CONTROL_PLANE_OWNERSHIP_ACQUIRED/u);
  assert.match(first.markers.join("\n"), /CONTROL_PLANE_OWNERSHIP_RELEASED/u);
  await second.ownership.release();
});

test("UT-OWN-STATE-MATRIX upgrades a released v1 record after device numbers drift across reboot", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const ownerPath = join(first.ownership.controlStateEntryPath, controlPlaneOwnerFilename);
  const released = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
  released.formatVersion = 1;
  released.workspaceRootDevice = (first.ownership.workspaceRootDevice + 3n).toString();
  released.lockDevice = (first.ownership.lockDevice + 3n).toString();
  await writeFile(ownerPath, `${JSON.stringify(released)}\n`, { mode: 0o600 });

  const second = await acquire(paths);
  assert.equal(second.ownership.controlPlaneId, first.ownership.controlPlaneId);
  const upgraded = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
  assert.equal(upgraded.formatVersion, 2);
  assert.equal("workspaceRootDevice" in upgraded, false);
  assert.equal("lockDevice" in upgraded, false);
  await second.ownership.release();
});

test("UT-OWN-STATE-MATRIX advances valid stable-without-owner and removes only bounded temp debris", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const entry = first.ownership.controlStateEntryPath;
  await rm(join(entry, controlPlaneOwnerFilename));
  const debris = join(entry, `.owner.json.tmp-${process.pid}-${crypto.randomUUID()}`);
  await writeFile(debris, "partial", { mode: 0o600 });
  const second = await acquire(paths);
  assert.equal(second.ownership.controlPlaneId, first.ownership.controlPlaneId);
  await assert.rejects(lstat(debris), { code: "ENOENT" });
  await second.ownership.release();
});

test("UT-OWN-STATE-MATRIX refuses malformed and mismatched pairs byte-for-byte", async (t) => {
  const cases = ["owner-without-stable", "malformed-stable", "malformed-owner", "mismatched-owner"] as const;
  for (const shape of cases) {
    await t.test(shape, async () => {
      const paths = await fixture();
      t.after(() => rm(paths.container, { recursive: true, force: true }));
      const first = await acquire(paths);
      await first.ownership.release();
      const entry = first.ownership.controlStateEntryPath;
      const stablePath = join(entry, controlPlaneIdFilename);
      const ownerPath = join(entry, controlPlaneOwnerFilename);
      if (shape === "owner-without-stable") await rm(stablePath);
      if (shape === "malformed-stable") await writeFile(stablePath, "{", { mode: 0o600 });
      if (shape === "malformed-owner") await writeFile(ownerPath, "{", { mode: 0o600 });
      if (shape === "mismatched-owner") {
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
        owner.controlPlaneId = crypto.randomUUID();
        await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      }
      const before = await Promise.all([readFile(stablePath).catch(() => null), readFile(ownerPath).catch(() => null)]);
      await assert.rejects(acquire(paths), ControlPlaneOwnershipStartupError);
      const after = await Promise.all([readFile(stablePath).catch(() => null), readFile(ownerPath).catch(() => null)]);
      assert.deepEqual(after, before);
    });
  }
});

test("UT-OWN-STATE-MATRIX recovers a free lock across hostname drift and PID reuse", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const ownerPath = join(first.ownership.controlStateEntryPath, controlPlaneOwnerFilename);
  const stale = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
  delete stale.releasedAt;
  stale.state = "owned";
  stale.pid = process.pid;
  stale.hostname = "hostname-before-reboot";
  await writeFile(ownerPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  const recovered = await acquire(paths, { hostname: "hostname-after-reboot" });
  assert.equal(recovered.ownership.controlPlaneId, first.ownership.controlPlaneId);
  assert.match(recovered.markers.join("\n"), /CONTROL_PLANE_OWNERSHIP_RECOVERED/u);
  const current = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
  assert.equal(current.hostname, "hostname-after-reboot");
  assert.notEqual(current.incarnationId, stale.incarnationId);
  await recovered.ownership.release();
});

test("UT-OWN-RECOVERY publishes recovery only after the new owner record is durable", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const ownerPath = join(first.ownership.controlStateEntryPath, controlPlaneOwnerFilename);
  const stale = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
  delete stale.releasedAt;
  stale.state = "owned";
  await writeFile(ownerPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

  let durableIncarnation: string | undefined;
  const recovered = await acquire(paths, {
    markerWriter: async (line) => {
      if (!line.startsWith("CONTROL_PLANE_OWNERSHIP_RECOVERED")) return;
      const durable = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
      assert.equal(durable.state, "owned");
      assert.notEqual(durable.incarnationId, stale.incarnationId);
      durableIncarnation = durable.incarnationId;
    },
  });
  assert.equal(durableIncarnation, recovered.ownership.incarnationId);
  await recovered.ownership.release();
});

test("UT-OWN-RECOVERY write, rename, and directory-sync failures never emit false recovery", async (t) => {
  for (const phase of ["before-write", "before-rename", "before-directory-sync"] as const) {
    await t.test(phase, async () => {
      const paths = await fixture();
      t.after(() => rm(paths.container, { recursive: true, force: true }));
      const first = await acquire(paths);
      await first.ownership.release();
      const ownerPath = join(first.ownership.controlStateEntryPath, controlPlaneOwnerFilename);
      const stale = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
      delete stale.releasedAt;
      stale.state = "owned";
      await writeFile(ownerPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
      const markers: string[] = [];
      await assert.rejects(acquire(paths, {
        markerWriter: (line) => { markers.push(line); },
        stateMutationHook: (operation, currentPhase) => {
          if (operation === "write-owner" && currentPhase === phase) throw new Error(`injected-${phase}`);
        },
      }), new RegExp(`injected-${phase}`, "u"));
      assert.doesNotMatch(markers.join("\n"), /CONTROL_PLANE_OWNERSHIP_RECOVERED/u);
      const durable = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
      assert.equal(durable.state, "owned");
      if (phase === "before-directory-sync") assert.notEqual(durable.incarnationId, stale.incarnationId);
      else assert.equal(durable.incarnationId, stale.incarnationId);
      const successor = await acquire(paths);
      await successor.ownership.release();
    });
  }
});

test("UT-OWN-REFUSAL preserves exit 75 and secondary marker failures without recursion", async (t) => {
  const cases = [
    ["closed-stdout", () => { throw Object.assign(new Error("closed stdout"), { code: "ERR_STREAM_DESTROYED" }); }],
    ["epipe", () => { throw Object.assign(new Error("broken pipe"), { code: "EPIPE" }); }],
    ["sync-throw", () => { throw new Error("synchronous marker failure"); }],
    ["rejected-promise", () => Promise.reject(new Error("rejected marker promise"))],
  ] as const;
  for (const [label, markerWriter] of cases) {
    await t.test(label, async () => {
      const paths = await fixture();
      t.after(() => rm(paths.container, { recursive: true, force: true }));
      let calls = 0;
      await assert.rejects(acquire(paths, {
        cloexecProbe: () => false,
        markerWriter: () => {
          calls += 1;
          return markerWriter();
        },
      }), (error: unknown) => {
        assert.ok(error instanceof ControlPlaneOwnershipStartupError);
        assert.equal(error.exitCode, CONTROL_PLANE_OWNERSHIP_EXIT_CODE);
        assert.equal(error.reason, "lock-descriptor-missing-cloexec");
        assert.equal(error.secondaryFailures.length, 1);
        return true;
      });
      assert.equal(calls, 1);
      const successor = await acquire(paths);
      await successor.ownership.release();
    });
  }
});

test("UT-OWN-REFUSAL a failed recovery marker is not retried and leaves valid evidence", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const ownerPath = join(first.ownership.controlStateEntryPath, controlPlaneOwnerFilename);
  const stale = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
  delete stale.releasedAt;
  stale.state = "owned";
  await writeFile(ownerPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  let calls = 0;
  await assert.rejects(acquire(paths, {
    markerWriter: () => {
      calls += 1;
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    },
  }), (error: unknown) => {
    assert.ok(error instanceof ControlPlaneOwnershipStartupError);
    assert.equal(error.reason, "marker-transport-failure");
    assert.equal(error.secondaryFailures.length, 1);
    return true;
  });
  assert.equal(calls, 1);
  const durable = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
  assert.notEqual(durable.incarnationId, stale.incarnationId);
  const successor = await acquire(paths);
  await successor.ownership.release();
});

test("RP-OWN-REPLACE base and entry replacement cannot redirect bound state operations", async (t) => {
  for (const shape of ["base", "entry"] as const) {
    await t.test(shape, async () => {
      const paths = await fixture();
      t.after(() => rm(paths.container, { recursive: true, force: true }));
      let replaced = false;
      let displaced = "";
      await assert.rejects(acquire(paths, {
        stateOperationHook: async (operation, entryPath) => {
          if (operation !== "write-owner" || replaced) return;
          replaced = true;
          const target = shape === "base" ? dirname(entryPath) : entryPath;
          displaced = `${target}-displaced`;
          await rename(target, displaced);
          await mkdir(target, { mode: 0o700 });
        },
      }), new RegExp(`control-state-${shape}-path-replaced`, "u"));
      assert.equal(replaced, true);
      assert.deepEqual(await readdir(shape === "base" ? paths.state : join(paths.state, (await readdir(paths.state))[0] as string)), []);
      const displacedEntry = shape === "base"
        ? join(displaced, (await readdir(displaced))[0] as string)
        : displaced;
      assert.deepEqual((await readdir(displacedEntry)).sort(), [controlPlaneIdFilename, "ownership.lock"].sort());
    });
  }
});

test("UT-OWN-INTEGRITY refuses unsupported filesystems and missing FD_CLOEXEC", async (t) => {
  const unsupported = await fixture();
  const noCloexec = await fixture();
  t.after(() => Promise.all([
    rm(unsupported.container, { recursive: true, force: true }),
    rm(noCloexec.container, { recursive: true, force: true }),
  ]));
  await assert.rejects(acquireControlPlaneOwnership({
    workspaceRoot: unsupported.workspace,
    filesRoot: unsupported.files,
    stateDir: unsupported.state,
    filesystemTypeProbe: async () => 0x6969,
    markerWriter: () => undefined,
  }), /unsupported-nfs/u);
  await assert.rejects(acquire(noCloexec, { cloexecProbe: () => false }), /missing-cloexec/u);
});

test("RP-OWN-REPLACE poisons lock replacement and root retarget without rewriting owner evidence", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  const ownerPath = join(first.ownership.controlStateEntryPath, controlPlaneOwnerFilename);
  const lockPath = join(first.ownership.controlStateEntryPath, "ownership.lock");
  const before = await readFile(ownerPath);
  await unlink(lockPath);
  await writeFile(lockPath, "", { mode: 0o600 });
  await assert.rejects(first.ownership.assertHeld(), /poisoned:lock-path-identity-drift/u);
  await first.ownership.release();
  assert.deepEqual(await readFile(ownerPath), before);
  await assert.rejects(acquire(paths), /owner-record-identity-mismatch/u);

  const fresh = await fixture();
  t.after(() => rm(fresh.container, { recursive: true, force: true }));
  await rm(fresh.workspace, { recursive: true });
  await symlink(paths.workspace, fresh.workspace);
  const held = await acquire(fresh);
  await unlink(fresh.workspace);
  await mkdir(join(paths.container, "other-root"));
  await symlink(join(paths.container, "other-root"), fresh.workspace);
  await assert.rejects(held.ownership.assertHeld(), /workspace-root-retargeted/u);
  await held.ownership.release();

  const filesAlias = await fixture();
  t.after(() => rm(filesAlias.container, { recursive: true, force: true }));
  const originalFiles = join(filesAlias.container, "original-files");
  await mkdir(originalFiles);
  await rm(filesAlias.files, { recursive: true });
  await symlink(originalFiles, filesAlias.files);
  const filesHeld = await acquire(filesAlias);
  await unlink(filesAlias.files);
  await symlink(filesAlias.state, filesAlias.files);
  await assert.rejects(filesHeld.ownership.assertHeld(), /files-root-retargeted/u);
  await filesHeld.ownership.release();
});

/** A complete, valid startup configuration for a spawned production entrypoint.
 *  `index.ts` validates its configuration before it acquires ownership (see
 *  startup-config.ts), so an ownership fixture has to state one; the values are
 *  fixture-shaped and reach nothing — the database host is port 1 on loopback
 *  and these children exit before they listen. */
/** The production entrypoint judges its own configuration before it does
 *  anything else, so a spawn has to hand it one a deployment could hold. The
 *  database here is an address nothing answers on: both tests below assert a
 *  refusal that happens before Prisma is ever imported. */
const startupConfiguration = spawnedStartupEnvironment({
  DATABASE_URL: "postgresql://invalid:invalid-fixture-password-000000@127.0.0.1:1/never-contact?schema=public",
});

test("RP-OWN-SOURCE-ARGV source entrypoints carry exactly one development condition", async () => {
  for (const entrypoint of ["index.ts", "control-plane-ownership-probe.ts"]) {
    const argv = spawnedSourceEntrypointArgv(entrypoint);
    assert.deepEqual(
      argv.filter((argument) => argument === "--conditions=development"),
      ["--conditions=development"],
      `${entrypoint} must select source resolution exactly once`,
    );
  }
  // Keep this audit coupled to the source children below. A future child that
  // reaches process.execPath directly must opt into the same canonical argv.
  const source = await readFile(new URL("./control-plane-ownership.test.ts", import.meta.url), "utf8");
  const sourceChildSpawns = source.match(/spawn\(process\.execPath,/gu) ?? [];
  const canonicalSourceChildSpawns = source.match(
    /spawn\(process\.execPath,\s*spawnedSourceEntrypointArgv\(/gu,
  ) ?? [];
  assert.equal(
    canonicalSourceChildSpawns.length,
    sourceChildSpawns.length,
    "every source child spawn must use spawnedSourceEntrypointArgv",
  );
});

test("RP-OWN-FILES-ALIAS production entrypoint refuses Files/state alias before database import", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  await rm(paths.files, { recursive: true });
  await symlink(paths.state, paths.files);
  const child = trackChild(t, "Files/state alias entrypoint", spawn(process.execPath, spawnedSourceEntrypointArgv("index.ts"), {
    cwd: dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      RUNNER_WORKSPACE_ROOT: paths.workspace,
      FILES_ROOT: paths.files,
      CONTROL_PLANE_STATE_DIR: paths.state,
      ...startupConfiguration,
      SCHEDULER_POLL_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.deepEqual(await readdir(paths.state), []);
  assert.equal((await waitForExit(child)).code, CONTROL_PLANE_OWNERSHIP_EXIT_CODE, child.output);
  assert.match(child.output, /CONTROL_PLANE_OWNERSHIP_REFUSED.*control-state-overlaps-files-root/u);
  assert.doesNotMatch(child.output, /CONTROL_PLANE_OWNERSHIP_ACQUIRED|Startup reconciliation|listening|PrismaClient/u);
  assert.deepEqual(await readdir(paths.state), []);
});

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };
type TrackedChild = {
  child: ChildProcess;
  label: string;
  output: string;
  descendantPids: Set<number>;
  cleanup: () => Promise<void>;
};

const childDiagnostic = (tracked: TrackedChild): string => [
  `${tracked.label} pid=${tracked.child.pid ?? "unknown"}`,
  `exitCode=${tracked.child.exitCode ?? "null"}`,
  `signalCode=${tracked.child.signalCode ?? "null"}`,
  `descendantPids=${[...tracked.descendantPids].join(",") || "none"}`,
  `output=${JSON.stringify(tracked.output)}`,
].join(" ");

/**
 * How long a spawned child may take to reach the behaviour a test waits for.
 *
 * Every child here is a full `node --import tsx` startup of a production
 * entrypoint, and the merge gate runs one workspace suite per CPU while each
 * suite runs its own files concurrently. On a host that saturated, a healthy
 * loser entrypoint has been observed to still be printing its build line ten
 * seconds after it was spawned — the whole of what these waits used to allow.
 * The budget covers process startup under that oversubscription, not the
 * behaviour: a child that is genuinely stuck still fails, with the same
 * diagnostic, one minute later instead of ten seconds later.
 */
const CHILD_WAIT_BUDGET_MS = 60_000;

/** A child being terminated has already started, so only signal delivery and
 *  its own cleanup remain. Escalation to SIGKILL keeps the shorter budget. */
const CHILD_TERMINATION_BUDGET_MS = 15_000;

const isRunning = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const waitForProcessExit = async (pid: number, label: string, timeoutMs = CHILD_TERMINATION_BUDGET_MS): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label} pid=${pid} to exit`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
};

const waitForExit = (tracked: TrackedChild, timeoutMs = CHILD_WAIT_BUDGET_MS): Promise<ChildExit> => {
  const { child } = tracked;
  if (!isRunning(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new Error(`Failed while waiting for child exit: ${childDiagnostic(tracked)}`, { cause: error }));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for child exit: ${childDiagnostic(tracked)}`));
    }, timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
};

const waitForLine = (tracked: TrackedChild, pattern: RegExp, timeoutMs = CHILD_WAIT_BUDGET_MS): Promise<string> => new Promise((resolve, reject) => {
  const { child } = tracked;
  const cleanup = (): void => {
    clearTimeout(timer);
    child.stdout?.removeListener("data", onData);
    child.stderr?.removeListener("data", onData);
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
  };
  const checkOutput = (): void => {
    pattern.lastIndex = 0;
    if (!pattern.test(tracked.output)) return;
    cleanup();
    resolve(tracked.output);
  };
  const onData = (): void => { checkOutput(); };
  const onError = (error: Error): void => {
    cleanup();
    reject(new Error(`Child failed before ${pattern} appeared: ${childDiagnostic(tracked)}`, { cause: error }));
  };
  const onExit = (): void => {
    cleanup();
    reject(new Error(`Child exited before ${pattern} appeared: ${childDiagnostic(tracked)}`));
  };
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${pattern}: ${childDiagnostic(tracked)}`));
  }, timeoutMs);
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("error", onError);
  child.once("exit", onExit);
  checkOutput();
});

const terminateChild = async (tracked: TrackedChild, signal: NodeJS.Signals = "SIGTERM"): Promise<ChildExit> => {
  if (!isRunning(tracked.child)) return waitForExit(tracked);
  tracked.child.kill(signal);
  try {
    return await waitForExit(tracked, CHILD_TERMINATION_BUDGET_MS);
  } catch (error) {
    if (signal === "SIGKILL" || !isRunning(tracked.child)) throw error;
    tracked.child.kill("SIGKILL");
    return waitForExit(tracked, CHILD_TERMINATION_BUDGET_MS).catch((killError: unknown) => {
      throw new AggregateError([error, killError], `Failed to terminate child: ${childDiagnostic(tracked)}`);
    });
  }
};

const terminateProcess = async (pid: number, label: string): Promise<void> => {
  if (!processExists(pid)) return;
  process.kill(pid, "SIGTERM");
  try {
    await waitForProcessExit(pid, label);
  } catch (error) {
    if (!processExists(pid)) return;
    process.kill(pid, "SIGKILL");
    await waitForProcessExit(pid, label).catch((killError: unknown) => {
      throw new AggregateError([error, killError], `Failed to terminate ${label} pid=${pid}`);
    });
  }
};

const cleanupTrackedChild = async (tracked: TrackedChild): Promise<void> => {
  const failures: unknown[] = [];
  if (isRunning(tracked.child)) {
    await terminateChild(tracked).catch((error: unknown) => { failures.push(error); });
  }
  for (const pid of tracked.descendantPids) {
    await terminateProcess(pid, `${tracked.label} descendant`).catch((error: unknown) => { failures.push(error); });
  }
  if (failures.length > 0) throw new AggregateError(failures, `Cleanup failed: ${childDiagnostic(tracked)}`);
};

const trackChild = (t: TestContext, label: string, child: ChildProcess, trackDescendants = false): TrackedChild => {
  let cleanupPromise: Promise<void> | undefined;
  const tracked: TrackedChild = {
    child,
    label,
    output: "",
    descendantPids: new Set<number>(),
    cleanup: () => cleanupPromise ??= cleanupTrackedChild(tracked),
  };
  const append = (chunk: Buffer): void => {
    tracked.output += chunk.toString("utf8");
    if (!trackDescendants) return;
    for (const match of tracked.output.matchAll(/OWNERSHIP_PROBE_DESCENDANT_PID (\d+)/gu)) {
      tracked.descendantPids.add(Number(match[1]));
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  t.after(tracked.cleanup);
  return tracked;
};

test("RP-OWN-SAME-ALIAS production loser exits 75 before database import, reconciliation, or listen", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const aliasParent = join(paths.container, "alias-parent");
  await mkdir(aliasParent);
  await symlink(paths.workspace, join(aliasParent, "root"));
  const env = {
    ...process.env,
    RUNNER_WORKSPACE_ROOT: paths.workspace,
    FILES_ROOT: paths.files,
    CONTROL_PLANE_STATE_DIR: paths.state,
  };
  const owner = trackChild(t, "same-alias owner probe", spawn(process.execPath, spawnedSourceEntrypointArgv("control-plane-ownership-probe.ts"), {
    cwd: dirname(new URL(import.meta.url).pathname), env, stdio: ["ignore", "pipe", "pipe"],
  }), true);
  await waitForLine(owner, /OWNERSHIP_PROBE_READY/u);
  const loser = trackChild(t, "same-alias loser entrypoint", spawn(process.execPath, spawnedSourceEntrypointArgv("index.ts"), {
    cwd: dirname(new URL(import.meta.url).pathname),
    env: {
      ...env,
      RUNNER_WORKSPACE_ROOT: join(aliasParent, "unused", "..", "root"),
      ...startupConfiguration,
      SCHEDULER_POLL_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const result = await waitForExit(loser);
  assert.equal(result.code, CONTROL_PLANE_OWNERSHIP_EXIT_CODE, loser.output);
  assert.match(loser.output, /CONTROL_PLANE_OWNERSHIP_CONFLICT/u);
  assert.doesNotMatch(loser.output, /CONTROL_PLANE_OWNERSHIP_ACQUIRED|Startup reconciliation|listening/u);
  assert.deepEqual(await terminateChild(owner), { code: 0, signal: null }, owner.output);
});

test("RP-OWN-RECOVERY-DESCENDANT recovers after SIGKILL while execed descendant remains alive", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const env = {
    ...process.env,
    RUNNER_WORKSPACE_ROOT: paths.workspace,
    FILES_ROOT: paths.files,
    CONTROL_PLANE_STATE_DIR: paths.state,
    OWNERSHIP_PROBE_DESCENDANT: "1",
  };
  const owner = trackChild(t, "recovery owner probe", spawn(process.execPath, spawnedSourceEntrypointArgv("control-plane-ownership-probe.ts"), {
    cwd: dirname(new URL(import.meta.url).pathname), env, stdio: ["ignore", "pipe", "pipe"],
  }), true);
  const ready = await waitForLine(owner, /OWNERSHIP_PROBE_READY/u);
  const descendantPid = Number(ready.match(/OWNERSHIP_PROBE_DESCENDANT_PID (\d+)/u)?.[1]);
  assert.ok(descendantPid > 0);
  assert.equal((await terminateChild(owner, "SIGKILL")).signal, "SIGKILL", owner.output);
  assert.doesNotThrow(() => process.kill(descendantPid, 0));

  const successor = trackChild(t, "recovery successor probe", spawn(process.execPath, spawnedSourceEntrypointArgv("control-plane-ownership-probe.ts"), {
    cwd: dirname(new URL(import.meta.url).pathname),
    env: { ...env, OWNERSHIP_PROBE_DESCENDANT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }), true);
  const output = await waitForLine(successor, /OWNERSHIP_PROBE_READY/u);
  assert.match(output, /CONTROL_PLANE_OWNERSHIP_RECOVERED/u);
  assert.deepEqual(await terminateChild(successor), { code: 0, signal: null }, successor.output);
  await terminateProcess(descendantPid, "recovery descendant");
  assert.equal(processExists(descendantPid), false);
});

test("RP-OWN-RECOVERY-CLEANUP readiness timeout removes the owner and unknown descendant", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const owner = trackChild(t, "readiness-timeout owner probe", spawn(process.execPath, spawnedSourceEntrypointArgv("control-plane-ownership-probe.ts"), {
    cwd: dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      RUNNER_WORKSPACE_ROOT: paths.workspace,
      FILES_ROOT: paths.files,
      CONTROL_PLANE_STATE_DIR: paths.state,
      OWNERSHIP_PROBE_DESCENDANT: "1",
      OWNERSHIP_PROBE_SUPPRESS_READY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }), true);

  await waitForLine(owner, /OWNERSHIP_PROBE_DESCENDANT_PID \d+/u);
  await assert.rejects(waitForLine(owner, /OWNERSHIP_PROBE_READY/u, 500), (error: unknown) => {
    assert.match(String(error), /Timed out after 500ms.*readiness-timeout owner probe/u);
    assert.match(String(error), /OWNERSHIP_PROBE_DESCENDANT_PID \d+/u);
    return true;
  });
  const [descendantPid] = owner.descendantPids;
  assert.ok(descendantPid && processExists(descendantPid));
  await owner.cleanup();
  assert.equal(owner.child.exitCode, 0, owner.output);
  assert.equal(processExists(descendantPid), false);
});
