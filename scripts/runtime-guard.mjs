import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';

import {DeploymentError, trustedDirectory, trustedFile} from './runtime-safety.mjs';
import {isActivationSnapshot} from './runtime-store.mjs';

export const GUARD_TRANSITION_PATHS = Object.freeze([
  '.config/jhw-control/guard-policy.json',
  '.claude/settings.json',
  '.codex/hooks.json',
]);

const RELEASE = /^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/;
const ACTIVATION = /^a-[a-f0-9]{32}$/;
const JOURNAL = /^\.deploy\.[a-f0-9]{32}$/;
const POLICY_TRANSACTION = /^\.guard-policy\.json\.jhw-txn\.[A-Za-z0-9._-]{1,128}$/;
const FILE_LIMIT = 128 * 1024;
const EVIDENCE_LIMIT = 4 * 1024 * 1024;
const JOURNAL_LIMIT = 8_192;
const OBSERVE_POLICY = Buffer.from('{"version":1,"mode":"observe"}\n', 'utf8');

function fail(reason, code = 'DEPLOY_RECOVERY_REQUIRED') {
  throw new DeploymentError(code, reason);
}

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function sameIdentity(left, right) {
  return ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'ctimeNs', 'mtimeNs']
    .every(key => left[key] === right[key]);
}

function pinnedDirectory(directory) {
  const initial = trustedDirectory(directory);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd, {bigint: true});
  const matches = value => String(value.dev) === String(opened.dev) && String(value.ino) === String(opened.ino) &&
    Number(value.uid) === Number(opened.uid) && Number(value.mode & 0o7777n) === Number(opened.mode & 0o7777n);
  const verify = () => {
    if (!matches(fs.fstatSync(fd, {bigint: true})) || !matches(fs.lstatSync(directory, {bigint: true})) ||
        !matches({...initial, dev: BigInt(initial.dev), ino: BigInt(initial.ino), uid: BigInt(initial.uid),
          mode: BigInt(initial.mode)})) fail('guard_parent_changed', 'DEPLOY_UNTRUSTED_PATH');
  };
  try { verify(); } catch (cause) { fs.closeSync(fd); throw cause; }
  return {fd, at: name => `/proc/self/fd/${fd}/${name}`, verify, close: () => fs.closeSync(fd)};
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshotFile(home, relative) {
  if (!GUARD_TRANSITION_PATHS.includes(relative)) fail('guard_path_invalid');
  const file = path.join(home, relative);
  const parent = pinnedDirectory(path.dirname(file));
  let fd;
  try {
    const anchored = parent.at(path.basename(file));
    let before;
    try { before = fs.lstatSync(anchored, {bigint: true}); }
    catch (cause) {
      if (cause?.code === 'ENOENT') { parent.verify(); return {type: 'absent'}; }
      throw cause;
    }
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n ||
        (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(FILE_LIMIT)) fail('guard_file_unsafe');
    fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd, {bigint: true});
    if (!sameIdentity(before, opened)) fail('guard_file_changed');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd, {bigint: true});
    const named = fs.lstatSync(anchored, {bigint: true});
    parent.verify();
    if (length !== Number(before.size) || !sameIdentity(before, after) || !sameIdentity(before, named)) {
      fail('guard_file_changed');
    }
    const content = bytes.subarray(0, length);
    return {
      type: 'file', mode: Number(before.mode & 0o7777n), bytes: content.toString('base64'),
      size: length, sha256: digest(content),
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    parent.close();
  }
}

function validSnapshot(value) {
  if (exact(value, ['type'])) return value.type === 'absent';
  if (!exact(value, ['type', 'mode', 'bytes', 'size', 'sha256']) || value.type !== 'file' ||
      value.mode !== 0o600 || !Number.isInteger(value.size) || value.size < 0 || value.size > FILE_LIMIT ||
      typeof value.bytes !== 'string' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return false;
  let bytes;
  try { bytes = Buffer.from(value.bytes, 'base64'); } catch { return false; }
  return bytes.length === value.size && digest(bytes) === value.sha256;
}

function sameSnapshot(left, right) {
  return validSnapshot(left) && validSnapshot(right) && JSON.stringify(left) === JSON.stringify(right);
}

function validTransitionEntryPaths(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > GUARD_TRANSITION_PATHS.length) return false;
  const paths = entries.map(entry => entry?.path);
  return paths[0] === GUARD_TRANSITION_PATHS[0] && new Set(paths).size === paths.length &&
    JSON.stringify(paths) === JSON.stringify(GUARD_TRANSITION_PATHS.filter(relative => paths.includes(relative)));
}

function transitionPaths(home) {
  const paths = [GUARD_TRANSITION_PATHS[0]];
  for (const relative of GUARD_TRANSITION_PATHS.slice(1)) {
    try { fs.lstatSync(path.dirname(path.join(home, relative))); }
    catch (cause) { if (cause?.code === 'ENOENT') continue; throw cause; }
    paths.push(relative);
  }
  return paths;
}

