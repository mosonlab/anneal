# Changelog

What changed in each release of Anneal, written for the people who run it.
Entries group changes by the part of the product they touch. Versions follow
Semantic Versioning; before 1.0.0 a minor version may change behaviour, and this
file says so where it does. Releases up to v0.3.0 were published under the
project's former name, AgentOS, and their entries below are left as they were
written.

## Unreleased

- Retired the temporary `sol-findings` execution alias for Step roles, repair
  evidence and prior outputs, and PR handoff. Execution uses `review-findings`;
  ordinary staffing carry reports the retired kind as unknown. Historical
  Tasks, Runs, outputs, and reports remain readable without rewriting or deleting
  rows, and template adoption and rollover mappings remain supported. The
  retirement boundary was established on 2026-09-08: of 280 Chains carrying the
  old kind, the only three unarchived unfinished Chains (word-factory
  `3cd7177f`, `21cc2d0b`, `bb60e911`) were archived and re-created from current
  templates. The 103 archived unfinished Chains are abandoned with no supported
  retry or resume path; archived completed Chains remain readable.
- Briefs for cards dispatched after a predecessor now state premises as of
  that predecessor's merge, name its card or branch, and avoid "until it lands"
  language; dependency qualification checks those premises against its outcome.
- The readiness `merge-executor-offline` recovery guidance now tells operators
  that the manual fallback to automatic re-arm is to retry the Regression
  task, opening a new Regression Run at full rerun cost. It also records
  that the executor-offline requeue is a separate settlement: it spends
  neither the lease-loss refund cap nor a Regression repair budget.
- Merge-tail repair staffing preserves webhook and manual-trigger profile provenance.
  Repair slots refuse the mechanical merge-integrator; profile edits preserve an
  omitted archived slot. Reset restores entries with warnings when its canonical
  repair Agent or Repo context is unavailable, and new Default profiles capture
  canonical step bindings after synchronization.

- An auto-deploy whose quiet-window wait outlives its budget now stops the
  platform from admitting new Runs until that deploy lands: it opens a
  platform-wide dispatch drain, every claim is refused with `dispatch-draining`
  without touching any Task or its run budget, and the deploy deletes the drain
  on every exit path. Running Runs are never interrupted, the refused runners
  stay online, and `GET /runners` reports the drain as `dispatchDrain`. A drain
  left behind by a dead deploy process expires by itself 120 minutes after that
  deploy last reported itself (`DISPATCH_DRAIN_DEADLINE_MINUTES`). One migration adds the drain table.
- The runner's dispatcher slot count for the primary gate worker follows
  `RUNNER_GATE_PRIMARY_SLOTS` (1 or 2, default 2) instead of always being two,
  and sessions receive it as `AGENTOS_GATE_PRIMARY_SLOTS` in the two-host gate
  topology. Set it to the primary worker's own `~/gate/worker-capacity`, or a
  dispatch holds a slot while it waits on that worker's execution lock.
- A base-drift recovery that stopped on a merge gate FAIL the branch did not
  cause can be re-run from the API:
  `POST /tasks/:taskId/merge-tail/rerun` on the Regression task opens the next
  recovery attempt against the same head and queues a fresh Regression Run. It
  opens no repair task, charges no repair budget, spends none of the two
  automatic base-drift recovery attempts, and grants the queued Run its own
  budget, and it is bounded at two re-runs per recovery stop.
- Merge-tail `review-fix` and `gate-fix` repair cards now use the nullable
  `mergeTailRepairAgentId` slot on the Chain's staffing profile, falling back
  to the fixed-implementation Agent only when that slot is empty. A Chain with
  no recorded profile uses the template default profile; an archived slot
  Agent falls back with a recorded TaskActivity. The active direct, PR, and
  compound canonical profiles default this slot to `senior-dev-luna-max`,
  while `refresh-conflict` retains `MERGE_RESOLVER_ROLE`. Profile create, PUT,
  and reset operations accept optional `repoId` context for validating the
  slot's Repo grant; PUT omission preserves the slot and `null` clears it.
- A gate dispatch queued behind other gates no longer gives up while the queue
  is moving. `GATE_DISPATCH_TIMEOUT_MINUTES` now bounds a queue that makes no
  progress: each poll reads which process holds each busy slot, and a slot that
  changes hands restarts the timeout, up to an absolute ceiling of twice the
  timeout so a dispatch that keeps losing the race for a slot still gives up.
  `GATE DISPATCH: NO SLOT` (exit 75) now reports either a queue where nothing
  finished for the whole timeout or one that moved for the whole ceiling without
  room for this dispatch, and the stderr line above it says which.
- Editing a chain step's brief after implementation has started no longer parks
  the chain. A review claim now checks the materialized `.chain/<branch>/spec.md`
  against the brief the implementer was actually handed instead of against the
  brief as it reads now, and tells the reviewer, in one line, that the brief was
  amended after materialization. A `spec.md` rewritten on the branch is still
  refused, and the refusal says whether the current brief also differs. Adds one
  migration.
- Session events are now bounded end to end. A runner holds at most 32 MiB and
  20 000 undelivered events per Run. When it fills, the oldest liveness events —
  streaming deltas, raw provider frames, captured stderr, provider status and
  tool output — are dropped and an `EVENTS_DROPPED` event records how many and
  which sequence range were lost. Lifecycle, error and terminal events are never
  dropped; if the queue is still full once nothing droppable is left, such an
  event keeps its place, type and sequence number but loses its payload to a
  `truncated` marker; once every event not in flight is such a marker, the two
  oldest adjacent markers merge into one `EVENTS_COALESCED` event carrying their
  summed counts and the sequence range they span, so the queue holds its bounds
  under any traffic mix while every event it saw is still accounted for.
  A single event payload above 256 KiB is truncated to a `truncated` marker
  carrying its original size.
  `POST /runner/runs/:runId/events` enforces the same per-event cap and a
  request-body cap, answering 413 with the offending event's index so the runner
  drops that one event and resends the rest. Heartbeats now carry
  `eventQueueBytes`.
- The merge executor verifies its own landed merge from the commit when
  GitHub's pull-request projection cannot. A merge commit whose parents are
  exactly the authorized base and head and which is reachable from the
  authorized base ref now completes the run instead of parking the chain tail on
  a `base-drift-post-merge` question an operator answered by checking the same
  two parent shas. Any missing fact, and any failed or timed-out read, still
  stops `base-drift-post-merge`; the Inbox evidence gains a `directParentCheck`
  field naming what was read.
- `PATCH /tasks/:taskId` accepts `dispatchAfterTaskId` on the first step of a
  Chain that has no Run, re-pointing or (with `null`) releasing its Chain
  binding instead of forcing the Chain to be deleted and instantiated again. A
  started Chain, a later step, or a standalone task is refused with
  `chain_binding_immutable_after_start`; an archived, foreign, standalone, or
  same-chain predecessor with `chain_binding_target_invalid`.
- An exception thrown while merge readiness evaluates a Chain now requeues the
  readiness step instead of stopping the merge tail. The retry is bounded by
  `MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT` (default 3); past the bound the tail
  stops with `readiness evaluation failed after <n> exception requeues:
  <message>`. A deliberate refusal, and a missing or mismatched merge-gate
  operator authorization, still stop the tail on the first occurrence.
- Retired the `POST /files/mkdir` and `POST /files/move` routes and their
  underlying store operations.
- Removed `POST /inbox/messages/:messageId/supersede`;
  `POST /inbox/messages/:messageId/close` is now the only Inbox route whose sole
  purpose is closing a message. Archiving a task still closes its open merge-tail
  stop notices, and an approval decision still closes the gate's sibling cards.
- The retired `goal-5a0` authorization-marker harness and root
  `test:dependency-gate` script are removed.
- Removed the `bench-postgres.sh` and `bench-dbtest-concurrency.sh` gate-worker
  benchmark scripts; gate throughput tuning is closed and the measured ceiling
  is recorded in operator records outside this repository.
- The runner no longer writes or reads the `.agentos/task-output-receipt.json`
  delivery receipt, and the `POST_DELIVERY_DISCONNECT_ACCEPTED` event no longer
  carries its `localReceipt` and `localReceiptReadError` diagnostics. The
  server-returned output identity alone authorizes that recovery, which is
  unchanged; the receipt was diagnostic evidence only.
