import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  manifestLines,
  requestFor,
  SESSION_TOOLS,
  type SessionToolName,
  type SessionToolRequest,
} from "./session-tool-contract.js";

const piExtension = fileURLToPath(new URL("../assets/pi-agentos-extension.ts", import.meta.url));

const toolNameFromManifest = (line: string): string => {
  const match = /^- ([a-z_]+)(?:\(|:)/u.exec(line);
  assert.ok(match, `manifest line has no tool name: ${line}`);
  return match[1]!;
};

test("the manifest is generated from exactly the tools the contract exposes", () => {
  assert.deepEqual(
    manifestLines().map(toolNameFromManifest),
    SESSION_TOOLS.map((tool) => tool.name),
  );
  assert.equal(SESSION_TOOLS.length, 10);
});

test("requestFor owns every session control-plane request shape", () => {
  const credentials = { fencingToken: "fence-1", commitSha: "a".repeat(40), requestIdPrefix: "mcp:run-1" };
  assert.deepEqual(requestFor("task_activity_log", { body: "Progress", metadata: { phase: "review" } }, credentials), {
    method: "POST",
    path: "/activity",
    body: { fencingToken: "fence-1", actorType: "agent", body: "Progress", metadata: { phase: "review" } },
  });
  assert.deepEqual(requestFor("task_output", { kind: "result", body: "Done" }, credentials), {
    method: "PUT",
    path: "/output",
    body: { fencingToken: "fence-1", kind: "result", body: "Done", commitSha: "a".repeat(40) },
  });
  assert.deepEqual(requestFor("task_status", {}, credentials), { method: "GET", path: "/status" });
  assert.deepEqual(requestFor("task_patch", { description: "Updated file references." }, credentials), {
    method: "PATCH",
    path: "/task",
    body: { fencingToken: "fence-1", description: "Updated file references." },
  });
  assert.deepEqual(requestFor("inbox_ask", {
    body: "Ship?",
    choices: [{ id: "yes", label: "Yes" }, { id: "", label: "Dropped" }],
  }, credentials), {
    method: "POST",
    path: "/inbox/questions",
    body: {
      fencingToken: "fence-1",
      requestId: "mcp:run-1:Ship?",
      body: "Ship?",
      choices: [{ id: "yes", label: "Yes" }],
    },
  });
  assert.deepEqual(requestFor("revalidation_cancel", {}, credentials), {
    method: "POST",
    path: "/revalidation/cancel",
    body: { fencingToken: "fence-1" },
  });
  assert.throws(() => requestFor("task_patch", {}, credentials), /task_patch requires description/u);
  assert.deepEqual(requestFor("files_list", { dir: "" }, credentials), {
    method: "GET", path: "/files", query: { dir: "" },
  });
  assert.deepEqual(requestFor("files_read", { path: "reports/a b.md" }, credentials), {
    method: "GET", path: "/files/content", query: { path: "reports/a b.md" },
  });
  assert.deepEqual(requestFor("files_write", { path: "binary.bin", content: "AA==", encoding: "base64" }, credentials), {
    method: "PUT", path: "/files/content", body: { path: "binary.bin", content: "AA==", encoding: "base64" },
  });
  assert.deepEqual(requestFor("files_delete", { path: "empty" }, credentials), {
    method: "DELETE", path: "/files", query: { path: "empty" },
  });
  assert.throws(() => requestFor("task_output", { kind: "result", body: "Done" }, { fencingToken: "fence-1" }), /commitSha/u);
  assert.throws(() => requestFor("unknown", {}, credentials), /Unknown tool unknown/u);
});

type RegisteredPiTool = {
  name: SessionToolName;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};

type Received = { method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> };

const normalizedRequest = (runId: string, request: SessionToolRequest): Received => ({
  method: request.method,
  path: `/session/runs/${runId}${request.path}`,
  query: { ...request.query },
  ...(request.body ? { body: { ...request.body } } : {}),
});

test("the dependency-free PI adapter inlines the canonical definitions and request shapes", async () => {
  const source = readFileSync(piExtension, "utf8");
  for (const specifier of source.matchAll(/from\s+"([^"]+)"/gu)) {
    assert.match(specifier[1]!, /^node:/u, `PI extension runtime import ${specifier[1]}`);
  }

  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const url = new URL(request.url ?? "", "http://local");
      received.push({
        method: request.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        ...(body ? { body: JSON.parse(body) as Record<string, unknown> } : {}),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const environment = {
    AGENTOS_API_URL: process.env.AGENTOS_API_URL,
    AGENTOS_RUN_ID: process.env.AGENTOS_RUN_ID,
    AGENTOS_SESSION_TOKEN: process.env.AGENTOS_SESSION_TOKEN,
    AGENTOS_FENCING_TOKEN: process.env.AGENTOS_FENCING_TOKEN,
    AGENTOS_WORKSPACE_PATH: process.env.AGENTOS_WORKSPACE_PATH,
  };
  const runId = "run-pi-contract";
  const fencingToken = "fence-pi";
  const registered: RegisteredPiTool[] = [];
  const workspace = await mkdtemp(join(tmpdir(), "agentos-pi-workspace-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Anneal Test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "runner@agentos.local"], { cwd: workspace });
  await writeFile(join(workspace, "fixture.txt"), "fixture\n");
  execFileSync("git", ["add", "fixture.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  try {
    process.env.AGENTOS_API_URL = `http://127.0.0.1:${port}`;
    process.env.AGENTOS_RUN_ID = runId;
    process.env.AGENTOS_SESSION_TOKEN = "session-pi";
    process.env.AGENTOS_FENCING_TOKEN = fencingToken;
    process.env.AGENTOS_WORKSPACE_PATH = workspace;
    const loaded = await import(pathToFileURL(piExtension).href) as {
      default(pi: { registerTool(tool: RegisteredPiTool): void; on(): void }): void;
    };
    loaded.default({ registerTool: (tool) => registered.push(tool), on: () => undefined });

    assert.deepEqual(
      registered.map(({ name, label, description, parameters }) => ({ name, label, description, parameters })),
      SESSION_TOOLS.map(({ name, title, description, inputSchema }) => ({
        name, label: title, description, parameters: inputSchema,
      })),
    );

    const cases: Array<[SessionToolName, Record<string, unknown>]> = [
      ["task_activity_log", { body: "Progress", metadata: { phase: "test" } }],
      ["task_output", { kind: "result", body: "Done" }],
      ["task_status", {}],
      ["task_patch", { description: "Updated file references." }],
      ["inbox_ask", { body: "Continue?", choices: [{ id: "yes", label: "Yes" }] }],
      ["revalidation_cancel", {}],
      ["files_list", { dir: "reports" }],
      ["files_read", { path: "reports/a b.md" }],
      ["files_write", { path: "reports/out.txt", content: "ok" }],
      ["files_delete", { path: "reports/empty" }],
    ];
    for (const [name, params] of cases) {
      await registered.find((tool) => tool.name === name)!.execute("call-1", params);
    }
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
    assert.deepEqual(received, cases.map(([name, params]) => normalizedRequest(runId, requestFor(name, params, {
      fencingToken,
      ...(name === "task_output" ? { commitSha } : {}),
      ...(name === "inbox_ask" ? { requestIdPrefix: `pi:${runId}` } : {}),
    }))));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
