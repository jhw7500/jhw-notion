import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const C = fs.constants;
const MAX_ENTRIES = 32768;
const MAX_ARGV_BYTES = 131072;
const RECORD_BYTES = 65536;
const issuedLeases = new WeakMap();
const issuedAtomicCapabilities = new WeakMap();
const PYTHON = '/usr/bin/python3';
const ATOMIC_HELPER_TIMEOUT_MS = 5000;
const ATOMIC_HELPER_OUTPUT_BYTES = 4096;
const ATOMIC_HELPER = String.raw`import ctypes, errno, os, sys
try:
    operation = {'noreplace': 1, 'exchange': 2}[sys.argv[1]]
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(3, os.fsencode(sys.argv[2]), 4, os.fsencode(sys.argv[3]), operation)
    if result == 0:
        os.write(1, b'{"ok":true}\n')
    else:
        value = ctypes.get_errno()
        os.write(1, ('{"ok":false,"errno":%d}\n' % value).encode('ascii'))
except (AttributeError, KeyError):
    os.write(1, ('{"ok":false,"errno":%d}\n' % errno.ENOSYS).encode('ascii'))
except BaseException:
    os.write(1, b'{"ok":false,"helper":"exception"}\n')
`;

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
    const state = { fd: heldFd, file: name, shared, stat, closed: false };
    const lease = {
      fd: heldFd,
      close() {
        // Do not LOCK_UN: an inherited descriptor must retain the lease even
        // when this caller closes its descriptor or exits.
        if (!closed) { closed = true; state.closed = true; fs.closeSync(heldFd); }
      },
    };
    issuedLeases.set(lease, state);
    return lease;
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError('DEPLOY_UNTRUSTED_PATH');
  } finally { if (fd !== undefined) fs.closeSync(fd); chain?.close(); }
}

/** Process-local proof that acquireLease issued this exact live handle for the
 * named lock and acquired the required mode. The public Lease shape stays
 * {fd,close}; capability state is neither enumerable nor caller-forgeable. */
export function validLeaseCapability(lease, file, { exclusive = false } = {}) {
  let chain;
  try {
    const state = issuedLeases.get(lease);
    const name = absoluteName(file);
    if (!state || state.closed || state.file !== name || state.fd !== lease?.fd ||
        exclusive && state.shared) return false;
    chain = directoryChain(path.dirname(name), process.getuid());
    const held = fs.fstatSync(state.fd);
    const named = fs.lstatSync(`/proc/self/fd/${chain.fd}/${path.basename(name)}`);
    chain.verify();
    return sameObject(state.stat, held) && sameObject(state.stat, named) &&
      held.isFile() && held.uid === process.getuid() && held.nlink === 1 &&
      (held.mode & 0o7777) === 0o600;
  } catch { return false; }
  finally { chain?.close(); }
}

function atomicInvalid(reason) {
  throw new DeploymentError('DEPLOY_ATOMIC_RENAME_INVALID', reason);
}

function atomicIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode };
}

function sameAtomicIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.gid === right.gid && left.mode === right.mode;
}

function verifyAtomicDirectory(directory, expected, reason = 'directory') {
  try {
    if (!directory || !Number.isSafeInteger(directory.fd) || directory.fd < 0 || typeof directory.verify !== 'function') atomicInvalid(reason);
    const before = fs.fstatSync(directory.fd);
    if (!before.isDirectory() || before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o700) atomicInvalid(reason);
    directory.verify();
    const after = fs.fstatSync(directory.fd);
    const identity = atomicIdentity(after);
    if (!sameAtomicIdentity(atomicIdentity(before), identity) || expected && !sameAtomicIdentity(expected, identity)) atomicInvalid(reason);
    return identity;
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    atomicInvalid(reason);
  }
}

function atomicName(value) {
  if (typeof value !== 'string' || value === '.' || value === '..' ||
      !/^[A-Za-z0-9._-]+$/.test(value) || Buffer.byteLength(value) > 255) atomicInvalid('name');
  return value;
}

