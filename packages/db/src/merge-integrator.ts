/**
 * Merge Integrator v1.1 (issue #100), Step 1: the shared record convention.
 *
 * Everything here is pure. No I/O, no Prisma client, no network — so the API
 * server, the inbox process, and the separately-principaled merge executor can
 * all import the *same* predicate rather than three drifting copies of it.
 * That sharing is the point: §D-P2's selection validator, §D-P4's binding
 * invariant, §D-P7's disposition machine and the `merge-result` parser are each
 * load-bearing for a security property, and a second implementation of any of
 * them is a second thing to get wrong.
 */

import type { CanonicalTemplateRegistryName } from "./canonical-template-transition.js";
import { stepRole } from "./step-role.js";

export { stepGeneration, stepRole, type StepRole, type TemplateStepLike } from "./step-role.js";

/** Discriminator namespace. Disjoint from Goal 5a0's `goal5a0.*` (plan §13). */
export const MERGE_INTEGRATOR_KIND = {
  evidenceRequest: "mergeIntegrator.evidenceRequest",
  authorization: "mergeIntegrator.authorization",
  stopAnswer: "mergeIntegrator.stopAnswer",
  targetCorrection: "mergeIntegrator.targetCorrection",
  intent: "mergeIntegrator.intent",
  result: "mergeIntegrator.result",
} as const;

export const MERGE_INTEGRATOR_SCHEMA_VERSION = 1;

/** v1.1 pins exactly one merge method (SPEC D4). */
export const AUTHORIZED_MERGE_METHOD = "merge";

/**
 * These ordinals describe persisted graph topology. Step role recognition uses
 * stepRole(); canonicalStepOrdinals supplies topology from the canonical registry.
 */
export const INTEGRATOR_STEP_INDEX = 12;
export const DIRECT_INTEGRATOR_STEP_INDEX = 7;
export const LEGACY_INTEGRATOR_STEP_INDEX = 12;
export const LEGACY_DIRECT_INTEGRATOR_STEP_INDEX = 7;
export const INTEGRATOR_OUTPUT_KIND = "merge-result";
export const INTEGRATOR_AGENT_NAME = "merge-integrator";
export const INTEGRATOR_TEMPLATE_NAME = "compound-engineer-workflow" satisfies CanonicalTemplateRegistryName;
export const DIRECT_INTEGRATOR_TEMPLATE_NAME = "direct-engineer-workflow";
/** Sentinel model. `catalogRunnerForModel` returns null for it, so no runner/model assertion fires. */
export const INTEGRATOR_SENTINEL_MODEL = "mechanical/merge-executor-v1";

// ---------------------------------------------------------------------------
// §D-P4 — the bidirectional binding invariant
// ---------------------------------------------------------------------------

export type IntegratorStepShape = {
  stepIndex: number;
  outputKind?: string;
  taskTemplate?: { name: string } | null;
  taskTemplateName?: string | null;
} | null | undefined;

export const isCanonicalIntegratorStep = (step: IntegratorStepShape): boolean =>
  typeof step?.outputKind === "string" && stepRole({ outputKind: step.outputKind }) === "integrator";

export const isIntegratorStep = isCanonicalIntegratorStep;

/**
 * Bidirectional: the sentinel Agent may bind only the integrator step, and the
 * integrator step may bind only the sentinel Agent. One direction alone leaves
 * a hole — the sentinel dispatchable as an ordinary model agent, or the integrator step
 * executable by a real LLM.
 */
export const integratorBindingValid = (
  agentName: string | null | undefined,
  step: IntegratorStepShape,
): boolean => (agentName === INTEGRATOR_AGENT_NAME) === isIntegratorStep(step);

/** New template instantiation is stricter than runtime compatibility. */
export const canonicalIntegratorBindingValid = (
  agentName: string | null | undefined,
  step: IntegratorStepShape,
): boolean => (agentName === INTEGRATOR_AGENT_NAME) === isCanonicalIntegratorStep(step);

