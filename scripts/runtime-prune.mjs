import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {validMigrationGuardReference,readGuardTransitionEvidence,sealMigrationGuardForward} from './runtime-guard.mjs';
import {DeploymentError,acquireLease,trustedDirectory,validLeaseCapability} from './runtime-safety.mjs';
import {validateRetainedBootstrap,validBootstrapObjectProof} from './runtime-entry.mjs';
import {validV1Current as validCurrent,validCurrent as validRuntimeCurrent,validRuntimePair,validTransitionWitness,readMigrationAnchor,snapshotBootstrapReferences,revalidateRetainedPruneEvidence,withUnreferencedBootstrapGeneration} from './runtime-store.mjs';
import {requireManagedScope} from './runtime-managed-scope.mjs';

const C=fs.constants;
const JOURNAL=/^\.deploy\.[a-f0-9]{32}$/;
const JOURNAL_V2=/^d-[a-f0-9]{32}$/;
const PREVIOUS=/^\.bootstrap\.previous\.[a-f0-9]{32}$/;
const LOG=/^(verify|wire|validate|finalize|rollback|uninstall)\.[a-f0-9]{16}\.log$/;
const OPERATIONS=new Set(['activate','rollback','uninstall','refresh-bootstrap']);
const SCAN_LIMIT=8192;
const FILE_LIMIT=256*1024;
const STATE_TOTAL_LIMIT=32*1024*1024;
const CANDIDATE_TOTAL_LIMIT=64*1024*1024;
const MIN_AGE_MS=30*24*60*60*1000;
const MIN_RECENT=32;
const MIN_RECENT_GENERATIONS=1;
const COUNTER='.retention-sequence.v1.json';
const PRUNE='.prune.v1';
const preparedPrunePlans = new WeakMap();
export const DEPLOY_VARIABLE_KEYS=['HOOK_LINK_CREATED','INSTALL_TRANSACTION_ACTIVE','HOOKS_CONFIG_CHANGED','HOOKS_CONFIG_FILE','HOOKS_ADAPTER','HOOKS_DISPLAY_NAME','HOOKS_TRANSACTION_DIR','HOOKS_TRANSACTION_STAGE','HOOKS_TRANSACTION_METADATA','HOOKS_TRANSACTION_PRESERVE','CLAUDE_HOOKS_CONFIG_CHANGED','CLAUDE_HOOKS_CONFIG_FILE','CLAUDE_HOOKS_TRANSACTION_DIR','CLAUDE_HOOKS_TRANSACTION_STAGE','CLAUDE_HOOKS_TRANSACTION_METADATA','CLAUDE_HOOKS_TRANSACTION_PRESERVE','CONTROL_HOOK_LINK_TRANSACTION_DIR','CONTROL_HOOK_LINK_TRANSACTION_STAGE','CONTROL_HOOK_LINK_TRANSACTION_METADATA','CONTROL_HOOK_LINK_TRANSACTION_PRESERVE','CONTROL_HOOK_LINK_REMOVE_OUTCOME','INSTALL_UNPROTECTED','MIGRATION_HOOK_TRANSACTION_DIR','CODEX_BACKUP_PRUNE_FILE','ENV_DROPPED','ENV_DROPPED_REPORTED'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value!==null&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const fail=(reason,partial=false)=>{throw new DeploymentError(partial?'DEPLOY_PRUNE_PARTIAL':'DEPLOY_PRUNE_BLOCKED',reason);};
const permissions=mode=>Number(typeof mode==='bigint'?mode&0o7777n:mode&0o7777);
const objectIdentity=stat=>({dev:String(stat.dev),ino:String(stat.ino),uid:Number(stat.uid),mode:permissions(stat.mode)});
const sameIdentity=(stat,identity)=>String(stat.dev)===identity.dev&&String(stat.ino)===identity.ino&&Number(stat.uid)===identity.uid&&permissions(stat.mode)===identity.mode;

class PinnedDirectory {
 constructor(name,{trusted=false,parentVerify=()=>{}}={}) {
  this.name=name;this.parentVerify=parentVerify;const initial=trusted?trustedDirectory(name):fs.lstatSync(name);this.fd=fs.openSync(name,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  this.stat=fs.fstatSync(this.fd,{bigint:true});
  if(!this.stat.isDirectory()||this.stat.uid!==BigInt(process.getuid())||(this.stat.mode&0o7777n)!==0o700n||String(initial.dev)!==String(this.stat.dev)||String(initial.ino)!==String(this.stat.ino)) {fs.closeSync(this.fd);fail('snapshot_changed');}
  try{this.verify();}catch(error){fs.closeSync(this.fd);throw error;}
 }
 at(name){if(typeof name!=='string'||!name||name.includes('/')||['.','..'].includes(name))fail('snapshot_changed');return `/proc/self/fd/${this.fd}/${name}`;}
 verify(){this.parentVerify();const held=fs.fstatSync(this.fd,{bigint:true});let named;try{named=fs.lstatSync(this.name,{bigint:true});}catch{fail('snapshot_changed');}if(!named.isDirectory()||!sameIdentity(held,objectIdentity(this.stat))||!sameIdentity(named,objectIdentity(this.stat)))fail('snapshot_changed');}
 sync(){fs.fsyncSync(this.fd);this.verify();}
 close(){if(this.fd!==undefined){fs.closeSync(this.fd);this.fd=undefined;}}
}
function runtimeDirectory(repositoryRoot) {return new PinnedDirectory(path.join(repositoryRoot,'.jhw-runtime'),{trusted:true});}
function scanNames(runtime) {
 const result=[];const stream=fs.opendirSync(`/proc/self/fd/${runtime.fd}`);
 try {let entry;while((entry=stream.readSync())!==null){if(result.length===SCAN_LIMIT)fail('scan_limit');result.push(entry.name);}}
 finally {stream.closeSync();}
 runtime.verify();
 return result.sort();
}
function readRegular(directory,name,limit=FILE_LIMIT,expectedProof=null) {
 const file=path.join(directory,name);let fd;
 try {
  fd=fs.openSync(file,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.size>BigInt(limit))fail('unverified_journal');
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
  while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  const after=fs.fstatSync(fd,{bigint:true});const named=fs.lstatSync(file,{bigint:true});
  for(const key of ['dev','ino','uid','mode','nlink','size','ctimeNs','mtimeNs'])if(before[key]!==after[key]||before[key]!==named[key])fail('unverified_journal');
  if(length!==Number(before.size))fail('unverified_journal');
  if(expectedProof!==null&&canonical(expectedProof)!==canonical({...objectIdentity(before),nlink:Number(before.nlink),
    mtimeNs:String(before.mtimeNs),ctimeNs:String(before.ctimeNs),sha256:digest(bytes.subarray(0,length))}))fail('unverified_journal');
  return {bytes:bytes.subarray(0,length),identity:objectIdentity(before),size:length};
 } catch(error) {if(error instanceof DeploymentError)throw error;fail('unverified_journal');}
 finally {if(fd!==undefined)fs.closeSync(fd);}
}
function readCandidateFile(directory,name,limit,requiredMode) {
 const file=path.join(directory,name);let fd;
 try {
  fd=fs.openSync(file,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||permissions(before.mode)!==requiredMode||before.size>BigInt(limit))fail('unverified_journal');
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  const after=fs.fstatSync(fd,{bigint:true});const named=fs.lstatSync(file,{bigint:true});for(const key of ['dev','ino','uid','mode','nlink','size','ctimeNs','mtimeNs'])if(before[key]!==after[key]||before[key]!==named[key])fail('unverified_journal');
  if(length!==Number(before.size))fail('unverified_journal');return {bytes:bytes.subarray(0,length),identity:objectIdentity(before),size:length};
 }catch(error){if(error instanceof DeploymentError)throw error;fail('unverified_journal');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function parseJson(bytes) {try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('unverified_journal');}}
function directoryIdentity(directory) {
 let info;try{info=fs.lstatSync(directory,{bigint:true});}catch{fail('unverified_journal');}
 if(!info.isDirectory()||info.uid!==BigInt(process.getuid())||(info.mode&0o7777n)!==0o700n)fail('unverified_journal');
 return objectIdentity(info);
}
function validPairDestination(value) {
 return exact(value,['version','activationId','releaseId','bootstrapId','runtimeContract','compatibilityDigest','predecessorActivationId','migrationId'])&&
  value.version===2&&/^a-[a-f0-9]{32}$/.test(value.activationId)&&validRuntimePair({releaseId:value.releaseId,
   bootstrapId:value.bootstrapId,runtimeContract:value.runtimeContract,compatibilityDigest:value.compatibilityDigest})&&
  (value.predecessorActivationId===null||/^a-[a-f0-9]{32}$/.test(value.predecessorActivationId))&&
  (value.migrationId===null||value.predecessorActivationId===null&&/^m-[a-f0-9]{32}$/.test(value.migrationId));
}

function validInitialInstallState(state) {
 if(!exact(state,['version','kind','status','phase','origin','candidate','destination','witness','published','wiring','adoptFrom','after','router','outcome'])||
   state.version!==2||state.kind!=='initial-install'||!['pending','complete'].includes(state.status)||
   !['prepared','router_intent','wire_intent','wired','pointer_intent','published','validation','restore_intent','complete'].includes(state.phase)||
   state.origin!==null||!validRuntimePair(state.candidate)||!validPairDestination(state.destination)||
   state.destination.migrationId!==null||state.destination.predecessorActivationId!==null||
   !validTransitionWitness(state.witness,null,state.destination)||
   canonical(state.candidate)!==canonical(Object.fromEntries(['releaseId','bootstrapId','runtimeContract','compatibilityDigest'].map(key=>[key,state.destination[key]])))||
   !(state.adoptFrom===null||typeof state.adoptFrom==='string'&&path.isAbsolute(state.adoptFrom)&&state.adoptFrom===path.resolve(state.adoptFrom))||
   !exact(state.wiring,['name','directory','before','listings'])||state.wiring.name!=='wiring'||
   !validWitnessIdentity(state.wiring.directory,{mode:0o700})||
   !validActivationWitness({directory:{...state.wiring.directory,mtimeNs:'0',ctimeNs:'0'},manifest:state.wiring.before})||
   !validActivationWitness({directory:{...state.wiring.directory,mtimeNs:'0',ctimeNs:'0'},manifest:state.wiring.listings})||
   state.after!==null&&!validActivationWitness({directory:{...state.wiring.directory,mtimeNs:'0',ctimeNs:'0'},manifest:state.after})||
   !exact(state.router,['stageName','stageProof','previousDirectory','previousProof','parkingDirectory'])||
   !/^\.bootstrap\.stage\.[a-f0-9]{32}$/.test(state.router.stageName)||!PREVIOUS.test(state.router.previousDirectory)||
   !/^\.bootstrap\.failed\.[a-f0-9]{32}$/.test(state.router.parkingDirectory)||!validBootstrapObjectProof(state.router.stageProof)||
   state.router.previousProof!==null&&!validBootstrapObjectProof(state.router.previousProof)||
   state.published!==null&&(!validRuntimeCurrent(state.published)||
    canonical(Object.fromEntries(Object.entries(state.published).filter(([key])=>key!=='observation')))!==canonical(state.destination)))return false;
 if(state.status==='complete')return state.phase==='complete'&&(state.outcome==='restored'&&state.published===null||state.outcome==='installed'&&state.published!==null&&state.after!==null);
 return state.phase!=='complete'&&state.outcome===null&&(!['wired','pointer_intent','published','validation'].includes(state.phase)||state.after!==null)&&
  (!['published','validation'].includes(state.phase)||state.published!==null);
}
// Restore replay may pretty-print a 2 MiB config up to the deployer's 32 MiB
// bound. These retained files are inventory only, never recovery authority.
const INITIAL_SCRATCH_FILE_LIMIT=32*1024*1024;
const INITIAL_SCRATCH_TOTAL_LIMIT=128*1024*1024;
const SCRATCH_UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const SCRATCH_TARGET=`[a-f0-9]{16}(?:\\.bak\\.jhw-notion\\.\\d{14}\\.${SCRATCH_UUID})?`;
const SCRATCH_FILE=new RegExp(`^${SCRATCH_TARGET}$`);
const SCRATCH_TEMP=new RegExp(`^\\.(${SCRATCH_TARGET})\\.\\d+\\.${SCRATCH_UUID}\\.tmp$`);
function readStableFile(file,limit,validate,{reason='unverified_journal',partial=false}={}) {
 let fd;
 try{
  fd=fs.openSync(file,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.size>BigInt(limit)||!validate(before))fail(reason,partial);
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
  while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  const after=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(file,{bigint:true});
  for(const key of ['dev','ino','uid','mode','nlink','size','ctimeNs','mtimeNs'])if(before[key]!==after[key]||before[key]!==named[key])fail(reason,partial);
  if(length!==Number(before.size))fail(reason,partial);
  return {bytes:bytes.subarray(0,length),identity:objectIdentity(before),size:length,nlink:Number(before.nlink),ctimeNs:String(before.ctimeNs),mtimeNs:String(before.mtimeNs)};
 }catch(error){if(error instanceof DeploymentError)throw error;fail(reason,partial);}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function readInitialScratchFile(directory,name,limit) {
 return readStableFile(path.join(directory,name),limit,before=>{
  const mode=permissions(before.mode);
  return [1n,2n].includes(before.nlink)&&(mode&~0o644)===0&&(mode&0o400)!==0;
 });
}
function readInitialWiring(journal,state,files) {
 const child=new PinnedDirectory(journal.at('wiring'),{parentVerify:()=>journal.verify()});let scratch;
 try{
  if(canonical(objectIdentity(child.stat))!==canonical(state.wiring.directory))fail('unverified_journal');
  const children=scanNames(child);
  if(children.length>64||!['state.json','before.json','listings.json'].every(name=>children.includes(name))||
    children.some(name=>!['state.json','before.json','listings.json','restore'].includes(name)&&!LOG.test(name)))fail('unverified_journal');
  const directory=`/proc/self/fd/${child.fd}`;
  files.set('wiring/before.json',readRegular(directory,'before.json',4*1024*1024,state.wiring.before));
  files.set('wiring/listings.json',readRegular(directory,'listings.json',16*1024*1024,state.wiring.listings));
  const workerRecord=readRegular(directory,'state.json'),worker=parseJson(workerRecord.bytes);
  const required=['version','status','operation','phase','previous','variables'],optional=['mutationStarted','workerDetached','stateIncomplete'];
  if(!worker||!required.every(key=>Object.hasOwn(worker,key))||Object.keys(worker).some(key=>![...required,...optional].includes(key))||
    worker.version!==1||worker.operation!=='activate'||worker.previous!==null||!['pending','complete'].includes(worker.status)||
    !['before_mutation','wire','validate','finalize','rollback','wire_rolled_back','complete'].includes(worker.phase)||
    optional.some(key=>Object.hasOwn(worker,key)&&worker[key]!==true)||
    !(exact(worker.variables,[])||validVariables(worker.variables))||
    worker.status==='complete'&&!['wire_rolled_back','complete'].includes(worker.phase)||
    state.status==='complete'&&(worker.status!=='complete'||worker.phase!==(state.outcome==='restored'?'wire_rolled_back':'complete')))fail('unverified_journal');
  files.set('wiring/state.json',workerRecord);let size=workerRecord.size;
  for(const name of children.filter(name=>LOG.test(name))){const record=readRegular(directory,name);files.set(`wiring/${name}`,record);size+=record.size;}
  if(children.includes('restore')){
   scratch=new PinnedDirectory(child.at('restore'),{parentVerify:()=>child.verify()});
   const names=scanNames(scratch);if(names.length>128)fail('scan_limit');let scratchSize=0;const linked=new Map();
   for(const name of names){
    const temporary=SCRATCH_TEMP.exec(name);if(!SCRATCH_FILE.test(name)&&!temporary)fail('unverified_journal');
    const record=readInitialScratchFile(`/proc/self/fd/${scratch.fd}`,name,Math.min(INITIAL_SCRATCH_FILE_LIMIT,INITIAL_SCRATCH_TOTAL_LIMIT-scratchSize));
    files.set(`wiring/restore/${name}`,record);scratchSize+=record.size;
    if(record.nlink===2){const key=`${record.identity.dev}:${record.identity.ino}`;if(!linked.has(key))linked.set(key,[]);linked.get(key).push({name,temporary:temporary?.[1]??null,record});}
   }
   for(const pair of linked.values()){
    const temporary=pair.find(item=>item.temporary!==null),target=pair.find(item=>item.temporary===null);
    if(pair.length!==2||!temporary||!target||temporary.temporary!==target.name||
      temporary.record.ctimeNs!==target.record.ctimeNs||temporary.record.mtimeNs!==target.record.mtimeNs||
      !temporary.record.bytes.equals(target.record.bytes))fail('unverified_journal');
   }
   if(canonical(scanNames(scratch))!==canonical(names))fail('unverified_journal');scratch.verify();
  }
  if(size>STATE_TOTAL_LIMIT)fail('scan_limit');if(canonical(scanNames(child))!==canonical(children))fail('unverified_journal');child.verify();
 }finally{scratch?.close();child.close();}
}
function validBootstrapMigrationState(state) {
 const phases=['prepared','guard_intent','router_intent','router_published','current_intent','pair_published','validation','restore_intent','complete'];
 if(!exact(state,['version','kind','operation','status','phase','migrationId','anchor','origin','destination','witness','published','guard','router','outcome'])||
   state.version!==2||state.kind!=='bootstrap-migration'||!['upgrade','legacy-rollback'].includes(state.operation)||
   !(state.guard===null||state.operation==='legacy-rollback'&&validMigrationGuardReference(state.guard)&&state.guard.migrationId===state.migrationId)||
   !['pending','complete'].includes(state.status)||!phases.includes(state.phase)||
   typeof state.migrationId!=='string'||!/^m-[a-f0-9]{32}$/.test(state.migrationId)||
   !exact(state.anchor,['directory','anchor'])||!validActivationWitness({directory:state.anchor.directory,manifest:state.anchor.anchor})||
   !validRuntimeCurrent(state.origin)||state.origin===null||
   !exact(state.router,['stageName','previousDirectory','stageProof','previousProof','parkingDirectory'])||
   !validBootstrapObjectProof(state.router.stageProof)||!validBootstrapObjectProof(state.router.previousProof)||
   !/^\.bootstrap\.failed\.[a-f0-9]{32}$/.test(state.router.parkingDirectory)||
   new Set([state.router.stageName,state.router.previousDirectory,state.router.parkingDirectory]).size!==3)return false;
 if(state.operation==='upgrade'){
  if(!validCurrent(state.origin)||state.origin.predecessorActivationId===null||!validPairDestination(state.destination)||
    state.destination.predecessorActivationId!==null||state.destination.migrationId!==state.migrationId||
    !/^\.bootstrap\.stage\.[a-f0-9]{32}$/.test(state.router.stageName)||!PREVIOUS.test(state.router.previousDirectory))return false;
 }else{
  if(state.origin.version!==2||state.origin.predecessorActivationId!==null||state.origin.migrationId!==state.migrationId||
    !exact(state.destination,['activationId','releaseId','predecessorActivationId'])||
    !validCurrent({...state.destination,observation:{target:`activations/${state.destination.activationId}`,dev:'0',ino:'0',ctimeNs:'0'}})||
    !PREVIOUS.test(state.router.stageName)||!/^\.bootstrap\.failed\.[a-f0-9]{32}$/.test(state.router.previousDirectory)||state.phase==='restore_intent')return false;
 }
 if(!validTransitionWitness(state.witness,state.origin,state.destination)||
   state.published!==null&&(!validRuntimeCurrent(state.published)||
    canonical(Object.fromEntries(Object.entries(state.published).filter(([key])=>key!=='observation')))!==canonical(state.destination)))return false;
 if(state.status==='complete')return state.phase==='complete'&&(
   state.operation==='upgrade'&&state.outcome==='restored'&&state.published===null||
   state.published!==null&&state.outcome===(state.operation==='upgrade'?'migrated':'rolled_back'));
 return state.phase!=='complete'&&state.outcome===null&&
   (!['pair_published','validation'].includes(state.phase)||state.published!==null);
}
function validWitnessIdentity(value,{times=false,links=null,mode}={}) {
 const keys=['dev','ino','uid','mode',...(links?['nlink']:[]),...(times?['mtimeNs','ctimeNs']:[])];
 return exact(value,keys)&&[value.dev,value.ino,...(times?[value.mtimeNs,value.ctimeNs]:[])].every(item=>typeof item==='string'&&/^\d{1,32}$/.test(item))&&
  Number.isSafeInteger(value.uid)&&value.uid===process.getuid()&&Number.isSafeInteger(value.mode)&&value.mode===mode&&
  (links===null||Number.isSafeInteger(value.nlink)&&value.nlink===links);
}
function validActivationWitness(value) {
 return exact(value,['directory','manifest'])&&validWitnessIdentity(value.directory,{times:true,mode:0o700})&&
  exact(value.manifest,['dev','ino','uid','mode','nlink','mtimeNs','ctimeNs','sha256'])&&
  validWitnessIdentity(Object.fromEntries(Object.entries(value.manifest).filter(([key])=>key!=='sha256')),{times:true,links:1,mode:0o600})&&
  typeof value.manifest.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.manifest.sha256);
}
function validPointerWitness(value,destination,initial=false) {
 return exact(value,['directory','pointer','origin','destination'])&&validWitnessIdentity(value.directory,{times:true,mode:0o700})&&
  exact(value.pointer,['dev','ino','uid','mode','target'])&&
  validWitnessIdentity(Object.fromEntries(Object.entries(value.pointer).filter(([key])=>key!=='target')),{mode:0o777})&&
  value.pointer.target===`v2/activations/${destination.activationId}`&&(initial?value.origin===null:validActivationWitness(value.origin))&&validActivationWitness(value.destination);
}
function validPairJournalState(state) {
 if(!exact(state,['version','kind','status','operation','phase','origin','candidate','destination','witness','outcome'])||
   state.version!==2||state.kind!=='pair'||!['pending','complete'].includes(state.status)||
   !['activate','rollback'].includes(state.operation)||!['prepared','blocked','pointer_intent','published','complete','rejected'].includes(state.phase)||
   !validRuntimeCurrent(state.origin)||(state.operation==='install'?state.origin!==null:state.origin?.version!==2)||!validRuntimePair(state.candidate)||
   !(state.destination===null||validPairDestination(state.destination)||validRuntimeCurrent(state.destination)&&state.destination?.version===2)||
   !(state.outcome===null||['pointer_not_published','pointer_published','candidate_rejected'].includes(state.outcome)))return false;
 if(state.operation==='install'&&state.destination!==null&&(state.destination.predecessorActivationId!==null||state.destination.migrationId!==null))return false;
 if(state.phase==='prepared')return state.status==='pending'&&state.destination===null&&state.witness===null&&state.outcome===null;
 if(state.phase==='blocked')return state.status==='pending'&&state.destination===null&&state.witness===null&&state.outcome===null;
 if(state.phase==='pointer_intent')return state.status==='pending'&&validPairDestination(state.destination)&&validPointerWitness(state.witness,state.destination,state.operation==='install')&&state.outcome===null;
 if(state.phase==='published')return state.status==='pending'&&validRuntimeCurrent(state.destination)&&state.destination?.version===2&&validPointerWitness(state.witness,state.destination,state.operation==='install')&&state.outcome===null;
 if(state.phase==='rejected')return state.status==='complete'&&['pointer_not_published','candidate_rejected'].includes(state.outcome);
 return state.status==='complete'&&validRuntimeCurrent(state.destination)&&state.destination?.version===2&&validPointerWitness(state.witness,state.destination,state.operation==='install')&&state.outcome==='pointer_published';
}
function validCodexIdentity(value) {
 return exact(value,['dev','ino','uid','mode','nlink','size'])&&[value.dev,value.ino,value.size].every(item=>typeof item==='string'&&/^\d{1,32}$/.test(item))&&
  value.uid===process.getuid()&&value.mode===0o600&&Number.isSafeInteger(value.nlink)&&value.nlink>=1&&value.nlink<=2;
}
function validCodexRecord(value) {return exact(value,['identity','sha256'])&&validCodexIdentity(value.identity)&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256);}
function validCodexObserved(value) {
 if(value===null)return true;
 return exact(value,['reason','live','quarantine','after','capturedAfter'])&&typeof value.reason==='string'&&value.reason.length<=128&&
  ['live','quarantine','after','capturedAfter'].every(key=>value[key]===null||validObservedCodexObject(value[key]));
}
function validObservedIdentity(value) {return exact(value,['dev','ino','uid','mode','nlink','size'])&&[value.dev,value.ino,value.size].every(item=>typeof item==='string'&&/^\d{1,32}$/.test(item))&&value.uid===process.getuid()&&Number.isSafeInteger(value.mode)&&value.mode>=0&&value.mode<=0o7777&&Number.isSafeInteger(value.nlink)&&value.nlink>=1;}
function validObservedCodexObject(value) {
 if(value?.kind==='file')return exact(value,['kind','identity','sha256'])&&validObservedIdentity(value.identity)&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256);
 if(value?.kind==='symlink')return exact(value,['kind','identity','targetSha256'])&&validObservedIdentity(value.identity)&&typeof value.targetSha256==='string'&&/^[a-f0-9]{64}$/.test(value.targetSha256);
 return value?.kind==='special'&&exact(value,['kind','identity'])&&validObservedIdentity(value.identity);
}
const CODEX_PHASES = ['prepared','quarantine_intent','quarantined','publish_intent','published',
 'foreign_restore_intent','restore_intent','quarantine_retire_intent','temp_capture_intent','temp_retire_intent','verified','ambiguous','complete'];
const CODEX_OUTCOMES = ['migrated','unchanged','restored-before'];
function validCodexCapture(value) {
 return exact(value,['name','identity']) && /^capture-[a-f0-9]{32}$/.test(value.name ?? '') &&
  validWitnessIdentity(value.identity,{mode:0o700});
}
function validCodexJournalState(state) {
 if(!exact(state,['version','kind','status','phase','config','editorReleaseId','before','after','captures','header','resolution','observed','outcome']) ||
  state.version!==2 || state.kind!=='codex-config' || !['pending','complete'].includes(state.status) || !CODEX_PHASES.includes(state.phase) ||
  typeof state.config!=='string' || !path.isAbsolute(state.config) || path.normalize(state.config)!==state.config || path.basename(state.config)!=='config.toml' || !RELEASE.test(state.editorReleaseId??'') ||
  !exact(state.before,['identity','sha256','copy']) || !validCodexIdentity(state.before.identity) || !validCodexIdentity(state.before.copy) ||
  !exact(state.after,['identity','sha256','copy']) || !validCodexIdentity(state.after.copy) || !validCodexRecord({identity:state.after.identity,sha256:state.after.sha256}) ||
  state.before.identity.nlink!==1 || state.before.copy.nlink!==1 || state.after.identity.nlink!==1 || state.after.copy.nlink!==1 ||
  typeof state.before.sha256!=='string' || !/^[a-f0-9]{64}$/.test(state.before.sha256) ||
  !exact(state.captures,['source','temp','control']) || !['source','temp','control'].every(key=>validCodexCapture(state.captures[key])) ||
  new Set(Object.values(state.captures).map(item=>item.name)).size!==3 || !validCodexRecord(state.header) || state.header.identity.nlink!==1 || !validCodexObserved(state.observed) ||
  !(state.resolution===null || CODEX_OUTCOMES.includes(state.resolution))) return false;
 if(state.status==='complete') return state.phase==='complete' && CODEX_OUTCOMES.includes(state.outcome) && state.resolution===state.outcome && state.observed===null;
 if(state.phase==='complete' || state.outcome!==null) return false;
 if(state.phase==='ambiguous') return state.observed!==null;
 if(state.phase==='foreign_restore_intent') return state.resolution===null && state.observed!==null &&
  state.observed.live===null && state.observed.capturedAfter===null &&
  ['file','symlink'].includes(state.observed.quarantine?.kind) && state.observed.quarantine.identity.nlink===1;
 if(state.observed!==null) return false;
 if(['restore_intent','quarantine_retire_intent'].includes(state.phase)) return state.resolution==='restored-before';
 if(['temp_capture_intent','temp_retire_intent','verified'].includes(state.phase)) return CODEX_OUTCOMES.includes(state.resolution);
 return state.resolution===null;
}
function readCodexObject(file,{allowLinks=[1],limit=2*1024*1024,observed=false}={}) {
 let fd;
 try {
  fd=fs.openSync(file,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile() || before.uid!==BigInt(process.getuid()) || before.size>BigInt(limit) ||
   (!observed && (permissions(before.mode)!==0o600 || !allowLinks.includes(Number(before.nlink))))) fail('unverified_journal');
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
  while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  const after=fs.fstatSync(fd,{bigint:true});const named=fs.lstatSync(file,{bigint:true});
  for(const key of ['dev','ino','uid','mode','nlink','size','ctimeNs','mtimeNs']) if(before[key]!==after[key] || before[key]!==named[key]) fail('unverified_journal');
  if(length!==Number(before.size)) fail('unverified_journal');
  return {bytes:bytes.subarray(0,length),info:after};
 } catch(error) {if(error instanceof DeploymentError)throw error;fail('unverified_journal');}
 finally {if(fd!==undefined)fs.closeSync(fd);}
}
function codexIdentity(info) {return {dev:String(info.dev),ino:String(info.ino),uid:Number(info.uid),mode:permissions(info.mode),nlink:Number(info.nlink),size:String(info.size)};}
export function readObservedCodexObject(file) {
 let info;try{info=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;fail('unverified_journal');}
 if(info.uid!==BigInt(process.getuid()))fail('unverified_journal');
 if(info.isSymbolicLink())return {kind:'symlink',identity:codexIdentity(info),targetSha256:digest(Buffer.from(fs.readlinkSync(file)))};
 if(!info.isFile())return {kind:'special',identity:codexIdentity(info)};
 const record=readCodexObject(file,{observed:true});
 return {kind:'file',identity:codexIdentity(record.info),sha256:digest(record.bytes)};
}
const codexObjectMatches=(actual,expected,links)=>actual?.kind==='file' && actual.sha256===expected.sha256 &&
 ['dev','ino','uid','mode','size'].every(key=>actual.identity[key]===expected.identity[key]) && links.includes(actual.identity.nlink);

const sameCodexObservedObject=(actual,expected,links)=>actual!==null && expected!==null && links.includes(actual.identity.nlink) &&
 canonical({...actual,identity:{...actual.identity,nlink:1}})===canonical({...expected,identity:{...expected.identity,nlink:1}});
function foreignCodexCapture(state,objects) {
 return ['quarantine_intent','quarantined','publish_intent'].includes(state.phase) && objects.live===null &&
  ['file','symlink'].includes(objects.quarantine?.kind) && objects.quarantine.identity.nlink===1 &&
  !codexObjectMatches(objects.quarantine,{identity:state.before.identity,sha256:state.before.sha256},[1]) &&
  codexObjectMatches(objects.after,state.after,[1]) && objects.capturedAfter===null;
}

// The worker and the public deploy/prune parser use this same actual-object table.
// Intent phases admit both sides of exactly one syscall, including proven nlink=2.
function codexStageMatches(state,objects) {
 const {live,quarantine,after,capturedAfter}=objects;
 const before={identity:state.before.identity,sha256:state.before.sha256};
 const lb=n=>codexObjectMatches(live,before,[n]);
 const la=n=>codexObjectMatches(live,state.after,[n]);
 const q=n=>codexObjectMatches(quarantine,before,[n]);
 const a=n=>codexObjectMatches(after,state.after,[n]);
 const c=n=>codexObjectMatches(capturedAfter,state.after,[n]);
 const original=(lb(1)&&!quarantine)||(!live&&q(1));
 const published=la(2)&&q(1)&&a(2)&&!capturedAfter;
 const restored=state.resolution==='migrated' ? q(1) : !quarantine;
 const finalLive=state.resolution==='migrated' ? la(1) : lb(1);
 const cleanupLive=n=>state.resolution==='migrated' ? la(n)&&q(1) : lb(1)&&!quarantine;
 switch(state.phase) {
  case 'prepared': return lb(1)&&!quarantine&&a(1)&&!capturedAfter;
  case 'quarantine_intent': return original&&a(1)&&!capturedAfter;
  case 'quarantined': return !live&&q(1)&&a(1)&&!capturedAfter;
  case 'publish_intent': return (!live&&q(1)&&a(1)&&!capturedAfter)||published;
  case 'published': return published;
  case 'foreign_restore_intent': {
   const captured=state.observed.quarantine;
   const beforeLink=!live&&sameCodexObservedObject(quarantine,captured,[1]);
   const afterLink=sameCodexObservedObject(live,captured,[2])&&sameCodexObservedObject(quarantine,captured,[2]);
   return (beforeLink||afterLink)&&a(1)&&!capturedAfter&&codexObjectMatches(state.observed.after,state.after,[1]);
  }
  case 'restore_intent': return ((!live&&q(1))||(lb(2)&&q(2)))&&a(1)&&!capturedAfter;
  case 'quarantine_retire_intent': return ((lb(2)&&q(2))||(lb(1)&&!quarantine))&&a(1)&&!capturedAfter;
  case 'temp_capture_intent': {
   const links=state.resolution==='migrated'?2:1;
   return cleanupLive(links)&&((a(links)&&!capturedAfter)||(!after&&c(links)));
  }
  case 'temp_retire_intent': {
   const links=state.resolution==='migrated'?2:1;
   return !after&&((cleanupLive(links)&&c(links))||(finalLive&&restored&&!capturedAfter));
  }
  case 'verified': return finalLive&&restored&&!after&&!capturedAfter;
  case 'ambiguous': return canonical(objects)===canonical(Object.fromEntries(Object.entries(state.observed).filter(([key])=>key!=='reason')));
  default: return false;
 }
}

/** Shared one-file transaction evidence reader, also used directly by the editor. */
export function readCodexMigrationJournal({journalDirectory}) {
 let journal;let control;const captures=[];
 try {
  journal=new PinnedDirectory(journalDirectory);
  const headerRecord=readRegular(`/proc/self/fd/${journal.fd}`,'state.json',FILE_LIMIT);
  const header=parseJson(headerRecord.bytes);
  if(!exact(header,['version','kind','control']) || header.version!==2 || header.kind!=='codex-config' || !validCodexCapture(header.control))fail('unverified_journal');
  control=new PinnedDirectory(journal.at(header.control.name),{parentVerify:()=>journal.verify()});
  if(!sameIdentity(control.stat,header.control.identity) || fs.readdirSync(`/proc/self/fd/${control.fd}`).join(',')!=='state.json')fail('unverified_journal');
  const record=readRegular(`/proc/self/fd/${control.fd}`,'state.json',FILE_LIMIT);
  const state=parseJson(record.bytes);
  if(!validCodexJournalState(state) || canonical(state.captures.control)!==canonical(header.control) ||
   !sameIdentity(fs.lstatSync(journal.at('state.json'),{bigint:true}),state.header.identity) || headerRecord.size!==Number(state.header.identity.size) ||
   digest(headerRecord.bytes)!==state.header.sha256)fail('unverified_journal');
  const names=fs.readdirSync(`/proc/self/fd/${journal.fd}`);
  const allowed=['state.json','before','after-copy','after','retention.json',...Object.values(state.captures).map(item=>item.name)];
  if(names.some(name=>!allowed.includes(name)))fail('unverified_journal');
  for(const [name,expected] of [['before',state.before],['after-copy',state.after]]) {
   const copy=readCodexObject(journal.at(name));
   if(!codexObjectMatches({kind:'file',identity:codexIdentity(copy.info),sha256:digest(copy.bytes)}, {identity:expected.copy,sha256:expected.sha256},[1])) fail('unverified_journal');
  }
  // Completion proves historical success only. Mutable live/capture objects are
  // not evidence for that claim and are not opened, hashed or link-counted here.
  // GC must obtain separate actual-object inventory before authorizing removal.
  if(state.status==='complete') {
   control.verify();journal.verify();
   return {state,objects:null,record,classification:'complete'};
  }
  const paths={};
  for(const key of ['source','temp']) {
   const expected=state.captures[key];
   const capture=new PinnedDirectory(journal.at(expected.name),{parentVerify:()=>journal.verify()});captures.push(capture);
   if(!sameIdentity(capture.stat,expected.identity) || fs.readdirSync(`/proc/self/fd/${capture.fd}`).some(name=>name!=='object'))fail('unverified_journal');
   paths[key]=capture.at('object');
  }
  const objects={live:readObservedCodexObject(state.config),
   quarantine:readObservedCodexObject(paths.source),after:readObservedCodexObject(journal.at('after')),
   capturedAfter:readObservedCodexObject(paths.temp)};
  const classification=foreignCodexCapture(state,objects)?'foreign-capture':
   state.phase==='foreign_restore_intent'?'foreign-restore':state.phase==='ambiguous'?'ambiguous':'active';
  if(classification!=='foreign-capture'&&!codexStageMatches(state,objects))fail('unverified_journal');
  for(const capture of captures)capture.verify();control.verify();journal.verify();
  return {state,objects,record,classification};
 } finally {for(const capture of captures)capture.close();control?.close();journal?.close();}
}
function verifyPairWitnessFiles({repositoryRoot,journalDirectory,state}) {
 const witnessDirectory=path.join(journalDirectory,'pointer-witness');
 if(state.witness===null){if(fs.existsSync(witnessDirectory))fail('unverified_journal');return;}
 let directory;let pointer;let target;
 try{
  directory=fs.lstatSync(witnessDirectory,{bigint:true});pointer=fs.lstatSync(path.join(witnessDirectory,'current'),{bigint:true});
  target=fs.readlinkSync(path.join(witnessDirectory,'current'));
 }catch(error){if(error instanceof DeploymentError)throw error;fail('unverified_journal');}
 const identity=(stat,{times=false,links=false}={})=>({dev:String(stat.dev),ino:String(stat.ino),uid:Number(stat.uid),mode:permissions(stat.mode),
  ...(links?{nlink:Number(stat.nlink)}:{}),...(times?{mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)}:{})});
 if(!directory.isDirectory()||!pointer.isSymbolicLink()||
  fs.readdirSync(witnessDirectory).join(',')!=='current'||JSON.stringify(identity(directory,{times:true}))!==JSON.stringify(state.witness.directory)||
  JSON.stringify({...identity(pointer),target})!==JSON.stringify(state.witness.pointer))fail('unverified_journal');
 const verifyActivation=(activationId,expected)=>{
  let activation;let manifest;let manifestRecord;
  try{const activationDirectory=path.join(repositoryRoot,'.jhw-runtime/v2/activations',activationId);
   activation=fs.lstatSync(activationDirectory,{bigint:true});manifest=fs.lstatSync(path.join(activationDirectory,'manifest.json'),{bigint:true});
   manifestRecord=readRegular(activationDirectory,'manifest.json',65536);
  }catch{fail('unverified_journal');}
  if(!activation.isDirectory()||!manifest.isFile()||JSON.stringify(identity(activation,{times:true}))!==JSON.stringify(expected.directory)||
   JSON.stringify({...identity(manifest,{times:true,links:true}),sha256:digest(manifestRecord.bytes)})!==JSON.stringify(expected.manifest))fail('unverified_journal');
  return {value:parseJson(manifestRecord.bytes),bytes:manifestRecord.bytes};
 };
 const origin=state.origin===null?null:verifyActivation(state.origin.activationId,state.witness.origin).value;
 const destinationRecord=verifyActivation(state.destination.activationId,state.witness.destination);const value=destinationRecord.value;
 const destination=Object.fromEntries(['version','activationId','releaseId','bootstrapId','runtimeContract','compatibilityDigest','predecessorActivationId','migrationId'].map(key=>[key,value[key]]));
 const destinationCanonical=canonical(value)+'\n'===destinationRecord.bytes.toString('utf8');
 const destinationMatches=canonical(destination)===canonical(Object.fromEntries(Object.entries(state.destination).filter(([key])=>key!=='observation')));
 if(origin?.activationId!==state.origin?.activationId||!destinationCanonical||!destinationMatches)fail('unverified_journal');
}

