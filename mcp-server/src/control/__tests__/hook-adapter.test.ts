import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuardSideEventResult } from "../guard-service.js";
import type { GuardDecision } from "../schemas.js";

type HookAdapterName = "claude" | "codex";
type HookEventName = "UserPromptSubmit" | "PreToolUse" | "PostToolUse";

interface HookGuardPort {
  submitUserPrompt(event: unknown): Promise<GuardSideEventResult>;
  evaluatePreTool(event: unknown): Promise<GuardDecision>;
  completePostTool(event: unknown): Promise<GuardSideEventResult>;
}

interface HookRunResult {
  exitCode: 0;
  stdout: string;
  stderr: "";
}

interface HookAdapterModule {
  parseHookCliArguments(argv: readonly string[]): {
    adapter: HookAdapterName;
    event: HookEventName;
  };
  parseBoundedHookStdin(raw: string | Uint8Array): Record<string, unknown>;
  runHookAdapter(
    argv: readonly string[],
    raw: string | Uint8Array,
    guard: HookGuardPort,
  ): Promise<HookRunResult>;
}

const modulePath = "../hook-adapter.js";
const loadAdapter = async (): Promise<HookAdapterModule> =>
  import(modulePath) as Promise<HookAdapterModule>;
const execFile = promisify(execFileCallback);
const paths: string[] = [];
const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repositoryRoot = resolve(mcpRoot, "..");
const sourceLauncher = join(repositoryRoot, "scripts", "jhw-control-hook");
const compiledCore = join(mcpRoot, "dist", "control", "hook-adapter.js");
const REQUEST_ID = "req-018f21e0-7b2c-7a00-8000-000000000003";

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function preToolPayload(secret = "tool-secret-9ee12c"): string {
  return JSON.stringify({
    session_id: "native-session-17",
    cwd: "/srv/worktrees/native-17",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: `deploy --token=${secret}` },
    tool_use_id: "call-native-17",
  });
}

function promptPayload(secret = "prompt-secret-8d6a31"): string {
  return JSON.stringify({
    session_id: "native-session-17",
    cwd: "/srv/worktrees/native-17",
    hook_event_name: "UserPromptSubmit",
    prompt: secret,
  });
}

function postToolPayload(): string {
  return JSON.stringify({
    session_id: "native-session-17",
    cwd: "/srv/worktrees/native-17",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push origin HEAD" },
    tool_use_id: "call-native-17",
  });
}

function exactFailure(event: HookEventName, code: "GUARD_UNAVAILABLE" | "GUARD_PROTOCOL_MISMATCH"): unknown {
  if (event === "PreToolUse") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: code,
      },
      systemMessage: code,
    };
  }
  if (event === "UserPromptSubmit") {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: code,
      },
      systemMessage: code,
    };
  }
  return { systemMessage: code };
}

