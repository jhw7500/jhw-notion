import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {acquireLease} from './runtime-safety.mjs';
import {prepareRelease, readActivation} from './runtime-store.mjs';
const deploy = await import('./runtime-deploy.mjs').catch(e => {if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const source = path.dirname(fileURLToPath(import.meta.url));
function write(root,name,bytes,mode=0o644) {const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o755});fs.writeFileSync(p,bytes,{mode});fs.chmodSync(p,mode);return p;}
function fixture(t) {
 const outer=fs.mkdtempSync(path.join(os.tmpdir(),'jhw-deploy-'));fs.chmodSync(outer,0o700);t.after(()=>{ if(t.passed===false) {for(const p of fs.readdirSync(outer,{recursive:true}).filter(p=>p.endsWith('.log'))) t.diagnostic(fs.readFileSync(path.join(outer,p),'utf8'));} fs.rmSync(outer,{recursive:true,force:true});});
 const root=path.join(outer,'repo'),home=path.join(outer,'home'),procRoot=path.join(outer,'proc');for(const p of [root,home,procRoot])fs.mkdirSync(p,{mode:0o700});
 for(const [p,b] of Object.entries({'.gitignore':'.jhw-runtime/\n','mcp-server/package.json':'{"type":"module"}','mcp-server/package-lock.json':'{"lockfileVersion":3}','mcp-server/tsconfig.json':'{}','mcp-server/src/index.ts':'export {};','scripts/sync-codex-skills.mjs':'','skills/claude/task.md':'fixture','skills/codex/jhw-task/SKILL.md':'fixture'}))write(root,p,b);
 for(const name of ['runtime-safety.mjs','runtime-store.mjs','runtime-entry.mjs','install-config.mjs','install-wiring.sh','jhw-runtime-entry','jhw-runtime-control','jhw-runtime-hook','jhw-control-hook'])write(root,`scripts/${name}`,fs.readFileSync(path.join(source,name)),name.startsWith('jhw-')?0o755:0o644);
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','fixture']])assert.equal(spawnSync('git',args,{cwd:root}).status,0);
 let builds=0;
 const build=async ({stagingRoot})=>{builds++;write(stagingRoot,'mcp-server/dist/index.js',"process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(q.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='tools/list'?{tools:[]}:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})+'\\n');}});");write(stagingRoot,'mcp-server/dist/control/cli.js',"#!/usr/bin/env node\nconsole.log(JSON.stringify({error:{code:'INVALID_CONFIG'}}));process.exitCode=78;",0o755);write(stagingRoot,'mcp-server/dist/control/hook-adapter.js','#!/usr/bin/env node\nconsole.log("{}");',0o755);fs.mkdirSync(path.join(stagingRoot,'mcp-server/node_modules'),{mode:0o755});};
 const options={repositoryRoot:root,home,procRoot,build};
 return {root,home,procRoot,options,build,builds:()=>builds,run:argv=>{assert.equal(typeof deploy.runDeployment,'function','deployment orchestrator must exist');return deploy.runDeployment({...options,argv});}};
}
function addConsumer(f,name='codex') {const p=path.join(f.procRoot,'100');fs.mkdirSync(p);write(p,'status',`Uid:\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\n`,0o600);write(p,'stat','100 (fixture) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0\n',0o600);write(p,'cmdline',`${name}\0`,0o600);fs.symlinkSync(f.root,path.join(p,'cwd'));}
function host(f) {const contract={commands:['unlock','preflight','portfolio status','task start','task child-start','task contract','task completion-ready','task promote','task status','task handoff','task finish','task recover','task assert-owner','board status','board acquire','board with'],credential_policy:'secure-store-only',name:'jhw-control-host',version:5};write(f.home,'.local/bin/jhw-control-host',`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(contract)}'\n`,0o755);}

