/** Anneal tools for pi.
 *
 *  pi deliberately ships no MCP client ("It intentionally does not include
 *  built-in MCP..."), so the same ten Anneal tools are registered as pi
 *  extension tools instead. The runner injects this file with `--extension`;
 *  credentials come from the inherited environment, exactly as the MCP server
 *  reads them, so the tool surface matches across all three CLIs.
 *
 *  Loaded by pi's own loader, not compiled by the runner's tsc — keep it
 *  dependency-free and self-contained. SessionToolContract is inlined here at
 *  build time; session-tool-contract.test.ts checks the inlined adapter against
 *  the canonical definitions and request shapes. */

import { execFileSync } from "node:child_process";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
type ToolName = "task_activity_log" | "task_output" | "task_status" | "task_patch" | "inbox_ask" | "revalidation_cancel"
  | "files_list" | "files_read" | "files_write" | "files_delete";
type ToolRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
};

const SESSION_TOOLS: ReadonlyArray<{
  name: ToolName;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}> = [
  {
    name: "task_activity_log",
    label: "Append to the task activity log",
    description: "Record notable progress on the current Anneal task. This is the routine progress channel; it never interrupts a human.",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "What happened, in one or two sentences." },
        metadata: { type: "object", description: "Optional structured detail stored alongside the entry.", additionalProperties: true },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "task_output",
    label: "Persist the task output",
    description: "Persist this Step's deliverable as the Anneal task output. Later Steps in the Chain read it, and the Approval gate shows it to the human. Canonical Steps may require a phase-specific write sequence from the task contract. A rejected write changes nothing; never probe the contract with placeholder content. A closed final output may be immutable.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Output kind, e.g. spec, plan, review, result." },
        body: { type: "string", description: "The deliverable itself, in full." },
        metadata: { type: "object", description: "Optional structured detail, e.g. branch or commit.", additionalProperties: true },
      },
      required: ["kind", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "task_status",
    label: "Read the task and Run status",
    description: "Read the current Anneal task and Run: name, status, Approval gate, Run number and budget, branch, and whether an output has already been persisted.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "task_patch",
    label: "Revalidate the implementation brief",
    description: "Replace only the current bound chain's implementation brief. The server derives the target task and preserves its platform-authored prompt and output instructions; arbitrary task IDs and intent fields are not accepted.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "The refreshed descriptive brief, with intent and acceptance bars unchanged." },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  {
    name: "inbox_ask",
    label: "Ask the human a question",
    description: "Ask the human a question through the Anneal Inbox. This SUSPENDS the Session until they answer, and the Session resumes in place with their reply. Routine progress belongs in task_activity_log, not here.",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "The question, with enough context for a human to answer it cold." },
        choices: {
          type: "array",
          description: "Optional fixed choices. Omit for a free-text question.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "revalidation_cancel",
    label: "Cancel the collapsed revalidation chain",
    description: "Cancel this bound revalidation Run after the operator chose 'cancel this chain' for a collapsed premise. The runner performs cleanup and terminalization; no task ID is accepted.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "files_list",
    label: "List files",
    description: "List one granted Files Root directory non-recursively.",
    parameters: {
      type: "object",
      properties: { dir: { type: "string", description: "Files-Root-relative POSIX directory path; empty means root." } },
      required: ["dir"],
      additionalProperties: false,
    },
  },
  {
    name: "files_read",
    label: "Read a file",
    description: "Read one granted file; binary content is returned with encoding base64.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "files_write",
    label: "Write a file",
    description: "Write one granted file, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "files_delete",
    label: "Delete a file",
    description: "Delete one granted file or empty directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

const credentials = () => {
  const apiUrl = process.env.AGENTOS_API_URL;
  const runId = process.env.AGENTOS_RUN_ID;
  const sessionToken = process.env.AGENTOS_SESSION_TOKEN;
  const fencingToken = process.env.AGENTOS_FENCING_TOKEN;
  const workspacePath = process.env.AGENTOS_WORKSPACE_PATH;
  if (!apiUrl || !runId || !sessionToken || !fencingToken || !workspacePath) {
    throw new Error("Anneal session credentials are missing from this environment");
  }
  return { apiUrl: apiUrl.replace(/\/$/, ""), runId, sessionToken, fencingToken, workspacePath };
};

const workspaceHead = (): string => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: credentials().workspacePath,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head)) throw new Error(`Workspace HEAD is not a commit SHA: ${head}`);
  return head;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const requestFor = (tool: ToolName, rawArguments: Record<string, unknown>): ToolRequest => {
  const session = credentials();
  if (tool === "task_activity_log") {
    const body = nonEmptyString(rawArguments.body);
    if (!body) throw new Error("task_activity_log requires a non-empty body");
    return {
      method: "POST",
      path: "/activity",
      body: {
        fencingToken: session.fencingToken,
        actorType: "agent",
        body,
        ...(rawArguments.metadata ? { metadata: asRecord(rawArguments.metadata) } : {}),
      },
    };
  }
  if (tool === "task_output") {
    const kind = nonEmptyString(rawArguments.kind);
    const body = nonEmptyString(rawArguments.body);
    if (!kind || !body) throw new Error("task_output requires kind and body");
    return {
      method: "PUT",
      path: "/output",
      body: {
        fencingToken: session.fencingToken,
        kind,
        body,
        commitSha: workspaceHead(),
        ...(rawArguments.metadata ? { metadata: asRecord(rawArguments.metadata) } : {}),
      },
    };
  }
  if (tool === "task_status") return { method: "GET", path: "/status" };
  if (tool === "task_patch") {
    if (typeof rawArguments.description !== "string") throw new Error("task_patch requires description");
    return {
      method: "PATCH",
      path: "/task",
      body: { fencingToken: session.fencingToken, description: rawArguments.description },
    };
  }
  if (tool === "inbox_ask") {
    const body = nonEmptyString(rawArguments.body);
    if (!body) throw new Error("inbox_ask requires a non-empty body");
    const choices = Array.isArray(rawArguments.choices)
      ? rawArguments.choices.flatMap((choice) => {
        const record = asRecord(choice);
        const id = nonEmptyString(record.id);
        const label = nonEmptyString(record.label);
        return id && label ? [{ id, label }] : [];
      })
      : [];
    return {
      method: "POST",
      path: "/inbox/questions",
      body: {
        fencingToken: session.fencingToken,
        requestId: `pi:${session.runId}:${body.slice(0, 80)}`,
        body,
        choices,
      },
    };
  }
  if (tool === "revalidation_cancel") {
    return {
      method: "POST",
      path: "/revalidation/cancel",
      body: { fencingToken: session.fencingToken },
    };
  }
  if (tool === "files_list") {
    const dir = typeof rawArguments.dir === "string" ? rawArguments.dir : null;
    if (dir === null) throw new Error("files_list requires dir");
    return { method: "GET", path: "/files", query: { dir } };
  }
  if (tool === "files_read") {
    const path = nonEmptyString(rawArguments.path);
    if (!path) throw new Error("files_read requires path");
    return { method: "GET", path: "/files/content", query: { path } };
  }
  if (tool === "files_write") {
    const path = nonEmptyString(rawArguments.path);
    const content = typeof rawArguments.content === "string" ? rawArguments.content : null;
    const encoding = rawArguments.encoding === undefined ? "utf8" : rawArguments.encoding;
    if (!path || content === null || (encoding !== "utf8" && encoding !== "base64")) {
      throw new Error("files_write requires path, content, and optional encoding utf8 or base64");
    }
    return { method: "PUT", path: "/files/content", body: { path, content, encoding } };
  }
  const path = nonEmptyString(rawArguments.path);
  if (!path) throw new Error("files_delete requires path");
  return { method: "DELETE", path: "/files", query: { path } };
};

