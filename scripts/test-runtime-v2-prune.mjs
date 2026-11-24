import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

import {acquireLease} from './runtime-safety.mjs';
import {applyRuntimePrune,collectBootstrapRoots,planRuntimePrune,prepareRuntimePrune,
  recordDeploymentRetention} from './runtime-prune.mjs';
import {observePruneScanPair,runDeployment,wiringPhase} from './runtime-deploy.mjs';
import {readActivation} from './runtime-store.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

const DAY=24*60*60*1000;
let replacementSequence=0;
const writeJson=(file,value)=>{fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});fs.chmodSync(file,0o600);};
const writeProcFile=(file,value)=>{fs.writeFileSync(file,value,{mode:0o600});fs.chmodSync(file,0o600);};
function stableProcEntry({procRoot,repositoryRoot,pid=100,startTime='12345',token}) {
  const directory=path.join(procRoot,String(pid));fs.mkdirSync(directory,{mode:0o700});
  const uid=process.getuid();
  writeProcFile(path.join(directory,'status'),'Name:\tnode\nUid:\t'+uid+'\t'+uid+'\t'+uid+'\t'+uid+'\n');
  writeProcFile(path.join(directory,'stat'),
    pid+' (node) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 '+startTime+' 0 0\n');
  writeProcFile(path.join(directory,'cmdline'),
    'node\0'+repositoryRoot+'/.jhw-runtime/bootstrap/jhw-runtime-entry\0');
  writeProcFile(path.join(directory,'environ'),token===undefined?'':
    `JHW_RUNTIME_SESSION_BINDING=${token}\0`);
  fs.symlinkSync(repositoryRoot,path.join(directory,'cwd'));
}

async function startBoundSessionChild(t,value) {
  const ready=path.join(value.fixture.home,'.bound-session.json');
  const storeUrl=new URL('./runtime-store.mjs',import.meta.url).href;
  const safetyUrl=new URL('./runtime-safety.mjs',import.meta.url).href;
  const source=[
    `import fs from 'node:fs'`,
    `import {acquireLease} from ${JSON.stringify(safetyUrl)}`,
    `import {bindEntryPair} from ${JSON.stringify(storeUrl)}`,
    `const [repositoryRoot,pairText,ready]=process.argv.slice(1)`,
    `const admission=acquireLease(repositoryRoot+'/.jhw-runtime/admission.lock',{shared:true})`,
    `const binding=bindEntryPair({repositoryRoot,kind:'session',selectedPair:JSON.parse(pairText),admissionLease:admission})`,
    `fs.writeFileSync(ready,JSON.stringify({id:binding.id,token:binding.token})+'\\n',{mode:0o600})`,
    `process.stdin.resume()`,
    `process.stdin.on('end',()=>{binding.close();admission.close();process.exit(0)})`,
  ].join(';');
  const child=spawn(process.execPath,['--input-type=module','-e',source,value.fixture.root,
    JSON.stringify(value.pairB),ready],{stdio:['pipe','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{
    if(child.exitCode===null){child.stdin.end();await new Promise(resolve=>child.once('close',resolve));}
  });
  const deadline=Date.now()+5000;
  while(!fs.existsSync(ready)&&child.exitCode===null&&Date.now()<deadline){
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
  assert.equal(fs.existsSync(ready),true,stderr||`bound session child exited ${child.exitCode}`);
  const published=JSON.parse(fs.readFileSync(ready));
  const row=value.store.inspectSessionBindingsV2({repositoryRoot:value.fixture.root})
    .find(item=>item.id===published.id);
  assert.ok(row?.live);
  return {child,row};
}

function countReleaseReadsDuringProcScans(procRoot,releasesRoot) {
  const selectedProcRoot=fs.realpathSync(procRoot);
  const releasePrefix=fs.realpathSync(releasesRoot)+path.sep;
  const originalOpendir=fs.opendirSync;
  const originalRead=fs.readSync;
  const counts=[0,0];let procReads=0;let activeScan=-1;
  fs.opendirSync=function(directory,...args){
    let target;
    try{target=fs.realpathSync(directory);}catch{}
    if(target===selectedProcRoot){
      procReads++;
      activeScan=procReads%2===1?Math.floor(procReads/2):-1;
    }
    return originalOpendir.call(this,directory,...args);
  };
  fs.readSync=function(fd,...args){
    if(activeScan>=0&&activeScan<counts.length){
      try{
        if(fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(releasePrefix))counts[activeScan]++;
      }catch{}
    }
    return originalRead.call(this,fd,...args);
  };
  return {
    counts,
    close(){fs.readSync=originalRead;fs.opendirSync=originalOpendir;return procReads;},
  };
}

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
  for(const name of ['install-config.mjs','install-wiring.sh','runtime-entry.mjs','runtime-prune.mjs','runtime-guard.mjs','runtime-managed-scope.mjs'])fixture.write(`scripts/${name}`,fs.readFileSync(path.join(source,name)),name.endsWith('.sh')?0o755:0o644);
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

test('baseline and prepared prune scans agree on a stable unbound managed consumer', async t => {
  const fixture=await createRuntimeFixture(t);
  const staleRelease=await fixture.prepare();
  fixture.write('scripts/runtime-entry.mjs','export const retainedGeneration = true;\n');
  const currentRelease=await fixture.prepare();
  const deploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));
  const store=await import('./runtime-store.mjs');
  let stalePair;let currentPair;
  try {
    stalePair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,
      releaseId:staleRelease.releaseId,deployLease:deploy});
    currentPair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,
      releaseId:currentRelease.releaseId,deployLease:deploy});
  } finally {deploy.close();}
  const current=fixture.seedPair(currentPair);
  const admission=acquireLease(path.join(fixture.root,'.jhw-runtime/admission.lock'),{shared:true,create:true});
  const binding=store.bindEntryPair({repositoryRoot:fixture.root,kind:'session',
    selectedPair:currentPair,admissionLease:admission});
  t.after(()=>{try{binding.close();}catch{}try{admission.close();}catch{}});
  const staleDirectory=path.join(fixture.root,'.jhw-runtime/v2/bootstraps',stalePair.bootstrapId);
  const staleTime=new Date(Date.now()-40*DAY);fs.utimesSync(staleDirectory,staleTime,staleTime);
  assert.deepEqual(planRuntimePrune({repositoryRoot:fixture.root}).candidates.bootstrapGenerations,
    [stalePair.bootstrapId]);
  const procRoot=path.join(fixture.home,'stable-unbound-proc');fs.mkdirSync(procRoot,{mode:0o700});
  stableProcEntry({procRoot,repositoryRoot:fixture.root});

  const baseline=observePruneScanPair({repositoryRoot:fixture.root,procRoot,method:'baseline'});
  const prepared=observePruneScanPair({repositoryRoot:fixture.root,procRoot,method:'prepared'});
  assert.equal(baseline.rootCount,1);assert.equal(prepared.rootCount,1);
  assert.deepEqual(baseline.plan,prepared.plan);
  assert.equal(baseline.scans.length,2);assert.equal(prepared.scans.length,2);
  for(let index=0;index<2;index++){
    const original=baseline.scans[index];const reused=prepared.scans[index];
    assert.deepEqual(reused.inventory,original.inventory);
    assert.deepEqual(reused.observation.causeCounts,original.observation.causeCounts);
    assert.equal(reused.observation.outcome,original.observation.outcome);
    assert.equal(original.observation.outcome,'disallowed');
    assert.equal(original.inventory.uncertain,0);
    assert.deepEqual(original.inventory.bound,{tui:0,app_server:0,legacy:0,managed:0});
    assert.deepEqual(original.inventory.counts,{tui:0,app_server:0,legacy:0,managed:1});
  }
  assert.deepEqual(store.readActivation({repositoryRoot:fixture.root}),current);
  assert.equal(fs.existsSync(staleDirectory),true);
  assert.equal(fs.existsSync(path.join(fixture.root,'.jhw-runtime/.prune.v1')),false);
  assert.deepEqual(planRuntimePrune({repositoryRoot:fixture.root}).candidates.bootstrapGenerations,
    [stalePair.bootstrapId]);
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

