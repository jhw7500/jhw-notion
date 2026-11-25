# Bootstrap Generations #261 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** helper가 다른 새 release를 게시·rollback해도 기존 bound 호출을 유지하고, bootstrap 복사본 회수와 Codex binding 전달을 안전하게 처리한다.

**Architecture:** stable router가 검증한 release/bootstrap pair를 세션에 고정한다. v1 객체를 보존하는 별도 v2 namespace에서 세대 lease, root/invocation index, 짧은 publication을 사용한다. 최초 전환과 Codex 설정 이행은 명시적 정지 경로이며, 기존 안전한 파일·복구 증거를 재사용한다.

**Tech Stack:** Node.js 22+, JavaScript ESM/CJS, Linux `/proc/self/fd`·`flock`, 기존 TypeScript/Vitest와 `node:test`. 새 의존성 없음.

**Spec:** [승인된 상세 설계](../specs/2026-11-16-bootstrap-generations-261-design.md). 2026-11-16 사용자 승인. 기준 main `75a50711661b547d303f53000d699a683785fa4d`, 설계 커밋 `63faedcdef64669bee4aaf210799c4db1018cf7a`.

## Global Constraints

- runtimeContract=2, routerContract=1. 기존 선언 shape `{version:1,generation,guardFloor}`를 유지하고 generation=2, guardFloor=1을 사용한다.
- v1 fingerprint 계산과 닫힌 형식은 보존한다. v2 fingerprint envelope는 version=3이며 세대별 `runtime-entry.mjs`, `runtime-safety.mjs`, `runtime-store.mjs` 세 파일의 내용만 추가로 유연하게 취급한다.
- stable selector/router, deploy/prune/wiring, 의존성·mode·경로·symlink 및 기존 보호 영속 계약은 계속 보호한다. v1↔v2 compatible 전환은 거부한다.
- bootstrapId는 `b-` + canonical manifest에서 자기 ID를 뺀 SHA-256이다. sourceReleaseId를 바꿔 같은 세대로 가장하지 않는다. catalog와 이행 anchor는 이번 작업에서 삭제하지 않는다.
- v2 snapshot/activation/record/token의 필드와 ID 문법은 설계 4절을 그대로 따른다. v1에 새 필드를 붙이지 않는다.
- FD 3=admission, 5=credential, 6=own binding, 7=generation, 8=parent root. `close()`는 LOCK_UN으로 상속 lease를 풀지 않는다.
- index 대기 500ms, 새 root의 publication 대기 500ms, current 재선택 최대 3회, 게시 전 검사 예산 1초. bound invocation은 publication을 획득하지 않는다.
- 외부 hook deadline은 일반 12초/SessionEnd 3초다. 시작부터 종료까지 측정하고 거부 0건을 수락 기준으로 삼는다.
- release/activation 전체 GC, secure host/SSH binding 연동, Task/Claim/Registry cutover는 범위 밖이다. control 시험은 비변경 managed direct entry만 사용한다.
- source·private config·credential을 로그에 노출하지 않는다. 문서·커밋에 실제 HOME, Task/Claim ID를 넣지 않는다.
- 모든 코드는 기존 Task worktree에서 작성한다. 소스 변경 중 테스트를 돌리지 않고, 각 commit은 CEC v1 한국어 메시지와 실제 검증 증거를 사용한다.
- push·PR·merge·live 배포·기존 실행 프로세스 종료는 별도 승인 대상이다. 격리 fixture 밖에서 activate/refresh/migration/prune apply를 실행하지 않는다.
- 관련 구현을 모두 병합한 뒤 한 번 배포한다. 그 뒤 #253 item12의 image-only UserPromptSubmit을 확인한다.

## Review Focus

1. 검증 직후 설정을 바꾸거나 old FD로 쓰는 외부 editor: foreign bytes를 덮거나 지우지 않는다. Task 7의 raced capture/reoccupation/open-FD 시험으로 고정한다.
2. 자식 payload보다 먼저 끝난 wrapper: FD 8이 root와 세대를 보존하고 죽은 owner의 token으로 새 호출은 거부한다. Task 3의 parent-first exit 시험으로 고정한다.
3. router 선택 직후 current가 바뀌는 새 세션: 새 helper로 전체 선택을 다시 하고 한 호출에서 세대를 섞지 않는다. Task 2·3의 reselect 시험으로 고정한다.
4. helper가 같아 세대를 재사용한 뒤 복사본이 회수된 역사적 rollback: 원래 catalog source로 같은 bootstrapId를 재구성한다. Task 5·9의 reuse/prune/rollback 시험으로 고정한다.
5. 최초 전환 중 config만 성공하거나 새 consumer가 validation 사이에 시작한 경우: additive env를 보존하고 정지 확인 없이 복구를 강행하지 않는다. Task 8의 단계별 중단 시험으로 고정한다.

---

## 파일과 구현 경계

기존 큰 runtime 파일을 일괄 분리하지 않는다. 세대에 복사하는 세 mjs 밖에 새 production helper를 추가하지 않는다.

| 파일 | 책임 |
|---|---|
| `scripts/runtime-store.mjs` | v1/v2 판독, pair·catalog·activation, 준비 증거, binding·retirement |
| `scripts/runtime-entry.mjs` | bootstrap 설치/검증, 관리형 진입, FD 전달, 검증한 bytes 실행 |
| `scripts/runtime-safety.mjs` | 기존 no-follow·lease·inventory 증명 유지, 필요한 제한 대기 |
| `scripts/jhw-runtime-entry` | built-in만 사용하는 stable verifier, legacy/v2 선택과 helper bytes import |
| `scripts/jhw-runtime-control`, `scripts/jhw-runtime-hook` | 기존 직접/Node 실행 벡터 유지, 고정 FD 전달 |
| `scripts/runtime-deploy.mjs` | v2 journal, compatible 게시·rollback, 초기 이행, 명시적 Codex migration |
| `scripts/runtime-prune.mjs`, `scripts/runtime-guard.mjs` | 공용 snapshot union, 정확한 journal 분류·보존·삭제와 Guard 증거 |
| `scripts/install-config.mjs`, `scripts/install-wiring.sh` | Codex env 보존, 엄격한 완료 검증, 한 파일 transaction worker |
| `mcp-server/src/control/runtime-compatibility.json`와 `__tests__/persistent-contract.test.ts` | 선언 generation과 실제 영속 writer/reader golden |
| `scripts/test-support/runtime-v2.mjs` (신규) | 여러 시험이 쓰는 격리 fixture, IPC barrier, 부모/자식 수명 추적. 제품 코드에 import하지 않는다 |
| `scripts/test-runtime-v2-{store,entry,sessions,publication,migration,prune,integration}.mjs` (신규) | 해당 v2 책임의 시험. 기존 v1 시험은 그대로 회귀 게이트로 남긴다 |
| `scripts/test-runtime-codex-migration.mjs` (신규) | 실제 whitelist와 한 파일 migration/crash 시험 |
| `scripts/__fixtures__/runtime-v2/contracts.json` (신규) | pair/snapshot/record/token/FD/lock의 검토 가능한 고정 계약 벡터 |
| `README.md`, `DESIGN.md` | 실제 구현의 명령·중단 경계·측정 결과·지원 범위 |