const call = async (request: ToolRequest): Promise<unknown> => {
  const session = credentials();
  const url = new URL(`${session.apiUrl}/session/runs/${session.runId}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: request.method,
    headers: { Authorization: `Bearer ${session.sessionToken}`, "Content-Type": "application/json" },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Anneal API ${response.status}: ${text.slice(0, 500)}`);
  return text.length > 0 ? JSON.parse(text) : null;
};

const said = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: {} });

const invokeTool = async (name: ToolName, params: Record<string, unknown>): Promise<ToolResult> => {
  const request = requestFor(name, params);
  const taskOutputCommitSha = name === "task_output" ? request.body?.commitSha : null;
  if (name === "task_output" && typeof taskOutputCommitSha !== "string") {
    throw new Error("task_output request omitted commitSha");
  }
  const result = await call(request);
  if (name === "task_activity_log") return said("Activity recorded.");
  if (name === "task_output") {
    const body = params.body as string;
    const kind = params.kind as string;
    const predecessorOutputs = (result as { predecessorOutputs?: unknown } | null)?.predecessorOutputs;
    return said([
      `Output persisted as '${kind}' (${body.length} characters).`,
      ...(Array.isArray(predecessorOutputs) && predecessorOutputs.length > 0
        ? ["Predecessor Step outputs are now available:", JSON.stringify(predecessorOutputs, null, 2)]
        : []),
    ].join("\n\n"));
  }
  if (name === "inbox_ask") {
    return said("Question sent. This Session is suspended until the human answers; the Session resumes with their reply.");
  }
  return said(JSON.stringify(result, null, 2));
};

export default function (pi: {
  registerTool(tool: Record<string, unknown>): void;
  on(
    event: "before_provider_request",
    handler: (
      event: { type: "before_provider_request"; payload: unknown },
      context: { model?: { provider?: string }; abort(): void; shutdown(): void },
    ) => unknown,
  ): void;
}): void {
  pi.on("before_provider_request", (event, context) => {
    const provider = context.model?.provider;
    const expectsOpenAICodex = process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX === "1";
    if (provider !== "openai-codex") {
      if (!expectsOpenAICodex) return undefined;
      context.abort();
      context.shutdown();
      return { service_tier: "agentos-provider-mismatch" };
    }
    const configured = process.env.AGENTOS_CODEX_SERVICE_TIER;
    if (configured !== "default" && configured !== "fast") {
      context.abort();
      context.shutdown();
      return { service_tier: "agentos-invalid-service-tier" };
    }
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      context.abort();
      context.shutdown();
      return { service_tier: "agentos-invalid-payload" };
    }
    return {
      ...event.payload,
      // The Responses API reports Fast as `priority`; the Anneal setting stays
      // `fast` because that is the operator-facing Codex config vocabulary.
      service_tier: configured === "fast" ? "priority" : "default",
    };
  });

  for (const tool of SESSION_TOOLS) {
    pi.registerTool({
      ...tool,
      promptSnippet: tool.description,
      async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
        return invokeTool(tool.name, params);
      },
    });
  }
}
