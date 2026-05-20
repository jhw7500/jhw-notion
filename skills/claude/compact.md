---
description: 저장된 Notion 레코드를 비슷한 것끼리 합치거나 긴 본문을 요약해 정리
argument-hint: "[--db <db>] [--report <report>] [--hard] [프로젝트명|키워드]"
---

# /jhw:compact — 저장 레코드 정리 (합치기 + 요약)

이미 저장된 Notion 레코드를 **비슷한 것끼리 합치고(N→1)**, 단독이지만 본문이 긴 레코드는 **요약**해서
누적된 저장 목록을 줄인다. `/jhw:review`로 여러 건 저장한 뒤 "저장이 너무 많다" 싶을 때 쓴다.

> **파괴적 작업**: 합치기는 합본을 새로 만들고 원본을 archive 한다. 반드시 미리보기 + 승인 후 실행.

## 사용

- `/jhw:compact` — cwd 프로젝트 추론 → 본문 누적 DB(knowledgeBase, references, decisionLog) 대상
- `/jhw:compact jhw-notion` — 특정 프로젝트 한정
- `/jhw:compact --db knowledgeBase` — DB 한정
- `/jhw:compact --report pim-driver-cam` — report 값으로 한정
- `/jhw:compact --db references jhw-notion` — 조합
- `/jhw:compact --hard ...` — 원본을 archive 대신 **완전 삭제** (위험, 명시적일 때만)

## 흐름

1. **범위 결정**: 인자 파싱 → DB / 프로젝트 / report 범위 확정.
   - 프로젝트 미지정 시 cwd 슬러그로 추론 (`save.md`의 report 추론 표 재사용).
   - DB 미지정 시 본문이 누적되는 DB(knowledgeBase, references, decisionLog)를 기본 범위로.

2. **레코드 수집**: 범위 키워드(프로젝트명/report/positional)로 `jhw_search` 호출.
   - 결과가 부족하면 `mcp__notion__notion-search`(`query_type: "internal"`)로 보완.
   - URL 기준 **중복 제거**.
   - 후보가 너무 많으면(40건 초과) 사용자에게 범위를 좁히도록(특정 DB/프로젝트) 제안한 뒤 진행.

3. **본문 로드**: 후보 페이지를 `mcp__notion__notion-fetch`로 **한 메시지에서 모두 병렬** 호출해 본문 확보
   (순차 호출 금지 — 전역 규칙).

4. **클러스터링 + 동작 판정** (`review.md` §3.1–3.4 합치기 규칙 재사용):
   - **합치기**: 같은 DB + 같은 도메인/스코프인 레코드가 **2개 이상**. 합쳐도 검색 시 함께 찾는 게 자연스럽고 한 항목으로 의미가 명확할 때.
   - **요약**: 단독 레코드인데 본문이 길거나(paragraph 합 ≳ 1800자) 장황할 때. 핵심 사실·수치·명령을 보존하며 축약.
   - **유지**: 단독·간결하면 변경하지 않음 (표에는 참고로만 표시).
   - **다른 DB는 절대 합치지 않는다** (`review.md` §3.1).
   - 의심스러우면 합치기보다 **유지**를 택한다 (정보 손실 방지).

5. **합본/요약 본문 작성**: `review.md` §3.5 paragraph 2000자 가드를 적용해 markdown 확정
   (빈 줄 = paragraph 분리자, 한 paragraph ≤ 1800자, 헤딩 위·아래 빈 줄).

