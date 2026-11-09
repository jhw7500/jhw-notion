import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {
  GUARD_TRANSITION_PATHS,
  readGuardHostPolicy,
  readGuardTransitionEvidence,
  captureGuardTransitionEvidence,
  writeGuardTransitionEvidence,
  recordGuardPolicyContext,
  recordGuardPublishedSnapshots,
  recordGuardDestination,
  markGuardTransitionFinalized,
  findGuardTransitionEvidence,
  prepareGuardRollbackEvidence,
  prepareIncompleteGuardRollbackEvidence,
  restoreGuardRollbackEvidence,
} from './runtime-guard.mjs';

const releaseId = `r-${'a'.repeat(40)}-${'b'.repeat(64)}`;
const origin = {
  activationId: `a-${'1'.repeat(32)}`,
  releaseId: `r-${'c'.repeat(40)}-${'d'.repeat(64)}`,
  predecessorActivationId: `a-${'2'.repeat(32)}`,
  observation: {target:`activations/a-${'1'.repeat(32)}`,dev:'1',ino:'2',ctimeNs:'3'},
};
const destination = `a-${'3'.repeat(32)}`;

function write(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, value, {mode});
  fs.chmodSync(file, mode);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-runtime-guard-'));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const runtimeRoot = path.join(root, 'runtime');
  const repositoryRoot = path.join(root, 'repository');
  const journalDirectory = path.join(runtimeRoot, `.deploy.${'4'.repeat(32)}`);
  for (const directory of [home, runtimeRoot, repositoryRoot, journalDirectory]) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    fs.chmodSync(directory, 0o700);
  }
  for (const directory of ['.config/jhw-control', '.claude', '.codex']) {
    fs.mkdirSync(path.join(home, directory), {recursive: true, mode: 0o700});
  }
  write(path.join(home, '.claude/settings.json'), '{"foreign":"claude"}\n');
  write(path.join(home, '.codex/hooks.json'), '{"hooks":{},"foreign":"codex"}\n');
  const sourceScripts = path.resolve(import.meta.dirname);
  const candidateScripts = path.join(repositoryRoot, '.jhw-runtime/releases', releaseId, 'scripts');
  fs.mkdirSync(candidateScripts, {recursive: true, mode: 0o755});
  for (const name of ['install-config.mjs', 'runtime-entry.mjs', 'runtime-safety.mjs', 'runtime-store.mjs']) {
    fs.copyFileSync(path.join(sourceScripts, name), path.join(candidateScripts, name));
    fs.chmodSync(path.join(candidateScripts, name), 0o644);
  }
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, home, runtimeRoot, repositoryRoot, journalDirectory};
}

function livePath(f, relative) {
  return path.join(f.home, relative);
}

function materializePredicted(f, evidence) {
  for (const entry of evidence.entries) {
    const file = livePath(f, entry.path);
    write(file, Buffer.from(entry.predicted.bytes, 'base64'), entry.predicted.mode);
  }
}

function policyContext(f, evidence) {
  const directory = path.join(f.home, '.config/jhw-control/.guard-policy.json.jhw-txn.fixture');
  fs.mkdirSync(directory, {mode: 0o700});
  return {
    version: 1,
    file: path.join(f.home, GUARD_TRANSITION_PATHS[0]),
    directory,
    transition: `${evidence.current_policy}:observe`,
    stage: 'activated',
  };
}

function finalizedForward(t) {
  const f = fixture(t);
  const evidence = captureGuardTransitionEvidence({
    home: f.home,
    repositoryRoot: f.repositoryRoot,
    candidateReleaseId: releaseId,
    origin,
  });
  writeGuardTransitionEvidence({journalDirectory: f.journalDirectory, evidence});
  materializePredicted(f, evidence);
  recordGuardPolicyContext({journalDirectory: f.journalDirectory, context: policyContext(f, evidence)});
  recordGuardPublishedSnapshots({home: f.home, journalDirectory: f.journalDirectory});
  recordGuardDestination({journalDirectory: f.journalDirectory, destinationActivationId: destination});
  markGuardTransitionFinalized({home: f.home, journalDirectory: f.journalDirectory});
  return {f, evidence: JSON.parse(fs.readFileSync(path.join(f.journalDirectory, 'before.json')))};
}

