import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsListTabs, filterAgentsByTab, type AgentsListTab } from "../pages/Agents";
import type { Agent } from "../lib/types";

const agent = (id: string, archivedAt: string | null): Agent => ({
  id, projectId: "p", environmentId: "e", name: id, canonicalRole: null, customizedFields: [], title: id,
  model: "claude-opus-5-5:high", codexServiceTier: "DEFAULT", runnerPreference: "CLAUDE", inboxAccess: false, disabledTools: [],
  foundationalPrompt: "foundation", rolePrompt: "role", createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z", archivedAt,
});

test("agent tabs separate active and archived agents", () => {
  const agents = [agent("active-1", null), agent("archived-1", "2026-08-16T01:00:00.000Z"), agent("active-2", null)];
  assert.deepEqual(filterAgentsByTab(agents, "active").map(({ id }) => id), ["active-1", "active-2"]);
  assert.deepEqual(filterAgentsByTab(agents, "archived").map(({ id }) => id), ["archived-1"]);
});

test("agent tabs use the Tasks segmented styling and identify the selected tab", () => {
  for (const active of ["active", "archived"] as AgentsListTab[]) {
    const markup = renderToStaticMarkup(<AgentsListTabs value={active} onChange={() => undefined} />);
    assert.equal((markup.match(/<button/gu) ?? []).length, 2);
    assert.match(markup, />Your Agents<\/button>/u);
    assert.match(markup, />Archived<\/button>/u);
    const selected = [...markup.matchAll(/<button[^>]*bg-accent[^>]*>([^<]*)<\/button>/gu)].map((match) => match[1]);
    assert.deepEqual(selected, [active === "active" ? "Your Agents" : "Archived"]);
  }
});
