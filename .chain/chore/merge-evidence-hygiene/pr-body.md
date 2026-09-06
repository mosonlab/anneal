# PR body

Remove unused merge-module declarations without changing merge behavior. Step-role comments now point to `stepRole()` and `canonicalStepOrdinals`.

## Scope clarifications

- BR-001: `MERGE_READINESS_OUTPUT_KIND` is deliberately deferred to the separate SIM-LIBS-006 export-narrowing decision. It is not one of the enumerated deletions. Its sole source match at the reviewed head is `packages/db/src/merge-tail.ts:15:export const MERGE_READINESS_OUTPUT_KIND = "merge-authorization";`. The broad Goal sentence is bounded by the enumerated Changes and Out of scope.
- BR-002: Nine unused ordinals were deleted, not ten. At base `d9f597d7638dd4e8e34f89cda40b4b3c1061aa32`, `merge-tail.ts` contains six ordinal declarations (lines 16–19 and 21–22); `merge-integrator.ts` contains seven (lines 40, 41, 43, 45–48), of which three are unused and four are protected survivors. There is no tenth unused ordinal. `INTEGRATOR_STEP_INDEX`, `DIRECT_INTEGRATOR_STEP_INDEX`, `LEGACY_INTEGRATOR_STEP_INDEX`, `LEGACY_DIRECT_INTEGRATOR_STEP_INDEX`, and `INTEGRATOR_OUTPUT_KIND` remain untouched.
- BR-003: `TEMPLATE_ROLLOVER_ACTIVE_RUN_STATUSES` and `RunOutcomeCase` were already absent at the base above. For each, `git grep -nw <NAME> d9f597d7638dd4e8e34f89cda40b4b3c1061aa32 -- . ':!**/dist/**'` returns no source line (only the specification mentions them); adding `':!.chain/**'` yields exit 1 and no output. Thus four of the six names in Changes 3 required deletion.

## Deletion evidence

For every name below, `git grep -nw <NAME> d9f597d7638dd4e8e34f89cda40b4b3c1061aa32 -- . ':!**/dist/**' ':!.chain/**'` returned exactly the defining line shown. The same command against reviewed head `ec703bc9b469888015647d07a0f964f6bce56c58` returned exit 1 and no output for all 16 names. Excluding `.chain` separates source references from specification and handoff prose.

| Deleted name | Sole base source match |
| --- | --- |
| `inStopState` | `packages/db/src/merge-integrator-db.ts:306:export const inStopState = async (tx: Tx, taskId: string): Promise<boolean> =>` |
| `INTEGRATOR_OUTPUT` | `packages/db/src/merge-integrator-db.ts:472:export const INTEGRATOR_OUTPUT = INTEGRATOR_OUTPUT_KIND;` |
| `assertIntegratorBinding` | `packages/db/src/merge-integrator-db.ts:1069:export const assertIntegratorBinding = async (tx: Tx, subject: BindingSubject): Promise<void> => {` |
| `MergeIntegratorKind` | `packages/db/src/merge-integrator.ts:28:export type MergeIntegratorKind = (typeof MERGE_INTEGRATOR_KIND)[keyof typeof MERGE_INTEGRATOR_KIND];` |
| `LEGACY_REGRESSION_FIRST_INTEGRATOR_STEP_INDEX` | `packages/db/src/merge-integrator.ts:43:export const LEGACY_REGRESSION_FIRST_INTEGRATOR_STEP_INDEX = 13;` |
| `LEGACY_PRE_ADJUDICATION_INTEGRATOR_STEP_INDEX` | `packages/db/src/merge-integrator.ts:45:export const LEGACY_PRE_ADJUDICATION_INTEGRATOR_STEP_INDEX = 13;` |
| `LEGACY_PRE_ADJUDICATION_DIRECT_INTEGRATOR_STEP_INDEX` | `packages/db/src/merge-integrator.ts:46:export const LEGACY_PRE_ADJUDICATION_DIRECT_INTEGRATOR_STEP_INDEX = 8;` |
| `DIRECT_MERGE_READINESS_STEP_INDEX` | `packages/db/src/merge-tail.ts:16:export const DIRECT_MERGE_READINESS_STEP_INDEX = 6;` |
| `MERGE_READINESS_STEP_INDEX` | `packages/db/src/merge-tail.ts:17:export const MERGE_READINESS_STEP_INDEX = 11;` |
| `LEGACY_DIRECT_MERGE_READINESS_STEP_INDEX` | `packages/db/src/merge-tail.ts:18:export const LEGACY_DIRECT_MERGE_READINESS_STEP_INDEX = 6;` |
| `LEGACY_MERGE_READINESS_STEP_INDEX` | `packages/db/src/merge-tail.ts:19:export const LEGACY_MERGE_READINESS_STEP_INDEX = 11;` |
| `LEGACY_PRE_ADJUDICATION_DIRECT_MERGE_READINESS_STEP_INDEX` | `packages/db/src/merge-tail.ts:21:export const LEGACY_PRE_ADJUDICATION_DIRECT_MERGE_READINESS_STEP_INDEX = 7;` |
| `LEGACY_PRE_ADJUDICATION_MERGE_READINESS_STEP_INDEX` | `packages/db/src/merge-tail.ts:22:export const LEGACY_PRE_ADJUDICATION_MERGE_READINESS_STEP_INDEX = 12;` |
| `AgentOsClient` | `packages/merge-executor/src/agentos.ts:35:export type AgentOsClient = ReturnType<typeof makeAgentOsClient>;` |
| `MutatingOperation` | `packages/merge-executor/src/github.ts:34:export type MutatingOperation = (typeof MUTATING_OPERATIONS)[number];` |
| `GitHubClient` | `packages/merge-executor/src/github.ts:514:export type GitHubClient = ReturnType<typeof makeGitHubClient>;` |

## Validation

With `RUNNER_WORKSPACE_ROOT` set to a new temporary directory:

- `npm run typecheck -w @anneal/db` and `npm run lint -w @anneal/db` passed.
- `npm run test -w @anneal/db` passed: 504 tests.
- `npm run typecheck -w @anneal/merge-executor` and `npm run lint -w @anneal/merge-executor` passed.
- `npm run test -w @anneal/merge-executor` passed: 107 tests; the live GitHub schema check was skipped because `GITHUB_SCHEMA_GATE_TOKEN` is unset in the ordinary workspace suite.
- `npm run test -w @anneal/build-info` passed unchanged: 28 tests, including the subpath contract.
- All 16 deletion grep proofs, both already-absent names, and the base ordinal counts were independently checked during review fixes.

Root `npm run typecheck` and `npm run lint` are whole-repository aggregates reserved for Regression by the Anneal Run instructions; workspace equivalents above passed. This review-fix commit changes only this PR-body handoff. The platform owns PR creation and should use this body when delivering the chain.
