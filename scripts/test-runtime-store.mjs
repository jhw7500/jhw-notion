import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { acquireLease } from './runtime-safety.mjs';

// A missing implementation is an explicit behavioral failure, not an import error.
const store = await import('./runtime-store.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

function write(root, name, text = 'fixture\n', mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, text, { mode });
  return file;
}
function command(cwd, name, args) {
  const result = spawnSync(name, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-store-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.gitignore', '.jhw-runtime/\n.env\nnode_modules/\ndist/\n');
  write(root, 'mcp-server/package.json', '{"type":"module"}\n');
  write(root, 'mcp-server/package-lock.json', '{"lockfileVersion":3}\n');
  write(root, 'mcp-server/tsconfig.json', '{}\n');
  write(root, 'mcp-server/src/index.ts', 'export const fixture = 1;\n');
  write(root, 'mcp-server/scripts/clean-dist.mjs');
  write(root, 'scripts/sync-codex-skills.mjs');
  write(root, 'scripts/jhw-control-hook', '#!/bin/sh\nexit 0\n', 0o755);
  write(root, 'skills/claude/task.md', '---\ndescription: task\n---\n');
  write(root, 'skills/codex/jhw-task/SKILL.md');
  fs.mkdirSync(path.join(root, 'skills/codex/jhw-task/references'), { mode: 0o755 });
  fs.symlinkSync('../../../claude/task.md', path.join(root, 'skills/codex/jhw-task/references/task.md'));
  command(root, 'git', ['init', '-q']);
  command(root, 'git', ['add', '.']);
  command(root, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  write(root, 'mcp-server/.env', 'NEVER_COPY_THIS_SECRET\n', 0o600);
  write(root, 'mcp-server/dist/live.js', 'old runtime');
  write(root, 'mcp-server/node_modules/live.js', 'old dependency');
  write(root, 'private-config.json', '{"foreign":true}\n', 0o600);
  fs.symlinkSync('mcp-server/dist/live.js', path.join(root, 'global-link'));
  return root;
}
async function build({ stagingRoot }) {
  assert.match(path.basename(stagingRoot), /^\.stage\./);
  assert.equal(fs.statSync(stagingRoot).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(stagingRoot, 'mcp-server/.env')), false);
  assert.equal(fs.existsSync(path.join(stagingRoot, '.git')), false);
  assert.equal(fs.existsSync(path.join(stagingRoot, 'private-config.json')), false);
  write(stagingRoot, 'mcp-server/dist/index.js', 'export const version = 1;\n');
  write(stagingRoot, 'mcp-server/dist/control/cli.js', '#!/usr/bin/env node\n', 0o755);
  write(stagingRoot, 'mcp-server/dist/control/hook-adapter.js', '#!/usr/bin/env node\n', 0o755);
  write(stagingRoot, 'mcp-server/dist/runtime/mcp.cjs', 'exports.version = 1;\n');
  write(stagingRoot, 'mcp-server/dist/runtime/control.cjs', '#!/usr/bin/env node\n', 0o755);
  write(stagingRoot, 'mcp-server/dist/runtime/hook.cjs', '#!/usr/bin/env node\n', 0o755);
  write(stagingRoot, 'mcp-server/node_modules/example/bin.js', '#!/usr/bin/env node\n', 0o755);
  fs.mkdirSync(path.join(stagingRoot, 'mcp-server/node_modules/.bin'), { mode: 0o755 });
  fs.symlinkSync('../example/bin.js', path.join(stagingRoot, 'mcp-server/node_modules/.bin/example'));
}
function prepare(root, callback = build) {
  assert.equal(typeof store.prepareRelease, 'function', 'immutable preparation API must exist');
  return store.prepareRelease({ repositoryRoot: root, build: callback });
}
function releasePath(root, release) { return path.join(root, '.jhw-runtime/releases', release.releaseId); }
function unchanged(root) {
  assert.equal(fs.readFileSync(path.join(root, 'mcp-server/dist/live.js'), 'utf8'), 'old runtime');
  assert.equal(fs.readFileSync(path.join(root, 'mcp-server/node_modules/live.js'), 'utf8'), 'old dependency');
  assert.equal(fs.readFileSync(path.join(root, 'private-config.json'), 'utf8'), '{"foreign":true}\n');
  assert.equal(fs.readlinkSync(path.join(root, 'global-link')), 'mcp-server/dist/live.js');
}
function code(expected) { return error => error.code === expected && !error.message.includes('/'); }
function mutateManifest(root, release, mutate) {
  const file = path.join(releasePath(root, release), 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest));
}

