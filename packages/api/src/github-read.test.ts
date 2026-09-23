import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubReader, GitHubReadConfigurationError, GitHubReadError } from "./github-read.js";

test("an empty GitHub read token is a named configuration refusal", () => {
  for (const token of ["", "   "]) {
    assert.throws(
      () => createGitHubReader(token),
      (error: unknown) => error instanceof GitHubReadConfigurationError
        && error.name === "GitHubReadConfigurationError"
        && error.message === "GITHUB_READ_TOKEN is required",
    );
  }
});

test("compare preserves ancestry, rename identity, and fails completeness closed at GitHub's file ceiling", async () => {
  const files = Array.from({ length: 300 }, (_, index) => ({
    filename: index === 299 ? "src/renamed.ts" : `docs/${index}.md`,
    ...(index === 299 ? { previous_filename: "packages/api/src/merge-readiness-worker.ts" } : {}),
    patch: "+added",
  }));
  const reader = createGitHubReader("read-token", async () => new Response(JSON.stringify({
    status: "ahead", behind_by: 0, files,
  }), { status: 200 }))!;
  const compared = await reader.compareCommits!("owner/repo", "a".repeat(40), "b".repeat(40), new AbortController().signal);
  assert.equal(compared.status, "ahead");
  assert.equal(compared.behindBy, 0);
  assert.equal(compared.filesComplete, false);
  assert.equal(compared.files[299]?.previousFilename, "packages/api/src/merge-readiness-worker.ts");
});

test("compare refuses an unknown ancestry status", async () => {
  const reader = createGitHubReader("read-token", async () => new Response(JSON.stringify({
    status: "mystery", behind_by: 0, files: [],
  }), { status: 200 }))!;
  await assert.rejects(
    reader.compareCommits!("owner/repo", "a".repeat(40), "b".repeat(40), new AbortController().signal),
    (error: unknown) => error instanceof GitHubReadError && /invalid status/u.test(error.message),
  );
});

test("transport failures retry with bounded exponential delays", async () => {
  let calls = 0;
  const waits: number[] = [];
  const reader = createGitHubReader("read-token", async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ status: "ahead", behind_by: 0, files: [] }), { status: 200 });
  }, { wait: async (delayMs) => { waits.push(delayMs); } })!;

  const compared = await reader.compareCommits!(
    "owner/repo",
    "a".repeat(40),
    "b".repeat(40),
    new AbortController().signal,
  );

  assert.equal(compared.status, "ahead");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 1_000]);
});

test("transport backoff stops immediately when the read deadline aborts", async () => {
  const deadline = new AbortController();
  let calls = 0;
  const reader = createGitHubReader("read-token", async () => {
    calls += 1;
    queueMicrotask(() => deadline.abort());
    throw new TypeError("fetch failed");
  })!;

  await assert.rejects(
    reader.compareCommits!("owner/repo", "a".repeat(40), "b".repeat(40), deadline.signal),
    (error: unknown) => error instanceof GitHubReadError && error.kind === "timeout",
  );
  assert.equal(calls, 1);
});

