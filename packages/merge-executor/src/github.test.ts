import assert from "node:assert/strict";
import { test } from "node:test";

import { makeGitHubClient, splitRepository, type Http, type HttpResponse } from "./github.js";

const TOKEN = `ghp_${"Q".repeat(36)}`;

const clientWith = (responses: HttpResponse[]) => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let index = 0;
  const http: Http = async (request) => {
    requests.push({ url: request.url, method: request.method, headers: request.headers, ...(request.body ? { body: request.body } : {}) });
    return responses[Math.min(index++, responses.length - 1)]!;
  };
  return {
    requests,
    client: makeGitHubClient({
      restUrl: "https://api.github.test",
      graphqlUrl: "https://api.github.test/graphql",
      token: TOKEN,
      timeoutMs: 1_000,
      http,
    }),
  };
};

const readBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  data: {
    repository: {
      id: "R_repo",
      mergeQueue: null,
      branchProtectionRules: { nodes: [{ pattern: "master", requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: ["ci"] }] },
      ref: { target: { oid: "b".repeat(40) } },
      pullRequest: {
        id: "PR_1",
        number: 7,
        state: "OPEN",
        isDraft: false,
        merged: false,
        mergedAt: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        baseRefName: "master",
        headRefOid: "a".repeat(40),
        autoMergeRequest: null,
        mergeQueueEntry: null,
        mergedBy: null,
        mergeCommit: null,
        commits: { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [
          { __typename: "CheckRun", name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
          { __typename: "StatusContext", context: "legacy", state: "SUCCESS" },
        ] } } } }] },
        ...overrides,
      },
    },
  },
});

const reference = { owner: "owner", name: "name", number: 7, baseRef: "master" };

test("the read query parses every §11.1 field, including both rollup context shapes", async () => {
  const { client, requests } = clientWith([{ status: 200, body: readBody() }]);
  const result = await client.readPullRequest(reference);
  assert.equal(result.status, "ok");
  assert.ok(result.status === "ok");
  assert.equal(result.snapshot.pullRequest.headRefOid, "a".repeat(40));
  assert.equal(result.snapshot.baseRefOid, "b".repeat(40));
  assert.equal(result.snapshot.pullRequest.rollupCommitOid, "a".repeat(40));
  assert.deepEqual(result.snapshot.pullRequest.checks, [
    { kind: "CheckRun", name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
    { kind: "StatusContext", context: "legacy", state: "SUCCESS" },
  ]);
  assert.deepEqual(result.snapshot.branchProtectionRules[0]?.requiredStatusCheckContexts, ["ci"]);
  // The credential travels in a header, never in a URL or a query variable.
  assert.equal(requests[0]!.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0]!.url.includes(TOKEN), false);
  assert.equal(requests[0]!.body?.includes(TOKEN), false);
});

