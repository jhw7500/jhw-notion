const UUID_RE =
  /([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Notion 페이지 URL 또는 UUID를 API가 받는 dashed UUID로 정규화한다. */
export function normalizePageId(input: string): string {
  const match = String(input).trim().match(UUID_RE);
  if (!match) {
    throw new Error("유효한 Notion 페이지 URL 또는 UUID가 필요합니다.");
  }

  const compact = match[0].replace(/-/g, "").toLowerCase();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}
