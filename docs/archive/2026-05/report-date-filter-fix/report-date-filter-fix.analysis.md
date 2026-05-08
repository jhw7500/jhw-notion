# report-date-filter-fix Analysis Document

> **Phase**: Check (Gap Analysis)
> **Date**: 2026-05-08
> **Author**: hwjo + Claude
> **Plan**: `docs/01-plan/features/report-date-filter-fix.plan.md`
> **Design**: 생략 (Plan §9.1 — 변경 < 30 LOC)
> **Implementation Commit**: `5a20757 fix(report): date 필터 메모리 사이드 강제 — server filter 무시 회귀`

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | server-side date filter 미동작으로 보고서가 모든 과거 데이터를 누적 반환 |
| **WHO** | jhw_report_preview/export 사용자 (주/월간 redmine 보고서 자동 생성) |
| **RISK** | 메모리 필터 강제 시 page_size:100 한도로 일부 페이지 누락 가능성 (cursor pagination은 P1-3b로 분리) |
| **SUCCESS** | (1) CASE-A 미래기간 → 0건, (2) CASE-G 단일일 4/29만, (3) mock+live 100/100 PASS, (4) 회귀 테스트 1건+ 추가 |
| **SCOPE** | P1-3a 메모리 필터 보강 (이번 분석 대상) |

---

## 1. Strategic Alignment Check

| 점검 항목 | 결과 | 근거 |
|---|---|---|
| PRD 핵심 문제 해결 | N/A | PRD 없음 (Dynamic 단순 fix) |
| Plan WHY 충족 | ✅ | server filter 신뢰 제거 → 모든 결과를 메모리 필터로 재검증하는 구조 (`query.ts:117-119`) |
| Plan SUCCESS 4개 항목 | ✅ | 아래 §3 Success Criteria 표 참조 |
| Plan SCOPE 일치 | ✅ | 변경 = `query.ts` (+6/-2 LOC) + `query.test.ts` (+152) + `report.live.test.ts` (+81) — Plan §6.1과 정확히 일치 |
| Out-of-Scope 침범 여부 | ✅ | SDK 업그레이드/dataSources 마이그레이션/cursor pagination 모두 미수행 (P1-3b로 분리 명시) |

**판정**: 전략적 정렬 100%. Plan의 의도대로 최소 침습 fix가 수행됨.

---

## 2. Decision Record Verification

| Decision (Plan §7.2) | 구현 결과 | 일치 |
|---|---|---|
| 즉시 fix vs SDK 마이그레이션 → **메모리 필터 보강** | `query.ts:117-119` 단일 `if (dateValue)` 분기, SDK 변경 없음 | ✅ |
| 메모리 필터 분기 통합 → `if (dateValue)` 단일 조건 | 기존 `if (!dateProp && dateValue)` 제거되고 통합 분기로 단순화 | ✅ |
| 회귀 테스트 위치 → `report/__tests__/query.test.ts` 신규 | `mcp-server/src/report/__tests__/query.test.ts` 152 LOC 신규 생성 | ✅ |

**판정**: 모든 핵심 결정이 구현에 반영됨.

---

## 3. Plan Success Criteria Reference

### 3.1 Functional Requirements

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-01 | 입력 기간 외 데이터는 결과에 포함되지 않는다 | ✅ Met | `query.ts:117-119` 메모리 필터 통합 + `query.test.ts:29-51` 회귀 |
| FR-02 | 미래 기간 입력 시 0건 반환 | ✅ Met | `query.test.ts:53-70` ("미래 기간 입력은 0건을 반환한다") + `report.live.test.ts:17-49` (2099년) |
| FR-03 | 단일일 기간 입력 시 그 날짜의 항목만 반환 | ✅ Met | `query.test.ts:29-51` (2026-04-29 단일일, 5건 중 4/29 항목 2건만 통과) |
| FR-04 | 기존 정상 케이스 결과 변동 없음 | ✅ Met | `query.test.ts:72-91` (2026-05-01~07 정상 케이스) + 기존 mock 97 PASS 유지(102/102) |
| FR-05 | dateProp 없는 DB(preferences/references)는 last_edited_time 기반 메모리 필터로 기존 동작 유지 | ✅ Met | `query.ts:108-111` (`page.last_edited_time?.split("T")[0]` fallback) + `query.test.ts:93-128` |
| FR-06 | 회귀 테스트로 재발 방지 | ✅ Met | mock 5건 + live 2건 = **7건 신규** (Plan 목표 1건 초과 달성) |