test('strict public arguments reject before any store or HOME write',async t=>{const f=fixture(t);for(const argv of [['--force'],['--status','extra'],['--activate'],['--activate','../bad'],['--prepare','--rollback'],['--uninstall','extra']])await assert.rejects(f.run(argv),{code:'DEPLOY_ARGUMENTS_INVALID'});assert.equal(fs.existsSync(path.join(f.root,'.jhw-runtime')),false);assert.deepEqual(fs.readdirSync(f.home),[]);});
test('prepare permits active consumers and never invokes wiring or touches legacy builds',async t=>{const f=fixture(t);addConsumer(f);write(f.root,'mcp-server/dist/legacy','old');const r=await f.run(['--prepare']);assert.match(r.releaseId,/^r-/);assert.equal(f.builds(),1);assert.deepEqual(fs.readdirSync(f.home),[]);assert.equal(readActivation({repositoryRoot:f.root}),null);assert.equal(fs.readFileSync(path.join(f.root,'mcp-server/dist/legacy'),'utf8'),'old');});
test('existing default install returns bounded explicit instructions without building',async t=>{const f=fixture(t);write(f.home,'.claude.json','{"mcpServers":{"jhw-notion":{"command":"node","args":["foreign"]}}}');const r=await f.run([]);assert.equal(r.code,'DEPLOY_EXPLICIT_ACTIVATION_REQUIRED');assert.equal(f.builds(),0);assert.equal(fs.existsSync(path.join(f.root,'.jhw-runtime')),false);});
test('active and uncertain inventory refuse activation and uninstall before shared mutation',async t=>{const f=fixture(t);const r=await f.run(['--prepare']);addConsumer(f);for(const argv of [['--activate',r.releaseId],['--uninstall'],['--rollback']])await assert.rejects(f.run(argv),{code:'DEPLOY_CONSUMERS_ACTIVE'});assert.equal(fs.existsSync(path.join(f.root,'.jhw-runtime/admission.lock')),false);fs.unlinkSync(path.join(f.procRoot,'100/status'));await assert.rejects(f.run(['--activate',r.releaseId]),{code:'DEPLOY_INVENTORY_UNCERTAIN'});assert.deepEqual(fs.readdirSync(f.home),[]);});
test('admission shared holder refuses activation preserving current and wiring',async t=>{const f=fixture(t);const r=await f.run(['--prepare']);const lock=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{shared:true,create:true});try{await assert.rejects(f.run(['--activate',r.releaseId]),{code:'DEPLOY_LOCK_CONTENDED'});}finally{lock.close();}assert.equal(readActivation({repositoryRoot:f.root}),null);assert.deepEqual(fs.readdirSync(f.home),[]);});
test('first activation wires stable entries, next activation is pointer-only, rollback and reinstall retain releases',async t=>{const f=fixture(t);host(f);for(const p of ['.claude','.gemini','.codex','.config/opencode'])fs.mkdirSync(path.join(f.home,p),{recursive:true,mode:0o700});const r=await f.run(['--prepare']);const a=await f.run(['--activate',r.releaseId]);assert.equal(a.releaseId,r.releaseId);const config=path.join(f.home,'.claude.json');assert.deepEqual(JSON.parse(fs.readFileSync(config)).mcpServers['jhw-notion'].args,[path.join(f.root,'.jhw-runtime/bootstrap/jhw-runtime-entry'),'mcp']);assert.equal(fs.readlinkSync(path.join(f.home,'.local/bin/jhw-control-hook')),path.join(f.root,'.jhw-runtime/bootstrap/jhw-runtime-hook'));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home,'.config/opencode/opencode.json'))).mcp['jhw-notion'].command,['node',path.join(f.root,'.jhw-runtime/bootstrap/jhw-runtime-entry'),'mcp']);assert.match(fs.readFileSync(path.join(f.home,'.codex/config.toml'),'utf8'),/"mcp"/);const before=fs.statSync(config,{bigint:true});write(f.root,'mcp-server/src/index.ts','export const version=2;');const r2=await f.run(['--prepare']);await f.run(['--activate',r2.releaseId]);assert.equal(fs.statSync(config,{bigint:true}).ino,before.ino);assert.equal(fs.statSync(config,{bigint:true}).mtimeNs,before.mtimeNs);await f.run(['--rollback']);assert.equal(readActivation({repositoryRoot:f.root}).releaseId,r.releaseId);await f.run(['--uninstall']);assert.equal(fs.existsSync(path.join(f.home,'.local/bin/jhw-control')),false);assert.equal(fs.existsSync(path.join(f.root,'.jhw-runtime/releases',r2.releaseId)),true);await f.run(['--activate',r.releaseId]);assert.equal(fs.existsSync(path.join(f.home,'.local/bin/jhw-control')),true);});
test('first managed activation has no invented legacy predecessor',async t=>{const f=fixture(t);host(f);const r=await f.run(['--prepare']);await f.run(['--activate',r.releaseId]);await assert.rejects(f.run(['--rollback']),{code:'DEPLOY_PREDECESSOR_INVALID'});});


