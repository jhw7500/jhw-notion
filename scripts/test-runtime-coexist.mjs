import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {randomBytes} from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DeploymentError, acquireLease } from './runtime-safety.mjs';
import { prepareRelease, publishActivation, readActivation, releaseCompatibility,ensureBootstrapGeneration,inspectSessionBindingsV2 } from './runtime-store.mjs';
import {installRouterV2} from './runtime-entry.mjs';
import { runDeployment, wiringPhase, reconcilePairJournal } from './runtime-deploy.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const helpers = ['runtime-entry.mjs','runtime-safety.mjs','runtime-store.mjs','runtime-deploy.mjs','install-wiring.sh','install-config.mjs','jhw-runtime-entry','jhw-runtime-control','jhw-runtime-hook','jhw-control-hook'];
function write(root, name, value, mode=0o644) {
  const file=path.join(root,name);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o755});
  fs.writeFileSync(file,value,{mode}); fs.chmodSync(file,mode); return file;
}
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jhw-coexist-test-')); fs.chmodSync(root,0o700);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home'); const procRoot=path.join(root,'proc');
  fs.mkdirSync(home,{mode:0o700}); fs.mkdirSync(procRoot,{mode:0o700});
  for(const [name,value] of Object.entries({
    '.gitignore':'.jhw-runtime/\nhome/\nproc/\n',
    'mcp-server/package.json':'{"type":"module"}','mcp-server/package-lock.json':'{"lockfileVersion":3}',
    'mcp-server/tsconfig.json':'{}','mcp-server/src/index.ts':'export const generation=1;','mcp-server/src/config.ts':'export const config=1;',
    'mcp-server/src/control/runtime-compatibility.json':'{"version":1,"generation":1,"guardFloor":1}\n',
    'mcp-server/src/control/hook-adapter.ts':'export const implementation="A";',
    'mcp-server/src/control/schemas.ts':'export const stateVersion=1;',
    'mcp-server/scripts/clean-dist.mjs':'','scripts/sync-codex-skills.mjs':'',
    'skills/claude/task.md':'same immutable skills','skills/codex/jhw-task/SKILL.md':'generated fixture skill',
  })) write(root,name,value);
  for(const name of helpers) write(root,'scripts/'+name,fs.readFileSync(path.join(source,name)),name.startsWith('jhw-')?0o755:0o644);
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]) {
    const r=spawnSync('git',args,{cwd:root,encoding:'utf8'}); assert.equal(r.status,0,r.stderr);
  }
  let broken=false;let implementation='A';let mcpOptions={protocolVersion:'2024-11-05',capabilities:{},tools:[{name:'fixture',inputSchema:{type:'object'}}]};
  const build=async({stagingRoot})=>{
    const stableControl="process.stdout.write(JSON.stringify({release:require('node:path').basename(globalThis.__JHW_MANAGED_RELEASE_ROOT__)})+'\\n');if(process.argv.includes('--hold'))process.stdin.resume();";
    const control="// "+implementation+"\n"+stableControl;
    const hook="// "+implementation+"\nconst event=process.argv.at(-1);const release=require('node:path').basename(globalThis.__JHW_MANAGED_RELEASE_ROOT__);if(process.env.JHW_TEST_TRACE)require('node:fs').appendFileSync(process.env.JHW_TEST_TRACE,JSON.stringify({event,release})+'\\n');const value=event==='SessionEnd'?{}:event==='PostToolUse'?{systemMessage:release}:event==='UserPromptSubmit'?{hookSpecificOutput:{hookEventName:event,additionalContext:release},systemMessage:release}:{hookSpecificOutput:{hookEventName:event}};process.stdout.write(JSON.stringify(value)+'\\n');";
    const mcp=broken?"process.stderr.write('candidate failed\\n');process.exitCode=1;":String.raw`
      const contract=__MCP_CONTRACT__;
      const lines=require('node:readline').createInterface({input:process.stdin});
      lines.on('line',line=>{const request=JSON.parse(line);if(!request.id)return;
        const result=request.method==='initialize'?{protocolVersion:contract.protocolVersion,serverInfo:{name:'fixture',version:require('node:path').basename(globalThis.__JHW_MANAGED_RELEASE_ROOT__)},capabilities:contract.capabilities}:{tools:contract.tools,...(Object.hasOwn(contract,'nextCursor')?{nextCursor:contract.nextCursor}:{})};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
      });`.replace('__MCP_CONTRACT__',JSON.stringify(mcpOptions));
    for(const [name,body,mode] of [
      ['mcp-server/dist/index.js',mcp,0o644],['mcp-server/dist/control/cli.js',stableControl,0o755],
      ['mcp-server/dist/control/hook-adapter.js',hook,0o755],['mcp-server/dist/runtime/mcp.cjs',mcp,0o644],
      ['mcp-server/dist/runtime/control.cjs',control,0o755],['mcp-server/dist/runtime/hook.cjs',hook,0o755],
    ]) write(stagingRoot,name,body,mode);
    fs.mkdirSync(path.join(stagingRoot,'mcp-server/node_modules'),{mode:0o755});
  };
  const prepare=()=>prepareRelease({repositoryRoot:root,build});
  const first=await prepare();
  const hostContract={commands:['unlock','preflight','portfolio status','task start','task child-start','task contract','task completion-ready','task promote','task status','task handoff','task finish','task recover','task assert-owner','board status','board acquire','board with'],credential_policy:'secure-store-only',name:'jhw-control-host',version:5};
  write(home,'.local/bin/jhw-control-host',`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(hostContract)}'\n`,0o755);
  for(const name of ['.claude','.gemini','.codex','.config/opencode'])fs.mkdirSync(path.join(home,name),{recursive:true,mode:0o700});
  await runDeployment({repositoryRoot:root,home,procRoot,argv:['--activate',first.releaseId],
    phaseRunner:options=>options.phase==='validate'?undefined:wiringPhase(options)});
  return {root,home,procRoot,first,prepare,breakCandidate:()=>{broken=true;},changeImplementation:()=>{implementation='B';write(root,'mcp-server/src/control/hook-adapter.ts','export const implementation="B";');write(root,'skills/claude/task.md','changed ordinary Markdown');write(root,'skills/codex/jhw-task/SKILL.md','changed generated Markdown');},configureMcp:value=>{mcpOptions={...mcpOptions,...value};},entry:path.join(root,'.jhw-runtime/bootstrap/jhw-runtime-entry')};
}
function seedV2Current(f,pair,priorCurrent=null) {
  const activationId=`a-${randomBytes(16).toString('hex')}`;
  const activation=path.join(f.root,'.jhw-runtime/v2/activations',activationId);
  fs.mkdirSync(activation,{recursive:true,mode:0o700});
  for(const directory of [path.join(f.root,'.jhw-runtime/v2'),path.dirname(activation),activation])fs.chmodSync(directory,0o700);
  for(const name of ['mcp-server','scripts','skills'])fs.symlinkSync(`../../../releases/${pair.releaseId}/${name}`,path.join(activation,name));
  fs.symlinkSync(`../../bootstraps/${pair.bootstrapId}`,path.join(activation,'bootstrap'));
  const manifest={version:2,activationId,...pair,predecessorActivationId:priorCurrent?.activationId??null,migrationId:null,createdAt:new Date().toISOString(),priorCurrent};
  write(activation,'manifest.json',JSON.stringify(manifest)+'\n',0o600);
  const current=path.join(f.root,'.jhw-runtime/current');fs.unlinkSync(current);fs.symlinkSync(`v2/activations/${activationId}`,current);
  return readActivation({repositoryRoot:f.root});
}
async function v2Fixture(t) {
  const f=await fixture(t);
  write(f.root,'mcp-server/src/control/runtime-compatibility.json','{"version":1,"generation":2,"guardFloor":1}\n');
  write(f.root,'mcp-server/src/index.ts','export const generation="v2-a";');
  const releaseA=await f.prepare();const deploy=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const admission=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'));
  let pairA;try{
    pairA=ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease:deploy});
    await installRouterV2({repositoryRoot:f.root,releaseId:releaseA.releaseId,deployLease:deploy,admissionLease:admission});
  }finally{admission.close();deploy.close();}
  seedV2Current(f,pairA);return {...f,pairA,releaseA};
}
function pairForToken(f,token) {
  const row=inspectSessionBindingsV2({repositoryRoot:f.root}).find(item=>item.kind==='session'&&item.token===token&&item.live);
  assert.ok(row,`live v2 root binding missing for ${token}; rows=${JSON.stringify(inspectSessionBindingsV2({repositoryRoot:f.root}).map(item=>({token:item.token,kind:item.kind,live:item.live})))}`);
  return {releaseId:row.releaseId,bootstrapId:row.bootstrapId,runtimeContract:row.runtimeContract,compatibilityDigest:row.compatibilityDigest};
}
function run(f,args,options={}) {
  return spawnSync(process.execPath,[f.entry,...args],{encoding:'utf8',timeout:12000,...options});
}
const sampleClient=String.raw`
const {spawnSync}=require('node:child_process');
const r=spawnSync(process.execPath,[process.argv[1],'control'],{encoding:'utf8'});
process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status??1;
`;

