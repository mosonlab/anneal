import { createHash } from "node:crypto";

import {
  agentExitVerdict,
  PR_TEMPLATE_NAME,
  type BudgetGate,
  type PersistedRunOutput,
  type PrHandoffOutput,
  type RunOutcome,
  type RunOutputEvidence,
} from "@anneal/db";

import {
  ADAPTER_VERSION,
  adapters,
  buildChildEnvironment,
  buildPrompt,
  failureReasonFromEvidence,
  manifestFor,
  outputTail,
  PREFLIGHT_CLASS,
  promptHashFor,
  RUNNER_DEFINITIONS,
  type AdapterEvent,
  type CliAdapter,
  type ExitEvidence,
  type RuntimeHandle,
} from "./adapters.js";
import {
  openControlPlane,
  isEventsRequestTooLarge,
  oversizedEventIndex,
  retriableStartupError,
  type ClaimedTask,
  type ControlPlane,
  type PreflightReport,
  type RunSession,
  type SessionTaskOutput,
} from "./api.js";
import {
  probeSupportedCliAvailability,
  type CliAvailability,
} from "./availability.js";
import { evaluateBudget } from "./budget.js";
import type { RunnerConfig, RunnerKind } from "./config.js";
import { deliverWorkspace } from "./delivery.js";
import {
  classifyDependencyProvisioningFailure,
  decideDependencyProvisioning,
} from "./dependency-provisioning.js";
import { disposeWorkspace, type WorkspaceDisposal } from "./dispose-workspace.js";
import {
  buildFailureEnvelope,
  completionEnvelope,
  type FailurePhase,
  RUNNER_EXCEPTION_REASON,
  runnerExceptionEnvelope,
  summarizeEvidence,
} from "./envelope.js";
import { transientBackoff } from "./network-retry.js";
import {
  decideProviderRelaunch,
  PROVIDER_RESUME_MAX_ATTEMPTS,
  providerRelaunchRefusalSummary,
  type ProviderRelaunchLeaseFacts,
} from "./provider-relaunch.js";
import { createRunLease, deliverUnderLease, type RunLease, type RunLeaseClock } from "./run-lease.js";
import { createSessionEventQueue } from "./session-event-queue.js";
import { openSessionConfig, type SessionConfigLease } from "./session-config-lease.js";
import { readMergeTrainOutputHandoff } from "./merge-train-output-handoff.js";
import { readRegressionOutputHandoff, type RegressionOutputHandoffBlock } from "./regression-output-handoff.js";
import { readTaskOutputReceipt } from "./task-output-receipt.js";
import {
  captureWorkspaceResult, captureWorkspaceSnapshot, cleanupAgentScratch, materializeRuntimeTools, provisionAgentScratch, provisionSessionConfig,
  provisionWorkspace, reuseWorkspace, workspaceEnvironment, writeSessionCredentials,
  type AgentScratch, type Workspace, type WorkspaceSnapshot,
} from "./workspace.js";
import { observeExternalWorktrees } from "./worktree-observer.js";

const serializeTool = (tool: RuntimeHandle["inFlightTool"]): Record<string, unknown> | null => tool ? {
  id: tool.id,
  name: tool.name,
  startedAt: tool.startedAt.toISOString(),
  lastProgressAt: tool.lastProgressAt.toISOString(),
} : null;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const persistMechanicalOutputHandoff = async (
  session: RunSession,
  handoff: SessionTaskOutput,
  sink: (event: AdapterEvent) => void,
): Promise<void> => {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await session.publishOutput(handoff);
      return;
    } catch (error: unknown) {
      if (attempt === attempts || !retriableStartupError(error)) throw error;
      sink({
        source: "RUNNER",
        type: "REGRESSION_OUTPUT_HANDOFF_RETRYING",
        payload: { attempt, attempts, message: errorMessage(error) },
      });
    }
  }
};

const appendRetainedSessionConfig = (reason: string, path: string | null): string =>
  `${reason}${path ? `; session CLI config retained at ${path}` : ""}`;

const missingOutputRemediationInput = (outputKind: string): string => [
  `Anneal detected that this Run finished its work but did not persist its required '${outputKind}' task output.`,
  "Do not redo the task, edit files, commit, push, open a PR, or run delivery steps.",
  `Using the work and evidence already produced in this conversation, call task_output with kind '${outputKind}' and a body that satisfies the task's exact output contract and current HEAD binding.`,
  "If the write is rejected, correct the body and retry. Then call task_status and finish only after its outputEvidence reports satisfaction case 'delivered' for this Run.",
].join("\n");

export const providerDisconnectResumeInput = (): string => [
  "The provider stream dropped before the task reached its terminal event.",
  "Continue this conversation in the same Anneal Run and workspace.",
  "Do not redo or revert already-completed work or files that have already been written.",
  "Carry on from where the interrupted turn stopped and finish the task normally.",
].join("\n");

const sameWorkspaceSnapshot = (left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const workspaceSnapshotEvidence = (snapshot: WorkspaceSnapshot): Record<string, unknown> => ({
  headSha: snapshot.headSha,
  treeDigest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  dirty: snapshot.status.length > 0,
});

const exitEvidencePayload = (evidence: ExitEvidence): Record<string, unknown> => ({
  exitCode: evidence.exitCode,
  signal: evidence.signal,
  terminalEventSeen: evidence.terminalEventSeen,
  terminalSuccess: evidence.terminalSuccess,
  terminationReason: evidence.terminationReason,
  finalOutputTail: summarizeEvidence(evidence.finalOutput),
  providerErrorTail: summarizeEvidence(evidence.providerError),
  stdoutTail: summarizeEvidence(evidence.stdout),
  stderrTail: summarizeEvidence(evidence.stderr),
});

type MechanicalHandoff =
  | Awaited<ReturnType<typeof readRegressionOutputHandoff>>
  | Awaited<ReturnType<typeof readMergeTrainOutputHandoff>>;

/** Read whichever mechanical deliverable this step's runtime tool authors. A
 * script never holds session credentials; the Runner publishes its handoff
 * through the fenced control-plane transport. */
const readMechanicalOutputHandoff = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace,
): Promise<MechanicalHandoff> => await readRegressionOutputHandoff(config, claim, workspace)
  ?? await readMergeTrainOutputHandoff(config, claim, workspace);

type AbsentTerminalProduct = { case: "absent"; reason: "none" | "wrong-output-kind" | "output-head-mismatch" };
type MechanicalTerminalProduct = { case: "mechanical-handoff"; handoff: SessionTaskOutput };
type DeliveredTerminalProduct = { case: "delivered-output"; output: PersistedRunOutput };

/** The shared, side-effect-free detection used by both established settling paths. */
function detectDurableTerminalProduct(input: {
  mechanicalHandoff: Exclude<MechanicalHandoff, null>;
  outputEvidence: null;
  capturedHeadSha: undefined;
}): MechanicalTerminalProduct | AbsentTerminalProduct;
function detectDurableTerminalProduct(input: {
  mechanicalHandoff: null;
  outputEvidence: RunOutputEvidence | null;
  capturedHeadSha: string | undefined;
}): DeliveredTerminalProduct | AbsentTerminalProduct;
function detectDurableTerminalProduct(input: {
  mechanicalHandoff: MechanicalHandoff;
  outputEvidence: RunOutputEvidence | null;
  capturedHeadSha: string | undefined;
}): MechanicalTerminalProduct | DeliveredTerminalProduct | AbsentTerminalProduct {
  if (input.mechanicalHandoff !== null && !("reason" in input.mechanicalHandoff)) {
    return { case: "mechanical-handoff", handoff: input.mechanicalHandoff };
  }
  const satisfaction = input.outputEvidence?.satisfaction;
  if (satisfaction?.case !== "delivered") return { case: "absent", reason: "none" };
  if (satisfaction.output.kind !== "result") return { case: "absent", reason: "wrong-output-kind" };
  if (input.capturedHeadSha === undefined || satisfaction.output.commitSha !== input.capturedHeadSha) {
    return { case: "absent", reason: "output-head-mismatch" };
  }
  return { case: "delivered-output", output: satisfaction.output };
}

