# Spec: no-commit refusal message coverage for uncontracted continuations

## Problem Statement

An operator reading a burned Run needs the refusal message to say exactly what
went wrong. `uncontractedContinuationRefusal` in the API's run-completion module
tells an uncontracted unchanged continuation why its evidence was rejected, and
one of its branches renders a `null` `commitSha` as the literal phrase
`no commit`. That branch is reachable — `TaskStepOutput.commitSha` is nullable
and the output write path accepts an output with no commit — but no test
asserts it. Today a developer could change or delete the `no commit` wording,
or drop the fallback entirely, and the API's unit tests would still pass. The
operator-facing sentence for "your output is bound to no commit at all" is
therefore unprotected.

## Solution

Pin the literal refusal sentence with one assertion in the existing
run-completion unit test that already covers the other refusal shapes of the
same function. Calling the exported `completionEvidenceRefusal` with an
uncontracted continuation Run and a this-Run output whose `commitSha` is `null`
must produce exactly
`task output is bound to no commit, not completion head <baseSha>`, with the
phrase `no commit` written out as a literal in the expectation rather than
re-derived from the production expression. Nothing else changes: no production
code, no existing assertion, no fixture, no new test file.

## User Stories

1. As an Anneal operator, I want the refusal for an output bound to no commit to
   keep saying `no commit`, so that I can tell it apart from an output bound to
   the wrong sha when I read a burned Run.
2. As an Anneal operator, I want that wording protected by a test, so that a
   later refactor cannot silently degrade the diagnostic I rely on.
3. As an API developer, I want the `?? "no commit"` fallback in
   `uncontractedContinuationRefusal` covered by an assertion, so that I learn
   from a failing test — not from production — when I change it.
4. As an API developer, I want the new assertion to live beside the sibling
   assertions for the same function, so that all refusal shapes of
   `completionEvidenceRefusal` for an uncontracted continuation read as one
   case.
5. As an API developer, I want the expectation to spell `no commit` literally,
   so that the test cannot tautologically restate the code under test and pass
   after the fallback string is edited.
6. As an API developer, I want the assertion to use the existing
   `continuation` and manual-output fixtures, so that I do not introduce a
   second way to describe the same Run shape.
7. As a reviewer, I want the change to be a single assertion in a single test
   file, so that I can judge it in one read and confirm it adds coverage
   without changing behavior.
8. As a reviewer, I want the diff to leave every existing assertion, test name,
   and helper untouched, so that I can trust the surrounding coverage is
   unchanged.
9. As a maintainer of the merge gate, I want the API workspace test run and the
   repository lint to stay green, so that the change is mergeable without
   further work.
10. As the implementer of this Step, I want an explicit mutation check — flip
    `?? "no commit"` to `?? "no-commit"` and confirm the new assertion is the
    one that fails — so that I can prove the test actually pins the literal.
11. As the implementer, I want to restore the production string and re-run the
    API tests to green, so that the workspace I hand off carries no temporary
    mutation.
12. As the implementer, I want to report both runs of that mutation check in my
    Step's output summary, so that the evidence is durable and a reviewer need
    not re-run it.
13. As a chain reviewer, I want the spec, plan, and implementation to keep this
    at one assertion, so that the compound template's step count does not
    inflate the scope of a trivially small change.
14. As an API developer, I want the identically shaped fallback in the canonical
    task output module left alone, so that this change stays a single, reviewable
    coverage addition rather than a sweep.
15. As an API developer, I want no new database-backed test for this, so that a
    pure-function branch keeps being covered at the cheapest seam that can
    observe it.

## Implementation Decisions

- **Module modified**: the run-completion unit test module in the API package
  (`packages/api/src/run-completion.test.ts`). No other file changes.
- **No production change.** `packages/api/src/run-completion.ts` is read-only
  for this Step, except for the temporary, reverted mutation described under
  Testing Decisions. The final diff must contain no production edit.
- **Entry point under test**: the module's exported `completionEvidenceRefusal`.
  `uncontractedContinuationRefusal` stays module-private and is exercised
  through that export; the change must not widen the module's public surface.
- **Fixture reuse**: the new assertion reuses the existing `continuation`
  helper with `task: { templateStep: null }` and the `manualOutput` object
  already constructed inside the target test, spreading it with
  `commitSha: null`. This is the same construction style as the sibling
  assertion that overrides `commitSha` with a different sha.
- **Placement**: the assertion is appended inside the existing test
  `"a manual own-publication continuation proves itself with this Run's output at
  the unchanged head"`, after the assertion covering the wrong-sha refusal.
  Grouping is by the function under test, not by refusal variant, so no new
  `test(...)` block is added.
