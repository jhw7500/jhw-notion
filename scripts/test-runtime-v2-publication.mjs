import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

import * as store from './runtime-store.mjs';
import {acquireLease} from './runtime-safety.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

async function prepared(t, {reuse = false} = {}) {
  const f = await createRuntimeFixture(t);
  const releaseA = await f.prepare();
  let deployLease = acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  t.after(() => deployLease?.close());
  const first = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease});
  let pair = first;
  if (reuse) {
    deployLease.close(); deployLease = null;
    f.write('mcp-server/src/index.ts','export const payload = "next";\n');
    const releaseB = await f.prepare();
    deployLease = acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
    pair = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseB.releaseId,
      reuseBootstrapId:first.bootstrapId,deployLease});
  }
  const evidence = store.prepareRuntimeEvidence({repositoryRoot:f.root,pairs:[pair]});
  t.after(() => evidence.close());
  const expectedCurrent = store.readActivation({repositoryRoot:f.root});
  const destination = store.preparePairActivation({repositoryRoot:f.root,pair,expectedCurrent,deployLease});
  return {f,pair,evidence,destination,expectedCurrent,deployLease,sourceReleaseId:releaseA.releaseId};
}

function publicationLease(root) {
  return acquireLease(path.join(root,'.jhw-runtime/publication.lock'),{create:true});
}

function invalidLease(file, kind) {
  if (kind === 'raw') {
    const fd=fs.openSync(file,fs.constants.O_RDWR);
    return {lease:{fd,close(){fs.closeSync(fd);}},cleanup() {}};
  }
  if (kind === 'shared') {
    const lease=acquireLease(file,{shared:true});
    return {lease,cleanup(){lease.close();}};
  }
  const lease=acquireLease(file);
  const fd=lease.fd;
  lease.close();
  const opened=[];
  while(!opened.includes(fd)){
    const candidate=fs.openSync(file,fs.constants.O_RDWR);
    opened.push(candidate);
    assert.ok(candidate<=fd,'fixture must be able to reuse the closed descriptor number');
  }
  return {lease,cleanup(){for(const openedFd of opened)fs.closeSync(openedFd);}};
}

test('v2 publication rejects mutation after complete validation', async t => {
  const cases = [
    ['same-size in-place edit with restored mtime', ({f,pair}) => {
      const file=path.join(f.root,`.jhw-runtime/releases/${pair.releaseId}/scripts/runtime-entry.mjs`);
      const before=fs.statSync(file,{bigint:true});
      const bytes=fs.readFileSync(file); bytes[0]^=0xff; fs.writeFileSync(file,bytes);
      fs.utimesSync(file,Number(before.atimeNs)/1e9,Number(before.mtimeNs)/1e9);
    }],
    ['inode replacement', ({f,pair}) => {
      const file=path.join(f.root,`.jhw-runtime/releases/${pair.releaseId}/mcp-server/dist/index.js`);
      const replacement=`${file}.replacement`;
      fs.writeFileSync(replacement,fs.readFileSync(file),{mode:0o644});
      fs.renameSync(replacement,file);
    }],
    ['directory replacement', ({f,pair}) => {
      const directory=path.join(f.root,`.jhw-runtime/releases/${pair.releaseId}/skills`);
      fs.renameSync(directory,`${directory}.old`);
      fs.mkdirSync(directory,{mode:0o755});
    }],
    ['symlink replacement', ({f,pair}) => {
      const link=path.join(f.root,`.jhw-runtime/releases/${pair.releaseId}/mcp-server/.env`);
      fs.unlinkSync(link); fs.symlinkSync(path.join(f.root,'mcp-server/other-env'),link);
    }],
    ['additional file', ({f,pair}) => {
      fs.writeFileSync(path.join(f.root,`.jhw-runtime/releases/${pair.releaseId}/scripts/extra`),'x',{mode:0o644});
    }],
    ['manifest replacement', ({f,pair}) => {
      const file=path.join(f.root,`.jhw-runtime/releases/${pair.releaseId}/manifest.json`);
      const replacement=`${file}.replacement`;
      fs.writeFileSync(replacement,fs.readFileSync(file),{mode:0o600});
      fs.renameSync(replacement,file);
    }],
  ];
  for (const [name,mutate] of cases) await t.test(name,async t => {
    const state=await prepared(t);
    const before=store.readActivation({repositoryRoot:state.f.root});
    mutate(state);
    assert.throws(() => store.revalidateRuntimeEvidence(state.evidence), {code:'DEPLOY_SOURCE_CHANGED'});
    const lease=publicationLease(state.f.root);
    try {
      assert.throws(() => store.publishPreparedActivation({...state,repositoryRoot:state.f.root,
        publicationLease:lease}), {code:'DEPLOY_SOURCE_CHANGED'});
    } finally { lease.close(); }
    assert.deepEqual(store.readActivation({repositoryRoot:state.f.root}),before);
  });
});

