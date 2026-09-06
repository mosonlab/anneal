import assert from "node:assert/strict";
import test from "node:test";

import { PR_TEMPLATE_NAME } from "./agent-contract.js";
import {
  CANONICAL_SOURCE_PROMPT_GENERATIONS,
  canonicalTemplateIdentity,
  LEGACY_TEMPLATE_GENERATIONS,
  legacyGenerationMatches,
  templateRolloverName,
  matchedLegacyGeneration,
  sourcePromptGenerationDrift,
  templatePromptGenerationDigest,
  templateRolloverBlockerCount,
  type CanonicalTemplateRegistryName,
  type PersistedTransitionStep,
} from "./canonical-template-transition.js";
import { retiredStepShapeDifferences, type LegacyStepRecord } from "./template-step-fields.js";
import {
  LEGACY_ALL_PRIOR_OUTPUTS,
  loadAllTemplateStepSources,
  type TemplateStepSource,
} from "./template-sources.js";

test("parked and not-yet-started legacy chains may roll over intact", () => {
  assert.equal(templateRolloverBlockerCount([
    { chainId: "parked", activeRunCount: 0 },
    { chainId: "parked", activeRunCount: 0 },
    { chainId: "not-started", activeRunCount: 0 },
  ]), 0);
});

test("active Runs and unfinished work without a chain identity block rollover", () => {
  assert.equal(templateRolloverBlockerCount([
    { chainId: "active", activeRunCount: 1 },
    { chainId: "quiescent", activeRunCount: 0 },
    { chainId: null, activeRunCount: 0 },
  ]), 2);
});

const asPersisted = (steps: readonly TemplateStepSource[]): PersistedTransitionStep[] =>
  steps.map((step) => ({
    id: `step-${String(step.stepIndex)}`,
    taskTemplateId: "template",
    stepIndex: step.stepIndex,
    name: step.name,
    assigneeAgent: step.agentName === null ? null : { name: step.agentName },
    assigneeType: step.agentName === null ? "HUMAN" : "AGENT",
    layer: step.layer,
    approvalGate: step.approvalGate,
    optional: step.optional,
    outputKind: step.outputKind,
    attachmentsFromPrevious: step.attachmentsFromPrevious,
    priorOutputKinds: step.priorOutputKinds,
    opensPullRequest: step.opensPullRequest,
    requiresCommit: step.requiresCommit,
    provisionDependencies: step.provisionDependencies,
    baseFromStepIndex: step.baseFromStepIndex,
    spawnPolicy: step.spawnPolicy as PersistedTransitionStep["spawnPolicy"],
    prompt: step.prompt,
  }));

/** The rows a registered shape describes, each field at the value it states. */
const shapeAsPersisted = (shape: readonly LegacyStepRecord[]): PersistedTransitionStep[] => shape.map((step, index) => ({
  id: `shape-${String(index + 1)}`,
  taskTemplateId: "template",
  stepIndex: index + 1,
  name: step.name,
  assigneeAgent: step.assigneeType === "AGENT" ? SOME_AGENT : null,
  assigneeType: step.assigneeType,
  layer: step.layer,
  approvalGate: step.approvalGate,
  optional: step.optional ?? false,
  outputKind: step.outputKind,
  attachmentsFromPrevious: step.attachmentsFromPrevious,
  priorOutputKinds: [],
  opensPullRequest: step.opensPullRequest,
  requiresCommit: step.requiresCommit ?? false,
  provisionDependencies: step.provisionDependencies ?? true,
  baseFromStepIndex: step.baseFromStepIndex,
  spawnPolicy: step.spawnPolicy,
  prompt: "retired",
}));

const generationOf = (templateName: CanonicalTemplateRegistryName, marker: string) => {
  const generation = LEGACY_TEMPLATE_GENERATIONS[templateName]?.find((candidate) => candidate.marker === marker);
  assert.ok(generation, `${templateName} must register ${marker}`);
  return generation;
};

/** Whatever a retired row was staffed with, the fingerprint does not read it. */
const SOME_AGENT = { name: "some-staffed-agent" };

