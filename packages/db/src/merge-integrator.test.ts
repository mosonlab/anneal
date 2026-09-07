import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPROVE_CHOICE_ID,
  BASE_DRIFT_CLASS_CEILING_CHOICES,
  AUTHORIZATION_BINDING_WINDOW_MS,
  EVIDENCE_PLACEHOLDER_BODY,
  EVIDENCE_UNAVAILABLE_MARKER,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  STOP_CHOICES,
  STOP_CONDITIONS,
  type CandidateActivity,
  type CardRow,
  type DecisionRow,
  type MergeEvidence,
  authorizationMetadata,
  canonicalIntegratorBindingValid,
  dispositionFor,
  evidenceEquals,
  followUpDispositionFor,
  integratorBindingValid,
  isIncidentCondition,
  isIntegratorStep,
  isStopCondition,
  isTerminalDisposition,
  parseEvidence,
  parseAuthorizationMetadata,
  parseMergeResult,
  parseStopAnswerMetadata,
  projectMergeOutcome,
  runOwnsMergeOutcome,
  selectAuthorization,
  serializeEvidence,
  serializeMergeResult,
} from "./merge-integrator.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);
const TRAIN_HEAD = "d".repeat(40);
const TRAIN_PREDECESSOR = "e".repeat(40);

const evidence = (overrides: Partial<MergeEvidence> = {}): MergeEvidence => ({
  schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
  nonce: "nonce-1",
  repository: "mosonlab/agentos",
  prNumber: 100,
  headSha: HEAD,
  baseRef: "master",
  baseSha: BASE,
  mergeMethod: "merge",
  requiredChecks: [{ name: "build", conclusion: "SUCCESS" }],
  readAt: "2026-08-18T02:00:00.000Z",
  ...overrides,
});

const card = (overrides: Partial<CardRow> = {}): CardRow => ({
  id: "card-1",
  gateTaskId: "step9",
  status: "ANSWERED",
  selectedChoiceId: APPROVE_CHOICE_ID,
  body: `审批闸门\n\n${serializeEvidence(evidence())}`,
  ...overrides,
});

const decision = (overrides: Partial<DecisionRow> = {}): DecisionRow => ({
  id: "decision-1",
  decision: APPROVE_CHOICE_ID,
  createdAt: new Date("2026-08-18T02:00:01.000Z"),
  inboxMessageId: "card-1",
  ...overrides,
});

const activity = (
  payloadEvidence: MergeEvidence,
  overrides: Partial<CandidateActivity> & { decisionId?: string; messageId?: string } = {},
): CandidateActivity => {
  const { decisionId = "decision-1", messageId = "card-1", ...rest } = overrides;
  return {
    id: "activity-1",
    createdAt: new Date("2026-08-18T02:00:01.100Z"),
    actorType: "operator",
    metadata: authorizationMetadata({
      ...payloadEvidence,
      issuedAt: "2026-08-18T02:00:01.100Z",
      decision: { channel: "inbox", inboxDecisionId: decisionId, inboxMessageId: messageId },
    }),
    ...rest,
  };
};

// --- the evidence block parser -------------------------------------------

test("a well-formed evidence block round-trips through the serializer", () => {
  const parsed = parseEvidence(`preamble\n${serializeEvidence(evidence())}\ntrailer`);
  assert.equal(parsed.status, "ok");
  assert.ok(parsed.status === "ok" && evidenceEquals(parsed.evidence, evidence()));
});

test("a placeholder card carries no block and an unavailable card is named as such", () => {
  assert.equal(parseEvidence(EVIDENCE_PLACEHOLDER_BODY).status, "absent");
  assert.equal(parseEvidence(null).status, "absent");
  assert.equal(parseEvidence(`body ${EVIDENCE_UNAVAILABLE_MARKER}`).status, "unavailable");
});

test("a truncated, mistyped or wrong-method block is unparseable, never a silent pass", () => {
  assert.equal(parseEvidence("```agentos-merge-evidence\n{\"schemaVersion\":1").status, "absent");
  assert.equal(parseEvidence("```agentos-merge-evidence\nnot json\n```").status, "unparseable");
  assert.equal(parseEvidence(serializeEvidence(evidence({ headSha: "short" }))).status, "unparseable");
  assert.equal(parseEvidence(serializeEvidence(evidence({ mergeMethod: "squash" }))).status, "unparseable");
  assert.equal(parseEvidence(serializeEvidence(evidence({ prNumber: 0 }))).status, "unparseable");
});

