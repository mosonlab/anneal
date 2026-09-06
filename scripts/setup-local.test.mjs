// Tests for `npm run setup:local`.
//
// The pure helpers are exercised in-process. Everything about publication is
// exercised against a real filesystem in a real temporary directory, and the
// race is exercised with two real processes held at a barrier immediately
// before `link(2)` — a single-process simulation of an atomic publication
// proves nothing about the primitive it is supposed to be testing.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { scanTextFindings } from "./public-snapshot-scan.mjs";
import {
  CONFIG_FILE_MODE,
  CONFIG_FILE_NAME,
  DATABASE_DEFAULTS,
  EXIT_CODES,
  REQUIRED_KEYS,
  SETUP_CLASSES,
  SUPPORTED_NODE_RANGE,
  TEMPORARY_PREFIX,
  UPGRADE_GENERATED_KEYS,
  composeDatabaseUrl,
  generateConfiguration as generateConfigurationWithoutGitHubToken,
  isSupportedNodeVersion,
  parseArguments,
  parseEnvAssignments,
  parseSemanticVersion,
  publishConfiguration,
  renderEnvFile,
  runSetup as runSetupWithoutGitHubToken,
  validateEnvContent,
} from "./setup-local.mjs";

const TEST_GITHUB_READ_TOKEN = "setup-local-test-token";
const generateConfiguration = (randomBytes) =>
  generateConfigurationWithoutGitHubToken(randomBytes, TEST_GITHUB_READ_TOKEN);
const runSetup = (options = {}) => runSetupWithoutGitHubToken({
  githubReadToken: Object.hasOwn(options, "githubReadToken")
    ? options.githubReadToken
    : TEST_GITHUB_READ_TOKEN,
  ...options,
});

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const modulePath = fileURLToPath(new URL("./setup-local.mjs", import.meta.url));

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "agentos-setup-local-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Deterministic bytes that still differ between calls and between seeds, so a
 *  test knows every value a given writer will produce without any process ever
 *  printing one. */
function seededRandomBytes(seed) {
  let call = 0;
  return (byteLength) => {
    const buffer = Buffer.alloc(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
      buffer[index] = (seed * 31 + call * 7 + index) % 256;
    }
    call += 1;
    return buffer;
  };
}

function secretValuesOf(values) {
  return [
    values.databasePassword,
    values.operatorToken,
    values.runnerToken,
    values.sessionCookieSecret,
    values.secretEncryptionKey,
  ];
}

function collectOutput() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

// ---------------------------------------------------------------------------
// Node version predicate
// ---------------------------------------------------------------------------

test("the Node predicate implements exactly ^20.19.0 || ^22.13.0 || >=24", () => {
  const supported = ["20.19.0", "20.19.5", "20.20.1", "22.13.0", "22.17.0", "24.0.0", "24.4.1", "26.5.0"];
  const refused = ["18.20.8", "20.0.0", "20.18.3", "20.18.9", "21.0.0", "21.7.3", "22.0.0", "22.12.0", "23.0.0"];

  for (const version of supported) {
    assert.equal(isSupportedNodeVersion(version), true, `${version} must be supported`);
    assert.equal(isSupportedNodeVersion(`v${version}`), true, `v${version} must be supported`);
  }
  for (const version of refused) {
    assert.equal(isSupportedNodeVersion(version), false, `${version} must be refused`);
  }
});

test("the Node predicate refuses what it cannot read, including prereleases", () => {
  for (const version of ["", "22", "22.12", "not-a-version", "22.12.0-nightly", "23.0.0-pre", null, undefined, 22]) {
    assert.equal(isSupportedNodeVersion(version), false, `${String(version)} must be refused`);
  }
  assert.equal(parseSemanticVersion("22.12.0-nightly").prerelease, "nightly");
  assert.equal(parseSemanticVersion("v20.19.0").major, 20);
});

