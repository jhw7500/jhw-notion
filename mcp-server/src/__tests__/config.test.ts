import { describe, it, expect } from "vitest";
import { NOTION_CONFIG, REPORT_VALUES } from "../config.js";
import type { DatabaseName } from "../config.js";

describe("config", () => {
  it("databases에 5개 DB가 모두 있다 (projects/preferences/decisionLog/knowledgeBase/references)", () => {
    expect(NOTION_CONFIG.databases).toHaveProperty("projects");
    expect(NOTION_CONFIG.databases).toHaveProperty("preferences");
    expect(NOTION_CONFIG.databases).toHaveProperty("decisionLog");
    expect(NOTION_CONFIG.databases).toHaveProperty("knowledgeBase");
    expect(NOTION_CONFIG.databases).toHaveProperty("references");
  });

  it("모든 DB ID가 UUID 형식이다", () => {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    for (const id of Object.values(NOTION_CONFIG.databases)) {
      expect(id).toMatch(uuidPattern);
    }
  });

  it("DatabaseName 타입이 5개 키를 허용한다", () => {
    const validNames: DatabaseName[] = [
      "projects",
      "preferences",
      "decisionLog",
      "knowledgeBase",
      "references",
    ];
    expect(validNames).toHaveLength(5);
  });

  it("REPORT_VALUES는 redmine 가이드의 11개 옵션과 일치한다", () => {
    expect(REPORT_VALUES).toEqual([
      "pim-app",
      "pim-driver-cam",
      "pim-driver-spi",
      "pim-test",
      "pim-bsp",
      "wlan-bsp",
      "wlan-app",
      "wlan-driver",
      "wlan-test",
      "etc",
      "none",
    ]);
  });
});
