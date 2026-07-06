import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { dbNameFromParent } from "../schema.js";
import { callNotion } from "../notion/api.js";

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
      const response = await callNotion(
        () =>
          notion.search({
            query,
            page_size: 10,
          }),
        { operation: "search.notion" }
      );

      const results = response.results.map((page: any) => {
        const dbName = dbNameFromParent(page.parent);

        const title =
          page.properties?.["title"]?.title?.[0]?.plain_text ||
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
