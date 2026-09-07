---
stepIndex: 8
layer: 7
agent: senior-dev-astra-low
approvalGate: false
optional: false
outputKind: fixed-implementation
priorOutputKinds: [review-findings, blind-findings]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Read the immutable `review-findings` review output and, when present, the immutable `blind-findings` output through their Anneal step outputs. The blind review may be absent when its optional step was omitted; when it is absent, the code review report is the sole report. Verify that every present report's reviewed head is the HEAD you are about to fix. When both reports are present, also verify that they report the same reviewed base and the same reviewed head. If that HEAD is a `WIP salvage` commit of a prior Run of this same task and its parent is the reviewed head, the salvaged changes are your own failed attempt's in-progress fixes: validate them against the reports, continue on top of them, and record the reviewed head — the salvage commit's parent — as `sourceHead`. Every other reviewed-head mismatch remains a stop. No adjudication step stands between the reviews and this one: decide every finding yourself. Record exactly one disposition per finding id across every present report — `ADOPTED`, `REJECTED`, or `MERGED`, each with a reason — and apply every adopted finding completely, rerunning every affected regression. Reject a P0 or P1 finding only with a reason that names why the defect is unreachable or already covered by another adopted finding. Commit the fixes, then persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<fixed HEAD>","sourceHead":"<pre-fix HEAD>","dispositions":[{"id":"<finding ID>","disposition":"ADOPTED|REJECTED|MERGED","reason":"<reason>"}],"closedFindings":[{"id":"<adopted finding ID>","status":"CLOSED","codeEvidence":"<code evidence>","testEvidence":"<test evidence>"}],"testsRun":["<command>"],"residualRisks":[]}`; every `ADOPTED` disposition has a matching `closedFindings` entry and nothing else does. Review reports are platform outputs; do not look for report files on the branch.