function preToolDenyLineOfBytes(bytes: number): string {
  const base = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "BOUNDARY",
    },
    systemMessage: "",
  };
  const fixedBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`, "utf8");
  if (bytes <= fixedBytes) throw new TypeError("Boundary fixture is too small");
  base.systemMessage = "x".repeat(bytes - fixedBytes);
  const line = `${JSON.stringify(base)}\n`;
  if (Buffer.byteLength(line, "utf8") !== bytes) throw new TypeError("Boundary fixture drifted");
  return line;
}

class ObservableGuard implements HookGuardPort {
  readonly calls: Array<{ method: string; event: unknown }> = [];

  constructor(
    private readonly promptResult: GuardSideEventResult = {
      status: "NO_STATE_CHANGE",
      event: "user_prompt_submit",
      summary: "Prompt did not change Guard authority",
    },
    private readonly preResult: GuardDecision = {
      decision: "DENY",
      code: "GUARD_WORKTREE_MISMATCH",
      summary: "Worktree identity does not match",
    },
    private readonly postResult: GuardSideEventResult = {
      status: "COMPLETED",
      event: "post_tool_use",
      request_id: REQUEST_ID,
      task_id: "tsk-018f21e0-7b2c-7a00-8000-000000000001",
      claim_id: "clm-018f21e0-7b2c-7a00-8000-000000000002",
      summary: "Guard permit completion recorded",
    },
  ) {}

  async submitUserPrompt(event: unknown): Promise<GuardSideEventResult> {
    this.calls.push({ method: "submitUserPrompt", event });
    return this.promptResult;
  }

  async evaluatePreTool(event: unknown): Promise<GuardDecision> {
    this.calls.push({ method: "evaluatePreTool", event });
    return this.preResult;
  }

  async completePostTool(event: unknown): Promise<GuardSideEventResult> {
    this.calls.push({ method: "completePostTool", event });
    return this.postResult;
  }
}

describe("strict hook adapter executable core", () => {
  it("accepts only one exact adapter and event flag pair", async () => {
    // Break caught: unknown, missing, duplicate, or positional CLI input selects an unintended adapter path.
    const { parseHookCliArguments } = await loadAdapter();
    expect(parseHookCliArguments(["--adapter", "claude", "--event", "PreToolUse"]))
      .toEqual({ adapter: "claude", event: "PreToolUse" });
    expect(parseHookCliArguments(["--adapter", "codex", "--event", "PostToolUse"]))
      .toEqual({ adapter: "codex", event: "PostToolUse" });

    const invalid = [
      [],
      ["--adapter", "gemini", "--event", "PreToolUse"],
      ["--adapter", "claude", "--event", "Notification"],
      ["--adapter", "claude"],
      ["--event", "PreToolUse"],
      ["--adapter", "claude", "--adapter", "codex", "--event", "PreToolUse"],
      ["--adapter", "claude", "--event", "PreToolUse", "extra"],
      ["--adapter=claude", "--event=PreToolUse"],
    ];
    for (const argv of invalid) expect(() => parseHookCliArguments(argv)).toThrow();
  });

  it("parses exactly one bounded stdin JSON object", async () => {
    // Break caught: arrays, concatenated values, or trailing bytes bypass the native object schema.
    const { parseBoundedHookStdin } = await loadAdapter();
    expect(parseBoundedHookStdin("  {\"session_id\":\"s\"}\n")).toEqual({ session_id: "s" });
    for (const raw of [
      "",
      "[]",
      "null",
      "true",
      "{} {}",
      "{} trailing",
      "{\"a\":1}\n{\"b\":2}",
    ]) expect(() => parseBoundedHookStdin(raw)).toThrow();
  });

  it("rejects stdin above the exact 128 KiB UTF-8 boundary", async () => {
    // Break caught: character-count or post-parse limiting lets oversized multibyte stdin consume memory.
    const { parseBoundedHookStdin } = await loadAdapter();
    const exact = `{"value":"${"a".repeat(128 * 1024 - 12)}"}`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(128 * 1024);
    expect(parseBoundedHookStdin(exact)).toEqual({ value: "a".repeat(128 * 1024 - 12) });
    expect(() => parseBoundedHookStdin(`${exact} `)).toThrow();
    expect(() => parseBoundedHookStdin(`{"value":"${"한".repeat(44_000)}"}`)).toThrow();
  });

  it.each([
    ["claude", "UserPromptSubmit", promptPayload(), "submitUserPrompt", "user_prompt_submit"],
    ["claude", "PreToolUse", preToolPayload(), "evaluatePreTool", "pre_tool_use"],
    ["claude", "PostToolUse", postToolPayload(), "completePostTool", "post_tool_use"],
    ["codex", "UserPromptSubmit", promptPayload(), "submitUserPrompt", "user_prompt_submit"],
    ["codex", "PreToolUse", preToolPayload(), "evaluatePreTool", "pre_tool_use"],
    ["codex", "PostToolUse", postToolPayload(), "completePostTool", "post_tool_use"],
  ] as const)("routes %s %s only to the central Guard method", async (
    adapter,
    event,
    raw,
    method,
    guardEvent,
  ) => {
    // Break caught: an event calls the wrong Guard lifecycle method or calls more than one policy authority.
    const { runHookAdapter } = await loadAdapter();
    const guard = new ObservableGuard();
    const result = await runHookAdapter(["--adapter", adapter, "--event", event], raw, guard);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(result.stdout)).toBeTypeOf("object");
    expect(guard.calls).toHaveLength(1);
    expect(guard.calls[0]).toMatchObject({ method, event: { adapter, event: guardEvent } });
  });

  it("renders malformed payload and event disagreement as protocol failures without calling Guard", async () => {
    // Break caught: invalid transport reaches policy evaluation or exits without a native fail-closed response.
    const { runHookAdapter } = await loadAdapter();
    const guard = new ObservableGuard();
    const mismatched = JSON.stringify({
      ...JSON.parse(preToolPayload()) as Record<string, unknown>,
      hook_event_name: "PostToolUse",
    });

    const malformed = await runHookAdapter(
      ["--adapter", "claude", "--event", "PreToolUse"],
      mismatched,
      guard,
    );
    expect(malformed).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(exactFailure("PreToolUse", "GUARD_PROTOCOL_MISMATCH"))}\n`,
      stderr: "",
    });
    expect(guard.calls).toEqual([]);
  });

  it("validates Guard results before native rendering", async () => {
    // Break caught: malformed or wrong-variant service output is treated as authorization.
    const { runHookAdapter } = await loadAdapter();
    const guard = new ObservableGuard(
      { status: "ALLOW" } as unknown as GuardSideEventResult,
      { decision: "ALLOW" } as unknown as GuardDecision,
    );
    const result = await runHookAdapter(
      ["--adapter", "codex", "--event", "PreToolUse"],
      preToolPayload(),
      guard,
    );

    expect(JSON.parse(result.stdout)).toEqual(exactFailure("PreToolUse", "GUARD_PROTOCOL_MISMATCH"));
    expect(result.exitCode).toBe(0);
  });

  it("rejects a prompt-shaped renderer result for a PreToolUse invocation", async () => {
    // Break caught: a future PreToolUse renderer drift emits a non-blocking prompt envelope.
    vi.resetModules();
    const codecs = await import("../hook-codecs.js");
    vi.doMock("../hook-codecs.js", () => ({
      ...codecs,
      codexHookCodec: {
        ...codecs.codexHookCodec,
        renderPreTool: () => ({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "wrong native event",
          },
          systemMessage: "wrong native event",
        }),
      },
    }));
    try {
      const { runHookAdapter } = await loadAdapter();
      const result = await runHookAdapter(
        ["--adapter", "codex", "--event", "PreToolUse"],
        preToolPayload(),
        new ObservableGuard(),
      );

      expect(result).toEqual({
        exitCode: 0,
        stdout: `${JSON.stringify(exactFailure("PreToolUse", "GUARD_PROTOCOL_MISMATCH"))}\n`,
        stderr: "",
      });
    } finally {
      vi.doUnmock("../hook-codecs.js");
      vi.resetModules();
    }
  });

  it("maps thrown Guard authority failures to unavailable and exits zero", async () => {
    // Break caught: a service exception becomes a shell failure/silent allow instead of native denial.
    const { runHookAdapter } = await loadAdapter();
    const secret = "authority-secret-c97e20";
    const guard = new ObservableGuard();
    guard.evaluatePreTool = async () => { throw new Error(secret); };
    const result = await runHookAdapter(
      ["--adapter", "claude", "--event", "PreToolUse"],
      preToolPayload(secret),
      guard,
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(exactFailure("PreToolUse", "GUARD_UNAVAILABLE"))}\n`,
      stderr: "",
    });
    expect(result.stdout).not.toContain(secret);
  });

  it("writes at most one 12 KiB native JSON object without raw request bytes", async () => {
    // Break caught: output reflects stdin, emits multiple JSON values, or exceeds the established control envelope.
    const { runHookAdapter } = await loadAdapter();
    const promptSecret = "prompt-secret-d53be1";
    const result = await runHookAdapter(
      ["--adapter", "codex", "--event", "UserPromptSubmit"],
      promptPayload(promptSecret),
      new ObservableGuard(),
    );
    const lines = result.stdout.trimEnd().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toBeTypeOf("object");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(result.stdout).not.toContain(promptSecret);
  });

  it("builds both control cores as executable files", async () => {
    // Break caught: TypeScript emits the hook core but package build leaves it non-executable or absent.
    await execFile("npm", ["run", "build"], { cwd: mcpRoot, encoding: "utf8" });
    const cli = await lstat(join(mcpRoot, "dist", "control", "cli.js"));
    const hook = await lstat(compiledCore);
    expect(cli.isFile()).toBe(true);
    expect(cli.mode & 0o111).not.toBe(0);
    expect(hook.isFile()).toBe(true);
    expect(hook.mode & 0o111).not.toBe(0);
  });

  it("installs both exact package binary mappings", async () => {
    // Break caught: publishing the package drops/renames either control binary or points it at the wrong compiled core.
    const root = await mkdtemp(join(tmpdir(), "jhw-hook-package-bin-"));
    paths.push(root);
    const consumer = join(root, "consumer");
    const packageFixture = join(root, "package");
    await Promise.all([
      mkdir(consumer),
      mkdir(join(packageFixture, "dist", "control"), { recursive: true }),
    ]);
    await copyFile(join(mcpRoot, "package.json"), join(packageFixture, "package.json"));
    await Promise.all([
      writeExecutable(join(packageFixture, "dist", "control", "cli.js"), "#!/usr/bin/env node\n"),
      writeExecutable(join(packageFixture, "dist", "control", "hook-adapter.js"), "#!/usr/bin/env node\n"),
    ]);
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      name: "hook-bin-consumer",
      private: true,
      dependencies: { "jhw-notion-mcp": `file:${packageFixture}` },
    }, null, 2)}\n`, "utf8");
    await execFile("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ], { cwd: consumer, encoding: "utf8" });

    const npmBin = join(consumer, "node_modules", ".bin");
    expect(await readlink(join(npmBin, "jhw-control")))
      .toBe("../jhw-notion-mcp/dist/control/cli.js");
    expect(await readlink(join(npmBin, "jhw-control-hook-core")))
      .toBe("../jhw-notion-mcp/dist/control/hook-adapter.js");
  });
});

