import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { renderMergeExecutorFollowerSystemdUnit } from './merge-executor-follower-templates.mjs';
import { computeReleaseDigest } from './release-directory.mjs';
import { follow } from './merge-executor-follower.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40);
const old = 'b'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'executor-follow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployRoot = join(root, 'deploy');
  const executorRoot = join(root, 'executor');
  const entries = {
    'packages/merge-executor/dist/index.js': 'executor',
    'packages/db/dist/claim-contract.js': 'contract',
  };
  const files = Object.entries(entries).map(([path, body]) => ({ path, type: 'file', size: Buffer.byteLength(body), sha256: sha(body) })).sort((a,b) => a.path.localeCompare(b.path));
  const digest = sha(JSON.stringify(files));
  const candidate = join(deployRoot, 'releases', `${commit}-${digest}`);
  for (const [path, body] of Object.entries(entries)) {
    mkdirSync(dirname(join(candidate, path)), { recursive: true });
    writeFileSync(join(candidate, path), body, { mode: 0o666 });
  }
  writeFileSync(join(candidate, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, commit, digest, releaseName: `${commit}-${digest}`, files }));
  mkdirSync(join(executorRoot, 'releases', old), { recursive: true });
  symlinkSync(`releases/${old}`, join(executorRoot, 'current'));
  symlinkSync(`releases/${commit}-${digest}`, join(deployRoot, 'current'));
  const log = join(root, 'commands.log');
  const commands = {};
  for (const name of ['chown', 'chmod', 'systemctl', 'journalctl']) {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name} '"$*" >> '${log}'\n${name === 'chmod' ? '/bin/chmod "$@"' : name === 'systemctl' ? `if [ "$1" = show ]; then printf 'ActiveState=active\\nMainPID=123\\n'; fi` : name === 'journalctl' ? `if [ -f '${root}/mismatch' ]; then echo 'mechanical completion contract mismatch'; fi` : ':'}\n`, { mode: 0o755 });
    commands[name] = path;
  }
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ deployRoot, executorRoot, unit: 'agentos-merge-executor.service', nodePath: process.execPath, commands }), { mode: 0o600 });
  return { root, candidate, executorRoot, deployRoot, configPath, commands, log, run: (options = {}) => follow(configPath, { uid: () => 0, configOwner: process.getuid(), wait: async ms => assert.equal(ms, 30_000), ...options }), pointer: () => readlinkSync(join(executorRoot, 'current')), logs: () => readFileSync(log, 'utf8') };
}

test('adoption hardens, switches, restarts once, retains three; repeat is untouched', async t => {
  const f = fixture(t);
  for (const [name, date] of [['c', 10], ['d', 20], ['e', 30]]) {
    const path = join(f.executorRoot, 'releases', name.repeat(40));
    mkdirSync(path); utimesSync(path, date, date);
  }
  await f.run();
  assert.equal(f.pointer(), `releases/${commit}`);
  assert.match(f.logs(), /chown -R root:root/);
  assert.equal(f.logs().match(/systemctl restart/g).length, 1);
  assert.doesNotMatch(f.logs(), /sleep/);
  assert.equal(statSync(join(f.executorRoot, 'releases', commit, 'packages/db/dist/claim-contract.js')).mode & 0o022, 0);
  assert.deepEqual(readdirSync(join(f.executorRoot, 'releases')).sort(), [commit, old, 'e'.repeat(40)].sort());
  const before = f.logs();
  const dirs = readdirSync(f.executorRoot);
  await f.run();
  assert.equal(f.logs(), before);
  assert.deepEqual(readdirSync(f.executorRoot), dirs);
});

