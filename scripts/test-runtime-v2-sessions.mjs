import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {acquireLease} from './runtime-safety.mjs';
import * as store from './runtime-store.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

async function prepared(t) {
  const f = await createRuntimeFixture(t);
  const release = await f.prepare();
  const deployLease = acquireLease(path.join(f.root, '.jhw-runtime/deploy.lock'));
  const pair = store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  deployLease.close();
  f.seedPair(pair);
  const admissionLease = acquireLease(path.join(f.root, '.jhw-runtime/admission.lock'), {shared:true,create:true});
  t.after(() => admissionLease.close());
  return {f,pair,admissionLease};
}

test('v2 root and invocation records preserve the selected pair and exact closed shape', async t => {
  assert.equal(typeof store.bindEntryPair, 'function');
  assert.equal(typeof store.resolveSessionBindingV2, 'function');
  assert.equal(typeof store.inspectSessionBindingsV2, 'function');
  const {f,pair,admissionLease} = await prepared(t);
  const root = store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  assert.equal(root.retryCurrent, undefined);
  const invocation = store.bindEntryPair({repositoryRoot:f.root,token:root.token,selectedPair:pair,admissionLease});
  t.after(() => { invocation.close(); root.close(); });
  assert.deepEqual(store.resolveSessionBindingV2({repositoryRoot:f.root,token:root.token}), {...pair,id:root.id,kind:'session'});
  assert.deepEqual(Object.keys(root.record).sort(), [
    'bootstrapId','compatibilityDigest','createdAt','id','kind','lease','manifest','owner',
    'parentBinding','releaseId','repository','runtimeContract','version',
  ].sort());
  assert.equal(invocation.record.parentBinding, root.token);
  assert.deepEqual(
    store.inspectSessionBindingsV2({repositoryRoot:f.root}).map(row => ({id:row.id,kind:row.kind,parentBinding:row.parentBinding})),
    [{id:root.id,kind:'session',parentBinding:null},{id:invocation.id,kind:'invocation',parentBinding:root.token}],
  );
});

test('v2 moved current asks the shared router budget to retry without publishing a root', async t => {
  const {f,pair,admissionLease} = await prepared(t);
  const moved = {...pair,releaseId:pair.releaseId.replace(/.$/, pair.releaseId.endsWith('0') ? '1' : '0')};
  const result = store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:moved,admissionLease});
  assert.deepEqual(result, {retryCurrent:true});
  assert.deepEqual(store.inspectSessionBindingsV2({repositoryRoot:f.root}), []);
});

test('v2 bound call ignores publication contention and refuses a dead root owner', async t => {
  const {f,pair,admissionLease} = await prepared(t);
  const root = store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  const publication = acquireLease(path.join(f.root,'.jhw-runtime/publication.lock'), {create:true});
  const bound = store.bindEntryPair({repositoryRoot:f.root,token:root.token,selectedPair:pair,admissionLease});
  assert.equal(bound.record.parentBinding, root.token);
  bound.close(); publication.close(); root.close();
  assert.throws(
    () => store.bindEntryPair({repositoryRoot:f.root,token:root.token,selectedPair:pair,admissionLease}),
    {code:'DEPLOY_SESSION_INVALID'},
  );
});

test('v2 child retains parent root until its last inherited fd closes', async t => {
  const {f,pair,admissionLease} = await prepared(t);
  const root = store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setTimeout(()=>{},30000)"], {
    stdio:['ignore','pipe','inherit','ignore','ignore','ignore','ignore',root.generationLease.fd,root.lease.fd],
  });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve,reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  root.close();
  const rootPath = path.join(f.root,'.jhw-runtime/v2/sessions',root.id);
  assert.equal(fs.existsSync(rootPath), true);
  assert.throws(
    () => acquireLease(path.join(f.root,`.jhw-runtime/v2/bootstraps/${pair.bootstrapId}/lease`)),
    {code:'DEPLOY_LOCK_CONTENDED'},
  );
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('close', resolve));
  const result = store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:false});
  assert.deepEqual(result.retired, [root.id]);
  assert.equal(fs.existsSync(rootPath), false);
});

