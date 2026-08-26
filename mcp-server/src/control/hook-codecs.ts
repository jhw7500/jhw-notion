import { z } from "zod";

import {
  GuardCommonEventSchema,
  type GuardCommonEvent,
} from "./guard-protocol.js";
import type { GuardSideEventResult } from "./guard-service.js";
import type { GuardDecision } from "./schemas.js";

export const HookEventNameSchema = z.enum(["UserPromptSubmit", "PreToolUse", "PostToolUse"]);
export type HookEventName = z.infer<typeof HookEventNameSchema>;

const coordinate = (maximumBytes: number) => z.string()
  .min(1)
  .max(maximumBytes)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);
const cwd = coordinate(4_096);
const prompt = z.string()
  .min(1)
  .max(64 * 1024)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 64 * 1024);
const toolInput = z.record(z.unknown());

// Keep the two native schema sets distinct. Task 2 can refine one adapter from
// recorded fixtures without silently widening the other adapter's parser.
const ClaudeUserPromptSubmitSchema = z.object({
  session_id: coordinate(255),
  cwd,
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt,
}).strict();
const ClaudePreToolUseSchema = z.object({
  session_id: coordinate(255),
  cwd,
  hook_event_name: z.literal("PreToolUse"),
  tool_name: coordinate(64),
  tool_input: toolInput,
  tool_use_id: coordinate(255),
}).strict();
const ClaudePostToolUseSchema = z.object({
  session_id: coordinate(255),
  cwd,
  hook_event_name: z.literal("PostToolUse"),
  tool_name: coordinate(64),
  tool_input: toolInput,
  tool_use_id: coordinate(255),
}).strict();

const CodexUserPromptSubmitSchema = z.object({
  session_id: coordinate(255),
  cwd,
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt,
}).strict();
const CodexPreToolUseSchema = z.object({
  session_id: coordinate(255),
  cwd,
  hook_event_name: z.literal("PreToolUse"),
  tool_name: coordinate(64),
  tool_input: toolInput,
  tool_use_id: coordinate(255),
}).strict();
const CodexPostToolUseSchema = z.object({
  session_id: coordinate(255),
  cwd,
  hook_event_name: z.literal("PostToolUse"),
  tool_name: coordinate(64),
  tool_input: toolInput,
  tool_use_id: coordinate(255),
}).strict();

const preToolAllowOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PreToolUse"),
    permissionDecision: z.literal("allow"),
  }).strict(),
}).strict();
const preToolDenyOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PreToolUse"),
    permissionDecision: z.literal("deny"),
    permissionDecisionReason: z.string().min(1).max(2_048),
  }).strict(),
  systemMessage: z.string().min(1).max(2_048),
}).strict();
const promptOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("UserPromptSubmit"),
    additionalContext: z.string().min(1).max(4_096),
  }).strict(),
  systemMessage: z.string().min(1).max(4_096),
}).strict();
const postOutputSchema = z.object({
  systemMessage: z.string().min(1).max(4_096),
}).strict();

export const NativeHookOutputSchema = z.union([
  preToolAllowOutputSchema,
  preToolDenyOutputSchema,
  promptOutputSchema,
  postOutputSchema,
]);

export interface HookCodec {
  decode(event: HookEventName, raw: unknown): GuardCommonEvent;
  renderPrompt(result: GuardSideEventResult): unknown;
  renderPreTool(result: GuardDecision): unknown;
  renderPostTool(result: GuardSideEventResult): unknown;
  renderFailure(
    event: HookEventName,
    code: "GUARD_UNAVAILABLE" | "GUARD_PROTOCOL_MISMATCH",
  ): unknown;
}

type NativeSchemaSet = Readonly<{
  UserPromptSubmit: typeof ClaudeUserPromptSubmitSchema;
  PreToolUse: typeof ClaudePreToolUseSchema;
  PostToolUse: typeof ClaudePostToolUseSchema;
}>;