순서는 Task 1→2→3→4→5→6→7→8→9→10이다. 겹치는 production 파일이 많으므로 구현 task는 순차 수행한다.
fresh reviewer가 거부하면 그 task 범위에서 수정·재검증한다. 같은 불변식의 리뷰 누락이 반복되면 설계 분기를 사용자에게 올린다.

## 공통 타입·시험 계약

아래 이름은 계획에서 정하는 내부 JS/JSDoc 계약이다. 새로운 public API/환경 우회 옵션이 아니다.

- `RuntimePair = {releaseId:string, bootstrapId:string, runtimeContract:2, compatibilityDigest:string}`.
- `CurrentSnapshot = V1Snapshot | V2Snapshot`; 정확한 키/nullable `priorCurrent`는 설계 4절이다. `Lease={fd:number,close():void}`는 기존 계약을 유지한다.
- `PreparedRuntimeEvidence`는 Task 4에서만 만드는 process-local 불투명 handle이다. 디렉터리 FD와 전체 metadata를 보유하고 `close():void`를 제공한다. 닫힌/다른 repo의 handle은 사용할 수 없다.
- `BindingV2={id:string,token:string,record:object,lease:Lease,generationLease:Lease,parentLease:Lease|null,close():void}`. record는 설계대로 닫힌 형식으로 정의한다.
- `ManagedResult = number | {retryCurrent:true}`. legacy는 number만 반환한다. 재선택 결과는 router 내부에서만 소비하고 CLI stdout이나 hook 응답에 출력하지 않는다.
- `createRuntimeFixture(t,{realDependencies=false,legacyRevision=null}={}) -> Promise<Fixture>`를 Task 2의 시험 지원 파일에서 만든다. `Fixture`는 `root,home,procRoot,entry`, `write(relative,bytes,mode=0o644)`, `prepare():Promise<ReleaseSummary>`, `run(argv):Promise<DeploymentResult>`, `seedPair(pair:RuntimePair):V2Snapshot`을 제공한다. 기본 build는 기존 coexist/deploy fixture 패턴, realDependencies는 Task 10의 실제 build 경로다. seedPair는 Task 3 단위 시험용 초기 자료만 만들고 Task 5 이후 통합 전환은 production 게시 API를 사용한다.
- 기존 fixture 함수를 무리하게 공용화하지 않는다. 신규 지원 파일은 private HOME·0700 root·고정 mode·등록된 자식 프로세스의 정상 종료만 관리한다. legacyRevision은 로컬 git의 검증된 baseline archive를 사용하며 누락을 skip으로 숨기지 않는다.
- 본문의 짧은 assert 예는 이름과 필수 관측을 고정한다. 실행 가능한 test에는 위 fixture 또는 해당 task의 명시된 입력을 만든 뒤 같은 assertion을 넣는다.
- RED는 새 행동의 assertion 실패여야 한다. fixture 설치/권한/import 실패는 행동의 RED로 인정하지 않는다.
- 각 task의 마지막 commit 전 `rtk proxy git diff --check`와 지정 시험을 실행한다. `jhw-commit`으로 메시지를 검증한 후 해당 파일만 stage하고 `git commit --cleanup=verbatim --file <private-message>`를 사용한다. 테스트 수·skip·실제 exit code를 기록한다.

### Task 1: 닫힌 v2 형식과 호환성 경계

**Files:** Modify `scripts/runtime-store.mjs`의 observation/activationIn/currentIn/validCurrent/isActivationSnapshot/compatibilityEntry/releaseCompatibilityIn, `scripts/runtime-guard.mjs`, `scripts/runtime-prune.mjs`의 snapshot 판독, `mcp-server/src/control/runtime-compatibility.json`, `mcp-server/src/control/__tests__/persistent-contract.test.ts`. Create `scripts/test-runtime-v2-store.mjs`, `scripts/__fixtures__/runtime-v2/contracts.json`, `mcp-server/src/control/__tests__/__fixtures__/persistent-contract/generation-2/manifest.json`.

**Interfaces:** 기존 `validCurrent(value):boolean`, `isActivationSnapshot(value):boolean`, `releaseCompatibility({repositoryRoot,releaseId}):string`를 유지한다. 새 `validRuntimePair(value):boolean`과 내부 v2 manifest/record validator를 `runtime-store.mjs`에 둔다. 다른 모듈은 공용 snapshot parser를 import한다.

