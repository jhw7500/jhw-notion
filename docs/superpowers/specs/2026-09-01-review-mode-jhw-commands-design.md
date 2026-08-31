# `/jhw:pr` 및 Issue 리뷰 모드 명령 설계

- 날짜: 2026-09-01
- 대상: `jhw7500/jhw-notion#99`
- 선행 계약: `jhw7500/automation` `v1.51`
  (`ccd1b6f3e1833c82d73826c1332cc6e3e4841d30`)
- 상태: 사용자 설계 개요 승인; 문서 검토 대기

## 목표

PR 생성·갱신과 GitHub Issue 등록에서 AI 리뷰 정책을 실행별로 선택할 수 있게 한다.

- `/jhw:pr --review`는 리뷰를 명시적으로 요청한다.
- `/jhw:pr --no-review`는 리뷰를 명시적으로 생략한다.
- 옵션을 생략하면 저장소의 기존 리뷰 설정을 그대로 따른다.
- `/jhw:pr`을 정본으로 만들고 기존 `/jhw:ship`은 인자 호환 alias로 유지한다.
- 새 `/jhw:issue`는 지원이 확인된 Issue 리뷰어만 요청하고 bounded wait 결과를 요약한다.
- 기존 PR 리뷰 대기, 자동 수정, 테스트, 병합 안전 게이트를 보존한다.

## 범위와 비범위

이 저장소가 소유하는 변경 범위는 다음뿐이다.

- Claude 정본 스킬 `pr.md`, `ship.md`, `issue.md`
- 정본 스킬의 계약 테스트와 설치 안전성 테스트
- Codex 생성 스킬 동기화 결과
- `README.md`와 스킬 인벤토리 문서

다음은 변경하지 않는다.

- `.github/workflow-config.yml`의 현재 기본값
- automation workflow, 재사용 workflow, App 전역 설정
- MCP 서버, Notion DB, Project Control 상태 또는 새 실행 서비스
- assignee, milestone, project, bulk edit 등 일반 Issue 관리 기능
- 리뷰 결과를 이용한 Issue 본문 편집, 종료 또는 자동 구현
- 새 설정 파일이나 영구 상태 DB

## 선택한 구조

현재의 완성도 높은 `skills/claude/ship.md`를 `skills/claude/pr.md`로 이동해 유일한 PR 정본으로
삼는다. 새 `ship.md`는 deprecation 안내와 원래 인자를 `/jhw:pr`에 그대로 전달하는 얇은 alias만
담는다. Issue 생성은 PR 상태 기계와 별개이므로 새 `issue.md`에 좁은 독립 workflow로 둔다.

`ship.md`를 계속 정본으로 두고 `pr.md`를 alias로 만드는 방법은 새 공개 이름과 구현 정본이
어긋난다. 두 파일에 전체 PR workflow를 복제하는 방법은 약 500줄 규모 계약을 두 군데서 유지해야
하므로 선택하지 않는다.

## 리뷰 모드와 현재 저장소 기본값

명령은 모든 mutation 전에 옵션을 다음 세 mode로 해석한다.

| 입력 | mode | durable override |
| --- | --- | --- |
| `--review` | `request` | `review:request`만 유지 |
| `--no-review` | `skip` | `review:skip`만 유지 |
| 옵션 없음 | `auto` | 두 override 라벨 모두 제거 |

`--review --no-review`는 상호 배타적이다. 둘을 함께 주면 라벨 생성·수정, push, PR/Issue 생성,
댓글, workflow dispatch, merge를 하나도 실행하지 않고 실패한다.

`auto`는 리뷰를 끈다는 뜻이 아니라 저장소 설정을 따른다는 뜻이다. automation `v1.51`의 PR
workflow 우선순위는 `workflows.<reviewer>.auto -> review.auto -> true`이고 외부 App 및 Issue 리뷰는
`review.auto -> true`를 따른다.

현재 `.github/workflow-config.yml`은 `claude-code-review.auto`와 `gemini-auto-review.auto`가 모두
`true`이고 전역 `review.auto`는 없다. 따라서 현재 저장소에서 옵션 생략은 호환 기본값을 포함해
자동 리뷰가 켜진 상태다. Task #99는 이 설정을 바꾸지 않는다. 실행별로 확실히 끄려면
`--no-review`를 사용하며, 기본값을 끄는 fleet/config 변경은 별도 작업이다.

`review:request`와 `review:skip`이 동시에 관측되면 configuration conflict로 fail-closed한다. 명령은
선택한 라벨을 적용하기 전에 반대 라벨을 제거하고, `auto`에서는 둘 다 제거한다. 적용 결과는 GitHub
API로 다시 읽어 검증한다.

## `/jhw:pr` 공개 계약

```text
/jhw:pr [기존 옵션] [--review | --no-review]
```

