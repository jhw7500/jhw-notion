import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

import {acquireLease} from './runtime-safety.mjs';
import * as entry from './runtime-entry.mjs';
import * as store from './runtime-store.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

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
  const pending = f.run(['jhw-runtime-entry', 'mcp']);
  assert.equal(typeof pending?.then, 'function');
  const result = await pending;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {selector:'mcp',args:[],selectedPair:pair,artifact:'generation-a',home:f.home});

  const generation = path.join(f.root, `.jhw-runtime/v2/bootstraps/${pair.bootstrapId}`);
  const helper = path.join(generation, 'runtime-entry.mjs');
  fs.writeFileSync(helper, fs.readFileSync(helper, 'utf8').replace('generation-a', 'forged-generation'));
  generationManifest.files.find(record => record.name === 'runtime-entry.mjs').sha256 =
    createHash('sha256').update(fs.readFileSync(helper)).digest('hex');
  const {bootstrapId: _oldBootstrapId, ...identity} = generationManifest;
  const forgedBootstrapId = `b-${createHash('sha256').update(canonical(identity)).digest('hex')}`;
  generationManifest.bootstrapId = forgedBootstrapId;
  fs.writeFileSync(path.join(generation, 'manifest.json'), canonical(generationManifest) + '\n');
  fs.renameSync(generation, path.join(f.root, `.jhw-runtime/v2/bootstraps/${forgedBootstrapId}`));
  fs.writeFileSync(path.join(f.root, `.jhw-runtime/v2/bootstrap-catalog/${forgedBootstrapId}.json`), canonical(generationManifest) + '\n', {mode:0o600});
  f.seedPair({...pair,bootstrapId:forgedBootstrapId});
  const rejected = await f.run(['jhw-runtime-entry', 'mcp']);
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
      ? spawnSync(argv[0], argv.slice(1), {encoding:'utf8',timeout:12000,env:{...process.env,HOME:f.home}})
      : await f.run(argv);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).selector, 'control');
  }
});

test('stable hook delegates through the v2 router with private HOME', async t => {
  const {f, pair} = await installed(t);
  const snapshot = f.seedPair(pair);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'activationId','bootstrapId','compatibilityDigest','migrationId','observation',
    'predecessorActivationId','releaseId','runtimeContract','version',
  ].sort());
  assert.equal(snapshot.observation.target, `v2/activations/${snapshot.activationId}`);
  const result = await f.run(['jhw-runtime-hook','--adapter','claude','--event','PreToolUse']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.selector, 'hook');
  assert.equal(output.home, f.home);
});

test('v2 router preserves and validates prior v1 and v2 roots', async t => {
  const f = await createRuntimeFixture(t);
  const releaseA = await f.prepare();
  let deployLease = acquireLease(path.join(f.root, '.jhw-runtime/deploy.lock'));
  let admissionLease = acquireLease(path.join(f.root, '.jhw-runtime/admission.lock'), {create:true});
  await entry.installBootstrap({repositoryRoot:f.root,releaseId:releaseA.releaseId});
  const first = await entry.installRouterV2({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease,admissionLease});
  assert.equal(typeof first.previousDirectory, 'string');
  assert.equal(entry.validateRetainedBootstrap({repositoryRoot:f.root,name:first.previousDirectory}).version, 1);
  const noOp = await entry.installRouterV2({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease,admissionLease});
  assert.equal(noOp.previousDirectory, null);
  admissionLease.close(); deployLease.close(); admissionLease = deployLease = null;

  f.write('scripts/jhw-runtime-control', fs.readFileSync(path.join(f.root,'scripts/jhw-runtime-control'),'utf8') + '\n// router-b\n', 0o755);
  const releaseB = await f.prepare();
  deployLease = acquireLease(path.join(f.root, '.jhw-runtime/deploy.lock'));
  admissionLease = acquireLease(path.join(f.root, '.jhw-runtime/admission.lock'));
  t.after(() => { admissionLease?.close(); deployLease?.close(); });
  const second = await entry.installRouterV2({repositoryRoot:f.root,releaseId:releaseB.releaseId,deployLease,admissionLease});
  assert.equal(typeof second.previousDirectory, 'string');
  const retainedV2 = entry.validateRetainedBootstrap({repositoryRoot:f.root,name:second.previousDirectory});
  assert.equal(retainedV2.version, 2);
  assert.equal(retainedV2.sourceReleaseId, releaseA.releaseId);
  const repeated = await entry.installRouterV2({repositoryRoot:f.root,releaseId:releaseB.releaseId,deployLease,admissionLease});
  assert.equal(repeated.previousDirectory, null);
});

test('fixture rejects an unverified local baseline revision', async t => {
  await assert.rejects(createRuntimeFixture(t,{legacyRevision:'0'.repeat(40)}), /baseline/i);
});

test('fixture extracts a verified local baseline archive', async t => {
  const revision = spawnSync('git',['rev-parse','HEAD^'],{encoding:'utf8'}).stdout.trim();
  const expected = spawnSync('git',['show',`${revision}:scripts/runtime-entry.mjs`],{encoding:'utf8'});
  assert.equal(expected.status,0,expected.stderr);
  const f = await createRuntimeFixture(t,{legacyRevision:revision});
  assert.equal(f.baselineRevision,revision);
  assert.equal(fs.readFileSync(path.join(f.root,'scripts/runtime-entry.mjs'),'utf8'),expected.stdout);
  assert.equal(fs.lstatSync(f.home).mode & 0o777,0o700);
});

test('guardFloor variants are refused by installer and stable router source validation', async t => {
  for (const declaration of [
    {version:1,generation:2,guardFloor:0},
    {version:1,generation:2,guardFloor:2},
    {version:1,generation:2,guardFloor:'1'},
    {version:1,generation:2,guardFloor:1,unknown:true},
  ]) {
    const f = await createRuntimeFixture(t);
    const releaseA = await f.prepare();
    let deployLease = acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
    let admissionLease = acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{create:true});
    const pair = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease});
    await entry.installRouterV2({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease,admissionLease});
    f.seedPair(pair);
    admissionLease.close(); deployLease.close();

    f.write('mcp-server/src/control/runtime-compatibility.json',JSON.stringify(declaration)+'\n');
    const releaseB = await f.prepare();
    deployLease = acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
    admissionLease = acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'));
    await assert.rejects(entry.installRouterV2({repositoryRoot:f.root,releaseId:releaseB.releaseId,deployLease,admissionLease}),
      {code:'DEPLOY_BOOTSTRAP_INVALID'});
    admissionLease.close(); deployLease.close();

    const routerManifestFile = path.join(f.root,'.jhw-runtime/bootstrap/manifest.json');
    const routerManifest = JSON.parse(fs.readFileSync(routerManifestFile));
    routerManifest.sourceReleaseId = releaseB.releaseId;
    fs.writeFileSync(routerManifestFile,canonical(routerManifest)+'\n');
    const result = await f.run(['jhw-runtime-entry','mcp']);
    assert.equal(result.status,75,JSON.stringify(declaration));
    assert.equal(result.stderr,'DEPLOY_BOOTSTRAP_INVALID\n');
  }
});