test("the predicate, the root engine, the lockfile and every published README carry the same string", () => {
  const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(rootPackage.engines.node, SUPPORTED_NODE_RANGE);

  // npm regenerates this block from the manifest, so a stale copy is not
  // cosmetic: the next `npm install` rewrites the lockfile and dirties the
  // tree, which is exactly what `npm run snapshot:scan` refuses to run on.
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].engines.node, SUPPORTED_NODE_RANGE, "package-lock.json root engines.node");

  // Every README the repository publishes, not just the English one. A
  // translated prerequisite is a published prerequisite.
  const readmes = readdirSync(repositoryRoot).filter((name) => /^README(\.[^/]+)?\.md$/.test(name));
  for (const required of ["README.md", "README.zh-CN.md"]) {
    assert.ok(readmes.includes(required), `${required} must exist for this test to mean anything`);
  }
  for (const name of readmes) {
    const text = readFileSync(join(repositoryRoot, name), "utf8");
    const published = /Node\.js (?:satisfying|满足) `([^`]+)`/.exec(text);
    assert.ok(published, `${name} must publish the Node range in a code span`);
    assert.equal(published[1], SUPPORTED_NODE_RANGE, name);
  }
});

test("an unsupported Node refuses before generating anything and leaves the directory alone", () => {
  withTemporaryDirectory((directory) => {
    const stdout = collectOutput();
    const stderr = collectOutput();
    const result = runSetup({
      directory,
      nodeVersion: "20.18.3",
      randomBytes: () => assert.fail("no value may be generated on an unsupported Node"),
      stdout: stdout.write,
      stderr: stderr.write,
    });

    assert.equal(result.setupClass, SETUP_CLASSES.unsupportedNode);
    assert.equal(result.exitCode, EXIT_CODES[SETUP_CLASSES.unsupportedNode]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(join(directory, CONFIG_FILE_NAME)), false);

    // The range reaches the caller as a value, not as free text on a stream.
    assert.equal(result.reason, `node-out-of-range:20.18.3:${SUPPORTED_NODE_RANGE}`);
    assert.deepEqual(stdout.lines, [`setup:local ${SETUP_CLASSES.unsupportedNode}`]);
    assert.deepEqual(stderr.lines, []);
  });
});

test("an unsupported Node leaves an existing file untouched too", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    const before = renderEnvFile(generateConfiguration(seededRandomBytes(11)));
    writeFileSync(target, before);
    const result = runSetup({
      directory,
      nodeVersion: "22.11.0",
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.setupClass, SETUP_CLASSES.unsupportedNode);
    assert.equal(readFileSync(target, "utf8"), before);
  });
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

test("every generated secret has the required length, encoding and distinctness", () => {
  const values = generateConfiguration();

  assert.equal(Buffer.from(values.operatorToken, "base64url").length, 32);
  assert.equal(Buffer.from(values.runnerToken, "base64url").length, 32);
  assert.equal(Buffer.from(values.sessionCookieSecret, "base64").length, 32);
  // The API decodes this one and refuses anything that is not exactly 32 bytes.
  assert.equal(Buffer.from(values.secretEncryptionKey, "base64").length, 32);
  assert.equal(Buffer.from(values.databasePassword, "base64url").length, 24);

  assert.match(values.databasePassword, /^[A-Za-z0-9_-]+$/);
  assert.match(values.operatorToken, /^[A-Za-z0-9_-]+$/);
  assert.match(values.runnerToken, /^[A-Za-z0-9_-]+$/);
  assert.match(values.secretEncryptionKey, /^[A-Za-z0-9+/]+={0,2}$/);

  const secrets = secretValuesOf(values);
  assert.equal(new Set(secrets).size, secrets.length, "no two generated values may be equal");
  assert.notEqual(values.operatorToken, values.runnerToken);
});

test("two runs never produce the same material", () => {
  const first = secretValuesOf(generateConfiguration());
  const second = secretValuesOf(generateConfiguration());
  for (const value of first) assert.equal(second.includes(value), false);
});

test("generation refuses a source that cannot tell two principals apart", () => {
  const constantBytes = (byteLength) => Buffer.alloc(byteLength, 0x41);
  assert.throws(
    () => generateConfiguration(constantBytes),
    (error) => error.setupClass === SETUP_CLASSES.entropyUnusable,
  );
});

test("generation refuses before drawing entropy without an operator GitHub token", () => {
  let draws = 0;
  assert.throws(
    () => generateConfigurationWithoutGitHubToken(() => { draws += 1; return Buffer.alloc(32); }),
    (error) => error instanceof Error
      && error.name === "SetupError"
      && error.reason === "missing-key:GITHUB_READ_TOKEN",
  );
  assert.equal(draws, 0);
});

test("the generated DATABASE_URL names its schema and carries the generated password", () => {
  const values = generateConfiguration();
  const url = new URL(values.databaseUrl);

  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, String(DATABASE_DEFAULTS.port));
  // The composed Goal 5a0 preflight reads the schema exactly this way and stops
  // when it is absent (packages/db/prisma/preflight-goal-execution.ts).
  const schema = url.searchParams.get("schema");
  assert.ok(schema);
  assert.notEqual(schema, "");
  assert.equal(decodeURIComponent(url.password), values.databasePassword);
  assert.equal(url.username, DATABASE_DEFAULTS.user);
});

test("a URL-safe password survives the URL without re-encoding", () => {
  for (let seed = 0; seed < 40; seed += 1) {
    const values = generateConfiguration(seededRandomBytes(seed));
    const url = new URL(values.databaseUrl);
    assert.equal(url.password, values.databasePassword, "the password must need no percent-encoding");
  }
  const composed = composeDatabaseUrl({ password: "abc-DEF_123", schema: "agentos" });
  assert.equal(new URL(composed).searchParams.get("schema"), "agentos");
});

test("the rendered file agrees with itself, exposes no browser token, and validates", () => {
  const values = generateConfiguration();
  const rendered = renderEnvFile(values);
  const assignments = parseEnvAssignments(rendered);

  for (const key of REQUIRED_KEYS) assert.ok(assignments.has(key), `${key} must be present`);
  assert.match(assignments.get("RUNNER_ID"), /^runner-[A-Za-z0-9_-]{16}$/u);
  assert.equal(assignments.get("POSTGRES_PASSWORD"), values.databasePassword);
  assert.equal(assignments.get("DATABASE_URL"), values.databaseUrl);
  assert.equal(assignments.get("API_HOST"), "127.0.0.1");
  assert.equal(assignments.get("OPERATOR_TOKEN"), values.operatorToken);
  assert.equal(assignments.get("GITHUB_READ_TOKEN"), TEST_GITHUB_READ_TOKEN);
  assert.notEqual(assignments.get("OPERATOR_TOKEN"), assignments.get("RUNNER_TOKEN"));

  for (const key of assignments.keys()) {
    assert.doesNotMatch(key, /^VITE_/, `${key} would be compiled into the browser bundle`);
  }
  assert.equal(/VITE_[A-Z0-9_]*TOKEN/.test(rendered), false);
  assert.equal(rendered.endsWith("\n"), true);
  assert.deepEqual(validateEnvContent(rendered), { valid: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// Validation of an existing file
// ---------------------------------------------------------------------------

test("validation refuses placeholders, and says so without quoting them", () => {
  const placeholderFile = readFileSync(join(repositoryRoot, ".env.example"), "utf8");
  const { valid, reasons } = validateEnvContent(placeholderFile);

  assert.equal(valid, false);
  assert.ok(reasons.some((reason) => reason.startsWith("placeholder-value:")));
  for (const reason of reasons) assert.doesNotMatch(reason, /CHANGE_ME/);
});

test("validation requires a non-placeholder GitHub read token", () => {
  const rendered = renderEnvFile(generateConfiguration());
  assert.deepEqual(
    validateEnvContent(rendered.replace(/^GITHUB_READ_TOKEN=.*\n/m, "")).reasons,
    ["missing-key:GITHUB_READ_TOKEN"],
  );
  assert.deepEqual(
    validateEnvContent(rendered.replace(/^GITHUB_READ_TOKEN=.*$/m, "GITHUB_READ_TOKEN=CHANGE_ME")).reasons,
    ["placeholder-value:GITHUB_READ_TOKEN"],
  );
});

test("validation names every defect it can find, and never a value", () => {
  const values = generateConfiguration();
  const cases = [
    ["missing-key:OPERATOR_TOKEN", renderEnvFile(values).replace(/^OPERATOR_TOKEN=.*$/m, "")],
    [
      "operator-runner-token-identical",
      renderEnvFile(values).replace(/^RUNNER_TOKEN=.*$/m, `RUNNER_TOKEN=${values.operatorToken}`),
    ],
    [
      "encryption-key-not-32-bytes:AGENTOS_SECRET_ENCRYPTION_KEY",
      renderEnvFile(values).replace(
        /^AGENTOS_SECRET_ENCRYPTION_KEY=.*$/m,
        `AGENTOS_SECRET_ENCRYPTION_KEY=${Buffer.alloc(16, 9).toString("base64")}`,
      ),
    ],
    [
      "database-url-missing-schema:DATABASE_URL",
      renderEnvFile(values).replace(/\?schema=public$/m, ""),
    ],
    [
      "database-password-mismatch:DATABASE_URL",
      renderEnvFile(values).replace(
        /^POSTGRES_PASSWORD=.*$/m,
        `POSTGRES_PASSWORD=${Buffer.alloc(24, 3).toString("base64url")}`,
      ),
    ],
    [
      "browser-exposed-token:VITE_API_TOKEN",
      `${renderEnvFile(values)}VITE_API_TOKEN=${values.operatorToken}\n`,
    ],
    ["placeholder-value:SESSION_COOKIE_SECRET", renderEnvFile(values).replace(/^SESSION_COOKIE_SECRET=.*$/m, "SESSION_COOKIE_SECRET=CHANGE_ME")],
    ["secret-too-short:RUNNER_TOKEN", renderEnvFile(values).replace(/^RUNNER_TOKEN=.*$/m, "RUNNER_TOKEN=short")],
    ["database-url-unparsable:DATABASE_URL", renderEnvFile(values).replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=not a url")],
  ];

  for (const [expectedReason, text] of cases) {
    const { valid, reasons } = validateEnvContent(text);
    assert.equal(valid, false, `${expectedReason} must invalidate the file`);
    assert.ok(reasons.includes(expectedReason), `expected ${expectedReason}, got ${reasons.join(" ")}`);
    for (const reason of reasons) {
      for (const secret of secretValuesOf(values)) {
        assert.equal(reason.includes(secret), false, "a reason must never carry a value");
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Publication against a real filesystem
// ---------------------------------------------------------------------------

test("a first run creates the file at mode 0600 and prints no value", () => {
  withTemporaryDirectory((directory) => {
    const stdout = collectOutput();
    const stderr = collectOutput();
    const result = runSetup({ directory, stdout: stdout.write, stderr: stderr.write });

    assert.equal(result.setupClass, SETUP_CLASSES.created);
    assert.equal(result.exitCode, 0);

    const target = join(directory, CONFIG_FILE_NAME);
    const contents = readFileSync(target, "utf8");
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(validateEnvContent(contents).valid, true);

    const output = [...stdout.lines, ...stderr.lines].join("\n");
    assert.match(output, /configuration-created/);
    const assignments = parseEnvAssignments(contents);
    for (const key of ["POSTGRES_PASSWORD", "OPERATOR_TOKEN", "RUNNER_TOKEN", "SESSION_COOKIE_SECRET", "AGENTOS_SECRET_ENCRYPTION_KEY"]) {
      assert.equal(output.includes(assignments.get(key)), false, `${key} reached the output`);
    }
    assert.equal(output.includes(assignments.get("DATABASE_URL")), false, "the rendered DATABASE_URL reached the output");
    assert.equal(output.includes(assignments.get("GITHUB_READ_TOKEN")), false, "GITHUB_READ_TOKEN reached the output");

    // Nothing of this invocation's own is left behind.
    assert.deepEqual(
      readdirSync(directory).filter((name) => name !== CONFIG_FILE_NAME),
      [],
    );
  });
});

test("a first run refuses to create a configuration without an operator-provided GitHub token", () => {
  withTemporaryDirectory((directory) => {
    const missing = runSetup({ directory, githubReadToken: undefined, stdout: () => {}, stderr: () => {} });
    assert.equal(missing.setupClass, SETUP_CLASSES.invalid);
    assert.equal(missing.reason, "missing-key:GITHUB_READ_TOKEN");
    assert.equal(existsSync(join(directory, CONFIG_FILE_NAME)), false);

    const placeholder = runSetup({ directory, githubReadToken: "CHANGE_ME", stdout: () => {}, stderr: () => {} });
    assert.equal(placeholder.setupClass, SETUP_CLASSES.invalid);
    assert.equal(placeholder.reason, "placeholder-value:GITHUB_READ_TOKEN");
    assert.equal(existsSync(join(directory, CONFIG_FILE_NAME)), false);
  });
});

test("a second run changes nothing and reports the file it found", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    runSetup({ directory, stdout: () => {}, stderr: () => {} });
    const first = readFileSync(target);
    const mode = statSync(target).mode;

    const stdout = collectOutput();
    const result = runSetup({
      directory,
      randomBytes: () => assert.fail("a valid file must be recognised before anything is generated"),
      stdout: stdout.write,
      stderr: () => {},
    });

    assert.equal(result.setupClass, SETUP_CLASSES.valid);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(readFileSync(target), first, "the bytes must be identical");
    assert.equal(statSync(target).mode, mode);
    assert.match(stdout.lines.join("\n"), /configuration-valid/);
  });
});

test("an invalid existing file is refused and left byte-identical", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    const before = "POSTGRES_DB=agentos\nOPERATOR_TOKEN=CHANGE_ME\n";
    writeFileSync(target, before);
    // 0600 so this case tests the content check and nothing else; the mode
    // check has its own tests below.
    chmodSync(target, CONFIG_FILE_MODE);

    const stdout = collectOutput();
    const stderr = collectOutput();
    const result = runSetup({ directory, stdout: stdout.write, stderr: stderr.write });

    assert.equal(result.setupClass, SETUP_CLASSES.invalid);
    assert.notEqual(result.exitCode, 0);
    assert.equal(readFileSync(target, "utf8"), before);
    assert.match(result.reason, /placeholder-value:OPERATOR_TOKEN/);
    assert.deepEqual(stdout.lines, [`setup:local ${SETUP_CLASSES.invalid}`]);
    assert.deepEqual(stderr.lines, []);
  });
});

test("a dry run generates nothing and writes nothing", () => {
  withTemporaryDirectory((directory) => {
    const stdout = collectOutput();
    const result = runSetup({
      directory,
      dryRun: true,
      randomBytes: () => assert.fail("a dry run must not generate a value"),
      stdout: stdout.write,
      stderr: () => {},
    });

    assert.equal(result.setupClass, SETUP_CLASSES.created);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(readdirSync(directory), []);
    assert.match(stdout.lines.join("\n"), /dry-run configuration-created/);
  });
});

test("a dry run against an existing file reports it without touching it", () => {
  withTemporaryDirectory((directory) => {
    runSetup({ directory, stdout: () => {}, stderr: () => {} });
    const before = readFileSync(join(directory, CONFIG_FILE_NAME));

    const stdout = collectOutput();
    const result = runSetup({ directory, dryRun: true, stdout: stdout.write, stderr: () => {} });
    assert.equal(result.setupClass, SETUP_CLASSES.valid);
    assert.deepEqual(readFileSync(join(directory, CONFIG_FILE_NAME)), before);
    assert.match(stdout.lines.join("\n"), /dry-run configuration-valid/);
  });
});

// ---------------------------------------------------------------------------
// What is already at the target: its type and mode, before its contents
// ---------------------------------------------------------------------------

function runCapturing(options) {
  const stdout = collectOutput();
  const stderr = collectOutput();
  const result = runSetup({ ...options, stdout: stdout.write, stderr: stderr.write });
  return { result, stdout: stdout.lines, stderr: stderr.lines };
}

/** The whole machine-readable contract: one class line on stdout, nothing on
 *  stderr. Asserted with `deepEqual` on purpose — a `match` would pass while
 *  free text sat next to the class. */
function assertClassOnly(run, expectedClass, { dryRun = false } = {}) {
  assert.equal(run.result.setupClass, expectedClass);
  assert.equal(run.result.exitCode, EXIT_CODES[expectedClass]);
  assert.deepEqual(run.stdout, [`setup:local ${dryRun ? "dry-run " : ""}${expectedClass}`]);
  assert.deepEqual(run.stderr, []);
}

test("an existing configuration that is not mode 0600 is refused, whatever it contains", () => {
  // Contents a run would otherwise call `configuration-valid`: the point is
  // that the mode alone decides, and it decides before the bytes are read.
  for (const mode of [0o644, 0o640, 0o604, 0o666, 0o660, 0o700, 0o601]) {
    withTemporaryDirectory((directory) => {
      const target = join(directory, CONFIG_FILE_NAME);
      const contents = renderEnvFile(generateConfiguration(seededRandomBytes(41)));
      writeFileSync(target, contents);
      chmodSync(target, mode);

      const run = runCapturing({
        directory,
        randomBytes: () => assert.fail("nothing may be generated while a file is in the way"),
      });

      assertClassOnly(run, SETUP_CLASSES.invalid);
      assert.notEqual(run.result.exitCode, 0, `mode ${mode.toString(8)} must exit nonzero`);
      assert.equal(run.result.reason, `unsafe-mode:${mode.toString(8).padStart(4, "0")}:expected-0600`);

      // Refused, not repaired. This command never modifies a file it did not
      // create, and silently tightening the mode would hide the exposure that
      // already happened.
      assert.equal(readFileSync(target, "utf8"), contents);
      assert.equal(statSync(target).mode & 0o777, mode);
    });
  }
});

test("the same contents at 0600 are accepted, so the mode is what the refusal turns on", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    const contents = renderEnvFile(generateConfiguration(seededRandomBytes(41)));
    writeFileSync(target, contents);
    chmodSync(target, CONFIG_FILE_MODE);

    const run = runCapturing({ directory, randomBytes: () => assert.fail("a valid file needs no generation") });
    assertClassOnly(run, SETUP_CLASSES.valid);
    assert.equal(run.result.exitCode, 0);
    assert.equal(readFileSync(target, "utf8"), contents);
  });
});

test("a symbolic link where the configuration belongs is refused without being followed", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    const elsewhere = join(directory, "elsewhere.env");
    const contents = renderEnvFile(generateConfiguration(seededRandomBytes(43)));
    writeFileSync(elsewhere, contents);
    chmodSync(elsewhere, CONFIG_FILE_MODE);
    symlinkSync(elsewhere, target);

    const run = runCapturing({
      directory,
      randomBytes: () => assert.fail("nothing may be generated while a link is in the way"),
    });

    assertClassOnly(run, SETUP_CLASSES.invalid);
    assert.notEqual(run.result.exitCode, 0);
    assert.equal(run.result.reason, "not-a-regular-file:symbolic-link");

    // The link is a path into a tree this command does not own: it is left
    // exactly as found, and its target is neither read as configuration nor
    // written through.
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(readFileSync(elsewhere, "utf8"), contents);
  });
});

test("a directory where the configuration belongs is refused", () => {
  withTemporaryDirectory((directory) => {
    mkdirSync(join(directory, CONFIG_FILE_NAME));

    const run = runCapturing({
      directory,
      randomBytes: () => assert.fail("nothing may be generated while a directory is in the way"),
    });

    assertClassOnly(run, SETUP_CLASSES.invalid);
    assert.notEqual(run.result.exitCode, 0);
    assert.equal(run.result.reason, "not-a-regular-file:directory");
    assert.equal(lstatSync(join(directory, CONFIG_FILE_NAME)).isDirectory(), true);
  });
});

// ---------------------------------------------------------------------------
// The output contract: a stable class and nothing else
// ---------------------------------------------------------------------------

test("every in-process class writes exactly one class line to stdout and nothing to stderr", () => {
  // created
  withTemporaryDirectory((directory) => {
    assertClassOnly(runCapturing({ directory }), SETUP_CLASSES.created);
  });

  // valid, and the same class again under --dry-run
  withTemporaryDirectory((directory) => {
    runSetup({ directory, stdout: () => {}, stderr: () => {} });
    assertClassOnly(runCapturing({ directory }), SETUP_CLASSES.valid);
    assertClassOnly(runCapturing({ directory, dryRun: true }), SETUP_CLASSES.valid, { dryRun: true });
  });

  // created, under --dry-run, against an empty directory
  withTemporaryDirectory((directory) => {
    assertClassOnly(runCapturing({ directory, dryRun: true }), SETUP_CLASSES.created, { dryRun: true });
  });

  // invalid, on contents
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    writeFileSync(target, "OPERATOR_TOKEN=CHANGE_ME\n");
    chmodSync(target, CONFIG_FILE_MODE);
    assertClassOnly(runCapturing({ directory }), SETUP_CLASSES.invalid);
  });

  // unsupported node
  withTemporaryDirectory((directory) => {
    assertClassOnly(runCapturing({ directory, nodeVersion: "22.11.0" }), SETUP_CLASSES.unsupportedNode);
  });

  // unsupported filesystem
  withTemporaryDirectory((directory) => {
    const { fs } = recordingFileSystem({
      fsyncSync: () => {
        const error = new Error("not supported");
        error.code = "ENOTSUP";
        throw error;
      },
    });
    assertClassOnly(runCapturing({ directory, fs }), SETUP_CLASSES.unsupportedFilesystem);
  });

  // entropy unusable
  withTemporaryDirectory((directory) => {
    assertClassOnly(
      runCapturing({ directory, randomBytes: (byteLength) => Buffer.alloc(byteLength, 7) }),
      SETUP_CLASSES.entropyUnusable,
    );
    assert.deepEqual(readdirSync(directory), [], "nothing may be published from unusable entropy");
  });
});

// ---------------------------------------------------------------------------
// The publication primitive itself
// ---------------------------------------------------------------------------

/** The real calls, recorded. Recording is the only way to prove the durability
 *  calls happened at all: a successful `fsync` is invisible in the result. */
function recordingFileSystem(overrides = {}) {
  const calls = [];
  const record = (name, implementation) => (...args) => {
    calls.push({ name, args });
    return implementation(...args);
  };
  const base = {
    lstatSync: record("lstatSync", overrides.lstatSync ?? lstatSync),
    openSync: record("openSync", overrides.openSync ?? openSync),
    writeSync: record("writeSync", overrides.writeSync ?? writeSync),
    fchmodSync: record("fchmodSync", overrides.fchmodSync ?? fchmodSync),
    fsyncSync: record("fsyncSync", overrides.fsyncSync ?? fsyncSync),
    closeSync: record("closeSync", overrides.closeSync ?? closeSync),
    linkSync: record("linkSync", overrides.linkSync ?? linkSync),
    unlinkSync: record("unlinkSync", overrides.unlinkSync ?? unlinkSync),
    readFileSync: record("readFileSync", overrides.readFileSync ?? readFileSync),
  };
  return { fs: base, calls };
}

test("publication is O_EXCL, 0600, fsynced, linked, and the directory is fsynced twice after it", () => {
  withTemporaryDirectory((directory) => {
    const { fs, calls } = recordingFileSystem();
    const result = runSetup({ directory, fs, stdout: () => {}, stderr: () => {} });
    assert.equal(result.setupClass, SETUP_CLASSES.created);

    const opens = calls.filter((call) => call.name === "openSync");
    const temporaryOpen = opens.find((call) => String(call.args[0]).includes(".env.setup-local."));
    assert.ok(temporaryOpen, "the bytes must go to a same-directory temporary file first");
    assert.equal(String(temporaryOpen.args[0]).startsWith(join(directory, ".env.setup-local.")), true);
    assert.equal((temporaryOpen.args[1] & fsConstants.O_EXCL) !== 0, true, "O_EXCL");
    assert.equal((temporaryOpen.args[1] & fsConstants.O_CREAT) !== 0, true, "O_CREAT");
    assert.equal(temporaryOpen.args[2], 0o600);

    const chmod = calls.find((call) => call.name === "fchmodSync");
    assert.ok(chmod);
    assert.equal(chmod.args[1], 0o600);

    const names = calls.map((call) => call.name);
    const link = names.indexOf("linkSync");
    assert.ok(link > names.indexOf("fchmodSync"));
    assert.equal(names.includes("renameSync"), false, "rename is never the publication primitive");

    // One fsync proves the directory can be made durable before anything is
    // generated; one publishes the new entry; one publishes its removal.
    assert.equal(calls.filter((call) => call.name === "fsyncSync").length >= 4, true);
    const afterLink = names.slice(link);
    assert.equal(afterLink.filter((name) => name === "fsyncSync").length, 2);
    assert.equal(afterLink.includes("unlinkSync"), true, "the temporary name is removed after publication");
    assert.equal(afterLink.lastIndexOf("fsyncSync") > afterLink.indexOf("unlinkSync"), true);

    const linkCall = calls[link];
    assert.equal(linkCall.args[1], join(directory, CONFIG_FILE_NAME));
  });
});

test("a filesystem that cannot fsync a directory fails closed before anything is generated", () => {
  withTemporaryDirectory((directory) => {
    const { fs } = recordingFileSystem({
      fsyncSync: () => {
        const error = new Error("not supported");
        error.code = "ENOTSUP";
        throw error;
      },
    });
    const stdout = collectOutput();
    const result = runSetup({
      directory,
      fs,
      randomBytes: () => assert.fail("nothing may be generated once durability is known to be unavailable"),
      stdout: stdout.write,
      stderr: () => {},
    });

    assert.equal(result.setupClass, SETUP_CLASSES.unsupportedFilesystem);
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(readdirSync(directory), []);
  });
});

test("a filesystem without usable link semantics fails closed and removes only its own temporary file", () => {
  withTemporaryDirectory((directory) => {
    const { fs, calls } = recordingFileSystem({
      linkSync: () => {
        const error = new Error("not supported");
        error.code = "EPERM";
        throw error;
      },
    });
    const result = runSetup({ directory, fs, stdout: () => {}, stderr: () => {} });

    assert.equal(result.setupClass, SETUP_CLASSES.unsupportedFilesystem);
    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(join(directory, CONFIG_FILE_NAME)), false);
    assert.deepEqual(readdirSync(directory), [], "the temporary file must be gone");
    const unlinked = calls.filter((call) => call.name === "unlinkSync").map((call) => String(call.args[0]));
    assert.equal(unlinked.length, 1);
    assert.equal(unlinked[0].includes(".env.setup-local."), true);
  });
});

test("publishConfiguration refuses to replace a file that appeared after the check", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    const winner = "WINNER=1\n";
    assert.throws(
      () =>
        publishConfiguration({
          directory,
          contents: "LOSER=1\n",
          beforePublish: () => writeFileSync(target, winner),
        }),
      (error) => error.setupClass === SETUP_CLASSES.raced,
    );
    assert.equal(readFileSync(target, "utf8"), winner);
    assert.deepEqual(readdirSync(directory), [CONFIG_FILE_NAME]);
  });
});

// ---------------------------------------------------------------------------
// The real two-process race
// ---------------------------------------------------------------------------

const RACE_WRITER = `
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSetup } from ${JSON.stringify(modulePath)};