interface LauncherFixture {
  root: string;
  launcher: string;
  core: string;
  bin: string;
}

async function launcherFixture(): Promise<LauncherFixture> {
  const root = await mkdtemp(join(tmpdir(), "jhw-hook-launcher-"));
  paths.push(root);
  const launcher = join(root, "scripts", "jhw-control-hook");
  const core = join(root, "mcp-server", "dist", "control", "hook-adapter.js");
  const bin = join(root, "bin");
  await Promise.all([mkdir(dirname(launcher), { recursive: true }), mkdir(dirname(core), { recursive: true }), mkdir(bin)]);
  await copyFile(sourceLauncher, launcher);
  await chmod(launcher, 0o755);
  await symlink(process.execPath, join(bin, "node"));
  await symlink("/usr/bin/bash", join(bin, "bash"));
  return { root, launcher, core, bin };
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { encoding: "utf8", mode: 0o755 });
  await chmod(path, 0o755);
}

async function installTimeout(fixture: LauncherFixture, source?: string): Promise<string> {
  const path = join(fixture.bin, "timeout");
  await writeExecutable(path, source ?? `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$WATCHDOG_LOG"
if [[ "$1" != "--foreground" || "$2" != "8" ]]; then exit 93; fi
shift 2
exec "$@"
`);
  return path;
}