test("a GraphQL errors entry is an api-error, never a data path", async () => {
  const { client } = clientWith([{ status: 200, body: JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN", message: "no" }] }) }]);
  const result = await client.readPullRequest(reference);
  assert.equal(result.status, "api-error");
  assert.ok(result.status === "api-error" && result.reason.includes("FORBIDDEN"));
});

test("a 401 or 403 is an api-error, and is never read as 'no queue' or 'no auto-merge'", async () => {
  for (const status of [401, 403]) {
    const { client } = clientWith([{ status, body: "denied" }]);
    const result = await client.readPullRequest(reference);
    assert.equal(result.status, "api-error", String(status));
  }
});

test("an omitted synchronous-execution field is sync-unknown, not null", async () => {
  const body = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
  const pullRequest = body.data.repository.pullRequest as Record<string, unknown>;
  delete pullRequest.autoMergeRequest;
  const { client } = clientWith([{ status: 200, body: JSON.stringify(body) }]);
  const result = await client.readPullRequest(reference);
  assert.equal(result.status, "sync-unknown");

  const withoutQueue = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
  delete withoutQueue.data.repository.mergeQueue;
  const second = clientWith([{ status: 200, body: JSON.stringify(withoutQueue) }]);
  assert.equal((await second.client.readPullRequest(reference)).status, "sync-unknown");
});

test("canonical merge constructs a two-parent tree without .chain and leaves the PR branch untouched", async () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const headTree = "1".repeat(40);
  const cleanTree = "2".repeat(40);
  const mergeCommit = "c".repeat(40);
  const { client, requests } = clientWith([
    { status: 200, body: JSON.stringify({ tree: { sha: headTree } }) },
    { status: 200, body: JSON.stringify({ truncated: false, tree: [{ path: ".chain/topic/spec.md", sha: "3".repeat(40) }, { path: "src/a.ts", sha: "4".repeat(40) }] }) },
    { status: 201, body: JSON.stringify({ sha: cleanTree }) },
    { status: 201, body: JSON.stringify({ sha: mergeCommit }) },
    { status: 200, body: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }) },
  ]);
  assert.deepEqual(
    await client.mergePullRequest({ owner: "owner", name: "name", number: 7 }, head, { ref: "main", sha: base, repositoryId: "R_repo" }),
    { status: "merged", sha: mergeCommit },
  );
  assert.deepEqual(JSON.parse(requests[2]!.body!), {
    base_tree: headTree,
    tree: [{ path: ".chain", mode: "040000", type: "tree", sha: null }],
  });
  assert.deepEqual(JSON.parse(requests[3]!.body!), {
    message: "Merge pull request #7\n\nAnneal autonomous exact-head merge",
    tree: cleanTree,
    parents: [base, head],
  });
  assert.equal(requests[4]!.method, "POST");
  assert.equal(requests[4]!.url, "https://api.github.test/graphql");
  assert.deepEqual(JSON.parse(requests[4]!.body!).variables.refUpdates, [{
    name: "refs/heads/main", beforeOid: base, afterOid: mergeCommit, force: false,
  }]);
  assert.equal(requests.some((request) => request.url.includes("git/refs/heads/feature")), false);
});

test("resulting Git objects strip .chain only from the landed merge and CAS refuses stale base", async () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const headTree = "1".repeat(40);
  const cleanTree = "2".repeat(40);
  const mergeCommit = "c".repeat(40);
  const trees = new Map<string, string[]>([[headTree, [".chain/topic/spec.md", "src/a.ts"]]]);
  const commits = new Map<string, { tree: string; parents: string[] }>([[head, { tree: headTree, parents: [] }]]);
  let baseRef = base;
  let forceDrift = false;
  const http: Http = async (request) => {
    if (request.url.endsWith(`/git/commits/${head}`)) return { status: 200, body: JSON.stringify({ tree: { sha: headTree } }) };
    if (request.url.includes(`/git/trees/${headTree}?recursive=1`)) {
      return { status: 200, body: JSON.stringify({ truncated: false, tree: trees.get(headTree)!.map((path) => ({ path })) }) };
    }
    if (request.url.endsWith("/git/trees")) {
      trees.set(cleanTree, trees.get(headTree)!.filter((path) => path.split("/")[0] !== ".chain"));
      return { status: 201, body: JSON.stringify({ sha: cleanTree }) };
    }
    if (request.url.endsWith("/git/commits")) {
      const body = JSON.parse(request.body ?? "{}") as { tree: string; parents: string[] };
      commits.set(mergeCommit, { tree: body.tree, parents: body.parents });
      return { status: 201, body: JSON.stringify({ sha: mergeCommit }) };
    }
    if (request.url.endsWith("/graphql")) {
      const body = JSON.parse(request.body ?? "{}") as { variables: { refUpdates: Array<{ beforeOid: string; afterOid: string }> } };
      const update = body.variables.refUpdates[0]!;
      if (forceDrift) baseRef = head;
      if (baseRef !== update.beforeOid) return { status: 200, body: JSON.stringify({ data: null, errors: [{ message: "beforeOid mismatch" }] }) };
      baseRef = update.afterOid;
      return { status: 200, body: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }) };
    }
    return { status: 500, body: "unexpected request" };
  };
  const client = makeGitHubClient({
    restUrl: "https://api.github.test", graphqlUrl: "https://api.github.test/graphql",
    token: TOKEN, timeoutMs: 1_000, http,
  });
  assert.deepEqual(await client.mergePullRequest(
    { owner: "owner", name: "name", number: 7 }, head,
    { ref: "main", sha: base, repositoryId: "R_repo" },
  ), { status: "merged", sha: mergeCommit });
  assert.equal(trees.get(commits.get(baseRef)!.tree)!.some((path) => path.startsWith(".chain/")), false);
  assert.equal(trees.get(commits.get(head)!.tree)!.some((path) => path.startsWith(".chain/")), true);

  baseRef = base;
  forceDrift = true;
  assert.deepEqual(await client.mergePullRequest(
    { owner: "owner", name: "name", number: 7 }, head,
    { ref: "main", sha: base, repositoryId: "R_repo" },
  ), { status: "ref-update-refused", reason: "UNKNOWN: beforeOid mismatch" });
  assert.equal(baseRef, head);
});

