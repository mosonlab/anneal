import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

import { DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME } from "./agent-contract.js";
import { canonicalOutputSchema, canonicalOutputSchemas } from "./canonical-output-schema.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import {
  retiredStepShapeDifferences,
  type LegacyStepRecord,
} from "./template-step-fields.js";
import {
  loadAllTemplateStepSources,
  loadTemplateStepSources,
  templateStepStructureDifferences,
  type CanonicalTemplateName,
  type PersistedTemplateStepStructure,
} from "./template-sources.js";

const templatesRoot = fileURLToPath(new URL("../../../agents/templates/", import.meta.url));
const regressionToolPrefix = '"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh"';
const regressionInvocations = [
  `${regressionToolPrefix} prepare`,
  `${regressionToolPrefix} review-fail '<concise finding IDs or defect>'`,
  `${regressionToolPrefix} finalize`,
];
const checkoutRegressionToolPattern = ["scripts", "regression-verification\\.sh"].join("\\/");
const regressionCommandPattern = new RegExp(
  String.raw`(?:"\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}/regression-verification\.sh"|${checkoutRegressionToolPattern}) (?:prepare|review-fail '[^']+'|finalize)`,
  "gu",
);

const withTemplateCopy = async (
  templateName: CanonicalTemplateName,
  mutate: (root: string) => Promise<void>,
  assertion: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "agentos-template-source-test-"));
  try {
    await cp(join(templatesRoot, templateName), join(root, templateName), { recursive: true });
    await mutate(root);
    await assertion(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const updateFrontmatter = async (
  root: string,
  templateName: CanonicalTemplateName,
  filename: string,
  replace: (source: string) => string,
): Promise<void> => {
  const path = join(root, templateName, filename);
  await writeFile(path, replace(await readFile(path, "utf8")));
};

type PromptContract = {
  format: "json" | "field-list";
  keys: string[];
};

const promptContract = (prompt: string): PromptContract | null => {
  const jsonLiteral = prompt.match(/`(\{"schemaVersion":[^`]+\})`/u)?.[1];
  if (jsonLiteral) {
    const parsed = JSON.parse(jsonLiteral) as unknown;
    assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    return { format: "json", keys: Object.keys(parsed).sort() };
  }
  const fieldList = prompt.match(/Persist exactly one immutable `blind-findings` JSON object with([\s\S]+?);/u)?.[1];
  if (!fieldList) return null;
  return {
    format: "field-list",
    keys: [...fieldList.matchAll(/`([a-z][A-Za-z]+)`/gu)].map((match) => match[1]!).sort(),
  };
};

test("canonical sources expose the exact layered Direct and Full graphs", async () => {
  const direct = await loadTemplateStepSources(DIRECT_TEMPLATE_NAME);
  const full = await loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME);

  assert.equal(direct.length, 8);
  assert.deepEqual(direct.map(({ layer }) => layer), [1, 2, 3, 3, 4, 5, 6, 7]);
  assert.deepEqual(direct.map(({ optional }) => optional), [false, false, false, true, false, false, false, false]);
  assert.deepEqual(
    direct.slice(0, 2).map(({ stepIndex, name, agentName, outputKind, opensPullRequest }) => ({
      stepIndex, name, agentName, outputKind, opensPullRequest,
    })),
    [
      {
        stepIndex: 1,
        name: "Revalidate specification",
        agentName: "spec-revalidator-luna-xhigh",
        outputKind: "revalidation",
        opensPullRequest: false,
      },
      {
        stepIndex: 2,
        name: "Implementation",
        agentName: "senior-dev-luna-max",
        outputKind: "implementation",
        opensPullRequest: true,
      },
    ],
  );
  assert.ok(canonicalOutputSchema(direct[0]!) instanceof z.ZodObject);
  assert.match(direct[0]!.prompt, /minimal task-PATCH authorization/u);
  assert.match(direct[0]!.prompt, /inbox_ask/u);
  assert.match(direct[0]!.prompt, /default is the answer unless one specific criterion/u);
  assert.match(direct[0]!.prompt, /new page, a page redesign, or a new\s+interaction or visual scheme/u);
  assert.match(direct[0]!.prompt, /neither the brief nor an existing test pins down/u);
  assert.match(direct[0]!.prompt, /concurrency,\s+transaction boundaries, lock or lease windows/u);
  assert.match(direct[0]!.prompt, /never edit the brief's `Route` line/u);
  assert.match(direct[0]!.prompt, /"schemaVersion":2/u);
  assert.equal(full.length, 12);
  assert.deepEqual(full.map(({ layer }) => layer), [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(full.map(({ optional }) => optional), [false, false, false, false, false, false, true, false, false, false, false, false]);
  for (const templateName of [DIRECT_TEMPLATE_NAME, INTEGRATOR_TEMPLATE_NAME]) {
    assert.equal(
      (await readdir(join(templatesRoot, templateName))).some((filename) => filename.includes("code-review-and-adjudication")),
      false,
    );
  }
  // The fix step now dispositions both review reports itself; no canonical step binds the adjudicator.
  assert.equal(direct.some(({ agentName }) => agentName === "review-adjudicator-opus"), false);
  assert.equal(full.some(({ agentName }) => agentName === "review-adjudicator-opus"), false);
  for (const steps of [direct, full]) {
    assert.deepEqual(
      steps.find(({ outputKind }) => outputKind === "review-findings")!.priorOutputKinds,
      ["implementation"],
    );
    assert.deepEqual(
      steps.find(({ outputKind }) => outputKind === "blind-findings")!.priorOutputKinds,
      [],
    );
    const librarian = steps.find(({ outputKind }) => outputKind === "documentation");
    if (librarian) assert.deepEqual(librarian.priorOutputKinds, ["implementation", "fixed-implementation"]);
    // The contract the removed adjudication node used to carry, now on the step that replaced it.
    const fix = steps.find(({ outputKind }) => outputKind === "fixed-implementation")!;
    assert.match(fix.prompt, /`review-findings`/u);
    assert.match(fix.prompt, /`blind-findings`/u);
    assert.match(fix.prompt, /blind review may be absent/u);
    assert.match(fix.prompt, /every present report/u);
    assert.match(fix.prompt, /No adjudication step stands between the reviews and this one/u);
    assert.match(fix.prompt, /exactly one disposition per finding id/u);
    assert.match(fix.prompt, /ADOPTED.*REJECTED.*MERGED/u);
    assert.match(fix.prompt, /every `ADOPTED` disposition has a matching `closedFindings` entry/u);
    const regression = steps.find(({ outputKind }) => outputKind === "regression-verification-v2")!;
    assert.match(regression.prompt, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" prepare/u);
    assert.match(regression.prompt, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" review-fail/u);
    assert.match(regression.prompt, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" finalize/u);
    assert.match(regression.prompt, /finalize exit 77[\s\S]*Repeat the full semantic verification/u);
    assert.match(regression.prompt, /finalize exit 0[\s\S]*`pass`, `gate-fail`,\s+or `refresh-conflict`/u);
    assert.match(regression.prompt, /script persists the one allowed v2 outcome/u);
    assert.doesNotMatch(regression.prompt, /merge-lease\.sh|gate-dispatch\.sh|\{"schemaVersion":2/u);
    assert.ok(regression.prompt.split("\n").length < 30, "the semantic prompt stays materially shorter than the retired 62-line procedure");
  }
});

test("canonical regression commands require runner tools without a checkout fallback", async () => {
  const templateNames = [DIRECT_TEMPLATE_NAME, INTEGRATOR_TEMPLATE_NAME] as const satisfies readonly CanonicalTemplateName[];
  for (const templateName of templateNames) {
    const regression = (await loadTemplateStepSources(templateName))
      .find(({ outputKind }) => outputKind === "regression-verification-v2");
    assert.ok(regression, `${templateName} must contain a v2 regression step`);
    const invocations = [...regression.prompt.matchAll(regressionCommandPattern)].map(([invocation]) => invocation);

    const root = await mkdtemp(join(tmpdir(), "agentos-regression-prompt-test-"));
    const fallbackFixture = join(root, "scripts", "regression-verification.sh");
    const marker = join(root, "checkout-fallback-invoked");
    try {
      await mkdir(join(root, "scripts"), { recursive: true });
      await writeFile(
        fallbackFixture,
        `#!/usr/bin/env bash\nprintf 'fallback fixture invoked\\n' > ${JSON.stringify(marker)}\nexit 99\n`,
        { mode: 0o755 },
      );

      for (const invocation of invocations) {
        for (const toolsValue of ["unset", ""]) {
          const env = { ...process.env };
          if (toolsValue === "unset") delete env.AGENTOS_TOOLS;
          else env.AGENTOS_TOOLS = toolsValue;
          const result = spawnSync("bash", ["-c", invocation], { cwd: root, encoding: "utf8", env });
          const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
          assert.notEqual(result.status, 0, `${templateName} ${invocation} unexpectedly succeeded`);
          assert.equal(existsSync(marker), false, `${templateName} ${invocation} invoked a checkout copy`);
          assert.match(output, /AGENTOS_TOOLS is required/u, `${templateName} ${invocation}: ${output}`);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    assert.doesNotMatch(regression.prompt, new RegExp(checkoutRegressionToolPattern, "u"));
    assert.deepEqual(invocations, regressionInvocations, `${templateName} must use only the runner-owned invocations`);
  }
});

