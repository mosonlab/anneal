# Plan decisions: no-commit-refusal-coverage

## One slice, not a decomposed frontier

**Choice.** The whole plan is a single slice, `01-no-commit-refusal-assertion`, with
empty `blocked_by`.

**Rejected.** (a) Splitting into a "prefactor the test helpers" slice plus an
"add the assertion" slice. (b) Adding a sibling slice that covers the identically
shaped fallback in the canonical task output module, to widen the frontier.
(c) A separate slice for the mutation check.

**Reason.** The specification of record fixes the change at one `assert.equal`
call inside an existing test, with a net budget of at most 6 added lines and an
explicit constraint that the compound template's step count must not inflate
scope. A second slice would have to invent work the spec places out of scope.
The mutation check is acceptance evidence for the same behaviour, so it belongs
to the same slice's criteria rather than to a slice of its own.

## No prefactoring

**Choice.** No preparatory refactor precedes the assertion.

**Rejected.** Extracting a table-driven case list for the refusal shapes inside
the target test, or hoisting the `{ ...manualOutput, ... }` overrides into a
helper, before adding the new case.

**Reason.** "Make the change easy, then make the easy change" pays off when the
change is otherwise hard. Here the sibling wrong-sha assertion is already the
exact template for the new one, so the change is a copy-and-adjust. The spec
also forbids refactoring the file's helpers and altering existing assertions, so
any prefactor would be a scope violation rather than a cost saving.

## Risk flag false

**Choice.** `risk: false` on the only slice.

**Rejected.** Marking it risky because the acceptance evidence requires
temporarily editing a production module.

**Reason.** The risk flag marks persisted data and irreversible external actions.
The mutation is a local working-tree edit that the same slice reverts, and the
final diff touches one test file. Nothing persists and nothing leaves the Run.

## Verification named at the workspace seam

**Choice.** Each acceptance criterion names the API workspace test script, the
repository lint script, or a `git diff` inspection as its verification.

**Rejected.** Naming the repository merge gate or a database suite as a slice
criterion.

**Reason.** Repository instructions reserve whole-repo aggregates and database
suites for the merge gate and forbid running them inside a Run. Chain-level
evidence stays outside the slice set.

## Mutation check is a slice criterion, not a report-only note

**Choice.** The flip of the production fallback to `?? "no-commit"`, the failing
run, the restore, and the green re-run are written as acceptance criteria that
the implementation must execute and report in its output summary.

**Rejected.** Leaving the mutation check as advisory prose in the slice body.

**Reason.** It is the only check that distinguishes a test that pins the literal
from a test that tautologically mirrors the production expression, which is the
spec's central constraint. A criterion is what an implementation is obliged to
turn green; prose is not.
