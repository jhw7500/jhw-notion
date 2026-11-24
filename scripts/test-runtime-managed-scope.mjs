import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

import {DeploymentError} from './runtime-safety.mjs';
import {openManagedScope, requireManagedScope} from './runtime-managed-scope.mjs';


const SERVICE_UID = 61101;
const CLIENT_UID = 61102;
const BOOTSTRAP_ID = `b-${'a'.repeat(64)}`;
const INVOCATION = `${BOOTSTRAP_ID}.i-${'b'.repeat(32)}.json`;
const scopeModule = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), 'runtime-managed-scope.mjs')).href;

function expectCode(callback, code) {
  assert.throws(callback, error => error instanceof DeploymentError && error.code === code);
}

function ownedDirectory(name, uid, mode) {
  fs.mkdirSync(name, {mode});
  fs.chmodSync(name, mode);
  fs.chownSync(name, uid, uid);
}

function fixture(t, {profileOverrides = {}, storeMode = 0o700} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-managed-scope-'));
  fs.chmodSync(root, 0o755);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repositoryRoot = path.join(root, 'repository');
  const home = path.join(root, 'home');
  const sockets = path.join(root, 'sockets');
  ownedDirectory(repositoryRoot, SERVICE_UID, 0o755);
  ownedDirectory(home, SERVICE_UID, 0o700);
  ownedDirectory(sockets, SERVICE_UID, 0o700);
  let current = repositoryRoot;
  for (const part of ['.jhw-runtime', 'v2', 'managed-invocations']) {
    current = path.join(current, part);
    ownedDirectory(current, SERVICE_UID, part === 'managed-invocations' ? storeMode : 0o700);
  }
  const profile = path.join(root, 'profile.json');
  const value = {
    version: 1,
    serviceUid: SERVICE_UID,
    clientUid: CLIENT_UID,
    repositoryRoot,
    serviceHome: home,
    socket: path.join(sockets, 'managed.sock'),
    node: process.execPath,
    ...profileOverrides,
  };
  fs.writeFileSync(profile, JSON.stringify(value), {mode: 0o644});
  fs.chmodSync(profile, 0o644);
  fs.chownSync(profile, 0, 0);
  return {root, repositoryRoot, home, store: current, profile};
}

function runAsService(profile, operation, profileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) {
  const profileFd = fs.openSync(profile, profileFlags);
  const program = String.raw`
    const fs = await import('node:fs');
    const {openManagedScope, requireManagedScope} = await import(${JSON.stringify(scopeModule)});
    const operation = JSON.parse(process.argv[1]);
    try {
      const beforeFds = fs.readdirSync('/proc/self/fd').length;
      const scope = openManagedScope({profileFd: 3});
      if (operation.repositoryRoot) requireManagedScope(scope, operation.repositoryRoot);
      let forgedCode = null;
      try { requireManagedScope(Object.freeze({...scope}), scope.repositoryRoot); }
      catch (error) { forgedCode = error.code; }
      const value = {
        repositoryRoot: scope.repositoryRoot,
        home: scope.home,
        frozen: Object.isFrozen(scope),
        records: operation.records ? scope.hasInvocationRecords() : null,
        generation: operation.bootstrapId ? scope.hasGenerationIntent(operation.bootstrapId) : null,
        forgedCode,
      };
      scope.close();
      value.profileFdOpen = fs.fstatSync(3).isFile();
      value.descriptorsReleased = fs.readdirSync('/proc/self/fd').length === beforeFds;
      try { scope.verify(); }
      catch (error) { value.closedCode = error.code; }
      process.stdout.write(JSON.stringify(value) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({error: error?.code ?? 'UNKNOWN'}) + '\n');
    }
  `;
  try {
    return spawnSync(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(operation)], {
      uid: SERVICE_UID,
      gid: SERVICE_UID,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', profileFd],
      timeout: 5000,
    });
  } finally {
    fs.closeSync(profileFd);
  }
}

