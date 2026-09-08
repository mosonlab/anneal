import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  LEGACY_TEMPLATE_GENERATIONS, PR_TEMPLATE_NAME, templateRolloverName,
  type PrHandoffOutput,
} from "@anneal/db";

import type { ExitEvidence } from "./adapters.js";
import type { RunnerConfig } from "./config.js";
import {
  deliverWorkspace, pullRequestTitle, salvageWorkspace,
  type DeliveryClaim,
} from "./delivery.js";
import { completionEnvelope } from "./envelope.js";
import { CommandTimeoutError, KILL_OVERHEAD_MS, type CommandRunner } from "./exec.js";
import {
  deliveryDeadline, NETWORK_COMMAND_TIMEOUT_MS, WORKSPACE_HEAD_TIMEOUT_MS,
} from "./network-retry.js";

const testHome = await mkdtemp(join(tmpdir(), "delivery-test-home-"));
after(() => rm(testHome, { recursive: true, force: true }));
const config = { runAsPrefix: [], path: "/fake/bin", home: testHome } as unknown as RunnerConfig;
const claim = {
  task: { id: "task-1", name: "Feature", templateStep: null },
  repo: { remoteUrl: "https://github.com/acme/app.git", defaultBranch: "main" },
  run: {},
} satisfies DeliveryClaim;
const salvageIdentity = {
  taskId: "task-1",
  runId: "run-2",
  runNumber: 2,
  remoteUrl: "https://github.com/acme/app.git",
};
const workspace = { path: "/fake/work", branch: "feature/test", baseSha: "base" };

const canonicalSha = (character: string): string => character.repeat(40);
const canonicalBaseSha = canonicalSha("a");
const canonicalImplementationSha = canonicalSha("b");
const canonicalFixedSha = canonicalSha("c");
const legacyPrTemplateName = templateRolloverName(PR_TEMPLATE_NAME, "model-neutral-review-step-names", "delivery-test");
const canonicalDescription = (
  brief = "Ship PR\nThe complete feature brief continues here.",
  prompt = "Canonical template step prompt that must not become the PR goal.",
): string => `${prompt}\n<!-- agentos:task-brief:v1 length=${String(brief.length)} -->\n${brief}\n<!-- /agentos:task-brief:v1 -->`;

const canonicalClaim = (
  outputKind: "implementation" | "fixed-implementation",
  id: string,
  chainIndex: number,
  templateName = PR_TEMPLATE_NAME,
): DeliveryClaim => ({
  task: {
    id,
    name: outputKind === "implementation" ? "Ship PR: Implementation" : "Ship PR: Apply review fixes",
    description: canonicalDescription(),
    chainId: "chain-pr",
    chainIndex,
    templateStep: {
      name: outputKind === "implementation" ? "Implementation" : "Apply review fixes",
      outputKind,
      taskTemplate: { name: templateName },
    } as unknown as DeliveryClaim["task"]["templateStep"],
  },
  repo: { remoteUrl: "https://github.com/acme/app.git", defaultBranch: "main" },
  run: { opensPullRequest: outputKind === "implementation", requiresCommit: outputKind === "implementation" },
});

const canonicalImplementationOutput = (
  headSha = canonicalImplementationSha,
  baseSha = canonicalBaseSha,
  testsRun = ["npm test -- runner — exit 0: all focused tests passed"],
): {
  taskId: string;
  chainIndex: number;
  kind: "implementation";
  body: string;
  commitSha: string;
} => ({
  taskId: "task-implementation",
  chainIndex: 1,
  kind: "implementation",
  body: JSON.stringify({
    schemaVersion: 1,
    headSha,
    baseSha,
    summary: "Implemented the requested change.",
    testsRun,
  }),
  commitSha: headSha,
});

const canonicalFinalOutputs = (
  baseSha = canonicalBaseSha,
  implementationSha = canonicalImplementationSha,
  fixedSha = canonicalFixedSha,
  reviewKind: PrHandoffOutput["kind"] = "review-findings",
): PrHandoffOutput[] => [
  canonicalImplementationOutput(implementationSha, baseSha),
  {
    taskId: "task-review",
    chainIndex: 2,
    kind: reviewKind,
    body: JSON.stringify({
      schemaVersion: 1,
      headSha: implementationSha,
      reviewedBase: baseSha,
      reviewedHead: implementationSha,
      findings: [{
        id: "SOL-1",
        severity: "P1",
        file: "src/change.ts",
        line: 12,
        title: "Close the handover gap",
        evidence: "The old path drops evidence.",
        requiredFix: "Carry the persisted body.",
      }],
      commandsRun: ["npm test -- review — exit 0: review passed"],
    }),
    commitSha: implementationSha,
  },
  {
    taskId: "task-blind",
    chainIndex: 3,
    kind: "blind-findings" as const,
    body: JSON.stringify({
      schemaVersion: 1,
      headSha: implementationSha,
      reviewedBase: baseSha,
      reviewedHead: implementationSha,
      findings: [],
    }),
    commitSha: implementationSha,
  },
  {
    taskId: "task-fixed",
    chainIndex: 4,
    kind: "fixed-implementation" as const,
    body: JSON.stringify({
      schemaVersion: 1,
      headSha: fixedSha,
      sourceHead: implementationSha,
      dispositions: [{ id: "SOL-1", disposition: "ADOPTED", reason: "The runner now carries the persisted evidence." }],
      closedFindings: [{
        id: "SOL-1",
        status: "CLOSED",
        codeEvidence: "Added the run-bound evidence projection.",
        testEvidence: "Added route and delivery coverage.",
      }],
      testsRun: ["npm test -- final — exit 0: final handover passed"],
      residualRisks: ["GitHub API availability remains external."],
    }),
    commitSha: fixedSha,
  },
];

test("canonical PR implementation creates the deterministic initial handover body", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    if (executable === "gh" && args[1] === "list") return "[]";
    if (executable === "gh" && args[1] === "create") return "https://github.com/acme/app/pull/1\n";
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("implementation", "task-implementation", 1),
    { ...workspace, baseSha: canonicalBaseSha },
    { command: fake, headSha: canonicalImplementationSha, prWorkflowOutputs: [canonicalImplementationOutput()] },
  );
  assert.equal(result.pushStatus, "SUCCEEDED");
  const create = calls.find(({ executable, args }) => executable === "gh" && args[1] === "create");
  assert.ok(create);
  const expectedBody = [
    "## Goal",
    "Ship PR",
    "## Summary",
    "Implemented the requested change.",
    "## Verification",
    "- npm test -- runner — exit 0: all focused tests passed",
    "## Review outcomes",
    "Not available at this step.",
    "## Anneal",
    "Task: task-implementation",
    "Chain: chain-pr",
  ].join("\n\n");
  assert.deepEqual(create.args, [
    "pr", "create", "--repo", "acme/app", "--base", "main", "--head", "feature/test",
    "--title", "Ship PR", "--body", expectedBody,
  ]);
});

test("canonical PR implementation edits an existing PR and reads back the initial body", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  let body = "";
  const fake: CommandRunner = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/2", number: 2 }]);
    if (executable === "gh" && args[1] === "edit") { body = args.at(-1)!; return ""; }
    if (executable === "gh" && args[1] === "view") return body;
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("implementation", "task-implementation", 1),
    { ...workspace, baseSha: canonicalBaseSha },
    { command: fake, headSha: canonicalImplementationSha, prWorkflowOutputs: [canonicalImplementationOutput()] },
  );
  assert.equal(result.pullRequestNumber, 2);
  const edit = calls.find(({ executable, args }) => executable === "gh" && args[1] === "edit");
  assert.ok(edit);
  const expectedBody = [
    "## Goal", "Ship PR",
    "## Summary", "Implemented the requested change.",
    "## Verification", "- npm test -- runner — exit 0: all focused tests passed",
    "## Review outcomes", "Not available at this step.",
    "## Anneal", "Task: task-implementation", "Chain: chain-pr",
  ].join("\n\n");
  assert.deepEqual(edit.args, ["pr", "edit", "2", "--repo", "acme/app", "--body", expectedBody]);
  assert.equal(body, expectedBody);
  const view = calls.find(({ executable, args }) => executable === "gh" && args[1] === "view");
  assert.ok(view);
});

