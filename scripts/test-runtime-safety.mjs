import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import {
  DeploymentError, trustedDirectory, trustedFile, acquireLease,
  inspectConsumers, requireQuiescence,
} from './runtime-safety.mjs';

const uid = process.getuid();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-safety-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(name, content = '', mode = 0o600) {
  fs.writeFileSync(name, content, { mode });
  fs.chmodSync(name, mode);
  return name;
}
function processStat(pid, { start = 12345, state = 'S', comm = 'node', flags = 4194304 } = {}) {
  return `${pid} (${comm}) ${state} 1 1 1 0 -1 ${flags} 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`;
}
function procFixture(t) {
  const root = fixture(t);
  const procRoot = path.join(root, 'proc');
  const repositoryRoot = path.join(root, 'repo');
  fs.mkdirSync(procRoot); fs.mkdirSync(repositoryRoot);
  return { procRoot, repositoryRoot };
}
function addProcess(options, pid, argv, { owner = uid, cwd = options.repositoryRoot, ...stat } = {}) {
  const directory = path.join(options.procRoot, String(pid));
  fs.mkdirSync(directory);
  file(path.join(directory, 'status'), `Name:\tnode\nUid:\t${owner}\t${owner}\t${owner}\t${owner}\n`);
  file(path.join(directory, 'stat'), processStat(pid, stat));
  file(path.join(directory, 'cmdline'), argv.length ? `${argv.join('\0')}\0` : '');
  fs.symlinkSync(cwd, path.join(directory, 'cwd'));
  return directory;
}
const clearInventory = { clear: true, counts: { tui: 0, app_server: 0, legacy: 0, managed: 0 }, uncertain: 0 };

test('trusted objects accept private files below the sticky temporary ancestor', t => {
  const root = fixture(t);
  assert.equal(trustedDirectory(root).isDirectory(), true);
  assert.equal(trustedFile(file(path.join(root, 'entry'), '', 0o700), { executable: true }).isFile(), true);
});

test('trust rejects symlinks, hard links, special files, and writable objects', t => {
  const root = fixture(t);
  const regular = file(path.join(root, 'regular'));
  fs.symlinkSync(regular, path.join(root, 'symlink'));
  fs.linkSync(regular, path.join(root, 'hardlink'));
  fs.mkdirSync(path.join(root, 'directory'));
  assert.equal(spawnSync('/usr/bin/mkfifo', [path.join(root, 'fifo')]).status, 0);
  for (const name of ['regular', 'hardlink', 'symlink', 'directory', 'fifo']) {
    assert.throws(() => trustedFile(path.join(root, name)), { code: 'DEPLOY_UNTRUSTED_PATH' });
  }
  const writable = file(path.join(root, 'writable'), '', 0o620);
  assert.throws(() => trustedFile(writable), { code: 'DEPLOY_UNTRUSTED_PATH' });
  assert.throws(() => trustedFile(file(path.join(root, 'noexec')), { executable: true }), { code: 'DEPLOY_UNTRUSTED_PATH' });
  assert.throws(() => trustedFile(writable, { uid: uid + 1 }), { code: 'DEPLOY_UNTRUSTED_PATH' });
  fs.chmodSync(path.join(root, 'directory'), 0o770);
  assert.throws(() => trustedDirectory(path.join(root, 'directory')), { code: 'DEPLOY_UNTRUSTED_PATH' });
});

test('trust rejects a symlink or writable ancestor before opening its descendants', t => {
  const root = fixture(t);
  const parent = path.join(root, 'parent'); fs.mkdirSync(parent, { mode: 0o700 });
  file(path.join(parent, 'entry'));
  fs.symlinkSync(parent, path.join(root, 'alias'));
  assert.throws(() => trustedFile(path.join(root, 'alias', 'entry')), { code: 'DEPLOY_UNTRUSTED_PATH' });
  fs.chmodSync(parent, 0o777);
  assert.throws(() => trustedFile(path.join(parent, 'entry')), { code: 'DEPLOY_UNTRUSTED_PATH' });
});