test('preparation publishes complete private releases without changing legacy artifacts or wiring', async t => {
  const root = fixture(t);
  const result = await prepare(root);
  assert.match(result.releaseId, /^r-[a-f0-9]{40}-[a-f0-9]{64}$/);
  assert.equal(result.sourceRevision, command(root, 'git', ['rev-parse', 'HEAD']));
  assert.equal(result.dirty, false);
  assert.match(result.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.validateRelease({ repositoryRoot: root, releaseId: result.releaseId }), result);
  assert.equal(store.readActivation({ repositoryRoot: root }), null);
  assert.equal(fs.readlinkSync(path.join(releasePath(root, result), 'mcp-server/.env')), path.join(root, 'mcp-server/.env'));
  const manifest = fs.readFileSync(path.join(releasePath(root, result), 'manifest.json'), 'utf8');
  assert.equal(manifest.includes(root), false);
  assert.equal(manifest.includes('NEVER_COPY_THIS_SECRET'), false);
  assert.equal(fs.statSync(path.join(releasePath(root, result), 'manifest.json')).mode & 0o777, 0o600);
  unchanged(root);
});

test('build failure removes only its staging directory and preserves previous prepared releases', async t => {
  const root = fixture(t);
  const first = await prepare(root);
  await assert.rejects(prepare(root, async options => { await build(options); throw new Error('secret /path'); }), code('DEPLOY_BUILD_FAILED'));
  assert.deepEqual(store.validateRelease({ repositoryRoot: root, releaseId: first.releaseId }), first);
  assert.equal(fs.readdirSync(path.join(root, '.jhw-runtime')).some(name => name.startsWith('.stage.')), false);
  unchanged(root);
});

test('source content digest marks dirty inputs and detects source edits during build', async t => {
  const root = fixture(t);
  const clean = await prepare(root);
  write(root, 'mcp-server/src/index.ts', 'export const fixture = 2;\n');
  const dirty = await prepare(root);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.sourceRevision, clean.sourceRevision);
  assert.notEqual(dirty.sourceDigest, clean.sourceDigest);
  assert.notEqual(dirty.releaseId, clean.releaseId);
  await assert.rejects(prepare(root, async options => { await build(options); write(root, 'mcp-server/src/index.ts', 'changed during build'); }), code('DEPLOY_SOURCE_CHANGED'));
});

test('preparation lease contention refuses before invoking build', async t => {
  const root = fixture(t);
  await prepare(root);
  const lease = acquireLease(path.join(root, '.jhw-runtime/deploy.lock'));
  try {
    await assert.rejects(prepare(root, () => assert.fail('build must not run')), code('DEPLOY_LOCK_CONTENDED'));
  } finally { lease.close(); }
});

test('missing credentials are allowed without dereferencing the credential source', async t => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, 'mcp-server/.env'));
  const result = await prepare(root);
  assert.deepEqual(store.validateRelease({ repositoryRoot: root, releaseId: result.releaseId }), result);
});

for (const [name, change] of [
  ['missing executable core', dir => fs.unlinkSync(path.join(dir, 'mcp-server/dist/control/cli.js'))],
  ['missing pinned runtime bundle', dir => fs.unlinkSync(path.join(dir, 'mcp-server/dist/runtime/mcp.cjs'))],
  ['tampered dependency bytes', dir => write(dir, 'mcp-server/node_modules/example/bin.js', 'tampered')],
  ['changed runtime mode', dir => fs.chmodSync(path.join(dir, 'mcp-server/dist/control/cli.js'), 0o644)],
  ['unmanifested artifact', dir => write(dir, 'mcp-server/dist/extra.js')],
  ['external dependency symlink', dir => { fs.unlinkSync(path.join(dir, 'mcp-server/node_modules/.bin/example')); fs.symlinkSync('/etc/passwd', path.join(dir, 'mcp-server/node_modules/.bin/example')); }],
  ['credential link substitution', dir => { fs.unlinkSync(path.join(dir, 'mcp-server/.env')); fs.symlinkSync('/etc/passwd', path.join(dir, 'mcp-server/.env')); }],
  ['hardlinked artifact', dir => fs.linkSync(path.join(dir, 'mcp-server/dist/index.js'), path.join(dir, 'mcp-server/dist/hardlink.js'))],
  ['FIFO artifact', dir => command(dir, 'mkfifo', ['mcp-server/dist/pipe'])],
  ['world writable directory', dir => fs.chmodSync(path.join(dir, 'mcp-server/dist'), 0o777)],
]) {
  test(`release validation refuses ${name}`, async t => {
    const root = fixture(t);
    const release = await prepare(root);
    change(releasePath(root, release));
    assert.throws(() => store.validateRelease({ repositoryRoot: root, releaseId: release.releaseId }), error => error.code?.startsWith('DEPLOY_'));
    unchanged(root);
  });
}

