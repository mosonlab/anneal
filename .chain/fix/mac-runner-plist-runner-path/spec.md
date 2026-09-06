# Deploy: a Mac runner definition rendered by the launchd installer finds the provider CLIs

Route: implementation=senior-dev-opus-medium - one installer template change plus a fixture; Moson 20260906 chose Opus for repair-class work

Depends on: chain a0adf8a2 (chore/single-launchd-wrapper) — it rewrites the launchd installer/wrapper this chain changes.

## Goal
A `com.agentos.runner-N` LaunchAgent rendered by `install-launchd-services.mjs` for the runner role runs Claude and Codex sessions without hand edits.

## Background
On 2026-09-06 the Mac runner inventory grew from 6 to 8 with `AGENTOS_DEPLOY_ROLE=runner AGENTOS_RUNNER_COUNT=8 AGENTOS_RUNNER_ID_PREFIX=mac- node scripts/deploy/install-launchd-services.mjs --apply --replace-existing`. The two new plists carried the canonical environment: `PATH` and `RUNNER_PATH` both set to `<node dir>:/usr/local/bin:/usr/bin:/bin`. The wrapper (`shared/bin/agentos-service-wrapper.mjs`) applies `shared/.env` with dotenv's non-override rule, so the plist value of `RUNNER_PATH` won over the `.env` value that includes `~/.npm-global/bin`, `claude` was not on the path, and three Claude steps failed with `cli-missing: the CLI did not answer --version (exit 127)` (tasks cmtpn8gih0djkdbb1w30m123m, cmtpo6mdl0jvudbb1x1x2kulk, cmtpng5ob0eevdbb1oa1fy6kh). The six older plists were migrated in place and kept their inline `RUNNER_PATH` from the earlier appliance install, which is why they were unaffected. Fixed by hand with `plutil -replace EnvironmentVariables.RUNNER_PATH`.

## Changes
1. The runner-role plist rendered on macOS does not set `RUNNER_PATH` inline when `shared/.env` defines it; when `.env` does not define it, the rendered value includes the directories the installer can prove hold the configured provider CLIs (`CLAUDE_BINARY`/`CODEX_BINARY` when set, otherwise the `claude`/`codex` resolved from the installing user's PATH), and the installer refuses with a named STOP when neither CLI resolves.
2. Plan output lists, per runner definition, the effective `RUNNER_PATH` source (`.env` or rendered) so the operator sees it before `--apply`.
3. The wrapper fixture proves that a rendered definition plus a `.env` with `RUNNER_PATH` yields the `.env` value in the child environment.

## Out of scope
- Linux systemd unit rendering.
- Migrating the six pre-existing Mac plists to the canonical shape.
- Runner claim behaviour, `RUNNER_SERVED_KINDS`, or auto-deploy.

## Constraints
- Fail loud: never render a `RUNNER_PATH` that cannot reach a configured provider CLI.
- Preserve the existing `--replace-existing` migration behaviour for already-installed definitions.

## Acceptance
- Installer unit tests: rendering a runner-role definition with `.env` `RUNNER_PATH` set leaves `RUNNER_PATH` out of the plist; without it, the rendered `RUNNER_PATH` contains the directory of the resolved `claude` binary; with no resolvable CLI the installer exits with a STOP naming the missing binary.
- Plan output for `AGENTOS_DEPLOY_ROLE=runner` prints the `RUNNER_PATH` source per definition.
- Wrapper fixture green; `scripts/deploy` suites green.
