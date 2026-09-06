import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DeployFailure } from "./quiet-window-lib.mjs";

export const DEPLOY_REQUIRED_ARTIFACT_PATHS = Object.freeze([
  "packages/github-client/dist",
  "packages/db/dist",
  "packages/api/dist",
  "packages/runner/dist",
  "packages/inbox/dist",
  "packages/merge-executor/dist",
  "apps/web/dist",
  "node_modules",
]);

export const DEPLOY_OPTIONAL_ARTIFACT_PATHS = Object.freeze([
  "packages/cli/dist",
]);

export const workspaceDependencyPaths = (root) => {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    throw new DeployFailure("workspace-layout-invalid", error?.code ?? "package-json-unreadable");
  }
  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.length === 0) {
    throw new DeployFailure("workspace-layout-invalid", "workspaces-must-be-a-nonempty-array");
  }
  const paths = [];
  for (const pattern of manifest.workspaces) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
      throw new DeployFailure("workspace-layout-invalid", `unsupported-workspace-pattern-${String(pattern)}`);
    }
    const parent = pattern.slice(0, -2);
    let entries;
    try {
      entries = readdirSync(join(root, parent), { withFileTypes: true });
    } catch (error) {
      throw new DeployFailure("workspace-layout-invalid", `${parent}-${error?.code ?? "unreadable"}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json"))) {
        paths.push(`${parent}/${entry.name}/node_modules`);
      }
    }
  }
  return Object.freeze([...new Set(paths)].sort());
};

export const deployArtifactPaths = (root) => Object.freeze([
  ...DEPLOY_REQUIRED_ARTIFACT_PATHS.slice(0, -1),
  ...DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  ...workspaceDependencyPaths(root),
  "node_modules",
]);

export const RELEASE_RUNTIME_PATHS = Object.freeze([
  ...DEPLOY_REQUIRED_ARTIFACT_PATHS,
  "packages/db/prisma",
  "packages/build-info/index.mjs",
  "packages/build-info/index.d.ts",
  "packages/build-info/package.json",
]);

/** Runtime material that completes the immutable release around its dist
 * trees and dependency graph: native addons, Prisma migrations,
 * runtime-loaded canonical sources, and Vite/runner assets all resolve
 * relative to the release root. */
export const DEPLOY_RELEASE_EXTRA_ARTIFACT_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "packages/db/prisma",
  "packages/db/src",
  "packages/build-info/index.mjs",
  "packages/build-info/index.d.ts",
  "packages/build-info/package.json",
  "packages/api/build/Release/control_plane_directory.node",
  "packages/runner/assets",
  "packages/runner/scripts/build-runtime-tools.mjs",
  "apps/web/vite.config.ts",
  "apps/web/src/lib/local-origin.ts",
  "agents/foundational.md",
  "agents/roles",
  "agents/templates",
  "scripts/deploy",
  "scripts/merge-lease-adapter.mjs",
  "scripts/merge-lease.sh",
]);

export const deployReleaseArtifactPaths = (root) => Object.freeze([
  ...deployArtifactPaths(root),
  ...DEPLOY_RELEASE_EXTRA_ARTIFACT_PATHS,
]);
