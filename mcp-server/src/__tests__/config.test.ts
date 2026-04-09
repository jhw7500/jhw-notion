import { describe, it, expect } from "vitest";
import { NOTION_CONFIG } from "../config.js";
import type { DatabaseName } from "../config.js";

describe("config", () => {
  it("databases에 projects, preferences, decisionLog이 있다", () => {
    expect(NOTION_CONFIG.databases).toHaveProperty("projects");
    expect(NOTION_CONFIG.databases).toHaveProperty("preferences");
    expect(NOTION_CONFIG.databases).toHaveProperty("decisionLog");
  });

  it("pages에 references, knowledgeBase가 있다", () => {
    expect(NOTION_CONFIG.pages).toHaveProperty("references");
    expect(NOTION_CONFIG.pages).toHaveProperty("knowledgeBase");
  });

  it("모든 ID가 UUID 형식이다", () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    for (const id of Object.values(NOTION_CONFIG.databases)) {
      expect(id).toMatch(uuidPattern);
    }
    for (const id of Object.values(NOTION_CONFIG.pages)) {
      expect(id).toMatch(uuidPattern);
    }
  });

  it("DatabaseName 타입이 올바른 키를 허용한다", () => {
    const validNames: DatabaseName[] = ["projects", "preferences", "decisionLog"];
    expect(validNames).toHaveLength(3);
  });
});
