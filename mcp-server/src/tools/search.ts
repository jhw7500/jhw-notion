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

      const results = response.results.map((page: any) => {
        const parentDbId =
          page.parent?.type === "database_id"
            ? page.parent.database_id.replace(/-/g, "")
            : null;

        let dbName = "page";
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
