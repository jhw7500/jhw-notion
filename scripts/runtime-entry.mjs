// Built-ins only: no bootstrap helper may execute before manifest validation.
import fs from 'node:fs';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const C = fs.constants;
const FILES = ['jhw-runtime-control', 'jhw-runtime-entry', 'jhw-runtime-hook', 'runtime-entry.mjs', 'runtime-safety.mjs', 'runtime-store.mjs'];
const ROUTER_FILES = ['jhw-runtime-control', 'jhw-runtime-entry', 'jhw-runtime-hook'];
const COMPATIBILITY_DECLARATION = 'mcp-server/src/control/runtime-compatibility.json';
const RELEASE = /^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/;
const BOOTSTRAP = /^b-[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PUBLICATION_WAIT_NS=500_000_000n;
const PUBLICATION_SLEEP=new Int32Array(new SharedArrayBuffer(4));
export const STARTUP_ENVIRONMENT = ['NODE_OPTIONS','NODE_PATH','NODE_REPL_EXTERNAL_MODULE','BASH_ENV','ENV'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const modeFor = name => name.startsWith('jhw-') ? 0o755 : 0o644;
function runtimeEnvironment() {
  const environment={...process.env};
  for(const name of STARTUP_ENVIRONMENT) delete environment[name];
  return environment;
}
function fail(code = 'DEPLOY_BOOTSTRAP_INVALID') { const error = new Error(code); error.code = code; throw error; }
function acquirePublication(safety,file,bounded){
  const deadline=process.hrtime.bigint()+PUBLICATION_WAIT_NS;
  for(;;){try{return safety.acquireLease(file,{shared:true,create:true});}catch(error){if(!bounded||error.code!=='DEPLOY_LOCK_CONTENDED'||process.hrtime.bigint()>=deadline)throw error;Atomics.wait(PUBLICATION_SLEEP,0,0,5);}}
}
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
class AnchoredDirectory {
  constructor(fd, verifyParent) {
    this.fd=fd;this.verifyParent=verifyParent;this.stat=fs.fstatSync(fd,{bigint:true});
    const mode=Number(this.stat.mode);if(!this.stat.isDirectory()||this.stat.uid!==BigInt(process.getuid())||mode&0o7022||mode&0o6000)fail();this.verify();
  }
  at(name){if(typeof name!=='string'||!name||name.includes('/')||['.','..'].includes(name))fail();return `/proc/self/fd/${this.fd}/${name}`;}
  verify(){this.verifyParent();const current=fs.fstatSync(this.fd,{bigint:true});for(const key of ['dev','ino','uid','gid','mode'])if(this.stat[key]!==current[key])fail();}
  close(){if(this.fd!==undefined){fs.closeSync(this.fd);this.fd=undefined;}}
}
function anchoredDirectory(runtimeHandle,parts) {
  if(!runtimeHandle||!Number.isInteger(runtimeHandle.fd)||typeof runtimeHandle.verify!=='function')fail();runtimeHandle.verify();let fd;
  try {
    let parentFd=runtimeHandle.fd;
    for(const part of parts){if(typeof part!=='string'||!part||part.includes('/')||['.','..'].includes(part))fail();const next=fs.openSync(`/proc/self/fd/${parentFd}/${part}`,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);if(fd!==undefined)fs.closeSync(fd);fd=next;parentFd=fd;}
    const result=new AnchoredDirectory(fd,()=>runtimeHandle.verify());fd=undefined;return result;
  } finally {if(fd!==undefined)fs.closeSync(fd);}
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
    for(;;) { const count=fs.readSync(fd,buffer,0,buffer.length,total); if(!count) break; total+=count; if(total>128*1024*1024) fail('DEPLOY_RELEASE_INVALID'); digest.update(buffer.subarray(0,count)); }
    if(digest.digest('hex')!==record.sha256 || !same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(location,{bigint:true}))) fail('DEPLOY_RELEASE_INVALID');
    directory.verify();
    const named=path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,relativeName);
    return {fd,verify:()=>{
      if(!same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(named,{bigint:true}))) fail('DEPLOY_RELEASE_CHANGED');
    }};
  } catch(error) { if(fd!==undefined) fs.closeSync(fd); throw error; }
  finally { directory.close(); }
}

const RUNTIME_BUNDLES = Object.freeze({
  mcp: 'mcp-server/dist/runtime/mcp.cjs',
  control: 'mcp-server/dist/runtime/control.cjs',
  hook: 'mcp-server/dist/runtime/hook.cjs',
});

