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
Implement the task description on `{{branchName}}`; the task description is the specification of record. The platform materializes `.chain/{{branchName}}/spec.md` as the specification of record, and this step leaves that file untouched. The step must commit the implementation. Before implementing, trace each input the specification of record requires as pre-existing to a source at HEAD or a specified change, including the same Changes item, that creates it before use. Distinguish an implementation-created detail within scope from an unavailable input premise; ask one blocking `inbox_ask` question with the governing quote and tree evidence only for the latter, and finish independent work meanwhile. For every shared contract this change adds, changes, or removes, enumerate all governed sites, verify each, update the inconsistent ones within the specification of record, and list checked sites, changed sites, and verification evidence in the summary. Persist exactly one `implementation` JSON output object: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Every `testsRun` entry must record the exact command and its observed exit/result summary (for example, `<exact command> — exit <status>: <observed result summary>`); report only commands actually run. Leave publication and pull-request creation to the platform. Complete when the behavior is demonstrably delivered and tests are green at the recorded head.
