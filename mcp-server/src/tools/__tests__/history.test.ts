import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerHistory } from "../history.js";

describe("jhw_history", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerHistory(server as any);
    handler = capturedTools.get("jhw_history")!.handler;
  });

  it("프로젝트를 찾을 수 없으면 메시지를 반환한다", async () => {
    mockClient.databases.query.mockResolvedValue({ results: [] });

    const result = await handler({ project: "없는프로젝트" });
    expect(result.content[0].text).toContain("찾을 수 없습니다");
  });

  it("타임라인을 날짜순으로 정렬하여 반환한다", async () => {
    mockClient.databases.query
      .mockResolvedValueOnce({
        results: [
          {
            id: "proj-1",
            properties: {
              title: { title: [{ plain_text: "my-project" }] },
              start_date: { date: { start: "2026-04-01" } },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            properties: {
              title: { title: [{ plain_text: "결정B" }] },
              date: { date: { start: "2026-04-05" } },
              status: { select: { name: "확정" } },
            },
          },
          {
            properties: {
              title: { title: [{ plain_text: "결정A" }] },
              date: { date: { start: "2026-04-03" } },
              status: { select: { name: "확정" } },
            },
          },
        ],
      });

    const result = await handler({ project: "my-project" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.totalEvents).toBe(3);
    expect(parsed.timeline[0].type).toBe("project");
    expect(parsed.timeline[0].date).toBe("2026-04-01");
    expect(parsed.timeline[1].title).toBe("결정A");
    expect(parsed.timeline[2].title).toBe("결정B");
  });
});
