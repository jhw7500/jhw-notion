import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockNotionClient,
  createMockServer,
} from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";
import { defaultPageCache } from "../../cache/page-cache.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerAppend } from "../append.js";

describe("jhw_append", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    defaultPageCache.clear();
    mockClient = createMockNotionClient();
    mockClient.blocks.children.append.mockResolvedValue({});
    const { server, capturedTools } = createMockServer();
    registerAppend(server as any);
    handler = capturedTools.get("jhw_append")!.handler;
  });

  it("URL을 페이지 ID로 정규화하고 heading + paragraph를 append한다", async () => {
    defaultPageCache.set({
      id: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
      db: "projects",
      title: "redmine",
      text: "기존 캐시",
    });
    const result = await handler({
      pageId: "https://app.notion.com/p/redmine-33a8a230a04e81548fa5d96ebdd63500",
      heading: "2026-07-16 보강",
      content: "첫 문단\n\n둘째 문단",
    });

    expect(mockClient.blocks.children.append).toHaveBeenCalledWith({
      block_id: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
      children: expect.arrayContaining([
        expect.objectContaining({ type: "heading_3" }),
        expect.objectContaining({ type: "paragraph" }),
      ]),
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.appendedBlocks).toBe(3);
    expect(parsed.batches).toBe(1);
    expect(
      defaultPageCache.get("33a8a230-a04e-8154-8fa5-d96ebdd63500")
    ).toBeUndefined();
  });

  it("100개를 넘는 블록은 API 제한에 맞춰 나눠 append한다", async () => {
    const content = Array.from({ length: 101 }, (_, i) => `문단 ${i + 1}`).join("\n\n");

    const result = await handler({
      pageId: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
      content,
    });

    expect(mockClient.blocks.children.append).toHaveBeenCalledTimes(2);
    expect(mockClient.blocks.children.append.mock.calls[0][0].children).toHaveLength(100);
    expect(mockClient.blocks.children.append.mock.calls[1][0].children).toHaveLength(1);
    expect(JSON.parse(result.content[0].text).batches).toBe(2);
  });

  it("부분 실패 시 캐시를 비우고 자동 재시도를 막는 오류를 반환한다", async () => {
    defaultPageCache.set({
      id: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
      db: "projects",
      title: "redmine",
      text: "기존 캐시",
    });
    mockClient.blocks.children.append
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("rate limited"));
    const content = Array.from({ length: 101 }, (_, i) => `문단 ${i + 1}`).join("\n\n");

    await expect(
      handler({
        pageId: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
        content,
      })
    ).rejects.toThrow("100개 블록 후 부분 실패");
    expect(
      defaultPageCache.get("33a8a230-a04e-8154-8fa5-d96ebdd63500")
    ).toBeUndefined();
  });

  it("빈 본문은 Notion API를 호출하지 않고 거부한다", async () => {
    await expect(
      handler({
        pageId: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
        content: "   ",
      })
    ).rejects.toThrow("append할 content가 비어 있습니다");
    expect(mockClient.blocks.children.append).not.toHaveBeenCalled();
  });
});
