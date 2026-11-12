import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import * as store from './runtime-store.mjs';
import { acquireLease } from './runtime-safety.mjs';
import { installBootstrap } from './runtime-entry.mjs';

const moduleUrl = pathToFileURL(new URL('./runtime-store.mjs', import.meta.url).pathname).href;
function api() {
  for (const name of ['createSessionBinding', 'resolveSessionBinding', 'inspectSessionBindings', 'releaseCompatibility']) {
    assert.equal(typeof store[name], 'function', name + ' must exist');
  }
}
function write(root, name, text = 'fixture\n', mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function fixture(t) {
  api();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-session-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({
    '.gitignore': '.jhw-runtime/\n',
    'mcp-server/package.json': '{"type":"module"}',
    'mcp-server/package-lock.json': '{"lockfileVersion":3}',
    'mcp-server/tsconfig.json': '{}',
    'mcp-server/tsconfig.test.json': '{}',
    'mcp-server/src/index.ts': 'export const version = "A";',
    'mcp-server/src/server.ts': 'export const server = "A";',
    'mcp-server/src/tools/read.ts': 'export const read = "A";',
    'mcp-server/src/control/schemas.ts': 'export const schema = 1;',
    'mcp-server/src/config.ts': 'export const config = 1;',
    'mcp-server/scripts/clean-dist.mjs': '',
    'scripts/sync-codex-skills.mjs': '',
    'scripts/runtime-entry.mjs': 'export const helper = 1;',
    'skills/claude/task.md': 'fixture task',
  })) write(root, name, text);
  write(root, 'scripts/jhw-control-hook', '#!/bin/sh\nexit 0\n', 0o755);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  let mcpVersion = 'A';
  let controlVersion = 'A';
  let dependencyVersion = 'A';
  const build = async ({ stagingRoot }) => {
    write(stagingRoot, 'mcp-server/dist/index.js', 'export const version = ' + JSON.stringify(mcpVersion) + ';');
    write(stagingRoot, 'mcp-server/dist/server.js', 'export const version = ' + JSON.stringify(mcpVersion) + ';');
    write(stagingRoot, 'mcp-server/dist/tools/read.js', 'export const version = ' + JSON.stringify(mcpVersion) + ';');
    write(stagingRoot, 'mcp-server/dist/control/cli.js', '#!/usr/bin/env node\n// ' + controlVersion, 0o755);
    write(stagingRoot, 'mcp-server/dist/control/hook-adapter.js', '#!/usr/bin/env node\n// stable', 0o755);
    write(stagingRoot, 'mcp-server/dist/config.js', 'export const config = 1;');
    write(stagingRoot, 'mcp-server/dist/runtime/mcp.cjs', 'exports.version = ' + JSON.stringify(mcpVersion) + ';');
    write(stagingRoot, 'mcp-server/dist/runtime/control.cjs', '#!/usr/bin/env node\n// ' + controlVersion, 0o755);
    write(stagingRoot, 'mcp-server/dist/runtime/hook.cjs', '#!/usr/bin/env node\n// stable', 0o755);
    write(stagingRoot, 'mcp-server/node_modules/example/index.js', '// ' + dependencyVersion);
  };
  const prepare = () => store.prepareRelease({ repositoryRoot: root, build });
  const release = await prepare();
  return { root, release, prepare, mcp(value) { mcpVersion = value; }, control(value) { controlVersion = value; }, dependency(value) { dependencyVersion = value; } };
}
function create(f, options = {}) {
  return store.createSessionBinding({ repositoryRoot: f.root, releaseId: f.release.releaseId, ...options });
}
function resolve(f, token, options = {}) {
  return store.resolveSessionBinding({ repositoryRoot: f.root, token, ...options });
}
function inspect(f) { return store.inspectSessionBindings({ repositoryRoot: f.root }); }
function sessionPath(f, id, name) { return path.join(f.root, '.jhw-runtime/sessions', id, name); }
function failure(fn) { assert.throws(fn, { code: 'DEPLOY_SESSION_INVALID' }); }
function canonical(value) {
  return Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
    value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
}

