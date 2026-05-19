import { describe, it, expect } from "vitest";
import { paragraphBlocks } from "../blocks.js";

describe("paragraphBlocks", () => {
  it("returns empty array for empty/null content", () => {
    expect(paragraphBlocks("")).toEqual([]);
    expect(paragraphBlocks(null)).toEqual([]);
    expect(paragraphBlocks(undefined)).toEqual([]);
    expect(paragraphBlocks("   ")).toEqual([]);
  });

  it("creates single block for short content", () => {
    const blocks = paragraphBlocks("Hello world");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].paragraph.rich_text[0].text.content).toBe("Hello world");
  });

  it("splits by \\n\\n into multiple blocks", () => {
    const blocks = paragraphBlocks("Para A\n\nPara B\n\nPara C");
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.paragraph.rich_text[0].text.content)).toEqual([
      "Para A",
      "Para B",
      "Para C",
    ]);
  });

  it("handles 3+ consecutive newlines as single separator", () => {
    const blocks = paragraphBlocks("A\n\n\n\nB");
    expect(blocks).toHaveLength(2);
  });

  it("splits paragraph longer than 2000 chars into chunks ≤ 2000", () => {
    const long = "Sentence. ".repeat(300); // 3000 chars
    const blocks = paragraphBlocks(long);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      expect(b.paragraph.rich_text[0].text.content.length).toBeLessThanOrEqual(2000);
    }
  });

  it("prefers line-break boundary when splitting long paragraphs", () => {
    const long = "Line 1\n".repeat(400); // long content with frequent line breaks
    const blocks = paragraphBlocks(long);
    for (const b of blocks) {
      const text = b.paragraph.rich_text[0].text.content;
      expect(text.length).toBeLessThanOrEqual(2000);
    }
  });

  it("preserves markdown formatting characters", () => {
    const blocks = paragraphBlocks("# Heading\n\n- item 1\n- item 2");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].paragraph.rich_text[0].text.content).toBe("# Heading");
    expect(blocks[1].paragraph.rich_text[0].text.content).toBe("- item 1\n- item 2");
  });
});
