# p1-3b-datasource-migration Planning Document

> **Summary**: v5 SDK + `dataSources.query` 마이그레이션의 **사전 단계** — 5개 DB의 data_source_id 매핑 인프라 구축. 실제 API 호출 마이그레이션은 후속 사이클(p1-3c)로 분리.
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
| **Problem** | Cycle #2에서 server-side date filter 미동작을 메모리 필터로 1차 차단했지만, long-term 해법인 `notion.dataSources.query()` 마이그레이션을 위해서는 각 DB의 `data_source_id`를 미리 알아야 한다. 현재 schema.ts는 `database_id`만 보유 → API 마이그레이션 진입 불가 |
| **Solution** | (1) Notion REST API(`GET /v1/databases/{id}`) 직접 호출로 5개 production + 5개 sandbox DB의 data_sources 메타 조회, (2) `schema.ts`에 `dataSourceId` 필드 추가(단일 string 또는 multi-data-source 시 string[]), (3) 운영 코드 영향 0 (조회/저장 인프라만 — `dataSources.query` 전환은 p1-3c) |
| **Function/UX 효과** | 사용자 가시 변화 없음. 다음 사이클 진입 자산 확보 — 매핑 테이블 + 조회 헬퍼 + 검증 테스트. v2 코드 그대로 유지하므로 회귀 위험 0 |
| **Core Value** | 큰 마이그레이션을 안전한 두 단계로 쪼갬: 이번엔 "지도(매핑)"만 만들고, 다음 사이클은 그 지도를 보고 "이동(API 전환)". 각 단계 회귀 검증을 분리해 위험 분산 |

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | v5 `dataSources.query`는 `data_source_id` 필수. 현재 schema.ts는 database_id만 → 마이그레이션 사전 자산 부재 |
| **WHO** | jhw-notion mcp-server 개발자(self) — production 코드 영향 없음, 다음 사이클(p1-3c) 진입 가능성 확보 |
| **RISK** | (1) multi-data-source DB의 N개 ID 처리 패턴 미확정, (2) production DB는 운영 환경이라 직접 조회 시 API rate-limit 영향, (3) v2 SDK가 응답에서 data_sources 필드를 노출 안 하면 우회 필요 |
| **SUCCESS** | (1) 10개 DB(prod 5 + sandbox 5)의 data_source_id 매핑 100% 확보, (2) schema.ts에 `dataSourceId` 추가 + 기존 dataset 회귀 0건, (3) 매핑 검증 테스트 1+건, (4) p1-3c 진입 가능 상태 |
| **SCOPE** | Phase 1(이번 plan): 매핑 인프라 + 조회 스크립트 + schema 확장. Phase 2(p1-3c): SDK v5 업그레이드 + dataSources.query 호출 마이그레이션 + archived→in_trash. 두 phase 분리는 의도적 |

---

## 1. Overview

### 1.1 Purpose

`@notionhq/client` v5에서 도입된 `notion.dataSources.query()` API로 5개 DB 조회를 마이그레이션할 때 필요한 `data_source_id` 매핑을 구축한다. 본 사이클은 매핑 인프라까지만 다루고, 실제 API 호출 변경은 후속 사이클로 분리한다.

### 1.2 Background

2026-05-08 spike에서 다음을 확인했다:

| 항목 | 결과 |
|---|---|
| 최신 SDK | `@notionhq/client@5.20.0` (Cycle #2 가정한 v3.x가 아님) |
| v5 `dataSources` 노출 | `retrieve / query / create / update / listTemplates` |
| v5 `databases.query` | **제거됨** — `databases`엔 `retrieve/create/update`만 |
| 파라미터 변경 | `database_id` → `data_source_id` |
| Notion-Version | `2025-09-03` (v5 = 2025-09 API) |

이는 단순 SDK 업그레이드가 아니라 API 모델 자체의 변경이다. multi-data-source DB(Projects/DecisionLog/KnowledgeBase) 는 1 database가 N dataSource를 가질 수 있으므로 매핑 구조 결정이 선행되어야 한다.

### 1.3 Related Documents

- 직전 사이클: [`docs/archive/2026-05/report-date-filter-fix/`](../../archive/2026-05/report-date-filter-fix/)
- 후속 plan 후보: `docs/01-plan/features/p1-3c-datasource-query-migration.plan.md` (미작성)
- spike 결과: 본 plan §1.2
- 관련 코드: `mcp-server/src/schema.ts`, `mcp-server/src/config.ts`

---

## 2. Scope

### 2.1 In Scope

- [ ] 일회성 조회 스크립트 작성 (`scripts/fetch-data-sources.ts` 또는 .mjs): Notion REST API `GET /v1/databases/{id}` 직접 호출 → response의 `data_sources[*].id` 추출
- [ ] production 5개 DB + sandbox 5개 DB = 총 10개의 `data_source_id` 확보 및 결과 보고서 출력
- [ ] `schema.ts`의 `DatabaseSchema` 인터페이스에 `dataSourceId` 필드 추가 (단일/배열은 §2.4에서 결정)
- [ ] `DATABASE_SCHEMAS`의 5개 항목에 production dataSourceId 채우기
- [ ] sandbox용 dataSourceId는 `test/sandbox-config.ts` 또는 환경변수에 별도 매핑 (production schema와 분리)
- [ ] 매핑 검증 테스트: 각 DB의 dataSourceId가 비어있지 않은지 확인하는 unit test 1건
- [ ] live test 1건: sandbox dataSourceId가 실제 Notion에서 유효한지 (옵셔널, sandbox guard로 skip 가능)
- [ ] 변경 사항 문서화 (CHANGELOG / schema.ts 주석)

### 2.2 Out of Scope

- v5 SDK 업그레이드 (`@notionhq/client@^2.2.0` → `^5.20.0`)
- `notion.databases.query()` → `notion.dataSources.query()` 호출 마이그레이션
- 응답 필드 `archived` → `in_trash` 처리
- `DataSourceObjectResponse` / `isFullDataSource` 등 신규 타입 가드 도입
- 운영 호출 path 변경 (production 코드는 v2 그대로)
- cursor pagination (page_size:100 한계 해결)

위 항목은 모두 **p1-3c-datasource-query-migration**(다음 사이클)에서 다룬다.

### 2.3 사전 검증 단계 (Phase 1.0 — 본 plan 시작 직후)

- [ ] v2 SDK의 `databases.retrieve` 응답이 `data_sources` 필드를 포함하는지 micro-spike (5분 이내)
  - YES: SDK 그대로 사용 가능
  - NO: REST API 직접 호출 (curl/fetch) — 본 plan의 기본 가정

### 2.4 Multi-Data-Source 구조 결정 (Phase 1.1)

조회 결과를 본 후 결정:
- 각 DB가 **1개 dataSource**만 가지면 → `dataSourceId: string`
- 일부 DB가 **N개 dataSource**를 가지면 → `dataSourceId: string` (default) + `dataSourceIds?: string[]` (확장)

이 결정은 조회 결과를 기반으로 plan 진행 중 확정. 가정 없이 데이터 기반.

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-01 | Notion REST API `GET /v1/databases/{id}` 직접 호출로 data_sources 추출 | High | Pending |
| FR-02 | production 5개 DB의 dataSourceId 100% 매핑 | High | Pending |
| FR-03 | sandbox 5개 DB의 dataSourceId 100% 매핑 | High | Pending |
| FR-04 | `schema.ts`에 `dataSourceId` 필드 추가 + production 값 채움 | High | Pending |
| FR-05 | sandbox dataSourceId는 별도 위치 매핑 (`test/sandbox-config.ts` 권장) | High | Pending |
| FR-06 | multi-data-source DB 발견 시 §2.4 결정 적용 (string vs string[]) | High | Pending |
| FR-07 | 매핑 검증 unit test 1+건 (모든 DB의 dataSourceId 비어있지 않음) | Medium | Pending |
| FR-08 | 운영 코드(tools/, report/, notion/) 변경 0 — schema 확장만 | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | 측정 |
|---|---|---|
| Performance | 조회 스크립트는 일회성 — 성능 무관 | manual run |
| Test | 기존 mock 102 + live 5 PASS 유지 + 매핑 검증 1+ 추가 | npm test |
| Safety | production DB에 write 0회 (read-only `databases.retrieve`만) | grep |
| Backward compat | 기존 `getDatabaseId` 등 호출부 영향 0 | tsc + grep |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01~08 모두 충족
- [ ] 10개 DB(prod 5 + sandbox 5)의 dataSourceId 결과 표가 plan 또는 별도 문서에 기록됨
- [ ] schema.ts: `DatabaseSchema.dataSourceId` 필드 + 5개 항목 채움
- [ ] sandbox-config.ts(또는 동등 위치): sandbox dataSourceId 5개 매핑
- [ ] mock 100% PASS + 매핑 검증 테스트 1+ 추가
- [ ] tsc 0 errors
- [ ] 운영 코드 변경 0 (git diff에서 tools/, report/, notion/ 디렉토리 변경 없음)

### 4.2 Quality Criteria

- [ ] 변경 line 수 < 100 (schema.ts 확장 + 신규 스크립트 + 1 테스트)
- [ ] 조회 스크립트에 API 키/시크릿 하드코딩 0 (env에서만 read)
- [ ] 매핑 결과 plan 문서 또는 archive에 영속 저장 (조회 재실행 부담 최소화)

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| v2 SDK가 `data_sources` 필드를 응답에서 제거/미노출 | Med | Med | REST API 직접 호출(curl/fetch) 백업 — Plan §2.1 기본 가정 |
| multi-data-source DB의 N개 ID 처리 미확정 → schema 구조 재설계 필요 | Med | Med | §2.4 데이터 기반 결정. plan 진행 중 확정 — design 단계 미사용이지만 plan 문서 §6에서 결과 기록 |
| production DB 호출 시 API rate-limit 트리거 | Low | Low | 5회 sequential read-only 호출, 기존 RateLimiter(`notion/api.ts`)와 별개라 영향 미미 |
| Notion-Version header 차이로 응답 스키마 변동 | Med | Low | 호출 시 `Notion-Version: 2025-09-03` 명시 — v5와 동일 버전으로 정렬 |
| 매핑 결과를 plan에만 기록하고 관리 잃음 | Med | Low | schema.ts에 영속 저장 + 검증 테스트로 회귀 보호 |
| sandbox dataSourceId가 운영 schema에 섞임 | High | Low | 별도 파일(`test/sandbox-config.ts`) 분리 — production 조회 시 sandbox ID 사용 불가 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|---|---|---|
| `mcp-server/src/schema.ts` | TS module | `DatabaseSchema` 인터페이스에 `dataSourceId` 필드 추가 + 5개 항목 채우기 (~15 LOC) |
| `mcp-server/scripts/fetch-data-sources.ts` (신규) | TS script | REST API로 10개 DB 조회 + 결과 출력 (~80 LOC) |
| `mcp-server/src/test/sandbox-config.ts` | TS module | sandbox dataSourceId 5개 매핑 추가 (~10 LOC) |
| `mcp-server/src/__tests__/schema.test.ts` (신규/확장) | Test | 매핑 검증 1+건 (~30 LOC) |
| `docs/01-plan/features/p1-3b-datasource-migration.plan.md` | Doc | 조회 결과 표 §6.4에 추가 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|---|---|---|---|
| `DatabaseSchema` 타입 | type | 7+ 파일에서 import | None — 새 필드는 `dataSourceId` 추가만, 기존 필드 무변경 |
| `getDatabaseId(db)` | function | `notion-client.ts`, `tools/start.ts` 등 | None — 함수 시그니처/반환값 동일 |
| `DATABASE_SCHEMAS[db].id` | property | `report/query.ts`, `tools/history.ts`, etc | None — `id` 필드 그대로, `dataSourceId`는 추가일 뿐 |
| sandbox env (`NOTION_SANDBOX_DB_*`) | runtime | live test | None — env는 그대로, dataSourceId는 별도 |

### 6.3 Verification

- [ ] `git diff` HEAD..후 — `tools/`, `report/`, `notion/` 디렉토리 변경 0건 확인
- [ ] tsc 0 errors
- [ ] 기존 mock 102 PASS 유지

### 6.4 Data Source Mapping (조회 후 채워질 자리)

> Phase 1.1 조회 후 채움. **현재는 미작성 — plan 진행 중 업데이트.**

| DB | DB ID (database_id) | DataSource ID(s) | env (production/sandbox) |
|---|---|---|---|
| projects | (config.ts) | TBD | production |
| preferences | (config.ts) | TBD | production |
| decisionLog | (config.ts) | TBD | production |
| knowledgeBase | (config.ts) | TBD | production |
| references | (config.ts) | TBD | production |
| projects-sandbox | NOTION_SANDBOX_DB_PROJECTS | TBD | sandbox |
| preferences-sandbox | NOTION_SANDBOX_DB_PREFERENCES | TBD | sandbox |
| decisionLog-sandbox | NOTION_SANDBOX_DB_DECISION_LOG | TBD | sandbox |
| knowledgeBase-sandbox | NOTION_SANDBOX_DB_KNOWLEDGE_BASE | TBD | sandbox |
| references-sandbox | NOTION_SANDBOX_DB_REFERENCES | TBD | sandbox |

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
| 조회 방법 (SDK vs REST) | **REST API 직접 호출** | v2 SDK의 응답 필드 미노출 가능성 + SDK 의존 제로 + Notion-Version 명시 가능 |
| dataSourceId 저장 위치 | **schema.ts 확장** | 기존 schema-driven 패턴 일관성 — `id` 필드와 같은 곳에 |
| 매핑 범위 | **production + sandbox 10개 모두** | 후속 사이클(p1-3c)에서 즉시 사용 가능 |
| sandbox 분리 위치 | `test/sandbox-config.ts` | production schema와 명시적 분리 (운영 schema에 sandbox ID 섞임 방지) |
| `dataSourceId` 타입 | **데이터 기반 결정** | 조회 결과(§6.4) 본 후 string vs string[]/주 ID + 보조 ID 결정. 가정 없음 |
| 후속 사이클 분리 | **p1-3c-datasource-query-migration** | API 호출 마이그레이션 = 별도 회귀 위험 단위. 매핑 인프라와 회귀 격리 |

### 7.3 Clean Architecture

기존 구조 유지. 변경은 schema.ts(메타데이터 확장), 신규 scripts/(일회성 도구), test/sandbox-config.ts(테스트 메타) 3 곳.

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md` (전역 + 프로젝트) 존재
- [x] `mcp-server/AGENTS.md` 코딩 규칙 존재
- [x] TypeScript strict (tsconfig.json)
- [x] Vitest (mock + live 분리)
- [x] schema-driven 패턴 (Cycle #1에서 도입)

### 8.2 Conventions to Define

- 일회성 스크립트 위치: `mcp-server/scripts/` (신규 디렉토리 — 신규 컨벤션이지만 단순)
- 스크립트 실행 방법: `node --loader ts-node/esm scripts/fetch-data-sources.ts` 또는 tsx — 설치 필요 시 별도 결정

### 8.3 Environment Variables Needed

기존 `NOTION_API_KEY` + sandbox 5개로 충분. 신규 env 없음 (조회 결과는 코드/문서로 영속 저장).

---

## 9. Next Steps

1. [ ] **Phase 1.0 micro-spike** (5분): v2 SDK `databases.retrieve` 응답에 `data_sources` 노출 여부 확인
2. [ ] Design 단계 생략 검토 — 변경 LOC 100 이하면 생략, 이상이면 짧은 design 작성
3. [ ] `/pdca do p1-3b-datasource-migration` 실행
4. [ ] 조회 스크립트 작성 → 10개 DB 조회 → 결과를 plan §6.4에 채움
5. [ ] §2.4 multi-data-source 구조 결정 → schema.ts 확장
6. [ ] sandbox-config.ts에 sandbox dataSourceId 추가
7. [ ] 매핑 검증 테스트 작성
8. [ ] `npm test` + `npm run build` 통과 확인
9. [ ] git commit (운영 코드 변경 0 검증)
10. [ ] `/pdca analyze p1-3b-datasource-migration`
11. [ ] `/pdca report` → `/pdca archive --summary`
12. [ ] `/pdca plan p1-3c-datasource-query-migration` 시작

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 0.1 | 2026-05-08 | Initial draft (spike 결과 기반: v5 SDK 5.20.0 + dataSources 입증, breaking changes 식별) | hwjo + Claude |
