import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {DeploymentError,trustedDirectory} from './runtime-safety.mjs';
import {validateRetainedBootstrap} from './runtime-entry.mjs';

const C=fs.constants;
const JOURNAL=/^\.deploy\.[a-f0-9]{32}$/;
const PREVIOUS=/^\.bootstrap\.previous\.[a-f0-9]{32}$/;
const LOG=/^(verify|wire|validate|finalize|rollback|uninstall)\.[a-f0-9]{16}\.log$/;
const OPERATIONS=new Set(['activate','rollback','uninstall','refresh-bootstrap']);
const SCAN_LIMIT=8192;
const FILE_LIMIT=256*1024;
const STATE_TOTAL_LIMIT=32*1024*1024;
const CANDIDATE_TOTAL_LIMIT=64*1024*1024;
const MIN_AGE_MS=30*24*60*60*1000;
const MIN_RECENT=32;
const COUNTER='.retention-sequence.v1.json';
const PRUNE='.prune.v1';
export const DEPLOY_VARIABLE_KEYS=['HOOK_LINK_CREATED','INSTALL_TRANSACTION_ACTIVE','HOOKS_CONFIG_CHANGED','HOOKS_CONFIG_FILE','HOOKS_ADAPTER','HOOKS_DISPLAY_NAME','HOOKS_TRANSACTION_DIR','HOOKS_TRANSACTION_STAGE','HOOKS_TRANSACTION_METADATA','HOOKS_TRANSACTION_PRESERVE','CLAUDE_HOOKS_CONFIG_CHANGED','CLAUDE_HOOKS_CONFIG_FILE','CLAUDE_HOOKS_TRANSACTION_DIR','CLAUDE_HOOKS_TRANSACTION_STAGE','CLAUDE_HOOKS_TRANSACTION_METADATA','CLAUDE_HOOKS_TRANSACTION_PRESERVE','CONTROL_HOOK_LINK_TRANSACTION_DIR','CONTROL_HOOK_LINK_TRANSACTION_STAGE','CONTROL_HOOK_LINK_TRANSACTION_METADATA','CONTROL_HOOK_LINK_TRANSACTION_PRESERVE','CONTROL_HOOK_LINK_REMOVE_OUTCOME','INSTALL_UNPROTECTED','MIGRATION_HOOK_TRANSACTION_DIR','CODEX_BACKUP_PRUNE_FILE','ENV_DROPPED','ENV_DROPPED_REPORTED'];
const digest=value=>createHash('sha256').update(value).digest('hex');
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
function readRegular(directory,name,limit=FILE_LIMIT) {
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
function validReceipt(value,name,stateBytes) {
 if(!exact(value,['version','sequence','journal','stateSha256','completedAt','previous'])||value.version!==1||!Number.isSafeInteger(value.sequence)||value.sequence<1||value.journal!==name||value.stateSha256!==digest(stateBytes)||typeof value.completedAt!=='string')return false;
 const time=Date.parse(value.completedAt);if(!Number.isFinite(time)||new Date(time).toISOString()!==value.completedAt)return false;
 if(value.previous!==null&&(!exact(value.previous,['name','dev','ino','manifestSha256'])||!PREVIOUS.test(value.previous.name)||![value.previous.dev,value.previous.ino].every(item=>typeof item==='string'&&/^\d+$/.test(item))||typeof value.previous.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.previous.manifestSha256)))return false;
 return true;
}
const RELEASE=/^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/;
const ACTIVATION=/^a-[a-f0-9]{32}$/;
const BOOTSTRAP_FILES=[['jhw-runtime-control',0o755],['jhw-runtime-entry',0o755],['jhw-runtime-hook',0o755],['runtime-entry.mjs',0o644],['runtime-safety.mjs',0o644],['runtime-store.mjs',0o644]];
function validCurrent(value) {
 if(value===null)return true;
 return exact(value,['activationId','releaseId','predecessorActivationId','observation'])&&ACTIVATION.test(value.activationId)&&RELEASE.test(value.releaseId)&&(value.predecessorActivationId===null||ACTIVATION.test(value.predecessorActivationId))&&exact(value.observation,['target','dev','ino','ctimeNs'])&&value.observation.target===`activations/${value.activationId}`&&['dev','ino','ctimeNs'].every(key=>typeof value.observation[key]==='string'&&/^\d{1,32}$/.test(value.observation[key]));
}
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
function inspectJournal(runtime,name,budget) {
 const directory=runtime.at(name);const identity=directoryIdentity(directory);let children;
 try{children=fs.readdirSync(directory).sort();}catch{fail('unverified_journal');}
 if(children.length>64||!children.includes('state.json')||children.some(child=>!['state.json','retention.json','before.json','listings.json'].includes(child)&&!LOG.test(child)))fail('unverified_journal');
 const records={};for(const child of children){const limit=child==='before.json'?4*1024*1024:child==='listings.json'?16*1024*1024:FILE_LIMIT;const record=readRegular(directory,child,limit);budget.state+=record.size;if(budget.state>STATE_TOTAL_LIMIT)fail('scan_limit');records[child]=record;}
 const state=parseJson(records['state.json'].bytes);
 if(state===null||typeof state!=='object'||Array.isArray(state)||state.version!==1||!['pending','complete'].includes(state.status)||!OPERATIONS.has(state.operation)||typeof state.phase!=='string'||state.previous===undefined||state.variables===null||typeof state.variables!=='object'||Array.isArray(state.variables))fail('unverified_journal');
 if(state.status==='pending')return {kind:'pending',name};
 const evidence=children.includes('before.json')||children.includes('listings.json')||state.phase!=='complete'||state.recovery!==undefined||state.supersedes!==undefined||state.reacquisition!==undefined||state.workerDetached===true||state.stateIncomplete===true;
 if(evidence)return {kind:'evidence',name};
 if(!successfulState(state))fail('unverified_journal');
 if(!records['retention.json'])return {kind:'legacy',name};
 const receipt=parseJson(records['retention.json'].bytes);if(!validReceipt(receipt,name,records['state.json'].bytes))fail('unverified_journal');
 if(state.operation==='refresh-bootstrap'?(receipt.previous?.name??null)!==state.bootstrap.previousDirectory:receipt.previous!==null)fail('unverified_journal');
 return {kind:'success',name,directory,identity,children,records,receipt,time:Date.parse(receipt.completedAt),size:Object.values(records).reduce((sum,item)=>sum+item.size,0)};
}
function publicPlan(plan,dryRun=true) {
 return {code:'DEPLOY_PRUNE_PLAN',version:1,dryRun,advisory:dryRun,blocked:false,reasons:[],policy:{minimumAgeDays:30,minimumRecentJournals:32,minimumRecentPrevious:1},observed:plan.observed,candidates:{journals:plan.journals.map(item=>item.name),previous:plan.previous.map(item=>item.name)},removed:{journals:0,previous:0},skipped:plan.skipped};
}
function buildPlan({repositoryRoot,now=Date.now(),validatePrevious=validateRetainedBootstrap}) {
 if(!Number.isFinite(now))fail('unverified_journal');const runtime=runtimeDirectory(repositoryRoot);
 try {
 const names=scanNames(runtime);
 if(names.includes(PRUNE))fail('previous_prune_incomplete');
 const budget={state:0};const journals=[];const skipped={evidence:0,legacy:0,unknown:0,retainedAge:0,retainedRecent:0,retainedPrevious:0};
 const fixed=new Set(['releases','activations','current','bootstrap','deploy.lock','admission.lock','wiring.json',COUNTER]);
 skipped.unknown=names.filter(name=>!fixed.has(name)&&!JOURNAL.test(name)&&!PREVIOUS.test(name)&&!/^\.(?:stage|bootstrap\.stage)\.[a-f0-9]{32}$/.test(name)).length;
 for(const name of names.filter(name=>JOURNAL.test(name))) {const item=inspectJournal(runtime,name,budget);if(item.kind==='pending')fail('pending_journal');if(item.kind==='success')journals.push(item);else skipped[item.kind]++;}
 const sequences=new Set();for(const item of journals){if(sequences.has(item.receipt.sequence))fail('unverified_journal');sequences.add(item.receipt.sequence);}
 if(journals.length) {
  if(!names.includes(COUNTER))fail('unverified_journal');const counter=parseJson(readRegular(`/proc/self/fd/${runtime.fd}`,COUNTER,4096).bytes);
  if(!exact(counter,['version','sequence'])||counter.version!==1||!Number.isSafeInteger(counter.sequence)||counter.sequence<Math.max(...sequences))fail('unverified_journal');
 }
 const newest=[...journals].sort((a,b)=>b.receipt.sequence-a.receipt.sequence);const recent=new Set(newest.slice(0,MIN_RECENT).map(item=>item.name));
 const boundary=newest[Math.min(MIN_RECENT,newest.length)-1]?.time;for(const item of newest)if(boundary!==undefined&&item.time===boundary)recent.add(item.name);
 const candidates=[];for(const item of journals){if(now-item.time<MIN_AGE_MS){skipped.retainedAge++;continue;}if(recent.has(item.name)){skipped.retainedRecent++;continue;}budget.candidates=(budget.candidates??0)+item.size;if(budget.candidates>CANDIDATE_TOTAL_LIMIT)fail('scan_limit');candidates.push(item);}
 candidates.sort((a,b)=>a.receipt.sequence-b.receipt.sequence);
 // A previous set is eligible only when a valid receipt proves its ordering and
 // the referencing journal is itself being removed. Legacy/unreferenced sets stay.
 const previous=[];const referenced=new Map();for(const item of journals.filter(item=>item.receipt.previous)){if(referenced.has(item.receipt.previous.name))fail('unverified_journal');referenced.set(item.receipt.previous.name,item);}
 const latestPrevious=[...referenced.values()].sort((a,b)=>b.receipt.sequence-a.receipt.sequence)[0]?.receipt.previous?.name;
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
 runtime.verify();return {runtime,rootNames:names,journals:candidates,previous,observed:{entries:names.length,journals:journals.length+skipped.evidence+skipped.legacy,previous:names.filter(name=>PREVIOUS.test(name)).length},skipped};
 } catch(error) {runtime.close();throw error;}
}

