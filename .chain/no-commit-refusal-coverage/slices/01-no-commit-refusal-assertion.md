---
id: 01-no-commit-refusal-assertion
title: Pin the "no commit" refusal wording for an uncontracted unchanged continuation
blocked_by: []
risk: false
---

# 01: Pin the "no commit" refusal wording for an uncontracted unchanged continuation

**What to build:** an operator reading a burned Run sees the refusal
`task output is bound to no commit, not completion head <head>` when an
uncontracted unchanged continuation's own output carries no commit at all, and
that exact sentence is now protected by the API's unit tests. The behaviour
itself already exists; this slice makes it observable to a failing test, so the
wording can no longer be changed or deleted silently. No production module
changes in the delivered diff.

The new assertion goes into the existing run-completion unit test that already
drives the other refusal shapes of the same exported entry point, reusing that
test's continuation fixture and its manual output object with the commit
overridden to null. The expected string spells `no commit` as a source literal;
the completion head may be interpolated from the existing fixture constant, but
the production fallback expression must not be reproduced in the expectation.

**Blocked by:** None (can start immediately).

- [ ] Calling the run-completion module's exported completion-evidence refusal
      with an uncontracted continuation Run, an unchanged head, and a this-Run
      output whose commit is null returns exactly
      `task output is bound to no commit, not completion head <head>`, asserted
      inside the existing manual own-publication continuation test. Verified by
      `npm run test -w @anneal/api` passing with the new assertion present; red
      at the frozen base because no such assertion exists there.
- [ ] The expectation contains `no commit` as a literal and does not restate the
      production fallback expression. Verified by reading the added lines in
      `git diff`.
- [ ] Temporarily changing the production fallback from `?? "no commit"` to
      `?? "no-commit"` makes `npm run test -w @anneal/api` fail, and the
      reported failure is the newly added assertion. Verified by running the
      script under the mutation; red at the frozen base because the mutation
      passes there.
- [ ] Restoring the production string returns `npm run test -w @anneal/api` to
      green, and both runs of this mutation check are reported in this Step's
      output summary.
- [ ] `npm run lint` is green.
- [ ] `git diff` against the frozen base touches exactly one file — the
      run-completion unit test module — with at most 6 net added lines, no
      production edit left behind, and no existing assertion, test name, fixture,
      or helper modified. Verified by `git diff --stat` and reading the diff.