test('owned legacy MCP and exact launcher migrate; foreign hook launcher refuses and retains evidence',async t=>{
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.claude'),{mode:0o700});write(f.root,'mcp-server/dist/index.js','old');fs.symlinkSync(path.join(f.root,'scripts/jhw-control-hook'),path.join(f.home,'.local/bin/jhw-control-hook'));
 write(f.home,'.claude.json',JSON.stringify({foreign:{keep:true},mcpServers:{'jhw-notion':{command:'node',args:[path.join(f.root,'mcp-server/dist/index.js')]}}}),0o600);
 const release=await f.run(['--prepare']);await f.run(['--activate',release.releaseId]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home,'.claude.json'))).foreign,{keep:true});assert.equal(fs.readlinkSync(path.join(f.home,'.local/bin/jhw-control-hook')),path.join(f.root,'.jhw-runtime/bootstrap/jhw-runtime-hook'));
 const g=fixture(t);host(g);fs.symlinkSync('/foreign/launcher',path.join(g.home,'.local/bin/jhw-control-hook'));const r=await g.run(['--prepare']);await assert.rejects(g.run(['--activate',r.releaseId]),{code:'DEPLOY_WIRING_FAILED'});assert.equal(fs.readlinkSync(path.join(g.home,'.local/bin/jhw-control-hook')),'/foreign/launcher');const status=await g.run(['--status']);assert.equal(status.recoveryPending,1);
});


test('second inventory runs after both real leases and refuses a racing consumer before publication',async t=>{
 const f=fixture(t);const release=await f.run(['--prepare']);const original=fs.openSync;let added=false;
 fs.openSync=function(name,...args){const fd=original.call(this,name,...args);if(!added&&String(name).endsWith('/admission.lock')){added=true;addConsumer(f);}return fd;};
 try{await assert.rejects(f.run(['--activate',release.releaseId]),{code:'DEPLOY_CONSUMERS_ACTIVE'});}finally{fs.openSync=original;}
 assert.equal(added,true);assert.equal(readActivation({repositoryRoot:f.root}),null);assert.deepEqual(fs.readdirSync(f.home),[]);
});
test('validation opens admission while deployment remains serialized; failed reacquisition preserves pending state',async t=>{
 const f=fixture(t);const release=await f.run(['--prepare']);let shared;const phases=[];
 try{await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:async options=>{
   phases.push(options.phase);
   assert.throws(()=>acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock')),{code:'DEPLOY_LOCK_CONTENDED'});
   if(options.phase==='validate'){const writer=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'));writer.close();shared=acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{shared:true});}
   else assert.throws(()=>acquireLease(path.join(f.root,'.jhw-runtime/admission.lock'),{shared:true}),{code:'DEPLOY_LOCK_CONTENDED'});
 }}),{code:'DEPLOY_RECOVERY_REQUIRED'});}finally{shared?.close();}
 assert.deepEqual(phases,['wire','validate']);assert.equal(readActivation({repositoryRoot:f.root}).releaseId,release.releaseId);assert.equal((await f.run(['--status'])).recoveryPending,1);
});
test('later validation failure retains evidence and explicit gated rollback restores only its predecessor', async t => {
  const f = fixture(t);
  host(f);
  const first = await f.run(['--prepare']);
  await f.run(['--activate', first.releaseId]);
  write(f.root, 'mcp-server/src/index.ts', 'export const changed=1;');
  const bootstrapBefore = fs.readFileSync(path.join(f.root, '.jhw-runtime/bootstrap/manifest.json'));
  fs.appendFileSync(path.join(f.root, 'scripts/runtime-safety.mjs'), '\n// next valid immutable helper generation\n');
  const second = await f.run(['--prepare']);
  await assert.rejects(deploy.runDeployment({
    ...f.options,
    argv:['--activate', second.releaseId],
    phaseRunner:async ({phase}) => {
      if (phase === 'validate') throw new Error('private diagnostic');
    },
  }), {code:'DEPLOY_VALIDATION_FAILED', reason:'validated_rollback_required'});
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId, second.releaseId);
  assert.equal((await f.run(['--status'])).recoveryPending, 1);
  await f.run(['--rollback']);
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId, first.releaseId);
  assert.equal((await f.run(['--status'])).recoveryPending, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.jhw-runtime/bootstrap/manifest.json')), bootstrapBefore);
});
test('failed rollback validation requires manual recovery instead of another rollback', async t => {
  const f = fixture(t);
  host(f);
  const first = await f.run(['--prepare']);
  await f.run(['--activate', first.releaseId]);
  write(f.root, 'mcp-server/src/index.ts', 'export const changed=1;');
  const second = await f.run(['--prepare']);
  await f.run(['--activate', second.releaseId]);
  write(f.home, '.local/bin/jhw-control-host', '#!/bin/sh\nexit 23;\n', 0o755);

  await assert.rejects(f.run(['--rollback']), {
    code:'DEPLOY_VALIDATION_FAILED', reason:'rollback_recovery_required',
  });
  const current = readActivation({repositoryRoot:f.root});
  assert.equal(current.releaseId, first.releaseId);
  const runtime = path.join(f.root, '.jhw-runtime');
  const journals = fs.readdirSync(runtime).filter(name => /^\.deploy\./.test(name));
  const pending = journals
    .map(name => JSON.parse(fs.readFileSync(path.join(runtime, name, 'state.json'))))
    .filter(state => state.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operation, 'rollback');
  assert.equal(pending[0].phase, 'validation_failed');
  assert.equal(pending[0].previous.releaseId, second.releaseId);
  assert.deepEqual(pending[0].current, current);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'wiring.json'))).installed, true);

  const retainedEvidence = homeObservation(runtime);
  const home = homeObservation(f.home);
  await assert.rejects(f.run(['--rollback']), {code:'DEPLOY_RECOVERY_REQUIRED'});
  assert.deepEqual(readActivation({repositoryRoot:f.root}), current);
  assert.deepEqual(homeObservation(runtime), retainedEvidence);
  assert.deepEqual(homeObservation(f.home), home);
  assert.equal((await f.run(['--status'])).recoveryPending, 1);
});

