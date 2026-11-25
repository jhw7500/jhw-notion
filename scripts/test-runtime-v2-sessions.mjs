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
function repeatDirectoryEntry(directory,name,count) {
  const original=fs.opendirSync;let reads=0;
  fs.opendirSync=function(location,...args){
    let target=null;try{target=fs.readlinkSync(location);}catch{}
    if(target!==directory)return original.call(this,location,...args);
    return {readSync(){reads++;return reads<=count?{name}:null;},closeSync(){}};
  };
  return {restore(){fs.opendirSync=original;},reads(){return reads;}};
}
function countReleaseFileOpens(releases,relative) {
  const original=fs.openSync;const counts=new Map(releases.map(release=>[release,0]));
  fs.openSync=function(location,...args){
    if(typeof location==='string'&&path.basename(location)===path.basename(relative)){
      const match=/^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(location);
      if(match&&match[2]===path.basename(relative)){
        try{
          const parent=fs.readlinkSync(`/proc/self/fd/${match[1]}`);
          for(const release of releases){
            if(parent===path.join(release,path.dirname(relative)))counts.set(release,counts.get(release)+1);
          }
        }catch{}
      }
    }
    return original.call(this,location,...args);
  };
  return {restore(){fs.openSync=original;},count(release){return counts.get(release);}};
}
function trackDirectoryFdPeak() {
  const originalOpen=fs.openSync;const originalClose=fs.closeSync;const live=new Set();let peak=0;
  fs.openSync=function(location,flags,...args){
    const fd=originalOpen.call(this,location,flags,...args);
    if(typeof flags==='number'&&(flags&fs.constants.O_DIRECTORY)){live.add(fd);peak=Math.max(peak,live.size);}
    return fd;
  };
  fs.closeSync=function(fd,...args){live.delete(fd);return originalClose.call(this,fd,...args);};
  return {restore(){fs.openSync=originalOpen;fs.closeSync=originalClose;},peak(){return peak;}};
}
function writePrivateEvidence({directory,name,id,kind,pair,parentBinding,template}) {
  const target=path.join(directory,name);fs.mkdirSync(target,{recursive:true,mode:0o700});fs.chmodSync(target,0o700);
  const lease=path.join(target,'lease');fs.writeFileSync(lease,'',{mode:0o600});fs.chmodSync(lease,0o600);
  const manifest=path.join(target,'manifest.json');const fd=fs.openSync(manifest,'wx',0o600);
  try{fs.fchmodSync(fd,0o600);const manifestStat=fs.fstatSync(fd,{bigint:true});const leaseStat=fs.statSync(lease,{bigint:true});
    const record={version:2,id,kind,...pair,parentBinding,repository:template.record.repository,owner:template.record.owner,
      manifest:{dev:String(manifestStat.dev),ino:String(manifestStat.ino)},
      lease:{dev:String(leaseStat.dev),ino:String(leaseStat.ino),fd:template.record.lease.fd},createdAt:template.record.createdAt};
    fs.writeFileSync(fd,canonical(record)+'\n');fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
}
function normalizeRecord(record) {
  assert.deepEqual(Object.keys(record).sort(),[
    'bootstrapId','compatibilityDigest','createdAt','id','kind','lease','manifest','owner',
    'parentBinding','releaseId','repository','runtimeContract','version',
  ].sort());
  assert.deepEqual(Object.keys(record.repository).sort(),['dev','ino','path']);
  assert.deepEqual(Object.keys(record.owner).sort(),['bootId','commandDigest','exeDev','exeIno','pid','startTime','uid']);
  assert.deepEqual(Object.keys(record.manifest).sort(),['dev','ino']);
  assert.deepEqual(Object.keys(record.lease).sort(),['dev','fd','ino']);
  assert.match(record.id,record.kind==='session'?/^s-[a-f0-9]{32}$/:/^i-[a-f0-9]{32}$/);
  assert.equal(record.parentBinding===null,record.kind==='session');
  assert.equal(typeof record.repository.path,'string');
  for(const value of [record.repository.dev,record.repository.ino,record.owner.startTime,record.owner.exeDev,
    record.owner.exeIno,record.manifest.dev,record.manifest.ino,record.lease.dev,record.lease.ino])assert.match(value,/^\d+$/);
  assert.equal(typeof record.owner.uid,'number');assert.equal(typeof record.owner.pid,'number');
  assert.match(record.owner.bootId,/^[a-f0-9-]{36}$/);assert.match(record.owner.commandDigest,/^[a-f0-9]{64}$/);
  assert.equal(typeof record.lease.fd,'number');assert.equal(new Date(record.createdAt).toISOString(),record.createdAt);
  const normalized=structuredClone(record);
  normalized.id='<id>';normalized.createdAt='<createdAt>';normalized.repository.path='<repository>';
  for(const key of ['dev','ino'])normalized.repository[key]=`<${key}>`;
  for(const key of ['pid','startTime','bootId','commandDigest','exeDev','exeIno'])normalized.owner[key]=`<${key}>`;
  for(const key of ['dev','ino'])normalized.manifest[key]=`<${key}>`;
  for(const key of ['dev','ino','fd'])normalized.lease[key]=`<${key}>`;
  return normalized;
}

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
  const rootBytes=fs.readFileSync(path.join(f.root,'.jhw-runtime/v2/sessions',root.id,'manifest.json'));
  const invocationBytes=fs.readFileSync(path.join(f.root,`.jhw-runtime/v2/invocations/${pair.bootstrapId}`,invocation.id,'manifest.json'));
  const rootDisk=JSON.parse(rootBytes);const invocationDisk=JSON.parse(invocationBytes);
  assert.equal(rootBytes.toString('utf8'),canonical(rootDisk)+'\n');
  assert.equal(invocationBytes.toString('utf8'),canonical(invocationDisk)+'\n');
  assert.equal(root.token,`v2:${pair.bootstrapId}:${root.id}:${createHash('sha256').update(rootBytes).digest('hex')}`);
  assert.equal(invocation.token,`v2:${pair.bootstrapId}:${invocation.id}:${createHash('sha256').update(invocationBytes).digest('hex')}`);
  assert.equal(root.record.lease.fd,root.lease.fd);assert.equal(invocation.record.lease.fd,invocation.lease.fd);
  assert.deepEqual(normalizeRecord(rootDisk),{version:2,id:'<id>',kind:'session',...pair,parentBinding:null,
    repository:{path:'<repository>',dev:'<dev>',ino:'<ino>'},owner:{uid:process.getuid(),pid:'<pid>',startTime:'<startTime>',bootId:'<bootId>',commandDigest:'<commandDigest>',exeDev:'<exeDev>',exeIno:'<exeIno>'},
    manifest:{dev:'<dev>',ino:'<ino>'},lease:{dev:'<dev>',ino:'<ino>',fd:'<fd>'},createdAt:'<createdAt>'});
  assert.deepEqual(normalizeRecord(invocationDisk),{version:2,id:'<id>',kind:'invocation',...pair,parentBinding:root.token,
    repository:{path:'<repository>',dev:'<dev>',ino:'<ino>'},owner:{uid:process.getuid(),pid:'<pid>',startTime:'<startTime>',bootId:'<bootId>',commandDigest:'<commandDigest>',exeDev:'<exeDev>',exeIno:'<exeIno>'},
    manifest:{dev:'<dev>',ino:'<ino>'},lease:{dev:'<dev>',ino:'<ino>',fd:'<fd>'},createdAt:'<createdAt>'});
  assert.deepEqual(
    store.inspectSessionBindingsV2({repositoryRoot:f.root}).map(row => ({id:row.id,kind:row.kind,parentBinding:row.parentBinding})),
    [{id:root.id,kind:'session',parentBinding:null},{id:invocation.id,kind:'invocation',parentBinding:root.token}],
  );
});