test('captures fixed preimages and candidate-predicted snapshots before any HOME mutation', t => {
  const f = fixture(t);
  const before = GUARD_TRANSITION_PATHS.map(relative => {
    const file = livePath(f, relative);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  });
  const evidence = captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  });
  assert.equal(evidence.version, 1);
  assert.equal(evidence.kind, 'guard-observe-transition');
  assert.equal(evidence.direction, 'forward');
  assert.equal(evidence.status, 'captured');
  assert.equal(evidence.current_policy, 'absent');
  assert.deepEqual(evidence.entries.map(entry => entry.path), GUARD_TRANSITION_PATHS);
  assert.match(Buffer.from(evidence.entries[0].predicted.bytes, 'base64').toString(), /"mode":"observe"/);
  assert.match(Buffer.from(evidence.entries[1].predicted.bytes, 'base64').toString(), /UserPromptSubmit/);
  assert.match(Buffer.from(evidence.entries[2].predicted.bytes, 'base64').toString(), /PreToolUse/);
  assert.deepEqual(GUARD_TRANSITION_PATHS.map((relative, index) => {
    const file = livePath(f, relative);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }), before);
});

for (const installedAdapter of ['claude', 'codex']) {
  const missingAdapter = installedAdapter === 'claude' ? 'codex' : 'claude';
  const missingPath = missingAdapter === 'claude' ? GUARD_TRANSITION_PATHS[1] : GUARD_TRANSITION_PATHS[2];
  test(`transitions only the installed ${installedAdapter} adapter and preserves a later ${missingAdapter} install on restore`, t => {
    const f = fixture(t);
    fs.rmSync(path.dirname(livePath(f, missingPath)), {recursive: true});
    const evidence = captureGuardTransitionEvidence({
      home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
    });
    assert.deepEqual(evidence.entries.map(entry => entry.path), [
      GUARD_TRANSITION_PATHS[0],
      installedAdapter === 'claude' ? GUARD_TRANSITION_PATHS[1] : GUARD_TRANSITION_PATHS[2],
    ]);
    assert.equal(fs.existsSync(path.dirname(livePath(f, missingPath))), false);

    writeGuardTransitionEvidence({journalDirectory: f.journalDirectory, evidence});
    materializePredicted(f, evidence);
    recordGuardPolicyContext({journalDirectory: f.journalDirectory, context: policyContext(f, evidence)});
    recordGuardPublishedSnapshots({home: f.home, journalDirectory: f.journalDirectory});
    recordGuardDestination({journalDirectory: f.journalDirectory, destinationActivationId: destination});
    markGuardTransitionFinalized({home: f.home, journalDirectory: f.journalDirectory});

    const lateConfig = '{"late":"adapter install"}\n';
    write(livePath(f, missingPath), lateConfig);
    const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'5'.repeat(32)}`);
    fs.mkdirSync(rollbackJournal, {mode: 0o700});
    prepareGuardRollbackEvidence({
      forwardJournalDirectory: f.journalDirectory,
      rollbackJournalDirectory: rollbackJournal,
      sourceActivationId: destination,
      destinationActivationId: origin.activationId,
    });
    assert.equal(restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal}).status, 'restored');
    assert.equal(fs.readFileSync(livePath(f, missingPath), 'utf8'), lateConfig);
  });
}

test('refuses an adapter scope change between capture and publication without modifying the new config', t => {
  const f = fixture(t);
  const codexPath = GUARD_TRANSITION_PATHS[2];
  fs.rmSync(path.dirname(livePath(f, codexPath)), {recursive: true});
  const evidence = captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  });
  writeGuardTransitionEvidence({journalDirectory: f.journalDirectory, evidence});
  materializePredicted(f, evidence);
  recordGuardPolicyContext({journalDirectory: f.journalDirectory, context: policyContext(f, evidence)});

  const lateConfig = '{"late":"before publication"}\n';
  write(livePath(f, codexPath), lateConfig);
  assert.throws(
    () => recordGuardPublishedSnapshots({home: f.home, journalDirectory: f.journalDirectory}),
    {code: 'DEPLOY_RECOVERY_REQUIRED', reason: 'guard_transition_scope_changed'},
  );
  assert.equal(fs.readFileSync(livePath(f, codexPath), 'utf8'), lateConfig);
});

function fullHooksFixture(t) {
  const f = fixture(t);
  materializePredicted(f, captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  }));
  fs.unlinkSync(livePath(f, GUARD_TRANSITION_PATHS[0]));
  return f;
}

function observeLiveFiles(f) {
  return GUARD_TRANSITION_PATHS.map(relative => {
    const file = livePath(f, relative);
    if (!fs.existsSync(file)) return null;
    const info = fs.lstatSync(file, {bigint: true});
    return {bytes: fs.readFileSync(file), identity: [info.dev, info.ino, info.uid, info.gid,
      info.mode, info.nlink, info.size, info.ctimeNs, info.mtimeNs]};
  });
}

test('candidate replay settles unchanged full hooks before snapshot without mutating HOME', t => {
  const f = fullHooksFixture(t);
  const before = observeLiveFiles(f);
  const evidence = captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  });
  assert.equal(evidence.current_policy, 'absent');
  for (const entry of evidence.entries) assert.equal(entry.predicted.type, 'file');
  for (const entry of evidence.entries.slice(1)) assert.deepEqual(entry.predicted, entry.preimage);
  assert.deepEqual(observeLiveFiles(f), before);
});

for (const adapter of ['claude', 'codex']) {
  test(`candidate replay refuses an unchanged ${adapter} finalize failure without mutating HOME`, t => {
    const f = fullHooksFixture(t);
    const editor = path.join(f.repositoryRoot, '.jhw-runtime/releases', releaseId, 'scripts/install-config.mjs');
    const bytes = fs.readFileSync(editor, 'utf8');
    const marker = 'const logicalConfigFile = configFile;';
    assert.ok(bytes.includes(marker));
    write(editor, bytes.replace(marker, `${marker}\nif (operation === "finalize-${adapter}-hooks-transaction") process.exit(93);`), 0o644);
    const before = observeLiveFiles(f);
    assert.throws(() => captureGuardTransitionEvidence({
      home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
    }), {code: 'DEPLOY_RECOVERY_REQUIRED', reason: 'guard_candidate_replay_failed'});
    assert.deepEqual(observeLiveFiles(f), before);
  });
}

test('persists and finalizes an exact transition, then finds it by destination activation only', t => {
  const {f} = finalizedForward(t);
  const before = path.join(f.journalDirectory, 'before.json');
  assert.equal(fs.statSync(before).mode & 0o7777, 0o600);
  const found = findGuardTransitionEvidence({runtimeRoot: f.runtimeRoot, activationId: destination});
  assert.equal(found.journalDirectory, f.journalDirectory);
  assert.equal(found.evidence.status, 'finalized');
  assert.equal(found.evidence.destination_activation_id, destination);
  assert.equal(findGuardTransitionEvidence({runtimeRoot: f.runtimeRoot, activationId: origin.activationId}), null);
  const duplicate = path.join(f.runtimeRoot, `.deploy.${'5'.repeat(32)}`);
  fs.mkdirSync(duplicate, {mode: 0o700});
  fs.copyFileSync(before, path.join(duplicate, 'before.json'));
  fs.chmodSync(path.join(duplicate, 'before.json'), 0o600);
  assert.throws(() => findGuardTransitionEvidence({runtimeRoot: f.runtimeRoot, activationId: destination}));
});

test('reads only absent or exact observe host policy from the fixed location', t => {
  const f = fixture(t);
  assert.equal(readGuardHostPolicy({home: f.home}), 'absent');
  write(path.join(f.home, GUARD_TRANSITION_PATHS[0]), '{"version":1,"mode":"observe"}\n');
  assert.equal(readGuardHostPolicy({home: f.home}), 'observe');
  write(path.join(f.home, GUARD_TRANSITION_PATHS[0]), '{"version":1,"mode":"enforce"}\n');
  assert.throws(() => readGuardHostPolicy({home: f.home}));
});

test('reads missing transition evidence as null but rejects malformed present evidence', t => {
  const f = fixture(t);
  assert.equal(readGuardTransitionEvidence({journalDirectory: f.journalDirectory}), null);
  write(path.join(f.journalDirectory, 'before.json'), '{"version":1,"entries":[]}\n');
  assert.equal(readGuardTransitionEvidence({journalDirectory: f.journalDirectory}), null);
  fs.unlinkSync(path.join(f.journalDirectory, 'before.json'));
  write(path.join(f.journalDirectory, 'before.json'), '{}\n');
  assert.throws(() => readGuardTransitionEvidence({journalDirectory: f.journalDirectory}));
  fs.unlinkSync(path.join(f.journalDirectory, 'before.json'));
  const evidence = captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  });
  writeGuardTransitionEvidence({journalDirectory: f.journalDirectory, evidence});
  assert.deepEqual(readGuardTransitionEvidence({journalDirectory: f.journalDirectory}), evidence);
});

test('rejects unsafe source files and published snapshots that differ from prediction', t => {
  const f = fixture(t);
  const hooks = path.join(f.home, '.codex/hooks.json');
  fs.linkSync(hooks, `${hooks}.hardlink`);
  assert.throws(() => captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  }));
  fs.unlinkSync(`${hooks}.hardlink`);
  const evidence = captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  });
  writeGuardTransitionEvidence({journalDirectory: f.journalDirectory, evidence});
  materializePredicted(f, evidence);
  recordGuardPolicyContext({journalDirectory: f.journalDirectory, context: policyContext(f, evidence)});
  fs.appendFileSync(hooks, 'foreign change\n');
  assert.throws(
    () => recordGuardPublishedSnapshots({home: f.home, journalDirectory: f.journalDirectory}),
    error => error.reason === 'guard_published_mismatch',
  );
});

test('binds the capture HOME identity before accepting policy context', t => {
  const f = fixture(t);
  const evidence = captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  });
  writeGuardTransitionEvidence({journalDirectory: f.journalDirectory, evidence});
  const otherHome = path.join(f.root, 'other-home');
  fs.mkdirSync(path.join(otherHome, '.config/jhw-control'), {recursive: true, mode: 0o700});
  assert.throws(() => recordGuardPolicyContext({
    journalDirectory: f.journalDirectory,
    context: policyContext({home: otherHome}, evidence),
  }));
});

test('rejects symlink source files and group-writable source parents', t => {
  const f = fixture(t);
  const hooks = livePath(f, GUARD_TRANSITION_PATHS[2]);
  fs.unlinkSync(hooks);
  fs.symlinkSync(livePath(f, GUARD_TRANSITION_PATHS[1]), hooks);
  assert.throws(() => captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  }));
  fs.unlinkSync(hooks);
  write(hooks, '{"hooks":{}}\n');
  fs.chmodSync(path.dirname(hooks), 0o770);
  assert.throws(() => captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  }));
});

test('restores finalized settings from separate reverse evidence and preserves the forward audit', t => {
  const {f} = finalizedForward(t);
  const forwardBytes = fs.readFileSync(path.join(f.journalDirectory, 'before.json'));
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'6'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  const result = restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal});
  assert.equal(result.status, 'restored');
  assert.equal(fs.existsSync(path.join(f.home, GUARD_TRANSITION_PATHS[0])), false);
  assert.equal(fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[1]), 'utf8'), '{"foreign":"claude"}\n');
  assert.equal(fs.readFileSync(path.join(f.home, GUARD_TRANSITION_PATHS[2]), 'utf8'), '{"hooks":{},"foreign":"codex"}\n');
  assert.deepEqual(fs.readFileSync(path.join(f.journalDirectory, 'before.json')), forwardBytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rollbackJournal, 'before.json'))).status, 'restored');
});

test('rejects reverse evidence that claims restored while entries remain pending', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'d'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  const file = path.join(rollbackJournal, 'before.json');
  const contradictory = JSON.parse(fs.readFileSync(file));
  contradictory.status = 'restored';
  write(file, `${JSON.stringify(contradictory)}\n`);
  assert.throws(() => readGuardTransitionEvidence({journalDirectory: rollbackJournal}));
  assert.throws(() => restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal}));
});

test('restores a destination-bound incomplete transition using an explicit frozen source activation', t => {
  const f = fixture(t);
  const evidence = captureGuardTransitionEvidence({
    home: f.home, repositoryRoot: f.repositoryRoot, candidateReleaseId: releaseId, origin,
  });
  writeGuardTransitionEvidence({journalDirectory: f.journalDirectory, evidence});
  materializePredicted(f, evidence);
  recordGuardPolicyContext({journalDirectory: f.journalDirectory, context: policyContext(f, evidence)});
  recordGuardPublishedSnapshots({home: f.home, journalDirectory: f.journalDirectory});
  recordGuardDestination({journalDirectory: f.journalDirectory, destinationActivationId: destination});
  const forwardBytes = fs.readFileSync(path.join(f.journalDirectory, 'before.json'));
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'c'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  const reverse = prepareIncompleteGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
  });
  assert.equal(reverse.scope, 'incomplete-config');
  assert.equal(reverse.destination_activation_id, origin.activationId);
  assert.equal(restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal}).status, 'restored');
  assert.deepEqual(fs.readFileSync(path.join(f.journalDirectory, 'before.json')), forwardBytes);
  assert.equal(fs.existsSync(livePath(f, GUARD_TRANSITION_PATHS[0])), false);
});

test('lookup validates but excludes a valid reverse journal', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'e'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  assert.equal(findGuardTransitionEvidence({runtimeRoot: f.runtimeRoot, activationId: destination}).journalDirectory,
    f.journalDirectory);
});

test('exclusive publish preserves a foreign live file created after durable capture', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'f'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  assert.throws(() => restoreGuardRollbackEvidence({
    home: f.home,
    journalDirectory: rollbackJournal,
    faultInjector(point, relative) {
      if (point === 'after_capture_sync' && relative === GUARD_TRANSITION_PATHS[1]) {
        write(livePath(f, relative), 'foreign after capture\n');
      }
    },
  }));
  assert.equal(fs.readFileSync(livePath(f, GUARD_TRANSITION_PATHS[1]), 'utf8'), 'foreign after capture\n');
  const interrupted = JSON.parse(fs.readFileSync(path.join(rollbackJournal, 'before.json')));
  assert.equal(fs.existsSync(path.join(path.dirname(livePath(f, GUARD_TRANSITION_PATHS[1])),
    interrupted.entries[1].capture)), true);
});

test('resumes after durable intent was recorded before capture', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'0'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  assert.throws(() => restoreGuardRollbackEvidence({
    home: f.home,
    journalDirectory: rollbackJournal,
    faultInjector(point, relative) {
      if (point === 'before_capture' && relative === GUARD_TRANSITION_PATHS[1]) throw new Error('crash');
    },
  }));
  assert.equal(restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal}).status, 'restored');
});

test('resumes after capture unlink was durable before restored progress commit', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'1'.repeat(31)}0`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  assert.throws(() => restoreGuardRollbackEvidence({
    home: f.home,
    journalDirectory: rollbackJournal,
    faultInjector(point, relative) {
      if (point === 'after_capture_unlink' && relative === GUARD_TRANSITION_PATHS[1]) throw new Error('crash');
    },
  }));
  assert.equal(restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal}).status, 'restored');
});

