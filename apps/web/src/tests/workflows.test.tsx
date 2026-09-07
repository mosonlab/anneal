// Radix decides at import time whether portals may mount; see dom-preload.ts.
import "./dom-preload";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import type { JSDOM } from "jsdom";

import { ROUTES } from "../App";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import { ProjectProvider } from "../lib/project";
import { matchRoute } from "../lib/router";
import { storage } from "../lib/storage";
import type { Agent, Project, StaffingProfile, TaskTemplate, TaskTemplateStep } from "../lib/types";
import { availableProfileName, StaffingProfileEditor } from "../pages/Workflows";
import { mountPage, type PageHarness, type PageRoutes } from "./dom-harness";

const t = (locale: "en" | "zh", key: string, vars?: Record<string, string | number>): string =>
  translate(locale, key, vars);

/* ------------------------------------------------------------------ fixtures */

const PROJECT: Project = {
  id: "project-1",
  name: "Staffing project",
  slug: "staffing-project",
  yamlDocument: "",
  maxDurationMin: 240,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 3,
  specGateDefault: false,
  mergeGateDefault: false,
  spendCap: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const agent = (overrides: Partial<Agent> & Pick<Agent, "id" | "name" | "title">): Agent => ({
  projectId: PROJECT.id,
  environmentId: "env-1",
  canonicalRole: null,
  customizedFields: [],
  model: "claude-opus-5:medium",
  codexServiceTier: "DEFAULT",
  foundationalPrompt: "",
  rolePrompt: "",
  runnerPreference: "CLAUDE",
  inboxAccess: false,
  disabledTools: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  ...overrides,
});

const SENIOR = agent({ id: "a-senior", name: "senior-dev-opus-medium", title: "Senior Developer" });
const RETIRED = agent({
  id: "a-retired", name: "retired-dev-sol-high", title: "Retired Developer",
  archivedAt: "2026-09-02T00:00:00.000Z",
});
const SENTINEL = agent({ id: "a-merge", name: "merge-integrator", title: "Merge Integrator", assignable: false });
const AGENTS = [SENIOR, RETIRED, SENTINEL];

type TestTierSlots = { default: string | null; frontend: string | null; hard: string | null; hazard: string | null };
const EMPTY_TIERS: TestTierSlots = { default: null, frontend: null, hard: null, hazard: null };

const step = (overrides: Partial<TaskTemplateStep> & Pick<TaskTemplateStep, "stepIndex" | "name" | "outputKind">): TaskTemplateStep => ({
  id: `step-${overrides.stepIndex}`,
  assigneeType: "AGENT",
  executionOwner: "agent",
  prompt: "",
  approvalGate: false,
  optional: false,
  priorOutputKinds: [],
  baseFromStepIndex: null,
  runner: null,
  assigneeAgentId: null,
  assigneeAgent: null,
  ...overrides,
});

const TEMPLATE: TaskTemplate = {
  id: "template-1",
  projectId: PROJECT.id,
  name: "Direct engineering",
  description: "A direct chain without a spec phase",
  variables: [],
  retired: false,
  steps: [
    step({ stepIndex: 1, name: "Implementation", outputKind: "implementation", assigneeAgentId: SENIOR.id, assigneeAgent: SENIOR }),
    step({ stepIndex: 2, name: "Blind review", outputKind: "blind-findings", optional: true }),
    step({ stepIndex: 3, name: "Human PR review", outputKind: "human-review", assigneeType: "HUMAN" }),
    // Bound to an Agent so its task row has an assignee, and executed by the
    // control plane all the same: the row is exactly the case the console must
    // not read as staffable.
    step({
      stepIndex: 4, name: "Merge readiness", outputKind: "merge-authorization",
      executionOwner: "control-plane", assigneeAgentId: SENIOR.id, assigneeAgent: SENIOR,
    }),
  ],
};

const profile = (overrides: Partial<StaffingProfile> & Pick<StaffingProfile, "id" | "name"> & { tiers?: Partial<TestTierSlots> }): StaffingProfile & { tiers: TestTierSlots } => ({
  projectId: PROJECT.id,
  taskTemplateId: TEMPLATE.id,
  isDefault: false,
  mergeTailRepairAgentId: null,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  entries: [],
  ...overrides,
  tiers: { ...EMPTY_TIERS, ...overrides.tiers },
});

const FAST_LANE = profile({
  id: "p-fast",
  name: "Fast lane",
  isDefault: true,
  entries: [
    { outputKind: "implementation", assigneeAgentId: SENIOR.id, include: null },
    // Saved before the control plane owned that step; the next save must surface the refusal.
    { outputKind: "merge-authorization", assigneeAgentId: SENIOR.id, include: null },
  ],
});
const TIERED = profile({
  id: "p-tiered",
  name: "Tiered lane",
  tiers: { default: SENIOR.id, frontend: null, hard: SENIOR.id, hazard: null },
});
const CAREFUL = profile({ id: "p-careful", name: "Careful lane" });

const PROFILES_PATH = `/projects/${PROJECT.id}/task-templates/${TEMPLATE.id}/staffing-profiles`;

/* -------------------------------------------------------------------- helpers */

const scoped = (dom: JSDOM): void => {
  storage.set("agentos.projectId", PROJECT.id);
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => true });
};

