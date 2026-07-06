import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerRetrieve } from "../retrieve.js";

const KB_ID = "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
const DEC_ID = "6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd";

function kbPage(id: string, title: string, projectRelId?: string) {
  return {
    id,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: KB_ID },
    properties: {
      title: { title: [{ plain_text: title }] },
      summary: { rich_text: [{ plain_text: `${title} 요약` }] },
      category: { select: { name: "문제해결" } },
      tags: { multi_select: [{ name: "i2c" }] },
      date: { date: { start: "2026-05-01" } },
      ...(projectRelId ? { project: { relation: [{ id: projectRelId }] } } : {}),
    },
  };
}

describe("jhw_retrieve", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerRetrieve(server as any);
    handler = capturedTools.get("jhw_retrieve")!.handler;
  });

  it("검색 결과가 없으면 used=empty, count=0을 반환한다", async () => {
    mockClient.search.mockResolvedValue({ results: [] });

    const result = await handler({ topic: "없는주제" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.used).toBe("empty");
    expect(parsed.count).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it("대상 DB(결정/지식/문서)에 속한 페이지만 유지한다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        kbPage("kb-1", "i2c 재시도"),
        { id: "x", url: "u", parent: { type: "page_id", page_id: "p" }, properties: {} },
      ],
    });
    mockClient.blocks.children.list.mockResolvedValue({ results: [] });

    const result = await handler({ topic: "i2c" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(1);
    expect(parsed.results[0].db).toBe("knowledgeBase");
    expect(parsed.results[0].title).toBe("i2c 재시도");
  });

  it("project 제공 시 해당 프로젝트 기록을 상위로 부스트한다", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        kbPage("kb-a", "무관 지식"),
        kbPage("kb-b", "프로젝트 지식", "proj-1"),
      ],
    });
    // resolveProjectId → queryDataSource(projects)
    mockClient.dataSources.query.mockResolvedValue({
      results: [{ id: "proj-1", properties: { title: { title: [{ plain_text: "my-project" }] } } }],
    });
    mockClient.blocks.children.list.mockResolvedValue({ results: [] });

    const result = await handler({ topic: "지식", project: "my-project" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0].title).toBe("프로젝트 지식");
    expect(parsed.results[0].project).toBe(true);
    expect(parsed.results[1].project).toBe(false);
  });

  it("본문 스니펫과 속성을 추출한다 (decisionLog rationale→summary)", async () => {
    mockClient.search.mockResolvedValue({
      results: [
        {
          id: "dec-1",
          url: "https://notion.so/dec-1",
          parent: { type: "database_id", database_id: DEC_ID },
          properties: {
            title: { title: [{ plain_text: "타임아웃 대응" }] },
            rationale: { rich_text: [{ plain_text: "링크 안정성" }] },
            status: { select: { name: "확정" } },
            date: { date: { start: "2026-05-02" } },
          },
        },
      ],
    });
    mockClient.blocks.children.list.mockResolvedValue({
      results: [
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "본문내용" }] } },
        { type: "heading_2", heading_2: { rich_text: [{ plain_text: "섹션" }] } },
      ],
    });

    const result = await handler({ topic: "타임아웃" });
    const parsed = JSON.parse(result.content[0].text);
    const r = parsed.results[0];

    expect(r.db).toBe("decisionLog");
    expect(r.summary).toBe("링크 안정성");
    expect(r.status).toBe("확정");
    expect(r.date).toBe("2026-05-02");
    expect(r.snippet).toContain("본문내용");
    expect(r.snippet).toContain("## 섹션");
  });
});