const [directory, seedText, label, barrierDirectory] = process.argv.slice(2);
const seed = Number(seedText);

const seededRandomBytes = () => {
  let call = 0;
  return (byteLength) => {
    const buffer = Buffer.alloc(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
      buffer[index] = (seed * 31 + call * 7 + index) % 256;
    }
    call += 1;
    return buffer;
  };
};

// Hold both writers at the instant before link(2), so the publication really is
// contended rather than accidentally serialised by process start-up.
const beforePublish = () => {
  writeFileSync(join(barrierDirectory, \`ready-\${label}\`), "");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  // Both writers are separately spawned node processes; the barrier only has to
  // outlast the slower one's start-up. Bounded so a writer that never arrives
  // throws below instead of hanging the suite, and sized for the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s), not for an idle host.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (readdirSync(barrierDirectory).filter((name) => name.startsWith("ready-")).length >= 2) return;
    Atomics.wait(sleeper, 0, 0, 5);
  }
  throw new Error("barrier-timeout");
};

const { exitCode } = runSetup({
  directory,
  randomBytes: seededRandomBytes(),
  githubReadToken: process.env.GITHUB_READ_TOKEN,
  beforePublish,
  stdout: (line) => process.stdout.write(line + "\\n"),
  stderr: (line) => process.stderr.write(line + "\\n"),
});
process.exitCode = exitCode;
`;

function runWriter(scriptPath, directory, seed, label, barrierDirectory) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, directory, String(seed), label, barrierDirectory], {
      env: { ...process.env, GITHUB_READ_TOKEN: TEST_GITHUB_READ_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr, label }));
  });
}

