# 설치된 Issue·Task 계약 실행기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 기존 Issue create/wait와 Task finish 계약을 설치된 Bash 파일로 실행한다.

**Architecture:** 기존 계약을 의미 변경 없이 `skills/claude/scripts/`의 독립 파일 두 개로 옮긴다. Issue의 create와 wait는 한 프로세스의 `jhw_issue_execute`로 연결하고, Task finish는 기존 host launcher를 정확히 한 번 호출한다. 기존 adapter 디렉터리 링크를 사용하며 Codex helper 참조만 생성기에 추가한다.

**Tech Stack:** Bash, Node.js 계약 테스트, 기존 runtime release/installer.

**Spec:** https://github.com/jhw7500/jhw-notion/issues/210 (사용자가 구현 진행 승인).

## Global Constraints

- 기존 승인 경계·reviewer 판정·Task lifecycle·launcher 인자와 실패 종료코드를 바꾸지 않는다.
- 실제 Issue 생성·Task/Claim 변경·live 배포는 테스트에 사용하지 않는다.
- 새 의존성·bootstrap entrypoint·Control subcommand·HOME 공용 링크를 추가하지 않는다.
- helper 전체에 새로운 admission lease가 생겼다고 주장하지 않는다. 실제 control 실행은 기존 host launcher가 보호한다.
- script는 한 파일에 필요한 함수를 포함하며 실행 중 다른 current-generation helper를 다시 source하지 않는다.
- Git 실행 파일 mode 0755를 유지하며 helper 없는 retained release를 새 REQUIRED 항목으로 거부하지 않는다.
- `skills/codex/`는 생성기로만 갱신한다. 인증 환경은 기본적으로 그대로 유지한다.
- publish·PR·merge·운영 배포는 기존 개별 승인 경계를 따른다.

## Review Focus

- 공백·따옴표·달러/백틱을 포함한 제목·validation이 코드로 실행되지 않고 exact argv로 전달된다.
- 실패한 finish는 한 번만 호출되고 switch start를 실행하지 않으며 원래 종료코드를 전달한다.
- 설치 경로가 빠지거나 실행 파일을 읽을 수 없으면 Markdown 코드 fallback 없이 실패한다.
- Codex만 설치된 HOME과 Claude/Gemini/OpenCode 경로에서 각각 독립적으로 helper를 찾는다.
- prepare의 hash/mode·symlink confinement과 helper 없는 retained release 호환성을 유지한다.

---

### Task 1: Issue 계약을 self-contained 실행 파일로 이동

**Files:**
- Create: `skills/claude/scripts/issue-contract.sh`
- Modify: `skills/claude/issue.md`
- Test: `scripts/test-issue-skill-contract.mjs`

**Interfaces:**
- Consumes: 기존 `REPO_NWO`·환경 및 위치 인수 title/body-file/mode/timeout.
- Produces: source 시 기존 함수만 정의; 직접 `bash <script> <title> <body-file> request|skip|auto <timeout>` 실행 시 `jhw_issue_execute` 한 번 호출.

- [x] 설치 fixture의 실제 helper를 실행하는 성공·PENDING→timeout·missing helper 회귀를 작성하고 실패를 확인한다.
- [x] 기존 create/wait 두 블록을 함수/상수 그대로 하나의 script로 옮기고 최소 직접 실행 진입만 추가한다.
- [x] 테스트의 함수별 검사도 Markdown 추출 대신 같은 canonical 파일을 source하도록 옮긴다.
- [x] 문서는 각 adapter 설치 경로·직접 실행·인증 환경의 명시적 선택을 설명한다. 토큰 원문을 읽거나 기본 인증을 자동 교체하지 않는다.
- [x] Issue 계약 전체와 구문 검사를 통과시킨다.

### Task 2: Task finish를 직접 파일 실행으로 연결

**Files:**
- Create: `skills/claude/scripts/task-finish.sh`
- Modify: `skills/claude/task.md`
- Test: `scripts/test-task-skill-contract.mjs`

