import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import { ApiError, api } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { installDom, installFetchFunction, reactDom } from "./dom-harness";

type Call = { url: string; init: RequestInit };

/** Runs `work` against a scripted fetch and hands back what the client sent. */
const withFetch = async (
  responses: Array<{ status: number; body?: string; etag?: string | null }>,
  work: () => Promise<void>,
): Promise<Call[]> => {
  const calls: Call[] = [];
  let index = 0;
  const fetchHarness = installFetchFunction(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const scripted = responses[index++] ?? { status: 500 };
      const headers = new Headers();
      if (scripted.etag !== null && scripted.etag !== undefined) headers.set("ETag", scripted.etag);
      return new Response(scripted.status === 304 || scripted.status === 204 ? null : (scripted.body ?? ""), {
        status: scripted.status,
        headers,
      });
  });
  try {
    await work();
  } finally {
    fetchHarness.dispose();
  }
  return calls;
};

const sentTag = (call: Call): string | null =>
  new Headers(call.init.headers as HeadersInit | undefined).get("If-None-Match");

test("the first poll sends no validator and keeps the one it is given", async () => {
  let polled: Awaited<ReturnType<typeof api.poll>> | null = null;
  const calls = await withFetch([{ status: 200, body: "[1]", etag: 'W/"a"' }], async () => {
    polled = await api.poll("/tasks?view=board", null);
  });
  assert.equal(sentTag(calls[0]!), null);
  assert.deepEqual(polled, { changed: true, body: "[1]", etag: 'W/"a"' });
});

test("an unchanged poll costs a header exchange, not a payload", async () => {
  // The regression this exists for: 1.58 MB of identical board JSON, 24 times a
  // minute. A 304 carries no body at all, so there is nothing to parse, nothing
  // to compare and nothing to re-render.
  let polled: Awaited<ReturnType<typeof api.poll>> | null = null;
  const calls = await withFetch([{ status: 304, etag: 'W/"a"' }], async () => {
    polled = await api.poll("/tasks?view=board", 'W/"a"');
  });
  assert.equal(sentTag(calls[0]!), 'W/"a"');
  assert.deepEqual(polled, { changed: false, body: "", etag: 'W/"a"' });
});

test("a 304 without a repeated ETag keeps the validator the caller already held", async () => {
  // RFC 9110 lets a 304 omit the tag. Dropping it would send the next poll out
  // unconditional and pull the whole payload back for nothing.
  await withFetch([{ status: 304, etag: null }], async () => {
    assert.deepEqual(await api.poll("/tasks", 'W/"a"'), { changed: false, body: "", etag: 'W/"a"' });
  });
});

test("a control plane that mints no validator still polls, just without the saving", async () => {
  // The board must not break against an older control plane; it only loses the
  // 304. `usePoll`'s body comparison is what still saves the parse there.
  await withFetch([{ status: 200, body: "[1]", etag: null }], async () => {
    assert.deepEqual(await api.poll("/tasks", null), { changed: true, body: "[1]", etag: null });
  });
});

test("the browser cache is bypassed, so a replayed 200 cannot pose as a fresh one", async () => {
  const calls = await withFetch([{ status: 200, body: "[]", etag: 'W/"a"' }], async () => {
    await api.poll("/tasks", null);
  });
  assert.equal(calls[0]!.init.cache, "no-store");
});

test("a failed poll raises ApiError rather than a silent empty board", async () => {
  await withFetch([{ status: 503, body: '{"error":"down"}' }], async () => {
    await assert.rejects(() => api.poll("/tasks", 'W/"a"'), (reason: unknown) => {
      assert.ok(reason instanceof ApiError);
      assert.equal(reason.status, 503);
      assert.equal(reason.message, "down");
      return true;
    });
  });
});

test("a 204 is a change to nothing, not an unchanged poll", async () => {
  await withFetch([{ status: 204, etag: 'W/"e"' }], async () => {
    assert.deepEqual(await api.poll("/tasks", null), { changed: true, body: "", etag: 'W/"e"' });
  });
});

