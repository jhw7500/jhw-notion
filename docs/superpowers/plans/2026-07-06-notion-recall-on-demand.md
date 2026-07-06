# On-Demand Notion Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프롬프트에 마커(`노션참고`/`@notion`)나 조회 의도가 있을 때만 지금 작업 주제에 맞는 노션 기록(결정·지식·문서)을 자동 조회해 참고하게 한다.

**Architecture:** 3계층 — (1) UserPromptSubmit 훅이 마커 감지 시 `[NOTION-RECALL]` 리마인더 주입(결정론적 트리거), (2) `CLAUDE-notion.md` 지침이 조회/저장/코드수정 의도를 3-way 구분하고 모델이 주제를 뽑아 조회하게 함(의미적 관련성), (3) 신규 `jhw_retrieve` MCP 도구가 `decisionLog+knowledgeBase+references`를 주제로 검색해 본문 스니펫까지 반환. Phase 0(훅+지침, 기존 `notion-search→notion-fetch`로 즉시 동작)과 Phase 1(`jhw_retrieve` 신설)로 나뉘며 계층이라 충돌 없음.

**Tech Stack:** TypeScript(ESM, NodeNext), `@modelcontextprotocol/sdk`, `@notionhq/client` v5(`dataSources`), `zod`, `vitest`. 훅은 Python 3(표준 라이브러리만).

**Design Ref:** `docs/superpowers/specs/2026-07-06-notion-recall-on-demand-design.md`

## Global Constraints

- **브랜치**: 모든 커밋은 `feat/notion-recall` 브랜치에서. `main` 직접 커밋 금지(사용자 git 규칙).
- **테스트 러너**: `mcp-server/`에서 `npx vitest run <path>` (package.json `test` = `vitest run`).
- **ESM import**: 로컬 import는 반드시 `.js` 확장자(예: `../config.js`). NodeNext 규약.
- **도구 등록 패턴**: `server.tool(name, description, ZodSchema.shape, async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(...) }] }))` + `export function registerX(server: McpServer)`.
- **Notion 안정성 레이어**: 모든 Notion 호출은 `callNotion(() => notion.xxx(...), { operation })` 경유(retry/rate-limit).
- **DB IDs (config.ts, 검증됨)**: decisionLog=`6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd`, knowledgeBase=`ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461`, references=`979a9412-73d9-4fa4-be0e-cbcafc0a2505`.
- **훅 escape**: 사용자가 `#noreminder`/`#nr`/`#raw`/`#silent`/`#조용히` prefix를 쓰면 훅 주입 스킵(기존 관례).
- **범위 최소화**: 요청 외 리팩토링/주석정리 금지. 기존 파일은 명시된 라인만 수정.

## File Structure

- **Create** `/home/jhw/.claude/hooks/notion-recall-trigger-hook.py` — 마커 감지 → `[NOTION-RECALL]` 리마인더(UserPromptSubmit, stdout)
- **Create** `mcp-server/src/tools/retrieve.ts` — `jhw_retrieve` 도구 (한 파일, 단일 책임: 주제 조회)
- **Create** `mcp-server/src/tools/__tests__/retrieve.test.ts` — 도구 단위 테스트
- **Modify** `mcp-server/src/server.ts` — `registerRetrieve` import + 호출
- **Modify** `/home/jhw/.claude/settings.json` — UserPromptSubmit에 신규 훅 등록 + PostToolUse info-matcher에 `jhw_retrieve` 추가
- **Modify** `/home/jhw/.claude/hooks/post-info-tool-continuation-hook.py` — `INFO_TOOL_SUBSTRINGS`에 `jhw_retrieve` 추가
- **Modify** `/home/jhw/.claude/CLAUDE-notion.md` — "온디맨드 노션 조회" 지침 섹션 추가

---

## Task 1: NOTION-RECALL 트리거 훅 생성 (Phase 0)

**Files:**
- Create: `/home/jhw/.claude/hooks/notion-recall-trigger-hook.py`

**Interfaces:**
- Consumes: Claude Code `UserPromptSubmit` hook JSON on stdin (`payload["prompt"]`).
- Produces: 마커 감지 시 stdout에 `<system-reminder>[NOTION-RECALL]…</system-reminder>` 텍스트(UserPromptSubmit stdout은 컨텍스트에 주입됨). 미감지 시 빈 출력.

