// Built-ins only: no bootstrap helper may execute before manifest validation.
import fs from 'node:fs';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const C = fs.constants;
const FILES = ['jhw-runtime-control', 'jhw-runtime-entry', 'jhw-runtime-hook', 'runtime-entry.mjs', 'runtime-safety.mjs', 'runtime-store.mjs'];
const RELEASE = /^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const modeFor = name => name.startsWith('jhw-') ? 0o755 : 0o644;
function fail(code = 'DEPLOY_BOOTSTRAP_INVALID') { const error = new Error(code); error.code = code; throw error; }
function exact(value, keys) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function same(a, b) { return ['dev','ino','uid','gid','mode','nlink','size','ctimeNs','mtimeNs'].every(key => a[key] === b[key]); }

// Retained directory descriptors and no-follow opens protect each component.
class Directory {
  constructor(name) {
    this.records = [];
    try {
      if (typeof name !== 'string' || !path.isAbsolute(name) || name !== path.resolve(name) || name.includes('\0')) fail();
      let current = '/';
      const parts = name.split('/').filter(Boolean);
      for (let i = -1; i < parts.length; i++) {
        if (i >= 0) current = path.join(current,parts[i]);
        const location = i < 0 ? '/' : `/proc/self/fd/${this.fd}/${parts[i]}`;
        const fd = fs.openSync(location,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
        const stat = fs.fstatSync(fd,{bigint:true});
        this.records.push({fd,name:current,stat}); this.fd = fd;
        const mode = Number(stat.mode);
        const leaf = i === parts.length-1;
        if (!stat.isDirectory() || (stat.uid !== BigInt(process.getuid()) && (leaf || stat.uid !== 0n)) || (mode & 0o022 && (leaf || !(mode & 0o1000))) || mode & 0o6000) fail();
      }
      this.verify();
    } catch (error) { this.close(); throw error; }
  }
  at(name) { if (typeof name !== 'string' || !name || name.includes('/') || ['.','..'].includes(name)) fail(); return `/proc/self/fd/${this.fd}/${name}`; }
  verify() {
    for (const record of this.records) {
      const current = fs.lstatSync(record.name,{bigint:true});
      const held = fs.fstatSync(record.fd,{bigint:true});
      for (const key of ['dev','ino','uid','gid','mode']) if (record.stat[key] !== current[key] || record.stat[key] !== held[key]) fail();
    }
  }
  close() { for (const record of this.records.reverse()) fs.closeSync(record.fd); this.records=[]; }
}
function read(directory,name,requiredMode,maximum=1024*1024) {
  directory.verify();
  const location=directory.at(name);
  const fd=fs.openSync(location,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  try {
    const before=fs.fstatSync(fd,{bigint:true});
    const mode=Number(before.mode)&0o7777;
    if (!before.isFile() || before.nlink!==1n || before.uid!==BigInt(process.getuid()) || mode!==requiredMode || before.size>BigInt(maximum)) fail();
    const bytes=Buffer.alloc(Number(before.size)); let offset=0;
    while(offset<bytes.length) { const count=fs.readSync(fd,bytes,offset,bytes.length-offset,null); if(!count) fail(); offset+=count; }
    if(fs.readSync(fd,Buffer.alloc(1),0,1,null)!==0 || !same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(location,{bigint:true}))) fail();
    directory.verify(); return bytes;
  } finally { fs.closeSync(fd); }
}

function openArtifact(repositoryRoot, releaseId, relativeName) {
  const manifest=releaseManifest(repositoryRoot,releaseId);
  const record=manifest.entries.find(entry=>entry.path===relativeName);
  if(!record || record.type!=='file') fail('DEPLOY_RELEASE_INVALID');
  const directory=new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,path.dirname(relativeName)));
  let fd;
  try {
    const location=directory.at(path.basename(relativeName));
    fd=fs.openSync(location,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile() || before.uid!==BigInt(process.getuid()) || before.nlink!==1n || (Number(before.mode)&0o7777)!==record.mode || before.size>128n*1024n*1024n) fail('DEPLOY_RELEASE_INVALID');
    const digest=createHash('sha256'); const buffer=Buffer.alloc(64*1024); let total=0;
    for(;;) { const count=fs.readSync(fd,buffer,0,buffer.length,null); if(!count) break; total+=count; if(total>128*1024*1024) fail('DEPLOY_RELEASE_INVALID'); digest.update(buffer.subarray(0,count)); }
    if(digest.digest('hex')!==record.sha256 || !same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(location,{bigint:true}))) fail('DEPLOY_RELEASE_INVALID');
    directory.verify();
    const named=path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,relativeName);
    return {fd,verify:()=>{
      if(!same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(named,{bigint:true}))) fail('DEPLOY_RELEASE_CHANGED');
    }};
  } catch(error) { if(fd!==undefined) fs.closeSync(fd); throw error; }
  finally { directory.close(); }
}

