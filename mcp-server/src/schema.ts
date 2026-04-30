// DB schema metadata.
// project 필드 타입을 한 곳에서 정의하여 record/context/history/start가
// 동일한 기준(relation)으로 동작하게 한다.
// (P0-1: 신규 DB 추가 시 코드 변경 최소화)
import { NOTION_CONFIG, type DatabaseName } from "./config.js";

export type PropertyType =
  | "title"
  | "select"
  | "rich_text"
  | "multi_select"
  | "relation"
  | "date"
  | "url";

export interface PropertyMeta {
  type: PropertyType;
  /** relation의 경우 target DB 이름 */
  target?: DatabaseName;
  /** select default 값 */
  default?: string;
}

export interface DatabaseSchema {
  id: string;
  /** title 프로퍼티 키 */
  title: string;
  /** project 필드 정의 (없으면 undefined) */
  project?: PropertyMeta;
  /** 기타 프로퍼티 메타 */
  properties: Record<string, PropertyMeta>;
}

const projectsRel: PropertyMeta = { type: "relation", target: "projects" };

export const DATABASE_SCHEMAS: Record<DatabaseName, DatabaseSchema> = {
  projects: {
    id: NOTION_CONFIG.databases.projects,
    title: "title",
    properties: {
      status: { type: "select", default: "진행중" },
      repo: { type: "rich_text" },
      tech_stack: { type: "multi_select" },
      description: { type: "rich_text" },
      start_date: { type: "date" },
      end_date: { type: "date" },
      report: { type: "select" },
    },
  },
  preferences: {
    id: NOTION_CONFIG.databases.preferences,
    title: "title",
    // preferences는 project 필드가 없음
    properties: {
      category: { type: "select" },
      content: { type: "rich_text" },
      tools: { type: "multi_select" },
      priority: { type: "select" },
      report: { type: "select" },
    },
  },
  decisionLog: {
    id: NOTION_CONFIG.databases.decisionLog,
    title: "title",
    project: projectsRel,
    properties: {
      status: { type: "select", default: "확정" },
      rationale: { type: "rich_text" },
      alternatives: { type: "rich_text" },
      area: { type: "select" },
      date: { type: "date" },
      report: { type: "select" },
    },
  },
  knowledgeBase: {
    id: NOTION_CONFIG.databases.knowledgeBase,
    title: "title",
    project: projectsRel,
    properties: {
      summary: { type: "rich_text" },
      category: { type: "select" },
      tags: { type: "multi_select" },
      date: { type: "date" },
      report: { type: "select" },
    },
  },
  references: {
    id: NOTION_CONFIG.databases.references,
    title: "title",
    project: projectsRel,
    properties: {
      summary: { type: "rich_text" },
      category: { type: "select" },
      tool: { type: "multi_select" },
      url: { type: "url" },
      report: { type: "select" },
    },
  },
};

export function getProjectFieldType(db: DatabaseName): PropertyType | null {
  return DATABASE_SCHEMAS[db]?.project?.type ?? null;
}

export function getDatabaseId(db: DatabaseName): string {
  return DATABASE_SCHEMAS[db].id;
}
