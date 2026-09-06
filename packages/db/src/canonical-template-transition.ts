import { createHash } from "node:crypto";

import { AssigneeType } from "@prisma/client";

import { DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME } from "./agent-contract.js";
import { retiredStepShapeDifferences, type LegacyStepRecord } from "./template-step-fields.js";
import type { PersistedTemplateStepStructure } from "./template-sources.js";

/**
 * Every retired canonical graph, keyed by the marker its renamed rows carry.
 * These are intentionally a closed contract: a row with the canonical name is
 * either one of these exact graphs or the current source graph. It is never
 * guessed at and it is never linearized as a fallback.
 *
 * `pre-narrow-regression-lease`: the v1 Regression graphs that acquired before
 * semantic verification and let a model share the lease protocol.
 * `pre-adjudication`: the graphs that existed immediately before the
 * adjudication node was removed.
 * `pre-zero-gate`: the compound graph that existed immediately before the
 * spec and revise-plan approval gates were removed (2026-08-26 ruling); the
 * direct graph did not change in that transition.
 * `pre-blind-review-retirement`: the graphs that existed immediately before the
 * merge tail's independent blind review and the release-authority signature
 * layer were retired (2026-08-26 ruling). This is the first generation whose
 * structure is identical to its successor's; it is told apart by
 * `promptDigest`, and the note on that field explains why that is sound.
 * `pre-platform-spec-materialization`: the direct graph whose implementation
 * prompt still delegated exact specification transcription to the model.
 * `pre-internal-npm-scope-rename`: the graphs whose merge prompts still named
 * the retired first-party npm scope.
 * `pre-revalidate-step`: the direct graph before bound chains gained their
 * read-only revalidation node.
 * `pre-product-rename-anneal`: the graphs whose prompts still called the
 * platform by its former product name. Prompt-only in both templates.
 * `pre-runner-provided-regression-tooling`: the graphs whose Regression
 * prompts still resolved the platform script through the repository checkout.
 * `pre-optional-review-omission`: the graphs whose fix and Regression prompts
 * still required both review reports, before the blind review step became
 * optional. Prompt-only in both templates.
 * `pre-pr-handover-quality`: the pull-request graph whose prompts still used
 * the placeholder delivery body and left chain bookkeeping in the published
 * tree.
 * `pre-pr-head-tree-check`: the first handover-quality prompt generation,
 * whose cleanup verification inspected the index rather than committed HEAD.
 * `pre-astra-low-review-fix`: the graphs whose review-fix step was still bound
 * to the Astra-medium senior developer before it moved to
 * `senior-dev-astra-low`. Agent-only in all three templates, so it carries
 * `retiredByBinding` and is a published-generation record rather than a
 * structural match.
 * `model-neutral-review-step-names`: the graphs whose review labels named
 * their default models, before staffing-independent display names.
 * `pre-salvage-resume`: the graphs whose review-fix prompts still stopped at
 * every reviewed-head mismatch, before a Run that starts on the `WIP salvage`
 * commit of its own prior failed attempt was told to continue from it.
 * Prompt-only in all three templates, on top of the renamed review steps.
 */
export type LegacyTemplateGeneration = Readonly<{
  marker: string;
  shape: readonly LegacyStepRecord[];
  /**
   * Whether this entry is retired from structural matching because a binding
   * was its only difference from its successor.
   *
   * A step's Agent is staffing, not structure, so it left the fingerprint. An
   * entry registered when it was still in it now states the same graph as the
   * graph that replaced it, and would match every deployed row forever: the
   * installer matches retired generations before it checks the current graph,
   * so every sync would plan a rollover and refuse under any active Run. The
   * entry stays to identify rows renamed under its published marker; only
   * structural matching skips it.
   */
  retiredByBinding?: boolean;
  /**
   * The prompt generation this entry retires, as a digest over its ordered step
   * prompts, or absent when the structure alone identifies it.
   *
   * A structural change is its own evidence that a graph was retired, so the
   * generations that carry one need nothing more. A prompt-only change is not:
   * the outgoing and incoming graphs have identical structure, so without this
   * field the successor would match its own predecessor's entry and every sync
   * would roll the row over again, forever.
   *
   * Registering it stays a deliberate act. This is not "the prompt changed, so
   * roll" -- nothing computes a rollover from drift. An operator writes the
   * outgoing generation's digest here by hand, exactly as they write a shape,
   * and a prompt edit with no entry still refuses the deploy rather than
   * migrating anything on its own.
   *
   * The generation an entry rolls *forward to* is not stated here. Every
   * rollover of a template installs that template's one current source
   * generation, pinned once in `CANONICAL_SOURCE_PROMPT_GENERATIONS`.
   */
  promptDigest?: string;
}>;

