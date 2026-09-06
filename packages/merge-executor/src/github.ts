/**
 * §11 — the normative platform binding.
 *
 * The executor speaks GitHub's GraphQL API for reads and disarms and its REST
 * API for the merge. `gh` is used by no code path here: a CLI would put the
 * credential in a child environment and an argv (§D-P1 rule 2), and `gh` 2.89.0
 * has no queue-removal command at all, so it cannot express §11.4's disarm
 * obligation.
 *
 * Undefined is never a pass. Every `null` where a value is required, every
 * omitted field, and every GraphQL `errors` entry is classified as a stop by the
 * caller — this module's job is to report exactly what came back, never to
 * paper over it.
 *
 * The transport and the did-it-land classification are `@anneal/github-client`'s
 * (#139), so this process and the runner answer "was the response lost?" the
 * same way. That package holds no credential, opens no socket of its own and
 * spawns nothing — asserted by its own suite and by `isolation.test.ts` here —
 * so importing it does not widen §D-P1's custody surface.
 */

import { callWithTimeout, classifyHttpStatus, NO_RESPONSE, type Http, type HttpAttempt, type HttpTrace, type ResponseClass } from "@anneal/github-client";

/** Every mutating request this package can construct. Enumerated so the
 *  no-bypass test can assert the complete list and a new write cannot be added
 *  without explicitly extending the custody audit. */
export const MUTATING_OPERATIONS = [
  "createSanitizedTree",
  "createMergeCommit",
  "updateBaseRef",
  "disablePullRequestAutoMerge",
  "dequeuePullRequest",
] as const;
export type CheckEntry =
  | { kind: "CheckRun"; name: string; conclusion: string | null; status: string | null }
  | { kind: "StatusContext"; context: string; state: string | null };

export type BranchProtectionRule = {
  pattern: string;
  requiresStatusChecks: boolean;
  requiresStrictStatusChecks: boolean;
  requiredStatusCheckContexts: string[];
};

export type PullRequestSnapshot = {
  id: string;
  number: number;
  state: string;
  isDraft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  baseRefName: string;
  headRefOid: string;
  autoMergeRequest: { enabledAt: string | null; mergeMethod: string | null } | null;
  mergeQueueEntry: { id: string; state: string | null; position: number | null } | null;
  mergedByLogin: string | null;
  mergeCommit: { oid: string; parents: string[] } | null;
  /** The rollup for the PR's own last commit, with that commit's oid, so a
   *  check can never be credited to a head other than the one it ran for. */
  rollupCommitOid: string | null;
  checks: CheckEntry[];
};

export type RepositorySnapshot = {
  repositoryId: string;
  mergeQueue: { id: string } | null;
  branchProtectionRules: BranchProtectionRule[];
  baseRefOid: string | null;
  pullRequest: PullRequestSnapshot;
};

export type ReadResult =
  | { status: "ok"; snapshot: RepositorySnapshot }
  /** A permission error is NEVER read as "no queue" or "no auto-merge". */
  | { status: "api-error"; reason: string }
  /** A synchronous-execution field was absent or unreadable (§11.2's last row). */
  | { status: "sync-unknown"; reason: string };

export type MergeResponse =
  | { status: "merged"; sha: string }
  | { status: "head-moved" }
  | { status: "not-mergeable" }
  | { status: "forbidden"; reason: string }
  | { status: "not-found"; reason: string }
  | { status: "unprocessable"; reason: string }
  | { status: "ref-update-refused"; reason: string }
  /**
   * The ref update's response never arrived, or arrived unreadable. The update
   * is a compare-and-swap that may or may not have been applied on the far
   * side, so the commit we built travels with the outcome: reading the target
   * ref back and comparing it to `mergeCommitSha` is the only thing that
   * settles which happened. A lost response recorded as a refusal is how an
   * already-landed merge gets re-classified as base drift on the next read.
   */
  | { status: "ref-update-uncertain"; reason: string; mergeCommitSha: string }
  | { status: "unknown"; reason: string };

export type DisarmResult = { ok: true } | { ok: false; reason: string };

/**
 * A failed GraphQL call, carrying the one distinction a *mutation*'s caller
 * cannot do without: `lost` means no answer arrived or the answer could not be
 * read, so the mutation may still have been applied and only a read-back
 * settles it. A GitHub refusal — a 4xx, or an `errors` entry — is an answer,
 * and asking again gets the same one.
 */