function openCredential(repositoryRoot, releaseId) {
  const manifest=releaseManifest(repositoryRoot,releaseId);
  const record=manifest.entries.find(entry=>entry.path==='mcp-server/.env');
  if(!record || record.type!=='credential' || record.target!=='canonical-mcp-env') fail('DEPLOY_RELEASE_INVALID');
  const directory=new Directory(path.join(repositoryRoot,'mcp-server'));
  let fd;
  try {
    const location=directory.at('.env');
    try { fd=fs.openSync(location,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK); }
    catch(error) { if(error.code==='ENOENT') return null; throw error; }
    const before=fs.fstatSync(fd,{bigint:true}); const mode=Number(before.mode);
    if(!before.isFile() || before.uid!==BigInt(process.getuid()) || before.nlink!==1n || mode&0o7022 || !(mode&0o400) || before.size>1024n*1024n) fail('DEPLOY_RELEASE_INVALID');
    if(!same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(location,{bigint:true}))) fail('DEPLOY_RELEASE_CHANGED');
    directory.verify();
    const named=path.join(repositoryRoot,'mcp-server/.env');
    return {fd,verify:()=>{
      if(!same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(named,{bigint:true}))) fail('DEPLOY_RELEASE_CHANGED');
    }};
  } catch(error) { if(fd!==undefined) fs.closeSync(fd); throw error; }
  finally { directory.close(); }
}

function canonical(value) {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value!==null && typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
// Bind a small artifact subset to the immutable generation identity without
// rehashing node_modules a second time inside the hook's existing deadline.
function releaseManifest(repositoryRoot,releaseId) {
  if(typeof releaseId!=='string' || !RELEASE.test(releaseId)) fail();
  const directory=new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId));
  try {
    if((fs.fstatSync(directory.fd).mode&0o7777)!==0o700) fail();
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(directory,'manifest.json',0o600,32*1024*1024)));
    if(!exact(manifest,['version','releaseId','sourceRevision','sourceDigest','contentDigest','dirty','createdAt','entries']) || manifest.version!==1 || manifest.releaseId!==releaseId || typeof manifest.sourceRevision!=='string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceRevision) || typeof manifest.sourceDigest!=='string' || !/^[a-f0-9]{64}$/.test(manifest.sourceDigest) || typeof manifest.dirty!=='boolean' || typeof manifest.createdAt!=='string' || new Date(manifest.createdAt).toISOString()!==manifest.createdAt || !Array.isArray(manifest.entries) || manifest.entries.length>100000) fail();
    let previous='';
    for(const entry of manifest.entries) {
      if(!entry || typeof entry.path!=='string' || !entry.path || entry.path.length>1024 || entry.path.includes('\\') || entry.path.includes('\0') || entry.path.split('/').some(part=>!part || part==='.' || part==='..') || entry.path<=previous) fail();
      previous=entry.path;
      if(entry.type==='file' || entry.type==='directory') {
        if(!exact(entry,entry.type==='file' ? ['path','type','mode','sha256'] : ['path','type','mode']) || !Number.isInteger(entry.mode) || entry.mode<0 || entry.mode>0o7777 || entry.mode&0o7022 || (entry.type==='file' && (typeof entry.sha256!=='string' || !/^[a-f0-9]{64}$/.test(entry.sha256)))) fail();
      } else if((entry.type==='symlink' || entry.type==='credential') && exact(entry,['path','type','target']) && typeof entry.target==='string') {
        if(entry.type==='credential' && (entry.path!=='mcp-server/.env' || entry.target!=='canonical-mcp-env')) fail();
      } else fail();
    }
    const contentDigest=hash(canonical({sourceRevision:manifest.sourceRevision,sourceDigest:manifest.sourceDigest,dirty:manifest.dirty,entries:manifest.entries}));
    if(manifest.contentDigest!==contentDigest || releaseId!==`r-${manifest.sourceRevision}-${contentDigest}`) fail();
    return manifest;
  } finally { directory.close(); }
}

