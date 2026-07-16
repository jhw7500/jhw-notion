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

  it("prioritizes the p query page ID over IDs elsewhere in the URL", () => {
    expect(
      normalizePageId(
        "https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/view?p=33a8a230a04e81548fa5d96ebdd63500"
      )
    ).toBe("33a8a230-a04e-8154-8fa5-d96ebdd63500");
  });

  it("uses the trailing page ID when the title contains another hex string", () => {
    expect(
      normalizePageId(
        "https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-title-33a8a230a04e81548fa5d96ebdd63500"
      )
    ).toBe("33a8a230-a04e-8154-8fa5-d96ebdd63500");
  });

  it("does not accept an unrelated query parameter as the page ID", () => {
    expect(() =>
      normalizePageId(
        "https://www.notion.so/project?v=33a8a230a04e81548fa5d96ebdd63500"
      )
    ).toThrow("유효한 Notion 페이지 URL 또는 UUID");
  });

  it("rejects a UUID embedded in a longer raw hex string", () => {
    expect(() =>
      normalizePageId("33a8a230a04e81548fa5d96ebdd635009999")
    ).toThrow("유효한 Notion 페이지 URL 또는 UUID");
  });

  it("rejects input without a Notion page ID", () => {
    expect(() => normalizePageId("https://app.notion.com/p/redmine")).toThrow(
      "유효한 Notion 페이지 URL 또는 UUID"
    );
  });
});
