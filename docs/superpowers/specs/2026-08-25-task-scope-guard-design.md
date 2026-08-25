# Task Scope Guard 및 프롬프트 1회 승인 설계

- **Date**: 2026-08-25
- **Status**: Approved — 사용자 섹션별 검토와 최종 진행 승인 완료
- **Author**: jhw + Codex
- **Scope**: `jhw-notion` Project Control, Claude Code, Codex CLI, Gemini CLI, OpenCode
- **Priority**: 태스크 간 우발적 침범 차단 > 명시적 사용자 예외 > 다중 TUI 편의성

---

## 1. 결정 요약

`jhw-control`에 중앙 Task Scope Guard를 둔다. 각 활성 Claim은 자연어 설명이 아닌
닫힌 `capability + resource` Work Contract를 고정하고, 모든 지원 TUI의 얇은
adapter가 변경 작업 전에 중앙 Guard에 판정을 요청한다.

판정은 세 종류다.

1. `ALLOW` — Work Contract와 소유권 불변식을 모두 만족한다.
2. `PERMIT_REQUIRED` — 소유권 충돌은 없지만 현재 Work Contract 밖의 정확히 식별된
   작업이다. Guard가 복사 가능한 `/jhw:unlock <request-id>`를 반드시 안내한다.
3. `DENY` — Claim, worktree, 다른 Task의 자원 소유권, Board Claim 등 사용자가
   일회성 범위 예외로 우회해서는 안 되는 불변식이 깨졌다.

사용자가 TUI 프롬프트에 정확한 unlock 명령을 제출하면 해당 요청 한 건만 승인된다.
`ok`, `진행`, `다음` 같은 일반 응답이나 AI가 생성한 텍스트·도구 호출은 승인이 아니다.
승인 후 10분은 **실행 시작 기한**이다. 실행 시작 시 permit을 원자적으로 한 번
소모하고, 이미 시작된 작업은 permit 만료로 중단하지 않는다.

저장소는 Task 경계가 아니라 resource다. 같은 저장소에서 여러 Task가 각기 다른
Claim·branch·worktree를 가지고 병렬 실행될 수 있다. 하나의 Issue에 독립 실행선이
여럿이면 Issue에 대응하는 parent Task 아래에 child Task를 만들며, 각 Task의
capability는 상속되지 않는다.

---

## 2. 배경과 실패 사례

Notion 데이터 정리와 `wlan-package` 로컬 변경 처리를 맡은 세션이 다른 세션에 배정된
F/W·driver·`iw`/`wpa`·`antcfg` 보드 비교 시험을 자신의 다음 단계로 해석하려 했다.
다른 세션의 상태와 프로젝트 전체 acceptance gate가 대화 문맥에 보였고, 계획 언어가
그 외부 작업을 현재 세션의 소유 작업처럼 승격한 것이 원인이다.

기존 Project Control은 동일 canonical Task의 다중 writer를 Claim으로 막지만 다음은
강제하지 않는다.

- 현재 Claim이 실제로 어떤 capability와 resource를 사용할 수 있는지
- 다른 Task를 읽은 세션이 그 작업을 자신의 다음 행동으로 실행하지 않는지
- raw Git·shell·SSH·보드 명령이 Task 소유권 검사를 통과했는지
- `진행` 같은 일반 응답이 범위 확대 승인으로 오해되지 않는지

`claude-config`의 현재 task nudge는 최초 Edit/Write 시 안내만 하며 Bash와 실제 실행을
차단하지 않는다. 따라서 프롬프트 지침만 강화하는 것으로는 이 실패를 막을 수 없다.

---

## 3. 목표, 비목표, 위협 모델

### 3.1 목표

- 현재 세션의 Task 범위를 중앙의 기계 판독 가능한 계약으로 고정한다.
- 같은 저장소의 서로 다른 Task를 독립 worktree에서 병렬 실행한다.
- 외부 Task의 상태를 dependency로 볼 수는 있지만 자동으로 소유 작업으로 바꾸지 않는다.
- Work Contract 밖의 단발 작업은 사용자가 정확한 프롬프트 명령으로 쉽게 승인한다.
- publish·merge·deploy·SSH·보드·F/W 작업은 TUI 훅뿐 아니라 실행 직전에도 재검사한다.
- Guard 장애나 상태 손상 시 변경 작업을 fail-closed한다.
- 모든 판정과 승인·소모를 bounded·secret-safe 감사 기록으로 남긴다.

### 3.2 비목표

- 같은 Unix UID로 실행되는 악성 프로세스에 대한 보안 경계
- OS 수준 MAC, sudo, polkit 또는 별도 승인 daemon
- raw shell을 적대적 코드로 간주한 완전한 명령 의미 분석
- 파일별 잠금이나 병합 충돌 자동 해결
- Board Claim을 Task Claim에 합치거나 대체하는 것
- 자연어 Issue/프롬프트를 실행 시점마다 capability로 추론하는 것
- 일반적인 `ok`나 `진행`을 암묵적 승인으로 해석하는 것