- [ ] **1. 형식·지문 회귀 시험을 작성한다.** `v2 contract rejects mixed snapshots and preserves v1`에서 v1에 version을 추가하면 false, v2에서 migrationId를 빼면 false, 최초 migration의 priorCurrent=null을 허용하고 v1 priorCurrent를 거부한다. helper-only 내용 변경은 generation2에서만 같은 지문, router/deploy/의존성/mode 변경은 다른 지문이다.

  ```js
  assert.equal(validCurrent(v1), true);
  assert.equal(validCurrent({...v1, version: 1}), false);
  assert.equal(validCurrent(v2), true);
  assert.equal(validCurrent({...v2, unexpected: true}), false);
  assert.notEqual(fingerprintGeneration1, fingerprintGeneration2);
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-store.mjs`; v2 snapshot/지문 assertion이 실패해야 한다.
- [ ] **3. 형식 판독과 지문을 구현한다.** 설계 4절의 exact key를 검사하고 v1 계산은 그대로 둔다. 내부 v1/v2 전용 validator를 분리해 v1 activation의 priorCurrent가 공개 union 때문에 v2로 넓어지지 않게 한다. generation1 corpus를 수정하지 않고 generation2 manifest가 기존 Control writer/reader 벡터를 참조하도록 시험을 매개화한다. runtime v2 벡터는 신규 contracts.json에 두며 이후 실제 writer 시험과 대조한다.
- [ ] **4. GREEN을 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-store.mjs scripts/test-runtime-store.mjs scripts/test-runtime-sessions.mjs scripts/test-runtime-guard.mjs scripts/test-runtime-prune.mjs`; `mcp-server/`에서 `rtk proxy npm test -- src/control/__tests__/persistent-contract.test.ts`와 `rtk proxy npm run typecheck`. 모두 exit 0, 기존 generation1 벡터 변형 없음.
- [ ] **5. 검증된 이 단위를 커밋한다.** 제목: `feat(runtime): v2 형식과 세대 호환 경계를 고정한다`.

### Task 2: 세대 저장소·catalog와 stable router

**Files:** Modify `scripts/runtime-entry.mjs`의 validateBootstrap/installBootstrap/runManaged ABI, `scripts/runtime-store.mjs`, `scripts/jhw-runtime-entry`. Inspect/verify `scripts/jhw-runtime-control`, `scripts/jhw-runtime-hook`; modify only for a required behavior change. Create `scripts/test-support/runtime-v2.mjs`, `scripts/test-runtime-v2-entry.mjs`. Extend `scripts/test-runtime-v2-store.mjs`, `scripts/test-runtime-entry.mjs`.

**Interfaces:** store의 `ensureBootstrapGeneration({repositoryRoot,releaseId,reuseBootstrapId=null,deployLease}):RuntimePair`, `validateBootstrapGeneration({repositoryRoot,bootstrapId}):{manifest:object,helperBytes:Map<string,Buffer>}`, `restoreBootstrapGeneration({repositoryRoot,bootstrapId,deployLease}):{bootstrapId:string,sourceReleaseId:string,runtimeContract:2}`. entry의 `installRouterV2({repositoryRoot,releaseId,deployLease,admissionLease}):{sourceReleaseId:string,routerContract:1,previousDirectory:string|null}`는 정지 경로 전용. 기존 runManaged 인자에 `selectedPair:RuntimePair|null`을 추가하고 `Promise<ManagedResult>`를 반환한다.

- [ ] **1. provenance·재사용·무혼합 시험을 작성한다.** `v2 router uses descriptor bytes from one generation`은 helper/manifest를 함께 변조해도 원본 release와 다르면 실행을 거부한다. `v2 generation reuse preserves catalog source`는 동일 helper의 release B가 A catalog를 유지하고, 소스 없는 재구성은 거부한다. 아래 값과 exact child set/mode도 검사한다.

  ```js
  assert.equal(reused.bootstrapId, original.bootstrapId);
  assert.equal(catalog.sourceReleaseId, releaseA.releaseId);
  assert.equal(routerManifest.files.length, 3);
  assert.equal(generationManifest.files.length, 3);
  assert.equal(legacyResult.status, 0);
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-entry.mjs scripts/test-runtime-v2-store.mjs`.
- [ ] **3. 세대와 router를 구현한다.** built-in 검증 전에는 helper를 import하지 않는다. catalog와 세대 manifest를 동일 bytes로 봉인하고 source release의 content-derived ID/hash를 검증한다. v1 root/세대 경로는 유지한다. root 선택이 바뀌면 runManaged의 `{retryCurrent:true}`를 받아 검증·helper import부터 최대 3회 반복하며 bound token은 current로 fallback하지 않는다. 이 단계의 router 단위 시험은 ABI를 갖춘 봉인된 fixture helper를 사용하고 실제 binding dispatch는 Task 3에서 완성한다. live bootstrap을 자동 갱신하는 CLI는 추가하지 않는다.
- [ ] **4. GREEN을 확인한다.** 위 명령과 `rtk proxy node --test scripts/test-runtime-entry.mjs scripts/test-runtime-store.mjs`. 직접 selector와 `node <selector-link>` 모두 검증하고, 출력 artifact는 실제 descriptor-read bytes에서 실행돼야 한다.
- [ ] **5. 커밋한다.** 제목: `feat(runtime): 검증된 bootstrap 세대와 고정 router를 추가한다`.

### Task 3: root·invocation 등록과 lease 수명

**Files:** Modify `scripts/jhw-runtime-entry`의 bound token 세대 선택, `scripts/runtime-store.mjs`의 binding/retirement/reaper, `scripts/runtime-entry.mjs`의 runManaged/runPinnedHook/자식 stdio, 필요 범위의 `scripts/runtime-safety.mjs`. Create `scripts/test-runtime-v2-sessions.mjs`. Extend `scripts/test-runtime-v2-entry.mjs`, `scripts/test-support/runtime-v2.mjs`.

**Interfaces:** `bindEntryPair({repositoryRoot,token,kind='invocation',selectedPair,admissionLease}):BindingV2|{retryCurrent:true}`, `resolveSessionBindingV2({repositoryRoot,token,pid=process.pid}):RuntimePair & {id:string,kind:string}`, `inspectSessionBindingsV2({repositoryRoot}):object[]`, `reapCompletedSessionBindingsV2({repositoryRoot,dryRun=true,limit=128}):{retired:string[],preserved:string[]}`. v1 API는 그대로 두고 entry에서 형식에 따라 dispatch한다.

- [ ] **1. 등록·부모 선종료 시험을 작성한다.** `v2 child retains parent root until its last inherited fd closes`는 실제 child가 FD 8을 보유한 동안 root 삭제와 세대 EX 획득이 불가능함을 검사한다. `v2 bound call ignores publication contention`은 publication EX 중에도 호출이 성공하며 새 root만 500ms 경계를 따름을 검사한다.

  ```js
  assert.equal(boundCall.status, 0);
  assert.equal(rootStillPresentWhileChildLives, true);
  assert.equal(newCallWithDeadParent.error.code, 'DEPLOY_SESSION_INVALID');
  assert.deepEqual(observedFdRoles, {3:'admission',5:'credential',6:'binding',7:'generation',8:'parent'});
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-sessions.mjs scripts/test-runtime-v2-entry.mjs`.
- [ ] **3. 등록·종료·회수 경로를 구현한다.** root는 publication SH→generation SH→root index EX, bound 호출은 generation SH→invocation index EX를 따른다(admission SH 선행). root token을 후손에게 유지한다. FD 6을 닫은 뒤 해당 index EX와 binding EX try로 퇴역하고 parent FD 8/세대를 마지막에 닫는다. reaper는 index를 놓고 generation부터 재획득하며 unlocked delete를 만들지 않는다. root membership은 writer의 index SH 동안 고정되고 그 뒤 publication EX 동안 축소만 가능하다.
- [ ] **4. GREEN을 확인한다.** 위 명령과 `rtk proxy node --test scripts/test-runtime-sessions.mjs scripts/test-runtime-entry.mjs scripts/test-runtime-safety.mjs`. 동시 root/child, forged token, PID 재사용, inode 교체, `.creating`/`.retired` 중단, lease 경합을 포함한다. 실제 writer record의 exact key/FD/token을 golden과 대조하고 PID·시간·inode 같은 동적 값만 명시적으로 정규화한다. reselect 3회는 router/binder 전체 합산이며 이미 발행한 binding은 재선택하지 않는다. wrapper/child의 종료는 시험용 IPC로 유도한다.
- [ ] **승인된 capacity/evidence 경계를 확인한다.** `SESSION_LIMIT`은 root와 각 bootstrap invocation namespace에 각각 적용하고 전체 합계에는 적용하지 않는다. 등록·inventory·reaper가 같은 no-follow type/owner/mode/ID-kind 분류를 사용하되 reaper의 후보 `limit`, `SESSION_SCAN_LIMIT`, 1.5초 시간 예산은 등록 용량과 분리한다. authoritative inventory는 완전하거나 명시적으로 실패한다. FD 5는 fixture helper의 실제 `fstat(5)` 직후 inode로 증명하고, golden은 중첩 key shape를 먼저 검사한 뒤 동적 scalar만 정규화하며, 실제 owner 종료와 마지막 FD 8 수명은 fixture IPC로 관측한다.
- [ ] **5. 커밋한다.** 제목: `feat(runtime): 세대별 호출 등록과 부모 lease 수명을 보장한다`.

### Task 4: 전체 검증 증거와 게시 직전 재검증

**Files:** Modify `scripts/runtime-store.mjs`의 walk/validateReleaseIn/activation 게시 내부 API, 필요한 `scripts/runtime-entry.mjs` artifact 읽기 경계. Create `scripts/test-runtime-v2-publication.mjs`.

**Interfaces:** `prepareRuntimeEvidence({repositoryRoot,pairs:RuntimePair[]}):PreparedRuntimeEvidence`, `revalidateRuntimeEvidence(evidence):void`, `preparePairActivation({repositoryRoot,pair,expectedCurrent,migrationId=null,deployLease}):V2Destination`, `publishPreparedActivation({repositoryRoot,destination,expectedCurrent,evidence,publicationLease,onPointerIntent}):V2Snapshot`. V2Destination은 설계 snapshot에서 observation만 뺀 exact shape다. 게시 API는 검증된 live handle·동일 repo·선택한 pair·lock identity가 없으면 거부한다.

- [ ] **1. 준비 이후 변조 시험을 작성한다.** `v2 publication rejects mutation after complete validation`에 same-size in-place edit+mtime 복원, inode/dir/symlink 교체, 추가 파일, manifest 교체를 각각 넣는다. 열린 handle 재사용/닫힌 증거/다른 repo 증거도 거부한다.

  ```js
  assert.throws(() => revalidateRuntimeEvidence(evidence), {code:'DEPLOY_SOURCE_CHANGED'});
  assert.deepEqual(readActivation({repositoryRoot: root}), before);
  assert.equal(payloadOpenedBeforeValidation, false);
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-publication.mjs`.
- [ ] **3. 준비 증거를 구현한다.** full hash 때 모든 entry의 descriptor 전후 metadata와 directory child set/symlink target을 모은다. 게시 직전 전체 entry metadata를 다시 보며 root-only shortcut/cache를 만들지 않는다. activation은 미리 fsync하고 pointer_intent durable 기록 뒤에 current를 rename한다. bundle/helper 실행은 검증한 bytes를 사용한다.
- [ ] **4. GREEN을 확인한다.** 위 명령과 `rtk proxy node --test scripts/test-runtime-store.mjs scripts/test-runtime-v2-store.mjs scripts/test-runtime-entry.mjs`. 준비 뒤 변조는 pointer 변경 전에 실패하고 정상 게시 때 중복 content hashing이 exclusive 구간에 없어야 한다.
- [ ] **5. 커밋한다.** 제목: `feat(runtime): 검증 증거로 pair 게시 구간을 제한한다`.

### Task 5: 호환 pair 게시·rollback과 중단 복구

**Files:** Modify `scripts/runtime-deploy.mjs`의 runCompatibleDeployment/compatibleInventory/reconcileCompatibleJournal/runDeployment, `scripts/runtime-store.mjs`의 rollback 대상 선택, `scripts/runtime-prune.mjs`의 공용 journal 판독·receipt writer. Extend `scripts/test-runtime-v2-publication.mjs`, `scripts/test-runtime-coexist.mjs`, `scripts/test-runtime-guard.mjs`.

**Interfaces:** Task 2·4의 pair/세대/증거 API를 소비한다. 기존 `runDeployment(options):Promise<object>`와 `--activate-compatible <release>`/`--rollback`을 유지한다. 내부 `runCompatiblePairDeployment({repositoryRoot,home,procRoot,environment,releaseId,rollback,phaseRunner,phaseTimeoutMs}):Promise<object>`와 `reconcilePairJournal({repositoryRoot,journalDirectory}):void`를 추가한다. v2 journal은 `v2/journals/d-32hex/`의 닫힌 `kind:'pair'` variant다. `runtime-prune.mjs`에 `readRuntimeJournalV2({repositoryRoot,journalDirectory}):{state:object,files:Map,identity:object}`를 두고 기존 `recordDeploymentRetention`을 v2 receipt에도 확장한다. Task 7·8은 이 공용 판독기에 해당 kind를 추가하고 deploy/GC가 동일 parser를 사용한다.
`publishPreparedActivation`의 첫 callback 인자는 그대로 유지하고, 검증된 pair journal 경로를 받은 경우
두 번째 인자로 sealed durable pointer witness descriptor를 전달한다. publisher가 hardlink witness 생성과
fsync를 소유하며 deploy callback은 그 descriptor를 동기적으로 journal intent에 기록한다.

- [ ] **1. 실제 호출과 중단 시험을 작성한다.** `v2 compatible publication keeps both bound pairs callable`은 A 세션을 유지한 채 B 게시→B 세션 생성→rollback 후 A/B 모두 원래 pair로 호출함을 검사한다. candidate MCP 계약 거부, v1/unknown consumer, current identity 변경과 pointer intent 양쪽 crash를 포함한다.

  ```js
  assert.deepEqual(oldSample.pair, pairA);
  assert.deepEqual(newSample.pair, pairB);
  assert.equal(samples.some(row => row.denied), false);
  assert.deepEqual(afterRejected.current, before.current);
  assert.equal(recoveredJournal.status, 'complete');
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-publication.mjs`.
- [ ] **3. 호환 게시와 복구를 연결한다.** deploy EX 아래 full validation·inventory·MCP probe를 먼저 수행한다. publication EX 안에는 exact current/root/consumer 확인, metadata 재검증, pointer_intent·rename·parent fsync만 둔다. root index SH는 membership 확인 동안만 잡는다. 1초 검사 예산 초과는 pointer 전에 중단하고 log fsync/완료 receipt는 publication을 놓은 뒤 수행한다. journal의 origin/destination 외 관측은 pending으로 남긴다.
- [ ] **4. paired rollback을 연결한다.** 호환 v2는 같은 게시 API를 사용한다. 비호환은 소비자 정지 필요를 보고하고 quiescent 재실행에서만 admission EX 경로를 사용한다. 회수된 세대는 catalog 원래 source로 복원하고 대상 activation의 releaseId/digest와 재조합·검증한다. 아직 Task 8의 legacy anchor rollback은 호출하지 않는다.
- [ ] **5. GREEN을 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-publication.mjs scripts/test-runtime-coexist.mjs scripts/test-runtime-guard.mjs scripts/test-runtime-v2-sessions.mjs`. MCP probe/log fsync가 EX 구간 밖임을 시험용 phase 관측으로 입증하고 timing을 JSON 증거로 남긴다. instrumentation은 함수 주입만 사용하고 production 환경 bypass는 만들지 않는다.
- [ ] **6. 커밋한다.** 제목: `feat(runtime): 기존 세션을 유지하며 pair를 게시하고 복원한다`.

