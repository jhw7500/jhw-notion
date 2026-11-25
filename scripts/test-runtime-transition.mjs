import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import * as store from './runtime-store.mjs';
import {acquireLease,prepareAtomicRename} from './runtime-safety.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

async function fixture(t,{origin=false}={}) {
 const f=await createRuntimeFixture(t);const release=await f.prepare();
 const runtimePath=path.join(f.root,'.jhw-runtime');
 const writer=acquireLease(path.join(runtimePath,'deploy.lock'));t.after(()=>writer.close());
 const pair=store.ensureBootstrapGeneration({repositoryRoot:f.root,releaseId:release.releaseId,deployLease:writer});
 let before=null;
 if(origin){const first=store.preparePairActivation({repositoryRoot:f.root,pair,expectedCurrent:null,deployLease:writer});
  const evidence=store.prepareRuntimeEvidence({repositoryRoot:f.root,pairs:[pair]});const lease=acquireLease(path.join(runtimePath,'publication.lock'),{create:true});
  try{before=store.publishPreparedActivation({repositoryRoot:f.root,destination:first,expectedCurrent:null,evidence,publicationLease:lease});}finally{lease.close();evidence.close();}}
 const destination=store.preparePairActivation({repositoryRoot:f.root,pair,expectedCurrent:before,deployLease:writer});
 const journal=path.join(runtimePath,'v2/journals',`d-${'3'.repeat(32)}`);fs.mkdirSync(journal,{recursive:true,mode:0o700});
 const fd=fs.openSync(runtimePath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);const stat=fs.fstatSync(fd);
 const runtimeHandle={fd,verify(){const current=fs.lstatSync(runtimePath);assert.equal(current.ino,stat.ino);assert.equal(current.dev,stat.dev);}};
 t.after(()=>fs.closeSync(fd));const capability=prepareAtomicRename({directory:runtimeHandle});
 const args={repositoryRoot:f.root,journalDirectory:journal,origin:before,destination,deployLease:writer};
 const witness=store.prepareTransitionPointer(args);
 return {f,journal,args:{...args,witness},runtimePath,runtimeHandle,capability,before};
}

for(const origin of [false,true])test(`transition ${origin?'exchange':'noreplace'} retains verifiable publication across restart`,async t=>{
 const s=await fixture(t,{origin});assert.equal(store.inspectTransitionPointer(s.args).location,'origin');
 const publicationLease=acquireLease(path.join(s.runtimePath,'publication.lock'),{create:true});
 try{store.publishTransitionPointer({...s.args,publicationLease,capability:s.capability,runtimeHandle:s.runtimeHandle});}finally{publicationLease.close();}
 const observed=store.inspectTransitionPointer(JSON.parse(JSON.stringify({...s.args,deployLease:undefined})));
 assert.equal(observed.location,'destination');assert.equal(observed.current.activationId,s.args.destination.activationId);
 if(origin)assert.equal(fs.readlinkSync(path.join(s.journal,'pointer-witness/slot')),s.before.observation.target);
 else assert.equal(fs.existsSync(path.join(s.journal,'pointer-witness/slot')),false);
});

test('transition EXCHANGE retains a foreign current that arrives at the syscall boundary',async t=>{
 const s=await fixture(t,{origin:true});let foreign;
 const publicationLease=acquireLease(path.join(s.runtimePath,'publication.lock'),{create:true});
 try{assert.throws(()=>store.publishTransitionPointer({...s.args,publicationLease,capability:s.capability,runtimeHandle:s.runtimeHandle,
  observe(event){if(event==='before_atomic_pointer'){fs.unlinkSync(path.join(s.runtimePath,'current'));fs.symlinkSync('foreign-owned',path.join(s.runtimePath,'current'));foreign=fs.lstatSync(path.join(s.runtimePath,'current'));}}
 }),{code:'DEPLOY_CURRENT_CHANGED'});}finally{publicationLease.close();}
 const retained=path.join(s.journal,'pointer-witness/slot');assert.equal(fs.lstatSync(retained).ino,foreign.ino);assert.equal(fs.readlinkSync(retained),'foreign-owned');
 assert.throws(()=>store.inspectTransitionPointer(s.args),{code:'DEPLOY_CURRENT_CHANGED'});
});

test('transition NOREPLACE preserves a foreign initially absent current',async t=>{
 const s=await fixture(t);let foreign;
 const publicationLease=acquireLease(path.join(s.runtimePath,'publication.lock'),{create:true});
 try{assert.throws(()=>store.publishTransitionPointer({...s.args,publicationLease,capability:s.capability,runtimeHandle:s.runtimeHandle,
  observe(event){if(event==='before_atomic_pointer'){fs.mkdirSync(path.join(s.runtimePath,'current'),{mode:0o700});foreign=fs.lstatSync(path.join(s.runtimePath,'current'));}}
 }),{code:'DEPLOY_ATOMIC_DESTINATION_EXISTS'});}finally{publicationLease.close();}
 assert.equal(fs.lstatSync(path.join(s.runtimePath,'current')).ino,foreign.ino);
 assert.equal(fs.readlinkSync(path.join(s.journal,'pointer-witness/slot')),s.args.witness.pointer.target);
});
