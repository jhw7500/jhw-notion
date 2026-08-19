---
description: Use when the user explicitly requests Project Control portfolio status, an on-demand export, or live preflight
argument-hint: "(status [--project prj-id] [--page page-id] | export | preflight)"
---

# /jhw:portfolio — 명시적 Project Control 조회

허용 동작은 `status`, `export`, `preflight`뿐이다. 현재 요청과 bounded command 결과만 사용한다. 이전 session, Notion, memory, recall/load/cclog, 광범위 Git history를 자동으로 불러오지 않는다.

## status

```bash
jhw-control portfolio status
jhw-control portfolio status --project <prj-id>
jhw-control portfolio status [--project <prj-id>] --page <page-id>
```

아래 metadata를 항상 표시한다.

- `page_id`, 반환 item 수, `total_items`
- `truncated`, `next_page_id`(없으면 `none`)
- raw stdout에 접근할 수 있을 때만 마지막 newline을 포함한 UTF-8 byte 길이; 아니면 `not measured`
- CLI 경계: output 12 KiB, page당 최대 20 items

`truncated: true`여도 다음 page를 자동 조회하지 않는다. 사용자가 “다음/계속/전체” 또는 exact page ID를 명시한 경우에만 반환된 `next_page_id`를 쓴다. `--all`, 임의 page ID, page-size 옵션을 만들지 않는다.

## export

사용자가 요청한 때만 실행한다.

```bash
jhw-control portfolio export
```

반환된 JSON/Markdown relative path와 checksum만 보여준다. export는 private host snapshot으로 향하는 on-demand 단방향 파생 출력이다. import, 역동기화, timer, schedule을 만들지 않는다.

status·export 공통 산출물 구성: 항목은 Priority(P0→P3)→project_id로 정렬되고 markdown은 `## P1` 식 그룹 헤딩 아래 Objective·Repositories 컬럼을 포함한다(Priority는 컬럼이 아니라 헤딩). Registry 파생 `## Repositories` 요약(`allow_public` = Record에 영속된 opt-in이며 live 공개여부가 아님)은 **page-1 markdown에만** 렌더되고(export는 `portfolio.md`), JSON 쪽 `repositories` 배열은 status 전 페이지 payload와 `schema_version: 2` snapshot에 항상 실린다. status와 export는 페이지 예산 계산이 달라 page-N 항목 구성이 서로 일치하지 않을 수 있다. 두 명령 모두 Registry 요약을 읽으므로 Registry 손상 시 corruption 계열 오류로 fail-closed한다.

## preflight

사용자가 live go/no-go를 명시적으로 요청한 경우에만 실행한다.

```bash
jhw-control preflight
```

`ready`는 다음 일곱 check가 모두 `ok`여야 한다: `credentials`, `authority`, `notion_guard`, `project`, `registry_repository`, `registry_issue`, `registry_git`.

- committed regular HEAD authority가 epoch 1 / legacy / no-cutover이고 installed version이 minimum 이상인지 확인한다.
- Notion database/data-source ancestry를 read-only로 확인한다.
- Project token scope가 정확히 `project` 하나인지, Project/Registry repository가 private인지, Registry SSH remote identity가 exact/unique인지 확인한다.
- read-only prerequisite가 모두 통과한 뒤에만 exact title/body를 가진 고정 Project DraftIssue fixture의 field를 write/restore하고, 이와 독립된 Registry Issue를 unchanged-write한다. 둘의 source identity를 결합하지 않는다.

실패를 cache/추정으로 덮거나 scope를 확장하지 않는다. 이 스킬은 Project 등록, Task Claim, authority file 생성/변경을 하지 않는다.

exit `0` + `journal_warning.code=JOURNAL_WRITE_FAILED`는 preflight 자체가 성공하고 measurement gap만 생긴 것이다. 재시도하지 않는다. exit `78`은 NO-GO이며 operator 수정 후 live preflight부터 다시 한다. raw credential/private path는 출력하지 않는다.
