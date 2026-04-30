---
description: Notion AI Workspace에 정보를 즉시 저장 (record + note + delete 통합)
argument-hint: "[--db <db>] [--delete <id>] [--hard] [내용]"
---

# /jhw:save — Notion 통합 저장

확정된 정보를 Notion에 한 번에 저장한다. DB는 자동 판별.

## DB 자동 판별

| 입력 유형 | 대상 DB | 호출 도구 |
|---|---|---|
| 기술 결정 (A vs B, 도구 변경) | decisionLog | jhw_record |
| AI 사용 선호도/피드백 | preferences | jhw_record |
| 프로젝트 등록/상태 변경 | projects | jhw_record |
| 외부 참조 문서 (URL/가이드) | references | jhw_record |
| 기술 지식/팁/메모 | knowledgeBase | jhw_note |

## 사용

- `/jhw:save <내용>` — 자동 판별 후 저장
- `/jhw:save --db decisionLog <내용>` — DB 강제
- `/jhw:save --delete <pageId>` — archive 처리 (이력 보존)
- `/jhw:save --delete <pageId> --hard` — 완전 삭제

## report 자동 추론

작업 디렉토리(`pwd`) 슬러그 → report 매핑:

| 슬러그 | report |
|---|---|
| `pim-check` / `pim-test*` | pim-test |
| `pim-app*` | pim-app |
| `pim-driver-cam*` | pim-driver-cam |
| `pim-driver-spi*` | pim-driver-spi |
| `wlan-bsp*` | wlan-bsp |
| `wlan-app*` | wlan-app |
| `wlan-driver*` | wlan-driver |
| `wlan-test*` | wlan-test |
| 기타 매핑 미스 | etc |
| 개인 메모/note | none |

## 흐름

1. 입력 파싱 → DB / 제목 / properties / report / project 결정
2. project 자동 추론 (cwd 디렉토리명으로 projects DB 검색)
3. 미리보기 + 사용자 승인 (1회만)
4. 승인 직후 jhw_record / jhw_note / jhw_delete MCP 호출 — **중간 멈춤 없이**
5. 결과 URL 보고

## 규칙

- 중간 결과·미확정 정보·실패 시도는 저장하지 않는다.
- 승인 이후 응답을 끊지 않고 한 흐름으로 저장 → 결과 보고까지 진행.
- `--delete`는 기본 archive. `--hard`는 명시적일 때만.
