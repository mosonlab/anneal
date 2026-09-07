import { confirmedWrite, isDeterministicRefusal, isLostResponse } from "@anneal/github-client";
import {
  canonicalOutputSchema,
  canonicalTemplateIdentity,
  PR_TEMPLATE_NAME,
  type PrHandoffKind,
  type PrHandoffOutput,
  runOwnedHead,
} from "@anneal/db";

import type { ClaimedTask, FailureClass } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { bindCommandRunner, isCommandTimeout, KILL_OVERHEAD_MS, platformCommitArgs, type CommandRunner } from "./exec.js";
import {
  boundedTimeout, budgetRemains, GH_PROBE_TIMEOUT_MS, MIN_ATTEMPT_TIMEOUT_MS, NETWORK_ATTEMPTS,
  NETWORK_COMMAND_TIMEOUT_MS, runWithNetworkRetry, transientBackoff, WORKSPACE_HEAD_TIMEOUT_MS,
  type AttemptBudget, type RetryOptions,
} from "./network-retry.js";
import type { Workspace } from "./workspace.js";
import { workspaceEnvironment } from "./workspace.js";

export type DeliveryResult = {
  pushStatus: "SUCCEEDED" | "FAILED";
  pushRemote: string;
  /** The ref actually handed to `git push`, reported on every path that pushed —
   *  including the PR-failure path, where the branch is on the remote no matter
   *  what `gh` did. The control plane treats this as the one publication
   *  signal, so a path that pushes and forgets to report it makes a chain step
   *  base on the wrong branch. */
  pushedBranch?: string;
  headSha?: string;
  /** The salvage commit's first parent, reported only by `salvageWorkspace`.
   *  The next Run of the task is handed both this and `headSha`, so an agent
   *  that starts on a salvaged head can tell whether the salvage sits directly
   *  on the head it was supposed to work from without reconstructing that fact
   *  from git history. Absent when the salvaged commit has no parent. */
  salvageParentSha?: string;
  pushError?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  deliveryInstructions?: string;
  failureClass?: FailureClass;
  /** The delivery command's own failure, kept structured. Never part of the
   *  completion payload — runner.ts destructures it off before the spread —
   *  because its `error` is a live object, not something to serialise. */
  failure?: DeliveryFailure;
};

/**
 * Why delivery failed, in the form the failure envelope needs.
 *
 * `message` and `stderr` are text; `error` is the original exception, held by
 * reference so its *type* survives. That is the whole point: #124 made a
 * per-command timeout a `CommandTimeoutError` rather than a phrase, and
 * flattening it to `error.message` here threw the type away one line after it
 * was caught — so a genuinely hung `git push` reached the API looking like an
 * ordinary failed run and was classified TASK_FAILED, non-retryable.
 */
export type DeliveryFailure = {
  /** The command that failed, named as an operator would name it. */
  operation: string;
  message: string;
  error: unknown;
};

export type DeliveryClaim = {
  task: Pick<ClaimedTask["task"], "id" | "name" | "templateStep"> & {
    /** The full task description is used only by the canonical PR body. */
    description?: string;
    /** Chain identity is required by the canonical PR body. */
    chainId?: string | null;
    chainIndex?: number | null;
  };
  repo: Pick<ClaimedTask["repo"], "remoteUrl" | "defaultBranch">;
  run: Partial<Pick<ClaimedTask["run"], "opensPullRequest" | "pullRequestBase" | "requiresCommit">>;
};

export type DeliverWorkspaceDependencies = {
  command?: CommandRunner;
  /** HEAD already captured by the runner before delivery. Direct callers may
   *  omit it and let delivery resolve the commit itself. */
  headSha?: string;
  recordPublication?: (branch: string) => Promise<void>;
  /** The canonical PR handoff the session status route already decided complete. */
  prWorkflowOutputs?: readonly PrHandoffOutput[];
  retryOptions?: RetryOptions;
};

export type SalvageWorkspaceDependencies = {
  command?: CommandRunner;
  retryOptions?: RetryOptions;
};

const githubRepo = (remote: string): string | null => {
  const ssh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (ssh?.[1]) return ssh[1];
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return url.pathname.replace(/^\//, "").replace(/\.git$/, "") || null;
  } catch {
    return null;
  }
};

// \bauth\w* would still swallow "Author identity unknown" (git's real error
// for a missing user.email, a config problem, not credentials) — so the auth
// terms are spelled out instead of matched as a bare substring.
const failureClassFor = (message: string): FailureClass =>
  /authentication|authorization|unauthorized|credential|permission denied|\b403\b|\b401\b/i.test(message)
    ? "AUTH_REQUIRED"
    : "TOOL_FAILED";

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const manual = (branch: string, remote: string, reason: string): DeliveryResult => ({
  pushStatus: "SUCCEEDED",
  pushRemote: remote,
  pushedBranch: branch,
  deliveryInstructions: `${reason} Branch '${branch}' was pushed. Open a pull request manually against the repository default branch.`,
});

/** The step pushed and is done: it was never meant to open a pull request, so
 *  saying "open one manually" would be wrong advice, not just noise. */