function readSet(directory,repositoryRoot) {
  directory.verify();
  if ((Number(fs.fstatSync(directory.fd).mode)&0o7777)!==0o700) fail();
  const names=fs.readdirSync(`/proc/self/fd/${directory.fd}`).sort();
  if(names.join(',')!==[...FILES,'manifest.json'].sort().join(',')) fail();
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(directory,'manifest.json',0o600,16384)));
  if(!exact(manifest,['version','sourceReleaseId','files']) || manifest.version!==1 || !RELEASE.test(manifest.sourceReleaseId) || !Array.isArray(manifest.files) || manifest.files.length!==FILES.length) fail();
  for(let i=0;i<FILES.length;i++) {
    const record=manifest.files[i]; const name=FILES[i];
    if(!exact(record,['name','mode','sha256']) || record.name!==name || record.mode!==modeFor(name) || typeof record.sha256!=='string' || !/^[a-f0-9]{64}$/.test(record.sha256) || hash(read(directory,name,record.mode))!==record.sha256) fail();
  }
  const source=releaseManifest(repositoryRoot,manifest.sourceReleaseId);
  const sourceDirectory=new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',manifest.sourceReleaseId,'scripts'));
  try {
    for(const record of manifest.files) {
      const original=source.entries.find(entry=>entry.path===`scripts/${record.name}`);
      if(!original || original.type!=='file' || original.mode!==record.mode || original.sha256!==record.sha256 || hash(read(sourceDirectory,record.name,record.mode))!==record.sha256) fail();
    }
  } finally { sourceDirectory.close(); }
  directory.verify(); return manifest;
}
export function validateBootstrap({repositoryRoot}) {
  let directory;
  try { directory=new Directory(path.join(repositoryRoot,'.jhw-runtime/bootstrap')); return readSet(directory,repositoryRoot); }
  catch { fail(); }
  finally { directory?.close(); }
}
function write(directory,name,bytes,mode) {
  directory.verify();
  const fd=fs.openSync(directory.at(name),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,mode);
  try { fs.fchmodSync(fd,mode); fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  directory.verify();
}
async function localStore(repositoryRoot) {
  // Installer code is caller-trusted; check both modules before the first import.
  const directory=new Directory(path.join(repositoryRoot,'scripts'));
  try { read(directory,'runtime-safety.mjs',0o644); read(directory,'runtime-store.mjs',0o644); }
  finally { directory.close(); }
  return import(pathToFileURL(path.join(repositoryRoot,'scripts/runtime-store.mjs')));
}

/** Caller must hold deploy + exclusive admission leases and completed inventories.
 * Unchanged bootstrap is reused. Replacement retains the complete old directory
 * as recovery evidence; neither prepare nor activation calls this implicitly.
 */
export async function installBootstrap({repositoryRoot,releaseId}) {
  if(typeof releaseId!=='string' || !RELEASE.test(releaseId)) fail();
  const store=await localStore(repositoryRoot);
  store.validateRelease({repositoryRoot,releaseId});
  let runtime; let source; let stage; let stageName; let previousDirectory=null;
  try {
    runtime=new Directory(path.join(repositoryRoot,'.jhw-runtime'));
    if((fs.fstatSync(runtime.fd).mode&0o7777)!==0o700) fail();
    source=new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'scripts'));
    const contents=FILES.map(name=>({name,bytes:read(source,name,modeFor(name))}));
    const manifest={version:1,sourceReleaseId:releaseId,files:contents.map(({name,bytes})=>({name,mode:modeFor(name),sha256:hash(bytes)}))};
    let previous;
    try { fs.lstatSync(runtime.at('bootstrap')); previous=validateBootstrap({repositoryRoot}); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    if(previous && JSON.stringify(previous.files)===JSON.stringify(manifest.files)) return {manifest:previous,previousDirectory:null};
    stageName=`.bootstrap.stage.${randomBytes(16).toString('hex')}`;
    fs.mkdirSync(runtime.at(stageName),{mode:0o700}); fs.chmodSync(runtime.at(stageName),0o700);
    stage=new Directory(path.join(repositoryRoot,'.jhw-runtime',stageName));
    for(const {name,bytes} of contents) write(stage,name,bytes,modeFor(name));
    write(stage,'manifest.json',JSON.stringify(manifest)+'\n',0o600);
    readSet(stage,repositoryRoot); fs.fsyncSync(stage.fd); source.verify(); runtime.verify();
    if(previous) {
      if(JSON.stringify(validateBootstrap({repositoryRoot}))!==JSON.stringify(previous)) fail('DEPLOY_BOOTSTRAP_CHANGED');
      previousDirectory=`.bootstrap.previous.${randomBytes(16).toString('hex')}`;
      fs.renameSync(runtime.at('bootstrap'),runtime.at(previousDirectory)); fs.fsyncSync(runtime.fd);
    } else {
      try { fs.lstatSync(runtime.at('bootstrap')); fail('DEPLOY_BOOTSTRAP_CHANGED'); }
      catch(error) { if(error.code!=='ENOENT') throw error; }
    }
    try {
      stage.verify(); fs.renameSync(runtime.at(stageName),runtime.at('bootstrap')); fs.fsyncSync(runtime.fd);
    } catch(error) {
      if(previousDirectory) {
        // Restore only when destination is absent; never overwrite foreign state.
        try { fs.lstatSync(runtime.at('bootstrap')); }
        catch(missing) { if(missing.code==='ENOENT') { fs.renameSync(runtime.at(previousDirectory),runtime.at('bootstrap')); fs.fsyncSync(runtime.fd); previousDirectory=null; } }
      }
      throw error;
    }
    const installed=validateBootstrap({repositoryRoot});
    if(JSON.stringify(installed)!==JSON.stringify(manifest)) fail('DEPLOY_BOOTSTRAP_CHANGED');
    return {manifest:installed,previousDirectory};
  } catch(error) {
    if(error.code && /^DEPLOY_[A-Z_]+$/.test(error.code)) throw error;
    fail();
  } finally {
    // Failed stages and replaced complete bootstraps remain bounded recovery
    // evidence. Never recursively remove a directory after a pathname race.
    stage?.close(); source?.close(); runtime?.close();
  }
}

