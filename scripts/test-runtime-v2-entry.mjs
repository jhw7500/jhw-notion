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

test('production v2 entry binds selected pair and bound calls bypass publication current selection', async t => {
  const f = await createRuntimeFixture(t,{productionEntry:true,credentialFdEvidence:true});
  f.write('mcp-server/.env','NOTION_API_KEY=fixture-secret\n',0o600);
  const release = await f.prepare();
  const deployLease = acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const admissionLease = acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{create:true});
  const pair = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  await entry.installRouterV2({repositoryRoot:f.root,releaseId:release.releaseId,deployLease,admissionLease});
  admissionLease.close();deployLease.close();f.seedPair(pair);
  const payload = String.raw`
const {spawnSync}=require('node:child_process');
const path=require('node:path');
(async()=>{
  const root=process.argv[1];
  const safety=await import('file://'+path.join(root,'scripts/runtime-safety.mjs'));
  const publication=safety.acquireLease(path.join(root,'.jhw-runtime/publication.lock'));
  const bound=spawnSync(path.join(root,'.jhw-runtime/bootstrap/jhw-runtime-entry'),['mcp'],{encoding:'utf8',env:process.env,timeout:6000});
  const unboundEnv={...process.env};delete unboundEnv.JHW_RUNTIME_SESSION_BINDING;
  const started=Date.now();
  const unbound=spawnSync(path.join(root,'.jhw-runtime/bootstrap/jhw-runtime-entry'),['mcp'],{encoding:'utf8',env:unboundEnv,timeout:6000});
  const elapsed=Date.now()-started;publication.close();
  process.stdout.write(JSON.stringify({bound:{status:bound.status,stdout:bound.stdout,stderr:bound.stderr},unbound:{status:unbound.status,stderr:unbound.stderr,elapsed}})+'\n');
})().catch(error=>{console.error(error);process.exit(1)});
`;
  const result = await f.run(['jhw-runtime-entry','session','--',process.execPath,'-e',payload,f.root]);
  assert.equal(result.status,0,result.stderr);
  const observed=JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(observed.bound.status,0,observed.bound.stderr);
  const boundCall=JSON.parse(observed.bound.stdout);
  assert.deepEqual(Object.fromEntries(Object.entries(boundCall.fdEvidence).map(([fd,value])=>[fd,value.role])),
    {3:'admission',6:'binding',7:'generation',8:'parent'});
  for(const value of Object.values(boundCall.fdEvidence)){assert.match(value.dev,/^-?\d+$/);assert.match(value.ino,/^-?\d+$/);}
  for(const [fd,value] of Object.entries(boundCall.fdEvidence))assert.deepEqual(boundCall.namedEvidence[fd],{dev:value.dev,ino:value.ino});
  assert.equal(boundCall.fdEvidence[3].target,path.join(f.root,'.jhw-runtime/admission.lock'));
  const credentialFd=JSON.parse(fs.readFileSync(path.join(f.root,'.credential-fd-evidence.json')));
  const credentialStat=fs.statSync(path.join(f.root,'mcp-server/.env'),{bigint:true});
  assert.deepEqual(credentialFd,{dev:String(credentialStat.dev),ino:String(credentialStat.ino),target:path.join(f.root,'mcp-server/.env')});
  assert.match(boundCall.fdEvidence[6].target,new RegExp(`^${f.root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/\\.jhw-runtime/v2/invocations/${pair.bootstrapId}/i-[a-f0-9]{32}/lease$`));
  assert.equal(boundCall.fdEvidence[7].target,path.join(f.root,`.jhw-runtime/v2/bootstraps/${pair.bootstrapId}/lease`));
  assert.match(boundCall.fdEvidence[8].target,new RegExp(`^${f.root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/\\.jhw-runtime/v2/sessions/s-[a-f0-9]{32}/lease$`));
  assert.equal(boundCall.releaseRoot,path.join(f.root,'.jhw-runtime/releases',pair.releaseId));
  assert.equal(observed.unbound.status,75);
  assert.equal(observed.unbound.stderr,'DEPLOY_MAINTENANCE\n');
  assert.ok(observed.unbound.elapsed>=450&&observed.unbound.elapsed<1000,`new root waited ${observed.unbound.elapsed}ms`);
});

