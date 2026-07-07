---
description: "신규 내용을 기존 Notion과 대조(중복/보강/유사) · --from-review 직전 review 후보 · --db 대상DB · --report 대상보고서"
argument-hint: "[--from-review] [--db <db>] [--report <report>] [내용 또는 키워드]"
---

# /jhw:match — 기존 Notion 대조 (Match)

신규 후보(텍스트·카드·키워드)를 기존 Notion 레코드와 의미적으로 대조해, **중복은 skip / 보강은 기존 페이지에 append / 유사·신규는 별도 저장**으로 정리한다.

- `/jhw:review` = 세션 후보 추출·저장 (대조 없음, 빠른 흐름).
- **`/jhw:review --match` = 세션 후보를 저장 전에 본 스킬 verdict로 대조하는 통합 흐름** (review 추출 + match 대조 한 번에, 승인 1회).
- `/jhw:compact` = 기존 ↔ 기존 정리.
- **`/jhw:match` = 신규 ↔ 기존 정리** (저장 전 옵트인 점검, 또는 저장 후 사후 보강).

## 사용

- `/jhw:match "edgeconf 채널 설정"` — 키워드로 기존 Notion 대조 + 카드
- `/jhw:match --from-review` — 직전 `/jhw:review` 후보 카드를 **명시적으로 강제** 사용 (무인자 자동감지와 결과는 같지만, 의도를 분명히 하거나 자동감지가 빗나갈 때 사용)
- `/jhw:match --db knowledgeBase "AWB 매핑"` — DB 한정
- `/jhw:match --report pim-driver-cam "..."` — report 필터
- `/jhw:match` — 인자 없으면: 대화에서 **가장 마지막** `/jhw:review` 후보 카드가 있고 그 이후 새 저장/대조가 없었으면 그것을 입력으로 사용(= `--from-review` 자동), 없거나 stale하면 "어떤 내용을 대조할까요?" 묻고 진행

## 흐름

1. **입력 파싱**
   - `--from-review`: 대화 컨텍스트에서 직전 `/jhw:review`의 카드 후보(번호·DB·제목·본문) 추출.
   - **인자 없음**: 대화에서 **가장 마지막** `/jhw:review` 후보 카드를 찾아 `--from-review`로 간주해 자동 추출한다. 단 그 review 이후 새 저장/대조가 끼어들었거나(stale) 후보 카드를 못 찾으면 "어떤 내용을 대조할까요?"로 되묻고 진행. (review 직후 대조가 가장 흔한 사용 패턴이라 무인자에서 이를 기본 동작으로 둔 것 — `--from-review` 플래그 자체의 기본 의미가 바뀐 건 아님.)
   - 키워드/본문 텍스트: 그대로 사용.
   - DB 미지정 시 입력 유형 자동 판별 (knowledgeBase 기본, --db로 명시).

2. **핵심어 추출** (후보별 2~3개)
   - 제목에서 명사·고유명사·기술 용어 우선.
   - 본문 첫 paragraph에서 보강.
   - 흔한 단어("정리", "메모", "지식", "참고")는 제외.

3. **1단계 — 키워드 검색** (병렬)
   - 후보마다 `mcp__jhw-notion__jhw_search`를 **한 메시지 안에서 병렬 호출**.
   - `jhw_search`를 `db=<후보 DB>`로 호출한다 — 서버가 전역 검색을 **페이지네이션(최대 500건 스캔)** 하며 해당 DB 결과만 수집해 반환하므로, 전역 top-10 한계 없이 동일 DB 매칭을 안정적으로 찾는다 (KB 후보는 `db=knowledgeBase`, References 후보는 `db=references` 등). 스캔 상한을 넘겨 잔여가 있으면 응답에 `truncated:true`가 온다.
   - top-5 결과 수집. report·project 필터는 걸지 않는다 (다른 report로 잘못 저장된 중복도 잡기 위함).
   - 결과 0건 **그리고 `truncated:false`** 면 그 후보는 **NEW**로 확정 (이후 단계 건너뜀). **0건이어도 `truncated:true`면 확정 NEW 금지** — 스캔이 잘렸으니 키워드를 좁혀 재검색하거나 SIMILAR(불확실)로 보수 처리한다.

4. **2단계 — 본문 fetch** (병렬)
   - ≥1건 매칭된 후보들에 대해 top-5 페이지 본문을 `mcp__notion__notion-fetch`로 **한 메시지 안에서 모두 병렬** 호출.
   - 동일 URL이 여러 후보의 매칭에 등장하면 한 번만 fetch (중복 호출 방지).

