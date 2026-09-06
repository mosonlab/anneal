import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  PrismaClient, SESSION_USAGE_LOCK_CLASS, recomputeSessionUsage, sessionUsageLockKey,
} from "@anneal/db";

import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

/**
 * The advisory lock inside `recomputeSessionUsage` (packages/db/src/usage.ts),
 * against a real PostgreSQL.
 *
 * HOW TO CHECK THESE TESTS STILL EARN THEIR KEEP. Delete the
 * `pg_advisory_xact_lock` statement from `recomputeSessionUsage` and re-run this
 * file: **test 1 and test 2b must fail, and nothing outside this file may fail.**
 * Two failures is the correct expectation, not a broken test —
 *   - test 1 fails because A's stale absolute write lands last
 *     (`storedInputTokens: 10` where 30 is expected);
 *   - test 2b fails because the contended recompute now RESOLVES instead of
 *     being made to wait.
 * Tests 0 and 2a are deliberately INSENSITIVE to that deletion: test 0 never
 * contends, and test 2a takes its lock directly rather than through
 * `recomputeSessionUsage`. A reader who deletes the line and sees those two
 * stay green has learned nothing alarming. Restore with
 * `git checkout -- packages/db/src/usage.ts`.
 *
 * WHAT THE FIRST RUN SETTLED (plan §13 items 1 and 2):
 * - The parameterised `${…}::int` bind form is accepted by Prisma 6.19.0
 *   (test 0 exercises it). The documented `$executeRawUnsafe` fallback was
 *   therefore NOT adopted.
 * - `lock_timeout` DOES bound an advisory-lock wait at ≈3 s. That error must
 *   remain internal: test 2b holds the lock beyond the bound, proves the
 *   contender is still pending, then proves it succeeds after release. Returning
 *   55P03 would acknowledge a durable FINAL_OUTPUT without repairing its cache.
 *
 * The schema this runs against is built from the committed migrations by
 * `testdb.ts`, which refuses `public`. It is never a dump or clone of the live
 * database, and no second control plane is ever pointed at it.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

/** The project → environment → agent → repo → task → run → session chain, copied
 *  from `scheduler.dbtest.ts` and `chain.dbtest.ts` rather than re-derived. */
