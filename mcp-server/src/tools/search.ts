import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNotionClient } from "../notion-client.js";
import { dbNameFromParent } from "../schema.js";
import { NOTION_CONFIG, type DatabaseName } from "../config.js";
import { callNotion } from "../notion/api.js";

// z.enum은 non-empty string tuple을 요구 — config의 DB 이름에서 파생(신규 DB 추가 시 자동 반영).
const DB_NAMES = Object.keys(NOTION_CONFIG.databases) as [DatabaseName, ...DatabaseName[]];

const SearchInput = z.object({
  query: z.string().describe("검색 키워드"),
  db: z
    .enum(DB_NAMES)
    .optional()
    .describe(
      "특정 DB로 한정 — 전역 검색을 페이지네이션하며 해당 DB 결과만 수집해 반환. 미지정 시 전역 top-N. (동일 DB 중복 대조 등에 사용)"
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("반환 개수 (기본 10)"),
});

// Notion search의 page_size 최대치. db 한정 시 한 페이지에 최대한 담아 필터 후 수집한다.
const DB_SCOPED_PAGE_SIZE = 100;
// db 한정 검색의 스캔 상한(페이지 수). 최대 DB_SCOPED_PAGE_SIZE*DB_SCOPED_MAX_PAGES 건까지 훑는다.
const DB_SCOPED_MAX_PAGES = 5;

interface SearchResult {
  id: string;
  db: DatabaseName | "page";
  title: string;
  url: string;
  lastEdited: string;
}

function mapPage(page: any): SearchResult {
  const title =
    page.properties?.["title"]?.title?.[0]?.plain_text ||
    page.properties?.["Name"]?.title?.[0]?.plain_text ||
    "(제목 없음)";
  return {
    id: page.id,
    db: dbNameFromParent(page.parent),
    title,
    url: page.url,
    lastEdited: page.last_edited_time,
  };
}

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function registerSearch(server: McpServer) {
  server.tool(
    "jhw_search",
    "Notion AI Workspace 키워드 검색 — db 지정 시 해당 DB로 한정(페이지네이션 후 서버측 필터)",
    SearchInput.shape,
    async ({ query, db, limit }) => {
      const notion = getNotionClient();
      const lim = limit ?? 10;

      // db 미지정: 전역 검색(기존 동작). 단일 호출.
      if (!db) {
        const response: any = await callNotion(
          () => notion.search({ query, page_size: Math.min(Math.max(lim, 10), 100) }),
          { operation: "search.notion" }
        );
        const results = (response.results as any[]).map(mapPage).slice(0, lim);
        return jsonContent({ query, db: null, count: results.length, results });
      }

      // db 한정: 전역 검색을 페이지네이션하며 해당 DB 결과만 수집한다.
      // (jhw_search 자체는 DB 필터 인자가 없는 notion.search를 쓰므로, 서버측에서 parent로 필터한다.)
      const collected: any[] = [];
      let cursor: string | undefined = undefined;
      let scanned = 0;
      let more = false; // 스캔하지 못한 뒤쪽에 동일 DB 결과가 더 남았을 수 있음
      let incomplete = false; // Notion이 내부 결과 한도로 검색을 잘랐음(request_status)
      for (let page = 0; page < DB_SCOPED_MAX_PAGES; page++) {
        const response: any = await callNotion(
          () =>
            notion.search({
              query,
              page_size: DB_SCOPED_PAGE_SIZE,
              filter: { property: "object", value: "page" },
              ...(cursor ? { start_cursor: cursor } : {}),
            }),
          { operation: "search.notion.dbScoped" }
        );
        const batch = (response.results as any[]) ?? [];
        scanned += batch.length;
        for (const p of batch) {
          if (dbNameFromParent(p?.parent) === db) collected.push(p);
        }
        // Notion 검색 엔진이 내부 한도(query_result_limit_reached)로 결과를 잘랐으면 미완으로 본다.
        // type 없이 incomplete_reason만 오는 응답 변종도 방어적으로 포착한다.
        if (
          response.request_status?.type === "incomplete" ||
          response.request_status?.incomplete_reason
        ) {
          incomplete = true;
        }

        if (collected.length >= lim) {
          // lim 충족 — 아직 못 훑은 뒤쪽에 동일 DB 결과가 더 있을 수 있음.
          more = Boolean(response.has_more);
          break;
        }
        if (!response.has_more) {
          // 전역 결과를 끝까지 훑음 — 동일 DB 결과를 빠짐없이 모음.
          more = false;
          break;
        }
        if (!response.next_cursor) {
          // has_more지만 커서가 없어 다음 페이지로 진행 불가 — 잔여 있음으로 처리(무한 재스캔 방지).
          more = true;
          break;
        }
        cursor = response.next_cursor;
        // 다음 페이지가 남았는데 다음 반복이 없다면(스캔 상한 도달) 미완 표시.
        more = true;
      }

      const results = collected.map(mapPage).slice(0, lim);
      // truncated: 미스캔 잔여(more) + 이번 스캔에서 lim 초과분을 잘라냄(collected>lim) + Notion 내부 절단(incomplete).
      // → 셋 중 하나라도면 "동일 DB 결과가 더 있을 수 있음" = 호출부가 NEW 확정에 보수적이어야 함을 신호.
      const truncated = collected.length > lim || more || incomplete;
      return jsonContent({ query, db, scanned, count: results.length, truncated, results });
    }
  );
}
