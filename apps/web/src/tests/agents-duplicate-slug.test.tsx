import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import type { JSDOM } from "jsdom";

import { ProjectProvider } from "../lib/project";
import type { Agent } from "../lib/types";
import { installDom, mountPage, type PageHarness } from "./dom-harness";

/* The page module is loaded after a DOM exists, never through a static import.
 * Radix decides once, when its modules first load, whether a layout effect can
 * run at all — and in a scope with no `document` it picks the no-op, which
 * leaves a portalled row menu open in state and absent from the document. */
installDom();
const pageModule = import("../pages/Agents");
const agentsPage = async (): Promise<typeof import("../pages/Agents")> => await pageModule;

const agent = (overrides: Partial<Agent> & Pick<Agent, "id" | "name" | "title" | "model">): Agent => ({
  projectId: "p1", environmentId: "e1", canonicalRole: null, customizedFields: [],
  codexServiceTier: "DEFAULT", runnerPreference: "CODEX", inboxAccess: false, disabledTools: [],
  foundationalPrompt: "foundation", rolePrompt: "role", createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z", archivedAt: null, ...overrides,
});

const seniorAstra = agent({ id: "a1", name: "senior-dev-astra-medium", title: "Senior Dev", model: "gpt-6-astra:medium", canonicalRole: "senior-dev-astra-medium" });
const seniorLuna = agent({ id: "a2", name: "senior-dev-luna-max", title: "Senior Dev", model: "gpt-5.6-luna:max", canonicalRole: "senior-dev-luna-max" });
const reviewer = agent({ id: "a3", name: "code-reviewer-sol-high", title: "Code Reviewer", model: "gpt-5.6-sol:high" });
const integrator = agent({
  id: "a4", name: "merge-integrator", title: "Merge Integrator", model: "mechanical/merge-executor-v1",
  runnerPreference: "INHERIT", assignable: false,
});

const ROSTER = [seniorAstra, seniorLuna, reviewer, integrator];

/** Radix's menu reads geometry and pointer types the jsdom globals omit. */
const installMenuGlobals = (dom: JSDOM): void => {
  Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: dom.window.MouseEvent });
  Object.defineProperty(globalThis, "DOMRect", { configurable: true, value: dom.window.DOMRect });
};

