# enhancement-roadmap Completion Report

> **Status**: Complete (Core scope, P1-1 FTS5 carried over)
>
> **Project**: jhw-notion
> **Version**: 0.1.0 (mcp-server)
> **Author**: hwjo
> **Completion Date**: 2026-05-07
> **PDCA Cycle**: #1

---

## Executive Summary

### 1.1 Project Overview

| Item | Content |
|------|---------|
| Feature | enhancement-roadmap (Notion MCP 9개 도구 정합성·안정성·자동화 고도화) |
| Plan 확정일 | 2026-04-30 |
| 구현 커밋 | 2026-04-30 (2f71ac3 P0/P1, 92471a6 P1-2/P2) ~ 2026-05-07 (PR push) |
| Duration | Plan→구현 6일, 구현→Live 검증 7일 (계획 6주 → 실제 ~1주, 6배 압축) |
| 분석 문서 | `docs/03-analysis/enhancement-roadmap.analysis.md` |

### 1.2 Results Summary

```
┌─────────────────────────────────────────────┐
│  Match Rate: 94% (90% 임계 통과)             │
├─────────────────────────────────────────────┤
│  ✅ Complete:     6 / 7 로드맵 항목          │
│  ⏳ Carried Over: 1 / 7 (P1-1 FTS5)          │
│  ❌ Cancelled:    0 / 7                      │
│  Tests:          100/100 PASS (97 mock + 3 live)
└─────────────────────────────────────────────┘
```

### 1.3 Value Delivered

| Perspective | Content |
|---|---|
| **Problem** | Notion MCP 9개 도구의 `project` 필드 타입 비대칭(rich_text vs relation), retry/rate-limit 부재, 보고서/리콜 자동화 부재로 검색·기록·조회가 서로 다른 데이터를 보던 문제 |
| **Solution** | (1) `schema.ts` 단일 진실 소스 + `resolve-project.ts` 통일 resolver, (2) `notion/api.ts` 5층 안정성 레이어(retry/timeout/rate-limit/circuit-breaker/safeTool), (3) `jhw_report_preview/export` + `jhw_recall` 신규 도구 2종, (4) `property-builder.ts` schema-driven 리팩토링, (5) sandbox 격리 live test 인프라 |
| **Function/UX 효과** | mock 97 + live 3 테스트 모두 PASS. record.ts 60줄 if/else → 6줄 위임으로 신규 DB 추가 비용 = schema 1줄. 13→8 스킬 슬림화로 사용자 진입 단순화 |
| **Core Value** | Plan §0 TL;DR의 "search/context/history/report/recall이 서로 다른 기준으로 데이터를 본다" 핵심 갭 해소. 운영 DB 보호된 sandbox로 회귀 보호 확보 |

---

## 1.4 Success Criteria Final Status

> Plan §6 6주 로드맵 항목별 최종 평가.

| # | Criteria | Status | Evidence |
|---|---|:---:|---|
| SC-1 (P0-1) | schema.ts + resolve-project.ts + project 회귀 테스트 | ✅ Met | `mcp-server/src/schema.ts` (107 LOC), `notion/resolve-project.ts` (71 LOC), `tools/__tests__/project-consistency.test.ts` (157 LOC) |
| SC-2 (P0-2) | notion/api.ts retry/timeout/rate-limit/표준 에러 | ✅ Met | `mcp-server/src/notion/api.ts` (194 LOC: withRetry/withTimeout/RateLimiter/NotionError), 13 파일에서 callNotion 사용 |
| SC-3 (P0-3) | jhw_report_preview MVP, redmine markdown | ✅ Met | `tools/report-preview.ts` (151 LOC), `tools/report-export.ts` (195 LOC), `report/format.ts` (markdown/redmine/json), KB/decisionLog writeBack |
| SC-4 (P1-1) | SQLite FTS5 cache + jhw_recall + 자동 저장 | ⚠️ Partial | `tools/recall.ts` (128 LOC), `cache/page-cache.ts` (token 매칭). **FTS5 미적용 — 후속 plan 분리 필요** |
| SC-5 (P1-2) | schema-driven record/query 리팩토링 | ✅ Met | `notion/property-builder.ts` (101 LOC) + 11 단위 테스트, record.ts 60→6줄 위임 |
| SC-6 (P2) | optional embedding, summary cache, *.live.test.ts | ✅ Met (live test) / ⚠️ embedding 후순위 | `test/sandbox-config.ts`, `vitest.live.config.ts`, `__tests__/live/record.live.test.ts` 3 PASS @ 2026-05-07T07:42Z. embedding은 Plan §6에서 optional로 표기 |
| SC-7 (스킬 슬림화) | 13 → 8 통합, deprecated alias 유지 | ✅ Met | b39e82c 커밋, deprecated alias 8개 유지 (record/note/search/context/history/start/close/delete) |

