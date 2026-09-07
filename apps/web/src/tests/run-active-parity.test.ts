import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIVE_RUN_STATUSES as SERVER_ACTIVE_RUN_STATUSES } from "@anneal/db/board-contract";

import { ACTIVE_RUN_STATUSES } from "@/lib/board";

test("the board's active run statuses are exactly the control plane's", () => {
  assert.deepEqual(
    [...ACTIVE_RUN_STATUSES].sort(),
    [...SERVER_ACTIVE_RUN_STATUSES].sort(),
  );
});
