---
stepIndex: 4
layer: 4
agent: plan-reviser-opus-medium
approvalGate: false
optional: false
outputKind: revised-plan
priorOutputKinds: [spec, plan, plan-review]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Start a fresh session — never resume the planning conversation — and read the persisted spec, the slice files under `.chain/{{branchName}}/slices/`, `decisions.md`, and the consolidated plan-review findings before editing. Revise the slice set against the plan-review findings by editing the slice files in place under `.chain/{{branchName}}/slices/`, preserving the planning invariants — tracer-bullet cut, acyclic true blocked_by, wide frontier and shallow critical path, risk true exactly for persisted data or an irreversible external action, every acceptance criterion red at the frozen base, no specific file paths or code snippets in slice bodies. When a finding overturns a recorded decision, rewrite its `decisions.md` entry with the new choice and reason. Commit to {{branchName}}, then persist exactly one JSON task output: `{"schemaVersion":1,"headSha":"<final HEAD>","summary":"<revisions>","addressedFindingIds":["<ID>"],"declinedFindings":[{"id":"<ID>","reason":"<reason>"}]}`; either findings array may be empty. The revised slice set is the implementation authority: complete when every must-fix finding has a resolving slice edit, every should-fix a recorded decision, and every implementation requirement still maps to exactly one slice; chain-level evidence, including the repository Merge Gate, remains outside the slice set.
