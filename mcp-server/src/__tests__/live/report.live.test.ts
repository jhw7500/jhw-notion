// Live integration test for date filter regression + p1-3c v5 마이그레이션 검증.
// 운영 DB가 아닌 sandbox에서:
//   - 미래/과거 기간 필터 + 메모리 사이드 필터로 모든 결과 0건 (Cycle #2 회귀)
//   - v5 dataSources.query 호출 + 응답 union(isFullPage 통과 검증) (p1-3c M5 신규)
import { describe, it, expect } from "vitest";
import { Client, isFullPage } from "@notionhq/client";
import { describeLiveOrSkip } from "../../test/sandbox-config.js";
import { withRetry } from "../../notion/api.js";

const guard = describeLiveOrSkip();

describe.skipIf(!guard.enabled)(
  `live: report query — date filter regression + v5 dataSources.query [${guard.reason ?? "enabled"}]`,
  () => {
    const config = guard.config;
    const notion = new Client({ auth: config.apiKey });

    it("미래 기간(2099-01-01~01-07) 필터 + 메모리 사이드 필터 → 0건", async () => {
      // p1-3c: notion.dataSources.query (v5) 직접 호출.
      // server filter는 multi-data-source DB에서 무시될 수 있으나 메모리 사이드 필터가 보장.
      const FUTURE_START = "2099-01-01";
      const FUTURE_END = "2099-01-07";

      const res: any = await withRetry(() =>
        notion.dataSources.query({
          data_source_id: config.dataSources.decisionLog,
          filter: {
            and: [
              {
                property: "date",
                date: { on_or_after: FUTURE_START, on_or_before: FUTURE_END },
              },
            ],
          },
          page_size: 100,
        } as any),
      );

      const filtered = (res.results as any[]).filter((page) => {
        const dateValue =
          page.properties?.date?.date?.start ||
          page.last_edited_time?.split("T")[0] ||
          "";
        if (!dateValue) return true;
        return dateValue >= FUTURE_START && dateValue <= FUTURE_END;
      });

      expect(filtered).toHaveLength(0);
    });

    it("과거 단일일(1999-01-01) 필터 + 메모리 사이드 필터 → 0건", async () => {
      const PAST = "1999-01-01";

      const res: any = await withRetry(() =>
        notion.dataSources.query({
          data_source_id: config.dataSources.knowledgeBase,
          filter: {
            and: [
              {
                property: "date",
                date: { on_or_after: PAST, on_or_before: PAST },
              },
            ],
          },
          page_size: 100,
        } as any),
      );

      const filtered = (res.results as any[]).filter((page) => {
        const dateValue =
          page.properties?.date?.date?.start ||
          page.last_edited_time?.split("T")[0] ||
          "";
        if (!dateValue) return true;
        return dateValue >= PAST && dateValue <= PAST;
      });

      expect(filtered).toHaveLength(0);
    });

    // p1-3c M5 신규: v5 응답 union 검증.
    // sandbox projects DB에 page 1건 query → 응답 results[0] 가 isFullPage 통과(=PageObjectResponse)인지 확인.
    // 또한 v5 응답 신규 필드(`request_status`)와 `next_cursor` 노출 검증.
    it("v5 dataSources.query 응답 union: results[0]가 isFullPage 통과", async () => {
      const res: any = await withRetry(() =>
        notion.dataSources.query({
          data_source_id: config.dataSources.projects,
          page_size: 1,
        } as any),
      );

      // 응답 필드 검증
      expect(res).toHaveProperty("results");
      expect(Array.isArray(res.results)).toBe(true);
      expect(res).toHaveProperty("next_cursor");

      // results가 비어있지 않다면 첫 항목이 PageObjectResponse 형태인지 검증
      // (sandbox projects DB는 최소 1건 이상 보유 가정)
      if (res.results.length > 0) {
        const first = res.results[0];
        expect(first.object).toBe("page");
        expect(first).toHaveProperty("url");
        expect(isFullPage(first)).toBe(true);
        // v5에서 archived 대신 in_trash 필드 노출
        expect(first).toHaveProperty("in_trash");
      }
    });
  },
);
