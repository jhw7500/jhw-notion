# jhw-notion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notion AI Workspace를 여러 AI TUI에서 사용할 수 있는 MCP 서버 + 설치 시스템 구축

**Architecture:** TypeScript MCP 서버가 Notion REST API를 직접 호출하여 9개 고수준 도구를 제공. 각 TUI는 얇은 스킬로 MCP 도구를 호출. install.sh가 스킬 심링크 + MCP 서버 등록을 자동화.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, @notionhq/client, Node.js

---

## File Structure

```
projects/jhw-notion/
├── mcp-server/
│   ├── src/
│   │   ├── index.ts              # 엔트리포인트 (stdio 전송)
│   │   ├── server.ts             # MCP 서버 + 도구 등록
│   │   ├── notion-client.ts      # Notion API 래퍼
│   │   ├── config.ts             # DB/페이지 ID 설정
│   │   └── tools/
│   │       ├── search.ts         # jhw_search
│   │       ├── status.ts         # jhw_status
│   │       ├── context.ts        # jhw_context
│   │       ├── history.ts        # jhw_history
│   │       ├── record.ts         # jhw_record
│   │       ├── note.ts           # jhw_note
│   │       ├── delete.ts         # jhw_delete
│   │       ├── start.ts          # jhw_start
│   │       └── close.ts          # jhw_close
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── skills/
│   └── claude/
│       ├── record.md
│       ├── note.md
│       ├── review.md
│       ├── delete.md
│       ├── search.md
│       ├── context.md
│       ├── history.md
│       ├── status.md
│       ├── start.md
│       └── close.md
├── install.sh
├── DESIGN.md
└── README.md
```

---

### Task 1: 프로젝트 초기화 + MCP 서버 뼈대

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/tsconfig.json`
- Create: `mcp-server/.env.example`
- Create: `mcp-server/src/config.ts`
- Create: `mcp-server/src/notion-client.ts`
- Create: `mcp-server/src/server.ts`
- Create: `mcp-server/src/index.ts`

- [ ] **Step 1: package.json 생성**

```json
{
  "name": "jhw-notion-mcp",
  "version": "1.0.0",
  "description": "Notion AI Workspace MCP Server",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@notionhq/client": "^2.2.0",
    "dotenv": "^16.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: tsconfig.json 생성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: .env.example 생성**

```
NOTION_API_KEY=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- [ ] **Step 4: config.ts 생성**

```typescript
export const NOTION_CONFIG = {
  databases: {
    projects: "d45ed33c-26ee-45be-ad9c-513db7c422e0",
    preferences: "634f7b00-b7a2-447b-9514-a109b57557a8",
    decisionLog: "c1d8d3c3-538e-40a9-a306-2b694a4d8ff9",
  },
  pages: {
    references: "3398a230-a04e-81cc-b3a3-d408355fee9f",
    knowledgeBase: "3398a230-a04e-817d-b04a-d0180abec592",
  },
} as const;

export type DatabaseName = keyof typeof NOTION_CONFIG.databases;
```

- [ ] **Step 5: notion-client.ts 생성**

```typescript
import { Client } from "@notionhq/client";

let client: Client | null = null;

export function getNotionClient(): Client {
  if (!client) {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
      throw new Error("NOTION_API_KEY 환경변수가 설정되지 않았습니다");
    }
    client = new Client({ auth: apiKey });
  }
  return client;
}
```

- [ ] **Step 6: server.ts 생성 (도구 없는 빈 서버)**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "jhw-notion",
    version: "1.0.0",
  });

  return server;
}
```

- [ ] **Step 7: index.ts 생성**

```typescript
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("서버 시작 실패:", error);
  process.exit(1);
});
```

- [ ] **Step 8: npm install + 빌드 확인**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server
npm install
npm run build
```

Expected: `dist/` 디렉토리에 .js 파일 생성, 에러 없음

- [ ] **Step 9: 커밋**

```bash
git add mcp-server/
git commit -m "feat: MCP 서버 프로젝트 초기화 (뼈대)"
```

---

### Task 2: 읽기 도구 — jhw_search

**Files:**
- Create: `mcp-server/src/tools/search.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: search.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const SearchInput = z.object({
  query: z.string().describe("검색 키워드"),
});

