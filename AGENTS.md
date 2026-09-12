# Repository instructions

Keep host configuration, credentials, and private operator procedures outside
this repository. Read "Everyone", then the section for your environment:
`AGENTOS_RUN_ID` set means an Anneal run; otherwise use "In a host window".

## Everyone

- Before writing specs, plans, reviews, or documentation, read [the domain glossary](CONTEXT.md) and use its vocabulary.
- Before proposing, specifying, or reviewing a design change, use the
  [out-of-scope index](docs/out-of-scope/README.md) and
  [ADR index](docs/adr/README.md) to find and read the relevant decisions,
  following their current cross-references. A proposal that contradicts an
  entry must cite it and argue its revisit condition.
- Use the simplest design that meets current requirements. Add abstractions,
  configuration, or compatibility only for a current criterion or caller.
- Run affected workspace checks (`npm run <script> -w <workspace>`) and relevant
  named checks, including root-defined checks. The merge gate owns whole-repo
  verification aggregates and whole database suites; never run them independently.
  Runs have no scratch PostgreSQL: do not attempt `test:db` inside a Run or
  report its absence as a gap; it is merge gate evidence.
- Before tests outside the merge gate, set `RUNNER_WORKSPACE_ROOT` to a new
  temporary directory; also pin `home` in hand-built `RunnerConfig` objects to
  one. Runner tests provision real workspaces and repository mirrors.
- Tests spawning the real API entrypoint use
  `packages/api/src/test-startup-environment.ts` to pin credentials from the test
  URL; otherwise dotenv can restore omitted credentials from the root `.env`.
- Before changing canonical Agents, roles, or task templates, read
  [agents/README.md](agents/README.md) and its contracts defining canonical defaults.
- Update the [operator API handbook](docs/operator-api.md) in the same change
  when adding, removing, or changing an HTTP route.

## Inside an Anneal run

Work in your exclusive checkout on its chain branch. Any additional worktree
stays inside your run workspace. Commit; the platform owns push, PR creation,
Regression, and merge.

Never run `scripts/merge-gate.sh`, scripts under `scripts/gate-worker/` or
`packages/runner/runtime-tools/gate-worker/`, or repository-wide verification
aggregates inside a Run. Gate-worker scripts have no Run refusal; this rule is
the guardrail. Regression runs the gate on its worker. Never operate on a
production or appliance checkout.

## In a host window

- Work in this session by default; create or dispatch task chains only on the
  human's explicit request. Before doing so, read
  [task routing](docs/governance/task-routing-v1.md) for tier, brief, assignee,
  sequencing, and backlog lifecycle. Qualify dependencies there before each
  instantiation.
- Before database bootstrap, testing, or delivery, read the relevant section of
  [CONTRIBUTING.md](CONTRIBUTING.md), including gate, lease, PR timing, and
  isolation rules. Never switch branches or commit feature work in the shared
  checkout; use your own branch in an isolated worktree and remove it after merge.
- Before changing deployment directories, runtime artifacts, or service config,
  read the [deployment runbook](docs/runbooks/quiet-window-auto-deploy.md) and
  follow its ownership and activation contract. Develop in a separate clone or
  worktree.

## Editing these instructions

Keep routing and guardrails here, with trigger-first pointers to detailed rules
in their authoritative documents. Read live config, `package.json`, the tree,
and tool help instead of caching them here. Remove obsolete pointers when their
replacements land.

Every runnable command is an instruction to its section's readers. Commands in
"Everyone" and "Inside an Anneal run" must be Run-safe; put host-workflow commands
in host-facing documents linked from "In a host window".
