import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { callNotion, queryDataSource } from "../notion/api.js";
import { sortProjectsByExact } from "../notion/resolve-project.js";

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
      // Design Ref: §4.3 — context.ts:22 마이그레이션
      const projectsRes = await queryDataSource(
        notion,
        "projects",
        {
          filter: {
            property: "title",
            title: { contains: project },
          },
        },
        { operation: "context.projects.query" }
      );

      if (projectsRes.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `프로젝트 "${project}"를 찾을 수 없습니다.` }],
        };
      }

      // exact 우선 — 부분일치 첫 결과 오매칭 방지 (recall.md §흐름과 일치)
      const projectPage = sortProjectsByExact(projectsRes.results as any[], project)[0] as any;
      const projectInfo = {
        id: projectPage.id,
        title: projectPage.properties["title"]?.title?.[0]?.plain_text || "",
        status: projectPage.properties["status"]?.select?.name || "",
        stack: projectPage.properties["tech_stack"]?.multi_select?.map((s: any) => s.name).join(", ") || "",
        repo: projectPage.properties["repo"]?.rich_text?.[0]?.plain_text || "",
        description: projectPage.properties["description"]?.rich_text?.[0]?.plain_text || "",
        startDate: projectPage.properties["start_date"]?.date?.start || "",
        url: projectPage.url,
      };

      // 2. Decision Log에서 관련 결정 검색 — relation filter 우선, legacy rich_text fallback
      // Design Ref: §4.3 — context.ts:53 마이그레이션
      let decisionsRes = await queryDataSource(
        notion,
        "decisionLog",
        {
          filter: {
            property: "project",
            relation: { contains: projectPage.id },
          },
          sorts: [{ property: "date", direction: "descending" }],
          page_size: 10,
        },
        { operation: "context.decisions.query.relation" }
      );
      if (decisionsRes.results.length === 0) {
        // legacy: project 필드가 rich_text로 저장된 과거 결정 fallback
        // Design Ref: §4.3 — context.ts:69 legacy (Cycle #1부터 존재한 패턴 보존)
        try {
          decisionsRes = await queryDataSource(
            notion,
            "decisionLog",
            {
              filter: {
                property: "project",
                rich_text: { contains: project },
              },
              sorts: [{ property: "date", direction: "descending" }],
              page_size: 10,
            },
            { operation: "context.decisions.query.legacy", attempts: 1 }
          );
        } catch {
          // schema가 이미 relation-only면 rich_text filter는 에러. 무시하고 빈 결과 유지.
        }
      }

      const decisions = decisionsRes.results.map((page: any) => ({
        id: page.id,
        title: page.properties["title"]?.title?.[0]?.plain_text || "",
        status: page.properties["status"]?.select?.name || "",
        date: page.properties["date"]?.date?.start || "",
        rationale: page.properties["rationale"]?.rich_text?.[0]?.plain_text || "",
      }));

      // 3. 프로젝트 페이지 본문 조회 (blocks.children.list — wrapper 영향 없음)
      const blocks = await callNotion(
        () =>
          notion.blocks.children.list({
            block_id: projectPage.id,
            page_size: 50,
          }),
        { operation: "context.blocks.list" }
      );

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
