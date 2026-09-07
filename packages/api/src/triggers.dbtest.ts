import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, type PrismaClient } from "@anneal/db";

import { mergeTailRepairAssignee } from "./merge-tail-actions.js";
import { createApp } from "./test-app.js";
import { encryptSecret } from "./secrets.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let priorKey: string | undefined;
before(() => {
  priorKey = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  process.env.AGENTOS_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorKey === undefined) delete process.env.AGENTOS_SECRET_ENCRYPTION_KEY; else process.env.AGENTOS_SECRET_ENCRYPTION_KEY = priorKey;
});

const OPERATOR = "operator-trigger-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => asOperator(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

/** A webhook-configured template whose one variable has a default, so `Fire now`
 *  needs no body at all. Overrides let each test break exactly one thing. */
const seedTrigger = async (label: string, overrides: {
  template?: Record<string, unknown>;
  steps?: number;
  secretDisabled?: boolean;
} = {}) => {
  const unique = `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const project = await db.project.create({ data: { name: label, slug: unique } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo", dependencyProvisioning: DependencyProvisioning.NONE } });
  await db.agentRepoAccess.create({ data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" } });
  const secret = await db.secret.create({ data: {
    name: `trigger-${unique}`, encryptedValue: encryptSecret("wh-secret-batch25"), purpose: "WEBHOOK",
    ...(overrides.secretDisabled ? { disabledAt: new Date() } : {}),
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: "Ticket", description: "ticket", variables: ["ticket"],
    webhookSecretId: secret.id, webhookRepoId: repo.id,
    webhookPayloadMapping: { map: { ticket: "issue.title" }, defaults: { ticket: "unlabelled" } },
    ...overrides.template,
  } });
  for (let index = 0; index < (overrides.steps ?? 1); index += 1) {
    await db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, assigneeAgentId: agent.id, stepIndex: index, layer: index,
      name: `Step ${index + 1}`, assigneeType: "AGENT", prompt: "Handle {{ticket}}",
    } });
  }
  return { project, agent, repo, secret, template };
};

// --- POST /task-templates/:templateId/fire ----------------------------------

test("Fire now on a fully-defaulted trigger creates one chain, one queued run, one manual fire", async () => {
  const { template } = await seedTrigger("fire-happy", { template: { name: "Ticket\nQueue" }, steps: 3 });
  const { status, body } = await call("POST", `/task-templates/${template.id}/fire`);
  assert.equal(status, 201);
  assert.equal(body.taskIds.length, 3);
  assert.ok(body.fireId);
  // §2.5-2: a three-step chain queues its first step and only its first step.
  assert.equal(await db.run.count({ where: { task: { chainId: body.chainId } } }), 1);
  assert.equal(await db.run.count({ where: { task: { chainId: body.chainId }, status: "QUEUED" } }), 1);
  const fires = await db.triggerFire.findMany({ where: { templateId: template.id } });
  assert.equal(fires.length, 1);
  assert.equal(fires[0]!.source, "MANUAL");
  assert.equal(fires[0]!.chainId, body.chainId);
  assert.equal(fires[0]!.dedupeKey, null);
  assert.equal(fires[0]!.id, body.fireId);
  const firedTasks = await db.task.findMany({
    where: { chainId: body.chainId },
    include: { templateStep: { select: { name: true } } },
    orderBy: { chainIndex: "asc" },
  });
  assert.ok(firedTasks.every((task) => task.name.startsWith(`Ticket Queue: ${body.fireId}: `)));
  assert.ok(firedTasks.every((task) => task.name !== `${template.name}: ${task.templateStep?.name}`));
  // The chain is operator-made; only webhook-born chains carry the WEBHOOK source.
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: body.taskIds[0]! } })).source, "MANUAL");
});

test("supplied variables win over the template defaults", async () => {
  const { template } = await seedTrigger("fire-override");
  const { body } = await call("POST", `/task-templates/${template.id}/fire`, { variables: { ticket: "PROJ-42" } });
  const task = await db.task.findUniqueOrThrow({ where: { id: body.taskIds[0]! } });
  assert.match(task.description, /PROJ-42/);
});

test("blank manual variables use a usable default and otherwise remain unresolved", async () => {
  const defaulted = await seedTrigger("fire-blank-default");
  const accepted = await call("POST", `/task-templates/${defaulted.template.id}/fire`, {
    variables: { ticket: "   " },
  });
  assert.equal(accepted.status, 201);
  assert.match((await db.task.findFirstOrThrow()).description, /unlabelled/);

  await resetTestDb(db);
  const required = await seedTrigger("fire-blank-required", {
    template: { webhookPayloadMapping: { map: {} } },
  });
  const rejected = await call("POST", `/task-templates/${required.template.id}/fire`, {
    variables: { ticket: "\t" },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Unresolved template variables: ticket/);
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.run.count(), 0);
  assert.equal(await db.triggerFire.count(), 0);
});

test("an invalid manual branch is a client refusal with no fire ledger or chain", async () => {
  const { template } = await seedTrigger("fire-invalid-branch", {
    template: {
      variables: ["branchName"],
      webhookPayloadMapping: { map: {}, defaults: { branchName: "agentos/default" } },
    },
  });
  const response = await call("POST", `/task-templates/${template.id}/fire`, {
    variables: { branchName: "bad..branch" },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Invalid template branch name/);
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.run.count(), 0);
  assert.equal(await db.triggerFire.count(), 0);
});

test("an unresolved variable names itself in the error prose and writes nothing", async () => {
  const { template } = await seedTrigger("fire-unresolved", {
    template: { variables: ["repoUrl", "issueId"], webhookPayloadMapping: { map: {} } },
  });
  const { status, body } = await call("POST", `/task-templates/${template.id}/fire`);
  assert.equal(status, 400);
  // The web client keeps only `error`, so the names must be in the prose.
  assert.match(body.error, /repoUrl/);
  assert.match(body.error, /issueId/);
  assert.deepEqual(body.unresolved, ["repoUrl", "issueId"]);
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.triggerFire.count(), 0);
});

test("a zero-step template refuses to fire and says so inline as well", async () => {
  const { template } = await seedTrigger("fire-zero-step", { steps: 0 });
  const detail = await call("GET", `/triggers/${template.id}`);
  assert.equal(detail.body.canFire, false);
  assert.match(detail.body.cannotFireReason, /no steps/i);
  const { status, body } = await call("POST", `/task-templates/${template.id}/fire`);
  assert.equal(status, 400);
  assert.match(body.error, /has no steps/i);
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.triggerFire.count(), 0);
});

test("a trigger with no repository is listed, not hidden, and cannot fire", async () => {
  const { project, template } = await seedTrigger("fire-no-repo", { template: { webhookRepoId: null } });
  const list = await call("GET", `/projects/${project.id}/triggers`);
  assert.equal(list.body.length, 1, "a trigger that cannot fire is exactly what the operator needs to see");
  assert.equal(list.body[0].repo, null);
  const detail = await call("GET", `/triggers/${template.id}`);
  assert.equal(detail.body.canFire, false);
  assert.equal(detail.body.cannotFireReason, "This trigger has no repository configured");
  const { status, body } = await call("POST", `/task-templates/${template.id}/fire`);
  assert.equal(status, 400);
  assert.equal(body.error, "This trigger has no repository configured");
  assert.equal(await db.task.count(), 0);
});

test("a paused trigger still fires manually", async () => {
  // [A5]: pause stops the outside world, not the operator standing at the console.
  const { template } = await seedTrigger("fire-paused", { template: { webhookPausedAt: new Date() } });
  assert.equal((await call("POST", `/task-templates/${template.id}/fire`)).status, 201);
});

// --- the list, the detail, and the ledger -----------------------------------

test("the triggers list reports fire counts from the ledger in one grouped query", async () => {
  const { project, template } = await seedTrigger("list-counts");
  await call("POST", `/task-templates/${template.id}/fire`);
  await call("POST", `/task-templates/${template.id}/fire`);
  const { body } = await call("GET", `/projects/${project.id}/triggers`);
  assert.equal(body.length, 1);
  assert.equal(body[0].fireCount, 2);
  assert.notEqual(body[0].lastFiredAt, null);
  assert.equal(body[0].paused, false);
  assert.equal(body[0].secretDisabled, false);
  assert.equal(body[0].stepCount, 1);
  assert.equal(body[0].repo.name, "repo");
});

test("a disabled secret surfaces on the trigger rather than silently failing later", async () => {
  const { project, template } = await seedTrigger("list-disabled", { secretDisabled: true });
  assert.equal((await call("GET", `/projects/${project.id}/triggers`)).body[0].secretDisabled, true);
  assert.equal((await call("GET", `/triggers/${template.id}`)).body.secretDisabled, true);
});

test("pause and enable round-trip and are visible in both the list and the detail", async () => {
  const { project, template } = await seedTrigger("pause-trip");
  assert.deepEqual((await call("POST", `/triggers/${template.id}/pause`)).body, { paused: true });
  assert.equal((await call("GET", `/triggers/${template.id}`)).body.paused, true);
  assert.equal((await call("GET", `/projects/${project.id}/triggers`)).body[0].paused, true);
  assert.deepEqual((await call("POST", `/triggers/${template.id}/enable`)).body, { paused: false });
  assert.equal((await db.taskTemplate.findUniqueOrThrow({ where: { id: template.id } })).webhookPausedAt, null);
});

test("the detail envelope carries the endpoint, the mapping, and the replay window — never the secret", async () => {
  const { template } = await seedTrigger("detail-envelope");
  await call("PATCH", `/task-templates/${template.id}`, { webhookReplayWindowSec: 300 });
  const { status, body } = await call("GET", `/triggers/${template.id}`);
  assert.equal(status, 200);
  assert.equal(body.endpointPath, `/hooks/templates/${template.id}`);
  assert.deepEqual(body.variables, ["ticket"]);
  assert.deepEqual(body.mapping, { ticket: "issue.title" });
  assert.deepEqual(body.defaults, { ticket: "unlabelled" });
  assert.equal(body.replayWindowSec, 300);
  assert.equal(body.canFire, true);
  assert.doesNotMatch(JSON.stringify(body), /wh-secret-batch25|encryptedValue|ciphertextVersion/);
});

test("a replay window of 0 is stored as null so disabled has one representation", async () => {
  const { template } = await seedTrigger("window-zero");
  await call("PATCH", `/task-templates/${template.id}`, { webhookReplayWindowSec: 300 });
  await call("PATCH", `/task-templates/${template.id}`, { webhookReplayWindowSec: 0 });
  assert.equal((await db.taskTemplate.findUniqueOrThrow({ where: { id: template.id } })).webhookReplayWindowSec, null);
  assert.equal((await call("GET", `/triggers/${template.id}`)).body.replayWindowSec, null);
});

test("the fires ledger reports chain progress, and survives a deleted chain", async () => {
  const { template } = await seedTrigger("fires-ledger", { steps: 2 });
  const kept = await call("POST", `/task-templates/${template.id}/fire`);
  const orphaned = await call("POST", `/task-templates/${template.id}/fire`);
  await db.run.deleteMany({ where: { task: { chainId: orphaned.body.chainId } } });
  await db.task.deleteMany({ where: { chainId: orphaned.body.chainId } });

  const { status, body } = await call("GET", `/triggers/${template.id}/fires?take=20`);
  assert.equal(status, 200);
  assert.equal(body.length, 2);
  const live = body.find((fire: any) => fire.chainId === kept.body.chainId);
  assert.equal(live.source, "MANUAL");
  assert.equal(live.firstTask.id, kept.body.taskIds[0]);
  assert.deepEqual(
    { done: live.progress.done, total: live.progress.total, activeStepName: live.progress.activeStepName },
    { done: 0, total: 2, activeStepName: "Step 1" },
  );
  const dead = body.find((fire: any) => fire.chainId === orphaned.body.chainId);
  assert.equal(dead.firstTask, null);
  assert.equal(dead.progress, null);
});

test("the ledger honours take and returns the newest fires first", async () => {
  const { template } = await seedTrigger("fires-take");
  for (let index = 0; index < 3; index += 1) await call("POST", `/task-templates/${template.id}/fire`);
  const { body } = await call("GET", `/triggers/${template.id}/fires?take=2`);
  assert.equal(body.length, 2);
  assert.ok(new Date(body[0].createdAt).getTime() >= new Date(body[1].createdAt).getTime());
});

// --- what the schema actually enforces (spec §4.6-T8) ------------------------

test("a repo referenced by a template cannot be deleted", async () => {
  // Spec §4.6-T8 assumes the FK nulls the repo. It restricts instead, so the
  // "repo deleted" state the spec describes is unreachable. Asserted here so the
  // real outcome is documented rather than assumed (plan O7).
  const { repo } = await seedTrigger("t8-restrict");
  await assert.rejects(db.repo.delete({ where: { id: repo.id } }));
});

// --- E6: simultaneous manual and webhook fire --------------------------------

test("a manual fire and a webhook delivery released together produce two independent chains", async () => {
  const { template } = await seedTrigger("e6-race");
  const app = createApp(db);
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const release = () => { arrived += 1; if (arrived === 2) open(); };
  const responses = await asOperator(() => Promise.all([
    (async () => { release(); await gate; return app.request(`/task-templates/${template.id}/fire`, {
      method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` },
    }); })(),
    (async () => { release(); await gate; return app.request(`/hooks/templates/${template.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Anneal-Webhook-Secret": "wh-secret-batch25" },
      body: JSON.stringify({ issue: { title: "From the wire" } }),
    }); })(),
  ]));
  // instantiateTemplate's Serializable retry is what keeps P2034 off the wire.
  assert.deepEqual(responses.map((response) => response.status), [201, 201]);
  const chainIds = await Promise.all(responses.map(async (response) => (await response.json() as { chainId: string }).chainId));
  assert.equal(new Set(chainIds).size, 2);
  assert.equal(await db.triggerFire.count({ where: { templateId: template.id } }), 2);
  assert.equal(await db.run.count(), 2);
  // Sorted in JS: an `orderBy` on the enum column follows the type's declared
  // value order, which is not alphabetical.
  const sources = (await db.triggerFire.findMany({ where: { templateId: template.id } })).map((fire) => fire.source).sort();
  assert.deepEqual(sources, ["MANUAL", "WEBHOOK"]);
});

// --- review fixes: the fires ledger is project-scoped (SOL-REVIEW M4) --------

test("a colliding chainId in another project never supplies this trigger's fire history", async () => {
  // `chainId` is unique per project only by convention — no constraint enforces
  // it, and `chain.ts` says so explicitly: chain identity is (projectId,
  // chainId). The fires route used to query and key by chainId alone, so a
  // collision handed a foreign project's task back as `firstTask`.
  const mine = await seedTrigger("fires-scope-mine", { steps: 2 });
  const theirs = await seedTrigger("fires-scope-theirs", { steps: 2 });
  const fired = await call("POST", `/task-templates/${mine.template.id}/fire`);
  const chainId = fired.body.chainId as string;

  // A disjoint index range in the other project, so a chainId-only query would
  // sort the foreign rows first and pick one as `firstTask`.
  const foreign = await db.task.create({ data: {
    projectId: theirs.project.id, name: "FOREIGN PROJECT TASK", description: "d",
    chainId, chainIndex: -5, chainLayer: -5, status: "DONE",
  } });

  const { status, body } = await call("GET", `/triggers/${mine.template.id}/fires?take=20`);
  assert.equal(status, 200);
  const fire = body.find((row: any) => row.chainId === chainId);
  assert.notEqual(fire.firstTask, null);
  assert.notEqual(fire.firstTask.id, foreign.id);
  assert.equal(fire.firstTask.name.includes("FOREIGN"), false, fire.firstTask.name);
  // Two steps in my project, not three across both, and none of them done.
  assert.equal(fire.progress.total, 2);
  assert.equal(fire.progress.done, 0);
  assert.equal(fire.progress.activeStepName, "Step 1");
});

test("the fires route 404s for a template that does not exist", async () => {
  const { status } = await call("GET", "/triggers/nope-not-a-template/fires");
  assert.equal(status, 404);
});

// --- review fixes: an empty-string default does not resolve (CODE-REVIEW S7) -

test("an empty-string default is treated as absent, matching the required badge", async () => {
  // The badge promises "every fire that omits this will 400". Accepting "" as a
  // resolved value broke that promise on a trigger that fires fine.
  const { template } = await seedTrigger("fire-empty-default", {
    template: { webhookPayloadMapping: { map: {}, defaults: { ticket: "" } } },
  });
  const { status, body } = await call("POST", `/task-templates/${template.id}/fire`);
  assert.equal(status, 400);
  assert.match(body.error, /Unresolved template variables: ticket/);
  assert.equal(await db.triggerFire.count({ where: { templateId: template.id } }), 0);
});

// --- review fixes: a malformed body is a client error (CODE-REVIEW S3) -------

test("a malformed JSON body on fire is a named 400 refusal", async () => {
  const { template } = await seedTrigger("fire-bad-json");
  const response = await asOperator(() => createApp(db).request(`/task-templates/${template.id}/fire`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: "{not json",
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Request body must be valid JSON",
    code: "invalid-json",
  });
  // An empty body is still the `Fire now` happy path and must keep working.
  assert.equal((await call("POST", `/task-templates/${template.id}/fire`)).status, 201);
});

for (const source of ["manual", "webhook"] as const) {
  test(`${source} repairs retain the instantiated default after another profile is promoted`, async () => {
    const { project, template, agent } = await seedTrigger(`profile-${source}`);
    const profile = await db.staffingProfile.create({ data: {
      projectId: project.id, taskTemplateId: template.id, name: "A", isDefault: true,
      mergeTailRepairAgentId: agent.id,
    } });
    const response = source === "manual"
      ? await call("POST", `/task-templates/${template.id}/fire`)
      : await (async () => {
        const result = await createApp(db).request(`/hooks/templates/${template.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Anneal-Webhook-Secret": "wh-secret-batch25" },
          body: JSON.stringify({ issue: { title: "Profile provenance" } }),
        });
        return { status: result.status, body: await result.json() };
      })();
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const root = await db.task.findFirstOrThrow({
      where: { chainId: response.body.chainId }, orderBy: { chainIndex: "asc" },
    });
    const provenance = await db.taskActivity.findFirstOrThrow({
      where: { taskId: root.id, body: { startsWith: "Template instantiated" } },
    });
    assert.equal(provenance.actorType, source === "manual" ? "operator" : "webhook");
    await db.staffingProfile.update({ where: { id: profile.id }, data: { isDefault: false } });
    const other = await db.staffingProfile.create({ data: {
      projectId: project.id, taskTemplateId: template.id, name: "B", isDefault: true,
    } });
    await db.taskActivity.create({ data: {
      taskId: root.id, actorType: "operator", body: "Ordinary note with colliding metadata",
      metadata: { staffingProfileId: other.id },
    } });
    for (const repairKind of ["review-fix", "gate-fix"] as const) {
      assert.deepEqual(await db.$transaction((tx) => mergeTailRepairAssignee(tx, {
        projectId: project.id, templateId: template.id, chainId: root.chainId, repairKind,
      })), { kind: "agent", agentId: agent.id, label: agent.name });
    }
  });
}
