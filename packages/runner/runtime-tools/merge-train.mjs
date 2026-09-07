#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_WIDTH = 3;
const MAX_GATE_ATTEMPTS = 3;
const OUTPUT_KIND = "merge-train-v1";
const HANDOFF_FILE = "merge-train-output.json";
const HANDOFF_SCHEMA_VERSION = 1;
const ZERO_OID = "0".repeat(40);
const MAX_EXCERPT_BYTES = 4_000;
const NETWORK_ATTEMPTS = 3;
const NETWORK_BACKOFF_MS = 500;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CONTROL_CHARACTER_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f]", "u");
const ANSI_ESCAPE_PATTERN = new RegExp("\\u001b\\[[0-9;]*m", "gu");

export class MergeTrainInputError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "MergeTrainInputError";
  }
}

export class MergeTrainCommandError extends Error {
  constructor(command, result) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    super(command + " exited " + result.code + (detail ? ": " + detail : ""));
    this.name = "MergeTrainCommandError";
    this.result = result;
  }
}

const runProcess = (command, args, options = {}) => new Promise((resolve, reject) => {
  let settled = false;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    reject(error);
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    resolve({
      code: code ?? 128,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
  child.stdin.end(options.input === undefined ? undefined : options.input);
});

const commandName = (command, args) => [command, ...args].join(" ");

const checkedProcess = async (command, args, options = {}) => {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) throw new MergeTrainCommandError(commandName(command, args), result);
  return result.stdout.trim();
};

const gitResult = (repoRoot, args) => runProcess("git", ["-C", repoRoot, ...args]);
const git = (repoRoot, args) => checkedProcess("git", ["-C", repoRoot, ...args]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failureDetail = (result, label) =>
  [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || label + " exited " + result.code;

/**
 * The transient half of this repository's network policy, in the vocabulary git
 * writes: bounded attempts with backoff for a transport failure, and no retry
 * for an answer the remote already gave. `classify` returns "retry" or the
 * Error that ends the operation immediately.
 */
const retryingProcess = async (label, run, classify = () => "retry") => {
  let detail = label + " failed";
  for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt += 1) {
    const result = await run();
    if (result.code === 0) return result;
    detail = failureDetail(result, label);
    const decision = classify(result, detail);
    if (decision !== "retry") throw decision;
    if (attempt < NETWORK_ATTEMPTS) await delay(NETWORK_BACKOFF_MS * attempt);
  }
  throw new Error(label + ": " + detail);
};

const assertSha = (value, label) => {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new MergeTrainInputError("malformed-input: " + label + " must be a full lowercase commit OID");
  }
};

const assertBranch = (value, label) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 500
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new MergeTrainInputError("malformed-input: " + label + " is not a valid branch");
  }
};

const assertTaskId = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 500
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new MergeTrainInputError("malformed-input: " + label + " must be a non-empty task id");
  }
};

export const parseMergeTrainInput = (raw) => {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MergeTrainInputError("malformed-input: stdin is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MergeTrainInputError("malformed-input: input must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new MergeTrainInputError("malformed-input: schemaVersion must be 1");
  }
  assertSha(value.baseSha, "baseSha");
  if (!Number.isSafeInteger(value.width) || value.width < 1 || value.width > MAX_WIDTH) {
    throw new MergeTrainInputError("malformed-input: width must be an integer from 1 to " + MAX_WIDTH);
  }
  if (!Array.isArray(value.candidates)) {
    throw new MergeTrainInputError("malformed-input: candidates must be an array");
  }
  if (value.candidates.length > value.width) {
    throw new MergeTrainInputError("candidate-count-exceeds-width: candidates exceed width");
  }

  const candidates = value.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new MergeTrainInputError("malformed-input: candidate " + (index + 1) + " must be an object");
    }
    assertTaskId(candidate.taskId, "candidate " + (index + 1) + " taskId");
    if (typeof candidate.chainId !== "string" || !UUID_PATTERN.test(candidate.chainId)) {
      throw new MergeTrainInputError("malformed-input: candidate " + (index + 1) + " chainId must be a UUID");
    }
    assertSha(candidate.headSha, "candidate " + (index + 1) + " headSha");
    assertBranch(candidate.branch, "candidate " + (index + 1) + " branch");
    return {
      taskId: candidate.taskId,
      chainId: candidate.chainId,
      headSha: candidate.headSha,
      branch: candidate.branch,
    };
  });
  return { schemaVersion: 1, baseSha: value.baseSha, width: value.width, candidates };
};

