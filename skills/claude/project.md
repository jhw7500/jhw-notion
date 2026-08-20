---
description: Use when the user explicitly requests a JHW project start, close, selection, or Phase 1A trial Repository/Project registration
argument-hint: "(--start | --close | --trial) [프로젝트명]"
---

# /jhw:project — 프로젝트 시작·종료·trial 등록

## Authority 경계

- 일반 `/jhw:project`, `--start`, `--close`는 기존 Notion workflow와 live authority를 그대로 사용한다.
- Registry/GitHub Project trial은 명시적 `/jhw:project --trial` 또는 동등한 요청에서만 사용한다.
- trial 등록은 authority flip, migration, cutover가 아니다. Task/portfolio는 각각 `/jhw:task`, `/jhw:portfolio`의 명시적 요청으로만 사용한다.

## 일반 Notion workflow

### `/jhw:project` 또는 `--start`

인자 없이는 `jhw_status`로 진행 중 Project를 보여주고 선택받는다. 새 Project는 이름·한 줄 설명(필수), repo·기술 stack(선택)을 수집한 뒤:

1. `jhw_search`로 동일명 확인
2. 한 번 미리보기·승인
3. `jhw_start` 호출
4. Projects/Decision Log/page URL 보고

### `--close`

인자 없으면 `jhw_status` 결과에서 선택받는다. 달성 내용·배운 점은 선택적이다. 한 번 미리보기·승인 후 `jhw_close`를 호출한다. 이미 완료된 Project는 변경하지 않는다.

`description`/`achievement`/`lessons`는 각 1800자 이하로 유지한다. 긴 내용은 요약하거나 별도 Knowledge Base로 분리한다.

## `--trial` — verified Repository 뒤 한 Project 제안

### 컨텍스트 경계

- 현재 요청과 현재 checkout의 직접 사실만 사용한다.
- 이전 session, Notion, memory, recall/load/cclog, 광범위 Git history를 자동으로 읽지 않는다.
- registration JSON이나 Registry YAML을 만들거나 손편집하지 않는다.
- existing `repo_id`/`project_id`/`task_id`, slug, checkout path를 추측하지 않는다. 모르면 짧게 질문한다.
- token/private path를 승인 제안, content field, output에 포함하지 않는다. checkout path는 command에만 전달한다.

### 1. Repository bootstrap

Project가 사용할 Repository Record가 없으면 operator가 승인한 `repo-...`, canonical `<owner>/<name>`, exact absolute checkout root를 확인한 뒤 별도 명시적 단계로 실행한다.

```bash
jhw-control repository register \
  --repo-id <repo-id> --slug <owner/name> --repo-path <absolute-checkout-root> \
  [--allow-public true]
```

이 명령이 checkout root/origin, GitHub repository, node ID를 검증한다. public repository는 기본 거부(`REPOSITORY_NOT_PRIVATE`)이며, operator가 명시적으로 승인한 경우에만 `--allow-public true`(정확한 리터럴)로 opt-in한다 — opt-in은 Record에 영속되어 이후 task start 재검증에도 적용되며, 재등록마다 다시 선언한다. 저장소가 여전히 public이면 플래그 없는 재등록은 `REPOSITORY_NOT_PRIVATE`로 실패하고 Record의 opt-in은 유지된다(public 상태에서는 opt-out 경로가 없다). private으로 되돌린 뒤 플래그 없이 재등록하면 opt-in이 소거되고 결과의 `allow_public`이 `false`가 된다. 추가 노출은 push되는 task 브랜치명과 formal Issue 내용뿐이며 Registry·GitHub Project는 여전히 private 필수다. 실패하면 Project 등록을 진행하지 않는다. 다른 node 충돌, ambiguous origin, opt-in 없는 public repository에서 새 ID나 파일 편집으로 우회하지 않으며, operator 명시 승인 없이 `--allow-public`을 붙이지 않는다.

### 2. Project 통합 제안

다음 값을 **한 제안**으로 보여준다.

- `project_id`, title, objective
- 1개 이상의 verified canonical `repo_id`
- Status: `proposed|active|paused|completed|cancelled`
- Priority: `P0|P1|P2|P3`
- Health: `on-track|at-risk|blocked|unknown`
- Next Action: `task:<canonical-tsk-id>` 또는 `wait:<short-condition>`
- Last Reviewed: valid `YYYY-MM-DD`

Task ID가 없으면 `wait:`를 사용하거나 질문한다. ID를 생성하지 않는다. 수정이 생기면 제안 전체를 갱신한 뒤 최종안에 대해 사용자 승인 한 번을 받는다.

### 3. 승인 payload 실행

```bash
jhw-control project register \
  --project <prj-id> --title <title> --objective <objective> \
  --repo-id <repo-id> [--repo-id <repo-id> ...] \
  --status <status> --priority <priority> --health <health> \
  --next-action <task:tsk-id-or-wait:condition> --last-reviewed <YYYY-MM-DD>
```

