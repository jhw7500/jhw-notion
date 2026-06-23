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

import { h2, h3, para, hint, todo, callout, divider } from "../blocks.js";

describe("block builders", () => {
  it("h2 prefixes emoji into heading_2 content", () => {
    const b = h2("목표", "🎯");
    expect(b.type).toBe("heading_2");
    expect(b.heading_2.rich_text[0].text.content).toBe("🎯 목표");
  });

  it("h2 without emoji keeps plain text", () => {
    expect(h2("범위").heading_2.rich_text[0].text.content).toBe("범위");
  });

  it("h3 prefixes emoji into heading_3 content", () => {
    expect(h3("달성한 것", "✅").heading_3.rich_text[0].text.content).toBe("✅ 달성한 것");
  });

  it("para('') yields empty rich_text (blank line)", () => {
    expect(para("").paragraph.rich_text).toEqual([]);
    expect(para("hi").paragraph.rich_text[0].text.content).toBe("hi");
  });

  it("hint is a gray italic paragraph", () => {
    const b = hint("(작업하며 작성)");
    expect(b.type).toBe("paragraph");
    expect(b.paragraph.rich_text[0].annotations).toEqual({ color: "gray", italic: true });
  });

  it("todo defaults to unchecked, accepts checked", () => {
    expect(todo("범위").to_do.checked).toBe(false);
    expect(todo("done", true).to_do.checked).toBe(true);
    expect(todo("범위").to_do.rich_text[0].text.content).toBe("범위");
  });

  it("callout puts emoji in icon slot, text in rich_text, gray bg default", () => {
    const b = callout("💡", "안내");
    expect(b.type).toBe("callout");
    expect(b.callout.icon).toEqual({ type: "emoji", emoji: "💡" });
    expect(b.callout.color).toBe("gray_background");
    expect(b.callout.rich_text[0].text.content).toBe("안내");
  });

  it("divider has empty divider object", () => {
    expect(divider()).toEqual({ object: "block", type: "divider", divider: {} });
  });
});
