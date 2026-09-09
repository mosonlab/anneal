import { PR_TEMPLATE_NAME } from "./agent-contract.js";
import type {
  CanonicalTemplateRegistryName,
  LegacyTemplateGeneration,
} from "./canonical-template-transition.js";

/**
 * One prompt generation this repository has published, as the digest
 * `templatePromptGenerationDigest` computes over a template's ordered step
 * prompts.
 */
export type PublishedPromptGeneration = Readonly<{
  digest: string;
  /**
   * The marker of the structural transition that retired this generation, when
   * the retirement changed the graph's shape. A structural retirement is
   * identified by the shape alone, so no registered entry states this digest
   * and there is nothing else to point at. Absent on a prompt-only retirement,
   * whose registered entry carries this exact digest as its `promptDigest`.
   */
  retiredByShape?: string;
}>;

/**
 * Every prompt generation this repository has published, per canonical
 * template, oldest first. The last element is the generation the source tree
 * holds now; every earlier element is a generation an installation may still
 * be running, and must therefore be one the transition registry can roll over.
 *
 * This is the fact `2a558a72` was missing. Canonical sync installs the source
 * tree's prompts; the rows it finds carry whatever generation the last deploy
 * installed. A prompt-only edit that re-pins the source generation without
 * registering the outgoing one leaves those rows matching no registered
 * generation, so the sync cannot roll them over and refuses at the first step
 * an instantiated task references. Nothing in the tree could notice, because
 * the outgoing generation existed only in the previous state of the tree and
 * in production.
 *
 * Recorded here, it survives the edit. Appending the new generation makes the
 * outgoing one an earlier element, and `publishedGenerationDrift` then refuses
 * until the registry registers it -- in the merge gate, on the change that
 * edits the prompt, instead of on the deploy that installs it.
 *
 * The list starts at the generation each template held on 2026-09-04.
 * Generations published before that are covered by the registry entries that
 * already retire them; nothing in the tree records what they were, and
 * inventing digests for them would state facts this repository cannot check.
 *
 * A shape-only successor appends the unchanged digest after annotating the
 * outgoing entry with its structural retirement marker. The digest plus that
 * marker identifies the published graph; repeated unretired digests refuse.
 *
 * Append -- never rewrite the last element's digest. Rewriting it in place
 * asserts that the generation it named was never published, which for anything already on
 * main is false.
 */
export const PUBLISHED_PROMPT_GENERATIONS = {
  "direct-engineer-workflow": [
    { digest: "8dbdb5fc5348a01eef73bd5908c4e142b4b6ca01bbb063eaf4916173fdc51543", retiredByShape: "model-neutral-review-step-names" },
    { digest: "8dbdb5fc5348a01eef73bd5908c4e142b4b6ca01bbb063eaf4916173fdc51543" },
    { digest: "a1a15921c9a4592c05db1e0d6d42f95ab2aa8c0011102bd20bf4d3b67b1bd0a1", retiredByShape: "pre-model-neutral-review-output" },
    { digest: "04d473928d65443202bd68b6d865df61f26983fc35870cf43e5032279e1ed107" },
    { digest: "79921b8f06e1abbfdcd3db7132e48816edb68deda47082b9c2508b1b74067ca1" },
    { digest: "667f0aadce31cc62aa7043d6c46a1ee89d08ce4f8690bd5a5fe50a5fd5662abd" },
    { digest: "cea709c7937fb307648ca7a5be2ed6de14aef3747ee96cff53e4d34270b03536" },
  ],
  "compound-engineer-workflow": [
    { digest: "e1e95c18a408a0c1847508ed16d4c60ae3978007dfccdbfe50cd793ee8a78fa9", retiredByShape: "model-neutral-review-step-names" },
    { digest: "e1e95c18a408a0c1847508ed16d4c60ae3978007dfccdbfe50cd793ee8a78fa9" },
    { digest: "be4428549ef4c428fd82ea9e6315bee040bd7874561f2fcc362a49216497bb66", retiredByShape: "pre-model-neutral-review-output" },
    { digest: "6d0e84947f79d3c1307727d4d0cdfae7827828e488dc6a05c2a9366480791142" },
    { digest: "2a3634bc7c7f74a066ab8fce78c4e0f02f2f9ac65acdcf37e07c993c445bed2c" },
  ],
  [PR_TEMPLATE_NAME]: [
    { digest: "1c1169bf0586f6bb71f4ed34b3eb6b166828802a9b24c6b07844b2f526b5f8a8", retiredByShape: "model-neutral-review-step-names" },
    { digest: "1c1169bf0586f6bb71f4ed34b3eb6b166828802a9b24c6b07844b2f526b5f8a8" },
    { digest: "e1bbe7b7e56d287f1f4e7ea85beeef29bc84ab8c162882f1c4050540ca46f734", retiredByShape: "pre-model-neutral-review-output" },
    { digest: "93a909a5d88b6aa158f9f86155853d7aed7762b61bd56dc9a1b17b6e7051281f" },
  ],
} as const satisfies Readonly<Record<CanonicalTemplateRegistryName, readonly PublishedPromptGeneration[]>>;

