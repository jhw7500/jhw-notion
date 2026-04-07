---
description: Notion AI Workspace 현황 조회
---

# /jhw:status — Notion 워크스페이스 현황

1. `jhw_status` MCP 도구를 호출한다.
   - 인자가 있으면 특정 DB만: `/jhw:status projects`

2. 결과를 테이블로 보여준다:
   ```
   📊 Notion AI Workspace 현황
   ─────────────────────────────────────
   DB              레코드   최근 항목
   projects        3       wlan-bridge (진행중)
   preferences     5       Notion 저장 규칙
   decisionLog     4       파일→Notion 마이그레이션
   ─────────────────────────────────────
   ```

3. 선택적으로 상세 조회를 제안한다.

## 사용 예시

- `/jhw:status` — 전체 현황
- `/jhw:status projects` — Projects DB만

## 규칙

- 조회 전용 — 데이터를 수정하지 않는다.