async function runLauncher(
  fixture: LauncherFixture,
  args: readonly string[],
  stdin: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(fixture.launcher, [...args], {
      cwd: fixture.root,
      env: {
        PATH: fixture.bin,
        WATCHDOG_LOG: join(fixture.root, "watchdog.log"),
        FORWARDED_STDIN: join(fixture.root, "forwarded-stdin"),
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(Object.assign(new Error("launcher failed"), { code, signal, stdout, stderr }));
    });
    child.stdin.end(stdin);
  });
}

describe("8-second fail-closed launcher", () => {
  it("ships as an executable user-facing file", async () => {
    // Break caught: installation links a launcher that the OS cannot execute.
    const stat = await lstat(sourceLauncher);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it("uses timeout --foreground with an exact 8-second inner watchdog and forwards stdin", async () => {
    // Break caught: the inner deadline is absent/wrong or command substitution stores native stdin.
    const fixture = await launcherFixture();
    await installTimeout(fixture);
    const neutral = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse" },
    });
    await writeExecutable(fixture.core, `#!/usr/bin/env bash
IFS= read -r payload || true
printf '%s' "$payload" > "$FORWARDED_STDIN"
printf '%s\\n' "$CORE_OUTPUT"
`);
    const stdin = preToolPayload();
    const result = await runLauncher(
      fixture,
      ["--adapter", "claude", "--event", "PreToolUse"],
      stdin,
      { CORE_OUTPUT: neutral },
    );

    expect(result).toEqual({ stdout: `${neutral}\n`, stderr: "" });
    expect(await readFile(join(fixture.root, "forwarded-stdin"), "utf8")).toBe(stdin);
    const watchdog = (await readFile(join(fixture.root, "watchdog.log"), "utf8")).trimEnd().split("\n");
    expect(watchdog.slice(0, 2)).toEqual(["--foreground", "8"]);
    expect(resolve(watchdog[2] as string)).toBe(resolve(fixture.core));
    expect(watchdog.slice(3)).toEqual(["--adapter", "claude", "--event", "PreToolUse"]);
  });

  it("rejects invalid launcher flags before invoking the core", async () => {
    // Break caught: unvalidated adapter/event values reach the core or become a silent shell error.
    const fixture = await launcherFixture();
    await installTimeout(fixture);
    await writeExecutable(fixture.core, "#!/usr/bin/env bash\nprintf '{\"unexpected\":true}\\n'\n");
    const result = await runLauncher(
      fixture,
      ["--adapter", "gemini", "--event", "PreToolUse"],
      preToolPayload(),
    );

    expect(JSON.parse(result.stdout)).toEqual(exactFailure("PreToolUse", "GUARD_PROTOCOL_MISMATCH"));
    expect(result.stderr).toBe("");
    await expect(readFile(join(fixture.root, "watchdog.log"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back before the outer deadline when timeout is unavailable", async () => {
    // Break caught: a host without GNU timeout executes unbounded or emits no native denial.
    const fixture = await launcherFixture();
    await writeExecutable(fixture.core, "#!/usr/bin/env bash\nprintf '{\"unexpected\":true}\\n'\n");
    const result = await runLauncher(
      fixture,
      ["--adapter", "codex", "--event", "PreToolUse"],
      preToolPayload(),
    );

    expect(JSON.parse(result.stdout)).toEqual(exactFailure("PreToolUse", "GUARD_UNAVAILABLE"));
    expect(result.stderr).toBe("");
  });

  it("falls back when the compiled core is missing", async () => {
    // Break caught: a partial installation silently allows because the launcher target is absent.
    const fixture = await launcherFixture();
    await installTimeout(fixture);
    const result = await runLauncher(
      fixture,
      ["--adapter", "claude", "--event", "PreToolUse"],
      preToolPayload(),
    );

    expect(JSON.parse(result.stdout)).toEqual(exactFailure("PreToolUse", "GUARD_UNAVAILABLE"));
    expect(result.stderr).toBe("");
  });

  it.each([
    ["timeout", "#!/usr/bin/env bash\nexit 124\n", "#!/usr/bin/env bash\nprintf '{}\\n'\n"],
    ["nonzero core", undefined, "#!/usr/bin/env bash\nprintf '{\"systemMessage\":\"wrong\"}\\n'\nexit 7\n"],
    ["empty core output", undefined, "#!/usr/bin/env bash\nexit 0\n"],
    ["malformed core JSON", undefined, "#!/usr/bin/env bash\nprintf 'not-json\\n'\n"],
    ["multiple core JSON values", undefined, "#!/usr/bin/env bash\nprintf '{}\\n{}\\n'\n"],
    ["empty JSON object", undefined, "#!/usr/bin/env bash\nprintf '{}\\n'\n"],
    [
      "wrong-event native object",
      undefined,
      "#!/usr/bin/env bash\nprintf '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"wrong\"},\"systemMessage\":\"wrong\"}\\n'\n",
    ],
  ] as const)("renders unavailable on %s", async (_name, timeoutSource, coreSource) => {
    // Break caught: a watchdog/core failure returns its bytes or empty stdout instead of a static native response.
    const fixture = await launcherFixture();
    await installTimeout(fixture, timeoutSource);
    await writeExecutable(fixture.core, coreSource);
    const result = await runLauncher(
      fixture,
      ["--adapter", "claude", "--event", "PreToolUse"],
      preToolPayload(),
    );

    expect(JSON.parse(result.stdout)).toEqual(exactFailure("PreToolUse", "GUARD_UNAVAILABLE"));
    expect(result.stderr).toBe("");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it("accepts one exact event-specific envelope at the 12 KiB capture boundary", async () => {
    // Break caught: overflow detection rejects an exact 12,288-byte native response.
    const fixture = await launcherFixture();
    await installTimeout(fixture);
    await writeExecutable(fixture.core, `#!/usr/bin/env bash
printf '%s' "$CORE_OUTPUT"
`);
    const line = preToolDenyLineOfBytes(12 * 1024);
    const result = await runLauncher(
      fixture,
      ["--adapter", "codex", "--event", "PreToolUse"],
      preToolPayload(),
      { CORE_OUTPUT: line },
    );

    expect(result).toEqual({ stdout: line, stderr: "" });
  });

  it("retains at most 12 KiB while detecting one overflow byte", async () => {
    // Break caught: overflow detection writes a 12,289th core byte into the bounded response capture.
    const fixture = await launcherFixture();
    await installTimeout(fixture);
    await rm(join(fixture.bin, "node"));
    await writeExecutable(join(fixture.bin, "node"), `#!/usr/bin/env bash
"$REAL_NODE" "$@"
status=$?
if [[ "$#" -eq 4 && -f "$3" ]]; then
  /usr/bin/stat -c '%s' "$3" > "$CAPTURE_SIZE_LOG"
fi
exit "$status"
`);
    await writeExecutable(fixture.core, `#!/usr/bin/env bash
printf '%s' "$CORE_OUTPUT"
`);
    const captureSizeLog = join(fixture.root, "capture-size");
    const result = await runLauncher(
      fixture,
      ["--adapter", "codex", "--event", "PreToolUse"],
      preToolPayload(),
      {
        CORE_OUTPUT: preToolDenyLineOfBytes(12 * 1024 + 1),
        REAL_NODE: process.execPath,
        CAPTURE_SIZE_LOG: captureSizeLog,
      },
    );

    expect(JSON.parse(result.stdout)).toEqual(exactFailure("PreToolUse", "GUARD_UNAVAILABLE"));
    expect(await readFile(captureSizeLog, "utf8")).toBe(`${12 * 1024}\n`);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it.each([
    ["UserPromptSubmit", promptPayload(), "GUARD_UNAVAILABLE"],
    ["PostToolUse", postToolPayload(), "GUARD_UNAVAILABLE"],
  ] as const)("emits bounded %s context/warning fallbacks", async (event, stdin, code) => {
    // Break caught: non-blocking native events fail silently and leave no bounded operator context.
    const fixture = await launcherFixture();
    await installTimeout(fixture, "#!/usr/bin/env bash\nexit 124\n");
    await writeExecutable(fixture.core, "#!/usr/bin/env bash\nexit 124\n");
    const result = await runLauncher(
      fixture,
      ["--adapter", "claude", "--event", event],
      stdin,
    );

    expect(JSON.parse(result.stdout)).toEqual(exactFailure(event, code));
    expect(result.stdout).not.toContain("prompt-secret-8d6a31");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });
});