const cleanup = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace | null,
  retain: boolean,
  alreadyDurable = false,
  controlPlane: ControlPlane = openControlPlane(config),
): Promise<WorkspaceDisposal> => {
  if (!workspace) return { cleanupStatus: "SUCCEEDED", workspaceRetained: false, salvage: null };
  return disposeWorkspace(config, { source: "runner", claim }, {
    ...workspace,
    pinnedBaseSha: workspace.pinnedBaseSha ?? null,
  }, { retain, alreadyDurable }, controlPlane);
};

const preflightEvidence = (message: string): ExitEvidence => ({
  // 127 is what "the CLI is not there" means downstream (BINARY_NOT_FOUND). The
  // preflight now names that case itself rather than leaving it to be read out
  // of a spawn error's wording, which is also CLI output nobody bounded.
  exitCode: message.startsWith(PREFLIGHT_CLASS.cliMissing) || message.includes("No such file") || message.includes("ENOENT") ? 127 : 1,
  signal: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  finalOutput: null,
  providerError: null,
  terminationReason: null,
  stdout: "",
  stderr: message,
});

export type ExecuteClaimDependencies = {
  materializeRuntimeTools?: typeof materializeRuntimeTools;
  provisionSessionConfig?: typeof provisionSessionConfig;
  cleanupAgentScratch?: typeof cleanupAgentScratch;
  writeSessionCredentials?: typeof writeSessionCredentials;
  /** The CLI the run is executed through. Defaults to the claim's runner kind. */
  adapter?: CliAdapter;
  controlPlane?: ControlPlane;
  /** Test seams for the fixed in-Run provider-resume timing policy. */
  providerResumeBackoff?: (attempt: number) => Promise<void>;
  runLeaseClock?: RunLeaseClock;
};