export function registerSearch(server: McpServer) {
  server.tool(
    "jhw_search",
    "Notion AI Workspace 전체를 키워드로 통합 검색",
    SearchInput.shape,
    async ({ query }) => {
      const notion = getNotionClient();
      const response = await notion.search({
        query,
        page_size: 10,
      });

      const dbIdToName: Record<string, string> = {};
      for (const [name, id] of Object.entries(NOTION_CONFIG.databases)) {
        dbIdToName[id] = name;
      }

      const results = response.results.map((page: any) => {
        const parentDbId =
          page.parent?.type === "database_id"
            ? page.parent.database_id.replace(/-/g, "")
            : null;

        let dbName = "unknown";
        if (parentDbId) {
          for (const [name, id] of Object.entries(NOTION_CONFIG.databases)) {
            if (id.replace(/-/g, "") === parentDbId) {
              dbName = name;
              break;
            }
          }
        }

        const title =
          page.properties?.["결정"]?.title?.[0]?.plain_text ||
          page.properties?.["프로젝트명"]?.title?.[0]?.plain_text ||
          page.properties?.["규칙"]?.title?.[0]?.plain_text ||
          page.properties?.["Name"]?.title?.[0]?.plain_text ||
          "(제목 없음)";

        return {
          id: page.id,
          db: dbName,
          title,
          url: page.url,
          lastEdited: page.last_edited_time,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ query, count: results.length, results }, null, 2),
          },
        ],
      };
    }
  );
}
```

- [ ] **Step 2: server.ts에 search 등록**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearch } from "./tools/search.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "jhw-notion",
    version: "1.0.0",
  });

  registerSearch(server);

  return server;
}
```

- [ ] **Step 3: 빌드 확인**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server
npm run build
```

Expected: 에러 없이 빌드 성공

- [ ] **Step 4: 커밋**

```bash
git add mcp-server/src/tools/search.ts mcp-server/src/server.ts
git commit -m "feat: jhw_search 도구 추가"
```

---

### Task 3: 읽기 도구 — jhw_status

**Files:**
- Create: `mcp-server/src/tools/status.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: status.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG, DatabaseName } from "../config.js";

const StatusInput = z.object({
  db: z
    .enum(["projects", "preferences", "decisionLog"])
    .optional()
    .describe("특정 DB만 조회 (생략 시 전체)"),
});

export function registerStatus(server: McpServer) {
  server.tool(
    "jhw_status",
    "Notion AI Workspace 현황 조회 (DB별 레코드 수, 최근 항목)",
    StatusInput.shape,
    async ({ db }) => {
      const notion = getNotionClient();
      const dbsToQuery: DatabaseName[] = db
        ? [db]
        : (Object.keys(NOTION_CONFIG.databases) as DatabaseName[]);

      const results: Record<string, any> = {};

      for (const dbName of dbsToQuery) {
        const dbId = NOTION_CONFIG.databases[dbName];
        const response = await notion.databases.query({
          database_id: dbId,
          page_size: 5,
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        });

        const items = response.results.map((page: any) => {
          const title =
            page.properties?.["결정"]?.title?.[0]?.plain_text ||
            page.properties?.["프로젝트명"]?.title?.[0]?.plain_text ||
            page.properties?.["규칙"]?.title?.[0]?.plain_text ||
            "(제목 없음)";

          const status =
            page.properties?.["상태"]?.select?.name || null;

          return { id: page.id, title, status, lastEdited: page.last_edited_time };
        });

        results[dbName] = {
          count: response.results.length,
          hasMore: response.has_more,
          recentItems: items,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );
}
```

- [ ] **Step 2: server.ts에 status 등록**

`server.ts`의 import에 추가하고 `registerStatus(server)` 호출.

```typescript
import { registerSearch } from "./tools/search.js";
import { registerStatus } from "./tools/status.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "jhw-notion",
    version: "1.0.0",
  });

  registerSearch(server);
  registerStatus(server);

  return server;
}
```

- [ ] **Step 3: 빌드 확인 + 커밋**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server
npm run build
git add mcp-server/src/tools/status.ts mcp-server/src/server.ts
git commit -m "feat: jhw_status 도구 추가"
```