/** Mounts whichever route owns `path`, exactly as `Routed` would pick it. */
const mountRoute = async (path: string, routes: PageRoutes, locale: "en" | "zh" = "en"): Promise<PageHarness> => {
  const matched = ROUTES.map((route) => ({ route, params: matchRoute(route.pattern, path) }))
    .find((candidate) => candidate.params !== null);
  assert.ok(matched, `no route matches ${path}`);
  return await mountPage(
    <LocaleProvider initialLocale={locale}>
      <ProjectProvider>{matched.route.render(matched.params ?? {})}</ProjectProvider>
    </LocaleProvider>,
    { "/projects": [PROJECT], ...routes },
    `http://127.0.0.1:5173/#${path}`,
    scoped,
  );
};

const templateRoutes = (profiles: StaffingProfile[]): PageRoutes => ({
  [`/projects/${PROJECT.id}/task-templates`]: [TEMPLATE],
  [PROFILES_PATH]: profiles,
  [`/projects/${PROJECT.id}/agents`]: AGENTS,
});

const rowFor = (page: PageHarness, outputKind: string): Element => {
  const row = page.container.querySelector(`[data-output-kind="${outputKind}"]`);
  assert.ok(row, `missing step row ${outputKind}`);
  return row;
};

const selectIn = async (page: PageHarness, row: Element, value: string): Promise<void> => {
  const select = row.querySelector("select");
  assert.ok(select, "the row should carry an agent picker");
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  });
  await page.settle();
};

const bodyOf = (page: PageHarness, method: string, path: string): Record<string, unknown> => {
  const request = page.requests.find((entry) => entry.method === method && entry.path === path);
  assert.ok(request, `no ${method} ${path} was sent`);
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
};

/* ---------------------------------------------------------------------- pages */

test("the three Workflows routes are registered and the list renders its templates", async () => {
  for (const path of ["/workflows", "/workflows/template-1", "/workflows/template-1/profiles/p-fast"]) {
    assert.ok(ROUTES.some((route) => matchRoute(route.pattern, path) !== null), `no route for ${path}`);
  }
  const page = await mountRoute("/workflows", templateRoutes([FAST_LANE]));
  try {
    const text = page.container.textContent ?? "";
    assert.match(text, /Direct engineering/u);
    assert.ok(text.includes(t("en", "workflows.template.steps", { n: 4 })));
    assert.ok(page.container.querySelector('a[href="#/workflows/template-1"]'), "the template should link to its profiles");
  } finally {
    await page.dispose();
  }
});

const listed = (id: string, name: string, retired: boolean): TaskTemplate => ({
  ...TEMPLATE, id, name, retired, description: "",
});

const CURRENT = [listed("t-pr", "pr-engineer-workflow", false), listed("t-direct", "compound-engineer-workflow", false)];
const RETIRED_GENERATIONS = [
  listed("t-legacy-1", "direct-engineer-workflow-legacy-pre-adjudication-t1", true),
  listed("t-legacy-2", "direct-engineer-workflow-legacy-pre-zero-gate-t2", true),
  listed("t-legacy-3", "compound-engineer-workflow-legacy-pre-adjudication-t3", true),
];

