import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockNotionClient,
  createMockServer,
} from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";
import { defaultPageCache } from "../../cache/page-cache.js";
import { NOTION_CONFIG } from "../../config.js";
import { ControlError } from "../../control/errors.js";

let mockClient: MockNotionClient;
const TARGET = "33a8a230-a04e-4154-8fa5-d96ebdd63500";
const PARENT = "44a8a230-a04e-4154-8fa5-d96ebdd63500";

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerAppend } from "../append.js";

const legacyAuthority = { assertNotionWriteAllowed: vi.fn(async () => undefined) };
const registryAuthority = {
  assertNotionWriteAllowed: vi.fn(async () => {
    throw new ControlError("AUTHORITY_MOVED", "moved");
  }),
};

describe("jhw_append", () => {
  let handler: (args: any) => Promise<any>;
  let schema: any;

  beforeEach(() => {
    defaultPageCache.clear();
    mockClient = createMockNotionClient();
    mockClient.pages.retrieve.mockResolvedValue({ parent: { type: "workspace", workspace: true } });
    mockClient.blocks.children.append.mockResolvedValue({});
    const { server, capturedTools } = createMockServer();
    legacyAuthority.assertNotionWriteAllowed.mockClear();
    registryAuthority.assertNotionWriteAllowed.mockClear();
    registerAppend(server as any, legacyAuthority);
    const tool = capturedTools.get("jhw_append")!;
    handler = tool.handler;
    schema = tool.schema;
  });

  it("registry authority에서 Projects descendant append를 거부한다", async () => {
    mockClient.pages.retrieve.mockImplementation(async ({ page_id }: { page_id: string }) => page_id === TARGET
      ? { id: TARGET, parent: { type: "page_id", page_id: PARENT } }
      : { id: PARENT, parent: { type: "database_id", database_id: NOTION_CONFIG.databases.projects } });
    const selectiveAuthority = {
      assertNotionWriteAllowed: vi.fn(async (db: string) => {
        if (db === "projects") throw new ControlError("AUTHORITY_MOVED", "moved");
      }),
    };
    const { server, capturedTools } = createMockServer();
    registerAppend(server as any, selectiveAuthority);

    const result = await capturedTools.get("jhw_append")!.handler({ pageId: TARGET, content: "blocked" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "AUTHORITY_MOVED", db: "projects" });
    expect(mockClient.blocks.children.append).not.toHaveBeenCalled();
  });

  it("registry authority에서 Knowledge Base descendant append는 허용한다", async () => {
    mockClient.pages.retrieve.mockImplementation(async ({ page_id }: { page_id: string }) => page_id === TARGET
      ? { id: TARGET, parent: { type: "page_id", page_id: PARENT } }
      : { id: PARENT, parent: { type: "database_id", database_id: NOTION_CONFIG.databases.knowledgeBase } });
    const selectiveAuthority = {
      assertNotionWriteAllowed: vi.fn(async (db: string) => {
        if (db === "projects" || db === "decisionLog") throw new ControlError("AUTHORITY_MOVED", "moved");
      }),
    };
    const { server, capturedTools } = createMockServer();
    registerAppend(server as any, selectiveAuthority);

    const result = await capturedTools.get("jhw_append")!.handler({ pageId: TARGET, content: "allowed" });

    expect(JSON.parse(result.content[0].text).appendedBlocks).toBe(1);
    expect(mockClient.blocks.children.append).toHaveBeenCalledTimes(1);
  });

  it("ancestor cycle/depth failures return stable MCP errors without append", async () => {
    const ids = Array.from({ length: 64 }, (_, index) => `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const cases = [
      {
        start: TARGET,
        retrieve: vi.fn(async ({ page_id }: { page_id: string }) => ({
          id: page_id,
          parent: { type: "page_id", page_id: page_id === TARGET ? PARENT : TARGET },
        })),
      },
      {
        start: ids[0],
        retrieve: vi.fn(async ({ page_id }: { page_id: string }) => {
          const index = ids.indexOf(page_id);
          return { id: page_id, parent: { type: "page_id", page_id: ids[index + 1] ?? ids.at(-1) } };
        }),
      },
    ];
    for (const { start, retrieve } of cases) {
      mockClient.pages.retrieve = retrieve;
      const { server, capturedTools } = createMockServer();
      registerAppend(server as any, legacyAuthority);
      const result = await capturedTools.get("jhw_append")!.handler({ pageId: start, content: "blocked" });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe("AUTHORITY_UNAVAILABLE");
      expect(mockClient.blocks.children.append).not.toHaveBeenCalled();
    }
  });

  it("registry authority에서는 대상 page 조회 뒤 Projects append를 캐시 변경 전에 거부한다", async () => {
    const pageId = "33a8a230-a04e-8154-8fa5-d96ebdd63500";
    defaultPageCache.set({ id: pageId, db: "projects", title: "kept", text: "kept" });
    mockClient.pages.retrieve.mockResolvedValue({
      parent: { type: "database_id", database_id: NOTION_CONFIG.databases.projects },
    });
    const { server, capturedTools } = createMockServer();
    registerAppend(server as any, registryAuthority);

    const result = await capturedTools.get("jhw_append")!.handler({ pageId, content: "blocked" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("AUTHORITY_MOVED");
    expect(mockClient.pages.retrieve).toHaveBeenCalledWith({ page_id: pageId });
    expect(mockClient.blocks.children.append).not.toHaveBeenCalled();
    expect(defaultPageCache.get(pageId)).toBeDefined();
  });

  it("registry authority에서도 Knowledge Base append는 기존 경로로 처리한다", async () => {
    const pageId = "33a8a230-a04e-8154-8fa5-d96ebdd63500";
    mockClient.pages.retrieve.mockResolvedValue({
      parent: { type: "database_id", database_id: NOTION_CONFIG.databases.knowledgeBase },
    });
    const selectiveAuthority = {
      assertNotionWriteAllowed: vi.fn(async (db: string) => {
        if (db === "projects" || db === "decisionLog") throw new ControlError("AUTHORITY_MOVED", "moved");
      }),
    };
    const { server, capturedTools } = createMockServer();
    registerAppend(server as any, selectiveAuthority);

    const result = await capturedTools.get("jhw_append")!.handler({ pageId, content: "allowed" });

    expect(JSON.parse(result.content[0].text).appendedBlocks).toBe(1);
    expect(mockClient.blocks.children.append).toHaveBeenCalledTimes(1);
  });

  it("unknown page scope에서도 local writes-disabled는 append를 차단한다", async () => {
    const disabled = {
      assertNotionWriteAllowed: vi.fn(async () => {
        throw new ControlError("NOTION_WRITES_DISABLED", "disabled");
      }),
    };
    const { server, capturedTools } = createMockServer();
    registerAppend(server as any, disabled);

    const result = await capturedTools.get("jhw_append")!.handler({
      pageId: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
      content: "blocked",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("NOTION_WRITES_DISABLED");
    expect(mockClient.blocks.children.append).not.toHaveBeenCalled();
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

  it("2000자를 넘는 본문은 Notion 제한보다 작은 paragraph로 나눈다", async () => {
    const result = await handler({
      pageId: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
      content: "가".repeat(4001),
    });

    const children = mockClient.blocks.children.append.mock.calls[0][0].children;
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.paragraph.rich_text[0].text.content.length).toBeLessThanOrEqual(2000);
    }
    expect(JSON.parse(result.content[0].text).appendedBlocks).toBe(3);
  });

  it("heading은 스키마에서 200자로 제한한다", () => {
    expect(schema.heading.safeParse("제목").success).toBe(true);
    expect(schema.heading.safeParse("가".repeat(201)).success).toBe(false);
  });

  it("비멱등 append는 retryable 오류에도 자동 재시도하지 않는다", async () => {
    mockClient.blocks.children.append.mockRejectedValue(
      Object.assign(new Error("service unavailable"), { status: 503 })
    );

    await expect(
      handler({
        pageId: "33a8a230-a04e-8154-8fa5-d96ebdd63500",
        content: "본문",
      })
    ).rejects.toThrow("service unavailable");
    expect(mockClient.blocks.children.append).toHaveBeenCalledTimes(1);
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
