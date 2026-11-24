import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DeploymentError, trustedDirectory, trustedFile, acquireLease, inspectConsumers, inspectSessionConsumers, observeSessionConsumers, requireQuiescence,prepareAtomicRename,atomicRename} from './runtime-safety.mjs';
import {prepareRelease, validateRelease, readActivation, validCurrent, publishActivation, rollbackActivation, createSessionBinding, resolveSessionBinding, inspectSessionBindings, releaseCompatibility,ensureBootstrapGeneration,prepareRuntimeEvidence,revalidateRuntimeEvidence,preparePairActivation,publishPreparedActivation,inspectSessionBindingsV2,resolveSessionBindingV2,selectPairRollbackTarget,validRuntimePair,preparePairPublicationEvidence,preparePrunePublicationEvidence,revalidatePairPublicationEvidence,revalidateRetainedPruneEvidence,verifyPairPublicationConsumer,prepareMigrationAnchor,readMigrationAnchor,releaseRuntimeGeneration,verifyMigrationOriginal,prepareTransitionPointer,inspectTransitionPointer,publishTransitionPointer} from './runtime-store.mjs';
import {installBootstrap, validateBootstrap,prepareRouterV2,bootstrapObjectProof,moveBootstrapObject} from './runtime-entry.mjs';
import {DEPLOY_VARIABLE_KEYS,applyRuntimePrune,planRuntimePrune,prepareRuntimePrune,pruneExecutionRoute,recordDeploymentRetention,readRuntimeJournalV2,findLegacyActivationReceipt,findCompletedBootstrapMigration} from './runtime-prune.mjs';
import {readGuardHostPolicy,captureGuardTransitionEvidence,writeGuardTransitionEvidence,readGuardTransitionEvidence,recordGuardPolicyContext,recordGuardPublishedSnapshots,recordGuardDestination,markGuardTransitionFinalized,findGuardTransitionEvidence,prepareGuardRollbackEvidence,prepareIncompleteGuardRollbackEvidence,restoreGuardRollbackEvidence,prepareMigrationGuardRollback,restoreMigrationGuardRollback} from './runtime-guard.mjs';
import {requireManagedScope} from './runtime-managed-scope.mjs';

