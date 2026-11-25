import fs from 'node:fs';
import path from 'node:path';

import {runDeployment} from '../runtime-deploy.mjs';
import {acquireLease} from '../runtime-safety.mjs';
import {
  ensureBootstrapGeneration,
  readActivation,
  releaseCompatibility,
} from '../runtime-store.mjs';
import {createRuntimeFixture} from './runtime-v2.mjs';

const fixture = await createRuntimeFixture({after() {}}, {realDependencies: true});
const releaseA = await fixture.prepare();
await runDeployment({
  repositoryRoot: fixture.root,
  home: fixture.home,
  environment: fixture.environment,
  argv: ['--activate', releaseA.releaseId],
});

const origin = readActivation({repositoryRoot: fixture.root});
const runtime = path.join(fixture.root, '.jhw-runtime');
const entry = fs.readFileSync(path.join(fixture.root, 'scripts/runtime-entry.mjs'), 'utf8');
const prepareVariant = (label) => {
  fixture.write('scripts/runtime-entry.mjs', `${entry}\n// Managed acceptance variant ${label}\n`);
  return fixture.prepare();
};
const releaseB = await prepareVariant('B');
const releaseC = await prepareVariant('C');

const compatibility = releaseCompatibility({
  repositoryRoot: fixture.root,
  releaseId: releaseB.releaseId,
});
if (compatibility !== origin.compatibilityDigest) {
  const manifestEntries = (releaseId) => JSON.parse(fs.readFileSync(
    path.join(runtime, 'releases', releaseId, 'manifest.json'),
  )).entries;
  const baseline = new Map(manifestEntries(origin.releaseId).map((row) => [row.path, row]));
  const variant = new Map(manifestEntries(releaseB.releaseId).map((row) => [row.path, row]));
  const changed = [...new Set([...baseline.keys(), ...variant.keys()])]
    .filter((name) => JSON.stringify(baseline.get(name)) !== JSON.stringify(variant.get(name)));
  throw new Error(JSON.stringify({
    compatibility,
    origin: origin.compatibilityDigest,
    changed: changed.slice(0, 25),
  }));
}

const deployLease = acquireLease(path.join(runtime, 'deploy.lock'));
let obsolete;
try {
  obsolete = ensureBootstrapGeneration({
    repositoryRoot: fixture.root,
    releaseId: releaseC.releaseId,
    deployLease,
  });
} finally {
  deployLease.close();
}
const aged = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
fs.utimesSync(path.join(runtime, 'v2', 'bootstraps', obsolete.bootstrapId), aged, aged);
fs.mkdirSync(path.join(runtime, 'v2', 'managed-invocations'), {mode: 0o700});

console.log(JSON.stringify({
  root: fixture.root,
  home: fixture.home,
  origin,
  releaseB: releaseB.releaseId,
  releaseC: releaseC.releaseId,
  bootstrapC: obsolete.bootstrapId,
}));