test("a pending poll is not repeated by the interval", async () => {
  const { dom, container } = installDom();
  const calls: RequestInit[] = [];
  const deferred: { release?: (response: Response) => void } = {};
  const fetchHarness = installFetchFunction(async (_url, init = {}) => {
    calls.push(init);
    const signal = init.signal;
    return await new Promise<Response>((resolve, reject) => {
      deferred.release = resolve;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  let tick: (() => void) | null = null;
  const originalSetInterval = dom.window.setInterval;
  const originalClearInterval = dom.window.clearInterval;
  Object.defineProperty(dom.window, "setInterval", { configurable: true, value: (run: () => void) => {
    tick = run;
    return 1;
  } });
  Object.defineProperty(dom.window, "clearInterval", { configurable: true, value: () => undefined });

  const observed: { snapshot?: ReturnType<typeof usePoll<string>> } = {};
  const Probe = (): null => { observed.snapshot = usePoll<string>("/tasks", 2_500); return null; };
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    assert.equal(calls.length, 1);
    await act(async () => tick?.());
    assert.equal(calls.length, 1, "the timer leaves the in-flight request alone");
    deferred.release?.(new Response(JSON.stringify("ready"), { status: 200 }));
    await fetchHarness.settle();
    assert.equal(observed.snapshot?.data, "ready");
    assert.equal(observed.snapshot?.loading, false);
  } finally {
    await act(async () => root.unmount());
    fetchHarness.dispose();
    Object.defineProperty(dom.window, "setInterval", { configurable: true, value: originalSetInterval });
    Object.defineProperty(dom.window, "clearInterval", { configurable: true, value: originalClearInterval });
    dom.window.close();
  }
});

test("unmount aborts a pending poll", async () => {
  const { dom, container } = installDom();
  const observed: { signal?: AbortSignal | null } = {};
  const fetchHarness = installFetchFunction(async (_url, init = {}) => {
    observed.signal = init.signal ?? null;
    const requestSignal = init.signal;
    return await new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
    });
  });
  const Probe = (): null => { usePoll<string>("/tasks", null); return null; };
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    assert.ok(observed.signal);
    await act(async () => root.unmount());
    assert.equal(observed.signal?.aborted, true, "cleanup aborts the request signal");
    await fetchHarness.settle();
  } finally {
    fetchHarness.dispose();
    dom.window.close();
  }
});

test("a hidden one-shot poll reads on the first return and does not repeat", async () => {
  const { dom, container } = installDom();
  Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: true });
  const calls: RequestInit[] = [];
  const fetchHarness = installFetchFunction(async (_url, init = {}) => {
    calls.push(init);
    return new Response(JSON.stringify("visible"), { status: 200 });
  });
  const observed: { snapshot?: ReturnType<typeof usePoll<string>> } = {};
  const Probe = (): null => { observed.snapshot = usePoll<string>("/tasks", null); return null; };
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    assert.equal(calls.length, 0, "the initial hidden read waits for visibility");
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: false });
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await fetchHarness.settle();
    assert.equal(calls.length, 1);
    assert.equal(observed.snapshot?.data, "visible");
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: true });
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: false });
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await fetchHarness.settle();
    assert.equal(calls.length, 1, "a completed one-shot poll stays one-shot");
  } finally {
    await act(async () => root.unmount());
    fetchHarness.dispose();
    dom.window.close();
  }
});

test("reload keeps the existing result visible while a replacement is pending", async () => {
  const { dom, container } = installDom();
  let calls = 0;
  const deferred: { release?: (response: Response) => void } = {};
  const fetchHarness = installFetchFunction(async (_url, init = {}) => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify("board"), { status: 200 });
    const signal = init.signal;
    return await new Promise<Response>((resolve, reject) => {
      deferred.release = resolve;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const observed: { snapshot?: ReturnType<typeof usePoll<string>> } = {};
  const Probe = (): null => { observed.snapshot = usePoll<string>("/tasks", null); return null; };
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    await fetchHarness.settle();
    assert.equal(observed.snapshot?.data, "board");
    assert.equal(observed.snapshot?.loading, false);
    await act(async () => observed.snapshot?.reload());
    assert.equal(calls, 2);
    assert.equal(observed.snapshot?.data, "board");
    assert.equal(observed.snapshot?.loading, false, "reload does not hide the existing board");
    deferred.release?.(new Response(JSON.stringify({ error: "down" }), { status: 503 }));
    await fetchHarness.settle();
    assert.equal(observed.snapshot?.data, "board");
    assert.equal(observed.snapshot?.error?.status, 503, "a failed refresh remains visible with the held board");
    assert.equal(observed.snapshot?.loading, false);
  } finally {
    await act(async () => root.unmount());
    fetchHarness.dispose();
    dom.window.close();
  }
});