test('real mutation worker retains writer leases after its parent exits and never restores on EOF',async t=>{
 const f=fixture(t);host(f);const hostPath=path.join(f.home,'.local/bin/jhw-control-host');const original=fs.readFileSync(hostPath,'utf8');
 const ready=path.join(f.home,'worker-ready'),resume=path.join(f.home,'worker-resume');
 fs.writeFileSync(hostPath,`#!/bin/sh\ntouch '${ready}'\nwhile [ ! -f '${resume}' ]; do /bin/sleep 0.01; done\n${original.split('\n').slice(1).join('\n')}`);
 const release=await f.run(['--prepare']);
 const code=`import fs from 'node:fs';import {runDeployment} from ${JSON.stringify(new URL('./runtime-deploy.mjs',import.meta.url).href)};setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)}))process.exit(19);},5);await runDeployment(${JSON.stringify({repositoryRoot:f.root,home:f.home,procRoot:f.procRoot,argv:['--activate',release.releaseId]})});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','ignore']});await once(child,'exit');
 assert.equal(fs.existsSync(ready),true);
 for(const name of ['deploy.lock','admission.lock'])assert.throws(()=>acquireLease(path.join(f.root,'.jhw-runtime',name)),{code:'DEPLOY_LOCK_CONTENDED'});
 assert.equal((await f.run(['--status'])).recoveryPending,1);write(f.home,'worker-resume','go');
 const end=Date.now()+8000;while(true){try{const lock=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));lock.close();break;}catch(error){if(error.code!=='DEPLOY_LOCK_CONTENDED'||Date.now()>end)throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
 assert.equal((await f.run(['--status'])).recoveryPending,1);
});


test('failed real MCP startup refuses success with retained recovery evidence', async t => {
  const f = fixture(t);
  host(f);
  const release = await deploy.runDeployment({
    ...f.options,
    argv:['--prepare'],
    build:async args => {
      await f.build(args);
      write(args.stagingRoot, 'mcp-server/dist/index.js', 'process.exit(23);');
    },
  });
  await assert.rejects(f.run(['--activate', release.releaseId]), {
    code:'DEPLOY_VALIDATION_FAILED', reason:'first_migration_recovery_required',
  });
  assert.equal((await f.run(['--status'])).recoveryPending, 1);
});

test('later foreign MCP replacement is preserved and refused before pointer change',async t=>{
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.claude'),{mode:0o700});const a=await f.run(['--prepare']);await f.run(['--activate',a.releaseId]);const prior=readActivation({repositoryRoot:f.root});write(f.root,'mcp-server/src/index.ts','export const b=2;');const b=await f.run(['--prepare']);const foreign='{"mcpServers":{"jhw-notion":{"command":"python","args":["foreign"]}}}';write(f.home,'.claude.json',foreign,0o600);await assert.rejects(f.run(['--activate',b.releaseId]),{code:'DEPLOY_WIRING_FAILED'});assert.deepEqual(readActivation({repositoryRoot:f.root}),prior);assert.equal(fs.readFileSync(path.join(f.home,'.claude.json'),'utf8'),foreign);
});


test('deployment journal parent substitution cannot redirect checkpoint writes',async t=>{
 const f=fixture(t);const release=await f.run(['--prepare']);const foreign=path.join(f.home,'foreign');fs.mkdirSync(foreign,{mode:0o700});const original=fs.openSync;let swapped=false;
 fs.openSync=function(name,...args){if(!swapped&&path.basename(String(name)).startsWith('.write.')){const runtime=path.join(f.root,'.jhw-runtime');const candidate=fs.readdirSync(runtime).find(n=>/^\.deploy\./.test(n));if(candidate){swapped=true;const dir=path.join(runtime,candidate);fs.renameSync(dir,dir+'.retained');fs.symlinkSync(foreign,dir);}}return original.call(this,name,...args);};
 try{await assert.rejects(f.run(['--activate',release.releaseId]));}finally{fs.openSync=original;}
 assert.equal(swapped,true);assert.deepEqual(fs.readdirSync(foreign),[]);assert.equal(readActivation({repositoryRoot:f.root}),null);
});


for (const refresh of ['helper', 'topology']) {
  test(`failed ${refresh} refresh after guarded uninstall requires manual recovery and preserves evidence on rollback refusal`, async t => {
    const f = fixture(t);
    host(f);
    fs.mkdirSync(path.join(f.home, '.codex'), {mode:0o700});
    const first = await f.run(['--prepare']);
    await f.run(['--activate', first.releaseId]);
    const runtime = path.join(f.root, '.jhw-runtime');
    const wiringFile = path.join(runtime, 'wiring.json');
    assert.equal(JSON.parse(fs.readFileSync(wiringFile)).installed, true);

    if (refresh === 'helper') {
      fs.appendFileSync(path.join(f.root, 'scripts/runtime-safety.mjs'), '\n// refreshed helper generation\n');
    } else {
      write(f.root, 'skills/codex/jhw-new/SKILL.md', 'new skill');
    }
    const second = await deploy.runDeployment({
      ...f.options,
      argv:['--prepare'],
      build:async args => {
        await f.build(args);
        write(args.stagingRoot, 'mcp-server/dist/index.js', 'process.exit(23);');
      },
    });
    await f.run(['--uninstall']);
    assert.equal(JSON.parse(fs.readFileSync(wiringFile)).installed, false);
    assert.equal(readActivation({repositoryRoot:f.root}).releaseId, first.releaseId);

    await assert.rejects(f.run(['--activate', second.releaseId]), {
      code:'DEPLOY_VALIDATION_FAILED', reason:'wiring_refresh_recovery_required',
    });
    const current = readActivation({repositoryRoot:f.root});
    assert.equal(current.releaseId, second.releaseId);
    assert.equal(JSON.parse(fs.readFileSync(wiringFile)).installed, false);
    const status = await f.run(['--status']);
    assert.equal(status.predecessorAvailable, true);
    assert.equal(status.recoveryPending, 1);
    const journals = fs.readdirSync(runtime).filter(name => /^\.deploy\./.test(name));
    const pending = journals.filter(name => {
      const state = JSON.parse(fs.readFileSync(path.join(runtime, name, 'state.json')));
      return state.status === 'pending';
    });
    assert.equal(pending.length, 1);
    const journal = path.join(runtime, pending[0]);
    const state = JSON.parse(fs.readFileSync(path.join(journal, 'state.json')));
    assert.equal(state.phase, 'validation_failed');
    assert.equal(state.previous.releaseId, first.releaseId);
    assert.deepEqual(state.current, current);
    assert.equal(fs.lstatSync(path.join(journal, 'before.json')).isFile(), true);
    if (refresh === 'helper') {
      assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'bootstrap/manifest.json'))).sourceReleaseId, second.releaseId);
      assert.equal(fs.readdirSync(runtime).filter(name => /^\.bootstrap\.previous\.[a-f0-9]{32}$/.test(name)).length, 1);
    } else {
      assert.equal(fs.readFileSync(path.join(f.home, '.codex/skills/jhw-new/SKILL.md'), 'utf8'), 'new skill');
    }

    const retainedEvidence = homeObservation(runtime);
    const home = homeObservation(f.home);
    await assert.rejects(f.run(['--rollback']), {code:'DEPLOY_RECOVERY_REQUIRED'});
    assert.deepEqual(readActivation({repositoryRoot:f.root}), current);
    assert.deepEqual(homeObservation(runtime), retainedEvidence);
    assert.deepEqual(homeObservation(f.home), home);
    assert.equal(JSON.parse(fs.readFileSync(wiringFile)).installed, false);
    assert.equal((await f.run(['--status'])).recoveryPending, 1);
  });
}

test('guarded uninstall and reinstall refresh changed bootstrap while retaining previous helpers',async t=>{
 const f=fixture(t);host(f);const a=await f.run(['--prepare']);await f.run(['--activate',a.releaseId]);const old=fs.readFileSync(path.join(f.root,'.jhw-runtime/bootstrap/manifest.json'));fs.appendFileSync(path.join(f.root,'scripts/runtime-safety.mjs'),'\n// changed bootstrap implementation\n');const b=await f.run(['--prepare']);await f.run(['--activate',b.releaseId]);assert.deepEqual(fs.readFileSync(path.join(f.root,'.jhw-runtime/bootstrap/manifest.json')),old);await f.run(['--uninstall']);await f.run(['--activate',b.releaseId]);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'.jhw-runtime/bootstrap/manifest.json'))).sourceReleaseId,b.releaseId);const previous=fs.readdirSync(path.join(f.root,'.jhw-runtime')).filter(n=>/^\.bootstrap\.previous\.[a-f0-9]{32}$/.test(n));assert.equal(previous.length,1);assert.deepEqual(fs.readFileSync(path.join(f.root,'.jhw-runtime',previous[0],'manifest.json')),old);
});
test('fresh default uses staging and gated activation without touching legacy build outputs',async t=>{const f=fixture(t);host(f);write(f.root,'mcp-server/dist/legacy','old');const result=await f.run([]);assert.equal(result.code,'DEPLOY_ACTIVATED');assert.equal(f.builds(),1);assert.equal(fs.readFileSync(path.join(f.root,'mcp-server/dist/legacy'),'utf8'),'old');});
test('public CLI inventories real sessions and rejects arguments with bounded no-write diagnostics',async t=>{
 const f=fixture(t);for(const name of ['runtime-deploy.mjs'])write(f.root,`scripts/${name}`,fs.readFileSync(path.join(source,name)));write(f.root,'install.sh',fs.readFileSync(path.join(source,'../install.sh')),0o755);
 const script=write(f.home,'codex',"process.stdout.write('ready');process.stdin.resume();",0o644);const child=spawn(process.execPath,[script],{stdio:['pipe','pipe','ignore']});const done=once(child,'exit');await once(child.stdout,'data');
 try {for(const args of [['--uninstall'],['--activate','bad'],['--status','extra']]){const r=spawnSync('/bin/bash',[path.join(f.root,'install.sh'),...args],{env:{HOME:f.home,PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`},encoding:'utf8'});assert.notEqual(r.status,0);const result=JSON.parse(r.stdout);assert.match(result.error.code,/^DEPLOY_(CONSUMERS_ACTIVE|INVENTORY_UNCERTAIN|ARGUMENTS_INVALID)$/);assert.equal(r.stderr,'');assert.equal(r.stdout.includes(f.root),false);assert.equal(r.stdout.includes(f.home),false);}assert.equal(fs.existsSync(path.join(f.root,'.jhw-runtime')),false);}finally{child.stdin.end();await done;}
 const old=spawnSync('/bin/bash',[path.join(f.root,'install.sh'),'--status'],{env:{HOME:f.home,PATH:'/usr/bin:/bin'},encoding:'utf8'});if(Number(spawnSync('/usr/bin/node',['-p','process.versions.node.split(".")[0]'],{encoding:'utf8'}).stdout)<22){assert.deepEqual(JSON.parse(old.stdout),{error:{code:'DEPLOY_NODE_UNSUPPORTED'}});assert.equal(old.stderr,'');}
});


