// 공통 project resolver.
// projects DB에서 input(키워드/URL/UUID)으로 페이지를 찾아 ID 반환.
// (P0-1: record/context/history/start의 4중 분산 로직 통합)
// p1-3c: notion.databases.query → notion.dataSources.query (via queryDataSource wrapper).
import type { Client } from "@notionhq/client";
import { queryDataSource } from "./api.js";

const UUID_RE =
  /([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function normalizeUuid(raw: string): string {
  if (raw.includes("-")) return raw;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export interface ProjectCandidate {
  id: string;
  title: string;
  /** input과 title이 정확히 (case-insensitive) 일치 */
  exact: boolean;
}

/**
 * projects DB에서 input으로 후보를 찾아 정확도 높은 순으로 반환.
 * - URL/UUID이면 즉시 단일 후보 반환 (exact=true).
 * - 키워드면 contains 검색 후 case-insensitive exact 우선 정렬.
 * - 검색 실패/0건이면 빈 배열 (caller가 fallback 결정).
 */
export async function resolveProject(
  notion: Client,
  input: string
): Promise<ProjectCandidate[]> {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const m = trimmed.match(UUID_RE);
  if (m) {
    return [{ id: normalizeUuid(m[0]), title: trimmed, exact: true }];
  }

  try {
    // Design Ref: §4.3 — resolve-project.ts:44 마이그레이션
    const res = await queryDataSource(
      notion,
      "projects",
      {
        filter: { property: "title", title: { contains: trimmed } },
        page_size: 25,
      },
      { operation: "projects.query.resolve" }
    );
    const lower = trimmed.toLowerCase();
    return (res.results as any[])
      .map((p) => {
        // 제목은 여러 rich_text 세그먼트(스타일/멘션)로 나뉠 수 있어 전체를 join.
        const title: string = (p.properties?.title?.title ?? [])
          .map((t: any) => t.plain_text)
          .join("");
        return { id: p.id, title, exact: title.toLowerCase() === lower };
      })
      .sort((a, b) => Number(b.exact) - Number(a.exact));
  } catch {
    return [];
  }
}

/** 단일 ID 반환. 후보 없으면 null. (기존 resolveProjectRelationId 대체) */
export async function resolveProjectId(
  notion: Client,
  input: string
): Promise<string | null> {
  const list = await resolveProject(notion, input);
  return list[0]?.id ?? null;
}

/**
 * 이미 조회한 projects 결과 배열을 input과 정확(case-insensitive) 일치하는 페이지 우선으로 정렬.
 * resolveProject과 달리 full page 객체를 보존하므로 properties가 필요한 호출부(context/history)에서 사용.
 * (close.ts의 부분일치 오종료 방지와 동일한 exact-우선 정책을 조회 도구에도 적용 — P1-2)
 */
export function sortProjectsByExact<T extends { properties?: any }>(
  results: T[],
  input: string
): T[] {
  const lower = input.trim().toLowerCase();
  return [...results].sort((a, b) => {
    const at = (a.properties?.title?.title?.[0]?.plain_text ?? "").toLowerCase();
    const bt = (b.properties?.title?.title?.[0]?.plain_text ?? "").toLowerCase();
    return Number(bt === lower) - Number(at === lower);
  });
}
