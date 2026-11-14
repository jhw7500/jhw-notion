import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOOK_DECISION_DEADLINE_MS,
  HOOK_LATENCY_WARNING_MS,
  recordBoundedDiagnostic,
  runHookAdapter,
  runHookAdapterWithDeadline,
  type HookDeadlineIo,
  type HookGuardPort,
  type HookRunContext,
} from "../hook-adapter.js";
import { renderStaticHookFailure } from "../hook-codecs.js";
import { newOperationId } from "../ids.js";
import type { GuardDecision } from "../schemas.js";

const slowAppend = vi.hoisted(() => ({ delayMs: 0 }));
vi.mock("../guard-diagnostics.js", async (importActual) => {
  const actual = await importActual<typeof import("../guard-diagnostics.js")>();
  return {
    ...actual,
    appendGuardHookDiagnostic: async (...args: Parameters<typeof actual.appendGuardHookDiagnostic>) => {
      if (slowAppend.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, slowAppend.delayMs));
      return actual.appendGuardHookDiagnostic(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  slowAppend.delayMs = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const NEUTRAL = '{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}\n';
const DEADLINE_DENY = `${JSON.stringify(renderStaticHookFailure("PreToolUse", "GUARD_DEADLINE_EXCEEDED"))}\n`;
const approval = "jhw-control guard approve req-018f21e0-7b2c-7a00-8000-000000000003";

function allow(): GuardDecision {
  return { decision: "ALLOW", operation_id: newOperationId(), summary: "ok", execution_boundary: "hook" } as GuardDecision;
}

function payload(event: string, toolInput: unknown = { file_path: "README.md" }, toolName = "Read"): string {
  return JSON.stringify({
    session_id: "deadline-session", cwd: "/srv/worktrees/deadline", hook_event_name: event,
    ...(event === "UserPromptSubmit" ? { prompt: "continue" } : {}),
    ...(event === "PreToolUse" || event === "PostToolUse" ? { tool_name: toolName, tool_input: toolInput, tool_use_id: "call-1" } : {}),
    ...(event === "PostToolUse" ? { tool_response: { success: true } } : {}),
    ...(event === "SessionEnd" ? { reason: "other", transcript_path: "/fixture/transcript" } : {}),
  });
}

function fakeIo() {
  const clock = { t: 0 };
  const timers: { at: number; callback: () => void; cleared: boolean }[] = [];
  const io = {
    now: () => clock.t,
    setTimer: vi.fn((callback: () => void, delayMs: number) => {
      const entry = { at: clock.t + delayMs, callback, cleared: false };
      timers.push(entry);
      return { clear: () => { entry.cleared = true; } };
    }),
    write: vi.fn(async (_stdout: string) => undefined),
    exit: vi.fn(),
  };
  return {
    io: io as HookDeadlineIo & typeof io,
    clock,
    timers,
    advance(ms: number) {
      clock.t += ms;
      for (const entry of timers) {
        if (!entry.cleared && entry.at <= clock.t) {
          entry.cleared = true;
          entry.callback();
        }
      }
    },
  };
}

async function context(mode: "observe" | "enforce"): Promise<HookRunContext> {
  const root = await mkdtemp(join(tmpdir(), "jhw-hook-deadline-"));
  roots.push(root);
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  return { stateDir, mode };
}

async function rows(ctx: HookRunContext): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(join(ctx.stateDir, "guard-hook-diagnostics.v1.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function port(evaluate: () => Promise<GuardDecision>): HookGuardPort {
  const unused = async (): Promise<never> => { throw new TypeError("unused"); };
  return { submitUserPrompt: unused, evaluatePreTool: evaluate, completePostTool: unused, recordSessionEnd: unused };
}

const argv = ["--adapter", "claude", "--event", "PreToolUse"];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function hanging() {
  let settle!: (decision: GuardDecision) => void;
  const evaluate = vi.fn(() => new Promise<GuardDecision>((resolve) => { settle = resolve; }));
  return { evaluate, settle: (decision: GuardDecision) => settle(decision) };
}

describe("PreToolUse decision deadline", () => {
  it("keeps the deadline between the Registry lock wait and the runner watchdog", () => {
    expect(HOOK_DECISION_DEADLINE_MS).toBeGreaterThan(5 * 1000 + 1_000);
    expect(HOOK_DECISION_DEADLINE_MS).toBeLessThan(8_000 - 1_000);
    expect(HOOK_LATENCY_WARNING_MS).toBe(HOOK_DECISION_DEADLINE_MS / 2);
  });

  it("answers an observe decision that never settles with one neutral allow and a deadline row", async () => {
    const ctx = await context("observe");
    const f = fakeIo();
    const guard = hanging();
    const run = runHookAdapterWithDeadline(argv, payload("PreToolUse"), port(guard.evaluate), f.io, ctx);
    await flush();
    expect(f.io.write).not.toHaveBeenCalled();

    f.advance(HOOK_DECISION_DEADLINE_MS);
    await vi.waitFor(() => expect(f.io.exit).toHaveBeenCalledOnce());
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith(NEUTRAL);
    expect(await rows(ctx)).toEqual([expect.objectContaining({
      v: 1, adapter: "claude", event: "PreToolUse", mode: "observe", kind: "deadline",
      code: "GUARD_DEADLINE_EXCEEDED", elapsed_ms: HOOK_DECISION_DEADLINE_MS,
    })]);

    guard.settle(allow());
    await run;
    expect(f.io.write).toHaveBeenCalledOnce();
    expect(await rows(ctx)).toHaveLength(1);
  });

  it("denies with GUARD_DEADLINE_EXCEEDED in enforce", async () => {
    const ctx = await context("enforce");
    const f = fakeIo();
    const guard = hanging();
    const run = runHookAdapterWithDeadline(argv, payload("PreToolUse"), port(guard.evaluate), f.io, ctx);
    await flush();
    f.advance(HOOK_DECISION_DEADLINE_MS);
    await vi.waitFor(() => expect(f.io.exit).toHaveBeenCalledOnce());
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith(DEADLINE_DENY);
    expect(JSON.parse(DEADLINE_DENY)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "GUARD_DEADLINE_EXCEEDED" },
      systemMessage: "GUARD_DEADLINE_EXCEEDED",
    });
    expect(await rows(ctx)).toEqual([expect.objectContaining({ mode: "enforce", kind: "deadline" })]);
    guard.settle(allow());
    await run;
    expect(f.io.write).toHaveBeenCalledOnce();
  });

  it("denies a self-approving command at the deadline even in observe", async () => {
    const ctx = await context("observe");
    const f = fakeIo();
    const guard = hanging();
    const run = runHookAdapterWithDeadline(
      argv, payload("PreToolUse", { command: approval }, "Bash"), port(guard.evaluate), f.io, ctx,
    );
    await flush();
    f.advance(HOOK_DECISION_DEADLINE_MS);
    await vi.waitFor(() => expect(f.io.exit).toHaveBeenCalledOnce());
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith(DEADLINE_DENY);
    guard.settle(allow());
    await run;
  });

  it("emits a fast decision once, disarms the timer and writes no row", async () => {
    const ctx = await context("observe");
    const f = fakeIo();
    f.clock.t = 120;
    const result = await runHookAdapterWithDeadline(
      argv, payload("PreToolUse"), port(async () => allow()), f.io, ctx,
    );
    expect(result.stdout).toBe(NEUTRAL);
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith(NEUTRAL);
    expect(f.timers).toHaveLength(1);
    expect(f.timers.every((entry) => entry.cleared)).toBe(true);
    f.advance(HOOK_DECISION_DEADLINE_MS * 2);
    expect(f.io.exit).not.toHaveBeenCalled();
    expect(await rows(ctx)).toEqual([]);
  });

  it.each([
    [3_300, 1],
    [3_200, 0],
  ])("records latency only above the warning: settled at %i ms gives %i row", async (elapsed, count) => {
    const ctx = await context("observe");
    const f = fakeIo();
    const result = await runHookAdapterWithDeadline(
      argv, payload("PreToolUse"), port(async () => { f.clock.t = elapsed; return allow(); }), f.io, ctx,
    );
    expect(result.stdout).toBe(NEUTRAL);
    expect(result.stderr).toBe("");
    expect(f.io.write).toHaveBeenCalledExactlyOnceWith(NEUTRAL);
    expect(await rows(ctx)).toEqual(count === 0 ? [] : [expect.objectContaining({
      kind: "latency", elapsed_ms: elapsed, mode: "observe",
    })]);
  });

  it("skips the diagnostics write once more than 7,000 ms have passed after stdout", async () => {
    const ctx = await context("enforce");
    const f = fakeIo();
    await runHookAdapterWithDeadline(
      argv, payload("PreToolUse"), port(async () => { f.clock.t = 7_100; return allow(); }), f.io, ctx,
    );
    expect(f.io.write).toHaveBeenCalledOnce();
    expect(await rows(ctx)).toEqual([]);
  });

  describe("stdout write failure", () => {
    it.each(["observe", "enforce"] as const)("resolves, writes once and records nothing when stdout rejects in %s", async (mode) => {
      const ctx = await context(mode);
      const f = fakeIo();
      f.io.write.mockImplementation(async () => { throw new Error("EPIPE"); });
      const result = await runHookAdapterWithDeadline(argv, payload("PreToolUse"), port(async () => allow()), f.io, ctx);
      expect(result.exitCode).toBe(0);
      expect(f.io.write).toHaveBeenCalledOnce();
      expect(result.stdout).toBe(f.io.write.mock.calls[0]![0]);
      expect(f.io.exit).not.toHaveBeenCalled();
      expect(await rows(ctx)).toEqual([]);
    });

    it("keeps a render failure in observe a neutral allow with one GUARD_PROTOCOL_MISMATCH row", async () => {
      const ctx = await context("observe");
      const f = fakeIo();
      const result = await runHookAdapterWithDeadline(
        argv, payload("PreToolUse"), port(async () => ({ decision: "BOGUS" }) as never), f.io, ctx,
      );
      expect(result.stdout).toBe(NEUTRAL);
      expect(f.io.write).toHaveBeenCalledExactlyOnceWith(NEUTRAL);
      expect(await rows(ctx)).toEqual([expect.objectContaining({
        kind: "unrecorded_allow", code: "GUARD_PROTOCOL_MISMATCH", mode: "observe",
      })]);
    });
  });

  describe("observe self-failure allow", () => {
    const withoutSession = JSON.stringify((({ session_id: _session, ...rest }) => rest)(JSON.parse(payload("PreToolUse"))));
    const failures = [
      ["a decode failure", withoutSession, async () => allow(), "decode_failure"],
      ["a provider failure", payload("PreToolUse"), async (): Promise<GuardDecision> => { throw new Error("boom"); }, "unrecorded_allow"],
    ] as const;

    it.each(failures)("writes the allow of %s to stdout before its diagnostics row", async (_label, raw, evaluate, kind) => {
      const ctx = await context("observe");
      const f = fakeIo();
      let rowsAtWrite = -1;
      f.io.write.mockImplementation(async () => { rowsAtWrite = (await rows(ctx)).length; });
      const result = await runHookAdapterWithDeadline(argv, raw, port(evaluate), f.io, ctx);
      expect(result.stdout).toBe(NEUTRAL);
      expect(rowsAtWrite).toBe(0);
      expect(await rows(ctx)).toEqual([expect.objectContaining({ kind, mode: "observe" })]);
    });

    it.each(failures)("skips the diagnostics row of %s once more than 7,000 ms have passed", async (_label, raw, evaluate) => {
      const ctx = await context("observe");
      const f = fakeIo();
      f.clock.t = 7_100;
      const result = await runHookAdapterWithDeadline(argv, raw, port(evaluate), f.io, ctx);
      expect(result.stdout).toBe(NEUTRAL);
      expect(f.io.write).toHaveBeenCalledExactlyOnceWith(NEUTRAL);
      expect(await rows(ctx)).toEqual([]);
    });
  });

  describe("exit after a committed decision with a slow diagnostics append", () => {
    const failures = [
      ["a slow decision", payload("PreToolUse"), async (f: ReturnType<typeof fakeIo>) => { f.clock.t = 3_300; return allow(); }],
      ["an observe self-failure", payload("PreToolUse"), async (): Promise<GuardDecision> => { throw new Error("boom"); }],
    ] as const;

    it.each(failures)("requests exit 0 within the bound after the stdout write of %s", async (_label, raw, evaluate) => {
      const ctx = await context("observe");
      const f = fakeIo();
      const order: string[] = [];
      f.io.write.mockImplementation(async () => { order.push("write"); });
      f.io.exit.mockImplementation(() => { order.push("exit"); });
      slowAppend.delayMs = 2_000;
      const started = Date.now();
      const result = await runHookAdapterWithDeadline(argv, raw, port(() => evaluate(f)), f.io, ctx);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result.exitCode).toBe(0);
      expect(order).toEqual(["write", "exit"]);
      expect(f.io.exit).toHaveBeenCalledOnce();
    });
  });

  it("does not let a slow diagnostics append started inside the Guard call hold the verdict or the process", async () => {
    const ctx = await context("observe");
    const f = fakeIo();
    const order: string[] = [];
    f.io.write.mockImplementation(async () => { order.push("write"); });
    f.io.exit.mockImplementation(() => { order.push("exit"); });
    slowAppend.delayMs = 2_000;
    const guard = port(async () => {
      await recordBoundedDiagnostic(ctx, { adapter: "claude", event: "PreToolUse", kind: "unrecorded_allow" }, f.io);
      return allow();
    });
    const started = Date.now();
    const result = await runHookAdapterWithDeadline(argv, payload("PreToolUse"), guard, f.io, ctx);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(["write", "exit"]);
    expect(f.io.exit).toHaveBeenCalledOnce();
  });

  it.each(["UserPromptSubmit", "PostToolUse", "SessionEnd"] as const)(
    "arms no timer for %s and leaves its output unchanged",
    async (event) => {
      const f = fakeIo();
      const side = vi.fn(async () => ({ status: "NO_STATE_CHANGE", summary: "ok" }));
      const guard: HookGuardPort = {
        submitUserPrompt: side as never,
        evaluatePreTool: async () => allow(),
        completePostTool: side as never,
        recordSessionEnd: async () => ({ status: "NO_MATCH" }),
      };
      const eventArgv = ["--adapter", "claude", "--event", event];
      const withDeadline = await runHookAdapterWithDeadline(eventArgv, payload(event), guard, f.io);
      expect(f.io.setTimer).not.toHaveBeenCalled();
      expect(withDeadline).toEqual(await runHookAdapter(eventArgv, payload(event), guard));
      expect(f.io.write).toHaveBeenCalledExactlyOnceWith(withDeadline.stdout);
    },
  );
});
