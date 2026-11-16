import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import * as store from './runtime-store.mjs';

const contracts = JSON.parse(fs.readFileSync(new URL('./__fixtures__/runtime-v2/contracts.json', import.meta.url), 'utf8'));

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
