import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const NoteInput = z.object({
  title: z.string().describe("메모 제목"),
  content: z.string().describe("메모 내용"),
  project: z.string().optional().describe("관련 프로젝트명"),
});

export function registerNote(server: McpServer) {
  server.tool(
    "jhw_note",
    "Knowledge Base에 기술 지식이나 발견 사항을 메모",
    NoteInput.shape,
    async ({ title, content, project }) => {
      const notion = getNotionClient();

      const children: any[] = [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content } }],
          },
        },
      ];

      if (project) {
        children.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: `관련 프로젝트: ${project}` }, annotations: { bold: true } },
            ],
          },
        });
      }

      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { content: `작성일: ${new Date().toISOString().split("T")[0]}` },
              annotations: { italic: true },
            },
          ],
        },
      });

      const page = await notion.pages.create({
        parent: { page_id: NOTION_CONFIG.pages.knowledgeBase },
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
        children,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: page.id, url: (page as any).url, title }, null, 2),
          },
        ],
      };
    }
  );
}
