#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_WIDTH = 3;
const MAX_GATE_ATTEMPTS = 3;
const OUTPUT_KIND = "merge-train-v1";
const ZERO_OID = "0".repeat(40);
const MAX_EXCERPT_BYTES = 4_000;
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

const readOriginDefaultBranch = async (repoRoot, environment) => {
  const remote = await gitResult(repoRoot, ["ls-remote", "--symref", "origin", "HEAD"]);
  if (remote.code !== 0) {
    throw new Error("default-branch-unresolved: cannot read origin default branch ("
      + (remote.stderr.trim() || "git ls-remote failed") + ")");
  }
  const branch = remote.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu)?.[1];
  if (!branch) throw new Error("default-branch-unresolved: origin did not name a default branch");
  await validateGitBranch(repoRoot, branch, "origin default branch");
  const configured = environment.AGENTOS_PULL_REQUEST_BASE;
  if (configured && configured !== branch) {
    throw new MergeTrainInputError("default-branch-mismatch: origin HEAD is " + branch + ", Run configured " + configured);
  }
  return branch;
};

const validateGitBranch = async (repoRoot, branch, label) => {
  assertBranch(branch, label);
  const result = await gitResult(repoRoot, ["check-ref-format", headsBranchRef(branch)]);
  if (result.code !== 0) throw new MergeTrainInputError("malformed-input: " + label + " is not a valid Git branch");
};

const fetchBranch = async (repoRoot, branch, candidateLabel = null) => {
  const source = headsBranchRef(branch);
  const destination = remoteBranchRef(branch);
  try {
    await git(repoRoot, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "+" + source + ":" + destination]);
  } catch (error) {
    const detail = error instanceof MergeTrainCommandError
      ? [error.result.stderr, error.result.stdout].join("\n")
      : String(error);
    if (candidateLabel && /could(?:n't| not) find remote ref|does not appear to be a git repository/u.test(detail)) {
      throw new MergeTrainInputError("candidate-tip-mismatch: " + candidateLabel + " branch does not exist on origin");
    }
    throw new Error("candidate-fetch-failed: could not fetch " + source + ": "
      + (error instanceof Error ? error.message : String(error)));
  }
};

const resolveGateDispatch = async (environment) => {
  if (environment.MERGE_TRAIN_GATE_DISPATCH) return environment.MERGE_TRAIN_GATE_DISPATCH;
  const fromPath = await runProcess("sh", ["-c", "command -v gate-dispatch.sh"], { env: environment });
  if (fromPath.code === 0 && fromPath.stdout.trim()) return fromPath.stdout.trim();
  return path.join(SCRIPT_DIRECTORY, "gate-worker", "gate-dispatch.sh");
};

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

const buildPrefixes = async (repoRoot, buildCheckout, buildCheckoutRef, input, defaultBranch, onWorktreeAdded = () => {}) => {
  await git(repoRoot, ["worktree", "add", "--detach", buildCheckoutRef, input.baseSha]);
  onWorktreeAdded();
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
  const result = await gitResult(repoRoot, ["ls-remote", "--refs", "origin", ref]);
  if (result.code !== 0) {
    throw new MergeTrainCommandError(commandName("git", ["-C", repoRoot, "ls-remote", "--refs", "origin", ref]), result);
  }
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

  const push = await gitResult(repoRoot, [
    "push", "--porcelain", "--force-with-lease=" + prefix.ref + ":" + ZERO_OID,
    "origin", prefix.prefixOid + ":" + prefix.ref,
  ]);
  if (push.code === 0) return;

  const raced = await readTrainRef(repoRoot, prefix.ref);
  if (raced === prefix.prefixOid) return;
  if (raced !== null) {
    throw new Error("train-ref-append-only-conflict: " + prefix.ref + " changed during append; found "
      + raced + ", expected " + prefix.prefixOid);
  }
  throw new Error("train-ref-push-failed: " + prefix.ref + ": "
    + ([push.stderr.trim(), push.stdout.trim()].filter(Boolean).join("\n") || "git push exited " + push.code));
};

const stripAnsi = (value) => value.replace(ANSI_ESCAPE_PATTERN, "");

const truncateUtf8 = (value, byteLimit = MAX_EXCERPT_BYTES) => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= byteLimit) return value;
  let end = byteLimit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};

const gateVerdict = (result, prefix) => {
  const stdout = stripAnsi(result.stdout);
  const stderr = stripAnsi(result.stderr);
  const output = [stdout, stderr].filter(Boolean).join("\n");
  const lines = [stdout, stderr].flatMap((stream) => stream.split(/\r?\n/u));
  const passLine = "MERGE GATE: PASS " + prefix.prefixOid;
  const failLine = lines.find((line) => /^MERGE GATE: FAIL \(.+\)$/u.test(line));
  if (result.code === 0 && lines.includes(passLine)) return { verdict: "pass", gateExcerpt: truncateUtf8(output) };
  if (result.code === 1 && failLine) return { verdict: "fail", gateExcerpt: truncateUtf8(output) };
  return { verdict: "no-verdict", gateExcerpt: truncateUtf8(output) };
};

