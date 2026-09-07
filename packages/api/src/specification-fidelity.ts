import { createHash } from "node:crypto";

import {
  canonicalTemplateIdentity,
  githubRepositoryFromRemote,
  isDirectImplementationStep,
  Prisma,
  PR_TEMPLATE_NAME,
  stepRole,
} from "@anneal/db";
import type { ClaimSpecificationMaterialization } from "@anneal/db/claim-contract";

import { abortableDelay, abortReason } from "./abortable-delay.js";
import { isCanonicalBlindFindingsStep, isCanonicalSolFindingsStep } from "./canonical-task-output.js";
import { isValidBranchName } from "./branch-name.js";
import { GitHubReadError } from "./github-read.js";
import { BRIEF_EDIT_ACTIVITY_NOTE, legacyBriefMigration, readBrief } from "./task-brief.js";

/** Stable, operator-visible reasons for the distinct fail-closed outcomes. */
export const SPEC_TRANSCRIPTION_REFUSAL_REASON = "spec-transcription-mismatch";
export const SPEC_TRANSCRIPTION_UNREADABLE_REASON = "spec-transcription-unreadable";
export const SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON = "spec-transcription-authority-missing";
/** The specification was reachable; only the read deadline was exceeded, repeatedly. */
export const SPEC_READ_DEADLINE_EXCEEDED_REASON = "spec-read-deadline-exceeded";

export type SpecificationRefusalReason =
  | typeof SPEC_TRANSCRIPTION_REFUSAL_REASON
  | typeof SPEC_TRANSCRIPTION_UNREADABLE_REASON
  | typeof SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON
  | typeof SPEC_READ_DEADLINE_EXCEEDED_REASON;

export type SpecificationRefusalClassification = "transient" | "non-transient";

/** Which transient failure a refusal saw: a deadline hit, or anything else. */
export type SpecificationReadTransientCause = "timeout" | "other";

export type SpecificationRefusal = {
  reason: SpecificationRefusalReason;
  classification: SpecificationRefusalClassification;
  detail: string;
  message: string;
  /** Present on transient refusals only; drives the claim-side deferral ceiling. */
  transientCause?: SpecificationReadTransientCause;
};

/** The path the implementation step promises to materialize. */
export const specificationPathForBranch = (branch: string): string => `.chain/${branch}/spec.md`;

/** Declared with the claim payload it travels in, not beside its producer. */
export type SpecificationMaterialization = ClaimSpecificationMaterialization;

/**
 * Both direct and PR workflows materialize the task brief before their
 * implementation branch is handed to a runner. Keep this predicate local to
 * specification fidelity: `isDirectImplementationStep` also drives the
 * direct-only native-child and revalidation contracts.
 */
const isSpecificationMaterializationImplementationStep = (
  templateStep: Parameters<typeof isDirectImplementationStep>[0],
): boolean => {
  if (!templateStep) return false;
  if (isDirectImplementationStep(templateStep)) return true;
  const templateName = templateStep.taskTemplate?.name;
  return templateName !== undefined
    && canonicalTemplateIdentity(templateName)?.canonicalName === PR_TEMPLATE_NAME
    && templateStep.outputKind !== undefined
    && stepRole({ outputKind: templateStep.outputKind }) === "implementation";
};

/** Prepare the direct-chain brief for runner-owned workspace bootstrap. */
export const specificationMaterializationForDirectImplementation = (
  task: {
    description: string;
    templateId?: string | null;
    chainId?: string | null;
    templateStep?: {
      stepIndex?: number;
      outputKind?: string;
      priorOutputKinds: readonly string[];
      taskTemplate?: { name: string } | null;
    } | null;
  },
  branch: string | null,
): SpecificationMaterialization | null => {
  if (!task.templateId || !task.chainId
    || !isSpecificationMaterializationImplementationStep(task.templateStep ?? null)
    || !branch || !isValidBranchName(branch)) return null;
  const parsed = readBrief(task.description, legacyBriefMigration(task.templateStep));
  return "unparseable" in parsed ? null : {
    kind: "direct-implementation",
    path: specificationPathForBranch(branch),
    body: parsed.brief,
  };
};

