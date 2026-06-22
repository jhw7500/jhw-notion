import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@notionhq/client";
import { getNotionClient } from "../notion-client.js";
import { NOTION_CONFIG, DatabaseName, REPORT_VALUES } from "../config.js";
import { resolveProjectId } from "../notion/resolve-project.js";
import { callNotion } from "../notion/api.js";
import { buildPropertiesFromSchema } from "../notion/property-builder.js";
import { FieldValidationError } from "../notion/field-vocab.js";
import { paragraphBlocks } from "../notion/blocks.js";
import { cachePage } from "../cache/page-cache.js";

const RecordInput = z.object({
  db: z
    .enum(["decisionLog", "preferences", "projects", "references", "knowledgeBase"])
    .describe("저장 대상 DB"),
  title: z.string().describe("레코드 제목"),
  content: z
    .string()
    .optional()
    .describe(
      "본문 markdown (선택). `\\n\\n`으로 paragraph 분리. 각 paragraph 2000자 한도(초과 시 자동 split). " +
        "preferences/projects 등 properties에 본문 필드가 없는 DB에서 특히 유용."
    ),
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
      impact: z
        .string()
        .optional()
        .describe(
          "임팩트 — 성과 한 줄 (projects 완료/decisionLog 확정 항목에 권장). 🏆 성과 뷰·보고서에 노출. 사실·수치 기반."
        ),
      achievement: z
        .boolean()
        .optional()
        .describe(
          "성과 플래그 — 제출용 강조 체크 (projects/decisionLog). impact와 함께 설정 권장 (성과만 켜고 임팩트가 비면 🏆 성과 뷰에 설명 없는 항목이 남음)."
        ),
    })
    .optional()
    .describe("추가 프로퍼티"),
  allowNewTags: z
    .boolean()
    .optional()
    .describe("미등록 multi_select 값(tags/tool/tech_stack)을 drop 대신 data source에 자동 등록(--force-tag). 기본 false."),
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
  notion: Client,
  warnings?: string[],
  allowNewTags?: boolean
) {
  const mapped: Record<string, any> = { ...(props ?? {}) };
  if (props?.stack !== undefined) mapped.tech_stack = props.stack;
  // 성과 자동 정리(projects 완료/decisionLog 확정): 영문 입력키 → Notion 한글 프로퍼티명.
  if (props?.impact !== undefined) mapped["임팩트"] = props.impact;
  if (props?.achievement !== undefined) mapped["성과"] = props.achievement;
  return buildPropertiesFromSchema(db, title, mapped, notion, {
    warnings,
    allowNewTags,
  });
}

export function registerRecord(server: McpServer) {
  server.tool(
    "jhw_record",
    "Notion AI Workspace DB에 레코드 생성",
    RecordInput.shape,
    async ({ db, title, content, properties, allowNewTags }) => {
      const notion = getNotionClient();
      const dbId = NOTION_CONFIG.databases[db as DatabaseName];

      if (!dbId) {
        return {
          content: [{ type: "text" as const, text: `알 수 없는 DB: ${db}` }],
        };
      }

      // 어휘 가드: select 미허용은 throw(저장 차단), multi_select 미등록은 drop+경고.
      const warnings: string[] = [];
      let notionProps: Record<string, any>;
      try {
        notionProps = await buildNotionProperties(
          db as DatabaseName,
          title,
          properties,
          notion,
          warnings,
          allowNewTags
        );
      } catch (e) {
        if (e instanceof FieldValidationError) {
          return {
            content: [{ type: "text" as const, text: e.message }],
          };
        }
        throw e;
      }

      const children = paragraphBlocks(content);
      const page = await callNotion(
        () =>
          notion.pages.create({
            parent: { database_id: dbId },
            properties: notionProps,
            ...(children.length > 0 ? { children } : {}),
          }),
        { operation: `${db}.pages.create` }
      );

      cachePage({
        id: page.id,
        db,
        title,
        url: (page as any).url,
        text: content || title,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: page.id,
                url: (page as any).url,
                db,
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