test("canonical PR final delivery publishes a clean head and the complete review handover body", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  let body = "";
  const fake: CommandRunner = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    if (executable === "git" && args[0] === "ls-tree") return "";
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/3", number: 3 }]);
    if (executable === "gh" && args[1] === "edit") { body = args.at(-1)!; return ""; }
    if (executable === "gh" && args[1] === "view") return body;
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: canonicalFinalOutputs() },
  );
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.equal(result.pullRequestNumber, 3);
  assert.deepEqual(calls.filter(({ executable }) => executable === "git").map(({ args }) => args), [
    ["ls-tree", "-r", "--name-only", "HEAD", "--", ".chain"],
    ["push", "--set-upstream", "origin", "feature/test"],
  ]);
  const expectedBody = [
    "## Goal",
    "Ship PR",
    "## Summary",
    "Implemented the requested change.\n\nReview-driven fixes:\n- SOL-1: Added the run-bound evidence projection.",
    "## Verification",
    "Implementation:\n- npm test -- runner — exit 0: all focused tests passed\n\nFixed implementation:\n- npm test -- final — exit 0: final handover passed",
    "## Review outcomes",
    "### Code review findings\n- SOL-1 [P1] Close the handover gap\n  Disposition: ADOPTED\n  Reason: The runner now carries the persisted evidence.\n  Code evidence: Added the run-bound evidence projection.\n  Test evidence: Added route and delivery coverage.\n\n### Blind findings\nNo findings reported.\n\nResidual risks:\n- GitHub API availability remains external.",
    "## Anneal",
    "Task: task-fixed",
    "Chain: chain-pr",
  ].join("\n\n");
  assert.equal(body, expectedBody);
  const edit = calls.find(({ executable, args }) => executable === "gh" && args[1] === "edit");
  assert.ok(edit);
  assert.equal(edit.args.at(-1), expectedBody);
});

test("canonical PR final delivery refuses a retired review output kind before publication", async () => {
  const retiredReviewKind = LEGACY_TEMPLATE_GENERATIONS[PR_TEMPLATE_NAME]
    .flatMap(({ shape }) => shape)
    .find(({ name }) => name === "Code review")?.outputKind;
  assert.ok(retiredReviewKind);
  assert.notEqual(retiredReviewKind, "review-findings");
  const outputs = canonicalFinalOutputs();
  outputs[1] = { ...outputs[1]!, kind: retiredReviewKind as unknown as PrHandoffOutput["kind"] };
  const calls: string[] = [];
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    {
      command: async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; },
      headSha: canonicalFixedSha,
      prWorkflowOutputs: outputs,
    },
  );
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "canonical PR output validation");
  assert.match(result.pushError ?? "", /missing required review-findings canonical output evidence/u);
  assert.deepEqual(calls, []);
});

test("legacy canonical PR final delivery accepts review-findings and preserves the handoff kind", async () => {
  let body = "";
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "ls-tree") return "";
    if (executable === "gh" && args[1] === "list") {
      return JSON.stringify([{ url: "https://github.com/acme/app/pull/10", number: 10 }]);
    }
    if (executable === "gh" && args[1] === "edit") { body = args.at(-1)!; return ""; }
    if (executable === "gh" && args[1] === "view") return body;
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed-legacy-neutral", 4, legacyPrTemplateName),
    { ...workspace, baseSha: canonicalImplementationSha },
    {
      command: fake,
      headSha: canonicalFixedSha,
      prWorkflowOutputs: canonicalFinalOutputs(canonicalBaseSha, canonicalImplementationSha, canonicalFixedSha, "review-findings"),
    },
  );
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.match(body, /### Code review findings/u);
  assert.doesNotMatch(body, /Sol findings/u);
});

test("canonical PR final delivery rejects a missing exact review report before publication", async () => {
  const outputs = canonicalFinalOutputs();
  outputs.splice(1, 1);
  const calls: string[] = [];
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    {
      command: async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; },
      headSha: canonicalFixedSha,
      prWorkflowOutputs: outputs,
    },
  );
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "canonical PR output validation");
  assert.deepEqual(calls, []);
});

test("canonical PR final delivery rejects duplicate finding ids across review reports", async () => {
  const outputs = canonicalFinalOutputs();
  const blind = JSON.parse(outputs[2]!.body) as Record<string, unknown>;
  blind.findings = [{
    id: "SOL-1",
    severity: "P1",
    file: "src/change.ts",
    line: 12,
    title: "Close the handover gap",
    evidence: "The old path drops evidence.",
    requiredFix: "Carry the persisted body.",
  }];
  outputs[2] = { ...outputs[2]!, body: JSON.stringify(blind) };
  const calls: string[] = [];
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    {
      command: async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; },
      headSha: canonicalFixedSha,
      prWorkflowOutputs: outputs,
    },
  );
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "canonical PR output validation");
  assert.deepEqual(calls, []);
});

test("canonical PR final delivery ignores the informational implementation base during publication", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  let body = "";
  const fake: CommandRunner = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    if (executable === "git" && args[0] === "ls-tree") return "";
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/3", number: 3 }]);
    if (executable === "gh" && args[1] === "edit") { body = args.at(-1)!; return ""; }
    if (executable === "gh" && args[1] === "view") return body;
    return "";
  };
  const outputs = canonicalFinalOutputs();
  outputs[0] = canonicalImplementationOutput(canonicalImplementationSha, canonicalSha("d"));
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: outputs },
  );
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.equal(result.pullRequestNumber, 3);
  assert.deepEqual(calls.filter(({ executable }) => executable === "git").map(({ args }) => args), [
    ["ls-tree", "-r", "--name-only", "HEAD", "--", ".chain"],
    ["push", "--set-upstream", "origin", "feature/test"],
  ]);
  const expectedBody = [
    "## Goal",
    "Ship PR",
    "## Summary",
    "Implemented the requested change.\n\nReview-driven fixes:\n- SOL-1: Added the run-bound evidence projection.",
    "## Verification",
    "Implementation:\n- npm test -- runner — exit 0: all focused tests passed\n\nFixed implementation:\n- npm test -- final — exit 0: final handover passed",
    "## Review outcomes",
    "### Code review findings\n- SOL-1 [P1] Close the handover gap\n  Disposition: ADOPTED\n  Reason: The runner now carries the persisted evidence.\n  Code evidence: Added the run-bound evidence projection.\n  Test evidence: Added route and delivery coverage.\n\n### Blind findings\nNo findings reported.\n\nResidual risks:\n- GitHub API availability remains external.",
    "## Anneal",
    "Task: task-fixed",
    "Chain: chain-pr",
  ].join("\n\n");
  assert.equal(body, expectedBody);
  const edit = calls.find(({ executable, args }) => executable === "gh" && args[1] === "edit");
  assert.ok(edit);
  assert.equal(edit.args.at(-1), expectedBody);
});

test("canonical PR final body states when reviews required no code change", async () => {
  const outputs = canonicalFinalOutputs();
  const review = JSON.parse(outputs[1]!.body) as Record<string, unknown>;
  review.findings = [];
  outputs[1] = { ...outputs[1]!, body: JSON.stringify(review) };
  const fixed = JSON.parse(outputs[3]!.body) as Record<string, unknown>;
  fixed.dispositions = [];
  fixed.closedFindings = [];
  outputs[3] = { ...outputs[3]!, body: JSON.stringify(fixed) };
  let body = "";
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "ls-tree") return "";
    if (executable === "gh" && args[1] === "list") {
      return JSON.stringify([{ url: "https://github.com/acme/app/pull/8", number: 8 }]);
    }
    if (executable === "gh" && args[1] === "edit") { body = args.at(-1)!; return ""; }
    if (executable === "gh" && args[1] === "view") return body;
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: outputs },
  );
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.match(body, /Implemented the requested change\.\n\nNo review-driven code change was required\./u);
});

