// jhw_recall MCP 도구 (P1-1 MVP).
// 로컬 PageCache 우선 → 캐시 미스 시 Notion 검색 fallback + 자동 캐시 저장.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { defaultPageCache } from "../cache/page-cache.js";
import { callNotion } from "../notion/api.js";
import { dbNameFromParent } from "../schema.js";

const RecallInput = z.object({
  query: z.string().describe("검색 키워드"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("결과 개수 (기본 10)"),
  notionFallback: z
    .boolean()
    .optional()
    .describe(
      "로컬 결과 부족 시 Notion 검색으로 보완 + 자동 캐시 저장 (기본 true)"
    ),
});

export function registerRecall(server: McpServer) {
  server.tool(
    "jhw_recall",
    "로컬 페이지 캐시 우선 회상 (P1-1) — 미스 시 Notion 검색 fallback + 자동 캐시",
    RecallInput.shape,
    async ({ query, limit, notionFallback }) => {
      const lim = limit ?? 10;
      const localResults = defaultPageCache.search(query, lim);
      const fallback = notionFallback !== false;

      let used: "cache" | "notion" | "hybrid" | "empty" = "cache";
      const remoteResults: any[] = [];

      if (localResults.length === 0 && !fallback) {
        used = "empty";
      } else if (localResults.length < lim && fallback) {
        try {
          const notion = getNotionClient();
          const res: any = await callNotion(
            () =>
              notion.search({
                query,
                page_size: lim - localResults.length,
              }),
            { operation: "recall.notion.search" }
          );
          for (const p of res.results as any[]) {
            const db = dbNameFromParent(p.parent);
            const title =
              p.properties?.title?.title?.[0]?.plain_text ??
              p.properties?.Name?.title?.[0]?.plain_text ??
              "(제목 없음)";
            // 자동 캐시 — 다음 recall 시 즉시 매칭
            defaultPageCache.set({
              id: p.id,
              db,
              title,
              url: p.url,
              text: title, // 본문 fetch는 비용 — title만 인덱싱 (P1-1b로 enhance)
              lastEdited: p.last_edited_time,
            });
            remoteResults.push({
              id: p.id,
              db,
              title,
              url: p.url,
              source: "notion",
              stale: false,
            });
          }
          used = localResults.length > 0 ? "hybrid" : "notion";
        } catch {
          // Notion fallback 실패 — 로컬 결과만 반환 (used 그대로 "cache")
        }
      }

      const combined = [
        ...localResults.map((r) => ({
          id: r.page.id,
          db: r.page.db,
          title: r.page.title,
          url: r.page.url,
          score: r.score,
          source: "cache" as const,
          cachedAt: r.page.cachedAt,
          stale: false,
        })),
        ...remoteResults,
      ].slice(0, lim);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                used,
                cacheSize: defaultPageCache.size(),
                results: combined,
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

// 테스트용
export const __pageCache = defaultPageCache;
