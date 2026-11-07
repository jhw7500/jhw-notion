import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

const prune = await import('./runtime-prune.mjs');
const DAY=24*60*60*1000;
const NOW=Date.parse('2026-11-07T00:00:00.000Z');
const hash=value=>createHash('sha256').update(value).digest('hex');

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jhw-prune-'));fs.chmodSync(root,0o700);
 const runtime=path.join(root,'.jhw-runtime');fs.mkdirSync(runtime,{mode:0o700});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,runtime};
}
function write(file,value,mode=0o600) {fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value)+'\n',{mode});fs.chmodSync(file,mode);}
function current(sequence) {const id=sequence.toString(16).padStart(32,'0');return {activationId:`a-${id}`,releaseId:`r-${'a'.repeat(40)}-${'b'.repeat(64)}`,predecessorActivationId:null,observation:{target:`activations/a-${id}`,dev:'1',ino:String(sequence+1),ctimeNs:String(sequence+2)}};}
function journal(f,sequence,{age=60,status='complete',phase='complete',operation='activate',extra={},children={}}={}) {
 const name=`.deploy.${sequence.toString(16).padStart(32,'0')}`;const directory=path.join(f.runtime,name);fs.mkdirSync(directory,{mode:0o700});
 const previous=current(sequence+1000);const destination=current(sequence);destination.predecessorActivationId=previous.activationId;const state={version:1,status,operation,phase,previous,variables:Object.fromEntries(prune.DEPLOY_VARIABLE_KEYS.map(key=>[key,''])),mutationStarted:true,destination:{activationId:destination.activationId,releaseId:destination.releaseId,predecessorActivationId:destination.predecessorActivationId},current:destination,...extra};const stateText=JSON.stringify(state)+'\n';write(path.join(directory,'state.json'),stateText);
 const completedAt=new Date(NOW-age*DAY).toISOString();write(path.join(directory,'retention.json'),{version:1,sequence,journal:name,stateSha256:hash(stateText),completedAt,previous:null});
 for(const [child,value] of Object.entries(children))write(path.join(directory,child),value);
 const counter=path.join(f.runtime,'.retention-sequence.v1.json');write(counter,{version:1,sequence:Math.max(sequence,fs.existsSync(counter)?JSON.parse(fs.readFileSync(counter)).sequence:0)});
 return {name,directory,state,completedAt};
}
function names(runtime) {return fs.readdirSync(runtime).sort();}
function recoveryPayload(runtime,index=0) {
 const recovery=path.join(runtime,'.prune.v1',`recovery.${index.toString().padStart(8,'0')}`);
 const inventory=JSON.parse(fs.readFileSync(path.join(recovery,'inventory.json'),'utf8'));
 for(const record of inventory.files){
  const file=path.join(recovery,'payload',record.name);const bytes=fs.readFileSync(file);const info=fs.statSync(file,{bigint:true});
  assert.equal(bytes.length,record.size);assert.equal(hash(bytes),record.sha256);assert.equal(Number(info.mode&0o7777n),record.mode);
 }
 return {recovery,inventory};
}
function retainedPrevious(f,journalRecord,sequence) {
 const name=`.bootstrap.previous.${sequence.toString(16).padStart(32,'0')}`;const directory=path.join(f.runtime,name);fs.mkdirSync(directory,{mode:0o700});
 const files=[['jhw-runtime-control',0o755],['jhw-runtime-entry',0o755],['jhw-runtime-hook',0o755],['runtime-entry.mjs',0o644],['runtime-safety.mjs',0o644],['runtime-store.mjs',0o644]];const manifest={version:1,sourceReleaseId:`r-${'a'.repeat(40)}-${'b'.repeat(64)}`,files:files.map(([file,mode])=>({name:file,mode,sha256:hash(file)}))};for(const [file,mode] of files)write(path.join(directory,file),file,mode);write(path.join(directory,'manifest.json'),manifest);
 const info=fs.statSync(directory,{bigint:true});const receiptFile=path.join(journalRecord.directory,'retention.json');const receipt=JSON.parse(fs.readFileSync(receiptFile));
 const stateFile=path.join(journalRecord.directory,'state.json');const state=JSON.parse(fs.readFileSync(stateFile));state.operation='refresh-bootstrap';delete state.destination;delete state.current;state.bootstrap={prior:manifest,from:manifest.sourceReleaseId,to:manifest.sourceReleaseId,previousDirectory:name};const stateText=JSON.stringify(state)+'\n';write(stateFile,stateText);
 receipt.stateSha256=hash(stateText);receipt.previous={name,dev:String(info.dev),ino:String(info.ino),manifestSha256:hash(fs.readFileSync(path.join(directory,'manifest.json')))};write(receiptFile,receipt);return {name,directory,manifest};
}

