---
stepIndex: 1
layer: 1
agent: spec-opus-medium
approvalGate: false
optional: false
outputKind: spec
priorOutputKinds: []
attachmentsFromPrevious: false
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Write a detailed feature specification for {{branchName}} and persist exactly one JSON object as the specification of record for the downstream steps: `{"schemaVersion":1,"headSha":"<workspace HEAD>","spec":"<complete specification>"}`. Before persisting, trace every input the specification consumes to an artefact at the frozen base or an explicit specified change that creates it before use; treat an unresolved required input as premise collapse and ask a blocking Inbox question with the governing request and tree evidence.