export function planRuntimePrune(options) {const plan=buildPlan(options);try{return publicPlan(plan,true);}finally{plan.runtime.close();}}

function writePrivate(file,value,{exclusive=true,directoryFd=null}={}) {
 const directory=directoryFd===null?path.dirname(file):`/proc/self/fd/${directoryFd}`;const temporary=path.join(directory,`.write.${randomBytes(16).toString('hex')}`);const fd=fs.openSync(temporary,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
 try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{if(exclusive){fs.linkSync(temporary,file);fs.unlinkSync(temporary);}else fs.renameSync(temporary,file);if(directoryFd===null){const dirFd=fs.openSync(directory,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{fs.fsyncSync(dirFd);}finally{fs.closeSync(dirFd);}}else fs.fsyncSync(directoryFd);}
 catch(error){try{fs.unlinkSync(temporary);}catch{}throw error;}
}
function verifyCandidate(item) {
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
 return {version:1,name:item.name,identity:item.identity,recoveryIdentity,payloadIdentity,files:item.children.map(name=>({name,identity:item.records[name].identity,recoveryIdentity:files[name],size:item.records[name].size,mode:item.records[name].identity.mode,sha256:digest(item.records[name].bytes)}))};
}
function verifyRecovery(evidence,recoveryRecord,item) {
 const recovery=new PinnedDirectory(recoveryRecord.path,{parentVerify:()=>evidence.verify()});try {
 if(!sameIdentity(recovery.stat,recoveryRecord.identity))fail('recovery_copy_failed',true);
 const inventory=parseJson(readCandidateFile(`/proc/self/fd/${recovery.fd}`,'inventory.json',FILE_LIMIT,0o600).bytes);
 if(!exact(inventory,['version','name','identity','recoveryIdentity','payloadIdentity','files'])||inventory.version!==1||inventory.name!==item.name||JSON.stringify(inventory.identity)!==JSON.stringify(item.identity)||JSON.stringify(inventory.recoveryIdentity)!==JSON.stringify(recoveryRecord.identity)||!Array.isArray(inventory.files)||inventory.files.length!==item.children.length)fail('recovery_copy_failed',true);
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
export function applyRuntimePrune(options) {
 const plan=buildPlan(options);const {runtime}=plan;let evidence;let mutated=false;const removed={journals:0,previous:0};
 try {
  options.faultInjector?.('before_intent');runtime.verify();if(JSON.stringify(scanNames(runtime))!==JSON.stringify(plan.rootNames))fail('snapshot_changed');
  fs.mkdirSync(runtime.at(PRUNE),{mode:0o700});fs.chmodSync(runtime.at(PRUNE),0o700);runtime.sync();
  evidence=new PinnedDirectory(runtime.at(PRUNE),{parentVerify:()=>runtime.verify()});
  writePrivate(evidence.at('intent.json'),{version:1,candidates:[...plan.previous,...plan.journals].map(item=>({name:item.name,identity:item.identity,children:item.children}))},{directoryFd:evidence.fd});
  writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'copying',recovered:0,removed},{directoryFd:evidence.fd});evidence.sync();options.faultInjector?.('after_intent_sync');
  const paired=new Set();const ordered=[];for(const item of plan.previous){ordered.push({type:'previous',item});const journal=plan.journals.find(candidate=>candidate.receipt.previous?.name===item.name);if(journal){ordered.push({type:'journals',item:journal});paired.add(journal.name);}}
  ordered.push(...plan.journals.filter(item=>!paired.has(item.name)).map(item=>({type:'journals',item})));
  const recoveries=[];for(let index=0;index<ordered.length;index++){
   const item=ordered[index].item;verifyCandidate(item);recoveries[index]=createRecovery(evidence,item,index,options.faultInjector);writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'copying',recovered:index+1,removed},{exclusive:false,directoryFd:evidence.fd});
  }
  writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'copies_durable',recovered:ordered.length,removed},{exclusive:false,directoryFd:evidence.fd});evidence.sync();options.faultInjector?.('after_recovery_durable');
  for(let index=0;index<ordered.length;index++){
   const {type,item}=ordered[index];verifyRecovery(evidence,recoveries[index],item);verifyCandidate(item);const captureName=`capture.${index.toString().padStart(8,'0')}`;const capture=evidence.at(captureName);fs.renameSync(item.directory,capture);mutated=true;evidence.sync();options.faultInjector?.('after_destination_sync',{name:item.name,index});runtime.sync();options.faultInjector?.('after_rename_sync',{name:item.name,index});
   const captured=fs.lstatSync(capture,{bigint:true});if(!sameIdentity(captured,item.identity))fail('capture_changed',true);
   options.faultInjector?.('after_capture',{name:item.name,index});removeCaptured(capture,item,options.faultInjector,index);removed[type]++;
   evidence.sync();options.faultInjector?.('after_capture_rmdir_sync',{name:item.name,index});writePrivate(evidence.at('state.json'),{version:1,status:'pending',phase:'removing_originals',recovered:ordered.length,removed},{exclusive:false,directoryFd:evidence.fd});
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
 const name=path.basename(journalDirectory);if(!JOURNAL.test(name)||path.dirname(journalDirectory)!==runtime.name)throw new Error('retention journal invalid');const anchoredJournal=runtime.at(name);
 const state=readRegular(anchoredJournal,'state.json').bytes;let sequence=0;const counter=runtime.at(COUNTER);const counterExists=fs.existsSync(counter);
 if(counterExists) {const value=parseJson(readRegular(`/proc/self/fd/${runtime.fd}`,COUNTER,4096).bytes);if(!exact(value,['version','sequence'])||value.version!==1||!Number.isSafeInteger(value.sequence)||value.sequence<0)throw new Error('retention counter invalid');sequence=value.sequence;}
 sequence++;writePrivate(counter,{version:1,sequence},{exclusive:!counterExists,directoryFd:runtime.fd});runtime.sync();
 let previous=null;if(previousDirectory){const previousName=path.basename(previousDirectory);validateRetainedBootstrap({repositoryRoot,name:previousName,runtimeHandle:{fd:runtime.fd,verify:()=>runtime.verify()}});const previousRoot=runtime.at(previousName);const info=fs.lstatSync(previousRoot,{bigint:true});const manifestBytes=readCandidateFile(previousRoot,'manifest.json',16384,0o600).bytes;previous={name:previousName,dev:String(info.dev),ino:String(info.ino),manifestSha256:digest(manifestBytes)};}
 const receipt={version:1,sequence,journal:name,stateSha256:digest(state),completedAt,previous};const journalRoot=new PinnedDirectory(anchoredJournal,{parentVerify:()=>runtime.verify()});try{writePrivate(journalRoot.at('retention.json'),receipt,{directoryFd:journalRoot.fd});journalRoot.verify();}finally{journalRoot.close();}runtime.verify();return receipt;
 } finally {runtime.close();}
}
