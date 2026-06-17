import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerContext } from "../context.js";

describe("jhw_context", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerContext(server as any);
    handler = capturedTools.get("jhw_context")!.handler;
  });

  it("프로젝트를 찾을 수 없으면 메시지를 반환한다", async () => {
    mockClient.dataSources.query.mockResolvedValue({ results: [] });

    const result = await handler({ project: "없는프로젝트" });
    expect(result.content[0].text).toContain("찾을 수 없습니다");
  });

  it("프로젝트 정보 + 결정 + 본문을 한 번에 로드한다", async () => {
    mockClient.dataSources.query
      .mockResolvedValueOnce({
        results: [
          {
            id: "proj-1",
            properties: {
              title: { title: [{ plain_text: "my-project" }] },
              status: { select: { name: "진행중" } },
              tech_stack: { multi_select: [{ name: "TypeScript" }] },
              repo: { rich_text: [{ plain_text: "github.com/test" }] },
              description: { rich_text: [{ plain_text: "설명" }] },
              start_date: { date: { start: "2026-04-01" } },
            },
            url: "https://notion.so/proj-1",
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            id: "dec-1",
            properties: {
              title: { title: [{ plain_text: "결정1" }] },
              status: { select: { name: "확정" } },
              date: { date: { start: "2026-04-02" } },
              rationale: { rich_text: [{ plain_text: "이유" }] },
            },
          },
        ],
      });

    mockClient.blocks.children.list.mockResolvedValue({
      results: [
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "본문 내용" }] } },
        { type: "heading_2", heading_2: { rich_text: [{ plain_text: "섹션" }] } },
      ],
    });

    const result = await handler({ project: "my-project" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.project.title).toBe("my-project");
    expect(parsed.project.stack).toBe("TypeScript");
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.pageContent).toContain("본문 내용");
    expect(parsed.pageContent).toContain("## 섹션");
  });

  it("정확 일치 프로젝트를 부분일치보다 우선 선택한다 (P1-2)", async () => {
    mockClient.dataSources.query
      .mockResolvedValueOnce({
        results: [
          { id: "p2", properties: { title: { title: [{ plain_text: "jhw-notion-v2" }] } }, url: "u2" },
          { id: "p1", properties: { title: { title: [{ plain_text: "jhw-notion" }] } }, url: "u1" },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            id: "dec-1",
            properties: {
              title: { title: [{ plain_text: "결정1" }] },
              status: { select: { name: "확정" } },
              date: { date: { start: "2026-04-02" } },
              rationale: { rich_text: [{ plain_text: "이유" }] },
            },
          },
        ],
      });
    mockClient.blocks.children.list.mockResolvedValue({ results: [] });

    const result = await handler({ project: "jhw-notion" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.project.id).toBe("p1");
    expect(parsed.project.title).toBe("jhw-notion");
  });
});
