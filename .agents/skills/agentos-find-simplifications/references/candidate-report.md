# Candidate report contract

Use this structure for a completed discovery run. Omit empty prose, but keep every evidence field so absence remains visible.

## Baseline and coverage

- Repository and exact commit
- Compared ref, if any
- Working-tree state
- Survey date
- Parent model and reasoning effort, or `requested gpt-5.6-sol/high; runtime metadata unavailable`
- Subagent model and reasoning effort, or `serial parent-only survey`
- Delegated areas and completion status
- Areas surveyed
- Protected or excluded areas and the authority for each exclusion
- Areas where evidence remained ambiguous

List every top-level tracked area and its coverage result: accepted candidate IDs, investigated-but-kept IDs, or `no candidate`. A directory name alone is not coverage evidence; name the entrypoints, manifests, or owner surfaces inspected.

## Theme summary

For each bounded theme:

- Theme ID and action-oriented title
- Candidate IDs
- Current complexity cost
- Proposed end state
- Net deletion or consolidation expected
- Highest risk classification in the theme
- Recommended chain: `direct` | `compound` | `separate high-risk investigation`
- Implementation route: `default route` | `hazard: <which>`, with the routing reason named by `docs/governance/task-routing-v1.md`
- Why the candidates belong in one independently verifiable change

Keep public-interface candidates and defense or persisted-data candidates visually separate from ordinary internal themes.

## Candidate record

Use a stable ID such as `SIM-RUNNER-001`.

### `<ID>`: `<action-oriented title>`

- Theme: `<theme ID>`
- Verdict: `confirmed-internal-delete` | `public-removal-needs-operator` | `defense-or-persisted-separate-task` | `intentional-keep` | `rejected`
- Surface: exact files, symbols, routes, events, config keys, scripts, prompts, or packages
- Problem: what complexity exists and what maintenance cost it creates
- Production consumers: each caller or `none found`, with searches and call-site interpretation
- Non-production consumers: tests, fixtures, docs, snapshots, and support code
- Dynamic entrypoints: loaders, reflection, manifests, CI, Docker, Prisma, wire formats, prompts, and workflow dispatch checked
- Intent and history: current rationale, intentional architecture, and relevant change history
- Proposal: exact deletion, fold, demotion, or replacement
- Why not keep it: strongest argument against retaining the current surface
- What we give up: behavior, compatibility, flexibility, failure isolation, rollback, or future option lost
- Risk flags: public interface, persisted data, defense list, security, concurrency, migration, release, or `none`
- Net effect: implementation and support surface removed minus glue or replacement added
- Acceptance criteria: observable end state for the later implementation task
- Validation: focused checks plus the repository-required review and exact-head gate path
- Implementation routing impact: facts that support the `default route` or require `hazard: <which>` under `docs/governance/task-routing-v1.md`
- Confidence: `high` | `medium` | `low`, with the remaining uncertainty

Do not assign `confirmed-internal-delete` when production or dynamic consumption remains ambiguous. Use `rejected` when a production caller survives; use `intentional-keep` when the current architecture deliberately owns the cost.

## Decision request

Ask the operator only for decisions with material consequences:

- theme IDs to advance;
- public-removal IDs approved for the next minor release;
- whether any defense or persisted-data candidate should receive a separate high-risk investigation.

State that selecting a theme approves only its closed candidate list. New deletion opportunities found during implementation return to a later discovery report rather than expanding scope silently.

## Persistence boundary

Present the report in the conversation by default. If the operator asks to persist it, use the existing Anneal backlog, brief, or private operator-record authority. Do not create an `.agents/notes` tree or a new repository record system.
