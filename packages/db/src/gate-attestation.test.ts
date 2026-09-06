import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";
import { LEGACY_TEMPLATE_GENERATIONS, templateRolloverName } from "./canonical-template-transition.js";

import { deriveGateAttestation, requireGateAttestation, recordGateAttestation } from "./gate-attestation.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const V2 = "regression-verification-v2";
const V1 = "regression-verification";

const pass = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  schemaVersion: 2,
  outcome: "pass",
  headSha: HEAD,
  baseHeadSha: BASE,
  gateVerdict: "PASS",
  gateProof: `MERGE GATE: PASS ${HEAD}`,
  ...overrides,
});

test("a passing v2 verdict attests the head the gate signed", () => {
  assert.deepEqual(deriveGateAttestation(V2, pass()), {
    headSha: HEAD,
    baseHeadSha: BASE,
    proof: `MERGE GATE: PASS ${HEAD}`,
  });
});

test("a proof naming another commit attests nothing", () => {
  assert.equal(deriveGateAttestation(V2, pass({ gateProof: `MERGE GATE: PASS ${BASE}` })), null);
});

test("a proof line without an oid attests nothing", () => {
  assert.equal(deriveGateAttestation(V2, pass({ gateProof: "MERGE GATE: PASS" })), null);
  assert.equal(deriveGateAttestation(V2, pass({ gateProof: undefined })), null);
});

test("outcomes other than pass attest nothing", () => {
  const gateFail = JSON.stringify({
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: HEAD,
    baseHeadSha: BASE,
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (unit tests)",
    summary: "unit tests",
  });
  assert.equal(deriveGateAttestation(V2, gateFail), null);
  const refreshConflict = JSON.stringify({
    schemaVersion: 2,
    outcome: "refresh-conflict",
    headSha: HEAD,
    baseHeadSha: BASE,
    summary: "the branch no longer refreshes cleanly onto its base",
  });
  assert.equal(deriveGateAttestation(V2, refreshConflict), null);
});

test("the frozen v1 generation attests nothing, whatever it reports", () => {
  const v1Pass = JSON.stringify({
    schemaVersion: 1,
    outcome: "pass",
    headSha: HEAD,
    baseHeadSha: BASE,
    gateVerdict: "PASS",
  });
  assert.equal(deriveGateAttestation(V1, v1Pass), null);
  // A v1 body that forges the v2 proof line still attests nothing: the kind,
  // not the body, decides which generation is being read.
  assert.equal(deriveGateAttestation(V1, pass()), null);
});

test("non-regression outputs and unusable bodies attest nothing", () => {
  assert.equal(deriveGateAttestation("documentation", pass()), null);
  assert.equal(deriveGateAttestation(V2, "not json"), null);
  assert.equal(deriveGateAttestation(V2, null), null);
});

const requirementFor = (name: string, outputKind: string) => requireGateAttestation({
  mergeGateAttestation: { findUnique: async () => null },
  task: { findMany: async () => [{ templateStep: { outputKind, taskTemplate: { name } } }] },
} as unknown as Prisma.TransactionClient, { chainId: "chain", headSha: HEAD });

test("registered retired Regression protocols retain exactly their v1 exemption", async () => {
  for (const [name, generations] of Object.entries(LEGACY_TEMPLATE_GENERATIONS)) {
    for (const generation of generations) {
      const regression = generation.shape.find((step) => step.outputKind.startsWith("regression-verification"));
      if (!regression) continue;
      const result = await requirementFor(templateRolloverName(name, generation.marker, "row"), regression.outputKind);
      assert.equal(result.satisfied, regression.outputKind === V1, `${name}/${generation.marker}`);
    }
  }
  for (const marker of ["10", "9", "human-12", "regression-first-13"]) {
    assert.equal((await requirementFor(templateRolloverName("compound-engineer-workflow", marker, "row"), V1)).satisfied, true);
  }
  assert.equal((await requirementFor(templateRolloverName("direct-engineer-workflow", "human-6", "row"), V1)).satisfied, true);
  for (const name of ["compound-engineer-workflow-legacy-v1", "direct-engineer-workflow-legacy-v1"]) {
    assert.equal((await requirementFor(name, V1)).satisfied, true);
  }
});

test("a retired marker does not exempt a later or unknown Regression protocol", async () => {
  const name = templateRolloverName("compound-engineer-workflow", "pre-adjudication", "row");
  for (const kind of [V2, "regression-verification-v3", "regression-attestation"]) {
    assert.equal((await requirementFor(name, kind)).satisfied, false, kind);
  }
});

test("re-attesting the same head refreshes the base and source provenance", async () => {
  let row: Record<string, unknown> | null = null;
  const tx = { mergeGateAttestation: { upsert: async (input: {
    create: Record<string, unknown>; update: Record<string, unknown>;
  }) => { row = row ? { ...row, ...input.update } : input.create; } } } as unknown as Prisma.TransactionClient;
  await recordGateAttestation(tx, { chainId: "chain", taskId: "first-task", runId: "first-run", kind: V2, body: pass() });
  const nextBase = "c".repeat(40);
  await recordGateAttestation(tx, { chainId: "chain", taskId: "next-task", runId: "next-run", kind: V2, body: pass({ baseHeadSha: nextBase }) });
  assert.equal(row?.["baseHeadSha"], nextBase);
  assert.equal(row?.["taskId"], "next-task");
  assert.equal(row?.["runId"], "next-run");
});