test('session launcher pins its later control invocation to one release',async t=>{
  const f=await fixture(t);
  const r=run(f,['session','--',process.execPath,'-e',sampleClient,f.entry]);
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout),{release:f.first.releaseId});
});
test('unknown inherited session binding refuses without falling back to current',async t=>{
  const f=await fixture(t);
  const r=run(f,['control'],{env:{...process.env,JHW_RUNTIME_SESSION_BINDING:'s-'+('1'.repeat(32))+':'+('2'.repeat(64))}});
  assert.equal(r.status,75);
  assert.match(r.stderr,/DEPLOY_SESSION_INVALID/);
  assert.equal(r.stdout,'');
});

test('compatible activation validates candidate before changing the default',async t=>{
  const f=await fixture(t);
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');
  const second=await f.prepare();
  const result=await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',second.releaseId],phaseRunner:async()=>{}});
  assert.equal(result.code,'DEPLOY_COMPATIBLE_ACTIVATED');
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,second.releaseId);
});

const persistentClient=String.raw`const fs=require('node:fs');const {spawnSync}=require('node:child_process');const readline=require('node:readline');
const [entry,trace]=process.argv.slice(1);
const call=(args,input='',environment=process.env)=>spawnSync(process.execPath,[entry,...args],{encoding:'utf8',input,env:environment});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
send({ready:true});
readline.createInterface({input:process.stdin}).on('line',command=>{
  try {
    if(command==='exit'){process.exit(0);return;}
    if(command==='lost-pin'){const environment={...process.env};delete environment.JHW_RUNTIME_SESSION_BINDING;const r=call(['control'],'',environment);send({status:r.status,stderr:r.stderr,stdout:r.stdout});return;}
    const control=call(['control']);if(control.status!==0)throw new Error(control.stderr);
    const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}].map(JSON.stringify).join('\n')+'\n';
    const mcp=call(['mcp'],input);if(mcp.status!==0)throw new Error(mcp.stderr);
    const events=['PreToolUse','PostToolUse','UserPromptSubmit','SessionEnd'];const codes=[];
    for(const event of events){const r=call(['hook','--adapter','codex','--event',event],'{}');codes.push(r.status);}
    const hooks=fs.readFileSync(trace,'utf8').trim().split('\n').slice(-4).map(JSON.parse);
    send({control:JSON.parse(control.stdout).release,mcp:mcp.stdout.trim().split('\n').map(JSON.parse).find(x=>x.id===1).result.serverInfo.version,hooks,codes,token:process.env.JHW_RUNTIME_SESSION_BINDING});
  }catch(error){send({error:error.message});}
});`;

