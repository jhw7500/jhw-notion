# p1-3c-datasource-query-migration Planning Document

> **Summary**: `@notionhq/client` v2.3.0 → v5.20.0 + `databases.query` (10 호출) → `dataSources.query` 호출 마이그레이션. p1-3b의 매핑 인프라 활용. 한 사이클에 전체 일괄 진행.
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
| **Problem** | Cycle #2(메모리 필터 차단) + Cycle #3(매핑 인프라) 후, 실제 호출은 여전히 v2 SDK의 `databases.query` 사용. Notion이 v5(2025-09-03)에서 `databases.query` 완전 제거 → 향후 SDK 업그레이드 시점에 강제 마이그레이션. multi-data-source DB의 server filter 신뢰성 회복 + breaking changes 정식 대응 필요 |
| **Solution** | (1) `@notionhq/client@5.20.0` 업그레이드, (2) production 10 호출(`history.ts×3 / context.ts×3 / status.ts / close.ts / resolve-project.ts / report/query.ts`)을 `notion.dataSources.query()`로 교체 + p1-3b의 `getDataSourceId(db)` 헬퍼 사용, (3) 응답 필드 `archived` → `in_trash` 처리, (4) mock 11개 파일 시그니처 마이그레이션, (5) sandbox live test로 회귀 7건 + v5 호환 신규 1건 검증, (6) 메모리 사이드 필터(`query.ts:117-119`)는 보험으로 유지 |
| **Function/UX 효과** | 사용자 가시 변화 0 (운영 동작 동일/정확). v5 신규 응답 union 타입(`Page | DataSource`)에 대응한 type guard 도입. cursor pagination은 별도 사이클(P1-3d) 분리 — 단, `request_status.incomplete` 감지 + warning 로그만 추가 |
| **Core Value** | "지도(p1-3b) → 이동(p1-3c)" 사이클 완성. SDK 미래호환성 확보 + Cycle #2 메모리 필터의 server filter 의존을 v5의 정식 path로 우회. multi-data-source 환경에서의 long-term 안정성 회복 |

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | v2 SDK의 `databases.query`는 v5에서 완전 제거됨. Notion 2025-09-03 API 모델은 `dataSources.query()`만 지원 — 미래 SDK 업그레이드 진입 차단 가능성 + multi-data-source 정식 처리 path 필요 |
| **WHO** | jhw-notion mcp-server. 사용자 가시 영향 0이지만 record/recall/report/start/close/note/status/context/history 9개 도구의 내부 호출이 모두 변경 |
| **RISK** | (1) 응답 타입 union 확장(`Page \| DataSource`)으로 기존 type guard 무효화 가능, (2) mock 11개 파일 시그니처 변경 — 전수 통과 검증 필요, (3) `archived` → `in_trash` 응답 키 변경에 따른 사용처 grep 누락, (4) 한 사이클 전체 마이그레이션은 회귀 위험이 분산 사이클 대비 큼 (사용자 합의 — Recommended) |
| **SUCCESS** | (1) production 10 호출 100% 마이그레이션, (2) mock 110+ PASS 유지, (3) live sandbox 회귀 7건 v5 환경 재PASS + v5 호환 1건 신규, (4) tsc 0 errors, (5) `archived` 응답 사용처 0건 (모두 `in_trash`로 정정), (6) 메모리 필터 보존 |
| **SCOPE** | In: SDK 업그레이드, 10 호출 마이그레이션, mock 11 회귀, in_trash 처리, request_status.incomplete 감지+warning. Out: cursor pagination 도입(별도 P1-3d), `result_type` 필드 활용, archived 도구 작성 |

---

## 1. Overview

### 1.1 Purpose

Cycle #3에서 확보한 `data_source_id` 매핑(`schema.ts.dataSourceId`, `getDataSourceId(db)`, `loadSandboxConfig().dataSources`)을 활용해, production의 `notion.databases.query` 호출 10건을 v5 `notion.dataSources.query`로 일괄 전환한다. SDK는 v2.3.0 → v5.20.0 업그레이드. 응답 union 타입과 `in_trash` 키 변경을 정식 처리한다.

