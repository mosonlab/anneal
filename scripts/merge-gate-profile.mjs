#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const FAST_DOCUMENTS = new Set([
  "AGENTS.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/BRIEF-TEMPLATE.md",
  "docs/governance/task-routing-v1.md",
  "docs/public-snapshot.md",
  "docs/runbooks/gate-worker.md",
]);

export const FROZEN_RECORD_DIRECTORIES = [
  "docs/reviews/",
  "docs/merge-notes/",
  "docs/briefs/",
  "docs/plans/archive/",
];

const isFastDocument = (path) =>
  FAST_DOCUMENTS.has(path)
  || (path.endsWith(".md") && FROZEN_RECORD_DIRECTORIES.some((directory) => path.startsWith(directory)));

export function classifyDiff({ nameStatus, summary = "" }) {
  if (summary.trim() !== "") return "full";

  const fields = Buffer.isBuffer(nameStatus)
    ? nameStatus.toString("utf8").split("\0")
    : String(nameStatus).split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length === 0) return "full";

  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status !== "M" || path === undefined || !isFastDocument(path)) return "full";
    index += 2;
  }
  return "docs-only";
}

export function classifyRange({ root = process.cwd(), baseline, candidate }) {
  for (const [label, oid] of [["baseline", baseline], ["candidate", candidate]]) {
    if (!/^[0-9a-f]{40}$/u.test(oid ?? "")) throw new Error(`${label} must be a full lowercase object id`);
  }

  const common = { cwd: root, maxBuffer: 64 * 1024 * 1024 };
  const nameStatus = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", baseline, candidate, "--"],
    common,
  );
  const summary = execFileSync(
    "git",
    ["diff", "--summary", baseline, candidate, "--"],
    { ...common, encoding: "utf8" },
  );
  return classifyDiff({ nameStatus, summary });
}

const isCli = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  try {
    const [baseline, candidate, ...extra] = process.argv.slice(2);
    if (extra.length > 0) throw new Error("usage: merge-gate-profile.mjs <baseline-oid> <candidate-oid>");
    process.stdout.write(`${classifyRange({ baseline, candidate })}\n`);
  } catch (error) {
    console.error(`merge-gate profile: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