test("a malformed or truncated recursive tree refuses the merge", async () => {
  for (const tree of [{ tree: [] }, { truncated: true, tree: [] }, { truncated: false, tree: null }]) {
    const { client } = clientWith([
      { status: 200, body: JSON.stringify({ tree: { sha: "1".repeat(40) } }) },
      { status: 200, body: JSON.stringify(tree) },
    ]);
    const response = await client.mergePullRequest(
      { owner: "owner", name: "name", number: 7 }, "a".repeat(40),
      { ref: "main", sha: "b".repeat(40), repositoryId: "R_repo" },
    );
    assert.equal(response.status, "unknown");
    assert.match(response.status === "unknown" ? response.reason : "", /malformed or truncated/u);
  }
});

test("§11.4 — the two disarm mutations report their own GraphQL errors rather than swallowing them", async () => {
  const ok = clientWith([{ status: 200, body: JSON.stringify({ data: { disablePullRequestAutoMerge: { pullRequest: { id: "PR_1" } } } }) }]);
  assert.deepEqual(await ok.client.disableAutoMerge("PR_1"), { ok: true });

  const failed = clientWith([{ status: 200, body: JSON.stringify({ data: null, errors: [{ type: "FORBIDDEN", message: "nope" }] }) }]);
  const result = await failed.client.dequeuePullRequest("MQE_1");
  assert.equal(result.ok, false);
});

test("a network failure or an unparseable body is reported, never treated as success", async () => {
  const client = makeGitHubClient({
    restUrl: "https://api.github.test",
    graphqlUrl: "https://api.github.test/graphql",
    token: TOKEN,
    timeoutMs: 5,
    http: async () => { throw new Error("ECONNRESET"); },
  });
  const read = await client.readPullRequest(reference);
  assert.equal(read.status, "api-error");
  const merge = await client.mergePullRequest(
    { owner: "owner", name: "name", number: 7 }, "a".repeat(40),
    { ref: "main", sha: "b".repeat(40), repositoryId: "R_repo" },
  );
  assert.equal(merge.status, "unknown");

  const garbage = clientWith([{ status: 200, body: "<html>" }]);
  assert.equal((await garbage.client.readPullRequest(reference)).status, "api-error");
});

test("a repository identifier is split strictly", () => {
  assert.deepEqual(splitRepository("owner/name"), { owner: "owner", name: "name" });
  assert.equal(splitRepository("owner/name/extra"), null);
  assert.equal(splitRepository("owner"), null);
});

const repositoryReference = { owner: "owner", name: "name" };
const trainHead = "c".repeat(40);
const trainBase = "b".repeat(40);

test("train reads the repository's default branch and its exact ref oid", async () => {
  const { client, requests } = clientWith([
    { status: 200, body: JSON.stringify({ default_branch: "main" }) },
    { status: 200, body: JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: trainBase } }) },
  ]);
  assert.deepEqual(await client.readDefaultBranch(repositoryReference), { status: "ok", name: "main", oid: trainBase });
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: "GET", url: "https://api.github.test/repos/owner/name" },
    { method: "GET", url: "https://api.github.test/repos/owner/name/git/ref/heads/main" },
  ]);
});

test("train ref reads distinguish a missing ref from an API failure", async () => {
  const missing = clientWith([{ status: 404, body: "missing" }]);
  assert.deepEqual(await missing.client.readRef(repositoryReference, "refs/anneal/train/" + trainHead), { status: "ok", oid: null });

  const malformed = clientWith([{ status: 200, body: JSON.stringify({ object: { sha: 7 } }) }]);
  const malformedResult = await malformed.client.readRef(repositoryReference, "refs/anneal/train/" + trainHead);
  assert.equal(malformedResult.status, "api-error");

  const failed = clientWith([{ status: 500, body: "upstream" }]);
  const failedResult = await failed.client.readRef(repositoryReference, "refs/anneal/train/" + trainHead);
  assert.equal(failedResult.status, "api-error");
});

