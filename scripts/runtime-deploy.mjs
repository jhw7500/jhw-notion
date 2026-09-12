import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DeploymentError, trustedDirectory, trustedFile, acquireLease, inspectConsumers, requireQuiescence} from './runtime-safety.mjs';
import {prepareRelease, validateRelease, readActivation, publishActivation, rollbackActivation} from './runtime-store.mjs';
import {installBootstrap, validateBootstrap} from './runtime-entry.mjs';

const RELEASE = /^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/;
const KEYS = ['HOOK_LINK_CREATED','INSTALL_TRANSACTION_ACTIVE','HOOKS_CONFIG_CHANGED','HOOKS_CONFIG_FILE','HOOKS_ADAPTER','HOOKS_DISPLAY_NAME','HOOKS_TRANSACTION_DIR','HOOKS_TRANSACTION_STAGE','HOOKS_TRANSACTION_METADATA','HOOKS_TRANSACTION_PRESERVE','CLAUDE_HOOKS_CONFIG_CHANGED','CLAUDE_HOOKS_CONFIG_FILE','CLAUDE_HOOKS_TRANSACTION_DIR','CLAUDE_HOOKS_TRANSACTION_STAGE','CLAUDE_HOOKS_TRANSACTION_METADATA','CLAUDE_HOOKS_TRANSACTION_PRESERVE','CONTROL_HOOK_LINK_TRANSACTION_DIR','CONTROL_HOOK_LINK_TRANSACTION_STAGE','CONTROL_HOOK_LINK_TRANSACTION_METADATA','CONTROL_HOOK_LINK_TRANSACTION_PRESERVE','CONTROL_HOOK_LINK_REMOVE_OUTCOME','INSTALL_UNPROTECTED','MIGRATION_HOOK_TRANSACTION_DIR'];
const fail = (code,reason) => {throw new DeploymentError(code,reason);};
function exists(file) {try {fs.lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function parse(argv) {
 if(!Array.isArray(argv)||argv.some(v=>typeof v!=='string'))fail('DEPLOY_ARGUMENTS_INVALID');
 if(argv.length===0)return {operation:'default'};
 if(argv.length===1&&['--prepare','--status','--rollback','--uninstall','--help','-h'].includes(argv[0]))return {operation:argv[0].replace(/^--?/,'')};
 if(argv.length===2&&argv[0]==='--activate'&&RELEASE.test(argv[1]))return {operation:'activate',releaseId:argv[1]};
 fail('DEPLOY_ARGUMENTS_INVALID');
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
function privateRead(file) {
 const directory=pinnedDirectory(path.dirname(file));let fd;
 try {
  fd=fs.openSync(directory.at(path.basename(file)),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.size>256n*1024n)fail('DEPLOY_RECOVERY_REQUIRED');
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
  while(length<bytes.length){const count=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
  const same=value=>['dev','ino','uid','gid','mode','nlink','size','ctimeNs','mtimeNs'].every(key=>before[key]===value[key]);
  if(length!==Number(before.size)||!same(fs.fstatSync(fd,{bigint:true}))||!same(fs.lstatSync(directory.at(path.basename(file)),{bigint:true})))fail('DEPLOY_RECOVERY_REQUIRED');
  directory.verify();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
 }finally{if(fd!==undefined)fs.closeSync(fd);directory.close();}
}

// Retained first-migration evidence only. No automatic restoration and no scan
// of unrelated HOME content. Every byte read is bounded and descriptor-relative.
function wiringPreimages({repositoryRoot,home,releaseId}) {
 const names=['.local/bin/jhw-control','.local/bin/jhw-control-hook','.claude.json','.claude/settings.json','.gemini/settings.json','.codex/config.toml','.codex/hooks.json','.config/opencode/opencode.json','.claude/commands/jhw','.gemini/commands/jhw','.config/opencode/skills/jhw','.codex/commands/jhw'];
 if(releaseId) {
  const skills=path.join(repositoryRoot,'.jhw-runtime/releases',releaseId,'skills');
  for(const [source,target,pattern] of [['claude','.codex/prompts',/^(?!AGENTS\.md$).+\.md$/],['codex','.codex/skills',/^jhw-/]]) {
   const directory=path.join(skills,source);
   if(exists(directory))for(const name of fs.readdirSync(directory).filter(n=>pattern.test(n)))names.push(`${target}/${name}`);
  }
 }
 if(names.length>1024)fail('DEPLOY_RECOVERY_REQUIRED');
 const entries=[];let remaining=2*1024*1024;
 for(const name of names) {
  const file=path.join(home,name);let initial;
  try {initial=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT'){entries.push({path:name,type:'absent'});continue;}throw error;}
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
keys=(${KEYS.join(' ')})
for key in "\${keys[@]}"; do
  IFS= read -r -d '' value || exit 65
  if [[ "$value" != __JHW_UNSET__ ]]; then printf -v "$key" '%s' "$value"; fi
done
save_phase_state() {
  local rc=$?
  trap - EXIT
  for key in "\${keys[@]}"; do printf '%s\\0' "\${!key}" >&5; done
  exit "$rc"
}
trap save_phase_state EXIT
case "$3" in
  verify) verify_wiring ;;
  wire) install_wiring ;;
  validate) require_control_host; run_guard_preflight ;;
  finalize) finalize_wiring ;;
  uninstall) uninstall_wiring ;;
  *) exit 64 ;;
esac
`;
async function wiringPhase({repositoryRoot,home,environment,phase,managed,deployLease,admissionLease,directory,state,phaseTimeoutMs}) {
 const selected=managed?readActivation({repositoryRoot}):null;
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
  logDirectory.verify();
  const child=spawn('/bin/bash',['-c',WORKER,'jhw-wiring-phase',repositoryRoot,library,phase,managed?'managed':'legacy',editor],{cwd:directory,env,stdio:['pipe','pipe','pipe',deployLease.fd,admissionLease?.fd??'ignore','pipe']});
  const capture=chunk=>{total+=chunk.length;if(logging&&total<=256*1024)fs.writeSync(logFd,chunk);else overflow=true;};child.stdout.on('data',capture);child.stderr.on('data',capture);
  child.stdio[5].on('data',chunk=>{if(output.length+chunk.length<=256*1024)output=Buffer.concat([output,chunk]);else overflow=true;});
  child.stdin.on('error',()=>{});child.stdin.end(KEYS.map(key=>(state.variables?.[key]??'__JHW_UNSET__')+'\0').join(''));
  const code=await Promise.race([new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve(signal?null:code));}),new Promise(resolve=>{phaseTimer=setTimeout(()=>{child.unref();for(const stream of [child.stdin,child.stdout,child.stderr,child.stdio[5]])stream.unref?.();resolve(null);},phaseTimeoutMs);})]);
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
export async function runDeployment({repositoryRoot,home=process.env.HOME,argv=[],procRoot='/proc',build,environment=process.env,phaseRunner=wiringPhase,phaseTimeoutMs=45000}={}) {
 const command=parse(argv);
 if(!Number.isInteger(phaseTimeoutMs)||phaseTimeoutMs<1||phaseTimeoutMs>45000)fail('DEPLOY_ARGUMENTS_INVALID');
 if(command.operation==='help'||command.operation==='h')return {code:'DEPLOY_USAGE',commands:['--prepare','--status','--activate RELEASE_ID','--rollback','--uninstall']};
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
 const before=requireQuiescence(inventoryOptions); // Before any shared mutation.
 prepareStore(repositoryRoot);
 let writer;let admission;let directory;let state;
 try {
  writer=acquireLease(path.join(runtime,'deploy.lock'),{create:true});
  admission=acquireLease(path.join(runtime,'admission.lock'),{create:true});
  const after=requireQuiescence(inventoryOptions);
  const previous=readActivation({repositoryRoot});
  const abandoned=pending(runtime);
  let recovery;
  if(abandoned.length) {
   if(command.operation!=='rollback'||abandoned.length!==1)fail('DEPLOY_RECOVERY_REQUIRED');
   const recoveryDirectory=path.join(runtime,abandoned[0]);const prior=privateRead(path.join(recoveryDirectory,'state.json'));
   if(!prior.previous)fail('DEPLOY_PREDECESSOR_INVALID');
   if(prior.operation!=='activate'||!['validation_failed','recovery_blocked','validate','finalize'].includes(prior.phase)||JSON.stringify(prior.current)!==JSON.stringify(previous)||previous?.predecessorActivationId!==prior.previous.activationId)fail('DEPLOY_RECOVERY_REQUIRED');
   recovery={directory:recoveryDirectory,state:prior};
  }
  const wiringFile=path.join(runtime,'wiring.json');
  const wiringPreviouslyInstalled = exists(wiringFile) && privateRead(wiringFile).installed === true;
  let managed = wiringPreviouslyInstalled;
  if(recovery&&!managed)fail('DEPLOY_RECOVERY_REQUIRED');
  if(command.operation==='activate')validateRelease({repositoryRoot,releaseId:command.releaseId});
  if(command.operation==='rollback'&&!previous?.predecessorActivationId)fail('DEPLOY_PREDECESSOR_INVALID');
  directory=createPrivateDirectory(runtime,`.deploy.${randomBytes(16).toString('hex')}`);
  state={version:1,status:'pending',operation:command.operation,phase:'before_mutation',previous,variables:{}};checkpoint(directory,state);
  const run=async phase=>{state.phase=phase;checkpoint(directory,state);await phaseRunner({repositoryRoot,home,environment,phase,managed,deployLease:writer,admissionLease:admission,directory,state,phaseTimeoutMs});};
  let current=previous;
  if(managed&&command.operation!=='uninstall') {
   await run('verify');
   requireCompatibleWiringTopology({repositoryRoot,home,previous,command});
  }
  if(!managed||command.operation==='uninstall')privateWrite(path.join(directory,'before.json'),wiringPreimages({repositoryRoot,home,releaseId:command.releaseId??previous?.releaseId}),{exclusive:true});
  if(command.operation==='uninstall') {
   state.mutationStarted=true;checkpoint(directory,state);
   if(previous){validateBootstrap({repositoryRoot});managed=true;}
   await run('uninstall');privateWrite(wiringFile,{version:1,installed:false});
  } else {
   state.mutationStarted=true;checkpoint(directory,state);
   if(command.operation==='activate') {
    if(!managed)await installBootstrap({repositoryRoot,releaseId:command.releaseId});else validateBootstrap({repositoryRoot});
    current=publishActivation({repositoryRoot,releaseId:command.releaseId,expectedCurrent:previous});
   } else {validateBootstrap({repositoryRoot});current=rollbackActivation({repositoryRoot,expectedCurrent:previous});}
   state.current=current;checkpoint(directory,state);
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
    requireQuiescence(inventoryOptions);
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
  return {code:command.operation==='uninstall'?'DEPLOY_UNINSTALLED':command.operation==='rollback'?'DEPLOY_ROLLED_BACK':'DEPLOY_ACTIVATED',previousReleaseId:previous?.releaseId??null,releaseId:current?.releaseId??null,predecessorAvailable:current?.predecessorActivationId!==null&&current!==null,inventory:{before,after},unprotected:state.variables.INSTALL_UNPROTECTED==='1'};
 } catch(error) {if(state&&!state.mutationStarted){try{state.status='complete';state.phase='refused';checkpoint(directory,state);}catch{}}if(error instanceof DeploymentError)throw error;fail('DEPLOY_FAILED');}
 finally {admission?.close();writer?.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {const result=await runDeployment({repositoryRoot:path.dirname(path.dirname(fileURLToPath(import.meta.url))),argv:process.argv.slice(2)});process.stdout.write(JSON.stringify(result)+'\n');}
 catch(error){const code=typeof error.code==='string'&&/^DEPLOY_[A-Z_]{1,55}$/.test(error.code)?error.code:'DEPLOY_FAILED';process.stdout.write(JSON.stringify({error:{code,...(error.reason?{reason:error.reason}:{})}})+'\n');process.exitCode=1;}
}
