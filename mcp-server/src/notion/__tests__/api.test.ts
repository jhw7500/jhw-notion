// P0-2 단위 테스트 — withRetry/withTimeout/RateLimiter/NotionError.
import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  withTimeout,
  RateLimiter,
  NotionError,
  isRetryable,
} from "../api.js";

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