/** Exact shared parser for v2 runtime journals. Future journal kinds extend this
 * closed dispatch rather than adding deploy- or prune-local readers. */
export function readRuntimeJournalV2({repositoryRoot,journalDirectory}) {
 const runtimeRoot=path.join(repositoryRoot,'.jhw-runtime');
 const journalsRoot=path.join(runtimeRoot,'v2/journals');
 const name=path.basename(journalDirectory);
 if(!JOURNAL_V2.test(name)||path.dirname(journalDirectory)!==journalsRoot)fail('unverified_journal');
 const root=runtimeDirectory(repositoryRoot);let v2;let journals;let journal;
 try {
  v2=new PinnedDirectory(root.at('v2'),{parentVerify:()=>root.verify()});
  journals=new PinnedDirectory(v2.at('journals'),{parentVerify:()=>v2.verify()});
  journal=new PinnedDirectory(journals.at(name),{parentVerify:()=>journals.verify()});
  const children=fs.readdirSync(`/proc/self/fd/${journal.fd}`).sort();
  if(children.length>7||!children.includes('state.json'))fail('unverified_journal');
  const files=new Map();
  files.set('state.json',readRegular(`/proc/self/fd/${journal.fd}`,'state.json',FILE_LIMIT));
  const state=parseJson(files.get('state.json').bytes);
  if(state?.kind==='codex-config') {
   const parsed=readCodexMigrationJournal({journalDirectory});
   files.set('state.json',parsed.record);
   if(children.includes('retention.json')){
    const record=readRegular(`/proc/self/fd/${journal.fd}`,'retention.json',FILE_LIMIT);files.set('retention.json',record);const receipt=parseJson(record.bytes),time=Date.parse(receipt.completedAt);
    if(!exact(receipt,['version','sequence','journal','stateSha256','completedAt','previous'])||receipt.version!==2||!Number.isSafeInteger(receipt.sequence)||receipt.sequence<1||receipt.journal!==name||receipt.stateSha256!==digest(files.get('state.json').bytes)||typeof receipt.completedAt!=='string'||!Number.isFinite(time)||new Date(time).toISOString()!==receipt.completedAt||receipt.previous!==null)fail('unverified_journal');
   }
   journal.verify();journals.verify();v2.verify();root.verify();return {state:parsed.state,files,identity:objectIdentity(journal.stat)};
  }
  if(state?.kind==='initial-install') {
   if(children.some(child=>!['state.json','retention.json','pointer-witness','wiring-after.json','wiring'].includes(child))||!children.includes('pointer-witness')||!children.includes('wiring')||!validInitialInstallState(state))fail('unverified_journal');
   readInitialWiring(journal,state,files);
   if(children.includes('wiring-after.json')){
    const after=readRegular(`/proc/self/fd/${journal.fd}`,'wiring-after.json',4*1024*1024);files.set('wiring-after.json',after);
    if(state.after!==null&&digest(after.bytes)!==state.after.sha256)fail('unverified_journal');
   }else if(state.after!==null)fail('unverified_journal');
   if(children.includes('retention.json')){
    const record=readRegular(`/proc/self/fd/${journal.fd}`,'retention.json',FILE_LIMIT);files.set('retention.json',record);const receipt=parseJson(record.bytes);const time=Date.parse(receipt.completedAt);
    if(!exact(receipt,['version','sequence','journal','stateSha256','completedAt','previous'])||receipt.version!==2||!Number.isSafeInteger(receipt.sequence)||receipt.sequence<1||receipt.journal!==name||receipt.stateSha256!==digest(files.get('state.json').bytes)||typeof receipt.completedAt!=='string'||!Number.isFinite(time)||new Date(time).toISOString()!==receipt.completedAt||receipt.previous!==null)fail('unverified_journal');
   }
   journal.verify();journals.verify();v2.verify();root.verify();return {state,files,identity:objectIdentity(journal.stat)};
  }
  if(state?.kind==='bootstrap-migration') {
   if(children.some(child=>!['state.json','retention.json','pointer-witness','validation','guard'].includes(child)&&!LOG.test(child))||!children.includes('validation')||!children.includes('pointer-witness')||!validBootstrapMigrationState(state)||children.includes('guard')!==(state.guard!==null))fail('unverified_journal');
   const validation=new PinnedDirectory(journal.at('validation'),{parentVerify:()=>journal.verify()});
   try{const entries=fs.readdirSync(`/proc/self/fd/${validation.fd}`);if(entries.some(child=>child!=='state.json'&&!LOG.test(child)))fail('unverified_journal');for(const child of entries)readRegular(`/proc/self/fd/${validation.fd}`,child,FILE_LIMIT);validation.verify();}finally{validation.close();}
   for(const child of children.filter(child=>child!=='pointer-witness'&&child!=='validation'&&child!=='guard'&&child!=='state.json'))files.set(child,readRegular(`/proc/self/fd/${journal.fd}`,child,FILE_LIMIT));
   if(files.has('retention.json')){
    const receipt=parseJson(files.get('retention.json').bytes);const time=Date.parse(receipt.completedAt);
    if(!exact(receipt,['version','sequence','journal','stateSha256','completedAt','previous'])||receipt.version!==2||
      !Number.isSafeInteger(receipt.sequence)||receipt.sequence<1||receipt.journal!==name||receipt.stateSha256!==digest(files.get('state.json').bytes)||
      typeof receipt.completedAt!=='string'||!Number.isFinite(time)||new Date(time).toISOString()!==receipt.completedAt||receipt.previous!==null)fail('unverified_journal');
   }
   journal.verify();journals.verify();v2.verify();root.verify();return {state,files,identity:objectIdentity(journal.stat)};
  }
  if(children.some(child=>!['state.json','candidate-probe.log','retention.json','pointer-witness'].includes(child)))fail('unverified_journal');
  for(const child of children.filter(child=>child!=='pointer-witness'&&child!=='state.json'))files.set(child,readRegular(`/proc/self/fd/${journal.fd}`,child,FILE_LIMIT));
  if(!validPairJournalState(state))fail('unverified_journal');
  verifyPairWitnessFiles({repositoryRoot,journalDirectory,state});
  if(files.has('retention.json')){
   const receipt=parseJson(files.get('retention.json').bytes);const time=Date.parse(receipt.completedAt);
   if(!exact(receipt,['version','sequence','journal','stateSha256','completedAt','previous'])||receipt.version!==2||
    !Number.isSafeInteger(receipt.sequence)||receipt.sequence<1||receipt.journal!==name||receipt.stateSha256!==digest(files.get('state.json').bytes)||
    typeof receipt.completedAt!=='string'||!Number.isFinite(time)||new Date(time).toISOString()!==receipt.completedAt||receipt.previous!==null)fail('unverified_journal');
  }
  journal.verify();journals.verify();v2.verify();root.verify();
  return {state,files,identity:objectIdentity(journal.stat)};
 }finally{journal?.close();journals?.close();v2?.close();root.close();}
}

