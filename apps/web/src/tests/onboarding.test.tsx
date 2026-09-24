import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { JSDOM } from "jsdom";
import type { ReactNode } from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../App";
import { LocaleProvider } from "../lib/i18n";
import { ThemeProvider } from "../lib/theme";
import { isValidBranchName, isValidSlug, remoteRejection, slugify, STARTER_MOUNT_PATH } from "../lib/onboarding";
import { storage } from "../lib/storage";
import { OnboardingPage, stepProblem } from "../pages/Onboarding";
import { mountPage } from "./dom-harness";

/**
 * The first-run wizard (plan Step 5; evidence rows E9/E10 on the browser side).
 *
 * Two things are being proven. The first is that an operator can install without
 * ever meeting the machinery: no endpoint, no id, no bearer token, no database
 * command appears in the copy. The second is that the browser cannot be the way
 * a credential gets stored — a remote carrying one is refused here, before the
 * only write this page can make.
 */
type Scripted = { status: number; body?: string } | { throws: true };

const casesPath = fileURLToPath(new URL("../../../../scripts/fixtures/onboarding-remote-cases.json", import.meta.url));

type RemoteCases = {
  accepted: Array<{ description: string; value: string }>;
  rejected: Array<{ description: string; value: string; reason: string }>;
};

const STATUS_BODY = JSON.stringify({
  complete: false,
  project: null,
  starter: { name: "default", title: "Starter", model: "gpt-5.6-sol:medium", runnerPreference: "CODEX" },
  disclosure: {
    environmentNetworking: "OPEN",
    filesystemGrantCreated: false,
    repoPermission: "GIT_WRITE",
    codexSandbox: "none",
    runsWithHostUserAuthority: true,
    supportedScope: "loopback-only",
    embeddedRemoteCredentialsRejected: true,
  },
});

/** What `GET /onboarding` answers once an installation exists — the shape Step 4
 *  made authoritative, and the one the wizard must believe over the empty
 *  project list that mounted it. */
const COMPLETED_BODY = JSON.stringify({
  complete: true,
  project: { id: "p-existing", name: "Existing", slug: "existing" },
  starter: { name: "default", title: "Starter", model: "gpt-5.6-sol:medium", runnerPreference: "CODEX" },
  disclosure: {
    environmentNetworking: "OPEN",
    filesystemGrantCreated: false,
    repoPermission: "GIT_WRITE",
    codexSandbox: "none",
    runsWithHostUserAuthority: true,
    supportedScope: "loopback-only",
    embeddedRemoteCredentialsRejected: true,
  },
});

/**
 * `GET /runners` with the one backend v0.1 requires in the state it requires.
 *
 * Step 6 makes Codex the sole readiness gate, so from here on the wizard reads
 * this endpoint and refuses to install without it. Claude is deliberately absent
 * and Pi deliberately failed: neither is allowed to matter.
 */
const runnersBody = (codex: Partial<{ cliVersion: string | null; lastPreflightAt: string | null; lastPreflightOk: boolean | null; circuitOpen: boolean | null; circuitReason: string | null }> = {}, rest: { online?: boolean; checkedAt?: string } = {}): string => {
  const at = new Date().toISOString();
  return JSON.stringify({
    checkedAt: rest.checkedAt ?? at,
    online: rest.online === false ? 0 : 1,
    total: 1,
    daemons: [{
      runnerId: "runner-a", lastSeenAt: at, online: rest.online !== false, busy: false, activeRuns: 0,
      daemonVersion: "0.0.0", diskFreeBytes: 100 * 1024 ** 3, pollIntervalMs: 5_000, workspaceRoot: "/tmp/runs",
    }],
    backends: [
      { runner: "CODEX", cliVersion: "0.147.0", authMode: "chatgpt", lastPreflightAt: at, lastPreflightOk: true, circuitOpen: false, circuitReason: null, ...codex },
      { runner: "PI", cliVersion: null, authMode: null, lastPreflightAt: at, lastPreflightOk: false, circuitOpen: true, circuitReason: "pi CLI missing" },
    ],
  });
};