test('prepared evidence is opaque, live, repository-bound, and pair-bound', async t => {
  const state=await prepared(t);
  const other=await createRuntimeFixture(t);
  await other.prepare();
  assert.deepEqual(Object.keys(state.evidence).sort(),['close']);
  assert.throws(() => store.revalidateRuntimeEvidence({...state.evidence}), {code:'DEPLOY_SOURCE_CHANGED'});
  assert.throws(() => store.preparePairActivation({repositoryRoot:state.f.root,
    pair:{...state.pair,compatibilityDigest:'0'.repeat(64)},expectedCurrent:state.expectedCurrent,
    deployLease:state.deployLease}), {code:'DEPLOY_ACTIVATION_INVALID'});
  const lease=publicationLease(state.f.root);
  try {
    assert.throws(() => store.publishPreparedActivation({repositoryRoot:other.root,destination:state.destination,
      expectedCurrent:state.expectedCurrent,evidence:state.evidence,publicationLease:lease}),
    {code:'DEPLOY_SOURCE_CHANGED'});
    assert.throws(() => store.publishPreparedActivation({repositoryRoot:state.f.root,destination:{...state.destination},
      expectedCurrent:state.expectedCurrent,evidence:state.evidence,publicationLease:lease}),
    {code:'DEPLOY_ACTIVATION_INVALID'});
  } finally { lease.close(); }
  state.evidence.close();
  assert.throws(() => store.revalidateRuntimeEvidence(state.evidence), {code:'DEPLOY_SOURCE_CHANGED'});
});

test('reused bootstrap evidence validates its original source release', async t => {
  const state=await prepared(t,{reuse:true});
  assert.notEqual(state.sourceReleaseId,state.pair.releaseId);
  const sourceHelper=path.join(state.f.root,`.jhw-runtime/releases/${state.sourceReleaseId}/scripts/runtime-entry.mjs`);
  fs.writeFileSync(sourceHelper,Buffer.alloc(fs.statSync(sourceHelper).size,0x78));
  assert.throws(() => store.revalidateRuntimeEvidence(state.evidence), {code:'DEPLOY_SOURCE_CHANGED'});
});

test('catalog evidence rejects content, inode, and deletion changes before publication', async t => {
  for (const [name,mutate] of [
    ['content',file=>fs.writeFileSync(file,'{}\n',{mode:0o600})],
    ['inode',file=>{
      const replacement=`${file}.replacement`;
      fs.writeFileSync(replacement,fs.readFileSync(file),{mode:0o600});
      fs.renameSync(replacement,file);
    }],
    ['deletion',file=>fs.unlinkSync(file)],
  ]) await t.test(name,async t=>{
    const state=await prepared(t,{reuse:true});
    const before=store.readActivation({repositoryRoot:state.f.root});
    const catalog=path.join(state.f.root,`.jhw-runtime/v2/bootstrap-catalog/${state.pair.bootstrapId}.json`);
    mutate(catalog);
    assert.throws(()=>store.revalidateRuntimeEvidence(state.evidence),{code:'DEPLOY_SOURCE_CHANGED'});
    const lease=publicationLease(state.f.root);
    try {
      assert.throws(()=>store.publishPreparedActivation({repositoryRoot:state.f.root,
        destination:state.destination,expectedCurrent:state.expectedCurrent,evidence:state.evidence,
        publicationLease:lease}),{code:'DEPLOY_SOURCE_CHANGED'});
    } finally {lease.close();}
    assert.deepEqual(store.readActivation({repositoryRoot:state.f.root}),before);
  });
});

test('prepared APIs reject a payload and bootstrap with different helper sets', async t=>{
  const f=await createRuntimeFixture(t);
  const releaseA=await f.prepare();
  let deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  t.after(()=>deployLease?.close());
  const pairA=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease});
  deployLease.close();deployLease=null;
  f.write('scripts/runtime-entry.mjs','export const incompatible = true;\n');
  const releaseB=await f.prepare();
  deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const pairB=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseB.releaseId,deployLease});
  const mismatched={...pairB,bootstrapId:pairA.bootstrapId};
  assert.throws(()=>store.prepareRuntimeEvidence({repositoryRoot:f.root,pairs:[mismatched]}),
    {code:'DEPLOY_SOURCE_CHANGED'});
  assert.throws(()=>store.preparePairActivation({repositoryRoot:f.root,pair:mismatched,
    expectedCurrent:null,deployLease}),{code:'DEPLOY_ACTIVATION_INVALID'});
});

