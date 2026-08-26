import { describe, expect, it } from "vitest";

import type { GuardCommonEvent } from "../guard-protocol.js";
import type { GuardSideEventResult } from "../guard-service.js";
import type { GuardDecision } from "../schemas.js";

type HookEventName = "UserPromptSubmit" | "PreToolUse" | "PostToolUse";

interface HookCodecContract {
  decode(event: HookEventName, raw: unknown): GuardCommonEvent;
  renderPrompt(result: GuardSideEventResult): unknown;
  renderPreTool(result: GuardDecision): unknown;
  renderPostTool(result: GuardSideEventResult): unknown;
  renderFailure(
    event: HookEventName,
    code: "GUARD_UNAVAILABLE" | "GUARD_PROTOCOL_MISMATCH",
  ): unknown;
}

interface HookCodecsModule {
  claudeHookCodec: HookCodecContract;
  codexHookCodec: HookCodecContract;
}

const modulePath = "../hook-codecs.js";
const loadCodecs = async (): Promise<HookCodecsModule> =>
  import(modulePath) as Promise<HookCodecsModule>;

const REQUEST_ID = "req-018f21e0-7b2c-7a00-8000-000000000003";
const OPERATION_ID = "op-018f21e0-7b2c-7a00-8000-000000000004";

const nativePayload = {
  UserPromptSubmit: {
    session_id: "native-session-17",
    cwd: "/srv/worktrees/native-17",
    hook_event_name: "UserPromptSubmit",
    prompt: `/jhw:unlock ${REQUEST_ID}`,
  },
  PreToolUse: {
    session_id: "native-session-17",
    cwd: "/srv/worktrees/native-17",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push origin HEAD" },
    tool_use_id: "call-native-17",
  },
  PostToolUse: {
    session_id: "native-session-17",
    cwd: "/srv/worktrees/native-17",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push origin HEAD" },
    tool_use_id: "call-native-17",
  },
} as const;

const adapters = [
  ["claude", "claudeHookCodec"],
  ["codex", "codexHookCodec"],
] as const;

