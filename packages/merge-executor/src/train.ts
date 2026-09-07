import type { AuthorizationPayload, MergeOutcome, StopCondition } from "@anneal/db/merge-integrator";
import { confirmedWrite } from "@anneal/github-client";
import { classifyPreMerge, disarmAndReadBack, synchronousExecution, type Deps } from "./decision-table.js";
import type { PullRequestRef, PullRequestSnapshot, TrainGitHub } from "./github.js";

type TrainAuthorization = AuthorizationPayload & { activityId: string; train: NonNullable<AuthorizationPayload["train"]> };
const stop = (condition: StopCondition, evidence: Record<string, unknown>): MergeOutcome => ({ outcome: "stopped", condition, evidence: JSON.stringify(evidence) });
const failed = (check: string, evidence: Record<string, unknown> = {}): MergeOutcome => stop("train-precondition-failed", { check, ...evidence });
/** A read that did not answer is not an observation of drift. */
const unreadable = (phase: string, reason: string): MergeOutcome => stop("api-error", { phase, reason });

type PrefixCommit =
  | { status: "ok"; commit: { oid: string; parents: string[] } }
  | { status: "mismatch"; reason: string }
  | { status: "api-error"; reason: string };

/**
 * Change 4's lineage check, bounded by `position`.
 *
 * The prefix commit for position k has parents `(P_{k-1}, C_k)` and sits
 * exactly `k - 1` first-parent merge steps above the authorized base, so the
 * whole check costs `position` commit reads. Nothing here walks a chain of
 * unknown length: an authorization whose `baseSha` is not on the prefix's
 * first-parent line is a bounded mismatch, not an unbounded crawl.
 */
const prefixCommit = async (
  github: TrainGitHub,
  reference: PullRequestRef,
  authorization: TrainAuthorization,
  mergeCommit: PullRequestSnapshot["mergeCommit"],
): Promise<PrefixCommit> => {
  const { train } = authorization;
  if (!mergeCommit) return { status: "mismatch", reason: "the merged pull request reports no merge commit" };
  const read = await github.readCommit(reference, mergeCommit.oid);
  if (read.status !== "ok") return { status: "api-error", reason: read.reason };
  const commit = read.commit;
  // Git is authoritative for the parents, and the pull-request projection has
  // to agree with it: a projection that reports a different shape is an
  // observed inconsistency about who landed this commit, not a stale read.
  if (mergeCommit.parents.length !== commit.parents.length
    || mergeCommit.parents.some((parent, index) => parent !== commit.parents[index])) {
    return { status: "mismatch", reason: "the pull request's merge-commit parents disagree with the commit read from git" };
  }
  if (commit.parents.length !== 2 || commit.parents[0] !== train.predecessorOid || commit.parents[1] !== authorization.headSha) {
    return { status: "mismatch", reason: "the merge commit's parents are not (predecessor, authorized head)" };
  }
  const reachable = await github.isAncestor(reference, commit.oid, train.publishHead);
  if (reachable.status !== "ok") return { status: "api-error", reason: reachable.reason };
  if (!reachable.ancestor) return { status: "mismatch", reason: "the merge commit is not reachable from the authorized prefix" };
  // The predecessor's own distance to the authorized base is what makes this
  // commit the prefix commit for *this* position rather than for another one.
  let oid = train.predecessorOid;
  for (let step = train.position - 1; step > 0; step -= 1) {
    const predecessor = await github.readCommit(reference, oid);
    if (predecessor.status !== "ok") return { status: "api-error", reason: predecessor.reason };
    if (predecessor.commit.parents.length !== 2) return { status: "mismatch", reason: `prefix commit ${oid} is not a two-parent merge` };
    oid = predecessor.commit.parents[0]!;
  }
  if (oid !== authorization.baseSha) {
    return { status: "mismatch", reason: "the predecessor is not this position's prefix commit above the authorized base" };
  }
  return { status: "ok", commit };
};

