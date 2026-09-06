---
name: agentos-find-simplifications
description: "Find evidence-backed Anneal simplification candidates and group them for the operator's approval before implementation."
---

# Anneal simplification discovery

Run a manual, full-repository survey when the operator decides Anneal feels bloated. The outcome is a small set of well-proven deletion or consolidation themes, not code changes.

## Authority boundary

This skill is discovery-only.

- Keep the survey read-only. Do not edit source, tests, configuration, prompts, documentation, or repository records.
- Do not create a branch, brief, backlog card, chain, pull request, or Agent Note unless the operator separately asks for that action.
- Stop after presenting the candidate report. Ask the operator to select theme IDs and separately approve any public-interface removal IDs.
- After approval, handle each selected theme through the repository's normal brief, chain, review, pull-request, and exact-head merge-gate process. Approval of a theme is not approval of unlisted deletions.

Use the current repository instructions as authority. Bind every report to an exact commit and state whether it represents `HEAD`, `origin/main`, or a dirty working tree. The serving checkout remains read-only; if later work must persist an artifact or run mutating validation, use an isolated worktree.

## Model and delegation contract

Launch the discovery task with `gpt-5.6-sol` at `high` reasoning effort; the skill cannot reconfigure its parent task. If runtime metadata explicitly exposes the effective parent model and effort, record them and stop before surveying only when they conflict with this launch contract. If the runtime does not expose either field, record `requested gpt-5.6-sol/high; runtime metadata unavailable` and continue. Do not infer task settings from documentation, global defaults, process inspection, or environment variables.

When the runtime supports subagents, use available capacity to widen the read-only survey:

- Spawn every survey worker with explicit `gpt-5.6-luna` and `max`; never rely on inherited or default model settings.
- Give each worker a disjoint tracked corpus or subsystem and the same evidence fields required by the candidate report.
- Workers gather coverage, consumers, dynamic entrypoints, intent, history, candidate leads, and unresolved ambiguity. They do not assign final verdicts or authorize deletion.
- Wait for every worker, then have the Sol parent inspect the returned evidence, fill coverage gaps, reject thin leads, deduplicate candidates, and assign the final classifications.

Choose the worker count from the available runtime capacity and independently useful partitions; do not encode a product version or fixed pool size. If subagents are unavailable, the Sol parent completes the same coverage serially and records that fact. Delegation changes throughput, not the evidence bar.

## Survey the whole tracked tree

First establish the repository's actual shape with `git status`, `git rev-parse`, `git ls-files`, workspace manifests, package scripts, and current architecture or operating docs. Derive areas from the repository rather than relying on a cached package list.

Cover every tracked area, but classify these corpora separately:

1. Production runtime: application and package source that ships or runs.
2. Non-production support: tests, fixtures, demos, snapshots, and test-only helpers.
3. Operational surfaces: scripts, CI, configuration, Docker, loaders, manifests, prompts, role definitions, and workflow templates.
4. Documentation: current product, contributor, governance, release, and runbook material.
5. Protected or excluded material: generated output, vendored code, frozen records, migration history, intentional mirrors, and files whose repository contract forbids modification.

Use `git log --stat`, `git log --numstat`, and recent change history to locate churn and duplicated maintenance, but treat size and churn only as leads. Complete the coverage inventory even after finding a strong candidate.

## Prove candidates from repository-native evidence

Use `rg`, `rg --files`, and `git grep` first. Search exact symbols, imports and exports, route and event names, wire strings, config keys, package names, script names, filenames, prompt identifiers, and dynamic loader registrations. Read every plausible call site before assigning a verdict.

For each candidate:

1. Separate production consumers, non-production consumers, and ambiguous or dynamic consumers.
2. Trace re-exports, package entrypoints, CLI/API surfaces, reflection, generated registration, Prisma use, scripts, CI, Docker, prompts, manifests, and workflow dispatch.
3. Read nearby rationale and relevant history. Current documented intent can defeat a static unused-code lead.
4. Name the exact deletion, fold, demotion, or replacement and estimate the net surface removed, including tests and documentation that exist only for that behavior.
5. State the capability, flexibility, compatibility, or defense the repository would give up.
6. Define observable validation for a later implementation task.

