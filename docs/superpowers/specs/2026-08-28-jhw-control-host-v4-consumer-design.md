# jhw-control-host v4 Consumer 전환 설계

- 날짜: 2026-08-28
- 상태: 사용자 승인된 cross-repository 설계의 consumer 범위
- 원본: `jhw7500/claude-config@8dd9e9a:docs/superpowers/specs/2026-08-27-jhw-control-host-v4-lifecycle-design.md`
- 대상: `jhw7500/jhw-notion#74`

## 목표

`skills/claude/task.md`에 남은 raw `jhw-control task ...` 호출을 설치된
`"$HOME/.local/bin/jhw-control-host" task ...` 호출로 전환한다. Task lifecycle 전체가
secure-store-only credential 경계를 사용하되 기존 사용자 승인, 순서, 오류 정지 조건과 보고 형식은
그대로 유지되어야 한다.

## 변경 범위

- 정본 `skills/claude/task.md`의 `child-start`, `status`, `contract`, `handoff`, `promote`,
  `completion-ready`, `recover`, `assert-owner` 호출을 absolute host path로 전환한다.
- 이미 host를 사용하는 `start`와 `finish`는 변경하지 않는다.
- `scripts/test-task-skill-contract.mjs`가 raw Task lifecycle 호출 부재와 여덟 전환 대상의 exact
  absolute host invocation 개수를 고정한다.
- `skills/codex/jhw-task/references/task.md`는 정본 심링크로 유지하고 직접 수정하지 않는다.

## 불변 조건

- 설치된 producer contract는 version `4`, credential policy `secure-store-only`여야 한다.
- canonical Task command는 `start`, `child-start`, `contract`, `completion-ready`, `promote`,
  `status`, `handoff`, `finish`, `recover`, `assert-owner` 열 개다.
- raw CLI fallback, shell credential export, config source/read를 추가하지 않는다.
- 사용자 authorization gate, no-retry, no-takeover, resume/switch/recovery 순서와 start 성공의 네 필드
  (`task_id`, `claim_id`, `branch`, `worktree_ref`) 보고를 변경하지 않는다.
- lifecycle 정책은 `jhw-task`가 결정하며 host가 switch 또는 migration을 자동 결정한다고 설명하지 않는다.
- Codex와 Claude consumer는 `skills/claude/task.md` 한 정본에서 동기화한다.

## 수용 조건

- `skills/claude/task.md`에 raw `jhw-control task` invocation이 없다.
- 여덟 전환 대상의 모든 executable example이 exact
  `"$HOME/.local/bin/jhw-control-host" task <subcommand>` 형식을 사용한다.
- 기존 start, finish, switch 실행 계약 테스트가 그대로 통과한다.
- Codex skill sync check, Task skill contract test, install safety, MCP typecheck/test/build가 통과한다.
- merge 뒤 stable checkout에서 `install.sh`를 실행하고 설치된 Codex reference가 같은 정본을 가리킨다.

## Rollout 경계

producer v4 설치와 clean preflight 검증은 consumer 배포 전 완료되어야 한다. Consumer merge·install 뒤의
#74 legacy Task migration은 이 코드 변경과 분리해 `jhw-task` 정본 절차로 수행한다. live Task/Claim
좌표는 repository 문서에 기록하지 않고 bounded `task status` 결과에서 실행 시점에만 승계한다.
