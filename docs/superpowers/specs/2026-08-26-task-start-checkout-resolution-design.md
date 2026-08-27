# Task start checkout resolution 설계

- 날짜: 2026-08-26
- 상태: 대화 설계 승인·독립 검토 반영, 작성본 사용자 검토 대기
- 대상: `jhw-notion` #74, 연계 `claude-config` #28
- 우선순위: 단순한 사용자 진입점 > 권위 좌표의 fail-closed 결정 > 기존 CLI 호환성

## 1. 배경과 결정

`jhw-control-host`를 Task 등록 진입점으로 연결하는 첫 구현은 Claude/Codex 스킬이
`portfolio status`를 여러 번 호출해 모든 페이지를 합친 뒤 `project_id`와 `repo_id`를
고르게 했다. 이 방식은 다음 이유로 폐기한다.

1. 각 페이지 호출은 독립된 GitHub Project/Registry 읽기다. snapshot token이나
   source revision이 없으므로 서로 다른 시점의 페이지를 한 결과처럼 합칠 수 있다.
2. Project 수가 같아도 페이지 사이에 항목이 이동·추가·삭제되면 전역 유일성을 잘못
   판단할 수 있다. ordinal, count, cycle 검사를 더해도 snapshot은 생기지 않는다.
3. 스킬 안에 shell/Node protocol parser가 커지면서 launcher의 Unicode, warning,
   Git remote 규칙을 중복 구현했고 실제 생산자 계약과 드리프트했다.
4. 사용자는 Task를 시작하려는 것이지 Project pagination을 운용하려는 것이 아니다.

따라서 신규 Task의 좌표 결정은 `task start` 서버 경계로 이동한다. 새 opt-in
`--resolve-from-checkout` 모드는 기존 mutation lock 안에서 checkout을 검증하고,
canonical Repository와 그 Repository를 포함하는 유일한 Project를 결정한 뒤 기존
등록·Claim 경로를 그대로 실행한다. Claude/Codex 소비자는 더 이상 portfolio를
페이지 순회하거나 자체 protocol을 파싱하지 않는다.

## 2. 목표

- clean shell에서 사용자가 credential이나 내부 Project/Repository ID를 다루지 않고
  명시적 요청 한 번으로 신규 Formal/Temporary Task를 시작한다.
- checkout, Registry Repository, GitHub Project 관계를 한 번의 `task start` lifecycle
  호출 안에서 fail-closed하게 결정한다.
- 기존 `--project` + `--repo-id` 호출과 기존 `--task` 재개를 깨지 않는다.
- launcher의 secure-store-only, hidden preflight, bounded output 계약을 유지하고 switch의
  finish도 같은 경계 안으로 넣는다.
- `$jhw-task`의 client-side pagination/reducer를 제거해 사용자-facing 절차를 짧게 한다.
- switch는 사용자가 선택한 finish 상태를 정확히 실행하고, finish를 반복하지 않는다.
- installer는 끝까지 신뢰된 system PATH만 사용한다.

## 3. 비목표

- GitHub Project와 Registry Git 사이의 분산 트랜잭션 구현
- pagination snapshot/token 저장소 또는 read-session lease 추가
- 자동 Project/Repository 등록·수정·migration
- 자동 retry, Claim takeover, finish rollback
- 기존 명시 좌표 모드 제거
- launcher를 임의 `jhw-control` proxy로 확대하거나 `task finish` 외 command family 추가
- `portfolio status` 제거: 상태 조회·진단 용도는 그대로 유지한다.

## 4. 선택한 CLI 계약

신규 Formal/Temporary Task는 두 coordinate mode 중 정확히 하나를 사용한다.

### 4.1 기존 명시 좌표 모드

```text
jhw-control task start \
  --project <prj-id> --repo-id <repo-id> --repo-path <absolute-root> \
  <formal-or-temporary-fields> --session <session-id>
```

이 모드의 동작과 검증은 바꾸지 않는다.

### 4.2 checkout 해석 모드

```text
jhw-control task start \
  --resolve-from-checkout true --repo-path <absolute-root> \
  <formal-or-temporary-fields> --session <session-id>
```