기존 `--merge`, `--target`, `--auto-fix`, `--base`, `--reviewers`, `--timeout`, `--max-rounds`,
`--block-on`의 의미를 유지한다. 리뷰 mode는 PR을 자동 병합하게 만들거나 CI와 target test를 약화하지
않는다. `--reviewers`는 기다릴 reviewer subset을 고르는 옵션이며 저장소 전체의 review override
라벨을 reviewer별 enable switch로 바꾸지 않는다.

`/jhw:ship`은 모든 인자를 `/jhw:pr`에 그대로 전달하고 replacement를 한 번 안내한다. 자체 PR 생성,
리뷰, 수정 또는 병합 절차를 복제하지 않는다.

### 새 PR 순서

리뷰 시작 event가 override 라벨보다 먼저 도착하는 경합을 막기 위해 다음 순서를 고정한다.

1. 옵션·권한·workflow capability·App prerequisite를 검사하고 고정 라벨 정의를 보장한다.
2. 필요한 branch commit을 push한다.
3. draft PR을 만든다.
4. draft 상태에서 선택 mode의 라벨을 reconcile한다.
5. 원격 라벨, draft 상태와 정확한 40자리 head SHA를 다시 검증한다.
6. PR을 ready for review로 전환한다.
7. effective policy가 request이면 ready 상태의 정확한 head에 외부 App 요청을 남긴다.

automation `v1.51` caller는 draft에서 provider를 호출하지 않고 `ready_for_review`를 처리한다. 따라서
`opened` event와 `gh pr create`의 라벨 적용 시점에 의존하지 않는다.

### 기존 PR의 새 head

push 전에 override 라벨을 reconcile하고 API read-back으로 확인한다. 그 다음 push하여
`synchronize` event가 의도한 mode를 보게 한다. 외부 App 요청은 원격 PR head가 방금 push한
40자리 SHA와 일치하는 것을 확인한 뒤에만 게시한다.

### 기존 PR의 같은 head

명시적 `--review`는 설치·활성화된 중앙 workflow의 승인된 `force_review` dispatch와 외부 App의
수동 요청을 head당 한 번만 실행한다. 옵션 생략 `auto`는 같은 head의 리뷰를 강제로 반복하지 않는다.

App 요청의 허용 쌍은 닫힌 목록이다.

| reviewer | 요청문 |
| --- | --- |
| Codex | `@codex review` |
| Gemini Code Assist | `/gemini review` |

명령 소유 댓글에는 reviewer와 정확한 head SHA를 담은 hidden marker를 붙인다. 같은 actor가 남긴 동일
reviewer/head marker가 정확히 하나 있으면 재사용하고, 과거 head marker는 현재 요청을 막지 않는다.
동일 marker가 여러 개면 임의 선택하지 않고 trigger failure로 보고한다. 기존 `jhw-ship` marker도
호환 입력으로 인식해 마이그레이션 직후 중복 요청을 막는다.

설치되지 않았거나 비활성인 특정 reviewer는 `UNAVAILABLE`로 보고하되 다른 지원 reviewer와 PR 생성
자체를 실패시키지 않는다. 실제 요청 API 실패는 채널별 `FAILED`로 남기며 이미 생성된 branch와 PR은
보존한다.

### 외부 App 전제

두 override 라벨은 저장소 관리형 workflow만 직접 제어한다. 외부 App이 PR-open 자동 리뷰를 별도로
수행하면 `review:skip` 라벨로 그것을 취소할 수 없으므로 command-level policy 활성화 전 다음 운영
전제가 충족되어야 한다.

- Codex repository Code review 접근은 유지하되 Automatic reviews는 꺼져 있어야 한다. 명령은 계정 또는
  App 설정을 변경하지 않고, 확인된 저장소에서 수동 `@codex review`만 사용한다.
- Gemini Code Assist가 설치된 저장소는 기존 `.gemini/config.yaml`의 다른 키를 보존하면서 PR-open
  code review만 꺼져 있어야 한다. 명령은 수동 `/gemini review`만 사용한다.

이 전제를 확인할 수 없다는 이유로 이미 만든 일반 PR을 삭제하지는 않는다. 다만 `--no-review` 보장을
검증할 수 없는 저장소는 rollout/canary 단계에서 활성화 완료로 판정하지 않는다. Task #99는 해당 전역
또는 저장소 App 설정 자체를 수정하지 않는다.

### 정확한 head와 리뷰 완료

모든 PR 요청·대기·결과에는 검토 대상 40자리 head SHA를 표시한다. 기존 automation 결과의
`- Reviewed: <40자리 SHA>`가 현재 원격 PR head와 정확히 같을 때만 현재 리뷰 완료로 인정한다.
대기 중 head가 바뀌면 이전 결과를 폐기하고 새 head의 policy를 다시 해석한다.

