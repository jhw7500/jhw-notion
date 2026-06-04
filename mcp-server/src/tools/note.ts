import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG, REPORT_VALUES } from "../config.js";
import { resolveProjectRelationId } from "./record.js";
import { callNotion } from "../notion/api.js";
import { paragraphBlocks } from "../notion/blocks.js";
import { normalizeMultiSelectValues } from "../notion/field-vocab.js";

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
      const warnings: string[] = [];

      if (summary) {
        properties["summary"] = { rich_text: [{ text: { content: summary } }] };
      }
      if (category) {
        properties["category"] = { select: { name: category } };
      }
      if (tags) {
        // 어휘 가드: 별칭 정규화 + 중복제거. 미등록 태그는 drop하고 경고.
        const { kept, dropped } = normalizeMultiSelectValues(
          "knowledgeBase",
          "tags",
          tags.split(",")
        );
        if (dropped.length > 0) {
          warnings.push(
            `[knowledgeBase.tags] 미등록 값 ${dropped.length}개 제외: ${dropped.join(", ")}`
          );
        }
        if (kept.length > 0) {
          properties["tags"] = {
            multi_select: kept.map((name) => ({ name })),
          };
        }
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

      // 본문을 paragraph block 배열로 변환 — 긴 본문도 \n\n 기준으로 자동 분할
      // (record.ts와 동일 헬퍼 사용, 2000자 한도 안전망 포함)
      const children = paragraphBlocks(content);

      const page = await callNotion(
        () =>
          notion.pages.create({
            parent: { database_id: NOTION_CONFIG.databases.knowledgeBase },
            properties,
            children,
          }),
        { operation: "note.knowledgeBase.create" }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: page.id,
                url: (page as any).url,
                title,
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