const seedSession = async (label: string) => {
  const unique = `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const project = await db.project.create({ data: { name: "Usage", slug: `usage-${unique}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo", dependencyProvisioning: DependencyProvisioning.NONE } });
  const task = await db.task.create({ data: {
    projectId: project.id, name: `Task ${unique}`, description: "usage", assigneeAgentId: agent.id, repoId: repo.id,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id, runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`, runner: "CLAUDE", status: "RUNNING", model: "claude", promptHash: "hash",
  } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: project.id, agentId: agent.id, taskId: task.id, runner: "CLAUDE", executionStatus: "RUNNING",
  } });
  return { session, run };
};

const addFinalOutput = async (
  target: { session: { id: string }; run: { id: string } },
  seq: number,
  payload: unknown,
): Promise<void> => {
  await db.sessionEvent.create({ data: {
    sessionId: target.session.id, runId: target.run.id, seq, source: "CLAUDE", type: "FINAL_OUTPUT",
    payload: payload as never,
  } });
};

const storedColumns = (sessionId: string) => db.session.findUniqueOrThrow({
  where: { id: sessionId },
  select: { inputTokens: true, outputTokens: true, cachedInputTokens: true, totalTokens: true, costUsd: true },
});

/* -------------------------------------------------------------- test 0 */

test("0: the locked recompute runs at all against a real database", async () => {
  // The cheapest possible check, and the most valuable one in this file. One
  // uninstrumented call exercises `SET LOCAL lock_timeout`, the `::int`
  // parameter binds and the `::text AS locked` return cast together. Without the
  // return cast, Prisma cannot deserialize `pg_advisory_xact_lock`'s `void` and
  // EVERY recompute raises P2010 — which the ingest path swallows and the unit
  // stubs cannot see, because they return `[]` from `$queryRaw` and never touch
  // PostgreSQL. A regression here would otherwise surface only as test 1
  // failing, where a reader would reasonably suspect the interleaving.
  const seeded = await seedSession("locked-recompute");
  await addFinalOutput(seeded, 1, { type: "result", total_cost_usd: 0.25, usage: { input_tokens: 11, output_tokens: 5 } });

  assert.equal(await recomputeSessionUsage(db, seeded.session.id), true);
  const columns = await storedColumns(seeded.session.id);
  assert.equal(columns.inputTokens, 11);
  assert.equal(columns.outputTokens, 5);
  assert.equal(columns.totalTokens, 16);
  assert.equal(columns.costUsd?.toString(), "0.25");

  // Same events in, same columns out: the second call must not write.
  assert.equal(await recomputeSessionUsage(db, seeded.session.id), false);
});

/* -------------------------------------------------------------- test 1 */

test("1: a recompute that reads a stale event set cannot overwrite a fresher total", { timeout: 20_000 }, async () => {
  // The defect, precisely: both callers write ABSOLUTE values. A reads one
  // event (10), B reads two (10 + 20 = 30) and commits, then A commits 10 on
  // top — and `sameColumns` sees a self-consistent row afterwards, so no later
  // recompute ever repairs it. The lock makes A's read-compare-write atomic, so
  // B's read happens after A's commit and sees both events.
  const seeded = await seedSession("interleaving");
  await addFinalOutput(seeded, 1, { type: "result", usage: { input_tokens: 10 } });

  const secondClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let signalRead!: () => void;
  let releaseA!: () => void;
  const readIssued = new Promise<void>((resolve) => { signalRead = resolve; });
  const aMayProceed = new Promise<void>((resolve) => { releaseA = resolve; });
  let eventReads = 0;
  let stalled = false;

  // The Proxy-over-$transaction shape from chain.dbtest.ts:218-239: intercept
  // `$transaction`, wrap the callback's `tx`, replace one delegate on the INNER
  // client. Wrapping the outer client alone would instrument nothing, because
  // the recompute reads through `tx`.
  const stallingDb = new Proxy(db, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const eventDelegate = new Proxy(tx.sessionEvent, { get(eventTarget, eventProperty, eventReceiver) {
        if (eventProperty !== "findMany") return Reflect.get(eventTarget, eventProperty, eventReceiver);
        return async (args: Parameters<typeof tx.sessionEvent.findMany>[0]) => {
          const rows = await tx.sessionEvent.findMany(args);
          eventReads += 1;
          if (!stalled) {
            stalled = true;
            signalRead();
            await aMayProceed;
          }
          return rows;
        };
      } });
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        return txProperty === "sessionEvent" ? eventDelegate : Reflect.get(txTarget, txProperty, txReceiver);
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;

  try {
    const a = recomputeSessionUsage(stallingDb, seeded.session.id).then(() => "resolved", (error) => error);
    await readIssued;
    // A has read and holds the lock. The second event only exists from here on.
    await addFinalOutput(seeded, 2, { type: "result", usage: { input_tokens: 20 } });
    let bSettled = false;
    const b = recomputeSessionUsage(secondClient, seeded.session.id)
      .then(() => "resolved", (error) => error)
      .then((outcome) => { bSettled = true; return outcome; });

    // Bounded, and well under the 3 s `lock_timeout` the recompute installs, so
    // B never aborts with 55P03 for a reason unrelated to the bug. Without the
    // lock B simply finishes, the poll observes that, and A's stale write lands
    // last — which is exactly the failure this test reports.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !bSettled) {
      const [waiting] = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND classid = ${SESSION_USAGE_LOCK_CLASS}::oid
      `;
      if ((waiting?.count ?? 0n) > 0n) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Hold A beyond B's first 3 s lock_timeout. Before the review fix B returned
    // 55P03 here, app.ts swallowed it, and A then committed 10 permanently even
    // though event 2 was already durable. B must instead roll back that attempt,
    // retry, and remain pending until A releases the lock.
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    assert.equal(bSettled, false, "B must retry after its first bounded lock wait");

    releaseA();
    const [aOutcome, bOutcome] = await Promise.all([a, b]);
    assert.equal(aOutcome, "resolved", `A failed: ${String(aOutcome)}`);
    assert.equal(bOutcome, "resolved", `B failed: ${String(bOutcome)}`);

    const columns = await storedColumns(seeded.session.id);
    assert.equal(
      columns.inputTokens,
      30,
      `expected 30, stored ${columns.inputTokens} (eventReads=${eventReads}) — an unserialised absolute write won`,
    );
  } finally {
    await secondClient.$disconnect();
  }
});

/* ------------------------------------------------------------- test 2a */

test("2a: the recompute's advisory lock is visible from another connection", { timeout: 20_000 }, async () => {
  // Preliminary to 2b, and what localises a test 1 failure: it says whether the
  // lock is missing or the interleaving is wrong.
  const seeded = await seedSession("lock-visible");
  const key = sessionUsageLockKey(seeded.session.id);
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let release!: () => void;
  const mayRelease = new Promise<void>((resolve) => { release = resolve; });
  try {
    const held = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SESSION_USAGE_LOCK_CLASS}::int, ${key}::int)::text AS locked`;
      await mayRelease;
    }, { timeout: 20_000 });

    let granted = 0n;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && granted === 0n) {
      const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND classid = ${SESSION_USAGE_LOCK_CLASS}::oid
      `;
      granted = row?.count ?? 0n;
      if (granted === 0n) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await held;
    assert.ok(granted > 0n, "a granted advisory lock in this class must be visible in pg_locks");
  } finally {
    await holder.$disconnect();
  }
});