const legacyTemplateGenerations = {
  [DIRECT_TEMPLATE_NAME]: [
    {
      marker: "pre-narrow-regression-lease",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-adjudication",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Opus adjudication", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "must-fix", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 3, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-blind-review-retirement",
      // Structurally identical to the current graph on purpose: this transition
      // changed prompts only. `promptDigest` is what tells the two apart.
      promptDigest: "1b2447559a77e28added3509a6f6b17bce8a8cd7db9113bdaaa17d581d874165",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-platform-spec-materialization",
      promptDigest: "c1a9ec1f8e783c3c814c0d0f5f4a9b91d5759b9dc39473dc200447aeb96677c5",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only rollover: regression now delegates mechanical work to the
      // platform script while keeping the template graph unchanged.
      marker: "pre-regression-step-split",
      promptDigest: "a760a6ca04bc047b47831fc4a4064cf2157487142f32a480223d6b5d8187c4a1",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-internal-npm-scope-rename",
      promptDigest: "3b50afcdd5aef2d0f06b00b7644cc67fac3ffbd29414e44564dc6aeb9757580d",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      // Structural rollover: the bound direct graph adds a read-only
      // revalidation node ahead of the historical seven-step graph. Existing
      // task and step rows stay under the renamed legacy template; only new
      // bound chains use the successor graph.
      marker: "pre-revalidate-step",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only, and the first direct entry to carry the bound eight-step
      // shape: the graphs it retires are the ones that already materialized the
      // revalidation node, so an unbound seven-step row still matches
      // `pre-revalidate-step` above and rolls over structurally as before.
      marker: "pre-product-rename-anneal",
      promptDigest: "0aa379a51d722ec9b8b5d91bc6158d9dd9a1f5d380b50695613d5aece9afda46",
      shape: [
        { name: "Revalidate specification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revalidation", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-runner-provided-regression-tooling",
      promptDigest: "c0ec5acb70b82b85bc3f3aff5840029a303d31e6098b7171a2bef35f105f3371",
      shape: [
        { name: "Revalidate specification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revalidation", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-optional-review-omission",
      promptDigest: "e8fdf5533275e85e33b0cf812db9474b00214de2401e4c97bb6eb0732f864df8",
      shape: [
        { name: "Revalidate specification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revalidation", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null, provisionDependencies: false },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
    {
      // Agent-only: the review-fix step moved from the Astra-medium senior
      // developer to senior-dev-astra-low. Under a fingerprint that no longer
      // reads bindings this states the current graph, so it is kept as the
      // published-generation record and excluded from matching.
      marker: "pre-astra-low-review-fix",
      retiredByBinding: true,
      shape: [
        { name: "Revalidate specification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revalidation", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null, provisionDependencies: false },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, optional: true, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
    {
      marker: "model-neutral-review-step-names",
      shape: [
        { name: "Revalidate specification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revalidation", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null, provisionDependencies: false },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, optional: true, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only rollover on top of the renamed review steps: the
      // review-fix prompt now lets a Run that starts on the `WIP salvage`
      // commit of its own prior failed attempt continue from it instead of
      // stopping. The graph is unchanged, so `promptDigest` authenticates
      // the outgoing generation.
      marker: "pre-salvage-resume",
      promptDigest: "8dbdb5fc5348a01eef73bd5908c4e142b4b6ca01bbb063eaf4916173fdc51543",
      shape: [
        { name: "Revalidate specification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revalidation", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Code review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null, provisionDependencies: false },
        { name: "Blind code review", assigneeType: AssigneeType.AGENT, approvalGate: false, optional: true, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 2, layer: 3, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 6, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
      ],
    },
  ],
  "compound-engineer-workflow": [
    {
      marker: "pre-narrow-regression-lease",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-adjudication",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: true, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: true, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Opus adjudication", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "must-fix", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 7, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 12, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-zero-gate",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: true, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: true, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-blind-review-retirement",
      // Structurally identical to the current graph on purpose: this transition
      // changed prompts only. `promptDigest` is what tells the two apart.
      promptDigest: "a9994d131d1cf2667c6d61cc7161f5653cf9903a6aae77ed55c18b1db6fb3cf2",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only rollover: regression now delegates mechanical work to the
      // platform script while keeping the template graph unchanged.
      marker: "pre-regression-step-split",
      promptDigest: "74fe9add0789494efce82d477ea472ce2a16132fe105e6f12c87223c18dbabf8",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-internal-npm-scope-rename",
      promptDigest: "79845a3badc75200d30ac22cb4fb10c6efa38308c31156e7b15f4c8475e9f7ff",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-product-rename-anneal",
      promptDigest: "606f9b5a667781cde3400d114cc7f2ebf00bada6995eee07a7019b63e7dd8424",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-runner-provided-regression-tooling",
      promptDigest: "27d552a220439bc091956173bc5ee12e5e7158b160fb015443a68f2e744e85d8",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "pre-optional-review-omission",
      promptDigest: "c3b3bb4692bda266e5afd81bb6ad258f58bd1eed14240f272338e0f44fa5e97e",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null, provisionDependencies: false },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      // Agent-only: the review-fix step moved from the Astra-medium senior
      // developer to senior-dev-astra-low. Under a fingerprint that no longer
      // reads bindings this states the current graph, so it is kept as the
      // published-generation record and excluded from matching.
      marker: "pre-astra-low-review-fix",
      retiredByBinding: true,
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null, provisionDependencies: false },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, optional: true, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      marker: "model-neutral-review-step-names",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null, provisionDependencies: false },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, optional: true, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only rollover on top of the renamed review steps: the
      // review-fix prompt now lets a Run that starts on the `WIP salvage`
      // commit of its own prior failed attempt continue from it instead of
      // stopping. The graph is unchanged, so `promptDigest` authenticates
      // the outgoing generation.
      marker: "pre-salvage-resume",
      promptDigest: "e1e95c18a408a0c1847508ed16d4c60ae3978007dfccdbfe50cd793ee8a78fa9",
      shape: [
        { name: "Write a spec", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "spec", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: false, baseFromStepIndex: null, layer: 2, spawnPolicy: null },
        { name: "Plan review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "plan-review", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
        { name: "Revise plan", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "revised-plan", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 4, spawnPolicy: null },
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: true, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 5, spawnPolicy: null },
        { name: "Code review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null, provisionDependencies: false },
        { name: "Blind code review", assigneeType: AssigneeType.AGENT, approvalGate: false, optional: true, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 5, layer: 6, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 7, spawnPolicy: null },
        { name: "Librarian", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "documentation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 8, spawnPolicy: null },
        { name: "Regression verification", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "regression-verification-v2", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 9, spawnPolicy: null },
        { name: "Merge authorization", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-authorization", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 10, spawnPolicy: null },
        { name: "Merge execution", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "merge-result", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 11, spawnPolicy: null },
      ],
    },
  ],
  [PR_TEMPLATE_NAME]: [
    {
      // Prompt-only rollover: PR delivery now publishes the implementation
      // evidence and cleans the tracked chain bookkeeping in the fix step.
      // The graph is unchanged, so both prompt digests authenticate the
      // outgoing and successor generations.
      marker: "pre-pr-handover-quality",
      promptDigest: "93a72d354876a6c26020e8638b6c365fb15e4ca4a400a2d6ca80084994f249d6",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only review fix: cleanup verification now authenticates the
      // committed HEAD tree, not the mutable index.
      marker: "pre-pr-head-tree-check",
      promptDigest: "805b9e911be94c84e451cdbf4d1cdb93ab10031c031c6854947f56d306fb1906",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
      ],
    },
    {
      // Agent-only: the review-fix step moved from the Astra-medium senior
      // developer to senior-dev-astra-low. Under a fingerprint that no longer
      // reads bindings this states the current graph, so it is kept as the
      // published-generation record and excluded from matching.
      marker: "pre-astra-low-review-fix",
      retiredByBinding: true,
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null, provisionDependencies: false },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
      ],
    },
    {
      marker: "model-neutral-review-step-names",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review (Sol)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null, provisionDependencies: false },
        { name: "Code review (Opus blind)", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
      ],
    },
    {
      // Prompt-only rollover on top of the renamed review steps: the
      // review-fix prompt now lets a Run that starts on the `WIP salvage`
      // commit of its own prior failed attempt continue from it instead of
      // stopping. The graph is unchanged, so `promptDigest` authenticates
      // the outgoing generation.
      marker: "pre-salvage-resume",
      promptDigest: "1c1169bf0586f6bb71f4ed34b3eb6b166828802a9b24c6b07844b2f526b5f8a8",
      shape: [
        { name: "Implementation", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false, requiresCommit: true, opensPullRequest: true, baseFromStepIndex: null, layer: 1, spawnPolicy: null },
        { name: "Code review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "sol-findings", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null, provisionDependencies: false },
        { name: "Blind code review", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "blind-findings", attachmentsFromPrevious: false, opensPullRequest: false, baseFromStepIndex: 1, layer: 2, spawnPolicy: null, provisionDependencies: false },
        { name: "Apply review fixes", assigneeType: AssigneeType.AGENT, approvalGate: false, outputKind: "fixed-implementation", attachmentsFromPrevious: true, opensPullRequest: false, baseFromStepIndex: null, layer: 3, spawnPolicy: null },
      ],
    },
  ],
} as const satisfies Readonly<Record<string, readonly LegacyTemplateGeneration[]>>;

export type CanonicalTemplateRegistryName = keyof typeof legacyTemplateGenerations;

export const LEGACY_TEMPLATE_GENERATIONS: Readonly<
  Record<CanonicalTemplateRegistryName, readonly LegacyTemplateGeneration[]>
> = legacyTemplateGenerations;

/**
 * The prompt generation each canonical template's source tree holds, as the
 * digest `templatePromptGenerationDigest` computes over its ordered step
 * prompts. One value per template; no registered generation restates it.
 *
 * `promptDigest` authenticates the row a rollover retires. On its own that is
 * only half the transition: it says nothing about what the source tree holds
 * when the rollover finally runs. Everywhere else an unregistered prompt edit
 * refuses the deploy because the persisted step is referenced by instantiated
 * tasks and its prompt no longer matches source. Writing a template row has no
 * such witness: a rollover renames the retired row away and writes a brand-new
 * row from source, first installation writes one into a project that had none,
 * and a brand-new row is referenced by nothing. Without this pin, prompts
 * edited between registering a rollover and deploying it would be installed on
 * the registered transition's authority, and onboarding a project would install
 * whatever the tree happened to hold.
 *
 * It is pinned rather than read from the tree on purpose: a digest computed
 * from the same tree it is meant to authenticate proves nothing. Re-pin it, in
 * the same change that edits a canonical prompt, from the value
 * `npm run db:template-digest` prints. It cannot go stale unnoticed --
 * `canonical-template-transition.test.ts` recomputes every entry here from
 * `agents/templates/` and fails on a mismatch.
 */
export const CANONICAL_SOURCE_PROMPT_GENERATIONS = {
  [DIRECT_TEMPLATE_NAME]: "a1a15921c9a4592c05db1e0d6d42f95ab2aa8c0011102bd20bf4d3b67b1bd0a1",
  "compound-engineer-workflow": "be4428549ef4c428fd82ea9e6315bee040bd7874561f2fcc362a49216497bb66",
  [PR_TEMPLATE_NAME]: "e1bbe7b7e56d287f1f4e7ea85beeef29bc84ab8c162882f1c4050540ca46f734",
} as const satisfies Readonly<Record<CanonicalTemplateRegistryName, string>>;

export type CanonicalTemplateIdentity = Readonly<{
  canonicalName: CanonicalTemplateRegistryName;
  generation: string | null;
}>;

const registeredGenerations = (canonicalName: string): readonly LegacyTemplateGeneration[] | null =>
  Object.hasOwn(LEGACY_TEMPLATE_GENERATIONS, canonicalName)
    ? LEGACY_TEMPLATE_GENERATIONS[canonicalName as CanonicalTemplateRegistryName]
    : null;

/**
 * Seed-era rename identities predate the closed structural transition contract.
 * Seed still authenticates those predecessor graphs with its historical
 * predicates. Register their names here without granting sync new structural
 * rollover authority or inventing shapes for their retired output protocols.
 */
const SEED_LEGACY_TEMPLATE_MARKERS = {
  "compound-engineer-workflow": ["10", "9", "human-12", "regression-first-13"],
  [DIRECT_TEMPLATE_NAME]: ["human-6"],
  [PR_TEMPLATE_NAME]: [],
} as const satisfies Readonly<Record<CanonicalTemplateRegistryName, readonly string[]>>;

const generationMarkers = (name: CanonicalTemplateRegistryName): readonly string[] => [
  ...LEGACY_TEMPLATE_GENERATIONS[name].map(({ marker }) => marker),
  ...SEED_LEGACY_TEMPLATE_MARKERS[name],
];
const REGISTERED_MARKERS: Readonly<Record<CanonicalTemplateRegistryName, readonly string[]>> = {
  "compound-engineer-workflow": generationMarkers("compound-engineer-workflow"),
  [DIRECT_TEMPLATE_NAME]: generationMarkers(DIRECT_TEMPLATE_NAME),
  [PR_TEMPLATE_NAME]: generationMarkers(PR_TEMPLATE_NAME),
};

/** Fixed identities used before per-row rollover names were introduced. */
export const LEGACY_INTEGRATOR_TEMPLATE_NAME = "compound-engineer-workflow-legacy-v1";
export const LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME = `${DIRECT_TEMPLATE_NAME}-legacy-v1`;
const FIXED_LEGACY_IDENTITIES: Readonly<Record<string, CanonicalTemplateIdentity>> = {
  [LEGACY_INTEGRATOR_TEMPLATE_NAME]: { canonicalName: "compound-engineer-workflow", generation: "v1" },
  [LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME]: { canonicalName: DIRECT_TEMPLATE_NAME, generation: "v1" },
};

/**
 * Resolve a current or registered retired canonical template name through the
 * registry. Legacy names include a row id after the generation marker; a bare
 * prefix is not an identity minted by `legacyTemplateName`.
 */
export const canonicalTemplateIdentity = (templateName: string): CanonicalTemplateIdentity | null => {
  if (Object.hasOwn(FIXED_LEGACY_IDENTITIES, templateName)) return FIXED_LEGACY_IDENTITIES[templateName]!;
  for (const canonicalName of Object.keys(LEGACY_TEMPLATE_GENERATIONS) as CanonicalTemplateRegistryName[]) {
    if (templateName === canonicalName) return { canonicalName, generation: null };
    for (const marker of REGISTERED_MARKERS[canonicalName]) {
      const prefix = `${canonicalName}-legacy-${marker}-`;
      if (templateName.startsWith(prefix) && templateName.length > prefix.length) {
        return { canonicalName, generation: marker };
      }
    }
  }
  return null;
};

/**
 * The prompt generation of an ordered step set, as one digest.
 *
 * Ordering is by `stepIndex` rather than by array order so a caller cannot
 * change the answer by handing the same graph back in a different order, and
 * each step contributes its index as well as its text so that moving a prompt
 * between two steps is a different generation from leaving it in place. The
 * separators are NUL because a prompt body can contain any printable run,
 * including one that would otherwise let two different step sets serialize to
 * the same bytes.
 */
export const templatePromptGenerationDigest = (
  steps: readonly { stepIndex: number; prompt: string }[],
): string => {
  const hash = createHash("sha256");
  for (const step of [...steps].sort((left, right) => left.stepIndex - right.stepIndex)) {
    hash.update(`${String(step.stepIndex)}\u0000${step.prompt}\u0000`);
  }
  return hash.digest("hex");
};

export const legacyGenerationMarkerForTemplateName = (templateName: string): string | null =>
  canonicalTemplateIdentity(templateName)?.generation ?? null;

/**
 * The rename target is minted per row and per generation: fixed identities
 * like `-legacy-v1` are already taken by older graphs, so each retired
 * generation needs an identity of its own to roll over onto.
 */
const legacyTemplateName = (templateName: string, marker: string, templateId: string): string => {
  if (!Object.hasOwn(LEGACY_TEMPLATE_GENERATIONS, templateName)
    || !REGISTERED_MARKERS[templateName as CanonicalTemplateRegistryName].includes(marker)) {
    throw new Error(`Unregistered legacy template generation: ${templateName} / ${marker}`);
  }
  if (templateId.length === 0) throw new Error("A legacy template name requires a row id");
  return `${templateName}-legacy-${marker}-${templateId}`;
};

/** Registry-owned rename target for a registered transition generation. */
export const templateRolloverName = (templateName: string, marker: string, templateId: string): string =>
  legacyTemplateName(templateName, marker, templateId);

/**
 * Seed rollover keeps the historical template row and its step ids intact so
 * already-materialized tasks retain their runtime contract. The template id in
 * this marker makes the rename deterministic and collision-free on retries.
 */
export const legacyTenStepTemplateName = (templateId: string): string =>
  legacyTemplateName("compound-engineer-workflow", "10", templateId);

export const legacyNineStepTemplateName = (templateId: string): string =>
  legacyTemplateName("compound-engineer-workflow", "9", templateId);

export const legacyHumanTwelveStepTemplateName = (templateId: string): string =>
  legacyTemplateName("compound-engineer-workflow", "human-12", templateId);

export const legacyRegressionFirstThirteenStepTemplateName = (templateId: string): string =>
  legacyTemplateName("compound-engineer-workflow", "regression-first-13", templateId);

export const legacyHumanSixStepTemplateName = (templateId: string): string =>
  legacyTemplateName(DIRECT_TEMPLATE_NAME, "human-6", templateId);

/**
 * A quiescent chain may move under a legacy template name without changing any
 * task or step identity. Its tasks keep the retired graph and runtime contract;
 * only new chains bind the replacement graph. Active Runs and unfinished work
 * that has no chain identity remain blockers.
 */
export const templateRolloverBlockers = <T extends { chainId: string | null; activeRunCount: number }>(
  tasks: readonly T[],
): T[] => tasks.filter((task) => task.activeRunCount > 0 || task.chainId === null);

/** The adjudication-era rename, kept for the rows and fixtures already carrying it. */
export const legacyAdjudicationTemplateName = (templateName: string, templateId: string): string =>
  legacyTemplateName(templateName, "pre-adjudication", templateId);

/**
 * A persisted step as a transition reads it: the structural columns every
 * row-vs-spec comparison uses, plus the identity, prompt and task count a
 * rollover decision needs. `optional` is required here because every row a
 * transition sees carries the column.
 */
export type PersistedTransitionStep = PersistedTemplateStepStructure & {
  id: string;
  taskTemplateId: string;
  stepIndex: number;
  optional: boolean;
  prompt: string;
  _count?: { tasks: number };
};

/**
 * Whether a persisted graph is exactly the graph a generation registered:
 * contiguous step indexes from 1, and every structural field of every step
 * equal to what the record states.
 */
const shapeMatches = (
  steps: readonly PersistedTransitionStep[],
  expected: readonly LegacyStepRecord[],
): boolean => {
  if (steps.length !== expected.length) return false;
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  if (ordered.some((step, index) => step.stepIndex !== index + 1)) return false;
  return ordered.every((step, index) => retiredStepShapeDifferences(step, expected[index]!).length === 0);
};

/**
 * The marker of the retired generation this persisted graph is, or null when
 * it is none of them (the caller then checks it against the current source
 * graph).
 *
 * Generations never overlap. A generation that changed the shape is told apart
 * by the shape; a generation that changed only the prompts is told apart by
 * `promptDigest`, which its successor by construction does not share. So at
 * most one entry can match, and the current source graph matches none.
 */
/**
 * A named reason the source tree does not hold the prompt generation this
 * template is registered to install, or null when it does.
 *
 * Every write of this template installs the same thing -- the current source
 * graph -- so this is asked once per template rather than once per retired
 * generation, and it covers first installation and structural rollovers as
 * well as prompt-only ones.
 */
export const sourcePromptGenerationDrift = (
  templateName: CanonicalTemplateRegistryName,
  sourceSteps: readonly { stepIndex: number; prompt: string }[],
): string | null => {
  const registered = CANONICAL_SOURCE_PROMPT_GENERATIONS[templateName];
  const actual = templatePromptGenerationDigest(sourceSteps);
  if (actual === registered) return null;
  return `${templateName} is registered to install prompt generation ${registered}, but the source tree holds ${actual}`;
};

export const legacyGenerationMatches = (
  generation: LegacyTemplateGeneration,
  steps: readonly PersistedTransitionStep[],
): boolean => {
  // An entry whose only difference from its successor was a binding states the
  // current graph; matching it would roll every deployed row over on every sync.
  if (generation.retiredByBinding === true) return false;
  if (!shapeMatches(steps, generation.shape)) return false;
  // An entry without a digest is identified by its shape alone. An entry with
  // one is a prompt-only transition, whose successor has the same shape, so the
  // digest is the whole difference between "this is the graph we retired" and
  // "this is the graph that replaced it".
  if (generation.promptDigest === undefined) return true;
  return generation.promptDigest === templatePromptGenerationDigest(steps);
};

export const matchedLegacyGeneration = (
  templateName: string,
  steps: readonly PersistedTransitionStep[],
): string | null =>
  registeredGenerations(templateName)
    ?.find((generation) => legacyGenerationMatches(generation, steps))?.marker ?? null;