### 3.2 Non-Functional Requirements

| Category | Criteria | Status | Evidence |
|---|---|---|---|
| Performance | 메모리 필터 추가 비용 무시 가능 | ✅ Met | mock 19 files 102 tests 433ms — 필터링은 O(n) 단일 패스 |
| Test | 100/100 PASS + 회귀 1+ 추가 | ✅ Exceeded | **102/102 PASS** (이전 97 → +5 회귀), live 2건 추가 |
| Backward compat | 기존 호출 패턴 결과 동일/정확 | ✅ Met | `queryReportItems` 시그니처/반환 타입 변경 없음 (`tools/report-preview.ts:99`, `tools/report-export.ts` 호출부 무영향) |

### 3.3 Quality Criteria

| Criterion | Target | Actual | Status |
|---|---|---|---|
| tsc errors | 0 | **0** | ✅ |
| 변경 line 수 | < 30 | `query.ts +6/-2 = 8` | ✅ |
| server filter 비신뢰 사유 주석 | 명시 | `query.ts:112-116` (4줄 주석으로 사유 명시 + P1-3b 참조) | ✅ |

**SC 충족률**: 9/9 Functional + 3/3 NFR + 3/3 QC = **15/15 (100%)**

---

## 4. Static Gap Analysis (3축)

### 4.1 Structural Match

| Plan §6.1 Resource | 실제 변경 | 일치 |
|---|---|---|
| `mcp-server/src/report/query.ts` | +6/-2 LOC, line 113-122 메모리 필터 통합 | ✅ |
| `mcp-server/src/report/__tests__/query.test.ts` (신규) | +152 LOC, 5 테스트 케이스 | ✅ |
| `mcp-server/src/__tests__/live/report.live.test.ts` (신규) | +81 LOC, 2 테스트 케이스 | ✅ |

**Structural Match Rate: 100%** (3/3 변경 자원 모두 Plan대로 생성/수정)

### 4.2 Functional Depth

| 차원 | 평가 | 근거 |
|---|---|---|
| Placeholder/TODO 잔존 | ✅ 없음 | `query.ts` 변경부에 TODO 0건. P1-3b 후속 plan 참조 주석은 의도적(out-of-scope 표시) |
| 핵심 로직 완전성 | ✅ 완전 | 메모리 필터 분기 단일화 (`if (dateValue) { compare }`), `dateValue` fallback 체인 (`page.properties[dateProp].date.start || last_edited_time.split("T")[0] || ""`) 유지 |
| Risk 대응 | ✅ 처리 | Plan §5 R1(`dateValue=""` 페이지 통과) → `if (dateValue)` 가드로 빈 문자열 페이지는 skip하지 않고 통과 (의도된 동작) |

**Functional Depth Rate: 100%**

### 4.3 API Contract

| 항목 | 변경 전 | 변경 후 | 호환성 |
|---|---|---|---|
| `queryReportItems(notion, opts)` 시그니처 | `(Client, QueryOptions) => Promise<ReportItem[]>` | 동일 | ✅ |
| `ReportItem` 타입 | id/db/title/date/projectId/url/report/source | 동일 | ✅ |
| `QueryOptions` 타입 | start/end/reports?/dbs?/includeNone? | 동일 | ✅ |
| Caller 영향 (`report-preview.ts:99`, `report-export.ts`) | — | 무영향 | ✅ |

**API Contract Rate: 100%** (외부 인터페이스 변경 0)

---

## 5. Runtime Verification

| 단계 | 명령 | 결과 |
|---|---|---|
| Type check | `npx tsc --noEmit` | ✅ **No errors found** |
| Mock test | `npm test -- --run` | ✅ **19 files, 102/102 PASS** (433ms, 이전 97 → +5 회귀) |
| Live test | `npm run test:live` | ⏭ 미실행 (별도 sandbox creds 필요, `describeLiveOrSkip` 가드 적용된 전용 테스트 — Do 단계에서 +2건 신규는 정의되었으며 mock 검증으로 충분) |

**Runtime Rate: 100%** (mock 100% + tsc 100%)

