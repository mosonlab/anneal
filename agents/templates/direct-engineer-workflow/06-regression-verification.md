---
stepIndex: 6
layer: 5
agent: regression-verifier-luna-max
approvalGate: false
optional: false
outputKind: regression-verification-v3
priorOutputKinds: [implementation, review-findings, blind-findings, fixed-implementation]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
The platform script owns target refresh, verdict transcription, and the final
`regression-verification-v3` task output. A semantic PASS is evidence about the
prepared fix; Merge train separately runs the full integration gate on the
actual publish prefix. Merge readiness owns the Merge Lease and authorization.
Do not perform or restate those mechanical operations yourself.

Run `"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh" prepare`.
If it reports `refresh-conflict`, the output is already persisted: report that
outcome and finish. If it reports `semantic-reused`, the platform qualified a
persisted prior semantic PASS: skip model re-review and run `finalize` immediately.
Otherwise perform the post-fix verification below.

Read the approved specification, implementation summary, every present review
report (`review-findings` and optional `blind-findings`), and the fix output with
its dispositions. Account for every finding ID. Review the complete fix delta
from the reviewed head to the prepared head, plus callers governed by changed
contracts. Verify adopted findings are resolved, rejected findings have evidence,
and the fix preserves specified behavior. Earlier review findings and test claims
are inputs to verify; they do not themselves prove a fix. Do not repeat the
initial review of unchanged implementation. Expand inspection when the fix changes
a shared contract, the target refresh intersects affected behavior, or the
persisted evidence cannot establish the reviewed range.

When the platform supplies a regression repair handoff, start with its trigger,
repair.startHeadSha-to-repair.resolvedHeadSha delta, and any target-refresh delta:
- review-fix: recheck every triggering finding and affected contract.
- gate-fix: reproduce the reported failure with a focused check and inspect the
  repair's changed behavior; the full gate remains Merge train's responsibility.
- refresh-conflict: inspect the conflict resolution and affected contracts;
  unrelated, already-reviewed implementation does not need another full review.
A known CI failure remains blocking until repaired; distinguish reproducible
code defects from observed environment/setup failures using the supplied logs.

Run focused regressions for findings and changed behavior. Do not run whole
workspace or repository suites, modify code, resolve conflicts, or repair failures.
The tracked `.chain/` workspace is platform bookkeeping stripped from the merge
commit; exclude it from scope/changed-file checks and do not edit it.

Sweep changed code and sites governed by changed contracts for each defect class
identified in the findings or fix. Record proven pre-existing out-of-scope instances
and non-blocking P2 observations separately in the activity log. If an adopted
finding remains open, a rejection is unsupported, or a new blocking defect exists,
report every blocking instance in one call, one line per finding ID, location
(`file:line`, or command and cwd), and consequence:
`"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh" review-fail '<concise finding IDs or defect>'`
and finish. Otherwise run
`"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh" finalize`.

A finalize exit 0 means the script persisted `semantic-pass` for the exact head
and baseline frozen by prepare. Report its bounded `REGRESSION FINALIZE` status.
Any nonzero script exit fails the Run loudly. Never call `task_output` for this
Step or write a report file.
