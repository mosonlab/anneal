import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { ApiError, REQUEST_TIMEOUT_MS, api } from "../lib/api";
import { installFetchFunction } from "./dom-harness";

/**
 * Every control-plane request is bounded.
 *
 * `fetch` has no timeout: a socket that is accepted and then never answered
 * leaves the promise pending forever, which is how an API restart overlapping
 * the first load turned into a permanent Loading screen. The bound lives in the
 * client rather than in each caller, so a page cannot forget it.
 */
type Call = { url: string; init: RequestInit };

const withFetch = async (
  answer: (call: Call) => Promise<Response>,
  work: () => Promise<void>,
): Promise<Call[]> => {
  const calls: Call[] = [];
  const fetchHarness = installFetchFunction(async (url, init = {}) => {
      const call = { url: String(url), init };
      calls.push(call);
      return await answer(call);
  });
  try {
    await work();
  } finally {
    fetchHarness.dispose();
  }
  return calls;
};

const ok = async (): Promise<Response> => new Response("{}", { status: 200 });

/** What `AbortSignal.timeout` rejects the fetch with once the bound expires. */
const timedOutFetch = async (): Promise<Response> => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

test("the bound is a real interval, and one an operator would wait through", () => {
  assert.ok(Number.isFinite(REQUEST_TIMEOUT_MS));
  assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 30_000, `${REQUEST_TIMEOUT_MS}ms is not a bound anyone waits through`);
});

test("every request carries the abort signal that enforces the bound", async () => {
  const calls = await withFetch(ok, async () => {
    await api.get("/projects");
    await api.poll("/tasks?view=board", null);
    await api.post("/tasks/t1/retry", {});
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal, `${call.url} was sent unbounded`);
    assert.equal(call.init.signal.aborted, false, "the signal fires on the bound, not before the request");
  }
});

test("a request abandoned on the bound is an ApiError that says so, not an opaque DOMException", async () => {
  await withFetch(timedOutFetch, async () => {
    await assert.rejects(() => api.get("/projects"), (reason: unknown) => {
      assert.ok(reason instanceof ApiError);
      // Nothing answered, so there is no status to report — 0 is the client's
      // own "no answer", the same one a refused connection uses.
      assert.equal(reason.status, 0);
      assert.equal(reason.timedOut, true);
      assert.match(reason.message, /15s/u);
      return true;
    });
  });
});

test("a poll is bounded on the same terms as any other request", async () => {
  await withFetch(timedOutFetch, async () => {
    await assert.rejects(() => api.poll("/tasks?view=board", 'W/"a"'), (reason: unknown) => {
      assert.ok(reason instanceof ApiError);
      assert.equal(reason.timedOut, true);
      return true;
    });
  });
});

test("an aborted poll is cancellation rather than a timeout", async () => {
  const controller = new AbortController();
  await withFetch(async ({ init }) => {
    const signal = init.signal;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, async () => {
    const pending = api.poll("/tasks?view=board", null, controller.signal);
    controller.abort();
    await assert.rejects(pending, (reason: unknown) => {
      assert.ok(reason instanceof Error);
      assert.equal(reason.name, "AbortError");
      assert.equal(reason instanceof ApiError, false);
      return true;
    });
  });
});

test("an ordinary transport failure is not reported as a timeout", async () => {
  await withFetch(async () => { throw new TypeError("Failed to fetch"); }, async () => {
    await assert.rejects(() => api.get("/projects"), (reason: unknown) => {
      assert.ok(reason instanceof ApiError);
      assert.equal(reason.status, 0);
      assert.equal(reason.timedOut, false);
      assert.equal(reason.message, "Failed to fetch");
      return true;
    });
  });
});

/**
 * The live half: the failure this whole change exists for, against a real
 * socket rather than a mocked one.
 *
 * The observed outage was not a refused connection — the dev proxy accepted it
 * and then nothing came back (ETIMEDOUT at 05:09, an API restart at 05:23). A
 * server that accepts and never answers is what `AbortSignal.timeout` has to
 * survive, and `TimeoutError` is the exact name the client keys on to tell that
 * apart from an ordinary transport failure. The bound here is 300ms rather than
 * `REQUEST_TIMEOUT_MS` because the property is the rejection, not the interval.
 */
test("a server that accepts the connection and never answers rejects as TimeoutError", async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/projects`, { signal: AbortSignal.timeout(300) }),
      (reason: unknown) => {
        assert.ok(reason instanceof Error);
        assert.equal(reason.name, "TimeoutError", "the client's timeout branch reads this name");
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});

test("a response that sends headers and then stalls its body is translated to a timed-out ApiError", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: () => originalTimeout(100),
  });
  const fetchHarness = installFetchFunction((_url, init = {}) => originalFetch(`http://127.0.0.1:${port}/projects`, init));
  try {
    await assert.rejects(() => api.get("/projects"), (reason: unknown) => {
      assert.ok(reason instanceof ApiError);
      assert.equal(reason.status, 0);
      assert.equal(reason.timedOut, true);
      return true;
    });
  } finally {
    fetchHarness.dispose();
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout });
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});