test('dry-run is advisory and byte-for-byte non-mutating',()=>{
 const f=fixture(test);journal(f,1);const before=names(f.runtime).map(name=>[name,fs.statSync(path.join(f.runtime,name)).ino]);
 const result=prune.planRuntimePrune({repositoryRoot:f.root,now:NOW});
 assert.equal(result.code,'DEPLOY_PRUNE_PLAN');assert.equal(result.dryRun,true);assert.equal(result.removed.journals,0);
 assert.deepEqual(names(f.runtime).map(name=>[name,fs.statSync(path.join(f.runtime,name)).ino]),before);
});

test('bounded scanner accepts 4096 and 4097 entries and blocks cap plus one',()=>{
 const f=fixture(test);for(let i=0;i<4096;i++)fs.mkdirSync(path.join(f.runtime,`unknown-${i}`));
 assert.equal(prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}).observed.entries,4096);
 fs.mkdirSync(path.join(f.runtime,'unknown-4096'));
 assert.equal(prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}).observed.entries,4097);
 for(let i=4097;i<8193;i++)fs.mkdirSync(path.join(f.runtime,`unknown-${i}`));
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'scan_limit'});
});

test('one pending or unverified journal blocks the entire batch',()=>{
 const f=fixture(test);const eligible=journal(f,1);journal(f,2,{status:'pending',phase:'validate'});
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'pending_journal'});
 assert.equal(fs.existsSync(eligible.directory),true);
 fs.rmSync(path.join(f.runtime,'.deploy.00000000000000000000000000000002'),{recursive:true});
 const malformed=path.join(f.runtime,'.deploy.00000000000000000000000000000003');fs.mkdirSync(malformed,{mode:0o700});write(path.join(malformed,'state.json'),'{}\n');
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'unverified_journal'});
 assert.equal(fs.existsSync(eligible.directory),true);
});

test('30 days, newest 32, and completedAt ties are retained',()=>{
 const f=fixture(test);for(let sequence=1;sequence<=35;sequence++)journal(f,sequence,{age:40+sequence});
 // Tie the boundary record to its immediate predecessor; both must survive.
 const boundary=path.join(f.runtime,'.deploy.00000000000000000000000000000003/retention.json');const tied=JSON.parse(fs.readFileSync(boundary));
 tied.completedAt=JSON.parse(fs.readFileSync(path.join(f.runtime,'.deploy.00000000000000000000000000000004/retention.json'))).completedAt;write(boundary,tied);
 const result=prune.planRuntimePrune({repositoryRoot:f.root,now:NOW});
 assert.deepEqual(result.candidates.journals,['.deploy.00000000000000000000000000000001','.deploy.00000000000000000000000000000002']);
});

test('closed child set and regular 0600 nlink1 are required',()=>{
 const f=fixture(test);journal(f,1,{children:{'foreign.bin':'evidence'}});
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'unverified_journal'});
});

test('counter corruption and hard-linked journal children block all deletion',()=>{
 const f=fixture(test);journal(f,1);write(path.join(f.runtime,'.retention-sequence.v1.json'),'{bad json\n');
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'unverified_journal'});
 const g=fixture(test);const record=journal(g,1);fs.linkSync(path.join(record.directory,'retention.json'),path.join(g.runtime,'linked-receipt'));
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:g.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'unverified_journal'});
});

test('receipt mismatch, duplicate sequence, and unsafe mode are unverified',()=>{
 const mismatch=fixture(test);const a=journal(mismatch,1);const receipt=JSON.parse(fs.readFileSync(path.join(a.directory,'retention.json')));receipt.stateSha256='0'.repeat(64);write(path.join(a.directory,'retention.json'),receipt);
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:mismatch.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'unverified_journal'});
 const duplicate=fixture(test);journal(duplicate,1);const b=journal(duplicate,2);const duplicateReceipt=JSON.parse(fs.readFileSync(path.join(b.directory,'retention.json')));duplicateReceipt.sequence=1;write(path.join(b.directory,'retention.json'),duplicateReceipt);
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:duplicate.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'unverified_journal'});
 const unsafe=fixture(test);const c=journal(unsafe,1);fs.chmodSync(path.join(c.directory,'retention.json'),0o644);
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:unsafe.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'unverified_journal'});
});

