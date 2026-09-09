# 0009 - Review and repair shape

Status: Accepted (2026-09-08)

## Context

Review findings and merge-tail repairs already have distinct responsibilities.
The chain needs a direct disposition path, while the merge tail keeps its
mechanical repair and audit protections without adding another authority layer.

## Decision

### K11 `no-independent-adjudication-step`

Direct Chains have no separate adjudication Step. The fix Step decides each
finding, refusing P0 or P1 only with an unreachability argument.

**Why:** Fix-Step cost tracks implementation-Step cost because the driver is a
fresh-context rebuild plus Regression re-run, not finding count.

#### Revisit when

No condition recorded.

### K12 `blind-review-authority-layer-removed`

Independent blind review as a gate, the review-fix loop, and the
release-authority signing layer were removed wholesale. Defense triggers only
write an audit message while the merge proceeds.

**Why:** Both guards cost two extra review rounds per Chain and collided with
every migration.

#### Revisit when

No condition recorded.

### K13 `mirror-lock-is-an-optimization`

The runner's bare-mirror `mkdir`/`mv` lock saves work and is not a correctness
boundary.

**Why:** git's own ref lock is the correctness line; a wrong steal
yields an explicit git error, not corruption.

#### Revisit when

No condition recorded.

### K14 `merge-gate-isolated-install`

`scripts/merge-gate.sh` runs its own separate `npm ci`.

**Why:** Concurrent Merge gates once deleted each other's `node_modules`; the
runner dependency cache is tuned by `DEPENDENCY_CACHE_ENTRY_LIMIT`, not by
sharing installs.

#### Revisit when

No condition recorded.

## Consequences

- The fix Step is the sole adjudicator in a direct Chain, leaving one fewer
  agent per Chain.
- Gate-fix, refresh-conflict repair, and Regression's review-fail path remain.
- The migration registry and gate attestation remain.
- The residual race in which a live mirror-lock holder is judged dead is
  accepted; git reports a wrong steal explicitly.
- Merge-gate time includes its own dependency install.
