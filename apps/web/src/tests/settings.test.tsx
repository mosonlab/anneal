import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ROUTES } from "../App";
import { ThemeCycleButton } from "../components/Shell";
import { RunnersProvider } from "../components/runner-status";
import { ApiError } from "../lib/api";
import type { Poll } from "../lib/hooks";
import { LocaleProvider } from "../lib/i18n";
import { storage } from "../lib/storage";
import { ThemeProvider } from "../lib/theme";
import type { Health, RunnersResponse, VersionInfo } from "../lib/types";
import { SecretsPage } from "../pages/Secrets";
import { SettingsContent, SettingsPage } from "../pages/Settings";

const idle = <T,>(overrides: Partial<Poll<T>> = {}): Poll<T> => ({
  data: null, error: null, loading: false, lastSuccessAt: null, reload: () => undefined, ...overrides,
});

const renderSettings = (health: Poll<Health> = idle<Health>(), version: Poll<VersionInfo> = idle<VersionInfo>()): string => renderToStaticMarkup(
  <ThemeProvider><LocaleProvider initialLocale="en">
    <SettingsContent runners={idle<RunnersResponse>()} health={health} version={version} />
  </LocaleProvider></ThemeProvider>,
);

const versionPayload = (overrides: Partial<VersionInfo> = {}): VersionInfo => ({
  service: "@anneal/api", version: "0.5.0", buildSha: "a".repeat(40), commit: "a".repeat(40),
  dirty: false, stamped: true, builtAt: new Date().toISOString(), ...overrides,
});

const runnerPayload = (diskFreeBytes = 1024 ** 3): RunnersResponse => ({
  checkedAt: new Date().toISOString(), online: 1, total: 1,
  daemons: [{
    runnerId: "runner-a", lastSeenAt: new Date().toISOString(), online: true, busy: true, activeRuns: 1,
    daemonVersion: "0.0.0", diskFreeBytes, pollIntervalMs: 5_000, workspaceRoot: "/tmp/runs",
  }],
  backends: [],
  dispatchDrain: null,
});

test("settings and secrets resolve to distinct pages", () => {
  const settings = ROUTES.find((route) => route.pattern === "/settings");
  const secrets = ROUTES.find((route) => route.pattern === "/secrets");
  assert.ok(settings && secrets);
  assert.equal((settings.render({}) as { type: unknown }).type, SettingsPage);
  assert.equal((secrets.render({}) as { type: unknown }).type, SecretsPage);
});

test("the four settings cards render complete missing states", () => {
  const markup = renderSettings();
  for (const title of ["Appearance", "Runner", "Product build", "Control plane"]) assert.match(markup, new RegExp(`>${title}<`));
  for (const field of ["Daemon version", "Disk free", "Workspace root", "CLI version", "Auth mode", "Last preflight", "Circuit reason"]) assert.match(markup, new RegExp(field));
  assert.ok((markup.match(/—/gu) ?? []).length >= 10);
});

test("the page never renders operator credentials", () => {
  const markup = renderSettings();
  assert.doesNotMatch(markup, /Bearer|OPERATOR_TOKEN|VITE_API_TOKEN/u);
  assert.match(markup, /<code>\/api<\/code>/);
});

test("a failed health poll keeps and renders its earlier success time", () => {
  const markup = renderSettings(idle<Health>({
    error: new ApiError(503, "/health", "down"),
    lastSuccessAt: new Date().toISOString(),
  }));
  assert.match(markup, /unreachable/);
  assert.match(markup, /Last successful poll[\s\S]*>(?:just )?now</);
});

test("the Settings runner card emphasizes online, Busy, and low disk independently", () => {
  const low = renderToStaticMarkup(
    <ThemeProvider><LocaleProvider initialLocale="en"><SettingsContent runners={idle<RunnersResponse>({ data: runnerPayload() })} health={idle<Health>()} version={idle<VersionInfo>()} /></LocaleProvider></ThemeProvider>,
  );
  assert.match(low, /data-runner-state="running"[\s\S]*?bg-\[color:var\(--status-green-fg\)\][\s\S]*?>Running</u);
  assert.match(low, /data-runner-busy=""[\s\S]*?>Busy</u);
  assert.match(low, /data-low-disk="" class="text-destructive">1\.0 GB/u);

  const high = renderToStaticMarkup(
    <ThemeProvider><LocaleProvider initialLocale="en"><SettingsContent runners={idle<RunnersResponse>({ data: runnerPayload(8 * 1024 ** 3) })} health={idle<Health>()} version={idle<VersionInfo>()} /></LocaleProvider></ThemeProvider>,
  );
  assert.doesNotMatch(high, /data-low-disk=""/u);
});