export const canonicalIntegratorBindingRefusal = (
  agentName: string | null | undefined,
  step: IntegratorStepShape,
): string | null => {
  if (canonicalIntegratorBindingValid(agentName, step)) return null;
  return agentName === INTEGRATOR_AGENT_NAME
    ? `Agent ${INTEGRATOR_AGENT_NAME} may bind only a canonical merge-execution step`
    : `A canonical merge-execution step may bind only agent ${INTEGRATOR_AGENT_NAME}`;
};

export const integratorBindingRefusal = (
  agentName: string | null | undefined,
  step: IntegratorStepShape,
): string | null => {
  if (integratorBindingValid(agentName, step)) return null;
  return agentName === INTEGRATOR_AGENT_NAME
    ? `Agent ${INTEGRATOR_AGENT_NAME} may bind only a merge-execution step`
    : `A merge-execution step may bind only agent ${INTEGRATOR_AGENT_NAME}`;
};

/**
 * `owner/name` for a GitHub remote, or null for any other host. Mirrors the
 * runner's `githubRepo` (delivery.ts) deliberately: the executor must resolve
 * the same repository the chain actually delivered to, and a second convention
 * here would be a way for the two to disagree.
 */
export const githubRepositoryFromRemote = (remote: string): string | null => {
  const ssh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu);
  if (ssh?.[1]) return ssh[1];
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return url.pathname.replace(/^\//u, "").replace(/\.git$/u, "") || null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// §D-P2 — the evidence block, carried in the gate card body
// ---------------------------------------------------------------------------

export const EVIDENCE_FENCE = "agentos-merge-evidence";
/**
 * The placeholder a Phase-A card is born with. Phase B's CAS keys on this exact
 * string, so it is a constant and never interpolated.
 */
export const EVIDENCE_PLACEHOLDER_BODY = "评审证据读取中…（reading merge evidence）";
export const EVIDENCE_UNAVAILABLE_MARKER = "evidence-unavailable";

export type RequiredCheck = { name: string; conclusion: string };

export type MergeEvidence = {
  schemaVersion: number;
  nonce: string;
  repository: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeMethod: string;
  requiredChecks: RequiredCheck[];
  readAt: string;
};

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/u;

const fenceBlock = (body: string): string | null => {
  const opening = `\`\`\`${EVIDENCE_FENCE}`;
  const start = body.indexOf(opening);
  if (start === -1) return null;
  const afterOpen = start + opening.length;
  const end = body.indexOf("```", afterOpen);
  if (end === -1) return null;
  return body.slice(afterOpen, end);
};

export const serializeEvidence = (evidence: MergeEvidence): string => [
  `\`\`\`${EVIDENCE_FENCE}`,
  JSON.stringify(evidence),
  "```",
].join("\n");

export type EvidenceParse =
  | { status: "ok"; evidence: MergeEvidence }
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "unparseable"; reason: string };

/**
 * The only reader of a card body in the codebase. Strict on purpose: a lenient
 * parser here would let a partially-rendered card be approved, and the card
 * body is the sole source of the authorized head, base and checks.
 */
