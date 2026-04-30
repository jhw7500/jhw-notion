import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { callNotion } from "../notion/api.js";

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
          await callNotion(
            () =>
              notion.pages.update({
                page_id: pageId,
                properties: {
                  "status": { select: { name: "폐기" } },
                },
              }),
            { operation: "delete.archive.update", attempts: 2 }
          );
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ pageId, mode: "archive", result: "폐기 완료" }) },
            ],
          };
        } catch {
          await callNotion(
            () =>
              notion.pages.update({
                page_id: pageId,
                archived: true,
              }),
            { operation: "delete.archive.fallback" }
          );
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
        await callNotion(
          () =>
            notion.pages.update({
              page_id: pageId,
              archived: true,
            }),
          { operation: "delete.hard" }
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ pageId, mode: "delete", result: "삭제 완료" }) },
          ],
        };
      }
    }
  );
}