for (const [name, mutate, reason] of [
  ['changed byte', f => writeFileSync(join(f.candidate, 'packages/db/dist/claim-contract.js'), 'changed'), 'release-file-digest-mismatch'],
  ['unlisted file', f => writeFileSync(join(f.candidate, 'extra'), 'extra'), 'release-unlisted-file'],
  ['env', f => writeFileSync(join(f.candidate, '.env'), 'secret'), 'release-env-present'],
  ['missing dist', f => rmSync(join(f.candidate, 'packages/db/dist/claim-contract.js')), 'release-dist-missing'],
  ['missing manifest', f => rmSync(join(f.candidate, 'release-manifest.json')), 'release-manifest-missing'],
  ['missing pointer', f => rmSync(join(f.deployRoot, 'current')), 'deploy-current-unavailable'],
  ['dangling pointer', f => { rmSync(join(f.deployRoot, 'current')); symlinkSync('releases/missing', join(f.deployRoot, 'current')); }, 'deploy-current-unavailable'],
  ['inventory digest', f => { const p = join(f.candidate, 'release-manifest.json'); const m = JSON.parse(readFileSync(p)); m.files.reverse(); writeFileSync(p, JSON.stringify(m)); }, 'release-digest-mismatch'],
]) test(`refuses ${name} before executor writes`, async t => {
  const f = fixture(t); mutate(f);
  await assert.rejects(f.run, new RegExp(reason));
  assert.equal(f.pointer(), `releases/${old}`);
  assert.deepEqual(readdirSync(f.executorRoot).sort(), ['current', 'releases']);
  assert.deepEqual(readdirSync(join(f.executorRoot, 'releases')), [old]);
});

test('contract mismatch rolls pointer back and restarts twice, preserving candidate', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'mismatch'), '');
  await assert.rejects(f.run, /post-restart-contract-mismatch/);
  assert.equal(f.pointer(), `releases/${old}`);
  assert.equal(f.logs().match(/systemctl restart/g).length, 2);
  assert.ok(statSync(join(f.executorRoot, 'releases', commit)).isDirectory());
});

test('non-root production invocation refuses before reading config', async t => {
  const f = fixture(t);
  await assert.rejects(() => follow(f.configPath, { uid: () => 1000 }), /root-required/);
});

for (const [name, contents, reason] of [
  ['inactive', "printf 'ActiveState=failed\\nMainPID=0\\n'", 'post-restart-inactive'],
  ['pid changed', 'unused', 'post-restart-pid-changed'],
  ['journal unavailable', 'exit 1', 'journalctl-failed'],
  ['restart failure', 'exit 1', 'rollback-failed'],
]) test(`post-restart ${name} restores the previous pointer`, async t => {
  const f = fixture(t);
  if (name === 'journal unavailable') writeFileSync(f.commands.journalctl, `#!/bin/sh\n${contents}\n`);
  else if (name === 'pid changed') {
    const run = f.run;
    f.run = () => run({ wait: async () => writeFileSync(f.commands.systemctl, `#!/bin/sh\nprintf 'ActiveState=active\\nMainPID=456\\n'\n`) });
  }
  else writeFileSync(f.commands.systemctl, `#!/bin/sh\n${contents}\n`);
  await assert.rejects(f.run, new RegExp(reason));
  assert.equal(f.pointer(), `releases/${old}`);
});

