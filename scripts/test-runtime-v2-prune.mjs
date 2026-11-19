import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

import {acquireLease} from './runtime-safety.mjs';
import {applyRuntimePrune,collectBootstrapRoots,planRuntimePrune,recordDeploymentRetention} from './runtime-prune.mjs';
import {runDeployment,wiringPhase} from './runtime-deploy.mjs';
import {readActivation} from './runtime-store.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

const DAY=24*60*60*1000;
let replacementSequence=0;
const writeJson=(file,value)=>{fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});fs.chmodSync(file,0o600);};

function addRecentCompatibleJournals(root,count=32) {
  const runtime=path.join(root,'.jhw-runtime');
  const previous={activationId:'a-'+'1'.repeat(32),releaseId:'r-'+'1'.repeat(40)+'-'+'2'.repeat(64),predecessorActivationId:null,observation:{target:'activations/a-'+'1'.repeat(32),dev:'1',ino:'2',ctimeNs:'3'}};
  const releaseId='r-'+'3'.repeat(40)+'-'+'4'.repeat(64);
  for(let index=0;index<count;index++){
    const name=`.deploy.${(index+1).toString(16).padStart(32,'0')}`,directory=path.join(runtime,name),activationId=`a-${(index+2).toString(16).padStart(32,'0')}`;
    fs.mkdirSync(directory,{mode:0o700});
    writeJson(path.join(directory,'state.json'),{version:1,status:'complete',operation:'activate',compatible:true,candidateReleaseId:releaseId,compatibilityDigest:'5'.repeat(64),phase:'complete',previous,variables:{},mutationStarted:true,destination:{activationId,releaseId,predecessorActivationId:previous.activationId},current:{activationId,releaseId,predecessorActivationId:previous.activationId,observation:{target:`activations/${activationId}`,dev:'7',ino:String(index+10),ctimeNs:'9'}}});
    fs.writeFileSync(path.join(directory,'candidate-probe.log'),'ok\n',{mode:0o600});
    recordDeploymentRetention({repositoryRoot:root,journalDirectory:directory,completedAt:new Date(Date.now()-index*1000).toISOString()});
  }
}

function ageReceipt(journal,ageDays,offset=0) {
  const file=path.join(journal,'retention.json'),receipt=JSON.parse(fs.readFileSync(file));
  receipt.completedAt=new Date(Date.now()-ageDays*DAY+offset).toISOString();writeJson(file,receipt);
}

function hostContract(home) {
  const contract={commands:['unlock','preflight','portfolio status','task start','task child-start','task contract','task completion-ready','task promote','task status','task handoff','task finish','task recover','task assert-owner','board status','board acquire','board with'],credential_policy:'secure-store-only',name:'jhw-control-host',version:5};
  const file=path.join(home,'.local/bin/jhw-control-host');fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(contract)}'\n`,{mode:0o755});
}

async function installedFixture(t) {
  const fixture=await createRuntimeFixture(t,{productionEntry:true});const source=path.dirname(new URL(import.meta.url).pathname);
  for(const name of ['install-config.mjs','install-wiring.sh','runtime-entry.mjs','runtime-prune.mjs','runtime-guard.mjs'])fixture.write(`scripts/${name}`,fs.readFileSync(path.join(source,name)),name.endsWith('.sh')?0o755:0o644);
  fixture.write('skills/codex/jhw-task/SKILL.md','fixture\n');
  fixture.write('mcp-server/src/control/runtime-compatibility.json','{"version":1,"generation":2,"guardFloor":1}\n');hostContract(fixture.home);
  for(const directory of ['.claude','.gemini','.codex','.config/opencode'])fs.mkdirSync(path.join(fixture.home,directory),{recursive:true,mode:0o700});
  writeJson(path.join(fixture.home,'.claude.json'),{mcpServers:{}});
  const procRoot=path.join(fixture.root,'proc');fs.mkdirSync(procRoot,{mode:0o700});const release=await fixture.prepare();
  const phaseRunner=options=>options.phase==='validate'?undefined:wiringPhase(options);
  await runDeployment({repositoryRoot:fixture.root,home:fixture.home,procRoot,argv:['--activate',release.releaseId],phaseRunner});
  return {...fixture,procRoot,release};
}