reviewer별 상태는 기존 계약의 `CLEAN`, `FEEDBACK`, `FAILED`, `TIMEOUT`을 유지한다. trigger가
거부되거나 workflow가 실패한 경우를 timeout으로 완화하지 않는다.

### 자동 수정과 병합

`--auto-fix`의 기본 반복 상한을 3에서 5라운드로 올린다. `--max-rounds <n>`은 양의 정수 실행별
override이며 PR 속성이나 영구 상태가 아니다. 수정 push마다 새 head를 검증하고 필요한 reviewer를
head당 한 번 재요청한다. pending, failed, timeout reviewer가 있는 동안 다음 수정 push를 만들지 않는다.

effective `request`에서는 계획된 AI reviewer, required GitHub checks, 선택한 target test를 모두
기다린다. `skip`에서는 AI 요청과 AI wait만 생략하고 required CI, target test, current head,
mergeability와 merge method 검증은 그대로 실행한다.

`--no-review --merge`는 두 옵션을 사용자가 모두 명시했을 때 허용한다. 최종 receipt에는 다음 사실을
명확히 남긴다.

```text
AI review: explicitly skipped (--no-review; review:skip)
```

## `/jhw:issue` 공개 계약

```text
/jhw:issue [title/body] [--review | --no-review] [--timeout <분>]
```

title과 body는 사용자 입력 또는 현재 task context에서 mutation 전에 하나로 확정한다. 모호하면 먼저
사용자에게 확인한다. `--timeout`은 양의 정수이고 기본값은 20분이다.

### reviewer 발견

Issue를 만들기 전에 지원 reviewer plan을 확정한다.

- Claude는 관리형 Issue mention caller가 설치되고 활성화된 경우만 eligible이다.
- 중앙 Gemini는 문서화된 Issue chat/dispatch caller가 설치·활성화·구성된 경우만 eligible이다.
- Codex는 해당 저장소에서 standalone Issue 응답 capability가 명시적으로 등록되었거나 성공한 canary가
  확인된 경우만 eligible이다. PR 지원을 Issue 지원으로 추측하지 않는다.
- Gemini Code Assist와 현재 OpenCode review 계약은 PR 전용이므로 standalone Issue에서 요청하거나
  기다리지 않는다.

secret 값은 GitHub API로 확인할 수 있다고 주장하지 않는다. 설치·활성 상태가 확인되어도 runtime
authentication이 실패할 수 있으며 이 경우 `FAILED`와 Actions URL을 보고한다.

명시적 `--review`인데 eligible reviewer가 하나도 없으면 Issue 생성 전에 중단한다. 일부 채널만
지원되지 않는 경우 그 채널을 `UNAVAILABLE`로 표시하고 나머지 계획으로 계속한다. `skip`은 reviewer를
계획하지 않는다. `auto`는 전역 `review.auto`와 호환 기본값으로 요청 여부를 정한다.

### 생성과 요청 순서

다음 순서를 고정한다.

```text
옵션·내용 검증
-> 라벨 정의 보장
-> reviewer plan 확정
-> Issue 생성
-> 선택 라벨 적용 또는 auto에서 두 라벨 제거
-> API read-back 검증
-> 계획된 reviewer별 요청 댓글 1개 게시
```

명시적 요청 marker는 Issue 단위 reviewer별로 고정한다.

```text
<!-- jhw-issue:review-request reviewer=claude -->
<!-- jhw-issue:review-request reviewer=gemini -->
<!-- jhw-issue:review-request reviewer=codex -->
```

resume 시 같은 actor의 marker 하나를 재사용한다. 동일 reviewer marker가 여러 개면 임의 응답을 고르지
않고 `FAILED`로 보고한다. 코드 좌표가 없는 standalone Issue에는 commit SHA를 억지로 붙이지 않는다.
Issue가 PR 또는 commit 코드 검토를 명시하면 그 코드 결과에만 정확한 SHA 규칙을 적용한다.

### bounded wait와 결과

요청 댓글 ID와 Issue 생성 시각 이후의 댓글, 요청 댓글 reaction, 관련 Actions run만 관찰한다. 짧은
trigger acknowledgment 구간에서 요청이 거부되면 `FAILED`, 수락됐지만 전체 timeout까지 최종 응답이
없으면 `TIMEOUT`이다.

계획된 reviewer 상태는 `PENDING`, `CLEAN`, `FEEDBACK`, `FAILED`, `TIMEOUT`이며, preflight에서 제외된
채널은 별도로 `UNAVAILABLE`이다. 모든 요청 reviewer가 terminal이 되거나 deadline에 도달하면 다음을
요약한다.

- Issue URL
- 요청 reviewer와 unavailable reviewer
- reviewer별 상태와 응답 또는 Actions URL
- 가장 높은 actionable disposition
- timeout/failure diagnostic

