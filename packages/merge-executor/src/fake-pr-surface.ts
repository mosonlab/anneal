/**
 * The PR-surface fake every executor test drives.
 *
 * It records **every** outbound request — method, URL, body — so the
 * no-publication and no-bypass assertions are made against a call trace rather
 * than against the absence of a code path someone believed was absent.
 */

import type { AuthorizationPayload } from "@anneal/db/merge-integrator";

import type { ChainEnvelope, Deps, IntentRecord } from "./decision-table.js";
import type { DisarmResult, MergeResponse, ReadResult, RepositorySnapshot, TrainGitHub } from "./github.js";

export const AUTHORIZED_HEAD = "a".repeat(40);
export const AUTHORIZED_BASE = "b".repeat(40);
export const MERGE_COMMIT = "c".repeat(40);
export const MERGE_IDENTITY = "agentos-merge-bot";

export const authorization = (overrides: Partial<AuthorizationPayload & { activityId: string; createdAt: string }> = {}) => ({
  schemaVersion: 1,
  nonce: "nonce-1",
  repository: "owner/name",
  prNumber: 123,
  headSha: AUTHORIZED_HEAD,
  baseRef: "master",
  baseSha: AUTHORIZED_BASE,
  mergeMethod: "merge",
  requiredChecks: [{ name: "ci", conclusion: "SUCCESS" }],
  readAt: "2026-08-18T00:00:00.000Z",
  issuedAt: "2026-08-18T00:00:01.000Z",
  decision: { channel: "inbox" as const, inboxDecisionId: "decision-1", inboxMessageId: "card-1" },
  activityId: "authorization-1",
  createdAt: "2026-08-18T00:00:01.000Z",
  ...overrides,
});

export const cleanSnapshot = (overrides: {
  pullRequest?: Partial<RepositorySnapshot["pullRequest"]>;
  repository?: Partial<Omit<RepositorySnapshot, "pullRequest">>;
} = {}): RepositorySnapshot => ({
  repositoryId: "R_repo",
  mergeQueue: null,
  branchProtectionRules: [{
    pattern: "master",
    requiresStatusChecks: true,
    requiresStrictStatusChecks: false,
    requiredStatusCheckContexts: ["ci"],
  }],
  baseRefOid: AUTHORIZED_BASE,
  ...overrides.repository,
  pullRequest: {
    id: "PR_kwDO",
    number: 123,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergedAt: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "master",
    headRefOid: AUTHORIZED_HEAD,
    autoMergeRequest: null,
    mergeQueueEntry: null,
    mergedByLogin: null,
    mergeCommit: null,
    rollupCommitOid: AUTHORIZED_HEAD,
    checks: [{ kind: "CheckRun", name: "ci", conclusion: "SUCCESS", status: "COMPLETED" }],
    ...overrides.pullRequest,
  },
});

export const mergedSnapshot = (overrides: Partial<RepositorySnapshot["pullRequest"]> = {}): RepositorySnapshot =>
  cleanSnapshot({
    repository: { baseRefOid: MERGE_COMMIT },
    pullRequest: {
      state: "MERGED",
      merged: true,
      mergedAt: "2026-08-18T00:05:00.000Z",
      mergedByLogin: MERGE_IDENTITY,
      mergeCommit: { oid: MERGE_COMMIT, parents: [AUTHORIZED_BASE, AUTHORIZED_HEAD] },
      ...overrides,
    },
  });

/** The window in which the ref update has landed but GitHub has not yet
 *  projected it onto the pull request. */
export const refLandedBeforeProjection = (): RepositorySnapshot => mergedSnapshot({
  state: "OPEN", merged: false, mergedAt: null, mergedByLogin: null, mergeCommit: null,
});

export type TraceEntry = { call: string; detail?: Record<string, unknown> };

export type FakeOptions = {
  envelope?: Partial<ChainEnvelope>;
  /** One snapshot per read, in order; the last is reused once exhausted. */
  reads?: ReadResult[];
  merge?: MergeResponse;
  /** One response per merge send, in order; the last is reused once exhausted.
   *  Takes precedence over `merge`, and exists so a test can say what the
   *  *second* send answers — the guarded resend has no other way to be driven. */
  merges?: MergeResponse[];
  intents?: IntentRecord[];
  disableAutoMerge?: DisarmResult;
  dequeue?: DisarmResult;
  /** Envelope returned by the pre-merge supersession re-check, if different. */
  recheckEnvelope?: Partial<ChainEnvelope>;
  /** Envelope returned by the resend guard's supersession re-check, if
   *  different again — the third chain read, taken only when a lost response
   *  has been confirmed absent and a second send is being considered. */
  resendEnvelope?: Partial<ChainEnvelope>;
  startedAt?: Date;
  pollAttempts?: number;
};

