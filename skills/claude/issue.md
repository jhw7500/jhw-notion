---
description: "GitHub 이슈 생성 · --review 지원 리뷰어 요청·대기·요약 · --no-review 리뷰 생략 · --timeout 대기한도"
argument-hint: "[title/body] [--review|--no-review] [--timeout <min>]"
---

# /jhw:issue — 좁은 GitHub Issue 생성 + 선택적 리뷰

한 개의 nonempty title과 Change Evidence Contract `v1`을 만족하는 body로 현재 저장소에 Issue를 만든다. `--review`는 실행 시 증명된
지원 reviewer만 요청하고, `--no-review`는 `review:skip`을 적용해 mention을 만들지 않는다.
두 옵션을 생략하면 전역 `review.auto`를 따르며, **키가 없으면 리뷰를 실행하지 않는다**
(automation `v1.59`의 `default_auto_false`와 같은 정책).

이 명령은 assignee, milestone, project, bulk edit를 지원하지 않는다. 리뷰 결과를 받아도 Issue를
수정·닫기·삭제하거나 구현을 시작하지 않으며 URL과 reviewer별 결과만 보고한다.

## Issue body 작성 계약

body는 아래 level-three heading을 정확히 한 번씩, 이 순서로 포함한다. 다른 heading은 추가하지 않는다.

```markdown
### Contract version
v1

### Context and problem
관찰한 문제와 그 문제를 실행 가능한 상태로 만드는 근거

### Goal
달성할 결과

### Non-goals
명시적으로 제외할 범위

### Acceptance criteria
- [ ] 검증 가능한 완료 조건

### Constraints and impact
호환성, 영향 시스템, rollout 제약
```

관찰하지 않은 명령, 결과, 영향, tracker 관계를 추측하거나 만들어내지 않는다. 정보 부재가 허용되는
`Non-goals`와 `Constraints and impact`에서만 `Unknown: 구체적인 이유` 또는
`Not applicable: 구체적인 이유`를 field 전체 값으로 사용할 수 있다. `TBD`, `TODO`, `N/A`,
`unknown`, `미정`, `추후` 같은 placeholder는 근거가 아니다. `Acceptance criteria`에는 중첩되지 않은
실제 Markdown task-list item(`- [ ] ...` 또는 `- [x] ...`)이 하나 이상 있어야 한다.

## 생성·reviewer preflight 계약

고정 순서는 `옵션/content 검증 → write/라벨 정의 preflight → reviewer 발견 → Issue 생성 →
mode 라벨 reconcile/read-back → reviewer별 actor-owned mention`이다. 명시적 `--review`에서
eligible reviewer가 0명이면 Issue 생성 전에 중단한다.

| Reviewer | Required evidence |
| --- | --- |
| Claude | local `claude.yml` regular file + config enabled + 기본 브랜치의 `Claude Code` workflow가 active이고 `issue_comment` event 및 request-comment `run-name` 좌표 지원 |
| Gemini | local `gemini-dispatch.yml` regular file + config enabled + 기본 브랜치의 `Gemini Dispatch` workflow가 active이고 `issue_comment` event 및 request-comment `run-name` 좌표 지원 |
| Codex | 동일 저장소 canary Issue에서 actor-owned 요청 뒤 하나의 Codex bot identity가 실패가 아닌 응답을 반환 |

Gemini Code Assist는 정책상 비활성이며 OpenCode와 함께 PR-only라 Issue reviewer로 추정하지 않는다. secret 값은 조회하거나
존재를 추정하지 않는다. Codex canary 증거는 이 invocation에서만 쓰고 파일·환경 프로필·DB에
저장하지 않는다. usage limit·connector 실패·review 불가를 보고한 canary 응답은 capability 증거가 아니다.

## 설치된 계약 실행기

create와 bounded wait 계약의 정본은 adapter가 설치하는 하나의 self-contained Bash 파일이다.
현재 adapter에 맞는 아래 경로 하나를 사용한다.

- Claude: `$HOME/.claude/commands/jhw/scripts/issue-contract.sh`
- Gemini: `$HOME/.gemini/commands/jhw/scripts/issue-contract.sh`
- OpenCode: `$HOME/.config/opencode/skills/jhw/scripts/issue-contract.sh`
- Codex: `$HOME/.codex/skills/jhw-issue/references/issue-contract.sh`

확정한 title과 body는 caller가 `umask 077`로 만든 자기 소유 임시 디렉터리 안의 새 body file에
기록하고 mode를 정확히 `0600`으로 확인한 뒤 실행한다. 실행기는 현재 uid 소유 regular non-symlink,
link count 1, 최대 65536 bytes, valid UTF-8이며 NUL이 없는 파일만 fd의
`O_NOFOLLOW|O_NONBLOCK` bounded read와 전후 identity·metadata 재검증을 거쳐 받는다. mode는
`request|skip|auto`, timeout은 분 단위 양의 정수다. body의 끝 newline도 그대로 전달한다.

```bash
bash "$HOME/.claude/commands/jhw/scripts/issue-contract.sh" "$title" "$body_file" "$mode" "$timeout"
```