`true`는 기존 pair 기반 flag parser와 `--allow-public true` 관례를 유지하기 위한 exact
literal이다. 다른 값은 `INVALID_CLI_ARGUMENT`다.

- `--resolve-from-checkout true`와 `--project` 또는 `--repo-id`를 섞으면 파싱 단계에서
  거부한다.
- 명시 좌표 모드에서 두 ID 중 하나만 주면 거부한다.
- 신규 Task가 두 coordinate mode를 모두 생략해도 거부한다.
- `--task <tsk-id>` 재개는 resolver와 registration field를 모두 거부한다. persistent
  Task가 이미 Project/Repository 좌표를 소유하며 현재 `prepareExistingTask`가 이를
  checkout 및 live authority와 재검증한다.
- Formal/Temporary source field, absolute `--repo-path`, `--session` 계약은 그대로다.

성공 envelope와 exit 분류는 바꾸지 않는다. 성공 시 기존 `task`, `claim`, `branch`,
`worktree_ref`, `reused`, optional `latest_handoff`를 반환하고 host launcher는 이를
`task_id`, `claim_id`, `branch`, `worktree_ref`, optional Handoff로 투영한다.

## 5. 서버 해석 경계

CLI가 좌표를 먼저 받아 서비스에 넘기는 대신, source service의 신규 Task 등록 입력을
다음 discriminated union으로 만든다.

```text
explicit: { project_id, repo_id }
resolved: { resolve_from_checkout: true }
```

Formal/Temporary 등록 메서드는 이 union을 받아 같은 메서드 안에서 context를 만든다.
resolved mode가 외부에 임시 좌표를 출력하거나 CLI가 다시 조합하게 하지 않는다.

### 5.1 checkout identity

1. `repository_path`가 absolute이며 `git rev-parse --show-toplevel`의 exact root인지
   확인한다.
2. origin fetch URL과 effective push URL이 각각 정확히 하나인지 확인한다.
3. 기존 `githubSlugFromRemote()`로 두 URL을 독립 파싱하고 case-insensitive canonical
   slug가 같은지 확인한다. HTTPS fetch + SSH push처럼 transport만 다른 정상 checkout을
   허용한다.
4. GitHub Repository API로 live node ID, canonical full name, private 여부를 읽는다.

### 5.2 canonical Repository

source service가 ad-hoc Catalog 호출을 조합하지 않도록 `SourceCatalogPort`에 다음 의미의
단일 callback port를 둔다.

```text
withPinnedRepositoryByGitHubNode(nodeId, use(repository))
```

이 port는 `RegistryGit.withCommittedTree(["repositories"])`를 열고 live GitHub node ID를
Registry의 `repositories/by-source/github/` index에서 조회한다. index audit, Repository
record read, `use` callback, callback이 수행하는 Project 전체 read 안의 Catalog 조회를 모두
같은 committed tree에 묶는다. callback이 성공한 뒤 scope를 닫기 직전에 pinned commit과
현재 Registry HEAD를 다시 비교하며, 달라졌으면 결과를 반환하지 않고
`REGISTRY_MOVED_DURING_READ`를 낸다. final comparison 자체를 수행할 수 없으면 기존
`committedViewIsStale()`처럼 `false`로 삼키지 않고 `REGISTRY_CORRUPT`로 fail-closed한다.

- source index나 record가 없으면 `REPOSITORY_NOT_FOUND`다.
- malformed, reverse mismatch, 중복 source mapping은 `REGISTRY_CORRUPT`다.
- 읽는 동안 Registry가 이동하면 `REGISTRY_MOVED_DURING_READ`다.
- live node ID와 record node ID가 같고 checkout fetch/push slug, live `full_name`, record
  slug는 모두 기존 `sameSlug()`의 case-insensitive 의미로 같아야 한다. live casing을
  Registry에 자동 반영하거나 rename을 자동 등록하지 않는다.
- public repository는 record의 기존 `allow_public: true`가 있을 때만 허용한다.

