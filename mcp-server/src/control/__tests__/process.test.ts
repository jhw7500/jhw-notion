import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadControlConfig } from "../config.js";
import { ProcessRunner } from "../process.js";

describe("control process boundary", () => {
  it("never includes secret environment values in a failed command", async () => {
    const runner = new ProcessRunner({ GH_PROJECT_TOKEN: "secret-project-token" });
    const error = await runner
      .run("bash", ["-c", "echo secret-project-token >&2; exit 2"])
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "COMMAND_FAILED" });
    expect(JSON.stringify(error)).not.toContain("secret-project-token");
    expect(JSON.stringify(error)).toContain("[REDACTED]");
  });

  it("requires build-server coordinates but not tokens in config files", () => {
    const config = loadControlConfig({
      HOME: "/home/jhw",
      JHW_REGISTRY_DIR: "/srv/jhw/project-registry",
      JHW_WORKTREE_ROOT: "/srv/jhw/worktrees",
      JHW_BUILD_HOST: "cantopsbuildserver",
      JHW_GITHUB_OWNER: "jhw7500",
      JHW_PROJECT_NUMBER: "7",
      JHW_REGISTRY_REPOSITORY: "jhw7500/project-registry",
      JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
      JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
    });

    expect(config.registryBranch).toBe("main");
    expect(config).toMatchObject({
      registryRepository: "jhw7500/project-registry",
      preflightProjectItemId: "PVTI_trial",
      preflightRegistryIssueNumber: 1,
    });
    expect(JSON.stringify(config)).not.toContain("TOKEN");
  });

  it("requires absolute Registry and worktree roots", () => {
    const base = {
      HOME: "/home/jhw",
      JHW_REGISTRY_DIR: "/srv/jhw/project-registry",
      JHW_WORKTREE_ROOT: "/srv/jhw/worktrees",
      JHW_BUILD_HOST: "cantopsbuildserver",
      JHW_GITHUB_OWNER: "jhw7500",
      JHW_PROJECT_NUMBER: "7",
      JHW_REGISTRY_REPOSITORY: "jhw7500/project-registry",
      JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
      JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
    };
    expect(() => loadControlConfig({ ...base, JHW_REGISTRY_DIR: "relative-registry" })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
    );
    expect(() => loadControlConfig({ ...base, JHW_WORKTREE_ROOT: "relative-worktrees" })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
    );
  });

  it("does not require HOME when an immutable absolute state directory is explicit", () => {
    const config = loadControlConfig({
      JHW_REGISTRY_DIR: "/srv/jhw/project-registry",
      JHW_WORKTREE_ROOT: "/srv/jhw/worktrees",
      JHW_CONTROL_STATE_DIR: "/srv/jhw/control-state",
      JHW_BUILD_HOST: "cantopsbuildserver",
      JHW_GITHUB_OWNER: "jhw7500",
      JHW_PROJECT_NUMBER: "7",
      JHW_REGISTRY_REPOSITORY: "jhw7500/project-registry",
      JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
      JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
    });

    expect(config.stateDir).toBe("/srv/jhw/control-state");
  });

  it.each([
    ["JHW_REGISTRY_REPOSITORY", "invalid"],
    ["JHW_REGISTRY_REPOSITORY", "another-owner/project-registry"],
    ["JHW_PREFLIGHT_PROJECT_ITEM_ID", "I_not-project-item"],
    ["JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER", "0"],
  ])("fails closed for invalid non-secret preflight coordinate %s", (key, value) => {
    const env = {
      HOME: "/home/jhw",
      JHW_REGISTRY_DIR: "/srv/jhw/project-registry",
      JHW_WORKTREE_ROOT: "/srv/jhw/worktrees",
      JHW_BUILD_HOST: "cantopsbuildserver",
      JHW_GITHUB_OWNER: "jhw7500",
      JHW_PROJECT_NUMBER: "7",
      JHW_REGISTRY_REPOSITORY: "jhw7500/project-registry",
      JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
      JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
      [key]: value,
    };

    expect(() => loadControlConfig(env)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
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

  it("returns bounded raw bytes without decoding or redacting committed blob content", async () => {
    const secret = "blob-secret";
    const bytes = await new ProcessRunner({ BLOB_TOKEN: secret }).runRaw("bash", ["-c", `printf '${secret}'`], {}, 64);

    expect(bytes).toEqual(Buffer.from(secret, "utf8"));
  });

  it("fails raw capture by stable metadata when output exceeds its byte bound", async () => {
    const error = await new ProcessRunner({}).runRaw("bash", ["-c", "head -c 16 /dev/zero"], {}, 8)
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "RAW_OUTPUT_TOO_LARGE" });
    expect(JSON.stringify(error)).not.toContain("\\u0000");
  });

  it("removes inherited and override secrets from ordinary child environments", async () => {
    const result = await new ProcessRunner({ GH_PROJECT_TOKEN: "inherited-token" }).run(
      "bash",
      ["-c", "printf '%s|%s' \"${GH_PROJECT_TOKEN:-missing}\" \"${APP_SECRET:-missing}\""],
      { env: { APP_SECRET: "override-secret" } },
    );

    expect(result.stdout).toBe("missing|missing");
  });

  it("requires an explicit selected credential for gh execution", async () => {
    const runner = new ProcessRunner({});
    await expect(runner.runGh(["--version"], "project")).rejects.toMatchObject({
      code: "MISSING_CREDENTIAL",
    });
  });

  it("injects only the selected credential into the gh child", async () => {
    const bin = await mkdtemp(join(tmpdir(), "jhw-control-gh-"));
    await writeFile(join(bin, "gh"), "#!/bin/sh\nprintf '%s|%s|%s' \"$GH_TOKEN\" \"${GH_PROJECT_TOKEN:-missing}\" \"${GH_REPO_TOKEN:-missing}\"\n");
    await chmod(join(bin, "gh"), 0o755);
    try {
      const result = await new ProcessRunner({
        GH_PROJECT_TOKEN: "project-token",
        GH_REPO_TOKEN: "repo-token",
      }).runGh([], "project", { env: { PATH: bin } });

      expect(result.stdout).toBe("[REDACTED]|missing|missing");
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("redacts a self-overlapping secret emitted in one chunk", async () => {
    const result = await new ProcessRunner({ AAA_TOKEN: "aaa" }).run("bash", ["-c", "printf aaa"]);

    expect(result.stdout).toBe("[REDACTED]");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("redacts a self-overlapping secret split across child output chunks", async () => {
    const result = await new ProcessRunner({ AAA_TOKEN: "aaa" }).run(process.execPath, [
      "-e",
      "process.stdout.write('a'); setTimeout(() => process.stdout.write('aa'), 20)",
    ]);

    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stdout).not.toContain("a");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("redacts an overlapping secret across arbitrary output splits", async () => {
    const result = await new ProcessRunner({ ABAB_TOKEN: "abab" }).run(process.execPath, [
      "-e",
      "process.stdout.write('ab'); setTimeout(() => process.stdout.write('ab'), 20)",
    ]);

    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stdout).not.toContain("ab");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("masks the union of distinct overlapping secrets in one chunk", async () => {
    const result = await new ProcessRunner({ FIRST_TOKEN: "abc", SECOND_TOKEN: "bcd" }).run(
      "bash",
      ["-c", "printf abcd"],
    );

    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stdout).not.toContain("abc");
    expect(result.stdout).not.toContain("bcd");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("masks the union of distinct overlapping secrets split across chunks", async () => {
    const result = await new ProcessRunner({ FIRST_TOKEN: "abc", SECOND_TOKEN: "bcd" }).run(process.execPath, [
      "-e",
      "process.stdout.write('ab'); setTimeout(() => process.stdout.write('cd'), 20)",
    ]);

    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stdout).not.toContain("d");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("masks containment relationships without exposing a suffix", async () => {
    const result = await new ProcessRunner({ SHORT_TOKEN: "abc", LONG_TOKEN: "abcde" }).run(
      "bash",
      ["-c", "printf abcde"],
    );

    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stdout).not.toContain("abc");
    expect(result.stdout).not.toContain("de");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("masks every span in a three-secret overlap chain", async () => {
    const result = await new ProcessRunner({ FIRST_TOKEN: "abc", SECOND_TOKEN: "bcd", THIRD_TOKEN: "cde" }).run(
      "bash",
      ["-c", "printf abcde"],
    );

    expect(result.stdout).toBe("[REDACTED]");
    expect(result.stdout).not.toContain("abc");
    expect(result.stdout).not.toContain("bcd");
    expect(result.stdout).not.toContain("cde");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("preserves an emoji when the streaming retention boundary bisects its surrogate pair", async () => {
    const result = await new ProcessRunner({ CROSSING_TOKEN: "secret" }).run(process.execPath, [
      "-e",
      "process.stdout.write('A😀xxxx'); setTimeout(() => process.stdout.write('secretZ'), 20)",
    ]);

    expect(result.stdout).toBe("A😀xxxx[REDACTED]Z");
    expect(result.stdout).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("does not leak a secret prefix that crosses the safe output boundary", async () => {
    const secret = "crossing-secret";
    const result = await new ProcessRunner({ CROSSING_TOKEN: secret }).run("bash", [
      "-c",
      `head -c ${1024 * 1024 - 4} /dev/zero | tr '\\0' x; printf '${secret}'`,
    ]);

    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(secret.slice(0, 4));
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("caps redacted output after short-secret replacement expansion", async () => {
    const result = await new ProcessRunner({ SHORT_TOKEN: "a" }).run("bash", [
      "-c",
      `head -c ${1024 * 1024} /dev/zero | tr '\\0' a`,
    ]);

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(result.stdout).not.toContain("a");
  });

  it("preserves complete UTF-8 when the final capture cap bisects an emoji", async () => {
    const marker = "[REDACTED]";
    const safeBytesBeforeEmoji = 1024 * 1024 - 3;
    const fillerLength = safeBytesBeforeEmoji - Buffer.byteLength(marker);
    const result = await new ProcessRunner({ ONE_TOKEN: "a" }).run("bash", [
      "-c",
      `printf a; head -c ${fillerLength} /dev/zero | tr '\\0' x; printf '😀tail'`,
    ]);

    expect(result.stdout.startsWith(marker)).toBe(true);
    expect(result.stdout).toHaveLength(marker.length + fillerLength);
    expect(result.stdout.slice(marker.length).replaceAll("x", "")).toBe("");
    expect(result.stdout).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });


});
