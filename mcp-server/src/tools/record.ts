import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@notionhq/client";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG, DatabaseName, REPORT_VALUES } from "../config.js";
import { resolveProjectId } from "../notion/resolve-project.js";
import { callNotion } from "../notion/api.js";
import { buildPropertiesFromSchema } from "../notion/property-builder.js";

const RecordInput = z.object({
  db: z
    .enum(["decisionLog", "preferences", "projects", "references", "knowledgeBase"])
    .describe("저장 대상 DB"),
  title: z.string().describe("레코드 제목"),
  properties: z
    .object({
      status: z.string().optional().describe("상태 (확정/검토중/폐기 등)"),
      report: z
        .enum(REPORT_VALUES)
        .optional()
        .describe(
          "redmine 보고 분류 (5개 DB 공통). 미설정 시 keyword fallback. 'none'=보고 제외."
        ),
      rationale: z.string().optional().describe("근거 (decisionLog)"),
      alternatives: z.string().optional().describe("대안 (decisionLog)"),
      area: z.string().optional().describe("영역 (decisionLog의 select)"),
      project: z
        .string()
        .optional()
        .describe(
          "관련 프로젝트 — projects DB의 페이지 title 키워드. 자동으로 검색해 relation으로 연결. URL/ID 직접 가능. (decisionLog/knowledgeBase/references 공통)"
        ),
      category: z
        .string()
        .optional()
        .describe(
          "범주 (preferences/knowledgeBase/references — 각 DB의 select 옵션명)"
        ),
      summary: z.string().optional().describe("한줄 요약 (knowledgeBase, references)"),
      tags: z
        .string()
        .optional()
        .describe("태그 (knowledgeBase multi_select, comma-separated)"),
      tool: z
        .string()
        .optional()
        .describe("도구 (references multi_select, comma-separated)"),
      url: z.string().optional().describe("참조 URL (references)"),
      repo: z.string().optional().describe("레포 경로 (projects)"),
      stack: z
        .string()
        .optional()
        .describe("기술 스택 (projects multi_select, comma-separated)"),
      description: z.string().optional().describe("설명 (projects)"),
    })
    .optional()
    .describe("추가 프로퍼티"),
});

// 공통 resolver로 위임. 외부 호환을 위해 named export 유지.
export const resolveProjectRelationId = resolveProjectId;

// schema-driven property builder로 위임 (P1-2).
// record.ts의 input은 일부 alias가 있어 schema 키로 변환:
// - stack → tech_stack (projects)
async function buildNotionProperties(
  db: DatabaseName,
  title: string,
  props: any,
  notion: Client
) {
  const mapped: Record<string, any> = { ...(props ?? {}) };
  if (props?.stack !== undefined) mapped.tech_stack = props.stack;
  return buildPropertiesFromSchema(db, title, mapped, notion);
}

export function registerRecord(server: McpServer) {
  server.tool(
    "jhw_record",
    "Notion AI Workspace DB에 레코드 생성",
    RecordInput.shape,
    async ({ db, title, properties }) => {
      const notion = getNotionClient();
      const dbId = NOTION_CONFIG.databases[db as DatabaseName];

      if (!dbId) {
        return {
          content: [{ type: "text" as const, text: `알 수 없는 DB: ${db}` }],
        };
      }

      const notionProps = await buildNotionProperties(
        db as DatabaseName,
        title,
        properties,
        notion
      );

      const page = await callNotion(
        () =>
          notion.pages.create({
            parent: { database_id: dbId },
            properties: notionProps,
          }),
        { operation: `${db}.pages.create` }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { id: page.id, url: (page as any).url, db, title },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
