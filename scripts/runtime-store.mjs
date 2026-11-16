import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DeploymentError, acquireLease, trustedDirectory } from './runtime-safety.mjs';

const C = fs.constants;
const RELEASE = /^r-([a-f0-9]{40}|[a-f0-9]{64})-([a-f0-9]{64})$/;
const ACTIVATION = /^a-[a-f0-9]{32}$/;
const BOOTSTRAP = /^b-[a-f0-9]{64}$/;
const MIGRATION = /^m-[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 100000;
const MAX_FILE = 128 * 1024 * 1024;
const MAX_MANIFEST = 32 * 1024 * 1024;
const COMPATIBILITY_DECLARATION = 'mcp-server/src/control/runtime-compatibility.json';
const BOOTSTRAP_HELPERS = ['runtime-entry.mjs', 'runtime-safety.mjs', 'runtime-store.mjs'];
const COMPATIBLE_CONTROL_IMPLEMENTATIONS = new Set([
  'guard-service', 'hook-adapter', 'hook-codecs', 'shell-classifier',
]);
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
function validateReleaseIn(runtime, repositoryRoot, releaseId, walkTree = true) {
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
    if (walkTree) {
      const entries = walk(release, { repositoryRoot });
      if (canonical(entries) !== canonical(manifest.entries)) fail('DEPLOY_RELEASE_INVALID');
    }
    requiredArtifacts(manifest.entries);
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

function requireLeaseIdentity(lease, file) {
  if (!lease || !Number.isInteger(lease.fd) || lease.fd < 0) fail('DEPLOY_BOOTSTRAP_INVALID');
  let held; let named;
  try { held = fs.fstatSync(lease.fd, {bigint:true}); named = fs.lstatSync(file, {bigint:true}); }
  catch { fail('DEPLOY_BOOTSTRAP_INVALID'); }
  if (!held.isFile() || held.uid !== BigInt(process.getuid()) || held.nlink !== 1n ||
      (Number(held.mode) & 0o7777) !== 0o600 || !same(held, named)) fail('DEPLOY_BOOTSTRAP_INVALID');
}

function bootstrapManifestId(manifest) {
  const {bootstrapId: _bootstrapId, ...identity} = manifest;
  return `b-${digest(canonical(identity))}`;
}

function generationSource(runtime, repositoryRoot, releaseId) {
  let releases; let release; let scripts;
  try {
    const validated = validateReleaseIn(runtime, repositoryRoot, releaseId);
    releases = runtime.child('releases', false, true);
    release = releases.child(releaseId, false, true);
    const manifest = readJson(release);
    if (canonical(summary(manifest)) !== canonical(validated)) fail('DEPLOY_BOOTSTRAP_INVALID');
    const declaration = compatibilityDeclaration(release, manifest);
    if (declaration?.generation !== 2) fail('DEPLOY_BOOTSTRAP_INVALID');
    scripts = release.child('scripts', false);
    const files = [];
    const helperBytes = new Map();
    for (const name of BOOTSTRAP_HELPERS) {
      const record = manifest.entries.find(entry => entry.path === `scripts/${name}`);
      if (!record || record.type !== 'file' || record.mode !== 0o644) fail('DEPLOY_BOOTSTRAP_INVALID');
      const retained = readBytes(scripts, name, 1024 * 1024);
      if (retained.mode !== 0o644 || digest(retained.bytes) !== record.sha256) fail('DEPLOY_BOOTSTRAP_INVALID');
      files.push({name, mode:0o644, sha256:record.sha256});
      helperBytes.set(name, retained.bytes);
    }
    release.verify(); scripts.verify();
    return {files, helperBytes};
  } catch { fail('DEPLOY_BOOTSTRAP_INVALID'); }
  finally { scripts?.close(); release?.close(); releases?.close(); }
}

function generationManifest(value, bootstrapId = null) {
  if (!exact(value, ['version','bootstrapId','runtimeContract','sourceReleaseId','files']) ||
      typeof value.version !== 'number' || typeof value.bootstrapId !== 'string' ||
      typeof value.runtimeContract !== 'number' || typeof value.sourceReleaseId !== 'string' ||
      value.version !== 1 || value.runtimeContract !== 2 || !BOOTSTRAP.test(value.bootstrapId) ||
      bootstrapId !== null && value.bootstrapId !== bootstrapId || !RELEASE.test(value.sourceReleaseId) ||
      !Array.isArray(value.files) || value.files.length !== BOOTSTRAP_HELPERS.length) return false;
  for (let index = 0; index < BOOTSTRAP_HELPERS.length; index++) {
    const record = value.files[index];
    if (!exact(record, ['name','mode','sha256']) || typeof record.name !== 'string' ||
        typeof record.mode !== 'number' || typeof record.sha256 !== 'string' ||
        record.name !== BOOTSTRAP_HELPERS[index] || record.mode !== 0o644 || !DIGEST.test(record.sha256)) return false;
  }
  return bootstrapManifestId(value) === value.bootstrapId;
}

function readGeneration(runtime, repositoryRoot, bootstrapId, requireCopy = true) {
  let v2; let catalog; let bootstraps; let generation;
  try {
    if (typeof bootstrapId !== 'string' || !BOOTSTRAP.test(bootstrapId)) fail('DEPLOY_BOOTSTRAP_INVALID');
    v2 = runtime.child('v2', false, true);
    catalog = v2.child('bootstrap-catalog', false, true);
    const catalogName = `${bootstrapId}.json`;
    const catalogRecord = readBytes(catalog, catalogName, 16384);
    if (catalogRecord.mode !== 0o600) fail('DEPLOY_BOOTSTRAP_INVALID');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(catalogRecord.bytes)); }
    catch { fail('DEPLOY_BOOTSTRAP_INVALID'); }
    if (!generationManifest(manifest, bootstrapId) || catalogRecord.bytes.toString('utf8') !== canonical(manifest) + '\n') fail('DEPLOY_BOOTSTRAP_INVALID');
    const source = generationSource(runtime, repositoryRoot, manifest.sourceReleaseId);
    if (canonical(source.files) !== canonical(manifest.files)) fail('DEPLOY_BOOTSTRAP_INVALID');
    if (!requireCopy) return {manifest, helperBytes:source.helperBytes, catalogBytes:catalogRecord.bytes};
    bootstraps = v2.child('bootstraps', false, true);
    generation = bootstraps.child(bootstrapId, false, true);
    if (canonical(names(generation)) !== canonical(['lease','manifest.json',...BOOTSTRAP_HELPERS])) fail('DEPLOY_BOOTSTRAP_INVALID');
    const generationRecord = readBytes(generation, 'manifest.json', 16384);
    if (generationRecord.mode !== 0o600 || !generationRecord.bytes.equals(catalogRecord.bytes)) fail('DEPLOY_BOOTSTRAP_INVALID');
    const lease = readBytes(generation, 'lease', 1);
    if (lease.mode !== 0o600 || lease.bytes.length !== 0) fail('DEPLOY_BOOTSTRAP_INVALID');
    const helperBytes = new Map();
    for (const record of manifest.files) {
      const retained = readBytes(generation, record.name, 1024 * 1024);
      if (retained.mode !== record.mode || digest(retained.bytes) !== record.sha256 ||
          !retained.bytes.equals(source.helperBytes.get(record.name))) fail('DEPLOY_BOOTSTRAP_INVALID');
      helperBytes.set(record.name, retained.bytes);
    }
    generation.verify();
    return {manifest, helperBytes, catalogBytes:catalogRecord.bytes};
  } catch (error) { boundary(error, 'DEPLOY_BOOTSTRAP_INVALID'); }
  finally { generation?.close(); bootstraps?.close(); catalog?.close(); v2?.close(); }
}

