# Merge-gate designs

## R4 affected-tests-only-gate

### Decision

The merge gate does not run only impacted tests.

### Why

The gate's authority comes from running the exact integrated head; narrowing to
affected tests downgrades evidence to a guess.

### What exists instead

The full gate, sped up only by scheduling (serial steps regrouped into
concurrent groups) and by removing per-fixture process startup.

### Revisit when

No condition recorded.

## R5 gate-scheduling-target

### Decision

No scheduling change is pursued to reach a fixed gate wall-clock target.

### Why

The gate is work-bound: total core-seconds divided by achievable packing
efficiency sets a floor that no scheduling, including a full DAG, can pass;
only removing work or adding a machine moves it.

### What exists instead

Publish the arithmetic and measure fresh numbers from gate logs, never from
memory.

### Revisit when

The work total changes materially.

## R6 decouple-lane-width-from-worker-capacity

### Decision

Worker capacity and per-gate lane width stay derived from one constant.

### Why

The invariant is that N concurrent gates sum to one machine; lane count is
derived by `scripts/merge-gate.sh` from host parallelism divided by
`AGENTOS_GATE_HOST_SHARE`, and widening lanes was measured to change nothing
because the database and CPU saturate together.

### What exists instead

The single derived constant.

### Revisit when

No condition recorded.

## R7 two-static-database-waves

### Decision

Database tests are not split into two static waves.

### Why

The first implementation starved the small wave and made the worker slower.

### What exists instead

One pooled database wave.

### Revisit when

No condition recorded.

## R8 per-database-checkpoint-templates

### Decision

Checkpoint templates are not cloned per test database.

### Why

Migration replay is a fraction of a second; the measured cost is process
startup of the migration tool, so the refactor would buy nothing.

### What exists instead

One `PrismaClient` reused for the fixture lifetime; schema-clone provisioning
left as is.

### Revisit when

No condition recorded.