test('production runtime entry returns retryCurrent when current moved after router selection', async t => {
  const f = await createRuntimeFixture(t,{productionEntry:true});
  const release = await f.prepare();
  const deployLease = acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const admissionLease = acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{create:true});
  const pair = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  const router = await entry.installRouterV2({repositoryRoot:f.root,releaseId:release.releaseId,deployLease,admissionLease});
  admissionLease.close();deployLease.close();f.seedPair(pair);
  const generation=path.join(f.root,`.jhw-runtime/v2/bootstraps/${pair.bootstrapId}`);
  const moved={...pair,releaseId:pair.releaseId.replace(/.$/,pair.releaseId.endsWith('0')?'1':'0')};
  const result=await entry.runManaged({repositoryRoot:f.root,selector:'mcp',args:[],sourceReleaseId:router.sourceReleaseId,
    safetySource:fs.readFileSync(path.join(generation,'runtime-safety.mjs')),
    storeSource:fs.readFileSync(path.join(generation,'runtime-store.mjs')),selectedPair:moved});
  assert.deepEqual(result,{retryCurrent:true});
});

test('stable router and binder share one three-attempt current retry budget', async t => {
  const f = await createRuntimeFixture(t,{retryHelper:true});
  const release = await f.prepare();
  const deployLease = acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const admissionLease = acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{create:true});
  const pair = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  await entry.installRouterV2({repositoryRoot:f.root,releaseId:release.releaseId,deployLease,admissionLease});
  admissionLease.close();deployLease.close();f.seedPair(pair);
  const result=await f.run(['jhw-runtime-entry','mcp']);
  assert.equal(result.status,75);
  assert.equal(fs.readFileSync(path.join(f.root,'.retry-count'),'utf8'),'3');
});

test('v2 wrapper descendant cannot erase its token and become an unbound current caller', async t => {
  const f=await createRuntimeFixture(t,{productionEntry:true});
  const release=await f.prepare();
  const deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const admissionLease=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{create:true});
  const pair=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  await entry.installRouterV2({repositoryRoot:f.root,releaseId:release.releaseId,deployLease,admissionLease});
  admissionLease.close();deployLease.close();f.seedPair(pair);
  const payload=String.raw`
const {spawnSync}=require('node:child_process');const path=require('node:path');
const env={...process.env};delete env.JHW_RUNTIME_SESSION_BINDING;
const result=spawnSync(path.join(process.argv[1],'.jhw-runtime/bootstrap/jhw-runtime-entry'),['mcp'],{encoding:'utf8',env,timeout:6000});
process.stdout.write(JSON.stringify({status:result.status,stderr:result.stderr})+'\n');
`;
  const wrapper=await f.run(['jhw-runtime-entry','session','--',process.execPath,'-e',payload,f.root]);
  assert.equal(wrapper.status,0,wrapper.stderr);
  assert.deepEqual(JSON.parse(wrapper.stdout),{status:75,stderr:'DEPLOY_SESSION_INVALID\n'});
});

