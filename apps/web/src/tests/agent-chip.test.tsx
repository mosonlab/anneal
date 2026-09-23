import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentChip } from "../components/ui";
import { LocaleProvider } from "../lib/i18n";

test("the chip names the agent and, when the caller has it, the runtime it runs", () => {
  const markup = renderToStaticMarkup(<AgentChip agent={{ id: "a1", title: "Senior Dev", name: "senior-dev-astra-medium", model: "gpt-6-astra:medium" }} />);
  assert.match(markup, /Senior Dev/u);
  // Four agents share this title, so the chip has to carry what separates them.
  assert.match(markup, /GPT-6 Astra \(codex\) · medium/u);
  // The slug belongs on the detail page, not in every list that names an agent.
  assert.doesNotMatch(markup, /senior-dev-astra-medium/u);
});

test("a Custom model keeps its exact id, and a bare model keeps its effort silent", () => {
  assert.match(
    renderToStaticMarkup(<AgentChip agent={{ title: "Nightly", model: "private/model:turbo" }} />),
    /private\/model · turbo/u,
  );
  const bare = renderToStaticMarkup(<AgentChip agent={{ title: "Nightly", model: "claude-opus-5" }} />);
  assert.match(bare, /Claude Opus 5/u);
  assert.doesNotMatch(bare, /·/u);
});

test("callers with no model at all still get a chip, and no agent still reads Unassigned", () => {
  const titleOnly = renderToStaticMarkup(<AgentChip agent={{ id: "s1", title: "Code Reviewer" }} />);
  assert.match(titleOnly, /Code Reviewer/u);
  assert.equal(titleOnly.includes("data-agent-chip-model"), false);

  const byName = renderToStaticMarkup(<AgentChip agent={null} name="session-agent-id" />);
  assert.match(byName, /session-agent-id/u);

  assert.match(renderToStaticMarkup(<AgentChip agent={null} />), /Unassigned/u);
});

test("the chip translates its unassigned state and leaves catalog labels alone", () => {
  const zh = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><AgentChip agent={null} /></LocaleProvider>);
  assert.match(zh, /未指派/u);
  assert.doesNotMatch(zh, /Unassigned/u);

  // The model label is catalog data, not copy: it reads the same in both.
  const named = <AgentChip agent={{ title: "Senior Dev", model: "gpt-6-luna:max" }} />;
  const en = renderToStaticMarkup(<LocaleProvider initialLocale="en">{named}</LocaleProvider>);
  assert.equal(
    renderToStaticMarkup(<LocaleProvider initialLocale="zh">{named}</LocaleProvider>),
    en,
  );
  assert.match(en, /GPT-6 Luna \(codex\) · max/u);
});
