import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { callNotion } from "../notion/api.js";
import { defaultPageCache } from "../cache/page-cache.js";

const DeleteInput = z.object({
  pageId: z.string().describe("삭제할 Notion 페이지 ID"),
  mode: z
    .enum(["archive", "delete"])
    .describe(
      "archive: 폐기(status를 '폐기'로 변경; status 필드 없으면 휴지통), " +
        "delete: Notion 휴지통 이동(archived:true, 영구 삭제 아님 — 복구 가능)"
    ),
});

export function registerDelete(server: McpServer) {
  server.tool(
    "jhw_delete",
    "Notion 레코드 삭제 또는 폐기 처리",
    DeleteInput.shape,
    async ({ pageId, mode }) => {
      const notion = getNotionClient();

      // 삭제/폐기 대상은 로컬 캐시에서도 제거 — jhw_recall이 archived 페이지를
      // stale hit로 반환하지 않도록 (best-effort: API 실패 시 다음 recall에서 재적재).
      defaultPageCache.delete(pageId);

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
            { type: "text" as const, text: JSON.stringify({ pageId, mode: "delete", result: "Notion 휴지통 이동 완료 (복구 가능)" }) },
          ],
        };
      }
    }
  );
}