function inspectAndReapInFreshProcess(repositoryRoot) {
  const storeUrl = new URL('./runtime-store.mjs', import.meta.url).href;
  const source = `
    import {inspectSessionBindingsV2, reapCompletedSessionBindingsV2} from ${JSON.stringify(storeUrl)};
    const repositoryRoot = process.argv[1];
    const inspect = () => inspectSessionBindingsV2({repositoryRoot})
      .map(({id, kind, live, token, manifest, lease}) => ({id, kind, live, token, manifest, lease}));
    const before = inspect();
    const reaped = reapCompletedSessionBindingsV2({repositoryRoot, dryRun: false, limit: 8});
    console.log(JSON.stringify({before, reaped, after: inspect()}));
  `;
  const processResult = spawnSync(process.execPath, ['--input-type=module', '-e', source, repositoryRoot], {
    encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(processResult.status, 0, processResult.stderr || String(processResult.error));
  return JSON.parse(processResult.stdout);
}

async function verifyRetainedLeasesAfterOwnerExit(t, workerExit) {
  const f=await createRuntimeFixture(t,{productionEntry:true,holdingMcp:true,credentialFdEvidence:true});
  f.write('mcp-server/.env','NOTION_API_KEY=fixture-secret\n',0o600);
  const releaseSummary=await f.prepare();
  const deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const admissionLease=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{create:true});
  const pair=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseSummary.releaseId,deployLease});
  await entry.installRouterV2({repositoryRoot:f.root,releaseId:releaseSummary.releaseId,deployLease,admissionLease});
  admissionLease.close();deployLease.close();f.seedPair(pair);
  const files=Object.fromEntries(['token','ready','release','attempt','attempt-result','allow-exit'].map(name=>[name,path.join(f.root,`.ipc-${name}`)]));
  fs.writeFileSync(files['allow-exit'],'');
  const payload=String.raw`
const fs=require('node:fs');const path=require('node:path');const {spawn,spawnSync}=require('node:child_process');
const [root,tokenFile,ready,release,attempt,resultFile,allowExit]=process.argv.slice(1);
fs.writeFileSync(tokenFile,process.env.JHW_RUNTIME_SESSION_BINDING);
const entry=path.join(root,'.jhw-runtime/bootstrap/jhw-runtime-entry');
const held=spawn(entry,['mcp',ready,release],{env:process.env,stdio:'inherit'});
const writeResult=(file,result)=>{
  fs.writeFileSync(file+'.tmp',JSON.stringify(result),{mode:0o600,flag:'wx'});
  fs.renameSync(file+'.tmp',file);
};
const timer=setInterval(()=>{
  if(!fs.existsSync(attempt))return;
  clearInterval(timer);
  const call=spawnSync(entry,['mcp',ready+'.new',allowExit],{env:process.env,encoding:'utf8',timeout:4000});
  writeResult(resultFile,{status:call.status,stderr:call.stderr});
},10);
held.once('close',code=>{
  clearInterval(timer);
  writeResult(release+'.result',{status:code});
  process.exit(code??1);
});
`;
  const managed=f.spawnRouter(['jhw-runtime-entry','session','--',process.execPath,'-e',payload,f.root,files.token,files.ready,files.release,files.attempt,files['attempt-result'],files['allow-exit']]);
  const waitFor=async predicate=>{const deadline=Date.now()+6000;while(!predicate()){if(Date.now()>deadline)assert.fail('fixture IPC deadline');await new Promise(resolve=>setTimeout(resolve,10));}};
  const generationLease = path.join(f.root, `.jhw-runtime/v2/bootstraps/${pair.bootstrapId}/lease`);
  let heldRoot;
  let workerStatus;
  try {
    await waitFor(() => fs.existsSync(files.token) && fs.existsSync(files.ready));
    const token = fs.readFileSync(files.token, 'utf8');
    heldRoot = token.split(':')[2];
    const manifest = path.join(f.root, '.jhw-runtime/v2/sessions', heldRoot, 'manifest.json');
    const rootRecord = JSON.parse(fs.readFileSync(manifest));
    assert.equal(rootRecord.owner.pid, managed.child.pid);
    const ready = JSON.parse(fs.readFileSync(files.ready, 'utf8'));
    assert.deepEqual(Object.fromEntries(Object.entries(ready.fdEvidence).map(([fd, value]) => [fd, value.role])),
      {3: 'admission', 6: 'binding', 7: 'generation', 8: 'parent'});
    for (const value of Object.values(ready.fdEvidence)) {
      const stat = fs.statSync(value.target, {bigint: true});
      assert.deepEqual({dev: String(stat.dev), ino: String(stat.ino)}, {dev: value.dev, ino: value.ino});
    }
    managed.child.send({type: 'exit'});
    assert.deepEqual(await managed.result, {status: 0, signal: null, stdout: '', stderr: '', error: null});
    fs.writeFileSync(files.attempt, '');
    await waitFor(() => fs.existsSync(files['attempt-result']));
    const denied = JSON.parse(fs.readFileSync(files['attempt-result'], 'utf8'));
    assert.deepEqual(denied, {status: 75, stderr: 'DEPLOY_SESSION_INVALID\n'});

    const restarted = inspectAndReapInFreshProcess(f.root);
    assert.equal(restarted.before.find(row => row.id === heldRoot)?.live, true);
    assert.equal(restarted.before.filter(row => row.kind === 'invocation' && row.live).length, 1);
    assert.deepEqual(restarted.after, restarted.before);
    assert.deepEqual(restarted.reaped.retired, []);
    assert.deepEqual(new Set(restarted.reaped.preserved), new Set(restarted.before.map(row => row.id)));
    assert.throws(() => acquireLease(generationLease), {code: 'DEPLOY_LOCK_CONTENDED'});
  } finally {
    fs.writeFileSync(files.release + '.tmp', workerExit);
    fs.renameSync(files.release + '.tmp', files.release);
    await managed.result;
    if (fs.existsSync(files.ready)) {
      await waitFor(() => fs.existsSync(files.release + '.result'));
      workerStatus = JSON.parse(fs.readFileSync(files.release + '.result', 'utf8')).status;
      await waitFor(() => {
        try {
          acquireLease(generationLease).close();
          return true;
        } catch (error) {
          if (error.code !== 'DEPLOY_LOCK_CONTENDED') throw error;
          return false;
        }
      });
    }
  }
  assert.equal(workerStatus, workerExit === 'crash' ? 137 : 0);
  const recovered = inspectAndReapInFreshProcess(f.root);
  assert.ok(recovered.reaped.retired.includes(heldRoot));
  assert.deepEqual(recovered.after, []);
  const lease = acquireLease(generationLease);
  lease.close();
}

test('managed root owner exit preserves an inherited lease through a fresh reaper', async t => {
  await verifyRetainedLeasesAfterOwnerExit(t, 'close');
});

test('a fresh reaper retires the orphan root only after the inherited worker crashes', async t => {
  await verifyRetainedLeasesAfterOwnerExit(t, 'crash');
});