async function unreferencedGenerationFixture(t) {
  const fixture=await createRuntimeFixture(t);
  const staleRelease=await fixture.prepare();
  fixture.write('scripts/runtime-entry.mjs','export const currentGeneration = true;\n');
  const currentRelease=await fixture.prepare();
  const store=await import('./runtime-store.mjs');
  const deploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));
  let stalePair;let currentPair;
  try {
    stalePair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,
      releaseId:staleRelease.releaseId,deployLease:deploy});
    currentPair=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,
      releaseId:currentRelease.releaseId,deployLease:deploy});
  } finally {deploy.close();}
  const current=fixture.seedPair(currentPair);
  const runtime=path.join(fixture.root,'.jhw-runtime');
  const generation=path.join(runtime,'v2/bootstraps',stalePair.bootstrapId);
  const generationLease=path.join(generation,'lease');
  fs.utimesSync(generation,new Date(Date.now()-40*DAY),new Date(Date.now()-40*DAY));
  assert.deepEqual(planRuntimePrune({repositoryRoot:fixture.root}).candidates.bootstrapGenerations,
    [stalePair.bootstrapId]);
  const identity=file=>{const stat=fs.lstatSync(file,{bigint:true});return {
    dev:String(stat.dev),ino:String(stat.ino),ctimeNs:String(stat.ctimeNs),
  };};
  return {fixture,stalePair,current,runtime,generation,generationLease,
    generationIdentity:identity(generation),leaseIdentity:identity(generationLease),identity};
}

