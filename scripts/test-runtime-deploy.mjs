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
 const build=async ({stagingRoot})=>{builds++;const mcp="process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(q.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='tools/list'?{tools:[]}:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})+'\\n');}});";const control="#!/usr/bin/env node\nconsole.log(JSON.stringify({error:{code:'INVALID_CONFIG'}}));process.exitCode=78;";const hook='#!/usr/bin/env node\nconsole.log("{}");';write(stagingRoot,'mcp-server/dist/index.js',mcp);write(stagingRoot,'mcp-server/dist/control/cli.js',control,0o755);write(stagingRoot,'mcp-server/dist/control/hook-adapter.js',hook,0o755);write(stagingRoot,'mcp-server/dist/runtime/mcp.cjs',mcp);write(stagingRoot,'mcp-server/dist/runtime/control.cjs',control,0o755);write(stagingRoot,'mcp-server/dist/runtime/hook.cjs',hook,0o755);fs.mkdirSync(path.join(stagingRoot,'mcp-server/node_modules'),{mode:0o755});};
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
 const g=fixture(t);host(g);fs.symlinkSync('/foreign/launcher',path.join(g.home,'.local/bin/jhw-control-hook'));const r=await g.run(['--prepare']);await assert.rejects(g.run(['--activate',r.releaseId]),{code:'DEPLOY_WIRING_CONFLICT',reason:'hook_link'});assert.equal(fs.readlinkSync(path.join(g.home,'.local/bin/jhw-control-hook')),'/foreign/launcher');const status=await g.run(['--status']);assert.equal(status.recoveryPending,0);
});

