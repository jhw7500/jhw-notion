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
  'scripts/runtime-entry.mjs', 'scripts/runtime-deploy.mjs', 'scripts/runtime-prune.mjs', 'scripts/runtime-guard.mjs', 'scripts/install-config.mjs', 'scripts/install-wiring.sh',
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
  // status never lists ignored files, yet the source walk would copy them. The exclude
  // pathspecs keep excluded subtrees (node_modules, dist) out of git's output, but with
  // --ignored git then also lists ignored nested repositories outside the inputs, so the
  // walk's own rules filter the result. git does not list an ignored directory that is
  // empty or holds only excluded names; the walk still copies it as an empty directory.
  const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...SOURCE_INPUTS, ...exclusions])
    .split('\0').filter(name => name && allowedSource(name.replace(/\/$/, '')) &&
      !name.split('/').some(part => EXCLUDED_SOURCE_NAMES.includes(part)));
  if (ignored.length) throw new DeploymentError('DEPLOY_SOURCE_INVALID', 'ignored_source_files');
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
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(mcpRoot, 'package.json'), 'utf8'));
  if (typeof packageMetadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)) {
    throw new DeploymentError('DEPLOY_BUILD_FAILED');
  }
  const controlVersionDefine = `__JHW_BUNDLED_CONTROL_TOOL_VERSION__:${JSON.stringify(packageMetadata.version)}`;
  const runtime = path.join(mcpRoot, 'dist/runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o755 });
  fs.chmodSync(runtime, 0o755);
  const bundler = path.join(mcpRoot, 'node_modules/.bin/rolldown');
  for (const [input, output, executable, defines] of [
    ['dist/index.js', 'dist/runtime/mcp.cjs', false, []],
    ['dist/control/cli.js', 'dist/runtime/control.cjs', true, []],
    // The hook bundle carries the CLI module under its own file name, so the
    // CLI's entry check would pass there too; this define switches it off.
    ['dist/control/hook-adapter.js', 'dist/runtime/hook.cjs', true, ['--transform.define', '__JHW_HOOK_BUNDLE__:true']],
  ]) {
    await run(bundler, [input, '--file', output, '--format', 'cjs', '--platform', 'node',
      '--no-codeSplitting', '--minify', '--legalComments', 'none', '--logLevel', 'silent',
      '--transform.define', controlVersionDefine, ...defines], mcpRoot, env);
    fs.chmodSync(path.join(mcpRoot, output), executable ? 0o755 : 0o644);
  }
  await run(process.execPath, ['scripts/sync-codex-skills.mjs'], stagingRoot, env);
  fs.rmSync(home, { recursive: true });
}