export function openRuntimeBundle({repositoryRoot, releaseId, selector}) {
  if (typeof selector !== 'string' || !Object.hasOwn(RUNTIME_BUNDLES, selector)) fail('DEPLOY_SELECTOR_INVALID');
  return openArtifact(repositoryRoot, releaseId, RUNTIME_BUNDLES[selector]);
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
function releaseManifest(repositoryRoot,releaseId,runtimeHandle=null) {
  if(typeof releaseId!=='string' || !RELEASE.test(releaseId)) fail();
  const directory=runtimeHandle?anchoredDirectory(runtimeHandle,['releases',releaseId]):new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId));
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
function requireGenerationTwo(repositoryRoot,releaseId,manifest,runtimeHandle=null) {
  const record=manifest.entries.find(entry=>entry.path===COMPATIBILITY_DECLARATION);
  if(!record||record.type!=='file')fail();
  const directory=runtimeHandle?anchoredDirectory(runtimeHandle,['releases',releaseId,'mcp-server','src','control']):new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'mcp-server/src/control'));
  try {
    const bytes=read(directory,'runtime-compatibility.json',record.mode,16384);
    if(hash(bytes)!==record.sha256)fail();
    const declaration=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!exact(declaration,['version','generation','guardFloor'])||declaration.version!==1||declaration.generation!==2||
        typeof declaration.guardFloor!=='number'||declaration.guardFloor!==1)fail();
  } finally { directory.close(); }
}

function readSet(directory,repositoryRoot,runtimeHandle=null) {
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
  const source=releaseManifest(repositoryRoot,manifest.sourceReleaseId,runtimeHandle);
  const sourceDirectory=runtimeHandle?anchoredDirectory(runtimeHandle,['releases',manifest.sourceReleaseId,'scripts']):new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',manifest.sourceReleaseId,'scripts'));
  try {
    for(const record of manifest.files) {
      const original=source.entries.find(entry=>entry.path===`scripts/${record.name}`);
      if(!original || original.type!=='file' || original.mode!==record.mode || original.sha256!==record.sha256 || hash(read(sourceDirectory,record.name,record.mode))!==record.sha256) fail();
    }
  } finally { sourceDirectory.close(); }
  directory.verify(); return manifest;
}
function readRouterSet(directory,repositoryRoot,runtimeHandle=null) {
  directory.verify();
  if ((Number(fs.fstatSync(directory.fd).mode)&0o7777)!==0o700) fail();
  if(fs.readdirSync(`/proc/self/fd/${directory.fd}`).sort().join(',')!==[...ROUTER_FILES,'manifest.json'].sort().join(',')) fail();
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(directory,'manifest.json',0o600,16384)));
  if(!exact(manifest,['version','sourceReleaseId','routerContract','files']) || manifest.version!==2 ||
      typeof manifest.sourceReleaseId!=='string' || !RELEASE.test(manifest.sourceReleaseId) ||
      typeof manifest.routerContract!=='number' || manifest.routerContract!==1 ||
      !Array.isArray(manifest.files) || manifest.files.length!==ROUTER_FILES.length) fail();
  for(let index=0;index<ROUTER_FILES.length;index++) {
    const record=manifest.files[index]; const name=ROUTER_FILES[index];
    if(!exact(record,['name','mode','sha256']) || typeof record.name!=='string' || typeof record.mode!=='number' ||
        typeof record.sha256!=='string' || record.name!==name || record.mode!==0o755 || !/^[a-f0-9]{64}$/.test(record.sha256) ||
        hash(read(directory,name,0o755))!==record.sha256) fail();
  }
  const source=releaseManifest(repositoryRoot,manifest.sourceReleaseId,runtimeHandle);
  requireGenerationTwo(repositoryRoot,manifest.sourceReleaseId,source,runtimeHandle);
  const scripts=runtimeHandle?anchoredDirectory(runtimeHandle,['releases',manifest.sourceReleaseId,'scripts']):new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',manifest.sourceReleaseId,'scripts'));
  try {
    for(const record of manifest.files) {
      const original=source.entries.find(entry=>entry.path===`scripts/${record.name}`);
      if(!original || original.type!=='file' || original.mode!==record.mode || original.sha256!==record.sha256 ||
          hash(read(scripts,record.name,record.mode))!==record.sha256) fail();
    }
  } finally { scripts.close(); }
  directory.verify(); return manifest;
}
export function validateBootstrap({repositoryRoot}) {
  let directory;
  try {
    directory=new Directory(path.join(repositoryRoot,'.jhw-runtime/bootstrap'));
    const preliminary=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(directory,'manifest.json',0o600,16384)));
    return preliminary?.version===2 ? readRouterSet(directory,repositoryRoot) : readSet(directory,repositoryRoot);
  }
  catch { fail(); }
  finally { directory?.close(); }
}
function requireLeaseIdentity(lease,file) {
  if(!lease||!Number.isInteger(lease.fd)||lease.fd<0)fail();
  let held;let named;try{held=fs.fstatSync(lease.fd,{bigint:true});named=fs.lstatSync(file,{bigint:true});}catch{fail();}
  if(!held.isFile()||held.uid!==BigInt(process.getuid())||held.nlink!==1n||(Number(held.mode)&0o7777)!==0o600||!same(held,named))fail();
}
function requireRuntimeHandle(repositoryRoot,runtimeHandle) {
  if(!runtimeHandle||!Number.isInteger(runtimeHandle.fd)||runtimeHandle.fd<0||typeof runtimeHandle.verify!=='function')fail();
  runtimeHandle.verify();let held;let named;
  try{held=fs.fstatSync(runtimeHandle.fd,{bigint:true});named=fs.lstatSync(path.join(repositoryRoot,'.jhw-runtime'),{bigint:true});}catch{fail();}
  if(!held.isDirectory()||held.uid!==BigInt(process.getuid())||(Number(held.mode)&0o7777)!==0o700)fail();
  for(const key of ['dev','ino','uid','gid','mode'])if(held[key]!==named[key])fail();
  return held;
}