test("evidence equality is field-by-field and includes the nonce", () => {
  assert.ok(evidenceEquals(evidence(), evidence()));
  assert.ok(!evidenceEquals(evidence(), evidence({ nonce: "nonce-2" })));
  assert.ok(!evidenceEquals(evidence(), evidence({ headSha: OTHER })));
  assert.ok(!evidenceEquals(evidence(), evidence({ requiredChecks: [] })));
});

// --- the authorization metadata parser ----------------------------------

const trainAuthorization = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  publishHead: TRAIN_HEAD,
  predecessorOid: TRAIN_PREDECESSOR,
  ref: `refs/anneal/train/${TRAIN_HEAD}`,
  position: 1,
  trainTaskId: "train-task-1",
  ...overrides,
});

const authorizationMetadataWithTrain = (train: Record<string, unknown> | undefined): Record<string, unknown> => ({
  ...authorizationMetadata({
    ...evidence(),
    issuedAt: "2026-08-18T02:00:01.100Z",
    decision: { channel: "mechanical", inboxDecisionId: "binding", inboxMessageId: "binding" },
  }),
  ...(train === undefined ? {} : { train }),
});

test("an authorization may carry a validated train publication descriptor", () => {
  const parsed = parseAuthorizationMetadata(authorizationMetadataWithTrain(trainAuthorization({ position: 2 })));
  assert.equal(parsed.status, "ok");
  assert.ok(parsed.status === "ok");
  assert.deepEqual(parsed.payload.train, {
    publishHead: TRAIN_HEAD,
    predecessorOid: TRAIN_PREDECESSOR,
    ref: `refs/anneal/train/${TRAIN_HEAD}`,
    position: 2,
    trainTaskId: "train-task-1",
  });

  const ordinary = parseAuthorizationMetadata(authorizationMetadataWithTrain(undefined));
  assert.equal(ordinary.status, "ok");
  assert.ok(ordinary.status === "ok");
  assert.equal(Object.hasOwn(ordinary.payload, "train"), false);
});

test("the authorization parser rejects malformed train publication descriptors", () => {
  for (const [field, value] of [
    ["publishHead", "short"],
    ["predecessorOid", "short"],
    ["ref", "refs/heads/main"],
    ["position", 0],
    ["position", -1],
    ["position", 1.5],
  ] as const) {
    const parsed = parseAuthorizationMetadata(authorizationMetadataWithTrain(trainAuthorization({ [field]: value })));
    assert.equal(parsed.status, "malformed", field);
  }

  assert.equal(parseAuthorizationMetadata(authorizationMetadataWithTrain(null as unknown as Record<string, unknown>)).status, "malformed");
  assert.equal(parseAuthorizationMetadata(authorizationMetadataWithTrain(trainAuthorization({ trainTaskId: "" }))).status, "malformed");
});

// --- §D-P2 the selection validator ---------------------------------------

test("a valid authorization is selected and reports no near-matches", () => {
  const result = selectAuthorization([activity(evidence())], [decision()], [card()], "step9");
  assert.equal(result.refusal, null);
  assert.equal(result.authorization?.headSha, HEAD);
  assert.equal(result.nearMatchCount, 0);
  assert.equal(result.ignoredCount, 0);
});

test("a server-owned readiness authorization needs no human decision and cannot be forged as operator activity", () => {
  const binding = "mechanical:readiness-1";
  const mechanical: CandidateActivity = {
    id: "mechanical-authorization",
    createdAt: new Date("2026-08-18T02:00:01.100Z"),
    actorType: "control-plane",
    metadata: authorizationMetadata({
      ...evidence(),
      issuedAt: "2026-08-18T02:00:01.100Z",
      decision: { channel: "mechanical", inboxDecisionId: binding, inboxMessageId: binding },
    }),
  };
  const selected = selectAuthorization([mechanical], [], [], "readiness-1");
  assert.equal(selected.refusal, null);
  assert.equal(selected.authorization?.headSha, HEAD);
  assert.equal(selectAuthorization([{ ...mechanical, actorType: "operator" }], [], [], "readiness-1").authorization, null);
  assert.equal(selectAuthorization([mechanical], [], [], "another-readiness").authorization, null);
});

