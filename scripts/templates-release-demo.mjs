#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_ID = /^oss-c0-demo-(\d{3})$/u;
export const TEMPLATE_NAME = "compound-engineer-workflow";
export const PROJECT_SLUG = "agentos-example";
export const PROJECT_NAME = "Templates Demo Project";
export const CHANGE_REQUEST = "Add summarize <path> to the demo CLI. Read UTF-8 text, normalize CRLF to LF, count an empty file as zero lines, do not count a final newline as an extra line, count non-empty whitespace-delimited words, and print exactly one JSON line with properties in the order lines, words. For fixtures/demo.txt, stdout must be {\"lines\":3,\"words\":5} followed by LF. Missing or extra arguments print one usage line to stderr and exit 2; a read failure prints one error line to stderr and exits 1. Add coverage for the example, empty input, final newline, CRLF, bad arguments, and a missing file. Update README usage. Do not add dependencies or change files outside src/cli.mjs, test/cli.test.mjs, and README.md.";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretKey = /token|secret|authorization|cookie|credential|private.?key/iu;
const secretValue = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/u;

const usage = `Usage:
  npm run demo:templates -- preflight --run-id oss-c0-demo-001 --mode rehearsal \\
    --agentos-commit <40-hex> --oss-b-artifact <json> --cp-a-artifact <json> \\
    --evidence-dir <absolute-external-path> --api-url <loopback-url> \\
    --target-path <synthetic-repo> --target-remote <url> --target-baseline <40-hex>
  npm run demo:templates -- setup|instantiate|capture|verify --run-id <id> --evidence-dir <path>
  npm run demo:templates -- reset --run-id <id> --confirm-run-id <id> --evidence-dir <path>
`;