const RELEASE = /^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/;
const KEYS = DEPLOY_VARIABLE_KEYS;
const ENV_ADAPTERS=['claude','codex','gemini','opencode'];
// Reacquisition after validation: samples, the wait between them, and the refusals sampled again.
const REACQUIRE_ATTEMPTS=5;const REACQUIRE_INTERVAL_MS=200;const REACQUIRE_RETRIED=['DEPLOY_LOCK_CONTENDED','DEPLOY_INVENTORY_UNCERTAIN'];
const fail = (code,reason) => {throw new DeploymentError(code,reason);};
function exists(file) {try {fs.lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function parse(argv) {
 if(!Array.isArray(argv)||argv.some(v=>typeof v!=='string'))fail('DEPLOY_ARGUMENTS_INVALID');
 if(argv.length===0)return {operation:'default'};
 if(argv.length===1&&['--prepare','--status','--rollback','--uninstall','--refresh-bootstrap','--migrate-codex-config','--help','-h'].includes(argv[0]))return {operation:argv[0].replace(/^--?/,'')};
 if(argv.length===1&&argv[0]==='--prune')return {operation:'prune',apply:false};
 if(argv.length===2&&argv[0]==='--prune'&&argv[1]==='--apply')return {operation:'prune',apply:true};
 if(argv.length===2&&argv[0]==='--activate-compatible'&&RELEASE.test(argv[1]))return {operation:'activate-compatible',releaseId:argv[1]};
 if(argv.length===2&&argv[0]==='--activate'&&RELEASE.test(argv[1]))return {operation:'activate',releaseId:argv[1]};
 if(argv.length===3&&argv[0]==='--activate'&&RELEASE.test(argv[1])&&argv[2]==='--guard-observe')return {operation:'activate',releaseId:argv[1],guardObserve:true};
 if(argv.length===4&&argv[0]==='--activate'&&RELEASE.test(argv[1])&&argv[2]==='--adopt-from'&&argv[3]!=='')return {operation:'activate',releaseId:argv[1],adoptFrom:argv[3]};
 fail('DEPLOY_ARGUMENTS_INVALID');
}
// --refresh-bootstrap installs the current release's helper set with this
// checkout's installer, so both must define the same closed helper set.
function requireMatchingInstaller(repositoryRoot,releaseId) {
 validateRelease({repositoryRoot,releaseId});
 const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(digest(path.join(repositoryRoot,'scripts/runtime-entry.mjs'))!==digest(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'scripts/runtime-entry.mjs')))fail('DEPLOY_ARGUMENTS_INVALID','refresh_installer_mismatch');
}
function requireMatchingCodexEditor(repositoryRoot,releaseId) {
 validateRelease({repositoryRoot,releaseId});
 const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 for(const name of ['install-config.mjs','runtime-prune.mjs']) {
  if(digest(path.join(repositoryRoot,'scripts',name))!==digest(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'scripts',name)))
   fail('DEPLOY_ARGUMENTS_INVALID','codex_editor_mismatch');
 }
}
// --adopt-from names a distinct, canonical sibling checkout of this repository.
function validateAdoptSource(repositoryRoot,source) {
 const invalid=()=>fail('DEPLOY_WIRING_CONFLICT','adopt_source_invalid');
 if(!path.isAbsolute(source)||source!==path.resolve(source)||source.split('/').includes('..'))invalid();
 let real;let root;try{real=fs.realpathSync(source);root=fs.realpathSync(repositoryRoot);}catch{invalid();}
 if(real!==source)invalid();
 const within=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));};
 if(within(source,root)||within(root,source))invalid();
 // P must itself be a work-tree root: discovery may not climb above P.
 const git=(directory,args,ceiling)=>{
  const env={PATH:'/usr/bin:/bin',LC_ALL:'C',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',...(ceiling?{GIT_CEILING_DIRECTORIES:path.dirname(directory)}:{})};
  const result=spawnSync('git',['-C',directory,'rev-parse',...args],{env,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:10000,maxBuffer:64*1024});
  if(result.status!==0||!result.stdout.endsWith('\n'))invalid();
  return result.stdout.slice(0,-1);
 };
 const canonical=candidate=>{try{return fs.realpathSync(candidate);}catch{invalid();}};
 if(git(source,['--is-inside-git-dir'],true)!=='false'||canonical(git(source,['--show-toplevel'],true))!==source)invalid();
 if(canonical(path.resolve(source,git(source,['--git-common-dir'],true)))!==canonical(path.resolve(root,git(root,['--git-common-dir']))))invalid();
 // A checkout that already runs managed wiring is not a legacy install.
 const wiring=path.join(source,'.jhw-runtime/wiring.json');
 if(exists(wiring)) {
  let installed;try{const info=fs.lstatSync(wiring);if(!info.isFile()||info.size>4096)invalid();installed=JSON.parse(fs.readFileSync(wiring,'utf8')).installed;}catch{invalid();}
  if(installed!==false)invalid();
 }
}
// The adopt root reaches helpers only through this variable, never inherited.
function adoptEnvironment(env,adoptFrom) {
 delete env.JHW_ADOPT_FROM;if(adoptFrom)env.JHW_ADOPT_FROM=adoptFrom;return env;
}
function pinnedDirectory(directory) {
 const before=trustedDirectory(directory);
 const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 const same=value=>['dev','ino','uid','gid','mode'].every(key=>before[key]===value[key]);
 const verify=()=>{if(!same(fs.fstatSync(fd))||!same(trustedDirectory(directory)))fail('DEPLOY_UNTRUSTED_PATH');};
 try {verify();}catch(error){fs.closeSync(fd);throw error;}
 return {fd,verify,at:name=>`/proc/self/fd/${fd}/${name}`,close:()=>fs.closeSync(fd)};
}
function createPrivateDirectory(parent,name) {
 const directory=pinnedDirectory(parent);let child;
 try {
  fs.mkdirSync(directory.at(name),{mode:0o700});
  child=fs.openSync(directory.at(name),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  fs.fchmodSync(child,0o700);fs.fsyncSync(child);fs.fsyncSync(directory.fd);directory.verify();
  const before=fs.fstatSync(child);const after=fs.lstatSync(directory.at(name));
  if(!after.isDirectory()||before.ino!==after.ino||before.dev!==after.dev)fail('DEPLOY_UNTRUSTED_PATH');
  return path.join(parent,name);
 }finally{if(child!==undefined)fs.closeSync(child);directory.close();}
}
function privateWrite(file,value,{exclusive=false}={}) {
 const directory=pinnedDirectory(path.dirname(file));
 try {
  const tmp=directory.at(`.write.${randomBytes(16).toString('hex')}`);
  const fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  directory.verify();
  const target=directory.at(path.basename(file));
  if(exclusive){fs.linkSync(tmp,target);fs.unlinkSync(tmp);}else fs.renameSync(tmp,target);
  fs.fsyncSync(directory.fd);directory.verify();
 }finally{directory.close();}
}
function privateRead(file,{limit=256*1024}={}) {
 const directory=pinnedDirectory(path.dirname(file));let fd;
 try {
  fd=fs.openSync(directory.at(path.basename(file)),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.size>BigInt(limit))fail('DEPLOY_RECOVERY_REQUIRED');
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
  while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  const same=value=>['dev','ino','uid','gid','mode','nlink','size','ctimeNs','mtimeNs'].every(key=>before[key]===value[key]);
  if(length!==Number(before.size)||!same(fs.fstatSync(fd,{bigint:true}))||!same(fs.lstatSync(directory.at(path.basename(file)),{bigint:true})))fail('DEPLOY_RECOVERY_REQUIRED');
  directory.verify();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
 }finally{if(fd!==undefined)fs.closeSync(fd);directory.close();}
}

const WIRE_PARENTS=['.local','.local/bin','.claude/commands','.gemini/commands','.config/opencode/skills','.codex/skills','.codex/prompts'];
// Retained first-migration evidence only. No automatic restoration and no scan
// of unrelated HOME content. Every byte read is bounded and descriptor-relative.
function wiringPreimages({repositoryRoot,home,releaseId,adoptFrom}) {
 // Directories wire may create come first so a restore visits them last.
 const names=[...WIRE_PARENTS,'.local/bin/jhw-control','.local/bin/jhw-control-hook','.claude.json','.claude/settings.json','.gemini/settings.json','.codex/config.toml','.codex/hooks.json','.config/opencode/opencode.json','.claude/commands/jhw','.gemini/commands/jhw','.config/opencode/skills/jhw','.codex/commands/jhw'];
 if(releaseId) {
  const skills=path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'skills');
  for(const [source,target,pattern] of [['claude','.codex/prompts',/^(?!AGENTS\.md$).+\.md$/],['codex','.codex/skills',/^jhw-/]]) {
   const directory=path.join(skills,source);
   if(exists(directory))for(const name of fs.readdirSync(directory).filter(n=>pattern.test(n)))names.push(`${target}/${name}`);
  }
 }
 // Adoption may remove adopt-root links whose names this release does not ship.
 if(adoptFrom) {
  for(const directory of ['.codex/skills','.codex/prompts']) {
   const parent=path.join(home,directory);if(!exists(parent))continue;
   for(const name of fs.readdirSync(parent)) {
    const file=path.join(parent,name);
    if(fs.lstatSync(file).isSymbolicLink()&&fs.readlinkSync(file).startsWith(`${adoptFrom}/`)&&!names.includes(`${directory}/${name}`))names.push(`${directory}/${name}`);
   }
  }
 }
 if(names.length>1024)fail('DEPLOY_RECOVERY_REQUIRED');
 const entries=[];let remaining=2*1024*1024;
 for(const name of names) {
  const file=path.join(home,name);let initial;
  try {initial=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT'){entries.push({path:name,type:'absent'});continue;}throw error;}
  // A wire-created parent needs only its identity: no bytes are read.
  if(WIRE_PARENTS.includes(name)) {
   const base={path:name,mode:Number(initial.mode&0o7777n),dev:String(initial.dev),ino:String(initial.ino)};
   if(initial.isSymbolicLink()){const target=fs.readlinkSync(file);if(Buffer.byteLength(target)>4096)fail('DEPLOY_UNTRUSTED_PATH');entries.push({...base,type:'symlink',target});}
   else entries.push({...base,type:initial.isDirectory()?'directory':'special'});
   continue;
  }
  const directory=pinnedDirectory(path.dirname(file));let fd;
  try {
   const anchored=directory.at(path.basename(file));
   const same=value=>['dev','ino','uid','gid','mode','nlink','size','ctimeNs','mtimeNs'].every(key=>initial[key]===value[key]);
   if(initial.uid!==BigInt(process.getuid())||!same(fs.lstatSync(anchored,{bigint:true})))fail('DEPLOY_UNTRUSTED_PATH');
   const base={path:name,mode:Number(initial.mode&0o7777n),dev:String(initial.dev),ino:String(initial.ino)};
   if(initial.isSymbolicLink()) {
    if(initial.nlink!==1n)fail('DEPLOY_UNTRUSTED_PATH');
    const target=fs.readlinkSync(anchored);if(Buffer.byteLength(target)>4096)fail('DEPLOY_UNTRUSTED_PATH');
    entries.push({...base,type:'symlink',target});
   }else if(initial.isFile()) {
    if(initial.nlink!==1n||(initial.mode&0o7022n)!==0n||initial.size>BigInt(remaining))fail('DEPLOY_UNTRUSTED_PATH');
    fd=fs.openSync(anchored,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    if(!same(fs.fstatSync(fd,{bigint:true})))fail('DEPLOY_UNTRUSTED_PATH');
    const bytes=Buffer.alloc(Number(initial.size)+1);let length=0;
    while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
    if(length!==Number(initial.size)||!same(fs.fstatSync(fd,{bigint:true})))fail('DEPLOY_UNTRUSTED_PATH');
    remaining-=length;entries.push({...base,type:'file',bytes:bytes.subarray(0,length).toString('base64')});
   }else {entries.push({...base,type:initial.isDirectory()?'directory':'special'});}
   if(!same(fs.lstatSync(anchored,{bigint:true})))fail('DEPLOY_UNTRUSTED_PATH');directory.verify();
  }finally{if(fd!==undefined)fs.closeSync(fd);directory.close();}
 }
 return {version:1,entries};
}

// Caller has validated both retained releases under deployment/admission leases.
// Only Codex installs individual skill/prompt names; the other adapters retain
// one current/skills directory link and therefore need no name-set equality.
function codexLinkTopology(repositoryRoot, releaseId) {
  const releaseRoot = path.join(repositoryRoot, '.jhw-runtime/releases', releaseId);
  const links = [];
  for (const surface of ['codex', 'claude']) {
    const source = path.join(releaseRoot, 'skills', surface);
    if (!exists(source)) continue;
    const physical = fs.realpathSync(source);
    if (!physical.startsWith(`${releaseRoot}${path.sep}`)) fail('DEPLOY_UNTRUSTED_PATH');
    const directory = pinnedDirectory(physical);
    try {
      for (const name of fs.readdirSync(directory.at('.'))) {
        if (surface === 'codex') {
          if (name.startsWith('jhw-') && fs.statSync(directory.at(name)).isDirectory()) links.push(`skills/${name}`);
        } else if (!name.startsWith('.') && name.endsWith('.md') && name !== 'AGENTS.md') {
          links.push(`prompts/${name}`);
        }
      }
      directory.verify();
    } finally { directory.close(); }
  }
  return links.sort();
}

function requireCompatibleWiringTopology({repositoryRoot, home, previous, command}) {
  if (!exists(path.join(home, '.codex'))) return;
  trustedDirectory(path.join(home, '.codex'));
  let destination = command.releaseId;
  if (command.operation === 'rollback') {
    // readActivation validated this committed manifest and priorCurrent schema.
    // rollbackActivation independently verifies that the actual predecessor
    // matches this recorded release before it performs the pointer transition.
    const manifest = privateRead(path.join(repositoryRoot, '.jhw-runtime/activations', previous.activationId, 'manifest.json'));
    destination = manifest.priorCurrent?.releaseId;
    if (!RELEASE.test(destination ?? '')) fail('DEPLOY_PREDECESSOR_INVALID');
    validateRelease({repositoryRoot, releaseId:destination});
  }
  const installed = codexLinkTopology(repositoryRoot, previous.releaseId);
  const candidate = codexLinkTopology(repositoryRoot, destination);
  if (JSON.stringify(installed) !== JSON.stringify(candidate)) {
    fail('DEPLOY_WIRING_TOPOLOGY_CHANGED', 'guarded_uninstall_reinstall_required');
  }
}

// The exact object this deployment's wire writes at a preimage path, or null.
function wiredLinkTarget(repositoryRoot,name) {
 const runtime=path.join(repositoryRoot,'.jhw-runtime');const skills=path.join(runtime,'current/skills');
 if(name==='.local/bin/jhw-control')return path.join(runtime,'bootstrap/jhw-runtime-control');
 if(name==='.local/bin/jhw-control-hook')return path.join(runtime,'bootstrap/jhw-runtime-hook');
 if(['.claude/commands/jhw','.gemini/commands/jhw','.config/opencode/skills/jhw'].includes(name))return path.join(skills,'claude');
 if(/^\.codex\/skills\/[^/]+$/.test(name))return path.join(skills,'codex',path.basename(name));
 if(/^\.codex\/prompts\/[^/]+$/.test(name))return path.join(skills,'claude',path.basename(name));
 return null;
}
const MCP_REGISTRATION={'.claude.json':'register-stdio','.gemini/settings.json':'register-stdio','.config/opencode/opencode.json':'register-opencode','.codex/config.toml':'register-codex'};
const PREIMAGE_LIMIT=4*1024*1024;const LISTING_LIMIT=16*1024*1024;const FILE_LIMIT=2*1024*1024;
// Every directory a first-activation wire may create an entry in.
const WIRE_DIRECTORIES=['','.local','.local/bin','.claude','.claude/commands','.gemini','.gemini/commands','.config/opencode','.config/opencode/skills','.codex','.codex/commands','.codex/skills','.codex/prompts'];
// Editor backups a wire may create, keyed by the preimage they copy.
const WIRE_BACKUPS=[['.codex/config.toml',/^config\.toml\.bak\.jhw-notion\.\d{14}\.[0-9a-f-]{36}$/],['.codex/hooks.json',/^hooks\.json\.bak\.(?:\d{14}|invalid)\.[0-9a-f-]{36}$/],['.claude/settings.json',/^settings\.json\.bak\.(?:\d{14}|invalid)\.[0-9a-f-]{36}$/]];
function wiringListings(home) {
 const listings={};
 for(const name of WIRE_DIRECTORIES) {
  let fd;
  try {fd=fs.openSync(path.join(home,name),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);}
  catch(error){if(['ENOENT','ENOTDIR'].includes(error.code)){listings[name]=null;continue;}throw error;}
  try {
   const info=fs.fstatSync(fd);const names=fs.readdirSync(`/proc/self/fd/${fd}`).sort();
   if(names.length>4096)fail('DEPLOY_UNTRUSTED_PATH');
   listings[name]={dev:String(info.dev),ino:String(info.ino),names};
  } finally {fs.closeSync(fd);}
 }
 return listings;
}
// Descriptor-anchored, no-follow, bounded view of one entry in a pinned parent.
function anchoredEntry(parent,name,limit=FILE_LIMIT) {
 const at=parent.at(name);let info;
 try {info=fs.lstatSync(at);}catch(error){if(error.code==='ENOENT')return {type:'absent'};throw error;}
 if(info.isSymbolicLink())return {type:'symlink',info,target:fs.readlinkSync(at)};
 if(!info.isFile()||info.nlink!==1||info.size>limit)return {type:info.isDirectory()?'directory':'special',info};
 const fd=fs.openSync(at,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try {
  const opened=fs.fstatSync(fd);if(opened.dev!==info.dev||opened.ino!==info.ino)return {type:'special',info};
  const bytes=Buffer.alloc(limit+1);let length=0;
  while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  if(length>limit)return {type:'special',info};
  return {type:'file',info,bytes:bytes.subarray(0,length)};
 } finally {fs.closeSync(fd);}
}
function matchesPreimage(view,entry) {
 if(entry.type==='absent')return view.type==='absent';
 if(entry.type==='symlink')return view.type==='symlink'&&view.target===entry.target;
 if(entry.type==='file')return view.type==='file'&&(view.info.mode&0o7777)===entry.mode&&view.bytes.equals(Buffer.from(entry.bytes,'base64'));
 return view.type===entry.type&&String(view.info.dev)===entry.dev&&String(view.info.ino)===entry.ino;
}
function sameObject(view,expected) {
 if(view.type!==expected.type||view.info?.dev!==expected.info?.dev||view.info?.ino!==expected.info?.ino)return false;
 if(view.type==='symlink')return view.target===expected.target;
 if(view.type==='file')return view.bytes.equals(expected.bytes);
 return true;
}
// Moves an inspected object aside inside its pinned parent and returns it only
// if the moved object is exactly what was inspected. Anything else is put back
// (never over a reoccupied name) and the restore fails closed.
function quarantine(parent,name,view,limit) {
 const aside=`.jhw-quarantine.${randomBytes(8).toString('hex')}`;
 if(anchoredEntry(parent,aside).type!=='absent')return null;
 fs.renameSync(parent.at(name),parent.at(aside));
 if(sameObject(anchoredEntry(parent,aside,limit),view))return aside;
 if(anchoredEntry(parent,name).type==='absent')fs.renameSync(parent.at(aside),parent.at(name));
 return null;
}
function discard(parent,name,aside,view) {
 try {if(view.type==='directory')fs.rmdirSync(parent.at(aside));else fs.unlinkSync(parent.at(aside));}
 catch(error) {if(anchoredEntry(parent,name).type==='absent')fs.renameSync(parent.at(aside),parent.at(name));throw error;}
}
// Visits one preimage path through its pinned parent; an absent parent means
// the entry is absent.
function withEntry(home,name,visit,limit) {
 const file=path.join(home,name);
 try {if(!fs.lstatSync(path.dirname(file)).isDirectory())return visit(null,{type:'absent'});}
 catch(error){if(error.code==='ENOENT')return visit(null,{type:'absent'});throw error;}
 const parent=pinnedDirectory(path.dirname(file));
 try {return visit(parent,anchoredEntry(parent,path.basename(file),limit));} finally {parent.close();}
}
// Replays the candidate config editor on a private copy of the preimage: the
// bytes its wire would have published (null when it would not have written).
function wiredConfigBytes({repositoryRoot,home,releaseId,scratch,entry,adoptFrom}) {
 const operation=MCP_REGISTRATION[entry.path];if(!operation)return null;
 const copy=path.join(scratch,randomBytes(8).toString('hex'));
 if(entry.type==='file')fs.writeFileSync(copy,Buffer.from(entry.bytes,'base64'),{mode:entry.mode,flag:'wx'});
 const editor=path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'scripts/install-config.mjs');trustedFile(editor);
 const result=spawnSync(process.execPath,[editor,operation,copy,path.join(repositoryRoot,'.jhw-runtime/bootstrap/jhw-runtime-entry'),repositoryRoot,'20000101000000'],{env:adoptEnvironment({HOME:home,PATH:[path.dirname(process.execPath),'/usr/bin','/bin'].join(':')},adoptFrom),stdio:'ignore',timeout:15000});
 return result.status===0&&fs.lstatSync(copy).size<=16*FILE_LIMIT?fs.readFileSync(copy):null;
}
// Bounded first-activation restore after a failed wire. Only an object this
// deployment's wire provably produced is removed or replaced; any other
// difference fails closed. Every preimage path and every directory listing
// wire could write into must then equal its pre-mutation record.
function restoreFirstWiring({repositoryRoot,home,releaseId,directory,adoptFrom}) {
 const {entries}=privateRead(path.join(directory,'before.json'),{limit:PREIMAGE_LIMIT});
 const listings=privateRead(path.join(directory,'listings.json'),{limit:LISTING_LIMIT});
 const scratch=path.join(directory,'restore');if(exists(scratch))trustedDirectory(scratch);else createPrivateDirectory(directory,'restore');
 for(const entry of [...entries].reverse()) {
  const live=withEntry(home,entry.path,(parent,view)=>matchesPreimage(view,entry)?null:view.type);
  if(live===null)continue;
  // A registration may legitimately grow an accepted preimage past FILE_LIMIT
  // (e.g. pretty-printing); the read bound covers exactly that replayed output.
  const link=wiredLinkTarget(repositoryRoot,entry.path);
  const wired=!link&&['file','special'].includes(live)?wiredConfigBytes({repositoryRoot,home,releaseId,scratch,entry,adoptFrom}):null;
  const limit=Math.max(FILE_LIMIT,wired?.length??0);
  const restored=withEntry(home,entry.path,(parent,view)=>{
   if(matchesPreimage(view,entry))return true;
   if(!parent)return false;
   const name=path.basename(entry.path);const at=parent.at(name);
   const ours=link?view.type==='symlink'&&view.target===link:view.type==='file'&&Boolean(wired?.equals(view.bytes));
   const removable=entry.type==='absent'&&(ours||(WIRE_PARENTS.includes(entry.path)&&view.type==='directory'));
   const replaceable=(entry.type==='symlink'||entry.type==='file')&&(ours||(entry.type==='symlink'&&view.type==='absent'));
   if(!removable&&!replaceable)return false;
   // Destructive steps act only on the quarantined, re-verified object; new
   // content is placed with no-clobber link/symlink semantics.
   const aside=view.type==='absent'?null:quarantine(parent,name,view,limit);
   if(view.type!=='absent'&&!aside)return false;
   try {
    if(entry.type==='symlink')fs.symlinkSync(entry.target,at);
    else if(entry.type==='file') {
     const temporary=parent.at(`.jhw-restore.${randomBytes(8).toString('hex')}`);
     const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
     try{fs.writeFileSync(fd,Buffer.from(entry.bytes,'base64'));fs.fchmodSync(fd,entry.mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
     try{fs.linkSync(temporary,at);}finally{fs.unlinkSync(temporary);}
    }
   } catch(error) {
    if(aside&&anchoredEntry(parent,name).type==='absent')fs.renameSync(parent.at(aside),at);
    throw error;
   }
   if(aside)discard(parent,name,aside,view);
   fs.fsyncSync(parent.fd);parent.verify();return true;
  },limit);
  if(!restored)return false;
 }
 for(const [config,pattern] of WIRE_BACKUPS) {
  const preimage=entries.find(entry=>entry.path===config);const before=listings[path.dirname(config)];
  if(preimage?.type!=='file'||!before)continue;
  const parent=pinnedDirectory(path.join(home,path.dirname(config)));
  try {
   for(const name of fs.readdirSync(parent.at('.')).filter(name=>pattern.test(name)&&!before.names.includes(name))) {
    const view=anchoredEntry(parent,name);
    if(view.type!=='file'||view.info.uid!==process.getuid()||!view.bytes.equals(Buffer.from(preimage.bytes,'base64')))continue;
    const aside=quarantine(parent,name,view);if(!aside)return false;
    discard(parent,name,aside,view);
   }
   fs.fsyncSync(parent.fd);parent.verify();
  } finally {parent.close();}
 }
 return entries.every(entry=>withEntry(home,entry.path,(parent,view)=>matchesPreimage(view,entry)))&&
  JSON.stringify(wiringListings(home))===JSON.stringify(listings);
}

function existingInstallation(repositoryRoot,home) {
 return exists(path.join(repositoryRoot,'.jhw-runtime')) || ['.local/bin/jhw-control','.local/bin/jhw-control-hook','.claude.json','.gemini/settings.json','.codex/config.toml','.config/opencode/opencode.json'].some(p=>exists(path.join(home,p)));
}
function prepareStore(repositoryRoot) {
 trustedDirectory(repositoryRoot);const runtime=path.join(repositoryRoot,'.jhw-runtime');
 if(!exists(runtime))createPrivateDirectory(repositoryRoot,'.jhw-runtime');
 if((trustedDirectory(runtime).mode&0o7777)!==0o700)fail('DEPLOY_UNTRUSTED_PATH');return runtime;
}
function pending(runtime) {
 if(!exists(runtime))return [];
 if((trustedDirectory(runtime).mode&0o7777)!==0o700)fail('DEPLOY_UNTRUSTED_PATH');
 const names=fs.readdirSync(runtime);if(names.length>4096)fail('DEPLOY_RECOVERY_REQUIRED');
 return names.filter(name=>/^\.deploy\.[a-f0-9]{32}$/.test(name)).filter(name=>privateRead(path.join(runtime,name,'state.json')).status!=='complete');
}
function checkpoint(directory,state) {privateWrite(path.join(directory,'state.json'),state);}
function pairOf(snapshot){return snapshot&&snapshot.version===2?{releaseId:snapshot.releaseId,bootstrapId:snapshot.bootstrapId,runtimeContract:snapshot.runtimeContract,compatibilityDigest:snapshot.compatibilityDigest}:null;}
function pairDestination(snapshot){if(!snapshot)return null;const {observation:_,...destination}=snapshot;return destination;}
function sameJson(left,right){return JSON.stringify(left)===JSON.stringify(right);}
// A new process receives real lease descriptors for each mutation phase. No
// persistent process retains exclusive admission during runtime validation.
const WORKER = `set -euo pipefail
umask 077
SCRIPT_DIR="$1"
# A library that predates env-drop reporting never initializes ENV_DROPPED.
unset ENV_DROPPED
source "$2"
JHW_ENV_DROP_REPORTED="\${ENV_DROPPED+1}"
CONFIG_EDITOR="$5"
initialize_wiring_directories
if [[ "$4" = managed ]]; then select_managed_wiring; fi
if [[ -n "\${6:-}" ]]; then SKILL_SOURCE_ROOT="$6"; fi
keys=(${KEYS.join(' ')})
for key in "\${keys[@]}"; do
  IFS= read -r -d '' value || exit 65
  if [[ "$value" != __JHW_UNSET__ ]]; then printf -v "$key" '%s' "$value"; fi
  # A retained older library may predate this key; never let set -u abort on it.
  if [[ -z "\${!key+x}" ]]; then printf -v "$key" '%s' ''; fi
done
ENV_DROPPED_REPORTED="$JHW_ENV_DROP_REPORTED"
guard_action="\${7:-}"
if [[ -n "\${9:-}" ]]; then
  declare -F load_guard_policy_transaction_context >/dev/null || exit 64
  load_guard_policy_transaction_context "$8" "$9" "\${10}" "\${11}" || exit 65
fi
save_phase_state() {
  local rc=$?
  trap - EXIT
  if [[ "$guard_action" = begin && "$rc" -ne 0 ]]; then rollback_install_transaction || :; fi
  for key in "\${keys[@]}"; do printf '%s\\0' "\${!key-}" >&5; done
  if [[ -n "$guard_action" ]]; then
    node -e 'const [file,directory,transition,stage]=process.argv.slice(1);process.stdout.write(JSON.stringify(directory?{version:1,file,directory,transition,stage}:null)+"\\n");' \
      "\${GUARD_POLICY_FILE:-}" "\${GUARD_POLICY_TRANSACTION_DIR:-}" "\${GUARD_POLICY_TRANSITION:-}" "\${GUARD_POLICY_TRANSACTION_STAGE:-}" >&6 || :
  fi
  exit "$rc"
}
trap save_phase_state EXIT
case "$3" in
  verify) verify_wiring ;;
  wire) if [[ "$guard_action" = begin ]]; then begin_guard_observe_transition absent; else install_wiring; fi ;;
  validate) require_control_host; run_guard_preflight ;;
  finalize) finalize_wiring ;;
  rollback) if [[ "$guard_action" = rollback ]]; then rollback_install_transaction; else rollback_first_wiring_complete; fi ;;
  uninstall) uninstall_wiring ;;
  *) exit 64 ;;
esac
`;
// Read-only first-activation plan: runs the candidate release's library before
// any journal, bootstrap, pointer, or HOME mutation, so it has no journal log.
const PLAN_WORKER = `set -euo pipefail
SCRIPT_DIR="$1"
source "$2"
CONFIG_EDITOR="$3"
initialize_wiring_directories
select_managed_wiring
if [[ -n "\${5:-}" ]]; then
  declare -F plan_guard_observe_transition >/dev/null || exit 64
  plan_guard_observe_transition "$5"
  printf 'clear\\n'
else plan_wiring "$4"; fi
`;
const PLAN_CONFLICTS = ['adopt_env_unpreservable','control_host','tui_root','pending_transaction','unsafe_parent','parent_unusable','control_link','hook_link','command_dir','skill_link','prompt_link','mcp_entry','hook_config'];
async function planWiring({repositoryRoot,home,environment,releaseId,planTimeoutMs,adoptFrom,guardPolicy}) {
 const release=path.join(repositoryRoot,'.jhw-runtime/releases',releaseId);
 const library=path.join(release,'scripts/install-wiring.sh');const editor=path.join(release,'scripts/install-config.mjs');trustedFile(library);trustedFile(editor);
 const env={...environment,HOME:home,PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':')};
 for(const key of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV','SHELLOPTS','BASHOPTS'])delete env[key];
 adoptEnvironment(env,adoptFrom);
 // Own process group: the plan is read-only, so any straggler is killed outright.
 const child=spawn('/bin/bash',['-c',PLAN_WORKER,'jhw-wiring-plan',repositoryRoot,library,editor,path.join(release,'skills'),guardPolicy??''],{cwd:release,env,stdio:['ignore','pipe','ignore'],detached:true});
 const killGroup=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
 let output='';let overflow=false;let timer;
 child.stdout.on('data',chunk=>{if(output.length+chunk.length<=4096)output+=chunk.toString('utf8');else overflow=true;});
 const code=await new Promise(resolve=>{
  timer=setTimeout(()=>{killGroup();resolve(null);},planTimeoutMs);
  child.once('error',()=>resolve(null));
  child.once('close',(code,signal)=>resolve(signal?null:code));
 });
 clearTimeout(timer);
 if(code===0&&!overflow&&output==='clear\n')return;
 const conflict=/^conflict ([a-z_]+)\n$/.exec(output);
 fail('DEPLOY_WIRING_CONFLICT',code===3&&!overflow&&PLAN_CONFLICTS.includes(conflict?.[1])?conflict[1]:'plan_unverified');
}

export async function wiringPhase({repositoryRoot,home,environment,phase,managed,deployLease,admissionLease,directory,state,phaseTimeoutMs,candidateReleaseId,adoptFrom,guardTransition}) {
 // Before pointer publication a first activation names its validated candidate.
 const selected=candidateReleaseId?{releaseId:candidateReleaseId}:managed?readActivation({repositoryRoot}):null;
 const scripts=selected?path.join(repositoryRoot,'.jhw-runtime/releases',selected.releaseId,'scripts'):path.join(repositoryRoot,'scripts');
 const library=path.join(scripts,'install-wiring.sh');const editor=path.join(scripts,'install-config.mjs');trustedFile(library);trustedFile(editor);
 const log=path.join(directory,`${phase}.${randomBytes(8).toString('hex')}.log`);
 const logDirectory=pinnedDirectory(directory);
 const logFd=fs.openSync(logDirectory.at(path.basename(log)),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.fchmodSync(logFd,0o600);
 let total=0;let output=Buffer.alloc(0);let policyOutput=Buffer.alloc(0);let overflow=false;let logging=true;let phaseTimer;
 try {
  const env={...environment,HOME:home,PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':')};
  // Never pass Node loader or shell startup injection into maintenance workers.
  for(const key of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV','SHELLOPTS','BASHOPTS'])delete env[key];
  adoptEnvironment(env,adoptFrom);
  logDirectory.verify();
  const skillSource=candidateReleaseId?path.join(repositoryRoot,'.jhw-runtime/releases',candidateReleaseId,'skills'):'';
  const context=guardTransition?.context;
  const child=spawn('/bin/bash',['-c',WORKER,'jhw-wiring-phase',repositoryRoot,library,phase,managed?'managed':'legacy',editor,skillSource,guardTransition?.action??'',context?.file??'',context?.directory??'',context?.transition??'',context?.stage??''],{cwd:directory,env,stdio:['pipe','pipe','pipe',deployLease.fd,admissionLease?.fd??'ignore','pipe','pipe']});
  const capture=chunk=>{total+=chunk.length;if(logging&&total<=256*1024)fs.writeSync(logFd,chunk);else overflow=true;};child.stdout.on('data',capture);child.stderr.on('data',capture);
  child.stdio[5].on('data',chunk=>{if(output.length+chunk.length<=256*1024)output=Buffer.concat([output,chunk]);else overflow=true;});
  child.stdio[6].on('data',chunk=>{if(policyOutput.length+chunk.length<=16*1024)policyOutput=Buffer.concat([policyOutput,chunk]);else overflow=true;});
  child.stdin.on('error',()=>{});child.stdin.end(KEYS.map(key=>(state.variables?.[key]??'__JHW_UNSET__')+'\0').join(''));
  const code=await Promise.race([new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve(signal?null:code));}),new Promise(resolve=>{phaseTimer=setTimeout(()=>{state.workerDetached=true;child.unref();for(const stream of [child.stdin,child.stdout,child.stderr,child.stdio[5],child.stdio[6]])stream.unref?.();resolve(null);},phaseTimeoutMs);})]);
  clearTimeout(phaseTimer);
  const values=output.toString('utf8').split('\0');
  if(values.length===KEYS.length+1&&values.at(-1)===''&&!overflow)state.variables=Object.fromEntries(KEYS.map((key,index)=>[key,values[index]]));
  else state.stateIncomplete=true;
  checkpoint(directory,state);
  if(code!==0||overflow||state.stateIncomplete)fail(phase==='validate'?'DEPLOY_VALIDATION_FAILED':'DEPLOY_WIRING_FAILED');
  if(phase==='validate')await mcpProbe({repositoryRoot,home,environment,deployLease,directory,logFd});
  if(guardTransition) {
   let guardPolicyContext;try{guardPolicyContext=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(policyOutput));}catch{fail('DEPLOY_RECOVERY_REQUIRED','guard_context_unverified');}
   return {guardPolicyContext};
  }
 } finally {logging=false;clearTimeout(phaseTimer);fs.fsyncSync(logFd);fs.closeSync(logFd);try{logDirectory.verify();}finally{logDirectory.close();}}
}

async function mcpProbe({repositoryRoot,home,environment,deployLease,directory,logFd,releaseId=null}) {
 const env={...environment,HOME:home,PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':')};
 for(const key of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV'])delete env[key];
 adoptEnvironment(env);
 const argv=releaseId===null?[path.join(repositoryRoot,'.jhw-runtime/bootstrap/jhw-runtime-entry'),'mcp']:
  ['-e',"Object.defineProperty(globalThis,'__JHW_MANAGED_RELEASE_ROOT__',{value:process.argv[1]});require(process.argv[2]);",
   path.join(repositoryRoot,'.jhw-runtime/releases',releaseId),path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'mcp-server/dist/runtime/mcp.cjs')];
 const child=spawn(process.execPath,argv,{cwd:directory,env,stdio:['pipe','pipe','pipe',deployLease.fd]});
 let input='';let bytes=0;let stderrBytes=0;let stage=0;let failure=false;let logging=true;let initialization;let advertisedTools;let nextCursor;
 child.stdin.on('error',()=>{failure=true;});
 const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
 send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'jhw-deployment-validation',version:'1'}}});
 child.stdout.on('data',chunk=>{
  bytes+=chunk.length;if(bytes>128*1024){failure=true;child.stdin.end();return;}
  input+=chunk.toString('utf8');let newline;
  while((newline=input.indexOf('\n'))>=0){const line=input.slice(0,newline);input=input.slice(newline+1);try{
   const response=JSON.parse(line);
   if(response.jsonrpc!=='2.0'||response.error)throw new Error();
   if(stage===0&&response.id===1&&typeof response.result?.protocolVersion==='string'&&response.result?.serverInfo&&response.result?.capabilities){initialization=response.result;stage=1;send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});}
   else if(stage===1&&response.id===2&&Array.isArray(response.result?.tools)){advertisedTools=response.result.tools;nextCursor=response.result.nextCursor;stage=2;child.stdin.end();}
   else throw new Error();
  }catch{failure=true;child.stdin.end();}}
 });
 child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(logging&&stderrBytes<=128*1024)fs.writeSync(logFd,chunk);failure=true;});
 // Close only our validation input on timeout. A child that refuses normal EOF
 // retains its shared lease and blocks recovery; no process is signaled.
 let timer;
 const result=await Promise.race([new Promise(resolve=>{child.once('error',()=>resolve(null));child.once('close',(code,signal)=>resolve(signal?null:code));}),new Promise(resolve=>{timer=setTimeout(()=>{failure=true;child.stdin.end();child.unref();child.stdout.unref();child.stderr.unref();resolve(null);},12000);})]);
 logging=false;clearTimeout(timer);
 if(result!==0||failure||stage!==2||input.trim())fail('DEPLOY_VALIDATION_FAILED');
 return {protocolVersion:initialization.protocolVersion,capabilities:initialization.capabilities,tools:advertisedTools,nextCursor};
}


