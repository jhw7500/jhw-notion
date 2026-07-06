# On-Demand Notion Recall — 설계 문서

- **Date**: 2026-07-06
- **Status**: Approved (2026-07-06 — 마커 `노션참고` 확정, 관련성 v1 topic-first 동의)
- **Author**: jhw + Claude
- **Scope**: `jhw-notion` MCP 서버(신규 도구) + 전역 `~/.claude` 설정(훅 1개 + 지침 1문단)

---

## 1. 문제 / 목표

노션에 프로젝트 진행내용·지식(결정·근거, 재사용 지식, 외부문서)이 쌓여 있으나, **작업 중 이를 자동으로 참고하는 장치가 전혀 없다.** 현재는 사용자가 명시적으로 `/jhw:recall` 등을 부르거나 모델이 즉흥적으로 노션 도구를 호출할 때만 활용된다.

**목표**: 프로젝트 작업 프롬프트에서 **필요할 때만, 지금 작업 주제에 맞는** 노션 기록을 자동 조회해 참고한다.

### 사용자가 확정한 제약 (설계를 결정한 두 문장)

1. **"같은 프로젝트라도 내용이 전혀 다른 것을 진행할 수 있다"**
   → 세션 시작 시 프로젝트 단위 통짜 로드는 부적합. 관련성은 **프로젝트가 아니라 "지금 이 작업(프롬프트 주제)" 단위**여야 한다.
2. **"프롬프트마다 노션 조회하는 것은 낭비"**
   → 매 프롬프트 자동 조회도 부적합. **명시적·on-demand 트리거**로만 발동.

---

## 2. 조사로 확인된 핵심 사실 (설계 근거)

> 4-에이전트 병렬 조사 결과 요약. 상세는 각 코드 file:line 참조.

- **현재 자동 주입 파이프라인에 노션 데이터는 0.** SessionStart/UserPromptSubmit/PreToolUse 어디에도 노션을 읽는 훅이 없다. 따라서 신규 메커니즘은 **그린필드**(중복·충돌 없음). 공존 대상은 OMC `[PROJECT MEMORY]`(로컬), 네이티브 `MEMORY.md`, `CLAUDE-notion.md`(지침 텍스트) 뿐.
- **기존 조회 도구는 "쓸 내용"을 안 준다.**
  - `jhw_recall`(`mcp-server/src/tools/recall.ts`) = 키워드 검색이나 **제목만** 인덱싱(`recall.ts:74` `text: title`), 본문 없음, 프로세스-수명 인메모리 캐시, 프로젝트 스코프 없음.
  - `jhw_context`(`mcp-server/src/tools/context.ts`) = 유일하게 본문을 주지만 **projects + decisionLog만** 조회, 정작 최대 지식창고 **KnowledgeBase/References/Preferences를 안 봄**.
- **관련성은 전부 키워드/부분일치.** 시맨틱/임베딩 없음(`page-cache.ts` 토큰중첩 스코어 + Notion `search` 랭킹).
- **노션 콘텐츠 모델(5 DB)** — `mcp-server/src/config.ts`, `schema.ts`:
  - `projects`(허브, 본문=목표/Scope/제약/진행메모)
  - ← `project` relation ← `decisionLog`(결정·근거·대안) / `knowledgeBase`(재사용 지식, 카테고리 8종, 태그 482종 규모) / `references`(외부문서·URL)
  - `preferences`(전역 AI행동 규칙, **프로젝트 relation 없음**)
  - 교차축 `report` select 11종(pim-*, wlan-* 제품 모듈)
- **재사용 가능한 인프라**: `resolveProject()`(`notion/resolve-project.ts:29`, 대소문자 무시 정확일치 우선), `queryDataSource()`(`notion/api.ts:281`, v5 data_source 쿼리 + relation/property 필터), `callNotion()`(RateLimiter concurrency=3 + 4회 재시도). 이미 다 있으므로 신규 도구는 조립만 하면 됨.
- **API 제약(중요)**: `queryDataSource`는 property/relation 필터만 가능(본문 전문검색 불가). `notion.search`는 전문검색이나 **워크스페이스 전역**이라 relation(프로젝트) 서버사이드 필터 불가. → 관련성 전략은 이 둘의 조합으로 설계.

---

## 3. 설계 개요

3계층 + 2단계로 구성한다. 계층은 대체재가 아니라 협력 구조다.

```
[트리거 계층]  UserPromptSubmit 훅
   프롬프트에 마커('노션참고'/'@notion') 감지 → [NOTION-RECALL] 리마인더 주입 (결정론적)
         │
         ▼
[행동 계층]  CLAUDE-notion.md 지침
   마커 OR 조회의도 감지 시: 모델이 프롬프트에서 '주제' 추출 → 조회 도구 호출 → 내용으로 작업
   (저장/코드수정 의도와 3-way 구분; 관련성 판단 = 모델)
         │
         ▼
[조회 계층]  jhw_retrieve (신규 MCP 도구, Phase 1)
   주제 키워드로 decisionLog+knowledgeBase+references 병렬 검색
   → top-k에 제목+요약+본문 스니펫+URL 반환 (토큰 예산 컷)
   (Phase 0 폴백: 기존 notion-search → notion-fetch 조합)
```

