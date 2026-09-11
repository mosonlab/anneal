import {
  NetworkingMode,
  Prisma,
  SecretPurpose,
} from "@anneal/db";
import type {
  Environment as EnvironmentContract,
  Project as ProjectContract,
  Secret as SecretContract,
} from "@anneal/db/wire-contract";
import type { SerializesTo } from "@anneal/db/wire-serialization";
import { z } from "zod";

import { COSTS_DEFAULT_DAYS, COSTS_RANGE_DAYS, isValidTimeZone, readProjectCosts, type CostsResponse } from "../costs.js";
import { deleteProject } from "../project-delete.js";
import { createProjectBootstrap, projectFields, projectInput } from "../project-bootstrap.js";
import { encryptSecret } from "../secrets.js";
import { withoutUndefined } from "../without-undefined.js";
import {
  id,
  readJson,
  secretPublicSelect,
  validated,
  type RouteApp,
  type RouteDeps,
} from "./support.js";

// Strict: a retired setting must be answered with 400 rather than silently
// dropped alongside the keys the body did carry.
const projectPatch = z.object({
  ...projectFields,
  specGateDefault: z.boolean(),
  mergeGateDefault: z.boolean(),
}).strict().partial().refine((value) => Object.keys(value).length > 0);

const environmentFields = {
  name: z.string().trim().min(1).max(120),
  networking: z.nativeEnum(NetworkingMode),
  allowedHosts: z.array(z.string().trim().min(1).max(253)).max(500),
};
const environmentInput = z.object({
  name: environmentFields.name,
  networking: environmentFields.networking.default(NetworkingMode.LIMITED),
  allowedHosts: environmentFields.allowedHosts.default([]),
});
const environmentPatch = z.object(environmentFields).partial().refine((value) => Object.keys(value).length > 0);

const secretFields = {
  name: z.string().trim().min(1).max(120),
  purpose: z.nativeEnum(SecretPurpose),
  description: z.string().trim().max(1000).nullable(),
};
const secretInput = z.object({ ...secretFields, description: secretFields.description.default(null), value: z.string().min(1).max(100_000) });
const secretPatch = z.object(secretFields).partial().extend({ value: z.string().min(1).max(100_000).optional() })
  .refine((value) => Object.keys(value).length > 0);

/** Each response names both its native projection and the browser contract that
 * projection must JSON-serialize to, so every `satisfies` below proves the
 * whole wire claim rather than the native half of it. `Environment` holds no
 * date or amount, and the proof is what says so. */
type EnvironmentResponse = SerializesTo<EnvironmentContract, EnvironmentContract>;
type ProjectResponse = SerializesTo<ProjectContract<Date, Prisma.Decimal>, ProjectContract>;
type SecretResponse = SerializesTo<SecretContract<Date>, SecretContract>;

