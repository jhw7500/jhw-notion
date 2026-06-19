<!-- Created: 2026-06-17 | Source session: wlan-driver-v2 | Updated: 2026-06-19 (jhw-notion: 코드 대조·옵션A 적용) -->

# multi_select 태그 어휘 가드 & Notion 옵션 자동 등록 분석

## 계기

다른 프로젝트(`wlan-driver-v2`) 세션에서 `jhw_note`(knowledgeBase.tags) / `jhw_record`(references.tool) 호출 시
신규 태그가 **저장되지 않고 경고만** 반환됨:

```
[knowledgeBase.tags] 미등록 값 6개 제외: thermal_mgmt, debug.conf, hostcmd, mlanutl, NXP, 0x008b
[references.tool] 미등록 값 3개 제외: mlanconfig, mlanutl, uaputl
```

이를 Notion에 수동 등록하는 과정에서 Notion API의 multi_select 옵션 등록 메커니즘과
`jhw-notion`의 어휘 가드 설계 의도를 함께 확인했다. 본 문서는 그 실측과 코드 수정 방향을 정리한다.

---

## 1. 현재 동작 — 의도된 "어휘 가드"

미등록 drop은 **버그가 아니라 설계 정책**이다. 노이즈/오타 태그가 DB 옵션을 오염시키는 것을 막으려는 화이트리스트.

| 위치 | 역할 |
|---|---|
| `mcp-server/src/notion/field-vocab.ts` | KB `tags`, references `tool`, projects `tech_stack`의 **허용 어휘 목록**. 별칭 정규화 + 중복제거 → 허용은 유지, **미등록은 drop**. (주석: "정당한 신규 태그는 이 목록에 추가") |
| `mcp-server/src/notion/property-builder.ts:85-100` | `multi_select` case에서 vocab 가드 적용. drop된 값은 `options.warnings`에 누적 |
| `mcp-server/src/tools/note.ts:63-76` | knowledgeBase.tags 가드 + 경고 |
| `mcp-server/src/tools/record.ts:103-112` | 공통 빌더 경유 가드 + 경고 |
| `mcp-server/src/tools/start.ts:34-42` | projects.tech_stack 가드 |

→ **현재 신규 태그를 쓰려면 `field-vocab.ts` 허용 목록에 손으로 추가해야 한다.**

---

## 2. Notion 옵션 등록 메커니즘 (실측)

### 2.1 페이지 업데이트만으로는 옵션 자동 생성 불가
`notion-update-page`로 미등록 multi_select 값을 쓰면 **API가 거부**:
```
validation_error: Invalid multi_select value for property "tags": "thermal_mgmt".
Value must be one of the following: ...
If a new multi_select option is needed, the data source must be updated to add it.
```
→ **반드시 data source(컬렉션) 스키마를 먼저 수정**해야 옵션이 생긴다.

### 2.2 ALTER COLUMN SET 은 "교체" (Notion MCP의 SQL 추상화 기준)
`notion-update-data-source`의 `ALTER COLUMN "tags" SET MULTI_SELECT(...)`는 **옵션 정의를 통째로 교체**한다.
- 신규 3개만 주고 ALTER → 기존 15개가 **목록에서 사라짐**(옵션 삭제, 새 ID로 재생성).
- 안전하게 추가하려면 **"기존 전체 + 신규"를 모두 나열**해야 한다.

### 2.3 단, 페이지의 기존 값은 "이름 매칭"으로 보존됨 (검증)
옵션이 삭제→재생성(새 ID)돼도 **페이지의 multi_select 값은 사라지지 않았다**.
- 검증: `wsl-serial` references 페이지의 `tool` = `["WSL2","usbipd","bash"]` — 1차 ALTER로 삭제됐던 옵션인데도 그대로 유지.
- 즉 Notion은 옵션 이름 기준으로 페이지 값을 보존한다(표시상 옵션 ID만 갱신).

> ⚠️ **코드 대조 정정 (2026-06-19 jhw-notion 세션)**: jhw-notion은 raw REST를 호출하지 않는다 — `@notionhq/client` v5.20.0 SDK만 쓰며(`mcp-server/src/notion-client.ts`의 `new Client(...)`), v5 모델에선 multi_select 스키마가 **database가 아니라 data source**에 산다. 따라서 관련 primitive는 `PATCH /v1/databases`가 아니라 **`notion.dataSources.retrieve` / `notion.dataSources.update`**. append vs replace(기존 id 보존) 의미는 현재 코드에 옵션-쓰기 호출이 전혀 없어 **여전히 실측 미해결**이나, "전체 옵션 조회→id 보존 merge→update"는 **어느 의미든 안전**하므로 블로커는 아니다(§3 옵션 B 참조).

