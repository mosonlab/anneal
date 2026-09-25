---
stepIndex: 2
layer: 2
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
Implement this task on {{branchName}} directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. The platform materializes `.chain/{{branchName}}/spec.md` as the specification of record; leave it untouched.

Choose whether and how to delegate based on the work, and select session-supported child models and reasoning effort to fit it. Give each concurrent writer its own branch and git worktree. Integrate and verify all child work against the specification of record and acceptance criteria in your context, resolve conflicts, and own final acceptance. Children must not perform irreversible external actions.

Follow the platform-pinned Implementation proof boundary after integration. Before implementing, trace each input the specification of record requires as pre-existing to a source at HEAD or a specified change, including the same Changes item, that creates it before use. Distinguish an implementation-created detail within scope from an unavailable input premise; ask one blocking `inbox_ask` question with the governing quote and tree evidence only for the latter, and finish independent work meanwhile. For every shared contract this change adds, changes, or removes, enumerate all governed sites, verify each, update the inconsistent ones within the specification of record, and list checked sites, changed sites, and verification evidence in the summary. Commit the result and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