### 3.3 위협 모델

막으려는 대상은 **규칙을 따르는 AI가 문맥을 잘못 해석해 발생시키는 우발적·자율적
scope drift**다. native `UserPromptSubmit` 이벤트를 사용자 의사의 출처로 신뢰한다.

같은 Unix UID의 악성 코드가 hook 입력·상태 파일·CLI 호출을 위조하는 공격까지 막으려면
외부 trust anchor가 필요하다. 이 설계는 그 강도를 주장하지 않는다. AI 도구를 통하지
않은 raw shell 직접 실행도 완전히 봉쇄하지 못하며, 고위험 실행 wrapper를 통해 실제
운영 경로의 강제력을 높인다.

---

## 4. 권한과 구성요소

### 4.1 정본 배치

| 객체 | 정본 | 비고 |
|---|---|---|
| Task identity와 parent/child 관계 | Registry Git | Issue source index는 parent만 가리킨다 |
| 현재 writer | Registry Git Active Claim | Task마다 최대 하나 |
| Work Contract 원본 | Registry Git Task record | free-text scope와 분리 |
| 실행 중 Work Contract | Active Claim의 immutable snapshot/digest | Claim 도중 자동 확대 금지 |
| permit 요청과 상태 | host-local Guard state | 짧은 수명, Registry에 commit하지 않음 |
| permit 감사 기록 | host-local Guard journal | 권한 정본이 아닌 파생 측정 스트림 |
| Board 점유·예약 | 기존 host-local Board state | Task permit으로 우회 불가 |

이 설계는 기존 Project Control SSOT 설계와 Board Lock 설계를 확장한다. Task 범위와
parent/child 관계에 대해서만 이 문서가 추가 규칙을 정의하며, Board Lock의 별도
소유권·예약·펜싱 규칙은 그대로 유지한다.

### 4.2 중앙 Guard

`jhw-notion`의 `jhw-control`이 유일한 정책 판정자다. 중앙 Guard는 다음을 소유한다.

- 닫힌 capability/resource 어휘와 operation 정규화 계약
- Task·Claim·worktree·Work Contract 검증
- `ALLOW | PERMIT_REQUIRED | DENY` 판정
- 승인 요청 생성, prompt-origin 승인, 원자적 permit 소모
- execution-layer 재검사
- Guard journal과 bounded 결과

TUI별 hook 안에 독자적인 허용 목록이나 Task 판정 로직을 복제하지 않는다.

### 4.3 TUI adapter

각 adapter는 두 종류의 native 이벤트를 연결한다.

1. `UserPromptSubmit`
   - 현재 Task·Claim·Work Contract 요약을 bounded context로 주입한다.
   - raw 사용자 입력이 정확한 `/jhw:unlock <request-id>` 형식인지 검사한다.
   - 일치할 때만 중앙 Guard의 prompt-origin 승인 경로를 호출한다.
2. `PreToolUse`
   - tool 이름, 인자, cwd, session을 canonical operation으로 정규화한다.
   - 실행 전에 중앙 Guard 판정을 요청한다.
   - `PERMIT_REQUIRED`이면 Guard가 준 승인 명령을 그대로 표시하고 실행을 막는다.

Claude hook wiring은 `claude-config`가 소유한다. Guard executable, adapter protocol,
공통 검증 fixture와 Claude 이외 TUI 설치 지원은 `jhw-notion`이 소유한다. adapter는
얇은 transport여야 하며 정책 변경은 `jhw-control` 한 곳에서 이뤄진다.

### 4.4 실행 계층 재검사

TUI 훅은 정상적인 tool 경로를 조기에 막는 UX 경계다. 다음 고위험 작업은 실제
실행 wrapper가 같은 operation과 permit을 다시 검증한다.

- `git push`, PR 생성, merge, release, deploy
- credentialed remote execution과 SSH
- `board with`를 포함한 보드 사용
- F/W 교체, flash, reset 등 target 상태 변경
- Notion·Issue의 권위 있는 상태 변경

hook에서 받은 `ALLOW`를 실행 wrapper가 그대로 신뢰하지 않는다. wrapper는 현재
Claim generation, worktree, operation digest, permit 상태를 다시 읽는다.

```text
User prompt/tool request
        │
        ▼
TUI adapter ──normalize──▶ jhw-control guard evaluate
        │                         │
        │                 ALLOW / PERMIT_REQUIRED / DENY
        │                         │
        ▼                         ▼
high-risk wrapper ──recheck──▶ Task/Claim + permit + resource lock
        │
        ▼
     operation
```

---

## 5. Task, Claim, Work Contract 모델

### 5.1 저장소는 resource다

Task 단위는 저장소가 아니다. 한 저장소에 여러 canonical Task가 존재할 수 있고,
각 Task는 다음을 독립적으로 가진다.

- `task_id`
- Active Claim과 immutable `claim_id`
- session, branch, worktree
- Work Contract snapshot
- lifecycle와 Handoff