const INSTALLATION_BODY = JSON.stringify({
  complete: true,
  project: { id: "p9", name: "Vibeville", slug: "vibeville" },
  environment: { id: "e9", name: "local", networking: "OPEN", allowedHosts: [] },
  agent: { id: "a9", name: "default", title: "Starter", model: "gpt-5.6-sol:medium", runnerPreference: "CODEX" },
  repo: { id: "r9", name: "app", defaultBranch: "main", mountPath: "repo" },
  access: { agentId: "a9", repoId: "r9", permissions: "GIT_WRITE", mountPath: "repo" },
});

type Wizard = {
  dom: JSDOM;
  posts: Array<Record<string, unknown>>;
  paths: string[];
  settle: () => Promise<void>;
  fill: (label: string, value: string) => Promise<void>;
  press: (label: string) => Promise<void>;
  check: (label: string) => Promise<void>;
  markup: () => string;
  disabled: (label: string) => boolean;
  /** Real elapsed time, inside `act`, so a timer the page scheduled for a
   *  freshness boundary actually fires and its re-render is flushed. */
  wait: (ms: number) => Promise<void>;
  /** `document.hidden`, which `usePoll` reads: a hidden tab is not polled, so it
   *  is the case where a verdict can only age out on its own. */
  visible: (value: boolean) => Promise<void>;
};

/** Mounts a subject against a scripted control plane and returns the handles a
 *  wizard walk-through needs. `projects` answers the gate; `post` answers the
 *  one write this page can make. */
