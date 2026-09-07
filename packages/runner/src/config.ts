import { createRequire } from "node:module";
import { cpus, hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type BuildInfo, readBuildInfo } from "@anneal/build-info";

import { RUNNER_DEFINITIONS, RUNNER_KINDS } from "./adapters.js";
import { MAX_HOST_PROOF_SLOTS } from "./host-proof-slots.js";
import { runnerProxyEnvironment } from "./adapters/environment.js";
import { requireLocalApiDestination } from "./local-origin.js";

export { runnerProxyEnvironment } from "./adapters/environment.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version: string };
const buildInfo: BuildInfo = readBuildInfo(import.meta.url);

/** A release runner identifies itself by the commit its dist was built from.
 * Source and development runners have no stamp, so retain the package version
 * used by the existing local/test process contract. */
export const runnerDaemonVersion = (info: BuildInfo): string => info.commit ?? packageMetadata.version;

/** The loopback literal, not `localhost`: the name resolves through DNS and a
 *  hosts file, and this process attaches the runner bearer token to every call
 *  it makes to that address. */
export const DEFAULT_API_URL = "http://127.0.0.1:3000";
export const MAX_GATE_LOCAL_SLOTS = 1024;

export type RunnerKind = "CLAUDE" | "CODEX" | "PI";

export type GitIdentity = {
  name: string;
  email: string;
};

export type RunnerConfig = {
  apiUrl: string;
  runnerToken: string;
  runnerId: string;
  daemonVersion: string;
  pollIntervalMs: number;
  claimMaxLoadAverage: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  path: string;
  home: string;
  /** Optional operator override. When absent, provisioning reads the runner
   * account's global Git configuration and pins that identity locally. */
  gitIdentity: GitIdentity | null;
  /** Optional operator-selected gate worker exposed to agent sessions. */
  gateServer?: string;
  /** Optional second gate worker; requires a distinct primary gateServer. */
  gateFallbackServer?: string;
  /** Optional local gate capacity exposed to agent sessions. */
  gateLocalSlots?: number;
  /** Dispatcher slots on the primary gate worker; must equal its worker-capacity. */
  gatePrimarySlots?: number;
  /** Proxy variables captured once, when the daemon starts. */
  proxyEnvironment?: NodeJS.ProcessEnv;
  /** Repository-owned baseline used to provision Codex session config roots. */
  sessionConfigBaselineRoot?: string;
  workspaceRoot: string;
  /** Host-wide cooperative ceiling for per-workspace proof commands. */
  hostProofSlots: number;
  /** Runner-owned, write-once dependency snapshots. Defaults beside workspaceRoot. */
  dependencyCacheRoot?: string;
  /** Persistent bare mirrors, in the home of the account that runs tasks. */
  repoMirrorRoot?: string;
  failedWorkspaceRetention: number;
  workspaceReclaimIntervalMs: number;
  toolDeadlineMs: number;
  apiTimeoutMs: number;
  runAsPrefix: string[];
  servedKinds: readonly RunnerKind[] | null;
  binaries: Record<RunnerKind, string>;
};

export const defaultSessionConfigBaselineRoot = (): string =>
  fileURLToPath(new URL("../assets/session-config-baseline", import.meta.url));

// This stays local because @anneal/api's dependency on @anneal/runner is a
// devDependency used only to pin the two copies against each other in tests.
export const defaultRunnerPath = (platform: NodeJS.Platform = process.platform): string => {
  if (platform === "darwin") return "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  if (platform === "linux") return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  throw new Error(`unsupported runner platform: ${platform}`);
};

const splitPrefix = (value: string): string[] => value.trim() ? value.trim().split(/\s+/u) : [];