test("the pull-request workflow source exposes its exact four-step graph and prompt contract", async () => {
  const steps = await loadTemplateStepSources(PR_TEMPLATE_NAME);
  assert.deepEqual(
    steps.map((step) => ({
      name: step.name,
      stepIndex: step.stepIndex,
      layer: step.layer,
      agent: step.agentName,
      approvalGate: step.approvalGate,
      optional: step.optional,
      outputKind: step.outputKind,
      priorOutputKinds: step.priorOutputKinds,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      provisionDependencies: step.provisionDependencies,
      baseFromStepIndex: step.baseFromStepIndex,
      spawnPolicy: step.spawnPolicy,
    })),
    [
      {
        name: "Implementation",
        stepIndex: 1,
        layer: 1,
        agent: "senior-dev-luna-max",
        approvalGate: false,
        optional: false,
        outputKind: "implementation",
        priorOutputKinds: [],
        attachmentsFromPrevious: false,
        opensPullRequest: true,
        requiresCommit: true,
        provisionDependencies: true,
        baseFromStepIndex: null,
        spawnPolicy: null,
      },
      {
        name: "Code review",
        stepIndex: 2,
        layer: 2,
        agent: "code-reviewer-sol-high",
        approvalGate: false,
        optional: false,
        outputKind: "review-findings",
        priorOutputKinds: ["implementation"],
        attachmentsFromPrevious: true,
        opensPullRequest: false,
        requiresCommit: false,
        provisionDependencies: false,
        baseFromStepIndex: 1,
        spawnPolicy: null,
      },
      {
        name: "Blind code review",
        stepIndex: 3,
        layer: 2,
        agent: "code-reviewer-opus-medium",
        approvalGate: false,
        optional: false,
        outputKind: "blind-findings",
        priorOutputKinds: [],
        attachmentsFromPrevious: false,
        opensPullRequest: false,
        requiresCommit: false,
        provisionDependencies: false,
        baseFromStepIndex: 1,
        spawnPolicy: null,
      },
      {
        name: "Apply review fixes",
        stepIndex: 4,
        layer: 3,
        agent: "senior-dev-astra-low",
        approvalGate: false,
        optional: false,
        outputKind: "fixed-implementation",
        priorOutputKinds: ["review-findings", "blind-findings"],
        attachmentsFromPrevious: true,
        opensPullRequest: false,
        requiresCommit: false,
        provisionDependencies: true,
        baseFromStepIndex: null,
        spawnPolicy: null,
      },
    ],
  );

  assert.deepEqual(
    (await loadTemplateStepSources(PR_TEMPLATE_NAME)).map(({ optional }) => optional),
    [false, false, false, false],
  );

  const direct = await loadTemplateStepSources(DIRECT_TEMPLATE_NAME);
  // The two review prompts remain shared with the direct workflow. The PR
  // fix prompt is intentionally different: only this workflow cleans its
  // chain bookkeeping before publishing the pull request.
  assert.deepEqual(
    steps.slice(1, 3).map(({ prompt }) => prompt),
    direct.slice(2, 4).map(({ prompt }) => prompt),
  );

  const implementationPrompt = steps[0]!.prompt;
  assert.match(implementationPrompt, /task description[^.]*specification of record/u);
  assert.match(implementationPrompt, /\.chain\/\{\{branchName\}\}\/spec\.md/u);
  assert.match(implementationPrompt, /leaves that file untouched/u);
  assert.match(implementationPrompt, /commit/u);
  assert.match(implementationPrompt, /Every `testsRun` entry must record the exact command and its observed exit\/result summary/u);
  for (const field of ["schemaVersion", "headSha", "baseSha", "summary", "testsRun"]) {
    assert.match(implementationPrompt, new RegExp(field, "u"));
  }
  assert.match(implementationPrompt, /exactly one.*implementation.*JSON output object/u);
  assert.match(implementationPrompt, /publication and pull-request creation to the platform/u);
  assert.doesNotMatch(implementationPrompt, /child|Route|revalidat/u);

  const reviewPrompts = steps.slice(1, 3).map(({ prompt }) => prompt);
  for (const prompt of [implementationPrompt, ...reviewPrompts]) {
    assert.doesNotMatch(prompt, /remove the complete tracked `\.chain\/` directory[\s\S]*fixed-implementation/u);
  }

  const finalPrompt = steps[3]!.prompt;
  assert.match(
    finalPrompt,
    /After using the review evidence[\s\S]*remove the complete tracked `\.chain\/` directory[\s\S]*commit that deletion together with any adopted fixes[\s\S]*fixed-implementation/u,
  );
  assert.match(finalPrompt, /Before persisting the output, verify that `git ls-tree -r --name-only HEAD -- \.chain` has no entries/u);
  assert.match(finalPrompt, /only after that cleanup commit/u);
  assert.match(finalPrompt, /`testsRun` entry[s]? [^\.]*exact command and its observed exit\/result summary/u);
  assert.match(finalPrompt, /retry starts at the already-clean cleanup commit[\s\S]*preserve that head[\s\S]*do not recreate bookkeeping or invent another commit/u);
  assert.notEqual(finalPrompt, direct[4]!.prompt);

  const source = await readFile(join(templatesRoot, PR_TEMPLATE_NAME, "01-implementation.md"), "utf8");
  assert.equal(implementationPrompt, source.slice(source.indexOf("\n---\n", 4) + 5).trim());
});