for (const [name, change] of [
  ['unknown key', manifest => { manifest.extra = true; }],
  ['mismatched revision', manifest => { manifest.sourceRevision = 'f'.repeat(40); }],
  ['unsafe entry path', manifest => { manifest.entries[0].path = '../outside'; }],
  ['malformed digest', manifest => { manifest.contentDigest = 'bad'; }],
]) {
  test(`release manifest rejects ${name}`, async t => {
    const root = fixture(t);
    const release = await prepare(root);
    mutateManifest(root, release, change);
    assert.throws(() => store.validateRelease({ repositoryRoot: root, releaseId: release.releaseId }), code('DEPLOY_RELEASE_INVALID'));
  });
}

test('strict IDs refuse traversal before reading arbitrary paths', t => {
  const root = fixture(t);
  assert.equal(typeof store.validateRelease, 'function');
  for (const releaseId of ['../outside', '/tmp', '', 'r-HEAD-anything', null]) {
    assert.throws(() => store.validateRelease({ repositoryRoot: root, releaseId }), code('DEPLOY_RELEASE_INVALID'));
  }
});

test('unsafe source links and special files are rejected before build', async t => {
  const root = fixture(t);
  fs.symlinkSync('/etc/passwd', path.join(root, 'skills/claude/escape.md'));
  await assert.rejects(prepare(root, () => assert.fail('build must not run')), error => error.code?.startsWith('DEPLOY_'));
});

test('foreign symlink store is preserved and rejected', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'foreign'), { mode: 0o700 });
  fs.symlinkSync('foreign', path.join(root, '.jhw-runtime'));
  await assert.rejects(prepare(root), code('DEPLOY_UNTRUSTED_PATH'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'foreign')), []);
});

test('activation history permits exact predecessor rollback and preserves every generation', async t => {
  const root = fixture(t);
  const a = await prepare(root);
  write(root, 'mcp-server/src/index.ts', 'second release\n');
  const b = await prepare(root);
  const original = store.readActivation({ repositoryRoot: root });
  const first = store.publishActivation({ repositoryRoot: root, releaseId: a.releaseId, expectedCurrent: original });
  const second = store.publishActivation({ repositoryRoot: root, releaseId: b.releaseId, expectedCurrent: first });
  assert.equal(second.predecessorActivationId, first.activationId);
  assert.equal(fs.readlinkSync(path.join(root, '.jhw-runtime/current')), `activations/${second.activationId}`);
  assert.equal(fs.readlinkSync(path.join(root, '.jhw-runtime/activations', second.activationId, 'scripts')), `../../releases/${b.releaseId}/scripts`);
  const rolled = store.rollbackActivation({ repositoryRoot: root, expectedCurrent: second });
  assert.equal(rolled.activationId, first.activationId);
  assert.equal(rolled.releaseId, a.releaseId);
  assert.equal(fs.readdirSync(path.join(root, '.jhw-runtime/releases')).length, 2);
  assert.equal(fs.readdirSync(path.join(root, '.jhw-runtime/activations')).length, 2);
  unchanged(root);
});