### Task 6: Codex binding 전달과 사용자 env 보존

**Files:** Modify `scripts/install-config.mjs`의 codexEntry/inspectCodexRegistration/registerCodex/unregisterCodex/verifyManagedConfiguration, `scripts/install-wiring.sh`의 Codex 검증 호출. Create `scripts/test-runtime-codex-migration.mjs`. Extend `scripts/test-runtime-deploy.mjs`, `scripts/test-install-safety.sh`.

**Interfaces:** install-config의 기존 positional CLI를 유지한다. 내부 `mergeCodexBinding(source:string):{text:string,changed:boolean,userEnvironmentPresent:boolean}`는 owned/adopted 검사 후 쓰는 순수 변환이다. `check-codex-binding-migration <config> <entry> <repo>`는 읽기 전용 capability/preflight이며 성공 시 `{version:1,capabilities:['codex-binding-migration-v1']}`만 출력한다. `verify-codex-binding`은 binding 포함을 추가 검증한다. 기존 `verify-codex`는 이행 전 소유 벡터 검증에 남긴다.

- [ ] **1. 생성 설정을 실제로 적용하는 시험을 작성한다.** `codex generated whitelist preserves binding and user environment`는 신규/owned/adopted 설정에서 whitelist로 child env를 구성해 유효한 binding이 전달됨을 검사한다. env_vars 중복·중복 key·loader 변수·모호한 TOML은 무변경 거부한다. env child table·관련 없는 bytes·comments를 유지하며 기본 binding만 제거할 때 envDropped=[]다.

  ```js
  assert.equal(envVars.filter(x => x === 'JHW_RUNTIME_SESSION_BINDING').length, 1);
  assert.equal(childEnvironment.JHW_RUNTIME_SESSION_BINDING, parentToken);
  assert.equal(unrelatedTomlAfter, unrelatedTomlBefore);
  assert.deepEqual(defaultOnlyUninstall.envDropped, []);
  assert.equal(userEnvUninstall.envDropped.includes('codex'), true);
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-codex-migration.mjs`; expected assertion failure는 누락된 binding/삭제된 사용자 env다.
- [ ] **3. 순수 변환과 검증을 구현한다.** env_vars를 한 번만 병합하고 owned에서도 사용자 env를 보존한다. byte-identical 재등록은 inode/mtime/backup을 바꾸지 않는다. 신규 설치 final 검증과 migration 뒤에만 binding strict 검증을 적용해 legacy 보정 진입을 막지 않는다. 전체 HOME rewiring은 추가하지 않는다.
- [ ] **4. GREEN을 확인한다.** 위 명령과 `rtk proxy node --test scripts/test-runtime-deploy.mjs`, `rtk proxy bash scripts/test-install-safety.sh`. launcher fixture는 임의의 env 전달 허용 대신 생성된 whitelist를 적용한다. 기존 first-wiring의 실패 복구도 유지한다.
- [ ] **5. 커밋한다.** 제목: `fix(codex): 사용자 환경을 보존하며 세션 binding을 전달한다`.