/** Narrow repository capability needed by review-claim verification. */
export type SpecificationReader = {
  readFileAtCommit: (
    repository: string,
    path: string,
    commitSha: string,
    signal: AbortSignal,
    /** The exact original Repo.remoteUrl used to key the runner mirror. */
    remoteUrl: string,
  ) => Promise<Uint8Array>;
};

type ReviewTask = {
  id: string;
  projectId: string;
  templateId: string | null;
  chainId: string | null;
  chainIndex: number | null;
  description: string;
  templateStep?: {
    stepIndex: number;
    outputKind: string;
    baseFromStepIndex: number | null;
    taskTemplate?: { name: string };
  } | null;
};

type ReviewRepo = { remoteUrl: string };

export type SpecificationReviewCandidate = {
  task: ReviewTask;
  repo: ReviewRepo;
  branch: string | null;
};

/** Normalize CR variants and ignore one optional trailing LF without decoding arbitrary bytes. */
export const normalizeLineEndings = (bytes: Uint8Array): Uint8Array => {
  const normalized: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0x0d) {
      if (bytes[index + 1] === 0x0a) index += 1;
      normalized.push(0x0a);
    } else {
      normalized.push(byte);
    }
  }
  if (normalized.at(-1) === 0x0a) normalized.pop();
  return Uint8Array.from(normalized);
};

/**
 * The one hash both sides of the fidelity check speak.
 *
 * The claim transaction records it over the bytes it hands the runner, and the
 * review claim recomputes it over the file read back from the branch. Both go
 * through `normalizeLineEndings` first, because the runner writes the body
 * verbatim while git may return it with CR variants or one extra final LF.
 */
export const specificationDigest = (specification: string | Uint8Array): string => createHash("sha256")
  .update(normalizeLineEndings(
    typeof specification === "string" ? new TextEncoder().encode(specification) : specification,
  ))
  .digest("hex");

const refusal = (
  reason: SpecificationRefusalReason,
  detail: string,
  classification: SpecificationRefusalClassification = "non-transient",
  transientCause?: SpecificationReadTransientCause,
): SpecificationRefusal => ({
  reason,
  classification,
  detail,
  message: `Spec transcription claim refused: ${reason}: ${detail}`,
  ...(transientCause ? { transientCause } : {}),
});

export const specificationUnreadableRefusal = (
  detail: string,
  classification: SpecificationRefusalClassification = "non-transient",
  transientCause?: SpecificationReadTransientCause,
): SpecificationRefusal => (
  refusal(SPEC_TRANSCRIPTION_UNREADABLE_REASON, detail, classification, transientCause)
);

/**
 * The all-timeout exhaustion message. The specification was readable; the
 * deadline was not met, so the refusal names the deadline, how many deferred
 * attempts hit it, and the window they spanned instead of calling the
 * specification unreadable.
 */
export const specificationReadDeadlineExceededRefusal = (
  evidence: { attempts: number; elapsedMs: number; ceilingMs: number; lastUnderlyingError: string },
): SpecificationRefusal => refusal(
  SPEC_READ_DEADLINE_EXCEEDED_REASON,
  `specification read exceeded its per-attempt deadline under host load on all ${evidence.attempts} deferred attempts`
  + ` over ${evidence.elapsedMs}ms (deferral ceiling ${evidence.ceilingMs}ms); last underlying error: ${evidence.lastUnderlyingError}`,
  "transient",
  "timeout",
);

/**
 * An episode that saw any non-timeout transient parks on the ordinary budget.
 * The window it actually ran can exceed that budget - an all-timeout episode
 * extended past it and then saw one other transient - so the message names the
 * observed elapsed window alongside the budget it was measured against.
 */
