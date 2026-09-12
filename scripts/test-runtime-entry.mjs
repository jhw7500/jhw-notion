import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { acquireLease } from './runtime-safety.mjs';
import { prepareRelease, publishActivation } from './runtime-store.mjs';

const entry = await import('./runtime-entry.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const source = path.dirname(fileURLToPath(import.meta.url));
const helpers = ['runtime-entry.mjs', 'runtime-safety.mjs', 'runtime-store.mjs', 'jhw-runtime-entry', 'jhw-runtime-control', 'jhw-runtime-hook'];
function write(root, name, bytes, mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, bytes, { mode });
  fs.chmodSync(file, mode);
  return file;
}
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function fixture(t, body = "process.stdin.pipe(process.stdout); process.stderr.write('fixture-stderr\\n'); process.stdin.on('end', () => { process.exitCode = 23; });", hookBody = "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse'}})+'\\n');", helperEdits = {}) {
  assert.equal(typeof entry.installBootstrap, 'function', 'complete validated bootstrap installation must exist');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-entry-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries({ '.gitignore':'.jhw-runtime/\n', 'mcp-server/package.json':'{"type":"module"}', 'mcp-server/package-lock.json':'{"lockfileVersion":3}', 'mcp-server/tsconfig.json':'{}', 'mcp-server/src/index.ts':'export {};', 'mcp-server/scripts/clean-dist.mjs':'', 'scripts/sync-codex-skills.mjs':'', 'skills/claude/task.md':'fixture' })) write(root, name, bytes);
  for (const name of [...helpers, 'jhw-control-hook']) {
    const original=fs.readFileSync(path.join(source,name));
    write(root,`scripts/${name}`,helperEdits[name] ? helperEdits[name](original.toString(),root) : original,name.startsWith('jhw-') ? 0o755 : 0o644);
  }
  git(root, ['init', '-q']); git(root, ['add', '.']);
  git(root, ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const prepare = () => prepareRelease({ repositoryRoot: root, build: async ({stagingRoot}) => {
    write(stagingRoot, 'mcp-server/dist/index.js', body);
    write(stagingRoot, 'mcp-server/dist/control/cli.js', '#!/usr/bin/env node\n'+body, 0o755);
    write(stagingRoot, 'mcp-server/dist/control/hook-adapter.js', '#!/usr/bin/env node\n'+hookBody, 0o755);
    fs.mkdirSync(path.join(stagingRoot, 'mcp-server/node_modules'), { mode: 0o755 });
  }});
  const release = await prepare();
  const deploy = acquireLease(path.join(root,'.jhw-runtime/deploy.lock'));
  const lease = acquireLease(path.join(root,'.jhw-runtime/admission.lock'), { create:true });
  let activation;
  try {
    await entry.installBootstrap({ repositoryRoot:root, releaseId:release.releaseId });
    activation = publishActivation({ repositoryRoot:root, releaseId:release.releaseId, expectedCurrent:null });
  } finally { lease.close(); deploy.close(); }
  return { root, release, activation, prepare, bootstrap:path.join(root,'.jhw-runtime/bootstrap'), lock:path.join(root,'.jhw-runtime/admission.lock') };
}
function run(f, name = 'jhw-runtime-entry', args = ['mcp'], input = '') {
  return spawnSync(path.join(f.bootstrap,name), args, { input, encoding:'utf8', timeout:12000 });
}
function start(f, name = 'jhw-runtime-entry', args = ['mcp']) {
  const child = spawn(path.join(f.bootstrap,name), args, { stdio:['pipe','pipe','pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  return { child, output:() => out, error:() => err, done:once(child,'close') };
}
async function until(check, text='condition') {
  const stop = Date.now()+8000;
  while (!check()) {
    if (Date.now()>stop) assert.fail(`timed out: ${text}`);
    await new Promise(resolve => setTimeout(resolve,10));
  }
}
function contended(file) { assert.throws(() => acquireLease(file), error => error.code === 'DEPLOY_LOCK_CONTENDED'); }
function hookFailure(event, code) {
  if (event === 'SessionEnd') return {};
  if (event === 'PostToolUse') return {systemMessage:code};
  if (event === 'UserPromptSubmit') return {hookSpecificOutput:{hookEventName:event,additionalContext:code},systemMessage:code};
  return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:code},systemMessage:code};
}

// Break caught: bootstrap publication with missing/unverified helpers, or prepare replacing live bootstrap.
test('complete validated bootstrap is stable across preparation and identical installation', async t => {
  const f = await fixture(t);
  const before = fs.readFileSync(path.join(f.bootstrap,'manifest.json'));
  const manifest = entry.validateBootstrap({repositoryRoot:f.root});
  assert.equal(manifest.sourceReleaseId, f.release.releaseId);
  assert.equal(manifest.files.length,6);
  await f.prepare();
  const result = await entry.installBootstrap({repositoryRoot:f.root,releaseId:f.release.releaseId});
  assert.equal(result.previousDirectory,null);
  assert.deepEqual(fs.readFileSync(path.join(f.bootstrap,'manifest.json')),before);
  for (const file of manifest.files) assert.equal(fs.lstatSync(path.join(f.bootstrap,file.name)).mode & 0o777, file.name.startsWith('jhw-') ? 0o755 : 0o644);
});

// Break caught: accepting arbitrary selectors or printing deployment metadata to MCP transport.
test('closed selectors preserve stdio and status for MCP and bound control launcher', async t => {
  const f = await fixture(t);
  for (const [name,args] of [['jhw-runtime-entry',['mcp']],['jhw-runtime-control',[]]]) {
    const result = run(f,name,args,'input bytes\n');
    assert.equal(result.status,23,result.stderr); assert.equal(result.stdout,'input bytes\n'); assert.equal(result.stderr,'fixture-stderr\n');
  }
  for (const selector of ['../mcp','/bin/sh','hook-core','constructor','']) {
    const result = run(f,'jhw-runtime-entry',[selector]);
    assert.equal(result.status,75); assert.equal(result.stdout,''); assert.equal(result.stderr,'DEPLOY_SELECTOR_INVALID\n');
  }
});

// Break caught: reading current before lock acquisition or starting a child under maintenance.
test('exclusive admission denies before reading corrupt current or executing any child', async t => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.root,'.jhw-runtime/current'));
  fs.symlinkSync('invalid',path.join(f.root,'.jhw-runtime/current'));
  const lock = acquireLease(f.lock);
  try {
    const result = run(f); assert.equal(result.status,75); assert.equal(result.stdout,''); assert.equal(result.stderr,'DEPLOY_MAINTENANCE\n');
  } finally { lock.close(); }
  const result = run(f); assert.equal(result.status,75); assert.equal(result.stdout,''); assert.match(result.stderr,/^DEPLOY_[A-Z_]+\n$/);
});

