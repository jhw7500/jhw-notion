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