/** Resolve the original completed upgrade seal before granting a new rollback. */
export function findCompletedBootstrapMigration({repositoryRoot,current}) {
 if(!validRuntimeCurrent(current)||current?.version!==2||current.predecessorActivationId!==null||current.migrationId===null)fail('unverified_journal');
 const runtime=runtimeDirectory(repositoryRoot);let v2;let journals;
 try{
  v2=new PinnedDirectory(runtime.at('v2'),{parentVerify:()=>runtime.verify()});
  journals=new PinnedDirectory(v2.at('journals'),{parentVerify:()=>v2.verify()});
  const matches=[];
  for(const name of scanNames(journals).filter(name=>JOURNAL_V2.test(name))){
   const parsed=readRuntimeJournalV2({repositoryRoot,journalDirectory:path.join(repositoryRoot,'.jhw-runtime/v2/journals',name)}),state=parsed.state;
   if(state.kind!=='bootstrap-migration'||state.operation!=='upgrade'||state.migrationId!==current.migrationId)continue;
   if(state.status!=='complete'||state.outcome!=='migrated'||!parsed.files.has('retention.json')||
     canonical(state.destination)!==canonical(Object.fromEntries(Object.entries(current).filter(([key])=>key!=='observation'))))fail('unverified_journal');
   matches.push(state);
  }
  journals.verify();v2.verify();runtime.verify();if(matches.length!==1)fail('unverified_journal');return matches[0];
 }finally{journals?.close();v2?.close();runtime.close();}
}

