import { describe, it, expect, beforeEach } from "vitest";
import { createMockNotionClient } from "../../__tests__/helpers/mock-notion.js";
import type { MockNotionClient } from "../../__tests__/helpers/mock-notion.js";
import { applyMultiSelectGuard } from "../multi-select-guard.js";
import { appendMultiSelectOptions } from "../api.js";

let notion: MockNotionClient;

describe("multi_select 옵션 자동 등록 (옵션 B)", () => {
  beforeEach(() => {
    notion = createMockNotionClient();
  });

  describe("appendMultiSelectOptions", () => {
    it("기존 옵션 id·color 보존 + 신규 name만, 대소문자 dedup", async () => {
      notion.dataSources.retrieve.mockResolvedValue({
        properties: {
          tags: {
            type: "multi_select",
            multi_select: {
              options: [{ id: "opt-1", name: "iMX93", color: "blue" }],
            },
          },
        },
      });
      notion.dataSources.update.mockResolvedValue({});

      const result = await appendMultiSelectOptions(
        notion as any,
        "knowledgeBase",
        "tags",
        ["새태그", "imx93"] // imx93은 기존 iMX93과 대소문자만 다름 → dedup
      );

      expect(result).toEqual(["새태그", "iMX93"]); // imx93 입력은 기존 iMX93의 canonical로 보정
      const updateArg = notion.dataSources.update.mock.calls[0][0];
      expect(updateArg.data_source_id).toBeDefined();
      expect(updateArg.properties.tags.multi_select.options).toEqual([
        { id: "opt-1", name: "iMX93", color: "blue" }, // id·color 보존 재전송
        { name: "새태그" }, // 신규만 추가 (imx93은 중복이라 제외)
      ]);
    });

    it("추가할 신규가 없으면 update를 호출하지 않는다", async () => {
      notion.dataSources.retrieve.mockResolvedValue({
        properties: {
          tags: {
            type: "multi_select",
            multi_select: { options: [{ id: "1", name: "iMX93" }] },
          },
        },
      });
      const result = await appendMultiSelectOptions(
        notion as any,
        "knowledgeBase",
        "tags",
        ["iMX93"]
      );
      expect(result).toEqual(["iMX93"]);
      expect(notion.dataSources.update).not.toHaveBeenCalled();
    });

    it("multi_select 필드가 아니면 throw", async () => {
      notion.dataSources.retrieve.mockResolvedValue({
        properties: { tags: { type: "rich_text" } },
      });
      await expect(
        appendMultiSelectOptions(notion as any, "knowledgeBase", "tags", ["x"])
      ).rejects.toThrow("multi_select");
    });
  });

  describe("applyMultiSelectGuard", () => {
    it("allowNew=false: 미등록은 drop + 경고, notion 호출 없음", async () => {
      const warnings: string[] = [];
      const names = await applyMultiSelectGuard(
        notion as any,
        "knowledgeBase",
        "tags",
        ["iMX93", "zzz미등록"],
        { warnings }
      );
      expect(names).toEqual(["iMX93"]);
      expect(warnings.join(" ")).toContain("zzz미등록");
      expect(warnings.join(" ")).toContain("제외");
      expect(notion.dataSources.retrieve).not.toHaveBeenCalled();
    });

    it("allowNew=true: 미등록을 자동 등록 후 포함 + 경고", async () => {
      notion.dataSources.retrieve.mockResolvedValue({
        properties: {
          tags: {
            type: "multi_select",
            multi_select: { options: [{ id: "1", name: "iMX93" }] },
          },
        },
      });
      notion.dataSources.update.mockResolvedValue({});
      const warnings: string[] = [];
      const names = await applyMultiSelectGuard(
        notion as any,
        "knowledgeBase",
        "tags",
        ["iMX93", "zzz미등록"],
        { allowNew: true, warnings }
      );
      expect(names).toEqual(["iMX93", "zzz미등록"]);
      expect(warnings.join(" ")).toContain("자동등록");
      expect(notion.dataSources.update).toHaveBeenCalled();
    });

    it("allowNew=true 자동등록 실패 시 drop으로 폴백(저장은 진행)", async () => {
      notion.dataSources.retrieve.mockRejectedValue(new Error("boom"));
      const warnings: string[] = [];
      const names = await applyMultiSelectGuard(
        notion as any,
        "knowledgeBase",
        "tags",
        ["iMX93", "zzz미등록"],
        { allowNew: true, warnings }
      );
      expect(names).toEqual(["iMX93"]); // 폴백 drop
      expect(warnings.join(" ")).toContain("자동등록 실패");
    });
  });
});
