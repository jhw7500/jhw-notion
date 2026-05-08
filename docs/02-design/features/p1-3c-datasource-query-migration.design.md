# p1-3c-datasource-query-migration Design Document

> **Summary**: Option C(Pragmatic) — `notion/api.ts`에 `queryDataSource` wrapper 추가하여 v5 dataSources.query 마이그레이션. type guard / incomplete 감지를 wrapper 안에 캡슐화.
>
> **Project**: jhw-notion
> **Version**: 0.1.0 (mcp-server)
> **Author**: hwjo + Claude
> **Date**: 2026-05-08
> **Status**: Draft
> **Planning Doc**: [p1-3c-datasource-query-migration.plan.md](../../01-plan/features/p1-3c-datasource-query-migration.plan.md)

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | v2 `databases.query`는 v5에서 완전 제거 → 미래 SDK 업그레이드 진입 차단 + multi-data-source 정식 path 필요 |
| **WHO** | jhw-notion mcp-server (사용자 가시 영향 0, 9도구 내부 호출 변경) |
| **RISK** | 응답 union 확장 / mock 11 파일 / archived→in_trash 누락 / 한 사이클 전체 마이그레이션 회귀 |
| **SUCCESS** | 10 호출 100% + mock 110+ + live 7+1 + tsc 0 + archived 사용처 0 |
| **SCOPE** | In: SDK + 10 호출 + mock 11 + in_trash + incomplete warning. Out: cursor pagination, result_type, archive 도구 |

---

## 1. Overview

### 1.1 Design Goals

- v5 `dataSources.query`로 호출 마이그레이션을 단일 wrapper로 캡슐화
- 호출처 10곳의 패턴 일관성 확보 (DRY)
- type guard / incomplete 감지를 호출처에 노출하지 않음
- 기존 `callNotion` 안정성 레이어(retry/timeout/rate-limit) 그대로 활용
- 신규 파일 도입 0 — 기존 `notion/api.ts` 확장만

### 1.2 Design Principles

- **Single source of truth**: `queryDataSource(notion, db, params, meta)` 한 곳에 모든 v5 호출 패턴 집중
- **Wrapper 안 캡슐화**: type guard(`isFullPage`), incomplete warning, error handling 모두 내부
- **호출처 단순화**: 호출처는 db 이름과 filter/sorts만 전달, 응답은 정규화된 `Page[]`만 반환
- **메모리 필터 보존**: `report/query.ts:117-119` 코드 변경 0 (보험)
- **bisect 친화 commit 분할**: SDK / wrapper / callers / mocks / live-test 4-5단계로 분리

---

## 2. Architecture Options (v1.7.0)

### 2.0 Architecture Comparison

| Criteria | Option A: Minimal | Option B: Clean | Option C: Pragmatic |
|----------|:-:|:-:|:-:|
| **Approach** | 인라인 10회 패턴 반복 | 신규 3파일 (wrapper/guards/log) | api.ts 확장 (wrapper 1개) |
| **New Files** | 0 | 3 | **0** |
| **Modified Files** | 17 | 17 | **18** (api.ts +1) |
| **Complexity** | Low (반복) | High | **Medium** |
| **DRY** | ❌ | ✅ | **✅** |
| **type guard 일관성** | △ | ✅ | **✅** |
| **Maintainability** | Medium | High | **High** |
| **Effort** | Low | High | **Medium** |
| **Risk** | Med | Low | **Low** |
| **Recommendation** | hotfix | 장기 프로젝트 | **Default ✓ Selected** |

**Selected**: Option C (Pragmatic) — **Rationale**: 기존 `callNotion`이 이미 안정성 레이어를 모은 곳이므로 같은 파일에 `queryDataSource` 추가가 자연스러움. 신규 파일 부담 0. wrapper 인터페이스 1곳에 집중되어 향후 SDK 변경 시 단일 수정점.

### 2.1 Component Diagram

