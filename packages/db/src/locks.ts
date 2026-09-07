/**
 * Global database lock order for this package. Fencing writers take the Run
 * row before any Task row. Template authoring takes the TaskTemplate row first,
 * then its TaskTemplateStep rows in stepIndex/id order. Template instantiation
 * takes that template mutex before its existing predecessor Task, Agent, and
 * AgentRepoAccess locks; Task inserts then acquire the template and
 * template-step foreign-key reference locks. For Chain writers, Task rows
 * first, then Agent rows, then AgentRepoAccess grant rows. Multiple Task rows
 * use chainLayer, chainIndex, and id order; multiple Agent rows use id order.
 * The Chain advisory mutex serializes structural changes even when no Task row
 * exists. Archive and grant revocation take only their own final lock, so they
 * cannot reverse the order. Existing template writers were audited: canonical
 * installation creates/updates a template before its steps, canonical sync
 * updates steps without later taking a template lock, and the operator webhook
 * patch takes only the template row. Instantiation takes the Project row after
 * the template row, before it reads gate defaults; the project PATCH writer
 * takes only the Project row. No existing writer takes a step row and then
 * acquires its template row.
 */
import { Prisma, RepoPermission, RunnerPreference, type Agent } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Takes the template-row mutex shared by authoring and instantiation.
 *
 * The caller deliberately receives the project and name from the locked row:
 * project ownership and canonical identity must be checked after this lock,
 * not from an unlocked preflight read that could race a canonical rollover.
 */
export const lockTemplateRow = async (
  tx: Tx,
  templateId: string,
): Promise<{ id: string; projectId: string; name: string } | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string; projectId: string; name: string }>>`
    SELECT "id", "projectId", "name" FROM "TaskTemplate"
    WHERE "id" = ${templateId} FOR UPDATE
  `;
  return rows[0] ?? null;
};

/**
 * Takes the Project-row mutex shared by project-default updates and chain
 * instantiation. The defaults are read from the locked row so a PATCH that
 * races dispatch is ordered before or after the whole chain snapshot rather
 * than landing between the read and the Task inserts.
 */
export const lockProjectGateDefaults = async (
  tx: Tx,
  projectId: string,
): Promise<{ id: string; specGateDefault: boolean; mergeGateDefault: boolean } | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string; specGateDefault: boolean; mergeGateDefault: boolean }>>`
    SELECT "id", "specGateDefault", "mergeGateDefault" FROM "Project"
    WHERE "id" = ${projectId} FOR UPDATE
  `;
  return rows[0] ?? null;
};

/** Locks an existing template graph after its template row is locked. */
export const lockTemplateStepRows = async (
  tx: Tx,
  templateId: string,
): Promise<string[]> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "TaskTemplateStep"
    WHERE "taskTemplateId" = ${templateId}
    ORDER BY "stepIndex", "id" FOR UPDATE
  `;
  return rows.map((row) => row.id);
};

/**
 * Takes the Task-row mutex the archive/start/retry/cron writers all take.
 *
 * `SELECT … FOR UPDATE` and not a plain read: under ReadCommitted a read of one
 * table is not re-evaluated when another transaction commits, so "no active run"
 * observed without the lock can be stale by the time the run is inserted.
 */
export const lockTaskRow = async (
  tx: Tx,
  taskId: string,
): Promise<{ id: string; archivedAt: Date | null } | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string; archivedAt: Date | null }>>`
    SELECT "id", "archivedAt" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  return rows[0] ?? null;
};

/**
 * Takes the Run-row mutex every fencing writer takes.
 *
 * Its callers ignore the row: they take the mutex and then re-read through the
 * fenced predicate. It is returned anyway, for the same reason `lockTaskRow`
 * returns one -- a caller that needs to tell "locked" from "no such run" apart
 * should not have to issue a second statement.
 */
export const lockRunRow = async (
  tx: Tx,
  runId: string,
): Promise<{ id: string } | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Run" WHERE "id" = ${runId} FOR UPDATE
  `;
  return rows[0] ?? null;
};

/**
 * Takes the Agent-row mutex that archive and every assignment/run writer share.
 *
 * Archive used to write `archivedAt` unconditionally while task creation,
 * template instantiation and run enqueue checked it in a different transaction.
 * Under ReadCommitted both sides can be right at the same instant: the writer
 * reads an unarchived agent, archive commits, and the writer then inserts a run
 * the claim query — which filters `agent: { archivedAt: null }` — will never
 * hand to a runner. That run sits QUEUED forever and its task never completes.
 *
 * The Agent row is the serialization point for that whole class. Every writer
 * that assigns an agent or creates a run for one re-reads `archivedAt` under
 * this lock; archive takes the same lock and fails closed on live references.
 */
export const lockAgentRow = async (
  tx: Tx,
  agentId: string,
): Promise<Agent | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE
  `;
  if (!rows[0]) return null;
  return tx.agent.findUnique({ where: { id: agentId } });
};

/**
 * `RunnerPreference` is stored under its `@map` name, and `$queryRaw` answers
 * the stored spelling rather than the client enum: a raw row holds `codex`
 * where `RunnerPreference.CODEX` is `CODEX`. Comparing the raw value to the
 * enum reads every Agent as "not Codex" without failing anywhere, so the
 * projection below translates the column back to the client spelling in SQL
 * and every caller sees the enum it compares against. The table is exhaustive
 * over the enum, so a new member fails the build here.
 */
