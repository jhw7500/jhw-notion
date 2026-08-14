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
  --repo-id <repo-id> --slug <owner/name> --repo-path <absolute-checkout-root>
```

이 명령이 checkout root/origin, private GitHub repository, node ID를 검증한다. 실패하면 Project 등록을 진행하지 않는다. 다른 node 충돌, ambiguous origin, public repository에서 새 ID나 파일 편집으로 우회하지 않는다.

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

성공 시 `project_id`, `project_item_id`, `source_node_id`, `issue_number`만 보고한다. partial failure 후에는 동일 approved payload만 재시도한다. 다른 body/field/node를 자동 채택하거나 중복 item을 만들지 않는다.

exit `0`에 `journal_warning.code=JOURNAL_WRITE_FAILED`가 있어도 registration은 이미 성공했으므로 재시도하지 않고 measurement gap만 보고한다. nonzero에서는 stable code만 보고 secret/private path를 출력하지 않는다.