async function until(check,label) {
  const deadline=Date.now()+10000;
  while(!check()){if(Date.now()>deadline)assert.fail('timed out: '+label);await new Promise(resolve=>setTimeout(resolve,10));}
}
function startClient(t,f) {
  const trace=path.join(f.root,'trace-'+Math.random().toString(16).slice(2)+'.jsonl');
  const child=spawn(process.execPath,[f.entry,'session','--',process.execPath,'-e',persistentClient,f.entry,trace],{
    stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C',JHW_TEST_TRACE:trace}});
  let buffered='';let stderr='';const messages=[];
  child.stdout.on('data',chunk=>{buffered+=chunk;let n;while((n=buffered.indexOf('\n'))>=0){messages.push(JSON.parse(buffered.slice(0,n)));buffered=buffered.slice(n+1);}});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const done=once(child,'close');
  t.after(async()=>{child.stdin.end();await done;});
  return {child,done,ready:async()=>{await until(()=>messages.length||child.exitCode!==null,'session ready '+stderr);assert.equal(child.exitCode,null,stderr);assert.deepEqual(messages.shift(),{ready:true});},
    request:async command=>{child.stdin.write(command+'\n');await until(()=>messages.length||child.exitCode!==null,'client response '+stderr);const result=messages.shift();assert.ok(result,stderr);assert.equal(result.error,undefined);return result;}};
}
function snapshotConsumer(f,pid) {
  const name=path.join(f.procRoot,String(pid));fs.mkdirSync(name,{mode:0o700});
  for(const file of ['stat','status','cmdline']) write(name,file,fs.readFileSync('/proc/'+pid+'/'+file),0o600);
  write(name,'environ','',0o600);fs.symlinkSync(f.root,path.join(name,'cwd'));
}
function assertSample(sample,release) {
  assert.equal(sample.control,release);assert.equal(sample.mcp,release);
  assert.deepEqual(sample.codes,[0,0,0,0]);assert.equal(sample.hooks.length,4);
  assert.deepEqual(sample.hooks.map(x=>x.event),['PreToolUse','PostToolUse','UserPromptSubmit','SessionEnd']);
  assert.ok(sample.hooks.every(x=>x.release===release));
}
const compatible=(f,releaseId)=>runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate-compatible',releaseId],phaseRunner:async()=>{}});
test('live A keeps control, reconnecting MCP and every hook on A while new B uses B',async t=>{
  const f=await fixture(t);const a=startClient(t,f);await a.ready();
  snapshotConsumer(f,a.child.pid);assertSample(await a.request('sample'),f.first.releaseId);
  f.changeImplementation();const second=await f.prepare();
  let verifiedRealWiring=false;
  const published=await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',second.releaseId],phaseRunner:async options=>{verifiedRealWiring=true;return wiringPhase(options);}});
  assert.equal(verifiedRealWiring,true);
  assert.equal(published.inventory.before.bound.managed,1);assert.equal(a.child.exitCode,null);
  assertSample(await a.request('sample'),f.first.releaseId);
  const b=startClient(t,f);await b.ready();assertSample(await b.request('sample'),second.releaseId);
  snapshotConsumer(f,b.child.pid);await compatible(f,f.first.releaseId);
  assertSample(await a.request('sample'),f.first.releaseId);assertSample(await b.request('sample'),second.releaseId);
  const c=startClient(t,f);await c.ready();assertSample(await c.request('sample'),f.first.releaseId);
  assert.throws(()=>acquireLease(path.join(f.root,'.jhw-runtime/admission.lock')),{code:'DEPLOY_LOCK_CONTENDED'});
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate',f.first.releaseId],phaseRunner:async()=>{}}),{code:'DEPLOY_CONSUMERS_ACTIVE'});
});
test('v2 compatible publication keeps both bound pairs callable',async t=>{
  const f=await v2Fixture(t);const samples=[];
  const a=startClient(t,f);await a.ready();snapshotConsumer(f,a.child.pid);
  const oldResponse=await a.request('sample');assertSample(oldResponse,f.pairA.releaseId);const oldSample={...oldResponse,pair:pairForToken(f,oldResponse.token)};samples.push(oldSample);
  assert.deepEqual(oldSample.pair,f.pairA);
  write(f.root,'mcp-server/src/index.ts','export const generation="v2-b";');const releaseB=await f.prepare();
  let verifiedRealWiring=false;const published=await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',releaseB.releaseId],phaseRunner:async options=>{verifiedRealWiring=true;return wiringPhase(options);}});
  assert.equal(published.code,'DEPLOY_COMPATIBLE_ACTIVATED');
  assert.equal(verifiedRealWiring,true);
  const selected=readActivation({repositoryRoot:f.root});
  const pairB={releaseId:selected.releaseId,bootstrapId:selected.bootstrapId,runtimeContract:selected.runtimeContract,
    compatibilityDigest:selected.compatibilityDigest};
  const b=startClient(t,f);await b.ready();snapshotConsumer(f,b.child.pid);
  const newResponse=await b.request('sample');assertSample(newResponse,pairB.releaseId);const newSample={...newResponse,pair:pairForToken(f,newResponse.token)};samples.push(newSample);
  assert.deepEqual(newSample.pair,pairB);
  const rollback=await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--rollback'],phaseRunner:async()=>{}});
  assert.equal(rollback.code,'DEPLOY_ROLLED_BACK');
  const afterA=await a.request('sample');const afterB=await b.request('sample');
  assertSample(afterA,f.pairA.releaseId);assertSample(afterB,pairB.releaseId);
  samples.push({...afterA,pair:pairForToken(f,afterA.token)});
  samples.push({...afterB,pair:pairForToken(f,afterB.token)});
  assert.deepEqual(samples.at(-2).pair,f.pairA);assert.deepEqual(samples.at(-1).pair,pairB);
  assert.ok(samples.every(row=>row.codes.every(code=>code===0)));
  assert.equal((await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--status']})).recoveryPending,0);
});
test('v2 activate-compatible rejects incompatible candidate without consumers',async t=>{
  const f=await v2Fixture(t);const before=readActivation({repositoryRoot:f.root});
  write(f.root,'mcp-server/src/control/schemas.ts','export const stateVersion=99;');const candidate=await f.prepare();
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',candidate.releaseId],phaseRunner:async()=>{}}),{code:'DEPLOY_COMPATIBILITY_MISMATCH'});
  assert.deepEqual(readActivation({repositoryRoot:f.root}),before);
});

test('v2 publication EX performs no retained release payload reads',async t=>{
  const f=await v2Fixture(t);const a=startClient(t,f);await a.ready();snapshotConsumer(f,a.child.pid);
  write(f.root,'mcp-server/src/index.ts','export const generation="v2-no-ex-read";');const candidate=await f.prepare();
  let exclusive=false;const payloadReads=[];const original=fs.readSync;fs.readSync=function(fd,...args){
    if(exclusive){try{const file=fs.readlinkSync(`/proc/self/fd/${fd}`);if(file.includes('/.jhw-runtime/releases/'))payloadReads.push(file);}catch{}}
    return original.call(this,fd,...args);
  };
  const phase=async()=>{};phase.observe=value=>{if(value.phase==='publication_acquired')exclusive=true;if(value.phase==='publication_released')exclusive=false;};
  try{await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',candidate.releaseId],phaseRunner:phase});}finally{fs.readSync=original;}
  assert.deepEqual(payloadReads,[]);
});

test('pre-pointer cleanup failure still releases every deployment lease',async t=>{
  const f=await v2Fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation="v2-cleanup";');const candidate=await f.prepare();
  const sync=fs.fsyncSync;let inject=false;fs.fsyncSync=function(fd){
    if(inject){try{if(fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('candidate-probe.log'))throw new Error('injected log fsync failure');}catch(error){if(error.message.includes('injected'))throw error;}}
    return sync.call(this,fd);
  };
  const phase=async()=>{};phase.observe=value=>{if(value.phase==='publication_acquired'){
    const current=path.join(f.root,'.jhw-runtime/current');const target=fs.readlinkSync(current);fs.unlinkSync(current);fs.symlinkSync(target,current);inject=true;
  }};
  try{await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',candidate.releaseId],phaseRunner:phase}),/injected log fsync failure/);}finally{fs.fsyncSync=sync;}
  const safety=new URL('./runtime-safety.mjs',import.meta.url).href;
  for(const name of ['publication.lock','admission.lock','deploy.lock']){
    const source=`import {acquireLease} from ${JSON.stringify(safety)};const lease=acquireLease(process.argv[1]);lease.close();`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',source,path.join(f.root,'.jhw-runtime',name)],{encoding:'utf8'});
    assert.equal(result.status,0,`${name}: ${result.stderr}`);
  }
});
test('v2 candidate MCP contract rejection preserves current',async t=>{
  const f=await v2Fixture(t);const a=startClient(t,f);await a.ready();snapshotConsumer(f,a.child.pid);
  const before=readActivation({repositoryRoot:f.root});f.configureMcp({tools:[]});
  write(f.root,'mcp-server/src/index.ts','export const generation="v2-contract-rejected";');const candidate=await f.prepare();
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',candidate.releaseId],phaseRunner:async()=>{}}),{code:'DEPLOY_CONSUMERS_ACTIVE',reason:'stopped_rollback_required'});
  assert.deepEqual(readActivation({repositoryRoot:f.root}),before);
  const journal=fs.readdirSync(path.join(f.root,'.jhw-runtime/v2/journals')).find(name=>name.startsWith('d-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'.jhw-runtime/v2/journals',journal,'state.json'),'utf8')).status,'complete');
});
test('v2 publication refuses an unknown legacy consumer',async t=>{
  const f=await v2Fixture(t);const before=readActivation({repositoryRoot:f.root});
  const p=path.join(f.procRoot,'101');fs.mkdirSync(p);write(p,'status','Uid:\t'+[process.getuid(),process.getuid(),process.getuid(),process.getuid()].join('\t')+'\n',0o600);
  write(p,'stat','101 (fixture) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0\n',0o600);
  write(p,'cmdline','jhw-control\0',0o600);write(p,'environ','',0o600);fs.symlinkSync(f.root,path.join(p,'cwd'));
  write(f.root,'mcp-server/src/index.ts','export const generation="v2-unknown-consumer";');const candidate=await f.prepare();
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',candidate.releaseId],phaseRunner:async()=>{}}),{code:'DEPLOY_CONSUMERS_ACTIVE'});
  assert.deepEqual(readActivation({repositoryRoot:f.root}),before);
});
test('v2 publication rejects current identity replacement before pointer intent',async t=>{
  const f=await v2Fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation="v2-current-race";');const candidate=await f.prepare();
  const phase=async()=>{};phase.observe=value=>{
    if(value.phase!=='publication_acquired')return;
    const current=path.join(f.root,'.jhw-runtime/current');const target=fs.readlinkSync(current);fs.unlinkSync(current);fs.symlinkSync(target,current);
  };
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',candidate.releaseId],phaseRunner:phase}),{code:'DEPLOY_CURRENT_CHANGED'});
  const journals=fs.readdirSync(path.join(f.root,'.jhw-runtime/v2/journals')).filter(name=>name.startsWith('d-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'.jhw-runtime/v2/journals',journals[0],'state.json'),'utf8')).status,'pending');
});
test('v2 publication keeps probes and log fsync outside exclusive interval',async t=>{
  const f=await v2Fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation="v2-timing";');const candidate=await f.prepare();
  const events=[];const phase=async()=>{};phase.observe=value=>{
    const event={...value,observedNs:String(process.hrtime.bigint())};
    if(value.phase==='root_index_held'){
      const safety=new URL('./runtime-safety.mjs',import.meta.url).href;
      const source=`import {acquireLease} from ${JSON.stringify(safety)};try{acquireLease(process.argv[1]);console.log('acquired')}catch(error){console.log(error.code)}`;
      const result=spawnSync(process.execPath,['--input-type=module','-e',source,path.join(f.root,'.jhw-runtime/v2/session-index.lock')],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);event.contender=result.stdout.trim();
    }
    events.push(event);
  };
  await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',candidate.releaseId],phaseRunner:phase});
  for(const name of ['candidate_probe_start','candidate_probe_complete','log_fsync_start','log_fsync_complete'])
    assert.equal(events.find(row=>row.phase===name)?.exclusive,false,name);
  for(const name of ['publication_acquired','pointer_intent','pointer_renamed'])assert.equal(events.find(row=>row.phase===name)?.exclusive,true,name);
  assert.equal(events.find(row=>row.phase==='publication_released')?.exclusive,false);
  assert.equal(events.find(row=>row.phase==='root_index_held')?.contender,'DEPLOY_LOCK_CONTENDED');
  assert.ok(BigInt(events.find(row=>row.phase==='pointer_renamed').elapsedNs)<1_000_000_000n);
  const acquired=BigInt(events.find(row=>row.phase==='publication_acquired').observedNs);
  const released=BigInt(events.find(row=>row.phase==='publication_released').observedNs);
  assert.ok(released-acquired<1_000_000_000n);
  console.log(JSON.stringify({timing:events}));
});
test('v2 publication aborts over-budget caller recheck before pointer rename',async t=>{
  const f=await v2Fixture(t);const before=readActivation({repositoryRoot:f.root});
  write(f.root,'mcp-server/src/index.ts','export const generation="v2-budget";');const candidate=await f.prepare();
  const phase=async()=>{};phase.observe=value=>{if(value.phase==='publication_acquired'){const until=Date.now()+1050;while(Date.now()<until){}}};
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,
    argv:['--activate-compatible',candidate.releaseId],phaseRunner:phase}),{code:'DEPLOY_SOURCE_CHANGED'});
  assert.deepEqual(readActivation({repositoryRoot:f.root}),before);
});
test('v2 rollback reconstructs a reclaimed predecessor generation from catalog source',async t=>{
  const f=await v2Fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation="v2-reconstruct-b";');const candidate=await f.prepare();
  await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate-compatible',candidate.releaseId],phaseRunner:async()=>{}});
  const reclaimed=path.join(f.root,'.jhw-runtime/v2/bootstraps',f.pairA.bootstrapId);fs.rmSync(reclaimed,{recursive:true});
  const rolled=await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--rollback'],phaseRunner:async()=>{}});
  assert.equal(rolled.releaseId,f.pairA.releaseId);assert.equal(fs.existsSync(reclaimed),true);
  const a=startClient(t,f);await a.ready();const sample=await a.request('sample');assert.equal(sample.control,f.pairA.releaseId);
  assert.deepEqual(pairForToken(f,sample.token),f.pairA);
});
test('noncompatible v2 rollback uses admission EX after consumers stop',async t=>{
  const f=await v2Fixture(t);f.configureMcp({tools:[{name:'fixture',inputSchema:{type:'object',required:['changed']}}]});
  write(f.root,'mcp-server/src/index.ts','export const generation="v2-stopped-b";');const candidate=await f.prepare();
  const prior=readActivation({repositoryRoot:f.root});const deploy=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  let pairB;try{pairB=ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:candidate.releaseId,deployLease:deploy});}finally{deploy.close();}
  seedV2Current(f,pairB,prior);
  let contender;const phase=async()=>{};phase.observe=value=>{
    if(value.phase!=='publication_acquired')return;
    const safety=new URL('./runtime-safety.mjs',import.meta.url).href;
    const source=`import {acquireLease} from ${JSON.stringify(safety)};try{acquireLease(process.argv[1],{shared:true});console.log('acquired')}catch(error){console.log(error.code)}`;
    contender=spawnSync(process.execPath,['--input-type=module','-e',source,path.join(f.root,'.jhw-runtime/admission.lock')],{encoding:'utf8'}).stdout.trim();
  };
  const rolled=await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--rollback'],phaseRunner:phase});
  assert.equal(rolled.releaseId,f.pairA.releaseId);assert.equal(contender,'DEPLOY_LOCK_CONTENDED');
});
async function interruptedV2Pair(t,phase) {
  const f=await v2Fixture(t);write(f.root,'mcp-server/src/index.ts',`export const generation=${JSON.stringify(phase)};`);const candidate=await f.prepare();
  const moduleUrl=new URL('./runtime-deploy.mjs',import.meta.url).href;
  const childSource=`import {runDeployment} from ${JSON.stringify(moduleUrl)};const phase=async()=>{};phase.observe=value=>{if(value.phase===process.argv[1])process.exit(37)};await runDeployment({...JSON.parse(process.argv[2]),phaseRunner:phase});`;
  const options={repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate-compatible',candidate.releaseId]};
  const result=spawnSync(process.execPath,['--input-type=module','-e',childSource,phase,JSON.stringify(options)],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,37,result.stderr);
  const journals=fs.readdirSync(path.join(f.root,'.jhw-runtime/v2/journals')).filter(name=>name.startsWith('d-'));
  assert.equal(journals.length,1);const journalDirectory=path.join(f.root,'.jhw-runtime/v2/journals',journals[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(journalDirectory,'state.json'),'utf8')).status,'pending');
  return {f,candidate,journalDirectory,options};
}
for(const phase of ['pointer_intent','pointer_renamed'])test(`v2 pair journal recovers crash at ${phase}`,async t=>{
  const interrupted=await interruptedV2Pair(t,phase);
  const recovered=await runDeployment({...interrupted.options,phaseRunner:async()=>{}});
  assert.equal(recovered.recovery.outcome,phase==='pointer_intent'?'pointer_not_published':'pointer_published');
  const recoveredJournal=JSON.parse(fs.readFileSync(path.join(interrupted.journalDirectory,'state.json'),'utf8'));
  assert.equal(recoveredJournal.status,'complete');
});
test('published journal rejects exact post-rename ctime mismatch',async t=>{
  const interrupted=await interruptedV2Pair(t,'published_checkpointed');
  const current=path.join(interrupted.f.root,'.jhw-runtime/current');const moved=current+'.moved';
  const before=fs.lstatSync(current,{bigint:true});fs.renameSync(current,moved);spawnSync('/bin/sleep',['0.02']);fs.renameSync(moved,current);
  const after=fs.lstatSync(current,{bigint:true});assert.equal(after.ino,before.ino);assert.notEqual(after.ctimeNs,before.ctimeNs);
  assert.throws(()=>reconcilePairJournal({repositoryRoot:interrupted.f.root,journalDirectory:interrupted.journalDirectory}),{code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(interrupted.journalDirectory,'state.json'),'utf8')).status,'pending');
});
test('pointer intent rejects replacement of the witness symlink alone',async t=>{
  const interrupted=await interruptedV2Pair(t,'pointer_intent');
  const pointer=path.join(interrupted.journalDirectory,'pointer-witness/current');const target=fs.readlinkSync(pointer);
  const before=fs.lstatSync(pointer,{bigint:true});fs.unlinkSync(pointer);fs.symlinkSync(target,pointer);
  assert.notEqual(fs.lstatSync(pointer,{bigint:true}).ino,before.ino);
  assert.throws(()=>reconcilePairJournal({repositoryRoot:interrupted.f.root,journalDirectory:interrupted.journalDirectory}),{code:'DEPLOY_RECOVERY_REQUIRED'});
});
for(const mutation of ['same bytes rewrite','content change','directory replacement'])test(`pointer intent keeps changed origin evidence pending: ${mutation}`,async t=>{
  const interrupted=await interruptedV2Pair(t,'pointer_intent');
  const state=JSON.parse(fs.readFileSync(path.join(interrupted.journalDirectory,'state.json'),'utf8'));
  const activation=path.join(interrupted.f.root,'.jhw-runtime/v2/activations',state.origin.activationId);const manifest=path.join(activation,'manifest.json');
  if(mutation==='same bytes rewrite'){const bytes=fs.readFileSync(manifest);spawnSync('/bin/sleep',['0.02']);fs.writeFileSync(manifest,bytes);}
  else if(mutation==='content change'){const value=JSON.parse(fs.readFileSync(manifest,'utf8'));value.createdAt=new Date(Date.parse(value.createdAt)+1000).toISOString();fs.writeFileSync(manifest,JSON.stringify(value)+'\n');}
  else {const moved=activation+'.moved';fs.renameSync(activation,moved);fs.cpSync(moved,activation,{recursive:true,dereference:false,preserveTimestamps:true});fs.chmodSync(activation,0o700);fs.chmodSync(manifest,0o600);}
  assert.throws(()=>reconcilePairJournal({repositoryRoot:interrupted.f.root,journalDirectory:interrupted.journalDirectory}),{code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(interrupted.journalDirectory,'state.json'),'utf8')).status,'pending');
});
test('rollback rejects a missing predecessor activation before reconstruction',async t=>{
  const f=await v2Fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation="v2-missing-predecessor";');const candidate=await f.prepare();
  const prior=readActivation({repositoryRoot:f.root});const deploy=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));let pair;
  try{pair=ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:candidate.releaseId,deployLease:deploy});}finally{deploy.close();}
  const current=seedV2Current(f,pair,prior);fs.renameSync(path.join(f.root,'.jhw-runtime/v2/activations',current.predecessorActivationId),path.join(f.root,'.jhw-runtime/v2/activations','.missing-predecessor'));
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--rollback'],phaseRunner:async()=>{}}),{code:'DEPLOY_PREDECESSOR_INVALID'});
});
test('v2 publication rejects a live cross-process v1 session root',async t=>{
  const f=await v2Fixture(t);const storeUrl=new URL('./runtime-store.mjs',import.meta.url).href;
  const source=`import readline from 'node:readline';import {createSessionBinding} from ${JSON.stringify(storeUrl)};const binding=createSessionBinding({repositoryRoot:process.argv[1],releaseId:process.argv[2]});console.log('ready');readline.createInterface({input:process.stdin}).once('line',()=>{binding.close();process.exit(0)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,f.root,f.pairA.releaseId],{stdio:['pipe','pipe','pipe']});let output='';let error='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{error+=chunk});
  await until(()=>output.includes('ready')||child.exitCode!==null,'v1 session ready');assert.equal(child.exitCode,null,error);let closed=false;
  t.after(async()=>{if(!closed&&child.exitCode===null)child.stdin.write('exit\n');if(!closed){await once(child,'close').catch(()=>{});closed=true;}});
  write(f.root,'mcp-server/src/index.ts','export const generation="v2-v1-reject";');const candidate=await f.prepare();
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate-compatible',candidate.releaseId],phaseRunner:async()=>{}}),{code:'DEPLOY_COMPATIBILITY_MISMATCH',reason:'v1_session'});
  child.stdin.write('exit\n');await once(child,'close');closed=true;assert.equal(child.exitCode,0,error);
});
test('publication accepts an actual root that exits and is removed while EX is held',async t=>{
  const f=await v2Fixture(t);const client=startClient(t,f);await client.ready();const root=inspectSessionBindingsV2({repositoryRoot:f.root}).find(row=>row.kind==='session'&&row.live);
  assert.ok(root);write(f.root,'mcp-server/src/index.ts','export const generation="v2-root-exit";');const candidate=await f.prepare();let removed=false;
  const phase=async()=>{};phase.observe=value=>{if(value.phase==='publication_acquired'){
    client.child.stdin.write('exit\n');const directory=path.join(f.root,'.jhw-runtime/v2/sessions',root.id);
    for(let attempt=0;attempt<500&&fs.existsSync(directory);attempt++)spawnSync('/bin/sleep',['0.01']);removed=!fs.existsSync(directory);
  }};
  const result=await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate-compatible',candidate.releaseId],phaseRunner:phase});
  assert.equal(removed,true);assert.equal(result.inventory.after.roots.length,0);await client.done;
});
test('v2 pointer intent rejects a foreign same-target current symlink',async t=>{
  const {f,options,journalDirectory}=await interruptedV2Pair(t,'pointer_renamed');
  const current=path.join(f.root,'.jhw-runtime/current');const target=fs.readlinkSync(current);fs.unlinkSync(current);fs.symlinkSync(target,current);
  await assert.rejects(runDeployment({...options,phaseRunner:async()=>{}}),{code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(journalDirectory,'state.json'),'utf8')).status,'pending');
});
for(const mutation of ['missing','replaced'])test(`v2 pointer intent rejects ${mutation} witness directory`,async t=>{
  const {f,options,journalDirectory}=await interruptedV2Pair(t,'pointer_renamed');const witness=path.join(journalDirectory,'pointer-witness');
  fs.unlinkSync(path.join(witness,'current'));fs.rmdirSync(witness);
  if(mutation==='replaced'){fs.mkdirSync(witness,{mode:0o700});fs.linkSync(path.join(f.root,'.jhw-runtime/current'),path.join(witness,'current'));}
  await assert.rejects(runDeployment({...options,phaseRunner:async()=>{}}),{code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(journalDirectory,'state.json'),'utf8')).status,'pending');
});
test('v2 pointer intent rejects changed destination manifest evidence',async t=>{
  const {f,journalDirectory}=await interruptedV2Pair(t,'pointer_renamed');
  const state=JSON.parse(fs.readFileSync(path.join(journalDirectory,'state.json'),'utf8'));
  const manifest=path.join(f.root,'.jhw-runtime/v2/activations',state.destination.activationId,'manifest.json');
  const bytes=fs.readFileSync(manifest);fs.writeFileSync(manifest,bytes); // ctime changes while canonical content stays identical.
  const {reconcilePairJournal}=await import('./runtime-deploy.mjs');
  assert.throws(()=>reconcilePairJournal({repositoryRoot:f.root,journalDirectory}),{code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(journalDirectory,'state.json'),'utf8')).status,'pending');
});
test('a session descendant that loses its pin is denied after promotion',async t=>{
  const f=await fixture(t);const a=startClient(t,f);await a.ready();snapshotConsumer(f,a.child.pid);
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');const second=await f.prepare();await compatible(f,second.releaseId);
  const result=await a.request('lost-pin');assert.equal(result.status,75);assert.match(result.stderr,/DEPLOY_SESSION_INVALID/);assert.equal(result.stdout,'');
});
test('failed candidate initialization preserves the default and clears only the rejected transaction',async t=>{
  const f=await fixture(t);f.breakCandidate();write(f.root,'mcp-server/src/index.ts','export const broken=true;');
  const candidate=await f.prepare();
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_VALIDATION_FAILED'});
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,f.first.releaseId);
  assert.equal((await runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--status']})).recoveryPending,0);
});
for(const [label,name,value] of [
  ['shared state','mcp-server/src/control/schemas.ts','export const stateVersion=2;'],
  ['public config','mcp-server/src/config.ts','export const config=2;'],
  ['generation','mcp-server/src/control/runtime-compatibility.json','{"version":1,"generation":2,"guardFloor":1}\n'],
  ['guard floor','mcp-server/src/control/runtime-compatibility.json','{"version":1,"generation":1,"guardFloor":2}\n'],
  ['new control file','mcp-server/src/control/new-implementation.ts','export const value=1;'],
  ['bootstrap','scripts/jhw-runtime-hook','#!/usr/bin/env node\n// changed\n'],
])test('compatible activation rejects changed '+label+' without moving the default',async t=>{
  const f=await fixture(t);write(f.root,name,value,name.startsWith('scripts/jhw-')?0o755:0o644);const candidate=await f.prepare();
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_COMPATIBILITY_MISMATCH'});
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,f.first.releaseId);
});
test('an unbound legacy consumer remains a blocker rather than being adopted',async t=>{
  const f=await fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  const p=path.join(f.procRoot,'100');fs.mkdirSync(p);
  write(p,'status','Uid:\t'+[process.getuid(),process.getuid(),process.getuid(),process.getuid()].join('\t')+'\n',0o600);
  write(p,'stat','100 (fixture) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0\n',0o600);
  write(p,'cmdline','codex\0',0o600);write(p,'environ','',0o600);
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_CONSUMERS_ACTIVE'});
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,f.first.releaseId);
});
test('a publication lock blocks selection before launching any target',async t=>{
  const f=await fixture(t);
  const lock=acquireLease(path.join(f.root,'.jhw-runtime/publication.lock'),{create:true});
  try {const r=run(f,['control']);assert.equal(r.status,75);assert.match(r.stderr,/DEPLOY_MAINTENANCE/);assert.equal(r.stdout,'');}
  finally {lock.close();}
});

test('an unbound managed invocation blocks a compatible update even without a classified proc entry',async t=>{
  const f=await fixture(t);
  const child=spawn(process.execPath,[f.entry,'control','--hold'],{stdio:['pipe','pipe','pipe']});
  let output='';let stderr='';child.stdout.on('data',part=>{output+=part;});child.stderr.on('data',part=>{stderr+=part;});
  const done=once(child,'close');t.after(async()=>{child.stdin.end();await done;});
  await until(()=>output.includes('\n')||child.exitCode!==null,'unbound control ready');
  assert.equal(child.exitCode,null,stderr);
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_CONSUMERS_ACTIVE'});
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,f.first.releaseId);
});
for(const [label,contract] of [
  ['removed tool',{tools:[]}],
  ['changed input schema',{tools:[{name:'fixture',inputSchema:{type:'object',required:['newArgument']}}]}],
  ['changed output schema',{tools:[{name:'fixture',inputSchema:{type:'object'},outputSchema:{type:'object'}}]}],
  ['changed capability',{capabilities:{tools:{listChanged:true}}}],
  ['changed protocol',{protocolVersion:'2099-01-01'}],
])test('compatible activation rejects '+label,async t=>{
  const f=await fixture(t);f.configureMcp(contract);
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_COMPATIBILITY_MISMATCH'});
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,f.first.releaseId);
});
test('a partial tools list cannot pass the complete-contract check',async t=>{
  const f=await fixture(t);f.configureMcp({nextCursor:'remaining-page'});
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_VALIDATION_FAILED'});
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,f.first.releaseId);
});
test('new tools can be added while existing contracts remain identical',async t=>{
  const f=await fixture(t);f.configureMcp({tools:[{name:'fixture',inputSchema:{type:'object'}},{name:'new-tool',inputSchema:{type:'object'}}]});
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  assert.equal((await compatible(f,candidate.releaseId)).code,'DEPLOY_COMPATIBLE_ACTIVATED');
});
test('a retry reconciles an actual process exit during prepublication verification',async t=>{
  const f=await fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  const moduleUrl=new URL('./runtime-deploy.mjs',import.meta.url).href;
  const source='import {runDeployment} from '+JSON.stringify(moduleUrl)+';await runDeployment({...JSON.parse(process.argv[1]),phaseRunner:async()=>process.exit(37)});';
  const result=spawnSync(process.execPath,['--input-type=module','-e',source,JSON.stringify({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate-compatible',candidate.releaseId]})],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,37,result.stderr);
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,f.first.releaseId);
  const retried=await compatible(f,candidate.releaseId);
  assert.equal(retried.recovery.outcome,'interrupted_before_publish');
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,candidate.releaseId);
});
function interruptedJournal(f,candidate,{phase='candidate_validate',mutationStarted,destination,published=false,overrides={}}={}) {
  const previous=readActivation({repositoryRoot:f.root});
  const state={version:1,status:'pending',operation:'activate',compatible:true,candidateReleaseId:candidate.releaseId,
    compatibilityDigest:releaseCompatibility({repositoryRoot:f.root,releaseId:previous.releaseId}),phase,previous,variables:{},
    ...(mutationStarted===undefined?{}:{mutationStarted}),...(destination?{destination}:{})};
  if(phase==='pointer_intent') {
    const writer=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
    const publication=acquireLease(path.join(f.root,'.jhw-runtime/publication.lock'),{create:true});
    const stop=new DeploymentError('DEPLOY_FIXTURE_INTERRUPT');
    try {
      publishActivation({repositoryRoot:f.root,releaseId:candidate.releaseId,expectedCurrent:previous,onPointerIntent:value=>{
        state.destination=value;if(!published)throw stop;
      }});
    } catch(error) {if(error!==stop)throw error;}
    finally {publication.close();writer.close();}
  }
  Object.assign(state,overrides);
  const file=write(f.root,'.jhw-runtime/.deploy.'+'f'.repeat(32)+'/state.json',JSON.stringify(state)+'\n',0o600);
  fs.chmodSync(path.dirname(file),0o700);
  return {state,file};
}
for(const scenario of [
  {label:'candidate probe',phase:'candidate_validate'},
  {label:'mutation checkpoint',phase:'candidate_validate',mutationStarted:true},
  {label:'unpublished pointer intent',phase:'pointer_intent',mutationStarted:true},
  {label:'published pointer intent',phase:'pointer_intent',mutationStarted:true,published:true},
])test('reconciles an interrupted '+scenario.label+' without changing live session pins',async t=>{
  const f=await fixture(t);const a=startClient(t,f);await a.ready();snapshotConsumer(f,a.child.pid);
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  const journal=interruptedJournal(f,candidate,scenario);
  const result=await compatible(f,candidate.releaseId);
  assert.equal(result.recovery.outcome,scenario.published?'interrupted_after_publish':'interrupted_before_publish');
  assert.equal(JSON.parse(fs.readFileSync(journal.file,'utf8')).status,'complete');
  assertSample(await a.request('sample'),f.first.releaseId);
});
for(const [label,overrides] of [
  ['foreign maintenance',{compatible:false}],
  ['unknown phase',{phase:'unrecognized'}],
  ['changed contract digest',{compatibilityDigest:'0'.repeat(64)}],
  ['detached worker',{workerDetached:true}],
])test('recovery refuses '+label+' evidence',async t=>{
  const f=await fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  const journal=interruptedJournal(f,candidate,{overrides});
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.equal(JSON.parse(fs.readFileSync(journal.file,'utf8')).status,'pending');
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,f.first.releaseId);
});
test('recovery refuses a changed activation even when the release bytes are the same',async t=>{
  const f=await fixture(t);write(f.root,'mcp-server/src/index.ts','export const generation=2;');const candidate=await f.prepare();
  const journal=interruptedJournal(f,candidate);
  const writer=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));
  const publication=acquireLease(path.join(f.root,'.jhw-runtime/publication.lock'),{create:true});
  try {publishActivation({repositoryRoot:f.root,releaseId:f.first.releaseId,expectedCurrent:readActivation({repositoryRoot:f.root})});}
  finally {publication.close();writer.close();}
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.equal(JSON.parse(fs.readFileSync(journal.file,'utf8')).status,'pending');
});

for(const [label,override] of [
  ['boolean input schema',{inputSchema:true}],
  ['non-object schema type',{inputSchema:{type:'array'}}],
  ['non-object properties',{inputSchema:{type:'object',properties:'bad'}}],
  ['non-object property schema',{inputSchema:{type:'object',properties:{query:true}}}],
  ['non-string required name',{inputSchema:{type:'object',required:[42]}}],
  ['numeric title',{title:42}],
  ['null description',{description:null}],
  ['non-array icons',{icons:{src:'fixture.svg'}}],
  ['non-string icon source',{icons:[{src:42}]}],
  ['non-string icon size',{icons:[{src:'fixture.svg',sizes:[32]}]}],
  ['unknown icon theme',{icons:[{src:'fixture.svg',theme:'contrast'}]}],
  ['null output schema',{outputSchema:null}],
  ['non-boolean annotation',{annotations:{readOnlyHint:'yes'}}],
  ['null execution',{execution:null}],
  ['unknown task support',{execution:{taskSupport:'later'}}],
  ['non-object metadata',{_meta:[]}],
])test('MCP tool validation rejects '+label+' before publication',async t=>{
  const f=await fixture(t);
  const previous=readActivation({repositoryRoot:f.root});
  f.configureMcp({tools:[
    {name:'fixture',inputSchema:{type:'object'}},
    {name:'new-tool',inputSchema:{type:'object'},...override},
  ]});
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');
  const candidate=await f.prepare();
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_VALIDATION_FAILED'});
  assert.deepEqual(readActivation({repositoryRoot:f.root}),previous);
});
for(const [label,extension] of [
  ['execution mode',{execution:{taskSupport:'required'}}],
  ['metadata',{_meta:{'example.test/invocation':{requiresConsent:true}}}],
  ['unknown extension',{'x-invocation':{mode:'task'}}],
])test('MCP non-display contract rejects changed '+label+' before publication',async t=>{
  const f=await fixture(t);
  const previous=readActivation({repositoryRoot:f.root});
  f.configureMcp({tools:[{name:'fixture',inputSchema:{type:'object'},...extension}]});
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');
  const candidate=await f.prepare();
  await assert.rejects(compatible(f,candidate.releaseId),{code:'DEPLOY_COMPATIBILITY_MISMATCH'});
  assert.deepEqual(readActivation({repositoryRoot:f.root}),previous);
});
test('MCP rich tool addition preserves existing invocation contracts',async t=>{
  const f=await fixture(t);
  f.configureMcp({tools:[
    {name:'fixture',title:'Updated display title',description:'Updated display text',
      icons:[{src:'fixture.svg'}],inputSchema:{type:'object'}},
    {name:'new-tool',title:'Search records',description:'Read matching records',
      icons:[{src:'search.svg',mimeType:'image/svg+xml',sizes:['24x24','any'],theme:'light'}],
      inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'integer',minimum:1}},required:['query'],additionalProperties:false},
      outputSchema:{type:'object',properties:{result:{type:'string'}},required:['result']},
      annotations:{title:'Record search',readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      execution:{taskSupport:'optional'},_meta:{'example.test/ui':{view:'records'}},
      'x-invocation':{mode:'optional',options:['normal','task']}},
  ]});
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');
  const candidate=await f.prepare();
  const result=await compatible(f,candidate.releaseId);
  assert.equal(result.code,'DEPLOY_COMPATIBLE_ACTIVATED');
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,candidate.releaseId);
});

const parallelManagedWorker = [
  "const {spawn} = await import('node:child_process');",
  "const entry=process.argv[1];",
  "const invoke=args=>new Promise(resolve=>{",
  " const started=performance.now();",
  " const child=spawn(process.execPath,[entry,...args],{stdio:['pipe','pipe','pipe']});",
  " let out='',err='';",
  " child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});",
  " child.once('error',e=>resolve({code:-1,stdout:out,stderr:e.message,durationMs:performance.now()-started}));",
  " child.once('close',code=>resolve({code,stdout:out,stderr:err,durationMs:performance.now()-started}));",
  " child.stdin.end('{}');",
  "});",
  "const control=await Promise.all(Array.from({length:3},()=>invoke(['control'])));",
  "const hooks=await Promise.all(Array.from({length:3},()=>invoke(['hook','--adapter','codex','--event','PreToolUse'])));",
  "process.stdout.write(JSON.stringify({control,hooks})+'\\n');",
].join('\n');

test('three concurrent pinned control and PreToolUse hooks complete under the hook deadline',async t=>{
  const f=await fixture(t);
  const started=performance.now();
  const result=run(f,['session','--',process.execPath,'-e',parallelManagedWorker,f.entry],{
    timeout:8000,env:{PATH:process.env.PATH,LANG:'C'},
  });
  assert.equal(result.status,0,result.stderr);
  const response=JSON.parse(result.stdout.trim());
  assert.equal(response.control.length,3);
  assert.equal(response.hooks.length,3);
  for(const call of response.control){
    assert.equal(call.code,0,JSON.stringify(response.control));
    assert.deepEqual(JSON.parse(call.stdout),{release:f.first.releaseId});
    assert.equal(call.stderr,'');
  }
  for(const hook of response.hooks){
    assert.equal(hook.code,0,JSON.stringify(response.hooks));
    assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.hookEventName,'PreToolUse');
    assert.equal(hook.stderr,'');
    assert.ok(hook.durationMs<8000,'PreToolUse exceeded hook timeout');
  }
  assert.ok(performance.now()-started<8000,'parallel harness deadline exceeded');
});

test('completed control and hook invocations do not retain public session records',async t=>{
  const f=await fixture(t);
  for(let iteration=0;iteration<4;iteration++){
    const control=run(f,['control']);assert.equal(control.status,0,control.stderr);
    const hook=run(f,['hook','--adapter','codex','--event','PreToolUse'],{input:'{}'});
    assert.equal(hook.status,0,hook.stderr);
    const sessions=path.join(f.root,'.jhw-runtime/sessions');
    const names=fs.existsSync(sessions)?fs.readdirSync(sessions):[];
    assert.deepEqual(names.filter(name=>name.startsWith('s-')),[],
      'finished invocations must retire in iteration '+iteration+': '+JSON.stringify(names));
  }
});
