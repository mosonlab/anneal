/** Anneal MCP server (stdio).
 *
 *  Spawned by the CLI the runner starts, not by the runner itself, so it never
 *  sees a token the agent does not already hold: credentials arrive through the
 *  inherited child environment (AGENTOS_API_URL / AGENTOS_SESSION_TOKEN /
 *  AGENTOS_RUN_ID / AGENTOS_FENCING_TOKEN) and never through argv, where any
 *  local process could read them.
 *
 *  Hand-rolled JSON-RPC rather than the MCP SDK: the runner package ships with
 *  no runtime dependencies, and the surface here is ten tools. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { requestFor, SESSION_TOOLS, type SessionToolRequest } from "./session-tool-contract.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);
const SERVER_INFO = { name: "agentos", title: "Anneal", version: "1.0.0" };

export type SessionCredentials = {
  apiUrl: string;
  runId: string;
  sessionToken: string;
  fencingToken: string;
  workspacePath: string;
};

const credentialsFile = (argv: string[]): Record<string, unknown> => {
  const at = argv.indexOf("--credentials");
  const path = at >= 0 ? argv[at + 1] : undefined;
  if (!path) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
};

/**
 * Credentials come from the environment where the CLI passes it through (claude,
 * pi) and from a 0600 file next to the workspace where it does not: codex spawns
 * MCP servers with a scrubbed environment (only PATH/HOME/USER survive). The
 * file path is safe in argv; the tokens themselves never are.
 */
export const readCredentials = (environment: NodeJS.ProcessEnv, argv: string[] = []): SessionCredentials => {
  const file = argv.length > 0 ? credentialsFile(argv) : {};
  const apiUrl = environment.AGENTOS_API_URL ?? asString(file.apiUrl) ?? undefined;
  const runId = environment.AGENTOS_RUN_ID ?? asString(file.runId) ?? undefined;
  const sessionToken = environment.AGENTOS_SESSION_TOKEN ?? asString(file.sessionToken) ?? undefined;
  const fencingToken = environment.AGENTOS_FENCING_TOKEN ?? asString(file.fencingToken) ?? undefined;
  const workspacePath = environment.AGENTOS_WORKSPACE_PATH ?? asString(file.workspacePath) ?? undefined;
  const missing = [
    ...(apiUrl ? [] : ["AGENTOS_API_URL"]),
    ...(runId ? [] : ["AGENTOS_RUN_ID"]),
    ...(sessionToken ? [] : ["AGENTOS_SESSION_TOKEN"]),
    ...(fencingToken ? [] : ["AGENTOS_FENCING_TOKEN"]),
    ...(workspacePath ? [] : ["AGENTOS_WORKSPACE_PATH"]),
  ];
  if (missing.length > 0) throw new Error(`Anneal MCP server is missing ${missing.join(", ")}`);
  return {
    apiUrl: apiUrl!.replace(/\/$/, ""),
    runId: runId!,
    sessionToken: sessionToken!,
    fencingToken: fencingToken!,
    workspacePath: workspacePath!,
  };
};

const workspaceHead = (credentials: SessionCredentials): string => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: credentials.workspacePath,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head)) {
    throw new Error(`Workspace HEAD is not a commit SHA: ${head}`);
  }
  return head;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const asString = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;

export const TOOLS = SESSION_TOOLS.map(({ name, title, description, inputSchema }) => ({
  name, title, description, inputSchema,
}));

const call = async (
  credentials: SessionCredentials,
  request: SessionToolRequest,
): Promise<unknown> => {
  const url = new URL(`/session/runs/${credentials.runId}${request.path}`, credentials.apiUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: request.method,
    headers: { Authorization: `Bearer ${credentials.sessionToken}`, "Content-Type": "application/json" },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Anneal API ${response.status}: ${text.slice(0, 500)}`);
  return text.length > 0 ? JSON.parse(text) as unknown : null;
};

export const invokeTool = async (
  credentials: SessionCredentials,
  name: string,
  rawArguments: Record<string, unknown>,
): Promise<ToolResult> => {
  const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
  const request = requestFor(name, rawArguments, {
    fencingToken: credentials.fencingToken,
    ...(name === "task_output" ? { commitSha: workspaceHead(credentials) } : {}),
    ...(name === "inbox_ask" ? { requestIdPrefix: `mcp:${credentials.runId}` } : {}),
  });
  const taskOutputCommitSha = name === "task_output" ? request.body?.commitSha : null;
  if (name === "task_output" && typeof taskOutputCommitSha !== "string") {
    throw new Error("task_output request omitted commitSha");
  }
  const result = await call(credentials, request);
  if (name === "task_activity_log") {
    return text("Activity recorded.");
  }
  if (name === "task_output") {
    const body = rawArguments.body as string;
    const kind = rawArguments.kind as string;
    const persisted = result as { predecessorOutputs?: unknown } | null;
    const predecessorOutputs = persisted?.predecessorOutputs;
    return text([
      `Output persisted as '${kind}' (${body.length} characters).`,
      ...(Array.isArray(predecessorOutputs) && predecessorOutputs.length > 0
        ? ["Predecessor step outputs are now available:", JSON.stringify(predecessorOutputs, null, 2)]
        : []),
    ].join("\n\n"));
  }
  if (name === "task_status") {
    return text(JSON.stringify(result, null, 2));
  }
  if (name === "task_patch" || name === "revalidation_cancel") {
    return text(JSON.stringify(result, null, 2));
  }
  if (name === "inbox_ask") {
    return text("Question sent. This session is suspended until the human answers; you will resume with their reply.");
  }
  if (name === "files_list") {
    return text(JSON.stringify(result, null, 2));
  }
  if (name === "files_read") {
    return text(JSON.stringify(result, null, 2));
  }
  if (name === "files_write") {
    return text(JSON.stringify(result, null, 2));
  }
  if (name === "files_delete") {
    return text(JSON.stringify(result, null, 2));
  }
  throw new Error(`Unknown tool ${name}`);
};

const write = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

export const handleRequest = async (
  credentials: SessionCredentials,
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | null> => {
  const isNotification = request.id === undefined || request.id === null;
  const respond = (result: Record<string, unknown>): Record<string, unknown> | null =>
    isNotification ? null : { id: request.id, result };
  if (request.method === "initialize") {
    const requested = asString(asRecord(request.params).protocolVersion);
    return respond({
      protocolVersion: requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: "Anneal control plane for the current task: log progress, persist the deliverable, read status, ask the human.",
    });
  }
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return null;
  if (request.method === "ping") return respond({});
  if (request.method === "tools/list") return respond({ tools: TOOLS });
  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    const name = asString(params.name) ?? "";
    try {
      return respond(await invokeTool(credentials, name, asRecord(params.arguments)) as unknown as Record<string, unknown>);
    } catch (error: unknown) {
      // Tool failures are results, not protocol errors: the model must see them.
      return respond({
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
  }
  if (isNotification) return null;
  return { id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
};

export const serve = (credentials: SessionCredentials, input: NodeJS.ReadableStream): void => {
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write({ id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      void handleRequest(credentials, request)
        .then((message) => { if (message) write(message); })
        .catch((error: unknown) => {
          if (request.id === undefined || request.id === null) return;
          write({ id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        });
    }
  });
};

// `node dist/mcp-server.js` is the command the CLIs are configured to spawn;
// importing this module from a test must not start reading stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(readCredentials(process.env, process.argv.slice(2)), process.stdin);
}