async function retainedGenerationFixture(t,{prunePrepared=false,inactiveRoot=false,secondCandidate=false}={}) {
  const fixture=await createRuntimeFixture(t);
  const releaseC=await fixture.prepare();
  let releaseD;
  if(secondCandidate){
    fixture.write('scripts/runtime-entry.mjs','export const unreferencedD = true;\n');
    releaseD=await fixture.prepare();
  }
  fixture.write('scripts/runtime-entry.mjs','export const retainedA = true;\n');
  const releaseA=await fixture.prepare();
  fixture.write('scripts/runtime-entry.mjs','export const retainedB = true;\n');
  const releaseB=await fixture.prepare();
  const store=await import('./runtime-store.mjs');
  const deploy=acquireLease(path.join(fixture.root,'.jhw-runtime/deploy.lock'));
  let pairC;let pairD;let pairA;let pairB;
  try {
    pairC=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,
      releaseId:releaseC.releaseId,deployLease:deploy});
    if(releaseD)pairD=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,
      releaseId:releaseD.releaseId,deployLease:deploy});
    pairA=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,
      releaseId:releaseA.releaseId,deployLease:deploy});
    pairB=store.ensureBootstrapGeneration({repositoryRoot:fixture.root,
      releaseId:releaseB.releaseId,deployLease:deploy});
  } finally {deploy.close();}
  fixture.seedPair(pairA);
  const admission=acquireLease(path.join(fixture.root,'.jhw-runtime/admission.lock'),
    {shared:true,create:true});
  let rootA=store.bindEntryPair({repositoryRoot:fixture.root,kind:'session',
    selectedPair:pairA,admissionLease:admission});
  const current=fixture.seedPair(pairB);
  let rootB=store.bindEntryPair({repositoryRoot:fixture.root,kind:'session',
    selectedPair:pairB,admissionLease:admission});
  let inactive;
  if(inactiveRoot){
    inactive=store.bindEntryPair({repositoryRoot:fixture.root,kind:'session',
      selectedPair:pairB,admissionLease:admission});
    inactive.lease.close();inactive.generationLease.close();
  }
  t.after(()=>{inactive?.close();rootB?.close();rootA?.close();admission.close();});
  const runtime=path.join(fixture.root,'.jhw-runtime');
  const generation=path.join(runtime,'v2/bootstraps',pairC.bootstrapId);
  fs.utimesSync(generation,new Date(Date.now()-40*DAY),new Date(Date.now()-40*DAY));
  const generationD=pairD?path.join(runtime,'v2/bootstraps',pairD.bootstrapId):null;
  if(generationD)fs.utimesSync(generationD,new Date(Date.now()-40*DAY),new Date(Date.now()-40*DAY));
  const roots=store.inspectSessionBindingsV2({repositoryRoot:fixture.root})
    .filter(row=>row.kind==='session'&&row.live).map(({live,...row})=>row);
  assert.equal(roots.length,2);
  const evidence=store.prepareRuntimeEvidence({repositoryRoot:fixture.root,pairs:[pairA,pairB]});
  t.after(()=>evidence.close());
  const prepare=prunePrepared
    ?store.preparePrunePublicationEvidence:store.preparePairPublicationEvidence;
  const prepared=prepare({
    repositoryRoot:fixture.root,evidence,current,roots,
  });
  const preparedPlan=prepareRuntimePrune({repositoryRoot:fixture.root});
  assert.deepEqual(new Set(preparedPlan.plan.candidates.bootstrapGenerations),
    new Set([pairC.bootstrapId,...(pairD?[pairD.bootstrapId]:[])]));
  return {
    fixture,store,pairC,pairD,pairA,pairB,current,runtime,generation,generationD,
    evidence,prepared,preparedPlan,
    generationA:path.join(runtime,'v2/bootstraps',pairA.bootstrapId),
    generationB:path.join(runtime,'v2/bootstraps',pairB.bootstrapId),
    releaseA:path.join(runtime,'releases',pairA.releaseId),
    inactive,
    retainedEvidence:{evidence,prepared},
    closeRootA(){rootA.close();rootA=null;},
  };
}

function applyRetainedFixture(value,{faultInjector}={}) {
  const deployLease=acquireLease(path.join(value.runtime,'deploy.lock'));
  const publicationLease=acquireLease(path.join(value.runtime,'publication.lock'),{create:true});
  try {
    return applyRuntimePrune({repositoryRoot:value.fixture.root,preparedPlan:value.preparedPlan,
      retainedEvidence:value.retainedEvidence,deployLease,publicationLease,faultInjector});
  } finally {publicationLease.close();deployLease.close();}
}

test('retained A and B evidence stays valid through C capture', async t => {
  const value=await retainedGenerationFixture(t);
  let durable=false;let generationLocked=false;
  const result=applyRetainedFixture(value,{faultInjector:point=>{
    if(point==='after_recovery_durable')durable=fs.existsSync(path.join(value.runtime,'.prune.v1'));
    if(point==='generation_ex_acquired')generationLocked=true;
  }});
  assert.equal(durable,true);
  assert.equal(generationLocked,true);
  assert.equal(result.removed.bootstrapGenerations,1);
  assert.equal(fs.existsSync(value.generation),false);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
});

