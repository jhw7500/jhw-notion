import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DeploymentError, acquireLease, trustedDirectory } from './runtime-safety.mjs';

const C = fs.constants;
const RELEASE = /^r-([a-f0-9]{40}|[a-f0-9]{64})-([a-f0-9]{64})$/;
const ACTIVATION = /^a-[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 100000;
const MAX_FILE = 128 * 1024 * 1024;
const MAX_MANIFEST = 32 * 1024 * 1024;
// Closed v1 manifests (all listed keys required; no additional keys):
// release: { version, releaseId, sourceRevision, sourceDigest, contentDigest,
//            dirty, createdAt, entries }
// activation: { version, activationId, releaseId, predecessorActivationId,
//               createdAt, priorCurrent }
// entries are sorted unique {path,type,mode,sha256} files, {path,type,mode}
// directories, or {path,type,target} symlinks/credential sentinel records.
// current observations contain decimal dev/ino/ctimeNs strings, never paths
// outside the relative activations/<id> namespace. Store/generation directories
// are 0700 and manifests are 0600; artifact modes are captured and revalidated.
// Future bootstrap helpers are optional source inputs; runtime cores below are mandatory.
const SOURCE_INPUTS = [
  'mcp-server/package.json', 'mcp-server/package-lock.json',
  'mcp-server/tsconfig.json', 'mcp-server/tsconfig.test.json',
  'mcp-server/src', 'mcp-server/scripts', 'skills',
  'scripts/sync-codex-skills.mjs', 'scripts/jhw-control-hook',
  'scripts/runtime-safety.mjs', 'scripts/runtime-store.mjs',
  'scripts/runtime-entry.mjs', 'scripts/runtime-deploy.mjs', 'scripts/install-config.mjs', 'scripts/install-wiring.sh',
  'scripts/jhw-runtime-entry', 'scripts/jhw-runtime-control', 'scripts/jhw-runtime-hook',
];
const EXCLUDED_SOURCE_NAMES = ['.git', '.ai', '.superpowers', 'node_modules', 'dist'];
const REQUIRED = new Map([
  ['mcp-server/package.json', false], ['mcp-server/package-lock.json', false],
  ['mcp-server/dist/index.js', false], ['mcp-server/dist/control/cli.js', true],
  ['mcp-server/dist/control/hook-adapter.js', true], ['scripts/jhw-control-hook', true],
  ['mcp-server/dist/runtime/mcp.cjs', false], ['mcp-server/dist/runtime/control.cjs', true],
  ['mcp-server/dist/runtime/hook.cjs', true],
]);
const fail = (code = 'DEPLOY_UNTRUSTED_PATH') => { throw new DeploymentError(code); };
function boundary(error, code) { throw error instanceof DeploymentError ? error : new DeploymentError(code); }
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(value).digest('hex');
function same(a, b) {
  return ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
}
function objectSame(a, b) {
  return ['dev', 'ino', 'uid', 'gid', 'mode'].every(key => a[key] === b[key]);
}
function relativeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 1024 &&
    !name.includes('\\') && !name.includes('\0') && !path.isAbsolute(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..');
}
function safeStat(stat, type) {
  const mode = Number(stat.mode);
  if (stat.uid !== BigInt(process.getuid()) || (mode & 0o7022)) fail();
  if (type === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n || !(mode & 0o400)) fail();
}

// Retained descriptors anchor operations to verified directories even if a pathname
// is replaced. Node has no openat; Linux /proc/self/fd supplies the equivalent base.
class Directory {
  constructor(name, parent = null, privateMode = false) {
    this.parent = parent;
    this.name = name;
    if (!parent) trustedDirectory(name);
    const location = parent ? parent.at(name) : name;
    try { this.fd = fs.openSync(location, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') throw error; fail(); }
    try {
      this.stat = fs.fstatSync(this.fd, { bigint: true });
      safeStat(this.stat, 'directory');
      if (privateMode && (Number(this.stat.mode) & 0o7777) !== 0o700) fail();
      this.verify();
    } catch (error) { fs.closeSync(this.fd); throw error; }
  }
  at(name) {
    if (!relativeName(name) || name.includes('/')) fail();
    return `/proc/self/fd/${this.fd}/${name}`;
  }
  verify() {
    if (this.parent) this.parent.verify();
    else trustedDirectory(this.name);
    const location = this.parent ? this.parent.at(this.name) : this.name;
    if (!objectSame(this.stat, fs.fstatSync(this.fd, { bigint: true })) ||
        !objectSame(this.stat, fs.lstatSync(location, { bigint: true }))) fail();
  }
  child(name, create = false, privateMode = false) {
    this.verify();
    if (create) {
      try { fs.mkdirSync(this.at(name), { mode: 0o700 }); fs.chmodSync(this.at(name), 0o700); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return new Directory(name, this, privateMode);
  }
  close() { fs.closeSync(this.fd); }
}
function withStore(repositoryRoot, create, callback) {
  let root; let runtime;
  try {
    root = new Directory(repositoryRoot);
    try { runtime = root.child('.jhw-runtime', create, true); }
    catch (error) { if (!create && error.code === 'ENOENT') return callback(null, root); throw error; }
    return callback(runtime, root);
  } catch (error) { boundary(error, 'DEPLOY_UNTRUSTED_PATH'); }
  finally { runtime?.close(); root?.close(); }
}
function readBytes(directory, name, limit = MAX_FILE) {
  directory.verify();
  const fd = fs.openSync(directory.at(name), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    safeStat(before, 'file');
    if (before.size > BigInt(limit)) fail();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) fail();
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || !same(before, fs.fstatSync(fd, { bigint: true })) ||
        !same(before, fs.lstatSync(directory.at(name), { bigint: true }))) fail();
    directory.verify();
    return { bytes, mode: Number(before.mode) & 0o7777 };
  } finally { fs.closeSync(fd); }
}
function writeBytes(directory, name, bytes, mode) {
  directory.verify();
  const fd = fs.openSync(directory.at(name), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  directory.verify();
}
function readLink(directory, name) {
  directory.verify();
  const before = fs.lstatSync(directory.at(name), { bigint: true });
  if (!before.isSymbolicLink() || before.uid !== BigInt(process.getuid())) fail();
  const target = fs.readlinkSync(directory.at(name));
  if (target.length > 4096 || !same(before, fs.lstatSync(directory.at(name), { bigint: true }))) fail();
  directory.verify();
  return { target, stat: before };
}
function readJson(directory) {
  const { bytes, mode } = readBytes(directory, 'manifest.json', MAX_MANIFEST);
  if (mode !== 0o600) fail();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function names(directory) {
  const result = [];
  const stream = fs.opendirSync(`/proc/self/fd/${directory.fd}`);
  try {
    let item;
    while ((item = stream.readSync()) !== null) {
      if (result.length === MAX_ENTRIES || !relativeName(item.name)) fail();
      result.push(item.name);
    }
  } finally { stream.closeSync(); }
  return result.sort();
}
function allowedSource(name) {
  return SOURCE_INPUTS.some(input => name === input || name.startsWith(`${input}/`) || input.startsWith(`${name}/`));
}
function walk(directory, { source = false, repositoryRoot, destination = null } = {}) {
  const entries = [];
  function visit(dir, prefix, copy) {
    const before = names(dir);
    for (const name of before) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (source && !allowedSource(relative)) continue;
      if (source && EXCLUDED_SOURCE_NAMES.includes(name)) continue;
      if (!source && relative === 'manifest.json') continue;
      if (!source && !['mcp-server', 'scripts', 'skills'].includes(relative.split('/')[0])) fail('DEPLOY_RELEASE_INVALID');
      if (entries.length >= MAX_ENTRIES) fail();
      const stat = fs.lstatSync(dir.at(name), { bigint: true });
      if (name === '.env') {
        if (source || relative !== 'mcp-server/.env' || !stat.isSymbolicLink() ||
            readLink(dir, name).target !== path.join(repositoryRoot, 'mcp-server/.env')) fail();
        entries.push({ path: relative, type: 'credential', target: 'canonical-mcp-env' });
      } else if (stat.isDirectory()) {
        safeStat(stat, 'directory');
        const child = dir.child(name);
        let target;
        try {
          if (copy) {
            target = copy.child(name, true);
            fs.fchmodSync(target.fd, Number(stat.mode) & 0o7777);
            target.stat = fs.fstatSync(target.fd, { bigint: true });
          }
          entries.push({ path: relative, type: 'directory', mode: Number(stat.mode) & 0o7777 });
          visit(child, relative, target);
        } finally { target?.close(); child.close(); }
      } else if (stat.isFile()) {
        const { bytes, mode } = readBytes(dir, name);
        entries.push({ path: relative, type: 'file', mode, sha256: digest(bytes) });
        if (copy) writeBytes(copy, name, bytes, mode);
      } else if (stat.isSymbolicLink()) {
        const { target } = readLink(dir, name);
        if (path.isAbsolute(target) || !target || target.includes('\0') || target.includes('\\')) fail();
        entries.push({ path: relative, type: 'symlink', target });
        if (copy) fs.symlinkSync(target, copy.at(name));
      } else fail();
      if (!same(stat, fs.lstatSync(dir.at(name), { bigint: true }))) fail();
    }
    if (canonical(before) !== canonical(names(dir))) fail();
    dir.verify();
    if (copy) fs.fsyncSync(copy.fd);
  }
  visit(directory, '', destination);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  validateLinks(entries);
  return entries;
}
function validateLinks(entries) {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries) {
    if (entry.type !== 'symlink') continue;
    let remaining = [...entry.path.split('/')];
    let resolved = []; let followed = 0;
    while (remaining.length) {
      const part = remaining.shift();
      if (part === '.' || part === '') continue;
      if (part === '..') { if (!resolved.length) fail(); resolved.pop(); continue; }
      resolved.push(part);
      const found = byPath.get(resolved.join('/'));
      if (!found || found.type === 'credential') fail();
      if (found.type === 'symlink') {
        if (++followed > 40 || path.isAbsolute(found.target)) fail();
        resolved.pop(); remaining = [...found.target.split('/'), ...remaining];
      } else if (remaining.length && found.type !== 'directory') fail();
    }
  }
}
function requiredArtifacts(entries) {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const [name, executable] of REQUIRED) {
    const entry = byPath.get(name);
    if (entry?.type !== 'file' || (executable && !(entry.mode & 0o100))) fail('DEPLOY_RELEASE_INVALID');
  }
  for (const name of ['skills', 'scripts', 'mcp-server/node_modules']) {
    if (byPath.get(name)?.type !== 'directory') fail('DEPLOY_RELEASE_INVALID');
  }
  if (byPath.get('mcp-server/.env')?.type !== 'credential') fail('DEPLOY_RELEASE_INVALID');
}
function credentialSource(repositoryRoot) {
  let root; let mcp;
  try {
    root = new Directory(repositoryRoot);
    mcp = root.child('mcp-server');
    // Metadata only: do not open, read, or copy credential bytes.
    let stat;
    try { stat = fs.lstatSync(mcp.at('.env'), { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    safeStat(stat, 'file');
    mcp.verify();
    if (!same(stat, fs.lstatSync(mcp.at('.env'), { bigint: true }))) fail();
  } finally { mcp?.close(); root?.close(); }
}
function validEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) return false;
  let last = '';
  for (const entry of entries) {
    if (!relativeName(entry?.path) || entry.path <= last) return false;
    last = entry.path;
    const keys = entry.type === 'file' ? ['path', 'type', 'mode', 'sha256'] :
      entry.type === 'directory' ? ['path', 'type', 'mode'] : ['path', 'type', 'target'];
    if (!exact(entry, keys)) return false;
    if (['file', 'directory'].includes(entry.type)) {
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || (entry.mode & 0o022)) return false;
      if (entry.type === 'file' && !DIGEST.test(entry.sha256)) return false;
    } else if (!['symlink', 'credential'].includes(entry.type) || typeof entry.target !== 'string' || entry.target.length > 4096) return false;
  }
  return true;
}
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}
function contentDigest(manifest) {
  return digest(canonical({ sourceRevision: manifest.sourceRevision, sourceDigest: manifest.sourceDigest, dirty: manifest.dirty, entries: manifest.entries }));
}
function summary(manifest) {
  const { releaseId, sourceRevision, sourceDigest, contentDigest, dirty } = manifest;
  return { releaseId, sourceRevision, sourceDigest, contentDigest, dirty };
}
function validateReleaseIn(runtime, repositoryRoot, releaseId) {
  let releases; let release;
  try {
    if (typeof releaseId !== 'string' || !RELEASE.test(releaseId)) fail('DEPLOY_RELEASE_INVALID');
    releases = runtime.child('releases', false, true);
    release = releases.child(releaseId, false, true);
    const manifest = readJson(release);
    if (!exact(manifest, ['version', 'releaseId', 'sourceRevision', 'sourceDigest', 'contentDigest', 'dirty', 'createdAt', 'entries']) ||
        manifest.version !== 1 || manifest.releaseId !== releaseId || manifest.sourceRevision !== RELEASE.exec(releaseId)[1] ||
        typeof manifest.sourceDigest !== 'string' || !DIGEST.test(manifest.sourceDigest) || typeof manifest.dirty !== 'boolean' || !timestamp(manifest.createdAt) ||
        !validEntries(manifest.entries) || contentDigest(manifest) !== manifest.contentDigest || RELEASE.exec(releaseId)[2] !== manifest.contentDigest) fail('DEPLOY_RELEASE_INVALID');
    const entries = walk(release, { repositoryRoot });
    if (canonical(entries) !== canonical(manifest.entries)) fail('DEPLOY_RELEASE_INVALID');
    requiredArtifacts(entries);
    credentialSource(repositoryRoot);
    // Re-read the manifest after hashing the entire tree to detect concurrent edits.
    if (canonical(manifest) !== canonical(readJson(release))) fail('DEPLOY_RELEASE_INVALID');
    return summary(manifest);
  } catch (error) { boundary(error, 'DEPLOY_RELEASE_INVALID'); }
  finally { release?.close(); releases?.close(); }
}
export function validateRelease({ repositoryRoot, releaseId }) {
  if (typeof releaseId !== 'string' || !RELEASE.test(releaseId)) fail('DEPLOY_RELEASE_INVALID');
  return withStore(repositoryRoot, false, runtime => {
    if (!runtime) fail('DEPLOY_RELEASE_INVALID');
    return validateReleaseIn(runtime, repositoryRoot, releaseId);
  });
}
function git(root, args) {
  root.verify();
  const result = spawnSync('git', ['-C', root.name, ...args], { encoding: 'utf8', maxBuffer: MAX_MANIFEST, stdio: ['ignore', 'pipe', 'ignore'] });
  root.verify();
  if (result.error || result.status !== 0 || result.signal) fail('DEPLOY_SOURCE_INVALID');
  return result.stdout.trim();
}
function sourceIdentity(root) {
  if (git(root, ['rev-parse', '--show-toplevel']) !== root.name) fail('DEPLOY_SOURCE_INVALID');
  const sourceRevision = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision)) fail('DEPLOY_SOURCE_INVALID');
  const exclusions = EXCLUDED_SOURCE_NAMES.flatMap(name => [
    `:(glob,exclude)**/${name}`, `:(glob,exclude)**/${name}/**`,
  ]);
  return { sourceRevision, dirty: git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...SOURCE_INPUTS, ...exclusions]) !== '' };
}
async function run(command, args, cwd, env) {
  await new Promise((resolve, reject) => {
    // Apply umask only to the build process tree, never to the caller's process.
    const child = spawn('/bin/sh', ['-c', 'umask 022; exec "$@"', 'jhw-runtime-build', command, ...args], { cwd, env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (status, signal) => status === 0 && !signal ? resolve() : reject(new DeploymentError('DEPLOY_BUILD_FAILED')));
  });
}
async function defaultBuild({ stagingRoot }) {
  const home = path.join(stagingRoot, '.build-home');
  fs.mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, npm_config_cache: path.join(home, 'npm-cache'), npm_config_userconfig: path.join(home, '.npmrc') };
  const mcpRoot = path.join(stagingRoot, 'mcp-server');
  await run('npm', ['ci', '--no-audit', '--no-fund'], mcpRoot, env);
  await run('npm', ['run', 'build'], mcpRoot, env);
  const runtime = path.join(mcpRoot, 'dist/runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o755 });
  fs.chmodSync(runtime, 0o755);
  const bundler = path.join(mcpRoot, 'node_modules/.bin/rolldown');
  for (const [input, output, executable] of [
    ['dist/index.js', 'dist/runtime/mcp.cjs', false],
    ['dist/control/cli.js', 'dist/runtime/control.cjs', true],
    ['dist/control/hook-adapter.js', 'dist/runtime/hook.cjs', true],
  ]) {
    await run(bundler, [input, '--file', output, '--format', 'cjs', '--platform', 'node',
      '--no-codeSplitting', '--minify', '--legalComments', 'none', '--logLevel', 'silent'], mcpRoot, env);
    fs.chmodSync(path.join(mcpRoot, output), executable ? 0o755 : 0o644);
  }
  await run(process.execPath, ['scripts/sync-codex-skills.mjs'], stagingRoot, env);
  fs.rmSync(home, { recursive: true });
}

/** Preparation alone owns deploy.lock. Publish/rollback MUST be called by the
 * driver holding deploy.lock + exclusive admission.lock and both quiescence checks.
 * build({stagingRoot}) is a module integration seam, never a public CLI option. */
export async function prepareRelease({ repositoryRoot, build = defaultBuild }) {
  let root; let runtime; let releases; let stage; let lease; let stageName;
  try {
    root = new Directory(repositoryRoot);
    runtime = root.child('.jhw-runtime', true, true);
    lease = acquireLease(path.join(repositoryRoot, '.jhw-runtime/deploy.lock'), { create: true });
    runtime.verify();
    releases = runtime.child('releases', true, true);
    stageName = `.stage.${randomBytes(16).toString('hex')}`;
    stage = runtime.child(stageName, true, true);
    credentialSource(repositoryRoot);
    const identity = sourceIdentity(root);
    const source = walk(root, { source: true, repositoryRoot, destination: stage });
    const sourceDigest = digest(canonical(source));
    const stagingRoot = path.join(repositoryRoot, '.jhw-runtime', stageName);
    try { await build({ stagingRoot }); }
    catch { fail('DEPLOY_BUILD_FAILED'); }
    stage.verify();
    if (canonical(sourceIdentity(root)) !== canonical(identity) || digest(canonical(walk(root, { source: true, repositoryRoot }))) !== sourceDigest) fail('DEPLOY_SOURCE_CHANGED');
    const mcp = stage.child('mcp-server');
    try { fs.symlinkSync(path.join(repositoryRoot, 'mcp-server/.env'), mcp.at('.env')); fs.fsyncSync(mcp.fd); }
    finally { mcp.close(); }
    const entries = walk(stage, { repositoryRoot });
    requiredArtifacts(entries);
    const manifest = { version: 1, releaseId: '', ...identity, sourceDigest, contentDigest: '', createdAt: new Date().toISOString(), entries };
    manifest.contentDigest = contentDigest(manifest);
    manifest.releaseId = `r-${manifest.sourceRevision}-${manifest.contentDigest}`;
    writeBytes(stage, 'manifest.json', `${canonical(manifest)}\n`, 0o600);
    fs.fsyncSync(stage.fd);
    stage.verify(); releases.verify();
    try {
      fs.lstatSync(releases.at(manifest.releaseId));
      const existing = validateReleaseIn(runtime, repositoryRoot, manifest.releaseId);
      if (canonical(existing) !== canonical(summary(manifest))) fail('DEPLOY_RELEASE_INVALID');
      return existing;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(runtime.at(stageName), releases.at(manifest.releaseId));
    stage.close(); stage = null; stageName = null;
    fs.fsyncSync(releases.fd);
    return validateReleaseIn(runtime, repositoryRoot, manifest.releaseId);
  } catch (error) { boundary(error, 'DEPLOY_PREPARE_FAILED'); }
  finally {
    // Never traverse a replacement stage during cleanup; retain uncertainty instead.
    if (stage) {
      try { stage.verify(); fs.rmSync(runtime.at(stageName), { recursive: true }); }
      catch { /* A changed/untrusted stage is preserved for explicit inspection. */ }
      stage.close();
    }
    releases?.close(); lease?.close(); runtime?.close(); root?.close();
  }
}

function observation(runtime) {
  try {
    const { target, stat } = readLink(runtime, 'current');
    if (!/^activations\/a-[a-f0-9]{32}$/.test(target)) fail('DEPLOY_ACTIVATION_INVALID');
    return { target, dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(stat.ctimeNs) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validCurrent(value) {
  if (value === null) return true;
  return exact(value, ['activationId', 'releaseId', 'predecessorActivationId', 'observation']) &&
    ACTIVATION.test(value.activationId) && RELEASE.test(value.releaseId) &&
    (value.predecessorActivationId === null || ACTIVATION.test(value.predecessorActivationId)) &&
    exact(value.observation, ['target', 'dev', 'ino', 'ctimeNs']) && value.observation.target === `activations/${value.activationId}` &&
    ['dev', 'ino', 'ctimeNs'].every(key => typeof value.observation[key] === 'string' && /^\d{1,32}$/.test(value.observation[key]));
}
function activationIn(runtime, repositoryRoot, activationId) {
  let activations; let activation;
  try {
    if (!ACTIVATION.test(activationId)) fail('DEPLOY_ACTIVATION_INVALID');
    activations = runtime.child('activations', false, true);
    activation = activations.child(activationId, false, true);
    if (canonical(names(activation)) !== canonical(['manifest.json', 'mcp-server', 'scripts', 'skills'])) fail('DEPLOY_ACTIVATION_INVALID');
    const manifest = readJson(activation);
    if (!exact(manifest, ['version', 'activationId', 'releaseId', 'predecessorActivationId', 'createdAt', 'priorCurrent']) ||
        manifest.version !== 1 || manifest.activationId !== activationId || !RELEASE.test(manifest.releaseId) ||
        !timestamp(manifest.createdAt) || !validCurrent(manifest.priorCurrent) ||
        manifest.predecessorActivationId !== (manifest.priorCurrent?.activationId ?? null) || manifest.predecessorActivationId === activationId) fail('DEPLOY_ACTIVATION_INVALID');
    for (const name of ['mcp-server', 'scripts', 'skills']) {
      if (readLink(activation, name).target !== `../../releases/${manifest.releaseId}/${name}`) fail('DEPLOY_ACTIVATION_INVALID');
    }
    validateReleaseIn(runtime, repositoryRoot, manifest.releaseId);
    if (canonical(readJson(activation)) !== canonical(manifest)) fail('DEPLOY_ACTIVATION_INVALID');
    return manifest;
  } catch (error) { boundary(error, 'DEPLOY_ACTIVATION_INVALID'); }
  finally { activation?.close(); activations?.close(); }
}
function currentIn(runtime, repositoryRoot) {
  if (!runtime) return null;
  const before = observation(runtime);
  if (!before) return null;
  const manifest = activationIn(runtime, repositoryRoot, before.target.slice('activations/'.length));
  if (canonical(before) !== canonical(observation(runtime))) fail('DEPLOY_CURRENT_CHANGED');
  return { activationId: manifest.activationId, releaseId: manifest.releaseId, predecessorActivationId: manifest.predecessorActivationId, observation: before };
}
export function readActivation({ repositoryRoot }) {
  return withStore(repositoryRoot, false, runtime => currentIn(runtime, repositoryRoot));
}
function checkCurrent(runtime, repositoryRoot, expectedCurrent) {
  if (!validCurrent(expectedCurrent)) fail('DEPLOY_CURRENT_CHANGED');
  const actual = currentIn(runtime, repositoryRoot);
  if (canonical(actual) !== canonical(expectedCurrent)) fail('DEPLOY_CURRENT_CHANGED');
  return actual;
}
function switchPointer(runtime, repositoryRoot, activationId, expectedCurrent, onPointerIntent) {
  const temporary = `.current.${randomBytes(16).toString('hex')}`;
  let created = false;
  try {
    checkCurrent(runtime, repositoryRoot, expectedCurrent);
    fs.symlinkSync(`activations/${activationId}`, runtime.at(temporary)); created = true;
    runtime.verify();
    if (canonical(observation(runtime)) !== canonical(expectedCurrent?.observation ?? null)) fail('DEPLOY_CURRENT_CHANGED');
    const destination=activationIn(runtime,repositoryRoot,activationId);
    onPointerIntent?.({activationId:destination.activationId,releaseId:destination.releaseId,predecessorActivationId:destination.predecessorActivationId});
    fs.renameSync(runtime.at(temporary), runtime.at('current')); created = false;
    fs.fsyncSync(runtime.fd);
    const result = currentIn(runtime, repositoryRoot);
    if (result?.activationId !== activationId) fail('DEPLOY_CURRENT_CHANGED');
    return result;
  } finally {
    if (created) { runtime.verify(); fs.unlinkSync(runtime.at(temporary)); }
  }
}
export function publishActivation({ repositoryRoot, releaseId, expectedCurrent, onPointerIntent }) {
  return withStore(repositoryRoot, false, runtime => {
    if (!runtime) fail('DEPLOY_RELEASE_INVALID');
    checkCurrent(runtime, repositoryRoot, expectedCurrent);
    validateReleaseIn(runtime, repositoryRoot, releaseId);
    let activations; let stage; let stageName;
    try {
      activations = runtime.child('activations', true, true);
      const activationId = `a-${randomBytes(16).toString('hex')}`;
      stageName = `.stage.${randomBytes(16).toString('hex')}`;
      stage = runtime.child(stageName, true, true);
      const manifest = { version: 1, activationId, releaseId, predecessorActivationId: expectedCurrent?.activationId ?? null, createdAt: new Date().toISOString(), priorCurrent: expectedCurrent };
      for (const name of ['mcp-server', 'scripts', 'skills']) fs.symlinkSync(`../../releases/${releaseId}/${name}`, stage.at(name));
      writeBytes(stage, 'manifest.json', `${canonical(manifest)}\n`, 0o600);
      fs.fsyncSync(stage.fd);
      stage.verify(); activations.verify();
      fs.renameSync(runtime.at(stageName), activations.at(activationId));
      stage.close(); stage = null;
      fs.fsyncSync(activations.fd);
      activationIn(runtime, repositoryRoot, activationId);
      return switchPointer(runtime, repositoryRoot, activationId, expectedCurrent, onPointerIntent);
    } finally {
      if (stage) {
        try { stage.verify(); fs.rmSync(runtime.at(stageName), { recursive: true }); } catch { /* Preserve untrusted evidence. */ }
        stage.close();
      }
      activations?.close();
    }
  });
}
export function rollbackActivation({ repositoryRoot, expectedCurrent, onPointerIntent }) {
  return withStore(repositoryRoot, false, runtime => {
    const current = checkCurrent(runtime, repositoryRoot, expectedCurrent);
    if (!current?.predecessorActivationId) fail('DEPLOY_PREDECESSOR_INVALID');
    const manifest = activationIn(runtime, repositoryRoot, current.activationId);
    const predecessor = activationIn(runtime, repositoryRoot, current.predecessorActivationId);
    if (predecessor.releaseId !== manifest.priorCurrent.releaseId ||
        predecessor.predecessorActivationId !== manifest.priorCurrent.predecessorActivationId) fail('DEPLOY_PREDECESSOR_INVALID');
    return switchPointer(runtime, repositoryRoot, current.predecessorActivationId, expectedCurrent, onPointerIntent);
  });
}