- [ ] **Step 1: 훅 스크립트 작성**

Create `/home/jhw/.claude/hooks/notion-recall-trigger-hook.py`:

```python
#!/usr/bin/env python3
"""
Notion Recall Trigger Hook (UserPromptSubmit)

프롬프트에 조회 마커('노션참고'/'노션 참고'/'@notion')가 있으면, 모델이 되묻거나
추측하기 전에 먼저 관련 노션 기록을 조회하도록 [NOTION-RECALL] system-reminder를 주입한다.

- 입력(stdin): Claude Code UserPromptSubmit hook JSON
- 출력(stdout): 마커 감지 시 reminder 텍스트. 미감지 시 빈 출력.

Design Ref: docs/superpowers/specs/2026-07-06-notion-recall-on-demand-design.md §4.1
"""
import json
import re
import sys

ESCAPE_PREFIXES = ("#noreminder", "#nr", "#raw", "#silent", "#조용히")

# '노션참고' / '노션 참고' / '@notion' (case-insensitive)
MARKER_RE = re.compile(r"(@notion|노션\s*참고)", re.IGNORECASE)

REMINDER = """<system-reminder>
[NOTION-RECALL] 노션 참고 요청 감지됨.

지금 프롬프트의 핵심 '주제'를 뽑아, 되묻거나 추측하기 전에 먼저 관련 노션 기록
(결정·근거 / 재사용 지식 / 외부문서)을 조회하고 그 내용을 근거로 작업하라.

- 우선 `mcp__jhw-notion__jhw_retrieve` 호출 (topic=핵심 주제, 식별되면 project 지정).
  도구가 없으면 `mcp__notion__notion-search` → 관련 후보 `mcp__notion__notion-fetch`.
- 독립 조회는 병렬로.
- 조회 근거(제목/URL)를 1줄로 보고한 뒤 작업을 이어간다.
- 조회로도 불충분하면 그때 사용자에게 무엇이 불명확한지 물어라.

맥락상 '노션에 저장'(기록)·'노션 MCP 코드 수정' 요청이면 이 reminder는 무시.
</system-reminder>"""


def is_escape_prefixed(text: str) -> bool:
    lowered = text.lstrip().lower()
    return any(lowered.startswith(p) for p in ESCAPE_PREFIXES)


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return 0

    prompt = (
        payload.get("prompt")
        or payload.get("user_prompt")
        or payload.get("message")
        or ""
    )
    if not isinstance(prompt, str):
        return 0

    text = prompt.strip()
    if not text or is_escape_prefixed(text):
        return 0

    if MARKER_RE.search(text):
        sys.stdout.write(REMINDER)
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: 실행 권한 부여**

Run:
```bash
chmod +x /home/jhw/.claude/hooks/notion-recall-trigger-hook.py
```

- [ ] **Step 3: 마커 감지 케이스 검증 (실패 없어야 함 = reminder 출력)**

Run:
```bash
echo '{"prompt":"노션참고 CAM i2c 타임아웃 예전에 어떻게 했지?"}' | python3 /home/jhw/.claude/hooks/notion-recall-trigger-hook.py
```
Expected: `<system-reminder>` 로 시작하는 `[NOTION-RECALL]` 텍스트 출력.

Run (공백 변형 + @notion):
```bash
echo '{"prompt":"이거 @notion 에서 찾아줘"}' | python3 /home/jhw/.claude/hooks/notion-recall-trigger-hook.py
echo '{"prompt":"노션 참고해서 정리해줘"}' | python3 /home/jhw/.claude/hooks/notion-recall-trigger-hook.py
```
Expected: 둘 다 reminder 출력.

- [ ] **Step 4: 비감지/escape 케이스 검증 (빈 출력이어야 함)**

Run:
```bash
echo '{"prompt":"노션에 저장해줘"}' | python3 /home/jhw/.claude/hooks/notion-recall-trigger-hook.py
echo '{"prompt":"CAM 드라이버 고쳐줘"}' | python3 /home/jhw/.claude/hooks/notion-recall-trigger-hook.py
echo '{"prompt":"#noreminder 노션참고 이건 무시"}' | python3 /home/jhw/.claude/hooks/notion-recall-trigger-hook.py
```
Expected: 셋 다 **빈 출력**(아무 텍스트 없음).
> 주의: "노션에 저장해줘"는 `노션\s*참고` 패턴에 안 걸리므로 정상적으로 빈 출력. "CAM 드라이버 고쳐줘"엔 마커 없음.

- [ ] **Step 5: Commit**

```bash
git add /home/jhw/.claude/hooks/notion-recall-trigger-hook.py
```
> 훅은 `~/.claude` 소속이라 이 저장소 git에 없을 수 있음. `~/.claude`가 별도 git repo면 거기서 커밋, 아니면 이 단계는 스킵하고 파일 존재만 확인.

---

## Task 2: 훅을 settings.json에 등록 (Phase 0)

**Files:**
- Modify: `/home/jhw/.claude/settings.json` (UserPromptSubmit hooks 배열)

**Interfaces:**
- Consumes: Task 1의 훅 스크립트 경로.
- Produces: 매 프롬프트마다 훅 실행(마커 있을 때만 주입).

- [ ] **Step 1: UserPromptSubmit에 훅 추가**

`/home/jhw/.claude/settings.json`에서 아래 블록을 찾아 교체.

Find:
```json
          {
            "type": "command",
            "command": "python3 /home/jhw/.claude/hooks/general-continuation-hook.py"
          },
          {
            "type": "command",
            "command": "python3 /home/jhw/.claude/scripts/timestamp-hook.py prompt"
          }
