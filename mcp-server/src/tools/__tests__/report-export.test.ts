// jhw_report_export 테스트.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerReportExport } from "../report-export.js";
import { __cache } from "../report-preview.js";
import {
  createMockNotionClient,
  createMockServer,
} from "../../__tests__/helpers/mock-notion.js";
import { NOTION_CONFIG } from "../../config.js";
import * as notionClientMod from "../../notion-client.js";

describe("registerReportExport", () => {
  let mockClient: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    vi.spyOn(notionClientMod, "getNotionClient").mockReturnValue(
      mockClient as any
    );
    __cache.clear();
  });

  it("등록 시 jhw_report_export 도구가 노출된다", () => {
    const { server, capturedTools } = createMockServer();
    registerReportExport(server);
    expect(capturedTools.has("jhw_report_export")).toBe(true);
  });

  it("format=markdown은 ## 헤더, redmine은 h2 사용", async () => {
    const { server, capturedTools } = createMockServer();
    registerReportExport(server);
    mockClient.dataSources.query.mockResolvedValue({ results: [] });

    const tool = capturedTools.get("jhw_report_export")!;
    const r1 = await tool.handler({
      period: "custom",
      start: "2026-04-01",
      end: "2026-04-07",
      format: "markdown",
    });
    const r2 = await tool.handler({
      period: "custom",
      start: "2026-04-01",
      end: "2026-04-07",
      format: "redmine",
    });

    const o1 = JSON.parse(r1.content[0].text);
    const o2 = JSON.parse(r2.content[0].text);
    expect(o1.text).toContain("## 업무 보고");
    expect(o2.text).toContain("h2. 업무 보고");
  });

  it("writeBack.enabled=false면 pages.create 호출 안 함", async () => {
    const { server, capturedTools } = createMockServer();
    registerReportExport(server);
    mockClient.dataSources.query.mockResolvedValue({ results: [] });

    const tool = capturedTools.get("jhw_report_export")!;
    const r = await tool.handler({
      period: "custom",
      start: "2026-04-01",
      end: "2026-04-07",
      format: "markdown",
    });

    const out = JSON.parse(r.content[0].text);
    expect(out.writeBack).toBeNull();
    expect(mockClient.pages.create).not.toHaveBeenCalled();
  });

  it("writeBack.enabled=true면 KB DB에 페이지 생성", async () => {
    const { server, capturedTools } = createMockServer();
    registerReportExport(server);
    mockClient.dataSources.query.mockResolvedValue({ results: [] });
    mockClient.pages.create.mockResolvedValue({
      id: "kb-1",
      url: "https://notion.so/kb-1",
    });

    const tool = capturedTools.get("jhw_report_export")!;
    const r = await tool.handler({
      period: "custom",
      start: "2026-04-01",
      end: "2026-04-07",
      format: "markdown",
      writeBack: { enabled: true },
    });

    const out = JSON.parse(r.content[0].text);
    expect(out.writeBack).toMatchObject({ id: "kb-1", db: "knowledgeBase" });
    const call = mockClient.pages.create.mock.calls[0][0];
    expect(call.parent.database_id).toBe(
      NOTION_CONFIG.databases.knowledgeBase
    );
    expect(call.properties.category.select.name).toBe("기타");
    expect(call.properties.report.select.name).toBe("etc");
  });

  it("writeBack.db=decisionLog면 decisionLog에 저장 + status/area 포함", async () => {
    const { server, capturedTools } = createMockServer();
    registerReportExport(server);
    mockClient.dataSources.query.mockResolvedValue({ results: [] });
    mockClient.pages.create.mockResolvedValue({
      id: "d-1",
      url: "https://notion.so/d-1",
    });

    const tool = capturedTools.get("jhw_report_export")!;
    await tool.handler({
      period: "custom",
      start: "2026-04-01",
      end: "2026-04-07",
      format: "markdown",
      writeBack: { enabled: true, db: "decisionLog", title: "주간 보고" },
    });

    const call = mockClient.pages.create.mock.calls[0][0];
    expect(call.parent.database_id).toBe(
      NOTION_CONFIG.databases.decisionLog
    );
    expect(call.properties.status.select.name).toBe("확정");
    expect(call.properties.title.title[0].text.content).toBe("주간 보고");
  });
});
