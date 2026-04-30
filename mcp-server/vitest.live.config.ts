import { defineConfig } from "vitest/config";

// Live integration tests (P2).
// 실행: RUN_LIVE_NOTION_TESTS=1 npm run test:live
// 운영 Notion DB와 분리된 sandbox DB만 건드린다.
// 기본 mock 테스트는 vitest.config.ts에서 처리하고, 여기서는 *.live.test.ts만.
export default defineConfig({
  test: {
    root: "src",
    include: ["**/*.live.test.ts"],
    // live test는 실제 API 호출이라 동시 실행 시 rate limit/충돌 위험.
    // 직렬 실행으로 안전하게.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