test("train ancestry compares GitHub's strict compare statuses", async () => {
  for (const [status, expected] of [["ahead", true], ["identical", true], ["behind", false], ["diverged", false]] as const) {
    const { client, requests } = clientWith([{ status: 200, body: JSON.stringify({ status }) }]);
    assert.deepEqual(await client.isAncestor(repositoryReference, trainBase, trainHead), { status: "ok", ancestor: expected });
    assert.equal(requests[0]!.url, `https://api.github.test/repos/owner/name/compare/${trainBase}...${trainHead}`);
  }
  const unknown = clientWith([{ status: 200, body: JSON.stringify({ status: "unknown" }) }]);
  const result = await unknown.client.isAncestor(repositoryReference, trainBase, trainHead);
  assert.equal(result.status, "api-error");
});

test("train commit reads require an exact sha and strictly shaped parent shas", async () => {
  const predecessor = "a".repeat(40);
  const { client, requests } = clientWith([{
    status: 200,
    body: JSON.stringify({ sha: trainHead, parents: [{ sha: predecessor }, { sha: trainBase }] }),
  }]);
  assert.deepEqual(await client.readCommit(repositoryReference, trainHead), {
    status: "ok",
    commit: { oid: trainHead, parents: [predecessor, trainBase] },
  });
  assert.equal(requests[0]!.url, `https://api.github.test/repos/owner/name/git/commits/${trainHead}`);

  for (const body of [
    { sha: "d".repeat(40), parents: [] },
    { sha: trainHead, parents: [{ sha: "short" }] },
    { sha: trainHead, parents: [{ sha: 7 }] },
    { sha: trainHead },
  ]) {
    const malformed = clientWith([{ status: 200, body: JSON.stringify(body) }]);
    assert.equal((await malformed.client.readCommit(repositoryReference, trainHead)).status, "api-error");
  }
});

test("train publication is a non-forced PATCH and only 409/422 are deterministic rejections", async () => {
  const { client, requests } = clientWith([{ status: 200, body: JSON.stringify({ ref: "refs/heads/main", object: { sha: trainHead } }) }]);
  assert.deepEqual(await client.publishTrain(repositoryReference, "main", trainHead), { status: "published" });
  assert.equal(requests[0]!.method, "PATCH");
  assert.equal(requests[0]!.url, "https://api.github.test/repos/owner/name/git/refs/heads/main");
  assert.deepEqual(JSON.parse(requests[0]!.body!), { sha: trainHead, force: false });

  for (const status of [409, 422]) {
    const rejected = clientWith([{ status, body: "ref refused" }]);
    const result = await rejected.client.publishTrain(repositoryReference, "main", trainHead);
    assert.equal(result.status, "rejected");
    assert.match(result.status === "rejected" ? result.reason : "", new RegExp(`HTTP ${status}`, "u"));
  }
  // An access or addressing failure is not evidence of a non-fast-forward.
  for (const status of [401, 403, 404]) {
    const denied = clientWith([{ status, body: "ref refused" }]);
    assert.equal((await denied.client.publishTrain(repositoryReference, "main", trainHead)).status, "unknown");
  }

  const ambiguous = clientWith([{ status: 503, body: "upstream" }]);
  const result = await ambiguous.client.publishTrain(repositoryReference, "main", trainHead);
  assert.equal(result.status, "unknown");

  for (const body of [
    "",
    JSON.stringify({ ref: "refs/heads/main", object: { sha: "d".repeat(40) } }),
    JSON.stringify({ ref: "refs/heads/other", object: { sha: trainHead } }),
  ]) {
    const malformed = clientWith([{ status: 200, body }]);
    assert.equal((await malformed.client.publishTrain(repositoryReference, "main", trainHead)).status, "unknown");
  }
});

