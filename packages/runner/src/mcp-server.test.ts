import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleRequest, invokeTool, readCredentials, TOOLS, type SessionCredentials } from "./mcp-server.js";

type Received = { method: string; url: string; authorization: string | undefined; body: string };

const withApi = async (
  respond: (received: Received) => { status: number; body: string },
  callback: (credentials: SessionCredentials, received: Received[]) => Promise<void>,
): Promise<void> => {
  const received: Received[] = [];
  const workspace = await mkdtemp(join(tmpdir(), "agentos-mcp-workspace-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Anneal Test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "runner@agentos.local"], { cwd: workspace });
  await writeFile(join(workspace, "fixture.txt"), "fixture\n");
  execFileSync("git", ["add", "fixture.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const hit = { method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body };
      received.push(hit);
      const reply = respond(hit);
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await callback({
      apiUrl: `http://127.0.0.1:${port}`,
      runId: "run-1",
      sessionToken: "agos_session_test",
      fencingToken: "1:run-1:token",
      workspacePath: workspace,
    }, received);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
};

test("the MCP handshake advertises all ten Anneal tools", async () => {
  const credentials = { apiUrl: "http://unused", runId: "run-1", sessionToken: "t", fencingToken: "f", workspacePath: process.cwd() };
  const initialize = await handleRequest(credentials, {
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" },
  });
  // The client's protocol version is echoed when supported, else ours.
  assert.equal((initialize?.result as Record<string, unknown>).protocolVersion, "2024-11-05");
  const listed = await handleRequest(credentials, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    ((listed?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name),
    ["task_activity_log", "task_output", "task_status", "task_patch", "inbox_ask", "revalidation_cancel", "files_list", "files_read", "files_write", "files_delete"],
  );
  assert.equal(TOOLS.length, 10);
  // Notifications never get a reply.
  assert.equal(await handleRequest(credentials, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("four file tools hit the correct session routes and preserve base64", async () => {
  await withApi((hit) => ({
    status: 200,
    body: hit.method === "GET" && hit.url.includes("content")
      ? JSON.stringify({ content: "/+7d", encoding: "base64" })
      : JSON.stringify({ ok: true }),
  }), async (credentials, received) => {
    await invokeTool(credentials, "files_list", { dir: "project/reports" });
    const read = await invokeTool(credentials, "files_read", { path: "project/binary.bin" });
    await invokeTool(credentials, "files_write", { path: "project/binary.bin", content: "/+7d", encoding: "base64" });
    await invokeTool(credentials, "files_delete", { path: "project/binary.bin" });
    assert.match(read.content[0]!.text, /"encoding": "base64"/u);
    assert.deepEqual(received.map(({ method, url }) => `${method} ${url}`), [
      "GET /session/runs/run-1/files?dir=project%2Freports",
      "GET /session/runs/run-1/files/content?path=project%2Fbinary.bin",
      "PUT /session/runs/run-1/files/content",
      "DELETE /session/runs/run-1/files?path=project%2Fbinary.bin",
    ]);
    assert.deepEqual(JSON.parse(received[2]!.body), { path: "project/binary.bin", content: "/+7d", encoding: "base64" });
    assert.ok(received.every((hit) => hit.authorization === "Bearer agos_session_test"));
  });
});

test("file tool query encoding preserves reserved, spaced, and non-ASCII filenames", async () => {
  const filename = "folder/a?#%& space 报告.md";
  await withApi((hit) => {
    const parsed = new URL(hit.url, "http://local");
    assert.equal(parsed.searchParams.get("path"), filename);
    return { status: 200, body: JSON.stringify({ content: "ok", encoding: "utf8" }) };
  }, async (credentials) => {
    await invokeTool(credentials, "files_read", { path: filename });
  });
});

test("file route 403 and 413 responses surface as MCP tool errors", async () => {
  for (const status of [403, 413]) {
    await withApi(() => ({ status, body: JSON.stringify({ error: status === 403 ? "Filesystem grant missing canRead" : "too large" }) }), async (credentials) => {
      const response = await handleRequest(credentials, {
        jsonrpc: "2.0", id: status, method: "tools/call", params: { name: "files_read", arguments: { path: "x" } },
      });
      const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, new RegExp(String(status)));
    });
  }
});

test("tools carry the session token and fencing token to the session endpoints", async () => {
  await withApi(() => ({ status: 200, body: JSON.stringify({ ok: true }) }), async (credentials, received) => {
    await invokeTool(credentials, "task_output", { kind: "spec", body: "the deliverable" });
    await invokeTool(credentials, "task_activity_log", { body: "made progress" });
    assert.deepEqual(received.map((hit) => `${hit.method} ${hit.url}`), [
      "PUT /session/runs/run-1/output",
      "POST /session/runs/run-1/activity",
    ]);
    assert.ok(received.every((hit) => hit.authorization === "Bearer agos_session_test"));
    assert.ok(received.every((hit) => JSON.parse(hit.body).fencingToken === "1:run-1:token"));
    assert.match(String(JSON.parse(received[0]!.body).commitSha), /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
  });
});

test("revalidation tools use only the derived session routes", async () => {
  await withApi(() => ({ status: 200, body: JSON.stringify({ ok: true }) }), async (credentials, received) => {
    await invokeTool(credentials, "task_patch", { description: "Current file references." });
    await invokeTool(credentials, "revalidation_cancel", {});
    assert.deepEqual(received.map((hit) => `${hit.method} ${hit.url}`), [
      "PATCH /session/runs/run-1/task",
      "POST /session/runs/run-1/revalidation/cancel",
    ]);
    assert.deepEqual(JSON.parse(received[0]!.body), {
      fencingToken: "1:run-1:token",
      description: "Current file references.",
    });
    assert.deepEqual(JSON.parse(received[1]!.body), { fencingToken: "1:run-1:token" });
  });
});

test("task_output reveals predecessor outputs only in the successful platform response", async () => {
  await withApi((_hit) => ({
    status: 200,
    body: JSON.stringify({
      id: "output-1",
      predecessorOutputs: [{ kind: "sol-findings", body: "SOL-1", commitSha: "a".repeat(40), task: { name: "Review", chainIndex: 2 } }],
    }),
  }), async (credentials) => {
    const result = await invokeTool(credentials, "task_output", { kind: "must-fix", body: "independent findings" });
    assert.match(result.content[0]!.text, /Output persisted/u);
    assert.match(result.content[0]!.text, /Predecessor step outputs are now available/u);
    assert.match(result.content[0]!.text, /SOL-1/u);
  });
});

test("an API rejection is reported to the model rather than breaking the protocol", async () => {
  await withApi(() => ({ status: 409, body: JSON.stringify({ error: "Stale fencing token" }) }), async (credentials) => {
    const response = await handleRequest(credentials, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_output", arguments: { kind: "spec", body: "x" } },
    });
    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /409/);
    assert.equal(response?.error, undefined);
  });
});

test("credentials come from the environment or the file, and missing ones are named", () => {
  const environment = {
    AGENTOS_API_URL: "http://api/", AGENTOS_RUN_ID: "run-1",
    AGENTOS_SESSION_TOKEN: "token", AGENTOS_FENCING_TOKEN: "fence", AGENTOS_WORKSPACE_PATH: "/work",
  };
  assert.deepEqual(readCredentials(environment), {
    apiUrl: "http://api", runId: "run-1", sessionToken: "token", fencingToken: "fence", workspacePath: "/work",
  });
  assert.throws(() => readCredentials({ AGENTOS_RUN_ID: "run-1" }), /AGENTOS_API_URL, AGENTOS_SESSION_TOKEN, AGENTOS_FENCING_TOKEN, AGENTOS_WORKSPACE_PATH/);
});
