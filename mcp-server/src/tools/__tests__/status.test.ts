import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerStatus } from "../status.js";

describe("jhw_status", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerStatus(server as any);
    handler = capturedTools.get("jhw_status")!.handler;
  });

  it("전체 DB 현황을 조회한다", async () => {
    mockClient.databases.query.mockResolvedValue({
      results: [
        {
          id: "p1",
          properties: {
            title: { title: [{ plain_text: "프로젝트A" }] },
            status: { select: { name: "진행중" } },
          },
          last_edited_time: "2026-04-09",
        },
      ],
      has_more: false,
    });

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveProperty("projects");
    expect(parsed).toHaveProperty("preferences");
    expect(parsed).toHaveProperty("decisionLog");
    expect(mockClient.databases.query).toHaveBeenCalledTimes(3);
  });

  it("특정 DB만 조회할 수 있다", async () => {
    mockClient.databases.query.mockResolvedValue({
      results: [],
      has_more: false,
    });

    const result = await handler({ db: "projects" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveProperty("projects");
    expect(parsed).not.toHaveProperty("preferences");
    expect(mockClient.databases.query).toHaveBeenCalledTimes(1);
  });
});