function compatibleInventory({repositoryRoot,procRoot,fingerprint}) {
  const sessions=inspectSessionBindings({repositoryRoot});
  if(sessions.some(item=>item.compatibilityDigest!==fingerprint))
    fail('DEPLOY_COMPATIBILITY_MISMATCH','live_session_contract');
  if(sessions.some(item=>item.kind==='invocation'&&item.parentBinding===null))
    fail('DEPLOY_CONSUMERS_ACTIVE','unbound_invocation');
  const inventory=inspectSessionConsumers({repositoryRoot,procRoot,excludePids:[process.pid]},observation=>{
    // Direct legacy execution and proxy connections lack the managed session contract.
    if(observation.category==='legacy'||(observation.category==='app_server'&&observation.args.includes('proxy'))) return false;
    const selectedToken=observation.token??sessions.find(item=>
      item.kind==='session'&&item.owner.pid===observation.pid&&item.owner.startTime===observation.startTime)?.token;
    if(selectedToken===undefined) return false;
    const record=resolveSessionBinding({repositoryRoot,token:selectedToken,pid:observation.pid});
    return record.compatibilityDigest===fingerprint;
  });
  if(inventory.uncertain) throw Object.assign(new DeploymentError('DEPLOY_INVENTORY_UNCERTAIN'),{inventory});
  if(!inventory.clear) throw Object.assign(new DeploymentError('DEPLOY_CONSUMERS_ACTIVE'),{inventory});
  return inventory;
}
function requireBootstrapGeneration({repositoryRoot,releaseId}) {
  const bootstrap=validateBootstrap({repositoryRoot});
  const manifest=privateRead(path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'manifest.json'),{limit:32*1024*1024});
  for(const helper of bootstrap.files) {
    const entry=manifest.entries.find(item=>item.path==='scripts/'+helper.name);
    if(entry?.type!=='file'||entry.sha256!==helper.sha256||entry.mode!==helper.mode)
      fail('DEPLOY_COMPATIBILITY_MISMATCH','bootstrap_refresh_required');
  }
}
// Validate the typed Tool surface without importing mutable SDK files at runtime.
function validMcpTool(tool) {
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const string=value=>typeof value==='string';
  const boolean=value=>typeof value==='boolean';
  const strings=value=>Array.isArray(value)&&value.every(string);
  const optional=(value,key,check)=>!Object.hasOwn(value,key)||check(value[key]);
  const schema=value=>object(value)&&value.type==='object'&&
    optional(value,'properties',properties=>object(properties)&&Object.values(properties).every(object))&&
    optional(value,'required',strings);
  const icon=value=>object(value)&&string(value.src)&&
    optional(value,'mimeType',string)&&optional(value,'sizes',strings)&&
    optional(value,'theme',theme=>['light','dark'].includes(theme));
  const annotations=value=>object(value)&&optional(value,'title',string)&&
    ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'].every(key=>optional(value,key,boolean));
  const execution=value=>object(value)&&
    optional(value,'taskSupport',support=>['required','optional','forbidden'].includes(support));
  return object(tool)&&string(tool.name)&&tool.name.length>0&&tool.name.length<=256&&
    optional(tool,'title',string)&&optional(tool,'description',string)&&
    optional(tool,'icons',icons=>Array.isArray(icons)&&icons.every(icon))&&
    schema(tool.inputSchema)&&optional(tool,'outputSchema',schema)&&
    optional(tool,'annotations',annotations)&&optional(tool,'execution',execution)&&
    optional(tool,'_meta',object);
}
function mcpContract(value) {
  if(value.nextCursor!==undefined) fail('DEPLOY_VALIDATION_FAILED','incomplete_tools_list');
  const normalize=value=>Array.isArray(value)?value.map(normalize):value!==null&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
  const tools=new Map();
  for(const tool of value.tools) {
    if(!validMcpTool(tool)||tools.has(tool.name)) fail('DEPLOY_VALIDATION_FAILED');
    const contract=Object.fromEntries(Object.entries(tool).filter(([key])=>!['name','title','description','icons'].includes(key)));
    tools.set(tool.name,JSON.stringify(normalize(contract)));
  }
  return {protocol:value.protocolVersion,capabilities:JSON.stringify(normalize(value.capabilities)),tools};
}
async function comparePairMcpContracts({repositoryRoot,home,environment,deployLease,directory,logFd,
  origin,candidate,observe,onProbed}) {
  const inspect=async (name,pair)=>{
    const contract=mcpContract(await mcpProbe({repositoryRoot,home,environment,deployLease,directory,logFd,
      releaseId:pair.releaseId}));
    onProbed?.(name);return contract;
  };
  observe?.({phase:'candidate_probe_start',exclusive:false});
  const currentContract=await inspect('current',pairOf(origin));
  const candidateContract=await inspect('candidate',candidate);
  observe?.({phase:'candidate_probe_complete',exclusive:false});
  return currentContract.protocol===candidateContract.protocol&&currentContract.capabilities===candidateContract.capabilities&&
    [...currentContract.tools].every(([name,contract])=>candidateContract.tools.get(name)===contract);
}

function pairJournalRoot(repositoryRoot) {
  const runtime=path.join(repositoryRoot,'.jhw-runtime');
  const v2=path.join(runtime,'v2');
  trustedDirectory(v2);
  const journals=path.join(v2,'journals');
  if(!exists(journals))createPrivateDirectory(v2,'journals');
  if((trustedDirectory(journals).mode&0o7777)!==0o700)fail('DEPLOY_UNTRUSTED_PATH');
  return journals;
}
function createPairJournalCandidate(repositoryRoot,state) {
  const journals=pairJournalRoot(repositoryRoot);
  const suffix=randomBytes(16).toString('hex');const staging=createPrivateDirectory(journals,`.candidate.${suffix}`);
  checkpoint(staging,state);return {journals,staging,name:`d-${suffix}`};
}
function publishPairJournal(candidate,capability=null) {
  const parent=pinnedDirectory(candidate.journals);
  try{parent.verify();if(capability)atomicRename({capability,sourceDirectory:parent,destinationDirectory:parent,sourceName:path.basename(candidate.staging),destinationName:candidate.name,operation:'noreplace'});else fs.renameSync(parent.at(path.basename(candidate.staging)),parent.at(candidate.name));fs.fsyncSync(parent.fd);parent.verify();return path.join(candidate.journals,candidate.name);}
  finally{parent.close();}
}
function createPairValidationDirectory(repositoryRoot) {
  return createPrivateDirectory(path.join(repositoryRoot,'.jhw-runtime/v2'),`.pair-validation.${randomBytes(16).toString('hex')}`);
}
function removePairValidationDirectory(directory) {
  if(!directory||!exists(directory))return;
  const child=pinnedDirectory(directory);const parent=pinnedDirectory(path.dirname(directory));
  try{
    const names=fs.readdirSync(`/proc/self/fd/${child.fd}`);
    if(names.some(name=>name!=='state.json'&&!/^verify\.[a-f0-9]{16}\.log$/.test(name)))fail('DEPLOY_RECOVERY_REQUIRED','validation_evidence_unverified');
    for(const name of names){const info=fs.lstatSync(child.at(name));if(!info.isFile()||info.uid!==process.getuid()||info.nlink!==1)fail('DEPLOY_RECOVERY_REQUIRED','validation_evidence_unverified');fs.unlinkSync(child.at(name));}
    fs.fsyncSync(child.fd);child.verify();fs.rmdirSync(parent.at(path.basename(directory)));fs.fsyncSync(parent.fd);parent.verify();
  }finally{child.close();parent.close();}
}
function pairRows(repositoryRoot) {
  if(inspectSessionBindings({repositoryRoot}).length)fail('DEPLOY_COMPATIBILITY_MISMATCH','v1_session');
  const rows=inspectSessionBindingsV2({repositoryRoot});
  if(rows.some(row=>row.kind==='invocation'&&row.parentBinding===null))fail('DEPLOY_CONSUMERS_ACTIVE','unbound_invocation');
  const roots=rows.filter(row=>row.kind==='session'&&row.live).map(({live,...row})=>row).sort((a,b)=>a.id.localeCompare(b.id));
  return {rows,roots};
}
function pairConsumerVerifier({repositoryRoot,roots,prepared}) {
  return observation=>{
    if(observation.category==='legacy'||(observation.category==='app_server'&&observation.args.includes('proxy')))return false;
    const token=observation.token??roots.find(row=>row.owner.pid===observation.pid&&row.owner.startTime===observation.startTime)?.token;
    if(token===undefined)return false;
    try{return prepared===null?(resolveSessionBindingV2({repositoryRoot,token,pid:observation.pid}),true):
      verifyPairPublicationConsumer({prepared,observation:{...observation,token}});}catch{return false;}
  };
}
function pairProcessInventory({repositoryRoot,procRoot,roots,prepared=null}) {
  const inventory=inspectSessionConsumers({repositoryRoot,procRoot,excludePids:[process.pid]},
    pairConsumerVerifier({repositoryRoot,roots,prepared}));
  if(inventory.uncertain)throw Object.assign(new DeploymentError('DEPLOY_INVENTORY_UNCERTAIN'),{inventory});
  if(!inventory.clear)throw Object.assign(new DeploymentError('DEPLOY_CONSUMERS_ACTIVE'),{inventory});
  return inventory;
}
function observePairProcesses({repositoryRoot,procRoot,roots,prepared,stage}) {
  return observeSessionConsumers({repositoryRoot,procRoot,excludePids:[process.pid]},
    pairConsumerVerifier({repositoryRoot,roots,prepared}),stage);
}
function completePairInventory({repositoryRoot,procRoot}, {rows,roots}=pairRows(repositoryRoot)) {
  return {rows,roots,processes:pairProcessInventory({repositoryRoot,procRoot,roots})};
}
function completeRetainedPruneInventory({repositoryRoot,procRoot,managedScope=null},snapshot,expected,retainedEvidence) {
  requirePreparedRootMembership(expected,snapshot.roots);
  const revalidate=()=>{
    try{return requirePreparedRootMembership(expected,
      revalidateRetainedPruneEvidence({repositoryRoot,retainedEvidence}));}
    catch(error){classifyRootRevalidationError({repositoryRoot,expected,error});}
  };
  let roots=revalidate();
  const processes=deploymentProcessInventory({repositoryRoot,procRoot,roots,prepared:retainedEvidence.prepared,managedScope});
  roots=revalidate();
  return {rows:snapshot.rows,roots,processes};
}
function supportsPreparedPruneInventory(current,{rows,roots}) {
  if(current?.version!==2||roots.length===0)return false;
  // Private transitional records are validated but omitted by pairRows. A
  // non-live session row here is therefore an inactive public record.
  return !rows.some(row=>row.kind==='session'&&!row.live);
}
function preparePruneReleaseEvidence(repositoryRoot,current,roots) {
  const pairs=[current,...roots].map(pairOf).filter(Boolean);
  const unique=new Map(pairs.map(pair=>[JSON.stringify(pair),pair]));
  return prepareRuntimeEvidence({repositoryRoot,pairs:[...unique.values()]});
}
/** Module-only read-only diagnostic. It evaluates the advisory plan and a
 * baseline generation-only inventory, then returns before acquiring deployment
 * locks or applying any prune mutation. */
export function observeLivePruneInventory({repositoryRoot,procRoot='/proc'}={}) {
  const planStarted=process.hrtime.bigint();
  const plan=planRuntimePrune({repositoryRoot});
  const planElapsedMs=Number(process.hrtime.bigint()-planStarted)/1e6;
  const route=pruneExecutionRoute(plan);
  const boundedPlan={
    bootstrapGenerations:plan.candidates.bootstrapGenerations?.length??0,
    previous:plan.candidates.previous.length,
    legacyJournals:plan.candidates.journals.filter(name=>name.startsWith('.deploy.')).length,
    v2Journals:plan.candidates.journals.filter(name=>name.startsWith('d-')).length,
  };
  if(!route.livePath)return {code:'DEPLOY_PRUNE_INVENTORY_OBSERVED',route,plan:boundedPlan,
    elapsedMs:{plan:planElapsedMs,roots:null,scan:null},rootCount:null,inventory:null,observation:null};
  const rootsStarted=process.hrtime.bigint();
  const {roots}=pairRows(repositoryRoot);
  const rootsElapsedMs=Number(process.hrtime.bigint()-rootsStarted)/1e6;
  const scanStarted=process.hrtime.bigint();
  const result=observePairProcesses({repositoryRoot,procRoot,roots,prepared:null,stage:'preliminary'});
  const scanFinished=process.hrtime.bigint();
  return {code:'DEPLOY_PRUNE_INVENTORY_OBSERVED',route,plan:boundedPlan,
    elapsedMs:{plan:planElapsedMs,roots:rootsElapsedMs,scan:result.observation.elapsedMs},
    scanWindow:{startedNs:String(scanStarted),finishedNs:String(scanFinished)},
    rootCount:roots.length,inventory:result.inventory,observation:result.observation};
}
/** Module-only read-only comparison of the two process scans used around prune
 * locking. The publication stage is modeled without acquiring deployment locks
 * or applying a prune mutation. */
export function observePruneScanPair({repositoryRoot,procRoot='/proc',method}={}) {
  if(!['baseline','prepared'].includes(method))throw new TypeError('unsupported prune scan method');
  const totalStarted=process.hrtime.bigint();
  const planStarted=process.hrtime.bigint();
  const plan=planRuntimePrune({repositoryRoot});
  const planElapsedMs=Number(process.hrtime.bigint()-planStarted)/1e6;
  const boundedPlan={
    bootstrapGenerations:plan.candidates.bootstrapGenerations?.length??0,
    previous:plan.candidates.previous.length,
    legacyJournals:plan.candidates.journals.filter(name=>name.startsWith('.deploy.')).length,
    v2Journals:plan.candidates.journals.filter(name=>name.startsWith('d-')).length,
  };
  if(boundedPlan.bootstrapGenerations!==1||boundedPlan.previous!==0||
      boundedPlan.legacyJournals!==0||boundedPlan.v2Journals!==0){
    fail('DEPLOY_PRUNE_BLOCKED','diagnostic_plan_changed');
  }
  const initialRootsStarted=process.hrtime.bigint();
  const snapshot=pairRows(repositoryRoot);
  const initialRootsElapsedMs=Number(process.hrtime.bigint()-initialRootsStarted)/1e6;
  const rootCount=snapshot.roots.length;
  if(rootCount===0)fail('DEPLOY_PRUNE_BLOCKED','diagnostic_roots_missing');
  let evidence;let prepared;let prepareElapsedMs=0;let scans;
  const revalidatePreparedRoots=()=>{
    try{return requirePreparedRootMembership(snapshot.roots,
      revalidatePairPublicationEvidence({repositoryRoot,prepared}));}
    catch(error){classifyRootRevalidationError({repositoryRoot,expected:snapshot.roots,error});}
  };
  const runScan=stage=>{
    const scanTotalStarted=process.hrtime.bigint();
    const rootsStarted=process.hrtime.bigint();
    const fresh=pairRows(repositoryRoot);
    if(method==='prepared')requirePreparedRootMembership(snapshot.roots,fresh.roots);
    const rootsElapsedMs=Number(process.hrtime.bigint()-rootsStarted)/1e6;
    let filesBeforeMs=0;let rootsBeforeMs=0;let filesAfterMs=0;let rootsAfterMs=0;
    let roots=fresh.roots;
    if(method==='prepared'){
      const filesStarted=process.hrtime.bigint();
      revalidateRuntimeEvidence(evidence);
      filesBeforeMs=Number(process.hrtime.bigint()-filesStarted)/1e6;
      const proofStarted=process.hrtime.bigint();
      roots=revalidatePreparedRoots();
      rootsBeforeMs=Number(process.hrtime.bigint()-proofStarted)/1e6;
    }
    const scanStarted=process.hrtime.bigint();
    const result=observePairProcesses({repositoryRoot,procRoot,roots,
      prepared:method==='prepared'?prepared:null,stage});
    const scanFinished=process.hrtime.bigint();
    if(method==='prepared'){
      const filesStarted=process.hrtime.bigint();
      revalidateRuntimeEvidence(evidence);
      filesAfterMs=Number(process.hrtime.bigint()-filesStarted)/1e6;
      const proofStarted=process.hrtime.bigint();
      revalidatePreparedRoots();
      rootsAfterMs=Number(process.hrtime.bigint()-proofStarted)/1e6;
    }
    return {inventory:result.inventory,observation:result.observation,
      scanWindow:{startedNs:String(scanStarted),finishedNs:String(scanFinished)},
      elapsedMs:{roots:rootsElapsedMs,filesBefore:filesBeforeMs,rootsBefore:rootsBeforeMs,
        scan:result.observation.elapsedMs,filesAfter:filesAfterMs,rootsAfter:rootsAfterMs,
        total:Number(process.hrtime.bigint()-scanTotalStarted)/1e6}};
  };
  try{
    if(method==='prepared'){
      const prepareStarted=process.hrtime.bigint();
      const current=readActivation({repositoryRoot});
      if(current?.version!==2)fail('DEPLOY_COMPATIBILITY_MISMATCH','v2_current_required');
      evidence=preparePruneReleaseEvidence(repositoryRoot,current,snapshot.roots);
      prepared=preparePairPublicationEvidence({repositoryRoot,evidence,current,roots:snapshot.roots});
      prepareElapsedMs=Number(process.hrtime.bigint()-prepareStarted)/1e6;
    }
    scans=[runScan('preliminary'),runScan('publication')];
  }finally{evidence?.close();}
  return {method,rootCount,plan:boundedPlan,
    elapsedMs:{plan:planElapsedMs,initialRoots:initialRootsElapsedMs,prepare:prepareElapsedMs,
      total:Number(process.hrtime.bigint()-totalStarted)/1e6},
    scans};
}
function rootMembershipChanged(expected,actual) {
  return !Array.isArray(actual)||!sameJson(expected.map(row=>row.id),actual.map(row=>row.id))||
    !expected.every((row,index)=>sameJson(row,actual[index]));
}
function requirePreparedRootMembership(expected,actual) {
  if(rootMembershipChanged(expected,actual))fail('DEPLOY_CONSUMERS_ACTIVE','root_membership_changed');
  return actual;
}
function classifyRootRevalidationError({repositoryRoot,expected,error}) {
  if(error.code==='DEPLOY_CURRENT_CHANGED')throw error;
  let actual;
  try{actual=pairRows(repositoryRoot).roots;}catch{throw error;}
  if(rootMembershipChanged(expected,actual))fail('DEPLOY_CONSUMERS_ACTIVE','root_membership_changed');
  throw error;
}
function deploymentProcessInventory({repositoryRoot,procRoot,roots,prepared,managedScope}) {
  if(managedScope===null)return pairProcessInventory({repositoryRoot,procRoot,roots,prepared});
  requireManagedScope(managedScope,repositoryRoot);
  return {boundary:'dedicated-service',sessionRoots:roots.length,invocationRecords:managedScope.hasInvocationRecords()};
}
function completePreparedPairInventory({repositoryRoot,procRoot,current,evidence,snapshot=pairRows(repositoryRoot),managedScope=null}) {
  const prepared=preparePairPublicationEvidence({repositoryRoot,evidence,current,roots:snapshot.roots});
  let roots;
  try{roots=requirePreparedRootMembership(snapshot.roots,revalidatePairPublicationEvidence({repositoryRoot,prepared}));}
  catch(error){if(error.code==='DEPLOY_CURRENT_CHANGED')throw error;fail('DEPLOY_CONSUMERS_ACTIVE','root_membership_changed');}
  const processes=deploymentProcessInventory({repositoryRoot,procRoot,roots,prepared,managedScope});
  try{roots=requirePreparedRootMembership(snapshot.roots,revalidatePairPublicationEvidence({repositoryRoot,prepared}));}
  catch(error){if(error.code==='DEPLOY_CURRENT_CHANGED')throw error;fail('DEPLOY_CONSUMERS_ACTIVE','root_membership_changed');}
  return {rows:snapshot.rows,roots,processes,prepared};
}
function observePreparedPairInventory({repositoryRoot,procRoot,current,evidence,snapshot,stage}) {
  let prepared;let roots;
  try{prepared=preparePairPublicationEvidence({repositoryRoot,evidence,current,roots:snapshot.roots});}
  catch(error){classifyRootRevalidationError({repositoryRoot,expected:snapshot.roots,error});}
  try{roots=requirePreparedRootMembership(snapshot.roots,
    revalidatePairPublicationEvidence({repositoryRoot,prepared}));}
  catch(error){classifyRootRevalidationError({repositoryRoot,expected:snapshot.roots,error});}
  const result=observePairProcesses({repositoryRoot,procRoot,roots,prepared,stage});
  try{requirePreparedRootMembership(snapshot.roots,revalidatePairPublicationEvidence({repositoryRoot,prepared}));}
  catch(error){classifyRootRevalidationError({repositoryRoot,expected:snapshot.roots,error});}
  return {...result,prepared,roots};
}
/** Module-only diagnostic surface. It follows candidate validation and both MCP
 * probes from compatible deployment, then structurally returns before activation
 * preparation, journal publication, pointer intent, or rename. */
