// Notion API 안정성 레이어 (P0-2).
// withRetry: 429/5xx/네트워크 일시 장애 → exponential backoff + jitter.
// withTimeout: 도구별 timeout (search 짧게, report/context 길게).
// RateLimiter: Notion 권장 평균 3 req/s 부근 동시성 제어.
// NotionError: 표준화된 에러 — operation/status/requestId/retryable/cause 보존.

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