test("claim-side file reads are single-shot so the outer claim policy owns retries", async () => {
  let calls = 0;
  const waits: number[] = [];
  const reader = createGitHubReader("read-token", async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  }, { wait: async (delayMs) => { waits.push(delayMs); } })!;

  await assert.rejects(
    reader.readFileAtCommit("owner/repo", "spec.md", "commit", new AbortController().signal),
    (error: unknown) => error instanceof GitHubReadError && error.kind === "transport",
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("permission failures never retry", async () => {
  let calls = 0;
  const waits: number[] = [];
  const reader = createGitHubReader("read-token", async () => {
    calls += 1;
    return new Response("forbidden", { status: 403 });
  }, { wait: async (delayMs) => { waits.push(delayMs); } })!;

  await assert.rejects(
    reader.compareCommits!("owner/repo", "a".repeat(40), "b".repeat(40), new AbortController().signal),
    (error: unknown) => error instanceof GitHubReadError && error.kind === "permission",
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("readFileAtCommit reads exact bytes from a commit-pinned Contents request", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const reader = createGitHubReader("read-token", async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({
      type: "file",
      encoding: "base64",
      // Contents responses may wrap base64 in newlines.
      content: "AP8K\n",
    }), { status: 200 });
  })!;

  const bytes = await reader.readFileAtCommit(
    "owner/repo",
    "docs/spec file.md",
    "0123456789abcdef0123456789abcdef01234567",
    new AbortController().signal,
  );

  assert.deepEqual(bytes, Buffer.from([0, 255, 10]));
  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/owner/repo/contents/docs/spec%20file.md?ref=0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(calls[0]?.init.method, "GET");
  assert.deepEqual(calls[0]?.init.headers, {
    Authorization: "Bearer read-token",
    Accept: "application/vnd.github+json",
  });
});

test("readFileAtCommit preserves a zero-byte repository file", async () => {
  const reader = createGitHubReader("read-token", async () => new Response(JSON.stringify({
    type: "file",
    encoding: "base64",
    content: "",
  }), { status: 200 }))!;

  const bytes = await reader.readFileAtCommit(
    "owner/repo",
    "spec.md",
    "commit",
    new AbortController().signal,
  );

  assert.deepEqual(bytes, Buffer.alloc(0));
});

test("readFileAtCommit refuses malformed JSON, file metadata, and base64", async () => {
  const responses = [
    new Response("{", { status: 200 }),
    new Response(JSON.stringify({ type: "directory", encoding: "base64", content: "" }), { status: 200 }),
    new Response(JSON.stringify({ type: "file", encoding: "base64", content: "not base64!" }), { status: 200 }),
  ];

  for (const response of responses) {
    const reader = createGitHubReader("read-token", async () => response)!;
    await assert.rejects(
      reader.readFileAtCommit("owner/repo", "spec.md", "commit", new AbortController().signal),
      (error: unknown) => error instanceof GitHubReadError && error.kind === "response" && /malformed/u.test(error.message),
    );
  }
});

test("readFileAtCommit names a missing file and surfaces other HTTP errors", async () => {
  let missingCalls = 0;
  const missingReader = createGitHubReader("read-token", async () => {
    missingCalls += 1;
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  })!;
  await assert.rejects(
    missingReader.readFileAtCommit("owner/repo", "spec.md", "commit", new AbortController().signal),
    (error: unknown) => error instanceof GitHubReadError
      && error.kind === "response"
      && /repository file is missing/u.test(error.message),
  );
  assert.equal(missingCalls, 1);

  const errorReader = createGitHubReader("read-token", async () => new Response("bad request", { status: 422 }))!;
  await assert.rejects(
    errorReader.readFileAtCommit("owner/repo", "spec.md", "commit", new AbortController().signal),
    (error: unknown) => error instanceof GitHubReadError
      && error.kind === "response"
      && /returned 422/u.test(error.message),
  );
});

test("branch head reads encode the Chain branch and reject non-commit or malformed refs", async () => {
  for (const object of [
    { type: "commit", sha: "a".repeat(40) },
    { type: "tag", sha: "a".repeat(40) },
    { type: "commit", sha: "bad" },
    null,
  ]) {
    const reader = createGitHubReader("test-token", async (url) => {
      assert.equal(url, "https://api.github.com/repos/acme/widgets/git/ref/heads/fix/repair");
      return Response.json({ object });
    });
    const read = reader.readBranchHead("acme/widgets", "fix/repair", new AbortController().signal);
    if (object?.type === "commit" && object.sha.length === 40) assert.equal(await read, object.sha);
    else await assert.rejects(read, /branch response has no exact commit head/u);
  }
});

test("Actions failure log is bound to the check job and head, with token kept off the redirect", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const head = "a".repeat(40);
  const reader = createGitHubReader("read-token", async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    if (String(url).endsWith("/actions/jobs/22")) return Response.json({
      id: 22, run_id: 11, head_sha: head, name: "typecheck", status: "completed",
      steps: [{ name: "Run typecheck", conclusion: "failure" }],
    });
    if (String(url).endsWith("/actions/jobs/22/logs")) return new Response(null, {
      status: 302, headers: { Location: "https://logs.example.test/signed" },
    });
    return new Response("step output\nerror TS2322\n", { status: 200 });
  });
  const log = await reader.readActionsFailureLog("acme/widgets", head, {
    name: "typecheck", detailsUrl: "https://github.com/ACME/WIDGETS/actions/runs/11/job/22?check_suite_focus=true",
  }, new AbortController().signal);
  assert.match(log, /Run typecheck/u);
  assert.match(log, /TS2322/u);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer read-token");
  assert.equal(calls[2]?.headers.get("authorization"), null);
});