test("two real writers against one empty directory: exactly one creates the file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-setup-race-"));
  const harness = mkdtempSync(join(tmpdir(), "agentos-setup-harness-"));
  let barrierDirectory;
  try {
    const scriptPath = join(harness, "writer.mjs");
    writeFileSync(scriptPath, RACE_WRITER);
    barrierDirectory = mkdtempSync(join(tmpdir(), "agentos-setup-barrier-"));

    const seeds = { first: 3, second: 200 };
    const results = await Promise.all([
      runWriter(scriptPath, directory, seeds.first, "first", barrierDirectory),
      runWriter(scriptPath, directory, seeds.second, "second", barrierDirectory),
    ]);

    const created = results.filter((result) => result.stdout.includes(SETUP_CLASSES.created));
    const raced = results.filter((result) => result.stdout.includes(SETUP_CLASSES.raced));
    assert.equal(created.length, 1, `exactly one writer may create the file: ${JSON.stringify(results)}`);
    assert.equal(raced.length, 1, `the other writer must report the race: ${JSON.stringify(results)}`);
    assert.equal(created[0].code, 0);
    assert.notEqual(raced[0].code, 0);
    assert.equal(raced[0].code, EXIT_CODES[SETUP_CLASSES.raced]);
    assert.equal(raced[0].stdout.includes(SETUP_CLASSES.valid), false, "the loser must not validate or report success");

    // Both writers are deterministic, so the test knows every value each of them
    // held without either process ever printing one.
    const renderings = {
      first: renderEnvFile(generateConfiguration(seededRandomBytes(seeds.first))),
      second: renderEnvFile(generateConfiguration(seededRandomBytes(seeds.second))),
    };
    const winner = created[0].label;
    const loser = raced[0].label;
    const published = readFileSync(join(directory, CONFIG_FILE_NAME), "utf8");

    assert.equal(published, renderings[winner], "the published bytes must be the winner's complete bytes");
    const loserValues = secretValuesOf(generateConfiguration(seededRandomBytes(seeds[loser])));
    for (const value of loserValues) {
      assert.equal(published.includes(value), false, "no value of the losing writer may reach the file");
    }

    // Both writers, unconditionally. Checking "the first writer's values plus
    // the loser's" collapses to one set whenever the first writer is the loser,
    // and the winner's values would go unchecked in exactly the half of the
    // outcomes where the winner had the most to leak.
    const allOutput = results.map((result) => `${result.stdout}${result.stderr}`).join("\n");
    const everyGeneratedValue = [
      ...secretValuesOf(generateConfiguration(seededRandomBytes(seeds.first))),
      ...secretValuesOf(generateConfiguration(seededRandomBytes(seeds.second))),
    ];
    assert.equal(everyGeneratedValue.length, 10, "both writers' full secret sets must be under test");
    for (const value of everyGeneratedValue) {
      assert.equal(allOutput.includes(value), false, "no writer may print a generated value");
    }

    // Neither process may say anything but its class, either.
    for (const result of results) {
      assert.deepEqual(result.stdout.split("\n").filter(Boolean).length, 1, "one line of stdout per writer");
      assert.equal(result.stderr, "", "a writer may not write to stderr");
    }
    assert.equal(created[0].stdout, `setup:local ${SETUP_CLASSES.created}\n`);
    assert.equal(raced[0].stdout, `setup:local ${SETUP_CLASSES.raced}\n`);

    assert.deepEqual(readdirSync(directory), [CONFIG_FILE_NAME], "no temporary file may survive");
    assert.equal(statSync(join(directory, CONFIG_FILE_NAME)).mode & 0o777, CONFIG_FILE_MODE);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(harness, { recursive: true, force: true });
    if (barrierDirectory) rmSync(barrierDirectory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// An interrupted run: what it leaves behind, and what Git does with it
// ---------------------------------------------------------------------------

/** A throwaway repository carrying this repository's real `.gitignore`, so the
 *  question "would Git add this file?" is answered by Git rather than by a
 *  regular expression this test made up. */
function gitIgnoreOracle() {
  const repository = mkdtempSync(join(tmpdir(), "agentos-setup-ignore-"));
  execFileSync("git", ["init", "--quiet"], { cwd: repository, stdio: "ignore" });
  writeFileSync(join(repository, ".gitignore"), readFileSync(join(repositoryRoot, ".gitignore")));
  return {
    repository,
    // `git check-ignore` exits 0 when a pattern matches and 1 when none does.
    isIgnored(relativePath) {
      try {
        execFileSync("git", ["check-ignore", "--", relativePath], { cwd: repository, stdio: "ignore" });
        return true;
      } catch (error) {
        if (error.status === 1) return false;
        throw error;
      }
    },
  };
}

test("the temporary namespace this command writes into is ignored by the repository's .gitignore", () => {
  const oracle = gitIgnoreOracle();
  try {
    assert.equal(oracle.isIgnored(CONFIG_FILE_NAME), true, ".env itself must stay ignored");
    for (const name of [
      `${TEMPORARY_PREFIX}123.deadbeefcafe.tmp`,
      `${TEMPORARY_PREFIX}${process.pid}.0123456789ab.tmp`,
      `${TEMPORARY_PREFIX}whatever`,
    ]) {
      assert.equal(oracle.isIgnored(name), true, `${name} must be ignored`);
    }
    // The namespace, not everything next to it: a pattern broad enough to
    // swallow unrelated files would hide real work from `git status`.
    assert.equal(oracle.isIgnored("scripts/setup-local.mjs"), false);
    assert.equal(oracle.isIgnored(".env.example"), false);
  } finally {
    rmSync(oracle.repository, { recursive: true, force: true });
  }
});

const INTERRUPTED_WRITER = `
import { writeFileSync } from "node:fs";
import { runSetup } from ${JSON.stringify(modulePath)};

const [directory, signalPath] = process.argv.slice(2);

runSetup({
  directory,
  githubReadToken: process.env.GITHUB_READ_TOKEN,
  // At this instant the temporary file holds the complete .env bytes, is 0600
  // and is fsynced, and .env has not been linked yet. This is the window a
  // SIGKILL, a crash or a power cut lands in.
  beforePublish: () => {
    writeFileSync(signalPath, "");
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleeper, 0, 0, 60_000);
    throw new Error("this process was supposed to be killed");
  },
  stdout: () => {},
  stderr: () => {},
});
`;

test("a run killed between the write and the link leaves an ignored temporary file, not a committable one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-setup-kill-"));
  const harness = mkdtempSync(join(tmpdir(), "agentos-setup-kill-harness-"));
  const oracle = gitIgnoreOracle();
  try {
    const scriptPath = join(harness, "interrupted.mjs");
    writeFileSync(scriptPath, INTERRUPTED_WRITER);
    const signalPath = join(harness, "reached-the-window");

    const child = spawn(process.execPath, [scriptPath, directory, signalPath], {
      env: { ...process.env, GITHUB_READ_TOKEN: TEST_GITHUB_READ_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));

    // The writer is a spawned node process that must reach its pre-publication
    // window. Bounded so a writer that never gets there fails the assertion
    // rather than hanging, and sized for the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s), not for an idle host.
    const deadline = Date.now() + 60_000;
    while (!existsSync(signalPath)) {
      assert.ok(Date.now() < deadline, "the writer never reached the pre-publication window");
      await delay(5);
    }

    // No cleanup handler gets to run. That is the whole point.
    child.kill("SIGKILL");
    const ended = await closed;
    assert.equal(ended.signal, "SIGKILL");

    // The interruption is real: nothing was published.
    assert.equal(existsSync(join(directory, CONFIG_FILE_NAME)), false, ".env must not exist after the kill");

    const residue = readdirSync(directory);
    assert.equal(residue.length, 1, `exactly one temporary file must be left: ${JSON.stringify(residue)}`);
    const [name] = residue;
    assert.equal(name.startsWith(TEMPORARY_PREFIX), true, `${name} must live in the temporary namespace`);
    assert.equal(name.endsWith(".tmp"), true);

    // It is left at 0600, and it really does hold a full set of generated
    // credentials — this is what makes `git add -A` the hazard it is.
    const residuePath = join(directory, name);
    assert.equal(statSync(residuePath).mode & 0o777, CONFIG_FILE_MODE);
    assert.equal(validateEnvContent(readFileSync(residuePath, "utf8")).valid, true);

    // So Git must refuse to stage it, by name, from the repository's own rules.
    assert.equal(oracle.isIgnored(name), true, `${name} must be ignored by .gitignore`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(harness, { recursive: true, force: true });
    rmSync(oracle.repository, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test("argument parsing accepts the documented flags and refuses everything else", () => {
  assert.deepEqual(parseArguments([]), { dryRun: false, help: false, upgrade: false });
  assert.equal(parseArguments(["--dry-run"]).dryRun, true);
  assert.equal(parseArguments(["--upgrade"]).upgrade, true);
  assert.equal(parseArguments(["--directory", "/tmp/x"]).directory, "/tmp/x");
  assert.equal(parseArguments(["--directory=/tmp/y"]).directory, "/tmp/y");
  assert.throws(() => parseArguments(["--force"]), (error) => error.setupClass === SETUP_CLASSES.usage);
  // There is no overwrite or rotation flag, and adding one is a product change.
  assert.throws(() => parseArguments(["--overwrite"]), (error) => error.setupClass === SETUP_CLASSES.usage);
  assert.throws(() => parseArguments(["--rotate"]), (error) => error.setupClass === SETUP_CLASSES.usage);
});

test("upgrade adds a stable runner id and missing encryption key without changing existing assignments", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    const original = renderEnvFile(generateConfiguration(seededRandomBytes(41)))
      .replace(/^RUNNER_ID=.*\n/m, "")
      .replace(/^AGENTOS_SECRET_ENCRYPTION_KEY=.*\n/m, "");
    writeFileSync(target, original, { mode: CONFIG_FILE_MODE });
    const before = parseEnvAssignments(original);
    const firstOutput = collectOutput();
    const first = runSetup({
      directory,
      upgrade: true,
      randomBytes: seededRandomBytes(42),
      stdout: firstOutput.write,
      stderr: () => assert.fail("upgrade must keep stderr empty"),
    });
    assert.equal(first.setupClass, SETUP_CLASSES.upgraded);
    assert.deepEqual(first.changed, ["RUNNER_ID", "AGENTOS_SECRET_ENCRYPTION_KEY"]);
    assert.deepEqual(first.remaining, []);
    assert.deepEqual(firstOutput.lines, [
      `setup:local upgrade ${SETUP_CLASSES.upgraded}`,
      "changed: RUNNER_ID,AGENTOS_SECRET_ENCRYPTION_KEY",
      "remaining: none",
    ]);

    const afterText = readFileSync(target, "utf8");
    const after = parseEnvAssignments(afterText);
    for (const [key, value] of before) assert.equal(after.get(key), value, key);
    assert.match(after.get("RUNNER_ID"), /^runner-[A-Za-z0-9_-]{16}$/u);
    assert.equal(Buffer.from(after.get("AGENTOS_SECRET_ENCRYPTION_KEY"), "base64").length, 32);
    assert.equal(statSync(target).mode & 0o777, CONFIG_FILE_MODE);

    const secondOutput = collectOutput();
    const second = runSetup({ directory, upgrade: true, stdout: secondOutput.write, stderr: () => {} });
    assert.equal(second.setupClass, SETUP_CLASSES.valid);
    assert.deepEqual(second.changed, []);
    assert.deepEqual(second.remaining, []);
    assert.equal(readFileSync(target, "utf8"), afterText);
    assert.deepEqual(secondOutput.lines, [
      `setup:local upgrade ${SETUP_CLASSES.valid}`,
      "changed: none",
      "remaining: none",
    ]);
  });
});

test("upgrade reports weak credentials for manual rotation while preserving them", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    const values = generateConfiguration(seededRandomBytes(51));
    const weakUrl = composeDatabaseUrl({ password: "agentos" });
    const original = renderEnvFile(values)
      .replace(/^POSTGRES_PASSWORD=.*$/m, "POSTGRES_PASSWORD=agentos")
      .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${weakUrl}`)
      .replace(/^AGENTOS_SECRET_ENCRYPTION_KEY=.*\n/m, "");
    writeFileSync(target, original, { mode: CONFIG_FILE_MODE });

    const output = collectOutput();
    const result = runSetup({
      directory,
      upgrade: true,
      randomBytes: seededRandomBytes(52),
      stdout: output.write,
      stderr: () => {},
    });
    assert.equal(result.setupClass, SETUP_CLASSES.upgradedNeedsAction);
    assert.deepEqual(result.changed, ["AGENTOS_SECRET_ENCRYPTION_KEY"]);
    assert.deepEqual(result.remaining, ["rotate:POSTGRES_PASSWORD+DATABASE_URL"]);
    const upgraded = parseEnvAssignments(readFileSync(target, "utf8"));
    assert.equal(upgraded.get("POSTGRES_PASSWORD"), "agentos");
    assert.equal(upgraded.get("DATABASE_URL"), weakUrl);
    for (const key of UPGRADE_GENERATED_KEYS.filter((key) => key !== "AGENTOS_SECRET_ENCRYPTION_KEY")) {
      assert.equal(upgraded.get(key), parseEnvAssignments(original).get(key), key);
    }

    const bytes = readFileSync(target, "utf8");
    const rerun = runSetup({ directory, upgrade: true, stdout: () => {}, stderr: () => {} });
    assert.equal(rerun.setupClass, SETUP_CLASSES.upgradeNeedsAction);
    assert.deepEqual(rerun.changed, []);
    assert.equal(readFileSync(target, "utf8"), bytes);
  });
});

test("upgrade names a missing operator-provided GitHub token without inventing one", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, CONFIG_FILE_NAME);
    const original = renderEnvFile(generateConfiguration(seededRandomBytes(61)))
      .replace(/^GITHUB_READ_TOKEN=.*\n/m, "");
    writeFileSync(target, original, { mode: CONFIG_FILE_MODE });

    const result = runSetup({ directory, upgrade: true, stdout: () => {}, stderr: () => {} });
    assert.equal(result.setupClass, SETUP_CLASSES.upgradeNeedsAction);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.remaining, ["add:GITHUB_READ_TOKEN"]);
    assert.equal(readFileSync(target, "utf8"), original);
  });
});

test("the CLI publishes, reports its class, and prints no value", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-setup-cli-"));
  try {
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [modulePath, "--directory", directory], {
          env: { ...process.env, GITHUB_READ_TOKEN: TEST_GITHUB_READ_TOKEN },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    const first = await run();
    assert.equal(first.code, 0);
    assert.equal(first.stdout, `setup:local ${SETUP_CLASSES.created}\n`);
    assert.equal(first.stderr, "", "a run explains itself with its class or not at all");

    const contents = readFileSync(join(directory, CONFIG_FILE_NAME), "utf8");
    const assignments = parseEnvAssignments(contents);
    const output = `${first.stdout}${first.stderr}`;
    for (const key of ["POSTGRES_PASSWORD", "OPERATOR_TOKEN", "RUNNER_TOKEN", "SESSION_COOKIE_SECRET", "AGENTOS_SECRET_ENCRYPTION_KEY", "DATABASE_URL"]) {
      assert.equal(output.includes(assignments.get(key)), false, `${key} reached the output`);
    }

    const second = await run();
    assert.equal(second.code, 0);
    assert.equal(second.stdout, `setup:local ${SETUP_CLASSES.valid}\n`);
    assert.equal(second.stderr, "");
    assert.equal(readFileSync(join(directory, CONFIG_FILE_NAME), "utf8"), contents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runCli(argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [modulePath, ...argv], {
      env: { ...process.env, GITHUB_READ_TOKEN: TEST_GITHUB_READ_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a rejected argument reports its class and nothing else; --help is the only path that explains", async () => {
  const rejected = await runCli(["--force"]);
  assert.equal(rejected.code, EXIT_CODES[SETUP_CLASSES.usage]);
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.stdout, `setup:local ${SETUP_CLASSES.usage}\n`);
  assert.equal(rejected.stderr, "", "a usage error is a class, not an essay on a stream");

  // The usage text exists and is reachable — it is just never printed by a run.
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /Usage: npm run setup:local/);
  assert.ok(help.stdout.includes(SUPPORTED_NODE_RANGE), "--help must publish the supported Node range");
  for (const setupClass of Object.values(SETUP_CLASSES)) {
    assert.ok(help.stdout.includes(setupClass), `--help must document ${setupClass}`);
  }
});

test("a dry run against this repository prints one class line and writes nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-setup-dry-"));
  try {
    const result = await runCli(["--dry-run", "--directory", directory]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `setup:local dry-run ${SETUP_CLASSES.created}\n`);
    assert.equal(result.stderr, "");
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the .env.example the repository publishes stays documentation, not configuration", () => {
  const example = readFileSync(join(repositoryRoot, ".env.example"), "utf8");
  const assignments = parseEnvAssignments(example);

  assert.equal(assignments.get("API_HOST"), "127.0.0.1");
  assert.equal(/VITE_[A-Z0-9_]*TOKEN/.test(example), false, "no browser-exposed token may be documented as supported");
  assert.equal(assignments.has("VITE_API_URL"), false);
  assert.equal(assignments.has("VITE_API_TOKEN"), false);
  assert.equal(assignments.get("POSTGRES_PASSWORD"), "CHANGE_ME");
  assert.equal(new URL(assignments.get("DATABASE_URL")).password, "CHANGE_ME", "the two placeholder passwords must agree");
  assert.ok(new URL(assignments.get("DATABASE_URL")).searchParams.get("schema"));
  assert.equal(assignments.get("FEISHU_APP_SECRET"), "");
  assert.equal(assignments.has("RUNNER_HOME"), false, "RUNNER_HOME must not be hard-coded to one machine's account");

  // The published-snapshot scanner is the authority on what may go out; the
  // only thing it may find here is the documented placeholder shape.
  const findings = scanTextFindings(".env.example", example);
  assert.deepEqual(
    findings.filter((finding) => finding.category !== "credential-placeholder"),
    [],
    "the documented template must carry no credential, private path or PII",
  );
});
