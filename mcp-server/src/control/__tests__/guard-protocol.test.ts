import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CanonicalOperationSchema,
  GUARD_UNLOCK_PREFIX,
  GuardCommonEventSchema,
  GuardProtocolVersion,
  MAX_TOOL_INPUT_BYTES,
  OperationRequirementSchema,
  parseGuardUnlockPrompt,
  type GuardCommonEventInput,
  type GuardCommonEventOutput,
} from "../guard-protocol.js";

const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000002";

const preTool = {
  protocol_version: 1,
  adapter: "codex",
  event: "pre_tool_use",
  session_id: "codex-local-hardening",
  cwd: "/srv/worktrees/tsk-local/clm-local",
  tool_name: "Bash",
  tool_input: { command: "git push origin HEAD" },
  tool_use_id: "call-17",
} satisfies GuardCommonEventInput;

describe("Guard common protocol", () => {
  it("accepts only the three strict version-one event variants", () => {
    const events: GuardCommonEventInput[] = [
      preTool,
      {
        protocol_version: GuardProtocolVersion,
        adapter: "claude",
        event: "post_tool_use",
        session_id: "claude-local-hardening",
        tool_use_id: "call-18",
        ok: false,
      },
      {
        protocol_version: GuardProtocolVersion,
        adapter: "gemini",
        event: "user_prompt_submit",
        session_id: "gemini-local-hardening",
        prompt: "/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000003",
      },
    ];

    for (const event of events) {
      const output: GuardCommonEventOutput = GuardCommonEventSchema.parse(event);
      expect(output).toEqual(event);
    }
  });

  it("rejects unknown protocol versions and top-level fields on every variant", () => {
    const invalid = [
      { ...preTool, protocol_version: 2 },
      { ...preTool, extra: true },
      {
        protocol_version: 1,
        adapter: "codex",
        event: "post_tool_use",
        session_id: "codex-local-hardening",
        tool_use_id: "call-17",
        ok: true,
        tool_output: { secret: "must-not-cross-the-protocol" },
      },
      {
        protocol_version: 1,
        adapter: "codex",
        event: "user_prompt_submit",
        session_id: "codex-local-hardening",
        prompt: "ok",
        cwd: "/private/worktree",
      },
    ];

    for (const event of invalid) expect(GuardCommonEventSchema.safeParse(event).success).toBe(false);
  });

  it("requires an exact boolean post-tool outcome and no raw output", () => {
    const base = {
      protocol_version: 1,
      adapter: "opencode",
      event: "post_tool_use",
      session_id: "opencode-local-hardening",
      tool_use_id: "call-19",
    };

    expect(GuardCommonEventSchema.safeParse({ ...base, ok: true }).success).toBe(true);
    for (const ok of [1, "true", null, undefined]) {
      expect(GuardCommonEventSchema.safeParse({ ...base, ok }).success).toBe(false);
    }
  });

  it("accepts tool input strings above 16 KiB and totals above 64 KiB (#247)", () => {
    // Break caught: the generic 16 KiB string / 64 KiB total default rejected large Write, Edit and apply_patch input.
    for (const tool_input of [
      { file_path: "src/file.ts", content: "x".repeat(17 * 1024) },
      { file_path: "src/file.ts", content: "x".repeat(1024 * 1024) },
      { chunks: ["a".repeat(16_384), "b".repeat(16_384), "c".repeat(16_384), "d".repeat(16_384)] },
    ]) {
      expect(GuardCommonEventSchema.safeParse({ ...preTool, tool_input }).success).toBe(true);
    }
  });

  it("rejects tool input whose canonical serialized UTF-8 size exceeds the 8 MiB tool-input limit", () => {
    expect(MAX_TOOL_INPUT_BYTES).toBe(8 * 1024 * 1024);
    const envelope = Buffer.byteLength('{"content":""}', "utf8");
    const exact = { content: "x".repeat(MAX_TOOL_INPUT_BYTES - envelope) };
    const over = { content: "x".repeat(MAX_TOOL_INPUT_BYTES - envelope + 1) };
    const half = MAX_TOOL_INPUT_BYTES / 2;

    expect(GuardCommonEventSchema.safeParse({ ...preTool, tool_input: exact }).success).toBe(true);
    expect(GuardCommonEventSchema.safeParse({ ...preTool, tool_input: over }).success).toBe(false);
    expect(GuardCommonEventSchema.safeParse({
      ...preTool,
      tool_input: { chunks: ["a".repeat(half), "b".repeat(half)] },
    }).success).toBe(false);
  });

  it("keeps the 64 KiB prompt bound separate from the tool-input limit", () => {
    const prompt = (bytes: number) => ({
      protocol_version: 1,
      adapter: "claude",
      event: "user_prompt_submit",
      session_id: "claude-local-hardening",
      prompt: "p".repeat(bytes),
    });

    expect(GuardCommonEventSchema.safeParse(prompt(64 * 1024)).success).toBe(true);
    expect(GuardCommonEventSchema.safeParse(prompt(64 * 1024 + 1)).success).toBe(false);
  });

  it("rejects non-JSON values, cycles, non-finite numbers, accessors, and authority-bearing prototypes", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "credential", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret";
      },
    });
    class AuthorityObject {
      readonly command = "git push";
    }
    const hostile = [
      { value: undefined },
      { value: () => undefined },
      { value: 1n },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      cycle,
      new Date(),
      new AuthorityObject(),
      accessor,
    ];

    for (const tool_input of hostile) {
      expect(GuardCommonEventSchema.safeParse({ ...preTool, tool_input }).success).toBe(false);
    }
    expect(getterCalls).toBe(0);
  });

  it("bounds JSON depth, node count, individual strings, keys, and sparse arrays", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 24; index += 1) deep = { child: deep };
    const sparse = new Array(4);
    sparse[3] = "only";
    const adorned = ["visible"];
    Object.defineProperty(adorned, "inherited_authority", { value: "git.push", enumerable: false });
    const cases = [
      deep,
      Array.from({ length: 2_100 }, () => null),
      { value: "x".repeat(MAX_TOOL_INPUT_BYTES + 1) },
      { ["k".repeat(300)]: true },
      sparse,
      adorned,
    ];

    for (const tool_input of cases) {
      expect(GuardCommonEventSchema.safeParse({ ...preTool, tool_input }).success).toBe(false);
    }
  });
});

