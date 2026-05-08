// P0-1 회귀 테스트.
// project 필드가 record/start (쓰기) ↔ context/history (읽기) 사이에서
// relation 타입으로 일관되게 다뤄지는지 검증.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import { registerRecord } from "../record.js";
import { registerStart } from "../start.js";
import { registerContext } from "../context.js";
import { registerHistory } from "../history.js";
import { NOTION_CONFIG } from "../../config.js";
import { DATABASE_SCHEMAS } from "../../schema.js";
import * as notionClientMod from "../../notion-client.js";

describe("project field consistency (P0-1 regression)", () => {
  let mockClient: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    vi.spyOn(notionClientMod, "getNotionClient").mockReturnValue(mockClient as any);
  });

  it("record.ts: decisionLog 작성 시 project를 relation으로 저장한다", async () => {
    const { server, capturedTools } = createMockServer();
    registerRecord(server);

    mockClient.dataSources.query.mockResolvedValueOnce({
      results: [
        {
          id: "test-project-id",
          properties: { title: { title: [{ plain_text: "test" }] } },
        },
      ],
    });
    mockClient.pages.create.mockResolvedValueOnce({ id: "new", url: "u" });

    const tool = capturedTools.get("jhw_record")!;
    await tool.handler({
      db: "decisionLog",
      title: "T",
      properties: { project: "test", rationale: "r" },
    });

    const props = mockClient.pages.create.mock.calls[0][0].properties;
    expect(props.project).toBeDefined();
    expect(props.project.relation).toEqual([{ id: "test-project-id" }]);
    expect(props.project.rich_text).toBeUndefined();
  });

  it("start.ts: decisionLog의 project를 relation으로 작성한다 (rich_text 금지)", async () => {
    const { server, capturedTools } = createMockServer();
    registerStart(server);

    mockClient.pages.create
      .mockResolvedValueOnce({ id: "proj-page", url: "u1" }) // projects
      .mockResolvedValueOnce({ id: "dec-page", url: "u2" }); // decisionLog

    const tool = capturedTools.get("jhw_start")!;
    await tool.handler({ name: "test-proj", description: "d" });

    const decisionCall = mockClient.pages.create.mock.calls[1][0];
    expect(decisionCall.parent.database_id).toBe(NOTION_CONFIG.databases.decisionLog);
    const projectProp = decisionCall.properties.project;
    expect(projectProp).toBeDefined();
    expect(projectProp.relation).toEqual([{ id: "proj-page" }]);
    expect(projectProp.rich_text).toBeUndefined();
  });

  it("context.ts: decisionLog query 시 relation filter를 우선 사용한다", async () => {
    const { server, capturedTools } = createMockServer();
    registerContext(server);

    mockClient.dataSources.query
      .mockResolvedValueOnce({
        results: [
          {
            id: "proj-id",
            url: "u",
            properties: {
              title: { title: [{ plain_text: "test" }] },
              status: { select: { name: "진행중" } },
              tech_stack: { multi_select: [] },
              repo: { rich_text: [] },
              description: { rich_text: [] },
              start_date: { date: { start: "2026-04-30" } },
            },
          },
        ],
      })
      // decisions — 1차 relation filter에 1건 매칭되도록 두어 fallback 방지
      .mockResolvedValueOnce({
        results: [
          {
            id: "dec-1",
            properties: {
              title: { title: [{ plain_text: "T" }] },
              status: { select: { name: "확정" } },
              date: { date: { start: "2026-04-30" } },
              rationale: { rich_text: [] },
            },
          },
        ],
      });
    mockClient.blocks.children.list.mockResolvedValueOnce({ results: [] });

    const tool = capturedTools.get("jhw_context")!;
    await tool.handler({ project: "test" });

    const decisionsCall = mockClient.dataSources.query.mock.calls[1][0];
    expect(decisionsCall.data_source_id).toBe(DATABASE_SCHEMAS.decisionLog.dataSourceId);
    expect(decisionsCall.filter.property).toBe("project");
    expect(decisionsCall.filter.relation?.contains).toBe("proj-id");
    // rich_text fallback이 1차 시도에 들어가지 않아야 함
    expect(decisionsCall.filter.rich_text).toBeUndefined();
    // fallback이 호출되지 않았어야 함 (projects 1 + decisions 1 = 총 2회)
    expect(mockClient.dataSources.query).toHaveBeenCalledTimes(2);
  });

  it("history.ts: decisionLog query 시 relation filter를 우선 사용한다", async () => {
    const { server, capturedTools } = createMockServer();
    registerHistory(server);

    mockClient.dataSources.query
      .mockResolvedValueOnce({
        results: [
          {
            id: "proj-id",
            properties: {
              title: { title: [{ plain_text: "test" }] },
              start_date: { date: { start: "2026-04-30" } },
            },
          },
        ],
      })
      // decisions — 1차 relation filter에 1건 매칭되도록 두어 fallback 방지
      .mockResolvedValueOnce({
        results: [
          {
            id: "dec-1",
            properties: {
              title: { title: [{ plain_text: "T" }] },
              status: { select: { name: "확정" } },
              date: { date: { start: "2026-04-30" } },
            },
          },
        ],
      });

    const tool = capturedTools.get("jhw_history")!;
    await tool.handler({ project: "test" });

    const decisionsCall = mockClient.dataSources.query.mock.calls[1][0];
    expect(decisionsCall.data_source_id).toBe(DATABASE_SCHEMAS.decisionLog.dataSourceId);
    expect(decisionsCall.filter.property).toBe("project");
    expect(decisionsCall.filter.relation?.contains).toBe("proj-id");
    expect(decisionsCall.filter.rich_text).toBeUndefined();
    expect(mockClient.dataSources.query).toHaveBeenCalledTimes(2);
  });
});
