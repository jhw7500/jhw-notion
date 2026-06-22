// Regression test for date filter bug (2026-05-08).
// notion.dataSources.query의 server-side date filter가 multi-data-source DB에서
// silently 무시되는 케이스를 시뮬레이션하고, 메모리 사이드 필터가 기간 외
// 데이터를 정확히 제거하는지 검증한다.
import { describe, it, expect, beforeEach } from "vitest";
import { queryReportItems } from "../query.js";
import { createMockNotionClient } from "../../__tests__/helpers/mock-notion.js";

function pageWithDate(id: string, date: string, report: string, title = "test") {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    properties: {
      title: { title: [{ plain_text: title }] },
      date: { date: { start: date } },
      report: { select: { name: report } },
    },
    last_edited_time: `${date}T00:00:00.000Z`,
  };
}

describe("queryReportItems — memory-side date filter (regression for bug 2026-05-08)", () => {
  let notion: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    notion = createMockNotionClient();
  });

  it("server filter가 무시되어 모든 날짜를 반환해도, 메모리 필터가 기간 외 항목을 제거한다", async () => {
    // server filter 무시 시뮬레이션: 입력 기간(2026-04-29 단일일)과 무관하게
    // 4/8, 4/22, 4/29, 5/7 항목이 모두 반환된다고 가정.
    const rawResults = [
      pageWithDate("p-april-08", "2026-04-08", "etc"),
      pageWithDate("p-april-22", "2026-04-22", "pim-test"),
      pageWithDate("p-april-29-a", "2026-04-29", "pim-app"),
      pageWithDate("p-april-29-b", "2026-04-29", "etc"),
      pageWithDate("p-may-07", "2026-05-07", "wlan-app"),
    ];
    notion.dataSources.query.mockResolvedValue({ results: rawResults, next_cursor: null });

    const items = await queryReportItems(notion as any, {
      start: "2026-04-29",
      end: "2026-04-29",
      dbs: ["decisionLog"],
    });

    // 4/29 항목 2개만 통과해야 한다 (4/8, 4/22, 5/7 모두 제거)
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(["p-april-29-a", "p-april-29-b"]);
    items.forEach((i) => expect(i.date).toBe("2026-04-29"));
  });

  it("미래 기간 입력은 0건을 반환한다 (server filter가 모든 과거 데이터를 반환해도)", async () => {
    notion.dataSources.query.mockResolvedValue({
      results: [
        pageWithDate("p-1", "2026-04-08", "etc"),
        pageWithDate("p-2", "2026-04-30", "pim-app"),
        pageWithDate("p-3", "2026-05-07", "etc"),
      ],
      next_cursor: null,
    });

    const items = await queryReportItems(notion as any, {
      start: "2027-01-01",
      end: "2027-01-07",
      dbs: ["decisionLog"],
    });

    expect(items).toHaveLength(0);
  });

  it("정상 기간(2026-05-01~05-07) 입력 시 해당 범위만 반환한다", async () => {
    notion.dataSources.query.mockResolvedValue({
      results: [
        pageWithDate("p-april", "2026-04-30", "etc"),
        pageWithDate("p-may-01", "2026-05-01", "pim-app"),
        pageWithDate("p-may-07", "2026-05-07", "wlan-app"),
        pageWithDate("p-may-08", "2026-05-08", "etc"),
      ],
      next_cursor: null,
    });

    const items = await queryReportItems(notion as any, {
      start: "2026-05-01",
      end: "2026-05-07",
      dbs: ["decisionLog"],
    });

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(["p-may-01", "p-may-07"]);
  });

  it("dateProp 없는 DB(preferences)도 last_edited_time 기반 메모리 필터가 작동한다", async () => {
    // preferences는 schema.properties에 date 키가 없음 → resolveDateProp이 null
    // → server filter는 date 조건 자체가 추가 안 됨. 메모리 필터만 작동.
    notion.dataSources.query.mockResolvedValue({
      results: [
        {
          id: "pref-old",
          url: "https://www.notion.so/pref-old",
          properties: {
            title: { title: [{ plain_text: "old" }] },
            report: { select: { name: "etc" } },
          },
          last_edited_time: "2026-04-08T00:00:00.000Z",
        },
        {
          id: "pref-recent",
          url: "https://www.notion.so/pref-recent",
          properties: {
            title: { title: [{ plain_text: "recent" }] },
            report: { select: { name: "pim-app" } },
          },
          last_edited_time: "2026-05-07T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    });

    const items = await queryReportItems(notion as any, {
      start: "2026-05-01",
      end: "2026-05-07",
      dbs: ["preferences"],
    });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("pref-recent");
  });

  it("select 필터(reports)는 메모리 필터와 독립적으로 동작한다 (server-side)", async () => {
    notion.dataSources.query.mockResolvedValue({
      results: [
        pageWithDate("p-1", "2026-05-01", "pim-app"),
        pageWithDate("p-2", "2026-05-02", "etc"),
      ],
      next_cursor: null,
    });

    await queryReportItems(notion as any, {
      start: "2026-05-01",
      end: "2026-05-07",
      reports: ["pim-app"],
      dbs: ["decisionLog"],
    });

    // server에 보낸 filter에 select=pim-app 조건이 포함되어야 한다
    const callArgs = notion.dataSources.query.mock.calls[0][0];
    const filterStr = JSON.stringify(callArgs.filter);
    expect(filterStr).toContain('"select":{"equals":"pim-app"}');
    expect(filterStr).toContain("on_or_after");
  });

  it("임팩트(text) 프로퍼티를 impact 필드로 읽는다", async () => {
    notion.dataSources.query.mockResolvedValue({
      results: [
        {
          id: "p-impact",
          url: "https://www.notion.so/p-impact",
          properties: {
            title: { title: [{ plain_text: "성과 항목" }] },
            date: { date: { start: "2026-05-03" } },
            report: { select: { name: "wlan-driver" } },
            임팩트: {
              rich_text: [{ plain_text: "무인 운용 안정성 확보" }],
            },
          },
          last_edited_time: "2026-05-03T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    });

    const items = await queryReportItems(notion as any, {
      start: "2026-05-01",
      end: "2026-05-07",
      dbs: ["projects"],
    });

    expect(items).toHaveLength(1);
    expect(items[0].impact).toBe("무인 운용 안정성 확보");
  });

  it("임팩트 프로퍼티가 없으면 impact는 undefined", async () => {
    notion.dataSources.query.mockResolvedValue({
      results: [pageWithDate("p-noimpact", "2026-05-03", "etc")],
      next_cursor: null,
    });

    const items = await queryReportItems(notion as any, {
      start: "2026-05-01",
      end: "2026-05-07",
      dbs: ["decisionLog"],
    });

    expect(items[0].impact).toBeUndefined();
  });

  it("임팩트 여러 rich_text 조각을 합치고 개행/연속공백을 단일 공백으로 정리한다", async () => {
    notion.dataSources.query.mockResolvedValue({
      results: [
        {
          id: "p-multi",
          url: "https://www.notion.so/p-multi",
          properties: {
            title: { title: [{ plain_text: "다중 조각" }] },
            date: { date: { start: "2026-05-03" } },
            report: { select: { name: "wlan-app" } },
            임팩트: {
              rich_text: [
                { plain_text: "재발률 0\n" },
                { plain_text: "  달성   완료" },
              ],
            },
          },
          last_edited_time: "2026-05-03T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    });

    const items = await queryReportItems(notion as any, {
      start: "2026-05-01",
      end: "2026-05-07",
      dbs: ["projects"],
    });

    expect(items[0].impact).toBe("재발률 0 달성 완료");
  });

  it("임팩트 rich_text가 빈 배열이면 impact는 undefined", async () => {
    notion.dataSources.query.mockResolvedValue({
      results: [
        {
          id: "p-empty",
          url: "https://www.notion.so/p-empty",
          properties: {
            title: { title: [{ plain_text: "빈 임팩트" }] },
            date: { date: { start: "2026-05-03" } },
            report: { select: { name: "etc" } },
            임팩트: { rich_text: [] },
          },
          last_edited_time: "2026-05-03T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    });

    const items = await queryReportItems(notion as any, {
      start: "2026-05-01",
      end: "2026-05-07",
      dbs: ["projects"],
    });

    expect(items[0].impact).toBeUndefined();
  });
});