서로 다른 Task는 같은 파일을 수정할 수도 있다. Guard는 파일 잠금을 만들지 않으며,
각 worktree 격리와 이후 Git 통합 검증으로 충돌을 다룬다.

### 5.2 standalone, parent, child

기존의 작은 Task는 standalone으로 유지할 수 있다. 하나의 Issue가 독립 실행선 여러
개를 필요로 하면 기존 Issue Task ID를 parent로 유지하고 child Task를 만든다.

- **parent Task**: Issue 목표, acceptance, child 구성, 최종 통합을 소유한다.
- **child Task**: 하나의 실행선, Claim, worktree, Work Contract를 소유한다.
- Issue node ID → Task source index는 parent만 가리킨다.
- child는 `parent_task_id`를 가지며 같은 Issue를 별도 formal source로 등록하지 않는다.
- 초기 모델은 깊이 1만 허용한다. child 아래 child를 만들지 않는다.
- parent와 child 사이에 capability나 resource grant를 자동 상속하지 않는다.
- child 관계는 `required_for_parent: true | false`를 명시한다. CLI 입력에서 생략하면
  `true`로 정규화한 뒤 저장하며 Registry record에는 항상 값이 존재한다.
- child 목록은 child record의 `parent_task_id`에서 파생하고 parent에 중복 목록을
  저장하지 않는다.
- child의 terminal 상태는 `completed | abandoned`다. `handoff`는 새 Claim이 이어받을
  수 있는 non-terminal 상태다.

예를 들어 `wlan-package` Issue 하나를 다음처럼 나눈다.

```text
parent: issue objective / acceptance / integration
├── child: local-hardening
│   └── local repository changes + host tests
└── child: target-matrix
    └── board + SSH + F/W/driver comparison
```

각 child는 writer 하나만 가진다. parent가 통합 작업을 수행해야 하면 parent도
통합용 Work Contract와 별도 Claim을 가져야 하며 child capability를 빌려 쓰지 않는다.

parent의 terminal 완료는 다음을 모두 만족해야 한다.

- 모든 required child가 terminal 상태다.
- abandoned child가 있다면 superseded·불필요 판정 등 명시적 disposition이 parent
  결과에 있다.
- 실제 integration validation이 하나 이상 기록됐다.
- formal Task의 Issue open/closed lifecycle 권한은 기존대로 GitHub Issue에 남는다.

Claim 한 generation을 `task finish --status completed`로 archive하는 것과 parent Issue를
terminal 완료하는 것은 같은 사건으로 간주하지 않는다.

초기 구현은 이 두 사건 사이의 권한 공백을 피하기 위해 활성 parent Claim에서 먼저
`completion-ready` evidence를 기록하고, 같은 Claim으로 tracker 실행 경계가 Issue를
close한 뒤, 마지막으로 Claim을 `task finish`한다. evidence는 Task·Claim·Work Contract
digest에 묶이며 required child 상태와 integration validation을 close 직전에 다시
검사한다. Claim을 먼저 끝냈다면 기존 evidence로 Issue를 close할 수 없고 새 Claim에서
evidence를 다시 기록해야 한다.

### 5.3 Work Contract

Work Contract는 free-text `scope`를 실행 시점에 해석하지 않는다. Task record가
명시적 grant를 소유하고 Claim 획득 시 snapshot과 digest를 고정한다.

개념 스키마:

```yaml
version: 1
task_id: tsk-...
grants:
  - capability: repo.inspect
    resource: { kind: repository, id: repo-wlan-package }
    coordination: shared
  - capability: repo.modify
    resource: { kind: repository, id: repo-wlan-package }
    coordination: shared
  - capability: git.commit
    resource: { kind: repository, id: repo-wlan-package }
    coordination: shared
dependencies:
  - task_id: tsk-target-matrix
    relation: observes
```

초기 capability 어휘:

```text
repo.inspect       repo.modify       git.commit       git.publish
tracker.mutate     notion.mutate     test.host
board.observe      board.execute     remote.execute
firmware.change    deploy.execute    integration.perform
shell.unclassified (permit-only)
```

초기 resource kind 어휘:

```text
repository   issue   notion_database   board
remote_host  firmware_target           deployment_target
```

어휘는 닫혀 있으며 alias, wildcard, prefix match를 허용하지 않는다. 모든 resource는
Repository Record, Issue node ID, Board registry 등 기존 authority에서 확인된 canonical
ID를 사용한다. 자유 텍스트 주소·경로를 resource identity로 승격하지 않는다.

각 grant의 `coordination`은 `shared | exclusive` 중 하나를 반드시 명시한다. grant는
작업 허가이고 실제 runtime lease와는 구별되지만, 활성 Claim 사이의 Task 배정 충돌을
판정하는 축이다.

- `shared`: 여러 Task의 활성 Claim이 같은 resource를 계약에 넣을 수 있다. repository
  수정은 일반적으로 shared이고 각 Claim worktree로 격리한다.