test("the canonical Regression v2 schema preserves an optional gate failure excerpt", () => {
  const schema = canonicalOutputSchemas.regression?.v2;
  assert.ok(schema);
  const verdict = {
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: "a".repeat(40),
    baseHeadSha: "b".repeat(40),
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (unit tests)",
    summary: "unit tests",
  };
  assert.equal(schema.safeParse(verdict).success, true);
  const withExcerpt = schema.safeParse({ ...verdict, gateFailureExcerpt: "not ok 1 - example.test.ts" });
  assert.equal(withExcerpt.success, true);
  if (!withExcerpt.success) throw new Error("canonical regression verdict rejected a string excerpt");
  assert.equal(
    (withExcerpt.data as Record<string, unknown>).gateFailureExcerpt,
    "not ok 1 - example.test.ts",
  );
  assert.equal(schema.safeParse({ ...verdict, gateFailureExcerpt: 42 }).success, false);
});

test("the revalidation v2 schema requires an explained tier route", () => {
  const schema = canonicalOutputSchemas.revalidation?.v2;
  assert.ok(schema);
  const base = {
    schemaVersion: 2,
    headSha: "a".repeat(40),
    outcome: "unchanged",
    summary: "the brief remains current",
    changedReferences: [],
  };
  for (const tier of ["default", "frontend", "hard", "hazard"] as const) {
    assert.equal(schema.safeParse({ ...base, route: { tier, reason: `criterion for ${tier}` } }).success, true);
  }
  assert.equal(schema.safeParse({ ...base, schemaVersion: 1, route: { tier: "default", reason: "none" } }).success, false);
  assert.equal(schema.safeParse(base).success, false);
  assert.equal(schema.safeParse({ ...base, route: { tier: "unknown", reason: "reason" } }).success, false);
  assert.equal(schema.safeParse({ ...base, route: { tier: "default", reason: "  " } }).success, false);
});