test("canonical PR final delivery rejects retained chain bookkeeping before push", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "git" && args[0] === "ls-tree") return ".chain/fix/pr-workflow/spec.md\n";
    throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: canonicalFinalOutputs() },
  );
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "git ls-tree HEAD -- .chain");
  assert.deepEqual(calls, ["git ls-tree -r --name-only HEAD -- .chain"]);
});

test("canonical PR final delivery allows an already-pushed clean retry without a new commit", async () => {
  const calls: string[] = [];
  let body = "";
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "git" && args[0] === "ls-tree") return "";
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/4", number: 4 }]);
    if (executable === "gh" && args[1] === "edit") { body = args.at(-1)!; return ""; }
    if (executable === "gh" && args[1] === "view") return body;
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalFixedSha },
    { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: canonicalFinalOutputs() },
  );
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.ok(calls.includes("git push --set-upstream origin feature/test"));
  assert.equal(calls.some((call) => call.includes("commit") || call.includes("reset") || call.includes("rebase") || call.includes("force")), false);
  assert.match(body, /## Review outcomes/u);
});

test("canonical PR implementation refuses an unchanged required-commit head before publication", async () => {
  const calls: string[] = [];
  const result = await deliverWorkspace(
    config,
    canonicalClaim("implementation", "task-implementation", 1),
    { ...workspace, baseSha: canonicalImplementationSha },
    {
      command: async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; },
      headSha: canonicalImplementationSha,
      prWorkflowOutputs: [canonicalImplementationOutput()],
    },
  );
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "workspace head comparison");
  assert.deepEqual(calls, []);
});

test("canonical PR implementation reports an empty command list factually", async () => {
  let body = "";
  const output = canonicalImplementationOutput(canonicalImplementationSha, canonicalBaseSha, []);
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") return "[]";
    if (executable === "gh" && args[1] === "create") { body = args.at(-1)!; return "https://github.com/acme/app/pull/5\n"; }
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("implementation", "task-implementation", 1),
    { ...workspace, baseSha: canonicalBaseSha },
    { command: fake, headSha: canonicalImplementationSha, prWorkflowOutputs: [output] },
  );
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.match(body, /## Verification\n\nNo commands reported in the task output\./u);
});

for (const failure of [
  { name: "edit failure", operation: "gh pr edit", edit: new Error("edit refused"), view: "" },
  { name: "unreadable read-back", operation: "gh pr view", edit: null, view: new Error("view unavailable") },
  { name: "unequal read-back", operation: "gh pr view", edit: null, view: "stale body" },
] as const) {
  test(`canonical PR final delivery fails on ${failure.name}`, async () => {
    const fake: CommandRunner = async (executable, args) => {
      if (executable === "git" && args[0] === "ls-tree") return "";
      if (executable === "gh" && args[1] === "list") {
        return JSON.stringify([{ url: "https://github.com/acme/app/pull/6", number: 6 }]);
      }
      if (executable === "gh" && args[1] === "edit") {
        if (failure.edit) throw failure.edit;
        return "";
      }
      if (executable === "gh" && args[1] === "view") {
        if (failure.view instanceof Error) throw failure.view;
        return failure.view;
      }
      return "";
    };
    const result = await deliverWorkspace(
      config,
      canonicalClaim("fixed-implementation", "task-fixed", 4),
      { ...workspace, baseSha: canonicalImplementationSha },
      { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: canonicalFinalOutputs() },
    );
    assert.equal(result.pushStatus, "FAILED");
    assert.equal(result.failure?.operation, failure.operation);
    assert.equal(result.pushedBranch, workspace.branch);
  });
}

test("canonical PR final delivery fails when no open pull request exists", async () => {
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "ls-tree") return "";
    if (executable === "gh" && args[1] === "list") return "[]";
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: canonicalFinalOutputs() },
  );
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "gh pr list");
  assert.equal(result.pushedBranch, workspace.branch);
});

test("canonical PR final delivery fails when open-PR lookup is malformed", async () => {
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "ls-tree") return "";
    if (executable === "gh" && args[1] === "list") return "not-json";
    return "";
  };
  const result = await deliverWorkspace(
    config,
    canonicalClaim("fixed-implementation", "task-fixed", 4),
    { ...workspace, baseSha: canonicalImplementationSha },
    { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: canonicalFinalOutputs() },
  );
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "gh pr list");
  assert.equal(result.pushedBranch, workspace.branch);
});

test("canonical PR final delivery fails for a non-GitHub remote after publishing", async () => {
  const finalClaim = canonicalClaim("fixed-implementation", "task-fixed", 4);
  finalClaim.repo.remoteUrl = "ssh://git.example.test/acme/app.git";
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "ls-tree") return "";
    return "";
  };
  const result = await deliverWorkspace(
    config,
    finalClaim,
    { ...workspace, baseSha: canonicalImplementationSha },
    { command: fake, headSha: canonicalFixedSha, prWorkflowOutputs: canonicalFinalOutputs() },
  );
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "GitHub remote validation");
  assert.equal(result.pushedBranch, workspace.branch);
});

// The shape, order and Task binding of the handoff are the control plane's
// decision (`decidePrHandoff`); what delivery still refuses on its own is a
// canonical PR delivery reached without one, or with a body that does not
// satisfy its kind's schema.
for (const missing of [
  { name: "no handoff at all", outputs: undefined },
  { name: "a handoff missing its final artifact", outputs: canonicalFinalOutputs().slice(0, 3) },
  { name: "a body that violates its canonical schema", outputs: canonicalFinalOutputs().map((output, index) => (
    index === 3 ? { ...output, body: JSON.stringify({ schemaVersion: 1 }) } : output
  )) },
] as const) {
  test(`canonical PR final delivery with ${missing.name} is refused before git or gh`, async () => {
    const calls: string[] = [];
    const result = await deliverWorkspace(
      config,
      canonicalClaim("fixed-implementation", "task-fixed", 4),
      { ...workspace, baseSha: canonicalImplementationSha },
      {
        command: async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; },
        headSha: canonicalFixedSha,
        ...(missing.outputs ? { prWorkflowOutputs: missing.outputs } : {}),
      },
    );
    assert.equal(result.pushStatus, "FAILED");
    assert.equal(result.failure?.operation, "canonical PR output validation");
    assert.deepEqual(calls, []);
  });
}

test("canonical PR final output and completion head mismatches are refused before publication", async () => {
  for (const candidate of [
    {
      name: "output commit mismatch",
      headSha: canonicalFixedSha,
      outputs: canonicalFinalOutputs().map((output, index) => index === 3
        ? { ...output, commitSha: canonicalSha("d") }
        : output),
      operation: "canonical PR output validation",
    },
    {
      name: "completion head mismatch",
      headSha: canonicalSha("d"),
      outputs: canonicalFinalOutputs(),
      operation: "canonical PR output/head comparison",
    },
  ]) {
    const calls: string[] = [];
    const result = await deliverWorkspace(
      config,
      canonicalClaim("fixed-implementation", "task-fixed", 4),
      { ...workspace, baseSha: canonicalImplementationSha },
      {
        command: async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; },
        headSha: candidate.headSha,
        prWorkflowOutputs: candidate.outputs,
      },
    );
    assert.equal(result.pushStatus, "FAILED", candidate.name);
    assert.equal(result.failure?.operation, candidate.operation, candidate.name);
    assert.deepEqual(calls, [], candidate.name);
  }
});