export const executeClaim = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  dependencies: ExecuteClaimDependencies = {},
): Promise<void> => {
  const adapter = dependencies.adapter ?? adapters[claim.runner];
  const controlPlane = dependencies.controlPlane ?? openControlPlane(config);
  const session = controlPlane.openRun(claim);
  let workspace: Workspace | null = null;
  let scratch: AgentScratch | null = null;
  let handle: RuntimeHandle | null = null;
  let sessionConfigLease: SessionConfigLease | null = null;
  // The budget gate that stopped this Run, kept as the gate it was rather than
  // as prose the control plane would have to grep for "walltime". Held in a
  // record because the heartbeat callback is its only writer, and a `let`
  // written only from a callback stays narrowed to its initializer.
  const budget: { refusal: { gate: BudgetGate; reason: string } | null } = { refusal: null };
  let terminalFailureReason: string | null = null;
  let taskOutputStatusCheckFailed = false;
  let regressionHandoffBlock: RegressionOutputHandoffBlock | null = null;
  let workspacePublicationForbidden = false;
  // Where the run is, for the failure envelope. The API reads this to decide
  // whether a failed attempt spends the task's budget: only EXECUTE is the
  // agent's own work, everything else is this process's plumbing.
  let phase: FailurePhase = "PROVISION";
  // What the agent produced, saved the moment its process exits and before any
  // of the DELIVER-phase work that can throw. The catch path rebuilds its
  // evidence out of an error message alone, so a lease, an event flush or a
  // cleanup that fails after a finished agent would otherwise complete the run
  // with the exception text and nothing else — discarding the account of a run
  // that had already produced one, which is the exact loss issue #114 is about,
  // one stage further along.
  let producedOutput: string | null = null;
  // Collected while the checkout still exists, then reused if a later cleanup
  // or completion write throws into the outer exception path. The observation
  // is report-only: failure to list worktrees is activity evidence, never a
  // different terminal verdict.
  let worktreeContainmentObserved = false;
  let worktreeContainmentViolations: string[] = [];
  const worktreeContainmentReport = async (): Promise<{ worktreeContainmentViolations?: string[] }> => {
    if (!workspace) return {};
    if (!worktreeContainmentObserved) {
      worktreeContainmentObserved = true;
      try {
        worktreeContainmentViolations = await observeExternalWorktrees(
          config,
          workspace.path,
        );
      } catch (error: unknown) {
        await session.note(
          `Unable to observe run worktree containment: ${errorMessage(error)}`,
          { stream: "runner" },
        ).catch(() => undefined);
      }
    }
    return worktreeContainmentViolations.length > 0 ? { worktreeContainmentViolations } : {};
  };
  const now = dependencies.runLeaseClock?.now ?? Date.now;
  const runLeaseClock = dependencies.runLeaseClock;
  const claimStartedAt = new Date(now());
  const pendingEvents = createSessionEventQueue({ nextSeq: claim.nextEventSeq });
  const runLease = createRunLease<RuntimeHandle>({
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    leaseSeconds: config.leaseSeconds,
    initialPhase: { name: "provision", startedAt: claimStartedAt },
    // Queue bytes ride every heartbeat, in each phase, so an operator can see a
    // runner holding events it cannot deliver before the bound starts dropping.
    send: (evidence) => session.heartbeat({ ...evidence, eventQueueBytes: pendingEvents.bytes }),
    stopProvider: (target, reason) => adapter.kill(target, reason),
    acknowledgeCancellation: async (request) => session.acknowledgeCancellation(
      request,
      workspace,
      await worktreeContainmentReport(),
    ),
    onRevocationStopError: (error) => {
      console.error(`Unable to drain fenced Run ${claim.run.id}: ${errorMessage(error)}`);
    },
    onRenewalError: (error) => { console.error("Run Lease renewal failed", error); },
    ...(runLeaseClock ? { clock: runLeaseClock } : {}),
  });
  let eventFlushPromise: Promise<void> | null = null;
  let providerConversationId = claim.resume?.providerConversationId ?? null;
  const rememberProviderConversationId = (): string | null => {
    const reported = handle?.providerConversationId;
    if (reported) providerConversationId = reported;
    return providerConversationId;
  };
  const sink = (event: AdapterEvent): void => { pendingEvents.push(event); };
  const flushEvents = (): Promise<void> => {
    if (eventFlushPromise) return eventFlushPromise;
    eventFlushPromise = (async () => {
      while (pendingEvents.length > 0 && runLease.held) {
        // Keep the batch in the queue until the API accepts it. A failed append
        // therefore remains the head of the queue for the next flush attempt,
        // while the single worker prevents a later batch overtaking it.
        const batch = pendingEvents.batch();
        try {
          await session.emit(batch, rememberProviderConversationId());
        } catch (error) {
          // The two failures the queue can resolve itself. Every other one —
          // 5xx, network, lost authority — belongs to the caller's retry, with
          // the queue's own bound protecting memory meanwhile.
          const index = oversizedEventIndex(error);
          if (index !== null) {
            // The API refused a single event of this batch by index: lose it.
            const refused = batch[index];
            if (!refused || !pendingEvents.reject(refused.seq, "payload-too-large")) throw error;
            continue;
          }
          if (isEventsRequestTooLarge(error)) {
            // The refusal names no event, so send less rather than resend the
            // same body. Once a batch is one event and is still refused, that
            // event alone is impossible and the queue loses it.
            if (pendingEvents.reduceBatch()) {
              console.warn(`Run ${claim.run.id} events request refused as too large; retrying with a smaller batch`);
              continue;
            }
            const refused = batch[0];
            if (refused && pendingEvents.reject(refused.seq, "request-too-large")) continue;
          }
          throw error;
        }
        pendingEvents.release(batch);
      }
    })().finally(() => { eventFlushPromise = null; });
    return eventFlushPromise;
  };

  const adoptAuthorityError = async (error: unknown): Promise<boolean> => {
    return runLease.adoptError(error);
  };

  const observeEventFlush = async (error: unknown): Promise<void> => {
    if (await adoptAuthorityError(error)) console.error("Event flush failed", error);
  };

  const drainEventsUnderLease = async (openLease: RunLease<RuntimeHandle>): Promise<void> => {
    let lastError: unknown = null;
    while (pendingEvents.length > 0 && openLease.held) {
      try {
        // This may first await an active-run flush. Recheck the retained queue
        // after it settles so its rejection can never become the terminal
        // verdict without a fresh delivery-phase attempt.
        await flushEvents();
        lastError = null;
      } catch (error: unknown) {
        lastError = error;
        await observeEventFlush(error);
      }
      if (pendingEvents.length === 0 || !openLease.held) break;
      const remainingMs = openLease.deadline - now();
      if (remainingMs <= 0) throw lastError ?? new Error("Event delivery lease expired with events still pending");
      // Reuse the lease's heartbeat cadence instead of introducing a separate
      // retry budget. Its renewal loop continues independently during the wait.
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(config.heartbeatIntervalMs, remainingMs)));
    }
  };

  const probeDurableTerminalProduct = async (): Promise<"present" | "absent" | "inconclusive"> => {
    if (!workspace) return "inconclusive";
    let mechanicalHandoff: MechanicalHandoff = null;
    try {
      mechanicalHandoff = await readMechanicalOutputHandoff(config, claim, workspace);
      if (mechanicalHandoff !== null
        && detectDurableTerminalProduct({ mechanicalHandoff, outputEvidence: null, capturedHeadSha: undefined }).case
          === "mechanical-handoff") {
        return "present";
      }
    } catch {
      // An unreadable handoff could be a durable product. Refuse a relaunch and
      // let the established regression path below own diagnostics and outcome.
      return "inconclusive";
    }
    try {
      const capturedHeadSha = (await captureWorkspaceResult(config, workspace)).headSha;
      const outputEvidence = await session.outputStatus();
      return detectDurableTerminalProduct({ mechanicalHandoff: null, outputEvidence, capturedHeadSha }).case
        === "delivered-output" ? "present" : "absent";
    } catch {
      // An inconclusive status read is not evidence that no product exists.
      // Fail closed and let the established delivery path retry and report it.
      return "inconclusive";
    }
  };

  try {
    // The dependency decision is made once, here, and passed down. It is the
    // first thing this function does: a refused claim shape must not reach a
    // runner workspace, scratch, child environment, adapter preflight or
    // provider launch, and the condition goes in both terminal fields so old
    // and new control planes can expose it.
    const provisioning = decideDependencyProvisioning(claim);
    if (!provisioning.admitted) {
      await session.finish({
        outcome: { case: "terminal-protocol-failure", reason: provisioning.condition },
        exitCode: null,
        terminationReason: provisioning.condition,
        cleanupStatus: "SUCCEEDED",
        workspaceRetained: false,
      });
      return;
    }
    // §D-P1 rule 4 — defence in depth behind the claim-side allowlist, and the
    // FIRST execution-mode check this function performs. Everything below it constructs something a
    // merge credential must never be near: a workspace, a prompt, a child
    // environment, an adapter preflight, a spawned CLI, a delivery push. A
    // mechanical run reaching an ordinary runner means the allowlist was
    // misconfigured; the run is failed closed and non-retryable rather than
    // executed, because retrying it here would just repeat the violation.
    if (claim.executionMode === "mechanical") {
      await session.finish({
        outcome: {
          case: "terminal-protocol-failure",
          reason: "This runner does not execute mechanical runs; @anneal/merge-executor does",
        },
        exitCode: null,
        terminationReason: "mechanical run claimed by a model runner",
        cleanupStatus: "SUCCEEDED",
        workspaceRetained: false,
      });
      return;
    }
    // `maxRunsPerTask` is the persisted authorization written by `openRun`;
    // this boot gate consumes that verdict and must not recompute a Task budget.
    if (claim.run.runNumber > claim.run.maxRunsPerTask) {
      const { salvage: _salvage, ...finishedCleanup } = await cleanup(config, claim, workspace, false, false, controlPlane);
      await session.finish({
        outcome: {
          case: "budget-exhausted",
          gate: "max-runs",
          reason: "Maximum run budget exceeded before launch",
        },
        exitCode: null,
        terminationReason: "max-runs budget exceeded",
        ...finishedCleanup,
      });
      return;
    }

    workspace = claim.resume
      ? await reuseWorkspace(config, claim)
      : await provisionWorkspace(config, claim, provisioning.decision);
    if (!provisioning.decision.provision) {
      // This is deliberately a fenced activity write with no fallback: the
      // agent must have durable evidence of the dependency-free checkout
      // before its adapter is preflighted or launched.
      await session.note(provisioning.decision.evidence, { stream: "runner" });
    }
    const prompt = buildPrompt(claim);
    scratch = await provisionAgentScratch(config, claim.session.id);
    await (dependencies.materializeRuntimeTools ?? materializeRuntimeTools)(config, scratch);
    sessionConfigLease = openSessionConfig(config, claim, scratch, dependencies);
    await (dependencies.provisionSessionConfig ?? provisionSessionConfig)(config, claim.runner, scratch, {
      reuse: claim.resume !== null,
    });
    const env = buildChildEnvironment(config, claim, scratch, workspace.path, workspace.commitHooksPath);
    const preflight = await adapter.preflight({ config, runner: claim.runner, model: claim.run.model, env });
    if (!runLease.held) {
      runLease.abandonProviderLaunch();
      const authority = await runLease.checkpoint();
      if (!authority.held && authority.reason === "cancelled") return;
      const cleaned = await cleanup(config, claim, workspace, false, false, controlPlane);
      const { salvage: _salvage, ...cleanupOutcome } = cleaned;
      await session.recordCleanup(cleanupOutcome).catch((error: unknown) => {
        console.error(`Unable to record lease-independent cleanup outcome: ${errorMessage(error)}`);
      });
      return;
    }
    if (!preflight.ok) {
      runLease.abandonProviderLaunch();
      const evidence = preflightEvidence(preflight.error ?? "Preflight failed");
      const classified = adapter.classifyError(evidence);
      const worktreeReport = await worktreeContainmentReport();
      const { salvage: _salvage, ...finishedCleanup } = await cleanup(config, claim, workspace, config.failedWorkspaceRetention > 0, false, controlPlane);
      const retainedPath = await sessionConfigLease.retainedPath();
      await session.finish({
        outcome: {
          case: "provider-failure",
          reason: appendRetainedSessionConfig(preflight.error ?? "Preflight failed", retainedPath),
          envelope: buildFailureEnvelope({
            phase,
            evidence,
            agentExited: false,
            runnerClass: classified.failureClass,
          }),
        },
        exitCode: evidence.exitCode,
        signal: evidence.signal,
        terminationReason: evidence.terminationReason,
        branch: workspace.branch,
        baseSha: workspace.baseSha,
        headSha: workspace.baseSha,
        ...worktreeReport,
        ...finishedCleanup,
      });
      return;
    }

    const credentialsPath = await (dependencies.writeSessionCredentials ?? writeSessionCredentials)(config, claim, workspace);
    if (!runLease.held) {
      runLease.abandonProviderLaunch();
      await runLease.checkpoint();
      return;
    }
    const spec = { config, claim, workingDirectory: workspace.path, env, prompt, credentialsPath };
    const launchedHandle = await runLease.launch(() => claim.resume
      ? adapter.resume({ ...spec, ...claim.resume }, sink)
      : adapter.start(spec, sink));
    if (!launchedHandle) return;
    handle = launchedHandle;
    phase = "EXECUTE";
    const executionStartedAt = handle.startedAt;
    let executionLastProgressEventAt = handle.lastProgressEventAt;
    await runLease.enterPhase({
      name: "execute",
      evidence: async () => {
        if (!handle) throw new Error("Execute heartbeat requires a provider handle");
        const heartbeatHandle = handle;
        const snapshot = await adapter.heartbeat(heartbeatHandle);
        // A new adapter state uses its own startedAt as lastProgressEventAt.
        // That spawn timestamp is not provider progress and must not reset a
        // stall window carried from the previous child.
        if (snapshot.lastProgressEventAt > heartbeatHandle.startedAt
          && snapshot.lastProgressEventAt > executionLastProgressEventAt) {
          executionLastProgressEventAt = snapshot.lastProgressEventAt;
        }
        const decision = evaluateBudget({
          now: new Date(now()),
          startedAt: executionStartedAt,
          maxDurationMs: claim.run.maxDurationMin * 60_000,
          currentRunNumber: claim.run.runNumber,
          maxRuns: claim.run.maxRunsPerTask,
          processAlive: snapshot.processAlive,
          lastProgressEventAt: executionLastProgressEventAt,
          stallTimeoutMs: claim.run.stallTimeoutMin * 60_000,
          toolDeadlineMs: config.toolDeadlineMs,
          inFlightTool: snapshot.inFlightTool,
        });
        if (!decision.allowed && snapshot.processAlive) {
          budget.refusal = { gate: decision.gate, reason: `${decision.gate}: ${decision.reason}` };
          await runLease.stopProvider(heartbeatHandle, budget.refusal.reason);
        }
        return {
          processAlive: snapshot.processAlive,
          lastProgressEventAt: executionLastProgressEventAt,
          inFlightTool: serializeTool(snapshot.inFlightTool),
        };
      },
      // Event delivery remains detached from renewal: a failed or slow append
      // cannot occupy the run Lease renewal loop, and the queue stays ordered.
      afterRenewal: () => { if (runLease.held) void flushEvents().catch(observeEventFlush); },
    });
    // A resume dispatches its continuation input rather than the fresh prompt.
    // Keep the launch manifest and durable Run hash tied to the bytes that this
    // invocation actually handed to the provider.
    const dispatchedPrompt = claim.resume?.input ?? prompt;
    const manifest = manifestFor(spec, dispatchedPrompt);
    await session.start({
      adapterVersion: ADAPTER_VERSION,
      cliVersion: preflight.cliVersion ?? "unknown",
      authMode: preflight.authMode,
      manifest,
      promptHash: promptHashFor(dispatchedPrompt),
      workspacePath: workspace.path,
      branch: workspace.branch,
      baseSha: workspace.baseSha,
      runtimeHandle: handle.pid ? `${config.runnerId}:${handle.pid}` : `${config.runnerId}:pending`,
    });
    // The first append is also best-effort from the heartbeat loop's point of
    // view. If the endpoint is down, keep the batch queued and let the active
    // renewal loop keeps the run Lease live while later flushes retry it.
    void flushEvents().catch(observeEventFlush);

    let evidence = await handle.exit;
    producedOutput = outputTail(evidence);
    let providerResumeAttempts = 0;
    const resumeBackoff = dependencies.providerResumeBackoff ?? transientBackoff;
    const renewLease = async (): Promise<ProviderRelaunchLeaseFacts> => {
      const renewal = await runLease.renewNow();
      return {
        accepted: renewal.accepted,
        authorityHeld: renewal.authority.held,
        leaseHeadroomMs: renewal.leaseHeadroomMs,
      };
    };
    while (true) {
      const deadHandle = handle;
      if (deadHandle.lastProgressEventAt > deadHandle.startedAt
        && deadHandle.lastProgressEventAt > executionLastProgressEventAt) {
        executionLastProgressEventAt = deadHandle.lastProgressEventAt;
      }
      const deadProviderConversationId = rememberProviderConversationId();
      const relaunch = await decideProviderRelaunch({
        purpose: "resume-disconnect",
        providerConversationId: deadProviderConversationId,
        // The shared verdict owns the exit record; the adapter adds only the
        // provider-shaped reading of a drop it already classified.
        exitResumable: agentExitVerdict(evidence).case === "dropped"
          && (adapter.isProviderDisconnect?.(evidence, deadHandle.providerState) ?? false),
        attempts: providerResumeAttempts,
        authorityHeld: () => runLease.authority.held,
        budgetRefused: () => budget.refusal !== null,
        remainingWalltimeMs: () => executionStartedAt.getTime() + claim.run.maxDurationMin * 60_000 - now(),
        probeDurableTerminalProduct,
        renewLease,
        backoff: async (attempt) => {
          const backoffStartedAt = now();
          await resumeBackoff(attempt);
          return Math.max(0, now() - backoffStartedAt);
        },
      });
      if (!relaunch.allowed) {
        if (relaunch.reason === "attempt-cap-reached") {
          sink({
            source: "RUNNER",
            type: "PROVIDER_RESUME_EXHAUSTED",
            payload: {
              attempt: providerResumeAttempts + 1,
              cap: PROVIDER_RESUME_MAX_ATTEMPTS,
              providerConversationId: deadProviderConversationId,
              backoffMs: 0,
              evidence: exitEvidencePayload(evidence),
            },
          });
        }
        break;
      }

      sink({
        source: "RUNNER",
        type: "PROVIDER_RESUME_STARTED",
        payload: {
          attempt: relaunch.attempt,
          cap: PROVIDER_RESUME_MAX_ATTEMPTS,
          providerConversationId: relaunch.providerConversationId,
          backoffMs: relaunch.backoffMs,
          evidence: exitEvidencePayload(evidence),
        },
      });
      const resumedHandle = await runLease.launch(() => adapter.resume({
        ...spec,
        providerConversationId: relaunch.providerConversationId,
        input: providerDisconnectResumeInput(),
      }, sink));
      if (!resumedHandle) break;
      providerResumeAttempts = relaunch.attempt;
      handle = resumedHandle;
      evidence = await resumedHandle.exit;
      producedOutput = outputTail(evidence);
    }
    // The dead child is classified once here, from the evidence the Run ends
    // on. Every question the rest of this function asks about how the agent
    // process ended is one case of this verdict.
    const exitVerdict = agentExitVerdict(evidence);
    let mechanicalHandoffPersisted = false;
    if (runLease.held) {
      try {
        const handoff = await readMechanicalOutputHandoff(config, claim, workspace);
        if (handoff) {
          const product = detectDurableTerminalProduct({
            mechanicalHandoff: handoff,
            outputEvidence: null,
            capturedHeadSha: undefined,
          });
          if (product.case === "mechanical-handoff") {
            await persistMechanicalOutputHandoff(session, product.handoff, sink);
            mechanicalHandoffPersisted = true;
            sink({
              source: "RUNNER",
              type: "REGRESSION_OUTPUT_HANDOFF_PERSISTED",
              payload: { kind: product.handoff.kind, commitSha: product.handoff.commitSha },
            });
          } else if ("reason" in handoff) {
            regressionHandoffBlock = handoff;
          }
        }
      } catch (error: unknown) {
        terminalFailureReason = `Mechanical output handoff failed for Run ${claim.run.id}: ${errorMessage(error)}`;
        sink({
          source: "RUNNER",
          type: "REGRESSION_OUTPUT_HANDOFF_FAILED",
          payload: { message: errorMessage(error) },
        });
      }
    }
    if (exitVerdict.case === "succeeded"
      && claim.task.templateStep?.outputKind
      && runLease.held
      && terminalFailureReason === null) {
      const declaredOutputKind = claim.task.templateStep.outputKind;
      let outputEvidence: RunOutputEvidence | null = null;
      let statusFailure: string | null = null;
      try {
        outputEvidence = await session.outputStatus();
      } catch (error: unknown) {
        statusFailure = errorMessage(error);
      }
      if (outputEvidence === null) {
        statusFailure ??= "Anneal API returned no task output status";
      }
      if (statusFailure !== null) {
        sink({
          source: "RUNNER",
          type: "TASK_OUTPUT_REMEDIATION_CHECK_FAILED",
          payload: { message: statusFailure },
        });
        taskOutputStatusCheckFailed = true;
        terminalFailureReason = `Task output status could not be established for a step declaring output kind '${declaredOutputKind}' for Run ${claim.run.id}: ${statusFailure}`;
      }
      const satisfaction = outputEvidence?.satisfaction;
      if (satisfaction?.case === "satisfied-by-prior-run") {
        sink({
          source: "RUNNER",
          type: "TASK_OUTPUT_REMEDIATION_SKIPPED",
          payload: { outputKind: satisfaction.outputKind, reason: "immutable-output-satisfied-by-prior-run" },
        });
      } else if (satisfaction?.case === "absent") {
        const { outputKind } = satisfaction;
        const providerConversationId = rememberProviderConversationId();
        // Only a remediable kind reaches the relaunch question at all: the
        // mechanical verdict below is not a repair this gate could authorize.
        const relaunch = satisfaction.remediable
          ? await decideProviderRelaunch({
            purpose: "remediate-missing-output",
            providerConversationId,
            authorityHeld: () => runLease.held,
            budgetRefused: () => budget.refusal !== null,
          })
          : null;
        if (relaunch === null) {
          // Only a mechanical verdict is undeliverable by asking again, and
          // the control plane says so; the runner does not re-test the kind.
          terminalFailureReason = regressionHandoffBlock
            ? `A step declaring output kind '${outputKind}' finished without a current-Run mechanical output handoff for Run ${claim.run.id}; block reason: ${regressionHandoffBlock.reason}; git stderr: ${regressionHandoffBlock.stderr}`
            : `A step declaring output kind '${outputKind}' finished without a current-Run mechanical output handoff for Run ${claim.run.id}`;
          sink({
            source: "RUNNER",
            type: "TASK_OUTPUT_REMEDIATION_UNAVAILABLE",
            payload: {
              outputKind,
              outputRemediationAllowed: false,
              providerConversationIdAvailable: providerConversationId !== null,
              ...(regressionHandoffBlock
                ? { reason: regressionHandoffBlock.reason, stderr: regressionHandoffBlock.stderr }
                : { reason: mechanicalHandoffPersisted ? "mechanical-output-not-visible" : "mechanical-handoff-absent" }),
            },
          });
        } else if (relaunch.allowed) {
          const beforeRemediation = await captureWorkspaceSnapshot(config, workspace);
          // Snapshotting is asynchronous. Cancellation may have been ACKed
          // against the already-closed first launch while it ran, so no second
          // provider launch may be opened without this fresh fence check.
          if (runLease.held) {
            sink({
              source: "RUNNER",
              type: "TASK_OUTPUT_REMEDIATION_STARTED",
              payload: { outputKind, workspace: workspaceSnapshotEvidence(beforeRemediation) },
            });
            const remediationHandle = await runLease.launch(() => adapter.resume({
              ...spec,
              providerConversationId: relaunch.providerConversationId,
              input: missingOutputRemediationInput(outputKind),
            }, sink));
            if (remediationHandle) {
              handle = remediationHandle;
              const remediationEvidence = await remediationHandle.exit;
              const afterRemediation = await captureWorkspaceSnapshot(config, workspace);
              const workspaceChanged = !sameWorkspaceSnapshot(beforeRemediation, afterRemediation);
              let remediated = false;
              let statusCheckError: string | null = null;
              if (!workspaceChanged) {
                try {
                  const recheck = (await session.outputStatus())?.satisfaction.case;
                  remediated = recheck === "delivered" || recheck === "satisfied-by-prior-run";
                } catch (error: unknown) {
                  statusCheckError = errorMessage(error);
                  sink({
                    source: "RUNNER",
                    type: "TASK_OUTPUT_REMEDIATION_CHECK_FAILED",
                    payload: { message: statusCheckError },
                  });
                }
              }
              if (workspaceChanged) {
                workspacePublicationForbidden = true;
                terminalFailureReason = `Task output remediation changed workspace HEAD or tree for Run ${claim.run.id}`;
              } else if (!remediated) {
                terminalFailureReason = statusCheckError
                  ? `Task output remediation status check failed for Run ${claim.run.id}: ${statusCheckError}`
                  : `Task output remediation finished without persisting ${outputKind} output for Run ${claim.run.id}`;
              }
              sink({
                source: "RUNNER",
                type: "TASK_OUTPUT_REMEDIATION_FINISHED",
                payload: {
                  outputKind,
                  outputPersisted: remediated,
                  terminalSuccess: agentExitVerdict(remediationEvidence).case === "succeeded",
                  evidence: exitEvidencePayload(remediationEvidence),
                  workspaceChanged,
                  ...(workspaceChanged ? {
                    workspaceBefore: workspaceSnapshotEvidence(beforeRemediation),
                    workspaceAfter: workspaceSnapshotEvidence(afterRemediation),
                  } : {}),
                  ...(statusCheckError ? { statusCheckError } : {}),
                },
              });
            }
          }
        } else {
          terminalFailureReason = `Task output remediation unavailable for Run ${claim.run.id}: ${
            providerRelaunchRefusalSummary(relaunch.reason)
          }`;
          sink({
            source: "RUNNER",
            type: "TASK_OUTPUT_REMEDIATION_UNAVAILABLE",
            payload: {
              outputKind,
              outputRemediationAllowed: true,
              providerConversationIdAvailable: providerConversationId !== null,
              reason: relaunch.reason,
            },
          });
        }
      }
    }
    if (!runLease.authority.held && runLease.authority.reason === "cancelled") {
      await runLease.checkpoint();
      return;
    }
    phase = "DELIVER";
    // The same renewal loop remains live while delivery evidence replaces
    // execute evidence. The opening delivery renewal fixes the deadline from
    // the last attempt known to have landed.
    await runLease.enterPhase({ name: "deliver", startedAt: new Date() });
    let gitResult = { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha };
    let capturedHeadSha: string | undefined;
    try {
      gitResult = await captureWorkspaceResult(config, workspace);
      capturedHeadSha = gitResult.headSha;
    } catch (error: unknown) {
      const message = `Unable to snapshot git result: ${errorMessage(error)}`;
      sink({ source: "RUNNER", type: "WORKSPACE_RESULT_SNAPSHOT_FAILED", payload: { message } });
      await session.note(message, { stream: "runner" }).catch((activityError: unknown) => {
        sink({
          source: "RUNNER",
          type: "WORKSPACE_RESULT_SNAPSHOT_REPORT_FAILED",
          payload: { message: errorMessage(activityError) },
        });
      });
    }
    let postDeliveryDisconnectTolerated = false;
    // A clean drop is the exit half; the rest is this Run's own state, which
    // no reading of the exit record can supply.
    const postDeliveryDisconnect = exitVerdict.case === "dropped"
      && exitVerdict.cleanExit
      && terminalFailureReason === null
      && budget.refusal === null
      && runLease.held;
    if (postDeliveryDisconnect) {
      try {
        const outputEvidence = await session.outputStatus();
        const satisfaction = outputEvidence?.satisfaction;
        const expectedKind = "result";
        // The server-returned output identity alone authorizes recovery, and
        // "this Run delivered it" is the control plane's decision, not a
        // predicate to re-run here. What remains is the one fact only this
        // process knows: the commit the workspace actually ends on.
        const product = detectDurableTerminalProduct({ mechanicalHandoff: null, outputEvidence, capturedHeadSha });
        if (product.case === "absent") {
          if (product.reason === "wrong-output-kind" && satisfaction?.case === "delivered") {
            throw new Error(`Persisted output kind ${satisfaction.output.kind} is not ${expectedKind}`);
          }
          if (product.reason === "output-head-mismatch") {
            throw new Error(`Persisted ${expectedKind} output does not match captured workspace HEAD`);
          }
          throw new Error(`No persisted ${expectedKind} output exists for this Run`);
        }
        const { output } = product;
        postDeliveryDisconnectTolerated = true;
        let localReceipt = null;
        let localReceiptReadError: string | null = null;
        try {
          localReceipt = await readTaskOutputReceipt(config, workspace);
          if (!localReceipt) localReceiptReadError = "Local task output receipt is absent";
        } catch (error: unknown) {
          localReceiptReadError = errorMessage(error);
        }
        sink({
          source: "RUNNER",
          type: "POST_DELIVERY_DISCONNECT_ACCEPTED",
          payload: {
            runId: claim.run.id,
            commitSha: output.commitSha,
            providerError: evidence.providerError,
            terminalEventSeen: evidence.terminalEventSeen,
            localReceipt,
            localReceiptReadError,
          },
        });
      } catch (error: unknown) {
        sink({
          source: "RUNNER",
          type: "POST_DELIVERY_DISCONNECT_CHECK_FAILED",
          payload: { message: errorMessage(error), providerError: evidence.providerError },
        });
      }
    }
    let prWorkflowOutputs: readonly PrHandoffOutput[] | undefined;
    const templateStep = claim.task.templateStep;
    const canonicalPrDelivery = templateStep?.taskTemplate.name === PR_TEMPLATE_NAME
      && (templateStep.outputKind === "implementation" || templateStep.outputKind === "fixed-implementation");
    if (canonicalPrDelivery && runLease.held) {
      try {
        const handoff = (await session.outputStatus())?.prHandoff;
        if (handoff?.case !== "complete") {
          throw new Error(handoff?.case === "incomplete"
            ? handoff.reason
            : "session status omitted canonical PR workflow output evidence");
        }
        prWorkflowOutputs = handoff.outputs;
      } catch (error: unknown) {
        if (terminalFailureReason === null) {
          terminalFailureReason = `Canonical PR workflow evidence handoff failed for Run ${claim.run.id}: ${errorMessage(error)}`;
        }
        sink({
          source: "RUNNER",
          type: "PR_WORKFLOW_EVIDENCE_HANDOFF_FAILED",
          payload: { message: errorMessage(error) },
        });
      }
    }
    // Flush the handoff failure (if any) before checking authority or entering
    // delivery. This status read happens after the provider's final events, so
    // placing it after the existing drain would leave the new diagnostic event
    // queued and then lose it when the run completes.
    await drainEventsUnderLease(runLease);
    if (!runLease.held) {
      const authority = await runLease.checkpoint();
      if (!authority.held && (authority.reason === "cancelled" || authority.reason === "waiting-inbox")) return;
      const cleaned = await cleanup(config, claim, workspace, false, false, controlPlane);
      const { salvage: _salvage, ...cleanupOutcome } = cleaned;
      await session.recordCleanup(cleanupOutcome).catch((error: unknown) => {
        console.error(`Unable to record lease-independent cleanup outcome: ${errorMessage(error)}`);
      });
      return;
    }
    const mechanicallySettled = mechanicalHandoffPersisted
      // A validated, fenced Regression handoff is the step's terminal product
      // only when the provider did not explicitly reject the session. Transport
      // loss remains recoverable, but a terminal failure keeps its authority.
      && exitVerdict.case !== "refused"
      && terminalFailureReason === null
      && budget.refusal === null;
    const executionSucceeded = (exitVerdict.case === "succeeded"
      || mechanicallySettled
      || postDeliveryDisconnectTolerated)
      && terminalFailureReason === null
      && budget.refusal === null;
    let delivery: Awaited<ReturnType<typeof deliverWorkspace>> | null = null;
    // Bound outside the closures below: `workspace` is nullable at the top of
    // this function, and the narrowing does not survive into a callback.
    const delivered = { ...workspace, branch: gitResult.branch };
    if (executionSucceeded) {
      // A pinned review started from an object-id-only detached checkout. It
      // produces a platform output, not a branch artifact, so publishing it
      // would either create a forbidden local chain ref or overwrite the chain
      // from an intentionally stale base.
      delivery = workspace.pinnedBaseSha
        ? {
          pushStatus: "SUCCEEDED",
          pushRemote: claim.repo.remoteUrl,
          deliveryInstructions: `Pinned checkout ${workspace.pinnedBaseSha} completed without branch publication.`,
        }
        : await deliverUnderLease(runLease, (retryOptions) => deliverWorkspace(
          config,
          claim,
          delivered,
          {
            ...(capturedHeadSha ? { headSha: capturedHeadSha } : {}),
            ...(prWorkflowOutputs ? { prWorkflowOutputs } : {}),
            recordPublication: (branch) => session.publishBranch(branch),
            retryOptions,
          },
        ));
    }
    const primaryDelivery = delivery;
    const succeeded = executionSucceeded && primaryDelivery?.pushStatus !== "FAILED";
    const worktreeReport = await worktreeContainmentReport();
    const cleaned = await cleanup(
      config,
      claim,
      workspace,
      !succeeded && config.failedWorkspaceRetention > 0,
      // Pinned review/verification checkouts are disposable at every outcome;
      // their stale scratch state must never become chain publication evidence.
      // A failed PR operation can follow a successful, acknowledged push. That
      // branch is already durable even though the run must fail, so salvaging it
      // would publish a second ref and replace the primary delivery evidence.
      succeeded
        || workspacePublicationForbidden
        || Boolean(workspace.pinnedBaseSha)
        || Boolean(primaryDelivery?.pushedBranch),
      controlPlane,
    );
    if (!succeeded && cleaned.salvage) {
      delivery = cleaned.salvage;
      if (cleaned.salvage.headSha) gitResult = { ...gitResult, headSha: cleaned.salvage.headSha };
      await session.note(
        cleaned.salvage.deliveryInstructions ?? cleaned.salvage.pushError ?? "WIP salvage attempted",
        { stream: "runner" }).catch(() => undefined);
    }
    if (succeeded && postDeliveryDisconnectTolerated) {
      const providerError = summarizeEvidence(evidence.providerError) ?? "no providerError reported";
      await session.note(
        `A provider disconnect after delivery was tolerated: ${providerError}`,
        { stream: "runner" },
      ).catch((error: unknown) => {
        sink({
          source: "RUNNER",
          type: "POST_DELIVERY_DISCONNECT_ACTIVITY_FAILED",
          payload: { message: errorMessage(error), providerError },
        });
      });
      await flushEvents().catch(observeEventFlush);
    }
    const sessionDisposal = await sessionConfigLease.settle(succeeded ? "succeeded" : "failed");
    const { salvage: _salvage, ...finishedCleanup } = cleaned;
    // The normal delivery failure remains the failure-envelope evidence even
    // when terminal salvage subsequently succeeds. The wire publication is the
    // salvage result, because it names the ref that actually became durable.
    const { failure: deliveryFailure } = primaryDelivery ?? {};
    const { failure: _deliveryError, ...deliveryPayload } = delivery ?? { pushStatus: "NOT_REQUESTED" as const };
    const retainedPath = sessionDisposal.retainedPath;
    const cleanupFailureReason = [
      finishedCleanup.cleanupFailureReason,
      sessionDisposal.cleanupFailureReason
        ? appendRetainedSessionConfig(`Session CLI config cleanup failed: ${sessionDisposal.cleanupFailureReason}`, retainedPath)
        : null,
    ].filter((reason): reason is string => reason !== undefined && reason !== null).join("; ");
    const completionCleanup = cleanupFailureReason
      ? { ...finishedCleanup, cleanupStatus: "FAILED" as const, cleanupFailureReason }
      : finishedCleanup;
    // Stop renewing before the terminal write: a heartbeat racing a completed
    // run is a guaranteed 409 and pure log noise. The last renewal is at most
    // one heartbeat interval old — half the lease — and the completion call is
    // itself bounded by RUNNER_API_TIMEOUT_MS, so it cannot outlive that.
    await runLease.close();
    // Which of the three acceptances granted this Run its success. The
    // exit evidence below is left exactly as the process reported it: this
    // value is what used to be spelled by overwriting `exitCode`,
    // `terminalEventSeen` and `terminalSuccess` so the control plane's copy of
    // the success predicate would agree with the verdict already reached here.
    const successOutcome: RunOutcome = exitVerdict.case === "succeeded"
      ? { case: "succeeded" }
      : mechanicallySettled
        ? { case: "regression-mechanically-settled" }
        : { case: "delivered-then-disconnected" };
    // A salvage push failure must not mask why the run itself failed.
    const providerFailureReason = appendRetainedSessionConfig(
      (executionSucceeded ? primaryDelivery?.pushError : null) ?? failureReasonFromEvidence(evidence),
      retainedPath,
    );
    const outcome: RunOutcome = succeeded
      ? successOutcome
      : budget.refusal
        ? {
          case: "budget-exhausted",
          gate: budget.refusal.gate,
          reason: appendRetainedSessionConfig(budget.refusal.reason, retainedPath),
        }
        // The control plane could not say whether the required output exists,
        // so re-asking it is not a repair; every other terminal failure here is
        // an absent deliverable the next attempt can still produce.
        : terminalFailureReason
          ? taskOutputStatusCheckFailed
            ? {
              case: "terminal-protocol-failure",
              reason: appendRetainedSessionConfig(terminalFailureReason, retainedPath),
            }
            : {
              case: "required-output-unsatisfied",
              reason: appendRetainedSessionConfig(terminalFailureReason, retainedPath),
            }
          : {
            case: "provider-failure",
            reason: providerFailureReason,
            // `executionSucceeded` decides which side of the agent/plumbing
            // line the run went wrong on. A run whose agent finished and whose
            // push failed is a DELIVER failure, and the API must not charge the
            // task for it.
            envelope: completionEnvelope({
              executionSucceeded,
              evidence,
              deliveryFailure,
              // The runner's own first guess, advisory only: the control plane
              // honours it for BUDGET_EXCEEDED and NO_CHANGES_PRODUCED and
              // classifies everything else from the facts on the envelope.
              runnerClass: primaryDelivery?.failureClass ?? adapter.classifyError(evidence).failureClass,
              terminationReason: evidence.terminationReason,
            }),
          };
    await session.finish({
      outcome,
      exitCode: evidence.exitCode,
      signal: evidence.signal,
      terminationReason: budget.refusal?.reason ?? evidence.terminationReason,
      output: outputTail(evidence),
      ...gitResult,
      ...deliveryPayload,
      ...worktreeReport,
      ...completionCleanup,
    });
    scratch = null;
  } catch (error: unknown) {
    runLease.abandonProviderLaunch();
    await runLease.adoptError(error);
    const authority = await runLease.checkpoint();
    if (!authority.held && (authority.reason === "waiting-inbox" || authority.reason === "cancelled")) return;
    const message = errorMessage(error);
    if (handle && authority.held) {
      await runLease.stopProvider(handle, RUNNER_EXCEPTION_REASON).catch((stopError: unknown) => {
        console.error(`Unable to drain failed Run ${claim.run.id}: ${errorMessage(stopError)}`);
      });
    }
    if (!authority.held && authority.reason === "revoked") {
      if (workspace) {
        const cleaned = await cleanup(config, claim, workspace, false, false, controlPlane);
        const { salvage: _salvage, ...cleanupOutcome } = cleaned;
        await session.recordCleanup(cleanupOutcome).catch((reportError: unknown) => {
          console.error(`Unable to record lease-independent cleanup outcome: ${errorMessage(reportError)}`);
        });
      }
      return;
    }
    const evidence = preflightEvidence(message);
    const classified = classifyDependencyProvisioningFailure(error) ?? adapter.classifyError(evidence);
    const worktreeReport = await worktreeContainmentReport();
    const cleaned = await cleanup(config, claim, workspace, config.failedWorkspaceRetention > 0, false, controlPlane);
    const { salvage, ...finishedCleanup } = cleaned;
    const sessionDisposal = sessionConfigLease && scratch
      ? await sessionConfigLease.settle("failed")
      : { retainedPath: null, cleanupFailureReason: null };
    if (sessionDisposal.cleanupFailureReason === null) scratch = null;
    let failureReason = appendRetainedSessionConfig(message, sessionDisposal.retainedPath);
    if (sessionDisposal.cleanupFailureReason) {
      failureReason = `${failureReason}; scratch cleanup failed: ${sessionDisposal.cleanupFailureReason}`;
    }
    await session.note(message, { stream: "stderr" }).catch(() => undefined);
    await session.finish({
      // The runner's own code threw, so the agent never got to report a
      // verdict: `agentExited: false` on the envelope is what tells the control
      // plane this attempt must not spend the task's budget.
      outcome: {
        case: "provider-failure",
        reason: failureReason,
        envelope: runnerExceptionEnvelope({ phase, evidence, runnerClass: classified.failureClass, error }),
      },
      exitCode: evidence.exitCode,
      signal: null,
      terminationReason: RUNNER_EXCEPTION_REASON,
      // Null until the agent has exited, so a run that never got that far still
      // sends nothing; past that point this is the agent's own output and it
      // survives whatever went wrong afterwards. `evidence` above cannot supply
      // it — it is reconstructed from the error, not from the process.
      output: producedOutput,
      ...(workspace ? { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha } : {}),
      ...(salvage ?? {}),
      ...worktreeReport,
      ...finishedCleanup,
      ...(sessionDisposal.cleanupFailureReason ? {
        cleanupStatus: "FAILED" as const,
        cleanupFailureReason: [finishedCleanup.cleanupFailureReason, sessionDisposal.cleanupFailureReason].filter(Boolean).join("; "),
      } : {}),
    });
  } finally {
    runLease.abandonProviderLaunch();
    await runLease.close();
    // Throwaway by construction, so losing it costs nothing and leaving it
    // behind would leak a directory per run.
    if (scratch) {
      if (sessionConfigLease) {
        const disposal = await sessionConfigLease.settle("failed");
        if (disposal.cleanupFailureReason) {
          console.error(`Agent scratch cleanup failed${disposal.retainedPath ? `; session config retained at ${disposal.retainedPath}` : ""}: ${disposal.cleanupFailureReason}`);
        }
      } else {
        await (dependencies.cleanupAgentScratch ?? cleanupAgentScratch)(config, scratch, {
          retainConfigRoot: RUNNER_DEFINITIONS[claim.runner].isolatesSessionConfig,
        }).catch((cleanupError: unknown) => console.error("Agent scratch cleanup failed", cleanupError));
      }
    }
  }
};