const noPullRequest = (branch: string, remote: string): DeliveryResult => ({
  pushStatus: "SUCCEEDED",
  pushRemote: remote,
  pushedBranch: branch,
  deliveryInstructions: `Branch '${branch}' was pushed. This step does not open a pull request.`,
});

/** The agent exited successfully but left the branch at its starting commit. */
const noChangesProduced = (branch: string, remote: string): DeliveryResult => {
  const reason = `no-changes-produced: the session ended cleanly without committing any change on ${branch}`;
  const error = new Error(reason);
  return {
    pushStatus: "FAILED",
    pushRemote: remote,
    pushError: reason,
    deliveryInstructions: reason,
    failureClass: "NO_CHANGES_PRODUCED",
    failure: { operation: "workspace head comparison", message: reason, error },
  };
};

/** A GitHub delivery failure after the branch was published. */
const failedPullRequestDelivery = (
  branch: string,
  remote: string,
  operation: string,
  error: unknown,
  reason: string,
  instructions: string,
): DeliveryResult => ({
  pushStatus: "FAILED",
  pushRemote: remote,
  pushedBranch: branch,
  pushError: reason,
  deliveryInstructions: instructions,
  failureClass: failureClassFor(reason),
  failure: { operation, message: reason, error },
});

/**
 * Classify a failed `gh pr create` for the confirmed-write loop.
 *
 * This asks the shared question — did the write's response get lost? — with the
 * shared predicates, so the runner, the merge executor and the API answer it
 * identically. It is deliberately NOT `isTransientNetworkError`: that predicate
 * answers a different question ("may I retry this command?") about a different
 * input (raw CLI stderr, including adapters.ts's "preflight timed out" for a
 * broken binary), and its narrower table would classify a bare `EOF` as a
 * refusal — which the loop then declines to resend even after a read-back has
 * proved nothing landed.
 *
 * Our own kill-at-the-deadline is a lost response by construction: the process
 * was killed, so its answer is gone, but the request may well have been
 * delivered. It is recognised by type, never by its wording.
 *
 * Anything neither lost nor a recognised refusal is treated as a refusal, which
 * is the safe direction: it is read back like everything else, and only the
 * resend is withheld.
 */
const classifyCreateFailure = (error: unknown, reason: string): { status: "lost" | "refused"; reason: string } => {
  if (isDeterministicRefusal(error)) return { status: "refused", reason };
  if (isCommandTimeout(error) || isLostResponse(error)) return { status: "lost", reason };
  return { status: "refused", reason };
};

/** `gh pr create` answers with the URL of what it made. */
const pullRequestFromUrl = (stdout: string): { url: string; number: number } | null => {
  const match = stdout.trim().match(/^(https:\/\/\S*\/pull\/(\d+))\s*$/mu);
  const url = match?.[1];
  const number = Number(match?.[2]);
  return url && Number.isInteger(number) && number > 0 ? { url, number } : null;
};

const PR_IMPLEMENTATION_KIND = "implementation";
const PR_REVIEW_FINDINGS_KIND = "review-findings";
const PR_LEGACY_REVIEW_FINDINGS_KIND = "sol-findings";
const PR_BLIND_FINDINGS_KIND = "blind-findings";
const PR_FIXED_IMPLEMENTATION_KIND = "fixed-implementation";

type PrImplementationArtifact = {
  headSha: string;
  baseSha: string;
  summary: string;
  testsRun: string[];
};

type PrReviewFinding = {
  id: string;
  severity: string;
  title: string;
};

type PrReviewArtifact = {
  headSha: string;
  reviewedBase: string;
  reviewedHead: string;
  findings: PrReviewFinding[];
};

type PrFixedArtifact = {
  headSha: string;
  sourceHead: string;
  dispositions: Array<{ id: string; disposition: string; reason: string }>;
  closedFindings: Array<{ id: string; status: string; codeEvidence: string; testEvidence: string }>;
  testsRun: string[];
  residualRisks: string[];
};

const canonicalPrTemplateIdentity = (claim: DeliveryClaim) => (
  canonicalTemplateIdentity(claim.task.templateStep?.taskTemplate.name ?? "")
);

const canonicalPrTemplateName = (claim: DeliveryClaim): boolean => (
  canonicalPrTemplateIdentity(claim)?.canonicalName === PR_TEMPLATE_NAME
);

const canonicalPrOutputKind = (claim: DeliveryClaim): string | null => (
  canonicalPrTemplateName(claim) ? claim.task.templateStep?.outputKind ?? null : null
);

const isCanonicalPrImplementation = (claim: DeliveryClaim): boolean => (
  canonicalPrOutputKind(claim) === PR_IMPLEMENTATION_KIND
);

const isCanonicalPrFinal = (claim: DeliveryClaim): boolean => (
  canonicalPrOutputKind(claim) === PR_FIXED_IMPLEMENTATION_KIND
);

/** The handoff entry is already selected by the control plane. Preserve its
 * exact review output kind so both current and immutable legacy Chains remain
 * readable, while rejecting unrelated kinds at this seam. */
const canonicalPrReviewKind = (output: PrHandoffOutput | undefined): PrHandoffKind | null => {
  if (!output) return null;
  return output.kind === PR_REVIEW_FINDINGS_KIND || output.kind === PR_LEGACY_REVIEW_FINDINGS_KIND
    ? output.kind
    : null;
};

