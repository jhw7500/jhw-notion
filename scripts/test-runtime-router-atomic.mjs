import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as siblingSafety from './runtime-safety.mjs';

import {
  bootstrapObjectProof,
  installRouterV2,
  moveBootstrapObject,
  prepareRouterV2,
  validBootstrapObjectProof,
} from './runtime-entry.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function write(file, bytes, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode });
  fs.chmodSync(file, mode);
}
function makeRelease(root, marker) {
  const sourceRevision = marker.repeat(40);
  const sourceDigest = marker.repeat(64);
  const files = new Map([
    ['mcp-server/src/control/runtime-compatibility.json', Buffer.from('{"version":1,"generation":2,"guardFloor":1}\n')],
    ['scripts/jhw-runtime-control', Buffer.from(`control-${marker}\n`)],
    ['scripts/jhw-runtime-entry', Buffer.from(`entry-${marker}\n`)],
    ['scripts/jhw-runtime-hook', Buffer.from(`hook-${marker}\n`)],
  ]);
  const entries = [...files].map(([name, bytes]) => ({ path: name, type: 'file', mode: name.startsWith('scripts/') ? 0o755 : 0o644, sha256: digest(bytes) }));
  const contentDigest = digest(canonical({ sourceRevision, sourceDigest, dirty: false, entries }));
  const releaseId = `r-${sourceRevision}-${contentDigest}`;
  const release = path.join(root, '.jhw-runtime/releases', releaseId);
  fs.mkdirSync(release, { recursive: true, mode: 0o700 });
  fs.chmodSync(release, 0o700);
  for (const [name, bytes] of files) write(path.join(release, name), bytes, name.startsWith('scripts/') ? 0o755 : 0o644);
  const manifest = { version: 1, releaseId, sourceRevision, sourceDigest, contentDigest, dirty: false, createdAt: '2026-11-20T00:00:00.000Z', entries };
  write(path.join(release, 'manifest.json'), `${canonical(manifest)}\n`, 0o600);
  return releaseId;
}
function retainedDirectory(name) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const expected = fs.lstatSync(name, { bigint: true });
  return {
    fd,
    verify() {
      const held = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(name, { bigint: true });
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode']) {
        assert.equal(held[key], expected[key]);
        assert.equal(named[key], expected[key]);
      }
    },
    close() { fs.closeSync(fd); },
  };
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-router-atomic-'));
  fs.chmodSync(root, 0o700);
  const runtime = path.join(root, '.jhw-runtime');
  fs.mkdirSync(path.join(runtime, 'releases'), { recursive: true, mode: 0o700 });
  fs.chmodSync(runtime, 0o700);
  fs.chmodSync(path.join(runtime, 'releases'), 0o700);
  write(path.join(root, 'scripts/runtime-safety.mjs'), fs.readFileSync(path.join(source, 'runtime-safety.mjs')), 0o644);
  const safety = siblingSafety;
  const deployLease = safety.acquireLease(path.join(runtime, 'deploy.lock'), { create: true });
  const admissionLease = safety.acquireLease(path.join(runtime, 'admission.lock'), { create: true });
  const runtimeHandle = retainedDirectory(runtime);
  t.after(() => {
    runtimeHandle.close();
    admissionLease.close();
    deployLease.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, safety, deployLease, admissionLease, runtimeHandle };
}
function objectIdentity(name) {
  const stat = fs.lstatSync(name, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

test('prepareRouterV2 creates a proven private stage without publishing bootstrap', async t => {
  const f = await fixture(t);
  const releaseId = makeRelease(f.root, 'a');

  const prepared = await prepareRouterV2({ repositoryRoot: f.root, releaseId, deployLease: f.deployLease, admissionLease: f.admissionLease });

  assert.match(prepared.stageName, /^\.bootstrap\.stage\.[a-f0-9]{32}$/);
  assert.equal(fs.existsSync(path.join(f.runtime, 'bootstrap')), false);
  assert.deepEqual(bootstrapObjectProof({ repositoryRoot: f.root, name: prepared.stageName }), prepared.proof);
  assert.equal(prepared.manifest.sourceReleaseId, releaseId);
});

test('validBootstrapObjectProof accepts reordered closed proof keys and rejects malformed schemas', async t => {
  const f = await fixture(t);
  const releaseId = makeRelease(f.root, '9');
  const prepared = await prepareRouterV2({ repositoryRoot: f.root, releaseId, deployLease: f.deployLease, admissionLease: f.admissionLease });
  const reordered = { files: prepared.proof.files.map(file => ({ sha256: file.sha256, ...file })), directory: { ...prepared.proof.directory }, version: 1 };
  assert.deepEqual(Object.keys(reordered.directory).sort(), ['dev', 'gid', 'ino', 'mode', 'mtimeNs', 'nlink', 'size', 'uid']);
  assert.equal(validBootstrapObjectProof(reordered), true);
  assert.equal(validBootstrapObjectProof({ ...reordered, extra: true }), false);
  assert.equal(validBootstrapObjectProof({ ...reordered, directory: { ...reordered.directory, dev: 1n } }), false);
  const { gid, ...missingGid } = reordered.directory;
  assert.equal(validBootstrapObjectProof({ ...reordered, directory: missingGid }), false);
  assert.equal(validBootstrapObjectProof({ ...reordered, files: [...reordered.files, reordered.files[0]] }), false);
  assert.equal(validBootstrapObjectProof({ ...reordered, files: [{ ...reordered.files[0], sha256: 'bad' }, ...reordered.files.slice(1)] }), false);
});

test('moveBootstrapObject uses NOREPLACE and preserves an occupied foreign destination', async t => {
  const f = await fixture(t);
  const releaseId = makeRelease(f.root, 'b');
  const prepared = await prepareRouterV2({ repositoryRoot: f.root, releaseId, deployLease: f.deployLease, admissionLease: f.admissionLease });
  const capability = f.safety.prepareAtomicRename({ directory: f.runtimeHandle });
  fs.symlinkSync('/foreign/bootstrap', path.join(f.runtime, 'bootstrap'));
  const sourceBefore = objectIdentity(path.join(f.runtime, prepared.stageName));
  const destinationBefore = objectIdentity(path.join(f.runtime, 'bootstrap'));

  await assert.rejects(() => moveBootstrapObject({
    repositoryRoot: f.root,
    sourceName: prepared.stageName,
    destinationName: 'bootstrap',
    expectedProof: prepared.proof,
    runtimeHandle: f.runtimeHandle,
    capability,
    deployLease: f.deployLease,
    admissionLease: f.admissionLease,
  }), error => error.code === 'DEPLOY_ATOMIC_DESTINATION_EXISTS');

  assert.deepEqual(objectIdentity(path.join(f.runtime, prepared.stageName)), sourceBefore);
  assert.deepEqual(objectIdentity(path.join(f.runtime, 'bootstrap')), destinationBefore);
  assert.equal(fs.readlinkSync(path.join(f.runtime, 'bootstrap')), '/foreign/bootstrap');
});

test('moveBootstrapObject preserves the durable proof across an absent-name rename', async t => {
  const f = await fixture(t);
  const releaseId = makeRelease(f.root, 'c');
  const prepared = await prepareRouterV2({ repositoryRoot: f.root, releaseId, deployLease: f.deployLease, admissionLease: f.admissionLease });
  const capability = f.safety.prepareAtomicRename({ directory: f.runtimeHandle });
  const reorderedProof = { files: prepared.proof.files.map(file => ({ sha256: file.sha256, ...file })), version: 1, directory: { ...prepared.proof.directory } };

  const moved = await moveBootstrapObject({
    repositoryRoot: f.root,
    sourceName: prepared.stageName,
    destinationName: 'bootstrap',
    expectedProof: reorderedProof,
    runtimeHandle: f.runtimeHandle,
    capability,
    deployLease: f.deployLease,
    admissionLease: f.admissionLease,
  });

  assert.equal(fs.existsSync(path.join(f.runtime, prepared.stageName)), false);
  assert.deepEqual(moved, prepared.proof);
  assert.deepEqual(bootstrapObjectProof({ repositoryRoot: f.root, name: 'bootstrap' }), prepared.proof);
});

test('moveBootstrapObject rejects changed stable root metadata before mutation', async t => {
  const f = await fixture(t);
  const releaseId = makeRelease(f.root, '8');
  const prepared = await prepareRouterV2({ repositoryRoot: f.root, releaseId, deployLease: f.deployLease, admissionLease: f.admissionLease });
  const capability = f.safety.prepareAtomicRename({ directory: f.runtimeHandle });
  const changed = { ...prepared.proof, directory: { ...prepared.proof.directory, gid: String(BigInt(prepared.proof.directory.gid) + 1n) } };
  const before = objectIdentity(path.join(f.runtime, prepared.stageName));

  await assert.rejects(() => moveBootstrapObject({ repositoryRoot: f.root, sourceName: prepared.stageName, destinationName: 'bootstrap',
    expectedProof: changed, runtimeHandle: f.runtimeHandle, capability, deployLease: f.deployLease, admissionLease: f.admissionLease }),
  error => error.code === 'DEPLOY_BOOTSTRAP_CHANGED');
  assert.deepEqual(objectIdentity(path.join(f.runtime, prepared.stageName)), before);
  assert.equal(fs.existsSync(path.join(f.runtime, 'bootstrap')), false);
});

test('installRouterV2 calls intent before the first live rename and retains both objects on refusal', async t => {
  const f = await fixture(t);
  const first = makeRelease(f.root, 'd');
  const second = makeRelease(f.root, 'e');
  await installRouterV2({ repositoryRoot: f.root, releaseId: first, deployLease: f.deployLease, admissionLease: f.admissionLease });
  const liveProof = bootstrapObjectProof({ repositoryRoot: f.root, name: 'bootstrap' });
  let descriptor;

  await assert.rejects(() => installRouterV2({
    repositoryRoot: f.root,
    releaseId: second,
    deployLease: f.deployLease,
    admissionLease: f.admissionLease,
    previousDirectory: `.bootstrap.previous.${'f'.repeat(32)}`,
    onRouterIntent(value) {
      descriptor = value;
      assert.deepEqual(bootstrapObjectProof({ repositoryRoot: f.root, name: 'bootstrap' }), liveProof);
      assert.deepEqual(bootstrapObjectProof({ repositoryRoot: f.root, name: value.stageName }), value.stageProof);
      throw Object.assign(new Error('intent refused'), { code: 'DEPLOY_INTENT_REFUSED' });
    },
  }), error => error.code === 'DEPLOY_INTENT_REFUSED');

  assert.equal(descriptor.previousDirectory, `.bootstrap.previous.${'f'.repeat(32)}`);
  assert.deepEqual(descriptor.previousProof, liveProof);
  assert.deepEqual(bootstrapObjectProof({ repositoryRoot: f.root, name: 'bootstrap' }), liveProof);
  assert.equal(fs.existsSync(path.join(f.runtime, descriptor.previousDirectory)), false);
  assert.ok(fs.existsSync(path.join(f.runtime, descriptor.stageName)));
});

test('installRouterV2 publishes with NOREPLACE and retains the exact previous proof', async t => {
  const f = await fixture(t);
  const first = makeRelease(f.root, '1');
  const second = makeRelease(f.root, '2');
  await installRouterV2({ repositoryRoot: f.root, releaseId: first, deployLease: f.deployLease, admissionLease: f.admissionLease });
  const previousProof = bootstrapObjectProof({ repositoryRoot: f.root, name: 'bootstrap' });
  const previousDirectory = `.bootstrap.previous.${'3'.repeat(32)}`;
  let descriptor;

  const result = await installRouterV2({
    repositoryRoot: f.root,
    releaseId: second,
    deployLease: f.deployLease,
    admissionLease: f.admissionLease,
    previousDirectory,
    onRouterIntent(value) { descriptor = value; },
  });

  assert.equal(result.previousDirectory, previousDirectory);
  assert.deepEqual(bootstrapObjectProof({ repositoryRoot: f.root, name: previousDirectory }), previousProof);
  assert.deepEqual(bootstrapObjectProof({ repositoryRoot: f.root, name: 'bootstrap' }), descriptor.stageProof);
  assert.equal(fs.existsSync(path.join(f.runtime, descriptor.stageName)), false);
});

test('installRouterV2 reuses an identical router without leaving a private stage', async t => {
  const f = await fixture(t);
  const releaseId = makeRelease(f.root, '4');
  await installRouterV2({ repositoryRoot: f.root, releaseId, deployLease: f.deployLease, admissionLease: f.admissionLease });
  const before = bootstrapObjectProof({ repositoryRoot: f.root, name: 'bootstrap' });

  const result = await installRouterV2({ repositoryRoot: f.root, releaseId, deployLease: f.deployLease, admissionLease: f.admissionLease });

  assert.deepEqual(result, { sourceReleaseId: releaseId, routerContract: 1, previousDirectory: null });
  assert.deepEqual(bootstrapObjectProof({ repositoryRoot: f.root, name: 'bootstrap' }), before);
  assert.deepEqual(fs.readdirSync(f.runtime).filter(name => name.startsWith('.bootstrap.stage.')), []);
});