**트리거 스타일 = 둘 다(사용자 선택 3번)**: 마커는 훅이 보장 발동(오발 0), 자연어 조회의도는 지침으로 모델판단 보조.

**범위 = 전역**: 훅·지침은 `~/.claude`에 두어 모든 세션 적용, 도구는 `mcp__jhw-notion__*`로 모든 세션 노출 → jhw-notion 저장소뿐 아니라 pim/wlan 등 다른 프로젝트 작업에도 동작.

---

## 4. 컴포넌트 상세

### 4.1 트리거 계층 — `notion-recall-trigger-hook.py`

- **위치**: `/home/jhw/.claude/hooks/notion-recall-trigger-hook.py` (기존 `notion-continuous-exec-hook.py`와 동일 패턴)
- **이벤트**: `UserPromptSubmit`
- **감지(정규식, 결정론적)**: 프롬프트에 마커가 있으면 발동
  - 한글 마커: `노션참고` (기본)
  - ASCII 별칭: `@notion` (대소문자 무시)
  - 마커는 프롬프트 어디에나 위치 가능
- **동작**: stdout으로 `[NOTION-RECALL]` 리마인더 주입:
  > 이 프롬프트는 **노션 참고 요청**이다. 프롬프트에서 핵심 주제를 뽑아 `mcp__jhw-notion__jhw_retrieve`(없으면 `notion-search`→`notion-fetch`)로 관련 기록(결정·지식·문서)을 먼저 조회하고, 그 내용을 근거로 작업하라. 조회 근거를 1줄로 보고하라. 독립 조회는 병렬로.
- **비발동**: 마커 없으면 아무것도 하지 않음(비용 0). 저장/코드수정 프롬프트는 마커를 안 쓰므로 자연히 제외.
- **탈출구**: `#noreminder`(기존 훅 관례와 동일)면 스킵.
- **다른 훅과의 관계**: 기존 `notion-continuous-exec-hook.py`(승인 키워드)·`post-info-tool-continuation-hook.py`(조회 후 계속)와 트리거가 달라 충돌 없음. 조회 실행 후의 "멈추지 말고 계속" 보장은 기존 `post-info-tool-continuation-hook.py`가 이미 담당(matcher에 `jhw_context` 등 포함 → **matcher에 `jhw_retrieve` 추가 필요**).

### 4.2 행동 계층 — `CLAUDE-notion.md` 신규 섹션

`~/.claude/CLAUDE-notion.md`에 아래 규칙 추가:

- **트리거**:
  1. (보장) 마커 `노션참고`/`@notion` 존재 시
  2. (보조·모델판단) 사용자가 명확히 **조회/참고 의도**를 보일 때 — "노션에서 찾아/참고/조회", "예전에 이거 어떻게 했더라(프로젝트 지식)", "관련 결정 있었나"
- **3-way 의도 구분(오발 방지, 핵심)**:
  - **조회(retrieve)** → 본 규칙 발동
  - **저장(save)** "노션에 저장/기록해줘" → 기존 저장 흐름 규칙(발동 안 함)
  - **코드수정** "노션 MCP 코드 고쳐줘" → 이 저장소 코드 작업(발동 안 함)
- **동작**:
  1. 프롬프트에서 **주제 키워드** 추출(작업 대상·기술·증상 등)
  2. `jhw_retrieve` 호출(주제 + 식별 가능하면 프로젝트). 도구 부재 시 `notion-search`→관련 후보 `notion-fetch`
  3. 반환 내용을 근거로 작업 수행
  4. **무엇을 근거로 삼았는지 1줄 보고**(제목/URL 포함)
  5. 조회로도 불충분하면 그때 사용자에게 질문(무엇을 찾았고 무엇이 여전히 불명확한지)
- **적용 안 함**: 코드/파일에서 즉시 확인되는 것, 일반 지식, 이번 세션에서 이미 확정된 것.

### 4.3 조회 계층 — `jhw_retrieve` (신규 도구, Phase 1)

- **파일**: `mcp-server/src/tools/retrieve.ts`, 등록 `mcp-server/src/server.ts`
- **입력**:
  - `topic` (string, required) — 조회 주제 키워드
  - `project` (string, optional) — 프로젝트명/URL/UUID (스코프 부스트용)
  - `limit` (number, 1–15, default 8)
  - `dbs` — **v1 미구현(deferred knob)**: 입력으로 노출하지 않고 `RETRIEVE_DBS` 상수로 3-DB(`decisionLog`/`knowledgeBase`/`references`) 하드코딩. 향후 파라미터화.
