import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCliDependencies, createCommandCliDependencies, runCli } from "../cli.js";
import { loadControlConfig } from "../config.js";
import { resolveGuardEnvironment } from "../guard-policy.js";
import { GuardRequestStore } from "../guard-state.js";
import { runProductionHookAdapter } from "../hook-adapter.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "jhw-observe-production-"));
  roots.push(home);
  const environment = { HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (cwd: string, ...args: string[]) =>
    (await execFile("/usr/bin/git", args, { cwd, env: environment, encoding: "utf8" })).stdout;
  const registry = join(home, "registry");
  const repository = join(home, "repository");
  for (const directory of [registry, repository]) {
    await mkdir(directory, { mode: 0o700 });
    await git(directory, "init", "--initial-branch=main");
    await git(directory, "config", "user.name", "Observe fixture");
    await git(directory, "config", "user.email", "observe@example.invalid");
    await writeFile(join(directory, "README.md"), "fixture\n");
    await git(directory, "add", "README.md");
    await git(directory, "commit", "-m", "fixture");
  }
  const directory = join(home, ".config/jhw-control");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stateDir = join(home, "state");
  const coordinates = {
    JHW_REGISTRY_DIR: registry, JHW_REGISTRY_REMOTE: "origin", JHW_REGISTRY_BRANCH: "main",
    JHW_WORKTREE_ROOT: join(home, "worktrees"), JHW_CONTROL_STATE_DIR: stateDir,
    JHW_BUILD_HOST: "fixture-host", JHW_GITHUB_OWNER: "fixture-owner", JHW_PROJECT_NUMBER: "1",
    JHW_REGISTRY_REPOSITORY: "fixture-owner/registry",
    JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_fixture", JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
  };
  await writeFile(join(directory, "control.env"), Object.entries(coordinates)
    .map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
  const policy = join(directory, "guard-policy.json");
  await writeFile(policy, '{"version":1,"mode":"observe"}\n', { mode: 0o600 });
  const head = await git(registry, "rev-parse", "HEAD");
  return { home, registry, repository, stateDir, policy, environment, git, head };
}

function payload(
  f: Awaited<ReturnType<typeof fixture>>,
  adapter: "claude" | "codex",
  event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "SessionEnd",
  override: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: "fresh-no-env-session", cwd: f.repository, hook_event_name: event,
    ...(adapter === "codex" && event !== "SessionEnd" ? {
      model: "fixture-model", permission_mode: "default", transcript_path: null, turn_id: "fixture-turn",
    } : {}),
    ...(event === "UserPromptSubmit" ? { prompt: "continue" } : {}),
    ...(event === "PreToolUse" || event === "PostToolUse" ? {
      tool_name: "Read", tool_input: { file_path: "README.md" }, tool_use_id: "fixture-read",
    } : {}),
    ...(event === "PostToolUse" ? { tool_response: { success: true } } : {}),
    ...(event === "SessionEnd" ? { reason: "other", transcript_path: adapter === "codex" ? null : "/fixture/transcript" } : {}),
    ...override,
  });
}

