# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.9.0 (Developer Preview) | Yes, on the target platform only — see [`docs/release/support-matrix.md`](docs/release/support-matrix.md) |
| 0.8.0 and earlier | No. A developer preview is superseded by the next one; there is no backport path. |

There is no patch stream and no backport path. A fix ships as the next release; published
tags and release assets are immutable and are never rewritten in place.

## Read the boundaries before you report

[`docs/release/security.md`](docs/release/security.md) states what
the current boundaries are and — more usefully — where they stop. Several
properties people reasonably expect are **not** claimed by this release, and are
documented as absent rather than treated as defects:

- Anneal is not a sandbox. The provider adapters launch the coding CLI with
  non-interactive permission-bypass flags, and with the shipped same-user default
  the agent runs with your own user's authority. Anneal grants are a
  control-plane authorization and audit boundary, not operating-system
  containment.
- There is no enforced network isolation. A fresh installation labels its
  environment open because it is.
- It is loopback-only, with no remote authentication design at all — no login, no
  per-user identity, no session model for anyone but the machine's own operator.
  Exposing any of it beyond `127.0.0.1`, by tunnel, reverse proxy or otherwise, is
  outside the supported surface.
- The repository access level does not gate delivery's push. Treat any repository
  you register as writable by the agent.

A report that an agent could modify files it was pointed at, or that a service
exposed on the network has no authentication, describes documented behaviour
rather than a vulnerability. The known limitations sections of
`docs/release/security.md` and `CHANGELOG.md` list the gaps already known
to us, including the Files path-walk race.

Findings that **are** in scope include: a way to reach a Files Root outside its
grant, a way to obtain operator authority from a runner or per-run session
principal, a secret reaching the browser bundle or a log, a path that decrypts or
exfiltrates stored secrets, a way to make the control plane listen off loopback,
or a migration path that reaches the database without its preflight.

## Reporting

**Do not open a public issue for a security report.**

Use GitHub's private vulnerability reporting on this repository: the **Security**
tab, then **Report a vulnerability**. That channel is private to the maintainers
and lets us reply to you.

If private reporting is unavailable to you, open a public issue that says only
that you have a security report and asks for a private channel. Put no details,
no reproduction, and no affected paths in it.

Please include, in the private channel: the exact commit or tag, the platform,
what you ran, what happened, and what you expected instead. A reproduction we can
run is worth more than a description of one.

## What to expect

This is a single-maintainer Developer Preview, not a funded security programme.
We do not promise a response time, we run no bounty, and we cannot commit to a
fix date. What we will do is read the report, tell you whether we consider it in
scope, and — if a fix ships — say so in `CHANGELOG.md`. If we decide not to fix
something, we will say that too, rather than leave the report open indefinitely.

Please give us a reasonable opportunity to respond before publishing. We will not
ask you to stay quiet indefinitely.