function decodeNative(
  adapter: "claude" | "codex",
  schemas: NativeSchemaSet,
  event: HookEventName,
  raw: unknown,
): GuardCommonEvent {
  if (event === "UserPromptSubmit") {
    const native = schemas.UserPromptSubmit.parse(raw);
    return GuardCommonEventSchema.parse({
      protocol_version: 1,
      adapter,
      event: "user_prompt_submit",
      session_id: native.session_id,
      prompt: native.prompt,
    });
  }
  if (event === "PreToolUse") {
    const native = schemas.PreToolUse.parse(raw);
    return GuardCommonEventSchema.parse({
      protocol_version: 1,
      adapter,
      event: "pre_tool_use",
      session_id: native.session_id,
      cwd: native.cwd,
      tool_name: native.tool_name,
      tool_input: native.tool_input,
      tool_use_id: native.tool_use_id,
    });
  }
  const native = schemas.PostToolUse.parse(raw);
  return GuardCommonEventSchema.parse({
    protocol_version: 1,
    adapter,
    event: "post_tool_use",
    session_id: native.session_id,
    tool_use_id: native.tool_use_id,
    ok: true,
  });
}

function promptMessage(result: GuardSideEventResult): string {
  if (result.status === "DENY") return result.code;
  const lines = [result.status, result.summary];
  if ("context" in result && result.context) {
    lines.push(
      `Task: ${result.context.task_alias}`,
      `Task ID: ${result.context.task_id}`,
      `Claim ID: ${result.context.claim_id}`,
      `Work Contract: ${result.context.work_contract_digest}`,
    );
  }
  if (result.status === "APPROVED") {
    lines.push(`Request ID: ${result.request_id}`, `Execution start by: ${result.start_by}`);
  }
  if ("journal_warning" in result && result.journal_warning) lines.push(result.journal_warning);
  return lines.join("\n");
}

function renderPrompt(result: GuardSideEventResult): unknown {
  const message = promptMessage(result);
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: message,
    },
    systemMessage: message,
  };
}

function renderPreTool(result: GuardDecision): unknown {
  if (result.decision === "ALLOW") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    };
  }
  const message = result.decision === "DENY"
    ? result.code
    : `PERMIT_REQUIRED\n${result.summary}\n${result.approval_command}`;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
    },
    systemMessage: message,
  };
}

function renderPostTool(result: GuardSideEventResult): unknown {
  const warning = "journal_warning" in result ? result.journal_warning : undefined;
  const message = result.status === "DENY"
    ? result.code
    : [result.summary, ...(warning ? [warning] : [])].join("\n");
  return { systemMessage: message };
}

export function renderStaticHookFailure(
  event: HookEventName,
  code: "GUARD_UNAVAILABLE" | "GUARD_PROTOCOL_MISMATCH",
): unknown {
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

const claudeSchemas: NativeSchemaSet = Object.freeze({
  UserPromptSubmit: ClaudeUserPromptSubmitSchema,
  PreToolUse: ClaudePreToolUseSchema,
  PostToolUse: ClaudePostToolUseSchema,
});
const codexSchemas: NativeSchemaSet = Object.freeze({
  UserPromptSubmit: CodexUserPromptSubmitSchema,
  PreToolUse: CodexPreToolUseSchema,
  PostToolUse: CodexPostToolUseSchema,
});

export const claudeHookCodec: HookCodec = Object.freeze({
  decode: (event: HookEventName, raw: unknown) => decodeNative("claude", claudeSchemas, event, raw),
  renderPrompt,
  renderPreTool,
  renderPostTool,
  renderFailure: renderStaticHookFailure,
});

export const codexHookCodec: HookCodec = Object.freeze({
  decode: (event: HookEventName, raw: unknown) => decodeNative("codex", codexSchemas, event, raw),
  renderPrompt,
  renderPreTool,
  renderPostTool,
  renderFailure: renderStaticHookFailure,
});
