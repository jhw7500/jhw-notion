import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';

const runner = new URL('./runtime-managed-invocation.cjs', import.meta.url).pathname;
const releaseRoot = '/srv/jhw/.jhw-runtime/releases/r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const keylessBanner = '// jhw-managed-notion-relay: 1\n';

async function invoke(t, source, {selector = 'control', args = [], digest, size, root = releaseRoot, descriptor = 3} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-managed-invocation-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const artifact = path.join(directory, 'artifact.cjs');
  fs.writeFileSync(artifact, source, {mode: 0o600});
  const bytes = fs.readFileSync(artifact);
  const fd = fs.openSync(artifact, 'r');
  const child = spawn(process.execPath, [
    runner,
    String(descriptor),
    digest ?? createHash('sha256').update(bytes).digest('hex'),
    String(size ?? bytes.length),
    root,
    '/usr/bin/python3',
    '/etc/jhw-managed.json',
    selector,
    ...args,
  ], {
    stdio: ['pipe', 'pipe', 'pipe', ...Array.from({length: descriptor - 3}, () => 'ignore'), fd],
  });
  fs.closeSync(fd);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end('managed-input');
  const result = await new Promise(resolve => child.once('close', (status, signal) => resolve({status, signal})));
  return {...result, stdout, stderr, pid: child.pid};
}

test('validated artifact executes in the authenticated process with the original main contract', async t => {
  const source = String.raw`
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let artifactFdRetained = false;
  try { artifactFdRetained = fs.readlinkSync('/proc/self/fd/3').includes('artifact.cjs'); } catch {}
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    argv: process.argv.slice(2),
    input,
    artifactFdRetained,
    releaseRoot: globalThis.__JHW_MANAGED_RELEASE_ROOT__,
  }) + '\n');
}
if (fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)) void main();
`;
  const result = await invoke(t, source, {args: ['guard', 'status']});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), {
    pid: result.pid,
    argv: ['guard', 'status'],
    input: 'managed-input',
    artifactFdRetained: false,
    releaseRoot,
  });
});

test('mcp, control, and hook are the only accepted selectors', async t => {
  const source = `process.stdout.write('loaded\\n');`;
  for (const selector of ['mcp', 'control', 'hook']) {
    const bundle = selector === 'mcp' ? keylessBanner + source : source;
    const result = await invoke(t, bundle, {selector});
    assert.equal(result.status, 0, `${selector}: ${result.stderr}`);
    assert.equal(result.stdout, 'loaded\n');
  }
  const rejected = await invoke(t, source, {selector: 'credential'});
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /DEPLOY_RUNTIME_BINDING_INVALID/u);
});

test('managed MCP and control preflight reject bundles predating the keyless client', async t => {
  for (const options of [{selector: 'mcp'}, {selector: 'control', args: ['preflight']}]) {
    const result = await invoke(t, "process.stdout.write('old credential path');", options);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /DEPLOY_RUNTIME_BINDING_INVALID/u);
  }
});

test('only managed MCP and control preflight get an immutable Notion relay', async t => {
  const source = `
const relay = Object.getOwnPropertyDescriptor(globalThis, '__JHW_MANAGED_NOTION_RELAY__');
process.stdout.write(JSON.stringify(relay
  ? [typeof relay.value, relay.writable, relay.configurable, relay.enumerable]
  : null));
`;
  const calls = [
    {selector: 'mcp', args: [], eligible: true},
    {selector: 'control', args: ['preflight'], eligible: true},
    {selector: 'control', args: ['guard', 'status'], eligible: false},
    {selector: 'hook', args: [], eligible: false},
  ];
  for (const {selector, args, eligible} of calls) {
    const result = await invoke(t, `#!/usr/bin/env node\n${keylessBanner}${source}`, {selector, args});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), eligible ? ['function', false, false, false] : null);
  }
});

test('multi-digit inherited descriptors are accepted', async t => {
  const result = await invoke(t, `process.stdout.write('loaded\\n');`, {descriptor: 10});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'loaded\n');
});

test('release root is validated structurally without reading it', async t => {
  const source = `process.stdout.write(globalThis.__JHW_MANAGED_RELEASE_ROOT__ + '\\n');`;
  const result = await invoke(t, source, {root: releaseRoot});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${releaseRoot}\n`);

  for (const root of [
    '/srv/jhw/releases/r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '/srv/jhw/.jhw-runtime/releases/not-a-release',
    '/srv/jhw/.jhw-runtime/releases/r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/child',
    'relative/.jhw-runtime/releases/r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]) {
    const rejected = await invoke(t, source, {root});
    assert.equal(rejected.status, 1, root);
    assert.equal(rejected.stdout, '');
  }
});

test('artifact size and sha256 are revalidated before execution', async t => {
  const source = `process.stdout.write('must-not-run\\n');`;
  for (const options of [
    {digest: '0'.repeat(64)},
    {size: Buffer.byteLength(source) + 1},
    {size: 0},
    {size: 16 * 1024 * 1024 + 1},
  ]) {
    const result = await invoke(t, source, options);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /DEPLOY_RUNTIME_BINDING_INVALID/u);
  }
});

test('bundle cannot fall back to filesystem modules', async t => {
  const source = `require('./neighbor.cjs'); process.stdout.write('must-not-run\\n');`;
  const result = await invoke(t, source);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /DEPLOY_EXTERNAL_MODULE_FORBIDDEN/u);
});