test('v2 bound invocation hashes each unique retained release once', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  t.after(()=>root.close());
  const release=path.join(f.root,'.jhw-runtime/releases',pair.releaseId);
  const counter=countReleaseFileOpens([release],'mcp-server/package.json');
  let invocation;
  try{invocation=store.bindEntryPair({repositoryRoot:f.root,token:root.token,selectedPair:pair,admissionLease});}
  finally{counter.restore();}
  invocation.close();
  assert.equal(counter.count(release),1);
});

test('v2 bound invocation validates distinct selected and bootstrap source releases once each', async t => {
  const {f,pair:sourcePair,admissionLease}=await prepared(t);
  f.write('mcp-server/src/control/hook-adapter.ts','export const revision = 2;\n');
  const selectedRelease=await f.prepare();
  const deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const selectedPair=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:selectedRelease.releaseId,
    reuseBootstrapId:sourcePair.bootstrapId,deployLease});
  deployLease.close();f.seedPair(selectedPair);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair,admissionLease});
  t.after(()=>root.close());
  const source=path.join(f.root,'.jhw-runtime/releases',sourcePair.releaseId);
  const selected=path.join(f.root,'.jhw-runtime/releases',selectedPair.releaseId);
  const counter=countReleaseFileOpens([source,selected],'mcp-server/package.json');
  let invocation;
  try{invocation=store.bindEntryPair({repositoryRoot:f.root,token:root.token,selectedPair,admissionLease});}
  finally{counter.restore();}
  invocation.close();
  assert.equal(counter.count(source),1);
  assert.equal(counter.count(selected),1);
});

