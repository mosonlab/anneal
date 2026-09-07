import { MERGE_TRAIN_OUTPUT_KIND, parseMergeTrainRecord } from "@anneal/db";

import type { RunnerConfig } from "./config.js";
import {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_SHA,
  readWorkspaceHandoffFile,
  type RegressionHandoffClaim,
} from "./regression-output-handoff.js";
import type { Workspace } from "./workspace.js";

export type MergeTrainOutputHandoff = {
  kind: typeof MERGE_TRAIN_OUTPUT_KIND;
  body: string;
  commitSha: string;
};

/**
 * Qualify the merge-train tool's record before it crosses the Runner's
 * control-plane seam. The tool writes the record into the workspace scratch
 * directory and never holds session credentials; this reader decides whether
 * the file is this Run's, well formed, and a record the control plane can
 * authorize from.
 *
 * Unlike a Regression verdict, the record makes no claim about the workspace
 * HEAD -- it is bound to the prefix object ids it names -- so `commitSha` is
 * carried as provenance rather than checked for equality with HEAD.
 */
export const readMergeTrainOutputHandoff = async (
  config: RunnerConfig,
  claim: RegressionHandoffClaim,
  workspace: Workspace,
): Promise<MergeTrainOutputHandoff | null> => {
  if (claim.task.templateStep?.outputKind !== MERGE_TRAIN_OUTPUT_KIND) return null;
  const raw = await readWorkspaceHandoffFile(config, workspace, "merge-train-output.json", "Merge train output");
  if (raw === null) return null;

  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    value = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Merge train output handoff is not valid JSON");
  }
  if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION) throw new Error("Merge train output handoff has an unsupported schemaVersion");
  if (value.runId !== claim.run.id) throw new Error(`Merge train output handoff belongs to Run ${String(value.runId)}, not ${claim.run.id}`);
  if (value.kind !== MERGE_TRAIN_OUTPUT_KIND) throw new Error(`Merge train output handoff has unexpected kind ${String(value.kind)}`);
  if (typeof value.body !== "string") throw new Error("Merge train output handoff body is not a string");
  if (typeof value.commitSha !== "string" || !HANDOFF_SHA.test(value.commitSha)) {
    throw new Error("Merge train output handoff commitSha is invalid");
  }
  const record = parseMergeTrainRecord(value.body);
  if (record.status === "invalid") throw new Error(`Merge train output handoff record is invalid: ${record.reason}`);
  return { kind: MERGE_TRAIN_OUTPUT_KIND, body: value.body, commitSha: value.commitSha };
};
