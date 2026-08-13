// jhw_report_export MCP 도구 (P0-3 후속).
// 보고서를 markdown/redmine/json으로 출력 + writeBack 옵션으로 KB/decisionLog 자동 저장.
// preview와 동일한 cache 사용 — preview→export 순서면 재조회 없음.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import {
  REPORT_VALUES,
  NOTION_CONFIG,
  type DatabaseName,
} from "../config.js";
import { queryReportItems } from "../report/query.js";
import {
  groupByReport,
  groupByDb,
  formatRedmine,
  formatMarkdown,
  formatJson,
} from "../report/format.js";
import { resolvePeriod, __cache } from "./report-preview.js";
import { callNotion } from "../notion/api.js";
import {
  authorityMcpError,
  defaultNotionAuthorityGuard,
  type NotionAuthorityGuard,
} from "../notion/authority-guard.js";

const ExportInput = z.object({
  period: z.enum(["week", "month", "custom"]),
  start: z.string().optional(),
  end: z.string().optional(),
  reports: z.array(z.enum(REPORT_VALUES)).optional(),
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
  groupBy: z.enum(["report", "db"]).optional(),
  includeNone: z.boolean().optional(),
  format: z
    .enum(["markdown", "redmine", "json"])
    .describe("출력 형식"),
  writeBack: z
    .object({
      enabled: z.boolean(),
      db: z
        .enum(["knowledgeBase", "decisionLog"])
        .optional()
        .describe("기본 knowledgeBase"),
      title: z.string().optional(),
    })
    .optional(),
});

function buildCacheKey(args: any, period: { start: string; end: string }) {
  return JSON.stringify({
    period,
    reports: args.reports ?? null,
    dbs: args.dbs ?? null,
    groupBy: args.groupBy ?? "report",
    includeNone: args.includeNone ?? false,
  });
}

export function registerReportExport(server: McpServer, authority: NotionAuthorityGuard = defaultNotionAuthorityGuard) {
  server.tool(
    "jhw_report_export",
    "보고서를 markdown/redmine/json으로 출력 + 선택적으로 KB/decisionLog에 자동 저장",
    ExportInput.shape,
    async (args) => {
      const period = resolvePeriod(args);
      const cacheKey = buildCacheKey(args, period);

      let payload = __cache.get(cacheKey);
      let cacheHit = !!payload;

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
        payload = {
          groups,
          stats: {
            scanned: items.length,
            included: items.length,
            excludedNone: items.filter((i) => i.report === "none").length,
          },
        };
        __cache.set(cacheKey, payload);
      }

      const text =
        args.format === "redmine"
          ? formatRedmine(payload.groups, period)
          : args.format === "json"
          ? formatJson(payload.groups, period)
          : formatMarkdown(payload.groups, period);

      let writeBack: { id: string; url: string; db: string } | null = null;

      if (args.writeBack?.enabled) {
        const wbDb = args.writeBack.db ?? "knowledgeBase";
        try {
          await authority.assertNotionWriteAllowed(wbDb, "jhw_report_export");
        } catch (cause) {
          const denied = authorityMcpError(cause, wbDb, "jhw_report_export");
          if (denied) return denied;
          throw cause;
        }
        const dbId = NOTION_CONFIG.databases[wbDb];
        const title =
          args.writeBack.title ??
          `보고서 ${period.start} ~ ${period.end}`;
        const today = new Date().toISOString().split("T")[0];

        const properties: Record<string, any> = {
          title: { title: [{ text: { content: title } }] },
          date: { date: { start: today } },
          report: { select: { name: "etc" } },
        };

        if (wbDb === "knowledgeBase") {
          properties.summary = {
            rich_text: [
              {
                text: {
                  content: `${period.start} ~ ${period.end} 보고서 (${args.format})`,
                },
              },
            ],
          };
          properties.category = { select: { name: "기타" } };
        } else {
          properties.status = { select: { name: "확정" } };
          properties.rationale = {
            rich_text: [
              {
                text: { content: `보고서 자동 생성 (${args.format})` },
              },
            ],
          };
          properties.area = { select: { name: "기타" } };
        }

        // 본문은 paragraph 1개에 markdown text 압축 — 2000자 제한 (Notion API limit 안전 영역)
        const bodyText = text.slice(0, 2000);
        const notion = getNotionClient();
        const page: any = await callNotion(
          () =>
            notion.pages.create({
              parent: { database_id: dbId },
              properties,
              children: [
                {
                  object: "block",
                  type: "paragraph",
                  paragraph: {
                    rich_text: [
                      { type: "text", text: { content: bodyText } },
                    ],
                  },
                },
              ],
            }),
          { operation: `report.writeBack.${wbDb}` }
        );
        writeBack = { id: page.id, url: page.url, db: wbDb };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                period,
                format: args.format,
                text,
                groups: payload.groups,
                stats: payload.stats,
                writeBack,
                cache: { hit: cacheHit, key: cacheKey },
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