test('v2 entry validation rejects a regular release credential before reading its bytes', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const release=path.join(f.root,'.jhw-runtime/releases',pair.releaseId);
  const credential=path.join(release,'mcp-server/.env');
  fs.unlinkSync(credential);fs.writeFileSync(credential,'fixture marker\n',{mode:0o600});
  const counter=countReleaseFileOpens([release],'mcp-server/.env');
  try{
    assert.throws(()=>store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease}),
      {code:'DEPLOY_SESSION_INVALID'});
  }finally{counter.restore();}
  assert.equal(counter.count(release),0);
});

test('v2 entry validation does not retain one directory descriptor per sibling', async t => {
  const f=await createRuntimeFixture(t);
  for(let index=0;index<256;index++)f.write(`skills/fd-${String(index).padStart(4,'0')}/item.md`,'fixture\n');
  const release=await f.prepare();
  const deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const pair=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  deployLease.close();f.seedPair(pair);
  const admissionLease=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{shared:true,create:true});
  t.after(()=>admissionLease.close());
  const tracker=trackDirectoryFdPeak();let root;
  try{root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});}
  finally{tracker.restore();}
  root.close();
  assert.ok(tracker.peak()<64,`peak directory descriptors: ${tracker.peak()}`);
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
  const {f,pair}=await prepared(t);
  const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');fs.mkdirSync(sessions,{recursive:true,mode:0o700});
  const creating=`.creating.s-${'1'.repeat(32)}`;
  const retired=`.retired.s-${'2'.repeat(32)}.${'3'.repeat(32)}`;
  const invocation=`.creating.i-${'4'.repeat(32)}`;
  const invocations=path.join(f.root,'.jhw-runtime/v2/invocations',pair.bootstrapId);
  fs.mkdirSync(path.join(sessions,creating),{mode:0o700});
  fs.mkdirSync(path.join(sessions,retired),{mode:0o700});
  fs.mkdirSync(path.join(invocations,invocation),{recursive:true,mode:0o700});
  fs.chmodSync(path.dirname(invocations),0o700);fs.chmodSync(invocations,0o700);
  fs.writeFileSync(path.join(sessions,retired,'unknown'),'',{mode:0o600});
  assert.throws(()=>store.inspectSessionBindingsV2({repositoryRoot:f.root}),{code:'DEPLOY_SESSION_INVALID'});
  const result=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:false});
  assert.deepEqual(result.retired,[]);
  assert.deepEqual(result.preserved.sort(),[creating,retired,invocation].sort());
  assert.equal(fs.existsSync(path.join(sessions,creating)),true);
  assert.equal(fs.existsSync(path.join(sessions,retired)),true);
  assert.equal(fs.existsSync(path.join(invocations,invocation)),true);
});