// Every destination class install_wiring refuses must be refused by the
// read-only plan before any journal, bootstrap, pointer, or HOME mutation.
// Each occupant returns the single decoy path whose removal must suffice, or
// a function that undoes exactly the occupied state.
const hostContract = h => fs.readFileSync(path.join(h,'.local/bin/jhw-control-host'));
const foreignDestinations = [
 ['control_host', 'missing-host', (h,f)=>{fs.unlinkSync(path.join(h,'.local/bin/jhw-control-host'));return ()=>host(f);}],
 ['control_host', 'host-contract', (h,f)=>{write(h,'.local/bin/jhw-control-host',String(hostContract(h)).replace('"version":5','"version":4'),0o755);return ()=>host(f);}],
 ['tui_root', 'claude-root-link', h=>{const real=path.join(path.dirname(h),'claude-real');fs.mkdirSync(real,{mode:0o700});fs.symlinkSync(real,path.join(h,'.claude'));return '.claude';}],
 ['tui_root', 'codex-root-link', h=>{const real=path.join(path.dirname(h),'codex-real');fs.mkdirSync(real,{mode:0o700});fs.symlinkSync(real,path.join(h,'.codex'));return '.codex';}],
 ['pending_transaction', 'codex-hook-txn', h=>{fs.mkdirSync(path.join(h,'.codex/.hooks.json.jhw-txn.abc123'),{recursive:true,mode:0o700});return '.codex/.hooks.json.jhw-txn.abc123';}],
 ['pending_transaction', 'claude-hook-txn', h=>{fs.mkdirSync(path.join(h,'.claude/.settings.json.jhw-txn.abc123'),{recursive:true,mode:0o700});return '.claude/.settings.json.jhw-txn.abc123';}],
 ['pending_transaction', 'launcher-txn', h=>{fs.mkdirSync(path.join(h,'.local/bin/.jhw-control-hook-link-txn.abc123'),{mode:0o700});return '.local/bin/.jhw-control-hook-link-txn.abc123';}],
 ['pending_transaction', 'codex-legacy-txn', (h,f)=>{fs.mkdirSync(path.join(h,'.codex/commands/.jhw-control-hook-link-txn.abc123'),{recursive:true,mode:0o700});fs.symlinkSync(path.join(f.root,'.jhw-runtime/current/skills/claude'),path.join(h,'.codex/commands/jhw'));
  // Removing an owned legacy link resolves current/, which a first activation has not published yet.
  return ()=>{fs.rmdirSync(path.join(h,'.codex/commands/.jhw-control-hook-link-txn.abc123'));fs.unlinkSync(path.join(h,'.codex/commands/jhw'));};}],
 ['pending_transaction', 'codex-commands-txn-without-link', h=>{fs.mkdirSync(path.join(h,'.codex/commands/.jhw-control-hook-link-txn.abc123'),{recursive:true,mode:0o700});return '.codex/commands/.jhw-control-hook-link-txn.abc123';}],
 ['unsafe_parent', 'launcher-parent-link', (h,f)=>{const bin=path.join(h,'.local/bin'),real=path.join(path.dirname(h),'bin-real');fs.renameSync(bin,real);fs.symlinkSync(real,bin);fs.symlinkSync(path.join(f.root,'scripts/jhw-control-hook'),path.join(real,'jhw-control-hook'));return ()=>{fs.unlinkSync(bin);fs.renameSync(real,bin);};}],
 ['parent_unusable', 'codex-skills-file', h=>{write(h,'.codex/skills','foreign');return '.codex/skills';}],
 ['parent_unusable', 'claude-commands-file', h=>{write(h,'.claude/commands','foreign');return '.claude/commands';}],
 ['parent_unusable', 'codex-prompts-readonly', h=>{fs.mkdirSync(path.join(h,'.codex/prompts'),{recursive:true,mode:0o700});fs.chmodSync(path.join(h,'.codex/prompts'),0o555);return '.codex/prompts';}],
 ['plan_unverified', 'unreadable-mcp-config', h=>{fs.mkdirSync(path.join(h,'.claude'),{mode:0o700});write(h,'.claude.json','{}',0o600);fs.chmodSync(path.join(h,'.claude.json'),0);return ()=>fs.chmodSync(path.join(h,'.claude.json'),0o600);}],
 ['control_link', 'cli', h=>{fs.symlinkSync('/foreign/control',path.join(h,'.local/bin/jhw-control'));return '.local/bin/jhw-control';}],
 ['hook_link', 'hook', h=>{write(h,'.local/bin/jhw-control-hook','#!/bin/sh\n',0o755);return '.local/bin/jhw-control-hook';}],
 ['command_dir', 'claude', h=>{fs.mkdirSync(path.join(h,'.claude/commands/jhw'),{recursive:true,mode:0o700});write(h,'.claude/commands/jhw/marker','foreign');return '.claude/commands/jhw';}],
 ['command_dir', 'gemini', h=>{fs.mkdirSync(path.join(h,'.gemini/commands'),{recursive:true});fs.symlinkSync('/foreign/commands',path.join(h,'.gemini/commands/jhw'));return '.gemini/commands/jhw';}],
 ['command_dir', 'opencode', h=>{write(h,'.config/opencode/skills/jhw','foreign');return '.config/opencode/skills/jhw';}],
 ['command_dir', 'codex-legacy', h=>{fs.mkdirSync(path.join(h,'.codex'),{mode:0o700});write(h,'.codex/commands/jhw','foreign');return '.codex/commands/jhw';}],
 ['skill_link', 'codex-skill', h=>{fs.mkdirSync(path.join(h,'.codex'),{mode:0o700});fs.mkdirSync(path.join(h,'.codex/skills/jhw-task'),{recursive:true});return '.codex/skills/jhw-task';}],
 ['prompt_link', 'codex-prompt', h=>{fs.mkdirSync(path.join(h,'.codex/prompts'),{recursive:true,mode:0o700});fs.symlinkSync('/foreign/task.md',path.join(h,'.codex/prompts/task.md'));return '.codex/prompts/task.md';}],
 ['mcp_entry', 'claude-mcp', h=>{fs.mkdirSync(path.join(h,'.claude'),{mode:0o700});write(h,'.claude.json','{"mcpServers":{"jhw-notion":{"command":"node","args":["/foreign/index.js"]}}}',0o600);return '.claude.json';}],
 ['mcp_entry', 'gemini-mcp', h=>{write(h,'.gemini/settings.json','{"mcpServers":{"jhw-notion":{"command":"python","args":[]}}}',0o600);return '.gemini/settings.json';}],
 ['mcp_entry', 'opencode-mcp', h=>{write(h,'.config/opencode/opencode.json','{"mcp":{"jhw-notion":{"type":"remote"}}}',0o600);return '.config/opencode/opencode.json';}],
 ['mcp_entry', 'codex-mcp', h=>{fs.mkdirSync(path.join(h,'.codex'),{mode:0o700});write(h,'.codex/config.toml','[mcp_servers.jhw-notion]\ncommand = "python"\nargs = []\n',0o600);return '.codex/config.toml';}],
 ['hook_config', 'claude-hooks', h=>{fs.mkdirSync(path.join(h,'.claude'),{mode:0o700});fs.symlinkSync('/foreign/settings.json',path.join(h,'.claude/settings.json'));return '.claude/settings.json';}],
 ['hook_config', 'codex-hooks', h=>{fs.mkdirSync(path.join(h,'.codex/hooks.json'),{recursive:true,mode:0o700});return '.codex/hooks.json';}],
];
for (const [reason, label, occupy] of foreignDestinations) {
 test(`first activation plan refuses foreign ${label} destination with zero mutation`, async t => {
  const f=fixture(t);host(f);const decoy=occupy(f.home,f);
  const runtime=path.join(f.root,'.jhw-runtime');
  const release=await f.run(['--prepare']);
  const runtimeBefore=fs.readdirSync(runtime).sort();
  const home=homeObservation(f.home);const phases=[];
  await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:async ({phase})=>{phases.push(phase);}}),{code:'DEPLOY_WIRING_CONFLICT',reason});
  assert.deepEqual(phases,[]);
  assert.deepEqual(homeObservation(f.home),home);
  assert.deepEqual(fs.readdirSync(runtime).filter(name=>name.startsWith('.deploy.')),[]);
  assert.deepEqual(fs.readdirSync(runtime).filter(name=>!name.endsWith('.lock')).sort(),runtimeBefore.filter(name=>!name.endsWith('.lock')));
  for(const name of ['current','bootstrap','wiring.json'])assert.equal(fs.existsSync(path.join(runtime,name)),false,name);
  const status=await f.run(['--status']);assert.equal(status.releaseId,null);assert.equal(status.recoveryPending,0);
  // Removing only the decoy must suffice: the refusal left no residue.
  if(typeof decoy==='function')decoy();else fs.rmSync(path.join(f.home,decoy),{recursive:true,force:true});
  const activated=await f.run(['--activate',release.releaseId]);
  assert.equal(activated.code,'DEPLOY_ACTIVATED');assert.equal(activated.releaseId,release.releaseId);
 });
}
test('first activation plan timeout is unverified and leaves zero mutation', async t => {
 const f=fixture(t);host(f);for(const p of ['.claude','.codex'])fs.mkdirSync(path.join(f.home,p),{mode:0o700});
 const runtime=path.join(f.root,'.jhw-runtime');const release=await f.run(['--prepare']);const home=homeObservation(f.home);
 await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],planTimeoutMs:1}),{code:'DEPLOY_WIRING_CONFLICT',reason:'plan_unverified'});
 assert.deepEqual(homeObservation(f.home),home);
 assert.deepEqual(fs.readdirSync(runtime).filter(name=>name.startsWith('.deploy.')||['current','bootstrap','wiring.json'].includes(name)),[]);
 assert.equal((await f.run(['--activate',release.releaseId])).code,'DEPLOY_ACTIVATED');
});
// Type, link target, bytes, and mode of every HOME entry; restore may change
// directory mtimes and inode numbers of restored entries, so those are omitted.
const homeShape = home => homeObservation(home).map(({name,mode,content})=>({name,mode,content}));
function assertFirstActivationRolledBack(f, shape) {
 const runtime=path.join(f.root,'.jhw-runtime');
 assert.equal(fs.existsSync(path.join(runtime,'current')),false);assert.equal(fs.existsSync(path.join(runtime,'wiring.json')),false);
 const journals=fs.readdirSync(runtime).filter(name=>name.startsWith('.deploy.')).map(name=>JSON.parse(fs.readFileSync(path.join(runtime,name,'state.json'))));
 assert.deepEqual(journals.map(state=>[state.status,state.phase]),[['complete','wire_rolled_back']]);
 assert.deepEqual(homeShape(f.home),shape);
}
const lateWireFailures = [
 ['home-not-writable', h=>{fs.mkdirSync(path.join(h,'.claude'),{mode:0o700});fs.mkdirSync(path.join(h,'.codex'),{mode:0o700});fs.chmodSync(h,0o500);}, h=>fs.chmodSync(h,0o700)],
 ['gemini-not-writable', (h,f)=>{fs.mkdirSync(path.join(h,'.gemini/commands'),{recursive:true});fs.chmodSync(path.join(h,'.gemini/commands'),0o700);fs.symlinkSync(path.join(f.root,'.jhw-runtime/current/skills/claude'),path.join(h,'.gemini/commands/jhw'));fs.chmodSync(path.join(h,'.gemini'),0o555);}, h=>fs.chmodSync(path.join(h,'.gemini'),0o700)],
];
for (const [label, occupy, fix] of lateWireFailures) {
 test(`first activation late wire failure (${label}) restores HOME before any pointer`, async t => {
  const f=fixture(t);host(f);const release=await f.run(['--prepare']);occupy(f.home,f);
  try {
  const shape=homeShape(f.home);
  await assert.rejects(f.run(['--activate',release.releaseId]),{code:'DEPLOY_WIRING_FAILED',reason:'first_activation_rolled_back'});
  assertFirstActivationRolledBack(f,shape);
  const status=await f.run(['--status']);assert.equal(status.releaseId,null);assert.equal(status.recoveryPending,0);
  // The inert bootstrap installed before wire is reused unchanged by the retry.
  const bootstrap=fs.statSync(path.join(f.root,'.jhw-runtime/bootstrap')).ino;
  fix(f.home);
  assert.equal((await f.run(['--activate',release.releaseId])).code,'DEPLOY_ACTIVATED');
  assert.equal(fs.statSync(path.join(f.root,'.jhw-runtime/bootstrap')).ino,bootstrap);
  assert.deepEqual(fs.readdirSync(path.join(f.root,'.jhw-runtime')).filter(name=>name.startsWith('.bootstrap.')),[]);
  } finally {fix(f.home);}
 });
}
test('first activation refuses an unsearchable destination directory at preimage capture', async t => {
 const f=fixture(t);host(f);const release=await f.run(['--prepare']);
 fs.mkdirSync(path.join(f.home,'.codex/skills'),{recursive:true,mode:0o700});const shape=homeShape(f.home);fs.chmodSync(path.join(f.home,'.codex/skills'),0o600);
 try{await assert.rejects(f.run(['--activate',release.releaseId]),{code:'DEPLOY_FAILED'});}finally{fs.chmodSync(path.join(f.home,'.codex/skills'),0o700);}
 assert.deepEqual(homeShape(f.home),shape);assert.equal(fs.existsSync(path.join(f.root,'.jhw-runtime/current')),false);
 assert.equal((await f.run(['--status'])).recoveryPending,0);
});
test('first activation rolls back hooks, MCP, links, and launcher migration after a late wire failure', async t => {
 const f=fixture(t);host(f);for(const p of ['.claude','.codex','.gemini'])fs.mkdirSync(path.join(f.home,p),{mode:0o700});
 fs.symlinkSync(path.join(f.root,'scripts/jhw-control-hook'),path.join(f.home,'.local/bin/jhw-control-hook'));
 write(f.home,'.claude/settings.json','{"hooks":{}}\n',0o600);
 const release=await f.run(['--prepare']);const shape=homeShape(f.home);const hooks=path.join(f.home,'.codex/hooks.json');let wired=false;
 // A foreign Codex hooks object appears only while wire runs, so every earlier wire mutation must be undone.
 const phaseRunner=async options=>{
  if(options.phase!=='wire')return deploy.wiringPhase(options);
  fs.mkdirSync(hooks,{mode:0o700});
  try{return await deploy.wiringPhase(options);}finally{wired=fs.existsSync(path.join(f.home,'.claude.json'));fs.rmdirSync(hooks);}
 };
 await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner}),{code:'DEPLOY_WIRING_FAILED',reason:'first_activation_rolled_back'});
 assert.equal(wired,true);
 assertFirstActivationRolledBack(f,shape);
 assert.equal((await f.run(['--status'])).recoveryPending,0);
 assert.equal((await f.run(['--activate',release.releaseId])).code,'DEPLOY_ACTIVATED');
 assert.equal(fs.readlinkSync(path.join(f.home,'.local/bin/jhw-control-hook')),path.join(f.root,'.jhw-runtime/bootstrap/jhw-runtime-hook'));
});
// Wire with a foreign Codex hooks object present only while wire runs: every
// earlier wire mutation (links, MCP, Claude hooks) must then be undone.
const lateCodexHookFailure = (f, {beforeRestore}={}) => async options => {
 const hooks=path.join(f.home,'.codex/hooks.json');
 if(options.phase!=='wire')return deploy.wiringPhase(options);
 fs.mkdirSync(hooks,{mode:0o700});
 try{return await deploy.wiringPhase(options);}finally{fs.rmdirSync(hooks);beforeRestore?.();}
};
// A preimage under the 2 MiB bound whose registration pretty-prints past it
// must still be recognised as this deployment's output and restored.
test('first activation rollback restores an MCP config that registration grew past 2 MiB', async t => {
 const f=fixture(t);host(f);for(const p of ['.claude','.codex'])fs.mkdirSync(path.join(f.home,p),{mode:0o700});
 const compact=JSON.stringify({padding:Array.from({length:300000},()=>[1])});
 assert.ok(compact.length<2*1024*1024);
 write(f.home,'.claude.json',compact,0o600);
 const release=await f.run(['--prepare']);const shape=homeShape(f.home);let wiredSize;
 await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:lateCodexHookFailure(f,{beforeRestore:()=>{wiredSize=fs.statSync(path.join(f.home,'.claude.json')).size;}})}),{code:'DEPLOY_WIRING_FAILED',reason:'first_activation_rolled_back'});
 assert.ok(wiredSize>2*1024*1024);
 assertFirstActivationRolledBack(f,shape);
 assert.equal(fs.readFileSync(path.join(f.home,'.claude.json'),'utf8'),compact);
 assert.equal((await f.run(['--status'])).recoveryPending,0);
});
// An entry already equal to its preimage needs no editor replay, so an
// unusable editor at restore time cannot fail an otherwise complete rollback.
test('first activation rollback does not replay the editor for entries already at their preimage', async t => {
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.claude'),{mode:0o700});write(f.home,'.claude.json','{"other":1}\n',0o600);
 const release=await f.run(['--prepare']);const shape=homeShape(f.home);
 const editor=path.join(f.root,'.jhw-runtime/releases',release.releaseId,'scripts/install-config.mjs');const mode=fs.statSync(editor).mode&0o7777;
 // Wire fails before any HOME write; the editor becomes untrusted before the restore.
 const phaseRunner=async ({phase})=>{if(phase==='wire')throw new Error('injected wire failure');if(phase==='rollback')fs.chmodSync(editor,0o666);};
 try {await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner}),{code:'DEPLOY_WIRING_FAILED',reason:'first_activation_rolled_back'});}
 finally {fs.chmodSync(editor,mode);}
 assertFirstActivationRolledBack(f,shape);
});
test('first activation rollback restores Codex config and preserves every pre-existing editor backup', async t => {
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.codex'),{mode:0o700});
 const config=path.join(f.home,'.codex/config.toml');write(f.home,'.codex/config.toml','[other]\nkey = 1\n',0o600);
 const old=['20200101000000','20210101000000','20220101000000'].map((stamp,index)=>`config.toml.bak.jhw-notion.${stamp}.0000000${index}-0000-4000-8000-000000000000`);
 for(const name of old)write(f.home,`.codex/${name}`,`backup ${name}\n`,0o600);
 const release=await f.run(['--prepare']);const shape=homeShape(f.home);
 let wiredBackups;const countBackups=()=>{wiredBackups=fs.readdirSync(path.join(f.home,'.codex')).filter(name=>name.startsWith('config.toml.bak.')).length;};
 await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:lateCodexHookFailure(f,{beforeRestore:countBackups})}),{code:'DEPLOY_WIRING_FAILED',reason:'first_activation_rolled_back'});
 assert.equal(wiredBackups,4);
 assertFirstActivationRolledBack(f,shape);
 assert.deepEqual(fs.readdirSync(path.join(f.home,'.codex')).filter(name=>name.startsWith('config.toml.bak.')).sort(),old);
 for(const name of old)assert.equal(fs.readFileSync(path.join(f.home,'.codex',name),'utf8'),`backup ${name}\n`);
 assert.equal(fs.readFileSync(config,'utf8'),'[other]\nkey = 1\n');
});
test('first activation removes an owned legacy Codex commands link before current is published', async t => {
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.codex/commands'),{recursive:true,mode:0o700});
 fs.symlinkSync(path.join(f.root,'.jhw-runtime/current/skills/claude'),path.join(f.home,'.codex/commands/jhw'));
 const release=await f.run(['--prepare']);
 assert.equal((await f.run(['--activate',release.releaseId])).code,'DEPLOY_ACTIVATED');
 assert.deepEqual(fs.readdirSync(path.join(f.home,'.codex/commands')),[]);
 assert.equal((await f.run(['--status'])).recoveryPending,0);
});
test('first activation rollback fails closed when a wire helper rollback step fails', async t => {
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.claude'),{mode:0o700});
 const release=await f.run(['--prepare']);const bin=path.join(f.home,'.local/bin');fs.chmodSync(f.home,0o500);
 try {
  // The launcher removal transaction cannot allocate while bin is read-only; the driver restore could.
  const phaseRunner=async options=>{
   if(options.phase!=='rollback')return deploy.wiringPhase(options);
   fs.chmodSync(bin,0o500);try{return await deploy.wiringPhase(options);}finally{fs.chmodSync(bin,0o700);}
  };
  await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner}),{code:'DEPLOY_RECOVERY_REQUIRED',reason:'wire_rollback_failed'});
  assert.equal((await f.run(['--status'])).recoveryPending,1);
 } finally {fs.chmodSync(f.home,0o700);}
});
test('first activation rollback fails closed when a wire transaction artifact remains', async t => {
 const f=fixture(t);host(f);for(const p of ['.claude','.codex'])fs.mkdirSync(path.join(f.home,p),{mode:0o700});
 const release=await f.run(['--prepare']);const leftover=path.join(f.home,'.codex/commands/.jhw-control-hook-link-txn.abc123');
 await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:lateCodexHookFailure(f,{beforeRestore:()=>fs.mkdirSync(leftover,{recursive:true,mode:0o700})})}),{code:'DEPLOY_RECOVERY_REQUIRED',reason:'wire_rollback_failed'});
 assert.equal(fs.existsSync(leftover),true);assert.equal((await f.run(['--status'])).recoveryPending,1);
});
test('first activation restore never follows a symlink swapped in between inspection and read', async t => {
 const f=fixture(t);host(f);for(const p of ['.claude','.codex'])fs.mkdirSync(path.join(f.home,p),{mode:0o700});
 const release=await f.run(['--prepare']);const config=path.join(f.home,'.claude.json');const outside=path.join(path.dirname(f.home),'outside.json');
 // Swap the wired config for a symlink to identical bytes at the moment restore reads it.
 let armed=false;const realOpen=fs.openSync,realRead=fs.readFileSync;
 const swap=name=>{if(armed&&typeof name==='string'&&name.endsWith('/.claude.json')){armed=false;fs.renameSync(config,outside);fs.symlinkSync(outside,config);}};
 fs.openSync=function(name,...rest){swap(name);return realOpen.call(this,name,...rest);};
 fs.readFileSync=function(name,...rest){swap(name);return realRead.call(this,name,...rest);};
 try {
  await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:lateCodexHookFailure(f,{beforeRestore:()=>{armed=true;}})}),{code:'DEPLOY_RECOVERY_REQUIRED',reason:'wire_rollback_failed'});
 } finally {fs.openSync=realOpen;fs.readFileSync=realRead;}
 assert.equal(armed,false);assert.equal(fs.readlinkSync(config),outside);assert.equal(fs.existsSync(outside),true);
});
test('first activation restore never deletes an object swapped in before a destructive step', async t => {
 const f=fixture(t);host(f);for(const p of ['.claude','.codex'])fs.mkdirSync(path.join(f.home,p),{mode:0o700});
 const release=await f.run(['--prepare']);const control=path.join(f.home,'.local/bin/jhw-control');
 // Replace the verified wired link with a foreign one at the moment restore removes or moves it.
 let armed=false;const realUnlink=fs.unlinkSync,realRename=fs.renameSync,realSymlink=fs.symlinkSync;
 const swap=name=>{if(armed&&typeof name==='string'&&name.endsWith('/jhw-control')){armed=false;realUnlink(control);realSymlink('/foreign/control',control);}};
 fs.unlinkSync=function(name,...rest){swap(name);return realUnlink.call(this,name,...rest);};
 fs.renameSync=function(name,...rest){swap(name);return realRename.call(this,name,...rest);};
 try {
  await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:lateCodexHookFailure(f,{beforeRestore:()=>{armed=true;}})}),{code:'DEPLOY_RECOVERY_REQUIRED',reason:'wire_rollback_failed'});
 } finally {fs.unlinkSync=realUnlink;fs.renameSync=realRename;}
 assert.equal(armed,false);assert.equal(fs.readlinkSync(control),'/foreign/control');
 assert.equal((await f.run(['--status'])).recoveryPending,1);
});
test('owned-link removal accepts the unpublished managed skill root only for command directories', async t => {
 const f=fixture(t);const skills=path.join(f.root,'.jhw-runtime/current/skills/claude');
 const remove=relative=>{
  const link=path.join(f.home,relative);fs.mkdirSync(path.dirname(link),{recursive:true,mode:0o700});fs.chmodSync(path.dirname(link),0o700);fs.symlinkSync(skills,link);
  const transaction=path.join(path.dirname(link),'.jhw-control-hook-link-txn.test01');fs.mkdirSync(transaction,{mode:0o700});
  const result=spawnSync(process.execPath,[path.join(f.root,'scripts/install-config.mjs'),'remove-control-hook-link-transaction',link,skills,f.root,transaction],{env:{...process.env,HOME:f.home},stdio:'ignore'});
  return {status:result.status,link};
 };
 const command=remove('.codex/commands/jhw');assert.equal(command.status,0);assert.equal(fs.existsSync(command.link)||fs.lstatSync(path.dirname(command.link)).isDirectory()&&fs.readdirSync(path.dirname(command.link)).includes('jhw'),false);
 const control=remove('.local/bin/jhw-control');assert.notEqual(control.status,0);assert.equal(fs.readlinkSync(control.link),skills);
});
test('first activation keeps a pending journal when a wired destination is replaced by a foreign object', async t => {
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.claude'),{mode:0o700});
 const release=await f.run(['--prepare']);const control=path.join(f.home,'.local/bin/jhw-control');fs.chmodSync(f.home,0o500);
 try {
 const phaseRunner=async options=>{
  if(options.phase!=='wire')return deploy.wiringPhase(options);
  try{return await deploy.wiringPhase(options);}finally{fs.unlinkSync(control);fs.symlinkSync('/foreign/control',control);}
 };
 await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner}),{code:'DEPLOY_RECOVERY_REQUIRED',reason:'wire_rollback_failed'});
 assert.equal(fs.readlinkSync(control),'/foreign/control');
 assert.equal(fs.existsSync(path.join(f.root,'.jhw-runtime/current')),false);
 const runtime=path.join(f.root,'.jhw-runtime');
 const states=fs.readdirSync(runtime).filter(name=>name.startsWith('.deploy.')).map(name=>JSON.parse(fs.readFileSync(path.join(runtime,name,'state.json'))));
 assert.deepEqual(states.map(state=>[state.status,state.phase]),[['pending','wire_rollback_failed']]);
 assert.equal((await f.run(['--status'])).recoveryPending,1);
 await assert.rejects(f.run(['--activate',release.releaseId]),{code:'DEPLOY_RECOVERY_REQUIRED'});
 } finally {fs.chmodSync(f.home,0o700);}
});
test('first activation plan accepts destinations already exactly owned by this checkout', async t => {
 const f=fixture(t);host(f);for(const p of ['.claude/commands','.gemini','.codex/skills','.codex/prompts','.config/opencode'])fs.mkdirSync(path.join(f.home,p),{recursive:true,mode:0o700});
 const runtime=path.join(f.root,'.jhw-runtime');
 fs.symlinkSync(path.join(runtime,'bootstrap/jhw-runtime-control'),path.join(f.home,'.local/bin/jhw-control'));
 fs.symlinkSync(path.join(f.root,'scripts/jhw-control-hook'),path.join(f.home,'.local/bin/jhw-control-hook'));
 fs.symlinkSync(path.join(runtime,'current/skills/claude'),path.join(f.home,'.claude/commands/jhw'));
 fs.symlinkSync(path.join(runtime,'current/skills/codex/jhw-task'),path.join(f.home,'.codex/skills/jhw-task'));
 fs.symlinkSync(path.join(runtime,'current/skills/claude/task.md'),path.join(f.home,'.codex/prompts/task.md'));
 write(f.root,'mcp-server/dist/index.js','old');
 write(f.home,'.claude.json',JSON.stringify({mcpServers:{'jhw-notion':{command:'node',args:[path.join(f.root,'mcp-server/dist/index.js')]}}}),0o600);
 const release=await f.run(['--prepare']);
 const activated=await f.run(['--activate',release.releaseId]);
 assert.equal(activated.code,'DEPLOY_ACTIVATED');
 assert.equal(fs.readlinkSync(path.join(f.home,'.local/bin/jhw-control-hook')),path.join(runtime,'bootstrap/jhw-runtime-hook'));
 assert.equal(fs.readlinkSync(path.join(f.home,'.codex/skills/jhw-task')),path.join(runtime,'current/skills/codex/jhw-task'));
});

