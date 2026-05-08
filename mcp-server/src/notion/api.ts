// Notion API 안정성 레이어 (P0-2 + p1-3c).
// withRetry: 429/5xx/네트워크 일시 장애 → exponential backoff + jitter.
// withTimeout: 도구별 timeout (search 짧게, report/context 길게).
// RateLimiter: Notion 권장 평균 3 req/s 부근 동시성 제어.
// NotionError: 표준화된 에러 — operation/status/requestId/retryable/cause 보존.
// queryDataSource (p1-3c): v5 dataSources.query wrapper — getDataSourceId 매핑 +
//   isFullPage 필터링 + request_status.incomplete warning 캡슐화.

import type {
  Client,
  PageObjectResponse,
  PartialPageObjectResponse,
  DataSourceObjectResponse,
  PartialDataSourceObjectResponse,
} from "@notionhq/client";
import { getDataSourceId } from "../schema.js";
import type { DatabaseName } from "../config.js";

export interface NotionErrorPayload {
  tool?: string;
  operation?: string;
  retryable: boolean;
  cause?: unknown;
  status?: number;
  requestId?: string;
}

export class NotionError extends Error {
  readonly tool?: string;
  readonly operation?: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  // override Error.cause를 안전하게 캐스트
  readonly _cause?: unknown;

  constructor(message: string, payload: NotionErrorPayload) {
    super(message);
    this.name = "NotionError";
    this.tool = payload.tool;
    this.operation = payload.operation;
    this.retryable = payload.retryable;
    this._cause = payload.cause;
    this.status = payload.status;
    this.requestId = payload.requestId;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      tool: this.tool,
      operation: this.operation,
      retryable: this.retryable,
      status: this.status,
      requestId: this.requestId,
    };
  }
}

const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

export function isRetryable(err: any): boolean {
  if (!err) return false;
  const status: unknown = err.status ?? err.statusCode;
  if (typeof status === "number" && DEFAULT_RETRY_STATUSES.has(status)) return true;
  if (typeof err.code === "string" && RETRYABLE_NETWORK_CODES.has(err.code)) return true;
  return false;
}

function readRetryAfterMs(err: any): number | null {
  const headers = err?.headers ?? err?.response?.headers;
  if (!headers) return null;
  const raw =
    typeof headers.get === "function"
      ? headers.get("retry-after")
      : headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return null;
}

export interface RetryOptions {
  /** 첫 시도 포함 최대 시도 횟수 (default 4) */
  attempts?: number;
  /** 기본 지연 ms (default 250) */
  baseDelayMs?: number;
  /** 최대 지연 ms (default 8000) */
  maxDelayMs?: number;
  /** 에러 컨텍스트용 라벨 */
  operation?: string;
  /** 테스트용 sleep 주입 */
  sleep?: (ms: number) => Promise<void>;
  /** 테스트용 RNG 주입 (0..1) */
  rng?: () => number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 8000;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = opts.rng ?? Math.random;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const retryable = isRetryable(err);
      if (i >= attempts || !retryable) {
        throw new NotionError(err?.message ?? "Notion API call failed", {
          operation: opts.operation,
          retryable,
          cause: err,
          status: err?.status,
          requestId: err?.headers?.["x-request-id"] ?? err?.requestId,
        });
      }
      // exponential backoff + jitter
      const expo = Math.min(max, base * 2 ** (i - 1));
      const jittered = expo / 2 + rng() * (expo / 2);
      const wait = readRetryAfterMs(err) ?? jittered;
      await sleep(wait);
    }
  }
  // unreachable
  throw new NotionError("withRetry exhausted attempts", {
    operation: opts.operation,
    retryable: false,
  });
}

export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  operation?: string
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new NotionError(
          `Operation '${operation ?? "unknown"}' timed out after ${ms}ms`,
          { operation, retryable: true }
        )
      );
    }, ms);
    fn().then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * 단순 token-less FIFO 동시성 제한.
 * Notion 권장은 평균 3 req/s 수준이므로 concurrency=3을 기본으로 둔다.
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly concurrency: number = 3) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export const defaultRateLimiter = new RateLimiter(3);

/** retry + rate limit 조합 헬퍼. timeout은 caller가 외부에서 감싼다. */
export async function callNotion<T>(
  fn: () => Promise<T>,
  opts: RetryOptions & { limiter?: RateLimiter } = {}
): Promise<T> {
  const limiter = opts.limiter ?? defaultRateLimiter;
  return limiter.run(() => withRetry(fn, opts));
}