---

### Task 4: 읽기 도구 — jhw_context

**Files:**
- Create: `mcp-server/src/tools/context.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: context.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const ContextInput = z.object({
  project: z.string().describe("프로젝트명 (검색 키워드)"),
});

export function registerContext(server: McpServer) {
  server.tool(
    "jhw_context",
    "특정 프로젝트의 정보, 관련 결정, 페이지 본문을 한 번에 로드",
    ContextInput.shape,
    async ({ project }) => {
      const notion = getNotionClient();

      // 1. Projects DB에서 프로젝트 검색
      const projectsRes = await notion.databases.query({
        database_id: NOTION_CONFIG.databases.projects,
        filter: {
          property: "프로젝트명",
          title: { contains: project },
        },
      });

      if (projectsRes.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `프로젝트 "${project}"를 찾을 수 없습니다.` }],
        };
      }

      const projectPage = projectsRes.results[0] as any;
      const projectInfo = {
        id: projectPage.id,
        title: projectPage.properties["프로젝트명"]?.title?.[0]?.plain_text || "",
        status: projectPage.properties["상태"]?.select?.name || "",
        stack: projectPage.properties["기술 스택"]?.rich_text?.[0]?.plain_text || "",
        repo: projectPage.properties["레포 경로"]?.rich_text?.[0]?.plain_text || "",
        description: projectPage.properties["설명"]?.rich_text?.[0]?.plain_text || "",
        startDate: projectPage.properties["시작일"]?.date?.start || "",
        url: projectPage.url,
      };

      // 2. Decision Log에서 관련 결정 검색
      const decisionsRes = await notion.databases.query({
        database_id: NOTION_CONFIG.databases.decisionLog,
        filter: {
          property: "관련 프로젝트",
          rich_text: { contains: project },
        },
        sorts: [{ property: "날짜", direction: "descending" }],
        page_size: 10,
      });

      const decisions = decisionsRes.results.map((page: any) => ({
        id: page.id,
        title: page.properties["결정"]?.title?.[0]?.plain_text || "",
        status: page.properties["상태"]?.select?.name || "",
        date: page.properties["날짜"]?.date?.start || "",
        rationale: page.properties["근거"]?.rich_text?.[0]?.plain_text || "",
      }));

      // 3. 프로젝트 페이지 본문 조회
      const blocks = await notion.blocks.children.list({
        block_id: projectPage.id,
        page_size: 50,
      });

      const pageContent = blocks.results
        .map((block: any) => {
          if (block.type === "paragraph") {
            return block.paragraph?.rich_text?.map((t: any) => t.plain_text).join("") || "";
          }
          if (block.type === "heading_2") {
            return `## ${block.heading_2?.rich_text?.map((t: any) => t.plain_text).join("") || ""}`;
          }
          if (block.type === "heading_3") {
            return `### ${block.heading_3?.rich_text?.map((t: any) => t.plain_text).join("") || ""}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ project: projectInfo, decisions, pageContent }, null, 2),
          },
        ],
      };
    }
  );
}
```

- [ ] **Step 2: server.ts에 등록 + 빌드 + 커밋**

```bash
# server.ts에 import { registerContext } 추가, registerContext(server) 호출
npm run build
git add mcp-server/src/tools/context.ts mcp-server/src/server.ts
git commit -m "feat: jhw_context 도구 추가"
```

---

### Task 5: 읽기 도구 — jhw_history

**Files:**
- Create: `mcp-server/src/tools/history.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: history.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const HistoryInput = z.object({
  project: z.string().describe("프로젝트명 (검색 키워드)"),
});

export function registerHistory(server: McpServer) {
  server.tool(
    "jhw_history",
    "특정 프로젝트의 시간순 활동 타임라인 조회",
    HistoryInput.shape,
    async ({ project }) => {
      const notion = getNotionClient();

      // 1. Projects DB에서 프로젝트 정보
      const projectsRes = await notion.databases.query({
        database_id: NOTION_CONFIG.databases.projects,
        filter: {
          property: "프로젝트명",
          title: { contains: project },
        },
      });

      if (projectsRes.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `프로젝트 "${project}"를 찾을 수 없습니다.` }],
        };
      }

      const projectPage = projectsRes.results[0] as any;
      const startDate = projectPage.properties["시작일"]?.date?.start || "";

      // 2. Decision Log에서 관련 결정 (날짜 오름차순)
      const decisionsRes = await notion.databases.query({
        database_id: NOTION_CONFIG.databases.decisionLog,
        filter: {
          property: "관련 프로젝트",
          rich_text: { contains: project },
        },
        sorts: [{ property: "날짜", direction: "ascending" }],
        page_size: 20,
      });

      const timeline: Array<{ date: string; type: string; title: string; status?: string }> = [];

      if (startDate) {
        timeline.push({ date: startDate, type: "project", title: "프로젝트 시작" });
      }

      for (const page of decisionsRes.results as any[]) {
        timeline.push({
          date: page.properties["날짜"]?.date?.start || "",
          type: "decision",
          title: page.properties["결정"]?.title?.[0]?.plain_text || "",
          status: page.properties["상태"]?.select?.name || "",
        });
      }

      timeline.sort((a, b) => a.date.localeCompare(b.date));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project: projectPage.properties["프로젝트명"]?.title?.[0]?.plain_text || "",
                totalEvents: timeline.length,
                timeline,
              },
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

- [ ] **Step 2: server.ts에 등록 + 빌드 + 커밋**

```bash
npm run build
git add mcp-server/src/tools/history.ts mcp-server/src/server.ts
git commit -m "feat: jhw_history 도구 추가"
```

---

### Task 6: 쓰기 도구 — jhw_record

**Files:**
- Create: `mcp-server/src/tools/record.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: record.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG, DatabaseName } from "../config.js";

