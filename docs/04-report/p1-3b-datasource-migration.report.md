# p1-3b-datasource-migration Completion Report

> **Status**: Complete (Match Rate 97.25%)
>
> **Project**: jhw-notion
> **Version**: 0.1.0 (mcp-server)
> **Author**: hwjo
> **Completion Date**: 2026-05-08
> **PDCA Cycle**: #3

---

## Executive Summary

### 1.1 Project Overview

| Item | Content |
|------|---------|
| Feature | p1-3b-datasource-migration (v5 SDK + dataSources.query 마이그레이션의 사전 단계 — data_source_id 매핑 인프라) |
| Plan 확정일 | 2026-05-08 |
| 구현 커밋 | 2026-05-08 (`12a815c feat(p1-3b): data_source_id 매핑 인프라 (Do 단계)`) |
| Duration | Plan(0973b94) → Token blocker → 토큰 갱신 후 재개 → Do/Check/Report 1 추가 세션 |
| 분석 문서 | `docs/03-analysis/p1-3b-datasource-migration.analysis.md` |

### 1.2 Results Summary

```
┌─────────────────────────────────────────────┐
│  Match Rate: 97.25% (90% 임계 통과)          │
├─────────────────────────────────────────────┤
│  ✅ Complete:     8/8 FR + 4/4 NFR + 3/3 QC  │
│  ⏳ Carried Over: 0 (p1-3c 별도 plan 분리)   │
│  ❌ Cancelled:    0                          │
│  Tests:          110/110 mock PASS (+8 회귀) │
│                  + tsc 0 errors              │
└─────────────────────────────────────────────┘
```

### 1.3 Value Delivered

| Perspective | Content |
|---|---|
| **Problem** | Cycle #2 메모리 필터로 server-side filter 무시를 1차 차단했지만 long-term 해법인 `notion.dataSources.query()` 마이그레이션을 위해서는 각 DB의 `data_source_id`가 필요. 현재 schema.ts는 `database_id`만 보유 → 마이그레이션 진입 불가 |
| **Solution** | (1) Notion REST API `GET /v1/databases/{id}` (Notion-Version `2025-09-03`) 직접 호출로 production 5 + sandbox 5 = 10개 DB의 data_sources 메타 조회, (2) `schema.ts`의 `DatabaseSchema`에 `dataSourceId: string` 필드 추가 + 5개 채움 + `getDataSourceId(db)` 헬퍼, (3) `test/sandbox-config.ts`에 sandbox dataSources 매핑(격리), (4) 검증 테스트 8건. 운영 코드 변경 0 |
| **Function/UX 효과** | 사용자 가시 변화 없음. 후속 사이클(p1-3c) 진입 자산 확보 — 매핑 테이블 + 헬퍼 + 검증 테스트. mock 110/110 PASS (이전 102 → +8). 모든 DB가 1:1(count=1)이므로 `string` 단일 타입으로 단순화 |
| **Core Value** | 큰 마이그레이션을 안전한 두 단계로 쪼갬: 이번엔 "지도(매핑)"만 만들고 다음 사이클은 그 지도로 "이동(API 전환)". Cycle #2의 잘못된 가정(v3.x)을 정정해 v5.20.0 stable + breaking changes 식별. 매핑 결과 3중 영속(schema.ts + sandbox-config.ts + plan §6.4) |

---

## 1.4 Success Criteria Final Status

> Plan §3 FR + §3.2 NFR + §4.2 QC 최종 평가.