test("fresh mechanical cycles keep prior authorization evidence while selecting the newest unique binding", () => {
  const firstBinding = "mechanical:readiness-1:first";
  const secondBinding = "mechanical:readiness-1:second";
  const candidate = (id: string, createdAt: string, binding: string, baseSha: string): CandidateActivity => ({
    id, createdAt: new Date(createdAt), actorType: "control-plane",
    metadata: authorizationMetadata({
      ...evidence({ baseSha }), issuedAt: createdAt,
      decision: { channel: "mechanical", inboxDecisionId: binding, inboxMessageId: binding },
    }),
  });
  const first = candidate("first", "2026-08-18T02:00:01.100Z", firstBinding, BASE);
  const second = candidate("second", "2026-08-18T02:01:01.100Z", secondBinding, "d".repeat(40));
  const selected = selectAuthorization([first, second], [], [], "readiness-1");
  assert.equal(selected.authorization?.activityId, "second");
  assert.equal(selected.authorization?.baseSha, "d".repeat(40));
});

test("rule 1: a non-operator actorType is ignored", () => {
  const result = selectAuthorization([activity(evidence(), { actorType: "session" })], [decision()], [card()], "step9");
  assert.equal(result.authorization, null);
  assert.equal(result.ignoredCount, 1);
  assert.equal(result.refusal, "missing");
});

test("rule 2: a forged activity bearing a real winning decision id from another chain is refused", () => {
  const result = selectAuthorization(
    [activity(evidence())],
    [decision()],
    [card({ gateTaskId: "someone-elses-step9" })],
    "step9",
  );
  assert.equal(result.authorization, null);
  assert.equal(result.ignoredCount, 1);
});

test("rule 2: an authorization naming a decision that does not exist is ignored", () => {
  const result = selectAuthorization([activity(evidence(), { decisionId: "ghost" })], [decision()], [card()], "step9");
  assert.equal(result.authorization, null);
  assert.equal(result.ignoredCount, 1);
});

test("rule 3: a decision that exists but did not win is refused", () => {
  const rejected = selectAuthorization(
    [activity(evidence())],
    [decision({ decision: "reject" })],
    [card({ selectedChoiceId: "reject" })],
    "step9",
  );
  assert.equal(rejected.authorization, null);
  const stillOpen = selectAuthorization([activity(evidence())], [decision()], [card({ status: "OPEN" })], "step9");
  assert.equal(stillOpen.authorization, null);
});

test("rule 4: MF-2's forgery — a real winning decision id with fresh head/base fields — is a near-match, not an authorization", () => {
  const forged = activity(evidence({ headSha: OTHER, baseSha: OTHER }));
  const result = selectAuthorization([forged], [decision()], [card()], "step9");
  assert.equal(result.authorization, null);
  assert.equal(result.nearMatchCount, 1);
  assert.equal(result.refusal, "malformed-near-match");
});

test("rule 4: a payload whose nonce differs from the displayed block is a near-match", () => {
  const result = selectAuthorization([activity(evidence({ nonce: "other" }))], [decision()], [card()], "step9");
  assert.equal(result.authorization, null);
  assert.equal(result.nearMatchCount, 1);
});

test("rule 5: one decision reused across two authorizations disqualifies both", () => {
  const first = activity(evidence(), { id: "a1" });
  const second = activity(evidence(), { id: "a2", createdAt: new Date("2026-08-18T02:00:01.200Z") });
  const result = selectAuthorization([first, second], [decision()], [card()], "step9");
  assert.equal(result.authorization, null);
  assert.equal(result.ignoredCount, 2);
});

test("rule 6: an activity written long after its decision is a near-match", () => {
  const late = activity(evidence(), {
    createdAt: new Date(decision().createdAt.getTime() + AUTHORIZATION_BINDING_WINDOW_MS + 1),
  });
  const result = selectAuthorization([late], [decision()], [card()], "step9");
  assert.equal(result.authorization, null);
  assert.equal(result.nearMatchCount, 1);
});

