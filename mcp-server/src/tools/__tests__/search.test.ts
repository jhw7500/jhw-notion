import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerSearch } from "../search.js";

describe("jhw_search", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerSearch(server as any);
    handler = capturedTools.get("jhw_search")!.handler;
  });

  it("검색 결과를 포맷팅하여 반환한다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        {
          id: "page-1",
          parent: { type: "database_id", database_id: "4430fcd4bfba4a469a1b4520db86e883" },
          properties: { title: { title: [{ plain_text: "테스트 프로젝트" }] } },
          url: "https://notion.so/page-1",
          last_edited_time: "2026-04-09",
        },
      ],
    });

    const result = await handler({ query: "테스트" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.query).toBe("테스트");
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
});