- `exclusive`: 같은 canonical resource를 포함한 다른 Task의 활성 Claim과 공존할 수
  없다. board·firmware target·deployment target처럼 실행선을 한 Task에 배정해야 하는
  자원에 사용한다.
- 같은 resource에 대해 어느 한쪽이 `exclusive`면 Claim 획득 단계에서 충돌한다.
- 이미 손상되거나 legacy migration으로 충돌 상태가 존재하면 Guard가 실행 단계에서도
  hard `DENY`한다.
- exclusive Work Contract는 Task 배정을 나타낼 뿐 물리 resource를 점유하지 않는다.
  board는 별도의 holder/reservation, deploy target은 해당 실행 authority를 추가로
  통과해야 한다.

따라서 두 child가 같은 repository에 `repo.modify + shared`를 가져도 병렬 실행할 수
있지만, `target-matrix`가 특정 board에 `board.execute + exclusive`를 가진 활성 Claim인
동안 `local-hardening`은 prompt permit으로 그 board를 사용할 수 없다.

한 operation이 여러 자원을 사용하면 필요한 모든 `(capability, resource)` grant가
있어야 한다. 예를 들어 보드에서 SSH로 F/W를 교체하는 wrapper는 `board.execute`,
`remote.execute`, `firmware.change`를 각각 정확한 resource에 대해 요구한다.

`shell.unclassified`는 닫힌 operation 어휘에 포함하지만 persistent Work Contract에는
저장할 수 없는 sentinel이다. parser가 안전하게 분류하지 못한 exact command를
read-only로 오인하지 않고 prompt permit 경로로 보내기 위해서만 사용한다. resource는
현재 Claim의 repository/worktree로 binding하며, 알려진 SSH·publish·board·deploy
패턴을 이 sentinel로 낮춰 고위험 재검사를 피할 수 없다.

Claim이 활성인 동안 Task record의 계약이 바뀌어도 활성 Claim은 자동 확대되지 않는다.
새 계약을 쓰려면 현재 Claim을 정상 종료하고 새 Claim을 획득한다. 권한 축소가 긴급한
경우에는 별도 revoke generation을 설계할 수 있지만 초기 구현 범위에는 넣지 않는다.

### 5.4 External Dependency

다른 Task의 상태는 다음 행동 판단에 필요할 수 있으므로 dependency로 연결할 수 있다.

```text
blocked_by | observes | integrates
```

dependency는 상태·Handoff를 읽을 수 있는 관계일 뿐 grant가 아니다. 다른 Task가
완료되지 않았거나 검증 항목을 보유한다고 해서 현재 Task에 그 작업의 capability가
추가되지 않는다. 계획 문장, acceptance 목록, `다음 단계` 텍스트도 계약을 바꾸지 않는다.

### 5.5 Claim과 worktree 불변식

변경 작업에는 다음이 모두 필요하다.

- canonical Task와 활성 Claim이 존재한다.
- 호출 session이 Claim의 session과 일치한다.
- 현재 host·branch·worktree가 Claim 좌표와 일치한다.
- 변경 대상 path가 Claim worktree 안으로 안전하게 resolve된다.
- operation의 모든 capability/resource 쌍이 Work Contract에 있다.

Claim 부재·불일치, 다른 worktree, 다른 활성 Task의 exclusive contract 또는 runtime
authority가 소유한 resource는 hard `DENY`다.
`/jhw:unlock`은 이를 우회하지 않는다. Task를 바꾸려면 기존 `finish → start/resume`
전환을 수행해야 한다.

---

## 6. Operation 정규화와 판정

### 6.1 Canonical operation

adapter는 사용자나 AI가 capability 이름을 직접 선언하게 두지 않는다. tool과 인자를
정규화하여 다음 구조를 만든다.

```yaml
operation_id: op-...
session_id: codex-...
task_id: tsk-...
claim_id: clm-...
cwd_worktree_ref: wt-...
requirements:
  - capability: git.publish
    resource: { kind: repository, id: repo-wlan-package }
risk: high
summary: bounded secret-safe text
digest: keyed canonical-operation digest
```

digest는 실행에 영향을 주는 정규화된 인자와 식별 가능한 local script content를
포함한다. raw 비밀값은 저장하지 않고 host-local key를 사용한 keyed digest만
보존한다. 승인 후 command, target, cwd, script content가 바뀌면 재검사에서
`PERMIT_MISMATCH`가 된다.

### 6.2 판정 순서

판정 순서는 고정한다.

1. adapter protocol/version과 입력 schema 검증
2. Task·Claim·session·host·worktree 검증
3. 다른 Task 또는 resource authority 충돌 검사
4. operation 정규화와 요구 grant 계산
5. Work Contract 비교
6. permit이 있으면 exact binding과 상태 검사
7. `ALLOW`, `PERMIT_REQUIRED`, `DENY` 반환

2~3단계 실패는 permit 요청을 만들지 않는다. 5단계의 범위 부족만
`PERMIT_REQUIRED`가 될 수 있다.

### 6.3 작업별 enforcement

