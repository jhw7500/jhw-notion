import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerClose } from "../close.js";

describe("jhw_close", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerClose(server as any);
    handler = capturedTools.get("jhw_close")!.handler;
  });

  it("프로젝트를 찾을 수 없으면 메시지를 반환한다", async () => {
    mockClient.dataSources.query.mockResolvedValue({ results: [] });

    const result = await handler({ project: "없는프로젝트" });
    expect(result.content[0].text).toContain("찾을 수 없습니다");
  });

  it("프로젝트 상태를 완료로 변경한다", async () => {
    mockClient.dataSources.query.mockResolvedValue({
      results: [{ id: "proj-1", properties: { title: { title: [{ plain_text: "my-project" }] } } }],
    });
    mockClient.pages.update.mockResolvedValue({});

    const result = await handler({ project: "my-project" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.project.status).toBe("완료");
    expect(mockClient.pages.update).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: "proj-1",
        properties: expect.objectContaining({
          status: { select: { name: "완료" } },
        }),
      })
    );
  });

  it("회고가 있으면 블록을 추가하고 Knowledge Base에 등록한다", async () => {
    mockClient.dataSources.query.mockResolvedValue({
      results: [{ id: "proj-1", properties: { title: { title: [{ plain_text: "my-project" }] } } }],
    });
    mockClient.pages.update.mockResolvedValue({});
    mockClient.blocks.children.append.mockResolvedValue({});
    mockClient.pages.create.mockResolvedValue({
      id: "kb-1",
      url: "https://notion.so/kb-1",
    });

    const result = await handler({
      project: "my-project",
      achievement: "MCP 서버 완성",
      lessons: "ESM 모킹이 까다롭다",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.retrospective).toBe(true);
    expect(parsed.knowledgeBase.id).toBe("kb-1");
    expect(mockClient.blocks.children.append).toHaveBeenCalledTimes(1);
    expect(mockClient.pages.create).toHaveBeenCalledTimes(1);
  });

  it("lessons가 없으면 Knowledge Base에 등록하지 않는다", async () => {
    mockClient.dataSources.query.mockResolvedValue({
      results: [{ id: "proj-1", properties: { title: { title: [{ plain_text: "my-project" }] } } }],
    });
    mockClient.pages.update.mockResolvedValue({});
    mockClient.blocks.children.append.mockResolvedValue({});

    const result = await handler({
      project: "my-project",
      achievement: "완성",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.knowledgeBase).toBeNull();
    expect(mockClient.pages.create).not.toHaveBeenCalled();
  });

  it("정확 일치가 없고 부분일치 후보가 여럿이면 종료하지 않고 후보를 안내한다 (P0-2)", async () => {
    mockClient.dataSources.query.mockResolvedValue({
      results: [
        { id: "p1", properties: { title: { title: [{ plain_text: "jhw-notion" }] } } },
        { id: "p2", properties: { title: { title: [{ plain_text: "jhw-notion-v2" }] } } },
      ],
    });

    const result = await handler({ project: "jhw" });

    expect(result.content[0].text).toContain("부분일치 후보가 2건");
    expect(mockClient.pages.update).not.toHaveBeenCalled();
  });

  it("정확 일치 프로젝트를 부분일치보다 우선 종료한다 (P0-2)", async () => {
    mockClient.dataSources.query.mockResolvedValue({
      results: [
        { id: "p2", properties: { title: { title: [{ plain_text: "jhw-notion-v2" }] } } },
        { id: "p1", properties: { title: { title: [{ plain_text: "jhw-notion" }] } } },
      ],
    });
    mockClient.pages.update.mockResolvedValue({});

    const result = await handler({ project: "jhw-notion" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.project.status).toBe("완료");
    expect(mockClient.pages.update).toHaveBeenCalledWith(
      expect.objectContaining({ page_id: "p1" })
    );
  });

  it("부분일치 단건이라도 정확 일치가 없으면 종료하지 않고 확인을 요청한다 (리뷰 피드백)", async () => {
    mockClient.dataSources.query.mockResolvedValue({
      results: [
        { id: "p1", properties: { title: { title: [{ plain_text: "jhw-notion-v2" }] } } },
      ],
    });

    const result = await handler({ project: "jhw" });

    expect(result.content[0].text).toContain("정확히 일치하는 프로젝트가 없습니다");
    expect(result.content[0].text).toContain("jhw-notion-v2");
    expect(mockClient.pages.update).not.toHaveBeenCalled();
  });
});
