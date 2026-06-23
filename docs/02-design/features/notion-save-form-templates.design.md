# notion-save-form-templates Design Document

> **Summary**: 저장 본문 양식을 "구조 가이드형"으로 재설계. 인라인 하드코딩된 블록 배열을 공통 블록 빌더(`blocks.ts`) + 경로별 양식 함수(`templates.ts`)로 추출하고, 각 DB 특성에 맞는 이모지 heading·placeholder callout·체크리스트 양식을 적용한다.
>
> **Project**: jhw-notion
> **Version**: 0.1.0 (mcp-server)
> **Author**: hwjo + Claude
> **Date**: 2026-06-23
> **Status**: Draft
> **Planning Doc**: (brainstorming → design 직접 진입, 별도 plan 없음)

---

## 1. 배경 / 문제

현재 모든 저장 경로의 본문(페이지 children)은 각 tool 파일에 **인라인 하드코딩된 블록 배열**이다.

- `start.ts:59-68` — heading_2 4개(목표/범위/제약/메모) + 단락, 이모지·시각 구조 없음
- `close.ts:69-89` — 회고/달성한것/배운점, 마찬가지
- `note.ts:93`, `record.ts:147` — `paragraphBlocks(content)`로 **단락만** 생성 (양식 없음)

문제점:
1. 양식이 코드에 흩어져 중복되고, 빌더 헬퍼가 없어 매번 raw 블록 객체를 손으로 작성한다.
2. 빈 페이지에 작성 가이드가 없어 사용자가 무엇을 채울지 알기 어렵다.
3. DB마다 성격(projects=목표추적, decisionLog=의사결정, knowledgeBase=지식메모 등)이 다른데 본문 구조가 이를 반영하지 못한다.

## 2. 목표 / 비목표

**목표**
- 저수준 블록 빌더 + 경로별 양식 함수를 공통 모듈로 추출(중복 제거, 유지보수성↑).
- 각 DB 특성에 맞는 "구조 가이드형" 본문 양식(이모지 heading + placeholder callout/체크리스트) 적용.
- 빈 페이지를 사용자가 쉽게 채우도록 가이드 제공.

**비목표 (YAGNI)**
- Notion DB 템플릿(`template_id`)으로의 이관 — 코드 방식 유지.
- start/close 전용 템플릿과 record scaffold의 공유 헬퍼 강제 통합(후속 과제).
- preferences 본문 양식(아래 §7 참조 — 기본 미적용).

## 3. 확정된 결정사항 (사용자 승인 2026-06-23)

| # | 결정 | 내용 |
|---|---|---|
| D1 | 스타일 | **구조 가이드형** — 이모지 heading + placeholder(회색 callout/옅은 단락) + 체크리스트(to_do) |
| D2 | 적용 범위 | 전 경로(5개 DB) |
| D3 | 구현 방식 | 공통 헬퍼 추출 후 개선 |
| D4 | record 적용 | **opt-in `scaffold` 플래그** — content 비었고 `scaffold=true`일 때만 주입. 기본 현행과 동일 |
| D5 | note 처리 | `content`를 **optional로 완화** + 빈 경우 category 맞춤 스캐폴드 주입 |
| D6 | start/close | 전용 도구 → 양식 **항상 적용** |
| D7 | preferences | 본문 양식 **기본 미적용** (content가 props SSOT) |

## 4. 아키텍처

```
src/notion/
  blocks.ts      ← (기존) paragraphBlocks 유지 + 저수준 블록 빌더 신규 추가
  templates.ts   ← (신규) DB/경로별 양식 함수. blocks.ts 빌더 + paragraphBlocks 조합
```

### 4.1 저수준 블록 빌더 (`blocks.ts`에 추가)

기존 `paragraphBlocks`(긴 본문 2000자 split)는 **그대로 유지**하고, 짧은 라벨/구조 블록용 빌더를 추가한다. 반환 타입은 기존 컨벤션(느슨한 `any`/`Block`)과 통일한다.

| 빌더 | 시그니처 | 노션 표현 | 비고 |
|---|---|---|---|
| `h2` | `(text: string, emoji?: string)` | heading_2 | 이모지는 **rich_text content prefix** (`🎯 목표`) — heading엔 icon 슬롯 없음 |
| `h3` | `(text: string, emoji?: string)` | heading_3 | h2와 동일 패턴 |
| `para` | `(text?: string)` | paragraph | 짧은 라벨/빈 단락. `para("")` → 빈 줄(`rich_text:[]`) |
| `hint` | `(text: string)` | paragraph | 옅은 회색(`annotations.color="gray"`) 안내 단락 |
| `todo` | `(text: string, checked = false)` | to_do | 항목성(범위/대안/액션) 체크박스 |
| `callout` | `(emoji: string, text: string, color = "gray_background")` | callout | 이모지는 **icon 슬롯**(`icon:{emoji}`), 본문은 회색 박스 = placeholder 주력 |
| `divider` | `()` | divider | 큰 섹션 경계 1곳만 |

