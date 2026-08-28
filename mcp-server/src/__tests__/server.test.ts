import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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

  it("MCP tools/list 응답에 jhw_fetch를 공개한다", async () => {
    const { createServer } = await import("../server.js");
    const server = createServer();
    const client = new Client({ name: "server-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("jhw_fetch");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
