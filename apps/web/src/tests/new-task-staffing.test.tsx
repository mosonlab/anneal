import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import { activeStaffingSelection, NewTask } from "../components/new-task-panel";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import type { Agent, Repo, StaffingProfile, TaskTemplate, TaskTemplateStep } from "../lib/types";
import { mountPage } from "./dom-harness";

/**
 * What the panel promises about staffing a chain.
 *
 * The load-bearing assertions are on the instantiate body, because the two
 * halves of the feature are invisible from the rendered page: `stepOverrides`
 * must carry only what the operator changed against the plan the server will
 * apply, and the explicit canonical option must pin the steps a default profile
 * would otherwise have moved — a request that names no profile is still staffed
 * from that default.
 */

const en = (key: string, values?: Record<string, string | number>): string => translate("en", key, values);

const agent = (id: string, title: string, model: string): Agent => ({
  id, projectId: "project-1", environmentId: "env-1", name: id, canonicalRole: null, customizedFields: [],
  title, model, codexServiceTier: "DEFAULT", runnerPreference: "INHERIT", inboxAccess: false, disabledTools: [],
  foundationalPrompt: "foundation", rolePrompt: "role", archivedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
});

const implementer = agent("agent-impl", "Senior Developer", "gpt-6-astra:medium");
const reviewer = agent("agent-review", "Reviewer", "gpt-5.6-luna:max");
const stand_in = agent("agent-standin", "Stand In", "claude-opus-5:high");
const integrator: Agent = { ...agent("agent-merge", "Merge Integrator", "gpt-5.6-sol:low"), assignable: false };

const step = (stepIndex: number, name: string, outputKind: string, overrides: Partial<TaskTemplateStep> = {}): TaskTemplateStep => ({
  id: `step-${stepIndex}`,
  stepIndex,
  name,
  assigneeType: "AGENT",
  executionOwner: "agent",
  prompt: "",
  approvalGate: false,
  optional: false,
  outputKind,
  priorOutputKinds: [],
  baseFromStepIndex: null,
  runner: null,
  assigneeAgentId: null,
  assigneeAgent: null,
  ...overrides,
});

const template: TaskTemplate = {
  id: "template-1",
  projectId: "project-1",
  name: "Delivery",
  description: "",
  variables: [],
  retired: false,
  steps: [
    step(1, "Implementation", "implementation", { assigneeAgentId: implementer.id, assigneeAgent: implementer }),
    step(2, "Review", "review", { optional: true, assigneeAgentId: reviewer.id, assigneeAgent: reviewer }),
    step(3, "Sign off", "sign-off", { assigneeType: "HUMAN" }),
  ],
};

const profile = (
  id: string,
  name: string,
  isDefault: boolean,
  entries: StaffingProfile["entries"],
): StaffingProfile => ({
  id,
  projectId: "project-1",
  taskTemplateId: template.id,
  name,
  isDefault,
  mergeTailRepairAgentId: null,
  tiers: { default: null, frontend: null, hard: null, hazard: null },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  entries,
});

/** The default plan moves implementation to the stand-in and drops the review. */
const fastLane = profile("profile-fast", "Fast lane", true, [
  { outputKind: "implementation", assigneeAgentId: stand_in.id, include: null },
  { outputKind: "review", assigneeAgentId: null, include: false },
]);
/** The thorough plan keeps the review and leaves implementation canonical. */
const thorough = profile("profile-thorough", "Thorough", false, [
  { outputKind: "review", assigneeAgentId: reviewer.id, include: true },
]);

const repos: Repo[] = [{
  id: "repo-1", projectId: "project-1", credentialSecretId: null, name: "anneal",
  remoteUrl: "https://github.com/o/r", mountPath: "/repos/anneal", defaultBranch: "main",
  dependencyProvisioning: "NONE",
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
}];

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

type Panel = Awaited<ReturnType<typeof mountPage>> & { posts: Array<Record<string, unknown>> };

/** How one test answers the profile reads: by path, and by which read it is. */
type Staffing = (path: string, attempt: number) => Response | Promise<Response>;