우선순위는 `FAILED/TIMEOUT > FEEDBACK > CLEAN`이다. partial failure와 timeout에서도 생성한 Issue를
보존하고 URL을 반환한다. 명령은 Issue edit, delete, close, milestone/project mutation이나 피드백 자동
구현을 실행하지 않는다.

## 오류 및 복구

- invalid option/content/timeout: 모든 mutation 전에 실패한다.
- 라벨 또는 write permission 부재: prerequisite 라벨 생성 이외의 push/PR/Issue mutation 전에 실패한다.
- 두 override 라벨 동시 관측: conflict로 실패하고 AI provider를 호출하지 않는다.
- push 뒤 요청 실패: branch와 PR을 보존하고 같은 head에서 idempotent resume를 허용한다.
- Issue 생성 뒤 reviewer 실패·timeout: Issue를 보존하고 부분 결과를 반환한다.
- 대기 중 PR head 변경: stale 결과를 폐기하고 새 head policy로 재시작한다.
- 배포된 workflow capability가 오래됨: override가 지켜진다고 가장하지 않고 mutation 전에 중단한다.

## 파일 책임

- `skills/claude/pr.md`: PR 생성·갱신·review wait·auto-fix·merge의 유일한 정본
- `skills/claude/ship.md`: `/jhw:pr`로 원본 인자를 전달하는 deprecated alias
- `skills/claude/issue.md`: 좁은 Issue 생성·review plan·wait·summary 정본
- `scripts/test-pr-skill-contract.mjs`: 기존 ship 실행 계약과 새 mode/order/dedup 계약
- `scripts/test-issue-skill-contract.mjs`: Issue option/discovery/order/wait/preservation 계약
- `scripts/test-install-safety.sh`: 두 skill 계약 및 설치 안전 게이트
- `skills/claude/AGENTS.md`, `README.md`: 공개 인벤토리, 옵션과 최소 예시
- `skills/codex/jhw-pr`, `skills/codex/jhw-ship`, `skills/codex/jhw-issue`: sync script 생성물

생성된 Codex 파일은 직접 수정하지 않는다. `node scripts/sync-codex-skills.mjs`로 생성하고 `--check`로
정본과의 drift가 없음을 검증한다.

## 테스트 전략

구현은 계약 테스트를 먼저 실패시키는 TDD 순서로 진행한다.

PR 계약은 최소한 다음을 검증한다.

1. option 상호 배타성과 mutation zero
2. 새 PR의 draft → label verify → ready 순서
3. 기존 PR의 label verify → push 순서
4. auto mode의 두 override 제거와 config fallback
5. 정확한 App command, 40자리 head marker와 head별 중복 방지
6. skip에서 AI 요청·대기 0회, required CI·target gate 유지
7. 명시적 skip merge receipt
8. auto-fix 기본 5라운드와 실행별 override
9. 현재 head와 다른 `Reviewed` 결과 거부
10. 기존 ship 옵션·review 분류·merge 안전 계약 회귀 없음

Issue 계약은 최소한 다음을 검증한다.

1. option 상호 배타성, title/body/timeout validation과 mutation zero
2. 지원 reviewer 발견 및 zero-reviewer request의 생성 전 실패
3. create → label verify → mention 순서
4. reviewer별 marker 중복 방지
5. `CLEAN|FEEDBACK|FAILED|TIMEOUT|UNAVAILABLE` 분류
6. trigger failure와 timeout의 구분
7. partial failure에서도 Issue 보존 및 URL 반환
8. Issue edit/delete/close와 자동 구현 호출 0회

최종 검증 명령은 다음과 같다.

```bash
node scripts/test-pr-skill-contract.mjs
node scripts/test-issue-skill-contract.mjs
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
bash scripts/test-install-safety.sh
cd mcp-server && npm run typecheck
cd mcp-server && npm run build
cd mcp-server && npm test
git diff --check origin/main...HEAD
```

## 배포와 중지 조건

구현 PR은 automation `v1.51`의 immutable commit과 현재 저장소 caller 계약을 다시 확인한 뒤 연다.
최종 head에 대해 required tests, skill sync, install safety, 요청 reviewer 결과가 모두 확인된 경우에만
병합한다.

다음 중 하나라도 관측되면 배포를 중지한다.

- draft 또는 `review:skip`/conflict 상태에서 provider 호출
- 라벨 검증 전 review-triggering push
- 같은 reviewer/head의 중복 App 요청
- stale head 리뷰를 현재 완료로 수락
- required CI, target, current-head 또는 mergeability gate 우회
- 생성된 Codex skill과 Claude 정본의 drift

병합 후 설치가 필요하면 삭제 예정이 없는 영구 checkout에서 `install.sh`를 실행한다. Task 전용 임시
worktree를 설치 심링크 대상으로 사용하지 않는다.