export async function observeCompatiblePairDeployment({repositoryRoot,home,procRoot,environment,
  releaseId,rollback=false,phaseRunner=wiringPhase,phaseTimeoutMs=45000,observe}) {
  const runtime=path.join(repositoryRoot,'.jhw-runtime');
  const stages=[];const probes={current:false,candidate:false};
  let writer;let publication;let evidence;let validationDirectory;let logFd;
  const emit=(phase,stage,exclusive)=>observe?.({phase,stage,exclusive});
  const runStage=(stage,exclusive,operation)=>{
    const started=performance.now();
    emit('inventory_start',stage,exclusive);
    try {
      const result=operation(stage);
      result.observation={...result.observation,elapsedMs:performance.now()-started};
      return result;
    } catch(error) {
      const changed=error.code==='DEPLOY_CURRENT_CHANGED';
      const rootMismatch=error.code==='DEPLOY_CONSUMERS_ACTIVE'&&error.reason==='root_membership_changed';
      if(changed||rootMismatch)error.observation={stage,outcome:'disallowed',elapsedMs:performance.now()-started,causeCounts:{
        pid_set_changed:0,process_vanished:0,identity_changed:changed?1:0,record_unreadable:0,
        classification_unknown:0,root_mismatch:rootMismatch?1:0}};
      throw error;
    }
    finally{emit('inventory_complete',stage,exclusive);}
  };
  const finish=current=>{
    const order=['preliminary','post_probe','publication'];
    const reached=stages.map(row=>row.observation.stage);
    return {code:'DEPLOY_PAIR_OBSERVED',stages,reached,missed:order.filter(stage=>!reached.includes(stage)),
      probes:{...probes},currentBefore:current,currentAfter:readActivation({repositoryRoot})};
  };
  try {
    writer=acquireLease(path.join(runtime,'deploy.lock'));
    if(pending(runtime).length||pendingPairJournalCount(repositoryRoot))
      fail('DEPLOY_RECOVERY_REQUIRED','deployment_journal_pending');
    const current=readActivation({repositoryRoot});
    if(current?.version!==2)fail('DEPLOY_COMPATIBILITY_MISMATCH','v2_current_required');
    let candidate;
    if(rollback)candidate=selectPairRollbackTarget({repositoryRoot,current,deployLease:writer}).pair;
    else {
      validateRelease({repositoryRoot,releaseId});
      try{candidate=ensureBootstrapGeneration({repositoryRoot,releaseId,reuseBootstrapId:current.bootstrapId,deployLease:writer});}
      catch(error){if(error.code!=='DEPLOY_BOOTSTRAP_INVALID')throw error;
        candidate=ensureBootstrapGeneration({repositoryRoot,releaseId,deployLease:writer});}
    }
    if(!validRuntimePair(candidate))fail('DEPLOY_COMPATIBILITY_MISMATCH');
    const snapshot=pairRows(repositoryRoot);
    const pairs=new Map([pairOf(current),candidate,...snapshot.roots.map(pairOf)].filter(Boolean)
      .map(pair=>[JSON.stringify(pair),pair]));
    evidence=prepareRuntimeEvidence({repositoryRoot,pairs:[...pairs.values()]});
    let result=runStage('preliminary',false,stage=>
      observePreparedPairInventory({repositoryRoot,procRoot,current,evidence,snapshot,stage}));
    stages.push({inventory:result.inventory,observation:result.observation});
    if(result.observation.outcome!=='complete')return finish(current);
    const active=result.roots.length>0||Object.values(result.inventory.bound).some(value=>value>0);
    const compatible=candidate.compatibilityDigest===current.compatibilityDigest;
    if(active&&!compatible)fail('DEPLOY_CONSUMERS_ACTIVE','stopped_rollback_required');
    if(!compatible&&!rollback)fail('DEPLOY_COMPATIBILITY_MISMATCH','incompatible_candidate');
    validationDirectory=createPairValidationDirectory(repositoryRoot);const phaseState={variables:{}};
    try{await phaseRunner({repositoryRoot,home,environment,phase:'verify',managed:true,deployLease:writer,
      directory:validationDirectory,state:phaseState,phaseTimeoutMs,candidateReleaseId:candidate.releaseId});}
    catch(error){if(phaseState.workerDetached){validationDirectory=undefined;
      fail('DEPLOY_RECOVERY_REQUIRED','pair_validation_worker_detached');}throw error;}
    const logDirectory=pinnedDirectory(validationDirectory);
    try{logFd=fs.openSync(logDirectory.at(`verify.${randomBytes(8).toString('hex')}.log`),
      fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.fchmodSync(logFd,0o600);}
    finally{logDirectory.close();}
    const contractCompatible=await comparePairMcpContracts({repositoryRoot,home,environment,deployLease:writer,
      directory:validationDirectory,logFd,origin:current,candidate,onProbed:name=>{probes[name]=true;}});
    if(active&&!contractCompatible)fail('DEPLOY_CONSUMERS_ACTIVE','stopped_rollback_required');
    if(!contractCompatible&&!rollback)fail('DEPLOY_COMPATIBILITY_MISMATCH','incompatible_candidate');
    result=runStage('post_probe',false,stage=>{
      const fresh=pairRows(repositoryRoot);
      requirePreparedRootMembership(snapshot.roots,fresh.roots);
      return observePreparedPairInventory({repositoryRoot,procRoot,current,evidence,snapshot:fresh,stage});
    });
    stages.push({inventory:result.inventory,observation:result.observation});
    if(result.observation.outcome!=='complete')return finish(current);
    publication=acquireLease(path.join(runtime,'publication.lock'),{create:true});
    const sealed=result;
    result=runStage('publication',true,stage=>{
      const observed=observePairProcesses({repositoryRoot,procRoot,roots:sealed.roots,prepared:sealed.prepared,stage});
      try{requirePreparedRootMembership(sealed.roots,
        revalidatePairPublicationEvidence({repositoryRoot,prepared:sealed.prepared}));}
      catch(error){classifyRootRevalidationError({repositoryRoot,expected:sealed.roots,error});}
      return {...observed,roots:sealed.roots,prepared:sealed.prepared};
    });
    stages.push({inventory:result.inventory,observation:result.observation});
    return finish(current);
  } catch(error) {
    const reached=stages.map(row=>row.observation.stage);
    error.observations={stages:[...stages],reached,missed:['preliminary','post_probe','publication'].filter(stage=>!reached.includes(stage)),
      probes:{...probes},
      ...(error.observation?{failed:error.observation}:{})};
    throw error;
  } finally {
    publication?.close();
    try {
      if(logFd!==undefined){try{fs.fsyncSync(logFd);}finally{fs.closeSync(logFd);}}
    } finally {
      try{if(validationDirectory!==undefined)removePairValidationDirectory(validationDirectory);}
      finally{try{evidence?.close();}finally{writer?.close();}}
    }
  }
}

function sameDestination(snapshot,destination) {
  return snapshot?.version===2&&sameJson(pairDestination(snapshot),destination);
}
function verifyPairWitness({repositoryRoot,journalDirectory,state,current}) {
  const witnessDirectory=path.join(journalDirectory,'pointer-witness');const witness=state.witness;
  let directoryInfo;let pointerInfo;let target;
  try {
    directoryInfo=fs.lstatSync(witnessDirectory,{bigint:true});pointerInfo=fs.lstatSync(path.join(witnessDirectory,'current'),{bigint:true});
    target=fs.readlinkSync(path.join(witnessDirectory,'current'));
  }catch{fail('DEPLOY_RECOVERY_REQUIRED','pair_witness_changed');}
  const identity=(stat,{times=false,links=false}={})=>({dev:String(stat.dev),ino:String(stat.ino),uid:Number(stat.uid),mode:Number(stat.mode&0o7777n),
    ...(links?{nlink:Number(stat.nlink)}:{}),...(times?{mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)}:{})});
  if(!directoryInfo.isDirectory()||!pointerInfo.isSymbolicLink()||
    fs.readdirSync(witnessDirectory).join(',')!=='current'||!sameJson(identity(directoryInfo,{times:true}),witness.directory)||
    !sameJson({...identity(pointerInfo),target},witness.pointer))
    fail('DEPLOY_RECOVERY_REQUIRED','pair_witness_changed');
  const verifyActivation=(activationId,expected)=>{let activationInfo;let manifestInfo;let manifestBytes;
    try{const activation=path.join(repositoryRoot,'.jhw-runtime/v2/activations',activationId);
      activationInfo=fs.lstatSync(activation,{bigint:true});manifestInfo=fs.lstatSync(path.join(activation,'manifest.json'),{bigint:true});manifestBytes=fs.readFileSync(path.join(activation,'manifest.json'));
    }catch{fail('DEPLOY_RECOVERY_REQUIRED','pair_witness_changed');}
    if(!activationInfo.isDirectory()||!manifestInfo.isFile()||!sameJson(identity(activationInfo,{times:true}),expected.directory)||
      !sameJson({...identity(manifestInfo,{times:true,links:true}),sha256:createHash('sha256').update(manifestBytes).digest('hex')},expected.manifest))
      fail('DEPLOY_RECOVERY_REQUIRED','pair_witness_changed');
    try{return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes)),bytes:manifestBytes};}catch{fail('DEPLOY_RECOVERY_REQUIRED','pair_witness_changed');}
  };
  if(state.origin!==null)verifyActivation(state.origin.activationId,witness.origin);
  const verified=verifyActivation(state.destination.activationId,witness.destination);const manifest=verified.value;
  if(JSON.stringify(manifest)+'\n'!==verified.bytes.toString('utf8')||manifest.activationId!==state.destination.activationId||
    !sameJson({version:manifest.version,activationId:manifest.activationId,releaseId:manifest.releaseId,bootstrapId:manifest.bootstrapId,
      runtimeContract:manifest.runtimeContract,compatibilityDigest:manifest.compatibilityDigest,predecessorActivationId:manifest.predecessorActivationId,
      migrationId:manifest.migrationId},state.destination))fail('DEPLOY_RECOVERY_REQUIRED','pair_witness_changed');
  if(current!==null&&sameDestination(current,state.destination)) {
    const currentLink=fs.lstatSync(path.join(repositoryRoot,'.jhw-runtime/current'),{bigint:true});
    if(String(currentLink.dev)!==witness.pointer.dev||String(currentLink.ino)!==witness.pointer.ino||fs.readlinkSync(path.join(repositoryRoot,'.jhw-runtime/current'))!==target)
      fail('DEPLOY_RECOVERY_REQUIRED','pair_pointer_changed');
  }
}

