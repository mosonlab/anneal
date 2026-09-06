import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
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
  for (const name of ['chown', 'chmod', 'systemctl', 'journalctl', 'sleep']) {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name} '"$*" >> '${log}'\n${name === 'chmod' ? '/bin/chmod "$@"' : name === 'systemctl' ? `if [ "$1" = show ]; then printf 'ActiveState=active\\nMainPID=123\\n'; fi` : name === 'journalctl' ? `if [ -f '${root}/mismatch' ]; then echo 'mechanical completion contract mismatch'; fi` : ':'}\n`, { mode: 0o755 });
    commands[name] = path;
  }
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ deployRoot, executorRoot, unit: 'agentos-merge-executor.service', nodePath: process.execPath, commands }), { mode: 0o600 });
  return { root, candidate, executorRoot, deployRoot, configPath, commands, log, run: () => follow(configPath, { uid: () => 0, configOwner: process.getuid() }), pointer: () => readlinkSync(join(executorRoot, 'current')), logs: () => readFileSync(log, 'utf8') };
}

test('adoption hardens, switches, restarts once, retains three; repeat is untouched', t => {
  const f = fixture(t);
  for (const [name, date] of [['c', 10], ['d', 20], ['e', 30]]) {
    const path = join(f.executorRoot, 'releases', name.repeat(40));
    mkdirSync(path); utimesSync(path, date, date);
  }
  f.run();
  assert.equal(f.pointer(), `releases/${commit}`);
  assert.match(f.logs(), /chown -R root:root/);
  assert.equal(f.logs().match(/systemctl restart/g).length, 1);
  assert.match(f.logs(), /sleep 30/);
  assert.equal(statSync(join(f.executorRoot, 'releases', commit, 'packages/db/dist/claim-contract.js')).mode & 0o022, 0);
  assert.deepEqual(readdirSync(join(f.executorRoot, 'releases')).sort(), [commit, old, 'e'.repeat(40)].sort());
  const before = f.logs();
  const dirs = readdirSync(f.executorRoot);
  f.run();
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
]) test(`refuses ${name} before executor writes`, t => {
  const f = fixture(t); mutate(f);
  assert.throws(f.run, new RegExp(reason));
  assert.equal(f.pointer(), `releases/${old}`);
  assert.deepEqual(readdirSync(f.executorRoot).sort(), ['current', 'releases']);
  assert.deepEqual(readdirSync(join(f.executorRoot, 'releases')), [old]);
});

test('contract mismatch rolls pointer back and restarts twice, preserving candidate', t => {
  const f = fixture(t); writeFileSync(join(f.root, 'mismatch'), '');
  assert.throws(f.run, /post-restart-contract-mismatch/);
  assert.equal(f.pointer(), `releases/${old}`);
  assert.equal(f.logs().match(/systemctl restart/g).length, 2);
  assert.ok(statSync(join(f.executorRoot, 'releases', commit)).isDirectory());
});

test('non-root production invocation refuses before reading config', t => {
  const f = fixture(t);
  assert.throws(() => follow(f.configPath, { uid: () => 1000 }), /root-required/);
});

for (const [name, contents, reason] of [
  ['inactive', "printf 'ActiveState=failed\\nMainPID=0\\n'", 'post-restart-inactive'],
  ['pid changed', 'unused', 'post-restart-pid-changed'],
  ['journal unavailable', 'exit 1', 'journalctl-failed'],
  ['restart failure', 'exit 1', 'rollback-failed'],
]) test(`post-restart ${name} restores the previous pointer`, t => {
  const f = fixture(t);
  if (name === 'journal unavailable') writeFileSync(f.commands.journalctl, `#!/bin/sh\n${contents}\n`);
  else if (name === 'pid changed') writeFileSync(f.commands.sleep, `#!/bin/sh\ncat > '${f.commands.systemctl}' <<'SCRIPT'\n#!/bin/sh\nprintf 'ActiveState=active\\nMainPID=456\\n'\nSCRIPT\n`);
  else writeFileSync(f.commands.systemctl, `#!/bin/sh\n${contents}\n`);
  assert.throws(f.run, new RegExp(reason));
  assert.equal(f.pointer(), `releases/${old}`);
});

test('immutable source tree with internal dependency links can be adopted', t => {
  const f = fixture(t);
  mkdirSync(join(f.candidate, 'node_modules'));
  symlinkSync('../packages/db', join(f.candidate, 'node_modules/db'));
  const m = JSON.parse(readFileSync(join(f.candidate, 'release-manifest.json')));
  m.files.push({ path: 'node_modules/db', type: 'symlink', target: '../packages/db' });
  m.files.sort((a,b) => a.path.localeCompare(b.path));
  m.digest = sha(JSON.stringify(m.files));
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
    f.run();
    assert.equal(readlinkSync(join(f.executorRoot, 'releases', commit, 'node_modules/db')), '../packages/db');
  } finally {
    for (const root of [newPath, join(f.executorRoot, 'releases', commit)]) {
      const writable = path => { chmodSync(path, 0o755); for (const child of readdirSync(path, { withFileTypes: true })) if (child.isDirectory()) writable(join(path, child.name)); };
      if (existsSync(root)) writable(root);
    }
  }
});

for (const key of ['deployRoot', 'executorRoot', 'unit', 'nodePath']) test(`missing ${key} is a named config failure`, t => {
  const f = fixture(t); const config = JSON.parse(readFileSync(f.configPath)); delete config[key];
  writeFileSync(f.configPath, JSON.stringify(config));
  assert.throws(f.run, new RegExp(`config-${key}-missing`));
});

test('Node input must be an executable file, not a directory', t => {
  const f = fixture(t); const config = JSON.parse(readFileSync(f.configPath)); config.nodePath = f.root;
  writeFileSync(f.configPath, JSON.stringify(config));
  assert.throws(f.run, /config-nodePath-invalid/);
});

test('a failed adoption can be retried using the verified diagnostic release', t => {
  const f = fixture(t); const mismatch = join(f.root, 'mismatch');
  writeFileSync(mismatch, ''); assert.throws(f.run, /post-restart-contract-mismatch/);
  rmSync(mismatch); f.run();
  assert.equal(f.pointer(), `releases/${commit}`);
  assert.equal(f.logs().match(/systemctl restart/g).length, 3);
});

for (const [field, value] of [['schemaVersion', 2], ['commit', old], ['releaseName', 'wrong']]) test(`refuses wrong manifest ${field}`, t => {
  const f = fixture(t); const path = join(f.candidate, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(path)); manifest[field] = value; writeFileSync(path, JSON.stringify(manifest));
  assert.throws(f.run, /release-manifest-invalid/);
  assert.equal(f.pointer(), `releases/${old}`);
});


test('installed CLI reports a named nonzero failure for unavailable configuration', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [new URL('./merge-executor-follower.mjs', import.meta.url).pathname, '--config', join(f.root, 'missing.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, process.getuid() === 0 ? /config-unreadable/ : /root-required/);
  assert.equal(f.pointer(), `releases/${old}`);
});