const BRIEF_HEADER_PREFIX = "\n<!-- agentos:task-brief:v1 length=";
const BRIEF_HEADER_SUFFIX = " -->\n";
const BRIEF_FOOTER = "\n<!-- /agentos:task-brief:v1 -->";

/** The task description contains the canonical step prompt followed by the
 * operator-authored brief. The pull request goal belongs to the latter. */
const taskGoal = (claim: DeliveryClaim): string => {
  const description = claim.task.description;
  if (typeof description !== "string") throw new Error("canonical PR workflow task description is unavailable");
  const headerStart = description.indexOf(BRIEF_HEADER_PREFIX);
  if (headerStart < 0) throw new Error("canonical PR workflow task brief fence is missing");
  const lengthStart = headerStart + BRIEF_HEADER_PREFIX.length;
  const headerEnd = description.indexOf(BRIEF_HEADER_SUFFIX, lengthStart);
  const encodedLength = headerEnd < 0 ? "" : description.slice(lengthStart, headerEnd);
  if (!/^\d+$/u.test(encodedLength)) throw new Error("canonical PR workflow task brief fence is malformed");
  const briefLength = Number(encodedLength);
  if (!Number.isSafeInteger(briefLength)) throw new Error("canonical PR workflow task brief length is unsafe");
  const briefStart = headerEnd + BRIEF_HEADER_SUFFIX.length;
  const briefEnd = briefStart + briefLength;
  if (description.slice(briefEnd, briefEnd + BRIEF_FOOTER.length) !== BRIEF_FOOTER) {
    throw new Error("canonical PR workflow task brief fence does not match its declared length");
  }
  return description.slice(briefStart, briefEnd).split(/\r?\n/u)[0] ?? "";
};

/**
 * Read one canonical artifact out of the decided handoff. Its shape, order and
 * Task binding were decided by the control plane; what is checked here is the
 * body: valid JSON that satisfies the kind's canonical schema.
 */
const parsePrOutput = <T>(
  output: PrHandoffOutput | undefined,
  expectedKind: PrHandoffKind,
): T => {
  if (!output || output.kind !== expectedKind) {
    throw new Error(`missing required ${expectedKind} canonical output evidence`);
  }
  let value: unknown;
  try {
    value = JSON.parse(output.body);
  } catch {
    throw new Error(`${expectedKind} canonical output body is not valid JSON`);
  }
  const schema = canonicalOutputSchema({ outputKind: expectedKind, taskTemplate: { name: PR_TEMPLATE_NAME } });
  if (!schema || !schema.safeParse(value).success) {
    throw new Error(`${expectedKind} canonical output body violates its schema`);
  }
  return value as T;
};

const validatePrReviewHandoff = (
  implementation: PrImplementationArtifact,
  implementationOutput: PrHandoffOutput,
  review: PrReviewArtifact,
  reviewOutput: PrHandoffOutput,
  blind: PrReviewArtifact,
  blindOutput: PrHandoffOutput,
  fixed: PrFixedArtifact,
  fixedOutput: PrHandoffOutput,
): void => {
  if (implementationOutput.commitSha !== implementation.headSha
    || reviewOutput.commitSha !== review.headSha
    || blindOutput.commitSha !== blind.headSha
    || fixedOutput.commitSha !== fixed.headSha) {
    throw new Error("canonical PR output commit SHA does not match its body headSha");
  }
  // Review bases come from platform Run records; the implementation body base is informational.
  if (review.headSha !== blind.headSha
    || implementation.headSha !== review.headSha
    || review.reviewedHead !== review.headSha
    || blind.reviewedHead !== blind.headSha
    || fixed.sourceHead !== review.headSha
    || review.reviewedBase !== blind.reviewedBase) {
    throw new Error("canonical PR review outputs do not describe one reviewed head and base");
  }
  const findings = [...review.findings, ...blind.findings];
  const findingIds = findings.map(({ id }) => id);
  if (new Set(findingIds).size !== findingIds.length) {
    throw new Error("canonical PR review outputs contain duplicate finding ids");
  }
  const dispositionIds = fixed.dispositions.map(({ id }) => id);
  if (new Set(dispositionIds).size !== dispositionIds.length
    || dispositionIds.length !== findingIds.length
    || dispositionIds.some((id) => !findingIds.includes(id))) {
    throw new Error("fixed-implementation dispositions do not account for every review finding");
  }
  const adoptedIds = fixed.dispositions.filter(({ disposition }) => disposition === "ADOPTED").map(({ id }) => id);
  const closedIds = fixed.closedFindings.map(({ id }) => id);
  if (new Set(closedIds).size !== closedIds.length
    || adoptedIds.length !== closedIds.length
    || adoptedIds.some((id) => !closedIds.includes(id))) {
    throw new Error("fixed-implementation closedFindings do not match adopted review fixes");
  }
};

const markdownTests = (testsRun: readonly string[]): string => testsRun.length > 0
  ? testsRun.map((entry) => `- ${entry}`).join("\n")
  : "No commands reported in the task output.";

