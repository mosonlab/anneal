import assert from "node:assert/strict";
import test from "node:test";

import { mergeTrainTaskDescription } from "./merge-train-task.js";

const candidate = {
  taskId: "readiness-1",
  chainId: "00000000-0000-4000-8000-000000000001",
  headSha: "a".repeat(40),
  branch: "agentos/chain-1",
};

test("merge-train task description carries the exact runtime payload and instruction", () => {
  const description = mergeTrainTaskDescription({
    baseSha: "b".repeat(40),
    width: 1,
    candidates: [candidate],
  });

  assert.match(description, /Run only the exact command below, then finish/u);
  assert.match(description, /\$\{AGENTOS_TOOLS\}\/merge-train\.sh/u);
  assert.match(description, /"schemaVersion": 1/u);
  assert.match(description, /"taskId": "readiness-1"/u);
});