**Success Rate**: **6/7 (86%) 완전 충족 + 1/7 부분 충족** → Match Rate 94%

## 1.5 Decision Record Summary

| Source | Decision | Followed? | Outcome |
|---|---|:---:|---|
| [DecisionLog 2026-04-07] | MCP 서버 — Notion API 직접 호출 방식 | ✅ | `@notionhq/client` 직접 사용, 미들웨어(api.ts) 자작 |
| [DecisionLog 2026-04-09] | DB ID/프로퍼티명 영문 전환 | ✅ | `schema.ts` 영문 키로 일원화 |
| [DecisionLog 2026-04-29] | jhw_note → KB DB row 생성 (wrapper page 폐기) | ✅ | `tools/note.ts`가 KB row 생성으로 동작 |
| [DecisionLog 2026-04-29] | 5개 DB redmine `report` select 표준화 | ✅ | `schema.ts`에 report select 정의, 5개 DB 적용 |
| [Plan §6] | 6주 로드맵 — 점진 도입 | ⚠️ 가속 | 6일에 압축 구현. 가속 자체는 의도적이지만 P1-1 FTS5 누락의 직접 원인 |
| [Plan §3] | schema-driven 리팩토링 (`JHW_SCHEMA_V2=1` feature flag) | ⚠️ 미적용 | property-builder는 즉시 활성화로 도입 (feature flag 생략). 회귀 테스트로 안전 확인 |
| [Plan §9] | relation 변경 시 legacy rich_text fallback | ✅ | context.ts/history.ts에 fallback 구현 확인 |

---

## 2. Related Documents

| Phase | Document | Status |
|---|---|---|
| PM | (없음) | — Plan 단계부터 시작 |
| Plan | [`enhancement-roadmap.plan.md`](../01-plan/features/enhancement-roadmap.plan.md) | ✅ Finalized 2026-04-30 |
| Design | (없음) | — 로드맵 자체가 설계 역할 수행 |
| Check | [`enhancement-roadmap.analysis.md`](../03-analysis/enhancement-roadmap.analysis.md) | ✅ Complete (Match 94%) |
| Act | 본 문서 | ✅ Complete |

---

## 3. Completed Items

### 3.1 Functional Requirements

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-01 | project 필드 타입 정합성 (4 도구) | ✅ Complete | record/context/history/start.ts 모두 relation으로 통일 |
| FR-02 | notion/api.ts 안정성 5층 | ✅ Complete | retry/timeout/rate-limit/circuit-breaker/safeTool |
| FR-03 | report 자동화 (preview + export) | ✅ Complete | markdown/redmine/json 포맷, KB/decisionLog writeBack |
| FR-04 | recall MVP + 자동 캐시 저장 | ✅ Complete | token 매칭 기반 (FTS5는 SC-4 carry-over) |
| FR-05 | schema-driven property builder | ✅ Complete | record.ts 60→6줄 위임 |
| FR-06 | live integration test 인프라 | ✅ Complete | sandbox 5 DB + dotenv 가드 + sample 통과 |
| FR-07 | 스킬 13 → 8 슬림화 | ✅ Complete | save/project/recall 통합 + deprecated alias |

### 3.2 Non-Functional Requirements

| Item | Target | Achieved | Status |
|---|---|---|---|
| Mock test pass rate | 100% | 97/97 (100%) | ✅ |
| Live test pass rate | 100% | 3/3 (100%) | ✅ |
| Test duration (mock) | < 5s | 295ms | ✅ |
| Test duration (live) | < 30s | 3.62s | ✅ |
| TypeScript strict | 0 errors | 0 errors (tsc OK) | ✅ |
| 운영 DB 격리 | 100% | sandbox 분리 완료 | ✅ |

### 3.3 Deliverables