### Task 7: 기존 managed Codex 한 파일 이행 transaction

**Files:** Modify `scripts/runtime-deploy.mjs`의 parse/help/pending/worker dispatch, `scripts/install-config.mjs`의 anchored transaction 부품, `scripts/runtime-prune.mjs`의 codex-config journal validator, 필요 범위의 `scripts/install-wiring.sh`. Extend `scripts/test-runtime-codex-migration.mjs`, `scripts/test-runtime-deploy.mjs`.

**Interfaces:** public CLI `--migrate-codex-config`. 내부 `runCodexConfigMigration({repositoryRoot,home,current,deployLease,admissionLease}):Promise<{code:'DEPLOY_CODEX_CONFIG_MIGRATED',changed:boolean}>`. 검증된 current release editor를 명시적으로 선택한다. worker operation `migrate-codex-binding-transaction <config> <entry> <repo> <stamp> <evidence>`는 새 transaction 또는 같은 pending의 복구를 수행한다. private evidence는 `kind:'codex-config'` journal이며 상태는 설계 9절 그대로다.

- [ ] **1. 교체 경쟁·중단 시험을 작성한다.** `codex migration never replaces a foreign reoccupied path`와 `codex migration preserves writes through an old fd`는 원본 검증 직후 교체, quarantine 직후 crash, publish link 직후 crash, nlink=2 도중 crash, live 재점유·symlink·old FD 쓰기를 각각 주입한다.

  ```js
  assert.equal(fs.readFileSync(livePath, 'utf8'), foreignText);
  assert.equal(quarantinedOriginalStillExists, true);
  assert.equal(journal.status, 'pending');
  assert.equal(otherHomeFilesChanged, false);
  assert.deepEqual(byteIdenticalAfter.identity, byteIdenticalBefore.identity);
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-codex-migration.mjs`.
- [ ] **3. CLI와 worker를 연결한다.** deploy EX→admission EX, current installer 일치·capability·기존 owned vector 검증 뒤 실행한다. 구버전 editor에 새 phase/KEYS를 전달하지 않는다. pending부터 판정하고 다른 mutation을 차단한다. 설정 부재/foreign vector는 자동 신규 설치로 바꾸지 않는다.
- [ ] **4. 승인된 설계 9절 A/A2 경계와 복구 표를 구현한다.** 새 active capture container의 단일 writer 전제, directory identity 재검증, 복원 각 syscall intent, 완료 이력의 봉인 사본 검증을 적용한다. complete는 live/retained 원본을 읽지 않으며 GC 삭제는 별도 inventory를 요구한다. foreign capture의 link 전후를 public 재호출도 복구 가능하게 판정하고 pending 보존으로 끝낸다. before/after 봉인→quarantine intent→move된 원본 확인→publish intent→no-clobber link→published 검증→자기 temp link 제거→strict verify→complete다. 자신의 정확한 객체만 회수하며 foreign live/quarantine을 추정 덮어쓰지 않는다. private 증거는 owner·regular·0600/no-follow로 검사하고 비밀 bytes를 출력하지 않는다.
- [ ] **5. GREEN을 확인한다.** 위 명령과 `rtk proxy node --test scripts/test-runtime-deploy.mjs`, `rtk proxy bash scripts/test-install-safety.sh`. 매 durable intent와 link/unlink 전후 재실행을 검증한다. 성공한 config 이행은 이후 runtime rollback 때문에 역변환하지 않는다.
- [ ] **6. 커밋한다.** 제목: `feat(codex): 기존 managed 설정의 안전한 이행을 지원한다`.

