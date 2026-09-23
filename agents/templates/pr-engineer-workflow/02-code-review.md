---
stepIndex: 2
layer: 2
agent: code-reviewer-sol-high
approvalGate: false
optional: false
outputKind: review-findings
priorOutputKinds: [implementation]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
provisionDependencies: false
baseFromStepIndex: 1
spawnPolicy: null
---
Review the complete integrated implementation diff using the platform-pinned implementationBaseSha and implementationHeadSha. Enumerate and inspect every site governed by a contract this change adds, changes, or removes at the pinned head, including sites outside `base...head`; report every inconsistency, grouping instances into one finding only when severity and required fix match, with every location listed in its evidence. Do not write or commit a report file. Persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<workspace HEAD>","reviewedBase":"<implementationBaseSha>","reviewedHead":"<implementationHeadSha>","findings":[{"id":"<stable ID>","severity":"P0|P1|P2","file":"<path>","line":1,"title":"<problem>","evidence":"<evidence>","requiredFix":"<fix>"}],"commandsRun":["<command>"]}`; an empty findings array is valid.