test('v2 reaper completes an interrupted private retirement only after generation and binding leases release', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');const interrupted=`.creating.${root.id}`;
  fs.renameSync(path.join(sessions,root.id),path.join(sessions,interrupted));
  assert.deepEqual(store.inspectSessionBindingsV2({repositoryRoot:f.root}),[]);
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

test('v2 invocation revalidates parent bytes immediately before publication', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  t.after(()=>root.close());
  const storeFile=fileURLToPath(new URL('./runtime-store.mjs',import.meta.url));
  const safetyFile=fileURLToPath(new URL('./runtime-safety.mjs',import.meta.url));
  const indexDirectory=path.join(f.root,'.jhw-runtime/v2/invocation-index');fs.mkdirSync(indexDirectory,{recursive:true,mode:0o700});
  const index=acquireLease(path.join(indexDirectory,`${pair.bootstrapId}.lock`),{create:true});
  const childScript=String.raw`
const wait=Atomics.wait;let observed=false;Atomics.wait=function(){if(!observed){observed=true;process.stdout.write('index-wait\n')}return wait.apply(this,arguments)};
const store=await import(process.argv[1]);const safety=await import(process.argv[2]);
const admission=safety.acquireLease(process.argv[3]+'/.jhw-runtime/admission.lock',{shared:true});
try{const binding=store.bindEntryPair({repositoryRoot:process.argv[3],token:process.argv[4],selectedPair:JSON.parse(process.argv[5]),admissionLease:admission});process.stdout.write(JSON.stringify({ok:true,id:binding.id})+'\n');}
catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code})+'\n');}
`;
  const child=spawn(process.execPath,['--input-type=module','-e',childScript,storeFile,safetyFile,f.root,root.token,JSON.stringify(pair)],{stdio:['ignore','pipe','pipe']});
  let stdout='';let stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  while(!stdout.includes('index-wait\n'))await new Promise(resolve=>setTimeout(resolve,5));
  const manifest=path.join(f.root,'.jhw-runtime/v2/sessions',root.id,'manifest.json');
  const record=JSON.parse(fs.readFileSync(manifest));record.owner.startTime=String(BigInt(record.owner.startTime)+1n);
  fs.writeFileSync(manifest,canonical(record)+'\n');index.close();
  const status=await new Promise(resolve=>child.once('close',resolve));
  assert.equal(status,0,stderr);
  const result=JSON.parse(stdout.trim().split('\n').at(-1));
  assert.deepEqual(result,{ok:false,code:'DEPLOY_SESSION_INVALID'});
});

test('v2 invocation revalidates full release evidence after index contention', async t => {
  const f=await createRuntimeFixture(t);
  f.write('skills/index-probe/unrelated.md','fixture\n');
  const release=await f.prepare();
  const deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const pair=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  deployLease.close();f.seedPair(pair);
  const admissionLease=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{shared:true,create:true});
  t.after(()=>admissionLease.close());
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  t.after(()=>root.close());
  const storeFile=fileURLToPath(new URL('./runtime-store.mjs',import.meta.url));
  const safetyFile=fileURLToPath(new URL('./runtime-safety.mjs',import.meta.url));
  const indexDirectory=path.join(f.root,'.jhw-runtime/v2/invocation-index');fs.mkdirSync(indexDirectory,{recursive:true,mode:0o700});
  const index=acquireLease(path.join(indexDirectory,`${pair.bootstrapId}.lock`),{create:true});
  const childScript=String.raw`
const wait=Atomics.wait;let observed=false;Atomics.wait=function(){if(!observed){observed=true;process.stdout.write('index-wait\n')}return wait.apply(this,arguments)};
const store=await import(process.argv[1]);const safety=await import(process.argv[2]);
const admission=safety.acquireLease(process.argv[3]+'/.jhw-runtime/admission.lock',{shared:true});
try{const binding=store.bindEntryPair({repositoryRoot:process.argv[3],token:process.argv[4],selectedPair:JSON.parse(process.argv[5]),admissionLease:admission});process.stdout.write(JSON.stringify({ok:true,id:binding.id})+'\n');}
catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code})+'\n');}
`;
  const child=spawn(process.execPath,['--input-type=module','-e',childScript,storeFile,safetyFile,f.root,root.token,JSON.stringify(pair)],{stdio:['ignore','pipe','pipe']});
  let stdout='';let stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  while(!stdout.includes('index-wait\n'))await new Promise(resolve=>setTimeout(resolve,5));
  const selected=path.join(f.root,'.jhw-runtime/releases',pair.releaseId,'skills/index-probe/unrelated.md');
  const changed=fs.readFileSync(selected);changed[0]^=1;fs.writeFileSync(selected,changed);index.close();
  const status=await new Promise(resolve=>child.once('close',resolve));
  assert.equal(status,0,stderr);
  const result=JSON.parse(stdout.trim().split('\n').at(-1));
  assert.deepEqual(result,{ok:false,code:'DEPLOY_SESSION_INVALID'});
  const invocations=path.join(f.root,'.jhw-runtime/v2/invocations',pair.bootstrapId);
  assert.deepEqual(fs.existsSync(invocations)?fs.readdirSync(invocations).filter(name=>name.startsWith('.creating.')):[],[]);
});