async function invoke(
  f: Awaited<ReturnType<typeof fixture>>, adapter: "claude" | "codex",
  event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "SessionEnd",
  override: Record<string, unknown> = {},
) {
  const result = await runProductionHookAdapter(
    ["--adapter", adapter, "--event", event], payload(f, adapter, event, override), f.environment,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, any>;
}

describe("private observe policy through the real production composition", () => {
  it("selects private Guard coordinates for the real CLI entry route without initializing state", async () => {
    const f = await fixture();
    const dependencies = createCommandCliDependencies(["guard", "status"], f.environment);
    expect(dependencies.guardMode).toBe("observe");
    expect(dependencies.stateDir).toBe(f.stateDir);
    expect(dependencies.env.JHW_REGISTRY_DIR).toBe(f.registry);
    expect(dependencies.env.JHW_GUARD_MODE).toBe("observe");
    expect(dependencies.env.JHW_GUARD_ALLOW_OBSERVE).toBe("true");
    await expect(dependencies.guardRequests.inspect()).resolves.toEqual({ status: "not_initialized", requests: [] });
    await expect(dependencies.guardDigestKey.inspect()).resolves.toEqual({ status: "not_initialized" });
    await expect(readdir(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    const status = await runCli(["guard", "status"], dependencies);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).result.runtime_mode).toBe("observe");
    await expect(readdir(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([["preflight"], ["task", "status"], ["board", "status"]])("keeps ordinary %j CLI configuration env-only", async (...argv) => {
    const f = await fixture();
    expect(() => createCommandCliDependencies(argv, f.environment)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => createCliDependencies(f.environment)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    await expect(readdir(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects partial ambient coordinates before the Guard CLI can fall back", async () => {
    const f = await fixture();
    expect(() => createCommandCliDependencies(["guard", "preflight"], {
      ...f.environment, JHW_BUILD_HOST: "ambient-host",
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    await expect(readdir(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates the actual Claude prompt probe HOME from the operator policy and state", async () => {
    const f = await fixture();
    const bin = join(f.home, "bin");
    await mkdir(bin, { mode: 0o700 });
    const capture = join(f.home, "probe-environment.json");
    await writeFile(join(bin, "claude"), String.raw`#!${process.execPath}
const fs = require("node:fs"); const path = require("node:path");
const coordinatePath = path.join(process.env.HOME, ".config/jhw-control/control.env");
const coordinates = fs.existsSync(coordinatePath) ? fs.readFileSync(coordinatePath, "utf8") : "";
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  home: process.env.HOME, coordinates, configDir: process.env.CLAUDE_CONFIG_DIR,
  ambientRegistry: process.env.JHW_REGISTRY_DIR ?? null,
}), { mode: 0o600 });
process.stdout.write("{}\n");
`, { mode: 0o755 });
    const dependencies = createCliDependencies({
      ...resolveGuardEnvironment(f.environment).environment,
      PATH: `${bin}:/usr/bin:/bin`,
    });
    const result = await dependencies.claudeHookRuntime!.probePrompt(f.home);
    expect(result.exitCode, Buffer.from(result.stderr).toString("utf8")).toBe(0);
    const observed = JSON.parse(await readFile(capture, "utf8"));
    expect(observed.home).not.toBe(f.home);
    expect(observed.home).toContain("jhw-claude-hook-preflight-");
    expect(observed.configDir).not.toBe(join(f.home, ".claude"));
    expect(observed.ambientRegistry).toBeNull();
    expect(observed.coordinates).not.toContain(f.registry);
    await expect(readdir(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["claude", "codex"] as const)("handles all four %s events without ambient coordinates", async (adapter) => {
    const f = await fixture();
    expect(await invoke(f, adapter, "UserPromptSubmit")).not.toHaveProperty("systemMessage", "GUARD_UNAVAILABLE");
    expect(await invoke(f, adapter, "PreToolUse")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    expect(await invoke(f, adapter, "PostToolUse")).not.toHaveProperty("systemMessage", "GUARD_UNAVAILABLE");
    expect(await invoke(f, adapter, "SessionEnd")).toEqual({});
    const config = loadControlConfig(resolveGuardEnvironment(f.environment).environment);
    await expect(new GuardRequestStore(config).inspect()).resolves.toEqual({ status: "ready", requests: [] });
    expect(await f.git(f.registry, "rev-parse", "HEAD")).toBe(f.head);
    expect(await f.git(f.registry, "status", "--porcelain")).toBe("");
  });

  it.each(["claude", "codex"] as const)("observes a missing Claim for %s without issuing a permit", async (adapter) => {
    const f = await fixture();
    expect(await invoke(f, adapter, "PreToolUse", {
      tool_name: "Bash", tool_input: { command: "printf bounded" }, tool_use_id: "fixture-write",
    })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    const events = (await readFile(join(f.stateDir, "guard-observe-journal.v1.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ mode: "observe", observed_decision: "DENY", decision_code: "GUARD_CLAIM_REQUIRED" }));
    const config = loadControlConfig(resolveGuardEnvironment(f.environment).environment);
    await expect(new GuardRequestStore(config).inspect()).resolves.toEqual({ status: "ready", requests: [] });
    expect(await f.git(f.registry, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("allows and reports a soft violation when only the legacy journal is writable", async () => {
    const f = await fixture();
    await mkdir(f.stateDir, { mode: 0o700 });
    const legacyPath = join(f.stateDir, "guard-journal.jsonl");
    const observePath = join(f.stateDir, "guard-observe-journal.v1.jsonl");
    await writeFile(legacyPath, "", { mode: 0o600 });
    await writeFile(observePath, "unsafe\n", { mode: 0o600 });
    await chmod(observePath, 0o644);

    expect(await invoke(f, "codex", "PreToolUse", {
      tool_name: "Bash", tool_input: { command: "printf bounded" }, tool_use_id: "fixture-write",
    })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });

    expect(await readFile(legacyPath, "utf8")).toBe("");
    expect(await readFile(observePath, "utf8")).toBe("unsafe\n");
    const diagnostics = (await readFile(join(f.stateDir, "guard-hook-diagnostics.v1.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(diagnostics).toEqual([expect.objectContaining({
      v: 1, adapter: "codex", event: "PreToolUse", mode: "observe", kind: "unrecorded_allow", code: "GUARD_CLAIM_REQUIRED",
    })]);
    expect((await stat(join(f.stateDir, "guard-hook-diagnostics.v1.jsonl"))).mode & 0o777).toBe(0o600);
    const config = loadControlConfig(resolveGuardEnvironment(f.environment).environment);
    await expect(new GuardRequestStore(config).inspect()).resolves.toEqual({ status: "ready", requests: [] });
  });

  it("accepts the documented Codex native apply_patch command envelope", async () => {
    const f = await fixture();
    expect(await invoke(f, "codex", "PreToolUse", {
      tool_name: "apply_patch", tool_use_id: "fixture-patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: added.txt\n+bounded\n*** End Patch" },
    })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    expect(await readdir(f.repository)).not.toContain("added.txt");
  });

  it("keeps self-approval blocked and allows corrupt Guard state without repairing it in observe mode", async () => {
    const f = await fixture();
    expect(await invoke(f, "codex", "PreToolUse", {
      tool_name: "Bash", tool_input: { command: "jhw-control guard approve --request req-018f21e0-7b2c-7a00-8000-000000000003" },
    })).toHaveProperty("systemMessage", "GUARD_SELF_APPROVAL_DENIED");
    const requests = join(f.stateDir, "guard-requests.yaml");
    await writeFile(requests, "{ corrupt");
    expect(await invoke(f, "codex", "PreToolUse")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    expect(await readFile(requests, "utf8")).toBe("{ corrupt");
  });

  it("allows a provider failure after observe resolved and reports it when the state directory exists", async () => {
    const f = await fixture();
    await invoke(f, "codex", "PreToolUse");
    // A digest key with a loose mode makes the production composition throw before any decision.
    await chmod(join(f.stateDir, "guard-digest.key"), 0o644);
    expect(await invoke(f, "codex", "PreToolUse")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    const diagnostics = (await readFile(join(f.stateDir, "guard-hook-diagnostics.v1.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(diagnostics).toContainEqual(expect.objectContaining({ kind: "unrecorded_allow", code: "GUARD_UNAVAILABLE" }));
  });

  it("allows a native event that fails to decode in observe, without initializing Guard state", async () => {
    const f = await fixture();
    expect(await invoke(f, "codex", "PreToolUse", { unexpected: "invalid" }))
      .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    expect(await readdir(f.home)).not.toContain("state");
  });

  it("keeps a self-approving native event that fails to decode denied in observe", async () => {
    const f = await fixture();
    expect(await invoke(f, "codex", "PreToolUse", {
      unexpected: "invalid",
      tool_name: "Bash", tool_input: { command: "jhw-control guard approve --request req-018f21e0-7b2c-7a00-8000-000000000003" },
    })).toHaveProperty("systemMessage", "GUARD_PROTOCOL_MISMATCH");
    expect(await readdir(f.home)).not.toContain("state");
  });

  it("keeps unreadable tool_input denied in observe", async () => {
    const f = await fixture();
    expect(await invoke(f, "codex", "PreToolUse", { tool_input: "not an object" }))
      .toHaveProperty("systemMessage", "GUARD_PROTOCOL_MISMATCH");
  });

  it("keeps the preflight command probe input denied in observe", async () => {
    const f = await fixture();
    const result = await runProductionHookAdapter(
      ["--adapter", "claude", "--event", "PreToolUse"], '{"hook_event_name":"PreToolUse"}\n', f.environment,
    );
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toHaveProperty("systemMessage", "GUARD_PROTOCOL_MISMATCH");
  });

  it("does not cut digest key creation when the deadline has already passed", async () => {
    const f = await fixture();
    const io = {
      now: () => 7_000,
      setTimer: () => ({ clear: () => undefined }),
      write: vi.fn(async (_stdout: string) => undefined),
      exit: vi.fn(),
    };
    await runProductionHookAdapter(
      ["--adapter", "codex", "--event", "PreToolUse"], payload(f, "codex", "PreToolUse"), f.environment, io,
    );
    // The gate arms only after the key exists, so the late clock fires at arm, never mid-creation.
    expect((await stat(join(f.stateDir, "guard-digest.key"))).size).toBe(32);
    expect(io.write).toHaveBeenCalledExactlyOnceWith('{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}\n');
    await vi.waitFor(() => expect(io.exit).toHaveBeenCalledOnce());
    const rows = (await readFile(join(f.stateDir, "guard-hook-diagnostics.v1.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toEqual([expect.objectContaining({ kind: "deadline", mode: "observe" })]);
  });

  it("skips the service-side unrecorded_allow row once more than 7,000 ms have passed", async () => {
    const f = await fixture();
    await mkdir(f.stateDir, { mode: 0o700 });
    const observePath = join(f.stateDir, "guard-observe-journal.v1.jsonl");
    await writeFile(observePath, "unsafe\n", { mode: 0o600 });
    await chmod(observePath, 0o644);
    // The gate arms on the first reading; every later reading is past the diagnostics cutoff.
    const readings = vi.fn().mockReturnValueOnce(100).mockReturnValue(7_100);
    const io = {
      now: readings,
      setTimer: () => ({ clear: () => undefined }),
      write: vi.fn(async (_stdout: string) => undefined),
      exit: vi.fn(),
    };
    await runProductionHookAdapter(
      ["--adapter", "codex", "--event", "PreToolUse"],
      payload(f, "codex", "PreToolUse", { tool_name: "Bash", tool_input: { command: "printf bounded" }, tool_use_id: "fixture-write" }),
      f.environment,
      io,
    );
    expect(io.write).toHaveBeenCalledExactlyOnceWith('{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}\n');
    await expect(readFile(join(f.stateDir, "guard-hook-diagnostics.v1.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps read-only guard preflight separate from startup initialization", async () => {
    const f = await fixture();
    const dependencies = createCliDependencies(resolveGuardEnvironment(f.environment).environment);
    const result = await runCli(["guard", "preflight"], dependencies);
    expect(result.exitCode).toBe(78);
    expect(await readdir(f.home)).not.toContain("state");
    expect(await f.git(f.registry, "rev-parse", "HEAD")).toBe(f.head);
  });
});
