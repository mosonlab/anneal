import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "./decision-table.js";
import { AUTHORIZED_BASE as BASE, AUTHORIZED_HEAD as C1, authorization, cleanSnapshot, makeFake } from "./fake-pr-surface.js";
import type { TrainGitHub } from "./github.js";

const C2 = "d".repeat(40);
const P1 = "e".repeat(40);
const P2 = "f".repeat(40);

const fixture = (position = 1) => {
  const head = position === 1 ? C1 : C2;
  const candidate = position === 1 ? P1 : P2;
  const predecessor = position === 1 ? BASE : P1;
  const auth = authorization({ headSha: head, train: { publishHead: P2, predecessorOid: predecessor, ref: `refs/anneal/train/${P2}`, position, trainTaskId: "train-task" } });
  const fake = makeFake({ envelope: { authorization: auth } });
  const state = { base: BASE, merged: false, sends: 0, deletes: 0, logs: [] as string[], wrongParents: false, ref: P2 as string | null, head, reject: false, lose: false, land: true };
  const train: TrainGitHub = {
    readDefaultBranch: async () => ({ status: "ok", name: "master", oid: state.base }),
    readRef: async () => ({ status: "ok", oid: state.ref }),
    isAncestor: async (_ref, ancestor, descendant) => ({ status: "ok", ancestor: ancestor === descendant || (descendant === P2 && [BASE, C1, C2, P1].includes(ancestor)) }),
    readCommit: async (_ref, oid) => ({ status: "ok", commit: { oid, parents: oid === P2 ? [P1, C2] : oid === P1 ? [BASE, C1] : [] } }),
    publishTrain: async () => {
      state.sends++;
      if (state.reject) return { status: "rejected", reason: "non-fast-forward" };
      if (state.land) { state.base = P2; state.merged = true; }
      return state.lose ? { status: "unknown", reason: "EOF" } : { status: "published" };
    },
    deleteTrainRef: async () => { state.deletes++; state.ref = null; return { ok: true }; },
  };
  fake.deps.train = train;
  fake.deps.logTrainCleanupFailure = (reason) => { state.logs.push(reason); };
  fake.deps.readPullRequest = async () => ({ status: "ok", snapshot: cleanSnapshot({ repository: { baseRefOid: state.base }, pullRequest: {
    headRefOid: state.head, merged: state.merged, state: state.merged ? "MERGED" : "OPEN", mergedByLogin: "some-ref-updater",
    mergeCommit: state.merged ? { oid: candidate, parents: [predecessor, state.wrongParents ? BASE : head] } : null,
  } }) });
  return { ...fake, state, train, auth };
};

for (const position of [1, 2]) test(`train position ${position} publishes once and verifies its own merge commit`, async () => {
  const f = fixture(position);
  if (position === 2) f.state.base = P1;
  assert.deepEqual(await execute(f.deps), { outcome: "merged", mergeCommitSha: position === 1 ? P1 : P2 });
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.deletes, position === 2 ? 1 : 0);
  assert.equal(f.calls().includes("merge"), false);
  assert.equal(f.calls().includes("writeIntent"), true);
});

for (const check of ["head", "ref-missing", "ref-mismatch", "head-ancestry", "base-position-1", "base-ancestry"]) test(`train precondition rejects ${check} without any write`, async () => {
  const f = fixture(check === "base-ancestry" ? 2 : 1);
  if (check === "head") f.state.head = BASE;
  if (check === "ref-missing") f.state.ref = null;
  if (check === "ref-mismatch") f.state.ref = P1;
  if (check === "head-ancestry") f.train.isAncestor = async () => ({ status: "ok", ancestor: false });
  if (check.startsWith("base-")) f.state.base = "9".repeat(40);
  
  const result = await execute(f.deps);
  assert.equal(result.outcome, "stopped");
  if (result.outcome === "stopped") { assert.equal(result.condition, "train-precondition-failed"); assert.ok(JSON.parse(result.evidence).check); }
  assert.equal(f.state.sends, 0);
  assert.equal(f.state.deletes, 0);
  assert.equal(f.calls().includes("writeIntent"), false);
});

test("train replay after publication and cleanup needs no second write or prior candidate intent", async () => {
  const f = fixture(2);
  f.state.base = P2; f.state.merged = true; f.state.ref = null;
  assert.deepEqual(await execute(f.deps), { outcome: "merged", mergeCommitSha: P2 });
  assert.equal(f.state.sends, 0);
});

test("train already published while PR projection is open skips the write", async () => {
  const f = fixture(); f.state.base = P2;
  const read = f.deps.readPullRequest;
  let reads = 0;
  f.deps.readPullRequest = async (ref) => { if (++reads > 1) f.state.merged = true; return read(ref); };
  assert.deepEqual(await execute(f.deps), { outcome: "merged", mergeCommitSha: P1 });
  assert.equal(f.state.sends, 0);
});

test("train non-fast-forward rejection is a named stop", async () => {
  const f = fixture(); f.state.reject = true;
  const result = await execute(f.deps);
  assert.equal(result.outcome === "stopped" && result.condition, "train-publish-rejected");
  assert.equal(f.state.sends, 1);
});

test("train merged PR with wrong second parent remains changed-underneath-me", async () => {
  const f = fixture(); f.state.base = P2; f.state.merged = true; f.state.wrongParents = true;
  const result = await execute(f.deps);
  assert.equal(result.outcome === "stopped" && result.condition, "changed-underneath-me");
  assert.equal(f.state.sends, 0);
});