- **Expectation form**: the expected string is written with `no commit` as a
  source literal. Interpolating the completion head via the existing `baseSha`
  constant is allowed, since the head is fixture data rather than the wording
  under test; reproducing the production fallback expression (for example
  `output.commitSha ?? "no commit"`) is not.
- **No new exports, helpers, or type changes.** The existing helpers
  (`continuation`, `implementationOutput`) are used as-is; refactoring them is
  forbidden by scope.
- **Size budget**: the net addition is at most 6 lines, consistent with a single
  `assert.equal` call formatted in the file's existing style.

## Testing Decisions

- **What makes a good test here**: it observes only the externally visible
  result of the exported function — the refusal string an operator sees — for a
  given Run and output. It does not reach into module internals, does not assert
  on call counts or intermediate state, and does not restate the implementation
  expression it is meant to pin.
- **Seam under test**: the existing one. `completionEvidenceRefusal` is the
  highest seam that can observe this branch as a pure function, and the target
  test file already drives every other refusal shape through it. Exactly one
  seam is involved and no new seam is created: neither a new export from
  run-completion, nor an HTTP-level test, nor a database-backed test.
- **Module tested**: `packages/api/src/run-completion.ts`, through
  `packages/api/src/run-completion.test.ts` (`node:test` with
  `node:assert/strict`, matching the file's existing idiom).
- **Prior art**: the three assertions already inside the target test — missing
  output, output belonging to another Run, and output bound to a different sha —
  are the template for the new one. The wrong-sha assertion in particular
  already demonstrates the `{ ...manualOutput, commitSha: ... }` override and an
  expectation built from fixture constants.
- **Mutation check as acceptance evidence**: the implementation Step must
  temporarily change the production fallback from `?? "no commit"` to
  `?? "no-commit"`, run the API workspace tests, and confirm the run fails with
  the failure pointing at the newly added assertion; then restore the original
  string and confirm the API workspace tests are green again. Both runs are
  reported in that Step's output summary. This is the acceptance evidence that
  the assertion pins the literal rather than mirroring it.
- **Checks to run**: the API workspace test script and the repository lint
  script. Whole-repo verification aggregates and database suites belong to the
  merge gate and must not be run in this Run.

## Out of Scope

- Any change to `packages/api/src/run-completion.ts` or any other production
  module. The temporary mutation for the acceptance check is made and reverted
  within the implementation Step and must not appear in the final diff.
- Any change to existing assertions, test names, or fixtures in
  `packages/api/src/run-completion.test.ts`, and any refactor of its helpers.
- Covering the identically shaped `?? "no commit"` fallback in
  `packages/api/src/canonical-task-output.ts`, and any change to
  `packages/api/src/canonical-task-output.test.ts`.
- Any new database-backed test, and any change to
  `packages/api/src/run-completion.dbtest.ts`.
- CHANGELOG, documentation, and operator API handbook edits — no HTTP route or
  operator-visible contract changes here.
- Broadening coverage of other refusal branches, adding table-driven cases, or
  splitting the work into multiple slices.

## Further Notes

- Origin: the fix for issue #630 (commit `46c9b808`) introduced
  `uncontractedContinuationRefusal`, which lets a Task with no canonical Step
  prove an unchanged continuation with the only claim it can make — an output
  this Run authored, bound to the head it leaves behind. The `no commit`
  fallback is the wording for the case where that output carries no commit at
  all.
- This Chain is a compound (12-Step) template used as a smoke-verification
  carrier, not a change whose size calls for Full Assurance. Per the
  task-routing tier rules this work would normally stay in a session. Every
  downstream Step should specify, plan, and review it honestly as a one-assertion
  change; expanding scope, adding slices, or inventing extra test surface to
  match the template's shape is a defect, not diligence.
- Assumptions recorded while writing this spec, all under the simplest reading
  of the brief and none of which alter the Product Contract's objective, scope,
  acceptance criteria, evidence, authority, or risk boundary:
  1. The new assertion is appended after the existing wrong-sha assertion rather
     than inserted elsewhere in the test body; the brief fixes the containing
     test but not the position within it.
  2. Interpolating the existing `baseSha` fixture constant into the expected
     string is acceptable; only the `no commit` phrase must be a literal.
  3. "Net added lines ≤ 6" is measured on the final `git diff` for the branch,
     with the production mutation already reverted.
  4. The plan Step produces a single slice; the work does not admit a
     meaningful frontier wider than one.
