---
stepIndex: 1
layer: 1
agent: senior-dev-luna-max
approvalGate: false
optional: false
outputKind: implementation
priorOutputKinds: []
attachmentsFromPrevious: false
opensPullRequest: true
requiresCommit: true
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Implement the task description on `{{branchName}}`; the task description is the specification of record. The platform materializes `.chain/{{branchName}}/spec.md` as the specification of record, and this step leaves that file untouched. The step must commit the implementation. When the change widens or adds a shared contract, invariant, or cross-cutting rule (such as a new policy field, enum member, or required parameter), enumerate every existing consumer, call site, and endpoint it now governs, update each one, and list them in the summary. Persist exactly one `implementation` JSON output object: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Every `testsRun` entry must record the exact command and its observed exit/result summary (for example, `<exact command> — exit <status>: <observed result summary>`); report only commands actually run. Leave publication and pull-request creation to the platform. Complete when the behavior is demonstrably delivered and tests are green at the recorded head.