const persistedGeneration = (
  generation: ReturnType<typeof generationOf>,
  provisionDependencies: unknown,
): PersistedTransitionStep[] => generation.shape.map((step, index) => ({
  id: `legacy-${String(index + 1)}`,
  taskTemplateId: "template",
  stepIndex: index + 1,
  name: step.name,
  assigneeAgent: step.assigneeType === "AGENT" ? SOME_AGENT : null,
  assigneeType: step.assigneeType,
  layer: step.layer,
  approvalGate: step.approvalGate,
  optional: step.optional ?? false,
  outputKind: step.outputKind,
  attachmentsFromPrevious: step.attachmentsFromPrevious,
  priorOutputKinds: [],
  opensPullRequest: step.opensPullRequest,
  requiresCommit: step.requiresCommit ?? false,
  provisionDependencies,
  baseFromStepIndex: step.baseFromStepIndex,
  spawnPolicy: step.spawnPolicy,
  prompt: "retired",
})) as unknown as PersistedTransitionStep[];

/** One source step as the registry would record it: every field stated as data. */
const asLegacyRecord = (step: TemplateStepSource): LegacyStepRecord => ({
  name: step.name,
  assigneeType: (step.agentName === null ? "HUMAN" : "AGENT") as LegacyStepRecord["assigneeType"],
  layer: step.layer,
  approvalGate: step.approvalGate,
  optional: step.optional,
  outputKind: step.outputKind,
  attachmentsFromPrevious: step.attachmentsFromPrevious,
  opensPullRequest: step.opensPullRequest,
  requiresCommit: step.requiresCommit,
  provisionDependencies: step.provisionDependencies,
  baseFromStepIndex: step.baseFromStepIndex,
  spawnPolicy: step.spawnPolicy as LegacyStepRecord["spawnPolicy"],
});

const PROMPT_ROLLOVER_TEMPLATES = ["direct-engineer-workflow", "compound-engineer-workflow"] as const;

test("canonical identity parses current names and every registered generation", () => {
  for (const [canonicalName, generations] of Object.entries(LEGACY_TEMPLATE_GENERATIONS)) {
    assert.deepEqual(canonicalTemplateIdentity(canonicalName), { canonicalName, generation: null });
    for (const generation of generations) {
      assert.deepEqual(
        canonicalTemplateIdentity(templateRolloverName(canonicalName, generation.marker, "template-row")),
        { canonicalName, generation: generation.marker },
      );
    }
  }
  assert.equal(canonicalTemplateIdentity("compound-engineer-workflow-legacy-pre-zero-gate-"), null);
  assert.equal(canonicalTemplateIdentity("unregistered-workflow"), null);
});

test("registered generations require an explicit true dependency-provisioning value", () => {
  const generation = generationOf("direct-engineer-workflow", "pre-adjudication");
  assert.equal(legacyGenerationMatches(generation, persistedGeneration(generation, true)), true);
  for (const value of [false, undefined, "true"]) {
    assert.equal(
      legacyGenerationMatches(generation, persistedGeneration(generation, value)),
      false,
      `historical field ${String(value)} must not match`,
    );
  }
});

test("legacy generation shapes match each step's optional flag", () => {
  const baseGeneration = generationOf("direct-engineer-workflow", "pre-adjudication");
  const optionalStepIndex = baseGeneration.shape.findIndex((step) => step.outputKind === "blind-findings");
  assert.notEqual(optionalStepIndex, -1);
  const withOptional = (steps: PersistedTransitionStep[], optional: boolean) =>
    steps.map((step, index) => (index === optionalStepIndex ? { ...step, optional } : step));
  const optionalGeneration = {
    marker: "synthetic-optional",
    shape: baseGeneration.shape.map((step, index) => (
      index === optionalStepIndex ? { ...step, optional: true } : step
    )),
  };
  const optionalRows = persistedGeneration(optionalGeneration, true);

  assert.equal(legacyGenerationMatches(optionalGeneration, optionalRows), true);
  assert.equal(
    legacyGenerationMatches(
      optionalGeneration,
      withOptional(optionalRows, false),
    ),
    false,
  );
  assert.equal(
    legacyGenerationMatches(
      baseGeneration,
      withOptional(persistedGeneration(baseGeneration, true), true),
    ),
    false,
  );
});