// Break caught: closing the lease when spawn returns rather than when the child exits.
test('real running child excludes writers for its entire lifetime', async t => {
  const f = await fixture(t,"process.stdout.write('READY\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(7));");
  const p = start(f); await until(()=>p.output().includes('READY'));
  contended(f.lock); p.child.stdin.end(); const [status] = await p.done; assert.equal(status,7);
  const lock = acquireLease(f.lock); lock.close();
});

// Break caught: explicit LOCK_UN, or omission of the inherited child descriptor.
test('child retains admission after its fixture supervisor is killed', async t => {
  const f = await fixture(t,"import fs from 'node:fs'; process.stdout.write('READY\\n'); const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]+'.go')) {clearInterval(timer); process.exit(0);}},10);");
  const p = start(f); await until(()=>p.output().includes('READY'));
  const exited = once(p.child,'exit'); p.child.kill('SIGKILL'); await exited;
  contended(f.lock); fs.writeFileSync(path.join(f.root,'.jhw-runtime/releases',f.release.releaseId,'mcp-server/dist/index.js.go'),'go'); await p.done;
  const lock = acquireLease(f.lock); lock.close();
});

for (const event of ['PreToolUse','UserPromptSubmit','PostToolUse','SessionEnd']) {
  // Break caught: hook contention falling open or using the wrong event response shape.
  test(`hook ${event} maintenance failure is bounded and adapter-compatible`, async t => {
    const f = await fixture(t); const lock = acquireLease(f.lock);
    try { for (const adapter of ['claude','codex']) {
      const result = run(f,'jhw-runtime-hook',['--adapter',adapter,'--event',event],'{}');
      assert.equal(result.status,0,result.stderr); assert.equal(result.stderr,'');
      assert.deepEqual(JSON.parse(result.stdout),hookFailure(event,'DEPLOY_MAINTENANCE')); assert.ok(result.stdout.length<512);
    }} finally { lock.close(); }
  });
}

