// property-builder가 어휘 가드(field-vocab)를 적용하는지 검증.
// select: 미허용 throw / 별칭 정규화. multi_select: 미등록 drop + 경고 수집.
import { describe, it, expect } from "vitest";
import { buildPropertiesFromSchema } from "../property-builder.js";
import { FieldValidationError } from "../field-vocab.js";
import { createMockNotionClient } from "../../__tests__/helpers/mock-notion.js";

describe("buildPropertiesFromSchema — 어휘 가드", () => {
  const notion = createMockNotionClient();

  it("projects.status 미허용 값이면 FieldValidationError를 throw한다", async () => {
    await expect(
      buildPropertiesFromSchema(
        "projects",
        "P",
        { status: "대충아무거나" },
        notion as any
      )
    ).rejects.toBeInstanceOf(FieldValidationError);
  });

  it("projects.status 별칭(운영중)을 운용중으로 정규화한다", async () => {
    const props = await buildPropertiesFromSchema(
      "projects",
      "P",
      { status: "운영중" },
      notion as any
    );
    expect(props.status.select.name).toBe("운용중");
  });

  it("decisionLog.area 미허용 값이면 throw한다", async () => {
    await expect(
      buildPropertiesFromSchema(
        "decisionLog",
        "D",
        { area: "존재안함zzz" },
        notion as any
      )
    ).rejects.toBeInstanceOf(FieldValidationError);
  });

  it("select default('확정')는 허용목록에 있어 통과한다", async () => {
    const props = await buildPropertiesFromSchema(
      "decisionLog",
      "D",
      {},
      notion as any
    );
    expect(props.status.select.name).toBe("확정");
  });

  it("knowledgeBase.tags 미등록 태그는 drop하고 warnings에 경고를 수집한다", async () => {
    const warnings: string[] = [];
    const props = await buildPropertiesFromSchema(
      "knowledgeBase",
      "K",
      { tags: "iMX93, 절대없는태그zzz, BSP" },
      notion as any,
      { warnings }
    );
    expect(props.tags.multi_select).toEqual([
      { name: "iMX93" },
      { name: "BSP" },
    ]);
    expect(warnings.join(" ")).toContain("절대없는태그zzz");
  });

  it("tech_stack 별칭(gh-cli)을 gh로 정규화한다", async () => {
    const props = await buildPropertiesFromSchema(
      "projects",
      "P",
      { tech_stack: "gh-cli, Python" },
      notion as any
    );
    expect(props.tech_stack.multi_select).toEqual([
      { name: "gh" },
      { name: "Python" },
    ]);
  });

  it("multi_select 값이 전부 미등록이면 필드 자체를 생략한다", async () => {
    const props = await buildPropertiesFromSchema(
      "knowledgeBase",
      "K",
      { tags: "zzz1, zzz2" },
      notion as any
    );
    expect(props.tags).toBeUndefined();
  });
});