const positiveInteger = (name: string, value: string): number => {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const positiveIntegerAtMost = (name: string, value: string, maximum: number): number => {
  let parsed: number;
  try {
    parsed = positiveInteger(name, value);
  } catch {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  if (parsed > maximum) throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  return parsed;
};

/**
 * The dispatcher's primary slot count is the same number as the primary
 * worker's own `~/gate/worker-capacity`, which run-gate.sh allows to be 1 or 2.
 * Anything else would put the two copies out of step, so it is refused here
 * rather than rounded into a default the operator never asked for.
 */
const gatePrimarySlotCount = (value: string | undefined): number => {
  if (value === undefined) return 2;
  if (value !== "1" && value !== "2") throw new Error("RUNNER_GATE_PRIMARY_SLOTS must be 1 or 2");
  return Number(value);
};

const positiveFiniteNumber = (name: string, value: string): number => {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) {
    throw new Error(`${name} must be a positive finite number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return parsed;
};

const optionalSshDestination = (name: string, value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9._@-]+$/u.test(value) || value.startsWith("-")) {
    throw new Error(`${name} must be a safe ssh destination`);
  }
  return value;
};

const parseServedKinds = (value: string | undefined): readonly RunnerKind[] | null => {
  if (value === undefined) return null;
  const entries = value.split(",").map((raw) => ({ raw, name: raw.trim() }));
  const acceptedNames = RUNNER_KINDS.join(", ");
  for (const { raw, name } of entries) {
    if (!RUNNER_KINDS.includes(name as RunnerKind)) {
      throw new Error(
        `RUNNER_SERVED_KINDS contains invalid entry ${JSON.stringify(raw)} in ${JSON.stringify(value)}; accepted names: ${acceptedNames}`,
      );
    }
  }
  return RUNNER_KINDS.filter((runner) => entries.some(({ name }) => name === runner));
};

export const loadRunnerConfig = ({ cpuCount = cpus().length }: { cpuCount?: number } = {}): RunnerConfig => {
  const leaseSeconds = Number.parseInt(process.env.RUNNER_LEASE_SECONDS ?? "60", 10);
  const runAsPrefix = splitPrefix(process.env.RUNNER_RUN_AS_PREFIX ?? "");
  const servedKinds = parseServedKinds(process.env.RUNNER_SERVED_KINDS);
  const workspaceRoot = process.env.RUNNER_WORKSPACE_ROOT ?? join(homedir(), ".agentos", "runs");
  const home = process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty";
  const gateServer = optionalSshDestination("RUNNER_GATE_SERVER", process.env.RUNNER_GATE_SERVER);
  const gateFallbackServer = optionalSshDestination("RUNNER_GATE_FALLBACK_SERVER", process.env.RUNNER_GATE_FALLBACK_SERVER);
  if (gateFallbackServer && !gateServer) {
    throw new Error("RUNNER_GATE_FALLBACK_SERVER requires RUNNER_GATE_SERVER");
  }
  if (gateFallbackServer && gateFallbackServer === gateServer) {
    throw new Error("RUNNER_GATE_FALLBACK_SERVER must differ from RUNNER_GATE_SERVER");
  }
  const gateLocalSlots = process.env.RUNNER_GATE_LOCAL_SLOTS === undefined
    ? undefined
    : positiveIntegerAtMost("RUNNER_GATE_LOCAL_SLOTS", process.env.RUNNER_GATE_LOCAL_SLOTS, MAX_GATE_LOCAL_SLOTS);
  const gatePrimarySlots = gatePrimarySlotCount(process.env.RUNNER_GATE_PRIMARY_SLOTS);
  const claimMaxLoadAverage = positiveFiniteNumber(
    "RUNNER_CLAIM_MAX_LOAD_AVERAGE",
    process.env.RUNNER_CLAIM_MAX_LOAD_AVERAGE ?? String(cpuCount * 1.5),
  );
  const gitName = process.env.RUNNER_GIT_USER_NAME;
  const gitEmail = process.env.RUNNER_GIT_USER_EMAIL;
  if ((gitName === undefined) !== (gitEmail === undefined)) {
    throw new Error("RUNNER_GIT_USER_NAME and RUNNER_GIT_USER_EMAIL must be set together");
  }
  // First, and before this function returns anything a caller could dial: the
  // runner's own index.ts builds the client, the preflight and the poll loop out
  // of this object, so a destination refused here is refused before any DNS
  // lookup, socket or bearer header exists.
  const apiUrl = requireLocalApiDestination("RUNNER_API_URL", process.env.RUNNER_API_URL, DEFAULT_API_URL);
  return {
    apiUrl,
    runnerToken: process.env.RUNNER_TOKEN ?? "",
    runnerId: process.env.RUNNER_ID ?? `${hostname()}-${process.pid}`,
    daemonVersion: runnerDaemonVersion(buildInfo),
    pollIntervalMs: Number.parseInt(process.env.RUNNER_POLL_INTERVAL_MS ?? "5000", 10),
    claimMaxLoadAverage,
    leaseSeconds,
    heartbeatIntervalMs: Number.parseInt(process.env.RUNNER_HEARTBEAT_INTERVAL_MS ?? String(Math.max(5_000, leaseSeconds * 500)), 10),
    path: process.env.RUNNER_PATH ?? defaultRunnerPath(),
    home,
    gitIdentity: gitName === undefined ? null : { name: gitName, email: gitEmail! },
    ...(gateServer ? { gateServer } : {}),
    ...(gateFallbackServer ? { gateFallbackServer } : {}),
    ...(gateLocalSlots !== undefined ? { gateLocalSlots } : {}),
    gatePrimarySlots,
    proxyEnvironment: runnerProxyEnvironment(),
    sessionConfigBaselineRoot: process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT ?? defaultSessionConfigBaselineRoot(),
    workspaceRoot,
    hostProofSlots: positiveIntegerAtMost(
      "AGENTOS_HOST_PROOF_SLOTS", process.env.AGENTOS_HOST_PROOF_SLOTS ?? "3", MAX_HOST_PROOF_SLOTS,
    ),
    dependencyCacheRoot: process.env.RUNNER_DEPENDENCY_CACHE_ROOT ?? join(dirname(workspaceRoot), "dependency-cache"),
    // One bare mirror per remote. Provisioning clones every workspace out of it
    // and only ever fetches incrementally from GitHub; see repo-mirror.ts for
    // why a full clone per run had to go, and why the mirror lives in the home
    // of the account that runs the tasks rather than beside the workspaces.
    repoMirrorRoot: process.env.RUNNER_REPO_MIRROR_ROOT ?? join(home, ".agentos", "repo-mirrors"),
    failedWorkspaceRetention: Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10),
    // How often this runner asks the control plane which of its directories may
    // be reclaimed (issue #115). Workspace disposal is not urgent — the runner
    // already removes its own workspace when a run ends, and this sweep only
    // catches what a crash or a failed cleanup left behind — so the default is
    // deliberately slow enough to be invisible next to a poll interval.
    workspaceReclaimIntervalMs: positiveInteger(
      "RUNNER_WORKSPACE_RECLAIM_INTERVAL_MS", process.env.RUNNER_WORKSPACE_RECLAIM_INTERVAL_MS ?? "300000",
    ),
    toolDeadlineMs: positiveInteger("RUNNER_TOOL_DEADLINE_MS", process.env.RUNNER_TOOL_DEADLINE_MS ?? "1800000"),
    // Every control-plane call is a lease-critical operation: a heartbeat that
    // never returns stops renewing the lease, and a completion that never
    // returns loses a finished run to reconciliation just as surely as a
    // crash. None of these routes long-poll — claim returns 204 when there is
    // no work — so a flat ceiling is safe.
    apiTimeoutMs: positiveInteger("RUNNER_API_TIMEOUT_MS", process.env.RUNNER_API_TIMEOUT_MS ?? "10000"),
    runAsPrefix,
    servedKinds,
    binaries: Object.fromEntries(RUNNER_KINDS.map((runner) => {
      const definition = RUNNER_DEFINITIONS[runner];
      return [runner, process.env[definition.binaryEnvironment] ?? definition.defaultBinary];
    })) as Record<RunnerKind, string>,
  };
};