// Break caught: bypassing the release's bounded hook protocol wrapper.
test('hook admission executes the existing release wrapper and rejects malformed core output', async t => {
  const f = await fixture(t,undefined,"process.stdout.write('not-json');");
  const result = run(f,'jhw-runtime-hook',['--adapter','claude','--event','PreToolUse'],'{}');
  assert.equal(result.status,0,result.stderr); assert.deepEqual(JSON.parse(result.stdout),hookFailure('PreToolUse','GUARD_UNAVAILABLE'));
});

// Break caught: importing a tampered helper before checking its digest.
test('tampered bootstrap helper never executes and hook still denies', async t => {
  const f = await fixture(t);
  const sentinel = path.join(f.root,'executed');
  fs.appendFileSync(path.join(f.bootstrap,'runtime-safety.mjs'), `\nfs.writeFileSync(${JSON.stringify(sentinel)},'bad');\n`);
  const result = run(f,'jhw-runtime-hook',['--adapter','claude','--event','PreToolUse'],'{}');
  assert.equal(result.status,0); assert.deepEqual(JSON.parse(result.stdout),hookFailure('PreToolUse','DEPLOY_BOOTSTRAP_INVALID'));
  assert.equal(fs.existsSync(sentinel),false);
});

for (const variant of ['extra-key','missing-file','extra-file','unsafe-mode','symlink','hardlink']) {
  // Break caught: trusting malformed manifest or unsafe bootstrap filesystem records.
  test(`bootstrap refuses ${variant}`, async t => {
    const f = await fixture(t); const file = path.join(f.bootstrap,'runtime-store.mjs');
    if (variant === 'extra-key') { const p = path.join(f.bootstrap,'manifest.json'); const m=JSON.parse(fs.readFileSync(p)); m.untrusted=true; fs.writeFileSync(p,JSON.stringify(m)); }
    if (variant === 'missing-file') fs.unlinkSync(file);
    if (variant === 'extra-file') write(f.bootstrap,'extra.mjs','');
    if (variant === 'unsafe-mode') fs.chmodSync(file,0o664);
    if (variant === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(path.join(f.root,'scripts/runtime-store.mjs'),file); }
    if (variant === 'hardlink') fs.linkSync(file,path.join(f.root,'alias'));
    const result=run(f); assert.equal(result.status,75); assert.equal(result.stdout,''); assert.equal(result.stderr,'DEPLOY_BOOTSTRAP_INVALID\n');
  });
}

// Break caught: blessing new helper bytes solely because an attacker rewrote the bootstrap checksum.
test('bootstrap checksums remain bound to the source release manifest', async t => {
  const f=await fixture(t); const sentinel=path.join(f.root,'executed');
  const file=path.join(f.bootstrap,'runtime-entry.mjs');
  fs.appendFileSync(file,`\nfs.writeFileSync(${JSON.stringify(sentinel)},'bad');\n`);
  const manifestPath=path.join(f.bootstrap,'manifest.json'); const manifest=JSON.parse(fs.readFileSync(manifestPath));
  manifest.files.find(file=>file.name==='runtime-entry.mjs').sha256=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  const result=run(f); assert.equal(result.status,75); assert.equal(fs.existsSync(sentinel),false);
});

// Break caught: a trust result derived from a physical pathname without its manifest digest.
test('managed hook trust relation binds physical wrapper and core to the retained release', async t => {
  const f=await fixture(t); const releaseRoot=path.join(f.root,'.jhw-runtime/releases',f.release.releaseId);
  const relation=entry.managedHookRelationship({repositoryRoot:f.root,releaseRoot});
  assert.deepEqual(relation,{sourceReleaseId:f.release.releaseId,releaseId:f.release.releaseId,launcherPath:path.join(f.bootstrap,'jhw-runtime-hook'),wrapperPath:path.join(releaseRoot,'scripts/jhw-control-hook'),corePath:path.join(releaseRoot,'mcp-server/dist/control/hook-adapter.js')});
  assert.throws(()=>entry.managedHookRelationship({repositoryRoot:f.root,releaseRoot:path.join(f.root,'.jhw-runtime/current')}));
  fs.appendFileSync(relation.corePath,'\n// corrupted');
  assert.throws(()=>entry.managedHookRelationship({repositoryRoot:f.root,releaseRoot}));
});

