import fs from 'node:fs';
import path from 'node:path';

import {DeploymentError} from './runtime-safety.mjs';


const C = fs.constants;
const PROFILE_BYTES = 4096;
const MAX_MARKERS = 8192;
const LINUX_O_PATH = 0o10000000;
const PROFILE_KEYS = [
  'clientUid', 'node', 'repositoryRoot', 'serviceHome', 'serviceUid', 'socket', 'version',
];
const BOOTSTRAP = /^b-[a-f0-9]{64}$/u;
const MARKER = /^(b-[a-f0-9]{64})\.i-[a-f0-9]{32}\.json$/u;
const issuedScopes = new WeakMap();

function failure(code) {
  throw new DeploymentError(code);
}

function modeRequired() {
  failure('DEPLOY_MANAGED_MODE_REQUIRED');
}

function recoveryRequired() {
  failure('DEPLOY_MANAGED_RECOVERY_REQUIRED');
}

function absoluteName(value) {
  if (typeof value !== 'string') modeRequired();
  const parts = value === '/' ? [] : value.slice(1).split('/');
  if (!value.startsWith('/') || value.includes('//')
      || parts.some(part => !part || part === '.' || part === '..')
      || [...value].some(character => character.codePointAt(0) < 32)
      || path.resolve(value) !== value) modeRequired();
  return value;
}

function sameObject(left, right) {
  return ['dev', 'ino', 'uid', 'gid', 'mode'].every(key => left[key] === right[key]);
}