test("a prompt generation is decided by step index and text, not by array order", () => {
  const forward = [{ stepIndex: 1, prompt: "one" }, { stepIndex: 2, prompt: "two" }];
  const reversed = [{ stepIndex: 2, prompt: "two" }, { stepIndex: 1, prompt: "one" }];
  assert.equal(templatePromptGenerationDigest(forward), templatePromptGenerationDigest(reversed));

  // Moving a prompt between two steps is a different generation, even though
  // the set of prompt bodies is unchanged.
  const swapped = [{ stepIndex: 1, prompt: "two" }, { stepIndex: 2, prompt: "one" }];
  assert.notEqual(templatePromptGenerationDigest(forward), templatePromptGenerationDigest(swapped));
});

test("a structure-identical generation is decided by its prompt digest alone", () => {
  // The predicate, exercised directly on a synthetic pair: same shape, one
  // registered prompt generation. This is the case a shape can never express.
  const shape = [{
    name: "Implementation",
    assigneeType: "AGENT",
    approvalGate: false,
    outputKind: "implementation",
    attachmentsFromPrevious: false,
    opensPullRequest: true,
    requiresCommit: true,
    baseFromStepIndex: null,
    layer: 1,
    spawnPolicy: null,
  }] as const;
  const stepsWith = (prompt: string): PersistedTransitionStep[] => [{
    id: "step-1", taskTemplateId: "template", stepIndex: 1, name: "Implementation",
    assigneeAgent: SOME_AGENT, assigneeType: "AGENT", layer: 1,
    approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false,
    optional: false,
    priorOutputKinds: [],
    opensPullRequest: true, requiresCommit: true, provisionDependencies: true,
    baseFromStepIndex: null, spawnPolicy: null, prompt,
  }];
  const outgoing = stepsWith("the retired instruction");
  const successor = stepsWith("the replacement instruction");
  const generation = {
    marker: "synthetic",
    shape: shape as never,
    promptDigest: templatePromptGenerationDigest(outgoing),
  };

  assert.equal(legacyGenerationMatches(generation, outgoing), true, "the retired generation is recognised");
  assert.equal(
    legacyGenerationMatches(generation, [{ ...outgoing[0]!, requiresCommit: false }]),
    false,
    "a mismatched commit contract is not the registered generation",
  );
  assert.equal(legacyGenerationMatches(generation, successor), false, "its successor is not, so it cannot re-roll");

  // Without a digest the same entry would swallow both, which is the infinite
  // rollover a prompt-only transition used to be unable to avoid.
  assert.equal(legacyGenerationMatches({ marker: "synthetic", shape: shape as never }, successor), true);
});

test("the regression step split is registered as a prompt-only rollover that cannot re-roll", async () => {
  // The upgrade this mechanism was extended for: the deployed graph and the
  // source graph have identical structure, so a graph still referenced by
  // instantiated tasks has to be recognised through its prompts or the deploy
  // stops at canonical sync.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const generation = generationOf(templateName, "pre-regression-step-split");
    assert.ok(generation.promptDigest, `${templateName} prompt-only generation must carry a digest`);

    const current = sources.get(templateName);
    assert.ok(current, `${templateName} must load from source`);
    const successor = asPersisted(current);

    // The explicit dependency-provisioning field makes the review rows
    // structurally different from every pre-field generation, so neither
    // current source graph can match the retired shape by fallback.
    assert.equal(
      legacyGenerationMatches({ marker: generation.marker, shape: generation.shape }, successor),
      false,
      `${templateName} rollover shape expectation`,
    );
    // But not the generation, because the prompts moved on.
    assert.notEqual(templatePromptGenerationDigest(successor), generation.promptDigest);
    assert.equal(
      matchedLegacyGeneration(templateName, successor),
      null,
      `${templateName} must not roll its own successor over again`,
    );
  }
});

test("an unregistered prompt edit matches nothing, so sync refuses instead of rolling", async () => {
  // Expressibility, not automation: nothing derives a rollover from drift.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    const edited = asPersisted(current).map((step) => ({ ...step, prompt: `${step.prompt}\n\nunregistered edit` }));
    assert.equal(matchedLegacyGeneration(templateName, edited), null);
  }
});