function validActivation(value) {
  return isActivationSnapshot(value);
}

function homeIdentity(home) {
  if (!path.isAbsolute(home) || path.resolve(home) !== home) fail('guard_home_invalid');
  const stat = trustedDirectory(home);
  return {
    path: home,
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: stat.uid,
    mode: stat.mode & 0o7777,
  };
}

function validHomeIdentity(value) {
  return exact(value, ['path', 'dev', 'ino', 'uid', 'mode']) && path.isAbsolute(value.path) &&
    path.resolve(value.path) === value.path && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino) &&
    Number.isInteger(value.uid) && Number.isInteger(value.mode);
}

function requireHomeIdentity(home, expected) {
  const actual = homeIdentity(home);
  if (!validHomeIdentity(expected) || JSON.stringify(actual) !== JSON.stringify(expected)) fail('guard_home_changed');
  return actual;
}

function atomicEvidenceWrite(journalDirectory, evidence, exclusive = false) {
  const encoded = Buffer.from(`${JSON.stringify(evidence)}\n`, 'utf8');
  if (encoded.length > EVIDENCE_LIMIT) fail('guard_evidence_too_large');
  const directory = pinnedDirectory(journalDirectory);
  const temporary = `.before.${randomBytes(16).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(directory.at(temporary), fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, encoded);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (exclusive) {
      fs.linkSync(directory.at(temporary), directory.at('before.json'));
      fs.unlinkSync(directory.at(temporary));
    } else {
      fs.renameSync(directory.at(temporary), directory.at('before.json'));
    }
    fs.fsyncSync(directory.fd);
    directory.verify();
  } catch (cause) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(directory.at(temporary)); } catch {}
    throw cause;
  } finally { directory.close(); }
}

function readEvidence(journalDirectory, {synchronize = false} = {}) {
  const directory = pinnedDirectory(journalDirectory);
  let fd;
  try {
    const file = directory.at('before.json');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, {bigint: true});
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n ||
        (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(EVIDENCE_LIMIT)) fail('guard_evidence_unsafe');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== Number(before.size) || !sameIdentity(before, fs.fstatSync(fd, {bigint: true})) ||
        !sameIdentity(before, fs.lstatSync(file, {bigint: true}))) fail('guard_evidence_changed');
    const evidence = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length)));
    if (synchronize) {
      fs.fsyncSync(fd);
      fs.fsyncSync(directory.fd);
      if (!sameIdentity(before, fs.fstatSync(fd, {bigint: true})) ||
          !sameIdentity(before, fs.lstatSync(file, {bigint: true}))) fail('guard_evidence_changed');
    }
    directory.verify();
    return evidence;
  } catch (cause) {
    if (cause instanceof DeploymentError) throw cause;
    fail('guard_evidence_invalid');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    directory.close();
  }
}

function candidateEditor(repositoryRoot, candidateReleaseId) {
  if (!path.isAbsolute(repositoryRoot) || !RELEASE.test(candidateReleaseId)) fail('guard_candidate_invalid');
  const release = path.join(repositoryRoot, '.jhw-runtime', 'releases', candidateReleaseId);
  const editor = path.join(release, 'scripts', 'install-config.mjs');
  trustedFile(editor);
  return {release, editor};
}

function materializeSnapshot(file, snapshot) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.chmodSync(path.dirname(file), 0o700);
  if (snapshot.type === 'file') {
    fs.writeFileSync(file, Buffer.from(snapshot.bytes, 'base64'), {mode: snapshot.mode, flag: 'wx'});
    fs.chmodSync(file, snapshot.mode);
  }
}

function replayCandidate({repositoryRoot, candidateReleaseId, entries, currentPolicy}) {
  const {editor} = candidateEditor(repositoryRoot, candidateReleaseId);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-guard-replay-'));
  fs.chmodSync(scratch, 0o700);
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, {mode: 0o700});
  try {
    const predicted = [];
    for (const entry of entries) {
      const config = path.join(home, entry.path);
      materializeSnapshot(config, entry.preimage);
      const parent = path.dirname(config);
      const isPolicy = entry.path === GUARD_TRANSITION_PATHS[0];
      const adapter = entry.path === GUARD_TRANSITION_PATHS[1] ? 'claude' : 'codex';
      const prefix = isPolicy ? '.guard-policy.json.jhw-txn.' :
        adapter === 'claude' ? '.settings.json.jhw-txn.' : '.hooks.json.jhw-txn.';
      const transaction = path.join(parent, `${prefix}replay`);
      fs.mkdirSync(transaction, {mode: 0o700});
      const operation = isPolicy ? 'register-guard-policy-transaction' : `register-${adapter}-hooks-transaction`;
      const evidence = isPolicy ? `${currentPolicy}:observe` : 'all';
      const runEditor = (selectedOperation, selectedEvidence) => spawnSync(process.execPath, [editor, selectedOperation, config, process.execPath,
        repositoryRoot, transaction, selectedEvidence], {
        cwd: scratch,
        env: {HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`},
        encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
      });
      const result = runEditor(operation, evidence);
      if (![0, 3].includes(result.status) || result.signal !== null) fail('guard_candidate_replay_failed');
      if (result.status === 3) {
        // Match the live installer's unchanged-hook path: detach captured-live
        // before requiring a settled single-link snapshot of the live file.
        const finalize = isPolicy ? 'finalize-guard-policy-transaction' : `finalize-${adapter}-hooks-transaction`;
        const settled = runEditor(finalize, 'unchanged-restored');
        if (settled.status !== 0 || settled.signal !== null) fail('guard_candidate_replay_failed');
      }
      predicted.push({path: entry.path, snapshot: snapshotFile(home, entry.path)});
    }
    return predicted;
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
}

