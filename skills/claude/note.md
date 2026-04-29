---
description: Knowledge Base DB에 기술 지식이나 발견 사항을 빠르게 메모
---

# /jhw:note — Knowledge Base 빠른 메모

1. 메모 내용을 파악한다:
   - 인자로 내용이 제공된 경우 → 그대로 사용
   - 인자가 없는 경우 → "무엇을 기록할까요?" 질문

2. 제목과 내용을 구성한다. 가능하면 다음도 함께:
   - `summary` — 한줄 요약 (KB DB 테이블에서 보임)
   - `category` — KB DB의 select 옵션 중 하나: `아키텍처`, `문제해결`, `베스트프랙티스`, `드라이버`, `빌드`, `디버깅`, `인프라`, `기타`
   - `tags` — `iMX93,BSP` 같은 comma-separated
   - `project` — 프로젝트 키워드 (자동으로 projects DB 검색해 relation 연결)
   - `report` — 보고 분류 (기본 권장값: `none`, 개인 메모이므로). 작업 cwd 기반 자동 추론은 `/jhw:record` 매핑표 참조.

3. 미리보기를 보여주고 승인을 받는다 (**`category`/`report` 항상 표시**):
   ```
   📝 Knowledge Base 메모
   ─────────────────────
   제목:     [키워드]
   요약:     [한줄 요약]
   category: 문제해결
   report:   none ← 개인 메모 기본값
   project:  [있으면 표시]
   tags:     [있으면 표시]
   내용:     [내용 미리보기]
   ─────────────────────
   저장할까요?
   ```

4. 승인 후 `jhw_note` MCP 도구를 호출한다.

5. 결과 URL을 반환한다.

## Decision Log과의 차이

- **Decision Log** (`/jhw:record db=decisionLog`): A vs B 중 선택한 **결정** (근거, 대안 포함)
- **Knowledge Base** (`/jhw:note`): 발견한 **사실/지식** (결정이 아닌 정보)

## 규칙

- 반드시 사용자 승인 후에만 저장한다.
- 중복 체크: 동일 제목의 메모가 있으면 안내한다.
- **report 기본값**: 개인 메모/순수 학습은 `none` (보고 제외). 업무 관련 학습이면 cwd 추론 또는 사용자 입력.
- KB는 DB이므로 `notion-create-pages` 직접 호출 시 `parent`는 `database_id`. `category`는 위 8개 옵션 중 하나만 허용.
