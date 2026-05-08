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

---

## Statistics

| Metric | Value |
|---|---|
| Total archived features | 1 |
| Average match rate | 100% |
| Total cycles | 1 |