test('a retained root ending at generation capture preserves C and recovery evidence', async t => {
  const value=await retainedGenerationFixture(t);
  let durable=false;let rootClosed=false;
  assert.throws(()=>applyRetainedFixture(value,{faultInjector:point=>{
    if(point==='after_recovery_durable')durable=true;
    if(point==='generation_ex_acquired'){value.closeRootA();rootClosed=true;}
  }}),{code:'DEPLOY_PRUNE_PARTIAL',reason:'snapshot_changed'});
  assert.equal(durable,true);
  assert.equal(rootClosed,true);
  assert.equal(fs.existsSync(value.generation),true);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),true);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1/recovery.00000000')),true);
  const state=JSON.parse(fs.readFileSync(path.join(value.runtime,'.prune.v1/state.json')));
  assert.equal(state.phase,'copies_durable');
  assert.deepEqual(state.removed,{journals:0,previous:0,bootstrapGenerations:0});
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
});

test('a retained root ending after one deletion preserves the second candidate and both recoveries', async t => {
  const value=await retainedGenerationFixture(t,{secondCandidate:true});
  const candidates=value.preparedPlan.plan.candidates.bootstrapGenerations;
  const directories=new Map([
    [value.pairC.bootstrapId,value.generation],
    [value.pairD.bootstrapId,value.generationD],
  ]);
  const first=directories.get(candidates[0]);
  const second=directories.get(candidates[1]);
  const secondIdentity=plannedIdentity(second);
  let rootClosed=false;
  assert.throws(()=>applyRetainedFixture(value,{faultInjector:(point,details)=>{
    if(point==='after_capture_rmdir_sync'&&details.index===0){
      value.closeRootA();rootClosed=true;
    }
  }}),{code:'DEPLOY_PRUNE_PARTIAL',reason:'snapshot_changed'});
  assert.equal(rootClosed,true);
  assert.equal(fs.existsSync(first),false);
  assert.equal(fs.existsSync(second),true);
  assert.deepEqual(plannedIdentity(second),secondIdentity);
  const marker=path.join(value.runtime,'.prune.v1');
  const recovery0=path.join(marker,'recovery.00000000');
  const recovery1=path.join(marker,'recovery.00000001');
  assert.equal(fs.existsSync(path.join(recovery0,'payload')),true);
  assert.equal(fs.existsSync(path.join(recovery1,'payload')),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(recovery0,'inventory.json'))).name,candidates[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(recovery1,'inventory.json'))).name,candidates[1]);
  const state=JSON.parse(fs.readFileSync(path.join(marker,'state.json')));
  assert.equal(state.phase,'removing_originals');
  assert.deepEqual(state.removed,{journals:0,previous:0,bootstrapGenerations:1});
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(value.generationA),true);
  assert.equal(fs.existsSync(value.generationB),true);
});

test('closed retained release evidence blocks prune before recovery evidence', async t => {
  const value=await retainedGenerationFixture(t);
  value.evidence.close();
  assert.throws(()=>applyRetainedFixture(value),
    {code:'DEPLOY_SOURCE_CHANGED'});
  assert.equal(fs.existsSync(value.generation),true);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
});

test('retained release metadata drift blocks prune before recovery evidence', async t => {
  const value=await retainedGenerationFixture(t);
  const releaseFile=path.join(value.releaseA,'scripts/runtime-entry.mjs');
  const bytes=fs.readFileSync(releaseFile);
  const beforeRelease=fs.statSync(releaseFile,{bigint:true});
  const objects=[value.generation,value.generationA,value.generationB].map(plannedIdentity);
  fs.utimesSync(releaseFile,Number(beforeRelease.atimeNs)/1e9,Number(beforeRelease.mtimeNs)/1e9+10);
  assert.deepEqual(fs.readFileSync(releaseFile),bytes);
  assert.notEqual(fs.statSync(releaseFile,{bigint:true}).mtimeNs,beforeRelease.mtimeNs);
  assert.throws(()=>applyRetainedFixture(value),{code:'DEPLOY_SOURCE_CHANGED'});
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
  assert.deepEqual([value.generation,value.generationA,value.generationB].map(plannedIdentity),objects);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
});

test('prune retained evidence tolerates an inactive published root', async t => {
  const value=await retainedGenerationFixture(t,{prunePrepared:true,inactiveRoot:true});
  const before=value.store.inspectSessionBindingsV2({repositoryRoot:value.fixture.root});
  assert.equal(before.some(row=>row.id===value.inactive.id&&!row.live),true);
  const result=applyRetainedFixture(value);
  assert.equal(result.removed.bootstrapGenerations,1);
  assert.equal(fs.existsSync(value.generation),false);
  const after=value.store.inspectSessionBindingsV2({repositoryRoot:value.fixture.root});
  assert.equal(after.some(row=>row.id===value.inactive.id&&!row.live),true);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
});

