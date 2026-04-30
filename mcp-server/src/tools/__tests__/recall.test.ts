// P1-1 MVP — page-cache + jhw_recall 테스트.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerRecall,
  __pageCache,
} from "../recall.js";
import { PageCache, tokenize } from "../../cache/page-cache.js";
import {
  createMockNotionClient,
  createMockServer,
} from "../../__tests__/helpers/mock-notion.js";
import * as notionClientMod from "../../notion-client.js";

describe("tokenize", () => {
  it("lower-case + 2자 이상 + stop word 제거", () => {
    const t = tokenize("The Quick Brown Fox 빠른 갈색 여우");
    expect(t.has("quick")).toBe(true);
    expect(t.has("brown")).toBe(true);
    expect(t.has("the")).toBe(false);
    expect(t.has("빠른")).toBe(true);
  });
});

describe("PageCache", () => {
  it("set + get", () => {
    const c = new PageCache();
    c.set({
      id: "p1",
      db: "decisionLog",
      title: "raw socket 전환",
      text: "libpcap 대신 raw socket 사용",
      lastEdited: "2026-04-01",
    });
    expect(c.get("p1")?.title).toBe("raw socket 전환");
    expect(c.size()).toBe(1);
  });

  it("search — title 매칭에 가중치", () => {
    const c = new PageCache();
    c.set({
      id: "1",
      db: "x",
      title: "VLAN 태깅",
      text: "기능 추가",
    });
    c.set({
      id: "2",
      db: "x",
      title: "기능 변경",
      text: "VLAN 처리 개선",
    });
    const results = c.search("VLAN", 5);
    expect(results.length).toBe(2);
    // title 매칭이 본문 매칭보다 점수 높아야 함 → id=1이 1순위
    expect(results[0].page.id).toBe("1");
  });

  it("query에 매칭 없으면 빈 결과", () => {
    const c = new PageCache();
    c.set({ id: "1", db: "x", title: "alpha", text: "beta" });
    expect(c.search("zeta", 5)).toEqual([]);
  });

  it("clear는 모두 제거", () => {
    const c = new PageCache();
    c.set({ id: "1", db: "x", title: "t", text: "t" });
    c.set({ id: "2", db: "x", title: "t", text: "t" });
    c.clear();
    expect(c.size()).toBe(0);
  });
});

describe("registerRecall", () => {
  let mockClient: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    mockClient = createMockNotionClient();
    vi.spyOn(notionClientMod, "getNotionClient").mockReturnValue(
      mockClient as any
    );
    __pageCache.clear();
  });

  it("등록 시 jhw_recall 도구가 노출된다", () => {
    const { server, capturedTools } = createMockServer();
    registerRecall(server);
    expect(capturedTools.has("jhw_recall")).toBe(true);
  });

  it("캐시가 limit만큼 충분하면 Notion 호출 안 함, used=cache", async () => {
    __pageCache.set({
      id: "p1",
      db: "decisionLog",
      title: "raw socket 전환",
      text: "raw socket 사용",
    });
    const { server, capturedTools } = createMockServer();
    registerRecall(server);
    const tool = capturedTools.get("jhw_recall")!;
    // limit=1로 설정 → 캐시 1건이면 충분 → fallback skip
    const r = await tool.handler({ query: "raw socket", limit: 1 });
    const out = JSON.parse(r.content[0].text);
    expect(out.used).toBe("cache");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].source).toBe("cache");
    expect(mockClient.search).not.toHaveBeenCalled();
  });

  it("캐시 미스 + fallback=true면 Notion search 호출 + 자동 캐시 저장", async () => {
    mockClient.search.mockResolvedValueOnce({
      results: [
        {
          id: "remote-1",
          url: "https://notion.so/remote-1",
          last_edited_time: "2026-04-15T00:00:00Z",
          parent: { type: "page_id" },
          properties: { title: { title: [{ plain_text: "원격 결과" }] } },
        },
      ],
    });

    const { server, capturedTools } = createMockServer();
    registerRecall(server);
    const tool = capturedTools.get("jhw_recall")!;
    const r = await tool.handler({ query: "VLAN", limit: 5 });
    const out = JSON.parse(r.content[0].text);
    expect(out.used).toBe("notion");
    expect(out.results).toHaveLength(1);
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    // 자동 캐시 저장 확인
    expect(__pageCache.size()).toBe(1);
    expect(__pageCache.get("remote-1")?.title).toBe("원격 결과");
  });

  it("캐시 미스 + fallback=false면 used=empty, Notion 호출 안 함", async () => {
    const { server, capturedTools } = createMockServer();
    registerRecall(server);
    const tool = capturedTools.get("jhw_recall")!;
    const r = await tool.handler({ query: "없는키워드", notionFallback: false });
    const out = JSON.parse(r.content[0].text);
    expect(out.used).toBe("empty");
    expect(out.results).toEqual([]);
    expect(mockClient.search).not.toHaveBeenCalled();
  });

  it("로컬 + remote 모두 있으면 used=hybrid", async () => {
    __pageCache.set({
      id: "local-1",
      db: "decisionLog",
      title: "VLAN 태깅",
      text: "VLAN 처리",
    });
    mockClient.search.mockResolvedValueOnce({
      results: [
        {
          id: "remote-1",
          url: "u",
          last_edited_time: "2026-04-15T00:00:00Z",
          parent: { type: "page_id" },
          properties: { title: { title: [{ plain_text: "원격 VLAN" }] } },
        },
      ],
    });

    const { server, capturedTools } = createMockServer();
    registerRecall(server);
    const tool = capturedTools.get("jhw_recall")!;
    const r = await tool.handler({ query: "VLAN", limit: 5 });
    const out = JSON.parse(r.content[0].text);
    expect(out.used).toBe("hybrid");
    expect(out.results.length).toBe(2);
  });
});
