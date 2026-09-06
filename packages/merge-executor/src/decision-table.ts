/**
 * SPEC §3's decision table, implemented in its stated order.
 *
 * Everything here is driven through an injected `Deps`, so every leg is a unit
 * test against a recording fake rather than a live repository. The rule the
 * whole file obeys: **undefined is never a pass**. Each branch either merges
 * under a fully re-verified authorization or records a named stop condition.
 */

import { confirmedWrite } from "@anneal/github-client";

import {
  AUTHORIZED_MERGE_METHOD,
  type AuthorizationPayload,
  type MergeOutcome,
  type RequiredCheck,
  type StopCondition,
} from "@anneal/db/merge-integrator";

import type { BranchProtectionRule, MergeResponse, PullRequestSnapshot, ReadResult, RepositorySnapshot, TrainGitHub } from "./github.js";
import { executeTrain } from "./train.js";

export type ChainTarget =
  | { resolved: true; repository: string; prNumber: number; observed: number[]; correctionActivityId: string | null }
  | { resolved: false; unresolvable: "none" | "ambiguous" | "repository"; observed: number[] };

export type ChainEnvelope = {
  target: ChainTarget;
  authorization: (AuthorizationPayload & { activityId: string; createdAt: string }) | null;
  nearMatchCount: number;
  ignoredCount: number;
  refusal: "missing" | "ambiguous-tie" | "malformed-near-match" | null;
};

/** A `mergeIntegrator.intent` row this task already wrote, in an earlier run. */
export type IntentRecord = {
  activityId: string;
  idempotencyKey: string;
  prNumber: number;
  headSha: string;
  authorizationActivityId: string;
};

export type Deps = {
  train?: TrainGitHub;
  logTrainCleanupFailure?: (reason: string) => void;
  /** The chain read route at `chainIndex - 1`. Called twice: once to select the
   *  authorization, and once immediately before the merge to catch supersession
   *  that landed while the world was being verified (SPEC 4.6). */
  readChain: () => Promise<ChainEnvelope>;
  /** This task's own `mergeIntegrator.intent` history, newest last. */
  readOwnIntents: () => Promise<IntentRecord[]>;
  readPullRequest: (reference: { owner: string; name: string; number: number; baseRef: string }) => Promise<ReadResult>;
  merge: (
    reference: { owner: string; name: string; number: number },
    expectedHeadSha: string,
    expectedBase: { ref: string; sha: string; repositoryId: string },
  ) => Promise<MergeResponse>;
  disableAutoMerge: (pullRequestId: string) => Promise<import("./github.js").DisarmResult>;
  dequeuePullRequest: (entryId: string) => Promise<import("./github.js").DisarmResult>;
  writeIntent: (intent: Omit<IntentRecord, "activityId">) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** When this run started. A record created after it is retroactive (SPEC 4.7). */
  startedAt: Date;
  mergeIdentityLogin: string;
  pollAttempts: number;
  pollIntervalMs: number;
  pollBudgetMs: number;
};

/**
 * The ceiling on merge PUTs in one run, counting the first.
 *
 * Two, not more: the only thing a resend can recover from is a response that
 * was lost in transit and then positively confirmed not to have landed, and a
 * second lost-then-absent pair is a link that is failing, not a merge that is
 * nearly done. Past that the run stops and says so, which is the outcome the
 * old code reached on the first lost response.
 */
const GUARDED_MERGE_SENDS = 2;

/** What established that the merge is on the platform. */
type MergeLanding =
  | { via: "response"; sha: string }
  | { via: "read-back"; pullRequest: PullRequestSnapshot };

const stop = (condition: StopCondition, evidence: string): MergeOutcome =>
  ({ outcome: "stopped", condition, evidence });

const describe = (value: unknown): string => value === null ? "null" : value === undefined ? "absent" : String(value);

export const splitRepository = (repository: string): { owner: string; name: string } | null => {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) return null;
  return { owner, name };
};

/**
 * §11.2's required-check rule. The rule whose `pattern` matches the authorized
 * base ref and whose `requiresStatusChecks` is true supplies the context names;
 * a context absent from the rollup is a stop, never a pass.
 */
