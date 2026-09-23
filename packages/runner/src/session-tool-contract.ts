export const SESSION_TOOL_TRANSPORTS = ["mcp-stdio", "pi-extension"] as const;

export type SessionToolTransport = typeof SESSION_TOOL_TRANSPORTS[number];

export type SessionToolName =
  | "task_activity_log"
  | "task_output"
  | "task_status"
  | "task_patch"
  | "inbox_ask"
  | "revalidation_cancel"
  | "files_list"
  | "files_read"
  | "files_write"
  | "files_delete";

export type SessionToolDefinition = Readonly<{
  name: SessionToolName;
  title: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  manifest: string;
}>;

export type SessionToolRequest = Readonly<{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Readonly<Record<string, unknown>>;
  query?: Readonly<Record<string, string>>;
}>;

export type SessionToolRequestCredentials = Readonly<{
  fencingToken: string;
  commitSha?: string;
  requestIdPrefix?: string;
}>;

export const SESSION_TOOLS: readonly SessionToolDefinition[] = Object.freeze([
  {
    name: "task_activity_log",
    title: "Append to the task activity log",
    description: "Record notable progress on the current Anneal task. This is the routine progress channel; it never interrupts a human.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "What happened, in one or two sentences." },
        metadata: { type: "object", description: "Optional structured detail stored alongside the entry.", additionalProperties: true },
      },
      required: ["body"],
      additionalProperties: false,
    },
    manifest: "- task_activity_log(body): record notable progress in the task activity log. Routine channel; never interrupts a human.",
  },
  {
    name: "task_output",
    title: "Persist the task output",
    description: "Persist this Step's deliverable as the Anneal task output. Later Steps in the Chain read it, and the Approval gate shows it to the human. Canonical Steps may require a phase-specific write sequence from the task contract. A rejected write changes nothing; never probe the contract with placeholder content. A closed final output may be immutable.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Output kind, e.g. spec, plan, review, result." },
        body: { type: "string", description: "The deliverable itself, in full." },
        metadata: { type: "object", description: "Optional structured detail, e.g. branch or commit.", additionalProperties: true },
      },
      required: ["kind", "body"],
      additionalProperties: false,
    },
    manifest: "- task_output(kind, body, metadata?): persist this Step's deliverable using the task's exact output contract. Rejected writes change nothing; never submit placeholder probes. Closed final outputs may be immutable.",
  },
  {
    name: "task_status",
    title: "Read the task and Run status",
    description: "Read the current Anneal task and Run: name, status, Approval gate, Run number and budget, branch, and whether an output has already been persisted.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    manifest: "- task_status(): read the current task and Run status, budget, branch, and whether an output exists.",
  },
  {
    name: "task_patch",
    title: "Revalidate the implementation brief",
    description: "Replace only the current bound chain's implementation brief. The server derives the target task and preserves its platform-authored prompt and output instructions; arbitrary task IDs and intent fields are not accepted.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "The refreshed descriptive brief, with intent and acceptance bars unchanged." },
      },
      required: ["description"],
      additionalProperties: false,
    },
    manifest: "- task_patch(description): replace the current bound chain's implementation brief; the server derives the target and preserves platform-authored instructions.",
  },
  {
    name: "inbox_ask",
    title: "Ask the human a question",
    description: "Ask the human a decision question through the Anneal Inbox. This SUSPENDS the Session until they answer, and the Session resumes in place with their reply. Start the body with a recommendation and one-sentence reason (or say what information is missing), list each option's consequence on its own line, then put background evidence last. With fixed choices, put the recommended choice first and end its label with `（推荐）`. Routine progress belongs in task_activity_log, not here.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "First line: `推荐：<choice id 或做法> —— <一句理由>`, or `无推荐：<缺什么信息>`. Then list each option's consequence on its own line; put background evidence last." },
        choices: {
          type: "array",
          description: "Optional fixed choices. Put the recommended choice first and append `（推荐）` to its label. Omit for a free-text question.",
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
    manifest: "- inbox_ask(body, choices?): ask the human. First line recommends a choice/action with one reason, or names missing information; next list option consequences one per line; background evidence comes last. Put a recommended fixed choice first and mark its label `（推荐）`. Suspends this Session until answered.",
  },
  {
    name: "revalidation_cancel",
    title: "Cancel the collapsed revalidation chain",
    description: "Cancel this bound revalidation Run after the operator chose 'cancel this chain' for a collapsed premise. The runner performs cleanup and terminalization; no task ID is accepted.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    manifest: "- revalidation_cancel(): cancel this bound revalidation chain after the operator selected 'cancel this chain'; the owning runner performs cleanup.",
  },
  {
    name: "files_list",
    title: "List files",
    description: "List one granted Files Root directory non-recursively.",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string", description: "Files-Root-relative POSIX directory path; empty means root." } },
      required: ["dir"],
      additionalProperties: false,
    },
    manifest: "- files_list(dir): list one Files Root directory non-recursively. Empty dir means the root. Requires a matching FilesystemGrant or returns 403.",
  },
  {
    name: "files_read",
    title: "Read a file",
    description: "Read one granted file; binary content is returned with encoding base64.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    manifest: "- files_read(path): read one file; binary content comes back with encoding base64. Requires a matching FilesystemGrant or returns 403.",
  },
  {
    name: "files_write",
    title: "Write a file",
    description: "Write one granted file, creating parent directories as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    manifest: "- files_write(path, content, encoding?): write one file, creating parent directories as needed. Requires a matching FilesystemGrant or returns 403.",
  },
  {
    name: "files_delete",
    title: "Delete a file",
    description: "Delete one granted file or empty directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    manifest: "- files_delete(path): delete one file or empty directory. Requires a matching FilesystemGrant or returns 403.",
  },
]);