test('v2 invocation never walks a release while holding its index', async t => {
  const f=await createRuntimeFixture(t);
  f.write('skills/index-probe/unrelated.md','fixture\n');
  const release=await f.prepare();
  const deployLease=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const pair=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease});
  deployLease.close();f.seedPair(pair);
  const admissionLease=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{shared:true,create:true});
  t.after(()=>admissionLease.close());
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  t.after(()=>root.close());
  const storeFile=fileURLToPath(new URL('./runtime-store.mjs',import.meta.url));
  const safetyFile=fileURLToPath(new URL('./runtime-safety.mjs',import.meta.url));
  const indexFile=path.join(f.root,'.jhw-runtime/v2/invocation-index',`${pair.bootstrapId}.lock`);
  fs.mkdirSync(path.dirname(indexFile),{recursive:true,mode:0o700});
  const index=acquireLease(indexFile,{create:true});
  const childScript=String.raw`
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
let waited=false,probed=false,packageOpens=0;const originalLstat=fs.lstatSync,originalOpen=fs.openSync;
fs.openSync=function(location,...args){if(path.basename(String(location))==='package.json')packageOpens++;return originalOpen.call(this,location,...args)};
fs.lstatSync=function(location,...args){
  if(waited&&!probed&&String(location).endsWith('/unrelated.md')){
    probed=true;
    const probe=spawnSync(process.execPath,['--input-type=module','-e',
      "const safety=await import(process.argv[1]);try{safety.acquireLease(process.argv[2]).close();process.stdout.write('free')}catch(error){process.stdout.write(error.code==='DEPLOY_LOCK_CONTENDED'?'held':'error')}",
      process.argv[2],process.argv[6]],{encoding:'utf8'});
    process.stdout.write('release-walk-index='+probe.stdout+'\n');
  }
  return originalLstat.call(this,location,...args);
};
const wait=Atomics.wait;Atomics.wait=function(){if(!waited){waited=true;process.stdout.write('index-wait\n')}return wait.apply(this,arguments)};
const store=await import(process.argv[1]);const safety=await import(process.argv[2]);
const admission=safety.acquireLease(process.argv[3]+'/.jhw-runtime/admission.lock',{shared:true});
try{const binding=store.bindEntryPair({repositoryRoot:process.argv[3],token:process.argv[4],selectedPair:JSON.parse(process.argv[5]),admissionLease:admission});binding.close();process.stdout.write(JSON.stringify({ok:true,packageOpens})+'\n');}
catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code})+'\n');}
`;
  const child=spawn(process.execPath,['--input-type=module','-e',childScript,storeFile,safetyFile,f.root,root.token,JSON.stringify(pair),indexFile],{stdio:['ignore','pipe','pipe']});
  let stdout='';let stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  while(!stdout.includes('index-wait\n'))await new Promise(resolve=>setTimeout(resolve,5));
  index.close();
  const status=await new Promise(resolve=>child.once('close',resolve));
  assert.equal(status,0,stderr);
  assert.match(stdout,/release-walk-index=free\n/);
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)),{ok:true,packageOpens:1});
});