for (const templateName of ["direct-engineer-workflow", "compound-engineer-workflow", "custom-pr-workflow"] as const) {
  test(`${templateName} keeps ordinary delivery behavior despite a canonical-looking output kind`, async () => {
    const calls: string[] = [];
    const ordinaryClaim: DeliveryClaim = {
      task: {
        id: "ordinary-task",
        name: "Ordinary step",
        templateStep: {
          name: "Apply review fixes",
          outputKind: "fixed-implementation",
          taskTemplate: { name: templateName },
        } as unknown as DeliveryClaim["task"]["templateStep"],
      },
      repo: { remoteUrl: "ssh://git.example.test/acme/app.git", defaultBranch: "main" },
      run: { opensPullRequest: false, requiresCommit: false },
    };
    const result = await deliverWorkspace(config, ordinaryClaim, workspace, {
      command: async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; },
      headSha: workspace.baseSha,
    });
    assert.equal(result.pushStatus, "SUCCEEDED");
    assert.equal(result.failure, undefined);
    assert.deepEqual(calls, ["git push --set-upstream origin feature/test"]);
  });
}

test("canonical PR final delivery pushes the exact descendant cleanup commit from a real repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "anneal-pr-delivery-"));
  try {
    const remote = join(root, "remote.git");
    const repository = join(root, "work");
    execFileSync("git", ["init", "--bare", remote]);
    await mkdir(repository);
    execFileSync("git", ["init", "-b", "feature/test"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Anneal Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "anneal@example.test"], { cwd: repository });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repository });
    await writeFile(join(repository, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repository });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    await mkdir(join(repository, ".chain", "feature"), { recursive: true });
    await writeFile(join(repository, ".chain", "feature", "spec.md"), "review evidence\n");
    execFileSync("git", ["add", ".chain/feature/spec.md"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "implementation"], { cwd: repository });
    const implementationSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const calls: string[] = [];
    let body = "";
    const command: CommandRunner = async (executable, args) => {
      calls.push(`${executable} ${args.join(" ")}`);
      if (executable === "gh" && args[1] === "list") {
        return JSON.stringify([{ url: "https://github.com/acme/app/pull/7", number: 7 }]);
      }
      if (executable === "gh" && args[1] === "edit") { body = args.at(-1)!; return ""; }
      if (executable === "gh" && args[1] === "view") return body;
      if (executable === "gh") return "gh version fixture";
      return execFileSync(executable, [...args], {
        cwd: repository,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      });
    };
    await rm(join(repository, ".chain"), { recursive: true });
    execFileSync("git", ["add", "-A", ".chain"], { cwd: repository });
    const stagedDeletion = await deliverWorkspace(
      config,
      canonicalClaim("fixed-implementation", "task-fixed", 4),
      { path: repository, branch: "feature/test", baseSha },
      {
        command,
        headSha: implementationSha,
        prWorkflowOutputs: canonicalFinalOutputs(baseSha, implementationSha, implementationSha),
      },
    );
    assert.equal(stagedDeletion.pushStatus, "FAILED");
    assert.equal(stagedDeletion.failure?.operation, "git ls-tree HEAD -- .chain");
    assert.equal(calls.some((call) => call.startsWith("git push") || call.startsWith("gh ")), false);
    calls.length = 0;
    execFileSync("git", ["commit", "-m", "remove chain bookkeeping"], { cwd: repository });
    const fixedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const result = await deliverWorkspace(
      config,
      canonicalClaim("fixed-implementation", "task-fixed", 4),
      { path: repository, branch: "feature/test", baseSha: implementationSha },
      { command, headSha: fixedSha, prWorkflowOutputs: canonicalFinalOutputs(baseSha, implementationSha, fixedSha) },
    );
    assert.equal(result.pushStatus, "SUCCEEDED", result.pushError);
    execFileSync("git", ["merge-base", "--is-ancestor", implementationSha, fixedSha], { cwd: repository });
    assert.equal(execFileSync("git", ["rev-parse", "refs/remotes/origin/feature/test"], { cwd: repository, encoding: "utf8" }).trim(), fixedSha);
    assert.equal(execFileSync("git", ["ls-tree", "-r", "--name-only", fixedSha, "--", ".chain"], { cwd: repository, encoding: "utf8" }).trim(), "");
    assert.equal(calls.some((call) => /(?:--force|\bcommit\b|\breset\b|\brebase\b)/u.test(call)), false);
    const commitCount = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    calls.length = 0;
    const retry = await deliverWorkspace(
      config,
      canonicalClaim("fixed-implementation", "task-fixed", 4),
      { path: repository, branch: "feature/test", baseSha: fixedSha },
      { command, headSha: fixedSha, prWorkflowOutputs: canonicalFinalOutputs(baseSha, implementationSha, fixedSha) },
    );
    assert.equal(retry.pushStatus, "SUCCEEDED", retry.pushError);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), fixedSha);
    assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), commitCount);
    assert.equal(calls.some((call) => /(?:--force|\bcommit\b|\breset\b|\brebase\b)/u.test(call)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing requiresCommit defaults to required and fails before publication", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, headSha: workspace.baseSha });
  const reason = "no-changes-produced: the session ended cleanly without committing any change on feature/test";
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failureClass, "NO_CHANGES_PRODUCED");
  assert.equal(result.pushError, reason);
  assert.equal(result.deliveryInstructions, reason);
  assert.equal(result.pushedBranch, undefined);
  assert.equal(result.failure?.operation, "workspace head comparison");
  assert.equal(result.failure?.message, reason);
  assert.ok(result.failure?.error instanceof Error);
  assert.deepEqual(calls, []);
});

test("a workspace-head read failure is reported without any remote operation", async () => {
  const calls: string[] = [];
  const headError = new Error("fatal: not a git repository");
  const fake: CommandRunner = async (executable, args, options) => {
    calls.push(`${executable} ${args.join(" ")}`);
    assert.equal(options?.timeoutMs, WORKSPACE_HEAD_TIMEOUT_MS);
    throw headError;
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake });
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failureClass, "TOOL_FAILED");
  assert.equal(result.failure?.operation, "git rev-parse HEAD");
  assert.equal(result.failure?.error, headError);
  assert.deepEqual(calls, ["git rev-parse HEAD"]);
});

test("a clean no-PR session with no commit also fails before publication", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return executable === "git" && args[0] === "rev-parse" ? workspace.baseSha : "";
  };
  const result = await deliverWorkspace(config, {
    ...claim,
    run: { ...claim.run, opensPullRequest: false },
  }, workspace, { command: fake });
  assert.equal(result.pushStatus, "FAILED");
  assert.match(result.pushError ?? "", /^no-changes-produced:/u);
  assert.deepEqual(calls, ["git rev-parse HEAD"]);
});

test("an unchanged optional-commit step still publishes its branch", async () => {
  const calls: string[] = [];
  const publications: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return "";
  };
  const result = await deliverWorkspace(config, {
    ...claim,
    repo: { ...claim.repo, remoteUrl: "ssh://git@example.test/acme/app.git" },
    run: { ...claim.run, opensPullRequest: false, requiresCommit: false },
  }, workspace, {
    command: fake,
    headSha: workspace.baseSha,
    recordPublication: async (branch) => { publications.push(branch); },
  });
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.equal(result.pushedBranch, workspace.branch);
  assert.equal(result.failureClass, undefined);
  assert.deepEqual(calls, ["git push --set-upstream origin feature/test"]);
  assert.deepEqual(publications, [workspace.branch]);
});

test("a session with a captured commit keeps the existing push and pull-request path", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "list") {
      return JSON.stringify([{ url: "https://github.com/acme/app/pull/7", number: 7 }]);
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, headSha: "new-head" });
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.equal(result.pullRequestNumber, 7);
  assert.deepEqual(calls.slice(0, 2), [
    "git push --set-upstream origin feature/test",
    "gh --version",
  ]);
});

test("delivery fails loudly with the gh probe error when gh is unavailable", async () => {
  const calls: string[] = [];
  const probeError = new Error("ENOENT");
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh") throw probeError;
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake });
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.pushedBranch, workspace.branch);
  assert.equal(result.failure?.operation, "gh --version");
  assert.equal(result.failure?.error, probeError);
  assert.match(result.deliveryInstructions ?? "", /gh CLI is unavailable/);
  assert.deepEqual(calls, ["git rev-parse HEAD", "git push --set-upstream origin feature/test", "gh --version"]);
});

