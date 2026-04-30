// P0-3 단위 테스트 — resolvePeriod / queryReportItems / format / cache.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolvePeriod, registerReportPreview, __cache } from "../report-preview.js";
import { queryReportItems } from "../../report/query.js";
import {
  groupByReport,
  formatRedmine,
  formatMarkdown,
} from "../../report/format.js";
import { ReportCache } from "../../cache/report-cache.js";
import {
  createMockNotionClient,
  createMockServer,
} from "../../__tests__/helpers/mock-notion.js";
import * as notionClientMod from "../../notion-client.js";

describe("resolvePeriod", () => {
  it("week는 7일 (today - 6 ~ today)", () => {
    const today = new Date("2026-04-30");
    const p = resolvePeriod({ period: "week", today });
    expect(p.start).toBe("2026-04-24");
    expect(p.end).toBe("2026-04-30");
  });

  it("month는 30일", () => {
    const today = new Date("2026-04-30");
    const p = resolvePeriod({ period: "month", today });
    expect(p.start).toBe("2026-04-01");
    expect(p.end).toBe("2026-04-30");
  });

  it("custom은 start/end 필수", () => {
    expect(() => resolvePeriod({ period: "custom" })).toThrow();
    const p = resolvePeriod({
      period: "custom",
      start: "2026-04-01",
      end: "2026-04-15",
    });
    expect(p.start).toBe("2026-04-01");
    expect(p.end).toBe("2026-04-15");
  });
});

describe("groupByReport", () => {
  it("report 별로 그룹화 + (unmapped)는 마지막", () => {
    const items: any[] = [
      { id: "1", db: "decisionLog", title: "A", date: "2026-04-01", report: "wlan-driver", source: "report" },
      { id: "2", db: "decisionLog", title: "B", date: "2026-04-02", source: "keywordFallback" },
      { id: "3", db: "decisionLog", title: "C", date: "2026-04-03", report: "etc", source: "report" },
    ];
    const groups = groupByReport(items);
    expect(groups.map((g) => g.report)).toEqual(["etc", "wlan-driver", "(unmapped)"]);
    expect(groups[2].items[0].title).toBe("B");
  });
});

describe("formatRedmine / formatMarkdown", () => {
  const period = { start: "2026-04-01", end: "2026-04-30" };
  const groups = [
    {
      report: "wlan-driver",
      items: [
        {
          id: "1",
          db: "decisionLog" as const,
          title: "T1",
          date: "2026-04-05",
          source: "report" as const,
          report: "wlan-driver" as const,
        },
      ],
    },
  ];

  it("redmine 형식은 h2/h3/* 사용", () => {
    const text = formatRedmine(groups, period);
    expect(text).toContain("h2. 업무 보고");
    expect(text).toContain("h3. wlan-driver");
    expect(text).toContain("* 2026-04-05 [decisionLog] T1");
  });

  it("markdown 형식은 ##/###/- 사용", () => {
    const text = formatMarkdown(groups, period);
    expect(text).toContain("## 업무 보고");
    expect(text).toContain("### wlan-driver");
    expect(text).toContain("- 2026-04-05 `decisionLog` T1");
  });
});

describe("ReportCache", () => {
  it("set/get 정상 동작", () => {
    const c = new ReportCache<string>(1000);
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
  });

  it("TTL 만료 시 null 반환", async () => {
    const c = new ReportCache<string>(10);
    c.set("k", "v");
    await new Promise((r) => setTimeout(r, 20));
    expect(c.get("k")).toBeNull();
  });

  it("clear는 모든 항목 제거", () => {
    const c = new ReportCache<string>(1000);
    c.set("a", "1");
    c.set("b", "2");
    expect(c.size()).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
  });
});

