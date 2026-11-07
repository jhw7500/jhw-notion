# Remaining Issues Single Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 남은 이슈의 승인된 구현과 정책 결정을 끝내고 최종 revision 하나의 배포를 준비한다.

**Architecture:** 기존 런타임·Project Control 경계를 유지하며 opt-in 경로만 추가한다.
Codex 사용량 한도는 FAILED를 유지하고, runtime 정리는 명시적 계획/apply로 분리한다.
worktree 정리는 정확한 역사적 통합과 외부 백업을 결속하며 Guard는 private policy로 관찰 모드를 선택한다.

**Tech Stack:** Node22+, TypeScript, Vitest, node:test, Bash, Git, 기존 SDK. 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-11-07-remaining-issues-single-deploy-design.md`

## Global Constraints

- 사용자 `진행`은 위 설계의 로컬 구현·검증을 승인한 것이다. 다시 작업 진행 승인을 묻지 않는다.
- AGENTS.md의 일반 실행 경로와 독립된 bounded native executor를 사용한다. 부모가 통합과 커밋을 소유한다.
- 실제 배포·프로세스 종료·push·PR·머지·운영 파일 삭제·Registry cutover는 이 계획으로 실행하지 않는다.
- Task/Claim 생성·자동 takeover·force-end·Registry 직접 편집 없음. 기존 Task 없음 결정을 유지한다.
- 모든 셸 명령은 rtk로 시작한다. 기존 타인의 수정과 Handoff를 보존한다.
- production 변경 전에 의미 있는 실패 회귀를 확인한다. 보존하는 기존 동작의 characterization은 기준선 통과를 정직하게 기록한다.
- 테스트 입력이 되는 파일은 실행 중 수정하지 않는다. targeted 검사 후 입력이 안정되면 전체 검사를 실행한다.
- canonical skill만 수정하고 Codex 생성물 sync는 부모가 모든 canonical 변경 뒤 한 번 수행한다.
- 새 ControlError reason은 schemas.ts와 canonical task skill에 같이 등록한다.
- runtime worker KEYS·phase와 bootstrap exact 파일 집합은 retained release 혼합 버전과 호환돼야 한다.
- 공개 출력에 credential·session·절대 경로·raw patch·private evidence 내용을 싣지 않는다.
- 커밋은 부모가 jhw-commit 계약과 pinned validator를 거쳐 한국어 필드로 작성한다.

## Review Focus

1. 읽기 전용 discovery의 fetch·index 갱신·journal append·mkdir/chmod 같은 숨은 쓰기: Task3/4에서 모두 거부한다.
2. 4097번째 또는 마지막 항목의 pending/불명 상태: Task2의 전체 preflight에서 삭제 0건을 검증한다.
3. 같은 patch-id지만 실제 blob·mode가 다른 변경: Task3에서 exact tuple 비교로 거부한다.
4. env 없는 새 세션과 일부 env·unsafe policy: Task5에서 전체 좌표 출처 일관성과 fail-closed를 검증한다.
5. 정상 설치 후 구버전 rollback과 중간 crash: Task2/3/5에서 증거 보존·old reader 거부·배선 복원을 검증한다.

---

### Task 1: Codex 사용량 한도 정책과 머지 차단 회귀

**Files:**
- Modify: `skills/claude/pr.md`, `scripts/test-pr-skill-contract.mjs`
- Create: `docs/pr-codex-usage-limit-policy.md`
- Parent later generates: `skills/codex/jhw-pr/`

**Interfaces:** 기존 `ship_collect_codex_signal`, reviewer expected/excluded 불변식을 사용한다.
새 자동 제외 함수·새 상태·request 귀속을 시간으로 추정하는 경로를 만들지 않는다.

- [x] Step1: quota+P0/P1, quota와 별도로 존재하는 현재 HEAD 지적, 과거/delayed quota를 기존 executable contract fixture로 검사한다. 머지가 열리거나 Codex가 excluded가 되면 안 된다.
- [x] Step2: `node scripts/test-pr-skill-contract.mjs` 실행. 기존 정책 characterization이면 기준선 통과를 기록하고 새로운 생산 로직을 만들지 않는다.
- [x] Step3: canonical skill와 정책 문서에 현재 API의 요청/HEAD 귀속 부재, FAILED 유지, 자동 제외 미지원, TIMEOUT·workflow 제외 의미를 기록한다.
- [x] Step4: 같은 계약 검사 종료0, 실제 실행/실패 수를 기록하고 독립된 diff 검토를 받는다.
- [x] Step5: 부모가 범위 파일만 커밋한다. 새 GitHub 이슈·코멘트·원격 리뷰를 요청하지 않는다.

### Task 2: 배포 기록의 명시적 보존·정리

**Files:**
- Modify: `scripts/runtime-deploy.mjs`, `scripts/runtime-entry.mjs`, `scripts/runtime-store.mjs`
- Create if needed: `scripts/runtime-prune.mjs`, `scripts/test-runtime-prune.mjs`, `docs/deployment-retention.md`
- Test: runtime deploy/entry tests. README/DESIGN 최종 통합은 부모가 담당한다.

**Interfaces:** `runDeployment({repositoryRoot,home,argv,procRoot,build,environment,phaseRunner,...})`를 유지한다.
공개 argv는 `--prune`과 `--prune --apply`만 추가하며 기존 명령 조합은 거부한다.
결과 code는 `DEPLOY_PRUNE_PLAN`/`DEPLOY_PRUNED`, 오류는 `DEPLOY_PRUNE_BLOCKED`/`DEPLOY_PRUNE_PARTIAL`이다.
내부 모듈을 분리하면 SOURCE_INPUTS에 포함한다. Task5는 변경 후 runDeployment에 Guard 전환을 통합한다.

- [x] Step1: fixture에서 다음 실패 회귀를 작성한다: dryrun 무변경, 4096/4097/cap+1, 마지막 pending/불명 journal 전체 삭제0, 실패·복구 증거 보존, unsafe child/owner/link/mode, sequence 최신 previous 보존, 중단 intent 보존.
- [x] Step2: 새 targeted node:test 실행에서 미구현 명령/동작으로 실패함을 확인한다.
- [x] Step3: 별도 bounded scanner(8192 entries, state256KiB/전체32MiB, candidate64MiB)로 전체 preflight를 구현한다. 정상 성공 journal 30일·최소32개, 순서 불명 previous와 복구 참조 보존, 새 receipt의 최신 previous1개·30일을 유지한다.
- [x] Step4: 성공한 배포 뒤 별도 sequence/receipt를 기록한다. 기존 state/KEYS/phase/bootstrap 집합은 그대로다. 부가 기록 실패는 성공을 뒤집지 않는다.
- [x] Step5: apply에서 기존 두 lease·quiescence를 유지하고 descriptor/capture·exact 자식 검사·개별 unlink/rmdir를 사용한다. 중간 실패의 남은 증거를 보존하고 자동 재개하지 않는다.
- [ ] Step6: targeted green, 기존 deploy/entry 관련 회귀와 mixed retained library를 검증한다. 실제 운영 runtime prune은 실행하지 않는다.
- [ ] Step7: 독립 diff 검토 후 부모가 범위 파일을 커밋하고 결과·정책을 README/DESIGN에 통합한다.

### Task 3: Released generation 발견과 정확한 역사적 통합 정리 core

**Files:**
- Modify: `mcp-server/src/control/task-service.ts`, `worktree.ts`, `registry-git.ts`, `catalog.ts`, `github-source.ts`, `schemas.ts`
- Create: `mcp-server/src/control/worktree-cleanup-proof.ts`
- Test: 해당 control `__tests__`의 unit/e2e
- Modify: `skills/claude/task.md`, `docs/project-control/phase1a-runbook.md`
- Reserved to parent: `cli.ts`, CLI tests, README, generated Codex skills

**Interfaces:**
- `TaskService.recoveryDiscovery(taskId)` inactive 결과에 strict `released` 발견 결과를 추가한다. 기존 active/handoff 의미는 유지한다.
- `TaskRecoverInput.action`의 cleanup variant를 `{kind:"cleanup"; cleanup_proof?:string}`로 확장한다.
- `WorktreeManager.cleanupReleased(history, options?)`의 options는 `{proofPath?:string}`이며 proof가 없으면 기존 경로다.
- 새 read-only source/catalog readiness 메서드는 기존 mutation 메서드와 분리해 export한다. 정확한 signature는 반환 전에 부모에게 공유한다.
- `WorktreeRemovalResult`에 선택 `cleanup_policy`, `branch_preserved`, `proof_sha256`를 추가해 CLI가 안전한 값만 투영한다.

- [x] Step1: inactive non-Handoff, timestamp 동률/alias/generation mismatch, root·mapping·Registry·git metadata 무변경 테스트를 먼저 추가하고 실패를 확인한다.
- [x] Step2: fetch 없는 readiness(ls-remote exact SHA), no-optional-lock Git, committed view pin, readOnlyState/root와 snapshot 재검증을 구현한다. CLI journal 생략은 Task4다.
- [x] Step3: full linear suffix<=32와 distinct ordered integration ancestor 대응, exact old/new blob·mode·type·path tuple 검증 테스트를 먼저 작성한다. 부분 대응·같은 patch-id 다른 bytes는 거부한다. 후속 변경/revert는 승인 정책대로 허용한다.
- [x] Step4: strict external manifest0600/dir0700, full bundle의 scratch 복원·연결성, ignored artifact 전수 hash/bytes/mode/별개inode 검증을 구현한다. manifest1MiB, artifact4096개/256MiB, symlink/gitlink/특수파일·unsafe backup은 거부한다.
- [x] Step5: 새 pending-remove-equivalent intent와 exact snapshot/CAS·최종 재검증·동일 proof 재개를 구현한다. 기존 ancestor/pending-remove 유지, plain remove·branch 보존, old parser fail-closed를 검사한다.
- [ ] Step6: unit/e2e targeted green과 타입 검사를 실행하고 필요한 reason/task 문서를 맞춘다. 실제 redmine·Registry·Task/Claim을 변경하지 않는다.
- [ ] Step7: 부모에게 새 interface·테스트 결과·한계를 보고한다. 독립 diff 검토 후 부모가 범위 파일만 커밋한다.

### Task 4: Released discovery와 cleanup의 CLI·host 계약

**Files:** `mcp-server/src/control/cli.ts`, CLI/e2e tests, host contract fixture, canonical task docs의 필요한 보완.

**Interfaces:** Task3의 recoveryDiscovery와 cleanup_proof를 소비한다.
`task recover --action status --resolve-from-checkout true --repo-path ... --issue-url ...`를 유지하고,
`--cleanup-proof`는 action cleanup에서만 허용한다.

- [x] Step1: inactive released projection, invalid action/flag 조합, proof path redaction, status 성공/실패 journal 무변경, 실제 host 경유 projection 테스트를 작성한다.
- [x] Step2: targeted CLI 실패를 확인한 뒤 읽기 전용 resolver 분기를 선택하고 released만 strict schema로 출력한다. status journal append를 생략하며 다른 명령 감사는 유지한다.
- [x] Step3: cleanup_proof를 core에 전달하고 safe result만 투영한다. mutation lock과 active successor 차단은 유지한다.
- [x] Step4: CLI/e2e/실제 launcher 계약 검증을 끝내고 문서를 업데이트한다. host production 변경이 꼭 필요하면 원인과 최소 범위를 기록하고 해당 저장소 지침을 먼저 적용한다.
- [ ] Step5: 부모가 커밋한다. canonical task 변경 뒤 최종 sync는 Task5 뒤 수행한다.

### Task 5: Guard private opt-in 관찰 모드와 managed 배선 전환

**Files:**
- Create: `mcp-server/src/control/guard-policy.ts`와 전용 tests
- Modify: `session-end-config.ts`, `hook-adapter.ts`, `guard-state.ts`, `cli.ts`, 해당 tests
- Modify: `scripts/runtime-deploy.mjs`, `scripts/install-wiring.sh`, `scripts/install-config.mjs`, runtime/installer tests
- Modify: README/DESIGN, 필요 운영 문서. Task2의 runtime 수정 완료 뒤 통합한다.

**Interfaces:**
- `resolveGuardEnvironment(env:NodeJS.ProcessEnv)`는 resolved environment와 출처·mode를 반환한다. 일반 loadControlConfig/credential launcher는 env-only로 유지한다.
- private policy는 HOME/.config/jhw-control/guard-policy.json의 exact `{version:1,mode:"observe"}`다. current-user regular0600/nlink1, 안전한 no-follow parent를 검증한다.
- env 좌표가 하나라도 있으면 전체 env를 사용한다. 파일과 일부 env를 섞지 않는다. env 없는 Guard만 명시 policy 아래 data-only11좌표를 읽는다.
- hook composition은 resolved environment 하나를 config·host·journal에 일관되게 사용한다. SessionEnd evidence-only 의미는 유지한다.
- `GuardRequestStore.ensureInitialized()`는 지원 lock 아래 파일이 없는 경우만 빈 store를 만들고 기존 requests는 바꾸지 않는다. preflight는 이를 호출하지 않는다.
- 배선 전환은 current-policy verify와 candidate-policy plan/wire를 분리하고 policy+두 adapter config를 같은 transaction/recovery evidence에 결속한다.

- [x] Step1: private policy/좌표 reader의 no-env observe, partial env, unsafe path/link/owner/mode/duplicate/credential/shell bytes, 일반 CLI fallback 부재 회귀를 먼저 쓰고 실패를 확인한다.
- [x] Step2: resolver와 안전 reader 공유를 구현한다. request store 초기화는 preflight와 분리하고 기존 store 보존·동시 초기화·손상 거부를 검사한다.
- [x] Step3: 두 adapter의 실제 production composition fixture에서 no-env 정상 tool 호출, 관찰 위반 허용, protocol/unavailable/self-approval 의도된 거부를 검증한다. probe HOME을 private fixture로 격리한다.
- [x] Step4: SessionEnd-only -> observe hook 전환, foreign group/credential env 보존, 실패·구버전 rollback의 policy+settings 복원을 먼저 회귀로 고정한다. 일반 refresh만으로 배선하지 않는다.
- [x] Step5: runtime driver의 현재/목표 정책 분리와 transaction을 구현하고 mixed release·crash evidence를 검증한다. code는 준비하되 실제 HOME/운영 배선은 변경하지 않는다.
- [x] Step6: unprotected:false/runtime_mode:observe/enforced:false의 의미를 결과와 문서에 명시한다. Registry authority cutover를 추가하지 않는다.
- [ ] Step7: canonical skill sync, 관련 계약, typecheck/build/vitest/runtime4종/installer 검사를 입력 안정 상태에서 실행한다. 테스트 종료코드·실행/실패/skip 수를 기록한다.
- [ ] Step8: 전체 branch 독립 리뷰와 필요 수정·로컬 커밋을 끝낸다. 원격 작업과 실제 최종 배포는 완성된 snapshot으로 별도 승인한다.

## Pre-flight interfaces and execution

- Task1과 Task2, Task3은 소유 파일이 다르다. bounded native lanes로 진행하며 전역 skill sync와 commit/index 조작은 부모만 수행한다.
- Task3 -> Task4: cleanup_proof·released metadata·readonly resolver 이름을 공유한다. Task4의 CLI 변경은 Task3 core 인터페이스 확정 뒤다.
- Task2 -> Task5: runtime-deploy/entry/store 소유권을 반납한 뒤 Guard runtime 통합을 시작한다.
- Task3/4 -> Task5: CLI 변경은 부모가 순차 통합한다. Guard unit은 별도 파일에서 먼저 구현할 수 있다.
- TDD targeted 실행 중에는 그 테스트가 읽는 소유 파일을 고정한다. 최종 전체 검사는 모든 lane의 쓰기를 멈춘 뒤 실행한다.
- 실행 규칙: 승인된 AGENTS 일반 lane에서 계획을 사용한다. workflow를 추가로 시작하거나 승인된 로컬 구현을 다시 확인하는 handoff는 만들지 않는다.

## Self-review

설계의 #201/#196/#220/#195를 각각 Task1/2/3+4/5가 담당한다. 완료한 #206/#217은
146cd19로 보존돼 재구현하지 않는다. cleanup_proof/public flag, historical 정책,
30일·32개·최신1개·legacy 보존, guard observe opt-in을 서로 일관되게 명시했다.
리뷰 초점 다섯 개는 해당 task 회귀에 모두 포함했다. 새 remote 권한이나 실제 삭제 승인은 없다.
