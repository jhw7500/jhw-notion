import { describe, it, expect } from "vitest";
import { buildStartBody, buildCloseRetro } from "../templates.js";

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
