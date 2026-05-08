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

---

## Statistics

| Metric | Value |
|---|---|
| Total archived features | 2 |
| Average match rate | 98.6% |
| Total cycles | 2 |