export const specificationReadBudgetExhaustedRefusal = (
  evidence: { budgetMs: number; elapsedMs: number; lastUnderlyingError: string },
): SpecificationRefusal => specificationUnreadableRefusal(
  `transient read deferral budget exhausted after ${evidence.elapsedMs}ms`
  + ` (budget ${evidence.budgetMs}ms); last underlying error: ${evidence.lastUnderlyingError}`,
  "transient",
  "other",
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

type AuthoritySource = {
  id: string;
  description: string;
  templateStep: { outputKind: string; priorOutputKinds: string[] } | null;
  stepOutput: { kind: string; body: string; run: { specificationDigest: string | null } | null } | null;
};

/**
 * What the materialized Specification of record must hash to, and where the
 * brief that is authoritative *now* stands against it.
 */
type SpecificationAuthority = {
  /** Hex SHA-256 of the normalized authoritative specification. */
  digest: string;
  /**
   * `not-compared` is every path that never weighed a brief against the digest:
   * a compound chain, whose authority is its approved specification output, and
   * the pre-digest fallback, where the current brief *is* the digest. `amended`
   * names the implementation Step whose brief has changed since the digest was
   * recorded, which is what lets the claim date the amendment and lets a
   * refusal tell a stale amendment apart from tampering.
   */
  currentBrief:
    | { kind: "not-compared" }
    | { kind: "unamended" }
    | { kind: "amended"; taskId: string };
};

const compoundAuthority = (source: AuthoritySource): AuthorityResult => {
  if (!source.stepOutput) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "approved specification output is missing",
    ) };
  }
  if (source.stepOutput.kind !== "spec") {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "approved specification output has an unexpected kind",
    ) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.stepOutput.body);
  } catch {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "approved specification output is not valid JSON",
    ) };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.spec !== "string") {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "approved specification output has no canonical spec field",
    ) };
  }
  return { authority: {
    digest: specificationDigest(parsed.spec),
    // A compound chain's authority is its approved specification output, which
    // no brief edit can move and which no brief is compared against, so a
    // refusal here says nothing about any task's brief.
    currentBrief: { kind: "not-compared" },
  } };
};

/**
 * The direct and PR chains' authority: the brief the implementer was handed.
 *
 * The pinned implementation Run recorded that brief's digest when it was
 * claimed, so amending the brief afterwards no longer makes a faithful
 * `spec.md` look tampered with — the amendment is reported to the reviewer
 * instead of refusing the claim.
 */
const directAuthority = (source: AuthoritySource): AuthorityResult => {
  if (!source.templateStep) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "direct-chain implementation step metadata is missing",
    ) };
  }
  const parsed = readBrief(source.description, legacyBriefMigration(source.templateStep));
  // A brief that has become unreadable is a brief that no longer says what the
  // Run was handed, so it counts as an amendment rather than as authority.
  const currentDigest = "unparseable" in parsed ? null : specificationDigest(parsed.brief);
  const materializedDigest = source.stepOutput?.run?.specificationDigest ?? null;
  if (materializedDigest !== null) {
    return { authority: {
      digest: materializedDigest,
      currentBrief: currentDigest === materializedDigest
        ? { kind: "unamended" }
        : { kind: "amended", taskId: source.id },
    } };
  }
  // No digest to compare against: the implementation Run was claimed before
  // `Run.specificationDigest` existed, or the pinned output carries no Run at
  // all because an operator wrote it through `PUT /tasks/:taskId/output`, which
  // is how a parked chain is recovered by hand. Both keep comparing against the
  // current brief — the behavior this change exists to end, because a tampered
  // `spec.md` that happens to match an amended brief passes here. Delete this
  // branch, and the null case of `Run.specificationDigest`, once no review step
  // pins a digest-less implementation output.
  if (currentDigest === null) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "direct-chain task brief is unavailable",
    ) };
  }
  return { authority: { digest: currentDigest, currentBrief: { kind: "not-compared" } } };
};

type AuthorityResult = { authority: SpecificationAuthority } | { error: SpecificationRefusal };