const listRoutes = (templates: TaskTemplate[]): PageRoutes => ({
  [`/projects/${PROJECT.id}/task-templates`]: templates,
});

const rowNames = (page: PageHarness): string[] =>
  [...page.container.querySelectorAll("[data-template-row] a")].map((node) => node.textContent ?? "");

test("the list ranks current templates by name and folds retired generations into one collapsed group", async () => {
  // The control plane lists by createdAt, retired rows first; the page does not.
  const page = await mountRoute("/workflows", listRoutes([...RETIRED_GENERATIONS, ...CURRENT]));
  try {
    assert.deepEqual(rowNames(page), ["compound-engineer-workflow", "pr-engineer-workflow"]);
    const toggle = page.container.querySelector<HTMLButtonElement>("[data-retired-toggle]");
    assert.ok(toggle, "the retired group should have a header");
    assert.equal(toggle.textContent, t("en", "workflows.retired.group", { n: 3 }));
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    await act(async () => toggle.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await page.settle();
    assert.deepEqual(rowNames(page), [
      "compound-engineer-workflow",
      "pr-engineer-workflow",
      ...RETIRED_GENERATIONS.map((template) => template.name),
    ]);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    for (const template of RETIRED_GENERATIONS) {
      assert.ok(page.container.querySelector(`a[href="#/workflows/${template.id}"]`), `${template.name} should stay navigable`);
    }
  } finally {
    await page.dispose();
  }
});

test("a project with no retired generation renders no group at all", async () => {
  const page = await mountRoute("/workflows", listRoutes(CURRENT));
  try {
    assert.equal(page.container.querySelector("[data-retired-toggle]"), null);
    assert.ok(!(page.container.textContent ?? "").includes("Retired"), page.container.textContent ?? "");
    assert.equal(rowNames(page).length, 2);
  } finally {
    await page.dispose();
  }
});

test("a template list of an unexpected shape is an error on screen, not an empty list", async () => {
  const page = await mountRoute("/workflows", { [`/projects/${PROJECT.id}/task-templates`]: [{ id: "t-1", name: "No retirement field" }] });
  try {
    assert.match(page.container.textContent ?? "", new RegExp(t("en", "workflows.error.shape")));
    assert.equal(page.container.querySelector("table"), null);
    assert.ok(!(page.container.textContent ?? "").includes(t("en", "workflows.templates.empty")));
  } finally {
    await page.dispose();
  }
});

for (const [label, body] of [
  ["object description", [{ ...TEMPLATE, description: { bad: true } }]],
  ["missing description", [{ ...TEMPLATE, description: undefined }]],
  ["invalid variables", [{ ...TEMPLATE, variables: [123] }]],
  ["invalid step", [{ ...TEMPLATE, steps: [null] }]],
  ["null body", null],
  ["empty body", new Response(null, { status: 200 })],
  ["malformed step fields", [{ ...TEMPLATE, steps: [{ ...TEMPLATE.steps[0], priorOutputKinds: [123] }] }]],
] as const) {
  test(`the template list rejects ${label} with a localized error`, async () => {
    const page = await mountRoute("/workflows", { [`/projects/${PROJECT.id}/task-templates`]: body });
    try {
      assert.ok((page.container.textContent ?? "").includes(t("en", "workflows.error.shape")));
      assert.equal(page.container.querySelector("table"), null);
      assert.ok(!(page.container.textContent ?? "").includes(t("en", "workflows.templates.empty")));
    } finally {
      await page.dispose();
    }
  });
}

test("the profile list shows the default badge and refuses to delete the default while others exist", async () => {
  const page = await mountRoute("/workflows/template-1", templateRoutes([FAST_LANE, CAREFUL]));
  try {
    const text = page.container.textContent ?? "";
    assert.match(text, /Fast lane/u);
    assert.match(text, /Careful lane/u);
    assert.ok(text.includes(t("en", "workflows.profile.default")));
    assert.ok(text.includes(t("en", "workflows.profile.delete.refused")), "the refusal hint should be on screen");
    const deletes = [...page.container.querySelectorAll("button")]
      .filter((node) => node.textContent?.trim() === t("en", "common.delete"));
    assert.equal(deletes.length, 2);
    // The default is the one the control plane answers 409 for; the other is free.
    assert.deepEqual(deletes.map((node) => (node as HTMLButtonElement).disabled), [true, false]);
  } finally {
    await page.dispose();
  }
});

test("a template with no profile says instantiation falls back to the canonical bindings", async () => {
  const page = await mountRoute("/workflows/template-1", templateRoutes([]));
  try {
    const text = page.container.textContent ?? "";
    assert.ok(text.includes(t("en", "workflows.profiles.empty")));
    assert.ok(text.includes(t("en", "workflows.profiles.empty.hint")));
  } finally {
    await page.dispose();
  }
});

test("promoting a profile sends PATCH { isDefault: true }", async () => {
  const page = await mountRoute("/workflows/template-1", {
    ...templateRoutes([FAST_LANE, CAREFUL]),
    "PATCH /staffing-profiles/p-careful": CAREFUL,
  });
  try {
    const promotes = [...page.container.querySelectorAll("button")]
      .filter((node) => node.textContent?.trim() === t("en", "workflows.profile.setDefault"));
    // The profile that is already the default has nothing to promote.
    assert.deepEqual(promotes.map((node) => (node as HTMLButtonElement).disabled), [true, false]);
    const promote = promotes[1];
    assert.ok(promote);
    await act(async () => promote.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await page.settle();
    assert.deepEqual(bodyOf(page, "PATCH", "/staffing-profiles/p-careful"), { isDefault: true });
  } finally {
    await page.dispose();
  }
});

test("duplicating a profile posts a copy of its entries under a new name", async () => {
  const page = await mountRoute("/workflows/template-1", {
    ...templateRoutes([FAST_LANE]),
    [`POST ${PROFILES_PATH}`]: { profile: FAST_LANE, warnings: [] },
  });
  try {
    await page.press(t("en", "workflows.profile.duplicate"));
    assert.deepEqual(bodyOf(page, "POST", PROFILES_PATH), {
      name: t("en", "workflows.profile.copyName", { name: "Fast lane" }),
      entries: FAST_LANE.entries,
      tiers: EMPTY_TIERS,
    });
  } finally {
    await page.dispose();
  }
});

test("a refused write reaches the operator as the control plane's own message", async () => {
  const page = await mountRoute("/workflows/template-1", {
    ...templateRoutes([FAST_LANE]),
    [`POST ${PROFILES_PATH}`]: new Response(
      JSON.stringify({ error: "A profile of this template is already named that", code: "staffing_profile_name_taken" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
  });
  try {
    await page.press(t("en", "workflows.profile.duplicate"));
    assert.match(page.container.textContent ?? "", /409 A profile of this template is already named that/u);
  } finally {
    await page.dispose();
  }
});

/* --------------------------------------------------------------------- editor */

const mountEditor = async (locale: "en" | "zh", routes: PageRoutes = {}, heldProfile: StaffingProfile = FAST_LANE): Promise<{
  page: PageHarness;
  saves: () => number;
}> => {
  let saved = 0;
  const page = await mountPage(
    <LocaleProvider initialLocale={locale}>
      <StaffingProfileEditor template={TEMPLATE} profile={heldProfile} agents={AGENTS} onSaved={() => { saved += 1; }} />
    </LocaleProvider>,
    routes,
  );
  return { page, saves: () => saved };
};

test("the editor shows all four implementation tier slots and saves their agents", async () => {
  const { page } = await mountEditor("en", {
    "PUT /staffing-profiles/p-tiered": { profile: TIERED, warnings: [] },
  }, TIERED);
  try {
    const slots = [...page.container.querySelectorAll<HTMLSelectElement>("[data-implementation-tier]")];
    assert.deepEqual(slots.map((select) => select.dataset.implementationTier), ["default", "frontend", "hard", "hazard"]);
    assert.deepEqual(slots.map((select) => select.value), [SENIOR.id, "", SENIOR.id, ""]);

    await act(async () => {
      const frontend = page.container.querySelector<HTMLSelectElement>('[data-implementation-tier="frontend"]');
      assert.ok(frontend);
      frontend.value = SENIOR.id;
      frontend.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
    });
    await page.settle();
    await page.press(t("en", "workflows.editor.save"));
    assert.deepEqual(bodyOf(page, "PUT", "/staffing-profiles/p-tiered").tiers, {
      default: SENIOR.id,
      frontend: SENIOR.id,
      hard: SENIOR.id,
      hazard: null,
    });
  } finally {
    await page.dispose();
  }
});

for (const locale of ["en", "zh"] as const) {
  test(`the editor renders one row per step, staffable agents only, and an include toggle only on optional steps in ${locale}`, async () => {
    const { page } = await mountEditor(locale);
    try {
      const rows = page.container.querySelectorAll("[data-output-kind]");
      assert.equal(rows.length, TEMPLATE.steps.length);

      // The canonical binding is the placeholder, so a row with no opinion still
      // says who runs it today.
      const implementation = rowFor(page, "implementation");
      const options = [...implementation.querySelectorAll("option")].map((node) => node.textContent);
      assert.deepEqual(options, [
        t(locale, "workflows.editor.canonical", { name: SENIOR.title }),
        `${SENIOR.title} · Claude Opus 5 medium`,
      ]);
      assert.equal((implementation.querySelector("select") as HTMLSelectElement).value, SENIOR.id);

      // Archived and non-assignable agents are absent from every picker.
      const everyOption = [...page.container.querySelectorAll("option")].map((node) => node.textContent ?? "");
      assert.ok(!everyOption.some((label) => label.includes(RETIRED.title)));
      assert.ok(!everyOption.some((label) => label.includes(SENTINEL.title)));

      // Neither is a step the control plane runs, whatever Agent its row binds.
      const readiness = rowFor(page, "merge-authorization");
      assert.equal(readiness.querySelector("select"), null);
      assert.ok((readiness.textContent ?? "").includes(t(locale, "workflows.editor.controlPlane")));

      // A human step is not staffable at all.
      assert.equal(rowFor(page, "human-review").querySelector("select"), null);
      assert.ok((rowFor(page, "human-review").textContent ?? "").includes(t(locale, "workflows.editor.human")));

      const toggles = page.container.querySelectorAll('[role="switch"]');
      assert.equal(toggles.length, 1);
      assert.ok(rowFor(page, "blind-findings").contains(toggles[0] ?? null));
      assert.equal(toggles[0]?.getAttribute("aria-label"), t(locale, "workflows.editor.include.aria", { name: "Blind review" }));
    } finally {
      await page.dispose();
    }
  });
}

test("saving preserves a legacy readiness assignment and shows the refusal", async () => {
  const { page, saves } = await mountEditor("en", {
    "PUT /staffing-profiles/p-fast": new Response(
      JSON.stringify({ code: "staffing_profile_step_control_plane", error: "Step Merge readiness (merge-authorization) is executed by the control plane and staffs no agent; remove its entry from this profile", outputKind: "merge-authorization" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ),
  });
  try {
    await selectIn(page, rowFor(page, "blind-findings"), SENIOR.id);
    const toggle = page.container.querySelector('[role="switch"]');
    assert.ok(toggle);
    await act(async () => toggle.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await page.settle();

    await page.press(t("en", "workflows.editor.save"));
    assert.deepEqual(bodyOf(page, "PUT", "/staffing-profiles/p-fast"), {
      name: "Fast lane",
      entries: [
        // Untouched rows keep no opinion at all: a PUT replaces the list whole,
        // so an omitted kind means "the template's own binding stands".
        { outputKind: "implementation", assigneeAgentId: SENIOR.id, include: null },
        { outputKind: "blind-findings", assigneeAgentId: SENIOR.id, include: false },
        { outputKind: "merge-authorization", assigneeAgentId: SENIOR.id, include: null },
      ],
      tiers: EMPTY_TIERS,
    });
    assert.equal(saves(), 0);
    assert.match(page.container.textContent ?? "", /400 Step Merge readiness.*remove its entry/u);
  } finally {
    await page.dispose();
  }
});

test("the warnings a save answers with are shown without blocking it", async () => {
  const message = "Senior Developer both implements and reviews under this plan";
  const { page } = await mountEditor("en", {
    "PUT /staffing-profiles/p-fast": {
      profile: FAST_LANE,
      warnings: [{ code: "same_agent_implements_and_reviews", message }],
    },
  });
  try {
    await page.press(t("en", "workflows.editor.save"));
    assert.match(page.container.textContent ?? "", new RegExp(message, "u"));
  } finally {
    await page.dispose();
  }
});

test("a refused save keeps the draft and shows the refusal", async () => {
  const { page, saves } = await mountEditor("en", {
    "PUT /staffing-profiles/p-fast": new Response(
      JSON.stringify({ error: "merge-integrator binds nothing else", code: "staffing_profile_integrator_binding" }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ),
  });
  try {
    await selectIn(page, rowFor(page, "blind-findings"), SENIOR.id);
    await page.press(t("en", "workflows.editor.save"));
    assert.match(page.container.textContent ?? "", /422 merge-integrator binds nothing else/u);
    assert.equal(saves(), 0, "a refused save must not report success");
    // The draft survives the refusal, so the operator can correct it in place.
    assert.equal((rowFor(page, "blind-findings").querySelector("select") as HTMLSelectElement).value, SENIOR.id);
  } finally {
    await page.dispose();
  }
});

/* ------------------------------------------------------- duplicate naming */

test("duplicating the same profile twice walks past the copy it already made", async () => {
  const held: StaffingProfile[] = [FAST_LANE];
  const names: string[] = [];
  const page = await mountRoute("/workflows/template-1", {
    [`/projects/${PROJECT.id}/task-templates`]: [TEMPLATE],
    [`/projects/${PROJECT.id}/agents`]: AGENTS,
    [PROFILES_PATH]: () => held,
    [`POST ${PROFILES_PATH}`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as { name: string };
      names.push(body.name);
      // The control plane's own rule: names are unique within a template.
      if (held.some((candidate) => candidate.name === body.name)) {
        return new Response(
          JSON.stringify({ error: "A profile of this template is already named that", code: "staffing_profile_name_taken" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      const created = profile({ id: `p-copy-${held.length}`, name: body.name, entries: FAST_LANE.entries });
      held.push(created);
      return { profile: created, warnings: [] };
    },
  });
  try {
    await page.press(t("en", "workflows.profile.duplicate"));
    await page.press(t("en", "workflows.profile.duplicate"));
    assert.deepEqual(names, [
      t("en", "workflows.profile.copyName", { name: "Fast lane" }),
      `${t("en", "workflows.profile.copyName", { name: "Fast lane" })} 2`,
    ]);
    // A repeatable command does not teach the operator to expect a 409.
    assert.doesNotMatch(page.container.textContent ?? "", /already named that/u);
  } finally {
    await page.dispose();
  }
});

test("a free copy name is taken as it is, and a taken one is numbered past the copies", () => {
  assert.equal(availableProfileName("Fast lane copy", new Set()), "Fast lane copy");
  assert.equal(availableProfileName("Fast lane copy", new Set(["Fast lane copy"])), "Fast lane copy 2");
  assert.equal(
    availableProfileName("Fast lane copy", new Set(["Fast lane copy", "Fast lane copy 2"])),
    "Fast lane copy 3",
  );
});

/* ------------------------------------------------- reading, failing, empty */

test("a failed profile read shows the failure with its retry instead of an empty template", async () => {
  const page = await mountRoute("/workflows/template-1", {
    [`/projects/${PROJECT.id}/task-templates`]: [TEMPLATE],
    [`/projects/${PROJECT.id}/agents`]: AGENTS,
    [PROFILES_PATH]: () => new Response(
      JSON.stringify({ error: "Task template not found", code: "not_found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    ),
  });
  try {
    const text = page.container.textContent ?? "";
    assert.ok(text.includes(t("en", "workflows.error.profiles", { reason: "404 Task template not found" })));
    // "No staffing profile for this template" is a fact about the template. A
    // read that failed knows no such fact, and saying both is telling the
    // operator that instantiation falls back to the canonical bindings.
    assert.ok(!text.includes(t("en", "workflows.profiles.empty")));
    assert.ok([...page.container.querySelectorAll("button")].some((node) => node.textContent?.trim() === t("en", "common.retry")));
  } finally {
    await page.dispose();
  }
});

test("a template whose profiles have not landed says it is loading, not that it has none", async () => {
  const page = await mountRoute("/workflows/template-1", {
    [`/projects/${PROJECT.id}/task-templates`]: [TEMPLATE],
    [`/projects/${PROJECT.id}/agents`]: AGENTS,
    [PROFILES_PATH]: () => new Promise<Response>(() => undefined),
  });
  try {
    const text = page.container.textContent ?? "";
    assert.ok(text.includes(t("en", "common.loading")));
    assert.ok(!text.includes(t("en", "workflows.profiles.empty")));
  } finally {
    await page.dispose();
  }
});

test("a failed template read is a notice on the profile list, not a page stuck on Loading", async () => {
  const page = await mountRoute("/workflows/template-1", {
    [`/projects/${PROJECT.id}/task-templates`]: () => new Response(
      JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } },
    ),
    [`/projects/${PROJECT.id}/agents`]: AGENTS,
    [PROFILES_PATH]: [FAST_LANE],
  });
  try {
    assert.ok((page.container.textContent ?? "").includes(t("en", "workflows.error.templates", { reason: "500 boom" })));
  } finally {
    await page.dispose();
  }
});

/* --------------------------------------------------- the editor's own reads */

test("a profile that is no longer in the list says so instead of loading forever", async () => {
  const page = await mountRoute("/workflows/template-1/profiles/p-fast", {
    ...templateRoutes([CAREFUL]),
  });
  try {
    const text = page.container.textContent ?? "";
    assert.ok(text.includes(t("en", "workflows.profile.missing")));
    assert.ok(!text.includes(t("en", "common.loading")));
  } finally {
    await page.dispose();
  }
});

test("a failed agent read is named, so an empty picker is never mistaken for an empty project", async () => {
  const page = await mountRoute("/workflows/template-1/profiles/p-fast", {
    [`/projects/${PROJECT.id}/task-templates`]: [TEMPLATE],
    [PROFILES_PATH]: [FAST_LANE],
    [`/projects/${PROJECT.id}/agents`]: () => new Response(
      JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } },
    ),
  });
  try {
    const text = page.container.textContent ?? "";
    assert.ok(text.includes(t("en", "workflows.error.agents", { reason: "500 boom" })));
    // The editor still renders, with the canonical bindings it can name.
    assert.ok(page.container.querySelector('[data-output-kind="implementation"]'));
  } finally {
    await page.dispose();
  }
});

/* ------------------------------------------------------------ accessibility */

test("every profile control is named by its own label", async () => {
  const page = await mountRoute("/workflows/template-1/profiles/p-fast", templateRoutes([FAST_LANE]));
  try {
    const named = (scope: Element, label: string): Element => {
      const node = [...scope.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(node, `no label reads ${label}`);
      const target = node.getAttribute("for");
      assert.ok(target, `the label ${label} names no control`);
      const control = page.dom.window.document.getElementById(target);
      assert.ok(control, `the label ${label} points at no element`);
      return control;
    };
    const name = named(page.container, t("en", "workflows.profile.name"));
    assert.equal((name as HTMLInputElement).value, FAST_LANE.name);
    const row = rowFor(page, "implementation");
    assert.equal(named(row, t("en", "workflows.editor.agent")), row.querySelector("select"));
    // The human step names no picker, because it has none.
    assert.equal(rowFor(page, "human-review").querySelector("label"), null);
  } finally {
    await page.dispose();
  }
});

test("the create dialog's name field is named by its label", async () => {
  const page = await mountRoute("/workflows/template-1", templateRoutes([FAST_LANE]));
  try {
    await page.press(t("en", "workflows.profiles.create"));
    const document = page.dom.window.document;
    const label = [...document.querySelectorAll("label")]
      .find((node) => node.textContent?.trim() === t("en", "workflows.profile.name"));
    assert.ok(label, document.body.innerHTML);
    const target = label.getAttribute("for");
    assert.ok(target);
    assert.ok(document.getElementById(target), "the dialog's label should name its input");
  } finally {
    await page.dispose();
  }
});
