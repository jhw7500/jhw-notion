import { createHmac } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { z } from "zod";

import {
  CanonicalOperationSchema,
  ClaimIdSchema,
  GuardAdapterSchema,
  GuardSessionSchema,
  GuardWorktreeRefSchema,
  OperationRequirementSchema,
  PreToolUseEventSchema,
  encodeCanonicalJson,
  type CanonicalOperation,
  type GuardAdapter,
  type JsonValue,
  type OperationRequirement,
  type PreToolUseEvent,
} from "./guard-protocol.js";
import { newOperationId } from "./ids.js";
import {
  classifyShell,
  type ExecutionBoundary,
  type OperationRisk,
  type ShellBoundarySignal,
} from "./shell-classifier.js";
import { ResourceRefSchema, TaskIdSchema } from "./work-contract.js";

const PRIVATE_PATH_BYTES = 4_096;
const DIGEST_KEY_BYTES = 32;
const MAX_DIGEST_MATERIAL_BYTES = 128 * 1024;

const privateAbsolutePath = z.string().min(1).max(PRIVATE_PATH_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= PRIVATE_PATH_BYTES)
  .refine(isAbsolute, "trusted worktree path must be absolute");

const repositoryResource = ResourceRefSchema.refine(
  (resource) => resource.kind === "repository",
  "Expected a canonical repository resource",
).transform((resource) => resource as Extract<typeof resource, { kind: "repository" }>);
const issueResource = ResourceRefSchema.refine(
  (resource) => resource.kind === "issue",
  "Expected a canonical issue resource",
).transform((resource) => resource as Extract<typeof resource, { kind: "issue" }>);
const notionResource = ResourceRefSchema.refine(
  (resource) => resource.kind === "notion_database",
  "Expected a canonical Notion database resource",
).transform((resource) => resource as Extract<typeof resource, { kind: "notion_database" }>);
const boardResource = ResourceRefSchema.refine(
  (resource) => resource.kind === "board",
  "Expected a canonical board resource",
).transform((resource) => resource as Extract<typeof resource, { kind: "board" }>);
const remoteResource = ResourceRefSchema.refine(
  (resource) => resource.kind === "remote_host",
  "Expected a canonical remote host resource",
).transform((resource) => resource as Extract<typeof resource, { kind: "remote_host" }>);
const firmwareResource = ResourceRefSchema.refine(
  (resource) => resource.kind === "firmware_target",
  "Expected a canonical firmware target resource",
).transform((resource) => resource as Extract<typeof resource, { kind: "firmware_target" }>);
const deploymentResource = ResourceRefSchema.refine(
  (resource) => resource.kind === "deployment_target",
  "Expected a canonical deployment target resource",
).transform((resource) => resource as Extract<typeof resource, { kind: "deployment_target" }>);

export const NormalizeOperationContextSchema = z.object({
  evaluation_stage: z.enum(["hook", "execution"]),
  task_id: TaskIdSchema,
  claim_id: ClaimIdSchema,
  session_id: GuardSessionSchema,
  cwd_worktree_ref: GuardWorktreeRefSchema,
  trusted_worktree_path: privateAbsolutePath,
  repository: repositoryResource,
  issue: issueResource.optional(),
  notion_database: notionResource.optional(),
  board: boardResource.optional(),
  remote_host: remoteResource.optional(),
  firmware_target: firmwareResource.optional(),
  deployment_target: deploymentResource.optional(),
}).strict();
export type NormalizeOperationContextInput = z.input<typeof NormalizeOperationContextSchema>;
export type NormalizeOperationContext = z.output<typeof NormalizeOperationContextSchema>;

export type OperationNormalizationErrorCode =
  | "invalid_event"
  | "invalid_context"
  | "invalid_digest_key"
  | "context_mismatch"
  | "cwd_outside_worktree"
  | "invalid_tool_input"
  | "unresolved_boundary"
  | "self_approval";

export class OperationNormalizationError extends Error {
  readonly code: OperationNormalizationErrorCode;
  readonly signals?: ShellBoundarySignal[];

  constructor(code: OperationNormalizationErrorCode, signals?: readonly ShellBoundarySignal[]) {
    super("Guard operation normalization failed closed");
    this.name = "OperationNormalizationError";
    this.code = code;
    this.signals = signals === undefined ? undefined : [...signals];
  }
}

export interface OperationDigestMaterial {
  protocol_version: 1;
  tool: string;
  origin_adapter: GuardAdapter;
  task_id: string;
  claim_id: string;
  session_id: string;
  cwd_worktree_ref: string;
  cwd_relative: string;
  requirements: OperationRequirement[];
  execution: JsonValue;
  script_content_sha256?: string;
}

function assertDigestKey(digestKey: Uint8Array): void {
  if (!(digestKey instanceof Uint8Array) || digestKey.byteLength !== DIGEST_KEY_BYTES) {
    throw new OperationNormalizationError("invalid_digest_key");
  }
}

