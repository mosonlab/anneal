import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelLabel, ModelPicker, modelForSave } from "../components/model-picker";
import { LocaleProvider } from "../lib/i18n";
import type { Agent } from "../lib/types";
import { AgentDetailPage, NewAgent } from "../pages/Agents";
import { NewGoal } from "../pages/Goals";
import { installDom, installFetchFunction, reactDom } from "./dom-harness";

test("catalog models render a default effort without rewriting a bare stored value", () => {
  let changes = 0;
  const markup = renderToStaticMarkup(
    <ModelPicker model="claude-opus-5" runnerPreference="CLAUDE" onChange={() => { changes += 1; }} />,
  );
  assert.equal(changes, 0);
  assert.match(markup, /Claude Opus 5/);
  assert.match(markup, /<option value="medium" selected="">medium<\/option>/);
  assert.match(markup, /<select[^>]*disabled=""[^>]*>[\s\S]*?<option value="CLAUDE" selected="">Claude<\/option>/);
  assert.equal(modelForSave("claude-opus-5"), "claude-opus-5:medium");
  assert.equal(modelForSave("private/model:turbo"), "private/model:turbo");
});

test("catalog selection retains a supported effort, falls back otherwise, and writes a concrete runner", async () => {
  const { dom, container } = installDom();
  const root = (await reactDom()).createRoot(container);
  const seen: Array<{ model: string; runnerPreference: string }> = [];
  try {
    await act(async () => root.render(
      <ModelPicker model="gpt-5.6-luna:max" runnerPreference="CODEX" onChange={(next) => seen.push(next)} />,
    ));
    const model = dom.window.document.querySelector("select");
    assert.ok(model);
    model.value = "gpt-5.6-sol";
    await act(async () => model.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.deepEqual(seen.pop(), { model: "gpt-5.6-sol:max", runnerPreference: "CODEX" });

    await act(async () => root.render(
      <ModelPicker model="gpt-5.6-luna:none" runnerPreference="CODEX" onChange={(next) => seen.push(next)} />,
    ));
    const nextModel = dom.window.document.querySelector("select");
    assert.ok(nextModel);
    nextModel.value = "claude-sonnet-5";
    await act(async () => nextModel.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.deepEqual(seen.pop(), { model: "claude-sonnet-5:high", runnerPreference: "CLAUDE" });

    await act(async () => root.render(
      <ModelPicker model="openai-codex/gpt-5.6-luna:xhigh" runnerPreference="PI" onChange={() => undefined} />,
    ));
    assert.match(dom.window.document.body.textContent ?? "", /GPT-5.6 Luna \(pi\)/);
    assert.match(renderToStaticMarkup(<ModelLabel model="openai-codex/gpt-5.6-luna:xhigh" />), /GPT-5.6 Luna \(pi\)[\s\S]*xhigh/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Custom keeps exact model text and exposes all runner preferences", () => {
  const markup = renderToStaticMarkup(
    <ModelPicker model="private/provider:model:turbo" runnerPreference="AUTO" onChange={() => undefined} />,
  );
  assert.match(markup, /Custom…/);
  assert.match(markup, /value="private\/provider:model:turbo"/);
  for (const runner of ["INHERIT", "AUTO", "CLAUDE", "CODEX", "PI"]) assert.match(markup, new RegExp(`value="${runner}"`));
  assert.match(markup, /Custom models use the selected runner/);
});

test("Chinese custom-model and goal forms render translated runner preference labels", () => {
  const picker = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh"><ModelPicker model="private/model" runnerPreference="AUTO" onChange={() => undefined} /></LocaleProvider>,
  );
  assert.match(picker, />继承<\/option>/u);
  assert.match(picker, />自动<\/option>/u);
  assert.doesNotMatch(picker, />inherit<\/option>|>auto<\/option>/iu);

  const goal = renderToStaticMarkup(
    <LocaleProvider initialLocale="zh"><NewGoal projectId="p" onClose={() => undefined} onCreated={() => undefined} /></LocaleProvider>,
  );
  assert.match(goal, /<option value="AUTO" selected="">自动<\/option>/u);
  assert.doesNotMatch(goal, />auto<\/option>/iu);
});

test("the real Create button blocks a contradictory model and runner pair", () => {
  const common = { projectId: "p", onClose: () => undefined, onCreated: () => undefined };
  const mismatch = renderToStaticMarkup(
    <NewAgent {...common} initial={{ name: "senior-dev-astra-medium", environmentId: "e", model: "gpt-5.6-luna:high", runnerPreference: "CLAUDE" }} />,
  );
  assert.match(mismatch, /<button[^>]*disabled=""[^>]*>[^<]*Create/);
  assert.match(mismatch, /requires CODEX, but this agent stores CLAUDE/);

  const valid = renderToStaticMarkup(
    <NewAgent {...common} initial={{ name: "senior-dev-astra-medium", environmentId: "e", model: "gpt-5.6-luna:high", runnerPreference: "CODEX" }} />,
  );
  assert.doesNotMatch(valid, /<button[^>]*disabled=""[^>]*>[^<]*Create/);
  assert.match(valid, /Codex service tier/u);
  assert.match(valid, /<option value="DEFAULT" selected="">Default<\/option>/u);
  assert.match(valid, /<option value="FAST">Fast<\/option>/u);
});

test("the real detail Save button blocks a stored contradiction until the picker repairs it", async () => {
  const { dom, container } = installDom();
  const root = (await reactDom()).createRoot(container);
  const agent: Agent = {
    id: "a", projectId: "p", environmentId: "e", name: "senior-dev-astra-medium", canonicalRole: null, customizedFields: [], title: "Senior Developer",
    model: "gpt-5.6-luna:high", codexServiceTier: "DEFAULT", runnerPreference: "CLAUDE", inboxAccess: false, disabledTools: [],
    foundationalPrompt: "foundation", rolePrompt: "role", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archivedAt: null,
  };
  const fetchHarness = installFetchFunction(async (input) => {
    const path = String(input);
    const body = path.endsWith("/agents/a") ? agent : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    await act(async () => {
      root.render(<AgentDetailPage agentId="a" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const edit = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Edit");
    assert.ok(edit);
    await act(async () => edit.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    const save = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save") as HTMLButtonElement | undefined;
    assert.ok(save);
    assert.equal(save.disabled, true);

    const model = dom.window.document.querySelector("select");
    assert.ok(model);
    model.value = "gpt-5.6-sol";
    await act(async () => model.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.equal(save.disabled, false);
  } finally {
    fetchHarness.dispose();
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("the executioner Setup page has no legacy subprocess profile controls", async () => {
  const { dom, container } = installDom();
  const root = (await reactDom()).createRoot(container);
  const agent: Agent = {
    id: "a", projectId: "p", environmentId: "e", name: "plan-executor-astra-low", canonicalRole: "plan-executor-astra-low", customizedFields: [], title: "Implementation Plan Executioner",
    model: "gpt-5.6-sol:high", codexServiceTier: "DEFAULT", runnerPreference: "CODEX", inboxAccess: true, disabledTools: [],
    foundationalPrompt: "foundation", rolePrompt: "role", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archivedAt: null,
  };
  const fetchHarness = installFetchFunction(async (input) => {
    const path = String(input);
    return new Response(JSON.stringify(path.endsWith("/agents/a") ? agent : [agent]), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  try {
    await act(async () => {
      root.render(<AgentDetailPage agentId="a" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Ordinary Codex subprocess|Elevated Codex subprocess/u);
    assert.equal(dom.window.document.querySelector("[data-subprocess-profile]"), null);

    const edit = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Edit");
    assert.ok(edit);
    await act(async () => edit.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    // The name is the operator's own identifier, and the platform pins the
    // native children by the step a run executes rather than by this Agent's
    // name — so an effort change may be followed by the matching slug here.
    const canonicalName = dom.window.document.querySelector('input[value="plan-executor-astra-low"]') as HTMLInputElement | null;
    assert.ok(canonicalName);
    assert.equal(canonicalName.disabled, false);
    // What is pinned is said, not enforced by a dead control.
    assert.match(dom.window.document.body.textContent ?? "", /Native Luna max children remain pinned/u);
  } finally {
    fetchHarness.dispose();
    await act(async () => root.unmount());
    dom.window.close();
  }
});