async function replaceCurrent(fixture) {
  fixture.write('mcp-server/src/index.ts',`export const next = ${++replacementSequence};\n`);const next=await fixture.prepare(),deploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));let pair;
  try{pair=(await import('./runtime-store.mjs')).ensureBootstrapGeneration({repositoryRoot:fixture.root,releaseId:next.releaseId,deployLease:deploy});}finally{deploy.close();}
  fixture.seedPair(pair);return pair;
}

test('old v2 initial journal is removed after its current witness is replaced',async t=>{
  const fixture=await installedFixture(t);const journalsRoot=path.join(fixture.root,'.jhw-runtime/v2/journals');
  const initialName=fs.readdirSync(journalsRoot)[0],initialDirectory=path.join(journalsRoot,initialName);ageReceipt(initialDirectory,40);
  await replaceCurrent(fixture);
  addRecentCompatibleJournals(fixture.root);
  const plan=planRuntimePrune({repositoryRoot:fixture.root});assert.equal(plan.candidates.journals.includes(initialName),true);
  const result=await runDeployment({repositoryRoot:fixture.root,home:fixture.home,procRoot:fixture.procRoot,argv:['--prune','--apply']});
  assert.equal(result.removed.journals,1);assert.equal(fs.existsSync(initialDirectory),false);
});

test('old v2 current-linked witness stays protected beyond age and recent limits',async t=>{
  const fixture=await installedFixture(t),journalsRoot=path.join(fixture.root,'.jhw-runtime/v2/journals'),name=fs.readdirSync(journalsRoot)[0],journal=path.join(journalsRoot,name);ageReceipt(journal,40);addRecentCompatibleJournals(fixture.root);
  const plan=planRuntimePrune({repositoryRoot:fixture.root});assert.equal(plan.candidates.journals.includes(name),false);assert.ok(plan.skipped.evidence>=1);assert.equal(fs.existsSync(journal),true);
});

test('receipt-less completed v2 journal remains legacy evidence',async t=>{
  const fixture=await installedFixture(t),journalsRoot=path.join(fixture.root,'.jhw-runtime/v2/journals'),name=fs.readdirSync(journalsRoot)[0],journal=path.join(journalsRoot,name);fs.unlinkSync(path.join(journal,'retention.json'));
  const plan=planRuntimePrune({repositoryRoot:fixture.root});assert.equal(plan.candidates.journals.includes(name),false);assert.equal(plan.skipped.legacy,1);assert.equal(fs.existsSync(journal),true);
});

test('safe Codex journal is deleted and a mutable captured original is retained as evidence',async t=>{
  const safe=await installedFixture(t);const config=path.join(safe.home,'.codex/config.toml');
  fs.writeFileSync(config,fs.readFileSync(config,'utf8').replace(/^env_vars = .*\n/m,''),{mode:0o600});
  await runDeployment({repositoryRoot:safe.root,home:safe.home,procRoot:safe.procRoot,argv:['--migrate-codex-config']});
  const safeRoot=path.join(safe.root,'.jhw-runtime/v2/journals');const safeName=fs.readdirSync(safeRoot).find(name=>JSON.parse(fs.readFileSync(path.join(safeRoot,name,'state.json'))).kind==='codex-config');const safeJournal=path.join(safeRoot,safeName);ageReceipt(safeJournal,40);addRecentCompatibleJournals(safe.root);
  assert.equal(planRuntimePrune({repositoryRoot:safe.root}).candidates.journals.includes(safeName),true);
  const removed=await runDeployment({repositoryRoot:safe.root,home:safe.home,procRoot:safe.procRoot,argv:['--prune','--apply']});assert.equal(removed.removed.journals,1);assert.equal(fs.existsSync(safeJournal),false);

  const changed=await installedFixture(t);const changedConfig=path.join(changed.home,'.codex/config.toml');fs.writeFileSync(changedConfig,fs.readFileSync(changedConfig,'utf8').replace(/^env_vars = .*\n/m,''),{mode:0o600});
  await runDeployment({repositoryRoot:changed.root,home:changed.home,procRoot:changed.procRoot,argv:['--migrate-codex-config']});
  const changedRoot=path.join(changed.root,'.jhw-runtime/v2/journals');const changedName=fs.readdirSync(changedRoot).find(name=>JSON.parse(fs.readFileSync(path.join(changedRoot,name,'state.json'))).kind==='codex-config');const changedJournal=path.join(changedRoot,changedName),header=JSON.parse(fs.readFileSync(path.join(changedJournal,'state.json'))),state=JSON.parse(fs.readFileSync(path.join(changedJournal,header.control.name,'state.json')));ageReceipt(changedJournal,40);fs.appendFileSync(path.join(changedJournal,state.captures.source.name,'object'),'foreign edit\n');addRecentCompatibleJournals(changed.root);
  const retained=planRuntimePrune({repositoryRoot:changed.root});assert.equal(retained.candidates.journals.includes(changedName),false);assert.ok(retained.skipped.evidence>=1);assert.equal(fs.existsSync(changedJournal),true);

});

