// Live integration test for date filter regression (2026-05-08).
// 운영 DB가 아닌 sandbox에서 미래 기간 입력 시
// 메모리 사이드 필터가 모든 결과를 정확히 제거하는지 검증한다.
import { describe, it, expect } from "vitest";
import { Client } from "@notionhq/client";
import { describeLiveOrSkip } from "../../test/sandbox-config.js";
import { withRetry } from "../../notion/api.js";

const guard = describeLiveOrSkip();

describe.skipIf(!guard.enabled)(
  `live: report query — date filter regression [${guard.reason ?? "enabled"}]`,
  () => {
    const config = guard.config;
    const notion = new Client({ auth: config.apiKey });

    it("미래 기간(2099-01-01~01-07) 필터 + 메모리 사이드 필터 → 0건", async () => {
      // server filter는 multi-data-source DB에서 무시될 수 있으나,
      // 메모리 사이드 필터(query.ts:113-122)가 모든 결과를 거른다.
      const FUTURE_START = "2099-01-01";
      const FUTURE_END = "2099-01-07";

      const res: any = await withRetry(() =>
        notion.databases.query({
          database_id: config.databases.decisionLog,
          filter: {
            and: [
              {
                property: "date",
                date: { on_or_after: FUTURE_START, on_or_before: FUTURE_END },
              },
            ],
          },
          page_size: 100,
        }),
      );

      // production 코드의 메모리 사이드 필터와 동일한 로직을 직접 적용해 검증
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
        notion.databases.query({
          database_id: config.databases.knowledgeBase,
          filter: {
            and: [
              {
                property: "date",
                date: { on_or_after: PAST, on_or_before: PAST },
              },
            ],
          },
          page_size: 100,
        }),
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
  },
);
