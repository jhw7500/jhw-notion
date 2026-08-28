import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerFetch } from "../fetch.js";

const PAGE_ID = "33a8a230-a04e-8154-8fa5-d96ebdd63500";
const PAGE_URL = "https://www.notion.so/Fetch-page-33a8a230a04e81548fa5d96ebdd63500";

function page(title = "Fetch page") {
  return {
    object: "page",
    id: PAGE_ID,
    url: PAGE_URL,
    properties: {
      title: {
        id: "title",
        type: "title",
        title: [{ type: "text", plain_text: title, text: { content: title } }],
      },
    },
  };
}

function rich(text: string) {
  return [
    {
      type: "text",
      plain_text: text,
      href: null,
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
      text: { content: text, link: null },
    },
  ];
}

function block(id: string, type: string, value: Record<string, unknown>, hasChildren = false) {
  return {
    object: "block",
    id,
    parent: { type: "page_id", page_id: PAGE_ID },
    created_time: "2026-08-28T00:00:00.000Z",
    last_edited_time: "2026-08-28T00:00:00.000Z",
    created_by: { object: "user", id: "user-1" },
    last_edited_by: { object: "user", id: "user-1" },
    has_children: hasChildren,
    archived: false,
    in_trash: false,
    type,
    [type]: value,
  };
}

function paragraph(id: string, text: string, hasChildren = false) {
  return block(id, "paragraph", { rich_text: rich(text), color: "default" }, hasChildren);
}