function bootstrapName(name) {
  if(name!=='bootstrap'&&!/^\.bootstrap\.(?:stage|previous|failed)\.[a-f0-9]{32}$/.test(name))fail();
  return name;
}
function proofInteger(value){return value.toString(10);}
function proofDirectory(stat){return {dev:proofInteger(stat.dev),ino:proofInteger(stat.ino),uid:proofInteger(stat.uid),gid:proofInteger(stat.gid),
  mode:Number(stat.mode),nlink:proofInteger(stat.nlink),size:proofInteger(stat.size),mtimeNs:proofInteger(stat.mtimeNs)};}
function proofFile(directory,name) {
  let fd;
  try {
    fd=fs.openSync(directory.at(name),C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||before.size>4n*1024n*1024n)fail();
    const bytes=Buffer.alloc(Number(before.size));let offset=0;
    while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)fail();offset+=count;}
    if(fs.readSync(fd,Buffer.alloc(1),0,1,null)!==0||!same(before,fs.fstatSync(fd,{bigint:true}))||!same(before,fs.lstatSync(directory.at(name),{bigint:true})))fail();
    return {name,dev:proofInteger(before.dev),ino:proofInteger(before.ino),uid:proofInteger(before.uid),gid:proofInteger(before.gid),
      mode:Number(before.mode),nlink:proofInteger(before.nlink),size:proofInteger(before.size),ctimeNs:proofInteger(before.ctimeNs),
      mtimeNs:proofInteger(before.mtimeNs),sha256:hash(bytes)};
  } finally {if(fd!==undefined)fs.closeSync(fd);}
}
function bootstrapProof(repositoryRoot,name,runtimeHandle=null) {
  bootstrapName(name);let directory;
  try {
    if(runtimeHandle)requireRuntimeHandle(repositoryRoot,runtimeHandle);
    directory=runtimeHandle?anchoredDirectory(runtimeHandle,[name]):new Directory(path.join(repositoryRoot,'.jhw-runtime',name));
    const first=fs.fstatSync(directory.fd,{bigint:true});
    if(!first.isDirectory()||first.uid!==BigInt(process.getuid())||(Number(first.mode)&0o7777)!==0o700)fail();
    const named=runtimeHandle?fs.lstatSync(`/proc/self/fd/${runtimeHandle.fd}/${name}`,{bigint:true}):fs.lstatSync(path.join(repositoryRoot,'.jhw-runtime',name),{bigint:true});
    for(const key of ['dev','ino','uid','gid','mode'])if(first[key]!==named[key])fail();
    const preliminary=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(directory,'manifest.json',0o600,16384)));
    preliminary?.version===2?readRouterSet(directory,repositoryRoot,runtimeHandle):readSet(directory,repositoryRoot,runtimeHandle);
    const names=fs.readdirSync(`/proc/self/fd/${directory.fd}`).sort();
    const files=names.map(child=>proofFile(directory,child));
    const last=fs.fstatSync(directory.fd,{bigint:true});
    for(const key of ['dev','ino','uid','gid','mode','nlink','size','mtimeNs'])if(first[key]!==last[key])fail();
    directory.verify();
    return {version:1,directory:proofDirectory(last),files};
  } finally {directory?.close();}
}

const PROOF_INTEGER=/^(?:0|[1-9][0-9]{0,39})$/;
function validProofMode(value){return Number.isInteger(value)&&value>=0&&value<=0o177777;}
function validProofInteger(value){return typeof value==='string'&&PROOF_INTEGER.test(value);}
/** Closed structural validator for journal parsing; it grants no filesystem trust. */
export function validBootstrapObjectProof(value) {
  if(!exact(value,['version','directory','files'])||value.version!==1||
      !exact(value.directory,['dev','ino','uid','gid','mode','nlink','size','mtimeNs'])||
      !validProofInteger(value.directory.dev)||!validProofInteger(value.directory.ino)||
      !validProofInteger(value.directory.uid)||!validProofInteger(value.directory.gid)||!validProofMode(value.directory.mode)||
      !validProofInteger(value.directory.nlink)||!validProofInteger(value.directory.size)||
      !validProofInteger(value.directory.mtimeNs)||!Array.isArray(value.files)||value.files.length<1||value.files.length>16)return false;
  let previous='';
  for(const file of value.files){
    if(!exact(file,['name','dev','ino','uid','gid','mode','nlink','size','ctimeNs','mtimeNs','sha256'])||
        typeof file.name!=='string'||!/^[A-Za-z0-9._-]+$/.test(file.name)||file.name<=previous||file.name.length>255||
        !validProofInteger(file.dev)||!validProofInteger(file.ino)||!validProofInteger(file.uid)||!validProofInteger(file.gid)||
        !validProofMode(file.mode)||!validProofInteger(file.nlink)||!validProofInteger(file.size)||
        !validProofInteger(file.ctimeNs)||!validProofInteger(file.mtimeNs)||typeof file.sha256!=='string'||!DIGEST.test(file.sha256))return false;
    previous=file.name;
  }
  return true;
}