export function validateBootstrapGeneration({repositoryRoot, bootstrapId}) {
  return withStore(repositoryRoot, false, runtime => {
    if (!runtime) fail('DEPLOY_BOOTSTRAP_INVALID');
    const {manifest, helperBytes} = readGeneration(runtime, repositoryRoot, bootstrapId);
    return {manifest, helperBytes};
  });
}

function generationNamespaces(runtime) {
  const v2 = runtime.child('v2', true, true);
  let catalog; let bootstraps;
  try {
    catalog = v2.child('bootstrap-catalog', true, true);
    bootstraps = v2.child('bootstraps', true, true);
    return {v2, catalog, bootstraps};
  } catch (error) { catalog?.close(); bootstraps?.close(); v2.close(); throw error; }
}

function publishGeneration({runtime, repositoryRoot, manifest, helperBytes}) {
  const encoded = Buffer.from(canonical(manifest) + '\n');
  const {v2, catalog, bootstraps} = generationNamespaces(runtime);
  let stage;
  try {
    const catalogName = `${manifest.bootstrapId}.json`;
    try {
      const prior = readBytes(catalog, catalogName, 16384);
      if (prior.mode !== 0o600 || !prior.bytes.equals(encoded)) fail('DEPLOY_BOOTSTRAP_INVALID');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      writeBytes(catalog, catalogName, encoded, 0o600); fs.fsyncSync(catalog.fd);
    }
    try { return readGeneration(runtime, repositoryRoot, manifest.bootstrapId); }
    catch (error) {
      try { bootstraps.child(manifest.bootstrapId, false, true).close(); throw error; }
      catch (missing) { if (missing.code !== 'ENOENT') throw error; }
    }
    const stageName = `.stage.${manifest.bootstrapId}.${randomBytes(16).toString('hex')}`;
    stage = bootstraps.child(stageName, true, true);
    writeBytes(stage, 'manifest.json', encoded, 0o600);
    writeBytes(stage, 'lease', Buffer.alloc(0), 0o600);
    for (const name of BOOTSTRAP_HELPERS) writeBytes(stage, name, helperBytes.get(name), 0o644);
    fs.fsyncSync(stage.fd); stage.verify(); bootstraps.verify();
    fs.renameSync(bootstraps.at(stageName), bootstraps.at(manifest.bootstrapId)); fs.fsyncSync(bootstraps.fd);
    stage.close(); stage = undefined;
    return readGeneration(runtime, repositoryRoot, manifest.bootstrapId);
  } finally { stage?.close(); bootstraps.close(); catalog.close(); v2.close(); }
}