test("delivery records a pushed branch without invoking gh for a non-GitHub remote", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; };
  const result = await deliverWorkspace(config, {
    ...claim, repo: { ...claim.repo, remoteUrl: "ssh://git@example.test/acme/app.git" },
  }, workspace, { command: fake });
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.equal(result.failure, undefined);
  assert.match(result.deliveryInstructions ?? "", /not hosted on GitHub/);
  assert.deepEqual(calls, ["git rev-parse HEAD", "git push --set-upstream origin feature/test"]);
});

test("a chain step reuses the open pull request on its shared head branch", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/7", number: 7 }]);
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake });
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(calls.some((call) => call.startsWith("gh pr create")), false);
});

test("a failed initial pull-request lookup fails delivery with the lookup error", async () => {
  const lookupError = new Error("gh: API rate limit exceeded");
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") throw lookupError;
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake });
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.pushedBranch, workspace.branch);
  assert.equal(result.failure?.operation, "gh pr list");
  assert.equal(result.failure?.error, lookupError);
  assert.match(result.pushError ?? "", /API rate limit exceeded/);
});

test("delivery opens one pull request titled after the chain, not the step", async () => {
  const calls: string[] = [];
  let created = false;
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "create") { created = true; return ""; }
    if (executable === "gh" && args[1] === "list") {
      return created ? JSON.stringify([{ url: "https://github.com/acme/app/pull/8", number: 8 }]) : "[]";
    }
    return "";
  };
  const chained = {
    ...claim,
    task: { ...claim.task, name: "lines subcommand: Write spec", templateStep: { name: "Write spec", outputKind: "result", provisionDependencies: true, taskTemplate: { name: "spec-workflow" } } },
  } satisfies DeliveryClaim;
  const result = await deliverWorkspace(config, chained, workspace, { command: fake });
  assert.equal(result.pullRequestNumber, 8);
  assert.equal(pullRequestTitle(chained.task), "lines subcommand");
  assert.ok(calls.some((call) => call.includes("--title lines subcommand")));
});

test("a custom chain base is preserved in gh pr create", async () => {
  const calls: string[] = [];
  let created = false;
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "create") created = true;
    if (executable === "gh" && args[1] === "list") {
      return created ? JSON.stringify([{ url: "https://github.com/acme/app/pull/10", number: 10 }]) : "[]";
    }
    return "";
  };
  const custom = { ...claim, run: { ...claim.run, pullRequestBase: "release/1.x" } } satisfies DeliveryClaim;
  const result = await deliverWorkspace(config, custom, workspace, { command: fake });
  assert.equal(result.pullRequestNumber, 10);
  assert.ok(calls.some((call) => call.includes("--base release/1.x")));
});

test("publication is acknowledged immediately after push and before GitHub work", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/7", number: 7 }]);
    return "";
  };
  await deliverWorkspace(config, claim, workspace, {
    command: fake,
    recordPublication: async (branch) => { calls.push(`ack ${branch}`); },
  });
  assert.deepEqual(calls.slice(0, 4), [
    "git rev-parse HEAD",
    "git push --set-upstream origin feature/test",
    "ack feature/test",
    "gh --version",
  ]);
});

test("a pull request created between list and create is confirmed and reused", async () => {
  let listCalls = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") {
      listCalls += 1;
      return listCalls === 1 ? "[]" : JSON.stringify([{ url: "https://github.com/acme/app/pull/7", number: 7 }]);
    }
    if (executable === "gh" && args[1] === "create") throw new Error("a pull request already exists for head");
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake });
  assert.equal(listCalls, 2);
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.equal(result.pullRequestNumber, 7);
});

test("transient push failures succeed on the third attempt", async () => {
  let pushes = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "push") {
      pushes += 1;
      if (pushes < 3) throw new Error("LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443");
    }
    if (executable === "gh" && args[1] === "list") {
      return JSON.stringify([{ url: "https://github.com/acme/app/pull/11", number: 11 }]);
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(pushes, 3);
  assert.equal(result.pushStatus, "SUCCEEDED");
});

test("an unknown push failure retries the same branch ref before GitHub work", async () => {
  const pushArgs: string[][] = [];
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "push") {
      pushArgs.push([...args]);
      if (pushArgs.length < 3) throw new Error("fatal: gnutls_handshake() failed: TLS connection was not properly terminated");
    }
    if (executable === "gh" && args[1] === "list") {
      return JSON.stringify([{ url: "https://github.com/acme/app/pull/13", number: 13 }]);
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, {
    command: fake,
    headSha: "new-head",
    retryOptions: { wait: async () => undefined },
  });
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.deepEqual(pushArgs, [
    ["push", "--set-upstream", "origin", workspace.branch],
    ["push", "--set-upstream", "origin", workspace.branch],
    ["push", "--set-upstream", "origin", workspace.branch],
  ]);
});

test("deterministic authentication failures are not retried", async () => {
  let pushes = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "push") {
      pushes += 1;
      throw new Error("remote: HTTP 403 Forbidden: permission denied");
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(pushes, 1);
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failureClass, "AUTH_REQUIRED");
});

test("an EOF after PR creation is resolved by head lookup without duplicate creation", async () => {
  let listCalls = 0;
  let createCalls = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") {
      listCalls += 1;
      return listCalls === 1 ? "[]" : JSON.stringify([{ url: "https://github.com/acme/app/pull/12", number: 12 }]);
    }
    if (executable === "gh" && args[1] === "create") {
      createCalls += 1;
      throw new Error("Post https://api.github.com/graphql: unexpected EOF");
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(createCalls, 1);
  assert.equal(result.pullRequestNumber, 12);
  assert.equal(result.pushStatus, "SUCCEEDED");
});

test("a read-back that cannot be completed preserves its typed failure and never authorises a second create", async () => {
  // The hole #139 closes. The create response was lost, so the pull request may
  // exist; the confirming lookup then failed too, so we cannot tell. The old
  // loop read that second failure as one more transient error and sent `gh pr
  // create` again — five more times — each send a candidate duplicate PR.
  let createCalls = 0;
  let listCalls = 0;
  const createError = new CommandTimeoutError("gh", ["pr", "create"], 20_000);
  const readBackError = new CommandTimeoutError("gh", ["pr", "list"], 20_000);
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") {
      listCalls += 1;
      if (listCalls === 1) return "[]";
      throw readBackError;
    }
    if (executable === "gh" && args[1] === "create") {
      createCalls += 1;
      throw createError;
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(createCalls, 1, "the create was resent without a read-back that found nothing");
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.pushedBranch, workspace.branch);
  assert.equal(result.pullRequestNumber, undefined);
  assert.equal(result.failure?.operation, "gh pr create");
  assert.equal(result.failure?.error, readBackError);
  assert.equal(completionEnvelope({
    executionSucceeded: true,
    evidence: {
      exitCode: 0,
      signal: null,
      terminalEventSeen: true,
      terminalSuccess: true,
      terminationReason: null,
      finalOutput: "done",
      providerError: null,
      stdout: "implemented",
      stderr: "",
    },
    deliveryFailure: result.failure,
  }).timedOut, true, "the API classification seam must receive the read-back timeout marker");
  // And the operator is told it is ambiguous, not told to go create one.
  assert.match(result.deliveryInstructions ?? "", /may already have been created/);
  assert.doesNotMatch(result.deliveryInstructions ?? "", /Run gh pr create manually/);
});

test("a deterministic create failure is read back once and never resent", async () => {
  // "not a valid base branch" is not a lost response, so resending it can only
  // fail again. It is still read back — the platform saying no is not evidence
  // that no pull request exists — and then reported.
  let createCalls = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") return "[]";
    if (executable === "gh" && args[1] === "create") {
      createCalls += 1;
      throw new Error("GraphQL: Base branch 'nope' was not found");
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(createCalls, 1);
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failure?.operation, "gh pr create");
  assert.match(result.deliveryInstructions ?? "", /PR creation failed/);
});

