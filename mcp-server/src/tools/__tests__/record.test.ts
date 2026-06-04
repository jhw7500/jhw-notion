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

  it("decisionLog의 project 키워드를 projects DB에서 검색해 relation으로 변환한다", async () => {
    mockClient.dataSources.query.mockResolvedValue({
      results: [{ id: "proj-page-id-1" }],
    });
    mockClient.pages.create.mockResolvedValue({ id: "p", url: "u" });

    await handler({
      db: "decisionLog",
      title: "테스트 결정",
      properties: { project: "redmine" },
    });

    expect(mockClient.dataSources.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          property: "title",
          title: { contains: "redmine" },
        }),
      })
    );
    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties["project"]).toEqual({
      relation: [{ id: "proj-page-id-1" }],
    });
  });

  it("decisionLog의 project가 URL이면 해당 페이지 ID를 relation으로 설정한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "p", url: "u" });

    await handler({
      db: "decisionLog",
      title: "테스트 결정",
      properties: {
        project:
          "https://www.notion.so/redmine-33a8a230a04e81548fa5d96ebdd63500",
      },
    });

    // URL에서 ID 추출 — 데이터베이스 검색 없이 바로 relation으로 변환
    expect(mockClient.dataSources.query).not.toHaveBeenCalled();
    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties["project"].relation[0].id).toBe(
      "33a8a230-a04e-8154-8fa5-d96ebdd63500"
    );
  });

  it("decisionLog의 project가 매칭되지 않으면 project 필드를 생략한다", async () => {
    mockClient.dataSources.query.mockResolvedValue({ results: [] });
    mockClient.pages.create.mockResolvedValue({ id: "p", url: "u" });

    await handler({
      db: "decisionLog",
      title: "테스트 결정",
      properties: { project: "존재하지 않는 프로젝트" },
    });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties["project"]).toBeUndefined();
  });

  it("미허용 select 값이면 저장하지 않고 에러 메시지를 반환한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "p", url: "u" });

    const result = await handler({
      db: "projects",
      title: "P",
      properties: { status: "이상한상태zzz" },
    });

    expect(result.content[0].text).toContain("미허용");
    expect(result.content[0].text).toContain("status");
    expect(mockClient.pages.create).not.toHaveBeenCalled();
  });

  it("미등록 multi_select 값은 drop하고 응답 warnings에 포함한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "p", url: "u" });

    const result = await handler({
      db: "knowledgeBase",
      title: "K",
      properties: { tags: "iMX93, zzz없는태그" },
    });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.properties["tags"].multi_select).toEqual([
      { name: "iMX93" },
    ]);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.join(" ")).toContain("zzz없는태그");
  });
});
