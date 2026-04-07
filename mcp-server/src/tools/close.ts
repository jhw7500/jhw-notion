import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const CloseInput = z.object({
  project: z.string().describe("프로젝트명 (검색 키워드)"),
  achievement: z.string().optional().describe("달성한 것"),
  lessons: z.string().optional().describe("배운 점"),
});

export function registerClose(server: McpServer) {
  server.tool(
    "jhw_close",
    "프로젝트 종료 — 상태 완료 + 회고 추가 + Knowledge Base 학습사항",
    CloseInput.shape,
    async ({ project, achievement, lessons }) => {
      const notion = getNotionClient();
      const today = new Date().toISOString().split("T")[0];

      // 1. Projects DB에서 프로젝트 검색
      const projectsRes = await notion.databases.query({
        database_id: NOTION_CONFIG.databases.projects,
        filter: {
          property: "프로젝트명",
          title: { contains: project },
        },
      });

      if (projectsRes.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `프로젝트 "${project}"를 찾을 수 없습니다.` }],
        };
      }

      const projectPage = projectsRes.results[0] as any;

      // 2. 상태 → 완료, 완료일 설정
      await notion.pages.update({
        page_id: projectPage.id,
        properties: {
          "상태": { select: { name: "완료" } },
          "완료일": { date: { start: today } },
        },
      });

      // 3. 회고 섹션 추가 (있는 경우)
      if (achievement || lessons) {
        const retroBlocks: any[] = [
          {
            object: "block",
            type: "heading_2",
            heading_2: { rich_text: [{ text: { content: `회고 (${today})` } }] },
          },
        ];

        if (achievement) {
          retroBlocks.push(
            { object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: "달성한 것" } }] } },
            { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: achievement } }] } }
          );
        }

        if (lessons) {
          retroBlocks.push(
            { object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: "배운 점" } }] } },
            { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: lessons } }] } }
          );
        }

        await notion.blocks.children.append({
          block_id: projectPage.id,
          children: retroBlocks,
        });
      }

      // 4. 배운 점이 있으면 Knowledge Base에 등록
      let knowledgePage = null;
      if (lessons) {
        knowledgePage = await notion.pages.create({
          parent: { page_id: NOTION_CONFIG.pages.knowledgeBase },
          properties: {
            title: { title: [{ text: { content: `${project} 회고 — 배운 점` } }] },
          },
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: [{ text: { content: lessons } }] },
            },
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", text: { content: `프로젝트: ${project} | 날짜: ${today}` }, annotations: { italic: true } }],
              },
            },
          ],
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project: { id: projectPage.id, status: "완료" },
                retrospective: !!(achievement || lessons),
                knowledgeBase: knowledgePage ? { id: knowledgePage.id, url: (knowledgePage as any).url } : null,
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
