---
description: Use when the user explicitly requests a Project Control Task start, existing-Task resume, promotion, Handoff, finish, a finish-then-start switch to another Task/Issue, or recovery
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

## 새 Task 시작

### Formal GitHub Issue

Issue URL이 authority coordinate다. 서버가 verified repository token으로 current node ID, canonical URL, revision, `<owner>/<repo>#<number>` alias를 도출한다.

```bash
jhw-control task start \
  --project <prj-id> --repo-id <repo-id> --repo-path <absolute-checkout-root> \
  --issue-url https://github.com/<owner>/<repo>/issues/<number> --session <session-id>
```

`--issue-node-id`/`--issue-revision`은 independently verified expectation이 이미 있을 때만 추가한다. caller 값을 source authority처럼 만들지 않는다.

### Temporary Task

`--done`과 `--scope`는 각각 1개 이상이며 반복 가능하다.

```bash
jhw-control task start \
  --project <prj-id> --repo-id <repo-id> --repo-path <absolute-checkout-root> \
  --temp-alias <alias> --goal <goal> \
  --done <condition> [--done <condition> ...] \
  --scope <scope> [--scope <scope> ...] --session <session-id>
```

성공 결과의 immutable `task_id`, 새 `claim_id`, branch, `worktree_ref`만 이후 명령에 사용한다. `TASK_ALREADY_CLAIMED`이면 검증된 `error.conflicting_claim`의 bounded 좌표만 보여주고 멈춘다. 자동 status/takeover하지 않는다.

## 기존 Task 재개

재개는 `status`가 아니라 같은 persistent Task를 다시 claim하는 명시적 start다. registration field를 섞지 않는다.

```bash
jhw-control task start \
  --task <tsk-id> --repo-path <absolute-checkout-root> --session <session-id>
```

성공 결과에 `latest_handoff`가 있을 때만 그것을 재개 context로 보여준다. `TASK_COMPLETED`, `WORKTREE_CLEANUP_REQUIRED`, source/Project/repository mismatch이면 멈춘다. cleanup이 필요하면 아래 exact released-generation 절차를 먼저 승인받는다.

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

사용자가 종료를 명시적으로 요청한 경우에만 실행한다. 모든 status에는 `--validation`이 1개 이상 필요하고 `completed`에는 `--outcome`도 필요하다.

```bash
jhw-control task finish --task <tsk-id> --claim <current-claim-id> \
  --status completed --outcome <result> \
  --validation <evidence> [--validation <evidence> ...] \
  [--active-work-minutes <positive-number>]

jhw-control task finish --task <tsk-id> --claim <current-claim-id> \
  --status handoff --validation <evidence> \
  [--progress <text>] [--failures <text>] [--next-step <text>] \
  [--related-adr-and-evidence <text>] [--active-work-minutes <positive-number>]
```

`--status`는 `completed|handoff|abandoned`다. Handoff source revision은 Claim acquisition 때 frozen된다. `--source-task-revision`을 새로 만들거나 `unknown`을 보내지 않는다; independently retained 값을 보낼 경우 frozen 값과 exact match해야 한다.

Handoff는 Registry copy/history를 durable하게 만든 뒤 release하고 worktree를 유지한다. completed/abandoned의 local cleanup 실패는 이미 성공한 release를 되돌리지 않는다.

Formal Task의 `--status completed`는 해당 Claim generation만 archive/release하며 GitHub Issue를 닫지 않는다. Formal lifecycle authority는 Issue의 open/closed 상태다. Issue가 open 또는 reopened이면 같은 Task ID를 검증해 새 Claim으로 재개할 수 있고, terminal 종료는 Issue authority에서 별도로 close한다.

## 전환 (switch)

사용자가 "현재 Task를 마무리하고 다른 작업으로 넘어간다"를 명시적으로 요청한 경우에만 사용한다. 전환은 새 커맨드가 아니라 위 **종료(finish)와 새 Task 시작/재개(start)의 연속 실행**이다. 서버에 switch 커맨드는 없으며 두 명령의 규격·정지 조건을 그대로 따른다.

