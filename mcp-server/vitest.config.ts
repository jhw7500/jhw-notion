import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "src",
    include: ["**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/*.test.ts", "__tests__/**"],
    },
  },
});
