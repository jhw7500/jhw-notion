<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-09 | Updated: 2026-04-29 -->

# tools

## Purpose
9개 MCP 도구 핸들러. 각 파일이 하나의 `jhw_*` 도구를 정의하며, `register*(server: McpServer)` 함수를 export하여 `server.ts`에서 등록된다.

## Key Files

| File | Description |
|------|-------------|
| `search.ts` | `jhw_search` — Notion 통합 키워드 검색 |
| `status.ts` | `jhw_status` — 워크스페이스 현황 (프로젝트/결정/선호도 요약) |
| `context.ts` | `jhw_context` — 특정 프로젝트의 관련 정보 일괄 로드 |
| `history.ts` | `jhw_history` — 특정 프로젝트의 시간순 활동 타임라인 |
| `record.ts` | `jhw_record` — DB에 새 레코드 생성 (5개 DB: decisionLog/projects/preferences/knowledgeBase/references). `report` select(redmine 보고 분류) + `project` relation 자동 매칭 지원. |
| `note.ts` | `jhw_note` — Knowledge Base **DB**에 메모 항목 생성 (이전: wrapper page에 children. 현재: DB row + properties). `category`/`tags`/`report`/`project` 지원. |
| `delete.ts` | `jhw_delete` — 레코드 삭제 또는 archived 처리 |
| `start.ts` | `jhw_start` — 프로젝트 시작 (projects DB + Decision Log 초기 항목 원스톱 생성) |
| `close.ts` | `jhw_close` — 프로젝트 종료 + 회고 (상태 변경 + Knowledge Base에 회고 기록) |

## For AI Agents

### Working In This Directory
- 1 파일 = 1 도구. 파일명과 도구명이 대응 (`record.ts` → `jhw_record`).
- 파라미터 유효성 검사에 `zod` 스키마 사용.
- Notion API 호출은 `../notion-client.ts`의 `getNotionClient()` 사용.
- DB ID는 `../config.ts`의 `NOTION_CONFIG.databases` 참조 (5개 DB). `pages.*`는 더 이상 없음 — KB/References도 DB로 이동.
- redmine 보고 분류용 `report` select 옵션 10종은 `REPORT_VALUES` (5개 DB 공통).

### Testing Requirements
- 도구 추가 시: 파일 생성 → `../server.ts`에 import + register 호출 추가 → `npm run build`.
- Notion API 응답 구조가 변경되면 해당 도구의 응답 파싱 로직 수정 필요.

### Common Patterns
- 읽기 도구 (`search`, `status`, `context`, `history`): Notion API query → 결과 포맷팅 → text 반환.
- 쓰기 도구 (`record`, `note`, `start`, `close`, `delete`): 파라미터 검증 → Notion API create/update → 결과 URL 반환.
- 모든 도구가 `server.tool()` 메서드로 등록되며, 도구명/설명/zod 스키마/핸들러를 인자로 받음.

## Dependencies

### Internal
- `../notion-client.ts` — `getNotionClient()`
- `../config.ts` — `NOTION_CONFIG`, `DatabaseName`

### External
- `@modelcontextprotocol/sdk` — `McpServer` 타입
- `@notionhq/client` — Notion API 응답 타입
- `zod` — 파라미터 스키마 정의

<!-- MANUAL: -->