/** Built-ins-only trust relation for guard integration. It verifies bootstrap
 * bytes and the physical selected hook files; main has already fully validated
 * the active release under its inherited lease. No env variable grants trust.
 */
export function managedHookRelationship({repositoryRoot,releaseRoot}) {
  const manifest=validateBootstrap({repositoryRoot});
  if(typeof releaseRoot!=='string') fail();
  const releaseId=path.basename(releaseRoot);
  if(!RELEASE.test(releaseId) || releaseRoot!==path.join(repositoryRoot,'.jhw-runtime/releases',releaseId)) fail();
  let scripts; let runtime;
  try {
    scripts=new Directory(path.join(releaseRoot,'scripts')); runtime=new Directory(path.join(releaseRoot,'mcp-server/dist/runtime'));
    const selected=releaseManifest(repositoryRoot,releaseId);
    for(const [directory,name,relative] of [[scripts,'jhw-control-hook','scripts/jhw-control-hook'],[runtime,'hook.cjs','mcp-server/dist/runtime/hook.cjs']]) {
      const record=selected.entries.find(entry=>entry.path===relative);
      if(!record || record.type!=='file' || !(record.mode&0o100) || hash(read(directory,name,record.mode,128*1024*1024))!==record.sha256) fail();
    }
    return {sourceReleaseId:manifest.sourceReleaseId,releaseId,launcherPath:path.join(repositoryRoot,'.jhw-runtime/bootstrap/jhw-runtime-hook'),wrapperPath:path.join(releaseRoot,'scripts/jhw-control-hook'),corePath:path.join(releaseRoot,'mcp-server/dist/runtime/hook.cjs')};
  } finally { scripts?.close(); runtime?.close(); }
}
function failure(selector,args,code) {
  if(selector!=='hook') { process.stderr.write(code+'\n'); return 75; }
  const event=args[2]==='--event' && ['UserPromptSubmit','PostToolUse','SessionEnd'].includes(args[3]) ? args[3] : 'PreToolUse';
  let result;
  if(event==='SessionEnd') result={};
  else if(event==='PostToolUse') result={systemMessage:code};
  else if(event==='UserPromptSubmit') result={hookSpecificOutput:{hookEventName:event,additionalContext:code},systemMessage:code};
  else result={hookSpecificOutput:{hookEventName:event,permissionDecision:'deny',permissionDecisionReason:code},systemMessage:code};
  process.stdout.write(JSON.stringify(result)+'\n'); return 0;
}