test('exclusive deployment cannot cross a managed reader; shared readers coexist', t => {
  const lock = path.join(fixture(t), 'admission.lock');
  const reader = acquireLease(lock, { shared: true, create: true });
  const other = acquireLease(lock, { shared: true });
  try {
    assert.throws(() => acquireLease(lock), { code: 'DEPLOY_LOCK_CONTENDED' });
    reader.close();
    assert.throws(() => acquireLease(lock), { code: 'DEPLOY_LOCK_CONTENDED' });
  } finally { reader.close(); other.close(); }
  const writer = acquireLease(lock);
  try { assert.throws(() => acquireLease(lock, { shared: true }), { code: 'DEPLOY_LOCK_CONTENDED' }); }
  finally { writer.close(); }
  assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
});

test('an inherited descriptor keeps the lease after the original holder closes', async t => {
  const lock = path.join(fixture(t), 'admission.lock');
  const holder = acquireLease(lock, { shared: true, create: true });
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('end', () => { require('node:fs').closeSync(3); });"], {
    stdio: ['pipe', 'pipe', 'pipe', holder.fd],
  });
  const exit = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    holder.close();
    assert.throws(() => acquireLease(lock), { code: 'DEPLOY_LOCK_CONTENDED' });
  } finally { holder.close(); child.stdin.end(); await exit; }
  const writer = acquireLease(lock); writer.close();
  assert.equal(fs.existsSync(lock), true);
});

test('leases reject unsafe existing locks and never repair them', t => {
  const root = fixture(t);
  const lock = file(path.join(root, 'lock'), 'evidence', 0o640);
  assert.throws(() => acquireLease(lock, { create: true }), { code: 'DEPLOY_UNTRUSTED_PATH' });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'evidence');
  assert.equal(fs.statSync(lock).mode & 0o777, 0o640);
  fs.symlinkSync(lock, path.join(root, 'alias'));
  assert.throws(() => acquireLease(path.join(root, 'alias'), { create: true }), { code: 'DEPLOY_UNTRUSTED_PATH' });
  assert.throws(() => acquireLease(path.join(root, 'missing')), DeploymentError);
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
});

test('lease creation pins mode 0600 independently of a restrictive umask', t => {
  const lock = path.join(fixture(t), 'lock');
  const previous = process.umask(0o777);
  try {
    const lease = acquireLease(lock, { create: true });
    lease.close();
    assert.equal(fs.statSync(lock).mode & 0o7777, 0o600);
  } finally { process.umask(previous); }
});

test('inventory counts supported binary and interpreter identities and Codex app-server', t => {
  const options = procFixture(t);
  const commands = [
    ['claude'], ['/usr/local/bin/codex'], ['gemini'], ['/opt/bin/opencode'],
    ['node', '/opt/node_modules/@anthropic-ai/claude-code/cli.js'],
    ['node', '/opt/node_modules/@openai/codex/bin/codex.js'],
    ['node', '/opt/node_modules/@google/gemini-cli/dist/index.js'],
    ['bun', '/opt/node_modules/opencode-ai/bin/opencode'],
    ['/opt/bin/codex', 'app-server', '--listen', 'stdio://'],
    ['node', '/opt/node_modules/@openai/codex/bin/codex.js', 'app-server'],
  ];
  commands.forEach((argv, i) => addProcess(options, i + 100, argv));
  assert.deepEqual(inspectConsumers(options), { clear: false, counts: { tui: 8, app_server: 2, legacy: 0, managed: 0 }, uncertain: 0 });
});

test('inventory resolves interpreter flags and relative entry paths without matching arbitrary arguments', t => {
  const options = procFixture(t);
  addProcess(options, 100, ['node', '--no-warnings', './mcp-server/dist/index.js']);
  addProcess(options, 101, ['bash', '-e', './scripts/jhw-control-hook']);
  addProcess(options, 102, ['node', '--require', './setup.js', './mcp-server/dist/control/cli.js']);
  addProcess(options, 103, ['node', '/other/script.js', `${options.repositoryRoot}/mcp-server/dist/index.js`, 'codex', 'app-server']);
  addProcess(options, 104, ['printf', 'claude']);
  addProcess(options, 105, ['node', '-e', 'console.log("codex")', `${options.repositoryRoot}/mcp-server/dist/index.js`]);
  addProcess(options, 106, ['node', '/opt/not-claude-code/cli.js']);
  assert.deepEqual(inspectConsumers(options), { clear: false, counts: { tui: 0, app_server: 0, legacy: 3, managed: 0 }, uncertain: 0 });
});