6. **미리보기 표 + 승인**:
   ```
   🗜️ /jhw:compact — 저장 레코드 정리 후보
   범위: KnowledgeBase · 프로젝트 jhw-notion · 조회 N건
   ─────────────────────────────────────────────────────────────────────────
   #  동작    대상(원본)                          결과                     비고
   1  합치기  채널 설정 AWB/led_flash/매핑 (3건)  채널 설정 종합          3→1 · 원본 archive
   2  합치기  raw socket 송신/수신 정정 (2건)     raw socket 키 정정 종합 2→1 · 원본 archive
   3  요약    빌드 트러블슈팅 로그 (4200자)       제자리 요약 (~1500자)   본문만 축소
   4  유지    RTC DS1307 배선                     —                       단독·간결, 변경 없음
   ─────────────────────────────────────────────────────────────────────────
   조회 N건 → 정리 후 M건 (합치기 K · 요약 L · 유지 P) · 예상 archive Q건

   전체 실행? 또는:
     - 제외: "3번 빼"
     - 합치기 해제(개별 유지): "1번 분리해"
     - 동작 변경: "2번 요약으로" / "3번 합치기로"
     - 완전 삭제로(주의): "--hard"
     - 취소: "취소"
   ```

7. **승인 수신 후 연속 실행** (중간 멈춤 없이 — 전역 CLAUDE.md 규칙):
   - **합치기**: 합본 properties 병합(report/project/category/tags/url/summary) → `jhw_record`(또는 knowledgeBase면 `jhw_note`)로 `content` 포함 생성 → **생성 성공 확인** → 원본들 `jhw_delete(mode: archive)` (─ `--hard`면 `mode: delete`).
   - **요약**: 요약본을 `mcp__notion__notion-update-page`로 본문 제자리 교체 (page ID·properties 유지). 본문 블록 교체가 불가하면 합치기와 동일하게 create+archive로 fallback.
   - **유지**: 아무 작업 안 함.

8. **결과 보고**: 생성/갱신된 페이지 URL, archive 처리 건수, `조회 N건 → 최종 M건`.

## 승인 처리

- "OK" / "전체 실행" → 표대로 실행 (유지 항목 제외 전부)
- "3번 빼" → 3번 제외하고 실행
- "1번 분리해" → 1번 합치기를 취소하고 원본을 개별 유지로 전환, 표 갱신 후 재승인
- "2번 요약으로" / "3번 합치기로" → 해당 항목 동작 변경 후 표 갱신·재승인
- "--hard" → 이번 실행의 archive를 완전 삭제로 전환 (재확인 후)
- "취소" → 아무것도 하지 않음

## 규칙

- **파괴적 작업 — 승인 필수.** 미리보기 없이 자동 실행하지 않는다.
- **다른 DB는 절대 합치지 않는다** (`review.md` §3.1).
- 원본은 **archive 기본** (이력 보존). `--hard`만 완전 삭제.
- **합본 생성 성공을 확인한 뒤에만 원본을 archive** 한다. 생성 실패 시 원본을 그대로 두어 데이터 유실을 막는다.
- properties 승계: 합칠 레코드들의 `report`/`project`가 다르면 표에 ⚠️로 표시하고 사용자에게 확인. 임의 통합 금지.
- **paragraph 2000자 가드**(`review.md` §3.5) 적용. 합본이 한도를 넘으면 분할하거나, 분할 불가하면 그 클러스터는 합치기를 포기하고 유지.
- 요약은 핵심 사실·수치·명령·경로를 보존한다. 불확실하면 요약하지 말고 유지.
- 후보가 0건이거나 정리할 게 없으면 "정리할 항목이 없습니다"로 응답한다.
- 병렬 필수: 본문 로드(`notion-fetch`)는 한 메시지에서 모두 병렬 호출.

## 사용 시점

- `/jhw:review`로 여러 건 저장한 뒤 같은 주제가 흩어져 보일 때
- 특정 프로젝트/report의 Knowledge Base·References가 비대해졌을 때
- 주기적 워크스페이스 정리 (월말 등)

## 참고

- 저장 시점의 합치기/평가는 `/jhw:review` (§3 합치기, §3.6 저장가치 평가). `compact`는 **이미 저장된** 레코드를 사후 정리.
- 단건 삭제/폐기는 `/jhw:save --delete <id>`.
