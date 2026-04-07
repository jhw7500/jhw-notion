---
description: Notion AI Workspace 전체를 키워드로 통합 검색
---

# /jhw:search — Notion 통합 검색

1. 사용자가 제공한 키워드로 `jhw_search` MCP 도구를 호출한다.

2. 결과를 출처별로 그룹화하여 보여준다:
   ```
   🔍 검색: "raw socket"
   ─────────────────────────────
   [decisionLog] libpcap → raw socket 전환 (2026-04-05)
   [projects] wlan-bridge TPACKET_V3 최적화 (진행중)
   ─────────────────────────────
   총 2건. 번호로 상세 보기 가능.
   ```

3. 사용자가 번호를 선택하면 해당 페이지 상세 정보를 보여준다.

## 사용 예시

- `/jhw:search raw socket` — 키워드 검색
- `/jhw:search VLAN` — 관련 결정/프로젝트/문서 찾기

## 규칙

- 결과가 없으면 "검색 결과 없음"으로 응답한다.
- 조회 전용 — 데이터를 수정하지 않는다.