const mountPanel = async (
  staffing: Staffing,
  locale: "en" | "zh" = "en",
  templates: TaskTemplate[] = [template],
): Promise<Panel> => {
  const posts: Array<Record<string, unknown>> = [];
  const reads = new Map<string, number>();
  const page = await mountPage(
    <LocaleProvider initialLocale={locale}>
      <NewTask
        projectId="project-1"
        agents={[implementer, reviewer, stand_in, integrator]}
        repos={repos}
        onClose={() => undefined}
        onCreated={() => undefined}
      />
    </LocaleProvider>,
    { "*": ({ input, init, method }) => {
      const path = String(input).replace(/^.*\/api/u, "");
      if (method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (path === "/projects/project-1/task-templates") return response(templates);
      if (path.endsWith("/staffing-profiles")) {
        const attempt = (reads.get(path) ?? 0) + 1;
        reads.set(path, attempt);
        return staffing(path, attempt);
      }
      return response({});
    } },
  );
  await page.press(translate(locale, "newTask.tab.template"));
  return Object.assign(page, { posts });
};

const mount = async (profiles: StaffingProfile[], locale: "en" | "zh" = "en"): Promise<Panel> =>
  await mountPanel(() => response(profiles), locale);

/** A response this test hands over when it chooses to, not when the page asks. */
const deferred = (): { promise: Promise<Response>; answer: (body: unknown) => void } => {
  let settle: (value: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => { settle = resolve; });
  return { promise, answer: (body) => settle(response(body)) };
};

const createButton = (page: Panel): HTMLButtonElement => {
  const button = [...page.container.querySelectorAll("button")]
    .find((node) => node.textContent?.trim() === en("newTask.create"));
  assert.ok(button, "the Create button should be present");
  return button as HTMLButtonElement;
};

/** The control a visible label names, resolved the way assistive technology
 *  resolves it: `label[for]` to the element that owns the id. */
const labelledControl = (page: Panel, label: string): HTMLElement => {
  const node = [...page.container.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(node, `no label reads ${label}`);
  const target = node.getAttribute("for");
  assert.ok(target, `the label ${label} names no control`);
  const control = page.dom.window.document.getElementById(target);
  assert.ok(control, `the label ${label} points at no element`);
  return control;
};

const selects = (page: Panel): HTMLSelectElement[] =>
  [...page.container.querySelectorAll("select")] as HTMLSelectElement[];

/** The staffing profile picker: after the template picker and the repo picker. */
const profileSelect = (page: Panel): HTMLSelectElement => {
  const found = selects(page)[2];
  assert.ok(found, "the staffing profile picker should be present");
  return found;
};

/** The agent picker of the step at `position` among the agent steps. */
const stepSelect = (page: Panel, position: number, hasProfiles: boolean): HTMLSelectElement => {
  const found = selects(page)[(hasProfiles ? 3 : 2) + position];
  assert.ok(found, `step picker ${position} should be present`);
  return found;
};

const choose = async (page: Panel, select: HTMLSelectElement, value: string): Promise<void> => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  });
  await page.settle();
};

const fillTitle = async (page: Panel, value: string): Promise<void> => {
  const label = [...page.container.querySelectorAll("label")]
    .find((candidate) => candidate.textContent?.trim() === en("newTask.field.title.label"));
  assert.ok(label, "the title field should be present");
  const input = label.parentElement?.querySelector("input") as HTMLInputElement | null;
  assert.ok(input, "the title field should contain an input");
  const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  });
  await page.settle();
};

const create = async (page: Panel, title = "Ship it"): Promise<Record<string, unknown>> => {
  await fillTitle(page, title);
  await page.press(en("newTask.create"));
  const body = page.posts.at(-1);
  assert.ok(body, "instantiate should have been posted");
  return body;
};

const previewText = (page: Panel): string => {
  const preview = page.container.querySelector<HTMLElement>('[class*="whitespace-pre-wrap"]');
  assert.ok(preview, "the template preview should be rendered");
  return preview.textContent ?? "";
};

test("the default profile is preselected and staffs the preview", async () => {
  const page = await mount([fastLane, thorough]);
  try {
    assert.equal(profileSelect(page).value, fastLane.id);
    const text = previewText(page);
    // Implementation reads the profile's agent, not the canonical one.
    assert.ok(text.includes(en("newTask.preview.agent", { name: stand_in.title })));
    assert.ok(!text.includes(en("newTask.preview.agent", { name: implementer.title })));
    // The profile drops the optional review, so the preview says so.
    assert.ok(text.includes(en("newTask.preview.skipped")));
  } finally {
    await page.dispose();
  }
});

test("a dispatch that accepts the default profile sends its id and no overrides", async () => {
  const page = await mount([fastLane, thorough]);
  try {
    const body = await create(page);
    assert.equal(body.staffingProfileId, fastLane.id);
    assert.equal("stepOverrides" in body, false);
  } finally {
    await page.dispose();
  }
});