test('session records are private, bound to a retained release, and removed after their final holder closes', async t => {
  const f = await fixture(t);
  const binding = create(f);
  try {
    assert.match(binding.id, /^s-[a-f0-9]{32}$/);
    assert.match(binding.token, /^s-[a-f0-9]{32}:[a-f0-9]{64}$/);
    assert.equal(fs.statSync(sessionPath(f, binding.id, '')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(sessionPath(f, binding.id, 'manifest.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(sessionPath(f, binding.id, 'lease')).mode & 0o777, 0o600);
    assert.equal(resolve(f, binding.token).releaseId, f.release.releaseId);
    assert.equal(resolve(f, binding.token).kind, 'session');
    assert.equal(binding.record.compatibilityDigest, store.releaseCompatibility({ repositoryRoot: f.root, releaseId: f.release.releaseId }));
    assert.deepEqual(inspect(f).map(row => row.id), [binding.id]);
  } finally { binding.close(); }
  assert.deepEqual(inspect(f), []);
  failure(() => resolve(f, binding.token));
});

test('a descendant resolves the exact parent generation and can register a bound invocation', async t => {
  const f = await fixture(t);
  const binding = create(f);
  try {
    const script = "const s=await import(process.argv[1]);const root=process.argv[2],token=process.argv[3];const r=s.resolveSessionBinding({repositoryRoot:root,token});const i=s.createSessionBinding({repositoryRoot:root,releaseId:r.releaseId,kind:'invocation',parentBinding:token});try{console.log(JSON.stringify({releaseId:r.releaseId,parent:i.record.parentBinding,kind:i.record.kind}));}finally{i.close();}";
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.root, binding.token], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { releaseId: f.release.releaseId, parent: binding.token, kind: 'invocation' });
    assert.equal(inspect(f).length, 1);
  } finally { binding.close(); }
});

test('unbound invocations remain explicit and cannot masquerade as session pins', async t => {
  const f = await fixture(t);
  const binding = create(f, { kind: 'invocation' });
  try {
    const [row] = inspect(f);
    assert.equal(row.kind, 'invocation');
    assert.equal(row.parentBinding, null);
    failure(() => resolve(f, binding.token));
  } finally { binding.close(); }
});

test('pins reject malformed ids, digest changes, unknown records, and non-descendant processes', async t => {
  const f = await fixture(t);
  const binding = create(f);
  try {
    for (const token of [null, '', '../foreign:' + 'a'.repeat(64), binding.id + ':' + '0'.repeat(64), 's-' + '0'.repeat(32) + ':' + '0'.repeat(64)]) {
      failure(() => resolve(f, token));
    }
    failure(() => resolve(f, binding.token, { pid: process.ppid }));
    failure(() => resolve(f, binding.token, { pid: 0 }));
  } finally { binding.close(); }
});

test('parent bindings must be live sessions for the same release and session roots cannot be nested pins', async t => {
  const f = await fixture(t);
  const binding = create(f);
  f.mcp('B');
  const other = await f.prepare();
  try {
    failure(() => create(f, { kind: 'session', parentBinding: binding.token }));
    failure(() => create(f, { kind: 'unknown' }));
    failure(() => create(f, { kind: 'invocation', parentBinding: 'bad' }));
    failure(() => create(f, { kind: 'invocation', parentBinding: binding.token, releaseId: other.releaseId }));
    assert.equal(inspect(f).length, 1);
  } finally { binding.close(); }
});

test('an inherited lease keeps evidence when the original owner closes, then becomes inactive after EOF', async t => {
  const f = await fixture(t);
  const binding = create(f);
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe', binding.fd] });
  const done = once(child, 'close');
  await once(child.stdout, 'data');
  try {
    binding.close();
    assert.equal(fs.existsSync(sessionPath(f, binding.id, 'manifest.json')), true);
    failure(() => inspect(f));
  } finally { child.stdin.end(); await done; binding.close(); }
  assert.deepEqual(inspect(f), []);
});

test('binding records reject byte-identical manifest replacement and retain uncertain evidence', async t => {
  const f = await fixture(t);
  const binding = create(f);
  const file = sessionPath(f, binding.id, 'manifest.json');
  const bytes = fs.readFileSync(file);
  fs.renameSync(file, file + '.old');
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.unlinkSync(file + '.old');
  try { failure(() => resolve(f, binding.token)); failure(() => inspect(f)); }
  finally { binding.close(); }
  assert.equal(fs.existsSync(file), true);
});

for (const type of ['symlink', 'hardlink', 'mode', 'lease-replaced']) {
  test('binding records reject ' + type + ' substitutions', async t => {
    const f = await fixture(t);
    const binding = create(f);
    const file = sessionPath(f, binding.id, type === 'lease-replaced' ? 'lease' : 'manifest.json');
    const bytes = fs.readFileSync(file);
    const foreign = path.join(f.root, 'foreign-' + type);
    if (type === 'mode') fs.chmodSync(file, 0o644);
    else if (type === 'hardlink') fs.linkSync(file, foreign);
    else {
      fs.renameSync(file, foreign);
      if (type === 'symlink') fs.symlinkSync(foreign, file);
      else fs.writeFileSync(file, bytes, { mode: 0o600 });
    }
    try { failure(() => resolve(f, binding.token)); failure(() => inspect(f)); }
    finally { binding.close(); }
  });
}

test('a held record with a stale owner identity fails closed even if its JSON digest is recomputed', async t => {
  const f = await fixture(t);
  const binding = create(f);
  const file = sessionPath(f, binding.id, 'manifest.json');
  const changed = { ...binding.record, owner: { ...binding.record.owner, startTime: '0' } };
  const bytes = canonical(changed) + '\n';
  fs.writeFileSync(file, bytes);
  const token = binding.id + ':' + createHash('sha256').update(bytes).digest('hex');
  try { failure(() => resolve(f, token)); failure(() => inspect(f)); }
  finally { binding.close(); }
});

test('a binding is not accepted in a different canonical runtime store', async t => {
  const f = await fixture(t);
  const g = await fixture(t);
  const binding = create(f);
  const directory = path.join(g.root, '.jhw-runtime/sessions', binding.id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(sessionPath(f, binding.id, 'manifest.json'), path.join(directory, 'manifest.json'));
  fs.copyFileSync(sessionPath(f, binding.id, 'lease'), path.join(directory, 'lease'));
  fs.chmodSync(path.join(directory, 'manifest.json'), 0o600);
  fs.chmodSync(path.join(directory, 'lease'), 0o600);
  try { failure(() => resolve(g, binding.token)); failure(() => inspect(g)); }
  finally { binding.close(); }
});

test('compatibility permits only MCP tool/entry output changes and checks the whole retained artifact', async t => {
  const f = await fixture(t);
  const first = store.releaseCompatibility({ repositoryRoot: f.root, releaseId: f.release.releaseId });
  f.mcp('B');
  write(f.root, 'mcp-server/src/tools/read.ts', 'export const read = "B";');
  write(f.root, 'mcp-server/src/index.ts', 'export const version = "B";');
  const next = await f.prepare();
  assert.notEqual(next.releaseId, f.release.releaseId);
  assert.equal(store.releaseCompatibility({ repositoryRoot: f.root, releaseId: next.releaseId }), first);
  const bundle = path.join(f.root, '.jhw-runtime/releases', next.releaseId, 'mcp-server/dist/runtime/mcp.cjs');
  fs.appendFileSync(bundle, '\n// tampered');
  assert.throws(() => store.releaseCompatibility({ repositoryRoot: f.root, releaseId: next.releaseId }), { code: 'DEPLOY_RELEASE_INVALID' });
});

for (const [label, mutate] of [
  ['skill bytes', f => write(f.root, 'skills/claude/task.md', 'changed')],
  ['helper bytes', f => write(f.root, 'scripts/runtime-entry.mjs', 'export const helper = 2;')],
  ['control source', f => write(f.root, 'mcp-server/src/control/schemas.ts', 'export const schema = 2;')],
  ['config source', f => write(f.root, 'mcp-server/src/config.ts', 'export const config = 2;')],
  ['new shared source', f => write(f.root, 'mcp-server/src/shared-policy.ts', 'export const policy = 1;')],
  ['control bundle', f => f.control('B')],
  ['dependency bytes', f => f.dependency('B')],
  ['skill mode', f => fs.chmodSync(path.join(f.root, 'skills/claude/task.md'), 0o600)],
]) {
  test('compatibility rejects changed ' + label, async t => {
    const f = await fixture(t);
    const first = store.releaseCompatibility({ repositoryRoot: f.root, releaseId: f.release.releaseId });
    mutate(f);
    const next = await f.prepare();
    assert.notEqual(store.releaseCompatibility({ repositoryRoot: f.root, releaseId: next.releaseId }), first);
  });
}


test('missing session pins are refused for the owner and descendants before current can be selected', async t => {
  const f = await fixture(t);
  assert.equal(typeof store.assertNoSessionAncestor, 'function', 'missing-pin ancestry guard must exist');
  const binding = create(f);
  try {
    failure(() => store.assertNoSessionAncestor({ repositoryRoot: f.root }));
    const script = "const s=await import(process.argv[1]);delete process.env.JHW_RUNTIME_SESSION_BINDING;try{s.assertNoSessionAncestor({repositoryRoot:process.argv[2]});process.exitCode=3;}catch(error){if(error.code!=='DEPLOY_SESSION_INVALID')throw error;console.log('missing-pin-refused');}";
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.root], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'missing-pin-refused');
  } finally { binding.close(); }
});

test('an independent caller is allowed while an unrelated descendant session is live', async t => {
  const f = await fixture(t);
  assert.equal(typeof store.assertNoSessionAncestor, 'function', 'missing-pin ancestry guard must exist');
  const script = "const s=await import(process.argv[1]);const b=s.createSessionBinding({repositoryRoot:process.argv[2],releaseId:process.argv[3]});console.log('ready');process.stdin.resume();process.stdin.on('end',()=>{b.close();});";
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.root, f.release.releaseId], { stdio: ['pipe', 'pipe', 'pipe'] });
  const done = once(child, 'close');
  await once(child.stdout, 'data');
  try {
    assert.doesNotThrow(() => store.assertNoSessionAncestor({ repositoryRoot: f.root }));
  } finally { child.stdin.end(); await done; }
});