test('shell options that take values do not hide the runtime script identity', t => {
  const options = procFixture(t);
  addProcess(options, 100, ['bash', '-o', 'pipefail', './scripts/jhw-control-hook']);
  addProcess(options, 101, ['bash', '-eo', 'pipefail', './scripts/jhw-control-hook']);
  const result = inspectConsumers(options);
  assert.equal(result.clear, false);
  assert.equal(result.counts.legacy, 2);
  assert.equal(result.uncertain, 0);
});

for (const flag of ['-C', '-r', '+C', '+r', '-eCr']) {
  test(`shell no-argument ${flag} never consumes the hook script`, t => {
    const options = procFixture(t);
    addProcess(options, 100, ['bash', flag, `${options.repositoryRoot}/scripts/jhw-control-hook`]);
    assert.deepEqual(inspectConsumers(options), {
      clear: false, counts: { tui: 0, app_server: 0, legacy: 1, managed: 0 }, uncertain: 0,
    }, flag);
  });
}

test('Node -C and -r consume option values and preserve the following script position', t => {
  const options = procFixture(t);
  addProcess(options, 100, ['node', '-C', 'development', './mcp-server/dist/index.js']);
  addProcess(options, 101, ['node', '-r', './setup.js', './mcp-server/dist/index.js']);
  addProcess(options, 102, ['node', '-r', `${options.repositoryRoot}/mcp-server/dist/index.js`, '/other/script.js']);
  assert.deepEqual(inspectConsumers(options), {
    clear: false, counts: { tui: 0, app_server: 0, legacy: 2, managed: 0 }, uncertain: 0,
  });
});

for (const flag of ['-C', '-r']) {
  test(`Python never inherits Node option-value semantics for unsupported ${flag}`, t => {
    const options = procFixture(t);
    addProcess(options, 100, ['python3', flag, `${options.repositoryRoot}/scripts/jhw-control-hook`]);
    assert.deepEqual(inspectConsumers(options), {
      clear: false, counts: { tui: 0, app_server: 0, legacy: 0, managed: 0 }, uncertain: 1,
    }, flag);
  });
}

test('inventory matches only exact legacy and known managed runtime entry paths', t => {
  const options = procFixture(t);
  const root = options.repositoryRoot;
  const entries = [
    '/mcp-server/dist/index.js', '/mcp-server/dist/control/cli.js', '/mcp-server/dist/control/hook-adapter.js', '/scripts/jhw-control-hook',
    '/.jhw-runtime/bootstrap/jhw-runtime-entry', '/.jhw-runtime/current/mcp-server/dist/index.js',
    `/.jhw-runtime/releases/r-${'a'.repeat(40)}-${'b'.repeat(64)}/mcp-server/dist/control/cli.js`, `/.jhw-runtime/activations/a-${'c'.repeat(32)}/scripts/jhw-control-hook`,
  ];
  entries.forEach((entry, i) => addProcess(options, i + 100, ['node', root + entry]));
  addProcess(options, 200, ['node', `${root}-other/mcp-server/dist/index.js`]);
  addProcess(options, 201, ['node', `${root}/.jhw-runtime/releases/r-abc123/other/index.js`]);
  assert.deepEqual(inspectConsumers(options), { clear: false, counts: { tui: 0, app_server: 0, legacy: 4, managed: 4 }, uncertain: 0 });
});

test('installed control launcher identities block even when argv uses the symlink name', t => {
  const options = procFixture(t);
  addProcess(options, 100, ['node', '/private/bin/jhw-control', 'status']);
  addProcess(options, 101, ['bash', '/private/bin/jhw-control-hook', '--adapter', 'codex']);
  addProcess(options, 102, ['/private/bin/jhw-runtime-entry', 'mcp']);
  addProcess(options, 103, ['node', '/other/script.js', '/private/bin/jhw-control']);
  assert.deepEqual(inspectConsumers(options), { clear: false, counts: { tui: 0, app_server: 0, legacy: 2, managed: 1 }, uncertain: 0 });
});

test('stable zombies and kernel tasks with empty argv are clear; living empty argv is uncertain', t => {
  const options = procFixture(t);
  addProcess(options, 100, [], { state: 'Z' });
  addProcess(options, 101, [], { flags: 2097152 });
  assert.deepEqual(inspectConsumers(options), clearInventory);
  addProcess(options, 102, []);
  assert.equal(inspectConsumers(options).uncertain, 1);
});