### 5.3 unique Project association

Project resolver port는 `repo_id`를 포함하는 Project Record를 전체 revision-stable read
한 번에서 찾고 `{project_id, source_revision}`을 반환한다. 이 호출은 5.2의 pinned Registry
callback 안에서 실행한다. 이 경로는 `PortfolioService.status()`와 pagination payload를
사용하지 않는다.

- Project read 자체가 `updatedAt`/source revision 이동을 발견하면 기존
  `PROJECT_CHANGED_DURING_READ`로 중단한다.
- Project Record 스키마와 duplicate canonical Project ID 검증은 기존 `readAll()` 계약을
  재사용한다.
- match 0개는 `PROJECT_REPOSITORY_NOT_FOUND`, 2개 이상은
  `PROJECT_REPOSITORY_AMBIGUOUS`다.
- match 1개일 때만 `{project_id, repo_id, project_source_revision}`을 verified registration
  context로 만든다. 그 직후 5.2의 Registry final fence까지 통과해야 context를 반환한다.

두 새 오류는 exit 1의 stable task-start 오류다. launcher v3의 closed `task start` error
allowlist에 두 코드만 추가하며 start 성공 schema와 credential 경계는 바꾸지 않는다.

### 5.4 등록과 linearization

resolved mode는 위 unique Project snapshot을 association authority point로 보존한다.
`requireContext()`를 coordinate mode별 공통 verified-context builder로 분리해 explicit
mode는 기존 `requireProjectRepository()`를 실행하고, resolved mode는 이미 검증한 unique
snapshot을 membership-only 재읽기로 약화하거나 덮어쓰지 않는다. 그 뒤 Formal/Temporary
등록 로직은 다음 검증을 그대로 유지한다.

- canonical Repository와 exact checkout fetch/push identity
- coordinate mode에 맞는 Project/Repository membership 또는 unique-association proof
- live GitHub Repository node identity와 public opt-in
- Formal Issue URL/repository/node/revision/open 상태
- Registry Task idempotency/source index
- Claim 충돌과 worktree 생성 규칙

전체 `task start`는 현재처럼 host-global mutation lock 안에서 실행한다. compliant local
mutation은 직렬화되고, Registry read는 committed-tree pin/CAS로 보호되며, 한 Project
read는 revision fence를 가진다.

GitHub Project와 Registry는 독립 권위라 완전한 분산 원자성은 만들지 않는다. 이 명령의
Project association linearization point는 pinned Registry scope 안의 revision-stable unique
Project read이며, scope 종료 직전 Registry final fence가 그 interval을 닫는다. 그 뒤의
외부 Project 변경은 기존 explicit-coordinate 경로와 같은 post-check 변경으로 취급한다.
명령이 감지한 mismatch나 이동 뒤에는 Task/Claim/worktree mutation을 만들지 않고 자동
retry하지 않는다.

## 6. Claude/Codex Task 진입점

canonical `skills/claude/task.md`의 신규 Task 흐름은 다음으로 축소한다.

1. 사용자에게 Task start 요청/승인이 있는지 확인하고 기존 승인을 재질문하지 않는다.
2. `"$HOME/.local/bin/jhw-control-host" preflight`를 실행한다.
3. nonzero이면 어떤 Task/Claim/worktree mutation도 하지 않고 멈춘다.
4. 현재 또는 명시된 target checkout의 absolute Git root를 direct Git fact로 얻는다.
5. Formal/Temporary는 launcher `task start --resolve-from-checkout true`를 정확히 한 번
   실행한다. Existing resume는 기존 `task start --task`를 정확히 한 번 실행한다.
6. 성공 결과의 immutable `task_id`, `claim_id`, `branch`, `worktree_ref`만 보고한다.

`PROJECT_REPOSITORY_NOT_FOUND`이면 해당 Repository를 올바른 Project Record에 등록한 뒤
재시도하라고 안내하고, `PROJECT_REPOSITORY_AMBIGUOUS`이면 중복 association을 한 개로
정리하라고 안내한다. 어느 경우에도 Project를 임의 선택하거나 explicit mode로 자동
fallback하지 않는다. canonical Task skill과 producer `global-guidance.md`가 같은 절차와
조치를 명시한다.

