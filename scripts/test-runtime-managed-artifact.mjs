import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { installRouterV2 } from './runtime-entry.mjs';
import { acquireLease } from './runtime-safety.mjs';
import { ensureBootstrapGeneration } from './runtime-store.mjs';
import { openBoundRuntimeBundle } from './runtime-managed-artifact.mjs';
import { createRuntimeFixture } from './test-support/runtime-v2.mjs';

test('service runner keeps a verified bundle on its own live pair', async t => {
  const fixture = await createRuntimeFixture(t, {productionEntry: true});
  const repositoryRoot = fixture.root;
  const release = await fixture.prepare();
  const runtime = path.join(repositoryRoot, '.jhw-runtime');
  const deploy = acquireLease(path.join(runtime, 'deploy.lock'));
  let admission;
  let pair;
  try {
    admission = acquireLease(path.join(runtime, 'admission.lock'), {create: true});
    pair = ensureBootstrapGeneration({repositoryRoot, releaseId: release.releaseId, deployLease: deploy});
    await installRouterV2({repositoryRoot, releaseId: release.releaseId, deployLease: deploy, admissionLease: admission});
  } finally {
    admission?.close();
    deploy.close();
  }
  fixture.seedPair(pair);
  assert.throws(() => openBoundRuntimeBundle({repositoryRoot, selector: 'mcp'}), {code: 'DEPLOY_SESSION_INVALID'});

  const moduleUrl = new URL('./runtime-managed-artifact.mjs', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {openBoundRuntimeBundle} from ${JSON.stringify(moduleUrl)};
    const repositoryRoot = process.argv[1];
    assert.throws(() => openBoundRuntimeBundle({repositoryRoot, selector: 'mcp-server/.env'}),
      {code: 'DEPLOY_SELECTOR_INVALID'});
    const bundle = openBoundRuntimeBundle({repositoryRoot, selector: 'mcp'});
    try {
      bundle.verify();
      const prefix = Buffer.alloc(256);
      const bytes = fs.readSync(bundle.fd, prefix, 0, prefix.length, null);
      assert.match(prefix.subarray(0, bytes).toString(), /fdEvidence/);
      console.log(JSON.stringify({releaseId: bundle.releaseId, bootstrapId: bundle.bootstrapId}));
    } finally {
      bundle.close();
    }
    assert.throws(() => fs.fstatSync(bundle.fd), {code: 'EBADF'});
  `;
  const result = await fixture.run([
    'jhw-runtime-entry', 'session', '--', process.execPath, '--input-type=module', '-e', program, repositoryRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {releaseId: pair.releaseId, bootstrapId: pair.bootstrapId});
  assert.equal(fs.existsSync(path.join(runtime, 'v2', 'bootstraps', pair.bootstrapId, 'lease')), true);
});
