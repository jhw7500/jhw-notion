import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { queryDataSource } from "../notion/api.js";

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
      // Design Ref: §4.3 — history.ts:22 마이그레이션 (databases.query → dataSources.query via wrapper)
      const projectsRes = await queryDataSource(
        notion,
        "projects",
        {
          filter: {
            property: "title",
            title: { contains: project },
          },
        },
        { operation: "history.projects.query" }
      );

      if (projectsRes.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `프로젝트 "${project}"를 찾을 수 없습니다.` }],
        };
      }

      const projectPage = projectsRes.results[0] as any;
      const startDate = projectPage.properties["start_date"]?.date?.start || "";

      // 2. Decision Log에서 관련 결정 — relation filter 우선, legacy rich_text fallback
      // Design Ref: §4.3 — history.ts:44 마이그레이션
      let decisionsRes = await queryDataSource(
        notion,
        "decisionLog",
        {
          filter: {
            property: "project",
            relation: { contains: projectPage.id },
          },
          sorts: [{ property: "date", direction: "ascending" }],
          page_size: 20,
        },
        { operation: "history.decisions.query.relation" }
      );
      if (decisionsRes.results.length === 0) {
        try {
          // Design Ref: §4.3 — history.ts:59 legacy fallback (Cycle #1부터 존재한 패턴 보존)
          decisionsRes = await queryDataSource(
            notion,
            "decisionLog",
            {
              filter: {
                property: "project",
                rich_text: { contains: project },
              },
              sorts: [{ property: "date", direction: "ascending" }],
              page_size: 20,
            },
            { operation: "history.decisions.query.legacy", attempts: 1 }
          );
        } catch {
          // schema가 이미 relation-only면 rich_text filter는 에러. 무시.
        }
      }

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