const openRowMenu = async (page: PageHarness, index: number): Promise<HTMLElement[]> => {
  const triggers = [...page.dom.window.document.querySelectorAll<HTMLButtonElement>("button[aria-label='More actions']")];
  const trigger = triggers[index];
  assert.ok(trigger, page.container.innerHTML);
  await act(async () => trigger.dispatchEvent(new page.dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  await page.settle();
  return [...page.dom.window.document.querySelectorAll<HTMLElement>("[role='menuitem']")];
};

test("the roster is grouped by title, so a job is read once and its variants under it", async () => {
  const { groupAgentsByTitle } = await agentsPage();
  const groups = groupAgentsByTitle(ROSTER);
  assert.deepEqual(groups.map((group) => group.title), ["Senior Dev", "Code Reviewer", "Merge Integrator"]);
  assert.deepEqual(groups[0]?.agents.map(({ name }) => name), ["senior-dev-astra-medium", "senior-dev-luna-max"]);
  assert.deepEqual(groups[1]?.agents.map(({ name }) => name), ["code-reviewer-sol-high"]);
});

test("the list renders one header per title, chips instead of slugs, and keeps the sentinel visible", async () => {
  const preload = installDom("http://127.0.0.1:5173/#/agents");
  installMenuGlobals(preload.dom);
  const { AgentsPage } = await agentsPage();
  const page = await mountPage(<ProjectProvider><AgentsPage /></ProjectProvider>, {
    "/projects": [{ id: "p1", name: "Anneal", slug: "anneal" }],
    "/projects/p1/agents": ROSTER,
    "*": [],
  }, "http://127.0.0.1:5173/#/agents");
  try {
    const text = page.container.textContent ?? "";
    assert.equal([...page.container.querySelectorAll("[data-agent-group]")].map((row) => row.getAttribute("data-agent-group")).join(","), "Senior Dev,Code Reviewer,Merge Integrator");
    // The runtime is what separates the two Senior Dev rows; the slug is not shown.
    assert.match(text, /GPT-6 Astra \(codex\) · medium/u);
    assert.match(text, /GPT-5.6 Luna \(codex\) · max/u);
    assert.doesNotMatch(text, /senior-dev-astra-medium/u);
    // Unassignable, but real: it spends and runs, so it stays in the roster.
    assert.match(text, /Merge Integrator/u);
    assert.match(text, /mechanical/u);

    // The sentinel cannot be duplicated, and its row does not offer it.
    const sentinelMenu = await openRowMenu(page, ROSTER.length - 1);
    assert.equal(sentinelMenu.some((item) => item.textContent?.trim() === "Duplicate"), false);
  } finally {
    await page.dispose();
    preload.dom.window.close();
  }
});

test("duplicating from a row prompts with the free slug, posts it, and opens the copy", async () => {
  const preload = installDom("http://127.0.0.1:5173/#/agents");
  installMenuGlobals(preload.dom);
  const { AgentsPage } = await agentsPage();
  const bodies: unknown[] = [];
  const prompts: Array<{ message: string; suggestion: string }> = [];
  const page = await mountPage(<ProjectProvider><AgentsPage /></ProjectProvider>, {
    "/projects": [{ id: "p1", name: "Anneal", slug: "anneal" }],
    "/projects/p1/agents": ROSTER,
    "POST /agents/a1/duplicate": async ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ...seniorAstra, id: "copy-1", name: "senior-dev-astra-medium-copy" };
    },
    "*": [],
  }, "http://127.0.0.1:5173/#/agents", (dom) => {
    Object.defineProperty(dom.window, "prompt", {
      configurable: true,
      value: (message: string, suggestion: string) => {
        prompts.push({ message, suggestion });
        return suggestion;
      },
    });
  });
  try {
    const menu = await openRowMenu(page, 0);
    const duplicate = menu.find((item) => item.textContent?.trim() === "Duplicate");
    assert.ok(duplicate, page.dom.window.document.body.innerHTML);
    await act(async () => duplicate.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await page.settle();

    assert.equal(prompts.length, 1);
    // The source already holds its own slug, so the offer is the free one next to it.
    assert.equal(prompts[0]?.suggestion, "senior-dev-astra-medium-copy");
    assert.match(prompts[0]?.message ?? "", /senior-dev-astra-medium/u);
    assert.deepEqual(bodies, [{ name: "senior-dev-astra-medium-copy" }]);
    assert.equal(page.dom.window.location.hash, "#/agents/copy-1");
  } finally {
    await page.dispose();
    preload.dom.window.close();
  }
});

test("a cancelled prompt writes nothing", async () => {
  const preload = installDom("http://127.0.0.1:5173/#/agents");
  installMenuGlobals(preload.dom);
  const { AgentsPage } = await agentsPage();
  const posts: string[] = [];
  const page = await mountPage(<ProjectProvider><AgentsPage /></ProjectProvider>, {
    "/projects": [{ id: "p1", name: "Anneal", slug: "anneal" }],
    "/projects/p1/agents": ROSTER,
    "*": ({ method, path }) => {
      if (method !== "GET") posts.push(`${method} ${path}`);
      return [];
    },
  }, "http://127.0.0.1:5173/#/agents", (dom) => {
    Object.defineProperty(dom.window, "prompt", { configurable: true, value: () => null });
  });
  try {
    const menu = await openRowMenu(page, 0);
    const duplicate = menu.find((item) => item.textContent?.trim() === "Duplicate");
    assert.ok(duplicate);
    await act(async () => duplicate.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await page.settle();
    assert.deepEqual(posts, []);
    assert.equal(page.dom.window.location.hash, "#/agents");
  } finally {
    await page.dispose();
    preload.dom.window.close();
  }
});

test("a free slug is offered as itself, and collisions walk past the copies already made", async () => {
  const { availableAgentName, duplicateNameSuggestion } = await agentsPage();
  assert.equal(availableAgentName("senior-dev-astra-low", new Set()), "senior-dev-astra-low");
  assert.equal(availableAgentName("senior-dev-astra-low", new Set(["senior-dev-astra-low"])), "senior-dev-astra-low-copy");
  assert.equal(
    availableAgentName("senior-dev-astra-low", new Set(["senior-dev-astra-low", "senior-dev-astra-low-copy"])),
    "senior-dev-astra-low-copy-2",
  );
  // The duplicate of a Luna agent is offered a Luna slug, not the source's title.
  assert.equal(duplicateNameSuggestion(seniorLuna, ROSTER), "senior-dev-luna-max-copy");
  // A Custom model names no slug, so the source's own name is the base.
  const custom = agent({ id: "a9", name: "nightly-triage", title: "Nightly Triage", model: "private/model:turbo" });
  assert.equal(duplicateNameSuggestion(custom, [...ROSTER, custom]), "nightly-triage-copy");
});

/* ------------------------------------------------------- slug regeneration */

const mountDetail = async (
  detail: Agent,
  siblings: readonly Agent[] = ROSTER,
): Promise<PageHarness> => {
  const { AgentDetailPage } = await agentsPage();
  return await mountPage(<AgentDetailPage agentId={detail.id} />, {
    [`/agents/${detail.id}`]: detail,
    "/projects/p1/agents": siblings,
    "*": [],
  }, "http://127.0.0.1:5173/#/agents/a1");
};

const nameInput = (page: PageHarness): HTMLInputElement => {
  const input = page.container.querySelector<HTMLInputElement>("input[type='text']");
  assert.ok(input, page.container.innerHTML);
  return input;
};

const selectModel = async (page: PageHarness, id: string): Promise<void> => {
  const select = page.container.querySelector<HTMLSelectElement>("select");
  assert.ok(select);
  select.value = id;
  await act(async () => select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true })));
  await page.settle();
};