/** Locate the unique receipt-backed v1 activation that moved A to current B. */
export function findLegacyActivationReceipt({repositoryRoot,current}) {
 if(!validCurrent(current)||current===null)fail('unverified_journal');
 const runtime=runtimeDirectory(repositoryRoot);try {
  const matches=[];for(const name of scanNames(runtime).filter(name=>JOURNAL.test(name))){
   const item=inspectJournal(runtime,name,{state:0});
   if(!['success','evidence'].includes(item.kind))continue;
   const directory=runtime.at(name);const record=readRegular(directory,'state.json',FILE_LIMIT);const state=parseJson(record.bytes);
   if(state.status!=='complete'||state.phase!=='complete'||state.operation!=='activate'||!successfulState(state)||
     canonical(state.current)!==canonical(current)||state.previous?.activationId!==current.predecessorActivationId)continue;
   let receipt;try{receipt=parseJson(readRegular(directory,'retention.json',FILE_LIMIT).bytes);}catch{continue;}
   if(!validReceipt(receipt,name,record.bytes)||receipt.previous!==null)fail('unverified_journal');
   let guard=null;
   if(item.kind==='evidence'){
    const evidence=readGuardTransitionEvidence({journalDirectory:path.join(repositoryRoot,'.jhw-runtime',name)});
    if(evidence?.direction!=='forward'||evidence.status!=='finalized'||evidence.destination_activation_id!==current.activationId||
      canonical(evidence.origin)!==canonical(state.previous))continue;
   }
   if(item.kind==='evidence')guard=sealMigrationGuardForward({repositoryRoot,journal:name,current:state.current,previous:state.previous});
   matches.push({journal:name,previous:state.previous,current:state.current,receipt,guard});
  }
  if(matches.length!==1)fail('unverified_journal');return matches[0];
 } finally {runtime.close();}
}
function validReceipt(value,name,stateBytes) {
 if(!exact(value,['version','sequence','journal','stateSha256','completedAt','previous'])||value.version!==1||!Number.isSafeInteger(value.sequence)||value.sequence<1||value.journal!==name||value.stateSha256!==digest(stateBytes)||typeof value.completedAt!=='string')return false;
 const time=Date.parse(value.completedAt);if(!Number.isFinite(time)||new Date(time).toISOString()!==value.completedAt)return false;
 if(value.previous!==null&&(!exact(value.previous,['name','dev','ino','manifestSha256'])||!PREVIOUS.test(value.previous.name)||![value.previous.dev,value.previous.ino].every(item=>typeof item==='string'&&/^\d+$/.test(item))||typeof value.previous.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.previous.manifestSha256)))return false;
 return true;
}
const RELEASE=/^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/;
const ACTIVATION=/^a-[a-f0-9]{32}$/;
const BOOTSTRAP_FILES=[['jhw-runtime-control',0o755],['jhw-runtime-entry',0o755],['jhw-runtime-hook',0o755],['runtime-entry.mjs',0o644],['runtime-safety.mjs',0o644],['runtime-store.mjs',0o644]];
function validDestination(value,current) {return exact(value,['activationId','releaseId','predecessorActivationId'])&&value.activationId===current.activationId&&value.releaseId===current.releaseId&&value.predecessorActivationId===current.predecessorActivationId;}
function validVariables(value) {return exact(value,DEPLOY_VARIABLE_KEYS)&&DEPLOY_VARIABLE_KEYS.every(key=>typeof value[key]==='string'&&Buffer.byteLength(value[key])<=256*1024);}
function validBootstrapManifest(value) {
 return value!==null&&exact(value,['version','sourceReleaseId','files'])&&value.version===1&&RELEASE.test(value.sourceReleaseId)&&Array.isArray(value.files)&&value.files.length===BOOTSTRAP_FILES.length&&value.files.every((record,index)=>exact(record,['name','mode','sha256'])&&record.name===BOOTSTRAP_FILES[index][0]&&record.mode===BOOTSTRAP_FILES[index][1]&&typeof record.sha256==='string'&&/^[a-f0-9]{64}$/.test(record.sha256));
}
function successfulState(state) {
 const common=['version','status','operation','phase','previous','variables','mutationStarted'];
 if(state.mutationStarted!==true||!validVariables(state.variables))return false;
 if(state.operation==='activate'||state.operation==='rollback') {
  if(!exact(state,[...common,'destination','current'])||!validCurrent(state.previous)||state.previous===null||!validCurrent(state.current)||state.current===null||!validDestination(state.destination,state.current))return false;
  if(state.operation==='activate')return state.current.predecessorActivationId===state.previous.activationId;
  return state.previous.predecessorActivationId!==null&&state.current.activationId===state.previous.predecessorActivationId;
 }
 if(state.operation==='refresh-bootstrap') {
  if(!exact(state,[...common,'bootstrap'])||!validCurrent(state.previous)||state.previous===null||!exact(state.bootstrap,['prior','from','to','previousDirectory']))return false;
  const {prior,from,to,previousDirectory}=state.bootstrap;if(prior!==null&&!validBootstrapManifest(prior))return false;
  return from===(prior?.sourceReleaseId??null)&&RELEASE.test(to)&&(previousDirectory===null||PREVIOUS.test(previousDirectory));
 }
 return false;
}
function successfulCompatibleState(state) {
 const keys=['version','status','operation','compatible','candidateReleaseId','compatibilityDigest','phase','previous','variables','mutationStarted','destination','current'];
 return exact(state,keys)&&state.version===1&&state.status==='complete'&&state.operation==='activate'&&state.compatible===true&&
  RELEASE.test(state.candidateReleaseId)&&/^[a-f0-9]{64}$/.test(state.compatibilityDigest)&&state.phase==='complete'&&
  validCurrent(state.previous)&&state.previous!==null&&validCurrent(state.current)&&state.current!==null&&exact(state.variables,[])&&
  state.mutationStarted===true&&validDestination(state.destination,state.current)&&state.current.releaseId===state.candidateReleaseId&&
  state.current.predecessorActivationId===state.previous.activationId;
}
function inspectJournal(runtime,name,budget) {
 const directory=runtime.at(name);const identity=directoryIdentity(directory);let children;
 try{children=fs.readdirSync(directory).sort();}catch{fail('unverified_journal');}
 if(children.length>64||!children.includes('state.json'))fail('unverified_journal');
 const records={};for(const child of children){const limit=child==='before.json'?4*1024*1024:child==='listings.json'?16*1024*1024:FILE_LIMIT;const record=readRegular(directory,child,limit);budget.state+=record.size;if(budget.state>STATE_TOTAL_LIMIT)fail('scan_limit');records[child]=record;}
 const state=parseJson(records['state.json'].bytes);
 if(state===null||typeof state!=='object'||Array.isArray(state)||state.version!==1||!['pending','complete'].includes(state.status)||!OPERATIONS.has(state.operation)||typeof state.phase!=='string'||state.previous===undefined||state.variables===null||typeof state.variables!=='object'||Array.isArray(state.variables))fail('unverified_journal');
 const compatible=state.compatible===true;
 const ordinaryChildren=['state.json','retention.json','before.json','listings.json'];
 const compatibleChildren=['state.json','retention.json','candidate-probe.log'];
 if(children.some(child=>!(compatible?compatibleChildren:ordinaryChildren).includes(child)&&!LOG.test(child)))fail('unverified_journal');
 if(state.status==='pending')return {kind:'pending',name};
 const evidence=children.includes('before.json')||children.includes('listings.json')||state.phase!=='complete'||state.recovery!==undefined||state.supersedes!==undefined||state.reacquisition!==undefined||state.workerDetached===true||state.stateIncomplete===true;
 if(evidence)return {kind:'evidence',name};
 if(!(compatible?successfulCompatibleState(state):successfulState(state)))fail('unverified_journal');
 if(!records['retention.json'])return {kind:'legacy',name};
 const receipt=parseJson(records['retention.json'].bytes);if(!validReceipt(receipt,name,records['state.json'].bytes))fail('unverified_journal');
 if(state.operation==='refresh-bootstrap'?(receipt.previous?.name??null)!==state.bootstrap.previousDirectory:receipt.previous!==null)fail('unverified_journal');
 return {kind:'success',name,directory,identity,children,records,receipt,time:Date.parse(receipt.completedAt),size:Object.values(records).reduce((sum,item)=>sum+item.size,0)};
}
function snapshotJournalTree(directory) {
 const records=[];let total=0;
 const visit=(current,relative)=>{const entries=fs.readdirSync(current).sort();for(const name of entries){if(records.length>=512)fail('scan_limit');const file=path.join(current,name);const item=relative?`${relative}/${name}`:name;const before=fs.lstatSync(file,{bigint:true});
   if(before.uid!==BigInt(process.getuid()))fail('unverified_journal');
   if(before.isDirectory()){if(permissions(before.mode)!==0o700)fail('unverified_journal');records.push({path:item,type:'directory',identity:objectIdentity(before)});visit(file,item);continue;}
   if(before.isSymbolicLink()){const target=fs.readlinkSync(file);const after=fs.lstatSync(file,{bigint:true});if(!sameIdentity(after,objectIdentity(before))||![1n,2n].includes(before.nlink))fail('unverified_journal');records.push({path:item,type:'symlink',identity:{...objectIdentity(before),nlink:Number(before.nlink),mtimeNs:String(before.mtimeNs),ctimeNs:String(before.ctimeNs)},target});total+=Buffer.byteLength(target);continue;}
   if(!before.isFile()||![1n,2n].includes(before.nlink)||before.size>32n*1024n*1024n)fail('unverified_journal');
   let fd;try{fd=fs.openSync(file,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);const bytes=Buffer.alloc(Number(before.size));let offset=0;while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)break;offset+=count;}const after=fs.fstatSync(fd,{bigint:true});const named=fs.lstatSync(file,{bigint:true});if(offset!==bytes.length||!sameIdentity(after,objectIdentity(before))||!sameIdentity(named,objectIdentity(before))||after.size!==before.size||after.nlink!==before.nlink)fail('unverified_journal');records.push({path:item,type:'file',identity:{...objectIdentity(before),nlink:Number(before.nlink),size:String(before.size)},bytes});total+=bytes.length;}finally{if(fd!==undefined)fs.closeSync(fd);}
   if(total>128*1024*1024)fail('scan_limit');
  }};visit(directory,'');
 const links=new Map();for(const record of records.filter(item=>item.type==='file')){const key=`${record.identity.dev}:${record.identity.ino}`;if(!links.has(key))links.set(key,[]);links.get(key).push(record);}
 for(const group of links.values()){const expected=group[0].identity.nlink;if(group.length!==expected||![1,2].includes(expected)||group.some(record=>record.identity.nlink!==expected||!record.bytes.equals(group[0].bytes)))fail('unverified_journal');}
 return records;
}
function treeSignature(records){return records.map(record=>({path:record.path,type:record.type,identity:record.identity,...(record.type==='file'?{sha256:digest(record.bytes)}:record.type==='symlink'?{target:record.target}:{})}));}
function codexActualInventorySafe(directory,state) {
 const capture=key=>{const expected=state.captures[key],root=path.join(directory,expected.name);let info,names;
  try{info=fs.lstatSync(root,{bigint:true});names=fs.readdirSync(root).sort();}catch{return null;}
  if(!info.isDirectory()||canonical(objectIdentity(info))!==canonical(expected.identity)||names.some(name=>name!=='object'))return null;
  return {valid:true,names,object:readObservedCodexObject(path.join(root,'object'))};};
 const sourceCapture=capture('source'),tempCapture=capture('temp');if(!sourceCapture||!tempCapture)return false;
 const source=sourceCapture.object,temp=tempCapture.object,after=readObservedCodexObject(path.join(directory,'after'));
 const before=state.before;const exactBefore=source?.kind==='file'&&source.sha256===before.sha256&&source.identity.nlink===1&&
  ['dev','ino','uid','mode','size'].every(key=>source.identity[key]===before.identity[key]);
 if(temp!==null||after!==null||tempCapture.names.length)return false;
 return state.outcome==='migrated'?exactBefore&&sourceCapture.names.join(',')==='object':source===null&&sourceCapture.names.length===0;
}
function treePruneCandidate({repositoryRoot,name,parsed,budget}) {
 const directory=path.join(repositoryRoot,'.jhw-runtime/v2/journals',name);if(!parsed.files.has('retention.json'))return {kind:'legacy',name};
 if(parsed.state.kind==='codex-config'&&!codexActualInventorySafe(directory,parsed.state))return {kind:'evidence',name};
 const treeRecords=snapshotJournalTree(directory);const records={};let size=0;
 for(let index=0;index<treeRecords.length;index++){const record=treeRecords[index];const bytes=record.type==='file'?record.bytes:Buffer.from(record.type==='symlink'?record.target:canonical(record.identity));const key=`entry-${String(index).padStart(3,'0')}`;records[key]={bytes,identity:{dev:'0',ino:'0',uid:process.getuid(),mode:0o600},size:bytes.length};size+=bytes.length;}
 const info=fs.lstatSync(directory,{bigint:true});const receipt=parseJson(parsed.files.get('retention.json').bytes);let witness=null;let protectedCurrent=false;
 if(parsed.state.witness){
  const pointerRecord=treeRecords.find(record=>record.path==='pointer-witness/current');witness=pointerRecord?.identity??null;
  const expected=pointerRecord?.identity??parsed.state.witness.pointer;
  try{const current=fs.lstatSync(path.join(repositoryRoot,'.jhw-runtime/current'),{bigint:true});protectedCurrent=String(current.dev)===expected.dev&&String(current.ino)===expected.ino;}catch{}
 }
 return {kind:'success',name,directory,identity:objectIdentity(info),children:Object.keys(records),records,receipt,time:Date.parse(receipt.completedAt),size,special:'v2-tree',treeRecords,witness,protected:protectedCurrent||size>CANDIDATE_TOTAL_LIMIT,currentPath:path.join(repositoryRoot,'.jhw-runtime/current')};
}
function inspectPairPruneCandidate({repositoryRoot,name,parsed,budget}) {
 const directory=path.join(repositoryRoot,'.jhw-runtime/v2/journals',name);const {state,files}=parsed;
 if(state.status==='pending')return {kind:'pending',name};
 if(state.kind!=='pair'||state.phase!=='complete'||state.outcome!=='pointer_published')return {kind:'evidence',name};
 if(!files.has('retention.json'))return {kind:'legacy',name};
 const witness=path.join(directory,'pointer-witness/current');let witnessInfo;let currentInfo=null;
 try{witnessInfo=fs.lstatSync(witness,{bigint:true});try{currentInfo=fs.lstatSync(path.join(repositoryRoot,'.jhw-runtime/current'),{bigint:true});}catch{}}
 catch{fail('unverified_journal');}
 const protectedCurrent=Boolean(currentInfo&&witnessInfo.dev===currentInfo.dev&&witnessInfo.ino===currentInfo.ino);
 if(!witnessInfo.isSymbolicLink()||witnessInfo.uid!==BigInt(process.getuid())||![1n,2n].includes(witnessInfo.nlink)||!protectedCurrent&&witnessInfo.nlink!==1n)fail('unverified_journal');
 const records={};for(const [child,record] of files){records[child]=record;budget.state+=record.size;if(budget.state>STATE_TOTAL_LIMIT)fail('scan_limit');}
 const target=Buffer.from(fs.readlinkSync(witness));const synthetic='pointer-witness.current';
 const witnessProof={...objectIdentity(witnessInfo),nlink:Number(witnessInfo.nlink),mtimeNs:String(witnessInfo.mtimeNs),ctimeNs:String(witnessInfo.ctimeNs)};
 records[synthetic]={bytes:target,identity:{...objectIdentity(witnessInfo),mode:0o600},sourceIdentity:witnessProof,size:target.length,target:target.toString()};
 const children=[...Object.keys(records)].sort();const info=fs.lstatSync(directory,{bigint:true});const receipt=parseJson(files.get('retention.json').bytes);
 return {kind:'success',name,directory,identity:objectIdentity(info),children,records,receipt,time:Date.parse(receipt.completedAt),
  size:Object.values(records).reduce((sum,item)=>sum+item.size,0),special:'v2-pair',protected:protectedCurrent,currentPath:path.join(repositoryRoot,'.jhw-runtime/current')};
}
function inspectV2JournalsForPrune({repositoryRoot,budget}) {
 const root=path.join(repositoryRoot,'.jhw-runtime/v2/journals');if(!fs.existsSync(root))return {success:[],evidence:0,legacy:0};
 const names=fs.readdirSync(root).sort();if(names.length>SCAN_LIMIT||names.some(name=>!JOURNAL_V2.test(name)))fail('unverified_journal');
 const result={success:[],evidence:0,legacy:0};
 for(const name of names){const parsed=readRuntimeJournalV2({repositoryRoot,journalDirectory:path.join(root,name)});let item;
  if(parsed.state.status==='pending')item={kind:'pending',name};
  else if(parsed.state.kind==='bootstrap-migration')item={kind:'evidence',name};
  else if(parsed.state.kind==='pair')item=inspectPairPruneCandidate({repositoryRoot,name,parsed,budget});
  else if(parsed.state.status==='complete'&&parsed.state.phase==='complete')item=treePruneCandidate({repositoryRoot,name,parsed,budget});
  else item={kind:'evidence',name};
  if(item.kind==='pending')fail('pending_journal');if(item.kind==='success')result.success.push(item);else result[item.kind]++;
 }
 return result;
}
function migrationAuthorityJournals(repositoryRoot) {
 const root=path.join(repositoryRoot,'.jhw-runtime/v2/migrations');const retained=new Set();if(!fs.existsSync(root))return retained;
 const names=fs.readdirSync(root).sort();if(names.length>SCAN_LIMIT||names.some(name=>!/^m-[a-f0-9]{32}$/.test(name)))fail('unverified_journal');
 for(const migrationId of names){let anchor;try{anchor=readMigrationAnchor({repositoryRoot,migrationId});}catch{fail('unverified_journal');}retained.add(anchor.legacyReceipt.journal);if(anchor.guard?.journal)retained.add(anchor.guard.journal);}
 return retained;
}
function publicPlan(plan,dryRun=true) {
 const candidates={journals:plan.journals.map(item=>item.name),previous:plan.previous.map(item=>item.name)};
 const removed={journals:0,previous:0};
 if(plan.hasBootstrapGenerations){candidates.bootstrapGenerations=plan.bootstrapGenerations.map(item=>item.name);removed.bootstrapGenerations=0;}
 return {code:'DEPLOY_PRUNE_PLAN',version:1,dryRun,advisory:dryRun,blocked:false,reasons:[],policy:{minimumAgeDays:30,minimumRecentJournals:32,minimumRecentPrevious:1},observed:plan.observed,candidates,removed,skipped:plan.skipped};
}
function inspectBootstrapCandidates({repositoryRoot,retained,budget}) {
 const snapshot=snapshotBootstrapReferences({repositoryRoot});const result=[];
 for(const item of snapshot.generations){
  if(retained.has(item.bootstrapId))continue;
  const directory=path.join(repositoryRoot,'.jhw-runtime/v2/bootstraps',item.bootstrapId);const children=fs.readdirSync(directory).sort();const records={};
  for(const child of children){const mode=['lease','manifest.json'].includes(child)?0o600:0o644;const record=readCandidateFile(directory,child,CANDIDATE_TOTAL_LIMIT,mode);records[child]=record;budget.candidates=(budget.candidates??0)+record.size;if(budget.candidates>CANDIDATE_TOTAL_LIMIT)fail('scan_limit');}
  result.push({name:item.bootstrapId,bootstrapId:item.bootstrapId,directory,identity:item.identity,children,records});
 }
 return result;
}
function buildPlan({repositoryRoot,now=Date.now(),validatePrevious=validateRetainedBootstrap}, compareLiveState=false) {
 if(!Number.isFinite(now))fail('unverified_journal');const runtime=runtimeDirectory(repositoryRoot);
 try {
 const names=scanNames(runtime);
 if(names.includes(PRUNE))fail('previous_prune_incomplete');
 const budget={state:0};const journals=[];const skipped={evidence:0,legacy:0,unknown:0,retainedAge:0,retainedRecent:0,retainedPrevious:0};
 const fixed=new Set(['releases','activations','current','bootstrap','deploy.lock','admission.lock','publication.lock','wiring.json','v2','.jhw-atomic-probe.v1',COUNTER]);
 skipped.unknown=names.filter(name=>!fixed.has(name)&&!JOURNAL.test(name)&&!PREVIOUS.test(name)&&!/^\.(?:stage|bootstrap\.stage)\.[a-f0-9]{32}$/.test(name)).length;
 for(const name of names.filter(name=>JOURNAL.test(name))) {const item=inspectJournal(runtime,name,budget);if(item.kind==='pending')fail('pending_journal');if(item.kind==='success')journals.push(item);else skipped[item.kind]++;}
 const v2Journals=inspectV2JournalsForPrune({repositoryRoot,budget});journals.push(...v2Journals.success);skipped.evidence+=v2Journals.evidence;skipped.legacy+=v2Journals.legacy;
 const permanentJournals=migrationAuthorityJournals(repositoryRoot);
 const sequences=new Set();for(const item of journals){if(sequences.has(item.receipt.sequence))fail('unverified_journal');sequences.add(item.receipt.sequence);}
 if(journals.length) {
  if(!names.includes(COUNTER))fail('unverified_journal');const counter=parseJson(readRegular(`/proc/self/fd/${runtime.fd}`,COUNTER,4096).bytes);
  if(!exact(counter,['version','sequence'])||counter.version!==1||!Number.isSafeInteger(counter.sequence)||counter.sequence<Math.max(...sequences))fail('unverified_journal');
 }
 const newest=[...journals].sort((a,b)=>b.receipt.sequence-a.receipt.sequence);const recent=new Set(newest.slice(0,MIN_RECENT).map(item=>item.name));
 const boundary=newest[Math.min(MIN_RECENT,newest.length)-1]?.time;for(const item of newest)if(boundary!==undefined&&item.time===boundary)recent.add(item.name);
 const referenced=new Map();for(const item of journals.filter(item=>item.receipt.previous)){if(referenced.has(item.receipt.previous.name))fail('unverified_journal');referenced.set(item.receipt.previous.name,item);}
 const latestPreviousJournal=[...referenced.values()].sort((a,b)=>b.receipt.sequence-a.receipt.sequence)[0];const latestPrevious=latestPreviousJournal?.receipt.previous?.name;
 const candidates=[];for(const item of journals){if(item.protected||permanentJournals.has(item.name)){skipped.evidence++;continue;}if(now-item.time<MIN_AGE_MS){skipped.retainedAge++;continue;}if(recent.has(item.name)){skipped.retainedRecent++;continue;}if(item===latestPreviousJournal)continue;budget.candidates=(budget.candidates??0)+item.size;if(budget.candidates>CANDIDATE_TOTAL_LIMIT)fail('scan_limit');candidates.push(item);}
 candidates.sort((a,b)=>a.receipt.sequence-b.receipt.sequence);
 // A previous set is eligible only when a valid receipt proves its ordering and
 // the referencing journal is itself being removed. Legacy/unreferenced sets stay.
 const previous=[];
 for(const name of names.filter(name=>PREVIOUS.test(name))) {
  const journal=referenced.get(name);if(!journal||name===latestPrevious||!candidates.includes(journal)||now-journal.time<MIN_AGE_MS){skipped.retainedPrevious++;continue;}
  let manifest;try{manifest=validatePrevious({repositoryRoot,name,runtimeHandle:{fd:runtime.fd,verify:()=>runtime.verify()}});}catch{fail('unverified_journal');}
  const previousRoot=runtime.at(name);const info=fs.lstatSync(previousRoot,{bigint:true});
  const manifestBytes=readCandidateFile(previousRoot,'manifest.json',16384,0o600).bytes;
  if(String(info.dev)!==journal.receipt.previous.dev||String(info.ino)!==journal.receipt.previous.ino||digest(manifestBytes)!==journal.receipt.previous.manifestSha256)fail('unverified_journal');
  const modes=new Map([['manifest.json',0o600],...manifest.files.map(record=>[record.name,record.mode])]);const children=fs.readdirSync(previousRoot).sort();const records={};
  if(children.length!==modes.size||children.some(child=>!modes.has(child)))fail('unverified_journal');
  for(const child of children){const record=readCandidateFile(previousRoot,child,CANDIDATE_TOTAL_LIMIT,modes.get(child));budget.candidates=(budget.candidates??0)+record.size;if(budget.candidates>CANDIDATE_TOTAL_LIMIT)fail('scan_limit');records[child]=record;}
  previous.push({name,directory:previousRoot,identity:objectIdentity(info),children,records,receipt:journal.receipt});
 }
 const candidateNames=new Set(candidates.map(item=>item.name));for(const item of journals)if(item.receipt.previous&&candidateNames.has(item.name)&&!previous.some(entry=>entry.name===item.receipt.previous.name))skipped.retainedPrevious++;
 const referenceSnapshot=snapshotBootstrapReferences({repositoryRoot});
 const roots=collectBootstrapRoots({repositoryRoot,now});if(roots.uncertain)fail('unverified_journal');
 const bootstrapGenerations=inspectBootstrapCandidates({repositoryRoot,retained:roots.retained,budget});
 const liveState = compareLiveState ? digest(canonical([referenceSnapshot.currentObservation,
   referenceSnapshot.records.filter(record => record.live && record.kind === 'session')])) : null;
 runtime.verify();return {runtime,rootNames:names,journals:candidates,previous,bootstrapGenerations,liveState,retained:roots.retained,hasBootstrapGenerations:referenceSnapshot.generations.length>0,hasLiveBindings:referenceSnapshot.records.some(record=>record.live),observed:{entries:names.length,journals:journals.length+skipped.evidence+skipped.legacy,previous:names.filter(name=>PREVIOUS.test(name)).length},skipped};
 } catch(error) {runtime.close();throw error;}
}

