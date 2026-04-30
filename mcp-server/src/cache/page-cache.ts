// 로컬 페이지 캐시 (P1-1 MVP).
// SQLite FTS5는 다음 단계 — 의존성 없이 시작.
// 사용자가 한 번 본 페이지를 다음 세션에서 즉시 떠올리는 것이 목표.

export interface CachedPage {
  id: string;
  db: string;
  title: string;
  url?: string;
  /** 본문 (block join). 미설정 시 title이 들어감. */
  text: string;
  lastEdited?: string;
  cachedAt: string;
  /** 검색용 lower-case 토큰 셋 */
  tokens: Set<string>;
}

export type PageInput = Omit<CachedPage, "tokens" | "cachedAt"> &
  Partial<Pick<CachedPage, "tokens" | "cachedAt">>;

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "이",
  "그",
  "저",
  "는",
  "은",
  "을",
  "를",
  "의",
  "에",
  "와",
  "과",
]);

export function tokenize(s: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of s
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)) {
    if (raw.length < 2) continue;
    if (STOP.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

export interface SearchResult {
  page: CachedPage;
  score: number;
}

export class PageCache {
  private pages = new Map<string, CachedPage>();

  set(input: PageInput): CachedPage {
    const tokens =
      input.tokens ?? tokenize(`${input.title} ${input.text}`);
    const cached: CachedPage = {
      ...input,
      tokens,
      cachedAt: input.cachedAt ?? new Date().toISOString(),
    };
    this.pages.set(input.id, cached);
    return cached;
  }

  get(id: string): CachedPage | undefined {
    return this.pages.get(id);
  }

  delete(id: string): boolean {
    return this.pages.delete(id);
  }

  size(): number {
    return this.pages.size;
  }

  clear(): void {
    this.pages.clear();
  }

  /**
   * 단순 토큰 매칭 + title 가중치. BM25는 P1-1b.
   * - 본문 토큰 1점, title 부분일치 2점.
   * - 동률은 cachedAt desc.
   */
  search(query: string, limit = 10): SearchResult[] {
    const qTokens = tokenize(query);
    if (qTokens.size === 0) return [];

    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();
    for (const page of this.pages.values()) {
      let score = 0;
      for (const qt of qTokens) {
        if (page.tokens.has(qt)) score += 1;
      }
      if (page.title.toLowerCase().includes(lowerQuery)) score += 3;
      if (score > 0) results.push({ page, score });
    }
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.page.cachedAt.localeCompare(a.page.cachedAt);
    });
    return results.slice(0, limit);
  }

  list(): CachedPage[] {
    return Array.from(this.pages.values());
  }
}

export const defaultPageCache = new PageCache();