```
Replace:
```json
          {
            "type": "command",
            "command": "python3 /home/jhw/.claude/hooks/general-continuation-hook.py"
          },
          {
            "type": "command",
            "command": "python3 /home/jhw/.claude/hooks/notion-recall-trigger-hook.py"
          },
          {
            "type": "command",
            "command": "python3 /home/jhw/.claude/scripts/timestamp-hook.py prompt"
          }
```

- [ ] **Step 2: JSON 유효성 검증**

Run:
```bash
python3 -c "import json; json.load(open('/home/jhw/.claude/settings.json')); print('settings.json OK')"
```
Expected: `settings.json OK`

- [ ] **Step 3: 훅 등록 확인**

Run:
```bash
python3 -c "import json; d=json.load(open('/home/jhw/.claude/settings.json')); cmds=[h['command'] for g in d['hooks']['UserPromptSubmit'] for h in g['hooks']]; print('registered' if any('notion-recall-trigger' in c for c in cmds) else 'MISSING')"
```
Expected: `registered`

- [ ] **Step 4: Commit** (settings.json이 git 관리 대상이면)

```bash
git add /home/jhw/.claude/settings.json  # ~/.claude repo 기준
```

---

## Task 3: CLAUDE-notion.md에 온디맨드 조회 지침 추가 (Phase 0)

**Files:**
- Modify: `/home/jhw/.claude/CLAUDE-notion.md` (신규 섹션)

**Interfaces:**
- Consumes: `jhw_retrieve`(Task 4에서 생성, 미존재 시 fallback 명시) + 기존 `notion-search`/`notion-fetch`.
- Produces: 모델이 마커/조회의도에서 조회를 수행하고 저장·코드수정과 구분하는 행동 규칙.

- [ ] **Step 1: 지침 섹션 삽입**

`/home/jhw/.claude/CLAUDE-notion.md`의 "## 저장 흐름 규칙" 섹션 **바로 앞**에 아래를 삽입.

Find:
```markdown
## 저장 흐름 규칙
```
Replace:
```markdown
## 온디맨드 노션 조회 (참고용)

**트리거**:
1. (보장) 프롬프트에 마커 `노션참고`/`노션 참고`/`@notion` 존재 시 — 훅이 `[NOTION-RECALL]` 리마인더로 강제.
2. (보조·모델판단) 사용자가 명확히 **조회/참고 의도**를 보일 때 — "노션에서 찾아/참고/조회", "예전에 이거 어떻게 했더라(프로젝트 지식)", "관련 결정 있었나".

**의도 3-way 구분 (오발 방지, 필수)**:
- **조회(retrieve)** → 본 규칙 발동.
- **저장(save)** "노션에 저장/기록해줘" → 저장 흐름 규칙(아래). 본 규칙 발동 안 함.
- **코드수정** "노션 MCP 코드 고쳐줘" → 이 저장소 코드 작업. 본 규칙 발동 안 함.

