/**
 * DB/경로별 본문 양식 함수. blocks.ts 저수준 빌더 + paragraphBlocks를 조합한
 * 순수함수(IO 없음). 반환 배열을 notion.pages.create({children}) /
 * blocks.children.append({children})에 그대로 전달한다.
 */
import { h2, h3, para, hint, todo, callout, divider, paragraphBlocks } from "./blocks.js";
import type { DatabaseName } from "../config.js";

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

const KB_DETAIL_LABELS: Record<string, string[]> = {
  "문제해결": ["문제", "원인", "해결"],
  "디버깅": ["증상", "원인", "조치"],
  "아키텍처": ["배경", "구조", "트레이드오프"],
};

function kbDetailLabels(category?: string): string[] {
  return (category && KB_DETAIL_LABELS[category]) || ["핵심", "근거·맥락"];
}

export function buildKbScaffold(input: { summary?: string; category?: string }): any[] {
  const { summary, category } = input;
  const blocks: any[] = [
    callout("💡", summary || "한 줄로 핵심을 적으세요 (테이블 summary와 동일 역할)"),
    h2("상세", "📖"),
  ];
  for (const label of kbDetailLabels(category)) {
    blocks.push(h3(label), hint("(작업하며 작성)"));
  }
  blocks.push(
    h2("액션·후속", "✅"),
    todo("(필요 시) 후속 작업 / 검증 항목"),
    h2("관련", "🔗"),
    hint("(관련 자료 URL / 페이지 멘션)"),
  );
  return blocks;
}

function altBlocks(alternatives?: string): any[] {
  const items = (alternatives || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (items.length) return items.map((a, i) => todo(a, i === 0)); // 첫 항목 = 채택 가정
  return [todo("대안 A — 왜 선택하지 않았는지"), todo("대안 B — 비교 포인트")];
}

export function buildScaffold(db: DatabaseName, props: any = {}): any[] {
  const fillOr = (val: string | undefined, hintText: string) =>
    val && val.trim() ? para(val) : callout("💡", hintText);

  switch (db) {
    case "projects":
      return buildStartBody({ description: props.description ?? "", stack: props.stack, repo: props.repo });

    case "decisionLog":
      return [
        h2("결정", "🎯"),
        props.description ? para(props.description) : hint("(무엇을 확정했는지 한 문장으로 — 제목을 풀어서)"),
        h2("근거", "🧭"),
        fillOr(props.rationale, "이 결정의 배경·전제·트레이드오프 — 무엇을 우선했고 무엇을 포기했는지 (props rationale은 한 줄 요약)"),
        h2("검토한 대안", "🔀"),
        ...altBlocks(props.alternatives),
        h2(props.status === "폐기" ? "폐기 사유·대체 결정" : "영향·결과", "📊"),
        ...(props.impact ? [todo(`🏆 ${props.impact}`, true)] : []),
        todo("영향 받는 영역: (작업하며 작성)"),
        todo("후속 확인/롤백 조건: (작업하며 작성)"),
      ];

    case "knowledgeBase":
      return buildKbScaffold({ summary: props.summary, category: props.category });

    case "references":
      return [
        h2("핵심 요약", "📄"),
        fillOr(props.summary, "이 자료가 무엇인지 1~2줄"),
        h2("왜 중요한가 / 발췌", "💬"),
        callout("💡", "저장 이유 + 핵심 인용·발췌. 나중에 이 자료를 다시 찾을 이유가 한눈에 보이게."),
        // 링크는 url props가 없을 때만 하단 fallback (design §5.5 — url은 properties가 SSOT)
        ...(props.url ? [] : [h2("링크", "🔗"), hint("(링크: 작업하며 붙여넣기)")]),
      ];

    case "preferences":
      // content는 RecordInput.properties에 없어(최상위 필드) props로 들어오지 않음 — description만 본문 seed.
      return [h2("선호 내용", "⚙️"), fillOr(props.description, "AI 사용 선호/피드백")];

    default:
      return [];
  }
}