test("supersession is latest-wins, and an exact tie is ambiguity rather than a coin flip", () => {
  const older = activity(evidence(), { id: "a1", decisionId: "decision-1", messageId: "card-1" });
  const newerEvidence = evidence({ nonce: "nonce-2", headSha: OTHER });
  const newer = activity(newerEvidence, {
    id: "a2",
    createdAt: new Date("2026-08-18T02:00:03.100Z"),
    decisionId: "decision-2",
    messageId: "card-2",
  });
  const cards = [card(), card({ id: "card-2", body: serializeEvidence(newerEvidence) })];
  const decisions = [decision(), decision({ id: "decision-2", inboxMessageId: "card-2", createdAt: new Date("2026-08-18T02:00:03.000Z") })];
  const latest = selectAuthorization([older, newer], decisions, cards, "step9");
  assert.equal(latest.authorization?.activityId, "a2");
  assert.equal(latest.authorization?.headSha, OTHER);

  const tied = selectAuthorization(
    [older, { ...newer, createdAt: older.createdAt }],
    decisions.map((row) => ({ ...row, createdAt: new Date(older.createdAt.getTime() - 100) })),
    cards,
    "step9",
  );
  assert.equal(tied.authorization, null);
  assert.equal(tied.refusal, "ambiguous-tie");
});

test("an unrelated activity is neither counted nor refused", () => {
  const unrelated: CandidateActivity = {
    id: "x", createdAt: new Date(), actorType: "operator", metadata: { kind: "goal5a0.merge_authorization" },
  };
  const result = selectAuthorization([unrelated], [], [], "step9");
  assert.equal(result.ignoredCount, 0);
  assert.equal(result.nearMatchCount, 0);
  assert.equal(result.refusal, "missing");
});

// --- §D-P4 the binding invariant -----------------------------------------

const integratorStep = { stepIndex: INTEGRATOR_STEP_INDEX, outputKind: "merge-result", taskTemplate: { name: "compound-engineer-workflow" } };

test("the binding predicate holds in both directions", () => {
  assert.ok(isIntegratorStep(integratorStep));
  assert.ok(integratorBindingValid(INTEGRATOR_AGENT_NAME, integratorStep));
  assert.ok(integratorBindingValid("senior-dev-astra-medium", { stepIndex: 5, outputKind: "implementation", taskTemplate: { name: "compound-engineer-workflow" } }));
  // The sentinel on an ordinary step, and an ordinary agent on step 12.
  assert.ok(!integratorBindingValid(INTEGRATOR_AGENT_NAME, null));
  assert.ok(!integratorBindingValid(INTEGRATOR_AGENT_NAME, { stepIndex: 5, outputKind: "implementation", taskTemplate: { name: "compound-engineer-workflow" } }));
  assert.ok(!integratorBindingValid("senior-dev-astra-medium", integratorStep));
});

test("integrator binding follows Step role across template names and ordinals", () => {
  for (const candidate of [
    integratorStep,
    { stepIndex: 1, outputKind: INTEGRATOR_OUTPUT_KIND, taskTemplate: { name: "some-other-template" } },
    { stepIndex: 99, outputKind: INTEGRATOR_OUTPUT_KIND, taskTemplateName: "retired-generation" },
  ]) {
    assert.equal(isIntegratorStep(candidate), true);
    assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, candidate), true);
    assert.equal(canonicalIntegratorBindingValid(INTEGRATOR_AGENT_NAME, candidate), true);
  }
});

test("a non-integrator role never binds the sentinel", () => {
  const implementation = {
    stepIndex: INTEGRATOR_STEP_INDEX,
    outputKind: "implementation",
    taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME },
  };
  assert.equal(isIntegratorStep(implementation), false);
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, implementation), false);
});

// --- §D-P7 the disposition machine ---------------------------------------

test("every stop condition offers at least one choice and every choice resolves to a disposition", () => {
  for (const condition of STOP_CONDITIONS) {
    const choices = STOP_CHOICES[condition];
    assert.ok(choices.length > 0, `${condition} offers no choice`);
    for (const choice of choices) {
      assert.ok(dispositionFor(condition, choice) !== null, `${condition}/${choice} has no disposition`);
    }
  }
});