const MODULE_RUNNER_SOURCE=String.raw`
const Module=require('node:module');
const fs=require('node:fs'); const path=require('node:path');
const entry=process.argv[1]; const releaseRoot=process.argv[2]; const selector=process.argv[3]; const credential=process.argv[4]; const args=process.argv.slice(5);
if(typeof releaseRoot!=='string' || !path.isAbsolute(releaseRoot) || path.resolve(releaseRoot)!==releaseRoot || releaseRoot.includes('\0') || !['mcp','control','hook'].includes(selector) || !['none','loaded'].includes(credential)) throw Object.assign(new Error('DEPLOY_RUNTIME_BINDING_INVALID'),{code:'DEPLOY_RUNTIME_BINDING_INVALID'});
Object.defineProperty(globalThis,'__JHW_MANAGED_RELEASE_ROOT__',{value:releaseRoot,writable:false,configurable:false,enumerable:false});
if(credential==='loaded') { try { fs.closeSync(5); } catch {} }
const builtins=new Set(Module.builtinModules.flatMap(name=>[name,'node:'+name]));
const load=Module._load; let loadingEntry=true;
Module._load=function(request,parent,isMain){
  if(loadingEntry && request===entry) { loadingEntry=false; return load.apply(this,arguments); }
  if(!builtins.has(request)) throw Object.assign(new Error('DEPLOY_EXTERNAL_MODULE_FORBIDDEN'),{code:'DEPLOY_EXTERNAL_MODULE_FORBIDDEN'});
  return load.apply(this,arguments);
};
process.argv=[process.execPath,entry,...args];
require(entry);
`;

