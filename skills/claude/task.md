---
description: Use when the user explicitly requests a Project Control Task start, existing-Task resume, promotion, Handoff, finish, a finish-then-start switch, recovery, says 태스크 받아서 or 작업준비, or asks to receive or continue from a HANDOFF*.md file
argument-hint: "(start | resume | promote | handoff | finish | switch | recover) <task-or-issue>"
---

# /jhw:task — 명시적 Task 제어

사용자가 Project Control Task 동작을 **명시적으로 요청했을 때만** 사용한다. 읽기 전용 조사·리뷰에는 Claim을 만들지 않는다. 일반 Notion workflow를 이 스킬로 자동 전환하지 않는다.

## 컨텍스트와 보안 경계

- 현재 요청, 현재 checkout의 직접 사실, command가 반환한 bounded 결과만 사용한다.
- 이전 session, Notion, memory, recall/load/cclog, 광범위 Git history를 자동으로 읽지 않는다.
- canonical `task_id`·`repo_id`·`claim_id`, Issue node/revision을 추측하지 않는다.
- token, private configured path, secret-like text를 content flag/Handoff/output에 넣지 않는다. `--repo-path`는 command에만 전달하고 응답에 반복하지 않는다.
- nonzero exit에서 자동 reset/rebase/force/retry/takeover하지 않는다.

## Task start authorization gate

새 Task 등록·기존 Task 재개·Handoff에서의 재개·switch의 후속 start는 사용자가 명시적으로 요청하거나 승인했을 때만 실행한다. 그 요청/승인은 이 흐름의 승인이다. 이미 명시적으로 승인했다면 두 번째 승인을 묻지 않는다. 승인되지 않았다면 start 전에 한 번만 승인을 받는다.

모든 `task start`는 아래 순서로 실행한다. raw config·`.env`를 source/read하지 않고, raw `jhw-control`을 호출하지 않는다. `preflight`가 nonzero이면 그 exit로 즉시 멈추고 `task start`나 Task·Claim·worktree mutation을 시도하지 않는다. checkout root는 현재 checkout의 직접 `git rev-parse --show-toplevel` 사실로만 얻고, Project/Repository association은 launcher resolver가 Registry의 pinned read 안에서 확정한다.

<!-- task-start-contract: gate:begin -->
```bash
"$HOME/.local/bin/jhw-control-host" preflight >/dev/null || exit $?
REPOSITORY_PATH="$(git rev-parse --show-toplevel)" || exit $?
test -n "$REPOSITORY_PATH" || exit 1
```
<!-- task-start-contract: gate:end -->

`task start` 성공 시 launcher result에서 오직 `task_id`, `claim_id`, `branch`, `worktree_ref` 네 필드만 사용자에게 보고하고 다른 result 필드는 보고하거나 출력하지 않는다. 이 네 immutable 좌표만 이후 명령에 사용한다. `TASK_ALREADY_CLAIMED`이면 검증된 `error.conflicting_claim`의 bounded 좌표만 보여주고 멈춘다. 자동 status/takeover하지 않는다.

성공 envelope의 `result`에는 향후 safe field가 추가될 수 있다. 사용자 보고는 다음 positive recipe 그대로 네 필드의 새 object를 만들어야 하며 `result` 전체를 전달하거나 나머지 field를 펼치지 않는다.

<!-- task-report-contract: start-success:begin -->
```javascript
const { task_id, claim_id, branch, worktree_ref } =
  JSON.parse(process.env.JHW_TASK_START_ENVELOPE).result;
process.stdout.write(`${JSON.stringify({ task_id, claim_id, branch, worktree_ref })}\n`);
```
<!-- task-report-contract: start-success:end -->

`PROJECT_REPOSITORY_NOT_FOUND`이면 올바른 Project Record에 Repository를 등록한 뒤 새 요청으로 다시 시작한다. `PROJECT_REPOSITORY_AMBIGUOUS`이면 Repository의 Project association을 하나로 줄인 뒤 새 요청으로 다시 시작한다. `PROJECT_REPOSITORY_NOT_FOUND`와 `PROJECT_REPOSITORY_AMBIGUOUS` 모두 추측, 임의 선택, 자동 재시도, explicit mode fallback을 금지한다.