test("train ref deletion uses the GitHub git-refs API and reports failures as disarm failures", async () => {
  const ref = "refs/anneal/train/" + trainHead;
  const { client, requests } = clientWith([{ status: 204, body: "" }]);
  assert.deepEqual(await client.deleteTrainRef(repositoryReference, ref), { ok: true });
  assert.equal(requests[0]!.method, "DELETE");
  assert.equal(requests[0]!.url, "https://api.github.test/repos/owner/name/git/refs/anneal/train/" + trainHead);

  const missing = clientWith([{ status: 404, body: "missing" }]);
  assert.deepEqual(await missing.client.deleteTrainRef(repositoryReference, ref), { ok: true });

  const failed = clientWith([{ status: 500, body: "upstream" }]);
  const result = await failed.client.deleteTrainRef(repositoryReference, ref);
  assert.equal(result.ok, false);
});

/* ------------------------------------------------- fail-closed field parsing */

/**
 * The review of PR #130 reproduced the fail-open exactly: set
 * `branchProtectionRules` to null, give the three synchronous-execution fields
 * malformed non-empty strings, omit `isDraft`, and the old parser answered
 * `ok` with all four collapsed to their safe values — after which
 * `classifyPreMerge` returned `{kind:"ok"}`, i.e. "merge may proceed".
 */
test("the review's exact fail-open reproduction is now a refusal, not an ok snapshot", async () => {
  const body = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
  const repository = body.data.repository;
  const pullRequest = repository.pullRequest as Record<string, unknown>;
  repository.branchProtectionRules = null;
  repository.mergeQueue = "not-a-record";
  pullRequest.mergeQueueEntry = "not-a-record";
  pullRequest.autoMergeRequest = "not-a-record";
  delete pullRequest.isDraft;
  const { client } = clientWith([{ status: 200, body: JSON.stringify(body) }]);
  const result = await client.readPullRequest(reference);
  // Refused, and the reason names the first thing that was wrong. Absence is
  // reported before malformation, so the omitted `isDraft` is what surfaces —
  // what matters is that no snapshot is produced at all.
  assert.notEqual(result.status, "ok", JSON.stringify(result));
  assert.equal(result.status, "api-error");
  assert.ok(result.status === "api-error" && result.reason.includes("isDraft"));

  // With `isDraft` supplied, the same body still refuses — now on the three
  // synchronous-execution fields, which degrade to the §11.2 last row.
  (body.data.repository.pullRequest as Record<string, unknown>).isDraft = false;
  const second = clientWith([{ status: 200, body: JSON.stringify(body) }]);
  assert.equal((await second.client.readPullRequest(reference)).status, "sync-unknown");
});

