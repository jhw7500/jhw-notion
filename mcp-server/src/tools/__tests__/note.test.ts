import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerNote } from "../note.js";
import { defaultPageCache } from "../../cache/page-cache.js";

describe("jhw_note", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerNote(server as any);
    handler = capturedTools.get("jhw_note")!.handler;
  });

  it("Knowledge Base DB에 메모를 생성한다 (parent.database_id 사용)", async () => {
    mockClient.pages.create.mockResolvedValue({
      id: "note-1",
      url: "https://notion.so/note-1",
    });

    const result = await handler({
      title: "ESM 팁",
      content: "import에 .js 확장자 필수",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.title).toBe("ESM 팁");
    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.parent.database_id).toBeDefined();
    expect(createCall.properties.title.title[0].text.content).toBe("ESM 팁");
    expect(createCall.children.length).toBe(1); // content paragraph 1개
  });

  it("프로젝트 키워드를 projects DB에서 검색해 relation으로 연결한다", async () => {
    mockClient.dataSources.query.mockResolvedValue({
      results: [{ id: "proj-page-id" }],
    });
    mockClient.pages.create.mockResolvedValue({ id: "n", url: "u" });

    await handler({ title: "팁", content: "내용", project: "my-project" });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties.project).toEqual({
      relation: [{ id: "proj-page-id" }],
    });
  });

  it("category/tags/summary/report를 properties로 설정한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "n", url: "u" });

    await handler({
      title: "메모",
      content: "내용",
      summary: "한줄 요약",
      category: "문제해결",
      tags: "iMX93, BSP",
      report: "wlan-bsp",
    });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties.summary.rich_text[0].text.content).toBe(
      "한줄 요약"
    );
    expect(createCall.properties.category.select.name).toBe("문제해결");
    expect(createCall.properties.tags.multi_select).toEqual([
      { name: "iMX93" },
      { name: "BSP" },
    ]);
    expect(createCall.properties.report.select.name).toBe("wlan-bsp");
  });

  it("미등록 tags는 drop하고 허용 태그만 저장한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "n", url: "u" });

    await handler({
      title: "메모",
      content: "내용",
      tags: "iMX93, 절대없는태그zzz, BSP",
    });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties.tags.multi_select).toEqual([
      { name: "iMX93" },
      { name: "BSP" },
    ]);
  });

  it("생성한 KB 페이지를 로컬 캐시에 적재한다 (P0-3)", async () => {
    defaultPageCache.clear();
    mockClient.pages.create.mockResolvedValue({
      id: "note-cache-1",
      url: "https://notion.so/note-cache-1",
    });

    await handler({ title: "캐시 메모", content: "raw socket 키 정정 메모" });

    const hit = defaultPageCache.get("note-cache-1");
    expect(hit).toBeDefined();
    expect(hit!.db).toBe("knowledgeBase");
    // 본문 토큰으로 검색 가능 (title-only가 아님)
    expect(
      defaultPageCache.search("socket").some((r) => r.page.id === "note-cache-1")
    ).toBe(true);
  });

  it("drop된 tags가 있으면 응답 warnings에 포함한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "n", url: "u" });

    const result = await handler({
      title: "메모",
      content: "내용",
      tags: "iMX93, 절대없는태그zzz",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.join(" ")).toContain("절대없는태그zzz");
  });
});
