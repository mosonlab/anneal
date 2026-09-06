/**
 * `@anneal/merge-executor` — the merge authority, in its own package, its own
 * process, and its own OS principal (§D-P1).
 *
 * What this process does NOT contain, structurally: an adapter, a prompt
 * builder, a CLI binary reference, workspace provisioning, or any delivery code.
 * It never spawns a child process, so neither the App private key nor a minted
 * installation token can reach a child environment or argv. Those properties
 * are asserted by `import-graph.test.ts` and `no-child-process.test.ts`, not
 * merely intended.
 */

import "dotenv/config";

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { MechanicalClaim } from "@anneal/db/claim-contract";
import { INTEGRATOR_OUTPUT_KIND, MERGE_INTEGRATOR_KIND, MERGE_INTEGRATOR_SCHEMA_VERSION, serializeMergeResult } from "@anneal/db/merge-integrator";

import {
  CompletionRejectedError,
  CompletionTransportError,
  makeAgentOsClient,
  MechanicalContractMismatchError,
  type MechanicalCancellation,
} from "./agentos.js";
import { loadExecutorConfig, type ExecutorConfig } from "./config.js";
import { execute, type Deps } from "./decision-table.js";
import { mintInstallationToken } from "./github-app-auth.js";
import { makeGitHubClient } from "./github.js";
import { evaluatePreconditions, liveDeps } from "./preconditions.js";
import { makeLog, makeRedactor, type ExecutorLog } from "./redaction.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

class MechanicalCancellationObserved extends Error {
  constructor(readonly cancellation: MechanicalCancellation) {
    super("persisted mechanical cancellation observed");
  }
}

class MechanicalApiIncompatible extends Error {
  constructor() {
    super("control plane does not refuse mechanical cancellation");
  }
}