test("gh names the pull request it made, so a confirmed create needs no lookup at all", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.slice(0, 2).join(" ")}`);
    if (executable === "gh" && args[1] === "list") return "[]";
    if (executable === "gh" && args[1] === "create") {
      return "\nCreating pull request for feature/test into main in acme/app\n\nhttps://github.com/acme/app/pull/42\n";
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(result.pullRequestNumber, 42);
  assert.equal(result.pullRequestUrl, "https://github.com/acme/app/pull/42");
  // One `gh pr list` — the one before creation. The read-after-write is gone,
  // and with it the window where a confirmed create could be reported as a
  // failure.
  assert.equal(calls.filter((call) => call === "gh pr list").length, 1);
});

test("a create that succeeded and a lookup that failed never asks for a second create", async () => {
  // The write is CONFIRMED applied — `gh pr create` exited 0 — and only its
  // name is missing. Telling the operator to run `gh pr create` here is the
  // blind resend this change exists to prevent, issued for the one case where
  // a pull request is known to exist.
  let createCalls = 0;
  let listCalls = 0;
  const lookupError = new Error("Get https://api.github.com/repos/acme/app/pulls: EOF");
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") {
      listCalls += 1;
      if (listCalls === 1) return "[]";
      throw lookupError;
    }
    // An older `gh` that prints nothing we can parse: the create succeeded, but
    // it did not name what it made.
    if (executable === "gh" && args[1] === "create") { createCalls += 1; return ""; }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(createCalls, 1);
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.pushedBranch, workspace.branch);
  assert.equal(result.failure?.operation, "gh pr list");
  assert.equal(result.failure?.error, lookupError);
  assert.match(result.deliveryInstructions ?? "", /a pull request was created for it/);
  assert.match(result.deliveryInstructions ?? "", /Do not create another/);
  assert.doesNotMatch(result.deliveryInstructions ?? "", /Run gh pr create manually/);
});

test("a successful but unnamed create fails when no open pull request can be found", async () => {
  let listCalls = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") {
      listCalls += 1;
      return "[]";
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(listCalls, 2);
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.pushedBranch, workspace.branch);
  assert.equal(result.failure?.operation, "gh pr create");
  assert.match(result.failure?.message ?? "", /no open pull request was found/);
  assert.match(result.deliveryInstructions ?? "", /returned no URL/);
});

test("a bare EOF is a lost response, so a read-back that finds nothing earns exactly one resend", async () => {
  // Not every lost response says "unexpected EOF". The runner used to classify
  // with its own narrower table, which meant `Post ...: EOF` was treated as a
  // refusal and no resend followed even after the read-back proved nothing had
  // landed — the safe direction, but not the one the ticket asks for.
  let createCalls = 0;
  let listCalls = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") {
      listCalls += 1;
      return createCalls >= 2 ? JSON.stringify([{ url: "https://github.com/acme/app/pull/21", number: 21 }]) : "[]";
    }
    if (executable === "gh" && args[1] === "create") {
      createCalls += 1;
      if (createCalls === 1) throw new Error("Post \"https://api.github.com/graphql\": EOF");
      return "https://github.com/acme/app/pull/21";
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(createCalls, 2, "the confirmed absence did not earn a resend");
  assert.equal(result.pullRequestNumber, 21);
  // Sends are gated on read-backs: one before creation, one confirming the loss.
  assert.equal(listCalls, 2);
});

test("a resend is not started with less budget than one attempt needs", async () => {
  // #139 review P2. The first send may spend the last of the phase budget —
  // publishing the work is worth the one documented overrun. A *resend* may
  // not: boundedTimeout would floor it back up to five seconds, so 1ms of
  // remaining budget would buy a five-second command that overruns the lease.
  let clock = 0;
  let createCalls = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" || args[0] === "--version") return "";
    if (args[1] === "list") return "[]";
    createCalls += 1;
    // Leaves 8s of the 35s phase budget — less than MIN_ATTEMPT_TIMEOUT_MS plus
    // the kill overhead once the backoff has been paid.
    clock += 27_000;
    throw new Error("Post https://api.github.com/graphql: unexpected EOF");
  };
  const result = await deliverWorkspace(config, claim, workspace, {
    command: fake,
    retryOptions: {
    deadline: deliveryDeadline(0, 60, 0),
    now: () => clock,
    wait: async () => { clock += 1_000; },
    },
  });
  assert.equal(createCalls, 1);
  assert.equal(result.pushStatus, "FAILED");
  assert.match(result.deliveryInstructions ?? "", /PR creation failed/);
  assert.ok(clock < LEASE_MS, `delivery outlived its lease: ${clock}ms`);
});

test("a pushed branch remains published when PR retries are exhausted, but delivery fails", async () => {
  let createCalls = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") return "[]";
    if (executable === "gh" && args[1] === "create") {
      createCalls += 1;
      throw new Error("HTTP 503 Service Unavailable");
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  assert.equal(createCalls, 6);
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.pushedBranch, workspace.branch);
  assert.equal(result.failureClass, "TOOL_FAILED");
  assert.equal(result.failure?.operation, "gh pr create");
  assert.match(result.deliveryInstructions ?? "", /PR creation failed/);
});

test("git's Author identity error stays a tool failure after push retries", async () => {
  let pushes = 0;
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "push") {
      pushes += 1;
      throw new Error("Author identity unknown\n*** Please tell me who you are.\nfatal: unable to auto-detect email address");
    }
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, { command: fake, retryOptions: { wait: async () => undefined } });
  // It is a deterministic local configuration problem, but it is not an
  // access refusal. Push retries are veto based, so it exhausts the existing
  // bounded budget while preserving the tool-failure classification.
  assert.equal(pushes, 6);
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.failureClass, "TOOL_FAILED");
});

test("a failed run commits uncommitted changes, pushes them as WIP, and opens no pull request", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "git" && args[0] === "status") return "M tracked.ts\n?? new.ts";
    if (executable === "git" && args[0] === "log") return "reviewed-head-sha\n";
    return executable === "git" && args[0] === "rev-parse" ? "salvage-sha" : "";
  };
  const result = await salvageWorkspace(config, salvageIdentity, workspace, { command: fake });
  assert.equal(result?.pushStatus, "SUCCEEDED");
  assert.equal(result?.headSha, "salvage-sha");
  // The next Run of this task starts on the salvage commit. Naming its parent
  // here is what lets that Run tell a resumable salvage from a stray head.
  assert.equal(result?.salvageParentSha, "reviewed-head-sha");
  assert.equal(result?.failureClass, undefined);
  assert.equal(result?.pullRequestUrl, undefined);
  assert.deepEqual(calls, [
    "git add -A",
    "git status --porcelain",
    "git -c user.name=Anneal Runner -c user.email=runner@agentos.local -c commit.gpgSign=false -c core.hooksPath=/dev/null commit --no-verify -m WIP salvage for Anneal run run-2",
    "git rev-parse HEAD",
    "git log -1 --format=%P HEAD",
    "git push origin HEAD:refs/heads/agentos/task-1/run-2",
  ]);
  assert.equal(calls.some((call) => call.includes("--force")), false);
  assert.equal(calls.some((call) => call.startsWith("gh ")), false);
});

test("a failed run with no new commit is not pushed at all", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return executable === "git" && args[0] === "rev-parse" ? workspace.baseSha : "";
  };
  assert.equal(await salvageWorkspace(config, salvageIdentity, workspace, { command: fake }), null);
  assert.deepEqual(calls, ["git add -A", "git status --porcelain", "git rev-parse HEAD"]);
});

test("a failed run still pushes commits the agent made before crashing", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return executable === "git" && args[0] === "rev-parse" ? "agent-commit-sha" : "";
  };
  const result = await salvageWorkspace(config, salvageIdentity, workspace, { command: fake });
  assert.equal(result?.headSha, "agent-commit-sha");
  assert.equal(result?.salvageParentSha, undefined, "a root salvage commit reports no parent rather than failing");
  assert.equal(calls.some((call) => call.includes(" commit ")), false);
  assert.equal(calls.at(-1), "git push origin HEAD:refs/heads/agentos/task-1/run-2");
});

// --- one branch and one PR per chain -----------------------------------------
//
// The `claim` fixture omits `opensPullRequest` and `requiresCommit` entirely, so
// the tests above pin both compatibility defaults for a stale API build: open
// the pull request, and fail an unchanged Run unless it explicitly opts out.

const noPrClaim = { ...claim, run: { ...claim.run, opensPullRequest: false } } satisfies DeliveryClaim;

test("a step that does not open pull requests still pushes its branch", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "list") return "[]";
    return "";
  };
  const result = await deliverWorkspace(config, noPrClaim, workspace, { command: fake });
  assert.equal(result.pushStatus, "SUCCEEDED");
  // The push is what the *next* step of the chain clones, so it is unconditional.
  assert.ok(calls.includes("git push --set-upstream origin feature/test"));
  assert.ok(calls.some((call) => call.startsWith("gh pr list")));
  assert.equal(calls.some((call) => call.startsWith("gh pr create")), false);
});

test("a step that does not open pull requests says so instead of failing", async () => {
  const fake: CommandRunner = async (executable, args) => (executable === "gh" && args[1] === "list" ? "[]" : "");
  const result = await deliverWorkspace(config, noPrClaim, workspace, { command: fake });
  assert.equal(result.pullRequestUrl, undefined);
  assert.match(result.deliveryInstructions ?? "", /Branch 'feature\/test' was pushed/);
  assert.match(result.deliveryInstructions ?? "", /does not open a pull request/);
});

test("a late documentation step reports the chain's existing pull request", async () => {
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/7", number: 7 }]);
    return "";
  };
  const result = await deliverWorkspace(config, noPrClaim, workspace, { command: fake });
  // The lookup is deliberately kept ahead of the flag check: a documentation
  // step running after the implementation step still shows the chain's PR.
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(calls.some((call) => call.startsWith("gh pr create")), false);
});

test("no gh and no pull request by design reads as design, not as a degraded path", async () => {
  const fake: CommandRunner = async (executable) => { if (executable === "gh") throw new Error("ENOENT"); return ""; };
  const result = await deliverWorkspace(config, noPrClaim, workspace, { command: fake });
  assert.match(result.deliveryInstructions ?? "", /does not open a pull request/);
  assert.doesNotMatch(result.deliveryInstructions ?? "", /manually/);
});

test("a failed pull-request lookup does not fail a step that opens no pull request", async () => {
  // Everything this step owed the chain is already on the remote, so a `gh pr
  // list` error is not a delivery failure. Reporting FAILED here would fail a
  // documentation step *after* its push, and a delivery failure carrying a
  // failureClass is marked non-retryable — one rate-limited lookup would wedge
  // the step permanently.
  const fake: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") throw new Error("gh: API rate limit exceeded");
    return "";
  };
  const result = await deliverWorkspace(config, noPrClaim, workspace, { command: fake });
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.equal(result.failureClass, undefined);
  assert.match(result.deliveryInstructions ?? "", /does not open a pull request/);
});

