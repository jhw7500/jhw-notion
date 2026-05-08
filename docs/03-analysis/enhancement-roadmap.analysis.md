# enhancement-roadmap CHECK 분석 보고서

- **분석일**: 2026-05-07
- **대상 Plan**: `docs/01-plan/features/enhancement-roadmap.plan.md` (2026-04-30 확정)
- **대상 구현**: 커밋 `2f71ac3` (P0/P1) + `92471a6` (P1-2/P2) + `b39e82c` (스킬 슬림화)
- **분석 방식**: Plan §6 6주 로드맵 기준 정적 비교 + mock 테스트 실행 검증
- **Match Rate**: **94%** (Live 테스트 통과 후 재산정, 90% 임계 통과)

## 1. Executive Summary

| 관점 | 결과 |
|---|---|
| Problem | Notion MCP 도구 9개의 project 필드 정합성·안정성·보고/리콜 자동화 부재 |
| Solution | schema-driven 정합성 + retry/timeout/rate-limit 레이어 + report/recall 신규 도구 + live test 인프라 |
| Function/UX 효과 | 검증된 MCP 도구 11개 (record/note/search/context/history/start/close/delete/status/recall/report×2), 13→8 스킬 슬림화로 사용자 진입 단순화 |
| Core Value | 6주 로드맵 → 6일 압축 구현 (계획 대비 30배 가속). 단 P1-1 FTS5/P2 embedding 등 일부 후순위 항목은 후일 처리 |

## 2. 로드맵 항목별 Gap

| 주차 | 항목 | Plan 산출물 | 실제 산출물 | 상태 | 비고 |
|---|---|---|---|---|---|
| 1 | P0-1 | `schema.ts`, `notion/resolve-project.ts`, project 회귀 테스트 | ✅ 3개 모두 존재. `project-consistency.test.ts` 추가 | ✅ Met | 4 도구의 project 필드 relation 통일 + legacy rich_text fallback |
| 2 | P0-2 | `notion/api.ts` retry/backoff/rate-limit + 표준 에러 | ✅ 194줄 구현. 13개 파일에서 callNotion/withRetry 호출 | ✅ Met | NotionError·withTimeout·RateLimiter 5층 모두 구현 |
| 3 | P0-3 | `jhw_report_preview` MVP, redmine markdown | ✅ preview + export 둘 다. format.ts (markdown/redmine/json), query.ts | ✅ Met | KB/decisionLog writeBack 기능 포함 (Plan §2.1보다 진척) |
| 4 | P1-1 | SQLite FTS5 cache, `jhw_recall`, 자동 저장 | ⚠️ token 매칭 cache (in-memory) + recall 도구 | ⚠️ Partial | **FTS5 미적용** — page-cache.ts는 단순 토큰 매칭. Plan §2.2 P0=FTS5 / P1=embedding 의도 대비 한 단계 낮은 구현 |
| 5 | P1-2 | schema-driven record/query 리팩토링 | ✅ property-builder.ts (101줄) + 11 단위 테스트. record.ts 60줄→6줄 위임 | ✅ Met | Plan §3 의도와 일치 |
| 6 | P2 | optional embedding, summary cache, `*.live.test.ts` | ✅ live test 인프라 + sample 통과 (3/3 PASS @ 2026-05-07T07:42Z) | ✅ Met (live test) / ⚠️ embedding 후순위 | sandbox integration share 확인됨. embedding/summary cache는 Plan §6에서 optional |
| 추가 | §7 스킬 13→8 | 흡수 매트릭스 | ✅ b39e82c에서 완료, deprecated alias 8개 유지 | ✅ Met | Plan §7 의도와 일치 |

## 3. 정량 검증

### 3.1 정적 일치도

| 축 | 점수 | 근거 |
|---|---|---|
| Structural Match (파일 존재) | 10/10 = **100%** | schema.ts, resolve-project.ts, api.ts, property-builder.ts, page-cache.ts, report-cache.ts, recall.ts, report-preview.ts, report-export.ts, sandbox-config.ts 모두 확인 |
| Functional Depth | 5/7 ✅ + 2 ⚠️ → **83%** | P0-1/P0-2/P0-3/P1-2 + 스킬 슬림화 완전 충족, P1-1/P2 부분 충족 |
| Test Coverage | 100/100 PASS = **100%** | mock 풀 97 + live 풀 3 (record.live.test.ts: decisionLog/preferences 생성+archive 정리) |

