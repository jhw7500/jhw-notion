import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@notionhq/client", () => ({
  Client: class MockClient {
    constructor(_opts: any) {}
    search = vi.fn();
  },
}));

vi.mock("../env.js", () => ({
  loadNotionEnv: vi.fn(),
}));

const relayName = "__JHW_MANAGED_NOTION_RELAY__";

describe("notion-client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.NOTION_API_KEY;
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, relayName);
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

  it("관리형 표식이 유효하지 않으면 호스트 자격증명으로 폴백하지 않는다", async () => {
    process.env.NOTION_API_KEY = "must-not-be-used";
    Object.defineProperty(globalThis, relayName, { value: null, configurable: true });
    const { loadNotionEnv } = await import("../env.js");
    const { getNotionClient } = await import("../notion-client.js");

    expect(() => getNotionClient()).toThrow("NOTION_MANAGED_UNAVAILABLE");
    expect(loadNotionEnv).not.toHaveBeenCalled();
  });
});
