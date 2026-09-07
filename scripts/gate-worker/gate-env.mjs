// The fixture's view of the gate's environment: which variables the gate reads,
// and which of them a fixture may inherit from the host it runs on.
//
// The dispatcher and the gate read their topology and their sizing out of the
// environment: `AGENTOS_GATE_SERVER` alone collapses the dispatcher to a single
// server with an empty fallback (gate-dispatch.sh), which turns a case that
// pre-fills the desktop slots into a wait for a slot that cannot open. A
// session configured to reach a real gate worker exports that variable, so a
// fixture that inherits the host environment tests the host's topology instead
// of the one it declares — which is how that suite once blocked for the
// dispatcher's full hour instead of failing. The host's Git identity was
// already neutralised for the same reason; behaviour belongs on the same list.
// The gate, dispatcher, and Anneal Run namespaces are stripped by prefix so a
// variable added to any of them later cannot reintroduce the leak.
//
// This was 26 identical lines in gate-worker.test.mjs and gate-dispatch.test.mjs.
// Three commits edited them by hand — 1a855ae, 4087264, d360238 — and 4087264
// landed in only one of the two, so the guard it added was missing from the
// other file until the commit after it. That is what this module is for: not
// that the list appeared twice, but that the reason did.

export const GATE_ENV_PREFIXES = ["AGENTOS_GATE_", "AGENTOS_RUN_", "GATE_DISPATCH_"];

// run-gate.sh's three are not prefixed but are read the same way: GATE_HOME
// relocates the whole gate directory a fixture built for itself — at the real
// worker's mirror, worktrees and logs — STALE_WORKTREE_MINUTES decides what its
// sweep reclaims, and SLOT_WAIT_MINUTES decides how long it waits for a worker
// slot before reporting that nothing ran. AGENTOS_RUNNER_HOME is likewise a
// runner-provided account root for shared local gate slots; a fixture must set
// it explicitly when that accounting behavior is under test, never inherit the
// host's account root.
export const GATE_ENV_NAMES = [
  "AGENTOS_WORKSPACE_PATH",
  "AGENTOS_RUNNER_HOME",
  "GATE_HOME",
  "SLOT_WAIT_MINUTES",
  "STALE_WORKTREE_MINUTES",
];

// The other half of the same question, and the reason for each entry. Every
// name the gate scripts read is either stripped by isHostGateConfig or stated
// here; gate-env.test.mjs holds that closed, so a variable added to the gate
// cannot silently start reaching the fixtures the way one already did.
export const GATE_ENV_INHERITED = {
  XDG_CACHE_HOME:
    "every case that needs it sets it, and removing it would point a dispatcher at the real slot locks under $HOME/.cache",
  HOME: "the fixture's own account; every case that needs a private home hands the script one",
  TMPDIR: "where the fixtures put their own scratch roots in the first place",
  RANDOM: "bash's own generator, not a name anything exports",
  AGENTOS_MASTER_OID:
    "read only by merge-gate.sh, and no fixture runs the real gate: every case that reaches it substitutes a stub",
  ESBUILD_BINARY_PATH: "read only by merge-gate.sh, and no fixture runs the real gate",
  NODE_OPTIONS: "read only by merge-gate.sh, and no fixture runs the real gate",
  TEST_DATABASE_URL: "read only by merge-gate.sh, and no fixture runs the real gate",
};

export const isHostGateConfig = (key) =>
  GATE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) || GATE_ENV_NAMES.includes(key);

export const hostNeutralEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !isHostGateConfig(key)));

// `identity` is the one thing that differed between the two fixture files.
export const fixtureEnv = (identity) => ({
  ...hostNeutralEnv(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: identity,
  GIT_AUTHOR_EMAIL: identity,
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: identity,
  GIT_COMMITTER_EMAIL: identity,
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
});
