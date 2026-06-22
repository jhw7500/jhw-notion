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
  | "url"
  | "checkbox";

export interface PropertyMeta {
  type: PropertyType;
  /** relation의 경우 target DB 이름 */
  target?: DatabaseName;
  /** select default 값 */
  default?: string;
}

export interface DatabaseSchema {
  id: string;
  /**
   * Notion API v5(2025-09-03~) 의 dataSources.query() 호출에 필요한 data_source_id.
   * 본 프로젝트의 5개 DB는 모두 1:1 (count=1) 매핑이라 단일 string.
   * 조회 일자: 2026-05-08 (Notion-Version: 2025-09-03).
   * 후속 사이클(p1-3c)에서 databases.query → dataSources.query 마이그레이션 시 사용.
   */
  dataSourceId: string;
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
    dataSourceId: "d45ed33c-26ee-45be-ad9c-513db7c422e0",
    title: "title",
    properties: {
      status: { type: "select", default: "진행중" },
      repo: { type: "rich_text" },
      tech_stack: { type: "multi_select" },
      description: { type: "rich_text" },
      start_date: { type: "date" },
      end_date: { type: "date" },
      report: { type: "select" },
      // 성과 정리용 (2026-06): 완료 작업의 성과 한 줄 + 제출 강조 플래그.
      임팩트: { type: "rich_text" },
      성과: { type: "checkbox" },
    },
  },
  preferences: {
    id: NOTION_CONFIG.databases.preferences,
    dataSourceId: "634f7b00-b7a2-447b-9514-a109b57557a8",
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
    dataSourceId: "c1d8d3c3-538e-40a9-a306-2b694a4d8ff9",
    title: "title",
    project: projectsRel,
    properties: {
      status: { type: "select", default: "확정" },
      rationale: { type: "rich_text" },
      alternatives: { type: "rich_text" },
      area: { type: "select" },
      date: { type: "date" },
      report: { type: "select" },
      // 성과 정리용 (2026-06): 확정 결정의 성과 한 줄 + 제출 강조 플래그.
      임팩트: { type: "rich_text" },
      성과: { type: "checkbox" },
    },
  },
  knowledgeBase: {
    id: NOTION_CONFIG.databases.knowledgeBase,
    dataSourceId: "6a4615db-ba17-44a8-b3c7-6688dce9c2fa",
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
    dataSourceId: "2917f7ce-c7a7-4301-a2fc-48137876c9a7",
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

/**
 * Notion v5 dataSources.query() 호출에 필요한 data_source_id 조회 헬퍼.
 * 후속 사이클(p1-3c)에서 databases.query → dataSources.query 마이그레이션 시 사용.
 */
export function getDataSourceId(db: DatabaseName): string {
  return DATABASE_SCHEMAS[db].dataSourceId;
}

export function getProjectFieldType(db: DatabaseName): PropertyType | null {
  return DATABASE_SCHEMAS[db]?.project?.type ?? null;
}

export function getDatabaseId(db: DatabaseName): string {
  return DATABASE_SCHEMAS[db].id;
}
