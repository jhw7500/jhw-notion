import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerSearch } from "../search.js";

// config.ts의 실제 DB id (dbNameFromParent가 dash 제거 후 매칭).
const PROJECTS_DB = "4430fcd4-bfba-4a46-9a1b-4520db86e883";
const KB_DB = "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
const REFERENCES_DB = "979a9412-73d9-4fa4-be0e-cbcafc0a2505";

function pageIn(dbId: string, id: string, title: string) {
  return {
    id,
    parent: { type: "database_id", database_id: dbId },
    properties: { title: { title: [{ plain_text: title }] } },
    url: `https://notion.so/${id}`,
    last_edited_time: "2026-07-07",
  };
}

describe("jhw_search", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerSearch(server as any);
    handler = capturedTools.get("jhw_search")!.handler;
  });

  // ── 전역(기존) 동작 ─────────────────────────────────────────────
  it("검색 결과를 포맷팅하여 반환한다", async () => {
    mockClient.search.mockResolvedValue({
      results: [pageIn(PROJECTS_DB, "page-1", "테스트 프로젝트")],
    });

    const result = await handler({ query: "테스트" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.query).toBe("테스트");
    expect(parsed.db).toBe(null);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].title).toBe("테스트 프로젝트");
    expect(parsed.results[0].db).toBe("projects");
  });

  it("DB에 매칭되지 않는 페이지는 db가 'page'이다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        {
          id: "page-2",
          parent: { type: "database_id", database_id: "unknown-db-id" },
          properties: { title: { title: [{ plain_text: "기타 페이지" }] } },
          url: "https://notion.so/page-2",
          last_edited_time: "2026-04-09",
        },
      ],
    });

    const result = await handler({ query: "기타" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results[0].db).toBe("page");
  });

  it("제목이 없으면 '(제목 없음)'을 반환한다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        {
          id: "page-3",
          parent: { type: "page_id" },
          properties: {},
          url: "https://notion.so/page-3",
          last_edited_time: "2026-04-09",
        },
      ],
    });

    const result = await handler({ query: "없음" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results[0].title).toBe("(제목 없음)");
  });

  it("전역 검색은 단일 호출이며 limit만큼 자른다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        pageIn(PROJECTS_DB, "g1", "일"),
        pageIn(KB_DB, "g2", "이"),
        pageIn(REFERENCES_DB, "g3", "삼"),
      ],
    });

    const result = await handler({ query: "전역", limit: 2 });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(parsed.db).toBe(null);
    expect(parsed.count).toBe(2);
  });

  // ── db 한정 동작 ────────────────────────────────────────────────
  it("db 지정 시 해당 DB 결과만 남긴다 (전역 top이 타 DB로 채워져도)", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        pageIn(PROJECTS_DB, "p1", "프로젝트 A"),
        pageIn(REFERENCES_DB, "r1", "참조 A"),
        pageIn(KB_DB, "k1", "지식 A"),
        pageIn(PROJECTS_DB, "p2", "프로젝트 B"),
        pageIn(KB_DB, "k2", "지식 B"),
      ],
      has_more: false,
    });

    const result = await handler({ query: "A", db: "knowledgeBase" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.db).toBe("knowledgeBase");
    expect(parsed.count).toBe(2);
    expect(parsed.results.map((r: any) => r.id)).toEqual(["k1", "k2"]);
    expect(parsed.results.every((r: any) => r.db === "knowledgeBase")).toBe(true);
    // object:page 필터가 걸린 채 호출되는지
    expect(mockClient.search).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { property: "object", value: "page" } })
    );
  });

  it("db 한정 검색은 동일 DB 매칭이 부족하면 다음 페이지까지 훑는다", async () => {
    mockClient.search
      .mockResolvedValueOnce({
        // 1페이지: 전역 top이 전부 타 DB — 동일 DB 매칭 0
        results: [pageIn(PROJECTS_DB, "p1", "타DB 1"), pageIn(REFERENCES_DB, "r1", "타DB 2")],
        has_more: true,
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        // 2페이지: 여기서 동일 DB 매칭 발견
        results: [pageIn(KB_DB, "k1", "지식 A")],
        has_more: false,
      });

    const result = await handler({ query: "A", db: "knowledgeBase" });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.search).toHaveBeenCalledTimes(2);
    // 2번째 호출은 start_cursor로 이어짐
    expect(mockClient.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ start_cursor: "cursor-2" })
    );
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].id).toBe("k1");
    expect(parsed.scannedItems).toBe(3);
    expect(parsed.truncated).toBe(false);
  });

  it("db 한정 검색은 limit 충족 시 조기 종료하고 truncated로 잔여를 표시한다", async () => {
    mockClient.search.mockResolvedValue({
      results: [pageIn(KB_DB, "k1", "지식 A"), pageIn(KB_DB, "k2", "지식 B")],
      has_more: true,
      next_cursor: "cursor-2",
    });

    const result = await handler({ query: "지식", db: "knowledgeBase", limit: 1 });
    const parsed = JSON.parse(result.content[0].text);

    // lim=1 충족 → 첫 페이지에서 조기 종료 (2페이지 호출 안 함)
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].id).toBe("k1");
    expect(parsed.truncated).toBe(true);
    // 양성 절단(잔여 있음)이지 엔진 절단이 아님 — 분리 신호는 false
    expect(parsed.searchIncomplete).toBe(false);
  });

  it("db 한정 검색은 스캔 상한(5페이지)에서 멈추고 truncated=true", async () => {
    // 매 페이지 동일 DB 매칭 0 + has_more 무한 → 상한에서 종료
    mockClient.search.mockResolvedValue({
      results: [pageIn(PROJECTS_DB, "p1", "타DB")],
      has_more: true,
      next_cursor: "cursor-n",
    });

    const result = await handler({ query: "없음", db: "knowledgeBase" });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.search).toHaveBeenCalledTimes(5);
    expect(parsed.count).toBe(0);
    expect(parsed.scannedItems).toBe(5);
    expect(parsed.truncated).toBe(true);
  });

  it("db 한정: 한 페이지에 lim 초과 동일 DB 매칭 + has_more:false여도 잘린 잔여를 truncated로 알린다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        pageIn(KB_DB, "k1", "지식 A"),
        pageIn(KB_DB, "k2", "지식 B"),
        pageIn(KB_DB, "k3", "지식 C"),
      ],
      has_more: false,
    });

    const result = await handler({ query: "지식", db: "knowledgeBase", limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(2);
    // 3개 중 2개만 반환·1개 잘림 → has_more가 false여도 truncated:true (잘린 동일 DB 매칭 신호)
    expect(parsed.truncated).toBe(true);
  });

  it("db 한정: Notion이 request_status.incomplete로 잘랐으면 truncated=true", async () => {
    mockClient.search.mockResolvedValue({
      results: [pageIn(KB_DB, "k1", "지식 A")],
      has_more: false,
      request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    });

    const result = await handler({ query: "지식", db: "knowledgeBase" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(1);
    expect(parsed.truncated).toBe(true);
    // 엔진 절단 — 결과가 있어도 "매칭 없음"의 근거로 못 쓴다는 분리 신호
    expect(parsed.searchIncomplete).toBe(true);
  });

  it("db 한정: request_status가 type 없이 incomplete_reason만 와도 truncated=true", async () => {
    mockClient.search.mockResolvedValue({
      results: [pageIn(KB_DB, "k1", "지식 A")],
      has_more: false,
      request_status: { incomplete_reason: "query_result_limit_reached" },
    });

    const result = await handler({ query: "지식", db: "knowledgeBase" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.truncated).toBe(true);
  });

  it("db 한정: has_more지만 next_cursor가 없으면 재스캔 없이 멈추고 truncated=true", async () => {
    mockClient.search.mockResolvedValue({
      results: [pageIn(KB_DB, "k1", "지식 A")],
      has_more: true, // next_cursor 없음
    });

    const result = await handler({ query: "지식", db: "knowledgeBase", limit: 5 });
    const parsed = JSON.parse(result.content[0].text);

    // 무한/페이지1 재스캔 방지 — 단 1회 호출로 종료
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(parsed.count).toBe(1);
    expect(parsed.truncated).toBe(true);
  });

  it("전역 검색 page_size는 lim이 작아도 최소 10으로 바닥을 둔다", async () => {
    mockClient.search.mockResolvedValue({ results: [] });

    await handler({ query: "바닥", limit: 3 });

    expect(mockClient.search).toHaveBeenCalledWith(
      expect.objectContaining({ page_size: 10 })
    );
  });

  it("전역 검색도 truncated·scannedItems를 반환한다 (db 한정과 형태 일치)", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        pageIn(PROJECTS_DB, "g1", "일"),
        pageIn(KB_DB, "g2", "이"),
        pageIn(REFERENCES_DB, "g3", "삼"),
      ],
      has_more: false,
    });

    const result = await handler({ query: "전역", limit: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.db).toBe(null);
    expect(parsed.scannedItems).toBe(3);
    expect(parsed.count).toBe(2);
    // 3건 받았는데 2건만 반환 → truncated:true (양성 절단 — searchIncomplete는 false)
    expect(parsed.truncated).toBe(true);
    expect(parsed.searchIncomplete).toBe(false);
  });

  it("전역 검색도 request_status.incomplete면 truncated=true (db 한정과 대칭)", async () => {
    mockClient.search.mockResolvedValue({
      results: [pageIn(PROJECTS_DB, "g1", "일")],
      has_more: false,
      request_status: { incomplete_reason: "query_result_limit_reached" },
    });

    const result = await handler({ query: "전역", limit: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.db).toBe(null);
    expect(parsed.truncated).toBe(true);
    expect(parsed.searchIncomplete).toBe(true);
  });
});