**placeholder 표현 원칙** (노션엔 진짜 placeholder 블록이 없음):
- 서술형 가이드 → `callout("💡", ...)` (회색 배경)
- 항목성 가이드 → 빈 `todo(...)`
- 즉시 타이핑용 → `para("")` (빈 줄)
- 짧은 옅은 안내 → `hint("(작업하며 작성)")`

### 4.2 양식 함수 (`templates.ts`, 순수함수 → `Block[]`)

명명 규칙 `build{용도}`:
- `buildStartBody({ description, stack, repo })` → start.ts 본문
- `buildCloseRetro({ today, achievement, lessons })` → close.ts 회고 append
- `buildScaffold(db, props)` → record opt-in 스캐폴드 (5개 DB 분기)
- `buildKbScaffold({ summary, category })` → note 빈 본문 + record KB 분기 **공유**

모두 `notion.pages.create({ children })` / `blocks.children.append({ children })`에 그대로 전달.

## 5. 경로별 양식 상세

### 5.1 projects — start (`start.ts:59-68` 교체)

```
🎯 목표                      ← description(필수) 채움
📦 범위 (Scope)
  ☐ (이 프로젝트에서 할 것 — 작업하며 채우기)
  ☐ (포함 범위 항목)
  ☐ (포함 범위 항목)
🚧 제약 / 비범위
  💡 제약(기술/일정/리소스)·하지 않을 것을 적어두면 범위 크리프를 막습니다. (작업하며 작성)
🧱 스택 / 환경                ← stack/repo 있을 때만 섹션 생성(YAGNI)
  {stack}
  레포: {repo}
📝 진행 메모 / 결정
  💡 진행하며 떠오른 메모·중간 결정을 시간순으로. 중요 결정은 Decision Log, 재사용 지식은 Knowledge Base로 별도 저장됩니다.
  (빈 단락)
```

### 5.2 projects — close (`close.ts:69-89` 교체, achievement/lessons 있을 때만)

```
──────  divider
🏁 회고 (YYYY-MM-DD)
  ✅ 달성한 것                ← achievement 있을 때만
  {achievement}
  💡 배운 점                  ← lessons 있을 때만
  {lessons}
  🔮 다음 액션 / 후속          ← 신규(선택 섹션, §12 OPEN-1)
  💡 이어서 할 일·미해결 이슈가 있으면 적어두세요. (없으면 비워둠)
```

기존 조건부 분기(`if (achievement || lessons)`)는 유지. 회고 heading 이모지는 라이프사이클 종료를 신호하는 🏁.

### 5.3 decisionLog (record content 없을 때 / start의 decisionLog 본문)

특성: **근거·대안 비교가 본문 핵심**.

```
🎯 결정              ← description seed 또는 placeholder
🧭 근거               💡 callout — props.rationale를 seed로 맥락·트레이드오프 확장
🔀 검토한 대안         ☑ 채택안 / ☐ 탈락안 — 사유  (props.alternatives 펼침)
📊 영향·결과           🏆 {impact}(checked) + 후속 체크박스
                      (status="폐기"면 "📊 폐기 사유·대체 결정")
```

### 5.4 knowledgeBase — note(빈 본문) / record KB 분기 (공유 `buildKbScaffold`)

골격은 공통, **상세 하위 라벨만 category 3종 분기**:

| category | 📖 상세 하위 라벨 |
|---|---|
| 문제해결 | 문제 / 원인 / 해결 |
| 디버깅 | 증상 / 원인 / 조치 |
| 아키텍처 | 배경 / 구조 / 트레이드오프 |
| 그 외 5종 / undefined | 핵심 / 근거·맥락 (공통 fallback) |

```
📌 요약    💡 callout (summary 값 우선, 없으면 안내)
📖 상세    (category별 heading_3 라벨 + hint 단락)
✅ 액션·후속  ☐ (필요 시) 후속 작업 / 검증 항목
🔗 관련    (관련 URL/페이지 멘션)
```

### 5.5 references (record content 없을 때, lean)

```
📄 핵심 요약   summary 값 또는 안내
💬 왜 중요한가 / 발췌   💡 callout — 인용·발췌·저장 이유 (props에 담을 수 없는 유일한 자리)
🔗 링크        url이 props에 있으면 섹션 생략, 없을 때만 fallback 안내
```

## 6. record 통합 — `scaffold` opt-in (D4)

`record.ts:147` 교체:

```ts
const children = content?.trim()
  ? paragraphBlocks(content)                              // ① content 있으면 그대로 (현행 100% 보존)
  : (scaffold ? buildScaffold(db, properties) : []);      // ② 없고 opt-in일 때만 주입
// 이후 ...(children.length > 0 ? { children } : {}) 가드 그대로
```