const RecordInput = z.object({
  db: z.enum(["decisionLog", "preferences", "projects", "references"]).describe("저장 대상 DB"),
  title: z.string().describe("레코드 제목"),
  properties: z
    .object({
      status: z.string().optional().describe("상태 (확정/검토중/폐기)"),
      rationale: z.string().optional().describe("근거 (decisionLog)"),
      alternatives: z.string().optional().describe("대안 (decisionLog)"),
      area: z.string().optional().describe("영역 (decisionLog)"),
      project: z.string().optional().describe("관련 프로젝트"),
      category: z.string().optional().describe("범주 (preferences)"),
      repo: z.string().optional().describe("레포 경로 (projects)"),
      stack: z.string().optional().describe("기술 스택 (projects)"),
      description: z.string().optional().describe("설명 (projects)"),
    })
    .optional()
    .describe("추가 프로퍼티"),
});

function buildNotionProperties(db: string, title: string, props: any) {
  const p: Record<string, any> = {};

  if (db === "decisionLog") {
    p["결정"] = { title: [{ text: { content: title } }] };
    if (props?.status) p["상태"] = { select: { name: props.status } };
    else p["상태"] = { select: { name: "확정" } };
    if (props?.rationale) p["근거"] = { rich_text: [{ text: { content: props.rationale } }] };
    if (props?.alternatives) p["대안"] = { rich_text: [{ text: { content: props.alternatives } }] };
    if (props?.area) p["영역"] = { select: { name: props.area } };
    if (props?.project)
      p["관련 프로젝트"] = { rich_text: [{ text: { content: props.project } }] };
    p["날짜"] = { date: { start: new Date().toISOString().split("T")[0] } };
  } else if (db === "preferences") {
    p["규칙"] = { title: [{ text: { content: title } }] };
    if (props?.category) p["범주"] = { select: { name: props.category } };
  } else if (db === "projects") {
    p["프로젝트명"] = { title: [{ text: { content: title } }] };
    if (props?.status) p["상태"] = { select: { name: props.status } };
    else p["상태"] = { select: { name: "진행중" } };
    if (props?.repo) p["레포 경로"] = { rich_text: [{ text: { content: props.repo } }] };
    if (props?.stack) p["기술 스택"] = { rich_text: [{ text: { content: props.stack } }] };
    if (props?.description) p["설명"] = { rich_text: [{ text: { content: props.description } }] };
    p["시작일"] = { date: { start: new Date().toISOString().split("T")[0] } };
  }

  return p;
}

