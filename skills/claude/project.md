---
description: 프로젝트 라이프사이클 통합 (start + close)
argument-hint: "(--start | --close) [프로젝트명]"
---

# /jhw:project — 프로젝트 시작/종료 통합

## 사용

- `/jhw:project --start <name>` — 새 프로젝트 시작 (원스톱)
- `/jhw:project --close [name]` — 프로젝트 종료 + 회고
- `/jhw:project` (인자 없음) — 진행중 프로젝트 목록 + 선택

## --start 흐름

1. 정보 수집:
   - 프로젝트명 (필수)
   - 레포 경로 (선택)
   - 기술 스택 (선택, comma-separated)
   - 한 줄 설명 (필수)
2. 동일명 존재 검사 (jhw_search) — 있으면 경고 + 확인
3. 미리보기 + 승인
4. jhw_start MCP 호출 → Projects DB + Decision Log "프로젝트 시작" + 페이지 템플릿(목표/범위/제약/메모)
5. 결과 URL 보고

## --close 흐름

1. 종료할 프로젝트 식별:
   - 인자가 있으면 그대로
   - 없으면 jhw_status로 진행중 목록 표시 후 선택
2. 회고 인터뷰:
   - "이 프로젝트에서 뭘 달성했나요?"
   - "배운 점이나 다음에 다르게 할 것이 있나요?"
   - 둘 다 "건너뛰기" 가능 (상태만 완료로 변경)
3. 미리보기 + 승인
4. jhw_close MCP 호출 → 상태 완료 + end_date + 회고 섹션 추가 + KB 등록(있으면)
5. 결과 보고

## paragraph 분할 가드 (페이지 본문 / KB 등록 시)

`--start` 템플릿(목표/범위/제약/메모)과 `--close` 회고·KB 본문도 `\n\n`로 paragraph를 나눠 작성한다(헤딩 위·아래 빈 줄, 한 paragraph ≤ 1800자).

**주의: `jhw_start`/`jhw_close`는 본문을 단일 rich_text로 넣어 `jhw_record`/`jhw_note`와 달리 MCP 자동 분할이 없다** — 2000자에 근접하면 호출 전 반드시 `\n\n`로 나눠 둔다. 상세 분할 전략·회복 절차는 `review.md` §3.5(단일 정본) 참조. 회고 KB 본문에서 자주 발생.

## 규칙

- 이미 완료 상태인 프로젝트 --close 시 "이미 종료됨" 안내.
- 회고는 선택. 빈 회고는 KB 등록을 생략.
- 승인 이후 한 흐름으로 진행 — 중간 멈춤 없음.