const authorityFor = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
): Promise<AuthorityResult> => {
  if (!candidate.task.templateId || !candidate.task.chainId) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "chain identity is unavailable",
    ) };
  }
  const sources = await tx.task.findMany({
    where: {
      projectId: candidate.task.projectId,
      templateId: candidate.task.templateId,
      chainId: candidate.task.chainId,
    },
    select: {
      id: true,
      description: true,
      templateStep: { select: { outputKind: true, priorOutputKinds: true } },
      // The Run behind the pinned output is the Run that materialized the
      // Specification of record, so its digest is the authority for this head.
      stepOutput: { select: { kind: true, body: true, run: { select: { specificationDigest: true } } } },
    },
  });
  const sourcesForRole = (role: "spec" | "implementation") => sources.filter((source) => (
    source.templateStep !== null && stepRole(source.templateStep) === role
  ));
  const specificationSources = sourcesForRole("spec");
  if (specificationSources.length > 1) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "compound chain has multiple specification steps",
    ) };
  }
  if (specificationSources[0]) return compoundAuthority(specificationSources[0]);

  const implementationSources = sourcesForRole("implementation");
  if (implementationSources.length !== 1) {
    return { error: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      implementationSources.length === 0
        ? "direct-chain implementation task is missing"
        : "direct chain has multiple implementation steps",
    ) };
  }
  return directAuthority(implementationSources[0]!);
};

/**
 * Where the brief that is authoritative now stands against the digest the
 * materialized file is checked against.
 *
 * `not-compared` is a claim that weighed no brief against the digest — a
 * compound chain, or the pre-digest fallback where the current brief *is* the
 * digest — so it has nothing to report either way. `amended` carries the
 * finished prompt line, because only the claim transaction can read the
 * amendment's time off `TaskActivity`.
 */
export type CurrentBriefStanding =
  | { kind: "not-compared" }
  | { kind: "unamended" }
  | { kind: "amended"; note: string };

export type SpecificationVerification = {
  key: string;
  repository: string;
  /** Exact remote URL used by the runner mirror's hash key. */
  remoteUrl: string;
  path: string;
  implementationHeadSha: string;
  /** What the materialized file must hash to. See `specificationDigest`. */
  authoritativeDigest: string;
  currentBrief: CurrentBriefStanding;
};

/**
 * One prompt line: which Step's brief changed after the Specification of record
 * was materialized, and when.
 *
 * `PATCH /tasks/:id` records a brief edit as an operator `TaskActivity`, and
 * that row is the only record of when the amendment landed. A chain amended
 * before those rows carried this note says so rather than inventing a time.
 *
 * The line states where the amended text lives and stops there. Each Step keeps
 * its own copy of the brief and `PATCH /tasks/:id` amends one Step at a time,
 * so the reviewer's prompt need not carry the amended text and this claim has
 * no way to put it there; telling the reviewer to judge against a brief it
 * cannot read would be an instruction it cannot follow.
 */
const briefAmendmentNote = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  path: string,
): Promise<string> => {
  const edit = await tx.taskActivity.findFirst({
    where: { taskId, actorType: "operator", body: { contains: BRIEF_EDIT_ACTIVITY_NOTE } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true },
  });
  const when = edit ? `at ${edit.createdAt.toISOString()}` : "at an unrecorded time";
  return `Task ${taskId} had its brief amended ${when}, after ${path} was materialized: that file is the pre-amendment Specification of record, and the amended text is the brief on that task.`;
};

export type SpecificationVerificationPreparation =
  | { status: "not-required" }
  | { status: "refused"; refusal: SpecificationRefusal }
  | { status: "ready"; verification: SpecificationVerification };

