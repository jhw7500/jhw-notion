<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-30 | Updated: 2026-04-30 -->

# claude (스킬)

## Purpose
AI TUI에서 `/jhw:*` 접두사로 호출되는 스킬. 각 스킬은 사용자 의도를 해석하여 적절한 MCP 도구(`jhw_*`)를 호출하는 워크플로우를 정의한다. Claude Code, Gemini CLI, OpenCode에서 심링크로 공유된다.

## 핵심 스킬 (8개)

| File | Description |
|------|-------------|
| `save.md` | Notion 통합 저장 — record/note/delete 흡수, DB 자동 판별 |
| `project.md` | 프로젝트 라이프사이클 — start/close 통합 (`--start`/`--close`) |
| `recall.md` | 통합 회상 — search/context/history 통합 (모드 자동 판별) |
| `review.md` | 세션 마무리 시 저장 후보 정리 + 승인 저장 |
| `report.md` | (3주차 신규 예정) 일/주/월 보고서 — preview + export |
| `status.md` | 워크스페이스 현황 대시보드 |
| `import.md` | Notion 검색 결과 → 현재 프로젝트 memory 폴더로 불러오기 |
| `cclog.md` | Claude Code 세션 대화 기록 조회 (Notion이 아닌 CC JSONL) |

## Deprecated alias (다음 메이저 릴리스에서 삭제)

| File | Replacement |
|------|-------------|
| `record.md` | `/jhw:save` |
| `note.md` | `/jhw:save` (knowledgeBase 자동 라우팅) |
| `delete.md` | `/jhw:save --delete <id>` |
| `search.md` | `/jhw:recall <키워드>` |
| `context.md` | `/jhw:recall <프로젝트명>` |
| `history.md` | `/jhw:recall <프로젝트명> --history` |
| `start.md` | `/jhw:project --start <name>` |
| `close.md` | `/jhw:project --close [name]` |

## For AI Agents

### Working In This Directory
- 각 파일은 YAML frontmatter (`description`) + 마크다운 본문 형식.
- 스킬은 MCP 도구를 호출하는 워크플로우 지시서. 실제 로직은 `mcp-server/src/tools/`에 있음.
- 저장 전 반드시 사용자 승인을 받는 패턴이 공통 (1회만, 이후 한 흐름).
- `notion-create-pages` 직접 호출 시 date 프로퍼티는 expanded 키 사용: `"date:date:start":"YYYY-MM-DD"`.
- project 필드는 schema-driven으로 **relation** 처리 (P0-1 정합성 정리). `mcp-server/src/notion/resolve-project.ts` 참조.

### Common Patterns
- 통합 스킬 (save/project/recall): 모드/플래그 자동 판별 → MCP 호출.
- 조회 전용 (recall, status, import, cclog, history alias): 결과 정리 표시.
- 쓰기 (save, project, review): 미리보기 → 승인 → 저장 → URL 반환.

## Dependencies

### Internal
- `mcp-server/src/tools/` — 각 스킬이 대응하는 MCP 도구 호출
- `mcp-server/src/notion/resolve-project.ts` — 공통 project resolver (P0-1)
- `mcp-server/src/schema.ts` — DB 메타데이터 (P0-1)

<!-- MANUAL: -->

## Custom Skills (Manual — 자동 재생성 대상 아님)

위 자동 생성 목록 외에 수동으로 추가된 스킬. `jhw-notion` MCP 서버가 `AGENTS.md`를 재생성해도 이 섹션은 보존된다.

| File | Description |
|------|-------------|
| `import.md` | Notion 검색 결과를 현재 프로젝트 `~/.claude/projects/<slug>/memory/` 폴더로 불러와 로컬 참조 파일로 저장. 다중 키워드 병렬 검색 + 승인 + 연속 실행 지원. |
| `cclog.md` | Claude Code 세션 JSONL을 시간순으로 조회 (도구 호출 포함 옵션). 대상이 Notion이 아니므로 recall에 흡수하지 않고 별도 유지. |

### Patterns
- 불러오기 (`import`): Notion 검색 → 후보 제시 → 승인 → fetch → 로컬 memory 파일 저장 + `MEMORY.md` 인덱스 갱신.
- 세션 조회 (`cclog`): JSONL 파싱 → 시간순 메시지/도구 호출 출력. `--last N` / `--tools` 플래그.
