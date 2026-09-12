# Out-of-scope designs

This directory records designs that were considered and refused, with one page
per refused design area. Each page holds entries with the headings `Decision`,
`Why`, `What exists instead`, and `Revisit when`.

An entry is a standing decision until a page or ADR supersedes it. A proposal
that contradicts an entry must cite the entry and argue its revisit condition.

Read the pages whose scope overlaps the proposed change, including any current
decisions they reference. Each page carries the reasons and revisit conditions;
this index routes to those decisions.

| When changing or proposing | Read |
| --- | --- |
| Merge queuing, Lease waits, or Run ownership of the Merge Lease | [Merge tail](merge-tail.md) |
| Merge gate coverage, scheduling, worker capacity, or database test provisioning | [Merge gate](merge-gate.md) |
| Runner containment, workspace retention or reclaim, scope bypass, or execution abstractions | [Runner isolation](runner-isolation.md) |
| Database shapes, query limits, event retention, canonical identity, or quotas | [Data model](data-model.md) |
| Deployment safeguards, rollback, or source-build fallback removal | [Deployment](deployment.md) |
| Supported operating systems or claim-rejection retry behavior | [Platform scope](platform-scope.md) |