test('sequence keeps newest previous and every unreferenced legacy previous',()=>{
 const f=fixture(test);const journals=[];for(let sequence=1;sequence<=34;sequence++)journals.push(journal(f,sequence,{age:60+sequence}));
 const first=retainedPrevious(f,journals[0],1);const latest=retainedPrevious(f,journals[1],2);const legacy=path.join(f.runtime,`.bootstrap.previous.${'f'.repeat(32)}`);fs.mkdirSync(legacy,{mode:0o700});
 const manifests=new Map([[first.name,first.manifest],[latest.name,latest.manifest]]);const result=prune.planRuntimePrune({repositoryRoot:f.root,now:NOW,validatePrevious:({name})=>manifests.get(name)});
 assert.deepEqual(result.candidates.previous,[first.name]);assert.equal(result.candidates.previous.includes(latest.name),false);assert.equal(result.candidates.previous.includes(path.basename(legacy)),false);
 const applied=prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW,validatePrevious:({name})=>manifests.get(name)});assert.equal(applied.removed.previous,1);assert.equal(applied.removed.journals,2);assert.equal(fs.existsSync(first.directory),false);assert.equal(fs.existsSync(latest.directory),true);assert.equal(fs.existsSync(legacy),true);
});

test('apply unlinks exact children without recursive removal',()=>{
 const f=fixture(test);for(let sequence=1;sequence<=34;sequence++)journal(f,sequence,{age:60+sequence});
 const plan=prune.planRuntimePrune({repositoryRoot:f.root,now:NOW});assert.deepEqual(plan.candidates.journals,['.deploy.00000000000000000000000000000001','.deploy.00000000000000000000000000000002']);
 const result=prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW});
 assert.equal(result.code,'DEPLOY_PRUNED');assert.equal(result.removed.journals,2);assert.equal(fs.existsSync(path.join(f.runtime,'.prune.v1')),false);
});

test('an interrupted capture preserves its durable recovery copy and blocks automatic resume',()=>{
 const f=fixture(test);for(let sequence=1;sequence<=33;sequence++)journal(f,sequence,{age:60+sequence});
 assert.throws(()=>prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW,faultInjector:point=>{if(point==='after_capture')throw new Error('crash');}}),{code:'DEPLOY_PRUNE_PARTIAL'});
 assert.equal(fs.existsSync(path.join(f.runtime,'.prune.v1')),true);
 recoveryPayload(f.runtime);
 assert.throws(()=>prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'previous_prune_incomplete'});
});

test('copy failure leaves every original unchanged and performs no original rename or unlink',()=>{
 const f=fixture(test);for(let sequence=1;sequence<=34;sequence++)journal(f,sequence,{age:60+sequence});
 const candidates=prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}).candidates.journals;const snapshots=new Map(candidates.map(name=>[name,fs.readFileSync(path.join(f.runtime,name,'state.json'))]));
 const real={rename:fs.renameSync,unlink:fs.unlinkSync};let renames=0,originalUnlinks=0;
 fs.renameSync=function(from,to,...args){if(candidates.some(name=>String(from).endsWith(`/${name}`)))renames++;return real.rename.call(this,from,to,...args);};
 fs.unlinkSync=function(file,...args){if(candidates.some(name=>String(file).includes(`/${name}/`)))originalUnlinks++;return real.unlink.call(this,file,...args);};
 try{assert.throws(()=>prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW,faultInjector:(point,context)=>{if(point==='after_recovery_file_sync'&&context.index===1){const error=new Error('no space');error.code='ENOSPC';throw error;}}}),{code:'DEPLOY_PRUNE_PARTIAL'});}finally{Object.assign(fs,{renameSync:real.rename,unlinkSync:real.unlink});}
 assert.equal(renames,0);assert.equal(originalUnlinks,0);for(const [name,bytes] of snapshots){assert.deepEqual(fs.readFileSync(path.join(f.runtime,name,'state.json')),bytes);}
});