const remoteBranchRef = (branch) => "refs/remotes/origin/" + branch;
const headsBranchRef = (branch) => "refs/heads/" + branch;

const validateGitBranch = async (repoRoot, branch, label) => {
  assertBranch(branch, label);
  const result = await gitResult(repoRoot, ["check-ref-format", headsBranchRef(branch)]);
  if (result.code !== 0) throw new MergeTrainInputError("malformed-input: " + label + " is not a valid Git branch");
};

const readOriginDefaultBranch = async (repoRoot) => {
  const remote = await retryingProcess(
    "default-branch-unresolved: cannot read origin default branch",
    () => gitResult(repoRoot, ["ls-remote", "--symref", "origin", "HEAD"]),
  );
  const branch = remote.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu)?.[1];
  if (!branch) throw new Error("default-branch-unresolved: origin did not name a default branch");
  await validateGitBranch(repoRoot, branch, "origin default branch");
  return branch;
};

const fetchBranch = async (repoRoot, branch, candidateLabel = null) => {
  const source = headsBranchRef(branch);
  const destination = remoteBranchRef(branch);
  await retryingProcess(
    "candidate-fetch-failed: could not fetch " + source,
    () => gitResult(repoRoot, [
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "+" + source + ":" + destination,
    ]),
    (_result, detail) => (candidateLabel
      && /could(?:n't| not) find remote ref|does not appear to be a git repository/u.test(detail)
      ? new MergeTrainInputError("candidate-tip-mismatch: " + candidateLabel + " branch does not exist on origin")
      : "retry"),
  );
};

/** The one supported override, then the tool bundled beside this module. No
 * PATH search: nothing on the caller's PATH gets to decide a merge verdict. */
const resolveGateDispatch = (environment) => environment.MERGE_TRAIN_GATE_DISPATCH
  || path.join(SCRIPT_DIRECTORY, "gate-worker", "gate-dispatch.sh");

const readRemoteCommit = async (repoRoot, branch, label) => {
  let oid;
  try {
    oid = await git(repoRoot, ["rev-parse", remoteBranchRef(branch) + "^{commit}"]);
  } catch (error) {
    throw new Error("candidate-tip-unreadable: " + label + " has no readable origin branch tip: "
      + (error instanceof Error ? error.message : String(error)));
  }
  if (!SHA_PATTERN.test(oid)) throw new Error("candidate-tip-unreadable: " + label + " origin branch tip is not a full object id");
  return oid;
};

const isAncestor = async (repoRoot, ancestor, descendant) => {
  const result = await gitResult(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new MergeTrainCommandError(
    commandName("git", ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant]),
    result,
  );
};

const buildPrefixes = async (repoRoot, buildCheckout, input, defaultBranch) => {
  const prefixes = [];
  let predecessor = input.baseSha;
  let blocked = null;

  for (const candidate of input.candidates) {
    if (await isAncestor(repoRoot, candidate.headSha, predecessor)) {
      blocked = {
        taskId: candidate.taskId,
        chainId: candidate.chainId,
        candidateHeadSha: candidate.headSha,
        reason: "candidate is already contained by an earlier train prefix; rerun after that prefix publishes",
      };
      break;
    }

    const merge = await gitResult(buildCheckout, ["merge", "--no-commit", "--no-ff", candidate.headSha]);
    if (merge.code !== 0) {
      const conflicts = await git(buildCheckout, ["diff", "--name-only", "--diff-filter=U"]);
      await gitResult(buildCheckout, ["merge", "--abort"]);
      if (!conflicts) {
        throw new MergeTrainCommandError(commandName("git", ["merge", "--no-commit", "--no-ff", candidate.headSha]), merge);
      }
      blocked = {
        taskId: candidate.taskId,
        chainId: candidate.chainId,
        candidateHeadSha: candidate.headSha,
        reason: "merge conflict",
      };
      break;
    }

    await git(buildCheckout, ["rm", "-r", "-f", "--ignore-unmatch", "--quiet", ".chain"]);
    await git(buildCheckout, [
      "-c", "commit.gpgsign=false", "commit", "-m",
      "Merge task " + candidate.taskId + " into " + defaultBranch,
    ]);
    const prefixOid = await git(buildCheckout, ["rev-parse", "HEAD^{commit}"]);
    if (!SHA_PATTERN.test(prefixOid)) {
      throw new Error("lineage-assertion-failed: prefix for " + candidate.taskId + " is not a full object id");
    }
    const parents = (await git(buildCheckout, ["show", "-s", "--format=%P", prefixOid])).split(/\s+/u).filter(Boolean);
    if (parents.length !== 2 || parents[0] !== predecessor || parents[1] !== candidate.headSha) {
      throw new Error("lineage-assertion-failed: prefix " + prefixOid + " does not have exact parents "
        + predecessor + " and " + candidate.headSha);
    }
    const internalPaths = await git(buildCheckout, ["ls-tree", "-r", "--name-only", prefixOid, "--", ".chain"]);
    if (internalPaths) throw new Error("lineage-assertion-failed: prefix " + prefixOid + " still contains internal .chain paths");

    prefixes.push({
      index: prefixes.length + 1,
      taskId: candidate.taskId,
      chainId: candidate.chainId,
      candidateHeadSha: candidate.headSha,
      predecessorOid: predecessor,
      prefixOid,
      ref: "refs/anneal/train/" + prefixOid,
      candidate,
    });
    predecessor = prefixOid;
  }

  return { prefixes, blocked };
};

const readTrainRef = async (repoRoot, ref) => {
  const result = await retryingProcess(
    "train-ref-unreadable: " + ref,
    () => gitResult(repoRoot, ["ls-remote", "--refs", "origin", ref]),
  );
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  const matching = lines.find((line) => line.endsWith("\t" + ref));
  if (!matching) return null;
  const oid = matching.slice(0, matching.indexOf("\t"));
  if (!SHA_PATTERN.test(oid)) throw new Error("train-ref-invalid: origin returned a malformed target for " + ref);
  return oid;
};

const pushAppendOnlyRef = async (repoRoot, prefix) => {
  const existing = await readTrainRef(repoRoot, prefix.ref);
  if (existing === prefix.prefixOid) return;
  if (existing !== null) {
    throw new Error("train-ref-append-only-conflict: " + prefix.ref + " already points to " + existing
      + ", expected " + prefix.prefixOid);
  }

  let detail = "git push failed";
  for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt += 1) {
    const push = await gitResult(repoRoot, [
      "push", "--porcelain", "--force-with-lease=" + prefix.ref + ":" + ZERO_OID,
      "origin", prefix.prefixOid + ":" + prefix.ref,
    ]);
    if (push.code === 0) return;
    detail = failureDetail(push, "git push");
    // A ref that now exists is an answer, not a transient failure: either this
    // push landed after all, or someone else claimed the name.
    const raced = await readTrainRef(repoRoot, prefix.ref);
    if (raced === prefix.prefixOid) return;
    if (raced !== null) {
      throw new Error("train-ref-append-only-conflict: " + prefix.ref + " changed during append; found "
        + raced + ", expected " + prefix.prefixOid);
    }
    if (attempt < NETWORK_ATTEMPTS) await delay(NETWORK_BACKOFF_MS * attempt);
  }
  throw new Error("train-ref-push-failed: " + prefix.ref + ": " + detail);
};

