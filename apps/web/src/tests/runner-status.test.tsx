import assert from "node:assert/strict";
import test from "node:test";
import type { JSDOM } from "jsdom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CodexReadinessNotice, codexReady, RunnerRow, RunnersProvider, RunnerStatusDetails, runnerSummary, useFreshnessClock, useRunners,
} from "../components/runner-status";
import { LocaleProvider } from "../lib/i18n";
import type { RunnersResponse } from "../lib/types";
import { installDom, installFetchFunction, reactDom } from "./dom-harness";

const now = new Date();
const payload = (overrides: Partial<RunnersResponse> = {}): RunnersResponse => ({
  checkedAt: now.toISOString(),
  online: 1,
  total: 1,
  daemons: [{
    runnerId: "runner-b", lastSeenAt: now.toISOString(), online: true, busy: true, activeRuns: 1,
    daemonVersion: "0.0.0", diskFreeBytes: 132.4 * 1024 ** 3, pollIntervalMs: 5_000, workspaceRoot: "/tmp/runs",
  }],
  backends: [
    { runner: "CLAUDE", cliVersion: "2.1.227", authMode: "subscription", lastPreflightAt: now.toISOString(), lastPreflightOk: true, circuitOpen: false, circuitReason: null },
    { runner: "CODEX", cliVersion: "0.147.0", authMode: "chatgpt", lastPreflightAt: now.toISOString(), lastPreflightOk: true, circuitOpen: false, circuitReason: null },
    { runner: "PI", cliVersion: null, authMode: null, lastPreflightAt: null, lastPreflightOk: null, circuitOpen: null, circuitReason: null },
  ],
  dispatchDrain: null,
  ...overrides,
});

const renderDetails = (data: RunnersResponse): string => renderToStaticMarkup(
  <LocaleProvider initialLocale="en"><RunnerStatusDetails payload={data} /></LocaleProvider>,
);

test("the popover renders the seven runner detail gaps", () => {
  const markup = renderDetails(payload());
  for (const expected of ["runner-b", "Busy", "Last heartbeat", "Daemon version 0.0.0", "Claude CLI 2.1.227", "Codex CLI 0.147.0", "Pi CLI —", "Disk free 132.4 GB", "Refreshes every 30s"]) {
    assert.match(markup, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), expected);
  }
});

test("Busy is present only for a busy daemon", () => {
  assert.match(renderDetails(payload()), />Busy</);
  const idle = payload({ daemons: [{ ...payload().daemons[0]!, busy: false, activeRuns: 0 }] });
  assert.doesNotMatch(renderDetails(idle), />Busy</);
  assert.doesNotMatch(renderDetails(idle), />Idle</);
});

test("never seen and offline are distinct summary states", () => {
  assert.equal(runnerSummary(payload({ online: 0, total: 0, daemons: [] }), now).state, "neverSeen");
  assert.equal(runnerSummary(payload({ online: 0, daemons: [{ ...payload().daemons[0]!, online: false, busy: false }] }), now).state, "offline");
});

test("missing daemon telemetry renders em dashes", () => {
  const markup = renderDetails(payload({ daemons: [{ ...payload().daemons[0]!, daemonVersion: null, diskFreeBytes: null }] }));
  assert.match(markup, /Daemon version —/);
  assert.match(markup, /Disk free —/);
});

test("low disk alone carries the destructive tone", () => {
  const low = renderDetails(payload({ daemons: [{ ...payload().daemons[0]!, diskFreeBytes: 1.2 * 1024 ** 3 }] }));
  const high = renderDetails(payload());
  assert.match(low, /text-destructive[^>]*>Disk free 1.2 GB/);
  assert.doesNotMatch(high, /text-destructive[^>]*>Disk free 132.4 GB/);
});

const withReason = (reason: string | null): RunnersResponse => payload({
  backends: payload().backends.map((backend) => backend.runner === "CODEX" ? { ...backend, circuitOpen: true, circuitReason: reason } : backend),
});