raw config, `.env`, raw `jhw-control task start`, client-side `portfolio status` pagination,
Project/Repository ID 추측은 모두 금지한다. `portfolio status`는 사용자가 별도로 상태를
요청했을 때의 읽기 전용 진단 명령으로만 남는다.

Codex `jhw-task`는 생성 파일을 직접 수정하지 않고 canonical Claude reference symlink를
계속 소비한다.

## 7. switch 계약

switch는 서버 명령이 아니라 기존 Task `finish`와 대상 Task `start`의 순서다.

1. 사용자에게서 finish status, 실제 validation, completed의 outcome, 대상 Task source와
   absolute target checkout을 한 번에 받는다.
2. target path가 absolute Git root인지 direct Git fact로 finish 전에 확인한다. 실패하면
   finish/start 모두 하지 않는다.
3. 사용자가 고른 exact status로 `jhw-control-host task finish`를 한 번 실행한다. launcher가
   secure store를 주입하고 mutation 직전 hidden preflight를 수행한다. completed는 outcome을
   포함하고, handoff/abandoned는 각 기존 필드 계약을 따른다. finish 실패 시 start하지
   않는다.
4. 신규 Formal/Temporary target은 retained target root로 launcher resolver start를 한 번
   실행한다. Existing target은 launcher `--task` resume를 한 번 실행한다.
5. 외부 gate를 다시 실행하거나 finish를 반복하지 않는다. launcher의 보안 계약상 finish와
   start 각각의 내부 hidden preflight는 수행되며, 이는 lifecycle gate 재실행이 아니다.
6. finish 성공 뒤 start 실패는 정상적인 부분 완료 상태다. finish를 rollback하거나
   반복하지 않고 start 오류와 이미 release된 이전 Claim을 함께 보고한다.

Project association은 start lifecycle 안에서만 권위 있게 해석된다. pre-finish에 별도
portfolio snapshot을 만들어 보존하지 않는다. 따라서 target이 미등록·ambiguous하면
finish 뒤 start가 실패할 수 있으며, 이는 기존 switch가 이미 명시한 부분 완료 한계다.
그 위험을 없애기 위한 read lease/snapshot token은 이 설계의 비목표다.

## 8. launcher와 installer

`jhw-control-host` v3는 기존 v2의 `task start ...` argv 전달과 성공 projection을 그대로
유지한다. 요청에 `--project`/`--repo-id`가 없으면 결과 내부 Task/Claim 좌표의 canonical
형식·상호 일치, host, branch/worktree 관계를 검증하므로 resolver flag 자체를 위한
start parser/projection 변경은 없다.

v3는 clean-shell switch를 위해 allowlist에 `task finish` 하나를 추가한다. command list가
확장되므로 contract version은 3으로 올린다. finish argv는 downstream에 exact 전달하고,
성공 envelope의 `task_id`, `claim_id`, exact requested `status`, `released_at`,
`worktree_removed`를 strict 검증해 투영한다. optional `cleanup_error`는 exact
`WORKTREE_CLEANUP_FAILED`만, `handoff_pointer`는 요청 Task/Claim에 묶인 canonical relative
pointer만 허용한다. 요청한 Task/Claim/status와 결과가 다르면
`CONTROL_OUTPUT_INVALID`다. finish도 closed command-specific error allowlist,
bounded/path-safe output, hidden preflight를 적용한다. 다른 lifecycle command는 노출하지
않는다.

`task finish`는 `COMMON_CONTROL_ERROR_CODES`에 다음 finish 경로의 stable code만 더한 별도
frozen set을 사용한다: Claim/owner 검증, source revision, Handoff 생성·retry, worktree
inspection/mapping, Registry transaction에서 실제 도달 가능한 코드다. 최소 핵심 집합은
`CLAIM_MISMATCH`, `CLAIM_NOT_FOUND`, `HOST_MISMATCH`, `SOURCE_REVISION_MISMATCH`,
`INVALID_FINISH_OUTCOME`, `HANDOFF_RETRY_CONFLICT`, `INVALID_WORKTREE_INSPECTION`,
`WORKTREE_DIRTY`, `WORKTREE_MAPPING_MISMATCH`이며, 구현 시 call-site contract test가 전체
literal set을 고정한다. 다른 command의 전체 set을 재사용하거나 임의 문자열을 허용하지
않는다.

