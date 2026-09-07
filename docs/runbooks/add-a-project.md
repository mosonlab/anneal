# Runbook — add a project and open a pull request

This runbook covers the pull-request workflow that A1 installs. It stops at an
open pull request: the operator reviews and merges that pull request by hand.
It does not provision another workflow, create a Secret, or perform an
automatic merge.

This is the canonical onboarding page for both tiers. Tier 0 creates a Project
and opens a pull request. Tier 1 completes the canonical inventory and
full-tail readiness needed by Direct and Full Assurance workflows.

## Tier 0 checklist

Complete these steps to add a project and open its first pull request:

- [ ] Prepare the API operator credentials, GitHub remote, Git identity, and
  provider CLIs described below.
- [ ] Create the Project with `POST /projects`.
- [ ] Add its repository with `POST /projects/:id/repos` and
  `grantAgents: true`.
- [ ] Select `pr-engineer-workflow`, instantiate it for the repository and
  branch, and start the chain.
- [ ] Review the resulting pull request and merge it by hand in GitHub.

### Prerequisites

Before calling the API, have all of the following ready:

- a supported GitHub remote for the repository you want Anneal to change;
- the GitHub CLI (`gh`) installed and authenticated under the account running
  the API; check it with `gh auth status`;
- the Codex, Pi, and Claude Code runtimes installed and authenticated. A1's
  four pull-request roles use those runtimes, so all three must be available
  even though a particular run may not exercise every provider on one host;
- the API's operator bearer in `OPERATOR_TOKEN`, and `jq` for extracting the
  ids returned by the API; and
- a Git identity and GitHub Git transport available to the API host. For a
  GitHub HTTPS remote, `gh auth setup-git` configures the authenticated Git
  helper used by the repository preflight. Under the same account and `HOME`
  used by the API preflight, confirm the global identity with
  `git config --global --get user.name` and
  `git config --global --get user.email`.

Set the local values for the commands below. Keep the remote exactly as a
supported GitHub URL; the Repo route validates the raw value and runs its
preflight before it writes anything.

```sh
export BASE_URL=http://127.0.0.1:3000
export PROJECT_NAME="Demo project"
export PROJECT_SLUG=demo-project
export REPO_NAME=demo
export REPO_REMOTE=https://github.com/acme/demo.git
export BRANCH_NAME=feature/demo
export CHAIN_NAME="Demo: open the first pull request"
```

## Create the Project

Call `POST /projects` with a name and lowercase hyphenated slug. A1 creates
the Project in one bootstrap operation with its `local` Environment, the four
workflow Agents `senior-dev-luna-max`, `code-reviewer-sol-high`,
`code-reviewer-opus-medium`, and `senior-dev-astra-low`, and the canonical
`pr-engineer-workflow` TaskTemplate.

```sh
PROJECT_BODY=$(jq -n \
  --arg name "$PROJECT_NAME" \
  --arg slug "$PROJECT_SLUG" \
  '{"name":$name,"slug":$slug}')
PROJECT_JSON=$(curl --fail-with-body -sS -X POST "$BASE_URL/projects" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PROJECT_BODY")
PROJECT_ID=$(printf '%s' "$PROJECT_JSON" | jq -r '.id')
test -n "$PROJECT_ID" -a "$PROJECT_ID" != null
```

If the slug is already used, choose another slug and repeat the Project
request. Do not retry with a different spelling of the same existing Project.

## Add the repository and grants

Add the GitHub repository with `grantAgents: true`. The successful response is
`{ repo, grants }`; the four active A1 workflow Agents receive `GIT_WRITE`
access, and the mechanical integrator Agent is not granted access. That
exclusion describes the A1 four-role workflow only. Direct and Full Assurance
templates run a `merge-integrator` step against the repository and do need the
grant; Tier 1 adds it below.