const gateOne = async (prefix, gateCheckout, environment, gateDispatch) => {
  let last = { verdict: "no-verdict", gateExcerpt: "" };
  let lastCode = 76;
  for (let attempt = 1; attempt <= MAX_GATE_ATTEMPTS; attempt += 1) {
    const result = await runProcess(gateDispatch, [prefix.prefixOid, "--master", prefix.predecessorOid], {
      cwd: gateCheckout,
      env: { ...environment, AGENTOS_WORKSPACE_PATH: gateCheckout },
    });
    lastCode = result.code;
    last = gateVerdict(result, prefix);
    if (last.verdict !== "no-verdict") return last;
    if (lastCode !== 75 && lastCode !== 76) break;
  }
  void lastCode;
  return last;
};

const gatePrefixes = async (prefixes, gateCheckouts, environment, gateDispatch) => Promise.all(
  prefixes.map((prefix, index) => gateOne(prefix, gateCheckouts[index], environment, gateDispatch)),
);

const persistRecord = async (record, repoRoot, environment) => {
  const apiUrl = environment.AGENTOS_API_URL;
  const runId = environment.AGENTOS_RUN_ID;
  const sessionToken = environment.AGENTOS_SESSION_TOKEN;
  const fencingToken = environment.AGENTOS_FENCING_TOKEN;
  for (const entry of [
    ["AGENTOS_API_URL", apiUrl],
    ["AGENTOS_RUN_ID", runId],
    ["AGENTOS_SESSION_TOKEN", sessionToken],
    ["AGENTOS_FENCING_TOKEN", fencingToken],
  ]) {
    if (!entry[1]) throw new Error("output-persist-config-missing: " + entry[0] + " is required");
  }
  const commitSha = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (!SHA_PATTERN.test(commitSha)) throw new Error("output-persist-config-invalid: commitSha is not a full lowercase commit OID");
  let response;
  try {
    response = await fetch(
      apiUrl.replace(/\/+$/u, "") + "/session/runs/" + encodeURIComponent(runId) + "/output",
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + sessionToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fencingToken,
          kind: OUTPUT_KIND,
          body: JSON.stringify(record),
          commitSha,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    throw new Error("output-persist-failed: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!response.ok) {
    const detail = truncateUtf8(await response.text().catch(() => ""), 1_000);
    throw new Error("output-persist-failed: API returned HTTP " + response.status + (detail ? ": " + detail : ""));
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

const ensureAgentDirectory = async (workspace) => {
  const agentDirectory = path.join(workspace, ".agentos");
  try {
    const status = await lstat(agentDirectory);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("not a regular directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("workspace-scratch-refused: .agentos is not a regular directory");
    await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  }
  return agentDirectory;
};

const ensureWorktreeDirectory = async (agentDirectory) => {
  const worktreeDirectory = path.join(agentDirectory, "worktrees");
  try {
    const status = await lstat(worktreeDirectory);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("not a regular directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("workspace-scratch-refused: .agentos/worktrees is not a regular directory");
    await mkdir(worktreeDirectory, { recursive: true, mode: 0o700 });
  }
  return worktreeDirectory;
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
  const defaultBranch = await readOriginDefaultBranch(repoRoot, environment);
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

  const agentDirectory = await ensureAgentDirectory(repoRoot);
  const worktreeDirectory = await ensureWorktreeDirectory(agentDirectory);
  const temporaryRoot = await mkdtemp(path.join(worktreeDirectory, "merge-train-"));
  const buildCheckout = path.join(temporaryRoot, "build");
  const buildCheckoutRef = path.relative(repoRoot, buildCheckout);
  const gateCheckouts = [];
  const gateCheckoutRefs = [];
  let buildAdded = false;
  try {
    const built = await buildPrefixes(repoRoot, buildCheckout, buildCheckoutRef, input, defaultBranch, () => {
      buildAdded = true;
    });
    for (const prefix of built.prefixes) {
      const checkout = path.join(temporaryRoot, "prefix-" + prefix.index);
      const checkoutRef = path.relative(repoRoot, checkout);
      await git(repoRoot, ["worktree", "add", "--detach", checkoutRef, prefix.prefixOid]);
      gateCheckouts.push(checkout);
      gateCheckoutRefs.push(checkoutRef);
    }

    // Transport every object before the first gate can start. The refs are the
    // publisher's durable reachability path if this Run's workspace disappears.
    for (const prefix of built.prefixes) await pushAppendOnlyRef(repoRoot, prefix);

    const gateDispatch = await resolveGateDispatch(environment);
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
    await persistRecord(record, repoRoot, environment);
    return record;
  } finally {
    const cleanupErrors = [];
    for (const checkout of gateCheckoutRefs.reverse()) {
      try {
        await removeWorktree(repoRoot, checkout);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (buildAdded) {
      try {
        await removeWorktree(repoRoot, buildCheckoutRef);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new Error("workspace-cleanup-failed: " + cleanupErrors.map((error) => (
        error instanceof Error ? error.message : String(error)
      )).join("; "));
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