function pythonProof() {
  let chain;
  try {
    chain = directoryChain(path.dirname(PYTHON), 0, false);
    const alias = fs.lstatSync(`/proc/self/fd/${chain.fd}/${path.basename(PYTHON)}`);
    if (alias.uid !== 0 || !alias.isFile() && !alias.isSymbolicLink() ||
        alias.isFile() && (alias.mode & 0o7022)) throw new Error();
    chain.verify();
    if (!sameObject(alias, fs.lstatSync(PYTHON))) throw new Error();
    const resolved = fs.realpathSync(PYTHON);
    if (!path.isAbsolute(resolved)) throw new Error();
    const target = trustedFile(resolved, { uid: 0, executable: true });
    return { alias: atomicIdentity(alias), resolved, target: atomicIdentity(target) };
  } catch {
    throw new DeploymentError('DEPLOY_ATOMIC_RENAME_HELPER_FAILED', 'spawn');
  } finally { chain?.close(); }
}

function samePythonProof(left, right) {
  return left.resolved === right.resolved && sameAtomicIdentity(left.alias, right.alias) &&
    sameAtomicIdentity(left.target, right.target);
}

function runAtomicHelper({ sourceDirectory, destinationDirectory, sourceName, destinationName, operation }) {
  const proof = pythonProof();
  const result = spawnSync(PYTHON, ['-I', '-S', '-c', ATOMIC_HELPER, operation, sourceName, destinationName], {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe', sourceDirectory.fd, destinationDirectory.fd],
    timeout: ATOMIC_HELPER_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: ATOMIC_HELPER_OUTPUT_BYTES,
  });
  const finalProof = pythonProof();
  if (!samePythonProof(proof, finalProof)) throw new DeploymentError('DEPLOY_ATOMIC_RENAME_HELPER_FAILED', 'spawn');
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? 'timeout' : result.error.code === 'ENOBUFS' ? 'output' : 'spawn';
    throw new DeploymentError('DEPLOY_ATOMIC_RENAME_HELPER_FAILED', reason);
  }
  if (result.signal || result.status !== 0) throw new DeploymentError('DEPLOY_ATOMIC_RENAME_HELPER_FAILED', 'exit');
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 256 || result.stderr !== '') {
    throw new DeploymentError('DEPLOY_ATOMIC_RENAME_HELPER_FAILED', 'output');
  }
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw new DeploymentError('DEPLOY_ATOMIC_RENAME_HELPER_FAILED', 'protocol'); }
  if (response && response.ok === true && Object.keys(response).length === 1) return;
  if (response && response.ok === false && response.helper === 'exception' && Object.keys(response).length === 2) {
    throw new DeploymentError('DEPLOY_ATOMIC_RENAME_HELPER_FAILED', 'helper');
  }
  if (!response || response.ok !== false || !Number.isInteger(response.errno) || response.errno < 1 || response.errno > 4095 ||
      Object.keys(response).length !== 2) throw new DeploymentError('DEPLOY_ATOMIC_RENAME_HELPER_FAILED', 'protocol');
  if ([38, 22, 95].includes(response.errno)) throw new DeploymentError('DEPLOY_ATOMIC_RENAME_UNSUPPORTED', operation);
  if (operation === 'noreplace' && response.errno === 17) {
    throw new DeploymentError('DEPLOY_ATOMIC_DESTINATION_EXISTS', 'destination_exists');
  }
  throw new DeploymentError('DEPLOY_ATOMIC_RENAME_FAILED', `errno_${response.errno}`);
}