test("the ref that was actually pushed is recorded on every path that pushed", async () => {
  // `pushedBranch` is the only publication evidence the control plane trusts,
  // because `branch` and `pushStatus` each lie in one direction:
  //   (b) below is the direction where the branch IS published but the run is
  //       recorded FAILED — the next chain step would base on the default branch
  //       and be rejected non-fast-forward;
  //   (d) below is the direction where a salvage push SUCCEEDED against a
  //       per-run branch while `branch` still reads the shared one — the next
  //       chain step would clone a ref nobody created.
  const created: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/9", number: 9 }]);
    return "";
  };
  assert.equal((await deliverWorkspace(config, claim, workspace, { command: created })).pushedBranch, "feature/test");

  const prFails: CommandRunner = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") return "[]";
    if (executable === "gh" && args[1] === "create") throw new Error("gh: API rate limit exceeded");
    return "";
  };
  // These command doubles test publication evidence, not backoff wall time.
  // Keep the real retry policy/attempts; advance through its waits immediately.
  const retryOptions = { wait: async () => undefined };
  const failed = await deliverWorkspace(config, claim, workspace, { command: prFails, retryOptions });
  assert.equal(failed.pushStatus, "FAILED");
  assert.equal(failed.pushedBranch, "feature/test");

  const pushFails: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "push") throw new Error("remote rejected");
    return "";
  };
  assert.equal((await deliverWorkspace(config, claim, workspace, { command: pushFails, retryOptions })).pushedBranch, undefined);

  const salvage: CommandRunner = async (executable, args) => {
    if (executable === "git" && args[0] === "status") return "M tracked.ts";
    return executable === "git" && args[0] === "rev-parse" ? "salvage-sha" : "";
  };
  const salvaged = await salvageWorkspace(config, salvageIdentity, workspace, { command: salvage });
  assert.equal(salvaged?.pushedBranch, "agentos/task-1/run-2");
  assert.notEqual(salvaged?.pushedBranch, workspace.branch);
});

// The delivery phase is what the 60s lease actually squeezes, so these tests
// measure from t=0 = the heartbeat runner.ts sends when the agent exits, and
// assert against the lease rather than against any single operation's budget.
const LEASE_MS = 60_000;

test("a hung push is timed out and reported as a transient failure, not a lease-eating stall", async () => {
  let clock = 0;
  const timeouts: Array<number | undefined> = [];
  const fake: CommandRunner = async (executable, args, options) => {
    if (executable === "git" && args[0] === "rev-parse") return "changed-head";
    timeouts.push(options?.timeoutMs);
    clock += (options?.timeoutMs ?? 0) + KILL_OVERHEAD_MS;
    throw new CommandTimeoutError("git", ["push"], options?.timeoutMs ?? 0);
  };
  const result = await deliverWorkspace(config, claim, workspace, {
    command: fake,
    retryOptions: {
    deadline: deliveryDeadline(0, 60, 0),
    now: () => clock,
    wait: async () => { clock += 1_000; },
    },
  });
  assert.equal(result.pushStatus, "FAILED");
  assert.match(result.pushError ?? "", /timed out after/);
  // A timeout is a network symptom, not a credentials problem: misclassifying
  // it as AUTH_REQUIRED would make the run non-retryable.
  assert.equal(result.failureClass, "TOOL_FAILED");
  assert.ok(timeouts.length > 1, "a hung push must be retried, not given up on after one ceiling");
  assert.ok(timeouts.every((timeoutMs) => timeoutMs !== undefined && timeoutMs <= NETWORK_COMMAND_TIMEOUT_MS));
  assert.ok(clock < LEASE_MS, `delivery outlived its lease: ${clock}ms`);
});

/**
 * The production chain, end to end on the runner's side: a real `git push` that
 * hangs, through the real retry budget, into the real envelope builder.
 *
 * Every other test of this feature injects a shape by hand — a
 * `CommandTimeoutError` straight into the builder, or a `timedOut: true` into a
 * completion body. Those prove the pieces and not the seam, and the seam is
 * where it broke: delivery caught the typed error and kept only
 * `error.message`, so by the time an envelope was built the type was gone and a
 * hung push arrived at the control plane looking like an ordinary failed task.
 *
 * The envelope asserted here is the one a runner actually sends. The API's half
 * of the chain continues in packages/api/src/execution.test.ts and
 * packages/api/src/failure-envelope.dbtest.ts, both of which consume this exact
 * object — keep the three in step.
 */