## 좌표 없는 Task/Handoff 수신 발견

사용자가 `태스크 받아서`, `작업준비`, `HANDOFF*.md`를 받아서/이어서 작업하라는 표현으로 Task 인수를 명시했지만 canonical `task_id`·Issue URL이 없으면 다음 discovery만 먼저 수행한다. 일반 조사 요청에는 자동 실행하지 않는다.

1. `git rev-parse --show-toplevel`로 현재 저장소를 확정하고, 그 루트에서 `git worktree list --porcelain -z`를 실행한다. NUL field/빈 NUL record 경계로 파싱하고 공백·줄·`eval`로 쪼개거나 C-quoted path를 직접 복원하지 않는다. `-z`를 지원하지 않거나 record가 malformed이면 fail-closed한다. 이 명령이 열거한 **같은 저장소의 worktree**만 대상으로 삼는다.
2. 각 worktree에서 root 바로 아래의 symlink가 아닌 regular file `HANDOFF*.md`와 canonical local copy `.ai/handoff.md`만 후보로 검사한다. canonical copy는 `.ai` directory와 `handoff.md`가 모두 symlink가 아닐 때만 후보이며 그 밖의 하위 디렉터리, 다른 repository, home, session/history, Notion으로 검색을 넓히지 않는다.
3. 사용자가 파일명을 지정했다면 pathless `HANDOFF*.md` basename 또는 exact literal `.ai/handoff.md`만 받으며 다른 path component·`..`·separator는 거부한다. 지정한 logical name과 일치하는 후보를 모든 worktree에서 먼저 찾고 glob 확장·부분 일치·현재 checkout 우선 선택으로 대체하지 않는다. 파일명을 지정하지 않았을 때만 두 후보 종류를 모두 모은다.
4. 후보를 원래 logical-name byte와 porcelain record 기준으로 안정 정렬한다. 0개면 발견 실패를 보고하고 멈춘다. 여러 개면 임의로 읽거나 선택하거나 Claim하지 말고 총 개수와 최대 20개만 보여준 뒤 사용자 선택을 기다린다. 각 항목은 `순번 + JSON-style escaped logical name + escaped branch(없으면 detached) + worktree-key`로 표시한다. `worktree-key`는 record의 첫 `worktree ` byte부터 마지막 field byte까지 single-NUL field separator를 보존하고 terminating double NUL은 제외한 raw bytes의 SHA-256 앞 12 hex인 선택용 비권위 식별자다. C0/C1·ESC·bidi/non-printable 문자를 escape하고 원래 name byte로 비교한다. 절대 worktree path는 출력하지 않으며 20개 초과분은 생략 수를 표시한다.
5. 단일 후보를 읽기 직전과 사용자가 복수 후보를 선택한 뒤에는 `git worktree list --porcelain -z`부터 다시 실행한다. 내부에 보존한 exact worktree root, `worktree-key`, exact logical name이 모두 그대로인지 확인한다. shell의 check-then-read로 대체하지 말고 local Python의 `os.open`을 사용해 root를 `O_DIRECTORY|O_NOFOLLOW`, canonical copy면 `.ai`도 같은 방식, 마지막 파일은 `O_RDONLY|O_NOFOLLOW`로 descriptor-relative open한 뒤 `fstat` regular file을 확인한다. 같은 fd에서 최대 12 KiB와 초과 확인용 1 byte만 읽는다. Python/필수 flag가 없거나 초과·교체·누락·symlink이면 truncate하거나 다른 후보로 넘어가지 말고 멈춘다.
6. 선택한 Handoff의 Task/Issue/branch/worktree 표기는 **discovery hint**일 뿐이다. Task를 받아 작업하라는 현재 요청은 명시적 resume이므로, 위 Task start authorization gate 뒤에 기존-Task launcher start를 실행해 Claim을 획득하고 그 성공 결과로만 canonical Task·Claim·owner를 확정한다. `task status`는 이미 active라고 알려진 Claim의 읽기 전용 소유권 확인에만 쓰며 released Handoff 수신을 대신하지 않는다. 다른 owner·충돌·불일치·좌표 부재에서는 작업하거나 자동 takeover하지 않는다.

