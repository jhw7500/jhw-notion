# Notion 저장 본문 양식 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 저장 본문(페이지 children)을 인라인 하드코딩에서 공통 블록 빌더 + 경로별 양식 함수로 추출하고, DB 특성에 맞는 "구조 가이드형" 양식을 적용한다.

**Architecture:** `blocks.ts`에 저수준 블록 빌더(h2/h3/para/hint/todo/callout/divider)를 추가하고, 신규 `templates.ts`가 이들을 조합해 경로별 양식 함수를 제공한다. start/close/note는 양식을 항상 적용하고, record는 opt-in `scaffold` 플래그로 주입한다.

**Tech Stack:** TypeScript (ESM, `.js` 확장자 import 필수), Vitest, @notionhq/client, zod.

## Global Constraints

- Notion DB 프로퍼티 key는 **영문** (`title`, `status`, `rationale` 등). 단 `임팩트`/`성과`는 한글 프로퍼티(기존 유지) — 본 작업은 properties 미변경.
- 블록 객체 형태: `{ object: "block", type: <T>, [<T>]: { rich_text: [{ type: "text", text: { content } }] } }` (기존 `makeParagraph` 패턴 준수).
- 이모지 규칙: **heading은 rich_text content prefix**(`🎯 목표`), **callout은 icon 슬롯**(`icon:{type:"emoji",emoji}`).
- ESM import는 `.js` 확장자 필수 (`from "./blocks.js"`).
- `content`는 Notion system reserved property → 항상 page-level children으로만. properties.content 미사용.
- 빌드 검증: `cd mcp-server && npm run build` (tsc 오류 0).
- 테스트 실행: `cd mcp-server && npx vitest run <path>`.
- 커밋: 한국어 메시지 + 영문 scope(`feat(notion):` 등), 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **하위호환 불변식**: record/note 기존 동작(content 있을 때)은 비트 단위로 동일해야 함.

---

## File Structure

| File | 책임 | 변경 |
|---|---|---|
| `mcp-server/src/notion/blocks.ts` | 저수준 블록 빌더 + paragraphBlocks | 빌더 7종 추가 (paragraphBlocks/makeParagraph 불변) |
| `mcp-server/src/notion/templates.ts` | 경로별 양식 함수 (순수함수 → Block[]) | **신규** |
| `mcp-server/src/notion/__tests__/blocks.test.ts` | 빌더 단위 테스트 | 케이스 추가 |
| `mcp-server/src/notion/__tests__/templates.test.ts` | 양식 함수 단위 테스트 | **신규** |
| `mcp-server/src/tools/start.ts` | jhw_start | 인라인 children → `buildStartBody` |
| `mcp-server/src/tools/close.ts` | jhw_close | 인라인 retroBlocks → `buildCloseRetro` |
| `mcp-server/src/tools/note.ts` | jhw_note | content optional + `buildKbScaffold` |
| `mcp-server/src/tools/record.ts` | jhw_record | `scaffold` 플래그 + `buildScaffold` |
| `mcp-server/src/tools/__tests__/start.test.ts` | start 테스트 | heading 기대값 이모지 갱신 |
| `mcp-server/src/tools/__tests__/note.test.ts` | note 테스트 | 빈 content 스캐폴드 케이스 추가 |
| `mcp-server/src/tools/__tests__/record.test.ts` | record 테스트 | scaffold 케이스 추가 |

---

### Task 1: 저수준 블록 빌더 (blocks.ts)

**Files:**
- Modify: `mcp-server/src/notion/blocks.ts` (append, paragraphBlocks 불변)
- Test: `mcp-server/src/notion/__tests__/blocks.test.ts` (append)

**Interfaces:**
- Produces:
  - `h2(text: string, emoji?: string): any` — heading_2, emoji는 content prefix
  - `h3(text: string, emoji?: string): any` — heading_3
  - `para(text?: string): any` — paragraph. 빈 문자열 → `rich_text:[]`
  - `hint(text: string): any` — paragraph, `annotations:{color:"gray",italic:true}`
  - `todo(text: string, checked?: boolean): any` — to_do
  - `callout(emoji: string, text: string, color?: string): any` — callout, icon 슬롯, color 기본 `"gray_background"`
  - `divider(): any` — divider

- [ ] **Step 1: 빌더 테스트 작성 (실패 예상)**

`blocks.test.ts` 끝(line 58, 마지막 `});` 뒤)에 추가:

```ts
import { h2, h3, para, hint, todo, callout, divider } from "../blocks.js";

describe("block builders", () => {
  it("h2 prefixes emoji into heading_2 content", () => {
    const b = h2("목표", "🎯");
    expect(b.type).toBe("heading_2");
    expect(b.heading_2.rich_text[0].text.content).toBe("🎯 목표");
  });

  it("h2 without emoji keeps plain text", () => {
    expect(h2("범위").heading_2.rich_text[0].text.content).toBe("범위");
  });

  it("h3 prefixes emoji into heading_3 content", () => {
    expect(h3("달성한 것", "✅").heading_3.rich_text[0].text.content).toBe("✅ 달성한 것");
  });

  it("para('') yields empty rich_text (blank line)", () => {
    expect(para("").paragraph.rich_text).toEqual([]);
    expect(para("hi").paragraph.rich_text[0].text.content).toBe("hi");
  });

  it("hint is a gray italic paragraph", () => {
    const b = hint("(작업하며 작성)");
    expect(b.type).toBe("paragraph");
    expect(b.paragraph.rich_text[0].annotations).toEqual({ color: "gray", italic: true });
  });

  it("todo defaults to unchecked, accepts checked", () => {
    expect(todo("범위").to_do.checked).toBe(false);
    expect(todo("done", true).to_do.checked).toBe(true);
    expect(todo("범위").to_do.rich_text[0].text.content).toBe("범위");
  });

  it("callout puts emoji in icon slot, text in rich_text, gray bg default", () => {
    const b = callout("💡", "안내");
    expect(b.type).toBe("callout");
    expect(b.callout.icon).toEqual({ type: "emoji", emoji: "💡" });
    expect(b.callout.color).toBe("gray_background");
    expect(b.callout.rich_text[0].text.content).toBe("안내");
  });

  it("divider has empty divider object", () => {
    expect(divider()).toEqual({ object: "block", type: "divider", divider: {} });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd mcp-server && npx vitest run src/notion/__tests__/blocks.test.ts`
Expected: FAIL — `h2 is not a function` (또는 import 에러)

- [ ] **Step 3: 빌더 구현**

`blocks.ts` 끝(line 61 뒤)에 추가:

```ts
// ── 구조 가이드형 양식용 저수준 블록 빌더 ──
// heading은 icon 슬롯이 없어 이모지를 content prefix로, callout은 icon 슬롯 사용.

export function h2(text: string, emoji?: string): any {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: emoji ? `${emoji} ${text}` : text } }] },
  };
}

export function h3(text: string, emoji?: string): any {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [{ type: "text", text: { content: emoji ? `${emoji} ${text}` : text } }] },
  };
}

export function para(text = ""): any {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: text ? [{ type: "text", text: { content: text } }] : [] },
  };
}

export function hint(text: string): any {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text }, annotations: { color: "gray", italic: true } }] },
  };
}

export function todo(text: string, checked = false): any {
  return {
    object: "block",
    type: "to_do",
    to_do: { checked, rich_text: [{ type: "text", text: { content: text } }] },
  };
}

export function callout(emoji: string, text: string, color = "gray_background"): any {
  return {
    object: "block",
    type: "callout",
    callout: { icon: { type: "emoji", emoji }, color, rich_text: [{ type: "text", text: { content: text } }] },
  };
}

export function divider(): any {
  return { object: "block", type: "divider", divider: {} };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd mcp-server && npx vitest run src/notion/__tests__/blocks.test.ts`
Expected: PASS (기존 paragraphBlocks 케이스 + 신규 빌더 케이스 전부)

- [ ] **Step 5: 커밋**

```bash
git add mcp-server/src/notion/blocks.ts mcp-server/src/notion/__tests__/blocks.test.ts
git commit -m "feat(notion): 구조 가이드형 저수준 블록 빌더 추가

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: projects 양식 함수 (templates.ts)

**Files:**
- Create: `mcp-server/src/notion/templates.ts`
- Test: `mcp-server/src/notion/__tests__/templates.test.ts`

**Interfaces:**
- Consumes: `h2/h3/para/hint/todo/callout/divider/paragraphBlocks` (Task 1, blocks.ts)
- Produces:
  - `buildStartBody(input: { description: string; stack?: string; repo?: string }): any[]`
  - `buildCloseRetro(input: { today: string; achievement?: string; lessons?: string }): any[]`

- [ ] **Step 1: 테스트 작성 (실패 예상)**

Create `templates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildStartBody, buildCloseRetro } from "../templates.js";

