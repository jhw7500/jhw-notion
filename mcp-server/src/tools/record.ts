import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@notionhq/client";
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
      project: z
        .string()
        .optional()
        .describe(
          "관련 프로젝트 — projects DB의 페이지 title 키워드. 자동으로 검색해 relation으로 연결. 페이지 URL/ID 직접 전달 가능."
        ),
      category: z.string().optional().describe("범주 (preferences)"),
      repo: z.string().optional().describe("레포 경로 (projects)"),
      stack: z.string().optional().describe("기술 스택 (projects)"),
      description: z.string().optional().describe("설명 (projects)"),
    })
    .optional()
    .describe("추가 프로퍼티"),
});

// projects DB에서 keyword로 페이지 검색하여 ID 반환.
// 입력이 이미 URL/ID면 바로 파싱하여 반환.
async function resolveProjectRelationId(
  notion: Client,
  input: string
): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // URL에서 ID 추출 시도 (e.g., https://www.notion.so/title-abcdef...)
  const urlMatch = trimmed.match(/([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (urlMatch) {
    return urlMatch[0].includes("-")
      ? urlMatch[0]
      : `${urlMatch[0].slice(0, 8)}-${urlMatch[0].slice(8, 12)}-${urlMatch[0].slice(12, 16)}-${urlMatch[0].slice(16, 20)}-${urlMatch[0].slice(20)}`;
  }

  // keyword로 projects DB 쿼리
  try {
    const result = await notion.databases.query({
      database_id: NOTION_CONFIG.databases.projects,
      filter: {
        property: "title",
        title: { contains: trimmed },
      },
      page_size: 3,
    });
    if (result.results.length > 0) {
      return result.results[0].id;
    }
  } catch (err) {
    // fall through
  }
  return null;
}

async function buildNotionProperties(
  db: string,
  title: string,
  props: any,
  notion: Client
) {
  const p: Record<string, any> = {};

  if (db === "decisionLog") {
    p["title"] = { title: [{ text: { content: title } }] };
    if (props?.status) p["status"] = { select: { name: props.status } };
    else p["status"] = { select: { name: "확정" } };
    if (props?.rationale) p["rationale"] = { rich_text: [{ text: { content: props.rationale } }] };
    if (props?.alternatives) p["alternatives"] = { rich_text: [{ text: { content: props.alternatives } }] };
    if (props?.area) p["area"] = { select: { name: props.area } };
    if (props?.project) {
      const relId = await resolveProjectRelationId(notion, props.project);
      if (relId) {
        p["project"] = { relation: [{ id: relId }] };
      }
      // 매칭 실패 시 project 필드 생략 (rich_text fallback은 DB가 relation이라 에러 유발)
    }
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

      const notionProps = await buildNotionProperties(db, title, properties, notion);

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