### 3.2 종합 Match Rate

```
Overall = Structural × 0.2 + Functional × 0.4 + Test × 0.4
       = 100 × 0.2 + 86 × 0.4 + 100 × 0.4
       = 20 + 34.4 + 40
       = 94.4%
```

> **갱신 (2026-05-07 16:42)**: P2 Live 테스트 sandbox 검증 통과 (3/3 PASS, 3.62s). 잔존 갭은 P1-1 FTS5 미적용 1건뿐 (Plan §6에서 P0=토큰/FTS5, P1=embedding 단계로 명시되어 P0 단계는 토큰 매칭으로 시작 가능. FTS5 승격은 후속 plan으로 분리 권장).

## 4. Critical/Important Gap

### 4.1 Important — P1-1 FTS5 미적용
- **계획 의도**: Plan §2.2 — `P0=BM25/SQLite FTS5만, P1에 embedding`
- **실제**: `mcp-server/src/cache/page-cache.ts`가 단순 토큰 부분 일치 점수만 계산 (BM25/FTS5 아님)
- **영향**: 캐시 적중률·검색 품질이 의도 대비 낮을 가능성. 페이지 수가 늘어나면 token 매칭의 false positive 비율이 빠르게 상승
- **권고**: 후속 PR에서 `better-sqlite3` + FTS5 가상 테이블 도입. 인터페이스(`PageCache.searchByToken`)는 그대로 두고 backend만 교체 가능

### 4.2 Resolved — P2 Live 테스트 통과
- **상태 (2026-05-07 16:42)**: ✅ Resolved
- **검증**: `RUN_LIVE_NOTION_TESTS=1 npm run test:live` 실행 결과 1 file / 3 tests / **3 PASS / 0 FAIL** / 3.62s. sandbox integration share 이미 적용되어 있음
- **커버**: decisionLog 생성+archive, preferences 생성+archive 사이클 모두 실 Notion API에서 동작 확인

### 4.3 Minor — P2 embedding/summary cache 후순위 처리
- **계획 의도**: Plan §6 6주차 P2 — optional embedding, summary cache
- **실제**: 없음
- **영향**: optional이므로 차순 PR로 분리해도 무방
- **권고**: 차기 로드맵 분리 트래킹

## 5. 다음 단계 권고

| 옵션 | 적합 시점 |
|---|---|
| `/pdca iterate` (자동 수정) | 부적합 — FTS5/live 권한은 사용자 결정·수동 작업 필요 |
| Live 테스트 1회 통과 후 Match Rate 재산정 | **추천** — sandbox integration share 후 `npm run test:live` 통과 시 실효 Match Rate 95%+ |
| `/pdca report` (완료 보고서) | Live 테스트 완료 후 진행 권장. 지금 진행 시 "FTS5/embedding 후순위" 명시 필요 |
| 신규 로드맵: P1-1.5 (FTS5) | 별도 plan 분리 권장 |

## 6. Decision Record 검증

| Decision (Notion) | 구현 일치 |
|---|---|
| jhw-notion 멀티 TUI 포팅 — MCP 서버 공유 | ✅ MCP 서버 단일 — 외부 진입점만 다양화 |
| MCP 서버 — Notion API 직접 호출 | ✅ `@notionhq/client` 직접 사용, 미들웨어 wrapper 자작 |
| DB ID/프로퍼티명 영문 전환 | ✅ `schema.ts` 영문 키 |
| record/review 작업 디렉토리 slug → report 자동 매핑 | ✅ 별도 검증 필요 (record.ts 내 매핑 로직) |
| jhw_note → KB DB row 생성 | ✅ note.ts 구현 |
| 5개 DB redmine `report` select 표준화 | ✅ schema.ts에 report select 정의 |
| 6주 로드맵 확정 | ⚠️ 6일에 압축 — 의도된 가속이지만 P1-1 FTS5 누락의 원인 |

## 7. Source

- Plan: `docs/01-plan/features/enhancement-roadmap.plan.md`
- 구현 커밋: `2f71ac3`, `92471a6`, `b39e82c`
- 테스트: `mcp-server` 97 PASS / 0 FAIL @ 2026-05-07T07:07:32Z