test("the pinned source generation is the one agents/templates holds", async () => {
  // The single fact 15 registry literals used to restate, checked here so a
  // stale pin fails in this suite instead of on a production deploy.
  const sources = await loadAllTemplateStepSources();
  for (const [templateName, pinned] of Object.entries(CANONICAL_SOURCE_PROMPT_GENERATIONS)) {
    const current = sources.get(templateName as CanonicalTemplateRegistryName);
    assert.ok(current, `${templateName} must load from source`);
    assert.equal(
      templatePromptGenerationDigest(current),
      pinned,
      `${templateName} pin is stale: re-pin it from npm run db:template-digest`,
    );
  }
  assert.deepEqual(
    Object.keys(CANONICAL_SOURCE_PROMPT_GENERATIONS).sort((left, right) => left.localeCompare(right)),
    Object.keys(LEGACY_TEMPLATE_GENERATIONS).sort((left, right) => left.localeCompare(right)),
  );
});

test("every registered generation rolls forward to a pinned source generation", () => {
  // The registry no longer restates the successor, so the only way an entry
  // can fail to resolve one is by naming a template with no pin at all.
  for (const [templateName, generations] of Object.entries(LEGACY_TEMPLATE_GENERATIONS)) {
    const pinned = CANONICAL_SOURCE_PROMPT_GENERATIONS[templateName as CanonicalTemplateRegistryName];
    assert.match(pinned ?? "", /^[0-9a-f]{64}$/u, `${templateName} must pin a source prompt generation`);
    for (const generation of generations) {
      assert.notEqual(
        generation.promptDigest,
        pinned,
        `${templateName}:${generation.marker} retires the generation it rolls forward to`,
      );
    }
  }
});

test("a rollover refuses a source that is not the generation it was registered to install", async () => {
  // The gap the retired-row digest leaves: the outgoing row still matches, so
  // the rename would fire, but the tree now holds prompts nobody registered.
  // A rollover writes a brand-new row, which no instantiated task references,
  // so the referenced-step prompt refusal cannot see the edit either.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);

    // The source as registered: no drift.
    assert.equal(sourcePromptGenerationDrift(templateName, current), null);

    // The same source, with the prompts edited again after registration.
    const driftedSource = current.map((step) => (
      step.stepIndex === current[0]!.stepIndex ? { ...step, prompt: `${step.prompt}\n\nlater edit` } : step
    ));
    const refusal = sourcePromptGenerationDrift(templateName, driftedSource);
    assert.ok(refusal, `${templateName} must refuse an unregistered successor`);
    assert.match(refusal, /registered to install prompt generation/u);

    // The outgoing row is unaffected by that edit and still matches, which is
    // exactly why the source has to be checked separately.
    const generation = generationOf(templateName, "pre-runner-provided-regression-tooling");
    assert.notEqual(generation.promptDigest, CANONICAL_SOURCE_PROMPT_GENERATIONS[templateName]);
  }
});

test("bound direct revalidation is a registered structural rollover", async () => {
  const current = (await loadAllTemplateStepSources()).get("direct-engineer-workflow");
  assert.ok(current);
  const generation = generationOf("direct-engineer-workflow", "pre-revalidate-step");
  assert.equal(generation.shape.length, 7);
  assert.equal(
    matchedLegacyGeneration("direct-engineer-workflow", shapeAsPersisted(generation.shape)),
    "pre-revalidate-step",
  );
  assert.equal(matchedLegacyGeneration("direct-engineer-workflow", asPersisted(current)), null);
});

