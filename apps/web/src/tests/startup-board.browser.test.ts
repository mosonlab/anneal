import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REQUEST_TIMEOUT_MS } from "../lib/api";
import { CARD_PAGE_SIZE } from "../lib/board";
import type { BoardTask } from "../lib/types";

const chromePath = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate): candidate is string => typeof candidate === "string" && existsSync(candidate));
const distRoot = fileURLToPath(new URL("../../dist/", import.meta.url));

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = async (): Promise<number> => {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    return Promise.race([
      response,
      new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`Chrome DevTools call timed out: ${method}`)), 10_000)),
    ]);
  }

  async value<T>(expression: string): Promise<T> {
    const result = await this.call<{ result: { value: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result.value;
  }
}

const connect = async (port: number, targetPrefix: string): Promise<{ cdp: Cdp; socket: WebSocket }> => {
  let endpoint = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then(async (response) => await response.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
      endpoint = targets.find((target) => target.type === "page" && target.url.startsWith(targetPrefix))?.webSocketDebuggerUrl ?? "";
      if (endpoint !== "") break;
    } catch {
      await wait(50);
    }
  }
  assert.notEqual(endpoint, "", "Chrome did not expose a page target");
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Chrome DevTools socket failed")), { once: true });
  });
  return { cdp: new Cdp(socket), socket };
};

const waitFor = async (cdp: Cdp, expression: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.value<boolean>(expression)) return;
    await wait(50);
  }
  throw new Error(`Browser condition timed out: ${expression}`);
};

const taskRow = (index: number): BoardTask => ({
  id: `done-${index}`, name: `Completed task ${index}`, displayName: `Completed task ${index}`,
  assigneeType: "HUMAN", createdAt: "2026-08-27T00:00:00.000Z",
  status: "DONE", failureReason: null, scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  approvalGate: false, templateId: null, source: "MANUAL", chainId: null, chainIndex: null,
  chainName: null, updatedAt: "2026-08-28T00:00:00.000Z", assigneeAgent: null,
  moveTargets: [], chainProgress: null, blockedOn: null, latestRun: null, taskCost: null, spendCapUsage: null,
  mergeOutcome: null, repairOf: null, budgetRemaining: true, leaseLossRefunds: 0, chainAggregate: null, readinessRequeues: 0, readinessGrants: 0, strandedSalvageBranches: [],
});

test("Chrome recovers from a bounded stalled startup and keeps large Tasks DOM work fixed", {
  skip: process.env.RUN_BROWSER_REGRESSION !== "1"
    ? "Set RUN_BROWSER_REGRESSION=1 after building the web app"
    : chromePath === undefined ? "Chrome is required for browser regression evidence" : false,
  timeout: REQUEST_TIMEOUT_MS + 45_000,
}, async () => {
  let firstProjects = true;
  let boardSize = CARD_PAGE_SIZE * 5;
  assert.ok(existsSync(join(distRoot, "index.html")), "build @anneal/web before running browser regression evidence");
  const webServer = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown): void => {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/projects" && firstProjects) {
      firstProjects = false;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.flushHeaders();
      return;
    }
    if (url.pathname === "/api/projects") return json([{ id: "browser-project", name: "Browser fixture", slug: "browser-fixture" }]);
    if (url.pathname === "/api/tasks") return json(Array.from({ length: boardSize }, (_, index) => taskRow(index)));
    if (url.pathname === "/api/inbox/messages/summary") return json({ needsReply: 0 });
    if (url.pathname.startsWith("/api/")) return json([]);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    const requestedPath = join(distRoot, safe);
    const path = existsSync(requestedPath) ? requestedPath : join(distRoot, "index.html");
    const type = ({ ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(path)] ?? "text/html";
    response.writeHead(200, { "Content-Type": type });
    response.end(readFileSync(path));
  });
  await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
  const webPort = (webServer.address() as AddressInfo).port;

  let chrome: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  const profile = mkdtempSync(join(tmpdir(), "agentos-browser-regression-"));
  try {
    const debugPort = await freePort();
    const started = Date.now();
    chrome = spawn(chromePath!, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1280,900",
      `http://127.0.0.1:${webPort}/#/tasks`,
    ], { stdio: "ignore" });
    const connected = await connect(debugPort, `http://127.0.0.1:${webPort}/`);
    socket = connected.socket;
    const cdp = connected.cdp;

    try {
      await waitFor(cdp, "document.querySelector('[data-startup-state=timeout]') !== null", REQUEST_TIMEOUT_MS + 5_000);
    } catch (reason: unknown) {
      const snapshot = {
        href: await cdp.value<string>("location.href"),
        html: await cdp.value<string>("document.body.innerHTML"),
        text: await cdp.value<string>("document.body.innerText"),
      };
      throw new Error(`${reason instanceof Error ? reason.message : String(reason)}; ${JSON.stringify(snapshot)}`);
    }
    assert.ok(Date.now() - started <= REQUEST_TIMEOUT_MS + 5_000, "startup did not leave Loading within its configured bound");
    assert.match(await cdp.value<string>("document.body.innerText"), /Try again/u);
    await cdp.value("[...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Try again'))?.click()");
    await waitFor(cdp, `document.querySelectorAll('[data-card]').length === ${CARD_PAGE_SIZE}`);
    const first = await cdp.value<{ cards: number; nodes: number }>(`({ cards: document.querySelectorAll('[data-card]').length, nodes: document.querySelectorAll('*').length })`);
    assert.equal(first.cards, CARD_PAGE_SIZE);

    boardSize = CARD_PAGE_SIZE * 20;
    await cdp.call("Page.reload", { ignoreCache: true });
    await waitFor(cdp, `document.querySelectorAll('[data-card]').length === ${CARD_PAGE_SIZE}`);
    const larger = await cdp.value<{ cards: number; nodes: number }>(`({ cards: document.querySelectorAll('[data-card]').length, nodes: document.querySelectorAll('*').length })`);
    assert.equal(larger.cards, CARD_PAGE_SIZE);
    assert.equal(larger.nodes, first.nodes, "larger completed history increased the Tasks DOM");
  } finally {
    socket?.close();
    chrome?.kill("SIGKILL");
    if (chrome?.exitCode === null) {
      await Promise.race([new Promise<void>((resolve) => chrome?.once("exit", () => resolve())), wait(2_000)]);
    }
    const webClosed = new Promise<void>((resolve) => webServer.close(() => resolve()));
    webServer.closeAllConnections();
    webServer.closeIdleConnections();
    await Promise.race([webClosed, wait(2_000)]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