export function ensureBootstrapGeneration({repositoryRoot, releaseId, reuseBootstrapId = null, deployLease}) {
  requireLeaseIdentity(deployLease, path.join(repositoryRoot, '.jhw-runtime/deploy.lock'));
  return withStore(repositoryRoot, false, runtime => {
    if (!runtime) fail('DEPLOY_BOOTSTRAP_INVALID');
    const source = generationSource(runtime, repositoryRoot, releaseId);
    let manifest;
    if (reuseBootstrapId !== null) {
      const existing = readGeneration(runtime, repositoryRoot, reuseBootstrapId);
      if (canonical(existing.manifest.files) !== canonical(source.files)) fail('DEPLOY_BOOTSTRAP_INVALID');
      manifest = existing.manifest;
    } else {
      const identity = {version:1,runtimeContract:2,sourceReleaseId:releaseId,files:source.files};
      manifest = {...identity, bootstrapId:`b-${digest(canonical(identity))}`};
      manifest = {version:manifest.version,bootstrapId:manifest.bootstrapId,runtimeContract:manifest.runtimeContract,
        sourceReleaseId:manifest.sourceReleaseId,files:manifest.files};
      publishGeneration({runtime, repositoryRoot, manifest, helperBytes:source.helperBytes});
    }
    return {releaseId,bootstrapId:manifest.bootstrapId,runtimeContract:2,
      compatibilityDigest:releaseCompatibilityIn(runtime,repositoryRoot,releaseId)};
  });
}

