import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  CAPABILITY_RESOURCE_COMPATIBILITY,
  CapabilitySchema,
  ResourceRefSchema,
  TaskIdSchema,
  type Capability,
  type ResourceRef,
} from "./work-contract.js";

export const GuardProtocolVersion = 1 as const;
export const MAX_GUARD_JSON_BYTES = 64 * 1024;

const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 2_048;
const MAX_JSON_STRING_BYTES = 16 * 1024;
const MAX_JSON_KEY_BYTES = 256;
const MAX_JSON_ARRAY_LENGTH = 2_048;
const MAX_JSON_OBJECT_KEYS = 256;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CanonicalJsonLimits {
  maximumBytes?: number;
  maximumDepth?: number;
  maximumNodes?: number;
  maximumStringBytes?: number;
  maximumKeyBytes?: number;
  maximumArrayLength?: number;
  maximumObjectKeys?: number;
}

function jsonFailure(message: string): never {
  throw new TypeError(message);
}

/**
 * Encodes the JSON data subset without invoking accessors or consulting a
 * custom prototype. Object keys are ordered, while arrays retain their exact
 * execution order. The traversal bounds apply before the encoded byte bound.
 */
export function encodeCanonicalJson(value: unknown, limits: CanonicalJsonLimits = {}): string {
  const maximumBytes = limits.maximumBytes ?? MAX_GUARD_JSON_BYTES;
  const maximumDepth = limits.maximumDepth ?? MAX_JSON_DEPTH;
  const maximumNodes = limits.maximumNodes ?? MAX_JSON_NODES;
  const maximumStringBytes = limits.maximumStringBytes ?? MAX_JSON_STRING_BYTES;
  const maximumKeyBytes = limits.maximumKeyBytes ?? MAX_JSON_KEY_BYTES;
  const maximumArrayLength = limits.maximumArrayLength ?? MAX_JSON_ARRAY_LENGTH;
  const maximumObjectKeys = limits.maximumObjectKeys ?? MAX_JSON_OBJECT_KEYS;
  const active = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > maximumNodes) jsonFailure("Canonical JSON node bound exceeded");
    if (depth > maximumDepth) jsonFailure("Canonical JSON depth bound exceeded");
    if (current === null) return "null";
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "number") {
      if (!Number.isFinite(current)) jsonFailure("Canonical JSON requires finite numbers");
      return Object.is(current, -0) ? "0" : JSON.stringify(current);
    }
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > maximumStringBytes) {
        jsonFailure("Canonical JSON string bound exceeded");
      }
      return JSON.stringify(current);
    }
    if (typeof current !== "object") jsonFailure("Unsupported canonical JSON value");
    if (active.has(current)) jsonFailure("Canonical JSON cannot contain cycles");
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > maximumArrayLength) jsonFailure("Canonical JSON array bound exceeded");
        const ownKeys = Reflect.ownKeys(current);
        if (
          ownKeys.some((key) => typeof key !== "string") ||
          ownKeys.length !== current.length + 1 ||
          !ownKeys.includes("length") ||
          Object.keys(current).length !== current.length
        ) {
          jsonFailure("Canonical JSON arrays must be dense and unadorned");
        }
        const encoded: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            jsonFailure("Canonical JSON arrays require enumerable data entries");
          }
          encoded.push(visit(descriptor.value, depth + 1));
        }
        return `[${encoded.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        jsonFailure("Canonical JSON objects cannot carry custom prototypes");
      }
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== "string")) {
        jsonFailure("Canonical JSON objects cannot contain symbol keys");
      }
      const stringKeys = keys as string[];
      if (stringKeys.length > maximumObjectKeys) jsonFailure("Canonical JSON object bound exceeded");
      stringKeys.sort();
      const encoded: string[] = [];
      for (const key of stringKeys) {
        if (Buffer.byteLength(key, "utf8") > maximumKeyBytes) jsonFailure("Canonical JSON key bound exceeded");
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          jsonFailure("Canonical JSON objects require enumerable data properties");
        }
        encoded.push(`${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`);
      }
      return `{${encoded.join(",")}}`;
    } finally {
      active.delete(current);
    }
  };

  const encoded = visit(value, 0);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) jsonFailure("Canonical JSON byte bound exceeded");
  return encoded;
}

function isBoundedJson(value: unknown): value is JsonValue {
  try {
    encodeCanonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

const boundedJsonValueSchema = z.custom<JsonValue>(isBoundedJson, "Expected bounded strict JSON data");
const boundedUtf8 = (maximumBytes: number, allowEmpty = false) => z.string()
  .min(allowEmpty ? 0 : 1)
  .max(maximumBytes)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);
const boundedCoordinate = (maximumBytes: number) => z.string()
  .min(1)
  .max(maximumBytes)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);

export const GuardAdapterSchema = z.enum(["claude", "codex", "gemini", "opencode"]);
export type GuardAdapter = z.infer<typeof GuardAdapterSchema>;
export const GuardSessionSchema = boundedCoordinate(255);
export const GuardWorktreeRefSchema = z.string().regex(/^wt-[a-z0-9][a-z0-9-]{1,120}$/);
export const GuardToolNameSchema = boundedCoordinate(64);
export const GuardToolUseIdSchema = boundedCoordinate(255);
export const ClaimIdSchema = z.string().regex(
  /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
export const RequestIdSchema = z.string().regex(
  /^req-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
export const OperationIdSchema = z.string().regex(
  /^op-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

const commonEventBase = {
  protocol_version: z.literal(GuardProtocolVersion),
  adapter: GuardAdapterSchema,
  session_id: GuardSessionSchema,
};

export const PreToolUseEventSchema = z.object({
  ...commonEventBase,
  event: z.literal("pre_tool_use"),
  cwd: boundedCoordinate(4_096).refine(isAbsolute, "cwd must be absolute"),
  tool_name: GuardToolNameSchema,
  tool_input: boundedJsonValueSchema,
  tool_use_id: GuardToolUseIdSchema,
}).strict();
export type PreToolUseEventInput = z.input<typeof PreToolUseEventSchema>;
export type PreToolUseEvent = z.output<typeof PreToolUseEventSchema>;

export const PostToolUseEventSchema = z.object({
  ...commonEventBase,
  event: z.literal("post_tool_use"),
  tool_use_id: GuardToolUseIdSchema,
  ok: z.boolean(),
}).strict();
export type PostToolUseEventInput = z.input<typeof PostToolUseEventSchema>;
export type PostToolUseEvent = z.output<typeof PostToolUseEventSchema>;

export const UserPromptSubmitEventSchema = z.object({
  ...commonEventBase,
  event: z.literal("user_prompt_submit"),
  prompt: boundedUtf8(MAX_GUARD_JSON_BYTES, true),
}).strict();
export type UserPromptSubmitEventInput = z.input<typeof UserPromptSubmitEventSchema>;
export type UserPromptSubmitEvent = z.output<typeof UserPromptSubmitEventSchema>;

export const GuardCommonEventSchema = z.discriminatedUnion("event", [
  PreToolUseEventSchema,
  PostToolUseEventSchema,
  UserPromptSubmitEventSchema,
]);
export type GuardCommonEventInput = z.input<typeof GuardCommonEventSchema>;
export type GuardCommonEventOutput = z.output<typeof GuardCommonEventSchema>;
export type GuardCommonEvent = GuardCommonEventOutput;

function capabilitySupportsResource(capability: Capability, resource: ResourceRef): boolean {
  if (capability === "shell.unclassified") return resource.kind === "repository";
  return CAPABILITY_RESOURCE_COMPATIBILITY[resource.kind].includes(capability);
}

export const OperationRequirementSchema = z.object({
  capability: CapabilitySchema,
  resource: ResourceRefSchema,
}).strict().superRefine((requirement, context) => {
  if (!capabilitySupportsResource(requirement.capability, requirement.resource)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["capability"],
      message: "Capability is incompatible with resource kind",
    });
  }
});
export type OperationRequirementInput = z.input<typeof OperationRequirementSchema>;
export type OperationRequirement = z.output<typeof OperationRequirementSchema>;

const requirementKey = (requirement: OperationRequirement): string =>
  `${requirement.capability}\u0000${requirement.resource.kind}\u0000${requirement.resource.id}`;

export const CanonicalOperationSchema = z.object({
  protocol_version: z.literal(GuardProtocolVersion),
  operation_id: OperationIdSchema,
  origin_adapter: GuardAdapterSchema,
  evaluation_stage: z.enum(["hook", "execution"]),
  session_id: GuardSessionSchema,
  task_id: TaskIdSchema,
  claim_id: ClaimIdSchema,
  cwd_worktree_ref: GuardWorktreeRefSchema,
  tool: z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]{0,63}$/),
  requirements: z.array(OperationRequirementSchema).min(1).max(32),
  risk: z.enum(["low", "medium", "high"]),
  execution_boundary: z.enum(["hook", "guarded_command", "tracker", "notion", "board"]),
  summary: boundedCoordinate(512),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().superRefine((operation, context) => {
  const keys = operation.requirements.map(requirementKey);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements"], message: "Duplicate operation requirement" });
  }
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements"], message: "Operation requirements are not canonical" });
  }
});
export type CanonicalOperationInput = z.input<typeof CanonicalOperationSchema>;
export type CanonicalOperation = z.output<typeof CanonicalOperationSchema>;