test("changing the profile reseeds every step and sends the new profile's id", async () => {
  const page = await mount([fastLane, thorough]);
  try {
    await choose(page, profileSelect(page), thorough.id);
    // `Thorough` has no implementation opinion, so the canonical binding returns.
    assert.equal(stepSelect(page, 0, true).value, implementer.id);
    assert.ok(previewText(page).includes(en("newTask.preview.agent", { name: implementer.title })));
    assert.ok(!previewText(page).includes(en("newTask.preview.skipped")));
    const body = await create(page);
    assert.equal(body.staffingProfileId, thorough.id);
    assert.equal("stepOverrides" in body, false);
  } finally {
    await page.dispose();
  }
});

test("a per-step agent change emits only that step's key", async () => {
  const page = await mount([fastLane, thorough]);
  try {
    await choose(page, stepSelect(page, 0, true), reviewer.id);
    const body = await create(page);
    assert.equal(body.staffingProfileId, fastLane.id);
    assert.deepEqual(body.stepOverrides, { "1": { assigneeAgentId: reviewer.id } });
    assert.ok(previewText(page).includes(en("newTask.preview.agent", { name: reviewer.title })));
  } finally {
    await page.dispose();
  }
});

test("restoring a changed step drops its key again", async () => {
  const page = await mount([fastLane, thorough]);
  try {
    const select = stepSelect(page, 0, true);
    await choose(page, select, reviewer.id);
    await choose(page, stepSelect(page, 0, true), stand_in.id);
    const body = await create(page);
    assert.equal("stepOverrides" in body, false);
  } finally {
    await page.dispose();
  }
});

test("the include toggle emits include on the optional step and marks it skipped", async () => {
  const page = await mount([thorough]);
  try {
    // `Thorough` is the only profile, so it is the default the panel preselects
    // and it keeps the optional review.
    assert.ok(!previewText(page).includes(en("newTask.preview.skipped")));
    await page.press(en("newTask.staffing.step.include", { name: "Review" }));
    assert.ok(previewText(page).includes(en("newTask.preview.skipped")));
    const body = await create(page);
    assert.deepEqual(body.stepOverrides, { "2": { include: false } });
  } finally {
    await page.dispose();
  }
});

test("the canonical option sends no profile id and pins what the default profile would have moved", async () => {
  const page = await mount([fastLane, thorough]);
  try {
    await choose(page, profileSelect(page), "");
    assert.ok((page.container.textContent ?? "").includes(en("newTask.staffing.canonical.hint")));
    assert.equal(stepSelect(page, 0, true).value, implementer.id);
    const body = await create(page);
    assert.equal("staffingProfileId" in body, false);
    // Without these the control plane would still staff the chain from
    // `Fast lane`: the stand-in on step 1 and no review at all.
    assert.deepEqual(body.stepOverrides, {
      "1": { assigneeAgentId: implementer.id },
      "2": { include: true },
    });
  } finally {
    await page.dispose();
  }
});

test("a template with no profiles hides the picker and sends nothing extra", async () => {
  const page = await mount([]);
  try {
    assert.equal(selects(page).length, 4, "template, repo and the two agent steps");
    assert.ok(!(page.container.textContent ?? "").includes(en("newTask.staffing.profile.label")));
    const body = await create(page);
    assert.equal("staffingProfileId" in body, false);
    assert.equal("stepOverrides" in body, false);
    // A human step is staffed by nobody, and offers no agent picker to say so.
    assert.ok(previewText(page).includes(en("newTask.preview.agent", { name: en("newTask.preview.human") })));
  } finally {
    await page.dispose();
  }
});

test("the agent picker offers assignable agents as title, model and effort", async () => {
  const page = await mount([]);
  try {
    const options = [...stepSelect(page, 0, false).options].map((option) => option.textContent ?? "");
    assert.deepEqual(options, [
      "Senior Developer · GPT-6 Astra (codex) medium",
      "Reviewer · GPT-5.6 Luna (codex) max",
      "Stand In · Claude Opus 5 high",
    ]);
    // The merge-integrator sentinel is not an assignee an operator may pick.
    assert.ok(!options.some((option) => option.includes(integrator.title)));
  } finally {
    await page.dispose();
  }
});