test('resume revalidates entries already marked restored before reporting terminal success', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'2'.repeat(31)}0`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  assert.throws(() => restoreGuardRollbackEvidence({
    home: f.home,
    journalDirectory: rollbackJournal,
    faultInjector(point, relative) {
      if (point === 'after_capture_sync' && relative === GUARD_TRANSITION_PATHS[2]) throw new Error('crash');
    },
  }));
  write(livePath(f, GUARD_TRANSITION_PATHS[1]), 'modified after earlier restore\n');
  assert.throws(() => restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal}));
  assert.equal(fs.readFileSync(livePath(f, GUARD_TRANSITION_PATHS[1]), 'utf8'), 'modified after earlier restore\n');
});

test('a crash after durable capture is retried without losing either published or preimage bytes', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'7'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  assert.throws(() => restoreGuardRollbackEvidence({
    home: f.home,
    journalDirectory: rollbackJournal,
    faultInjector(point, relative) {
      if (point === 'after_capture_sync' && relative === GUARD_TRANSITION_PATHS[1]) throw new Error('crash');
    },
  }));
  const interrupted = JSON.parse(fs.readFileSync(path.join(rollbackJournal, 'before.json')));
  assert.equal(interrupted.status, 'restoring');
  assert.equal(interrupted.entries[1].progress, 'capture-durable');
  const parent = path.dirname(livePath(f, GUARD_TRANSITION_PATHS[1]));
  assert.equal(fs.readdirSync(parent).some(name => name.startsWith('.jhw-guard-restore.')), true);
  const result = restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal});
  assert.equal(result.status, 'restored');
  assert.equal(fs.readFileSync(livePath(f, GUARD_TRANSITION_PATHS[1]), 'utf8'), '{"foreign":"claude"}\n');
  assert.equal(fs.readdirSync(parent).some(name => name.startsWith('.jhw-guard-restore.')), false);
});

test('a crash after preimage publication is retried by verifying both namespaces', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'9'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  assert.throws(() => restoreGuardRollbackEvidence({
    home: f.home,
    journalDirectory: rollbackJournal,
    faultInjector(point, relative) {
      if (point === 'after_preimage_sync' && relative === GUARD_TRANSITION_PATHS[1]) throw new Error('crash');
    },
  }));
  const interrupted = JSON.parse(fs.readFileSync(path.join(rollbackJournal, 'before.json')));
  assert.equal(interrupted.entries[1].progress, 'preimage-published');
  assert.equal(fs.readFileSync(livePath(f, GUARD_TRANSITION_PATHS[1]), 'utf8'), '{"foreign":"claude"}\n');
  assert.equal(restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal}).status, 'restored');
});

test('restore detects a concurrent live replacement before capture and preserves it', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'a'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  assert.throws(() => restoreGuardRollbackEvidence({
    home: f.home,
    journalDirectory: rollbackJournal,
    faultInjector(point, relative) {
      if (point === 'before_capture' && relative === GUARD_TRANSITION_PATHS[1]) {
        write(livePath(f, relative), 'concurrent user replacement\n');
      }
    },
  }));
  assert.equal(fs.readFileSync(livePath(f, GUARD_TRANSITION_PATHS[1]), 'utf8'), 'concurrent user replacement\n');
});

test('restore is bound to the HOME recorded by the finalized forward transition', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'b'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  const otherHome = path.join(f.root, 'other-home');
  for (const relative of GUARD_TRANSITION_PATHS) {
    write(path.join(otherHome, relative), fs.readFileSync(livePath(f, relative)));
  }
  assert.throws(() => restoreGuardRollbackEvidence({home: otherHome, journalDirectory: rollbackJournal}));
});

test('lookup fails closed for unsafe evidence and an over-budget runtime directory', t => {
  const {f} = finalizedForward(t);
  const before = path.join(f.journalDirectory, 'before.json');
  const saved = fs.readFileSync(before);
  fs.unlinkSync(before);
  fs.symlinkSync(livePath(f, GUARD_TRANSITION_PATHS[1]), before);
  assert.throws(() => findGuardTransitionEvidence({runtimeRoot: f.runtimeRoot, activationId: destination}));
  fs.unlinkSync(before);
  write(before, saved);
  write(before, '{"version":1,"kind":"foreign-transition","entries":[]}\n');
  assert.throws(() => findGuardTransitionEvidence({runtimeRoot: f.runtimeRoot, activationId: destination}));
  write(before, saved);
  for (let index = 0; index < 8_192; index += 1) {
    fs.writeFileSync(path.join(f.runtimeRoot, `bounded-${index}`), '');
  }
  assert.throws(() => findGuardTransitionEvidence({runtimeRoot: f.runtimeRoot, activationId: destination}));
});

test('restore refuses a user-modified live file and leaves both audit records unchanged', t => {
  const {f} = finalizedForward(t);
  const rollbackJournal = path.join(f.runtimeRoot, `.deploy.${'8'.repeat(32)}`);
  fs.mkdirSync(rollbackJournal, {mode: 0o700});
  prepareGuardRollbackEvidence({
    forwardJournalDirectory: f.journalDirectory,
    rollbackJournalDirectory: rollbackJournal,
    sourceActivationId: destination,
    destinationActivationId: origin.activationId,
  });
  const hooks = livePath(f, GUARD_TRANSITION_PATHS[2]);
  write(hooks, 'user modified\n');
  const before = fs.readFileSync(path.join(rollbackJournal, 'before.json'));
  assert.throws(() => restoreGuardRollbackEvidence({home: f.home, journalDirectory: rollbackJournal}));
  assert.equal(fs.readFileSync(hooks, 'utf8'), 'user modified\n');
  assert.deepEqual(fs.readFileSync(path.join(rollbackJournal, 'before.json')), before);
});


function preparedReverse(t) {
  const {f}=finalizedForward(t);
  const journal=path.join(f.runtimeRoot,`.deploy.${'e'.repeat(32)}`);
  fs.mkdirSync(journal,{mode:0o700});
  prepareGuardRollbackEvidence({forwardJournalDirectory:f.journalDirectory,rollbackJournalDirectory:journal,
    sourceActivationId:destination,destinationActivationId:origin.activationId});
  return {f,journal};
}

test('resume repeats data fsync on a ready inode whose first sync was interrupted',t=>{
  const {f,journal}=preparedReverse(t);const claude=path.dirname(livePath(f,GUARD_TRANSITION_PATHS[1]));
  const sync=fs.fsyncSync;let inode;
  fs.fsyncSync=function(fd){
    const info=fs.fstatSync(fd);const target=fs.readlinkSync(`/proc/self/fd/${fd}`);
    if(info.isFile()&&target.startsWith(claude+'/.jhw-guard-ready.')){inode=info.ino;throw Error('before first ready sync');}
    return sync.apply(this,arguments);
  };
  try{assert.throws(()=>restoreGuardRollbackEvidence({home:f.home,journalDirectory:journal}),/before first ready sync/);}
  finally{fs.fsyncSync=sync;}
  assert.ok(inode);let synchronized=0;
  fs.fsyncSync=function(fd){if(fs.fstatSync(fd).ino===inode)synchronized++;return sync.apply(this,arguments);};
  try{assert.equal(restoreGuardRollbackEvidence({home:f.home,journalDirectory:journal}).status,'restored');}
  finally{fs.fsyncSync=sync;}
  assert.ok(synchronized>0,'the resumed data inode must be fsynced before successful restoration');
});

test('resume repeats parent fsync when capture unlink happened before its sync',t=>{
  const {f,journal}=preparedReverse(t);const claude=path.dirname(livePath(f,GUARD_TRANSITION_PATHS[1]));
  const unlink=fs.unlinkSync;const sync=fs.fsyncSync;const inode=fs.statSync(claude).ino;let interrupted=false;
  fs.unlinkSync=function(file){
    const target=String(file);const parent=fs.realpathSync(path.dirname(target));
    const result=unlink.apply(this,arguments);
    if(!interrupted&&parent===claude&&path.basename(target).startsWith('.jhw-guard-restore.')){interrupted=true;throw Error('after unlink before parent sync');}
    return result;
  };
  try{assert.throws(()=>restoreGuardRollbackEvidence({home:f.home,journalDirectory:journal}),/after unlink before parent sync/);}
  finally{fs.unlinkSync=unlink;}
  assert.equal(interrupted,true);let synchronized=0;
  fs.fsyncSync=function(fd){const info=fs.fstatSync(fd);if(info.isDirectory()&&info.ino===inode)synchronized++;return sync.apply(this,arguments);};
  try{assert.equal(restoreGuardRollbackEvidence({home:f.home,journalDirectory:journal}).status,'restored');}
  finally{fs.fsyncSync=sync;}
  assert.ok(synchronized>0,'an absent capture does not prove its parent namespace was synced');
});

test('terminal restore rejects an unrelated second hard link',t=>{
  const {f,journal}=preparedReverse(t);
  restoreGuardRollbackEvidence({home:f.home,journalDirectory:journal});
  const live=livePath(f,GUARD_TRANSITION_PATHS[1]);const alias=path.join(f.home,'unrelated-alias');
  fs.linkSync(live,alias);
  assert.throws(()=>restoreGuardRollbackEvidence({home:f.home,journalDirectory:journal}),{code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.equal(fs.statSync(live).nlink,2);assert.deepEqual(fs.readFileSync(live),fs.readFileSync(alias));
});

test('terminal restore repeats evidence file and journal sync after interrupted publication',t=>{
  const {f,journal}=preparedReverse(t);
  const sync=fs.fsyncSync;const journalInode=fs.statSync(journal).ino;let interrupted=false;
  fs.fsyncSync=function(fd){
    const info=fs.fstatSync(fd);
    if(info.isDirectory()&&info.ino===journalInode&&
        JSON.parse(fs.readFileSync(path.join(journal,'before.json'))).status==='restored'){
      interrupted=true;throw Error('terminal evidence parent sync interrupted');
    }
    return sync.apply(this,arguments);
  };
  try{assert.throws(()=>restoreGuardRollbackEvidence({home:f.home,journalDirectory:journal}),/terminal evidence parent sync interrupted/);}
  finally{fs.fsyncSync=sync;}
  assert.equal(interrupted,true);
  const child=`import fs from 'node:fs';import path from 'node:path';
  import {restoreGuardRollbackEvidence} from ${JSON.stringify(new URL('./runtime-guard.mjs',import.meta.url).href)};
  const journal=${JSON.stringify(journal)};const journalInode=fs.statSync(journal).ino;const sync=fs.fsyncSync;
  let fileSync=0;let directorySync=0;
  fs.fsyncSync=function(fd){const info=fs.fstatSync(fd);const target=fs.readlinkSync('/proc/self/fd/'+fd);
    if(info.isDirectory()&&info.ino===journalInode)directorySync++;
    if(info.isFile()&&path.dirname(target)===journal)fileSync++;
    return sync.apply(this,arguments);};
  const result=restoreGuardRollbackEvidence(${JSON.stringify({home:f.home,journalDirectory:journal})});
  console.log(JSON.stringify({status:result.status,fileSync,directorySync}));`;
  const resumed=spawnSync(process.execPath,['--input-type=module','-'],{input:child,encoding:'utf8',timeout:10000,
    env:{HOME:f.home,PATH:process.env.PATH}});
  assert.equal(resumed.status,0,resumed.stderr);
  const result=JSON.parse(resumed.stdout);
  assert.equal(result.status,'restored');
  assert.ok(result.fileSync>0,'visible terminal progress does not prove evidence data durability');
  assert.ok(result.directorySync>0,'visible terminal progress does not prove journal namespace durability');
});

test('transition accepts the full frozen activation observation returned by the store',t=>{
  const f=fixture(t);
  const actualShape={...origin,observation:{target:`activations/${origin.activationId}`,dev:'1',ino:'2',ctimeNs:'3'}};
  const captured=captureGuardTransitionEvidence({home:f.home,repositoryRoot:f.repositoryRoot,candidateReleaseId:releaseId,origin:actualShape});
  assert.deepEqual(captured.origin,actualShape,'the observation must not be silently dropped');
});


const restoreFaultBoundaries=[
  'before_ready_sync','before_ready_write','after_ready_write','before_ready_data_sync','after_ready_sync',
  'before_capture_link','after_capture_link','before_live_unlink','after_live_unlink',
  'before_capture_parent_sync','after_capture_parent_sync','before_preimage_link','after_preimage_link',
  'before_ready_unlink','after_ready_unlink','before_preimage_parent_sync','after_preimage_parent_sync',
  'before_capture_unlink','after_capture_unlink_before_sync','before_cleanup_parent_sync','after_cleanup_parent_sync',
];
for(const boundary of restoreFaultBoundaries)test(`fresh process verifies restore obligations after ${boundary}`,t=>{
  const {f,journal}=preparedReverse(t);let reached=false;
  assert.throws(()=>restoreGuardRollbackEvidence({home:f.home,journalDirectory:journal,faultInjector(point,relative){
    if(point===boundary&&relative===GUARD_TRANSITION_PATHS[1]){reached=true;throw Error('bounded logical interruption');}
  }}),/bounded logical interruption/);
  assert.equal(reached,true,'fault must reach the intended data/namespace boundary');
  const child=`import {restoreGuardRollbackEvidence} from ${JSON.stringify(new URL('./runtime-guard.mjs',import.meta.url).href)};
  try{const result=restoreGuardRollbackEvidence(${JSON.stringify({home:f.home,journalDirectory:journal})});console.log(JSON.stringify({status:result.status}));}
  catch(error){console.log(JSON.stringify({error:error.code,reason:error.reason}));}`;
  const resumed=spawnSync(process.execPath,['--input-type=module','-'],{input:child,encoding:'utf8',timeout:10000,
    env:{HOME:f.home,PATH:process.env.PATH}});
  assert.equal(resumed.status,0,resumed.stderr);
  const result=JSON.parse(resumed.stdout);
  if(boundary==='before_ready_write'){
    assert.equal(result.error,'DEPLOY_RECOVERY_REQUIRED','an interrupted empty ready is retained for manual review');
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(journal,'before.json'))).status,'restored');
  }else{
    assert.equal(result.status,'restored');
    assert.equal(fs.readFileSync(livePath(f,GUARD_TRANSITION_PATHS[1]),'utf8'),'{"foreign":"claude"}\n');
    assert.equal(fs.readFileSync(livePath(f,GUARD_TRANSITION_PATHS[2]),'utf8'),'{"hooks":{},"foreign":"codex"}\n');
    assert.equal(fs.existsSync(livePath(f,GUARD_TRANSITION_PATHS[0])),false);
  }
  assert.equal(fs.existsSync(path.join(f.journalDirectory,'before.json')),true,'original audit/backup remains available');
});
