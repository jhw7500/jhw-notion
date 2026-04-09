import { describe, it, expect, vi } from "vitest";

vi.mock("../notion-client.js", () => ({
  getNotionClient: vi.fn(),
}));

describe("server", () => {
  it("createServer가 McpServer 인스턴스를 반환한다", async () => {
    const { createServer } = await import("../server.js");
    const server = createServer();
    expect(server).toBeDefined();
    expect(server).toHaveProperty("connect");
  });
});