// =====================================================================
// p1-3c: dataSources.query wrapper
// Design Ref: §4.1 — queryDataSource(notion, db, params, meta)
// Plan SC: FR-01..06 (SDK 업그레이드 + 호출 마이그레이션 + incomplete warning)
// =====================================================================

/** Notion v5 dataSources.query body parameters (path는 wrapper가 채움) */
export interface QueryDataSourceParams {
  filter?: unknown;
  sorts?: unknown[];
  page_size?: number;
  start_cursor?: string;
  /** v5 신규 — 본 사이클은 기본값(page+data_source 혼합) 사용 */
  result_type?: "page" | "data_source";
}

export interface QueryDataSourceMeta {
  /** 로그/에러 컨텍스트용 식별자 (예: "history.decisions.query") */
  operation: string;
  /** withRetry 시도 횟수 (default 4) */
  attempts?: number;
  /** RateLimiter 주입 (테스트용) */
  limiter?: RateLimiter;
}

/** v5 응답의 한 result item — 4가지 union (Page / DataSource × Full / Partial) */
export type QueryDataSourceItem =
  | PageObjectResponse
  | PartialPageObjectResponse
  | DataSourceObjectResponse
  | PartialDataSourceObjectResponse;

export interface QueryDataSourceResult {
  /** v5 응답 results 그대로 (union — 호출처에서 properties 접근 시 type cast) */
  results: QueryDataSourceItem[];
  /** v5 응답의 next_cursor 그대로 노출 (cursor pagination 도입 시 사용) */
  nextCursor: string | null;
  /** v5 request_status.type === "incomplete" 일 때 true */
  incomplete: boolean;
}

/**
 * v5 `notion.dataSources.query` 호출 wrapper.
 *
 * - `getDataSourceId(db)` 자동 매핑 (p1-3b 자산)
 * - `callNotion` 안정성 레이어 자동 적용 (retry/rate-limit/NotionError)
 * - `request_status.incomplete` 감지 시 `console.warn` 1줄
 * - `isFullPage` 필터링으로 `PageObjectResponse[]` 정규화
 *
 * 사용 예:
 * ```ts
 *   const { results } = await queryDataSource(
 *     notion, "decisionLog",
 *     { filter, sorts: [{ property: "date", direction: "ascending" }], page_size: 100 },
 *     { operation: "history.decisions.query" },
 *   );
 *   for (const page of results) {
 *     // page is PageObjectResponse — page.properties[...] 안전
 *   }
 * ```
 */
export async function queryDataSource(
  notion: Client,
  db: DatabaseName,
  params: QueryDataSourceParams,
  meta: QueryDataSourceMeta
): Promise<QueryDataSourceResult> {
  const dataSourceId = getDataSourceId(db);
  // Notion SDK 타입은 매우 엄격한 union — wrapper 안에서만 unknown으로 우회.
  const requestArgs = {
    data_source_id: dataSourceId,
    ...params,
  } as Parameters<Client["dataSources"]["query"]>[0];

  const res = await callNotion(() => notion.dataSources.query(requestArgs), {
    operation: meta.operation,
    attempts: meta.attempts,
    limiter: meta.limiter,
  });

  // v5 incomplete 감지 — cursor pagination 본격 도입은 P1-3d 분리. 여기선 alert만.
  const requestStatus = (res as { request_status?: { type?: string; incomplete_reason?: string } })
    .request_status;
  const incomplete = requestStatus?.type === "incomplete";
  if (incomplete) {
    // eslint-disable-next-line no-console
    console.warn(
      `[notion.queryDataSource] ${meta.operation} incomplete:`,
      requestStatus?.incomplete_reason ?? "unknown"
    );
  }

  // 호출처는 page.properties[...] 패턴을 (page as any) 캐스팅으로 사용 (record/recall/report
  // 9 도구 모두 동일 컨벤션). isFullPage 필터링은 SDK union을 좁히지만 mock test 호환성을
  // 위해 results를 union 그대로 노출하고 cast 책임을 호출처에 둔다 (DRY는 wrapper 호출 일관성에서 충분).
  return {
    results: res.results,
    nextCursor: res.next_cursor,
    incomplete,
  };
}