/** Snapshot database-backed authority while the claim transaction is open. */
export const prepareSpecificationVerification = async (
  tx: Prisma.TransactionClient,
  candidate: SpecificationReviewCandidate,
  implementationHeadSha: string | null,
): Promise<SpecificationVerificationPreparation> => {
  const step = candidate.task.templateStep;
  if (!step || (!isCanonicalSolFindingsStep(step) && !isCanonicalBlindFindingsStep(step))) {
    return { status: "not-required" };
  }
  if (!implementationHeadSha) {
    return { status: "refused", refusal: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "pinned implementation head is unavailable",
    ) };
  }
  if (!candidate.branch || !isValidBranchName(candidate.branch)) {
    return { status: "refused", refusal: refusal(
      SPEC_TRANSCRIPTION_AUTHORITY_MISSING_REASON,
      "materialized specification branch is unavailable",
    ) };
  }

  const authority = await authorityFor(tx, candidate);
  if ("error" in authority) return { status: "refused", refusal: authority.error };

  const repository = githubRepositoryFromRemote(candidate.repo.remoteUrl);
  if (!repository) {
    return { status: "refused", refusal: specificationUnreadableRefusal(
      `repository remote is not a supported GitHub repository: ${candidate.repo.remoteUrl}`,
    ) };
  }
  const path = specificationPathForBranch(candidate.branch);
  const standing = authority.authority.currentBrief;
  const currentBrief: CurrentBriefStanding = standing.kind === "amended"
    ? { kind: "amended", note: await briefAmendmentNote(tx, standing.taskId, path) }
    : standing;
  return {
    status: "ready",
    verification: {
      key: [
        candidate.task.id,
        repository,
        candidate.repo.remoteUrl,
        implementationHeadSha,
        candidate.branch,
        authority.authority.digest,
      ].join("\0"),
      repository,
      remoteUrl: candidate.repo.remoteUrl,
      path,
      implementationHeadSha,
      authoritativeDigest: authority.authority.digest,
      currentBrief,
    },
  };
};

const isAbortError = (error: unknown): boolean => (
  error instanceof Error && error.name === "AbortError"
);

export type SpecificationReadFailureKind = SpecificationRefusalClassification;

const TRANSIENT_SYSTEM_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

/** Only transport and deadline failures are retried; repository/content responses fail closed immediately. */
export const classifySpecificationReadFailure = (error: unknown): SpecificationReadFailureKind => {
  if (error instanceof GitHubReadError) {
    return error.kind === "timeout" || error.kind === "transport" ? "transient" : "non-transient";
  }
  if (isAbortError(error)) return "transient";
  const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code && TRANSIENT_SYSTEM_ERROR_CODES.has(code) ? "transient" : "non-transient";
};

/**
 * A deadline hit is retried on a longer clock; every other transient is not.
 * Only an observed deadline expiry counts: this function's own per-attempt
 * timer converts one into `GitHubReadError(..., "timeout")` before classifying,
 * so a raw `AbortError` reaching here was aborted by something else and is an
 * ordinary transient, not evidence that the host is merely slow.
 */
export const specificationReadTransientCause = (error: unknown): SpecificationReadTransientCause => (
  error instanceof GitHubReadError && error.kind === "timeout" ? "timeout" : "other"
);