function sameFile(left, right) {
  return sameObject(left, right)
    && ['nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

function closeChain(chain) {
  if (!chain) return;
  for (const record of chain.records.reverse()) {
    try { fs.closeSync(record.fd); } catch { /* already invalidated */ }
  }
  chain.records.length = 0;
}

function trustedDirectoryStat(stat, uid, leaf, rootOnly, name) {
  if (!stat.isDirectory()) modeRequired();
  const owner = Number(stat.uid);
  if (rootOnly ? owner !== 0 : owner !== 0 && owner !== uid) modeRequired();
  const mode = Number(stat.mode) & 0o7777;
  const stickyTmp = name === '/tmp' && owner === 0 && (mode & 0o1000) !== 0;
  if ((mode & 0o022) !== 0 && !stickyTmp) modeRequired();
  if (leaf && !rootOnly && owner !== uid) modeRequired();
}

function openDirectoryChain(name, uid, {rootOnly = false} = {}) {
  const target = absoluteName(name);
  const records = [];
  try {
    const parts = target.split('/').filter(Boolean);
    let current = '/';
    let fd = fs.openSync('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    let info = fs.fstatSync(fd, {bigint: true});
    records.push({fd, name: current, stat: info});
    trustedDirectoryStat(info, uid, parts.length === 0, rootOnly, current);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      fd = fs.openSync(`/proc/self/fd/${records.at(-1).fd}/${parts[index]}`,
        C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      info = fs.fstatSync(fd, {bigint: true});
      records.push({fd, name: current, stat: info});
      const leaf = index === parts.length - 1;
      trustedDirectoryStat(info, uid, leaf, rootOnly, current);
    }
    return {records, fd: records.at(-1).fd, name: target};
  } catch (error) {
    closeChain({records});
    if (error instanceof DeploymentError) throw error;
    modeRequired();
  }
}

function verifyChain(chain, code) {
  try {
    for (const record of chain.records) {
      if (!sameObject(record.stat, fs.fstatSync(record.fd, {bigint: true}))
          || !sameObject(record.stat, fs.lstatSync(record.name, {bigint: true}))) failure(code);
    }
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    failure(code);
  }
}

function appendPrivateChild(chain, child, uid) {
  const parent = chain.records.at(-1);
  const name = path.join(parent.name, child);
  let fd;
  try {
    fd = fs.openSync(`/proc/self/fd/${parent.fd}/${child}`,
      C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const info = fs.fstatSync(fd, {bigint: true});
    if (!info.isDirectory() || Number(info.uid) !== uid || (Number(info.mode) & 0o7777) !== 0o700) {
      recoveryRequired();
    }
    chain.records.push({fd, name, stat: info});
    chain.fd = fd;
    chain.name = name;
  } catch (error) {
    if (fd !== undefined && chain.records.at(-1)?.fd !== fd) fs.closeSync(fd);
    if (error instanceof DeploymentError) throw error;
    recoveryRequired();
  }
}

function readSmallFile(fd, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) modeRequired();
    offset += count;
  }
  return bytes;
}

function readDescriptorFlags(fd) {
  let descriptor;
  try {
    descriptor = fs.openSync(`/proc/self/fdinfo/${fd}`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const bytes = Buffer.alloc(PROFILE_BYTES + 1);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, null);
    if (length > PROFILE_BYTES || fs.readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) modeRequired();
    const lines = bytes.subarray(0, length).toString('ascii').split('\n').filter(line => line.startsWith('flags:'));
    const match = lines.length === 1 ? /^flags:\s+([0-7]+)$/u.exec(lines[0]) : null;
    if (!match) modeRequired();
    return Number.parseInt(match[1], 8);
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    modeRequired();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function exactProfile(text, value) {
  let keys;
  try {
    keys = [...text.matchAll(/"((?:\\.|[^"\\])*)"\s*:/gu)]
      .map(match => JSON.parse(`"${match[1]}"`)).sort();
  } catch { modeRequired(); }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && keys.length === PROFILE_KEYS.length
    && keys.every((key, index) => key === PROFILE_KEYS[index])
    && Object.keys(value).length === PROFILE_KEYS.length
    && Object.keys(value).sort().every((key, index) => key === PROFILE_KEYS[index]);
}

function readProfile(profileFd) {
  const descriptorFlags = Number.isSafeInteger(profileFd) && profileFd >= 0
    ? readDescriptorFlags(profileFd)
    : null;
  if (descriptorFlags === null || (descriptorFlags & 3) !== C.O_RDONLY
      || (descriptorFlags & LINUX_O_PATH) !== 0) {
    modeRequired();
  }
  let profilePath;
  let duplicate;
  let chain;
  try {
    profilePath = absoluteName(fs.readlinkSync(`/proc/self/fd/${profileFd}`));
    chain = openDirectoryChain(path.dirname(profilePath), 0, {rootOnly: true});
    duplicate = fs.openSync(`/proc/self/fd/${profileFd}`, C.O_RDONLY);
    const before = fs.fstatSync(duplicate, {bigint: true});
    const named = fs.lstatSync(profilePath, {bigint: true});
    const mode = Number(before.mode);
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (mode & 0o7022) !== 0
        || !sameFile(before, fs.fstatSync(profileFd, {bigint: true})) || !sameFile(before, named)
        || before.size < 1n || before.size > BigInt(PROFILE_BYTES)) modeRequired();
    const text = new TextDecoder('utf-8', {fatal: true}).decode(readSmallFile(duplicate, Number(before.size)));
    const after = fs.fstatSync(duplicate, {bigint: true});
    verifyChain(chain, 'DEPLOY_MANAGED_MODE_REQUIRED');
    if (!sameFile(before, after) || !sameFile(before, fs.lstatSync(profilePath, {bigint: true}))) modeRequired();
    let value;
    try { value = JSON.parse(text); } catch { modeRequired(); }
    if (!exactProfile(text, value)) modeRequired();
    return {profilePath, profileFd: duplicate, profileStat: before, profileChain: chain, value};
  } catch (error) {
    if (duplicate !== undefined) fs.closeSync(duplicate);
    closeChain(chain);
    if (error instanceof DeploymentError) throw error;
    modeRequired();
  }
}

function validUid(value) {
  return Number.isInteger(value) && value > 0 && value < 2 ** 32 - 1;
}

function validateRootExecutable(name) {
  const executable = absoluteName(name);
  const chain = openDirectoryChain(path.dirname(executable), 0, {rootOnly: true});
  let fd;
  try {
    fd = fs.openSync(`/proc/self/fd/${chain.fd}/${path.basename(executable)}`,
      C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const info = fs.fstatSync(fd, {bigint: true});
    if (!info.isFile() || info.uid !== 0n || (Number(info.mode) & 0o7022) !== 0
        || (Number(info.mode) & 0o001) === 0
        || !sameFile(info, fs.lstatSync(executable, {bigint: true}))) modeRequired();
    verifyChain(chain, 'DEPLOY_MANAGED_MODE_REQUIRED');
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    modeRequired();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    closeChain(chain);
  }
}

function validateProfileValue(value) {
  if (value.version !== 1 || !validUid(value.serviceUid) || !validUid(value.clientUid)
      || value.serviceUid === value.clientUid) modeRequired();
  const repositoryRoot = absoluteName(value.repositoryRoot);
  const home = absoluteName(value.serviceHome);
  const socket = absoluteName(value.socket);
  const node = absoluteName(value.node);
  const runtime = path.join(repositoryRoot, '.jhw-runtime');
  if (Buffer.byteLength(socket) >= 108 || socket === runtime || socket.startsWith(`${runtime}/`)) modeRequired();
  validateRootExecutable(node);
  return {serviceUid: value.serviceUid, clientUid: value.clientUid, repositoryRoot, home, socket};
}

function closeState(state) {
  if (state.closed) return;
  state.closed = true;
  for (const chain of state.chains.reverse()) closeChain(chain);
  closeChain(state.profileChain);
  try { fs.closeSync(state.profileFd); } catch { /* already invalidated */ }
}

function verifyState(state) {
  if (state.closed) modeRequired();
  try {
    for (const chain of state.chains) verifyChain(chain, 'DEPLOY_MANAGED_RECOVERY_REQUIRED');
    if (!sameFile(state.profileStat, fs.fstatSync(state.profileFd, {bigint: true}))
        || !sameFile(state.profileStat, fs.lstatSync(state.profilePath, {bigint: true}))) recoveryRequired();
    verifyChain(state.profileChain, 'DEPLOY_MANAGED_RECOVERY_REQUIRED');
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    recoveryRequired();
  }
}

function requireState(scope) {
  const state = issuedScopes.get(scope);
  if (!state || state.closed) modeRequired();
  return state;
}

function markerStat(state, name) {
  const anchored = `/proc/self/fd/${state.store.fd}/${name}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const info = fs.lstatSync(anchored, {bigint: true});
      if (!info.isFile() || info.uid !== BigInt(state.serviceUid) || info.nlink !== 1n
          || (Number(info.mode) & 0o7777) !== 0o600) recoveryRequired();
      return;
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      if (error?.code !== 'ENOENT') recoveryRequired();
    }
  }
}

function markerNames(state) {
  const result = [];
  const seen = new Set();
  let scanned = 0;
  let stream;
  try {
    stream = fs.opendirSync(`/proc/self/fd/${state.store.fd}`);
    let entry;
    while ((entry = stream.readSync()) !== null) {
      if (++scanned > MAX_MARKERS) recoveryRequired();
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      result.push(entry.name);
    }
    return result;
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    recoveryRequired();
  } finally {
    stream?.closeSync();
  }
}

function scanMarkers(state, bootstrapId = null) {
  verifyState(state);
  let any = false;
  let generation = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const name of markerNames(state)) {
      const match = MARKER.exec(name);
      if (!match) recoveryRequired();
      any = true;
      if (match[1] === bootstrapId) generation = true;
      markerStat(state, name);
    }
  }
  verifyState(state);
  return {any, generation};
}

export function openManagedScope({profileFd} = {}) {
  let profile;
  let state;
  const chains = [];
  try {
    profile = readProfile(profileFd);
    const parsed = validateProfileValue(profile.value);
    if (process.getuid() !== parsed.serviceUid || process.geteuid() !== parsed.serviceUid
        || parsed.serviceUid === 0 || parsed.serviceUid === parsed.clientUid) modeRequired();
    const repository = openDirectoryChain(parsed.repositoryRoot, parsed.serviceUid);
    chains.push(repository);
    const home = openDirectoryChain(parsed.home, parsed.serviceUid);
    chains.push(home);
    const socketParent = openDirectoryChain(path.dirname(parsed.socket), parsed.serviceUid);
    chains.push(socketParent);
    for (const child of ['.jhw-runtime', 'v2', 'managed-invocations']) {
      appendPrivateChild(repository, child, parsed.serviceUid);
    }
    state = {
      ...parsed,
      profileFd: profile.profileFd,
      profilePath: profile.profilePath,
      profileStat: profile.profileStat,
      profileChain: profile.profileChain,
      chains,
      store: repository,
      closed: false,
    };
    profile = null;
    let scope;
    scope = Object.freeze(Object.defineProperties({}, {
      repositoryRoot: {value: state.repositoryRoot, enumerable: true},
      home: {value: state.home, enumerable: true},
      verify: {value() { verifyState(requireState(this)); }},
      hasInvocationRecords: {value() { return scanMarkers(requireState(this)).any; }},
      hasGenerationIntent: {value(bootstrapId) {
        if (typeof bootstrapId !== 'string' || !BOOTSTRAP.test(bootstrapId)) modeRequired();
        return scanMarkers(requireState(this), bootstrapId).generation;
      }},
      close: {value() {
        const owned = issuedScopes.get(this);
        if (!owned) modeRequired();
        closeState(owned);
      }},
    }));
    issuedScopes.set(scope, state);
    verifyState(state);
    return scope;
  } catch (error) {
    if (state) closeState(state);
    else for (const chain of chains.reverse()) closeChain(chain);
    if (!state && profile) {
      try { fs.closeSync(profile.profileFd); } catch {}
      closeChain(profile.profileChain);
    }
    if (error instanceof DeploymentError) throw error;
    modeRequired();
  }
}

export function requireManagedScope(scope, repositoryRoot) {
  const state = requireState(scope);
  if (typeof repositoryRoot !== 'string' || repositoryRoot !== state.repositoryRoot) modeRequired();
  verifyState(state);
  return scope;
}
