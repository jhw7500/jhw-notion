import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "src",
    include: ["**/*.test.ts"],
    // Nine of these files drive real Git repositories through real subprocesses,
    // and the cost is dominated by process spawns rather than by anything the
    // test computes. Running two such files at once — the default, since files
    // are distributed across workers — put the slowest of them at 4.0-4.9s
    // against Vitest's 5s default, with three tests inside that band. That is
    // not a slow test to speed up; it is a budget with no room, and it failed
    // whichever of the three happened to be running (#39). The heaviest file
    // already opts out per test at 15s and above, so the default matches its
    // lowest tier. Tests that deliberately assert promptness keep overriding
    // this downward.
    testTimeout: 15_000,
    // *.live.test.ts는 별도 config (vitest.live.config.ts)로 실행
    exclude: ["**/*.live.test.ts", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/*.test.ts", "__tests__/**"],
    },
  },
});
