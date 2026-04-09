import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockNotionClient, createMockServer } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";

let mockClient: MockNotionClient;

vi.mock("../../notion-client.js", () => ({
  getNotionClient: () => mockClient,
}));

import { registerStart } from "../start.js";

describe("jhw_start", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    const { server, capturedTools } = createMockServer();
    registerStart(server as any);
    handler = capturedTools.get("jhw_start")!.handler;
  });

  it("프로젝트 + Decision Log 두 페이지를 생성한다", async () => {
    mockClient.pages.create
      .mockResolvedValueOnce({ id: "proj-1", url: "https://notion.so/proj-1" })
      .mockResolvedValueOnce({ id: "dec-1", url: "https://notion.so/dec-1" });

    const result = await handler({
      name: "test-infra",
      description: "테스트 인프라 구축",
      repo: "github.com/test",
      stack: "TypeScript, Vitest",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.project.id).toBe("proj-1");
    expect(parsed.decision.id).toBe("dec-1");
    expect(mockClient.pages.create).toHaveBeenCalledTimes(2);
  });

  it("프로젝트 페이지에 템플릿 블록을 포함한다", async () => {
    mockClient.pages.create
      .mockResolvedValueOnce({ id: "p", url: "u" })
      .mockResolvedValueOnce({ id: "d", url: "u" });

    await handler({ name: "test", description: "설명" });

    const projectCreate = mockClient.pages.create.mock.calls[0][0];
    expect(projectCreate.children).toBeDefined();
    expect(projectCreate.children.length).toBeGreaterThan(0);
    // 목표, 범위, 제약사항, 메모 heading 블록 확인
    const headings = projectCreate.children
      .filter((b: any) => b.type === "heading_2")
      .map((b: any) => b.heading_2.rich_text[0].text.content);
    expect(headings).toContain("목표");
    expect(headings).toContain("범위");
  });

  it("Decision Log에 프로젝트명과 설명을 기록한다", async () => {
    mockClient.pages.create
      .mockResolvedValueOnce({ id: "p", url: "u" })
      .mockResolvedValueOnce({ id: "d", url: "u" });

    await handler({ name: "my-proj", description: "설명 텍스트" });

    const decisionCreate = mockClient.pages.create.mock.calls[1][0];
    expect(decisionCreate.properties["title"].title[0].text.content).toContain("my-proj");
    expect(decisionCreate.properties["project"].rich_text[0].text.content).toBe("my-proj");
    expect(decisionCreate.properties["rationale"].rich_text[0].text.content).toBe("설명 텍스트");
  });
});