finish error의 optional `reason`도 code별 closed map으로만 투영한다.

- `HANDOFF_RETRY_CONFLICT`: `invalid_git_state_line`, `duplicate_git_state_key`,
  `unexpected_git_state_key`, `missing_git_state_key`, `invalid_git_state_count`,
  `missing_git_identity`, `invalid_dirty_digest`, `legacy_dirty_evidence_ambiguous`,
  `git_identity_changed`, `dirty_delta_changed`, `handoff_metadata_mismatch`,
  `retry_fields_changed`
- `INVALID_WORKTREE_INSPECTION`: `duplicate_dirty_files`
- `WORKTREE_DIRTY`: `handoff_copy_not_plain_file`

등록되지 않은 reason, 잘못된 code/reason 조합, 다른 finish code의 reason은
`CONTROL_OUTPUT_INVALID`다. canonical Task skill의 기존 reason별 복구 조치(커밋 Handoff
정본 유지, Git evidence 복원 또는 새 Claim, malformed copy/inspection 중단)를 launcher
projection 뒤에도 그대로 적용하며 자동 finish 재실행이나 overwrite는 하지 않는다.

launcher와 producer guidance 변경은 다음으로 제한한다.

- resolved-mode Formal/Temporary argv가 hidden preflight 뒤 exact 전달되고 정상 성공
  projection을 통과하는 회귀 테스트
- 두 새 stable error code의 `task start` allowlist와 exit-1 테스트
- `task finish` strict input/output/error projection과 contract-v3 테스트
- README의 optional caller-coordinate binding 및 finish 설명
- `global-guidance.md`의 `preflight → portfolio status → task start` 문구를 canonical skill과
  같은 `preflight → resolver task start`로 교체하고 raw finish 안내를 launcher finish로
  교체하는 literal regression test

installer는 `PATH=/usr/bin:/bin`을 설치 종료까지 유지한다. `$HOME/.local/bin`을 PATH에
prepend/append하지 않는다. RTK 존재 확인은 shell builtin의 direct executable probe로만
수행하고 RTK나 user-local helper를 실행하지 않는다. pre-existing user-local `install`,
`mv`, `ln`, `python3` symlink/leaf canary가 실행되지 않는 테스트를 둔다.

## 9. 호환성과 migration

- Registry/Project/Task/Claim schema migration은 없다.
- 기존 explicit-coordinate callers는 byte-for-byte 같은 명령을 계속 사용할 수 있다.
- existing Task resume, promote, finish, recover, assert-owner 동작은 바꾸지 않는다.
- v2 launcher의 기존 start caller는 계속 동작하지만, resolver/switch 소비자는 v3가
  필요하다.
- 새 error code와 `task finish`를 모르는 구 launcher는 각각 fail-closed
  `CONTROL_OUTPUT_INVALID` 또는 unsupported command가 되므로, resolver 사용 전 producer
  installer를 재실행해 같은 delivery의 v3 launcher를 갱신한다.
- 배포 순서는 producer allowlist/installer merge → `install.sh` 재실행 → clean-shell
  contract/preflight → jhw-notion server/skill merge → resolver Task smoke다. producer를 먼저
  배포하면 아직 새 오류를 내지 않는 구 server와 호환되고, consumer가 활성화되기 전에
  새 stable 오류를 안전하게 투영할 수 있다. 구 explicit mode는 rollout 동안 fallback이
  아니라 호환 경로로만 남는다.

## 10. 테스트 계약

### jhw-notion