async function foreignCodexCapture(t,mutation) {
  const fixture=await installedFixture(t),config=path.join(fixture.home,'.codex/config.toml');fs.writeFileSync(config,fs.readFileSync(config,'utf8').replace(/^env_vars = .*\n/m,''),{mode:0o600});
  await runDeployment({repositoryRoot:fixture.root,home:fixture.home,procRoot:fixture.procRoot,argv:['--migrate-codex-config']});
  const root=path.join(fixture.root,'.jhw-runtime/v2/journals'),name=fs.readdirSync(root).find(value=>JSON.parse(fs.readFileSync(path.join(root,value,'state.json'))).kind==='codex-config'),journal=path.join(root,name),header=JSON.parse(fs.readFileSync(path.join(journal,'state.json'))),control=JSON.parse(fs.readFileSync(path.join(journal,header.control.name,'state.json')));ageReceipt(journal,40);
  const capture=path.join(journal,control.captures.temp.name);if(mutation==='unknown-child')fs.writeFileSync(path.join(capture,'foreign-data'),'foreign',{mode:0o600});else{const aside=path.join(fixture.root,'.replaced-capture');fs.renameSync(capture,aside);fs.mkdirSync(capture,{mode:0o700});}
  addRecentCompatibleJournals(fixture.root);return {fixture,name,journal};
}

for(const mutation of ['unknown-child','replaced-capture'])test(`Codex ${mutation} remains evidence`,async t=>{
  const value=await foreignCodexCapture(t,mutation),plan=planRuntimePrune({repositoryRoot:value.fixture.root});assert.equal(plan.candidates.journals.includes(value.name),false);assert.ok(plan.skipped.evidence>=1);assert.equal(fs.existsSync(value.journal),true);
});

async function initialScratchCandidate(t,{full=false}={}) {
  const fixture=await installedFixture(t),root=path.join(fixture.root,'.jhw-runtime/v2/journals'),name=fs.readdirSync(root)[0],journal=path.join(root,name);ageReceipt(journal,40);await replaceCurrent(fixture);addRecentCompatibleJournals(fixture.root);
  const scratch=path.join(journal,'wiring/restore');fs.mkdirSync(scratch,{mode:0o700});const target='a'.repeat(16),uuid='00000000-0000-4000-8000-000000000000',temporary=`.${target}.123.${uuid}.tmp`;fs.writeFileSync(path.join(scratch,target),'paired',{mode:0o600});fs.linkSync(path.join(scratch,target),path.join(scratch,temporary));
  if(full)for(let index=0;index<126;index++)fs.writeFileSync(path.join(scratch,index.toString(16).padStart(16,'0')),'x',{mode:0o600});
  return {fixture,root,name,journal,target,temporary};
}

test('initial scratch hardlink pairs delete atomically',async t=>{
  const clean=await initialScratchCandidate(t);assert.equal(planRuntimePrune({repositoryRoot:clean.fixture.root}).candidates.journals.includes(clean.name),true);const removed=applyRuntimePrune({repositoryRoot:clean.fixture.root});assert.equal(removed.removed.journals,1);assert.equal(fs.existsSync(clean.journal),false);
});

