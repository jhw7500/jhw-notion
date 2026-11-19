import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GUARD_TRANSITION_PATHS,
  captureGuardTransitionEvidence,
  markGuardTransitionFinalized,
  prepareMigrationGuardRollback,
  recordGuardDestination,
  recordGuardPolicyContext,
  recordGuardPublishedSnapshots,
  sealMigrationGuardForward,
  restoreMigrationGuardRollback,
  validMigrationGuardReference,
  writeGuardTransitionEvidence,
} from './runtime-guard.mjs';
import {readMigrationAnchor} from './runtime-store.mjs';

const releaseA = `r-${'a'.repeat(40)}-${'1'.repeat(64)}`;
const releaseB = `r-${'b'.repeat(40)}-${'2'.repeat(64)}`;
const activationA = `a-${'a'.repeat(32)}`;
const activationB = `a-${'b'.repeat(32)}`;
const migrationId = `m-${'c'.repeat(32)}`;

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value !== null && typeof value === 'object' ?
    `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` :
    JSON.stringify(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const identity = (stat, {times = false, links = false, size = false} = {}) => ({
  dev: String(stat.dev), ino: String(stat.ino), uid: Number(stat.uid), mode: Number(stat.mode & 0o7777n),
  gid: Number(stat.gid),
  ...(links ? {nlink: Number(stat.nlink)} : {}),
  ...(times ? {mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs)} : {}),
  ...(size ? {size: String(stat.size)} : {}),
});

function write(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, bytes, {mode});
  fs.chmodSync(file, mode);
}

function v1Current(activationId, releaseId, predecessorActivationId, seed) {
  return {activationId, releaseId, predecessorActivationId,
    observation: {target: `activations/${activationId}`, dev: '1', ino: String(seed), ctimeNs: String(seed + 1)}};
}

function migrationAnchor(root, preMigrationCurrent, legacyRollbackTarget, guard=null) {
  const migration = path.join(root, '.jhw-runtime/v2/migrations', migrationId);
  const backup = path.join(migration, 'bootstrap-original');
  fs.mkdirSync(backup, {recursive: true, mode: 0o700});
  for (const directory of [path.join(root, '.jhw-runtime/v2'), path.dirname(migration), migration, backup]) {
    fs.chmodSync(directory, 0o700);
  }
  const marker = path.join(backup, 'marker');
  write(marker, 'legacy bootstrap\n');
  const rootStat = fs.lstatSync(backup, {bigint: true});
  const markerStat = fs.lstatSync(marker, {bigint: true});
  const markerHash = sha256(fs.readFileSync(marker));
  const recoveryCopy = [
    {path: '', type: 'directory', identity: {...identity(rootStat, {times: true, links: true, size: true})},
      children: ['marker']},
    {path: 'marker', type: 'file', identity: identity(markerStat, {times: true, links: true, size: true}), sha256: markerHash},
  ];
  delete recoveryCopy[0].identity.ctimeNs;
  const snapshot = [
    {path: '', type: 'directory', mode: 0o700, children: ['marker']},
    {path: 'marker', type: 'file', mode: 0o600, sha256: markerHash},
  ];
  const anchor = {version: 1, migrationId, preMigrationCurrent, legacyRollbackTarget,
    previousDirectory: `.bootstrap.previous.${migrationId.slice(2)}`,
    originalBootstrap: {manifest: {sourceReleaseId: releaseA}, treeSha256: sha256(Buffer.from(canonical(snapshot))), identity: []},
    recoveryCopy,
    guard, legacyReceipt: {journal: `.deploy.${'8'.repeat(32)}`, current: preMigrationCurrent, previous: legacyRollbackTarget,
      receipt: {stateSha256: '3'.repeat(64)}},
    router: {sourceReleaseId: releaseB, routerContract: 1},
    pair: {releaseId: releaseB, bootstrapId: `b-${'4'.repeat(64)}`, runtimeContract: 2,
      compatibilityDigest: '5'.repeat(64)},
    firstActivationId: `a-${'6'.repeat(32)}`};
  write(path.join(migration, 'anchor.json'), `${canonical(anchor)}\n`);
  return readMigrationAnchor({repositoryRoot: root, migrationId});
}

