import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      HOME: "/fixture/home",
      JHW_REGISTRY_DIR: "/fixture/registry",
      JHW_WORKTREE_ROOT: "/fixture/worktrees",
      JHW_BUILD_HOST: "fixture-build-host",
      JHW_GITHUB_OWNER: "fixture-owner",
      JHW_PROJECT_NUMBER: "7",
      JHW_REGISTRY_REPOSITORY: "fixture-owner/registry",
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

  it("forces ordinary child processes into non-interactive Git and SSH mode", async () => {
    const result = await new ProcessRunner({ GIT_SSH_COMMAND: "ssh -i /fixture/key" }).run(
      "bash",
      ["-c", "printf '%s|%s|%s' \"$GIT_TERMINAL_PROMPT\" \"$GCM_INTERACTIVE\" \"$GIT_SSH_COMMAND\""],
    );

    expect(result.stdout).toBe("0|Never|ssh -i /fixture/key -oBatchMode=yes");
  });

  it("kills a hanging command at the caller's bounded timeout", async () => {
    const started = Date.now();
    const error = await new ProcessRunner({}).run(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { timeoutMs: 25 },
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(JSON.stringify(error)).not.toContain("setInterval");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each(["captured", "raw"] as const)("aborts a %s process tree whose descendant retains the capture pipes", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "jhw-control-process-tree-"));
    const marker = join(root, "descendant.pid");
    const controller = new AbortController();
    let descendantPid: number | undefined;
    let settled = false;
    const script = [
      "const {spawn}=require('node:child_process');",
      "const {writeFileSync}=require('node:fs');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>undefined,1000)'],{stdio:['ignore',process.stdout,process.stderr]});",
      "writeFileSync(process.argv[1],String(child.pid));",
      "setInterval(()=>undefined,1000);",
    ].join("");
    const runner = new ProcessRunner({});
    const pending = (kind === "captured"
      ? runner.run(process.execPath, ["-e", script, marker], { signal: controller.signal })
      : runner.runRaw(process.execPath, ["-e", script, marker], { signal: controller.signal }, 64)
    ).catch((cause: unknown) => cause);
    pending.finally(() => { settled = true; }).catch(() => undefined);

    try {
      for (let turn = 0; turn < 10_000 && descendantPid === undefined; turn += 1) {
        try {
          descendantPid = Number.parseInt(await readFile(marker, "utf8"), 10);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      controller.abort();
      for (let turn = 0; turn < 10_000 && !settled; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const settledBeforeCleanup = settled;
      if (!settled && descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already stopped */ }
      }
      const error = await pending;

      expect(settledBeforeCleanup).toBe(true);
      expect(error).toMatchObject({ code: "COMMAND_ABORTED" });
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills a hanging raw command without returning partial blob bytes", async () => {
    const error = await new ProcessRunner({}).runRaw(
      process.execPath,
      ["-e", "process.stdout.write('partial'); setInterval(() => undefined, 1000)"],
      { timeoutMs: 25 },
      64,
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(JSON.stringify(error)).not.toContain("partial");
  });

  it("honors an already-aborted signal without returning child output", async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await new ProcessRunner({}).run(
      process.execPath,
      ["-e", "process.stdout.write('must-not-return'); setInterval(() => undefined, 1000)"],
      { signal: controller.signal },
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "COMMAND_ABORTED" });
    expect(JSON.stringify(error)).not.toContain("must-not-return");
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

  it("aligns password, credential, API-key, private-key, passwd, and lowercase token handling", async () => {
    const environment = {
      DB_PASSWORD: "unmistakably-fake-db-password",
      SERVICE_CREDENTIAL: "unmistakably-fake-service-credential",
      NOTION_API_KEY: "unmistakably-fake-notion-api-key",
      SSH_PRIVATE_KEY: "unmistakably-fake-private-key",
      CACHE_PASSWD: "unmistakably-fake-cache-passwd",
      lowercase_token: "unmistakably-fake-lower-token",
    };
    const keys = Object.keys(environment);
    const runner = new ProcessRunner(environment);
    const inherited = await runner.run(process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(keys)}.map(k=>process.env[k]??'missing').join('|'))`,
    ]);

    expect(inherited.stdout).toBe(keys.map(() => "missing").join("|"));
    const secret = environment.DB_PASSWORD;
    const error = await runner.run(process.execPath, [
      "-e",
      `process.stderr.write(${JSON.stringify(secret)});process.exit(2)`,
    ]).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "COMMAND_FAILED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).toContain("[REDACTED]");
  });

  it("requires an explicit selected credential for gh execution", async () => {
    const runner = new ProcessRunner({});
    await expect(runner.runGh(["--version"], "project")).rejects.toMatchObject({
      code: "MISSING_CREDENTIAL",
    });
  });

  it("injects only the selected credential into the gh child", async () => {
    const bin = await mkdtemp(join(tmpdir(), "jhw-control-gh-"));
    await writeFile(join(bin, "gh"), "#!/bin/sh\nprintf '%s|%s|%s|%s|%s' \"$GH_TOKEN\" \"${GH_PROJECT_TOKEN:-missing}\" \"${GH_REPO_TOKEN:-missing}\" \"${DB_PASSWORD:-missing}\" \"${lowercase_token:-missing}\"\n");
    await chmod(join(bin, "gh"), 0o755);
    try {
      const result = await new ProcessRunner({
        GH_PROJECT_TOKEN: "project-token",
        GH_REPO_TOKEN: "repo-token",
        DB_PASSWORD: "unmistakably-fake-db-password",
        lowercase_token: "unmistakably-fake-lower-token",
      }).runGh([], "project", { env: { PATH: bin } });

      expect(result.stdout).toBe("[REDACTED]|missing|missing|missing|missing");
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
