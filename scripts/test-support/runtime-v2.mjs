import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

import {prepareRelease, releaseCompatibility} from '../runtime-store.mjs';

const scriptsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.dirname(scriptsRoot);

function checkedSpawn(command, args, options, label) {
  const result = spawnSync(command, args, {encoding:'utf8', maxBuffer:128*1024*1024, ...options});
  if (result.status !== 0 || result.signal || result.error) throw new Error(`${label}: ${result.stderr || result.error?.message || 'failed'}`);
  return result;
}

export async function createRuntimeFixture(t, {realDependencies = false, legacyRevision = null} = {}) {
  if (realDependencies) throw new Error('realDependencies build is not available in this fixture phase');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-runtime-v2-fixture-'));
  const home = path.join(root, 'home');
  const procRoot = '/proc';
  const children = new Set();
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(home, {mode: 0o700});
  const privateEnvironment = {...process.env, HOME:home, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1'};
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
  if (legacyRevision !== null) {
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
    write('scripts/runtime-entry.mjs', `
export async function runManaged({selector, args, selectedPair}) {
  if (!selectedPair || selectedPair.runtimeContract !== 2) return {retryCurrent:true};
  process.stdout.write(JSON.stringify({selector,args,selectedPair,artifact:'generation-a',home:process.env.HOME})+'\\n');
  return 0;
}
`);
    write('scripts/jhw-control-hook', '#!/bin/sh\nexit 0\n', 0o755);
  }

  fs.rmSync(path.join(root,'.git'),{recursive:true,force:true});
  checkedSpawn('git',['init','-q'],{cwd:root,env:privateEnvironment},'fixture git init');
  checkedSpawn('git',['add','.'],{cwd:root,env:privateEnvironment},'fixture git add');
  checkedSpawn('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],
    {cwd:root,env:privateEnvironment},'fixture git commit');

  const prepare = () => prepareRelease({repositoryRoot:root,build:async ({stagingRoot}) => {
    const built = (name, bytes = '') => {
      const target = path.join(stagingRoot,name);
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});
      const executable = name.includes('/control/') || name.endsWith('/control.cjs') || name.endsWith('/hook.cjs');
      fs.writeFileSync(target,bytes,{mode:executable?0o755:0o644});
    };
    built('mcp-server/dist/index.js');
    built('mcp-server/dist/control/cli.js');
    built('mcp-server/dist/control/hook-adapter.js');
    built('mcp-server/dist/runtime/mcp.cjs');
    built('mcp-server/dist/runtime/control.cjs');
    built('mcp-server/dist/runtime/hook.cjs');
    fs.mkdirSync(path.join(stagingRoot,'mcp-server/node_modules'),{recursive:true,mode:0o755});
  }});

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

  const run = argv => new Promise(resolve => {
    const child = spawn(path.join(root,'.jhw-runtime/bootstrap',argv[0]),argv.slice(1),
      {env:privateEnvironment,stdio:['ignore','pipe','pipe']});
    children.add(child);
    let stdout=''; let stderr=''; let error=null;
    let killTimer;
    const timer = setTimeout(() => { child.kill('SIGTERM'); killTimer=setTimeout(()=>child.kill('SIGKILL'),200); },12000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',value=>{error=value;});
    child.once('close',(status,signal)=>{clearTimeout(timer);clearTimeout(killTimer);children.delete(child);resolve({status,signal,stdout,stderr,error});});
  });

  return {root,home,procRoot,entry:path.join(root,'.jhw-runtime/bootstrap/jhw-runtime-entry'),write,prepare,run,seedPair,baselineRevision,
    compatibility(releaseId){return releaseCompatibility({repositoryRoot:root,releaseId});}};
}