- CLI coordinate mode truth table과 mutation-lock 유지
- Formal/Temporary resolved success 및 explicit mode 회귀
- resume + resolver/mixed/partial coordinate 파싱 거부
- exact checkout root, unique fetch/push, mixed HTTPS/SSH transport, case-insensitive slug,
  `.github` repository, rename/node/public-policy 검증
- Registry source-index pinned callback: missing, corrupt, duplicate, Project read 도중 이동,
  callback 종료 직전 final fence 이동·비교 실패
- Project association 0/1/N, malformed record, duplicate ID, revision movement
- resolver 실패 뒤 Task/Claim/worktree mutation 없음
- Formal Issue identity/revision/open 검증과 Temporary input 규칙 유지
- Claude/Codex 소비자: preflight 실패 무변경, Formal/Temporary resolver 1회, resume 1회,
  canonical v3 success/error envelope, 두 association 오류의 exact operator action,
  no raw config/control/pagination
- switch status/target matrix: completed/handoff/abandoned × formal/temporary/resume,
  exact finish/start argv, finish 실패 no-start, start 실패 no-refinish

### claude-config

- launcher resolved argv exact forwarding과 hidden preflight
- resolved success projection 및 두 새 error code safe projection
- caller-provided coordinate binding 회귀
- launcher finish exact forwarding, requested Task/Claim/status binding, success/error/warning
  projection, hidden preflight, unsupported lifecycle command 차단, v2→v3 contract
- ambient PATH와 pre-existing `$HOME/.local/bin` executable/symlink poison 차단
- installed launcher byte equality, `0500` payload, `0700` directory, reinstall idempotency
- focused/full pytest, shellcheck, py_compile, diff check

### 통합

- generated Codex sync check
- locked producer full pytest와 consumer build/typecheck/full tests
- clean environment installed `--contract`/preflight
- 기존 #74 positive-smoke Task/Claim은 operator attestation으로 보존하고, 원문 envelope가
  없다는 audit limitation을 명시한다. 증거만을 위해 두 번째 Task를 만들지 않는다.
- 새 resolver positive smoke는 명시적으로 승인된 실제 다음 Task start에서 확보한다.
  그 전에도 코드는 merge할 수 있지만 #28/#74 완료·close는 보류한다. 별도 smoke Task가
  필요하면 실행 직전에 사용자 승인을 받아 생성하고 검증 뒤 정상 lifecycle로 종료한다.

## 11. 폐기한 대안

### A. client-side pagination 보강

count/cycle/schema 검사를 늘려도 서로 다른 호출을 한 snapshot으로 만들 수 없고 protocol
중복이 계속 커진다. 폐기한다.

### B. `portfolio status --repo` 한 번 호출 후 explicit start

표시에는 유용하지만 별도 start와 사이에 TOCTOU가 남고, 소비자가 다시 두 권위 결과를
조합해야 한다. Task start 권위 경계로 쓰지 않는다.

### C. pagination snapshot token/lease

snapshot 저장, expiry, token 검증, launcher projection, cleanup이 필요하다. 한 번의 Task
등록을 위해 상태ful read protocol을 추가하는 것은 과도하다.

### D. 별도 `task resolve` command

switch의 pre-finish 진단은 좋아지지만 launcher allowlist와 공개 command family를 늘리고
실제 start에서 다시 검증해야 한다. 현재 switch의 documented partial-completion 의미를
받아들이는 편이 더 단순하다.

## 12. 완료 조건

- client-side portfolio accumulator와 중복 remote/schema parser가 canonical Task skill에서
  제거된다.
- 신규 Task는 명시적 승인 뒤 launcher resolver mode로 한 번만 시작된다.
- 서버 resolver가 Repository source index와 unique Project association을 fail-closed하게
  결정하고 기존 source/Issue/Claim 검증을 우회하지 않는다.
- 기존 explicit/resume start 동작과 launcher v2 start projection이 유지되고, v3의 유일한
  command-family 증가는 secure `task finish`다.
- installer가 user-local executable을 선택하지 않는다.
- 두 저장소의 focused/full/static/integration 검증과 독립 리뷰가 clean이다.
- default branch 갱신 후 충돌 없는 PR/merge 증거가 있다.