const RUNNER_PREFERENCE_COLUMN = {
  [RunnerPreference.CLAUDE]: "claude",
  [RunnerPreference.CODEX]: "codex",
  [RunnerPreference.PI]: "pi",
  [RunnerPreference.AUTO]: "auto",
  [RunnerPreference.INHERIT]: "inherit",
} as const satisfies Record<RunnerPreference, string>;

// `Prisma.raw`, not a bound parameter: the branches are this module's own
// constants, and a raw fragment contributes no placeholder of its own.
const runnerPreferenceAsClientEnum = Prisma.raw(
  `CASE "runnerPreference"::text ${Object.entries(RUNNER_PREFERENCE_COLUMN)
    .map(([preference, column]) => `WHEN '${column}' THEN '${preference}'`)
    .join(" ")} END AS "runnerPreference"`,
);

/**
 * Takes the same mutex for a whole step list in one statement.
 *
 * `model` and `runnerPreference` are projected because the capability
 * invariants a batch caller re-checks — the compound implementation root's
 * Codex `gpt-*` requirement — are properties of the runtime configuration, not
 * of the Agent's name. Reading them from an unlocked preflight would let an
 * Agent's model change between the check and the write the lock exists to
 * order.
 */
export const lockAgentRows = async (
  tx: Tx,
  agentIds: string[],
): Promise<Map<string, {
  name: string;
  projectId: string;
  archivedAt: Date | null;
  model: string;
  runnerPreference: RunnerPreference;
}>> => {
  const unique = [...new Set(agentIds)];
  if (unique.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{
    id: string;
    name: string;
    projectId: string;
    archivedAt: Date | null;
    model: string;
    runnerPreference: RunnerPreference;
  }>>`
    SELECT "id", "name", "projectId", "archivedAt", "model", ${runnerPreferenceAsClientEnum}
    FROM "Agent"
    WHERE "id" = ANY(${unique})
    ORDER BY "id" FOR UPDATE
  `;
  return new Map(rows.map((row) => [row.id, {
    name: row.name,
    projectId: row.projectId,
    archivedAt: row.archivedAt,
    model: row.model,
    runnerPreference: row.runnerPreference,
  }]));
};

/**
 * Serializes structural mutations for one Chain, including the empty state
 * after deletion where there is no Task row left to lock. The two-int advisory
 * namespace keeps this mutex distinct from row locks and other advisory lock
 * families; hash collisions only serialize unrelated Chains.
 */
export const CHAIN_STRUCTURE_LOCK_CLASS = 1128812105;

export const lockChainStructure = async (
  tx: Tx,
  input: { projectId: string; chainId: string },
): Promise<void> => {
  const identity = JSON.stringify([input.projectId, input.chainId]);
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      ${CHAIN_STRUCTURE_LOCK_CLASS}::int,
      hashtext(${identity})
    )::text AS locked
  `;
};

/**
 * Locks every existing row in one chain. A prefix lock is insufficient for a
 * layered join: two siblings can complete concurrently while each only locks
 * its own prefix, then both observe a stale incomplete layer and race the join.
 *
 * The nullable columns are deliberate while the expand migration is live. The
 * query still locks malformed rows, so a later contract migration cannot race
 * a writer that is already holding one of them.
 */
export const lockChainRows = async (
  tx: Tx,
  input: { projectId: string; chainId: string },
): Promise<string[]> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task"
    WHERE "projectId" = ${input.projectId}
      AND "chainId" = ${input.chainId}
    ORDER BY "chainLayer" NULLS LAST, "chainIndex" NULLS LAST, "id" FOR UPDATE
  `;
  return rows.map((row) => row.id);
};

/** Serializes Run creation with revocation of the exact agent/repository grant. */
export const lockAgentRepoGrant = async (
  tx: Tx,
  input: { projectId: string; agentId: string; repoId: string },
): Promise<boolean> => {
  const rows = await tx.$queryRaw<Array<{ agentId: string; repoId: string }>>`
    SELECT "agentId", "repoId" FROM "AgentRepoAccess"
    WHERE "projectId" = ${input.projectId}
      AND "agentId" = ${input.agentId}
      AND "repoId" = ${input.repoId}
    FOR KEY SHARE
  `;
  if (rows.length === 0) return false;
  return (await tx.agentRepoAccess.count({ where: input })) === 1;
};

/** Route-line and judged-tier implementation Agents need write access. Hold
 * permission updates as well as grant deletion until the caller commits. */
export const lockAgentRepoWriteGrant = async (
  tx: Tx,
  input: { projectId: string; agentId: string; repoId: string },
): Promise<boolean> => {
  const rows = await tx.$queryRaw<Array<{ agentId: string }>>`
    SELECT "agentId" FROM "AgentRepoAccess"
    WHERE "projectId" = ${input.projectId}
      AND "agentId" = ${input.agentId}
      AND "repoId" = ${input.repoId}
    FOR SHARE
  `;
  if (rows.length === 0) return false;
  return (await tx.agentRepoAccess.count({
    where: { ...input, permissions: RepoPermission.GIT_WRITE },
  })) === 1;
};

/** Exclusive companion for grant revocation. */
export const lockAgentRepoGrantForRevocation = async (
  tx: Tx,
  input: { projectId: string; agentId: string; repoId: string },
): Promise<boolean> => {
  const rows = await tx.$queryRaw<Array<{ agentId: string; repoId: string }>>`
    SELECT "agentId", "repoId" FROM "AgentRepoAccess"
    WHERE "projectId" = ${input.projectId}
      AND "agentId" = ${input.agentId}
      AND "repoId" = ${input.repoId}
    FOR UPDATE
  `;
  return rows.length === 1;
};