---

## 3. 코드 수정 방향 (jhw-notion 세션 작업용)

### 옵션 A — 허용 목록 확장 (단순/저위험, 현 정책 유지)
`field-vocab.ts`의 해당 배열에 신규 태그를 추가만 한다.
- KB `tags` 후보: `thermal_mgmt`, `debug.conf`, `hostcmd`, `NXP`, `0x008b`
- references `tool` 후보: `mlanconfig`, `mlanutl`, `uaputl`
- 장점: 어휘 가드(노이즈 방지) 의도 유지. 단점: 매번 수동.

### 옵션 B — 미등록 태그 자동 등록 (근본/자동화)
drop 대신, 미등록 태그를 **data source에 자동 추가한 뒤 저장**.
- 진입점: `property-builder.ts:85` multi_select case (현재 drop+warning 지점).
- 신규 함수 필요: `notion/api.ts` 에 옵션 append 함수 신설. **SDK v5 기준**:
  `notion.dataSources.retrieve(data_source_id)` 로 현재 옵션 조회 → name 기준 merge(**각 옵션 id·color 보존**)
  → `notion.dataSources.update({ data_source_id, properties: { [name]: { multi_select: { options } } } })`,
  전부 `callNotion()` 래핑(retry/ratelimit). `data_source_id` 는 `schema.ts`의 `getDataSourceId(db)`.
  현재 `api.ts`는 read-only(`queryDataSource`)뿐이라 옵션-쓰기 함수가 없음 → 신설 대상.
- **주의 (구현 실패 모드)**:
  1. **동시성**: retrieve→merge→update는 read-modify-write라 서로 다른 신규 태그를 추가하는 두 호출이 last-writer-wins로 lost-update. 옵션 쓰기를 직렬화하거나 충돌 재시도.
  2. **append 전 dedupe**: 신규 태그를 조회된 기존 옵션과 정규화(대소문자/공백) 비교로 중복제거 후 append. 안 하면 동명 옵션 중복 생성 또는 API 거부.
  3. **id 보존**: 기존 옵션 재전송 시 **원래 id를 함께** 보내야 §2.2의 delete-recreate(새 id churn)를 피한다.
  - merge가 전체 옵션을 조회·재전송하므로 API 의미가 append든 replace든 **안전**(§2.3 hedge는 구현을 막지 않고 "재전송 필요성"만 가른다).
- 트레이드오프: 어휘 가드의 노이즈 방지 의도와 충돌(오타까지 옵션화). 절충안:
  - 화이트리스트(자동등록 허용 DB/필드만), 또는
  - `allow_new_tags`/`--force-tag` 같은 명시 플래그가 있을 때만 자동 등록, 평소엔 현행 drop 유지.

### 권장
1차로 **옵션 A**(필요 태그를 vocab에 추가)로 즉시 해소. — **✅ 적용됨(2026-06-19)**: `field-vocab.ts`에 KB tags 6개(`thermal_mgmt`·`debug.conf`·`hostcmd`·`mlanutl`·`NXP`·`0x008b`)·references tool 3개(`mlanconfig`·`mlanutl`·`uaputl`) 추가.
**옵션 B**는 정책 결정(어휘 가드를 유지할지 자동등록으로 전환할지)이 필요하므로 별도 설계.

---

## 4. 이번 세션 실측 데이터 (수동 등록, 참고)

- KB `tags`: 109 → **114개** (신규 5개; `mlanutl`은 기존 존재). 기존 옵션 ID·색상 보존.
- references `tool`: 15 → **18개** (신규 3개). 1차 ALTER로 일시 축소됐다가 18개로 복구.
- 두 저장 페이지 태깅 정상, **기존 페이지 태그 손실 없음**(§2.3).

## 5. 코드 수정 진입점 요약

| 파일 | 라인 | 내용 |
|---|---|---|
| `mcp-server/src/notion/field-vocab.ts` | 허용 목록(KB tags / references tool / tech_stack) | 옵션 A: 여기 추가 |
| `mcp-server/src/notion/property-builder.ts` | 85–100 (multi_select case) | 옵션 B: drop 대신 자동등록 분기 |
| `mcp-server/src/notion/api.ts` | — | 옵션 B: `dataSources.retrieve/update` 기반 옵션 append 함수 신설 (SDK client는 `src/notion-client.ts`) |
| `mcp-server/src/tools/note.ts` / `record.ts` | note 63–76 / record 103–112 | 경고 처리 흐름 |