test('immutable source tree with internal dependency links can be adopted', async t => {
  const f = fixture(t);
  mkdirSync(join(f.candidate, 'node_modules'));
  symlinkSync('../packages/db', join(f.candidate, 'node_modules/db'));
  const m = JSON.parse(readFileSync(join(f.candidate, 'release-manifest.json')));
  m.files.push({ path: 'node_modules/db', type: 'symlink', target: '../packages/db' });
  m.files.sort((a,b) => a.path.localeCompare(b.path));
  m.digest = computeReleaseDigest(f.candidate);
  assert.equal(m.digest, sha(JSON.stringify(m.files)), 'producer inventory agrees with follower fixture for nested files and internal symlink');
  m.releaseName = `${commit}-${m.digest}`;
  writeFileSync(join(f.candidate, 'release-manifest.json'), JSON.stringify(m));
  const newPath = join(f.deployRoot, 'releases', m.releaseName);
  // cp has to handle the read-only directory and file modes used by the real builder.
  const harden = path => {
    if (statSync(path).isDirectory()) for (const child of readdirSync(path)) {
      if (child !== 'db' || !path.endsWith('node_modules')) harden(join(path, child));
    }
    chmodSync(path, statSync(path).isDirectory() ? 0o555 : 0o444);
  };
  // Rename before making the parent tree immutable.
  renameSync(f.candidate, newPath);
  rmSync(join(f.deployRoot, 'current')); symlinkSync(`releases/${m.releaseName}`, join(f.deployRoot, 'current'));
  harden(newPath);
  try {
    await f.run();
    assert.equal(readlinkSync(join(f.executorRoot, 'releases', commit, 'node_modules/db')), '../packages/db');
  } finally {
    for (const root of [newPath, join(f.executorRoot, 'releases', commit)]) {
      const writable = path => { chmodSync(path, 0o755); for (const child of readdirSync(path, { withFileTypes: true })) if (child.isDirectory()) writable(join(path, child.name)); };
      if (existsSync(root)) writable(root);
    }
  }
});

for (const key of ['deployRoot', 'executorRoot', 'unit', 'nodePath']) test(`missing ${key} is a named config failure`, async t => {
  const f = fixture(t); const config = JSON.parse(readFileSync(f.configPath)); delete config[key];
  writeFileSync(f.configPath, JSON.stringify(config));
  await assert.rejects(f.run, new RegExp(`config-${key}-missing`));
});

test('Node input must be an executable file, not a directory', async t => {
  const f = fixture(t); const config = JSON.parse(readFileSync(f.configPath)); config.nodePath = f.root;
  writeFileSync(f.configPath, JSON.stringify(config));
  await assert.rejects(f.run, /config-nodePath-invalid/);
});

test('a failed adoption is poisoned until an administrator clears its marker', async t => {
  const f = fixture(t); const mismatch = join(f.root, 'mismatch');
  writeFileSync(mismatch, ''); await assert.rejects(f.run, /post-restart-contract-mismatch/);
  await assert.rejects(f.run, /release-adoption-poisoned/);
  assert.equal(f.logs().match(/systemctl restart/g).length, 2);
  rmSync(mismatch); rmSync(join(f.executorRoot, 'failed-adoptions', commit)); await f.run();
  assert.equal(f.pointer(), `releases/${commit}`);
  assert.equal(f.logs().match(/systemctl restart/g).length, 3);
});

for (const [field, value] of [['schemaVersion', 2], ['commit', old], ['releaseName', 'wrong']]) test(`refuses wrong manifest ${field}`, async t => {
  const f = fixture(t); const path = join(f.candidate, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(path)); manifest[field] = value; writeFileSync(path, JSON.stringify(manifest));
  await assert.rejects(f.run, /release-manifest-invalid/);
  assert.equal(f.pointer(), `releases/${old}`);
});