test('v2 bounded publication check removes private staging on anchor change', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  t.after(()=>root.close());
  const selected=path.join(f.root,'.jhw-runtime/releases',pair.releaseId,'mcp-server/package.json');
  const originalFsync=fs.fsyncSync;let changed=false;
  fs.fsyncSync=function(fd,...args){
    if(!changed){
      let target='';try{target=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}
      if(path.basename(target).startsWith('.creating.i-')){
        const bytes=fs.readFileSync(selected);bytes[0]^=1;fs.writeFileSync(selected,bytes);changed=true;
      }
    }
    return originalFsync.call(this,fd,...args);
  };
  try{
    assert.throws(()=>store.bindEntryPair({repositoryRoot:f.root,token:root.token,selectedPair:pair,admissionLease}),
      {code:'DEPLOY_SESSION_INVALID'});
  }finally{fs.fsyncSync=originalFsync;}
  assert.equal(changed,true);
  const invocations=path.join(f.root,'.jhw-runtime/v2/invocations',pair.bootstrapId);
  assert.deepEqual(fs.readdirSync(invocations).filter(name=>name.startsWith('.creating.')),[]);
});

test('v2 private reaper preserves byte-identical manifest inode replacement', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});
  const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');const privateName=`.retired.${root.id}.${'4'.repeat(32)}`;
  fs.renameSync(path.join(sessions,root.id),path.join(sessions,privateName));root.close();
  const manifest=path.join(sessions,privateName,'manifest.json');const replacement=manifest+'.new';
  fs.writeFileSync(replacement,fs.readFileSync(manifest),{mode:0o600});fs.renameSync(replacement,manifest);
  const result=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:false});
  assert.deepEqual(result,{retired:[],preserved:[privateName]});
  assert.equal(fs.existsSync(path.join(sessions,privateName)),true);
});

test('v2 inventory fails closed on unknown namespace entries', async t => {
  const {f}=await prepared(t);const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');
  fs.mkdirSync(sessions,{recursive:true,mode:0o700});fs.mkdirSync(path.join(sessions,'unknown-consumer'),{mode:0o700});
  assert.throws(()=>store.inspectSessionBindingsV2({repositoryRoot:f.root}),{code:'DEPLOY_SESSION_INVALID'});
  assert.throws(()=>store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:false}),{code:'DEPLOY_SESSION_INVALID'});
});

test('v2 inventory and reaper reject non-directory or wrong-kind private entries', async t => {
  for(const variant of ['file','symlink','mode','kind'])await t.test(variant,async t=>{
    const {f,pair}=await prepared(t);const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');
    fs.mkdirSync(sessions,{recursive:true,mode:0o700});
    const name=variant==='kind'?`.creating.i-${'1'.repeat(32)}`:`.creating.s-${'1'.repeat(32)}`;
    const target=path.join(sessions,name);
    if(variant==='file')fs.writeFileSync(target,'',{mode:0o600});
    else if(variant==='symlink')fs.symlinkSync(path.join(f.root,`.jhw-runtime/v2/bootstraps/${pair.bootstrapId}`),target);
    else {fs.mkdirSync(target,{mode:variant==='mode'?0o755:0o700});if(variant==='mode')fs.chmodSync(target,0o755);}
    assert.throws(()=>store.inspectSessionBindingsV2({repositoryRoot:f.root}),{code:'DEPLOY_SESSION_INVALID'});
    assert.throws(()=>store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:false,limit:1}),{code:'DEPLOY_SESSION_INVALID'});
  });
});

test('v2 inventory applies SESSION_LIMIT per namespace and reaper has a separate candidate budget', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const roots=[
    store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease}),
    store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease}),
  ];
  t.after(()=>roots.forEach(root=>root.close()));
  const group=path.join(f.root,'.jhw-runtime/v2/invocations',pair.bootstrapId);fs.mkdirSync(group,{recursive:true,mode:0o700});
  for(let index=0;index<1023;index++){
    const id=`i-${index.toString(16).padStart(32,'0')}`;
    writePrivateEvidence({directory:group,name:`.creating.${id}`,id,kind:'invocation',pair,
      parentBinding:roots[0].token,template:roots[0]});
  }
  const rows=store.inspectSessionBindingsV2({repositoryRoot:f.root});
  assert.equal(rows.filter(row=>row.kind==='session').length,2);
  const result=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:true,limit:1});
  assert.equal(result.retired.length+result.preserved.length,1);
});

