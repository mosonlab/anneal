# Architecture and security model


## Runtime shape

```text
Web console
          |
          v
Control-plane API  <---->  PostgreSQL
          ^                    tasks, runs, leases,
          |                    events, grants, outputs
          |
Local runner -----> ephemeral git workspace
          |
          +----> Codex CLI / Claude Code / Pi
                         |
                         +----> Anneal session tools (MCP or Pi extension)
```

- The React/Vite web console and Hono API expose projects, agents, capabilities,
  tasks, chains, approvals, runs, sessions, and the Inbox workflow.
- PostgreSQL, accessed through Prisma, stores task state separately from durable
  Run and SessionEvent records.
- The local runner claims work with a fenced lease, clones the selected
  repository into a controlled per-run workspace, creates or resumes the run
  branch, preflights the selected CLI, and records structured provider events.
  Those events are buffered in memory and delivered independently of lease
  renewal, so the buffer is bounded: see the event caps below.
- Codex and Claude receive the Anneal session tools over a per-run stdio MCP
  server. Pi receives the corresponding task tools through an extension.
- Anneal does not ship a repository command-line interface. Operators use the
  web console and the documented service, database, and runner scripts.

## A real task workflow

1. The operator creates a project, registers a repository, defines an agent,
   and grants the repository access, Files Root access, and secrets needed by
   the current runtime. Skill, custom-MCP, and collaborator bindings can also
   be stored as control-plane configuration, but they are not currently sent to
   the runner as runtime grants.
2. The operator creates a task directly or from a task-chain template and
   selects the Codex, Claude, or Pi path.
3. The runner claims the queued Run with a lease and fencing generation, then
   provisions an ephemeral clone and a run-specific git branch.
4. Provider preflight checks the configured binary, version command, and login
   status before the agent starts.
5. The agent works in the clone, streams provider and tool events, logs notable
   progress, can ask a blocking human question through the Inbox, and persists
   its task output.
6. Anneal captures the git result and pushes the run branch. A repository-access
   row is required when the task is created and claimed, but its read/write
   level does not currently gate that push. The Run's `opensPullRequest` setting
   controls whether delivery also attempts to open a pull request. A gated task
   moves to review for a human decision; an ungated successful task can finish.

## Security defaults and limits

- Operator, runner, and per-run session principals are separate. Runner routes
  and session routes are scoped independently, and session tokens expire or are
  revoked with the Run.
- Runner-authenticated run-state writes and the session event, activity, output,
  Inbox, and completion paths are checked against the Run's fencing generation;
  stale or expired generations are rejected, and the runner terminates the
  provider process group. Files Root mutations instead require a lease-bound
  per-run session token and matching Filesystem Grant; their requests carry no
  client fencing field.
- Child processes receive an explicit environment containing configured
  `PATH`/`HOME`, Run identity, session credentials, and granted secrets; the
  runner does not copy the host environment wholesale.
- Runner proxying is opt-in through `RUNNER_HTTP_PROXY`, `RUNNER_HTTPS_PROXY`,
  and `RUNNER_NO_PROXY`. When configured, it applies to the whole
  runner-controlled network path: Claude, Codex, Pi,
  and Git/workspace provisioning and delivery commands. Conventional host proxy
  variables are ignored. A `RUNNER_RUN_AS_PREFIX` launcher must preserve the
  explicit environment; proxy URLs are not serialized into provider argv.
- Session events are bounded end to end. The runner holds at most 32 MiB and
  20 000 undelivered events per Run, truncates any single payload above 256 KiB
  to a `truncated` marker carrying its original size, and forms batches of at
  most 250 events or 1 MiB. The API enforces the same per-event cap and reads at
  most the batch cap plus envelope overhead of request body, refusing more with
  413. Because event delivery is detached from lease renewal, a Run whose event
  writes keep failing stays leased and keeps producing events; without the bound
  the runner grows until the host runs out of memory, sooner with several
  runners on it. Bounding means choosing what to lose: liveness detail
  (streaming deltas, raw provider frames, captured stderr) is dropped
  oldest-first, lifecycle, tool, error and terminal events never are, and every
  drop or truncation is itself recorded as an event. A 413 the API raises names
  the one offending event, so the runner loses that event rather than wedging an
  ordered queue that only advances on success. Both caps are declared once, in
  `@anneal/db/session-event-limits`.
- Exactly one API control plane may own a canonical workspace root. Ownership is
  acquired from the protected, API-only `CONTROL_PLANE_STATE_DIR` before Prisma
  is imported or reconciliation begins. Runner daemons remain ordinary clients,
  and any number of them may poll that one API. Successful workspaces are
  removed. A bounded number of failed workspaces may be retained for recovery
  according to runner configuration.

[`docs/release/security.md`](release/security.md) owns the release security
boundaries and limitations.
