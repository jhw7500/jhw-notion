/**
 * Notion paragraph 블록 빌더.
 *
 * 한 paragraph block의 rich_text content는 2000자 한도. 호출자(스킬 등)가
 * `\n\n`으로 paragraph를 분리해 두면 여기서 그대로 paragraph block 배열로 변환.
 * 단일 paragraph가 2000자를 초과하면 안전 경계(line break → 마침표 → 강제 슬라이스)로
 * 자동 split.
 */

const MAX_PARAGRAPH_CHARS = 2000;
const SAFE_PARAGRAPH_CHARS = 1900; // 안전 마진

function makeParagraph(text: string) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  };
}

function splitLongParagraph(text: string, maxLen = SAFE_PARAGRAPH_CHARS): string[] {
  const result: string[] = [];
  let buf = text;
  while (buf.length > maxLen) {
    // 우선순위: 줄바꿈 → ". " → "; " → 공백 → 강제 슬라이스
    let cut = buf.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = buf.lastIndexOf(". ", maxLen);
    if (cut < maxLen * 0.5) cut = buf.lastIndexOf("; ", maxLen);
    if (cut < maxLen * 0.5) cut = buf.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    const chunk = buf.slice(0, cut).trim();
    if (chunk) result.push(chunk);
    buf = buf.slice(cut).trim();
  }
  if (buf) result.push(buf);
  return result;
}

/**
 * Markdown 본문을 Notion paragraph block 배열로 변환.
 *
 * @param content 본문 markdown (`\n\n`으로 paragraph 분리)
 * @returns paragraph block 배열. content가 비면 빈 배열.
 */
export function paragraphBlocks(content: string | undefined | null): any[] {
  if (!content || !content.trim()) return [];
  const paragraphs = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const children: any[] = [];
  for (const p of paragraphs) {
    if (p.length <= MAX_PARAGRAPH_CHARS) {
      children.push(makeParagraph(p));
    } else {
      for (const chunk of splitLongParagraph(p)) {
        children.push(makeParagraph(chunk));
      }
    }
  }
  return children;
}
