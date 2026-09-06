# Merge executor operator runbook

This is the current public authority for provisioning and maintaining the
self-hosted `@anneal/merge-executor`. It covers GitHub.com, a dedicated local
service identity, a Linux systemd profile the maintainer runs in production,
and a macOS LaunchDaemon profile nobody has run. The support matrix carries the
classification of each; this runbook does not describe mosonlab's installation
or any private operator service.

The executor is fail closed. A missing permission, unreadable field, shared
principal, unsafe key path, failed disarm, or uncertain merge result stops the
mechanical run; there is no token, identity, or service fallback.

## Security model

Create a private GitHub App owned by the account or organization where Anneal
runs. A public operator cannot install another organization's private App and
must not try to reuse one. The App acts as itself through short-lived
installation access tokens; it never acts for a GitHub user.

Use all of these boundaries:

- install the private App with **Only select repositories** and select only
  repositories this executor is authorized to merge;
- do not request OAuth user authorization and leave Device Flow disabled;
- disable the webhook and select no event subscriptions;
- run the executor as one dedicated, non-admin OS user, distinct from the API
  user and every model-runner user;
- keep the GitHub App private key in a non-empty regular file of at most 64 KiB,
  owned by the executor uid with no group or world access, below directories
  that are not group- or world-writable;
- give the API and executor one executor-only bearer, distinct from
  `OPERATOR_TOKEN` and `RUNNER_TOKEN`; and
- expose only the executor subset of configuration to the executor service.

The private key bytes never belong in `.env`, a plist, a unit, an argument,
GitHub Actions, a fixture, or a log. `MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY_FILE`
is only the non-secret absolute path. The process reads key bytes after it has
claimed a mechanical run and passed the OS isolation gate, mints one installation
token, and retains neither token across runs.