- Removed the completed one-shot database backfill and post-delivery audit
  CLIs and their root aliases; upgrades from pre-backfill versions are not
  supported. The unused root `db:export-goal-lineage` and
  `db:verify-goal-execution` aliases are also removed; both commands remain
  available as `npm run db:export-goal-lineage -w @anneal/db -- <output-path>`
  and `npm run db:verify-goal-execution -w @anneal/db`.

## v0.8.0 — Developer Preview 8

The eighth preview is about who does the work, and where it runs. Staffing
profiles let a project decide, step by step, which agent runs a template step
and which optional steps it skips, and a new Workflows console edits that
without hand-authoring a template. Linux becomes a maintainer-verified platform
with systemd units for every service, a host can contribute its own merge-gate
slots instead of dispatching everything to a remote worker, and the console
reaches every control from a phone. As with every 0.x minor, behaviour changes
below are breaking-eligible. There is still no supported upgrade path between
previews other than a fresh install. This release adds three migrations.

### Staffing, templates and workflows

- **A task template carries staffing profiles, and one of them is the
  default.** A profile holds one entry per step, keyed on the step's exact
  `outputKind`, naming the agent that runs it and — for an optional step —
  whether it is included or skipped. Profiles are created, duplicated, made
  default, reset and deleted through
  `/projects/:projectId/task-templates/:templateId/staffing-profiles` and
  `/staffing-profiles/:profileId`, validated under the Agent mutex, and carried
  through project bootstrap, template clone, step-graph replacement and
  canonical rollover. Instantiation resolves each step as dispatch
  `stepOverrides`, then the selected profile, then the canonical binding; a
  `Staffing: <name>` line in a brief selects a profile by name, and the chain
  root records which one was used.
- **`Project.skipOptionalSteps` is removed.** The column, its lock projection,
  the `PATCH /projects/:projectId` input, the wire contract and the Projects
  page toggle are all gone. Skipping an optional step is now a per-step decision
  inside a staffing profile, not a project-wide switch.
- **A template step can be declared optional.** A step marked optional in its
  frontmatter can be included or skipped without cloning the template, and the
  legacy template-shape comparators match on the optional flag each step
  declares rather than assuming every step is mandatory.
- **Canonical agents are identified by `canonicalRole`, not by their name, and
  are renamed in place to `role-model-effort` slugs** with two-word titles. The
  `customizedFields` list replaces `runtimeConfigCustomized`, an agent can be
  copied with `POST /agents/:agentId/duplicate`, and archiving an agent is
  refused while a staffing profile still references it.
- **Review steps are named for what they do, not for the model that runs
  them.** Every legacy template name the merge integrator can mint still
  resolves through the transition registry, and retired template generations
  fold away in the console so the current templates list first.
- **Reassigning a task is refused with `409` while that task has an active
  Run.** A retry with a new assignee derives the new agent's full runtime
  configuration rather than inheriting the old one.
- A control-plane step cannot be staffed at all, and a repair card never falls
  back to a hidden role when its own role is missing.
- The Workflows page (`/workflows`) walks templates, then profiles, then a
  per-step editor with an assignable-agent picker and an include/skip toggle on
  optional steps. The New Task panel gained a profile selector and a preview
  that resolves override over profile over canonical, marking skipped steps
  before the chain is created.

### Agents and model routes

- Canonical roles run on Codex rather than Pi.
- `gpt-6-astra` joins the model catalogue, priced and exposed at low, medium,
  high, xhigh and max. Implementation, plan execution and review coordination
  route through `gpt-6-astra:medium`; the review-fix step of every template
  binds to `senior-dev-astra-low`; `senior-dev-sol` and `senior-dev-opus` are
  explicit routes an operator can name in a brief but are never a template
  default.
- The retired bindings behind these moves are registered as structural
  generations, so a project that has not rolled over is recognized instead of
  being treated as drift.

### Chains, Runs and the runner

- **A chain name is required at instantiation**, at the API, in the web form
  and in the brief template. An unnamed chain is refused rather than given a
  generated placeholder.
- **A runner serves only the runner kinds it declares**, through the new
  `RUNNER_SERVED_KINDS`. An unset value keeps serving every kind; an invalid
  value refuses daemon startup.
- **The first mirror clone of a repository on a machine has its own time
  budget**, and its mirror root is configurable with `RUNNER_REPO_MIRROR_ROOT`.
  `docs/install.md` documents pre-seeding a mirror so a cold host does not spend
  a Run's budget on the initial clone.
- **`RUNNER_PATH` is now optional**, defaulting per platform: the Homebrew-first
  path on macOS and the standard path on Linux. The runner's admission,
  workspace restore and PATH mechanisms work on Linux as they do on macOS.
- A provider capacity refusal is classified as a transient external fault rather
  than as the agent's failure, and a fix step resumes from its own salvaged
  attempt through the new `Run.salvageParentSha`. An external transport fault
  refunds the attempt against the Run budget and names the fault instead of
  spending a retry silently.
- A Codex Run survives a provider disconnect by resuming inside the same Run,
  rather than being abandoned and retried from the top.
- An automatic retry publishes to the branch its task declares, not to whatever
  branch the previous attempt happened to leave behind.
- A regression FAIL excerpt carries the pytest failures for a Python-gated
  repository, so the failing tests are named in the repair brief.

### Merge tail, merge train and the merge executor

- A regression FAIL inside base-drift recovery has an operator-driven repair
  reentry: `POST /tasks/:taskId/merge-tail/repair` restarts the tail from the
  card that failed instead of leaving the chain stopped.
- A rejected completion is not retried automatically once the Run has been
  judged lost, and archiving a chain closes its open merge-tail stop notices in
  the Inbox.
- A merge train that finds the lease contended waits for it, then publishes the
  prefixes it has already proven while `main` is unchanged, rather than
  discarding proven work.
- A review step pins the implementation range from platform facts — the Run's
  own recorded SHAs — rather than from SHAs an agent typed into its output.
- The merge executor serialises a nested `Error` into its name, message, stack
  and `cause` chain instead of logging `{}`, and it runs when started through
  the `current -> releases/<oid>` symlink its own runbook installs. Before this,
  a symlinked install exited 0 silently and was respawned forever by the service
  manager.

### Merge gate

- **A host contributes a configurable number of local gate slots**, tried before
  its configured remote worker, through `RUNNER_GATE_LOCAL_SLOTS` and
  `AGENTOS_GATE_LOCAL_SLOTS`. Local dispatch stays off when neither is set.
  Local slots are accounted per runner account rather than per Codex session.
- `jq` is declared as a gate-worker prerequisite: `provision.sh` installs it, and
  a worker without it reports `GATE NOT RUN` beside the git, node and flock
  checks instead of producing a FAIL that says nothing about the commit.
- Type-aware eslint runs with a 3.5 GiB heap ceiling, which is where the gate
  had begun failing with a V8 out-of-memory inside `lint:types`.

### Web console

- The console has a phone shell: a sticky top bar with the project switcher and
  runner state, a five-slot tab bar and a bottom sheet for the remaining pages,
  Settings and the theme. The runner row is a link rather than a hover-only
  control, and the dark sidebar's faint text meets 4.5:1.
- Every page was read at 390x844 and made to fit: definition lists collapse to
  one column, metric cards go two to a row, the daily spend chart has its own
  phone geometry with legible axes, and touch targets are 44px — grown where a
  control can grow and given a hit halo where it cannot. No route scrolls
  horizontally except the data tables, which scroll by design.
- An operator can lift a task's run budget and edit its prompt from the task
  page, instead of reaching for `PATCH /tasks/:id` by hand after a
  `409 Run budget exhausted`.
- The hold action reads "Hold" on a board card and "Hold Chain" on the chain
  detail, replacing "Stop after current step" and "Stop after current layer".

### Costs and API

- Claude Session usage counts the latest cumulative `FINAL_OUTPUT` cost and
  `modelUsage` totals once per provider conversation within each process, then
  adds totals across `PROCESS_STARTED` boundaries. Resuming can retain the
  provider `session_id` while resetting its counters.
  On 2026-09-08 UTC, the locked `recomputeSessionUsage` correction checked 14
  historical Claude Sessions with multiple final outputs: 10 changed and four
  remained correct. Their stored cost totals changed from $274.2944 to
  $106.4807, removing $167.8137 of duplicate accounting. Each Session's derived
  totals were verified after writing; a second recompute made no changes.
- A Codex session with native children is priced by the model that produced each
  token, rather than attributing every token to the session's parent model.
- A mechanical completion contract mismatch opens an Inbox alert instead of
  failing where nobody sees it.
