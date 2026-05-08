// 보고서 다중 DB 조회 (P0-3).
// 기간 + report 필드를 기준으로 5개 DB에서 페이지를 가져온다.
// schema.ts 메타데이터 기반 — DB 추가 시 query 코드 변경 불필요.
import type { Client } from "@notionhq/client";
import { DATABASE_SCHEMAS } from "../schema.js";
import {
  type DatabaseName,
  type ReportValue,
  REPORT_VALUES,
} from "../config.js";
import { callNotion } from "../notion/api.js";

export interface ReportItem {
  id: string;
  db: DatabaseName;
  title: string;
  date: string;
  projectId?: string;
  url?: string;
  report?: ReportValue;
  /** "report" = report 필드 매칭, "keywordFallback" = report 미설정 (legacy) */
  source: "report" | "keywordFallback";
}

export interface QueryOptions {
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  end: string;
  /** 필터: 특정 report 값만 (기본: none 제외 전체) */
  reports?: ReportValue[];
  /** 조회 대상 DB (기본: schema.ts의 모든 DB) */
  dbs?: DatabaseName[];
  /** none(보고 제외) 항목도 포함 (기본 false) */
  includeNone?: boolean;
}

/** schema에서 date 프로퍼티 키를 결정. decisionLog/knowledgeBase는 "date", projects는 "start_date". */
function resolveDateProp(db: DatabaseName): string | null {
  const schema = DATABASE_SCHEMAS[db];
  if (!schema) return null;
  if (schema.properties.date?.type === "date") return "date";
  if (schema.properties.start_date?.type === "date") return "start_date";
  return null;
}

export async function queryReportItems(
  notion: Client,
  opts: QueryOptions
): Promise<ReportItem[]> {
  const dbsToQuery: DatabaseName[] =
    opts.dbs ?? (Object.keys(DATABASE_SCHEMAS) as DatabaseName[]);
  const baseReports =
    opts.reports ??
    REPORT_VALUES.filter((r) => (opts.includeNone ? true : r !== "none"));

  const all: ReportItem[] = [];

  for (const db of dbsToQuery) {
    const schema = DATABASE_SCHEMAS[db];
    if (!schema) continue;

    const dateProp = resolveDateProp(db);
    const hasReport = !!schema.properties.report;

    const filters: any[] = [];
    if (dateProp) {
      filters.push({
        property: dateProp,
        date: { on_or_after: opts.start, on_or_before: opts.end },
      });
    }
    if (hasReport && baseReports.length > 0) {
      filters.push({
        or: baseReports.map((r) => ({
          property: "report",
          select: { equals: r },
        })),
      });
    }

    const filter =
      filters.length === 0
        ? undefined
        : filters.length === 1
        ? filters[0]
        : { and: filters };

    const res = await callNotion(
      () =>
        notion.databases.query({
          database_id: schema.id,
          filter,
          sorts: dateProp
            ? [{ property: dateProp, direction: "ascending" }]
            : [
                {
                  timestamp: "last_edited_time",
                  direction: "ascending",
                },
              ],
          page_size: 100,
        }),
      { operation: `report.query.${db}` }
    );

    for (const page of res.results as any[]) {
      const dateValue =
        (dateProp && page.properties?.[dateProp]?.date?.start) ||
        page.last_edited_time?.split("T")[0] ||
        "";
      // 메모리 사이드 기간 필터 — server filter 결과를 신뢰하지 않는다.
      // 이유: notion.databases.query의 date filter가 multi-data-source DB
      // (Projects/DecisionLog/KnowledgeBase) 에서 silently 무시됨을
      // 2026-05-08 시뮬레이션(CASE-A 미래기간/CASE-G 단일일)에서 확인.
      // SDK v3 + dataSources.query 마이그레이션은 별도 plan(P1-3b).
      if (dateValue) {
        if (dateValue < opts.start || dateValue > opts.end) continue;
      }
      const reportVal = page.properties?.report?.select?.name as
        | ReportValue
        | undefined;
      const titleProp = page.properties?.[schema.title]?.title;
      const title = titleProp?.[0]?.plain_text ?? "(제목 없음)";
      all.push({
        id: page.id,
        db,
        title,
        date: dateValue,
        projectId: page.properties?.project?.relation?.[0]?.id,
        url: page.url,
        report: reportVal,
        source: reportVal ? "report" : "keywordFallback",
      });
    }
  }

  return all;
}