1. **입력을 한 번에 수집한다.** 현재 Task의 종료 status(completed면 `--outcome` 포함)와 validation 1개 이상, 그리고 대상 좌표 — 기존 Task 재개면 `<tsk-id>`, 신규면 project/repo-id/repo-path와 Issue URL 또는 temporary 등록 필드. validation은 세션에서 실제 수행된 검증 근거만 사용하고 자동 생성하지 않는다.
2. **대상 좌표를 추측하지 않는다.** 대상 repo-id/project가 불확실하면 `jhw-control portfolio status` 결과의 `repositories` 배열로 확인한다. 미등록 저장소면 멈추고 repository 등록을 먼저 안내한다. `--repo-path`는 대상 checkout의 절대경로를 존재 확인 후 사용한다.
3. **(필요 시) Issue를 먼저 만든다.** 대상 Issue가 아직 없으면 사용자 제공 제목·본문으로 `gh issue create --repo <owner>/<repo>`를 실행하고, 반환된 URL만 authority coordinate로 사용한다. Issue 생성이 실패하면 finish 전이므로 아무것도 변하지 않은 상태다 — 멈추고 보고한다.
4. **finish를 먼저 실행한다** (위 종료 규격 그대로). `--status handoff`로 넘기는 경우 `--next-step`에 대상 Issue URL 또는 Task 좌표를 남겨 체인을 기록한다. finish가 nonzero면 **start를 실행하지 않고** 멈춘다.
5. **start를 실행한다** (위 새 Task 시작 또는 재개 규격 그대로). `--session`은 finish에 쓴 것과 같은 session-id를 승계한다.
6. **finish 성공 후 start 실패는 정상 상태다** — 현재 Task는 이미 종료됐고 되돌리지 않는다. start 오류만 결과 해석 절차대로 보고하며, `TASK_ALREADY_CLAIMED`이면 기존 규칙대로 bounded 좌표만 보여주고 멈춘다. start 재시도는 finish를 반복하지 않고 start만 다시 실행한다.
7. **결과를 함께 보고한다.** 종료한 Task(tsk-id, status, released claim)와 시작한 Task(tsk-id, 새 claim_id, branch, worktree_ref)를 한 번에 보여준다.

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
- `REGISTRY_MOVED_DURING_READ`: 읽기 도중 다른 세션이 Registry에 커밋해 이 읽기가 뒤처진 것이다. **Registry 손상이 아니므로 같은 명령을 그대로 다시 실행**한다. 읽기 전용 명령(`status`·`handoff`·`assert-owner`·`recover --action status`)은 host lock을 잡지 않아 이 조건에 걸릴 수 있다. 반복되면 쓰기가 계속 들어오는 것이니 한가한 시점에 다시 본다.
- `error.reason`은 같은 code 안에서 조치가 갈리는 축이다. `HANDOFF_RETRY_CONFLICT`: `git_identity_changed`·`dirty_delta_changed`는 worktree가 커밋된 Handoff 증거(branch·head_sha·ahead·behind·dirty delta)에서 움직인 것 — **커밋된 Handoff가 정본**이므로 로컬 움직임(새 commit·파일 변경)은 되돌린 뒤 같은 필드로 재시도하고, 작업을 유지하려 하거나 되돌릴 수 없는 움직임(upstream 이동에 따른 ahead/behind 변화)이면 completed/abandoned release 후 새 Claim에서 이어간다(그 release는 handoff 경로를 타지 않는다), `legacy_dirty_evidence_ambiguous`는 구 포맷(새 Handoff 생성), `retry_fields_changed`·`handoff_metadata_mismatch`는 재시도 요청이 커밋본과 다른 것(커밋된 필드·좌표 그대로 재시도), 그 외 git-state 파스 계열은 커밋된 Handoff 자체 손상. `WORKTREE_DIRTY` + `handoff_copy_not_plain_file`은 worktree가 더러운 게 아니라 `.ai/handoff.md` 사본이 malformed인 것이다. `INVALID_WORKTREE_INSPECTION` + `duplicate_dirty_files`는 inspection이 중복 dirty 엔트리를 반환해 fail-closed한 것 — 재실행 후에도 반복되면 Git status 자체가 이상한 것이다. reason은 journal에도 `error_reason`으로 남아 사후 감사에서 같은 축을 쓴다.
- 다른 nonzero: stable `error.code`만 보고하고 secret/raw path를 출력하지 않는다.