export const registerAdminRoutes = (app: RouteApp, { db, projectBootstrapLoaders }: RouteDeps): void => {
  app.get("/projects", async (context) => validated(context,
    (await db.project.findMany({ orderBy: { createdAt: "asc" } })) satisfies ProjectResponse[]));
  app.post("/projects", async (context) => {
    const input = await readJson(context.req.raw, projectInput);
    const result = await createProjectBootstrap(db, input, projectBootstrapLoaders);
    if (!result.ok) return context.json({ error: result.message, code: result.code }, 409);
    return context.json(result.project satisfies ProjectResponse, 201);
  });
  app.get("/projects/:projectId", async (context) => {
    const project = await db.project.findUnique({ where: { id: id.parse(context.req.param("projectId")) } });
    return project ? context.json(project satisfies ProjectResponse) : context.json({ error: "Project not found" }, 404);
  });
  app.patch("/projects/:projectId", async (context) => context.json((await db.project.update({
    where: { id: id.parse(context.req.param("projectId")) },
    data: withoutUndefined(await readJson(context.req.raw, projectPatch)) as Prisma.ProjectUpdateInput,
  })) satisfies ProjectResponse));
  app.delete("/projects/:projectId", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const deleted = await deleteProject(db, projectId);
    return deleted ? context.body(null, 204) : context.json({ error: "Project not found" }, 404);
  });

  app.get("/projects/:projectId/costs", async (context) => {
    const timeZone = context.req.query("tz");
    if (timeZone === undefined || !isValidTimeZone(timeZone)) {
      return context.json({ error: "tz must be a recognized IANA timezone" }, 400);
    }
    const raw = context.req.query("days");
    const days = raw === undefined
      ? COSTS_DEFAULT_DAYS
      : COSTS_RANGE_DAYS.find((candidate) => raw === String(candidate));
    // Refused rather than clamped: a window the caller did not ask for would be
    // read as the one they did, and the totals would be quietly wrong.
    if (days === undefined) {
      return context.json({ error: `days must be one of ${COSTS_RANGE_DAYS.join(", ")}` }, 400);
    }
    return context.json(
      await readProjectCosts(db, id.parse(context.req.param("projectId")), days, timeZone) satisfies CostsResponse,
    );
  });

  app.get("/projects/:projectId/environments", async (context) => context.json((await db.environment.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })) satisfies EnvironmentResponse[]));
  app.post("/projects/:projectId/environments", async (context) => context.json((await db.environment.create({
    data: { projectId: id.parse(context.req.param("projectId")), ...await readJson(context.req.raw, environmentInput) },
  })) satisfies EnvironmentResponse, 201));
  app.get("/environments/:environmentId", async (context) => {
    const environment = await db.environment.findUnique({
      where: { id: id.parse(context.req.param("environmentId")) },
      include: { secrets: { include: { secret: { select: secretPublicSelect } } } },
    });
    return environment ? context.json(environment satisfies EnvironmentResponse) : context.json({ error: "Environment not found" }, 404);
  });
  app.patch("/environments/:environmentId", async (context) => context.json((await db.environment.update({
    where: { id: id.parse(context.req.param("environmentId")) },
    data: withoutUndefined(await readJson(context.req.raw, environmentPatch)),
  })) satisfies EnvironmentResponse));
  app.delete("/environments/:environmentId", async (context) => {
    await db.environment.delete({ where: { id: id.parse(context.req.param("environmentId")) } });
    return context.body(null, 204);
  });

  app.get("/secrets", async (context) => context.json((await db.secret.findMany({
    select: {
      ...secretPublicSelect,
      agentGrants: { include: { agent: { select: { id: true, name: true, title: true, projectId: true } } } },
    },
    orderBy: { createdAt: "asc" },
  })) satisfies SecretResponse[]));
  app.post("/secrets", async (context) => {
    const body = await readJson(context.req.raw, secretInput);
    const secret = await db.secret.create({
      data: {
        name: body.name,
        purpose: body.purpose,
        description: body.description,
        encryptedValue: encryptSecret(body.value),
      },
      select: secretPublicSelect,
    });
    return context.json(secret satisfies SecretResponse, 201);
  });
  app.get("/secrets/:secretId", async (context) => {
    const secret = await db.secret.findUnique({
      where: { id: id.parse(context.req.param("secretId")) },
      select: {
        ...secretPublicSelect,
        agentGrants: { include: { agent: { select: { id: true, name: true, title: true, projectId: true } } } },
      },
    });
    return secret ? context.json(secret satisfies SecretResponse) : context.json({ error: "Secret not found" }, 404);
  });
  app.patch("/secrets/:secretId", async (context) => {
    const body = await readJson(context.req.raw, secretPatch);
    const { value, ...fields } = body;
    return context.json((await db.secret.update({
      where: { id: id.parse(context.req.param("secretId")) },
      data: {
        ...withoutUndefined(fields),
        ...(value === undefined ? {} : { encryptedValue: encryptSecret(value), rotatedAt: new Date() }),
      },
      select: secretPublicSelect,
    })) satisfies SecretResponse);
  });
  app.delete("/secrets/:secretId", async (context) => {
    await db.secret.delete({ where: { id: id.parse(context.req.param("secretId")) } });
    return context.body(null, 204);
  });
};