export const stableJson = (value) => `${JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
}, 2)}\n`;

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function assertSanitized(value, path = "evidence") {
  if (typeof value === "string") {
    if (secretValue.test(value)) throw new Error(`${path} contains a credential-shaped value`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSanitized(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (secretKey.test(key)) throw new Error(`${path} contains forbidden key ${key}`);
    assertSanitized(nested, `${path}.${key}`);
  }
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { command: "help", options: {} };
  if (!new Set(["preflight", "setup", "instantiate", "capture", "verify", "reset"]).has(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) return { command: "help", options: {} };
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument: ${flag ?? "missing"}`);
    const name = flag.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (Object.hasOwn(options, name)) throw new Error(`${flag} was supplied more than once`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

const within = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("../") && path !== "..");
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const evidencePath = (config, name) => resolve(config.evidenceDir, name);

const writeEvidence = (config, name, value) => {
  assertSanitized(value);
  const path = evidencePath(config, name);
  if (existsSync(path)) throw new Error(`refusing to overwrite evidence: ${name}`);
  writeFileSync(path, stableJson(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
};

const required = (options, name) => {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const validateRemote = (raw) => {
  let url;
  try { url = new URL(raw); } catch { throw new Error("target remote must be an absolute URL"); }
  if (!new Set(["file:", "https:", "ssh:"]).has(url.protocol)) throw new Error("target remote uses an unsupported scheme");
  if (url.username || url.password || url.search || url.hash) throw new Error("target remote must not contain credentials, query, or fragment");
  return raw;
};

export const validateAuthority = (artifact, expectedCommit, scope) => {
  if (artifact.status !== "approved") throw new Error(`${scope} artifact is not approved`);
  if (artifact.agentosCommit !== expectedCommit) throw new Error(`${scope} artifact names another Anneal commit`);
  if (typeof artifact.approver !== "string" || artifact.approver.trim() === "") throw new Error(`${scope} artifact has no approver`);
  if (!Number.isFinite(Date.parse(artifact.approvedAt))) throw new Error(`${scope} artifact has no approval timestamp`);
  if (artifact.scopes?.[scope] !== true) throw new Error(`${scope} artifact does not approve its required scope`);
  return {
    status: artifact.status,
    agentosCommit: artifact.agentosCommit,
    approver: artifact.approver,
    approvedAt: artifact.approvedAt,
    scope,
  };
};

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function validatePreflightOptions(options, repositoryRoot = root) {
  const match = RUN_ID.exec(required(options, "run-id"));
  if (!match) throw new Error("run id must match oss-c0-demo-[0-9]{3}");
  const mode = required(options, "mode");
  if (mode !== "rehearsal" && mode !== "public") throw new Error("mode must be rehearsal or public");
  const commit = required(options, "agentos-commit").toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("agentos commit must be a full object id");
  const evidenceDir = resolve(required(options, "evidence-dir"));
  const targetPath = realpathSync(resolve(required(options, "target-path")));
  const sourcePath = realpathSync(repositoryRoot);
  if (!isAbsolute(required(options, "evidence-dir"))) throw new Error("evidence directory must be absolute");
  if (within(sourcePath, evidenceDir) || within(targetPath, evidenceDir)) throw new Error("evidence directory must be outside both repositories");
  if (within(sourcePath, targetPath) || within(targetPath, sourcePath)) throw new Error("target and Anneal repositories must be separate");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const schema = new URL(databaseUrl).searchParams.get("schema");
  if (schema !== `oss_c0_templates_demo_${match[1]}`) throw new Error("DATABASE_URL must name the dedicated demo schema");
  const apiUrl = new URL(required(options, "api-url"));
  if (apiUrl.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(apiUrl.hostname)) {
    throw new Error("api-url must be loopback HTTP");
  }
  return {
    schemaVersion: 1,
    runId: options["run-id"],
    mode,
    agentosCommit: commit,
    evidenceDir,
    targetPath,
    targetRemote: validateRemote(required(options, "target-remote")),
    targetBaseline: required(options, "target-baseline").toLowerCase(),
    targetDefaultBranch: options["target-default-branch"] ?? "main",
    targetMountPath: options["target-mount-path"] ?? "/workspace/templates-demo",
    apiUrl: apiUrl.href.replace(/\/$/u, ""),
    sourcePath,
    ossBArtifact: resolve(required(options, "oss-b-artifact")),
    cpAArtifact: resolve(required(options, "cp-a-artifact")),
  };
}

const commandSummary = (cwd, command, args) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  return {
    argv: [command, ...args],
    exitCode: result.status ?? 1,
    stdoutSha256: sha256(result.stdout ?? ""),
    stderrSha256: sha256(result.stderr ?? ""),
  };
};

export function runPreflight(options, repositoryRoot = root) {
  const config = validatePreflightOptions(options, repositoryRoot);
  if (git(config.sourcePath, ["rev-parse", "HEAD^{commit}"]) !== config.agentosCommit) throw new Error("Anneal checkout is not at the declared commit");
  if (git(config.sourcePath, ["status", "--porcelain"]) !== "") throw new Error("Anneal checkout must be clean");
  if (git(config.targetPath, ["rev-parse", "HEAD^{commit}"]) !== config.targetBaseline) throw new Error("target checkout is not at the declared baseline");
  if (git(config.targetPath, ["status", "--porcelain"]) !== "") throw new Error("target checkout must be clean");
  const remoteHead = git(config.targetPath, ["ls-remote", config.targetRemote, `refs/heads/${config.targetDefaultBranch}`]).split(/\s/u)[0];
  if (remoteHead !== config.targetBaseline) throw new Error("target remote baseline does not match");
  const branch = `agentos/${config.runId}`;
  if (git(config.targetPath, ["ls-remote", "--heads", config.targetRemote, branch]) !== "") throw new Error("demo branch already exists");
  const ossB = validateAuthority(readJson(config.ossBArtifact), config.agentosCommit, "freshInstall");
  const cpA = validateAuthority(readJson(config.cpAArtifact), config.agentosCommit, "providerPath");
  let publicAuthority = null;
  if (config.mode === "public") {
    const publicArtifactPath = resolve(required(options, "public-authority"));
    publicAuthority = validateAuthority(readJson(publicArtifactPath), config.agentosCommit, "publicDemo");
    const remote = new URL(config.targetRemote);
    if (remote.protocol !== "https:" || remote.hostname !== "github.com") throw new Error("public mode requires an HTTPS GitHub remote");
    const nameWithOwner = remote.pathname.replace(/^\//u, "").replace(/\.git$/u, "");
    const auth = commandSummary(config.sourcePath, "gh", ["auth", "status", "--hostname", "github.com"]);
    if (auth.exitCode !== 0) throw new Error("GitHub authentication preflight failed");
    const viewed = spawnSync("gh", ["repo", "view", nameWithOwner, "--json", "nameWithOwner,isPrivate,defaultBranchRef"], {
      cwd: config.sourcePath,
      encoding: "utf8",
      env: process.env,
    });
    if (viewed.status !== 0) throw new Error("GitHub repository preflight failed");
    const repository = JSON.parse(viewed.stdout);
    if (repository.nameWithOwner !== nameWithOwner || repository.isPrivate !== false || repository.defaultBranchRef?.name !== config.targetDefaultBranch) {
      throw new Error("GitHub repository identity, visibility, or default branch disagrees");
    }
    const existingPrs = spawnSync("gh", ["pr", "list", "--repo", nameWithOwner, "--head", branch, "--state", "open", "--json", "number"], {
      cwd: config.sourcePath,
      encoding: "utf8",
      env: process.env,
    });
    if (existingPrs.status !== 0 || JSON.parse(existingPrs.stdout).length > 0) throw new Error("demo branch already has an open pull request or PR lookup failed");
  }
  const targetTest = commandSummary(config.targetPath, "npm", ["test"]);
  if (targetTest.exitCode !== 0) throw new Error("target baseline tests failed");
  mkdirSync(config.evidenceDir, { recursive: true, mode: 0o700 });
  const safeConfig = {
    ...config,
    ossBArtifact: undefined,
    cpAArtifact: undefined,
    authority: {
      ossB: { ...ossB, digest: sha256(readFileSync(config.ossBArtifact)) },
      cpA: { ...cpA, digest: sha256(readFileSync(config.cpAArtifact)) },
      ...(publicAuthority ? { publicDemo: publicAuthority } : {}),
    },
    branch,
    packageLockSha256: sha256(readFileSync(resolve(config.sourcePath, "package-lock.json"))),
    targetTest,
    recordedAt: new Date().toISOString(),
  };
  writeEvidence(config, "preflight.json", safeConfig);
  return safeConfig;
}

const loadConfig = (options) => {
  const evidenceDir = resolve(required(options, "evidence-dir"));
  const config = readJson(resolve(evidenceDir, "preflight.json"));
  const runId = required(options, "run-id");
  const match = RUN_ID.exec(runId);
  if (!match || config.runId !== runId) throw new Error("run id does not match preflight evidence");
  if (config.schema !== `oss_c0_templates_demo_${match[1]}`) throw new Error("preflight evidence does not name the dedicated demo schema");
  if (config.mode !== "rehearsal" && config.mode !== "public") throw new Error("preflight evidence has an invalid mode");
  return { ...config, evidenceDir };
};

export async function apiRequest(config, method, path, body) {
  const token = process.env.OPERATOR_TOKEN;
  if (!token) throw new Error("OPERATOR_TOKEN is required for API commands");
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    const error = new Error(`API ${method} ${path} refused with ${response.status}: ${payload?.error ?? "unknown"}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const canonicalSteps = (steps) => {
  if (steps.length !== 12) throw new Error("canonical template must contain twelve steps");
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].stepIndex !== index + 1) throw new Error("canonical template step order drifted");
  }
  const readiness = steps[10];
  const integrator = steps[11];
  if (readiness.assigneeType !== "AGENT" || readiness.assigneeAgent?.name !== "review-coordinator-sol-high"
    || readiness.approvalGate !== false || readiness.outputKind !== "merge-authorization") {
    throw new Error("canonical step 11 must be server-side mechanical readiness");
  }
  if (integrator.assigneeAgent?.name !== "merge-integrator" || integrator.outputKind !== "merge-result" || integrator.opensPullRequest !== false) {
    throw new Error("canonical step 12 must be the no-PR mechanical merge-integrator");
  }
  return steps;
};

export async function runSetup(
  options,
  request = apiRequest,
  verifyTemplate = (config) => commandSummary(config.sourcePath, "npm", ["run", "db:verify-agent-template"]),
) {
  const config = loadConfig(options);
  if (existsSync(evidencePath(config, "instantiate.json"))) throw new Error("setup cannot change a run after instantiation");
  const projects = await request(config, "GET", "/projects");
  const project = projects.find((candidate) => candidate.slug === PROJECT_SLUG);
  if (!project) throw new Error(`seeded project ${PROJECT_SLUG} not found`);
  const namedProject = project.name === PROJECT_NAME
    ? project
    : await request(config, "PATCH", `/projects/${project.id}`, { name: PROJECT_NAME });
  const templates = await request(config, "GET", `/projects/${project.id}/task-templates`);
  const template = templates.find((candidate) => candidate.name === TEMPLATE_NAME);
  if (!template) throw new Error(`template ${TEMPLATE_NAME} not found`);
  const steps = canonicalSteps(template.steps);
  const repos = await request(config, "GET", `/projects/${project.id}/repos`);
  const existing = repos.find((candidate) => candidate.name === config.runId);
  if (existing && (existing.remoteUrl !== config.targetRemote || existing.defaultBranch !== config.targetDefaultBranch)) {
    throw new Error("same-name demo Repo has different immutable configuration");
  }
  const repo = existing ?? await request(config, "POST", `/projects/${project.id}/repos`, {
    name: config.runId,
    remoteUrl: config.targetRemote,
    mountPath: config.targetMountPath,
    defaultBranch: config.targetDefaultBranch,
    dependencyProvisioning: "NONE",
  });
  const agents = [...new Map(steps.flatMap((step) => step.assigneeAgent ? [[step.assigneeAgent.id, step.assigneeAgent]] : [])).values()];
  for (const agent of agents) {
    if (agent.archivedAt) throw new Error(`canonical agent ${agent.name} is archived`);
    await request(config, "POST", `/agents/${agent.id}/repos/${repo.id}/access`, {
      mountPath: config.targetMountPath,
      permissions: "GIT_WRITE",
    });
  }
  const evidence = {
    schemaVersion: 1,
    runId: config.runId,
    project: { id: namedProject.id, name: namedProject.name, slug: namedProject.slug },
    template: { id: template.id, name: template.name },
    repo: { id: repo.id, name: repo.name, defaultBranch: repo.defaultBranch },
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name })).sort((left, right) => left.name.localeCompare(right.name)),
    steps: steps.map((step) => ({
      id: step.id,
      stepIndex: step.stepIndex,
      assigneeType: step.assigneeType,
      agentName: step.assigneeAgent?.name ?? null,
      outputKind: step.outputKind,
      approvalGate: step.approvalGate,
      opensPullRequest: step.opensPullRequest,
    })),
    verifier: verifyTemplate(config),
  };
  if (evidence.verifier.exitCode !== 0) throw new Error("canonical template database verifier failed");
  const setupPath = evidencePath(config, "setup.json");
  if (existsSync(setupPath)) {
    const existingEvidence = readJson(setupPath);
    if (stableJson(existingEvidence) !== stableJson(evidence)) throw new Error("setup evidence disagrees with the converged state");
    return existingEvidence;
  }
  writeEvidence(config, "setup.json", evidence);
  return evidence;
}