type GraphQlFailure = { error: string; lost: boolean };

/**
 * A REST call that produced no usable object, with the class
 * `classifyHttpStatus` computed for it. The class is carried rather than
 * recomputed by the caller because a 2xx whose body is unreadable is `lost`
 * even though its status says `applied`.
 */
type RestFailure = { ok: false; responseClass: ResponseClass; status: number; reason: string };

/**
 * A REST failure, as a merge outcome.
 *
 * A deterministic GitHub rejection keeps its class: nothing about repeating a
 * 403, a 404 or a 422 changes the answer, so degrading it to `unknown` would
 * buy a read-back and a resend for a request the platform has already refused.
 * Only a genuinely lost response — no answer, a 5xx, a body we cannot read —
 * leaves the write's fate open.
 */
const restStop = (stage: string, failure: RestFailure): MergeResponse => {
  const reason = `${stage}: ${failure.reason}`;
  if (failure.responseClass !== "refused") return { status: "unknown", reason };
  if (failure.status === 401 || failure.status === 403) return { status: "forbidden", reason };
  if (failure.status === 404) return { status: "not-found", reason };
  return { status: "unprocessable", reason };
};

export const READ_QUERY = `query($owner:String!,$name:String!,$number:Int!,$base:String!) {
  repository(owner:$owner,name:$name) {
    id
    mergeQueue(branch:$base) { id }
    branchProtectionRules(first:100) { nodes {
      pattern requiresStatusChecks requiresStrictStatusChecks
      requiredStatusCheckContexts } }
    ref(qualifiedName:$base) { target { oid } }
    pullRequest(number:$number) {
      id number state isDraft merged mergedAt
      mergeable mergeStateStatus
      baseRefName headRefOid
      autoMergeRequest { enabledAt mergeMethod }
      mergeQueueEntry { id state position }
      mergedBy { login }
      mergeCommit { oid parents(first:5) { nodes { oid } } }
      commits(last:1) { nodes { commit { oid statusCheckRollup {
        state contexts(first:100) { nodes {
          __typename
          ... on CheckRun { name conclusion status }
          ... on StatusContext { context state } } } } } } }
    }
  }
}`;

export const DISABLE_AUTO_MERGE_MUTATION =
  `mutation($pullRequestId:ID!) { disablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId}) { pullRequest { id } } }`;

export const DEQUEUE_MUTATION =
  `mutation($id:ID!) { dequeuePullRequest(input:{id:$id}) { mergeQueueEntry { id } } }`;

export const UPDATE_REFS_MUTATION =
  `mutation($repositoryId:ID!,$refUpdates:[RefUpdate!]!) { updateRefs(input:{repositoryId:$repositoryId,refUpdates:$refUpdates}) { clientMutationId } }`;

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;

const asString = (value: unknown): string | null => typeof value === "string" ? value : null;

/** Re-exported so this module stays the executor's single platform seam even
 *  though the transport itself is now shared. */
export type { Http, HttpResponse } from "@anneal/github-client";

export type GitHubClientOptions = {
  restUrl: string;
  graphqlUrl: string;
  token: string;
  timeoutMs: number;
  http: Http;
  /** Recorded for the no-publication assertion; the caller owns the array. */
  trace?: HttpTrace;
};

export type PullRequestRef = { owner: string; name: string; number: number; baseRef: string };

export const splitRepository = (repository: string): { owner: string; name: string } | null => {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) return null;
  return { owner, name };
};

/**
 * A GraphQL `errors` entry is never merged into the data path: a FORBIDDEN or
 * INSUFFICIENT_SCOPES response looks exactly like "there is no merge queue" if
 * you only read `data`, and that is the difference between a stop and an
 * unauthorized merge into a queue-governed branch.
 */
const classifyGraphQlErrors = (errors: unknown): string | null => {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((entry) => {
    const record = asRecord(entry);
    const type = asString(record?.type) ?? "UNKNOWN";
    const message = asString(record?.message) ?? "";
    return `${type}: ${message}`;
  }).join("; ");
};