test('v2 root authority rejects forged digest, PID reuse identity, and manifest inode replacement', async t => {
  await t.test('forged digest', async t => {
    const {f,pair,admissionLease}=await prepared(t);
    const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
    t.after(()=>root.close());
    const forged=root.token.slice(0,-1)+(root.token.endsWith('0')?'1':'0');
    assert.throws(()=>store.resolveSessionBindingV2({repositoryRoot:f.root,token:forged}),{code:'DEPLOY_SESSION_INVALID'});
  });
  await t.test('PID reuse identity', async t => {
    const {f,pair,admissionLease}=await prepared(t);
    const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
    t.after(()=>root.close());
    const manifest=path.join(f.root,'.jhw-runtime/v2/sessions',root.id,'manifest.json');
    const record=JSON.parse(fs.readFileSync(manifest));record.owner.startTime=String(BigInt(record.owner.startTime)+1n);
    const bytes=canonical(record)+'\n';fs.writeFileSync(manifest,bytes);
    const token=`v2:${pair.bootstrapId}:${root.id}:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.throws(()=>store.resolveSessionBindingV2({repositoryRoot:f.root,token}),{code:'DEPLOY_SESSION_INVALID'});
  });
  await t.test('manifest inode replacement', async t => {
    const {f,pair,admissionLease}=await prepared(t);
    const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
    t.after(()=>root.close());
    const manifest=path.join(f.root,'.jhw-runtime/v2/sessions',root.id,'manifest.json');
    const replacement=manifest+'.replacement';fs.writeFileSync(replacement,fs.readFileSync(manifest),{mode:0o600});fs.renameSync(replacement,manifest);
    assert.throws(()=>store.resolveSessionBindingV2({repositoryRoot:f.root,token:root.token}),{code:'DEPLOY_SESSION_INVALID'});
  });
});

test('v2 interrupted creating and retired namespaces never become public or unlocked deletes', async t => {
  const {f}=await prepared(t);
  const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');fs.mkdirSync(sessions,{recursive:true,mode:0o700});
  const creating=`.creating.s-${'1'.repeat(32)}`;
  const retired=`.retired.s-${'2'.repeat(32)}.${'3'.repeat(32)}`;
  fs.mkdirSync(path.join(sessions,creating),{mode:0o700});
  fs.mkdirSync(path.join(sessions,retired),{mode:0o700});
  fs.writeFileSync(path.join(sessions,retired,'unknown'),'',{mode:0o600});
  assert.deepEqual(store.inspectSessionBindingsV2({repositoryRoot:f.root}),[]);
  const result=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:false});
  assert.deepEqual(result.retired,[]);
  assert.deepEqual(result.preserved.sort(),[creating,retired].sort());
  assert.equal(fs.existsSync(path.join(sessions,creating)),true);
  assert.equal(fs.existsSync(path.join(sessions,retired)),true);
});

test('v2 reaper completes an interrupted private retirement only after generation and binding leases release', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');const interrupted=`.creating.${root.id}`;
  fs.renameSync(path.join(sessions,root.id),path.join(sessions,interrupted));
  root.close();
  const result=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:false});
  assert.deepEqual(result,{retired:[interrupted],preserved:[]});
  assert.equal(fs.existsSync(path.join(sessions,interrupted)),false);
});

test('v2 simultaneous descendants serialize invocation publication without rejecting the root', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  t.after(()=>root.close());
  const storeFile=fileURLToPath(new URL('./runtime-store.mjs',import.meta.url));
  const safetyFile=fileURLToPath(new URL('./runtime-safety.mjs',import.meta.url));
  const script=String.raw`
const store=await import(process.argv[1]);const safety=await import(process.argv[2]);
const root=process.argv[3];const token=process.argv[4];const pair=JSON.parse(process.argv[5]);
const admission=safety.acquireLease(root+'/.jhw-runtime/admission.lock',{shared:true});
const binding=store.bindEntryPair({repositoryRoot:root,token,selectedPair:pair,admissionLease:admission});
process.stdout.write(binding.record.parentBinding+'\n');binding.close();admission.close();
`;
  const children=Array.from({length:3},()=>spawn(process.execPath,['--input-type=module','-e',script,storeFile,safetyFile,f.root,root.token,JSON.stringify(pair)],{stdio:['ignore','pipe','pipe']}));
  const results=await Promise.all(children.map(child=>new Promise(resolve=>{let stdout='';let stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('close',status=>resolve({status,stdout,stderr}));})));
  for(const result of results){assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),root.token);}
});
