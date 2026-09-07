import type { BranchAncestryReader } from "./github-read.js";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import type { PrismaClient } from "@anneal/db";

import { createApp as createLiveApp } from "./app.js";
import { defaultControlPlaneStateDir } from "./control-plane-state.js";
import type { MergeLeaseHolderReader, ReleaseMergeLease } from "./merge-lease.js";
import type { preflightOnboardingRepository, RepositoryPreflight } from "./onboarding-preflight.js";
import type { ProjectBootstrapLoaders } from "./project-bootstrap.js";
import type { SpecificationReader } from "./specification-fidelity.js";
import { defaultWorkspaceRoot } from "./workspace-root.js";

// Symlink aliases (/tmp vs /private/tmp, a symlinked home) must not slip a
// forbidden root past a string comparison. Nonexistent paths cannot alias
// anything on disk, so plain resolution is enough for them.
const canonicalize = (path: string): string => {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
};

// Mirrors control-plane-state.ts: an operator running the control plane with
// CONTROL_PLANE_STATE_DIR relocated keeps owner.json records there, not in
// the default dir.
const controlPlaneStateDir = (): string => process.env.CONTROL_PLANE_STATE_DIR ?? defaultControlPlaneStateDir();

/**
 * Roots a test process must never sweep: the production default, plus every
 * canonical root recorded by a control plane on this machine. Read fresh on
 * each check — a control plane may acquire a root while tests are running.
 */
const forbiddenRoots = (): Set<string> => {
  const roots = new Set<string>([canonicalize(defaultWorkspaceRoot())]);
  try {
    for (const entry of readdirSync(controlPlaneStateDir())) {
      try {
        const owner = JSON.parse(readFileSync(join(controlPlaneStateDir(), entry, "owner.json"), "utf8")) as {
          canonicalWorkspaceRoot?: string;
        };
        if (owner.canonicalWorkspaceRoot) roots.add(canonicalize(owner.canonicalWorkspaceRoot));
      } catch {
        // Unreadable state entries cannot veto the check; the production
        // default above is always enforced.
      }
    }
  } catch {
    // No control-plane state dir on this machine.
  }
  return roots;
};

const assertRootIsDisposable = (root: string): string => {
  const resolved = canonicalize(root);
  if (forbiddenRoots().has(resolved)) {
    throw new Error(
      `test-app refuses workspace root ${resolved}: it is the production default or a control-plane-owned root. `
      + "Tests must use an isolated temporary directory (mkdtemp).",
    );
  }
  return resolved;
};

/**
 * Test-only capability. Production imports createApp directly from app.ts.
 *
 * The workspace root MUST be provided (option or RUNNER_WORKSPACE_ROOT) and
 * must not be the production default or any control-plane-owned root — even
 * explicitly. Destructive routes re-run that check on every call via
 * assertHeld, so a root that becomes owned mid-test also fails closed.
 * (2026-08-18 incident: this factory used to default to the production root
 * with a no-op ownership stub; one dbtest with a scratch database swept the
 * entire live workspace root.)
 */
export const createApp = (db: PrismaClient, options: {
  workspaceRoot?: string;
  repositoryReader?: BranchAncestryReader | undefined;
  onboardingRepositoryPreflight?: typeof preflightOnboardingRepository;
  repositoryPreflight?: RepositoryPreflight;
  projectBootstrapLoaders?: Partial<ProjectBootstrapLoaders>;
  releaseMergeLease?: ReleaseMergeLease;
  readMergeLeaseHolder?: MergeLeaseHolderReader;
  specificationReader?: SpecificationReader | null;
} = {}) => {
  const configured = options.workspaceRoot ?? process.env.RUNNER_WORKSPACE_ROOT;
  if (!configured) {
    throw new Error(
      "test-app requires an explicit workspace root: pass { workspaceRoot } or set RUNNER_WORKSPACE_ROOT to an isolated temporary directory.",
    );
  }
  const root = assertRootIsDisposable(configured);
  // The app no longer deletes anything (issue #115), but the guard stays: it is
  // what makes a test process that points a scratch database at an owned root
  // fail loudly instead of quietly, and it is cheap.
  return createLiveApp(db, {
    ownership: { assertHeld: () => { assertRootIsDisposable(root); } },
    onboardingRepositoryPreflight: options.onboardingRepositoryPreflight ?? (async () => {}),
    repositoryPreflight: options.repositoryPreflight ?? (async () => {}),
    ...(options.projectBootstrapLoaders === undefined ? {} : { projectBootstrapLoaders: options.projectBootstrapLoaders }),
    releaseMergeLease: options.releaseMergeLease ?? (async () => {}),
    // A test never shells out to origin unless it says so: the default is the
    // answer a lease-free origin gives.
    readMergeLeaseHolder: options.readMergeLeaseHolder ?? (async () => ({ outcome: "none" })),
    specificationReader: options.specificationReader ?? null,
    repositoryReader: options.repositoryReader,
  });
};

export { partitionArchivable } from "./task-archive.js";