test("the pull-request workflow has a registered prompt-only generation", async () => {
  const sources = await loadAllTemplateStepSources();
  const current = sources.get(PR_TEMPLATE_NAME);
  assert.ok(current);
  const generation = generationOf(PR_TEMPLATE_NAME, "pre-pr-handover-quality");
  assert.equal(generation.promptDigest, "93a72d354876a6c26020e8638b6c365fb15e4ca4a400a2d6ca80084994f249d6");
  assert.equal(generation.shape.length, 4);
  // The retired graph against the current one, field by field through the
  // shared table: its review steps predate opting out of dependency
  // provisioning. The fix step moved to another Agent in the meantime, which
  // the retired shape does not read, so it is not a structural difference.
  assert.deepEqual(
    asPersisted(current).map((step, index) => retiredStepShapeDifferences(step, generation.shape[index]!)),
    [[], ["name", "provisionDependencies"], ["name", "provisionDependencies"], []],
  );
  assert.equal(templatePromptGenerationDigest(current), CANONICAL_SOURCE_PROMPT_GENERATIONS[PR_TEMPLATE_NAME]);
  assert.equal(matchedLegacyGeneration(PR_TEMPLATE_NAME, asPersisted(current)), null);
  const reviewedGeneration = generationOf(PR_TEMPLATE_NAME, "pre-pr-head-tree-check");
  assert.equal(reviewedGeneration.promptDigest, "805b9e911be94c84e451cdbf4d1cdb93ab10031c031c6854947f56d306fb1906");
  assert.notEqual(reviewedGeneration.promptDigest, templatePromptGenerationDigest(current));
  assert.deepEqual(reviewedGeneration.shape, generation.shape);
});

test("the internal npm scope rename is a registered prompt-only rollover", async () => {
  const sources = await loadAllTemplateStepSources();
  const retiredDigests = {
    "compound-engineer-workflow": "79845a3badc75200d30ac22cb4fb10c6efa38308c31156e7b15f4c8475e9f7ff",
  } as const;

  for (const templateName of ["compound-engineer-workflow"] as const) {
    const current = sources.get(templateName);
    assert.ok(current);
    const generation = generationOf(templateName, "pre-internal-npm-scope-rename");
    assert.equal(generation.promptDigest, retiredDigests[templateName]);
    assert.notEqual(generation.promptDigest, templatePromptGenerationDigest(current));
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
  }
});

test("the product rename is a registered prompt-only rollover in both templates", async () => {
  const sources = await loadAllTemplateStepSources();
  const retiredDigests = {
    "direct-engineer-workflow": "0aa379a51d722ec9b8b5d91bc6158d9dd9a1f5d380b50695613d5aece9afda46",
    "compound-engineer-workflow": "606f9b5a667781cde3400d114cc7f2ebf00bada6995eee07a7019b63e7dd8424",
  } as const;

  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    const generation = generationOf(templateName, "pre-product-rename-anneal");
    assert.equal(generation.promptDigest, retiredDigests[templateName]);
    assert.notEqual(generation.promptDigest, templatePromptGenerationDigest(current));
    // The retired generation carries the current shape, so only the digest
    // tells it apart from the graph that replaced it.
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
  }
});

test("runner-provided Regression tooling is a registered prompt-only rollover in both templates", async () => {
  const sources = await loadAllTemplateStepSources();
  const retiredDigests = {
    "direct-engineer-workflow": "c0ec5acb70b82b85bc3f3aff5840029a303d31e6098b7171a2bef35f105f3371",
    "compound-engineer-workflow": "27d552a220439bc091956173bc5ee12e5e7158b160fb015443a68f2e744e85d8",
  } as const;

  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    const generation = generationOf(templateName, "pre-runner-provided-regression-tooling");
    assert.equal(generation.promptDigest, retiredDigests[templateName]);
    assert.notEqual(generation.promptDigest, templatePromptGenerationDigest(current));
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
  }
});

test("optional review omission is a registered prompt-only rollover in both templates", async () => {
  const sources = await loadAllTemplateStepSources();
  const retiredDigests = {
    "direct-engineer-workflow": "e8fdf5533275e85e33b0cf812db9474b00214de2401e4c97bb6eb0732f864df8",
    "compound-engineer-workflow": "c3b3bb4692bda266e5afd81bb6ad258f58bd1eed14240f272338e0f44fa5e97e",
  } as const;

  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    const generation = generationOf(templateName, "pre-optional-review-omission");
    assert.equal(generation.promptDigest, retiredDigests[templateName]);
    assert.notEqual(generation.promptDigest, templatePromptGenerationDigest(current));
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
    // The rows that generation retired carried the outgoing prompts on its
    // shape: no optional steps, and the review steps opting out of dependency
    // provisioning as the source does. Those rows were staffed differently at
    // the fix step, which the shape no longer reads either way.
    assert.equal(
      legacyGenerationMatches(
        { marker: generation.marker, shape: generation.shape },
        asPersisted(current).map((step, index) => ({ ...step, name: generation.shape[index]!.name, optional: false })),
      ),
      true,
    );
  }
});