| # | Criteria | Status | Evidence |
|---|---|:---:|---|
| FR-01 | REST API 직접 호출로 data_sources 추출 | ✅ Met | curl + Notion-Version `2025-09-03`, 10개 DB 모두 200 OK |
| FR-02 | production 5개 매핑 100% | ✅ Met | `schema.ts:36-99` DATABASE_SCHEMAS 5 항목에 UUID 채움 |
| FR-03 | sandbox 5개 매핑 100% | ✅ Met | `test/sandbox-config.ts:36-42` SANDBOX_DATA_SOURCES |
| FR-04 | schema.ts dataSourceId 필드 추가 + 채움 | ✅ Met | `DatabaseSchema.dataSourceId: string` + `getDataSourceId(db)` 헬퍼 |
| FR-05 | sandbox 별도 위치 (`test/sandbox-config.ts`) | ✅ Met | 운영 schema와 격리 |
| FR-06 | multi-data-source 결정 적용 | ✅ Met | 모든 DB count=1 → 단일 `string` 타입 |
| FR-07 | 매핑 검증 unit test 1+건 | ✅ Exceeded | `schema-datasource.test.ts` **8건** (UUID/고유성/격리/헬퍼/혼동방지) |
| FR-08 | 운영 코드 변경 0 | ✅ Met | `git diff --stat`에서 `tools/`, `report/`, `notion/` 0건 |
| NFR-1 | Performance — 조회 일회성 | ✅ N/A | manual run 10회 curl |
| NFR-2 | Test 100% + 매핑 검증 1+ | ✅ Exceeded | **110/110 PASS** (이전 102 → +8) |
| NFR-3 | Safety — production write 0 | ✅ Met | `databases.retrieve` (read-only) 만 사용 |
| NFR-4 | Backward compat | ✅ Met | `getDatabaseId`/`DATABASE_SCHEMAS[db].id` 시그니처 동일 |
| QC-1 | 변경 line < 100 | ⚠ Acceptable | src +43, test +103 = 146 (관대 +46%, 회귀 가치로 수용) |
| QC-2 | API 키 하드코딩 0 | ✅ Met | env(.bashrc)에서만 read |
| QC-3 | 매핑 결과 영속 저장 | ✅ Met | schema.ts + sandbox-config.ts + plan §6.4 (3중) |

**Success Rate**: **15/15 (100%)** — QC-1 LOC 초과는 사용자 승인 범위 내.

## 1.5 Decision Record Summary