| 작업 | 1차 검사 | 실행 직전 재검사 | 범위 밖 동작 |
|---|---|---|---|
| 로컬 repository 읽기 | adapter | 없음 | 일반적으로 허용 |
| 로컬 파일 수정·commit | `PreToolUse` | commit wrapper가 있으면 재검사 | permit 또는 hard deny |
| Notion·Issue mutation | `PreToolUse` | MCP/CLI mutation 경계 | permit 또는 hard deny |
| push·PR·merge·release | `PreToolUse` | publish wrapper | 반드시 재검사 |
| Board·SSH·F/W·deploy | `PreToolUse` | 전용 wrapper + 별도 resource lock | 반드시 재검사 |
| 분류 불가능한 shell | `PreToolUse` | exact digest 확인 | 명시적 unknown-operation permit |

Project Control·Guard·Board의 읽기 전용 status는 충돌 진단을 위해 Claim 없이 허용한다.
credentialed external read나 remote command는 단순 로컬 읽기로 간주하지 않고 해당
capability를 요구한다.

### 6.4 Shell 처리

- 알려진 Git, SSH, board, deploy 패턴은 고위험 operation으로 우선 분류한다.
- pipeline·조건식·다중 command는 가능한 경우 구성 command 전부를 정규화하고 모든
  요구 grant를 합친다.
- 안전하게 분해할 수 없으면 read-only로 추정하지 않고 `unknown shell operation`으로
  표시한다.
- unknown operation은 정확한 command digest에 대한 prompt permit을 요구한다.
- known Claim·worktree·resource ownership 충돌을 shell 포장으로 바꿔 permit 대상처럼
  만들 수 없다.
- 로컬 script 실행은 식별 가능한 script의 content digest까지 binding한다.

이는 적대적인 shell 난독화를 막는 sandbox가 아니다. 정상 adapter 경로에서 모호한
명령을 조용히 허용하지 않는 fail-closed 규칙이다.

---

## 7. 프롬프트 1회 승인

### 7.1 필수 사용자 안내

`PERMIT_REQUIRED` 결과는 `approval_command`를 필수 필드로 가진다. adapter나 AI가
임의 문구를 만들어내는 것이 아니라 Guard 결과를 그대로 표시한다.

```text
현재 Task 범위를 벗어나 차단되었습니다.

Task: local-hardening
요청: board.execute
대상: wlan-target-board
요청 ID: req-7D2K

1회 승인:
  /jhw:unlock req-7D2K

효과: 표시된 작업 1회만 허용
승인 가능 시간: 10분
```

요청이 만료되면 Guard는 원래 작업을 다시 요청해 새 request ID를 발급받으라고
안내한다. 전체 세션이나 capability를 한꺼번에 푸는 `--all`, wildcard, 영구 unlock은
제공하지 않는다.

승인에 성공하면 adapter는 다음 실행 시작 기한도 즉시 보여준다.

```text
1회 승인이 등록되었습니다: req-7D2K
실행 시작 기한: 10분
표시된 작업이 시작되면 승인은 즉시 소모됩니다.
```

### 7.2 사용자 원점 판정

다음 조건을 모두 만족해야 승인된다.

- native `UserPromptSubmit` 이벤트다.
- raw prompt가 정확히 `/jhw:unlock <request-id>` 한 줄이다.
- 현재 TUI session이 요청에 binding된 session과 같다.
- request가 `PENDING`이고 승인 가능 시간 안이다.

공백·대소문자·추가 인자 허용 범위는 parser에서 하나로 고정한다. `ok`, `진행`, `다음`,
`승인`, 인용문, code block, AI 응답 속 텍스트는 승인으로 해석하지 않는다. AI가 Bash로
내부 approve CLI를 호출하려 하면 adapter가 self-approval operation으로 hard deny한다.

`/jhw:unlock`은 일반 agent skill이 아니라 adapter가 모델 실행 전에 처리하는 reserved
control prompt다. TUI가 slash command 등록을 요구하더라도 그 등록물은 raw prompt를
adapter로 전달하는 transport일 뿐이며 자체적으로 permit을 만들거나 AI에게 승인
권한을 주지 않는다.

TUI가 raw 사용자 prompt origin을 검증 가능한 native hook으로 제공하지 않으면 그
TUI에서는 prompt unlock을 지원한다고 표시하지 않는다. 해당 경로는 계속 차단하며,
설치 preflight가 adapter coverage 부족을 명시한다.

### 7.3 상태 전이와 10분 의미

```text
PENDING ──user prompt──▶ APPROVED ──atomic start──▶ CONSUMED
   │                         │                         │
   └──expired                └──start deadline        ├──COMPLETED
                                                      └──FAILED
```

- `PENDING` 요청은 생성 후 10분 안에 승인해야 한다.
- `APPROVED` permit은 승인 후 10분 안에 실행을 시작해야 한다.
- 실행 직전 state lock 안에서 `APPROVED → CONSUMED`를 원자적으로 수행한다.
- `CONSUMED` 뒤에는 permit TTL을 다시 검사해 실행을 중단하지 않는다.
- 장시간 작업의 runtime limit은 permit과 별도의 command timeout/lease가 담당한다.
- spawn 실패를 포함해 한번 `CONSUMED`된 작업의 재시도에는 새 승인이 필요하다.
- 두 세션이나 두 실행이 동시에 같은 permit을 소모하면 정확히 하나만 성공한다.