## 새 Task 시작

### Formal GitHub Issue

Issue URL이 authority coordinate다. 서버가 verified repository token으로 current node ID, canonical URL, revision, `<owner>/<repo>#<number>` alias를 도출한다. 위 authorization gate 뒤에 **한 번만** 다음 formal start를 실행한다.

<!-- task-start-contract: formal:begin -->
```bash
"$HOME/.local/bin/jhw-control-host" task start \
  --resolve-from-checkout true \
  --repo-path "$REPOSITORY_PATH" \
  --issue-url 'https://github.com/<owner>/<repo>/issues/<number>' \
  --session '<session-id>'
```
<!-- task-start-contract: formal:end -->

`--issue-node-id`/`--issue-revision`은 independently verified expectation이 이미 있을 때만 추가한다. caller 값을 source authority처럼 만들지 않는다.

### Temporary Task

`--done`과 `--scope`는 각각 1개 이상이며 반복 가능하다.

위 authorization gate를 통과한 뒤에만 launcher로 다음 temporary registration fields를 사용한다. Project/Repository association을 caller가 고르거나 명시하지 않는다. alias, goal, 각 done, 각 scope, session과 source 값은 shell-safe quoting으로 각각 정확히 한 argv argument가 되게 serialize한다. bracket notation을 명령에 그대로 넣지 않는다.

<!-- task-start-contract: temporary:begin -->
```bash
"$HOME/.local/bin/jhw-control-host" task start \
  --resolve-from-checkout true \
  --repo-path "$REPOSITORY_PATH" \
  --temp-alias '<alias>' --goal '<goal>' \
  --done '<condition-1>' --done '<condition-2>' \
  --scope '<scope-1>' --scope '<scope-2>' \
  --session '<session-id>'
```
<!-- task-start-contract: temporary:end -->

## 기존 Task 재개

재개는 `status`가 아니라 같은 persistent Task를 다시 claim하는 명시적 start다. registration field를 섞지 않는다.

위 authorization gate를 통과한 뒤에만 launcher로 재개한다. resolver나 Project/Repository registration field를 섞지 않는다.

<!-- task-start-contract: resume:begin -->
```bash
"$HOME/.local/bin/jhw-control-host" task start \
  --task '<tsk-id>' --repo-path "$REPOSITORY_PATH" --session '<session-id>'
```
<!-- task-start-contract: resume:end -->

성공 결과에 `latest_handoff`가 있을 때만 그것을 재개 context로 보여준다. `latest_handoff`가 없고(강제종료 등) 사용자가 컨텍스트 복구를 요청하면 repo root의 `HANDOFF.<세션>.md`를 보조 context로 읽을 수 있다 — Task 좌표·상태·증거는 command 결과만 정본이다. `TASK_COMPLETED`, `WORKTREE_CLEANUP_REQUIRED`, source/Project/repository mismatch이면 멈춘다. cleanup이 필요하면 아래 exact released-generation 절차를 먼저 승인받는다.

활성 Claim 확인만 요청받았으면:

```bash
jhw-control task status --task <tsk-id> [--claim <active-claim-id>]
```

owner(host/branch/worktree), dirty/ahead/behind와 current Claim을 보여준다. 다른 owner이면 작업하지 않는다.

## Handoff 조회와 promotion

사용자가 Handoff를 명시적으로 요청한 경우에만 exact Claim 또는 unambiguous latest history를 읽는다.

```bash
jhw-control task handoff --task <tsk-id> [--claim <released-handoff-claim-id>]
```

12 KiB fixed-six-section 결과만 보여주며 다른 history/session을 자동 확장하지 않는다.

Temporary Task를 verified Issue로 승격하라는 요청에는 Task ID를 보존한다.