function probeAtomicRename(directory) {
  const nonce = randomBytes(16).toString('hex');
  const sourceName = `.jhw-atomic-source-${nonce}`;
  const destinationName = `.jhw-atomic-destination-${nonce}`;
  const sourcePath = `/proc/self/fd/${directory.fd}/${sourceName}`;
  const destinationPath = `/proc/self/fd/${directory.fd}/${destinationName}`;
  fs.mkdirSync(sourcePath, 0o700);
  fs.mkdirSync(destinationPath, 0o700);
  fs.fsyncSync(directory.fd);
  const source = atomicIdentity(fs.lstatSync(sourcePath));
  const destination = atomicIdentity(fs.lstatSync(destinationPath));
  assertProbeError(() => runAtomicHelper({ sourceDirectory: directory, destinationDirectory: directory, sourceName, destinationName, operation: 'noreplace' }));
  if (!sameAtomicIdentity(source, atomicIdentity(fs.lstatSync(sourcePath))) ||
      !sameAtomicIdentity(destination, atomicIdentity(fs.lstatSync(destinationPath)))) atomicInvalid('directory');
  runAtomicHelper({ sourceDirectory: directory, destinationDirectory: directory, sourceName, destinationName, operation: 'exchange' });
  fs.fsyncSync(directory.fd);
  if (!sameAtomicIdentity(destination, atomicIdentity(fs.lstatSync(sourcePath))) ||
      !sameAtomicIdentity(source, atomicIdentity(fs.lstatSync(destinationPath)))) atomicInvalid('directory');
}

function assertProbeError(operation) {
  try { operation(); }
  catch (error) {
    if (error instanceof DeploymentError && error.code === 'DEPLOY_ATOMIC_DESTINATION_EXISTS') return;
    throw error;
  }
  throw new DeploymentError('DEPLOY_ATOMIC_RENAME_UNSUPPORTED', 'noreplace');
}

/** Probe both required renameat2 operations before any caller live-name mutation. */
export function prepareAtomicRename({ directory } = {}) {
  const identity = verifyAtomicDirectory(directory);
  probeAtomicRename(directory);
  const finalIdentity = verifyAtomicDirectory(directory, identity);
  const capability = Object.freeze({});
  issuedAtomicCapabilities.set(capability, { directory, identity: finalIdentity });
  return capability;
}

/** Execute only the two probed Linux renameat2 operations through retained parents. */
export function atomicRename({ capability, sourceDirectory, destinationDirectory, sourceName, destinationName, operation } = {}) {
  const state = issuedAtomicCapabilities.get(capability);
  if (!state) atomicInvalid('capability');
  verifyAtomicDirectory(state.directory, state.identity, 'capability');
  if (operation !== 'noreplace' && operation !== 'exchange') atomicInvalid('operation');
  const source = atomicName(sourceName);
  const destination = atomicName(destinationName);
  const sourceIdentity = verifyAtomicDirectory(sourceDirectory);
  const destinationIdentity = verifyAtomicDirectory(destinationDirectory);
  if (sourceIdentity.dev !== state.identity.dev || destinationIdentity.dev !== state.identity.dev) atomicInvalid('directory');
  try {
    runAtomicHelper({ sourceDirectory, destinationDirectory, sourceName: source, destinationName: destination, operation });
  } catch (error) {
    fs.fsyncSync(sourceDirectory.fd);
    if (destinationDirectory.fd !== sourceDirectory.fd) fs.fsyncSync(destinationDirectory.fd);
    verifyAtomicDirectory(sourceDirectory, sourceIdentity);
    verifyAtomicDirectory(destinationDirectory, destinationIdentity);
    verifyAtomicDirectory(state.directory, state.identity, 'capability');
    throw error;
  }
  fs.fsyncSync(sourceDirectory.fd);
  if (destinationDirectory.fd !== sourceDirectory.fd) fs.fsyncSync(destinationDirectory.fd);
  verifyAtomicDirectory(sourceDirectory, sourceIdentity);
  verifyAtomicDirectory(destinationDirectory, destinationIdentity);
  verifyAtomicDirectory(state.directory, state.identity, 'capability');
}

