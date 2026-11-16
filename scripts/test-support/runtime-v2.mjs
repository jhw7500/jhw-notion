import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';

import {prepareRelease, releaseCompatibility} from '../runtime-store.mjs';

const source = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function git(root, ...args) {
  const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}

export async function createRuntimeFixture(t, {realDependencies = false, legacyRevision = null} = {}) {
  if (legacyRevision !== null) throw new Error('legacyRevision is not used by Task 2 fixtures');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jhw-runtime-v2-fixture-'));
  const home = path.join(root, 'home');
  const procRoot = '/proc';
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(home, {mode: 0o700});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  const write = (relative, bytes, mode = 0o644) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o755});
    fs.writeFileSync(target, bytes, {mode});
    fs.chmodSync(target, mode);
    return target;
  };
  for (const [name, bytes] of Object.entries({
    '.gitignore': '.jhw-runtime/\n',
    'mcp-server/package.json': '{"type":"module"}\n',
    'mcp-server/package-lock.json': '{"lockfileVersion":3}\n',
    'mcp-server/tsconfig.json': '{}\n',
    'mcp-server/tsconfig.test.json': '{}\n',
    'mcp-server/src/index.ts': 'export {};\n',
    'mcp-server/src/server.ts': 'export {};\n',
    'mcp-server/src/tools/read.ts': 'export {};\n',
    'mcp-server/src/control/runtime-compatibility.json': '{"version":1,"generation":2,"guardFloor":1}\n',
    'mcp-server/src/control/hook-adapter.ts': 'export {};\n',
    'mcp-server/scripts/clean-dist.mjs': '',
    'scripts/sync-codex-skills.mjs': '',
    'scripts/runtime-deploy.mjs': 'export {};\n',
    'skills/claude/task.md': 'fixture\n',
  })) write(name, bytes);
  for (const name of ['jhw-runtime-entry', 'jhw-runtime-control', 'jhw-runtime-hook', 'runtime-safety.mjs']) {
    write(`scripts/${name}`, fs.readFileSync(path.join(source, name)), name.startsWith('jhw-') ? 0o755 : 0o644);
  }
  write('scripts/runtime-store.mjs', 'export const fixtureStore = true;\n');
  write('scripts/runtime-entry.mjs', `
export async function runManaged({selector, args, selectedPair}) {
  if (!selectedPair || selectedPair.runtimeContract !== 2) return {retryCurrent:true};
  process.stdout.write(JSON.stringify({selector,args,selectedPair,artifact:'generation-a'})+'\\n');
  return 0;
}
`);
  write('scripts/jhw-control-hook', '#!/bin/sh\nexit 0\n', 0o755);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');

  const prepare = () => prepareRelease({repositoryRoot: root, build: async ({stagingRoot}) => {
    const built = (name, bytes = '') => {
      const target = path.join(stagingRoot, name);
      fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o755});
      fs.writeFileSync(target, bytes, {mode: name.includes('/control/') || name.endsWith('/control.cjs') || name.endsWith('/hook.cjs') ? 0o755 : 0o644});
    };
    built('mcp-server/dist/index.js');
    built('mcp-server/dist/control/cli.js');
    built('mcp-server/dist/control/hook-adapter.js');
    built('mcp-server/dist/runtime/mcp.cjs');
    built('mcp-server/dist/runtime/control.cjs');
    built('mcp-server/dist/runtime/hook.cjs');
    fs.mkdirSync(path.join(stagingRoot, 'mcp-server/node_modules'), {recursive:true, mode:0o755});
    if (realDependencies) built('mcp-server/node_modules/example/index.js', 'dependency');
  }});

  const seedPair = pair => {
    const activationId = `a-${randomBytes(16).toString('hex')}`;
    const activation = path.join(root, '.jhw-runtime/v2/activations', activationId);
    fs.mkdirSync(activation, {recursive: true, mode: 0o700});
    for (const directory of [path.join(root, '.jhw-runtime/v2'), path.dirname(activation), activation]) fs.chmodSync(directory, 0o700);
    for (const name of ['mcp-server', 'scripts', 'skills']) fs.symlinkSync(`../../../releases/${pair.releaseId}/${name}`, path.join(activation, name));
    fs.symlinkSync(`../../bootstraps/${pair.bootstrapId}`, path.join(activation, 'bootstrap'));
    const manifest = {version:2,activationId,...pair,predecessorActivationId:null,migrationId:null,createdAt:new Date().toISOString(),priorCurrent:null};
    fs.writeFileSync(path.join(activation, 'manifest.json'), JSON.stringify(manifest) + '\n', {mode:0o600});
    fs.chmodSync(path.join(activation, 'manifest.json'), 0o600);
    const current = path.join(root, '.jhw-runtime/current');
    fs.rmSync(current, {force:true});
    fs.symlinkSync(`v2/activations/${activationId}`, current);
    return {version:2,activationId,...pair,predecessorActivationId:null,migrationId:null};
  };

  const run = argv => spawnSync(path.join(root, '.jhw-runtime/bootstrap', argv[0]), argv.slice(1), {encoding:'utf8', timeout:12000});
  return {root, home, procRoot, entry:path.join(root, '.jhw-runtime/bootstrap/jhw-runtime-entry'), write, prepare, run, seedPair,
    compatibility(releaseId) { return releaseCompatibility({repositoryRoot:root, releaseId}); }};
}
