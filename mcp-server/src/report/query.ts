// 보고서 다중 DB 조회 (P0-3 + p1-3c).
// 기간 + report 필드를 기준으로 5개 DB에서 페이지를 가져온다.
// schema.ts 메타데이터 기반 — DB 추가 시 query 코드 변경 불필요.
// p1-3c: notion.databases.query → notion.dataSources.query (via queryDataSource wrapper).
import type { Client } from "@notionhq/client";
import { DATABASE_SCHEMAS } from "../schema.js";
import {
  type DatabaseName,
  type ReportValue,
  REPORT_VALUES,
} from "../config.js";
import { queryDataSource } from "../notion/api.js";

/** projects/decisionLog의 "임팩트"(성과 한 줄) Notion 프로퍼티 키 — 리뷰 반영: 하드코딩 단일화. */
const IMPACT_PROP = "임팩트";

export interface ReportItem {
  id: string;
  db: DatabaseName;
  title: string;
  date: string;
  projectId?: string;
  url?: string;
  report?: ReportValue;
  /** 임팩트(성과 한 줄) — projects/decisionLog DB에만 존재, 그 외 DB는 undefined */
  impact?: string;
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

    // Design Ref: §4.3 — report/query.ts:91 마이그레이션 (dynamic db loop)
    const res = await queryDataSource(
      notion,
      db,
      {
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
      },
      // p1-3d: 보고서는 N건 모두 필요 — wrapper의 paginate 옵션으로 next_cursor 자동 루프.
      // 다른 9 호출(history/context/status 등)은 의도적 N건 cap이라 paginate 미지정.
      { operation: `report.query.${db}`, paginate: true }
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
      // p1-3c에서 dataSources.query로 마이그레이션 후에도 보험으로 유지 (Plan SC FR-08).
      if (dateValue) {
        if (dateValue < opts.start || dateValue > opts.end) continue;
      }
      const reportVal = page.properties?.report?.select?.name as
        | ReportValue
        | undefined;
      const titleProp = page.properties?.[schema.title]?.title;
      const title = titleProp?.[0]?.plain_text ?? "(제목 없음)";
      // 임팩트(text) — projects/decisionLog에만 존재. 여러 rich_text 조각을 합치고
      // 개행/연속공백을 단일 공백으로 정리 (단일 라인 보고서 깨짐 방지, 리뷰 반영).
      const impactRaw = page.properties?.[IMPACT_PROP]?.rich_text
        ?.map((t: any) => t.plain_text ?? "")
        .join("");
      const impact = impactRaw?.replace(/\s+/g, " ").trim() || undefined;
      all.push({
        id: page.id,
        db,
        title,
        date: dateValue,
        projectId: page.properties?.project?.relation?.[0]?.id,
        url: page.url,
        report: reportVal,
        impact,
        source: reportVal ? "report" : "keywordFallback",
      });
    }
  }

  return all;
}
