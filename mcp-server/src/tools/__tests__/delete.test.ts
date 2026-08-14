import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";
import { NOTION_CONFIG } from "../../config.js";
import { ControlError } from "../../control/errors.js";

let mockClient: MockNotionClient;
const TARGET = "55a8a230-a04e-4154-8fa5-d96ebdd63500";
const PARENT = "66a8a230-a04e-4154-8fa5-d96ebdd63500";

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerDelete } from "../delete.js";
import { defaultPageCache } from "../../cache/page-cache.js";

const legacyAuthority = { assertNotionWriteAllowed: vi.fn(async () => undefined) };
const registryAuthority = {
  assertNotionWriteAllowed: vi.fn(async () => {
    throw new ControlError("AUTHORITY_MOVED", "moved");
  }),
};

describe("jhw_delete", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    mockClient.pages.retrieve.mockImplementation(async ({ page_id }: { page_id: string }) => ({
      id: page_id, object: "page", parent: { type: "workspace", workspace: true },
    }));
    const { server, capturedTools } = createMockServer();
    legacyAuthority.assertNotionWriteAllowed.mockClear();
    registryAuthority.assertNotionWriteAllowed.mockClear();
    registerDelete(server as any, legacyAuthority);
    handler = capturedTools.get("jhw_delete")!.handler;
  });

  it("registry authority에서 Decision Log descendant delete를 거부한다", async () => {
    mockClient.pages.retrieve.mockImplementation(async ({ page_id }: { page_id: string }) => page_id === TARGET
      ? { id: TARGET, object: "page", parent: { type: "page_id", page_id: PARENT } }
      : { id: PARENT, object: "page", parent: { type: "database_id", database_id: NOTION_CONFIG.databases.decisionLog } });
    const selectiveAuthority = {
      assertNotionWriteAllowed: vi.fn(async (db: string) => {
        if (db === "decisionLog") throw new ControlError("AUTHORITY_MOVED", "moved");
      }),
    };
    const { server, capturedTools } = createMockServer();
    registerDelete(server as any, selectiveAuthority);

    const result = await capturedTools.get("jhw_delete")!.handler({ pageId: TARGET, mode: "delete" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "AUTHORITY_MOVED", db: "decisionLog" });
    expect(mockClient.pages.update).not.toHaveBeenCalled();
  });

  it("ancestor retrieve failure returns stable MCP error without cache/update mutation", async () => {
    defaultPageCache.clear();
    defaultPageCache.set({ id: TARGET, db: "decisionLog", title: "kept", text: "kept" });
    mockClient.pages.retrieve.mockRejectedValue(new Error("sensitive upstream failure"));
    const { server, capturedTools } = createMockServer();
    registerDelete(server as any, legacyAuthority);

    const result = await capturedTools.get("jhw_delete")!.handler({ pageId: TARGET, mode: "delete" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "AUTHORITY_UNAVAILABLE", db: "page" });
    expect(result.content[0].text).not.toContain("sensitive upstream");
    expect(defaultPageCache.get(TARGET)).toBeDefined();
    expect(mockClient.pages.update).not.toHaveBeenCalled();
  });

  it("registry authority에서는 대상 page 조회 뒤 Decision Log 삭제를 캐시 변경 전에 거부한다", async () => {
    defaultPageCache.clear();
    defaultPageCache.set({ id: "page-1", db: "decisionLog", title: "kept", text: "kept" });
    mockClient.pages.retrieve.mockResolvedValue({
      id: "page-1",
      object: "page",
      parent: {
        type: "data_source_id",
        data_source_id: "c1d8d3c3-538e-40a9-a306-2b694a4d8ff9",
        database_id: NOTION_CONFIG.databases.decisionLog,
      },
    });
    const { server, capturedTools } = createMockServer();
    registerDelete(server as any, registryAuthority);

    const result = await capturedTools.get("jhw_delete")!.handler({ pageId: "page-1", mode: "delete" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).route).toContain("Git ADR");
    expect(mockClient.pages.retrieve).toHaveBeenCalledWith({ page_id: "page-1" });
    expect(mockClient.pages.update).not.toHaveBeenCalled();
    expect(defaultPageCache.get("page-1")).toBeDefined();
  });

  it("registry authority에서도 Knowledge Base 삭제는 기존 경로로 처리한다", async () => {
    mockClient.pages.retrieve.mockResolvedValue({
      id: "kb-page",
      object: "page",
      parent: { type: "database_id", database_id: NOTION_CONFIG.databases.knowledgeBase },
    });
    mockClient.pages.update.mockResolvedValue({});
    const selectiveAuthority = {
      assertNotionWriteAllowed: vi.fn(async (db: string) => {
        if (db === "projects" || db === "decisionLog") throw new ControlError("AUTHORITY_MOVED", "moved");
      }),
    };
    const { server, capturedTools } = createMockServer();
    registerDelete(server as any, selectiveAuthority);

    const result = await capturedTools.get("jhw_delete")!.handler({ pageId: "kb-page", mode: "delete" });

    expect(JSON.parse(result.content[0].text).mode).toBe("delete");
    expect(mockClient.pages.update).toHaveBeenCalledTimes(1);
  });

  it("unknown page scope에서도 local writes-disabled는 삭제를 차단한다", async () => {
    const disabled = {
      assertNotionWriteAllowed: vi.fn(async () => {
        throw new ControlError("NOTION_WRITES_DISABLED", "disabled");
      }),
    };
    const { server, capturedTools } = createMockServer();
    registerDelete(server as any, disabled);

    const result = await capturedTools.get("jhw_delete")!.handler({ pageId: "unknown-page", mode: "delete" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("NOTION_WRITES_DISABLED");
    expect(mockClient.pages.update).not.toHaveBeenCalled();
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

    expect(parsed.result).toBe("Notion 휴지통 이동 완료 (복구 가능)");
    expect(mockClient.pages.update).toHaveBeenCalledWith({
      page_id: "page-1",
      archived: true,
    });
  });

  it("삭제 시 로컬 캐시에서 해당 페이지를 제거한다 (리뷰 피드백 — Codex)", async () => {
    defaultPageCache.clear();
    defaultPageCache.set({
      id: "page-1",
      db: "knowledgeBase",
      title: "삭제될 메모",
      text: "socket 내용",
    });
    expect(defaultPageCache.get("page-1")).toBeDefined();
    mockClient.pages.update.mockResolvedValue({});

    await handler({ pageId: "page-1", mode: "delete" });

    expect(defaultPageCache.get("page-1")).toBeUndefined();
  });
});
