---
stepIndex: 2
layer: 2
agent: plan-fable-medium
approvalGate: false
optional: false
outputKind: plan
priorOutputKinds: [spec]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: true
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Turn the persisted spec into a tracer-bullet slice set engineered for parallel execution: many slices with empty blocked_by, a shallow critical path. Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change." Any prefactoring should be done first.

Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer. A completed slice is demoable or verifiable on its own. Each slice is sized to fit in a single fresh context window.

Wide refactors are the exception to vertical slicing. A wide refactor is one mechanical change (rename a column, retype a shared symbol) whose blast radius fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as expand–contract. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own slice blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a slice blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify slice; green is promised only there.

Write the chain artifacts under `.chain/{{branchName}}/` on {{branchName}} — the persisted spec copied to `spec.md`, one file per slice at `slices/<NN>-<slug>.md` numbered from `01` in dependency order (blockers first), and the plan's load-bearing decisions in `decisions.md` — one entry per decision naming the choice made, the alternatives rejected, and the reason, so a fresh-context revision inherits the why without this session's transcript. One slice per file, never a single combined file. Each slice file carries YAML frontmatter — `id` (unique, matching its file's `<NN>-<slug>`), `title`, `blocked_by` (a list of existing slice ids, never its own; only true prerequisites, acyclic), `risk` (boolean, true exactly when the slice touches persisted data or an irreversible external action) — and the body below:

<slice-template>

# <NN>: <Slice title>

**What to build:** the end-to-end behaviour this slice makes work, from the user's perspective, not a layer-by-layer implementation list.

**Blocked by:** the ids of the slices that gate this one, or "None (can start immediately)".

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</slice-template>

Every acceptance criterion is red at the frozen base and names the verification that turns it green. Avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

Before committing slices, verify that every consumed input exists at the frozen base or is created before use by the same slice or a prerequisite slice; resolve missing creation within the specification of record, and escalate a premise that requires changing it. Commit every file, then persist exactly one JSON task output: `{"schemaVersion":1,"headSha":"<final HEAD>","summary":"<approach>","sliceIds":["<slice id>"]}`. The plan is complete when every implementation requirement maps to exactly one slice's What to build; chain-level evidence, including the repository Merge Gate, remains outside the slice set.
