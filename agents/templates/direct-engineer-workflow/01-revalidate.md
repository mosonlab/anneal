---
stepIndex: 1
layer: 1
agent: spec-revalidator-luna-xhigh
approvalGate: false
optional: false
outputKind: revalidation
priorOutputKinds: []
attachmentsFromPrevious: false
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Revalidate the bound direct chain's feature brief before implementation. Read
the implementation task description and inspect the current repository tree at
HEAD. Update only stale descriptive references — file, function, field, and
route names, plus descriptions of current behavior — through the task PATCH
API. Keep every statement of intent unchanged: Goal; the intent of each
Changes item; Out of scope; Constraints; Acceptance; and Route. The updated
description must be durable before the implementation task is claimed, so its
`.chain/{{branchName}}/spec.md` materialization and the later review
verification both use the patched authority.

For each Changes item, check whether its premise still holds. If the thing it
exists to change is gone or already delivered, collect concrete tree evidence
and call `inbox_ask` with exactly these choices (stable IDs and labels):
`cancel-chain` — cancel this chain; `operator-rewrite` — operator rewrites the
brief, then continue; `proceed-reading` — proceed with the step's proposed
reading. `cancel-chain` applies the revalidation action to cancel the chain.
After `operator-rewrite`, resume in place by re-reading the current
implementation brief; after `proceed-reading`, resume with the proposed
reading.

Use only the minimal task-PATCH authorization granted to this step. This is a
read-only workflow: do not edit files, commit, push, open a pull request, or
otherwise change repository state. An unreadable repository, rejected PATCH,
or tool error fails this step loudly with the reason recorded; normal retry
semantics apply.

After checking the brief and the tree, judge the implementation tier. The
default is the answer unless one specific criterion below applies; escalation
is by hazard or by output kind, never by path. Name the criterion in the route
reason and check the listed not-a-reason cases before choosing a tier other than
`default`:

- `default` — everything else. Acceptance that existing tests or grep can
  check stays here whatever it touches. It is not a reason to leave `default`
  that the change crosses packages, touches web files, touches many files,
  lands in a sensitive directory, or that an audit report once suggested a
  stronger model. The current Agent is `senior-dev-luna-max`.
- `frontend` — the deliverable is a new page, a page redesign, or a new
  interaction or visual scheme. It is not a reason to choose `frontend` to add
  a field, wire data, or change copy on an existing component. The current
  Agent is `frontend-dev-opus-medium`.
- `hard` — a behavior that neither the brief nor an existing test pins down has
  to be defined by the implementer, and getting it wrong would not show in
  review or regression; for example, keeping an untested semantic intact
  across several providers' event handling. It is not a reason that the change
  is large, spans modules, or needs a lot of reading. The current Agent is
  `senior-dev-sol-high`.
- `hazard` — the failure the acceptance suite cannot witness: concurrency,
  transaction boundaries, lock or lease windows, cross-module contract
  migrations; or the change alters what the merge gate, merge automation, a
  migration, or authorization does. It is not a reason merely to touch those
  files without changing their behavior. The current Agent is
  `senior-dev-astra-medium`.

Record the selected tier and the specific criterion that applies, or explain
why none applies when selecting `default`, in `route.reason`. The route is an
assessment only: never edit the brief's `Route` line, even when it is present.

After the PATCH succeeds, or when no descriptive references need changing,
persist exactly one JSON object as this step's output:
`{"schemaVersion":2,"headSha":"<current HEAD>","outcome":"updated|unchanged|proceeded-after-premise-collapse","summary":"<result>","changedReferences":["<reference>"],"route":{"tier":"default|frontend|hard|hazard","reason":"<criterion that applies, or why none does>"}}`.
