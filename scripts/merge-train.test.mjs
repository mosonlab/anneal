import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  acquireMergeTrainLease,
  coordinateMergeTrain,
  releaseMergeTrainLease,
} from "./merge-train.mjs";

const execFileAsync = promisify(execFile);

const command = async (file, args, cwd) => {
  const { stdout } = await execFileAsync(file, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const git = (cwd, ...args) => command("git", args, cwd);

const makeFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentos-merge-train-test-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "init", "--initial-branch=main", repo);
  await git(repo, "config", "user.name", "Merge Train Test");
  await git(repo, "config", "user.email", "merge-train@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, "base.txt"), "base\n");
  await writeFile(path.join(repo, "shared.txt"), "base\n");
  await git(repo, "add", "base.txt", "shared.txt");
  await git(repo, "commit", "-m", "base");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");
  const baseSha = await git(repo, "rev-parse", "HEAD");

  const candidate = async (pullRequest, files, start = baseSha) => {
    const checkout = path.join(root, `candidate-${pullRequest}`);
    await git(repo, "worktree", "add", "-b", `candidate-${pullRequest}`, checkout, start);
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(checkout, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-m", `candidate ${pullRequest}`);
    const headSha = await git(checkout, "rev-parse", "HEAD");
    await git(checkout, "push", "origin", `${headSha}:refs/pull/${pullRequest}/head`);
    await git(repo, "worktree", "remove", "--force", checkout);
    return { pullRequest, headSha };
  };

  const remoteMain = () => command("git", ["--git-dir", origin, "rev-parse", "refs/heads/main"], root);
  const remoteContains = async (headSha) => {
    const main = await remoteMain();
    try {
      await command("git", ["--git-dir", origin, "merge-base", "--is-ancestor", headSha, main], root);
      return true;
    } catch {
      return false;
    }
  };
  const readPullRequest = (candidates) => async (_repoRoot, pullRequest) => {
    const found = candidates.find((value) => value.pullRequest === pullRequest);
    assert.ok(found, `unknown fixture PR #${pullRequest}`);
    const merged = await remoteContains(found.headSha);
    return { state: merged ? "MERGED" : "OPEN", headSha: found.headSha };
  };
  const cleanup = async () => rm(root, { recursive: true, force: true });

  return { baseSha, candidate, cleanup, origin, readPullRequest, remoteContains, remoteMain, repo, root };
};

const passGate = async (_repoRoot, prefix) => ({
  status: "pass",
  code: 0,
  output: `MERGE GATE: PASS ${prefix.oid}\n`,
});

const noLease = (events = []) => ({
  acquireLease: async () => {
    events.push("lease-acquire");
    return { outcome: "acquired" };
  },
  releaseLease: async () => {
    events.push("lease-release");
    return { outcome: "not-held" };
  },
});

test("merge train lease caller uses the release root and bounded-wait acquisition policy", async () => {
  const calls = [];
  const environment = { AGENTOS_RELEASE_ROOT: "/srv/agentos/current" };
  const runner = async (...args) => {
    calls.push(args);
    return calls.length === 1
      ? { code: 75, stderr: "merge-lease: timed out\n" }
      : { code: 0, stdout: "MERGE LEASE: not-held\n" };
  };

  assert.equal((await acquireMergeTrainLease("/checkout", "train-42", 2, { environment, runner })).outcome, "contended");
  assert.equal((await releaseMergeTrainLease("/checkout", "train-42", { environment, runner })).outcome, "not-held");
  assert.deepEqual(calls[0], [
    "bash",
    [
      "/srv/agentos/current/scripts/merge-lease.sh",
      "acquire",
      "--task",
      "train-42",
      "--reason",
      "Publish 2-entry merge train",
      "--timeout-minutes",
      "10",
    ],
    { cwd: "/checkout", environment, processTimeoutMs: undefined },
  ]);
  assert.deepEqual(calls[1], [
    "bash",
    ["/srv/agentos/current/scripts/merge-lease.sh", "release", "--task", "train-42"],
    { cwd: "/checkout", environment, processTimeoutMs: undefined },
  ]);
});

test("merge train lease caller forwards an explicit wait including zero", async () => {
  for (const leaseWaitMinutes of [0, 2]) {
    await acquireMergeTrainLease("/checkout", "train-42", 2, {
      leaseWaitMinutes,
      environment: {},
      runner: async (_command, args) => {
        assert.equal(args.at(-1), String(leaseWaitMinutes));
        return { code: 0 };
      },
    });
  }
});

for (const scenario of ["unchanged", "moved", "expired", "unreachable"]) {
  test(`lease wait after passing gates: ${scenario}`, async (t) => {
    const fixture = await makeFixture();
    let elapsed = 0;
    t.mock.method(performance, "now", () => elapsed);
    try {
      const candidates = [
        await fixture.candidate(280, { "a.txt": "a\n" }),
        await fixture.candidate(281, { "b.txt": "b\n" }),
      ];
      const events = [];
      const gated = [];
      const options = {
        repoRoot: fixture.repo,
        task: "waiting-train",
        candidates,
        leaseWaitMinutes: 2,
        adapters: {
          gate: async (repoRoot, prefix) => {
            gated.push(prefix.oid);
            return passGate(repoRoot, prefix);
          },
          acquireLease: (repoRoot, task, count, waitOptions) =>
            acquireMergeTrainLease(repoRoot, task, count, {
              ...waitOptions,
              environment: {},
              runner: async (_command, args) => {
                assert.equal(args.at(-1), "2");
                assert.equal(count, 2);
                assert.equal(gated.length, 2, "all gates finish before acquisition starts");
                events.push("acquire-attempted");
                // Model polling inside the lease script: the caller awaits one execution.
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(await fixture.remoteMain(), fixture.baseSha);
                if (scenario === "moved") {
                  const drift = await fixture.candidate(282, { "drift.txt": "drift\n" });
                  await git(fixture.repo, "push", "origin", `${drift.headSha}:refs/heads/main`);
                }
                elapsed = scenario === "expired" ? 120_000 : 5_000;
                if (scenario === "expired") return { code: 75, stderr: "timed out" };
                if (scenario === "unreachable") return { code: 2, stderr: "transport failed" };
                events.push("acquired");
                return { code: 0 };
              },
            }),
          releaseLease: async () => {
            events.push("released");
            return {
              outcome: "released",
              ref: "refs/merge-lease/holder",
              sha: "1".repeat(40),
              acquiredAt: "2026-01-01T00:00:00.000Z",
            };
          },
          now: () => new Date("2026-01-01T00:02:07.400Z"),
          readPullRequest: fixture.readPullRequest(candidates),
          sleep: async () => {},
        },
      };
      if (scenario === "unreachable") {
        await assert.rejects(coordinateMergeTrain(options), /acquisition was unreachable: transport failed/u);
        assert.deepEqual(events, ["acquire-attempted"]);
        assert.equal(await fixture.remoteMain(), fixture.baseSha);
      } else {
        const result = await coordinateMergeTrain(options);
        assert.equal(gated.length, 2, "no gates rerun after waiting");
        if (scenario === "unchanged") {
          assert.equal(result.status, "published-all");
          assert.deepEqual(result.published.map((prefix) => prefix.oid), gated);
          assert.equal(await fixture.remoteMain(), gated[1]);
        } else {
          assert.equal(result.status, scenario === "moved" ? "stale-base" : "lease-contended");
          assert.deepEqual(result.published, []);
          for (const candidate of candidates) assert.equal(await fixture.remoteContains(candidate.headSha), false);
        }
        if (scenario === "expired") {
          assert.equal(result.leaseWaitedMs, 120_000);
          assert.deepEqual(events, ["acquire-attempted"]);
          // A train that never held the lease has no hold to compare.
          assert.equal(result.heldForSeconds, undefined);
        } else {
          assert.deepEqual(events, ["acquire-attempted", "acquired", "released"]);
          // The same measurement the chain tail records on its own release, so
          // a train hold and a chain-tail hold are comparable numbers.
          assert.equal(result.heldForSeconds, 127);
        }
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

test("CLI documents lease wait and rejects invalid minute values before gating", async () => {
  const script = fileURLToPath(new URL("./merge-train.mjs", import.meta.url));
  const help = await command(process.execPath, [script, "--help"]);
  assert.match(help, /--lease-wait-minutes <n>/u);
  assert.match(help, /default: 10/u);
  for (const value of ["-1", "1.5", "NaN", "Infinity", "", "9007199254740992"]) {
    await assert.rejects(execFileAsync(process.execPath, [script, "--lease-wait-minutes", value]),
      (error) => error.code === 1 && /--lease-wait-minutes must be a non-negative safe integer/u.test(error.stderr));
  }
});

test("CLI forwards the wait and includes elapsed duration in contention JSON", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = await fixture.candidate(283, { "cli.txt": "cli\n" });
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);
    // Intercept subprocesses; no actual gate-worker or lease script runs.
    const fakeBash = path.join(bin, "bash");
    await writeFile(fakeBash, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0].endsWith("/gate-dispatch.sh")) {
  console.log("MERGE GATE: PASS " + args[1]);
} else if (args[0].endsWith("/merge-lease.sh") && args[1] === "acquire"
  && args.at(-2) === "--timeout-minutes" && args.at(-1) === "2") {
  setTimeout(() => process.exit(75), 20);
} else {
  process.exit(2);
}
`);
    const fakeGh = path.join(bin, "gh");
    await writeFile(fakeGh, `#!/usr/bin/env node
console.log(JSON.stringify({state: "OPEN", headRefOid: ${JSON.stringify(candidate.headSha)}}));
`);
    await chmod(fakeBash, 0o755);
    await chmod(fakeGh, 0o755);
    const script = fileURLToPath(new URL("./merge-train.mjs", import.meta.url));
    await assert.rejects(execFileAsync(process.execPath, [
      script, "--task", "cli-wait", "--candidate", `283:${candidate.headSha}`, "--lease-wait-minutes", "2",
    ], {
      cwd: fixture.repo,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    }), (error) => {
      assert.equal(error.code, 1);
      const summary = JSON.parse(error.stdout.slice(error.stdout.indexOf("{\n")));
      assert.equal(summary.status, "lease-contended");
      assert.ok(Number.isSafeInteger(summary.leaseWaitedMs));
      assert.ok(summary.leaseWaitedMs >= 20);
      assert.deepEqual(summary.published, []);
      return true;
    });
    assert.equal(await fixture.remoteMain(), fixture.baseSha);
  } finally {
    await fixture.cleanup();
  }
});

test("lease contention is a structured no-publication result", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = await fixture.candidate(290, { "candidate.txt": "candidate\n" });
    let releaseCalled = false;
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "contended-train",
      candidates: [candidate],
      adapters: {
        acquireLease: async () => ({ outcome: "contended" }),
        releaseLease: async () => {
          releaseCalled = true;
          return { outcome: "not-held" };
        },
        gate: passGate,
        readPullRequest: fixture.readPullRequest([candidate]),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "lease-contended");
    assert.deepEqual(result.published, []);
    assert.equal(releaseCalled, false);
    assert.equal(await fixture.remoteMain(), fixture.baseSha);
  } finally {
    await fixture.cleanup();
  }
});

test("release anomalies prevent a clean merge train finish after safe read-back", async () => {
  const anomalies = [
    { outcome: "skipped", heldFor: "another-task" },
    { outcome: "refused", heldBy: "another@host" },
    { outcome: "unreachable", detail: "release transport failed" },
  ];

  for (const [index, release] of anomalies.entries()) {
    const fixture = await makeFixture();
    try {
      const candidate = await fixture.candidate(291 + index, { [`candidate-${index}.txt`]: "candidate\n" });
      await assert.rejects(coordinateMergeTrain({
        repoRoot: fixture.repo,
        task: `release-${release.outcome}`,
        candidates: [candidate],
        adapters: {
          acquireLease: async () => ({ outcome: "acquired" }),
          releaseLease: async () => release,
          gate: passGate,
          readPullRequest: fixture.readPullRequest([candidate]),
          sleep: async () => {},
        },
      }), new RegExp(`merge Lease release ${release.outcome}`, "u"));
      assert.equal(await fixture.remoteContains(candidate.headSha), true);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("an unknown publication read-back retains the lease", async (t) => {
  const fixture = await makeFixture();
  const stderr = [];
  t.mock.method(process.stderr, "write", (chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const candidate = await fixture.candidate(294, { "candidate.txt": "candidate\n" });
    let releaseCalled = false;
    await assert.rejects(coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "unknown-read-back",
      candidates: [candidate],
      adapters: {
        acquireLease: async () => ({ outcome: "acquired" }),
        releaseLease: async () => {
          releaseCalled = true;
          return { outcome: "released" };
        },
        gate: passGate,
        push: async () => {
          throw new Error("main read-back unavailable");
        },
        readPullRequest: fixture.readPullRequest([candidate]),
        sleep: async () => {},
      },
    }), /main read-back unavailable/u);
    assert.equal(releaseCalled, false);
    assert.match(stderr.join(""), /lease for task unknown-read-back was retained/u);
    assert.equal(await fixture.remoteMain(), fixture.baseSha);
  } finally {
    await fixture.cleanup();
  }
});

test("the default adapter locally dispatches from a clean exact-prefix checkout", async () => {
  const fixture = await makeFixture();
  try {
    const dispatcher = await readFile(new URL("../packages/runner/runtime-tools/gate-worker/gate-dispatch.sh", import.meta.url), "utf8");
    const gateLibrary = await readFile(new URL("../packages/runner/runtime-tools/gate-worker/lib.sh", import.meta.url), "utf8");
    const wrapper = `#!/usr/bin/env bash
set -eu
unset AGENTOS_GATE_SERVER AGENTOS_GATE_PRIMARY_SERVER AGENTOS_GATE_FALLBACK_SERVER
export AGENTOS_GATE_ALLOW_LOCAL=1
export XDG_CACHE_HOME=${JSON.stringify(path.join(fixture.root, "gate-cache"))}
exec bash "$(dirname "$0")/gate-dispatch-real.sh" "$@"
`;
    const mergeGate = `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "--expect-head" ]
expected="$2"
[ "$3" = "--master" ]
head="$(git rev-parse HEAD)"
status="$(git status --porcelain)"
[ "$head" = "$expected" ]
[ -z "$status" ]
printf 'FIXTURE GATE: cwd=%s head=%s clean=yes\\n' "$PWD" "$head"
printf 'MERGE GATE: PASS %s\\n' "$head"
`;
    const candidate = await fixture.candidate(300, {
      "packages/runner/runtime-tools/gate-worker/gate-dispatch.sh": wrapper,
      "packages/runner/runtime-tools/gate-worker/gate-dispatch-real.sh": dispatcher,
      "packages/runner/runtime-tools/gate-worker/lib.sh": gateLibrary,
      "scripts/merge-gate.sh": mergeGate,
    });
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "local-dispatch",
      candidates: [candidate],
      adapters: {
        ...noLease(),
        readPullRequest: fixture.readPullRequest([candidate]),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "published-all");
    assert.equal(result.gateResults[0].status, "pass");
    const evidence = /FIXTURE GATE: cwd=(.+) head=([0-9a-f]{40}) clean=yes/u.exec(
      result.gateResults[0].output,
    );
    assert.ok(evidence, result.gateResults[0].output);
    assert.notEqual(path.resolve(evidence[1]), path.resolve(fixture.repo));
    assert.equal(evidence[2], result.prefixes[0].oid);
    const worktrees = await git(fixture.repo, "worktree", "list", "--porcelain");
    assert.equal(worktrees.match(/^worktree /gmu)?.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("three cumulative prefixes gate concurrently and publish in FIFO order", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      await fixture.candidate(301, { "a.txt": "a\n", ".chain/private.txt": "private\n" }),
      await fixture.candidate(302, { "b.txt": "b\n" }),
      await fixture.candidate(303, { "c.txt": "c\n" }),
    ];
    const events = [];
    let activeGates = 0;
    let maximumActiveGates = 0;
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "clean-three",
      candidates,
      adapters: {
        ...noLease(events),
        gate: async (_repoRoot, prefix) => {
          events.push(`gate-${prefix.index}`);
          activeGates += 1;
          maximumActiveGates = Math.max(maximumActiveGates, activeGates);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeGates -= 1;
          return passGate(_repoRoot, prefix);
        },
        readPullRequest: fixture.readPullRequest(candidates),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "published-all");
    assert.equal(result.published.length, 3);
    assert.equal(maximumActiveGates, 3);
    assert.ok(events.indexOf("lease-acquire") > events.indexOf("gate-3"));
    assert.equal(events.at(-1), "lease-release");
    assert.equal(await fixture.remoteMain(), result.prefixes[2].oid);
    for (const candidate of candidates) assert.equal(await fixture.remoteContains(candidate.headSha), true);
    const internalPaths = await git(fixture.repo, "ls-tree", "-r", "--name-only", result.prefixes[0].oid, "--", ".chain");
    assert.equal(internalPaths, "");
  } finally {
    await fixture.cleanup();
  }
});

test("a failed middle prefix cuts publication even when the last prefix passes", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      await fixture.candidate(311, { "a.txt": "a\n" }),
      await fixture.candidate(312, { "b.txt": "b\n" }),
      await fixture.candidate(313, { "c.txt": "c\n" }),
    ];
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "middle-fails",
      candidates,
      adapters: {
        ...noLease(),
        gate: async (repoRoot, prefix) =>
          prefix.index === 2
            ? { status: "fail", code: 1, output: "MERGE GATE: FAIL (fixture)\n" }
            : passGate(repoRoot, prefix),
        readPullRequest: fixture.readPullRequest(candidates),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "published-prefix");
    assert.deepEqual(result.published.map((prefix) => prefix.candidate.pullRequest), [311]);
    assert.equal(await fixture.remoteContains(candidates[0].headSha), true);
    assert.equal(await fixture.remoteContains(candidates[1].headSha), false);
    assert.equal(await fixture.remoteContains(candidates[2].headSha), false);
  } finally {
    await fixture.cleanup();
  }
});

test("a mechanical conflict ends the batch without inventing a resolution", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      await fixture.candidate(321, { "shared.txt": "first\n" }),
      await fixture.candidate(322, { "shared.txt": "second\n" }),
      await fixture.candidate(323, { "later.txt": "later\n" }),
    ];
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "conflict",
      candidates,
      adapters: {
        ...noLease(),
        gate: passGate,
        readPullRequest: fixture.readPullRequest(candidates),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "published-prefix");
    assert.equal(result.blocked.pullRequest, 322);
    assert.equal(result.blocked.reason, "merge conflict");
    assert.deepEqual(result.blocked.files, ["shared.txt"]);
    assert.deepEqual(result.published.map((prefix) => prefix.candidate.pullRequest), [321]);
  } finally {
    await fixture.cleanup();
  }
});

test("main drift after gates publishes nothing", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [await fixture.candidate(331, { "a.txt": "a\n" })];
    let drifted = false;
    const result = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "drift",
      candidates,
      adapters: {
        ...noLease(),
        gate: async (repoRoot, prefix) => {
          if (!drifted) {
            drifted = true;
            const checkout = path.join(fixture.root, "drift");
            await git(fixture.repo, "worktree", "add", "-b", "drift", checkout, fixture.baseSha);
            await writeFile(path.join(checkout, "drift.txt"), "drift\n");
            await git(checkout, "add", "drift.txt");
            await git(checkout, "commit", "-m", "drift main");
            await git(checkout, "push", "origin", "HEAD:main");
            await git(fixture.repo, "worktree", "remove", "--force", checkout);
          }
          return passGate(repoRoot, prefix);
        },
        readPullRequest: fixture.readPullRequest(candidates),
        sleep: async () => {},
      },
    });

    assert.equal(result.status, "stale-base");
    assert.deepEqual(result.published, []);
    assert.notEqual(await fixture.remoteMain(), fixture.baseSha);
    assert.equal(await fixture.remoteContains(candidates[0].headSha), false);
  } finally {
    await fixture.cleanup();
  }
});

test("rerun reads live main, skips an earlier published head, and rebuilds the rest", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      await fixture.candidate(341, { "a.txt": "a\n" }),
      await fixture.candidate(342, { "b.txt": "b\n" }),
      await fixture.candidate(343, { "c.txt": "c\n" }),
    ];
    const adapters = {
      ...noLease(),
      readPullRequest: fixture.readPullRequest(candidates),
      sleep: async () => {},
    };
    const first = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "recovery-one",
      candidates,
      adapters: {
        ...adapters,
        gate: async (repoRoot, prefix) =>
          prefix.index === 2
            ? { status: "fail", code: 1, output: "MERGE GATE: FAIL (fixture)\n" }
            : passGate(repoRoot, prefix),
      },
    });
    assert.deepEqual(first.published.map((prefix) => prefix.candidate.pullRequest), [341]);

    const second = await coordinateMergeTrain({
      repoRoot: fixture.repo,
      task: "recovery-two",
      candidates,
      adapters: { ...adapters, gate: passGate },
    });
    assert.equal(second.status, "published-all");
    assert.deepEqual(second.alreadyDelivered.map((candidate) => candidate.pullRequest), [341]);
    assert.deepEqual(second.published.map((prefix) => prefix.candidate.pullRequest), [342, 343]);
    for (const candidate of candidates) assert.equal(await fixture.remoteContains(candidate.headSha), true);
  } finally {
    await fixture.cleanup();
  }
});