export async function runInstantiate(options, request = apiRequest) {
  const config = loadConfig(options);
  if (existsSync(evidencePath(config, "instantiate.json"))) throw new Error("run id was already instantiated");
  const setup = readJson(evidencePath(config, "setup.json"));
  const result = await request(config, "POST", `/projects/${setup.project.id}/task-templates/${setup.template.id}/instantiate`, {
    repoId: setup.repo.id,
    variables: { branchName: config.branch },
    autoStart: true,
    name: `OSS-C0 template demo ${config.runId.slice(-3)}`,
    description: CHANGE_REQUEST,
  });
  if (result.branchName !== config.branch || result.tasks?.length !== 12) throw new Error("instantiation did not create the canonical twelve-step chain");
  const evidence = {
    schemaVersion: 1,
    runId: config.runId,
    chainId: result.chainId,
    branchName: result.branchName,
    taskIds: result.tasks.map((task) => task.id),
  };
  writeEvidence(config, "instantiate.json", evidence);
  return evidence;
}

export async function runCapture(options, request = apiRequest) {
  const config = loadConfig(options);
  const instantiated = readJson(evidencePath(config, "instantiate.json"));
  const tasks = [];
  for (const taskId of instantiated.taskIds) {
    const [task, chain, activity] = await Promise.all([
      request(config, "GET", `/tasks/${taskId}`),
      request(config, "GET", `/tasks/${taskId}/chain`),
      request(config, "GET", `/tasks/${taskId}/activity`),
    ]);
    let output = null;
    try {
      output = await request(config, "GET", `/tasks/${taskId}/output`);
    } catch (error) {
      if (error?.status !== 404) throw error;
      output = null;
    }
    tasks.push({
      id: task.id,
      chainIndex: task.chainIndex,
      status: task.status,
      assigneeType: task.assigneeType,
      agentName: task.assigneeAgent?.name ?? null,
      templateStep: task.templateStep ? {
        outputKind: task.templateStep.outputKind,
        opensPullRequest: task.templateStep.opensPullRequest,
      } : null,
      runs: (task.runs ?? []).map((run) => ({
        id: run.id,
        status: run.status,
        pushedBranch: run.pushedBranch,
        headSha: run.headSha,
        pullRequestUrl: run.pullRequestUrl,
        pullRequestNumber: run.pullRequestNumber,
        deliveryInstructions: run.deliveryInstructions ? true : false,
      })),
      output: output ? { kind: output.kind, bytes: Buffer.byteLength(output.body ?? ""), sha256: sha256(output.body ?? "") } : null,
      activity: { count: activity.length, digest: sha256(stableJson(activity)) },
      chainDigest: sha256(stableJson(chain)),
    });
  }
  const evidence = { schemaVersion: 1, runId: config.runId, chainId: instantiated.chainId, capturedAt: new Date().toISOString(), tasks };
  writeEvidence(config, "capture.json", evidence);
  return evidence;
}