test('second inventory runs after both real leases and refuses a racing consumer before publication',async t=>{
 const f=fixture(t);const release=await f.run(['--prepare']);const original=fs.openSync;let added=false;
 fs.openSync=function(name,...args){const fd=original.call(this,name,...args);if(!added&&String(name).endsWith('/admission.lock')){added=true;addConsumer(f);}return fd;};
 try{await assert.rejects(f.run(['--activate',release.releaseId]),{code:'DEPLOY_CONSUMERS_ACTIVE'});}finally{fs.openSync=original;}
 assert.equal(added,true);assert.equal(readActivation({repositoryRoot:f.root}),null);assert.deepEqual(fs.readdirSync(f.home),[]);
});
test('validation opens admission while deployment remains serialized; failed reacquisition preserves pending state',async t=>{
 const f=fixture(t);host(f);const release=await f.run(['--prepare']);let shared;const phases=[];
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

test('pointer replacement failure before readback retains a rollback destination', async t => {
  const f=fixture(t); host(f);
  const first=await f.run(['--prepare']); await f.run(['--activate',first.releaseId]);
  write(f.root,'mcp-server/src/index.ts','export const pointerFailure=1;');
  const second=await f.run(['--prepare']);
  const realRename=fs.renameSync; const realFsync=fs.fsyncSync; let replaced=false; let injected=false;
  fs.renameSync=function(source,destination,...rest) {
    const result=realRename.call(this,source,destination,...rest);
    if(path.basename(String(destination))==='current') replaced=true;
    return result;
  };
  fs.fsyncSync=function(fd,...rest) {
    let descriptor=''; try { descriptor=fs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
    if(replaced&&!injected&&descriptor===path.join(f.root,'.jhw-runtime')) { injected=true; throw new Error('injected pointer directory fsync failure'); }
    return realFsync.call(this,fd,...rest);
  };
  try { await assert.rejects(f.run(['--activate',second.releaseId])); }
  finally { fs.renameSync=realRename; fs.fsyncSync=realFsync; }
  assert.equal(injected,true);
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,second.releaseId);
  assert.equal((await f.run(['--status'])).recoveryPending,1);
  await f.run(['--rollback']);
  assert.equal(readActivation({repositoryRoot:f.root}).releaseId,first.releaseId);
  assert.equal((await f.run(['--status'])).recoveryPending,0);
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
 const planned=path.join(f.home,'plan-seen');
 // The read-only plan queries the host first; block only the mutation worker.
 fs.writeFileSync(hostPath,`#!/bin/sh\nif [ ! -f '${planned}' ]; then touch '${planned}'; else touch '${ready}'\nwhile [ ! -f '${resume}' ]; do /bin/sleep 0.01; done; fi\n${original.split('\n').slice(1).join('\n')}`);
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
      write(args.stagingRoot, 'mcp-server/dist/runtime/mcp.cjs', 'process.exit(23);');
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
 const f=fixture(t);host(f);const release=await f.run(['--prepare']);const foreign=path.join(f.home,'foreign');fs.mkdirSync(foreign,{mode:0o700});const original=fs.openSync;let swapped=false;
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
        write(args.stagingRoot, 'mcp-server/dist/runtime/mcp.cjs', 'process.exit(23);');
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
 const f=fixture(t);host(f);const hostPath=path.join(f.home,'.local/bin/jhw-control-host');fs.writeFileSync(hostPath,fs.readFileSync(hostPath,'utf8').replace('#!/bin/sh\n','#!/bin/sh\n/bin/sleep 1\n'));const release=await f.run(['--prepare']);await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseTimeoutMs:50}),{code:'DEPLOY_RECOVERY_REQUIRED',reason:'wire_rollback_failed'});assert.equal(readActivation({repositoryRoot:f.root}),null);assert.equal((await f.run(['--status'])).recoveryPending,1);assert.throws(()=>acquireLease(path.join(f.root,'.jhw-runtime/admission.lock')),{code:'DEPLOY_LOCK_CONTENDED'});const end=Date.now()+5000;while(true){try{const lock=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock'));lock.close();break;}catch(error){if(error.code!=='DEPLOY_LOCK_CONTENDED'||Date.now()>end)throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
});


test('journal directory replacement cannot chmod a foreign symlink target',async t=>{
 const f=fixture(t);host(f);const release=await f.run(['--prepare']);const foreign=path.join(f.home,'foreign-mode');fs.mkdirSync(foreign,{mode:0o755});fs.chmodSync(foreign,0o755);const original=fs.mkdirSync;let swapped=false;
 fs.mkdirSync=function(name,...args){const result=original.call(this,name,...args);if(!swapped&&path.basename(String(name)).startsWith('.deploy.')){swapped=true;fs.renameSync(name,String(name)+'.retained');fs.symlinkSync(foreign,name);}return result;};
 try{await assert.rejects(f.run(['--activate',release.releaseId]));}finally{fs.mkdirSync=original;}
 assert.equal(swapped,true);assert.equal(fs.statSync(foreign).mode&0o777,0o755);assert.deepEqual(fs.readdirSync(foreign),[]);
});


test('first migration failure retains exact bounded configuration and launcher preimages',async t=>{
 const f=fixture(t);host(f);fs.mkdirSync(path.join(f.home,'.claude'),{mode:0o700});write(f.root,'mcp-server/dist/index.js','legacy');const original=JSON.stringify({mcpServers:{'jhw-notion':{command:'node',args:[path.join(f.root,'mcp-server/dist/index.js')]}},foreign:'private-preimage-marker'})+'\n';write(f.home,'.claude.json',original,0o640);const link=path.join(f.root,'scripts/jhw-control-hook');fs.symlinkSync(link,path.join(f.home,'.local/bin/jhw-control-hook'));
 const release=await deploy.runDeployment({...f.options,argv:['--prepare'],build:async args=>{await f.build(args);write(args.stagingRoot,'mcp-server/dist/runtime/mcp.cjs','process.exit(23);');}});await assert.rejects(f.run(['--activate',release.releaseId]),{code:'DEPLOY_VALIDATION_FAILED'});
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
        content:info.isSymbolicLink() ? fs.readlinkSync(file) : info.isFile() ? ((info.mode & 0o400n) ? fs.readFileSync(file).toString('base64') : 'unreadable') : null,
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

// Publication failures after a completed first wire.
const armAfterWire = arm => async options => {
 const result=await deploy.wiringPhase(options);
 if(options.phase==='wire')arm();
 return result;
};
function firstWireFixture(t) {
 const f=fixture(t);host(f);for(const p of ['.claude','.codex'])fs.mkdirSync(path.join(f.home,p),{mode:0o700});return f;
}
for (const [label, isTarget] of [
 ['before the pointer switch', destination=>path.basename(String(destination))==='current'],
 ['while staging the activation record', destination=>/^a-[a-f0-9]{32}$/.test(path.basename(String(destination)))],
]) {
 test(`first activation publication failure ${label} restores HOME at the origin pointer`, async t => {
  const f=firstWireFixture(t);const release=await f.run(['--prepare']);const shape=homeShape(f.home);
  let armed=false;let injected=false;const realRename=fs.renameSync;
  fs.renameSync=function(source,destination,...rest){if(armed&&isTarget(destination)){armed=false;injected=true;throw new Error('injected publication failure');}return realRename.call(this,source,destination,...rest);};
  try {
   await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:armAfterWire(()=>{armed=true;})}),{code:'DEPLOY_WIRING_FAILED',reason:'first_activation_rolled_back'});
  } finally {fs.renameSync=realRename;}
  assert.equal(injected,true);
  assertFirstActivationRolledBack(f,shape);
  assert.equal((await f.run(['--status'])).recoveryPending,0);
  assert.equal((await f.run(['--activate',release.releaseId])).code,'DEPLOY_ACTIVATED');
 });
}
function assertPublicationUncertain(f) {
 const runtime=path.join(f.root,'.jhw-runtime');
 assert.equal(fs.readlinkSync(path.join(f.home,'.claude/commands/jhw')),path.join(runtime,'current/skills/claude'));
 assert.equal(fs.readlinkSync(path.join(f.home,'.local/bin/jhw-control')),path.join(runtime,'bootstrap/jhw-runtime-control'));
 const states=fs.readdirSync(runtime).filter(name=>name.startsWith('.deploy.')).map(name=>JSON.parse(fs.readFileSync(path.join(runtime,name,'state.json'))));
 assert.deepEqual(states.map(state=>[state.status,state.phase]),[['pending','publication_uncertain']]);
}
test('first activation publication failure after the pointer moved keeps HOME wired and the journal pending', async t => {
 const f=firstWireFixture(t);const release=await f.run(['--prepare']);const runtime=path.join(f.root,'.jhw-runtime');
 let armed=false;let replaced=false;let injected=false;const realRename=fs.renameSync,realFsync=fs.fsyncSync;
 fs.renameSync=function(source,destination,...rest){const result=realRename.call(this,source,destination,...rest);if(armed&&path.basename(String(destination))==='current')replaced=true;return result;};
 fs.fsyncSync=function(fd,...rest){let descriptor='';try{descriptor=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}if(replaced&&!injected&&descriptor===runtime){injected=true;throw new Error('injected pointer fsync failure');}return realFsync.call(this,fd,...rest);};
 try {
  await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:armAfterWire(()=>{armed=true;})}),{code:'DEPLOY_RECOVERY_REQUIRED',reason:'publication_uncertain'});
 } finally {fs.renameSync=realRename;fs.fsyncSync=realFsync;}
 assert.equal(injected,true);assert.equal(readActivation({repositoryRoot:f.root}).releaseId,release.releaseId);
 assertPublicationUncertain(f);assert.equal((await f.run(['--status'])).recoveryPending,1);
});
test('first activation publication failure with a foreign pointer never restores HOME', async t => {
 const f=firstWireFixture(t);const release=await f.run(['--prepare']);const pointer=path.join(f.root,'.jhw-runtime/current');
 await assert.rejects(deploy.runDeployment({...f.options,argv:['--activate',release.releaseId],phaseRunner:armAfterWire(()=>fs.symlinkSync('activations/a-00000000000000000000000000000000',pointer))}),{code:'DEPLOY_RECOVERY_REQUIRED',reason:'publication_uncertain'});
 assert.equal(fs.readlinkSync(pointer),'activations/a-00000000000000000000000000000000');
 assertPublicationUncertain(f);
});