```bash
jhw-control task promote --task <tsk-id> \
  --repo-path <absolute-checkout-root> \
  --issue-url https://github.com/<owner>/<repo>/issues/<number>
```

다른 Task에 이미 매핑된 Issue, Project membership/checkout mismatch, source mismatch에서 멈춘다. merge/supersede를 자동 결정하지 않는다.

## 종료

사용자가 종료를 명시적으로 요청한 경우에만 실행한다. 모든 status에는 `--validation`이 1개 이상 필요하고 `completed`에는 `--outcome`도 필요하다. launcher가 secure store 주입과 hidden preflight를 담당하므로 별도 preflight를 실행하거나 raw config·credential을 읽지 않는다.

아래 block이 standalone과 switch가 함께 사용하는 **유일한 status-sensitive finish contract**다. 수집한 scalar는 shell source에 치환하지 않고 process environment의 각 named value로, validation은 `bash -c <block> lifecycle <validation>...`의 positional argv로 전달한다. 빈 optional value는 환경에서 생략하거나 empty로 전달한다. Handoff의 `--progress`, `--failures`, `--next-step`, `--related-adr-and-evidence`, retained `--source-task-revision`, `--active-work-minutes`는 각각 optional이고 validation은 repeatable이다. 사용자가 제공한 것만 exact 한 argv로 append한다.

<!-- task-lifecycle-contract: finish:begin -->
```bash
finish_status="$JHW_FINISH_STATUS"
current_task_id="$JHW_CURRENT_TASK_ID"
current_claim_id="$JHW_CURRENT_CLAIM_ID"
finish_outcome="${JHW_FINISH_OUTCOME-}"
source_task_revision="${JHW_SOURCE_TASK_REVISION-}"
active_work_minutes="${JHW_ACTIVE_WORK_MINUTES-}"
handoff_progress="${JHW_HANDOFF_PROGRESS-}"
handoff_failures="${JHW_HANDOFF_FAILURES-}"
handoff_next_step="${JHW_HANDOFF_NEXT_STEP-}"
handoff_related_evidence="${JHW_HANDOFF_RELATED_EVIDENCE-}"

test -n "$current_task_id" || exit 1
test -n "$current_claim_id" || exit 1
test "$#" -ge 1 || exit 1
finish_args=(task finish --task "$current_task_id" --claim "$current_claim_id" --status "$finish_status")
case "$finish_status" in
  completed)
    test -n "$finish_outcome" || exit 1
    test -z "$source_task_revision$handoff_progress$handoff_failures$handoff_next_step$handoff_related_evidence" || exit 1
    finish_args+=(--outcome "$finish_outcome")
    ;;
  handoff)
    test -z "$finish_outcome" || exit 1
    if [ -n "$handoff_progress" ]; then finish_args+=(--progress "$handoff_progress"); fi
    if [ -n "$handoff_failures" ]; then finish_args+=(--failures "$handoff_failures"); fi
    if [ -n "$handoff_next_step" ]; then finish_args+=(--next-step "$handoff_next_step"); fi
    if [ -n "$handoff_related_evidence" ]; then
      finish_args+=(--related-adr-and-evidence "$handoff_related_evidence")
    fi
    if [ -n "$source_task_revision" ]; then
      test "$source_task_revision" != "unknown" || exit 1
      finish_args+=(--source-task-revision "$source_task_revision")
    fi
    ;;
  abandoned)
    test -z "$finish_outcome$source_task_revision$handoff_progress$handoff_failures$handoff_next_step$handoff_related_evidence" || exit 1
    ;;
  *) exit 1 ;;
esac

if [ -n "$active_work_minutes" ]; then
  finish_args+=(--active-work-minutes "$active_work_minutes")
fi
for validation in "$@"; do
  test -n "$validation" || exit 1
  finish_args+=(--validation "$validation")
done

"$HOME/.local/bin/jhw-control-host" "${finish_args[@]}"
finish_rc=$?
test "$finish_rc" -eq 0 || exit "$finish_rc"
```
<!-- task-lifecycle-contract: finish:end -->