export function planRuntimePrune(options) {const plan=buildPlan(options);try{return publicPlan(plan,true);}finally{plan.runtime.close();}}

export function pruneExecutionRoute(plan) {
  const hasGenerations = (plan.candidates.bootstrapGenerations?.length ?? 0) > 0;
  const hasLegacy = plan.candidates.previous.length > 0 ||
    plan.candidates.journals.some(name => JOURNAL.test(name));
  return {hasGenerations, hasLegacy, livePath: hasGenerations && !hasLegacy};
}

function candidateFingerprint(item) {
  const files = item.treeRecords ? treeSignature(item.treeRecords) : item.children.map(name => {
    const record = item.records[name];
    return [name, record.sourceIdentity ?? record.identity, digest(record.bytes)];
  });
  return digest(canonical([item.special ?? null, item.identity, files]));
}

// The public plan only lists names. Bind this apply attempt to the objects that
// were actually observed before choosing the inventory and lock requirements.
export function prepareRuntimePrune(options) {
  const initial = buildPlan(options, true);
  try {
    const handle = Object.freeze({plan: publicPlan(initial)});
    const candidates = new Map();
    for (const item of [...initial.previous, ...initial.journals, ...initial.bootstrapGenerations]) {
      candidates.set(item.name, {
        fingerprint: candidateFingerprint(item),
        // A disappearing generation may be skipped if its original files still
        // match and the final retention pass positively protected that copy.
        generation: item.bootstrapId ? item : null,
      });
    }
    preparedPrunePlans.set(handle, {
      repositoryRoot: options.repositoryRoot,
      runtimeIdentity: objectIdentity(initial.runtime.stat),
      route: pruneExecutionRoute(handle.plan),
      liveState: initial.liveState,
      candidates,
    });
    return handle;
  } finally { initial.runtime.close(); }
}

