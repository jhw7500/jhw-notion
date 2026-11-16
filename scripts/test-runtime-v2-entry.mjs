import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

import {acquireLease} from './runtime-safety.mjs';
import * as entry from './runtime-entry.mjs';
import * as store from './runtime-store.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

async function installed(t) {
  assert.equal(typeof store.ensureBootstrapGeneration, 'function', 'generation catalog API must exist');
  assert.equal(typeof entry.installRouterV2, 'function', 'stable v2 router installer must exist');
  const f = await createRuntimeFixture(t);
  const release = await f.prepare();
  const deployLease = acquireLease(path.join(f.root, '.jhw-runtime/deploy.lock'));
  const admissionLease = acquireLease(path.join(f.root, '.jhw-runtime/admission.lock'), {create:true});
  t.after(() => { admissionLease.close(); deployLease.close(); });
  const pair = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  const router = await entry.installRouterV2({repositoryRoot:f.root,releaseId:release.releaseId,deployLease,admissionLease});
  return {f, release, pair, router};
}

test('v2 router uses descriptor bytes from one generation', async t => {
  const {f, release, pair, router} = await installed(t);
  f.seedPair(pair);
  assert.equal(router.sourceReleaseId, release.releaseId);
  const routerManifest = JSON.parse(fs.readFileSync(path.join(f.root, '.jhw-runtime/bootstrap/manifest.json')));
  const generationManifest = JSON.parse(fs.readFileSync(path.join(f.root, `.jhw-runtime/v2/bootstraps/${pair.bootstrapId}/manifest.json`)));
  assert.equal(routerManifest.files.length, 3);
  assert.equal(generationManifest.files.length, 3);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.jhw-runtime/bootstrap')).sort(),
    ['jhw-runtime-control','jhw-runtime-entry','jhw-runtime-hook','manifest.json']);
  for (const record of routerManifest.files) {
    assert.equal(fs.lstatSync(path.join(f.root, '.jhw-runtime/bootstrap', record.name)).mode & 0o777, 0o755);
  }
  const result = f.run(['jhw-runtime-entry', 'mcp']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).artifact, 'generation-a');

  const helper = path.join(f.root, `.jhw-runtime/v2/bootstraps/${pair.bootstrapId}/runtime-entry.mjs`);
  fs.writeFileSync(helper, fs.readFileSync(helper, 'utf8').replace('generation-a', 'forged-generation'));
  generationManifest.files.find(record => record.name === 'runtime-entry.mjs').sha256 =
    (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(helper)).digest('hex');
  fs.writeFileSync(path.join(f.root, `.jhw-runtime/v2/bootstraps/${pair.bootstrapId}/manifest.json`), JSON.stringify(generationManifest) + '\n');
  fs.writeFileSync(path.join(f.root, `.jhw-runtime/v2/bootstrap-catalog/${pair.bootstrapId}.json`), JSON.stringify(generationManifest) + '\n');
  const rejected = f.run(['jhw-runtime-entry', 'mcp']);
  assert.equal(rejected.status, 75);
  assert.equal(rejected.stderr, 'DEPLOY_BOOTSTRAP_INVALID\n');
});

test('stable control router works as a selector and through node', async t => {
  const {f, pair} = await installed(t);
  f.seedPair(pair);
  for (const argv of [
    ['jhw-runtime-control'],
    [process.execPath, path.join(f.root, '.jhw-runtime/bootstrap/jhw-runtime-control')],
  ]) {
    const result = argv[0] === process.execPath
      ? (await import('node:child_process')).spawnSync(argv[0], argv.slice(1), {encoding:'utf8',timeout:12000})
      : f.run(argv);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).selector, 'control');
  }
});