test("train publication failures are named resumable stop conditions", () => {
  for (const condition of ["train-precondition-failed", "train-publish-rejected"] as const) {
    assert.equal(isStopCondition(condition), true);
    assert.deepEqual(STOP_CHOICES[condition], ["re-authorize", "abandon"]);
    assert.equal(dispositionFor(condition, "re-authorize"), "refresh-requested");
  }
});

test("target-unresolvable does not offer re-authorize, which could not change its inputs", () => {
  assert.ok(!STOP_CHOICES["target-unresolvable"].includes("re-authorize"));
  assert.equal(dispositionFor("target-unresolvable", "re-authorize"), null);
  assert.equal(dispositionFor("target-unresolvable", "open-repair"), "repair-requested");
});

test("ordinary pre-merge base drift cannot enter the manual re-authorization path", () => {
  assert.deepEqual(STOP_CHOICES["base-drift"], ["abandon"]);
  assert.equal(dispositionFor("base-drift", "re-authorize"), null);
});

test("base drift answers re-validate as its own nonterminal disposition, and no other condition does", () => {
  assert.deepEqual(BASE_DRIFT_CLASS_CEILING_CHOICES, ["re-validate", "abandon"]);
  assert.equal(dispositionFor("base-drift", "re-validate"), "revalidation-requested");
  assert.equal(dispositionFor("base-drift", "abandon"), "terminal-abandoned");
  assert.ok(!isTerminalDisposition("revalidation-requested"));
  // The wider card is the recovery's to open; nothing else answers this choice.
  for (const condition of STOP_CONDITIONS) {
    if (condition === "base-drift") continue;
    assert.equal(dispositionFor(condition, "re-validate"), null, condition);
  }
  assert.equal(followUpDispositionFor("re-validate"), null);
});

test("flag-incident is nonterminal and its follow-up offers the terminal exits", () => {
  assert.equal(dispositionFor("changed-underneath-me", "flag-incident"), "nonterminal");
  assert.ok(!isTerminalDisposition("nonterminal"));
  assert.equal(followUpDispositionFor("accept-foreign-merge"), "terminal-done");
  assert.equal(followUpDispositionFor("abandon"), "terminal-abandoned");
  // flag-incident cannot be answered again through the follow-up.
  assert.equal(followUpDispositionFor("flag-incident"), null);
});

test("a choice valid for one condition is refused for another", () => {
  assert.equal(dispositionFor("head-drift", "accept"), null);
  assert.equal(dispositionFor("head-drift", "re-authorize"), "refresh-requested");
  assert.equal(dispositionFor("base-drift-post-merge", "re-authorize"), null);
  assert.equal(dispositionFor("head-drift", "not-a-choice"), null);
});

test("re-authorize and open-repair are nonterminal; accept, revert and abandon are terminal", () => {
  assert.ok(!isTerminalDisposition("refresh-requested"));
  assert.ok(!isTerminalDisposition("repair-requested"));
  assert.ok(isTerminalDisposition(dispositionFor("base-drift-post-merge", "accept")));
  assert.ok(isTerminalDisposition(dispositionFor("base-drift-post-merge", "revert")));
  assert.ok(isTerminalDisposition(dispositionFor("head-drift", "abandon")));
});

test("a stop-answer record parses only with a known condition, choice and disposition", () => {
  const good = {
    kind: MERGE_INTEGRATOR_KIND.stopAnswer,
    schemaVersion: 1,
    stopId: "stop-1",
    condition: "head-drift",
    choice: "re-authorize",
    disposition: "refresh-requested",
  };
  assert.equal(parseStopAnswerMetadata(good)?.disposition, "refresh-requested");
  assert.equal(parseStopAnswerMetadata({ ...good, condition: "invented" }), null);
  assert.equal(parseStopAnswerMetadata({ ...good, kind: "other" }), null);
  assert.equal(parseStopAnswerMetadata({ ...good, disposition: "terminal-whatever" }), null);
  assert.equal(parseStopAnswerMetadata(null), null);
});

// --- the merge-result parser ---------------------------------------------