test('stale activation observation and same-target pointer replacement refuse publication', async t => {
  const root = fixture(t);
  const release = await prepare(root);
  const first = store.publishActivation({ repositoryRoot: root, releaseId: release.releaseId, expectedCurrent: null });
  assert.throws(() => store.publishActivation({ repositoryRoot: root, releaseId: release.releaseId, expectedCurrent: null }), code('DEPLOY_CURRENT_CHANGED'));
  const current = path.join(root, '.jhw-runtime/current');
  fs.symlinkSync(`activations/${first.activationId}`, `${current}.replacement`);
  fs.renameSync(`${current}.replacement`, current);
  assert.throws(() => store.publishActivation({ repositoryRoot: root, releaseId: release.releaseId, expectedCurrent: first }), code('DEPLOY_CURRENT_CHANGED'));
  assert.equal(store.readActivation({ repositoryRoot: root }).activationId, first.activationId);
});

test('malformed predecessor manifest refuses rollback without changing current', async t => {
  const root = fixture(t);
  const release = await prepare(root);
  const first = store.publishActivation({ repositoryRoot: root, releaseId: release.releaseId, expectedCurrent: null });
  const second = store.publishActivation({ repositoryRoot: root, releaseId: release.releaseId, expectedCurrent: first });
  const file = path.join(root, '.jhw-runtime/activations', first.activationId, 'manifest.json');
  fs.writeFileSync(file, '{}');
  assert.throws(() => store.rollbackActivation({ repositoryRoot: root, expectedCurrent: second }), code('DEPLOY_ACTIVATION_INVALID'));
  assert.equal(fs.readlinkSync(path.join(root, '.jhw-runtime/current')), `activations/${second.activationId}`);
});

test('credential source symlink is rejected without following or copying its target', async t => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, 'mcp-server/.env'));
  fs.symlinkSync('../private-config.json', path.join(root, 'mcp-server/.env'));
  await assert.rejects(prepare(root), code('DEPLOY_UNTRUSTED_PATH'));
  unchanged(root);
});

test('replaced stage is preserved on failure without traversing the replacement', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'foreign'), { mode: 0o700 });
  write(root, 'foreign/sentinel', 'keep');
  await assert.rejects(prepare(root, async options => {
    await build(options);
    fs.renameSync(options.stagingRoot, `${options.stagingRoot}.detached`);
    fs.symlinkSync(path.join(root, 'foreign'), options.stagingRoot);
  }), code('DEPLOY_UNTRUSTED_PATH'));
  assert.equal(fs.readFileSync(path.join(root, 'foreign/sentinel'), 'utf8'), 'keep');
});

for (const [name, target] of [['cycle', 'loop.md'], ['excluded source', '../../private-config.json'], ['credential source', '../../mcp-server/.env']]) {
  test(`source symlink ${name} fails before reaching build`, async t => {
    const root = fixture(t);
    fs.symlinkSync(target, path.join(root, 'skills/claude/loop.md'));
    await assert.rejects(prepare(root, () => assert.fail('build must not run')), code('DEPLOY_UNTRUSTED_PATH'));
  });
}

test('generated source subtrees stay out of snapshots and digests without changing their bytes', async t => {
  const root = fixture(t);
  const clean = await prepare(root);
  const excluded = [
    'mcp-server/src/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json',
    'mcp-server/src/dist/cache.js',
    'mcp-server/src/.ai/private.json',
    'skills/.superpowers/private.json',
    'mcp-server/scripts/.git/private.json',
  ];
  for (const name of excluded) write(root, name, 'EXCLUDED_SOURCE_BYTES\n');
  const cached = await prepare(root, async options => {
    for (const name of excluded) assert.equal(fs.existsSync(path.join(options.stagingRoot, name)), false);
    await build(options);
  });
  assert.deepEqual(cached, clean);
  for (const name of excluded) {
    assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'EXCLUDED_SOURCE_BYTES\n');
    assert.equal(fs.existsSync(path.join(releasePath(root, cached), name)), false);
    write(root, name, 'DIFFERENT_EXCLUDED_BYTES\n');
  }
  const changedCache = await prepare(root);
  assert.deepEqual(changedCache, clean);
  const manifest = fs.readFileSync(path.join(releasePath(root, cached), 'manifest.json'), 'utf8');
  for (const name of excluded) assert.equal(manifest.includes(name), false);
  unchanged(root);
});