- **관련성 전략 (v1 = topic-first; 반복 개선 가능한 knob)**:
  1. `notion.search({ query: topic, page_size: ~15 })` (전문검색)
  2. hit의 parent data_source가 대상 `dbs`에 속하는 것만 유지(schema 매핑)
  3. `project` 제공 시: `resolveProject()`로 projectId 해석 → in-project hit을 상위로 부스트(search는 relation 서버필터 불가하므로 post-filter/rank)
  4. 상위 `limit`개 선택
  5. 각 항목 **병렬** fetch: 속성(summary/category/tags/date/status/rationale) + 본문 앞 ~10블록 → 스니펫(~400–600자) 구성
  6. 토큰 예산 초과 시 잘라내고 `truncated: true` 표기
  - **폴백 knob (v1 미구현, 향후)**: `topic`이 약하고 `project`가 있으면 relation-scoped `queryDataSource`(DB별 최근 N)로 대체. **v1은** topic 검색이 0건이면 `project`가 있어도 `used:"empty"`.
- **출력**: `{ topic, project?, used, count, truncated, results: [{ db, title, summary, snippet, url, project, date, category?, tags?, status? }] }`
- **비용**: search 1회 + 최대 `limit`개 fetch(RateLimiter concurrency=3로 자동 제한). `jhw_context`(2–3회)보다 약간 무겁지만 top-k·스니펫으로 상한 고정.
- **재사용**: `resolveProject`, `queryDataSource`/`callNotion`, `schema.ts` data_source 매핑.

---

## 5. 데이터 흐름 (예시)

프롬프트: `노션참고 CAM 드라이버 i2c 타임아웃 예전에 어떻게 처리했지?`

1. **훅**: `노션참고` 감지 → `[NOTION-RECALL]` 리마인더 주입.
2. **모델**: 주제 `CAM 드라이버 i2c timeout` 추출, 프로젝트 유추 가능 시 전달 → `jhw_retrieve({ topic: "CAM i2c timeout", project?: ... })`.
3. **도구**: `notion.search("CAM i2c timeout")` → KB/Decision hit 필터 → top-k fetch → 스니펫 반환 (예: KB "AP1302 i2c 재시도" 본문 + Decision "max9296 링크 타임아웃 대응 근거").
4. **모델**: 그 내용을 근거로 답/코드 작성 + `근거: [KB]AP1302 i2c 재시도(url), [Decision]max9296…(url)` 1줄 보고.

---

## 6. 단계(둘 다 진행하되 독립적으로 동작)

- **Phase 0 (코드 0, 즉시 사용 가능)**: 4.1 훅 + 4.2 지침. 조회는 기존 `notion-search`→`notion-fetch`로 모델 수행. → **바로 오늘부터 동작**, Phase 1이 늦어져도 유효.
- **Phase 1 (코드)**: 4.3 `jhw_retrieve` 신설 + `server.ts` 등록 + 테스트. 완료 시 지침이 이 도구를 우선 호출(폴백은 유지). `post-info-tool-continuation-hook.py` matcher에 `jhw_retrieve` 추가.

> 두 Phase는 **계층이라 충돌 없음**. 지침을 처음부터 `jhw_retrieve` 우선(폴백 명시)으로 써서 재작업 방지.

---

## 7. 테스트

- **훅**: 마커 유/무, `@notion` 대소문자, `#noreminder`, 저장/코드수정 프롬프트 오발 없음(마커 없을 때 무발동) 단위 검증.
- **`jhw_retrieve`**: 기존 도구 테스트(`mcp-server` 테스트 관례) 미러링 — topic-only, topic+project 부스트, 빈 결과, limit/토큰 컷, DB 필터, 폴백 경로. Notion API는 기존 테스트처럼 목킹.
- **통합(수동)**: `노션참고 …` 프롬프트로 실제 조회→근거 보고까지 1턴 완결 확인.

---

## 8. 대안 검토

- **`jhw_recall` 확장(별도 도구 대신 모드 추가)**: 하나의 recall로 통합되나 기존 title-only/캐시 계약을 건드릴 위험. → 계약이 분명한 신규 도구 채택.
- **세션시작 훅 브리핑**: 제약 1로 탈락(작업별 관련성 불가).
- **매 프롬프트 자동 조회**: 제약 2로 탈락(낭비).
- **순수 스킬 auto-trigger**: 발동이 모델판단(비결정론) — 마커+훅의 결정론성이 사용자 요구에 더 부합.
- **임베딩 시맨틱 검색**: 큰 별도 프로젝트(인덱스 구축·동기화). v1 범위 밖(향후 knob).

---

## 9. 반복 개선 knob (v1 이후)

- 관련성 랭킹(topic-first ↔ relation-scoped ↔ 하이브리드), 스니펫 길이/토큰 예산, `report` 축·`tags` 부스트, 결과 로컬 캐시(TTL) 도입, 임베딩 도입.

## 10. 범위 밖 (YAGNI)

- 임베딩/벡터 검색, 프롬프트별 자동 조회, 세션시작 자동 로드, Preferences 자동주입(전역 행동규칙은 별건), 신규 `/jhw:*` 스킬 커맨드(모델이 MCP 도구 직접 호출로 충분).