test('v2 reaper remains bounded when one namespace exceeds registration capacity', async t => {
  const {f}=await prepared(t);const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');
  fs.mkdirSync(sessions,{recursive:true,mode:0o700});
  for(let index=0;index<1025;index++)fs.mkdirSync(path.join(sessions,`.creating.s-${index.toString(16).padStart(32,'0')}`),{mode:0o700});
  const result=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:true,limit:1});
  assert.equal(result.retired.length+result.preserved.length,1);
});

test('v2 scan and time budgets cannot masquerade as a complete inventory', async t => {
  await t.test('authoritative inventory fails when the 65536-entry scan budget is exhausted',async t=>{
    const {f,pair}=await prepared(t);const invocations=path.join(f.root,'.jhw-runtime/v2/invocations');
    fs.mkdirSync(path.join(invocations,pair.bootstrapId),{recursive:true,mode:0o700});
    fs.chmodSync(invocations,0o700);const repeated=repeatDirectoryEntry(invocations,pair.bootstrapId,65537);
    try{assert.throws(()=>store.inspectSessionBindingsV2({repositoryRoot:f.root}),{code:'DEPLOY_SESSION_INVALID'});}
    finally{repeated.restore();}
    assert.equal(repeated.reads(),65537);
  });

  await t.test('reaper scan exhaustion returns only processed candidates and preserves unprocessed evidence',async t=>{
    const {f}=await prepared(t);const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');
    fs.mkdirSync(sessions,{recursive:true,mode:0o700});const name=`.creating.s-${'2'.repeat(32)}`;
    fs.mkdirSync(path.join(sessions,name),{mode:0o700});const repeated=repeatDirectoryEntry(sessions,name,65537);
    const clock=process.hrtime.bigint;process.hrtime.bigint=()=>0n;
    let result;try{result=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:true,limit:1});}
    finally{process.hrtime.bigint=clock;repeated.restore();}
    assert.deepEqual(result,{retired:[],preserved:[name]});assert.equal(repeated.reads(),65537);
    assert.equal(fs.existsSync(path.join(sessions,name)),true);
  });

  await t.test('reaper time exhaustion prevents the next candidate from starting',async t=>{
    const {f}=await prepared(t);const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');
    fs.mkdirSync(sessions,{recursive:true,mode:0o700});
    const names=['3','4'].map(digit=>`.creating.s-${digit.repeat(32)}`);
    for(const name of names)fs.mkdirSync(path.join(sessions,name),{mode:0o700});
    const clock=process.hrtime.bigint;let calls=0;
    process.hrtime.bigint=()=>++calls<7?0n:2_000_000_000n;
    let result;try{result=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:true,limit:2});}
    finally{process.hrtime.bigint=clock;}
    assert.equal(result.retired.length+result.preserved.length,1);
    assert.ok(names.includes(result.preserved[0]));
    assert.equal(names.filter(name=>!result.preserved.includes(name)).length,1);
    for(const name of names)assert.equal(fs.existsSync(path.join(sessions,name)),true);
  });
});

