#!/usr/bin/env node
// Installed as a root-owned copy. Never import modules from a deployed release.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const REVISION = /^[0-9a-f]{40}$/u;
const RELEASE = /^([0-9a-f]{40})-([0-9a-f]{64})$/u;
const MANIFEST = 'release-manifest.json';
const REQUIRED = ['packages/merge-executor/dist/index.js', 'packages/db/dist/claim-contract.js'];
const defaults = { chown: '/usr/bin/chown', chmod: '/usr/bin/chmod', systemctl: '/usr/bin/systemctl', journalctl: '/usr/bin/journalctl', sleep: '/usr/bin/sleep' };
const fail = (reason, detail = '') => { throw new Error(`${reason}${detail ? `: ${detail}` : ''}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => path.startsWith(`${root}${sep}`);
function named(reason, operation) {
  try { return operation(); } catch (error) { fail(reason, error.message); }
}
function directory(path, reason) {
  const stat = named(reason, () => lstatSync(path));
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(reason, path);
}
function readConfig(path, owner) {
  const stat = named('config-unreadable', () => lstatSync(path));
  if (!stat.isFile() || stat.uid !== owner || (stat.mode & 0o022)) fail('config-unsafe', path);
  const config = named('config-invalid', () => JSON.parse(readFileSync(path, 'utf8')));
  for (const key of ['deployRoot', 'executorRoot', 'unit', 'nodePath']) {
    if (typeof config?.[key] !== 'string' || !config[key]) fail(`config-${key}-missing`);
  }
  for (const key of ['deployRoot', 'executorRoot', 'nodePath']) {
    if (!isAbsolute(config[key])) fail(`config-${key}-invalid`);
  }
  if (!/^[A-Za-z0-9_.@-]+\.service$/u.test(config.unit) || config.unit.startsWith('-')) fail('config-unit-invalid');
  for (const key of ['deployRoot', 'executorRoot']) {
    directory(config[key], `config-${key}-unreadable`);
    config[key] = realpathSync(config[key]);
  }
  if (config.deployRoot === config.executorRoot || inside(config.deployRoot, config.executorRoot) || inside(config.executorRoot, config.deployRoot)) fail('config-roots-overlap');
  config.commands = { ...defaults, ...config.commands };
  for (const [key, path] of Object.entries({ nodePath: config.nodePath, ...config.commands })) {
    if (typeof path !== 'string' || !isAbsolute(path)) fail(`config-${key}-invalid`);
    named(`config-${key}-unreadable`, () => accessSync(path, constants.R_OK | constants.X_OK));
    if (!lstatSync(realpathSync(path)).isFile()) fail(`config-${key}-invalid`);
  }
  return config;
}
function command(config, name, args) {
  const result = spawnSync(config.commands[name], args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${name}-failed`, result.error?.message ?? `exit=${result.status} ${result.stderr.trim()}`);
  return result.stdout;
}
function inventory(root) {
  const files = [];
  function visit(directoryPath, prefix = '') {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === '.env' || entry.name.startsWith('.env.')) fail('release-env-present', path);
      if (path === MANIFEST) continue;
      const absolute = join(root, path);
      if (entry.isDirectory()) visit(absolute, path);
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (isAbsolute(target) || !inside(root, resolve(dirname(absolute), target))) fail('release-symlink-invalid', path);
        const resolved = named('release-symlink-invalid', () => realpathSync(absolute));
        if (!inside(root, resolved)) fail('release-symlink-invalid', path);
        files.push({ path, type: 'symlink', target });
      } else if (entry.isFile()) {
        const bytes = readFileSync(absolute);
        files.push({ path, type: 'file', size: bytes.byteLength, sha256: hash(bytes) });
      } else fail('release-entry-invalid', path);
    }
  }
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function verify(root, commit, digest) {
  directory(root, 'release-directory-invalid');
  const manifestPath = join(root, MANIFEST);
  const status = named('release-manifest-missing', () => lstatSync(manifestPath));
  if (!status.isFile()) fail('release-manifest-invalid');
  const manifest = named('release-manifest-invalid', () => JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest?.schemaVersion !== 1 || manifest.commit !== commit || manifest.releaseName !== `${commit}-${digest}` || !Array.isArray(manifest.files)) fail('release-manifest-invalid');
  const observed = inventory(root);
  for (const path of REQUIRED) {
    if (!observed.some(file => file.path === path && file.type === 'file')) fail('release-dist-missing', path);
  }
  if (hash(JSON.stringify(manifest.files)) !== digest || manifest.digest !== digest) fail('release-digest-mismatch');
  const expected = new Map();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || expected.has(file.path)) fail('release-manifest-invalid');
    expected.set(file.path, file);
  }
  for (const file of observed) {
    const wanted = expected.get(file.path);
    if (!wanted) fail('release-unlisted-file', file.path);
    if (file.type === 'file' && (file.sha256 !== wanted.sha256 || file.size !== wanted.size)) fail('release-file-digest-mismatch', file.path);
    if (JSON.stringify(file) !== JSON.stringify(wanted)) fail('release-file-inventory-mismatch', file.path);
    expected.delete(file.path);
  }
  if (expected.size) fail('release-file-missing', expected.keys().next().value);
  if (JSON.stringify(observed) !== JSON.stringify(manifest.files)) fail('release-file-inventory-mismatch');
}
function pointer(root, reason) {
  const path = join(root, 'current');
  const target = named(reason, () => {
    readlinkSync(path);
    return realpathSync(path);
  });
  directory(target, reason);
  if (dirname(target) !== join(root, 'releases')) fail(reason, 'not-a-direct-release');
  return target;
}
function flip(root, target) {
  const temporary = join(root, `.current-${randomUUID()}`);
  try {
    symlinkSync(target, temporary);
    renameSync(temporary, join(root, 'current'));
  } finally { rmSync(temporary, { force: true }); }
}
function health(config) {
  const output = command(config, 'systemctl', ['show', config.unit, '--property=ActiveState', '--property=MainPID']);
  const state = Object.fromEntries(output.trim().split('\n').map(line => line.split('=')));
  if (state.ActiveState !== 'active' || !/^[1-9][0-9]*$/u.test(state.MainPID ?? '')) fail('post-restart-inactive');
  return state.MainPID;
}
function retain(config, commit, previous) {
  const releases = join(config.executorRoot, 'releases');
  const others = readdirSync(releases, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && REVISION.test(entry.name) && entry.name !== commit)
    .map(entry => ({ name: entry.name, time: lstatSync(join(releases, entry.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
  // The release just replaced always occupies a rollback slot, even after a manual rollback.
  const keep = new Set([commit, previous]);
  for (const entry of others) if (keep.size < 3) keep.add(entry.name);
  for (const entry of others) if (!keep.has(entry.name)) {
    const path = join(releases, entry.name);
    command(config, 'chmod', ['-R', 'u+w', path]);
    rmSync(path, { recursive: true });
  }
}

// Tests inject identity only through this module API; the installed CLI always checks real uid.
export function follow(configPath = '/etc/agentos/merge-executor-follower.json', { uid = () => process.getuid(), configOwner = 0 } = {}) {
  if (uid() !== 0) fail('root-required');
  const config = readConfig(configPath, configOwner);
  const candidate = pointer(config.deployRoot, 'deploy-current-unavailable');
  const match = RELEASE.exec(basename(candidate));
  if (!match) fail('release-name-invalid');
  const [, commit, digest] = match;
  // Also require the manifest on the no-op path: a mid-deploy tree is never success.
  verify(candidate, commit, digest);
  const previousPath = pointer(config.executorRoot, 'executor-current-unavailable');
  const previous = basename(previousPath);
  if (!REVISION.test(previous)) fail('executor-current-invalid');
  if (previous === commit) { console.log(`merge-executor-follower no-op commit=${commit}`); return; }
  directory(join(config.executorRoot, 'releases'), 'executor-releases-invalid');
  const lock = join(config.executorRoot, '.follower-lock');
  named('follower-busy', () => mkdirSync(lock, { mode: 0o700 }));
  const temporary = join(config.executorRoot, 'releases', `${commit}.tmp-${randomUUID()}`);
  try {
    // Refuse a concurrent administrator pointer change instead of overwriting it.
    if (pointer(config.executorRoot, 'executor-current-unavailable') !== previousPath) fail('executor-current-changed');
    const destination = join(config.executorRoot, 'releases', commit);
    let exists = false;
    try { lstatSync(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) verify(destination, commit, digest);
    else {
      cpSync(candidate, temporary, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      // Reverify the private copy to close races with source changes during copying.
      verify(temporary, commit, digest);
    }
    const adopted = exists ? destination : temporary;
    command(config, 'chown', ['-R', 'root:root', '--no-dereference', adopted]);
    command(config, 'chmod', ['-R', 'go-w', adopted]);
    if (!exists) renameSync(temporary, destination);
    flip(config.executorRoot, `releases/${commit}`);
    try {
      const since = `@${(Date.now() / 1000).toFixed(3)}`;
      command(config, 'systemctl', ['restart', config.unit]);
      const pid = health(config);
      command(config, 'sleep', ['30']);
      if (health(config) !== pid) fail('post-restart-pid-changed');
      const journal = command(config, 'journalctl', ['--unit', config.unit, '--since', since, '--no-pager', '--output=cat']);
      if (journal.includes('mechanical completion contract mismatch')) fail('post-restart-contract-mismatch');
    } catch (error) {
      named('rollback-failed', () => {
        flip(config.executorRoot, `releases/${previous}`);
        command(config, 'systemctl', ['restart', config.unit]);
      });
      throw error;
    }
    retain(config, commit, previous);
    console.log(`merge-executor-follower adopted commit=${commit} previous=${previous}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2 && !(process.argv.length === 4 && process.argv[2] === '--config')) fail('arguments-invalid');
    named('follower-operation-failed', () => follow(process.argv[3]));
  } catch (error) {
    console.error(`merge-executor-follower failed: ${error.message}`);
    process.exitCode = 1;
  }
}
