# Runner-isolation designs

## R9 runner-sandbox-containment

### Decision

The runner adds no container or VM sandbox and no post-delivery closeout
cleanup.

### Why

Both are over-defence for a single-operator deployment; isolation is per OS
account plus an ephemeral clone, and residual run directories are retained
failure scenes, not garbage.

### What exists instead

OS-account isolation (`scripts/os-isolation/`), workspace containment
observation, and the shared-checkout guard `scripts/run-scope-guard.sh`.

### Revisit when

The deployment serves untrusted repositories or more than one tenant.

## R10 workspace-reclaim-mechanism

### Decision

No automatic workspace reclaim mechanism beyond the existing intent-and-act
protocol.

### Why

Verification found the reclaim surface empty; leftover run directories are
intentional and reclaim never offers foreign-runner workspaces, an accepted
gap.

### What exists instead

Manual cleanup.

### Revisit when

No condition recorded.

## R11 run-scope-bypass-credential

### Decision

Run-scope bypass uses no runner token or lease.

### Why

A parent-process check answers the same question without new credential-shaped
state.

### What exists instead

The parent-process check in `scripts/run-scope-guard.sh`.

### Revisit when

No condition recorded.

## R12 container-sandbox-and-library-shape

### Decision

No container or cloud sandbox provider abstraction, no branch-strategy
abstraction, no library-shaped API or init scaffolding, no in-process iteration
loop, and no effect-system dependency.

### Why

Compared with single-process "one agent invocation" execution-kernel
libraries, this platform is a strict superset at the orchestration layer, so
only single-invocation ideas are borrowable.

### What exists instead

Process-level isolation and server-side chain orchestration.

### Revisit when

Untrusted repositories or multi-tenancy.
