---
description: 일/주/월 업무 보고서 — preview(미리보기) → export(redmine/markdown/json, 선택적 저장)
argument-hint: "[week|month] [--start YYYY-MM-DD --end YYYY-MM-DD] [--report <값>...] [--db <db>...] [--by db] [--include-none]"
---

# /jhw:report — 업무 보고서 (preview → export)

5개 DB의 `report` 분류 필드를 기간별로 모아 redmine/markdown 보고서를 만든다.
**2단계**: `jhw_report_preview`로 미리보기 → 사용자 승인 → `jhw_report_export`로 출력(+선택 저장).

## 사용

- `/jhw:report` — 이번 주(week) 보고서 미리보기
- `/jhw:report month` — 최근 30일
- `/jhw:report --start 2026-06-01 --end 2026-06-15` — custom 기간
- `/jhw:report --report pim-driver-cam pim-app` — 특정 report 값만 집계
- `/jhw:report --db decisionLog knowledgeBase` — 특정 DB만
- `/jhw:report --by db` — DB별 그룹화 (기본: report별)

## 흐름

1. **인자 파싱 → period 결정**
   - 무인자/`week` → `period: "week"` (최근 7일)
   - `month` → `period: "month"` (최근 30일)
   - `--start`/`--end` 둘 다 있으면 `period: "custom"` (start/end 필수)
   - `--report <값>...` → `reports` 필터, `--db <db>...` → `dbs` 필터, `--by db` → `groupBy: "db"`, `--include-none` → `includeNone: true`

2. **미리보기** — `jhw_report_preview` 호출 (period/start/end/reports/dbs/groupBy/includeNone).
   - 반환된 `redmineText`(기본 표시) 또는 `markdownText`를 보여준다.
   - `stats` 요약: `scanned`=처리 건수(`included`와 동일값). `excludedNone`은 응답에 항상 포함되나 기본(none 제외)에서는 **항상 0**이고, `--include-none`일 때만 실제 제외 수를 뜻한다.

3. **승인 + 출력 옵션 확인**
   - "OK" / "내보내기" → export 진행. 형식 기본 `redmine`. "markdown" / "json"으로 변경 가능.
   - **저장하려면** "저장"(또는 "KB 저장" / "결정 저장") → `writeBack.enabled=true` (기본 `db: knowledgeBase`, "결정 저장"이면 `decisionLog`).
   - "취소" → 아무 작업 안 함.

4. **export** — `jhw_report_export` 호출 (**preview와 동일 인자 + `format` + `writeBack`**).
   - preview 직후면 공유 캐시(5분 TTL) 히트로 Notion 재조회가 없다 — 인자를 그대로 유지할 것.
   - `writeBack` 시 생성된 페이지의 URL을 보고하고, **저장본은 2000자 요약**(전문 아님 — 전문은 응답 `text`)임을 함께 알린다.

5. **결과 보고** — 기간 / 형식 / (저장 시) 저장 페이지 URL.

## 규칙

- `report=none` 항목은 기본 **제외**. 포함하려면 `--include-none`.
- preview는 **조회 전용**(저장 없음). 실제 저장은 export의 `writeBack`에서만 일어난다 — 파괴적이지 않으나 저장 전 승인 1회.
- **writeBack 본문은 2000자로 절단**된다(Notion 단일 paragraph 한도). 긴 보고서 전문은 export 응답의 `text`로 확인하고, 저장본은 요약 성격임을 인지.
- preview→export는 **같은 인자**를 유지해야 캐시가 재사용된다(period/reports/dbs/groupBy/includeNone 일치 — format/writeBack은 캐시 키와 무관).
- 캐시 강제 우회는 preview의 `useCache=false`로만 가능(export에는 캐시 우회 옵션 없음).

## 참고

- `report` 분류값 자동 추론(cwd 슬러그/도메인)은 `/jhw:save`·`/jhw:review`의 §report. **이 스킬은 그 값으로 기간 집계만** 한다(분류 자체를 바꾸지 않음).
- 백엔드: `jhw_report_preview` / `jhw_report_export` (`mcp-server/src/tools/report-preview.ts`, `report-export.ts`).