type SpecificationReadRetryOptions = {
  retryDelaysMs?: readonly number[];
  attemptTimeoutsMs?: readonly number[];
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

/**
 * The runner aborts its claim request at `RUNNER_API_TIMEOUT_MS`, whose shipped
 * default is 10000ms (`packages/runner/src/config.ts`). The whole read - every
 * attempt deadline plus every backoff between them - runs inside that request,
 * so a ladder that reaches the ceiling would abort the claim before the control
 * plane could defer, park, or notice anything. Half of the shipped default
 * leaves room for the route work that precedes the read.
 */
export const SPECIFICATION_READ_REQUEST_BUDGET_MS = 10_000 / 2;

/**
 * An escalating per-attempt deadline ladder, not three identical deadlines. A
 * host under load makes every read slower by the same factor, so repeating one
 * 1200ms deadline fails all three attempts deterministically rather than
 * probabilistically. The first attempt keeps the fast deadline for the healthy
 * case; the later two give a merely slow read room to finish inside the same
 * claim. How much room is capped by `SPECIFICATION_READ_REQUEST_BUDGET_MS`, so
 * the escalation that matters for a sustained overload is the claim-side
 * deferral ceiling, not this ladder.
 */
export const SPECIFICATION_READ_ATTEMPT_TIMEOUTS_MS = [1_200, 1_500, 1_800] as const;
export const SPECIFICATION_READ_RETRY_DELAYS_MS = [100, 300] as const;

const failureDetail = (error: unknown): string => (
  error instanceof Error ? error.message : "repository content read failed"
);

/**
 * The half of a mismatch an operator cannot see from the branch: whether the
 * brief that is authoritative now still says what the implementation Run was
 * handed. Without it a tampered `spec.md` and a brief amended after
 * materialization read exactly the same in the refusal.
 */
const BRIEF_STANDING_DETAIL: Record<CurrentBriefStanding["kind"], string> = {
  // No brief was weighed against this digest, so the refusal claims nothing
  // about one and keeps the message it had before digests existed.
  "not-compared": "",
  unamended: "; the current task brief still matches that specification",
  amended: "; the current task brief also differs from that specification",
};

/** Perform repository I/O only; callers must invoke this outside a transaction. */
export const verifyPreparedSpecification = async (
  verification: SpecificationVerification,
  reader: SpecificationReader | null,
  signal: AbortSignal,
  options: SpecificationReadRetryOptions = {},
): Promise<SpecificationRefusal | null> => {
  if (!reader) return specificationUnreadableRefusal(
    "server-side repository content reader is unavailable",
  );
  const retryDelaysMs = options.retryDelaysMs ?? SPECIFICATION_READ_RETRY_DELAYS_MS;
  const attemptTimeoutsMs = options.attemptTimeoutsMs ?? SPECIFICATION_READ_ATTEMPT_TIMEOUTS_MS;
  const wait = options.wait ?? abortableDelay;
  let materialized: Uint8Array | undefined;
  let sawNonTimeoutFailure = false;
  for (let attempt = 0; materialized === undefined; attempt += 1) {
    signal.throwIfAborted();
    const attemptDeadline = new AbortController();
    const abortFromRequest = (): void => attemptDeadline.abort(abortReason(signal));
    signal.addEventListener("abort", abortFromRequest, { once: true });
    const timeoutMs = attemptTimeoutsMs[Math.min(attempt, attemptTimeoutsMs.length - 1)] ?? 4_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptDeadline.abort();
    }, timeoutMs);
    let failure: unknown;
    try {
      materialized = await reader.readFileAtCommit(
        verification.repository,
        verification.path,
        verification.implementationHeadSha,
        attemptDeadline.signal,
        verification.remoteUrl,
      );
      continue;
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      failure = timedOut
        ? new GitHubReadError(`repository content read exceeded the ${timeoutMs}ms server deadline`, "timeout")
        : error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortFromRequest);
    }

    const detail = failureDetail(failure);
    const failureKind = classifySpecificationReadFailure(failure);
    if (specificationReadTransientCause(failure) !== "timeout") sawNonTimeoutFailure = true;
    const delayMs = retryDelaysMs[attempt];
    if (failureKind === "non-transient" || delayMs === undefined) {
      return specificationUnreadableRefusal(
        delayMs === undefined && attempt > 0
          ? `after ${attempt} retries (${attempt + 1} total attempts); last failure: ${detail}`
          : detail,
        failureKind,
        failureKind === "transient" ? (sawNonTimeoutFailure ? "other" : "timeout") : undefined,
      );
    }
    await wait(delayMs, signal);
  }
  if (specificationDigest(materialized) === verification.authoritativeDigest) return null;
  return refusal(
    SPEC_TRANSCRIPTION_REFUSAL_REASON,
    `materialized ${verification.path} does not match the authoritative specification${
      BRIEF_STANDING_DETAIL[verification.currentBrief.kind]
    }`,
  );
};