/** Durable, JSON-safe proof for a closed bootstrap namespace object. */
export function bootstrapObjectProof({repositoryRoot,name}) {
  try{return bootstrapProof(repositoryRoot,name);}
  catch(error){if(error.code&&/^DEPLOY_[A-Z_]+$/.test(error.code))throw error;fail();}
}

/** Build and prove a private router stage without reading or changing bootstrap. */
export async function prepareRouterV2({repositoryRoot,releaseId,deployLease,admissionLease}) {
  if(typeof releaseId!=='string'||!RELEASE.test(releaseId))fail();
  requireLeaseIdentity(deployLease,path.join(repositoryRoot,'.jhw-runtime/deploy.lock'));
  requireLeaseIdentity(admissionLease,path.join(repositoryRoot,'.jhw-runtime/admission.lock'));
  const release=releaseManifest(repositoryRoot,releaseId);requireGenerationTwo(repositoryRoot,releaseId,release);
  let runtime;let source;let stage;let stageName;
  try {
    runtime=new Directory(path.join(repositoryRoot,'.jhw-runtime'));
    if((fs.fstatSync(runtime.fd).mode&0o7777)!==0o700)fail();
    source=new Directory(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'scripts'));
    const contents=ROUTER_FILES.map(name=>({name,bytes:read(source,name,0o755)}));
    const manifest={version:2,sourceReleaseId:releaseId,routerContract:1,
      files:contents.map(({name,bytes})=>({name,mode:0o755,sha256:hash(bytes)}))};
    stageName=`.bootstrap.stage.${randomBytes(16).toString('hex')}`;
    fs.mkdirSync(runtime.at(stageName),{mode:0o700});fs.chmodSync(runtime.at(stageName),0o700);
    stage=anchoredDirectory(runtime,[stageName]);
    for(const {name,bytes} of contents)write(stage,name,bytes,0o755);
    write(stage,'manifest.json',Buffer.from(canonical(manifest)+'\n'),0o600);
    readRouterSet(stage,repositoryRoot,{fd:runtime.fd,verify:()=>runtime.verify()});fs.fsyncSync(stage.fd);source.verify();runtime.verify();
    const proof=bootstrapProof(repositoryRoot,stageName,{fd:runtime.fd,verify:()=>runtime.verify()});
    return {stageName,manifest,proof};
  } catch(error){if(error.code&&/^DEPLOY_[A-Z_]+$/.test(error.code))throw error;fail();}
  finally{stage?.close();source?.close();runtime?.close();}
}

/** Move a proven bootstrap object to an absent closed name with no fallback. */
export async function moveBootstrapObject({repositoryRoot,sourceName,destinationName,expectedProof,runtimeHandle,capability,deployLease,admissionLease}) {
  requireLeaseIdentity(deployLease,path.join(repositoryRoot,'.jhw-runtime/deploy.lock'));
  requireLeaseIdentity(admissionLease,path.join(repositoryRoot,'.jhw-runtime/admission.lock'));
  bootstrapName(sourceName);bootstrapName(destinationName);
  if(sourceName===destinationName)fail();
  try {
    requireRuntimeHandle(repositoryRoot,runtimeHandle);
    const before=bootstrapProof(repositoryRoot,sourceName,runtimeHandle);
    if(canonical(before)!==canonical(expectedProof))fail('DEPLOY_BOOTSTRAP_CHANGED');
    const safety=await maintenanceSafety();
    safety.atomicRename({capability,sourceDirectory:runtimeHandle,destinationDirectory:runtimeHandle,sourceName,destinationName,operation:'noreplace'});
    const after=bootstrapProof(repositoryRoot,destinationName,runtimeHandle);
    if(canonical(after)!==canonical(expectedProof))fail('DEPLOY_BOOTSTRAP_CHANGED');
    return after;
  } catch(error){if(error.code&&/^DEPLOY_[A-Z_]+$/.test(error.code))throw error;fail();}
}

