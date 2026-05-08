# p1-3d-cursor-pagination Planning Document

> **Summary**: `queryDataSource` wrapper에 `paginate?: boolean` 옵션 추가. report/query.ts에서만 활성화하여 100건 한도 누락 방지. 내부 MAX_PAGES=50 안전장치.
>
> **Project**: jhw-notion
> **Version**: 0.1.0 (mcp-server)
> **Author**: hwjo
> **Date**: 2026-05-08
> **Status**: Draft

---

## Executive Summary

| 관점 | 내용 |
|---|---|
| **Problem** | Cycle #4(p1-3c)에서 `queryDataSource` wrapper에 `request_status.incomplete` warning만 도입. 실제 페이지가 100건(`page_size` 한도) 초과 시 silent 누락 가능 — 보고서가 N건 모두 필요한 케이스(`report/query.ts:104`)에서 회귀 위험. 다른 9 호출은 의도적 N건 cap이라 영향 0 |
| **Solution** | (1) `queryDataSource` wrapper에 `paginate?: boolean` 옵션 추가, (2) `paginate=true` 시 `start_cursor`/`next_cursor` 자동 루프, (3) 내부 `MAX_PAGES=50` (=5000건) 안전장치 hardcoded — 무한 루프 차단 + 도달 시 warning, (4) `report/query.ts:104` 호출만 `paginate: true` 활성화 (다른 9 호출은 의도적 N건 cap 유지), (5) mock test에 pagination 시나리오 추가 |
| **Function/UX 효과** | 사용자 가시 변화 0 (보고서가 100건 미만이면 동작 동일). 100건 초과 시점부터 자동으로 모든 결과 반환 — silent 누락 차단. wrapper API 호환 유지 (`paginate` 미지정 시 단일 호출, 기존 호출처 영향 0) |
| **Core Value** | Cycle #2~#4 누적 계층(메모리 필터 → 매핑 → API 마이그레이션 → pagination)의 마지막 안전망. 데이터 누적 시점에도 보고서 정확성 보장. wrapper 단일 수정점에 안전장치 hardcoded → 호출처 부담 0 |

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | `report/query.ts:104` 5 DB × 100 page_size = 500건 max. 누적 시 100건/DB 도달 가능 → 보고서 silent 누락. wrapper에 paginate 옵션 미존재 |
| **WHO** | jhw-notion mcp-server. 영향: report/query.ts 1 호출. 다른 9 호출 영향 0 |
| **RISK** | (1) 무한 루프 (next_cursor 응답 오류) — MAX_PAGES=50으로 차단, (2) MAX_PAGES 도달 시 warning만 출력하고 종료 — 누락 가능성 알림, (3) live test 비용 — sandbox에 100건 이상 데이터 없으면 mock 시뮬만 |
| **SUCCESS** | (1) wrapper에 paginate 옵션 + 내부 MAX_PAGES, (2) report/query.ts paginate 활성화, (3) mock 테스트 — 단일 페이지 / 다중 페이지 / MAX_PAGES 도달 3 케이스, (4) tsc 0, mock 116+3=119/119 PASS, (5) 다른 호출 영향 0 (mock 통과 유지) |
| **SCOPE** | In: wrapper 옵션 + report 활성화 + mock 시나리오. Out: live test 신규(sandbox 100건 데이터 없음), 다른 호출 paginate 활성화 |

---

## 1. Overview

### 1.1 Purpose

p1-3c에서 도입한 `queryDataSource` wrapper의 `request_status.incomplete` warning을 cursor 루프로 확장. 보고서(`report/query.ts`) 같은 "N건 모두 필요" 케이스에 silent 누락 0 보장. 다른 호출은 의도적 N건 cap이라 영향 받지 않도록 옵션 활성화.

### 1.2 Background

| 사이클 | 결과 | 본 사이클과 관계 |
|---|---|---|
| Cycle #2 (`report-date-filter-fix`) | 메모리 필터 보험 | 본 사이클이 누락 가능성을 추가로 차단 |
| Cycle #3 (`p1-3b`) | data_source_id 매핑 | 변경 없음 (활용만) |
| Cycle #4 (`p1-3c`) | wrapper + dataSources.query 마이그레이션 | wrapper에 paginate 옵션 추가 |
| **Cycle #5 (본 사이클)** | wrapper paginate 옵션 + report 활성화 | 마지막 안전망 |

