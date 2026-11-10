import { spawn, type SpawnOptions } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { loadControlConfig } from "../config.js";
import { createObserveJournalLock, MutationLock, ProcessRunner, type ProcessRunnerRuntime } from "../process.js";

describe("control process boundary", () => {
  it("uses a dedicated strict bounded observe-journal lock profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-observe-lock-"));
    const stateDir = join(root, "state");
    try {
      await createObserveJournalLock(stateDir).runInStateDirectory(async () => undefined);
      const info = await lstat(join(stateDir, "guard-observe-journal.lock"));
      expect(info.isFile()).toBe(true);
      expect(info.nlink).toBe(1);
      expect(info.uid).toBe(process.getuid!());
      expect(info.mode & 0o7777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tries every strict directory handle close and surfaces the first normal-path close failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-observe-close-"));
    const stateDir = join(root, "state");
    const closeFailure = new Error("injected strict directory close failure");
    const closed: number[] = [];
    const runtime = {
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
    };
    try {
      const lock = new MutationLock({ stateDir }, {}, runtime, {}, {
        lockFileName: "guard-observe-journal.lock",
        waitSeconds: 5,
        strictExistingStateDirectory: true,
        strictExistingLockFileMode: true,
        strictCurrentUserPrivateState: true,
        closeStrictDirectoryHandle: async (handle) => {
          closed.push(handle.fd);
          await handle.close();
          if (closed.length === 1) throw closeFailure;
        },
      });

      await expect(lock.runInStateDirectory(async () => "completed")).rejects.toBe(closeFailure);
      expect(closed.length).toBeGreaterThan(1);
      expect(new Set(closed).size).toBe(closed.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a primary setup failure while still attempting every strict directory close", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-observe-close-primary-"));
    const stateDir = join(root, "state");
    const closed: number[] = [];
    try {
      const lock = new MutationLock({ stateDir }, {}, { spawn: () => { throw new Error("spawn failed"); } }, {}, {
        lockFileName: "guard-observe-journal.lock",
        waitSeconds: 5,
        strictExistingStateDirectory: true,
        strictExistingLockFileMode: true,
        strictCurrentUserPrivateState: true,
        closeStrictDirectoryHandle: async (handle) => {
          closed.push(handle.fd);
          await handle.close();
          if (closed.length === 1) throw new Error("secondary close failure");
        },
      });

      await expect(lock.runInStateDirectory(async () => "must-not-run")).rejects.toMatchObject({
        code: "LOCK_SPAWN_FAILED",
      });
      expect(closed.length).toBeGreaterThan(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("never includes secret environment values in a failed command", async () => {
    const runner = new ProcessRunner({ GH_PROJECT_TOKEN: "secret-project-token" });
    const error = await runner
      .run("bash", ["-c", "echo secret-project-token >&2; exit 2"])
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "COMMAND_FAILED" });
    expect(JSON.stringify(error)).not.toContain("secret-project-token");
    expect(JSON.stringify(error)).toContain("[REDACTED]");
  });

  it("never includes host-absolute command arguments in direct error metadata", async () => {
    const privatePath = "/srv/private/source-checkout";
    const runner = new ProcessRunner();

    const error = await runner.run("bash", ["-c", "exit 2", privatePath]).catch((cause) => cause);

    expect(error).toMatchObject({ code: "COMMAND_FAILED" });
    expect(JSON.stringify(error)).not.toContain(privatePath);
    expect((error as Error).message).not.toContain(privatePath);
  });

  it("requires build-server coordinates but not tokens in config files", () => {
    const config = loadControlConfig({
      HOME: "/fixture/home",
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
    ["JHW_REGISTRY_REMOTE", "--upload-pack=helper"],
    ["JHW_REGISTRY_BRANCH", "--force"],
    ["JHW_BUILD_HOST", `host\n${"x".repeat(256)}`],
    ["JHW_REGISTRY_DIR", "/"],
    ["JHW_WORKTREE_ROOT", "/"],
  ])("fails closed for invalid non-secret preflight coordinate %s", (key, value) => {
    const env = {
      HOME: "/fixture/home",
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
      loadControlConfig({ HOME: "/fixture/home" });
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

  it("rejects protected data in successful output instead of returning redacted corruption", async () => {
    const secret = "unmistakably-fake-success-token";
    const error = await new ProcessRunner({ API_TOKEN: secret }).run(
      "bash",
      ["-c", `printf '${secret}'`],
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_OUTPUT_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("[REDACTED]");
  });

  it("does not corrupt successful output for unusably short secret-like values", async () => {
    const result = await new ProcessRunner({ API_TOKEN: "x" }).run("bash", ["-c", "printf x"]);
    expect(result.stdout).toBe("x");
  });

  it("does not reject an ordinary output prefix that is not the protected value", async () => {
    const result = await new ProcessRunner({ API_TOKEN: "abcdefgh" }).run("bash", ["-c", "printf a"]);
    expect(result.stdout).toBe("a");
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

  it("settles after the kill grace even when a child never emits close", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const RuntimeProcessRunner = ProcessRunner as unknown as new (
      environment: NodeJS.ProcessEnv,
      runtime: { spawn(): typeof child },
    ) => ProcessRunner;
    const runner = new RuntimeProcessRunner({}, { spawn: () => child });

    const error = await runner.run("never-closes", [], { timeoutMs: 10 }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(child.kill).toHaveBeenCalled();
  }, 500);

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
      const error = await new ProcessRunner({
        GH_PROJECT_TOKEN: "project-token",
        GH_REPO_TOKEN: "repo-token",
        DB_PASSWORD: "unmistakably-fake-db-password",
        lowercase_token: "unmistakably-fake-lower-token",
      }).runGh([], "project", { env: { PATH: bin } }).catch((cause: unknown) => cause);

      expect(error).toMatchObject({ code: "SENSITIVE_OUTPUT_REJECTED" });
      expect(JSON.stringify(error)).not.toContain("project-token");
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("redacts overlapping protected terms in failed diagnostic streams", async () => {
    const first = "abcdefgh";
    const second = "defghijk";
    const error = await new ProcessRunner({ FIRST_TOKEN: first, SECOND_TOKEN: second }).run(process.execPath, [
      "-e",
      "process.stderr.write('abc');setTimeout(()=>{process.stderr.write('defghijk');process.exit(2)},10)",
    ]).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "COMMAND_FAILED" });
    expect(JSON.stringify(error)).not.toContain(first);
    expect(JSON.stringify(error)).not.toContain(second);
    expect(JSON.stringify(error)).toContain("[REDACTED]");
  });

  it("rejects protected successful output even when the match crosses the capture boundary", async () => {
    const secret = "crossing-secret";
    const error = await new ProcessRunner({ CROSSING_TOKEN: secret }).run("bash", [
      "-c",
      `head -c ${1024 * 1024 - 4} /dev/zero | tr '\\0' x; printf '${secret}'`,
    ]).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_OUTPUT_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("rejects oversized successful stdout instead of returning truncated authority data", async () => {
    const fillerLength = 1024 * 1024 - 3;
    const failure = await new ProcessRunner({ SHORT_TOKEN: "x" }).run("bash", [
      "-c",
      `head -c ${fillerLength} /dev/zero | tr '\\0' x; printf '😀tail'`,
    ]).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ code: "COMMAND_OUTPUT_TOO_LARGE" });
    expect(JSON.stringify(failure)).not.toContain("\uFFFD");
  });

  it("rejects oversized successful stderr instead of returning truncated diagnostics", async () => {
    const failure = await new ProcessRunner().run("bash", [
      "-c",
      `head -c ${1024 * 1024 + 1} /dev/zero | tr '\\0' x >&2`,
    ]).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ code: "COMMAND_OUTPUT_TOO_LARGE" });
  });

  it("feeds raw input to the child's stdin and closes it", async () => {
    const input = Buffer.from([0x00, 0x0a, 0xff, 0x41, 0x0a]);
    const bytes = await new ProcessRunner({}).runRaw(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { input },
      64,
    );

    expect(bytes).toEqual(input);
  });

  // Far more input than a pipe holds, so the write is still pending when the
  // child lets go of its stdin.
  it.each([
    ["closes stdin and keeps running", "exec 0<&-; sleep 0.2; printf done"],
    ["exits at once", "printf done"],
  ])("returns the answer of a raw child that %s without reading its input", async (_label, script) => {
    const bytes = await new ProcessRunner({}).runRaw(
      "bash",
      ["-c", script],
      { input: Buffer.alloc(8 * 1024 * 1024, 0x61) },
      64,
    );

    expect(bytes.toString("utf8")).toBe("done");
  });

  it("opens stdin only for a raw command that is given input", async () => {
    const stdio: unknown[] = [];
    const runtime: ProcessRunnerRuntime = {
      spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
        stdio.push(options.stdio);
        return spawn(command, args, options);
      }) as typeof spawn,
    };
    const runner = new ProcessRunner({}, runtime);

    // Without input stdin is not a pipe, so `cat` sees end of file at once.
    expect((await runner.runRaw("bash", ["-c", "cat; printf end"], {}, 64)).toString("utf8")).toBe("end");
    expect((await runner.runRaw("bash", ["-c", "cat"], { input: Buffer.from("in", "utf8") }, 64)).toString("utf8")).toBe("in");
    expect(stdio).toEqual([["ignore", "pipe", "ignore"], ["pipe", "pipe", "ignore"]]);
  });

  it.each([
    ["EPIPE", "resolves"],
    ["ECONNRESET", "resolves"],
    ["EIO", "rejects"],
  ] as const)("leaves a %s stdin failure to the child's own answer only when the child let go of the pipe", async (code, outcome) => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("injected stdin failure"), { code }));
      },
    });
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdin, stdout: new PassThrough(), kill: vi.fn(() => true) });
    const RuntimeProcessRunner = ProcessRunner as unknown as new (
      environment: NodeJS.ProcessEnv,
      runtime: { spawn(): typeof child },
    ) => ProcessRunner;
    const runner = new RuntimeProcessRunner({}, {
      spawn: () => {
        setImmediate(() => {
          child.stdout.end();
          child.emit("close", 0);
        });
        return child;
      },
    });

    const pending = runner.runRaw("fake", [], { input: Buffer.from("x", "utf8") }, 64);

    if (outcome === "resolves") await expect(pending).resolves.toEqual(Buffer.alloc(0));
    else await expect(pending).rejects.toMatchObject({ code: "RAW_COMMAND_FAILED" });
  });

  it("fails a raw command that cannot start, with input pending, by stable metadata", async () => {
    const error = await new ProcessRunner({}).runRaw(
      "/nonexistent/jhw-raw-command",
      [],
      { input: Buffer.alloc(1024 * 1024, 0x61) },
      64,
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "RAW_COMMAND_FAILED" });
  });
});