test("the Astra-low review-fix generation is kept on record and retired from matching", async () => {
  // PR #490 registered a generation whose only difference from its successor
  // was the Agent bound at the fix step. Under a fingerprint that no longer
  // reads bindings it states the current graph, so it is flagged rather than
  // deleted: the generation was published, and rows already renamed under its
  // marker still resolve their identity through it.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of Object.keys(LEGACY_TEMPLATE_GENERATIONS) as CanonicalTemplateRegistryName[]) {
    const current = sources.get(templateName);
    assert.ok(current, `${templateName} must load from source`);
    const generation = generationOf(templateName, "pre-astra-low-review-fix");
    assert.ok(generation);
    assert.equal(generation.marker, "pre-astra-low-review-fix");
    assert.equal(generation.retiredByBinding, true, templateName);
    assert.equal(generation.promptDigest, undefined, templateName);
    const fixIndex = current.findIndex((step) => step.outputKind === "fixed-implementation");
    assert.equal(current[fixIndex]!.agentName, "senior-dev-astra-low", templateName);

    // Apart from the later review rename, the rebinding left no structural
    // trace, which is the reason for the flag.
    assert.deepEqual(
      asPersisted(current).map((step, index) => retiredStepShapeDifferences(step, generation.shape[index]!)),
      current.map((step) => ["sol-findings", "blind-findings"].includes(step.outputKind) ? ["name"] : []),
      templateName,
    );
    assert.equal(legacyGenerationMatches(generation, asPersisted(current)), false, templateName);
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null, templateName);

    assert.deepEqual(
      canonicalTemplateIdentity(templateRolloverName(templateName, generation.marker, "template-row")),
      { canonicalName: templateName, generation: generation.marker },
      templateName,
    );
  }
});

test("no registered generation matches the current source graph of its template", async () => {
  // The invariant a binding in the fingerprint used to break: an entry that
  // matches the graph the source tree holds makes the installer plan a
  // rollover on every sync, and refuse the whole deploy under any active Run.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of Object.keys(LEGACY_TEMPLATE_GENERATIONS) as CanonicalTemplateRegistryName[]) {
    const current = sources.get(templateName);
    assert.ok(current, `${templateName} must load from source`);
    const rows = asPersisted(current);
    for (const generation of LEGACY_TEMPLATE_GENERATIONS[templateName]) {
      assert.equal(
        legacyGenerationMatches(generation, rows),
        false,
        `${templateName}:${generation.marker} matches the current source graph`,
      );
    }
    assert.equal(matchedLegacyGeneration(templateName, rows), null, templateName);
  }
});

test("two registered generations of one template are never both structural on one graph", () => {
  // A structural entry -- one with no prompt digest -- claims every row of its
  // graph. Two of them on one graph, which is what a pair differing only by an
  // Agent binding now is, cannot be told apart: the second could never match,
  // and the marker a row rolls over under would be whichever the registry
  // happens to list first. A digest entry may share a graph with a structural
  // one, and does: it is the more specific claim, so it is listed ahead of the
  // structural catch-all for that shape and matches its own rows first.
  for (const templateName of Object.keys(LEGACY_TEMPLATE_GENERATIONS) as CanonicalTemplateRegistryName[]) {
    const generations = LEGACY_TEMPLATE_GENERATIONS[templateName]
      .filter((generation) => generation.retiredByBinding !== true);
    for (const [index, generation] of generations.entries()) {
      const rows = shapeAsPersisted(generation.shape);
      const sameGraph = (other: (typeof generations)[number]): boolean => (
        generation.shape.length === other.shape.length
          && rows.every((row, stepIndex) => retiredStepShapeDifferences(row, other.shape[stepIndex]!).length === 0)
      );
      for (const other of generations.slice(index + 1)) {
        if (!sameGraph(other)) continue;
        assert.ok(
          generation.promptDigest !== undefined || other.promptDigest !== undefined,
          `${templateName}: ${generation.marker} and ${other.marker} are both structural on one graph`,
        );
        assert.ok(
          other.promptDigest === undefined || generation.promptDigest !== undefined,
          `${templateName}: ${other.marker} states a digest but ${generation.marker} claims its graph first`,
        );
      }
    }
  }
});

