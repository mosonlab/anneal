<div align="center">

# Anneal

**You write the specs. It clears the board.**

Anneal runs chains of coding agents on your own machine. Queue tasks on
the board, and each one is planned, reviewed, implemented, verified and
merged unattended, on the Codex and Claude subscriptions you are
already signed in to.

[![status](https://img.shields.io/badge/status-developer%20preview-orange)](#status)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon%20%7C%20Linux-lightgrey)](#status)
[![node](https://img.shields.io/badge/node-22.17.0-brightgreen)](.nvmrc)

[Install](#quick-start) · [How it works](#how-it-works) · [Status](#status) · [简体中文](README.zh-CN.md)

<img src="docs/media/parallel-tasks.gif" alt="Multiple tasks running in parallel across the board" width="880">

<sub>Live capture: Anneal clearing its own task board. This repository is built by Anneal itself.</sub>

</div>

## The workflow it is built for

You do one thing: write specs. You queue them on the board, Anneal
breaks them down and orchestrates the work, and you walk away. A
chain picks up each task and takes it the whole way through plan, plan
review, implementation, two independent code reviews, fix application,
regression verification, and the merge itself. When you come back, the
board is clear: you read the pull requests that matter, open an agent
window on the ones you care about, and iterate until you are satisfied.

In between, nothing needs you. A chain only stops when a human
decision is needed: an agent asks a question through the web Inbox, a
step you marked as gated waits for your call, or a run escalates. Once
you answer in the Inbox, the board moves on.

## What you get

- **Spec in, merge out.** A task card becomes a branch, a pull request
  and a merge behind the merge gate. Every intermediate artifact (plan,
  review findings, fix dispositions, regression results) is recorded on
  your machine, so you can trace any chain step by step afterwards.
- **Nothing merges on faith.** Two blind code reviews, an independent
  regression run, and a merge gate stand between an agent's diff and
  your main branch.
- **Parallel by default.** Chains for different projects, repositories
  and tasks run at the same time. Concurrency is bounded by your
  machine's resources and your subscription's rate limits; registering
  more runners raises throughput.
- **Your subscriptions, no keys.** Anneal launches the official Codex
  CLI, Claude Code and Pi you have already installed and signed in to.
  It holds no credential of its own, runs no proxy, and there is no key
  to paste in.

## Anneal is built with Anneal

The pull requests in this repository are specified, planned, reviewed,
implemented and merged by Anneal's own chains, running on one local
machine.
Chain-delivered commits carry `Co-Authored-By: Anneal Chain` and
`X-Anneal-Run` / `X-Anneal-Step` trailers, so you can check in the git
log which commits the chains produced.

## How it works

A chain instantiates a template of steps. Each step binds an agent
role: a prompt, a model, a reasoning effort and the runner CLI it
executes on. The flagship Full Assurance template covers delivery in
twelve steps.

The template is data, not code. Roles, prompts, models and gates are
all editable, so you can define your own agent roles and reshape the
chain into a workflow for your own team of agents.

<div align="center">

<img src="docs/media/agents.png" alt="Agents view: each agent's role, model, reasoning effort and runner" width="880">

<sub>Agents: a role, a prompt, a model and effort, and the runner it goes to.</sub>

</div>

<details>
<summary><b>The twelve steps in full</b>: role, runner, model and effort for each</summary>

An agent's title names the role only — Planner, Code Reviewer, Senior Dev — while
its slug spells out `role-model-effort`, so two agents that do the same job on
different models stay distinguishable at a glance.

| # | Step | Agent role | What it does | Runner | Model · effort |
| --- | --- | --- | --- | --- | --- |
| 1 | Write a spec | `spec-opus-high` | Turns the task into the specification of record | Claude | Claude Opus 5 · high |
| 2 | Plan | `plan-fable-medium` | Cuts the spec into parallel vertical tracer-bullet slices | Claude | Claude Fable 5 · medium |
| 3 | Plan review | `review-coordinator-astra-medium` | Reviews every slice against the spec and the frozen base | Codex | GPT-6 Astra · medium |
| 4 | Revise plan | `plan-reviser-opus-medium` | Edits the slice set against the findings, in a fresh session | Claude | Claude Opus 5 · medium |
| 5 | Implementation | `plan-executor-astra-low` | Executes the slice set from the live dependency frontier and opens the pull request | Codex | GPT-6 Astra · low, with GPT-5.6 Luna · max subagents |
| 6 | Code review | `code-reviewer-sol-high` | Reviews the integrated diff at the pinned base and head | Codex | GPT-5.6 Sol · high |
| 7 | Blind code review | `code-reviewer-opus-medium` | Reviews the same diff again, blind to step 6's findings | Claude | Claude Opus 5 · medium |
| 8 | Apply review fixes | `senior-dev-astra-low` | Dispositions every finding from both reviews and applies the adopted ones | Codex | GPT-6 Astra · low |
| 9 | Documentation | `librarian-luna-xhigh` | Updates internal documentation to match the delivered code | Codex | GPT-5.6 Luna · xhigh |
| 10 | Regression verification | `regression-verifier-luna-max` | Refreshes onto the target branch and reruns the regressions | Codex | GPT-5.6 Luna · max |
| 11 | Merge readiness | — | Recomputes the head, requires head-bound regression PASS evidence and a server-side ancestry check, emits an exact-head authorization | — | mechanical, no model run |
| 12 | Merge execution | `merge-integrator` | Re-verifies every precondition against the live pull request, then merges | — | mechanical, no model run |

</details>

<div align="center">

<img src="docs/media/chain.png" alt="Task detail: a completed twelve-step chain with each step's role and status, the run cost, and the merge-tail repair timeline" width="880">

<sub>A finished chain: twelve steps done, including four autonomous
merge-tail repairs during regression verification.</sub>

</div>

The design rule behind the steps: whoever wrote the code never judges
it. Authorship, review and verification run in separate sessions, the
two code reviews cannot see each other's findings, and step 8
adjudicates both. Each session starts clean, with a purpose-built
prompt and an environment the runner constructs itself: your global
agent config and skills never leak in as noise. Role bindings live in
[`agents/templates/compound-engineer-workflow/`](agents/templates/compound-engineer-workflow);
board column semantics in the
[task-routing contract](docs/governance/task-routing-v1.md).

## Quick start

The verified release path needs:

- an Apple Silicon Mac or a Linux machine (Ubuntu 24.04 LTS verified)
- Node.js satisfying `^20.19.0 || ^22.13.0 || >=24`; use `22.17.0` from
  `.nvmrc`, with npm 10.9.2+
- Docker Compose and Git
- the official Codex CLI signed in under the account that runs the runner
  (Claude Code and Pi optional)

macOS on Intel is expected to work but is not yet release-verified;
Windows is unsupported.

```sh
git clone https://github.com/mosonlab/anneal.git
cd anneal
git checkout v0.8.0
npm ci
npm run setup:local
npm run build
docker compose up -d --wait --wait-timeout 60 postgres
npm run db:migrate:release -- --fresh
```

Then start `npm run dev:api`, `npm run dev:runner` and `npm run dev:web`
in three terminals, in that order, and open `http://127.0.0.1:5173`.
The full sequence with its preflights is in
[`docs/release/developer-preview.md`](docs/release/developer-preview.md).

## Status

Developer Preview 8 (v0.8.0): interfaces and stored data shapes may
change between previews, and the only upgrade path is a fresh install.
The verified targets are macOS on Apple Silicon and Linux (Ubuntu 24.04 LTS,
x86_64). macOS on Intel is expected to work but is not yet release-verified;
Windows is unsupported.

For the pull-request workflow, follow [Add a project](docs/runbooks/add-a-project.md).

**Read before pointing this at anything you care about:** Anneal
launches coding CLIs with non-interactive permission bypass, as your
own user account, outside a sandbox. Use a disposable repository and a
machine you are willing to let an agent modify. Details in
[`docs/release/security.md`](docs/release/security.md).

Provider CLIs, their authentication and their plan terms stay between
you and the provider; the authoritative support statement is
[`docs/release/support-matrix.md`](docs/release/support-matrix.md).

## Documentation

[Architecture](docs/architecture.md) ·
[Install](docs/install.md) ·
[Security](docs/release/security.md) ·
[Migration and recovery](docs/release/migration-and-recovery.md) ·
[Release notes](docs/release/v0.8.0-release-notes.md) ·
[Contributing](CONTRIBUTING.md) ·
[Support](SECURITY.md)

## Credits and license

Five skills from
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT,
Copyright (c) 2026 Matt Pocock) supply working text for the chain's
prompts; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). This
snapshot is licensed under the [MIT License](LICENSE), with its
boundary defined by [`public-snapshot.json`](public-snapshot.json).

Community link: [LINUX DO](https://linux.do/) — sincere, friendly,
united, and professional.
