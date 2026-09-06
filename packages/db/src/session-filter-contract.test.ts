import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SessionExecutionStatus } from "@prisma/client";

import {
  hasSessionListFilters,
  NO_SESSION_FILTERS,
  parseSessionListFilters,
  SESSION_FILTER_PARAMETERS,
  SESSION_FILTER_REFUSAL_CODES,
  SESSION_STATUS_EXECUTION_STATUSES,
  SESSION_STATUS_FILTERS,
  sessionListFilterParams,
  sessionStatusMatches,
  type SessionListFilters,
  type SessionStatusFilter,
} from "./session-filter-contract.js";

const source = readFileSync(fileURLToPath(new URL("./session-filter-contract.ts", import.meta.url)), "utf8");

const reader = (query: Record<string, string>) => (parameter: string): string | null =>
  Object.hasOwn(query, parameter) ? query[parameter]! : null;

const filters = (overrides: Partial<SessionListFilters> = {}): SessionListFilters =>
  ({ ...NO_SESSION_FILTERS, ...overrides });

test("the browser-safe filter contract imports only types", () => {
  const runtimeSpecifiers = [
    ...source.matchAll(/(?:^|\n)\s*import(?!\s+type\b)[^;]*?from\s+"([^"]+)"/gu),
    ...source.matchAll(/(?:^|\n)\s*import\s+"([^"]+)"/gu),
    ...source.matchAll(/(?:^|\n)\s*export(?!\s+type\b)[^;]*?from\s+"([^"]+)"/gu),
    ...source.matchAll(/\brequire\s*\(\s*"([^"]+)"/gu),
    ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/gu),
  ].map((match) => match[1]);
  assert.deepEqual(runtimeSpecifiers, []);
});

test("the package publishes the session filter contract as an isolated subpath", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.deepEqual(manifest.exports["./session-filter-contract"], {
    types: "./src/session-filter-contract.ts",
    development: "./src/session-filter-contract.ts",
    import: "./dist/session-filter-contract.js",
  });
});

test("the status mapping partitions every execution status exactly once", () => {
  const mapped = SESSION_STATUS_FILTERS.flatMap((filter) => [...SESSION_STATUS_EXECUTION_STATUSES[filter]]);
  assert.equal(new Set(mapped).size, mapped.length, "a status may belong to only one bucket");
  assert.deepEqual([...mapped].sort(), Object.values(SessionExecutionStatus).sort());
});

test("sessionStatusMatches answers from the mapping and nothing else", () => {
  for (const status of Object.values(SessionExecutionStatus)) {
    const matching = SESSION_STATUS_FILTERS.filter((filter) => sessionStatusMatches(status, filter));
    assert.equal(matching.length, 1, `${status} matched ${matching.join(", ")}`);
    assert.ok(SESSION_STATUS_EXECUTION_STATUSES[matching[0] as SessionStatusFilter].includes(status));
  }
});

test("an empty query parses to no filters at all", () => {
  const parsed = parseSessionListFilters(reader({}));
  assert.deepEqual(parsed.filters, NO_SESSION_FILTERS);
  assert.equal(hasSessionListFilters(NO_SESSION_FILTERS), false);
});

test("every filter parses, normalizes its instants, and round-trips to a query", () => {
  const parsed = parseSessionListFilters(reader({
    status: "failed", agentId: "agent-1", runner: "CODEX", taskId: "task-1", chainId: "chain-1",
    since: "2026-08-16T00:00:00Z", until: "2026-08-17T12:30:00.000+02:00", q: "  Branch  ",
  }));
  assert.deepEqual(parsed.filters, {
    status: "failed", agentId: "agent-1", runner: "CODEX", taskId: "task-1", chainId: "chain-1",
    since: "2026-08-16T00:00:00.000Z", until: "2026-08-17T10:30:00.000Z", q: "Branch",
  });
  assert.ok(hasSessionListFilters(parsed.filters!));
  assert.deepEqual(
    sessionListFilterParams(parsed.filters!),
    [
      ["status", "failed"], ["agentId", "agent-1"], ["runner", "CODEX"], ["taskId", "task-1"],
      ["chainId", "chain-1"], ["since", "2026-08-16T00:00:00.000Z"], ["until", "2026-08-17T10:30:00.000Z"],
      ["q", "Branch"],
    ],
  );
  assert.deepEqual(sessionListFilterParams(filters({ q: "x" })), [["q", "x"]]);
});

test("an unusable value refuses with the code named for its parameter", () => {
  const cases: Array<[Record<string, string>, keyof typeof SESSION_FILTER_REFUSAL_CODES]> = [
    [{ status: "running" }, "status"],
    [{ status: "" }, "status"],
    [{ runner: "CLAUDE_CODE" }, "runner"],
    [{ runner: "claude" }, "runner"],
    [{ since: "not-a-date" }, "since"],
    [{ until: "yesterday" }, "until"],
    [{ agentId: "   " }, "agentId"],
    [{ taskId: "" }, "taskId"],
    [{ chainId: " " }, "chainId"],
    [{ q: "" }, "q"],
    [{ since: "0" }, "since"],
    [{ until: "August 16, 2026" }, "until"],
    [{ since: "2026-02-31T00:00:00Z" }, "since"],
  ];
  for (const [query, parameter] of cases) {
    const parsed = parseSessionListFilters(reader(query));
    assert.equal(parsed.filters, undefined, JSON.stringify(query));
    assert.equal(parsed.refusal?.parameter, parameter, JSON.stringify(query));
    assert.equal(parsed.refusal?.code, SESSION_FILTER_REFUSAL_CODES[parameter]);
    assert.ok((parsed.refusal?.message.length ?? 0) > 0);
  }
});

test("every parameter has exactly one refusal code and no code is shared", () => {
  const codes = SESSION_FILTER_PARAMETERS.map((parameter) => SESSION_FILTER_REFUSAL_CODES[parameter]);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(Object.keys(SESSION_FILTER_REFUSAL_CODES).sort(), [...SESSION_FILTER_PARAMETERS].sort());
});

test("long free text remains searchable", () => {
  assert.equal(parseSessionListFilters(reader({ q: "x".repeat(201) })).filters?.q?.length, 201);
});