test("a hung push arrives at the API as a typed timeout, not as a failed task", async () => {
  let clock = 0;
  const fake: CommandRunner = async (executable, args, options) => {
    if (executable === "git" && args[0] === "rev-parse") return "changed-head";
    clock += (options?.timeoutMs ?? 0) + KILL_OVERHEAD_MS;
    throw new CommandTimeoutError("git", ["push"], options?.timeoutMs ?? 0);
  };
  const delivery = await deliverWorkspace(config, claim, workspace, {
    command: fake,
    retryOptions: {
    deadline: deliveryDeadline(0, 60, 0),
    now: () => clock,
    wait: async () => { clock += 1_000; },
    },
  });
  assert.equal(delivery.pushStatus, "FAILED");
  assert.ok(delivery.failure, "delivery must keep its failure structured, not only as a message");
  assert.ok(delivery.failure.error instanceof CommandTimeoutError, "and must keep the error by reference, with its type");

  // The agent itself finished, and its stdout is full of the vocabulary that
  // used to get runs misclassified. Only the push failed.
  const evidence: ExitEvidence = {
    exitCode: 0,
    signal: null,
    terminalEventSeen: true,
    terminalSuccess: true,
    terminationReason: null,
    finalOutput: "done",
    providerError: null,
    stdout: "added the 429 rate limit backoff; retries on ECONNRESET",
    stderr: "",
  };
  const envelope = completionEnvelope({
    executionSucceeded: true,
    evidence,
    deliveryFailure: delivery.failure,
    runnerClass: delivery.failureClass ?? null,
  });
  assert.deepEqual(envelope, {
    version: 1,
    phase: "DELIVER",
    runnerClass: "TOOL_FAILED",
    exitCode: 0,
    signal: null,
    terminationReason: null,
    terminalEventSeen: true,
    terminalSuccess: true,
    agentExited: true,
    providerError: null,
    stderrSummary: `git push timed out after ${envelope.timeoutMs}ms; its process group was killed`,
    // Dropped on purpose: the agent's work product says nothing about the push,
    // and it is the channel that caused the misclassifications this ticket is
    // about. The completion still reports it as `output`.
    stdoutSummary: null,
    timedOut: true,
    transient: true,
    timeoutMs: envelope.timeoutMs,
  });
  assert.ok(
    typeof envelope.timeoutMs === "number" && envelope.timeoutMs > 0 && envelope.timeoutMs <= NETWORK_COMMAND_TIMEOUT_MS,
    `the timeout the API is told about must be the ceiling that actually fired: ${envelope.timeoutMs}`,
  );
});

test("a failing agent keeps its own evidence even when the salvage push also fails", async () => {
  // The mirror case. `executionSucceeded: false` means the run's failure is the
  // agent's, so a salvage that also fails must not overwrite the reason.
  const envelope = completionEnvelope({
    executionSucceeded: false,
    evidence: {
      exitCode: 1, signal: null, terminalEventSeen: true, terminalSuccess: false, terminationReason: null,
      finalOutput: null, providerError: "server_error", stdout: "partial work", stderr: "the model gave up",
    },
    deliveryFailure: { operation: "git push", message: "WIP salvage failed", error: new CommandTimeoutError("git", ["push"], 20_000) },
    runnerClass: "TRANSIENT_PROVIDER",
  });
  assert.equal(envelope.phase, "EXECUTE");
  assert.equal(envelope.providerError, "server_error");
  assert.equal(envelope.stderrSummary, "the model gave up");
  assert.equal(envelope.timedOut, false, "the salvage's timeout is not why the run failed");
});

test("every command of a slow delivery is capped, and the whole phase fits one lease", async () => {
  // The full chain the reviewer asked for: push, the gh probe, the first
  // lookup, creation, and the confirming lookup — every one of them slow, all
  // drawing on the single phase deadline, measured from the delivery heartbeat.
  let clock = 0;
  const calls: string[] = [];
  const fake: CommandRunner = async (executable, args, options) => {
    calls.push(`${executable} ${args.slice(0, 2).join(" ")}`);
    const timeoutMs = options?.timeoutMs;
    // Nothing in delivery may run uncapped: an uncapped command is a hole in
    // the phase bound, whatever the budget arithmetic says.
    assert.ok(timeoutMs !== undefined, `${executable} ${args[0]} ran without a ceiling`);
    if (executable === "git" && args[0] === "rev-parse") { clock += 50; return "changed-head"; }
    if (executable === "git") { clock += timeoutMs; return ""; }
    if (args[0] === "--version") { clock += 50; return "gh version 2.0.0"; }
    if (args[1] === "list") { clock += 2_000; return calls.filter((call) => call === "gh pr create").length > 0 ? JSON.stringify([{ url: "https://github.com/acme/app/pull/9", number: 9 }]) : "[]"; }
    clock += timeoutMs;
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, {
    command: fake,
    retryOptions: {
    deadline: deliveryDeadline(0, 60, 0),
    now: () => clock,
    wait: async () => { clock += 1_000; },
    },
  });
  assert.equal(result.pullRequestNumber, 9);
  assert.deepEqual(calls, ["git rev-parse HEAD", "git push --set-upstream", "gh --version", "gh pr list", "gh pr create", "gh pr list"]);
  assert.ok(clock < LEASE_MS, `delivery outlived its lease: ${clock}ms`);
});

test("a hung pull-request creation and its probe cannot open a second budget", async () => {
  let clock = 0;
  const calls: string[] = [];
  const ghTimeouts: Array<number | undefined> = [];
  const fake: CommandRunner = async (executable, args, options) => {
    calls.push(`${executable} ${args.slice(0, 2).join(" ")}`);
    if (executable === "git") return "";
    if (args[0] === "--version") return "gh version 2.0.0";
    ghTimeouts.push(options?.timeoutMs);
    if (args[1] === "list") { clock += 500; return "[]"; }
    // `gh pr create` hangs; the probe that follows it must not restart the
    // budget, or one operation costs the phase twice what it was promised.
    clock += (options?.timeoutMs ?? 0) + KILL_OVERHEAD_MS;
    throw new CommandTimeoutError("gh", ["pr"], options?.timeoutMs ?? 0);
  };
  const result = await deliverWorkspace(config, claim, workspace, {
    command: fake,
    retryOptions: {
    deadline: deliveryDeadline(0, 60, 0),
    now: () => clock,
    wait: async () => { clock += 1_000; },
    },
  });
  // The push already succeeded, so publication is retained even though the
  // delivery step fails and preserves the typed timeout.
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.pushedBranch, "feature/test");
  assert.ok(result.failure);
  assert.equal(result.failure?.error instanceof CommandTimeoutError, true);
  assert.match(result.deliveryInstructions ?? "", /PR creation failed/);
  assert.ok(ghTimeouts.every((timeoutMs) => timeoutMs !== undefined && timeoutMs <= NETWORK_COMMAND_TIMEOUT_MS));
  assert.ok(clock < LEASE_MS, `delivery outlived its lease: ${clock}ms`);
});

test("retries across the delivery chain cannot stack into more than one lease", async () => {
  // The shape the per-operation budget could not bound: every network call
  // hangs once, is retried, and only then succeeds — so each *operation*
  // legitimately spends most of a budget. With a budget per call that is four
  // budgets back to back; with one phase deadline it is one.
  let clock = 0;
  const attempted = new Map<string, number>();
  const fake: CommandRunner = async (executable, args, options) => {
    const key = `${executable} ${args.slice(0, 2).join(" ")}`;
    const seen = (attempted.get(key) ?? 0) + 1;
    attempted.set(key, seen);
    const timeoutMs = options?.timeoutMs ?? 0;
    if (executable === "git" || args[0] === "--version") return "";
    if (seen === 1) {
      clock += timeoutMs + KILL_OVERHEAD_MS;
      throw new CommandTimeoutError(executable, args, timeoutMs);
    }
    clock += timeoutMs;
    return args[1] === "list" ? "[]" : "";
  };
  const result = await deliverWorkspace(config, claim, workspace, {
    command: fake,
    retryOptions: {
    deadline: deliveryDeadline(0, 60, 0),
    now: () => clock,
    wait: async () => { clock += 1_000; },
    },
  });
  assert.equal(result.pushStatus, "FAILED");
  assert.equal(result.pushedBranch, "feature/test");
  assert.ok(clock < LEASE_MS, `delivery outlived its lease: ${clock}ms`);
  // The chain really did get as far as creation before the budget stopped it.
  assert.ok((attempted.get("gh pr list") ?? 0) >= 2);
  assert.ok((attempted.get("gh pr create") ?? 0) >= 1);
});
