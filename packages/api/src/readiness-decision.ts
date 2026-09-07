import { randomUUID } from "node:crypto";

import { defenseTriggers, type MergeEvidence } from "@anneal/db";

import { evidenceFromSnapshot } from "./merge-evidence-worker.js";
import { GitHubReadError, type PullRequestReader } from "./github-read.js";

type ReadinessContext = {
  readiness: {
    id: string;
    chainId: string | null;
    projectId: string;
    repoId: string | null;
  };
  now: Date;
};

type RegressionPass = {
  headSha: string;
  baseHeadSha: string;
};

export const READINESS_READ_BUDGET_MS = 20_000;

export type ReadinessInput = ReadinessContext & (
  | { stage: "claim-lost" | "regression-pending" }
  | { stage: "missing-regression-evidence" }
  | { stage: "invalid-regression-evidence" }
  | {
      stage: "read-failed";
      failure: {
        kind: GitHubReadError["kind"] | "unexpected";
        message: string;
      };
    }
  | {
      stage: "ready";
      regression: RegressionPass;
      /**
       * A previously validated merge-train base and candidate head. The train
       * is the only path that may authorize a candidate whose head is not an
       * ancestor of the live base; the caller remains responsible for proving
       * the train record and its cumulative gates before supplying this input.
       */
      train?: { baseSha: string; candidateHeadSha: string };
      target:
        | { resolved: true; repository: string; prNumber: number }
        | { resolved: false; unresolvable: "none" | "ambiguous" | "repository" };
      defaultBranch: string;
    }
);

export type ReadinessDecision =
  | {
      kind: "authorize";
      evidence: MergeEvidence;
      repository: string;
      prNumber: number;
      issuedAt: string;
      baseSha: string;
      headSha: string;
      /**
       * The defence-list paths this diff moved. They no longer hold the merge;
       * the worker records them as an audit message against the readiness task.
       */
      auditTriggers: Array<{ path: string; reason: string }>;
    }
  | {
      kind: "requeue-regression";
      reason: string;
      staleBaseSha: string;
      currentBaseSha: string;
    }
  | { kind: "defer"; reason: string }
  | { kind: "stop"; condition: string; evidence: string }
  | { kind: "skip" };

const stop = (condition: string, evidence: string): ReadinessDecision => (
  { kind: "stop", condition, evidence }
);

const readFailureDecision = (failure: {
  kind: GitHubReadError["kind"] | "unexpected";
  message: string;
}): ReadinessDecision => {
  const evidence = `readiness evaluation failed: ${failure.message}`;
  if (failure.kind === "timeout" || failure.kind === "transport") {
    return { kind: "defer", reason: evidence };
  }
  return stop("readiness-read-failed", evidence);
};

/**
 * Owns the complete remote-read sequence and the decision derived from it.
 * The worker supplies durable facts and applies the result; this module alone
 * decides which GitHub facts are needed and when a later read can be skipped.
 */
export const evaluateReadiness = async (
  facts: PullRequestReader,
  input: ReadinessInput,
): Promise<ReadinessDecision> => {
  switch (input.stage) {
    case "claim-lost":
    case "regression-pending":
      return { kind: "skip" };
    case "missing-regression-evidence":
      return stop("regression-evidence-missing", "missing head-bound regression PASS evidence");
    case "invalid-regression-evidence":
      return stop("regression-evidence-invalid", "missing or stale head-bound regression PASS evidence");
    case "read-failed":
      return readFailureDecision(input.failure);
    case "ready":
      break;
  }

  if (!facts.compareCommits) {
    return stop("github-reader-unavailable", "server-side GitHub comparison reader is unavailable");
  }
  if (!input.target.resolved) {
    return stop("pull-request-target-unresolved", `pull-request target is ${input.target.unresolvable}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READINESS_READ_BUDGET_MS);
  try {
    const snapshot = await facts.readPullRequest(
      input.target.repository,
      input.target.prNumber,
      input.defaultBranch,
      controller.signal,
    );
    if (snapshot.headRefOid !== input.regression.headSha) {
      return {
        kind: "requeue-regression",
        staleBaseSha: input.regression.baseHeadSha,
        currentBaseSha: snapshot.baseSha ?? "missing",
        reason: `stale PASS head ${input.regression.headSha}; current PR head is ${snapshot.headRefOid ?? "missing"}`,
      };
    }
    if (!snapshot.baseSha || !snapshot.baseRefName) {
      return stop("pull-request-base-missing", "pull request base identity is unavailable");
    }
    const expectedBaseSha = input.train?.baseSha ?? input.regression.baseHeadSha;
    if (snapshot.baseSha !== expectedBaseSha) {
      return {
        kind: "requeue-regression",
        staleBaseSha: input.regression.baseHeadSha,
        currentBaseSha: snapshot.baseSha,
        reason: input.train
          ? `merge-train base ${input.train.baseSha} is stale; current base is ${snapshot.baseSha}`
          : "target base advanced after regression PASS",
      };
    }
    if (input.train && input.train.candidateHeadSha !== input.regression.headSha) {
      return stop(
        "merge-train-evidence-invalid",
        `train candidate head ${input.train.candidateHeadSha} does not match Regression PASS head ${input.regression.headSha}`,
      );
    }

    const comparison = await facts.compareCommits(
      input.target.repository,
      snapshot.baseSha,
      input.regression.headSha,
      controller.signal,
    );
    if (!comparison.filesComplete) {
      return stop(
        "comparison-incomplete",
        "GitHub comparison file list is truncated or completeness is unproven",
      );
    }
    const normalAncestry = (comparison.status === "ahead" || comparison.status === "identical")
      && comparison.behindBy === 0;
    const validatedTrainDivergence = input.train !== undefined
      && input.train.baseSha === snapshot.baseSha
      && input.train.candidateHeadSha === input.regression.headSha
      && comparison.status === "diverged";
    if (!normalAncestry && !validatedTrainDivergence) {
      return {
        kind: "requeue-regression",
        staleBaseSha: input.regression.baseHeadSha,
        currentBaseSha: snapshot.baseSha,
        reason: `server-side ancestry check refused ${comparison.status} comparison with behind_by=${comparison.behindBy}`,
      };
    }

    const evidence = evidenceFromSnapshot(snapshot, randomUUID());
    if ("error" in evidence) {
      return stop("merge-evidence-invalid", evidence.error);
    }
    return {
      kind: "authorize",
      evidence,
      repository: input.target.repository,
      prNumber: input.target.prNumber,
      issuedAt: input.now.toISOString(),
      baseSha: snapshot.baseSha,
      headSha: input.regression.headSha,
      auditTriggers: defenseTriggers(comparison.files),
    };
  } catch (error: unknown) {
    return readFailureDecision({
      kind: error instanceof GitHubReadError ? error.kind : "unexpected",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
};