test("an open backend circuit shows its reason as a class this dictionary owns", () => {
  const data = withReason("not-authenticated: the CLI's own login check did not pass (exit 1)");
  assert.match(renderDetails(data), /The CLI is not signed in/);
  assert.equal(runnerSummary(data, now).tone, "amber");
  assert.match(renderDetails(withReason("Repeated authentication failures")), /Stopped after repeated sign-in failures/);
  assert.match(renderDetails(withReason("cli-missing: the CLI did not answer --version (exit 127)")), /The CLI did not answer/);
});

test("a reason this build does not recognise is reported as a circuit, not printed", () => {
  // The negative case for the whole boundary: an older daemon that still posts
  // the CLI's own stdout. Nothing about that string is bounded, so nothing
  // about it is rendered — not as text, and not in an attribute either, which
  // is where the retired `title` used to put it.
  // The home-directory path is assembled rather than written out: a literal one
  // is what `snapshot:scan` flags in public source, and a test about not
  // shipping private paths should not ship one.
  const home = ["", "Users", "someone", ".codex", "auth.json"].join("/");
  const leak = `OPENAI_API_KEY=sk-live-9 https://user:pw@example.test ${home}`;
  const markup = renderDetails(withReason(leak));
  assert.doesNotMatch(markup, /OPENAI_API_KEY|sk-live-9|user:pw/u);
  assert.ok(!markup.includes(home));
  assert.match(markup, /Circuit open/);
  // And it is still reported as trouble rather than silently dropped.
  assert.equal(runnerSummary(withReason(leak), now).tone, "amber");
});

test("a 90-second-old payload is unknown even when its daemon says online", () => {
  assert.deepEqual(runnerSummary(payload({ checkedAt: new Date(now.getTime() - 90_000).toISOString() }), now), { state: "unknown", tone: "grey" });
});

test("two daemon blocks are sorted and report two of two online", () => {
  const data = payload({
    online: 2, total: 2,
    daemons: [payload().daemons[0]!, { ...payload().daemons[0]!, runnerId: "runner-a", busy: false, activeRuns: 0 }],
  });
  const markup = renderDetails(data);
  assert.match(markup, /2 of 2 runner online/);
  assert.ok(markup.indexOf("runner-a") < markup.indexOf("runner-b"));
});

type Timer = { at: number; every: number | null; run: () => void };
const withProvider = async (
  respond: (path: string, count: number) => { ok: boolean; body: unknown },
  operation: (context: { dom: JSDOM; requests: string[]; advance: (ms: number) => Promise<void>; latest: () => ReturnType<typeof useRunners> }) => Promise<void>,
): Promise<void> => {
  const { dom, container } = installDom();

  const requests: string[] = [];
  const counts = new Map<string, number>();
  const fetchHarness = installFetchFunction(async (input) => {
    const path = String(input);
    requests.push(path);
    const count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    const response = respond(path, count);
    return {
      ok: response.ok,
      status: response.ok ? 200 : 503,
      headers: new Headers(),
      text: async () => JSON.stringify(response.body),
    } as Response;
  });

  let clock = now.getTime();
  let handle = 0;
  const timers = new Map<number, Timer>();
  const originalDateNow = Date.now;
  Object.defineProperty(Date, "now", { configurable: true, value: () => clock });
  Object.defineProperty(dom.window, "setInterval", { configurable: true, value: (run: () => void, every: number) => {
    handle += 1;
    timers.set(handle, { at: clock + every, every, run });
    return handle;
  } });
  Object.defineProperty(dom.window, "clearInterval", { configurable: true, value: (id: number) => timers.delete(id) });
  Object.defineProperty(dom.window, "setTimeout", { configurable: true, value: (run: () => void, delay: number) => {
    handle += 1;
    timers.set(handle, { at: clock + delay, every: null, run });
    return handle;
  } });
  Object.defineProperty(dom.window, "clearTimeout", { configurable: true, value: (id: number) => timers.delete(id) });

  let snapshot: ReturnType<typeof useRunners> | null = null;
  const Probe = () => { snapshot = useRunners(); return null; };
  const root = (await reactDom()).createRoot(container);
  const flush = fetchHarness.settle;
  const advance = async (ms: number): Promise<void> => {
    const target = clock + ms;
    for (let guard = 0; guard < 100; guard += 1) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      if (due[1].every === null) timers.delete(due[0]);
      else due[1].at += due[1].every;
      await act(async () => due[1].run());
      await flush();
    }
    clock = target;
  };

  try {
    await act(async () => root.render(<RunnersProvider><Probe /><Probe /><RunnerRow /></RunnersProvider>));
    await flush();
    await operation({ dom, requests, advance, latest: () => { assert.ok(snapshot); return snapshot; } });
  } finally {
    await act(async () => root.unmount());
    fetchHarness.dispose();
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    dom.window.close();
  }
};

