---
description: Use when the user explicitly requests a JHW project start, close, selection, or Phase 1A trial registration
argument-hint: "(--start | --close | --trial) [프로젝트명]"
---

# /jhw:project — 프로젝트 시작·종료·시험 등록

## 권한 경계

- 일반 `/jhw:project`, `--start`, `--close`는 Phase 1A에서도 기존 Notion workflow와 live authority를 그대로 사용한다.
- Registry 시험 등록은 명시적 `/jhw:project --trial` 또는 동등한 “Phase 1A trial 등록” 요청에서만 사용한다. 일반 호출을 Registry로 자동 라우팅하지 않는다.
- 시험 등록은 authority 변경이나 기존 데이터 migration이 아니다. Phase 1A 제어 조회/작업은 `/jhw:portfolio`, `/jhw:task`를 명시적으로 사용한다.

## 일반 Notion workflow

### `/jhw:project` 또는 `--start`

인자 없이는 `jhw_status`로 진행중 Projects를 보여주고 선택받는다. `--start`는 이름·한 줄 설명(필수), repo·기술 stack(선택)을 수집한 뒤:

1. `jhw_search`로 동일명 확인
2. 한 번 미리보기·승인
3. `jhw_start` 호출
4. Projects/Decision Log/페이지 결과 URL 보고

### `--close`

인자가 없으면 `jhw_status` 결과에서 선택받는다. 달성 내용·배운 점은 선택적으로 묻고 건너뛸 수 있다. 한 번 미리보기·승인 후 `jhw_close`를 호출한다. 이미 완료된 프로젝트는 변경하지 않는다.

`jhw_start`/`jhw_close`의 `description`/`achievement`/`lessons`는 단일 rich text이므로 각 1800자 이하로 유지한다. 긴 내용은 요약하거나 별도 KB로 분리한다.

## `--trial` — 한 제안, 한 승인, 한 호출

### 입력 경계

- 현재 사용자 요청과 현재 저장소의 직접 사실만 사용한다.
- 이전 세션, Notion, memory, recall/cclog/load, 광범위한 Git history를 자동으로 읽지 않는다.
- registration JSON 파일을 만들거나 읽지 않는다.
- 기존 canonical `repo_id`나 `task_id`를 추측하지 않는다. 없으면 짧게 질문한다. 신규 Project임이 명확할 때만 새 `prj-...` ID를 제안하고, 기존 Project ID는 질문한다.

다음 값을 준비한다: `project_id`, title, objective, 1개 이상의 canonical `repo_id`, 그리고 다섯 운영 필드 `Status`, `Priority`, `Health`, `Next Action`, `Last Reviewed`.

허용값:

- Status: `proposed|active|paused|completed|cancelled`
- Priority: `P0|P1|P2|P3`
- Health: `on-track|at-risk|blocked|unknown`
- Next Action: `task:<canonical-tsk-id>` 또는 `wait:<short-condition>`
- Last Reviewed: `YYYY-MM-DD`

Task를 Next Action으로 지정했지만 canonical ID가 없으면 질문하며 만들지 않는다. 차단/대기 조건은 사실에 근거한 `wait:`만 사용한다.

### 승인과 실행

아홉 항목을 **하나의 통합 제안**으로 함께 보여준다. 수정이 필요하면 제안을 갱신한 뒤 최종안 전체에 대해 사용자 승인 한 번만 받는다.

승인 직후 파일 없이 다음 전체 인자를 한 번 호출한다. repo가 여러 개면 `--repo-id`를 반복한다.

```bash
jhw-control project register \
  --project <prj-id> --title <title> --objective <objective> \
  --repo-id <repo-id> [--repo-id <repo-id> ...] \
  --status <status> --priority <priority> --health <health> \
  --next-action <task:tsk-id-or-wait:condition> --last-reviewed <YYYY-MM-DD>
```

성공 시 `project_id`, `project_item_id`, `source_node_id`, `issue_number`를 보고한다. 실패 시 승인 없이 다른 값으로 재호출하지 않는다.
