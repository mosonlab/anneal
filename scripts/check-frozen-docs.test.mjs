// Fixtures for scripts/check-frozen-docs.sh. Every case is a real git
// repository built here and gated by running the script exactly as the merge
// gate runs it, because the whole subject of that script is what git reports
// about a branch — a unit test that stubbed git would test nothing.
//
// The rules under test are the script's own contract: the four record
// directories are append-only once merged, files added to them are dated, and
// a supersession marker has one shape. Each rule gets a passing case and a
// failing one; the baseline cases are the ones that matter most, because a
// wrong baseline makes every other rule silently vacuous.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-frozen-docs.sh", import.meta.url));

// Every case owns a fresh mktemp repository and a private shim when it needs
// one. Running those repositories concurrently changes no fixture state and
// preserves every real-git assertion while avoiding a serial process tax.
const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// No global or system git configuration, and fixed identities and dates: the
// operator's own config must not be able to change what these tests prove. The
// identity is not an address — git takes any string, and the snapshot scan is
// entitled to treat an email-shaped literal in a tracked file as one.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "frozen-docs-fixture",
  GIT_AUTHOR_EMAIL: "frozen-docs-fixture",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "frozen-docs-fixture",
  GIT_COMMITTER_EMAIL: "frozen-docs-fixture",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", env: GIT_ENV }).trim();

const write = (root, path, contents) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
};

