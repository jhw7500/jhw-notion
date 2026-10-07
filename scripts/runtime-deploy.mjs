import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DeploymentError, trustedDirectory, trustedFile, acquireLease, inspectConsumers, requireQuiescence} from './runtime-safety.mjs';
import {prepareRelease, validateRelease, readActivation, publishActivation, rollbackActivation} from './runtime-store.mjs';
import {installBootstrap, validateBootstrap} from './runtime-entry.mjs';

const RELEASE = /^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/;
const KEYS = ['HOOK_LINK_CREATED','INSTALL_TRANSACTION_ACTIVE','HOOKS_CONFIG_CHANGED','HOOKS_CONFIG_FILE','HOOKS_ADAPTER','HOOKS_DISPLAY_NAME','HOOKS_TRANSACTION_DIR','HOOKS_TRANSACTION_STAGE','HOOKS_TRANSACTION_METADATA','HOOKS_TRANSACTION_PRESERVE','CLAUDE_HOOKS_CONFIG_CHANGED','CLAUDE_HOOKS_CONFIG_FILE','CLAUDE_HOOKS_TRANSACTION_DIR','CLAUDE_HOOKS_TRANSACTION_STAGE','CLAUDE_HOOKS_TRANSACTION_METADATA','CLAUDE_HOOKS_TRANSACTION_PRESERVE','CONTROL_HOOK_LINK_TRANSACTION_DIR','CONTROL_HOOK_LINK_TRANSACTION_STAGE','CONTROL_HOOK_LINK_TRANSACTION_METADATA','CONTROL_HOOK_LINK_TRANSACTION_PRESERVE','CONTROL_HOOK_LINK_REMOVE_OUTCOME','INSTALL_UNPROTECTED','MIGRATION_HOOK_TRANSACTION_DIR','CODEX_BACKUP_PRUNE_FILE','ENV_DROPPED'];
const ENV_ADAPTERS=['claude','codex','gemini','opencode'];
const fail = (code,reason) => {throw new DeploymentError(code,reason);};
function exists(file) {try {fs.lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function parse(argv) {
 if(!Array.isArray(argv)||argv.some(v=>typeof v!=='string'))fail('DEPLOY_ARGUMENTS_INVALID');
 if(argv.length===0)return {operation:'default'};
 if(argv.length===1&&['--prepare','--status','--rollback','--uninstall','--refresh-bootstrap','--help','-h'].includes(argv[0]))return {operation:argv[0].replace(/^--?/,'')};
 if(argv.length===2&&argv[0]==='--activate'&&RELEASE.test(argv[1]))return {operation:'activate',releaseId:argv[1]};
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
 const scratch=createPrivateDirectory(directory,'restore');
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
// A new process receives real lease descriptors for each mutation phase. No
// persistent process retains exclusive admission during runtime validation.
const WORKER = `set -euo pipefail
umask 077
SCRIPT_DIR="$1"
source "$2"
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
save_phase_state() {
  local rc=$?
  trap - EXIT
  for key in "\${keys[@]}"; do printf '%s\\0' "\${!key-}" >&5; done
  exit "$rc"
}
trap save_phase_state EXIT
case "$3" in
  verify) verify_wiring ;;
  wire) install_wiring ;;
  validate) require_control_host; run_guard_preflight ;;
  finalize) finalize_wiring ;;
  rollback) rollback_first_wiring_complete ;;
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
plan_wiring "$4"
`;
const PLAN_CONFLICTS = ['adopt_env_unpreservable','control_host','tui_root','pending_transaction','unsafe_parent','parent_unusable','control_link','hook_link','command_dir','skill_link','prompt_link','mcp_entry','hook_config'];
async function planWiring({repositoryRoot,home,environment,releaseId,planTimeoutMs,adoptFrom}) {
 const release=path.join(repositoryRoot,'.jhw-runtime/releases',releaseId);
 const library=path.join(release,'scripts/install-wiring.sh');const editor=path.join(release,'scripts/install-config.mjs');trustedFile(library);trustedFile(editor);
 const env={...environment,HOME:home,PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':')};
 for(const key of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV','SHELLOPTS','BASHOPTS'])delete env[key];
 adoptEnvironment(env,adoptFrom);
 // Own process group: the plan is read-only, so any straggler is killed outright.
 const child=spawn('/bin/bash',['-c',PLAN_WORKER,'jhw-wiring-plan',repositoryRoot,library,editor,path.join(release,'skills')],{cwd:release,env,stdio:['ignore','pipe','ignore'],detached:true});
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

export async function wiringPhase({repositoryRoot,home,environment,phase,managed,deployLease,admissionLease,directory,state,phaseTimeoutMs,candidateReleaseId,adoptFrom}) {
 // Before pointer publication a first activation names its validated candidate.
 const selected=candidateReleaseId?{releaseId:candidateReleaseId}:managed?readActivation({repositoryRoot}):null;
 const scripts=selected?path.join(repositoryRoot,'.jhw-runtime/releases',selected.releaseId,'scripts'):path.join(repositoryRoot,'scripts');
 const library=path.join(scripts,'install-wiring.sh');const editor=path.join(scripts,'install-config.mjs');trustedFile(library);trustedFile(editor);
 const log=path.join(directory,`${phase}.${randomBytes(8).toString('hex')}.log`);
 const logDirectory=pinnedDirectory(directory);
 const logFd=fs.openSync(logDirectory.at(path.basename(log)),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.fchmodSync(logFd,0o600);
 let total=0;let output=Buffer.alloc(0);let overflow=false;let logging=true;let phaseTimer;
 try {
  const env={...environment,HOME:home,PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':')};
  // Never pass Node loader or shell startup injection into maintenance workers.
  for(const key of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV','SHELLOPTS','BASHOPTS'])delete env[key];
  adoptEnvironment(env,adoptFrom);
  logDirectory.verify();
  const skillSource=candidateReleaseId?path.join(repositoryRoot,'.jhw-runtime/releases',candidateReleaseId,'skills'):'';
  const child=spawn('/bin/bash',['-c',WORKER,'jhw-wiring-phase',repositoryRoot,library,phase,managed?'managed':'legacy',editor,skillSource],{cwd:directory,env,stdio:['pipe','pipe','pipe',deployLease.fd,admissionLease?.fd??'ignore','pipe']});
  const capture=chunk=>{total+=chunk.length;if(logging&&total<=256*1024)fs.writeSync(logFd,chunk);else overflow=true;};child.stdout.on('data',capture);child.stderr.on('data',capture);
  child.stdio[5].on('data',chunk=>{if(output.length+chunk.length<=256*1024)output=Buffer.concat([output,chunk]);else overflow=true;});
  child.stdin.on('error',()=>{});child.stdin.end(KEYS.map(key=>(state.variables?.[key]??'__JHW_UNSET__')+'\0').join(''));
  const code=await Promise.race([new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve(signal?null:code));}),new Promise(resolve=>{phaseTimer=setTimeout(()=>{state.workerDetached=true;child.unref();for(const stream of [child.stdin,child.stdout,child.stderr,child.stdio[5]])stream.unref?.();resolve(null);},phaseTimeoutMs);})]);
  clearTimeout(phaseTimer);
  const values=output.toString('utf8').split('\0');
  if(values.length===KEYS.length+1&&values.at(-1)===''&&!overflow)state.variables=Object.fromEntries(KEYS.map((key,index)=>[key,values[index]]));
  else state.stateIncomplete=true;
  checkpoint(directory,state);
  if(code!==0||overflow||state.stateIncomplete)fail(phase==='validate'?'DEPLOY_VALIDATION_FAILED':'DEPLOY_WIRING_FAILED');
  if(phase==='validate')await mcpProbe({repositoryRoot,home,environment,deployLease,directory,logFd});
 } finally {logging=false;clearTimeout(phaseTimer);fs.fsyncSync(logFd);fs.closeSync(logFd);try{logDirectory.verify();}finally{logDirectory.close();}}
}

async function mcpProbe({repositoryRoot,home,environment,deployLease,directory,logFd}) {
 const env={...environment,HOME:home,PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':')};
 for(const key of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV'])delete env[key];
 adoptEnvironment(env);
 const child=spawn(process.execPath,[path.join(repositoryRoot,'.jhw-runtime/bootstrap/jhw-runtime-entry'),'mcp'],{cwd:directory,env,stdio:['pipe','pipe','pipe',deployLease.fd]});
 let input='';let bytes=0;let stderrBytes=0;let stage=0;let failure=false;let logging=true;
 child.stdin.on('error',()=>{failure=true;});
 const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
 send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'jhw-deployment-validation',version:'1'}}});
 child.stdout.on('data',chunk=>{
  bytes+=chunk.length;if(bytes>128*1024){failure=true;child.stdin.end();return;}
  input+=chunk.toString('utf8');let newline;
  while((newline=input.indexOf('\n'))>=0){const line=input.slice(0,newline);input=input.slice(newline+1);try{
   const response=JSON.parse(line);
   if(response.jsonrpc!=='2.0'||response.error)throw new Error();
   if(stage===0&&response.id===1&&typeof response.result?.protocolVersion==='string'&&response.result?.serverInfo&&response.result?.capabilities){stage=1;send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});}
   else if(stage===1&&response.id===2&&Array.isArray(response.result?.tools)){stage=2;child.stdin.end();}
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
}

/** Module-only fixtures may supply private procRoot/build/phaseRunner. Public
 * argv and environment have no gate bypass, lock-fd, or alternate-root option. */
export async function runDeployment({repositoryRoot,home=process.env.HOME,argv=[],procRoot='/proc',build,environment=process.env,phaseRunner=wiringPhase,phaseTimeoutMs=45000,planTimeoutMs=45000}={}) {
 const command=parse(argv);
 if([phaseTimeoutMs,planTimeoutMs].some(value=>!Number.isInteger(value)||value<1||value>45000))fail('DEPLOY_ARGUMENTS_INVALID');
 if(command.operation==='help'||command.operation==='h')return {code:'DEPLOY_USAGE',commands:['--prepare','--status','--activate RELEASE_ID','--activate RELEASE_ID --adopt-from LEGACY_CHECKOUT','--rollback','--uninstall','--refresh-bootstrap']};
 if(typeof repositoryRoot!=='string'||!path.isAbsolute(repositoryRoot)||typeof home!=='string'||!path.isAbsolute(home))fail('DEPLOY_ARGUMENTS_INVALID');
 const inventoryOptions={repositoryRoot,procRoot,excludePids:[process.pid]};
 const runtime=path.join(repositoryRoot,'.jhw-runtime');
 if(command.operation==='status') {
  const inventory=inspectConsumers(inventoryOptions);const current=exists(runtime)?readActivation({repositoryRoot}):null;
  return {code:'DEPLOY_STATUS',advisory:true,releaseId:current?.releaseId??null,predecessorAvailable:current?.predecessorActivationId!==null&&current!==null,recoveryPending:pending(runtime).length,inventory};
 }
 if(command.operation==='default'&&existingInstallation(repositoryRoot,home))return {code:'DEPLOY_EXPLICIT_ACTIVATION_REQUIRED',next:['--prepare','--activate RELEASE_ID']};
 if(command.operation==='prepare')return {code:'DEPLOY_PREPARED',...await prepareRelease({repositoryRoot,build})};
 if(command.operation==='default'){const release=await prepareRelease({repositoryRoot,build});command.operation='activate';command.releaseId=release.releaseId;}
 if(command.adoptFrom)validateAdoptSource(repositoryRoot,command.adoptFrom);
 // Adoption also requires the legacy checkout to have no consumers.
 const quiesce=()=>{const result=requireQuiescence(inventoryOptions);if(command.adoptFrom)requireQuiescence({...inventoryOptions,repositoryRoot:command.adoptFrom});return result;};
 const before=quiesce(); // Before any shared mutation.
 prepareStore(repositoryRoot);
 let writer;let admission;let directory;let state;
 try {
  writer=acquireLease(path.join(runtime,'deploy.lock'),{create:true});
  admission=acquireLease(path.join(runtime,'admission.lock'),{create:true});
  const after=quiesce();
  const previous=readActivation({repositoryRoot});
  const abandoned=pending(runtime);
  let recovery;
  if(abandoned.length) {
   if(!['rollback','refresh-bootstrap'].includes(command.operation)||abandoned.length!==1)fail('DEPLOY_RECOVERY_REQUIRED');
   const recoveryDirectory=path.join(runtime,abandoned[0]);const prior=privateRead(path.join(recoveryDirectory,'state.json'));
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
  const wiringFile=path.join(runtime,'wiring.json');
  const wiringPreviouslyInstalled = exists(wiringFile) && privateRead(wiringFile).installed === true;
  let managed = wiringPreviouslyInstalled;
  if(command.adoptFrom&&managed)fail('DEPLOY_ARGUMENTS_INVALID','adopt_requires_first_activation');
  if(recovery&&!managed)fail('DEPLOY_RECOVERY_REQUIRED');
  if(command.operation==='activate')validateRelease({repositoryRoot,releaseId:command.releaseId});
  if(command.operation==='rollback'&&!previous?.predecessorActivationId)fail('DEPLOY_PREDECESSOR_INVALID');
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
  directory=createPrivateDirectory(runtime,`.deploy.${randomBytes(16).toString('hex')}`);
  state={version:1,status:'pending',operation:command.operation,phase:'before_mutation',previous,variables:{}};
  if(command.operation==='refresh-bootstrap') {
   state.bootstrap={prior:originalBootstrap,from:originalBootstrap?.sourceReleaseId??null,to:null,previousDirectory:null};
   // The inherited obligation keeps this journal pending even when the retry is
   // refused. It is written before the interrupted journal closes, so a crash in
   // between leaves two pending journals and fails closed.
   if(recovery){state.mutationStarted=true;state.supersedes=path.basename(recovery.directory);}
  }
  checkpoint(directory,state);
  if(recovery&&command.operation==='refresh-bootstrap'){recovery.state.status='complete';recovery.state.recovery='superseded_by_refresh';checkpoint(recovery.directory,recovery.state);recovery=undefined;}
  const run=async (phase,candidateReleaseId)=>{state.phase=phase;checkpoint(directory,state);await phaseRunner({repositoryRoot,home,environment,phase,managed,deployLease:writer,admissionLease:admission,directory,state,phaseTimeoutMs,candidateReleaseId,adoptFrom:command.adoptFrom});};
  const pointerIntent=destination=>{state.destination=destination;state.phase='pointer_intent';checkpoint(directory,state);};
  let current=previous;
  if(managed&&command.operation!=='uninstall') {
   await run('verify');
   if(command.operation!=='refresh-bootstrap')requireCompatibleWiringTopology({repositoryRoot,home,previous,command});
  }
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
   try {
    admission=acquireLease(path.join(runtime,'admission.lock'));
    quiesce();
   } catch {
    state.phase='recovery_blocked';checkpoint(directory,state);
    fail('DEPLOY_RECOVERY_REQUIRED','maintenance_reacquisition_failed');
   }
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
   try {
    if(firstWired){state.phase='wired';checkpoint(directory,state);}
    if(command.operation==='activate')current=publishActivation({repositoryRoot,releaseId:command.releaseId,expectedCurrent:previous,onPointerIntent:pointerIntent});
    else {validateBootstrap({repositoryRoot});current=rollbackActivation({repositoryRoot,expectedCurrent:previous,onPointerIntent:pointerIntent});}
    state.current=current;checkpoint(directory,state);
   } catch(error) {
    if(!firstWired)throw error;
    // Publication after a completed first wire failed. Only a pointer proven
    // still at the origin makes the wired HOME safe to undo; otherwise the new
    // wiring may already be live, so nothing is guessed or restored.
    let pointer;try{pointer=readActivation({repositoryRoot});}catch{pointer=undefined;}
    if(pointer!==undefined&&JSON.stringify(pointer)===JSON.stringify(previous))await undoFirstWiring();
    state.phase='publication_uncertain';try{checkpoint(directory,state);}catch{}
    fail('DEPLOY_RECOVERY_REQUIRED','publication_uncertain');
   }
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
   try {
    admission = acquireLease(path.join(runtime, 'admission.lock'));
    quiesce();
   } catch {
    state.phase = 'recovery_blocked';
    checkpoint(directory, state);
    fail('DEPLOY_RECOVERY_REQUIRED', 'maintenance_reacquisition_failed');
   }
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
   await run('finalize');
   if (!exists(wiringFile) || privateRead(wiringFile).installed !== true) {
    privateWrite(wiringFile, {version:1, installed:true});
   }
  }
  if(recovery){recovery.state.status='complete';recovery.state.recovery='validated_predecessor_rollback';checkpoint(recovery.directory,recovery.state);}
  state.status='complete';state.phase='complete';checkpoint(directory,state);
  if(command.operation==='refresh-bootstrap')return {code:'DEPLOY_BOOTSTRAP_REFRESHED',releaseId:current.releaseId,bootstrap:{from:state.bootstrap.from,to:state.bootstrap.to,previousDirectory:state.bootstrap.previousDirectory},inventory:{before,after}};
  // Uninstall reports adapters whose removed entry carried non-default env (names only).
  const envDropped=command.operation==='uninstall'?{envDropped:[...new Set((state.variables.ENV_DROPPED??'').split(' '))].filter(name=>ENV_ADAPTERS.includes(name)).sort()}:{};
  return {...envDropped,code:command.operation==='uninstall'?'DEPLOY_UNINSTALLED':command.operation==='rollback'?'DEPLOY_ROLLED_BACK':'DEPLOY_ACTIVATED',previousReleaseId:previous?.releaseId??null,releaseId:current?.releaseId??null,predecessorAvailable:current?.predecessorActivationId!==null&&current!==null,inventory:{before,after},unprotected:state.variables.INSTALL_UNPROTECTED==='1'};
 } catch(error) {if(state&&!state.mutationStarted){try{state.status='complete';state.phase='refused';checkpoint(directory,state);}catch{}}if(error instanceof DeploymentError)throw error;fail('DEPLOY_FAILED');}
 finally {admission?.close();writer?.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {const result=await runDeployment({repositoryRoot:path.dirname(path.dirname(fileURLToPath(import.meta.url))),argv:process.argv.slice(2)});process.stdout.write(JSON.stringify(result)+'\n');}
 catch(error){const code=typeof error.code==='string'&&/^DEPLOY_[A-Z_]{1,55}$/.test(error.code)?error.code:'DEPLOY_FAILED';process.stdout.write(JSON.stringify({error:{code,...(error.reason?{reason:error.reason}:{})}})+'\n');process.exitCode=1;}
}