test('plain objects cannot forge a managed scope capability', () => {
  const forged = Object.freeze({
    repositoryRoot: '/tmp/repository',
    home: '/tmp/home',
    verify() {},
    hasInvocationRecords() { return false; },
    hasGenerationIntent() { return false; },
    close() {},
  });
  expectCode(() => requireManagedScope(forged, forged.repositoryRoot), 'DEPLOY_MANAGED_MODE_REQUIRED');
});

test('service UID receives a frozen pinned scope for an empty protected store', {skip: process.getuid() !== 0}, t => {
  const current = fixture(t);
  const result = runAsService(current.profile, {repositoryRoot: current.repositoryRoot, records: true, bootstrapId: BOOTSTRAP_ID});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    repositoryRoot: current.repositoryRoot,
    home: current.home,
    frozen: true,
    records: false,
    generation: false,
    forgedCode: 'DEPLOY_MANAGED_MODE_REQUIRED',
    closedCode: 'DEPLOY_MANAGED_MODE_REQUIRED',
    profileFdOpen: true,
    descriptorsReleased: true,
  });
});

test('valid invocation markers are bounded to their bootstrap generation', {skip: process.getuid() !== 0}, t => {
  const current = fixture(t);
  const marker = path.join(current.store, INVOCATION);
  fs.writeFileSync(marker, '{}\n', {mode: 0o600});
  fs.chmodSync(marker, 0o600);
  fs.chownSync(marker, SERVICE_UID, SERVICE_UID);
  const result = runAsService(current.profile, {repositoryRoot: current.repositoryRoot, records: true, bootstrapId: BOOTSTRAP_ID});
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.records, true);
  assert.equal(value.generation, true);
});

test('unknown store entries fail closed as managed recovery', {skip: process.getuid() !== 0}, t => {
  const current = fixture(t);
  const unknown = path.join(current.store, 'unexpected.json');
  fs.writeFileSync(unknown, '{}\n', {mode: 0o600});
  fs.chownSync(unknown, SERVICE_UID, SERVICE_UID);
  const result = runAsService(current.profile, {records: true});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {error: 'DEPLOY_MANAGED_RECOVERY_REQUIRED'});
});

test('validly named markers with a foreign owner fail as managed recovery', {skip: process.getuid() !== 0}, t => {
  const current = fixture(t);
  const marker = path.join(current.store, INVOCATION);
  fs.writeFileSync(marker, '{}\n', {mode: 0o600});
  fs.chmodSync(marker, 0o600);
  const result = runAsService(current.profile, {records: true});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {error: 'DEPLOY_MANAGED_RECOVERY_REQUIRED'});
});

test('wrong protected-store mode fails as managed recovery', {skip: process.getuid() !== 0}, t => {
  const current = fixture(t, {storeMode: 0o755});
  const result = runAsService(current.profile, {});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {error: 'DEPLOY_MANAGED_RECOVERY_REQUIRED'});
});

test('a process outside the configured service UID cannot mint a scope', {skip: process.getuid() !== 0}, t => {
  const current = fixture(t);
  const profileFd = fs.openSync(current.profile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    expectCode(() => openManagedScope({profileFd}), 'DEPLOY_MANAGED_MODE_REQUIRED');
  } finally {
    fs.closeSync(profileFd);
  }
});

test('profile schema and inherited descriptor must both be exact and read only', {skip: process.getuid() !== 0}, t => {
  const extra = fixture(t, {profileOverrides: {unexpected: true}});
  const extraResult = runAsService(extra.profile, {});
  assert.equal(extraResult.status, 0, extraResult.stderr);
  assert.deepEqual(JSON.parse(extraResult.stdout), {error: 'DEPLOY_MANAGED_MODE_REQUIRED'});

  const writable = fixture(t);
  const writableResult = runAsService(
    writable.profile,
    {},
    fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
  );
  assert.equal(writableResult.status, 0, writableResult.stderr);
  assert.deepEqual(JSON.parse(writableResult.stdout), {error: 'DEPLOY_MANAGED_MODE_REQUIRED'});
});