- The runner telemetry registry keeps every daemon it has seen inside the forget
  window, so a briefly silent runner does not disappear from the console.

### Installation and maintainer deployment

- **The API refuses to start without `GITHUB_READ_TOKEN`.** A missing or
  placeholder value exits 78 with a `missing:GITHUB_READ_TOKEN` or
  `placeholder-value:GITHUB_READ_TOKEN` reason. The credential is read-only and
  is never exchanged with the merge token; it is now required of every API
  process, whether or not Direct or Full Assurance is enabled. Obtain one before
  running the install sequence.
- Anneal's services install and deploy as systemd units on Linux, alongside the
  existing macOS profile.
- **Runner identities can be namespaced with `AGENTOS_RUNNER_ID_PREFIX`**, so a
  second machine's runners do not collide with the control plane's. Reinstall
  grows and shrinks the unit set without touching surviving units, and a
  privileged transition is bound to the prior manifest and transaction digests.
- A malformed install manifest is refused with an error naming the file and the
  field, and a host that keeps only runners follows the control plane's deployed
  build automatically.
- The release artifact build retries a transient source clone failure before
  escalating, and the auto-deploy suite is hermetic on a developer Mac.
- These changes apply to the maintainer appliance. The public Developer Preview
  continues to use the foreground fresh-install sequence in the README.

### Documentation

- Linux (Ubuntu 24.04 LTS, x86_64) is now a maintainer-verified platform
  alongside macOS on Apple Silicon; the install documents drop their
  macOS-only wording. Running some runners on a second machine over an SSH
  tunnel is documented as experimental in `docs/install.md`.
- The remote gate-worker profile, the autonomous merge tail and the Linux
  systemd merge executor move from Unverified to Maintainer-verified in the
  support matrix; the macOS LaunchDaemon executor profile stays Unverified.
- Codex CLI model access moves from Pending to Maintainer-verified in the
  support matrix: since the canonical roles moved to Codex, the maintainer's own
  installation runs Codex chains daily. The adapter's verification wording is
  unchanged.
- The 2026-09-04 documentation audit corrected the reader surface: the routing
  and delivery runbooks, the agents' verification and deployment boundaries, the
  repository instructions and the decision-record surface. ADR 0001 keeps its
  decision and moves its diagnosis to operator records.
- `CONTRIBUTING.md` documents pre-acquiring the merge lease before a host-run
  merge train.

### Internal structure

- A refactor wave gave single owners to the canonical source prompt generation,
  the Run's publish target, the mechanical contract compatibility decision, the
  template step field table and its omission fact, the completion advancement
  decision, the provider relaunch gate, the Run verdict over its exit record,
  the deployment service inventory, the sudoers grant derivation and the
  installer outcome. A first simplification wave removed five zero-reference
  database exports, a never-declared runner session-tool transport, an unused
  deploy preflight script and several inert web allowlist rows. These changes
  are intended to preserve their existing external behaviour.
- The published prompt generation is a checked-in fact rather than something
  recomputed at read time, and the pre-optional-review prompt rollover is
  registered.
- The removed surfaces in this release are `Project.skipOptionalSteps`,
  `runtimeConfigCustomized` and the `agentName` literals in retired-generation
  fingerprints. The new routes are `POST /agents/:agentId/duplicate`,
  `GET /projects/:projectId/task-templates`, the staffing-profile routes under
  `/projects/:projectId/task-templates/:templateId/staffing-profiles` and
  `/staffing-profiles/:profileId`, and `POST /tasks/:taskId/merge-tail/repair`.
  The new configuration keys are `RUNNER_SERVED_KINDS`,
  `RUNNER_GATE_LOCAL_SLOTS`, `AGENTOS_GATE_LOCAL_SLOTS`,
  `RUNNER_REPO_MIRROR_ROOT` and `AGENTOS_RUNNER_ID_PREFIX`; `GITHUB_READ_TOKEN`
  changes from optional to required.

### Known limitations

- There is no supported in-place upgrade from v0.7.0. Install v0.8.0 against an
  empty schema with `npm run db:migrate:release -- --fresh`.