| Deliverable | Location | Status |
|---|---|---|
| Schema 단일 소스 | `mcp-server/src/schema.ts` | ✅ |
| Project resolver | `mcp-server/src/notion/resolve-project.ts` | ✅ |
| 안정성 레이어 | `mcp-server/src/notion/api.ts` | ✅ |
| Property builder | `mcp-server/src/notion/property-builder.ts` | ✅ |
| Report 도구 | `mcp-server/src/tools/report-{preview,export}.ts` + `report/{query,format}.ts` | ✅ |
| Recall 도구 | `mcp-server/src/tools/recall.ts` + `cache/page-cache.ts` | ✅ |
| Live test 인프라 | `mcp-server/src/test/sandbox-config.ts` + `vitest.live.config.ts` + `.env.example` | ✅ |
| 회귀 테스트 | `mcp-server/src/tools/__tests__/*.test.ts` (총 18 파일, 97 mock + 3 live) | ✅ |

---

## 4. Incomplete Items

### 4.1 Carried Over to Next Cycle

| Item | Reason | Priority | Estimated Effort |
|---|---|---|---|
| P1-1.5 SQLite FTS5 cache 승격 | Plan §2.2에서 P0=토큰/FTS5, P1=embedding으로 단계 분리 명시. 토큰 매칭으로 시작 가능. FTS5 도입은 `better-sqlite3` 의존성 추가 + 인덱스 마이그레이션 결정 필요 | Medium | 1~2일 |
| P2 embedding/summary cache | Plan §6에서 optional 표기. 사용 데이터 누적 후 효용 판단 권장 | Low | TBD |

### 4.2 Cancelled/On Hold Items

| Item | Reason | Alternative |
|---|---|---|
| `JHW_SCHEMA_V2=1` feature flag (Plan §9) | 회귀 테스트로 안전성 확인되어 즉시 활성화로 진행 | property-consistency 테스트가 안전망 역할 |

---

## 5. Quality Metrics

### 5.1 Final Analysis Results

| Metric | Target | Final | Note |
|---|---|---|---|
| Match Rate | 90% | **94%** | Live 통과 후 산정 |
| Mock Test Coverage | 100% | 97/97 (100%) | 18 파일 |
| Live Test Coverage | 1+ | 3 PASS | record.live.test.ts |
| TypeScript Errors | 0 | 0 | tsc OK |
| LOC Delta | — | +2,971 / -224 | 신규 11 파일 + 9 도구 마이그레이션 |

### 5.2 Resolved Issues

| Issue (Plan §1) | Resolution | Result |
|---|---|---|
| project 필드 타입 비대칭 | schema.ts + resolve-project.ts + 4도구 relation 통일 | ✅ Resolved |
| 9개 도구 갭 (search pagination/idempotency/error 정규화 등) | api.ts 안정성 레이어 + 도구별 마이그레이션 | ✅ Resolved (search pagination/idempotency는 부분 — 다음 사이클 후보) |
| 보고 자동화 부재 | jhw_report_preview/export 신규 | ✅ Resolved |
| 로컬 retrieval layer 부재 | jhw_recall + page-cache | ⚠️ Partial (FTS5 미적용) |
| 스킬 13개 산만 | 13 → 8 통합 | ✅ Resolved |

---

## 6. Lessons Learned & Retrospective

### 6.1 What Went Well (Keep)

- **schema-driven 단일 소스 패턴**: schema.ts 도입으로 record/context/history/property-builder가 같은 메타를 공유. 신규 DB 추가 비용이 1줄로 줄어듦
- **점진 마이그레이션**: 회귀 테스트(`project-consistency.test.ts`)를 먼저 깔고 9도구를 차례로 callNotion 으로 옮긴 덕에 중간 회귀 0건
- **sandbox 격리**: 운영 DB와 분리된 wrapper page에 5개 DB를 만들어 live test가 운영 데이터에 영향 없음
- **legacy rich_text fallback**: relation 전환 후에도 과거 데이터를 잃지 않음 (context.ts/history.ts의 2단 검색)

### 6.2 What Needs Improvement (Problem)

