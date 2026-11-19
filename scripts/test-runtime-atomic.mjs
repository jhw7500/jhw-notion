import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import {
  DeploymentError,
  atomicRename,
  prepareAtomicRename,
} from './runtime-safety.mjs';

function identity(name) {
  const stat = fs.lstatSync(name, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function retainedDirectory(name) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const expected = identity(name);
  return {
    fd,
    verify() {
      assert.deepEqual(identity(name), expected);
      const held = fs.fstatSync(fd, { bigint: true });
      assert.equal(held.dev, expected.dev);
      assert.equal(held.ino, expected.ino);
      assert.equal(held.mode, expected.mode);
    },
    close() { fs.closeSync(fd); },
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-atomic-'));
  fs.chmodSync(root, 0o700);
  const directory = retainedDirectory(root);
  t.after(() => {
    try { directory.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory };
}

function invoke(capability, directory, sourceName, destinationName, operation) {
  return atomicRename({
    capability,
    sourceDirectory: directory,
    destinationDirectory: directory,
    sourceName,
    destinationName,
    operation,
  });
}

function withSpawnSync(replacement, callback) {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = replacement;
  syncBuiltinESMExports();
  try { return callback(); }
  finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
}

test('NOREPLACE preserves occupied empty destination and source identities', { concurrency: false }, t => {
  const { root, directory } = fixture(t);
  const capability = prepareAtomicRename({ directory });
  fs.mkdirSync(path.join(root, 'source'), 0o700);
  fs.mkdirSync(path.join(root, 'destination'), 0o700);
  const source = identity(path.join(root, 'source'));
  const destination = identity(path.join(root, 'destination'));

  assert.throws(
    () => invoke(capability, directory, 'source', 'destination', 'noreplace'),
    error => error instanceof DeploymentError &&
      error.code === 'DEPLOY_ATOMIC_DESTINATION_EXISTS' &&
      error.reason === 'destination_exists',
  );
  assert.deepEqual(identity(path.join(root, 'source')), source);
  assert.deepEqual(identity(path.join(root, 'destination')), destination);
});

test('NOREPLACE atomically moves a directory to an absent name', { concurrency: false }, t => {
  const { root, directory } = fixture(t);
  const capability = prepareAtomicRename({ directory });
  fs.mkdirSync(path.join(root, 'source'), 0o700);
  const source = identity(path.join(root, 'source'));

  invoke(capability, directory, 'source', 'destination', 'noreplace');

  assert.equal(fs.existsSync(path.join(root, 'source')), false);
  assert.deepEqual(identity(path.join(root, 'destination')), source);
});

test('EXCHANGE retains a displaced foreign symlink at the source slot', { concurrency: false }, t => {
  const { root, directory } = fixture(t);
  const capability = prepareAtomicRename({ directory });
  fs.mkdirSync(path.join(root, 'staged'), 0o700);
  fs.symlinkSync('/foreign/target', path.join(root, 'current'));
  const staged = identity(path.join(root, 'staged'));
  const displaced = identity(path.join(root, 'current'));

  invoke(capability, directory, 'staged', 'current', 'exchange');

  assert.deepEqual(identity(path.join(root, 'current')), staged);
  assert.deepEqual(identity(path.join(root, 'staged')), displaced);
  assert.equal(fs.readlinkSync(path.join(root, 'staged')), '/foreign/target');
});

test('invalid capability, directory, operation, and names fail before mutation', { concurrency: false }, t => {
  const { root, directory } = fixture(t);
  const capability = prepareAtomicRename({ directory });
  fs.mkdirSync(path.join(root, 'source'), 0o700);
  const source = identity(path.join(root, 'source'));
  const invalid = [
    { capability: {}, sourceName: 'source', destinationName: 'destination', operation: 'noreplace' },
    { capability, sourceName: '../source', destinationName: 'destination', operation: 'noreplace' },
    { capability, sourceName: 'source', destinationName: 'a/b', operation: 'noreplace' },
    { capability, sourceName: 'source', destinationName: 'destination', operation: 'rename' },
  ];
  for (const values of invalid) {
    assert.throws(() => atomicRename({
      sourceDirectory: directory,
      destinationDirectory: directory,
      ...values,
    }), error => error instanceof DeploymentError && error.code === 'DEPLOY_ATOMIC_RENAME_INVALID');
    assert.deepEqual(identity(path.join(root, 'source')), source);
    assert.equal(fs.existsSync(path.join(root, 'destination')), false);
  }

  const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-atomic-unsafe-'));
  fs.chmodSync(unsafeRoot, 0o755);
  const unsafe = retainedDirectory(unsafeRoot);
  t.after(() => { unsafe.close(); fs.rmSync(unsafeRoot, { recursive: true, force: true }); });
  assert.throws(() => prepareAtomicRename({ directory: unsafe }), error =>
    error instanceof DeploymentError && error.code === 'DEPLOY_ATOMIC_RENAME_INVALID' && error.reason === 'directory');
});

test('capability refuses a replaced preparation directory and a closed retained fd', { concurrency: false }, t => {
  const { root, directory } = fixture(t);
  const capability = prepareAtomicRename({ directory });
  fs.mkdirSync(path.join(root, 'source'), 0o700);
  const source = identity(path.join(root, 'source'));
  const replacement = `${root}.replacement`;
  fs.mkdirSync(replacement, 0o700);
  t.after(() => fs.rmSync(replacement, { recursive: true, force: true }));
  fs.renameSync(root, `${root}.old`);
  fs.renameSync(replacement, root);

  assert.throws(() => invoke(capability, directory, 'source', 'destination', 'noreplace'), error =>
    error instanceof DeploymentError && error.code === 'DEPLOY_ATOMIC_RENAME_INVALID' && error.reason === 'capability');
  assert.deepEqual(identity(path.join(`${root}.old`, 'source')), source);

  fs.renameSync(root, replacement);
  fs.renameSync(`${root}.old`, root);
  directory.close();
  assert.throws(() => invoke(capability, directory, 'source', 'destination', 'noreplace'), error =>
    error instanceof DeploymentError && error.code === 'DEPLOY_ATOMIC_RENAME_INVALID');
});

test('preparation rejects unsupported and malformed fixed-helper results', { concurrency: false }, t => {
  const { directory } = fixture(t);
  withSpawnSync(() => ({ status: 0, signal: null, stdout: '{"ok":false,"errno":38}\n', stderr: '' }), () => {
    assert.throws(() => prepareAtomicRename({ directory }), error =>
      error instanceof DeploymentError &&
      error.code === 'DEPLOY_ATOMIC_RENAME_UNSUPPORTED' &&
      error.reason === 'noreplace');
  });
  let calls = 0;
  withSpawnSync(() => ({
    status: 0,
    signal: null,
    stdout: ++calls === 1 ? '{"ok":false,"errno":17}\n' : '{"ok":false,"errno":38}\n',
    stderr: '',
  }), () => {
    assert.throws(() => prepareAtomicRename({ directory }), error =>
      error instanceof DeploymentError &&
      error.code === 'DEPLOY_ATOMIC_RENAME_UNSUPPORTED' &&
      error.reason === 'exchange');
  });
  withSpawnSync(() => ({ status: 0, signal: null, stdout: 'not-json\n', stderr: '' }), () => {
    assert.throws(() => prepareAtomicRename({ directory }), error =>
      error instanceof DeploymentError &&
      error.code === 'DEPLOY_ATOMIC_RENAME_HELPER_FAILED' &&
      error.reason === 'protocol');
  });
  withSpawnSync(() => ({ status: 0, signal: null, stdout: '{"ok":false,"helper":"exception"}\n', stderr: '' }), () => {
    assert.throws(() => prepareAtomicRename({ directory }), error =>
      error instanceof DeploymentError &&
      error.code === 'DEPLOY_ATOMIC_RENAME_HELPER_FAILED' &&
      error.reason === 'helper');
  });
});

test('probe failure retains raced foreign entries instead of deleting pathnames', { concurrency: false }, t => {
  const { root, directory } = fixture(t);
  let calls = 0;
  let racedName;
  withSpawnSync(() => {
    calls++;
    if (calls === 1) return { status: 0, signal: null, stdout: '{"ok":false,"errno":17}\n', stderr: '' };
    racedName = fs.readdirSync(root).find(name => name.startsWith('.jhw-atomic-source-'));
    fs.renameSync(path.join(root, racedName), path.join(root, '.owned-probe'));
    fs.mkdirSync(path.join(root, racedName), 0o700);
    return { status: 0, signal: null, stdout: '{"ok":true}\n', stderr: '' };
  }, () => {
    assert.throws(() => prepareAtomicRename({ directory }), DeploymentError);
  });

  assert.ok(racedName);
  assert.equal(fs.lstatSync(path.join(root, racedName)).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(root, '.owned-probe')).isDirectory(), true);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.jhw-atomic-destination-')), true);
});