```
┌──────────────────┐           ┌──────────────────┐
│ tools/* (9개)    │           │ schema.ts        │
│ - history.ts     │──────┐    │ - dataSourceId   │
│ - context.ts     │      │    │ - getDataSourceId│
│ - status.ts      │      │    └────────┬─────────┘
│ - close.ts       │      │             │
│ - report/*       │      │             │
│ - resolve-project│      ▼             ▼
└──────────────────┘   ┌─────────────────────────────┐
                       │ notion/api.ts (확장)          │
                       │                             │
                       │ ▶ callNotion (기존)         │
                       │ ▶ withRetry (기존)          │
                       │ ▶ withTimeout (기존)        │
                       │ ▶ RateLimiter (기존)        │
                       │ ▶ NotionError (기존)        │
                       │ ◆ queryDataSource (신규)    │ ◀── 본 사이클의 핵심 추가
                       │   - getDataSourceId(db) 호출 │
                       │   - dataSources.query 호출  │
                       │   - isFullPage 필터링       │
                       │   - incomplete warning      │
                       └────────┬────────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │ @notionhq/client  │
                       │ v5.20.0           │
                       │ .dataSources.query│
                       └──────────────────┘
```

### 2.2 Data Flow

```
호출처 (예: history.ts)
  │
  │ queryDataSource(notion, "decisionLog", { filter, sorts, page_size }, { operation: "history.decisions.query" })
  ▼
notion/api.ts queryDataSource
  │
  │ 1. getDataSourceId(db) → "c1d8d3c3-..."
  │ 2. callNotion(() => notion.dataSources.query({ data_source_id, filter, sorts, ... }), meta)
  │    └─ withRetry + withTimeout + RateLimiter + NotionError 자동 적용
  │ 3. response.request_status.type === "incomplete" → console.warn(operation, reason)
  │ 4. response.results.filter(isFullPage) → PageObjectResponse[]
  ▼
호출처 수신 ({ results: PageObjectResponse[], nextCursor: string|null, incomplete: boolean })
  │
  │ 호출처 비즈니스 로직 (page.properties[...] 등)
  │ ※ report/query.ts는 메모리 필터(line 117-119) 추가 적용
  ▼
사용자 응답 (MCP tool result)
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|---|---|---|
| `tools/history.ts` 등 6 production | `notion/api.ts:queryDataSource` | wrapper 사용 |
| `notion/api.ts:queryDataSource` | `@notionhq/client@^5.20.0` `notion.dataSources.query` | v5 API 호출 |
| `notion/api.ts:queryDataSource` | `schema.ts:getDataSourceId` | DB → data_source_id 매핑 |
| `notion/api.ts:queryDataSource` | `@notionhq/client/build/src/helpers:isFullPage` | union 응답 타입 가드 |
| `notion/api.ts:queryDataSource` | 기존 `callNotion` | 안정성 레이어 |
| mock 11 파일 | `notion.dataSources.query` mock | 호출 시그니처 mock |

---

## 3. Data Model

### 3.1 wrapper 입출력 타입

```typescript
// notion/api.ts (신규 추가 영역)
import type { Client } from "@notionhq/client";
import {
  isFullPage,
  type PageObjectResponse,
  type PartialPageObjectResponse,
  type DataSourceObjectResponse,
  type PartialDataSourceObjectResponse,
} from "@notionhq/client";
import { type DatabaseName } from "../config.js";
import { getDataSourceId } from "../schema.js";

export interface QueryDataSourceParams {
  filter?: any;       // Notion filter object (v5 동일 형식)
  sorts?: any[];      // Notion sort array (v5 동일 형식)
  page_size?: number;
  start_cursor?: string;
  /** v5 신규 — 본 사이클은 기본값 사용 (page만) */
  result_type?: "page" | "data_source";
}

export interface QueryDataSourceMeta {
  /** 로그/에러 컨텍스트용 식별자 (예: "history.decisions.query") */
  operation: string;
  /** retry 시도 횟수 (기본 3) */
  attempts?: number;
}