for(const mutation of ['before-open','during-read-mode','during-read-size','during-read-link','during-read-time','final-name'])test(`v2 deletion preserves evidence on ${mutation} file change`,async t=>{
  const candidate=await initialScratchCandidate(t),runtime=path.join(candidate.fixture.root,'.jhw-runtime');
  const captureFile=path.join(runtime,'.prune.v1/capture.00000000/wiring/state.json');
  const original=fs.readFileSync(path.join(candidate.journal,'wiring/state.json'));
  const retained=path.join(candidate.fixture.root,'retained-original');
  const replacement=path.join(candidate.fixture.root,'replacement');
  fs.writeFileSync(replacement,original,{mode:0o600});
  const foreignInode=fs.lstatSync(replacement).ino;
  const open=fs.openSync,fstat=fs.fstatSync;let armed=false,opens=0,selectedFd,changed=false;
  const replace=()=>{fs.renameSync(captureFile,retained);fs.renameSync(replacement,captureFile);};
  fs.openSync=function(file,...args){
    const selected=armed&&String(file).endsWith('/capture.00000000/wiring/state.json')&&++opens===2;
    if(selected&&mutation==='before-open'){replace();changed=true;}
    const fd=open.call(this,file,...args);if(selected)selectedFd=fd;return fd;
  };
  fs.fstatSync=function(fd,...args){
    const stat=fstat.call(this,fd,...args);
    if(fd===selectedFd&&!changed){
      changed=true;
      if(mutation==='final-name')replace();
      else if(mutation==='during-read-mode')fs.chmodSync(captureFile,0o400);
      else if(mutation==='during-read-size')fs.appendFileSync(captureFile,' ');
      else if(mutation==='during-read-link')fs.linkSync(captureFile,retained);
      else if(mutation==='during-read-time')fs.utimesSync(captureFile,new Date(0),new Date(0));
    }
    return stat;
  };
  try{
    assert.throws(()=>applyRuntimePrune({repositoryRoot:candidate.fixture.root,faultInjector:point=>{if(point==='after_capture')armed=true;}}),{code:'DEPLOY_PRUNE_PARTIAL'});
  }finally{fs.openSync=open;fs.fstatSync=fstat;}
  assert.equal(changed,true,'the deletion read boundary was exercised');
  assert.equal(fs.existsSync(captureFile),true,'changed file must survive');
  if(mutation==='before-open'||mutation==='final-name')assert.equal(fs.lstatSync(captureFile).ino,foreignInode,'foreign inode must survive');
  const recovery=path.join(runtime,'.prune.v1/recovery.00000000');
  const inventory=JSON.parse(fs.readFileSync(path.join(recovery,'inventory.json')));
  const record=inventory.tree.find(value=>value.path==='wiring/state.json');
  assert.deepEqual(fs.readFileSync(path.join(recovery,'payload',record.payload)),original,'durable recovery must survive');
});

test('initial scratch preserves the accepted 128-entry capacity',async t=>{
  const full=await initialScratchCandidate(t,{full:true});assert.equal(planRuntimePrune({repositoryRoot:full.fixture.root}).candidates.journals.includes(full.name),true);assert.equal(applyRuntimePrune({repositoryRoot:full.fixture.root}).removed.journals,1);
});

test('initial scratch recovery manifest retains paths, types, proofs and link groups',async t=>{
  const interrupted=await initialScratchCandidate(t);assert.throws(()=>applyRuntimePrune({repositoryRoot:interrupted.fixture.root,faultInjector:point=>{if(point==='after_recovery_durable')throw new Error('stop');}}),{code:'DEPLOY_PRUNE_PARTIAL'});
  const inventory=JSON.parse(fs.readFileSync(path.join(interrupted.fixture.root,'.jhw-runtime/.prune.v1/recovery.00000000/inventory.json')));assert.equal(Array.isArray(inventory.tree),true);const first=`wiring/restore/${interrupted.target}`,second=`wiring/restore/${interrupted.temporary}`,records=inventory.tree.filter(record=>[first,second].includes(record.path));
  assert.equal(records.length,2);assert.deepEqual(new Set(records.map(record=>record.type)),new Set(['file']));assert.equal(records[0].linkGroup,records[1].linkGroup);assert.ok(records[0].linkGroup);assert.ok(records.every(record=>record.proof.nlink===2&&typeof record.payload==='string'));
});