Tests are behavior evidence, not automatic authority. Tests or docs as the only consumers can support removal when the behavior itself is obsolete. Zero in-repository references never proves that an exported API has no external consumers.

For asynchronous, concurrent, ownership, cancellation, retry, or lifecycle code, map owners, states, transitions, terminal outcomes, cleanup, and rollback before proposing consolidation. Mirrored flags are a candidate only when they encode the same fact and no distinct transition or failure boundary depends on them.

Repository-native evidence is the required stack. Do not install or configure analysis tooling such as Knip, do not add persistent analysis dependencies, or wire a scanner into CI or the merge gate. A preinstalled scanner may supply leads, but never deletion authority.

## Prefer high-value simplifications

Strong leads include:

- an internal symbol, helper, package surface, config knob, script, prompt, or event with no production consumer;
- behavior consumed only by obsolete tests or documentation;
- two representations, lifecycle mechanisms, or sources of truth that mirror the same fact;
- seam methods every implementation carries but no caller uses;
- speculative generality with no current product owner;
- invariants, rollback paths, fixtures, or dedicated tests that protect only an unused behavior;
- hand-rolled infrastructure replaceable by an existing dependency or supported Node builtin when the result is net deletion rather than relocated complexity;
- repeated logic that can move behind one existing owner without broadening that owner's public interface.

Reject or downgrade leads based only on file size, aesthetic preference, a one-off typo, static-tool output, or duplication required by localization, generated artifacts, independent failure domains, security boundaries, or repository policy.

## Classify before grouping

Assign exactly one verdict to every investigated lead:

- `confirmed-internal-delete`: internal removal or folding supported by strong consumer and intent evidence.
- `public-removal-needs-operator`: exported API, CLI, protocol, wire format, configuration contract, or other externally consumable surface. List it separately; target an approved removal to the next minor release while Anneal is pre-1.0.
- `defense-or-persisted-separate-task`: persisted data, Prisma schema or migrations, merge authorization or automation, ownership, locking, workspace containment, security, secrets, or other defense-list behavior. Report the opportunity, but require a separate task and explicit operator approval before implementation; the later brief uses the `default route` unless an owner-defined `hazard: <which>` applies.
- `intentional-keep`: complexity or duplication justified by a current owner, contract, boundary, or deliberate architecture.
- `rejected`: the evidence did not prove a net simplification or a production consumer still needs the behavior.

Representative defense paths include `packages/db/prisma/**`, `scripts/merge-gate.sh`, `scripts/gate-worker/**`, merge-executor and merge-evidence paths, and ownership or workspace-containment code. Discover current paths and semantics before classifying; the list is not exhaustive.

## Report and stop

Read [references/candidate-report.md](references/candidate-report.md) before writing the result. Give each candidate a stable ID and group related candidates into bounded themes that can later be implemented and validated independently.

The report must account for every surveyed area, including areas with no accepted candidate, and must distinguish exclusions from completed coverage. Prefer a few high-confidence themes over a long list of guesses.

For each theme, read the current tier-selection and implementation-assignee
rules in `docs/governance/task-routing-v1.md` and recommend a chain type plus
one implementation route: `default route` unless the owner-defined hazard
applies, in which case write `hazard: <which>`. State the exact routing reason.
Treat this as a post-approval handoff recommendation, not implementation
authority. A Luna subagent dispatched outside the required Anneal chain does
not inherit the chain's permission to implement.

End with only the consequential decisions the operator must make:

1. Which theme IDs, if any, should advance to separate briefs and chains?
2. Which `public-removal-needs-operator` IDs, if any, are approved for a next-minor breaking removal?

Do not implement while waiting for the answer.
