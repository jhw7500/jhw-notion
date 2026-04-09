import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerNote } from "../note.js";

describe("jhw_note", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerNote(server as any);
    handler = capturedTools.get("jhw_note")!.handler;
  });

  it("Knowledge Base에 메모를 생성한다", async () => {
    mockClient.pages.create.mockResolvedValue({
      id: "note-1",
      url: "https://notion.so/note-1",
    });

    const result = await handler({ title: "ESM 팁", content: "import에 .js 확장자 필수" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.title).toBe("ESM 팁");
    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.parent.page_id).toBeDefined();
    expect(createCall.children.length).toBe(2); // content + date
  });

  it("프로젝트가 있으면 관련 프로젝트 블록을 추가한다", async () => {
    mockClient.pages.create.mockResolvedValue({ id: "n", url: "u" });

    await handler({ title: "팁", content: "내용", project: "my-project" });

    const createCall = mockClient.pages.create.mock.calls[0][0];
    expect(createCall.children.length).toBe(3); // content + project + date
    expect(createCall.children[1].paragraph.rich_text[0].text.content).toContain("my-project");
  });
});