test('publication requires a live issued exclusive lease capability',async t=>{
  for(const kind of ['raw','shared','reused'])await t.test(kind,async t=>{
    const state=await prepared(t);
    const lock=path.join(state.f.root,'.jhw-runtime/publication.lock');
    publicationLease(state.f.root).close();
    const invalid=invalidLease(lock,kind);
    try{
      assert.throws(()=>store.publishPreparedActivation({repositoryRoot:state.f.root,
        destination:state.destination,expectedCurrent:state.expectedCurrent,evidence:state.evidence,
        publicationLease:invalid.lease}),{code:'DEPLOY_ACTIVATION_INVALID'});
    }finally{invalid.cleanup();}
    assert.deepEqual(store.readActivation({repositoryRoot:state.f.root}),state.expectedCurrent);
  });
});

test('activation preparation requires a live issued exclusive deploy lease capability',async t=>{
  for(const kind of ['raw','shared','reused'])await t.test(kind,async t=>{
    const state=await prepared(t);
    state.deployLease.close();state.deployLease=null;
    const invalid=invalidLease(path.join(state.f.root,'.jhw-runtime/deploy.lock'),kind);
    try{
      assert.throws(()=>store.preparePairActivation({repositoryRoot:state.f.root,pair:state.pair,
        expectedCurrent:state.expectedCurrent,deployLease:invalid.lease}),{code:'DEPLOY_ACTIVATION_INVALID'});
    }finally{invalid.cleanup();}
    assert.deepEqual(store.readActivation({repositoryRoot:state.f.root}),state.expectedCurrent);
  });
});

test('invalid manifest is rejected before any payload artifact opens', async t => {
  const state=await prepared(t);
  state.evidence.close();
  const manifest=path.join(state.f.root,`.jhw-runtime/releases/${state.pair.releaseId}/manifest.json`);
  fs.writeFileSync(manifest,'{}\n',{mode:0o600});
  const payload=path.join(state.f.root,`.jhw-runtime/releases/${state.pair.releaseId}/mcp-server/dist/runtime/mcp.cjs`);
  let payloadOpenedBeforeValidation=false;
  const original=fs.openSync;
  fs.openSync=function(name,...args){
    try { if(fs.realpathSync(name)===payload)payloadOpenedBeforeValidation=true; } catch {}
    return original.call(this,name,...args);
  };
  try {
    assert.throws(() => store.prepareRuntimeEvidence({repositoryRoot:state.f.root,pairs:[state.pair]}),
      {code:'DEPLOY_RELEASE_INVALID'});
  } finally { fs.openSync=original; }
  assert.equal(payloadOpenedBeforeValidation,false);
});

test('prepared activation fails closed until migration anchor support exists', async t => {
  const state=await prepared(t);
  assert.throws(() => store.preparePairActivation({repositoryRoot:state.f.root,pair:state.pair,
    expectedCurrent:state.expectedCurrent,migrationId:`m-${'1'.repeat(32)}`,deployLease:state.deployLease}),
  {code:'DEPLOY_ACTIVATION_INVALID'});
  const v1={activationId:`a-${'1'.repeat(32)}`,releaseId:state.pair.releaseId,
    predecessorActivationId:null,observation:{target:`activations/a-${'1'.repeat(32)}`,dev:'1',ino:'1',ctimeNs:'1'}};
  assert.throws(() => store.preparePairActivation({repositoryRoot:state.f.root,pair:state.pair,
    expectedCurrent:v1,deployLease:state.deployLease}),{code:'DEPLOY_ACTIVATION_INVALID'});
});