test('selected source symlink into an excluded generated cache still refuses preparation', async t => {
  const root = fixture(t);
  write(root, 'mcp-server/src/node_modules/.vite/vitest/results.json', 'excluded cache');
  fs.symlinkSync('node_modules/.vite/vitest/results.json', path.join(root, 'mcp-server/src/cache-link.json'));
  await assert.rejects(prepare(root, () => assert.fail('build must not run')), code('DEPLOY_UNTRUSTED_PATH'));
  assert.equal(fs.readFileSync(path.join(root, 'mcp-server/src/node_modules/.vite/vitest/results.json'), 'utf8'), 'excluded cache');
});

test('rollback rejects predecessor release disagreement in recorded prior observation', async t => {
  const root = fixture(t);
  const a = await prepare(root);
  write(root, 'mcp-server/src/index.ts', 'second');
  const b = await prepare(root);
  const first = store.publishActivation({ repositoryRoot: root, releaseId: a.releaseId, expectedCurrent: null });
  const second = store.publishActivation({ repositoryRoot: root, releaseId: b.releaseId, expectedCurrent: first });
  const file = path.join(root, '.jhw-runtime/activations', second.activationId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.priorCurrent.releaseId = b.releaseId;
  fs.writeFileSync(file, `${JSON.stringify(manifest)}\n`);
  assert.throws(() => store.rollbackActivation({ repositoryRoot: root, expectedCurrent: second }), code('DEPLOY_PREDECESSOR_INVALID'));
  assert.equal(fs.readlinkSync(path.join(root, '.jhw-runtime/current')), `activations/${second.activationId}`);
});

test('identical preparation reuses validated release and removes its redundant stage', async t => {
  const root = fixture(t);
  const first = await prepare(root);
  assert.deepEqual(await prepare(root), first);
  assert.equal(fs.readdirSync(path.join(root, '.jhw-runtime/releases')).length, 1);
  assert.equal(fs.readdirSync(path.join(root, '.jhw-runtime')).some(name => name.startsWith('.stage.')), false);
});

test('default npm build and skill generation stay private with safe modes under permissive umask', async t => {
  const root = fixture(t);
  write(root, 'mcp-server/package.json', JSON.stringify({ name: 'store-fixture', version: '1.0.0', type: 'module', scripts: { build: 'node scripts/clean-dist.mjs' } }));
  write(root, 'mcp-server/package-lock.json', JSON.stringify({ name: 'store-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'store-fixture', version: '1.0.0' } } }));
  write(root, 'mcp-server/scripts/clean-dist.mjs', `
    import fs from 'node:fs';
    fs.mkdirSync('dist/control', { recursive: true });
    fs.mkdirSync('node_modules', { recursive: true });
    fs.mkdirSync('node_modules/.bin', { recursive: true });
    fs.writeFileSync('dist/index.js', 'export {};');
    for (const name of ['cli', 'hook-adapter']) fs.writeFileSync('dist/control/' + name + '.js', '#!/usr/bin/env node\\n', { mode: 0o755 });
    fs.writeFileSync('node_modules/.bin/rolldown', '#!/bin/sh\\ninput="$1"\\nshift\\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--file" ]; then output="$2"; shift 2; else shift; fi; done\\ncp -- "$input" "$output"\\n', { mode: 0o755 });
    fs.chmodSync('node_modules/.bin/rolldown', 0o755);
  `);
  write(root, 'scripts/sync-codex-skills.mjs', "import fs from 'node:fs'; fs.mkdirSync(new URL('../skills/generated', import.meta.url)); fs.writeFileSync(new URL('../skills/generated/done', import.meta.url), 'generated');\n");
  const old = process.umask(0);
  let release;
  try { release = await store.prepareRelease({ repositoryRoot: root }); }
  finally { process.umask(old); }
  assert.equal(fs.readFileSync(path.join(releasePath(root, release), 'skills/generated/done'), 'utf8'), 'generated');
  assert.equal(fs.existsSync(path.join(releasePath(root, release), '.build-home')), false);
  unchanged(root);
});


test('preparation retains the source-only wiring library as a bound input', async t => {
  const root = fixture(t);
  write(root, 'scripts/install-wiring.sh', '# source-only fixture\n');
  const result = await prepare(root);
  assert.equal(fs.readFileSync(path.join(releasePath(root, result), 'scripts/install-wiring.sh'), 'utf8'), '# source-only fixture\n');
});