export const runClaim = async (
  config: ExecutorConfig,
  privateKeyFile: string,
  claimed: MechanicalClaim,
  log: ExecutorLog,
  fetchImpl: typeof fetch = fetch,
  overrides: {
    mintToken?: typeof mintInstallationToken;
    makeGitHub?: typeof makeGitHubClient;
    executeDecision?: typeof execute;
  } = {},
): Promise<void> => {
  const agentos = makeAgentOsClient(config, fetchImpl);
  let runLog = log;
  let redactCompletionEvidence = makeRedactor();
  const complete = async (
    completion: { succeeded: boolean; outcome: Awaited<ReturnType<typeof execute>> | null; failureReason?: string },
  ): Promise<boolean> => {
    try {
      await agentos.complete(claimed, completion, redactCompletionEvidence);
      return true;
    } catch (error: unknown) {
      if (error instanceof CompletionRejectedError) {
        runLog.error(`mechanical completion rejected with HTTP ${error.status}: ${error.responseBody}`, {
          runId: claimed.run.id,
          status: error.status,
          responseBody: error.responseBody,
          ...(error.activityError === null ? {} : { activityError: error.activityError }),
        });
        return false;
      }
      if (error instanceof CompletionTransportError) {
        runLog.error("mechanical completion failed after network retry", { runId: claimed.run.id, error: error.cause });
        return false;
      }
      runLog.error("mechanical completion failed without retry", { runId: claimed.run.id, error });
      return false;
    }
  };
  const chainIndex = claimed.task.chainIndex;
  if (chainIndex === null) {
    // Fail closed and loudly: a mechanical run outside a chain has no
    // predecessor to read an authorization from, so there is nothing to execute.
    await complete({ succeeded: false, outcome: null, failureReason: "mechanical run is not part of a chain" });
    return;
  }

  const startedAt = new Date();
  let pendingCancellation: MechanicalCancellation | null = null;
  const checkCancellation = async (): Promise<void> => {
    if (pendingCancellation) throw new MechanicalCancellationObserved(pendingCancellation);
    const heartbeat = await agentos.heartbeat(claimed);
    if (heartbeat.cancellation) {
      pendingCancellation = heartbeat.cancellation;
      throw new MechanicalCancellationObserved(heartbeat.cancellation);
    }
    // A new executor must never run against an old API that can still accept a
    // cancellation in the check-to-merge gap. The capability marker turns an
    // unsafe inverse rollout into a fail-closed retry instead of a merge.
    if (heartbeat.mechanicalCancellationPolicy !== "refused") throw new MechanicalApiIncompatible();
  };
  const heartbeat = setInterval(() => {
    void agentos.heartbeat(claimed)
      .then((observed) => { if (observed.cancellation) pendingCancellation = observed.cancellation; })
      .catch((error: unknown) => { runLog.warn("heartbeat failed", { error }); });
  }, Math.max(5_000, config.leaseSeconds * 500));

  try {
    await agentos.start(claimed);
    // Old control planes could persist a cancellation for an already-started
    // mechanical Run. A rolling upgrade must consume that state before this
    // process mints GitHub authority or reaches an irreversible merge.
    await checkCancellation();
    const minted = await (overrides.mintToken ?? mintInstallationToken)({
      appId: config.githubAppId,
      installationId: config.githubAppInstallationId,
      privateKeyFile,
      restUrl: config.githubRestUrl,
      timeoutMs: config.githubAppAuthTimeoutMs,
      http: async ({ url, method, headers, body, signal }) => {
        const response = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }), signal });
        return { status: response.status, body: await response.text() };
      },
    });
    if (!minted.ok) {
      const suffix = minted.httpStatus === undefined ? "" : ` (HTTP ${minted.httpStatus})`;
      const failureReason = `GitHub App installation-token mint failed: ${minted.failure}${suffix}`;
      log.error("GitHub App installation-token mint failed", { runId: claimed.run.id, failure: minted.failure, ...(minted.httpStatus === undefined ? {} : { httpStatus: minted.httpStatus }) });
      await complete({ succeeded: false, outcome: null, failureReason });
      return;
    }

    runLog = log.withSecrets(minted.token);
    const redactInstallationToken = makeRedactor(minted.token);
    redactCompletionEvidence = redactInstallationToken;
    // The installation token is run-scoped: construct the GitHub surface only
    // after this Run's successful mint, and never retain it outside this call.
    const github = (overrides.makeGitHub ?? makeGitHubClient)({
      restUrl: config.githubRestUrl,
      graphqlUrl: config.githubGraphqlUrl,
      token: minted.token,
      timeoutMs: config.githubTimeoutMs,
      http: async ({ url, method, headers, body, signal }) => {
        try {
          const response = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }), signal });
          // Response text is untrusted platform input and can flow into a stop
          // record. Filter an echoed credential before the decision table sees
          // it; a replacement that makes a required field malformed fails shut.
          return { status: response.status, body: redactInstallationToken(await response.text()) };
        } catch {
          // Some transports include request headers in thrown errors. Convert
          // them to a fixed string before the shared HTTP layer classifies the
          // no-response case.
          throw new Error("GitHub request failed");
        }
      },
    });
    const deps: Deps = {
      readChain: () => agentos.readChain(claimed, chainIndex - 1),
      readOwnIntents: () => agentos.readOwnIntents(claimed, chainIndex),
      readPullRequest: (reference) => github.readPullRequest(reference),
      merge: async (reference, expectedHeadSha, expectedBase) => {
        // The current API refuses new mechanical cancellation, so this is an
        // upgrade fence for persisted legacy intent. Keep it immediately in
        // front of the only irreversible operation as defense in depth.
        await checkCancellation();
        return github.mergePullRequest(reference, expectedHeadSha, expectedBase);
      },
      disableAutoMerge: (pullRequestId) => github.disableAutoMerge(pullRequestId),
      dequeuePullRequest: (entryId) => github.dequeuePullRequest(entryId),
      writeIntent: async (intent) => {
        await agentos.writeActivity(claimed, `Merge intent recorded for PR #${intent.prNumber} at ${intent.headSha}`, {
          kind: MERGE_INTEGRATOR_KIND.intent,
          schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
          ...intent,
        });
      },
      sleep,
      now: () => new Date(),
      startedAt,
      mergeIdentityLogin: config.mergeIdentityLogin,
      pollAttempts: config.mergeabilityPollAttempts,
      pollIntervalMs: config.mergeabilityPollMs,
      pollBudgetMs: config.mergeabilityPollBudgetMs,
    };

    const outcome = await (overrides.executeDecision ?? execute)(deps);
    await checkCancellation();
    // The output is the latest view and is replaceable; the activity is the
    // append-only history the stop guard keys on (Y1). Both are written, always.
    await agentos.writeOutput(claimed, INTEGRATOR_OUTPUT_KIND, serializeMergeResult(outcome));
    await agentos.writeActivity(
      claimed,
      outcome.outcome === "merged"
        ? `Mechanical merge completed as ${outcome.mergeCommitSha}`
        : `Mechanical merge stopped: ${outcome.condition}`,
      { kind: MERGE_INTEGRATOR_KIND.result, schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION, ...outcome },
    );
    // Every executed contract ends SUCCESS, stop or merge alike. FAILURE is for
    // crashes only, so a recorded stop is never automatically retried.
    if (!await complete({ succeeded: true, outcome })) return;
    runLog.info("mechanical run completed", { runId: claimed.run.id, outcome: outcome.outcome });
  } catch (error: unknown) {
    if (error instanceof MechanicalCancellationObserved) {
      await agentos.acknowledgeCancellation(claimed, error.cancellation);
      runLog.info("persisted mechanical cancellation acknowledged", { runId: claimed.run.id });
      return;
    }
    if (error instanceof MechanicalApiIncompatible) {
      runLog.error("mechanical run refused incompatible control plane", { runId: claimed.run.id });
      await complete({
        succeeded: false,
        outcome: null,
        failureReason: "control plane does not enforce mechanical cancellation refusal",
      });
      return;
    }
    runLog.error("mechanical run crashed", { runId: claimed.run.id, error });
    // Deep transport errors can contain request headers. The run record names
    // the failed phase without serialising the thrown value into control-plane
    // evidence; the token-aware logger above remains the diagnostic backstop.
    await complete({ succeeded: false, outcome: null, failureReason: "merge executor crashed during mechanical execution" });
  } finally {
    clearInterval(heartbeat);
  }
};