`--status`는 `completed|handoff|abandoned`다. Handoff source revision은 Claim acquisition 때 frozen된다. `--source-task-revision`을 새로 만들거나 `unknown`을 보내지 않는다; independently retained 값을 보낼 경우 frozen 값과 exact match해야 한다.

Handoff는 Registry copy/history를 durable하게 만든 뒤 release하고 worktree를 유지한다. completed/abandoned의 local cleanup 실패는 이미 성공한 release를 되돌리지 않는다.

Formal Task의 `--status completed`는 해당 Claim generation만 archive/release하며 GitHub Issue를 닫지 않는다. Formal lifecycle authority는 Issue의 open/closed 상태다. Issue가 open 또는 reopened이면 같은 Task ID를 검증해 새 Claim으로 재개할 수 있고, terminal 종료는 Issue authority에서 별도로 close한다.

## 전환 (switch)

사용자가 "현재 Task를 마무리하고 다른 작업으로 넘어간다"를 명시적으로 요청한 경우에만 사용한다. 전환은 새 커맨드가 아니라 위 **종료(finish)와 새 Task 시작/재개(start)의 연속 실행**이다. 서버에 switch 커맨드는 없으며 두 명령의 규격·정지 조건을 그대로 따른다.

1. **입력을 한 번에 수집한다.** 현재 Task의 `<current-tsk-id>`·Claim·종료 status(completed면 `--outcome` 포함)와 validation 1개 이상, 그리고 대상 좌표 — 기존 Task 재개면 별개의 `<target-tsk-id>`, 신규면 대상 checkout root와 Issue URL 또는 temporary 등록 필드. validation은 세션에서 실제 수행된 검증 근거만 사용하고 자동 생성하지 않는다. 현재 Task ID와 resume target Task ID를 같은 placeholder나 변수로 재사용하지 않는다.
2. **대상 좌표를 추측하지 않는다.** `--repo-path`는 대상 checkout의 절대 Git root를 확인해 사용하고, 신규 start의 Project/Repository association은 launcher resolver가 확정한다.
3. **(필요 시) Issue를 먼저 만든다.** 대상 Issue가 아직 없으면 사용자 제공 제목·본문으로 `gh issue create --repo <owner>/<repo>`를 실행하고, 반환된 URL만 authority coordinate로 사용한다. Issue 생성이 실패하면 finish 전이므로 아무것도 변하지 않은 상태다 — 멈추고 보고한다.
4. **대상의 absolute exact Git root를 finish 전에 검증하고 보존한다.** path가 absolute가 아니거나 `git -C ... rev-parse --show-toplevel` 결과와 exact match하지 않으면 lifecycle call 없이 멈춘다. 별도 preflight·portfolio lookup은 실행하지 않는다. launcher가 finish/start 각각에서 hidden preflight를 수행한다. finish가 nonzero이면 **start를 실행하지 않고** 멈추며, finish 뒤에 target gate를 다시 실행하지 않는다.

target checkout도 shell source에 치환하지 않고 process environment의 `JHW_TARGET_CHECKOUT` 한 argv value로 전달한다. 다음 shared block을 finish 전에 한 번 실행하고, 이어서 위 canonical finish block 하나와 선택한 start tail 하나를 같은 shell에서 순서대로 compose한다.

<!-- task-lifecycle-contract: switch-target-root:begin -->
```bash
target_checkout="$JHW_TARGET_CHECKOUT"
case "$target_checkout" in
  /*) ;;
  *) exit 1 ;;
esac
target_root="$(git -C "$target_checkout" rev-parse --show-toplevel)" || exit $?
test "$target_root" = "$target_checkout" || exit 1
```
<!-- task-lifecycle-contract: switch-target-root:end -->

Formal target start tail:

<!-- task-lifecycle-contract: switch-formal-start:begin -->
```bash
"$HOME/.local/bin/jhw-control-host" task start \
  --resolve-from-checkout true --repo-path "$target_root" \
  --issue-url "$JHW_TARGET_ISSUE_URL" --session "$JHW_SESSION_VALUE"
```
<!-- task-lifecycle-contract: switch-formal-start:end -->

