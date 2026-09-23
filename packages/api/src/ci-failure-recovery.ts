import type { PullRequestSnapshot } from "./github-read.js";

export type FailedHeadCheck = {
  name: string;
  conclusion: string;
  detailsUrl: string | null;
  kind: "CheckRun" | "StatusContext";
};

const failedConclusions = new Set([
  "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE",
]);
const passedConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export const classifyHeadCheckFailures = (
  snapshot: PullRequestSnapshot,
  authorizedHeadSha: string,
): { kind: "failed"; checks: FailedHeadCheck[]; fingerprint: string }
  | { kind: "none" }
  | { kind: "unavailable"; reason: string } => {
  if (snapshot.headRefOid !== authorizedHeadSha || snapshot.headCommitOid !== authorizedHeadSha) {
    return { kind: "unavailable", reason: "PR head check rollup is not bound to the authorized head" };
  }
  if (!snapshot.checksComplete) {
    return { kind: "unavailable", reason: "PR head check rollup is missing or has more than 100 contexts" };
  }
  const checks: FailedHeadCheck[] = [];
  for (const context of snapshot.checkContexts) {
    if (context.__typename === "CheckRun" && "name" in context) {
      if (context.status !== "COMPLETED") continue;
      const conclusion = context.conclusion ?? "";
      if (failedConclusions.has(conclusion)) checks.push({
        kind: "CheckRun", name: context.name, conclusion,
        detailsUrl: context.detailsUrl ?? null,
      });
      else if (!passedConclusions.has(conclusion)) {
        return { kind: "unavailable", reason: `completed check ${context.name} has unknown conclusion ${conclusion || "null"}` };
      }
    } else if (context.__typename === "StatusContext" && "context" in context) {
      const state = context.state ?? "";
      if (state === "FAILURE" || state === "ERROR") checks.push({
        kind: "StatusContext", name: context.context, conclusion: state, detailsUrl: null,
      });
      else if (!["SUCCESS", "PENDING", "EXPECTED"].includes(state)) {
        return { kind: "unavailable", reason: `status ${context.context} has unknown state ${state || "null"}` };
      }
    } else {
      return { kind: "unavailable", reason: "PR head check rollup has an unknown context kind" };
    }
  }
  if (checks.length === 0) return { kind: "none" };
  checks.sort((a, b) => a.name.localeCompare(b.name) || a.conclusion.localeCompare(b.conclusion));
  return { kind: "failed", checks, fingerprint: JSON.stringify(checks.map(({ name, conclusion }) => [name, conclusion])) };
};