### Task 8: 최초 v1→v2 이행과 legacy rollback

**Files:** Modify `scripts/runtime-deploy.mjs`의 activate/refresh/rollback/recovery/worker 선택, `scripts/runtime-entry.mjs`의 root 설치·복구, `scripts/runtime-store.mjs`의 최초 activation/anchor, `scripts/runtime-guard.mjs`의 전환 증거, `scripts/runtime-prune.mjs`의 bootstrap-migration journal validator. Create `scripts/test-runtime-v2-migration.mjs`. Extend `scripts/test-runtime-deploy.mjs`, `scripts/test-runtime-guard.mjs`.

**Interfaces:** `runBootstrapMigration({repositoryRoot,home,current,deployLease,admissionLease}):Promise<object>`, `readMigrationAnchor({repositoryRoot,migrationId}):MigrationAnchor`, `rollbackLegacyMigration({repositoryRoot,home,current,anchor,deployLease,admissionLease}):Promise<object>`. anchor는 설계 7절의 preMigrationCurrent/legacyRollbackTarget/원본 bootstrap 복구 자료/새 router·세대·최초 activationId를 검증한 불변 자료다. journal kind는 `bootstrap-migration`; 최초 v2 activation의 migrationId와 상호 검증한다.

- [ ] **1. 명령 순서와 중단 시험을 작성한다.** `v1 bridge activates before explicit refresh and rolls back through its anchor`는 로컬 baseline `75a5071`의 실제 retained v1 reader/worker를 사용한다. B의 v1 activation·old bootstrap 중간 상태에서 호출이 가능하고, config migration→refresh 뒤 최초 v2의 priorCurrent/predecessor=null 및 migrationId를 확인한다.

  ```js
  assert.equal(intermediateCurrent.version, undefined);
  assert.equal(intermediateCall.status, 0);
  assert.equal(firstV2.priorCurrent, null);
  assert.equal(firstV2.predecessorActivationId, null);
  assert.match(firstV2.migrationId, /^m-[a-f0-9]{32}$/);
  assert.equal(stoppedLegacyRollback.releaseId, originalReleaseA);
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-migration.mjs`. baseline object가 없으면 검사 실패로 보고하고 읽기 전용 fetch로 확보한 뒤 실행한다. v1 코드를 현재 구현의 모사 parser로 대신하지 않는다.
- [ ] **3. 초기 전환과 복구를 구현한다.** managed v1 activate는 pointer-only이며 B가 legacy token도 읽는다. refresh만 anchor를 봉인하고 router→current를 바꾼다. 성공 activate B journal origin/receipt가 없으면 mutation 전에 거부한다. `prepared/router_intent/router_published/current_intent/pair_published/validation/complete`의 각 의도와 실제 객체를 대조한다. validation 뒤 admission 재획득에서 새 consumer가 있으면 pending으로 중단한다.
- [ ] **4. rollback과 새 설치를 연결한다.** 첫 v2의 기존 `--rollback`은 정지 상태에서 anchor의 A+원래 bootstrap을 복원한다. C→B는 v2 paired rollback이며 B→A는 정지 경계다. re-upgrade는 새 anchor를 쓴다. 신규 v2 설치는 migrationId=null로 기존 first-wiring 보호를 유지한다. 새 worker만 v2 journal을 읽고 retained v1 worker에는 지원되는 기존 변수만 전달한다.
- [ ] **5. GREEN을 확인한다.** 위 명령과 `rtk proxy node --test scripts/test-runtime-deploy.mjs scripts/test-runtime-guard.mjs scripts/test-runtime-codex-migration.mjs`. 모든 명령 사이/각 intent 전후 interruption, config-only 성공, foreign root/current, live/orphan lease를 검사한다. old reader가 v2를 fail-closed하고 v1 자료가 byte-identical하게 남는지도 확인한다.
- [ ] **6. 커밋한다.** 제목: `feat(runtime): 최초 세대 이행과 정지 rollback을 복구 가능하게 한다`.

### Task 9: 호환 journal 판독과 세대 복사본 회수