test("every registered generation, structural ones included, rolls straight to the current source", async () => {
  // No hand-kept marker list: the registry itself is the list, so a newly
  // registered generation is covered the moment it is added.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of Object.keys(LEGACY_TEMPLATE_GENERATIONS) as CanonicalTemplateRegistryName[]) {
    const current = sources.get(templateName);
    assert.ok(current, `${templateName} must load from source`);
    assert.equal(sourcePromptGenerationDrift(templateName, current), null, templateName);
  }
});

test("the next prompt-only rollover of the optional-review graphs is registrable", async () => {
  // The block the optional column left behind: the deployed direct and compound
  // graphs carry an optional blind review, so a prompt-only successor could not
  // be registered while the comparator asserted a fixed value for that field.
  // Registered here in test data only; the real registry is untouched.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current, `${templateName} must load from source`);
    assert.ok(
      current.some((step) => step.outputKind === "blind-findings" && step.optional),
      `${templateName} must still carry an optional blind review`,
    );
    const rows = asPersisted(current);
    const registered = {
      marker: "synthetic-prompt-only-successor",
      shape: current.map(asLegacyRecord),
      promptDigest: templatePromptGenerationDigest(rows),
    };

    assert.equal(legacyGenerationMatches(registered, rows), true, templateName);
    const successor = rows.map((step) => ({ ...step, prompt: `${step.prompt}\n\nthe replacement instruction` }));
    assert.equal(legacyGenerationMatches(registered, successor), false, templateName);
  }
});

test("a retired generation is identified without its prior-output whitelist", () => {
  // The whitelist migration rewrites this column on rows of every generation,
  // so reading it would refuse the rollover of any row it has not reached.
  const generation = generationOf("direct-engineer-workflow", "pre-adjudication");
  const rows = persistedGeneration(generation, true);
  assert.equal(legacyGenerationMatches(generation, rows), true);
  assert.equal(
    legacyGenerationMatches(
      generation,
      rows.map((step) => ({ ...step, priorOutputKinds: [LEGACY_ALL_PRIOR_OUTPUTS] })),
    ),
    true,
  );
});


test("model-neutral review names roll over exactly the deployed shapes and retain retired generation identity", async () => {
  const sources = await loadAllTemplateStepSources();
  for (const templateName of Object.keys(LEGACY_TEMPLATE_GENERATIONS) as CanonicalTemplateRegistryName[]) {
    const current = sources.get(templateName)!;
    const generation = generationOf(templateName, "model-neutral-review-step-names");
    const outgoing = asPersisted(current).map((step) => ({
      ...step,
      name: step.outputKind === "sol-findings" ? "Code review (Sol)"
        : step.outputKind === "blind-findings" ? "Code review (Opus blind)" : step.name,
    }));
    assert.equal(generation.promptDigest, undefined);
    assert.equal(matchedLegacyGeneration(templateName, outgoing), generation.marker);
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
    assert.deepEqual(canonicalTemplateIdentity(templateRolloverName(templateName, generation.marker, "row")), {
      canonicalName: templateName, generation: generation.marker,
    });
    for (const outputKind of ["sol-findings", "blind-findings"] as const) {
      const ordinal = current.findIndex((step) => step.outputKind === outputKind) + 1;
      assert.equal(current[ordinal - 1]!.name, outputKind === "sol-findings" ? "Code review" : "Blind code review");
    }
    assert.equal(templatePromptGenerationDigest(outgoing), CANONICAL_SOURCE_PROMPT_GENERATIONS[templateName]);
  }
});