test('installed CLI reports a named nonzero failure for unavailable configuration', async t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [new URL('./merge-executor-follower.mjs', import.meta.url).pathname, '--config', join(f.root, 'missing.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, process.getuid() === 0 ? /config-unreadable/ : /root-required/);
  assert.equal(f.pointer(), `releases/${old}`);
});


test('stale directory lock from an interrupted old follower does not block adoption', async t => {
  const f = fixture(t);
  mkdirSync(join(f.executorRoot, '.follower-lock'));
  await f.run();
  assert.equal(f.pointer(), `releases/${commit}`);
});

test('live follower excludes another invocation and releases its lock afterward', async t => {
  const f = fixture(t);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = f.run({ wait: async () => { entered(); await held; } });
  await ready;
  // Restore the old pointer to exercise adoption rather than the no-op path.
  rmSync(join(f.executorRoot, 'current'));
  symlinkSync(`releases/${old}`, join(f.executorRoot, 'current'));
  try { await assert.rejects(f.run, /follower-busy/); }
  finally { release(); await first; }
  await f.run();
});

test('configured Node must resolve to the executable running the rendered service', async t => {
  const f = fixture(t);
  const unit = renderMergeExecutorFollowerSystemdUnit({
    nodePath: process.execPath,
    followerPath: new URL('./merge-executor-follower.mjs', import.meta.url).pathname,
    configPath: f.configPath,
  });
  assert.ok(unit.includes(`ExecStart=${process.execPath} `));
  const config = JSON.parse(readFileSync(f.configPath));
  config.nodePath = f.commands.systemctl;
  writeFileSync(f.configPath, JSON.stringify(config));
  await assert.rejects(f.run, /config-nodePath-mismatch/);
  assert.equal(f.pointer(), `releases/${old}`);
});

test('no-op skips inventory but still requires a valid manifest', async t => {
  const f = fixture(t); await f.run();
  writeFileSync(join(f.candidate, 'packages/db/dist/claim-contract.js'), 'changed');
  await f.run();
  rmSync(join(f.candidate, 'release-manifest.json'));
  await assert.rejects(f.run, /release-manifest-missing/);
});

test('rollback failure preserves the adoption mismatch reason', async t => {
  const f = fixture(t);
  writeFileSync(f.commands.journalctl, `#!/bin/sh\necho 'mechanical completion contract mismatch'\nprintf '#!/bin/sh\\nexit 1\\n' > '${f.commands.systemctl}'\n`);
  await assert.rejects(f.run, /rollback-failed:.*systemctl-failed.*original: post-restart-contract-mismatch/);
});

test('retention failure reports successful adoption and a named nonzero failure', async t => {
  const f = fixture(t);
  for (const name of ['c', 'd', 'e']) mkdirSync(join(f.executorRoot, 'releases', name.repeat(40)));
  writeFileSync(f.commands.chmod, '#!/bin/sh\nif [ "$2" = "u+w" ]; then exit 1; fi\n/bin/chmod "$@"\n');
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  await assert.rejects(f.run, /retention-failed/);
  assert.equal(f.pointer(), `releases/${commit}`);
  assert.ok(logs.some(line => line.includes(`adopted commit=${commit}`)));
});

test('unsafe config parent is refused', async t => {
  const f = fixture(t); chmodSync(f.root, 0o777);
  await assert.rejects(f.run, /config-unsafe/);
});

test('unsafe command parent is refused', async t => {
  const f = fixture(t); const bin = join(f.root, 'bin'); mkdirSync(bin); chmodSync(bin, 0o777);
  const command = join(bin, 'chown'); writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const config = JSON.parse(readFileSync(f.configPath)); config.commands.chown = command;
  writeFileSync(f.configPath, JSON.stringify(config));
  await assert.rejects(f.run, /config-unsafe/);
});

test('kernel releases follower lock after SIGKILL', async t => {
  const f = fixture(t);
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { follow } from ${JSON.stringify(new URL('./merge-executor-follower.mjs', import.meta.url).href)};
    await follow(${JSON.stringify(f.configPath)}, {
      uid: () => 0, configOwner: process.getuid(),
      wait: async () => { process.send('locked'); await new Promise(() => {}); }
    });
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const ready = once(child, 'message');
  const exited = once(child, 'exit');
  await Promise.race([ready, exited.then(() => { throw new Error('child exited before acquiring lock'); })]);
  child.kill('SIGKILL'); await exited;
  rmSync(join(f.executorRoot, 'current'));
  symlinkSync(`releases/${old}`, join(f.executorRoot, 'current'));
  await f.run();
  assert.equal(f.pointer(), `releases/${commit}`);
});

test('no-op reads only the manifest under the candidate', async t => {
  const f = fixture(t); await f.run();
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.readFileSync;
  const reads = [];
  const mock = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (String(path).startsWith(`${f.candidate}/`)) reads.push(String(path));
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await f.run();
    assert.deepEqual(reads, [join(f.candidate, 'release-manifest.json')]);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