Project Record는 비공개 Project의 canonical DraftIssue다. Registry Issue를 만들거나 source node ID로 결합하지 않는다.

성공 시 `project_id`, `project_item_id`, `source_node_id`만 보고한다. partial failure 후에는 동일 approved payload와 정확히 하나인 같은 DraftIssue만 재사용한다. 다른 title/body/field/node를 자동 채택하거나 중복 item을 만들지 않는다.

Project write는 read에 지연되어 반영되므로 등록은 두 번 기다린다 — 레코드 부재 확인(2초 1회)과 최종 검증(최대 14초)이며, 둘이 합성되면 **최악 16초**다. **그 시간이 걸리는 것은 정상**이므로 중간에 끊지 않는다. 그동안 호스트 전역 lock을 잡으므로 다른 세션의 lifecycle 명령이 `LOCK_CONTENDED`로 실패할 수 있다. 중단된 등록을 재시도하면 host-local 등록 기록의 좌표로 기존 DraftIssue를 단건 조회해 재사용하므로 중복이 생기지 않는다. 그 기록은 보조 수단이라 없거나 읽히지 않아도 등록은 그대로 진행된다.

성공 결과에 `registration_record_warning`이 실려 오면 등록은 정상이고 host-local 등록 기록만 고장난 것이다 — exit code는 `0`이며, `REGISTRATION_RECORD_UNREADABLE`·`REGISTRATION_RECORD_AT_CAPACITY`는 등록이 진행 중이 아닐 때 `project-registrations.json`을 삭제해 복구하고, `REGISTRATION_RECORD_UNWRITABLE`은 디스크 여유와 상위 경로 권한을 확인한다. 실패한 등록의 `stderr`에도 실리므로, 재실행을 지시받은 경우 그 재시도는 좌표 없이 돈다. 방치해도 등록은 옳지만 재시도가 단건 조회로 수렴하지 못한다.

실패 코드별 대응이 다르다. `PROJECT_REGISTRATION_UNSETTLED`는 아직 정착하지 않은 것이므로 같은 payload로 다시 실행한다(기존 DraftIssue 재사용). `PROJECT_REGISTRATION_MISMATCH`는 정착했는데 값이 다른 것이므로 **재실행하지 말고** Project 보드의 현재 상태를 먼저 확인한다. `DUPLICATE_PROJECT_RECORD`는 이미 중복이 생긴 상태이므로 수동 해소 후 재실행하며, 도구가 자동으로 지우지 않는다.

exit `0`에 `journal_warning.code=JOURNAL_WRITE_FAILED`가 있어도 registration은 이미 성공했으므로 재시도하지 않고 measurement gap만 보고한다. nonzero에서는 stable code만 보고 secret/private path를 출력하지 않는다.

### 4. 등록된 Project의 운영 필드 갱신

이미 등록된 Project의 다섯 운영 필드만 바뀌는 경우에는 재등록하지 않고 update를 쓴다. 바꿀 필드만 플래그로 준다.

```bash
jhw-control project update \
  --project <prj-id> \
  [--status <status>] [--priority <priority>] [--health <health>] \
  [--next-action <task:tsk-id-or-wait:condition>] [--last-reviewed <YYYY-MM-DD>]
```

최소 한 필드를 명시해야 하고, 생략한 필드는 현재 값 그대로 둔다. title·objective·repository 목록은 이 명령으로 바꾸지 않는다 — 정체성 변경 요청은 진행하지 않고 사용자에게 되돌린다. Next Action을 `task:`로 바꿀 때는 canonical Task ID만 쓰고 생성하지 않는다. Next Action을 명시하면 현재 값과 같더라도 그 Task의 존재를 검증하고, 명시하지 않으면 레코드가 이미 갖고 있던 참조는 검증하지 않는다.

성공 시 `project_id`, `project_item_id`, `source_node_id`, 갱신된 다섯 필드를 보고한다. `PROJECT_RECORD_NOT_FOUND`·`DUPLICATE_PROJECT_RECORD`에서는 레코드를 만들거나 고르지 않는다. `PROJECT_UPDATE_UNSETTLED`는 쓴 값이 아직 정착하지 않은 것이므로 같은 플래그로 다시 실행한다. `PROJECT_UPDATE_MISMATCH`는 다른 writer가 값을 바꿨을 수 있으므로 현재 상태를 다시 읽어 확인한 뒤 판단한다. `INVALID_PROJECT_NEXT_ACTION`은 병합 결과가 active 규칙을 어기는 것이므로 Health와 Next Action을 함께 맞춘 패치로 다시 낸다 — 중단된 재구성으로 어긋난 레코드도 이 방법으로 복구한다. `INVALID_PROJECT_ITEM`은 운영 필드가 비어 있거나 Project 옵션과 어긋난 상태이므로 update가 아니라 승인된 원래 payload의 `project register`로 복구한다.
