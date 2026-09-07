import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readMergeExecutorLiveness } from "./merge-executor-liveness.js";

const env = { OPERATOR_TOKEN: "test-token", MERGE_EXECUTOR_RUNNER_IDS: "executor", RUNNER_API_URL: "http://127.0.0.1:3000" };
const cases = JSON.parse(readFileSync(new URL("../../../scripts/fixtures/local-api-origin-cases.json", import.meta.url), "utf8")) as {
  accepted: { value: string }[]; rejected: { value: string | null; reason: string }[];
};
for (const entry of cases.rejected) {
  if (entry.value === null) continue;
  test(`Inbox refuses destination ${entry.reason}: ${entry.value}`, async () => {
    let calls = 0;
    const logs: string[] = [];
    const result = await readMergeExecutorLiveness({ env: { ...env, RUNNER_API_URL: entry.value! },
      fetch: async () => { calls++; throw new Error("must not fetch"); }, log: (reason) => logs.push(reason) });
    assert.deepEqual(result, { observation: "unreadable", cause: entry.reason });
    assert.equal(calls, 0);
    assert.deepEqual(logs, [entry.reason]);
  });
}
for (const entry of cases.accepted) {
  test(`Inbox accepts shared origin ${entry.value}`, async () => {
    const result = await readMergeExecutorLiveness({ env: { ...env, RUNNER_API_URL: entry.value },
      fetch: async (url, init) => {
        assert.equal(String(url), `${entry.value.trim()}/runners`);
        assert.equal(init?.redirect, "error");
        return Response.json({ daemons: [{ runnerId: "executor", online: true }] });
      } });
    assert.deepEqual(result, [{ runnerId: "executor", online: true }]);
  });
}
for (const [name, fetcher, cause] of [
  ["non-2xx", async () => new Response(null, { status: 503 }), "http-503"],
  ["timeout", async () => { throw new DOMException("timeout", "TimeoutError"); }, "unreachable"],
  ["unreachable", async () => { throw new Error("connection refused"); }, "unreachable"],
  ["invalid JSON", async () => new Response("not JSON"), "malformed"],
  ["missing daemons", async () => Response.json({}), "malformed"],
  ["malformed daemon", async () => Response.json({ daemons: [{ runnerId: "executor" }] }), "malformed"],
] as const) {
  test(`Inbox reports ${name}`, async () => {
    const logs: string[] = [];
    assert.deepEqual(await readMergeExecutorLiveness({ env, fetch: fetcher, log: (reason) => logs.push(reason) }),
      { observation: "unreadable", cause });
    assert.deepEqual(logs, [cause]);
  });
}
test("missing token refuses without fetching", async () => {
  assert.deepEqual(await readMergeExecutorLiveness({ env: { ...env, OPERATOR_TOKEN: undefined },
    fetch: async () => { throw new Error("must not fetch"); }, log: () => {} }),
  { observation: "unreadable", cause: "no-token" });
});
test("Inbox ignores the merge executor host origin and uses the local default", async () => {
  await readMergeExecutorLiveness({ env: { ...env, RUNNER_API_URL: undefined, MERGE_EXECUTOR_API_URL: "https://remote.invalid" },
    fetch: async (url) => { assert.equal(String(url), "http://127.0.0.1:3000/runners"); return Response.json({ daemons: [] }); } });
});
