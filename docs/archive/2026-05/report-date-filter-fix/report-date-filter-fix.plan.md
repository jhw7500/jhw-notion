# report-date-filter-fix Planning Document

> **Summary**: jhw_report_preview/export의 date 필터가 무시되는 Critical 버그 수정 — 메모리 사이드 필터 보강 + SDK 마이그레이션은 후속 분리
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
| **Problem** | `notion.databases.query`의 server-side date filter가 multi-data-source DB(Projects/DecisionLog/KnowledgeBase)에서 silently 무시되어, 모든 기간 입력에 대해 4월~5월 전체 데이터가 누적 반환됨. 주간보고가 헤더 날짜와 본문 데이터 범위가 일치하지 않음 |
| **Solution** | 1) 즉시 fix: query.ts의 메모리 필터(line 113-115)를 dateProp 유무 무관 모든 결과에 적용 → server filter 동작 여부와 무관하게 정확한 결과 보장. 2) 후속: `@notionhq/client` SDK 업그레이드 + `dataSources.query()` 마이그레이션은 별도 plan으로 분리 |
| **Function/UX 효과** | weekly/month/custom 기간 입력이 본문에 정확히 반영. 보고서 신뢰도 회복. 회귀 테스트로 재발 방지 |
| **Core Value** | 주간보고 자동화의 기본 가정(기간 필터링) 복구. 사용자가 "5월 1주차" 라고 하면 5월 1주차 데이터만 나오는 명확성 |

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | server-side date filter 미동작으로 보고서가 모든 과거 데이터를 누적 반환 — 수동 시뮬레이션(CASE-A 미래기간/CASE-G 단일일)에서 확정 |
| **WHO** | jhw_report_preview/export 사용자 (주/월간 redmine 보고서 자동 생성) |
| **RISK** | 메모리 필터 강제 시 page_size:100 한도로 일부 페이지 누락 가능성 — 1차 fix 범위에서는 cursor pagination 미도입 (TODO 명시) |
| **SUCCESS** | (1) CASE-A 미래기간 → 0건, (2) CASE-G 단일일 2026-04-29 → 4/29 항목만, (3) mock+live 100/100 PASS, (4) 회귀 테스트 1건 추가 |
| **SCOPE** | P1-3a: 메모리 필터 보강(이번 plan). P1-3b: SDK 업그레이드 + dataSources 마이그레이션(분리) |

---

## 1. Overview

### 1.1 Purpose

`jhw_report_preview` / `jhw_report_export`가 입력된 기간(start/end)을 정확히 반영하도록 한다. 현재 `projects`/`decisionLog`/`knowledgeBase` 3개 DB의 server-side filter가 무시되어 4월 8일부터의 모든 데이터가 누적 반환되는 문제를 해결한다.

### 1.2 Background

2026-05-08 시뮬레이션(8개 케이스)에서 확정된 버그:
- CASE-A 미래 (2027-01-01~07): 39 items 반환 (기대 0)
- CASE-G 단일일 (2026-04-29~04-29): 21 items 반환 (4/8, 4/22 데이터 포함)
- select 필터(`reports`)는 정상 작동 → date 필터만 미동작

추정 원인: `notion.databases.query`가 multi-data-source DB에서 deprecated 동작. SDK v2.3.0의 `client.dataSources`는 노출 안 됨.

### 1.3 Related Documents

- 시뮬레이션 결과: 본 세션 컨텍스트 (CASE A~G)
- 관련 코드: `mcp-server/src/report/query.ts:60-135`
- 영향 범위: `tools/report-preview.ts`, `tools/report-export.ts`
- 후속 plan 후보: `docs/01-plan/features/p1-3b-datasource-migration.plan.md` (미작성)

---

## 2. Scope

### 2.1 In Scope

- [ ] `query.ts:113-115`의 메모리 필터 조건 수정: `if (!dateProp && dateValue)` → `if (dateValue)` (dateProp 유무 무관 항상 적용)
- [ ] `dateValue`가 빈 문자열일 때의 처리 명확화 (현재 `""` < `start` 비교 시 항상 true → 누락 위험 검토)
- [ ] 회귀 테스트 추가: `report/__tests__/query.test.ts` (mock notion으로 server filter 무시 시뮬레이션)
- [ ] live 시나리오 1건 추가: 미래 기간 입력 → 0건 검증 (`__tests__/live/report.live.test.ts`)
- [ ] CHANGELOG/주석에 server filter 신뢰 안 함 명시
- [ ] 마이그레이션 후 시뮬레이션 CASE A/G 재실행으로 fix 검증

### 2.2 Out of Scope