### 7.4 Permit binding

permit은 다음 전체에 binding된다.

- Task ID와 Claim generation
- TUI와 session ID
- cwd와 worktree ref
- capability/resource 요구 집합
- canonical operation digest
- request/approval/start deadline

요약문은 사람 확인용이고 digest가 실행 동일성의 기준이다. summary가 같아 보여도
resource, command, script, cwd가 바뀌면 사용할 수 없다.

### 7.5 Permit이 우회하지 못하는 것

prompt permit은 **Work Contract 범위 부족만** 한 번 예외 처리한다. 다음은 계속 hard
deny 또는 기존 authority의 별도 절차를 요구한다.

- Task/Claim/session/host/worktree mismatch
- 다른 활성 Task가 소유한 resource
- Board holder·reservation·펜싱 충돌
- stale Claim takeover 또는 recovery 승인
- Git non-fast-forward, hash/revision pin mismatch
- destructive command의 별도 확인 조건
- state corruption과 Guard unavailable

반복해서 같은 capability가 필요하면 permit을 반복하는 대신 child Task 생성,
Work Contract 개정, 정상 Claim 재획득 또는 명시적 Task switch를 사용한다.

---

## 8. 상태, 동시성, 감사

### 8.1 Host-local permit state

permit은 짧은 수명이고 한 host의 TUI 실행에 묶이므로 Registry Git에 commit하지 않는다.
`${JHW_CONTROL_STATE_DIR}` 아래 별도 state와 lock을 사용한다.

개념 파일:

```text
guard-requests.yaml
guard-requests.lock
guard-journal.jsonl
guard-digest.key
```

- 파일은 symlink 금지, owner-only permission, regular-file·nlink 검사를 적용한다.
- mutation은 flock → read/strict-validate → update → temp fsync → atomic rename →
  directory fsync 순서다.
- request ID는 충돌 가능성이 무시 가능한 random component를 가진 canonical ID다.
- session당 pending 16개, host 전체 live request 256개를 초기 상한으로 둔다.
- 만료 request는 다음 mutation에서 정리하되 감사 journal은 별도로 보존한다.
- state가 손상되면 변경 작업과 승인을 fail-closed하며 자동 초기화하지 않는다.

### 8.2 Journal

각 journal row는 다음의 bounded 값만 가진다.

- event: `decision | requested | approved | consumed | completed | failed | expired`
- Task, Claim, session, adapter, protocol version
- capability/resource canonical IDs
- request ID, operation digest, timestamps
- decision code와 등록된 reason

전체 prompt, raw command, 자유 텍스트 reason, API key, SSH credential, 환경변수 값은
기록하지 않는다. 한 row와 조회 결과에는 기존 control journal과 같은 구조적 상한을
둔다. journal 쓰기 실패는 이미 완료된 operation 결과를 되돌리지 않되 bounded
`journal_warning`으로 측정 공백을 알린다.

---

## 9. 결과와 오류 계약

정상 정책 판정은 exception이 아니라 구조화된 결과다.

```json
{
  "decision": "PERMIT_REQUIRED",
  "request_id": "req-...",
  "summary": "wlan-target-board에서 board.execute",
  "approval_command": "/jhw:unlock req-...",
  "approval_expires_at": "2026-08-25T15:10:00+09:00"
}
```

승인 성공 결과는 별도 `start_by`를 반환한다. 요청 승인 기한과 승인 후 실행 시작 기한을
하나의 모호한 `expires_at` 필드로 합치지 않는다.

이렇게 해야 `ControlError` message가 운영자에게 전달되지 않는 현재 계약에 의존하지
않고 승인 명령을 확실히 보여줄 수 있다. 내부 실패는 stable code를 사용한다.

초기 code 집합:

| code | 의미 | unlock 가능 여부 |
|---|---|---|
| `GUARD_CLAIM_REQUIRED` | 변경 작업에 활성 Claim 없음 | 불가 |
| `GUARD_CLAIM_MISMATCH` | Task/Claim/session/host 불일치 | 불가 |
| `GUARD_WORKTREE_MISMATCH` | 현재 cwd/branch/worktree 불일치 | 불가 |
| `GUARD_RESOURCE_OWNED` | 다른 Task가 resource를 소유 | 불가 |
| `GUARD_REQUEST_NOT_FOUND` | 승인 request 좌표 없음 | 불가, 새 요청 필요 |
| `GUARD_REQUEST_EXPIRED` | 승인 또는 실행 시작 기한 만료 | 불가, 새 요청 필요 |
| `GUARD_PERMIT_MISMATCH` | operation binding 불일치 | 불가, 재평가 필요 |
| `GUARD_PERMIT_CONSUMED` | permit 재사용 시도 | 불가 |
| `GUARD_PROMPT_ORIGIN_UNSUPPORTED` | native prompt origin 미지원 | 불가 |
| `GUARD_UNAVAILABLE` | Guard/Registry/state 검증 실패 | 불가 |

