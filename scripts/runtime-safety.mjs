import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const C = fs.constants;
const MAX_ENTRIES = 32768;
const MAX_ARGV_BYTES = 131072;
const RECORD_BYTES = 65536;

/** Only stable, bounded identifiers cross the deployment error boundary. */
export class DeploymentError extends Error {
  constructor(code, reason) {
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'DEPLOY_FAILED';
    super(safeCode);
    this.name = 'DeploymentError';
    this.code = safeCode;
    if (typeof reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(reason)) this.reason = reason;
  }
}

function untrusted() { throw new DeploymentError('DEPLOY_UNTRUSTED_PATH'); }
function sameObject(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && (a.isDirectory() && b.isDirectory() || a.nlink === b.nlink);
}
function absoluteName(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.split('/').includes('..')) untrusted();
  return path.resolve(value);
}
function directoryMode(stat, uid, leaf) {
  if (!stat.isDirectory() || (stat.uid !== uid && (leaf || stat.uid !== 0))) untrusted();
  // A sticky root/current-user ancestor (not the target) permits private /tmp roots.
  if ((stat.mode & 0o022) && (leaf || !(stat.mode & 0o1000))) untrusted();
}
function fileMode(stat, uid, executable = false) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o7022) || (executable && !(stat.mode & 0o100))) untrusted();
}

/**
 * Node has no openat binding. Linux /proc/self/fd anchors every component open
 * to a retained, verified directory descriptor; O_NOFOLLOW protects the next
 * component. Retaining ancestors also prevents pathname substitution during use.
 */