export interface QueryDataSourceResult {
  /** isFullPage 필터링된 PageObjectResponse만 */
  results: PageObjectResponse[];
  nextCursor: string | null;
  /** v5의 request_status.type === "incomplete" 일 때 true */
  incomplete: boolean;
  /** 원본 응답 union (디버깅/특수 케이스용) — 일반 호출처는 results만 사용 */
  raw: Array<
    PageObjectResponse
    | PartialPageObjectResponse
    | DataSourceObjectResponse
    | PartialDataSourceObjectResponse
  >;
}
```

### 3.2 schema.ts 변경 없음

p1-3b에서 도입한 `DatabaseSchema.dataSourceId: string` + `getDataSourceId(db)` 헬퍼 그대로 사용. 본 사이클은 schema.ts 변경 0.

---

## 4. API Specification

### 4.1 Wrapper 시그니처

```typescript
/**
 * v5 dataSources.query 호출 wrapper.
 * - getDataSourceId(db) 자동 매핑
 * - callNotion 안정성 레이어 자동 적용
 * - request_status.incomplete 감지 시 console.warn
 * - isFullPage 필터링으로 PageObjectResponse[] 정규화
 *
 * 사용 예:
 *   const { results } = await queryDataSource(
 *     notion, "decisionLog",
 *     { filter, sorts: [{ property: "date", direction: "ascending" }], page_size: 100 },
 *     { operation: "history.decisions.query" },
 *   );
 *   for (const page of results) { ... page.properties[...] ... }
 */