function fixture(t, {withGuard = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-runtime-guard-migration-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const runtime = path.join(root, '.jhw-runtime');
  const candidate = path.join(runtime, 'v2/journals', `.candidate.${'7'.repeat(32)}`);
  for (const directory of [home, runtime, path.join(runtime, 'v2'), path.dirname(candidate), candidate,
    path.join(home, '.config/jhw-control'), path.join(home, '.claude'), path.join(home, '.codex')]) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700}); fs.chmodSync(directory, 0o700);
  }
  write(path.join(home, '.claude/settings.json'), '{"foreign":"claude"}\n');
  write(path.join(home, '.codex/hooks.json'), '{"hooks":{},"foreign":"codex"}\n');
  const scripts = path.join(runtime, 'releases', releaseB, 'scripts');
  fs.mkdirSync(scripts, {recursive: true, mode: 0o755});
  for (const name of ['install-config.mjs', 'runtime-entry.mjs', 'runtime-safety.mjs', 'runtime-store.mjs']) {
    fs.copyFileSync(path.join(import.meta.dirname, name), path.join(scripts, name));
    fs.chmodSync(path.join(scripts, name), 0o644);
  }
  const legacyRollbackTarget = v1Current(activationA, releaseA, null, 10);
  const preMigrationCurrent = v1Current(activationB, releaseB, activationA, 20);
  let guard=null;
  if (withGuard) {
    const forwardDirectory = path.join(runtime, `.deploy.${'8'.repeat(32)}`);
    fs.mkdirSync(forwardDirectory, {mode: 0o700});
    const forward = captureGuardTransitionEvidence({home, repositoryRoot: root,
      candidateReleaseId: releaseB, origin: legacyRollbackTarget});
    writeGuardTransitionEvidence({journalDirectory: forwardDirectory, evidence: forward});
    for (const entry of forward.entries) write(path.join(home, entry.path), Buffer.from(entry.predicted.bytes, 'base64'));
    const contextDirectory = path.join(home, '.config/jhw-control/.guard-policy.json.jhw-txn.migration');
    fs.mkdirSync(contextDirectory, {mode: 0o700});
    recordGuardPolicyContext({journalDirectory: forwardDirectory, context: {version: 1,
      file: path.join(home, GUARD_TRANSITION_PATHS[0]), directory: contextDirectory,
      transition: 'absent:observe', stage: 'activated'}});
    recordGuardPublishedSnapshots({home, journalDirectory: forwardDirectory});
    recordGuardDestination({journalDirectory: forwardDirectory, destinationActivationId: activationB});
    markGuardTransitionFinalized({home, journalDirectory: forwardDirectory});
    guard=sealMigrationGuardForward({repositoryRoot:root,journal:path.basename(forwardDirectory),current:preMigrationCurrent,previous:legacyRollbackTarget});
  }
  const anchor = migrationAnchor(root, preMigrationCurrent, legacyRollbackTarget,guard);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, home, candidate, anchor};
}

function prepareAndFinalizeJournal(f) {
  const reference = prepareMigrationGuardRollback({repositoryRoot: f.root, journalDirectory: f.candidate, anchor: f.anchor});
  assert.equal(validMigrationGuardReference(reference), true);
  const finalized = path.join(path.dirname(f.candidate), `d-${'9'.repeat(32)}`);
  fs.renameSync(f.candidate, finalized);
  return {reference, finalized};
}

test('nested v2 journal restores guard-enabled B to legacy A preimages after candidate finalization', t => {
  const f = fixture(t);
  const {reference, finalized} = prepareAndFinalizeJournal(f);
  assert.equal(reference.forward.journal, `.deploy.${'8'.repeat(32)}`);
  assert.equal(Object.values(reference).some(value => typeof value === 'string' && value.includes('.candidate')), false);
  const persistedReference = JSON.parse(canonical(reference));
  const restored = restoreMigrationGuardRollback({repositoryRoot: f.root, home: f.home,
    journalDirectory: finalized, anchor: f.anchor, reference: persistedReference});
  assert.equal(restored.status, 'restored');
  assert.equal(fs.existsSync(path.join(f.home, GUARD_TRANSITION_PATHS[0])), false);
  assert.equal(fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[1]), 'utf8'), '{"foreign":"claude"}\n');
  assert.equal(fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[2]), 'utf8'), '{"hooks":{},"foreign":"codex"}\n');
});

test('migration guard prepare returns null without creating a child when B has no finalized guard evidence', t => {
  const f = fixture(t, {withGuard: false});
  assert.equal(prepareMigrationGuardRollback({repositoryRoot: f.root, journalDirectory: f.candidate, anchor: f.anchor}), null);
  assert.equal(fs.existsSync(path.join(f.candidate, 'guard')), false);
});

test('foreign HOME changes reject migration restore before any earlier entry is changed', t => {
  const f = fixture(t);
  const {reference, finalized} = prepareAndFinalizeJournal(f);
  const policy = fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[0]));
  const claude = fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[1]));
  write(path.join(f.home, GUARD_TRANSITION_PATHS[2]), '{"foreign":"after migration"}\n');
  assert.throws(() => restoreMigrationGuardRollback({repositoryRoot: f.root, home: f.home,
    journalDirectory: finalized, anchor: f.anchor, reference}), {code: 'DEPLOY_RECOVERY_REQUIRED'});
  assert.deepEqual(fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[0])), policy);
  assert.deepEqual(fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[1])), claude);
  assert.equal(fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[2]), 'utf8'), '{"foreign":"after migration"}\n');
});

test('migration guard restore resumes the existing reverse journal after interruption', t => {
  const f = fixture(t);
  const {reference, finalized} = prepareAndFinalizeJournal(f);
  let interrupted = false;
  assert.throws(() => restoreMigrationGuardRollback({repositoryRoot: f.root, home: f.home,
    journalDirectory: finalized, anchor: f.anchor, reference,
    faultInjector(point) { if (!interrupted && point === 'after_capture_sync') { interrupted = true; throw new Error('interrupt'); } }}),
  /interrupt/);
  assert.equal(restoreMigrationGuardRollback({repositoryRoot: f.root, home: f.home,
    journalDirectory: finalized, anchor: f.anchor, reference}).status, 'restored');
});
