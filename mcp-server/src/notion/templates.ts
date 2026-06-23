/**
 * DB/경로별 본문 양식 함수. blocks.ts 저수준 빌더 + paragraphBlocks를 조합한
 * 순수함수(IO 없음). 반환 배열을 notion.pages.create({children}) /
 * blocks.children.append({children})에 그대로 전달한다.
 */
import { h2, h3, para, hint, todo, callout, divider, paragraphBlocks } from "./blocks.js";

export function buildStartBody(input: { description: string; stack?: string; repo?: string }): any[] {
  const { description, stack, repo } = input;
  const blocks: any[] = [
    h2("목표", "🎯"),
    ...(description ? paragraphBlocks(description) : [hint("(작업하며 작성)")]),
    h2("범위 (Scope)", "📦"),
    todo("(이 프로젝트에서 할 것 — 작업하며 채우기)"),
    todo("(포함 범위 항목)"),
    todo("(포함 범위 항목)"),
    h2("제약 / 비범위", "🚧"),
    callout("💡", "제약(기술/일정/리소스)·하지 않을 것을 적어두면 범위 크리프를 막습니다. (작업하며 작성)"),
  ];
  if (stack || repo) {
    blocks.push(h2("스택 / 환경", "🧱"));
    if (stack) blocks.push(para(stack));
    if (repo) blocks.push(para(`레포: ${repo}`));
  }
  blocks.push(
    h2("진행 메모 / 결정", "📝"),
    callout("💡", "진행하며 떠오른 메모·중간 결정을 시간순으로. 중요 결정은 Decision Log, 재사용 지식은 Knowledge Base로 별도 저장됩니다."),
    para(""),
  );
  return blocks;
}

export function buildCloseRetro(input: { today: string; achievement?: string; lessons?: string }): any[] {
  const { today, achievement, lessons } = input;
  const blocks: any[] = [divider(), h2(`회고 (${today})`, "🏁")];
  if (achievement) blocks.push(h3("달성한 것", "✅"), ...paragraphBlocks(achievement));
  if (lessons) blocks.push(h3("배운 점", "💡"), ...paragraphBlocks(lessons));
  blocks.push(h3("다음 액션 / 후속", "🔮"), callout("💡", "이어서 할 일·미해결 이슈가 있으면 적어두세요. (없으면 비워둠)"));
  return blocks;
}