- `RecordInput`에 최상위 `scaffold: z.boolean().optional()` 추가 (`allowNewTags` 패턴과 일관).
- 분기 3종:
  1. content 있음 → `paragraphBlocks`, scaffold 무시 (본문 우선)
  2. content 없음 + scaffold 미지정/false → children 없음 (현행 동일)
  3. content 없음 + scaffold=true → `buildScaffold(db, props)` (실제 props 값은 채우고 빈 곳만 placeholder)
- `buildScaffold`의 KB 분기는 `buildKbScaffold` 재사용(note와 공유).

## 7. note 변경 (D5)

- `NoteInput.content`를 `z.string()` → `z.string().optional()`로 완화.
- 본문 생성 교체:
  ```ts
  const children = content?.trim()
    ? paragraphBlocks(content)               // 현행 동작 보존
    : buildKbScaffold({ summary, category }); // 빈 경우 category 맞춤 스캐폴드
  ```
- `cachePage`의 `text = content || title` 유지 → 스캐폴드 placeholder는 검색 인덱스에 들어가지 않음(의도).

## 8. preferences (D7)

본문 양식 **기본 미적용**. 근거:
1. 규칙 텍스트의 SSOT는 `content` property(`schema.ts:69`) — 본문 복제 시 SSOT 분리.
2. 대부분 1~2줄 단일 규칙이라 섹션화할 내용 없음.
3. record 기본 경로는 content 비면 이미 본문 0블록 → "본문 없음"이 자연 기본값.

예외: `buildScaffold("preferences", ...)`는 최소 1섹션(⚙️ 선호 내용)만 — scaffold=true를 명시한 경우에 한함.

## 9. props ↔ 본문 중복 방지 규칙

| props | 본문 역할 |
|---|---|
| `rationale` (한 줄) | callout에 **맥락·트레이드오프 확장** (복붙 금지) |
| `alternatives` (평문) | to_do로 **채택/탈락 비교 구조화** |
| `url` (references) | 본문 링크 섹션 **생략** |
| `content` (preferences) | 본문 미사용 — props가 SSOT |
| `summary` (KB/refs) | 본문 첫 줄로 **경량 재사용**(열람 맥락) 허용 |

`content`는 Notion system reserved property → 항상 page-level children으로만 흐른다(CLAUDE-notion.md 준수, properties.content 미사용).

## 10. 변경 파일

| 파일 | 변경 |
|---|---|
| `src/notion/blocks.ts` | 빌더(h2/h3/para/hint/todo/callout/divider) 추가. `paragraphBlocks` 불변 |
| `src/notion/templates.ts` | **신규** — buildStartBody/buildCloseRetro/buildScaffold/buildKbScaffold |
| `src/tools/start.ts` | 인라인 children → `buildStartBody({description, stack, repo})` |
| `src/tools/close.ts` | 인라인 retroBlocks → `buildCloseRetro({today, achievement, lessons})` |
| `src/tools/record.ts` | `scaffold` 플래그 + 분기. `buildScaffold` 호출 |
| `src/tools/note.ts` | `content` optional + `buildKbScaffold` 분기 |

## 11. 테스트 계획

- **신규** `src/notion/__tests__/blocks.test.ts` (또는 templates.test.ts): h2 이모지 prefix, callout icon 슬롯, hint color="gray", divider 형태, 각 build* 함수 섹션 구성.
- **갱신** `src/tools/__tests__/start.test.ts:54-55` — heading 기대값을 이모지 포함(`🎯 목표`)으로.
- **회귀 확인**: `record.test.ts`(scaffold 미전달 → 현행 동일), `note.test.ts`(content 있을 때 불변). content 없는 케이스가 children 없는 create를 깨지 않는지.
- **신규 record 케이스**: scaffold=true+content없음 → 해당 db heading 포함 / scaffold=true+content있음 → scaffold 무시 / props.description 채움 분기.
- 빌드: `cd mcp-server && npm run build` (tsc 컴파일 오류 0).

## 12. 열린 결정 (스펙 리뷰에서 확정)

- **OPEN-1**: close 회고에 `🔮 다음 액션 / 후속` 섹션을 신규 추가할지 (현재 없음). 기본안: 포함(가벼운 callout 1줄). 빼도 무방.
- **OPEN-2**: 빌더 위치 — 저수준 빌더를 `blocks.ts`에 둘지(현 설계) vs `templates.ts`에 통합할지. 기본안: blocks.ts(저수준)/templates.ts(양식) 분리.
- **OPEN-3**: `/jhw:save --scaffold` 스킬 플래그 연동은 **이번 코드 범위 밖**(skills md 별도 PR).

## 13. 호환성 / 롤백

- record/note 기본 동작은 비트 단위로 현행과 동일(scaffold/빈 content 분기만 추가) → 회귀 표면 최소.
- 전부 page-level children 변경이라 properties/DB 스키마 무변경 → DB 마이그레이션 없음.
- 롤백: 양식 함수 호출을 인라인 배열로 되돌리면 됨(코드 변경만, 데이터 영향 없음).