const commit = (root, message) => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const check = (root, ...args) => {
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: GIT_ENV,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// A git that fails one subcommand and forwards the rest. The question these
// answer is not "does git work" but "what does this script conclude when a git
// invocation it depends on did not run".
const checkWithBrokenGit = (t, root, subcommand) => {
  const shim = mkdtempSync(join(tmpdir(), "agentos-frozen-docs-shim-"));
  t.after(() => rmSync(shim, { recursive: true, force: true }));
  writeFileSync(
    join(shim, "git"),
    `#!/usr/bin/env bash\nif [ "\${1:-}" = ${subcommand} ]; then\n  printf 'fixture: git ${subcommand} failed\\n' >&2\n  exit 2\nfi\nexec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [scriptPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...GIT_ENV, PATH: `${shim}:${process.env.PATH ?? ""}` },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const FROZEN = ["docs/reviews", "docs/merge-notes", "docs/briefs", "docs/plans/archive"];

// What git actually reports for the branch, so a test's name and the git graph
// it claims to build cannot drift apart.
const frozenDiff = (root) =>
  git(root, "diff", "--find-renames=100%", "-l0", "--name-status", "main", "HEAD", "--", ...FROZEN);

// A repository whose main already carries merged records in the frozen
// directories, plus a live plan and a DECISIONS.md to point supersession at.
// `merged` puts further files on main before the branch is cut, which is the
// only way to test what happens to a record that is genuinely history: a file
// created on the branch is an addition no matter what the branch then does to
// it, and a test that forgets this proves nothing about the merged case.
const repository = (t, merged = {}) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-frozen-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  write(root, "docs/reviews/2026-01-01-merged-review.md", "# a merged review\n");
  write(root, "docs/merge-notes/2026-01-01-merged-note.md", "# a merged note\n");
  write(root, "docs/briefs/2026-01-01-merged-brief.md", "# a merged brief\n");
  write(root, "docs/plans/archive/2026-01-01-merged-plan.md", "# a merged plan\n");
  write(root, "docs/plans/live-plan.md", "# a plan still being worked\n");
  write(root, "DECISIONS.md", "# decisions\n");
  commit(root, "baseline");
  const extra = Object.entries(merged);
  if (extra.length > 0) {
    for (const [path, contents] of extra) write(root, path, contents);
    commit(root, "records that were merged before this branch existed");
  }
  git(root, "checkout", "-q", "-b", "topic");
  return root;
};

// --- rule 1: append-only ----------------------------------------------------

test("a branch that touches no record passes", (t) => {
  const root = repository(t);
  write(root, "docs/plans/live-plan.md", "# a plan still being worked, revised\n");
  commit(root, "revise the live plan");
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 record\(s\) added/u);
});

test("dated additions to every frozen directory pass", (t) => {
  const root = repository(t);
  write(root, "docs/reviews/2026-02-02-new-review.md", "# review\n");
  write(root, "docs/merge-notes/2026-02-02-new-note.md", "# note\n");
  write(root, "docs/briefs/2026-02-02-new-brief.md", "# brief\n");
  write(root, "docs/plans/archive/2026-02-02-new-plan.md", "# plan\n");
  commit(root, "four dated records");
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 record\(s\) added/u);
});

test("an undated addition is refused, and named", (t) => {
  const root = repository(t);
  write(root, "docs/plans/archive/batch-repairs-plan.md", "# plan\n");
  commit(root, "the shape PR #156 shipped");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not named YYYY-MM-DD/u);
  assert.match(result.stderr, /docs\/plans\/archive\/batch-repairs-plan\.md/u);
});

test("an addition dated with an impossible date is refused", (t) => {
  const root = repository(t);
  write(root, "docs/reviews/2026-13-40-new-review.md", "# review\n");
  commit(root, "a typo for a date");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not named YYYY-MM-DD/u);
});

test("modifying a merged record is refused", (t) => {
  const root = repository(t);
  write(root, "docs/reviews/2026-01-01-merged-review.md", "# a merged review, edited\n");
  commit(root, "edit history");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frozen record modified: docs\/reviews\/2026-01-01-merged-review\.md/u);
});

test("deleting a merged record is refused", (t) => {
  const root = repository(t);
  rmSync(join(root, "docs/briefs/2026-01-01-merged-brief.md"));
  commit(root, "delete history");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frozen record deleted: docs\/briefs\/2026-01-01-merged-brief\.md/u);
});

// --- rule 1, the one allowed rename ----------------------------------------

test("a byte-identical rename of a merged record to a dated name passes", (t) => {
  // The misnamed record is on main before the branch exists, so this is the
  // real correction case: git reports R100, not an addition.
  const root = repository(t, { "docs/plans/archive/undated-plan.md": "# an undated plan\n" });
  git(root, "mv", "docs/plans/archive/undated-plan.md", "docs/plans/archive/2026-02-02-undated-plan.md");
  commit(root, "correct the name");
  assert.equal(
    frozenDiff(root),
    "R100\tdocs/plans/archive/undated-plan.md\tdocs/plans/archive/2026-02-02-undated-plan.md",
  );
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test("a rename that leaves the name undated is still refused", (t) => {
  const root = repository(t);
  git(root, "mv", "docs/reviews/2026-01-01-merged-review.md", "docs/reviews/merged-review.md");
  commit(root, "un-date a record");
  assert.equal(
    frozenDiff(root),
    "R100\tdocs/reviews/2026-01-01-merged-review.md\tdocs/reviews/merged-review.md",
  );
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /renamed but still is not named YYYY-MM-DD/u);
});

test("a rename that also edits the record is refused as the deletion it is", (t) => {
  const root = repository(t);
  git(root, "mv", "docs/reviews/2026-01-01-merged-review.md", "docs/reviews/2026-02-02-merged-review.md");
  write(root, "docs/reviews/2026-02-02-merged-review.md", "# a merged review, edited in flight\n");
  commit(root, "rename and edit");
  // Not a rename at 100% similarity, and the test says so in git's own words.
  assert.equal(
    frozenDiff(root),
    "D\tdocs/reviews/2026-01-01-merged-review.md\nA\tdocs/reviews/2026-02-02-merged-review.md",
  );
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frozen record deleted: docs\/reviews\/2026-01-01-merged-review\.md/u);
});

test("moving a merged record between frozen directories is refused", (t) => {
  const root = repository(t);
  git(root, "mv", "docs/briefs/2026-01-01-merged-brief.md", "docs/reviews/2026-01-01-merged-brief.md");
  commit(root, "re-file history");
  assert.equal(
    frozenDiff(root),
    "R100\tdocs/briefs/2026-01-01-merged-brief.md\tdocs/reviews/2026-01-01-merged-brief.md",
  );
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /moved between frozen directories/u);
});

// --- git itself failing is a FAIL, never a quiet pass ------------------------

test("a git diff that fails is refused, not read as an untouched tree", (t) => {
  const root = repository(t);
  write(root, "docs/reviews/2026-01-01-merged-review.md", "# a merged review, edited\n");
  commit(root, "a violation the broken diff would hide");
  const result = checkWithBrokenGit(t, root, "diff");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /append-only rule was not established/u);
  assert.doesNotMatch(result.stdout, /frozen records intact/u);
});

test("a git grep that fails is refused, not read as no markers", (t) => {
  const root = repository(t);
  write(root, "GRILLING-STATE.md", "> Superseded by DECISIONS.md (2026-01-01)\n");
  commit(root, "a marker the broken grep would never see");
  const result = checkWithBrokenGit(t, root, "grep");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /marker rule was not established/u);
  assert.doesNotMatch(result.stdout, /frozen records intact/u);
});

test("archiving a live plan is an addition, and must be dated", (t) => {
  const root = repository(t);
  git(root, "mv", "docs/plans/live-plan.md", "docs/plans/archive/live-plan.md");
  commit(root, "archive without a date");
  let result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not named YYYY-MM-DD/u);

  git(root, "mv", "docs/plans/archive/live-plan.md", "docs/plans/archive/2026-02-02-live-plan.md");
  commit(root, "archive with a date");
  result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 record\(s\) added/u);
});

// --- rule 2: supersession markers -------------------------------------------

test("a well-formed leading marker passes and is counted", (t) => {
  const root = repository(t);
  write(root, "GRILLING-STATE.md", "> Superseded by DECISIONS.md (2026-01-01)\n\n# state\n");
  commit(root, "mark the dump superseded");
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 supersession marker\(s\) well formed/u);
});

test("a marker in a nested directory is found, not only one at the root", (t) => {
  const root = repository(t);
  write(root, "docs/plans/live-plan.md", "> Superseded by DECISIONS.md (2026-01-01)\n\n# plan\n");
  commit(root, "supersede a nested doc");
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 supersession marker\(s\) well formed/u);

  write(root, "docs/plans/live-plan.md", "# plan\n\n> Superseded by docs/NOT-THERE.md (2026-01-01)\n");
  commit(root, "break the nested marker");
  assert.equal(check(root).status, 1);
});

test("a marker that is not the first line is refused", (t) => {
  const root = repository(t);
  write(root, "GRILLING-STATE.md", "# state\n\n> Superseded by DECISIONS.md (2026-01-01)\n");
  commit(root, "bury the marker");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be the first line/u);
});

test("a marker of the wrong shape is refused", (t) => {
  const root = repository(t);
  write(root, "GRILLING-STATE.md", "> Superseded by DECISIONS.md, 2026-01-01\n");
  commit(root, "improvise the shape");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be the first line and read exactly/u);
});

test("a marker naming a path the commit does not track is refused", (t) => {
  const root = repository(t);
  write(root, "GRILLING-STATE.md", "> Superseded by docs/NOT-THERE.md (2026-01-01)\n");
  commit(root, "point at nothing");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not track/u);
});

test("a marker pointing at its own file is refused", (t) => {
  const root = repository(t);
  write(root, "GRILLING-STATE.md", "> Superseded by GRILLING-STATE.md (2026-01-01)\n");
  commit(root, "self-supersede");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /points at its own file/u);
});

test("a second marker in the same file is refused", (t) => {
  const root = repository(t);
  write(
    root,
    "GRILLING-STATE.md",
    "> Superseded by DECISIONS.md (2026-01-01)\n\n# state\n\n> Superseded by docs/plans/live-plan.md (2026-01-02)\n",
  );
  commit(root, "superseded twice");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /2 supersession markers in one file/u);
});

test("prose that merely discusses supersession is not a marker", (t) => {
  const root = repository(t);
  write(
    root,
    "docs/specs/some-spec.md",
    "# spec\n\n> **Superseded chain-control semantics:** TC-UX v1.0 replaces this section.\n\nBody mentioning `> Superseded by <path> (YYYY-MM-DD)` inline.\n",
  );
  commit(root, "prose about supersession");
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 supersession marker\(s\)/u);
});

// --- the baseline -----------------------------------------------------------

test("a stale origin/main no longer disguises a modification as an addition", (t) => {
  const root = repository(t);
  const stale = git(root, "rev-parse", "main");
  git(root, "update-ref", "refs/remotes/origin/main", stale);

  // main moves on, adding a record; origin/main stays where it was.
  git(root, "checkout", "-q", "main");
  write(root, "docs/reviews/2026-03-03-later-review.md", "# later\n");
  commit(root, "a record main has but origin/main has not");
  git(root, "checkout", "-q", "topic");
  git(root, "merge", "-q", "main");

  // The branch modifies that record. Against the stale ref it looks new.
  write(root, "docs/reviews/2026-03-03-later-review.md", "# later, edited\n");
  commit(root, "edit a record the stale ref cannot see");

  const result = check(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /frozen record modified: docs\/reviews\/2026-03-03-later-review\.md/u);
});

test("agreeing refs, and a stale local main, both simply work", (t) => {
  const root = repository(t);
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "main"));
  write(root, "docs/reviews/2026-02-02-new-review.md", "# review\n");
  commit(root, "a dated record");
  let result = check(root);
  assert.equal(result.status, 0, result.stderr);

  // origin/main ahead of a local main left behind: the descendant wins.
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "topic"));
  result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ahead of main/u);
});

test("diverged main refs are refused rather than guessed at", (t) => {
  const root = repository(t);
  const baseline = git(root, "rev-parse", "main");

  git(root, "checkout", "-q", "-b", "elsewhere", baseline);
  write(root, "docs/plans/other.md", "# somewhere else entirely\n");
  const diverged = commit(root, "a commit main never saw");
  git(root, "update-ref", "refs/remotes/origin/main", diverged);

  git(root, "checkout", "-q", "main");
  write(root, "docs/plans/live-plan.md", "# advanced\n");
  commit(root, "main advances on its own");
  git(root, "checkout", "-q", "topic");
  git(root, "merge", "-q", "main");

  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /have diverged/u);
  assert.match(result.stderr, /pass --master/u);
});

test("an authoritative --master oid settles a divergence the refs cannot", (t) => {
  const root = repository(t);
  const baseline = git(root, "rev-parse", "main");
  git(root, "checkout", "-q", "-b", "elsewhere", baseline);
  write(root, "docs/plans/other.md", "# somewhere else entirely\n");
  git(root, "update-ref", "refs/remotes/origin/main", commit(root, "a commit main never saw"));
  git(root, "checkout", "-q", "topic");

  const result = check(root, "--master", baseline);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /authoritative oid/u);
});

test("a single stale ref is why the gate binds the oid: unbound passes, bound refuses", (t) => {
  // The #157 review's fixture, kept as the reason the call chain exists. Only a
  // remote-tracking ref survives, and it is behind: nothing inside a repository
  // can tell a stale ref from a fresh one.
  const root = repository(t);
  const stale = git(root, "rev-parse", "main");
  git(root, "checkout", "-q", "main");
  write(root, "docs/reviews/2026-03-03-frozen.md", "# a record main carries\n");
  const current = commit(root, "main moves on");
  git(root, "checkout", "-q", "topic");
  git(root, "merge", "-q", "main");
  write(root, "docs/reviews/2026-03-03-frozen.md", "# a record main carries, edited\n");
  commit(root, "modify it");
  git(root, "update-ref", "refs/remotes/origin/main", stale);
  git(root, "branch", "-q", "-D", "main");

  const unbound = check(root);
  assert.equal(unbound.status, 0);
  assert.match(unbound.stderr, /not gate authority/u);

  const bound = check(root, "--master", current);
  assert.equal(bound.status, 1);
  assert.match(bound.stderr, /frozen record modified: docs\/reviews\/2026-03-03-frozen\.md/u);
  assert.doesNotMatch(bound.stderr, /not gate authority/u);
});

test("--master refuses anything that is not a full object id in this repository", (t) => {
  const root = repository(t);
  assert.match(check(root, "--master", "deadbeef").stderr, /full 40-character object id/u);
  assert.match(check(root, "--master", "z".repeat(40)).stderr, /hexadecimal object id/u);
  assert.match(check(root, "--master", "0".repeat(40)).stderr, /is not a commit/u);
  assert.equal(check(root, "--master").status, 1);
  assert.equal(check(root, "--nonsense").status, 1);
});

test("no main ref at all is refused, not passed trivially", (t) => {
  const root = repository(t);
  git(root, "branch", "-q", "-D", "main");
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no main ref to compare against/u);
});