test('v2 nested bytes, symlink, owner and quarantine interruption preserve recoverable evidence',async t=>{
  for(const mutation of ['bytes','symlink','owner']){
    const fixture=await installedFixture(t),root=path.join(fixture.root,'.jhw-runtime/v2/journals'),name=fs.readdirSync(root)[0],journal=path.join(root,name);ageReceipt(journal,40);addRecentCompatibleJournals(fixture.root);
    await replaceCurrent(fixture);
    const target=path.join(journal,'wiring/state.json');
    const lstat=fs.lstatSync;let foreignOwner=false;
    if(mutation==='owner')fs.lstatSync=function(file,...args){const stat=lstat.call(this,file,...args);return foreignOwner&&String(file)===target?new Proxy(stat,{get(value,key){return key==='uid'?value.uid+1n:Reflect.get(value,key,value);}}):stat;};
    try{assert.throws(()=>applyRuntimePrune({repositoryRoot:fixture.root,faultInjector:(point,context)=>{if(point!=='after_recovery_file_sync'||context.name!==name)return;if(mutation==='bytes')fs.appendFileSync(target,'x');else if(mutation==='symlink'){fs.unlinkSync(target);fs.symlinkSync('before.json',target);}else foreignOwner=true;}}),{code:'DEPLOY_PRUNE_PARTIAL'});}
    finally{fs.lstatSync=lstat;}
    assert.equal(fs.existsSync(journal),true,mutation);assert.equal(fs.existsSync(path.join(fixture.root,'.jhw-runtime/.prune.v1')),true,mutation);
  }
  const interrupted=await installedFixture(t),root=path.join(interrupted.root,'.jhw-runtime/v2/journals'),name=fs.readdirSync(root)[0],journal=path.join(root,name);ageReceipt(journal,40);addRecentCompatibleJournals(interrupted.root);
  await replaceCurrent(interrupted);
  assert.throws(()=>applyRuntimePrune({repositoryRoot:interrupted.root,faultInjector:(point,context)=>{if(point==='after_capture'&&context.name===name)throw new Error('stop');}}),{code:'DEPLOY_PRUNE_PARTIAL'});
  assert.equal(fs.existsSync(journal),false);assert.equal(fs.readdirSync(path.join(interrupted.root,'.jhw-runtime/.prune.v1')).some(child=>child.startsWith('capture.')),true);
});