export function readGuardHostPolicy({home}) {
  if (!path.isAbsolute(home)) fail('guard_home_invalid');
  // Absence enables no policy: ordinary managed installations need no private namespace.
  try { fs.lstatSync(path.join(home, GUARD_TRANSITION_PATHS[0])); }
  catch (cause) { if (cause?.code === 'ENOENT') return 'absent'; throw cause; }
  const snapshot = snapshotFile(home, GUARD_TRANSITION_PATHS[0]);
  if (snapshot.type === 'absent') return 'absent';
  return Buffer.from(snapshot.bytes, 'base64').equals(OBSERVE_POLICY) ? 'observe' : fail('guard_policy_invalid');
}

export function captureGuardTransitionEvidence({home, repositoryRoot, candidateReleaseId, origin}) {
  if (!path.isAbsolute(home) || !validActivation(origin)) fail('guard_coordinates_invalid');
  const capturedHome = homeIdentity(home);
  const currentPolicy = readGuardHostPolicy({home});
  if (currentPolicy !== 'absent') fail('guard_transition_already_applied');
  const entries = transitionPaths(home).map(relative => ({path: relative, preimage: snapshotFile(home, relative)}));
  const predicted = replayCandidate({repositoryRoot, candidateReleaseId, entries, currentPolicy});
  requireHomeIdentity(home, capturedHome);
  return {
    version: 1, kind: 'guard-observe-transition', direction: 'forward', status: 'captured',
    origin: structuredClone(origin), candidate_release_id: candidateReleaseId, current_policy: currentPolicy,
    home: capturedHome,
    entries: entries.map((entry, index) => ({...entry, predicted: predicted[index].snapshot})),
  };
}

function validForward(value) {
  if (!exact(value, ['version', 'kind', 'direction', 'status', 'origin', 'candidate_release_id',
    'current_policy', 'home', 'entries', ...(value.policy_context ? ['policy_context'] : []),
    ...(value.destination_activation_id ? ['destination_activation_id'] : [])])) return false;
  if (value.version !== 1 || value.kind !== 'guard-observe-transition' || value.direction !== 'forward' ||
      !['captured', 'policy-context-recorded', 'published-recorded', 'destination-bound', 'finalized'].includes(value.status) ||
      !validActivation(value.origin) || !RELEASE.test(value.candidate_release_id) || value.current_policy !== 'absent' ||
      !validHomeIdentity(value.home) || !validTransitionEntryPaths(value.entries)) return false;
  if (!value.entries.every(entry => exact(entry,
    ['path', 'preimage', 'predicted', ...(entry.published ? ['published'] : [])]) &&
    GUARD_TRANSITION_PATHS.includes(entry.path) && validSnapshot(entry.preimage) && validSnapshot(entry.predicted) &&
    (entry.published === undefined || validSnapshot(entry.published)))) return false;
  if (value.destination_activation_id !== undefined && !ACTIVATION.test(value.destination_activation_id)) return false;
  if (value.policy_context !== undefined && !validPolicyContext(value.policy_context)) return false;
  const published = value.entries.every(entry => entry.published !== undefined);
  if (value.entries.some(entry => (entry.published !== undefined) !== published)) return false;
  if (value.status === 'captured') {
    return value.policy_context === undefined && !published && value.destination_activation_id === undefined;
  }
  if (value.status === 'policy-context-recorded') {
    return value.policy_context !== undefined && !published && value.destination_activation_id === undefined;
  }
  if (value.status === 'published-recorded') {
    return value.policy_context !== undefined && published && value.destination_activation_id === undefined;
  }
  return value.policy_context !== undefined && published && value.destination_activation_id !== undefined;
}

