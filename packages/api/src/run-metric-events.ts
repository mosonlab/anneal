import { Prisma, type PrismaClient } from "@anneal/db";
import { TOOL_METRIC_EVENT_TYPES, TTFT_METRIC_EVENT_TYPES, type RunMetricsToolEvent, type RunMetricsTtftEvent } from "./run-metrics.js";

/** One bounded payload projection and batched read for all requested sessions. */
export async function readRunMetricEvents(db: PrismaClient, sessionIds: readonly string[]) {
  // Project only names, outcome markers and the namespaced TTFT value in
  // PostgreSQL: provider tool output can be megabytes and must never enter
  // the metrics input.
  const metricEvents = sessionIds.length === 0 ? [] : await db.$queryRaw<
    Array<{
      sessionId: string;
      type: string;
      at: Date;
      toolCallId: string | null;
      payload: unknown;
    }>
  >(Prisma.sql`
    SELECT "sessionId", "type", "at", "toolCallId",
      jsonb_build_object(
        'type', CASE WHEN jsonb_typeof("payload"->'type') = 'string' THEN "payload"->'type' END,
        'name', CASE WHEN jsonb_typeof("payload"->'name') = 'string' THEN "payload"->'name' END,
        'toolName', CASE WHEN jsonb_typeof("payload"->'toolName') = 'string' THEN "payload"->'toolName' END,
        'is_error', CASE WHEN jsonb_typeof("payload"->'is_error') = 'boolean' THEN "payload"->'is_error' END,
        'isError', CASE WHEN jsonb_typeof("payload"->'isError') = 'boolean' THEN "payload"->'isError' END,
        'exit_code', CASE WHEN jsonb_typeof("payload"->'exit_code') = 'number' THEN "payload"->'exit_code' END,
        'error', CASE WHEN "payload"->'error' IS NOT NULL AND "payload"->'error' <> 'null'::jsonb THEN true END,
        'anneal', CASE WHEN jsonb_typeof("payload"->'anneal') = 'object' THEN jsonb_build_object(
          'ttftMs', CASE WHEN jsonb_typeof("payload"->'anneal'->'ttftMs') = 'number'
            THEN "payload"->'anneal'->'ttftMs' END
        ) END
      ) AS "payload"
    FROM "SessionEvent"
    WHERE "sessionId" IN (${Prisma.join(sessionIds)})
      AND ("type"::text IN (${Prisma.join(TOOL_METRIC_EVENT_TYPES)}) OR (
          ("type"::text = 'MODEL_DELTA' AND (
            "payload"->>'type' = 'assistant'
            OR ("payload"->>'type' = 'item.completed' AND "payload"->'item'->>'type' = 'agent_message')
          ))
          OR ("type"::text = 'MODEL_COMPLETED'
            AND "payload"->>'type' = 'message_end'
            AND "payload"->'message'->>'role' = 'assistant')
      ))
    ORDER BY "sessionId" ASC, "seq" ASC
  `);
  const toolEventsBySession = new Map<string, RunMetricsToolEvent[]>();
  const ttftEventsBySession = new Map<string, RunMetricsTtftEvent[]>();
  for (const event of metricEvents) {
    if ((TOOL_METRIC_EVENT_TYPES as readonly string[]).includes(event.type)) {
      const events = toolEventsBySession.get(event.sessionId);
      if (events) events.push(event);
      else toolEventsBySession.set(event.sessionId, [event]);
    } else if ((TTFT_METRIC_EVENT_TYPES as readonly string[]).includes(event.type)) {
      const events = ttftEventsBySession.get(event.sessionId);
      if (events) events.push(event);
      else ttftEventsBySession.set(event.sessionId, [event]);
    }
  }
  return { toolEventsBySession, ttftEventsBySession };
}
