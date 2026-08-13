import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG } from "../config.js";
import { callNotion } from "../notion/api.js";
import { applyMultiSelectGuard } from "../notion/multi-select-guard.js";
import { cachePage } from "../cache/page-cache.js";
import { buildStartBody } from "../notion/templates.js";
import {
  authorityMcpError,
  defaultNotionAuthorityGuard,
  type NotionAuthorityGuard,
} from "../notion/authority-guard.js";

const StartInput = z.object({
  name: z.string().describe("프로젝트명"),
  repo: z.string().optional().describe("레포 경로"),
  stack: z.string().optional().describe("기술 스택"),
  description: z.string().describe("한 줄 설명"),
  allowNewTags: z
    .boolean()
    .optional()
    .describe("미등록 tech_stack 값을 drop 대신 자동 등록(--force-tag). 기본 false."),
});

export function registerStart(server: McpServer, authority: NotionAuthorityGuard = defaultNotionAuthorityGuard) {
  server.tool(
    "jhw_start",
    "새 프로젝트 시작 — Projects DB 등록 + Decision Log 기록 + 페이지 템플릿",
    StartInput.shape,
    async ({ name, repo, stack, description, allowNewTags }) => {
      try {
        await authority.assertNotionWriteAllowed("projects", "jhw_start");
        await authority.assertNotionWriteAllowed("decisionLog", "jhw_start");
      } catch (cause) {
        const denied = authorityMcpError(cause, "projects", "jhw_start");
        if (denied) return denied;
        throw cause;
      }
      const notion = getNotionClient();
      const today = new Date().toISOString().split("T")[0];
      const warnings: string[] = [];

      // 1. Projects DB에 레코드 생성
      const projectProps: Record<string, any> = {
        "title": { title: [{ text: { content: name } }] },
        "status": { select: { name: "진행중" } },
        "description": { rich_text: [{ text: { content: description } }] },
        "start_date": { date: { start: today } },
      };
      if (repo) projectProps["repo"] = { rich_text: [{ text: { content: repo } }] };
      if (stack) {
        // 어휘 가드(별칭 정규화+중복제거) + opt-in 자동 등록.
        const names = await applyMultiSelectGuard(
          notion,
          "projects",
          "tech_stack",
          stack.split(","),
          { allowNew: allowNewTags, warnings }
        );
        if (names.length > 0) {
          projectProps["tech_stack"] = {
            multi_select: names.map((name) => ({ name })),
          };
        }
      }

      const projectPage = await callNotion(
        () =>
          notion.pages.create({
            parent: { database_id: NOTION_CONFIG.databases.projects },
            properties: projectProps,
            children: buildStartBody({ description, stack, repo }),
          }),
        { operation: "start.projects.create" }
      );

      // 2. Decision Log에 "프로젝트 시작" 기록 — project를 relation으로 (rich_text 아님)
      const decisionPage = await callNotion(
        () =>
          notion.pages.create({
            parent: { database_id: NOTION_CONFIG.databases.decisionLog },
            properties: {
              "title": { title: [{ text: { content: `${name} 프로젝트 시작` } }] },
              "status": { select: { name: "확정" } },
              "area": { select: { name: "기타" } },
              "date": { date: { start: today } },
              "rationale": { rich_text: [{ text: { content: description } }] },
              "project": { relation: [{ id: projectPage.id }] },
            },
          }),
        { operation: "start.decisionLog.create" }
      );

      cachePage({
        id: projectPage.id,
        db: "projects",
        title: name,
        url: (projectPage as any).url,
        text: description,
      });
      cachePage({
        id: decisionPage.id,
        db: "decisionLog",
        title: `${name} 프로젝트 시작`,
        url: (decisionPage as any).url,
        text: description,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                project: { id: projectPage.id, url: (projectPage as any).url },
                decision: { id: decisionPage.id, url: (decisionPage as any).url },
                ...(warnings.length > 0 ? { warnings } : {}),
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