function validPolicyContext(value) {
  return exact(value, ['version', 'file', 'directory', 'transition', 'stage']) && value.version === 1 &&
    path.isAbsolute(value.file) && path.isAbsolute(value.directory) &&
    value.transition === 'absent:observe' && value.stage === 'activated';
}

function contextHome(context) {
  return path.dirname(path.dirname(path.dirname(context.file)));
}

function requireForward(journalDirectory) {
  const evidence = readEvidence(journalDirectory);
  if (!validForward(evidence)) fail('guard_evidence_invalid');
  return evidence;
}

export function writeGuardTransitionEvidence({journalDirectory, evidence}) {
  if (!validForward(evidence) || evidence.status !== 'captured') fail('guard_evidence_invalid');
  atomicEvidenceWrite(journalDirectory, evidence, true);
}

export function recordGuardPolicyContext({journalDirectory, context}) {
  const evidence = requireForward(journalDirectory);
  if (evidence.status !== 'captured' || !validPolicyContext(context)) fail('guard_context_invalid');
  const home = contextHome(context);
  requireHomeIdentity(home, evidence.home);
  if (context.file !== path.join(home, GUARD_TRANSITION_PATHS[0]) || home !== evidence.home.path ||
      path.dirname(context.directory) !== path.dirname(context.file) ||
      !POLICY_TRANSACTION.test(path.basename(context.directory))) fail('guard_context_invalid');
  trustedDirectory(context.directory);
  evidence.policy_context = structuredClone(context);
  evidence.status = 'policy-context-recorded';
  atomicEvidenceWrite(journalDirectory, evidence);
  return evidence;
}

export function recordGuardPublishedSnapshots({home, journalDirectory}) {
  const evidence = requireForward(journalDirectory);
  requireHomeIdentity(home, evidence.home);
  if (evidence.status !== 'policy-context-recorded' || home !== contextHome(evidence.policy_context)) {
    fail('guard_evidence_order');
  }
  if (JSON.stringify(transitionPaths(home)) !== JSON.stringify(evidence.entries.map(entry => entry.path))) {
    fail('guard_transition_scope_changed');
  }
  for (const entry of evidence.entries) {
    const published = snapshotFile(home, entry.path);
    if (!sameSnapshot(published, entry.predicted)) fail('guard_published_mismatch');
    entry.published = published;
  }
  evidence.status = 'published-recorded';
  atomicEvidenceWrite(journalDirectory, evidence);
  return evidence;
}

export function recordGuardDestination({journalDirectory, destinationActivationId}) {
  const evidence = requireForward(journalDirectory);
  if (evidence.status !== 'published-recorded' || !ACTIVATION.test(destinationActivationId)) fail('guard_destination_invalid');
  evidence.destination_activation_id = destinationActivationId;
  evidence.status = 'destination-bound';
  atomicEvidenceWrite(journalDirectory, evidence);
  return evidence;
}

export function markGuardTransitionFinalized({home, journalDirectory}) {
  const evidence = requireForward(journalDirectory);
  requireHomeIdentity(home, evidence.home);
  if (evidence.status !== 'destination-bound' || home !== contextHome(evidence.policy_context)) {
    fail('guard_evidence_order');
  }
  for (const entry of evidence.entries) {
    if (!sameSnapshot(snapshotFile(home, entry.path), entry.published)) fail('guard_published_mismatch');
  }
  evidence.status = 'finalized';
  atomicEvidenceWrite(journalDirectory, evidence);
  return evidence;
}

export function findGuardTransitionEvidence({runtimeRoot, activationId}) {
  if (!path.isAbsolute(runtimeRoot) || !ACTIVATION.test(activationId)) fail('guard_lookup_invalid');
  const runtime = pinnedDirectory(runtimeRoot);
  try {
    const names = fs.readdirSync(runtime.at('.')).sort();
    if (names.length > JOURNAL_LIMIT) fail('guard_lookup_limit');
    const matches = [];
    for (const name of names.filter(candidate => JOURNAL.test(candidate))) {
      const journalDirectory = path.join(runtimeRoot, name);
      const before = path.join(journalDirectory, 'before.json');
      let info;
      try { info = fs.lstatSync(before); } catch (cause) { if (cause?.code === 'ENOENT') continue; throw cause; }
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 ||
          (info.mode & 0o7777) !== 0o600 || info.size > EVIDENCE_LIMIT) fail('guard_lookup_unsafe');
      let evidence;
      try { evidence = readEvidence(journalDirectory); } catch { fail('guard_lookup_unsafe'); }
      if (exact(evidence, ['version', 'entries']) && evidence.version === 1 && Array.isArray(evidence.entries)) continue;
      if (evidence?.kind !== 'guard-observe-transition') fail('guard_lookup_unsafe');
      if (validReverse(evidence)) continue;
      if (!validForward(evidence)) fail('guard_lookup_unsafe');
      if (evidence.status === 'finalized' && evidence.destination_activation_id === activationId) {
        matches.push({journalDirectory, evidence});
      }
    }
    runtime.verify();
    if (matches.length > 1) fail('guard_lookup_ambiguous');
    return matches[0] ?? null;
  } finally { runtime.close(); }
}

