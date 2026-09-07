---
stepIndex: 7
layer: 6
agent: code-reviewer-opus-high
approvalGate: false
optional: true
outputKind: blind-findings
priorOutputKinds: []
attachmentsFromPrevious: false
opensPullRequest: false
requiresCommit: false
provisionDependencies: false
baseFromStepIndex: 5
spawnPolicy: null
---
Blind-review the complete integrated implementation diff using the immutable
implementationBaseSha and implementationHeadSha in the platform-pinned claim
metadata; verify both endpoints resolve in this detached checkout. Do not read
predecessor or sibling review evidence through attachments, task outputs,
activity, or any other session-scoped route, before or after persisting this
report. Persist exactly one immutable `blind-findings` JSON object with
`schemaVersion`, `headSha`, `reviewedBase`, `reviewedHead`, and `findings`; every
finding has `id`, `severity` (`P0|P1|P2`), `file`, positive integer `line`,
`title`, `evidence`, and `requiredFix`. Do not adjudicate findings, write a
report file, or commit changes.
