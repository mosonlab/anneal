# 0008 - Templates are immutable once used

Status: Accepted (2026-09-08)

## Context

Templates define the step graph and prompts used to instantiate Chains. Once a
template has instantiation history, changing it would change the source of
later Chains while existing history still refers to the earlier shape. Prompt
revisions on steps with history therefore need a registered generation
rollover.

## Decision

### K8 `template-immutable-once-used`

A template with instantiation history is immutable. Authoring is
clone-then-edit, and the step graph is replaced as a whole by one atomic
`PUT /task-templates/:id/steps`.

**Why:** Copy-on-write was deliberately not built. Instantiation re-reads and
re-validates the template inside the locking transaction.

### K9 `prompt-only-changes-ride-rollover`

A prompt revision on a step with history rides a registered generation
rollover. Unregistered prompt drift refuses deployment.

**Why:** The generation registry carries prompt digests in both directions, so
outgoing and successor prompts are pinned.

### K10 `review-step-base-pinning`

Review steps pin their base with `baseFromStepIndex` to the predecessor's end
commit. Reports travel as step outputs bound to a commit and are never
committed to the Chain branch.

**Why:** This provides fetch-level isolation with fail-stop semantics and no
branch-head fallback.

## Consequences

- A template with instantiation history refuses edits with
  `template_in_use`.
- Validation has two tiers: errors block, while warnings pass.
- The old rule that prompt-only changes do not exist is retired; generation
  rollover registration is manual.
- Review-step base pinning survived removal of the blind-review authority layer
  because it is unrelated to that layer.