test('public prune rejects a live v1 session and preserves a released v1 record', async t => {
  const value=await unreferencedGenerationFixture(t);
  const {root:repositoryRoot,home,environment}=value.fixture;
  const procRoot=path.join(home,'legacy-session-prune-proc');
  fs.mkdirSync(procRoot,{mode:0o700});
  const apply=()=>runDeployment({repositoryRoot,home,procRoot,environment,argv:['--prune','--apply']});
  const store=await import('./runtime-store.mjs');
  const releaseId=value.current.releaseId;
  const live=store.createSessionBinding({repositoryRoot,releaseId});
  try {
    await assert.rejects(apply(),{code:'DEPLOY_COMPATIBILITY_MISMATCH',reason:'v1_session'});
    assert.equal(fs.existsSync(value.generation),true);
    assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
  } finally {live.close();}

  // An exited v1 owner leaves a valid public record and releases its kernel lease.
  const moduleUrl=new URL('./runtime-store.mjs',import.meta.url).href;
  const childSource=[
    'import {createSessionBinding} from '+JSON.stringify(moduleUrl),
    'const [repositoryRoot,releaseId]=process.argv.slice(1)',
    'console.log(createSessionBinding({repositoryRoot,releaseId}).id)',
  ].join('\n');
  const child=spawnSync(process.execPath,['--input-type=module','-e',childSource,repositoryRoot,releaseId],
    {encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);
  const id=child.stdout.trim();
  assert.match(id,/^s-[a-f0-9]{32}$/);
  assert.deepEqual(store.inspectSessionBindings({repositoryRoot}),[]);
  const manifest=path.join(value.runtime,'sessions',id,'manifest.json');
  const before=value.identity(manifest);
  const result=await apply();
  assert.equal(result.code,'DEPLOY_PRUNED');
  assert.equal(result.removed.bootstrapGenerations,1);
  assert.equal(fs.existsSync(value.generation),false);
  assert.deepEqual(value.identity(manifest),before);
  assert.deepEqual(readActivation({repositoryRoot}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
});

test('public prune preserves C when retained release metadata cannot be read after recovery', async t => {
  const value=await retainedGenerationFixture(t,{prunePrepared:true});
  const marker=path.join(value.runtime,'.prune.v1');
  const procRoot=path.join(value.fixture.home,'retained-prune-proc');
  fs.mkdirSync(procRoot,{mode:0o700});
  const originalFstat=fs.fstatSync;let injected=0;
  fs.fstatSync=function(fd,...args){
    let target;
    try{target=fs.readlinkSync('/proc/self/fd/'+fd);}catch{}
    if(target===value.releaseA&&fs.existsSync(path.join(marker,'state.json'))){
      const state=JSON.parse(fs.readFileSync(path.join(marker,'state.json')));
      if(state.phase==='copies_durable'){
        injected++;
        throw Object.assign(new Error('fixture metadata read failed'),{code:'EIO'});
      }
    }
    return originalFstat.call(this,fd,...args);
  };
  try {
    await assert.rejects(runDeployment({repositoryRoot:value.fixture.root,home:value.fixture.home,
      procRoot,environment:value.fixture.environment,
      argv:['--prune','--apply']}),{code:'DEPLOY_PRUNE_PARTIAL',reason:'snapshot_changed'});
  } finally {fs.fstatSync=originalFstat;}
  assert.ok(injected>0);
  assert.equal(fs.existsSync(value.generation),true);
  assert.equal(fs.existsSync(path.join(marker,'recovery.00000000')),true);
  const state=JSON.parse(fs.readFileSync(path.join(marker,'state.json')));
  assert.equal(state.phase,'copies_durable');
  assert.deepEqual(state.removed,{journals:0,previous:0,bootstrapGenerations:0});
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
});

test('public prune accepts the prepared verifier in both scans and removes only C', async t => {
  const value=await retainedGenerationFixture(t,{prunePrepared:true});
  const {row}=await startBoundSessionChild(t,value);
  const procRoot=path.join(value.fixture.home,'bound-retained-prune-proc');
  fs.mkdirSync(procRoot,{mode:0o700});
  stableProcEntry({procRoot,repositoryRoot:value.fixture.root,pid:row.owner.pid,
    startTime:row.owner.startTime,token:row.token});

  const releaseReads=countReleaseReadsDuringProcScans(procRoot,path.join(value.runtime,'releases'));
  let result;let procReads;
  try{
    result=await runDeployment({repositoryRoot:value.fixture.root,home:value.fixture.home,
      procRoot,environment:value.fixture.environment,argv:['--prune','--apply']});
  }finally{procReads=releaseReads.close();}
  assert.equal(procReads,4);
  assert.deepEqual(releaseReads.counts,[0,0]);
  assert.equal(result.code,'DEPLOY_PRUNED');
  assert.equal(result.removed.bootstrapGenerations,1);
  assert.deepEqual(result.inventory.before.processes.bound,
    {tui:0,app_server:0,legacy:0,managed:1});
  assert.deepEqual(result.inventory.after.processes.bound,
    {tui:0,app_server:0,legacy:0,managed:1});
  assert.equal(result.inventory.before.processes.clear,true);
  assert.equal(result.inventory.after.processes.clear,true);
  assert.equal(fs.existsSync(value.generation),false);
  assert.equal(fs.existsSync(value.generationA),true);
  assert.equal(fs.existsSync(value.generationB),true);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
});

test('public prune uses baseline release validation for inactive public sessions', async t => {
  const value=await retainedGenerationFixture(t,{prunePrepared:true,inactiveRoot:true});
  const {row}=await startBoundSessionChild(t,value);
  const procRoot=path.join(value.fixture.home,'inactive-root-baseline-proc');
  fs.mkdirSync(procRoot,{mode:0o700});
  stableProcEntry({procRoot,repositoryRoot:value.fixture.root,pid:row.owner.pid,
    startTime:row.owner.startTime,token:row.token});
  const releaseReads=countReleaseReadsDuringProcScans(procRoot,path.join(value.runtime,'releases'));
  let result;let procReads;
  try{
    result=await runDeployment({repositoryRoot:value.fixture.root,home:value.fixture.home,
      procRoot,environment:value.fixture.environment,argv:['--prune','--apply']});
  }finally{procReads=releaseReads.close();}
  assert.equal(procReads,4);
  assert.ok(releaseReads.counts[0]>0,`first baseline scan read count: ${releaseReads.counts[0]}`);
  assert.ok(releaseReads.counts[1]>0,`second baseline scan read count: ${releaseReads.counts[1]}`);
  assert.equal(result.removed.bootstrapGenerations,1);
  assert.deepEqual(result.inventory.before.processes.bound,
    {tui:0,app_server:0,legacy:0,managed:1});
  assert.deepEqual(result.inventory.after.processes.bound,
    {tui:0,app_server:0,legacy:0,managed:1});
  assert.equal(fs.existsSync(value.generation),false);
  assert.equal(fs.existsSync(value.generationA),true);
  assert.equal(fs.existsSync(value.generationB),true);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
});

for(const boundary of [
  {name:'first',procRead:2},
  {name:'second',procRead:4},
])test(`public prune rejects retained source drift after the ${boundary.name} PID scan`, async t => {
  const value=await retainedGenerationFixture(t,{prunePrepared:true});
  const procRoot=path.join(value.fixture.home,`${boundary.name}-source-drift-proc`);
  fs.mkdirSync(procRoot,{mode:0o700});
  const releaseFile=path.join(value.releaseA,'scripts/runtime-entry.mjs');
  const initial=fs.statSync(releaseFile,{bigint:true});
  const originalOpendir=fs.opendirSync;let procReads=0;
  fs.opendirSync=function(directory,...args){
    const opened=originalOpendir.call(this,directory,...args);
    let target;
    try{target=fs.realpathSync(directory);}catch{}
    if(target===fs.realpathSync(procRoot)&&++procReads===boundary.procRead){
      fs.utimesSync(releaseFile,Number(initial.atimeNs)/1e9,Number(initial.mtimeNs)/1e9+10);
    }
    return opened;
  };
  let failure;
  try {
    try{
      await runDeployment({repositoryRoot:value.fixture.root,home:value.fixture.home,
        procRoot,environment:value.fixture.environment,argv:['--prune','--apply']});
    }catch(error){failure=error;}
  } finally {fs.opendirSync=originalOpendir;}
  assert.equal(failure?.code,'DEPLOY_SOURCE_CHANGED');
  assert.match(failure?.stack??'',/completeRetainedPruneInventory/,
    'the scan post-check must reject before applyRuntimePrune pre-intent validation');
  assert.equal(procReads,boundary.procRead);
  assert.equal(fs.existsSync(value.generation),true);
  assert.equal(fs.existsSync(value.generationA),true);
  assert.equal(fs.existsSync(value.generationB),true);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
});

test('a generation lease acquired after durable recovery preserves C and cleans prune evidence', async t => {
  const value=await unreferencedGenerationFixture(t);
  const deploy=acquireLease(path.join(value.runtime,'deploy.lock'));
  const publication=acquireLease(path.join(value.runtime,'publication.lock'),{create:true});
  let generationLease;let durableMarker;let locksHeld=false;
  try {
    const result=applyRuntimePrune({repositoryRoot:value.fixture.root,
      deployLease:deploy,publicationLease:publication,
      faultInjector:point=>{
        if(point!=='after_recovery_durable')return;
        durableMarker=fs.existsSync(path.join(value.runtime,'.prune.v1'));
        let otherDeploy;let otherPublication;
        try{otherDeploy=acquireLease(path.join(value.runtime,'deploy.lock'));}
        catch(error){assert.equal(error.code,'DEPLOY_LOCK_CONTENDED');}
        try{otherPublication=acquireLease(path.join(value.runtime,'publication.lock'));}
        catch(error){assert.equal(error.code,'DEPLOY_LOCK_CONTENDED');}
        locksHeld=otherDeploy===undefined&&otherPublication===undefined;
        otherPublication?.close();otherDeploy?.close();
        generationLease=acquireLease(value.generationLease,{shared:true});
      }});
    assert.equal(result.removed.bootstrapGenerations,0);
  } finally {
    generationLease?.close();publication.close();deploy.close();
  }
  assert.equal(durableMarker,true);
  assert.equal(locksHeld,true);
  assert.equal(fs.existsSync(value.generation),true);
  assert.deepEqual(value.identity(value.generation),value.generationIdentity);
  assert.deepEqual(value.identity(value.generationLease),value.leaseIdentity);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
  assert.deepEqual(planRuntimePrune({repositoryRoot:value.fixture.root}).candidates.bootstrapGenerations,
    [value.stalePair.bootstrapId]);
});

test('a generation lease acquired after routing makes the final empty plan marker-free', async t => {
  const value=await unreferencedGenerationFixture(t);
  const preparedPlan=prepareRuntimePrune({repositoryRoot:value.fixture.root});
  assert.deepEqual(preparedPlan.plan.candidates.bootstrapGenerations,[value.stalePair.bootstrapId]);
  const deploy=acquireLease(path.join(value.runtime,'deploy.lock'));
  const publication=acquireLease(path.join(value.runtime,'publication.lock'),{create:true});
  const generationLease=acquireLease(value.generationLease,{shared:true});
  const points=[];const marker=path.join(value.runtime,'.prune.v1');
  const markerParent=fs.realpathSync(value.runtime);
  const mkdirSync=fs.mkdirSync;let markerCreateCalls=0;
  fs.mkdirSync=function(directory,...args){
    if(typeof directory==='string'&&path.basename(directory)==='.prune.v1'){
      try {
        if(fs.realpathSync(path.dirname(directory))===markerParent)markerCreateCalls++;
      } catch {}
    }
    return mkdirSync.call(this,directory,...args);
  };
  try {
    const result=applyRuntimePrune({repositoryRoot:value.fixture.root,
      preparedPlan,deployLease:deploy,publicationLease:publication,
      faultInjector:point=>{
        points.push(point);
        assert.equal(fs.existsSync(marker),false,point);
      }});
    assert.equal(result.removed.bootstrapGenerations,0);
  } finally {
    fs.mkdirSync=mkdirSync;
    generationLease.close();publication.close();deploy.close();
  }
  assert.deepEqual(points,['before_intent']);
  assert.equal(markerCreateCalls,0);
  assert.equal(fs.existsSync(value.generation),true);
  assert.deepEqual(value.identity(value.generation),value.generationIdentity);
  assert.deepEqual(value.identity(value.generationLease),value.leaseIdentity);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(marker),false);
});

test('a generation becoming eligible after route selection is blocked before prune intent', async t => {
  const value=await unreferencedGenerationFixture(t);
  const generationLease=acquireLease(value.generationLease,{shared:true});
  const preparedPlan=prepareRuntimePrune({repositoryRoot:value.fixture.root});
  assert.deepEqual(preparedPlan.plan.candidates.bootstrapGenerations,[]);
  const deploy=acquireLease(path.join(value.runtime,'deploy.lock'));
  const admission=acquireLease(path.join(value.runtime,'admission.lock'),{create:true});
  generationLease.close();
  const points=[];const marker=path.join(value.runtime,'.prune.v1');
  try {
    assert.throws(()=>applyRuntimePrune({repositoryRoot:value.fixture.root,
      preparedPlan,deployLease:deploy,admissionLease:admission,
      faultInjector:point=>{
        points.push(point);
        assert.equal(fs.existsSync(marker),false,point);
      }}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'snapshot_changed'});
  } finally {admission.close();deploy.close();}
  assert.deepEqual(points,['before_intent']);
  assert.equal(fs.existsSync(marker),false);
  assert.equal(fs.existsSync(value.generation),true);
  assert.deepEqual(value.identity(value.generation),value.generationIdentity);
  assert.deepEqual(value.identity(value.generationLease),value.leaseIdentity);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.deepEqual(planRuntimePrune({repositoryRoot:value.fixture.root})
    .candidates.bootstrapGenerations,[value.stalePair.bootstrapId]);
});

function plannedIdentity(file) {
  const stat=fs.lstatSync(file,{bigint:true});
  return {dev:String(stat.dev),ino:String(stat.ino),uid:Number(stat.uid),mode:Number(stat.mode&0o7777n)};
}

test('an unreadable final generation blocks apply before recovery starts', async t => {
  const value=await unreferencedGenerationFixture(t);
  const options={repositoryRoot:value.fixture.root};
  const preparedPlan=prepareRuntimePrune(options);
  const deployLease=acquireLease(path.join(value.runtime,'deploy.lock'));
  const publicationLease=acquireLease(path.join(value.runtime,'publication.lock'),{create:true});
  let checked=false;
  const marker=path.join(value.runtime,'.prune.v1');
  const readdir=fs.readdirSync;
  try {
    assert.throws(()=>applyRuntimePrune({...options,preparedPlan,deployLease,publicationLease,
      faultInjector(point) {
        if(point!=='before_intent')return;
        t.mock.method(fs,'readdirSync',function(directory,...args) {
          if(directory===value.generation){
            checked=true;
            assert.equal(fs.existsSync(marker),false);
            throw Object.assign(new Error('fixture read failed'),{code:'EIO'});
          }
          return readdir.call(this,directory,...args);
        });
      },
    }),{code:'DEPLOY_PRUNE_BLOCKED',reason:'snapshot_changed'});
  } finally {t.mock.restoreAll();publicationLease.close();deployLease.close();}
  assert.equal(checked,true);
  assert.equal(fs.existsSync(marker),false);
  assert.deepEqual(value.identity(value.generation),value.generationIdentity);
  assert.deepEqual(value.identity(value.generationLease),value.leaseIdentity);
});

test('generation reclaim rejects a mismatched planned lease proof before remove', async t => {
  const value=await unreferencedGenerationFixture(t);
  const store=await import('./runtime-store.mjs');
  const deploy=acquireLease(path.join(value.runtime,'deploy.lock'));
  const publication=acquireLease(path.join(value.runtime,'publication.lock'),{create:true});
  const wrongLease=path.join(value.runtime,'v2/bootstraps',value.current.bootstrapId,'lease');
  let removeCalls=0;let shared;
  try {
    const reclaim=()=>store.withUnreferencedBootstrapGeneration({
      repositoryRoot:value.fixture.root,bootstrapId:value.stalePair.bootstrapId,
      identity:plannedIdentity(value.generation),leaseIdentity:plannedIdentity(wrongLease),
      deployLease:deploy,publicationLease:publication,
      remove:()=>{removeCalls++;return true;},
    });
    assert.throws(reclaim,{code:'DEPLOY_BOOTSTRAP_CHANGED'});
    shared=acquireLease(value.generationLease,{shared:true});
    assert.throws(reclaim,{code:'DEPLOY_BOOTSTRAP_CHANGED'});
  } finally {shared?.close();publication.close();deploy.close();}
  assert.equal(removeCalls,0);
  assert.equal(fs.existsSync(value.generation),true);
  assert.deepEqual(value.identity(value.generation),value.generationIdentity);
  assert.deepEqual(value.identity(value.generationLease),value.leaseIdentity);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
});

test('retained generation reclaim still rejects a mismatched planned lease proof', async t => {
  const value=await unreferencedGenerationFixture(t);
  const store=await import('./runtime-store.mjs');
  const currentGeneration=path.join(value.runtime,'v2/bootstraps',value.current.bootstrapId);
  const currentLease=path.join(currentGeneration,'lease');
  const currentLeaseIdentity=plannedIdentity(currentLease);
  const deploy=acquireLease(path.join(value.runtime,'deploy.lock'));
  const publication=acquireLease(path.join(value.runtime,'publication.lock'),{create:true});
  let removeCalls=0;
  try {
    assert.throws(()=>store.withUnreferencedBootstrapGeneration({
      repositoryRoot:value.fixture.root,bootstrapId:value.current.bootstrapId,
      identity:plannedIdentity(currentGeneration),leaseIdentity:plannedIdentity(value.generationLease),
      deployLease:deploy,publicationLease:publication,
      remove:()=>{removeCalls++;return true;},
    }),{code:'DEPLOY_BOOTSTRAP_CHANGED'});
  } finally {publication.close();deploy.close();}
  assert.equal(removeCalls,0);
  assert.equal(fs.existsSync(currentGeneration),true);
  assert.deepEqual(plannedIdentity(currentLease),currentLeaseIdentity);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
});

test('an unchanged unreferenced generation is removed under deploy and publication locks', async t => {
  const value=await unreferencedGenerationFixture(t);
  const deploy=acquireLease(path.join(value.runtime,'deploy.lock'));
  const publication=acquireLease(path.join(value.runtime,'publication.lock'),{create:true});
  let durableMarker=false;let locksHeld=false;
  try {
    const result=applyRuntimePrune({repositoryRoot:value.fixture.root,
      deployLease:deploy,publicationLease:publication,
      faultInjector:point=>{
        if(point!=='after_recovery_durable')return;
        durableMarker=fs.existsSync(path.join(value.runtime,'.prune.v1'));
        let otherDeploy;let otherPublication;
        try{otherDeploy=acquireLease(path.join(value.runtime,'deploy.lock'));}
        catch(error){assert.equal(error.code,'DEPLOY_LOCK_CONTENDED');}
        try{otherPublication=acquireLease(path.join(value.runtime,'publication.lock'));}
        catch(error){assert.equal(error.code,'DEPLOY_LOCK_CONTENDED');}
        locksHeld=otherDeploy===undefined&&otherPublication===undefined;
        otherPublication?.close();otherDeploy?.close();
      }});
    assert.equal(result.removed.bootstrapGenerations,1);
  } finally {publication.close();deploy.close();}
  assert.equal(durableMarker,true);
  assert.equal(locksHeld,true);
  assert.equal(fs.existsSync(value.generation),false);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
  assert.deepEqual(planRuntimePrune({repositoryRoot:value.fixture.root}).candidates.bootstrapGenerations,[]);
});

test('public prune apply removes an unchanged C generation in an isolated fixture', async t => {
  const value=await unreferencedGenerationFixture(t);
  const procRoot=path.join(value.fixture.home,'empty-prune-proc');
  fs.mkdirSync(procRoot,{mode:0o700});
  const result=await runDeployment({repositoryRoot:value.fixture.root,home:value.fixture.home,
    procRoot,environment:value.fixture.environment,argv:['--prune','--apply']});
  assert.equal(result.code,'DEPLOY_PRUNED');
  assert.equal(result.removed.bootstrapGenerations,1);
  assert.equal(result.inventory.before.processes.clear,true);
  assert.equal(result.inventory.after.processes.clear,true);
  assert.equal(fs.existsSync(value.generation),false);
  assert.deepEqual(readActivation({repositoryRoot:value.fixture.root}),value.current);
  assert.equal(fs.existsSync(path.join(value.runtime,'.prune.v1')),false);
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
