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
            page.properties?.["title"]?.title?.[0]?.plain_text ||
            "(제목 없음)";

          const status = page.properties?.["status"]?.select?.name || null;

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