```sh
REPO_BODY=$(jq -n \
  --arg name "$REPO_NAME" \
  --arg remoteUrl "$REPO_REMOTE" \
  '{"name":$name,"remoteUrl":$remoteUrl,"defaultBranch":"main","dependencyProvisioning":"NPM_CI","grantAgents":true}')
REPO_JSON=$(curl --fail-with-body -sS -X POST "$BASE_URL/projects/$PROJECT_ID/repos" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REPO_BODY")
REPO_ID=$(printf '%s' "$REPO_JSON" | jq -r '.repo.id')
test -n "$REPO_ID" -a "$REPO_ID" != null
```

Choose `NPM_CI` only for repositories whose default branch has a root `package-lock.json`; otherwise choose `NONE`.

`defaultBranch` is the branch a chain starts from, and nothing later reconciles
it with the remote. Read the remote's actual HEAD branch before you send the
request rather than assuming `main`:

```sh
git ls-remote --symref "$REPO_REMOTE" HEAD | sed -n 's#^ref: refs/heads/##p'
```

A registered branch the remote does not carry is accepted here and fails much
later, when the first Run tries to start from a branch that does not exist.
Rename the remote branch or register the name the remote actually has.

If the response was not saved, obtain the created Repo id from the Project's
Repo list:

```sh
REPO_ID=$(curl --fail-with-body -sS -X GET "$BASE_URL/projects/$PROJECT_ID/repos" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  | jq -r --arg name "$REPO_NAME" '.[] | select(.name == $name) | .id' | tail -n 1)
```

The preflight uses the API host's ambient Git identity and credentials. It
does not read or decrypt a Secret supplied as `credentialSecretId`; configure
the host's GitHub transport before this call if the remote requires it.

## Instantiate A1's template

Fetch the Project's templates and select the canonical `pr-engineer-workflow`
id. The template declares the `branchName` variable.

```sh
TEMPLATE_ID=$(curl --fail-with-body -sS -X GET "$BASE_URL/projects/$PROJECT_ID/task-templates" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  | jq -r '.[] | select(.name == "pr-engineer-workflow") | .id')
test -n "$TEMPLATE_ID" -a "$TEMPLATE_ID" != null
```

Instantiate it with the created Repo and the branch to change. Choose
`CHAIN_NAME` as the operator-facing title for this chain: it must be one line
of at most 120 characters. `autoStart: true` queues the first step so the
pull-request workflow begins immediately.

```sh
INSTANTIATE_BODY=$(jq -n \
  --arg repoId "$REPO_ID" \
  --arg branchName "$BRANCH_NAME" \
  --arg name "$CHAIN_NAME" \
  '{"repoId":$repoId,"variables":{"branchName":$branchName},"name":$name,"autoStart":true}')
curl --fail-with-body -sS -X POST \
  "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/instantiate" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$INSTANTIATE_BODY"
```

The response contains the chain and task ids. Follow the task's pull-request
link (or inspect it with `gh`) after the four A1 roles finish:

```sh
gh auth status
GH_REPO=$(gh repo view "$REPO_REMOTE" --json nameWithOwner --jq '.nameWithOwner')
gh pr list --repo "$GH_REPO" --head "$BRANCH_NAME"
```

Review the resulting pull request, its checks, and its diff. Merge it by hand
in GitHub only after you are satisfied; this runbook does not invoke an
automatic merge.

## Tier 1 checklist

Complete these steps before starting a Direct or Full Assurance workflow:

- [ ] Run one `pr-engineer-workflow` chain end to end on this repository first,
  and only then install the full inventory.
- [ ] Run project-scoped canonical installation with
  `npm run db:sync-canonical-prompts -- --install-full <projectId>` when the
  Project needs the full post-A1 inventory.
- [ ] Run project-scoped verification with
  `npm run db:verify-agent-template -- --project <projectId>`.
- [ ] Confirm that the Project has an in-Project Repo and that every effective
  template assignee has an `AgentRepoAccess` grant for that Repo.