test("two consumers still create one poll per path", async () => {
  await withProvider((path) => ({ ok: true, body: path.endsWith("/runners") ? payload() : { status: "ok", database: "connected", checkedAt: now.toISOString() } }), async ({ requests, advance }) => {
    await advance(89_999);
    assert.equal(requests.filter((path) => path.endsWith("/runners")).length, 3);
    assert.equal(requests.filter((path) => path.endsWith("/health")).length, 9);
  });
});

test("lastSuccessAt survives a later failed poll", async () => {
  await withProvider((path, count) => path.endsWith("/health") && count > 1
    ? { ok: false, body: { error: "down" } }
    : { ok: true, body: path.endsWith("/runners") ? payload() : { status: "ok", database: "connected", checkedAt: now.toISOString() } }, async ({ advance, latest }) => {
    const first = latest().health.lastSuccessAt;
    assert.ok(first);
    await advance(10_000);
    assert.equal(latest().health.lastSuccessAt, first);
    assert.ok(latest().health.error);
  });
});

test("a mounted runner row ages to Unknown while hidden and stays Unknown when visibility returns", async () => {
  await withProvider((path, count) => {
    if (path.endsWith("/runners") && count > 1) return { ok: false, body: { error: "unreachable" } };
    return { ok: true, body: path.endsWith("/runners") ? payload() : { status: "ok", database: "connected", checkedAt: now.toISOString() } };
  }, async ({ dom, advance }) => {
    // The row is a link to Settings (hover-only buttons are unreachable by touch).
    const rowState = (): string => dom.window.document.querySelector('a[href="#/settings"]')?.textContent ?? "";
    assert.match(rowState(), /Busy/);
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: true });
    await advance(60_001);
    assert.match(rowState(), /Unknown/);
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: false });
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    assert.match(rowState(), /Unknown/);
  });
});

/**
 * A timer is scheduled on the event loop's clock, which is not `Date.now()`, so
 * it can wake a millisecond before the deadline it was given. The tick that
 * wakes early reads the report as still fresh — and if that were the only tick
 * the page had, the verdict would sit on screen past its limit with nothing left
 * to correct it, which is the one thing this clock exists to prevent.
 */
test("a freshness tick that wakes before the deadline re-arms instead of passing the report as fresh", async () => {
  const { dom, container } = installDom();
  const checkedAt = new Date(now.getTime() - 30_000).toISOString();
  let clock = now.getTime();
  let handle = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const originalDateNow = Date.now;
  Object.defineProperty(Date, "now", { configurable: true, value: () => clock });
  Object.defineProperty(dom.window, "setTimeout", { configurable: true, value: (run: () => void, delay: number) => {
    handle += 1;
    timers.set(handle, { at: clock + delay, run });
    return handle;
  } });
  Object.defineProperty(dom.window, "clearTimeout", { configurable: true, value: (id: number) => timers.delete(id) });

  let observed = 0;
  const Probe = (): null => { observed = useFreshnessClock(checkedAt); return null; };
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    // The first wake lands one millisecond short; every later one is punctual.
    let early = 1;
    for (let guard = 0; guard < 5 && timers.size > 0; guard += 1) {
      const [id, timer] = [...timers.entries()][0]!;
      timers.delete(id);
      clock = timer.at - early;
      early = 0;
      await act(async () => timer.run());
    }
    assert.ok(observed - Date.parse(checkedAt) > 60_000, "the clock reached the far side of the deadline");
    assert.equal(timers.size, 0, "and stops once the report has nothing left to age into");
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    dom.window.close();
  }
});

