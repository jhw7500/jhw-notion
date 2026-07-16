import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { callNotion } from "../notion/api.js";
import { h3, paragraphBlocks } from "../notion/blocks.js";
import { normalizePageId } from "../notion/page-id.js";
import { defaultPageCache } from "../cache/page-cache.js";

const MAX_BLOCKS_PER_REQUEST = 100;

const AppendInput = z.object({
  pageId: z
    .string()
    .describe("보강할 Notion 페이지 URL 또는 UUID"),
  content: z
    .string()
    .describe("페이지 끝에 추가할 본문 markdown (빈 줄로 paragraph 분리)"),
  heading: z
    .string()
    .optional()
    .describe("본문 앞에 추가할 heading_3 제목 (예: 2026-07-16 보강)"),
});

export function registerAppend(server: McpServer) {
  server.tool(
    "jhw_append",
    "기존 Notion 페이지 끝에 heading과 본문 블록을 추가 (properties 유지)",
    AppendInput.shape,
    async ({ pageId, content, heading }) => {
      if (!content.trim()) {
        throw new Error("append할 content가 비어 있습니다.");
      }

      const notion = getNotionClient();
      const normalizedPageId = normalizePageId(pageId);
      const normalizedHeading = heading?.trim();
      const children = [
        ...(normalizedHeading ? [h3(normalizedHeading)] : []),
        ...paragraphBlocks(content),
      ];

      // 첫 배치부터 원격 상태가 바뀔 수 있으므로 부분 실패 시에도 stale 캐시를 남기지 않는다.
      defaultPageCache.delete(normalizedPageId);

      let batches = 0;
      let appendedBlocks = 0;
      try {
        for (let offset = 0; offset < children.length; offset += MAX_BLOCKS_PER_REQUEST) {
          const batch = children.slice(offset, offset + MAX_BLOCKS_PER_REQUEST);
          await callNotion(
            () =>
              notion.blocks.children.append({
                block_id: normalizedPageId,
                children: batch,
              }),
            { operation: "append.blocks.append" }
          );
          batches++;
          appendedBlocks += batch.length;
        }
      } catch (error) {
        if (appendedBlocks === 0) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Notion append가 ${appendedBlocks}개 블록 후 부분 실패했습니다. ` +
            `이미 추가된 블록이 있으므로 동일 요청을 자동 재시도하지 마세요. 원인: ${reason}`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pageId: normalizedPageId,
                target: pageId,
                heading: normalizedHeading || null,
                appendedBlocks,
                batches,
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