test('another UID is excluded by directory ownership without requiring its private records', t => {
  const options = procFixture(t);
  const directory = addProcess(options, 100, ['codex']);
  fs.unlinkSync(path.join(directory, 'status'));
  assert.deepEqual(inspectConsumers({ ...options, uid: uid + 1 }), clearInventory);
});

test('only explicit orchestration exclusions apply; a parent TUI remains a blocker', t => {
  const options = procFixture(t);
  addProcess(options, 1, ['codex']);
  addProcess(options, 100, ['node', `${options.repositoryRoot}/mcp-server/dist/control/cli.js`]);
  assert.deepEqual(inspectConsumers({ ...options, excludePids: [100] }), { clear: false, counts: { tui: 1, app_server: 0, legacy: 0, managed: 0 }, uncertain: 0 });
});

test('unavailable cwd, ambiguous interpreter options and malformed UID records are uncertain', t => {
  for (const failure of ['cwd', 'options', 'uid', 'unterminated_argv']) {
    const options = procFixture(t);
    const directory = addProcess(options, 100, ['node', './mcp-server/dist/index.js']);
    if (failure === 'cwd') fs.unlinkSync(path.join(directory, 'cwd'));
    if (failure === 'options') file(path.join(directory, 'cmdline'), 'node\0--unknown-option\0codex\0');
    if (failure === 'uid') file(path.join(directory, 'status'), 'Uid: invalid\n');
    if (failure === 'unterminated_argv') file(path.join(directory, 'cmdline'), 'node\0script.js');
    const result = inspectConsumers(options);
    assert.equal(result.clear, false, failure);
    assert.equal(result.uncertain, 1, failure);
  }
});

test('foreign UID observations never count as consumers; only explicit PIDs are excluded', t => {
  const options = procFixture(t);
  addProcess(options, 100, ['claude'], { owner: uid + 1 });
  addProcess(options, 101, ['codex']);
  addProcess(options, 102, ['gemini']);
  const result = inspectConsumers({ ...options, excludePids: [101] });
  assert.equal(result.counts.tui, 1);
  // A fixture cannot chown its proc directory as an ordinary user; a status/directory
  // UID disagreement is uncertainty, never authority to ignore a current-user PID.
  assert.equal(result.uncertain, 1);
  assert.equal(result.clear, false);
});

test('missing, malformed, unreadable and special required process records fail closed', t => {
  for (const failure of ['missing', 'malformed', 'unreadable', 'symlink', 'fifo', 'empty']) {
    const options = procFixture(t);
    const directory = addProcess(options, 100, ['node', '/other/script.js']);
    const target = path.join(directory, failure === 'malformed' ? 'stat' : 'cmdline');
    if (failure === 'missing') fs.unlinkSync(target);
    if (failure === 'malformed') file(target, '100 invalid stat');
    if (failure === 'unreadable') fs.chmodSync(target, 0);
    if (failure === 'empty') file(target, '');
    if (failure === 'symlink') { fs.unlinkSync(target); fs.symlinkSync(path.join(directory, 'status'), target); }
    if (failure === 'fifo') { fs.unlinkSync(target); assert.equal(spawnSync('/usr/bin/mkfifo', [target]).status, 0); }
    const result = inspectConsumers(options);
    assert.equal(result.clear, false, failure);
    assert.equal(result.uncertain, 1, failure);
    assert.throws(() => requireQuiescence(options), { code: 'DEPLOY_INVENTORY_UNCERTAIN' });
  }
});

test('inventory entry and byte budgets fail closed with bounded diagnostics', t => {
  const options = procFixture(t);
  addProcess(options, 10987, ['codex', 'private-session-coordinate']);
  addProcess(options, 20987, ['node', '/other/script.js']);
  for (const limits of [{ maxEntries: 1 }, { maxArgvBytes: 8 }, { maxEntries: 0 }, { maxArgvBytes: Number.MAX_SAFE_INTEGER }]) {
    const result = inspectConsumers({ ...options, ...limits });
    assert.equal(result.clear, false);
    assert.ok(result.uncertain > 0);
    let error;
    try { requireQuiescence({ ...options, ...limits }); } catch (caught) { error = caught; }
    assert.ok(error instanceof DeploymentError);
    const serialized = JSON.stringify({ result, error, message: error.message });
    for (const secret of [options.procRoot, options.repositoryRoot, '10987', 'private-session-coordinate']) assert.equal(serialized.includes(secret), false);
    assert.ok(serialized.length < 512);
  }
});