Temporary target start tail:

<!-- task-lifecycle-contract: switch-temporary-start:begin -->
```bash
"$HOME/.local/bin/jhw-control-host" task start \
  --resolve-from-checkout true --repo-path "$target_root" \
  --temp-alias "$JHW_TEMP_ALIAS" --goal "$JHW_TEMP_GOAL" \
  --done "$JHW_DONE_ONE" --done "$JHW_DONE_TWO" \
  --scope "$JHW_SCOPE_ONE" --scope "$JHW_SCOPE_TWO" \
  --session "$JHW_SESSION_VALUE"
```
<!-- task-lifecycle-contract: switch-temporary-start:end -->

Existing Task target start tail은 registration/resolver field 없이 retained root와 별개의 target Task ID를 사용한다.

<!-- task-lifecycle-contract: switch-resume-start:begin -->
```bash
"$HOME/.local/bin/jhw-control-host" task start \
  --task "$JHW_TARGET_TASK_ID" --repo-path "$target_root" --session "$JHW_SESSION_VALUE"
```
<!-- task-lifecycle-contract: switch-resume-start:end -->

5. **start를 한 번 실행한다.** Formal/Temporary는 resolver start, Existing Task는 `--task` resume만 사용한다. `--session`은 같은 switch 요청의 session-id를 승계한다. external gate rerun, raw control, rollback, automatic refinish는 없다.
6. **finish 성공 후 start 실패는 정상적인 부분 완료 상태다.** 이전 Claim은 이미 release되었으며 rollback하거나 release를 되돌리지 않는다. start 오류만 결과 해석 절차대로 보고하며, `TASK_ALREADY_CLAIMED`이면 기존 규칙대로 bounded 좌표만 보여주고 멈춘다. finish는 절대 반복하지 않는다. 이후 start는 별도 사용자 승인을 받고 해당 error의 결과 해석 규칙이 허용할 때만 새로 실행하며, `REGISTRY_MOVED_DURING_READ`는 자동 retry나 explicit-mode fallback을 허용하지 않는다. target Repository가 미등록되어 `PROJECT_REPOSITORY_NOT_FOUND`이거나 association이 ambiguous이면 이전 Claim release 뒤 start가 실패할 수 있다. 자동 rollback이나 성공 약속을 하지 않는다.
7. **결과를 함께 보고한다.** 종료한 Task(current-tsk-id, status, released claim)와 시작한 Task(target-tsk-id, 새 claim_id, branch, worktree_ref)를 서로 구분해 한 번에 보여준다.

completed 전환이어도 이전 worktree는 병합 여부 판정에 따라 남을 수 있다. 전환이 cleanup을 대신하지 않으며, 정리는 아래 recovery의 released-generation cleanup 절차를 따른다.

## recovery

활성 Claim은 status부터 읽는다.

```bash
jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action status
```

stale을 추정하지 않는다. `force-end`/`takeover`는 결과를 보여준 뒤 **실행 직전에 별도 사용자 승인**을 받는다.

```bash
jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action force-end
jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action takeover --session <new-session-id>
```

Takeover 성공 시 반환된 새 `claim_id`로 `task status`를 다시 확인한다. old ID를 재사용하지 않는다.

이미 release된 Claim generation의 pending cleanup은 exact history ID로만 실행한다.

```bash
jhw-control task recover --task <tsk-id> --expect <released-claim-id> --action cleanup
```

exact `pending-remove`는 cleanup이 재개하는 상태다. active successor/cross-host/coordinate mismatch, dirty worktree, source checkout에 통합되지 않은 commit, `pending-create`, 또는 다른 generation의 ambiguous pending state에서만 멈춘다. 파일 삭제나 새 Claim으로 우회하지 않는다. worktree의 commit이 이미 병합됐으면 commit 수와 무관하게 제거된다. `WORKTREE_UNPUSHED`는 이 cleanup 경로에서만 보인다 — 아직 병합되지 않았거나 source checkout이 detached인 것이므로, 병합과 checkout 상태를 확인하고 다시 실행한다. `task finish`는 이 코드를 표면화하지 않고 `worktree_removed: false`와 `cleanup_error`만 반환하므로, 사유를 알려면 위 cleanup을 실행한다.