test("nine authored Full Assurance output contracts match their canonical schemas", async () => {
  const steps = await loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME);
  const contracts = steps
    .map((step) => ({ step, contract: promptContract(step.prompt) }))
    .filter((entry): entry is { step: typeof entry.step; contract: PromptContract } => entry.contract !== null);

  assert.equal(contracts.length, 9);
  assert.equal(contracts.filter(({ contract }) => contract.format === "json").length, 8);
  assert.deepEqual(
    contracts.filter(({ contract }) => contract.format === "field-list").map(({ step }) => step.outputKind),
    ["blind-findings"],
  );
  for (const { step, contract } of contracts) {
    const schema = canonicalOutputSchema(step);
    assert.ok(schema instanceof z.ZodObject, `${step.outputKind} must resolve to an object schema`);
    assert.deepEqual(contract.keys, Object.keys(schema.shape).sort(), step.outputKind);
  }
});

test("missing layer frontmatter is refused by the source loader", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "03-code-review.md", (source) => source.replace("layer: 3\n", "")),
    (root) => assert.rejects(
      loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root),
      /frontmatter must contain exactly .*layer/u,
    ),
  );
});

test("optional is a required boolean frontmatter field in every canonical template", async () => {
  for (const templateName of [INTEGRATOR_TEMPLATE_NAME, DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME] as const) {
    const firstStepFilename = templateName === PR_TEMPLATE_NAME
      ? "01-implementation.md"
      : templateName === DIRECT_TEMPLATE_NAME
        ? "01-revalidate.md"
        : "01-write-a-spec.md";
    await withTemplateCopy(
      templateName,
      (root) => updateFrontmatter(root, templateName, firstStepFilename, (source) => source.replace(/^optional: .*\n/mu, "")),
      (root) => assert.rejects(
        loadTemplateStepSources(templateName, root),
        /frontmatter must contain exactly .*optional/u,
      ),
    );
  }
});