/**
 * The tick's stored time and its decision to re-arm must come from one reading
 * of the clock. Reading `Date.now()` twice lets the deadline fall between the
 * two: the state keeps the earlier reading, which is still fresh, while the
 * later reading says the deadline is past and no replacement timer is needed —
 * and the report then sits fresh forever with no tick left to age it.
 */
test("a tick that crosses the deadline between two clock readings still ages the report", async () => {
  const { dom, container } = installDom();
  const checkedAt = new Date(now.getTime() - 30_000).toISOString();
  const deadline = Date.parse(checkedAt) + 60_001;
  // Time genuinely passes between reads, so a tick that reads the clock twice
  // can straddle the deadline.
  let clock = now.getTime();
  let handle = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const originalDateNow = Date.now;
  Object.defineProperty(Date, "now", { configurable: true, value: () => { const at = clock; clock += 1; return at; } });
  Object.defineProperty(dom.window, "setTimeout", { configurable: true, value: (run: () => void, delay: number) => {
    handle += 1;
    timers.set(handle, { at: clock + delay, run });
    return handle;
  } });
  Object.defineProperty(dom.window, "clearTimeout", { configurable: true, value: (id: number) => timers.delete(id) });

  let observed = 0;
  const Probe = (): null => { observed = useFreshnessClock(checkedAt); return null; };
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    // The first wake lands on the last millisecond before the deadline, so a
    // tick reading the clock twice sees `deadline - 1` and then `deadline`;
    // every later wake is punctual.
    let wakeAt: number | null = deadline - 1;
    for (let guard = 0; guard < 5 && timers.size > 0; guard += 1) {
      const [id, timer] = [...timers.entries()][0]!;
      timers.delete(id);
      clock = wakeAt ?? timer.at;
      wakeAt = null;
      await act(async () => timer.run());
    }
    assert.equal(timers.size, 0, "the clock stops once the report has nothing left to age into");
    assert.ok(observed - Date.parse(checkedAt) > 60_000, `the rendered time is past the deadline (${observed - deadline} ms)`);
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    dom.window.close();
  }
});

/* ------------------------------------------ Codex, the one v0.1 readiness gate */

/**
 * Plan Step 6: Codex is the only backend this preview requires, and the states
 * below exist because the operator's next action differs between them. A
 * verdict that collapsed "not installed" and "not signed in" would send half of
 * them to do the wrong thing, and one that called a silent daemon a failure
 * would send all of them to reinstall a working CLI.
 */
const codexBackend = (overrides: Partial<RunnersResponse["backends"][number]> = {}): RunnersResponse["backends"][number] => ({
  runner: "CODEX", cliVersion: "0.147.0", authMode: "chatgpt",
  lastPreflightAt: now.toISOString(), lastPreflightOk: true, circuitOpen: false, circuitReason: null, ...overrides,
});

const withCodex = (overrides: Partial<RunnersResponse["backends"][number]>, rest: Partial<RunnersResponse> = {}): RunnersResponse =>
  payload({ backends: [codexBackend(overrides), payload().backends[2]!], ...rest });

test("a passing Codex preflight on a live daemon is the only thing that reads ready", () => {
  assert.equal(codexReady(withCodex({}), now).state, "ready");
  assert.equal(codexReady(withCodex({}), now).cliVersion, "0.147.0");
});