export function registerRecord(server: McpServer) {
  server.tool(
    "jhw_record",
    "Notion AI Workspace DB에 레코드 생성",
    RecordInput.shape,
    async ({ db, title, properties }) => {
      const notion = getNotionClient();
      const dbId = NOTION_CONFIG.databases[db as DatabaseName];

      if (!dbId) {
        return {
          content: [{ type: "text" as const, text: `알 수 없는 DB: ${db}` }],
        };
      }

      const notionProps = buildNotionProperties(db, title, properties);

      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties: notionProps,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { id: page.id, url: (page as any).url, db, title },
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

- [ ] **Step 2: server.ts에 등록 + 빌드 + 커밋**

```bash
npm run build
git add mcp-server/src/tools/record.ts mcp-server/src/server.ts
git commit -m "feat: jhw_record 도구 추가"
```

---

### Task 7: 쓰기 도구 — jhw_note

**Files:**
- Create: `mcp-server/src/tools/note.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: note.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const NoteInput = z.object({
  title: z.string().describe("메모 제목"),
  content: z.string().describe("메모 내용"),
  project: z.string().optional().describe("관련 프로젝트명"),
});

export function registerNote(server: McpServer) {
  server.tool(
    "jhw_note",
    "Knowledge Base에 기술 지식이나 발견 사항을 메모",
    NoteInput.shape,
    async ({ title, content, project }) => {
      const notion = getNotionClient();

      const children: any[] = [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content } }],
          },
        },
      ];

      if (project) {
        children.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: `관련 프로젝트: ${project}` }, annotations: { bold: true } },
            ],
          },
        });
      }

      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { content: `작성일: ${new Date().toISOString().split("T")[0]}` },
              annotations: { italic: true },
            },
          ],
        },
      });

      const page = await notion.pages.create({
        parent: { page_id: NOTION_CONFIG.pages.knowledgeBase },
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
        children,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: page.id, url: (page as any).url, title }, null, 2),
          },
        ],
      };
    }
  );
}
```

- [ ] **Step 2: server.ts에 등록 + 빌드 + 커밋**

```bash
npm run build
git add mcp-server/src/tools/note.ts mcp-server/src/server.ts
git commit -m "feat: jhw_note 도구 추가"
```

---

### Task 8: 쓰기 도구 — jhw_delete

**Files:**
- Create: `mcp-server/src/tools/delete.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: delete.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";

const DeleteInput = z.object({
  pageId: z.string().describe("삭제할 Notion 페이지 ID"),
  mode: z.enum(["archive", "delete"]).describe("archive: 폐기(상태 변경), delete: 완전 삭제"),
});

export function registerDelete(server: McpServer) {
  server.tool(
    "jhw_delete",
    "Notion 레코드 삭제 또는 폐기 처리",
    DeleteInput.shape,
    async ({ pageId, mode }) => {
      const notion = getNotionClient();

      if (mode === "archive") {
        try {
          await notion.pages.update({
            page_id: pageId,
            properties: {
              "상태": { select: { name: "폐기" } },
            },
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ pageId, mode: "archive", result: "폐기 완료" }) },
            ],
          };
        } catch {
          // 상태 필드가 없는 DB (Preferences 등)는 완전 삭제로 폴백
          await notion.pages.update({
            page_id: pageId,
            archived: true,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ pageId, mode: "delete", result: "상태 필드 없어 아카이브 처리" }),
              },
            ],
          };
        }
      } else {
        await notion.pages.update({
          page_id: pageId,
          archived: true,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ pageId, mode: "delete", result: "삭제 완료" }) },
          ],
        };
      }
    }
  );
}
```

- [ ] **Step 2: server.ts에 등록 + 빌드 + 커밋**

```bash
npm run build
git add mcp-server/src/tools/delete.ts mcp-server/src/server.ts
git commit -m "feat: jhw_delete 도구 추가"
```

---

### Task 9: 쓰기 도구 — jhw_start

**Files:**
- Create: `mcp-server/src/tools/start.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: start.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const StartInput = z.object({
  name: z.string().describe("프로젝트명"),
  repo: z.string().optional().describe("레포 경로"),
  stack: z.string().optional().describe("기술 스택"),
  description: z.string().describe("한 줄 설명"),
});

export function registerStart(server: McpServer) {
  server.tool(
    "jhw_start",
    "새 프로젝트 시작 — Projects DB 등록 + Decision Log 기록 + 페이지 템플릿",
    StartInput.shape,
    async ({ name, repo, stack, description }) => {
      const notion = getNotionClient();
      const today = new Date().toISOString().split("T")[0];

      // 1. Projects DB에 레코드 생성
      const projectProps: Record<string, any> = {
        "프로젝트명": { title: [{ text: { content: name } }] },
        "상태": { select: { name: "진행중" } },
        "설명": { rich_text: [{ text: { content: description } }] },
        "시작일": { date: { start: today } },
      };
      if (repo) projectProps["레포 경로"] = { rich_text: [{ text: { content: repo } }] };
      if (stack) projectProps["기술 스택"] = { rich_text: [{ text: { content: stack } }] };

      const projectPage = await notion.pages.create({
        parent: { database_id: NOTION_CONFIG.databases.projects },
        properties: projectProps,
        children: [
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "목표" } }] } },
          { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: description } }] } },
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "범위" } }] } },
          { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: "(작업하면서 작성)" } }] } },
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "제약사항" } }] } },
          { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: "(작업하면서 작성)" } }] } },
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "메모" } }] } },
          { object: "block", type: "paragraph", paragraph: { rich_text: [] } },
        ],
      });

      // 2. Decision Log에 "프로젝트 시작" 기록
      const decisionPage = await notion.pages.create({
        parent: { database_id: NOTION_CONFIG.databases.decisionLog },
        properties: {
          "결정": { title: [{ text: { content: `${name} 프로젝트 시작` } }] },
          "상태": { select: { name: "확정" } },
          "영역": { select: { name: "기타" } },
          "날짜": { date: { start: today } },
          "근거": { rich_text: [{ text: { content: description } }] },
          "관련 프로젝트": { rich_text: [{ text: { content: name } }] },
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project: { id: projectPage.id, url: (projectPage as any).url },
                decision: { id: decisionPage.id, url: (decisionPage as any).url },
              },
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

- [ ] **Step 2: server.ts에 등록 + 빌드 + 커밋**

```bash
npm run build
git add mcp-server/src/tools/start.ts mcp-server/src/server.ts
git commit -m "feat: jhw_start 도구 추가"
```

---

### Task 10: 쓰기 도구 — jhw_close

**Files:**
- Create: `mcp-server/src/tools/close.ts`
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: close.ts 구현**

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const CloseInput = z.object({
  project: z.string().describe("프로젝트명 (검색 키워드)"),
  achievement: z.string().optional().describe("달성한 것"),
  lessons: z.string().optional().describe("배운 점"),
});

export function registerClose(server: McpServer) {
  server.tool(
    "jhw_close",
    "프로젝트 종료 — 상태 완료 + 회고 추가 + Knowledge Base 학습사항",
    CloseInput.shape,
    async ({ project, achievement, lessons }) => {
      const notion = getNotionClient();
      const today = new Date().toISOString().split("T")[0];

      // 1. Projects DB에서 프로젝트 검색
      const projectsRes = await notion.databases.query({
        database_id: NOTION_CONFIG.databases.projects,
        filter: {
          property: "프로젝트명",
          title: { contains: project },
        },
      });

      if (projectsRes.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `프로젝트 "${project}"를 찾을 수 없습니다.` }],
        };
      }

      const projectPage = projectsRes.results[0] as any;

      // 2. 상태 → 완료, 완료일 설정
      await notion.pages.update({
        page_id: projectPage.id,
        properties: {
          "상태": { select: { name: "완료" } },
          "완료일": { date: { start: today } },
        },
      });

      // 3. 회고 섹션 추가 (있는 경우)
      if (achievement || lessons) {
        const retroBlocks: any[] = [
          {
            object: "block",
            type: "heading_2",
            heading_2: { rich_text: [{ text: { content: `회고 (${today})` } }] },
          },
        ];

        if (achievement) {
          retroBlocks.push(
            { object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: "달성한 것" } }] } },
            { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: achievement } }] } }
          );
        }

        if (lessons) {
          retroBlocks.push(
            { object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: "배운 점" } }] } },
            { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: lessons } }] } }
          );
        }

        await notion.blocks.children.append({
          block_id: projectPage.id,
          children: retroBlocks,
        });
      }

      // 4. 배운 점이 있으면 Knowledge Base에 등록
      let knowledgePage = null;
      if (lessons) {
        knowledgePage = await notion.pages.create({
          parent: { page_id: NOTION_CONFIG.pages.knowledgeBase },
          properties: {
            title: { title: [{ text: { content: `${project} 회고 — 배운 점` } }] },
          },
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: [{ text: { content: lessons } }] },
            },
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", text: { content: `프로젝트: ${project} | 날짜: ${today}` }, annotations: { italic: true } }],
              },
            },
          ],
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project: { id: projectPage.id, status: "완료" },
                retrospective: !!(achievement || lessons),
                knowledgeBase: knowledgePage ? { id: knowledgePage.id, url: (knowledgePage as any).url } : null,
              },
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

- [ ] **Step 2: server.ts에 등록 + 빌드 + 커밋**

```bash
npm run build
git add mcp-server/src/tools/close.ts mcp-server/src/server.ts
git commit -m "feat: jhw_close 도구 추가"
```

---

### Task 11: Claude 스킬 (얇은 버전) 작성

**Files:**
- Create: `skills/claude/record.md`
- Create: `skills/claude/note.md`
- Create: `skills/claude/review.md`
- Create: `skills/claude/delete.md`
- Create: `skills/claude/search.md`
- Create: `skills/claude/context.md`
- Create: `skills/claude/history.md`
- Create: `skills/claude/status.md`
- Create: `skills/claude/start.md`
- Create: `skills/claude/close.md`

- [ ] **Step 1: 얇은 스킬 10개 작성**

모든 스킬은 동일 패턴:
1. 사용자 입력 파싱
2. 미리보기 + 승인 (쓰기 도구만)
3. `jhw_*` MCP 도구 호출
4. 결과 표시

`review.md`만 예외 — 세션 대화 분석 로직을 스킬에 유지.

각 스킬 파일은 기존 `~/.claude/commands/jhw/*.md`의 규칙/예시를 유지하되, Notion API 호출 절차를 `jhw_*` MCP 도구 호출로 대체.

- [ ] **Step 2: 커밋**

```bash
git add skills/claude/
git commit -m "feat: Claude 스킬 (얇은 버전) 10개 작성"
```

---

### Task 12: install.sh + README

**Files:**
- Create: `install.sh`
- Create: `.env.example` (루트)
- Create: `README.md`

- [ ] **Step 1: install.sh 작성**

DESIGN.md 6.1절의 스크립트 구현. 기능:
- MCP 서버 빌드 (npm install + build)
- TUI 감지 (~/.claude, ~/.gemini 존재 여부)
- 스킬 심링크 생성
- 각 TUI settings.json에 MCP 서버 등록
- --uninstall 옵션으로 제거 지원

- [ ] **Step 2: README.md 작성**

설치 방법, 사용법, 환경변수 설정, 지원 TUI 목록.

- [ ] **Step 3: 실행 권한 + 커밋**

```bash
chmod +x install.sh
git add install.sh .env.example README.md
git commit -m "feat: install.sh + README 추가"
```

---

### Task 13: 통합 테스트 + GitHub 푸시

- [ ] **Step 1: MCP 서버 빌드 최종 확인**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server
npm run build
```

- [ ] **Step 2: install.sh 실행 테스트**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion
./install.sh
```

확인: 심링크 생성, settings.json에 jhw-notion 등록

- [ ] **Step 3: Claude Code에서 MCP 도구 호출 테스트**

세션 재시작 후 `jhw_status` 도구가 보이는지 확인.

- [ ] **Step 4: GitHub에 푸시**

```bash
git remote add origin https://github.com/jhw7500/jhw-notion.git
git push -u origin main
```