const INVENTORY_CAUSES = Object.freeze([
  'pid_set_changed',
  'process_vanished',
  'identity_changed',
  'record_unreadable',
  'classification_unknown',
  'root_mismatch',
]);
const INVENTORY_STAGES = new Set(['preliminary', 'post_probe', 'publication']);
function causeCounts() {
  return Object.fromEntries(INVENTORY_CAUSES.map(cause => [cause, 0]));
}
function uncertain(cause = 'record_unreadable') {
  const error = new DeploymentError('DEPLOY_INVENTORY_UNCERTAIN');
  Object.defineProperty(error, 'inventoryCause', {value: cause});
  throw error;
}
function stableRecord(a, b) {
  return sameObject(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function readRecord(directoryFd, name, limit, uid) {
  let fd;
  try {
    fd = fs.openSync(`/proc/self/fd/${directoryFd}/${name}`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    // Non-dumpable tasks keep a current-user /proc/<pid> directory, but the
    // kernel assigns their records to root; any other record owner is foreign.
    if (!before.isFile() || (before.uid !== uid && before.uid !== 0) || !(before.mode & 0o400)) uncertain();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const size = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (size === 0) break;
      length += size;
    }
    if (length > limit || !stableRecord(before, fs.fstatSync(fd)) || !stableRecord(before, fs.lstatSync(`/proc/self/fd/${directoryFd}/${name}`))) {
      uncertain('identity_changed');
    }
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
const NODE_BOOLEAN_FLAGS = new Set(['--watch', '--watch-preserve-output', '--node-snapshot', '--no-node-snapshot', '--no-warnings', '--trace-warnings', '--enable-source-maps', '--no-deprecation', '--trace-deprecation', '--experimental-strip-types', '--experimental-transform-types', '--experimental-default-type=module', '--inspect', '--inspect-brk', '--expose-gc']);
const PYTHON_BOOLEAN_FLAGS = new Set(['-B', '-I']);
const BUN_BOOLEAN_FLAGS = new Set(['--no-install']);
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
        if (index + 1 >= argv.length) uncertain('classification_unknown');
        index += 2; continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(flag) && !/[coO]/.test(flag)) { index++; continue; }
      // Shell options never fall through to Node's consuming-option table:
      // shell -C/-r take no argument; Node -C/-r take an argument.
      uncertain('classification_unknown');
    } else if (binary === 'node' || binary === 'nodejs') {
      if (['-e', '--eval', '-p', '--print', '-'].includes(flag) || /^-[ep].+/.test(flag) || /^--(?:eval|print)=/.test(flag)) return null;
      if (NODE_VALUE_FLAGS.has(flag)) { if (index + 1 >= argv.length) uncertain('classification_unknown'); index += 2; continue; }
      if (NODE_BOOLEAN_FLAGS.has(flag) || /^--[a-z][a-z0-9-]*=/.test(flag)) { index++; continue; }
    } else if (binary === 'python' || binary === 'python3') {
      if (flag === '-' || /^-[cm]/.test(flag)) return null;
      if (PYTHON_BOOLEAN_FLAGS.has(flag)) { index++; continue; }
    } else if (binary === 'bun') {
      if (['-e', '--eval', '-p', '--print', '-'].includes(flag) || /^-[ep].+/.test(flag) || /^--(?:eval|print)=/.test(flag)) return null;
      if (BUN_BOOLEAN_FLAGS.has(flag)) { index++; continue; }
    }
    // Unknown interpreter options can consume the would-be script. Do not guess.
    uncertain('classification_unknown');
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
const BOOTSTRAP_ENTRIES = new Set(['.jhw-runtime/bootstrap/jhw-runtime-entry', '.jhw-runtime/bootstrap/jhw-runtime-control', '.jhw-runtime/bootstrap/jhw-runtime-hook', '.jhw-runtime/bootstrap/runtime-entry.mjs', 'scripts/runtime-entry.mjs']);
const RUNTIME_BASENAMES = new Set([...RUNTIME_ENTRIES, ...BOOTSTRAP_ENTRIES].map(entry => path.basename(entry)));
// Resolution against any cwd keeps a normalized relative entry's basename unless
// it normalizes to '.' or ends in '..'. Other basenames cannot name a runtime file.
function needsCwd(entry) {
  const normalized = path.normalize(entry);
  return normalized === '.' || path.basename(normalized) === '..' || RUNTIME_BASENAMES.has(path.basename(normalized));
}
// Codex global options that may precede a subcommand (codex-cli 0.161.0). An
// option whose arity is not listed here, such as the multi-value --image, is
// not guessed: `codex -m app-server` is a TUI whose model is "app-server".
const CODEX_VALUE_FLAGS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
// --not-so-yolo and --yolo are hidden aliases of the two approval options.
const CODEX_BOOLEAN_FLAGS = new Set(['--strict-config', '--oss', '--approve-for-me', '--not-so-yolo', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--dangerously-bypass-hook-trust', '--worktree', '--search', '--no-alt-screen', '--no-daemon']);
function codexCategory(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const flag = args[index];
    if (flag === '--') return 'tui';
    if (CODEX_BOOLEAN_FLAGS.has(flag)) { index++; continue; }
    if (CODEX_VALUE_FLAGS.has(flag)) { if (index + 1 >= args.length) uncertain('classification_unknown'); index += 2; continue; }
    if (flag.startsWith('--') && flag.includes('=') && CODEX_VALUE_FLAGS.has(flag.split('=')[0])) { index++; continue; }
    if (/^-[cmpsCa]./.test(flag)) { index++; continue; }
    uncertain('classification_unknown');
  }
  return args[index] === 'app-server' ? 'app_server' : 'tui';
}
function classify(identity, repositoryRoot, readCwd) {
  if (!identity) return null;
  const name = tuiName(identity.entry);
  if (name) return name === 'codex' ? codexCategory(identity.args) : 'tui';
  // Relative script paths are meaningful only with a stable, required cwd link.
  if (path.isAbsolute(identity.entry) || needsCwd(identity.entry)) {
    const entry = path.isAbsolute(identity.entry) ? path.normalize(identity.entry) : path.resolve(readCwd(), identity.entry);
    const relative = path.relative(repositoryRoot, entry);
    if (RUNTIME_ENTRIES.has(relative)) return 'legacy';
    if (BOOTSTRAP_ENTRIES.has(relative)) return 'managed';
    const match = /^\.jhw-runtime\/(?:current\/|(?:releases\/r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}|activations\/a-[a-f0-9]{32})\/)(.+)$/.exec(relative);
    if (match && RUNTIME_ENTRIES.has(match[1])) return 'managed';
  }
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
      if (!sameObject(before, fs.lstatSync(anchored))) uncertain('identity_changed');
      return null;
    }
    const firstUids = readUids(readRecord(fd, 'status', RECORD_BYTES, options.uid));
    if (firstUids.some(id => id !== options.uid)) uncertain('identity_changed');
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
    if (!argv.length && firstStat.state !== 'Z' && !(firstStat.flags & 0x00200000n)) uncertain('classification_unknown');
    const identity = argv.length ? entryIdentity(argv) : null;
    const consumer = argv.length ? classify(identity, options.repositoryRoot, readCwd) : null;
    let environment; let bound = false;
    if (consumer && options.verifySessionConsumer) {
      environment = readRecord(fd, 'environ', MAX_ARGV_BYTES, options.uid);
      if (environment.length && environment.at(-1) !== 0) uncertain();
      const variables = new TextDecoder('utf-8', {fatal:true}).decode(environment).split('\0');
      const matches = variables.filter(value => value.startsWith('JHW_RUNTIME_SESSION_BINDING='));
      if (matches.length > 1) uncertain('classification_unknown');
      const token = matches.length ? matches[0].slice('JHW_RUNTIME_SESSION_BINDING='.length) : undefined;
      bound = options.verifySessionConsumer({pid:Number(pid),startTime:firstStat.start,category:consumer,entry:identity?.entry,args:identity?.args??[],token}) === true;
    }
    const lastArgv = readRecord(fd, 'cmdline', options.maxArgvBytes, options.uid);
    const lastStat = parseStat(readRecord(fd, 'stat', RECORD_BYTES, options.uid), pid);
    const lastUids = readUids(readRecord(fd, 'status', RECORD_BYTES, options.uid));
    if (!firstArgv.equals(lastArgv) || firstStat.start !== lastStat.start || firstStat.comm !== lastStat.comm ||
        firstUids.some((id, index) => id !== lastUids[index]) ||
        (!argv.length && (firstStat.state !== lastStat.state || firstStat.flags !== lastStat.flags)) ||
        (cwd !== undefined && cwd !== fs.readlinkSync(`/proc/self/fd/${fd}/cwd`)) ||
        !sameObject(before, fs.fstatSync(fd)) || !sameObject(before, fs.lstatSync(anchored))) uncertain('identity_changed');
    if (environment && !environment.equals(readRecord(fd, 'environ', MAX_ARGV_BYTES, options.uid))) uncertain('identity_changed');
    return options.verifySessionConsumer && consumer ? {category:consumer,bound} : consumer;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function processNames(procFd, maxEntries) {
  const directory = fs.opendirSync(`/proc/self/fd/${procFd}`);
  const names = [];
  try {
    let entry; let seen = 0;
    while ((entry = directory.readSync()) !== null) {
      if (++seen > maxEntries) uncertain('classification_unknown');
      if (/^[1-9]\d*$/.test(entry.name)) names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names.sort();
}

function scanConsumers({ repositoryRoot, procRoot = '/proc', uid = process.getuid(), excludePids = [], maxEntries = MAX_ENTRIES, maxArgvBytes = MAX_ARGV_BYTES } = {}, verifySessionConsumer, causes = null) {
  const result = { clear: false, counts: { tui: 0, app_server: 0, legacy: 0, managed: 0 }, uncertain: 0 };
  if (verifySessionConsumer) result.bound = {tui:0,app_server:0,legacy:0,managed:0};
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
        const consumer = processObservation(fd, pid, { repositoryRoot: repository, uid, maxArgvBytes, verifySessionConsumer });
        if (consumer && verifySessionConsumer) (consumer.bound ? result.bound : result.counts)[consumer.category]++;
        else if (consumer) result.counts[consumer]++;
      } catch (error) {
        result.uncertain++;
        if (causes) {
          let cause = error?.inventoryCause;
          if (!INVENTORY_CAUSES.includes(cause)) {
            try { fs.lstatSync(`/proc/self/fd/${fd}/${pid}`); cause = 'record_unreadable'; }
            catch (current) { cause = current?.code === 'ENOENT' ? 'process_vanished' : 'record_unreadable'; }
          }
          causes[cause]++;
        }
      }
    }
    const afterNames = processNames(fd, maxEntries);
    if (names.length !== afterNames.length || names.some((name, index) => name !== afterNames[index]) || !sameObject(before, fs.lstatSync(proc))) {
      result.uncertain++;
      if (causes) causes.pid_set_changed++;
    }
    result.clear = result.uncertain === 0 && Object.values(result.counts).every(count => count === 0);
  } catch (error) {
    result.uncertain++;
    if (causes) causes[INVENTORY_CAUSES.includes(error?.inventoryCause) ? error.inventoryCause : 'record_unreadable']++;
  }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return result;
}

export function inspectConsumers(options = {}) {
  return scanConsumers(options);
}

// Module-only proof callback. The public deployment command always supplies its
// canonical binding verifier; there is no argv/env exclusion or acceptance knob.
export function inspectSessionConsumers(options, verifySessionConsumer) {
  if (typeof verifySessionConsumer !== 'function') uncertain();
  return scanConsumers(options, verifySessionConsumer);
}

export function observeSessionConsumers(options, verifySessionConsumer, stage) {
  if (typeof verifySessionConsumer !== 'function' || !INVENTORY_STAGES.has(stage)) uncertain();
  const causes = causeCounts();
  const started = process.hrtime.bigint();
  const inventory = scanConsumers(options, verifySessionConsumer, causes);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const disallowed = Object.values(inventory.counts).some(count => count > 0);
  return {
    inventory,
    observation: {
      stage,
      outcome: inventory.uncertain > 0 ? 'incomplete' : disallowed ? 'disallowed' : 'complete',
      elapsedMs,
      causeCounts: causes,
    },
  };
}

export function requireQuiescence(options) {
  const result = inspectConsumers(options);
  // The refusing inventory rides on the error so a caller can record its counts.
  if (result.uncertain) throw Object.assign(new DeploymentError('DEPLOY_INVENTORY_UNCERTAIN'), { inventory: result });
  if (!result.clear) throw Object.assign(new DeploymentError('DEPLOY_CONSUMERS_ACTIVE'), { inventory: result });
  return result;
}
