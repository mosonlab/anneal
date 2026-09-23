import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { contentRevision } from "../lib/format";
import type { Agent } from "../lib/types";
import { AgentDetailPage, NewAgent } from "../pages/Agents";
import { installDom, installFetchFunction, reactDom } from "./dom-harness";

const value: Agent = {
  id: "a", projectId: "p", environmentId: "e", name: "senior-dev-astra-medium", canonicalRole: null, customizedFields: [], title: "Senior Developer",
  model: "claude-opus-5-5:high", codexServiceTier: "DEFAULT", runnerPreference: "CLAUDE", inboxAccess: false, disabledTools: [],
  foundationalPrompt: "the canonical foundation", rolePrompt: "role", createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z", archivedAt: null,
};

test("foundation content revisions are stable, distinct and exactly seven hex characters", () => {
  assert.equal(contentRevision("foundation"), contentRevision("foundation"));
  assert.notEqual(contentRevision("foundation"), contentRevision("foundation changed"));
  assert.match(contentRevision("foundation"), /^[0-9a-f]{7}$/u);
});

test("the create form has no Foundation field or request key", async () => {
  const staticMarkup = renderToStaticMarkup(<NewAgent projectId="p" onClose={() => undefined} onCreated={() => undefined}
    initial={{ name: "new-agent", title: "New Agent", environmentId: "e", rolePrompt: "role" }} />);
  assert.equal((staticMarkup.match(/<textarea/gu) ?? []).length, 1, "only the role prompt remains");
  assert.doesNotMatch(staticMarkup, /Anneal foundation/iu);

  const { dom, container } = installDom("http://localhost/agents/a");
  const root = (await reactDom()).createRoot(container);
  const requests: RequestInit[] = [];
  const fetchHarness = installFetchFunction(async (_input, init) => {
    requests.push(init ?? {});
    return new Response(JSON.stringify(init?.method === "POST" ? value : []), { status: init?.method === "POST" ? 201 : 200 });
  });
  try {
    await act(async () => {
      root.render(<NewAgent projectId="p" onClose={() => undefined} onCreated={() => undefined}
        initial={{ name: "new-agent", title: "New Agent", environmentId: "e", rolePrompt: "role" }} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const create = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create");
    assert.ok(create);
    await act(async () => {
      create.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const post = requests.find((request) => request.method === "POST");
    assert.ok(post);
    const body = JSON.parse(String(post.body)) as Record<string, unknown>;
    assert.equal("foundationalPrompt" in body, false);
  } finally {
    fetchHarness.dispose();
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("edit mode keeps Foundation read-only and the save payload omits it", async () => {
  const { dom, container } = installDom("http://localhost/agents/a");
  const root = (await reactDom()).createRoot(container);
  const requests: RequestInit[] = [];
  const fetchHarness = installFetchFunction(async (input, init) => {
    requests.push(init ?? {});
    const body = String(input).endsWith("/agents/a") ? value : [];
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const button = (text: string): HTMLButtonElement => {
    const match = [...dom.window.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
    assert.ok(match, text);
    return match as HTMLButtonElement;
  };
  try {
    await act(async () => {
      root.render(<AgentDetailPage agentId="a" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => button("Edit").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    await act(async () => button("Prompt").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.document.querySelectorAll("textarea").length, 1, "only the role prompt is editable");
    assert.match(dom.window.document.body.textContent ?? "", /Read-only/);
    assert.match(dom.window.document.body.textContent ?? "", /Sits above your instructions/);
    assert.match(dom.window.document.body.textContent ?? "", /agents\/foundational\.md/);
    assert.match(dom.window.document.body.textContent ?? "", new RegExp(`rev ${contentRevision(value.foundationalPrompt)}`));
    assert.equal(dom.window.document.querySelector('[title="Content revision, not a semantic version"]') !== null, true);

    await act(async () => {
      button("Save").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const patch = requests.find((request) => request.method === "PATCH");
    assert.ok(patch);
    const body = JSON.parse(String(patch.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["codexServiceTier", "inboxAccess", "model", "name", "rolePrompt", "runnerPreference", "title"]);
    assert.equal("foundationalPrompt" in body, false);
  } finally {
    fetchHarness.dispose();
    await act(async () => root.unmount());
    dom.window.close();
  }
});
