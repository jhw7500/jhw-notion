---
description: Use when the user explicitly requests a Project Control Task or Issue start, resume, finish, or recovery
argument-hint: "(start | resume | finish | recover) <task-or-issue>"
---

# /jhw:task — 명시적 Task 제어

이 스킬은 사용자가 Task/Issue/임시 작업의 **시작·재개·종료·복구를 명시적으로 요청한 경우에만** 사용한다. 읽기 전용 조사·리뷰는 Claim이 필요 없다.

## 컨텍스트 경계

- 현재 사용자 요청과 현재 저장소 사실만 사용한다.
- 이전 세션, Notion, memory, `/jhw:recall`, `/jhw:cclog`, `/jhw:load`, 광범위한 Git history를 자동으로 읽지 않는다.
- 기존 canonical `task_id`·`repo_id`를 추측하지 않는다. 안전하게 알 수 없는 값만 짧게 질문한다.

## 시작

정식 Issue는 다음 전체 인자로 한 번 실행한다.

```bash
jhw-control task start --project <prj-id> --repo-id <repo-id> \
  --repo-path <absolute-path> --issue-node-id <node-id> \
  --issue-url <url> --issue-revision <revision> --session <session-id>
```

임시 작업은 Issue 인자 대신 아래를 사용한다. `--done`과 `--scope`는 각각 1개 이상이며 반복 가능하다.

```bash
jhw-control task start --project <prj-id> --repo-id <repo-id> \
  --repo-path <absolute-path> --temp-alias <alias> --goal <goal> \
  --done <condition> [--done <condition> ...] \
  --scope <path-or-scope> [--scope <path-or-scope> ...] --session <session-id>
```

반환된 immutable `task_id`, `claim_id`, branch, `worktree_ref`만 이후 명령에 사용한다. Claim 충돌은 owner/Claim 정보를 그대로 보여주고 멈춘다. 자동 takeover하지 않는다.

## 재개

canonical Task ID가 없으면 질문한다. **재개 전에 항상** 실행한다.

```bash
jhw-control task status --task <tsk-id>
```

반환된 Claim owner(host/branch/worktree), `claim_id`, dirty/ahead/behind를 보여준다. 현재 작업과 소유자가 다르면 충돌로 보고하고 멈춘다. 반환된 현재 `claim_id`를 임의로 바꾸거나 과거 ID를 재사용하지 않는다. 반환이 exit 4 `CLAIM_NOT_FOUND`이면 자동 `task start`하지 않고 미점유 Task인지 사용자에게 알린 뒤 명시적 시작 요청을 받는다.

## 복구

명시적 복구 요청에서 먼저 상태만 검사한다.

```bash
jhw-control task recover --task <tsk-id> --expect <current-claim-id> --action status
```

stale 여부를 자동 판정하지 않는다. `force-end` 또는 `takeover`를 제안할 때 검사 결과와 대상 Claim을 보여주고, **실행 직전에 별도 사용자 승인**을 받는다.

```bash
jhw-control task recover --task <tsk-id> --expect <old-claim-id> --action force-end
jhw-control task recover --task <tsk-id> --expect <old-claim-id> --action takeover --session <session-id>
```

takeover 성공 시 반환된 **새 `claim_id`**만 사용한다. 실패하거나 기대 Claim이 바뀌면 멈추고 새 승인 없이 재시도하지 않는다.

takeover 직후 새 ID로 `task status --task <tsk-id> --claim <new-claim-id>`를 실행해 host-local worktree 소유까지 확인한다. 이 검증이 실패하면 작업·finish·공유 동작을 진행하지 않고 오류를 보고한다. 임의 rebind, force-end+restart, 새 명령을 만들어 우회하지 않는다.

## 공유 경계와 종료

공유 push, PR 생성, merge, deploy **각 동작 직전**에 실행한다. 실패하면 해당 공유 동작을 하지 않는다.

```bash
jhw-control task assert-owner --task <tsk-id> --claim <current-claim-id>
```

사용자가 종료를 명시적으로 요청한 경우에만 `task finish`를 실행한다.

```bash
jhw-control task finish --task <tsk-id> --claim <current-claim-id> \
  --status completed --outcome <result> --validation <evidence> \
  [--validation <evidence> ...] [--active-work-minutes <minutes>]
```

`--status`는 `completed|handoff|abandoned`다. handoff에는 `--source-task-revision`과 필요 시 `--progress`, `--failures`, `--next-step`, `--related-adr-and-evidence`를 추가한다. 모든 종료에는 `--validation`이 1개 이상 필요하다.