5. **LLM 의미적 판정** — verdict 부여 (§verdict).

6. **카드형 미리보기 + 승인** (§미리보기).

7. **액션 분기**
   - NEW/SIMILAR → 신규 저장 (`jhw_record`/`jhw_note`). SIMILAR는 본문 하단에 `(참고: <매칭된 유사 페이지 URL>)`를 남겨 관련성을 표시한다. projects(완료)/decisionLog(확정)면 `impact`(성과 한 줄)+`achievement:true`도 함께 저장(사실·수치 기반, 애매하면 생략).
   - AUGMENT → 기존 페이지에 `### YYYY-MM-DD 보강` append (§AUGMENT 절차)
   - DUPLICATE → skip

## verdict (4-tier)

| Verdict | 기준 | 동작 |
|---|---|---|
| **NEW** | 매칭 결과 없거나 모두 무관 | 신규 생성 |
| **SIMILAR** | 같은 카테고리지만 서로 독립 검색이 자연스러움 | 신규 생성 + 참고 표시 |
| **AUGMENT** | 같은 주제 + 새 정보(후속 수치/새 사례/정정) | 기존 페이지 본문에 append |
| **DUPLICATE** | 같은 사실·수치·명령이 ≥80% 겹침 | skip |

판정 가이드:
- 단순 키워드 중복이 아닌 **의미적 중복**을 본다. 같은 단어라도 다른 맥락이면 SIMILAR.
- AUGMENT는 기존 본문에 정보가 추가되는 게 자연스러운 경우만. 본문 구조가 크게 다르면 SIMILAR로.
- DUPLICATE 판정에 확신이 없으면 **SIMILAR로 보수적으로 떨어뜨린다** (의도치 않은 skip이 정보 손실보다 나쁨).

판정 결과 구조:
```
{ verdict: NEW | SIMILAR | AUGMENT | DUPLICATE,
  target_url: <기존 페이지 URL — SIMILAR/AUGMENT/DUPLICATE일 때>,
  reason: <한 줄 사유> }
```

## 미리보기 카드

```
🔍 /jhw:match — 기존 Notion 대조 결과
입력: <키워드 또는 --from-review N개 후보>  ·  DB: <범위>  ·  조회 K건

[1] ✅ NEW       Knowledge Base  ·  pim-driver-cam
    제목: edgeconf 채널 설정 종합
    (매칭 없음)

[2] ↻ AUGMENT   Knowledge Base  ·  pim-driver-cam
    제목: AWB 매핑 추가 사례
    target: https://www.notion.so/...  (기존 채널 노트에 새 사례 append)

[3] ✅ SIMILAR  References  ·  pim-driver-cam
    제목: 설정 가이드 + release note 보강
    target: https://www.notion.so/...  (관련 가이드 별개 항목)

[4] ❌ DUPLICATE Knowledge Base  ·  etc
    제목: Notion paragraph 2000자 제한
    target: https://www.notion.so/...  (동일 수치·동일 회복 절차)

──────────────────────────────────────────────
총 N개 · NEW p / SIMILAR q / AUGMENT r / DUPLICATE s
기본 처리: NEW/SIMILAR=신규, AUGMENT=append, DUPLICATE=skip

전체 실행? 또는:
  - "N번 신규"  → verdict를 NEW로 강제 (target_url 무시, 신규 생성)
  - "N번 중복"  → DUPLICATE 강제 → skip
  - "N번 보강"  → AUGMENT 강제 (LLM 제시 target_url 사용)
  - "N번 보강=<URL>" → AUGMENT + target_url 지정
  - "N번 참고"  → SIMILAR 강제 (신규 + 참고 표시)
  - "N번 빼"    → 제외
  - "취소"      → 아무 작업 없음
```

## 승인 처리

- "OK" / "전체 실행" → verdict 그대로 실행 (NEW/SIMILAR=신규, AUGMENT=append, DUPLICATE=skip)
- "N번 신규/중복/보강/참고/빼" → 개별 verdict 변경 후 실행
- "N번 보강=<URL>" → AUGMENT + target_url 지정
- "취소" → 아무 작업 없음

**AUGMENT 항목에 target_url이 비어 있으면 그냥 "OK"로 넘기지 말고**, "N번 보강 대상 URL을 알려주세요" 또는 "N번 신규로 전환할까요?"로 한 번 더 확인한다. 임의 신규 전환 금지.

## AUGMENT 절차