function validReverse(value) {
  if (!exact(value, ['version', 'kind', 'direction', 'scope', 'status', 'source_activation_id',
    'destination_activation_id', 'forward_journal', 'entries'])) return false;
  return value.version === 1 && value.kind === 'guard-observe-transition' && value.direction === 'reverse' &&
    ['finalized-transition', 'incomplete-config'].includes(value.scope) &&
    ['prepared', 'restoring', 'restored'].includes(value.status) && ACTIVATION.test(value.source_activation_id) &&
    ACTIVATION.test(value.destination_activation_id) && JOURNAL.test(value.forward_journal) &&
    validTransitionEntryPaths(value.entries) &&
    value.entries.every(entry => exact(entry, ['path', 'preimage', 'published', 'progress',
      ...(entry.capture ? ['capture'] : []), ...(entry.ready ? ['ready'] : [])]) &&
      GUARD_TRANSITION_PATHS.includes(entry.path) &&
      validSnapshot(entry.preimage) && validSnapshot(entry.published) &&
      ['pending', 'intent-durable', 'capture-durable', 'preimage-published', 'restored'].includes(entry.progress) &&
      (entry.capture === undefined || /^\.jhw-guard-restore\.[a-f0-9]{32}$/.test(entry.capture)) &&
      (entry.ready === undefined || /^\.jhw-guard-ready\.[a-f0-9]{32}$/.test(entry.ready)) &&
      (['intent-durable', 'capture-durable', 'preimage-published'].includes(entry.progress) ?
        entry.capture !== undefined : entry.capture === undefined) &&
      (entry.progress === 'intent-durable' || entry.progress === 'capture-durable' ?
        (entry.preimage.type === 'file' ? entry.ready !== undefined : entry.ready === undefined) :
        entry.ready === undefined)) &&
    (value.status !== 'prepared' || value.entries.every(entry => entry.progress === 'pending')) &&
    (value.status !== 'restored' || value.entries.every(entry => entry.progress === 'restored'));
}

export function readGuardTransitionEvidence({journalDirectory}) {
  const directory = pinnedDirectory(journalDirectory);
  try {
    try { fs.lstatSync(directory.at('before.json'), {bigint: true}); }
    catch (cause) {
      if (cause?.code === 'ENOENT') { directory.verify(); return null; }
      throw cause;
    }
    directory.verify();
  } finally { directory.close(); }
  const evidence = readEvidence(journalDirectory);
  if (exact(evidence, ['version', 'entries']) && evidence.version === 1 && Array.isArray(evidence.entries)) return null;
  if (!validForward(evidence) && !validReverse(evidence)) fail('guard_evidence_invalid');
  return evidence;
}

function requireReverse(journalDirectory, options) {
  const evidence = readEvidence(journalDirectory, options);
  if (!validReverse(evidence)) fail('guard_evidence_invalid');
  return evidence;
}

export function prepareGuardRollbackEvidence({forwardJournalDirectory, rollbackJournalDirectory,
  sourceActivationId, destinationActivationId}) {
  const forward = requireForward(forwardJournalDirectory);
  if (path.dirname(forwardJournalDirectory) !== path.dirname(rollbackJournalDirectory) ||
      forward.status !== 'finalized' || sourceActivationId !== forward.destination_activation_id ||
      destinationActivationId !== forward.origin.activationId) fail('guard_rollback_coordinates');
  const evidence = {
    version: 1, kind: 'guard-observe-transition', direction: 'reverse', scope: 'finalized-transition', status: 'prepared',
    source_activation_id: sourceActivationId, destination_activation_id: destinationActivationId,
    forward_journal: path.basename(forwardJournalDirectory),
    entries: forward.entries.map(entry => ({path: entry.path, preimage: entry.preimage,
      published: entry.published, progress: 'pending'})),
  };
  atomicEvidenceWrite(rollbackJournalDirectory, evidence, true);
  return evidence;
}

export function prepareIncompleteGuardRollbackEvidence({forwardJournalDirectory, rollbackJournalDirectory,
  sourceActivationId}) {
  const forward = requireForward(forwardJournalDirectory);
  const sourceAllowed = sourceActivationId === forward.origin.activationId ||
    (forward.status === 'destination-bound' && sourceActivationId === forward.destination_activation_id);
  if (path.dirname(forwardJournalDirectory) !== path.dirname(rollbackJournalDirectory) ||
      !['published-recorded', 'destination-bound'].includes(forward.status) || !sourceAllowed) {
    fail('guard_rollback_coordinates');
  }
  const evidence = {
    version: 1, kind: 'guard-observe-transition', direction: 'reverse', scope: 'incomplete-config', status: 'prepared',
    source_activation_id: sourceActivationId, destination_activation_id: forward.origin.activationId,
    forward_journal: path.basename(forwardJournalDirectory),
    entries: forward.entries.map(entry => ({path: entry.path, preimage: entry.preimage,
      published: entry.published, progress: 'pending'})),
  };
  atomicEvidenceWrite(rollbackJournalDirectory, evidence, true);
  return evidence;
}