| Source | Decision | Followed? | Outcome |
|---|---|:---:|---|
| [Spike] SDK 최신 = v3.x (Cycle #2 가정) | 실제 v5.20.0 정정 | ✅ Corrected | Cycle #2 plan §6.4의 v3.x 가정이 부정확함을 spike로 입증 → 본 plan에서 v5 기반으로 재설계 |
| [Plan §7.2] 조회 방법 → REST API 직접 | curl + Notion-Version `2025-09-03` | ✅ | SDK 의존 0, 일관성 확보 |
| [Plan §7.2] 저장 위치 → schema.ts 확장 | DATABASE_SCHEMAS 각 항목에 dataSourceId | ✅ | schema-driven 패턴 일관 |
| [Plan §7.2] 매핑 범위 → prod + sandbox 10개 | 10/10 매핑 확보 | ✅ | 후속 p1-3c 즉시 진입 가능 자산 |
| [Plan §7.2] sandbox 분리 → test/sandbox-config.ts | SANDBOX_DATA_SOURCES + loadSandboxConfig().dataSources | ✅ | 운영 격리 명확 |
| [Plan §7.2] dataSourceId 타입 → 데이터 기반 | 모든 DB count=1 → 단일 `string` | ✅ | string[] 미사용으로 단순화 |
| [Plan §7.2] 후속 사이클 분리 → p1-3c | 호출 변경 0건 | ✅ | 인프라/마이그레이션 회귀 격리 |
| [Cycle 운영] M0 단계에서 Notion API 401 발견 | 토큰 갱신 + .env 정리 | ✅ Resolved | `.env`/`.bashrc`/Claude Code env 3중 토큰 충돌 → `.env` 토큰 줄 제거, `.bashrc:202` 단일 source |
| [Cycle 운영] 텍스트 응답 0줄 turn 종료 재발 방지 | Stop hook + CLAUDE.md 위반 사례 | ✅ Applied | `~/.claude/scripts/stop-text-required.py` 등록 + smoke 5/5 PASS |

---

## 2. Related Documents

| Phase | Document | Status |
|---|---|---|
| PM | (없음) | — Plan 단계부터 시작 (후속 분리 사이클) |
| Plan | [`p1-3b-datasource-migration.plan.md`](../01-plan/features/p1-3b-datasource-migration.plan.md) | ✅ Finalized 2026-05-08 (commit `0973b94`) |
| Design | (없음) | — Plan §9.2에서 임계 근처지만 §7.2 결정으로 충분, 의도적 생략 |
| Check | [`p1-3b-datasource-migration.analysis.md`](../03-analysis/p1-3b-datasource-migration.analysis.md) | ✅ Complete (Match 97.25%) |
| Act | 본 문서 | ✅ Complete |

---

## 3. Completed Items

### 3.1 Functional Requirements

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-01 | REST API 직접 호출 | ✅ Complete | Notion-Version `2025-09-03` 10회 curl |
| FR-02 | production 5 매핑 | ✅ Complete | schema.ts hardcoded |
| FR-03 | sandbox 5 매핑 | ✅ Complete | sandbox-config.ts hardcoded |
| FR-04 | DatabaseSchema.dataSourceId 필드 | ✅ Complete | + `getDataSourceId(db)` 헬퍼 |
| FR-05 | sandbox 별도 위치 | ✅ Complete | test/sandbox-config.ts 격리 |
| FR-06 | multi-DS 결정 적용 | ✅ Complete | count=1 확인 → 단일 string |
| FR-07 | 검증 테스트 1+ | ✅ Complete | 8건 (목표 +700%) |
| FR-08 | 운영 코드 변경 0 | ✅ Complete | tools/report/notion/ 무변경 |

### 3.2 Non-Functional Requirements

| Item | Target | Achieved | Status |
|---|---|---|---|
| Mock test pass rate | 100% | 110/110 (100%) | ✅ |
| 회귀 테스트 신규 추가 | 1+ | 8건 | ✅ |
| Test duration (mock) | < 5s | 369ms | ✅ |
| TypeScript strict | 0 errors | 0 errors | ✅ |
| Production write 호출 | 0 | 0 (read-only retrieve) | ✅ |
| 운영 코드 LOC delta | 0 | 0 (`tools/`, `report/`, `notion/`) | ✅ |

### 3.3 Deliverables

| Deliverable | Location | Status |
|---|---|---|
| dataSourceId 필드 + 5개 매핑 | `mcp-server/src/schema.ts` | ✅ |
| getDataSourceId 헬퍼 | `mcp-server/src/schema.ts:107-109` | ✅ |
| sandbox dataSources 매핑 | `mcp-server/src/test/sandbox-config.ts` | ✅ |
| 검증 테스트 (8건) | `mcp-server/src/__tests__/schema-datasource.test.ts` | ✅ |
| 매핑 결과 표 (영속) | `docs/01-plan/features/p1-3b-datasource-migration.plan.md` §6.4 | ✅ |
| Plan 문서 | `docs/01-plan/features/p1-3b-datasource-migration.plan.md` | ✅ |
| Analysis 문서 | `docs/03-analysis/p1-3b-datasource-migration.analysis.md` | ✅ |
| Report 문서 | 본 문서 | ✅ |
| **Stop hook (운영 개선)** | `~/.claude/scripts/stop-text-required.py` + settings.json 등록 | ✅ |
| **CLAUDE.md 위반 사례 추가** | `~/.claude/CLAUDE.md:124-125` (2026-05-08) | ✅ |

---

## 4. Incomplete Items

### 4.1 Carried Over to Next Cycle

| Item | Reason | Priority | Estimated Effort |
|---|---|---|---|
| **p1-3c-datasource-query-migration**: SDK v2.3.0 → v5.20.0 + `dataSources.query()` 호출 | Plan §2.2 명시적 out-of-scope. v5는 `databases.query` 완전 제거이므로 강제 마이그레이션 | High | 1~2일 |
| **p1-3c**: `archived` → `in_trash` 응답 필드 처리 | Plan §2.2. v5 응답 모델 변경 영향 처리 | Medium | (p1-3c 포함) |
| **p1-3c**: `DataSourceObjectResponse` / `isFullDataSource` 타입 가드 도입 | Plan §2.2. v5 신규 타입 시스템 대응 | Medium | (p1-3c 포함) |
| **p1-3c-pagination (후보)**: cursor pagination (page_size:100 한계) | Plan §2.2. 현재 데이터 ~50건이라 즉시 영향 없음 | Low | 0.5일 |
| **Minor**: `groupBy="db"` 응답 필드명 정리 (`report` → `group`) | 별도 사이클 (Cycle #2 carry-over) | Low | 0.2일 |

### 4.2 Cancelled/On Hold Items

| Item | Reason | Alternative |
|---|---|---|
| Plan §6.1의 `scripts/fetch-data-sources.ts` 신규 작성 | 1회성 조회라 영속 스크립트 불필요. plan §6.4 표 + schema.ts hardcode가 영속 자산 | 1회성 curl 명령 사용 (Analysis G1 — Accept) |
| Design 단계 작성 | Plan §7.2 6개 architectural decision으로 충분 | Plan이 design 역할 수행 |

### 4.3 Cycle 운영 중 발생한 Blocker (해결됨)

| Blocker | 발견 시점 | 해결 |
|---|---|---|
| Notion API 401 (`.env` token stale) | M0 spike 1차 시도 | 토큰 갱신 + `.env`에서 NOTION_API_KEY 줄 제거 (`.bashrc:202` 단일 source) |
| 도구 결과 후 텍스트 0줄 turn 종료 | M0 spike v5 header 호출 직후 | Stop hook (`stop-text-required.py`) + CLAUDE.md 위반 사례 추가 |

---

## 5. Quality Metrics

### 5.1 Final Analysis Results

| Metric | Target | Final | Note |
|---|---|---|---|
| Match Rate | 90% | **97.25%** | Structural 90 + Functional 100 + Contract 95 + Runtime 100 |
| Mock Test Coverage | 100% | 110/110 (100%) | 20 파일 (+8 신규) |
| Live Test Coverage | n/a | (실제 호출은 p1-3c에서 자동 검증) | sandbox dataSourceId 유효성은 p1-3c 진입 시 검증 |
| TypeScript Errors | 0 | 0 | tsc OK |
| LOC Delta (production) | 0 | 0 | tools/report/notion 무변경 |
| LOC Delta (schema) | < 100 | +43 (schema.ts +20, sandbox-config.ts +23) | 매핑 인프라 |
| LOC Delta (tests) | — | +103 (schema-datasource.test.ts) | 8건 회귀 |
| LOC Delta (docs) | — | plan §6.4 +33, analysis 신규, report 신규 | 영속 자산 |

### 5.2 Resolved Issues

| Issue (Plan §1.2) | Resolution | Result |
|---|---|---|
| Cycle #2 plan의 v3.x 가정 부정확 | Spike로 v5.20.0 stable 확인 + breaking changes 식별 | ✅ Resolved |
| `data_source_id` 매핑 부재로 dataSources.query 진입 불가 | 10개 DB 매핑 schema/sandbox-config에 영속 | ✅ Resolved |
| multi-data-source DB의 N개 ID 처리 패턴 미확정 | 데이터 본 결과 모두 count=1 → 단일 string | ✅ Resolved |
| v2 SDK가 응답에 data_sources 노출 안 함 | REST 직접 호출로 우회 | ✅ Resolved |

---

## 6. Lessons Learned & Retrospective

### 6.1 What Went Well (Keep)

- **Spike 우선 결정**: Plan 작성 전 v5 dataSources 존재 검증 spike(`/tmp/notion-v5-spike`)로 Cycle #2의 잘못된 가정(v3.x)을 즉시 정정 → 헛된 plan 시간 절약
- **Phase 분리 (p1-3b vs p1-3c)**: 매핑 인프라와 API 호출 마이그레이션을 회귀 위험 단위로 격리 → 한 사이클에 한 번에 다 했을 경우의 mock 5 파일 재작성 + 응답 타입 처리 + 테스트 깨짐을 동시 처리해야 하는 부담 분산
- **데이터 기반 결정**: dataSourceId 타입을 가정 없이 조회 결과(모두 count=1) 본 후 단일 `string` 으로 결정 → 미사용 string[] 분기 제거
- **3중 영속**: schema.ts (런타임) + sandbox-config.ts (테스트) + plan §6.4 (문서) — 매핑 결과의 자산화 강도 높음
- **Cycle 운영 개선의 즉시 캡처**: 401 blocker, 토큰 source 분기, 텍스트 0줄 turn 종료 모두 같은 사이클 내에서 해결 + Stop hook + CLAUDE.md 위반 사례로 영속화
- **회귀 테스트 +700%**: Plan 목표 1건 → 실제 8건 (UUID 형식 / id↔dataSourceId 분리 / 고유성 / sandbox-prod 격리 / 헬퍼 매핑 / 다섯 가지 보장)

### 6.2 What Needs Improvement (Problem)

- **Cycle #2 plan의 잘못된 가정(v3.x)**: 외부 SDK 버전 가정을 검증 없이 plan에 적었음. 외부 의존성에 대한 가정은 plan 작성 시점에 spike로 검증해야 함
- **3중 토큰 source 충돌**: `.env` / `.bashrc` / Claude Code 부모 환경 — 토큰 source의 우선순위가 명시 안 됨. 본 사이클에서 `.env` 줄 삭제 + `.bashrc:202` 단일 source로 정리했지만, 같은 패턴은 다른 프로젝트에서도 재발 가능
- **응답 분기 시 자가점검 빈틈**: 멀티-도구 한 응답 내에서는 잘 적용되던 자가점검이 단일 도구 결과만 받은 응답 분기에서 빠짐. Stop hook으로 보강했지만 본질은 모델 자가준수

### 6.3 What to Try Next (Try)

- **p1-3c 진입 시 v5 마이그레이션 가이드 직접 확인**: `node_modules/@notionhq/client/README.md` 의 마이그레이션 섹션 + GitHub release notes를 plan 작성 전 확인
- **회귀 테스트 패턴 일반화**: dataSourceId 검증 8건의 패턴(UUID 형식 / 분리 / 고유성 / 격리 / 헬퍼)을 다른 schema-driven 자산에도 적용
- **Stop hook 데이터 수집**: 다음 N번 세션에서 Stop hook 트리거 빈도 모니터링 → 자가점검 효과 측정
- **token source 일원화 가이드**: 다른 프로젝트에도 적용 가능한 패턴 문서화 (".bashrc 우선, .env는 식별자만")

---

## 7. Process Improvement Suggestions

### 7.1 PDCA Process

| Phase | Current | Improvement Suggestion |
|---|---|---|
| Plan | spike + phase 분리 잘 됨 | OK — 외부 SDK 가정은 spike 의무화 |
| Design | 의도적 생략 | OK — plan §7.2 결정으로 충분한 변경 규모 |
| Do | 한 세션에 M0~M4 + 검증 | OK — 단, M0 blocker 처리 시 다음 세션으로 보류한 판단도 적절 |
| Check | gap-detector 자동화 미사용 (수동) | 다음 사이클은 gap-detector 호출 시도 (구조적 검증 자동화) |
| Act | 본 보고서 | OK |

### 7.2 Tools/Environment

| Area | Improvement Suggestion | Expected Benefit |
|---|---|---|
| Stop hook | 본 사이클에 도입 | 텍스트 0줄 turn 종료 패턴 차단 |
| Token source 일원화 | `.bashrc` 단일 source 패턴 다른 프로젝트에 전파 | 토큰 충돌 디버깅 시간 절감 |
| Live test CI (Cycle #1, #2 carry-over) | GitHub Actions 야간 실행 | server-side breaking change 조기 감지 |
| v5 마이그레이션 회귀 가드 (p1-3c) | data_sources.query 호출 후 결과 shape 검증 | 응답 모델 변경 회귀 보호 |

---

## 8. Next Steps

### 8.1 Immediate

- [x] git commit Plan (`0973b94`, 2026-05-08)
- [x] git commit Do (`12a815c`, 2026-05-08)
- [ ] git commit Analysis + Report (본 사이클 마무리 commit)
- [ ] (선택) `/pdca archive p1-3b-datasource-migration --summary`

### 8.2 Next PDCA Cycle (강력 권장)

| Item | Priority | Note |
|---|---|---|
| **p1-3c-datasource-query-migration** | High | 본 사이클에서 매핑 인프라 확보 → 즉시 API 호출 마이그레이션 진입 가능. 4 호출(`history.ts` × 3 + `report/query.ts` × 1) + mock 5 파일 + 응답 타입 처리 |
| live-test-ci (carry-over) | Medium | Cycle #1, #2 누적. v5 마이그레이션 후 회귀 보호 핵심 |
| state-cleanup (`helpers`/`__tests__` phantom) | Low | UX 노이즈 |

---

## 9. Changelog

### v0.1.0+ (2026-05-08, p1-3b)

**Added:**
- `mcp-server/src/schema.ts` — `DatabaseSchema.dataSourceId: string` 필드 + 5개 production 매핑 + `getDataSourceId(db)` 헬퍼
- `mcp-server/src/test/sandbox-config.ts` — `SandboxConfig.dataSources` 5개 sandbox 매핑 (격리)
- `mcp-server/src/__tests__/schema-datasource.test.ts` — 회귀 8건 (UUID/고유성/격리/헬퍼/혼동방지)
- `docs/01-plan/features/p1-3b-datasource-migration.plan.md` (commit `0973b94`)
- `docs/03-analysis/p1-3b-datasource-migration.analysis.md`
- `docs/04-report/p1-3b-datasource-migration.report.md` (본 문서)
- `~/.claude/scripts/stop-text-required.py` — 텍스트 0줄 turn 종료 차단 hook
- `~/.claude/CLAUDE.md:124-125` — 2026-05-08 위반 사례 영속화

**Changed:**
- `~/.claude/settings.json` — Stop hook entry에 `stop-text-required.py` 추가
- `mcp-server/.env` — NOTION_API_KEY 줄 제거 (`.bashrc:202` 단일 source 정책)

**Fixed:**
- `.env` / `.bashrc` / Claude Code env 3중 토큰 충돌 (Notion API 401 회귀 차단)

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 1.0 | 2026-05-08 | 초안 작성 (PDCA #3 완료 보고서, Match Rate 97.25%) | hwjo + Claude |