**Files:** Modify `scripts/runtime-prune.mjs`, `scripts/runtime-deploy.mjs`의 prune dispatch/receipt, `scripts/runtime-store.mjs`의 참조 snapshot·세대 삭제 보조. Create `scripts/test-runtime-v2-prune.mjs`. Extend `scripts/test-runtime-prune.mjs`, `scripts/test-runtime-coexist.mjs`.

**Interfaces:** 기존 `planRuntimePrune(options)`/`applyRuntimePrune(options)`/`recordDeploymentRetention(options)`의 v1 호출을 유지한다. `collectBootstrapRoots({repositoryRoot}):{retained:Set<string>,uncertain:boolean}`는 current/즉시 predecessor/live binding/lease/pending/anchor/최근 1개·30일 정책을 반영한다. v2 journal kind별 exact parser를 Task 5·7·8과 공유한다. GC는 catalog·activation·release·anchor를 삭제하지 않는다.

- [ ] **1. journal 분류·live 회수 시험을 작성한다.** `prune recognizes compatible journal variants without widening ordinary keys`는 candidate-probe.log/세 추가 키/variables={}를 compatible variant에서만 허용한다. `v2 prune preserves live roots and reconstructs historical reused generation`은 live A, current B, predecessor C, pending D를 보존하고 충분히 오래된 미참조 E만 회수한다.

  ```js
  assert.ok(oldEnoughPlan.candidates.journals.includes(completedJournalName));
  assert.equal(evidenceOnlyPlan.skipped.evidence, 1);
  assert.equal(legacyOnlyPlan.skipped.legacy, 1);
  assert.throws(() => planRuntimePrune(pendingOptions), {code:'DEPLOY_PRUNE_BLOCKED',reason:'pending_journal'});
  assert.equal(removedBootstrapCopy, true);
  assert.equal(catalogStillExists && sourceReleaseStillExists && anchorStillExists, true);
  assert.equal(rebuilt.bootstrapId, originalBootstrapId);
  ```
- [ ] **2. RED를 확인한다.** `rtk proxy node --test scripts/test-runtime-v2-prune.mjs scripts/test-runtime-prune.mjs`.
- [ ] **3. 판독과 보존 정책을 구현한다.** v1 compatible 성공에 receipt를 쓰고 기존 receipt 없는 기록은 보존한다. rejected/interrupted complete는 evidence, unresolved pending은 전체 prune 차단이다. journal의 기존 30일/최근 32개 정책과 previous의 최소 1개를 유지하고, 별도 세대 복사본은 설계의 30일/최근 1개를 적용한다. v2 새 journal의 kind/state/파일 집합을 각각 검사하고 unknown key를 완화하지 않는다.
- [ ] **4. 세대 GC를 연결한다.** v2 live-bound-only 조건에서는 deploy EX→publication EX→generation EX try→indexes SH로 참조를 재확인한다. 미퇴역 record가 있으면 삭제하지 않고 별도 index EX retirement 뒤 다음 시도로 넘긴다. 기존 v1/.bootstrap.previous 삭제 경로는 정지 admission 조건을 유지한다. 혼합 계획에서 live와 양립하지 않는 legacy 삭제는 apply 전체를 변경 전에 거부한다. quarantine/recovery copy/identity/owner/0600/exact-child/fsync 강도를 유지한다.
- [ ] **5. GREEN을 확인한다.** 위 명령과 `rtk proxy node --test scripts/test-runtime-deploy.mjs scripts/test-runtime-coexist.mjs scripts/test-runtime-v2-publication.mjs`. plan 이후 재참조, EX 실패, symlink/bytes/owner 교체, quarantine 중단, 30일/최근 1개 경계를 검사한다. GC 뒤 실제 rollback으로 같은 ID를 복원한다.
- [ ] **6. 커밋한다.** 제목: `fix(runtime): 호환 journal과 미참조 세대를 안전하게 정리한다`.

### Task 10: 실제 의존성·동시 세션 통합 검증과 운영 문서

**Files:** Create `scripts/test-runtime-v2-integration.mjs`. Extend `scripts/test-support/runtime-v2.mjs`, 필요한 기존 runtime/설치 회귀 시험. Update `README.md`, `DESIGN.md`. 버그 수정이 필요하면 소유 task로 돌아가 해당 시험부터 보완한다.

**Interfaces:** Task 2 fixture의 `realDependencies:true`는 실제 `mcp-server/package-lock.json`과 기본 build/rolldown 산출물을 사용한다. public `runDeployment`와 설치된 selector 경로로만 전환·호출한다. `startBoundClient(t,fixture):Promise<{request(command):Promise<object>,close():Promise<void>}>`를 시험 지원 파일에 추가한다. request는 실제 managed control/MCP/hook의 status·pair·시작/종료 시각을 수집하고 close는 정상 IPC 종료다.

- [ ] **1. 수락 시나리오 시험을 작성한다.** `v2 real dependencies keep three bound sessions callable through publication rollback and prune`는 실제 bytes가 다른 helper A/B, 3개 live root, 전환 중 연속 hook/control/MCP 호출, 새 root의 B 선택, rollback, prune과 재호출을 묶는다. 모든 호출을 기록하며 zero-sample 성공을 금지한다.

  ```js
  assert.ok(liveRoots.length >= 3);
  assert.notEqual(helperHashA, helperHashB);
  assert.ok(samples.every(row => row.status === 0 && !row.denied));
  assert.ok(samples.filter(row => row.duringPublication).length > 0);
  assert.ok(samples.filter(row => row.event === 'SessionEnd').every(row => row.elapsedMs < 3000));
  assert.ok(samples.filter(row => row.hook && row.event !== 'SessionEnd').every(row => row.elapsedMs < 12000));
  ```