test("the staffing controls are translated in Chinese", async () => {
  const page = await mount([fastLane, thorough], "zh");
  try {
    const text = page.container.textContent ?? "";
    assert.match(text, /配人档案/u);
    assert.match(text, /Fast lane（默认）/u);
    assert.match(text, /模板默认（模板自带绑定）/u);
    assert.match(previewText(page), /（跳过）/u);
  } finally {
    await page.dispose();
  }
});

/* --------------------------------------------- the profile read is a gate */

test("Create waits for the first profile read, and says what it is waiting for", async () => {
  const gate = deferred();
  const page = await mountPanel(() => gate.promise);
  try {
    await fillTitle(page, "Ship it");
    // The steps on screen are the canonical bindings, and the control plane
    // would staff this chain from the default profile instead. Dispatching here
    // creates something other than what the preview shows.
    assert.equal(createButton(page).disabled, true);
    assert.ok((page.container.textContent ?? "").includes(en("newTask.staffing.loading")));

    await act(async () => { gate.answer([fastLane, thorough]); });
    await page.settle();
    assert.equal(createButton(page).disabled, false);
    assert.ok(!(page.container.textContent ?? "").includes(en("newTask.staffing.loading")));
    assert.equal(profileSelect(page).value, fastLane.id);
  } finally {
    await page.dispose();
  }
});

test("a failed profile read is on screen with a retry, and holds Create until it lands", async () => {
  const page = await mountPanel((_path, attempt) => (attempt === 1
    ? new Response(JSON.stringify({ error: "profiles unavailable" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    })
    : response([fastLane, thorough])));
  try {
    await fillTitle(page, "Ship it");
    assert.equal(createButton(page).disabled, true);
    assert.ok((page.container.textContent ?? "").includes(en("newTask.staffing.error", { reason: "503 profiles unavailable" })));

    await page.press(en("common.retry"));
    assert.equal(createButton(page).disabled, false);
    assert.equal(profileSelect(page).value, fastLane.id);
    assert.equal(page.posts.length, 0, "nothing may be dispatched while the plan is unknown");
  } finally {
    await page.dispose();
  }
});

test("switching templates holds Create until the new template's profiles answer", async () => {
  const second: TaskTemplate = { ...template, id: "template-2", name: "Second" };
  const gate = deferred();
  const page = await mountPanel(
    (path) => (path.includes("template-2") ? gate.promise : response([fastLane, thorough])),
    "en",
    [template, second],
  );
  try {
    await fillTitle(page, "Ship it");
    assert.equal(createButton(page).disabled, false);

    const templateSelect = selects(page)[0];
    assert.ok(templateSelect);
    await choose(page, templateSelect, second.id);
    // The old template's profiles say nothing about this one's steps.
    assert.equal(createButton(page).disabled, true);

    await act(async () => { gate.answer([]); });
    await page.settle();
    assert.equal(createButton(page).disabled, false);
  } finally {
    await page.dispose();
  }
});

test("a poll that moves the profiles under an open write does not reseed the draft", async () => {
  const seeded = { contextKey: "before", profileId: fastLane.id, steps: { "1": { assigneeAgentId: reviewer.id, include: true } } };
  // The operator's own choice, held against the context it was made in.
  const moved = activeStaffingSelection(seeded, "after", template, [thorough], true);
  assert.equal(moved, seeded, "a write in flight owns the draft it is submitting");
  // With no write open the panel reseeds, which is what a profile edited
  // elsewhere has to mean.
  const reseeded = activeStaffingSelection(seeded, "after", template, [thorough], false);
  assert.equal(reseeded.contextKey, "after");
  assert.equal(reseeded.steps["1"]?.assigneeAgentId, implementer.id);
});

/* ------------------------------------------------------------ accessibility */

test("every staffing control is named by its own label", async () => {
  const page = await mount([fastLane, thorough]);
  try {
    assert.equal(labelledControl(page, en("newTask.staffing.profile.label")), profileSelect(page));
    assert.equal(labelledControl(page, en("newTask.staffing.step.agent", { name: "Implementation" })), stepSelect(page, 0, true));
    assert.equal(labelledControl(page, en("newTask.staffing.step.agent", { name: "Review" })), stepSelect(page, 1, true));
    // A human step has no control, so its label claims none.
    const human = [...page.container.querySelectorAll("label")]
      .find((node) => node.textContent?.trim() === en("newTask.staffing.step.human", { name: "Sign off" }));
    assert.ok(human);
    assert.equal(human.getAttribute("for"), null);
  } finally {
    await page.dispose();
  }
});