export const makeGitHubClient = (options: GitHubClientOptions) => {
  const headers = (accept: string): Record<string, string> => ({
    Authorization: `Bearer ${options.token}`,
    Accept: accept,
    "User-Agent": "agentos-merge-executor",
    "Content-Type": "application/json",
  });

  const call = async (
    request: { url: string; method: "GET" | "POST"; accept: string; body?: string },
  ): Promise<HttpAttempt> => callWithTimeout(options.http, {
    url: request.url,
    method: request.method,
    headers: headers(request.accept),
    ...(request.body === undefined ? {} : { body: request.body }),
  }, options.timeoutMs, options.trace);

  const graphql = async (query: string, variables: Json): Promise<{ data: Json } | GraphQlFailure> => {
    const response = await call({
      url: options.graphqlUrl,
      method: "POST",
      accept: "application/json",
      body: JSON.stringify({ query, variables }),
    });
    const responseClass = classifyHttpStatus(response.status);
    if (responseClass !== "applied") {
      return {
        error: response.status === NO_RESPONSE ? `network: ${response.body}` : `HTTP ${response.status}`,
        lost: responseClass === "lost",
      };
    }
    // A 2xx whose body cannot be read says nothing about what the platform did
    // with the request, so it is lost, not refused.
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { error: "response body is not valid JSON", lost: true };
    }
    const record = asRecord(parsed);
    if (!record) return { error: "response body is not an object", lost: true };
    const errors = classifyGraphQlErrors(record.errors);
    if (errors) return { error: errors, lost: false };
    const data = asRecord(record.data);
    if (!data) return { error: "response carried no data", lost: true };
    return { data };
  };

  const readPullRequest = async (reference: PullRequestRef): Promise<ReadResult> => {
    const result = await graphql(READ_QUERY, {
      owner: reference.owner,
      name: reference.name,
      number: reference.number,
      base: reference.baseRef,
    });
    if ("error" in result) return { status: "api-error", reason: result.error };
    const repository = asRecord(result.data.repository);
    if (!repository) return { status: "api-error", reason: "repository resolved to null" };
    const pullRequest = asRecord(repository.pullRequest);
    if (!pullRequest) return { status: "api-error", reason: "pullRequest resolved to null" };

    // Every bound field is validated for presence *and* shape, and a failure of
    // either is a refusal rather than a default.
    //
    // The review of PR #130 demonstrated the alternative empirically: with
    // `branchProtectionRules: null`, the three synchronous-execution fields set
    // to malformed non-empty strings and `isDraft` omitted, the old parser
    // returned `status: "ok"` with every one of those collapsed to a safe value
    // — no rules, no queue, no auto-merge, not a draft — and `classifyPreMerge`
    // then returned `{kind:"ok"}`. A response we cannot read is not evidence
    // that the guarded conditions are absent; it is evidence of nothing.
    //
    // Absence and malformation are also kept distinct from `null`: `undefined`
    // means the field never came back, `null` means the platform positively
    // reported "none", and a wrong type means the response cannot be trusted at
    // all. Fields §11.3 binds synchronous execution to degrade to
    // `sync-unknown`; everything else to `api-error`.
    // Prefixes, so a fault on a leaf of one of the three (`mergeQueueEntry.id`,
    // `autoMergeRequest.mergeMethod`) degrades the same way its parent does.
    const SYNC_FIELDS = [
      "repository.mergeQueue", "pullRequest.mergeQueueEntry", "pullRequest.autoMergeRequest",
      "mergeQueueEntry", "autoMergeRequest",
    ];
    const faults: string[] = [];
    const present = (holder: Json, path: string, keys: string[]): void => {
      for (const key of keys) if (!(key in holder)) faults.push(`${path}.${key} was omitted from the response`);
    };
    present(repository, "repository", ["id", "mergeQueue", "branchProtectionRules", "ref"]);
    present(pullRequest, "pullRequest", [
      "id", "number", "state", "isDraft", "merged", "mergedAt", "mergeable", "mergeStateStatus",
      "baseRefName", "headRefOid", "autoMergeRequest", "mergeQueueEntry", "mergedBy", "mergeCommit", "commits",
    ]);
    const refuse = (): ReadResult => {
      const sync = faults.filter((fault) => {
        const path = fault.split(" ")[0] ?? "";
        return SYNC_FIELDS.some((field) => path === field || path.startsWith(`${field}.`));
      });
      return sync.length > 0
        ? { status: "sync-unknown", reason: sync.join("; ") }
        : { status: "api-error", reason: faults.join("; ") };
    };
    if (faults.length > 0) return refuse();

    /** Records the fault and returns the fallback, so one pass collects them all. */
    const bad = <T>(path: string, fallback: T): T => {
      faults.push(`${path} is malformed`);
      return fallback;
    };
    const strictString = (value: unknown, path: string): string =>
      typeof value === "string" ? value : bad(path, "");
    const strictNullableString = (value: unknown, path: string): string | null =>
      value === null || typeof value === "string" ? (value as string | null) : bad(path, null);
    const strictBoolean = (value: unknown, path: string): boolean =>
      typeof value === "boolean" ? value : bad(path, false);
    const strictNullableRecord = (value: unknown, path: string): Json | null =>
      value === null ? null : (asRecord(value) ?? bad(path, null));
    /**
     * A connection whose parent object exists is itself non-null in the GitHub
     * schema, so `null` here is not "there are none" — it is a response we
     * cannot read. `branchProtectionRules: null` reading as "this branch is
     * unprotected" is precisely the fail-open the review reproduced.
     */
    const strictNodes = (value: unknown, path: string): unknown[] => {
      const holder = asRecord(value);
      if (!holder) return bad(path, []);
      if (!("nodes" in holder)) return bad(`${path}.nodes`, []);
      return Array.isArray(holder.nodes) ? holder.nodes : bad(`${path}.nodes`, []);
    };

    const id = strictString(pullRequest.id, "pullRequest.id");
    const headRefOid = strictString(pullRequest.headRefOid, "pullRequest.headRefOid");
    const baseRefName = strictString(pullRequest.baseRefName, "pullRequest.baseRefName");
    const state = strictString(pullRequest.state, "pullRequest.state");
    const number = typeof pullRequest.number === "number" && Number.isInteger(pullRequest.number)
      ? pullRequest.number
      : bad("pullRequest.number", 0);
    const isDraft = strictBoolean(pullRequest.isDraft, "pullRequest.isDraft");
    const merged = strictBoolean(pullRequest.merged, "pullRequest.merged");

    const rules: BranchProtectionRule[] = [];
    for (const entry of strictNodes(repository.branchProtectionRules, "repository.branchProtectionRules")) {
      const rule = asRecord(entry);
      if (!rule) { bad("repository.branchProtectionRules.nodes[]", null); continue; }
      // A rule we cannot read is a rule we must assume applies, so its shape is
      // strict too: silently dropping it is exactly the fail-open the review hit.
      for (const key of ["pattern", "requiresStatusChecks", "requiresStrictStatusChecks", "requiredStatusCheckContexts"]) {
        if (!(key in rule)) faults.push(`repository.branchProtectionRules.nodes[].${key} was omitted from the response`);
      }
      const contexts = rule.requiredStatusCheckContexts;
      rules.push({
        pattern: strictString(rule.pattern, "branchProtectionRule.pattern"),
        requiresStatusChecks: strictBoolean(rule.requiresStatusChecks, "branchProtectionRule.requiresStatusChecks"),
        requiresStrictStatusChecks: strictBoolean(rule.requiresStrictStatusChecks, "branchProtectionRule.requiresStrictStatusChecks"),
        requiredStatusCheckContexts: contexts === null
          ? []
          : Array.isArray(contexts) && contexts.every((context) => typeof context === "string")
            ? contexts as string[]
            : bad("branchProtectionRule.requiredStatusCheckContexts", []),
      });
    }

    const mergeCommitRecord = strictNullableRecord(pullRequest.mergeCommit, "pullRequest.mergeCommit");
    const mergeCommit = mergeCommitRecord
      ? {
        oid: strictString(mergeCommitRecord.oid, "pullRequest.mergeCommit.oid"),
        parents: strictNodes(mergeCommitRecord.parents, "pullRequest.mergeCommit.parents")
          .map((node) => strictString(asRecord(node)?.oid, "pullRequest.mergeCommit.parents.nodes[].oid")),
      }
      : null;

    const commitNodes = strictNodes(pullRequest.commits, "pullRequest.commits");
    const lastEdge = commitNodes.length > 0 ? asRecord(commitNodes.at(-1)) : null;
    const lastCommit = commitNodes.length === 0
      ? null
      : strictNullableRecord(lastEdge?.commit, "pullRequest.commits.nodes[].commit");
    const rollup = lastCommit ? strictNullableRecord(lastCommit.statusCheckRollup, "commit.statusCheckRollup") : null;
    const checks: CheckEntry[] = [];
    for (const entry of rollup ? strictNodes(rollup.contexts, "statusCheckRollup.contexts") : []) {
      const node = asRecord(entry);
      if (!node) { bad("statusCheckRollup.contexts.nodes[]", null); continue; }
      // An unrecognised __typename is not a check that passed — it is a check
      // whose state we cannot read, and dropping it would credit the PR with a
      // green rollup it has not earned.
      if (node.__typename === "CheckRun") {
        checks.push({
          kind: "CheckRun",
          name: strictString(node.name, "CheckRun.name"),
          conclusion: strictNullableString(node.conclusion, "CheckRun.conclusion"),
          status: strictNullableString(node.status, "CheckRun.status"),
        });
      } else if (node.__typename === "StatusContext") {
        checks.push({
          kind: "StatusContext",
          context: strictString(node.context, "StatusContext.context"),
          state: strictNullableString(node.state, "StatusContext.state"),
        });
      } else {
        bad(`statusCheckRollup.contexts.nodes[].__typename=${JSON.stringify(node.__typename)}`, null);
      }
    }

    const queueEntry = strictNullableRecord(pullRequest.mergeQueueEntry, "pullRequest.mergeQueueEntry");
    const autoMerge = strictNullableRecord(pullRequest.autoMergeRequest, "pullRequest.autoMergeRequest");
    const mergeQueue = strictNullableRecord(repository.mergeQueue, "repository.mergeQueue");
    const baseRef = strictNullableRecord(repository.ref, "repository.ref");
    const baseTarget = baseRef ? strictNullableRecord(baseRef.target, "repository.ref.target") : null;

    const mergedBy = strictNullableRecord(pullRequest.mergedBy, "pullRequest.mergedBy");
    const snapshot: RepositorySnapshot = {
      repositoryId: strictString(repository.id, "repository.id"),
      mergeQueue: mergeQueue ? { id: strictString(mergeQueue.id, "repository.mergeQueue.id") } : null,
      branchProtectionRules: rules,
      baseRefOid: baseTarget ? strictNullableString(baseTarget.oid, "repository.ref.target.oid") : null,
      pullRequest: {
        id,
        number,
        state,
        isDraft,
        merged,
        mergedAt: strictNullableString(pullRequest.mergedAt, "pullRequest.mergedAt"),
        mergeable: strictNullableString(pullRequest.mergeable, "pullRequest.mergeable"),
        mergeStateStatus: strictNullableString(pullRequest.mergeStateStatus, "pullRequest.mergeStateStatus"),
        baseRefName,
        headRefOid,
        autoMergeRequest: autoMerge
          ? {
            enabledAt: strictNullableString(autoMerge.enabledAt, "autoMergeRequest.enabledAt"),
            mergeMethod: strictNullableString(autoMerge.mergeMethod, "autoMergeRequest.mergeMethod"),
          }
          : null,
        mergeQueueEntry: queueEntry
          ? {
            id: strictString(queueEntry.id, "mergeQueueEntry.id"),
            state: strictNullableString(queueEntry.state, "mergeQueueEntry.state"),
            position: queueEntry.position === null || typeof queueEntry.position === "number"
              ? (queueEntry.position as number | null)
              : bad("mergeQueueEntry.position", null),
          }
          : null,
        mergedByLogin: mergedBy ? strictNullableString(mergedBy.login, "pullRequest.mergedBy.login") : null,
        mergeCommit,
        rollupCommitOid: lastCommit ? strictNullableString(lastCommit.oid, "commit.oid") : null,
        checks,
      },
    };
    // The fault check is last, after every bound field has been parsed, so a
    // single malformed leaf anywhere refuses the whole read rather than being
    // decided by the order the fields happen to be visited in.
    if (faults.length > 0) return refuse();
    return { status: "ok", snapshot };
  };

  const restJson = async (
    request: { url: string; method: "GET" | "POST"; body?: unknown },
  ): Promise<{ ok: true; value: Json } | RestFailure> => {
    const response = await call({
      url: request.url,
      method: request.method,
      accept: "application/vnd.github+json",
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    const responseClass = classifyHttpStatus(response.status);
    const reason = response.status === NO_RESPONSE
      ? `network: ${response.body}`
      : `HTTP ${response.status} ${response.body}`;
    if (responseClass !== "applied") return { ok: false, responseClass, status: response.status, reason };
    // A 2xx we cannot read is not an answer either way, so it keeps the lost
    // class however deterministic the status looked.
    try {
      const value = asRecord(JSON.parse(response.body));
      return value
        ? { ok: true, value }
        : { ok: false, responseClass: "lost", status: response.status, reason: "response body is not an object" };
    } catch {
      return { ok: false, responseClass: "lost", status: response.status, reason: "response body is not valid JSON" };
    }
  };

  /**
   * Creates the merge commit directly so its tree can omit `.chain/` while the
   * pull-request branch remains unchanged. Regression has already refreshed
   * the head onto the exact base, so the head tree contains both sides. The
   * final non-force ref update is the CAS: base drift is refused rather than
   * overwritten.
   */
  const mergePullRequest = async (
    reference: Pick<PullRequestRef, "owner" | "name" | "number">,
    expectedHeadSha: string,
    expectedBase: { ref: string; sha: string; repositoryId: string },
  ): Promise<MergeResponse> => {
    const repo = `${options.restUrl}/repos/${reference.owner}/${reference.name}`;
    const commit = await restJson({ url: `${repo}/git/commits/${expectedHeadSha}`, method: "GET" });
    if (!commit.ok) return restStop("head commit read failed", commit);
    const headTree = asString(asRecord(commit.value.tree)?.sha);
    if (!headTree) return { status: "unknown", reason: "head commit has no tree sha" };
    const recursive = await restJson({ url: `${repo}/git/trees/${headTree}?recursive=1`, method: "GET" });
    if (!recursive.ok) return restStop("head tree read failed", recursive);
    if (!Array.isArray(recursive.value.tree) || recursive.value.truncated !== false) {
      return { status: "unknown", reason: "head tree response is malformed or truncated; .chain absence is unproven" };
    }
    const carriesChain = recursive.value.tree.some((entry) => asString(asRecord(entry)?.path)?.split("/")[0] === ".chain");
    let mergeTree = headTree;
    if (carriesChain) {
      const tree = await restJson({
        url: `${repo}/git/trees`,
        method: "POST",
        body: { base_tree: headTree, tree: [{ path: ".chain", mode: "040000", type: "tree", sha: null }] },
      });
      if (!tree.ok) return restStop("sanitized tree creation failed", tree);
      const sanitized = asString(tree.value.sha);
      if (!sanitized) return { status: "unknown", reason: "sanitized tree response has no sha" };
      mergeTree = sanitized;
    }
    const created = await restJson({
      url: `${repo}/git/commits`,
      method: "POST",
      body: {
        message: `Merge pull request #${reference.number}\n\nAnneal autonomous exact-head merge`,
        tree: mergeTree,
        parents: [expectedBase.sha, expectedHeadSha],
      },
    });
    if (!created.ok) return restStop("merge commit creation failed", created);
    const mergeSha = asString(created.value.sha);
    if (!mergeSha) return { status: "unknown", reason: "merge commit response has no sha" };
    const updated = await graphql(UPDATE_REFS_MUTATION, {
      repositoryId: expectedBase.repositoryId,
      refUpdates: [{
        name: `refs/heads/${expectedBase.ref}`,
        beforeOid: expectedBase.sha,
        afterOid: mergeSha,
        force: false,
      }],
    });
    // The ref update IS the merge, so the difference between "GitHub said no"
    // and "GitHub never answered" is the difference between a stop and a merge
    // that is already on the branch. Only the former is a refusal; the latter
    // travels with the commit we built so the caller can settle it by reading
    // the ref back.
    if ("error" in updated) {
      return updated.lost
        ? { status: "ref-update-uncertain", reason: updated.error, mergeCommitSha: mergeSha }
        : { status: "ref-update-refused", reason: updated.error };
    }
    if (!asRecord(updated.data.updateRefs)) {
      return { status: "unknown", reason: "updateRefs response did not prove the atomic ref update" };
    }
    return { status: "merged", sha: mergeSha };
  };

  const disableAutoMerge = async (pullRequestId: string): Promise<DisarmResult> => {
    const result = await graphql(DISABLE_AUTO_MERGE_MUTATION, { pullRequestId });
    return "error" in result ? { ok: false, reason: result.error } : { ok: true };
  };

  const dequeuePullRequest = async (mergeQueueEntryId: string): Promise<DisarmResult> => {
    const result = await graphql(DEQUEUE_MUTATION, { id: mergeQueueEntryId });
    return "error" in result ? { ok: false, reason: result.error } : { ok: true };
  };

  return { readPullRequest, mergePullRequest, disableAutoMerge, dequeuePullRequest, graphql };
};