/**
 * One claim attempt. A contract mismatch is *reported*, not logged, here: the
 * poll loop rechecks on an interval and only it can tell a newly entered
 * mismatch from the same one observed a minute later.
 */
export type ClaimOnceResult =
  | { kind: "idle" }
  | { kind: "handled" }
  | { kind: "contract-mismatch"; executorVersion: number | null; apiVersion: number };

export const claimOnce = async (
  config: ExecutorConfig,
  privateKeyFile: string,
  log: ExecutorLog,
  fetchImpl: typeof fetch = fetch,
  runClaimImpl: typeof runClaim = runClaim,
): Promise<ClaimOnceResult> => {
  const agentos = makeAgentOsClient(config, fetchImpl);
  let claimed: MechanicalClaim | null;
  try {
    claimed = await agentos.claim();
  } catch (error: unknown) {
    if (!(error instanceof MechanicalContractMismatchError)) throw error;
    return { kind: "contract-mismatch", executorVersion: error.executorVersion, apiVersion: error.apiVersion };
  }
  if (!claimed) return { kind: "idle" };
  if (claimed.executionMode !== "mechanical") {
    // Symmetric to the ordinary runner's refusal: an allowlisted runner id
    // should be offered nothing else, so being handed an agent run means the
    // allowlist is misconfigured. Refuse it rather than execute it.
    await agentos.complete(
      claimed,
      { succeeded: false, outcome: null, failureReason: "the merge executor does not execute model runs" },
      makeRedactor(),
    );
    return { kind: "handled" };
  }
  await runClaimImpl(config, privateKeyFile, claimed, log, fetchImpl);
  return { kind: "handled" };
};

