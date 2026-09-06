import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIVE_RUN_STATUSES as SERVER_ACTIVE_RUN_STATUSES } from "@anneal/db";

import { ACTIVE_RUN_STATUSES } from "@/lib/board";

/**
 * The board decides on its own which runs are still live, because it holds only
 * the wire projection and cannot call the control plane's guards. That makes it
 * a second copy of a set the server owns, and the failure it can produce is
 * silent: a RunStatus added as active server-side would leave the board showing
 * cancel on nothing and retry on a live run.
 *
 * `RUN_STATUS_IS_ACTIVE` in `lib/board.ts` makes *omitting* a status a compile
 * error; this test makes *disagreeing* about one a test failure. Together they
 * are the exhaustiveness the single list could not give. The import is test-only
 * on purpose: the app bundle must not pull `@anneal/db`'s Prisma runtime in.
 */
test("the board's active run statuses are exactly the control plane's", () => {
  assert.deepEqual(
    [...ACTIVE_RUN_STATUSES].sort(),
    [...SERVER_ACTIVE_RUN_STATUSES].sort(),
  );
});