test('bounded mutation worker timeout preserves evidence and leases until its own process exits',async t=>{
 const f=fixture(t);host(f);const hostPath=path.join(f.home,'.local/bin/jhw-control-host');fs.writeFileSync(hostPath,fs.readFileSync(hostPath,'utf8').replace('#!/bin/sh\n','#!/bin/sh\n/bin/sleep 1\n'));const release=await f.run(['--prepare']);await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseTimeoutMs:50}),{code:'DEPLOY_WIRING_FAILED'});assert.equal((await f.run(['--status'])).recoveryPending,1);assert.throws(()=>acquireLease(path.join(f.root,'.jhw-runtime/admission.lock')),{code:'DEPLOY_LOCK_CONTENDED'});const end=Date.now()+5000;while(true){try{const lock=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));lock.close();break;}catch(error){if(error.code!=='DEPLOY_LOCK_CONTENDED'||Date.now()>end)throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
});


test('journal directory replacement cannot chmod a foreign symlink target',async t=>{
 const f=fixture(t);const release=await f.run(['--prepare']);const foreign=path.join(f.home,'foreign-mode');fs.mkdirSync(foreign,{mode:0o755});fs.chmodSync(foreign,0o755);const original=fs.mkdirSync;let swapped=false;
 fs.mkdirSync=function(name,...args){const result=original.call(this,name,...args);if(!swapped&&path.basename(String(name)).startsWith('.deploy.')){swapped=true;fs.renameSync(name,String(name)+'.retained');fs.symlinkSync(foreign,name);}return result;};
 try{await assert.rejects(f.run(['--activate',release.releaseId]));}finally{fs.mkdirSync=original;}
 assert.equal(swapped,true);assert.equal(fs.statSync(foreign).mode&0o777,0o755);assert.deepEqual(fs.readdirSync(foreign),[]);
});


