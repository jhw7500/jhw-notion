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
- `/jhw:save --delete <pageId>` — 폐기 처리 (jhw_delete `mode: archive` — status를 '폐기'로 변경; status 필드 없는 DB는 Notion 휴지통으로 이동)
- `/jhw:save --delete <pageId> --hard` — Notion 휴지통으로 이동 (jhw_delete `mode: delete` — `archived: true`)

## report 자동 추론

작업 디렉토리(`pwd`) 슬러그 → report 매핑:

| 슬러그 | report |
|---|---|
| `pim-check` / `pim-test*` | pim-test |
| `pim-app*` | pim-app |
| `pim-driver-cam*` | pim-driver-cam |
| `pim-driver-spi*` | pim-driver-spi |
| `wlan-package*` | wlan-app |
| `wlan-bsp*` | wlan-bsp |
| `wlan-app*` | wlan-app |
| `wlan-driver*` | wlan-driver |
| `wlan-test*` | wlan-test |
| `wlan-opc*` | wlan-app |
| 기타 매핑 미스 | etc |
| 개인 메모/note | none |

## 흐름

1. 입력 파싱 → DB / 제목 / properties / report / project 결정
2. project 자동 추론 (cwd 디렉토리명으로 projects DB 검색)
3. 미리보기 + 사용자 승인 (1회만)
4. **DB가 knowledgeBase면 §paragraph 분할 가드** 적용 후 본문 확정
5. 승인 직후 jhw_record / jhw_note / jhw_delete MCP 호출 — **중간 멈춤 없이**
6. 결과 URL 보고 (실패 시 §회복 로직)

## paragraph 분할 가드 (jhw_note 본문 2000자 한도)

`jhw_note`의 본문은 Notion paragraph 한 블록의 한도(**2000자**)에 걸린다. 한도를 넘으면 API가
`body.children[0].paragraph.rich_text[0].text.content.length should be ≤ 2000`으로 거절한다.

### 작성 규칙
- 한 paragraph(빈 줄 사이 연속 텍스트 블록) **≤ 1800자** (안전 마진 200자).
- 빈 줄(`\n\n`)이 paragraph 분리자 — 모든 `##`/`###` 헤딩 위·아래는 빈 줄.
- 코드 블록 ```` ``` ````, markdown 표, 긴 bullet 목록도 한 paragraph로 셈.

### 호출 직전 자동 검증
1. 본문을 `\n\n`로 split해 paragraph 배열 만들기.
2. 각 paragraph 길이 측정 (코드 펜스 포함).
3. 1800자 초과면 자동 분할 시도.

### 자동 분할 전략 (우선순위)
1. sub-heading 추가 → 2. 긴 목록을 그룹별로 분리 → 3. 긴 코드 블록을 의미 단위로 분할 → 4. 긴 표를 카테고리별로 분할 → 5. 자연 경계(`. `, `; `, 항목 끝)에 빈 줄 → 6. 분할 불가 단일 단위면 본문 단축.

### 회복 로직 (호출 실패 시)
같은 응답 안에서:
1. 에러의 `was N`으로 초과 paragraph 식별.
2. 분할 전략을 한 단계 더 강하게 적용 후 재호출.
3. 두 번째 실패면 본문을 두 KB 항목으로 분리해 각각 저장.

세부 절차/예시: `~/.claude/commands/jhw/review.md` §3.5 참조.

## 규칙

- 중간 결과·미확정 정보·실패 시도는 저장하지 않는다.
- 승인 이후 응답을 끊지 않고 한 흐름으로 저장 → 결과 보고까지 진행.
- `--delete`/`--hard` → MCP 매핑: `--delete`=`jhw_delete mode: archive`(status를 '폐기'로 변경), `--hard`=`jhw_delete mode: delete`(`archived: true`, Notion 휴지통 이동). **Notion API는 영구 삭제를 노출하지 않아 둘 다 30일 내 복구 가능** — '완전 삭제' 아님. `--hard`는 명시적일 때만.
