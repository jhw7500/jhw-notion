import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import * as store from './runtime-store.mjs';
import {acquireLease} from './runtime-safety.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

const contracts = JSON.parse(fs.readFileSync(new URL('./__fixtures__/runtime-v2/contracts.json', import.meta.url), 'utf8'));

function atPath(value, field, replacement) {
  const changed = structuredClone(value);
  const parts = field.split('.');
  let target = changed;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1)] = replacement;
  return changed;
}

const wrongStrings = value => [123, true, null, [value], {}];
const wrongNullableStrings = value => wrongStrings(value).filter(candidate => candidate !== null);
const wrongIntegers = value => [String(value), true, null, [value], {}];

function write(root, name, text = 'fixture\n', mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function releaseFixture(t, generation = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-runtime-v2-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = {
    '.gitignore': '.jhw-runtime/\n',
    'mcp-server/package.json': '{"type":"module"}',
    'mcp-server/package-lock.json': '{"lockfileVersion":3}',
    'mcp-server/tsconfig.json': '{}',
    'mcp-server/tsconfig.test.json': '{}',
    'mcp-server/src/index.ts': 'export const version = 1;',
    'mcp-server/src/server.ts': 'export const server = 1;',
    'mcp-server/src/tools/read.ts': 'export const read = 1;',
    'mcp-server/src/control/runtime-compatibility.json': JSON.stringify({ version: 1, generation, guardFloor: 1 }) + '\n',
    'mcp-server/src/control/hook-adapter.ts': 'export const hook = 1;',
    'mcp-server/scripts/clean-dist.mjs': '',
    'scripts/sync-codex-skills.mjs': '',
    'scripts/runtime-entry.mjs': 'export const helper = "entry-a";',
    'scripts/runtime-safety.mjs': 'export const helper = "safety-a";',
    'scripts/runtime-store.mjs': 'export const helper = "store-a";',
    'scripts/runtime-deploy.mjs': 'export const deploy = "a";',
    'scripts/jhw-runtime-entry': '#!/bin/sh\nexit 0\n',
    'scripts/jhw-runtime-control': '#!/bin/sh\nexit 0\n',
    'scripts/jhw-runtime-hook': '#!/bin/sh\nexit 0\n',
    'skills/claude/task.md': 'fixture task',
    'skills/codex/jhw-task/SKILL.md': 'generated fixture skill',
  };
  for (const [name, text] of Object.entries(sources)) write(root, name, text, name.startsWith('scripts/jhw-runtime-') ? 0o755 : 0o644);
  fs.mkdirSync(path.join(root, 'skills/codex/jhw-task/references'), { recursive: true, mode: 0o755 });
  fs.symlinkSync('../../../claude/task.md', path.join(root, 'skills/codex/jhw-task/references/task.md'));
  write(root, 'scripts/jhw-control-hook', '#!/bin/sh\nexit 0\n', 0o755);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  let dependency = 'dependency-a';
  const build = async ({ stagingRoot }) => {
    write(stagingRoot, 'mcp-server/dist/index.js');
    write(stagingRoot, 'mcp-server/dist/control/cli.js', '#!/usr/bin/env node\n', 0o755);
    write(stagingRoot, 'mcp-server/dist/control/hook-adapter.js', '#!/usr/bin/env node\n', 0o755);
    write(stagingRoot, 'mcp-server/dist/runtime/mcp.cjs');
    write(stagingRoot, 'mcp-server/dist/runtime/control.cjs', '#!/usr/bin/env node\n', 0o755);
    write(stagingRoot, 'mcp-server/dist/runtime/hook.cjs', '#!/usr/bin/env node\n', 0o755);
    write(stagingRoot, 'mcp-server/node_modules/example/index.js', dependency);
  };
  const prepare = () => store.prepareRelease({ repositoryRoot: root, build });
  return { root, prepare, dependency(value) { dependency = value; } };
}

test('v2 contract rejects mixed snapshots and preserves v1', () => {
  const { v1, v2, runtimePair } = contracts;
  assert.equal(store.validCurrent(v1), true);
  assert.equal(store.validCurrent({ ...v1, version: 1 }), false);
  assert.equal(store.validCurrent(v2), true);
  const { migrationId: _migrationId, ...withoutMigrationId } = v2;
  assert.equal(store.validCurrent(withoutMigrationId), false);
  assert.equal(store.validCurrent({ ...v2, unexpected: true }), false);
  assert.equal(store.validCurrent({ ...v2, observation: v1.observation }), false);
  assert.equal(store.validCurrent({ ...v2, predecessorActivationId: v1.activationId }), false);
  assert.equal(store.validRuntimePair(runtimePair), true);
  assert.equal(store.validRuntimePair({ ...runtimePair, unexpected: true }), false);
});

test('v2 snapshot and pair reject every JSON scalar type mismatch without coercion', () => {
  const {v2, runtimePair} = contracts;
  for (const field of [
    'activationId', 'releaseId', 'bootstrapId', 'compatibilityDigest',
    'observation.target', 'observation.dev', 'observation.ino', 'observation.ctimeNs',
  ]) {
    for (const replacement of wrongStrings(field.split('.').reduce((value, key) => value[key], v2))) {
      assert.equal(store.validCurrent(atPath(v2, field, replacement)), false, `snapshot ${field}: ${JSON.stringify(replacement)}`);
    }
  }
  const withPredecessor = {...v2, predecessorActivationId: `a-${'9'.repeat(32)}`, migrationId: null};
  assert.equal(store.validCurrent(withPredecessor), true);
  for (const [field, value] of [['predecessorActivationId', withPredecessor.predecessorActivationId], ['migrationId', v2.migrationId]]) {
    const source = field === 'predecessorActivationId' ? withPredecessor : v2;
    for (const replacement of wrongNullableStrings(value)) {
      assert.equal(store.validCurrent({...source, [field]: replacement}), false, `snapshot ${field}: ${JSON.stringify(replacement)}`);
    }
  }
  for (const field of ['version', 'runtimeContract']) {
    for (const replacement of wrongIntegers(v2[field])) {
      assert.equal(store.validCurrent({...v2, [field]: replacement}), false, `snapshot ${field}: ${JSON.stringify(replacement)}`);
    }
  }

  for (const field of ['releaseId', 'bootstrapId', 'compatibilityDigest']) {
    for (const replacement of wrongStrings(runtimePair[field])) {
      assert.equal(store.validRuntimePair({...runtimePair, [field]: replacement}), false, `pair ${field}: ${JSON.stringify(replacement)}`);
    }
  }
  for (const replacement of wrongIntegers(runtimePair.runtimeContract)) {
    assert.equal(store.validRuntimePair({...runtimePair, runtimeContract: replacement}), false,
      `pair runtimeContract: ${JSON.stringify(replacement)}`);
  }
});

test('v2 binding records close identity fields and token relationships', () => {
  const withUid = record => ({...record, owner: {...record.owner, uid: process.getuid()}});
  const rootRecord = withUid(contracts.rootRecord);
  const invocationRecord = withUid(contracts.invocationRecord);
  assert.equal(store.validV2SessionRecord(rootRecord), true);
  assert.equal(store.validV2SessionRecord(invocationRecord), true);
  assert.equal(store.validV2SessionRecord({...invocationRecord, parentBinding: null}), true);

  for (const [label, invalid] of [
    ['session id with invocation kind', {...rootRecord, kind: 'invocation'}],
    ['invocation id with session kind', {...invocationRecord, kind: 'session', parentBinding: null}],
    ['root parent token', {...rootRecord, parentBinding: invocationRecord.parentBinding}],
    ['arbitrary parent token', {...invocationRecord, parentBinding: 'unverified'}],
    ['foreign bootstrap parent token', {...invocationRecord,
      parentBinding: invocationRecord.parentBinding.replace(contracts.v2.bootstrapId, `b-${'0'.repeat(64)}`)}],
    ['relative repository', {...rootRecord, repository: {...rootRecord.repository, path: 'relative'}}],
    ['malformed repository identity', {...rootRecord, repository: {...rootRecord.repository, dev: 'device'}}],
    ['malformed owner', {...rootRecord, owner: {...rootRecord.owner, pid: 0}}],
    ['malformed manifest identity', {...rootRecord, manifest: {...rootRecord.manifest, ino: 'inode'}}],
    ['malformed lease identity', {...rootRecord, lease: {...rootRecord.lease, fd: -1}}],
    ['unknown key', {...rootRecord, unexpected: true}],
  ]) assert.equal(store.validV2SessionRecord(invalid), false, label);
});

test('v2 binding records reject every JSON scalar type mismatch without coercion', () => {
  const rootRecord = {...contracts.rootRecord, owner: {...contracts.rootRecord.owner, uid: process.getuid()}};
  const invocationRecord = {...contracts.invocationRecord,
    owner: {...contracts.invocationRecord.owner, uid: process.getuid()}};
  for (const field of [
    'id', 'kind', 'releaseId', 'bootstrapId', 'compatibilityDigest',
    'repository.path', 'repository.dev', 'repository.ino',
    'owner.startTime', 'owner.bootId', 'owner.commandDigest', 'owner.exeDev', 'owner.exeIno',
    'manifest.dev', 'manifest.ino', 'lease.dev', 'lease.ino', 'createdAt',
  ]) {
    const original = field.split('.').reduce((value, key) => value[key], rootRecord);
    for (const replacement of wrongStrings(original)) {
      assert.equal(store.validV2SessionRecord(atPath(rootRecord, field, replacement)), false,
        `record ${field}: ${JSON.stringify(replacement)}`);
    }
  }
  for (const replacement of wrongNullableStrings(invocationRecord.parentBinding)) {
    assert.equal(store.validV2SessionRecord({...invocationRecord, parentBinding: replacement}), false,
      `record parentBinding: ${JSON.stringify(replacement)}`);
  }
  for (const field of ['version', 'runtimeContract', 'owner.uid', 'owner.pid', 'lease.fd']) {
    const original = field.split('.').reduce((value, key) => value[key], rootRecord);
    for (const replacement of wrongIntegers(original)) {
      assert.equal(store.validV2SessionRecord(atPath(rootRecord, field, replacement)), false,
        `record ${field}: ${JSON.stringify(replacement)}`);
    }
  }
});

test('v2 activation reader accepts an initial migration and rejects a v1 priorCurrent', async t => {
  const f = await releaseFixture(t);
  const release = await f.prepare();
  const activationId = contracts.v2.activationId;
  const bootstrapId = contracts.v2.bootstrapId;
  const activation = path.join(f.root, '.jhw-runtime/v2/activations', activationId);
  fs.mkdirSync(activation, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(f.root, '.jhw-runtime/v2'), 0o700);
  fs.chmodSync(path.join(f.root, '.jhw-runtime/v2/activations'), 0o700);
  for (const name of ['mcp-server', 'scripts', 'skills']) fs.symlinkSync(`../../../releases/${release.releaseId}/${name}`, path.join(activation, name));
  fs.symlinkSync(`../../bootstraps/${bootstrapId}`, path.join(activation, 'bootstrap'));
  const manifest = {
    version: 2,
    activationId,
    releaseId: release.releaseId,
    bootstrapId,
    runtimeContract: 2,
    compatibilityDigest: store.releaseCompatibility({ repositoryRoot: f.root, releaseId: release.releaseId }),
    predecessorActivationId: null,
    migrationId: contracts.v2.migrationId,
    createdAt: '2026-11-17T00:00:00.000Z',
    priorCurrent: null,
  };
  write(activation, 'manifest.json', JSON.stringify(manifest) + '\n', 0o600);
  fs.symlinkSync(`v2/activations/${activationId}`, path.join(f.root, '.jhw-runtime/current'));

  const snapshot = store.readActivation({ repositoryRoot: f.root });
  assert.deepEqual(snapshot, {
    version: 2,
    activationId,
    releaseId: release.releaseId,
    bootstrapId,
    runtimeContract: 2,
    compatibilityDigest: manifest.compatibilityDigest,
    predecessorActivationId: null,
    migrationId: contracts.v2.migrationId,
    observation: snapshot.observation,
  });
  assert.equal(snapshot.observation.target, `v2/activations/${activationId}`);
  for (const key of ['dev', 'ino', 'ctimeNs']) assert.match(snapshot.observation[key], /^\d{1,32}$/);

  for (const field of ['activationId', 'releaseId', 'bootstrapId', 'compatibilityDigest', 'createdAt']) {
    for (const replacement of wrongStrings(manifest[field])) {
      fs.writeFileSync(path.join(activation, 'manifest.json'), JSON.stringify({...manifest, [field]: replacement}) + '\n');
      assert.throws(() => store.readActivation({ repositoryRoot: f.root }), { code: 'DEPLOY_ACTIVATION_INVALID' },
        `activation ${field}: ${JSON.stringify(replacement)}`);
    }
  }
  for (const field of ['predecessorActivationId', 'migrationId']) {
    const validString = field === 'predecessorActivationId' ? `a-${'9'.repeat(32)}` : manifest.migrationId;
    for (const replacement of wrongNullableStrings(validString)) {
      fs.writeFileSync(path.join(activation, 'manifest.json'), JSON.stringify({...manifest, [field]: replacement}) + '\n');
      assert.throws(() => store.readActivation({ repositoryRoot: f.root }), { code: 'DEPLOY_ACTIVATION_INVALID' },
        `activation ${field}: ${JSON.stringify(replacement)}`);
    }
  }
  for (const field of ['version', 'runtimeContract']) {
    for (const replacement of wrongIntegers(manifest[field])) {
      fs.writeFileSync(path.join(activation, 'manifest.json'), JSON.stringify({...manifest, [field]: replacement}) + '\n');
      assert.throws(() => store.readActivation({ repositoryRoot: f.root }), { code: 'DEPLOY_ACTIVATION_INVALID' },
        `activation ${field}: ${JSON.stringify(replacement)}`);
    }
  }
  for (const replacement of [123, true, 'v2', [], {}]) {
    fs.writeFileSync(path.join(activation, 'manifest.json'), JSON.stringify({...manifest, priorCurrent: replacement}) + '\n');
    assert.throws(() => store.readActivation({ repositoryRoot: f.root }), { code: 'DEPLOY_ACTIVATION_INVALID' },
      `activation priorCurrent: ${JSON.stringify(replacement)}`);
  }
  fs.writeFileSync(path.join(activation, 'manifest.json'), JSON.stringify(manifest) + '\n');
  manifest.compatibilityDigest = '0'.repeat(64);
  fs.writeFileSync(path.join(activation, 'manifest.json'), JSON.stringify(manifest) + '\n');
  assert.throws(() => store.readActivation({ repositoryRoot: f.root }), { code: 'DEPLOY_ACTIVATION_INVALID' });
  manifest.compatibilityDigest = snapshot.compatibilityDigest;
  fs.unlinkSync(path.join(f.root, '.jhw-runtime/current'));
  manifest.priorCurrent = contracts.v1;
  manifest.predecessorActivationId = contracts.v1.activationId;
  fs.writeFileSync(path.join(activation, 'manifest.json'), JSON.stringify(manifest) + '\n');
  fs.symlinkSync(`v2/activations/${activationId}`, path.join(f.root, '.jhw-runtime/current'));
  assert.throws(() => store.readActivation({ repositoryRoot: f.root }), { code: 'DEPLOY_ACTIVATION_INVALID' });
});

test('generation 2 fingerprints flex only helper contents while generation 1 stays closed', async t => {
  const v1 = await releaseFixture(t, 1);
  const v1First = await v1.prepare();
  const v1Fingerprint = store.releaseCompatibility({ repositoryRoot: v1.root, releaseId: v1First.releaseId });
  write(v1.root, 'scripts/runtime-entry.mjs', 'export const helper = "entry-b";');
  const v1Next = await v1.prepare();
  assert.notEqual(store.releaseCompatibility({ repositoryRoot: v1.root, releaseId: v1Next.releaseId }), v1Fingerprint);

  const v2 = await releaseFixture(t, 2);
  const generation2 = await v2.prepare();
  const fingerprintGeneration2 = store.releaseCompatibility({ repositoryRoot: v2.root, releaseId: generation2.releaseId });
  write(v2.root, 'scripts/runtime-entry.mjs', 'export const helper = "entry-b";');
  write(v2.root, 'scripts/runtime-safety.mjs', 'export const helper = "safety-b";');
  write(v2.root, 'scripts/runtime-store.mjs', 'export const helper = "store-b";');
  const helpersChanged = await v2.prepare();
  assert.equal(store.releaseCompatibility({ repositoryRoot: v2.root, releaseId: helpersChanged.releaseId }), fingerprintGeneration2);
  assert.notEqual(v1Fingerprint, fingerprintGeneration2);

  for (const [label, mutate, restore] of [
    ['router', () => write(v2.root, 'scripts/jhw-runtime-entry', '#!/bin/sh\nexit 1\n', 0o755),
      () => write(v2.root, 'scripts/jhw-runtime-entry', '#!/bin/sh\nexit 0\n', 0o755)],
    ['deploy', () => write(v2.root, 'scripts/runtime-deploy.mjs', 'export const deploy = "b";'),
      () => write(v2.root, 'scripts/runtime-deploy.mjs', 'export const deploy = "a";')],
    ['dependency', () => v2.dependency('dependency-b'), () => v2.dependency('dependency-a')],
    ['mode', () => fs.chmodSync(path.join(v2.root, 'scripts/runtime-entry.mjs'), 0o600),
      () => fs.chmodSync(path.join(v2.root, 'scripts/runtime-entry.mjs'), 0o644)],
  ]) {
    mutate();
    const changed = await v2.prepare();
    assert.notEqual(store.releaseCompatibility({ repositoryRoot: v2.root, releaseId: changed.releaseId }), fingerprintGeneration2, label);
    restore();
  }
});

test('v2 generation reuse preserves catalog source', async t => {
  assert.equal(typeof store.ensureBootstrapGeneration, 'function', 'generation catalog API must exist');
  const f = await createRuntimeFixture(t);
  const releaseA = await f.prepare();
  let deployLease = acquireLease(path.join(f.root, '.jhw-runtime/deploy.lock'));
  t.after(() => deployLease?.close());
  const original = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease});
  deployLease.close(); deployLease = null;
  f.write('mcp-server/src/index.ts', 'export const next = true;\n');
  const releaseB = await f.prepare();
  deployLease = acquireLease(path.join(f.root, '.jhw-runtime/deploy.lock'));
  const reused = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseB.releaseId,reuseBootstrapId:original.bootstrapId,deployLease});
  assert.equal(reused.bootstrapId, original.bootstrapId);
  const catalogFile = path.join(f.root, `.jhw-runtime/v2/bootstrap-catalog/${original.bootstrapId}.json`);
  const catalog = JSON.parse(fs.readFileSync(catalogFile));
  assert.equal(catalog.sourceReleaseId, releaseA.releaseId);
  assert.equal(fs.lstatSync(catalogFile).mode & 0o777, 0o600);

  fs.rmSync(path.join(f.root, `.jhw-runtime/v2/bootstraps/${original.bootstrapId}`), {recursive:true});
  const restored = store.restoreBootstrapGeneration({repositoryRoot:f.root,bootstrapId:original.bootstrapId,deployLease});
  assert.equal(restored.sourceReleaseId, releaseA.releaseId);
  assert.deepEqual(restored, {bootstrapId:original.bootstrapId,sourceReleaseId:releaseA.releaseId,runtimeContract:2});
  fs.rmSync(path.join(f.root, `.jhw-runtime/releases/${releaseA.releaseId}`), {recursive:true});
  fs.rmSync(path.join(f.root, `.jhw-runtime/v2/bootstraps/${original.bootstrapId}`), {recursive:true});
  assert.throws(() => store.restoreBootstrapGeneration({repositoryRoot:f.root,bootstrapId:original.bootstrapId,deployLease}),
    {code:'DEPLOY_BOOTSTRAP_INVALID'});
});

test('v2 generation validates exact children and modes', async t => {
  assert.equal(typeof store.validateBootstrapGeneration, 'function', 'generation validation API must exist');
  const f = await createRuntimeFixture(t);
  const release = await f.prepare();
  const deployLease = acquireLease(path.join(f.root, '.jhw-runtime/deploy.lock'));
  t.after(() => deployLease.close());
  const pair = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  const validated = store.validateBootstrapGeneration({repositoryRoot:f.root,bootstrapId:pair.bootstrapId});
  assert.deepEqual([...validated.helperBytes.keys()], ['runtime-entry.mjs','runtime-safety.mjs','runtime-store.mjs']);
  const generation = path.join(f.root, `.jhw-runtime/v2/bootstraps/${pair.bootstrapId}`);
  assert.deepEqual(fs.readdirSync(generation).sort(), ['lease','manifest.json','runtime-entry.mjs','runtime-safety.mjs','runtime-store.mjs']);
  fs.chmodSync(path.join(generation, 'runtime-entry.mjs'), 0o600);
  assert.throws(() => store.validateBootstrapGeneration({repositoryRoot:f.root,bootstrapId:pair.bootstrapId}),
    {code:'DEPLOY_BOOTSTRAP_INVALID'});
});