test('first migration failure retains exact bounded configuration and launcher preimages',async t=>{
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.claude'),{mode:0o700});write(f.root,'mcp-server/dist/index.js','legacy');const original=JSON.stringify({mcpServers:{'jhw-notion':{command:'node',args:[path.join(f.root,'mcp-server/dist/index.js')]}},foreign:'private-preimage-marker'})+'\n';write(f.home,'.claude.json',original,0o640);const link=path.join(f.root,'scripts/jhw-control-hook');fs.symlinkSync(link,path.join(f.home,'.local/bin/jhw-control-hook'));
 const release=await deploy.runDeployment({...f.options,argv:['--prepare'],build:async args=>{await f.build(args);write(args.stagingRoot,'mcp-server/dist/index.js','process.exit(23);');}});await assert.rejects(f.run(['--activate',release.releaseId]),{code:'DEPLOY_VALIDATION_FAILED'});
 const runtime=path.join(f.root,'.jhw-runtime');const journal=fs.readdirSync(runtime).find(n=>/^\.deploy\./.test(n));const evidencePath=path.join(runtime,journal,'before.json');const evidence=JSON.parse(fs.readFileSync(evidencePath));const config=evidence.entries.find(e=>e.path==='.claude.json');assert.equal(Buffer.from(config.bytes,'base64').toString('utf8'),original);assert.equal(config.mode,0o640);assert.deepEqual(evidence.entries.find(e=>e.path==='.local/bin/jhw-control-hook').target,link);assert.equal(evidence.entries.find(e=>e.path==='.claude/settings.json').type,'absent');assert.equal(fs.statSync(evidencePath).mode&0o777,0o600);
});