const HOOK_RUNNER_SOURCE=String.raw`
const {spawn}=require('node:child_process');
const releaseRoot=process.argv[1]; const args=process.argv.slice(2); const event=args[3];
const coreRunner=${JSON.stringify(MODULE_RUNNER_SOURCE)};
const exact=(value,keys)=>value!==null && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const fallback=()=>{
  const code='GUARD_UNAVAILABLE'; let value;
  if(event==='SessionEnd') value={};
  else if(event==='PostToolUse') value={systemMessage:code};
  else if(event==='UserPromptSubmit') value={hookSpecificOutput:{hookEventName:event,additionalContext:code},systemMessage:code};
  else value={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:code},systemMessage:code};
  process.stdout.write(JSON.stringify(value)+'\n');
};
const validate=bytes=>{
  if(bytes.length===0 || bytes.length>12*1024) return;
  let value; try { value=JSON.parse(bytes.toString('utf8')); } catch { return; }
  const hook=value?.hookSpecificOutput; let valid=false;
  if(event==='PreToolUse' && hook?.hookEventName==='PreToolUse') {
    valid=exact(value,['hookSpecificOutput']) && exact(hook,['hookEventName']);
    if(hook.permissionDecision==='deny') valid=exact(value,['hookSpecificOutput','systemMessage']) && exact(hook,['hookEventName','permissionDecision','permissionDecisionReason']) && typeof hook.permissionDecisionReason==='string' && hook.permissionDecisionReason.length>0 && typeof value.systemMessage==='string' && value.systemMessage.length>0;
  } else if(event==='UserPromptSubmit') valid=exact(value,['hookSpecificOutput','systemMessage']) && exact(hook,['hookEventName','additionalContext']) && hook.hookEventName===event && typeof hook.additionalContext==='string' && hook.additionalContext.length>0 && typeof value.systemMessage==='string' && value.systemMessage.length>0;
  else if(event==='PostToolUse') valid=exact(value,['systemMessage']) && typeof value.systemMessage==='string' && value.systemMessage.length>0;
  else if(event==='SessionEnd') valid=exact(value,[]);
  if(!valid) return;
  const output=Buffer.from(JSON.stringify(value)+'\n'); return output.length<=12*1024 ? output : undefined;
};
let child; let timer; let killTimer; let settled=false; let overflow=false; let length=0; const chunks=[];
const finish=(code,signal)=>{
  if(settled) return; settled=true; clearTimeout(timer); clearTimeout(killTimer);
  const output=!overflow && code===0 && signal===null ? validate(Buffer.concat(chunks,length)) : undefined;
  if(output) process.stdout.write(output); else fallback();
};
try { child=spawn(process.execPath,['-e',coreRunner,'--','/proc/self/fd/4',releaseRoot,'hook','none',...args],{stdio:['inherit','pipe','inherit',3,4]}); }
catch { fallback(); process.exit(0); }
child.stdout.on('data',chunk=>{ if(overflow) return; length+=chunk.length; if(length>12*1024) { overflow=true; chunks.length=0; child.kill('SIGTERM'); } else chunks.push(chunk); });
child.stdout.on('error',()=>{ overflow=true; child.kill('SIGTERM'); });
child.once('error',()=>finish(null,null)); child.once('close',finish);
timer=setTimeout(()=>{ child.kill('SIGTERM'); killTimer=setTimeout(()=>child.kill('SIGKILL'),200); },event==='SessionEnd' ? 2000 : 8000);
`;

function runPinnedHook({args,artifact,lease,releaseRoot}) {
  return new Promise(resolve=>{
    let child;
    try {
      artifact.verify();
      child=spawn(process.execPath,['-e',HOOK_RUNNER_SOURCE,'--',releaseRoot,...args],{stdio:['inherit','inherit','inherit',lease.fd,artifact.fd]});
      fs.closeSync(artifact.fd); artifact.fd=undefined;
    } catch { if(artifact.fd!==undefined) { fs.closeSync(artifact.fd); artifact.fd=undefined; } resolve(failure('hook',args,'GUARD_UNAVAILABLE')); return; }
    child.once('error',()=>resolve(failure('hook',args,'GUARD_UNAVAILABLE')));
    child.once('exit',(code,signal)=>resolve(code===0 && signal===null ? 0 : failure('hook',args,'GUARD_UNAVAILABLE')));
  });
}