test("a key that is present but malformed refuses the read, field by field", async () => {
  // Each entry mutates exactly one bound field to a value of the wrong type —
  // "present but malformed", which is the case the old parser silently
  // defaulted. `null` is *not* used here: null is a fact the platform may
  // legitimately report and is covered by the happy-path fixture.
  const cases: Array<[string, (repository: Record<string, unknown>, pullRequest: Record<string, unknown>) => void, string]> = [
    ["isDraft", (_r, pr) => { pr.isDraft = "false"; }, "api-error"],
    ["merged", (_r, pr) => { pr.merged = 0; }, "api-error"],
    ["headRefOid", (_r, pr) => { pr.headRefOid = 42; }, "api-error"],
    ["baseRefName", (_r, pr) => { pr.baseRefName = ["master"]; }, "api-error"],
    ["state", (_r, pr) => { pr.state = { value: "OPEN" }; }, "api-error"],
    ["number", (_r, pr) => { pr.number = "7"; }, "api-error"],
    ["mergeable", (_r, pr) => { pr.mergeable = 1; }, "api-error"],
    ["mergeStateStatus", (_r, pr) => { pr.mergeStateStatus = true; }, "api-error"],
    ["mergedAt", (_r, pr) => { pr.mergedAt = 1700000000; }, "api-error"],
    ["mergedBy", (_r, pr) => { pr.mergedBy = { login: 7 }; }, "api-error"],
    ["mergeCommit.oid", (_r, pr) => { pr.mergeCommit = { oid: 7, parents: { nodes: [] } }; }, "api-error"],
    ["mergeCommit.parents", (_r, pr) => { pr.mergeCommit = { oid: "c".repeat(40), parents: null }; }, "api-error"],
    ["commits", (_r, pr) => { pr.commits = "many"; }, "api-error"],
    ["commits.nodes", (_r, pr) => { pr.commits = { nodes: "one" }; }, "api-error"],
    ["statusCheckRollup", (_r, pr) => {
      pr.commits = { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: "SUCCESS" } }] };
    }, "api-error"],
    ["rollup context __typename", (_r, pr) => {
      pr.commits = { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { contexts: { nodes: [{ __typename: "SomethingNew", name: "ci" }] } } } }] };
    }, "api-error"],
    ["CheckRun.conclusion", (_r, pr) => {
      pr.commits = { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", conclusion: 1, status: "COMPLETED" }] } } } }] };
    }, "api-error"],
    ["branchProtectionRules", (repository) => { repository.branchProtectionRules = null; }, "api-error"],
    ["branchProtectionRules.nodes", (repository) => { repository.branchProtectionRules = { nodes: {} }; }, "api-error"],
    ["rule.requiresStatusChecks", (repository) => {
      repository.branchProtectionRules = { nodes: [{ pattern: "master", requiresStatusChecks: "true", requiresStrictStatusChecks: false, requiredStatusCheckContexts: [] }] };
    }, "api-error"],
    ["rule.requiredStatusCheckContexts", (repository) => {
      repository.branchProtectionRules = { nodes: [{ pattern: "master", requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: [7] }] };
    }, "api-error"],
    ["rule.pattern missing", (repository) => {
      repository.branchProtectionRules = { nodes: [{ requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: [] }] };
    }, "api-error"],
    ["ref.target.oid", (repository) => { repository.ref = { target: { oid: 7 } }; }, "api-error"],
    // The three §11.3 fields degrade to the bounded-unknown row instead.
    ["mergeQueue", (repository) => { repository.mergeQueue = "on"; }, "sync-unknown"],
    ["mergeQueue.id", (repository) => { repository.mergeQueue = { id: 7 }; }, "sync-unknown"],
    ["mergeQueueEntry", (_r, pr) => { pr.mergeQueueEntry = "queued"; }, "sync-unknown"],
    ["mergeQueueEntry.position", (_r, pr) => { pr.mergeQueueEntry = { id: "MQE_1", state: "QUEUED", position: "1" }; }, "sync-unknown"],
    ["autoMergeRequest", (_r, pr) => { pr.autoMergeRequest = "enabled"; }, "sync-unknown"],
    ["autoMergeRequest.mergeMethod", (_r, pr) => { pr.autoMergeRequest = { enabledAt: null, mergeMethod: 3 }; }, "sync-unknown"],
  ];
  for (const [label, mutate, expected] of cases) {
    const body = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
    mutate(body.data.repository, body.data.repository.pullRequest as Record<string, unknown>);
    const { client } = clientWith([{ status: 200, body: JSON.stringify(body) }]);
    const result = await client.readPullRequest(reference);
    assert.equal(result.status, expected, `${label}: ${JSON.stringify(result)}`);
  }
});

test("a bound key omitted entirely is refused, and named in the reason", async () => {
  for (const key of ["id", "state", "merged", "mergedAt", "mergeable", "mergeStateStatus", "mergedBy", "mergeCommit", "commits", "isDraft"]) {
    const body = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
    delete (body.data.repository.pullRequest as Record<string, unknown>)[key];
    const { client } = clientWith([{ status: 200, body: JSON.stringify(body) }]);
    const result = await client.readPullRequest(reference);
    assert.equal(result.status, "api-error", key);
    assert.ok(result.status === "api-error" && result.reason.includes(key), `${key}: ${JSON.stringify(result)}`);
  }
  const withoutRef = JSON.parse(readBody()) as { data: { repository: Record<string, unknown> } };
  delete withoutRef.data.repository.ref;
  const { client } = clientWith([{ status: 200, body: JSON.stringify(withoutRef) }]);
  assert.equal((await client.readPullRequest(reference)).status, "api-error");
});

/* --------------------------------------------- did the ref update land? ---- */

/** The four calls of a merge whose head tree carries no `.chain/`. */
const mergeWithoutSanitizing = (final: HttpResponse | "lost") => {
  const head = "a".repeat(40);
  const headTree = "1".repeat(40);
  const mergeCommit = "c".repeat(40);
  const responses: HttpResponse[] = [
    { status: 200, body: JSON.stringify({ tree: { sha: headTree } }) },
    { status: 200, body: JSON.stringify({ truncated: false, tree: [{ path: "src/a.ts" }] }) },
    { status: 201, body: JSON.stringify({ sha: mergeCommit }) },
  ];
  let index = 0;
  const http: Http = async () => {
    const next = responses[index++];
    if (next) return next;
    if (final === "lost") throw new Error("ECONNRESET");
    return final;
  };
  return {
    head,
    mergeCommit,
    client: makeGitHubClient({
      restUrl: "https://api.github.test", graphqlUrl: "https://api.github.test/graphql",
      token: TOKEN, timeoutMs: 1_000, http,
    }),
  };
};

