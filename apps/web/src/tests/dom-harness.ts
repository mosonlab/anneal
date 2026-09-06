import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, type ReactElement } from "react";

/**
 * A jsdom the React DOM client believes in, and the client loaded against it.
 *
 * The order matters more than the contents. React DOM feature-detects the
 * `input` event once, when its module first loads, and when it decides it is not
 * running in a browser it falls back to a keyboard-and-selection polyfill. A
 * test file that imports `react-dom/client` at the top has already spent that
 * detection on an empty global scope, and every `input` event it dispatches
 * afterwards is dropped: the DOM node's value changes and the controlled
 * component's state does not, which reads exactly like a broken page. So the
 * globals go up first and `reactDom()` loads the client afterwards.
 */
export const installDom = (url = "http://127.0.0.1:5173/"): { dom: JSDOM; container: Element } => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url });
  for (const [key, value] of Object.entries({
    // `getComputedStyle` is read as a bare global by Radix's presence layer, so
    // a dialog mounted through a portal throws without it.
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement, HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    // React compares dispatched events against the *global* constructors, so a
    // window whose Event/InputEvent/MouseEvent are not the global ones has its
    // events silently ignored by the reconciler.
    Event: dom.window.Event, InputEvent: dom.window.InputEvent, MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent, FocusEvent: dom.window.FocusEvent,
    NodeFilter: dom.window.NodeFilter,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  // jsdom has no scroll box, and `navigate` scrolls to the top of every new
  // route. Without this the router's ordinary behaviour prints a jsdom
  // not-implemented error over the test output.
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  return { dom, container };
};

let client: Promise<typeof import("react-dom/client")> | null = null;

/** The React DOM client, loaded no earlier than the first `installDom`. */
export const reactDom = async (): Promise<typeof import("react-dom/client")> => {
  assert.ok(globalThis.document !== undefined, "installDom() runs before reactDom()");
  client ??= import("react-dom/client");
  return await client;
};

export type PageRequest = {
  input: string | URL | Request;
  init: RequestInit;
  method: string;
  path: string;
  requestIndex: number;
  routeIndex: number;
};

export type PageRouteResult = Response | string | number | boolean | null | readonly unknown[] | { [key: string]: unknown };
export type PageRoute = PageRouteResult | ((request: PageRequest) => PageRouteResult | Promise<PageRouteResult>);
export type PageRoutes = Record<string, PageRoute>;
export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;

export type FetchHarness = {
  requests: PageRequest[];
  settle: () => Promise<void>;
  dispose: () => void;
};

export type PageHarness = FetchHarness & {
  dom: JSDOM;
  container: Element;
  press: (label: string) => Promise<void>;
  dispose: () => Promise<void>;
};

const descriptor = (key: PropertyKey): PropertyDescriptor | undefined =>
  Object.getOwnPropertyDescriptor(globalThis, key);

const restore = (key: PropertyKey, previous: PropertyDescriptor | undefined): void => {
  if (previous === undefined) Reflect.deleteProperty(globalThis, key);
  else Object.defineProperty(globalThis, key, previous);
};

const requestPath = (input: string | URL | Request): string => {
  const address = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
  const location = globalThis.window?.location.href;
  const base = location?.startsWith("http://") || location?.startsWith("https://") ? location : "http://127.0.0.1/";
  const url = new URL(address, base);
  const path = `${url.pathname}${url.search}`;
  return path.startsWith("/api/") ? path.slice(4) : path;
};

const routeKeys = (method: string, path: string): string[] => {
  const pathname = path.split("?", 1)[0]!;
  return [`${method} ${path}`, path, `${method} ${pathname}`, pathname, "*"];
};

const responseFrom = (value: unknown): Response => {
  if (value instanceof Response || (
    typeof value === "object" && value !== null && "ok" in value && "status" in value &&
    "text" in value && typeof value.text === "function"
  )) return value as Response;
  return Response.json(value);
};

/**
 * Installs the test-side fetch seam and observes when its work becomes quiet.
 *
 * Route keys are a path, `METHOD path`, or `*`; paths are relative to `/api`.
 * Values are JSON responses unless the route returns a `Response` itself.
 */
export const installFetch = (routes: PageRoutes): FetchHarness => {
  const previousFetch = descriptor("fetch");
  const requests: PageRequest[] = [];
  const routeCounts = new Map<string, number>();
  const observedResponses = new WeakSet<object>();
  let activity = 0;
  let disposed = false;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: string | URL | Request, suppliedInit?: RequestInit): Promise<Response> => {
      const init = suppliedInit ?? (input instanceof Request ? {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: input.signal,
      } : {});
      const method = (init.method ?? "GET").toUpperCase();
      const path = requestPath(input);
      const routeKey = routeKeys(method, path).find((key) => Object.hasOwn(routes, key));
      assert.ok(routeKey, `unhandled fetch route: ${method} ${path}`);
      const routeIndex = (routeCounts.get(routeKey) ?? 0) + 1;
      routeCounts.set(routeKey, routeIndex);
      const request = { input, init, method, path, requestIndex: requests.length + 1, routeIndex };
      requests.push(request);
      activity += 1;
      try {
        const route = routes[routeKey];
        const response = responseFrom(typeof route === "function" ? await route(request) : route);
        if (!observedResponses.has(response)) {
          observedResponses.add(response);
          for (const name of ["text", "json", "arrayBuffer", "blob", "formData"] as const) {
            const bodyReader = response[name];
            if (typeof bodyReader !== "function") continue;
            Object.defineProperty(response, name, {
              configurable: true,
              value: async () => {
                activity += 1;
                try {
                  return await bodyReader.call(response);
                } finally {
                  activity += 1;
                }
              },
            });
          }
        }
        return response;
      } finally {
        activity += 1;
      }
    },
  });

  return {
    requests,
    settle: async () => {
      let previousActivity: number | null = null;
      let quiet = 0;
      for (let guard = 0; guard < 100; guard += 1) {
        // Turns of the task queue, not just a microtask drain: jsdom delivers
        // `hashchange` from a queued task and React schedules a render off one,
        // so work started by a click is still ahead of any number of resolved
        // promises. Quiet is only quiet once it holds across two of them.
        await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
        await act(async () => { await new Promise((resolve) => { setImmediate(resolve); }); });
        quiet = activity === previousActivity ? quiet + 1 : 0;
        if (quiet === 2) return;
        previousActivity = activity;
      }
      assert.fail("fetch did not become quiet after 100 observed state changes");
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      restore("fetch", previousFetch);
    },
  };
};

