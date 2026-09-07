Docs: a brief bound to a predecessor's tail describes the world after that predecessor lands

Goal: an author writing a brief for a card that will be bound after another chain never writes a premise that the bound predecessor makes false.

Background: on 2026-09-07 the docs card for executor-offline recovery was bound to the tail of its companion code card. Its brief said "until the self re-arm card lands this is the only operator exit". The companion landed first, as the binding guarantees, so the implementation agent found the premise false at HEAD, stopped, and asked the operator a MULTIPLE_CHOICE question (`Premise collapse found in Change 1`). This was the only human intervention of the day that was not a platform fault; it cost a ten-minute wait and a ruling. The Revalidate step that a bound chain gains exists to catch exactly this drift, but the cheaper fix is to not write the drift.

Changes:
1. `docs/BRIEF-TEMPLATE.md`: in the section that explains Background and Changes, add the rule that a brief whose card will be dispatched after another card (afterTaskId, or a serial line declared in a wave plan) states its premises as of the moment that predecessor has merged; it names the predecessor by card or branch and does not use "until X lands" or "X has not landed" language about it.
2. `docs/governance/task-routing-v1.md`, Dependency qualification: one sentence cross-referencing the rule, so the person qualifying dependencies checks the brief's premises against the predecessor's outcome.
3. `CHANGELOG.md` entry.

Out of scope: any code; the Revalidate step behavior; existing briefs in records.

Acceptance: `npm run test:snapshot-scan` and `npm run lint` pass; the template sentence names the predecessor binding and forbids the "until it lands" phrasing.

Route: implementation=senior-dev-astra-medium - operator choice (Astra capacity is ample; documentation-only change with snapshot-pinned files)
