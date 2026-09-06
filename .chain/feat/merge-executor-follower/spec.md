Deploy: the merge executor adopts the control plane's deployed release on its own

Goal: after a control-plane deploy on a Linux host, the root-owned merge executor runtime is repointed to the same release and restarted without an administrator step, so the executor's completion contract can lag the API's for at most one follow interval.

Background: the merge executor is a separately installed, root-owned runtime
(`/opt/agentos/merge-executor/current -> releases/<oid>`, unit
`agentos-merge-executor.service`, per `docs/runbooks/merge-executor.md`
"Adopt a root-owned runtime" and "Code upgrades and rollback"), and
quiet-window auto-deploy states that it does not adopt it.
`RUN_COMPLETION_CONTRACT_VERSION` (`packages/db/src/claim-contract.ts`) is
shared by the API and the executor; when a release bumps it,
`mechanicalContractMismatch` refuses every mechanical claim, `claimOnce` in
`packages/merge-executor/src/index.ts` returns `contract-mismatch`, the
process exits 13 and systemd restarts it every 10 s. Three releases
(636d33fb, 3bb6232b, dd5a1ed3 via PR #505 on 2026-09-06) each stalled every
chain at Merge execution until an administrator copied the production release
into `/opt` by hand; the 2026-09-06 stall lasted 77 minutes with nine queued
mechanical runs. The runbook's manual adoption is already a copy of the
control plane's verified release directory
(`<deployRoot>/releases/<commit>-<digest>`, checked by `verifyReleaseDirectory`
in `scripts/deploy/release-directory.mjs` against `release-manifest.json`), so
the provenance of the executor's code is the control-plane deployer's build
today; what is missing is the automation and its verification.

Changes:
1. A self-contained follower program ships in `scripts/deploy/` (shell, or Node
   importing only the Node standard library). It is installed by root as a copy
   under `/opt/agentos/merge-executor/bin/` and run by a root systemd timer; it
   never executes code from the control plane's checkout or release tree.
2. Its inputs come from a root-owned config file of its own under
   `/etc/agentos/` (not the executor env file that
   `packages/merge-executor/src/config.ts` reads): the control-plane deploy
   root, the executor root (`/opt/agentos/merge-executor`), the systemd unit
   name, and the Node path. A missing or unreadable input is a named failure
   with a non-zero exit.
3. Target selection reads the control plane's `current` release pointer under
   the deploy root. When the executor's `current` already resolves to
   `releases/<that commit>`, the run logs the commit and exits 0 without
   touching anything.
4. Before adoption the candidate is verified the way `verifyReleaseDirectory`
   verifies: directory name `<commit>-<digest>`, manifest `schemaVersion` 1,
   manifest commit equal to the name, every listed file present with the listed
   sha256, no unlisted file, and the digest recomputed as the sha256 over the
   manifest's file inventory JSON equal to the name's digest. It also refuses a
   tree containing a `.env` or lacking `packages/merge-executor/dist/index.js`
   or `packages/db/dist/claim-contract.js`. Any failure aborts before anything
   under the executor root is written.
5. Adoption copies the candidate into `releases/<commit>.tmp-<random>` under the
   executor root, sets `root:root` ownership, removes group and world write
   bits while keeping read and traverse bits, renames it to
   `releases/<commit>`, records the current target, then replaces `current`
   atomically (a symlink created beside it and renamed over it).
6. After the switch the follower restarts the unit and verifies that the unit
   is active with an unchanged main PID 30 s later and that the journal since
   the restart contains no `mechanical completion contract mismatch` line. On
   verification failure it repoints `current` to the recorded previous
   release, restarts again, and exits non-zero with a named reason, leaving the
   new release directory in place for diagnosis.
7. After a successful adoption, release directories other than the current one
   and the two most recent are removed; the run that adopts a release never
   removes the release it replaced.
8. Ownership, permission and service-control operations go through commands the
   follower resolves from its config or defaults (`chown`, `chmod`,
   `systemctl`, `journalctl`), so the test suite can run it unprivileged with
   substitutes; in production the defaults apply and the follower refuses to
   run when not root.
9. `docs/runbooks/merge-executor.md` gains the follower install: the config
   file, the unit and timer rendered from templates in `scripts/deploy/`
   (`OnBootSec` and a 5-minute `OnUnitActiveSec`), and post-install checks.
   Its "Code upgrades and rollback" section states that adoption is automatic
   on Linux, that the manual procedure remains the rollback path, and that the
   Darwin profile stays manual. The sentence in
   `docs/runbooks/quiet-window-auto-deploy.md` that places the executor outside
   the activation set names the follower as the executor's path.
10. A test file beside the follower in `scripts/deploy/` covers: no-op, each
    verification refusal (digest mismatch, unlisted file, `.env` present,
    missing dist file), successful adoption with pointer flip and retention,
    and rollback when the post-restart check fails, using a temporary root and
    substituted commands.

Out of scope: adding the executor to the quiet-window service inventory or the
auto-deploy activation set; running the executor as the API user or relaxing
any hardening directive of its unit; the executor's exit-13 behaviour on a
contract mismatch or `RUN_COMPLETION_CONTRACT_VERSION` handling; Darwin
LaunchDaemon automation; any sudoers or privilege grant to the `agentos`
account; how a refused claim is shown on the board or in the inbox.

Constraints: nothing but the follower and an administrator writes under the
executor root; the executor's env file and unit file are never modified; every
failure is a named non-zero exit with the reason in the journal, never a
silent fallback; a run that finds the control plane mid-deploy (pointer
missing, dangling, or manifest missing) exits non-zero and leaves the executor
untouched, and the next timer tick retries.

Acceptance:
1. The follower test file is green under the `scripts/deploy` test script that
   owns it, and `npm run test:auto-deploy` stays green.
2. With a temporary deploy root whose `current` points at a valid
   `<commit>-<digest>` release and an executor root at an older release, one
   run leaves `current -> releases/<commit>`, the copied tree with no group or
   world write bit, the substituted chown invoked with `root:root`, and the
   substituted restart invoked once.
3. A second run with the same inputs exits 0, invokes no restart, and creates
   no directory.
4. Changing one byte of a listed file, adding an unlisted file, placing a
   `.env`, and removing `packages/db/dist/claim-contract.js` each make the run
   exit non-zero with a distinct named reason and leave `current` unchanged.
5. When the substituted post-restart check reports a mismatch line, the run
   exits non-zero, `current` points at the previous release again, and restart
   was invoked twice.
6. The retention case leaves exactly the current release plus the two most
   recent others.
7. The rendered unit and timer are covered by a fixture test, and
   `systemd-analyze verify` on the rendered unit is clean on a Linux host.

Route: implementation=senior-dev-astra-medium - root-run adoption with an atomic pointer flip, rollback and retention windows; partial-state and ordering failures are outside what the acceptance suite can witness