const stripAnsi = (value) => value.replace(ANSI_ESCAPE_PATTERN, "");

const truncateUtf8 = (value, byteLimit = MAX_EXCERPT_BYTES) => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= byteLimit) return value;
  let end = byteLimit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};

const tailTruncateUtf8 = (value, byteLimit) => {
  if (byteLimit <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= byteLimit) return value;
  let start = bytes.length - byteLimit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
};

/**
 * Compose the durable excerpt around the verdict line. The gate deliberately
 * prints its verdict last, after a failure excerpt that can be far larger than
 * this budget, so the excerpt keeps the tail and never truncates away the proof
 * the control plane authorizes from.
 */
const composeExcerpt = (lines, verdictIndex) => {
  if (verdictIndex < 0) return tailTruncateUtf8(lines.join("\n"), MAX_EXCERPT_BYTES);
  let proof = lines.slice(verdictIndex).join("\n");
  if (Buffer.byteLength(proof, "utf8") > MAX_EXCERPT_BYTES) proof = truncateUtf8(lines[verdictIndex]);
  const budget = MAX_EXCERPT_BYTES - Buffer.byteLength(proof, "utf8") - 1;
  const prior = verdictIndex === 0 ? "" : tailTruncateUtf8(lines.slice(0, verdictIndex).join("\n"), budget);
  return prior ? prior + "\n" + proof : proof;
};