test("optional frontmatter must contain a strict boolean", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "04-code-review-blind.md", (source) => source.replace("optional: true\n", "optional: yes\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /optional must be true or false/u),
  );
});

test("missing prior output declaration frontmatter is refused by the source loader", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "03-code-review.md", (source) => source.replace(/^priorOutputKinds: .*\n/mu, "")),
    (root) => assert.rejects(
      loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root),
      /frontmatter must contain exactly .*priorOutputKinds/u,
    ),
  );
});

test("missing or malformed dependency provisioning frontmatter is refused by the source loader", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "03-code-review.md", (source) => source.replace(/^provisionDependencies: .*\n/mu, "")),
    (root) => assert.rejects(
      loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root),
      /frontmatter must contain exactly .*provisionDependencies/u,
    ),
  );
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "03-code-review.md", (source) => source.replace("provisionDependencies: false\n", "provisionDependencies: no\n")),
    (root) => assert.rejects(
      loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root),
      /provisionDependencies must be true or false/u,
    ),
  );
});

test("only the six canonical code-review steps disable dependency provisioning", async () => {
  const templates = await loadAllTemplateStepSources();
  const disabled = [...templates].flatMap(([templateName, steps]) => steps
    .filter((step) => !step.provisionDependencies)
    .map((step) => `${templateName}:${step.stepIndex}`));
  assert.deepEqual(disabled, [
    `${INTEGRATOR_TEMPLATE_NAME}:6`,
    `${INTEGRATOR_TEMPLATE_NAME}:7`,
    `${DIRECT_TEMPLATE_NAME}:3`,
    `${DIRECT_TEMPLATE_NAME}:4`,
    `${PR_TEMPLATE_NAME}:2`,
    `${PR_TEMPLATE_NAME}:3`,
  ]);
  assert.equal([...templates.values()].flat().every((step) => typeof step.provisionDependencies === "boolean"), true);
});

