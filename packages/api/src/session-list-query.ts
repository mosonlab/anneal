/**
 * The `where` behind `GET /sessions`.
 *
 * The route parses its query through `@anneal/db/session-filter-contract` and
 * hands the parsed filters here, so the predicate is decided in one pure place
 * a test can read exactly. An absent filter leaves its key out rather than
 * setting it to `undefined`: Prisma treats the two the same, but only the
 * former lets a test prove that an unfiltered request still asks the question
 * it asked before this feature.
 */

import type { Prisma } from "@anneal/db";
import {
  SESSION_STATUS_EXECUTION_STATUSES,
  type SessionListFilters,
} from "@anneal/db/session-filter-contract";

/** The scope the list already had before filters: the project it is read for
 *  and the keyset cursor. `before` may be an Invalid Date, which the route
 *  tolerates by dropping the cursor rather than refusing. */
export type SessionListScope = {
  projectId?: string | undefined;
  before?: Date | null;
};

/** `q` searches human-authored text only. An id or an event payload must never
 *  match, or a search for a word would surface rows an operator cannot see the
 *  reason for. */
const insensitiveContains = (value: string) => ({
  contains: value.replace(/[\\%_]/gu, (character) => `\\${character}`),
  mode: "insensitive",
} satisfies Prisma.StringNullableFilter);

export const sessionListWhere = (
  filters: SessionListFilters,
  scope: SessionListScope,
): Prisma.SessionWhereInput => {
  // The cursor and the range are one column, so they must be one filter object:
  // a second `requestedAt` key would silently replace the first.
  const requestedAt: Prisma.DateTimeFilter = {
    // An unparseable cursor drops the filter rather than reaching Prisma as an
    // Invalid Date and surfacing as a 500.
    ...(scope.before && !Number.isNaN(scope.before.getTime()) ? { lt: scope.before } : {}),
    ...(filters.since === null ? {} : { gte: new Date(filters.since) }),
    ...(filters.until === null ? {} : { lte: new Date(filters.until) }),
  };
  return {
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ...(Object.keys(requestedAt).length > 0 ? { requestedAt } : {}),
    ...(filters.status === null
      ? {}
      : { executionStatus: { in: [...SESSION_STATUS_EXECUTION_STATUSES[filters.status]] } }),
    ...(filters.agentId === null ? {} : { agentId: filters.agentId }),
    ...(filters.runner === null ? {} : { runner: filters.runner }),
    ...(filters.taskId === null ? {} : { taskId: filters.taskId }),
    ...(filters.chainId === null ? {} : { task: { chainId: filters.chainId } }),
    ...(filters.q === null ? {} : {
      OR: [
        { task: { name: insensitiveContains(filters.q) } },
        { run: { branch: insensitiveContains(filters.q) } },
        { failureReason: insensitiveContains(filters.q) },
      ],
    }),
  };
};
