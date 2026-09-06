Runner: session events are bounded end to end, with a byte cap per event and a bounded, back-pressured delivery queue

Goal: a runner cannot grow its in-memory event queue without bound when the API rejects or cannot accept events, the API refuses oversized event payloads, and the two limits are designed together so neither side can wedge the other.

Background: the runner buffers provider events in memory (`packages/runner/src/runner.ts:299-330`, `pendingEvents`), sends up to 250 per request and removes them only after a successful send; heartbeat renewal is independent of delivery (`:554-556`), so a run whose event writes keep failing (API 503, network) stays leased while the queue grows until the process runs out of memory before `maxDurationMin`; several runners on one host amplify it. On the API side `packages/api/src/run-lifecycle.ts:89-104` limits the number of events per request but no byte size, `routes/runner.ts:246-250` parses the body with no `bodyLimit`, and `SessionEvent.payload` has no size cap; SessionEvent is ~95% of database size. A naive API 413 would make a batch fail forever because the runner only dequeues on success. PI event dieting is already in place (`adapters/pi.ts:89-98`).

Changes:
1. Runner: bound `pendingEvents` by bytes (default 32 MiB) and count; when the bound is reached, drop the oldest non-essential events (tool output chunks, streaming deltas) and keep lifecycle and error events, recording one synthetic `events-dropped` event with counts; expose queue bytes in the heartbeat payload for observability. Batches are formed by bytes (default 1 MiB) as well as count.
2. Runner: a single event larger than the per-event cap is truncated client-side to the cap with a `truncated: true` marker and original size, so no batch can be rejected for one oversized event.
3. API: enforce a per-event payload byte cap (same constant, shared via `@anneal/db` or the wire contract) and a request `bodyLimit` sized to the batch cap plus overhead; an oversized event is rejected with a named 413 body that identifies the offending event index so the runner can drop that one and resend the rest, not the whole batch.
4. Runner: on a 413 naming an index, drop that event (recording a synthetic marker) and retry the batch; on 5xx/network keep retrying with the existing backoff while the bound from item 1 protects memory.
5. Document the caps and the drop policy in `docs/operator-api.md` (events route) and in the runner section of `docs/architecture.md`.

Out of scope: database retention or pruning of SessionEvent/TaskActivity (separate operator decision), PI adapter dieting, heartbeat semantics, TaskActivity protocol records.

Constraints: lifecycle and error events are never dropped; every drop or truncation is itself recorded; the caps are defined once and shared, not duplicated as literals; no change to event ordering for kept events.

Acceptance: `npm run test -w @anneal/runner` and `-w @anneal/api` green; runner tests cover: queue reaching the byte bound drops oldest chunk events and emits the marker, lifecycle events survive, heartbeat carries queue bytes; a 413 naming index 3 drops only that event and the resend succeeds; API tests cover: an event over the cap returns the named 413 with the index, a request over `bodyLimit` is refused; `RUNNER_WORKSPACE_ROOT` set for runner tests. Handbook and architecture doc updated.

Route: implementation=senior-dev-opus-high - a liveness and backpressure design across two processes; the failure (memory growth under sustained API rejection) cannot be witnessed by the acceptance suite against a real provider