const initialPullRequestBody = (
  claim: DeliveryClaim,
  implementation: PrImplementationArtifact,
): string => {
  const goal = taskGoal(claim);
  if (!claim.task.chainId) throw new Error("canonical PR workflow requires a non-null chain identity");
  return [
    "## Goal",
    goal,
    "## Summary",
    implementation.summary,
    "## Verification",
    markdownTests(implementation.testsRun),
    "## Review outcomes",
    "Not available at this step.",
    "## Anneal",
    `Task: ${claim.task.id}`,
    `Chain: ${claim.task.chainId}`,
  ].join("\n\n");
};

const finalPullRequestBody = (
  claim: DeliveryClaim,
  implementation: PrImplementationArtifact,
  review: PrReviewArtifact,
  blind: PrReviewArtifact,
  fixed: PrFixedArtifact,
): string => {
  const goal = taskGoal(claim);
  if (!claim.task.chainId) throw new Error("canonical PR workflow requires a non-null chain identity");
  const adoptedFixes = fixed.closedFindings;
  const summary = [
    implementation.summary,
    adoptedFixes.length === 0
      ? "No review-driven code change was required."
      : [
        "Review-driven fixes:",
        ...adoptedFixes.map((finding) => `- ${finding.id}: ${finding.codeEvidence}`),
      ].join("\n"),
  ].join("\n\n");
  const renderReview = (label: string, report: PrReviewArtifact): string => {
    const dispositions = new Map(fixed.dispositions.map((item) => [item.id, item]));
    const closed = new Map(fixed.closedFindings.map((item) => [item.id, item]));
    const findings = report.findings.length === 0
      ? "No findings reported."
      : report.findings.map((finding) => {
        const disposition = dispositions.get(finding.id);
        const evidence = closed.get(finding.id);
        return [
          `- ${finding.id} [${finding.severity}] ${finding.title}`,
          `  Disposition: ${disposition?.disposition ?? "UNACCOUNTED"}`,
          `  Reason: ${disposition?.reason ?? "No final disposition was reported."}`,
          ...(evidence ? [
            `  Code evidence: ${evidence.codeEvidence}`,
            `  Test evidence: ${evidence.testEvidence}`,
          ] : []),
        ].join("\n");
      }).join("\n");
    return `### ${label}\n${findings}`;
  };
  const residualRisks = fixed.residualRisks.length > 0
    ? fixed.residualRisks.map((risk) => `- ${risk}`).join("\n")
    : "None reported.";
  return [
    "## Goal",
    goal,
    "## Summary",
    summary,
    "## Verification",
    `Implementation:\n${markdownTests(implementation.testsRun)}\n\nFixed implementation:\n${markdownTests(fixed.testsRun)}`,
    "## Review outcomes",
    `${renderReview("Code review findings", review)}\n\n${renderReview("Blind findings", blind)}\n\nResidual risks:\n${residualRisks}`,
    "## Anneal",
    `Task: ${claim.task.id}`,
    `Chain: ${claim.task.chainId}`,
  ].join("\n\n");
};

const readPullRequestBody = (stdout: string): string => {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error("gh pr view returned malformed body JSON"); }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { body?: unknown }).body !== "string") {
      throw new Error("gh pr view returned no readable pull request body");
    }
    return (parsed as { body: string }).body;
  }
  return stdout.replace(/\r?\n$/u, "");
};

// A chain step is named "<chain>: <step>"; the PR is the chain's, not the step's.
export const pullRequestTitle = (
  task: Pick<ClaimedTask["task"], "name" | "templateStep">,
): string => {
  const step = task.templateStep?.name;
  const suffix = step ? `: ${step}` : null;
  return suffix && task.name.endsWith(suffix) && task.name.length > suffix.length
    ? task.name.slice(0, -suffix.length)
    : task.name;
};