**Interfaces:**
- Consumes: 기존 `JHW_FINISH_*`·current Task/Claim·handoff 환경과 repeatable validation argv.
- Produces: 기존 exact host `task finish` argv, 성공 또는 원래 nonzero. switch는 같은 실행 파일의 성공 뒤에만 기존 start tail을 실행한다.

- [x] 기존 standalone finish 테스트를 설치 fixture의 실제 파일 직접 실행으로 전환하고 missing helper 실패를 먼저 확인한다.
- [x] 상태별 completed/handoff/abandoned·빈 validation·금지된 필드·특수문자·host nonzero 회귀를 유지한다.
- [x] 기존 finish 본문을 실행 파일로 이동한다. 문서의 canonical finish 블록은 adapter별 경로 선택과 파일 실행/종료코드 전달만 담당한다.
- [x] switch 실패 후 start가 실행되지 않고 원래 argv가 유지되는 계약 전체를 통과시킨다.

### Task 3: adapter 참조와 release 설치 통합 검증

**Files:**
- Modify: `scripts/sync-codex-skills.mjs`, `scripts/test-runtime-store.mjs`, `scripts/test-install-safety.sh`, `scripts/test-claude-command-dir-contract.mjs`, `README.md`
- Generate: Codex issue/task의 helper reference symlink

**Interfaces:**
- Consumes: 위 canonical helper 이름 두 개.
- Produces: `references/issue-contract.sh`와 `references/task-finish.sh`의 release 내부 상대 symlink; 기존 directory wiring으로 설치.

- [x] generator가 helper reference 누락을 검사하고 정상 link를 생성·보존하는 실패 테스트를 먼저 추가한다.
- [x] command별 고정 helper allowlist를 추가하고 source 파일의 존재·mode를 확인한다. unrelated orphan 정리 동작을 유지한다.
- [x] release manifest에 helper bytes/mode가 포함되고 기존 retained release 검증도 통과하는 테스트를 추가한다.
- [x] 격리 HOME 설치의 실제 adapter helper 경로에서 controlled fake GH/host로 실행한다. 운영 서비스·Task·Issue는 건드리지 않는다.
- [x] 정본 문서와 생성물을 동기화하고 모든 skill contract·MCP build/typecheck/test·runtime suite·installer safety를 실행한다.
- [x] 가능한 범위에서 Claude Code의 실제 Bash 도구에 파일 실행을 제출하여 과거 shell -c 거부가 없는지 확인한다. 이 검증을 못 하면 명시적으로 남기며 fixture 결과를 실제 Claude 증거로 바꾸지 않는다.
- [x] 전체 diff를 독립 검토하고 Change Evidence 계약으로 로컬 커밋을 준비한다. 다음 publish 단계 전에 기존 승인 경계를 적용한다.

## 기준선

- `node scripts/test-issue-skill-contract.mjs`: exit 0, 24.496초.
- `node scripts/test-task-skill-contract.mjs`: exit 0, 6.804초.
- 기준 commit: `fa1f621b9e91b1e1d7e671561f5af8b881a87068`.

## 구현 중 확인한 보완

- command 디렉터리 검사는 기존의 모든 entry=Markdown 가정을 scripts asset 디렉터리 하나의 고정 allowlist로 확장한다. 다른 디렉터리나 비스킬 Markdown은 계속 거부한다.
- 새 Issue body-file 경계는 current-user-owned 단일 링크 0600 regular file, 최대 65536 bytes와 UTF-8/no-NUL, no-follow descriptor read 및 읽기 전후 동일성을 요구한다. 원본 create/wait text API는 변경하지 않는다.

## 최종 검증

- MCP: 77파일, 2211개 통과; build/typecheck exit 0.
- 런타임: 270개 통과, 실패/skip 0.
- 모든 스킬 계약, helper 참조 생성 3개, 전체 설치 안전성 exit 0.
- Claude Code 2.1.319, auto 모드, Bash 도구 1회: 통제된 fake host 호출 정확히 1회, 권한 거부 0. 허용 규칙이나 권한 우회 옵션을 추가하지 않았다.
- 독립 검토의 body-file 안전성 지적 1건을 RED→GREEN으로 보완했다.
- publish·PR·배포는 실행하지 않았다.