// Break caught: a shell pipeline/timeout closing inherited fd 3 after supervisor death.
test('hook wrapper and core retain admission after the fixture supervisor exits', async t => {
  const f=await fixture(t,undefined,"import fs from 'node:fs'; fs.writeFileSync(process.argv[1]+'.ready','ready'); const timer=setInterval(()=>{ if(fs.existsSync(process.argv[1]+'.go')) { clearInterval(timer); process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse'}})+'\\n'); } },10);");
  const core=path.join(f.root,'.jhw-runtime/releases',f.release.releaseId,'mcp-server/dist/control/hook-adapter.js');
  const p=start(f,'jhw-runtime-hook',['--adapter','claude','--event','PreToolUse']); p.child.stdin.end('{}');
  await until(()=>fs.existsSync(core+'.ready')); const exited=once(p.child,'exit'); p.child.kill('SIGKILL'); await exited;
  contended(f.lock); fs.writeFileSync(core+'.go','go'); await p.done;
  const lease=acquireLease(f.lock); lease.close(); assert.equal(JSON.parse(p.output()).hookSpecificOutput.hookEventName,'PreToolUse');
});

// Break caught: caching current at bootstrap installation instead of reading after admission.
test('paused fresh invocation selects the activation committed before admission', async t => {
  const f=await fixture(t,"process.stdout.write('old');");
  const p=start(f); p.child.kill('SIGSTOP');
  await until(()=> { try {return /\) T /.test(fs.readFileSync(`/proc/${p.child.pid}/stat`,'utf8'));} catch{return false;} });
  const next=await prepareRelease({repositoryRoot:f.root,build:async({stagingRoot})=>{
    write(stagingRoot,'mcp-server/dist/index.js',"process.stdout.write('new');");
    write(stagingRoot,'mcp-server/dist/control/cli.js','#!/usr/bin/env node\n',0o755);
    write(stagingRoot,'mcp-server/dist/control/hook-adapter.js','#!/usr/bin/env node\n',0o755);
    fs.mkdirSync(path.join(stagingRoot,'mcp-server/node_modules'),{mode:0o755});
  }});
  const lease=acquireLease(f.lock);
  try {publishActivation({repositoryRoot:f.root,releaseId:next.releaseId,expectedCurrent:f.activation});} finally {lease.close();}
  p.child.kill('SIGCONT'); p.child.stdin.end(); const [status]=await p.done;
  assert.equal(status,0,p.error()); assert.equal(p.output(),'new');
});

// Break caught: replacement deleting prior recovery bytes or failing to fsync/publish a complete set.
test('bootstrap replacement retains the prior complete set under a bounded recovery name', async t => {
  const f=await fixture(t); const prior=fs.readFileSync(path.join(f.bootstrap,'manifest.json'));
  fs.appendFileSync(path.join(f.root,'scripts/runtime-entry.mjs'),'\n// new validated bootstrap revision\n');
  const next=await f.prepare(); const lease=acquireLease(f.lock); let installed;
  try { installed=await entry.installBootstrap({repositoryRoot:f.root,releaseId:next.releaseId}); } finally {lease.close();}
  assert.match(installed.previousDirectory,/^\.bootstrap\.previous\.[a-f0-9]{32}$/);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'.jhw-runtime',installed.previousDirectory,'manifest.json')),prior);
  assert.equal(entry.validateBootstrap({repositoryRoot:f.root}).sourceReleaseId,next.releaseId);
  const result=run(f,'jhw-runtime-control',[],'kept\n'); assert.equal(result.status,23,result.stderr); assert.equal(result.stdout,'kept\n');
});

// Break caught: missing source helper accepted for publication, or existing bootstrap lost on refusal.
test('incomplete release helper set refuses installation and preserves the prior bootstrap', async t => {
  const f=await fixture(t); const prior=fs.readFileSync(path.join(f.bootstrap,'manifest.json'));
  fs.unlinkSync(path.join(f.root,'scripts/jhw-runtime-hook')); const next=await f.prepare();
  await assert.rejects(entry.installBootstrap({repositoryRoot:f.root,releaseId:next.releaseId}));
  assert.deepEqual(fs.readFileSync(path.join(f.bootstrap,'manifest.json')),prior);
  const result=run(f,'jhw-runtime-control',[],'still works'); assert.equal(result.status,23,result.stderr); assert.equal(result.stdout,'still works');
});

// Break caught: collapsing valid child signal exits into a different status.
test('managed child signal status preserves the actual terminating signal', async t => {
  const f=await fixture(t,"process.kill(process.pid,'SIGUSR2');");
  const result=run(f); assert.equal(result.status,140,result.stderr); assert.equal(result.stdout,'');
});