test("changing the model offers the regenerated slug and applies it only when accepted", async () => {
  const page = await mountDetail(seniorLuna);
  try {
    await page.press("Edit");
    // Nothing to offer while the name already states the model it runs.
    assert.equal(page.container.querySelector("[data-agent-slug-suggestion]"), null);

    await selectModel(page, "gpt-6-astra");
    const offer = page.container.querySelector("[data-agent-slug-suggestion]");
    assert.ok(offer, page.container.innerHTML);
    assert.equal(offer.getAttribute("data-agent-slug-suggestion"), "senior-dev-astra-max");
    // Offered, not applied: the slug is the operator's identifier.
    assert.equal(nameInput(page).value, "senior-dev-luna-max");

    await page.press("Rename to senior-dev-astra-max");
    assert.equal(nameInput(page).value, "senior-dev-astra-max");
    assert.equal(page.container.querySelector("[data-agent-slug-suggestion]"), null);

    // A canonical agent says what an edit costs it.
    assert.match(page.container.textContent ?? "", /canonical role senior-dev-luna-max/u);
  } finally {
    await page.dispose();
  }
});

test("a name the operator typed is kept, and the offer follows that role", async () => {
  const page = await mountDetail(seniorAstra);
  try {
    await page.press("Edit");
    // React tracks the node's last value; assigning through the instance would
    // update that tracker and make the change look like no change at all.
    const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, "value")?.set;
    assert.ok(setter);
    const input = nameInput(page);
    await act(async () => {
      setter.call(input, "nightly-triage");
      input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
    });
    await page.settle();
    assert.equal(nameInput(page).value, "nightly-triage");
    assert.equal(
      page.container.querySelector("[data-agent-slug-suggestion]")?.getAttribute("data-agent-slug-suggestion"),
      "nightly-triage-astra-medium",
    );
  } finally {
    await page.dispose();
  }
});

test("the model-free roles are never renamed, and the sentinel is never duplicated", async () => {
  const starter = agent({ id: "d1", name: "default", title: "Default", model: "claude-opus-5:medium", runnerPreference: "CLAUDE" });
  const page = await mountDetail(starter, [starter, ...ROSTER]);
  try {
    await page.press("Edit");
    assert.equal(page.container.querySelector("[data-agent-slug-suggestion]"), null);
    await selectModel(page, "gpt-6-astra");
    assert.equal(page.container.querySelector("[data-agent-slug-suggestion]"), null);
  } finally {
    await page.dispose();
  }

  const sentinel = await mountDetail(integrator);
  try {
    const text = sentinel.container.textContent ?? "";
    assert.match(text, /mechanical/u);
    assert.equal([...sentinel.container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Duplicate"), false);
  } finally {
    await sentinel.dispose();
  }
});

test("the detail page carries the slug with a copy button, and the list does not", async () => {
  const page = await mountDetail(seniorAstra);
  try {
    assert.match(page.container.textContent ?? "", /senior-dev-astra-medium/u);
    const copy = [...page.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Copy");
    assert.ok(copy, page.container.innerHTML);
  } finally {
    await page.dispose();
  }
});

/* ------------------------------------------------- who the exemption covers */

const selectEffort = async (page: PageHarness, effort: string): Promise<void> => {
  // The picker's order is model, effort, runner.
  const select = [...page.container.querySelectorAll("select")][1];
  assert.ok(select, page.container.innerHTML);
  select.value = effort;
  await act(async () => select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true })));
  await page.settle();
};