test("Claude and Pi cannot make Codex unready, whatever they report", () => {
  // The whole point of the gate: an operator with no Claude CLI has a complete
  // installation, and a Pi circuit that is open is not this preview's problem.
  const others = payload({
    backends: [
      codexBackend(),
      { runner: "CLAUDE", cliVersion: null, authMode: null, lastPreflightAt: null, lastPreflightOk: null, circuitOpen: null, circuitReason: null },
      { runner: "PI", cliVersion: null, authMode: null, lastPreflightAt: now.toISOString(), lastPreflightOk: false, circuitOpen: true, circuitReason: "pi CLI missing" },
    ],
  });
  assert.equal(codexReady(others, now).state, "ready");
});

test("a failed preflight with no version is a missing CLI, and with one is a sign-in", () => {
  // The adapter reads `--version` first and only then the login, so the version
  // it managed to record is what separates the two.
  assert.equal(codexReady(withCodex({ lastPreflightOk: false, circuitOpen: true, cliVersion: null, circuitReason: "CLI missing" }), now).state, "missing");
  assert.equal(codexReady(withCodex({ lastPreflightOk: false, circuitOpen: true, circuitReason: "Not logged in" }), now).state, "unauthenticated");
});

test("a passing preflight the control plane has stopped dispatching to is not ready", () => {
  const blocked = codexReady(withCodex({ circuitOpen: true, circuitReason: "Repeated authentication failures" }), now);
  assert.equal(blocked.state, "blocked");
  // The version is carried; the reason is not. `CodexReadiness` is rendered, and
  // what a backend reported about its own failure is not this type's to hold.
  assert.equal(blocked.cliVersion, "0.147.0");
  assert.ok(!("detail" in blocked));
});

test("silence is pending, never a failure: no payload, a stale one, no daemon, no preflight", () => {
  assert.equal(codexReady(null, now).state, "pending");
  assert.equal(codexReady(withCodex({}, { checkedAt: new Date(now.getTime() - 90_000).toISOString() }), now).state, "pending");
  assert.equal(codexReady(withCodex({}, { daemons: [{ ...payload().daemons[0]!, online: false }] }), now).state, "pending");
  assert.equal(codexReady(withCodex({ lastPreflightAt: null, lastPreflightOk: null }), now).state, "pending");
  assert.equal(codexReady(payload({ backends: [payload().backends[2]!] }), now).state, "pending");
});

test("an old preflight on a live daemon still reads ready, because it is only run at startup", () => {
  // Ageing the preflight out would block every operator whose runner has been up
  // a while. What would invalidate the verdict — a sign-out — arrives by another
  // route: a run that fails authentication clears `lastPreflightOk`.
  const yesterday = new Date(now.getTime() - 26 * 3_600_000).toISOString();
  assert.equal(codexReady(withCodex({ lastPreflightAt: yesterday }), now).state, "ready");
});

test("the readiness copy tells an operator what to do and never a credential", () => {
  for (const [state, expected] of [["missing", /Install the official Codex CLI/u], ["unauthenticated", /codex login/u], ["pending", /Waiting for the local runner/u]] as const) {
    const markup = renderToStaticMarkup(
      <LocaleProvider initialLocale="en"><CodexReadinessNotice readiness={{ state, cliVersion: null }} /></LocaleProvider>,
    );
    assert.match(markup, expected, state);
    assert.match(markup, new RegExp(`data-codex-state="${state}"`, "u"));
    assert.doesNotMatch(markup, /token|Bearer|OPENAI_API_KEY|password/iu, state);
  }
});

/**
 * The wire is not the type.
 *
 * `RunnersResponse` is a cast over parsed JSON, so every field in it is a claim
 * made by whatever control plane happens to be running — which, on a machine
 * that updates one half at a time, is not necessarily this build's. A selector
 * written as "not explicitly false" reads a record it does not understand as a
 * pass. So the positive verdict is stated as a complete tuple and everything
 * else, including shapes nobody has thought of, lands on `pending`.
 */
