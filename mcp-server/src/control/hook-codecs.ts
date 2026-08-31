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
const transcriptPath = coordinate(4_096);
const nullableTranscriptPath = transcriptPath.nullable();
const claudePermissionMode = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);
const codexPermissionMode = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);
const documentedAgentMetadata = {
  agent_id: coordinate(255).optional(),
  agent_type: coordinate(255).optional(),
};

// Keep the two native schema sets distinct. Task 2 can refine one adapter from
// recorded fixtures without silently widening the other adapter's parser.
// Claude Code 2.1.246 documents these optional common hook fields. Agent
// metadata is accepted but never copied into Guard authority coordinates.
const ClaudeUserPromptSubmitSchema = z.object({
  session_id: coordinate(255),
  ...documentedAgentMetadata,
  prompt_id: coordinate(255).optional(),
  transcript_path: transcriptPath.optional(),
  cwd,
  permission_mode: claudePermissionMode.optional(),
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt,
}).strict();
const ClaudePreToolUseSchema = z.object({
  session_id: coordinate(255),
  ...documentedAgentMetadata,
  prompt_id: coordinate(255).optional(),
  transcript_path: transcriptPath.optional(),
  cwd,
  permission_mode: claudePermissionMode.optional(),
  hook_event_name: z.literal("PreToolUse"),
  tool_name: coordinate(64),
  tool_input: toolInput,
  tool_use_id: coordinate(255),
}).strict();
const ClaudePostToolUseSchema = z.object({
  session_id: coordinate(255),
  ...documentedAgentMetadata,
  prompt_id: coordinate(255).optional(),
  transcript_path: transcriptPath.optional(),
  cwd,
  permission_mode: claudePermissionMode.optional(),
  hook_event_name: z.literal("PostToolUse"),
  tool_name: coordinate(64),
  tool_input: toolInput,
  tool_response: z.unknown().optional(),
  tool_use_id: coordinate(255),
  duration_ms: z.number().finite().nonnegative().optional(),
}).strict();

// Codex CLI 0.149.1 generated command-hook schemas document the metadata
// below. The Guard keeps its narrower object-only tool input authority while
// accepting the documented metadata and rejecting every unknown field.
const CodexUserPromptSubmitSchema = z.object({
  cwd,
  ...documentedAgentMetadata,
  hook_event_name: z.literal("UserPromptSubmit"),
  model: coordinate(255).optional(),
  permission_mode: codexPermissionMode.optional(),
  prompt,
  session_id: coordinate(255),
  transcript_path: nullableTranscriptPath.optional(),
  turn_id: coordinate(255).optional(),
}).strict();
const CodexPreToolUseSchema = z.object({
  cwd,
  ...documentedAgentMetadata,
  hook_event_name: z.literal("PreToolUse"),
  model: coordinate(255).optional(),
  permission_mode: codexPermissionMode.optional(),
  session_id: coordinate(255),
  tool_input: toolInput,
  tool_name: coordinate(64),
  tool_use_id: coordinate(255),
  transcript_path: nullableTranscriptPath.optional(),
  turn_id: coordinate(255).optional(),
}).strict();
const CodexPostToolUseSchema = z.object({
  cwd,
  ...documentedAgentMetadata,
  hook_event_name: z.literal("PostToolUse"),
  model: coordinate(255).optional(),
  permission_mode: codexPermissionMode.optional(),
  session_id: coordinate(255),
  tool_input: toolInput,
  tool_name: coordinate(64),
  tool_response: z.unknown().optional(),
  tool_use_id: coordinate(255),
  transcript_path: nullableTranscriptPath.optional(),
  turn_id: coordinate(255).optional(),
}).strict();

const preToolNeutralOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PreToolUse"),
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
  preToolNeutralOutputSchema,
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

type NativeSchemaSet = Readonly<Record<HookEventName, z.ZodTypeAny>>;

function decodeNative(
  adapter: "claude" | "codex",
  schemas: NativeSchemaSet,
  event: HookEventName,
  raw: unknown,
): GuardCommonEvent {
  if (event === "UserPromptSubmit") {
    const native = schemas.UserPromptSubmit.parse(raw) as { session_id: string; prompt: string };
    return GuardCommonEventSchema.parse({
      protocol_version: 1,
      adapter,
      event: "user_prompt_submit",
      session_id: native.session_id,
      prompt: native.prompt,
    });
  }
  if (event === "PreToolUse") {
    const native = schemas.PreToolUse.parse(raw) as {
      session_id: string;
      cwd: string;
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
    };
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
  const native = schemas.PostToolUse.parse(raw) as { session_id: string; tool_use_id: string };
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

export interface AdapterContractResult {
  contract_version: 1;
  adapter: "claude" | "codex";
  native_version: string;
  fixture_axes: Readonly<{
    prompt_origin: true;
    pre_tool_block: true;
    post_tool_correlation: true;
  }>;
}

export const adapterContractResults: Readonly<Record<"claude" | "codex", AdapterContractResult>> = Object.freeze({
  claude: Object.freeze({
    contract_version: 1,
    adapter: "claude",
    native_version: "2.1.246",
    fixture_axes: Object.freeze({ prompt_origin: true, pre_tool_block: true, post_tool_correlation: true }),
  }),
  codex: Object.freeze({
    contract_version: 1,
    adapter: "codex",
    native_version: "0.149.1",
    fixture_axes: Object.freeze({ prompt_origin: true, pre_tool_block: true, post_tool_correlation: true }),
  }),
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