export async function runManaged({repositoryRoot,selector,args=[],sourceReleaseId,safetySource,storeSource}) {
  let lease; let credential; const artifacts=[];
  try {
    if(!['mcp','control','hook'].includes(selector)) fail('DEPLOY_SELECTOR_INVALID');
    if(!Array.isArray(args) || args.some(value=>typeof value!=='string' || value.includes('\0'))) fail('DEPLOY_SELECTOR_INVALID');
    if(selector==='hook' && (args.length!==4 || args[0]!=='--adapter' || !['claude','codex'].includes(args[1]) || args[2]!=='--event' || !['PreToolUse','PostToolUse','UserPromptSubmit','SessionEnd'].includes(args[3]))) return failure(selector,args,'GUARD_PROTOCOL_MISMATCH');
    const validated=validateBootstrap({repositoryRoot});
    if(sourceReleaseId!==validated.sourceReleaseId || !Buffer.isBuffer(safetySource) || !Buffer.isBuffer(storeSource)) fail('DEPLOY_BOOTSTRAP_CHANGED');
    const byName=new Map(validated.files.map(record=>[record.name,record]));
    if(hash(safetySource)!==byName.get('runtime-safety.mjs')?.sha256 || hash(storeSource)!==byName.get('runtime-store.mjs')?.sha256) fail('DEPLOY_BOOTSTRAP_CHANGED');
    const moduleUrl=bytes=>`data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`;
    const safetyUrl=moduleUrl(safetySource);
    const safety=await import(safetyUrl);
    try { lease=safety.acquireLease(path.join(repositoryRoot,'.jhw-runtime/admission.lock'),{shared:true}); }
    catch(error) { if(error.code==='DEPLOY_LOCK_CONTENDED') fail('DEPLOY_MAINTENANCE'); throw error; }
    // Admission now prevents a cooperating maintenance writer from replacing
    // bootstrap. Revalidate before importing store or resolving current.
    if(canonical(validateBootstrap({repositoryRoot}))!==canonical(validated)) fail('DEPLOY_BOOTSTRAP_CHANGED');
    const storeText=new TextDecoder('utf-8',{fatal:true}).decode(storeSource);
    const safetySpecifier="'./runtime-safety.mjs'";
    if(storeText.split(safetySpecifier).length!==2) fail('DEPLOY_BOOTSTRAP_CHANGED');
    const store=await import(moduleUrl(Buffer.from(storeText.replace(safetySpecifier,JSON.stringify(safetyUrl)))));
    const activation=store.readActivation({repositoryRoot});
    if(!activation) fail('DEPLOY_NO_CURRENT');
    const release=path.join(repositoryRoot,'.jhw-runtime/releases',activation.releaseId);
    const target=path.join(release, selector==='mcp' ? 'mcp-server/dist/runtime/mcp.cjs' : selector==='control' ? 'mcp-server/dist/runtime/control.cjs' : 'mcp-server/dist/runtime/hook.cjs');
    const relative=path.relative(release,target); artifacts.push(openArtifact(repositoryRoot,activation.releaseId,relative));
    if(selector==='hook') return await runPinnedHook({args,artifact:artifacts.pop(),lease,releaseRoot:release});
    if(selector==='mcp') credential=openCredential(repositoryRoot,activation.releaseId);
    const command=process.execPath; const childArgs=[...(credential ? ['--env-file=/proc/self/fd/5'] : []),'-e',MODULE_RUNNER_SOURCE,'--',`/proc/self/fd/4`,release,selector,credential?'loaded':'none',...args];
    return await new Promise((resolve,reject)=>{
      // fd 3 is inherited through Node, Bash, timeout, and core. Closing the
      // supervisor's fd never unlocks the child's open-file description.
      for(const artifact of artifacts) artifact.verify();
      credential?.verify();
      const child=spawn(command,childArgs,{stdio:['inherit','inherit','inherit',lease.fd,...artifacts.map(artifact=>artifact.fd),credential?.fd??'ignore']});
      for(const artifact of artifacts.splice(0)) fs.closeSync(artifact.fd);
      if(credential){fs.closeSync(credential.fd);credential.fd=undefined;}
      child.once('error',()=>reject(Object.assign(new Error('DEPLOY_START_FAILED'),{code:'DEPLOY_START_FAILED'})));
      child.once('exit',(code,signal)=>resolve(code ?? (128+(osConstants.signals[signal] ?? 1))));
    });
  } catch(error) { return failure(selector,args,typeof error.code==='string' && /^DEPLOY_[A-Z_]{1,56}$/.test(error.code) ? error.code : 'DEPLOY_START_FAILED'); }
  finally { for(const artifact of artifacts) if(artifact.fd!==undefined) fs.closeSync(artifact.fd); if(credential?.fd!==undefined) fs.closeSync(credential.fd); lease?.close(); }
}