const headings = (blocks: any[]) =>
  blocks.filter((b) => b.type === "heading_2" || b.type === "heading_3")
    .map((b) => (b.heading_2 ?? b.heading_3).rich_text[0].text.content);

describe("buildStartBody", () => {
  it("목표에 description을 채우고 핵심 섹션을 포함한다", () => {
    const b = buildStartBody({ description: "세션 자동 저장" });
    expect(headings(b)).toEqual(["🎯 목표", "📦 범위 (Scope)", "🚧 제약 / 비범위", "📝 진행 메모 / 결정"]);
    // 목표 단락 = description
    const goalPara = b[1];
    expect(goalPara.paragraph.rich_text[0].text.content).toBe("세션 자동 저장");
    // 범위는 to_do 체크리스트
    expect(b.some((x) => x.type === "to_do")).toBe(true);
  });

  it("stack/repo가 있으면 스택 섹션을 추가한다", () => {
    const b = buildStartBody({ description: "d", stack: "TS", repo: "~/x" });
    expect(headings(b)).toContain("🧱 스택 / 환경");
    const texts = b.filter((x) => x.type === "paragraph").map((x) => x.paragraph.rich_text[0]?.text.content);
    expect(texts).toContain("TS");
    expect(texts).toContain("레포: ~/x");
  });

  it("stack/repo가 없으면 스택 섹션을 생략한다", () => {
    expect(headings(buildStartBody({ description: "d" }))).not.toContain("🧱 스택 / 환경");
  });
});

