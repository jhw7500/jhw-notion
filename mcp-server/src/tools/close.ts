import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";
import { callNotion, queryDataSource } from "../notion/api.js";

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
      // Design Ref: §4.3 — close.ts:25 마이그레이션
      const projectsRes = await queryDataSource(
        notion,
        "projects",
        {
          filter: {
            property: "title",
            title: { contains: project },
          },
        },
        { operation: "close.projects.query" }
      );

      if (projectsRes.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `프로젝트 "${project}"를 찾을 수 없습니다.` }],
        };
      }

      const projectPage = projectsRes.results[0] as any;

      // 2. 상태 → 완료, 완료일 설정 (pages.update — wrapper 영향 없음)
      await callNotion(
        () =>
          notion.pages.update({
            page_id: projectPage.id,
            properties: {
              "status": { select: { name: "완료" } },
              "end_date": { date: { start: today } },
            },
          }),
        { operation: "close.projects.update" }
      );

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

        await callNotion(
          () =>
            notion.blocks.children.append({
              block_id: projectPage.id,
              children: retroBlocks,
            }),
          { operation: "close.blocks.append" }
        );
      }

      // 4. 배운 점이 있으면 Knowledge Base DB에 등록 (pages.create — wrapper 영향 없음)
      let knowledgePage = null;
      if (lessons) {
        knowledgePage = await callNotion(
          () =>
            notion.pages.create({
              parent: { database_id: NOTION_CONFIG.databases.knowledgeBase },
              properties: {
                title: { title: [{ text: { content: `${project} 회고 — 배운 점` } }] },
                summary: { rich_text: [{ text: { content: `${project} 종료 회고` } }] },
                category: { select: { name: "베스트프랙티스" } },
                project: { relation: [{ id: projectPage.id }] },
                date: { date: { start: today } },
              },
              children: [
                {
                  object: "block",
                  type: "paragraph",
                  paragraph: { rich_text: [{ text: { content: lessons } }] },
                },
              ],
            }),
          { operation: "close.knowledgeBase.create" }
        );
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