export const deliverWorkspace = async (
  config: RunnerConfig,
  claim: DeliveryClaim,
  workspace: Workspace,
  dependencies: DeliverWorkspaceDependencies = {},
): Promise<DeliveryResult> => {
  const command = dependencies.command
    ?? bindCommandRunner(config.runAsPrefix, workspace.path, workspaceEnvironment(config));
  const recordPublication = dependencies.recordPublication ?? (async () => undefined);
  const retryOptions = dependencies.retryOptions ?? {};
  const remote = claim.repo.remoteUrl;
  const canonicalImplementation = isCanonicalPrImplementation(claim);
  const canonicalFinal = isCanonicalPrFinal(claim);
  const canonicalPr = canonicalImplementation || canonicalFinal;
  let canonicalBody: string | undefined;
  const canonicalOutputs = dependencies.prWorkflowOutputs;
  let implementationArtifact: PrImplementationArtifact | undefined;
  let reviewArtifact: PrReviewArtifact | undefined;
  let blindArtifact: PrReviewArtifact | undefined;
  let fixedArtifact: PrFixedArtifact | undefined;

  // Canonical PR delivery is deliberately evidence-driven. Validate the
  // projected bodies before any publication command so a missing, foreign, or
  // malformed output cannot turn into an ordinary branch push.
  if (canonicalPr) {
    try {
      implementationArtifact = parsePrOutput<PrImplementationArtifact>(canonicalOutputs?.[0], PR_IMPLEMENTATION_KIND);
      if (canonicalFinal) {
        const reviewOutput = canonicalOutputs?.[1];
        const reviewKind = canonicalPrReviewKind(reviewOutput);
        if (!reviewKind) throw new Error("missing required review-findings canonical output evidence");
        reviewArtifact = parsePrOutput<PrReviewArtifact>(reviewOutput, reviewKind);
        blindArtifact = parsePrOutput<PrReviewArtifact>(canonicalOutputs?.[2], PR_BLIND_FINDINGS_KIND);
        fixedArtifact = parsePrOutput<PrFixedArtifact>(canonicalOutputs?.[3], PR_FIXED_IMPLEMENTATION_KIND);
        validatePrReviewHandoff(
          implementationArtifact,
          canonicalOutputs![0]!,
          reviewArtifact,
          canonicalOutputs![1]!,
          blindArtifact,
          canonicalOutputs![2]!,
          fixedArtifact,
          canonicalOutputs![3]!,
        );
        canonicalBody = finalPullRequestBody(claim, implementationArtifact, reviewArtifact, blindArtifact, fixedArtifact);
      } else {
        canonicalBody = initialPullRequestBody(claim, implementationArtifact);
      }
    } catch (error: unknown) {
      const message = messageOf(error);
      return {
        pushStatus: "FAILED",
        pushRemote: remote,
        pushError: message,
        failureClass: failureClassFor(message),
        failure: { operation: "canonical PR output validation", message, error },
      };
    }
  }
  // `!== false`, not a truthiness test, and the difference is the whole point.
  // ClaimedTask requires the field, while this interface keeps it optional so
  // a stale API build that omits it degrades to today's behaviour (open the PR)
  // instead of to the expensive failure (never open one again, silently). Read
  // from `run`, not `task`: the run carries the snapshot taken when it was
  // created, so an operator's PATCH cannot change a run that is already queued.
  // This ordinary delivery decision remains run-snapshot driven; the exact
  // canonical template/output-kind checks above govern only PR handover.
  const opensPullRequest = claim.run.opensPullRequest !== false;
  // Missing means required for compatibility with an older API claim. The
  // explicit false belongs to the immutable Run snapshot, never to a Step-name
  // or output-kind exception in the runner.
  const requiresCommit = claim.run.requiresCommit !== false;
  // A clean provider exit is not sufficient delivery evidence when this Run's
  // contract requires a commit. Optional-commit Runs still publish the shared
  // branch below so later Chain Steps have a durable remote ref.
  try {
    const head = dependencies.headSha ?? await command("git", ["rev-parse", "HEAD"],
      { timeoutMs: boundedTimeout(retryOptions, WORKSPACE_HEAD_TIMEOUT_MS) });
    if (canonicalPr) {
      const currentOutput = canonicalOutputs?.at(-1);
      const currentArtifact = canonicalFinal ? fixedArtifact : implementationArtifact;
      if (!currentOutput || !currentArtifact || currentOutput.commitSha !== head || currentArtifact.headSha !== head) {
        const reason = `${canonicalPrOutputKind(claim)} canonical output does not match current workspace HEAD`;
        const error = new Error(reason);
        return {
          pushStatus: "FAILED",
          pushRemote: remote,
          pushError: reason,
          failureClass: failureClassFor(reason),
          failure: { operation: "canonical PR output/head comparison", message: reason, error },
        };
      }
    }
    // A canonical PR output is durable evidence for a retry after the same
    // head was already published. Such a retry must be able to repair the PR
    // body without inventing a second commit; ordinary required-commit Runs
    // retain the no-change refusal.
    if (head === workspace.baseSha && requiresCommit && !canonicalFinal) {
      return noChangesProduced(workspace.branch, remote);
    }
  } catch (error: unknown) {
    const message = messageOf(error);
    return {
      pushStatus: "FAILED",
      pushRemote: remote,
      pushError: message,
      failureClass: failureClassFor(message),
      failure: { operation: "git rev-parse HEAD", message, error },
    };
  }
  if (canonicalFinal) {
    try {
      const trackedChain = await command("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ".chain"],
        { timeoutMs: boundedTimeout(retryOptions, WORKSPACE_HEAD_TIMEOUT_MS) });
      if (trackedChain.trim().length > 0) {
        const reason = "canonical PR final delivery requires a clean tracked .chain tree";
        const error = new Error(`${reason}: ${trackedChain.trim()}`);
        return {
          pushStatus: "FAILED",
          pushRemote: remote,
          pushError: error.message,
          failureClass: failureClassFor(error.message),
          failure: { operation: "git ls-tree HEAD -- .chain", message: error.message, error },
        };
      }
    } catch (error: unknown) {
      const message = messageOf(error);
      return {
        pushStatus: "FAILED",
        pushRemote: remote,
        pushError: message,
        failureClass: failureClassFor(message),
        failure: { operation: "git ls-tree HEAD -- .chain", message, error },
      };
    }
  }
  // A step that opens no PR still publishes its changed branch, which is what
  // lets the *next* step of the chain clone it.
  try {
    await runWithNetworkRetry("git", ["push"],
      ({ timeoutMs }) => command("git", ["push", "--set-upstream", "origin", workspace.branch], { timeoutMs }),
      retryOptions,
    );
  } catch (error: unknown) {
    const message = messageOf(error);
    return {
      pushStatus: "FAILED",
      pushRemote: remote,
      pushError: message,
      // Still computed, still sent — but as the runner's advisory first guess.
      // The API classifies from `failure` below.
      failureClass: failureClassFor(message),
      failure: { operation: "git push", message, error },
    };
  }
  // This API write intentionally sits immediately after git push and before
  // any GitHub lookup, cleanup, or terminal completion. It closes the large
  // post-push loss window; provisionWorkspace's remote-head check covers the
  // irreducible crash between these two network operations. A transient ACK
  // failure does not turn a successful push into a failed push: completion is
  // a second persistence opportunity and remote reconciliation is the final
  // source of truth.
  await recordPublication(workspace.branch).catch(() => undefined);
  const repo = githubRepo(remote);
  if (!repo) {
    if (canonicalFinal) {
      const reason = "canonical PR final delivery requires a GitHub remote";
      const error = new Error(reason);
      return failedPullRequestDelivery(
        workspace.branch,
        remote,
        "GitHub remote validation",
        error,
        reason,
        `Branch '${workspace.branch}' was pushed, but the final pull request could not be updated because the remote is not hosted on GitHub.`,
      );
    }
    return opensPullRequest
      ? manual(workspace.branch, remote, "Remote is not hosted on GitHub.")
      : noPullRequest(workspace.branch, remote);
  }
  try {
    // Capped against the same phase deadline as everything else here: this is
    // the one command in delivery that is not on the retry allowlist, and a
    // hung `gh` would otherwise stall the phase before the budget applies.
    await command("gh", ["--version"], { timeoutMs: boundedTimeout(retryOptions, GH_PROBE_TIMEOUT_MS) });
  } catch (error: unknown) {
    if (!opensPullRequest && !canonicalFinal) return noPullRequest(workspace.branch, remote);
    const reason = messageOf(error);
    return failedPullRequestDelivery(
      workspace.branch,
      remote,
      "gh --version",
      error,
      reason,
      `The gh CLI is unavailable. Branch '${workspace.branch}' was pushed, but pull request delivery failed: ${reason}.`,
    );
  }
  // Only an *open* PR on this head may be reused: a merged or closed one would
  // silently swallow the push. One open PR per head branch is a GitHub invariant,
  // so a chain sharing a branch keeps exactly one human-facing PR.
  // This lookup is also the read-back for `gh pr create` below, which is what
  // makes creation idempotent: the open PR on this head IS the key. `inherited`
  // carries the enclosing phase deadline when it runs in that role, because a
  // nested loop that opened its own budget could double the operation's worst
  // case behind the back of the timing contract in network-retry.ts.
  const openPullRequest = async (inherited: AttemptBudget = {}): Promise<{ url: string; number: number } | null> => {
    const args = [
      "pr", "list", "--repo", repo, "--head", workspace.branch, "--state", "open", "--limit", "1", "--json", "url,number",
    ];
    const raw = await runWithNetworkRetry("gh", args,
      ({ timeoutMs }) => command("gh", args, { timeoutMs }),
      { ...retryOptions, ...(inherited.deadline === undefined ? {} : { deadline: inherited.deadline }) },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || "[]");
    } catch (error: unknown) {
      throw new Error(`gh pr list returned malformed JSON: ${messageOf(error)}`, { cause: error });
    }
    if (!Array.isArray(parsed)) throw new Error("gh pr list returned a non-array response");
    const first = parsed[0];
    if (first === undefined) return null;
    if (!first || typeof first !== "object" || Array.isArray(first)
      || typeof (first as { url?: unknown }).url !== "string"
      || (first as { url: string }).url.trim().length === 0
      || !Number.isInteger((first as { number?: unknown }).number)
      || (first as { number: number }).number <= 0) {
      throw new Error("gh pr list returned a malformed open pull request");
    }
    return {
      url: (first as { url: string }).url,
      number: (first as { number: number }).number,
    };
  };
  const editPullRequestBody = async (
    pullRequest: { url: string; number: number },
    body: string,
  ): Promise<void> => {
    const editArguments = [
      "pr", "edit", String(pullRequest.number), "--repo", repo, "--body", body,
    ];
    await command("gh", editArguments, { timeoutMs: boundedTimeout(retryOptions, NETWORK_COMMAND_TIMEOUT_MS) });
    const readArguments = [
      "pr", "view", String(pullRequest.number), "--repo", repo, "--json", "body", "--jq", ".body",
    ];
    let readBack: string;
    try {
      readBack = readPullRequestBody(await command("gh", readArguments,
        { timeoutMs: boundedTimeout(retryOptions, NETWORK_COMMAND_TIMEOUT_MS) }));
    } catch (error: unknown) {
      throw new Error(`pull request body read-back was unreadable: ${messageOf(error)}`, { cause: error });
    }
    if (readBack !== body) throw new Error("pull request body read-back did not match the canonical body");
  };
  try {
    // The lookup runs before the flag check on purpose: a documentation step
    // running after the implementation step still reports the chain's PR on its
    // gate card and in GET /tasks/:id. Only *creation* is suppressed.
    const existing = await openPullRequest();
    if (existing) {
      if (canonicalPr) {
        try {
          await editPullRequestBody(existing, canonicalBody!);
        } catch (error: unknown) {
          const reason = messageOf(error);
          return failedPullRequestDelivery(
            workspace.branch,
            remote,
            reason.includes("read-back") ? "gh pr view" : "gh pr edit",
            error,
            reason,
            `Branch '${workspace.branch}' was pushed, but updating the pull request body failed: ${reason}.`,
          );
        }
      }
      return { pushStatus: "SUCCEEDED", pushRemote: remote, pushedBranch: workspace.branch, pullRequestUrl: existing.url, pullRequestNumber: existing.number };
    }
    if (canonicalFinal) {
      const reason = "canonical PR final delivery found no open pull request";
      const error = new Error(reason);
      return failedPullRequestDelivery(
        workspace.branch,
        remote,
        "gh pr list",
        error,
        reason,
        `Branch '${workspace.branch}' was pushed, but no open pull request was found for the final handover.`,
      );
    }
    if (!opensPullRequest && !canonicalFinal) return noPullRequest(workspace.branch, remote);
    const createArguments = [
      "pr", "create", "--repo", repo,
      "--base", claim.run.pullRequestBase ?? claim.repo.defaultBranch,
      "--head", workspace.branch,
      "--title", pullRequestTitle(claim.task),
      "--body", canonicalBody ?? `Automated delivery for Anneal task ${claim.task.id}.`,
    ];
    // The one creating GitHub write this package makes, and the reason #139
    // exists. A create response can be lost after GitHub has committed the PR,
    // so the error is never the verdict: the open PR on this head is the
    // idempotency key, and confirmedWrite reads it back after every failed send
    // and resends only when that read positively found nothing. A read-back
    // that cannot be completed ends the loop as `indeterminate` — which is what
    // this call site used to get wrong, because a probe that threw on a flaky
    // link looked like a transient failure of the *create* and earned it
    // another send.
    let lastCreateError: unknown;
    let lastReadBackError: unknown;
    const creation = await confirmedWrite<{ url: string; number: number } | null>({
      resend: "after-confirmed-absent",
      attempts: NETWORK_ATTEMPTS,
      wait: retryOptions.wait ?? transientBackoff,
      // The same judgment the retry loop makes about itself: the first send may
      // spend the last of the budget, because publishing the run's work is
      // worth the one documented overrun; a resend may not, because a send that
      // cannot finish inside the deadline buys nothing and costs the lease.
      canSend: (attemptNumber) => budgetRemains(
        retryOptions,
        attemptNumber === 1 ? 1 : MIN_ATTEMPT_TIMEOUT_MS + KILL_OVERHEAD_MS,
      ),
      attempt: async () => {
        try {
          const stdout = await command("gh", createArguments,
            { timeoutMs: boundedTimeout(retryOptions, NETWORK_COMMAND_TIMEOUT_MS) });
          // `gh pr create` prints the URL of the pull request it made. Taking
          // the identity from the write's own answer is what removes the
          // read-after-write step entirely — and with it the case where a
          // confirmed-successful create was followed by a failed lookup and the
          // operator was told to go and create another one.
          return { status: "applied", value: pullRequestFromUrl(stdout) };
        } catch (createError: unknown) {
          lastCreateError = createError;
          const reason = createError instanceof Error ? createError.message : String(createError);
          // Both classifications are read back before anything is decided; the
          // split only decides whether a *resend* may follow a confirmed absence.
          return classifyCreateFailure(createError, reason);
        }
      },
      readBack: async () => {
        try {
          // The enclosing phase deadline is inherited rather than reopened: a
          // probe with its own budget would double the operation's worst case
          // behind the back of the timing contract in network-retry.ts.
          const found = await openPullRequest(
            retryOptions.deadline === undefined ? {} : { deadline: retryOptions.deadline },
          );
          return found ? { status: "applied", value: found } : { status: "absent" };
        } catch (probeError: unknown) {
          lastReadBackError = probeError;
          return { status: "unreadable", reason: probeError instanceof Error ? probeError.message : String(probeError) };
        }
      },
    });
    if (creation.status !== "applied") {
      let error = lastCreateError ?? new Error(creation.reason);
      if (creation.status === "indeterminate") {
        error = lastReadBackError ?? error;
        if (isCommandTimeout(lastCreateError) && !isCommandTimeout(lastReadBackError)) error = lastCreateError;
      }
      const instructions = creation.status === "indeterminate"
        ? `Branch '${workspace.branch}' was pushed, but PR creation failed without a verdict: ${creation.reason}. A pull request may already have been created — check the head branch before retrying.`
        : `Branch '${workspace.branch}' was pushed, but PR creation failed: ${creation.reason}.`;
      return failedPullRequestDelivery(
        workspace.branch,
        remote,
        "gh pr create",
        error,
        creation.reason,
        instructions,
      );
    }
    if (creation.value) {
      // Either `gh pr create` named it on stdout, or the read-back found it —
      // our own lost create having landed, or a concurrent human or runner
      // having opened it first. Either way it is the PR.
      return {
        pushStatus: "SUCCEEDED",
        pushRemote: remote,
        pushedBranch: workspace.branch,
        pullRequestUrl: creation.value.url,
        pullRequestNumber: creation.value.number,
      };
    }
    // The create succeeded but did not name the pull request — an older `gh`,
    // or output we could not parse. One lookup gets the identity.
    try {
      const created = await openPullRequest();
      const missingPullRequest = "gh pr create succeeded without returning a pull request URL, and no open pull request was found";
      return created
        ? { pushStatus: "SUCCEEDED", pushRemote: remote, pushedBranch: workspace.branch, pullRequestUrl: created.url, pullRequestNumber: created.number }
        : failedPullRequestDelivery(
          workspace.branch,
          remote,
          "gh pr create",
          new Error(missingPullRequest),
          missingPullRequest,
          `Branch '${workspace.branch}' was pushed, but PR creation returned no URL and no open pull request was found.`,
        );
    } catch (lookupError: unknown) {
      // The write is CONFIRMED applied and only its name is missing. Falling
      // through to a manual-create advisory would risk a duplicate, because
      // the write is known to have created a pull request. The run fails so its
      // identity can be recorded by a retry, while the lookup error remains on
      // the delivery result for the completion envelope.
      const reason = messageOf(lookupError);
      return failedPullRequestDelivery(
        workspace.branch,
        remote,
        "gh pr list",
        lookupError,
        reason,
        `Branch '${workspace.branch}' was pushed and a pull request was created for it, but its URL could not be read back: ${reason}. Do not create another — inspect the head branch.`,
      );
    }
  } catch (error: unknown) {
    const message = messageOf(error);
    // The push above already succeeded, so the branch exists on the remote no
    // matter what `gh` did. Report that fact (`pushedBranch`) on both paths, or
    // the chain's next step bases on the default branch and its push of the
    // already-published shared name is rejected non-fast-forward — a wedge no
    // retry clears.
    //
    // For a step that was never meant to open a PR, a failed `gh pr list` is
    // not a delivery failure at all: everything this step owed the chain is
    // already on the remote. Reporting FAILED here would fail a documentation
    // step *after* its push, and the runner marks a delivery failure with a
    // failureClass non-retryable.
    if (!opensPullRequest && !canonicalFinal) return noPullRequest(workspace.branch, remote);
    return failedPullRequestDelivery(
      workspace.branch,
      remote,
      "gh pr list",
      error,
      message,
      `Branch '${workspace.branch}' was pushed, but checking for an open pull request failed: ${message}.`,
    );
  }
};

