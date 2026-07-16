import { describe, expect, it } from "vitest";
import { normalizePageId } from "../page-id.js";

describe("normalizePageId", () => {
  it("keeps a dashed UUID", () => {
    expect(normalizePageId("33a8a230-a04e-8154-8fa5-d96ebdd63500")).toBe(
      "33a8a230-a04e-8154-8fa5-d96ebdd63500"
    );
  });

  it("extracts and normalizes an ID from a Notion URL", () => {
    expect(
      normalizePageId(
        "https://app.notion.com/p/redmine-33a8a230a04e81548fa5d96ebdd63500"
      )
    ).toBe("33a8a230-a04e-8154-8fa5-d96ebdd63500");
  });

  it("rejects input without a Notion page ID", () => {
    expect(() => normalizePageId("https://app.notion.com/p/redmine")).toThrow(
      "유효한 Notion 페이지 URL 또는 UUID"
    );
  });
});
