import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  globToRegExp,
  scanRepository,
  scanTextFindings,
  scopeFor,
} from "./public-snapshot-scan.mjs";

function baseManifest({ include = [], exclude = [], approvedFindings = [], mintedArtifacts = [] } = {}) {
  return {
    schemaVersion: 2,
    source: "git-tracked-files+minted-artifacts",
    defaultDisposition: "blocker",
    include: include.map((glob) => ({ glob, reason: "test public input" })),
    deny: [],
    exclude: exclude.map((glob) => ({
      glob,
      disposition: "later-release-follow-up",
      reason: "test excluded input",
    })),
    approvedFindings,
    mintedArtifacts,
    generatedRuntimePatterns: [],
  };
}

function createRepositoryFixture({ files = {}, manifest, symlinks = {}, copyScanner = false }) {
  const root = mkdtempSync(join(tmpdir(), "agentos-snapshot-scan-"));
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  for (const [path, target] of Object.entries(symlinks)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  if (copyScanner) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(fileURLToPath(new URL("./public-snapshot-scan.mjs", import.meta.url)), join(root, "scripts/public-snapshot-scan.mjs"));
  }
  writeFileSync(join(root, "public-snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  const trackedPaths = [
    ...Object.keys(files),
    ...Object.keys(symlinks),
    ...(copyScanner ? ["scripts/public-snapshot-scan.mjs"] : []),
    "public-snapshot.json",
  ];
  execFileSync("git", ["add", "--", ...trackedPaths], { cwd: root });
  execFileSync("git", ["commit", "-m", "test: create snapshot fixture"], { cwd: root });
  return root;
}

function withRepositoryFixture(options, callback) {
  const root = createRepositoryFixture(options);
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("glob matching keeps the allowlist bounded", () => {
  assert.equal(globToRegExp("apps/**").test("apps/web/src/App.tsx"), true);
  assert.equal(globToRegExp("apps/**").test("packages/api/src/app.ts"), false);
  assert.equal(globToRegExp("docs/BACKLOG*.md").test("docs/BACKLOG-V2.md"), true);
});

test("credential evidence contains counts but never matched values", () => {
  const credential = `ghp_${"A".repeat(24)}`;
  const findings = scanTextFindings("fixture.txt", `token=${credential}\n`);
  assert.deepEqual(findings, [{ category: "credential", count: 1 }]);
  assert.equal(JSON.stringify(findings).includes(credential), false);
});

test("only exact placeholder forms avoid a credential blocker", () => {
  const adversarial = "production-token-that-is-not-a-placeholder";
  const findings = scanTextFindings(".env.example", `API_KEY=${adversarial}\n`);
  assert.deepEqual(findings, [{ category: "credential", count: 1 }]);
  assert.equal(JSON.stringify(findings).includes(adversarial), false);

  assert.deepEqual(
    scanTextFindings(
      ".env.example",
      "FIRST_SECRET=\nSECOND_TOKEN=CHANGE_ME\nTHIRD_API_KEY=${INJECTED_API_KEY}\n",
    ),
    [{ category: "credential-placeholder", count: 3 }],
  );
});

test("repository-wide deny rules take precedence over reviewed source rules", () => {
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  for (const path of [
    "apps/web/runtime/session.stdout",
    "apps/web/coverage/operator.dump",
    "packages/api/private/operator-notes.md",
    "apps/web/src/runtime/session.ts",
  ]) {
    const scope = scopeFor(path, manifest);
    assert.equal(scope.classification, "excluded", path);
    assert.ok(scope.denies.length > 0, path);
  }

  assert.equal(
    scopeFor("packages/api/src/operator-notes.md", manifest).classification,
    "unclassified",
  );
});

test("email and private-path evidence is redacted to metadata", () => {
  const email = ["person", "private.example"].join("@");
  const privatePath = ["", "Users", "private-person", "project"].join("/");
  const sensitive = `${email} ${privatePath}`;
  const findings = scanTextFindings("fixture.txt", sensitive);
  assert.deepEqual(findings, [
    { category: "private-absolute-path", count: 1 },
    { category: "pii-email", count: 1 },
  ]);
  assert.equal(JSON.stringify(findings).includes("private-person"), false);
  assert.equal(JSON.stringify(findings).includes("person@"), false);
});

/** The address rule has to point at people. Every shape below is a Git remote:
 *  the credential or service login sits where a mailbox would, and reading it as
 *  personal data spends a blocker on a string that names no one. Each is written
 *  the way this repository's own tests write them. */
test("git remote userinfo is not read as a personal address", () => {
  const remotes = [
    "ssh://git@github.com/owner/name.git",
    "git@github.com:owner/name.git",
    "https://user:password@github.com/owner/name.git",
    "https://ghp_exampletoken@github.com/owner/name.git",
    "https://x-access-token:token@github.com/owner/name.git",
    "ssh://git:secret@github.com/owner/name.git",
    "ghp_exampletoken@github.com:owner/name.git",
    "ssh://x-access-token@github.com/owner/name.git",
    "oauth2@gitlab.com:owner/name.git",
    "token@github.com",
  ];
  for (const remote of remotes) {
    assert.deepEqual(scanTextFindings("fixture.ts", `const url = "${remote}";\n`), [], remote);
  }
});

/** The negative control for the rule above: narrowing what counts as an address
 *  must not stop counting addresses. A mailbox written as a mailbox is still PII,
 *  including on a line that also carries a URL — proximity to a scheme is not the
 *  test, occupying the userinfo position is. */
test("a real address is still counted next to a url", () => {
  const address = ["alice.smith", "corp.example.invalid"].join("@");
  assert.deepEqual(scanTextFindings("fixture.md", `mail ${address}\n`), [
    { category: "pii-email", count: 1 },
  ]);
  assert.deepEqual(
    scanTextFindings("fixture.md", `see https://github.com/owner/name and mail ${address}\n`),
    [{ category: "pii-email", count: 1 }],
  );
  assert.deepEqual(scanTextFindings("fixture.md", `<${address}>: reachable\n`), [
    { category: "pii-email", count: 1 },
  ]);
});

test("the checked-out tree is fully classified", () => {
  const { report, includedPaths } = scanRepository(undefined, { requireClean: false });
  assert.equal(report.summary.countsByDisposition.blocker, 0);
  assert.equal(report.summary.countsByCategory.credential, 0);
  assert.equal(report.summary.countsByCategory["pii-government-id"], 0);
  assert.equal(report.scope.includedFiles, includedPaths.length);
  assert.equal(report.scope.unclassifiedFiles, 0);
  assert.equal(report.scope.overlappingFiles, 0);
  assert.equal(
    report.scope.trackedFiles + report.scope.mintedFiles,
    report.scope.includedFiles +
      report.scope.excludedFiles +
      report.scope.unclassifiedFiles +
      report.scope.overlappingFiles,
  );
  assert.equal(includedPaths.includes("LICENSE"), true);
  assert.equal(includedPaths.includes("public-snapshot.json"), true);
});

test("the merge gate executes snapshot and auto-deploy contracts", () => {
  const gate = readFileSync("scripts/merge-gate.sh", "utf8");
  // A gate step is a label followed by the command it runs, either as a serial
  // `step "label" <command>` or as one member of a concurrent group, which is
  // the same pair indented under parallel_steps. Anchoring at the start of a
  // line is what stops a mention in a comment from satisfying this.
  for (const script of ["test:snapshot-scan", "snapshot:scan", "test:auto-deploy"]) {
    assert.match(
      gate,
      new RegExp(`^(?:step |\\s+)"[^"\\n]+" npm run ${script}`, "m"),
      `${script} is absent from the merge gate`,
    );
  }
});

test("an approved credential on the published surface is always a blocker", () => {
  const credential = `ghp_${"A".repeat(24)}`;
  withRepositoryFixture({
    files: { "published.txt": `token=${credential}\n` },
    manifest: baseManifest({
      include: ["published.txt"],
      exclude: ["public-snapshot.json", "scripts/**"],
      approvedFindings: [{
        category: "credential",
        glob: "published.txt",
        reason: "an approval must not make this safe",
      }],
    }),
    copyScanner: true,
  }, (root) => {
    const { report } = scanRepository(root, { requireClean: true });
    const flagged = report.findings.filter((finding) => finding.category === "credential");
    assert.equal(report.summary.countsByDisposition.blocker, 1);
    assert.deepEqual(flagged.map((finding) => finding.disposition), ["blocker"]);
    assert.equal(JSON.stringify(report).includes(credential), false, "no matched value may be emitted");

    const cli = spawnSync(process.execPath, ["scripts/public-snapshot-scan.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(cli.status, 1, cli.stderr);
    assert.equal(cli.stdout.includes(credential), false);
    assert.equal(cli.stderr.includes(credential), false);
  });
});

test("an include glob that matches no git-tracked path is a blocker", () => {
  withRepositoryFixture({
    files: { "published.txt": "safe text\n" },
    manifest: baseManifest({
      include: ["published.txt", "missing/**"],
      exclude: ["public-snapshot.json", "scripts/**"],
    }),
    copyScanner: true,
  }, (root) => {
    const { report } = scanRepository(root, { requireClean: true });
    assert.equal(report.summary.countsByDisposition.blocker, 1);
    assert.deepEqual(
      report.findings.filter((finding) => finding.disposition === "blocker"),
      [{
        category: "snapshot-scope",
        disposition: "blocker",
        path: "missing/**",
        count: 1,
        reason: "include glob matches no git-tracked path",
      }],
    );

    const cli = spawnSync(process.execPath, ["scripts/public-snapshot-scan.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(cli.status, 1, cli.stderr);
  });
});

test("manifest paths reject traversal, absolute, non-normalized, NUL, and duplicate entries", () => {
  const cases = [
    ["../outside.txt"],
    ["/absolute.txt"],
    ["nested/../outside.txt"],
    ["bad\0path"],
    ["same.txt", "same.txt"],
  ];
  for (const mintedArtifacts of cases) {
    withRepositoryFixture({
      manifest: baseManifest({ exclude: ["public-snapshot.json"], mintedArtifacts }),
    }, (root) => {
      assert.throws(() => scanRepository(root, { requireClean: true }), /manifest minted artifact/);
    });
  }
});

test("tracked and minted paths cannot escape or resolve through symlinks", () => {
  withRepositoryFixture({
    symlinks: { "published-link": "public-snapshot.json" },
    manifest: baseManifest({ include: ["published-link"], exclude: ["public-snapshot.json"] }),
  }, (root) => {
    assert.throws(
      () => scanRepository(root, { requireClean: true }),
      /included tracked path must be a regular Git file/,
    );
  });

  const outside = mkdtempSync(join(tmpdir(), "agentos-snapshot-outside-"));
  const secret = `ghp_${"B".repeat(24)}`;
  writeFileSync(join(outside, "secret.txt"), secret);
  try {
    withRepositoryFixture({
      manifest: baseManifest({
        exclude: ["public-snapshot.json"],
        mintedArtifacts: ["minted/secret.txt"],
      }),
    }, (root) => {
      mkdirSync(join(root, "minted"));
      symlinkSync(join(outside, "secret.txt"), join(root, "minted/secret.txt"));
      assert.throws(() => scanRepository(root, { requireClean: true }), /regular file/);
      const cliScanner = fileURLToPath(new URL("./public-snapshot-scan.mjs", import.meta.url));
      const cli = spawnSync(process.execPath, ["-e", [
        `import(${JSON.stringify(new URL(`file://${cliScanner}`).href)})`,
        `.then(({scanRepository}) => scanRepository(${JSON.stringify(root)}, {requireClean:true}))`,
      ].join("")], { encoding: "utf8" });
      assert.notEqual(cli.status, 0);
      assert.equal(`${cli.stdout}${cli.stderr}`.includes(secret), false, "outside bytes must not be emitted");
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("tracked bytes come from the reported commit even when the worktree changes", () => {
  withRepositoryFixture({
    files: { "published.txt": "safe text\n" },
    manifest: baseManifest({ include: ["published.txt"], exclude: ["public-snapshot.json"] }),
  }, (root) => {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "published.txt"), `ghp_${"C".repeat(24)}\n`);
    const { report } = scanRepository(root, { requireClean: false });
    assert.equal(report.commit, commit);
    assert.equal(report.source, "git-objects");
    assert.equal(report.summary.countsByCategory.credential, 0);
    assert.throws(() => scanRepository(root, { requireClean: true }), /tracked worktree must match HEAD/);
  });
});

test("binary detection examines bytes after the first 8192", () => {
  withRepositoryFixture({
    files: { "late-binary.dat": Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0, 1, 2])]) },
    manifest: baseManifest({ include: ["late-binary.dat"], exclude: ["public-snapshot.json"] }),
  }, (root) => {
    const { report } = scanRepository(root, { requireClean: true });
    assert.equal(report.summary.countsByCategory["binary-material"], 1);
    assert.equal(report.summary.countsByDisposition.blocker, 1);
  });
});

test("the retired repository CLI is absent from snapshot authority", () => {
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  const globs = manifest.include.map((entry) => entry.glob);
  assert.equal(globs.some((glob) => glob === "packages/cli" || glob.startsWith("packages/cli/")), false);
});

const PROJECT_MERGE_GATE_MANIFEST_ENTRIES = [
  "docs/repo-contract/merge-gate.sh",
  "scripts/repo-contract-merge-gate.test.mjs",
];

test("the project merge-gate contract and proof are published by exact name", () => {
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  const included = new Set(manifest.include.map((entry) => entry.glob));
  for (const path of PROJECT_MERGE_GATE_MANIFEST_ENTRIES) {
    assert.equal(included.has(path), true, `${path} must be published by exact name`);
    assert.equal(scopeFor(path, manifest).classification, "included", `${path} must classify as included`);
    assert.equal(
      execFileSync("git", ["ls-files", path]).toString("utf8").trim(),
      path,
      `${path} must be tracked, not merely present on disk`,
    );
  }
  assert.equal(
    included.has("docs/runbooks/add-a-project.md"),
    true,
    "the add-project runbook must remain published by exact name",
  );
  assert.equal(
    scopeFor("docs/runbooks/add-a-project.md", manifest).classification,
    "included",
    "the add-project runbook must remain classified as included",
  );
});

test("the docs surface is closed and named one file at a time", () => {
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  const docs = manifest.include.map((entry) => entry.glob).filter((glob) => glob.startsWith("docs/"));
  assert.ok(docs.length > 0, "the manifest must publish at least one docs path");
  for (const glob of docs) {
    assert.doesNotMatch(glob, /[*?[\]{}]/u, `${glob} must name one literal file`);
  }
});

test("the six release documents the inventory names are published, and tracked", () => {
  // The release artifact inventory names exactly these six pages plus the four
  // root governance files. A manifest entry for a file that is not tracked
  // publishes nothing, and a tracked file with no entry is a scan failure, so
  // both halves are asserted here rather than assumed from either one.
  const released = [
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/release/developer-preview.md",
    "docs/release/license-and-assets.md",
    "docs/release/migration-and-recovery.md",
    "docs/release/v0.1.0-release-notes.md",
    "docs/release/security.md",
    "docs/release/support-matrix.md",
  ];
  const manifest = JSON.parse(readFileSync("public-snapshot.json", "utf8"));
  const included = new Set(manifest.include.map((entry) => entry.glob));
  for (const path of released) {
    assert.equal(included.has(path), true, `${path} must be published by exact name`);
    assert.equal(
      execFileSync("git", ["ls-files", path]).toString("utf8").trim(),
      path,
      `${path} must be tracked, not merely present on disk`,
    );
    assert.equal(scopeFor(path, manifest).classification, "included", `${path} must classify as included`);
  }
  const { report } = scanRepository(undefined, { requireClean: false });
  assert.equal(report.scope.unclassifiedFiles, 0);
});

test("every workspace manifest records the same first-party version", () => {
  // One version across the root and every workspace, with `private` intact.
  // A release that ships two versions of itself is ambiguous about which one
  // the tag names, and a manifest that lost `private: true` is one `npm publish`
  // away from a registry entry nobody decided to create.
  const manifests = execFileSync("git", ["ls-files", "package.json", "apps/*/package.json", "packages/*/package.json"])
    .toString("utf8").trim().split("\n");
  assert.equal(manifests.length, 9, "expected the root manifest and eight workspace manifests");
  const releaseVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  for (const path of manifests) {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(pkg.version, releaseVersion, `${path} must record version ${releaseVersion}`);
    assert.equal(pkg.private, true, `${path} must stay private`);
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (!name.startsWith("@anneal/")) continue;
        assert.equal(range, releaseVersion, `${path} must pin ${name} to the exact release version`);
      }
    }
  }
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(lock.version, releaseVersion, "the lockfile must record the same root version");
});
