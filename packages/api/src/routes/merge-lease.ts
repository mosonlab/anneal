import type { MergeLeaseEventState } from "@anneal/db";

import { mergeLeaseHoldSeconds } from "../../../../scripts/merge-lease-adapter.mjs";

import type { RouteApp, RouteDeps } from "./support.js";

/** How many ledger rows the route answers with: one screen of recent history. */
const EVENT_WINDOW = 20;

export type MergeLeaseHolderView = {
  holder: string;
  task: string | null;
  reason: string | null;
  acquiredAt: string;
  ageSeconds: number | null;
  sha: string | null;
};

export type MergeLeaseEventView = {
  id: string;
  projectId: string;
  chainId: string;
  state: MergeLeaseEventState;
  owningTaskId: string;
  leaseRef: string | null;
  leaseSha: string | null;
  acquiredAt: string | null;
  handedOffRunId: string | null;
  handedOffAt: string | null;
  deferredAt: string | null;
  settledAt: string | null;
  failureDetail: string | null;
  createdAt: string;
};

/**
 * What `GET /merge-lease` says. `holder` is the lease standing on origin right
 * now; `unavailable` is what stopped the route from reading it, and the two are
 * never both set. A read that could not reach origin still answers with the
 * ledger, because the recorded history is the half an operator needs when the
 * remote is the thing that is broken.
 */
export type MergeLeaseView = {
  checkedAt: string;
  holder: MergeLeaseHolderView | null;
  unavailable: string | null;
  events: MergeLeaseEventView[];
};

const isoOrNull = (value: Date | null): string | null => value?.toISOString() ?? null;

export const registerMergeLeaseRoutes = (app: RouteApp, deps: RouteDeps): void => {
  const { db, readLeaseHolder } = deps;

  // Read-only by construction: it runs `merge-lease.sh status`, which writes
  // nothing to origin, and reads the ledger. Nothing here acquires, releases or
  // steals -- breaking a lease stays a human decision made at the script.
  app.get("/merge-lease", async (context) => {
    const [status, events] = await Promise.all([
      readLeaseHolder(),
      db.mergeLeaseEvent.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: EVENT_WINDOW,
      }),
    ]);
    // Stamped after the reads, not before them: `checkedAt` is when the route
    // saw origin, and the holder's age is measured from that same instant, so
    // neither under-reports by however long the `merge-lease.sh` shell-out took.
    const now = new Date();
    return context.json({
      checkedAt: now.toISOString(),
      holder: status.outcome === "held"
        ? {
          holder: status.holder.holder,
          task: status.holder.task,
          reason: status.holder.reason,
          acquiredAt: status.holder.acquiredAt,
          ageSeconds: mergeLeaseHoldSeconds(status.holder.acquiredAt, now),
          sha: status.holder.sha,
        }
        : null,
      unavailable: status.outcome === "unreachable" ? status.detail : null,
      events: events.map((event) => ({
        id: event.id,
        projectId: event.projectId,
        chainId: event.chainId,
        state: event.state,
        owningTaskId: event.owningTaskId,
        leaseRef: event.leaseRef,
        leaseSha: event.leaseSha,
        acquiredAt: isoOrNull(event.acquiredAt),
        handedOffRunId: event.handedOffRunId,
        handedOffAt: isoOrNull(event.handedOffAt),
        deferredAt: isoOrNull(event.deferredAt),
        settledAt: isoOrNull(event.settledAt),
        failureDetail: event.failureDetail,
        createdAt: event.createdAt.toISOString(),
      })),
    } satisfies MergeLeaseView);
  });
};