### 1.2 Background

| 사이클 | 결과 | 본 사이클 영향 |
|---|---|---|
| Cycle #2 (`report-date-filter-fix`) | server filter 무시 회귀를 `query.ts:117-119` 메모리 필터로 차단. SDK 업그레이드는 분리 | 메모리 필터 유지 (보험) |
| Cycle #3 (`p1-3b-datasource-migration`) | 10개 DB의 `data_source_id` 매핑 인프라 + `getDataSourceId(db)` + sandbox 격리 + 검증 8건 | 본 사이클이 그 매핑을 호출 path에 연결 |
| **Cycle #4 (본 사이클)** | SDK + 호출 마이그레이션 일괄 | (다음) Cycle #5 후보: cursor pagination, FTS5 등 |

Spike 결과(2026-05-08, /tmp/notion-v5-spike2):
- v5 `dataSources.query` 시그니처: pathParams `[data_source_id]`, bodyParams `[archived, sorts, filter, start_cursor, page_size, in_trash, result_type]`
- 응답: `Array<Page | PartialPage | DataSource | PartialDataSource>` union
- `request_status: { type: "complete"|"incomplete", incomplete_reason?: "query_result_limit_reached" }` 신규
- v5에 `databases.query` 완전 제거 — 강제 마이그레이션

### 1.3 Related Documents

- 직전 사이클: [`docs/archive/2026-05/p1-3b-datasource-migration/`](../../archive/2026-05/p1-3b-datasource-migration/)
- p1-3b의 매핑 자산: `mcp-server/src/schema.ts:30,107-119`, `mcp-server/src/test/sandbox-config.ts`
- spike 결과: 본 plan §1.2
- v5 SDK 타입: `node_modules/@notionhq/client/build/src/api-endpoints/data-sources.d.ts` (설치 후 검증)

---

## 2. Scope

### 2.1 In Scope

- [ ] **SDK 업그레이드**: `@notionhq/client@^2.2.0` → `^5.20.0` (package.json + `npm install`)
- [ ] **호출 마이그레이션 10건** (production):
  - [ ] `tools/history.ts` 3 호출 (line 22, 44, 59)
  - [ ] `tools/context.ts` 3 호출 (line 22, 53, 69)
  - [ ] `tools/status.ts` 1 호출 (line 31)
  - [ ] `tools/close.ts` 1 호출 (line 25)
  - [ ] `notion/resolve-project.ts` 1 호출 (line 44)
  - [ ] `report/query.ts` 1 호출 (line 91) — 메모리 필터(line 117-119)는 유지
- [ ] **공통 패턴**: 각 호출에서 `database_id: NOTION_CONFIG.databases.X` → `data_source_id: getDataSourceId("X")`
- [ ] **응답 처리**: `page.archived` 사용처 grep 후 `page.in_trash` 또는 호환 헬퍼로 정정
- [ ] **응답 union 처리**: 결과 항목이 `PageObjectResponse | PartialPageObjectResponse | DataSourceObjectResponse | PartialDataSourceObjectResponse` union — 기존 `(page as any).properties` 사용처에 type guard 또는 `isFullPage(page)` 체크 도입
- [ ] **mock 11 파일 마이그레이션**: `databases.query.mockResolvedValue` → `dataSources.query.mockResolvedValue`
  - tools: close, context, history, note, project-consistency, record, report-export, report-preview, status
  - notion: property-builder
  - report: query