export async function queryDataSource(
  notion: Client,
  db: DatabaseName,
  params: QueryDataSourceParams,
  meta: QueryDataSourceMeta,
): Promise<QueryDataSourceResult>;
```

### 4.2 호출처 마이그레이션 패턴

| Before (v2) | After (v5) |
|---|---|
| `notion.databases.query({ database_id: NOTION_CONFIG.databases.X, filter, sorts, page_size: 100 })` | `queryDataSource(notion, "X", { filter, sorts, page_size: 100 }, { operation: "..." })` |
| `await callNotion(() => ..., { operation: "..." })` | wrapper가 callNotion 자동 호출 — 호출처는 `await queryDataSource(...)`로 단순화 |
| `for (const page of res.results as any[]) { page.properties[...] }` | `for (const page of results) { page.properties[...] }` (results는 `PageObjectResponse[]`) |
| `page.archived` 사용 | `page.in_trash` (응답 키 변경) |

### 4.3 호출처 10곳 일대일 매핑

| 위치 | DB | 변경 전 | 변경 후 |
|---|---|---|---|
| `tools/history.ts:22` | projects | `databases.query({ database_id: ...projects, filter: {property:"title",title:{contains}} })` | `queryDataSource(notion, "projects", { filter: ... }, { operation: "history.projects.query" })` |
| `tools/history.ts:44` | decisionLog | filter relation, sorts | `queryDataSource(notion, "decisionLog", {...}, { operation: "history.decisions.query.relation" })` |
| `tools/history.ts:59` | decisionLog | filter rich_text legacy | `queryDataSource(notion, "decisionLog", {...}, { operation: "history.decisions.query.legacy", attempts: 1 })` |
| `tools/context.ts:22` | projects | (확인 필요 — Do 단계) | `queryDataSource(notion, "projects", ...)` |
| `tools/context.ts:53` | knowledgeBase 또는 decisionLog | (확인) | `queryDataSource(notion, "...", ...)` |
| `tools/context.ts:69` | (legacy fallback) | (확인) | `queryDataSource(notion, "...", { ...attempts: 1 })` |
| `tools/status.ts:31` | (확인) | (확인) | `queryDataSource(notion, "...", ...)` |
| `tools/close.ts:25` | decisionLog | filter project | `queryDataSource(notion, "decisionLog", ...)` |
| `notion/resolve-project.ts:44` | projects | filter title | `queryDataSource(notion, "projects", ...)` |
| `report/query.ts:91` | (5 DB 순회) | for-loop in db, databases.query per | for-loop, `queryDataSource(notion, db, ...)` per. 메모리 필터(line 117-119)는 그대로 |

> Do 단계 시작 시 `git grep "databases.query" -A 10` 으로 정확한 입력값/응답 처리 패턴을 §6.4(plan)에 채움.

---

## 5. UI/UX Design

해당 없음 (MCP 백엔드 only).

---

## 6. Error Handling

### 6.1 Error Code Definition

| Code | Source | Cause | Handling |
|---|---|---|---|
| 401 | Notion API | API 토큰 만료 | (호출처 영향) `NotionError` 던짐 → MCP error response |
| 404 | Notion API | data_source_id 무효 | wrapper 안에서 `NotionError` 던짐. **신규**: schema.ts dataSourceId 정합성 회귀 (검증 테스트로 차단) |
| 429 | Notion API | rate limit | 기존 RateLimiter + retry |
| 500 | Notion API | 서버 오류 | 기존 withRetry |
| TIMEOUT | client | 응답 지연 | 기존 withTimeout |
| (warn) | wrapper | `request_status.type === "incomplete"` | `console.warn(operation, incomplete_reason)` 1줄. 호출 자체는 성공으로 간주 (반환값 `incomplete: true`) |

### 6.2 Error Response Format

기존 `NotionError` 패턴 그대로. wrapper는 새 에러 형식 도입 X.

### 6.3 incomplete 처리 정책

```typescript
if (response.request_status?.type === "incomplete") {
  console.warn(
    `[notion.queryDataSource] ${meta.operation} incomplete:`,
    response.request_status.incomplete_reason ?? "unknown",
  );
}
```

- 호출 자체는 성공 (results 일부 반환됨)
- 호출처는 `incomplete: true` 플래그를 무시하거나 future-proof 로 활용 가능
- cursor pagination 본격 도입은 P1-3d에서 (이번엔 alert만)

---

## 7. Security Considerations

- [x] API 토큰 — `.bashrc:202` 단일 source (Cycle #3에서 정착)
- [x] production write 0회 — wrapper는 query만 (read-only)
- [x] sandbox 격리 — `loadSandboxConfig().dataSources` 사용 시 production data 접근 0
- [ ] Live test 시 sandbox env 검증 후 진입

---

## 8. Test Plan (v2.3.0)

### 8.1 Test Scope

| Type | Target | Tool | Phase |
|---|---|---|---|
| L1: API Tests | `notion.dataSources.query` 직접 호출 sanity check | curl | Spike (Do 진입 시) |
| Mock unit tests | wrapper + 11 호출처 mock 마이그레이션 | Vitest | Do |
| Live integration | Cycle #2 회귀 7건 v5 환경 + 신규 1건 | Vitest live | Do |

### 8.2 L1: API Test Scenarios

> Do 단계 시작 시 sanity check 1회.

| # | 호출 | 기대 |
|---|---|---|
| 1 | `dataSources.query({ data_source_id: <prod-projects>, page_size: 1 })` (Notion-Version: 2025-09-03) | 200 OK + `results: [Page]` + `request_status?` 키 존재 |
| 2 | 잘못된 `data_source_id` | 404 |
| 3 | 빈 결과 (filter 매칭 0건) | 200 + `results: []` |

### 8.3 Mock Unit Test Scenarios (Do 단계)

> 11 mock 파일 마이그레이션 패턴.

| # | 변경 내용 | 영향 파일 |
|---|---|---|
| 1 | `mockClient.databases.query.mockResolvedValue(...)` → `mockClient.dataSources.query.mockResolvedValue(...)` | 11 파일 모두 |
| 2 | mock 응답에 `next_cursor: null` (기존 ✓) + `request_status` 미포함(undefined OK) | 모두 |
| 3 | 호출 인자 검증 `expect(...query).toHaveBeenCalledWith(...)`에서 `database_id` → `data_source_id` | mock + assertion 부분만 |
| 4 | `helpers/mock-notion.ts` 또는 동등 파일에 `dataSources.query` mock 추가 | mock-notion.ts (helpers) |

### 8.4 Live Integration Test Scenarios

| # | 시나리오 | 위치 | 기대 |
|---|---|---|---|
| 1 | (회귀) 미래기간(2099-01-01~01-07) sandbox decisionLog → 0건 | `report.live.test.ts` | 통과 (v2 → v5 동일) |
| 2 | (회귀) 과거 단일일(1999-01-01) sandbox knowledgeBase → 0건 | `report.live.test.ts` | 통과 |
| 3 | (회귀) Cycle #1 record live 3건 (sandbox에 page 작성/검색) | `record.live.test.ts` | 통과 |
| 4 | **신규** v5 응답 union 검증: sandbox projects → results[0] 가 `isFullPage` 통과 | 신규 `datasource-query.live.test.ts` 또는 기존에 추가 | 통과 |
| 5 | (회귀) report/query.ts 메모리 필터 시뮬 5건 | `report/__tests__/query.test.ts` (mock 마이그레이션 후) | 통과 |

### 8.5 Seed Data Requirements

기존 sandbox 5 DB 그대로. 신규 seed 0.

---

## 9. Clean Architecture

### 9.1 Layer Structure

| Layer | Responsibility | Location |
|---|---|---|
| **Tool (Presentation)** | MCP 도구 등록 + 입출력 | `src/tools/*.ts` |
| **Service (Application)** | 비즈니스 로직 (filter 합성, sort, fallback) | 호출처 안에 inline (DRY 비용보다 변경 폭 작아 유지) |
| **Schema (Domain)** | DB 메타 + dataSourceId 매핑 | `src/schema.ts` |
| **Notion API (Infrastructure)** | callNotion + queryDataSource wrapper + 안정성 | `src/notion/api.ts` |

### 9.2 Dependency Rules

```
tools/* ─┬─→ schema.ts (DatabaseName, getDataSourceId)
         └─→ notion/api.ts (queryDataSource)
                  │
                  ├─→ schema.ts
                  ├─→ @notionhq/client (v5)
                  └─→ callNotion (자기 모듈 내부 헬퍼)
```

### 9.3 File Import Rules — 본 사이클 영향

| From | Can Import | Cannot Import |
|---|---|---|
| `tools/*` | `notion/api.ts:queryDataSource`, `schema.ts:DatabaseName` | `@notionhq/client` 직접 (wrapper 우회 금지) |
| `notion/api.ts` | `schema.ts`, `@notionhq/client` (v5) | `tools/*` |
| `schema.ts` | `config.ts` | `notion/api.ts` (순환 참조 금지) |

---

## 10. Coding Convention Reference

### 10.1 Naming

기존 컨벤션 그대로 (camelCase 함수, PascalCase 타입, kebab-case 파일).

### 10.2 Import Order

1. External (`@notionhq/client`)
2. Internal absolute (`../schema.js`, `../config.js`)
3. Same module (`./api.js`)
4. Type imports

### 10.3 Code Comment Convention

```typescript
// Design Ref: §4.1 — queryDataSource wrapper 시그니처
// Plan SC: FR-04 (응답 union 처리)
export async function queryDataSource(...) { ... }
```

호출처 마이그레이션 시:

```typescript
// Design Ref: §4.3 — history.ts 마이그레이션 (databases.query → dataSources.query via wrapper)
const { results } = await queryDataSource(notion, "decisionLog", { filter, sorts }, { operation: "history.decisions.query.relation" });
```

---

## 11. Implementation Guide

### 11.1 File Structure (변경 영역만)

```
mcp-server/
├── package.json                    [수정] @notionhq/client ^2.2 → ^5.20
├── package-lock.json               [auto]
└── src/
    ├── notion/
    │   └── api.ts                  [수정] +queryDataSource wrapper (~80 LOC 추가)
    ├── tools/
    │   ├── history.ts              [수정] 3 호출 마이그레이션
    │   ├── context.ts              [수정] 3 호출
    │   ├── status.ts               [수정] 1 호출
    │   ├── close.ts                [수정] 1 호출
    │   └── __tests__/              [수정] 9 mock 파일
    ├── notion/
    │   ├── resolve-project.ts      [수정] 1 호출
    │   └── __tests__/
    │       └── property-builder.test.ts  [수정] mock
    ├── report/
    │   ├── query.ts                [수정] 1 호출 (메모리 필터 line 117-119 보존)
    │   └── __tests__/
    │       └── query.test.ts       [수정] mock
    └── __tests__/
        └── live/
            ├── report.live.test.ts [신규 1건 추가 — v5 union 검증]
            └── record.live.test.ts [v2 → v5 동작 확인]
```

### 11.2 Implementation Order

1. **M1 (sdk-upgrade)**: `package.json` 변경 + `npm install` + tsc 즉시 깨짐 확인
2. **M2 (wrapper)**: `notion/api.ts`에 `queryDataSource` 추가 + unit test
3. **M3 (callers)**: 6 production 파일 마이그레이션 (호출 + 응답 처리)
4. **M4 (mocks)**: 11 mock 파일 시그니처 마이그레이션 → mock test 100% PASS 회복
5. **M5 (live + check)**: live 회귀 7건 + 신규 1건 + tsc/test 최종 검증

### 11.3 Session Guide

#### Module Map

| Module | Scope Key | Description | LOC | Estimated Turns |
|---|---|---|---:|:---:|
| **M1** | `sdk-upgrade` | package.json 변경 + npm install. tsc 깨짐 명시적 확인 (확인 후 다음 단계) | ~5 | 5-8 |
| **M2** | `wrapper` | `notion/api.ts`에 queryDataSource + QueryDataSource* 타입 + isFullPage import + incomplete warning. unit test 1-2건 추가 | ~80 | 8-12 |
| **M3** | `callers` | 6 production 파일 마이그레이션 (history, context, status, close, resolve-project, report/query) | ~150 | 15-20 |
| **M4** | `mocks` | 11 mock 파일 마이그레이션 + mock-notion 헬퍼 | ~150 | 15-20 |
| **M5** | `live-test` | live test 신규 1건 + 회귀 7건 v5 환경 재실행 + tsc/test 최종 통과 | ~30 | 8-12 |

#### Recommended Session Plan

| Session | Phase | Scope | Turns |
|---|---|---|:-:|
| Session 1 | Plan + Design (이번) | 전체 | 30-35 ✅ |
| Session 2 | Do | `--scope sdk-upgrade,wrapper` (M1+M2) | 15-20 |
| Session 3 | Do | `--scope callers,mocks` (M3+M4) | 30-40 |
| Session 4 | Do + Check + Report | `--scope live-test` + analyze + report | 25-35 |

> **권장**: 한 사이클이지만 LOC ~415 + 영향 17 파일이라 Do는 2-3 세션으로 분할 추천. M1+M2 먼저(인프라), 그 다음 M3+M4(대량 마이그레이션), 마지막 M5(검증).
> 단, 전체 한 세션도 가능 — 사용자 컨텍스트 윈도우와 시간 여유에 따라 조정.

#### Commit 단위 (bisect 친화)

| Commit | 내용 |
|---|---|
| 1 | `chore(deps): @notionhq/client v2.3.0 → v5.20.0` (M1) |
| 2 | `feat(notion/api): queryDataSource wrapper for v5 dataSources.query` (M2) |
| 3 | `refactor(tools): migrate 6 callers to queryDataSource` (M3) |
| 4 | `test(mocks): migrate 11 mock files to dataSources.query signature` (M4) |
| 5 | `test(live): v5 union response check + regression rerun` (M5) |

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 0.1 | 2026-05-08 | Initial draft (Option C 선택, Module Map 5단계, Commit 5단계 분할) | hwjo + Claude |