test('prepared activation publishes exact v2 destination without duplicate payload hashing', async t => {
  const state=await prepared(t,{reuse:true});
  assert.deepEqual(Object.keys(state.destination).sort(),[
    'activationId','bootstrapId','compatibilityDigest','migrationId','predecessorActivationId',
    'releaseId','runtimeContract','version',
  ]);
  const payload=path.join(state.f.root,`.jhw-runtime/releases/${state.pair.releaseId}/mcp-server/dist/runtime/mcp.cjs`);
  let payloadReads=0;
  const original=fs.readSync;
  fs.readSync=function(fd,...args){
    try { if(fs.readlinkSync(`/proc/self/fd/${fd}`)===payload)payloadReads++; } catch {}
    return original.call(this,fd,...args);
  };
  const intents=[];
  const lease=publicationLease(state.f.root);
  let snapshot;
  try {
    snapshot=store.publishPreparedActivation({repositoryRoot:state.f.root,destination:state.destination,
      expectedCurrent:state.expectedCurrent,evidence:state.evidence,publicationLease:lease,
      onPointerIntent:value=>intents.push(value)});
  } finally { fs.readSync=original; lease.close(); }
  assert.equal(payloadReads,0);
  assert.deepEqual(intents,[state.destination]);
  assert.deepEqual(snapshot,{...state.destination,observation:snapshot.observation});
  assert.deepEqual(store.readActivation({repositoryRoot:state.f.root}),snapshot);
});

test('durable pointer witness keeps object identity across delayed rename ctime change',async t=>{
  const state=await prepared(t,{reuse:true});
  const journals=path.join(state.f.root,'.jhw-runtime/v2/journals');fs.mkdirSync(journals,{recursive:true,mode:0o700});
  for(const directory of [path.join(state.f.root,'.jhw-runtime/v2'),journals])fs.chmodSync(directory,0o700);
  const journalDirectory=path.join(journals,`d-${'3'.repeat(32)}`);fs.mkdirSync(journalDirectory,{mode:0o700});
  let intent;let preRenameCtime;const lease=publicationLease(state.f.root);let snapshot;
  try{
    snapshot=store.publishPreparedActivation({repositoryRoot:state.f.root,destination:state.destination,
      expectedCurrent:state.expectedCurrent,evidence:state.evidence,publicationLease:lease,journalDirectory,
      onPointerIntent:(_destination,value)=>{intent=value;preRenameCtime=String(fs.lstatSync(path.join(journalDirectory,'pointer-witness/current'),{bigint:true}).ctimeNs);const until=Date.now()+25;while(Date.now()<until){}}});
  }finally{lease.close();}
  const linked=fs.lstatSync(path.join(journalDirectory,'pointer-witness/current'),{bigint:true});
  assert.equal(intent.witness.pointer.dev,String(linked.dev));assert.equal(intent.witness.pointer.ino,String(linked.ino));
  assert.equal(snapshot.observation.dev,intent.witness.pointer.dev);assert.equal(snapshot.observation.ino,intent.witness.pointer.ino);
  assert.notEqual(snapshot.observation.ctimeNs,preRenameCtime,'published ctime must come from the actual pointer, not a pre-rename timestamp');
});

test('publication requires prepared evidence for the exact v2 origin pair', async t => {
  const f=await createRuntimeFixture(t);
  const releaseA=await f.prepare();
  let deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  t.after(()=>deployLease?.close());
  const pairA=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease});
  const expectedCurrent=f.seedPair(pairA);
  deployLease.close();deployLease=null;
  f.write('mcp-server/src/index.ts','export const second = true;\n');
  const releaseB=await f.prepare();
  deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const pairB=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseB.releaseId,
    reuseBootstrapId:pairA.bootstrapId,deployLease});
  const evidence=store.prepareRuntimeEvidence({repositoryRoot:f.root,pairs:[pairB]});
  t.after(()=>evidence.close());
  const destination=store.preparePairActivation({repositoryRoot:f.root,pair:pairB,expectedCurrent,deployLease});
  const lease=publicationLease(f.root);
  try {
    assert.throws(()=>store.publishPreparedActivation({repositoryRoot:f.root,destination,expectedCurrent,
      evidence,publicationLease:lease}),{code:'DEPLOY_SOURCE_CHANGED'});
  } finally { lease.close(); }
  assert.deepEqual(store.readActivation({repositoryRoot:f.root}),expectedCurrent);
});

test('pointer intent must complete synchronously before current changes', async t => {
  for (const [name,onPointerIntent] of [
    ['callback failure',()=>{throw new Error('journal fsync failed');}],
    ['async callback',()=>Promise.resolve()],
  ]) await t.test(name,async t => {
    const state=await prepared(t);
    const before=store.readActivation({repositoryRoot:state.f.root});
    const lease=publicationLease(state.f.root);
    try {
      assert.throws(()=>store.publishPreparedActivation({repositoryRoot:state.f.root,
        destination:state.destination,expectedCurrent:state.expectedCurrent,evidence:state.evidence,
        publicationLease:lease,onPointerIntent}));
    } finally { lease.close(); }
    assert.deepEqual(store.readActivation({repositoryRoot:state.f.root}),before);
  });
});