const withWizard = async (
  subject: () => ReactNode,
  script: {
    projects?: Scripted[]; get?: Scripted; post?: Scripted[]; url?: string; runners?: Scripted;
    /** Stub out `window.setTimeout`, which is the only clock the page has. This
     *  is not a convenience: it is how the write path is tested on its own,
     *  with the rendered verdict deliberately left as stale as it can get. */
    freezeClock?: boolean;
  },
  walk: (wizard: Wizard) => Promise<void>,
): Promise<{ posts: Array<Record<string, unknown>>; paths: string[]; markup: string; hash: string }> => {
  const posts: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  let projectIndex = 0;
  let postIndex = 0;
  const answer = (scripted: Scripted | undefined, fallback: Scripted): Response => {
    const chosen = scripted ?? fallback;
    if ("throws" in chosen) throw new TypeError("Failed to fetch");
    return new Response(chosen.body ?? "", { status: chosen.status, headers: { "Content-Type": "application/json" } });
  };
  const page = await mountPage(
    <ThemeProvider><LocaleProvider initialLocale="en">{subject()}</LocaleProvider></ThemeProvider>,
    { "*": ({ input, init, method }) => {
    const path = String(input);
    paths.push(path);
    if (path === "/api/onboarding" && method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return answer(script.post?.[Math.min(postIndex++, (script.post?.length ?? 1) - 1)], { status: 201, body: INSTALLATION_BODY });
    }
    if (path === "/api/onboarding") return answer(script.get, { status: 200, body: STATUS_BODY });
    if (path === "/api/runners") return answer(script.runners, { status: 200, body: runnersBody() });
    if (path === "/api/projects") {
      // A poll repeats the bootstrap's last answer instead of advancing the
      // script: after the gate succeeds the provider is polling the same
      // control plane.
      const length = script.projects?.length ?? 1;
      const at = init.cache === "no-store" ? Math.max(0, projectIndex - 1) : projectIndex++;
      return answer(script.projects?.[Math.min(at, length - 1)], { status: 200, body: "[]" });
    }
    return new Response("[]", { status: 404 });
    } },
    script.url,
    script.freezeClock ? (dom) => {
      let frozen = 0;
      Object.defineProperty(dom.window, "setTimeout", { configurable: true, value: () => { frozen += 1; return frozen; } });
      Object.defineProperty(dom.window, "clearTimeout", { configurable: true, value: () => undefined });
    } : undefined,
  );
  const { dom } = page;
  const button = (label: string): HTMLButtonElement => {
    const found = [...dom.window.document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
    assert.ok(found, `no control labelled ${label}`);
    return found as HTMLButtonElement;
  };
  try {
    await walk({
      dom, posts, paths, settle: page.settle,
      markup: () => dom.window.document.body.innerHTML,
      disabled: (label) => button(label).hasAttribute("disabled"),
      fill: async (label, value) => {
        const field = [...dom.window.document.querySelectorAll("label")]
          .find((candidate) => candidate.textContent?.trim() === label)?.parentElement?.querySelector("input");
        assert.ok(field, `no field labelled ${label}`);
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
        assert.ok(setter);
        await act(async () => {
          setter.call(field, value);
          field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
      },
      press: async (label) => {
        await act(async () => button(label).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
        await page.settle();
      },
      check: async (label) => {
        await act(async () => button(label).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
        await page.settle();
      },
      wait: async (ms) => {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
        await page.settle();
      },
      visible: async (value) => {
        Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: !value });
        await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
        await page.settle();
      },
    });
    return { posts, paths, markup: dom.window.document.body.innerHTML, hash: dom.window.location.hash };
  } finally {
    await page.dispose();
  }
};

const ACKNOWLEDGEMENT = "I understand that the starter agent runs on this machine with my user's authority, without a sandbox, and may push to the repository I named.";

/** Fills every screen with a valid installation and stops on Confirm. */
const walkToConfirm = async (wizard: Wizard): Promise<void> => {
  await wizard.fill("Project name", "Vibeville");
  await wizard.press("Next");
  await wizard.press("Next");
  await wizard.fill("Repository name", "app");
  await wizard.fill("Remote", "https://github.com/owner/name.git");
  await wizard.press("Next");
  await wizard.press("Next");
};

/* ------------------------------------------------------- the shared contract */

test("the browser and the control plane agree on every remote in the shared table", () => {
  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as RemoteCases;
  assert.ok(cases.accepted.length > 0 && cases.rejected.length > 0);
  for (const accepted of cases.accepted) {
    assert.equal(remoteRejection(accepted.value), null, accepted.description);
  }
  for (const rejected of cases.rejected) {
    assert.equal(remoteRejection(rejected.value), rejected.reason, rejected.description);
  }
});

test("every rejection reason the table names has copy in both locales", () => {
  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as RemoteCases;
  const dictionary = readFileSync(fileURLToPath(new URL("../locales/en.ts", import.meta.url)), "utf8");
  const chinese = readFileSync(fileURLToPath(new URL("../locales/zh.ts", import.meta.url)), "utf8");
  for (const reason of new Set(cases.rejected.map((entry) => entry.reason))) {
    assert.match(dictionary, new RegExp(`"onboarding\\.remote\\.${reason}"`, "u"), reason);
    assert.match(chinese, new RegExp(`"onboarding\\.remote\\.${reason}"`, "u"), reason);
  }
});

test("the wizard's own validation refuses before a request can carry it", () => {
  const draft = { projectName: "Vibeville", projectSlug: "", repoName: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main" };
  assert.equal(stepProblem("repo", draft), null);
  assert.equal(stepProblem("repo", { ...draft, remoteUrl: "https://ghp_exampletoken@github.com/owner/name.git" }), "onboarding.remote.embedded-credentials");
  assert.equal(stepProblem("repo", { ...draft, remoteUrl: "ghp_exampletoken@github.com:owner/name.git" }), "onboarding.remote.unsupported-ssh-account");
  assert.equal(stepProblem("repo", { ...draft, remoteUrl: "\nhttps://github.com/owner/name.git" }), "onboarding.remote.control-characters");
  assert.equal(stepProblem("repo", { ...draft, defaultBranch: "bad branch" }), "onboarding.problem.branch");
  assert.equal(stepProblem("repo", { ...draft, repoName: "  " }), "onboarding.problem.repoName");
  assert.equal(stepProblem("project", { ...draft, projectName: "" }), "onboarding.problem.projectName");
  assert.equal(stepProblem("project", { ...draft, projectSlug: "Not A Slug" }), "onboarding.problem.projectSlug");
  // The two screens that ask nothing of the operator can never block on input.
  assert.equal(stepProblem("environment", draft), null);
  assert.equal(stepProblem("confirm", { ...draft, projectName: "" }), null);
  // Codex is the one thing the last two screens do insist on (plan Step 6), and
  // readiness can lapse between them — so the screen that writes checks too.
  for (const state of ["missing", "unauthenticated", "blocked", "pending"] as const) {
    assert.equal(stepProblem("starter", draft, state), "onboarding.problem.codex", state);
    assert.equal(stepProblem("confirm", draft, state), "onboarding.problem.codex", state);
  }
  assert.equal(stepProblem("starter", draft, "ready"), null);
  assert.equal(stepProblem("confirm", draft, "ready"), null);
  // And it is the *last* two only: a machine with no Codex can still be asked
  // for a project name.
  assert.equal(stepProblem("project", draft, "missing"), null);
});

test("a typed name becomes the slug the control plane accepts", () => {
  assert.equal(slugify("Vibe Ville!"), "vibe-ville");
  assert.ok(isValidSlug(slugify("Vibe Ville!")));
  assert.ok(!isValidSlug(""));
  assert.ok(isValidBranchName("main") && !isValidBranchName("feature branch"));
  assert.equal(STARTER_MOUNT_PATH, "repo");
});

/* ----------------------------------------------------------------- the copy */

test("the wizard copy names no endpoint, id, token or database command", () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider initialLocale="en"><OnboardingPage onInstalled={() => undefined} /></LocaleProvider>,
  );
  for (const forbidden of [/curl/iu, /OPERATOR_TOKEN/u, /Bearer/iu, /cuid/iu, /POST |GET \//u, /\/api\b/u, /prisma|psql|migrate/iu]) {
    assert.doesNotMatch(markup, forbidden, String(forbidden));
  }
});

test("the disclosure states host authority, open networking and no filesystem grant", async () => {
  const { markup } = await withWizard(() => <OnboardingPage onInstalled={() => undefined} />, {}, async (wizard) => {
    await walkToConfirm(wizard);
  });
  assert.match(markup, /OPEN/u);
  assert.match(markup, /GIT_WRITE/u);
  assert.match(markup, /None created/u);
  assert.match(markup, /Your own user/u);
  assert.match(markup, /no application sandbox|without a sandbox/u);
});

/* ------------------------------------------------------------- the wizard */

test("an empty control plane opens the wizard instead of an application with nothing in it", async () => {
  const { markup, paths } = await withWizard(() => <App />, { projects: [{ status: 200, body: "[]" }] }, async () => undefined);
  assert.match(markup, /Set up Anneal/u);
  // No Shell, no routed page, no runner row behind the wizard. The wizard does
  // read `/runners` itself from Step 6 on — that is the Codex readiness gate,
  // not a provider mounted behind the page — so what is asserted is the absence
  // of everything else the installed application polls.
  assert.doesNotMatch(markup, /data-runner-state=/u);
  assert.deepEqual([...new Set(paths)].filter((path) => !["/api/projects", "/api/onboarding", "/api/runners"].includes(path)), []);
});

test("Install stays refused until the acknowledgement is given", async () => {
  const { posts } = await withWizard(() => <OnboardingPage onInstalled={() => undefined} />, {}, async (wizard) => {
    await walkToConfirm(wizard);
    assert.ok(wizard.disabled("Install"), "Install is available before the disclosure is acknowledged");
    await wizard.check(ACKNOWLEDGEMENT);
    assert.ok(!wizard.disabled("Install"));
  });
  assert.deepEqual(posts, []);
});

test("a refused remote never reaches the control plane", async () => {
  const { posts, paths } = await withWizard(() => <OnboardingPage onInstalled={() => undefined} />, {}, async (wizard) => {
    await wizard.fill("Project name", "Vibeville");
    await wizard.press("Next");
    await wizard.press("Next");
    await wizard.fill("Repository name", "app");
    await wizard.fill("Remote", "https://ghp_exampletoken@github.com/owner/name.git");
    await wizard.settle();
    assert.match(wizard.markup(), /embeds a user name or password/u);
    assert.ok(wizard.disabled("Next"), "Next is available with a credential-bearing remote");
    // The rejected string is never echoed back into a message.
    const problem = wizard.dom.window.document.querySelector("[data-onboarding-problem]")?.textContent ?? "";
    assert.doesNotMatch(problem, /ghp_/u);
  });
  assert.deepEqual(posts, []);
  assert.ok(!paths.some((path) => path === "/api/onboarding" && posts.length > 0));
});

test("a double-clicked Install sends exactly one installation", async () => {
  const { posts } = await withWizard(() => <OnboardingPage onInstalled={() => undefined} />, {}, async (wizard) => {
    await walkToConfirm(wizard);
    await wizard.check(ACKNOWLEDGEMENT);
    const install = [...wizard.dom.window.document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "Install");
    assert.ok(install);
    await act(async () => {
      install.dispatchEvent(new wizard.dom.window.MouseEvent("click", { bubbles: true }));
      install.dispatchEvent(new wizard.dom.window.MouseEvent("click", { bubbles: true }));
    });
    await wizard.settle();
  });
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], {
    project: { name: "Vibeville", slug: "vibeville" },
    repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main", mountPath: "repo" },
    acknowledgedHostExecution: true,
  });
});

test("a successful install selects the created project and lands on the board", async () => {
  storage.remove("agentos.projectId");
  const { posts, hash, markup } = await withWizard(
    () => <App />,
    {
      projects: [{ status: 200, body: "[]" }, { status: 200, body: '[{"id":"p9","name":"Vibeville","slug":"vibeville"}]' }],
      post: [{ status: 201, body: INSTALLATION_BODY }],
    },
    async (wizard) => {
      await walkToConfirm(wizard);
      await wizard.check(ACKNOWLEDGEMENT);
      await wizard.press("Install");
    },
  );
  assert.equal(posts.length, 1);
  assert.equal(storage.get("agentos.projectId"), "p9");
  assert.equal(hash, "#/tasks");
  assert.match(markup, /Vibeville/u);
  assert.doesNotMatch(markup, /Set up Anneal/u);
});

test("an installation that already exists recovers into the application without a second write", async () => {
  storage.remove("agentos.projectId");
  const { posts, hash, markup } = await withWizard(
    () => <App />,
    {
      projects: [{ status: 200, body: "[]" }, { status: 200, body: '[{"id":"other","name":"Existing","slug":"existing"}]' }],
      post: [{ status: 409, body: '{"error":"An installation already exists","code":"existing-installation"}' }],
    },
    async (wizard) => {
      await walkToConfirm(wizard);
      await wizard.check(ACKNOWLEDGEMENT);
      await wizard.press("Install");
    },
  );
  assert.equal(posts.length, 1, "the 409 is not retried");
  // The wizard selects nothing on a 409 — it created nothing, so it has no id to
  // select. What ends up stored is the provider's ordinary first-project rule
  // applied to the installation that already existed.
  assert.equal(storage.get("agentos.projectId"), "other");
  assert.equal(hash, "#/tasks");
  assert.match(markup, /Existing/u);
  assert.doesNotMatch(markup, /Set up Anneal/u);
});

test("a refused installation keeps the operator on the wizard with their answers intact", async () => {
  const { posts, markup } = await withWizard(
    () => <OnboardingPage onInstalled={() => { throw new Error("must not complete"); }} />,
    { post: [{ status: 400, body: '{"error":"Validation failed"}' }] },
    async (wizard) => {
      await walkToConfirm(wizard);
      await wizard.check(ACKNOWLEDGEMENT);
      await wizard.press("Install");
    },
  );
  assert.equal(posts.length, 1);
  assert.match(markup, /refused this installation/u);
  assert.match(markup, /Vibeville/u, "the confirmation summary still holds the answers");
});

/* ------------------------------------ a completed installation, however it is learned */

test("a control plane that already reports an installation ends the wizard without a write", async () => {
  // The reachable race, not a hypothetical one: `GET /projects` is read a moment
  // before another installer commits, and `GET /onboarding` is read a moment
  // after. Step 4 made the next GET the way that is recovered, so nothing here
  // POSTs — the wizard simply stops asking questions that have been answered.
  storage.remove("agentos.projectId");
  const { posts, hash, markup } = await withWizard(
    () => <App />,
    {
      projects: [{ status: 200, body: "[]" }, { status: 200, body: '[{"id":"p-existing","name":"Existing","slug":"existing"}]' }],
      get: { status: 200, body: COMPLETED_BODY },
    },
    async () => undefined,
  );
  assert.deepEqual(posts, [], "a completed installation is recovered by reading, never by writing");
  assert.equal(storage.get("agentos.projectId"), "p-existing");
  assert.equal(hash, "#/tasks");
  assert.match(markup, /Existing/u);
  assert.doesNotMatch(markup, /Set up Anneal/u);
});

test("a control plane that disagrees with itself is recovered from once, not forever", async () => {
  // `complete: true` while the project list stays empty is a control plane
  // contradicting itself, and the recovery above is exactly the shape that would
  // bounce off it: read, reload, read, reload. It is offered on the first
  // bootstrap only, so the operator ends up somewhere they can act instead of
  // in a loop of protected requests.
  const { posts, paths, markup } = await withWizard(
    () => <App />,
    { projects: [{ status: 200, body: "[]" }], get: { status: 200, body: COMPLETED_BODY } },
    async () => undefined,
  );
  // `/runners` is the wizard's own readiness read and says nothing about this
  // property, which is about how many times the bootstrap is re-run.
  assert.deepEqual(paths.filter((path) => path !== "/api/runners"), ["/api/projects", "/api/onboarding", "/api/projects", "/api/onboarding"]);
  assert.deepEqual(posts, []);
  assert.match(markup, /Set up Anneal/u);
});

/* ------------------------------------------ an installation with no answer */

test("a POST that is never answered says so, and does not call it a refusal", async () => {
  const { posts, markup } = await withWizard(
    () => <OnboardingPage onInstalled={() => { throw new Error("must not complete"); }} />,
    { post: [{ throws: true }] },
    async (wizard) => {
      await walkToConfirm(wizard);
      await wizard.check(ACKNOWLEDGEMENT);
      await wizard.press("Install");
    },
  );
  assert.equal(posts.length, 1, "an unanswered installation is not retried on its own");
  assert.match(markup, /did not answer/u);
  assert.match(markup, /unknown/u, "the outcome is unknown, and the operator is told so");
  assert.doesNotMatch(markup, /refused this installation/u, "nothing refused these values");
  assert.match(markup, /Vibeville/u, "the answers survive for the retry");
});

test("retrying an unanswered installation recovers through 409 rather than writing twice", async () => {
  storage.remove("agentos.projectId");
  const { posts, hash, markup } = await withWizard(
    () => <App />,
    {
      projects: [{ status: 200, body: "[]" }, { status: 200, body: '[{"id":"p-existing","name":"Existing","slug":"existing"}]' }],
      post: [{ throws: true }, { status: 409, body: '{"error":"An installation already exists","code":"existing-installation"}' }],
    },
    async (wizard) => {
      await walkToConfirm(wizard);
      await wizard.check(ACKNOWLEDGEMENT);
      await wizard.press("Install");
      assert.match(wizard.markup(), /did not answer/u);
      await wizard.press("Install");
    },
  );
  // Two attempts, one installation: the second POST is the operator's, and the
  // control plane — not the browser — is what makes it safe.
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(hash, "#/tasks");
  assert.match(markup, /Existing/u);
  assert.doesNotMatch(markup, /Set up Anneal/u);
});

/* ----------------------------------------------------------- no way around it */

test("a deep link into a protected route on a fresh installation still lands on the wizard", async () => {
  // The gate decides what mounts, not the route: arriving at #/settings with no
  // installation must not mount the Shell or start a protected poll behind the
  // wizard.
  const { markup, paths } = await withWizard(
    () => <App />,
    { projects: [{ status: 200, body: "[]" }], url: "http://127.0.0.1:5173/#/settings" },
    async () => undefined,
  );
  assert.match(markup, /Set up Anneal/u);
  assert.doesNotMatch(markup, /data-runner-state=/u);
  assert.deepEqual(paths.filter((path) => !["/api/projects", "/api/onboarding", "/api/runners"].includes(path)), []);
});

/* -------------------------------------------- Codex, the sole readiness gate */

/** Walks to the Codex summary screen, which is where readiness is shown and
 *  where an unready installation stops. */
const walkToStarter = async (wizard: Wizard): Promise<void> => {
  await wizard.fill("Project name", "Vibeville");
  await wizard.press("Next");
  await wizard.press("Next");
  await wizard.fill("Repository name", "app");
  await wizard.fill("Remote", "https://github.com/owner/name.git");
  await wizard.press("Next");
};

test("a healthy Codex with no Claude and a failed Pi installs without complaint", async () => {
  const { posts, markup } = await withWizard(
    () => <OnboardingPage onInstalled={() => undefined} />,
    {},
    async (wizard) => {
      await walkToStarter(wizard);
      assert.match(wizard.markup(), /data-codex-state="ready"/u);
      // The optional backends are named as optional on the screen that shows
      // them, rather than left to look like something the operator failed to
      // install.
      assert.match(wizard.markup(), /optional in this preview/u);
      assert.ok(!wizard.disabled("Next"), "a ready Codex blocks nothing");
      await wizard.press("Next");
      await wizard.check(ACKNOWLEDGEMENT);
      assert.ok(!wizard.disabled("Install"));
    },
  );
  assert.deepEqual(posts, []);
  assert.match(markup, /Vibeville/u, "the confirmation screen is reached");
});

test("a missing Codex CLI stops the wizard with install guidance and no write", async () => {
  const { posts } = await withWizard(
    () => <OnboardingPage onInstalled={() => undefined} />,
    { runners: { status: 200, body: runnersBody({ cliVersion: null, lastPreflightOk: false, circuitOpen: true, circuitReason: "CLI missing" }) } },
    async (wizard) => {
      await walkToStarter(wizard);
      assert.match(wizard.markup(), /data-codex-state="missing"/u);
      assert.match(wizard.markup(), /Install the official Codex CLI/u);
      assert.ok(wizard.disabled("Next"), "an installation with nowhere to run must not reach Install");
    },
  );
  assert.deepEqual(posts, []);
});

test("an unauthenticated Codex says codex login, and nothing here runs it", async () => {
  const { markup, posts } = await withWizard(
    () => <OnboardingPage onInstalled={() => undefined} />,
    { runners: { status: 200, body: runnersBody({ lastPreflightOk: false, circuitOpen: true, circuitReason: "Not logged in" }) } },
    async (wizard) => {
      await walkToStarter(wizard);
      assert.match(wizard.markup(), /data-codex-state="unauthenticated"/u);
      assert.ok(wizard.disabled("Next"));
    },
  );
  assert.match(markup, /codex login/u);
  // The guidance is an instruction to the operator, not an offer: no button, no
  // credential field, no automation.
  assert.doesNotMatch(markup, /OPENAI_API_KEY|Bearer|Sign in with|Paste your/iu);
  assert.deepEqual(posts, []);
});

test("a control plane nobody has reported to is Pending, not a failure", async () => {
  const { markup } = await withWizard(
    () => <OnboardingPage onInstalled={() => undefined} />,
    { runners: { status: 200, body: runnersBody({}, { online: false }) } },
    async (wizard) => {
      await walkToStarter(wizard);
      assert.match(wizard.markup(), /data-codex-state="pending"/u);
      assert.ok(wizard.disabled("Next"), "pending is not a pass");
    },
  );
  assert.match(markup, /Waiting for the local runner/u);
  assert.doesNotMatch(markup, /Install the official Codex CLI/u, "a silent daemon is not a missing CLI");
});

test("a stale runner report is Pending too, and an unreachable one does not pass", async () => {
  const stale = runnersBody({}, { checkedAt: new Date(Date.now() - 120_000).toISOString() });
  const { markup } = await withWizard(
    () => <OnboardingPage onInstalled={() => undefined} />,
    { runners: { status: 200, body: stale } },
    async (wizard) => { await walkToStarter(wizard); assert.ok(wizard.disabled("Next")); },
  );
  assert.match(markup, /data-codex-state="pending"/u);

  const { markup: unreachable } = await withWizard(
    () => <OnboardingPage onInstalled={() => undefined} />,
    { runners: { throws: true } },
    async (wizard) => { await walkToStarter(wizard); assert.ok(wizard.disabled("Next")); },
  );
  assert.match(unreachable, /data-codex-state="pending"/u);
});

/**
 * Freshness is a property of *now*, not of the last render.
 *
 * `codexReady` ages a report out at sixty seconds, but a selector only runs when
 * something renders, and this page can sit on the confirmation screen for
 * minutes. Worse, `usePoll` does not ask a hidden tab anything — so the one
 * event that would have refreshed the verdict is exactly the one that does not
 * happen while an operator is away running `codex login`. Without a clock of its
 * own the page keeps showing a verdict that stopped being true, with the Install
 * button still live under it.
 *
 * The times below are real elapsed milliseconds against a report that is already
 * 58.5 seconds old, so the boundary falls about 1.5 seconds into the test.
 */
test("a ready wizard ages to Pending on its own, and a hidden tab does not hold the verdict open", async () => {
  const nearlyStale = runnersBody({}, { checkedAt: new Date(Date.now() - 58_500).toISOString() });
  const { posts } = await withWizard(
    () => <OnboardingPage onInstalled={() => undefined} />,
    { runners: { status: 200, body: nearlyStale } },
    async (wizard) => {
      await walkToStarter(wizard);
      await wizard.press("Next");
      await wizard.check(ACKNOWLEDGEMENT);
      // A ready gate says nothing on this screen — there is nothing to do about
      // it — so what is read here is the button and the problem line.
      assert.ok(!wizard.disabled("Install"));
      assert.doesNotMatch(wizard.markup(), /data-onboarding-problem/u);
      // The operator switches away. Nothing will be fetched from here on.
      await wizard.visible(false);
      // Wait past the boundary in one turn. Under the merge gate's parallel
      // unit load a nominal 900 ms wait can be descheduled past the boundary,
      // so an intermediate wall-clock assertion cannot prove the pre-boundary
      // state. The ready assertions above and expired assertions below cover
      // the two states without depending on scheduler latency.
      await wizard.wait(1_800);
      assert.match(wizard.markup(), /data-codex-state="pending"/u, "the report aged out with nobody asking");
      assert.match(wizard.markup(), /data-onboarding-problem/u);
      assert.ok(wizard.disabled("Install"), "an expired verdict does not leave a live Install behind it");
      // Coming back does not restore it either: what expired is the report, and
      // returning to the tab is not a new one.
      await wizard.visible(true);
      assert.match(wizard.markup(), /data-codex-state="pending"/u);
      assert.ok(wizard.disabled("Install"));
      await wizard.press("Install");
    },
  );
  assert.deepEqual(posts, [], "a stale wizard cannot write");
});

/**
 * And the write re-checks anyway.
 *
 * The disabled attribute is the product of a render that has already happened;
 * the only check that happens at the moment of the write is the one inside
 * `install()`. Here the page's clock is stubbed out entirely — standing in for
 * any way it might fail to tick — so the button stays enabled under a verdict
 * that has expired, which is precisely the state the guard exists for.
 */
test("the write re-checks readiness, so a verdict no clock corrected still cannot install", async () => {
  const nearlyStale = runnersBody({}, { checkedAt: new Date(Date.now() - 58_500).toISOString() });
  const { posts, markup } = await withWizard(
    () => <OnboardingPage onInstalled={() => undefined} />,
    { runners: { status: 200, body: nearlyStale }, freezeClock: true },
    async (wizard) => {
      await walkToStarter(wizard);
      await wizard.press("Next");
      await wizard.check(ACKNOWLEDGEMENT);
      assert.ok(!wizard.disabled("Install"));
      await wizard.wait(1_800);
      assert.doesNotMatch(wizard.markup(), /data-codex-state="pending"/u, "with no clock the stale render survives, which is the point");
      assert.ok(!wizard.disabled("Install"), "the button is live under an expired verdict");
      await wizard.press("Install");
    },
  );
  assert.deepEqual(posts, [], "the write fails closed on the clock, not on the last render");
  assert.match(markup, /Codex was ready a moment ago and is not now/u);
  // The answers survive: this is a gate, not a rejection of what was typed.
  assert.match(markup, /Vibeville/u);
});