describe("buildCloseRetro", () => {
  it("divider + 회고 heading으로 시작한다", () => {
    const b = buildCloseRetro({ today: "2026-06-23" });
    expect(b[0].type).toBe("divider");
    expect(b[1].heading_2.rich_text[0].text.content).toBe("🏁 회고 (2026-06-23)");
  });

  it("achievement/lessons가 있을 때만 해당 섹션을 넣는다", () => {
    const b = buildCloseRetro({ today: "d", achievement: "완성", lessons: "교훈" });
    expect(headings(b)).toEqual(["🏁 회고 (d)", "✅ 달성한 것", "💡 배운 점", "🔮 다음 액션 / 후속"]);
    const only = buildCloseRetro({ today: "d", achievement: "완성" });
    expect(headings(only)).toEqual(["🏁 회고 (d)", "✅ 달성한 것", "🔮 다음 액션 / 후속"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd mcp-server && npx vitest run src/notion/__tests__/templates.test.ts`
Expected: FAIL — cannot find module `../templates.js`

- [ ] **Step 3: 구현**

Create `templates.ts`:

```ts
/**
 * DB/경로별 본문 양식 함수. blocks.ts 저수준 빌더 + paragraphBlocks를 조합한
 * 순수함수(IO 없음). 반환 배열을 notion.pages.create({children}) /
 * blocks.children.append({children})에 그대로 전달한다.
 */
import { h2, h3, para, hint, todo, callout, divider, paragraphBlocks } from "./blocks.js";
import type { DatabaseName } from "../config.js";

export function buildStartBody(input: { description: string; stack?: string; repo?: string }): any[] {
  const { description, stack, repo } = input;
  const blocks: any[] = [
    h2("목표", "🎯"),
    ...(description ? paragraphBlocks(description) : [hint("(작업하며 작성)")]),
    h2("범위 (Scope)", "📦"),
    todo("(이 프로젝트에서 할 것 — 작업하며 채우기)"),
    todo("(포함 범위 항목)"),
    todo("(포함 범위 항목)"),
    h2("제약 / 비범위", "🚧"),
    callout("💡", "제약(기술/일정/리소스)·하지 않을 것을 적어두면 범위 크리프를 막습니다. (작업하며 작성)"),
  ];
  if (stack || repo) {
    blocks.push(h2("스택 / 환경", "🧱"));
    if (stack) blocks.push(para(stack));
    if (repo) blocks.push(para(`레포: ${repo}`));
  }
  blocks.push(
    h2("진행 메모 / 결정", "📝"),
    callout("💡", "진행하며 떠오른 메모·중간 결정을 시간순으로. 중요 결정은 Decision Log, 재사용 지식은 Knowledge Base로 별도 저장됩니다."),
    para(""),
  );
  return blocks;
}

export function buildCloseRetro(input: { today: string; achievement?: string; lessons?: string }): any[] {
  const { today, achievement, lessons } = input;
  const blocks: any[] = [divider(), h2(`회고 (${today})`, "🏁")];
  if (achievement) blocks.push(h3("달성한 것", "✅"), ...paragraphBlocks(achievement));
  if (lessons) blocks.push(h3("배운 점", "💡"), ...paragraphBlocks(lessons));
  blocks.push(h3("다음 액션 / 후속", "🔮"), callout("💡", "이어서 할 일·미해결 이슈가 있으면 적어두세요. (없으면 비워둠)"));
  return blocks;
}
```

> 주: `DatabaseName` import는 Task 4(`buildScaffold`)에서 사용. Task 2 시점에 미사용 import 경고를 피하려면 Task 4까지 import 라인을 생략하거나, Task 2에서 추가하되 Task 4를 같은 PR로 묶어 처리. (tsc `noUnusedLocals` 미설정이면 무해 — `tsconfig` 확인 후 결정. 미설정이 기본.)

- [ ] **Step 4: 통과 확인**

Run: `cd mcp-server && npx vitest run src/notion/__tests__/templates.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add mcp-server/src/notion/templates.ts mcp-server/src/notion/__tests__/templates.test.ts
git commit -m "feat(notion): projects 양식 함수(buildStartBody/buildCloseRetro)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: KB 스캐폴드 (buildKbScaffold)

**Files:**
- Modify: `mcp-server/src/notion/templates.ts` (append)
- Test: `mcp-server/src/notion/__tests__/templates.test.ts` (append)

**Interfaces:**
- Produces: `buildKbScaffold(input: { summary?: string; category?: string }): any[]`

- [ ] **Step 1: 테스트 추가 (실패 예상)**

`templates.test.ts`에 추가:

```ts
import { buildKbScaffold } from "../templates.js";

describe("buildKbScaffold", () => {
  const h3labels = (b: any[]) => b.filter((x) => x.type === "heading_3").map((x) => x.heading_3.rich_text[0].text.content);

  it("문제해결 category는 문제/원인/해결 라벨을 쓴다", () => {
    expect(h3labels(buildKbScaffold({ category: "문제해결" }))).toEqual(["문제", "원인", "해결"]);
  });

  it("디버깅/아키텍처도 전용 라벨을 쓴다", () => {
    expect(h3labels(buildKbScaffold({ category: "디버깅" }))).toEqual(["증상", "원인", "조치"]);
    expect(h3labels(buildKbScaffold({ category: "아키텍처" }))).toEqual(["배경", "구조", "트레이드오프"]);
  });

  it("그 외 category와 미지정은 공통 라벨(핵심/근거·맥락)로 fallback", () => {
    expect(h3labels(buildKbScaffold({ category: "기타" }))).toEqual(["핵심", "근거·맥락"]);
    expect(h3labels(buildKbScaffold({}))).toEqual(["핵심", "근거·맥락"]);
  });

  it("summary가 있으면 첫 callout에 채운다", () => {
    const b = buildKbScaffold({ summary: "한 줄 요약" });
    expect(b[0].type).toBe("callout");
    expect(b[0].callout.rich_text[0].text.content).toBe("한 줄 요약");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd mcp-server && npx vitest run src/notion/__tests__/templates.test.ts -t buildKbScaffold`
Expected: FAIL — `buildKbScaffold is not exported`

- [ ] **Step 3: 구현**

`templates.ts`에 추가:

```ts
const KB_DETAIL_LABELS: Record<string, string[]> = {
  "문제해결": ["문제", "원인", "해결"],
  "디버깅": ["증상", "원인", "조치"],
  "아키텍처": ["배경", "구조", "트레이드오프"],
};

function kbDetailLabels(category?: string): string[] {
  return (category && KB_DETAIL_LABELS[category]) || ["핵심", "근거·맥락"];
}

export function buildKbScaffold(input: { summary?: string; category?: string }): any[] {
  const { summary, category } = input;
  const blocks: any[] = [
    callout("💡", summary || "한 줄로 핵심을 적으세요 (테이블 summary와 동일 역할)"),
    h2("상세", "📖"),
  ];
  for (const label of kbDetailLabels(category)) {
    blocks.push(h3(label), hint("(작업하며 작성)"));
  }
  blocks.push(
    h2("액션·후속", "✅"),
    todo("(필요 시) 후속 작업 / 검증 항목"),
    h2("관련", "🔗"),
    hint("(관련 자료 URL / 페이지 멘션)"),
  );
  return blocks;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd mcp-server && npx vitest run src/notion/__tests__/templates.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add mcp-server/src/notion/templates.ts mcp-server/src/notion/__tests__/templates.test.ts
git commit -m "feat(notion): KB category 맞춤 스캐폴드(buildKbScaffold)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: record 스캐폴드 분기 (buildScaffold)

**Files:**
- Modify: `mcp-server/src/notion/templates.ts` (append)
- Test: `mcp-server/src/notion/__tests__/templates.test.ts` (append)

**Interfaces:**
- Consumes: `buildStartBody`(Task2), `buildKbScaffold`(Task3), `DatabaseName`(config.ts)
- Produces: `buildScaffold(db: DatabaseName, props?: any): any[]`

- [ ] **Step 1: 테스트 추가 (실패 예상)**

`templates.test.ts`에 추가:

```ts
import { buildScaffold } from "../templates.js";

describe("buildScaffold", () => {
  it("projects는 buildStartBody와 동형(목표 heading 포함)", () => {
    const b = buildScaffold("projects", { description: "목표값" });
    expect(b[0].heading_2.rich_text[0].text.content).toBe("🎯 목표");
  });

  it("decisionLog는 결정/근거/대안/영향 섹션", () => {
    const b = buildScaffold("decisionLog", { rationale: "근거값", alternatives: "A, B" });
    const hs = b.filter((x) => x.type === "heading_2").map((x) => x.heading_2.rich_text[0].text.content);
    expect(hs).toEqual(["🎯 결정", "🧭 근거", "🔀 검토한 대안", "📊 영향·결과"]);
    // alternatives 'A, B' → to_do 2개(첫 항목 checked)
    const todos = b.filter((x) => x.type === "to_do");
    expect(todos[0].to_do.checked).toBe(true);
    expect(todos[0].to_do.rich_text[0].text.content).toBe("A");
  });

  it("decisionLog status=폐기는 영향 섹션 헤더를 바꾼다", () => {
    const b = buildScaffold("decisionLog", { status: "폐기" });
    const hs = b.filter((x) => x.type === "heading_2").map((x) => x.heading_2.rich_text[0].text.content);
    expect(hs).toContain("📊 폐기 사유·대체 결정");
  });

  it("knowledgeBase는 buildKbScaffold로 위임", () => {
    expect(buildScaffold("knowledgeBase", { category: "디버깅" })
      .filter((x) => x.type === "heading_3").map((x) => x.heading_3.rich_text[0].text.content))
      .toEqual(["증상", "원인", "조치"]);
  });

  it("references는 url이 있으면 링크 섹션을 생략", () => {
    const withUrl = buildScaffold("references", { summary: "s", url: "http://x" });
    const noUrl = buildScaffold("references", { summary: "s" });
    const hh = (b: any[]) => b.filter((x) => x.type === "heading_2").map((x) => x.heading_2.rich_text[0].text.content);
    expect(hh(withUrl)).not.toContain("🔗 링크");
    expect(hh(noUrl)).toContain("🔗 링크");
  });

  it("preferences는 최소 1섹션", () => {
    const b = buildScaffold("preferences", { content: "규칙" });
    expect(b[0].heading_2.rich_text[0].text.content).toBe("⚙️ 선호 내용");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd mcp-server && npx vitest run src/notion/__tests__/templates.test.ts -t buildScaffold`
Expected: FAIL — `buildScaffold is not exported`

- [ ] **Step 3: 구현**

`templates.ts`에 추가 (상단 import에 `DatabaseName`이 이미 있어야 함 — Task 2 주석 참조):

```ts
function altBlocks(alternatives?: string): any[] {
  const items = (alternatives || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (items.length) return items.map((a, i) => todo(a, i === 0)); // 첫 항목 = 채택 가정
  return [todo("대안 A — 왜 선택하지 않았는지"), todo("대안 B — 비교 포인트")];
}

export function buildScaffold(db: DatabaseName, props: any = {}): any[] {
  const fillOr = (val: string | undefined, hintText: string) =>
    val && val.trim() ? para(val) : callout("💡", hintText);

  switch (db) {
    case "projects":
      return buildStartBody({ description: props.description ?? "", stack: props.stack, repo: props.repo });

    case "decisionLog":
      return [
        h2("결정", "🎯"),
        props.description ? para(props.description) : hint("(무엇을 확정했는지 한 문장으로 — 제목을 풀어서)"),
        h2("근거", "🧭"),
        fillOr(props.rationale, "이 결정의 배경·전제·트레이드오프 — 무엇을 우선했고 무엇을 포기했는지 (props rationale은 한 줄 요약)"),
        h2("검토한 대안", "🔀"),
        ...altBlocks(props.alternatives),
        h2(props.status === "폐기" ? "폐기 사유·대체 결정" : "영향·결과", "📊"),
        ...(props.impact ? [todo(`🏆 ${props.impact}`, true)] : []),
        todo("영향 받는 영역: (작업하며 작성)"),
        todo("후속 확인/롤백 조건: (작업하며 작성)"),
      ];

    case "knowledgeBase":
      return buildKbScaffold({ summary: props.summary, category: props.category });

    case "references":
      return [
        ...(props.url ? [] : [h2("링크", "🔗"), hint("(링크: 작업하며 붙여넣기)")]),
        h2("핵심 요약", "📄"),
        fillOr(props.summary, "이 자료가 무엇인지 1~2줄"),
        h2("왜 중요한가 / 발췌", "💬"),
        callout("💡", "저장 이유 + 핵심 인용·발췌. 나중에 이 자료를 다시 찾을 이유가 한눈에 보이게."),
      ];

    case "preferences":
      return [h2("선호 내용", "⚙️"), fillOr(props.content ?? props.description, "AI 사용 선호/피드백")];

    default:
      return [];
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd mcp-server && npx vitest run src/notion/__tests__/templates.test.ts`
Expected: PASS (Task 2~4 전체)

- [ ] **Step 5: 커밋**

```bash
git add mcp-server/src/notion/templates.ts mcp-server/src/notion/__tests__/templates.test.ts
git commit -m "feat(notion): record용 db별 buildScaffold 분기

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: start.ts 연결 + 테스트 갱신

**Files:**
- Modify: `mcp-server/src/tools/start.ts:54-71` (children 인라인 → 함수)
- Modify: `mcp-server/src/tools/__tests__/start.test.ts:56-57` (heading 기대값)

**Interfaces:**
- Consumes: `buildStartBody`(Task 2)

- [ ] **Step 1: start.test.ts heading 기대값 갱신 (먼저 실패하도록)**

`start.test.ts:56-57`을 교체:

```ts
    expect(headings).toContain("🎯 목표");
    expect(headings).toContain("📦 범위 (Scope)");
```

- [ ] **Step 2: 실패 확인 (구현 전이라 기존 인라인 '목표'와 불일치)**

Run: `cd mcp-server && npx vitest run src/tools/__tests__/start.test.ts`
Expected: FAIL — `expected [ '목표', '범위', ... ] to contain '🎯 목표'`

- [ ] **Step 3: start.ts 구현 교체**

`start.ts` 상단 import에 추가:
```ts
import { buildStartBody } from "../notion/templates.js";
```

`start.ts:59-68`의 인라인 `children: [ ... ]` 배열을 교체:
```ts
            children: buildStartBody({ description, stack, repo }),
```

(주변 `notion.pages.create({ parent, properties: projectProps, children: ... })` 구조 유지)

- [ ] **Step 4: 통과 확인**

Run: `cd mcp-server && npx vitest run src/tools/__tests__/start.test.ts`
Expected: PASS (두 페이지 생성 / 템플릿 블록 / Decision Log / 캐시 케이스 모두)

- [ ] **Step 5: 커밋**

```bash
git add mcp-server/src/tools/start.ts mcp-server/src/tools/__tests__/start.test.ts
git commit -m "feat(start): 본문을 buildStartBody 구조 가이드형 양식으로 교체

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: close.ts 연결

**Files:**
- Modify: `mcp-server/src/tools/close.ts:67-99` (retroBlocks 인라인 → 함수)
- Test: `mcp-server/src/tools/__tests__/close.test.ts` (기존 회귀 확인, 필요 시 heading 기대값 갱신)

**Interfaces:**
- Consumes: `buildCloseRetro`(Task 2)

- [ ] **Step 1: close.test.ts 회귀 기준 확인**

Run: `cd mcp-server && npx vitest run src/tools/__tests__/close.test.ts`
먼저 현재 통과 상태와, 회고 heading 텍스트("회고")를 검증하는 케이스가 있는지 확인.
- 만약 `"회고"` 정확 매칭 검증이 있으면 `"🏁 회고 (<날짜>)"` 형태로 기대값 갱신(이모지+날짜 포함). `toContain` 부분일치면 패턴을 `expect.stringContaining("회고")`로.

- [ ] **Step 2: close.ts 구현 교체**

`close.ts` 상단 import에 추가:
```ts
import { buildCloseRetro } from "../notion/templates.js";
```

`close.ts:68-99`의 `if (achievement || lessons) { const retroBlocks = [...]; ... append(...) }` 블록에서 인라인 `retroBlocks` 구성을 교체:
```ts
      if (achievement || lessons) {
        const retroBlocks = buildCloseRetro({ today, achievement, lessons });

        await callNotion(
          () =>
            notion.blocks.children.append({
              block_id: projectPage.id,
              children: retroBlocks,
            }),
          { operation: "close.blocks.append" }
        );
      }
```

- [ ] **Step 3: 통과 확인**

Run: `cd mcp-server && npx vitest run src/tools/__tests__/close.test.ts`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add mcp-server/src/tools/close.ts mcp-server/src/tools/__tests__/close.test.ts
git commit -m "feat(close): 회고 본문을 buildCloseRetro 양식으로 교체

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: note.ts 연결 (content optional + KB 스캐폴드)

**Files:**
- Modify: `mcp-server/src/tools/note.ts:25` (content optional), `:91-93` (children 분기)
- Test: `mcp-server/src/tools/__tests__/note.test.ts` (빈 content 케이스 추가)

**Interfaces:**
- Consumes: `buildKbScaffold`(Task 3), `paragraphBlocks`(blocks.ts)

- [ ] **Step 1: 빈 content 스캐폴드 테스트 추가 (실패 예상)**

`note.test.ts` 끝(line 127 `});` 앞)에 추가:

```ts
  it("content가 없으면 category 맞춤 스캐폴드를 주입한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "n", url: "u" });

    await handler({ title: "디버그 노트", category: "디버깅" });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    const h3s = createCall.children
      .filter((b: any) => b.type === "heading_3")
      .map((b: any) => b.heading_3.rich_text[0].text.content);
    expect(h3s).toEqual(["증상", "원인", "조치"]);
  });

  it("content가 있으면 기존대로 paragraph만 만든다 (회귀)", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "n", url: "u" });

    await handler({ title: "t", content: "본문" });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.children.length).toBe(1);
    expect(createCall.children[0].type).toBe("paragraph");
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd mcp-server && npx vitest run src/tools/__tests__/note.test.ts`
Expected: FAIL — content 없는 호출에서 children이 빈 배열(또는 zod 필수 위반)

- [ ] **Step 3: note.ts 구현**

`note.ts:25` content를 optional로:
```ts
  content: z.string().optional().describe("메모 내용 (본문 markdown). 없으면 category 맞춤 스캐폴드 주입."),
```

`note.ts` 상단 import에 추가:
```ts
import { buildKbScaffold } from "../notion/templates.js";
```

`note.ts:91-93` children 생성 교체:
```ts
      // content 있으면 paragraph 변환, 없으면 category 맞춤 스캐폴드 주입.
      const children = content?.trim()
        ? paragraphBlocks(content)
        : buildKbScaffold({ summary, category });
```

(이후 `cachePage`의 `text: content || title`은 그대로 — 스캐폴드 placeholder는 캐시에 안 들어감)

- [ ] **Step 4: 통과 확인**

Run: `cd mcp-server && npx vitest run src/tools/__tests__/note.test.ts`
Expected: PASS (기존 6케이스 + 신규 2케이스)

- [ ] **Step 5: 커밋**

```bash
git add mcp-server/src/tools/note.ts mcp-server/src/tools/__tests__/note.test.ts
git commit -m "feat(note): content optional + 빈 경우 KB category 스캐폴드 주입

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: record.ts 연결 (scaffold opt-in)

**Files:**
- Modify: `mcp-server/src/tools/record.ts:80-84`(scaffold 플래그), `:116`(구조분해), `:147`(children 분기)
- Test: `mcp-server/src/tools/__tests__/record.test.ts` (scaffold 케이스 추가)

**Interfaces:**
- Consumes: `buildScaffold`(Task 4), `paragraphBlocks`(blocks.ts)

- [ ] **Step 1: scaffold 케이스 테스트 추가 (실패 예상)**

`record.test.ts` 적절한 describe 안(파일 끝 `});` 앞)에 추가:

```ts
  it("scaffold=true + content 없음이면 db별 스캐폴드를 주입한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "r", url: "u" });

    await handler({ db: "decisionLog", title: "결정", scaffold: true });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    const hs = createCall.children
      .filter((b: any) => b.type === "heading_2")
      .map((b: any) => b.heading_2.rich_text[0].text.content);
    expect(hs).toContain("🎯 결정");
  });

  it("scaffold=true여도 content가 있으면 content 우선(스캐폴드 무시)", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "r", url: "u" });

    await handler({ db: "decisionLog", title: "t", content: "내 본문", scaffold: true });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.children.every((b: any) => b.type === "paragraph")).toBe(true);
  });

  it("scaffold 미지정 + content 없음이면 children 없음(현행 회귀)", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "r", url: "u" });

    await handler({ db: "decisionLog", title: "t" });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.children).toBeUndefined();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd mcp-server && npx vitest run src/tools/__tests__/record.test.ts`
Expected: FAIL — scaffold=true 케이스에서 children 없음

- [ ] **Step 3: record.ts 구현**

`record.ts` 상단 import에 추가:
```ts
import { buildScaffold } from "../notion/templates.js";
```

`record.ts` `RecordInput`의 최상위(allowNewTags 뒤, `:80-83` 인근)에 추가:
```ts
  scaffold: z
    .boolean()
    .optional()
    .describe("content가 비었을 때만 해당 db 특성에 맞는 구조 가이드형 본문 스캐폴드를 주입. 기본 false. content가 있으면 무시(입력 본문 우선)."),
```

핸들러 구조분해(`record.ts:116`)에 `scaffold` 추가:
```ts
    async ({ db, title, content, properties, allowNewTags, scaffold }) => {
```

`record.ts:147` children 생성 교체:
```ts
      const children = content?.trim()
        ? paragraphBlocks(content)
        : (scaffold ? buildScaffold(db as DatabaseName, properties ?? {}) : []);
```

(이후 `...(children.length > 0 ? { children } : {})` 가드는 그대로 — 스캐폴드 미주입 시 children 키 생략)

- [ ] **Step 4: 통과 확인**

Run: `cd mcp-server && npx vitest run src/tools/__tests__/record.test.ts`
Expected: PASS (기존 케이스 회귀 0 + 신규 3케이스)

- [ ] **Step 5: 커밋**

```bash
git add mcp-server/src/tools/record.ts mcp-server/src/tools/__tests__/record.test.ts
git commit -m "feat(record): scaffold opt-in 플래그로 db별 본문 양식 주입

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 전체 빌드 + 회귀 검증

**Files:** (없음 — 검증만)

- [ ] **Step 1: 전체 테스트**

Run: `cd mcp-server && npx vitest run`
Expected: PASS (전체 스위트 — 신규 포함, 회귀 0)

- [ ] **Step 2: 타입 빌드**

Run: `cd mcp-server && npm run build`
Expected: tsc 오류 0, `dist/` 갱신

- [ ] **Step 3: 최종 확인 커밋 (필요 시 — dist는 보통 gitignore)**

`git status`로 의도치 않은 변경 없음 확인. dist가 추적 대상이 아니면 추가 커밋 불필요.

---

## Self-Review (작성자 점검 완료)

- **Spec coverage**: §4.1 빌더→T1, §4.2/§5.1-5.2 projects→T2, §5.4 KB→T3, §6 buildScaffold/§5.3/5.5/§8→T4, start→T5, close→T6, note(§7)→T7, record(§6 D4)→T8, §11 빌드/회귀→T9. preferences(§8) = T4 preferences 분기 + 기본 미적용(record는 scaffold 없으면 본문 0). 누락 없음.
- **Placeholder scan**: 모든 step에 실제 코드/명령/예상 출력 포함. "적절히 처리" 류 없음.
- **Type consistency**: `buildStartBody/buildCloseRetro/buildKbScaffold/buildScaffold` 시그니처가 T2-4 정의와 T5-8 호출에서 일치. `DatabaseName`은 config.ts(record.ts가 이미 import). `props.stack/description/rationale/alternatives/summary/category/url/content`는 record `RecordInput.properties` 키와 일치.

## 참조
- Spec: `docs/02-design/features/notion-save-form-templates.design.md`
- 코드 컨벤션: `mcp-server/AGENTS.md`, `AGENTS.md`