/** Stable bounded encoder shared by HMAC material and hostile-value tests. */
export function stableCanonicalJson(value: unknown): string {
  return encodeCanonicalJson(value, {
    maximumBytes: MAX_DIGEST_MATERIAL_BYTES,
    maximumStringBytes: 64 * 1024,
    maximumNodes: 4_096,
    maximumArrayLength: 2_048,
    maximumObjectKeys: 512,
  });
}

/**
 * Computes the approval binding from an explicit allowlist of fields. Extra
 * correlation/display properties on an input object are intentionally ignored.
 */
export function computeOperationDigest(input: OperationDigestMaterial, digestKey: Uint8Array): string {
  assertDigestKey(digestKey);
  const material = {
    protocol_version: input.protocol_version,
    tool: input.tool,
    origin_adapter: input.origin_adapter,
    task_id: input.task_id,
    claim_id: input.claim_id,
    session_id: input.session_id,
    cwd_worktree_ref: input.cwd_worktree_ref,
    cwd_relative: input.cwd_relative,
    requirements: input.requirements,
    execution: input.execution,
    ...(input.script_content_sha256 ? { script_content_sha256: input.script_content_sha256 } : {}),
  };
  return createHmac("sha256", digestKey).update(stableCanonicalJson(material), "utf8").digest("hex");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requirementKey(requirement: OperationRequirement): string {
  return `${requirement.capability}\u0000${requirement.resource.kind}\u0000${requirement.resource.id}`;
}

function normalizeRequirements(requirements: readonly OperationRequirement[]): OperationRequirement[] {
  const parsed = requirements.map((requirement) => OperationRequirementSchema.parse(requirement));
  return [...new Map(parsed.map((requirement) => [requirementKey(requirement), requirement])).values()]
    .sort((left, right) => compare(requirementKey(left), requirementKey(right)));
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function relativeTrustedCwd(eventCwd: string, trustedWorktreePath: string): Promise<{
  trustedRoot: string;
  cwd: string;
  relativeCwd: string;
}> {
  let trustedRoot: string;
  let cwd: string;
  try {
    [trustedRoot, cwd] = await Promise.all([realpath(trustedWorktreePath), realpath(eventCwd)]);
  } catch {
    throw new OperationNormalizationError("cwd_outside_worktree");
  }
  if (!isWithin(trustedRoot, cwd)) throw new OperationNormalizationError("cwd_outside_worktree");
  return { trustedRoot, cwd, relativeCwd: relative(trustedRoot, cwd) || "." };
}

function canonicalToolAlias(toolName: string): string {
  const namespaceTail = toolName.trim().toLowerCase().split(/__+|[.:/]+/u).filter(Boolean).at(-1) ?? "";
  return namespaceTail.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

const fileReadTools = new Set(["read", "read_file", "glob", "glob_files", "grep", "grep_files"]);
const fileModifyTools = new Set([
  "edit", "edit_file", "write", "write_file", "notebookedit", "notebook_edit", "apply_patch", "functions_apply_patch",
]);
const shellTools = new Set(["bash", "shell", "exec_command", "run_command", "terminal"]);
const notionMutationTools = new Set(["jhw_record", "jhw_save", "jhw_delete", "jhw_note"]);
const trackerMutationTools = new Set(["github_issue_close", "github_issue_edit", "github_issue_comment"]);

function asObject(value: JsonValue): Record<string, JsonValue> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function commandFromToolInput(input: JsonValue): string {
  const command = asObject(input)?.command;
  if (typeof command !== "string" || command.length === 0) throw new OperationNormalizationError("invalid_tool_input");
  return command;
}

function shellExecutionMaterial(input: JsonValue, digestArgv?: readonly string[]): JsonValue {
  if (!digestArgv) return input;
  const object = asObject(input);
  if (!object) throw new OperationNormalizationError("invalid_tool_input");
  const options: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(object)) {
    if (key !== "command") options[key] = value;
  }
  return Object.keys(options).length === 0
    ? { argv: [...digestArgv] }
    : { argv: [...digestArgv], options };
}

function summaryFor(requirements: readonly OperationRequirement[]): string {
  const fragments = requirements.map((requirement) =>
    `${requirement.capability} ${requirement.resource.kind}:${requirement.resource.id}`);
  let summary = "";
  let retained = 0;
  for (const fragment of fragments) {
    const candidate = summary.length === 0 ? fragment : `${summary}, ${fragment}`;
    if (Buffer.byteLength(candidate, "utf8") > 480) break;
    summary = candidate;
    retained += 1;
  }
  if (retained < fragments.length) summary = `${summary} +${fragments.length - retained}`;
  return summary || "guarded operation";
}

interface NormalizedTool {
  tool: string;
  requirements: OperationRequirement[];
  risk: OperationRisk;
  execution_boundary: ExecutionBoundary;
  execution: JsonValue;
  script_content_sha256?: string;
}

async function normalizeTool(
  event: PreToolUseEvent,
  context: NormalizeOperationContext,
  cwd: string,
): Promise<NormalizedTool> {
  const alias = canonicalToolAlias(event.tool_name);
  if (fileReadTools.has(alias)) {
    return {
      tool: "file.read",
      requirements: [{ capability: "repo.inspect", resource: context.repository }],
      risk: "low",
      execution_boundary: "hook",
      execution: event.tool_input,
    };
  }
  if (fileModifyTools.has(alias)) {
    return {
      tool: "file.modify",
      requirements: [{ capability: "repo.modify", resource: context.repository }],
      risk: "medium",
      execution_boundary: "hook",
      execution: event.tool_input,
    };
  }
  if (notionMutationTools.has(alias)) {
    if (!context.notion_database) {
      throw new OperationNormalizationError("unresolved_boundary", [{ capability: "notion.mutate", boundary: "notion" }]);
    }
    return {
      tool: "notion.mutate",
      requirements: [{ capability: "notion.mutate", resource: context.notion_database }],
      risk: "high",
      execution_boundary: "notion",
      execution: event.tool_input,
    };
  }
  if (trackerMutationTools.has(alias)) {
    if (!context.issue) {
      throw new OperationNormalizationError("unresolved_boundary", [{ capability: "tracker.mutate", boundary: "tracker" }]);
    }
    return {
      tool: "tracker.mutate",
      requirements: [{ capability: "tracker.mutate", resource: context.issue }],
      risk: "high",
      execution_boundary: "tracker",
      execution: event.tool_input,
    };
  }
  if (shellTools.has(alias)) {
    const command = commandFromToolInput(event.tool_input);
    const classification = await classifyShell(command, {
      trusted_worktree_path: context.trusted_worktree_path,
      cwd,
      repository: context.repository,
      ...(context.issue ? { issue: context.issue } : {}),
      ...(context.notion_database ? { notion_database: context.notion_database } : {}),
      ...(context.board ? { board: context.board } : {}),
      ...(context.remote_host ? { remote_host: context.remote_host } : {}),
      ...(context.firmware_target ? { firmware_target: context.firmware_target } : {}),
      ...(context.deployment_target ? { deployment_target: context.deployment_target } : {}),
    });
    if (classification.self_approval) throw new OperationNormalizationError("self_approval");
    if (classification.unresolved_signals.length > 0) {
      throw new OperationNormalizationError("unresolved_boundary", classification.unresolved_signals);
    }
    return {
      tool: "shell",
      requirements: classification.requirements,
      risk: classification.risk,
      execution_boundary: classification.execution_boundary,
      execution: shellExecutionMaterial(event.tool_input, classification.digest_argv),
      ...(classification.script_content_sha256
        ? { script_content_sha256: classification.script_content_sha256 }
        : {}),
    };
  }

  return {
    tool: "tool.unclassified",
    requirements: [{ capability: "shell.unclassified", resource: context.repository }],
    risk: "high",
    execution_boundary: "hook",
    execution: event.tool_input,
  };
}

export async function normalizeOperation(
  eventInput: PreToolUseEvent,
  contextInput: NormalizeOperationContext,
  digestKey: Uint8Array,
): Promise<CanonicalOperation> {
  assertDigestKey(digestKey);
  const eventResult = PreToolUseEventSchema.safeParse(eventInput);
  if (!eventResult.success) throw new OperationNormalizationError("invalid_event");
  const contextResult = NormalizeOperationContextSchema.safeParse(contextInput);
  if (!contextResult.success) throw new OperationNormalizationError("invalid_context");
  const event = eventResult.data;
  const context = contextResult.data;
  if (event.session_id !== context.session_id) throw new OperationNormalizationError("context_mismatch");

  const cwd = await relativeTrustedCwd(event.cwd, context.trusted_worktree_path);
  const normalizedTool = await normalizeTool(event, context, cwd.cwd);
  const requirements = normalizeRequirements(normalizedTool.requirements);
  const digest = computeOperationDigest({
    protocol_version: 1,
    tool: normalizedTool.tool,
    origin_adapter: GuardAdapterSchema.parse(event.adapter),
    task_id: context.task_id,
    claim_id: context.claim_id,
    session_id: context.session_id,
    cwd_worktree_ref: context.cwd_worktree_ref,
    cwd_relative: cwd.relativeCwd,
    requirements,
    execution: normalizedTool.execution,
    ...(normalizedTool.script_content_sha256
      ? { script_content_sha256: normalizedTool.script_content_sha256 }
      : {}),
  }, digestKey);

  return CanonicalOperationSchema.parse({
    protocol_version: 1,
    operation_id: newOperationId(),
    origin_adapter: event.adapter,
    evaluation_stage: context.evaluation_stage,
    session_id: context.session_id,
    task_id: context.task_id,
    claim_id: context.claim_id,
    cwd_worktree_ref: context.cwd_worktree_ref,
    tool: normalizedTool.tool,
    requirements,
    risk: normalizedTool.risk,
    execution_boundary: normalizedTool.execution_boundary,
    summary: summaryFor(requirements),
    digest,
  });
}
