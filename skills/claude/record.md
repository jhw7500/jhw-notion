---
description: Notion AI Workspace에 확정된 정보를 즉시 저장
---

# /jhw:record — Notion 즉시 저장

1. 사용자 입력 또는 현재 컨텍스트에서 저장할 내용과 대상 DB를 파악한다.

2. DB 판별 기준:
   - 기술 결정 (A vs B 선택, 도구 변경 등) → db: "decisionLog"
   - AI 사용 선호도/피드백 → db: "preferences"
   - 프로젝트 등록/상태 변경 → db: "projects"
   - 참조 문서 → db: "references"
   - 기술 지식/사실/팁 → `/jhw:note` 사용을 안내

3. 미리보기를 보여주고 승인을 받는다:
   ```
   📝 Notion 저장 미리보기
   ─────────────────────
   DB: Decision Log
   제목: [제목]
   상태: 확정
   근거: [근거]
   ─────────────────────
   저장할까요?
   ```

4. 승인 후 `jhw_record` MCP 도구를 호출한다.

5. 결과 URL을 반환한다.

## 사용 예시

- `/jhw:record` — 직전 대화 컨텍스트에서 자동 판별
- `/jhw:record libpcap 대신 raw socket 선택` — 내용 직접 지정

## 규칙

- 중간 결과나 미확정 정보는 저장하지 않는다.
- 저장 전 반드시 사용자 승인을 받는다.
- 상태 필드는 기본값 "확정"으로 설정한다.
- `jhw_record` MCP 도구가 불가능하여 `notion-create-pages`를 직접 호출할 때, date 프로퍼티는 반드시 expanded 키를 사용한다: `"date:date:start":"YYYY-MM-DD"` (단순 `"date"` 키는 에러 발생).