describe("native hook input codecs", () => {
  it("keeps Claude and Codex as separate codec authorities", async () => {
    // Break caught: one permissive shared object silently accepts schema drift in both adapters.
    const codecs = await loadCodecs();
    expect(codecs.claudeHookCodec).not.toBe(codecs.codexHookCodec);
  });

  it.each(adapters)("maps exact snake_case %s coordinates into Guard events", async (adapter, key) => {
    // Break caught: a native coordinate is renamed, dropped, synthesized, or mapped to the wrong Guard variant.
    const codec = (await loadCodecs())[key];

    expect(codec.decode("UserPromptSubmit", nativePayload.UserPromptSubmit)).toEqual({
      protocol_version: 1,
      adapter,
      event: "user_prompt_submit",
      session_id: "native-session-17",
      prompt: `/jhw:unlock ${REQUEST_ID}`,
    });
    expect(codec.decode("PreToolUse", nativePayload.PreToolUse)).toEqual({
      protocol_version: 1,
      adapter,
      event: "pre_tool_use",
      session_id: "native-session-17",
      cwd: "/srv/worktrees/native-17",
      tool_name: "Bash",
      tool_input: { command: "git push origin HEAD" },
      tool_use_id: "call-native-17",
    });
    expect(codec.decode("PostToolUse", nativePayload.PostToolUse)).toEqual({
      protocol_version: 1,
      adapter,
      event: "post_tool_use",
      session_id: "native-session-17",
      tool_use_id: "call-native-17",
      ok: true,
    });
  });

  it.each(adapters)("uses only prompt as the authoritative %s prompt field", async (_adapter, key) => {
    // Break caught: fallback text such as user_prompt or an embedded transcript can approve a permit.
    const codec = (await loadCodecs())[key];
    const raw = {
      ...nativePayload.UserPromptSubmit,
      prompt: "literal-user-prompt",
      user_prompt: `/jhw:unlock ${REQUEST_ID}`,
    };

    expect(() => codec.decode("UserPromptSubmit", raw)).toThrow();
    expect(() => codec.decode("UserPromptSubmit", {
      session_id: raw.session_id,
      cwd: raw.cwd,
      hook_event_name: raw.hook_event_name,
      user_prompt: raw.user_prompt,
    })).toThrow();
  });

  it.each(adapters)("rejects %s event argument and payload disagreement", async (_adapter, key) => {
    // Break caught: a PreToolUse payload is decoded through a less restrictive side-event branch.
    const codec = (await loadCodecs())[key];
    for (const event of ["UserPromptSubmit", "PostToolUse"] as const) {
      expect(() => codec.decode(event, nativePayload.PreToolUse)).toThrow();
    }
  });

  it.each(adapters)("rejects missing and empty required %s coordinates", async (_adapter, key) => {
    // Break caught: deleting or emptying any event-required native coordinate reaches Guard as ambient/default state.
    const codec = (await loadCodecs())[key];
    const cases: Array<[HookEventName, Record<string, unknown>, readonly string[]]> = [
      [
        "UserPromptSubmit",
        nativePayload.UserPromptSubmit,
        ["session_id", "cwd", "prompt"],
      ],
      [
        "PreToolUse",
        nativePayload.PreToolUse,
        ["session_id", "cwd", "tool_name", "tool_input", "tool_use_id"],
      ],
      [
        "PostToolUse",
        nativePayload.PostToolUse,
        ["session_id", "cwd", "tool_name", "tool_input", "tool_use_id"],
      ],
    ];
    for (const [event, fixture, fields] of cases) {
      for (const field of fields) {
        const missing = { ...fixture };
        delete missing[field];
        expect(() => codec.decode(event, missing), `${event}.${field} missing`).toThrow();
        expect(
          () => codec.decode(event, { ...fixture, [field]: "" }),
          `${event}.${field} empty`,
        ).toThrow();
      }
    }
  });

  it.each(adapters)("rejects unknown top-level %s payload fields", async (_adapter, key) => {
    // Break caught: a permissive passthrough begins treating unreviewed native fields as adapter authority.
    const codec = (await loadCodecs())[key];
    expect(() => codec.decode("PreToolUse", {
      ...nativePayload.PreToolUse,
      prompt: `/jhw:unlock ${REQUEST_ID}`,
    })).toThrow();
  });
});

