import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerDelete } from "../delete.js";

describe("jhw_delete", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerDelete(server as any);
    handler = capturedTools.get("jhw_delete")!.handler;
  });

  it("archive 모드: 상태를 '폐기'로 변경한다", async () => {
    mockClient.pages.update.mockResolvedValue({});

    const result = await handler({ pageId: "page-1", mode: "archive" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.mode).toBe("archive");
    expect(parsed.result).toBe("폐기 완료");
    expect(mockClient.pages.update).toHaveBeenCalledWith({
      page_id: "page-1",
      properties: { status: { select: { name: "폐기" } } },
    });
  });

  it("archive 모드에서 상태 필드가 없으면 아카이브로 폴백한다", async () => {
    mockClient.pages.update
      .mockRejectedValueOnce(new Error("property not found"))
      .mockResolvedValueOnce({});

    const result = await handler({ pageId: "page-1", mode: "archive" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.result).toBe("상태 필드 없어 아카이브 처리");
    expect(mockClient.pages.update).toHaveBeenCalledTimes(2);
  });

  it("delete 모드: 페이지를 아카이브한다", async () => {
    mockClient.pages.update.mockResolvedValue({});

    const result = await handler({ pageId: "page-1", mode: "delete" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.result).toBe("삭제 완료");
    expect(mockClient.pages.update).toHaveBeenCalledWith({
      page_id: "page-1",
      archived: true,
    });
  });
});