## raw Git 공유 경계

push, PR, merge, deploy 각각의 직전에 실행한다.

```bash
jhw-control task assert-owner --task <tsk-id> --claim <current-claim-id>
```

이 확인은 raw Git을 통합 enforcement하지 않는 **advisory check**라서 확인 직후 승인된 takeover와 race할 수 있다. 안전을 보장하는 wrapper로 표현하지 않는다. 실패하면 공유 동작을 하지 않는다.

## 결과 해석

- exit `0` + `journal_warning.code=JOURNAL_WRITE_FAILED`: lifecycle은 이미 성공했다. 재시도하지 말고 measurement gap만 보고한다.
- exit `4`: Claim conflict/mismatch/not found. 자동 takeover 금지.
- exit `75`: Registry dirty/diverged 또는 lock contention/acquisition timeout. stop; 자동 retry/rebase/force 금지. Lock helper spawn/setup/acquire 실패는 일반 command `1`, preflight NO-GO `78`이다.
- resolver `task start`/`task finish`가 `REGISTRY_MOVED_DURING_READ`를 반환하면 자동 재실행 없이 멈추고 보고한다. 수동 재실행 안내는 `status`, `handoff`, `assert-owner`, `recover --action status` 읽기 전용 명령에만 제한한다. 읽기 전용 명령에서 반복되면 쓰기가 계속 들어오는 것이니 한가한 시점에 다시 본다.
- `error.reason`은 같은 code 안에서 조치가 갈리는 축이다. 자동 overwrite나 finish 재실행을 하지 않는다.
- `HANDOFF_RETRY_CONFLICT` + `git_identity_changed`·`dirty_delta_changed`: worktree가 커밋된 Handoff 증거(branch·head_sha·ahead·behind·dirty delta)에서 움직인 것이다. **커밋된 Handoff가 정본**이므로 새 commit·파일 변경은 되돌린 뒤 커밋된 같은 필드로 사용자가 승인한 새 요청에서 재시도한다. 작업을 유지하려 하거나 upstream 이동 때문에 되돌릴 수 없으면 completed/abandoned release 후 새 Claim에서 이어가며 handoff retry로 우회하지 않는다.
- `HANDOFF_RETRY_CONFLICT` + `legacy_dirty_evidence_ambiguous`: 구 포맷 증거이므로 기존 것을 overwrite하지 않고 새 Handoff를 생성한다.
- `HANDOFF_RETRY_CONFLICT` + `handoff_metadata_mismatch`·`retry_fields_changed`: 요청이 커밋본과 다르므로 커밋된 필드·좌표 그대로 사용자가 승인한 새 요청에서 재시도한다.
- `HANDOFF_RETRY_CONFLICT` + git-state 파스 계열 `invalid_git_state_line`·`duplicate_git_state_key`·`unexpected_git_state_key`·`missing_git_state_key`·`invalid_git_state_count`·`missing_git_identity`·`invalid_dirty_digest`: 커밋된 Handoff Git-state 증거 자체 손상이므로 멈추고 손상된 정본을 별도로 복구·수정한다.
- `WORKTREE_DIRTY` + `handoff_copy_not_plain_file`: worktree 변경 문제가 아니라 local `.ai/handoff.md` 사본이 regular file이 아닌 malformed 상태다. 멈추고 local copy 형태를 복구한다.
- `INVALID_WORKTREE_INSPECTION` + `duplicate_dirty_files`: inspection이 중복 dirty entry를 반환한 상태다. 멈추고 읽기 전용 status를 재실행하며, 반복되면 Git status 자체를 조사한다.
- reason은 journal에도 `error_reason`으로 남아 사후 감사에서 같은 축을 쓴다.
- 다른 nonzero: stable `error.code`만 보고하고 secret/raw path를 출력하지 않는다.