**동작**:
1. 프롬프트에서 **주제 키워드**(작업 대상·기술·증상 등)를 뽑는다.
2. `mcp__jhw-notion__jhw_retrieve`를 호출한다(`topic`=주제, 프로젝트가 식별되면 `project` 지정). 도구가 없으면 `mcp__notion__notion-search` → 관련 후보를 `mcp__notion__notion-fetch`로 본문 조회.
3. 반환 내용을 근거로 작업을 수행한다.
4. **무엇을 근거로 삼았는지 1줄 보고**(제목/URL 포함).
5. 조회로도 불충분하면 그때 사용자에게 질문(무엇을 찾았고 무엇이 여전히 불명확한지 명시).
- 독립적인 조회는 **병렬** 호출. 적용 안 함: 코드/파일에서 즉시 확인되는 것, 일반 지식, 이번 세션에서 이미 확정된 것.

---

## 저장 흐름 규칙
```

- [ ] **Step 2: 삽입 확인**

Run:
```bash
grep -n "온디맨드 노션 조회" /home/jhw/.claude/CLAUDE-notion.md
```
Expected: 해당 헤딩 라인 1건 출력.

- [ ] **Step 3: Commit** (CLAUDE-notion.md가 git 관리 대상이면)

```bash
git add /home/jhw/.claude/CLAUDE-notion.md
```

> **여기까지 Phase 0 완료 — 마커/의도로 `notion-search→notion-fetch` 기반 조회가 즉시 동작.**

---

## Task 4: jhw_retrieve 도구 구현 (Phase 1)

**Files:**
- Create: `mcp-server/src/tools/retrieve.ts`
- Test: `mcp-server/src/tools/__tests__/retrieve.test.ts`

**Interfaces:**
- Consumes: `getNotionClient()`(`../notion-client.js`), `callNotion`(`../notion/api.js`), `resolveProjectId`(`../notion/resolve-project.js`), `NOTION_CONFIG`/`DatabaseName`(`../config.js`).
- Produces: `export function registerRetrieve(server: McpServer)`. 도구 `jhw_retrieve` 반환 JSON:
  `{ topic, project: string|null, used: "notion"|"empty", count, truncated, results: Array<{ db, title, summary, snippet, url, project: boolean, date, category, tags: string[], status }> }`.

- [ ] **Step 1: 실패하는 테스트 작성**

Create `mcp-server/src/tools/__tests__/retrieve.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerRetrieve } from "../retrieve.js";

const KB_ID = "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
const DEC_ID = "6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd";

function kbPage(id: string, title: string, projectRelId?: string) {
  return {
    id,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: KB_ID },
    properties: {
      title: { title: [{ plain_text: title }] },
      summary: { rich_text: [{ plain_text: `${title} 요약` }] },
      category: { select: { name: "문제해결" } },
      tags: { multi_select: [{ name: "i2c" }] },
      date: { date: { start: "2026-05-01" } },
      ...(projectRelId ? { project: { relation: [{ id: projectRelId }] } } : {}),
    },
  };
}

describe("jhw_retrieve", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerRetrieve(server as any);
    handler = capturedTools.get("jhw_retrieve")!.handler;
  });

  it("검색 결과가 없으면 used=empty, count=0을 반환한다", async () => {
    mockClient.search.mockResolvedValue({ results: [] });

    const result = await handler({ topic: "없는주제" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.used).toBe("empty");
    expect(parsed.count).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it("대상 DB(결정/지식/문서)에 속한 페이지만 유지한다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        kbPage("kb-1", "i2c 재시도"),
        { id: "x", url: "u", parent: { type: "page_id", page_id: "p" }, properties: {} },
      ],
    });
    mockClient.blocks.children.list.mockResolvedValue({ results: [] });

    const result = await handler({ topic: "i2c" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(1);
    expect(parsed.results[0].db).toBe("knowledgeBase");
    expect(parsed.results[0].title).toBe("i2c 재시도");
  });

  it("project 제공 시 해당 프로젝트 기록을 상위로 부스트한다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        kbPage("kb-a", "무관 지식"),
        kbPage("kb-b", "프로젝트 지식", "proj-1"),
      ],
    });
    // resolveProjectId → queryDataSource(projects)
    mockClient.dataSources.query.mockResolvedValue({
      results: [{ id: "proj-1", properties: { title: { title: [{ plain_text: "my-project" }] } } }],
    });
    mockClient.blocks.children.list.mockResolvedValue({ results: [] });

    const result = await handler({ topic: "지식", project: "my-project" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0].title).toBe("프로젝트 지식");
    expect(parsed.results[0].project).toBe(true);
    expect(parsed.results[1].project).toBe(false);
  });

  it("본문 스니펫과 속성을 추출한다 (decisionLog rationale→summary)", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        {
          id: "dec-1",
          url: "https://notion.so/dec-1",
          parent: { type: "database_id", database_id: DEC_ID },
          properties: {
            title: { title: [{ plain_text: "타임아웃 대응" }] },
            rationale: { rich_text: [{ plain_text: "링크 안정성" }] },
            status: { select: { name: "확정" } },
            date: { date: { start: "2026-05-02" } },
          },
        },
      ],
    });
    mockClient.blocks.children.list.mockResolvedValue({
      results: [
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "본문내용" }] } },
        { type: "heading_2", heading_2: { rich_text: [{ plain_text: "섹션" }] } },
      ],
    });

    const result = await handler({ topic: "타임아웃" });
    const parsed = JSON.parse(result.content[0].text);
    const r = parsed.results[0];

    expect(r.db).toBe("decisionLog");
    expect(r.summary).toBe("링크 안정성");
    expect(r.status).toBe("확정");
    expect(r.date).toBe("2026-05-02");
    expect(r.snippet).toContain("본문내용");
    expect(r.snippet).toContain("## 섹션");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run:
```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server && npx vitest run src/tools/__tests__/retrieve.test.ts
```
Expected: FAIL — `Cannot find module '../retrieve.js'` (또는 `registerRetrieve is not a function`).

- [ ] **Step 3: 도구 구현**

Create `mcp-server/src/tools/retrieve.ts`:

```typescript
// jhw_retrieve — 주제 키워드로 지식 DB(decisionLog/knowledgeBase/references)를
// 검색해 제목+요약+본문 스니펫+URL을 반환하는 on-demand 조회 도구.
// Design Ref: docs/superpowers/specs/2026-07-06-notion-recall-on-demand-design.md §4.3
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG, type DatabaseName } from "../config.js";
import { callNotion } from "../notion/api.js";
import { resolveProjectId } from "../notion/resolve-project.js";

const RETRIEVE_DBS: DatabaseName[] = ["decisionLog", "knowledgeBase", "references"];
const SEARCH_PAGE_SIZE = 20;
const SNIPPET_BLOCKS = 10;
const SNIPPET_MAX_CHARS = 500;

const RetrieveInput = z.object({
  topic: z.string().describe("조회 주제 키워드 (지금 작업 내용)"),
  project: z
    .string()
    .optional()
    .describe("프로젝트명/URL/UUID — 있으면 해당 프로젝트 기록을 상위로"),
  limit: z.number().int().min(1).max(15).optional().describe("결과 개수 (기본 8)"),
});

function dbNameFromParent(parent: any): DatabaseName | "page" {
  if (parent?.type !== "database_id") return "page";
  const id = parent.database_id.replace(/-/g, "");
  for (const [name, dbId] of Object.entries(NOTION_CONFIG.databases)) {
    if (dbId.replace(/-/g, "") === id) return name as DatabaseName;
  }
  return "page";
}

const rt = (p: any): string => p?.rich_text?.map((t: any) => t.plain_text).join("") ?? "";
const sel = (p: any): string => p?.select?.name ?? "";
const ms = (p: any): string[] => p?.multi_select?.map((s: any) => s.name) ?? [];
const dateStart = (p: any): string => p?.date?.start ?? "";

function titleOf(page: any): string {
  return (
    (page.properties?.title?.title ?? []).map((t: any) => t.plain_text).join("") ||
    "(제목 없음)"
  );
}

function blockToText(block: any): string {
  const t = block?.type;
  const rich = block?.[t]?.rich_text;
  if (!Array.isArray(rich)) return "";
  const text = rich.map((r: any) => r.plain_text).join("");
  if (!text) return "";
  if (t === "heading_2") return `## ${text}`;
  if (t === "heading_3") return `### ${text}`;
  if (t === "bulleted_list_item" || t === "numbered_list_item") return `- ${text}`;
  return text;
}

