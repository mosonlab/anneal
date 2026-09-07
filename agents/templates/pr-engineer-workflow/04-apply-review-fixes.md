---
stepIndex: 4
layer: 3
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
Read both immutable review outputs from the preceding layer — `review-findings` and `blind-findings` — through their Anneal step outputs, and verify both report the same reviewed base and the same reviewed head, and that the head they reviewed is the HEAD you are about to fix. If that HEAD is a `WIP salvage` commit of a prior Run of this same task and its parent is the reviewed head, the salvaged changes are your own failed attempt's in-progress fixes: validate them against the reports, continue on top of them, and record the reviewed head — the salvage commit's parent — as `sourceHead`. Every other reviewed-head mismatch remains a stop. The two reviews must continue to read `.chain/{{branchName}}/spec.md` at that pinned implementation head; do not remove or alter that bookkeeping until both review outputs have been consumed. No adjudication step stands between the reviews and this one: decide every finding yourself. Record exactly one disposition per finding id across both reports — `ADOPTED`, `REJECTED`, or `MERGED`, each with a reason — and apply every adopted finding completely, rerunning every affected regression. Reject a P0 or P1 finding only with a reason that names why the defect is unreachable or already covered by another adopted finding. After using the review evidence and applying any adopted fixes, remove the complete tracked `.chain/` directory from the worktree and commit that deletion together with any adopted fixes on top of the reviewed history. Before persisting the output, verify that `git ls-tree -r --name-only HEAD -- .chain` has no entries. A failed removal, failed commit, or remaining tracked `.chain/` entry is an error and the step must not succeed. Persist exactly one `fixed-implementation` JSON output object only after that cleanup commit: `{"schemaVersion":1,"headSha":"<fixed HEAD>","sourceHead":"<pre-fix HEAD>","dispositions":[{"id":"<finding ID>","disposition":"ADOPTED|REJECTED|MERGED","reason":"<reason>"}],"closedFindings":[{"id":"<adopted finding ID>","status":"CLOSED","codeEvidence":"<code evidence>","testEvidence":"<test evidence>"}],"testsRun":["<command>"],"residualRisks":[]}`. Set `headSha` to the cleanup commit that is the human-mergeable head, and make every `testsRun` entry record the exact command and its observed exit/result summary (for example, `<exact command> — exit <status>: <observed result summary>`); report only commands actually run. Every `ADOPTED` disposition has a matching `closedFindings` entry and nothing else does. Review reports are platform outputs; do not look for report files on the branch. If a retry starts at the already-clean cleanup commit after a successful push and a failed PR edit, preserve that head and do not recreate bookkeeping or invent another commit.