영향 범위 (`page_size` grep):
- `page_size: 100`: **`report/query.ts:104`** ← 유일한 cursor 후보
- `page_size: 5/10/20`: 9 호출 — 의도적 N건 cap (변경 0)

### 1.3 Related Documents

- 직전 사이클: `docs/archive/2026-05/p1-3c-datasource-query-migration/`
- wrapper 구현: `mcp-server/src/notion/api.ts:queryDataSource` (Cycle #4)
- 영향 코드: `mcp-server/src/report/query.ts:104`

---

## 2. Scope

### 2.1 In Scope

- [ ] `mcp-server/src/notion/api.ts` `QueryDataSourceMeta` 인터페이스에 `paginate?: boolean` 필드 추가
- [ ] `queryDataSource` 함수 안에 cursor 루프:
  - `paginate=true` 시 `next_cursor`가 null이 될 때까지 반복 호출
  - 내부 `MAX_PAGES = 50` 안전장치 hardcoded (=5000건)
  - MAX_PAGES 도달 시 `console.warn(operation, "MAX_PAGES reached")` + 그때까지 results 반환
  - 반환 `nextCursor` — paginate 시 항상 null (모든 페이지 소진), MAX_PAGES 도달 시 마지막 cursor
- [ ] `mcp-server/src/report/query.ts:104` 호출에 `paginate: true` 활성화
- [ ] `mcp-server/src/notion/__tests__/api.test.ts` mock 시나리오 3건 추가:
  - 단일 페이지 (`paginate: true`이지만 next_cursor=null) — 1번 호출
  - 다중 페이지 (3 pages) — next_cursor 체인, 결과 합쳐짐 검증
  - MAX_PAGES 도달 — 51 응답 시뮬, 50번째에서 정지 + warning 검증
- [ ] tsc 0 errors, mock 119/119 PASS 유지

### 2.2 Out of Scope

- live test 신규 (sandbox에 100건 이상 데이터 없음 — mock 시뮬만으로 충분)
- 다른 9 호출의 paginate 활성화 (의도적 N건 cap 유지)
- AsyncIterator API 노출 (단일 호출 사이트만이라 과한 디자인)
- `result_type: "page"` 필터 활용 (Cycle #4 carry-over)
- v5 신규 `dataSources.{create,update,listTemplates}` 도구 작성

### 2.3 Assumptions

- **A1**: Notion v5 `dataSources.query`의 `start_cursor` 동작이 v2 `databases.query`와 동일 (cursor 호환)
- **A2**: `next_cursor`가 null일 때 추가 호출하지 않음 (Notion 표준)
- **A3**: 1 페이지당 100건 × 50 pages = 5000건 안전 한도 — 본 프로젝트 데이터 규모(~50건/DB)에 충분

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-01 | `QueryDataSourceMeta`에 `paginate?: boolean` 필드 | High | Pending |
| FR-02 | `paginate=true` 시 next_cursor 루프 자동 실행 | High | Pending |
| FR-03 | 내부 `MAX_PAGES=50` hardcoded 안전장치 + 도달 시 warning | High | Pending |
| FR-04 | `report/query.ts:104`에 `paginate: true` 적용 | High | Pending |
| FR-05 | mock 테스트 3건 (단일/다중/MAX 도달) | High | Pending |
| FR-06 | 다른 9 호출 영향 0 (mock 통과 유지) | High | Pending |
| FR-07 | tsc 0 errors | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | 측정 |
|---|---|---|
| Performance | report 호출 시 N pages × ~150ms (Notion API) — 100건 미만이면 변동 없음 | manual run |
| Test | mock 116→119 PASS (+3) | npm test |
| Backward compat | wrapper API 호환 (`paginate` 미지정 시 동작 동일) | grep |
| Safety | MAX_PAGES 한도로 무한 루프 차단 | mock test 검증 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01~07 모두 충족
- [ ] `git grep "paginate" mcp-server/src/` — wrapper + report 1곳 + mock test 3건만 노출
- [ ] mock 119/119 PASS (이전 116 → +3)
- [ ] tsc 0 errors
- [ ] 다른 9 호출의 mock 결과 변화 0 (regression 0)

### 4.2 Quality Criteria

- [ ] 변경 line 수 < 80 (wrapper +30, report 1줄, mock test +50)
- [ ] MAX_PAGES 상수 명명 명확 + 주석으로 사유 명시
- [ ] paginate 옵션 미사용 시 코드 path 변동 0

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| 무한 루프 (Notion이 next_cursor를 잘못 반환) | High | Low | `MAX_PAGES=50` hardcoded — 도달 시 break + warning |
| 데이터 누락 (50 pages × 100 = 5000건 초과) | Med | Very Low | 본 프로젝트 데이터 규모 ~50건/DB, 1년 누적해도 5000 미달 |
| paginate=true가 다른 호출에 잘못 적용 | High | Low | report/query.ts 1곳에만 활성화, mock test에서 paginate=false 케이스 통과 확인 |
| live 검증 부재 | Low | Low | sandbox에 100건 이상 데이터 부재 — mock 시뮬로 cursor 동작 검증 + Notion API 표준 신뢰 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|---|---|---|
| `mcp-server/src/notion/api.ts` | TS | `QueryDataSourceMeta` +1 field, `queryDataSource` 안에 cursor loop (~30 LOC) |
| `mcp-server/src/report/query.ts` | TS | line 104 호출의 meta에 `paginate: true` 추가 (1 LOC) |
| `mcp-server/src/notion/__tests__/api.test.ts` | Test | mock 3건 추가 (~50 LOC) |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|---|---|---|---|
| `queryDataSource` | call | 10 production paths | None — paginate 미지정 시 단일 호출 (default false) |
| `report/query.ts` | call | report-preview / report-export 도구 | Positive — 100건 초과 시 자동 paginate |
| 9 other callers (history/context/status/close/resolve-project) | call | tools/* | None — paginate 미지정 |
| mock test 11 파일 | mock | __tests__/* | None — 기존 mock 응답 형태 그대로 (paginate=false 동작) |

### 6.3 Verification

- [ ] tsc 0 errors
- [ ] mock 119/119 PASS
- [ ] `git diff --stat` — 3 파일만 변경
- [ ] `report/query.ts` 외 호출은 mock test 결과 변동 0

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Selected |
|---|:---:|
| Starter | ☐ |
| **Dynamic** | **☑** |
| Enterprise | ☐ |

### 7.2 Key Architectural Decisions

| Decision | Selected | Rationale |
|---|---|---|
| Scope: 자동 vs 옵션 vs iterator vs 보류 | **wrapper에 paginate 옵션 + report만 활성화 (Option A)** | 사용자 합의. 다른 9 호출 의도(N건 cap) 보존 + future-proof |
| paginate API 시그니처 | **`paginate?: boolean` + 내부 MAX_PAGES=50 hardcoded** | 사용자 합의. API 단순 + 안전장치 hardcoded. report 도메인 공량으로 5000건 충분 |
| MAX_PAGES 도달 처리 | **warning + 그때까지 results 반환** | silent 누락 차단(warning) + 보고서는 부분 결과로도 동작 가능 |
| live test | **미작성** | sandbox 100건 이상 데이터 부재. mock 시뮬로 cursor 동작 검증 |
| Design 단계 | **생략** | 변경 < 80 LOC, Plan §7.2 결정으로 충분 (Cycle #2/#3 패턴) |

### 7.3 Clean Architecture

기존 구조 유지. 변경: wrapper 1 layer + report caller 1줄 + mock test.

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] CLAUDE.md / AGENTS.md
- [x] TypeScript strict
- [x] Vitest (mock + live)
- [x] schema-driven (Cycle #1+#3)
- [x] wrapper 패턴 (Cycle #4)

### 8.2 Conventions to Define

신규 정의 불필요 — 기존 컨벤션 따름.

### 8.3 Environment Variables Needed

기존 + 변동 없음.

---

## 9. Next Steps

1. [ ] Design 단계 생략 (변경 < 80 LOC, Cycle #2/#3 패턴)
2. [ ] `/pdca do p1-3d-cursor-pagination` 실행
3. [ ] wrapper에 paginate 옵션 + cursor 루프 + MAX_PAGES 추가
4. [ ] `report/query.ts:104` paginate: true 활성화
5. [ ] mock test 3건 추가 (단일/다중/MAX 도달)
6. [ ] tsc 0 + mock 119/119 PASS 검증
7. [ ] git commit (3 파일)
8. [ ] `/pdca analyze` → Match Rate ≥ 90% 목표
9. [ ] `/pdca report` → archive

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 0.1 | 2026-05-08 | Initial draft (영향 범위 1곳 한정 — report/query.ts. wrapper paginate 옵션 + MAX_PAGES=50 hardcoded) | hwjo + Claude |