function listResponse(results: any[], hasMore = false, nextCursor: string | null = null) {
  return {
    object: "list",
    type: "block",
    block: {},
    results,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

describe("jhw_fetch", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerFetch(server as any);
    handler = capturedTools.get("jhw_fetch")!.handler;
  });

  it("빈 페이지도 정규화된 식별자와 명시적인 비절단 상태를 반환한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list.mockResolvedValue({
      object: "list",
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const result = await handler({ pageId: PAGE_URL });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({
      pageId: PAGE_ID,
      url: PAGE_URL,
      title: "Fetch page",
      markdown: "",
      truncated: false,
      truncation: null,
      truncations: [],
      metadata: {
        blocksRead: 0,
        characters: 0,
        maxCharacters: 100_000,
      },
    });
  });

  it("top-level block pagination을 끝까지 읽어 순서를 보존한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list
      .mockResolvedValueOnce(listResponse([paragraph("p-1", "첫 페이지")], true, "cursor-2"))
      .mockResolvedValueOnce(
        listResponse([
          block("h-2", "heading_2", { rich_text: rich("둘째 페이지"), color: "default", is_toggleable: false }),
        ])
      );

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.markdown).toBe("첫 페이지\n## 둘째 페이지");
    expect(parsed.metadata.blocksRead).toBe(2);
    expect(mockClient.blocks.children.list.mock.calls).toEqual([
      [{ block_id: PAGE_ID, page_size: 100 }],
      [{ block_id: PAGE_ID, page_size: 100, start_cursor: "cursor-2" }],
    ]);
  });

  it("중첩 child block을 끝까지 재귀 조회하고 깊이를 들여쓰기로 보존한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list
      .mockResolvedValueOnce(
        listResponse([
          block("parent", "bulleted_list_item", { rich_text: rich("Parent"), color: "default" }, true),
        ])
      )
      .mockResolvedValueOnce(
        listResponse([
          block("child", "bulleted_list_item", { rich_text: rich("Child"), color: "default" }, true),
        ])
      )
      .mockResolvedValueOnce(listResponse([paragraph("leaf", "Leaf")]));

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.markdown).toBe("- Parent\n  - Child\n    Leaf");
    expect(parsed.metadata.blocksRead).toBe(3);
    expect(mockClient.blocks.children.list.mock.calls.map((call) => call[0].block_id)).toEqual([
      PAGE_ID,
      "parent",
      "child",
    ]);
  });

  it("대조에 필요한 heading, todo, quote, code, divider 구조를 Markdown으로 보존한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list.mockResolvedValue(
      listResponse([
        block("h-1", "heading_1", { rich_text: rich("Heading"), color: "default", is_toggleable: false }),
        block("todo", "to_do", { rich_text: rich("Done"), checked: true, color: "default" }),
        block("quote", "quote", { rich_text: rich("Quoted"), color: "default" }),
        block("code", "code", { rich_text: rich("const value = 1;"), caption: [], language: "typescript" }),
        block("divider", "divider", {}),
      ])
    );

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.markdown).toBe(
      "# Heading\n- [x] Done\n> Quoted\n```typescript\nconst value = 1;\n```\n---"
    );
  });

  it("header가 있는 Notion table을 Markdown table로 렌더링한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list
      .mockResolvedValueOnce(
        listResponse([
          block(
            "table",
            "table",
            { table_width: 2, has_column_header: true, has_row_header: false },
            true
          ),
        ])
      )
      .mockResolvedValueOnce(
        listResponse([
          block("row-1", "table_row", { cells: [rich("Name"), rich("Value")] }),
          block("row-2", "table_row", { cells: [rich("A"), rich("B")] }),
        ])
      );

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.markdown).toBe("| Name | Value |\n| --- | --- |\n| A | B |");
  });

  it("header가 없는 Notion table은 빈 header를 넣어 유효한 Markdown table로 만든다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list
      .mockResolvedValueOnce(
        listResponse([
          block(
            "table",
            "table",
            { table_width: 2, has_column_header: false, has_row_header: false },
            true
          ),
        ])
      )
      .mockResolvedValueOnce(
        listResponse([block("row-1", "table_row", { cells: [rich("A"), rich("B")] })])
      );

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.markdown).toBe("|  |  |\n| --- | --- |\n| A | B |");
  });

  it("heading_4를 Markdown 4단계 제목으로 보존한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list.mockResolvedValue(
      listResponse([
        block("h-4", "heading_4", { rich_text: rich("Deep heading"), color: "default", is_toggleable: false }),
      ])
    );

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.markdown).toBe("#### Deep heading");
  });

  it("code 본문 안의 backtick run보다 긴 fence를 선택한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list.mockResolvedValue(
      listResponse([
        block("code", "code", {
          rich_text: rich("before ``` inside"),
          caption: [],
          language: "plain text",
        }),
      ])
    );

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.markdown).toBe("````\nbefore ``` inside\n````");
  });

  it("partial block은 완전한 본문으로 오인하지 않고 위치와 사유를 반환한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list.mockResolvedValue(
      listResponse([{ object: "block", id: "partial-block" }])
    );

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);
    const expected = { reason: "partial_block", blockId: "partial-block", depth: 0 };

    expect(parsed.markdown).toBe("[Partial Notion block: partial-block]");
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncation).toEqual(expected);
    expect(parsed.truncations).toEqual([expected]);
  });

  it("unsupported block은 원래 block type을 포함한 불완전 사유를 반환한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list.mockResolvedValue(
      listResponse([
        block("unsupported-block", "unsupported", { block_type: "future_widget" }),
      ])
    );

    const result = await handler({ pageId: PAGE_ID });
    const parsed = JSON.parse(result.content[0].text);
    const expected = {
      reason: "unsupported_block",
      blockId: "unsupported-block",
      depth: 0,
      blockType: "future_widget",
    };

    expect(parsed.markdown).toBe("[Unsupported Notion block: future_widget]");
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncation).toEqual(expected);
    expect(parsed.truncations).toEqual([expected]);
  });

  it("maxCharacters를 넘는 페이지는 조용히 자르지 않고 위치와 사유를 반환한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list.mockResolvedValue(
      listResponse([paragraph("long", "abcdefghij")])
    );

    const result = await handler({ pageId: PAGE_ID, maxCharacters: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.markdown).toBe("abcde");
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncation).toEqual({ reason: "max_characters", atCharacter: 5 });
    expect(parsed.truncations).toEqual([{ reason: "max_characters", atCharacter: 5 }]);
    expect(parsed.metadata).toEqual({ blocksRead: 1, characters: 5, maxCharacters: 5 });
  });

  it("구조 조회와 문자 출력이 모두 잘리면 두 사유를 잃지 않는다", async () => {
    mockClient.pages.retrieve.mockResolvedValue(page());
    mockClient.blocks.children.list.mockResolvedValue(
      listResponse([paragraph("long", "abcdefghij")], true, null)
    );

    const result = await handler({ pageId: PAGE_ID, maxCharacters: 5 });
    const parsed = JSON.parse(result.content[0].text);
    const traversal = {
      reason: "pagination_cursor_missing",
      blockId: PAGE_ID,
      depth: 0,
    };
    const characters = { reason: "max_characters", atCharacter: 5 };

    expect(parsed.markdown).toBe("abcde");
    expect(parsed.truncation).toEqual(traversal);
    expect(parsed.truncations).toEqual([traversal, characters]);
  });

  it("잘못된 page ID는 Notion API를 호출하기 전에 거절한다", async () => {
    await expect(handler({ pageId: "not-a-page-id" })).rejects.toThrow(
      "유효한 Notion 페이지 URL 또는 UUID가 필요합니다."
    );
    expect(mockClient.pages.retrieve).not.toHaveBeenCalled();
  });

  it("Notion API 오류를 callNotion의 NotionError 계약으로 전파한다", async () => {
    mockClient.pages.retrieve.mockRejectedValue({
      status: 400,
      message: "object_not_found",
      requestId: "req-fetch-1",
    });

    await expect(handler({ pageId: PAGE_ID })).rejects.toMatchObject({
      name: "NotionError",
      operation: "fetch.page.retrieve",
      retryable: false,
      status: 400,
      requestId: "req-fetch-1",
    });
  });
});
