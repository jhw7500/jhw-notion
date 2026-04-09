import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerRecord } from "../record.js";

describe("jhw_record", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerRecord(server as any);
    handler = capturedTools.get("jhw_record")!.handler;
  });

  it("decisionLog에 레코드를 생성한다", async () => {
    mockClient.pages.create.mockResolvedValue({
      id: "new-page",
      url: "https://notion.so/new-page",
    });

    const result = await handler({
      db: "decisionLog",
      title: "Vitest 선택",
      properties: { rationale: "ESM 지원", status: "확정" },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.db).toBe("decisionLog");
    expect(parsed.title).toBe("Vitest 선택");

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties["title"].title[0].text.content).toBe("Vitest 선택");
    expect(createCall.properties["status"].select.name).toBe("확정");
    expect(createCall.properties["rationale"].rich_text[0].text.content).toBe("ESM 지원");
  });

  it("decisionLog 기본 상태는 '확정'이다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "p", url: "u" });

    await handler({ db: "decisionLog", title: "테스트" });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties["status"].select.name).toBe("확정");
  });

  it("projects DB에 레코드를 생성한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "p", url: "u" });

    await handler({
      db: "projects",
      title: "새 프로젝트",
      properties: { stack: "TypeScript, Node.js", repo: "github.com/test" },
    });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties["tech_stack"].multi_select).toEqual([
      { name: "TypeScript" },
      { name: "Node.js" },
    ]);
  });

  it("알 수 없는 DB이면 에러 메시지를 반환한다", async () => {
    const result = await handler({ db: "unknown", title: "테스트" });
    expect(result.content[0].text).toContain("알 수 없는 DB");
  });
});