/**
 * A `setTimeout` wait that a shutdown cuts short. The timer is what keeps the
 * event loop alive: a promise that only registers an `abort` listener settles
 * nothing and node exits 13 ("Detected unsettled top-level await"), which is
 * exactly how the documented mismatch "park" used to become a restart loop.
 */
const sleepUnlessAborted = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
};

/**
 * Poll until shutdown. A contract mismatch parks the daemon *alive*: it stops
 * claiming at the poll interval and re-checks once per recheck interval, so an
 * incompatible executor neither hammers the API nor dies into a service-manager
 * restart loop, and it resumes claiming by itself when a deploy or rollback on
 * either side makes the versions agree again. Logging follows the state, not
 * the attempt: one error on entering the mismatch, one line on leaving it.
 */
export const pollClaims = async (input: {
  signal: AbortSignal;
  pollIntervalMs: number;
  contractRecheckMs: number;
  log: ExecutorLog;
  claim: () => Promise<ClaimOnceResult>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> => {
  const sleepImpl = input.sleep ?? ((ms: number) => sleepUnlessAborted(ms, input.signal));
  let mismatched = false;
  while (!input.signal.aborted) {
    try {
      const result = await input.claim();
      if (result.kind === "contract-mismatch") {
        if (!mismatched) {
          mismatched = true;
          input.log.error("mechanical completion contract mismatch", {
            executorVersion: result.executorVersion,
            apiVersion: result.apiVersion,
          });
        }
        await sleepImpl(input.contractRecheckMs);
        continue;
      }
      if (mismatched) {
        mismatched = false;
        input.log.info("contract mismatch cleared");
      }
      if (result.kind === "idle") await sleepImpl(input.pollIntervalMs);
    } catch (error: unknown) {
      input.log.error("claim loop error", { error });
      await sleepImpl(input.pollIntervalMs);
    }
  }
};

export const main = async (): Promise<void> => {
  // The isolation gate runs BEFORE anything reads a credential, and its failure
  // is a non-zero exit with a named message — never a warning the deployment can
  // run past.
  const gate = evaluatePreconditions(liveDeps());
  if (!gate.ok) {
    for (const failure of gate.failures) process.stderr.write(`merge-executor startup refused: ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  const log = makeLog(makeRedactor());
  const config = loadExecutorConfig();
  log.info("merge executor started", { osUser: gate.osUser, runnerId: config.runnerId, privateKeyFile: gate.privateKeyFile });

  const shutdown = new AbortController();
  const stop = (): void => { shutdown.abort(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await pollClaims({
    signal: shutdown.signal,
    pollIntervalMs: config.pollIntervalMs,
    contractRecheckMs: config.contractRecheckMs,
    log,
    claim: () => claimOnce(config, gate.privateKeyFile, log),
  });
  log.info("merge executor stopped");
};

/**
 * `import.meta.url` is the *resolved* location: ESM follows symlinks before it
 * is set, while `process.argv[1]` is the path as spelled on the command line.
 * Comparing those two strings made this condition false in exactly the layout
 * this package's operator runbook prescribes — the daemon is started through a
 * `current` symlink into `releases/<oid>` — so `main` was never called, node
 * exited 0 having written nothing to either log, and the service manager
 * respawned that silence forever under KeepAlive.
 *
 * Resolve the invoked path the same way the loader did, and build the URL with
 * `pathToFileURL` rather than string concatenation, which also gets a path
 * containing a space or a non-ASCII character right.
 */
const invokedAs = process.argv[1];
if (invokedAs && import.meta.url === pathToFileURL(realpathSync(invokedAs)).href) {
  await main();
}