- **Design 단계 생략**: 로드맵을 설계 역할로 사용 — 결과적으로 작동했지만 이번 CHECK에서 비교 기준이 모호해 정량화에 시간이 더 걸림. 다음 사이클은 짧은 design 문서라도 작성 권장
- **6주 → 6일 압축의 부작용**: P1-1 FTS5는 Plan에서 명시적이었지만 가속 과정에서 토큰 매칭으로 단순화. 추적 가능한 carry-over 표시가 필요
- **PDCA state 자동 등록 노이즈**: `helpers`, `__tests__` 같은 디렉토리명이 feature로 잘못 등록됨 — `.bkit/state/pdca-status.json` 정리 필요

### 6.3 What to Try Next (Try)

- **Carry-over 표준화**: Plan에 명시됐으나 미구현된 항목은 `/pdca plan p1-1-fts5` 같이 별도 plan으로 분리
- **state cleanup 자동화**: `helpers/__tests__` 같은 phantom feature 자동 감지 + 사용자 확인
- **search/idempotency 후속**: Plan §1.2의 9도구 갭 중 search pagination, write idempotency는 미반영 — 다음 사이클 후보

---

## 7. Process Improvement Suggestions

### 7.1 PDCA Process

| Phase | Current | Improvement Suggestion |
|---|---|---|
| Plan | 1회로 충분 | OK |
| Design | 생략됨 | 짧은 design 문서(아키텍처 다이어그램 + 인터페이스 시그니처)라도 작성하면 CHECK 정량화 용이 |
| Do | 6일 압축 잘 됨 | 가속 시 carry-over 표 명시 |
| Check | gap-detector 자동화 미사용 (수동 분석) | 다음 사이클은 design 문서 + gap-detector 자동 호출 |
| Act | 본 보고서가 1회차 종합 | OK |

### 7.2 Tools/Environment

| Area | Improvement Suggestion | Expected Benefit |
|---|---|---|
| Live test 자동화 | GitHub Actions에서 `RUN_LIVE_NOTION_TESTS=1` 야간 1회 실행 | 회귀 보호 + 외부 API 변화 조기 감지 |
| state cleanup | `.bkit/state/pdca-status.json` phantom feature 자동 정리 | 노이즈 제거 |
| FTS5 도입 | better-sqlite3 + `pages_fts(title, content)` virtual table | 토큰 매칭 false positive 감소, 검색 정확도 향상 |

---

## 8. Next Steps

### 8.1 Immediate

- [x] origin/main push (2026-05-07 완료)
- [x] Live 테스트 1회 통과 (2026-05-07 07:42Z 완료)
- [ ] (선택) `/pdca archive enhancement-roadmap --summary` 으로 문서 아카이빙
- [ ] `.bkit/state/pdca-status.json` phantom feature(`helpers`, `__tests__`) cleanup

### 8.2 Next PDCA Cycle (후보)

| Item | Priority | Note |
|---|---|---|
| p1-1-fts5 (SQLite FTS5 승격) | Medium | Plan §2.2의 P0 단계 완성 |
| search-enhancement (pagination + idempotency) | Medium | Plan §1.2의 미반영 갭 |
| live-test-ci (GitHub Actions 야간 실행) | Low | 회귀 보호 |

---

## 9. Changelog

### v0.1.0 (2026-05-07)

**Added:**
- `mcp-server/src/schema.ts` — DB 메타데이터 단일 소스
- `mcp-server/src/notion/resolve-project.ts` — project relation resolver
- `mcp-server/src/notion/api.ts` — withRetry/withTimeout/RateLimiter/NotionError 5층
- `mcp-server/src/notion/property-builder.ts` — schema-driven property builder
- `mcp-server/src/tools/{report-preview,report-export,recall}.ts` — 신규 도구 3종
- `mcp-server/src/cache/{page-cache,report-cache}.ts` — 로컬 캐시
- `mcp-server/src/test/sandbox-config.ts` + `vitest.live.config.ts` — live test 인프라
- 18 테스트 파일 (97 mock + 3 live)

**Changed:**
- `record/context/history/start.ts` — project 필드 relation 통일
- `record.ts` buildNotionProperties — 60줄 if/else → 6줄 schema 위임
- 9 도구 + 1 resolver를 callNotion 안정성 레이어로 마이그레이션
- 13 → 8 스킬 통합 (save / project / recall 신설, deprecated alias 유지)

**Fixed:**
- start로 등록된 결정을 context/history가 못 찾던 비대칭 버그 (FR-01)

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 1.0 | 2026-05-07 | 초안 작성 (PDCA #1 완료 보고서) | hwjo |