test('generation policy keeps recent-one ties and collects the exact 30-day boundary',async t=>{
  const fixture=await createRuntimeFixture(t),store=await import('./runtime-store.mjs'),pairs=[];
  for(let index=0;index<5;index++){fixture.write('mcp-server/src/index.ts',`export const generation = ${index};\n`);const release=await fixture.prepare(),deploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'),{create:true});try{pairs.push(store.ensureBootstrapGeneration({repositoryRoot:fixture.root,releaseId:release.releaseId,deployLease:deploy}));}finally{deploy.close();}}
  fixture.seedPair(pairs[4]);const now=Date.now(),directory=pair=>path.join(fixture.root,'.jhw-runtime/v2/bootstraps',pair.bootstrapId),set=(pair,time)=>fs.utimesSync(directory(pair),new Date(time),new Date(time));
  set(pairs[0],now-50*DAY);set(pairs[1],now-51*DAY);set(pairs[2],now-40*DAY);set(pairs[3],now-40*DAY);set(pairs[4],now-60*DAY);
  const plan=planRuntimePrune({repositoryRoot:fixture.root,now});
  assert.deepEqual(new Set(plan.candidates.bootstrapGenerations),new Set([pairs[0].bootstrapId,pairs[1].bootstrapId]));
  assert.equal(plan.candidates.bootstrapGenerations.includes(pairs[2].bootstrapId),false);assert.equal(plan.candidates.bootstrapGenerations.includes(pairs[3].bootstrapId),false);

  const boundary=await createRuntimeFixture(t),boundaryStore=await import('./runtime-store.mjs'),boundaryPairs=[];
  for(let index=0;index<2;index++){boundary.write('mcp-server/src/index.ts',`export const boundary = ${index};\n`);const release=await boundary.prepare(),deploy=acquireLease(path.join(boundary.root,'.jhw-runtime/deploy.lock'),{create:true});try{boundaryPairs.push(boundaryStore.ensureBootstrapGeneration({repositoryRoot:boundary.root,releaseId:release.releaseId,deployLease:deploy}));}finally{deploy.close();}}
  boundary.seedPair(boundaryPairs[1]);const boundaryNow=Date.now(),oldDirectory=path.join(boundary.root,'.jhw-runtime/v2/bootstraps',boundaryPairs[0].bootstrapId);fs.utimesSync(oldDirectory,new Date(boundaryNow-30*DAY),new Date(boundaryNow-30*DAY));
  assert.equal(planRuntimePrune({repositoryRoot:boundary.root,now:boundaryNow}).candidates.bootstrapGenerations.includes(boundaryPairs[0].bootstrapId),true);
});

test('v2 prune preserves current generation and identifies an old unreferenced copy', async t => {
  const fixture=await createRuntimeFixture(t);
  const firstRelease=await fixture.prepare();
  fixture.write('scripts/runtime-entry.mjs','export const generationTwo = true;\n');
  const currentRelease=await fixture.prepare();
  const deploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));
  let oldPair;let currentPair;let store;
  try {
    store=await import('./runtime-store.mjs');
    oldPair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,releaseId:firstRelease.releaseId,deployLease:deploy});
    currentPair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,releaseId:currentRelease.releaseId,deployLease:deploy});
  } finally {deploy.close();}
  fixture.seedPair(oldPair);
  const admission=acquireLease(path.join(fixture.root,'.jhw-runtime/admission.lock'),{shared:true,create:true});
  const stale=store.bindEntryPair({repositoryRoot:fixture.root,kind:'session',selectedPair:oldPair,admissionLease:admission});
  fixture.seedPair(currentPair);
  stale.lease.close();stale.generationLease.close();admission.close();
  const oldDirectory=path.join(fixture.root,'.jhw-runtime/v2/bootstraps',oldPair.bootstrapId);
  const oldTime=new Date(Date.now()-40*24*60*60*1000);fs.utimesSync(oldDirectory,oldTime,oldTime);
  const roots=collectBootstrapRoots({repositoryRoot:fixture.root,now:Date.now()+31*24*60*60*1000});
  assert.equal(roots.uncertain,false);
  assert.equal(roots.retained.has(currentPair.bootstrapId),true);
  const plan=planRuntimePrune({repositoryRoot:fixture.root,now:Date.now()});
  assert.deepEqual(plan.candidates.bootstrapGenerations,[oldPair.bootstrapId]);
  const applyDeploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));
  const publication=acquireLease(path.join(fixture.root,'.jhw-runtime/publication.lock'),{create:true});
  let retired;
  try{retired=applyRuntimePrune({repositoryRoot:fixture.root,now:Date.now(),deployLease:applyDeploy,publicationLease:publication});}
  finally{publication.close();applyDeploy.close();}
  assert.equal(retired.removed.bootstrapGenerations,0);
  assert.equal(fs.existsSync(oldDirectory),true);
  const secondDeploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));const secondPublication=acquireLease(path.join(fixture.root,'.jhw-runtime/publication.lock'));
  const originalFsync=fs.fsyncSync;let sourceParentSynced=false;fs.fsyncSync=function(fd,...args){try{if(fs.readlinkSync(`/proc/self/fd/${fd}`)===path.join(fixture.root,'.jhw-runtime/v2/bootstraps'))sourceParentSynced=true;}catch{}return originalFsync.call(this,fd,...args);};
  let applied;try{applied=applyRuntimePrune({repositoryRoot:fixture.root,now:Date.now(),deployLease:secondDeploy,publicationLease:secondPublication});}
  finally{fs.fsyncSync=originalFsync;secondPublication.close();secondDeploy.close();}
  assert.equal(applied.removed.bootstrapGenerations,1);
  assert.equal(sourceParentSynced,true);
  assert.equal(fs.existsSync(oldDirectory),false);
  assert.equal(fs.existsSync(path.join(fixture.root,'.jhw-runtime/v2/bootstrap-catalog',`${oldPair.bootstrapId}.json`)),true);
  const restoreDeploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));
  let rebuilt;try{rebuilt=store.restoreBootstrapGeneration({repositoryRoot:fixture.root,bootstrapId:oldPair.bootstrapId,deployLease:restoreDeploy});}
  finally{restoreDeploy.close();}
  assert.equal(rebuilt.bootstrapId,oldPair.bootstrapId);
  fs.utimesSync(oldDirectory,oldTime,oldTime);
  const safety=pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname),'runtime-safety.mjs')).href;
  const ready=path.join(fixture.root,'.generation-holder-ready');let holder;
  t.after(()=>{if(holder?.exitCode===null)holder.kill('SIGTERM');});
  const blockedDeploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));const blockedPublication=acquireLease(path.join(fixture.root,'.jhw-runtime/publication.lock'));
  let blocked;try{blocked=applyRuntimePrune({repositoryRoot:fixture.root,now:Date.now(),deployLease:blockedDeploy,publicationLease:blockedPublication,faultInjector:point=>{if(point!=='before_intent')return;holder=spawn(process.execPath,['--input-type=module','--eval',`import fs from 'node:fs';import {acquireLease} from ${JSON.stringify(safety)};const lease=acquireLease(process.argv[1],{shared:true});fs.writeFileSync(process.argv[2],'ready',{mode:0o600});process.stdin.resume();process.stdin.on('end',()=>{lease.close();process.exit(0)});`,path.join(oldDirectory,'lease'),ready],{stdio:['pipe','ignore','pipe']});const deadline=Date.now()+3000;while(!fs.existsSync(ready)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);assert.equal(fs.existsSync(ready),true);}});}
  finally{blockedPublication.close();blockedDeploy.close();}
  assert.equal(blocked.removed.bootstrapGenerations,0);assert.equal(fs.existsSync(oldDirectory),true);
  holder.stdin.end();await new Promise(resolve=>holder.once('close',resolve));
});

