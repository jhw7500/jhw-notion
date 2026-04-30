// 보고서 미리보기용 메모리 캐시 (P0-3).
// 기본 TTL 5분. 동일 (period, reports, dbs) 조합의 재조회를 방지.
// MCP 서버 생존 중에만 유효. 파일 캐시는 P1.

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class ReportCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  constructor(private readonly ttlMs: number = 5 * 60 * 1000) {}

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