function verifyPreparedPrune(initial, plan, options) {
  if (!initial || initial.repositoryRoot !== options.repositoryRoot ||
      !sameIdentity(plan.runtime.stat, initial.runtimeIdentity)) fail('snapshot_changed');
  const lock = (handle, name) => validLeaseCapability(handle, path.join(plan.runtime.name, name), {exclusive:true});
  if (!lock(options.deployLease, 'deploy.lock') ||
      (!initial.route.livePath && !lock(options.admissionLease, 'admission.lock')) ||
      (initial.route.hasGenerations && !lock(options.publicationLease, 'publication.lock'))) fail('snapshot_changed');
  if (initial.route.livePath && initial.liveState !== plan.liveState) fail('snapshot_changed');
  const pending = new Map(initial.candidates);
  const final = [...plan.previous, ...plan.journals, ...plan.bootstrapGenerations];
  for (const item of final) {
    if (pending.get(item.name)?.fingerprint !== candidateFingerprint(item)) fail('snapshot_changed');
    try { verifyCandidate(item); } catch { fail('snapshot_changed'); }
    pending.delete(item.name);
  }
  if (final.length && initial.route.livePath !== pruneExecutionRoute(publicPlan(plan)).livePath) fail('snapshot_changed');
  for (const [name, expected] of pending) {
    if (!expected.generation || !plan.retained.has(name)) fail('snapshot_changed');
    try { verifyCandidate(expected.generation); } catch { fail('snapshot_changed'); }
  }
}