test("appearance controls share locale and theme stores with the sidebar", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "http://localhost/settings" });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  storage.remove("agentos.locale");
  storage.remove("agentos.theme");

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ThemeProvider><LocaleProvider>
        <SettingsContent runners={idle<RunnersResponse>()} health={idle<Health>()} version={idle<VersionInfo>()} />
        <ThemeCycleButton />
      </LocaleProvider></ThemeProvider>,
    ));
    const button = (label: string): HTMLButtonElement => {
      const match = [...dom.window.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(match, label);
      return match as HTMLButtonElement;
    };
    await act(async () => button("Dark").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.localStorage.getItem("agentos.theme"), "dark");
    assert.match(dom.window.document.body.textContent ?? "", /Theme: dark/);

    await act(async () => button("中文").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.localStorage.getItem("agentos.locale"), "zh");
    assert.match(dom.window.document.body.textContent ?? "", /设置/);
    assert.match(dom.window.document.body.textContent ?? "", /主题：深色/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

/**
 * Plan Step 6 on the Settings side: the starter this preview installs runs on
 * Codex, and a machine without Claude or Pi is not a broken installation. The
 * telemetry for those backends stays — it is the truth about them, and someone
 * does use them — but it is labelled with what it means here.
 */
const backendsPayload = (): RunnersResponse => ({
  ...runnerPayload(),
  backends: [
    { runner: "CLAUDE", cliVersion: null, authMode: null, lastPreflightAt: new Date().toISOString(), lastPreflightOk: false, circuitOpen: true, circuitReason: "cli-missing: the CLI did not answer --version (exit 127)" },
    { runner: "CODEX", cliVersion: "0.147.0", authMode: "chatgpt", lastPreflightAt: new Date().toISOString(), lastPreflightOk: true, circuitOpen: false, circuitReason: null },
    { runner: "PI", cliVersion: null, authMode: null, lastPreflightAt: null, lastPreflightOk: null, circuitOpen: null, circuitReason: null },
  ],
});

const renderRunners = (data: RunnersResponse): string => renderToStaticMarkup(
  <ThemeProvider><LocaleProvider initialLocale="en">
    <SettingsContent runners={idle<RunnersResponse>({ data })} health={idle<Health>()} version={idle<VersionInfo>()} freshnessNow={Date.now()} />
  </LocaleProvider></ThemeProvider>,
);

test("Settings says the starter is Codex-only and marks the other backends optional", () => {
  const markup = renderRunners(backendsPayload());
  assert.match(markup, /it runs on Codex/u);
  assert.match(markup, /data-backend="CODEX"[\s\S]*?data-backend-role="required"/u);
  for (const runner of ["CLAUDE", "PI"]) {
    assert.match(markup, new RegExp(`data-backend="${runner}"[\\s\\S]*?data-backend-role="optional"`, "u"), runner);
  }
});

test("a failed optional backend is telemetry, not an installation failure", () => {
  const markup = renderRunners(backendsPayload());
  // The failure is still shown — hiding it would lie to whoever does use Claude
  // — but as the class the control plane records, not as the CLI's own words:
  // this card is in every screenshot an operator sends.
  assert.match(markup, /The CLI did not answer/u);
  assert.doesNotMatch(markup, /--version \(exit 127\)/u);
  assert.match(markup, /does not block installation or runs/u);
  // And the gate itself reports the only backend that can block anything.
  assert.match(markup, /data-codex-state="ready"/u);
});

test("a failing Codex is the one backend Settings reports as blocking", () => {
  const payload = backendsPayload();
  const markup = renderRunners({
    ...payload,
    backends: payload.backends.map((backend) => backend.runner === "CODEX"
      ? { ...backend, lastPreflightOk: false, circuitOpen: true, circuitReason: "not-authenticated: the CLI's own login check did not pass (exit 1)" }
      : backend),
  });
  assert.match(markup, /data-codex-state="unauthenticated"/u);
  assert.match(markup, /codex login/u);
});

test("Settings reports the product build separately from the runner versions", () => {
  const markup = renderSettings(idle<Health>(), idle<VersionInfo>({ data: versionPayload() }));
  assert.match(markup, /data-build-state="ready"/u);
  for (const field of ["Version", "Build SHA", "Commit", "Built"]) assert.match(markup, new RegExp(`>${field}<`));
  assert.match(markup, new RegExp(`<code>${"a".repeat(40)}</code>`, "u"));
  assert.match(markup, />0\.5\.0</u);
  // The runner's own version is a different number about a different thing: it
  // stays the daemon card's empty value while the product build reports 0.5.0.
  assert.match(markup, /Daemon version<\/div><div [^>]*>—</u);
});

test("an unbuilt process reports itself as unbuilt rather than as an error", () => {
  const markup = renderSettings(idle<Health>(), idle<VersionInfo>({
    data: versionPayload({ version: null, buildSha: "unbuilt", commit: null, stamped: false, builtAt: null }),
  }));
  assert.match(markup, /data-build-state="ready"/u);
  assert.match(markup, /<code>unbuilt<\/code>/u);
  assert.match(markup, /runs from source/u);
  assert.doesNotMatch(markup, /Could not read the product build identity/u);
});

test("a dirty build says so, so a report is not attributed to a clean commit", () => {
  const markup = renderSettings(idle<Health>(), idle<VersionInfo>({
    data: versionPayload({ buildSha: `${"a".repeat(40)}-dirty`, dirty: true }),
  }));
  assert.match(markup, /uncommitted changes/u);
});

test("a failed version poll says so instead of showing a misleading identity", () => {
  const markup = renderSettings(idle<Health>(), idle<VersionInfo>({
    error: new ApiError(503, "/version", "down"),
  }));
  assert.match(markup, /data-build-state="error"/u);
  assert.match(markup, /Could not read the product build identity/u);
  assert.doesNotMatch(markup, /data-build-state="ready"/u);
  assert.doesNotMatch(markup, /unbuilt|unknown/u);
});

test("a transient version failure preserves the last good build identity", () => {
  const markup = renderSettings(idle<Health>(), idle<VersionInfo>({
    data: versionPayload(), error: new ApiError(503, "/version", "down"),
  }));
  assert.match(markup, /data-build-state="ready"/u);
  assert.match(markup, />0\.5\.0</u);
  assert.doesNotMatch(markup, /Could not read the product build identity/u);
});

test("the build card is loading until the first version response lands", () => {
  const markup = renderSettings(idle<Health>(), idle<VersionInfo>({ loading: true }));
  assert.match(markup, /data-build-state="loading"/u);
  assert.doesNotMatch(markup, /Could not read the product build identity/u);
});

test("SettingsPage polls the product version endpoint every 60 seconds", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "http://localhost/settings" });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  const requests: string[] = [];
  const intervals: number[] = [];
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string) => {
    const path = String(input);
    requests.push(path);
    const body = path.endsWith("/version")
      ? versionPayload()
      : path.endsWith("/runners")
        ? runnerPayload()
        : { status: "ok", database: "connected", checkedAt: new Date().toISOString() };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) } as Response;
  } });
  Object.defineProperty(dom.window, "setInterval", { configurable: true, value: (_run: () => void, every: number) => {
    intervals.push(every);
    return intervals.length;
  } });
  Object.defineProperty(dom.window, "clearInterval", { configurable: true, value: () => undefined });

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <RunnersProvider><ThemeProvider><LocaleProvider initialLocale="en"><SettingsPage /></LocaleProvider></ThemeProvider></RunnersProvider>,
    ));
    await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
    assert.equal(requests.filter((path) => path.endsWith("/version")).length, 1);
    assert.ok(intervals.includes(60_000));
    assert.match(dom.window.document.body.textContent ?? "", /Product build.*0\.5\.0/su);
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    dom.window.close();
  }
});