- [ ] Put exactly one target-repository Tier 1 file in the repository:
  `scripts/merge-gate.sh`.
- [ ] Provide the required model CLIs for the selected roles and their
  runner-host authentication, plus an authenticated `gh`.
- [ ] Provide `GITHUB_READ_TOKEN`, `RUNNER_GATE_SERVER`, and the target
  repository's test toolchain, with an SSH-reachable gate worker.
- [ ] Verify that test toolchain on every gate worker the dispatcher may
  select, not only on one of them.
- [ ] Install the private merge-executor GitHub App on the target repository
  and run its isolated executor service.
- [ ] Treat Node on the runner and the gate-worker test toolchain as documented
  prerequisites, not probes; provision them before starting a chain.
- [ ] Confirm that Regression, not an in-Run agent, executes the gate.

### Probe with A1 before installing the full inventory

The Tier 0 workflow is the cheapest end-to-end proof that this Project, this
Repo, and this host can carry a chain at all: it exercises the remote, the Git
identity, the branch registration, and the runtime authentication without any
of the full tail's infrastructure. Run it once and let it reach an open pull
request before `--install-full`.

Installing the full inventory first only moves the same failures later, into a
longer chain with more roles and a gate to pay for.

### Canonical synchronization and verification

The files under [`agents/`](../../agents/) are the source of truth for
canonical Agent and template prompts. Synchronization uses one all-or-none
transaction per Project. It visits the canonical Project first, then every
other Project in slug order:

```sh
npm run db:sync-canonical-prompts
```

An ordinary sync visits every Project. It restores prompts and validates
canonical-named Agents and template rows that a Project already holds. A
partial inventory is valid outside `agentos-example`; absent canonical Agents
and templates are left absent. `agentos-example` remains the canonical Project
and its complete template inventory is restored when a canonical row is
missing.

A refusal in `agentos-example` is fatal and prevents every other Project from
being attempted. A refusal in another Project rolls back only that Project,
prints `REFUSED <slug>: <reason>`, and continues; successfully synchronized
Projects keep their commits and print their counters.

`--install-full` fills only missing canonical Agents and templates in the
addressed Project. An unknown Project id is refused before the transaction;
the addressed Project must have exactly one Environment, and an archived
same-name Agent is refused. It never resurrects or overwrites an existing
object and it creates no Repo, `AgentRepoAccess`, `AgentSecretGrant`, or
other grant. The ordinary synchronization and the installation share the
addressed Project's transaction. If the explicitly requested Project refuses,
`--install-full` exits non-zero; Projects committed before that refusal remain
committed. A second successful installation is a no-op.