describe("canonical Guard protocol", () => {
  it("uses strict capability plus canonical resource requirements without coordination", () => {
    expect(OperationRequirementSchema.parse({
      capability: "repo.modify",
      resource: { kind: "repository", id: "repo-wlan-package" },
    })).toEqual({
      capability: "repo.modify",
      resource: { kind: "repository", id: "repo-wlan-package" },
    });
    expect(OperationRequirementSchema.safeParse({
      capability: "repo.modify",
      resource: { kind: "repository", id: "repo-wlan-package" },
      coordination: "shared",
    }).success).toBe(false);
    expect(OperationRequirementSchema.safeParse({
      capability: "repo.modify",
      resource: { kind: "issue", id: "I_kwDOAb-123" },
    }).success).toBe(false);
  });

  it("rejects raw transport, cwd, command, prompt, and credential fields in canonical operations", () => {
    const canonical = {
      protocol_version: 1,
      operation_id: "op-018f21e0-7b2c-7a00-8000-000000000003",
      origin_adapter: "codex",
      evaluation_stage: "hook",
      session_id: "codex-local-hardening",
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      cwd_worktree_ref: "wt-local-hardening",
      tool: "shell",
      requirements: [{
        capability: "git.publish",
        resource: { kind: "repository", id: "repo-wlan-package" },
      }],
      risk: "high",
      execution_boundary: "guarded_command",
      summary: "git.publish repository:repo-wlan-package",
      digest: "a".repeat(64),
    };

    expect(CanonicalOperationSchema.safeParse(canonical).success).toBe(true);
    for (const field of ["tool_input", "command", "cwd", "prompt", "credential", "environment"]) {
      expect(CanonicalOperationSchema.safeParse({ ...canonical, [field]: "private" }).success).toBe(false);
    }
  });

  it("carries an optional known prompt source on user prompt events only", () => {
    const prompt = {
      protocol_version: 1,
      adapter: "claude",
      event: "user_prompt_submit",
      session_id: "claude-local-hardening",
      prompt: "hello",
    };
    expect(GuardCommonEventSchema.parse(prompt)).toEqual(prompt);
    for (const source of ["user", "sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event"]) {
      expect(GuardCommonEventSchema.parse({ ...prompt, prompt_source: source })).toMatchObject({ prompt_source: source });
    }
    expect(GuardCommonEventSchema.safeParse({ ...prompt, prompt_source: "operator" }).success).toBe(false);
    expect(GuardCommonEventSchema.safeParse({ ...preTool, prompt_source: "user" }).success).toBe(false);
  });
});

describe("Guard unlock prompt codec", () => {
  const id = "req-018f21e0-7b2c-7a00-8000-000000000003";

  it("classifies prompts as none, exact or malformed from one definition", () => {
    expect(GUARD_UNLOCK_PREFIX).toBe("/jhw:unlock");
    expect(parseGuardUnlockPrompt("ok")).toEqual({ kind: "none" });
    expect(parseGuardUnlockPrompt(` ${GUARD_UNLOCK_PREFIX} ${id}`)).toEqual({ kind: "none" });
    expect(parseGuardUnlockPrompt(`${GUARD_UNLOCK_PREFIX} ${id}`)).toEqual({ kind: "exact", request_id: id });
    for (const raw of [
      GUARD_UNLOCK_PREFIX,
      `${GUARD_UNLOCK_PREFIX} ${id}\n`,
      `${GUARD_UNLOCK_PREFIX} ${id} extra`,
      `${GUARD_UNLOCK_PREFIX} ${id.toUpperCase()}`,
      `${GUARD_UNLOCK_PREFIX}x ${id}`,
    ]) {
      expect(parseGuardUnlockPrompt(raw), raw).toEqual({ kind: "malformed" });
    }
  });

  it("is the only place in control sources that spells the reserved prefix", () => {
    const controlDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const offenders: string[] = [];
    for (const name of readdirSync(controlDir)) {
      if (!name.endsWith(".ts") || name === "guard-protocol.ts") continue;
      if (readFileSync(join(controlDir, name), "utf8").includes("jhw:unlock")) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
