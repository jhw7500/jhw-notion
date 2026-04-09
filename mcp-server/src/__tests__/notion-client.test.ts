import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@notionhq/client", () => ({
  Client: class MockClient {
    constructor(_opts: any) {}
    search = vi.fn();
  },
}));

describe("notion-client", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.NOTION_API_KEY;
  });

  it("NOTION_API_KEY가 없으면 에러를 던진다", async () => {
    const { getNotionClient } = await import("../notion-client.js");
    expect(() => getNotionClient()).toThrow("NOTION_API_KEY");
  });

  it("NOTION_API_KEY가 있으면 Client를 반환한다", async () => {
    process.env.NOTION_API_KEY = "test-key";
    const { getNotionClient } = await import("../notion-client.js");
    const client = getNotionClient();
    expect(client).toBeDefined();
  });

  it("싱글턴으로 동일한 인스턴스를 반환한다", async () => {
    process.env.NOTION_API_KEY = "test-key";
    const { getNotionClient } = await import("../notion-client.js");
    const a = getNotionClient();
    const b = getNotionClient();
    expect(a).toBe(b);
  });
});
