import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTENDED_EXIT = 75;
const MACHINE_LINE = /^MERGE LEASE: (.+)$/gmu;
const HOLDER_LINE = /^MERGE LEASE HOLDER: (.+)$/gmu;

export const resolveMergeLeaseScriptPath = ({ environment = process.env, repoRoot } = {}) => {
  if (environment.AGENTOS_RELEASE_ROOT) {
    return path.join(path.resolve(environment.AGENTOS_RELEASE_ROOT), "scripts/merge-lease.sh");
  }
  return repoRoot
    ? path.join(path.resolve(repoRoot), "scripts/merge-lease.sh")
    : fileURLToPath(new URL("./merge-lease.sh", import.meta.url));
};

export const buildMergeLeaseArgv = ({ operation, scriptPath, task, reason, timeoutMinutes }) => {
  if (operation === "release") return [scriptPath, "release", "--task", task];
  if (operation === "status") return [scriptPath, "status"];
  if (operation === "acquire") {
    return [
      scriptPath,
      "acquire",
      "--task",
      task,
      "--reason",
      reason,
      "--timeout-minutes",
      String(timeoutMinutes),
    ];
  }
  throw new Error(`Unsupported merge lease operation: ${operation}`);
};

/**
 * Who holds the lease, as `merge-lease.sh` says it on the line beside its prose.
 * `null` means the script said nothing parseable about a holder: no line at all,
 * an explicit `none`, or a line this reader cannot trust. The caller decides
 * what that absence means -- for a contended acquire it is a holder the script
 * could not name, and for a status read it is no lease at all.
 */
export const parseMergeLeaseHolder = (output) => {
  const lines = [...output.matchAll(HOLDER_LINE)];
  if (lines.length !== 1) return null;
  const spoken = lines[0][1]?.trim();
  if (!spoken || spoken === "none") return null;
  let holder;
  try {
    holder = JSON.parse(spoken);
  } catch {
    return null;
  }
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return null;
  const optional = (value) => (typeof value === "string" && value.length > 0 ? value : null);
  if (typeof holder.holder !== "string" || holder.holder.length === 0) return null;
  if (typeof holder.acquiredAt !== "string" || Number.isNaN(Date.parse(holder.acquiredAt))) return null;
  return {
    holder: holder.holder,
    task: optional(holder.task),
    reason: optional(holder.reason),
    acquiredAt: holder.acquiredAt,
    sha: optional(holder.sha),
  };
};

/**
 * A hold in whole seconds, or null when either end of it is not a time. Both
 * the chain tail (packages/api/src/merge-lease-hold.ts) and the merge train
 * measure their hold this way, so the two numbers mean the same thing; a clock
 * adjustment must not produce a negative hold in either.
 */
export const mergeLeaseHoldSeconds = (acquiredAt, releasedAt) => {
  const acquiredAtMs = Date.parse(acquiredAt);
  const releasedAtMs = releasedAt instanceof Date ? releasedAt.getTime() : Date.parse(releasedAt);
  if (!Number.isFinite(acquiredAtMs) || !Number.isFinite(releasedAtMs)) return null;
  return Math.max(0, Math.floor((releasedAtMs - acquiredAtMs) / 1_000));
};

export const parseMergeLeaseRelease = (output) => {
  const lines = [...output.matchAll(MACHINE_LINE)];
  if (lines.length !== 1) return null;
  const spoken = lines[0][1]?.trim();
  if (!spoken) return null;
  const [outcome, ...tokens] = spoken.split(" ");
  switch (outcome) {
    case "released": {
      const [ref, sha, acquiredAt, ...extra] = tokens;
      if (ref === undefined || sha === undefined || acquiredAt === undefined || extra.length > 0) return null;
      return { outcome: "released", ref, sha, acquiredAt };
    }
    case "not-held":
      return tokens.length === 0 ? { outcome: "not-held" } : null;
    case "skipped":
      return tokens.length === 1 && tokens[0] ? { outcome: "skipped", heldFor: tokens[0] } : null;
    case "refused":
      return tokens.length === 1 && tokens[0] ? { outcome: "refused", heldBy: tokens[0] } : null;
    default:
      return null;
  }
};

const outputDetail = ({ stdout = "", stderr = "" }) => `${stdout}${stderr}`.trim();

export const classifyMergeLeaseExecution = ({ operation, code, stdout = "", stderr = "", error }) => {
  const detail = outputDetail({ stdout, stderr });
  if (operation === "acquire") {
    if (code === 0) return { outcome: "acquired", detail };
    if (code === CONTENDED_EXIT) {
      const holder = parseMergeLeaseHolder(detail);
      return { outcome: "contended", detail, ...(holder ? { holder } : {}) };
    }
    return {
      outcome: "unreachable",
      detail: detail || (error instanceof Error ? error.message : `merge-lease.sh acquire exited ${String(code)}`),
    };
  }

  if (operation === "status") {
    if (code !== 0) {
      return {
        outcome: "unreachable",
        detail: detail || (error instanceof Error ? error.message : `merge-lease.sh status exited ${String(code)}`),
      };
    }
    const holder = parseMergeLeaseHolder(detail);
    return holder ? { outcome: "held", holder, detail } : { outcome: "none", detail };
  }

  if (operation !== "release") throw new Error(`Unsupported merge lease operation: ${operation}`);
  const parsed = parseMergeLeaseRelease(detail);
  if (code === 0 && parsed && parsed.outcome !== "refused") return { ...parsed, detail };
  if (code === 1 && parsed?.outcome === "refused") return { ...parsed, detail };
  return {
    outcome: "unreachable",
    detail: detail || (error instanceof Error ? error.message : `merge-lease.sh release exited ${String(code)}`),
  };
};

export const isMergeLeaseReleaseAnomaly = (release) =>
  release.outcome === "skipped" || release.outcome === "refused" || release.outcome === "unreachable";

const defaultRunner = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.environment,
      timeout: options.processTimeoutMs,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : null,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error,
    };
  }
};

const execute = async ({ operation, repoRoot, environment, processTimeoutMs, task, reason, timeoutMinutes, runner }) => {
  const effectiveEnvironment = environment ?? process.env;
  const scriptPath = resolveMergeLeaseScriptPath({ environment: effectiveEnvironment, repoRoot });
  const argv = buildMergeLeaseArgv({ operation, scriptPath, task, reason, timeoutMinutes });
  const execution = await (runner ?? defaultRunner)("bash", argv, {
    cwd: repoRoot,
    environment: effectiveEnvironment,
    processTimeoutMs,
  });
  return classifyMergeLeaseExecution({ operation, ...execution });
};

export const acquireMergeLease = (options) => execute({ operation: "acquire", ...options });

export const releaseMergeLease = (options) => execute({ operation: "release", ...options });

/** Read the current holder without touching it. `status` writes nothing to origin. */
export const readMergeLeaseHolder = (options = {}) => execute({ operation: "status", ...options });