const gateVerdict = (result, prefix) => {
  const output = [stripAnsi(result.stdout), stripAnsi(result.stderr)]
    .filter(Boolean)
    .join("\n")
    .replaceAll("\r\n", "\n");
  const lines = output.split("\n");
  const passIndex = lines.indexOf("MERGE GATE: PASS " + prefix.prefixOid);
  const failIndex = lines.findIndex((line) => /^MERGE GATE: FAIL \(.+\)$/u.test(line));
  if (result.code === 0 && passIndex >= 0) return { verdict: "pass", gateExcerpt: composeExcerpt(lines, passIndex) };
  if (result.code === 1 && failIndex >= 0) return { verdict: "fail", gateExcerpt: composeExcerpt(lines, failIndex) };
  return { verdict: "no-verdict", gateExcerpt: composeExcerpt(lines, -1) };
};

const gateOne = async (prefix, gateCheckout, environment, gateDispatch) => {
  let last = { verdict: "no-verdict", gateExcerpt: "" };
  for (let attempt = 1; attempt <= MAX_GATE_ATTEMPTS; attempt += 1) {
    const result = await runProcess(gateDispatch, [prefix.prefixOid, "--master", prefix.predecessorOid], {
      cwd: gateCheckout,
      env: { ...environment, AGENTOS_WORKSPACE_PATH: gateCheckout },
    });
    last = gateVerdict(result, prefix);
    if (last.verdict !== "no-verdict") return last;
    if (result.code !== 75 && result.code !== 76) break;
  }
  return last;
};

const gatePrefixes = async (prefixes, gateCheckouts, environment, gateDispatch) => Promise.all(
  prefixes.map((prefix, index) => gateOne(prefix, gateCheckouts[index].absolute, environment, gateDispatch)),
);

/**
 * Hand the record to the Runner the way `regression-verification.sh finalize`
 * does: a mode-0600 file in the workspace scratch directory that the Runner
 * publishes through its fenced control-plane transport. This tool derives the
 * deliverable and never needs control-plane network access or credentials.
 */
const persistRecord = async (record, repoRoot, agentDirectory, environment) => {
  const runId = environment.AGENTOS_RUN_ID;
  if (!runId) throw new Error("output-persist-config-missing: AGENTOS_RUN_ID is required");
  const commitSha = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (!SHA_PATTERN.test(commitSha)) throw new Error("output-persist-config-invalid: commitSha is not a full lowercase commit OID");
  const target = path.join(agentDirectory, HANDOFF_FILE);
  const temporary = target + "." + process.pid + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify({
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      runId,
      kind: OUTPUT_KIND,
      body: JSON.stringify(record),
      commitSha,
    }), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error("output-persist-failed: " + (error instanceof Error ? error.message : String(error)));
  }
};

const removeWorktree = async (repoRoot, checkout) => {
  const result = await gitResult(repoRoot, ["worktree", "remove", "--force", checkout]);
  if (result.code !== 0) {
    throw new MergeTrainCommandError(
      commandName("git", ["-C", repoRoot, "worktree", "remove", "--force", checkout]),
      result,
    );
  }
};