function inProjectFactory(projectId: string | null): (page: any) => boolean {
  if (!projectId) return () => false;
  const target = projectId.replace(/-/g, "");
  return (page: any): boolean =>
    (page.properties?.project?.relation ?? []).some(
      (r: any) => (r.id ?? "").replace(/-/g, "") === target
    );
}

export function registerRetrieve(server: McpServer) {
  server.tool(
    "jhw_retrieve",
    "주제 키워드로 관련 결정·지식·문서를 본문 스니펫까지 조회 (on-demand 참고용)",
    RetrieveInput.shape,
    async ({ topic, project, limit }) => {
      const lim = limit ?? 8;
      const notion = getNotionClient();

      // 1. 전문검색 (워크스페이스 전역 — search는 relation 서버필터 불가)
      const searchRes: any = await callNotion(
        () => notion.search({ query: topic, page_size: SEARCH_PAGE_SIZE }),
        { operation: "retrieve.search" }
      );

      // 2. 대상 DB(결정/지식/문서)에 속한 페이지만 유지
      const kept = (searchRes.results as any[])
        .filter((p) => p && p.properties)
        .map((p) => ({ page: p, db: dbNameFromParent(p.parent) }))
        .filter((x) => RETRIEVE_DBS.includes(x.db as DatabaseName)) as {
        page: any;
        db: DatabaseName;
      }[];

      if (kept.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { topic, project: project ?? null, used: "empty", count: 0, truncated: false, results: [] },
                null,
                2
              ),
            },
          ],
        };
      }

      // 3. project 제공 시 해당 프로젝트 기록을 상위로 부스트 (stable sort)
      let projectId: string | null = null;
      if (project) projectId = await resolveProjectId(notion, project);
      const inProject = inProjectFactory(projectId);
      const ordered = [...kept].sort(
        (a, b) => Number(inProject(b.page)) - Number(inProject(a.page))
      );

      const truncated = ordered.length > lim;
      const selected = ordered.slice(0, lim);

      // 4. 각 항목 본문 스니펫 + 속성 추출 (병렬 — RateLimiter가 동시성 제한)
      const results = await Promise.all(
        selected.map(async ({ page, db }) => {
          const props = page.properties ?? {};
          let snippet = "";
          try {
            const blocks: any = await callNotion(
              () =>
                notion.blocks.children.list({ block_id: page.id, page_size: SNIPPET_BLOCKS }),
              { operation: "retrieve.blocks.list" }
            );
            snippet = (blocks.results as any[])
              .map(blockToText)
              .filter(Boolean)
              .join("\n")
              .slice(0, SNIPPET_MAX_CHARS);
          } catch {
            snippet = "";
          }
          const tags = ms(props.tags).length ? ms(props.tags) : ms(props.tool);
          return {
            db,
            title: titleOf(page),
            summary: rt(props.summary) || rt(props.rationale),
            snippet,
            url: page.url,
            project: inProject(page),
            date: dateStart(props.date),
            category: sel(props.category) || sel(props.area),
            tags,
            status: sel(props.status),
          };
        })
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { topic, project: project ?? null, used: "notion", count: results.length, truncated, results },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run:
```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server && npx vitest run src/tools/__tests__/retrieve.test.ts
```
Expected: PASS (4 tests). (이후 리뷰 보강으로 13건까지 확대 — 커버리지 + 2025-09-03 `data_source_id` parent 수정.)

- [ ] **Step 5: 타입 체크**

Run:
```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server && npx tsc --noEmit
```
Expected: 에러 없음(exit 0).

- [ ] **Step 6: Commit**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion
git add mcp-server/src/tools/retrieve.ts mcp-server/src/tools/__tests__/retrieve.test.ts
git commit -m "feat(retrieve): jhw_retrieve 온디맨드 주제 조회 도구 추가"
```

---

## Task 5: server.ts에 jhw_retrieve 등록 (Phase 1)

**Files:**
- Modify: `mcp-server/src/server.ts`

**Interfaces:**
- Consumes: `registerRetrieve`(Task 4).
- Produces: `createServer()`가 `jhw_retrieve`를 등록한 상태.

- [ ] **Step 1: import 추가**

`mcp-server/src/server.ts`에서:

Find:
```typescript
import { registerRecall } from "./tools/recall.js";
```
Replace:
```typescript
import { registerRecall } from "./tools/recall.js";
import { registerRetrieve } from "./tools/retrieve.js";
```

- [ ] **Step 2: 등록 호출 추가**

Find:
```typescript
  registerRecall(server);

  return server;
```
Replace:
```typescript
  registerRecall(server);
  registerRetrieve(server);

  return server;
```

- [ ] **Step 3: 서버 생성 테스트 통과 확인**

Run:
```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server && npx vitest run src/__tests__/server.test.ts
```
Expected: PASS (createServer가 정상 반환 — import 경로 오류 시 실패).

- [ ] **Step 4: 전체 테스트 + 빌드 확인**

Run:
```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server && npx vitest run && npm run build
```
Expected: 전체 테스트 PASS + 빌드 성공.

- [ ] **Step 5: Commit**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion
git add mcp-server/src/server.ts
git commit -m "feat(retrieve): jhw_retrieve를 MCP 서버에 등록"
```

---

## Task 6: 조회 후 연속실행 훅에 jhw_retrieve 연결 (Phase 1)

**Files:**
- Modify: `/home/jhw/.claude/settings.json` (PostToolUse info-tool matcher)
- Modify: `/home/jhw/.claude/hooks/post-info-tool-continuation-hook.py` (`INFO_TOOL_SUBSTRINGS`)

**Interfaces:**
- Consumes: 등록된 `mcp__jhw-notion__jhw_retrieve` 도구명.
- Produces: `jhw_retrieve` 호출 직후 `[INFO-TOOL-CONTINUATION]` 리마인더 발동(조회만 하고 멈추는 관성 차단).

- [ ] **Step 1: settings.json PostToolUse matcher에 jhw_retrieve 추가**

Find:
```
"matcher": "ToolSearch|WebSearch|WebFetch|mcp__notion__notion-search|mcp__notion__notion-fetch|mcp__notion__notion-get-comments|mcp__jhw-notion__jhw_search|mcp__jhw-notion__jhw_context|mcp__jhw-notion__jhw_history|mcp__jhw-notion__jhw_status|mcp__plugin_context7_context7__query-docs|mcp__plugin_context7_context7__resolve-library-id",
```
Replace:
```
"matcher": "ToolSearch|WebSearch|WebFetch|mcp__notion__notion-search|mcp__notion__notion-fetch|mcp__notion__notion-get-comments|mcp__jhw-notion__jhw_search|mcp__jhw-notion__jhw_context|mcp__jhw-notion__jhw_history|mcp__jhw-notion__jhw_status|mcp__jhw-notion__jhw_retrieve|mcp__plugin_context7_context7__query-docs|mcp__plugin_context7_context7__resolve-library-id",
```

- [ ] **Step 2: 훅 스크립트 substring 목록에 추가**

`/home/jhw/.claude/hooks/post-info-tool-continuation-hook.py`에서:

Find:
```python
    "mcp__jhw-notion__jhw_status",
    # context7 docs
```
Replace:
```python
    "mcp__jhw-notion__jhw_status",
    "mcp__jhw-notion__jhw_retrieve",
    # context7 docs
```

- [ ] **Step 3: JSON 유효성 + 발동 검증**

Run:
```bash
python3 -c "import json; json.load(open('/home/jhw/.claude/settings.json')); print('OK')"
echo '{"tool_name":"mcp__jhw-notion__jhw_retrieve"}' | python3 /home/jhw/.claude/hooks/post-info-tool-continuation-hook.py
```
Expected: `OK` + `[INFO-TOOL-CONTINUATION]`를 담은 JSON 출력.

- [ ] **Step 4: Commit** (해당 파일들이 git 관리 대상이면)

```bash
git add /home/jhw/.claude/settings.json /home/jhw/.claude/hooks/post-info-tool-continuation-hook.py
```

---

## 완료 후 통합 검증 (수동)

1. 새 세션에서 `노션참고 <실제 주제>` 프롬프트 → `[NOTION-RECALL]` 주입 → 모델이 `jhw_retrieve` 호출 → 결과 근거 1줄 보고까지 한 턴에 이어지는지 확인.
2. `노션에 저장해줘` → 조회 미발동(저장 흐름 유지) 확인.
3. `jhw_retrieve`가 실제 워크스페이스에서 관련 KB/Decision을 스니펫과 함께 반환하는지 확인(관련성 v1 체감 점검 → 필요 시 knob 조정: `SEARCH_PAGE_SIZE`, `SNIPPET_MAX_CHARS`, 부스트 로직).
