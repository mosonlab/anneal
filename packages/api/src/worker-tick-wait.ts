/** Shared by the merge worker suites, which both drive a real poll interval and
 *  need to observe a tick rather than sleep past one. */

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Patience, not a timing assumption: the loop returns the moment the condition
 *  holds, so this budget only bounds the failure case — a worker that never
 *  ticks fails here rather than hanging the suite. The size comes from the
 *  loaded gate worker, not an idle one; see "Test timing on the gate worker" in
 *  CONTRIBUTING.md. */
export const WORKER_TICK_BUDGET_MS = 30_000;

export const waitUntil = async (predicate: () => boolean, timeoutMs = WORKER_TICK_BUDGET_MS): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await wait(25);
  }
};
