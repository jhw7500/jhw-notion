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
  // Notion API 2025-09-03: data source에 속한 페이지의 parent는
  // { type:"data_source_id", data_source_id, database_id } 로 내려오며 database_id를 함께 담는다.
  // database_id parent variant도 database_id를 가지므로 type 게이트 없이 database_id로 매핑한다.
  const dbid: string | undefined = parent?.database_id;
  if (!dbid) return "page";
  const id = dbid.replace(/-/g, "");
  for (const [name, cid] of Object.entries(NOTION_CONFIG.databases)) {
    if (cid.replace(/-/g, "") === id) return name as DatabaseName;
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
        () =>
          notion.search({
            query: topic,
            page_size: SEARCH_PAGE_SIZE,
            filter: { property: "object", value: "page" },
          }),
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