caller는 성공·실패 모두에서 자신이 이번 실행을 위해 만든 private body copy와 그 임시 디렉터리만
`EXIT` cleanup한다. 사용자가 제공한 원본 파일은 삭제·chmod·덮어쓰기하지 않는다.
선택한 adapter 경로에 파일이 없거나 읽을 수 없으면 Markdown 코드로 fallback하지 않고 중단한다.
실행기는 현재 인증 환경을 그대로 사용하며 token 값을 읽거나 출력하거나 자동으로 unset하지 않는다.
기존 `gh auth login` 인증을 `GITHUB_TOKEN`이 가리는 경우에만 운영자가 명시적으로
`env -u GITHUB_TOKEN bash <adapter-path> ...`를 선택할 수 있다.


## bounded review wait 계약

요청된 reviewer만 private invocation state에서 추적한다. 한 번의 collect/classify pass는 read-only이며,
agent harness가 약 60초 간격으로 모든 요청 reviewer가 terminal이거나 전체 deadline에 도달할 때까지
반복한다. untracked `&`/`nohup`과 60초를 넘는 foreground sleep은 사용하지 않는다.
workflow run은 `jhw-review-comment-<request_comment_id>`라는 정확한 `display_title`을 가진 경우에만
그 reviewer 요청의 acknowledgment·failure 좌표로 사용한다. 뒤이은 다른 reviewer/Codex 멘션이 깨운
같은 이름의 run은 request comment ID가 다르므로 현재 판정에서 제외한다.
워크플로 파일은 `path`의 `<workflow-file>`과 `<workflow-file>@<ref>` 형식을 모두 받아 정확히
비교한다. ref가 붙으면 비어 있거나 공백을 포함한 값은 거부한다.

bounded wait 구현도 같은 설치 파일에 포함되며, create 뒤 같은 프로세스에서
`jhw_issue_execute`가 정확히 한 번 연결한다.

실행 시작 시 private summary state와 현재 활성 signal snapshot 좌표를 추적하고
`jhw_issue_install_execution_cleanup`으로 `EXIT/HUP/INT/TERM` 정리를 등록한다. partial failure,
timeout, 중단 신호에서도 summary state와 0600 signal snapshot만 제거하며 생성된 Issue는 보존한다.
설치 전에 있던 caller-owned trap 사양은 정상 epilogue와 신호 처리 모두에서 그대로 복원한다.
GitHub의 UTC 시각은 초 단위이므로 요청과 응답이 같은 초에 기록될 수 있다. 댓글은 같은 초일 때
요청 댓글보다 큰 comment ID만 후속 신호로 인정하고, reaction은 정확한 요청 댓글의 reactions
endpoint에 종속되므로 같은 초를 허용한다. workflow run도 정확한 request comment ID를
`display_title`에 담으므로 요청 시각과 같은 초부터 인정하되, 다른 멘션의 run은 제외한다.
같은 요청에 여러 relevant workflow run이 있으면 `run_started_at`, `run_attempt`, `created_at`, run ID
순으로 가장 최신 attempt만 workflow 실패 판정에 사용하므로 성공한 재시도는 이전 실패를 대체한다.
relevant run ID·attempt가 양의 safe integer가 아니거나 attempt 시작 시각이 유효하지 않으면 정렬 권한을
정할 수 없어 classifier가 fail-closed한다. bot 댓글도 같은
순서의 최신 substantive 댓글만 판정하며, 거절 reaction은 그 댓글이 없거나 더 나중일 때만 우선한다.
선택된 run 이후의 bot 댓글은 시각 차이와 무관하게 본문이 그 run의 검증된 `html_url`을 정확히
참조할 때만 verdict로 인정한다. 좌표 없는 댓글과 run 좌표를 담을 수 없는 reaction은 인정하지 않는다.
첫 attempt는 run 시작과 같은 초의 정확한 run-link 댓글을 허용하지만, re-run은 이전 attempt 댓글과
초 단위로 구분할 수 없으므로 최신 attempt 시작 시각보다 엄격히 뒤의 댓글만 인정한다.
run 좌표를 담은 non-failure verdict도 선택된 run이 완료되기 전에는 terminal로 판정하지 않고
`PENDING(workflow_in_progress)`으로 재poll한다.
선택된 reviewer 응답의 usage-limit·quota 소진 또는 provider/connector/environment 실패는 구현
지적이 아니므로 `FEEDBACK`이 아니라 `FAILED(connector_rejected)`로 분류한다.
댓글과 reaction이 같은 초면 교차 타입 순서를 증명할 수 없어 `PENDING`으로 재poll한다. 최신 retry
run보다 오래되거나 같은 초지만 상관 좌표가 없는 댓글·reaction도 terminal 신호에서 제외한다. 요청 reviewer가 없고 capability
부재로 unavailable reviewer가 있으면 highest disposition은 `UNAVAILABLE`이다. 명시적 skip이나
`review.auto=false`처럼 unavailable도 없는 의도적 no-review는 기존 `CLEAN`을 유지한다.

## 실행 규칙

- title/body를 먼저 확정한다. 내용이 모호하면 생성 전에 한 번만 질문한다.
- `--timeout` 기본값은 20분이며 양의 정수만 허용한다.
- `--reviewers` 같은 임의 capability override는 없다. eligible matrix를 통과한 reviewer만 요청한다.
- partial reviewer unavailable은 나머지 eligible reviewer 요청을 막지 않는다.
- mention 이후 실패해도 생성된 Issue URL을 보존하고, Issue edit/close/delete/PATCH나 자동 구현을 하지 않는다.