test('v2 invocation index wait succeeds below and fails at the 500ms boundary', async t => {
  const {f,pair,admissionLease}=await prepared(t);
  const root=store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease});t.after(()=>root.close());
  const directory=path.join(f.root,'.jhw-runtime/v2/invocation-index');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  acquireLease(path.join(directory,`${pair.bootstrapId}.lock`),{create:true}).close();
  const safetyFile=fileURLToPath(new URL('./runtime-safety.mjs',import.meta.url));
  const holderScript=String.raw`const safety=await import(process.argv[1]);const lock=safety.acquireLease(process.argv[2]);process.stdout.write('ready\n');setTimeout(()=>lock.close(),100);`;
  const holder=spawn(process.execPath,['--input-type=module','-e',holderScript,safetyFile,path.join(directory,`${pair.bootstrapId}.lock`)],{stdio:['ignore','pipe','pipe']});
  const holderClosed=new Promise(resolve=>holder.once('close',resolve));
  await new Promise((resolve,reject)=>{holder.stdout.once('data',resolve);holder.once('error',reject)});
  const shortStarted=Date.now();const binding=store.bindEntryPair({repositoryRoot:f.root,token:root.token,selectedPair:pair,admissionLease});
  const shortElapsed=Date.now()-shortStarted;binding.close();
  assert.ok(shortElapsed>=50&&shortElapsed<500,`short index wait ${shortElapsed}ms`);
  await holderClosed;
  const lock=acquireLease(path.join(directory,`${pair.bootstrapId}.lock`),{create:true});
  const started=Date.now();
  assert.throws(()=>store.bindEntryPair({repositoryRoot:f.root,token:root.token,selectedPair:pair,admissionLease}),{code:'DEPLOY_SESSION_INVALID'});
  const elapsed=Date.now()-started;lock.close();
  assert.ok(elapsed>=450&&elapsed<1000,`index wait ${elapsed}ms`);
});

test('v2 concurrent roots publish complete records and reaper limit bounds probes', async t => {
  const {f,pair}=await prepared(t);const storeFile=fileURLToPath(new URL('./runtime-store.mjs',import.meta.url));
  const safetyFile=fileURLToPath(new URL('./runtime-safety.mjs',import.meta.url));const release=path.join(f.root,'.roots-release');
  const script=String.raw`
import fs from 'node:fs';const store=await import(process.argv[1]);const safety=await import(process.argv[2]);
const admission=safety.acquireLease(process.argv[3]+'/.jhw-runtime/admission.lock',{shared:true});
const binding=store.bindEntryPair({repositoryRoot:process.argv[3],kind:'session',selectedPair:JSON.parse(process.argv[4]),admissionLease:admission});
process.stdout.write(binding.token+'\n');const timer=setInterval(()=>{if(fs.existsSync(process.argv[5])){clearInterval(timer);binding.close();admission.close();}},10);
`;
  const children=Array.from({length:3},()=>spawn(process.execPath,['--input-type=module','-e',script,storeFile,safetyFile,f.root,JSON.stringify(pair),release],{stdio:['ignore','pipe','pipe']}));
  const outputs=children.map(child=>({child,stdout:'',stderr:'',closed:new Promise(resolve=>child.once('close',resolve))}));for(const item of outputs){item.child.stdout.on('data',b=>item.stdout+=b);item.child.stderr.on('data',b=>item.stderr+=b);}
  const deadline=Date.now()+5000;while(outputs.some(item=>!item.stdout.includes('\n'))){if(Date.now()>deadline)assert.fail('concurrent roots deadline');await new Promise(resolve=>setTimeout(resolve,10));}
  const rows=store.inspectSessionBindingsV2({repositoryRoot:f.root});assert.equal(rows.filter(row=>row.kind==='session').length,3);
  const preview=store.reapCompletedSessionBindingsV2({repositoryRoot:f.root,dryRun:true,limit:2});
  assert.equal(preview.retired.length+preview.preserved.length,2);
  fs.writeFileSync(release,'');
  for(const item of outputs){const status=await item.closed;assert.equal(status,0,item.stderr);}
});

test('v2 registration preserves the existing SESSION_LIMIT bound', async t => {
  const {f,pair,admissionLease}=await prepared(t);const sessions=path.join(f.root,'.jhw-runtime/v2/sessions');fs.mkdirSync(sessions,{recursive:true,mode:0o700});
  for(let index=0;index<1024;index++)fs.mkdirSync(path.join(sessions,`.creating.s-${index.toString(16).padStart(32,'0')}`),{mode:0o700});
  assert.throws(()=>store.bindEntryPair({repositoryRoot:f.root,kind:'session',selectedPair:pair,admissionLease}),{code:'DEPLOY_SESSION_INVALID'});
});
