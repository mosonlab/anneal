---
stepIndex: 10
layer: 9
agent: regression-verifier-luna-xhigh
approvalGate: false
optional: false
outputKind: regression-verification-v2
priorOutputKinds: [implementation, review-findings, blind-findings, fixed-implementation]
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
The platform script owns refresh/merge, merge-lease operations, gate dispatch
and retries, verdict transcription, and the final `regression-verification-v2`
task output. Do not perform or restate those mechanical operations yourself.

Run `"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh" prepare`. If it reports
`refresh-conflict`, the final output is already persisted: record the outcome
in the activity log and finish. Otherwise read the implementation summary,
every present review report (`review-findings` and, when instantiated,
`blind-findings`), and the fixed implementation with its dispositions from
Anneal. The blind review report may be absent when its optional step was
omitted. Review the entire refreshed fix diff as one unit, account for every
finding id in every present report, rerun focused regressions, and verify that the approved
specification is preserved without a new defect. Do not modify code or repair
a failure.

If an adopted finding remains open, a rejection is unsupported, or a new
defect exists, run
`"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh" review-fail '<concise finding IDs or defect>'`
and finish. Otherwise run `"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh" finalize`.

A finalize exit 0 means the script persisted exactly one of `pass`, `gate-fail`,
or `refresh-conflict`; report the bounded `REGRESSION FINALIZE` status line it
printed. A finalize exit 77 means the script integrated a newer target head
outside the lease. Repeat the full semantic verification against that refreshed
tree, then run either `review-fail` or `finalize` again. Any other nonzero script
exit fails the run loudly. The script persists the one allowed v2 outcome;
never call `task_output` for this step or write a report file.