const REGISTRY_FILE = "packages/db/src/canonical-template-transition.ts";
const PUBLISHED_FILE = "packages/db/src/canonical-published-generations.ts";

const retirementRefusal = (
  templateName: string,
  entry: PublishedPromptGeneration,
  registered: readonly LegacyTemplateGeneration[],
): string | null => {
  if (entry.retiredByShape !== undefined) {
    const structural = registered.find((generation) => generation.marker === entry.retiredByShape);
    if (!structural) {
      return `${templateName} published prompt generation ${entry.digest} names structural retirement ${entry.retiredByShape}, which ${REGISTRY_FILE} does not register`;
    }
    if (structural.promptDigest !== undefined) {
      return `${templateName} published prompt generation ${entry.digest} names ${entry.retiredByShape} as a structural retirement, but that entry registers prompt generation ${structural.promptDigest}; drop retiredByShape`;
    }
    return null;
  }
  const registration = registered.find((generation) => generation.promptDigest === entry.digest);
  if (!registration) {
    return `${templateName} published prompt generation ${entry.digest}, which no registered generation retires: add an entry to ${REGISTRY_FILE} carrying promptDigest ${entry.digest} and the shape those rows hold, or, when the retirement changed the shape, name that entry's marker as retiredByShape in ${PUBLISHED_FILE}`;
  }
  return null;
};

/**
 * The first reason this template's published generations are not a history the
 * transition registry can transition from, or null when they are.
 *
 * Pure in all four arguments so the invariant can be exercised against
 * fixtures rather than only against the canonical constants.
 */
export const publishedGenerationDrift = (
  templateName: string,
  published: readonly PublishedPromptGeneration[],
  registered: readonly LegacyTemplateGeneration[],
  sourceGeneration: string,
): string | null => {
  const current = published.at(-1);
  if (!current) {
    return `${templateName} publishes no prompt generation at all; ${PUBLISHED_FILE} must name the generation the source tree holds`;
  }
  const duplicate = published.find((entry, index) => (
    published.findIndex((candidate) => candidate.digest === entry.digest
      && candidate.retiredByShape === entry.retiredByShape) !== index
  ));
  if (duplicate) {
    return `${templateName} publishes prompt generation ${duplicate.digest} twice; a generation is published once`;
  }
  if (current.retiredByShape !== undefined) {
    return `${templateName} names a retirement for prompt generation ${current.digest}, which the source tree still holds`;
  }
  if (current.digest !== sourceGeneration) {
    return `${templateName} last published prompt generation ${current.digest}, but the source tree now holds ${sourceGeneration}: append { digest: "${sourceGeneration}" } in ${PUBLISHED_FILE}, then register ${current.digest} as a retired generation in ${REGISTRY_FILE}`;
  }
  for (const entry of published.slice(0, -1)) {
    const refusal = retirementRefusal(templateName, entry, registered);
    if (refusal !== null) return refusal;
  }
  return null;
};