export const executeTrain = async (
  deps: Deps,
  reference: PullRequestRef,
  authorization: TrainAuthorization,
  idempotencyKey: string,
  sends: number,
): Promise<MergeOutcome> => {
  const github = deps.train;
  const { train } = authorization;

  const published = async (base: string) => base === train.publishHead
    ? { status: "ok" as const, ancestor: true }
    : github.isAncestor(reference, train.publishHead, base);

  const finish = async (pullRequest?: PullRequestSnapshot): Promise<MergeOutcome> => {
    let pr = pullRequest;
    const started = deps.now().getTime();
    for (let attempt = 0; ; attempt++) {
      if (!pr) {
        const read = await deps.readPullRequest(reference);
        if (read.status !== "ok") return unreadable("train post-publication", read.reason);
        pr = read.snapshot.pullRequest;
      }
      if (pr.merged || pr.state === "MERGED") break;
      if (attempt >= deps.pollAttempts || deps.now().getTime() - started >= deps.pollBudgetMs) {
        return unreadable("train post-publication", "published prefix is not yet reflected by the candidate pull request");
      }
      await deps.sleep(deps.pollIntervalMs);
      pr = undefined;
    }
    const lineage = await prefixCommit(github, reference, authorization, pr.mergeCommit);
    if (lineage.status === "api-error") return unreadable("train lineage", lineage.reason);
    if (lineage.status !== "ok" || pr.headRefOid !== authorization.headSha) {
      return stop("changed-underneath-me", {
        phase: "train lineage",
        reason: lineage.status === "mismatch" ? lineage.reason : "the pull request head is not the authorized head",
        mergeCommit: pr.mergeCommit,
        authorizedHead: authorization.headSha,
        train,
      });
    }
    // The final prefix commit identifies the highest position without another
    // control-plane lookup or a second source of truth for train membership.
    if (lineage.commit.oid === train.publishHead) {
      try {
        const deleted = await github.deleteTrainRef(reference, train.ref);
        if (!deleted.ok) deps.logTrainCleanupFailure(deleted.reason);
      } catch {
        deps.logTrainCleanupFailure("train ref deletion failed");
      }
    }
    return { outcome: "merged", mergeCommitSha: lineage.commit.oid };
  };

  const verify = async (): Promise<{ outcome: MergeOutcome } | { baseRef: string; alreadyPublished: boolean; pr: PullRequestSnapshot }> => {
    const started = deps.now().getTime();
    for (let attempt = 0; ; attempt++) {
      const read = await deps.readPullRequest(reference);
      if (read.status === "api-error") return { outcome: unreadable("train precondition", read.reason) };
      if (read.status === "sync-unknown") {
        return { outcome: stop("deferred-merge-machinery", { phase: "train precondition", reason: read.reason }) };
      }
      const snapshot = read.snapshot;
      const pr = snapshot.pullRequest;
      if (pr.headRefOid !== authorization.headSha) return { outcome: failed("head", { observed: pr.headRefOid, expected: authorization.headSha }) };
      const base = await github.readDefaultBranch(reference);
      if (base.status !== "ok") return { outcome: unreadable("train default branch", base.reason) };
      if (base.name !== authorization.baseRef || pr.baseRefName !== base.name) return { outcome: failed("default-branch", { observed: base.name, authorized: authorization.baseRef, prBase: pr.baseRefName }) };
      const landed = await published(base.oid);
      if (landed.status !== "ok") return { outcome: unreadable("train publication ancestry", landed.reason) };
      // Cleanup removes the staging ref. Once publication is proven, replay is
      // governed by immutable commit lineage rather than that ephemeral ref.
      if (landed.ancestor) return { baseRef: base.name, alreadyPublished: true, pr };
      if (pr.merged || pr.state === "MERGED") return { outcome: stop("changed-underneath-me", { reason: "candidate is merged but the authorized prefix is not published" }) };
      const ref = await github.readRef(reference, train.ref);
      if (ref.status !== "ok") return { outcome: unreadable("train ref", ref.reason) };
      if (ref.oid !== train.publishHead) return { outcome: failed("train-ref", { ref: train.ref, observed: ref.oid }) };
      const head = await github.isAncestor(reference, authorization.headSha, train.publishHead);
      if (head.status !== "ok") return { outcome: unreadable("train head ancestry", head.reason) };
      if (!head.ancestor) return { outcome: failed("head-ancestry", { head: authorization.headSha, publishHead: train.publishHead }) };
      let acceptsBase: ((baseRefOid: string) => boolean) | undefined;
      if (train.position === 1) {
        if (base.oid !== authorization.baseSha) return { outcome: failed("base-position-1", { observed: base.oid, expected: authorization.baseSha }) };
      } else {
        const ancestor = await github.isAncestor(reference, base.oid, train.publishHead);
        if (ancestor.status !== "ok") return { outcome: unreadable("train base ancestry", ancestor.reason) };
        if (!ancestor.ancestor) return { outcome: failed("base-ancestry", { observed: base.oid, publishHead: train.publishHead }) };
        acceptsBase = (baseRefOid) => baseRefOid === base.oid;
      }
      // Change 2's train checks are additive. Publishing a prefix moves the
      // default branch, so the candidate still has to clear the whole pre-merge
      // defense list — required checks, draft and mergeability state, and the
      // positive synchronous-execution determination — before anything is
      // written. The one relaxation is Change 2's own: at a later position the
      // live base is the prefix commit the predecessor already published.
      const pending = classifyPreMerge(snapshot, authorization, acceptsBase);
      if (pending.kind === "stop") return { outcome: pending.outcome };
      if (pending.kind === "poll") {
        const elapsed = deps.now().getTime() - started;
        if (attempt >= deps.pollAttempts || elapsed >= deps.pollBudgetMs) {
          return { outcome: stop("unresolved-mergeability", { observed: pending.observed, phase: "train precondition", pollAttempts: attempt, elapsedMs: elapsed }) };
        }
        await deps.sleep(deps.pollIntervalMs);
        continue;
      }
      const sync = synchronousExecution(snapshot);
      if (sync.armed) return { outcome: await disarmAndReadBack(deps, reference, snapshot, sync.reason) };
      return { baseRef: base.name, alreadyPublished: false, pr };
    }
  };

  const initial = await verify();
  if ("outcome" in initial) return initial.outcome;
  if (initial.alreadyPublished) return finish(initial.pr);
  await deps.writeIntent({ idempotencyKey, prNumber: reference.number, headSha: authorization.headSha, authorizationActivityId: authorization.activityId });
  let guardStop: MergeOutcome | null = null;
  let rejected = false;
  const landing = await confirmedWrite({
    resend: "after-confirmed-absent",
    attempts: sends,
    attempt: async () => {
      const recheck = await deps.readChain();
      if (recheck.authorization?.activityId !== authorization.activityId) {
        guardStop = stop("superseded-authorization", { actedOn: authorization.activityId, latest: recheck.authorization?.activityId ?? null });
        return { status: "refused", reason: "superseded-authorization" };
      }
      const current = await verify();
      if ("outcome" in current) {
        guardStop = current.outcome;
        return { status: "refused", reason: "train guard refused" };
      }
      if (current.alreadyPublished) return { status: "applied", value: train.publishHead };
      const response = await github.publishTrain(reference, current.baseRef, train.publishHead);
      if (response.status === "published") return { status: "applied", value: train.publishHead };
      rejected = response.status === "rejected";
      return { status: rejected ? "refused" : "lost", reason: response.reason };
    },
    readBack: async () => {
      const base = await github.readDefaultBranch(reference);
      if (base.status !== "ok") return { status: "unreadable", reason: base.reason };
      if (base.name !== authorization.baseRef) return { status: "unreadable", reason: "default branch changed" };
      const landed = await published(base.oid);
      if (landed.status !== "ok") return { status: "unreadable", reason: landed.reason };
      return landed.ancestor ? { status: "applied", value: train.publishHead } : { status: "absent" };
    },
  });
  // A confirmed publication outranks a guard that refused a redundant send:
  // `confirmedWrite` reads back even after a refusal, and a read-back that
  // finds the prefix on the default branch has settled the run. Discarding it
  // would report a stop for a candidate that is already merged.
  if (landing.status === "applied") return finish();
  if (guardStop) return guardStop;
  return stop(rejected && landing.status === "refused" ? "train-publish-rejected" : "api-error", { phase: "train publication", reason: landing.reason, sends: landing.attempts });
};