const malformed = (mutate: (backend: Record<string, unknown>) => void, rest: Partial<RunnersResponse> = {}): RunnersResponse => {
  const backend: Record<string, unknown> = { ...codexBackend() };
  mutate(backend);
  return { ...payload(), backends: [backend], ...rest } as unknown as RunnersResponse;
};

test("no malformed or version-skewed record reads ready", () => {
  const soon = new Date(now.getTime() + 300_000).toISOString();
  const cases: [string, RunnersResponse][] = [
    ["lastPreflightOk omitted", malformed((backend) => { delete backend.lastPreflightOk; })],
    ["circuitOpen omitted", malformed((backend) => { delete backend.circuitOpen; })],
    ["lastPreflightOk undefined", malformed((backend) => { backend.lastPreflightOk = undefined; })],
    ["circuitOpen undefined", malformed((backend) => { backend.circuitOpen = undefined; })],
    ["lastPreflightOk as a string", malformed((backend) => { backend.lastPreflightOk = "true"; })],
    ["circuitOpen as a number", malformed((backend) => { backend.circuitOpen = 0; })],
    ["cliVersion as a number", malformed((backend) => { backend.cliVersion = 147; })],
    ["cliVersion missing on a passing preflight", malformed((backend) => { backend.cliVersion = null; })],
    ["lastPreflightAt unparseable", malformed((backend) => { backend.lastPreflightAt = "whenever"; })],
    ["lastPreflightAt from the future", malformed((backend) => { backend.lastPreflightAt = soon; })],
    ["runner named in another case", malformed((backend) => { backend.runner = "codex"; })],
    ["checkedAt unparseable", malformed(() => undefined, { checkedAt: "whenever" })],
    ["checkedAt from the future", malformed(() => undefined, { checkedAt: soon })],
    ["backends not an array", malformed(() => undefined, { backends: null as unknown as RunnersResponse["backends"] })],
    ["daemons not an array", malformed(() => undefined, { daemons: null as unknown as RunnersResponse["daemons"] })],
    ["online reported as a string", malformed(() => undefined, { daemons: [{ ...payload().daemons[0]!, online: "true" as unknown as boolean }] })],
  ];
  for (const [label, data] of cases) assert.equal(codexReady(data, now).state, "pending", label);
  // Contradiction is not pending — it is a control plane that has stopped
  // dispatching, which the operator is told about — but it is never ready.
  assert.equal(codexReady(malformed((backend) => { backend.circuitOpen = true; }), now).state, "blocked");
});

/**
 * The shell has one readiness colour, and after Step 6 it means Codex.
 *
 * The v0.1 target machine is Codex healthy, no Claude, no Pi. An all-backend
 * amber paints that complete installation as something to go and fix, which is
 * the exact reading Step 6 removes — the optional backends' telemetry stays in
 * Settings, where it is labelled as optional.
 */
test("an optional backend's failure cannot colour the shell's readiness", () => {
  const target = payload({
    backends: [
      codexBackend(),
      { runner: "CLAUDE", cliVersion: null, authMode: null, lastPreflightAt: now.toISOString(), lastPreflightOk: false, circuitOpen: true, circuitReason: "cli-missing: the CLI did not answer --version (exit 127)" },
      { runner: "PI", cliVersion: null, authMode: null, lastPreflightAt: now.toISOString(), lastPreflightOk: false, circuitOpen: true, circuitReason: "unsupported-model: an explicit provider/model is required" },
    ],
  });
  assert.deepEqual(runnerSummary(target, now), { state: "busy", tone: "green" });
  // And the required one still does colour it, by either route.
  assert.equal(runnerSummary(withCodex({ circuitOpen: true }), now).tone, "amber");
  assert.equal(runnerSummary(withCodex({ lastPreflightOk: false }), now).tone, "amber");
  // A backend that has never reported is not a failure: `null` is not `false`.
  assert.equal(runnerSummary(payload({ backends: [payload().backends[2]!] }), now).tone, "green");
});