test("every stop condition round-trips as a stopped outcome", () => {
  for (const condition of STOP_CONDITIONS) {
    const body = serializeMergeResult({ outcome: "stopped", condition, evidence: "observed" });
    const parsed = parseMergeResult({ kind: "merge-result", body });
    assert.equal(parsed.outcome, "stopped");
    assert.ok(parsed.outcome === "stopped" && parsed.condition === condition);
  }
});

test("a merged outcome requires a well-formed merge commit sha", () => {
  const good = parseMergeResult({ kind: "merge-result", body: serializeMergeResult({ outcome: "merged", mergeCommitSha: OTHER }) });
  assert.equal(good.outcome, "merged");
  const bad = parseMergeResult({ kind: "merge-result", body: JSON.stringify({ outcome: "merged", mergeCommitSha: "nope" }) });
  assert.equal(bad.outcome, "malformed");
});

test("absent, wrong-kind, unparseable and unknown-outcome bodies all fail closed", () => {
  assert.equal(parseMergeResult(null).outcome, "malformed");
  assert.equal(parseMergeResult({ kind: "implementation", body: "{}" }).outcome, "malformed");
  assert.equal(parseMergeResult({ kind: "merge-result", body: "Run 1 completed successfully." }).outcome, "malformed");
  assert.equal(parseMergeResult({ kind: "merge-result", body: "[]" }).outcome, "malformed");
  assert.equal(parseMergeResult({ kind: "merge-result", body: JSON.stringify({ outcome: "probably-fine" }) }).outcome, "malformed");
  assert.equal(parseMergeResult({ kind: "merge-result", body: JSON.stringify({ outcome: "stopped", condition: "invented" }) }).outcome, "malformed");
  assert.equal(parseMergeResult({
    kind: "merge-result",
    body: JSON.stringify({ outcome: "stopped", condition: "base-drift-post-merge" }),
  }).outcome, "malformed");
  assert.equal(parseMergeResult({
    kind: "merge-result",
    body: JSON.stringify({ outcome: "stopped", condition: "base-drift-post-merge", evidence: 42 }),
  }).outcome, "malformed");
});

test("the SF-1 projection separates a pre-merge stop from a post-merge incident", () => {
  const stopped = projectMergeOutcome({ kind: "merge-result", body: serializeMergeResult({ outcome: "stopped", condition: "head-drift", evidence: "" }) });
  assert.deepEqual(stopped, { outcome: "stopped", condition: "head-drift", incident: false });
  const incident = projectMergeOutcome({ kind: "merge-result", body: serializeMergeResult({ outcome: "stopped", condition: "base-drift-post-merge", evidence: "" }) });
  assert.deepEqual(incident, { outcome: "stopped", condition: "base-drift-post-merge", incident: true });
  assert.equal(projectMergeOutcome(null), null);
  // An ordinary step's output is not a malformed merge result — it is not a
  // merge result at all, and the run-centric surfaces must read nothing from it.
  assert.equal(projectMergeOutcome({ kind: "code-review", body: "Looks good." }), null);
  assert.deepEqual(projectMergeOutcome({ kind: "merge-result", body: "not json" }), {
    outcome: "malformed", condition: "missing-or-malformed-result", incident: false,
  });
});

test("a merge outcome belongs to the run that recorded it, not to every run of the task", () => {
  const authored = { runId: "run-2" };
  assert.equal(runOwnsMergeOutcome(authored, "run-2", "run-3"), true);
  // Run 1 stopped, run 2 merged: painting run 1 with run 2's outcome would
  // report the wrong fate for both.
  assert.equal(runOwnsMergeOutcome(authored, "run-1", "run-3"), false);
  // The operator output route stamps no author; the newest run is then the only
  // run the row can mean.
  assert.equal(runOwnsMergeOutcome({ runId: null }, "run-3", "run-3"), true);
  assert.equal(runOwnsMergeOutcome({ runId: null }, "run-1", "run-3"), false);
  assert.equal(runOwnsMergeOutcome(null, "run-1", "run-1"), false);
  assert.ok(isIncidentCondition("changed-underneath-me"));
  assert.ok(!isIncidentCondition("head-drift"));
});