const ensureScratchDirectory = async (parent, name) => {
  const directory = path.join(parent, name);
  let status = null;
  try {
    status = await lstat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("workspace-scratch-refused: cannot inspect " + name + ": "
        + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (status) {
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("workspace-scratch-refused: " + name + " is not a regular directory");
    }
    return directory;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
};

export const runMergeTrain = async (input, environment = process.env) => {
  const workspaceInput = environment.AGENTOS_WORKSPACE_PATH ?? process.cwd();
  let repoRoot;
  try {
    repoRoot = await realpath(workspaceInput);
  } catch (error) {
    throw new Error("workspace-refused: cannot resolve AGENTOS_WORKSPACE_PATH: "
      + (error instanceof Error ? error.message : String(error)));
  }
  const defaultBranch = await readOriginDefaultBranch(repoRoot);
  await fetchBranch(repoRoot, defaultBranch);
  const liveBase = await readRemoteCommit(repoRoot, defaultBranch, "default branch");
  if (liveBase !== input.baseSha) {
    throw new MergeTrainInputError("base-stale: supplied " + input.baseSha + ", current origin/"
      + defaultBranch + " is " + liveBase);
  }

  for (const [index, candidate] of input.candidates.entries()) {
    await validateGitBranch(repoRoot, candidate.branch, "candidate " + (index + 1) + " branch");
    await fetchBranch(repoRoot, candidate.branch, candidate.taskId);
    const tip = await readRemoteCommit(repoRoot, candidate.branch, "candidate " + (index + 1));
    if (tip !== candidate.headSha) {
      throw new MergeTrainInputError("candidate-tip-mismatch: " + candidate.taskId + " supplied "
        + candidate.headSha + ", origin/" + candidate.branch + " is " + tip);
    }
  }

  const agentDirectory = await ensureScratchDirectory(repoRoot, ".agentos");
  const worktreeDirectory = await ensureScratchDirectory(agentDirectory, "worktrees");
  const temporaryRoot = await mkdtemp(path.join(worktreeDirectory, "merge-train-"));
  // Every checkout travels as the pair git needs: the absolute path a gate runs
  // in, and the repo-relative path the worktree is registered under.
  const checkoutFor = (name) => {
    const absolute = path.join(temporaryRoot, name);
    return { absolute, relative: path.relative(repoRoot, absolute) };
  };
  const added = [];
  try {
    const buildCheckout = checkoutFor("build");
    await git(repoRoot, ["worktree", "add", "--detach", buildCheckout.relative, input.baseSha]);
    added.push(buildCheckout);
    const built = await buildPrefixes(repoRoot, buildCheckout.absolute, input, defaultBranch);
    const gateCheckouts = [];
    for (const prefix of built.prefixes) {
      const gateCheckout = checkoutFor("prefix-" + prefix.index);
      await git(repoRoot, ["worktree", "add", "--detach", gateCheckout.relative, prefix.prefixOid]);
      added.push(gateCheckout);
      gateCheckouts.push(gateCheckout);
    }

    // Transport every object before the first gate can start. The refs are the
    // publisher's durable reachability path if this Run's workspace disappears.
    for (const prefix of built.prefixes) await pushAppendOnlyRef(repoRoot, prefix);

    const gateDispatch = resolveGateDispatch(environment);
    const gateResults = await gatePrefixes(built.prefixes, gateCheckouts, environment, gateDispatch);
    const prefixes = built.prefixes.map((prefix, index) => ({
      index: prefix.index,
      taskId: prefix.taskId,
      chainId: prefix.chainId,
      candidateHeadSha: prefix.candidateHeadSha,
      predecessorOid: prefix.predecessorOid,
      prefixOid: prefix.prefixOid,
      ref: prefix.ref,
      verdict: gateResults[index].verdict,
      gateExcerpt: gateResults[index].gateExcerpt,
    }));
    let contiguousPassCount = 0;
    for (const prefix of prefixes) {
      if (prefix.verdict !== "pass") break;
      contiguousPassCount += 1;
    }
    const record = {
      schemaVersion: 1,
      baseSha: input.baseSha,
      width: input.width,
      prefixes,
      blocked: built.blocked ? [built.blocked] : [],
      skipped: built.blocked
        ? input.candidates.slice(prefixes.length + 1).map((candidate) => candidate.taskId)
        : [],
      contiguousPassCount,
    };
    await persistRecord(record, repoRoot, agentDirectory, environment);
    return record;
  } finally {
    const cleanupErrors = [];
    for (const checkout of [...added].reverse()) {
      try {
        await removeWorktree(repoRoot, checkout.relative);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    // Cleanup noise must never replace the outcome. A throw here would swap a
    // real failure for scratch bookkeeping, and would keep an already-persisted
    // record from reaching stdout, so it is reported and never raised.
    if (cleanupErrors.length > 0) {
      process.stderr.write("merge-train: warning: workspace-cleanup-failed: " + cleanupErrors.map((error) => (
        error instanceof Error ? error.message : String(error)
      )).join("; ") + "\n");
    }
  }
};

const main = async () => {
  const raw = await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
  const input = parseMergeTrainInput(raw);
  const record = await runMergeTrain(input);
  process.stdout.write(JSON.stringify(record) + "\n");
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write("merge-train: " + reason + "\n");
    process.exitCode = error instanceof MergeTrainInputError ? 2 : 1;
  });
}