- The delivery symptom in [Issue #305](https://github.com/mosonlab/anneal/issues/305)
  is classified accurately, but the provider-side cause is not eliminated: a
  code-producing provider can still end a successful session without writing or
  committing its announced work. A manual Task's final prose remains in its
  Session events and is not promoted to retry handoff output.
- The pull-request tier stops at an open pull request. Anneal does not review or
  merge it for you, and onboarding a project does not provision another
  workflow or create a Secret.
- macOS on Apple Silicon and Linux (Ubuntu 24.04 LTS, x86_64) are the verified
  targets. macOS on Intel is expected to work but has not been exercised;
  Windows is unsupported by design.
- On a phone, the data tables still scroll horizontally rather than becoming
  card lists; the `Toggle` and `Check` controls keep their existing hit targets
  because a halo would overlap the rows around them; and iOS Safari zooms on a
  focused input, because the application's type scale is pinned to a 13px root
  and `maximum-scale=1` would cost pinch zoom.
- Anneal still launches coding CLIs with the operator account's authority and
  is not a sandbox.

## v0.7.0 — Developer Preview 7

The seventh preview opens Anneal to more than one project: a documented
onboarding path takes a new repository from `POST /projects` to an open pull
request, approval gates become a per-project setting instead of a fixed
property of the workflow, and the Board gains direct Hold and Resume control
over a running chain. As with every 0.x minor, behaviour changes below are
breaking-eligible. There is still no supported upgrade path between previews
other than a fresh install. This release adds five migrations.

### Multiple projects and onboarding

- A project can be brought up end to end from the API. `POST /projects`
  bootstraps a Project with the canonical `pr-engineer-workflow` template,
  which implements, reviews and applies fixes, then hands over an open pull
  request with its evidence for you to review and merge yourself. The whole
  path is written up in
  [Add a project](docs/runbooks/add-a-project.md), which is the one onboarding
  page for both the pull-request tier and the full Direct and Full Assurance
  tier.
- `POST /projects/:projectId/repos` runs a repository preflight before the Repo
  row exists, checks Git identity, remote reachability, default branch, fetch
  and dry-run push, and can grant every active Project Agent `GIT_WRITE` in the
  same transaction with `grantAgents: true`. Preflight is never skipped as a
  success fallback. The Inbox is scoped per project.
- **`dependencyProvisioning` is now a required field on a Repo, declared as
  exactly `NONE` or `NPM_CI`.** Anneal no longer infers it. The declaration is
  preflighted on create and on `PATCH /repos/:repoId`: `NPM_CI` without a root
  `package-lock.json` on the fetched default branch, and `NONE` with one
  present, are each refused with a named code and a remedy rather than
  producing a Run that fails later.
- The regression tooling a Run needs is supplied by the runner into a per-run
  directory outside the checkout, so a project does not have to carry Anneal's
  gate scripts in its own repository. The canonical Regression steps and the
  reference merge gate both read the runner-provided tooling.
- Canonical Agent, role and template sync runs per project in its own
  transaction and reports each project's refusals instead of failing the whole
  sync silently. `npm run db:sync-canonical-prompts -- --install-full
  <projectId>` completes the canonical inventory for the full-tail tiers, and a
  partial verifier reports what a partially installed project is still missing.

### Approval gates

- **Approval gates are configurable per project.** A Project carries
  `specGateDefault` and `mergeGateDefault`; template instantiation accepts a
  `gates` object with optional `spec` and `merge` booleans. For the
  specification and merge-readiness slots the created Task's `approvalGate`
  resolves in exactly this order: the dispatch override, then the project
  default, then the template step's frontmatter. An explicit `false` is an
  override. Every other step keeps its template value.
- Resolved gate values are persisted onto the created Tasks, so changing a
  project default later does not change a Chain that is already running. A
  `gates.spec` or `gates.merge` sent to a template that has no such step is
  refused with `gates_spec_step_absent` or `gates_merge_step_absent` and
  creates no Task. Factory defaults leave both gates off.
- A malformed `Route:` line in a brief is refused at direct instantiation with
  a `400` instead of silently falling back to a default assignee and
  misrouting the chain.

### Board, task detail and Inbox

- Chain aggregate cards carry Hold and Resume directly, show a held state, and
  can be held before their first layer has started. The Doing column can hold
  every chain it shows in one action. A hold is layer-granular and never
  cancels a Run that is already going.
- Board cards are more compact, every column reads newest first, and a card
  footer links the newest Run's pull request and shows its cost. The run line
  on an aggregate card wraps instead of being truncated.
- Task detail opens on the frontier step rather than the first one, adds a
  session column, makes the Details block collapsible, and shows a Now block
  carrying the newest Run's latest agent message.
- Archiving a chain from a card is applied to the whole chain atomically
  instead of one request per member.
- Every open Inbox card accepts a free-text answer, and an approve or reject
  decision on a gate can carry an operator note.

### Costs

- The Costs page reports per-chain lead and busy time, repair counts, longest
  idle gap and priced spend by step role, alongside the existing totals. Waste
  is partitioned exactly into operator-cancelled and failed spend, and failed
  spend is partitioned further by failure class.
- Cache accounting has one completeness rule across the views. Runs whose cache
  split is unknown are counted and excluded from cache metrics rather than
  being folded in, and an unpriced Run is never given a fabricated cost.

### Template authoring

- A canonical template can be cloned under a project-local name with
  `POST /projects/:projectId/task-templates/:templateId/clone` and edited with
  `PUT /projects/:projectId/task-templates/:templateId/steps`, so a workflow
  can be adjusted without hand-authoring one from scratch. A template already
  in use refuses the edit; the recovery is to clone again.

### Host load and gate stability

- The runner stops claiming new work while the host's one-minute load average
  is above cores times 1.5, and resumes claiming when it drops. Running work is
  not interrupted. The threshold is `RUNNER_CLAIM_MAX_LOAD_AVERAGE`.
- Per-workspace verification inside Runs shares a host-wide proof-slot ceiling,
  Node test concurrency is capped inside Run proofs, and a proof-slot wait of
  60 seconds or more is reported rather than being silent.
- The merge gate defaults to half the host when it is not running on a
  dedicated gate worker.
- The runner dependency cache is retained against a fixed byte budget rather
  than an entry count.
- A gate failure excerpt keeps its stage attribution through nested workspace
  headings, and a gate-fix repair brief names the failing tests rather than
  only the failed stage.

### Runner and delivery reliability

- **Runs against a private repository can authenticate.** The session answers
  git credential requests from the runner account's home even when the provider
  relocates `HOME`, and the credential helper is materialized into the Run's
  tools. Before this, every fetch in such a Run failed with
  `could not read Username`.
- Delivered work is no longer thrown away by what happens after delivery. A
  provider stream that dies after the work is delivered is accepted, an
  explicit terminal failure is not promoted over a completed delivery, and a
  reconnect notice that names its own cause is no longer misread as
  `PROTOCOL_ERROR`.
- A merge-tail repair card gets a second Run instead of stopping the whole
  merge tail when its first Run is lost after delivering.
- A Run's target branch is resolved inside the run workspace, so a workspace
  cloned from its own salvaged head no longer retries a revision lookup that
  cannot succeed. A salvage continuation that correctly produces no new commit
  no longer dead-ends in `REVIEW`.
- A failed regression target fetch reports git's own error and retries only
  genuinely transient network failures, and merge-lease git operations use the
  canonical retry and backoff budget instead of three fixed one-second
  attempts.
- A required-output status failure is terminal, prior-Run immutable findings
  output is accepted at Run completion and by the sibling review validator, and
  the merge integrator raises a stop question only when it has to: a definitive
  merge result outranks a failed completion.
- A malformed or empty JSON body returns `400` on every JSON route instead of
  `500`, and a failed startup health count is reported as unavailable rather
  than as `0`.
- [`docs/operator-api.md`](docs/operator-api.md) now documents the operator exit
  for a merge tail that stopped after exhausting its repair budget, and the
  route handbook is checked against the registered routes so it cannot drift.

### Maintainer deployment

- A transient deploy failure that raised an escalation is retried and can
  self-clear within its bounded budget, rather than latching and waiting for a
  maintainer.
- `--clear-escalation` now clears the escalation marker instead of reporting
  success without removing it.
- These changes apply to the maintainer appliance. The public Developer Preview
  continues to use the foreground fresh-install sequence in the README.

### Internal structure

- Route registration is split out of `app.ts` into per-prefix route modules,
  and a large refactor wave gives single owners to the runner's claim payload,
  run session, run outcome, delivery receipt, dependency-provisioning decision
  and dependency-cache store; to the API's refusal-code status families and Run
  output evidence; to the database's canonical drift adoption, canonical sync
  report, operator console wire contract and refused-Run disposition; to the
  web client's Chain control admissibility and run liveness; and to the
  deployment escalation marker and invocation decision. Every native projection
  is now proved to serialize to its browser contract. These changes are
  intended to preserve their existing external behaviour.
- Session events no longer persist `message_update` and `tool_execution_update`
  chunks. The runtime-tools bundle is byte-identical across builds, and
  `verify-test-no-build` is retired.
- No HTTP route or configuration key is intentionally removed in this release.
  The breaking change is the required `dependencyProvisioning` declaration on a
  Repo; the observable additions are the project gate defaults and the
  `gates` dispatch override, the template clone and steps routes, the per-chain
  Costs fields, and the Board hold fields.

### Known limitations

- There is no supported in-place upgrade from v0.6.0. Install v0.7.0 against an
  empty schema with `npm run db:migrate:release -- --fresh`.
- The delivery symptom in [Issue #305](https://github.com/mosonlab/anneal/issues/305)
  is classified accurately, but the provider-side cause is not eliminated: a
  code-producing provider can still end a successful session without writing or
  committing its announced work. A manual Task's final prose remains in its
  Session events and is not promoted to retry handoff output.
- The pull-request tier stops at an open pull request. Anneal does not review or
  merge it for you, and onboarding a project does not provision another
  workflow or create a Secret.
- macOS on Apple Silicon remains the only release-verified target. Linux and
  macOS on Intel are expected to work but have not been exercised; Windows is
  unsupported by design.
- Anneal still launches coding CLIs with the operator account's authority and
  is not a sandbox.

## v0.6.0 — Developer Preview 6

The sixth preview adds wave activation and live repair visibility to the chain
board, makes zero-commit delivery outcomes explicit, and bounds the maintainer
appliance's deployment steps. As with every 0.x minor, behaviour changes below
are breaking-eligible. There is still no supported upgrade path between
previews other than a fresh install. This release adds four migrations.

### Board and chain operations

- The Todo column can activate every parked chain aggregate on its current
  visible page after one confirmation. Each chain retains its own startability
  check; starts run concurrently, and a named refusal for one chain does not
  stop the others.
- Aggregate chain cards show an active detached merge-tail repair, including
  its repair kind, latest Run, model and reasoning effort, Codex `FAST` tier and
  elapsed time. The additive Board wire fields are
  `chainAggregate.activeRepair` and `latestRun.codexServiceTier`.
- Fully archived chains no longer reappear on the active Board through a
  detached repair binding. Archived siblings still contribute to an aggregate
  when a live member owns the card.

### Runner delivery and chain evidence

- A successful provider session whose Run requires a commit but leaves `HEAD`
  at its base now fails before push or pull-request creation as
  `NO_CHANGES_PRODUCED`, rather than surfacing GitHub's misleading
  `No commits between` response. This outcome is not classified as an external
  delivery failure and does not raise the retry budget.
- Canonical output-only Direct and Full Assurance Steps now snapshot an
  explicit `requiresCommit=false` contract onto each Run. They may publish an
  unchanged shared branch for the next Step. The primary plan and implementation
  Steps require a commit. A manual Task that requests a pull request also
  requires one, while branch-only manual work retains its optional-commit
  behaviour.
- A negative Regression verdict from an older output-only Run rejected under
  the former commit requirement is audit-only evidence unless an exact repair
  attempt consumed it. Valid repair handoffs remain fail-closed.

### Merge-tail reliability

- Historical pre-intent and target-branch-mismatch recovery refusals now use
  typed `MergeRecoveryRefusalCode` values. Two migrations add the codes and
  backfill exact legacy messages, so recovery decisions no longer parse
  operator-facing prose.
- Runner backend claim health, dependency-cache collaborators and the shared
  Session, Run, Task, Chain, Trigger, Costs and Board wire contracts each have
  one owning module instead of competing projections.

### Maintainer deployment

- A transient `remote-main-unreadable` result is retried within a bounded
  budget. Only that transport escalation may self-clear after a later successful
  read; persistent, authorization and malformed-response failures remain
  latched, and the Inbox record remains as historical evidence.
- Artifact build, backup, migration, Prisma generation, prompt sync and service
  control have independent deadlines plus a deployment-barrier watchdog.
  Ordinary timeouts follow the normal failure path and release the barrier.
  Before publication the current release remains active; afterwards recovery
  attempts to restore the prior release and services. Database migrations are
  not rolled back. A migration-deploy timeout instead prevents activation and
  restart and keeps the PostgreSQL barrier blocking new Run claims until an
  operator safely runs `--clear-escalation`.

### Gate and test structure

- The longest parallel-review database test is split by subject so the merge
  gate can schedule its cases in parallel without changing runtime behaviour.
- No command, HTTP route or configuration key is intentionally removed in this
  release. Observable contract additions are the `NO_CHANGES_PRODUCED` failure
  class, the Step and Run `requiresCommit` policy, and the additive Board fields
  above.

### Known limitations

- There is no supported in-place upgrade from v0.5.0. Install v0.6.0 against an
  empty schema with `npm run db:migrate:release -- --fresh`.
- The delivery symptom in [Issue #305](https://github.com/mosonlab/anneal/issues/305)
  is now classified accurately, but the provider-side cause is not eliminated:
  a code-producing provider can still end a successful session without writing
  or committing its announced work. A manual Task's final prose remains in its
  Session events and is not promoted to retry handoff output.
- macOS on Apple Silicon remains the only target platform. Linux remains
  unverified and Windows unsupported.
- Anneal still launches coding CLIs with the operator account's authority and
  is not a sandbox.

## v0.5.0 — Developer Preview 5

The fifth preview makes the board read at chain level, makes completed work
self-clearing, and replaces the maintainer appliance's mutable checkout deploy
with immutable release directories. As with every 0.x minor, behaviour changes
below are breaking-eligible. There is still no supported upgrade path between
previews other than a fresh install. This release adds five migrations.

### Board and task lifecycle

- Chains collapse into aggregate board cards that carry their task count,
  progress and available actions. The individual tasks remain available in the
  chain and task detail views.
- Individual task moves are projected from operator-owned transitions rather
  than from every status the runtime can produce. Aggregate chain cards expose
  activation, filtering and archival actions; they are not draggable.
- DONE tasks are archived automatically after seven days, in batches of at
  most 100 tasks. A chain member becomes eligible only after every persisted
  member of that chain is DONE.
- `DELETE /tasks/:taskId/chain` deletes a whole chain and its marker-bound
  repair tasks atomically. It refuses while active runs or retained run/session
  history remain. Chain members can no longer be deleted individually through
  `DELETE /tasks/:taskId`.
- Card rendering, pagination and status projection now share one contract
  between the desktop board, mobile list and API.

### Costs

- The Costs page is rebuilt as a two-column dashboard with model, cache and
  waste breakdowns, while preserving the period totals and top-run views.
- The API now reports model and cache usage, reconciles rounding in the model
  breakdown, and fixes date-bucket gaps across local day and DST boundaries.
  The costs endpoint now requires an IANA `tz` query parameter; omitting it
  returns `400` rather than guessing a timezone.

### Merge-tail reliability

- Readiness claims have an explicit durable handle, so only one worker owns the
  transition while recovery reads are performed.
- Claims left in the pre-migration `failureReason` format are reclaimed at
  their recorded expiry, so a crashed worker at the migration boundary cannot
  leave its merge chain stuck.
- Merge-lease handoffs and deferrals are recorded in a durable ledger, and
  deferred releases are indexed and retried rather than being lost after a
  transient failure.
- Requeue attempt authority and budget are persisted for merge-tail repair, and
  chain deletion is serialized with concurrent member creation.
- Recovery refusals and merge-tail transitions are typed and applied through
  shared decision seams, preserving the existing external behaviour while
  removing competing implementations.

### Maintainer deployment

- The macOS appliance deployment path now assembles immutable, verified release
  directories and activates them through an atomic `current` pointer. Service
  wrappers read that pointer, so deployment no longer mutates or serves a source
  checkout.
- A durable ledger records build, backup, migration, activation, verification
  and rollback evidence. Database maintenance runtime and nested dependency data
  are included in the verified artifact.
- These changes apply to the maintainer appliance. The public Developer Preview
  continues to use the foreground fresh-install sequence in the README.

### Release and support surface

- **The public `verify:oss-b0` and `test:oss-b0-harness` commands are removed as
  a breaking change.** No compatibility alias or
  replacement harness is provided. Current verification remains with
  `scripts/merge-gate.sh` and its `scripts/gate-worker/` dispatch path, `npm run
  test:release-docs`, `npm run test:dependency-gate`, `npm run
  verify:secret-hygiene`, and the public-snapshot scans. The merge-integrator
  real/system checks and documented templates release demo remain unchanged;
  the frozen OSS-B0 smoke fixture remains for release, UI and API parity.
- The project-scoped goal action aliases are removed. Call
  `POST /goals/:goalId/approve-dod` and `POST /goals/:goalId/pause` instead of
  the former `/projects/:projectId/goals/...` routes.
- `view=board` adds a `chainAggregate` projection to one row in each chain. The
  web client uses it to render one aggregate card while the API retains the
  underlying task rows.
- Settings now reports the Anneal product version and exact build SHA returned
  by `/version`, separately from runner daemon and provider CLI versions. A
  failed version request is shown as a failure rather than as an unknown build.
- Repository links recognise both SCP-style and `ssh://` GitHub remotes while
  rejecting unsupported SSH remote shapes.
- The README is rewritten around the unattended chain workflow, with current
  board and agent views, clearer trust boundaries and a Linux Do community link.

### Known limitations

- There is no supported in-place upgrade from v0.4.0. Install v0.5.0 against an
  empty schema with `npm run db:migrate:release -- --fresh`.
- macOS on Apple Silicon remains the only target platform. Linux remains
  unverified and Windows unsupported.
- Anneal still launches coding CLIs with the operator account's authority and
  is not a sandbox.

## v0.4.0 — Developer Preview 4

The fourth preview, and the first under the name Anneal. The headline is
operator control over a running chain: a chain can be held mid-flight and
resumed exactly once, and the console's Sessions and new Costs pages make what
a chain did and what it cost readable without leaving the browser. As with
every 0.x minor, behaviour changes below are breaking-eligible, and there is
still no upgrade path between previews other than a fresh install. This release
adds eight migrations.

### The rename

- The project is now called **Anneal**. The repository moved to
  `mosonlab/anneal`, the internal npm scope is `@anneal/*`, and the product
  name in the console, the documentation and the release material follows.
- **Nothing an operator configures was renamed.** The `AGENTOS_*` environment
  variables, the default `agentos` PostgreSQL database and role, the
  `~/.agentos/` runtime directories and the `agentos` MCP server name are
  unchanged in this release, so an existing `.env` and an existing runner host
  keep working. Renaming them is successor work and will be called out as
  breaking when it happens.
- Deployments that were provisioned before the scope rename are recovered
  rather than reinstalled, and the legacy delivery artifacts of a run that
  straddles the rename are bridged instead of failing.
- Two names do change where the product names itself in output: the runner's
  git identity now reads `Anneal Runner` rather than `AgentOS Runner` (its
  address is unchanged), and the canonical
  chain prompts that named the platform are rolled forward under a registered
  prompt-only template generation (`pre-product-rename-anneal`). An existing
  install picks the new prompts up through the ordinary canonical sync; an
  unregistered prompt edit still refuses, as before.

### Chain hold and resume

- A running chain has an explicit control authority. `POST
  /tasks/:taskId/chain/hold` holds it at its current layer and `POST
  /tasks/:taskId/chain/resume` releases it; both are idempotent on a request
  identifier, and a chain's `control` block reports the held layer, who held
  it, why, and when it was last released.
- The hold is enforced where work is admitted rather than only in the UI:
  successor layers do not activate while held, a held step is refused
  admission, held successor runs are excluded at claim time, and a universal
  enqueue barrier covers the paths that used to enqueue around the layer
  machinery. Cancelled runs survive a release instead of being reactivated.
- The board and task console can hold and resume a chain, and a step shows the
  hold-specific refusal it would return.
- Salvage repair is serialized with holds, so a repair raised inside a held
  chain cannot run ahead of the operator releasing it.

### Sessions, Costs, and the console

- Sessions is rebuilt for reading: rows replace the table, sessions group by
  calendar day, agent and status filters narrow the list, unseen sessions are
  tracked locally, and a hover card carries the detail the row drops.
- The session stream is projected rather than dumped: tool calls group, prose
  chunks merge into continuous text, markers and operator input render as their
  own nodes, and output lines are capped so one runaway session cannot make the
  page unusable.
- A read-only **Costs** page reports spend over 7, 30 or 90 days: tiles for
  total spend, run count and average per run, a daily stacked bar chart grouped
  by agent, and by-agent and top-run tables. The chart is inline SVG with no
  charting dependency, and the same figures ship as a table beside it because
  three of the light-theme series colours sit under 3:1 against the card. The
  tiles state what they cannot include — the estimated share of the total, and
  the number of settled runs that reported no cost at all.
- A new project cost aggregation endpoint backs the page, and cached input
  tokens are normalized at the write boundary with the historical rows
  backfilled.
- Native child sessions are priced from what was actually observed rather than
  from a guess: an unsplit native child bills at the parent's rates, a
  cost-only model total is preserved instead of discarded, and the unobserved
  Claude fallback is removed.
- Every control-plane request from the console is bounded, board columns are
  bounded, the Inbox badge polls a summary instead of the full list, and a card
  is labelled with its run's model snapshot rather than the agent's current
  setting.
- The Inbox separates notices from cards that owe a reply, and dismissal is
  based on what actually blocks a run.

### Task chains and canonical agents

- The direct engineer workflow is eight steps and opens with a conditional
  revalidation of the brief: the step materializes only when the chain is bound
  to a predecessor task, and the revalidation session runs fenced with its own
  capability set.
- Prior outputs a step may read are declared per template and enforced as a
  whitelist, so a step cannot silently widen its context; the declarations
  survive an upgrade with their handoffs intact.
- Canonical template identity is derived rather than matched by name, canonical
  agent defaults load from the role sources, and a prompt-only canonical
  rollover can be registered without a structural change.
- Model routing is re-pinned again: regression verification moves to Luna at
  max effort, the plan reviser to Sol at high, spec and blind review are pinned
  to Opus high in the canonical contract, and frontend-heavy implementation
  routes to `frontend-dev`.
- Operator model and runner overrides are respected: canonical sync adopts
  drift only where an operator has not customized the value, notifies on
  customized drift, and a reset route restores the canonical runtime
  configuration.

### Regression verification

- Mechanical verification moved into a script and the verifier is narrowed to
  the semantic recheck it is actually good at.
- Verdicts are persisted mechanically and settled durably, including after a
  transport failure, so a verdict that was reached is not lost to a dropped
  connection.
- Retries are bound to the salvage branch and the run that produced them, and
  the recovery regression head is adopted rather than inferred.

### Merge delivery and recovery

- A cumulative merge train replaces one-candidate-at-a-time delivery, with its
  proof modes documented in
  [`docs/adr/0002-coordinate-main-delivery-with-merge-trains.md`](docs/adr/0002-coordinate-main-delivery-with-merge-trains.md).
- The gate's signature is persisted as a merge precondition, and chain-authored
  commits are attested with stale provenance stripped on rewrite.
- The merge lease is acquired in readiness rather than at the merge itself, is
  recorded project-scoped, reports its acquisition time on release, and
  readiness-owned leases are released against the project target — see
  [`docs/adr/0003-acquire-merge-lease-in-readiness.md`](docs/adr/0003-acquire-merge-lease-in-readiness.md).
- Pre-intent and legacy base drift are recovered rather than parked, and the
  live legacy recovery sentinel is retired.
- The autonomous merge tail no longer holds a merge for an independent review
  of a defense-list diff. Defense-list detection stays as an audit record: a
  match writes one inbox message naming the triggered paths and reasons, and
  the merge proceeds.
- **The Ed25519 release-authority attestation layer is removed whole** — the
  signing and verification module, the mint and check scripts, the tracked key
  and attestation, the preflight `authority` condition, the resign worker, and
  the two `GOAL5A0_*` SHA exports every install path used to require. The
  release-candidate migration set, the gate attestation, the merge lease and
  the gate's own checks are unchanged.
- Delivery fails loudly when a GitHub pull request is not recorded, and a
  pushed branch is preserved when pull request creation fails.

### Control plane and API

- Claim specifications are read from local mirrors at pinned commits against
  the exact claim remote, review specs are verified at pinned implementation
  heads, and the spec verdict cache is bound to its repository. Transient read
  failures are retried and then deferred under a budget rather than parking the
  work.
- Claims are prioritized by remaining chain work.
- A task can be created directly in `BACKLOG` in one call, and it stays parked;
  mechanical task cards stay prompt-only and promptless mechanical starts are
  admitted.
- Upgrade sweeps are decided under a lock rather than from a stale snapshot,
  and spent sweeps are removed.
- Refusals are typed through the workflow layer, and run terminalization, step
  admission, merge lease disposition, base drift recovery decisions and the
  readiness evaluation each moved behind one seam instead of being decided at
  every call site.
- A new [operator API handbook](docs/operator-api.md) documents the routes, and
  a route change is required to update it in the same change.

### Runner

- Session-created worktrees are contained: escapes from the run root are
  observed, persisted and reported, including on cancellation.
- The dispatched prompt's hash is persisted, so what a run was actually given
  can be checked after the fact.
- Host-personal skill roots are isolated from a run, with git configuration
  preserved under that isolation, and Codex resume authorization survives a
  reconnect.
- Operator notes reach retry prompts, missing task output is remediated in the
  session, and reconnect evidence is preserved on a failed exit.
- Deployment and dependency caches are bounded.

### Development and operations

- The merge gate host was resized and its evidence recorded; the database wave's
  two long test files are split and a test that waited out a 35-second delivery
  deadline no longer does.
- The public snapshot scanner fails when an include glob matches no git-tracked
  path.
- The operator handle in published material is replaced with a role name, with
  a `.mailmap` mapping the second author email; the `.mailmap` itself is not
  published.

### Documentation

- Both READMEs lead with the problem and a time-lapse of one real chain, state
  the spec-to-merge value proposition and the subscription authentication
  model, table the twelve-step chain with role, runner, model and effort, and
  point at the support matrix rather than copying it. Pi's authentication
  source is corrected to the Codex login.
- `AGENTS.md` is a trigger layer: the detail moved to the documents that own it,
  and the routing contract now records dependency qualification and the backlog
  card lifecycle.
- The published documentation surface is smaller: the support note and evidence
  status live in the README, three operator runbooks are maintained outside
  this repository, and the Simplified Chinese inner documentation pages are
  retired.
- `THIRD_PARTY_NOTICES.md` carries the mattpocock/skills notice the chain
  prompts require.

### Known limitations

- There is still no upgrade path between previews. Installing v0.4.0 over a
  v0.3.0 database is not supported; the supported install is
  `npm run db:migrate:release -- --fresh` against an empty schema.
- The migration preflight bypass is still procedural, not technically closed:
  nothing prevents a hand-run `prisma migrate deploy`.
- The `--existing` release-migration consumer remains executable but has no
  supported end-to-end workflow, because this repository does not ship the
  backup producer that creates its input.

## v0.3.0 — Developer Preview 3

The third preview. The headline is delivery: the merge tail now runs itself,
from gate proof through review repair to a serialized exact-head merge, and
chains execute in explicit layers that the API and the console both show. As
with every 0.x minor, behaviour changes below are breaking-eligible, and there
is still no upgrade path between previews other than a fresh install. This
release adds ten migrations, including an expand/backfill/contract sequence over
chain layers.

### Merge delivery

- The merge tail is autonomous: a repair loop that reads review severity,
  recovers parked work, hands repair tasks the chain's context and a second
  attempt, and binds the gate proof to the regression head it was produced
  against.
- Merge delivery is serialized on the exact head, recovers pre-merge base drift
  automatically, and centralizes recovery authority instead of deciding it at
  each call site.
- The merge lease is parsed once and its release reports a typed outcome, and
  the hold window is narrowed to the merge itself — see
  [`docs/adr/0001-merge-lease-hold-window.md`](docs/adr/0001-merge-lease-hold-window.md).
- Merge credentials are minted through a private GitHub App, and the
  provisioning path for a self-hosted merge executor is public and documented in
  [`docs/runbooks/merge-executor.md`](docs/runbooks/merge-executor.md).

### Task chains and canonical agents

- Chains have explicit execution layers. The schema expands with a legacy
  backfill and then contracts onto the layered shape, the API exposes layers and
  progress, and the console renders them with blocked-on markers.
- Canonical templates are layered, their review sources split, and their prompts
  now load from markdown rather than from inlined strings. A six-step direct
  engineer workflow template ships alongside the full-assurance chain.
- Blind review and adjudication are separate roles with their own authority
  guard and physical isolation, and the review base is pinned in the schema
  rather than inferred.
- The spec and revise-plan approval gates are removed and the plan reviser
  retiered; regression verification is streamlined, routed to Sol, and its
  repair handoffs are bound to the run that produced them.
- Chain prompts are aligned with the upstream mattpocock-skills baseline, both
  senior-developer roles adopt its implement cadence, `senior-dev-luna` is the
  direct chain's implementation default, the librarian moves onto the Pi runner,
  and canonical model routing is re-pinned across the fleet.
- Implementation runs on native Luna subagents, with configurable executioner
  subprocess profiles and Codex service tiers.

### Control plane and API

- Task dispatch binding: a chain can be instantiated bound to a predecessor
  task, terminal steps dispatch on that binding, and the start guard reports
  chain detail.
- Runs and the merge tail have explicit operator control, unclaimed queued runs
  can be cancelled, and an archived task's Inbox messages are superseded rather
  than left open.
- Refusal-to-HTTP mapping is centralized, and `app.ts` is split into modules
  along its own seams.
- The board confirms task starts, orders cards by activity, shows an approval
  gate's full artifact, and shows estimated cumulative run cost.
- Model and runner choices saved in the Agents page are durable operator
  overrides; canonical seed and prompt sync no longer replace them.

### Runner

- Workspaces are provisioned from a machine-local bare mirror instead of a fresh
  network clone, and provisioned dependencies are cached safely.
- Platform CLI configuration is isolated from the host's, and Pi per-message
  usage is captured into the session columns.

### Development and operations

- The help-only repository command-line interface is retired; this release no
  longer builds or ships an `agentos` binary.
- Production upgrades run in a quiet window without an operator at the keyboard.
- The offshore merge-gate worker is revived with a per-repo layout and a slot
  dispatcher, supports two slots per worker and primary-worker failover, and
  classifies docs-only changes onto a shorter profile. The gate itself runs its
  checks concurrently.
- The README is a landing page again: the evidence tables, architecture, and
  installation and verification detail moved into `docs/`, and the release
  documents that are not tied to one version lost their `v0.1.0-` filename
  prefix.

## v0.2.0 — Developer Preview 2

The second preview. The headline is the task-chain overhaul: the twelve-step
template now plans for parallelism and implements in parallel waves, its code
review runs as two independent blind paths, and the whole chain has been
exercised end-to-end on an isolated rehearsal stack before this release. As
with every 0.x minor, behaviour changes below are breaking-eligible and there
is no upgrade path between previews other than a fresh install.

### Task chain and canonical agents

- The full-assurance code review step is now a dual-path blind review: an
  independent review on the Codex side, a blind review and final adjudication
  on the Claude side, and a regression verification of the applied fixes.
  Legacy nine-step templates are preserved and pinned rather than migrated.
- The twelve-step chain prompts were rewritten end to end. Planning cuts
  tracer-bullet slices engineered for parallel execution; implementation
  schedules those slices in dependency waves, one isolated git worktree and one
  background subprocess per slice, merging serially at each wave barrier; the
  review prompts drive the native `codex exec review` harness in two passes
  with the review range declared in the prompt. Plan review now prices every
  merge and added dependency edge against the frontier width the plan was
  engineered for.
- Chain artifacts (spec, slices, session labels, review findings) live under
  `.chain/<branch>/` on the chain branch.
- The task-claim API now honours a step's `attachmentsFromPrevious=false`, so
  the blind review step really does start blind instead of receiving prior
  step outputs.
- `npm run db:sync-canonical-prompts -w @anneal/db` synchronises every
  canonical step prompt and role prompt from the repository into an existing
  installation, idempotently.
- Seeded skills are retired. The runner never injected them, so the `agents/`
  contract drops the skills pipeline entirely; skills remain an API-managed
  concept.
- The librarian role runs at a higher reasoning tier.

### Control plane and API

- Control-plane ownership recovery is hardened, and ownership tolerates device
  identity drift across restarts.
- The shared maintenance lock recovers its sessions after the lock backend is
  lost, and retains itself across connection-pool recycling.
- Onboarding validates its prerequisites, local service startup is bounded, and
  toolchain and runner identity are enforced.
- Backup quiescence attestations are validated before an existing-mode
  migration will accept them.
- The default session budget is 240 minutes.

### Web

- Agents page: archived agents move to their own tab.

### Development and operations

- The merge gate is substantially faster: independent checks overlap, isolated
  database suites run concurrently, lint workers stop oversubscribing the
  machine, and gate caches publish atomically with their integrity preserved.
- Sanitized operational harnesses are published in-repo.
- `npm run setup:local` can repair an existing local configuration safely.
- Public snapshot scanning is hardened, template release gaps are closed, and
  the v0.1.0 install guidance corrections are folded into the released docs.
- The README shows the task board and agents screens.

## v0.1.0 — Developer Preview

The first release of AgentOS: a local, single-operator control plane for handing
scoped software tasks to coding CLIs already installed on your own machine, and
for keeping what they did observable and durable. There is no earlier version, so
this entry describes the surface rather than a difference from one.

AgentOS orchestrates coding CLIs you have already installed and signed into. It
bundles no subscription, resells no capacity, never logs you into a provider and
never reads a credential store; your provider account, its plan limits and its
availability remain yours.

Supported target: macOS on Apple Silicon, Node.js `^20.19.0 || ^22.13.0 || >=24` with
npm 10.9.2 or newer, Docker with Compose, and Git. Linux is unverified. Windows
is unsupported — the runner relies on POSIX process-group, path and command
behaviour.

### Installation and first run

- `npm run setup:local` generates local configuration in one step: distinct
  random operator and runner tokens, a session-cookie secret, a 32-byte
  encryption key and one database password, written to `.env` at mode `0600`. It
  prints a class (`configuration-created`, `configuration-valid`,
  `configuration-raced`) and never a value, and it refuses to overwrite or repair
  an existing file.
- A database with no projects in it opens a five-screen installation wizard and
  nothing else. It states what it is about to create — an environment that is
  honestly open, a starter agent that runs with your own user's authority, no
  filesystem grant, a repository grant that can push — and the server refuses an
  installation whose acknowledgement of that disclosure is false.
- Installing writes the project, environment, starter agent, repository and
  access grant in one transaction, or none of them. Submitting twice creates one
  installation.
- A repository remote that embeds a password or a token is refused, in the
  browser and again on the server, from one shared policy table so the two cannot
  drift apart.
- The supported Node.js range is enforced rather than warned about, by the
  package manifest and by the configuration generator.

### Control plane and console

- A React/Vite console and a Hono API over PostgreSQL expose projects, agents and
  capabilities, tasks and task detail, task chains and approvals, runs, sessions,
  the Inbox, triggers and automations, connections, secrets, settings and an
  archive.
- The console is available in English and Chinese.
- Task state is stored separately from durable run and session-event records, so
  what happened is retained independently of what is currently queued.
- Goals are stored and editable — a goal, its definition of done, its progress log
  and its limits — but no execution model is wired to them: nothing schedules work
  from a goal, nothing measures its spend and nothing stops it on spend, time or
  stall. The console shows no spend figure and no stopped state because the server
  has no writer for either.

### Task execution and the local runner

- The runner claims queued work with a fenced lease, clones the selected
  repository into a controlled per-run workspace, and creates or resumes a
  run-specific branch.
- Provider preflight checks the configured binary, its version command and login
  status before an agent starts, so a missing or signed-out CLI is reported as
  that rather than as a failed run.
- Provider and tool events are recorded as structured records while the agent
  works; the agent logs notable progress and persists its task output.
- Runs are bounded by a wall-clock limit and a stall timeout.
- Successful workspaces are removed; a bounded number of failed ones may be kept
  for recovery according to runner configuration, and orphaned workspaces can be
  reclaimed deliberately by the operator.
- Exactly one API control plane may own a canonical workspace root, and ownership
  is acquired before the database client is imported or reconciliation begins.
  Runner daemons are ordinary clients, and any number of them may poll that one
  API.

### Coding CLI support

- **Codex CLI** — verified adapter and runtime, and the backend the starter agent
  uses. It is the only provider CLI a complete installation requires.
- **Claude Code** — verified adapter and runtime; subscription authentication is
  maintainer-verified on macOS Apple Silicon.
- **Pi** — an experimental adapter, outside the supported surface of this
  release.
- Codex and Claude receive the AgentOS session tools over a per-run stdio MCP
  server; Pi receives the corresponding task tools through an extension.

### Scheduling, triggers and human questions

- Recurring automations run tasks on a schedule, with the next fire and the
  current state shown as one status rather than inferred from several fields.
- Webhook triggers can start work from outside, authenticated by a stored secret;
  a disabled secret is reported as such rather than as a pause.
- An agent can ask a blocking human question through the Inbox and wait for the
  answer, and the operator can answer it from the console.

### Git delivery and review

- AgentOS captures the git result of a run and pushes the run branch. The run's
  "opens a pull request" setting controls whether delivery also attempts to open
  one.
- A gated task moves to review for a human decision; an ungated successful task
  can finish on its own.

### Files, grants and secrets

- No filesystem grant is created by default. Files Root mutations require a
  lease-bound per-run session token and a matching filesystem grant.
- The Files store refuses hostile path strings, does not follow symlinks when
  listing or stating, opens final paths without following links, and treats
  hardlinks as a separate escape: reads refuse a multiply-linked regular file and
  writes land on a private new inode renamed over the target.
- Stored secrets are encrypted with AES-256-GCM; neither plaintext nor ciphertext
  appears in the API's secret representations. Per-run credentials are written at
  mode `0600` inside the throwaway workspace and are excluded from git locally.
- Child processes receive an explicit environment — configured `PATH`/`HOME`, run
  identity, session credentials and granted secrets — rather than a copy of the
  host environment.

### Security posture

- The API refuses to start on anything but the loopback interface; the database
  service publishes on loopback only; the console's dev/preview server decides per
  request that the caller is its own loopback origin before attaching the
  operator's authority.
- Operator, runner and per-run session principals are separate, with independently
  scoped routes and session tokens that expire or are revoked with the run.
- Runner-authenticated run-state writes, and the session event, activity, output,
  Inbox and completion paths, are checked against the run's fencing generation; a
  stale or expired generation is rejected and the runner terminates the provider's
  process group.
- There is deliberately no credential in the browser bundle: a token-shaped
  `VITE_*` key is a startup refusal, and a hygiene scan checks the built bundle
  for token variables, bearer headers and this checkout's own generated values.

### Database and migrations

- PostgreSQL through Prisma, with the schema and its migration history in the
  repository.
- Two commands change a schema and they are not alternatives. `npm run db:migrate`
  is `prisma migrate dev`: development only, no preflight, and it will rewrite
  history. `npm run db:migrate:release` is the release path and the only
  supported migration command: it proves the target is this checkout's own
  database, proves the target is empty in fresh mode, proves the migration set is
  the recorded release candidate, and only then runs the migration through
  `npm run db:migrate-goal-execution`, which is exactly
  `db:preflight-goal-execution && prisma migrate deploy`.
- Refusals print stable, machine-readable lines — `STOP release-migrate
  <condition>: <reason>` — carrying no URL, password, database name, container id,
  path or raw subprocess output.
- The release path recognises `--force`, `--skip-preflight` and `--no-preflight`
  only in order to refuse them by name.

### Release and supply-chain safety

- The public snapshot is closed by default: a manifest names what may be
  published, repository-wide deny rules keep private, generated and installed
  path classes out, and every remaining tracked file must be classified — a file
  nobody has looked at is a scan failure, not a silent inclusion.
- The snapshot scan reads the tracked worktree, requires it to match `HEAD`, and
  fails closed on a dirty tree rather than attributing changes to the reported
  commit. It looks for credentials, personal data, private absolute paths and
  internal-only material.
- The migration preflight refuses to run without evidence that the migration set
  passed review. A published snapshot can carry that evidence as a signed
  attestation verified against a public key the repository tracks; an absent
  attestation refuses rather than defaulting to trusted.

### Verification

- `npm test` runs every workspace's unit tests and needs no database and no
  running service; it does need a build first, because one CSS regression test
  reads the built stylesheet.
- `npm run test:db` is separate on purpose. It runs the API's database tests
  against a PostgreSQL the caller supplies, on a scratch database — never one
  holding anything you want to keep. Several files run at once, each against a
  database of its own, cloned from one migrated template; the per-file databases
  are opt-in, the concurrency is configurable, every controlled exit drops what it
  created, a database that cannot be dropped fails the run, and a run killed
  outright leaves databases that the next run reclaims by name.
- A single merge gate is this repository's only CI, and it runs, in order: the
  append-only check on frozen records and that checker's own fixtures, a clean
  `npm ci`, the database client generation, typecheck and lint across every
  workspace, the build, every workspace's unit tests, the gate schema's
  migration, the database package's preflight tests, the API's database tests,
  and a final check that the commit it gated is the commit it started from. It
  does not run the snapshot scan, the dependency gate or the Compose validation;
  those are in the verification list a developer runs, and
  this entry does not promise a gate that has them.

### Known limitations

- **Not a sandbox.** The provider adapters launch the coding CLI with
  non-interactive permission-bypass flags. With the shipped same-user default the
  agent runs with your own user's authority; AgentOS grants constrain AgentOS's
  own APIs and give an audit trail, but they are not operating-system
  containment.
- **No enforced network isolation.** The environment a fresh installation creates
  is labelled open because it is.
- **Loopback only.** There is no remote authentication design — no login, no
  per-user identity, no session model for anyone but the machine's own operator.
  A tunnel or reverse proxy does not add one, and exposing any of it is
  unsupported.
- **The repository access level does not gate delivery's push.** A repository
  access row is required when a task is created and claimed, but its read/write
  level is not what decides whether the branch is pushed. Treat any repository you
  register as writable by the agent.
- **The Files path walk can be raced** by an adversary who can already write
  inside the Files Root: an intermediate directory can be swapped after the walk
  has checked it and before the open. Closing it needs a native helper; until then
  the backstop is deployment, and the API refuses to boot when the Files Root
  overlaps the run workspace root.
- **Runner separation is partial.** Running the CLI under a dedicated account
  separates runners from each other; one runner's account still owns every
  workspace it has created.
- **Migrating an existing installation is not supported.** `--existing` stops at
  `oss-d-interface-unavailable`: the verified-backup attestation producer its
  safety story rests on has not merged, and a command that validated a bundle no
  producer creates would look guarded without being it. Fresh mode is the
  supported path; its one precondition is the preflight's `authority` evidence,
  which a release clone carries as `release-authority.pub` and
  `release-authority.json`. These are refusals of a real command, and the fix is
  not to take the preflight out of the path.
- **The unguarded migration bypass is procedural, not closed.** Nothing prevents
  running `prisma migrate dev` or `prisma migrate deploy` against a database by
  hand, with no preflight.
- **No down migration, no supported restore.** Rolling back code does not roll
  back the database, and restoring over a database something is still using is not
  a supported operation of this release.
- **No secret rotation command.** Replacing generated values is a deliberate human
  recovery; rotating the secret encryption key while encrypted rows exist destroys
  them unrecoverably.
- **No upgrade path between preview builds** other than a fresh install. Nothing
  is packaged, notarized or self-updating.
- **Goals have no execution model**, as described above.
- **The v0.1.0 command-line interface was help-only.** The tagged v0.2.0 release
  retained it; current main retires it for the next minor release.
- **Five surfaces merged without an independent implementation review.** Four —
  the control plane's workspace ownership change, the public snapshot mechanism,
  the templates release closure, and the documentation factual-accuracy pass —
  were reviewed as plans but not as written code, and the verified-backup
  attestation producer was not reviewed at all. The gap is recorded rather than
  closed; the reviews happen after the cutover and any finding lands as
  `v0.1.1`. [`docs/release/v0.1.0-release-notes.md`](docs/release/v0.1.0-release-notes.md)
  names each surface.
- **The release snapshot was assembled by hand.** The deterministic builder and
  provenance manifest the plan calls for are deferred to `v0.1.1`; reproducibility
  for this release is evidenced by two independent builds agreeing on one commit
  id and by independent recomputation of the tree hash.
  [`docs/release/v0.1.0-release-notes.md`](docs/release/v0.1.0-release-notes.md)
  states what was and was not done.
- **The release verification harness is mostly unbuilt.** One of the 25
  `verify:oss-f0` checks is implemented; the rest refuse rather than pass, and the
  release steps they were written to close were closed with direct evidence
  recorded at the exact commit. Deferred to `v0.1.1`.
- **Some published files reference paths the snapshot holds back**, including
  four `package.json` scripts that fail when run from a clone. Deferred to
  `v0.1.1`.
  [`docs/release/v0.1.0-release-notes.md`](docs/release/v0.1.0-release-notes.md)
  says which.