/** Preparation alone owns deploy.lock. Ordinary publish/rollback requires the
 * driver to hold deploy.lock + exclusive admission.lock and both quiescence checks.
 * Compatible activation instead requires deploy.lock + exclusive publication.lock
 * and the bound-session inventory/compatibility gate; maintenance still requires
 * exclusive admission. build({stagingRoot}) is a module seam, never a CLI option. */
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
export function validCurrent(value) {
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
/** Strict frozen current-pointer shape shared with Guard transition evidence. */
export function isActivationSnapshot(value) {
  return value !== null && validCurrent(value);
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


// A binding chooses immutable runtime bytes; it never grants Project Control or
// board authority. Callers serialize selection/registration with publication.lock
// and keep the ordinary admission lease over the complete process lifetime.
const SESSION_ID = /^s-[a-f0-9]{32}$/;
const SESSION_PRIVATE = /^(?:\.creating\.s-[a-f0-9]{32}|\.retired\.s-[a-f0-9]{32}\.[a-f0-9]{32})$/;
const SESSION_TOKEN = /^(s-[a-f0-9]{32}):([a-f0-9]{64})$/;
const SESSION_LIMIT = 1024;
const SESSION_MANIFEST_LIMIT = 16 * 1024;
const PROCESS_RECORD_LIMIT = 128 * 1024;
const DECIMAL = /^\d{1,32}$/;
// BigInt stats are signed 64-bit, so an inode or device number above 2^63 reads
// as negative. Identity is compared as the same string, so only the sign is new.
const SIGNED_DECIMAL = /^-?\d{1,32}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sessionFail = () => fail('DEPLOY_SESSION_INVALID');
// Readers hold a shared namespace lease only while taking the directory snapshot;
// registration and retirement hold the exclusive lease over atomic publication.
// A bounded wait handles ordinary simultaneous arrivals without weakening pin checks.
const SESSION_INDEX_WAIT_NS = 500_000_000n;
const SESSION_INDEX_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const sessionIndexWriters = new Set();
function sessionIndexLease(repositoryRoot, shared) {
  // Synchronous re-entrant reads inside the same JS stack cannot wait for their
  // own exclusive lease. Their caller already holds the verified namespace.
  // Separate processes and worker isolates still acquire the kernel lease.
  if (shared && sessionIndexWriters.has(repositoryRoot)) return { close() {} };
  const file = path.join(repositoryRoot, '.jhw-runtime/session-index.lock');
  const deadline = process.hrtime.bigint() + SESSION_INDEX_WAIT_NS;
  for (;;) {
    try {
      const lease = acquireLease(file, { shared, create: true });
      if (!shared) sessionIndexWriters.add(repositoryRoot);
      let closed = false;
      return { close() {
        if (closed) return;
        closed = true;
        try { lease.close(); }
        finally { if (!shared) sessionIndexWriters.delete(repositoryRoot); }
      } };
    } catch (error) {
      if (error.code !== 'DEPLOY_LOCK_CONTENDED' || process.hrtime.bigint() >= deadline) sessionFail();
      Atomics.wait(SESSION_INDEX_SLEEP, 0, 0, 5);
    }
  }
}
function sessionBoundary(callback) {
  try { return callback(); }
  catch { sessionFail(); }
}
function sessionRootName(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot) ||
      repositoryRoot !== path.resolve(repositoryRoot) || repositoryRoot.includes('\0')) sessionFail();
  return repositoryRoot;
}
function processRecord(directoryFd, name, limit = PROCESS_RECORD_LIMIT, allowedUid = process.getuid()) {
  const fd = fs.openSync('/proc/self/fd/' + directoryFd + '/' + name, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || (before.uid !== BigInt(allowedUid) && before.uid !== 0n)) sessionFail();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit || !same(before, fs.fstatSync(fd, { bigint: true }))) sessionFail();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { fs.closeSync(fd); }
}
function sessionBootId() {
  const directory = fs.openSync('/proc/sys/kernel/random', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    const value = processRecord(directory, 'boot_id', 64).trim();
    if (!BOOT_ID.test(value)) sessionFail();
    return value;
  } finally { fs.closeSync(directory); }
}
function sessionProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) sessionFail();
  const name = '/proc/' + pid;
  const directory = fs.openSync(name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(directory, { bigint: true });
    if (before.uid !== BigInt(process.getuid())) sessionFail();
    const observe = () => {
      const stat = processRecord(directory, 'stat');
      const end = stat.lastIndexOf(')');
      if (!stat.startsWith(pid + ' (') || end < 0) sessionFail();
      const fields = stat.slice(end + 1).trim().split(/\s+/);
      if (fields.length < 20 || !/^\d+$/.test(fields[1]) || !DECIMAL.test(fields[19]) ||
          ['Z', 'X', 'x'].includes(fields[0])) sessionFail();
      const parentPid = Number(fields[1]);
      if (!Number.isSafeInteger(parentPid) || parentPid < 0 || parentPid > 0x7fffffff) sessionFail();
      const status = processRecord(directory, 'status');
      const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
      if (!uid || uid.slice(1).some(value => Number(value) !== process.getuid())) sessionFail();
      const command = processRecord(directory, 'cmdline');
      if (!command || !command.endsWith('\0')) sessionFail();
      const executable = fs.statSync('/proc/self/fd/' + directory + '/exe', { bigint: true });
      if (!executable.isFile()) sessionFail();
      return { pid, parentPid, uid: process.getuid(), startTime: fields[19],
        commandDigest: digest(command), exeDev: String(executable.dev), exeIno: String(executable.ino) };
    };
    const first = observe();
    const second = observe();
    if (canonical(first) !== canonical(second) || !objectSame(before, fs.fstatSync(directory, { bigint: true })) ||
        !objectSame(before, fs.lstatSync(name, { bigint: true }))) sessionFail();
    return first;
  } finally { fs.closeSync(directory); }
}
function ownerMatches(record) {
  if (record.owner.bootId !== sessionBootId()) sessionFail();
  const observed = sessionProcess(record.owner.pid);
  for (const key of ['uid', 'pid', 'startTime', 'commandDigest', 'exeDev', 'exeIno']) {
    if (observed[key] !== record.owner[key]) sessionFail();
  }
  const held = fs.statSync('/proc/' + record.owner.pid + '/fd/' + record.lease.fd, { bigint: true });
  if (!held.isFile() || held.uid !== BigInt(process.getuid()) || held.nlink !== 1n ||
      (Number(held.mode) & 0o7777) !== 0o600 ||
      String(held.dev) !== record.lease.dev || String(held.ino) !== record.lease.ino) sessionFail();
  return observed;
}
function requireSessionDescendant(pid, record) {
  const chain = [];
  let current = pid;
  for (let depth = 0; depth < 256; depth++) {
    if (chain.some(item => item.pid === current)) sessionFail();
    const observed = sessionProcess(current);
    chain.push(observed);
    if (current === record.owner.pid) {
      ownerMatches(record);
      for (const prior of chain.reverse()) {
        if (canonical(prior) !== canonical(sessionProcess(prior.pid))) sessionFail();
      }
      return;
    }
    if (!observed.parentPid || observed.parentPid === current) sessionFail();
    current = observed.parentPid;
  }
  sessionFail();
}
function sessionNames(directory, reserved = 0) {
  const list = [];
  let count = reserved;
  const stream = fs.opendirSync('/proc/self/fd/' + directory.fd);
  try {
    let item;
    while ((item = stream.readSync()) !== null) {
      if (++count > SESSION_LIMIT) sessionFail();
      if (SESSION_ID.test(item.name)) list.push(item.name);
      else {
        // Interrupted construction/retirement stays outside the public namespace.
        // Count every entry and validate even ignored names as private real dirs.
        if (!SESSION_PRIVATE.test(item.name)) sessionFail();
        const ignored = directory.child(item.name, false, true);
        ignored.close();
      }
    }
  } finally { stream.closeSync(); }
  directory.verify();
  return list.sort();
}
// Entry reclaim must still list a namespace that sessionNames() refuses as full.
// Unknown names are only counted here; they are never opened or removed.
const SESSION_SCAN_LIMIT = 65536;
function sessionInventory(directory) {
  const ids = []; const leftovers = []; let total = 0;
  const stream = fs.opendirSync('/proc/self/fd/' + directory.fd);
  try {
    let item;
    while ((item = stream.readSync()) !== null) {
      if (++total > SESSION_SCAN_LIMIT) sessionFail();
      if (SESSION_ID.test(item.name)) ids.push(item.name);
      else if (SESSION_PRIVATE.test(item.name)) leftovers.push(item.name);
    }
  } finally { stream.closeSync(); }
  directory.verify();
  return { ids, leftovers, total };
}
function unusedSessionName(directory, name) {
  directory.verify();
  try { fs.lstatSync(directory.at(name)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  sessionFail();
}
function sessionDirectory(runtime, create = false) {
  try { return runtime.child('sessions', create, true); }
  catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
}
function leaseIsHeld(file) {
  let probe;
  try { probe = acquireLease(file); return false; }
  catch (error) { if (error.code === 'DEPLOY_LOCK_CONTENDED') return true; throw error; }
  finally { probe?.close(); }
}
function sessionRecord(runtime, root, repositoryRoot, id, token = null) {
  let sessions; let directory;
  try {
    if (!SESSION_ID.test(id)) sessionFail();
    sessions = sessionDirectory(runtime);
    if (!sessions) sessionFail();
    directory = sessions.child(id, false, true);
    if (canonical(names(directory)) !== canonical(['lease', 'manifest.json'])) sessionFail();
    const { bytes, mode } = readBytes(directory, 'manifest.json', SESSION_MANIFEST_LIMIT);
    if (mode !== 0o600) sessionFail();
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const actualToken = id + ':' + digest(bytes);
    const file = fs.lstatSync(directory.at('manifest.json'), { bigint: true });
    const lease = fs.lstatSync(directory.at('lease'), { bigint: true });
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    if (token !== null && token !== actualToken ||
        !exact(record, ['version', 'id', 'kind', 'releaseId', 'compatibilityDigest', 'parentBinding',
          'repository', 'owner', 'manifest', 'lease', 'createdAt']) ||
        record.version !== 1 || record.id !== id || !['session', 'invocation'].includes(record.kind) ||
        !RELEASE.test(record.releaseId) || !DIGEST.test(record.compatibilityDigest) ||
        !(record.parentBinding === null || typeof record.parentBinding === 'string' && SESSION_TOKEN.test(record.parentBinding)) ||
        record.kind === 'session' && record.parentBinding !== null || !timestamp(record.createdAt) ||
        !exact(record.repository, ['path', 'dev', 'ino']) || record.repository.path !== repositoryRoot ||
        record.repository.dev !== String(root.stat.dev) || record.repository.ino !== String(root.stat.ino) ||
        !exact(record.owner, ['uid', 'pid', 'startTime', 'bootId', 'commandDigest', 'exeDev', 'exeIno']) ||
        record.owner.uid !== process.getuid() || !integer(record.owner.pid) || record.owner.pid < 1 ||
        !DECIMAL.test(record.owner.startTime) || !BOOT_ID.test(record.owner.bootId) ||
        !DIGEST.test(record.owner.commandDigest) || !SIGNED_DECIMAL.test(record.owner.exeDev) || !SIGNED_DECIMAL.test(record.owner.exeIno) ||
        !exact(record.manifest, ['dev', 'ino']) || record.manifest.dev !== String(file.dev) || record.manifest.ino !== String(file.ino) ||
        !exact(record.lease, ['dev', 'ino', 'fd']) || !integer(record.lease.fd) || record.lease.fd > 1048576 ||
        !lease.isFile() || lease.uid !== BigInt(process.getuid()) || lease.nlink !== 1n || (Number(lease.mode) & 0o7777) !== 0o600 ||
        record.lease.dev !== String(lease.dev) || record.lease.ino !== String(lease.ino) ||
        bytes.toString('utf8') !== canonical(record) + '\n') sessionFail();
    directory.verify();
    return { record, token: actualToken, leaseFile: path.join(repositoryRoot, '.jhw-runtime/sessions', id, 'lease') };
  } finally { directory?.close(); sessions?.close(); }
}

// Retire only exact inode-bound records after an independent exclusive flock
// proves every inherited holder has closed. This is used by normal close(), by
// bounded entry reclaim (each retirement under its own short index lease), and
// by the explicit maintenance reaper.
function retireUnusedSessionRecord({ repositoryRoot, id, token = null, expectedRecord = null, indexHeld = false }) {
  let index;
  try {
    if (!indexHeld) index = sessionIndexLease(repositoryRoot, false);
    return withStore(repositoryRoot, false, (runtime, root) => {
      if (!runtime) sessionFail();
      const data = sessionRecord(runtime, root, repositoryRoot, id, token);
      if (expectedRecord && canonical(data.record) !== canonical(expectedRecord)) sessionFail();
      let exclusive; let sessions; let directory;
      try {
        try { exclusive = acquireLease(data.leaseFile); }
        catch (error) { if (error.code === 'DEPLOY_LOCK_CONTENDED') return false; throw error; }
        const exclusiveIdentity = fs.fstatSync(exclusive.fd, { bigint: true });
        if (String(exclusiveIdentity.dev) !== data.record.lease.dev ||
            String(exclusiveIdentity.ino) !== data.record.lease.ino) sessionFail();
        sessions = sessionDirectory(runtime);
        directory = sessions.child(id, false, true);
        const verified = sessionRecord(runtime, root, repositoryRoot, id, data.token);
        if (canonical(data.record) !== canonical(verified.record)) sessionFail();
        directory.verify();
        const retired = '.retired.' + id + '.' + randomBytes(16).toString('hex');
        unusedSessionName(sessions, retired);
        const retiringIdentity = directory.stat;
        fs.renameSync(sessions.at(id), sessions.at(retired));
        fs.fsyncSync(sessions.fd);
        directory.close(); directory = undefined;
        directory = sessions.child(retired, false, true);
        if (!objectSame(retiringIdentity, directory.stat)) sessionFail();
        const retiredManifest = fs.lstatSync(directory.at('manifest.json'), { bigint: true });
        if (String(retiredManifest.dev) !== data.record.manifest.dev ||
            String(retiredManifest.ino) !== data.record.manifest.ino ||
            !same(exclusiveIdentity, fs.lstatSync(directory.at('lease'), { bigint: true }))) sessionFail();
        const retiredBytes = readBytes(directory, 'manifest.json', SESSION_MANIFEST_LIMIT);
        if (retiredBytes.mode !== 0o600 || id + ':' + digest(retiredBytes.bytes) !== data.token) sessionFail();
        fs.unlinkSync(directory.at('manifest.json'));
        fs.unlinkSync(directory.at('lease'));
        fs.fsyncSync(directory.fd);
        sessions.verify();
        fs.rmdirSync(sessions.at(retired));
        fs.fsyncSync(sessions.fd);
        return true;
      } finally { directory?.close(); sessions?.close(); exclusive?.close(); }
    });
  } finally { index?.close(); }
}

// A wrapper or entry killed by a signal never runs close(). Entries therefore
// reclaim in bounded batches before taking their own exclusive index lease: public
// records only after the exclusive flock in retireUnusedSessionRecord proves no
// holder (session and invocation alike), and private leftovers only when proven
// abandoned under the exclusive index lease with the expected file shape.
// Near the limit an entry drains toward SESSION_RECLAIM_FLOOR within a deadline.
// Uncertain candidates are skipped and kept as evidence; this never fails an entry.
const SESSION_RECLAIM_FLOOR = SESSION_LIMIT - 64;
const SESSION_RECLAIM_DEADLINE_NS = 1_500_000_000n;
function reclaimCompletedSessions({ repositoryRoot, runtime, root, sessions }) {
  try {
    const deadline = process.hrtime.bigint() + SESSION_RECLAIM_DEADLINE_NS;
    const inventory = sessionInventory(sessions);
    let total = inventory.total;
    // At exactly the floor a drain would stop at once; use normal batches there.
    const drain = total > SESSION_RECLAIM_FLOOR;
    // Live records and kept evidence are skipped, so one random start over every
    // candidate keeps neither from starving the rest of each bounded batch.
    const pool = [...inventory.leftovers, ...inventory.ids];
    const start = pool.length ? randomBytes(4).readUInt32LE(0) % pool.length : 0;
    const candidates = [...pool.slice(start), ...pool.slice(0, start)];
    const bootId = inventory.ids.length ? sessionBootId() : null;
    let attempts = 0; let reclaimed = 0;
    for (const name of candidates) {
      if (drain ? total <= SESSION_RECLAIM_FLOOR || process.hrtime.bigint() >= deadline : reclaimed >= 2 || attempts >= 4) break;
      attempts++;
      try {
        let removed = false;
        if (SESSION_PRIVATE.test(name)) {
          const index = sessionIndexLease(repositoryRoot, false);
          let directory;
          try {
            directory = sessions.child(name, false, true);
            const entries = names(directory);
            let expected = true;
            for (const entry of entries) {
              if (!['manifest.json', 'lease'].includes(entry)) { expected = false; break; }
              const stat = fs.lstatSync(directory.at(entry), { bigint: true });
              if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || stat.nlink !== 1n ||
                  (Number(stat.mode) & 0o7777) !== 0o600) { expected = false; break; }
            }
            if (expected) {
              directory.verify();
              for (const entry of entries) fs.unlinkSync(directory.at(entry));
              fs.fsyncSync(directory.fd);
              directory.verify();
              fs.rmdirSync(sessions.at(name));
              fs.fsyncSync(sessions.fd);
              removed = true;
            }
          } finally { directory?.close(); index.close(); }
        } else {
          const data = sessionRecord(runtime, root, repositoryRoot, name);
          const { owner } = data.record;
          let mayLive = false;
          // Cheap prefilter without flock: a same-boot owner whose start time
          // (field 22, as in sessionProcess) still matches may hold the lease.
          if (owner.bootId === bootId) {
            let stat = null;
            try { stat = fs.readFileSync('/proc/' + owner.pid + '/stat', 'latin1'); }
            catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
            if (stat !== null) {
              const end = stat.lastIndexOf(')');
              const fields = stat.slice(end + 1).trim().split(/\s+/);
              mayLive = !stat.startsWith(owner.pid + ' (') || end < 0 || !DECIMAL.test(fields[19] ?? '') ||
                fields[19] === owner.startTime;
            }
          }
          if (!mayLive) removed = retireUnusedSessionRecord({ repositoryRoot, id: name, token: data.token, expectedRecord: data.record }) === true;
        }
        if (removed) { reclaimed++; total--; }
      } catch { /* Skip an uncertain candidate; its evidence stays in place. */ }
    }
  } catch { /* Best effort only; the SESSION_LIMIT check at registration still decides. */ }
}

// This explicit maintenance API (preview by default, removes nothing then) is
// unchanged: it pages through historical invocation records under one index
// lease and is not called during runManaged entry, whose bounded reclaim above
// handles signal-terminated leftovers. Use it in an owner-approved window.
export function reapCompletedSessionBindings({ repositoryRoot, dryRun = true, limit = 128, after = null }) {
  return sessionBoundary(() => {
    sessionRootName(repositoryRoot);
    if (typeof dryRun !== 'boolean' || !Number.isInteger(limit) || limit < 1 || limit > SESSION_LIMIT ||
        !(after === null || typeof after === 'string' && SESSION_ID.test(after))) sessionFail();
    let index;
    try {
      const lockPath = path.join(repositoryRoot, '.jhw-runtime/session-index.lock');
      if (!dryRun) index = sessionIndexLease(repositoryRoot, false);
      else if (fs.existsSync(lockPath)) index = acquireLease(lockPath, { shared: true });
      return withStore(repositoryRoot, false, (runtime, root) => {
        if (!runtime) return { scanned:0, candidates:0, removed:0, busy:0, rootsSkipped:0, nextAfter:null };
        const sessions = sessionDirectory(runtime);
        if (!sessions) return { scanned:0, candidates:0, removed:0, busy:0, rootsSkipped:0, nextAfter:null };
        try {
          const namesBefore = sessionNames(sessions);
          const ids = namesBefore.filter(id => after === null || id > after);
          const selected = ids.slice(0, limit);
          let candidates = 0; let removed = 0; let busy = 0; let rootsSkipped = 0;
          for (const id of selected) {
            const data = sessionRecord(runtime, root, repositoryRoot, id);
            if (data.record.kind !== 'invocation') { rootsSkipped++; continue; }
            if (dryRun) {
              if (leaseIsHeld(data.leaseFile)) busy++;
              else candidates++;
            } else {
              if (retireUnusedSessionRecord({repositoryRoot, id, token:data.token,
                  expectedRecord:data.record, indexHeld:true})) { removed++; candidates++; }
              else busy++;
            }
          }
          if (dryRun && canonical(namesBefore) !== canonical(sessionNames(sessions))) sessionFail();
          return { scanned:selected.length, candidates, removed, busy, rootsSkipped,
            nextAfter:ids.length > selected.length ? selected.at(-1) : null };
        } finally { sessions.close(); }
      });
    } finally { index?.close(); }
  });
}

// Everything is protected except the explicitly bounded MCP tool/entry surface.
// This includes actual dependency bytes, not only their package-lock declaration.
function compatibleMcpEntry(name) {
  return name === 'mcp-server/src/tools' || name.startsWith('mcp-server/src/tools/') ||
    /^mcp-server\/src\/(?:index|server)\.ts$/.test(name) ||
    name === 'mcp-server/dist/tools' || name.startsWith('mcp-server/dist/tools/') ||
    /^mcp-server\/dist\/(?:index|server)\.(?:js(?:\.map)?|d\.ts(?:\.map)?)$/.test(name) ||
    name === 'mcp-server/dist/runtime/mcp.cjs';
}
function releaseCompatibilityIn(runtime, repositoryRoot, releaseId) {
  const validated = validateReleaseIn(runtime, repositoryRoot, releaseId);
  let releases; let release;
  try {
    releases = runtime.child('releases', false, true);
    release = releases.child(releaseId, false, true);
    const manifest = readJson(release);
    if (canonical(summary(manifest)) !== canonical(validated) || contentDigest(manifest) !== validated.contentDigest) fail('DEPLOY_RELEASE_INVALID');
    const result = digest(canonical({ version: 1, entries: manifest.entries.filter(entry => !compatibleMcpEntry(entry.path)) }));
    release.verify();
    if (canonical(manifest) !== canonical(readJson(release))) fail('DEPLOY_RELEASE_INVALID');
    return result;
  } finally { release?.close(); releases?.close(); }
}
export function releaseCompatibility({ repositoryRoot, releaseId }) {
  return withStore(repositoryRoot, false, runtime => {
    if (!runtime) fail('DEPLOY_RELEASE_INVALID');
    return releaseCompatibilityIn(runtime, repositoryRoot, releaseId);
  });
}
function verifyLiveSession(runtime, repositoryRoot, data) {
  if (!leaseIsHeld(data.leaseFile)) sessionFail();
  ownerMatches(data.record);
  if (releaseCompatibilityIn(runtime, repositoryRoot, data.record.releaseId) !== data.record.compatibilityDigest) sessionFail();
  if (!leaseIsHeld(data.leaseFile)) sessionFail();
  ownerMatches(data.record);
}
export function resolveSessionBinding({ repositoryRoot, token, pid = process.pid }) {
  return sessionBoundary(() => {
    sessionRootName(repositoryRoot);
    if (typeof token !== 'string' || !SESSION_TOKEN.test(token)) sessionFail();
    return withStore(repositoryRoot, false, (runtime, root) => {
      if (!runtime) sessionFail();
      const index = sessionIndexLease(repositoryRoot, true);
      let data;
      try { data = sessionRecord(runtime, root, repositoryRoot, token.slice(0, 34), token); }
      finally { index.close(); }
      if (data.record.kind !== 'session') sessionFail();
      verifyLiveSession(runtime, repositoryRoot, data);
      requireSessionDescendant(pid, data.record);
      return { ...data.record, token: data.token, live: true };
    });
  });
}
export function inspectSessionBindings({ repositoryRoot }) {
  return sessionBoundary(() => {
    sessionRootName(repositoryRoot);
    return withStore(repositoryRoot, false, (runtime, root) => {
      if (!runtime) return [];
      const sessions = sessionDirectory(runtime);
      if (!sessions) return [];
      try {
        let snapshot;
        const index = sessionIndexLease(repositoryRoot, true);
        try {
          const before = sessionNames(sessions);
          snapshot = before.map(id => sessionRecord(runtime, root, repositoryRoot, id));
          if (canonical(before) !== canonical(sessionNames(sessions))) sessionFail();
        } finally { index.close(); }
        const result = [];
        for (const data of snapshot) {
          let held;
          try { held = leaseIsHeld(data.leaseFile); }
          catch (error) {
            // A record retired after the snapshot (close() or entry reclaim) is
            // not live. Any other probe failure stays fail-closed.
            let present = true;
            const recheck = sessionIndexLease(repositoryRoot, true);
            try {
              sessions.verify();
              try { fs.lstatSync(sessions.at(data.record.id)); }
              catch (missing) { if (missing.code !== 'ENOENT') throw missing; present = false; }
            } finally { recheck.close(); }
            if (present) throw error;
            continue;
          }
          if (!held) continue;
          verifyLiveSession(runtime, repositoryRoot, data);
          if (data.record.parentBinding !== null) {
            const parent = resolveSessionBinding({ repositoryRoot, token: data.record.parentBinding, pid: data.record.owner.pid });
            if (parent.releaseId !== data.record.releaseId) sessionFail();
          }
          result.push({ ...data.record, token: data.token, live: true });
        }
        return result;
      } finally { sessions.close(); }
    });
  });
}
export function createSessionBinding({ repositoryRoot, releaseId, kind = 'session', parentBinding = null }) {
  return sessionBoundary(() => {
    sessionRootName(repositoryRoot);
    if (!['session', 'invocation'].includes(kind) || kind === 'session' && parentBinding !== null ||
        !(parentBinding === null || typeof parentBinding === 'string' && SESSION_TOKEN.test(parentBinding))) sessionFail();
    if (parentBinding !== null) {
      const parent = resolveSessionBinding({ repositoryRoot, token: parentBinding });
      if (parent.releaseId !== releaseId) sessionFail();
    }
    return withStore(repositoryRoot, false, (runtime, root) => {
      if (!runtime) sessionFail();
      const compatibilityDigest = releaseCompatibilityIn(runtime, repositoryRoot, releaseId);
      const observed = sessionProcess(process.pid);
      const owner = { uid: observed.uid, pid: observed.pid, startTime: observed.startTime, bootId: sessionBootId(),
        commandDigest: observed.commandDigest, exeDev: observed.exeDev, exeIno: observed.exeIno };
      let sessions; let directory; let lease; let manifestFd; let index; let published = false;
      const id = 's-' + randomBytes(16).toString('hex');
      const staging = '.creating.' + id;
      const leaseFile = path.join(repositoryRoot, '.jhw-runtime/sessions', staging, 'lease');
      try {
        sessions = sessionDirectory(runtime, true);
        reclaimCompletedSessions({ repositoryRoot, runtime, root, sessions });
        index = sessionIndexLease(repositoryRoot, false);
        sessionNames(sessions, 1);
        fs.mkdirSync(sessions.at(staging), { mode: 0o700 });
        directory = sessions.child(staging, false, true);
        writeBytes(directory, 'lease', '', 0o600);
        lease = acquireLease(leaseFile, { shared: true });
        manifestFd = fs.openSync(directory.at('manifest.json'), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
        fs.fchmodSync(manifestFd, 0o600);
        const manifestIdentity = fs.fstatSync(manifestFd, { bigint: true });
        const leaseIdentity = fs.fstatSync(lease.fd, { bigint: true });
        const record = { version: 1, id, kind, releaseId, compatibilityDigest, parentBinding,
          repository: { path: repositoryRoot, dev: String(root.stat.dev), ino: String(root.stat.ino) }, owner,
          manifest: { dev: String(manifestIdentity.dev), ino: String(manifestIdentity.ino) },
          lease: { dev: String(leaseIdentity.dev), ino: String(leaseIdentity.ino), fd: lease.fd }, createdAt: new Date().toISOString() };
        const bytes = canonical(record) + '\n';
        fs.writeFileSync(manifestFd, bytes);
        fs.fsyncSync(manifestFd);
        fs.closeSync(manifestFd); manifestFd = undefined;
        fs.fsyncSync(directory.fd);
        directory.verify(); ownerMatches(record);
        unusedSessionName(sessions, id);
        const directoryIdentity = directory.stat;
        // No public s-ID exists until its complete, inode-bound record is durable.
        fs.renameSync(sessions.at(staging), sessions.at(id));
        published = true;
        fs.fsyncSync(sessions.fd); fs.fsyncSync(runtime.fd);
        directory.close(); directory = undefined;
        directory = sessions.child(id, false, true);
        if (!objectSame(directoryIdentity, directory.stat)) sessionFail();
        const token = id + ':' + digest(bytes);
        sessionRecord(runtime, root, repositoryRoot, id, token);
        ownerMatches(record);
        const held = lease; lease = undefined;
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          held.close();
          // A descendant may outlive its owner and retain this lease. If so,
          // leave a complete record for later bounded reclaim or the reaper.
          try { retireUnusedSessionRecord({ repositoryRoot, id, token, expectedRecord:record }); }
          catch { /* Keep untrusted records as evidence; never guess cleanup. */ }
        };
        return { id, token, record, fd: held.fd, close };
      } finally {
        if (manifestFd !== undefined) fs.closeSync(manifestFd);
        lease?.close();
        if (!published && directory) {
          try {
            directory.verify();
            for (const name of names(directory)) {
              if (!['manifest.json', 'lease'].includes(name)) sessionFail();
              fs.unlinkSync(directory.at(name));
            }
            fs.fsyncSync(directory.fd);
            sessions.verify(); fs.rmdirSync(sessions.at(staging)); fs.fsyncSync(sessions.fd);
          } catch { /* Interrupted private construction is never a public record. */ }
        }
        directory?.close(); index?.close(); sessions?.close();
      }
    });
  });
}


// Missing pins must not turn a descendant of a pinned wrapper into an unbound
// caller. Ancestor traversal reads only PID relationship metadata, including for
// foreign-UID ancestors; it never reads their command line or environment.
function sessionAncestorProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) sessionFail();
  const name = '/proc/' + pid;
  const directory = fs.openSync(name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(directory, { bigint: true });
    const observe = () => {
      const stat = processRecord(directory, 'stat', PROCESS_RECORD_LIMIT, before.uid);
      const end = stat.lastIndexOf(')');
      if (!stat.startsWith(pid + ' (') || end < 0) sessionFail();
      const fields = stat.slice(end + 1).trim().split(/\s+/);
      if (fields.length < 20 || !/^\d+$/.test(fields[1]) || !DECIMAL.test(fields[19]) ||
          ['Z', 'X', 'x'].includes(fields[0])) sessionFail();
      const parentPid = Number(fields[1]);
      if (!Number.isSafeInteger(parentPid) || parentPid < 0 || parentPid > 0x7fffffff) sessionFail();
      return { pid, parentPid, uid: Number(before.uid), startTime: fields[19], dev: String(before.dev), ino: String(before.ino) };
    };
    const first = observe();
    if (canonical(first) !== canonical(observe()) ||
        !objectSame(before, fs.fstatSync(directory, { bigint: true })) ||
        !objectSame(before, fs.lstatSync(name, { bigint: true }))) sessionFail();
    return first;
  } finally { fs.closeSync(directory); }
}
// The missing-pin check is an ancestry check, not a global inventory audit.
// Enumerating every historical invocation and probing its lease made each new
// hook slower as completed invocation records accumulated. Session owners and
// descendants retain their lease descriptor; inspect those actual ancestors
// instead. The separate deployment inventory remains exhaustive/fail-closed.
// A non-dumpable current-user ancestor, such as the per-user sshd of an SSH
// login, hides its descriptor table: opendir fails with EACCES and the kernel
// owns /proc/<pid>/fd as root. Such a process cannot be a working session
// owner, because bound descendants verify the owner through its exe and fd
// entries (sessionProcess, ownerMatches), which it hides as well. Only that
// kernel-marked case is skipped; every other failure stays fail-closed.
function ancestorHasSessionLease(repositoryRoot, ancestor) {
  if (ancestor.uid !== process.getuid()) return false;
  const base = path.join(repositoryRoot, '.jhw-runtime/sessions') + path.sep;
  const fdPath = '/proc/' + ancestor.pid + '/fd';
  let descriptors;
  try { descriptors = fs.opendirSync(fdPath); }
  catch (error) {
    let owner = null;
    try { if (error?.code === 'EACCES') owner = fs.statSync(fdPath, { bigint: true }).uid; } catch { owner = null; }
    if (owner !== 0n) sessionFail();
    return false;
  }
  try {
    let item; let scanned = 0;
    while ((item = descriptors.readSync()) !== null) {
      if (++scanned > 65536 || !/^(?:0|[1-9][0-9]*)$/.test(item.name)) sessionFail();
      const descriptorPath = fdPath + '/' + item.name;
      let target;
      try { target = fs.readlinkSync(descriptorPath); }
      catch (error) { if (error.code === 'ENOENT') continue; sessionFail(); }
      if (!target.startsWith(base)) continue;
      const parts = target.slice(base.length).split(path.sep);
      // An ancestor holding a private/retired/unknown session lease is
      // uncertainty, never evidence that the pin may be discarded.
      if (parts.length !== 2 || !SESSION_ID.test(parts[0]) || parts[1] !== 'lease') sessionFail();
      const data = withStore(repositoryRoot, false, (runtime, root) => {
        if (!runtime) sessionFail();
        return sessionRecord(runtime, root, repositoryRoot, parts[0]);
      });
      const held = fs.statSync(descriptorPath, { bigint: true });
      if (String(held.dev) !== data.record.lease.dev ||
          String(held.ino) !== data.record.lease.ino) sessionFail();
      if (data.record.kind === 'session' || data.record.parentBinding !== null) return true;
    }
    return false;
  } finally { descriptors.closeSync(); }
}
export function assertNoSessionAncestor({ repositoryRoot, pid = process.pid }) {
  return sessionBoundary(() => {
    sessionRootName(repositoryRoot);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) sessionFail();
    // Check trusted store identity once, without scanning unrelated invocations.
    withStore(repositoryRoot, false, runtime => {
      if (!runtime) return;
      const sessions = sessionDirectory(runtime);
      sessions?.close();
    });
    const bootId = sessionBootId();
    const chain = [];
    let current = pid;
    let reachedInit = false;
    for (let depth = 0; depth < 256; depth++) {
      if (chain.some(item => item.pid === current)) sessionFail();
      const observed = sessionAncestorProcess(current);
      chain.push(observed);
      if (ancestorHasSessionLease(repositoryRoot, observed)) sessionFail();
      if (current === 1) { reachedInit = true; break; }
      if (!observed.parentPid || observed.parentPid === current) sessionFail();
      current = observed.parentPid;
    }
    if (!reachedInit) sessionFail();
    for (const before of chain.reverse()) {
      if (canonical(before) !== canonical(sessionAncestorProcess(before.pid)) ||
          ancestorHasSessionLease(repositoryRoot, before)) sessionFail();
    }
    if (bootId !== sessionBootId()) sessionFail();
  });
}
