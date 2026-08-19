import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "src",
    include: ["**/*.test.ts"],
    // Nine of these files drive real Git repositories through real subprocesses.
    // The cost is the spawns, not the assertions: the slowest single test spawns
    // git about 650 times, which is roughly 93% of its duration.
    //
    // A spawn does not cost a fixed amount. Its price tracks the CPU clock, and
    // a machine on intel_pstate's powersave governor idles near its minimum, so
    // each spawn costs about 1.8x more when little else is running. Running
    // FEWER of these files is therefore slower, not faster — measured, the same
    // test takes ~1.5s with all 53 files in flight, ~4.9s with only two, and
    // ~6.5s fully serial. The 5s default had already broken outright under
    // --no-file-parallelism, and under the two-file pairing it left under two
    // percent of the budget unspent with three tests inside the failing band,
    // which is why the failure moved between them (#39).
    //
    // Do not "fix" a recurrence by reducing parallelism: maxWorkers=2 and serial
    // execution both measured worse for exactly the reason above. 15s is 2.3x
    // the serial worst case and the tier the heaviest file already assigns
    // itself per test. Tests that deliberately assert promptness override this
    // downward as before.
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