function directoryChain(directory, uid, leafOwned = true) {
  const target = absoluteName(directory);
  const records = [];
  try {
    const parts = target.split('/').filter(Boolean);
    const rootFd = fs.openSync('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    records.push({ fd: rootFd, name: '/', stat: fs.fstatSync(rootFd) });
    directoryMode(records[0].stat, uid, parts.length === 0 && leafOwned);
    let name = '/';
    for (let index = 0; index < parts.length; index++) {
      name = path.join(name, parts[index]);
      const fd = fs.openSync(`/proc/self/fd/${records.at(-1).fd}/${parts[index]}`, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      const record = { fd, name, stat: fs.fstatSync(fd) };
      records.push(record);
      directoryMode(record.stat, uid, index === parts.length - 1 && leafOwned);
    }
    return {
      fd: records.at(-1).fd,
      stat: records.at(-1).stat,
      verify() {
        for (const record of records) {
          if (!sameObject(record.stat, fs.fstatSync(record.fd)) || !sameObject(record.stat, fs.lstatSync(record.name))) untrusted();
        }
      },
      close() { for (const record of records.reverse()) fs.closeSync(record.fd); },
    };
  } catch {
    for (const record of records.reverse()) fs.closeSync(record.fd);
    untrusted();
  }
}

export function trustedDirectory(directory, { uid = process.getuid() } = {}) {
  let chain;
  try {
    chain = directoryChain(directory, uid);
    chain.verify();
    return chain.stat;
  } catch { untrusted(); }
  finally { chain?.close(); }
}

export function trustedFile(file, { uid = process.getuid(), executable = false } = {}) {
  let chain; let fd;
  try {
    const name = absoluteName(file);
    chain = directoryChain(path.dirname(name), uid, false);
    fd = fs.openSync(`/proc/self/fd/${chain.fd}/${path.basename(name)}`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    fileMode(stat, uid, executable);
    chain.verify();
    if (!sameObject(stat, fs.lstatSync(name))) untrusted();
    return stat;
  } catch { untrusted(); }
  finally { if (fd !== undefined) fs.closeSync(fd); chain?.close(); }
}

export function acquireLease(file, { shared = false, create = false } = {}) {
  let chain; let fd;
  try {
    const name = absoluteName(file);
    chain = directoryChain(path.dirname(name), process.getuid());
    const anchored = `/proc/self/fd/${chain.fd}/${path.basename(name)}`;
    const flags = C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK;
    if (create) {
      try {
        fd = fs.openSync(anchored, flags | C.O_CREAT | C.O_EXCL, 0o600);
        fs.fchmodSync(fd, 0o600);
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (fd === undefined) fd = fs.openSync(anchored, flags);
    const stat = fs.fstatSync(fd);
    fileMode(stat, process.getuid());
    if ((stat.mode & 0o7777) !== 0o600) untrusted();
    chain.verify();
    if (!sameObject(stat, fs.lstatSync(name))) untrusted();
    trustedFile('/usr/bin/flock', { uid: 0, executable: true });
    // flock operates on fd 3, duplicated from this fd: both refer to the same
    // open-file description. The helper exiting does not release our lease.
    const result = spawnSync('/usr/bin/flock', [shared ? '--shared' : '--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    if (result.status === 75) throw new DeploymentError('DEPLOY_LOCK_CONTENDED');
    if (result.error || result.signal || result.status !== 0) throw new DeploymentError('DEPLOY_LOCK_FAILED');
    chain.verify();
    if (!sameObject(stat, fs.fstatSync(fd)) || !sameObject(stat, fs.lstatSync(name))) untrusted();
    const heldFd = fd;
    fd = undefined;
    let closed = false;
    return {
      fd: heldFd,
      close() {
        // Do not LOCK_UN: an inherited descriptor must retain the lease even
        // when this caller closes its descriptor or exits.
        if (!closed) { closed = true; fs.closeSync(heldFd); }
      },
    };
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError('DEPLOY_UNTRUSTED_PATH');
  } finally { if (fd !== undefined) fs.closeSync(fd); chain?.close(); }
}

function uncertain() { throw new DeploymentError('DEPLOY_INVENTORY_UNCERTAIN'); }
function stableRecord(a, b) {
  return sameObject(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function readRecord(directoryFd, name, limit, uid) {
  let fd;
  try {
    fd = fs.openSync(`/proc/self/fd/${directoryFd}/${name}`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.uid !== uid || !(before.mode & 0o400)) uncertain();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const size = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (size === 0) break;
      length += size;
    }
    if (length > limit || !stableRecord(before, fs.fstatSync(fd)) || !stableRecord(before, fs.lstatSync(`/proc/self/fd/${directoryFd}/${name}`))) uncertain();
    return bytes.subarray(0, length);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readUids(bytes) {
  const lines = bytes.toString('utf8').split('\n').filter(line => line.startsWith('Uid:'));
  if (lines.length !== 1) uncertain();
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(lines[0]);
  if (!match) uncertain();
  const ids = match.slice(1).map(Number);
  if (ids.some(id => !Number.isSafeInteger(id))) uncertain();
  return ids;
}
function parseStat(bytes, pid) {
  const match = /^(\d+) \((.*)\) ([A-Za-z]) (.*)\n?$/s.exec(bytes.toString('utf8'));
  if (!match || match[1] !== pid) uncertain();
  const fields = match[4].trim().split(/\s+/);
  if (fields.length < 19 || fields.some(field => !/^-?\d+$/.test(field)) || !/^\d+$/.test(fields[18])) uncertain();
  return { comm: match[2], state: match[3], flags: BigInt(fields[5]), start: fields[18] };
}
function parseArgv(bytes) {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) uncertain();
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const argv = value.slice(0, -1).split('\0');
  if (!argv[0]) uncertain();
  return argv;
}

const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'bash', 'sh', 'dash', 'zsh', 'python', 'python3']);
const NODE_VALUE_FLAGS = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader', '--conditions', '-C', '--title', '--icu-data-dir', '--openssl-config', '--env-file', '--env-file-if-exists', '--input-type', '--diagnostic-dir', '--redirect-warnings', '--inspect-port']);
const NODE_BOOLEAN_FLAGS = new Set(['--no-warnings', '--trace-warnings', '--enable-source-maps', '--no-deprecation', '--trace-deprecation', '--experimental-strip-types', '--experimental-transform-types', '--experimental-default-type=module', '--inspect', '--inspect-brk', '--expose-gc']);
function entryIdentity(argv) {
  const binary = path.basename(argv[0]);
  if (!INTERPRETERS.has(binary)) return { entry: argv[0], args: argv.slice(1) };
  const shell = ['bash', 'sh', 'dash', 'zsh'].includes(binary);
  let index = 1;
  while (index < argv.length && (argv[index].startsWith('-') || (shell && argv[index].startsWith('+')))) {
    const flag = argv[index];
    if (flag === '--') { index++; break; }
    if (shell) {
      if (flag === '-' || /^-[a-zA-Z]*c/.test(flag)) return null;
      if (/^[-+][a-zA-Z]*[oO]$/.test(flag)) {
        if (index + 1 >= argv.length) uncertain();
        index += 2; continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(flag) && !/[coO]/.test(flag)) { index++; continue; }
      // Shell options never fall through to Node's consuming-option table:
      // shell -C/-r take no argument; Node -C/-r take an argument.
      uncertain();
    } else if (binary === 'node' || binary === 'nodejs') {
      if (['-e', '--eval', '-p', '--print', '-'].includes(flag) || /^-[ep].+/.test(flag) || /^--(?:eval|print)=/.test(flag)) return null;
      if (NODE_VALUE_FLAGS.has(flag)) { if (index + 1 >= argv.length) uncertain(); index += 2; continue; }
      if (NODE_BOOLEAN_FLAGS.has(flag) || /^--[a-z][a-z0-9-]*=/.test(flag)) { index++; continue; }
    } else if (binary === 'python' || binary === 'python3') {
      if (flag === '-' || /^-[cm]/.test(flag)) return null;
    } else if (binary === 'bun') {
      if (['-e', '--eval', '-p', '--print', '-'].includes(flag) || /^-[ep].+/.test(flag) || /^--(?:eval|print)=/.test(flag)) return null;
    }
    // Unknown interpreter options can consume the would-be script. Do not guess.
    uncertain();
  }
  return index < argv.length ? { entry: argv[index], args: argv.slice(index + 1) } : null;
}

function tuiName(entry) {
  const base = path.basename(entry);
  if (['claude', 'codex', 'gemini', 'opencode'].includes(base)) return base;
  const identities = [
    ['claude', /\/node_modules\/@anthropic-ai\/claude-code\/cli\.js$/],
    ['codex', /\/node_modules\/@openai\/codex\/bin\/codex\.js$/],
    ['gemini', /\/node_modules\/@google\/gemini-cli\/dist\/(?:src\/)?index\.js$/],
    ['opencode', /\/node_modules\/opencode-ai\/bin\/opencode$/],
  ];
  return identities.find(([, pattern]) => pattern.test(entry))?.[0];
}
const RUNTIME_ENTRIES = new Set(['mcp-server/dist/index.js', 'mcp-server/dist/control/cli.js', 'mcp-server/dist/control/hook-adapter.js', 'scripts/jhw-control-hook']);
function classify(identity, repositoryRoot, readCwd) {
  if (!identity) return null;
  const name = tuiName(identity.entry);
  if (name) return name === 'codex' && identity.args[0] === 'app-server' ? 'app_server' : 'tui';
  // Relative script paths are meaningful only with a stable, required cwd link.
  const entry = path.isAbsolute(identity.entry) ? path.normalize(identity.entry) : path.resolve(readCwd(), identity.entry);
  const relative = path.relative(repositoryRoot, entry);
  if (RUNTIME_ENTRIES.has(relative)) return 'legacy';
  if (['.jhw-runtime/bootstrap/jhw-runtime-entry', '.jhw-runtime/bootstrap/jhw-runtime-control', '.jhw-runtime/bootstrap/jhw-runtime-hook', '.jhw-runtime/bootstrap/runtime-entry.mjs', 'scripts/runtime-entry.mjs'].includes(relative)) return 'managed';
  const match = /^\.jhw-runtime\/(?:current\/|(?:releases\/r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}|activations\/a-[a-f0-9]{32})\/)(.+)$/.exec(relative);
  if (match && RUNTIME_ENTRIES.has(match[1])) return 'managed';
  // Installed links can retain their launcher spelling in argv. These closed
  // executable/script basenames are consumer identities, never argument scans.
  const launcher = path.basename(identity.entry);
  if (['jhw-control', 'jhw-control-hook'].includes(launcher)) return 'legacy';
  return ['jhw-runtime-entry', 'jhw-runtime-control', 'jhw-runtime-hook'].includes(launcher) ? 'managed' : null;
}

function processObservation(procFd, pid, options) {
  let fd;
  try {
    const anchored = `/proc/self/fd/${procFd}/${pid}`;
    fd = fs.openSync(anchored, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isDirectory()) uncertain();
    // Other users' records are deliberately not read (ptrace restrictions).
    if (before.uid !== options.uid) {
      if (!sameObject(before, fs.lstatSync(anchored))) uncertain();
      return null;
    }
    const firstUids = readUids(readRecord(fd, 'status', RECORD_BYTES, options.uid));
    if (firstUids.some(id => id !== options.uid)) uncertain();
    const firstStat = parseStat(readRecord(fd, 'stat', RECORD_BYTES, options.uid), pid);
    const firstArgv = readRecord(fd, 'cmdline', options.maxArgvBytes, options.uid);
    const argv = parseArgv(firstArgv);
    let cwd;
    const readCwd = () => {
      cwd = fs.readlinkSync(`/proc/self/fd/${fd}/cwd`);
      if (!path.isAbsolute(cwd) || cwd.endsWith(' (deleted)') || cwd.length > 4096) uncertain();
      return cwd;
    };
    // Zombies and PF_KTHREAD tasks cannot start a consumer; all other empty
    // cmdlines are uncertain, including an exec transition through empty argv.
    if (!argv.length && firstStat.state !== 'Z' && !(firstStat.flags & 0x00200000n)) uncertain();
    const consumer = argv.length ? classify(entryIdentity(argv), options.repositoryRoot, readCwd) : null;
    const lastArgv = readRecord(fd, 'cmdline', options.maxArgvBytes, options.uid);
    const lastStat = parseStat(readRecord(fd, 'stat', RECORD_BYTES, options.uid), pid);
    const lastUids = readUids(readRecord(fd, 'status', RECORD_BYTES, options.uid));
    if (!firstArgv.equals(lastArgv) || firstStat.start !== lastStat.start || firstStat.comm !== lastStat.comm ||
        firstUids.some((id, index) => id !== lastUids[index]) ||
        (!argv.length && (firstStat.state !== lastStat.state || firstStat.flags !== lastStat.flags)) ||
        (cwd !== undefined && cwd !== fs.readlinkSync(`/proc/self/fd/${fd}/cwd`)) ||
        !sameObject(before, fs.fstatSync(fd)) || !sameObject(before, fs.lstatSync(anchored))) uncertain();
    return consumer;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function processNames(procFd, maxEntries) {
  const directory = fs.opendirSync(`/proc/self/fd/${procFd}`);
  const names = [];
  try {
    let entry; let seen = 0;
    while ((entry = directory.readSync()) !== null) {
      if (++seen > maxEntries) uncertain();
      if (/^[1-9]\d*$/.test(entry.name)) names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names.sort();
}

export function inspectConsumers({ repositoryRoot, procRoot = '/proc', uid = process.getuid(), excludePids = [], maxEntries = MAX_ENTRIES, maxArgvBytes = MAX_ARGV_BYTES } = {}) {
  const result = { clear: false, counts: { tui: 0, app_server: 0, legacy: 0, managed: 0 }, uncertain: 0 };
  let fd;
  try {
    if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES ||
        !Number.isInteger(maxArgvBytes) || maxArgvBytes < 1 || maxArgvBytes > MAX_ARGV_BYTES ||
        !Array.isArray(excludePids) || excludePids.length > MAX_ENTRIES || excludePids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) uncertain();
    const repository = absoluteName(repositoryRoot);
    const proc = absoluteName(procRoot);
    fd = fs.openSync(proc, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    const names = processNames(fd, maxEntries);
    const excluded = new Set(excludePids.map(String));
    for (const pid of names) {
      if (excluded.has(pid)) continue;
      try {
        const consumer = processObservation(fd, pid, { repositoryRoot: repository, uid, maxArgvBytes });
        if (consumer) result.counts[consumer]++;
      } catch { result.uncertain++; }
    }
    const afterNames = processNames(fd, maxEntries);
    if (names.length !== afterNames.length || names.some((name, index) => name !== afterNames[index]) || !sameObject(before, fs.lstatSync(proc))) result.uncertain++;
    result.clear = result.uncertain === 0 && Object.values(result.counts).every(count => count === 0);
  } catch { result.uncertain++; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return result;
}

export function requireQuiescence(options) {
  const result = inspectConsumers(options);
  if (result.uncertain) throw new DeploymentError('DEPLOY_INVENTORY_UNCERTAIN');
  if (!result.clear) throw new DeploymentError('DEPLOY_CONSUMERS_ACTIVE');
  return result;
}