function anchoredView(parent, name, {allowLinked = false, synchronize = false} = {}) {
  const anchored = parent.at(name);
  let before; let fd;
  try { before = fs.lstatSync(anchored, {bigint: true}); } catch (cause) {
    if (cause?.code === 'ENOENT') return {snapshot: {type: 'absent'}, identity: null};
    throw cause;
  }
  if (!before.isFile() || before.uid !== BigInt(process.getuid()) ||
      (!allowLinked && before.nlink !== 1n) || (allowLinked && ![1n, 2n].includes(before.nlink)) ||
      (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(FILE_LIMIT)) fail('guard_restore_live_unsafe');
  try {
    fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!sameIdentity(before, fs.fstatSync(fd, {bigint: true}))) fail('guard_restore_live_changed');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (synchronize) fs.fsyncSync(fd);
    if (length !== Number(before.size) || !sameIdentity(before, fs.fstatSync(fd, {bigint: true})) ||
        !sameIdentity(before, fs.lstatSync(anchored, {bigint: true}))) fail('guard_restore_live_changed');
    const content = bytes.subarray(0, length);
    return {
      snapshot: {type: 'file', mode: 0o600, bytes: content.toString('base64'), size: length, sha256: digest(content)},
      identity: {dev: String(before.dev), ino: String(before.ino), nlink: Number(before.nlink)},
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sameViewObject(left, right) {
  return left.identity !== null && right.identity !== null && left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino;
}

function restoreViews(home, entry) {
  const file = path.join(home, entry.path);
  const parent = pinnedDirectory(path.dirname(file));
  try {
    return {
      live: anchoredView(parent, path.basename(file), {allowLinked: true}),
      capture: entry.capture ? anchoredView(parent, entry.capture, {allowLinked: true}) :
        {snapshot: {type: 'absent'}, identity: null},
      ready: entry.ready ? anchoredView(parent, entry.ready, {allowLinked: true}) :
        {snapshot: {type: 'absent'}, identity: null},
    };
  } finally { parent.close(); }
}

function validRestoreViews(entry, {live, capture, ready}) {
  const named = {live, capture, ready};
  for (const [name, view] of Object.entries(named)) {
    if (view.identity?.nlink !== 2) continue;
    const partner = name === 'capture' ? 'live' : name === 'ready' ? 'live' :
      entry.progress === 'intent-durable' ? 'capture' : 'ready';
    const permitted = (entry.progress === 'intent-durable' && [name, partner].every(key => ['live', 'capture'].includes(key))) ||
      (entry.progress === 'capture-durable' && [name, partner].every(key => ['live', 'ready'].includes(key)));
    if (!permitted || named[partner].identity?.nlink !== 2 || !sameViewObject(view, named[partner])) return false;
  }
  const livePublished = sameSnapshot(live.snapshot, entry.published);
  const livePreimage = sameSnapshot(live.snapshot, entry.preimage);
  const liveAbsent = live.snapshot.type === 'absent';
  const capturePublished = sameSnapshot(capture.snapshot, entry.published);
  const captureAbsent = capture.snapshot.type === 'absent';
  const readyPreimage = sameSnapshot(ready.snapshot, entry.preimage);
  const readyAbsent = ready.snapshot.type === 'absent';
  if (entry.progress === 'pending') return captureAbsent && readyAbsent && (livePublished || livePreimage);
  if (entry.progress === 'intent-durable') {
    const readyValid = entry.preimage.type === 'file' ? readyAbsent || readyPreimage : readyAbsent;
    return readyValid && (
      livePublished && captureAbsent ||
      livePublished && capturePublished && sameViewObject(live, capture) ||
      liveAbsent && capturePublished
    );
  }
  if (entry.progress === 'capture-durable') {
    if (!capturePublished) return false;
    if (entry.preimage.type === 'absent') return liveAbsent && readyAbsent;
    return liveAbsent && readyPreimage ||
      livePreimage && readyAbsent ||
      livePreimage && readyPreimage && sameViewObject(live, ready);
  }
  if (entry.progress === 'preimage-published') {
    return livePreimage && readyAbsent && (capturePublished || captureAbsent);
  }
  return entry.progress === 'restored' && livePreimage && captureAbsent && readyAbsent;
}

function requireRestoreViews(home, entry) {
  const views = restoreViews(home, entry);
  if (!validRestoreViews(entry, views)) fail('guard_restore_foreign_change');
  return views;
}

function ensureReady(parent, entry, faultInjector = () => {}) {
  if (entry.preimage.type === 'absent') return;
  faultInjector('before_ready_sync', entry.path);
  const existing = anchoredView(parent, entry.ready, {synchronize: true});
  if (sameSnapshot(existing.snapshot, entry.preimage) && existing.identity.nlink === 1) { faultInjector('after_ready_sync', entry.path); return; }
  if (existing.snapshot.type !== 'absent') fail('guard_restore_foreign_change');
  const fd = fs.openSync(parent.at(entry.ready), fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    faultInjector('before_ready_write', entry.path);
    fs.writeFileSync(fd, Buffer.from(entry.preimage.bytes, 'base64'));
    faultInjector('after_ready_write', entry.path);
    fs.fchmodSync(fd, 0o600);
    faultInjector('before_ready_data_sync', entry.path);
    fs.fsyncSync(fd);
    faultInjector('after_ready_sync', entry.path);
  } finally { fs.closeSync(fd); }
  parent.verify();
}

function exclusiveLink(parent, source, destination, expected) {
  try { fs.linkSync(parent.at(source), parent.at(destination)); }
  catch (cause) {
    if (cause?.code === 'EEXIST') fail('guard_restore_foreign_change');
    throw cause;
  }
  const sourceView = anchoredView(parent, source, {allowLinked: true});
  const destinationView = anchoredView(parent, destination, {allowLinked: true});
  if (!sameSnapshot(sourceView.snapshot, expected) || !sameSnapshot(destinationView.snapshot, expected) ||
      !sameViewObject(sourceView, destinationView) || sourceView.identity.nlink !== 2 ||
      destinationView.identity.nlink !== 2) {
    fail('guard_restore_foreign_change');
  }
}

function synchronizePreimage(home, entry) {
  const file = path.join(home, entry.path);
  const parent = pinnedDirectory(path.dirname(file));
  try {
    const live = anchoredView(parent, path.basename(file), {synchronize: true});
    if (!sameSnapshot(live.snapshot, entry.preimage)) fail('guard_restore_foreign_change');
    fs.fsyncSync(parent.fd);
    parent.verify();
  } finally { parent.close(); }
}

export function restoreGuardRollbackEvidence({home, journalDirectory, faultInjector = () => {}}) {
  let evidence = requireReverse(journalDirectory);
  const forward = requireForward(path.join(path.dirname(journalDirectory), evidence.forward_journal));
  requireHomeIdentity(home, forward.home);
  const finalizedCoordinates = evidence.scope === 'finalized-transition' && forward.status === 'finalized' &&
    evidence.source_activation_id === forward.destination_activation_id;
  const incompleteSource = evidence.source_activation_id === forward.origin.activationId ||
    (forward.status === 'destination-bound' && evidence.source_activation_id === forward.destination_activation_id);
  const incompleteCoordinates = evidence.scope === 'incomplete-config' &&
    ['published-recorded', 'destination-bound'].includes(forward.status) && incompleteSource;
  if ((!finalizedCoordinates && !incompleteCoordinates) || home !== contextHome(forward.policy_context) ||
      evidence.destination_activation_id !== forward.origin.activationId ||
      JSON.stringify(evidence.entries.map(({path: entryPath, preimage, published}) =>
        ({path: entryPath, preimage, published}))) !== JSON.stringify(forward.entries.map(
        ({path: entryPath, preimage, published}) => ({path: entryPath, preimage, published})))) {
    fail('guard_rollback_coordinates');
  }
  if (!['prepared', 'restoring', 'restored'].includes(evidence.status)) fail('guard_restore_state');
  // Read-only all-entry preflight prevents a known later conflict from following earlier mutations.
  for (const entry of evidence.entries) requireRestoreViews(home, entry);
  // A readable progress record may have been renamed just before a failed parent sync.
  const synchronized = requireReverse(journalDirectory, {synchronize: true});
  if (JSON.stringify(synchronized) !== JSON.stringify(evidence)) fail('guard_evidence_changed');
  evidence = synchronized;
  if (evidence.status === 'restored') {
    for (const entry of evidence.entries) synchronizePreimage(home, entry);
    return evidence;
  }
  if (evidence.status === 'prepared') {
    evidence.status = 'restoring';
    atomicEvidenceWrite(journalDirectory, evidence);
  }
  for (let index = 0; index < evidence.entries.length; index += 1) {
    while (true) {
      evidence = requireReverse(journalDirectory);
      const entry = evidence.entries[index];
      const views = requireRestoreViews(home, entry);
      if (entry.progress === 'restored') { synchronizePreimage(home, entry); break; }
      if (entry.progress === 'pending') {
        if (sameSnapshot(views.live.snapshot, entry.preimage)) {
          synchronizePreimage(home, entry);
          entry.progress = 'restored';
        } else {
          entry.capture = `.jhw-guard-restore.${randomBytes(16).toString('hex')}`;
          if (entry.preimage.type === 'file') entry.ready = `.jhw-guard-ready.${randomBytes(16).toString('hex')}`;
          entry.progress = 'intent-durable';
        }
        atomicEvidenceWrite(journalDirectory, evidence);
        continue;
      }
      const file = path.join(home, entry.path);
      const parent = pinnedDirectory(path.dirname(file));
      try {
        const name = path.basename(file);
        if (entry.progress === 'intent-durable') {
          faultInjector('before_capture', entry.path);
          let current = requireRestoreViews(home, entry);
          ensureReady(parent, entry, faultInjector);
          current = requireRestoreViews(home, entry);
          if (sameSnapshot(current.live.snapshot, entry.published) && current.capture.snapshot.type === 'absent') {
            faultInjector('before_capture_link', entry.path);
            exclusiveLink(parent, name, entry.capture, entry.published);
            faultInjector('after_capture_link', entry.path);
            current = requireRestoreViews(home, entry);
          }
          if (sameSnapshot(current.live.snapshot, entry.published) &&
              sameSnapshot(current.capture.snapshot, entry.published) && sameViewObject(current.live, current.capture)) {
            faultInjector('before_live_unlink', entry.path);
            fs.unlinkSync(parent.at(name));
            faultInjector('after_live_unlink', entry.path);
          } else if (!(current.live.snapshot.type === 'absent' &&
              sameSnapshot(current.capture.snapshot, entry.published))) {
            fail('guard_restore_foreign_change');
          }
          faultInjector('before_capture_parent_sync', entry.path);
          fs.fsyncSync(parent.fd);
          parent.verify();
          faultInjector('after_capture_parent_sync', entry.path);
          entry.progress = 'capture-durable';
          atomicEvidenceWrite(journalDirectory, evidence);
          faultInjector('after_capture_sync', entry.path);
          continue;
        }
        if (entry.progress === 'capture-durable') {
          let current = requireRestoreViews(home, entry);
          if (entry.preimage.type === 'file') {
            if (current.live.snapshot.type === 'absent') {
              ensureReady(parent, entry, faultInjector);
              faultInjector('before_preimage_link', entry.path);
              exclusiveLink(parent, entry.ready, name, entry.preimage);
              faultInjector('after_preimage_link', entry.path);
              current = requireRestoreViews(home, entry);
            }
            const synced = anchoredView(parent, name, {allowLinked: true, synchronize: true});
            if (!sameSnapshot(synced.snapshot, entry.preimage)) fail('guard_restore_foreign_change');
            if (sameSnapshot(current.live.snapshot, entry.preimage) &&
                sameSnapshot(current.ready.snapshot, entry.preimage) && sameViewObject(current.live, current.ready)) {
              faultInjector('before_ready_unlink', entry.path);
              fs.unlinkSync(parent.at(entry.ready));
              faultInjector('after_ready_unlink', entry.path);
            } else if (!(sameSnapshot(current.live.snapshot, entry.preimage) &&
                current.ready.snapshot.type === 'absent')) {
              fail('guard_restore_foreign_change');
            }
            faultInjector('before_preimage_parent_sync', entry.path);
            fs.fsyncSync(parent.fd);
            parent.verify();
            faultInjector('after_preimage_parent_sync', entry.path);
            delete entry.ready;
          }
          entry.progress = 'preimage-published';
          atomicEvidenceWrite(journalDirectory, evidence);
          faultInjector('after_preimage_sync', entry.path);
          continue;
        }
        if (entry.progress === 'preimage-published') {
          const current = requireRestoreViews(home, entry);
          if (sameSnapshot(current.capture.snapshot, entry.published)) {
            faultInjector('before_capture_unlink', entry.path);
            fs.unlinkSync(parent.at(entry.capture));
            faultInjector('after_capture_unlink_before_sync', entry.path);
          } else if (current.capture.snapshot.type !== 'absent') {
            fail('guard_restore_capture_changed');
          }
          faultInjector('before_cleanup_parent_sync', entry.path);
          fs.fsyncSync(parent.fd);
          parent.verify();
          faultInjector('after_cleanup_parent_sync', entry.path);
          faultInjector('after_capture_unlink', entry.path);
          entry.progress = 'restored'; delete entry.capture;
          atomicEvidenceWrite(journalDirectory, evidence);
          continue;
        }
      } finally { parent.close(); }
    }
  }
  evidence = requireReverse(journalDirectory);
  if (!evidence.entries.every(entry => entry.progress === 'restored')) fail('guard_restore_incomplete');
  for (const entry of evidence.entries) requireRestoreViews(home, entry);
  evidence.status = 'restored';
  atomicEvidenceWrite(journalDirectory, evidence);
  return evidence;
}
