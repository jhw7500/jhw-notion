---
description: Use when the user explicitly requests Project Control portfolio status, an on-demand export, or live preflight
argument-hint: "(status [project-id] [--page page-id] | export | preflight)"
---

# /jhw:portfolio — 명시적 포트폴리오 조회

허용 동작은 `status`, `export`, `preflight`뿐이다. 현재 요청과 반환 payload만 사용하며 이전 세션, Notion, memory, recall/cclog/load, 광범위한 Git history를 자동으로 불러오지 않는다.

## status

기본 또는 특정 프로젝트/페이지를 한 번 조회한다.

```bash
jhw-control portfolio status
jhw-control portfolio status --project <prj-id>
jhw-control portfolio status [--project <prj-id>] --page <page-id>
```

결과와 함께 아래 metadata를 항상 표시한다.

- `page_id`, 반환 item 수, `total_items`
- `truncated`, `next_page_id`(없으면 `none`)
- CLI가 반환한 정확한 stdout JSON envelope와 마지막 줄바꿈까지의 UTF-8 byte 길이를 로컬에서 측정한 값. TUI가 정확한 raw stdout bytes에 접근해 측정할 수 없으면 `not measured`로 표시하며 `payload_bytes` 필드를 가정하거나 결과 객체에서 수치를 만들어내지 않는다.
- CLI가 강제하는 한도(12 KiB/20 items)

기본 조회에서 `truncated: true`여도 `next_page_id`를 자동으로 따라가지 않는다. 사용자가 `다음/계속/전체` 또는 특정 page ID를 **명시적으로 요청한 경우에만** 반환된 ID로 다음 호출을 실행한다. 임의 page ID, `--all`, page-size 옵션을 만들지 않는다.

## export

사용자가 요청한 때만 실행하고 반환된 JSON/Markdown 경로와 checksum을 보여준다.

```bash
jhw-control portfolio export
```

export는 Registry/Project → snapshot의 단방향 파생 출력이다. import, 역동기화, timer, schedule을 만들거나 자동 실행하지 않는다.

## preflight

```bash
jhw-control preflight
```

이 live preflight 결과가 Phase 1A 운영의 go/no-go다. 실패를 캐시나 추정으로 덮지 않는다. 이 스킬은 Project 등록·수정 또는 Task Claim을 수행하지 않는다.