Because it creates no grant, every Agent the newly installed templates assign
needs an `AgentRepoAccess` row added by hand, including the `merge-integrator`
step that Direct and compound templates carry. Instantiation refuses a template
whose assignee lacks one with `template_agent_repo_grant_missing` and HTTP 400.
Grant each of them with
[`POST /agents/:agentId/repos/:repoId/access`](../operator-api.md#post-agentsagentidreposrepoidaccess),
then re-read the Project's templates and confirm that every effective assignee
is covered.

Project-scoped verification checks exactly the canonical Agents and templates
that are present and ignores absent and noncanonical inventory. With no
`--project`, verification retains its complete `agentos-example` inventory
requirement and its special Full Assurance and Direct checks.

### Full-tail readiness — three categories

Full-tail readiness is a contract between the repository, the control plane,
and operator infrastructure. Keep these three categories separate; all three
must be satisfied before a Direct or Full Assurance tail can rely on its
mechanical checks.

#### 1. Repository files (repository contract)

The target repository carries exactly one repository-owned Tier 1 file,
`scripts/merge-gate.sh`. The runner supplies the Regression verification
tooling; the target file follows the standalone reference contract below.
For Python gates, the excerpt recognizes pytest `FAILED` and `ERROR` lines
with `.py::` node IDs, assertion-detail lines beginning `E   `, and repository
verdict lines such as `PYTEST-REGRESSION: UNMET`; the gate does not need to emit
TAP.

#### 2. Control-plane prerequisites

The target Project must have an in-Project Repo. Every effective template
assignee must have an `AgentRepoAccess` row for that Repo; synchronization
does not create the Repo or grants for you.

#### 3. Operator infrastructure

The operator supplies the required model CLIs for the selected roles and their
runner-host authentication, an authenticated `gh`, `GITHUB_READ_TOKEN`, an
SSH-reachable gate worker selected through `RUNNER_GATE_SERVER`, and the
target repository's test toolchain.
The private merge-executor GitHub App installed on the target repository with
its isolated executor service is required.
Provider authentication is runner-host infrastructure: it is not an
`AgentSecretGrant`, and `AgentSecretGrant` is not a full-tail readiness
prerequisite.

Node on the runner and the gate-worker test toolchain are documented prerequisites, not probes.
Regression, not an in-Run agent, executes the gate.
A missing prerequisite stops the chain rather than authorizing a weaker merge.

A repository whose gate does not run on Node needs that repository's own
toolchain present on every worker the dispatcher may select, and it needs the
same versions on each of them. Verify it the way the gate will see it — one
non-interactive command per worker, over `ssh`, not in a login shell you
prepared by hand:

```sh
ssh <worker> '<interpreter> --version && <test-runner> --version'
```

Two workers running different versions of the same test runner are not one
environment: a version that reports results the other does not changes the test
identifiers a baseline matches against, so the same commit can pass on one
worker and fail on the other. Pin the versions in the target repository — a
`requirements-gate.txt` beside `scripts/merge-gate.sh` for a Python repository —
so the pin is reviewable with the gate it serves rather than living in an
operator's shell history.

### Reference merge-gate contract

The target repository's sole Tier 1 file, `scripts/merge-gate.sh`, is a Bash
implementation of the [standalone reference](../repo-contract/merge-gate.sh).
Replace only the body of the clearly marked `run_repository_tests`
repository-specific test-command function with that repository's test command.
Keep the argument parsing, preconditions, verdicts, and signal handling from
the reference unchanged. The dispatcher supplies both OIDs, so a target gate
does not invent or infer its authoritative baseline.

The reference accepts `--expect-head <full-oid>` and `--master <full-oid>`.
It rejects malformed or incomplete usage with exit status 2 and prints no
verdict. Before the test command it verifies a clean worktree, that HEAD is
exactly the expected full OID, and that the stated master exists and is an
ancestor. It repeats the clean-worktree and exact-HEAD checks after the command
so a command cannot pass after changing the checkout.

The public, color-insensitive final-line wire format is:

| Result | Final line | Status |
| --- | --- | ---: |
| Both OID pins stated and the test command passes | `MERGE GATE: PASS <oid>` | 0 |
| A command or precondition fails | `MERGE GATE: FAIL (<reason>)` | 1 |
| A manual pass omits `--master` | `MERGE GATE: NOT AUTHORITATIVE (master not stated)` | 3 |
| A run is refused inside Anneal | `GATE NOT RUN: refused inside Anneal run <id>` | 76 |
| SIGINT interrupts the gate | `GATE NOT RUN: <reason>` | 130 |
| SIGTERM interrupts the gate | `GATE NOT RUN: <reason>` | 143 |

The Anneal-run refusal happens before `run_repository_tests`. A passing manual
run without `--master` is never authoritative. Every completed run emits the
corresponding line as its final line; ANSI color does not change its meaning.
If the repository test command is stopped from outside by SIGHUP, SIGINT,
SIGQUIT, SIGKILL, or SIGTERM, the gate makes no commit judgment: it prints a
`GATE NOT RUN: <reason>` final line and retains status 129, 130, 131, 137, or
143 respectively.