// I1: another helper failing validation must prevent evaluation of valid entry code.
for (const invalid of ['missing', 'changed']) {
  test(`complete helper set is checked before entry evaluation when safety is ${invalid}`, async t => {
    const f=await fixture(t,undefined,undefined,{'runtime-entry.mjs':(bytes,root)=>bytes+`\nfs.writeFileSync(${JSON.stringify(path.join(root,'entry-evaluated'))},'evaluated');\n`});
    const safety=path.join(f.bootstrap,'runtime-safety.mjs');
    if(invalid==='missing') fs.unlinkSync(safety); else fs.appendFileSync(safety,'\n// changed bytes\n');
    const result=run(f);
    assert.equal(result.status,75); assert.equal(result.stdout,'');
    assert.equal(fs.existsSync(path.join(f.root,'entry-evaluated')),false,'valid entry must not be evaluated before the complete set passes');
  });
}

// I2: a real replacement while the admitted invocation awaits safety import must
// not mix its cached A entry/safety with B store code or execute any selected child.
test('bootstrap replacement during a paused safety import refuses generation mixing', async t => {
  const f=await fixture(t,"process.stdout.write('CHILD STARTED');",undefined,{
    'runtime-safety.mjs':(bytes,root)=>bytes+`\nif(import.meta.url.includes('/.jhw-runtime/')) { fs.writeFileSync(${JSON.stringify(path.join(root,'safety-ready'))},'ready'); while(!fs.existsSync(${JSON.stringify(path.join(root,'resume-safety'))})) await new Promise(resolve=>setTimeout(resolve,10)); }\n`,
  });
  const p=start(f);
  await until(()=>fs.existsSync(path.join(f.root,'safety-ready')));
  fs.appendFileSync(path.join(f.root,'scripts/runtime-store.mjs'),`\nif(import.meta.url.includes('/.jhw-runtime/')) fs.writeFileSync(${JSON.stringify(path.join(f.root,'store-b-evaluated'))},'evaluated');\n`);
  const next=await f.prepare(); const deploy=acquireLease(path.join(f.root,'.jhw-runtime/deploy.lock')); const admission=acquireLease(f.lock);
  try { await entry.installBootstrap({repositoryRoot:f.root,releaseId:next.releaseId}); }
  finally {admission.close();deploy.close();}
  fs.writeFileSync(path.join(f.root,'resume-safety'),'go'); p.child.stdin.end();
  const [status]=await p.done;
  assert.equal(status,75,p.error()); assert.equal(p.output(),''); assert.equal(p.error(),'DEPLOY_BOOTSTRAP_CHANGED\n');
  assert.equal(fs.existsSync(path.join(f.root,'store-b-evaluated')),false,'replacement store must not be imported by the earlier generation');
  const lease=acquireLease(f.lock); lease.close();
});

// I3: unavailable/incompatible interpreters must not escape through a shebang
// with empty stdout. PATH changes are isolated child fixtures, never a bypass.
for (const interpreter of ['missing','incompatible']) {
  for (const event of ['PreToolUse','SessionEnd']) {
    test(`hook ${event} returns bounded JSON with ${interpreter} interpreter`, async t => {
      const f=await fixture(t); const bin=path.join(f.root,'bin'); fs.mkdirSync(bin,{mode:0o700});
      fs.symlinkSync('/usr/bin/bash',path.join(bin,'bash'));
      if(interpreter==='incompatible') {
        const version=spawnSync('/usr/bin/node',['--version'],{encoding:'utf8',timeout:1000});
        // Exercise the host's real legacy parser when present. On newer hosts,
        // an executable that cannot start a Node program covers the same outer
        // startup-failure boundary without requiring another installed runtime.
        if(/^v(?:[0-9]|1[0-7])\./.test(version.stdout ?? '')) fs.symlinkSync('/usr/bin/node',path.join(bin,'node'));
        else fs.symlinkSync('/usr/bin/false',path.join(bin,'node'));
      }
      const result=spawnSync(path.join(f.bootstrap,'jhw-runtime-hook'),['--adapter','claude','--event',event],{input:'{}',encoding:'utf8',env:{...process.env,PATH:bin},timeout:3000});
      assert.equal(result.status,0,result.stderr); assert.equal(result.stderr,'');
      assert.deepEqual(JSON.parse(result.stdout),hookFailure(event,'GUARD_UNAVAILABLE'));
    });
  }
}
