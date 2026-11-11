import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DeploymentError, acquireLease } from './runtime-safety.mjs';
import { prepareRelease, publishActivation, readActivation, releaseCompatibility } from './runtime-store.mjs';
import { installBootstrap } from './runtime-entry.mjs';
import { runDeployment } from './runtime-deploy.mjs';

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
    'mcp-server/tsconfig.json':'{}','mcp-server/src/index.ts':'export const generation=1;',
    'mcp-server/src/control/schemas.ts':'export const stateVersion=1;',
    'mcp-server/scripts/clean-dist.mjs':'','scripts/sync-codex-skills.mjs':'',
    'skills/claude/task.md':'same immutable skills',
  })) write(root,name,value);
  for(const name of helpers) write(root,'scripts/'+name,fs.readFileSync(path.join(source,name)),name.startsWith('jhw-')?0o755:0o644);
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]) {
    const r=spawnSync('git',args,{cwd:root,encoding:'utf8'}); assert.equal(r.status,0,r.stderr);
  }
  let broken=false;let mcpOptions={protocolVersion:'2024-11-05',capabilities:{},tools:[{name:'fixture',inputSchema:{type:'object'}}]};
  const build=async({stagingRoot})=>{
    const control="process.stdout.write(JSON.stringify({release:require('node:path').basename(globalThis.__JHW_MANAGED_RELEASE_ROOT__)})+'\\n');if(process.argv.includes('--hold'))process.stdin.resume();";
    const hook="const event=process.argv.at(-1);const release=require('node:path').basename(globalThis.__JHW_MANAGED_RELEASE_ROOT__);if(process.env.JHW_TEST_TRACE)require('node:fs').appendFileSync(process.env.JHW_TEST_TRACE,JSON.stringify({event,release})+'\\n');const value=event==='SessionEnd'?{}:event==='PostToolUse'?{systemMessage:release}:event==='UserPromptSubmit'?{hookSpecificOutput:{hookEventName:event,additionalContext:release},systemMessage:release}:{hookSpecificOutput:{hookEventName:event}};process.stdout.write(JSON.stringify(value)+'\\n');";
    const mcp=broken?"process.stderr.write('candidate failed\\n');process.exitCode=1;":String.raw`
      const contract=__MCP_CONTRACT__;
      const lines=require('node:readline').createInterface({input:process.stdin});
      lines.on('line',line=>{const request=JSON.parse(line);if(!request.id)return;
        const result=request.method==='initialize'?{protocolVersion:contract.protocolVersion,serverInfo:{name:'fixture',version:require('node:path').basename(globalThis.__JHW_MANAGED_RELEASE_ROOT__)},capabilities:contract.capabilities}:{tools:contract.tools,...(Object.hasOwn(contract,'nextCursor')?{nextCursor:contract.nextCursor}:{})};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
      });`.replace('__MCP_CONTRACT__',JSON.stringify(mcpOptions));
    for(const [name,body,mode] of [
      ['mcp-server/dist/index.js',mcp,0o644],['mcp-server/dist/control/cli.js',control,0o755],
      ['mcp-server/dist/control/hook-adapter.js',hook,0o755],['mcp-server/dist/runtime/mcp.cjs',mcp,0o644],
      ['mcp-server/dist/runtime/control.cjs',control,0o755],['mcp-server/dist/runtime/hook.cjs',hook,0o755],
    ]) write(stagingRoot,name,body,mode);
    fs.mkdirSync(path.join(stagingRoot,'mcp-server/node_modules'),{mode:0o755});
  };
  const prepare=()=>prepareRelease({repositoryRoot:root,build});
  const first=await prepare();
  const deploy=acquireLease(path.join(root,'.jhw-runtime/deploy.lock'));
  const admission=acquireLease(path.join(root,'.jhw-runtime/admission.lock'),{create:true});
  try { await installBootstrap({repositoryRoot:root,releaseId:first.releaseId}); publishActivation({repositoryRoot:root,releaseId:first.releaseId,expectedCurrent:null}); }
  finally {admission.close();deploy.close();}
  write(root,'.jhw-runtime/wiring.json','{"version":1,"installed":true}\n',0o600);
  return {root,home,procRoot,first,prepare,breakCandidate:()=>{broken=true;},configureMcp:value=>{mcpOptions={...mcpOptions,...value};},entry:path.join(root,'.jhw-runtime/bootstrap/jhw-runtime-entry')};
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
    if(command==='lost-pin'){const environment={...process.env};delete environment.JHW_RUNTIME_SESSION_BINDING;const r=call(['control'],'',environment);send({status:r.status,stderr:r.stderr,stdout:r.stdout});return;}
    const control=call(['control']);if(control.status!==0)throw new Error(control.stderr);
    const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}].map(JSON.stringify).join('\n')+'\n';
    const mcp=call(['mcp'],input);if(mcp.status!==0)throw new Error(mcp.stderr);
    const events=['PreToolUse','PostToolUse','UserPromptSubmit','SessionEnd'];const codes=[];
    for(const event of events){const r=call(['hook','--adapter','codex','--event',event],'{}');codes.push(r.status);}
    const hooks=fs.readFileSync(trace,'utf8').trim().split('\n').slice(-4).map(JSON.parse);
    send({control:JSON.parse(control.stdout).release,mcp:mcp.stdout.trim().split('\n').map(JSON.parse).find(x=>x.id===1).result.serverInfo.version,hooks,codes});
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
  write(f.root,'mcp-server/src/index.ts','export const generation=2;');const second=await f.prepare();
  const published=await compatible(f,second.releaseId);
  assert.equal(published.inventory.before.bound.managed,1);assert.equal(a.child.exitCode,null);
  assertSample(await a.request('sample'),f.first.releaseId);
  const b=startClient(t,f);await b.ready();assertSample(await b.request('sample'),second.releaseId);
  snapshotConsumer(f,b.child.pid);await compatible(f,f.first.releaseId);
  assertSample(await a.request('sample'),f.first.releaseId);assertSample(await b.request('sample'),second.releaseId);
  const c=startClient(t,f);await c.ready();assertSample(await c.request('sample'),f.first.releaseId);
  assert.throws(()=>acquireLease(path.join(f.root,'.jhw-runtime/admission.lock')),{code:'DEPLOY_LOCK_CONTENDED'});
  await assert.rejects(runDeployment({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate',f.first.releaseId],phaseRunner:async()=>{}}),{code:'DEPLOY_CONSUMERS_ACTIVE'});
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
  ['skills','skills/claude/task.md','changed skills'],['shared state','mcp-server/src/control/schemas.ts','export const stateVersion=2;'],
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