export function verifyEvidence(config, setup, instantiated, capture) {
  if (setup.runId !== config.runId || instantiated.runId !== config.runId || capture.runId !== config.runId) throw new Error("evidence run ids disagree");
  if (capture.chainId !== instantiated.chainId || instantiated.branchName !== config.branch) throw new Error("chain identity disagrees");
  if (capture.tasks.length !== 12) throw new Error("capture must contain twelve tasks");
  const expectedKinds = setup.steps.map((step) => step.outputKind);
  for (let index = 0; index < capture.tasks.length; index += 1) {
    const task = capture.tasks[index];
    if (task.chainIndex !== index + 1) throw new Error("task positions are missing or reordered");
    if (task.status !== "DONE") throw new Error(`step ${index + 1} is not done`);
    if (!task.output || task.output.kind !== expectedKinds[index]) {
      throw new Error(`step ${index + 1} output is missing or has the wrong kind`);
    }
  }
  const readiness = capture.tasks[10];
  const integrator = capture.tasks[11];
  if (readiness.assigneeType !== "AGENT" || readiness.agentName !== "review-coordinator-sol-high"
    || readiness.output?.kind !== "merge-authorization") throw new Error("step 11 is not mechanical readiness");
  if (integrator.agentName !== "merge-integrator" || integrator.templateStep?.opensPullRequest !== false) throw new Error("step 12 is not mechanical merge execution");
  const delivered = capture.tasks.flatMap((task) => task.runs).filter((run) => run.pullRequestUrl);
  if (config.mode === "public") {
    if (delivered.length === 0 || delivered.some((run) => run.deliveryInstructions)) throw new Error("public evidence requires an automatic pull request with no manual fallback");
  }
  return {
    verdict: config.mode === "public" ? "PASS" : "REHEARSAL_ONLY",
    runId: config.runId,
    chainId: capture.chainId,
    positions: capture.tasks.map((task) => task.chainIndex),
    evidenceDigest: sha256(stableJson({ setup, instantiated, capture })),
  };
}

