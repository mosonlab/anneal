import { RUN_STATUS_IS_ACTIVE } from "@anneal/db/board-contract";

import type { BoardLatestRun, RunPhase } from "../lib/types";

/** A projected board fixture. Active defaults assume eligibility (and, for
 * PROVISIONING, provisioning) at FIXTURE_READY_AT. Tests for Inbox waits or
 * cleanup supply phase and phaseSince explicitly because the board does not
 * carry the underlying Session milestones. Overrides may describe incomplete
 * or inconsistent payloads deliberately; this is not the server phase rule. */
const FIXTURE_READY_AT = "2026-08-16T00:00:00.000Z";

export const boardRun = (overrides: Partial<BoardLatestRun> = {}): BoardLatestRun => {
  const run: BoardLatestRun = {
    id: "r1",
    runNumber: 1,
    status: "SUCCEEDED",
    model: "claude-opus-5:medium",
    codexServiceTier: "DEFAULT",
    costUsd: null,
    startedAt: null,
    endedAt: null,
    pullRequestUrl: null,
    phase: "finished",
    phaseSince: null,
    lastProgressEventAt: null,
    maxRunsPerTask: 5,
    ...overrides,
  };
  if (overrides.phase !== undefined) return run;
  const derived = derivePhase(run);
  return { ...run, phase: derived.phase, phaseSince: overrides.phaseSince ?? derived.phaseSince };
};

const derivePhase = (run: BoardLatestRun): { phase: RunPhase; phaseSince: string | null } => {
  if (run.status === "WAITING_INBOX") return { phase: "waiting-inbox", phaseSince: null };
  if (!RUN_STATUS_IS_ACTIVE[run.status]) return { phase: "finished", phaseSince: run.endedAt };
  if (run.endedAt !== null) return { phase: "finished", phaseSince: run.endedAt };
  if (run.startedAt !== null) return { phase: "executing", phaseSince: run.startedAt };
  if (run.status === "PROVISIONING") return { phase: "provisioning", phaseSince: FIXTURE_READY_AT };
  return { phase: "queued", phaseSince: FIXTURE_READY_AT };
};
