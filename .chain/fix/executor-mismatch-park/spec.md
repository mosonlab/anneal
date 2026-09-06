Merge executor: a contract mismatch parks the daemon alive and re-checks on an interval

Goal: an executor whose completion-contract version differs from the API's stays running, logs the mismatch once, re-checks the claim on a fixed interval, and resumes claiming by itself when the versions agree again, instead of exiting and being restarted by the service manager every ten seconds.

Background: `pollClaims` in `packages/merge-executor/src/index.ts` is documented
as parking the daemon on `contract-mismatch` ("so unconditional service-manager
restart policies cannot turn incompatibility into a slower claim loop"). It
does so by awaiting `waitForAbort(signal)`, which only registers an `abort`
listener. Nothing keeps the Node event loop alive while that promise is
pending, so Node exits with status 13 ("Detected unsettled top-level await")
within a second of the mismatch; systemd's `Restart=always` with
`RestartSec=10` then restarts it, and the daemon re-claims, mismatches and
exits again. On 2026-09-06 the production unit restarted 402 times in 77
minutes, each cycle writing five journal lines. The park never happened; the
comment describes behaviour the code does not have. With the mismatch being a
version pair that only a code adoption on either side can resolve, the daemon
also needs to notice when the API side changes (a rollback or a forward
deploy) without a restart.

Changes:
1. On `contract-mismatch`, `pollClaims` stays alive: it waits for the recheck
   interval using a timer that keeps the event loop alive (or an equivalent
   live handle), then issues the next claim. It returns only when the signal
   aborts.
2. The recheck interval is `MERGE_EXECUTOR_CONTRACT_RECHECK_MS`, parsed in
   `packages/merge-executor/src/config.ts` like the other positive-integer
   settings, default 60 000, and passed into `pollClaims` by `main`.
3. Logging is per state change, not per attempt: one `log.error` on entering
   the mismatched state (with both versions, as today), one `log.info` when a
   claim succeeds or returns idle after a mismatch ("contract mismatch
   cleared"), and nothing while the state is unchanged. `claimOnce` no longer
   logs the mismatch itself; `pollClaims` owns that log.
4. The comment on `pollClaims` describes the new behaviour.
5. `docs/runbooks/merge-executor.md` "Startup and regular health" states that a
   mismatch shows as one journal line and an alive unit, and names the recheck
   setting.

Out of scope: the API side of the mismatch (`mechanicalContractMismatch`, the
TaskActivity, the inbox alert); the systemd unit and its restart policy; the
release adoption automation; any other exit path of the daemon; claim-loop
error handling for non-mismatch errors.

Constraints: the daemon never exits on its own because of a mismatch; a
mismatched daemon issues at most one claim per recheck interval; SIGTERM and
SIGINT still end `pollClaims` promptly while it is waiting; no new dependency.

Acceptance:
1. `packages/merge-executor/src/index.test.ts`: with an injected sleep and a
   claim that returns `contract-mismatch` twice then `idle`, `pollClaims`
   calls claim three times, sleeps the recheck interval (not the poll
   interval) between the first two, logs exactly one error and one
   "cleared" info line, and returns only after the signal aborts.
2. A test spawns a Node child process that runs `pollClaims` from the built or
   tsx-loaded module with a claim always returning `contract-mismatch` and a
   real 50 ms recheck interval, asserts the child is still alive after 300 ms
   and has not written an exit code, then sends SIGTERM and asserts it exits 0.
3. `config.test.ts` covers the default and a rejected non-positive value of
   `MERGE_EXECUTOR_CONTRACT_RECHECK_MS`.
4. `npm run test -w @anneal/merge-executor` and `npm run lint` are green.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity for this change