test('source byte, mode, or link changes during copy preserve the original namespace',()=>{
 for(const mutation of ['bytes','mode','link']){
  const f=fixture(test);for(let sequence=1;sequence<=33;sequence++)journal(f,sequence,{age:60+sequence});const name='.deploy.00000000000000000000000000000001';const state=path.join(f.runtime,name,'state.json');
  assert.throws(()=>prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW,faultInjector:point=>{if(point!=='after_recovery_file_sync')return;if(mutation==='bytes')write(state,'changed\n');if(mutation==='mode')fs.chmodSync(state,0o640);if(mutation==='link')fs.linkSync(state,path.join(f.runtime,'race-link'));}}),{code:'DEPLOY_PRUNE_PARTIAL'});
  assert.equal(fs.existsSync(path.join(f.runtime,name)),true,mutation);
 }
});

test('a changed runtime snapshot is blocked before intent creation',()=>{
 const f=fixture(test);for(let sequence=1;sequence<=33;sequence++)journal(f,sequence,{age:60+sequence});
 assert.throws(()=>prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW,faultInjector:point=>{if(point==='before_intent')fs.mkdirSync(path.join(f.runtime,'racing-entry'));}}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'snapshot_changed'});
 assert.equal(fs.existsSync(path.join(f.runtime,'.prune.v1')),false);
});

test('runtime pathname replacement is never adopted as the scan root',()=>{
 const f=fixture(test);journal(f,1);const held=`${f.runtime}.held`;const replacement=path.join(f.root,'replacement');const realOpen=fs.opendirSync;let swapped=false;
 fs.opendirSync=function(name,...args){if(!swapped){swapped=true;fs.renameSync(f.runtime,held);fs.mkdirSync(replacement,{mode:0o700});fs.symlinkSync(replacement,f.runtime);}return realOpen.call(this,name,...args);};
 try{assert.throws(()=>prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'snapshot_changed'});}finally{fs.opendirSync=realOpen;}
 assert.equal(swapped,true);assert.equal(fs.readdirSync(replacement).length,0);assert.equal(fs.readdirSync(held).some(name=>name.startsWith('.deploy.')),true);
});

test('underspecified complete activate state blocks the whole batch',()=>{
 const f=fixture(test);journal(f,1,{age:90,extra:{previous:null,current:undefined,destination:undefined}});for(let sequence=2;sequence<=33;sequence++)journal(f,sequence,{age:60+sequence});
 assert.throws(()=>prune.planRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_BLOCKED',reason:'unverified_journal'});
});

test('apply makes all recovery copies durable before destination-then-source capture sync',()=>{
 const f=fixture(test);for(let sequence=1;sequence<=34;sequence++)journal(f,sequence,{age:60+sequence});const events=[];const real={mkdir:fs.mkdirSync,rename:fs.renameSync,rmdir:fs.rmdirSync,fsync:fs.fsyncSync};
 fs.mkdirSync=function(name,...args){const result=real.mkdir.call(this,name,...args);if(path.basename(String(name))==='.prune.v1')events.push('mkdir:prune');return result;};
 fs.renameSync=function(from,to,...args){const result=real.rename.call(this,from,to,...args);if(path.basename(String(to)).startsWith('capture.'))events.push('rename:capture');return result;};
 fs.rmdirSync=function(name,...args){const result=real.rmdir.call(this,name,...args);events.push(path.basename(String(name))==='.prune.v1'?'rmdir:prune':'rmdir:capture');return result;};
 fs.fsyncSync=function(fd,...args){let target='';try{target=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}const result=real.fsync.call(this,fd,...args);if(target===f.runtime)events.push('fsync:runtime');else if(target.endsWith('/.prune.v1'))events.push('fsync:evidence');else if(target.endsWith('/recovery.00000001'))events.push('fsync:recovery.00000001');return result;};
 try{prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW});}finally{Object.assign(fs,{mkdirSync:real.mkdir,renameSync:real.rename,rmdirSync:real.rmdir,fsyncSync:real.fsync});}
 const after=(needle,start)=>events.indexOf(needle,start+1);const mkdir=events.indexOf('mkdir:prune');const rename=events.indexOf('rename:capture');const captureRmdir=events.indexOf('rmdir:capture');const finalRmdir=events.lastIndexOf('rmdir:prune');
 assert.ok(after('fsync:runtime',mkdir)>mkdir,events);assert.ok(events.indexOf('fsync:recovery.00000001')<rename,events);const destinationSync=after('fsync:evidence',rename);assert.ok(destinationSync>rename,events);assert.ok(after('fsync:runtime',destinationSync)>destinationSync,events);assert.ok(after('fsync:evidence',captureRmdir)>captureRmdir,events);assert.ok(after('fsync:runtime',finalRmdir)>finalRmdir,events);
});