/** Stopped-path-only publication of the stable v2 selector. */
export async function installRouterV2({repositoryRoot,releaseId,deployLease,admissionLease,previousDirectory:reservedPreviousDirectory=null,onRouterIntent}) {
  let runtime;let previousDirectory=null;
  try {
    if(typeof releaseId!=='string'||!RELEASE.test(releaseId))fail();
    requireLeaseIdentity(deployLease,path.join(repositoryRoot,'.jhw-runtime/deploy.lock'));
    requireLeaseIdentity(admissionLease,path.join(repositoryRoot,'.jhw-runtime/admission.lock'));
    const release=releaseManifest(repositoryRoot,releaseId);requireGenerationTwo(repositoryRoot,releaseId,release);
    runtime=new Directory(path.join(repositoryRoot,'.jhw-runtime'));
    let existing=false;try{fs.lstatSync(runtime.at('bootstrap'));existing=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing){const current=validateBootstrap({repositoryRoot});if(current?.version===2&&current.sourceReleaseId===releaseId&&current.routerContract===1)
      return {sourceReleaseId:releaseId,routerContract:1,previousDirectory:null};}
    runtime.close();runtime=undefined;
    const prepared=await prepareRouterV2({repositoryRoot,releaseId,deployLease,admissionLease});
    runtime=new Directory(path.join(repositoryRoot,'.jhw-runtime'));
    if((fs.fstatSync(runtime.fd).mode&0o7777)!==0o700)fail();
    let previousProof=null;let previous;
    try{fs.lstatSync(runtime.at('bootstrap'));previous=validateBootstrap({repositoryRoot});previousProof=bootstrapProof(repositoryRoot,'bootstrap',{fd:runtime.fd,verify:()=>runtime.verify()});}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(previous?.version===2&&canonical(previous)===canonical(prepared.manifest))return {sourceReleaseId:releaseId,routerContract:1,previousDirectory:null};
    if(previous){
      if(canonical(validateBootstrap({repositoryRoot}))!==canonical(previous))fail('DEPLOY_BOOTSTRAP_CHANGED');
      previousDirectory=reservedPreviousDirectory??`.bootstrap.previous.${randomBytes(16).toString('hex')}`;
      if(!/^\.bootstrap\.previous\.[a-f0-9]{32}$/.test(previousDirectory))fail();
    }
    const descriptor={sourceReleaseId:releaseId,routerContract:1,stageName:prepared.stageName,previousDirectory,stageProof:prepared.proof,previousProof};
    let intentResult=onRouterIntent?.(descriptor);
    if(intentResult!==null&&(typeof intentResult==='object'||typeof intentResult==='function')&&typeof intentResult.then==='function')fail();
    const safety=await maintenanceSafety();
    const capability=safety.prepareAtomicRename({directory:runtime});
    if(previousProof){
      await moveBootstrapObject({repositoryRoot,sourceName:'bootstrap',destinationName:previousDirectory,expectedProof:previousProof,
        runtimeHandle:runtime,capability,deployLease,admissionLease});
    }
    await moveBootstrapObject({repositoryRoot,sourceName:prepared.stageName,destinationName:'bootstrap',expectedProof:prepared.proof,
      runtimeHandle:runtime,capability,deployLease,admissionLease});
    const installed=validateBootstrap({repositoryRoot});
    if(canonical(installed)!==canonical(prepared.manifest))fail('DEPLOY_BOOTSTRAP_CHANGED');
    return {sourceReleaseId:installed.sourceReleaseId,routerContract:installed.routerContract,previousDirectory};
  } catch(error){if(error.code&&/^DEPLOY_[A-Z_]+$/.test(error.code))throw error;fail();}
  finally{runtime?.close();}
}
export function validateRetainedBootstrap({repositoryRoot,name,runtimeHandle=null}) {
  if(typeof name!=='string'||!/^\.bootstrap\.previous\.[a-f0-9]{32}$/.test(name))fail();
  let directory;
  try {
    directory=runtimeHandle?anchoredDirectory(runtimeHandle,[name]):new Directory(path.join(repositoryRoot,'.jhw-runtime',name));
    const preliminary=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(read(directory,'manifest.json',0o600,16384)));
    return preliminary?.version===2?readRouterSet(directory,repositoryRoot,runtimeHandle):readSet(directory,repositoryRoot,runtimeHandle);
  }
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
async function maintenanceSafety(){return import('./runtime-safety.mjs');}
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
  // jhw-control-host accepts a nonzero control exit only with this single JSON error line.
  if(selector==='control') { process.stderr.write(JSON.stringify({error:{code}})+'\n'); return 75; }
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
const invalid=()=>{ throw Object.assign(new Error('DEPLOY_RUNTIME_BINDING_INVALID'),{code:'DEPLOY_RUNTIME_BINDING_INVALID'}); };
const same=(a,b)=>['dev','ino','uid','gid','mode','nlink','size','ctimeNs','mtimeNs'].every(key=>a[key]===b[key]);
const fdRoles={3:'admission',6:'binding',7:'generation'};
if(credential==='fd')fdRoles[5]='credential';
if(process.env.JHW_RUNTIME_SESSION_BINDING!==undefined)fdRoles[8]='parent';
for(const fd of Object.keys(fdRoles)){try{fs.fstatSync(Number(fd));fs.readlinkSync('/proc/self/fd/'+fd);}catch{invalid();}}
const parseCredential=bytes=>{
  let text; try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { invalid(); }
  if(text.includes('\0')) invalid();
  let credentialValue;
  for(let line of text.split('\n')) {
    if(line.endsWith('\r')) line=line.slice(0,-1);
    if(/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const match=/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(line);
    if(!match) invalid();
    if(match[1]!=='NOTION_API_KEY') continue;
    if(credentialValue!==undefined) invalid();
    let value=match[2].trim();
    if(value.startsWith("'")) {
      if(value.length<2 || !value.endsWith("'") || value.slice(1,-1).includes("'")) invalid();
      value=value.slice(1,-1);
    } else if(value.startsWith('"')) {
      if(value.length<2 || !value.endsWith('"')) invalid();
      const body=value.slice(1,-1); let decoded='';
      for(let index=0;index<body.length;index++) {
        if(body[index]!=='\\') { decoded+=body[index]; continue; }
        const next=body[++index];
        if(next==='n') decoded+='\n'; else if(next==='r') decoded+='\r'; else if(next==='t') decoded+='\t';
        else if(next==='"' || next==='\\') decoded+=next; else invalid();
      }
      value=decoded;
    }
    if(!value || value.length>16*1024 || /[\0\r\n]/.test(value)) invalid();
    credentialValue=value;
  }
  return credentialValue;
};
const loadCredential=()=>{
  let before;
  try {
    before=fs.fstatSync(5,{bigint:true}); const mode=Number(before.mode);
    if(!before.isFile() || before.uid!==BigInt(process.getuid()) || before.nlink!==1n || mode&0o7022 || !(mode&0o400) || before.size>1024n*1024n) invalid();
    const bytes=Buffer.alloc(Number(before.size)); let offset=0;
    while(offset<bytes.length) { const count=fs.readSync(5,bytes,offset,bytes.length-offset,null); if(!count) invalid(); offset+=count; }
    if(fs.readSync(5,Buffer.alloc(1),0,1,null)!==0 || !same(before,fs.fstatSync(5,{bigint:true}))) invalid();
    return parseCredential(bytes);
  } finally { try { fs.closeSync(5); } catch {} }
};
if(typeof releaseRoot!=='string' || !path.isAbsolute(releaseRoot) || path.resolve(releaseRoot)!==releaseRoot || releaseRoot.includes('\0') || !['mcp','control','hook'].includes(selector) || !['none','fd'].includes(credential)) invalid();
if(credential==='fd') { const value=loadCredential(); if(value!==undefined) process.env.NOTION_API_KEY=value; }
Object.defineProperty(globalThis,'__JHW_MANAGED_RELEASE_ROOT__',{value:releaseRoot,writable:false,configurable:false,enumerable:false});
const builtins=new Set(Module.builtinModules.flatMap(name=>[name,'node:'+name]));
const load=Module._load; let loadingEntry=true;
Module._load=function(request,parent,isMain){
  if(loadingEntry && request===entry) { loadingEntry=false; return load.apply(this,arguments); }
  if(!builtins.has(request)) throw Object.assign(new Error('DEPLOY_EXTERNAL_MODULE_FORBIDDEN'),{code:'DEPLOY_EXTERNAL_MODULE_FORBIDDEN'});
  return load.apply(this,arguments);
};
process.argv=[process.execPath,entry,...args];
if(selector==='control') {
  let wrote=false; const write=process.stderr.write;
  process.stderr.write=function(){ wrote=true; return write.apply(this,arguments); };
  process.on('uncaughtException',error=>{
    if(!wrote) { try { fs.writeSync(2,JSON.stringify({error:{code:typeof error?.code==='string' && /^DEPLOY_[A-Z_]{1,56}$/.test(error.code)?error.code:'DEPLOY_START_FAILED'}})+'\n'); } catch {} }
    process.exit(1);
  });
}
require(entry);
`;

const HOOK_RUNNER_SOURCE=String.raw`
const {spawn}=require('node:child_process');
const releaseRoot=process.argv[1]; const args=process.argv.slice(2); const event=args[3];
const coreRunner=${JSON.stringify(MODULE_RUNNER_SOURCE)};
const exact=(value,keys)=>value!==null && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const fallback=code=>{
  let value;
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
let child; let timer; let killTimer; let settled=false; let timedOut=false; let overflow=false; let length=0; const chunks=[];
const finish=(code,signal)=>{
  if(settled) return; settled=true; clearTimeout(timer); clearTimeout(killTimer);
  const output=!overflow && code===0 && signal===null ? validate(Buffer.concat(chunks,length)) : undefined;
  if(output) process.stdout.write(output); else fallback(timedOut ? 'GUARD_HOOK_TIMEOUT' : 'GUARD_UNAVAILABLE');
};
try { child=spawn(process.execPath,['-e',coreRunner,'--','/proc/self/fd/4',releaseRoot,'hook','none',...args],{stdio:['inherit','pipe','inherit',3,4,'ignore',6,7,8]}); }
catch { fallback('GUARD_UNAVAILABLE'); process.exit(0); }
child.stdout.on('data',chunk=>{ if(overflow) return; length+=chunk.length; if(length>12*1024) { overflow=true; chunks.length=0; child.kill('SIGTERM'); } else chunks.push(chunk); });
child.stdout.on('error',()=>{ overflow=true; child.kill('SIGTERM'); });
child.once('error',()=>finish(null,null)); child.once('close',finish);
timer=setTimeout(()=>{ timedOut=true; child.kill('SIGTERM'); killTimer=setTimeout(()=>child.kill('SIGKILL'),200); },event==='SessionEnd' ? 2000 : 8000);
`;

function runPinnedHook({args,artifact,lease,binding,releaseRoot}) {
  return new Promise(resolve=>{
    let child;
    try {
      artifact.verify();
      child=spawn(process.execPath,['-e',HOOK_RUNNER_SOURCE,'--',releaseRoot,...args],{stdio:['inherit','inherit','inherit',lease.fd,artifact.fd,'ignore',binding.lease?.fd??binding.fd,binding.generationLease?.fd??'ignore',binding.parentLease?.fd??'ignore'],env:runtimeEnvironment()});
      fs.closeSync(artifact.fd); artifact.fd=undefined;
    } catch { if(artifact.fd!==undefined) { fs.closeSync(artifact.fd); artifact.fd=undefined; } resolve(failure('hook',args,'GUARD_UNAVAILABLE')); return; }
    child.once('error',()=>resolve(failure('hook',args,'GUARD_UNAVAILABLE')));
    child.once('exit',(code,signal)=>resolve(code===0 && signal===null ? 0 : failure('hook',args,'GUARD_UNAVAILABLE')));
  });
}

export async function runManaged({repositoryRoot,selector,args=[],sourceReleaseId,safetySource,storeSource,selectedPair=null}) {
  let lease; let publication; let binding; let credential; const artifacts=[];
  try {
    if(!['mcp','control','hook','session'].includes(selector)) fail('DEPLOY_SELECTOR_INVALID');
    if(!Array.isArray(args) || args.some(value=>typeof value!=='string' || value.includes('\0'))) fail('DEPLOY_SELECTOR_INVALID');
    if(selectedPair!==null && (!exact(selectedPair,['releaseId','bootstrapId','runtimeContract','compatibilityDigest']) ||
        typeof selectedPair.releaseId!=='string' || typeof selectedPair.bootstrapId!=='string' ||
        typeof selectedPair.runtimeContract!=='number' || typeof selectedPair.compatibilityDigest!=='string' ||
        !RELEASE.test(selectedPair.releaseId) || !BOOTSTRAP.test(selectedPair.bootstrapId) ||
        selectedPair.runtimeContract!==2 || !DIGEST.test(selectedPair.compatibilityDigest))) fail('DEPLOY_SESSION_INVALID');
    if(selector==='hook' && (args.length!==4 || args[0]!=='--adapter' || !['claude','codex'].includes(args[1]) || args[2]!=='--event' || !['PreToolUse','PostToolUse','UserPromptSubmit','SessionEnd'].includes(args[3]))) return failure(selector,args,'GUARD_PROTOCOL_MISMATCH');
    if(selector==='session' && (args.length<2 || args[0]!=='--' || !args[1])) fail('DEPLOY_SELECTOR_INVALID');
    const token=process.env.JHW_RUNTIME_SESSION_BINDING;
    // A nested wrapper cannot silently turn an existing client's later work into a new generation.
    if(selector==='session' && token!==undefined) fail('DEPLOY_SESSION_INVALID');
    const validated=validateBootstrap({repositoryRoot});
    if(sourceReleaseId!==validated.sourceReleaseId || !Buffer.isBuffer(safetySource) || !Buffer.isBuffer(storeSource)) fail('DEPLOY_BOOTSTRAP_CHANGED');
    if(selectedPair===null){
      const byName=new Map(validated.files.map(record=>[record.name,record]));
      if(hash(safetySource)!==byName.get('runtime-safety.mjs')?.sha256 || hash(storeSource)!==byName.get('runtime-store.mjs')?.sha256) fail('DEPLOY_BOOTSTRAP_CHANGED');
    }
    const moduleUrl=bytes=>'data:text/javascript;base64,'+Buffer.from(bytes).toString('base64');
    const safetyUrl=moduleUrl(safetySource);
    const safety=await import(safetyUrl);
    try {
      // Keep the original lifetime lease: even orphan children still block ordinary maintenance.
      lease=safety.acquireLease(path.join(repositoryRoot,'.jhw-runtime/admission.lock'),{shared:true});
      if(selectedPair===null || token===undefined) publication=acquirePublication(safety,path.join(repositoryRoot,'.jhw-runtime/publication.lock'),selectedPair!==null);
    } catch(error) { if(error.code==='DEPLOY_LOCK_CONTENDED') fail('DEPLOY_MAINTENANCE'); throw error; }
    if(canonical(validateBootstrap({repositoryRoot}))!==canonical(validated)) fail('DEPLOY_BOOTSTRAP_CHANGED');
    const storeText=new TextDecoder('utf-8',{fatal:true}).decode(storeSource);
    const safetySpecifier="'./runtime-safety.mjs'";
    if(storeText.split(safetySpecifier).length!==2) fail('DEPLOY_BOOTSTRAP_CHANGED');
    const store=await import(moduleUrl(Buffer.from(storeText.replace(safetySpecifier,JSON.stringify(safetyUrl)))));
    if(token===undefined) store.assertNoSessionAncestor({repositoryRoot});
    let selected;
    if(selectedPair===null){
      const bound=store.bindEntryRelease({repositoryRoot,token,kind:selector==='session'?'session':'invocation'});
      binding=bound.binding;selected={releaseId:bound.releaseId};
    }else{
      const bound=store.bindEntryPair({repositoryRoot,token,kind:selector==='session'?'session':'invocation',selectedPair,admissionLease:lease});
      if(bound?.retryCurrent===true)return {retryCurrent:true};
      binding=bound;selected=selectedPair;
    }
    const release=path.join(repositoryRoot,'.jhw-runtime/releases',selected.releaseId);
    if(selector==='session') {
      const environment=runtimeEnvironment();
      environment.JHW_RUNTIME_SESSION_BINDING=binding.token;
      publication?.close(); publication=undefined;
      return await new Promise((resolve,reject)=>{
        const child=spawn(args[1],args.slice(2),{stdio:['inherit','inherit','inherit',lease.fd,'ignore','ignore',binding.lease?.fd??binding.fd,binding.generationLease?.fd??'ignore',binding.parentLease?.fd??'ignore'],env:environment});
        child.once('error',()=>reject(Object.assign(new Error('DEPLOY_START_FAILED'),{code:'DEPLOY_START_FAILED'})));
        child.once('exit',(code,signal)=>resolve(code??(128+(osConstants.signals[signal]??1))));
      });
    }
    artifacts.push(openRuntimeBundle({repositoryRoot,releaseId:selected.releaseId,selector}));
    if(selector==='mcp') credential=openCredential(repositoryRoot,selected.releaseId);
    publication?.close(); publication=undefined;
    if(selector==='hook') return await runPinnedHook({args,artifact:artifacts.pop(),lease,binding,releaseRoot:release});
    const childArgs=['-e',MODULE_RUNNER_SOURCE,'--','/proc/self/fd/4',release,selector,credential?'fd':'none',...args];
    return await new Promise((resolve,reject)=>{
      for(const artifact of artifacts) artifact.verify();
      credential?.verify();
      // Credential remains fd 5; session lifetime proof has a separate inherited fd 6.
      const child=spawn(process.execPath,childArgs,{stdio:['inherit','inherit','inherit',lease.fd,...artifacts.map(artifact=>artifact.fd),credential?.fd??'ignore',binding.lease?.fd??binding.fd,binding.generationLease?.fd??'ignore',binding.parentLease?.fd??'ignore'],env:runtimeEnvironment()});
      for(const artifact of artifacts.splice(0)) fs.closeSync(artifact.fd);
      if(credential){fs.closeSync(credential.fd);credential.fd=undefined;}
      child.once('error',()=>reject(Object.assign(new Error('DEPLOY_START_FAILED'),{code:'DEPLOY_START_FAILED'})));
      child.once('exit',(code,signal)=>{
        if(code!==null) { resolve(code); return; }
        // jhw-control-host captures control output and accepts only rc 75 with one JSON line for a signalled child; `board with` streams (inherited stdio, signal status propagated) and mcp keep 128+n.
        if(selector!=='control' || (args[0]==='board' && args[1]==='with')) { resolve(128+(osConstants.signals[signal]??1)); return; }
        process.stderr.write(JSON.stringify({error:{code:'DEPLOY_CHILD_SIGNALED'}})+'\n');
        resolve(75);
      });
    });
  } catch(error) {
    return failure(selector,args,typeof error.code==='string' && /^DEPLOY_[A-Z_]{1,56}$/.test(error.code)?error.code:'DEPLOY_START_FAILED');
  } finally {
    // A failure line may already be written: no cleanup step may throw into a second emission.
    const quiet=close=>{ try { close(); } catch {} };
    for(const artifact of artifacts) if(artifact.fd!==undefined) quiet(()=>fs.closeSync(artifact.fd));
    if(credential?.fd!==undefined) quiet(()=>fs.closeSync(credential.fd));
    quiet(()=>publication?.close()); quiet(()=>binding?.close()); quiet(()=>lease?.close());
  }
}
