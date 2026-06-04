// 분류 필드 어휘 가드 단위 테스트.
// 정책:
//  - 단일 select: 별칭 정규화 → 허용목록에 있으면 사용, 없으면 FieldValidationError throw.
//  - 다중 multi_select: 별칭+중복제거 → 허용은 유지, 미허용은 drop(에러 없음).
import { describe, it, expect } from "vitest";
import {
  normalizeSelectValue,
  normalizeMultiSelectValues,
  FieldValidationError,
  getFieldVocab,
} from "../field-vocab.js";

describe("normalizeSelectValue", () => {
  it("허용 옵션은 그대로 통과한다", () => {
    expect(normalizeSelectValue("projects", "status", "진행중")).toBe("진행중");
  });

  it("앞뒤 공백을 정리한다", () => {
    expect(normalizeSelectValue("projects", "status", "  완료 ")).toBe("완료");
  });

  it("별칭(운영중)을 표준값(운용중)으로 정규화한다", () => {
    expect(normalizeSelectValue("projects", "status", "운영중")).toBe("운용중");
  });

  it("decisionLog status의 PR 문장 별칭을 '확정'으로 정규화한다", () => {
    expect(
      normalizeSelectValue(
        "decisionLog",
        "status",
        "확정 (PR #43 머지 → 1ca1b86)"
      )
    ).toBe("확정");
  });

  it("미허용 값이면 FieldValidationError를 throw한다", () => {
    expect(() => normalizeSelectValue("projects", "status", "달성씀")).toThrow(
      FieldValidationError
    );
  });

  it("throw 메시지에 db.field와 허용목록이 포함된다", () => {
    try {
      normalizeSelectValue("projects", "status", "아무거나");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FieldValidationError);
      const err = e as FieldValidationError;
      expect(err.message).toContain("projects.status");
      expect(err.message).toContain("진행중");
      expect(err.field).toBe("status");
      expect(err.value).toBe("아무거나");
    }
  });

  it("vocab이 정의되지 않은 필드는 trim만 하고 통과시킨다", () => {
    // report는 별도(zod REPORT_VALUES)로 가드되므로 field-vocab에 없음
    expect(normalizeSelectValue("projects", "report", " wlan-test ")).toBe(
      "wlan-test"
    );
  });

  it("area의 별칭(tooling)을 표준값(도구/플러그인)으로 정규화한다", () => {
    expect(normalizeSelectValue("decisionLog", "area", "tooling")).toBe(
      "도구/플러그인"
    );
  });
});

describe("normalizeMultiSelectValues", () => {
  it("허용 태그는 유지, 미허용 태그는 drop한다", () => {
    const { kept, dropped } = normalizeMultiSelectValues(
      "knowledgeBase",
      "tags",
      ["iMX93", "절대없는태그zzz", "BSP"]
    );
    expect(kept).toContain("iMX93");
    expect(kept).toContain("BSP");
    expect(kept).not.toContain("절대없는태그zzz");
    expect(dropped).toEqual(["절대없는태그zzz"]);
  });

  it("중복 값은 제거한다", () => {
    const { kept } = normalizeMultiSelectValues("knowledgeBase", "tags", [
      "iMX93",
      " iMX93 ",
    ]);
    expect(kept).toEqual(["iMX93"]);
  });

  it("tech_stack 별칭(gh-cli)을 표준값(gh)으로 정규화한다", () => {
    const { kept } = normalizeMultiSelectValues("projects", "tech_stack", [
      "gh-cli",
    ]);
    expect(kept).toEqual(["gh"]);
  });

  it("빈 문자열은 건너뛴다", () => {
    const { kept, dropped } = normalizeMultiSelectValues(
      "projects",
      "tech_stack",
      ["Python", "", "  "]
    );
    expect(kept).toEqual(["Python"]);
    expect(dropped).toEqual([]);
  });

  it("references tool의 특정 스크립트는 미허용으로 drop된다", () => {
    const { kept, dropped } = normalizeMultiSelectValues("references", "tool", [
      "bash",
      "diag-9098-11ax.sh",
    ]);
    expect(kept).toEqual(["bash"]);
    expect(dropped).toEqual(["diag-9098-11ax.sh"]);
  });
});

describe("getFieldVocab", () => {
  it("가드되는 필드는 vocab을 반환한다", () => {
    expect(getFieldVocab("projects", "status")).toBeDefined();
    expect(getFieldVocab("knowledgeBase", "tags")).toBeDefined();
  });

  it("가드되지 않는 필드는 undefined를 반환한다", () => {
    expect(getFieldVocab("projects", "report")).toBeUndefined();
    expect(getFieldVocab("projects", "repo")).toBeUndefined();
  });
});