test("prior output declarations are unique and reference only earlier steps", async () => {
  await withTemplateCopy(
    INTEGRATOR_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, INTEGRATOR_TEMPLATE_NAME, "08-apply-review-fixes.md", (source) => source.replace(
      "priorOutputKinds: [review-findings, blind-findings]",
      "priorOutputKinds: [review-findings, review-findings]",
    )),
    (root) => assert.rejects(loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME, root), /duplicate priorOutputKinds review-findings/u),
  );
  await withTemplateCopy(
    INTEGRATOR_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, INTEGRATOR_TEMPLATE_NAME, "05-implementation.md", (source) => source.replace(
      "priorOutputKinds: [revised-plan]",
      "priorOutputKinds: [review-findings]",
    )),
    (root) => assert.rejects(loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME, root), /priorOutputKinds review-findings does not reference an earlier step/u),
  );
});

test("blind review steps cannot declare prior outputs", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "04-code-review-blind.md", (source) => source.replace(
      "priorOutputKinds: []",
      "priorOutputKinds: [implementation]",
    )),
    (root) => assert.rejects(
      loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root),
      /blind-findings cannot declare priorOutputKinds/u,
    ),
  );
});

test("inserting a duplicate outputKind into a canonical template is refused", async () => {
  await withTemplateCopy(
    INTEGRATOR_TEMPLATE_NAME,
    async (root) => {
      const templateRoot = join(root, INTEGRATOR_TEMPLATE_NAME);
      const inserted = join(templateRoot, "13-second-merge-execution.md");
      await copyFile(join(templateRoot, "12-merge-execution.md"), inserted);
      await writeFile(inserted, (await readFile(inserted, "utf8")).replace("stepIndex: 12\n", "stepIndex: 13\n"));
    },
    (root) => assert.rejects(
      loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME, root),
      /duplicate outputKind merge-result/u,
    ),
  );
});

test("source layers must be non-decreasing and bases must cross to a lower layer", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "04-code-review-blind.md", (source) => source.replace("layer: 3\n", "layer: 1\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /layer values must be non-decreasing/u),
  );

  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "04-code-review-blind.md", (source) => source.replace("baseFromStepIndex: 2\n", "baseFromStepIndex: 3\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /must reference a strictly lower layer/u),
  );
});

test("optional canonical steps obey entry, base, gate, and merge-tail invariants", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "01-revalidate.md", (source) => source.replace("optional: false\n", "optional: true\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /step 1 first_step_optional/u),
  );
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "02-implementation.md", (source) => source.replace("optional: false\n", "optional: true\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /step 3 base_step_optional 2/u),
  );
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "07-merge-readiness.md", (source) => source.replace("optional: false\n", "optional: true\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /step 7 gate_slot_step_optional/u),
  );
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "06-regression-verification.md", (source) => source.replace("optional: false\n", "optional: true\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /step 6 optional_step_precedes_merge_tail/u),
  );
});