/** Adapts a protocol-level fetch double for tests that exercise the client itself. */
export const installFetchFunction = (implementation: FetchImplementation): FetchHarness =>
  installFetch({ "*": ({ input, init }) => implementation(input, init) });

/** Runs work with a fetch route table and always restores the global seam. */
export const withFetch = async <T>(routes: PageRoutes, work: (fetch: FetchHarness) => Promise<T>): Promise<T> => {
  const harness = installFetch(routes);
  try {
    return await work(harness);
  } finally {
    harness.dispose();
  }
};

/** Mounts an element and returns it only after fetch and DOM activity is quiet. */
export const mountPage = async (
  element: ReactElement,
  routes: PageRoutes,
  url = "http://127.0.0.1:5173/",
  prepareDom?: (dom: JSDOM) => void,
): Promise<PageHarness> => {
  const globalKeys = [
    "window", "document", "navigator", "getComputedStyle", "HTMLElement", "HTMLButtonElement", "HTMLFormElement",
    "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "Event", "InputEvent", "MouseEvent",
    "CustomEvent", "KeyboardEvent", "FocusEvent", "NodeFilter",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previousGlobals = new Map(globalKeys.map((key) => [key, descriptor(key)]));
  const { dom, container } = installDom(url);
  prepareDom?.(dom);
  const fetch = installFetch(routes);
  const root = (await reactDom()).createRoot(container);
  let mutations = 0;
  let disposed = false;
  const observer = new dom.window.MutationObserver(() => { mutations += 1; });
  observer.observe(container, { attributes: true, childList: true, characterData: true, subtree: true });

  const settle = async (): Promise<void> => {
    let previousSnapshot: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      await fetch.settle();
      const snapshot = `${fetch.requests.length}:${mutations}`;
      if (snapshot === previousSnapshot) return;
      previousSnapshot = snapshot;
    }
    assert.fail("page did not become quiet after 100 observed state changes");
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await act(async () => root.unmount());
    } finally {
      observer.disconnect();
      fetch.dispose();
      dom.window.close();
      for (const key of globalKeys) restore(key, previousGlobals.get(key));
    }
  };

  try {
    await act(async () => root.render(element));
    await settle();
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    dom,
    container,
    requests: fetch.requests,
    settle,
    press: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find((node) => (
        node.textContent?.trim() === label || node.getAttribute("aria-label") === label
      ));
      assert.ok(button, `missing button ${label}: ${container.innerHTML}`);
      await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
      await settle();
    },
    dispose,
  };
};
