import assert from "node:assert/strict";
import test from "node:test";
import type { MergeTrainRecord } from "@anneal/db";
import { trainRecordBindingFailure } from "./merge-train-readiness.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const oid = "c".repeat(40);
const candidate = { taskId: "ready-1", chainId: "chain-1", headSha: head, branch: "feat/one" };
const record: MergeTrainRecord = {
  schemaVersion: 1, baseSha: base, width: 2, contiguousPassCount: 1,
  prefixes: [{ index: 1, taskId: candidate.taskId, chainId: candidate.chainId,
    candidateHeadSha: head, predecessorOid: base, prefixOid: oid,
    ref: `refs/anneal/train/${oid}`, verdict: "pass", gateExcerpt: `MERGE GATE: PASS ${oid}` }],
  blocked: [], skipped: [],
};

test("train qualification binds the complete ordered candidate list and live base", () => {
  assert.equal(trainRecordBindingFailure(record, { baseSha: base, width: 2, candidates: [candidate] }, base), null);
  assert.match(trainRecordBindingFailure(record, { baseSha: base, width: 2, candidates: [candidate] }, head)!, /live base/);
  assert.match(trainRecordBindingFailure(record, { baseSha: base, width: 2, candidates: [{ ...candidate, headSha: oid }] }, base)!, /candidate/);
  assert.match(trainRecordBindingFailure(record, { baseSha: base, width: 2, candidates: [candidate, { ...candidate, taskId: "ready-2" }] }, base)!, /candidate/);
});

test("train qualification refuses reordered, duplicate, and foreign record entries", () => {
  const second = { ...candidate, taskId: "ready-2", chainId: "chain-2" };
  const intent = { baseSha: base, width: 2, candidates: [candidate, second] };
  assert.match(trainRecordBindingFailure({ ...record, blocked: [{ taskId: "foreign", chainId: second.chainId, candidateHeadSha: head, reason: "conflict" }] }, intent, base)!, /candidate/);
  assert.match(trainRecordBindingFailure({ ...record, blocked: [{ taskId: candidate.taskId, chainId: candidate.chainId, candidateHeadSha: head, reason: "conflict" }] }, intent, base)!, /candidate/);
  assert.equal(trainRecordBindingFailure({ ...record, blocked: [{ taskId: second.taskId, chainId: second.chainId, candidateHeadSha: head, reason: "conflict" }] }, intent, base), null);
});