test("only the exact canonical graphs may contain a multi-node layer", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "05-apply-review-fixes.md", (source) => source.replace("layer: 4\n", "layer: 3\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /multi-node layer outside the exact canonical graph/u),
  );
});

test("parallel nodes share one non-null base and never open a pull request", async () => {
  await withTemplateCopy(
    INTEGRATOR_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, INTEGRATOR_TEMPLATE_NAME, "06-code-review.md", (source) => source.replace("baseFromStepIndex: 5\n", "baseFromStepIndex: 4\n")),
    (root) => assert.rejects(loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME, root), /must use the same baseFromStepIndex/u),
  );

  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "03-code-review.md", (source) => source.replace("opensPullRequest: false\n", "opensPullRequest: true\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /cannot contain a step with opensPullRequest/u),
  );

  for (const [templateName, filename] of [
    [DIRECT_TEMPLATE_NAME, "03-code-review.md"],
    [INTEGRATOR_TEMPLATE_NAME, "06-code-review.md"],
  ] as const) {
    await withTemplateCopy(
      templateName,
      (root) => updateFrontmatter(root, templateName, filename, (source) => source.replace("approvalGate: false\n", "approvalGate: true\n")),
      (root) => assert.rejects(loadTemplateStepSources(templateName, root), /multi-node layer .* cannot contain an approval gate/u),
    );
  }
});

test("layer, requiresCommit, and dependency provisioning are structural fields in canonical prompt drift comparison", async () => {
  const expected = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))[2]!;
  const persisted: PersistedTemplateStepStructure = {
    name: expected.name,
    assigneeAgent: { name: expected.agentName! },
    assigneeType: "AGENT",
    layer: expected.layer,
    approvalGate: expected.approvalGate,
    optional: expected.optional,
    outputKind: expected.outputKind,
    attachmentsFromPrevious: expected.attachmentsFromPrevious,
    priorOutputKinds: expected.priorOutputKinds,
    opensPullRequest: expected.opensPullRequest,
    requiresCommit: expected.requiresCommit,
    provisionDependencies: expected.provisionDependencies,
    baseFromStepIndex: expected.baseFromStepIndex,
    spawnPolicy: expected.spawnPolicy as PersistedTemplateStepStructure["spawnPolicy"],
  };
  assert.deepEqual(templateStepStructureDifferences(persisted, expected), []);
  assert.deepEqual(templateStepStructureDifferences({ ...persisted, layer: expected.layer + 1 }, expected), ["layer"]);
  assert.deepEqual(templateStepStructureDifferences({ ...persisted, optional: !expected.optional }, expected), ["optional"]);
  assert.deepEqual(
    templateStepStructureDifferences({ ...persisted, requiresCommit: !expected.requiresCommit }, expected),
    ["requiresCommit"],
  );
  assert.deepEqual(
    templateStepStructureDifferences({ ...persisted, provisionDependencies: !expected.provisionDependencies }, expected),
    ["provisionDependencies"],
  );
});

