import { RUN_STATUS_IS_ACTIVE } from "@anneal/db/board-contract";

import type { BoardLatestRun, RunPhase } from "../lib/types";

/**
 * One board run, exactly as the projection sends it.
 *
 * `phase` and `phaseSince` default to what the run's own status and timestamps
 * imply rather than to a constant, so a fixture cannot describe a RUNNING run
 * as finished and prove a card against a combination the server never emits.
 * Every field is still overridable: a test that is about an inconsistent
 * payload has to say so.
 */
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

/** The same boundaries `runPhase` states server-side, over the fields a board
 *  run carries: enough for a fixture, and never a second implementation the
 *  product reads. */
const derivePhase = (run: BoardLatestRun): { phase: RunPhase; phaseSince: string | null } => {
  if (run.status === "WAITING_INBOX") return { phase: "waiting-inbox", phaseSince: null };
  if (!RUN_STATUS_IS_ACTIVE[run.status]) return { phase: "finished", phaseSince: run.endedAt };
  if (run.startedAt !== null) return { phase: "executing", phaseSince: run.startedAt };
  return { phase: "queued", phaseSince: null };
};