test("a lost updateRefs response is uncertain rather than refused, and carries the commit it may have landed", async () => {
  const { client, head, mergeCommit } = mergeWithoutSanitizing("lost");
  const response = await client.mergePullRequest(
    { owner: "owner", name: "name", number: 7 }, head,
    { ref: "main", sha: "b".repeat(40), repositoryId: "R_repo" },
  );
  // A compare-and-swap whose answer never arrived may be on the branch already.
  // Only the caller's read-back can say, and it needs this SHA to ask.
  assert.deepEqual(response, {
    status: "ref-update-uncertain",
    reason: "network: ECONNRESET",
    mergeCommitSha: mergeCommit,
  });

  // A 5xx on the same mutation is the same absence of information.
  const serverError = mergeWithoutSanitizing({ status: 502, body: "Bad Gateway" });
  assert.equal((await serverError.client.mergePullRequest(
    { owner: "owner", name: "name", number: 7 }, serverError.head,
    { ref: "main", sha: "b".repeat(40), repositoryId: "R_repo" },
  )).status, "ref-update-uncertain");
});

test("a deterministic REST rejection keeps its class instead of degrading to a lost outcome", async () => {
  const merge = (client: ReturnType<typeof makeGitHubClient>) => client.mergePullRequest(
    { owner: "owner", name: "name", number: 7 }, "a".repeat(40),
    { ref: "main", sha: "b".repeat(40), repositoryId: "R_repo" },
  );

  // A 422 on the merge-commit creation is an answer: the payload was rejected,
  // and sending it again gets the same rejection.
  const rejected = clientWith([
    { status: 200, body: JSON.stringify({ tree: { sha: "1".repeat(40) } }) },
    { status: 200, body: JSON.stringify({ truncated: false, tree: [{ path: "src/a.ts" }] }) },
    { status: 422, body: JSON.stringify({ message: "Invalid request" }) },
  ]);
  const response = await merge(rejected.client);
  assert.equal(response.status, "unprocessable");
  assert.match(response.status === "unprocessable" ? response.reason : "", /merge commit creation failed: HTTP 422/u);

  for (const [status, expected] of [[401, "forbidden"], [403, "forbidden"], [404, "not-found"], [400, "not-found"], [422, "not-found"]] as const) {
    const { client } = clientWith([{ status, body: "no" }]);
    assert.equal((await merge(client)).status, expected, String(status));
  }

  // The lost classes are unchanged: a 5xx, a 429 and an unreadable 2xx body all
  // leave the write's fate open.
  for (const response of [
    { status: 500, body: "boom" },
    { status: 429, body: "slow down" },
    { status: 200, body: "<html>" },
  ]) {
    const { client } = clientWith([response]);
    assert.equal((await merge(client)).status, "unknown", String(response.status));
  }
});

test("a GraphQL timeout on updateRefs carries the uncertain merge identity", async () => {
  const { client, head, mergeCommit } = mergeWithoutSanitizing({
    status: 200, body: JSON.stringify({ errors: [{ type: "TIMEOUT", message: "The request timed out" }] }),
  });
  assert.deepEqual(await client.mergePullRequest(reference, head,
    { ref: "main", sha: "b".repeat(40), repositoryId: "R_repo" }), {
    status: "ref-update-uncertain", reason: "TIMEOUT: The request timed out", mergeCommitSha: mergeCommit,
  });
});

test("a null updateRefs payload retains the uncertain merge identity", async () => {
  const { client, head, mergeCommit } = mergeWithoutSanitizing({
    status: 200, body: JSON.stringify({ data: { updateRefs: null } }),
  });
  assert.deepEqual(await client.mergePullRequest(reference, head,
    { ref: "main", sha: "b".repeat(40), repositoryId: "R_repo" }), {
    status: "ref-update-uncertain",
    reason: "updateRefs response did not prove the atomic ref update",
    mergeCommitSha: mergeCommit,
  });
});
