import { type Prisma, type PrismaClient } from "@anneal/db";

import {
  commitWithLeaseOutcome,
  type HeldLeaseOutcome,
  type LeaseOutcome,
  type ReleaseMergeLease,
  type TransactionLeaseOutcome,
} from "./merge-lease.js";
import {
  type ReadinessClaimHandle,
  type ReadinessLeaseOwnership,
} from "./readiness-claim.js";

export type ReadinessSettlementKind = "stop" | "requeue" | "defer" | "authorize";

export type ReadinessSettlementBody = (
  tx: Prisma.TransactionClient,
  claim: ReadinessClaimHandle,
) => Promise<TransactionLeaseOutcome<{ applied: boolean; stopped?: boolean }>>;

export type ReadinessSettlement = {
  kind: ReadinessSettlementKind;
  taskId: string;
  body: ReadinessSettlementBody;
};

type ReadinessSettlementApply = (
  tx: Prisma.TransactionClient,
) => Promise<{
  stopped?: boolean;
  ownership: ReadinessLeaseOwnership;
  leaseOutcome: LeaseOutcome;
}>;

export const readinessSettlement = (
  kind: ReadinessSettlementKind,
  input: {
    taskId: string;
    at: Date;
    apply: ReadinessSettlementApply;
  },
): ReadinessSettlement => ({
  kind,
  taskId: input.taskId,
  body: async (tx, claim) => {
    const settlement = await claim.settle(tx, {
      kind: "finish",
      at: input.at,
      apply: async (client) => {
        const applied = await input.apply(client);
        return { value: { leaseOutcome: applied.leaseOutcome, stopped: applied.stopped }, ownership: applied.ownership };
      },
    });
    if (!settlement.settled) {
      return {
        value: { applied: false },
        leaseOutcome: heldLeaseOutcome(settlement.ownership, input.taskId),
      };
    }
    if (settlement.claim !== "released") {
      throw new Error("Readiness settlement retained a finished claim");
    }
    return {
      value: { applied: true, ...(settlement.value.stopped ? { stopped: true } : {}) },
      leaseOutcome: settlement.value.leaseOutcome,
    };
  },
});

export type ReadinessSettlementApplication =
  | { kind: "acquire-lease" }
  | {
    kind: "settled";
    outcome: {
      value: { applied: boolean; stopped?: boolean };
      leaseOutcome: HeldLeaseOutcome;
    };
  };

type ReadinessSettlementPosition =
  | { kind: "pre-acquire"; release: ReleaseMergeLease }
  | { kind: "held"; release: ReleaseMergeLease };

export type ReadinessSettlementRunner = {
  readonly position: ReadinessSettlementPosition["kind"];
  apply(
    settlement: ReadinessSettlement,
    claim: ReadinessClaimHandle,
  ): Promise<ReadinessSettlementApplication>;
  skip(taskId: string): ReadinessSettlementApplication;
};

const heldLeaseOutcome = (
  ownership: ReadinessLeaseOwnership,
  taskId: string,
): HeldLeaseOutcome => ownership === "released"
  ? { kind: "stop", taskId }
  : { kind: "continue" };

const asHeldLeaseOutcome = (
  outcome: LeaseOutcome,
  taskId: string,
): HeldLeaseOutcome => outcome.kind === "stop"
  ? { kind: "stop", taskId: outcome.taskId ?? taskId }
  : { kind: "continue" };

const continueLease = (): { kind: "continue" } => ({ kind: "continue" });

const preAcquireOutcome = (
  settlement: ReadinessSettlement,
  outcome: TransactionLeaseOutcome<{ applied: boolean; stopped?: boolean }>,
): TransactionLeaseOutcome<{ applied: boolean; stopped?: boolean }> => {
  if (!outcome.value.applied || settlement.kind === "defer") {
    return { ...outcome, leaseOutcome: continueLease() };
  }
  return outcome;
};

const settled = (
  outcome: { value: { applied: boolean; stopped?: boolean }; leaseOutcome: HeldLeaseOutcome },
): ReadinessSettlementApplication => ({ kind: "settled", outcome });

/**
 * Pre-acquire runners commit post-transaction Lease outcomes themselves. Held
 * runners return a normalized outcome to the withMergeLease callback that owns
 * the already-acquired Lease.
 */
export const createReadinessSettlementRunner = (
  db: PrismaClient,
  position: ReadinessSettlementPosition,
): ReadinessSettlementRunner => ({
  position: position.kind,
  skip: (taskId) => settled({
    value: { applied: false },
    leaseOutcome: position.kind === "held"
      ? { kind: "stop", taskId }
      : { kind: "continue" },
  }),
  apply: async (settlement, claim) => {
    if (position.kind === "pre-acquire") {
      if (settlement.kind === "authorize") return { kind: "acquire-lease" };
      const value = await commitWithLeaseOutcome(
        db,
        async (tx) => preAcquireOutcome(settlement, await settlement.body(tx, claim)),
        { release: position.release },
      );
      if (!value) throw new Error("Readiness settlement transaction returned no value");
      return settled({ value, leaseOutcome: continueLease() });
    }

    if (settlement.kind !== "authorize") {
      const outcome = await db.$transaction((tx) => settlement.body(tx, claim));
      return settled({
        ...outcome,
        leaseOutcome: asHeldLeaseOutcome(outcome.leaseOutcome, settlement.taskId),
      });
    }

    let heldOutcome: HeldLeaseOutcome | null = null;
    const value = await commitWithLeaseOutcome(db, async (tx) => {
      const outcome = await settlement.body(tx, claim);
      heldOutcome = outcome.value.applied && outcome.leaseOutcome.kind === "continue"
        ? { kind: "stop", taskId: settlement.taskId }
        : asHeldLeaseOutcome(outcome.leaseOutcome, settlement.taskId);
      return outcome.value.applied
        ? outcome
        : { ...outcome, leaseOutcome: continueLease() };
    }, { release: position.release });
    if (!value || !heldOutcome) throw new Error("Readiness authorization transaction returned no value");
    return settled({ value, leaseOutcome: heldOutcome });
  },
});