GitHub changes settings pages over time. The concepts above are stable; quoted
labels in this runbook describe the current UI and may drift. Follow GitHub's
official [registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[permission](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app),
and [private-key](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
documentation when a label has moved.

## GitHub App permission contract

Set every unlisted repository permission to **No access**. Seven permissions are
mandatory for the executor's ordinary fail-closed decision path. Workflows
read/write is the additional supported path for a merge whose resulting tree
changes a file below `.github/workflows/`.

| GitHub repository permission | Access | Status | Named source operation |
| --- | --- | --- | --- |
| Administration | Read | Mandatory | GraphQL `READ_QUERY`: `repository.branchProtectionRules` and each rule's required-check policy. An unreadable rule is not treated as no protection. |
| Checks | Read | Mandatory | GraphQL `READ_QUERY`: `commit.statusCheckRollup.contexts` entries of type `CheckRun`. |
| Commit statuses | Read | Mandatory | GraphQL `READ_QUERY`: `commit.statusCheckRollup.contexts` entries of type `StatusContext`. |
| Contents | Read and write | Mandatory | REST `GET /repos/{owner}/{repo}/git/commits/{head}` and `GET /git/trees/{tree}?recursive=1`; REST `POST /git/trees` (`createSanitizedTree`) and `POST /git/commits` (`createMergeCommit`); GraphQL `updateRefs` (`updateBaseRef`). |
| Merge queues | Read and write | Mandatory | GraphQL `READ_QUERY`: `repository.mergeQueue` and `pullRequest.mergeQueueEntry`; GraphQL `dequeuePullRequest` (`dequeuePullRequest`). Read failure is never interpreted as no queue. |
| Metadata | Read | Mandatory | GraphQL `READ_QUERY`: repository identity, ref, object IDs, and ordinary repository metadata used to bind all other reads. GitHub includes Metadata read as the App baseline. |
| Pull requests | Read and write | Mandatory | GraphQL `READ_QUERY`: PR state, head/base, mergeability, merge commit, author, auto-merge, and queue state; GraphQL `disablePullRequestAutoMerge` (`disablePullRequestAutoMerge`). |
| Workflows | Read and write | Workflow-file support | The executor has no separate Workflows API call. GitHub requires this permission in addition to Contents write when `createSanitizedTree`, `createMergeCommit`, or `updateBaseRef` adopts a tree changing `.github/workflows/`. Install it to support those authorized PRs; otherwise such PRs must stop at GitHub's refusal. |

App authentication also calls
`POST /app/installations/{installation_id}/access_tokens` using an App JWT. That
exchange is bound by the App ID, installation ID, private key, selected
repositories, and the installation permissions above; it is not OAuth, Device
Flow, or a user token operation.

Every GitHub mutation is enumerated in
`packages/merge-executor/src/github.ts` as `MUTATING_OPERATIONS`. Use the
following evidence; a process merely staying alive proves none of these writes.

| Mutating operation | Required permission | Verification evidence |
| --- | --- | --- |
| `createSanitizedTree` — `POST /git/trees` | Contents write; Workflows write too when the retained tree changes workflow files | The first controlled Anneal chain PR contains `.chain/` on its head. After the App-bot merge, inspect the landed tree and record that `.chain/` is absent. |
| `createMergeCommit` — `POST /git/commits` | Contents write; Workflows write for a workflow-changing result | The mechanical `merge-result` names the new commit SHA; GitHub shows a two-parent merge commit whose parents are the authorized base and exact reviewed head. |
| `updateBaseRef` — GraphQL `updateRefs` | Contents write; Workflows write for a workflow-changing result | The selected base ref equals the recorded merge commit and the old base was its first parent. A concurrent base change must instead record `ref-update-refused`. |
| `disablePullRequestAutoMerge` — GraphQL mutation | Pull requests write | In a controlled, merge-blocked test PR with auto-merge armed, exercise a stop/disarm path; record the run activity and verify GitHub reports auto-merge disabled. |
| `dequeuePullRequest` — GraphQL mutation | Merge queues write | On a repository that uses a merge queue, put a controlled, merge-blocked test PR in the queue and exercise a stop/disarm path; record the activity and verify the queue entry is gone. Repositories without a queue do not fabricate this evidence. |

After an App permission change, GitHub may require an organization owner to
approve the changed installation. Treat the installation as unavailable until
the selected-repository page shows the intended permission set again.

## Run the capture wizard

First complete the ordinary local setup so the root `.env` exists at mode 0600
and contains distinct `OPERATOR_TOKEN` and `RUNNER_TOKEN` values:

```sh
npm run setup:local
bash scripts/setup-merge-executor.sh
```

Run the capture mode as the repository operator, never as root. It makes no
GitHub API request, creates no account, installs no key or service, and invokes
no privileged command. It opens official documentation and requires the human
to confirm each GitHub or administrator-owned step. A declined confirmation or
failed prerequisite exits with a named error; there is no skipped stage.

The wizard preserves an existing `.env` assignment when Enter is pressed and
replaces it only when the human types a new value. It validates all values
before writing any of them. Secret entry uses hidden terminal input. Because the
repository operator cannot and must not traverse the mode-0700 executor-owned
directory, key validation uses a separately confirmed administrator handoff.
The administrator invokes the wizard's announced, read-only
`--inspect-key-metadata` mode; it reads only `stat` metadata—path, regular-file
kind, owner uid, mode, size, and every parent-directory mode—and emits one
`MERGE_EXECUTOR_KEY_METADATA_V1` receipt. Capture mode validates the pasted
receipt without opening or traversing the key path. Neither mode reads key
bytes.

On success, both `.env` and `.merge-executor.env` are mode 0600. The second file
is an untracked service-install input containing only executor variables. Keep
it out of tickets, logs, shell arguments, and version control.

| Wizard-captured value | `.env` destination | `.merge-executor.env` destination | Runtime consumer |
| --- | --- | --- | --- |
| `MERGE_EXECUTOR_OS_USER` | Same key | Same key | Executor startup isolation gate |
| `MERGE_EXECUTOR_PEER_USERS` | Same key | Same key | Executor startup isolation gate |
| `MERGE_EXECUTOR_RUNNER_ID` | Same key | Same key | Executor claim/start/heartbeat/complete calls |
| `MERGE_EXECUTOR_RUNNER_IDS` | Same key | Not copied | API claim allowlist |
| `MERGE_EXECUTOR_API_URL` | Same key | Same key | Executor control-plane client |
| `MERGE_EXECUTOR_GITHUB_APP_ID` | Same key | Same key | App JWT issuer |
| `MERGE_EXECUTOR_GITHUB_APP_INSTALLATION_ID` | Same key | Same key | Installation-token endpoint |
| `MERGE_EXECUTOR_IDENTITY_LOGIN` | Same key | Same key | Own-merge replay determination |
| `MERGE_EXECUTOR_GITHUB_APP_PRIVATE_KEY_FILE` | Path only | Path only | Isolation gate and per-claim key reader |
| `MERGE_EXECUTOR_TOKEN` | Same key, hidden input | Same key | API authenticates it; executor presents it |

The root `.env` remains the rerun authority and gives the API the allowlist and
executor bearer. Do not point a service at the whole root `.env`: it also holds
the operator, runner, database, session, and encryption credentials. Adopt only
`.merge-executor.env` into the executor service profile.

## Service installation

All commands in this section are administrator-owned and are separate from the
wizard. Read the complete matching profile, substitute every `<placeholder>`,
and confirm the resolved paths and identities before running it. Never paste a
literal angle-bracket placeholder into a shell or service definition.

The common layout is:

- root-owned runtime: `/opt/agentos/merge-executor/current`;
- root-owned service configuration: `/etc/agentos/merge-executor.env`;
- root-owned start definition: a LaunchDaemon plist plus non-privileged start
  script on macOS, or a systemd unit on Linux;
- executor-owned key: `<merge-executor-home>/secrets/github-app.pem`, mode 0600;
- logs: `/var/log/agentos/merge-executor/` on macOS or the systemd journal on
  Linux.

Create `<merge-executor-user>` and `<merge-executor-group>` with the host's
approved account-management tool. The account must have a private home, a
non-login shell where the platform supports it, no administrator/sudo/wheel
membership, and no shared uid with the API or runner. Explicitly verify:

```sh
id <merge-executor-user>
id <api-os-user>
id <model-runner-os-user>
```

Install the downloaded key only after inspecting the resolved source and
destination paths. This is a human-only administrator action:

```sh
sudo install -d -o <merge-executor-user> -g <merge-executor-group> -m 0700 <merge-executor-home>/secrets
sudo install -o <merge-executor-user> -g <merge-executor-group> -m 0600 <downloaded-private-key> <merge-executor-home>/secrets/github-app.pem
cd <repository-root>
sudo bash scripts/setup-merge-executor.sh --inspect-key-metadata <merge-executor-user> <merge-executor-home>/secrets/github-app.pem
```

The final command is the wizard's separately invoked, read-only administrator
mode. It makes no change and prints one non-secret metadata receipt, not key
bytes. Paste that entire receipt into capture mode when prompted. The repository
operator does not receive search permission on the private home or the 0700
`secrets` directory. Remove the download only after capture mode accepts the
receipt. Never use `cat`, command substitution, or a diagnostic that prints key
bytes.

### Adopt a root-owned runtime

Build and test a clean, named commit as an unprivileged operator. The temporary
staging tree is not the serving checkout and contains no `.env` or App key:

```sh
git status --short
npm ci
npm run db:generate
npm run build -w @anneal/github-client
npm run build -w @anneal/db
npm run build -w @anneal/merge-executor
npm run test -w @anneal/merge-executor
git rev-parse HEAD
```

Stop the executor before adoption. Copy `package.json`, `package-lock.json`,
`node_modules/`, and `packages/` from that exact clean build into a fresh
versioned directory below `/opt/agentos/merge-executor/releases/<release-oid>`.
Recursively change that directory to `root:<root-group>` and remove group/world
write permission. Only then replace the root-owned `current` symlink. Do not
build in the root-owned runtime and do not let the service account own or modify
it. Keep the previous release until post-install verification passes.

The path layout is portable across the two profiles; the actual Node executable
is not. Resolve it once with `command -v node`, verify it is an absolute regular
executable outside a user-writable version-manager directory, and substitute
that exact path for `<absolute-node>` below. Neither profile relies on `PATH`.

### macOS LaunchDaemon

The LaunchDaemon uses a root-owned, non-setuid start script because launchd has
no `EnvironmentFile` directive. Launchd drops to `<merge-executor-user>` before
the script runs. The script can read a root-owned, group-readable configuration
file and then replaces itself with the explicit Node executable; it never runs
as root and contains no `sudo`.

Install `.merge-executor.env` as root and the executor's private group, then
create `/usr/local/libexec/agentos-merge-executor-start` with these exact
contents after substituting paths:

```sh
#!/bin/sh
set -eu
set -a
. /etc/agentos/merge-executor.env
set +a
exec <absolute-node> /opt/agentos/merge-executor/current/packages/merge-executor/dist/index.js
```

The administrator applies ownership and mode explicitly:

```sh
sudo install -d -o root -g <root-group> -m 0755 /etc/agentos /usr/local/libexec /var/log/agentos/merge-executor
sudo install -o root -g <merge-executor-group> -m 0640 .merge-executor.env /etc/agentos/merge-executor.env
sudo chown root:<root-group> /usr/local/libexec/agentos-merge-executor-start
sudo chmod 0755 /usr/local/libexec/agentos-merge-executor-start
```

Create `/Library/LaunchDaemons/io.agentos.merge-executor.plist` as root:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.agentos.merge-executor</string>
  <key>UserName</key><string>&lt;merge-executor-user&gt;</string>
  <key>GroupName</key><string>&lt;merge-executor-group&gt;</string>
  <key>WorkingDirectory</key><string>/opt/agentos/merge-executor/current</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/libexec/agentos-merge-executor-start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/var/log/agentos/merge-executor/stdout.log</string>
  <key>StandardErrorPath</key><string>/var/log/agentos/merge-executor/stderr.log</string>
</dict>
</plist>
```

Confirm the definition and bootstrap it into the system domain. `RunAtLoad` and
`KeepAlive` provide restart at boot and after failure:

```sh
sudo chown root:<root-group> /Library/LaunchDaemons/io.agentos.merge-executor.plist
sudo chmod 0644 /Library/LaunchDaemons/io.agentos.merge-executor.plist
sudo plutil -lint /Library/LaunchDaemons/io.agentos.merge-executor.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.agentos.merge-executor.plist
sudo launchctl print system/io.agentos.merge-executor
```

For later restarts use `sudo launchctl kickstart -k
system/io.agentos.merge-executor`. A bootstrap or kickstart error is a stop;
do not fall back to a per-user LaunchAgent, the API user, or root.

### Linux systemd

The merge-executor unit in this section remains operator-installed and is
outside the quiet-window service inventory. The service inventory's Linux
systemd installer, sudoers control grant, activation, and rollback procedure
is documented in [Quiet-window auto-deploy — Linux systemd](quiet-window-auto-deploy.md#linux-systemd);
that installer covers the API, inbox, runner, web, and auto-deploy units, not
the merge executor. Keep this executor unit as a separate operator procedure.

systemd reads the root-only environment file before dropping privileges, so it
can remain mode 0600. Create `/etc/systemd/system/agentos-merge-executor.service`
as root after substituting the user, group, and Node path:

```ini
[Unit]
Description=Anneal merge executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<merge-executor-user>
Group=<merge-executor-group>
WorkingDirectory=/opt/agentos/merge-executor/current
EnvironmentFile=/etc/agentos/merge-executor.env
ExecStart=<absolute-node> /opt/agentos/merge-executor/current/packages/merge-executor/dist/index.js
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
```

Install the wizard output and unit, validate them, and enable restart at boot:

```sh
sudo install -d -o root -g <root-group> -m 0755 /etc/agentos
sudo install -o root -g <root-group> -m 0600 .merge-executor.env /etc/agentos/merge-executor.env
sudo chown root:<root-group> /etc/systemd/system/agentos-merge-executor.service
sudo chmod 0644 /etc/systemd/system/agentos-merge-executor.service
sudo systemd-analyze verify /etc/systemd/system/agentos-merge-executor.service
sudo systemctl daemon-reload
sudo systemctl enable --now agentos-merge-executor.service
sudo systemctl status agentos-merge-executor.service
```

For later restarts use `sudo systemctl restart
agentos-merge-executor.service`. A unit failure is a stop; do not remove the
hardening directives or run the process as root to make it start.

### Why no passwordless sudo or generic root helper is installed

Normal executor work needs no privilege: it reads one owner-only key, calls the
loopback or configured API, and calls GitHub. Administrator authority is needed
only for account creation, key installation, root-owned runtime/config updates,
and service-manager changes. These are infrequent, separately reviewed actions.

Neither profile installs passwordless sudo, a setuid binary, nor a generic root
copy/restart helper. Such a helper would turn a compromise of the repository
operator or executor into durable root execution and would erase the root-owned
adoption boundary. The macOS start script is not such a helper: launchd starts
it after selecting the unprivileged uid, it executes one fixed path, and it has
no sudo or write operation.

## Post-install verification

### Startup and regular health

First require the service manager to report the configured non-root uid and a
running process. Review logs for `merge executor started` and for no
`merge-executor startup refused:` lines. Startup logs name only public paths and
identifiers; never add key or token diagnostics.

The executor reports through the same runner registry as model runners. Query
the operator-only `/runners` endpoint without placing `OPERATOR_TOKEN` in argv:

```sh
umask 077
auth_config=$(mktemp)
printf 'header = "Authorization: Bearer %s"\n' "$OPERATOR_TOKEN" > "$auth_config"
curl --fail --silent --show-error --config "$auth_config" "$MERGE_EXECUTOR_API_URL/runners"
rm -f "$auth_config"
```

Find the `daemons` row whose `runnerId` exactly equals
`MERGE_EXECUTOR_RUNNER_ID`. Require `online: true`, a fresh `lastSeenAt`, and
`workspaceRoot: null` and `diskFreeBytes: null`. A model runner using the
executor id populates workspace or disk telemetry and is unhealthy. An absent
or stale row or authentication failure is also unhealthy. Check `/runners`
regularly and alert on staleness; service-manager liveness alone does not prove
the API recognizes the principal.

`/runners` does not expose the executor adapter or CLI identity. After a claim
has started, inspect that mechanical Run record and require its `adapterVersion`
and `cliVersion` fields to both equal `merge-executor-v1`. Keep this Run-record
check in first-positive and incident evidence; do not expect those fields in the
daemon row.

### First positive App-bot merge

Use a controlled repository selected in the App installation and a disposable
PR that travels through the normal Anneal authorization, regression, and merge
chain. Do not bypass a gate to create evidence. Record together:

1. the authorization activity and exact reviewed head/base SHAs;
2. a successful mechanical `merge-result` naming the merge commit;
3. GitHub's PR view showing `<app-slug>[bot]` as the merger;
4. the two merge parents matching the authorized base and head;
5. the landed tree containing no `.chain/`; and
6. the base ref at the recorded merge commit.

That is the first positive evidence for App authentication, mandatory read
permissions, sanitized-tree creation, merge-commit creation, and atomic base-ref
update. It does not prove the two disarm mutations or workflow-file support;
exercise the controlled cases in the mutation table when those capabilities are
part of the installation.

### Train-prefix publication

The merge executor may receive a `merge-authorization` with an optional `train`
object. The control plane produces this object; operators do not construct or
edit it. It identifies a cumulative prefix commit and the candidate's position
within that prefix:

```json
{
  "train": {
    "publishHead": "<40-hex prefix SHA>",
    "predecessorOid": "<40-hex predecessor SHA>",
    "ref": "refs/anneal/train/<publishHead>",
    "position": 1,
    "trainTaskId": "<train task id>"
  }
}
```

An authorization without `train` keeps the ordinary single-candidate behavior
described above. For a train authorization, the executor completes every live
state check before making a write. The pull request head must equal the
authorized `headSha`; `refs/anneal/train/<publishHead>` must exist and resolve
to `publishHead`; `publishHead` must contain the authorized head as an
ancestor; and the default branch must equal `baseSha` at position 1, or be an
ancestor of `publishHead` at later positions. A failed check records the
`train-precondition-failed` stop with the failing check and makes no GitHub
write.

Once those checks pass, the executor publishes the prefix by updating
`refs/heads/<default branch>` to `publishHead` through GitHub's git-refs API
with the App installation token. The update is never forced and must be a
fast-forward. The send is bounded by `GUARDED_MERGE_SENDS`, uses the same
idempotency key and `confirmedWrite` read-back discipline as the ordinary merge
API call, and rechecks `superseded-authorization` at the same points. If the
default branch already equals `publishHead` or contains it, the update is
skipped. A GitHub non-fast-forward refusal records `train-publish-rejected`.

After publication, and on replay when the ref update already happened, the
executor reads the candidate pull request again. It reports `merged` only when
the pull request is merged and its merge commit is the prefix commit for this
candidate: the commit reachable from `publishHead` whose second parent is the
authorized `headSha`, with parents exactly `(predecessor, headSha)`. The
predecessor is `baseSha` at position 1 and the previous prefix commit at later
positions. The GitHub `mergedByLogin` value need not be the executor identity
for this path; the prefix lineage supplies the authorization check. A merged
pull request with another shape still records `changed-underneath-me`.

When the candidate at the highest position in a prefix reports `merged`, the
executor deletes `refs/anneal/train/<publishHead>`. A deletion failure is
logged for operator follow-up and does not stop the run.

## Rotation and recovery

### Rotate the executor API token

Stop the executor. Generate a new high-entropy value without printing it, then
update `MERGE_EXECUTOR_TOKEN` in the API's mode-0600 `.env` and the root-owned
executor service configuration through a protected temporary file. Refuse the
change if it equals `OPERATOR_TOKEN` or `RUNNER_TOKEN`. Restart the API, restart
the executor, verify `/runners`, and complete new positive merge evidence before
destroying the protected staging copy. There is no dual-token or shared-token
fallback; plan a short fail-closed maintenance interval.

### Rotate a GitHub App private key

Generate a second key in the same App, install it at a new owner-only path, and
run the wizard metadata validation. Update only the service configuration's
path, restart, and obtain positive merge evidence. Then delete the old key in
GitHub and remove the old local file. Never overwrite the only working key in
place, and never compare keys by printing their bytes.

### Recover from a lost App key

GitHub cannot show a downloaded private key again. If App administration is
still available, generate a replacement key and follow the rotation procedure.
If the App or its installation is no longer administrable, register a new
private installation-local App with the exact permission contract, install it
on selected repositories, and replace the App ID, installation ID, bot login,
and key path together. Re-run every verification class. Revoke the abandoned
App/installation when account access is recovered. Never weaken custody or use
a personal token as recovery.

## Code upgrades and rollback

Treat each upgrade as a new root-owned runtime adoption:

1. stop the executor and leave the API running fail closed;
2. fetch and check out the intended tag or commit in an unprivileged clean
   staging checkout;
3. install locked dependencies, build, run the merge-executor tests and the
   repository merge gate, and record the exact commit;
4. copy that build into a new root-owned, non-writable release directory;
5. atomically repoint `current`, restart the service, and verify `/runners` plus
   positive App-bot evidence; and
6. retain the previous directory until verification succeeds.

On a code regression, stop the service, repoint `current` to the previous
root-owned release, restart, and repeat verification. Do not roll back
configuration or keys unless the failure is demonstrably in those inputs.

The repository's quiet-window auto-deploy includes
`packages/merge-executor/dist` in the serving checkout's build publication.
That may update the serving checkout's executor dist, but it **does not adopt
that build into `/opt/agentos/merge-executor/current` and does not restart a
separately root-owned executor service**. Root-owned adoption remains the
explicit administrator procedure above; treating an auto-deploy build as
already adopted runs stale code while reporting a misleading upgrade.
