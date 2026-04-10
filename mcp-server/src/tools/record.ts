import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG, DatabaseName } from "../config.js";

const RecordInput = z.object({
  db: z.enum(["decisionLog", "preferences", "projects", "references"]).describe("저장 대상 DB"),
  title: z.string().describe("레코드 제목"),
  properties: z
    .object({
      status: z.string().optional().describe("상태 (확정/검토중/폐기)"),
      rationale: z.string().optional().describe("근거 (decisionLog)"),
      alternatives: z.string().optional().describe("대안 (decisionLog)"),
      area: z.string().optional().describe("영역 (decisionLog)"),
      project: z.string().optional().describe("관련 프로젝트"),
      category: z.string().optional().describe("범주 (preferences)"),
      repo: z.string().optional().describe("레포 경로 (projects)"),
      stack: z.string().optional().describe("기술 스택 (projects)"),
      description: z.string().optional().describe("설명 (projects)"),
    })
    .optional()
    .describe("추가 프로퍼티"),
});

function buildNotionProperties(db: string, title: string, props: any) {
  const p: Record<string, any> = {};

  if (db === "decisionLog") {
    p["title"] = { title: [{ text: { content: title } }] };
    if (props?.status) p["status"] = { select: { name: props.status } };
    else p["status"] = { select: { name: "확정" } };
    if (props?.rationale) p["rationale"] = { rich_text: [{ text: { content: props.rationale } }] };
    if (props?.alternatives) p["alternatives"] = { rich_text: [{ text: { content: props.alternatives } }] };
    if (props?.area) p["area"] = { select: { name: props.area } };
    if (props?.project)
      p["project"] = { rich_text: [{ text: { content: props.project } }] };
    p["date"] = { date: { start: new Date().toISOString().split("T")[0] } };
  } else if (db === "preferences") {
    p["title"] = { title: [{ text: { content: title } }] };
    if (props?.category) p["category"] = { select: { name: props.category } };
  } else if (db === "projects") {
    p["title"] = { title: [{ text: { content: title } }] };
    if (props?.status) p["status"] = { select: { name: props.status } };
    else p["status"] = { select: { name: "진행중" } };
    if (props?.repo) p["repo"] = { rich_text: [{ text: { content: props.repo } }] };
    if (props?.stack) p["tech_stack"] = { multi_select: props.stack.split(",").map((s: string) => ({ name: s.trim() })) };
    if (props?.description) p["description"] = { rich_text: [{ text: { content: props.description } }] };
    p["start_date"] = { date: { start: new Date().toISOString().split("T")[0] } };
  }

  return p;
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

      const notionProps = buildNotionProperties(db, title, properties);

      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties: notionProps,
      });

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
