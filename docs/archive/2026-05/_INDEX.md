# Archive Index — 2026-05

> 2026년 5월 완료된 PDCA 사이클 모음

---

## Archived Features

### report-date-filter-fix

| Item | Value |
|---|---|
| **PDCA Cycle** | #2 |
| **Started** | 2026-05-08 |
| **Archived** | 2026-05-08 |
| **Match Rate** | 100% |
| **Iteration Count** | 0 |
| **Summary** | `notion.databases.query`의 server-side date filter가 multi-data-source DB에서 무시되는 회귀 — `query.ts:117-119` 메모리 사이드 필터 강제로 차단 (8 LOC fix). 회귀 7건 추가 (mock 5 + live 2). SDK v3 + dataSources 마이그레이션은 P1-3b로 분리 |
| **Documents** | [Plan](./report-date-filter-fix/report-date-filter-fix.plan.md) · [Analysis](./report-date-filter-fix/report-date-filter-fix.analysis.md) · [Report](./report-date-filter-fix/report-date-filter-fix.report.md) |
| **Implementation Commit** | `5a20757 fix(report): date 필터 메모리 사이드 강제 — server filter 무시 회귀` |

### p1-3b-datasource-migration

| Item | Value |
|---|---|
| **PDCA Cycle** | #3 |
| **Started** | 2026-05-08 |
| **Archived** | 2026-05-08 |
| **Match Rate** | 97.25% |
| **Iteration Count** | 0 |
| **Summary** | v5 SDK + `dataSources.query()` 마이그레이션의 사전 단계 — Notion REST API(Notion-Version 2025-09-03) 직접 호출로 10개 DB(prod 5+sandbox 5) data_source_id 매핑 확보. `schema.ts.dataSourceId: string` + `getDataSourceId(db)` 헬퍼 + sandbox 격리. 회귀 8건. 운영 코드 변경 0. 후속 p1-3c에서 SDK v2→v5 + dataSources.query 호출 마이그레이션 진행 예정 |
| **Documents** | [Plan](./p1-3b-datasource-migration/p1-3b-datasource-migration.plan.md) · [Analysis](./p1-3b-datasource-migration/p1-3b-datasource-migration.analysis.md) · [Report](./p1-3b-datasource-migration/p1-3b-datasource-migration.report.md) |
| **Implementation Commit** | `12a815c feat(p1-3b): data_source_id 매핑 인프라 (Do 단계)` |
| **Side Improvements** | Stop hook(`stop-text-required.py`) 도입 + CLAUDE.md 위반 사례 추가 + Notion 토큰 source 일원화 |

### p1-3c-datasource-query-migration

| Item | Value |
|---|---|
| **PDCA Cycle** | #4 |
| **Started** | 2026-05-08 |
| **Archived** | 2026-05-08 |
| **Match Rate** | 99.25% |
| **Iteration Count** | 0 |
| **Summary** | Notion v5 SDK(@notionhq/client v2.3.0 → v5.20.0) + `notion.dataSources.query()` 호출 일괄 마이그레이션. `notion/api.ts queryDataSource` wrapper 1개로 production 10 호출 통일 (getDataSourceId 매핑 + callNotion + union 노출 + incomplete warning 캡슐화). mock 11 파일 + helper 마이그레이션. live 회귀 7건 + v5 응답 union 검증 신규 1건. 메모리 필터(report/query.ts:117-119) 보험 보존. 9 MCP 도구 외부 인터페이스 무변화 |
| **Documents** | [Plan](./p1-3c-datasource-query-migration/p1-3c-datasource-query-migration.plan.md) · [Design](./p1-3c-datasource-query-migration/p1-3c-datasource-query-migration.design.md) · [Analysis](./p1-3c-datasource-query-migration/p1-3c-datasource-query-migration.analysis.md) · [Report](./p1-3c-datasource-query-migration/p1-3c-datasource-query-migration.report.md) |
| **Implementation Commits** | `210cba4` chore(deps) → `ec274e7` feat(wrapper) → `6822467` refactor(callers) → `30b4438` test(mocks) → `e48b04a` test(live) (5단계, bisect 친화) |
| **Architecture** | Option C (Pragmatic) — api.ts 확장, 신규 파일 0 |
| **Mid-cycle Adjustment** | wrapper isFullPage 필터 → union 노출 (mock 호환을 위한 정정) |

### p1-3d-cursor-pagination

| Item | Value |
|---|---|
| **PDCA Cycle** | #5 |
| **Started** | 2026-05-08 |
| **Archived** | 2026-05-08 |
| **Match Rate** | 100% |
| **Iteration Count** | 0 |
| **Summary** | `queryDataSource` wrapper에 `paginate?: boolean` 옵션 + cursor 자동 루프 + `MAX_PAGES=50` (5000건) hardcoded 안전장치 도입. `report/query.ts:104` 호출만 활성화 — 다른 9 호출은 의도적 N건 cap 보존. mock 4건 추가 (단일/다중/MAX/disabled). 4-layer defense 완성 (#2 메모리 필터 → #3 매핑 → #4 API 마이그레이션 → #5 cursor pagination) |
| **Documents** | [Plan](./p1-3d-cursor-pagination/p1-3d-cursor-pagination.plan.md) · [Analysis](./p1-3d-cursor-pagination/p1-3d-cursor-pagination.analysis.md) · [Report](./p1-3d-cursor-pagination/p1-3d-cursor-pagination.report.md) |
| **Implementation Commits** | `dbdad49` Plan + `b6dee92` feat(notion/api): paginate option + cursor loop with MAX_PAGES safety |
| **Architecture** | Option A (Pragmatic) — wrapper 확장, design 생략 (변경 < 80 LOC) |
| **Cycle 시간** | ~30분 (가벼운 사이클) |

---

## Statistics

| Metric | Value |
|---|---|
| Total archived features | 4 |
| Average match rate | 99.13% |
| Total cycles | 4 |
| Highest Match | p1-3d-cursor-pagination (100%) + report-date-filter-fix (100%) |
