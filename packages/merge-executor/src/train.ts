import type { AuthorizationPayload, MergeOutcome, StopCondition } from "@anneal/db/merge-integrator";
import { confirmedWrite } from "@anneal/github-client";
import type { Deps } from "./decision-table.js";
import type { PullRequestSnapshot, TrainGitHub } from "./github.js";

type TrainAuthorization = AuthorizationPayload & { activityId: string; train: NonNullable<AuthorizationPayload["train"]> };
type Reference = { owner: string; name: string; number: number; baseRef: string };
const stop = (condition: StopCondition, evidence: Record<string, unknown>): MergeOutcome => ({ outcome: "stopped", condition, evidence: JSON.stringify(evidence) });
const failed = (check: string, evidence: Record<string, unknown> = {}): MergeOutcome => stop("train-precondition-failed", { check, ...evidence });

/** Walk only prefix first parents: general reachability cannot establish a position. */
const candidateCommit = async (github: TrainGitHub, reference: Reference, authorization: TrainAuthorization) => {
  const commits: { oid: string; parents: string[] }[] = [];
  const seen = new Set<string>();
  let oid = authorization.train.publishHead;
  while (oid !== authorization.baseSha) {
    if (seen.has(oid)) return null;
    seen.add(oid);
    const read = await github.readCommit(reference, oid);
    if (read.status !== "ok" || read.commit.oid !== oid || read.commit.parents.length !== 2) return null;
    commits.push(read.commit);
    oid = read.commit.parents[0]!;
  }
  const candidate = commits.reverse()[authorization.train.position - 1];
  if (!candidate || candidate.parents[1] !== authorization.headSha
    || candidate.parents[0] !== authorization.train.predecessorOid) return null;
  return candidate;
};

export const executeTrain = async (
  deps: Deps,
  reference: Reference,
  authorization: TrainAuthorization,
  idempotencyKey: string,
  sends: number,
): Promise<MergeOutcome> => {
  const github = deps.train;
  if (!github) return failed("train-client", { reason: "train platform binding is unavailable" });
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
        if (read.status !== "ok") return stop("api-error", { phase: "train post-publication", reason: read.reason });
        pr = read.snapshot.pullRequest;
      }
      if (pr.merged || pr.state === "MERGED") break;
      if (attempt >= deps.pollAttempts || deps.now().getTime() - started >= deps.pollBudgetMs) {
        return stop("api-error", { phase: "train post-publication", reason: "published prefix is not yet reflected by the candidate pull request" });
      }
      await deps.sleep(deps.pollIntervalMs);
      pr = undefined;
    }
    const candidate = await candidateCommit(github, reference, authorization);
    const commit = pr.mergeCommit;
    if (pr.headRefOid !== authorization.headSha || !candidate || !commit || commit.oid !== candidate.oid
      || commit.parents.length !== 2 || commit.parents[0] !== candidate.parents[0] || commit.parents[1] !== authorization.headSha) {
      return stop("changed-underneath-me", { phase: "train lineage", mergeCommit: commit, candidate, authorizedHead: authorization.headSha, train });
    }
    // The final prefix commit identifies the highest position without another
    // control-plane lookup or a second source of truth for train membership.
    if (candidate.oid === train.publishHead) {
      try {
        const deleted = await github.deleteTrainRef(reference, train.ref);
        if (!deleted.ok) deps.logTrainCleanupFailure?.(deleted.reason);
      } catch {
        deps.logTrainCleanupFailure?.("train ref deletion failed");
      }
    }
    return { outcome: "merged", mergeCommitSha: candidate.oid };
  };

  const verify = async (): Promise<{ outcome: MergeOutcome } | { baseRef: string; alreadyPublished: boolean; pr: PullRequestSnapshot }> => {
    const read = await deps.readPullRequest(reference);
    if (read.status !== "ok") return { outcome: failed("pull-request", { reason: read.reason }) };
    const pr = read.snapshot.pullRequest;
    if (pr.headRefOid !== authorization.headSha) return { outcome: failed("head", { observed: pr.headRefOid, expected: authorization.headSha }) };
    const base = await github.readDefaultBranch(reference);
    if (base.status !== "ok") return { outcome: failed("default-branch", { reason: base.reason }) };
    if (base.name !== authorization.baseRef || pr.baseRefName !== base.name) return { outcome: failed("default-branch", { observed: base.name, authorized: authorization.baseRef, prBase: pr.baseRefName }) };
    const landed = await published(base.oid);
    if (landed.status !== "ok") return { outcome: failed("publication-ancestry", { reason: landed.reason }) };
    // Cleanup removes the staging ref. Once publication is proven, replay is
    // governed by immutable commit lineage rather than that ephemeral ref.
    if (landed.ancestor) return { baseRef: base.name, alreadyPublished: true, pr };
    if (pr.merged || pr.state === "MERGED") return { outcome: stop("changed-underneath-me", { reason: "candidate is merged but the authorized prefix is not published" }) };
    const ref = await github.readRef(reference, train.ref);
    if (ref.status !== "ok" || ref.oid !== train.publishHead) return { outcome: failed("train-ref", { ref: train.ref, observed: ref.status === "ok" ? ref.oid : ref.reason }) };
    const head = await github.isAncestor(reference, authorization.headSha, train.publishHead);
    if (head.status !== "ok" || !head.ancestor) return { outcome: failed("head-ancestry", { head: authorization.headSha, publishHead: train.publishHead }) };
    if (train.position === 1) {
      if (base.oid !== authorization.baseSha) return { outcome: failed("base-position-1", { observed: base.oid, expected: authorization.baseSha }) };
    } else {
      const ancestor = await github.isAncestor(reference, base.oid, train.publishHead);
      if (ancestor.status !== "ok" || !ancestor.ancestor) return { outcome: failed("base-ancestry", { observed: base.oid, publishHead: train.publishHead }) };
    }
    return { baseRef: base.name, alreadyPublished: false, pr };
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
  if (guardStop) return guardStop;
  if (landing.status !== "applied") return stop(rejected && landing.status === "refused" ? "train-publish-rejected" : "api-error", { phase: "train publication", reason: landing.reason, sends: landing.attempts });
  return finish();
};
