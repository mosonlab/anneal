/**
 * The executor's configuration surface. Every default is fail-closed: an
 * unconfigured deployment claims no integrator run and merges nothing, rather
 * than merging with weaker guarantees.
 *
 * Private key bytes are deliberately absent from this file. Only the public
 * GitHub App identifiers are environment configuration; `preconditions.ts`
 * supplies the owner-only key path after the isolation gate passes.
 */

export type ExecutorConfig = {
  apiUrl: string;
  executorToken: string;
  runnerId: string;
  leaseSeconds: number;
  pollIntervalMs: number;
  /** How long a contract-mismatched daemon waits before re-checking the claim. */
  contractRecheckMs: number;
  apiTimeoutMs: number;
  githubRestUrl: string;
  githubGraphqlUrl: string;
  githubTimeoutMs: number;
  githubAppAuthTimeoutMs: number;
  githubAppId: string;
  githubAppInstallationId: string;
  /** The login of the dedicated merge identity, for the §5.1 replay determination. */
  mergeIdentityLogin: string;
  mergeabilityPollAttempts: number;
  mergeabilityPollMs: number;
  /** One wall-clock cap over the whole bounded poll (§11.2). */
  mergeabilityPollBudgetMs: number;
};

const positiveInteger = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const required = (name: string, raw: string | undefined): string => {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is required; the merge executor refuses to start without it`);
  return value;
};

const requiredIdentifier = (name: string, raw: string | undefined): string => {
  const value = required(name, raw);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive decimal identifier`);
  return value;
};

/**
 * The executor credential, refused when it is absent or when the deployment has
 * aliased it onto RUNNER_TOKEN/OPERATOR_TOKEN. The API applies the same rule
 * (`mergeExecutorTokenIsDistinct`); refusing here as well means the aliasing
 * mistake stops the process at startup instead of silently degrading to a
 * principal that can claim nothing.
 */
const requireDistinctExecutorToken = (env: Record<string, string | undefined>): string => {
  const token = required("MERGE_EXECUTOR_TOKEN", env.MERGE_EXECUTOR_TOKEN);
  const aliased = [["RUNNER_TOKEN", env.RUNNER_TOKEN], ["OPERATOR_TOKEN", env.OPERATOR_TOKEN]] as const;
  for (const [name, other] of aliased) {
    if (other?.trim() && other.trim() === token) {
      throw new Error(`MERGE_EXECUTOR_TOKEN must not equal ${name}; the merge executor refuses to start with a shared credential`);
    }
  }
  return token;
};

export const loadExecutorConfig = (env: Record<string, string | undefined> = process.env): ExecutorConfig => {
  const attempts = positiveInteger("MERGE_EXECUTOR_MERGEABILITY_POLL_ATTEMPTS", env.MERGE_EXECUTOR_MERGEABILITY_POLL_ATTEMPTS, 5);
  const intervalMs = positiveInteger("MERGE_EXECUTOR_MERGEABILITY_POLL_MS", env.MERGE_EXECUTOR_MERGEABILITY_POLL_MS, 2_000);
  return {
    apiUrl: env.MERGE_EXECUTOR_API_URL?.trim() || "http://localhost:3000",
    // §D-P1 rule 3. Its own credential, never the fleet-wide RUNNER_TOKEN: the
    // API grants mechanical authority to this bearer alone, so sharing the
    // runner token would hand every runner the ability to claim a merge.
    executorToken: requireDistinctExecutorToken(env),
    // Must also appear in the API's MERGE_EXECUTOR_RUNNER_IDS allowlist, or the
    // claim route offers this process nothing at all (§D-P1 rule 3).
    runnerId: required("MERGE_EXECUTOR_RUNNER_ID", env.MERGE_EXECUTOR_RUNNER_ID),
    leaseSeconds: positiveInteger("MERGE_EXECUTOR_LEASE_SECONDS", env.MERGE_EXECUTOR_LEASE_SECONDS, 120),
    pollIntervalMs: positiveInteger("MERGE_EXECUTOR_POLL_INTERVAL_MS", env.MERGE_EXECUTOR_POLL_INTERVAL_MS, 5_000),
    contractRecheckMs: positiveInteger("MERGE_EXECUTOR_CONTRACT_RECHECK_MS", env.MERGE_EXECUTOR_CONTRACT_RECHECK_MS, 60_000),
    apiTimeoutMs: positiveInteger("MERGE_EXECUTOR_API_TIMEOUT_MS", env.MERGE_EXECUTOR_API_TIMEOUT_MS, 15_000),
    githubRestUrl: env.GITHUB_REST_URL?.trim() || "https://api.github.com",
    githubGraphqlUrl: env.GITHUB_GRAPHQL_URL?.trim() || "https://api.github.com/graphql",
    githubTimeoutMs: positiveInteger("MERGE_EXECUTOR_GITHUB_TIMEOUT_MS", env.MERGE_EXECUTOR_GITHUB_TIMEOUT_MS, 15_000),
    githubAppAuthTimeoutMs: positiveInteger(
      "MERGE_EXECUTOR_GITHUB_APP_AUTH_TIMEOUT_MS",
      env.MERGE_EXECUTOR_GITHUB_APP_AUTH_TIMEOUT_MS,
      15_000,
    ),
    githubAppId: requiredIdentifier("MERGE_EXECUTOR_GITHUB_APP_ID", env.MERGE_EXECUTOR_GITHUB_APP_ID),
    githubAppInstallationId: requiredIdentifier(
      "MERGE_EXECUTOR_GITHUB_APP_INSTALLATION_ID",
      env.MERGE_EXECUTOR_GITHUB_APP_INSTALLATION_ID,
    ),
    mergeIdentityLogin: required("MERGE_EXECUTOR_IDENTITY_LOGIN", env.MERGE_EXECUTOR_IDENTITY_LOGIN),
    mergeabilityPollAttempts: attempts,
    mergeabilityPollMs: intervalMs,
    mergeabilityPollBudgetMs: positiveInteger(
      "MERGE_EXECUTOR_MERGEABILITY_POLL_BUDGET_MS",
      env.MERGE_EXECUTOR_MERGEABILITY_POLL_BUDGET_MS,
      attempts * intervalMs * 2,
    ),
  };
};
