import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as store from './runtime-store.mjs';
import { acquireLease } from './runtime-safety.mjs';

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
