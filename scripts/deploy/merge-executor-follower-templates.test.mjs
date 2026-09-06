import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  renderMergeExecutorFollowerSystemdTimer,
  renderMergeExecutorFollowerSystemdUnit,
} from "./merge-executor-follower-templates.mjs";

const VALUES = Object.freeze({
  nodePath: "/usr/bin/node",
  followerPath: "/opt/agentos/merge-executor/bin/merge-executor-follower.mjs",
  configPath: "/etc/agentos/merge-executor-follower.json",
});

test("follower templates render a root service and five-minute timer", () => {
  const unit = renderMergeExecutorFollowerSystemdUnit(VALUES);
  const timer = renderMergeExecutorFollowerSystemdTimer();

  assert.match(unit, /^Description=Anneal merge executor release follower$/mu);
  assert.match(unit, /^Type=oneshot$/mu);
  assert.match(unit, /^User=root$/mu);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/agentos\/merge-executor\/bin\/merge-executor-follower\.mjs --config \/etc\/agentos\/merge-executor-follower\.json$/mu);
  assert.doesNotMatch(unit, /__[A-Z_]+__/u);

  assert.match(timer, /^OnBootSec=60$/mu);
  assert.match(timer, /^OnUnitActiveSec=300$/mu);
  assert.match(timer, /^Unit=agentos-merge-executor-follower\.service$/mu);
  assert.doesNotMatch(timer, /__[A-Z_]+__/u);
});

test("rendered follower unit and timer pass systemd-analyze when available", (t) => {
  if (process.platform !== "linux") {
    t.skip("systemd-analyze fixture applies to Linux systemd");
    return;
  }
  const available = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") {
    t.skip("systemd-analyze unavailable on this host");
    return;
  }
  assert.equal(available.status, 0, available.stderr);

  const root = mkdtempSync(join(tmpdir(), "agentos-merge-executor-follower-systemd-"));
  try {
    const unitPath = join(root, "agentos-merge-executor-follower.service");
    const timerPath = join(root, "agentos-merge-executor-follower.timer");
    writeFileSync(unitPath, renderMergeExecutorFollowerSystemdUnit({
      nodePath: process.execPath,
      followerPath: join(root, "merge-executor-follower.mjs"),
      configPath: join(root, "merge-executor-follower.json"),
    }));
    writeFileSync(timerPath, renderMergeExecutorFollowerSystemdTimer());

    for (const path of [unitPath, timerPath]) {
      const verified = spawnSync("systemd-analyze", ["verify", path], {
        encoding: "utf8",
        env: { ...process.env, SYSTEMD_UNIT_PATH: `${root}:` },
      });
      const output = `${verified.stdout ?? ""}${verified.stderr ?? ""}`;
      assert.equal(verified.status, 0, output);
      assert.doesNotMatch(output, /Failed to parse|Unknown lvalue/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("template files remain present and contain only renderer placeholders", () => {
  const service = readFileSync(new URL("./agentos-merge-executor-follower.service.in", import.meta.url), "utf8");
  const timer = readFileSync(new URL("./agentos-merge-executor-follower.timer.in", import.meta.url), "utf8");
  assert.match(service, /__NODE_PATH__/u);
  assert.match(service, /__FOLLOWER_PATH__/u);
  assert.match(service, /__CONFIG_PATH__/u);
  assert.match(timer, /agentos-merge-executor-follower\.service/u);
});

test("systemd path values reject expansion and quoting syntax", () => {
  for (const nodePath of ["/usr/bin/$node", "/usr/bin/node'quoted'"]) {
    assert.throws(
      () => renderMergeExecutorFollowerSystemdUnit({ ...VALUES, nodePath }),
      /merge-executor-follower-template-node-path-invalid/u,
    );
  }
});
