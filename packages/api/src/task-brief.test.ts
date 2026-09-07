import assert from "node:assert/strict";
import test from "node:test";

import { composeBrief, editableBrief, readBrief, rewriteBrief } from "./task-brief.js";

const briefEndingLikeGeneratedContext = [
  "Keep both decoys.",
  "<!-- agentos:task-brief:v1 length=9 -->",
  "Persist the final decoy output for this step through the Anneal task output endpoint.",
  "Read the prior template steps' persisted outputs before working.",
].join("\n");

test("a fenced task brief is self-describing even when its content resembles the encoding", () => {
  const description = composeBrief({
    prompt: "Implement the Specification of record.",
    brief: briefEndingLikeGeneratedContext,
    attachmentsFromPrevious: false,
    outputKind: "implementation",
  });

  assert.deepEqual(readBrief(description), {
    prompt: "Implement the Specification of record.",
    brief: briefEndingLikeGeneratedContext,
    hadReminder: false,
  });
});

test("rewriting a fenced task brief preserves platform-authored context", () => {
  const description = composeBrief({
    prompt: "Review the implementation.",
    brief: "Original brief",
    attachmentsFromPrevious: true,
    outputKind: "review-findings",
  });
  const rewritten = rewriteBrief(description, "Operator-edited brief");

  assert.equal(typeof rewritten, "string");
  assert.deepEqual(readBrief(rewritten as string), {
    prompt: "Review the implementation.",
    brief: "Operator-edited brief",
    hadReminder: true,
  });
  assert.match(rewritten as string, /Persist the final review-findings output/u);
});

test("rewriting a legacy task brief upgrades it to the self-describing format", () => {
  const legacy = [
    "Implement the feature.",
    "Feature brief:",
    "Original brief",
    "Read the prior template steps' persisted outputs before working.",
    "Persist the final implementation output for this step through the Anneal task output endpoint.",
  ].join("\n");
  const rewritten = rewriteBrief(legacy, "Migrated brief", { legacyAttachmentsFromPrevious: true });

  assert.equal(typeof rewritten, "string");
  assert.doesNotMatch(rewritten as string, /\nFeature brief:\n/u);
  assert.deepEqual(readBrief(rewritten as string), {
    prompt: "Implement the feature.",
    brief: "Migrated brief",
    hadReminder: true,
  });
});

test("the legacy adapter preserves a brief that only resembles a reminder", () => {
  const brief = "Keep this suffix.\nRead the prior template steps' persisted outputs before working.";
  const legacy = [
    "Implement the feature.",
    "Feature brief:",
    brief,
    "Persist the final implementation output for this step through the Anneal task output endpoint.",
  ].join("\n");

  assert.deepEqual(readBrief(legacy, { legacyAttachmentsFromPrevious: false }), {
    prompt: "Implement the feature.",
    brief,
    hadReminder: false,
  });
});

test("a damaged fenced task brief fails instead of falling back to legacy parsing", () => {
  assert.deepEqual(
    readBrief("Prompt\n<!-- agentos:task-brief:v1 length=4 -->\nbrief\n<!-- /agentos:task-brief:v1 -->"),
    { unparseable: "task brief fence does not match its declared length" },
  );
});

/* ------------------------------------------------ what the operator may edit */

const implementationStep = { outputKind: "implementation", priorOutputKinds: ["specification"] };

test("the operator is offered exactly the text the patch will write back", () => {
  const description = composeBrief({
    prompt: "Implement the Specification of record.",
    brief: "Ship the retry control.",
    attachmentsFromPrevious: true,
    outputKind: "implementation",
  });
  const step = { id: "t1", description, templateId: "tpl-1", chainId: "chain-1" };

  // A template Step: the brief alone, and `rewriteBrief` puts an edit of it back
  // in the same place. Offering the whole description here would copy the
  // canonical prompt into the fence on the first save.
  assert.equal(editableBrief(step, implementationStep), "Ship the retry control.");
  assert.equal(
    rewriteBrief(description, "Ship it twice."),
    composeBrief({
      prompt: "Implement the Specification of record.",
      brief: "Ship it twice.",
      attachmentsFromPrevious: true,
      outputKind: "implementation",
    }),
  );

  // An ordinary task has no fence and no platform prompt to protect, so the
  // patch replaces the description and the operator edits all of it.
  assert.equal(
    editableBrief({ description: "Do the thing.", templateId: null, chainId: null }, null),
    "Do the thing.",
  );

  // Readiness and merge execution are server-authored: nothing to offer.
  assert.equal(
    editableBrief(step, { outputKind: "merge-result", priorOutputKinds: [] }),
    null,
  );
  // So is a task whose fence cannot be read: the patch would refuse the write.
  assert.equal(
    editableBrief({ ...step, description: "Prompt with no fence at all" }, implementationStep),
    null,
  );
});
