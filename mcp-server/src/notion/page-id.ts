const COMPACT_UUID = "[0-9a-f]{32}";
const DASHED_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXACT_UUID_RE = new RegExp(`^(?:${COMPACT_UUID}|${DASHED_UUID})$`, "i");
const UUID_SUFFIX_RE = new RegExp(`(${COMPACT_UUID}|${DASHED_UUID})$`, "i");

function formatUuid(value: string): string {
  const compact = value.replace(/-/g, "").toLowerCase();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

/** Notion 페이지 URL 또는 UUID를 API가 받는 dashed UUID로 정규화한다. */
export function normalizePageId(input: string): string {
  const value = String(input).trim();

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("유효한 Notion 페이지 URL 또는 UUID가 필요합니다.");
    }

    // 데이터베이스/peek URL은 경로의 DB ID와 별도로 실제 페이지를 p=에 담는다.
    const queryPageId = url.searchParams.get("p")?.trim();
    if (queryPageId && EXACT_UUID_RE.test(queryPageId)) {
      return formatUuid(queryPageId);
    }

    const lastSegment = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const pathMatch = lastSegment.match(UUID_SUFFIX_RE);
    if (pathMatch) {
      return formatUuid(pathMatch[1]);
    }
  } else if (EXACT_UUID_RE.test(value)) {
    return formatUuid(value);
  }

  throw new Error("유효한 Notion 페이지 URL 또는 UUID가 필요합니다.");
}
