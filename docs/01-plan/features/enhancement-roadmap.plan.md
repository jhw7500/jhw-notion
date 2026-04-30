# jhw-notion 고도화 6주 로드맵

- **작성일**: 2026-04-30
- **출처**: Codex 어드바이저(architecture/backend, exit 0) + Claude UX 합성. Gemini는 IneligibleTier 인증 실패로 미사용.
- **상태**: 확정 (decisionLog 등록 예정)

## 0. TL;DR

`project` 필드 정합성을 먼저 잡지 않으면 search/context/history/report/recall이 서로 다른 기준으로 데이터를 본다. **첫 PR 범위는 P0-1 (정합성 + 공통 resolver) 한정**. 그 위에 안정성 레이어(P0-2) → 보고 자동화(P0-3) → 로컬 메모리(P1-1) → 스키마 리팩토링(P1-2) → 임베딩/라이브테스트(P2) 순.

## 1. 발견된 갭

### 1.1 critical: project 필드 타입 불일치

| 파일 | 라인 | 처리 |
|---|---|---|
| `mcp-server/src/tools/record.ts` | 107 | relation으로 자동 변환 |
| `mcp-server/src/tools/context.ts` | 48 | rich_text contains |
| `mcp-server/src/tools/history.ts` | 45 | rich_text contains |
| `mcp-server/src/tools/start.ts` | 56 | rich_text로 직접 씀 |

→ start로 등록한 결정은 context/history가 찾지만 record로 등록한 결정은 못 찾는 식의 비대칭 버그.

### 1.2 9개 도구 갭

| 영역 | 갭 | 우선조치 |
|---|---|---|
| 검색 (`search.ts:17`) | `notion.search({query, page_size:10})`만. pagination·DB필터·snippet 없음 | `dbs/limit/cursor/includeContent/sort/filters` 인자 |
| 프로젝트 리콜 | 동명이인·첫 결과 선택 오매칭 | `resolveProject()` exact title 우선 + 다중 후보 |
| context LLM 친화성 | block 50개 raw JSON, source 부족, token budget 없음 | `{summary, facts, decisions, openQuestions, sources, truncated}` |
| 쓰기 idempotency | 즉시 create — 재시도시 중복 | `idempotencyKey`, canonical duplicate query, `dryRun`, `upsert` |
| 에러/관측성 | 예외 그대로 throw, `resolveProjectRelationId`는 catch 후 null로 은폐 | `NotionError` 정규화: `requestId/tool/operation/retryable/cause` |
| status `count` | 5개만 조회한 부분 count를 전체처럼 표시 | `returnedCount/hasMore` 명시 |

## 2. 신규 도구 설계

### 2.1 보고 자동화 — `jhw_report_preview` + `jhw_report_export`

신규 파일:
- `mcp-server/src/tools/report-preview.ts`
- `mcp-server/src/tools/report-export.ts`
- `mcp-server/src/report/{query,format}.ts`
- `mcp-server/src/cache/report-cache.ts`
- `mcp-server/src/server.ts:10` 등록

입력 스키마:
```ts
// preview
{ period: "week"|"month"|"custom", start?, end?, reports?: ReportValue[],
  dbs?: DatabaseName[], groupBy?: "report"|"project"|"db", includeNone?, useCache? }
// export
{ previewId?, period, start?, end?, format: "markdown"|"redmine"|"json",
  writeBack?: { enabled, db?: "knowledgeBase"|"decisionLog", title? } }
```

캐시: 메모리 LRU + `~/.cache/jhw-notion/reports/*.json` 옵션. cache key = `toolVersion + schemaVersion + start + end + reports + dbs`. last_edited_time 기반 incremental은 P1.

Rate limit: 모든 호출을 `notion/api.ts` 래퍼로 → `Retry-After` 우선, DB query 동시성 1~2.

### 2.2 로컬 retrieval layer — `jhw_recall` + `jhw_remember`

```
mcp-server/src/cache/page-cache.ts
mcp-server/src/memory/indexer.ts
mcp-server/src/memory/summarizer.ts
mcp-server/src/memory/vector-store.ts  (P0=SQLite FTS5, P1=sqlite-vec)
```

자동: `jhw_context`/`jhw_search` 호출 시 본 페이지를 자동 cache 저장. `jhw_recall`은 Notion API 호출 전에 로컬 즉시 조회. stale이면 `stale: true` + 백그라운드 refresh.

위험: 임베딩 비용/키 관리. 권한 변경 후 캐시 잔존 보안 리스크.
대안: P0는 BM25/SQLite FTS5만, P1에 embedding.

UX: 세션 시작 시 `~/.claude/projects/<slug>/memory/MEMORY.md`에 `jhw_recall(top-3)` 자동 주입.

## 3. Schema-driven 리팩토링

`mcp-server/src/schema.ts` 신규 — DB 메타데이터를 한 곳에 집중.

```ts
export const DATABASE_SCHEMAS = {
  decisionLog: {
    id: NOTION_CONFIG.databases.decisionLog,
    title: "title",
    project: { type: "relation", target: "projects" },
    properties: {
      status: { type: "select", default: "확정" },
      rationale: { type: "rich_text" },
      area: { type: "select" },
      ...
    }
  }
}
```

