import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  decidePrHandoff,
  decideRunOutputSatisfaction,
  parseRunOutputEvidence,
  type PrHandoffCandidate,
  type PersistedTaskOutput,
  type RunOutputRequirement,
  type RunOutputSatisfaction,
} from "./run-output-evidence.js";
import { LEGACY_TEMPLATE_GENERATIONS } from "./canonical-template-transition.js";

// Derive the historical output kind from the transition fixture so this test
// exercises an actual persisted predecessor without making it an accepted
// execution contract here.
const legacyReviewOutputKind = LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"][0]!.shape[1]!.outputKind;

const required: RunOutputRequirement = { outputKind: "implementation", immutableOncePersisted: false, remediable: true };
const findings: RunOutputRequirement = { outputKind: "review-findings", immutableOncePersisted: true, remediable: true };
const mechanical: RunOutputRequirement = { outputKind: "regression-verification-v2", immutableOncePersisted: false, remediable: false };
const optional: RunOutputRequirement = { outputKind: null, immutableOncePersisted: false, remediable: true };

const persisted = (runId: string | null, kind = "implementation"): PersistedTaskOutput => ({
  runId,
  kind,
  commitSha: "a".repeat(40),
});

for (const [name, requirement, output, expected] of [
  [
    "this Run's own output is the deliverable",
    required,
    persisted("run-1"),
    { case: "delivered", output: { kind: "implementation", commitSha: "a".repeat(40) } },
  ],
  [
    "a Step that requires nothing and wrote nothing needs nothing",
    optional,
    null,
    { case: "not-required" },
  ],
  [
    "an output this Run wrote counts even where the Step requires none",
    optional,
    persisted("run-1", "result"),
    { case: "delivered", output: { kind: "result", commitSha: "a".repeat(40) } },
  ],
  [
    "an immutable findings artifact from an earlier Run leaves nothing to author",
    findings,
    persisted("run-0", "review-findings"),
    { case: "satisfied-by-prior-run", outputKind: "review-findings" },
  ],
  [
    "a replaceable output from an earlier Run is not this Run's deliverable",
    required,
    persisted("run-0"),
    { case: "absent", outputKind: "implementation", remediable: true },
  ],
  [
    "an unowned output row is not this Run's deliverable",
    required,
    persisted(null),
    { case: "absent", outputKind: "implementation", remediable: true },
  ],
  [
    "a required deliverable nobody wrote is remediable",
    required,
    null,
    { case: "absent", outputKind: "implementation", remediable: true },
  ],
  [
    "a mechanical verdict cannot be re-asked from the agent",
    mechanical,
    null,
    { case: "absent", outputKind: "regression-verification-v2", remediable: false },
  ],
] as Array<[string, RunOutputRequirement, PersistedTaskOutput | null, RunOutputSatisfaction]>) {
  test(`run output satisfaction: ${name}`, () => {
    assert.deepEqual(decideRunOutputSatisfaction("run-1", requirement, output), expected);
  });
}

const candidate = (overrides: Partial<PrHandoffCandidate> & { kind: string; chainIndex: number }): PrHandoffCandidate => ({
  taskId: `task-${overrides.kind}`,
  body: JSON.stringify({ schemaVersion: 1 }),
  commitSha: String(overrides.chainIndex).repeat(40),
  ...overrides,
});

const finalCandidates = (): PrHandoffCandidate[] => [
  candidate({ kind: "implementation", chainIndex: 1 }),
  candidate({ kind: "review-findings", chainIndex: 2 }),
  candidate({ kind: "blind-findings", chainIndex: 3 }),
  candidate({ kind: "fixed-implementation", chainIndex: 4 }),
];

const finalDelivery = { taskId: "task-fixed-implementation", chainIndex: 4, stage: "final" } as const;

test("a Step that is not a canonical PR delivery carries no handoff", () => {
  assert.deepEqual(decidePrHandoff(null, []), { case: "not-a-pr-delivery" });
});

test("the implementation delivery carries its own output alone", () => {
  const handoff = decidePrHandoff(
    { taskId: "task-implementation", chainIndex: 1, stage: "implementation" },
    [candidate({ kind: "implementation", chainIndex: 1 })],
  );
  assert.equal(handoff.case, "complete");
  assert.deepEqual(handoff.case === "complete" ? handoff.outputs.map(({ kind }) => kind) : [], ["implementation"]);
});

test("the final delivery carries all four canonical outputs in chain order", () => {
  const handoff = decidePrHandoff(finalDelivery, finalCandidates());
  assert.equal(handoff.case, "complete");
  assert.deepEqual(
    handoff.case === "complete" ? handoff.outputs.map(({ chainIndex }) => chainIndex) : [],
    [1, 2, 3, 4],
  );
});

test("a SHA-256 commit identity is a canonical output identity", () => {
  const candidates = finalCandidates();
  candidates[3]!.commitSha = "d".repeat(64);
  assert.equal(decidePrHandoff(finalDelivery, candidates).case, "complete");
});

