# Architecture decision records

- [0001 - Narrow the merge lease hold window](0001-merge-lease-hold-window.md) — Superseded by ADR-0003 (2026-08-28).
- [0002 - Coordinate concurrent host deliveries with cumulative merge prefixes](0002-coordinate-main-delivery-with-merge-trains.md) — Accepted (2026-08-27).
- [0003 - Acquire the merge lease in readiness](0003-acquire-merge-lease-in-readiness.md) — Accepted (2026-08-28).
- [0004 - Publish ready Chains through a merge train](0004-publish-chains-through-a-merge-train.md) — Accepted (2026-09-07).
- [0005 - Zero human gates by default](0005-zero-human-gates-by-default.md) — Accepted (2026-09-08).
- [0006 - Merge lease is not a correctness boundary](0006-merge-lease-is-not-a-correctness-boundary.md) — Accepted (2026-09-08).
- [0007 - One check instead of a mechanism](0007-one-check-instead-of-a-mechanism.md) — Accepted (2026-09-08).
- [0008 - Templates are immutable once used](0008-templates-are-immutable-once-used.md) — Accepted (2026-09-08).
- [0009 - Review and repair shape](0009-review-and-repair-shape.md) — Accepted (2026-09-08).
- [0010 - Cross-family review before dispatch](0010-cross-family-review-before-dispatch.md) — Accepted (2026-09-08).

Entry uniqueness is checked against entry headings. A recursive full-text
search also matches slugs in index links and cross-references; those link
targets do not define additional entries. To find the defining heading for a
Reference slug, use:

```sh
rg '^#{2,3} .*<slug>' docs/out-of-scope docs/adr
```
