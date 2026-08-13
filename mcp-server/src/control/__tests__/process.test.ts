import { describe, expect, it } from "vitest";

import { loadControlConfig } from "../config.js";
import { ProcessRunner } from "../process.js";

describe("control process boundary", () => {
  it("never includes secret environment values in a failed command", async () => {
    const runner = new ProcessRunner({ GH_PROJECT_TOKEN: "secret-project-token" });
    const error = await runner
      .run("bash", ["-c", "echo \"$GH_PROJECT_TOKEN\" >&2; exit 2"])
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "COMMAND_FAILED" });
    expect(JSON.stringify(error)).not.toContain("secret-project-token");
  });

  it("requires build-server coordinates but not tokens in config files", () => {
    const config = loadControlConfig({
      HOME: "/home/jhw",
      JHW_REGISTRY_DIR: "/srv/jhw/project-registry",
      JHW_WORKTREE_ROOT: "/srv/jhw/worktrees",
      JHW_BUILD_HOST: "cantopsbuildserver",
      JHW_GITHUB_OWNER: "jhw7500",
      JHW_PROJECT_NUMBER: "7",
    });

    expect(config.registryBranch).toBe("main");
    expect(JSON.stringify(config)).not.toContain("TOKEN");
  });

  it("rejects incomplete build-server coordinates", () => {
    let error: unknown;
    try {
      loadControlConfig({ HOME: "/home/jhw" });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("captures successful command output and its exit code", async () => {
    const result = await new ProcessRunner({}).run("bash", ["-c", "printf output"]);

    expect(result).toMatchObject({
      command: "bash",
      args: ["-c", "printf output"],
      stdout: "output",
      stderr: "",
      exitCode: 0,
    });
  });

  it("re-execs under flock without terminating an injected test runtime", async () => {
    const { reexecUnderMutationLock } = await import("../process.js");
    const config = loadControlConfig({
      HOME: "/home/jhw",
      JHW_REGISTRY_DIR: "/srv/jhw/project-registry",
      JHW_WORKTREE_ROOT: "/srv/jhw/worktrees",
      JHW_BUILD_HOST: "cantopsbuildserver",
      JHW_GITHUB_OWNER: "jhw7500",
      JHW_PROJECT_NUMBER: "7",
      JHW_CONTROL_STATE_DIR: "/srv/jhw/state",
    });
    const calls: unknown[][] = [];
    let exitCode: number | undefined;

    reexecUnderMutationLock(["project", "register"], config, {
      environment: {},
      mkdirSync: (...args) => calls.push(["mkdir", ...args]),
      spawnSync: (...args) => {
        calls.push(["spawn", ...args]);
        return { status: 42 };
      },
      exit: (code) => {
        exitCode = code;
      },
    });

    expect(calls).toEqual([
      ["mkdir", "/srv/jhw/state", { recursive: true, mode: 0o700 }],
      [
        "spawn",
        "flock",
        [
          "-n",
          "/srv/jhw/state/registry.lock",
          process.execPath,
          expect.stringMatching(/process\.ts$/),
          "project",
          "register",
        ],
        {
          stdio: "inherit",
          env: { JHW_CONTROL_LOCK_HELD: "1" },
        },
      ],
    ]);
    expect(exitCode).toBe(42);
  });
});