for (const [name, mutate, reason] of [
  ["a short handoff", (rows: PrHandoffCandidate[]) => rows.splice(2, 1), /requires exactly 4 output entries, not 3/u],
  ["an out-of-order kind", (rows: PrHandoffCandidate[]) => { rows.reverse(); }, /missing or out of order at implementation/u],
  ["an absent commit identity", (rows: PrHandoffCandidate[]) => { rows[0]!.commitSha = null; }, /malformed implementation canonical output evidence/u],
  ["a commit identity that is not a SHA", (rows: PrHandoffCandidate[]) => { rows[1]!.commitSha = "not-a-sha"; }, /malformed review-findings canonical output evidence/u],
  ["an empty body", (rows: PrHandoffCandidate[]) => { rows[2]!.body = "  "; }, /malformed blind-findings canonical output evidence/u],
  ["a non-positive chain index", (rows: PrHandoffCandidate[]) => { rows[0]!.chainIndex = 0; }, /malformed implementation canonical output evidence/u],
  ["a repeated chain index", (rows: PrHandoffCandidate[]) => { rows[1]!.chainIndex = 1; }, /not ordered by chain index/u],
  ["a repeated Task", (rows: PrHandoffCandidate[]) => { rows[1]!.taskId = rows[0]!.taskId; }, /repeats a Task/u],
  ["a current entry from another Task", (rows: PrHandoffCandidate[]) => { rows[3]!.taskId = "task-elsewhere"; }, /belongs to another Task/u],
  ["a current entry at another chain index", (rows: PrHandoffCandidate[]) => { rows[3]!.chainIndex = 9; }, /not for the current chain index/u],
] as Array<[string, (rows: PrHandoffCandidate[]) => void, RegExp]>) {
  test(`the final delivery refuses ${name}`, () => {
    const candidates = finalCandidates();
    mutate(candidates);
    const handoff = decidePrHandoff(finalDelivery, candidates);
    assert.equal(handoff.case, "incomplete");
    assert.match(handoff.case === "incomplete" ? handoff.reason : "", reason);
  });
}

test("the decided answer survives the wire unchanged", () => {
  const evidence = {
    satisfaction: decideRunOutputSatisfaction("run-1", required, persisted("run-1")),
    prHandoff: decidePrHandoff(finalDelivery, finalCandidates()),
  };
  assert.deepEqual(parseRunOutputEvidence(JSON.parse(JSON.stringify(evidence))), evidence);
});

for (const malformed of [
  undefined,
  null,
  { satisfaction: { case: "delivered" }, prHandoff: { case: "not-a-pr-delivery" } },
  { satisfaction: { case: "absent", outputKind: "implementation" }, prHandoff: { case: "not-a-pr-delivery" } },
  { satisfaction: { case: "not-required" } },
  {
    satisfaction: { case: "not-required" },
    prHandoff: { case: "complete", outputs: [{ taskId: "t", chainIndex: 1, kind: "implementation", body: "{}", commitSha: "zz" }] },
  },
]) {
  test(`the wire parse refuses ${JSON.stringify(malformed) ?? "undefined"}`, () => {
    assert.throws(() => parseRunOutputEvidence(malformed));
  });
}

test("PR handoff preserves the current review output contract through the wire", () => {
  const evidence = {
    satisfaction: decideRunOutputSatisfaction("run-1", required, persisted("run-1")),
    prHandoff: decidePrHandoff(finalDelivery, finalCandidates()),
  };
  assert.equal(evidence.prHandoff.case, "complete");
  if (evidence.prHandoff.case === "complete") assert.equal(evidence.prHandoff.outputs[1]!.kind, "review-findings");
  assert.deepEqual(parseRunOutputEvidence(JSON.parse(JSON.stringify(evidence))), evidence);
});

test("PR handoff refuses the historical review output kind with a named reason", () => {
  const rows = finalCandidates();
  rows[1]!.kind = legacyReviewOutputKind;
  assert.deepEqual(decidePrHandoff(finalDelivery, rows), {
    case: "incomplete",
    reason: "canonical PR handoff evidence is missing or out of order at review-findings",
  });
});

test("the wire parser refuses the historical review output kind", () => {
  const rows = finalCandidates();
  rows[1]!.kind = legacyReviewOutputKind;
  assert.throws(() => parseRunOutputEvidence({
    satisfaction: decideRunOutputSatisfaction("run-1", required, persisted("run-1")),
    prHandoff: { case: "complete", outputs: rows },
  }), (error: unknown) => {
    assert.ok(error instanceof z.ZodError);
    assert.equal(error.issues.length, 1);
    assert.deepEqual(error.issues[0]!.path, ["prHandoff", "outputs", 1, "kind"]);
    assert.equal(error.issues[0]!.code, "invalid_value");
    return true;
  });
});

test("PR handoff refuses duplicate review outputs in place of independent and blind review", () => {
  const rows = finalCandidates();
  rows[2]!.kind = "review-findings";
  assert.deepEqual(decidePrHandoff(finalDelivery, rows), {
    case: "incomplete", reason: "canonical PR handoff evidence is missing or out of order at blind-findings",
  });
});