test('process-exit boundaries preserve an original or a verified recovery payload until durable deletion',()=>{
 const module=pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname),'runtime-prune.mjs')).href;
 for(const [point,check] of [
  ['after_intent_sync',f=>fs.existsSync(path.join(f.runtime,'.prune.v1/intent.json'))&&fs.existsSync(path.join(f.runtime,'.deploy.00000000000000000000000000000001'))],
  ['after_recovery_file_sync',f=>fs.existsSync(path.join(f.runtime,'.deploy.00000000000000000000000000000001'))],
  ['after_recovery_durable',f=>fs.existsSync(path.join(f.runtime,'.deploy.00000000000000000000000000000001'))&&Boolean(recoveryPayload(f.runtime))],
  ['after_destination_sync',f=>!fs.existsSync(path.join(f.runtime,'.deploy.00000000000000000000000000000001'))&&Boolean(recoveryPayload(f.runtime))],
  ['after_original_unlink',f=>Boolean(recoveryPayload(f.runtime))],
  ['before_recovery_cleanup',f=>!fs.existsSync(path.join(f.runtime,'.deploy.00000000000000000000000000000001'))&&Boolean(recoveryPayload(f.runtime))],
  ['after_recovery_cleanup_sync',f=>!fs.existsSync(path.join(f.runtime,'.prune.v1/recovery.00000000'))&&fs.existsSync(path.join(f.runtime,'.prune.v1/state.json'))],
  ['before_final_evidence_removal',f=>fs.existsSync(path.join(f.runtime,'.prune.v1/intent.json'))&&fs.existsSync(path.join(f.runtime,'.prune.v1/state.json'))],
  ['after_final_evidence_removal_sync',f=>fs.existsSync(path.join(f.runtime,'.prune.v1'))&&fs.readdirSync(path.join(f.runtime,'.prune.v1')).length===0],
  ['after_final_runtime_sync',f=>!fs.existsSync(path.join(f.runtime,'.prune.v1'))],
 ]) {
  const f=fixture(test);for(let sequence=1;sequence<=33;sequence++)journal(f,sequence,{age:60+sequence});
  const source=`import {applyRuntimePrune} from ${JSON.stringify(module)};applyRuntimePrune({repositoryRoot:${JSON.stringify(f.root)},now:${NOW},faultInjector:point=>{if(point===${JSON.stringify(point)})process.exit(77);}});`;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8'});assert.equal(child.status,77,`${point}: ${child.stderr}`);assert.equal(check(f),true,point);
 }
});

test('final runtime parent fsync failure reports removed evidence without fencing a later explicit empty apply',()=>{
 const f=fixture(test);for(let sequence=1;sequence<=33;sequence++)journal(f,sequence,{age:60+sequence});const pruneRoot=path.join(f.runtime,'.prune.v1');const realFsync=fs.fsyncSync;let injected=false;
 fs.fsyncSync=function(fd,...args){let target='';try{target=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}if(!injected&&target===f.runtime&&!fs.existsSync(pruneRoot)){injected=true;const error=new Error('simulated final parent fsync failure');error.code='EIO';throw error;}return realFsync.call(this,fd,...args);};
 try{assert.throws(()=>prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW}),{code:'DEPLOY_PRUNE_PARTIAL',reason:'evidence_removed_unsynced'});}finally{fs.fsyncSync=realFsync;}
 assert.equal(injected,true);assert.equal(fs.existsSync(pruneRoot),false);
 const explicitRetry=prune.applyRuntimePrune({repositoryRoot:f.root,now:NOW});assert.equal(explicitRetry.code,'DEPLOY_PRUNED');assert.deepEqual(explicitRetry.removed,{journals:0,previous:0});
});
