import { describe, it, expect } from "vitest";
import { sortProjectsByExact } from "../resolve-project.js";

describe("sortProjectsByExact", () => {
  const page = (id: string, segments: string[]) => ({
    id,
    properties: { title: { title: segments.map((s) => ({ plain_text: s })) } },
  });

  it("정확 일치 페이지를 부분일치보다 앞에 둔다", () => {
    const results = [page("p2", ["jhw-notion-v2"]), page("p1", ["jhw-notion"])];
    expect(sortProjectsByExact(results, "jhw-notion")[0].id).toBe("p1");
  });

  it("여러 rich_text 세그먼트로 나뉜 제목도 전체를 합쳐 정확 매칭한다 (리뷰 피드백)", () => {
    // 스타일/멘션으로 'jhw-notion'이 ['jhw-', 'notion'] 두 세그먼트로 분할된 경우.
    // [0]만 보면 'jhw-'가 되어 매칭 실패 → join으로 전체 제목 복원해야 함.
    const results = [page("p2", ["jhw-notion-v2"]), page("p1", ["jhw-", "notion"])];
    expect(sortProjectsByExact(results, "jhw-notion")[0].id).toBe("p1");
  });

  it("대소문자를 무시하고 정확 일치를 우선한다", () => {
    const results = [page("p2", ["JHW-Notion-X"]), page("p1", ["JHW-Notion"])];
    expect(sortProjectsByExact(results, "jhw-notion")[0].id).toBe("p1");
  });

  it("입력 배열을 변형하지 않는다 (순수 함수)", () => {
    const results = [page("p1", ["a"]), page("p2", ["b"])];
    const snapshot = [...results];
    sortProjectsByExact(results, "b");
    expect(results).toEqual(snapshot);
  });

  it("properties가 없거나 title이 비어도 throw하지 않는다", () => {
    const results = [{ id: "x" } as any, page("p1", ["only"])];
    expect(() => sortProjectsByExact(results, "only")).not.toThrow();
    expect(sortProjectsByExact(results, "only")[0].id).toBe("p1");
  });
});
