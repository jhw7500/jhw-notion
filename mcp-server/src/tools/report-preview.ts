// jhw_report_preview MCP 도구 (P0-3 MVP).
// 주간/월간 보고서 미리보기 — redmine report 필드 기반.
// preview → (사용자 승인) → export(별도 도구) 2-step UX.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { REPORT_VALUES, type DatabaseName } from "../config.js";
import { queryReportItems } from "../report/query.js";
import {
  groupByReport,
  groupByDb,
  formatRedmine,
  formatMarkdown,
} from "../report/format.js";
import { ReportCache } from "../cache/report-cache.js";

const cache = new ReportCache<any>(5 * 60 * 1000);

const PreviewInput = z.object({
  period: z
    .enum(["week", "month", "custom"])
    .describe("기간 단위. custom이면 start/end 필수."),
  start: z.string().optional().describe("YYYY-MM-DD"),
  end: z.string().optional().describe("YYYY-MM-DD"),
  reports: z
    .array(z.enum(REPORT_VALUES))
    .optional()
    .describe("필터: 특정 report 값만 (기본: none 제외 전체)"),
  dbs: z
    .array(
      z.enum([
        "projects",
        "preferences",
        "decisionLog",
        "knowledgeBase",
        "references",
      ])
    )
    .optional(),
  groupBy: z
    .enum(["report", "db"])
    .optional()
    .describe("기본: report"),
  includeNone: z.boolean().optional().describe("none 항목 포함 (기본 false)"),
  useCache: z.boolean().optional().describe("기본 true"),
});

export function resolvePeriod(p: {
  period: "week" | "month" | "custom";
  start?: string;
  end?: string;
  /** 테스트용 today 주입 */
  today?: Date;
}): { start: string; end: string } {
  if (p.period === "custom") {
    if (!p.start || !p.end) {
      throw new Error("custom period requires start and end");
    }
    return { start: p.start, end: p.end };
  }
  const today = p.today ?? new Date();
  const end = p.end ?? today.toISOString().split("T")[0];
  const endDate = new Date(end);
  const days = p.period === "week" ? 6 : 29;
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - days);
  return {
    start: p.start ?? startDate.toISOString().split("T")[0],
    end,
  };
}

export function registerReportPreview(server: McpServer) {
  server.tool(
    "jhw_report_preview",
    "주간/월간 업무 보고서 미리보기 — 5개 DB의 report 필드 기반 + redmine markdown",
    PreviewInput.shape,
    async (args) => {
      const period = resolvePeriod(args);
      const cacheKey = JSON.stringify({
        period,
        reports: args.reports ?? null,
        dbs: args.dbs ?? null,
        groupBy: args.groupBy ?? "report",
        includeNone: args.includeNone ?? false,
      });
      const useCache = args.useCache !== false;

      let payload: { groups: any; stats: any } | null = null;
      let cacheHit = false;

      if (useCache) {
        payload = cache.get(cacheKey);
        cacheHit = !!payload;
      }

      if (!payload) {
        const notion = getNotionClient();
        const items = await queryReportItems(notion, {
          start: period.start,
          end: period.end,
          reports: args.reports,
          dbs: args.dbs as DatabaseName[] | undefined,
          includeNone: args.includeNone,
        });
        const groups =
          (args.groupBy ?? "report") === "db"
            ? groupByDb(items)
            : groupByReport(items);
        const excludedNone = items.filter((i) => i.report === "none").length;
        const stats = {
          scanned: items.length,
          included: items.length,
          excludedNone,
        };
        payload = { groups, stats };
        if (useCache) cache.set(cacheKey, payload);
      }

      const redmineText = formatRedmine(payload.groups, period);
      const markdownText = formatMarkdown(payload.groups, period);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                period,
                groups: payload.groups,
                stats: payload.stats,
                redmineText,
                markdownText,
                cache: {
                  hit: cacheHit,
                  key: cacheKey,
                  generatedAt: new Date().toISOString(),
                },
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

// 테스트용 export
export const __cache = cache;
