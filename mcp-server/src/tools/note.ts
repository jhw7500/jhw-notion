import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG, REPORT_VALUES } from "../config.js";
import { resolveProjectRelationId } from "./record.js";

// KB DB의 category select 옵션 (8종)
const KB_CATEGORIES = [
  "아키텍처",
  "문제해결",
  "베스트프랙티스",
  "드라이버",
  "빌드",
  "디버깅",
  "인프라",
  "기타",
] as const;

const NoteInput = z.object({
  title: z.string().describe("메모 제목"),
  content: z.string().describe("메모 내용 (본문 markdown)"),
  summary: z.string().optional().describe("한줄 요약 (테이블에서 보임)"),
  category: z
    .enum(KB_CATEGORIES)
    .optional()
    .describe("KB 카테고리 (8개 옵션 중)"),
  tags: z.string().optional().describe("태그 (comma-separated)"),
  project: z
    .string()
    .optional()
    .describe("관련 프로젝트 — projects DB title 키워드 / URL / ID"),
  report: z
    .enum(REPORT_VALUES)
    .optional()
    .describe("redmine 보고 분류. 개인 메모는 'none' 권장."),
});

export function registerNote(server: McpServer) {
  server.tool(
    "jhw_note",
    "Knowledge Base DB에 기술 지식이나 발견 사항을 메모 (DB 항목으로 저장)",
    NoteInput.shape,
    async ({ title, content, summary, category, tags, project, report }) => {
      const notion = getNotionClient();

      const properties: Record<string, any> = {
        title: { title: [{ text: { content: title } }] },
        date: { date: { start: new Date().toISOString().split("T")[0] } },
      };

      if (summary) {
        properties["summary"] = { rich_text: [{ text: { content: summary } }] };
      }
      if (category) {
        properties["category"] = { select: { name: category } };
      }
      if (tags) {
        properties["tags"] = {
          multi_select: tags.split(",").map((s) => ({ name: s.trim() })),
        };
      }
      if (report) {
        properties["report"] = { select: { name: report } };
      }
      if (project) {
        const relId = await resolveProjectRelationId(notion, project);
        if (relId) {
          properties["project"] = { relation: [{ id: relId }] };
        }
      }

      const children: any[] = [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content } }],
          },
        },
      ];

      const page = await notion.pages.create({
        parent: { database_id: NOTION_CONFIG.databases.knowledgeBase },
        properties,
        children,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { id: page.id, url: (page as any).url, title },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
