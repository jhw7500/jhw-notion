import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

import {readRuntimeJournalV2} from './runtime-prune.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

const release=`r-${'1'.repeat(40)}-${'2'.repeat(64)}`;
const activation=value=>`a-${value.repeat(32)}`;
const observation=(id,ino)=>({target:`activations/${id}`,dev:'1',ino:String(ino),ctimeNs:String(ino)});

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jhw-bootstrap-migration-'));
  fs.chmodSync(root,0o700);
  const journal=path.join(root,'.jhw-runtime/v2/journals',`d-${'4'.repeat(32)}`);
  fs.mkdirSync(journal,{recursive:true,mode:0o700});
  for(const directory of [path.join(root,'.jhw-runtime'),path.join(root,'.jhw-runtime/v2'),path.dirname(journal),journal])fs.chmodSync(directory,0o700);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,journal};
}

test('bootstrap migration reader rejects the former unbound anchor schema',t=>{
  const {root,journal}=fixture(t);
  const legacyRollbackTarget={activationId:activation('a'),releaseId:release,predecessorActivationId:null,observation:observation(activation('a'),10)};
  const origin={activationId:activation('b'),releaseId:release,predecessorActivationId:legacyRollbackTarget.activationId,observation:observation(activation('b'),11)};
  const state={version:2,kind:'bootstrap-migration',status:'pending',phase:'prepared',migrationId:`m-${'3'.repeat(32)}`,
    anchor:`m-${'3'.repeat(32)}`,origin,legacyRollbackTarget,destination:null,witness:null,
    router:{sourceReleaseId:release,routerContract:1,previousDirectory:null},outcome:null};
  fs.writeFileSync(path.join(journal,'state.json'),JSON.stringify(state)+'\n',{mode:0o600});
  fs.chmodSync(path.join(journal,'state.json'),0o600);
  assert.throws(()=>readRuntimeJournalV2({repositoryRoot:root,journalDirectory:journal}),{code:'DEPLOY_PRUNE_BLOCKED'});
});

test('local baseline retained v1 reader and worker both execute with observed exits',async t=>{
  const baseline='75a50711661b547d303f53000d699a683785fa4d';
  const f=await createRuntimeFixture(t,{legacyRevision:baseline});
  assert.equal(f.baselineRevision,baseline);
  const runtime=path.join(f.root,'.jhw-runtime');fs.mkdirSync(runtime,{mode:0o700});fs.chmodSync(runtime,0o700);
  const reader=spawnSync(process.execPath,['--input-type=module','-e',
    `const m=await import(${JSON.stringify(pathToFileURL(path.join(f.root,'scripts/runtime-prune.mjs')).href)});const p=m.planRuntimePrune({repositoryRoot:${JSON.stringify(f.root)}});process.stdout.write(p.code+'\\n');`],
    {encoding:'utf8',env:{...process.env,HOME:f.home},timeout:12000});
  assert.equal(reader.status,0,reader.stderr);assert.equal(reader.stdout,'DEPLOY_PRUNE_PLAN\n');
  const worker=spawnSync('/bin/bash',['-c','set -euo pipefail; source "$1"; initialize_wiring_directories; declare -F verify_wiring >/dev/null','baseline-worker',path.join(f.root,'scripts/install-wiring.sh')],
    {encoding:'utf8',env:{...process.env,HOME:f.home,SCRIPT_DIR:f.root,CONFIG_EDITOR:path.join(f.root,'scripts/install-config.mjs')},timeout:12000});
  assert.equal(worker.status,0,worker.stderr);
});
