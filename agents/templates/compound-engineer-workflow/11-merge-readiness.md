---
stepIndex: 11
layer: 10
agent: review-coordinator-sol-high
approvalGate: false
optional: false
outputKind: merge-authorization
priorOutputKinds: []
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
This is a server-owned mechanical readiness step. No model run executes it.
The control plane recomputes the pull-request head and defense-list triggers,
and emits an exact-head merge authorization. A defense-list trigger does not
hold the merge: it records one audit inbox message on this step naming the
triggered paths and reasons, and the merge proceeds. Missing or stale PASS
evidence leaves this step blocked at regression verification with a named
reason.