function homeObservation(home) {
  const entries = [];
  const visit = directory => {
    for (const name of fs.readdirSync(path.join(home, directory)).sort()) {
      const relative = path.join(directory, name);
      const file = path.join(home, relative);
      const info = fs.lstatSync(file, {bigint:true});
      entries.push({
        name:relative, mode:String(info.mode), ino:String(info.ino), mtimeNs:String(info.mtimeNs),
        content:info.isSymbolicLink() ? fs.readlinkSync(file) : info.isFile() ? fs.readFileSync(file).toString('base64') : null,
      });
      if (info.isDirectory()) visit(relative);
    }
  };
  visit('');
  return entries;
}

for (const surface of ['skill', 'prompt']) {
  for (const change of ['addition', 'removal']) {
    test(`Codex ${surface} ${change} refuses incompatible topology before publication`, async t => {
      const f = fixture(t);
      host(f);
      fs.mkdirSync(path.join(f.home, '.codex'), {mode:0o700});
      const changedPath = surface === 'skill' ? 'skills/codex/jhw-new/SKILL.md' : 'skills/claude/new.md';
      if (change === 'removal') write(f.root, changedPath, 'old command');
      const a = await f.run(['--prepare']);
      await f.run(['--activate', a.releaseId]);
      if (change === 'addition') write(f.root, changedPath, 'new command');
      else fs.rmSync(path.join(f.root, surface === 'skill' ? 'skills/codex/jhw-new' : changedPath), {recursive:true});
      const b = await f.run(['--prepare']);
      const current = readActivation({repositoryRoot:f.root});
      const home = homeObservation(f.home);
      await assert.rejects(f.run(['--activate', b.releaseId]), {
        code:'DEPLOY_WIRING_TOPOLOGY_CHANGED', reason:'guarded_uninstall_reinstall_required',
      });
      assert.deepEqual(readActivation({repositoryRoot:f.root}), current);
      assert.deepEqual(homeObservation(f.home), home);
      assert.equal((await f.run(['--status'])).recoveryPending, 0);
    });
  }
}