export const matchingProtectionRule = (
  rules: BranchProtectionRule[],
  baseRef: string,
): BranchProtectionRule | null => {
  const matches = rules.filter((rule) => rule.requiresStatusChecks && globMatches(rule.pattern, baseRef));
  if (matches.length === 0) return null;
  // Most specific first: a literal pattern beats a wildcard, and a longer
  // pattern beats a shorter one. GitHub's own precedence, made explicit.
  return [...matches].sort((left, right) => {
    const wildcards = Number(left.pattern.includes("*")) - Number(right.pattern.includes("*"));
    return wildcards !== 0 ? wildcards : right.pattern.length - left.pattern.length;
  })[0]!;
};

/** GitHub branch-protection patterns: `*` matches within a path segment, `**` across. */
export const globMatches = (pattern: string, value: string): boolean => {
  const source = pattern
    .split("**").map((part) => part.split("*").map((literal) => literal.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`, "u").test(value);
};

export type CheckVerdict =
  | { status: "ok"; observed: RequiredCheck[] }
  | { status: "pending"; pending: string[] }
  | { status: "stop"; reason: string };

export const verifyRequiredChecks = (
  snapshot: RepositorySnapshot,
  authorizedHead: string,
  baseRef: string,
): CheckVerdict => {
  // A rollup belonging to a different commit is not evidence about this head.
  if (snapshot.pullRequest.rollupCommitOid !== authorizedHead) {
    return { status: "stop", reason: `check rollup belongs to commit ${describe(snapshot.pullRequest.rollupCommitOid)}, not to the authorized head ${authorizedHead}` };
  }
  const rule = matchingProtectionRule(snapshot.branchProtectionRules, baseRef);
  const requiredNames = rule?.requiredStatusCheckContexts ?? [];
  const observed: RequiredCheck[] = [];
  const pending: string[] = [];
  for (const name of requiredNames) {
    const entry = snapshot.pullRequest.checks.find((check) => (check.kind === "CheckRun" ? check.name : check.context) === name);
    if (!entry) return { status: "stop", reason: `required check ${name} is absent from the rollup for ${authorizedHead}` };
    if (entry.kind === "CheckRun") {
      if (entry.status !== "COMPLETED") { pending.push(name); continue; }
      if (entry.conclusion !== "SUCCESS") return { status: "stop", reason: `required check ${name} concluded ${describe(entry.conclusion)}` };
      observed.push({ name, conclusion: "SUCCESS" });
    } else {
      if (entry.state === "PENDING" || entry.state === "EXPECTED") { pending.push(name); continue; }
      if (entry.state !== "SUCCESS") return { status: "stop", reason: `required status ${name} is ${describe(entry.state)}` };
      observed.push({ name, conclusion: "SUCCESS" });
    }
  }
  return pending.length > 0 ? { status: "pending", pending } : { status: "ok", observed };
};

export type SyncVerdict = { armed: false } | { armed: true; reason: string };

/** §11.2, precondition 10: synchronous execution is determined POSITIVELY. All
 *  three fields must be `null`; an unknown or a permission error is never read
 *  as "no queue". */
export const synchronousExecution = (snapshot: RepositorySnapshot): SyncVerdict => {
  const armed: string[] = [];
  if (snapshot.mergeQueue !== null) armed.push(`repository.mergeQueue is ${snapshot.mergeQueue.id}`);
  if (snapshot.pullRequest.mergeQueueEntry !== null) armed.push(`pullRequest.mergeQueueEntry is ${snapshot.pullRequest.mergeQueueEntry.id}`);
  if (snapshot.pullRequest.autoMergeRequest !== null) armed.push("pullRequest.autoMergeRequest is enabled");
  return armed.length === 0 ? { armed: false } : { armed: true, reason: armed.join("; ") };
};

export const idempotencyKeyFor = (prNumber: number, headSha: string, authorizationActivityId: string): string =>
  `${prNumber}:${headSha}:${authorizationActivityId}`;

const hasAuthorizedParents = (
  commit: PullRequestSnapshot["mergeCommit"],
  authorization: AuthorizationPayload,
): commit is NonNullable<PullRequestSnapshot["mergeCommit"]> => commit !== null && commit.parents.length >= 2
  && commit.parents[0] === authorization.baseSha
  && commit.parents[1] === authorization.headSha;

/**
 * §5.1 — the replay determination, applied whenever the PR is already merged.
 * All three durable facts must hold, plus the landed commit's parent check.
 */
export const classifyMerged = (
  pullRequest: PullRequestSnapshot,
  authorization: AuthorizationPayload,
  intents: IntentRecord[],
  idempotencyKey: string,
  mergeIdentityLogin: string,
): MergeOutcome => {
  const priorIntent = intents.some((intent) => intent.idempotencyKey === idempotencyKey);
  const headMatches = pullRequest.headRefOid === authorization.headSha;
  const mergedByUs = pullRequest.mergedByLogin === mergeIdentityLogin;
  const commit = pullRequest.mergeCommit;
  const evidence = JSON.stringify({
    headRefOid: pullRequest.headRefOid,
    authorizedHead: authorization.headSha,
    mergedBy: pullRequest.mergedByLogin,
    expectedIdentity: mergeIdentityLogin,
    priorIntent,
    mergeCommit: commit,
    authorizedBase: authorization.baseSha,
  });
  if (!headMatches || !mergedByUs || !priorIntent) {
    // Someone or something other than this run's own authorized attempt landed
    // it. That is an incident to be judged by a human, never a success.
    return stop("changed-underneath-me", evidence);
  }
  if (!hasAuthorizedParents(commit, authorization)) return stop("base-drift-post-merge", evidence);
  return { outcome: "merged", mergeCommitSha: commit.oid };
};

/** §11.4 — disarm, then read back. A readback that still shows an armed state is
 *  recorded INSIDE the 4.15 stop as an incident demanding immediate action. */
const disarmAndReadBack = async (
  deps: Deps,
  reference: { owner: string; name: string; number: number; baseRef: string },
  snapshot: RepositorySnapshot,
  reason: string,
): Promise<MergeOutcome> => {
  const attempts: string[] = [];
  if (snapshot.pullRequest.autoMergeRequest !== null) {
    const result = await deps.disableAutoMerge(snapshot.pullRequest.id);
    attempts.push(`disablePullRequestAutoMerge: ${result.ok ? "ok" : `failed (${result.reason})`}`);
  }
  if (snapshot.pullRequest.mergeQueueEntry !== null) {
    const result = await deps.dequeuePullRequest(snapshot.pullRequest.mergeQueueEntry.id);
    attempts.push(`dequeuePullRequest: ${result.ok ? "ok" : `failed (${result.reason})`}`);
  }
  const readback = await deps.readPullRequest(reference);
  const stillArmed = readback.status !== "ok"
    ? `readback failed: ${readback.reason}`
    : synchronousExecution(readback.snapshot).armed
      ? `readback still shows an armed state: ${(synchronousExecution(readback.snapshot) as { reason: string }).reason}`
      : null;
  return stop("deferred-merge-machinery", JSON.stringify({
    detected: reason,
    disarm: attempts,
    armedStateIncident: stillArmed,
  }));
};

/**
 * The gate every merge send after the first has to pass.
 *
 * A resend is only safe because it is not a resend of a *request* — it is a
 * fresh merge decision, taken against the read-back that proved the first send
 * did not land, and refused unless that read-back still shows the exact world
 * the human authorized. Everything the pre-merge path checks is checked again
 * here, in the same order, so a merge sent second is a merge that would have
 * been authorized had it been sent first.
 *
 * Returns the stop to record, or null to permit the send.
 */
const refuseResend = async (
  deps: Deps,
  reference: { owner: string; name: string; number: number; baseRef: string },
  authorization: AuthorizationPayload & { activityId: string },
  snapshot: RepositorySnapshot | null,
): Promise<MergeOutcome | null> => {
  if (!snapshot) {
    // Unreachable while `confirmedWrite` only resends after a completed
    // read-back, and fail-closed if that ever stops being true.
    return stop("api-error", JSON.stringify({ phase: "resend guard", reason: "no read-back to re-verify against" }));
  }
  // SPEC 4.6 again. The first send and its read-back took wall-clock time, and
  // an authorization that arrived inside it supersedes the one being acted on.
  const recheck = await deps.readChain();
  if (recheck.authorization?.activityId !== authorization.activityId) {
    return stop("superseded-authorization", JSON.stringify({
      actedOn: authorization.activityId,
      latest: recheck.authorization?.activityId ?? null,
      phase: "resend guard",
    }));
  }
  const verdict = classifyPreMerge(snapshot, authorization);
  if (verdict.kind === "stop") return verdict.outcome;
  if (verdict.kind === "poll") {
    // Mergeability that has gone back to UNKNOWN is not a state we may merge
    // on, and the bounded poll belongs to the first send, not to this one.
    return stop("unresolved-mergeability", JSON.stringify({ observed: verdict.observed, phase: "resend guard" }));
  }
  const sync = synchronousExecution(snapshot);
  if (sync.armed) return disarmAndReadBack(deps, reference, snapshot, sync.reason);
  return null;
};

export const execute = async (deps: Deps): Promise<MergeOutcome> => {
  // ---- 1. Chain target identity ------------------------------------------
  const envelope = await deps.readChain();
  if (!envelope.target.resolved) {
    return stop("target-unresolvable", JSON.stringify({
      unresolvable: envelope.target.unresolvable,
      observed: envelope.target.observed,
    }));
  }
  const target = envelope.target;

  // ---- 2. The authorization, already validated server-side ----------------
  if (envelope.nearMatchCount > 0 || envelope.refusal === "ambiguous-tie" || envelope.refusal === "malformed-near-match") {
    return stop("ambiguity", JSON.stringify({
      refusal: envelope.refusal,
      nearMatchCount: envelope.nearMatchCount,
      ignoredCount: envelope.ignoredCount,
    }));
  }
  const authorization = envelope.authorization;
  if (!authorization) {
    return stop("missing-authorization", JSON.stringify({ refusal: envelope.refusal, ignoredCount: envelope.ignoredCount }));
  }
  if (new Date(authorization.createdAt).getTime() > deps.startedAt.getTime()) {
    return stop("retroactive-authorization", JSON.stringify({
      authorizationCreatedAt: authorization.createdAt,
      runStartedAt: deps.startedAt.toISOString(),
    }));
  }
  if (authorization.repository !== target.repository || authorization.prNumber !== target.prNumber) {
    return stop("payload-mismatch", JSON.stringify({
      authorized: { repository: authorization.repository, prNumber: authorization.prNumber },
      chainTarget: { repository: target.repository, prNumber: target.prNumber },
    }));
  }
  if (authorization.mergeMethod !== AUTHORIZED_MERGE_METHOD) {
    return stop("payload-mismatch", JSON.stringify({ mergeMethod: authorization.mergeMethod }));
  }
  const repository = splitRepository(target.repository);
  if (!repository) return stop("target-unresolvable", JSON.stringify({ repository: target.repository }));
  const reference = { ...repository, number: target.prNumber, baseRef: authorization.baseRef };
  const idempotencyKey = idempotencyKeyFor(target.prNumber, authorization.headSha, authorization.activityId);
  if (authorization.train) {
    return executeTrain(deps, reference, { ...authorization, train: authorization.train }, idempotencyKey, GUARDED_MERGE_SENDS);
  }
  const intents = await deps.readOwnIntents();

  // ---- 3-5. Verify the world, with the bounded UNKNOWN poll ---------------
  const pollStartedAt = deps.now().getTime();
  let attempt = 0;
  let snapshot: RepositorySnapshot;
  for (;;) {
    const read = await deps.readPullRequest(reference);
    if (read.status === "api-error") return stop("api-error", JSON.stringify({ reason: read.reason }));
    if (read.status === "sync-unknown") {
      return stop("deferred-merge-machinery", JSON.stringify({ reason: read.reason, note: "a synchronous-execution field could not be positively determined" }));
    }
    snapshot = read.snapshot;

    // The replay determination precedes every pre-merge check: a merged PR is
    // not "non-clean", it is either our own landed work or an incident.
    if (snapshot.pullRequest.merged || snapshot.pullRequest.state === "MERGED") {
      return classifyMerged(snapshot.pullRequest, authorization, intents, idempotencyKey, deps.mergeIdentityLogin);
    }

    const pending = classifyPreMerge(snapshot, authorization);
    if (pending.kind === "stop") return pending.outcome;
    if (pending.kind === "ok") break;
    // kind === "poll"
    attempt += 1;
    const elapsed = deps.now().getTime() - pollStartedAt;
    if (attempt > deps.pollAttempts || elapsed >= deps.pollBudgetMs) {
      return stop("unresolved-mergeability", JSON.stringify({
        observed: pending.observed,
        pollAttempts: attempt - 1,
        elapsedMs: elapsed,
      }));
    }
    await deps.sleep(deps.pollIntervalMs);
  }

  // ---- 4 (cont). Synchronous execution, positively determined -------------
  const sync = synchronousExecution(snapshot);
  if (sync.armed) return disarmAndReadBack(deps, reference, snapshot, sync.reason);

  // ---- 6. Intent, supersession re-check, then the guarded merge ------------
  await deps.writeIntent({
    idempotencyKey,
    prNumber: target.prNumber,
    headSha: authorization.headSha,
    authorizationActivityId: authorization.activityId,
  });

  // SPEC 4.6. Verification took wall-clock time; a newer authorization may have
  // landed inside it. Merging under a superseded record is exactly what the
  // exact-head authorization is supposed to make impossible.
  const recheck = await deps.readChain();
  if (recheck.authorization?.activityId !== authorization.activityId) {
    return stop("superseded-authorization", JSON.stringify({
      actedOn: authorization.activityId,
      latest: recheck.authorization?.activityId ?? null,
    }));
  }

  // The base SHA is re-read as the LAST read before the merge, so the window
  // between "the base was what the human authorized" and the merge itself is as
  // small as the platform allows.
  const finalRead = await deps.readPullRequest(reference);
  if (finalRead.status !== "ok") {
    return finalRead.status === "api-error"
      ? stop("api-error", JSON.stringify({ reason: finalRead.reason, phase: "pre-merge re-read" }))
      : stop("deferred-merge-machinery", JSON.stringify({ reason: finalRead.reason, phase: "pre-merge re-read" }));
  }
  if (finalRead.snapshot.baseRefOid !== authorization.baseSha) {
    return stop("base-drift", JSON.stringify({ observed: finalRead.snapshot.baseRefOid, authorized: authorization.baseSha }));
  }
  if (finalRead.snapshot.pullRequest.headRefOid !== authorization.headSha) {
    return stop("head-drift", JSON.stringify({ observed: finalRead.snapshot.pullRequest.headRefOid, authorized: authorization.headSha }));
  }
  // Base and head are not the whole of the pre-merge state, and the review of
  // PR #130 named the gap: auto-merge enabled, the PR converted to a draft, a
  // required check turned red or a new required context added — any of these
  // can happen inside the same window as a base move, and none of them shifts
  // an oid. The last read before the merge therefore re-runs the *entire*
  // classification, not a two-field diff.
  //
  // Replay first, for the same reason as in the poll loop: if someone merged it
  // between the intent and now, that is a replay determination, not a drift.
  if (finalRead.snapshot.pullRequest.merged || finalRead.snapshot.pullRequest.state === "MERGED") {
    return classifyMerged(finalRead.snapshot.pullRequest, authorization, intents, idempotencyKey, deps.mergeIdentityLogin);
  }
  const finalPending = classifyPreMerge(finalRead.snapshot, authorization);
  if (finalPending.kind === "stop") return finalPending.outcome;
  if (finalPending.kind === "poll") {
    // The bounded poll is spent. A state that has gone back to UNKNOWN at the
    // last moment is not a state we may merge on.
    return stop("unresolved-mergeability", JSON.stringify({ observed: finalPending.observed, phase: "pre-merge re-read" }));
  }
  const finalSync = synchronousExecution(finalRead.snapshot);
  if (finalSync.armed) return disarmAndReadBack(deps, reference, finalRead.snapshot, finalSync.reason);

  // ---- 6 (cont). The guarded merge, on the confirmed-write engine ---------
  //
  // What licenses this write is everything above it: the exact-head
  // authorization, the intent record, the supersession re-check, and a full
  // re-classification taken as the last read before the send. What licenses it
  // to *stop* is `confirmedWrite`: a response that never arrived is read back
  // before anything else happens, and only a read-back that positively finds
  // the pull request still unmerged may license a second send.
  //
  // Both halves of the night of 2026-08-18 are this one call. PR #150 — the
  // PUT reported EOF, the read-back said MERGED — is the read-back branch, and
  // goes to the §5.1 replay determination exactly as it did before. PR #147 —
  // the PUT reported EOF, the read-back said still OPEN — is the resend, which
  // this executor could not do: it stopped `api-error` and an operator sent the
  // second PUT by hand. Deleting that hand-sent PUT is what #139 is for.
  //
  // A resend is not a retry of a request. `refuseResend` re-runs the entire
  // authorization — supersession, base, head, state, draft, checks and the
  // synchronous-execution disarm — against the read-back that established the
  // first send did not land, and refuses if anything moved at all. The
  // expected-head compare-and-swap then makes the send itself incapable of
  // landing a merge the authorization did not name, and makes a second PUT
  // after a first one that *did* land answer 405 rather than merge twice.
  const state: {
    response: MergeResponse | null;
    readBack: RepositorySnapshot | null;
    guardStop: MergeOutcome | null;
    sends: number;
  } = { response: null, readBack: null, guardStop: null, sends: 0 };

  const landing = await confirmedWrite<MergeLanding>({
    resend: "after-confirmed-absent",
    attempts: GUARDED_MERGE_SENDS,
    attempt: async (sendNumber) => {
      if (sendNumber > 1) {
        state.guardStop = await refuseResend(deps, reference, authorization, state.readBack);
        if (state.guardStop) {
          return { status: "refused", reason: `the resend guard refused: ${state.guardStop.outcome === "stopped" ? state.guardStop.condition : "unknown"}` };
        }
      }
      state.sends += 1;
      const response = await deps.merge(
        reference,
        authorization.headSha,
        { ref: authorization.baseRef, sha: authorization.baseSha, repositoryId: finalRead.snapshot.repositoryId },
      );
      state.response = response;
      if (response.status === "merged") return { status: "applied", value: { via: "response", sha: response.sha } };
      // `unknown` is the only lost class the transport produces: a 5xx, a
      // timeout, an EOF, or a body that could not be parsed. Everything else
      // is a deterministic no, and is still read back below.
      if (response.status === "unknown") return { status: "lost", reason: response.reason };
      return { status: "refused", reason: response.status };
    },
    readBack: async () => {
      const read = await deps.readPullRequest(reference);
      if (read.status !== "ok") {
        state.readBack = null;
        return { status: "unreadable", reason: read.reason };
      }
      state.readBack = read.snapshot;
      // "Applied" here means the pull request is merged — not that *we* merged
      // it. Which of those it was is the replay determination's question, and
      // it is asked below with the full intent history.
      return read.snapshot.pullRequest.merged || read.snapshot.pullRequest.state === "MERGED"
        ? { status: "applied", value: { via: "read-back", pullRequest: read.snapshot.pullRequest } }
        : { status: "absent" };
    },
  });

  if (landing.status !== "applied") {
    // Nothing landed, or nothing can be said about whether it landed. Every
    // branch below is a stop; none of them sends anything further.
    if (state.guardStop) return state.guardStop;
    const response = state.response;
    const platform = response === null
      ? "no response was recorded"
      : response.status === "unknown" ? response.reason
      : response.status === "not-mergeable" ? "405 not mergeable"
      : response.status;
    if (landing.status === "indeterminate") {
      // The one pairing that must never be resolved by sending again: the
      // merge's response was lost AND the read-back that would have settled it
      // failed. The merge may or may not be on master; only a human may look.
      return stop("api-error", JSON.stringify({ platform, reclassify: landing.reason, sends: state.sends }));
    }
    if (response?.status === "head-moved") {
      return stop("head-drift", JSON.stringify({ platform: "409 on the expected-head compare-and-swap", authorized: authorization.headSha }));
    }
    if (response?.status === "unprocessable") {
      return stop("payload-mismatch", JSON.stringify({ platform: response.reason }));
    }
    if (response?.status === "forbidden" || response?.status === "not-found") {
      return stop("api-error", JSON.stringify({ platform: response.reason }));
    }
    // A 405, or a lost response whose resends were refused or spent. The
    // read-back that proved nothing landed is the freshest view of the world
    // there is, so it names the condition — no further re-read is taken.
    const observed = state.readBack;
    if (observed) {
      const rearmed = synchronousExecution(observed);
      if (rearmed.armed) return disarmAndReadBack(deps, reference, observed, rearmed.reason);
      const reclassified = classifyPreMerge(observed, authorization);
      if (reclassified.kind === "stop") return reclassified.outcome;
    }
    return stop("api-error", JSON.stringify({
      platform,
      sends: state.sends,
      note: "the classifying re-read found no disqualifying condition",
    }));
  }

  if (landing.value.via === "read-back") {
    // The response was lost and the pull request reads MERGED. Whether that is
    // this run's own landed merge or someone else's is the §5.1 replay
    // determination's call, made against the full intent history — including
    // the intent this run wrote before sending, which has no activity id yet.
    return classifyMerged(landing.value.pullRequest, authorization, [
      ...intents,
      { activityId: "pending", idempotencyKey, prNumber: target.prNumber, headSha: authorization.headSha, authorizationActivityId: authorization.activityId },
    ], idempotencyKey, deps.mergeIdentityLogin);
  }

  // ---- 6 (cont). Post-merge parent verification ---------------------------
  const mergeCommitSha = landing.value.sha;
  const verify = await deps.readPullRequest(reference);
  if (verify.status !== "ok") {
    return stop("base-drift-post-merge", JSON.stringify({
      mergeCommitSha,
      note: "the merge landed but its parents could not be verified",
      reason: verify.reason,
    }));
  }
  const landed = verify.snapshot.pullRequest.mergeCommit;
  const landedIdentifiesMerge = verify.snapshot.baseRefOid !== null
    && landed !== null
    && landed.oid === mergeCommitSha
    && hasAuthorizedParents(landed, authorization);
  // The ref can land before GitHub's pull-request mergeCommit projection catches up.
  const refAloneProvesMerge = verify.snapshot.baseRefOid === mergeCommitSha && landed === null;
  if (!landedIdentifiesMerge && !refAloneProvesMerge) {
    return stop("base-drift-post-merge", JSON.stringify({
      mergeCommitSha,
      landed,
      observedBaseRefOid: verify.snapshot.baseRefOid,
      authorizedBase: authorization.baseSha,
      authorizedHead: authorization.headSha,
    }));
  }
  return { outcome: "merged", mergeCommitSha };
};

type PreMergeVerdict =
  | { kind: "ok" }
  | { kind: "poll"; observed: Record<string, unknown> }
  | { kind: "stop"; outcome: MergeOutcome };

/** SPEC §3 preconditions 1-7, exactly §11.2's accepted values. */
export const classifyPreMerge = (
  snapshot: RepositorySnapshot,
  authorization: AuthorizationPayload,
): PreMergeVerdict => {
  const pr = snapshot.pullRequest;
  if (pr.headRefOid !== authorization.headSha) {
    return { kind: "stop", outcome: stop("head-drift", JSON.stringify({ observed: pr.headRefOid, authorized: authorization.headSha })) };
  }
  if (pr.baseRefName !== authorization.baseRef) {
    return { kind: "stop", outcome: stop("base-drift", JSON.stringify({ observed: pr.baseRefName, authorized: authorization.baseRef })) };
  }
  if (snapshot.baseRefOid === null) {
    return { kind: "stop", outcome: stop("api-error", JSON.stringify({ reason: "the base ref resolved to null" })) };
  }
  if (snapshot.baseRefOid !== authorization.baseSha) {
    return { kind: "stop", outcome: stop("base-drift", JSON.stringify({ observed: snapshot.baseRefOid, authorized: authorization.baseSha })) };
  }
  if (pr.state !== "OPEN") {
    return { kind: "stop", outcome: stop("non-clean-mergeability", JSON.stringify({ state: pr.state })) };
  }
  if (pr.isDraft) {
    return { kind: "stop", outcome: stop("non-clean-mergeability", JSON.stringify({ isDraft: true })) };
  }

  const checks = verifyRequiredChecks(snapshot, authorization.headSha, authorization.baseRef);
  if (checks.status === "stop") {
    return { kind: "stop", outcome: stop("check-failure-or-absence", JSON.stringify({ reason: checks.reason })) };
  }

  const mergeableUnknown = pr.mergeable === "UNKNOWN";
  const stateUnknown = pr.mergeStateStatus === "UNKNOWN";
  if (mergeableUnknown || stateUnknown || checks.status === "pending") {
    return {
      kind: "poll",
      observed: {
        mergeable: pr.mergeable,
        mergeStateStatus: pr.mergeStateStatus,
        ...(checks.status === "pending" ? { pendingChecks: checks.pending } : {}),
      },
    };
  }
  if (pr.mergeable !== "MERGEABLE") {
    return { kind: "stop", outcome: stop("non-clean-mergeability", JSON.stringify({ mergeable: describe(pr.mergeable) })) };
  }
  if (pr.mergeStateStatus !== "CLEAN") {
    return { kind: "stop", outcome: stop("non-clean-mergeability", JSON.stringify({ mergeStateStatus: describe(pr.mergeStateStatus) })) };
  }
  return { kind: "ok" };
};