export const manifestLines = (): readonly string[] => SESSION_TOOLS.map((tool) => tool.manifest);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const credential = (value: string | undefined, name: string, tool: SessionToolName): string => {
  if (!value) throw new Error(`${tool} requires session credential ${name}`);
  return value;
};

export const requestFor = (
  toolName: SessionToolName | string,
  rawArguments: Readonly<Record<string, unknown>>,
  credentials: SessionToolRequestCredentials,
): SessionToolRequest => {
  const tool = SESSION_TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Unknown tool ${toolName}`);

  if (tool.name === "task_activity_log") {
    const body = nonEmptyString(rawArguments.body);
    if (!body) throw new Error("task_activity_log requires a non-empty body");
    return {
      method: "POST",
      path: "/activity",
      body: {
        fencingToken: credentials.fencingToken,
        actorType: "agent",
        body,
        ...(rawArguments.metadata ? { metadata: asRecord(rawArguments.metadata) } : {}),
      },
    };
  }
  if (tool.name === "task_output") {
    const kind = nonEmptyString(rawArguments.kind);
    const body = nonEmptyString(rawArguments.body);
    if (!kind || !body) throw new Error("task_output requires kind and body");
    return {
      method: "PUT",
      path: "/output",
      body: {
        fencingToken: credentials.fencingToken,
        kind,
        body,
        commitSha: credential(credentials.commitSha, "commitSha", tool.name),
        ...(rawArguments.metadata ? { metadata: asRecord(rawArguments.metadata) } : {}),
      },
    };
  }
  if (tool.name === "task_status") return { method: "GET", path: "/status" };
  if (tool.name === "task_patch") {
    if (typeof rawArguments.description !== "string") throw new Error("task_patch requires description");
    return {
      method: "PATCH",
      path: "/task",
      body: { fencingToken: credentials.fencingToken, description: rawArguments.description },
    };
  }
  if (tool.name === "inbox_ask") {
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
        fencingToken: credentials.fencingToken,
        requestId: `${credential(credentials.requestIdPrefix, "requestIdPrefix", tool.name)}:${body.slice(0, 80)}`,
        body,
        choices,
      },
    };
  }
  if (tool.name === "revalidation_cancel") {
    return {
      method: "POST",
      path: "/revalidation/cancel",
      body: { fencingToken: credentials.fencingToken },
    };
  }
  if (tool.name === "files_list") {
    const dir = typeof rawArguments.dir === "string" ? rawArguments.dir : null;
    if (dir === null) throw new Error("files_list requires dir");
    return { method: "GET", path: "/files", query: { dir } };
  }
  if (tool.name === "files_read") {
    const path = nonEmptyString(rawArguments.path);
    if (!path) throw new Error("files_read requires path");
    return { method: "GET", path: "/files/content", query: { path } };
  }
  if (tool.name === "files_write") {
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