/**
 * Salvage for a failed run: commit any trackable worktree changes, then push the
 * run branch as WIP so the work survives workspace cleanup. Never opens a PR,
 * and never reports a failureClass — the run already has one from CLI evidence.
 *
 * The ref this pushes is the one the Run owns (`runOwnedHead` in @anneal/db),
 * never `workspace.branch`: a failed run's half-finished tree must never enter
 * the chain's shared branch, which every later step of the chain clones.
 *
 * Note what this function does *not* control: the completion payload still
 * reports `Run.branch` as the workspace branch (runner.ts spreads the workspace
 * result before this one), so a salvaged run still *looks* like a push to the
 * shared branch in that column. `pushedBranch` is the column that tells the
 * truth, and it is the only one @anneal/db's resolveRunBranches trusts. Keep
 * them in sync: whatever ref is handed to `git push` is the ref reported as
 * `pushedBranch`.
 */
export const salvageWorkspace = async (
  config: RunnerConfig,
  identity: { taskId: string; runId: string; runNumber: number; remoteUrl?: string },
  workspace: Workspace,
  dependencies: SalvageWorkspaceDependencies = {},
): Promise<DeliveryResult | null> => {
  const command = dependencies.command
    ?? bindCommandRunner(config.runAsPrefix, workspace.path, workspaceEnvironment(config));
  const retryOptions = dependencies.retryOptions ?? {};
  const remote = identity.remoteUrl ?? "origin";
  const branch = runOwnedHead(identity.taskId, identity.runNumber);
  try {
    // Respect .gitignore while including tracked deletions and untracked files.
    await command("git", ["add", "-A"]);
    const status = await command("git", ["status", "--porcelain"]);
    if (status) {
      await command("git", platformCommitArgs(`WIP salvage for Anneal run ${identity.runId}`));
    }
    const head = await command("git", ["rev-parse", "HEAD"]);
    // A clean run branch that never diverged from its base has nothing to push.
    if (head === workspace.baseSha) return null;
    // `git log` rather than `rev-parse HEAD^`: a root commit has no parent, and
    // reporting no parent must not turn salvage — the last chance this work
    // has of surviving — into a failure.
    const parents = await command("git", ["log", "-1", "--format=%P", "HEAD"]);
    const parent = parents.trim().split(/\s+/u).find((sha) => sha.length > 0);
    // Plain push, never forced: the run branch is unique per (task, run), so a
    // rejection means something else is there and salvaging must not clobber it.
    await runWithNetworkRetry("git", ["push"],
      ({ timeoutMs }) => command("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { timeoutMs }),
      retryOptions,
    );
    return {
      pushStatus: "SUCCEEDED",
      pushRemote: remote,
      pushedBranch: branch,
      headSha: head,
      ...(parent ? { salvageParentSha: parent } : {}),
      deliveryInstructions: `Run failed; its commits were pushed to '${branch}' as work in progress. No pull request was opened.`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { pushStatus: "FAILED", pushRemote: remote, pushError: `WIP salvage failed: ${message}` };
  }
};
