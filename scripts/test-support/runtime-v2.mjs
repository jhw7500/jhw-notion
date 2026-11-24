import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

import {prepareRelease, releaseCompatibility} from '../runtime-store.mjs';

const scriptsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = process.env.JHW_RUNTIME_TEST_SOURCE_ROOT ?? path.dirname(scriptsRoot);
if (!path.isAbsolute(repositoryRoot)) throw new Error('runtime test source root must be absolute');

function checkedSpawn(command, args, options, label) {
  const result = spawnSync(command, args, {encoding:'utf8', maxBuffer:128*1024*1024, ...options});
  if (result.status !== 0 || result.signal || result.error) throw new Error(`${label}: ${result.stderr || result.error?.message || 'failed'}`);
  return result;
}

export async function createRuntimeFixture(t, {realDependencies = false, legacyRevision = null, productionEntry = false, retryHelper = false, holdingMcp = false, credentialFdEvidence = false} = {}) {
  if (realDependencies && legacyRevision !== null) throw new Error('realDependencies and legacyRevision are mutually exclusive');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-runtime-v2-fixture-'));
  const home = path.join(root, 'home');
  const procRoot = '/proc';
  const children = new Set();
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(home, {mode: 0o700});
  const privateEnvironment = realDependencies ? {
    HOME:home,
    PATH:process.env.PATH,
    LANG:process.env.LANG ?? 'C.UTF-8',
    GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_CONFIG_NOSYSTEM:'1',
  } : {...process.env, HOME:home, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1'};
  t.after(async () => {
    const closing = [];
    for (const child of children) {
      closing.push(new Promise(resolve => child.once('close', resolve)));
      child.kill('SIGTERM');
    }
    await Promise.allSettled(closing);
    fs.rmSync(root, {recursive:true, force:true});
  });

  const write = (relative, bytes, mode = 0o644) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), {recursive:true, mode:0o755});
    fs.writeFileSync(target, bytes, {mode});
    fs.chmodSync(target, mode);
    return target;
  };
  let baselineRevision = null;
  if (realDependencies) {
    const runtimeInputs = [
      'mcp-server/package.json','mcp-server/package-lock.json','mcp-server/tsconfig.json','mcp-server/tsconfig.test.json',
      'mcp-server/src','mcp-server/scripts','skills','scripts/sync-codex-skills.mjs','scripts/jhw-control-hook',
      'scripts/runtime-safety.mjs','scripts/runtime-store.mjs','scripts/runtime-entry.mjs','scripts/runtime-deploy.mjs',
      'scripts/runtime-prune.mjs','scripts/runtime-guard.mjs','scripts/install-config.mjs','scripts/install-wiring.sh',
      'scripts/runtime-managed-scope.mjs',
      'scripts/jhw-runtime-entry','scripts/jhw-runtime-control','scripts/jhw-runtime-hook',
    ];
    runtimeInputs.push('install.sh');
    const revision = checkedSpawn('git',['-C',repositoryRoot,'rev-parse','--verify','HEAD^{commit}'],
      {env:privateEnvironment},'real dependency revision').stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error('real dependency revision is invalid');
    checkedSpawn('git',['init','-q'],{cwd:root,env:privateEnvironment},'real dependency git init');
    checkedSpawn('git',['-C',root,'fetch','--no-tags',repositoryRoot,revision],
      {env:privateEnvironment},'real dependency fetch');
    checkedSpawn('/bin/sh',['-c','umask 022; exec "$@"','fixture-checkout','git','-C',root,'reset','--hard',revision],
      {env:privateEnvironment},'real dependency checkout');
    const patch = checkedSpawn('git',['-C',repositoryRoot,'diff','--binary','HEAD','--',...runtimeInputs],
      {env:privateEnvironment,encoding:null},'real dependency tracked changes').stdout;
    if (patch.length) checkedSpawn('/bin/sh',['-c','umask 022; exec "$@"','fixture-overlay','git','-C',root,'apply','--binary','--whitespace=nowarn','-'],
      {env:privateEnvironment,encoding:null,input:patch},'real dependency tracked overlay');
    const untracked = checkedSpawn('git',['-C',repositoryRoot,'ls-files','--others','--exclude-standard','-z','--',...runtimeInputs],
      {env:privateEnvironment,encoding:null},'real dependency untracked inputs').stdout;
    for (let offset=0;offset<untracked.length;) {
      const end=untracked.indexOf(0,offset);
      if (end<0 || end===offset && end!==untracked.length-1) throw new Error('real dependency untracked list is invalid');
      if (end===offset) break;
      const encodedBytes=untracked.subarray(offset,end);
      const encoded=encodedBytes.toString('utf8');
      offset=end+1;
      if (!encodedBytes.equals(Buffer.from(encoded)) || encoded.includes('\\') || path.normalize(encoded) !== encoded || path.isAbsolute(encoded) || encoded.split(path.sep).includes('..')) {
        throw new Error('real dependency untracked path is invalid');
      }
      const source = path.join(repositoryRoot,encoded);
      const sourceStat = fs.lstatSync(source);
      if (sourceStat.uid !== process.getuid()) throw new Error('real dependency untracked input is unsafe');
      let sourceParent = repositoryRoot;
      let targetParent = root;
      for (const part of encoded.split('/').slice(0,-1)) {
        sourceParent = path.join(sourceParent,part);
        const parentStat = fs.lstatSync(sourceParent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o022)) throw new Error('real dependency untracked parent is unsafe');
        targetParent = path.join(targetParent,part);
        try {
          const targetStat = fs.lstatSync(targetParent);
          if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('real dependency target parent is unsafe');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          fs.mkdirSync(targetParent,{mode:0o755});
        }
      }
      const target = path.join(root,encoded);
      if (sourceStat.isFile() && sourceStat.nlink === 1 && !(sourceStat.mode & 0o022)) {
        fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target,(sourceStat.mode & 0o111) ? 0o755 : 0o644);
      } else if (sourceStat.isSymbolicLink()) {
        const link = fs.readlinkSync(source);
        if (path.isAbsolute(link) || link.includes('\0')) throw new Error('real dependency untracked symlink is unsafe');
        fs.symlinkSync(link,target);
      } else {
        throw new Error('real dependency untracked input type is unsupported');
      }
    }
    if (!fs.existsSync(path.join(root,'install.sh'))) throw new Error('real dependency install.sh is unavailable');
    baselineRevision = revision;
  } else if (legacyRevision !== null) {
    if (typeof legacyRevision !== 'string' || !/^[a-f0-9]{40,64}$/.test(legacyRevision)) throw new Error('baseline revision is invalid');
    let resolved;
    try {
      resolved = checkedSpawn('git',['-C',repositoryRoot,'rev-parse','--verify',`${legacyRevision}^{commit}`],
        {env:privateEnvironment},'baseline revision').stdout.trim();
    } catch { throw new Error('baseline revision is not a verified local commit'); }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resolved)) throw new Error('baseline revision is not a verified local commit');
    try {
      checkedSpawn('git',['-C',repositoryRoot,'merge-base','--is-ancestor',resolved,'HEAD'],
        {env:privateEnvironment},'baseline ancestry');
    } catch { throw new Error('baseline revision is not a verified local ancestor'); }
    const archive = checkedSpawn('git',['-C',repositoryRoot,'archive','--format=tar',resolved],
      {env:privateEnvironment,encoding:null},'baseline archive').stdout;
    const archiveFile = path.join(root,'.baseline.tar');
    fs.writeFileSync(archiveFile,archive,{mode:0o600});
    checkedSpawn('/usr/bin/tar',['-xf',archiveFile,'-C',root],{env:privateEnvironment},'baseline archive extraction');
    fs.unlinkSync(archiveFile);
    baselineRevision = resolved;
  } else {
    for (const [name, bytes] of Object.entries({
      '.gitignore': '.jhw-runtime/\n',
      'mcp-server/package.json': '{"type":"module"}\n',
      'mcp-server/package-lock.json': '{"lockfileVersion":3}\n',
      'mcp-server/tsconfig.json': '{}\n',
      'mcp-server/tsconfig.test.json': '{}\n',
      'mcp-server/src/index.ts': 'export {};\n',
      'mcp-server/src/server.ts': 'export {};\n',
      'mcp-server/src/tools/read.ts': 'export {};\n',
      'mcp-server/src/control/runtime-compatibility.json': '{"version":1,"generation":2,"guardFloor":1}\n',
      'mcp-server/src/control/hook-adapter.ts': 'export {};\n',
      'mcp-server/scripts/clean-dist.mjs': '',
      'scripts/sync-codex-skills.mjs': '',
      'scripts/runtime-deploy.mjs': 'export {};\n',
      'skills/claude/task.md': 'fixture\n',
    })) write(name, bytes);
    for (const name of ['jhw-runtime-entry','jhw-runtime-control','jhw-runtime-hook','runtime-safety.mjs','runtime-store.mjs']) {
      write(`scripts/${name}`,fs.readFileSync(path.join(scriptsRoot,name)),name.startsWith('jhw-')?0o755:0o644);
    }
    let runtimeEntry=productionEntry ? fs.readFileSync(path.join(scriptsRoot,'runtime-entry.mjs'),'utf8') : retryHelper ? `
import fs from 'node:fs';
export async function runManaged({repositoryRoot}) {
  const file=repositoryRoot+'/.retry-count';
  let count=0;try{count=Number(fs.readFileSync(file,'utf8'))}catch{}
  fs.writeFileSync(file,String(count+1));
  return {retryCurrent:true};
}
` : `
export async function runManaged({selector, args, selectedPair}) {
  if (!selectedPair || selectedPair.runtimeContract !== 2) return {retryCurrent:true};
  process.stdout.write(JSON.stringify({selector,args,selectedPair,artifact:'generation-a',home:process.env.HOME})+'\\n');
  return 0;
}
`;
    if(productionEntry&&credentialFdEvidence){
      const needle='before=fs.fstatSync(5,{bigint:true}); const mode=Number(before.mode);';
      if(runtimeEntry.split(needle).length!==2)throw new Error('credential FD observation point is not unique');
      const evidence=path.join(root,'.credential-fd-evidence.json');
      runtimeEntry=runtimeEntry.replace(needle,`before=fs.fstatSync(5,{bigint:true}); fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({dev:String(before.dev),ino:String(before.ino),target:fs.readlinkSync('/proc/self/fd/5')}),{mode:0o600}); const mode=Number(before.mode);`);
    }
    write('scripts/runtime-entry.mjs',runtimeEntry);
    write('scripts/jhw-control-hook', '#!/bin/sh\nexit 0\n', 0o755);
  }

  if (!realDependencies) {
    fs.rmSync(path.join(root,'.git'),{recursive:true,force:true});
    checkedSpawn('git',['init','-q'],{cwd:root,env:privateEnvironment},'fixture git init');
    checkedSpawn('git',['add','.'],{cwd:root,env:privateEnvironment},'fixture git add');
    checkedSpawn('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],
      {cwd:root,env:privateEnvironment},'fixture git commit');
  } else {
    for (const name of ['.claude','.gemini','.codex','.config/opencode']) {
      fs.mkdirSync(path.join(home,name),{recursive:true,mode:0o700});
      fs.chmodSync(path.join(home,name),0o700);
    }
    const hostContract = {commands:['unlock','preflight','portfolio status','task start','task child-start','task contract','task completion-ready','task promote','task status','task handoff','task finish','task recover','task assert-owner','board status','board acquire','board with'],credential_policy:'secure-store-only',name:'jhw-control-host',version:5};
    write('home/.local/bin/jhw-control-host',`#!/bin/sh\nif [ "$#" -ne 1 ] || [ "$1" != --contract ]; then exit 64; fi\nprintf '%s\\n' '${JSON.stringify(hostContract)}'\n`,0o755);
  }

  const prepareRealDependencies = () => new Promise((resolve,reject) => {
    const child = spawn(path.join(root,'install.sh'),['--prepare'],{
      cwd:root,env:privateEnvironment,stdio:['ignore','pipe','pipe']});
    children.add(child);
    let stdout='';let stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',error=>{children.delete(child);reject(error);});
    child.once('close',(status,signal)=>{
      children.delete(child);
      if(status!==0||signal){reject(new Error(`real dependency preparation failed: ${stderr||stdout||signal||status}`));return;}
      try {
        const {code,...release}=JSON.parse(stdout);
        if(code!=='DEPLOY_PREPARED')throw new Error(`unexpected result ${code}`);
        resolve(release);
      } catch(error){reject(new Error(`real dependency preparation returned invalid output: ${error.message}`));}
    });
  });
  const prepareSynthetic = (bundles={}) => prepareRelease({repositoryRoot:root,build:async ({stagingRoot}) => {
    const built = (name, bytes = '') => {
      const target = path.join(stagingRoot,name);
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});
      const executable = name.includes('/control/') || name.endsWith('/control.cjs') || name.endsWith('/hook.cjs');
      fs.writeFileSync(target,bytes,{mode:executable?0o755:0o644});
    };
    built('mcp-server/dist/index.js');
    built('mcp-server/dist/control/cli.js');
    built('mcp-server/dist/control/hook-adapter.js');
    built('mcp-server/dist/runtime/mcp.cjs', bundles.mcp ?? (productionEntry ? (holdingMcp ? `
const fs=require('node:fs');const [ready,release]=process.argv.slice(2);
const roles={3:'admission',6:'binding',7:'generation',8:'parent'};const fdEvidence={};
for(const [fd,role] of Object.entries(roles)){const stat=fs.fstatSync(Number(fd),{bigint:true});fdEvidence[fd]={role,dev:String(stat.dev),ino:String(stat.ino),target:fs.readlinkSync('/proc/self/fd/'+fd)};}
fs.writeFileSync(ready+'.tmp',JSON.stringify({fdEvidence,pid:process.pid}),{mode:0o600,flag:'wx'});
fs.renameSync(ready+'.tmp',ready);
const timer=setInterval(()=>{
  if(!fs.existsSync(release))return;
  clearInterval(timer);
  if(fs.readFileSync(release,'utf8')==='crash')process.kill(process.pid,'SIGKILL');
  process.exit(0);
},10);
` : `
const fs=require('node:fs');
const roles={3:'admission',6:'binding',7:'generation',8:'parent'};const fdEvidence={};const namedEvidence={};
for(const [fd,role] of Object.entries(roles)){const stat=fs.fstatSync(Number(fd),{bigint:true});const target=fs.readlinkSync('/proc/self/fd/'+fd);fdEvidence[fd]={role,dev:String(stat.dev),ino:String(stat.ino),target};const named=fs.statSync(target,{bigint:true});namedEvidence[fd]={dev:String(named.dev),ino:String(named.ino)};}
process.stdout.write(JSON.stringify({fdEvidence,namedEvidence,releaseRoot:globalThis.__JHW_MANAGED_RELEASE_ROOT__})+'\\n');
`) : ''));
    built('mcp-server/dist/runtime/control.cjs',bundles.control);
    built('mcp-server/dist/runtime/hook.cjs',bundles.hook);
    fs.mkdirSync(path.join(stagingRoot,'mcp-server/node_modules'),{recursive:true,mode:0o755});
  }});
  const prepare = realDependencies ? prepareRealDependencies : prepareSynthetic;

  const seedPair = pair => {
    const activationId = `a-${randomBytes(16).toString('hex')}`;
    const activation = path.join(root,'.jhw-runtime/v2/activations',activationId);
    fs.mkdirSync(activation,{recursive:true,mode:0o700});
    for (const directory of [path.join(root,'.jhw-runtime/v2'),path.dirname(activation),activation]) fs.chmodSync(directory,0o700);
    for (const name of ['mcp-server','scripts','skills']) fs.symlinkSync(`../../../releases/${pair.releaseId}/${name}`,path.join(activation,name));
    fs.symlinkSync(`../../bootstraps/${pair.bootstrapId}`,path.join(activation,'bootstrap'));
    const manifest = {version:2,activationId,...pair,predecessorActivationId:null,migrationId:null,createdAt:new Date().toISOString(),priorCurrent:null};
    fs.writeFileSync(path.join(activation,'manifest.json'),JSON.stringify(manifest)+'\n',{mode:0o600});
    fs.chmodSync(path.join(activation,'manifest.json'),0o600);
    const current = path.join(root,'.jhw-runtime/current');
    fs.rmSync(current,{force:true});
    fs.symlinkSync(`v2/activations/${activationId}`,current);
    const observed = fs.lstatSync(current,{bigint:true});
    return {version:2,activationId,releaseId:pair.releaseId,bootstrapId:pair.bootstrapId,runtimeContract:2,
      compatibilityDigest:pair.compatibilityDigest,predecessorActivationId:null,migrationId:null,
      observation:{target:`v2/activations/${activationId}`,dev:String(observed.dev),ino:String(observed.ino),ctimeNs:String(observed.ctimeNs)}};
  };

  const spawnManaged = argv => {
    const child = spawn(path.join(root,'.jhw-runtime/bootstrap',argv[0]),argv.slice(1),
      {env:privateEnvironment,stdio:['ignore','pipe','pipe']});
    children.add(child);
    let stdout=''; let stderr=''; let error=null;
    let killTimer;
    const timer = setTimeout(() => { child.kill('SIGTERM'); killTimer=setTimeout(()=>child.kill('SIGKILL'),200); },12000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',value=>{error=value;});
    const result=new Promise(resolve=>child.once('close',(status,signal)=>{clearTimeout(timer);clearTimeout(killTimer);children.delete(child);resolve({status,signal,stdout,stderr,error});}));
    return {child,result};
  };
  const run = argv => spawnManaged(argv).result;

  const spawnRouter = argv => {
    const harness=write('.router-harness.cjs',`const router=process.argv[2];\nprocess.on('message',message=>{if(message?.type==='exit')process.exit(0)});\nprocess.argv=[process.execPath,router,...process.argv.slice(3)];\nrequire(router);\n`,0o600);
    const router=path.join(root,'.jhw-runtime/bootstrap',argv[0]);
    const child=spawn(process.execPath,[harness,router,...argv.slice(1)],{env:privateEnvironment,
      stdio:['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore','ipc']});
    children.add(child);let stdout='';let stderr='';let error=null;let killTimer;
    const timer=setTimeout(()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),200);},12000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',value=>{error=value;});
    const result=new Promise(resolve=>child.once('exit',(status,signal)=>{clearTimeout(timer);clearTimeout(killTimer);children.delete(child);resolve({status,signal,stdout,stderr,error});}));
    return {child,result};
  };

  return {root,home,procRoot,environment:Object.freeze({...privateEnvironment}),entry:path.join(root,'.jhw-runtime/bootstrap/jhw-runtime-entry'),write,prepare,run,spawnManaged,spawnRouter,seedPair,baselineRevision,
    compatibility(releaseId){return releaseCompatibility({repositoryRoot:root,releaseId});}};
}