같은 code 안에서 운영자 조치가 갈리면 `details.reason`의 literal 식별자를 쓴다.
신규 reason은 `schemas.ts`의 `ERROR_REASONS` 등록, Guard 스킬 문서의 해석, journal
`error_reason` 기록을 한 변경으로 제공한다. 사용자 조치나 승인 명령을 free-text
exception message에만 넣지 않는다.

모든 결과는 bounded envelope를 지키며 secret/raw private path를 노출하지 않는다.

---

## 10. 설치와 adapter 책임

### 10.1 Protocol handshake

Guard와 adapter는 명시적 protocol version을 교환한다. version mismatch, hook 누락,
필수 event field 누락 시 adapter는 mutation을 허용하지 않는다. 읽기 전용 status는
가능하며 preflight가 정확한 누락 항목을 보여준다.

### 10.2 설치 소유권

- `jhw-notion`
  - `jhw-control guard` 엔진과 상태
  - 공통 adapter executable/protocol
  - Codex·Gemini·OpenCode의 검증된 hook 설치
  - contract fixtures, preflight, install/uninstall 검증
- `claude-config`
  - Claude native `UserPromptSubmit`/`PreToolUse` wiring
  - 공통 adapter executable 호출
  - 로컬 안내 문구가 아닌 중앙 결과 표시

설치기는 선택된 TUI마다 `prompt-origin`, `pre-tool-block`, `execution-recheck` 지원 여부를
검사한다. 일부 hook만 설치된 상태를 완전 보호 상태로 보고하지 않는다.

### 10.3 Runtime mode와 rollout

- 출시 기본값은 `enforce`다.
- `observe`는 개발·fixture 검증에서 명시적으로만 사용한다.
- Guard 장애 시 `observe`로 자동 강등하지 않는다.
- 새 adapter는 native 이벤트의 실제 payload와 차단 semantics를 contract test로
  증명한 뒤 enforce 대상에 넣는다.
- prompt-origin을 증명하지 못한 TUI는 범위 밖 작업을 계속 차단하고 unlock 미지원으로
  표시한다.
- uninstall은 자신이 설치한 hook entry와 symlink만 제거하고 사용자 설정을 보존한다.

권장 rollout 순서:

1. Guard schema·판정·permit state와 fixture 기반 observe 검증
2. Claude/Codex native adapter와 fail-closed preflight
3. publish·Notion/Issue mutation 실행 경계 재검사
4. Board·SSH·F/W·deploy wrapper 재검사
5. Gemini/OpenCode native hook capability를 증명한 뒤 동일 contract 적용

각 단계는 다음 단계가 준비되지 않았음을 숨기지 않는다. 특히 TUI hook만 있는 상태를
고위험 실행 강제가 끝난 상태로 표시하지 않는다.

---

## 11. 검증과 acceptance gate

### 11.1 Unit/property tests

- capability/resource 닫힌 어휘와 unknown field 거부
- canonical operation의 안정적 직렬화와 keyed digest
- Task/Claim/session/worktree mismatch hard deny
- parent/child depth, source index, 비상속 불변식
- dependency가 grant로 변환되지 않음
- request 상태 전이와 invalid transition 거부
- pending/approved 두 기한의 경계값
- 원자적 one-use consume와 replay 거부
- state strict parse, symlink, permission, nlink, atomic-write 검증
- journal redaction과 row/output 상한

### 11.2 Adapter contract tests

- Claude와 Codex가 같은 operation fixture를 같은 결과로 정규화
- 일반 `ok`, `진행`, `다음`, 인용·code block이 unlock되지 않음
- 정확한 `/jhw:unlock req-id` raw user prompt만 승인
- AI tool call과 Bash self-approval 차단
- 승인 후 command/resource/cwd/script 변경 시 mismatch
- adapter/Guard version mismatch가 mutation을 fail-closed
- hook 미설치·오류·timeout이 silent allow가 되지 않음

### 11.3 End-to-end scenarios

1. 같은 repository의 두 child Task가 서로 다른 Claim/worktree에서 병렬 수정한다.
2. `local-hardening` 세션이 `target-matrix`의 상태를 읽어도 board 실행 grant를 얻지 않는다.
3. 범위 밖이지만 소유권 충돌 없는 정확한 작업은 승인 명령을 표시한다.
4. 사용자가 exact unlock을 제출하면 그 operation 한 건만 실행된다.
5. 승인 뒤 10분 내 시작한 장시간 작업은 중간에 permit 만료로 종료되지 않는다.
6. permit을 두 실행이 동시에 소모하면 한 건만 실행된다.
7. 실패·재시도·두 번째 command에는 새 승인이 필요하다.
8. 다른 Task의 active ownership과 Board reservation은 permit으로 우회되지 않는다.
9. Guard/Registry/permit state 손상 시 mutation은 차단되고 read-only status는 가능하다.
10. publish·SSH·board wrapper가 hook의 과거 결과가 아닌 현재 Claim과 permit을 재검사한다.
11. parent terminal 완료가 required child와 integration validation 없이 거부된다.
12. audit 결과에 prompt, raw command, credential, private path가 없다.