export function runVerify(options) {
  const config = loadConfig(options);
  const verdict = verifyEvidence(
    config,
    readJson(evidencePath(config, "setup.json")),
    readJson(evidencePath(config, "instantiate.json")),
    readJson(evidencePath(config, "capture.json")),
  );
  writeEvidence(config, "verification.json", verdict);
  return verdict;
}

export async function runReset(options, request = apiRequest) {
  const config = loadConfig(options);
  if (config.mode !== "rehearsal") throw new Error("reset is forbidden in public mode");
  if (required(options, "confirm-run-id") !== config.runId) throw new Error("reset confirmation does not match run id");
  const setup = readJson(evidencePath(config, "setup.json"));
  const tasks = await request(config, "GET", `/tasks?projectId=${encodeURIComponent(setup.project.id)}`);
  const active = tasks.flatMap((task) => task.runs ?? []).filter((run) => (
    ["QUEUED", "CLAIMED", "PROVISIONING", "RUNNING", "WAITING_INBOX"].includes(run.status)
  ));
  if (active.length > 0) throw new Error("reset refuses while the recorded project has active runs");
  const result = await request(config, "DELETE", `/projects/${setup.project.id}`);
  const evidence = { schemaVersion: 1, runId: config.runId, projectId: setup.project.id, deleted: result === null, recordedAt: new Date().toISOString() };
  writeEvidence(config, "reset.json", evidence);
  return evidence;
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "help") { process.stdout.write(usage); return; }
  const result = command === "preflight" ? runPreflight(options)
    : command === "setup" ? await runSetup(options)
    : command === "instantiate" ? await runInstantiate(options)
    : command === "capture" ? await runCapture(options)
    : command === "verify" ? runVerify(options)
    : await runReset(options);
  process.stdout.write(`${command}: ${result.verdict ?? "pass"} run=${result.runId}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`templates release demo refused: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  });
}
