import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "src",
    include: ["**/*.test.ts"],
    // *.live.test.ts는 별도 config (vitest.live.config.ts)로 실행
    exclude: ["**/*.live.test.ts", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/*.test.ts", "__tests__/**"],
    },
  },
});
