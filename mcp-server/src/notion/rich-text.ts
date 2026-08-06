/**
 * Notion rich_text **property** 값 가드.
 *
 * rich_text 객체 하나의 content는 2000자 한도다. paragraph 블록은 blocks.ts가
 * 여러 블록으로 자동 split하지만, property(summary/description/rationale 등)는
 * 쪼갠다고 의미가 살아나지 않는다 — "한 줄 요약"이 열 줄이 될 뿐이다.
 * 그래서 여기서는 분할 대신 잘라내고 경고를 남긴다.
 *
 * 실제 사고 사례: 호출부가 `content`(본문)를 `summary`에 실어 보내면 Notion API가
 * `properties.summary.rich_text[0].text.content.length should be ≤ 2000`로 거절하는데,
 * 이 메시지만으로는 "summary가 길다"로 읽혀 원인(본문 혼입)을 찾기 어렵다.
 * 경고 문구에 그 가능성을 명시해 진단을 짧게 만든다.
 */

export const MAX_RICH_TEXT_CHARS = 2000;

const ELLIPSIS = "…";

/**
 * rich_text property 값이 한도를 넘으면 잘라내고 warnings에 사유를 push한다.
 * 한도 이하면 원본 그대로 반환(무해).
 */
export function clampRichText(
  value: string,
  field: string,
  warnings?: string[]
): string {
  if (value.length <= MAX_RICH_TEXT_CHARS) return value;

  const clamped =
    value.slice(0, MAX_RICH_TEXT_CHARS - ELLIPSIS.length) + ELLIPSIS;
  warnings?.push(
    `${field}: ${value.length}자 → ${MAX_RICH_TEXT_CHARS}자로 잘림 ` +
      `(Notion rich_text property 한도). 본문(content)이 ${field}에 섞여 들어가지 않았는지 확인.`
  );
  return clamped;
}