test("one field table decides both row-vs-spec comparisons", async () => {
  // The roster, pinned: a structural column added to a step shape without an
  // entry in the field table cannot make either comparator report it.
  const expected = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))[2]!;
  const persisted: PersistedTemplateStepStructure = {
    name: expected.name,
    assigneeAgent: { name: expected.agentName! },
    assigneeType: "AGENT",
    layer: expected.layer,
    approvalGate: expected.approvalGate,
    optional: expected.optional,
    outputKind: expected.outputKind,
    attachmentsFromPrevious: expected.attachmentsFromPrevious,
    priorOutputKinds: expected.priorOutputKinds,
    opensPullRequest: expected.opensPullRequest,
    requiresCommit: expected.requiresCommit,
    provisionDependencies: expected.provisionDependencies,
    baseFromStepIndex: expected.baseFromStepIndex,
    spawnPolicy: expected.spawnPolicy as PersistedTemplateStepStructure["spawnPolicy"],
  };
  const changed: PersistedTemplateStepStructure = {
    name: `${expected.name} (renamed)`,
    assigneeAgent: null,
    assigneeType: "HUMAN",
    layer: expected.layer + 1,
    approvalGate: !expected.approvalGate,
    optional: !expected.optional,
    outputKind: `${expected.outputKind}-v2`,
    attachmentsFromPrevious: !expected.attachmentsFromPrevious,
    priorOutputKinds: [...expected.priorOutputKinds, "spec"],
    opensPullRequest: !expected.opensPullRequest,
    requiresCommit: !expected.requiresCommit,
    provisionDependencies: !expected.provisionDependencies,
    baseFromStepIndex: (expected.baseFromStepIndex ?? 0) + 1,
    spawnPolicy: { changed: true },
  };
  assert.deepEqual(templateStepStructureDifferences(changed, expected), [
    "name", "agent", "assigneeType", "layer", "approvalGate", "optional", "outputKind",
    "attachmentsFromPrevious", "priorOutputKinds", "opensPullRequest", "requiresCommit",
    "provisionDependencies", "baseFromStepIndex", "spawnPolicy",
  ]);

  // The retired-shape reading of the same table: every field is data on the
  // record, except the two the retired shape deliberately does not read -- the
  // prior-output whitelist, whose migration is independent of any graph
  // transition, and the Agent binding, which is staffing rather than structure.
  const record: LegacyStepRecord = {
    name: expected.name,
    assigneeType: "AGENT" as LegacyStepRecord["assigneeType"],
    layer: expected.layer,
    approvalGate: expected.approvalGate,
    optional: expected.optional,
    outputKind: expected.outputKind,
    attachmentsFromPrevious: expected.attachmentsFromPrevious,
    opensPullRequest: expected.opensPullRequest,
    requiresCommit: expected.requiresCommit,
    provisionDependencies: expected.provisionDependencies,
    baseFromStepIndex: expected.baseFromStepIndex,
    spawnPolicy: expected.spawnPolicy as LegacyStepRecord["spawnPolicy"],
  };
  assert.deepEqual(retiredStepShapeDifferences(persisted, record), []);
  assert.deepEqual(retiredStepShapeDifferences({ ...persisted, priorOutputKinds: ["anything"] }, record), []);
  // A row staffed by any other Agent is still the same retired graph.
  assert.deepEqual(
    retiredStepShapeDifferences({ ...persisted, assigneeAgent: { name: "some-other-agent" } }, record),
    [],
  );
  assert.deepEqual(retiredStepShapeDifferences(changed, record), [
    "name", "assigneeType", "layer", "approvalGate", "optional", "outputKind",
    "attachmentsFromPrevious", "opensPullRequest", "requiresCommit",
    "provisionDependencies", "baseFromStepIndex", "spawnPolicy",
  ]);

  // An omitted field is the documented default, not an unconstrained one.
  const omitted: LegacyStepRecord = {
    name: record.name,
    assigneeType: record.assigneeType,
    layer: record.layer,
    approvalGate: record.approvalGate,
    outputKind: record.outputKind,
    attachmentsFromPrevious: record.attachmentsFromPrevious,
    opensPullRequest: record.opensPullRequest,
    baseFromStepIndex: record.baseFromStepIndex,
    spawnPolicy: record.spawnPolicy,
  };
  assert.deepEqual(
    retiredStepShapeDifferences({ ...persisted, optional: false, requiresCommit: false, provisionDependencies: true }, omitted),
    [],
  );
  assert.deepEqual(
    retiredStepShapeDifferences({ ...persisted, optional: true, requiresCommit: false, provisionDependencies: true }, omitted),
    ["optional"],
  );
});