target_url의 기존 페이지 본문 끝에 `### YYYY-MM-DD 보강` 헤딩 + 새 본문을 덧붙인다.

1. `mcp__notion__notion-fetch`로 target_url 본문 markdown 확보.
2. 본문 끝에 `\n\n### YYYY-MM-DD 보강\n\n<신규 본문>` 형태로 연결 (YYYY-MM-DD는 오늘 날짜).
3. 합친 markdown에 paragraph 2000자 가드 적용 (review.md §3.5 재사용) — 1800자 초과 paragraph는 자동 분할.
4. `mcp__notion__notion-update-page`로 본문 교체 (page ID·properties 유지).
5. 실패 시 사용자에게 "N번 AUGMENT 실패 — 신규로 저장할까요?" 1회 안내. 자동으로 NEW 전환 금지.

AUGMENT 시 properties는 건드리지 않는다 (report/category/tags 등 원래 그대로). 본문에만 정보를 누적.

## 결과 보고

- 처리 N개 (신규 X / 보강 Y / 중복 skip Z)
- 신규·보강 모두 URL을 텍스트로 1줄씩 보고.

## 사용 시점

- `/jhw:review` 직후 의심나는 항목 사후 점검 — 무인자 `/jhw:match`로 충분(가장 마지막 review 자동 사용), 명시하려면 `/jhw:match --from-review`
- 단건 저장 전 미리 검사 (`/jhw:match "<제목 또는 키워드>"`)
- "이 주제 기존에 뭐 있나?" 빠른 확인
- 정기적인 신규 후보 정리

## 규칙

- **같은 DB 결과만 사용** — `jhw_search`를 `db=<후보 DB>`로 호출하면 서버가 해당 DB로 한정 검색한다 (KB는 `db=knowledgeBase`, Decision Log는 `db=decisionLog`; 상세 §흐름3).
- **모든 jhw_search와 notion-fetch는 한 메시지 안에서 병렬 호출** — 순차 호출 금지 (전역 규칙).
- **AUGMENT 본문 append 형식**: 기존 본문 끝에 `### YYYY-MM-DD 보강` + 빈 줄 + 새 본문. paragraph 2000자 가드 적용. properties는 건드리지 않는다.
- **DUPLICATE 기본 skip**. 사용자가 "N번 신규"로 강제 신규 저장 가능.
- **확신 없으면 SIMILAR로 보수적 분류**. DUPLICATE 남발은 정보 손실. AUGMENT 잘못 판정해서 엉뚱한 페이지에 append하는 것이 가장 위험.
- **AUGMENT에 target_url이 비어 있으면 임의 신규 전환 금지** — 사용자 확인 필수.
- **/jhw:compact와 역할 구분**: compact는 *기존 ↔ 기존*, match는 *신규 ↔ 기존*.
- **/jhw:review와 역할 구분**: review는 가벼운 저장 흐름, match는 옵트인 대조.
- **성과 필드 자동 채움**: NEW/SIMILAR로 projects(완료)·decisionLog(확정) 신규 저장 시 `impact`+`achievement:true`를 함께 넣는다 → 🏆 성과 뷰·보고서 자동 누적. AUGMENT는 properties 미변경 원칙이라 성과 필드도 건드리지 않는다.
- **무인자 자동 from-review**: 인자 없이 `/jhw:match` 호출 시 대화의 **가장 마지막** `/jhw:review` 후보 카드를 자동 입력으로 사용한다(그 이후 새 저장/대조가 없을 때만). 없거나 stale하면 되묻는다. 명시적 `--from-review`는 강제용.
- 매칭 결과 0건이면 카드에 NEW로 표시. 매칭이 있어도 모두 SIMILAR면 신규 저장이 기본 동작.
- **`/jhw:review --match` 재사용 정본**: review의 `--match` 플래그는 본 스킬의 verdict 파이프라인(§verdict)·AUGMENT 절차(§AUGMENT)를 단일 정본으로 재사용한다. 단 review --match는 **저장 전** 대조라 중복 페이지를 애초에 생성하지 않는다(DUPLICATE 판정 시 skip — 순차 `/jhw:review`→`/jhw:match`의 사후 정리와 다름). 대조 로직 변경 시 여기만 고치면 review에도 반영된다.

## 참고

- 단건 저장: `/jhw:save`, `/jhw:record`, `/jhw:note`
- 세션 저장: `/jhw:review`
- 세션 저장+대조(저장 전): `/jhw:review --match`
- 사후 정리: `/jhw:compact`
- 회상/검색: `/jhw:recall`
