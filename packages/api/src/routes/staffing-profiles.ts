import type { Context } from "hono";
import { z } from "zod";

import {
  isStaffingProfileRefusal,
  staffingProfileRefusalBody,
  staffingProfileRefusalStatusFor,
} from "../staffing-profile-errors.js";
import {
  createStaffingProfile,
  deleteStaffingProfile,
  listStaffingProfiles,
  replaceStaffingProfile,
  resetStaffingProfile,
  setStaffingProfileDefault,
} from "../staffing-profiles.js";
import { STAFFING_PROFILE_NAME_LIMIT } from "../templates.js";
import {
  id,
  readJson,
  type RouteApp,
  type RouteDeps,
} from "./support.js";

const entryInput = z.object({
  outputKind: z.string().trim().min(1).max(200),
  assigneeAgentId: id.nullable().optional(),
  include: z.boolean().nullable().optional(),
}).strict();
const entriesInput = z.array(entryInput).max(64);
const profileName = z.string().trim().min(1).max(STAFFING_PROFILE_NAME_LIMIT);

const createProfileInput = z.object({
  name: profileName,
  entries: entriesInput,
  isDefault: z.boolean().optional(),
  mergeTailRepairAgentId: id.nullable().optional(),
  repoId: id.optional(),
}).strict();
const replaceProfileInput = z.object({
  name: profileName,
  entries: entriesInput,
  mergeTailRepairAgentId: id.nullable().optional(),
  repoId: id.optional(),
}).strict();
// Only promotion is expressible: clearing the default would leave a template
// with profiles and no default, which instantiation has no answer for.
const defaultProfileInput = z.object({ isDefault: z.literal(true) }).strict();
const resetProfileInput = z.object({ repoId: id.optional() }).strict();

/**
 * Answer a staffing-profile refusal with the status family its code declares.
 *
 * The mapping is applied here rather than through `refusalFor` in refusal.ts
 * so this route group carries its own contract; the shared error handler still
 * sees anything else.
 */
const answering = async (context: Context, operation: () => Promise<Response>): Promise<Response> => {
  try {
    return await operation();
  } catch (error: unknown) {
    if (!isStaffingProfileRefusal(error)) throw error;
    return context.json(staffingProfileRefusalBody(error), staffingProfileRefusalStatusFor(error));
  }
};

export const registerStaffingProfileRoutes = (app: RouteApp, { db }: RouteDeps): void => {
  app.get("/projects/:projectId/task-templates/:templateId/staffing-profiles", async (context) => answering(
    context,
    async () => context.json(await listStaffingProfiles(
      db,
      id.parse(context.req.param("projectId")),
      id.parse(context.req.param("templateId")),
    )),
  ));
  app.post("/projects/:projectId/task-templates/:templateId/staffing-profiles", async (context) => answering(
    context,
    async () => context.json(await createStaffingProfile(
      db,
      id.parse(context.req.param("projectId")),
      id.parse(context.req.param("templateId")),
      await readJson(context.req.raw, createProfileInput),
    ), 201),
  ));
  app.put("/staffing-profiles/:profileId", async (context) => answering(
    context,
    async () => context.json(await replaceStaffingProfile(
      db,
      id.parse(context.req.param("profileId")),
      await readJson(context.req.raw, replaceProfileInput),
    )),
  ));
  app.patch("/staffing-profiles/:profileId", async (context) => answering(
    context,
    async () => {
      await readJson(context.req.raw, defaultProfileInput);
      return context.json(await setStaffingProfileDefault(db, id.parse(context.req.param("profileId"))));
    },
  ));
  app.delete("/staffing-profiles/:profileId", async (context) => answering(
    context,
    async () => {
      await deleteStaffingProfile(db, id.parse(context.req.param("profileId")));
      return context.body(null, 204);
    },
  ));
  app.post("/staffing-profiles/:profileId/reset", async (context) => answering(
    context,
    async () => {
      const body = context.req.raw.body === null
        ? {}
        : await readJson(context.req.raw, resetProfileInput);
      return context.json(await resetStaffingProfile(
        db,
        id.parse(context.req.param("profileId")),
        body.repoId,
      ));
    },
  ));
};
