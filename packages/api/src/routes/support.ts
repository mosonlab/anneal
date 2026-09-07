import type { BranchAncestryReader } from "../github-read.js";
import { Prisma, type PrismaClient } from "@anneal/db";
import type { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { etagFor, etagMatches } from "../board.js";
import type { MergeLeaseHolderReader, ReleaseMergeLease } from "../merge-lease.js";
import {
  DirectoryNotEmptyError,
  InvalidPathError,
  IsADirectoryError,
  NotADirectoryError,
  NotFoundError,
  SymlinkError,
} from "../files/store.js";
import type { SpecificationReader } from "../specification-fidelity.js";
import type { RunnerRegistry } from "../runners.js";
import { appendRunActivity, fencedActivityInput } from "../run-lifecycle.js";
import type { Principal } from "../auth.js";
import type { ProjectBootstrapLoaders } from "../project-bootstrap.js";
import { refusalResponse, type Refusal, type RefusalDetail, type RefusalReason } from "../refusal.js";
import type { preflightOnboardingRepository, RepositoryPreflight } from "../onboarding-preflight.js";

export type AppEnvironment = { Variables: { principal: Principal } };

export interface LiveAppOptions {
  repositoryReader?: BranchAncestryReader | undefined;
  ownership: { assertHeld(): void | Promise<void> };
  onboardingRepositoryPreflight?: typeof preflightOnboardingRepository;
  repositoryPreflight?: RepositoryPreflight;
  releaseMergeLease?: ReleaseMergeLease;
  /** Lease holder read used by `GET /merge-lease`; injectable for route tests. */
  readMergeLeaseHolder?: MergeLeaseHolderReader;
  /** Repository content capability used to verify materialized review specs. */
  specificationReader?: SpecificationReader | null;
  /** Source loaders used by POST /projects; injectable for route tests. */
  projectBootstrapLoaders?: Partial<ProjectBootstrapLoaders>;
  /**
   * The daemon registry `GET /runners` reports from. The entrypoint passes its
   * own so the readiness worker reads the same liveness this app records; an
   * app without one keeps a private registry, as every test app does.
   */
  runnerRegistry?: RunnerRegistry;
}

export type RouteDeps = {
  db: PrismaClient;
  options: LiveAppOptions;
  repositoryPreflight: RepositoryPreflight;
  projectBootstrapLoaders: ProjectBootstrapLoaders;
  releaseChainLease: ReleaseMergeLease;
  readLeaseHolder: MergeLeaseHolderReader;
  runners: RunnerRegistry;
  appendFencedActivity: ReturnType<typeof createAppendFencedActivityHandler>;
};

export const refusal = (reason: RefusalReason, message: string, detail?: RefusalDetail): Refusal => (
  detail === undefined ? { reason, message } : { reason, message, detail }
);

export const refusalJson = (context: Context, refused: Refusal): Response => {
  // Keep the response mapping in one place so every route group preserves the
  // exact refusal status/body contract from app.ts.
  const response = refusalResponse(refused);
  return context.json(response.body, response.status);
};

export const id = z.string().min(1);
export const fence = z.string().min(1);

export const readJson = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await request.json());

/**
 * A JSON response carrying a validator, so a poll that changed nothing costs a
 * header exchange instead of a payload.
 *
 * `GET /tasks` is polled every 2.5s by an open board and answers with the same
 * bytes almost every time; at 1.58 MB that was ~38 MB/min of unchanged data.
 * The body is serialised here rather than by `context.json` because the ETag has
 * to be a hash of the exact bytes that would be sent.
 *
 * `Cache-Control: no-cache` — store it, but never reuse it without asking. A
 * bare ETag with no cache directive lets a shared cache serve a stale board.
 */
export const validated = (context: Context, payload: unknown): Response => {
  const body = JSON.stringify(payload);
  const tag = etagFor(body);
  const headers = { ETag: tag, "Cache-Control": "no-cache" };
  if (etagMatches(context.req.header("if-none-match"), tag)) return context.body(null, 304, headers);
  return context.body(body, 200, { ...headers, "Content-Type": "application/json; charset=UTF-8" });
};

export const FILE_WRITE_LIMIT = 25 * 1024 * 1024;
export class PayloadTooLargeError extends Error {}

export const readBoundedBody = async (request: Request, limit: number): Promise<Buffer> => {
  const length = request.headers.get("Content-Length");
  if (length !== null && Number(length) > limit) throw new PayloadTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("Request body exceeds limit");
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

/**
 * `readJson` for a route that must refuse an oversized body rather than buffer
 * it. The limit is enforced while the body streams, so a client that lies in
 * `Content-Length` still cannot make this process hold more than `limit` bytes.
 */
export const readBoundedJson = async <T>(
  request: Request,
  schema: z.ZodType<T>,
  limit: number,
): Promise<T> => schema.parse(JSON.parse((await readBoundedBody(request, limit)).toString("utf8")));

export const fileErrorResponse = (context: Context, error: unknown): Response | undefined => {
  if (error instanceof PayloadTooLargeError) return context.json({ error: "File exceeds 25 MB upload limit" }, 413);
  if (error instanceof SymlinkError || error instanceof NotADirectoryError || error instanceof InvalidPathError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof NotFoundError) return context.json({ error: error.message }, 404);
  // 409, not 400: the request is well formed and the conflict is in the state of the
  // target, so the client may retry it once that state changes.
  if (error instanceof DirectoryNotEmptyError || error instanceof IsADirectoryError) {
    return context.json({ error: error.message }, 409);
  }
  return undefined;
};

export const secretPublicSelect = {
  id: true,
  name: true,
  purpose: true,
  description: true,
  ciphertextVersion: true,
  keyId: true,
  rotatedAt: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SecretSelect;

export const taskOutputInput = z.object({
  fencingToken: fence.optional(),
  kind: z.string().trim().min(1).max(80),
  body: z.string().min(1).max(500_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  commitSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u).optional(),
});

export const createAppendFencedActivityHandler = (db: PrismaClient) =>
  async (context: Context<AppEnvironment, string>): Promise<Response> => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, fencedActivityInput);
    const principal = context.get("principal");
    const result = await appendRunActivity(db, { runId, body, principal });
    return "message" in result ? refusalJson(context, result) : context.json(result, 201);
  };

// Hono's generic is intentionally kept here for route modules that need to
// annotate a registration function without importing app.ts.
export type RouteApp = Hono<AppEnvironment>;