test('quiescence returns the clear inventory or a bounded active-consumer error', t => {
  const options = procFixture(t);
  assert.deepEqual(requireQuiescence(options), clearInventory);
  addProcess(options, 100, ['claude']);
  assert.throws(() => requireQuiescence(options), { code: 'DEPLOY_CONSUMERS_ACTIVE' });
});

test('changing process identity records are never accepted as a stable observation', async t => {
  const options = procFixture(t);
  const directory = addProcess(options, 100, ['node', '/other/script.js', 'x'.repeat(100000)]);
  const state = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const fs = require('node:fs'); const state = new Int32Array(workerData.state);
    let generation = 50000; parentPort.postMessage('ready');
    while (!Atomics.load(state, 0)) {
      fs.writeFileSync(workerData.file, workerData.stat.replace('12345', String(generation++)));
      Atomics.add(state, 1, 1);
    }
  `, { eval: true, workerData: { state: state.buffer, file: path.join(directory, 'stat'), stat: processStat(100) } });
  const exit = once(worker, 'exit');
  let uncertain = 0;
  try {
    await once(worker, 'message');
    for (let i = 0; i < 30; i++) uncertain += inspectConsumers(options).uncertain;
  } finally { Atomics.store(state, 0, 1); await exit; }
  assert.ok(Atomics.load(state, 1) > 0);
  assert.ok(uncertain > 0, 'concurrent stat changes must produce uncertainty');
});


test('ancestor sibling directory churn preserves trusted pathname identity', t => {
  const root = fixture(t);
  const leaf = path.join(root, 'leaf'); fs.mkdirSync(leaf, {mode: 0o700});
  const original = fs.fstatSync;
  const parent = fs.statSync(root);
  let changed = false;
  fs.fstatSync = function(fd, ...args) {
    const value = original.call(this, fd, ...args);
    if (!changed && value.ino === parent.ino && value.dev === parent.dev) {
      changed = true; fs.mkdirSync(path.join(root, 'unrelated-sibling'), {mode: 0o700});
    }
    return value;
  };
  try { assert.equal(trustedDirectory(leaf).isDirectory(), true); }
  finally { fs.fstatSync = original; }
  assert.equal(changed, true);
});

test('actual ancestor replacement still refuses trusted pathname identity', t => {
  const root = fixture(t);
  const leaf = path.join(root, 'leaf'); fs.mkdirSync(leaf, {mode: 0o700});
  const original = fs.fstatSync;
  const parent = fs.statSync(root);
  let changed = false;
  // Replacement is injected after the leaf has been opened, while verifying ancestors.
  let reads = 0;
  fs.fstatSync = function(fd, ...args) {
    const value = original.call(this, fd, ...args);
    if (value.ino === parent.ino && value.dev === parent.dev && ++reads === 2) {
      changed = true; fs.renameSync(leaf, path.join(root, 'old-leaf')); fs.mkdirSync(leaf, {mode: 0o700});
    }
    return value;
  };
  try { assert.throws(() => trustedDirectory(leaf), {code: 'DEPLOY_UNTRUSTED_PATH'}); }
  finally { fs.fstatSync = original; }
  assert.equal(changed, true);
});

test('inventory covers final closed managed launchers and SHA256 release IDs', t => {
  const options = procFixture(t);
  const release = `r-${'a'.repeat(64)}-${'b'.repeat(64)}`;
  const activation = `a-${'c'.repeat(32)}`;
  const entries = ['jhw-runtime-entry', 'jhw-runtime-control', 'jhw-runtime-hook'].flatMap(name => [name, `${options.repositoryRoot}/.jhw-runtime/bootstrap/${name}`]);
  for (const prefix of [`releases/${release}`, `activations/${activation}`, 'current']) {
    for (const suffix of ['mcp-server/dist/index.js', 'mcp-server/dist/control/cli.js', 'mcp-server/dist/control/hook-adapter.js', 'scripts/jhw-control-hook']) entries.push(`${options.repositoryRoot}/.jhw-runtime/${prefix}/${suffix}`);
  }
  entries.forEach((entry, index) => addProcess(options, 100 + index, ['node', entry]));
  assert.deepEqual(inspectConsumers(options), {clear:false,counts:{tui:0,app_server:0,legacy:0,managed:entries.length},uncertain:0});
});