describe("queryReportItems", () => {
  let mockClient: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
  });

  it("schema 기반으로 5개 DB query (decisionLog 예시)", async () => {
    // 5개 DB에 대해 각각 빈 결과
    mockClient.databases.query.mockResolvedValue({ results: [] });

    await queryReportItems(mockClient as any, {
      start: "2026-04-01",
      end: "2026-04-30",
      reports: ["wlan-driver"],
      dbs: ["decisionLog"],
    });

    expect(mockClient.databases.query).toHaveBeenCalledTimes(1);
    const call = mockClient.databases.query.mock.calls[0][0];
    expect(call.database_id).toBeDefined();
    // filter는 and([date, or(report)])
    const filter = call.filter;
    expect(filter.and).toBeDefined();
    expect(filter.and[0].property).toBe("date");
    expect(filter.and[0].date.on_or_after).toBe("2026-04-01");
    expect(filter.and[1].or[0].property).toBe("report");
    expect(filter.and[1].or[0].select.equals).toBe("wlan-driver");
  });

  it("결과를 ReportItem 형태로 변환", async () => {
    mockClient.databases.query.mockResolvedValueOnce({
      results: [
        {
          id: "p1",
          url: "u1",
          last_edited_time: "2026-04-05T10:00:00Z",
          properties: {
            title: { title: [{ plain_text: "결정1" }] },
            date: { date: { start: "2026-04-05" } },
            report: { select: { name: "wlan-driver" } },
            project: { relation: [{ id: "proj-id" }] },
          },
        },
      ],
    });

    const items = await queryReportItems(mockClient as any, {
      start: "2026-04-01",
      end: "2026-04-30",
      dbs: ["decisionLog"],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "p1",
      db: "decisionLog",
      title: "결정1",
      date: "2026-04-05",
      report: "wlan-driver",
      projectId: "proj-id",
      source: "report",
    });
  });

  it("none은 기본적으로 제외", async () => {
    mockClient.databases.query.mockResolvedValue({ results: [] });

    await queryReportItems(mockClient as any, {
      start: "2026-04-01",
      end: "2026-04-30",
      dbs: ["decisionLog"],
    });

    const call = mockClient.databases.query.mock.calls[0][0];
    const reportOptions = call.filter.and[1].or.map(
      (f: any) => f.select.equals
    );
    expect(reportOptions).not.toContain("none");
    expect(reportOptions).toContain("etc");
  });

  it("includeNone=true면 none 포함", async () => {
    mockClient.databases.query.mockResolvedValue({ results: [] });

    await queryReportItems(mockClient as any, {
      start: "2026-04-01",
      end: "2026-04-30",
      dbs: ["decisionLog"],
      includeNone: true,
    });

    const call = mockClient.databases.query.mock.calls[0][0];
    const reportOptions = call.filter.and[1].or.map(
      (f: any) => f.select.equals
    );
    expect(reportOptions).toContain("none");
  });
});

describe("registerReportPreview (도구 등록 + cache)", () => {
  let mockClient: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    vi.spyOn(notionClientMod, "getNotionClient").mockReturnValue(
      mockClient as any
    );
    __cache.clear();
  });

  it("등록 시 jhw_report_preview 도구가 노출된다", () => {
    const { server, capturedTools } = createMockServer();
    registerReportPreview(server);
    expect(capturedTools.has("jhw_report_preview")).toBe(true);
  });

  it("동일 인자로 두 번째 호출 시 cache hit", async () => {
    const { server, capturedTools } = createMockServer();
    registerReportPreview(server);
    mockClient.databases.query.mockResolvedValue({ results: [] });

    const tool = capturedTools.get("jhw_report_preview")!;
    const r1 = await tool.handler({
      period: "custom",
      start: "2026-04-01",
      end: "2026-04-07",
    });
    const r2 = await tool.handler({
      period: "custom",
      start: "2026-04-01",
      end: "2026-04-07",
    });

    const out1 = JSON.parse(r1.content[0].text);
    const out2 = JSON.parse(r2.content[0].text);
    expect(out1.cache.hit).toBe(false);
    expect(out2.cache.hit).toBe(true);
    // databases.query는 5개 DB × 1 (첫 호출) = 5번. 두 번째는 cache라 호출 0.
    expect(mockClient.databases.query).toHaveBeenCalledTimes(5);
  });
});