export const pollForTask = async (
  config: RunnerConfig,
  controlPlane: ControlPlane = openControlPlane(config),
): Promise<boolean> => {
  const claim = await controlPlane.claim();
  if (!claim) return false;
  console.log(`Claimed run ${claim.run.id} for task ${claim.task.id} via ${claim.runner.toLowerCase()}`);
  await executeClaim(config, claim, { controlPlane });
  return true;
};

export const STARTUP_REPORT_ATTEMPTS = 5;

export type StartupReportRetryOptions = {
  attempts?: number;
  wait?: (attempt: number) => Promise<void>;
  onRetry?: (runner: RunnerKind, attempt: number, attempts: number) => void;
  onAvailability?: (availability: CliAvailability) => void;
  controlPlane?: ControlPlane;
};

const waitBeforeStartupReportRetry = async (attempt: number): Promise<void> => {
  // 0.5s + 1s + 2s + 4s = 7.5s maximum wait. Together with five API request
  // ceilings this keeps startup below 57.5s with the default 10s API timeout,
  // while covering the ordinary API-after-runner launch ordering race.
  const delayMs = Math.min(4_000, 500 * 2 ** (attempt - 1));
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const reportStartupStateWithRetry = async (
  runner: RunnerKind,
  send: () => Promise<void>,
  options: StartupReportRetryOptions,
): Promise<void> => {
  const attempts = options.attempts ?? STARTUP_REPORT_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("startup report attempts must be a positive integer");
  const wait = options.wait ?? waitBeforeStartupReportRetry;
  const onRetry = options.onRetry ?? ((kind, attempt, total) => {
    console.error(`Anneal API unavailable during ${kind.toLowerCase()} startup preflight; retrying ${attempt + 1}/${total}`);
  });

  for (let attempt = 1; ; attempt += 1) {
    try {
      await send();
      return;
    } catch (error: unknown) {
      if (attempt >= attempts || !retriableStartupError(error)) throw error;
      onRetry(runner, attempt, attempts);
      await wait(attempt);
    }
  }
};

const reportPreflightWithRetry = async (
  config: RunnerConfig,
  runner: RunnerKind,
  result: PreflightReport,
  options: StartupReportRetryOptions,
): Promise<void> => reportStartupStateWithRetry(
  runner, () => (options.controlPlane ?? openControlPlane(config)).reportPreflight(runner, result), options,
);

const reportAvailabilityWithRetry = async (
  config: RunnerConfig,
  availability: CliAvailability,
  options: StartupReportRetryOptions,
): Promise<void> => reportStartupStateWithRetry(
  availability.runner,
  async () => { await (options.controlPlane ?? openControlPlane(config)).reportCliAvailability(availability); },
  options,
);

export const runStartupPreflight = async (
  config: RunnerConfig,
  retryOptions: StartupReportRetryOptions = {},
): Promise<Partial<Record<RunnerKind, boolean>>> => {
  const results: Partial<Record<RunnerKind, boolean>> = {};
  const availability = await probeSupportedCliAvailability(config);
  const onAvailability = retryOptions.onAvailability ?? ((probe: CliAvailability) => {
    if (probe.available) console.log(`${probe.runner.toLowerCase()} runner CLI available: ${probe.resolvedPath}`);
    else console.error(`${probe.runner.toLowerCase()} runner CLI NOT FOUND: ${probe.binary} is not executable in configured RUNNER_PATH`);
  });
  // Resolve and print every served backend before any API report or full
  // preflight can fail. Startup remains alive when one backend is absent, and
  // the operator still gets a complete local inventory in the daemon log.
  const probes = Object.values(availability);
  for (const probe of probes) onAvailability(probe);
  for (const probe of probes) {
    await reportAvailabilityWithRetry(config, probe, retryOptions);
  }
  const env = workspaceEnvironment(config);
  for (const probe of probes) {
    if (!probe.available) {
      results[probe.runner] = false;
      continue;
    }
    const result = await runBackendPreflight(config, probe.runner, env);
    results[probe.runner] = result.ok;
    await reportPreflightWithRetry(config, probe.runner, result, retryOptions);
  }
  return results;
};

/** The daemon prints only the backend verdicts returned by startup preflight.
 * Keeping the formatting next to that result makes the log's inventory follow
 * the same served-kind scope as the reports and probes. */
export const startupPreflightLog = (preflight: Partial<Record<RunnerKind, boolean>>): string =>
  `CLI preflight: ${Object.entries(preflight).map(([runner, ok]) => `${runner.toLowerCase()}=${ok ? "ok" : "blocked"}`).join(" ")}`;

export type AvailabilityHeartbeatOptions = {
  onReportError?: (availability: CliAvailability, error: unknown) => void;
  onPreflightError?: (availability: CliAvailability, error: unknown) => void;
  controlPlane?: ControlPlane;
};

const runBackendPreflight = async (
  config: RunnerConfig,
  runner: RunnerKind,
  env = workspaceEnvironment(config),
) => {
  return adapters[runner].preflight({ config, runner, model: RUNNER_DEFINITIONS[runner].startupPreflightModel, env });
};

/** One cheap daemon heartbeat. Every served backend is attempted independently
 * so a missing CLI or a failed report for one kind cannot starve the others. */
export const reportCliAvailabilityHeartbeat = async (
  config: RunnerConfig,
  options: AvailabilityHeartbeatOptions = {},
): Promise<void> => {
  const controlPlane = options.controlPlane ?? openControlPlane(config);
  const availability = await probeSupportedCliAvailability(config);
  const onReportError = options.onReportError ?? ((probe: CliAvailability, error: unknown) => {
    console.error(`Failed to report ${probe.runner.toLowerCase()} runner CLI availability`, error);
  });
  const onPreflightError = options.onPreflightError ?? ((probe: CliAvailability, error: unknown) => {
    console.error(`Failed to revalidate ${probe.runner.toLowerCase()} runner preflight`, error);
  });
  for (const probe of Object.values(availability)) {
    let revalidatePreflight = false;
    try {
      ({ revalidatePreflight } = await controlPlane.reportCliAvailability(probe));
    } catch (error: unknown) {
      onReportError(probe, error);
      continue;
    }
    if (revalidatePreflight && probe.available) {
      try {
        await controlPlane.reportPreflight(probe.runner, await runBackendPreflight(config, probe.runner));
      } catch (error: unknown) {
        onPreflightError(probe, error);
      }
    }
  }
};

export const startCliAvailabilityMonitor = (
  config: RunnerConfig,
  options: AvailabilityHeartbeatOptions = {},
): { stop: () => void } => {
  let busy = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    void reportCliAvailabilityHeartbeat(config, options).finally(() => { busy = false; });
  };
  const schedule = cliAvailabilityHeartbeatSchedule(config.runnerId);
  const initial = setTimeout(() => {
    tick();
    interval = setInterval(tick, schedule.intervalMs);
  }, schedule.initialDelayMs);
  return { stop: () => {
    clearTimeout(initial);
    if (interval !== null) clearInterval(interval);
  } };
};

const CLI_AVAILABILITY_INTERVAL_MS = 60_000;
const CLI_AVAILABILITY_JITTER_MS = 15_000;

export const cliAvailabilityHeartbeatSchedule = (runnerId: string): {
  initialDelayMs: number;
  intervalMs: number;
} => {
  let hash = 2_166_136_261;
  for (const character of runnerId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return {
    initialDelayMs: CLI_AVAILABILITY_INTERVAL_MS + (hash % CLI_AVAILABILITY_JITTER_MS),
    intervalMs: CLI_AVAILABILITY_INTERVAL_MS,
  };
};
