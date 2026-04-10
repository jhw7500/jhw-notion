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
          property: "title",
          title: { contains: project },
        },
      });

      if (projectsRes.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `프로젝트 "${project}"를 찾을 수 없습니다.` }],
        };
      }

      const projectPage = projectsRes.results[0] as any;
      const startDate = projectPage.properties["start_date"]?.date?.start || "";

      // 2. Decision Log에서 관련 결정 (날짜 오름차순)
      const decisionsRes = await notion.databases.query({
        database_id: NOTION_CONFIG.databases.decisionLog,
        filter: {
          property: "project",
          rich_text: { contains: project },
        },
        sorts: [{ property: "date", direction: "ascending" }],
        page_size: 20,
      });

      const timeline: Array<{ date: string; type: string; title: string; status?: string }> = [];

      if (startDate) {
        timeline.push({ date: startDate, type: "project", title: "프로젝트 시작" });
      }

      for (const page of decisionsRes.results as any[]) {
        timeline.push({
          date: page.properties["date"]?.date?.start || "",
          type: "decision",
          title: page.properties["title"]?.title?.[0]?.plain_text || "",
          status: page.properties["status"]?.select?.name || "",
        });
      }

      timeline.sort((a, b) => a.date.localeCompare(b.date));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project: projectPage.properties["title"]?.title?.[0]?.plain_text || "",
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