export function restoreBootstrapGeneration({repositoryRoot, bootstrapId, deployLease}) {
  requireLeaseIdentity(deployLease, path.join(repositoryRoot, '.jhw-runtime/deploy.lock'));
  return withStore(repositoryRoot, false, runtime => {
    if (!runtime) fail('DEPLOY_BOOTSTRAP_INVALID');
    const source = readGeneration(runtime, repositoryRoot, bootstrapId, false);
    publishGeneration({runtime, repositoryRoot, manifest:source.manifest, helperBytes:source.helperBytes});
    return {bootstrapId,sourceReleaseId:source.manifest.sourceReleaseId,runtimeContract:2};
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
    if (!/^(?:activations|v2\/activations)\/a-[a-f0-9]{32}$/.test(target)) fail('DEPLOY_ACTIVATION_INVALID');
    return { target, dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(stat.ctimeNs) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validObservation(value, activationId, prefix) {
  return exact(value, ['target', 'dev', 'ino', 'ctimeNs']) && value.target === `${prefix}/${activationId}` &&
    ['dev', 'ino', 'ctimeNs'].every(key => typeof value[key] === 'string' && /^\d{1,32}$/.test(value[key]));
}
export function validV1Current(value) {
  if (value === null) return true;
  return exact(value, ['activationId', 'releaseId', 'predecessorActivationId', 'observation']) &&
    ACTIVATION.test(value.activationId) && RELEASE.test(value.releaseId) &&
    (value.predecessorActivationId === null || ACTIVATION.test(value.predecessorActivationId)) &&
    validObservation(value.observation, value.activationId, 'activations');
}
function validV2SnapshotScalarTypes(value) {
  return typeof value.version === 'number' && typeof value.activationId === 'string' &&
    typeof value.releaseId === 'string' && typeof value.bootstrapId === 'string' &&
    typeof value.runtimeContract === 'number' && typeof value.compatibilityDigest === 'string' &&
    (value.predecessorActivationId === null || typeof value.predecessorActivationId === 'string') &&
    (value.migrationId === null || typeof value.migrationId === 'string') &&
    exact(value.observation, ['target', 'dev', 'ino', 'ctimeNs']) &&
    ['target', 'dev', 'ino', 'ctimeNs'].every(key => typeof value.observation[key] === 'string');
}
function validV2Current(value) {
  if (value === null) return true;
  return exact(value, ['version', 'activationId', 'releaseId', 'bootstrapId', 'runtimeContract',
    'compatibilityDigest', 'predecessorActivationId', 'migrationId', 'observation']) &&
    validV2SnapshotScalarTypes(value) && value.version === 2 &&
    ACTIVATION.test(value.activationId) && RELEASE.test(value.releaseId) && BOOTSTRAP.test(value.bootstrapId) &&
    value.runtimeContract === 2 && DIGEST.test(value.compatibilityDigest) &&
    (value.predecessorActivationId === null || ACTIVATION.test(value.predecessorActivationId)) &&
    (value.migrationId === null || value.predecessorActivationId === null && MIGRATION.test(value.migrationId)) &&
    validObservation(value.observation, value.activationId, 'v2/activations');
}
export function validCurrent(value) {
  return validV1Current(value) || validV2Current(value);
}
export function validRuntimePair(value) {
  return exact(value, ['releaseId', 'bootstrapId', 'runtimeContract', 'compatibilityDigest']) &&
    typeof value.releaseId === 'string' && typeof value.bootstrapId === 'string' &&
    typeof value.runtimeContract === 'number' && typeof value.compatibilityDigest === 'string' &&
    RELEASE.test(value.releaseId) && BOOTSTRAP.test(value.bootstrapId) && value.runtimeContract === 2 &&
    DIGEST.test(value.compatibilityDigest);
}
function validV2ActivationManifest(value, activationId) {
  if (!exact(value, ['version', 'activationId', 'releaseId', 'bootstrapId', 'runtimeContract',
      'compatibilityDigest', 'predecessorActivationId', 'migrationId', 'createdAt', 'priorCurrent']) ||
      typeof value.version !== 'number' || typeof value.activationId !== 'string' ||
      typeof value.releaseId !== 'string' || typeof value.bootstrapId !== 'string' ||
      typeof value.runtimeContract !== 'number' || typeof value.compatibilityDigest !== 'string' ||
      value.predecessorActivationId !== null && typeof value.predecessorActivationId !== 'string' ||
      value.migrationId !== null && typeof value.migrationId !== 'string' ||
      typeof value.createdAt !== 'string' ||
      value.priorCurrent !== null && (typeof value.priorCurrent !== 'object' || Array.isArray(value.priorCurrent)) ||
      value.version !== 2 || value.activationId !== activationId || !validRuntimePair({
        releaseId: value.releaseId, bootstrapId: value.bootstrapId, runtimeContract: value.runtimeContract,
        compatibilityDigest: value.compatibilityDigest,
      }) ||
      !timestamp(value.createdAt) || !validV2Current(value.priorCurrent) ||
      value.predecessorActivationId !== (value.priorCurrent?.activationId ?? null) ||
      value.predecessorActivationId === activationId || value.priorCurrent !== null && value.migrationId !== null) return false;
  return value.migrationId === null || MIGRATION.test(value.migrationId);
}
function activationIn(runtime, repositoryRoot, activationId, walkTree = true, version = 1) {
  let namespace; let activations; let activation;
  try {
    if (!ACTIVATION.test(activationId)) fail('DEPLOY_ACTIVATION_INVALID');
    if (version === 2) {
      namespace = runtime.child('v2', false, true);
      activations = namespace.child('activations', false, true);
    } else {
      activations = runtime.child('activations', false, true);
    }
    activation = activations.child(activationId, false, true);
    const children = version === 2 ? ['bootstrap', 'manifest.json', 'mcp-server', 'scripts', 'skills'] :
      ['manifest.json', 'mcp-server', 'scripts', 'skills'];
    if (canonical(names(activation)) !== canonical(children)) fail('DEPLOY_ACTIVATION_INVALID');
    const manifest = readJson(activation);
    if (version === 2 ? !validV2ActivationManifest(manifest, activationId) :
        !exact(manifest, ['version', 'activationId', 'releaseId', 'predecessorActivationId', 'createdAt', 'priorCurrent']) ||
        manifest.version !== 1 || manifest.activationId !== activationId || !RELEASE.test(manifest.releaseId) ||
        !timestamp(manifest.createdAt) || !validV1Current(manifest.priorCurrent) ||
        manifest.predecessorActivationId !== (manifest.priorCurrent?.activationId ?? null) || manifest.predecessorActivationId === activationId) fail('DEPLOY_ACTIVATION_INVALID');
    for (const name of ['mcp-server', 'scripts', 'skills']) {
      const target = version === 2 ? `../../../releases/${manifest.releaseId}/${name}` : `../../releases/${manifest.releaseId}/${name}`;
      if (readLink(activation, name).target !== target) fail('DEPLOY_ACTIVATION_INVALID');
    }
    if (version === 2 && readLink(activation, 'bootstrap').target !== `../../bootstraps/${manifest.bootstrapId}`) fail('DEPLOY_ACTIVATION_INVALID');
    if (version === 2) {
      if (releaseCompatibilityIn(runtime, repositoryRoot, manifest.releaseId, walkTree) !== manifest.compatibilityDigest) fail('DEPLOY_ACTIVATION_INVALID');
    } else {
      validateReleaseIn(runtime, repositoryRoot, manifest.releaseId, walkTree);
    }
    if (canonical(readJson(activation)) !== canonical(manifest)) fail('DEPLOY_ACTIVATION_INVALID');
    return manifest;
  } catch (error) { boundary(error, 'DEPLOY_ACTIVATION_INVALID'); }
  finally { activation?.close(); activations?.close(); namespace?.close(); }
}
function currentIn(runtime, repositoryRoot, walkTree = true) {
  if (!runtime) return null;
  const before = observation(runtime);
  if (!before) return null;
  const version = before.target.startsWith('v2/') ? 2 : 1;
  const prefix = version === 2 ? 'v2/activations/' : 'activations/';
  const manifest = activationIn(runtime, repositoryRoot, before.target.slice(prefix.length), walkTree, version);
  if (canonical(before) !== canonical(observation(runtime))) fail('DEPLOY_CURRENT_CHANGED');
  if (version === 1) return { activationId: manifest.activationId, releaseId: manifest.releaseId,
    predecessorActivationId: manifest.predecessorActivationId, observation: before };
  return { version: 2, activationId: manifest.activationId, releaseId: manifest.releaseId,
    bootstrapId: manifest.bootstrapId, runtimeContract: manifest.runtimeContract,
    compatibilityDigest: manifest.compatibilityDigest, predecessorActivationId: manifest.predecessorActivationId,
    migrationId: manifest.migrationId, observation: before };
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
    if (!validV1Current(expectedCurrent)) fail('DEPLOY_CURRENT_CHANGED');
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
    if (!validV1Current(expectedCurrent)) fail('DEPLOY_CURRENT_CHANGED');
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
const INVOCATION_ID = /^i-[a-f0-9]{32}$/;
const V2_ROOT_TOKEN = /^v2:(b-[a-f0-9]{64}):(s-[a-f0-9]{32}):([a-f0-9]{64})$/;
const SESSION_LIMIT = 1024;
const SESSION_MANIFEST_LIMIT = 16 * 1024;
const PROCESS_RECORD_LIMIT = 128 * 1024;
const DECIMAL = /^\d{1,32}$/;
// BigInt stats are signed 64-bit, so an inode or device number above 2^63 reads
// as negative. Identity is compared as the same string, so only the sign is new.
const SIGNED_DECIMAL = /^-?\d{1,32}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
function validRepositoryIdentity(value, repositoryRoot = null, rootStat = null) {
  if (!exact(value, ['path', 'dev', 'ino']) || typeof value.path !== 'string' || !path.isAbsolute(value.path) ||
      path.resolve(value.path) !== value.path || value.path.includes('\0') ||
      !SIGNED_DECIMAL.test(value.dev) || !SIGNED_DECIMAL.test(value.ino)) return false;
  return repositoryRoot === null || value.path === repositoryRoot && value.dev === String(rootStat.dev) &&
    value.ino === String(rootStat.ino);
}
function validOwnerIdentity(value) {
  return exact(value, ['uid', 'pid', 'startTime', 'bootId', 'commandDigest', 'exeDev', 'exeIno']) &&
    value.uid === process.getuid() && nonnegativeInteger(value.pid) && value.pid >= 1 &&
    DECIMAL.test(value.startTime) && BOOT_ID.test(value.bootId) && DIGEST.test(value.commandDigest) &&
    SIGNED_DECIMAL.test(value.exeDev) && SIGNED_DECIMAL.test(value.exeIno);
}
function validManifestIdentity(value, file = null) {
  return exact(value, ['dev', 'ino']) && SIGNED_DECIMAL.test(value.dev) && SIGNED_DECIMAL.test(value.ino) &&
    (file === null || value.dev === String(file.dev) && value.ino === String(file.ino));
}
function validLeaseIdentity(value, lease = null) {
  if (!exact(value, ['dev', 'ino', 'fd']) || !SIGNED_DECIMAL.test(value.dev) || !SIGNED_DECIMAL.test(value.ino) ||
      !nonnegativeInteger(value.fd) || value.fd > 1048576) return false;
  return lease === null || lease.isFile() && lease.uid === BigInt(process.getuid()) && lease.nlink === 1n &&
    (Number(lease.mode) & 0o7777) === 0o600 && value.dev === String(lease.dev) && value.ino === String(lease.ino);
}
function validV2RecordScalarTypes(value) {
  return typeof value.version === 'number' && typeof value.id === 'string' && typeof value.kind === 'string' &&
    typeof value.releaseId === 'string' && typeof value.bootstrapId === 'string' &&
    typeof value.runtimeContract === 'number' && typeof value.compatibilityDigest === 'string' &&
    (value.parentBinding === null || typeof value.parentBinding === 'string') &&
    exact(value.repository, ['path', 'dev', 'ino']) && typeof value.repository.path === 'string' &&
    typeof value.repository.dev === 'string' && typeof value.repository.ino === 'string' &&
    exact(value.owner, ['uid', 'pid', 'startTime', 'bootId', 'commandDigest', 'exeDev', 'exeIno']) &&
    typeof value.owner.uid === 'number' && typeof value.owner.pid === 'number' &&
    typeof value.owner.startTime === 'string' && typeof value.owner.bootId === 'string' &&
    typeof value.owner.commandDigest === 'string' && typeof value.owner.exeDev === 'string' &&
    typeof value.owner.exeIno === 'string' && exact(value.manifest, ['dev', 'ino']) &&
    typeof value.manifest.dev === 'string' && typeof value.manifest.ino === 'string' &&
    exact(value.lease, ['dev', 'ino', 'fd']) && typeof value.lease.dev === 'string' &&
    typeof value.lease.ino === 'string' && typeof value.lease.fd === 'number' && typeof value.createdAt === 'string';
}
// This is the pure closed-schema gate. The v2 reader additionally resolves the
// recorded process, manifest, lease, and parent token identities before use.
export function validV2SessionRecord(value) {
  if (!exact(value, ['version', 'id', 'kind', 'releaseId', 'bootstrapId', 'runtimeContract',
    'compatibilityDigest', 'parentBinding', 'repository', 'owner', 'manifest', 'lease', 'createdAt'])) return false;
  if (!validV2RecordScalarTypes(value) || value.version !== 2 || !validRuntimePair({
      releaseId: value.releaseId, bootstrapId: value.bootstrapId, runtimeContract: value.runtimeContract,
      compatibilityDigest: value.compatibilityDigest,
    }) || !timestamp(value.createdAt) || !validRepositoryIdentity(value.repository) ||
      !validOwnerIdentity(value.owner) || !validManifestIdentity(value.manifest) ||
      !validLeaseIdentity(value.lease)) return false;
  if (SESSION_ID.test(value.id)) return value.kind === 'session' && value.parentBinding === null;
  if (!INVOCATION_ID.test(value.id) || value.kind !== 'invocation') return false;
  if (value.parentBinding === null) return true;
  if (typeof value.parentBinding !== 'string') return false;
  const parent = V2_ROOT_TOKEN.exec(value.parentBinding);
  return parent !== null && parent[1] === value.bootstrapId;
}
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
    if (token !== null && token !== actualToken ||
        !exact(record, ['version', 'id', 'kind', 'releaseId', 'compatibilityDigest', 'parentBinding',
          'repository', 'owner', 'manifest', 'lease', 'createdAt']) ||
        record.version !== 1 || record.id !== id || !['session', 'invocation'].includes(record.kind) ||
        !RELEASE.test(record.releaseId) || !DIGEST.test(record.compatibilityDigest) ||
        !(record.parentBinding === null || typeof record.parentBinding === 'string' && SESSION_TOKEN.test(record.parentBinding)) ||
        record.kind === 'session' && record.parentBinding !== null || !timestamp(record.createdAt) ||
        !validRepositoryIdentity(record.repository, repositoryRoot, root.stat) ||
        !validOwnerIdentity(record.owner) || !validManifestIdentity(record.manifest, file) ||
        !validLeaseIdentity(record.lease, lease) ||
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
function compatibleControlEntry(name) {
  if (name === 'mcp-server/dist/runtime/control.cjs' || name === 'mcp-server/dist/runtime/hook.cjs') return true;
  const source = /^mcp-server\/src\/control\/([^/]+)\.ts$/.exec(name);
  if (source) return COMPATIBLE_CONTROL_IMPLEMENTATIONS.has(source[1]);
  const compiled = /^mcp-server\/dist\/control\/([^/]+)\.(?:js(?:\.map)?|d\.ts(?:\.map)?)$/.exec(name);
  return compiled !== null && COMPATIBLE_CONTROL_IMPLEMENTATIONS.has(compiled[1]);
}
function compatibleControlTestEntry(name) {
  return name.startsWith('mcp-server/src/control/__tests__/') || name.startsWith('mcp-server/src/control/__fixtures__/');
}
function flexibleMarkdownEntry(entry) {
  return entry.type === 'file' && entry.path.startsWith('skills/') && entry.path.endsWith('.md') &&
    !entry.path.slice('skills/'.length).split('/').includes('scripts') && (entry.mode & 0o111) === 0;
}
const GENERATION_HELPERS = new Set([
  'scripts/runtime-entry.mjs', 'scripts/runtime-safety.mjs', 'scripts/runtime-store.mjs',
]);
function compatibilityEntry(entry, generation = 1) {
  if (entry.type === 'file' && (compatibleMcpEntry(entry.path) || compatibleControlEntry(entry.path) ||
      compatibleControlTestEntry(entry.path) || flexibleMarkdownEntry(entry) || entry.path === COMPATIBILITY_DECLARATION ||
      generation === 2 && GENERATION_HELPERS.has(entry.path))) {
    const { sha256, ...identity } = entry;
    return identity;
  }
  return entry;
}
function retainedFile(release, relative) {
  const parts = relative.split('/');
  const directories = [];
  let directory = release;
  try {
    for (const part of parts.slice(0, -1)) {
      directory = directory.child(part);
      directories.push(directory);
    }
    return readBytes(directory, parts.at(-1));
  } finally {
    for (const child of directories.reverse()) child.close();
  }
}
function compatibilityDeclaration(release, manifest) {
  const entry = manifest.entries.find(candidate => candidate.path === COMPATIBILITY_DECLARATION);
  if (!entry) {
    try { retainedFile(release, COMPATIBILITY_DECLARATION); }
    catch (error) { if (error.code === 'ENOENT') return null; fail('DEPLOY_RELEASE_INVALID'); }
    fail('DEPLOY_RELEASE_INVALID');
  }
  if (entry.type !== 'file') fail('DEPLOY_RELEASE_INVALID');
  let retained;
  try { retained = retainedFile(release, COMPATIBILITY_DECLARATION); }
  catch { fail('DEPLOY_RELEASE_INVALID'); }
  const { bytes, mode } = retained;
  if (mode !== entry.mode || digest(bytes) !== entry.sha256) fail('DEPLOY_RELEASE_INVALID');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('DEPLOY_RELEASE_INVALID'); }
  if (!exact(value, ['version', 'generation', 'guardFloor']) || value.version !== 1 ||
      ![1, 2].includes(value.generation) ||
      !Number.isSafeInteger(value.guardFloor) || value.guardFloor <= 0) fail('DEPLOY_RELEASE_INVALID');
  return value;
}
function releaseCompatibilityIn(runtime, repositoryRoot, releaseId, walkTree = true) {
  const validated = validateReleaseIn(runtime, repositoryRoot, releaseId, walkTree);
  let releases; let release;
  try {
    releases = runtime.child('releases', false, true);
    release = releases.child(releaseId, false, true);
    const manifest = readJson(release);
    if (canonical(summary(manifest)) !== canonical(validated) || contentDigest(manifest) !== validated.contentDigest) fail('DEPLOY_RELEASE_INVALID');
    const declaration = compatibilityDeclaration(release, manifest);
    if (declaration?.generation === 2) {
      const helpers = manifest.entries.filter(entry => GENERATION_HELPERS.has(entry.path));
      if (helpers.length !== GENERATION_HELPERS.size || helpers.some(entry => entry.type !== 'file')) fail('DEPLOY_RELEASE_INVALID');
    }
    const result = declaration === null
      ? digest(canonical({ version: 1, entries: manifest.entries.filter(entry => !compatibleMcpEntry(entry.path)) }))
      : declaration.generation === 1
        ? digest(canonical({ version: 2, generation: declaration.generation, guardFloor: declaration.guardFloor,
            entries: manifest.entries.map(entry => compatibilityEntry(entry, 1)) }))
        : digest(canonical({ version: 3, generation: declaration.generation, guardFloor: declaration.guardFloor,
            runtimeContract: 2, routerContract: 1,
            entries: manifest.entries.map(entry => compatibilityEntry(entry, 2)) }));
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
function verifyLiveSession(runtime, repositoryRoot, data, walkTree = true) {
  if (!leaseIsHeld(data.leaseFile)) sessionFail();
  ownerMatches(data.record);
  if (releaseCompatibilityIn(runtime, repositoryRoot, data.record.releaseId, walkTree) !== data.record.compatibilityDigest) sessionFail();
  if (!leaseIsHeld(data.leaseFile)) sessionFail();
  ownerMatches(data.record);
}
export function resolveSessionBinding({ repositoryRoot, token, pid = process.pid }) {
  return resolveSessionBindingWith({ repositoryRoot, token, pid }, true);
}
function resolveSessionBindingWith({ repositoryRoot, token, pid }, walkTree) {
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
      verifyLiveSession(runtime, repositoryRoot, data, walkTree);
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
          // A record whose holder finished after the snapshot is not live: it was
          // retired (close() or entry reclaim) or its lease is no longer held.
          // Re-check that under the shared index lease; anything else stays fail-closed.
          const ended = () => {
            const recheck = sessionIndexLease(repositoryRoot, true);
            try {
              sessions.verify();
              try { fs.lstatSync(sessions.at(data.record.id)); }
              catch (missing) { if (missing.code !== 'ENOENT') throw missing; return true; }
              return !leaseIsHeld(data.leaseFile);
            } finally { recheck.close(); }
          };
          let held;
          try { held = leaseIsHeld(data.leaseFile); }
          catch (error) { if (ended()) continue; throw error; }
          if (!held) continue;
          try {
            verifyLiveSession(runtime, repositoryRoot, data);
            if (data.record.parentBinding !== null) {
              const parent = resolveSessionBinding({ repositoryRoot, token: data.record.parentBinding, pid: data.record.owner.pid });
              if (parent.releaseId !== data.record.releaseId) sessionFail();
            }
          } catch (error) { if (ended()) continue; throw error; }
          result.push({ ...data.record, token: data.token, live: true });
        }
        return result;
      } finally { sessions.close(); }
    });
  });
}
export function createSessionBinding({ repositoryRoot, releaseId, kind = 'session', parentBinding = null }) {
  return createSessionBindingWith({ repositoryRoot, releaseId, kind, parentBinding }, true);
}
/** Entry selection reads manifests only; the one full release walk is the compatibility digest inside binding creation. */
export function bindEntryRelease({ repositoryRoot, token, kind = 'invocation' }) {
  let releaseId;
  if (token !== undefined) releaseId = resolveSessionBindingWith({ repositoryRoot, token, pid: process.pid }, false).releaseId;
  else {
    const selected = withStore(repositoryRoot, false, runtime => currentIn(runtime, repositoryRoot, false));
    if (!selected) fail('DEPLOY_NO_CURRENT');
    releaseId = selected.releaseId;
  }
  // Unbound entries report the walk's own code, as the separate selection walk did; sessionBoundary would relabel it.
  const walked = {};
  let binding;
  try { binding = createSessionBindingWith({ repositoryRoot, releaseId, kind, parentBinding: token ?? null }, false, token === undefined ? walked : null); }
  catch (error) { throw walked.error ?? error; }
  return { releaseId, binding };
}
function createSessionBindingWith({ repositoryRoot, releaseId, kind, parentBinding }, walkParent, walked = null) {
  return sessionBoundary(() => {
    sessionRootName(repositoryRoot);
    if (!['session', 'invocation'].includes(kind) || kind === 'session' && parentBinding !== null ||
        !(parentBinding === null || typeof parentBinding === 'string' && SESSION_TOKEN.test(parentBinding))) sessionFail();
    if (parentBinding !== null) {
      const parent = resolveSessionBindingWith({ repositoryRoot, token: parentBinding, pid: process.pid }, walkParent);
      if (parent.releaseId !== releaseId) sessionFail();
    }
    return withStore(repositoryRoot, false, (runtime, root) => {
      if (!runtime) sessionFail();
      let compatibilityDigest;
      try { compatibilityDigest = releaseCompatibilityIn(runtime, repositoryRoot, releaseId); }
      catch (error) { if (walked && error instanceof DeploymentError) walked.error = error; throw error; }
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
    let reachedTop = false;
    for (let depth = 0; depth < 256; depth++) {
      if (chain.some(item => item.pid === current)) sessionFail();
      const observed = sessionAncestorProcess(current);
      chain.push(observed);
      if (ancestorHasSessionLease(repositoryRoot, observed)) sessionFail();
      // The visible lineage ends at PID 1 or at a process whose parent lies
      // outside this PID namespace (PPID 0, e.g. entered by setns or docker exec).
      // Every visible process up to there was still checked for a session lease;
      // a lease inherited across the boundary stays visible on that process.
      if (current === 1 || observed.parentPid === 0) { reachedTop = true; break; }
      if (observed.parentPid === current) sessionFail();
      current = observed.parentPid;
    }
    if (!reachedTop) sessionFail();
    for (const before of chain.reverse()) {
      if (canonical(before) !== canonical(sessionAncestorProcess(before.pid)) ||
          ancestorHasSessionLease(repositoryRoot, before)) sessionFail();
    }
    if (bootId !== sessionBootId()) sessionFail();
  });
}
