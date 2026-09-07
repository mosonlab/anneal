import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Execute the deployed command, including its shell quoting and stdin protocol.
// Copying only settings models the root-owned OS isolation staging contract.
const settings = JSON.parse(readFileSync(new URL("../../assets/claude-platform-settings.json", import.meta.url), "utf8"));
const hook = settings.hooks.PreToolUse[0];
const command: string = hook.hooks[0].command;
const invoke = (input: unknown, cwd?: string, env?: NodeJS.ProcessEnv) => {
  const result = spawnSync("/bin/sh", ["-c", command], {
    input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", cwd, env,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
};
const denied = (input: unknown) => {
  const output = invoke(input);
  assert.equal(output?.hookEventName, "PreToolUse");
  assert.equal(output?.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /Anneal subagent model policy/);
};

test("platform hook restricts Agent and legacy Task to explicit approved model aliases", () => {
  for (const tool_name of ["Agent", "Task"]) {
    assert.match(tool_name, new RegExp(hook.matcher));
    for (const model of ["opus", "sonnet", "haiku"]) {
      assert.equal(invoke({ tool_name, tool_input: { model } }), null);
    }
    for (const model of [undefined, null, "", "inherit", "fable", "claude-fable-5-1", "Opus", "opusplan", {}, ["opus"]]) {
      denied({ tool_name, tool_input: { model } });
    }
  }
  assert.doesNotMatch("TaskOutput", new RegExp(hook.matcher));
  denied("{invalid");
  denied({ tool_name: "Agent" });
});

test("fork validates the current non-sidechain parent and cannot override Fable via model", () => {
  const cwd = mkdtempSync(join(tmpdir(), "claude-guard-"));
  try {
    const transcript_path = join(cwd, "transcript.jsonl");
    const input = { tool_name: "Agent", transcript_path, tool_input: { subagent_type: "fork", model: "opus" } };
    for (const model of ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "opus"]) {
      writeFileSync(transcript_path, JSON.stringify({ type: "assistant", message: { model } }) + "\n");
      assert.equal(invoke(input, cwd), null);
    }
    for (const model of ["claude-fable-5-1", "unknown", "opus-fable", "claude-opus-fable", null]) {
      writeFileSync(transcript_path, [
        { type: "assistant", message: { model: "claude-opus-5" } },
        { type: "assistant", message: { model } },
        { type: "assistant", isSidechain: true, message: { model: "claude-opus-5" } },
      ].map(row => JSON.stringify(row)).join("\n"));
      denied(input);
    }
    for (const transcript of ["", "{invalid", JSON.stringify({ type: "assistant", isSidechain: true, message: { model: "claude-opus-5" } })]) {
      writeFileSync(transcript_path, transcript);
      denied(input);
    }
    rmSync(transcript_path);
    denied(input);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("staged settings are independent of repository cwd and missing node blocks rather than allows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "claude-staged-guard-"));
  try {
    writeFileSync(join(cwd, "claude-platform-settings.json"), JSON.stringify(settings));
    assert.equal(invoke({ tool_name: "Agent", tool_input: { model: "opus" } }, cwd), null);
    const result = spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify({ tool_name: "Agent", tool_input: { model: "fable" } }),
      cwd, env: { PATH: cwd }, encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /guard failed to execute/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