test("Actions log falls back to the bounded job tail when failed-step timestamps do not match", async () => {
  const head = "a".repeat(40);
  const largeTail = "x".repeat(5_000);
  const reader = createGitHubReader("read-token", async (url) => {
    if (String(url).endsWith("/actions/jobs/22")) return Response.json({
      id: 22, run_id: 11, head_sha: head, name: "typecheck", status: "completed",
      steps: [{ name: "Run typecheck", conclusion: "failure",
        started_at: "2026-09-23T10:00:00Z", completed_at: "2026-09-23T10:01:00Z" }],
    });
    if (String(url).endsWith("/actions/jobs/22/logs")) return new Response(null, {
      status: 302, headers: { Location: "https://logs.example.test/signed" },
    });
    return new Response(`2026-09-23T09:00:00Z ${largeTail}\n2026-09-23T09:00:01Z error TS2322`, { status: 200 });
  });
  const log = await reader.readActionsFailureLog("acme/widgets", head, {
    name: "typecheck", detailsUrl: "https://github.com/acme/widgets/actions/runs/11/job/22",
  }, new AbortController().signal);
  assert.match(log, /error TS2322/u);
  assert.ok(Buffer.byteLength(log) <= 4_100);
});

test("signed Actions log download retries a transient server error without forwarding the token", async () => {
  const head = "a".repeat(40);
  let downloads = 0;
  const waits: number[] = [];
  const reader = createGitHubReader("read-token", async (url, init) => {
    if (String(url).endsWith("/actions/jobs/22")) return Response.json({
      id: 22, run_id: 11, head_sha: head, name: "typecheck", status: "completed", steps: [],
    });
    if (String(url).endsWith("/actions/jobs/22/logs")) return new Response(null, {
      status: 302, headers: { Location: "https://logs.example.test/signed" },
    });
    downloads += 1;
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return new Response(downloads === 1 ? "unavailable" : "error TS2322", { status: downloads === 1 ? 503 : 200 });
  }, { wait: async (delayMs) => { waits.push(delayMs); } });
  const log = await reader.readActionsFailureLog("acme/widgets", head, {
    name: "typecheck", detailsUrl: "https://github.com/acme/widgets/actions/runs/11/job/22",
  }, new AbortController().signal);
  assert.match(log, /TS2322/u);
  assert.equal(downloads, 2);
  assert.deepEqual(waits, [250]);
});

test("Actions job identity mismatch and non-Actions check URL refuse log recovery", async () => {
  const head = "a".repeat(40);
  for (const changed of [
    { head_sha: "b".repeat(40) }, { run_id: 12 }, { id: 23 },
    { name: "other job" }, { status: "in_progress" },
  ]) {
    const reader = createGitHubReader("read-token", async () => Response.json({
      id: 22, run_id: 11, head_sha: head, name: "typecheck", status: "completed", ...changed,
    }));
    await assert.rejects(reader.readActionsFailureLog("acme/widgets", head, {
      name: "typecheck", detailsUrl: "https://github.com/acme/widgets/actions/runs/11/job/22",
    }, new AbortController().signal), /identity does not match/u);
  }
  const reader = createGitHubReader("read-token", async () => Response.json({}));
  await assert.rejects(reader.readActionsFailureLog("acme/widgets", head, {
    name: "typecheck", detailsUrl: "https://elsewhere.test/22",
  }, new AbortController().signal), /no GitHub Actions job URL/u);
  await assert.rejects(reader.readActionsFailureLog("acme/widgets", head, {
    name: "typecheck", detailsUrl: "https://github.com/acme/widgets/actions/runs/11/job/22#fragment",
  }, new AbortController().signal), /no GitHub Actions job URL/u);
});
