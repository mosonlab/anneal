---
stepIndex: 5
layer: 5
agent: plan-executor-astra-low
approvalGate: false
optional: false
outputKind: implementation
priorOutputKinds: [revised-plan]
attachmentsFromPrevious: true
opensPullRequest: true
requiresCommit: true
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Implement the reviewed and revised slice set on {{branchName}} from the live dependency frontier. Read every slice under `.chain/{{branchName}}/slices/`; preserve every slice and its acceptance criteria, but group compatible ready slices into focused native-subagent assignments instead of creating one process per slice. The platform pins all child threads to Luna max and limits the session to eight concurrent children. In the controlled resource limit, fill as many slots as can execute safely in parallel. Give every concurrent implementation writer its own branch and git worktree; reserve one long-lived child as merger after the first result is ready, so no more than seven implementation children run while it is active. Integrate results as soon as their dependencies permit, without wave-wide barriers. Follow the platform-pinned Implementation proof boundary after integration. A risk-flagged slice may be implemented by Luna, but you must inspect its risk boundary, rollback behavior, and acceptance evidence before integration, and a child must not perform irreversible external actions. Persist exactly one JSON task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when every slice's acceptance criteria are green at the recorded head.