/* ------------------------------------------------------------- test 2b */

test("2b: a recompute retries a bounded lock wait until the durable event is folded", { timeout: 30_000 }, async () => {
  // 2a proves a lock is visible. Only this proves a second RECOMPUTE is actually
  // made to wait. The first attempt reaches PostgreSQL's 3 s lock_timeout, but
  // that cannot be the public outcome: app.ts intentionally suppresses a
  // recompute error after the FINAL_OUTPUT rows are already durable. The
  // recompute must retry and eventually fold the event after the holder leaves.
  const seeded = await seedSession("contended");
  await addFinalOutput(seeded, 1, { type: "result", usage: { input_tokens: 7 } });
  const key = sessionUsageLockKey(seeded.session.id);

  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const contender = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let release!: () => void;
  const mayRelease = new Promise<void>((resolve) => { release = resolve; });
  let signalLocked!: () => void;
  const holderLocked = new Promise<void>((resolve) => { signalLocked = resolve; });
  try {
    // 20 s, not Prisma's default 5 s: the contender needs ≈3 s to give up and
    // could need 15 s if `lock_timeout` ever stops bounding an advisory wait. A
    // holder that timed out first would release the lock, let the contender
    // succeed, and fail this test while reporting the opposite of what happened.
    const held = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SESSION_USAGE_LOCK_CLASS}::int, ${key}::int)::text AS locked`;
      signalLocked();
      await mayRelease;
    }, { timeout: 20_000 });

    await holderLocked;
    const start = performance.now();
    let settled = false;
    const outcome = recomputeSessionUsage(contender, seeded.session.id).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    assert.equal(settled, false, "the contender must still be retrying after the first 3 s lock timeout");
    release();
    const [wrote] = await Promise.all([outcome, held]);
    const elapsed = performance.now() - start;
    assert.equal(wrote, true);
    assert.ok(elapsed >= 3_000, `expected a real lock timeout before retry, took ${Math.round(elapsed)} ms`);
    assert.ok(elapsed < 10_000, `expected success soon after release, took ${Math.round(elapsed)} ms`);
    assert.equal((await storedColumns(seeded.session.id)).inputTokens, 7);
  } finally {
    release();
    await contender.$disconnect();
    await holder.$disconnect();
  }
});
