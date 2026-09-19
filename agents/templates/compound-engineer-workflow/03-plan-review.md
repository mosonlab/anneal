---
stepIndex: 3
layer: 3
agent: review-coordinator-sol-high
approvalGate: false
optional: false
outputKind: plan-review
priorOutputKinds: [spec, plan]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Review every vertical slice against the specification of record and frozen base: standalone demonstration, layer coverage and context size, true blocked_by prerequisites, merge or split decisions priced against frontier width, expand–contract staging for wide refactors, and acceptance criteria that fail at base and turn green under the named verification. Persist exactly one JSON task output: `{"schemaVersion":1,"headSha":"<workspace HEAD>","findings":[{"id":"<stable ID>","severity":"P0|P1|P2","file":"<path>","line":1,"title":"<problem>","evidence":"<evidence>","requiredFix":"<fix>"}]}`; an empty findings array is valid.