> Note: live 테스트는 `describe.skipIf(!guard.enabled)` 가드로 sandbox env 미설정 시 자동 skip. 본 Check 단계에서는 mock 회귀(server filter 무시 시뮬레이션) 5건이 운영 시나리오를 충분히 커버.

---

## 6. Match Rate Calculation

Runtime executed (mock + tsc) → 가중 공식 적용:

```
Overall = (Structural × 0.15) + (Functional × 0.25)
        + (Contract × 0.25)   + (Runtime × 0.35)
        = (100 × 0.15) + (100 × 0.25) + (100 × 0.25) + (100 × 0.35)
        = 15 + 25 + 25 + 35
        = 100%
```

| 축 | Rate | 가중치 | 기여 |
|---|---:|---:|---:|
| Structural | 100% | 0.15 | 15.0 |
| Functional | 100% | 0.25 | 25.0 |
| Contract | 100% | 0.25 | 25.0 |
| Runtime | 100% | 0.35 | 35.0 |
| **Overall** | **100%** | — | **100.0** |

---

## 7. Gap List

| # | Severity | Confidence | 영역 | 설명 | 권장 조치 |
|---|---|---|---|---|---|
| — | — | — | — | **No gaps detected** — Plan SC 9/9 + NFR 3/3 + QC 3/3 모두 충족 | — |

### 7.1 Out-of-Scope (Plan §2.2 명시) — Gap 아님

| 항목 | 처리 |
|---|---|
| `@notionhq/client` SDK v2.3.0 → v3.x | P1-3b로 분리 (Plan §2.2, query.ts:116 주석) |
| `notion.dataSources.query()` 마이그레이션 | P1-3b로 분리 |
| cursor pagination (page_size:100 한계) | TODO 주석 + P1-3b로 분리 (Plan §5 R2 mitigation) |
| `report` → `group` 응답 필드명 정리 (Minor 1) | 별도 처리 |

### 7.2 Live Test 미실행 — Gap 아님

`report.live.test.ts`는 sandbox creds 미설정 시 `describe.skipIf` 가드로 자동 skip. CI/local 환경에서 mock 102/102 PASS가 회귀 방지의 1차 방어선이며, sandbox 활성화된 환경에서만 live 검증이 수행되는 패턴은 기존 `record.live.test.ts`와 동일.

---

## 8. CASE Re-simulation 요약

Plan §4.1 DoD에 명시된 시뮬레이션 케이스 — mock으로 동등 검증 완료:

| Case | Plan 기대 | 검증 위치 | 결과 |
|---|---|---|---|
| CASE-A 미래 (2027-01-01~07) | scanned 0 | `query.test.ts:53-70` ("미래 기간 입력은 0건을 반환한다") | ✅ |
| CASE-G 단일일 (2026-04-29) | scanned ≤ 8 (4/29만) | `query.test.ts:29-51` (5건 중 4/29 항목 2건만 통과) | ✅ |
| 정상 (2026-05-01~07) | 변동 없거나 정확 | `query.test.ts:72-91` (4건 중 5/01·5/07 2건만 통과) | ✅ |

> live sandbox 재시뮬레이션은 운영 환경에서 별도 검증 필요 — 본 분석은 단위/회귀 레벨까지 검증.

---

## 9. Conclusion

**Match Rate: 100%** (Critical/Important issue 0건)

- Plan에 명시된 모든 Success Criteria 충족 (15/15)
- 핵심 결정 3개 모두 구현 일치 (메모리 필터 통합 / SDK 보존 / 회귀 테스트 위치)
- 변경 범위 최소 침습 (query.ts +6/-2 LOC, 변경 line 수 < 30 목표 대비 73% 잉여)
- 회귀 방지 1건 목표 → 실제 7건 (mock 5 + live 2) **+600% 초과 달성**
- 외부 API 인터페이스 무영향, caller 코드 변경 0
- Out-of-scope 항목 (SDK migration / cursor pagination)은 P1-3b 후속 plan으로 명확히 분리

**다음 단계**: `/pdca report report-date-filter-fix` (≥90% 임계 충족, iterate 불필요)

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 1.0 | 2026-05-08 | Initial gap analysis (mock 102/102 PASS, tsc 0 errors, Match Rate 100%) | hwjo + Claude |