describe("native hook response renderers", () => {
  it.each(adapters)("renders the exact %s hard-deny object", async (_adapter, key) => {
    // Break caught: a hard deny becomes an allow, advisory-only message, or non-native response shape.
    const codec = (await loadCodecs())[key];
    expect(codec.renderPreTool({
      decision: "DENY",
      code: "GUARD_WORKTREE_MISMATCH",
      summary: "Worktree identity does not match",
    })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "GUARD_WORKTREE_MISMATCH",
      },
      systemMessage: "GUARD_WORKTREE_MISMATCH",
    });
  });

  it.each(adapters)("renders exact %s allow semantics without advisory denial", async (_adapter, key) => {
    // Break caught: an authoritative ALLOW is omitted or rendered with a stale deny message.
    const codec = (await loadCodecs())[key];
    expect(codec.renderPreTool({
      decision: "ALLOW",
      operation_id: OPERATION_ID,
      summary: "Read repository status",
      execution_boundary: "hook",
    })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  it.each(adapters)("renders bounded %s permit instructions exactly once per native message", async (_adapter, key) => {
    // Break caught: adapter-generated approval syntax or duplicate commands make the one-shot permit ambiguous.
    const codec = (await loadCodecs())[key];
    const approvalCommand = `/jhw:unlock ${REQUEST_ID}`;
    const expectedMessage = `PERMIT_REQUIRED\nRun the protected board probe\n${approvalCommand}`;
    const rendered = codec.renderPreTool({
      decision: "PERMIT_REQUIRED",
      operation_id: OPERATION_ID,
      request_id: REQUEST_ID,
      summary: "Run the protected board probe",
      approval_command: approvalCommand,
      approval_expires_at: "2026-08-25T06:10:00.000Z",
    });

    expect(rendered).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expectedMessage,
      },
      systemMessage: expectedMessage,
    });
    const native = rendered as {
      hookSpecificOutput: { permissionDecisionReason: string };
      systemMessage: string;
    };
    for (const message of [native.hookSpecificOutput.permissionDecisionReason, native.systemMessage]) {
      expect(message.split(approvalCommand)).toHaveLength(2);
      expect(message.split("Run the protected board probe")).toHaveLength(2);
    }
  });

  it.each(adapters)("renders bounded %s prompt context and post-tool warnings", async (_adapter, key) => {
    // Break caught: side-event results disappear, so users lose current Task context or completion warnings.
    const codec = (await loadCodecs())[key];
    const promptResult: GuardSideEventResult = {
      status: "NO_STATE_CHANGE",
      event: "user_prompt_submit",
      summary: "Prompt did not change Guard authority",
      context: {
        task_id: "tsk-018f21e0-7b2c-7a00-8000-000000000001",
        claim_id: "clm-018f21e0-7b2c-7a00-8000-000000000002",
        task_alias: "local-hardening",
        work_contract_digest: "a".repeat(64),
      },
    };
    const postResult: GuardSideEventResult = {
      status: "DENY",
      event: "post_tool_use",
      code: "GUARD_PERMIT_MISMATCH",
      summary: "Guard permit binding does not match",
    };

    const prompt = JSON.stringify(codec.renderPrompt(promptResult));
    const post = JSON.stringify(codec.renderPostTool(postResult));
    expect(prompt).toContain("Prompt did not change Guard authority");
    expect(prompt).toContain("local-hardening");
    expect(prompt).toContain("tsk-018f21e0-7b2c-7a00-8000-000000000001");
    expect(post).toContain("GUARD_PERMIT_MISMATCH");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(Buffer.byteLength(post, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it.each(adapters)("never reflects raw %s prompt or tool input bytes", async (_adapter, key) => {
    // Break caught: failure/decision rendering serializes the native request and leaks prompt or tool arguments.
    const codec = (await loadCodecs())[key];
    const promptSecret = "prompt-secret-7c592c";
    const toolSecret = "tool-input-secret-6f41e9";
    const decodedPrompt = codec.decode("UserPromptSubmit", {
      ...nativePayload.UserPromptSubmit,
      prompt: promptSecret,
    });
    const decodedTool = codec.decode("PreToolUse", {
      ...nativePayload.PreToolUse,
      tool_input: { command: `deploy --token=${toolSecret}` },
    });
    const rendered = JSON.stringify([
      decodedPrompt.event === "user_prompt_submit"
        ? codec.renderPrompt({
          status: "DENY",
          event: "user_prompt_submit",
          code: "GUARD_PROTOCOL_MISMATCH",
          summary: "Guard protocol input is invalid",
        })
        : null,
      decodedTool.event === "pre_tool_use"
        ? codec.renderPreTool({
          decision: "DENY",
          code: "GUARD_UNAVAILABLE",
          summary: "Guard state or authority is unavailable",
        })
        : null,
      codec.renderFailure("PreToolUse", "GUARD_UNAVAILABLE"),
    ]);

    expect(rendered).not.toContain(promptSecret);
    expect(rendered).not.toContain(toolSecret);
  });

  it.each(adapters)("renders fail-closed %s transport failures for all events", async (_adapter, key) => {
    // Break caught: a transport failure returns an empty object and native PreToolUse silently continues.
    const codec = (await loadCodecs())[key];
    expect(codec.renderFailure("PreToolUse", "GUARD_UNAVAILABLE")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "GUARD_UNAVAILABLE",
      },
      systemMessage: "GUARD_UNAVAILABLE",
    });
    expect(JSON.stringify(codec.renderFailure("UserPromptSubmit", "GUARD_PROTOCOL_MISMATCH")))
      .toContain("GUARD_PROTOCOL_MISMATCH");
    expect(JSON.stringify(codec.renderFailure("PostToolUse", "GUARD_UNAVAILABLE")))
      .toContain("GUARD_UNAVAILABLE");
  });
});