- [ ] **2. 통합 검증을 실행한다.** `rtk proxy node --test scripts/test-runtime-v2-integration.mjs`. synthetic dependency나 준비된 process 목록만으로 완료하지 않고 실제 proc/lease 증거를 대조한다. 실패하면 성능/안전 기준을 낮추지 말고 소유 task로 돌아간다.

  일반 호스트 시험에서는 전체 릴리스 검증을 PID 검사 밖으로 옮겼다. 연속 호출 중에 PID 목록과 개별 프로세스 관측이 계속 변했다. 일반 호스트는 불확실한 관측에서 게시와 회수를 중단한다. [실행 경계 설계](../specs/2026-11-24-managed-execution-boundary-261.md#일반-호스트-진단)

  전담 서비스 UID의 관리형 실행 경계에서 기존 사용자 UID에 세션과 호출을 결속했다. 실제 의존성으로 빌드한 네 세션을 유지하며 호환 활성화, 롤백, 제3세대 회수를 확인했다. 운영 C5와 승인된 `PostToolUse`는 별도 배포 승인 뒤에 검증한다. [재현 절차와 검증](../specs/2026-11-24-managed-execution-boundary-261.md#실제-번들-반복-검증)

- [ ] **3. 운영 문서를 구현 결과로 갱신한다.** README에는 새 명령과 결과 코드, 초기 `prepare→status→activate→migrate-codex-config→refresh-bootstrap` 순서, router 변경의 정지 조건, rollback/anchor/catalog/30일 정책, hook 시간 측정과 지원 범위를 기록한다. DESIGN에는 실제 lock/FD/snapshot/fingerprint 계약을 기록한다. helper 갱신은 activate-compatible로 수행하고 v2 refresh가 정확한 pair면 no-op임을 명시한다.
- [ ] **4. 전체 정적·회귀 검증을 실행한다.** 아래 최종 명령 목록을 사용하고 각 종료코드와 pass/fail/skip을 기록한다. 입력 파일은 실행 중 변경하지 않는다. 제품 오류와 기준선에서도 재현되는 호스트 환경 실패를 구분한다.
- [ ] **5. 실제 Codex C5를 격리해 재검증한다.** 새 설정의 기본 whitelist를 적용한 대화형 세션에서 MCP 초기화와 읽기 전용 조회를 확인한다. 기존 live 설치의 per-run env 보완 성공을 후보 기본 설정 성공으로 재사용하지 않는다. 후보 검증에 실제 HOME 배포가 필요하면 승인된 한 번의 배포 뒤 검증 항목으로 남기고 선행 배포를 하지 않는다. MCP 호출 승인이 거부된 결과는 runtime 성공/실패로 계산하지 않는다.

  2026-11-23 사용자 결정에 따라 별도 Guard enforce 시험 환경이 없는 현재, C5와 승인된 `PostToolUse`의 대화형 검증은 별도 배포 승인 뒤 수행한다. 후보의 보호된 세션에서 사용자가 실제 요청을 승인하고 대응하는 `PostToolUse`가 `COMPLETED`인지 확인한다. 네 hook 모두 거부 0건이라는 수락 기준은 그대로 적용한다.

- [ ] **6. 문서와 통합 증거를 커밋한다.** 제목: `test(runtime): 세대 전환의 다중 세션 호출 연속성을 검증한다`. 전체 branch review 후 결과를 보고하며 push·PR·배포 승인은 이 계획 검토와 분리한다.

## 최종 검증 명령과 보고

새 worktree에 의존성이 없으면 구현 시작 시 `mcp-server/`에서 `rtk proxy npm ci`를 먼저 실행한다.
호스트 runtime-safety 기준선은 변경 전에 한 번 기록한다. Node/설치 fixture는 private root와 022 source mode를 사용한다.

`mcp-server/`에서 순서대로:

```bash
rtk proxy npm run typecheck
rtk proxy npm run build
rtk proxy npm test
```

저장소 루트에서(쉘 glob은 현재 파일 집합에 대해서만 확장):

```bash
rtk proxy node --test --test-concurrency=1 scripts/test-runtime-*.mjs
rtk proxy node --test scripts/test-guard-policy-wiring.mjs
rtk proxy node scripts/test-issue-skill-contract.mjs
rtk proxy node scripts/test-commit-skill-contract.mjs
rtk proxy node scripts/test-pr-skill-contract.mjs
rtk proxy node scripts/test-review-skill-contract.mjs
rtk proxy node scripts/test-task-skill-contract.mjs
rtk proxy node scripts/test-skill-alias-contract.mjs
rtk proxy node scripts/test-claude-command-dir-contract.mjs
rtk proxy node scripts/test-skill-runner-references.mjs
rtk proxy node scripts/sync-codex-skills.mjs --check
rtk proxy bash scripts/test-hook-preflight.sh
rtk proxy bash scripts/test-install-safety.sh
rtk proxy git diff --check
```

별도 lint 명령은 현재 package.json에 없다. typecheck, 변경된 JS의 `rtk proxy node --check <file>`, diff check, 계약 시험을 정적 게이트로 사용한다.
runtime integration이 병렬 실행으로 측정에 간섭받으면 단독 실행 증거를 추가하고 이유를 기록한다.
같은 소스·의존성·설정에서 이미 통과한 최종 검증은 결과를 재사용할 수 있으며 관련 변경/실패가 없으면 반복하지 않는다.
Task worktree mode 때문에 계약 시험이 막히면 소스 commit/diff와 묶인 `umask 022` 격리 복사본에서 실행한다.
관리형 MCP가 떠 있어 runtime-safety의 non-dumpable 사례가 실패하면 변경 전·후 동일 여부와 대상 오류를 기록한다.
`npm run test:live`와 실제 Notion 쓰기는 이 계획의 자동 검증에 포함하지 않는다.

## 설계 대조와 실행 인계

| 설계 요구 | 소유 task |
|---|---|
| 목표·비목표·v1 보존·closed snapshot·compatibility generation | 1, 10 |
| stable trust root, catalog, 세대 bytes 선택, current 재선택 | 2, 3 |
| root/invocation 잠금·FD 8·retirement·orphan | 3 |
| full 검증 증거·변조 방어·짧은 publication | 4, 5 |
| paired rollback·journal 중단·historical 재구성 | 5, 9 |
| 최초 이행·anchor·v1 복원·mixed worker | 8 |
| live 참조 보존·legacy/compatible journal·안전한 삭제 | 9 |
| 기본 whitelist·사용자 env·명시적 한 파일 migration | 6, 7 |
| 실제 3개 세션·deadline·control 범위·C5·배포 후 item12 | 10 및 별도 승인된 배포 후 확인 |

이 계획은 제품 구현 완료 증거가 아니다. 실행 방식은 사용자가 승인한 **Subagent-driven 순차 실행**이다.
공유 runtime 파일의 인터페이스를 단계별로 고정하고
수명·삭제·복구 결함을 다음 단계에 넘기지 않도록 각 task 직후 독립 검토를 받는다.
각 구현 agent에는 소유 파일과 push·PR·머지·브랜치 전환 금지를 명시한다.
