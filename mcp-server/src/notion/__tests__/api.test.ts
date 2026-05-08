// P0-2 단위 테스트 — withRetry/withTimeout/RateLimiter/NotionError.
// p1-3c M2 추가 — queryDataSource wrapper.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  withRetry,
  withTimeout,
  RateLimiter,
  NotionError,
  isRetryable,
  queryDataSource,
} from "../api.js";
import { DATABASE_SCHEMAS } from "../../schema.js";

describe("isRetryable", () => {
  it("429/500/502/503/504는 retryable", () => {
    for (const s of [429, 500, 502, 503, 504, 408]) {
      expect(isRetryable({ status: s })).toBe(true);
    }
  });
  it("400/401/403/404는 non-retryable", () => {
    for (const s of [400, 401, 403, 404]) {
      expect(isRetryable({ status: s })).toBe(false);
    }
  });
  it("ECONNRESET/ETIMEDOUT 같은 네트워크 에러는 retryable", () => {
    expect(isRetryable({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryable({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryable({ code: "ENOTFOUND" })).toBe(true);
  });
});

describe("withRetry", () => {
  it("성공하면 즉시 반환한다", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retryable 에러 (429)는 재시도 후 성공한다", async () => {
    const err: any = new Error("rate limit");
    err.status = 429;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(fn, { sleep, rng: () => 0.5 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("non-retryable 에러 (400)는 즉시 NotionError로 throw", async () => {
    const err: any = new Error("bad request");
    err.status = 400;
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { sleep: vi.fn() })).rejects.toBeInstanceOf(NotionError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("max attempts 초과 시 NotionError로 throw", async () => {
    const err: any = new Error("server error");
    err.status = 503;
    const fn = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      withRetry(fn, { attempts: 3, sleep, rng: () => 0 })
    ).rejects.toBeInstanceOf(NotionError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("Retry-After 헤더가 있으면 그 시간만큼 대기한다", async () => {
    const err: any = new Error("rate limit");
    err.status = 429;
    err.headers = { "retry-after": "2" };
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    await withRetry(fn, { sleep, rng: () => 0.5 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("ECONNRESET 같은 네트워크 에러도 retryable", async () => {
    const err: any = new Error("conn reset");
    err.code = "ECONNRESET";
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(fn, { sleep, rng: () => 0.5 });
    expect(result).toBe("ok");
  });

  it("NotionError에 status/requestId가 보존된다", async () => {
    const err: any = new Error("nope");
    err.status = 404;
    err.headers = { "x-request-id": "req-abc" };
    const fn = vi.fn().mockRejectedValue(err);
    try {
      await withRetry(fn, { operation: "pages.create" });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e).toBeInstanceOf(NotionError);
      expect(e.status).toBe(404);
      expect(e.requestId).toBe("req-abc");
      expect(e.operation).toBe("pages.create");
      expect(e.retryable).toBe(false);
    }
  });
});

describe("withTimeout", () => {
  it("timeout 전에 완료되면 정상 반환", async () => {
    const result = await withTimeout(async () => "ok", 100);
    expect(result).toBe("ok");
  });

  it("timeout 초과 시 NotionError로 throw", async () => {
    const slow = () => new Promise((r) => setTimeout(r, 200));
    await expect(withTimeout(slow, 50, "test")).rejects.toBeInstanceOf(NotionError);
  });

  it("내부 함수가 throw하면 그대로 전파", async () => {
    const fn = () => Promise.reject(new Error("inner"));
    await expect(withTimeout(fn, 1000)).rejects.toThrow("inner");
  });
});

describe("RateLimiter", () => {
  it("concurrency 제한을 지킨다", async () => {
    const limiter = new RateLimiter(2);
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(task)));
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("내부 함수 throw해도 active 카운트가 정상 해제된다", async () => {
    const limiter = new RateLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error("oops");
      })
    ).rejects.toThrow("oops");
    // 다음 task가 즉시 실행되어야 함 (deadlock 없음)
    const result = await limiter.run(async () => "ok");
    expect(result).toBe("ok");
  });
});

// =====================================================================
// p1-3c M2 — queryDataSource wrapper unit tests
// =====================================================================

function makeFullPage(id: string) {
  return {
    object: "page",
    id,
    parent: { type: "data_source_id", data_source_id: "x" },
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-02T00:00:00.000Z",
    created_by: { object: "user", id: "u1" },
    last_edited_by: { object: "user", id: "u1" },
    in_trash: false,
    archived: false,
    icon: null,
    cover: null,
    url: `https://www.notion.so/${id}`,
    public_url: null,
    properties: {},
  };
}

describe("queryDataSource (p1-3c M2)", () => {
  let mockNotion: any;

  beforeEach(() => {
    mockNotion = {
      dataSources: {
        query: vi.fn(),
      },
    };
  });

  it("schema의 dataSourceId를 path param에 매핑해 호출한다", async () => {
    mockNotion.dataSources.query.mockResolvedValue({ results: [], next_cursor: null });
    await queryDataSource(
      mockNotion,
      "decisionLog",
      { page_size: 50 },
      { operation: "test.op" }
    );
    const expectedId = DATABASE_SCHEMAS.decisionLog.dataSourceId;
    expect(mockNotion.dataSources.query).toHaveBeenCalledTimes(1);
    const args = mockNotion.dataSources.query.mock.calls[0][0];
    expect(args.data_source_id).toBe(expectedId);
    expect(args.page_size).toBe(50);
  });

  it("응답 union(Full/Partial 혼합)을 그대로 노출한다 (호출처가 type cast 처리)", async () => {
    const full = makeFullPage("p-full");
    const partial = { object: "page", id: "p-partial" };
    mockNotion.dataSources.query.mockResolvedValue({
      results: [full, partial],
      next_cursor: null,
    });
    const out = await queryDataSource(
      mockNotion,
      "decisionLog",
      {},
      { operation: "test.union" }
    );
    expect(out.results).toHaveLength(2);
    expect(out.results.map((r: any) => r.id).sort()).toEqual(["p-full", "p-partial"]);
  });

  it("request_status.type === 'incomplete' 면 incomplete=true + console.warn 호출", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makeFullPage("p1")],
      next_cursor: null,
      request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    });
    const out = await queryDataSource(
      mockNotion,
      "knowledgeBase",
      {},
      { operation: "test.incomplete" }
    );
    expect(out.incomplete).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("test.incomplete incomplete:"),
      "query_result_limit_reached"
    );
    warnSpy.mockRestore();
  });

  it("request_status가 없거나 complete면 incomplete=false + warn 안 함", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makeFullPage("p1")],
      next_cursor: null,
      request_status: { type: "complete" },
    });
    const out = await queryDataSource(
      mockNotion,
      "projects",
      {},
      { operation: "test.complete" }
    );
    expect(out.incomplete).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("nextCursor를 그대로 노출한다 (pagination preparation)", async () => {
    mockNotion.dataSources.query.mockResolvedValue({
      results: [makeFullPage("p1")],
      next_cursor: "cursor-abc",
    });
    const out = await queryDataSource(
      mockNotion,
      "references",
      {},
      { operation: "test.cursor" }
    );
    expect(out.nextCursor).toBe("cursor-abc");
  });

  it("filter / sorts 인자를 그대로 전달한다", async () => {
    mockNotion.dataSources.query.mockResolvedValue({ results: [], next_cursor: null });
    const filter = { property: "title", title: { contains: "x" } };
    const sorts = [{ property: "date", direction: "ascending" as const }];
    await queryDataSource(
      mockNotion,
      "preferences",
      { filter, sorts },
      { operation: "test.passthrough" }
    );
    const args = mockNotion.dataSources.query.mock.calls[0][0];
    expect(args.filter).toEqual(filter);
    expect(args.sorts).toEqual(sorts);
  });
});