test('ordinary callers without live session bindings retain current-selection eligibility', async t => {
  const f = await fixture(t);
  assert.equal(typeof store.assertNoSessionAncestor, 'function', 'missing-pin ancestry guard must exist');
  assert.doesNotThrow(() => store.assertNoSessionAncestor({ repositoryRoot: f.root }));
  failure(() => store.assertNoSessionAncestor({ repositoryRoot: f.root, pid: 0 }));
});

// An SSH login puts a per-user, non-dumpable sshd in every shell's ancestry; its
// /proc/<pid>/fd is EACCES and root-owned even for the same UID. This python parent
// reproduces that, prints the precondition its child observes, then runs argv.
const NON_DUMPABLE_PARENT = [
  'import ctypes, subprocess, sys',
  'assert ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) == 0  # PR_SET_DUMPABLE',
  'probe = "import errno, os\\np = \\"/proc/%d/fd\\" % os.getppid()\\ntry:\\n  os.listdir(p); code = \\"readable\\"\\nexcept OSError as e:\\n  code = errno.errorcode[e.errno]\\nprint(\\"parent-fd:%s:owner=%d\\" % (code, os.stat(p).st_uid))"',
  'print(subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True).stdout.strip(), flush=True)',
  'sys.exit(subprocess.run(sys.argv[1:]).returncode)',
].join('\n');
const UNBOUND_CALLER = "const s=await import(process.argv[1]);delete process.env.JHW_RUNTIME_SESSION_BINDING;try{s.assertNoSessionAncestor({repositoryRoot:process.argv[2]});console.log('allowed');}catch(error){if(error.code!=='DEPLOY_SESSION_INVALID')throw error;console.log('refused');}";
function childReport(child) { return String(child.error ?? '') + (child.stdout ?? '') + (child.stderr ?? ''); }