export const parseEvidence = (body: string | null | undefined): EvidenceParse => {
  if (!body) return { status: "absent" };
  if (body.includes(EVIDENCE_UNAVAILABLE_MARKER)) return { status: "unavailable" };
  const raw = fenceBlock(body);
  if (raw === null) return { status: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { status: "unparseable", reason: "evidence block is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "unparseable", reason: "evidence block is not an object" };
  }
  const value = parsed as Record<string, unknown>;
  const fail = (reason: string): EvidenceParse => ({ status: "unparseable", reason });
  if (value.schemaVersion !== MERGE_INTEGRATOR_SCHEMA_VERSION) return fail("unsupported schemaVersion");
  if (typeof value.nonce !== "string" || value.nonce.length === 0) return fail("missing nonce");
  if (typeof value.repository !== "string" || !REPOSITORY_PATTERN.test(value.repository)) return fail("malformed repository");
  if (typeof value.prNumber !== "number" || !Number.isInteger(value.prNumber) || value.prNumber <= 0) return fail("malformed prNumber");
  if (typeof value.headSha !== "string" || !SHA_PATTERN.test(value.headSha)) return fail("malformed headSha");
  if (typeof value.baseRef !== "string" || value.baseRef.length === 0) return fail("missing baseRef");
  if (typeof value.baseSha !== "string" || !SHA_PATTERN.test(value.baseSha)) return fail("malformed baseSha");
  if (value.mergeMethod !== AUTHORIZED_MERGE_METHOD) return fail("merge method is not the pinned method");
  if (typeof value.readAt !== "string" || Number.isNaN(Date.parse(value.readAt))) return fail("malformed readAt");
  if (!Array.isArray(value.requiredChecks)) return fail("requiredChecks is not an array");
  const requiredChecks: RequiredCheck[] = [];
  for (const entry of value.requiredChecks) {
    if (typeof entry !== "object" || entry === null) return fail("malformed requiredChecks entry");
    const check = entry as Record<string, unknown>;
    if (typeof check.name !== "string" || typeof check.conclusion !== "string") return fail("malformed requiredChecks entry");
    requiredChecks.push({ name: check.name, conclusion: check.conclusion });
  }
  return {
    status: "ok",
    evidence: {
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      nonce: value.nonce,
      repository: value.repository,
      prNumber: value.prNumber,
      headSha: value.headSha,
      baseRef: value.baseRef,
      baseSha: value.baseSha,
      mergeMethod: value.mergeMethod,
      requiredChecks,
      readAt: value.readAt,
    },
  };
};

/** Field-by-field equality, including the nonce. §D-P2 rule 4. */
export const evidenceEquals = (left: MergeEvidence, right: MergeEvidence): boolean => {
  if (left.schemaVersion !== right.schemaVersion) return false;
  if (left.nonce !== right.nonce) return false;
  if (left.repository !== right.repository) return false;
  if (left.prNumber !== right.prNumber) return false;
  if (left.headSha !== right.headSha) return false;
  if (left.baseRef !== right.baseRef) return false;
  if (left.baseSha !== right.baseSha) return false;
  if (left.mergeMethod !== right.mergeMethod) return false;
  if (left.readAt !== right.readAt) return false;
  if (left.requiredChecks.length !== right.requiredChecks.length) return false;
  return left.requiredChecks.every((check, index) => {
    const other = right.requiredChecks[index]!;
    return check.name === other.name && check.conclusion === other.conclusion;
  });
};

// ---------------------------------------------------------------------------
// §8.1 / §D-P2 — the authorization payload
// ---------------------------------------------------------------------------

export type DecisionChannel = "inbox" | "patch" | "mechanical";

export type DecisionBinding = {
  channel: DecisionChannel;
  inboxDecisionId: string;
  inboxMessageId: string;
};

export type AuthorizationPayload = MergeEvidence & {
  issuedAt: string;
  decision: DecisionBinding;
};

export const authorizationMetadata = (payload: AuthorizationPayload): Record<string, unknown> => ({
  ...payload,
  kind: MERGE_INTEGRATOR_KIND.authorization,
  schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
});

export type AuthorizationParse =
  | { status: "ok"; payload: AuthorizationPayload }
  | { status: "not-authorization" }
  | { status: "malformed"; reason: string };

/**
 * Parses one activity's metadata. `not-authorization` and `malformed` are
 * deliberately different outcomes: the first is an unrelated row to ignore, the
 * second is a near-match that §4.9 must escalate as ambiguity rather than skip.
 */
export const parseAuthorizationMetadata = (metadata: unknown): AuthorizationParse => {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return { status: "not-authorization" };
  }
  const value = metadata as Record<string, unknown>;
  if (value.kind !== MERGE_INTEGRATOR_KIND.authorization) return { status: "not-authorization" };
  if (value.schemaVersion !== MERGE_INTEGRATOR_SCHEMA_VERSION) {
    return { status: "malformed", reason: "unsupported schemaVersion" };
  }
  const decision = value.decision;
  if (typeof decision !== "object" || decision === null) return { status: "malformed", reason: "missing decision binding" };
  const binding = decision as Record<string, unknown>;
  if (binding.channel !== "inbox" && binding.channel !== "patch" && binding.channel !== "mechanical") {
    return { status: "malformed", reason: "unknown decision channel" };
  }
  if (typeof binding.inboxDecisionId !== "string" || binding.inboxDecisionId.length === 0) {
    return { status: "malformed", reason: "missing inboxDecisionId" };
  }
  if (typeof binding.inboxMessageId !== "string" || binding.inboxMessageId.length === 0) {
    return { status: "malformed", reason: "missing inboxMessageId" };
  }
  if (typeof value.issuedAt !== "string" || Number.isNaN(Date.parse(value.issuedAt))) {
    return { status: "malformed", reason: "malformed issuedAt" };
  }
  // The evidence half is validated by the same parser that reads a card body,
  // so a payload and the block it was copied from cannot diverge in what counts
  // as well-formed.
  const evidence = parseEvidence(serializeEvidence({
    schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
    nonce: typeof value.nonce === "string" ? value.nonce : "",
    repository: typeof value.repository === "string" ? value.repository : "",
    prNumber: typeof value.prNumber === "number" ? value.prNumber : -1,
    headSha: typeof value.headSha === "string" ? value.headSha : "",
    baseRef: typeof value.baseRef === "string" ? value.baseRef : "",
    baseSha: typeof value.baseSha === "string" ? value.baseSha : "",
    mergeMethod: typeof value.mergeMethod === "string" ? value.mergeMethod : "",
    requiredChecks: Array.isArray(value.requiredChecks) ? value.requiredChecks as RequiredCheck[] : [],
    readAt: typeof value.readAt === "string" ? value.readAt : "",
  }));
  if (evidence.status !== "ok") {
    return { status: "malformed", reason: evidence.status === "unparseable" ? evidence.reason : "missing evidence fields" };
  }
  return {
    status: "ok",
    payload: {
      ...evidence.evidence,
      issuedAt: value.issuedAt,
      decision: {
        channel: binding.channel,
        inboxDecisionId: binding.inboxDecisionId,
        inboxMessageId: binding.inboxMessageId,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// §D-P2 rules 1-6 — the selection validator
// ---------------------------------------------------------------------------

/**
 * How long after its decision an authorization activity may be written. The two
 * are created in one transaction, so anything outside this window was written
 * by a later, separate call — which is exactly the forgery MF-2 describes.
 */
export const AUTHORIZATION_BINDING_WINDOW_MS = 5_000;

export type CandidateActivity = {
  id: string;
  createdAt: Date;
  actorType: string;
  metadata: unknown;
};

export type DecisionRow = {
  id: string;
  decision: string;
  createdAt: Date;
  inboxMessageId: string;
};

export type CardRow = {
  id: string;
  gateTaskId: string | null;
  status: string;
  selectedChoiceId: string | null;
  body: string;
};

export type SelectionRefusal = "missing" | "ambiguous-tie" | "malformed-near-match";

export type SelectionResult = {
  authorization: (AuthorizationPayload & { activityId: string; createdAt: Date }) | null;
  nearMatchCount: number;
  ignoredCount: number;
  refusal: SelectionRefusal | null;
};

export const APPROVE_CHOICE_ID = "approve";

/**
 * The one predicate both the read route and its tests use.
 *
 * The security claim it carries: a candidate is an authorization only if a
 * server-only row says so. `POST /tasks/:taskId/activity` can forge the
 * activity — it cannot forge an `InboxDecision`, cannot forge a gate card, and
 * cannot forge the card *body* the payload must equal byte for byte. Rules 2-4
 * are what turn "references a real decision id" into "the human approved these
 * exact facts".
 */
export const selectAuthorization = (
  candidates: CandidateActivity[],
  decisions: DecisionRow[],
  cards: CardRow[],
  chainStep9TaskId: string,
): SelectionResult => {
  const decisionById = new Map(decisions.map((row) => [row.id, row]));
  const cardById = new Map(cards.map((row) => [row.id, row]));
  let ignoredCount = 0;
  let nearMatchCount = 0;
  const valid: Array<AuthorizationPayload & { activityId: string; createdAt: Date }> = [];
  // Rule 5 needs the whole candidate set, so decision reuse is counted first
  // and consulted below rather than discovered mid-loop.
  const decisionUse = new Map<string, number>();
  for (const candidate of candidates) {
    const parsed = parseAuthorizationMetadata(candidate.metadata);
    if (parsed.status === "ok") {
      const key = parsed.payload.decision.inboxDecisionId;
      decisionUse.set(key, (decisionUse.get(key) ?? 0) + 1);
    }
  }

  for (const candidate of candidates) {
    const parsed = parseAuthorizationMetadata(candidate.metadata);
    if (parsed.status === "not-authorization") continue;

    // Rule 1: the discriminator matched, so from here on the row is *claiming*
    // to be an authorization and silence is not an option — it is either valid,
    // ignored for a structural reason, or a near-match worth escalating.
    if (parsed.status === "malformed") { nearMatchCount += 1; continue; }
    const payload = parsed.payload;
    if (payload.decision.channel === "mechanical") {
      const bindingPrefix = `mechanical:${chainStep9TaskId}:`;
      const binding = payload.decision.inboxDecisionId;
      const legacyBinding = `mechanical:${chainStep9TaskId}`;
      if (candidate.actorType !== "control-plane"
        || (binding !== legacyBinding && (!binding.startsWith(bindingPrefix) || binding.length === bindingPrefix.length))
        || payload.decision.inboxMessageId !== binding
        || (decisionUse.get(binding) ?? 0) > 1) {
        ignoredCount += 1;
        continue;
      }
      valid.push({ ...payload, activityId: candidate.id, createdAt: candidate.createdAt });
      continue;
    }
    if (candidate.actorType !== "operator") { ignoredCount += 1; continue; }
    const decision = decisionById.get(payload.decision.inboxDecisionId);
    // Rule 2: the decision must exist and belong to *this* chain's step-11 gate,
    // resolved from the caller's own chain and never from the payload.
    if (!decision) { ignoredCount += 1; continue; }
    const card = cardById.get(decision.inboxMessageId);
    if (!card || card.gateTaskId !== chainStep9TaskId) { ignoredCount += 1; continue; }
    if (card.id !== payload.decision.inboxMessageId) { ignoredCount += 1; continue; }
    // Rule 3: the decision won, rather than merely existing.
    if (decision.decision !== APPROVE_CHOICE_ID) { ignoredCount += 1; continue; }
    if (card.status !== "ANSWERED" || card.selectedChoiceId !== APPROVE_CHOICE_ID) { ignoredCount += 1; continue; }
    // Rule 5: no reuse of one decision across two authorizations.
    if ((decisionUse.get(payload.decision.inboxDecisionId) ?? 0) > 1) { ignoredCount += 1; continue; }
    // Rule 4: the payload equals the bytes the human saw.
    const block = parseEvidence(card.body);
    if (block.status !== "ok") { nearMatchCount += 1; continue; }
    if (!evidenceEquals(block.evidence, payload)) { nearMatchCount += 1; continue; }
    // Rule 6: written in the decision's own transaction.
    const delta = candidate.createdAt.getTime() - decision.createdAt.getTime();
    if (delta < 0 || delta > AUTHORIZATION_BINDING_WINDOW_MS) { nearMatchCount += 1; continue; }
    valid.push({ ...payload, activityId: candidate.id, createdAt: candidate.createdAt });
  }

  if (valid.length === 0) {
    return { authorization: null, nearMatchCount, ignoredCount, refusal: nearMatchCount > 0 ? "malformed-near-match" : "missing" };
  }
  // Latest-wins supersession (SPEC 4.6). A tie at identical createdAt is not
  // resolvable by the rule the SPEC states, so it is ambiguity, not a coin flip.
  const sorted = [...valid].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const newest = sorted[0]!;
  if (sorted.length > 1 && sorted[1]!.createdAt.getTime() === newest.createdAt.getTime()) {
    return { authorization: null, nearMatchCount, ignoredCount, refusal: "ambiguous-tie" };
  }
  return { authorization: newest, nearMatchCount, ignoredCount, refusal: null };
};

// ---------------------------------------------------------------------------
// §4 — stop conditions, and §D-P7's disposition state machine
// ---------------------------------------------------------------------------

export const STOP_CONDITIONS = [
  "head-drift",
  "base-drift",
  "check-failure-or-absence",
  "non-clean-mergeability",
  "missing-authorization",
  "superseded-authorization",
  "retroactive-authorization",
  "api-error",
  "ambiguity",
  "base-drift-post-merge",
  "unresolved-mergeability",
  "payload-mismatch",
  "changed-underneath-me",
  "target-unresolvable",
  "deferred-merge-machinery",
  "missing-or-malformed-result",
] as const;

export type StopCondition = (typeof STOP_CONDITIONS)[number];

const STOP_CONDITION_SET = new Set<string>(STOP_CONDITIONS);
export const isStopCondition = (value: unknown): value is StopCondition =>
  typeof value === "string" && STOP_CONDITION_SET.has(value);

/** The two conditions that mean a merge already landed. They read as incidents, not stops. */
export const INCIDENT_CONDITIONS: StopCondition[] = ["base-drift-post-merge", "changed-underneath-me"];
export const isIncidentCondition = (condition: StopCondition): boolean => INCIDENT_CONDITIONS.includes(condition);

export type Disposition =
  | "terminal-done"
  | "terminal-abandoned"
  | "refresh-requested"
  | "repair-requested"
  | "revalidation-requested"
  | "nonterminal";

export const TERMINAL_DISPOSITIONS: Disposition[] = ["terminal-done", "terminal-abandoned"];
export const isTerminalDisposition = (value: unknown): value is Disposition =>
  typeof value === "string" && TERMINAL_DISPOSITIONS.includes(value as Disposition);

export type StopChoice =
  | "re-authorize"
  | "abandon"
  | "accept"
  | "revert"
  | "accept-foreign-merge"
  | "flag-incident"
  | "open-repair"
  | "re-validate";

const RESUMABLE: StopChoice[] = ["re-authorize", "abandon"];

/**
 * The §12 matrix, as data. Note 4.14 offers `open-repair` and NOT
 * `re-authorize` (MF-8): re-authorizing cannot change the immutable run rows
 * the target is derived from, so offering it would be a dead end dressed as a
 * resume path.
 */
export const STOP_CHOICES: Record<StopCondition, StopChoice[]> = {
  "head-drift": RESUMABLE,
  // Ordinary pre-merge base drift is recovered by the control plane. When the
  // evidence is ineligible or the automatic budget is exhausted, abandoning
  // remains possible but re-authorization must not bypass the fresh tail.
  "base-drift": ["abandon"],
  "check-failure-or-absence": RESUMABLE,
  "non-clean-mergeability": RESUMABLE,
  "missing-authorization": RESUMABLE,
  "superseded-authorization": RESUMABLE,
  "retroactive-authorization": RESUMABLE,
  "api-error": RESUMABLE,
  ambiguity: RESUMABLE,
  "base-drift-post-merge": ["accept", "revert"],
  "unresolved-mergeability": RESUMABLE,
  "payload-mismatch": RESUMABLE,
  "changed-underneath-me": ["accept-foreign-merge", "flag-incident"],
  "target-unresolvable": ["open-repair", "abandon"],
  "deferred-merge-machinery": RESUMABLE,
  "missing-or-malformed-result": RESUMABLE,
};

/** The choices the `flag-incident` follow-up question offers — the later exits C3 promised. */
export const FOLLOW_UP_CHOICES: StopChoice[] = ["accept-foreign-merge", "abandon"];

/**
 * The wider offering a base-drift recovery opens when one retry class crossed
 * its own ceiling rather than the candidate being ineligible. Only a ceiling
 * has counters to reset, so `re-validate` is offered there and nowhere else;
 * an ordinary refusal keeps the abandon-only card above.
 */
export const BASE_DRIFT_CLASS_CEILING_CHOICES: StopChoice[] = ["re-validate", "abandon"];

/**
 * Every choice a condition can be answered with, which for base drift is wider
 * than the default offering: the recovery decides per settle which card to
 * open, and the answer transaction must accept whichever it opened.
 */
const ANSWERABLE_CHOICES: Partial<Record<StopCondition, StopChoice[]>> = {
  "base-drift": [...BASE_DRIFT_CLASS_CEILING_CHOICES, ...STOP_CHOICES["base-drift"]],
};

const DISPOSITION_OF: Record<StopChoice, Disposition> = {
  accept: "terminal-done",
  revert: "terminal-done",
  "accept-foreign-merge": "terminal-done",
  abandon: "terminal-abandoned",
  "re-authorize": "refresh-requested",
  "open-repair": "repair-requested",
  "re-validate": "revalidation-requested",
  "flag-incident": "nonterminal",
};

export const isStopChoice = (value: unknown): value is StopChoice =>
  typeof value === "string" && Object.hasOwn(DISPOSITION_OF, value);

/**
 * Resolves a choice against the condition that offered it. A choice valid for
 * one condition is not valid for another — `accept` closing a `head-drift` stop
 * would mark an unmerged PR done.
 */
export const dispositionFor = (condition: StopCondition, choice: string): Disposition | null => {
  if (!isStopChoice(choice)) return null;
  if (!(ANSWERABLE_CHOICES[condition] ?? STOP_CHOICES[condition]).includes(choice)) return null;
  return DISPOSITION_OF[choice];
};

export const followUpDispositionFor = (choice: string): Disposition | null => {
  if (!isStopChoice(choice)) return null;
  if (!FOLLOW_UP_CHOICES.includes(choice)) return null;
  return DISPOSITION_OF[choice];
};

export const CHOICE_LABELS: Record<StopChoice, string> = {
  "re-authorize": "重新授权（读取最新证据后再确认）",
  abandon: "放弃本链（不合并）",
  accept: "接受这次合并结果",
  revert: "记录需要回滚（回滚本身另行授权）",
  "accept-foreign-merge": "接受他人已完成的合并",
  "flag-incident": "标记为事故，暂不结案",
  "open-repair": "开始修复合并目标",
  "re-validate": "重新校验（重置该类计数，继续自动恢复）",
};

export const stopChoicePayload = (choices: StopChoice[]): Array<{ id: string; label: string }> =>
  choices.map((choice) => ({ id: choice, label: CHOICE_LABELS[choice] }));

export type StopAnswerRecord = {
  stopId: string;
  condition: StopCondition;
  choice: StopChoice;
  disposition: Disposition;
};

export const parseStopAnswerMetadata = (metadata: unknown): StopAnswerRecord | null => {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const value = metadata as Record<string, unknown>;
  if (value.kind !== MERGE_INTEGRATOR_KIND.stopAnswer) return null;
  if (value.schemaVersion !== MERGE_INTEGRATOR_SCHEMA_VERSION) return null;
  if (typeof value.stopId !== "string" || value.stopId.length === 0) return null;
  if (!isStopCondition(value.condition)) return null;
  if (!isStopChoice(value.choice)) return null;
  const disposition = value.disposition;
  const known: Disposition[] = [
    "terminal-done", "terminal-abandoned", "refresh-requested", "repair-requested",
    "revalidation-requested", "nonterminal",
  ];
  if (typeof disposition !== "string" || !known.includes(disposition as Disposition)) return null;
  return { stopId: value.stopId, condition: value.condition, choice: value.choice, disposition: disposition as Disposition };
};

// ---------------------------------------------------------------------------
// §3 Output — the `merge-result` outcome, parsed by the control plane and the UI
// ---------------------------------------------------------------------------

export type MergeOutcome =
  | { outcome: "merged"; mergeCommitSha: string }
  | { outcome: "stopped"; condition: StopCondition; evidence: string }
  | { outcome: "malformed"; condition: "missing-or-malformed-result"; reason: string };

/**
 * Fail-closed by construction (X3): every input that is not unambiguously a
 * `merged` or `stopped` record becomes `malformed`, which the control plane
 * lands in the stop state. There is no path here that returns success by
 * default.
 */
export const parseMergeResult = (
  output: { kind: string; body: string } | null | undefined,
): MergeOutcome => {
  const malformed = (reason: string): MergeOutcome =>
    ({ outcome: "malformed", condition: "missing-or-malformed-result", reason });
  if (!output) return malformed("no output persisted");
  if (output.kind !== INTEGRATOR_OUTPUT_KIND) return malformed(`output kind is ${output.kind}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.body);
  } catch {
    return malformed("output body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return malformed("output body is not an object");
  const value = parsed as Record<string, unknown>;
  if (value.outcome === "merged") {
    if (typeof value.mergeCommitSha !== "string" || !SHA_PATTERN.test(value.mergeCommitSha)) {
      return malformed("merged outcome without a well-formed mergeCommitSha");
    }
    return { outcome: "merged", mergeCommitSha: value.mergeCommitSha };
  }
  if (value.outcome === "stopped") {
    if (!isStopCondition(value.condition)) return malformed("stopped outcome without a known condition");
    if (typeof value.evidence !== "string") return malformed("stopped outcome without string evidence");
    return {
      outcome: "stopped",
      condition: value.condition,
      evidence: value.evidence,
    };
  }
  return malformed("outcome is neither merged nor stopped");
};

export const serializeMergeResult = (outcome: MergeOutcome): string => JSON.stringify(outcome);

/** The projection §SF-1 renders. Null for every non-integrator run. */
export type MergeOutcomeProjection = {
  outcome: "merged" | "stopped" | "malformed";
  condition: StopCondition | null;
  incident: boolean;
};

/**
 * SF-1: which run a persisted merge outcome belongs to.
 *
 * `TaskStepOutput` is unique per task, so a task with three runs has one row —
 * and painting all three runs with it would report an earlier run's stop on a
 * later run that merged cleanly. The session output route stamps `runId`, so
 * the row names its own author; the operator route does not, and a row with no
 * author can only mean the task's newest run.
 */
export const runOwnsMergeOutcome = (
  output: { runId?: string | null } | null | undefined,
  runId: string,
  latestRunId: string | null,
): boolean => (output ? (output.runId ?? latestRunId) === runId : false);

/**
 * SF-1's DTO projection: null for every non-integrator run.
 *
 * The kind check is the whole of "non-integrator". `parseMergeResult` reports
 * an ordinary step's output as `malformed` — correctly, since it is not a merge
 * result — and a DTO that carried that would put a malformed marker on all 112
 * board cards. Only a row that claims to be a merge result is projected.
 */
export const projectMergeOutcome = (
  output: { kind: string; body: string } | null | undefined,
): MergeOutcomeProjection | null => {
  if (!output || output.kind !== INTEGRATOR_OUTPUT_KIND) return null;
  const parsed = parseMergeResult(output);
  if (parsed.outcome === "merged") return { outcome: "merged", condition: null, incident: false };
  if (parsed.outcome === "stopped") {
    return { outcome: "stopped", condition: parsed.condition, incident: isIncidentCondition(parsed.condition) };
  }
  return { outcome: "malformed", condition: parsed.condition, incident: false };
};
