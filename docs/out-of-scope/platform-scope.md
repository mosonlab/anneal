# Platform-scope designs

## R18 native-windows-support

### Decision

Native Windows is unsupported and off the roadmap.

### Why

Six semantic blockers, not path joining: the control-plane directory native
module uses `openat`/`O_NOFOLLOW` with no Windows branch and loads at API start;
`control-plane-directory.ts` asserts `geteuid` and mode `0o700`; process-group
kills and process-table scans in `exec.ts` and `runtime.ts`; `flock` plus
mkdir/mv mirror locks; ownership keyed on device and inode; mode-bit and
symlink refusals used as security invariants.

### What exists instead

WSL2 is the supported route, a documentation statement only.

### Revisit when

No condition recorded; this item is the lowest priority and is not a reason
for other work.

## R19 transient-claim-rejection-latching

### Decision

Transient claim rejections are not latched.

### Why

Network jitter once made spec reads time out and latched tasks in Backlog.

### What exists instead

Transient rejections auto-requeue with backoff; non-transient rejections latch
for the operator, so a card visibly returning to Backlog and retrying is
designed behaviour.

### Revisit when

No condition recorded.