이후 record의 if/else 더미 제거 → schema-driven property builder. context/history/report도 project 타입을 schema에서 읽어 relation/rich_text 자동 선택.

신규 DB 추가 비용 = schema 1줄.

## 4. 안정성 레이어

`mcp-server/src/notion/api.ts` 5층:
- `withRetry(op, fn)` — 429/5xx/네트워크 → exponential backoff + jitter
- `withTimeout` — search 짧게, report/context 길게
- `CircuitBreaker` — 연속 실패 시 fast-fail
- `RateLimiter` — 공통 큐
- `safeTool(handler)` — 모든 결과 `{ok, data?, error?}` 정규화

multi-step 도구 보호:
- `start.ts:32` — operationId + 재개
- `close.ts:39` — completedSteps 반환
- `delete.ts:19` — catch 원인 기록 후 fallback

## 5. 테스트 전략

- `*.test.ts` (mock only, CI 기본)
- `*.live.test.ts` (`RUN_LIVE_NOTION_TESTS=1`일 때만)
- `src/__fixtures__/notion/*.json` — 실제 응답 익명화
- **Live 테스트는 sandbox DB로** — 운영 DB 직접 쓰기 금지

P0: notion/api.ts retry, schema property builder, project 회귀
P1: report query/format snapshot, cache fixture
P2: live integration

## 6. 6주 로드맵

| 주차 | 우선 | 산출물 |
|---|---|---|
| 1 | P0-1 | `schema.ts`, `notion/resolve-project.ts`, project 회귀 테스트 |
| 2 | P0-2 | `notion/api.ts` retry/backoff/rate-limit, 표준 에러 |
| 3 | P0-3 | `jhw_report_preview` MVP, redmine markdown |
| 4 | P1-1 | SQLite FTS5 cache, `jhw_recall`, 자동 저장 |
| 5 | P1-2 | schema-driven record/query 리팩토링 |
| 6 | P2 | optional embedding, summary cache, `*.live.test.ts` |

## 7. 스킬 슬림화 (13 → 7)

현재 13: record/note/review/delete/search/context/history/status/start/close/import/cclog + AGENTS.md

개편안:

| 핵심 (7개) | 흡수 | 비고 |
|---|---|---|
| `/jhw:save` | record + note (+ delete --delete) | DB 자동 판별. note는 KB 전용 alias로 유지 가능 |
| `/jhw:project` | start + close (`--start`/`--close` 플래그) | 프로젝트 라이프사이클 단일 진입점 |
| `/jhw:recall` | search + context + history | 모드 자동 판별 (키워드/프로젝트/타임라인) |
| `/jhw:review` | (유지) | 세션 분석은 LLM 영역 |
| `/jhw:report` | (신규) | preview + export |
| `/jhw:status` | (유지) | 워크스페이스 대시보드 |
| `/jhw:import` | (유지) | Notion → 로컬 memory |
| `/jhw:cclog` | **별도 유지** | 대상이 Notion이 아니라 Claude Code 세션. recall과 결이 다름 |

→ 실질 8개. delete는 save의 플래그로 흡수, note는 사용 빈도 높으면 alias 유지.

## 8. 첫 PR 체크리스트 (1주차 P0-1)

- [x] `mcp-server/src/schema.ts` (신규)
- [x] `mcp-server/src/notion/resolve-project.ts` (신규)
- [x] `mcp-server/src/tools/record.ts` (resolveProjectId import로 단순화)
- [x] `mcp-server/src/tools/context.ts` (decisionLog filter를 relation으로)
- [x] `mcp-server/src/tools/history.ts` (decisionLog filter를 relation으로)
- [x] `mcp-server/src/tools/start.ts` (decisionLog의 project를 relation으로)
- [x] `mcp-server/src/tools/__tests__/project-consistency.test.ts` (회귀)

## 9. 위험 / 대안

- **위험**: relation 필터 변경 시 legacy rich_text 데이터(start로 등록된 과거 결정)가 누락될 수 있음.
  - **대안**: context/history에서 relation 결과 0건이면 rich_text contains로 한 번 더 fallback. 데이터 마이그레이션 별도 스크립트 (P1).
- **위험**: 로컬 캐시 도입 후 Notion 권한 변경된 페이지가 캐시에 잔존.
  - **대안**: `last_edited_time` + `archived` 체크로 staleness invalidation. opt-out 환경변수.
- **위험**: schema-driven 리팩토링 중 일시적으로 도구 동작 깨질 수 있음.
  - **대안**: feature flag `JHW_SCHEMA_V2=1` 환경변수로 점진 도입.

## 10. Source

- Codex artifact: `.omc/artifacts/ask/codex-jhw-notion-...-2026-04-30T03-34-32-798Z.md` (138K)
- Gemini artifact: `.omc/artifacts/ask/gemini-...-2026-04-30T03-30-12-031Z.md` (실패 — IneligibleTier)