// Complete generation roots used by both advisory planning and apply-time
// revalidation. Bounded reaper output is deliberately not consulted here.
export function collectBootstrapRoots({repositoryRoot,now=Date.now()}) {
 if(!Number.isFinite(now))fail('unverified_journal');
 try{
  const snapshot=snapshotBootstrapReferences({repositoryRoot});const retained=new Set(snapshot.retained);
  const journalsRoot=path.join(repositoryRoot,'.jhw-runtime/v2/journals');
  if(fs.existsSync(journalsRoot)){
   const journalNames=fs.readdirSync(journalsRoot).sort();if(journalNames.length>SCAN_LIMIT||journalNames.some(name=>!JOURNAL_V2.test(name)))fail('unverified_journal');
   for(const name of journalNames){const parsed=readRuntimeJournalV2({repositoryRoot,journalDirectory:path.join(journalsRoot,name)});const state=parsed.state;
    if(state.status==='pending')fail('pending_journal');
    // A completed migration is permanent rollback authority. Completed pair,
    // initial-install, and Codex history are not deletion authority, but only
    // migration coordinates permanently root a generation copy.
    if(state.kind==='bootstrap-migration')for(const value of [state.origin,state.destination,state.published])if(value?.bootstrapId)retained.add(value.bootstrapId);
   }
  }
  const newest=[...snapshot.generations].sort((a,b)=>b.mtimeMs-a.mtimeMs||a.bootstrapId.localeCompare(b.bootstrapId));
  const boundary=newest[Math.min(MIN_RECENT_GENERATIONS,newest.length)-1]?.mtimeMs;
  for(const item of newest){
   if(now-item.mtimeMs<MIN_AGE_MS||item.mtimeMs===boundary){retained.add(item.bootstrapId);continue;}
   let lease;try{lease=acquireLease(path.join(repositoryRoot,`.jhw-runtime/v2/bootstraps/${item.bootstrapId}/lease`));}
   catch(error){if(error.code==='DEPLOY_LOCK_CONTENDED'){retained.add(item.bootstrapId);continue;}throw error;}
   finally{lease?.close();}
  }
  return {retained,uncertain:false};
 }catch(error){if(error instanceof DeploymentError)throw error;return {retained:new Set(),uncertain:true};}
}