test('gated reinstall applies changed topology and rollback refuses the incompatible predecessor', async t => {
  const f = fixture(t);
  host(f);
  fs.mkdirSync(path.join(f.home, '.codex'), {mode:0o700});
  write(f.root, 'skills/codex/jhw-old/SKILL.md', 'old skill');
  write(f.root, 'skills/claude/old.md', 'old prompt');
  const a = await f.run(['--prepare']);
  await f.run(['--activate', a.releaseId]);
  fs.rmSync(path.join(f.root, 'skills/codex/jhw-old'), {recursive:true});
  fs.unlinkSync(path.join(f.root, 'skills/claude/old.md'));
  write(f.root, 'skills/codex/jhw-new/SKILL.md', 'new skill');
  write(f.root, 'skills/claude/new.md', 'new prompt');
  const b = await f.run(['--prepare']);
  await assert.rejects(f.run(['--activate', b.releaseId]), {code:'DEPLOY_WIRING_TOPOLOGY_CHANGED'});
  await f.run(['--uninstall']);
  await f.run(['--activate', b.releaseId]);
  for (const name of ['.codex/skills/jhw-old', '.codex/prompts/old.md']) {
    assert.throws(() => fs.lstatSync(path.join(f.home, name)), {code:'ENOENT'});
  }
  for (const [name, bytes] of [['.codex/skills/jhw-new/SKILL.md','new skill'],['.codex/prompts/new.md','new prompt']]) {
    assert.equal(fs.readFileSync(path.join(f.home, name), 'utf8'), bytes);
  }
  const current = readActivation({repositoryRoot:f.root});
  const home = homeObservation(f.home);
  await assert.rejects(f.run(['--rollback']), {
    code:'DEPLOY_WIRING_TOPOLOGY_CHANGED', reason:'guarded_uninstall_reinstall_required',
  });
  assert.deepEqual(readActivation({repositoryRoot:f.root}), current);
  assert.deepEqual(homeObservation(f.home), home);
  assert.equal((await f.run(['--status'])).recoveryPending, 0);
  await f.run(['--uninstall']);
  await f.run(['--activate', a.releaseId]);
  assert.equal(fs.readFileSync(path.join(f.home, '.codex/skills/jhw-old/SKILL.md'), 'utf8'), 'old skill');
  assert.equal(fs.readFileSync(path.join(f.home, '.codex/prompts/old.md'), 'utf8'), 'old prompt');
  assert.throws(() => fs.lstatSync(path.join(f.home, '.codex/skills/jhw-new')), {code:'ENOENT'});
  assert.throws(() => fs.lstatSync(path.join(f.home, '.codex/prompts/new.md')), {code:'ENOENT'});
});

test('whole-directory adapter wiring accepts skill additions without an installed Codex surface', async t => {
  const f = fixture(t);
  host(f);
  for (const name of ['.claude', '.gemini', '.config/opencode']) fs.mkdirSync(path.join(f.home, name), {recursive:true,mode:0o700});
  const a = await f.run(['--prepare']);
  await f.run(['--activate', a.releaseId]);
  write(f.root, 'skills/codex/jhw-new/SKILL.md', 'new skill');
  write(f.root, 'skills/claude/new.md', 'new prompt');
  const b = await f.run(['--prepare']);
  const home = homeObservation(f.home);
  await f.run(['--activate', b.releaseId]);
  assert.deepEqual(homeObservation(f.home), home);
  for (const root of ['.claude/commands/jhw', '.gemini/commands/jhw', '.config/opencode/skills/jhw']) {
    assert.equal(fs.readFileSync(path.join(f.home, root, 'new.md'), 'utf8'), 'new prompt');
  }
  await f.run(['--rollback']);
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId, a.releaseId);
  assert.deepEqual(homeObservation(f.home), home);
});


test('rollback destination topology is checked after an explicitly reinstalled release', async t => {
  const f = fixture(t);
  host(f);
  fs.mkdirSync(path.join(f.home, '.codex'), {mode:0o700});
  const a = await f.run(['--prepare']);
  await f.run(['--activate', a.releaseId]);
  write(f.root, 'skills/claude/new.md', 'new prompt');
  const b = await f.run(['--prepare']);
  await f.run(['--uninstall']);
  await f.run(['--activate', b.releaseId]);
  const current = readActivation({repositoryRoot:f.root});
  const home = homeObservation(f.home);
  await assert.rejects(f.run(['--rollback']), {
    code:'DEPLOY_WIRING_TOPOLOGY_CHANGED', reason:'guarded_uninstall_reinstall_required',
  });
  assert.deepEqual(readActivation({repositoryRoot:f.root}), current);
  assert.deepEqual(homeObservation(f.home), home);
  assert.equal((await f.run(['--status'])).recoveryPending, 0);
});
