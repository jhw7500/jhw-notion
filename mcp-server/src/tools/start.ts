import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";

const StartInput = z.object({
  name: z.string().describe("프로젝트명"),
  repo: z.string().optional().describe("레포 경로"),
  stack: z.string().optional().describe("기술 스택"),
  description: z.string().describe("한 줄 설명"),
});

export function registerStart(server: McpServer) {
  server.tool(
    "jhw_start",
    "새 프로젝트 시작 — Projects DB 등록 + Decision Log 기록 + 페이지 템플릿",
    StartInput.shape,
    async ({ name, repo, stack, description }) => {
      const notion = getNotionClient();
      const today = new Date().toISOString().split("T")[0];

      // 1. Projects DB에 레코드 생성
      const projectProps: Record<string, any> = {
        "title": { title: [{ text: { content: name } }] },
        "status": { select: { name: "진행중" } },
        "description": { rich_text: [{ text: { content: description } }] },
        "start_date": { date: { start: today } },
      };
      if (repo) projectProps["repo"] = { rich_text: [{ text: { content: repo } }] };
      if (stack) projectProps["tech_stack"] = { multi_select: stack.split(",").map((s: string) => ({ name: s.trim() })) };

      const projectPage = await notion.pages.create({
        parent: { database_id: NOTION_CONFIG.databases.projects },
        properties: projectProps,
        children: [
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "목표" } }] } },
          { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: description } }] } },
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "범위" } }] } },
          { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: "(작업하면서 작성)" } }] } },
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "제약사항" } }] } },
          { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: "(작업하면서 작성)" } }] } },
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "메모" } }] } },
          { object: "block", type: "paragraph", paragraph: { rich_text: [] } },
        ],
      });

      // 2. Decision Log에 "프로젝트 시작" 기록
      const decisionPage = await notion.pages.create({
        parent: { database_id: NOTION_CONFIG.databases.decisionLog },
        properties: {
          "title": { title: [{ text: { content: `${name} 프로젝트 시작` } }] },
          "status": { select: { name: "확정" } },
          "area": { select: { name: "기타" } },
          "date": { date: { start: today } },
          "rationale": { rich_text: [{ text: { content: description } }] },
          "project": { rich_text: [{ text: { content: name } }] },
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project: { id: projectPage.id, url: (projectPage as any).url },
                decision: { id: decisionPage.id, url: (decisionPage as any).url },
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