test("changing a canonical Agent's effort offers the matching slug and leaves the name editable", async () => {
  const executioner = agent({
    id: "a5", name: "plan-executor-astra-low", title: "Executioner",
    model: "gpt-6-astra:low", canonicalRole: "plan-executor-astra-low",
  });
  const page = await mountDetail(executioner, [executioner, ...ROSTER]);
  try {
    await page.press("Edit");
    // Only `default` and `merge-integrator` name no model; this role does.
    assert.equal(nameInput(page).disabled, false);
    await selectEffort(page, "high");
    assert.equal(
      page.container.querySelector("[data-agent-slug-suggestion]")?.getAttribute("data-agent-slug-suggestion"),
      "plan-executor-astra-high",
    );
    await page.press("Rename to plan-executor-astra-high");
    assert.equal(nameInput(page).value, "plan-executor-astra-high");
    // The platform pins the native children by the step, so the note survives
    // the rename rather than being addressed by the old name.
    assert.match(page.container.textContent ?? "", /Native Luna max children remain pinned/u);
  } finally {
    await page.dispose();
  }
});

test("the exemption follows the canonical role, not the name an operator typed", async () => {
  // Renamed by its operator, but still the starter Agent whose name names no model.
  const renamed = agent({
    id: "a6", name: "house-default", title: "Default", model: "claude-opus-5:medium",
    canonicalRole: "default", runnerPreference: "CLAUDE",
  });
  const page = await mountDetail(renamed, [renamed, ...ROSTER]);
  try {
    await page.press("Edit");
    await selectEffort(page, "high");
    assert.equal(page.container.querySelector("[data-agent-slug-suggestion]"), null);
  } finally {
    await page.dispose();
  }

  // And an Agent of no canonical role is judged by the name it carries.
  const ownName = agent({ id: "a7", name: "nightly-triage", title: "Nightly", model: "claude-opus-5:medium", runnerPreference: "CLAUDE" });
  const own = await mountDetail(ownName, [ownName, ...ROSTER]);
  try {
    await own.press("Edit");
    await selectEffort(own, "high");
    assert.equal(
      own.container.querySelector("[data-agent-slug-suggestion]")?.getAttribute("data-agent-slug-suggestion"),
      "nightly-triage-opus-high",
    );
  } finally {
    await own.dispose();
  }
});

test("a list row carries the runtime alone, and the title is read once in its header", async () => {
  const preload = installDom("http://127.0.0.1:5173/#/agents");
  installMenuGlobals(preload.dom);
  const { AgentsPage } = await agentsPage();
  const page = await mountPage(<ProjectProvider><AgentsPage /></ProjectProvider>, {
    "/projects": [{ id: "p1", name: "Anneal", slug: "anneal" }],
    "/projects/p1/agents": ROSTER,
    "*": [],
  }, "http://127.0.0.1:5173/#/agents");
  try {
    const rows = [...page.container.querySelectorAll("tr")];
    const header = rows.find((row) => row.getAttribute("data-agent-group") === "Senior Dev");
    assert.ok(header);
    assert.match(header.textContent ?? "", /Senior Dev/u);
    // The two variants under it differ by runtime, and say only that.
    const variants = rows.slice(rows.indexOf(header) + 1, rows.indexOf(header) + 3);
    assert.deepEqual(
      variants.map((row) => row.querySelector("td")?.textContent?.trim()),
      ["GPT-6 Astra (codex) · medium", "GPT-5.6 Luna (codex) · max"],
    );
  } finally {
    await page.dispose();
    preload.dom.window.close();
  }
});