### 11.4 Repository gate

구현 변경은 프로젝트 필수 수동 gate를 모두 통과해야 한다.

```bash
cd mcp-server && npm run build
cd mcp-server && npm run typecheck
cd mcp-server && npm test
```

추가로 `install.sh --uninstall` 후 재설치, 각 지원 TUI의 hook preflight, 고위험 wrapper
smoke test를 수행한다. `build`나 `npm test`가 통과해도 `typecheck`를 생략하지 않는다.

---

## 12. 호환성과 migration

- 기존 canonical Task ID와 Issue source index는 유지한다.
- 기존 formal Task를 parent로 전환할 때 Issue mapping을 새 ID로 바꾸지 않는다.
- child는 새 canonical Task ID와 parent reference를 가진 Registry-owned 실행 Task다.
- 기존 temporary Task의 `expected_scope`는 표시·migration 입력으로만 유지하고 runtime
  권한으로 파싱하지 않는다.
- Work Contract가 없는 기존 Claim은 광범위 권한으로 추정하지 않는다. migration
  전에는 read-only status만 허용하거나 명시적 compatibility contract를 생성한다.
- 활성 Claim이 있는 Task의 contract/parent role을 제자리에서 바꾸지 않는다. 먼저
  finish/handoff한 뒤 migration하고 새 Claim을 획득한다.
- Board `purpose` free text는 Task linkage authority가 아니다. 새 wrapper가 Task/Claim
  좌표를 별도로 검증하더라도 기존 Board state schema의 소유권 모델을 바꾸지 않는다.

---

## 13. WLAN 사례에 적용한 기대 결과

현재 Notion/로컬 변경 세션이 `local-hardening` child를 claim했다고 가정한다.

허용:

- `wlan-package` Claim worktree의 파일 검토·수정·commit
- host build/test
- Work Contract에 포함된 Issue comment 또는 Notion 정리
- 다른 child의 bounded status를 dependency로 읽기

차단 또는 별도 승인:

- target board에서 비교 시험 실행
- SSH를 통한 F/W·driver·`iw`·`wpa`·`antcfg` 변경
- 다른 child worktree 수정
- 다른 session의 Claim 또는 Board holder 조작

board operation이 다른 active child에 속하면 hard `DENY`하고 Task switch/owner 조정을
안내한다. 소유 Task가 없고 Board Claim도 충돌하지 않는 단발 작업만
`PERMIT_REQUIRED`가 되며 다음을 표시한다.

```text
/jhw:unlock req-...
```

사용자가 정확히 승인한 뒤 wrapper가 10분 안에 시작하면 permit은 소모되고, 그
wrapper의 장시간 시험은 permit TTL 때문에 중단되지 않는다. 반복 matrix 시험이라면
일회성 permit을 연속 사용하지 않고 `target-matrix` child를 명시적으로 claim한다.

---

## 14. 채택 결과와 의도적 trade-off

얻는 것:

- 대화 문맥과 실제 작업 권한을 분리한다.
- 저장소 하나에서 여러 실행 Task를 안전하게 배치할 수 있다.
- 사용자는 복사 가능한 한 줄로 단발 예외를 승인할 수 있다.
- 고위험 작업은 hook 우회나 stale 판단에 덜 의존한다.
- 승인과 실행의 관계를 사후 감사할 수 있다.

감수하는 것:

- 모든 TUI가 동일 native hook을 제공하지 않으면 초기 지원 범위가 다를 수 있다.
- unknown shell은 오탐 차단이나 추가 승인을 만들 수 있다.
- 별도 OS privilege boundary가 없으므로 악성 same-UID 프로세스 방어는 제공하지 않는다.
- parent/child와 Work Contract 도입으로 Task 시작 입력이 늘어난다.
- file-level 충돌은 여전히 Git 통합 단계에서 해결한다.

이 trade-off는 현재 관측된 실패인 AI의 우발적 task overlap을 직접 막으면서, sudo/polkit
승인의 운영 복잡도는 도입하지 않는 선택이다.

---

## 15. 구현 전 정지 조건

이 문서는 architecture와 behavioral contract만 확정한다. 다음 단계는 별도 구현 계획이며,
계획에는 최소한 다음 순서를 명시해야 한다.

1. 기존 Task schema와 parent/child migration
2. Work Contract와 Guard decision engine
3. host-local request/permit state와 journal
4. Claude/Codex adapter contract
5. execution-layer 고위험 wrapper 통합
6. Gemini/OpenCode capability 검증
7. install/uninstall과 전체 acceptance gate

통합 문서에 대한 사용자 최종 승인이 있기 전에는 구현을 시작하지 않는다.
