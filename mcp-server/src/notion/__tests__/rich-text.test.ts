import { describe, it, expect } from "vitest";
import { clampRichText, MAX_RICH_TEXT_CHARS } from "../rich-text.js";

describe("clampRichText", () => {
  it("returns the value untouched when within the limit", () => {
    expect(clampRichText("짧은 요약", "summary")).toBe("짧은 요약");
    expect(clampRichText("", "summary")).toBe("");
  });

  it("leaves a value of exactly the limit untouched", () => {
    const exact = "가".repeat(MAX_RICH_TEXT_CHARS);
    const warnings: string[] = [];
    expect(clampRichText(exact, "summary", warnings)).toBe(exact);
    expect(warnings).toEqual([]);
  });

  it("clamps to the limit (inclusive of the ellipsis) when over", () => {
    const long = "a".repeat(MAX_RICH_TEXT_CHARS + 500);
    const out = clampRichText(long, "summary");
    expect(out).toHaveLength(MAX_RICH_TEXT_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("pushes a warning naming the field, both lengths, and the likely cause", () => {
    const warnings: string[] = [];
    clampRichText("b".repeat(2602), "summary", warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("summary");
    expect(warnings[0]).toContain("2602");
    expect(warnings[0]).toContain(String(MAX_RICH_TEXT_CHARS));
    // 실제 사고(본문이 summary로 흘러들어감) 진단을 돕는 문구
    expect(warnings[0]).toContain("content");
  });

  it("does not throw when no warnings array is supplied", () => {
    expect(() =>
      clampRichText("c".repeat(MAX_RICH_TEXT_CHARS + 1), "description")
    ).not.toThrow();
  });

  it("counts by code units so multibyte text is clamped to a valid length", () => {
    // Notion 한도는 문자 수 기준이라 한글도 동일하게 잘려야 한다.
    const long = "한".repeat(MAX_RICH_TEXT_CHARS + 100);
    expect(clampRichText(long, "summary")).toHaveLength(MAX_RICH_TEXT_CHARS);
  });
});
