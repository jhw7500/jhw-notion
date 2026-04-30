// Live integration test 샘플 (P2).
// RUN_LIVE_NOTION_TESTS=1 + NOTION_API_KEY + NOTION_SANDBOX_DB_* 모두 있을 때만 실행.
// 운영 DB가 아닌 sandbox에 실제로 record를 만들고, 작성된 페이지를 archive로 정리.
import { describe, it, expect } from "vitest";
import { Client } from "@notionhq/client";
import { describeLiveOrSkip } from "../../test/sandbox-config.js";
import { withRetry } from "../../notion/api.js";

const guard = describeLiveOrSkip();

describe.skipIf(!guard.enabled)(
  `live: record → sandbox decisionLog [${guard.reason ?? "enabled"}]`,
  () => {
    const config = guard.config;
    const notion = new Client({ auth: config.apiKey });

    it("decisionLog에 페이지 생성 + 조회 + archive 가능해야 한다", async () => {
      const today = new Date().toISOString().split("T")[0];
      const title = `[live test] ${new Date().toISOString()}`;

      // 1. 생성
      const created: any = await withRetry(() =>
        notion.pages.create({
          parent: { database_id: config.databases.decisionLog },
          properties: {
            title: { title: [{ text: { content: title } }] },
            status: { select: { name: "확정" } },
            rationale: { rich_text: [{ text: { content: "live test 검증" } }] },
            date: { date: { start: today } },
            report: { select: { name: "etc" } },
          },
        }),
      );
      expect(created.id).toBeTruthy();

      try {
        // 2. 조회로 존재 검증
        const fetched: any = await withRetry(() =>
          notion.pages.retrieve({ page_id: created.id }),
        );
        expect(fetched.properties.title.title[0].plain_text).toBe(title);
        expect(fetched.properties.status.select.name).toBe("확정");
      } finally {
        // 3. 정리 — archive (실패해도 sandbox라 OK)
        await withRetry(() =>
          notion.pages.update({ page_id: created.id, archived: true }),
        ).catch(() => undefined);
      }
    });

    it("preferences (relation 없는 DB)에도 record 가능해야 한다", async () => {
      const created: any = await withRetry(() =>
        notion.pages.create({
          parent: { database_id: config.databases.preferences },
          properties: {
            title: { title: [{ text: { content: `[live test pref] ${Date.now()}` } }] },
            category: { select: { name: "AI 사용" } },
            content: { rich_text: [{ text: { content: "live preferences test" } }] },
            priority: { select: { name: "중간" } },
            report: { select: { name: "etc" } },
          },
        }),
      );
      expect(created.id).toBeTruthy();
      await withRetry(() =>
        notion.pages.update({ page_id: created.id, archived: true }),
      ).catch(() => undefined);
    });
  },
);

// 가드만 단독으로 한 번 더 — 환경 미설정 시 skip 메시지를 보여주기 위함
describe("live test guard", () => {
  it(`enabled=${guard.enabled}${guard.reason ? ` (${guard.reason})` : ""}`, () => {
    expect(typeof guard.enabled).toBe("boolean");
  });
});
