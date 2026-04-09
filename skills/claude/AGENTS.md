<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-09 | Updated: 2026-04-09 -->

# claude (스킬)

## Purpose
AI TUI에서 `/jhw:*` 접두사로 호출되는 스킬 10개. 각 스킬은 사용자 의도를 해석하여 적절한 MCP 도구(`jhw_*`)를 호출하는 워크플로우를 정의한다. Claude Code, Gemini CLI, OpenCode에서 심링크로 공유된다.

## Key Files

| File | Description |
|------|-------------|
| `record.md` | 확정된 정보를 Notion에 즉시 저장 (DB 자동 판별) |
| `note.md` | Knowledge Base 페이지에 기술 지식/메모 저장 |
| `review.md` | 세션 마무리 시 저장 후보를 정리하고 승인 후 저장 |
| `search.md` | Notion 전체 키워드 통합 검색 |
| `context.md` | 특정 프로젝트의 관련 정보 일괄 로드 |
| `history.md` | 특정 프로젝트의 시간순 활동 타임라인 |
| `status.md` | 워크스페이스 현황 대시보드 |
| `start.md` | 새 프로젝트 시작 (Notion에 필요한 모든 것 원스톱 생성) |
| `close.md` | 프로젝트 종료 + 회고 작성 → Knowledge Base 등록 |
| `delete.md` | 레코드 삭제 또는 폐기 처리 |

## For AI Agents

### Working In This Directory
- 각 파일은 YAML frontmatter (`description`) + 마크다운 본문 형식.
- 스킬은 MCP 도구를 호출하는 워크플로우 지시서. 실제 로직은 `mcp-server/src/tools/`에 있음.
- 저장 전 반드시 사용자 승인을 받는 패턴이 공통.
- `notion-create-pages`를 직접 호출할 때 date 프로퍼티는 expanded 키 사용: `"date:date:start":"YYYY-MM-DD"`.

### Common Patterns
- 읽기 도구 (`search`, `status`, `context`, `history`): 결과를 정리하여 표시.
- 쓰기 도구 (`record`, `note`, `start`, `close`): 미리보기 → 승인 → 저장 → URL 반환.
- `delete`: 상태를 "폐기"로 변경하거나 실제 삭제.

## Dependencies

### Internal
- `mcp-server/src/tools/` — 각 스킬이 대응하는 MCP 도구 호출

<!-- MANUAL: -->
