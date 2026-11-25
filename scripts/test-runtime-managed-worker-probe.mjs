import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { acquireLease } from './runtime-safety.mjs';
import { ensureBootstrapGeneration } from './runtime-store.mjs';
import { installRouterV2 } from './runtime-entry.mjs';
import { createRuntimeFixture } from './test-support/runtime-v2.mjs';

const probe = path.join(import.meta.dirname, 'runtime-managed-worker-probe.mjs');

async function preparedFixture(t) {
  const fixture = await createRuntimeFixture(t, {productionEntry: true});
  const release = await fixture.prepare();
  const runtime = path.join(fixture.root, '.jhw-runtime');
  const deploy = acquireLease(path.join(runtime, 'deploy.lock'));
  let admission;
  let pair;
  try {
    admission = acquireLease(path.join(runtime, 'admission.lock'), {create: true});
    pair = ensureBootstrapGeneration({repositoryRoot: fixture.root, releaseId: release.releaseId, deployLease: deploy});
    await installRouterV2({repositoryRoot: fixture.root, releaseId: release.releaseId, deployLease: deploy, admissionLease: admission});
  } finally {
    admission?.close();
    deploy.close();
  }
  fixture.seedPair(pair);
  return {fixture, pair};
}

test('probe emits the bound pair and verified artifact with a bounded frame', async t => {
  const {fixture, pair} = await preparedFixture(t);
  const program = `
    import {spawnSync} from 'node:child_process';
    const result=spawnSync(process.execPath,[${JSON.stringify(probe)},'artifact',process.argv[1],'mcp'],{
      env:process.env,stdio:['ignore','pipe','pipe',3,'ignore','ignore',6,7],maxBuffer:20*1024*1024});
    if(result.status!==0)process.stderr.write(result.stderr);
    else process.stdout.write(result.stdout);
    process.exit(result.status??1);
  `;
  const result = await fixture.run([
    'jhw-runtime-entry', 'session', '--', process.execPath, '--input-type=module', '-e', program, fixture.root,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const newline = result.stdout.indexOf('\n');
  assert.ok(newline > 0);
  const header = JSON.parse(result.stdout.slice(0, newline));
  const artifact = Buffer.from(result.stdout.slice(newline + 1));
  assert.deepEqual(header, {
    version: 1,
    releaseId: pair.releaseId,
    bootstrapId: pair.bootstrapId,
    bytes: artifact.length,
    sha256: createHash('sha256').update(artifact).digest('hex'),
    sessionId: header.sessionId,
  });
  assert.match(header.sha256, /^[a-f0-9]{64}$/);
  assert.match(header.sessionId, /^s-[a-f0-9]{32}$/);
  assert.match(result.stdout.slice(newline + 1, newline + 257), /fdEvidence/);
});

test('probe rejects a selector outside the fixed artifact set', async t => {
  const {fixture} = await preparedFixture(t);
  const result = await fixture.run([
    'jhw-runtime-entry', 'session', '--', process.execPath, probe, 'artifact', fixture.root, '../credential',
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});
