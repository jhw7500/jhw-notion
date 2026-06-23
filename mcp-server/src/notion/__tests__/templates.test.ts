import { describe, it, expect } from "vitest";
import { buildStartBody, buildCloseRetro, buildKbScaffold, buildScaffold } from "../templates.js";

const headings = (blocks: any[]) =>
  blocks.filter((b) => b.type === "heading_2" || b.type === "heading_3")
    .map((b) => (b.heading_2 ?? b.heading_3).rich_text[0].text.content);

describe("buildStartBody", () => {
  it("목표에 description을 채우고 핵심 섹션을 포함한다", () => {
    const b = buildStartBody({ description: "세션 자동 저장" });
    expect(headings(b)).toEqual(["🎯 목표", "📦 범위 (Scope)", "🚧 제약 / 비범위", "📝 진행 메모 / 결정"]);
    // 목표 단락 = description
    const goalPara = b[1];
    expect(goalPara.paragraph.rich_text[0].text.content).toBe("세션 자동 저장");
    // 범위는 to_do 체크리스트
    expect(b.some((x) => x.type === "to_do")).toBe(true);
  });

  it("stack/repo가 있으면 스택 섹션을 추가한다", () => {
    const b = buildStartBody({ description: "d", stack: "TS", repo: "~/x" });
    expect(headings(b)).toContain("🧱 스택 / 환경");
    const texts = b.filter((x) => x.type === "paragraph").map((x) => x.paragraph.rich_text[0]?.text.content);
    expect(texts).toContain("TS");
    expect(texts).toContain("레포: ~/x");
  });

  it("stack/repo가 없으면 스택 섹션을 생략한다", () => {
    expect(headings(buildStartBody({ description: "d" }))).not.toContain("🧱 스택 / 환경");
  });
});

describe("buildCloseRetro", () => {
  it("divider + 회고 heading으로 시작한다", () => {
    const b = buildCloseRetro({ today: "2026-06-23" });
    expect(b[0].type).toBe("divider");
    expect(b[1].heading_2.rich_text[0].text.content).toBe("🏁 회고 (2026-06-23)");
  });

  it("achievement/lessons가 있을 때만 해당 섹션을 넣는다", () => {
    const b = buildCloseRetro({ today: "d", achievement: "완성", lessons: "교훈" });
    expect(headings(b)).toEqual(["🏁 회고 (d)", "✅ 달성한 것", "💡 배운 점", "🔮 다음 액션 / 후속"]);
    const only = buildCloseRetro({ today: "d", achievement: "완성" });
    expect(headings(only)).toEqual(["🏁 회고 (d)", "✅ 달성한 것", "🔮 다음 액션 / 후속"]);
  });
});

describe("buildKbScaffold", () => {
  const h3labels = (b: any[]) => b.filter((x) => x.type === "heading_3").map((x) => x.heading_3.rich_text[0].text.content);

  it("문제해결 category는 문제/원인/해결 라벨을 쓴다", () => {
    expect(h3labels(buildKbScaffold({ category: "문제해결" }))).toEqual(["문제", "원인", "해결"]);
  });

  it("디버깅/아키텍처도 전용 라벨을 쓴다", () => {
    expect(h3labels(buildKbScaffold({ category: "디버깅" }))).toEqual(["증상", "원인", "조치"]);
    expect(h3labels(buildKbScaffold({ category: "아키텍처" }))).toEqual(["배경", "구조", "트레이드오프"]);
  });

  it("그 외 category와 미지정은 공통 라벨(핵심/근거·맥락)로 fallback", () => {
    expect(h3labels(buildKbScaffold({ category: "기타" }))).toEqual(["핵심", "근거·맥락"]);
    expect(h3labels(buildKbScaffold({}))).toEqual(["핵심", "근거·맥락"]);
  });

  it("summary가 있으면 첫 callout에 채운다", () => {
    const b = buildKbScaffold({ summary: "한 줄 요약" });
    expect(b[0].type).toBe("callout");
    expect(b[0].callout.rich_text[0].text.content).toBe("한 줄 요약");
  });
});

describe("buildScaffold", () => {
  it("projects는 buildStartBody와 동형(목표 heading 포함)", () => {
    const b = buildScaffold("projects", { description: "목표값" });
    expect(b[0].heading_2.rich_text[0].text.content).toBe("🎯 목표");
  });

  it("decisionLog는 결정/근거/대안/영향 섹션", () => {
    const b = buildScaffold("decisionLog", { rationale: "근거값", alternatives: "A, B" });
    const hs = b.filter((x) => x.type === "heading_2").map((x) => x.heading_2.rich_text[0].text.content);
    expect(hs).toEqual(["🎯 결정", "🧭 근거", "🔀 검토한 대안", "📊 영향·결과"]);
    // alternatives 'A, B' → to_do 2개(첫 항목 checked)
    const todos = b.filter((x) => x.type === "to_do");
    expect(todos[0].to_do.checked).toBe(true);
    expect(todos[0].to_do.rich_text[0].text.content).toBe("A");
  });

  it("decisionLog status=폐기는 영향 섹션 헤더를 바꾼다", () => {
    const b = buildScaffold("decisionLog", { status: "폐기" });
    const hs = b.filter((x) => x.type === "heading_2").map((x) => x.heading_2.rich_text[0].text.content);
    expect(hs).toContain("📊 폐기 사유·대체 결정");
  });

  it("knowledgeBase는 buildKbScaffold로 위임", () => {
    expect(buildScaffold("knowledgeBase", { category: "디버깅" })
      .filter((x) => x.type === "heading_3").map((x) => x.heading_3.rich_text[0].text.content))
      .toEqual(["증상", "원인", "조치"]);
  });

  it("references는 url이 있으면 링크 섹션을 생략하고, 없으면 하단에 둔다", () => {
    const withUrl = buildScaffold("references", { summary: "s", url: "http://x" });
    const noUrl = buildScaffold("references", { summary: "s" });
    const hh = (b: any[]) => b.filter((x) => x.type === "heading_2").map((x) => x.heading_2.rich_text[0].text.content);
    expect(hh(withUrl)).not.toContain("🔗 링크");
    expect(hh(noUrl)).toContain("🔗 링크");
    // 링크는 하단 fallback (design §5.5) — heading 중 마지막이어야 함
    expect(hh(noUrl).at(-1)).toBe("🔗 링크");
  });

  it("preferences는 description을 본문 seed로 채운 1섹션", () => {
    const b = buildScaffold("preferences", { description: "규칙" });
    expect(b[0].heading_2.rich_text[0].text.content).toBe("⚙️ 선호 내용");
    expect(b[1].paragraph.rich_text[0].text.content).toBe("규칙");
  });
});