async function staleGenerationFixture(t,{privateState=null}={}) {
  const fixture=await createRuntimeFixture(t);const first=await fixture.prepare();fixture.write('scripts/runtime-entry.mjs','export const nextGeneration=true;\n');const second=await fixture.prepare(),store=await import('./runtime-store.mjs'),deploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));let oldPair,currentPair;
  try{oldPair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,releaseId:first.releaseId,deployLease:deploy});currentPair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,releaseId:second.releaseId,deployLease:deploy});}finally{deploy.close();}
  fixture.seedPair(oldPair);const admission=acquireLease(path.join(fixture.root,'.jhw-runtime/admission.lock'),{shared:true,create:true}),binding=store.bindEntryPair({repositoryRoot:fixture.root,kind:'session',selectedPair:oldPair,admissionLease:admission});fixture.seedPair(currentPair);binding.lease.close();binding.generationLease.close();admission.close();
  const sessions=path.join(fixture.root,'.jhw-runtime/v2/sessions');let recordName=binding.id;if(privateState){recordName=privateState==='creating'?`.creating.${binding.id}`:`.retired.${binding.id}.${'a'.repeat(32)}`;fs.renameSync(path.join(sessions,binding.id),path.join(sessions,recordName));}
  const generation=path.join(fixture.root,'.jhw-runtime/v2/bootstraps',oldPair.bootstrapId),old=new Date(Date.now()-40*DAY);fs.utimesSync(generation,old,old);return {fixture,store,oldPair,currentPair,binding,generation,sessions,recordName};
}

for(const privateState of ['creating','retired'])test(`private ${privateState} records are retired before a later generation reclaim`,async t=>{
  const value=await staleGenerationFixture(t,{privateState});assert.equal(planRuntimePrune({repositoryRoot:value.fixture.root}).candidates.bootstrapGenerations.includes(value.oldPair.bootstrapId),true);
  const deploy=acquireLease(path.join(value.fixture.root,'.jhw-runtime/deploy.lock')),publication=acquireLease(path.join(value.fixture.root,'.jhw-runtime/publication.lock'),{create:true});let first;try{first=applyRuntimePrune({repositoryRoot:value.fixture.root,deployLease:deploy,publicationLease:publication});}finally{publication.close();deploy.close();}
  assert.equal(first.removed.bootstrapGenerations,0);assert.equal(fs.existsSync(value.generation),true);assert.equal(fs.existsSync(path.join(value.sessions,value.recordName)),false);
  const nextDeploy=acquireLease(path.join(value.fixture.root,'.jhw-runtime/deploy.lock')),nextPublication=acquireLease(path.join(value.fixture.root,'.jhw-runtime/publication.lock'));let second;try{second=applyRuntimePrune({repositoryRoot:value.fixture.root,deployLease:nextDeploy,publicationLease:nextPublication});}finally{nextPublication.close();nextDeploy.close();}assert.equal(second.removed.bootstrapGenerations,1);
});