export const makeFake = (options: FakeOptions = {}) => {
  const trace: TraceEntry[] = [];
  const reads = options.reads ?? [{ status: "ok", snapshot: cleanSnapshot() }];
  let readIndex = 0;
  let chainReads = 0;
  let mergeSends = 0;
  const baseEnvelope: ChainEnvelope = {
    target: { resolved: true, repository: "owner/name", prNumber: 123, observed: [123], correctionActivityId: null },
    authorization: authorization(),
    nearMatchCount: 0,
    ignoredCount: 0,
    refusal: null,
    ...options.envelope,
  };
  const written: Array<Omit<IntentRecord, "activityId">> = [];

  // The train surface is a required binding, so a missing one is a wiring bug
  // rather than a live-state condition. Every non-train test gets a surface
  // that refuses to answer, which is what an unused binding should do.
  const unusedTrain: TrainGitHub = {
    readDefaultBranch: async () => ({ status: "api-error", reason: "the train surface is not used by this test" }),
    readRef: async () => ({ status: "api-error", reason: "the train surface is not used by this test" }),
    isAncestor: async () => ({ status: "api-error", reason: "the train surface is not used by this test" }),
    readCommit: async () => ({ status: "api-error", reason: "the train surface is not used by this test" }),
    publishTrain: async () => ({ status: "unknown", reason: "the train surface is not used by this test" }),
    deleteTrainRef: async () => ({ ok: false, reason: "the train surface is not used by this test" }),
  };

  const deps: Deps = {
    train: unusedTrain,
    logTrainCleanupFailure: (reason) => { trace.push({ call: "logTrainCleanupFailure", detail: { reason } }); },
    readChain: async () => {
      chainReads += 1;
      trace.push({ call: "readChain", detail: { nth: chainReads } });
      if (chainReads > 2 && options.resendEnvelope) return { ...baseEnvelope, ...options.resendEnvelope };
      if (chainReads > 1 && options.recheckEnvelope) return { ...baseEnvelope, ...options.recheckEnvelope };
      return baseEnvelope;
    },
    readOwnIntents: async () => {
      trace.push({ call: "readOwnIntents" });
      return [...(options.intents ?? []), ...written.map((intent, index) => ({ activityId: `intent-${index}`, ...intent }))];
    },
    readPullRequest: async (reference) => {
      trace.push({ call: "readPullRequest", detail: { ...reference } });
      const result = reads[Math.min(readIndex, reads.length - 1)]!;
      readIndex += 1;
      return result;
    },
    merge: async (reference, expectedHeadSha, expectedBase) => {
      mergeSends += 1;
      trace.push({ call: "merge", detail: { ...reference, expectedHeadSha, expectedBase, nth: mergeSends } });
      const sequence = options.merges;
      if (sequence && sequence.length > 0) return sequence[Math.min(mergeSends - 1, sequence.length - 1)]!;
      return options.merge ?? { status: "merged", sha: MERGE_COMMIT };
    },
    disableAutoMerge: async (pullRequestId) => {
      trace.push({ call: "disableAutoMerge", detail: { pullRequestId } });
      return options.disableAutoMerge ?? { ok: true };
    },
    dequeuePullRequest: async (entryId) => {
      trace.push({ call: "dequeuePullRequest", detail: { entryId } });
      return options.dequeue ?? { ok: true };
    },
    writeIntent: async (intent) => {
      trace.push({ call: "writeIntent", detail: { ...intent } });
      written.push(intent);
    },
    sleep: async () => { trace.push({ call: "sleep" }); },
    now: () => new Date("2026-08-18T00:10:00.000Z"),
    startedAt: options.startedAt ?? new Date("2026-08-18T00:09:00.000Z"),
    mergeIdentityLogin: MERGE_IDENTITY,
    pollAttempts: options.pollAttempts ?? 2,
    pollIntervalMs: 1,
    pollBudgetMs: 60_000,
  };

  return { deps, trace, calls: (): string[] => trace.map((entry) => entry.call) };
};