- `@notionhq/client` SDK 업그레이드 (v2.3.0 → v3.x)
- `notion.dataSources.query()` 마이그레이션
- cursor pagination (page_size:100 한계 해결)
- groupBy="db" 응답 필드명 정리(`report` → `group`) — Minor 1, 별도 처리

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-01 | 입력 기간 외 데이터는 결과에 포함되지 않는다 | High | Pending |
| FR-02 | 미래 기간 입력 시 0건 반환 | High | Pending |
| FR-03 | 단일일 기간 입력 시 그 날짜의 항목만 반환 | High | Pending |
| FR-04 | 기존 정상 케이스(weekly/month) 결과 변동 없음 (data 누락 0건) | High | Pending |
| FR-05 | dateProp 없는 DB(preferences/references)는 last_edited_time 기반 메모리 필터로 기존 동작 유지 | High | Pending |
| FR-06 | 회귀 테스트로 재발 방지 | Medium | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | 측정 |
|---|---|---|
| Performance | 메모리 필터 추가 비용 무시 가능 (O(n) loop 1회) | live test 5초 이내 |
| Test | 100/100 PASS 유지 + 회귀 테스트 1+ 추가 | npm test |
| Backward compat | 기존 호출 패턴 결과 동일 또는 더 정확해질 것 | mock 회귀 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01~06 모두 충족
- [ ] CASE-A (2027-01-01~07): scanned 0 확인
- [ ] CASE-G (2026-04-29~04-29): scanned ≤ 8건 (4/29 항목만)
- [ ] CASE 정상 (2026-05-01~07): 변동 없거나 더 정확
- [ ] mock 풀 100% PASS, live 풀 100% PASS
- [ ] 회귀 테스트 추가됨 (`query.test.ts` 또는 신규)

### 4.2 Quality Criteria

- [ ] tsc 0 errors
- [ ] 변경 line 수 < 30 (최소 침습)
- [ ] 주석으로 server filter 의존 안 함 사유 명시

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| `dateValue=""` 인 페이지가 메모리 필터에서 의도치 않게 제외 | Med | Low | `if (!dateValue) include` (date 정보 없는 페이지는 통과) 또는 명시적 check |
| page_size:100 초과 데이터 누락 | High | Low (현재 데이터 약 50건) | TODO 주석 + 후속 plan(cursor pagination)으로 분리 |
| server filter 의도와 무관하게 동작 — 정상 동작 케이스 회귀 | Low | Low | 메모리 필터는 server filter 통과한 데이터를 다시 거름 → 결과는 같거나 더 작음 (확장 무) |
| dateProp 없는 DB(preferences/references)의 기존 동작 변경 | Med | Low | line 113의 기존 분기를 유지한 채 새 분기 추가하지 않고 통합 (코드 단순화) |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|---|---|---|
| `mcp-server/src/report/query.ts` | TS module | 메모리 필터 조건 통합 (3줄 변경) |
| `mcp-server/src/report/__tests__/query.test.ts` | Test (신규) | server filter 무시 시뮬레이션 + 회귀 테스트 |
| `mcp-server/src/__tests__/live/report.live.test.ts` | Test (신규) | live 미래기간 0건 검증 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|---|---|---|---|
| `queryReportItems` | call | `tools/report-preview.ts:99` | None — 결과 동일하거나 정확해짐 |
| `queryReportItems` | call | `tools/report-export.ts` | None — 동일 함수 사용 |
| `queryReportItems` | indirect | redmine 주간보고 자동화 | Positive — 헤더 기간과 본문 일치 |

### 6.3 Verification

- [ ] CASE A~G 8개 시나리오 재실행하여 정상 동작 확인
- [ ] 기존 mock 97 PASS 유지
- [ ] live 3 PASS + 신규 1건 PASS

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Selected |
|---|:---:|
| Starter | ☐ |
| **Dynamic** | **☑** (mcp-server 단일 모듈) |
| Enterprise | ☐ |

### 7.2 Key Architectural Decisions

| Decision | Selected | Rationale |
|---|---|---|
| 즉시 fix vs SDK 마이그레이션 | **메모리 필터 보강** | 변경 범위 최소(<30 LOC), SDK 호환성 영향 0, 회귀 위험 낮음. SDK 마이그레이션은 v2.3.0에 dataSources 미노출이라 v3.x 업그레이드 + 호환성 검증 필요 → 별도 사이클 |
| 메모리 필터 분기 통합 | `if (dateValue)` 단일 조건 | dateProp 유무 분기 제거로 코드 단순화. server filter 결과를 그대로 신뢰하지 않음을 명시 |
| 회귀 테스트 위치 | `report/__tests__/query.test.ts` 신규 | 기존 report-preview.test.ts와 분리 — query 레벨 단위 테스트가 명확 |

### 7.3 Clean Architecture

기존 구조 유지. 변경은 `report/query.ts` 1 파일.

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md` (전역 + 프로젝트) 존재
- [x] `mcp-server/AGENTS.md` 코딩 규칙 존재
- [x] TypeScript strict (tsconfig.json)
- [x] Vitest (mock + live 분리)

### 8.2 Conventions to Define

신규 정의 불필요 — 기존 컨벤션 따름.

### 8.3 Environment Variables Needed

기존 `NOTION_API_KEY` + sandbox 5개로 충분. 신규 env 없음.

---

## 9. Next Steps

1. [ ] Design 단계 생략 (변경 < 30 LOC) — 바로 Do로 진행
2. [ ] `/pdca do report-date-filter-fix` 실행
3. [ ] `query.ts` 메모리 필터 통합 + 회귀 테스트 작성
4. [ ] `npm test` + `npm run test:live` 100/100 + 1 신규 PASS 확인
5. [ ] CASE A/G 재시뮬레이션으로 시각 확인
6. [ ] git commit + push
7. [ ] /pdca analyze → 94→100% 목표
8. [ ] /pdca report

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 0.1 | 2026-05-08 | Initial draft (시뮬레이션 결과 기반) | hwjo |
