// P1-2 단위 테스트 — schema-driven property builder.
import { describe, it, expect, vi } from "vitest";
import { buildPropertiesFromSchema } from "../property-builder.js";
import { createMockNotionClient } from "../../__tests__/helpers/mock-notion.js";

describe("buildPropertiesFromSchema", () => {
  function setup() {
    const notion = createMockNotionClient();
    return notion;
  }

  it("decisionLog: status default '확정', date 자동 today, rationale rich_text", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "decisionLog",
      "T",
      { rationale: "근거", alternatives: "대안" },
      notion as any
    );
    expect(props.title.title[0].text.content).toBe("T");
    expect(props.status.select.name).toBe("확정");
    expect(props.rationale.rich_text[0].text.content).toBe("근거");
    expect(props.alternatives.rich_text[0].text.content).toBe("대안");
    const today = new Date().toISOString().split("T")[0];
    expect(props.date.date.start).toBe(today);
  });

  it("projects: status default '진행중', tech_stack multi_select, start_date 자동", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "projects",
      "P",
      { tech_stack: "TypeScript, Node.js", description: "설명" },
      notion as any
    );
    expect(props.status.select.name).toBe("진행중");
    expect(props.tech_stack.multi_select).toEqual([
      { name: "TypeScript" },
      { name: "Node.js" },
    ]);
    expect(props.description.rich_text[0].text.content).toBe("설명");
    expect(props.start_date.date.start).toBeTruthy();
  });

  it("knowledgeBase: summary + category + tags + date", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "knowledgeBase",
      "T",
      {
        summary: "요약",
        category: "문제해결",
        tags: "iMX93,BSP",
      },
      notion as any
    );
    expect(props.summary.rich_text[0].text.content).toBe("요약");
    expect(props.category.select.name).toBe("문제해결");
    expect(props.tags.multi_select).toEqual([
      { name: "iMX93" },
      { name: "BSP" },
    ]);
    expect(props.date.date.start).toBeTruthy();
  });

  it("references: url 필드", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "references",
      "T",
      { url: "https://example.com", tool: "vitest,tsc" },
      notion as any
    );
    expect(props.url.url).toBe("https://example.com");
    expect(props.tool.multi_select).toHaveLength(2);
  });

  it("preferences: project 필드는 schema에 없으므로 skip (relation 호출 안 함)", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "preferences",
      "T",
      { project: "test", category: "AI 사용" },
      notion as any
    );
    expect(props.project).toBeUndefined();
    expect(notion.dataSources.query).not.toHaveBeenCalled();
  });

  it("project relation: resolveProject 호출 후 [{id}]로 변환", async () => {
    const notion = setup();
    notion.dataSources.query.mockResolvedValueOnce({
      results: [
        { id: "proj-id", properties: { title: { title: [{ plain_text: "test" }] } } },
      ],
    });
    const props = await buildPropertiesFromSchema(
      "decisionLog",
      "T",
      { project: "test" },
      notion as any
    );
    expect(props.project.relation).toEqual([{ id: "proj-id" }]);
  });

  it("presetProjectId 옵션이 있으면 resolveProject 호출 skip", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "decisionLog",
      "T",
      { project: "ignored" },
      notion as any,
      { presetProjectId: "preset-id" }
    );
    expect(props.project.relation).toEqual([{ id: "preset-id" }]);
    expect(notion.dataSources.query).not.toHaveBeenCalled();
  });

  it("autoFillToday: false면 date 자동 주입 안 함", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "decisionLog",
      "T",
      {},
      notion as any,
      { autoFillToday: false }
    );
    expect(props.date).toBeUndefined();
  });

  it("input date 명시 시 autoFill 대신 그 값 사용", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "decisionLog",
      "T",
      { date: "2026-01-15" },
      notion as any
    );
    expect(props.date.date.start).toBe("2026-01-15");
  });

  it("schema에 없는 입력 키는 무시", async () => {
    const notion = setup();
    const props = await buildPropertiesFromSchema(
      "decisionLog",
      "T",
      { 알수없는키: "값", rationale: "근거" },
      notion as any
    );
    expect(props.알수없는키).toBeUndefined();
    expect(props.rationale).toBeDefined();
  });

  it("report select은 모든 5개 DB에서 작동", async () => {
    const notion = setup();
    for (const db of ["decisionLog", "preferences", "projects", "knowledgeBase", "references"] as const) {
      const props = await buildPropertiesFromSchema(
        db,
        "T",
        { report: "wlan-driver" },
        notion as any
      );
      expect(props.report.select.name).toBe("wlan-driver");
    }
  });
});