async function crossProcessReaperScenario(t,privateState=null) {
  const value=await staleGenerationFixture(t,{privateState}),storeUrl=pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname),'runtime-store.mjs')).href,deploy=acquireLease(path.join(value.fixture.root,'.jhw-runtime/deploy.lock')),publication=acquireLease(path.join(value.fixture.root,'.jhw-runtime/publication.lock'),{create:true});let child;let childResult;
  try{const first=applyRuntimePrune({repositoryRoot:value.fixture.root,deployLease:deploy,publicationLease:publication,faultInjector:point=>{if(point!=='generation_ex_acquired'||child)return;const source=`import {reapCompletedSessionBindingsV2} from ${JSON.stringify(storeUrl)};console.log(JSON.stringify(reapCompletedSessionBindingsV2({repositoryRoot:process.argv[1],dryRun:false,limit:8})))`;child=spawnSync(process.execPath,['--input-type=module','-e',source,value.fixture.root],{encoding:'utf8',timeout:10000});if(child.status===0)childResult=JSON.parse(child.stdout);}});assert.equal(first.removed.bootstrapGenerations,0);}finally{publication.close();deploy.close();}
  assert.equal(child.status,0,child.stderr);
  assert.ok(childResult.preserved.includes(value.recordName));assert.equal(fs.existsSync(value.generation),true);assert.equal(fs.existsSync(path.join(value.sessions,value.recordName)),false);
  const nextDeploy=acquireLease(path.join(value.fixture.root,'.jhw-runtime/deploy.lock')),nextPublication=acquireLease(path.join(value.fixture.root,'.jhw-runtime/publication.lock'));try{assert.equal(applyRuntimePrune({repositoryRoot:value.fixture.root,deployLease:nextDeploy,publicationLease:nextPublication}).removed.bootstrapGenerations,1);}finally{nextPublication.close();nextDeploy.close();}
}

test('cross-process public reaper cannot invert generation to index ordering during reclaim',async t=>{
  await crossProcessReaperScenario(t);
});

test('cross-process private reaper cannot invert generation to index ordering during reclaim',async t=>{
  await crossProcessReaperScenario(t,'creating');
});

test('live v2 binding rejects an eligible legacy batch before prune intent', async t => {
  const fixture=await createRuntimeFixture(t);const release=await fixture.prepare();const deploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));let pair;let store;
  try{store=await import('./runtime-store.mjs');pair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,releaseId:release.releaseId,deployLease:deploy});}finally{deploy.close();}
  fixture.seedPair(pair);const admission=acquireLease(path.join(fixture.root,'.jhw-runtime/admission.lock'),{shared:true,create:true});const binding=store.bindEntryPair({repositoryRoot:fixture.root,kind:'session',selectedPair:pair,admissionLease:admission});
  t.after(()=>{try{binding.close();}catch{}try{admission.close();}catch{}});
  const runtime=path.join(fixture.root,'.jhw-runtime');const previous={activationId:'a-'+'1'.repeat(32),releaseId:'r-'+'1'.repeat(40)+'-'+'2'.repeat(64),predecessorActivationId:null,observation:{target:'activations/a-'+'1'.repeat(32),dev:'1',ino:'2',ctimeNs:'3'}};const candidate='r-'+'3'.repeat(40)+'-'+'4'.repeat(64);
  for(let sequence=1;sequence<=33;sequence++){const name=`.deploy.${sequence.toString(16).padStart(32,'0')}`;const directory=path.join(runtime,name);fs.mkdirSync(directory,{mode:0o700});const activation=`a-${sequence.toString(16).padStart(32,'0')}`;const state={version:1,status:'complete',operation:'activate',compatible:true,candidateReleaseId:candidate,compatibilityDigest:'5'.repeat(64),phase:'complete',previous,variables:{},mutationStarted:true,destination:{activationId:activation,releaseId:candidate,predecessorActivationId:previous.activationId},current:{activationId:activation,releaseId:candidate,predecessorActivationId:previous.activationId,observation:{target:`activations/${activation}`,dev:'7',ino:String(sequence),ctimeNs:'9'}}};fs.writeFileSync(path.join(directory,'state.json'),JSON.stringify(state)+'\n',{mode:0o600});fs.writeFileSync(path.join(directory,'candidate-probe.log'),'ok\n',{mode:0o600});recordDeploymentRetention({repositoryRoot:fixture.root,journalDirectory:directory,completedAt:new Date(Date.now()-(sequence===1?90:1)*86400000).toISOString()});}
  assert.throws(()=>applyRuntimePrune({repositoryRoot:fixture.root,now:Date.now()}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'mixed_generation_legacy'});
  assert.equal(fs.existsSync(path.join(runtime,'.prune.v1')),false);
});