- [ ] **incomplete 감지 + warning 로그**: 응답에 `request_status.incomplete` 발견 시 `console.warn` 또는 structured log 1줄 (Cycle #3 carry-over의 일부 — pagination 미도입이라도 alert는 가능)
- [ ] **mock 회귀 100% PASS 유지**: 110+ → 신규 마이그레이션 후에도 동일 카운트(또는 +α)
- [ ] **live sandbox 검증**: Cycle #2의 회귀 7건(미래기간 0건 / 단일일 / 정상기간 / preferences / select 독립 / 미래 live / 과거 live) 전부 v5 환경에서 재실행 + 신규 1건 (v5 응답 union에서 첫 결과의 type 검증)
- [ ] **메모리 필터 유지**: `report/query.ts:117-119` 코드 변경 0 (보험으로 보존, 주석에 "v5 마이그레이션 후에도 유지" 추가)
- [ ] **CHANGELOG / 주석**: SDK 메이저 업그레이드 + breaking changes 명시

### 2.2 Out of Scope

- **cursor pagination 본격 도입** — 별도 사이클 P1-3d (단, `incomplete` 감지 + warning은 본 사이클에 포함 = 가벼운 hook only)
- v5 신규 `result_type` 필드 활용 (page-only filter 등) — 별도 사이클
- v5 신규 `dataSources.create / update / listTemplates` 도구 작성
- archive된 페이지 명시 처리 (`archived: true` 또는 `in_trash: true` 필터링) — 본 사이클은 응답 키 정정만
- `groupBy="db"` 응답 필드명 정리 (`report` → `group`) — Cycle #1 carry-over Minor 1, 별도 처리

### 2.3 Assumptions (사용자 검토 필요)

이 가정 중 하나라도 어긋나면 plan 보정:
- **A1**: `databases.{retrieve, create, update}`는 v5에도 그대로 남아있으므로(spike 확인됨) 다른 도구는 영향 없음
- **A2**: v5 SDK가 v2 응답 keys(`title`, `properties`, `last_edited_time`, `id`, `url`)를 모두 유지 (응답 union 확장만)
- **A3**: live sandbox 환경(`RUN_LIVE_NOTION_TESTS=1`)이 갱신된 토큰으로 동작 가능 (현재 `.bashrc:202` 단일 source)
- **A4**: cursor pagination 미도입에도 현재 데이터(~50건)는 page_size:100 한계 미발생

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-01 | SDK `@notionhq/client` ^5.20.0 으로 업그레이드 | High | Pending |
| FR-02 | production 10 호출 모두 `dataSources.query` 사용 + `getDataSourceId(db)` 매핑 | High | Pending |
| FR-03 | `archived` 응답 키 사용처 0건 (모두 `in_trash`로 정정) | High | Pending |
| FR-04 | 응답 union 타입 처리 (type guard 또는 `isFullPage` 도입) | High | Pending |
| FR-05 | mock 11 파일 모두 `dataSources.query` mock으로 마이그레이션 | High | Pending |
| FR-06 | `request_status.incomplete` 감지 + warning 로그 1줄 | Medium | Pending |
| FR-07 | live sandbox에서 Cycle #2 회귀 7건 + v5 호환 1건 신규 PASS | High | Pending |
| FR-08 | 메모리 필터(`query.ts:117-119`) 유지 + 주석 보강 | Medium | Pending |
| FR-09 | `databases.{retrieve, create, update}` 다른 호출 영향 0 | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | 측정 |
|---|---|---|
| Performance | 호출당 latency 변화 < 10% | 운영 sample 비교 (선택) |
| Test | mock 110+ PASS 유지 + live 7+1 = 8 PASS | npm test + npm run test:live |
| Backward compat | `record/recall/report/start/close/note/status/context/history` 9 도구의 외부 인터페이스 무변화 | grep + 기존 mock 통과 |
| Type safety | tsc 0 errors, any 사용 신규 0건 (기존 any 유지 OK) | tsc --strict |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01~09 모두 충족
- [ ] `git grep "databases.query"` 결과 = 0 (production), 0 (mock) — 주석은 OK
- [ ] `git grep "page.archived\|\.archived\b"` 결과 검토 후 모두 `in_trash`로 정정 또는 합리적 유지(v5에서도 동일 의미일 시)
- [ ] mock 110+ PASS 유지
- [ ] live RUN_LIVE_NOTION_TESTS=1 통과 (회귀 7 + 신규 1 = 8)
- [ ] tsc 0 errors
- [ ] 메모리 필터 코드(`query.ts:117-119`) 변경 0
- [ ] CHANGELOG/주석 갱신

### 4.2 Quality Criteria

- [ ] 변경 line 수 < 500 (production +200, mock +200, types +50, deps 1줄)
- [ ] type guard 패턴 일관 (한 곳에 헬퍼 정의 + 호출처 사용)
- [ ] `isFullPage` 등 SDK 헬퍼 우선 — 직접 `as any` 캐스팅 회피

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| 응답 union 타입 변경으로 기존 `(page as any).properties` 패턴 다수 깨짐 | High | Med | type guard 헬퍼 한 곳 정의 + 모든 호출처 통일. 기존 mock이 `properties` 키를 그대로 사용하면 mock 측에선 큰 변경 없음 |
| `archived` → `in_trash` 사용처 grep 누락 | Med | Med | 본 plan §6.4에 grep 결과 표 채움. `\.archived\b` 정규식으로 전수 검토 |
| live test 토큰/integration 권한 누락 (Cycle #3 401 재발) | Med | Low | `.bashrc:202` 단일 source 정착됨. 시작 전 `curl /v1/users/me` 1회 검증 |
| 한 사이클 전체 마이그레이션 → 회귀 발생 시 디버깅 부담 | Med | Med | 사용자 합의(Recommended). git commit 단위를 SDK 업그레이드 / 호출 마이그레이션 / mock 마이그레이션 3단계로 분할해 bisect 용이성 확보 |
| v5 SDK가 의존성 변경(node 버전, peer deps) 도입 | Low | Low | npm install 시 warning/error 즉시 감지 |
| pagination 미도입으로 대용량 데이터 누락 | Low | Low | `request_status.incomplete` warning 도입으로 alert. 현재 데이터 ~50건이라 즉시 영향 없음 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|---|---|---|
| `mcp-server/package.json` | dep | `@notionhq/client@^2.2.0` → `@notionhq/client@^5.20.0` |
| `mcp-server/package-lock.json` | lock | 자동 갱신 |
| `mcp-server/src/tools/history.ts` | TS | 3 호출 마이그레이션 + 응답 처리 |
| `mcp-server/src/tools/context.ts` | TS | 3 호출 마이그레이션 + 응답 처리 |
| `mcp-server/src/tools/status.ts` | TS | 1 호출 마이그레이션 |
| `mcp-server/src/tools/close.ts` | TS | 1 호출 마이그레이션 |
| `mcp-server/src/notion/resolve-project.ts` | TS | 1 호출 마이그레이션 |
| `mcp-server/src/report/query.ts` | TS | 1 호출 마이그레이션 (line 91 영역) + 메모리 필터(117-119)는 유지 |
| `mcp-server/src/notion/api.ts` | TS | (선택) `request_status.incomplete` 감지 헬퍼 추가 |
| `mcp-server/src/notion/type-guards.ts` (신규 가능) | TS | `isFullPage` re-export 또는 union 처리 헬퍼 |
| `mcp-server/src/tools/__tests__/{close,context,history,note,project-consistency,record,report-export,report-preview,status}.test.ts` | Test | mock 시그니처 마이그레이션 |
| `mcp-server/src/notion/__tests__/property-builder.test.ts` | Test | mock 시그니처 |
| `mcp-server/src/report/__tests__/query.test.ts` | Test | mock 시그니처 |
| `mcp-server/src/__tests__/live/report.live.test.ts` | Test | v5 호환 검증 신규 케이스 1건 추가 |
| `mcp-server/src/__tests__/live/record.live.test.ts` | Test | (선택) v5 응답 형식 검증 추가 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|---|---|---|---|
| `notion.databases.query` | call | 10 production paths (위 §6.1) | Breaking — 본 사이클의 핵심 변경 대상 |
| `notion.databases.retrieve` | call | (있다면) | None — v5에 동일 메서드 보존 |
| `record/recall/report/start/close/note/status/context/history` 9 도구 외부 인터페이스 | API | MCP tool API | None — 내부 구현만 변경 |
| `getDataSourceId(db)` 헬퍼 | call | 본 사이클이 첫 사용처 | Activated |
| `loadSandboxConfig().dataSources` | call | 본 사이클이 첫 사용처 (live test) | Activated |

### 6.3 Verification

- [ ] tsc 0 errors
- [ ] `git grep "databases.query"` 결과 = 0 (주석 제외)
- [ ] `git grep "\\.archived\\b" mcp-server/src/` 결과 모두 검토
- [ ] mock 110+ PASS
- [ ] live 8 PASS (회귀 7 + 신규 1)
- [ ] 운영 시나리오 sanity check (record/report/recall 1회씩)

### 6.4 `archived` 키 사용처 grep (Do 단계 진입 시 채움)

> Do 단계 시작 시 `git grep '\.archived\b' mcp-server/src/` 실행 결과를 여기에 표로 정리.

| 위치 | 사용 형태 | 처리 |
|---|---|---|
| TBD | TBD | TBD |

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
| 분할 vs 일괄 마이그레이션 | **일괄 (한 사이클 전체)** | 사용자 합의(Recommended). SDK 업그레이드는 어차피 한 번이라 분리 효익 작음. git commit 단위 분할로 bisect 용이성 확보 |
| 메모리 필터 처리 | **유지 (보험)** | 사용자 합의. v5에서도 silent 메소드 버그 가능성 0이 아님. 보고서 정확성 보호 우선 |
| 응답 union 처리 | **type guard 헬퍼 한 곳 정의** | `isFullPage` SDK 헬퍼 우선, 필요 시 `notion/type-guards.ts` 신설. `as any` 직접 캐스팅 회피 |
| pagination | **incomplete 감지+warning만** | 본 사이클 out-of-scope이지만, alert 메커니즘은 거의 비용 0이라 포함 |
| `archived` → `in_trash` | **사용처 grep 후 정정** | §6.4 표 작성으로 누락 방지 |
| commit 단위 | **3-4단계 분할** | (1) SDK upgrade + package.json (2) 호출 마이그레이션 (3) mock 마이그레이션 (4) live test 추가 — bisect 친화 |
| Live test 신규 | **v5 응답 union 검증 1건 추가** | v5 응답에 `DataSourceObjectResponse`가 results에 섞이는지 sandbox 호출 1회로 확인 |

### 7.3 Clean Architecture

기존 9도구 + notion/api.ts 안정성 레이어 그대로 유지. 변경은 호출 시그니처 + 응답 type guard 한 층만.

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] CLAUDE.md / AGENTS.md 컨벤션
- [x] TypeScript strict
- [x] Vitest (mock + live)
- [x] schema-driven (Cycle #1 도입, Cycle #3 확장)

### 8.2 Conventions to Define

- type guard 위치: `mcp-server/src/notion/type-guards.ts` (신규 가능) 또는 SDK의 `isFullPage` 직접 import
- commit 단위 분할 정책: 본 plan §7.2 (4단계)

### 8.3 Environment Variables Needed

기존 + 변동 없음. (`.bashrc:202` 단일 source 패턴 유지)

---

## 9. Next Steps

1. [ ] Plan §2.3 Assumptions 사용자 검토 (현재 응답에서 확인 받기)
2. [ ] Design 단계 작성 검토 — 변경 수백 LOC 예상이라 작성 권장
3. [ ] `/pdca design p1-3c-datasource-query-migration` 또는 직접 do
4. [ ] Phase 1.0 micro-spike: `databases.{retrieve,create,update}` 호환 + `archived` grep 결과 §6.4 채움
5. [ ] commit 단위별 진행 (SDK → 호출 → mock → live)
6. [ ] live sandbox 토큰 검증 (`/v1/users/me` 200 OK)
7. [ ] `/pdca analyze p1-3c-datasource-query-migration`
8. [ ] `/pdca report` → `/pdca archive --summary`

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 0.1 | 2026-05-08 | Initial draft (영향 범위 재발견 — Cycle #3 plan 가정 4 호출 → 실제 10 호출. spike: v5 dataSources.query 시그니처 확정) | hwjo + Claude |