test('a non-dumpable current-user ancestor does not refuse an unbound caller', async t => {
  const f = await fixture(t);
  const child = spawnSync('python3', ['-c', NON_DUMPABLE_PARENT, process.execPath, '--input-type=module', '-e', UNBOUND_CALLER, moduleUrl, f.root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, childReport(child));
  // Precondition printed next to the verdict: the parent's descriptor table really is hidden by the kernel.
  assert.deepEqual(child.stdout.trim().split('\n'), ['parent-fd:EACCES:owner=0', 'allowed']);
});

test('a session owner above a non-dumpable ancestor still refuses an unbound caller', async t => {
  const f = await fixture(t);
  const owner = "const s=await import(process.argv[1]);const {spawnSync}=await import('node:child_process');const b=s.createSessionBinding({repositoryRoot:process.argv[2],releaseId:process.argv[3]});try{const r=spawnSync('python3',['-c',process.argv[4],process.execPath,'--input-type=module','-e',process.argv[5],process.argv[1],process.argv[2]],{encoding:'utf8',timeout:10000});process.stdout.write(String(r.error??'')+(r.stdout??''));process.stderr.write(r.stderr??'');process.exitCode=r.status??1;}finally{b.close();}";
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', owner, moduleUrl, f.root, f.release.releaseId, NON_DUMPABLE_PARENT, UNBOUND_CALLER], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, childReport(child));
  assert.deepEqual(child.stdout.trim().split('\n'), ['parent-fd:EACCES:owner=0', 'refused']);
});


test('binding publication exposes only a complete atomic record to concurrent inspection', async t => {
  const f = await fixture(t);
  const original = { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  const failures = [];
  const seams = [];
  const inspectAt = (label, expected) => {
    seams.push(label);
    try {
      const count = inspect(f).length;
      if (count !== expected) failures.push(label + ': visible=' + count);
    } catch (error) { failures.push(label + ': ' + error.code); }
  };
  const inSessions = value => {
    try {
      const file = typeof value === 'number' ? fs.realpathSync('/proc/self/fd/' + value) :
        path.join(fs.realpathSync(path.dirname(String(value))), path.basename(String(value)));
      return file.startsWith(path.join(f.root, '.jhw-runtime/sessions') + '/');
    } catch { return false; }
  };
  let binding;
  try {
    fs.mkdirSync = function(...args) {
      const result = original.mkdirSync.apply(this, args);
      if (/^(?:s-[a-f0-9]{32}|\.creating\.s-[a-f0-9]{32})$/.test(path.basename(String(args[0])))) inspectAt('directory-created', 0);
      return result;
    };
    fs.writeFileSync = function(...args) {
      let file = '';
      try { if (typeof args[0] === 'number') file = fs.realpathSync('/proc/self/fd/' + args[0]); } catch {}
      const manifest = inSessions(args[0]) && path.basename(file) === 'manifest.json';
      if (manifest) inspectAt('before-manifest-write', 0);
      const result = original.writeFileSync.apply(this, args);
      if (manifest) inspectAt('after-manifest-write', 0);
      return result;
    };
    fs.renameSync = function(...args) {
      const publishing = /^\.creating\.s-[a-f0-9]{32}$/.test(path.basename(String(args[0]))) &&
        /^s-[a-f0-9]{32}$/.test(path.basename(String(args[1])));
      if (publishing) inspectAt('before-publish', 0);
      const result = original.renameSync.apply(this, args);
      if (publishing) inspectAt('after-publish', 1);
      return result;
    };
    binding = create(f);
  } finally {
    Object.assign(fs, original);
    binding?.close();
  }
  assert.deepEqual(failures, []);
  assert.equal(seams.includes('before-publish'), true, 'registration must use atomic publication');
  assert.equal(seams.includes('after-publish'), true);
});

const crashBindingScript = String.raw`
const fs = await import('node:fs').then(module => module.default);
const path = await import('node:path').then(module => module.default);
const store = await import(process.argv[1]);
const [root, releaseId, seam] = process.argv.slice(2);
const original = { mkdirSync:fs.mkdirSync, openSync:fs.openSync, renameSync:fs.renameSync, unlinkSync:fs.unlinkSync };
const location = value => {
  try { return path.join(fs.realpathSync(path.dirname(String(value))), path.basename(String(value))); }
  catch { return ''; }
};
const belongs = value => location(value).startsWith(path.join(root,'.jhw-runtime/sessions')+'/');
if (seam === 'create-directory') fs.mkdirSync = function(...args) {
  const result = original.mkdirSync.apply(this,args);
  if (/^(?:s-[a-f0-9]{32}|\.creating\.s-[a-f0-9]{32})$/.test(path.basename(String(args[0])))) process.exit(47);
  return result;
};
if (seam === 'empty-manifest') fs.openSync = function(...args) {
  const result = original.openSync.apply(this,args);
  if (belongs(args[0]) && path.basename(String(args[0])) === 'manifest.json' && (args[1] & fs.constants.O_CREAT)) process.exit(47);
  return result;
};
if (seam === 'before-publish' || seam === 'after-publish') fs.renameSync = function(...args) {
  const publishing = /^\.creating\.s-[a-f0-9]{32}$/.test(path.basename(String(args[0]))) && /^s-[a-f0-9]{32}$/.test(path.basename(String(args[1])));
  if (publishing && seam === 'before-publish') process.exit(47);
  const result = original.renameSync.apply(this,args);
  if (publishing && seam === 'after-publish') process.exit(47);
  return result;
};
const binding = store.createSessionBinding({repositoryRoot:root,releaseId});
if (seam === 'before-retire' || seam === 'after-retire') fs.renameSync = function(...args) {
  const retiring = /^s-[a-f0-9]{32}$/.test(path.basename(String(args[0]))) && /^\.retired\.s-[a-f0-9]{32}\.[a-f0-9]{32}$/.test(path.basename(String(args[1])));
  if (retiring && seam === 'before-retire') process.exit(47);
  const result = original.renameSync.apply(this,args);
  if (retiring && seam === 'after-retire') process.exit(47);
  return result;
};
if (seam === 'first-unlink') fs.unlinkSync = function(...args) {
  const target = belongs(args[0]) && path.basename(String(args[0])) === 'manifest.json';
  const result = original.unlinkSync.apply(this,args);
  if (target) process.exit(47);
  return result;
};
binding.close();
process.exitCode = 99;
`;
for (const seam of ['create-directory', 'empty-manifest', 'before-publish', 'after-publish', 'before-retire', 'after-retire', 'first-unlink']) {
  test('crash at binding ' + seam + ' leaves no partial public record', async t => {
    const f = await fixture(t);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', crashBindingScript, moduleUrl, f.root, f.release.releaseId, seam], { encoding:'utf8', timeout:10000 });
    assert.equal(child.status, 47, child.stderr || 'atomic lifecycle seam was not reached');
    assert.deepEqual(inspect(f), []);
    const next = create(f);
    try { assert.equal(resolve(f, next.token).releaseId, f.release.releaseId); }
    finally { next.close(); }
  });
}

test('atomic retirement is durable before any record file is deleted', async t => {
  const f = await fixture(t);
  const binding = create(f);
  const original = { renameSync:fs.renameSync, fsyncSync:fs.fsyncSync, unlinkSync:fs.unlinkSync };
  const events = [];
  const sessionRoot = path.join(f.root, '.jhw-runtime/sessions');
  try {
    fs.renameSync = function(...args) {
      const result = original.renameSync.apply(this,args);
      if (path.basename(String(args[0])) === binding.id) events.push('retire');
      return result;
    };
    fs.fsyncSync = function(...args) {
      const result = original.fsyncSync.apply(this,args);
      try { if (fs.realpathSync('/proc/self/fd/' + args[0]) === sessionRoot) events.push('parent-fsync'); } catch {}
      return result;
    };
    fs.unlinkSync = function(...args) {
      if (path.basename(String(args[0])) === 'manifest.json') events.push('first-unlink');
      return original.unlinkSync.apply(this,args);
    };
    binding.close();
  } finally { Object.assign(fs, original); binding.close(); }
  assert.ok(events.indexOf('retire') >= 0, 'retire rename is required');
  assert.ok(events.indexOf('parent-fsync') > events.indexOf('retire'), 'retire must reach the parent directory');
  assert.ok(events.indexOf('first-unlink') > events.indexOf('parent-fsync'), 'unlink must follow durable retirement');
  assert.deepEqual(inspect(f), []);
});

test('private session lifecycle namespaces are closed and ownership checked', async t => {
  const f = await fixture(t);
  const sessionRoot = path.join(f.root, '.jhw-runtime/sessions');
  fs.mkdirSync(sessionRoot, { mode:0o700 });
  const creating = '.creating.s-' + '1'.repeat(32);
  const retired = '.retired.s-' + '2'.repeat(32) + '.' + '3'.repeat(32);
  fs.mkdirSync(path.join(sessionRoot, creating), { mode:0o700 });
  fs.mkdirSync(path.join(sessionRoot, retired), { mode:0o700 });
  write(path.join(sessionRoot, retired), 'lease', '', 0o600);
  assert.deepEqual(inspect(f), []);
  fs.mkdirSync(path.join(sessionRoot, '.creating.foreign'), { mode:0o700 });
  failure(() => inspect(f));
  fs.rmdirSync(path.join(sessionRoot, '.creating.foreign'));
  fs.chmodSync(path.join(sessionRoot, creating), 0o755);
  failure(() => inspect(f));
  fs.chmodSync(path.join(sessionRoot, creating), 0o700);
  fs.rmdirSync(path.join(sessionRoot, creating));
  fs.symlinkSync(f.root, path.join(sessionRoot, creating));
  failure(() => inspect(f));
});


const concurrencyWorker = String.raw`
const [root, moduleUrl, releaseId, mode, token] = process.argv.slice(1);
let binding;
try {
  const s = await import(moduleUrl);
  if (mode === 'bound') {
    const parent = s.resolveSessionBinding({ repositoryRoot: root, token });
    if (parent.releaseId !== releaseId) throw new Error('RELEASE_MISMATCH');
  } else {
    s.assertNoSessionAncestor({ repositoryRoot: root });
  }
  binding = s.createSessionBinding({ repositoryRoot: root, releaseId, kind: 'invocation', parentBinding: mode === 'bound' ? token : null });
  if (binding.record.kind !== 'invocation') throw new Error('KIND_MISMATCH');
  process.stdout.write('ok\n');
} catch (error) {
  process.stderr.write((error.code || error.message || 'UNKNOWN') + '\n');
  process.exitCode = 2;
} finally { binding?.close(); }
`;
async function runThreeConcurrent(f, mode, token) {
  const start = performance.now();
  const execute = () => new Promise(resolve => {
    const child = spawn(process.execPath,
      ['--input-type=module', '-e', concurrencyWorker, f.root, moduleUrl, f.release.releaseId, mode, token ?? '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.once('error', error => resolve({ code: -1, stderr: error.message, stdout }));
    child.once('close', code => resolve({ code, stderr, stdout }));
  });
  const results = await Promise.all([execute(), execute(), execute()]);
  const elapsedMs = performance.now() - start;
  for (const result of results) assert.equal(result.code, 0, mode + ': ' + JSON.stringify(results));
  assert.ok(elapsedMs < 8000, 'concurrent ' + mode + ' exceeded 8s: ' + elapsedMs);
}
test('three parallel bound session invocations never reject a valid parent during registration', async t => {
  const f = await fixture(t);
  const parent = create(f);
  try {
    for (let repeat = 0; repeat < 5; repeat++) await runThreeConcurrent(f, 'bound', parent.token);
  } finally { parent.close(); }
});
test('three parallel unbound entry checks tolerate sibling session publication', async t => {
  const f = await fixture(t);
  for (let repeat = 0; repeat < 5; repeat++) await runThreeConcurrent(f, 'unbound');
});

test('simultaneous descendants wait for a short namespace publication lease', async t => {
  const f = await fixture(t);
  const parent = create(f);
  let lock;
  try {
    lock = acquireLease(path.join(f.root, '.jhw-runtime/session-index.lock'));
    const pending = runThreeConcurrent(f, 'bound', parent.token);
    await new Promise(resolve => setTimeout(resolve, 220));
    lock.close(); lock = undefined;
    await pending;
  } finally { lock?.close(); parent.close(); }
});
test('a held namespace publication lease fails closed after the bounded wait', async t => {
  const f = await fixture(t);
  const parent = create(f);
  const lock = acquireLease(path.join(f.root, '.jhw-runtime/session-index.lock'));
  try {
    const start = performance.now();
    failure(() => resolve(f, parent.token));
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 300 && elapsed < 2000, 'lock refusal must be bounded: ' + elapsed);
  } finally { lock.close(); parent.close(); }
});

test('the namespace lock does not add unknown entries to retained session directories', async t => {
  const f = await fixture(t);
  const binding = create(f);
  try {
    const sessions = path.join(f.root, '.jhw-runtime/sessions');
    assert.deepEqual(fs.readdirSync(sessions).sort(), [binding.id]);
    const index = fs.statSync(path.join(f.root, '.jhw-runtime/session-index.lock'));
    assert.equal(index.isFile(), true);
    assert.equal(index.mode & 0o777, 0o600);
    assert.equal(resolve(f, binding.token).releaseId, f.release.releaseId);
  } finally { binding.close(); }
});

test('unbound session ancestry check does not inspect every finished invocation lease', async t => {
  const f = await fixture(t);
  const script = "const s=await import(process.argv[1]);for(let i=0;i<48;i++)s.createSessionBinding({repositoryRoot:process.argv[2],releaseId:process.argv[3],kind:'invocation'});";
  const dead = spawnSync(process.execPath, ['--input-type=module','-e',script,moduleUrl,f.root,f.release.releaseId],
    { encoding:'utf8',timeout:20000 });
  assert.equal(dead.status,0,dead.stderr);
  const names = fs.readdirSync(path.join(f.root,'.jhw-runtime/sessions'));
  assert.equal(names.filter(name=>name.startsWith('s-')).length,48);
  let leaseOpens=0;
  const original=fs.openSync;
  try {
    fs.openSync=function(name,...args) {
      if(String(name).endsWith('/lease')) leaseOpens++;
      return original.call(this,name,...args);
    };
    assert.doesNotThrow(()=>store.assertNoSessionAncestor({repositoryRoot:f.root}));
  } finally { fs.openSync=original; }
  assert.ok(leaseOpens<=2,'unbound entry scanned '+leaseOpens+' unrelated invocation leases');
});

test('a finished inherited invocation is reaped only after its last lease holder exits', async t => {
  const f = await fixture(t);
  const binding = create(f,{kind:'invocation'});
  const child = spawn(process.execPath,
    ['-e',"process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
    {stdio:['pipe','pipe','pipe',binding.fd]});
  const done = once(child,'close');
  await once(child.stdout,'data');
  binding.close();
  assert.equal(fs.existsSync(sessionPath(f,binding.id,'manifest.json')),true);
  const active=store.reapCompletedSessionBindings({repositoryRoot:f.root,dryRun:false});
  assert.equal(active.removed,0);
  assert.equal(fs.existsSync(sessionPath(f,binding.id,'manifest.json')),true);
  child.stdin.end();await done;
  assert.equal(fs.existsSync(sessionPath(f,binding.id,'manifest.json')),true,
    'late lease release must be retained until an authorized reaper proves no holder');
  const preview=store.reapCompletedSessionBindings({repositoryRoot:f.root,dryRun:true});
  assert.equal(preview.candidates,1);
  assert.equal(fs.existsSync(sessionPath(f,binding.id,'manifest.json')),true);
  const removed=store.reapCompletedSessionBindings({repositoryRoot:f.root,dryRun:false});
  assert.equal(removed.removed,1);
  assert.deepEqual(fs.readdirSync(path.join(f.root,'.jhw-runtime/sessions')),[]);
});
test('reaper does not delete a live session root or a live invocation', async t=>{
  const f=await fixture(t);
  const session=create(f);
  const invocation=create(f,{kind:'invocation'});
  try {
    const result=store.reapCompletedSessionBindings({repositoryRoot:f.root,dryRun:false});
    assert.equal(result.removed,0);
    assert.equal(fs.existsSync(sessionPath(f,session.id,'manifest.json')),true);
    assert.equal(fs.existsSync(sessionPath(f,invocation.id,'manifest.json')),true);
  } finally {invocation.close();session.close();}
});
test('reaper refuses changed invocation manifests without deleting evidence', async t=>{
  const f=await fixture(t);
  const binding=create(f,{kind:'invocation'});
  const file=sessionPath(f,binding.id,'manifest.json');
  binding.close();
  // Completed sessions normally retire immediately. Build a corrupt orphan
  // in a separate child process so no already-closed lease can mask the test.
  const script="const s=await import(process.argv[1]);s.createSessionBinding({repositoryRoot:process.argv[2],releaseId:process.argv[3],kind:'invocation'});";
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,moduleUrl,f.root,f.release.releaseId],
    {encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);
  const id=fs.readdirSync(path.join(f.root,'.jhw-runtime/sessions')).find(name=>name.startsWith('s-'));
  assert.ok(id);
  const corrupt=sessionPath(f,id,'manifest.json');
  fs.chmodSync(corrupt,0o644);
  failure(()=>store.reapCompletedSessionBindings({repositoryRoot:f.root,dryRun:false}));
  assert.equal(fs.existsSync(corrupt),true);
});

test('a live invocation is not confused with an ancestor session root', async t => {
  const f = await fixture(t);
  const invocation=create(f,{kind:'invocation'});
  try {
    assert.doesNotThrow(()=>store.assertNoSessionAncestor({repositoryRoot:f.root}));
    failure(()=>resolve(f,invocation.token));
  } finally {invocation.close();}
});
test('a bound invocation cannot lose its inherited pin after the original root closes', async t => {
  const f=await fixture(t);
  const rootBinding=create(f);
  const invocation=create(f,{kind:'invocation',parentBinding:rootBinding.token});
  try {
    rootBinding.close();
    failure(()=>store.assertNoSessionAncestor({repositoryRoot:f.root}));
  } finally {invocation.close();rootBinding.close();}
});
test('a tampered ancestor session lease fails closed without a global record scan', async t => {
  const f=await fixture(t);
  const binding=create(f);
  const manifest=sessionPath(f,binding.id,'manifest.json');
  try {
    failure(()=>store.assertNoSessionAncestor({repositoryRoot:f.root}));
    fs.chmodSync(manifest,0o644);
    failure(()=>store.assertNoSessionAncestor({repositoryRoot:f.root}));
  } finally {fs.chmodSync(manifest,0o600);binding.close();}
});
test('bounded reaper paginates finished invocations without touching a live root', async t => {
  const f=await fixture(t);
  const root=create(f);
  const script="const s=await import(process.argv[1]);for(let i=0;i<19;i++)s.createSessionBinding({repositoryRoot:process.argv[2],releaseId:process.argv[3],kind:'invocation'});";
  try {
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,moduleUrl,f.root,f.release.releaseId],
      {encoding:'utf8',timeout:20000});
    assert.equal(child.status,0,child.stderr);
    let after=null;let total=0;let scanned=0;
    for(let page=0;page<10;page++){
      const result=store.reapCompletedSessionBindings({repositoryRoot:f.root,dryRun:false,limit:6,after});
      total+=result.removed;scanned+=result.scanned;
      if(result.nextAfter===null)break;
      after=result.nextAfter;
    }
    assert.equal(total,19);
    assert.equal(scanned,20);
    assert.deepEqual(fs.readdirSync(path.join(f.root,'.jhw-runtime/sessions')),[root.id]);
    assert.equal(resolve(f,root.token).releaseId,f.release.releaseId);
  } finally {root.close();}
});

// Real managed entries need an installed bootstrap, as in test-runtime-coexist.mjs.
const entryHelpers = ['runtime-entry.mjs', 'runtime-safety.mjs', 'runtime-store.mjs', 'runtime-deploy.mjs', 'install-wiring.sh',
  'install-config.mjs', 'jhw-runtime-entry', 'jhw-runtime-control', 'jhw-runtime-hook', 'jhw-control-hook'];
async function entryFixture(t, sentinel = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-session-entry-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({
    '.gitignore': '.jhw-runtime/\n', 'mcp-server/package.json': '{"type":"module"}',
    'mcp-server/package-lock.json': '{"lockfileVersion":3}', 'mcp-server/tsconfig.json': '{}',
    'mcp-server/src/index.ts': 'export const generation = 1;', 'mcp-server/scripts/clean-dist.mjs': '',
    'scripts/sync-codex-skills.mjs': '', 'skills/claude/task.md': 'fixture task',
  })) write(root, name, text);
  for (const name of entryHelpers) {
    write(root, 'scripts/' + name, fs.readFileSync(new URL('./' + name, import.meta.url)), name.startsWith('jhw-') ? 0o755 : 0o644);
  }
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const control = "process.stdout.write('ready\\n');if(process.argv.includes('--hold'))process.stdin.resume();";
  const hook = "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:process.argv.at(-1)}})+'\\n');";
  const build = async ({ stagingRoot }) => {
    for (const [name, body, mode] of [
      ['mcp-server/dist/index.js', 'module.exports = {};', 0o644], ['mcp-server/dist/runtime/mcp.cjs', 'module.exports = {};', 0o644],
      ['mcp-server/dist/control/cli.js', control, 0o755], ['mcp-server/dist/runtime/control.cjs', control, 0o755],
      ['mcp-server/dist/control/hook-adapter.js', hook, 0o755], ['mcp-server/dist/runtime/hook.cjs', hook, 0o755],
    ]) write(stagingRoot, name, body, mode);
    if (sentinel) write(stagingRoot, 'mcp-server/node_modules/walk-sentinel/walk-sentinel.js', '// sentinel');
    fs.mkdirSync(path.join(stagingRoot, 'mcp-server/node_modules'), { recursive: true, mode: 0o755 });
  };
  const release = await store.prepareRelease({ repositoryRoot: root, build });
  const deploy = acquireLease(path.join(root, '.jhw-runtime/deploy.lock'));
  const admission = acquireLease(path.join(root, '.jhw-runtime/admission.lock'), { create: true });
  try {
    await installBootstrap({ repositoryRoot: root, releaseId: release.releaseId });
    store.publishActivation({ repositoryRoot: root, releaseId: release.releaseId, expectedCurrent: null });
  } finally { admission.close(); deploy.close(); }
  write(root, '.jhw-runtime/wiring.json', '{"version":1,"installed":true}\n', 0o600);
  return { root, release, entry: path.join(root, '.jhw-runtime/bootstrap/jhw-runtime-entry') };
}
function runEntry(f, args, options = {}) {
  return spawnSync(process.execPath, [f.entry, ...args], { encoding: 'utf8', timeout: 20000, ...options });
}
function listSessions(f) {
  try { return fs.readdirSync(path.join(f.root, '.jhw-runtime/sessions')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function leaseFree(f, id) {
  try { acquireLease(sessionPath(f, id, 'lease')).close(); return true; }
  catch (error) { if (error.code === 'DEPLOY_LOCK_CONTENDED') return false; throw error; }
}
async function until(check, label, limit = 10000) {
  const deadline = Date.now() + limit;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
// Valid completed invocation records whose owner already exited, as a killed
// entry leaves them. Each manifest binds its own and its lease file's inode.
function writeCompletedRecords(f, count, exe = null) {
  const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:fs').readFileSync('/proc/self/stat','latin1'))"], { encoding: 'latin1' });
  assert.equal(probe.status, 0, probe.stderr);
  const fields = probe.stdout.slice(probe.stdout.lastIndexOf(')') + 1).trim().split(/\s+/);
  const executable = fs.statSync(process.execPath, { bigint: true });
  const repository = fs.statSync(f.root, { bigint: true });
  const owner = { uid: process.getuid(), pid: probe.pid, startTime: fields[19],
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    commandDigest: createHash('sha256').update('exited entry').digest('hex'),
    exeDev: String(executable.dev), exeIno: String(executable.ino), ...exe };
  const compatibilityDigest = store.releaseCompatibility({ repositoryRoot: f.root, releaseId: f.release.releaseId });
  fs.mkdirSync(path.join(f.root, '.jhw-runtime/sessions'), { recursive: true, mode: 0o700 });
  const ids = [];
  for (let index = 0; index < count; index++) {
    const id = 's-' + randomBytes(16).toString('hex');
    fs.mkdirSync(sessionPath(f, id, ''), { mode: 0o700 });
    const leaseFd = fs.openSync(sessionPath(f, id, 'lease'), 'wx', 0o600);
    const lease = fs.fstatSync(leaseFd, { bigint: true });
    fs.closeSync(leaseFd);
    const fd = fs.openSync(sessionPath(f, id, 'manifest.json'), 'wx', 0o600);
    try {
      const manifest = fs.fstatSync(fd, { bigint: true });
      fs.writeFileSync(fd, canonical({ version: 1, id, kind: 'invocation', releaseId: f.release.releaseId, compatibilityDigest,
        parentBinding: null, repository: { path: f.root, dev: String(repository.dev), ino: String(repository.ino) }, owner,
        manifest: { dev: String(manifest.dev), ino: String(manifest.ino) },
        lease: { dev: String(lease.dev), ino: String(lease.ino), fd: 6 }, createdAt: new Date().toISOString() }) + '\n');
    } finally { fs.closeSync(fd); }
    ids.push(id);
  }
  return ids;
}

test('a record whose executable inode reads as a negative BigInt stays valid', async t => {
  const f = await fixture(t);
  // Some filesystems report inode numbers above 2^63, which BigInt stats show as negative.
  const [id] = writeCompletedRecords(f, 1, { exeIno: '-9223372036854300301' });
  const preview = store.reapCompletedSessionBindings({ repositoryRoot: f.root, dryRun: true });
  assert.equal(preview.candidates, 1);
  const removed = store.reapCompletedSessionBindings({ repositoryRoot: f.root, dryRun: false });
  assert.equal(removed.removed, 1);
  assert.equal(listSessions(f).includes(id), false);
});

test('records of signal-terminated entries and session wrappers are reclaimed by a later entry', async t => {
  const f = await entryFixture(t);
  const held = spawn(process.execPath, [f.entry, 'control', '--hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const wrapper = spawn(process.execPath, [f.entry, 'session', '--', process.execPath, '-e', "process.stdout.write('ready\\n');process.stdin.resume()"],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const exits = [once(held, 'exit'), once(wrapper, 'exit')];
  let output = ''; let stderr = '';
  for (const child of [held, wrapper]) {
    child.stdout.on('data', part => { output += part; });
    child.stderr.on('data', part => { stderr += part; });
  }
  let ids;
  try {
    await until(() => output === 'ready\nready\n' || held.exitCode !== null || wrapper.exitCode !== null, 'entries ready ' + stderr);
    ids = listSessions(f);
    assert.deepEqual(ids.map(id => JSON.parse(fs.readFileSync(sessionPath(f, id, 'manifest.json'), 'utf8')).kind).sort(), ['invocation', 'session']);
    held.kill('SIGTERM'); wrapper.kill('SIGTERM');
    assert.deepEqual((await Promise.all(exits)).map(([, signal]) => signal), ['SIGTERM', 'SIGTERM']);
  } finally { held.kill('SIGKILL'); wrapper.kill('SIGKILL'); held.stdin.end(); wrapper.stdin.end(); }
  // Descendants exit on stdin EOF; no close() ran, so both records stay behind.
  await until(() => ids.every(id => leaseFree(f, id)), 'descendants released leases');
  assert.deepEqual(listSessions(f), ids);
  const next = runEntry(f, ['control']);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.stdout, 'ready\n');
  assert.deepEqual(listSessions(f), []);
});

// Break caught: a pinned entry validating the whole release more than once (resolve, parent re-resolve, compatibility).
test('a hook entry under a session wrapper walks the release exactly once', async t => {
  const f = await entryFixture(t, true);
  const directory = fs.mkdtempSync(path.join(f.root, 'walk-probe-'));
  const counter = path.join(directory, 'counter.mjs'); const count = path.join(directory, 'count');
  fs.writeFileSync(counter, "import fs from 'node:fs'; const out = new URL(import.meta.url).searchParams.get('count'); let opens = 0; const open = fs.openSync;\n" +
    "fs.openSync = function (name, ...rest) { if (typeof name === 'string' && name.endsWith('/walk-sentinel.js')) opens++; return open.call(this, name, ...rest); };\n" +
    "process.on('exit', () => fs.writeFileSync(out, String(opens)));\n");
  const preload = pathToFileURL(counter).href + '?count=' + encodeURIComponent(count);
  const result = runEntry(f, ['session', '--', process.execPath, '--import', preload, f.entry, 'hook', '--adapter', 'claude', '--event', 'PreToolUse'], { input: '{}' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  assert.equal(Number(fs.readFileSync(count, 'utf8')), 1);
});

// Preservation: under a session wrapper, a release corrupt or untrusted before the entry reports DEPLOY_SESSION_INVALID.
test('a release corrupt or untrusted before a pinned entry reports DEPLOY_SESSION_INVALID', async t => {
  for (const [label, tamper] of [['file bytes differ from the manifest', file => `fs.appendFileSync(${JSON.stringify(file)}, '// tampered')`],
    ['group-writable release file', file => `fs.chmodSync(${JSON.stringify(file)}, 0o666)`]]) {
    for (const args of [['hook', '--adapter', 'claude', '--event', 'PreToolUse'], ['control']]) {
      const f = await entryFixture(t);
      const file = path.join(f.root, '.jhw-runtime/releases', f.release.releaseId, 'mcp-server/dist/index.js');
      const script = `const fs = require('node:fs'); ${tamper(file)}; const r = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(f.entry)}, ...${JSON.stringify(args)}], { encoding: 'utf8', input: '{}' }); process.stdout.write(JSON.stringify([r.status, r.stdout, r.stderr]));`;
      const wrapped = runEntry(f, ['session', '--', process.execPath, '-e', script]);
      assert.equal(wrapped.status, 0, label + wrapped.stderr);
      const [status, stdout, stderr] = JSON.parse(wrapped.stdout);
      if (args[0] === 'hook') {
        assert.equal(status, 0, label); assert.equal(stderr, '', label);
        assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'DEPLOY_SESSION_INVALID' }, systemMessage: 'DEPLOY_SESSION_INVALID' }, label);
      } else {
        assert.equal(status, 75, label); assert.equal(stdout, '', label); assert.equal(stderr, JSON.stringify({ error: { code: 'DEPLOY_SESSION_INVALID' } }) + '\n', label);
      }
    }
  }
});

test('an entry drains more than SESSION_LIMIT completed records so control and PreToolUse still run', async t => {
  const f = await entryFixture(t);
  writeCompletedRecords(f, 1);
  // Positive control: the helper's records pass full sessionRecord validation.
  assert.equal(store.reapCompletedSessionBindings({ repositoryRoot: f.root, dryRun: true }).candidates, 1);
  writeCompletedRecords(f, 1099);
  assert.equal(listSessions(f).length, 1100);
  const control = runEntry(f, ['control']);
  assert.equal(control.status, 0, control.stderr);
  assert.equal(control.stdout, 'ready\n');
  const afterControl = listSessions(f).length;
  const hook = runEntry(f, ['hook', '--adapter', 'claude', '--event', 'PreToolUse'], { input: '{}' });
  assert.equal(hook.status, 0, hook.stderr);
  assert.doesNotMatch(hook.stdout, /DEPLOY_SESSION_INVALID|deny/);
  assert.deepEqual(JSON.parse(hook.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  const remaining = listSessions(f).length;
  assert.ok(remaining < 1024, 'entries left ' + remaining + ' records (after control: ' + afterControl + ')');
  // Reclaim keeps making progress after a drain reaches its floor; it never stalls there.
  assert.ok(remaining < afterControl, 'the second entry reclaimed nothing at ' + afterControl);
});

test('entry reclaim removes abandoned private leftovers of the expected shape and keeps other evidence', async t => {
  const f = await fixture(t);
  const sessions = path.join(f.root, '.jhw-runtime/sessions');
  fs.mkdirSync(sessions, { mode: 0o700 });
  const hex = () => randomBytes(16).toString('hex');
  const leftover = (name, files) => {
    fs.mkdirSync(path.join(sessions, name), { mode: 0o700 });
    for (const [file, mode] of files) write(path.join(sessions, name), file, '', mode);
    return name;
  };
  leftover('.creating.s-' + hex(), []);
  leftover('.retired.s-' + hex() + '.' + hex(), [['lease', 0o600]]);
  leftover('.creating.s-' + hex(), [['lease', 0o600], ['manifest.json', 0o600]]);
  const kept = [
    leftover('.retired.s-' + hex() + '.' + hex(), [['lease', 0o600], ['manifest.json', 0o600], ['extra', 0o600]]),
    leftover('.creating.s-' + hex(), [['lease', 0o644]]),
  ].sort();
  // Each entry reclaims at most two; three entries cover any listing order.
  for (let entry = 0; entry < 3; entry++) {
    const binding = create(f);
    try { assert.equal(resolve(f, binding.token).releaseId, f.release.releaseId); }
    finally { binding.close(); }
  }
  assert.deepEqual(listSessions(f), kept);
  assert.deepEqual(fs.readdirSync(path.join(sessions, kept[0])).sort(), kept[0].startsWith('.retired.') ? ['extra', 'lease', 'manifest.json'] : ['lease']);
});

test('kept evidence leftovers do not starve reclaim of completed public records', async t => {
  const f = await fixture(t);
  const sessions = path.join(f.root, '.jhw-runtime/sessions');
  fs.mkdirSync(sessions, { mode: 0o700 });
  const hex = () => randomBytes(16).toString('hex');
  // Five leftovers whose shape is kept as evidence fill more than one batch.
  for (let i = 0; i < 5; i++) {
    const name = '.retired.s-' + hex() + '.' + hex();
    fs.mkdirSync(path.join(sessions, name), { mode: 0o700 });
    write(path.join(sessions, name), 'extra', '', 0o600);
  }
  // A finished process leaves one completed public record behind.
  const script = "const s=await import(process.argv[1]);s.createSessionBinding({repositoryRoot:process.argv[2],releaseId:process.argv[3],kind:'invocation'});";
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.root, f.release.releaseId], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const [completed] = listSessions(f).filter(name => name.startsWith('s-'));
  assert.ok(completed);
  // Each entry tries four consecutive candidates from a random start over six, so
  // twelve entries all missing the record has probability (1/3)^12.
  for (let entry = 0; entry < 12 && listSessions(f).includes(completed); entry++) {
    const binding = create(f);
    try { assert.equal(resolve(f, binding.token).releaseId, f.release.releaseId); }
    finally { binding.close(); }
  }
  assert.equal(listSessions(f).includes(completed), false, 'completed record starved behind kept evidence');
  assert.equal(listSessions(f).filter(name => name.startsWith('.retired.')).length, 5);
});

test('entry reclaim keeps a completed record whose manifest was tampered', async t => {
  const f = await fixture(t);
  const script = "const s=await import(process.argv[1]);for(let i=0;i<2;i++)s.createSessionBinding({repositoryRoot:process.argv[2],releaseId:process.argv[3],kind:'invocation'});";
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.root, f.release.releaseId], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const [tampered, valid] = listSessions(f);
  assert.ok(tampered && valid);
  fs.chmodSync(sessionPath(f, tampered, 'manifest.json'), 0o644);
  const binding = create(f);
  try { assert.equal(resolve(f, binding.token).releaseId, f.release.releaseId); }
  finally { binding.close(); }
  // The valid sibling shows reclaim ran in this entry; the tampered one is evidence.
  assert.deepEqual(listSessions(f), [tampered]);
  assert.equal(fs.statSync(sessionPath(f, tampered, 'manifest.json')).mode & 0o777, 0o644);
});

test('entry reclaim keeps live session roots and invocations, including ones whose owner exited', async t => {
  const f = await fixture(t);
  const sessionRoot = create(f);
  const invocation = create(f, { kind: 'invocation' });
  // The owner exits at once; a descendant keeps both inherited leases until a stop
  // file appears (Node destroys a child's stdin pipe when that child exits).
  const stop = path.join(f.root, 'stop');
  const holder = "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t);},20);";
  const script = "const s=await import(process.argv[1]);const {spawn}=await import('node:child_process');const [root,releaseId,holder,stop]=process.argv.slice(2);const a=s.createSessionBinding({repositoryRoot:root,releaseId});const b=s.createSessionBinding({repositoryRoot:root,releaseId,kind:'invocation'});spawn(process.execPath,['-e',holder,stop],{stdio:['ignore','ignore','ignore',a.fd,b.fd]});process.exit(0);";
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.root, f.release.releaseId, holder, stop], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', part => { stderr += part; });
  let orphans;
  try {
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    const live = [sessionRoot.id, invocation.id].sort();
    orphans = listSessions(f).filter(id => !live.includes(id));
    assert.equal(orphans.length, 2);
    assert.ok(orphans.every(id => !leaseFree(f, id)), 'descendant must hold both orphan leases');
    for (let entry = 0; entry < 3; entry++) create(f).close();
    assert.deepEqual(listSessions(f), [...live, ...orphans].sort());
    assert.ok(orphans.every(id => !leaseFree(f, id)), 'descendant must still hold both orphan leases');
  } finally { fs.writeFileSync(stop, ''); }
  try {
    // Positive control: once the last holder exits, the same orphans are reclaimed.
    await until(() => orphans.every(id => leaseFree(f, id)), 'descendant released leases');
    create(f).close();
    assert.deepEqual(listSessions(f), [sessionRoot.id, invocation.id].sort());
  } finally { invocation.close(); sessionRoot.close(); }
});

test('inventory treats a record whose holder finishes during live verification as not live', async t => {
  const f = await fixture(t);
  // Deterministic seam: the first lease probe sees the holder; retire it right
  // before verifyLiveSession probes the lease again.
  const binding = create(f, { kind: 'invocation' });
  const original = fs.openSync;
  let opens = 0; let retiredDuringVerify = false;
  try {
    fs.openSync = function(name, ...args) {
      if (path.basename(String(name)) === 'lease' && ++opens === 2) {
        binding.close();
        retiredDuringVerify = !fs.existsSync(sessionPath(f, binding.id, ''));
      }
      return original.call(this, name, ...args);
    };
    assert.deepEqual(inspect(f), []);
  } finally { fs.openSync = original; binding.close(); }
  assert.equal(retiredDuringVerify, true, 'the record must vanish between the first probe and live verification');
});

test('an unbound lineage may end at a process whose parent is outside the PID namespace', async t => {
  const f = await fixture(t);
  // A process entered into a PID namespace by setns (docker exec, nsenter) sees
  // PPID 0 without being PID 1. On a host, kthreadd has the same shape.
  let top = null;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name) || name === '1') continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${name}/stat`, 'latin1'); } catch { continue; }
    if (stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1] === '0') { top = Number(name); break; }
  }
  if (top === null) { t.skip('no process with PPID 0 other than PID 1 is visible'); return; }
  assert.doesNotThrow(() => store.assertNoSessionAncestor({ repositoryRoot: f.root, pid: top }));
});

test('inventory treats a record retired after its snapshot as not live', async t => {
  const f = await fixture(t);
  // Deterministic seam: retire a held record right before its post-snapshot lease probe.
  const binding = create(f, { kind: 'invocation' });
  const original = fs.openSync;
  let armed = true; let retiredBeforeProbe = false;
  try {
    fs.openSync = function(name, ...args) {
      if (armed && path.basename(String(name)) === 'lease') {
        armed = false;
        binding.close();
        retiredBeforeProbe = !fs.existsSync(sessionPath(f, binding.id, ''));
      }
      return original.call(this, name, ...args);
    };
    assert.deepEqual(inspect(f), []);
  } finally { fs.openSync = original; binding.close(); }
  assert.equal(retiredBeforeProbe, true, 'the record must vanish between snapshot and probe');
  // Concurrent churn: a child creates and closes invocations while inventory repeats.
  const stop = path.join(f.root, 'stop');
  const script = "const fs=await import('node:fs');const s=await import(process.argv[1]);const [root,releaseId,stop]=process.argv.slice(2);let count=0;process.stdout.write('ready\\n');while(!fs.existsSync(stop)){s.createSessionBinding({repositoryRoot:root,releaseId,kind:'invocation'}).close();count++;}process.stdout.write(count+'\\n');";
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.root, f.release.releaseId, stop], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = once(child, 'exit');
  let output = ''; let stderr = '';
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { stderr += part; });
  const errors = []; let inspections = 0;
  try {
    await until(() => output === 'ready\n' || child.exitCode !== null, 'creator ready ' + stderr);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && child.exitCode === null && inspections < 300) {
      try { inspect(f); } catch (error) { errors.push(error.code ?? error.message); }
      inspections++;
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { fs.writeFileSync(stop, ''); }
  const [code] = await done;
  assert.equal(code, 0, stderr);
  assert.deepEqual(errors, []);
  assert.ok(Number(output.split('\n')[1]) > 0 && inspections > 0, 'churn and inventory both ran: ' + JSON.stringify({ output, inspections }));
});