function writePrivate(file,value,{exclusive=true,directoryFd=null}={}) {
 const directory=directoryFd===null?path.dirname(file):`/proc/self/fd/${directoryFd}`;const temporary=path.join(directory,`.write.${randomBytes(16).toString('hex')}`);const fd=fs.openSync(temporary,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
 try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{if(exclusive){fs.linkSync(temporary,file);fs.unlinkSync(temporary);}else fs.renameSync(temporary,file);if(directoryFd===null){const dirFd=fs.openSync(directory,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{fs.fsyncSync(dirFd);}finally{fs.closeSync(dirFd);}}else fs.fsyncSync(directoryFd);}
 catch(error){try{fs.unlinkSync(temporary);}catch{}throw error;}
}
function verifyPairCandidate(item,directory=item.directory) {
 const info=fs.lstatSync(directory,{bigint:true});if(!sameIdentity(info,item.identity)||!info.isDirectory())fail('snapshot_changed');
 const regular=item.children.filter(name=>name!=='pointer-witness.current');const actual=fs.readdirSync(directory).sort();
 if(JSON.stringify(actual)!==JSON.stringify([...regular,'pointer-witness'].sort()))fail('snapshot_changed');
 for(const child of regular){const expected=item.records[child];const current=readCandidateFile(directory,child,Math.max(expected.size,1),expected.identity.mode);if(!sameIdentity(fs.lstatSync(path.join(directory,child),{bigint:true}),expected.identity)||!current.bytes.equals(expected.bytes))fail('snapshot_changed');}
 const pointer=path.join(directory,'pointer-witness/current');const expected=item.records['pointer-witness.current'];let witness;try{witness=fs.lstatSync(pointer,{bigint:true});}catch{fail('snapshot_changed');}
 const proof={...objectIdentity(witness),nlink:Number(witness.nlink),mtimeNs:String(witness.mtimeNs),ctimeNs:String(witness.ctimeNs)};
 if(canonical(proof)!==canonical(expected.sourceIdentity)||!witness.isSymbolicLink()||witness.nlink!==1n||fs.readlinkSync(pointer)!==expected.target||fs.readdirSync(path.dirname(pointer)).join(',')!=='current')fail('snapshot_changed');
 try{const current=fs.lstatSync(item.currentPath,{bigint:true});if(current.dev===witness.dev&&current.ino===witness.ino)fail('snapshot_changed');}catch(error){if(error instanceof DeploymentError)throw error;}
}
function verifyTreeCandidate(item,directory=item.directory) {
 const info=fs.lstatSync(directory,{bigint:true});if(!sameIdentity(info,item.identity)||!info.isDirectory())fail('snapshot_changed');
 const actual=snapshotJournalTree(directory);if(canonical(treeSignature(actual))!==canonical(treeSignature(item.treeRecords)))fail('snapshot_changed');
 if(item.witness){const record=actual.find(value=>value.path==='pointer-witness/current');if(!record||canonical(record.identity)!==canonical(item.witness))fail('snapshot_changed');try{const current=fs.lstatSync(item.currentPath,{bigint:true});if(current.dev.toString()===item.witness.dev&&current.ino.toString()===item.witness.ino)fail('snapshot_changed');}catch(error){if(error instanceof DeploymentError)throw error;}}
}
function verifyCandidate(item) {
 if(item.special==='v2-pair')return verifyPairCandidate(item);
 if(item.special==='v2-tree')return verifyTreeCandidate(item);
 const info=fs.lstatSync(item.directory,{bigint:true});if(!sameIdentity(info,item.identity)||!info.isDirectory())fail('snapshot_changed');
 if(JSON.stringify(fs.readdirSync(item.directory).sort())!==JSON.stringify(item.children))fail('snapshot_changed');
 for(const child of item.children){const expected=item.records[child];const current=readCandidateFile(item.directory,child,Math.max(expected.size,1),expected.identity.mode);if(!sameIdentity(fs.lstatSync(path.join(item.directory,child),{bigint:true}),expected.identity)||!current.bytes.equals(expected.bytes))fail('snapshot_changed');}
}
function writeRecoveryFile(payload,name,record) {
 const target=payload.at(name);let fd;
 try {
  fd=fs.openSync(target,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);fs.fchmodSync(fd,record.identity.mode);fs.writeFileSync(fd,record.bytes);fs.fsyncSync(fd);
  const info=fs.fstatSync(fd,{bigint:true});if(!info.isFile()||info.uid!==BigInt(process.getuid())||info.nlink!==1n||permissions(info.mode)!==record.identity.mode||Number(info.size)!==record.size)fail('recovery_copy_failed');
  return objectIdentity(info);
 } finally {if(fd!==undefined)fs.closeSync(fd);}
}
function recoveryInventory(item,files,recoveryIdentity,payloadIdentity) {
 const tree=item.special==='v2-tree'?item.treeRecords.map((record,index)=>({path:record.path,type:record.type,proof:record.identity,payload:item.children[index],
  target:record.type==='symlink'?record.target:null,linkGroup:record.type==='file'&&record.identity.nlink===2?`${record.identity.dev}:${record.identity.ino}`:null})):null;
 return {version:1,name:item.name,identity:item.identity,recoveryIdentity,payloadIdentity,tree,files:item.children.map(name=>({name,identity:item.records[name].identity,recoveryIdentity:files[name],size:item.records[name].size,mode:item.records[name].identity.mode,sha256:digest(item.records[name].bytes)}))};
}
function verifyRecovery(evidence,recoveryRecord,item) {
 const recovery=new PinnedDirectory(recoveryRecord.path,{parentVerify:()=>evidence.verify()});try {
 if(!sameIdentity(recovery.stat,recoveryRecord.identity))fail('recovery_copy_failed',true);
 const inventory=parseJson(readCandidateFile(`/proc/self/fd/${recovery.fd}`,'inventory.json',4*1024*1024,0o600).bytes);
 if(!exact(inventory,['version','name','identity','recoveryIdentity','payloadIdentity','tree','files'])||inventory.version!==1||inventory.name!==item.name||JSON.stringify(inventory.identity)!==JSON.stringify(item.identity)||JSON.stringify(inventory.recoveryIdentity)!==JSON.stringify(recoveryRecord.identity)||!Array.isArray(inventory.files)||inventory.files.length!==item.children.length)fail('recovery_copy_failed',true);
 const expectedTree=item.special==='v2-tree'?recoveryInventory(item,{},inventory.recoveryIdentity,inventory.payloadIdentity).tree:null;if(canonical(inventory.tree)!==canonical(expectedTree))fail('recovery_copy_failed',true);
 const payload=new PinnedDirectory(recovery.at('payload'),{parentVerify:()=>recovery.verify()});try {
 if(!sameIdentity(payload.stat,inventory.payloadIdentity)||JSON.stringify(fs.readdirSync(`/proc/self/fd/${payload.fd}`).sort())!==JSON.stringify(item.children))fail('recovery_copy_failed',true);
 for(let index=0;index<item.children.length;index++){
  const name=item.children[index];const expected=item.records[name];const record=inventory.files[index];
  if(!exact(record,['name','identity','recoveryIdentity','size','mode','sha256'])||record.name!==name||JSON.stringify(record.identity)!==JSON.stringify(expected.identity)||record.size!==expected.size||record.mode!==expected.identity.mode||record.sha256!==digest(expected.bytes))fail('recovery_copy_failed',true);
  const copied=readCandidateFile(`/proc/self/fd/${payload.fd}`,name,Math.max(expected.size,1),expected.identity.mode);const named=fs.lstatSync(payload.at(name),{bigint:true});if(!sameIdentity(named,record.recoveryIdentity)||!copied.bytes.equals(expected.bytes))fail('recovery_copy_failed',true);
 }
 } finally {payload.close();}
 } finally {recovery.close();}
}
function createRecovery(evidence,item,index,faultInjector) {
 const name=`recovery.${index.toString().padStart(8,'0')}`;const recoveryPath=evidence.at(name);fs.mkdirSync(recoveryPath,{mode:0o700});fs.chmodSync(recoveryPath,0o700);evidence.sync();
 const recovery=new PinnedDirectory(recoveryPath,{parentVerify:()=>evidence.verify()});try {
  const payloadPath=recovery.at('payload');fs.mkdirSync(payloadPath,{mode:0o700});fs.chmodSync(payloadPath,0o700);recovery.sync();
  const payload=new PinnedDirectory(payloadPath,{parentVerify:()=>recovery.verify()});const payloadIdentity=objectIdentity(payload.stat);const files={};try {
   for(const child of item.children){files[child]=writeRecoveryFile(payload,child,item.records[child]);payload.sync();faultInjector?.('after_recovery_file_sync',{name:item.name,index,child});}
  } finally {payload.close();}
  const recoveryIdentity=objectIdentity(recovery.stat);verifyCandidate(item);writePrivate(recovery.at('inventory.json'),recoveryInventory(item,files,recoveryIdentity,payloadIdentity),{directoryFd:recovery.fd});recovery.sync();verifyRecovery(evidence,{path:recoveryPath,identity:recoveryIdentity},item);
  return {path:recoveryPath,identity:recoveryIdentity};
 } finally {recovery.close();}
}
function removeCaptured(capture,item,faultInjector,index) {
 if(item.special==='v2-pair'){
  verifyPairCandidate(item,capture);const fd=fs.openSync(capture,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{
   for(const name of item.children.filter(value=>value!=='pointer-witness.current')){fs.unlinkSync(`/proc/self/fd/${fd}/${name}`);fs.fsyncSync(fd);faultInjector?.('after_original_unlink',{name:item.name,index,child:name});}
   const witnessPath=`/proc/self/fd/${fd}/pointer-witness`;const witnessFd=fs.openSync(witnessPath,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{fs.unlinkSync(`/proc/self/fd/${witnessFd}/current`);fs.fsyncSync(witnessFd);}finally{fs.closeSync(witnessFd);}
   fs.rmdirSync(witnessPath);fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}fs.rmdirSync(capture);return;
 }
 if(item.special==='v2-tree'){
  verifyTreeCandidate(item,capture);
  const leaves=item.treeRecords.filter(record=>record.type!=='directory').sort((a,b)=>b.path.split('/').length-a.path.split('/').length||b.path.localeCompare(a.path));
  const removedLinks=new Map();
  for(const record of leaves){
   const file=path.join(capture,record.path),actual=fs.lstatSync(file,{bigint:true});
   if(!sameIdentity(actual,record.identity))fail('capture_changed',true);
   if(record.type==='file'){
    const group=`${record.identity.dev}:${record.identity.ino}`,removed=removedLinks.get(group)??0;
    const expectedLinks=record.identity.nlink-removed;
    const current=readStableFile(file,Number(record.identity.size),before=>
     sameIdentity(before,record.identity)&&Number(before.nlink)===expectedLinks&&String(before.size)===record.identity.size,
     {reason:'capture_changed',partial:true});
    if(digest(current.bytes)!==digest(record.bytes))fail('capture_changed',true);
    removedLinks.set(group,removed+1);
   }else{
    const proof={...objectIdentity(actual),nlink:Number(actual.nlink),mtimeNs:String(actual.mtimeNs),ctimeNs:String(actual.ctimeNs)};
    if(!actual.isSymbolicLink()||canonical(proof)!==canonical(record.identity)||fs.readlinkSync(file)!==record.target)fail('capture_changed',true);
   }
   fs.unlinkSync(file);syncDirectory(path.dirname(file));faultInjector?.('after_original_unlink',{name:item.name,index,child:record.path});
  }
  const directories=item.treeRecords.filter(record=>record.type==='directory').sort((a,b)=>b.path.split('/').length-a.path.split('/').length||b.path.localeCompare(a.path));
  for(const record of directories){const directory=path.join(capture,record.path);const actual=fs.lstatSync(directory,{bigint:true});if(!sameIdentity(actual,record.identity)||fs.readdirSync(directory).length)fail('capture_changed',true);fs.rmdirSync(directory);syncDirectory(path.dirname(directory));}
  fs.rmdirSync(capture);return;
 }
 const fd=fs.openSync(capture,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{
  const info=fs.fstatSync(fd,{bigint:true});if(!sameIdentity(info,item.identity))fail('capture_changed',true);
  const names=fs.readdirSync(`/proc/self/fd/${fd}`).sort();if(JSON.stringify(names)!==JSON.stringify(item.children))fail('capture_changed',true);
  for(let childIndex=0;childIndex<names.length;childIndex++){const name=names[childIndex];const target=`/proc/self/fd/${fd}/${name}`;const child=fs.lstatSync(target,{bigint:true});const expected=item.records[name];if(!child.isFile()||child.uid!==BigInt(process.getuid())||child.nlink!==1n||!sameIdentity(child,expected.identity))fail('capture_changed',true);fs.unlinkSync(target);fs.fsyncSync(fd);faultInjector?.('after_original_unlink',{name:item.name,index,child,childIndex});}
 }finally{fs.closeSync(fd);}fs.rmdirSync(capture);
}
function removeRecovery(evidence,recoveryRecord,item) {
 verifyRecovery(evidence,recoveryRecord,item);const recovery=new PinnedDirectory(recoveryRecord.path,{parentVerify:()=>evidence.verify()});try {
  const payloadPath=recovery.at('payload');const payload=new PinnedDirectory(payloadPath,{parentVerify:()=>recovery.verify()});try{for(const child of item.children){fs.unlinkSync(payload.at(child));payload.sync();}}finally{payload.close();}
  fs.rmdirSync(payloadPath);recovery.sync();fs.unlinkSync(recovery.at('inventory.json'));recovery.sync();
 } finally {recovery.close();}
 fs.rmdirSync(recoveryRecord.path);evidence.sync();
}
function syncDirectory(directory) {const fd=fs.openSync(directory,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function applyRuntimePrune(options) {
 const {repositoryRoot,retainedEvidence=null,managedScope=null}=options;
 if(managedScope!==null){requireManagedScope(managedScope,repositoryRoot);managedScope.hasInvocationRecords();}
 else {
  try {
   fs.lstatSync(path.join(repositoryRoot,'.jhw-runtime/v2/managed-invocations'));
   throw new DeploymentError('DEPLOY_MANAGED_MODE_REQUIRED');
  }
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 const prepared = options.preparedPlan;
 const initial = preparedPrunePlans.get(prepared);
 if (prepared !== undefined && !preparedPrunePlans.delete(prepared)) fail('snapshot_changed');
 const plan=buildPlan(options, prepared !== undefined);const {runtime}=plan;let evidence;let mutated=false;const removed={journals:0,previous:0};
 try {
  const legacyDeletion=plan.previous.length||plan.journals.some(item=>item.special===undefined);
  if(managedScope!==null&&legacyDeletion)fail('managed_legacy_prune_requires_offline');
  if(plan.hasLiveBindings&&legacyDeletion)fail('mixed_generation_legacy');
  if(plan.hasBootstrapGenerations)removed.bootstrapGenerations=0;
  options.faultInjector?.('before_intent');runtime.verify();if(JSON.stringify(scanNames(runtime))!==JSON.stringify(plan.rootNames))fail('snapshot_changed');
  if (prepared !== undefined) verifyPreparedPrune(initial, plan, options);
  if (retainedEvidence!==null) revalidateRetainedPruneEvidence({repositoryRoot,retainedEvidence});
  if (!plan.previous.length && !plan.journals.length && !plan.bootstrapGenerations.length) {
    return {...publicPlan(plan,false), code:'DEPLOY_PRUNED', removed};
  }
  fs.mkdirSync(runtime.at(PRUNE),{mode:0o700});fs.chmodSync(runtime.at(PRUNE),0o700);runtime.sync();
  evidence=new PinnedDirectory(runtime.at(PRUNE),{parentVerify:()=>runtime.verify()});
  writePrivate(evidence.at('intent.json'),{version:1,candidates:[...plan.previous,...plan.journals].map(item=>({name:item.name,identity:item.identity,children:item.children}))},{directoryFd:evidence.fd});
  writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'copying',recovered:0,removed},{directoryFd:evidence.fd});evidence.sync();options.faultInjector?.('after_intent_sync');
  const paired=new Set();const ordered=[];for(const item of plan.previous){ordered.push({type:'previous',item});const journal=plan.journals.find(candidate=>candidate.receipt.previous?.name===item.name);if(journal){ordered.push({type:'journals',item:journal});paired.add(journal.name);}}
  ordered.push(...plan.journals.filter(item=>!paired.has(item.name)).map(item=>({type:'journals',item})));
  ordered.push(...plan.bootstrapGenerations.map(item=>({type:'bootstrapGenerations',item})));
  const recoveries=[];for(let index=0;index<ordered.length;index++){
   const item=ordered[index].item;verifyCandidate(item);recoveries[index]=createRecovery(evidence,item,index,options.faultInjector);writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'copying',recovered:index+1,removed},{exclusive:false,directoryFd:evidence.fd});
  }
  writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'copies_durable',recovered:ordered.length,removed},{exclusive:false,directoryFd:evidence.fd});evidence.sync();options.faultInjector?.('after_recovery_durable');
  for(let index=0;index<ordered.length;index++){
   const {type,item}=ordered[index];verifyRecovery(evidence,recoveries[index],item);verifyCandidate(item);
   if (retainedEvidence!==null) revalidateRetainedPruneEvidence({repositoryRoot,retainedEvidence});
   const remove=({directory=item.directory,syncSource=()=>runtime.sync()}={})=>{const captureName=`capture.${index.toString().padStart(8,'0')}`;const capture=evidence.at(captureName);fs.renameSync(directory,capture);mutated=true;evidence.sync();options.faultInjector?.('after_destination_sync',{name:item.name,index});syncSource();options.faultInjector?.('after_rename_sync',{name:item.name,index});
    const captured=fs.lstatSync(capture,{bigint:true});if(!sameIdentity(captured,item.identity))fail('capture_changed',true);
    options.faultInjector?.('after_capture',{name:item.name,index});removeCaptured(capture,item,options.faultInjector,index);removed[type]++;
    evidence.sync();options.faultInjector?.('after_capture_rmdir_sync',{name:item.name,index});return true;};
   if(type==='bootstrapGenerations'){
    const reclaimed=withUnreferencedBootstrapGeneration({repositoryRoot,bootstrapId:item.bootstrapId,identity:item.identity,
      leaseIdentity:item.records.lease.identity,deployLease:options.deployLease,
      publicationLease:options.publicationLease,retainedEvidence,
      remove:managedScope===null?remove:source=>managedScope.hasGenerationIntent(item.bootstrapId)?false:remove(source),
      observe:options.faultInjector});
    if(!reclaimed)continue;
   }else if(item.special==='v2-pair'||item.special==='v2-tree')remove({syncSource:()=>syncDirectory(path.dirname(item.directory))});
   else remove();
   writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'removing_originals',recovered:ordered.length,removed},{exclusive:false,directoryFd:evidence.fd});
  }
  writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'originals_durable',recovered:ordered.length,removed},{exclusive:false,directoryFd:evidence.fd});evidence.sync();options.faultInjector?.('after_originals_durable');
  for(let index=0;index<ordered.length;index++){
   const item=ordered[index].item;options.faultInjector?.('before_recovery_cleanup',{name:item.name,index});removeRecovery(evidence,recoveries[index],item);options.faultInjector?.('after_recovery_cleanup_sync',{name:item.name,index});writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'cleanup',recovered:ordered.length-index-1,removed},{exclusive:false,directoryFd:evidence.fd});options.faultInjector?.('after_unlink',{name:item.name,index});
  }
  options.faultInjector?.('before_final_evidence_removal');for(const name of ['intent.json','state.json'])fs.unlinkSync(evidence.at(name));evidence.sync();options.faultInjector?.('after_final_evidence_removal_sync');evidence.close();evidence=undefined;fs.rmdirSync(runtime.at(PRUNE));try{fs.fsyncSync(runtime.fd);}catch{fail('evidence_removed_unsynced',true);}runtime.verify();options.faultInjector?.('after_final_runtime_sync');
  return {...publicPlan(plan,false),code:'DEPLOY_PRUNED',dryRun:false,advisory:false,removed};
 } catch(error) {
  if(error instanceof DeploymentError){if(error.code==='DEPLOY_PRUNE_PARTIAL'||mutated||evidence!==undefined)fail(error.reason??'snapshot_changed',true);throw error;}
  fail('maintenance_interrupted',mutated||evidence!==undefined);
 } finally {evidence?.close();runtime.close();}
}

export function recordDeploymentRetention({repositoryRoot,journalDirectory,previousDirectory=null,completedAt=new Date().toISOString()}) {
 const runtime=runtimeDirectory(repositoryRoot);try {
 const name=path.basename(journalDirectory);const v2Journal=JOURNAL_V2.test(name)&&path.dirname(journalDirectory)===path.join(runtime.name,'v2/journals');
 if(!v2Journal&&(!JOURNAL.test(name)||path.dirname(journalDirectory)!==runtime.name))throw new Error('retention journal invalid');
 if(v2Journal&&previousDirectory!==null)throw new Error('retention journal invalid');
 const anchoredJournal=v2Journal?journalDirectory:runtime.at(name);let parsedV2=null;
 if(v2Journal)parsedV2=readRuntimeJournalV2({repositoryRoot,journalDirectory});
 const state=v2Journal?parsedV2.files.get('state.json').bytes:readRegular(anchoredJournal,'state.json').bytes;let sequence=0;const counter=runtime.at(COUNTER);const counterExists=fs.existsSync(counter);
 if(counterExists) {const value=parseJson(readRegular(`/proc/self/fd/${runtime.fd}`,COUNTER,4096).bytes);if(!exact(value,['version','sequence'])||value.version!==1||!Number.isSafeInteger(value.sequence)||value.sequence<0)throw new Error('retention counter invalid');sequence=value.sequence;}
 sequence++;writePrivate(counter,{version:1,sequence},{exclusive:!counterExists,directoryFd:runtime.fd});runtime.sync();
 let previous=null;if(previousDirectory){const previousName=path.basename(previousDirectory);validateRetainedBootstrap({repositoryRoot,name:previousName,runtimeHandle:{fd:runtime.fd,verify:()=>runtime.verify()}});const previousRoot=runtime.at(previousName);const info=fs.lstatSync(previousRoot,{bigint:true});const manifestBytes=readCandidateFile(previousRoot,'manifest.json',16384,0o600).bytes;previous={name:previousName,dev:String(info.dev),ino:String(info.ino),manifestSha256:digest(manifestBytes)};}
 const receipt={version:v2Journal?2:1,sequence,journal:name,stateSha256:digest(state),completedAt,previous};const journalRoot=new PinnedDirectory(anchoredJournal,{parentVerify:()=>runtime.verify()});try{writePrivate(journalRoot.at('retention.json'),receipt,{directoryFd:journalRoot.fd});journalRoot.verify();}finally{journalRoot.close();}runtime.verify();return receipt;
 } finally {runtime.close();}
}