test("train cleanup failure is logged and does not stop success", async () => {
  const f = fixture(2); f.train.deleteTrainRef = async () => ({ ok: false, reason: "denied" });
  assert.deepEqual(await execute(f.deps), { outcome: "merged", mergeCommitSha: P2 });
  assert.deepEqual(f.state.logs, ["denied"]);
});

test("train lost response is read back before any resend", async () => {
  const f = fixture(); f.state.lose = true;
  assert.deepEqual(await execute(f.deps), { outcome: "merged", mergeCommitSha: P1 });
  assert.equal(f.state.sends, 1);
});

test("train resend bound permits at most two lost-and-absent writes", async () => {
  const f = fixture(); f.state.lose = true; f.state.land = false;
  const result = await execute(f.deps);
  assert.equal(result.outcome === "stopped" && result.condition, "api-error");
  assert.equal(f.state.sends, 2);
});

for (const resend of [false, true]) test(`train supersession stops ${resend ? "resend" : "first send"}`, async () => {
  const f = fixture(); f.state.lose = true; f.state.land = false;
  const read = f.deps.readChain; let reads = 0;
  f.deps.readChain = async () => { const envelope = await read(); return ++reads >= (resend ? 3 : 2) ? { ...envelope, authorization: null } : envelope; };
  const result = await execute(f.deps);
  assert.equal(result.outcome === "stopped" && result.condition, "superseded-authorization");
  assert.equal(f.state.sends, resend ? 1 : 0);
});

for (const shape of ["position", "predecessor", "first-parent", "octopus", "merge-oid"]) test(`train replay refuses wrong ${shape} lineage`, async () => {
  const f = fixture(2); f.state.base = P2; f.state.merged = true;
  if (shape === "position") f.auth.train!.position = 1;
  if (shape === "predecessor") f.auth.train!.predecessorOid = BASE;
  const readCommit = f.train.readCommit;
  f.train.readCommit = async (ref, oid) => {
    const result = await readCommit(ref, oid);
    if (result.status === "ok" && oid === P2) {
      if (shape === "first-parent") result.commit.parents[0] = C1;
      if (shape === "octopus") result.commit.parents.push(BASE);
    }
    return result;
  };
  if (shape === "merge-oid") {
    const read = f.deps.readPullRequest;
    f.deps.readPullRequest = async (ref) => { const r = await read(ref); if (r.status === "ok") r.snapshot.pullRequest.mergeCommit!.oid = P1; return r; };
  }
  const result = await execute(f.deps);
  assert.equal(result.outcome === "stopped" && result.condition, "changed-underneath-me");
  assert.equal(f.state.sends, 0); assert.equal(f.state.deletes, 0);
});

test("train replay accepts a default branch that has advanced beyond the published prefix", async () => {
  const f = fixture(); f.state.base = "9".repeat(40); f.state.merged = true;
  f.train.isAncestor = async () => ({ status: "ok", ancestor: true });
  assert.deepEqual(await execute(f.deps), { outcome: "merged", mergeCommitSha: P1 });
  assert.equal(f.state.sends, 0);
});

test("train ambiguous read-back never resends a possibly applied update", async () => {
  const f = fixture(); f.state.lose = true; f.state.land = false;
  const read = f.train.readDefaultBranch;
  f.train.readDefaultBranch = async (ref) => f.state.sends ? { status: "api-error", reason: "unreadable" } : read(ref);
  const result = await execute(f.deps);
  assert.equal(result.outcome === "stopped" && result.condition, "api-error");
  assert.equal(f.state.sends, 1);
});

test("train resend rechecks all preconditions before another update", async () => {
  const f = fixture(); f.state.lose = true; f.state.land = false;
  const publish = f.train.publishTrain;
  f.train.publishTrain = async (...args) => { const r = await publish(...args); f.state.head = BASE; return r; };
  const result = await execute(f.deps);
  assert.equal(result.outcome === "stopped" && result.condition, "train-precondition-failed");
  assert.equal(f.state.sends, 1);
});

test("train final pre-send read catches drift after intent without publishing", async () => {
  const f = fixture(); const write = f.deps.writeIntent;
  f.deps.writeIntent = async (intent) => { await write(intent); f.state.ref = P1; };
  const result = await execute(f.deps);
  assert.equal(result.outcome === "stopped" && result.condition, "train-precondition-failed");
  assert.equal(f.state.sends, 0);
});

test("executor train authorization parser retains the descriptor and rejects every malformed field", async () => {
  const { authorizationMetadata, parseAuthorizationMetadata } = await import("@anneal/db/merge-integrator");
  const { auth } = fixture();
  const metadata = authorizationMetadata(auth);
  const parsed = parseAuthorizationMetadata(metadata);
  assert.equal(parsed.status, "ok");
  if (parsed.status === "ok") assert.deepEqual(parsed.payload.train, auth.train);
  for (const patch of [
    { publishHead: "a".repeat(39) }, { publishHead: "z".repeat(40) },
    { predecessorOid: "b".repeat(41) }, { predecessorOid: "g".repeat(40) },
    { ref: `refs/heads/${P2}` }, { ref: `refs/anneal/train/${P1}` },
    { position: 0 }, { position: -1 }, { position: 1.5 }, { position: "1" },
  ]) assert.equal(parseAuthorizationMetadata({ ...metadata, train: { ...auth.train, ...patch } }).status, "malformed");
});