export function reconcilePairJournal({repositoryRoot,journalDirectory}) {
  let parsed;try{parsed=readRuntimeJournalV2({repositoryRoot,journalDirectory});}catch{fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_unverified');}
  const {state}=parsed;
  if(state.status==='complete')return {transaction:path.basename(journalDirectory),outcome:state.outcome};
  const current=readActivation({repositoryRoot});
  const atOrigin=sameJson(current,state.origin);
  const atDestination=state.phase==='pointer_intent'?sameDestination(current,state.destination):state.destination!==null&&sameJson(current,state.destination);
  if(state.phase==='prepared'&&atOrigin) {
    state.status='complete';state.phase='rejected';state.outcome='pointer_not_published';checkpoint(journalDirectory,state);
    return {transaction:path.basename(journalDirectory),outcome:state.outcome};
  }
  if(['pointer_intent','published'].includes(state.phase)&&(atOrigin||atDestination)) {
    verifyPairWitness({repositoryRoot,journalDirectory,state,current:atDestination?current:null});
    if(atDestination)state.destination=current;
    state.status='complete';state.phase=atDestination?'complete':'rejected';
    state.outcome=atDestination?'pointer_published':'pointer_not_published';checkpoint(journalDirectory,state);
    if(atDestination)recordDeploymentRetention({repositoryRoot,journalDirectory});
    return {transaction:path.basename(journalDirectory),outcome:state.outcome};
  }
  fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_identity_changed');
}

function reconcilePairJournals(repositoryRoot) {
  const journals=pairJournalRoot(repositoryRoot);
  const names=fs.readdirSync(journals).filter(name=>/^d-[a-f0-9]{32}$/.test(name)).sort();
  const pending=[];
  for(const name of names){const directory=path.join(journals,name);let parsed;try{parsed=readRuntimeJournalV2({repositoryRoot,journalDirectory:directory});}catch{fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_unverified');}if(parsed.state.status==='pending')pending.push(directory);}
  if(pending.length>1)fail('DEPLOY_RECOVERY_REQUIRED','multiple_pair_journals');
  return pending.length?reconcilePairJournal({repositoryRoot,journalDirectory:pending[0]}):null;
}
function pendingRuntimeJournals(repositoryRoot) {
  const journals=path.join(repositoryRoot,'.jhw-runtime/v2/journals');if(!exists(journals))return [];
  const pending=[];for(const name of fs.readdirSync(journals).filter(name=>/^d-[a-f0-9]{32}$/.test(name))){
    try{const state=readRuntimeJournalV2({repositoryRoot,journalDirectory:path.join(journals,name)}).state;if(state.status==='pending')pending.push({name,kind:state.kind});}
    catch{fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_unverified');}
  }
  return pending;
}
function pendingPairJournalCount(repositoryRoot) {return pendingRuntimeJournals(repositoryRoot).length;}

function hasManagedInvocationStore(repositoryRoot) {
  return exists(path.join(repositoryRoot,'.jhw-runtime/v2/managed-invocations'));
}

export async function runCompatiblePairDeployment({repositoryRoot,home,procRoot,environment,releaseId,rollback=false,phaseRunner=wiringPhase,phaseTimeoutMs=45000,managedScope=null}) {
  const runtime=path.join(repositoryRoot,'.jhw-runtime');
  let writer;let admission;let publication;let evidence;let publicationEvidence;let directory;let logFd;let state;let journalCandidate;let validationDirectory;
  try {
    writer=acquireLease(path.join(runtime,'deploy.lock'));
    if(managedScope!==null)requireManagedScope(managedScope,repositoryRoot);
    else if(hasManagedInvocationStore(repositoryRoot))fail('DEPLOY_MANAGED_MODE_REQUIRED');
    if(pending(runtime).length)fail('DEPLOY_RECOVERY_REQUIRED','deployment_journal_pending');
    const recovery=reconcilePairJournals(repositoryRoot);
    const origin=readActivation({repositoryRoot});
    if(origin?.version!==2)fail('DEPLOY_COMPATIBILITY_MISMATCH','v2_current_required');
    let candidate;
    if(rollback)candidate=selectPairRollbackTarget({repositoryRoot,current:origin,deployLease:writer}).pair;
    else {
      validateRelease({repositoryRoot,releaseId});
      try{candidate=ensureBootstrapGeneration({repositoryRoot,releaseId,reuseBootstrapId:origin.bootstrapId,deployLease:writer});}
      catch(error){if(error.code!=='DEPLOY_BOOTSTRAP_INVALID')throw error;candidate=ensureBootstrapGeneration({repositoryRoot,releaseId,deployLease:writer});}
    }
    if(!validRuntimePair(candidate))fail('DEPLOY_COMPATIBILITY_MISMATCH');
    const preliminarySnapshot=pairRows(repositoryRoot);
    const pairMap=new Map([pairOf(origin),candidate,...preliminarySnapshot.roots.map(pairOf)].filter(Boolean).map(pair=>[JSON.stringify(pair),pair]));
    evidence=prepareRuntimeEvidence({repositoryRoot,pairs:[...pairMap.values()]});
    const preliminary=completePreparedPairInventory({repositoryRoot,procRoot,current:origin,evidence,snapshot:preliminarySnapshot,managedScope});
    const active=preliminary.roots.length>0||(managedScope!==null
      ?preliminary.processes.invocationRecords:Object.values(preliminary.processes.bound).some(value=>value>0));
    const compatible=candidate.compatibilityDigest===origin.compatibilityDigest;
    if(managedScope!==null&&!compatible)fail('DEPLOY_COMPATIBILITY_MISMATCH','incompatible_candidate');
    if(active&&!compatible)fail('DEPLOY_CONSUMERS_ACTIVE','stopped_rollback_required');
    if(!compatible&&!rollback)fail('DEPLOY_COMPATIBILITY_MISMATCH','incompatible_candidate');
    state={version:2,kind:'pair',status:'pending',operation:rollback?'rollback':'activate',phase:'prepared',origin,
      candidate,destination:null,witness:null,outcome:null};
    journalCandidate=createPairJournalCandidate(repositoryRoot,state);directory=journalCandidate.staging;
    validationDirectory=createPairValidationDirectory(repositoryRoot);const phaseState={variables:{}};
    try{await phaseRunner({repositoryRoot,home,environment,phase:'verify',managed:true,deployLease:writer,directory:validationDirectory,state:phaseState,phaseTimeoutMs,
      candidateReleaseId:candidate.releaseId});}
    catch(error){if(phaseState.workerDetached){state.phase='blocked';checkpoint(directory,state);directory=publishPairJournal(journalCandidate);validationDirectory=undefined;fail('DEPLOY_RECOVERY_REQUIRED','pair_validation_worker_detached');}throw error;}
    removePairValidationDirectory(validationDirectory);validationDirectory=undefined;directory=journalCandidate.staging;
    const logDirectory=pinnedDirectory(directory);
    try{logFd=fs.openSync(logDirectory.at('candidate-probe.log'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.fchmodSync(logFd,0o600);}
    finally{logDirectory.close();}
    const contractCompatible=await comparePairMcpContracts({repositoryRoot,home,environment,deployLease:writer,
      directory,logFd,origin,candidate,observe:phaseRunner.observe});
    if(managedScope!==null&&!contractCompatible)fail('DEPLOY_COMPATIBILITY_MISMATCH','incompatible_candidate');
    if(active&&!contractCompatible)fail('DEPLOY_CONSUMERS_ACTIVE','stopped_rollback_required');
    if(!contractCompatible&&!rollback)fail('DEPLOY_COMPATIBILITY_MISMATCH','incompatible_candidate');
    const prepared=preparePairActivation({repositoryRoot,pair:candidate,expectedCurrent:origin,rollback,deployLease:writer});
    directory=publishPairJournal(journalCandidate);
    const before=completePreparedPairInventory({repositoryRoot,procRoot,current:origin,evidence,managedScope});
    publicationEvidence=before.prepared;
    if(managedScope===null&&rollback&&(!active||!compatible||!contractCompatible)){
      admission=acquireLease(path.join(runtime,'admission.lock'),{create:true});
      const quiet=requireQuiescence({repositoryRoot,procRoot,excludePids:[process.pid]});
      if(pairRows(repositoryRoot).roots.length)fail('DEPLOY_CONSUMERS_ACTIVE','stopped_rollback_required');
      before.processes=quiet;
    }
    let started;let current;let processes;let roots;
    publication=acquireLease(path.join(runtime,'publication.lock'),{create:true});
    try {
      started=process.hrtime.bigint();
      phaseRunner.observe?.({phase:'publication_acquired',exclusive:true,elapsedNs:'0'});
      processes=deploymentProcessInventory({repositoryRoot,procRoot,roots:before.roots,prepared:publicationEvidence,managedScope});
      try{roots=requirePreparedRootMembership(before.roots,revalidatePairPublicationEvidence({repositoryRoot,prepared:publicationEvidence,observer:phaseRunner.observe}));}
      catch(error){if(error.code==='DEPLOY_CURRENT_CHANGED')throw error;fail('DEPLOY_CONSUMERS_ACTIVE','root_membership_changed');}
      current=publishPreparedActivation({repositoryRoot,destination:prepared,expectedCurrent:origin,evidence,publicationLease:publication,journalDirectory:directory,publicationStartedNs:started,
        onPointerIntent:(destination,intent)=>{
          if(!intent?.witness)fail('DEPLOY_RECOVERY_REQUIRED','pointer_identity_unavailable');
          state.destination=destination;state.witness=intent.witness;state.phase='pointer_intent';checkpoint(directory,state);
          phaseRunner.observe?.({phase:'pointer_intent',exclusive:true,elapsedNs:String(process.hrtime.bigint()-started)});
        }});
      phaseRunner.observe?.({phase:'pointer_renamed',exclusive:true,elapsedNs:String(process.hrtime.bigint()-started)});
    } finally {
      // Finalization and the outer error classifier may read payloads or sync
      // logs. They must only run after this publication scope has released EX.
      publication.close();publication=undefined;
      phaseRunner.observe?.({phase:'publication_released',exclusive:false,elapsedNs:String(process.hrtime.bigint()-started)});
    }
    state.destination=current;state.phase='published';checkpoint(directory,state);
    phaseRunner.observe?.({phase:'published_checkpointed',exclusive:false,elapsedNs:String(process.hrtime.bigint()-started)});
    if(!sameJson(current,state.destination))fail('DEPLOY_CURRENT_CHANGED');
    state.status='complete';state.phase='complete';state.outcome='pointer_published';checkpoint(directory,state);
    phaseRunner.observe?.({phase:'log_fsync_start',exclusive:false,elapsedNs:String(process.hrtime.bigint()-started)});
    if(logFd!==undefined){fs.fsyncSync(logFd);fs.closeSync(logFd);logFd=undefined;}
    phaseRunner.observe?.({phase:'log_fsync_complete',exclusive:false,elapsedNs:String(process.hrtime.bigint()-started)});
    recordDeploymentRetention({repositoryRoot,journalDirectory:directory});
    return {code:rollback?'DEPLOY_ROLLED_BACK':'DEPLOY_COMPATIBLE_ACTIVATED',releaseId:current.releaseId,
      previousReleaseId:origin.releaseId,predecessorAvailable:current.predecessorActivationId!==null,
      inventory:{before:{...before,processes},after:{roots,processes}},existingSessionsPreserved:true,recovery};
  }catch(error){
    if(state?.phase==='prepared'&&!publication){
      try{if(sameJson(readActivation({repositoryRoot}),state.origin)){
        state.status='complete';state.phase='rejected';state.outcome='candidate_rejected';checkpoint(directory,state);
        if(journalCandidate&&directory===journalCandidate.staging)directory=publishPairJournal(journalCandidate);
      }}catch{}
    }
    throw error;
  }finally{
    let cleanupError;const cleanup=operation=>{try{operation();}catch(error){cleanupError??=error;}};
    cleanup(()=>publication?.close());publication=undefined;
    cleanup(()=>admission?.close());admission=undefined;
    cleanup(()=>removePairValidationDirectory(validationDirectory));validationDirectory=undefined;
    cleanup(()=>evidence?.close());evidence=undefined;
    cleanup(()=>{if(logFd!==undefined){fs.fsyncSync(logFd);fs.closeSync(logFd);logFd=undefined;}});
    cleanup(()=>writer?.close());writer=undefined;
    if(cleanupError)throw cleanupError;
  }
}

function reconcileCompatibleJournal({repositoryRoot,runtime}) {
  const abandoned=pending(runtime);
  if(!abandoned.length) return null;
  if(abandoned.length!==1) fail('DEPLOY_RECOVERY_REQUIRED');
  const directory=path.join(runtime,abandoned[0]);
  const state=privateRead(path.join(directory,'state.json'));
  const allowed=['version','status','operation','compatible','candidateReleaseId','compatibilityDigest','phase','previous','variables','mutationStarted','destination','stateIncomplete','workerDetached'];
  if(!state||Object.keys(state).some(key=>!allowed.includes(key))||state.version!==1||state.status!=='pending'||
    state.operation!=='activate'||state.compatible!==true||!RELEASE.test(state.candidateReleaseId??'')||
    !/^[a-f0-9]{64}$/.test(state.compatibilityDigest??'')||!state.previous||state.stateIncomplete||state.workerDetached||
    !state.variables||typeof state.variables!=='object'||Array.isArray(state.variables)||
    Object.entries(state.variables).some(([key,value])=>!KEYS.includes(key)||typeof value!=='string')||
    !['before_mutation','candidate_validate','pointer_intent'].includes(state.phase))
    fail('DEPLOY_RECOVERY_REQUIRED');
  if(!validCurrent(state.previous)) fail('DEPLOY_RECOVERY_REQUIRED');
  const publication=acquireLease(path.join(runtime,'publication.lock'),{create:true});
  try {
    const current=readActivation({repositoryRoot});
    const atOrigin=JSON.stringify(current)===JSON.stringify(state.previous);
    let atDestination=false;
    if(state.phase==='pointer_intent') {
      const destination=state.destination;
      if(state.mutationStarted!==true||!destination||Object.keys(destination).sort().join(',')!=='activationId,predecessorActivationId,releaseId'||
        !/^a-[a-f0-9]{32}$/.test(destination.activationId)||destination.releaseId!==state.candidateReleaseId||
        destination.predecessorActivationId!==state.previous.activationId) fail('DEPLOY_RECOVERY_REQUIRED');
      atDestination=current?.activationId===destination.activationId&&current.releaseId===destination.releaseId&&
        current.predecessorActivationId===destination.predecessorActivationId;
      if(atDestination) {
        const manifest=privateRead(path.join(runtime,'activations',current.activationId,'manifest.json'));
        const origin=manifest.priorCurrent;
        if(!origin||['activationId','releaseId','predecessorActivationId'].some(key=>origin[key]!==state.previous[key])||
          ['target','dev','ino','ctimeNs'].some(key=>origin.observation[key]!==state.previous.observation?.[key])) fail('DEPLOY_RECOVERY_REQUIRED');
      }
    } else if(state.destination!==undefined||
      (state.mutationStarted!==undefined&&state.mutationStarted!==true)||
      (state.phase==='before_mutation'&&state.mutationStarted)) fail('DEPLOY_RECOVERY_REQUIRED');
    if(!atOrigin&&!atDestination) fail('DEPLOY_RECOVERY_REQUIRED');
    for(const releaseId of [state.previous.releaseId,state.candidateReleaseId]) {
      if(releaseCompatibility({repositoryRoot,releaseId})!==state.compatibilityDigest) fail('DEPLOY_RECOVERY_REQUIRED');
      requireBootstrapGeneration({repositoryRoot,releaseId});
    }
    state.status='complete';
    state.phase=atDestination?'interrupted_after_publish':'interrupted_before_publish';
    checkpoint(directory,state);
    return {transaction:abandoned[0],outcome:state.phase};
  } finally {publication.close();}
}
function createCompatibleJournal(runtime,state) {
  const parent=pinnedDirectory(runtime);
  const suffix=randomBytes(16).toString('hex');
  try {
    const staging=createPrivateDirectory(runtime,'.candidate.'+suffix);
    checkpoint(staging,state);
    parent.verify();
    fs.renameSync(parent.at('.candidate.'+suffix),parent.at('.deploy.'+suffix));
    fs.fsyncSync(parent.fd);parent.verify();
    return path.join(runtime,'.deploy.'+suffix);
  } finally {parent.close();}
}

async function runCompatibleDeployment({repositoryRoot,home,procRoot,environment,releaseId,phaseRunner,phaseTimeoutMs}) {
  const runtime=path.join(repositoryRoot,'.jhw-runtime');
  // This is a distinct, proved-coexistence operation. Ordinary maintenance keeps
  // its original global inventory and exclusive admission semantics unchanged.
  let writer; let publication; let probe; let directory; let state; let logFd;
  try {
    writer=acquireLease(path.join(runtime,'deploy.lock'));
    const previous=readActivation({repositoryRoot});
    if(!previous||!exists(path.join(runtime,'wiring.json'))||privateRead(path.join(runtime,'wiring.json')).installed!==true)
      fail('DEPLOY_COMPATIBILITY_MISMATCH','managed_activation_required');
    const recovery=reconcileCompatibleJournal({repositoryRoot,runtime});
    validateRelease({repositoryRoot,releaseId});
    requireMatchingInstaller(repositoryRoot,previous.releaseId);
    requireBootstrapGeneration({repositoryRoot,releaseId:previous.releaseId});
    const fingerprint=releaseCompatibility({repositoryRoot,releaseId:previous.releaseId});
    if(releaseCompatibility({repositoryRoot,releaseId})!==fingerprint)
      fail('DEPLOY_COMPATIBILITY_MISMATCH','shared_artifacts_changed');
    requireBootstrapGeneration({repositoryRoot,releaseId});
    const before=compatibleInventory({repositoryRoot,procRoot,fingerprint});
    state={version:1,status:'pending',operation:'activate',compatible:true,candidateReleaseId:releaseId,compatibilityDigest:fingerprint,phase:'before_mutation',previous,variables:{}};
    directory=createCompatibleJournal(runtime,state);
    await phaseRunner({repositoryRoot,home,environment,phase:'verify',managed:true,deployLease:writer,directory,state,phaseTimeoutMs});
    const logDirectory=pinnedDirectory(directory);
    try {
      logFd=fs.openSync(logDirectory.at('candidate-probe.log'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      fs.fchmodSync(logFd,0o600); logDirectory.verify();
    } finally {logDirectory.close();}
    const inspectCandidate=async selected=>{
      publication=acquireLease(path.join(runtime,'publication.lock'),{shared:true,create:true});
      try {probe=createSessionBinding({repositoryRoot,releaseId:selected});}
      finally {publication.close();publication=undefined;}
      try {
        return mcpContract(await mcpProbe({repositoryRoot,home,environment:{...environment,JHW_RUNTIME_SESSION_BINDING:probe.token},deployLease:writer,directory,logFd}));
      } finally {probe.close();probe=undefined;}
    };
    state.phase='candidate_validate';checkpoint(directory,state);
    const currentContract=await inspectCandidate(previous.releaseId);
    const candidateContract=await inspectCandidate(releaseId);
    if(currentContract.protocol!==candidateContract.protocol||currentContract.capabilities!==candidateContract.capabilities||
      [...currentContract.tools].some(([name,contract])=>candidateContract.tools.get(name)!==contract))
      fail('DEPLOY_COMPATIBILITY_MISMATCH','mcp_contract_changed');
    // Only selection/registration and the atomic default switch use publication.
    // Existing processes retain their admission and per-binding lifetime leases.
    publication=acquireLease(path.join(runtime,'publication.lock'),{create:true});
    if(JSON.stringify(readActivation({repositoryRoot}))!==JSON.stringify(previous)) fail('DEPLOY_CURRENT_CHANGED');
    const after=compatibleInventory({repositoryRoot,procRoot,fingerprint});
    if(releaseCompatibility({repositoryRoot,releaseId})!==fingerprint) fail('DEPLOY_COMPATIBILITY_MISMATCH');
    requireBootstrapGeneration({repositoryRoot,releaseId});
    state.mutationStarted=true;checkpoint(directory,state);
    const current=publishActivation({repositoryRoot,releaseId,expectedCurrent:previous,onPointerIntent:destination=>{
      state.destination=destination;state.phase='pointer_intent';checkpoint(directory,state);
    }});
    state.current=current;state.status='complete';state.phase='complete';checkpoint(directory,state);
    recordDeploymentRetention({repositoryRoot,journalDirectory:directory});
    return {code:'DEPLOY_COMPATIBLE_ACTIVATED',releaseId:current.releaseId,previousReleaseId:previous.releaseId,
      predecessorAvailable:true,inventory:{before,after},existingSessionsPreserved:true,recovery};
  } catch(error) {
    // A failed pre-publication probe never moves the default. Retain its audit
    // record but do not strand an otherwise unchanged installation as pending.
    if(state&&!state.mutationStarted) {
      try {
        if(JSON.stringify(readActivation({repositoryRoot}))===JSON.stringify(state.previous)) {
          state.status='complete';state.phase='candidate_rejected';checkpoint(directory,state);
        }
      } catch { /* Preserve uncertain evidence for the existing recovery path. */ }
    }
    throw error;
  } finally {
    probe?.close();
    if(logFd!==undefined){fs.fsyncSync(logFd);fs.closeSync(logFd);}
    publication?.close();writer?.close();
  }
}

function codexJournalRoot(repositoryRoot) {
 const runtime=prepareStore(repositoryRoot);const v2=path.join(runtime,'v2');if(!exists(v2))createPrivateDirectory(runtime,'v2');
 const journals=path.join(v2,'journals');if(!exists(journals))createPrivateDirectory(v2,'journals');
 trustedDirectory(v2);trustedDirectory(journals);return journals;
}
function codexPendingJournals(repositoryRoot) {
 const journals=path.join(repositoryRoot,'.jhw-runtime/v2/journals');if(!exists(journals))return [];
 const pending=[];
 for(const name of fs.readdirSync(journals).filter(name=>/^d-[a-f0-9]{32}$/.test(name)).sort()) {
  let parsed;try{parsed=readRuntimeJournalV2({repositoryRoot,journalDirectory:path.join(journals,name)});}catch{fail('DEPLOY_RECOVERY_REQUIRED','runtime_journal_unverified');}
  if(parsed.state.status==='pending')pending.push({directory:path.join(journals,name),kind:parsed.state.kind});
 }
 return pending;
}
function createCodexJournal(repositoryRoot) {
 const journals=codexJournalRoot(repositoryRoot);return createPrivateDirectory(journals,`d-${randomBytes(16).toString('hex')}`);
}
function runEditor(editor,args,{environment,home,deployLease,admissionLease,capture=false}) {
 const env={...environment,HOME:home,PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':')};
 for(const key of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV','SHELLOPTS','BASHOPTS'])delete env[key];
 const result=spawnSync(process.execPath,[editor,...args],{env,encoding:capture?'utf8':undefined,stdio:capture?['ignore','pipe','ignore',deployLease.fd,admissionLease.fd]:['ignore','ignore','ignore',deployLease.fd,admissionLease.fd],timeout:45000,maxBuffer:16*1024});
 if(result.error||result.signal||result.status!==0)return null;return capture?result.stdout:true;
}
export async function runCodexConfigMigration({repositoryRoot,home,current,deployLease,admissionLease,environment=process.env}) {
 if(!current||!RELEASE.test(current.releaseId))fail('DEPLOY_ARGUMENTS_INVALID','managed_activation_required');
 requireMatchingCodexEditor(repositoryRoot,current.releaseId);
 const release=path.join(repositoryRoot,'.jhw-runtime/releases',current.releaseId);const editor=path.join(release,'scripts/install-config.mjs');
 const entry=path.join(repositoryRoot,'.jhw-runtime/bootstrap/jhw-runtime-entry');const config=path.join(home,'.codex/config.toml');
 trustedFile(editor);trustedFile(entry);
 const pending=codexPendingJournals(repositoryRoot);
 if(pending.length>1||pending.some(item=>item.kind!=='codex-config'))fail('DEPLOY_RECOVERY_REQUIRED','runtime_journal_pending');
 let evidence=pending[0]?.directory;
 if(!evidence) {
  if(runEditor(editor,['verify-codex-binding',config,entry,repositoryRoot,current.releaseId],{environment,home,deployLease,admissionLease}))
   return {code:'DEPLOY_CODEX_CONFIG_MIGRATED',changed:false};
  if(!runEditor(editor,['verify-codex',config,entry,repositoryRoot,current.releaseId],{environment,home,deployLease,admissionLease}))fail('DEPLOY_WIRING_CONFLICT','codex_owned_vector_required');
  const capability=runEditor(editor,['check-codex-binding-migration',config,entry,repositoryRoot,current.releaseId],{environment,home,deployLease,admissionLease,capture:true});
  let parsed;try{parsed=JSON.parse(capability);}catch{fail('DEPLOY_WIRING_CONFLICT','codex_migration_capability_required');}
  if(JSON.stringify(parsed)!==JSON.stringify({version:1,capabilities:['codex-binding-migration-v1']}))fail('DEPLOY_WIRING_CONFLICT','codex_migration_capability_required');
  evidence=createCodexJournal(repositoryRoot);
 }
 const changed=runEditor(editor,['migrate-codex-binding-transaction',config,entry,repositoryRoot,current.releaseId,evidence],{environment,home,deployLease,admissionLease});
 if(!changed) {
  const recovered=readRuntimeJournalV2({repositoryRoot,journalDirectory:evidence}).state;
  if(recovered.kind==='codex-config'&&recovered.status==='complete'&&['unchanged','restored-before'].includes(recovered.outcome))
   fail('DEPLOY_WIRING_FAILED','codex_config_migration_recovered');
  fail('DEPLOY_RECOVERY_REQUIRED','codex_config_migration_pending');
 }
 const parsed=readRuntimeJournalV2({repositoryRoot,journalDirectory:evidence});
 if(parsed.state.kind!=='codex-config'||parsed.state.status!=='complete'||parsed.state.outcome!=='migrated')fail('DEPLOY_RECOVERY_REQUIRED','codex_config_migration_unverified');
 recordDeploymentRetention({repositoryRoot,journalDirectory:evidence});
 return {code:'DEPLOY_CODEX_CONFIG_MIGRATED',changed:true};
}

function transitionEqual(a,b) {
 const ordered=value=>Array.isArray(value)?value.map(ordered):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
 return JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
}
function requireStoppedTransition(repositoryRoot,procRoot) {
 requireQuiescence({repositoryRoot,procRoot,excludePids:[process.pid]});
 if(inspectSessionBindings({repositoryRoot}).some(row=>row.live)||inspectSessionBindingsV2({repositoryRoot}).some(row=>row.live))
  fail('DEPLOY_CONSUMERS_ACTIVE','stopped_transition_required');
 const generations=path.join(repositoryRoot,'.jhw-runtime/v2/bootstraps');
 if(exists(generations)){
  const parent=pinnedDirectory(generations);
  try{const names=fs.readdirSync(`/proc/self/fd/${parent.fd}`);if(names.length>8192)fail('DEPLOY_INVENTORY_UNCERTAIN');
   for(const name of names.filter(name=>/^b-[a-f0-9]{64}$/.test(name))){let lease;
    try{lease=acquireLease(path.join(generations,name,'lease'));}
    catch(error){if(error.code==='DEPLOY_LOCK_CONTENDED')fail('DEPLOY_CONSUMERS_ACTIVE','orphan_generation_lease');throw error;}
    finally{lease?.close();}
   }parent.verify();
  }finally{parent.close();}
 }
}
function transitionObserver(phaseRunner,phase) {
 const result=phaseRunner.observe?.({phase,exclusive:true});if(result?.then)fail('DEPLOY_ARGUMENTS_INVALID');
}
function transitionRootProof(repositoryRoot,name) {
 if(!exists(path.join(repositoryRoot,'.jhw-runtime',name)))return null;
 return bootstrapObjectProof({repositoryRoot,name});
}
async function runBootstrapTransition({repositoryRoot,home,procRoot,environment,phaseRunner,phaseTimeoutMs,
    deployLease,admissionLease,journalDirectory,state,recover=false,runtimeHandle,capability}) {
 const runtime=path.join(repositoryRoot,'.jhw-runtime');let admission=admissionLease;let publication;
 const anchor=readMigrationAnchor({repositoryRoot,migrationId:state.migrationId,expectedRef:state.anchor});
 if(state.operation==='legacy-rollback'&&(anchor.guard===null)!==(state.guard===null))fail('DEPLOY_RECOVERY_REQUIRED','migration_guard_mismatch');
 if(state.operation==='upgrade'?!transitionEqual(state.origin,anchor.preMigrationCurrent)||state.destination.activationId!==anchor.firstActivationId||state.destination.migrationId!==anchor.migrationId:
   state.origin.activationId!==anchor.firstActivationId||state.origin.migrationId!==anchor.migrationId||!transitionEqual(state.destination,Object.fromEntries(Object.entries(anchor.legacyRollbackTarget).filter(([key])=>key!=='observation'))))
  fail('DEPLOY_RECOVERY_REQUIRED','migration_anchor_mismatch');
 const pointerArgs={repositoryRoot,journalDirectory,origin:state.origin,destination:state.destination,witness:state.witness};
 const checkpointPhase=phase=>{state.phase=phase;checkpoint(journalDirectory,state);transitionObserver(phaseRunner,`migration_${phase}`);};
 const proof=name=>transitionRootProof(repositoryRoot,name);
 const matches=(name,expected)=>transitionEqual(proof(name),expected);
 const move=async(sourceName,destinationName,expectedProof,event)=>{
  requireStoppedTransition(repositoryRoot,procRoot);
  await moveBootstrapObject({repositoryRoot,sourceName,destinationName,expectedProof,runtimeHandle,capability,deployLease,admissionLease:admission});
  transitionObserver(phaseRunner,event);
 };
 const complete=outcome=>{state.status='complete';state.phase='complete';state.outcome=outcome;checkpoint(journalDirectory,state);recordDeploymentRetention({repositoryRoot,journalDirectory});};
 try{
  requireStoppedTransition(repositoryRoot,procRoot);
  const pointer=inspectTransitionPointer(pointerArgs);const router=state.router;
  if(state.operation==='legacy-rollback'&&state.guard!==null){
   checkpointPhase('guard_intent');restoreMigrationGuardRollback({repositoryRoot,home,journalDirectory,anchor,reference:state.guard});
   transitionObserver(phaseRunner,'migration_guard_restored');
  }
  if(state.operation==='upgrade'&&pointer.location==='origin'&&(recover||state.phase==='restore_intent')){
   // Recovery before pointer publication returns to B and the exact old root.
   const atBootstrap=proof('bootstrap'),atPrevious=proof(router.previousDirectory),atStage=proof(router.stageName),atPark=proof(router.parkingDirectory);
   const untouched=transitionEqual(atBootstrap,router.previousProof)&&atPrevious===null&&transitionEqual(atStage,router.stageProof)&&atPark===null;
   const oldMoved=atBootstrap===null&&transitionEqual(atPrevious,router.previousProof)&&transitionEqual(atStage,router.stageProof)&&atPark===null;
   const routerPublished=transitionEqual(atBootstrap,router.stageProof)&&transitionEqual(atPrevious,router.previousProof)&&atStage===null&&atPark===null;
   const routerParked=atBootstrap===null&&transitionEqual(atPrevious,router.previousProof)&&atStage===null&&transitionEqual(atPark,router.stageProof);
   const restored=transitionEqual(atBootstrap,router.previousProof)&&atPrevious===null&&atStage===null&&transitionEqual(atPark,router.stageProof);
   if(![untouched,oldMoved,routerPublished,routerParked,restored].some(Boolean))fail('DEPLOY_RECOVERY_REQUIRED','migration_bootstrap_foreign');
   checkpointPhase('restore_intent');
   if(routerPublished)await move('bootstrap',router.parkingDirectory,router.stageProof,'migration_router_parked');
   if(oldMoved||routerPublished||routerParked)await move(router.previousDirectory,'bootstrap',router.previousProof,'migration_original_restored');
   verifyMigrationOriginal({repositoryRoot,anchor,name:'bootstrap'});
   if(inspectTransitionPointer(pointerArgs).location!=='origin')fail('DEPLOY_CURRENT_CHANGED');
   complete('restored');return {code:'DEPLOY_BOOTSTRAP_REFRESHED',releaseId:state.origin.releaseId,migrationId:state.migrationId,recovered:true,outcome:'restored',bootstrap:{from:anchor.originalBootstrap.manifest.sourceReleaseId,to:anchor.originalBootstrap.manifest.sourceReleaseId,previousDirectory:null}};
  }
  if(pointer.location==='origin'){
   // The same exact-state table drives initial forward execution and rollback retry.
   if(matches('bootstrap',router.previousProof)&&matches(router.previousDirectory,null)&&matches(router.stageName,router.stageProof)&&matches(router.parkingDirectory,null)){
    checkpointPhase('router_intent');await move('bootstrap',router.previousDirectory,router.previousProof,'migration_original_moved');
   }
   if(matches('bootstrap',null)&&matches(router.previousDirectory,router.previousProof)&&matches(router.stageName,router.stageProof)&&matches(router.parkingDirectory,null)){
    await move(router.stageName,'bootstrap',router.stageProof,'migration_router_renamed');
   }
   if(!matches('bootstrap',router.stageProof)||!matches(router.previousDirectory,router.previousProof)||!matches(router.stageName,null)||!matches(router.parkingDirectory,null))
    fail('DEPLOY_RECOVERY_REQUIRED','migration_bootstrap_foreign');
   checkpointPhase('router_published');
   verifyMigrationOriginal({repositoryRoot,anchor,name:state.operation==='upgrade'?router.previousDirectory:'bootstrap'});
   checkpointPhase('current_intent');publication=acquireLease(path.join(runtime,'publication.lock'),{create:true});
   try{state.published=publishTransitionPointer({...pointerArgs,publicationLease:publication,capability,runtimeHandle,
    observe:phase=>transitionObserver(phaseRunner,`migration_${phase}`)});}finally{publication.close();publication=undefined;}
   checkpointPhase('pair_published');
  }else{
   if(!matches('bootstrap',router.stageProof)||!matches(router.previousDirectory,router.previousProof)||!matches(router.stageName,null)||!matches(router.parkingDirectory,null))
    fail('DEPLOY_RECOVERY_REQUIRED','migration_bootstrap_foreign');
   if(state.published!==null&&!transitionEqual(state.published,pointer.current))fail('DEPLOY_CURRENT_CHANGED');
   state.published=pointer.current;checkpointPhase('pair_published');
  }
  const validationDirectory=path.join(journalDirectory,'validation');
  const phaseState=exists(path.join(validationDirectory,'state.json'))?privateRead(path.join(validationDirectory,'state.json')):{variables:{}};
  if(phaseState.workerDetached||phaseState.stateIncomplete)fail('DEPLOY_RECOVERY_REQUIRED','migration_validation_unverified');
  if(state.operation==='legacy-rollback'&&state.guard!==null)await phaseRunner({repositoryRoot,home,environment,phase:'verify',managed:true,deployLease,admissionLease:admission,directory:validationDirectory,state:phaseState,phaseTimeoutMs});
  checkpointPhase('validation');admission.close();admission=undefined;
  let validationError;
  try{await phaseRunner({repositoryRoot,home,environment,phase:'validate',managed:true,deployLease,admissionLease:null,
    directory:validationDirectory,state:phaseState,phaseTimeoutMs});}catch(error){validationError=error;}
  admission=acquireLease(path.join(runtime,'admission.lock'));requireStoppedTransition(repositoryRoot,procRoot);
  if(validationError)fail('DEPLOY_VALIDATION_FAILED','bootstrap_migration_validation_failed');
  if(!transitionEqual(inspectTransitionPointer(pointerArgs).current,state.published)||!matches('bootstrap',router.stageProof)||!matches(router.previousDirectory,router.previousProof))fail('DEPLOY_CURRENT_CHANGED');
  complete(state.operation==='upgrade'?'migrated':'rolled_back');
  return state.operation==='upgrade'?{code:'DEPLOY_BOOTSTRAP_REFRESHED',releaseId:state.published.releaseId,migrationId:state.migrationId,
   priorCurrent:null,predecessorActivationId:null,bootstrap:{from:anchor.originalBootstrap.manifest.sourceReleaseId,to:state.published.releaseId,previousDirectory:router.previousDirectory}}:
   {code:'DEPLOY_ROLLED_BACK',previousReleaseId:state.origin.releaseId,releaseId:state.published.releaseId,predecessorAvailable:state.published.predecessorActivationId!==null};
 }finally{publication?.close();if(admission&&admission!==admissionLease)admission.close();}
}
export async function runBootstrapMigration({repositoryRoot,home,current,deployLease,admissionLease,procRoot='/proc',environment=process.env,phaseRunner=wiringPhase,phaseTimeoutMs=45000}) {
 const runtime=path.join(repositoryRoot,'.jhw-runtime');let runtimeHandle;
 try{
  runtimeHandle=pinnedDirectory(runtime);const capability=prepareAtomicRename({directory:runtimeHandle});
  requireStoppedTransition(repositoryRoot,procRoot);
  if(current?.version===2||!validCurrent(current)||current===null)fail('DEPLOY_ARGUMENTS_INVALID','migration_requires_v1_current');
  requireMatchingInstaller(repositoryRoot,current.releaseId);
  if(!exists(path.join(runtime,'wiring.json'))||privateRead(path.join(runtime,'wiring.json')).installed!==true)fail('DEPLOY_ARGUMENTS_INVALID','refresh_requires_managed_activation');
  if(exists(path.join(home,'.codex'))){
   const editor=path.join(runtime,'releases',current.releaseId,'scripts/install-config.mjs');trustedFile(editor);
   if(!runEditor(editor,['verify-codex-binding',path.join(home,'.codex/config.toml'),path.join(runtime,'bootstrap/jhw-runtime-entry'),repositoryRoot,current.releaseId],{environment,home,deployLease,admissionLease}))
    fail('DEPLOY_ARGUMENTS_INVALID','codex_config_migration_required');
  }
  const {guard,...proof}=findLegacyActivationReceipt({repositoryRoot,current});
  const migrationId=`m-${randomBytes(16).toString('hex')}`,firstActivationId=`a-${randomBytes(16).toString('hex')}`;
  const previousDirectory=`.bootstrap.previous.${migrationId.slice(2)}`;
  const pair=ensureBootstrapGeneration({repositoryRoot,releaseId:current.releaseId,deployLease});
  const original=validateBootstrap({repositoryRoot});if(original.version!==1)fail('DEPLOY_BOOTSTRAP_INVALID');
  const anchor=prepareMigrationAnchor({repositoryRoot,migrationId,preMigrationCurrent:current,legacyRollbackTarget:proof.previous,
    previousDirectory,router:{sourceReleaseId:current.releaseId,routerContract:1},pair,firstActivationId,legacyReceipt:proof,guard,deployLease});
  const stage=await prepareRouterV2({repositoryRoot,releaseId:current.releaseId,deployLease,admissionLease});
  const destination=preparePairActivation({repositoryRoot,pair,expectedCurrent:current,migrationId,migrationAnchor:anchor,activationId:firstActivationId,deployLease});
  const state={version:2,kind:'bootstrap-migration',operation:'upgrade',status:'pending',phase:'prepared',migrationId,anchor:anchor.reference,
   origin:current,destination,witness:null,published:null,guard:null,router:{stageName:stage.stageName,previousDirectory,stageProof:stage.proof,
    previousProof:bootstrapObjectProof({repositoryRoot,name:'bootstrap'}),parkingDirectory:`.bootstrap.failed.${randomBytes(16).toString('hex')}`},outcome:null};
  const candidate=createPairJournalCandidate(repositoryRoot,state);
  state.witness=prepareTransitionPointer({repositoryRoot,journalDirectory:candidate.staging,origin:current,destination,deployLease});
  createPrivateDirectory(candidate.staging,'validation');checkpoint(candidate.staging,state);
  const journalDirectory=publishPairJournal(candidate,capability);transitionObserver(phaseRunner,'migration_prepared');
  return await runBootstrapTransition({repositoryRoot,home,procRoot,environment,phaseRunner,phaseTimeoutMs,deployLease,admissionLease,journalDirectory,state,runtimeHandle,capability});
 }finally{runtimeHandle?.close();}
}
export async function rollbackLegacyMigration({repositoryRoot,home,current,anchor,deployLease,admissionLease,procRoot='/proc',environment=process.env,phaseRunner=wiringPhase,phaseTimeoutMs=45000}) {
 const runtime=path.join(repositoryRoot,'.jhw-runtime');let runtimeHandle;
 try{
  runtimeHandle=pinnedDirectory(runtime);const capability=prepareAtomicRename({directory:runtimeHandle});requireStoppedTransition(repositoryRoot,procRoot);
  if(current?.version!==2||current.predecessorActivationId!==null||current.activationId!==anchor.firstActivationId||current.migrationId!==anchor.migrationId)fail('DEPLOY_PREDECESSOR_INVALID');
  const owner=findCompletedBootstrapMigration({repositoryRoot,current});
  anchor=readMigrationAnchor({repositoryRoot,migrationId:current.migrationId,expectedRef:owner.anchor});
  if(!transitionEqual(owner.origin,anchor.preMigrationCurrent)||!transitionEqual(owner.destination,pairDestination(current)))fail('DEPLOY_PREDECESSOR_INVALID');
  verifyMigrationOriginal({repositoryRoot,anchor,name:anchor.previousDirectory});
  const destination=Object.fromEntries(Object.entries(anchor.legacyRollbackTarget).filter(([key])=>key!=='observation'));
  const state={version:2,kind:'bootstrap-migration',operation:'legacy-rollback',status:'pending',phase:'prepared',migrationId:anchor.migrationId,anchor:anchor.reference,
   origin:current,destination,witness:null,published:null,guard:null,router:{stageName:anchor.previousDirectory,previousDirectory:`.bootstrap.failed.${randomBytes(16).toString('hex')}`,
    stageProof:bootstrapObjectProof({repositoryRoot,name:anchor.previousDirectory}),previousProof:bootstrapObjectProof({repositoryRoot,name:'bootstrap'}),parkingDirectory:`.bootstrap.failed.${randomBytes(16).toString('hex')}`},outcome:null};
  const candidate=createPairJournalCandidate(repositoryRoot,state);
  state.witness=prepareTransitionPointer({repositoryRoot,journalDirectory:candidate.staging,origin:current,destination,deployLease});
  state.guard=prepareMigrationGuardRollback({repositoryRoot,journalDirectory:candidate.staging,anchor});
  createPrivateDirectory(candidate.staging,'validation');checkpoint(candidate.staging,state);
  const journalDirectory=publishPairJournal(candidate,capability);transitionObserver(phaseRunner,'migration_prepared');
  return await runBootstrapTransition({repositoryRoot,home,procRoot,environment,phaseRunner,phaseTimeoutMs,deployLease,admissionLease,journalDirectory,state,runtimeHandle,capability});
 }finally{runtimeHandle?.close();}
}
function initialFileProof(directory,name,limit=PREIMAGE_LIMIT) {
 const parent=pinnedDirectory(directory);let fd;
 try{
  const file=parent.at(name);fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const stat=fs.fstatSync(fd,{bigint:true});
  if(!stat.isFile()||stat.uid!==BigInt(process.getuid())||stat.nlink!==1n||(stat.mode&0o7777n)!==0o600n||stat.size>BigInt(limit))fail('DEPLOY_RECOVERY_REQUIRED','initial_wiring_unverified');
  const bytes=Buffer.alloc(Number(stat.size));let offset=0;
  while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)fail('DEPLOY_RECOVERY_REQUIRED','initial_wiring_unverified');offset+=count;}
  if(fs.readSync(fd,Buffer.alloc(1),0,1,null)!==0)fail('DEPLOY_RECOVERY_REQUIRED','initial_wiring_unverified');
  const final=fs.lstatSync(file,{bigint:true});
  if(['dev','ino','uid','mode','nlink','size','mtimeNs','ctimeNs'].some(key=>stat[key]!==final[key]||stat[key]!==fs.fstatSync(fd,{bigint:true})[key]))fail('DEPLOY_RECOVERY_REQUIRED','initial_wiring_unverified');
  parent.verify();return {dev:String(stat.dev),ino:String(stat.ino),uid:Number(stat.uid),mode:Number(stat.mode&0o7777n),nlink:1,mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs),sha256:createHash('sha256').update(bytes).digest('hex')};
 }finally{if(fd!==undefined)fs.closeSync(fd);parent.close();}
}
function initialWiringBinding(directory) {
 const stat=trustedDirectory(directory);
 return {name:path.basename(directory),directory:{dev:String(stat.dev),ino:String(stat.ino),uid:stat.uid,mode:stat.mode&0o7777},
  before:initialFileProof(directory,'before.json'),listings:initialFileProof(directory,'listings.json',LISTING_LIMIT)};
}
async function finishInitialInstallation(options) {
 const {repositoryRoot,home,procRoot,environment,phaseRunner,phaseTimeoutMs,deployLease,admissionLease,journalDirectory,state,runtimeHandle,capability,recover=false}=options;
 const runtime=path.join(repositoryRoot,'.jhw-runtime');const directory=path.join(journalDirectory,state.wiring.name);
 readRuntimeJournalV2({repositoryRoot,journalDirectory});
 if(!transitionEqual(initialWiringBinding(directory),state.wiring))fail('DEPLOY_RECOVERY_REQUIRED','initial_wiring_unverified');
 const wiringState=privateRead(path.join(directory,'state.json'));
 if(wiringState.version!==1||wiringState.operation!=='activate'||wiringState.previous!==null||wiringState.workerDetached||wiringState.stateIncomplete)fail('DEPLOY_RECOVERY_REQUIRED','initial_wiring_unverified');
 let admission=admissionLease;let publication;
 const pointerArgs={repositoryRoot,journalDirectory,origin:null,destination:state.destination,witness:state.witness};
 const checkpointPhase=phase=>{state.phase=phase;checkpoint(journalDirectory,state);transitionObserver(phaseRunner,`initial_${phase}`);};
 const move=async(sourceName,destinationName,expectedProof,event)=>{
  requireStoppedTransition(repositoryRoot,procRoot);await moveBootstrapObject({repositoryRoot,sourceName,destinationName,expectedProof,runtimeHandle,capability,deployLease,admissionLease:admission});transitionObserver(phaseRunner,event);
 };
 const proof=name=>transitionRootProof(repositoryRoot,name);const matches=(name,value)=>transitionEqual(proof(name),value);
 const run=async phase=>{wiringState.phase=phase;checkpoint(directory,wiringState);await phaseRunner({repositoryRoot,home,environment,phase,managed:true,deployLease,admissionLease:admission,
  directory,state:wiringState,phaseTimeoutMs,candidateReleaseId:state.candidate.releaseId,adoptFrom:state.adoptFrom??undefined});};
 const complete=outcome=>{
  wiringState.status='complete';wiringState.phase=outcome==='restored'?'wire_rolled_back':'complete';checkpoint(directory,wiringState);
  transitionObserver(phaseRunner,'initial_wiring_complete');
  state.status='complete';state.phase='complete';state.outcome=outcome;checkpoint(journalDirectory,state);recordDeploymentRetention({repositoryRoot,journalDirectory});
 };
 try{
  requireStoppedTransition(repositoryRoot,procRoot);
  let pointer=inspectTransitionPointer(pointerArgs);const router=state.router;
  if(recover&&pointer.location==='origin'){
   const boot=proof('bootstrap'),previous=proof(router.previousDirectory),stage=proof(router.stageName),park=proof(router.parkingDirectory);
   const untouched=transitionEqual(boot,router.previousProof)&&previous===null&&transitionEqual(stage,router.stageProof)&&park===null;
   const oldMoved=boot===null&&transitionEqual(previous,router.previousProof)&&transitionEqual(stage,router.stageProof)&&park===null;
   const published=transitionEqual(boot,router.stageProof)&&transitionEqual(previous,router.previousProof)&&stage===null&&park===null;
   const parked=boot===null&&transitionEqual(previous,router.previousProof)&&stage===null&&transitionEqual(park,router.stageProof);
   const restored=transitionEqual(boot,router.previousProof)&&previous===null&&stage===null&&transitionEqual(park,router.stageProof);
   if(![untouched,oldMoved,published,parked,restored].some(Boolean))fail('DEPLOY_RECOVERY_REQUIRED','initial_bootstrap_foreign');
   checkpointPhase('restore_intent');
   if(wiringState.phase!=='wire_rolled_back'){
    // The retained v1 worker sees only its original KEYS/phases.
    if(wiringState.phase!=='before_mutation')await run('rollback');
    if(!restoreFirstWiring({repositoryRoot,home,releaseId:state.candidate.releaseId,directory,adoptFrom:state.adoptFrom??undefined}))fail('DEPLOY_RECOVERY_REQUIRED','wire_rollback_failed');
   }
   if(published)await move('bootstrap',router.parkingDirectory,router.stageProof,'initial_router_parked');
   if(router.previousProof!==null&&(oldMoved||published||parked))await move(router.previousDirectory,'bootstrap',router.previousProof,'initial_original_restored');
   if(!matches('bootstrap',router.previousProof)||inspectTransitionPointer(pointerArgs).location!=='origin')fail('DEPLOY_RECOVERY_REQUIRED','initial_restore_unverified');
   complete('restored');return {code:'DEPLOY_ACTIVATION_RESTORED',releaseId:null,recovered:true,outcome:'restored'};
  }
  if(pointer.location==='origin'){
   wiringState.mutationStarted=true;checkpoint(directory,wiringState);
   checkpointPhase('router_intent');
   if(router.previousProof!==null)await move('bootstrap',router.previousDirectory,router.previousProof,'initial_original_moved');
   await move(router.stageName,'bootstrap',router.stageProof,'initial_router_renamed');
   checkpointPhase('wire_intent');
   try{await run('wire');}catch(error){
    if(wiringState.workerDetached||wiringState.stateIncomplete)throw error;
    await finishInitialInstallation({...options,recover:true});fail('DEPLOY_WIRING_FAILED','first_activation_rolled_back');
   }
   privateWrite(path.join(journalDirectory,'wiring-after.json'),wiringPreimages({repositoryRoot,home,releaseId:state.candidate.releaseId,adoptFrom:state.adoptFrom??undefined}),{exclusive:true});
   state.after=initialFileProof(journalDirectory,'wiring-after.json');checkpointPhase('wired');
   checkpointPhase('pointer_intent');publication=acquireLease(path.join(runtime,'publication.lock'),{create:true});
   try{state.published=publishTransitionPointer({...pointerArgs,publicationLease:publication,capability,runtimeHandle,observe:phase=>transitionObserver(phaseRunner,`initial_${phase}`)});}
   finally{publication.close();publication=undefined;}
   checkpointPhase('published');pointer={location:'destination',current:state.published};
  }
  if(state.published!==null&&!transitionEqual(pointer.current,state.published))fail('DEPLOY_CURRENT_CHANGED');
  state.published=pointer.current;
  if(state.after===null||!transitionEqual(initialFileProof(journalDirectory,'wiring-after.json'),state.after)||
    !transitionEqual(privateRead(path.join(journalDirectory,'wiring-after.json'),{limit:PREIMAGE_LIMIT}),wiringPreimages({repositoryRoot,home,releaseId:state.candidate.releaseId,adoptFrom:state.adoptFrom??undefined}))||
    !matches('bootstrap',router.stageProof)||!matches(router.stageName,null)||!matches(router.previousDirectory,router.previousProof)||!matches(router.parkingDirectory,null))fail('DEPLOY_RECOVERY_REQUIRED','initial_destination_unverified');
  checkpointPhase('validation');admission.close();admission=undefined;
  let validationError;try{await run('validate');}catch(error){validationError=error;}
  admission=acquireLease(path.join(runtime,'admission.lock'));requireStoppedTransition(repositoryRoot,procRoot);
  if(validationError)fail('DEPLOY_VALIDATION_FAILED','first_migration_recovery_required');
  if(!transitionEqual(inspectTransitionPointer(pointerArgs).current,state.published)||!matches('bootstrap',router.stageProof)||
    !transitionEqual(privateRead(path.join(journalDirectory,'wiring-after.json'),{limit:PREIMAGE_LIMIT}),wiringPreimages({repositoryRoot,home,releaseId:state.candidate.releaseId,adoptFrom:state.adoptFrom??undefined})))fail('DEPLOY_RECOVERY_REQUIRED','initial_destination_unverified');
  await run('finalize');privateWrite(path.join(runtime,'wiring.json'),{version:1,installed:true});complete('installed');
  return {code:'DEPLOY_ACTIVATED',previousReleaseId:null,releaseId:state.candidate.releaseId,predecessorAvailable:false,unprotected:wiringState.variables.INSTALL_UNPROTECTED==='1'};
 }finally{publication?.close();if(admission&&admission!==admissionLease)admission.close();}
}
async function runInitialPairInstallation(options) {
 const {repositoryRoot,home,releaseId,deployLease,admissionLease,adoptFrom=null}=options;let runtimeHandle;
 try{
  const observed=phase=>transitionObserver(options.phaseRunner,`initial_${phase}`);
  observed('prepare_start');
  const runtime=path.join(repositoryRoot,'.jhw-runtime');runtimeHandle=pinnedDirectory(runtime);const capability=prepareAtomicRename({directory:runtimeHandle});
  observed('capability_ready');
  const pair=ensureBootstrapGeneration({repositoryRoot,releaseId,deployLease});observed('generation_ready');
  const stage=await prepareRouterV2({repositoryRoot,releaseId,deployLease,admissionLease});observed('router_ready');
  const destination=preparePairActivation({repositoryRoot,pair,expectedCurrent:null,deployLease});observed('activation_ready');
  const state={version:2,kind:'initial-install',status:'pending',phase:'prepared',origin:null,candidate:pair,destination,witness:null,published:null,
   wiring:null,adoptFrom,after:null,router:{stageName:stage.stageName,stageProof:stage.proof,previousDirectory:`.bootstrap.previous.${randomBytes(16).toString('hex')}`,
    previousProof:transitionRootProof(repositoryRoot,'bootstrap'),parkingDirectory:`.bootstrap.failed.${randomBytes(16).toString('hex')}`},outcome:null};
  const candidate=createPairJournalCandidate(repositoryRoot,state),directory=createPrivateDirectory(candidate.staging,'wiring');
  checkpoint(directory,{version:1,status:'pending',operation:'activate',phase:'before_mutation',previous:null,variables:{}});
  privateWrite(path.join(directory,'before.json'),wiringPreimages({repositoryRoot,home,releaseId,adoptFrom:adoptFrom??undefined}),{exclusive:true});
  privateWrite(path.join(directory,'listings.json'),wiringListings(home),{exclusive:true});
  state.wiring=initialWiringBinding(directory);observed('wiring_ready');
  state.witness=prepareTransitionPointer({repositoryRoot,journalDirectory:candidate.staging,origin:null,destination,deployLease});
  checkpoint(candidate.staging,state);observed('candidate_ready');
  const journalDirectory=publishPairJournal(candidate,capability);observed('prepared');
  return await finishInitialInstallation({...options,state,journalDirectory,runtimeHandle,capability});
 }finally{runtimeHandle?.close();}
}
async function recoverInitialInstallation(options,releaseId) {
 const {repositoryRoot}=options;const runtime=path.join(repositoryRoot,'.jhw-runtime');let writer;let admission;let runtimeHandle;
 try{
  requireStoppedTransition(repositoryRoot,options.procRoot);writer=acquireLease(path.join(runtime,'deploy.lock'));admission=acquireLease(path.join(runtime,'admission.lock'));requireStoppedTransition(repositoryRoot,options.procRoot);
  const journals=pendingRuntimeJournals(repositoryRoot);
  if(journals.length!==1||journals[0].kind!=='initial-install')fail('DEPLOY_RECOVERY_REQUIRED','initial_owner_mismatch');
  const journalDirectory=path.join(runtime,'v2/journals',journals[0].name);const state=readRuntimeJournalV2({repositoryRoot,journalDirectory}).state;
  if(state.candidate.releaseId!==releaseId||pending(runtime).length)fail('DEPLOY_RECOVERY_REQUIRED','initial_owner_mismatch');
  runtimeHandle=pinnedDirectory(runtime);const capability=prepareAtomicRename({directory:runtimeHandle});
  return await finishInitialInstallation({...options,deployLease:writer,admissionLease:admission,state,journalDirectory,recover:true,runtimeHandle,capability});
 }finally{runtimeHandle?.close();admission?.close();writer?.close();}
}

async function recoverBootstrapTransition(options,operation) {
 const {repositoryRoot}=options;const runtime=path.join(repositoryRoot,'.jhw-runtime');let writer;let admission;let runtimeHandle;
 try{
  requireStoppedTransition(repositoryRoot,options.procRoot);writer=acquireLease(path.join(runtime,'deploy.lock'));admission=acquireLease(path.join(runtime,'admission.lock'));
  requireStoppedTransition(repositoryRoot,options.procRoot);if(pending(runtime).length)fail('DEPLOY_RECOVERY_REQUIRED','deployment_journal_pending');
  const pendingV2=pendingRuntimeJournals(repositoryRoot);
  if(pendingV2.length!==1||pendingV2[0].kind!=='bootstrap-migration')fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_pending');
  const journalDirectory=path.join(runtime,'v2/journals',pendingV2[0].name);const state=readRuntimeJournalV2({repositoryRoot,journalDirectory}).state;
  if(state.operation!==operation)fail('DEPLOY_RECOVERY_REQUIRED','migration_owner_mismatch');
  runtimeHandle=pinnedDirectory(runtime);const capability=prepareAtomicRename({directory:runtimeHandle});
  return await runBootstrapTransition({...options,deployLease:writer,admissionLease:admission,journalDirectory,state,recover:true,runtimeHandle,capability});
 }finally{runtimeHandle?.close();admission?.close();writer?.close();}
}

/** Module-only fixtures may supply private procRoot/build/phaseRunner. Public
 * argv and environment have no gate bypass, lock-fd, or alternate-root option. */
export async function runDeployment({repositoryRoot,home=process.env.HOME,argv=[],procRoot='/proc',build,environment=process.env,phaseRunner=wiringPhase,phaseTimeoutMs=45000,planTimeoutMs=45000,managedScope=null}={}) {
 const command=parse(argv);
 if([phaseTimeoutMs,planTimeoutMs].some(value=>!Number.isInteger(value)||value<1||value>45000))fail('DEPLOY_ARGUMENTS_INVALID');
 if(command.operation==='help'||command.operation==='h'){
  if(managedScope!==null){
   requireManagedScope(managedScope,repositoryRoot);
   return {code:'DEPLOY_USAGE',commands:['--prepare','--status','--activate-compatible RELEASE_ID','--rollback','--prune','--prune --apply']};
  }
  return {code:'DEPLOY_USAGE',commands:['--prepare','--status','--activate-compatible RELEASE_ID','--activate RELEASE_ID','--activate RELEASE_ID --adopt-from LEGACY_CHECKOUT','--activate RELEASE_ID --guard-observe','--rollback','--uninstall','--refresh-bootstrap','--migrate-codex-config','--prune','--prune --apply']};
 }
 if(typeof repositoryRoot!=='string'||!path.isAbsolute(repositoryRoot)||typeof home!=='string'||!path.isAbsolute(home))fail('DEPLOY_ARGUMENTS_INVALID');
 const inventoryOptions={repositoryRoot,procRoot,excludePids:[process.pid]};
 const runtime=path.join(repositoryRoot,'.jhw-runtime');
 const administrativeRead=command.operation==='status'||(command.operation==='prune'&&!command.apply);
 if(managedScope!==null){
  requireManagedScope(managedScope,repositoryRoot);
  if(home!==managedScope.home||!['prepare','status','activate-compatible','rollback','prune'].includes(command.operation))
   fail('DEPLOY_MANAGED_MODE_REQUIRED');
  if(readActivation({repositoryRoot})?.version!==2)fail('DEPLOY_COMPATIBILITY_MISMATCH','v2_current_required');
 }else if(!administrativeRead&&command.operation!=='prepare'&&hasManagedInvocationStore(repositoryRoot))
  fail('DEPLOY_MANAGED_MODE_REQUIRED');
 if(exists(runtime)&&!['status','migrate-codex-config','prune'].includes(command.operation)) {
  const pendingV2=pendingRuntimeJournals(repositoryRoot);
  if(command.operation==='activate'&&pendingV2.length===1&&pendingV2[0].kind==='initial-install')return recoverInitialInstallation({repositoryRoot,home,procRoot,environment,phaseRunner,phaseTimeoutMs},command.releaseId);
  const pairRecoveryOwner=['activate-compatible','rollback'].includes(command.operation)&&pendingV2.length>0&&pendingV2.every(item=>item.kind==='pair');
  const bootstrapRecoveryOwner=managedScope===null&&['refresh-bootstrap','rollback'].includes(command.operation)&&pendingV2.length===1&&pendingV2[0].kind==='bootstrap-migration';
  if(bootstrapRecoveryOwner)return recoverBootstrapTransition({repositoryRoot,home,procRoot,environment,phaseRunner,phaseTimeoutMs},command.operation==='refresh-bootstrap'?'upgrade':'legacy-rollback');
  if(pendingV2.length&&!pairRecoveryOwner&&!bootstrapRecoveryOwner)fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_pending');
 }
 if(command.operation==='migrate-codex-config') {
  const before=requireQuiescence(inventoryOptions);let writer;let admission;
  try {
   writer=acquireLease(path.join(runtime,'deploy.lock'));admission=acquireLease(path.join(runtime,'admission.lock'));
   const after=requireQuiescence(inventoryOptions);if(pending(runtime).length)fail('DEPLOY_RECOVERY_REQUIRED','deployment_journal_pending');const current=readActivation({repositoryRoot});
   const result=await runCodexConfigMigration({repositoryRoot,home,current,deployLease:writer,admissionLease:admission,environment});
   return {...result,inventory:{before,after}};
  } finally {admission?.close();writer?.close();}
 }
 if(command.operation==='prune'&&exists(runtime)&&pendingPairJournalCount(repositoryRoot)>0)fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_pending');
 if(command.operation==='prune'&&!command.apply)return planRuntimePrune({repositoryRoot});
 if(command.operation==='prune') {
  const preparedPlan=prepareRuntimePrune({repositoryRoot});
  const {hasGenerations,hasLegacy,livePath:ordinaryLivePath}=pruneExecutionRoute(preparedPlan.plan);
  if(managedScope!==null&&hasLegacy)fail('DEPLOY_PRUNE_BLOCKED','managed_legacy_prune_requires_offline');
  const livePath=managedScope!==null||ordinaryLivePath;
  let pruneWriter;let pruneAdmission;let prunePublication;let evidence;
  try {
   let retainedEvidence;let scanInventory;let before;
   if(livePath){
    const snapshot=pairRows(repositoryRoot);
    const current=readActivation({repositoryRoot});
    const preparedInventory=managedScope!==null||supportsPreparedPruneInventory(current,snapshot);
    if(current?.version===2){
     evidence=preparePruneReleaseEvidence(repositoryRoot,current,snapshot.roots);
     const prepared=preparePrunePublicationEvidence({repositoryRoot,evidence,current,roots:snapshot.roots});
     retainedEvidence={evidence,prepared};
    }
    scanInventory=preparedInventory
      ?(next=pairRows(repositoryRoot))=>completeRetainedPruneInventory(
        {repositoryRoot,procRoot,managedScope},next,snapshot.roots,retainedEvidence)
      :next=>completePairInventory({repositoryRoot,procRoot},next);
    before=scanInventory(snapshot);
   }else{
    scanInventory=()=>requireQuiescence(inventoryOptions);
    before=scanInventory();
   }
   pruneWriter=acquireLease(path.join(runtime,'deploy.lock'),{create:true});
   if(managedScope===null&&hasManagedInvocationStore(repositoryRoot))fail('DEPLOY_MANAGED_MODE_REQUIRED');
   const now=Date.now();
   if(!livePath)pruneAdmission=acquireLease(path.join(runtime,'admission.lock'),{create:true});
   if(hasGenerations||managedScope!==null)prunePublication=acquireLease(path.join(runtime,'publication.lock'),{create:true});
   const after=scanInventory();
   if(livePath)requirePreparedRootMembership(before.roots,after.roots);
   const result=applyRuntimePrune({repositoryRoot,now,preparedPlan,retainedEvidence,managedScope,
    deployLease:pruneWriter,admissionLease:pruneAdmission,publicationLease:prunePublication});
   return {...result,inventory:{before,after}};
  } finally {prunePublication?.close();pruneAdmission?.close();pruneWriter?.close();evidence?.close();}
 }
 if(command.operation==='activate-compatible') {
  const current=exists(runtime)?readActivation({repositoryRoot}):null;
  if(current?.version===2)return runCompatiblePairDeployment({repositoryRoot,home,procRoot,environment,releaseId:command.releaseId,rollback:false,phaseRunner,phaseTimeoutMs,managedScope});
  return runCompatibleDeployment({repositoryRoot,home,procRoot,environment,releaseId:command.releaseId,phaseRunner,phaseTimeoutMs});
 }
 if(command.operation==='status') {
  const inventory=managedScope===null?inspectConsumers(inventoryOptions):
   deploymentProcessInventory({repositoryRoot,roots:pairRows(repositoryRoot).roots,managedScope});
  const current=exists(runtime)?readActivation({repositoryRoot}):null;
  return {code:'DEPLOY_STATUS',advisory:true,releaseId:current?.releaseId??null,predecessorAvailable:current?.predecessorActivationId!==null&&current!==null,recoveryPending:pending(runtime).length+pendingPairJournalCount(repositoryRoot),inventory};
 }
 if(command.operation==='default'&&existingInstallation(repositoryRoot,home))return {code:'DEPLOY_EXPLICIT_ACTIVATION_REQUIRED',next:['--prepare','--activate RELEASE_ID']};
 if(command.operation==='prepare')return {code:'DEPLOY_PREPARED',...await prepareRelease({repositoryRoot,build})};
 if(command.operation==='default'){const release=await prepareRelease({repositoryRoot,build});command.operation='activate';command.releaseId=release.releaseId;}
 if(command.operation==='refresh-bootstrap'&&exists(runtime)){
  const current=readActivation({repositoryRoot});
  if(current?.version===2&&pendingPairJournalCount(repositoryRoot)===0){
   let refreshWriter;let evidence;
   try {
    refreshWriter=acquireLease(path.join(runtime,'deploy.lock'));
    if(pending(runtime).length)fail('DEPLOY_RECOVERY_REQUIRED','deployment_journal_pending');
    if(pendingRuntimeJournals(repositoryRoot).length)fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_pending');
    if(!sameJson(readActivation({repositoryRoot}),current))fail('DEPLOY_CURRENT_CHANGED');
    const router=validateBootstrap({repositoryRoot});if(router.version!==2)fail('DEPLOY_BOOTSTRAP_INVALID');
    evidence=prepareRuntimeEvidence({repositoryRoot,pairs:[pairOf(current)]});
    if(!sameJson(readActivation({repositoryRoot}),current))fail('DEPLOY_CURRENT_CHANGED');
    return {code:'DEPLOY_BOOTSTRAP_REFRESHED',releaseId:current.releaseId,unchanged:true,
     bootstrap:{from:router.sourceReleaseId,to:router.sourceReleaseId,previousDirectory:null}};
   } finally {evidence?.close();refreshWriter?.close();}
  }

  if(current&&current.version!==2&&releaseRuntimeGeneration({repositoryRoot,releaseId:current.releaseId})===2){const before=requireQuiescence(inventoryOptions);let migrationWriter;let migrationAdmission;
   try{migrationWriter=acquireLease(path.join(runtime,'deploy.lock'));migrationAdmission=acquireLease(path.join(runtime,'admission.lock'));
    const after=requireQuiescence(inventoryOptions);if(pending(runtime).length)fail('DEPLOY_RECOVERY_REQUIRED','deployment_journal_pending');
    const result=await runBootstrapMigration({repositoryRoot,home,current,deployLease:migrationWriter,admissionLease:migrationAdmission,procRoot,environment,phaseRunner,phaseTimeoutMs});return {...result,inventory:{before,after}};
   }finally{migrationAdmission?.close();migrationWriter?.close();}}
 }
 if(command.operation==='rollback'&&exists(runtime)){
  const current=readActivation({repositoryRoot});
  if(managedScope===null&&current?.version===2&&current.predecessorActivationId===null&&current.migrationId){const before=requireQuiescence(inventoryOptions);let rollbackWriter;let rollbackAdmission;
   try{rollbackWriter=acquireLease(path.join(runtime,'deploy.lock'));rollbackAdmission=acquireLease(path.join(runtime,'admission.lock'));const after=requireQuiescence(inventoryOptions);
    if(pairRows(repositoryRoot).roots.length)fail('DEPLOY_CONSUMERS_ACTIVE','stopped_rollback_required');
    const owner=findCompletedBootstrapMigration({repositoryRoot,current});
    const anchor=readMigrationAnchor({repositoryRoot,migrationId:current.migrationId,expectedRef:owner.anchor});const result=await rollbackLegacyMigration({repositoryRoot,home,current,anchor,deployLease:rollbackWriter,admissionLease:rollbackAdmission,procRoot,environment,phaseRunner,phaseTimeoutMs});
    return {...result,inventory:{before,after}};
   }finally{rollbackAdmission?.close();rollbackWriter?.close();}}
  if(current?.version===2)return runCompatiblePairDeployment({repositoryRoot,home,procRoot,environment,rollback:true,phaseRunner,phaseTimeoutMs,managedScope});
 }
 if(exists(runtime)&&pendingPairJournalCount(repositoryRoot)>0)fail('DEPLOY_RECOVERY_REQUIRED','pair_journal_pending');
 if(command.adoptFrom){
  validateAdoptSource(repositoryRoot,command.adoptFrom);
  if(hasManagedInvocationStore(command.adoptFrom))fail('DEPLOY_MANAGED_MODE_REQUIRED');
 }
 // Adoption also requires the legacy checkout to have no consumers.
 const quiesce=()=>{const result=requireQuiescence(inventoryOptions);if(command.adoptFrom)requireQuiescence({...inventoryOptions,repositoryRoot:command.adoptFrom});return result;};
 const before=quiesce(); // Before any shared mutation.
 prepareStore(repositoryRoot);
 let writer;let admission;let directory;let state;
 try {
  writer=acquireLease(path.join(runtime,'deploy.lock'),{create:true});
  if(hasManagedInvocationStore(repositoryRoot))fail('DEPLOY_MANAGED_MODE_REQUIRED');
  admission=acquireLease(path.join(runtime,'admission.lock'),{create:true});
  const after=quiesce();
  const previous=readActivation({repositoryRoot});
  const abandoned=pending(runtime);
  let recovery;let guardRecovery;
  if(abandoned.length) {
   if(!['rollback','refresh-bootstrap'].includes(command.operation)||abandoned.length!==1)fail('DEPLOY_RECOVERY_REQUIRED');
   const recoveryDirectory=path.join(runtime,abandoned[0]);const prior=privateRead(path.join(recoveryDirectory,'state.json'));
   const guard=readGuardTransitionEvidence({journalDirectory:recoveryDirectory});
   if(guard) {
    if(command.operation!=='rollback'||prior.stateIncomplete||prior.workerDetached)fail('DEPLOY_RECOVERY_REQUIRED','guard_recovery_unverified');
    if(guard.direction==='forward') {
     if(prior.operation!=='activate'||!['published-recorded','destination-bound'].includes(guard.status)||JSON.stringify(prior.previous)!==JSON.stringify(guard.origin))fail('DEPLOY_RECOVERY_REQUIRED','guard_recovery_unverified');
     const atOrigin=JSON.stringify(previous)===JSON.stringify(guard.origin);
     const atDestination=guard.destination_activation_id===previous?.activationId&&previous.releaseId===guard.candidate_release_id&&previous.predecessorActivationId===guard.origin.activationId;
     if(!atOrigin&&!atDestination)fail('DEPLOY_RECOVERY_REQUIRED','guard_recovery_unverified');
     validateRelease({repositoryRoot,releaseId:guard.candidate_release_id});
    } else {
     if(prior.operation!=='rollback'||![guard.source_activation_id,guard.destination_activation_id].includes(previous?.activationId))fail('DEPLOY_RECOVERY_REQUIRED','guard_recovery_unverified');
    }
    guardRecovery={directory:recoveryDirectory,state:prior,evidence:guard};
   }
   if(!guardRecovery) {
   // An interrupted refresh never moved the pointer or wiring; only a retried
   // refresh supersedes it, and only while current is still its origin.
   if(command.operation==='refresh-bootstrap'&&(prior.operation!=='refresh-bootstrap'||JSON.stringify(prior.previous)!==JSON.stringify(previous)))fail('DEPLOY_RECOVERY_REQUIRED');
   if(command.operation==='rollback'&&prior.operation==='refresh-bootstrap')fail('DEPLOY_RECOVERY_REQUIRED');
   if(command.operation==='refresh-bootstrap')recovery={directory:recoveryDirectory,state:prior};
   else {
   if(!prior.previous)fail('DEPLOY_PREDECESSOR_INVALID');
   const destination=prior.destination;
   const validDestination=destination && Object.keys(destination).sort().join(',')==='activationId,predecessorActivationId,releaseId' &&
     /^a-[a-f0-9]{32}$/.test(destination.activationId) && RELEASE.test(destination.releaseId) &&
     (destination.predecessorActivationId===null || /^a-[a-f0-9]{32}$/.test(destination.predecessorActivationId));
   const atOrigin=JSON.stringify(previous)===JSON.stringify(prior.previous);
   const atDestination=validDestination && previous?.activationId===destination.activationId && previous.releaseId===destination.releaseId && previous.predecessorActivationId===destination.predecessorActivationId;
   if(prior.phase==='pointer_intent' && validDestination && (atOrigin || atDestination)) {
    if(atOrigin || prior.operation==='rollback') {
     prior.status='complete';prior.phase='complete';prior.recovery=atOrigin?'pointer_not_published':'pointer_published';checkpoint(recoveryDirectory,prior);
     if(prior.operation==='activate' || atDestination) return {code:'DEPLOY_ROLLED_BACK',previousReleaseId:previous?.releaseId??null,releaseId:previous?.releaseId??null,predecessorAvailable:previous?.predecessorActivationId!==null&&previous!==null,inventory:{before,after},unprotected:false};
    } else recovery={directory:recoveryDirectory,state:prior};
   } else {
    if(prior.operation!=='activate'||!['validation_failed','recovery_blocked','validate','finalize'].includes(prior.phase)||JSON.stringify(prior.current)!==JSON.stringify(previous)||previous?.predecessorActivationId!==prior.previous.activationId)fail('DEPLOY_RECOVERY_REQUIRED');
    recovery={directory:recoveryDirectory,state:prior};
   }
   }
  }
  }
  const wiringFile=path.join(runtime,'wiring.json');
  const wiringPreviouslyInstalled = exists(wiringFile) && privateRead(wiringFile).installed === true;
  let managed = wiringPreviouslyInstalled;
  if(command.adoptFrom&&managed)fail('DEPLOY_ARGUMENTS_INVALID','adopt_requires_first_activation');
  if(command.guardObserve&&!managed)fail('DEPLOY_ARGUMENTS_INVALID','guard_requires_managed_activation');
  const guardPolicy=managed?readGuardHostPolicy({home}):'absent';
  const enableGuard=command.operation==='activate'&&command.guardObserve&&guardPolicy==='absent';
  let resultGuardMode=guardPolicy==='observe'?'observe':undefined;
  const rollbackGuard=command.operation==='rollback'&&!guardRecovery&&previous
   ?findGuardTransitionEvidence({runtimeRoot:runtime,activationId:previous.activationId}):null;
  if(rollbackGuard&&rollbackGuard.evidence.origin.activationId!==previous.predecessorActivationId)fail('DEPLOY_RECOVERY_REQUIRED','guard_rollback_coordinates');
  let guardForward;

  if(recovery&&!managed)fail('DEPLOY_RECOVERY_REQUIRED');
  if(command.operation==='activate')validateRelease({repositoryRoot,releaseId:command.releaseId});
  if(command.operation==='rollback'&&!previous?.predecessorActivationId&&!guardRecovery)fail('DEPLOY_PREDECESSOR_INVALID');
  // A missing bootstrap (interrupted replacement) is reinstalled; an invalid one refuses.
  // A retried refresh restores the set that was live before the first attempt,
  // never whatever the interrupted attempt left behind.
  let originalBootstrap=null;
  if(command.operation==='refresh-bootstrap') {
   if(!managed||!previous)fail('DEPLOY_ARGUMENTS_INVALID','refresh_requires_managed_activation');
   requireMatchingInstaller(repositoryRoot,previous.releaseId);
   const live=exists(path.join(runtime,'bootstrap'))?validateBootstrap({repositoryRoot}):null;
   if(recovery?.state.bootstrap) {
    const inherited=recovery.state.bootstrap.prior;
    if(inherited!==null&&!(inherited&&typeof inherited==='object'&&RELEASE.test(inherited.sourceReleaseId??'')))fail('DEPLOY_RECOVERY_REQUIRED');
    originalBootstrap=inherited;
   } else originalBootstrap=live;
  }
  // First managed activation: refuse foreign wiring destinations before any mutation.
  if(command.operation==='activate'&&!managed)await planWiring({repositoryRoot,home,environment,releaseId:command.releaseId,planTimeoutMs,adoptFrom:command.adoptFrom});
  // A new v2 install publishes its worker evidence and recovery owner together.
  // Unpublished preparation must never create a separate public v1 pending owner.
  if(!managed&&previous===null&&command.operation==='activate'&&releaseRuntimeGeneration({repositoryRoot,releaseId:command.releaseId})===2){
   return {...await runInitialPairInstallation({repositoryRoot,home,procRoot,environment,phaseRunner,phaseTimeoutMs,releaseId:command.releaseId,deployLease:writer,admissionLease:admission,adoptFrom:command.adoptFrom}),inventory:{before,after}};
  }
  // An explicit retry continues the same strict reverse intent. Creating another
  // pending journal would turn a second interruption into ambiguous recovery.
  const resumeGuardReverse=guardRecovery?.evidence.direction==='reverse';
  directory=resumeGuardReverse?guardRecovery.directory:createPrivateDirectory(runtime,`.deploy.${randomBytes(16).toString('hex')}`);
  state=resumeGuardReverse?guardRecovery.state:{version:1,status:'pending',operation:command.operation,phase:'before_mutation',previous,variables:{}};
  if(command.operation==='refresh-bootstrap') {
   state.bootstrap={prior:originalBootstrap,from:originalBootstrap?.sourceReleaseId??null,to:null,previousDirectory:null};
   // The inherited obligation keeps this journal pending even when the retry is
   // refused. It is written before the interrupted journal closes, so a crash in
   // between leaves two pending journals and fails closed.
   if(recovery){state.mutationStarted=true;state.supersedes=path.basename(recovery.directory);}
  }
  checkpoint(directory,state);
  if(recovery&&command.operation==='refresh-bootstrap'){recovery.state.status='complete';recovery.state.recovery='superseded_by_refresh';checkpoint(recovery.directory,recovery.state);recovery=undefined;}
  const run=async (phase,candidateReleaseId,guardTransition)=>{state.phase=phase;checkpoint(directory,state);return await phaseRunner({repositoryRoot,home,environment,phase,managed,deployLease:writer,admissionLease:admission,directory,state,phaseTimeoutMs,candidateReleaseId,adoptFrom:command.adoptFrom,guardTransition});};
  const pointerIntent=destination=>{if(guardForward)guardForward=recordGuardDestination({journalDirectory:directory,destinationActivationId:destination.activationId});state.destination=destination;state.phase='pointer_intent';checkpoint(directory,state);};
  // Validation runs with admission released, so one sample can still see a probe
  // holding its shared lease or an unrelated process starting or exiting. Only
  // those two refusals are sampled again, and never a sample that counted a
  // consumer: an active consumer is not waited out. A final refusal keeps its
  // code and inventory in the journal.
  const reacquire=async()=>{
   for(let attempt=1;;attempt++) {
    try {admission??=acquireLease(path.join(runtime,'admission.lock'));quiesce();return;}
    catch(error) {
     const sawConsumer=Object.values(error?.inventory?.counts??{}).some(count=>count>0);
     if(attempt<REACQUIRE_ATTEMPTS&&REACQUIRE_RETRIED.includes(error?.code)&&!sawConsumer){await new Promise(resolve=>setTimeout(resolve,REACQUIRE_INTERVAL_MS));continue;}
     state.phase='recovery_blocked';state.reacquisition={code:error instanceof DeploymentError?error.code:'DEPLOY_FAILED',attempts:attempt,inventory:error?.inventory??null};checkpoint(directory,state);
     fail('DEPLOY_RECOVERY_REQUIRED','maintenance_reacquisition_failed');
    }
   }
  };
  let current=previous;
  if(managed&&command.operation!=='uninstall'&&!guardRecovery) {
   await run('verify');
   if(command.operation!=='refresh-bootstrap')requireCompatibleWiringTopology({repositoryRoot,home,previous,command});
  }
  if(command.operation==='activate'&&managed&&(enableGuard||guardPolicy==='observe')) {
   await planWiring({repositoryRoot,home,environment,releaseId:command.releaseId,planTimeoutMs,guardPolicy});
  }
  if(enableGuard) {
   guardForward=captureGuardTransitionEvidence({home,repositoryRoot,candidateReleaseId:command.releaseId,origin:previous});
   writeGuardTransitionEvidence({journalDirectory:directory,evidence:guardForward});
  }
  if(rollbackGuard)prepareGuardRollbackEvidence({forwardJournalDirectory:rollbackGuard.journalDirectory,rollbackJournalDirectory:directory,sourceActivationId:previous.activationId,destinationActivationId:rollbackGuard.evidence.origin.activationId});
  if(guardRecovery?.evidence.direction==='forward')prepareIncompleteGuardRollbackEvidence({forwardJournalDirectory:guardRecovery.directory,rollbackJournalDirectory:directory,sourceActivationId:previous.activationId});
  if(!managed||command.operation==='uninstall')privateWrite(path.join(directory,'before.json'),wiringPreimages({repositoryRoot,home,releaseId:command.releaseId??previous?.releaseId,adoptFrom:command.adoptFrom}),{exclusive:true});
  if(!managed&&command.operation==='activate')privateWrite(path.join(directory,'listings.json'),wiringListings(home),{exclusive:true});
  if(command.operation==='uninstall') {
   state.mutationStarted=true;checkpoint(directory,state);
   if(previous){validateBootstrap({repositoryRoot});managed=true;}
   await run('uninstall');privateWrite(wiringFile,{version:1,installed:false});
  } else if(command.operation==='refresh-bootstrap') {
   // Reinstalls the current release's helper set without moving the pointer or
   // wiring. A failed live validation reinstalls the original set from its own
   // retained source release. The journal completes only when the live set is
   // proven to be the validated new set or the original set; otherwise it stays
   // pending so every other operation remains refused.
   const settle=(phase,code,reason)=>{state.status='complete';state.phase=phase;checkpoint(directory,state);fail(code,reason);};
   const hold=(phase,reason)=>{state.phase=phase;checkpoint(directory,state);fail('DEPLOY_RECOVERY_REQUIRED',reason);};
   const liveIsOriginal=()=>{try{return originalBootstrap!==null&&JSON.stringify(validateBootstrap({repositoryRoot}))===JSON.stringify(originalBootstrap);}catch{return false;}};
   state.mutationStarted=true;checkpoint(directory,state);
   let installed;
   try {installed=await installBootstrap({repositoryRoot,releaseId:previous.releaseId});}
   catch(error) {
    if(liveIsOriginal())settle('bootstrap_install_failed',error.code&&/^DEPLOY_[A-Z_]+$/.test(error.code)?error.code:'DEPLOY_BOOTSTRAP_INVALID','bootstrap_install_failed');
    hold('bootstrap_install_failed','bootstrap_install_unverified');
   }
   state.bootstrap.to=installed.manifest.sourceReleaseId;state.bootstrap.previousDirectory=installed.previousDirectory;state.phase='bootstrap_installed';checkpoint(directory,state);
   admission.close();
   admission=undefined;
   let validationError;
   try {await run('validate');} catch(error) {validationError=error;}
   await reacquire();
   if(validationError) {
    if(liveIsOriginal())settle('validation_failed','DEPLOY_VALIDATION_FAILED','bootstrap_unchanged');
    if(originalBootstrap===null)hold('validation_failed','bootstrap_unverified');
    try {
     const restored=await installBootstrap({repositoryRoot,releaseId:originalBootstrap.sourceReleaseId});
     if(JSON.stringify(restored.manifest)!==JSON.stringify(originalBootstrap))fail('DEPLOY_BOOTSTRAP_CHANGED');
     state.bootstrap.failedDirectory=restored.previousDirectory;
    } catch {hold('bootstrap_restore_failed','bootstrap_restore_failed');}
    settle('validation_failed','DEPLOY_VALIDATION_FAILED','bootstrap_restored');
   }
   if(JSON.stringify(readActivation({repositoryRoot}))!==JSON.stringify(current))fail('DEPLOY_CURRENT_CHANGED');
   await run('finalize');
  } else {
   state.mutationStarted=true;checkpoint(directory,state);
   // Undoes a first-activation wire from its preimages; always throws.
   const undoFirstWiring=async()=>{
    let restored=false;
    if(!state.stateIncomplete&&!state.workerDetached) {
     try {await run('rollback',command.releaseId);restored=restoreFirstWiring({repositoryRoot,home,releaseId:command.releaseId,directory,adoptFrom:command.adoptFrom});}catch{restored=false;}
    }
    if(restored){state.status='complete';state.phase='wire_rolled_back';checkpoint(directory,state);fail('DEPLOY_WIRING_FAILED','first_activation_rolled_back');}
    state.phase='wire_rollback_failed';checkpoint(directory,state);fail('DEPLOY_RECOVERY_REQUIRED','wire_rollback_failed');
   };
   let guardRollbackDestination;
   if(rollbackGuard||guardRecovery) {
    const evidence=readGuardTransitionEvidence({journalDirectory:directory});
    guardRollbackDestination=evidence.destination_activation_id;
    if(guardRecovery?.evidence.direction==='forward') {
     const forward=guardRecovery.evidence;
     const transactionPaths=[forward.policy_context?.directory,guardRecovery.state.variables?.HOOKS_TRANSACTION_DIR,guardRecovery.state.variables?.CLAUDE_HOOKS_TRANSACTION_DIR].filter(Boolean);
     const remaining=transactionPaths.filter(exists);
     if(remaining.length) {
      if(remaining.length!==transactionPaths.length||!forward.policy_context)fail('DEPLOY_RECOVERY_REQUIRED','guard_context_unverified');
      state.variables={...guardRecovery.state.variables};checkpoint(directory,state);
      await run('rollback',forward.candidate_release_id,{action:'rollback',context:forward.policy_context});
     }
    }
    restoreGuardRollbackEvidence({home,journalDirectory:directory});
    resultGuardMode=undefined;
   }
   const guardPreimagesMatch=()=>guardForward?.entries.every(entry=>withEntry(home,entry.path,(_parent,view)=>
    matchesPreimage(view,entry.preimage)&&(view.type!=='file'||view.info.uid===process.getuid()&&(view.info.mode&0o7022)===0)));
   const undoGuardWiring=async()=>{
    let restored=false;
    if(!state.stateIncomplete&&!state.workerDetached) {
     try {
      if(guardForward.policy_context)await run('rollback',command.releaseId,{action:'rollback',context:guardForward.policy_context});
      await run('verify',command.releaseId);await run('verify');
      restored=guardPreimagesMatch();
     } catch {restored=false;}
    }
    if(restored){state.status='complete';state.phase='wire_rolled_back';checkpoint(directory,state);fail('DEPLOY_WIRING_FAILED','guard_activation_rolled_back');}
    fail('DEPLOY_RECOVERY_REQUIRED','guard_wire_unverified');
   };
   let firstWired=false;
   if(command.operation==='activate') {
    if(!managed) {
     // First managed activation wires before publication, so a refused wire
     // is undone from before.json and never leaves a published pointer.
     await installBootstrap({repositoryRoot,releaseId:command.releaseId});
     managed=true;
     try {await run('wire',command.releaseId);}catch{await undoFirstWiring();}
     firstWired=true;
    } else validateBootstrap({repositoryRoot});
   }
   if(enableGuard) {
    try {
     const wire=await run('wire',command.releaseId,{action:'begin'});
     guardForward=recordGuardPolicyContext({journalDirectory:directory,context:wire?.guardPolicyContext});
     guardForward=recordGuardPublishedSnapshots({home,journalDirectory:directory});
    } catch {await undoGuardWiring();}
   }
   try {
    if(firstWired){state.phase='wired';checkpoint(directory,state);}
    if(command.operation==='activate')current=publishActivation({repositoryRoot,releaseId:command.releaseId,expectedCurrent:previous,onPointerIntent:pointerIntent});
    else {validateBootstrap({repositoryRoot});if(guardRollbackDestination===previous?.activationId){current=previous;pointerIntent({activationId:previous.activationId,releaseId:previous.releaseId,predecessorActivationId:previous.predecessorActivationId});}else current=rollbackActivation({repositoryRoot,expectedCurrent:previous,onPointerIntent:pointerIntent});if(guardRollbackDestination&&current.activationId!==guardRollbackDestination)fail('DEPLOY_CURRENT_CHANGED');}
    state.current=current;checkpoint(directory,state);
   } catch(error) {
    if(guardForward) {
     let pointer;try{pointer=readActivation({repositoryRoot});}catch{}
     if(pointer&&JSON.stringify(pointer)===JSON.stringify(previous))await undoGuardWiring();
     fail('DEPLOY_RECOVERY_REQUIRED','guard_publication_uncertain');
    }
    if(!firstWired)throw error;
    // Publication after a completed first wire failed. Only a pointer proven
    // still at the origin makes the wired HOME safe to undo; otherwise the new
    // wiring may already be live, so nothing is guessed or restored.
    let pointer;try{pointer=readActivation({repositoryRoot});}catch{pointer=undefined;}
    if(pointer!==undefined&&JSON.stringify(pointer)===JSON.stringify(previous)){
     await undoFirstWiring();
    }
    state.phase='publication_uncertain';try{checkpoint(directory,state);}catch{}
    fail('DEPLOY_RECOVERY_REQUIRED','publication_uncertain');
   }
   if(guardRollbackDestination)await run('verify');
   if (!managed) {
    managed = true;
    await run('wire');
   }
   // The deployment lease serializes the whole operation. Only runtime probes
   // may enter here; the operator still prevents new normal sessions.
   admission.close();
   admission = undefined;
   let validationError;
   try {
    await run('validate');
   } catch (error) {
    validationError = error;
   }
   // Every later mutation requires actual reacquisition and another inventory.
   await reacquire();
   if (validationError) {
    state.phase = 'validation_failed';
    checkpoint(directory, state);
    // Retained activation history cannot restore unfinished initial/refresh wiring.
    let reason = 'first_migration_recovery_required';
    if (command.operation === 'rollback') {
     reason = 'rollback_recovery_required';
    } else if (previous && wiringPreviouslyInstalled) {
     reason = 'validated_rollback_required';
    } else if (previous) {
     reason = 'wiring_refresh_recovery_required';
    }
    fail('DEPLOY_VALIDATION_FAILED', reason);
   }
   if(JSON.stringify(readActivation({repositoryRoot}))!==JSON.stringify(current))fail('DEPLOY_CURRENT_CHANGED');
   await run('finalize',undefined,guardForward?{action:'continue',context:guardForward.policy_context}:undefined);
   if(guardForward){guardForward=markGuardTransitionFinalized({home,journalDirectory:directory});resultGuardMode='observe';}
   if (!exists(wiringFile) || privateRead(wiringFile).installed !== true) {
    privateWrite(wiringFile, {version:1, installed:true});
   }
  }
  if(guardRecovery&&!resumeGuardReverse){guardRecovery.state.status='complete';guardRecovery.state.recovery='guard_predecessor_rollback';checkpoint(guardRecovery.directory,guardRecovery.state);}
  if(recovery){recovery.state.status='complete';recovery.state.recovery='validated_predecessor_rollback';checkpoint(recovery.directory,recovery.state);}
  state.status='complete';state.phase='complete';checkpoint(directory,state);
  let retentionWarning;
  try {recordDeploymentRetention({repositoryRoot,journalDirectory:directory,previousDirectory:command.operation==='refresh-bootstrap'?state.bootstrap.previousDirectory:null});}
  catch {retentionWarning='retention_receipt_unavailable';}
  const retention=retentionWarning?{warnings:[retentionWarning]}:{};
  if(command.operation==='refresh-bootstrap')return {...retention,code:'DEPLOY_BOOTSTRAP_REFRESHED',releaseId:current.releaseId,bootstrap:{from:state.bootstrap.from,to:state.bootstrap.to,previousDirectory:state.bootstrap.previousDirectory},inventory:{before,after}};
  // Uninstall reports adapters whose removed entry carried non-default env (names only),
  // or null when the selected release's library predates that report.
  const envDropped=command.operation==='uninstall'?{envDropped:state.variables.ENV_DROPPED_REPORTED==='1'?[...new Set((state.variables.ENV_DROPPED??'').split(' '))].filter(name=>ENV_ADAPTERS.includes(name)).sort():null}:{};
  return {...retention,...envDropped,...(resultGuardMode?{runtime_mode:resultGuardMode,enforced:false}:{}),code:command.operation==='uninstall'?'DEPLOY_UNINSTALLED':command.operation==='rollback'?'DEPLOY_ROLLED_BACK':'DEPLOY_ACTIVATED',previousReleaseId:previous?.releaseId??null,releaseId:current?.releaseId??null,predecessorAvailable:current?.predecessorActivationId!==null&&current!==null,inventory:{before,after},unprotected:state.variables.INSTALL_UNPROTECTED==='1'};
 } catch(error) {if(state&&!state.mutationStarted){try{state.status='complete';state.phase='refused';checkpoint(directory,state);}catch{}}if(error instanceof DeploymentError)throw error;fail('DEPLOY_FAILED');}
 finally {admission?.close();writer?.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {const result=await runDeployment({repositoryRoot:path.dirname(path.dirname(fileURLToPath(import.meta.url))),argv:process.argv.slice(2)});process.stdout.write(JSON.stringify(result)+'\n');}
 catch(error){const code=typeof error.code==='string'&&/^DEPLOY_[A-Z_]{1,55}$/.test(error.code)?error.code:'DEPLOY_FAILED';process.stdout.write(JSON.stringify({error:{code,...(error.reason?{reason:error.reason}:{})}})+'\n');process.exitCode=1;}
}
