/**
 * The read-only half of the §11 platform binding.
 *
 * This client holds `GITHUB_READ_TOKEN`, which is a *different* credential from
 * the merge token and lives in a different process: the API server may read a
 * pull request's state, and may never merge one. The two are never exchanged
 * and neither is ever written to a log, an activity, or an output.
 *
 * The query below is §11.1 verbatim. Field names, enum values and their
 * classification are the normative binding; §D-P6's schema-introspection gate
 * (in the merge-executor package) is what turns a wrong name here into a
 * failing test rather than a wrong merge.
 *
 * There is deliberately no write here, and that is the API's whole share of
 * #139: this process may read a pull request and may never change one. If a
 * GitHub write is ever added to the control plane — a status comment, a label,
 * a review — it goes through `@anneal/github-client`'s `confirmedWrite`, not
 * through a hand-rolled fetch, because the failure this process is most likely
 * to see is the one that looks like an error and was actually a success. The
 * classification of *that* failure is already shared: `isDeterministicRefusal`
 * below is the same predicate the merge executor and the runner answer with.
 */

import { isDeterministicRefusal } from "@anneal/github-client";
import type { ChangedFile } from "@anneal/db";

import { abortableDelay } from "./abortable-delay.js";
import { decodeStrictBase64 } from "./base64.js";

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/** §11.1 — one round trip per verification pass. */
export const PULL_REQUEST_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$base:String!) {
  repository(owner:$owner,name:$name) {
    mergeQueue(branch:$base) { id }
    branchProtectionRules(first:100) { nodes {
      pattern requiresStatusChecks requiresStrictStatusChecks
      requiredStatusCheckContexts } }
    ref(qualifiedName:$base) { target { oid } }
    pullRequest(number:$number) {
      number state isDraft merged mergedAt
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

export type CheckContext =
  | { __typename: "CheckRun"; name: string; conclusion: string | null; status: string | null }
  | { __typename: "StatusContext"; context: string; state: string | null }
  | { __typename: string };

export type PullRequestSnapshot = {
  repository: string;
  number: number;
  state: string | null;
  isDraft: boolean | null;
  merged: boolean | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  baseRefName: string | null;
  headRefOid: string | null;
  baseSha: string | null;
  autoMergeRequest: { enabledAt: string | null; mergeMethod: string | null } | null;
  mergeQueueEntry: { id: string; state: string | null; position: number | null } | null;
  repositoryMergeQueue: { id: string } | null;
  mergedBy: { login: string } | null;
  mergeCommit: { oid: string; parents: string[] } | null;
  requiredCheckNames: string[];
  checkContexts: CheckContext[];
  headCommitOid: string | null;
  readAt: string;
};

export class GitHubReadError extends Error {
  constructor(message: string, readonly kind: "timeout" | "permission" | "transport" | "response") {
    super(message);
    this.name = "GitHubReadError";
  }
}

/** Configuration failure raised before a GitHub reader can be constructed. */
export class GitHubReadConfigurationError extends Error {
  constructor() {
    super("GITHUB_READ_TOKEN is required");
    this.name = "GitHubReadConfigurationError";
  }
}

export type GitHubReader = {
  readPullRequest: (
    repository: string,
    prNumber: number,
    baseRef: string,
    signal: AbortSignal,
  ) => Promise<PullRequestSnapshot>;
  compareCommits?: (
    repository: string,
    baseSha: string,
    headSha: string,
    signal: AbortSignal,
  ) => Promise<{
    status: "ahead" | "behind" | "diverged" | "identical";
    behindBy: number;
    filesComplete: boolean;
    files: ChangedFile[];
  }>;
  /** Read the exact bytes of one repository path at a pinned commit. */
  readFileAtCommit: (
    repository: string,
    path: string,
    commitSha: string,
    signal: AbortSignal,
  ) => Promise<Buffer>;
};

/** Required repository capabilities for resolver fallback ancestry verification. */
export type BranchAncestryReader = {
  readBranchHead: (repository: string, branch: string, signal: AbortSignal) => Promise<string>;
  compareCommits: NonNullable<GitHubReader["compareCommits"]>;
};

/** Read-only capability used by merge evidence workers that never fetch repository files. */
export type PullRequestReader = Pick<GitHubReader, "readPullRequest" | "compareCommits">;

type GitHubReadRetryOptions = {
  wait?: (delayMs: number, signal?: AbortSignal | null) => Promise<void>;
};

const GITHUB_READ_RETRY_DELAYS_MS = [250, 1_000] as const;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const decodeBase64 = (content: string): Buffer => {
  // GitHub wraps Contents API base64 in newlines. Buffer.from is intentionally
  // not used as the validator because it silently ignores invalid characters
  // and truncated input, which could turn a malformed authority file into a
  // different, apparently valid byte sequence.
  const compact = content.replace(/[ \t\r\n]/gu, "");
  if (compact === "") return Buffer.alloc(0);
  const bytes = decodeStrictBase64(compact);
  if (!bytes) {
    throw new GitHubReadError("repository file response has malformed base64 content", "response");
  }
  return bytes;
};

/**
 * The required checks for a base ref are the union of every protection rule
 * whose pattern matches it and which actually requires status checks. Matching
 * is exact or a single trailing `*` — GitHub's full fnmatch surface is wider,
 * and guessing at it would silently *drop* a required check, which is the one
 * direction that must never happen.
 */
export const requiredCheckNamesFor = (
  rules: Array<{ pattern: string; requiresStatusChecks: boolean; requiredStatusCheckContexts: string[] | null }>,
  baseRef: string,
): string[] => {
  const names = new Set<string>();
  for (const rule of rules) {
    if (!rule.requiresStatusChecks) continue;
    const pattern = rule.pattern;
    const matches = pattern === baseRef
      || (pattern.endsWith("*") && baseRef.startsWith(pattern.slice(0, -1)));
    if (!matches) continue;
    for (const context of rule.requiredStatusCheckContexts ?? []) names.add(context);
  }
  return [...names].sort();
};

export const parsePullRequestResponse = (
  repository: string,
  baseRef: string,
  payload: unknown,
  readAt: string,
): PullRequestSnapshot => {
  const root = asObject(payload);
  const errors = asArray(root?.errors);
  if (errors.length > 0) {
    const first = asObject(errors[0]);
    const type = typeof first?.type === "string" ? first.type : "";
    // A permission error is never read as "no queue" or "no auto-merge" (§11.2).
    const kind = type === "FORBIDDEN" || type === "INSUFFICIENT_SCOPES" ? "permission" : "response";
    throw new GitHubReadError(`GitHub GraphQL errors: ${JSON.stringify(errors)}`, kind);
  }
  const repo = asObject(asObject(root?.data)?.repository);
  if (!repo) throw new GitHubReadError("repository resolved to null", "response");
  const pr = asObject(repo.pullRequest);
  if (!pr) throw new GitHubReadError("pullRequest resolved to null", "response");

  const rules = asArray(asObject(repo.branchProtectionRules)?.nodes).flatMap((node) => {
    const rule = asObject(node);
    if (!rule) return [];
    return [{
      pattern: typeof rule.pattern === "string" ? rule.pattern : "",
      requiresStatusChecks: rule.requiresStatusChecks === true,
      requiredStatusCheckContexts: Array.isArray(rule.requiredStatusCheckContexts)
        ? rule.requiredStatusCheckContexts.filter((entry): entry is string => typeof entry === "string")
        : null,
    }];
  });

  const lastCommit = asObject(asObject(asArray(asObject(pr.commits)?.nodes)[0])?.commit);
  const rollup = asObject(lastCommit?.statusCheckRollup);
  const checkContexts = asArray(asObject(rollup?.contexts)?.nodes)
    .flatMap((node) => (asObject(node) ? [asObject(node) as unknown as CheckContext] : []));

  const mergeCommit = asObject(pr.mergeCommit);
  const autoMerge = asObject(pr.autoMergeRequest);
  const queueEntry = asObject(pr.mergeQueueEntry);
  const mergedBy = asObject(pr.mergedBy);

  return {
    repository,
    number: typeof pr.number === "number" ? pr.number : -1,
    state: typeof pr.state === "string" ? pr.state : null,
    isDraft: typeof pr.isDraft === "boolean" ? pr.isDraft : null,
    merged: typeof pr.merged === "boolean" ? pr.merged : null,
    mergeable: typeof pr.mergeable === "string" ? pr.mergeable : null,
    mergeStateStatus: typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus : null,
    baseRefName: typeof pr.baseRefName === "string" ? pr.baseRefName : null,
    headRefOid: typeof pr.headRefOid === "string" ? pr.headRefOid : null,
    baseSha: typeof asObject(asObject(repo.ref)?.target)?.oid === "string"
      ? asObject(asObject(repo.ref)?.target)!.oid as string
      : null,
    autoMergeRequest: autoMerge ? {
      enabledAt: typeof autoMerge.enabledAt === "string" ? autoMerge.enabledAt : null,
      mergeMethod: typeof autoMerge.mergeMethod === "string" ? autoMerge.mergeMethod : null,
    } : null,
    mergeQueueEntry: queueEntry && typeof queueEntry.id === "string" ? {
      id: queueEntry.id,
      state: typeof queueEntry.state === "string" ? queueEntry.state : null,
      position: typeof queueEntry.position === "number" ? queueEntry.position : null,
    } : null,
    repositoryMergeQueue: asObject(repo.mergeQueue) && typeof asObject(repo.mergeQueue)!.id === "string"
      ? { id: asObject(repo.mergeQueue)!.id as string }
      : null,
    mergedBy: mergedBy && typeof mergedBy.login === "string" ? { login: mergedBy.login } : null,
    mergeCommit: mergeCommit && typeof mergeCommit.oid === "string" ? {
      oid: mergeCommit.oid,
      parents: asArray(asObject(mergeCommit.parents)?.nodes)
        .flatMap((node) => {
          const parent = asObject(node);
          return typeof parent?.oid === "string" ? [parent.oid] : [];
        }),
    } : null,
    requiredCheckNames: requiredCheckNamesFor(rules, baseRef),
    checkContexts,
    headCommitOid: typeof lastCommit?.oid === "string" ? lastCommit.oid : null,
    readAt,
  };
};

/** The conclusion this snapshot records for one required check name, or null when absent. */
export const checkConclusionFor = (snapshot: PullRequestSnapshot, name: string): string | null => {
  for (const context of snapshot.checkContexts) {
    if (context.__typename === "CheckRun" && "name" in context && context.name === name) {
      // A check that has not completed is not a pass, and its conclusion is not
      // yet meaningful — the status is what the caller must poll on.
      return context.status === "COMPLETED" ? context.conclusion ?? null : `PENDING:${context.status ?? "UNKNOWN"}`;
    }
    if (context.__typename === "StatusContext" && "context" in context && context.context === name) {
      return context.state ?? null;
    }
  }
  return null;
};

export const createGitHubReader = (
  token: string,
  fetchImpl: typeof fetch = fetch,
  retryOptions: GitHubReadRetryOptions = {},
): GitHubReader & BranchAncestryReader => {
  if (typeof token !== "string" || token.trim() === "") throw new GitHubReadConfigurationError();
  const wait = retryOptions.wait ?? abortableDelay;
  const waitBeforeRetry = async (delayMs: number, signal?: AbortSignal | null): Promise<void> => {
    try {
      await wait(delayMs, signal);
    } catch (error: unknown) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new GitHubReadError("GitHub read aborted at its deadline", "timeout");
      }
      throw error;
    }
  };
  const request = async (
    url: string,
    init: RequestInit,
    options: { missingMessage?: string; retry?: boolean } = {},
  ): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, init);
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new GitHubReadError("GitHub read aborted at its deadline", "timeout");
        }
        const message = error instanceof Error ? error.message : "unknown";
        if (isDeterministicRefusal(error)) throw new GitHubReadError(`GitHub read failed: ${message}`, "permission");
        const delay = options.retry === false ? undefined : GITHUB_READ_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw new GitHubReadError(`GitHub read failed: ${message}`, "transport");
        await waitBeforeRetry(delay, init.signal);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new GitHubReadError(`GitHub read refused with ${response.status}`, "permission");
      }
      if (response.status === 404 && options.missingMessage !== undefined) {
        throw new GitHubReadError(options.missingMessage, "response");
      }
      if (response.ok) return response;
      const delay = options.retry === false ? undefined : GITHUB_READ_RETRY_DELAYS_MS[attempt];
      const transientStatus = response.status === 429 || response.status >= 500;
      if (transientStatus && delay !== undefined) {
        await waitBeforeRetry(delay, init.signal);
        continue;
      }
      throw new GitHubReadError(
        `GitHub read returned ${response.status}`,
        transientStatus ? "transport" : "response",
      );
    }
  };
  return {
    readBranchHead: async (repository, branch, signal) => {
      const [owner, name, ...rest] = repository.split("/");
      if (!owner || !name || rest.length > 0) throw new GitHubReadError(`malformed repository ${repository}`, "response");
      const response = await request(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
        { method: "GET", signal, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
      );
      const object = asObject(asObject(await response.json())?.object);
      if (object?.type !== "commit" || typeof object.sha !== "string" || !/^[0-9a-f]{40}$/u.test(object.sha)) {
        throw new GitHubReadError("branch response has no exact commit head", "response");
      }
      return object.sha;
    },
    readPullRequest: async (repository, prNumber, baseRef, signal) => {
      const [owner, name] = repository.split("/");
      if (!owner || !name) throw new GitHubReadError(`malformed repository ${repository}`, "response");
      const response = await request(GITHUB_GRAPHQL_URL, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ query: PULL_REQUEST_QUERY, variables: { owner, name, number: prNumber, base: baseRef } }),
      });
      return parsePullRequestResponse(repository, baseRef, await response.json(), new Date().toISOString());
    },
    compareCommits: async (repository, baseSha, headSha, signal) => {
      const [owner, name, ...rest] = repository.split("/");
      if (!owner || !name || rest.length > 0) throw new GitHubReadError(`malformed repository ${repository}`, "response");
      const response = await request(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${baseSha}...${headSha}`,
        {
          method: "GET",
          signal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        },
      );
      const payload = asObject(await response.json());
      const status = payload?.status;
      const behindBy = payload?.behind_by;
      if (status !== "ahead" && status !== "behind" && status !== "diverged" && status !== "identical") {
        throw new GitHubReadError("comparison response has an invalid status", "response");
      }
      if (typeof behindBy !== "number" || !Number.isInteger(behindBy) || behindBy < 0) {
        throw new GitHubReadError("comparison response has an invalid behind_by", "response");
      }
      if (!Array.isArray(payload?.files)) throw new GitHubReadError("comparison response has no files array", "response");
      const files = payload.files.map((raw) => {
        const entry = asObject(raw);
        if (!entry || typeof entry.filename !== "string") {
          throw new GitHubReadError("comparison response has a malformed file entry", "response");
        }
        if (entry.status === "renamed" && typeof entry.previous_filename !== "string") {
          throw new GitHubReadError("renamed comparison entry has no previous_filename", "response");
        }
        return {
          filename: entry.filename,
          previousFilename: typeof entry.previous_filename === "string" ? entry.previous_filename : null,
          patch: typeof entry.patch === "string" ? entry.patch : null,
        };
      });
      // GitHub exposes at most 300 changed files and does not expose later file
      // pages. Exactly 300 is therefore ambiguous and must not be read as a
      // complete benign diff.
      return { status, behindBy, filesComplete: files.length < 300, files };
    },
    readFileAtCommit: async (repository, path, commitSha, signal) => {
      const [owner, name, ...rest] = repository.split("/");
      if (!owner || !name || rest.length > 0) {
        throw new GitHubReadError(`malformed repository ${repository}`, "response");
      }
      if (path.length === 0) throw new GitHubReadError("malformed repository file path", "response");
      if (commitSha.length === 0) throw new GitHubReadError("malformed repository commit", "response");

      let encodedPath: string;
      let encodedCommit: string;
      try {
        // Keep path separators as route separators while escaping every path
        // segment, including `?`, `#`, and spaces.
        encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
        encodedCommit = encodeURIComponent(commitSha);
      } catch {
        throw new GitHubReadError("malformed repository file path or commit", "response");
      }

      const response = await request(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}?ref=${encodedCommit}`,
        {
          method: "GET",
          signal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        },
        {
          missingMessage: `repository file is missing at ${repository}@${commitSha}:${path}`,
          // Claim-side specification verification owns the complete retry and
          // deadline policy so its evidence counts actual HTTP attempts.
          retry: false,
        },
      );

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new GitHubReadError("repository file response is malformed JSON", "response");
      }
      const file = asObject(payload);
      if (!file || file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
        throw new GitHubReadError("repository file response is malformed", "response");
      }
      return decodeBase64(file.content);
    },
  };
};
