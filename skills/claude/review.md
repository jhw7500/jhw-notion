---
description: 세션 마무리 시 Notion 저장 후보 정리 및 승인 저장
---

# /jhw:review — 세션 마무리 리뷰

1. 현재 세션의 대화 내용을 분석하여 다음을 추출한다:
   - 새로운 기술 결정 (Decision Log 후보)
   - AI 사용 피드백/선호도 (Preferences 후보)
   - 프로젝트 상태 변경 (Projects 후보)
   - 새로운 참조 문서 (References 후보)
   - 기술 지식/팁 (Knowledge Base 후보 — `/jhw:note`로 처리)

2. **각 후보별로 `report` 자동 추론**: 작업 디렉토리 슬러그 → report 매핑 (`/jhw:record` 스킬 표 참조). 매칭 실패 시 표에서 비워두고 사용자가 일괄 입력 가능.

3. 추출된 항목을 테이블로 정리하여 보여준다 (**`report` 컬럼 포함**):
   ```
   📋 세션 리뷰 — Notion 저장 후보
   ─────────────────────────────────────────────────────────────
   #  DB              제목                       report        저장?
   1  Decision Log    libpcap → raw socket       wlan-test     ✅
   2  Preferences     한국어 응답 선호           etc           ✅
   3  Projects        wlan-bridge 상태→완료      wlan-app      ✅
   4  Knowledge Base  ESM .js 확장자 필수        none          ✅
   5  References      Notion API 가이드          etc           ✅
   ─────────────────────────────────────────────────────────────
   전체 저장? 또는:
     - 번호로 제외: "2번 빼"
     - report 일괄 변경: "3번 report=wlan-bsp"
     - 취소: "취소"
   ```

4. 사용자가 승인/수정한다:
   - "OK" / "전체 저장" → 전부 저장
   - "2번 빼" → 2번 제외하고 저장
   - "3번 report=wlan-bsp" → 3번의 report만 변경 후 저장
   - "취소" → 저장 안 함

5. 승인된 항목마다 `jhw_record` (또는 `jhw_note`) MCP 도구를 호출한다. `properties.report`는 반드시 포함한다.

6. 저장 결과 요약을 보여준다.

## 사용 시점

- 세션 종료 전
- 긴 작업 구간이 끝났을 때
- 사용자가 "기록할 거 있어?" 라고 물었을 때

## 규칙

- 저장 후보가 없으면 "이번 세션에서 저장할 항목이 없습니다"로 응답한다.
- 실패한 시도나 중간 과정은 후보에서 제외한다.
- 이미 저장된 항목은 중복 제안하지 않는다.
- **`report` 자동 추론 우선**, 매칭 실패는 표에 빈 값으로 남겨 사용자가 일괄 보충.
- 보고서에 노출 원치 않는 항목은 `report=none`으로 명시 (보고 제외).
