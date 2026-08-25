import { createHash } from "node:crypto";

import { z } from "zod";

import { encodeCanonicalJson, type GuardAdapter, type JsonValue } from "./guard-protocol.js";

const notionDatabaseId = z.enum(["decisionLog", "preferences", "projects", "references", "knowledgeBase"]);
type NotionDatabaseId = z.infer<typeof notionDatabaseId>;

const authorityCoordinateKeys = new Set([
  "file_path", "path", "notebook_path", "cwd", "workdir", "working_directory", "directory",
  "root", "root_dir", "repo_path", "repository_path",
  "db", "database", "database_id", "notion_database_id",
  "issue_node_id", "issue_id", "issue_number", "repository", "repository_id", "repo", "owner",
]);

function exactAuthorityCoordinates<T extends z.ZodRawShape>(
  shape: T,
  allowed: readonly string[],
): z.ZodEffects<z.ZodObject<T, "passthrough">> {
  const allowedCoordinates = new Set(allowed);
  return z.object(shape).passthrough().superRefine((value, context) => {
    for (const field of Object.keys(value)) {
      if (authorityCoordinateKeys.has(field) && !allowedCoordinates.has(field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Alternate authority coordinate is not valid for this exact tool identity",
        });
      }
    }
  });
}

const readInput = exactAuthorityCoordinates({
  file_path: z.string().min(1),
  offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().positive().max(100_000).optional(),
}, ["file_path"]);
const globInput = exactAuthorityCoordinates(
  { pattern: z.string().min(1), path: z.string().min(1).optional() },
  ["path"],
);
const grepInput = exactAuthorityCoordinates(
  { pattern: z.string().min(1), path: z.string().min(1).optional() },
  ["path"],
);
const pathReadInput = exactAuthorityCoordinates({ path: z.string().min(1) }, ["path"]);
const editInput = exactAuthorityCoordinates({
  file_path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
}, ["file_path"]);
const writeInput = exactAuthorityCoordinates(
  { file_path: z.string().min(1), content: z.string() },
  ["file_path"],
);
const notebookEditInput = exactAuthorityCoordinates({ notebook_path: z.string().min(1) }, ["notebook_path"]);
const pathEditInput = exactAuthorityCoordinates({
  path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
}, ["path"]);
const pathWriteInput = exactAuthorityCoordinates(
  { path: z.string().min(1), content: z.string() },
  ["path"],
);
const patchInput = z.union([
  z.string().min(1),
  exactAuthorityCoordinates({ patch: z.string().min(1) }, []),
]);
const shellInput = exactAuthorityCoordinates({ command: z.string().min(1) }, []);
const notionInput = exactAuthorityCoordinates({ db: notionDatabaseId }, ["db"]);
const notionNoteInput = exactAuthorityCoordinates({ title: z.string().min(1).optional() }, []);
const trackerInput = exactAuthorityCoordinates({ issue_node_id: z.string().min(1) }, ["issue_node_id"]);

type GuardToolFamily = "file_read" | "file_modify" | "shell" | "notion_mutation" | "tracker_mutation" | "unclassified";

interface ToolDefinition {
  family: Exclude<GuardToolFamily, "unclassified">;
  codec: z.ZodTypeAny;
  pathField?: "file_path" | "path" | "notebook_path";
  patch?: true;
  notionDatabase?: "input" | "knowledgeBase";
  claimFreeRead?: true;
}

function key(adapter: GuardAdapter, rawToolName: string): string {
  return `${adapter}\u0000${rawToolName}`;
}

/**
 * Plan 2's complete authority inventory. Each pair is backed by its current
 * protocol tests or approved adapter-plan fixture; future adapters extend this
 * table only after pinning their native payloads.
 */
const toolDefinitions = Object.freeze({
  [key("codex", "Read")]: { family: "file_read", codec: readInput, claimFreeRead: true },
  [key("codex", "Glob")]: { family: "file_read", codec: globInput },
  [key("codex", "Grep")]: { family: "file_read", codec: grepInput },
  [key("codex", "read_file")]: { family: "file_read", codec: pathReadInput },
  [key("codex", "mcp__filesystem__read_file")]: { family: "file_read", codec: pathReadInput },
  [key("codex", "Edit")]: { family: "file_modify", codec: editInput, pathField: "file_path" },
  [key("codex", "Write")]: { family: "file_modify", codec: writeInput, pathField: "file_path" },
  [key("codex", "NotebookEdit")]: { family: "file_modify", codec: notebookEditInput, pathField: "notebook_path" },
  [key("codex", "edit_file")]: { family: "file_modify", codec: pathEditInput, pathField: "path" },
  [key("codex", "mcp__filesystem__write_file")]: { family: "file_modify", codec: pathWriteInput, pathField: "path" },
  [key("codex", "apply_patch")]: { family: "file_modify", codec: patchInput, patch: true },
  [key("codex", "functions.apply_patch")]: { family: "file_modify", codec: patchInput, patch: true },
  [key("codex", "Bash")]: { family: "shell", codec: shellInput },
  [key("codex", "exec_command")]: { family: "shell", codec: shellInput },
  [key("codex", "jhw_record")]: { family: "notion_mutation", codec: notionInput, notionDatabase: "input" },
  [key("codex", "jhw_save")]: { family: "notion_mutation", codec: notionInput, notionDatabase: "input" },
  [key("codex", "jhw_delete")]: { family: "notion_mutation", codec: notionInput, notionDatabase: "input" },
  [key("codex", "jhw_note")]: { family: "notion_mutation", codec: notionNoteInput, notionDatabase: "knowledgeBase" },
  [key("codex", "github_issue_close")]: { family: "tracker_mutation", codec: trackerInput },
  [key("codex", "github_issue_edit")]: { family: "tracker_mutation", codec: trackerInput },
  [key("codex", "github_issue_comment")]: { family: "tracker_mutation", codec: trackerInput },
  [key("claude", "Bash")]: { family: "shell", codec: shellInput },
  [key("claude", "Edit")]: { family: "file_modify", codec: editInput, pathField: "file_path" },
} satisfies Record<string, ToolDefinition>);

/** Derived test inventory: the authority table above remains the sole source. */
export function guardToolIdentityInventoryForTesting(): readonly Readonly<{
  adapter: GuardAdapter;
  rawToolName: string;
}>[] {
  return Object.freeze(Object.keys(toolDefinitions).map((encoded) => {
    const separator = encoded.indexOf("\u0000");
    return Object.freeze({
      adapter: encoded.slice(0, separator) as GuardAdapter,
      rawToolName: encoded.slice(separator + 1),
    });
  }));
}

function patchTargets(input: JsonValue): string[] | undefined {
  const patch = typeof input === "string"
    ? input
    : input !== null && typeof input === "object" && !Array.isArray(input)
      ? input.patch
      : undefined;
  if (typeof patch !== "string") return undefined;
  const targets: string[] = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/u) ??
      line.match(/^\*\*\* Move to: (.+)$/u);
    if (match?.[1]) targets.push(match[1]);
  }
  return targets.length > 0 ? [...new Set(targets)] : undefined;
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
    return Object.freeze(value) as JsonValue;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
    return Object.freeze(value) as JsonValue;
  }
  return value;
}

export class GuardToolResolutionError extends Error {
  readonly code = "invalid_tool_input" as const;

  constructor() {
    super("Guard tool input failed its exact identity codec");
    this.name = "GuardToolResolutionError";
  }
}

export interface ResolvedGuardTool {
  readonly adapter: GuardAdapter;
  readonly raw_tool_name: string;
  readonly raw_identity: string;
  readonly family: GuardToolFamily;
  readonly execution: JsonValue;
  readonly command?: string;
  readonly self_approval_command?: string;
  readonly mutation_targets: readonly string[];
  readonly notion_database_id?: NotionDatabaseId;
  readonly tracker_issue_node_id?: string;
  readonly claim_free_read?: {
    readonly file_path: string;
    readonly offset?: number;
    readonly limit?: number;
  };
}

interface ResolutionBinding {
  adapter: GuardAdapter;
  rawToolName: string;
  rawInputFingerprint: string;
}

const genuineResolutions = new WeakMap<object, ResolutionBinding>();

function rawInputFingerprint(input: JsonValue): string {
  return createHash("sha256").update(encodeCanonicalJson(input), "utf8").digest("hex");
}

function rawCommand(input: JsonValue): string | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input) && typeof input.command === "string"
    ? input.command
    : undefined;
}

export function resolveGuardTool(
  adapter: GuardAdapter,
  rawToolName: string,
  rawInput: JsonValue,
): ResolvedGuardTool {
  const definition = toolDefinitions[key(adapter, rawToolName)] as ToolDefinition | undefined;
  const selfApprovalCommand = rawCommand(rawInput);
  const inputFingerprint = rawInputFingerprint(rawInput);
  if (!definition) {
    const resolution = Object.freeze({
      adapter,
      raw_tool_name: rawToolName,
      raw_identity: rawToolName,
      family: "unclassified" as const,
      execution: freezeJson(structuredClone(rawInput)),
      ...(selfApprovalCommand ? { self_approval_command: selfApprovalCommand } : {}),
      mutation_targets: Object.freeze([]) as readonly string[],
    });
    genuineResolutions.set(resolution, { adapter, rawToolName, rawInputFingerprint: inputFingerprint });
    return resolution;
  }

  const parsed = definition.codec.safeParse(rawInput);
  if (!parsed.success) throw new GuardToolResolutionError();
  const execution = freezeJson(structuredClone(parsed.data as JsonValue));
  let mutationTargets: string[] = [];
  if (definition.patch) {
    const targets = patchTargets(execution);
    if (!targets) throw new GuardToolResolutionError();
    mutationTargets = targets;
  } else if (definition.pathField) {
    const value = execution !== null && typeof execution === "object" && !Array.isArray(execution)
      ? execution[definition.pathField]
      : undefined;
    if (typeof value !== "string") throw new GuardToolResolutionError();
    mutationTargets = [value];
  }
  const command = definition.family === "shell" ? rawCommand(execution) : undefined;
  if (definition.family === "shell" && !command) throw new GuardToolResolutionError();
  const database = definition.notionDatabase === "knowledgeBase"
    ? "knowledgeBase"
    : definition.notionDatabase === "input" && execution !== null && typeof execution === "object" && !Array.isArray(execution)
      ? notionDatabaseId.safeParse(execution.db).data
      : undefined;
  if (definition.notionDatabase && !database) throw new GuardToolResolutionError();
  const trackerIssueNodeId = definition.family === "tracker_mutation" && execution !== null &&
    typeof execution === "object" && !Array.isArray(execution) && typeof execution.issue_node_id === "string"
    ? execution.issue_node_id
    : undefined;
  if (definition.family === "tracker_mutation" && !trackerIssueNodeId) throw new GuardToolResolutionError();
  const claimFree = definition.claimFreeRead && execution !== null && typeof execution === "object" && !Array.isArray(execution) &&
    Object.keys(execution).every((field) => ["file_path", "offset", "limit"].includes(field))
    ? {
      file_path: execution.file_path as string,
      ...(typeof execution.offset === "number" ? { offset: execution.offset } : {}),
      ...(typeof execution.limit === "number" ? { limit: execution.limit } : {}),
    }
    : undefined;
  const resolution = Object.freeze({
    adapter,
    raw_tool_name: rawToolName,
    raw_identity: rawToolName,
    family: definition.family,
    execution,
    ...(command ? { command } : {}),
    ...(selfApprovalCommand ? { self_approval_command: selfApprovalCommand } : {}),
    mutation_targets: Object.freeze([...mutationTargets]),
    ...(database ? { notion_database_id: database } : {}),
    ...(trackerIssueNodeId ? { tracker_issue_node_id: trackerIssueNodeId } : {}),
    ...(claimFree ? { claim_free_read: Object.freeze(claimFree) } : {}),
  });
  genuineResolutions.set(resolution, { adapter, rawToolName, rawInputFingerprint: inputFingerprint });
  return resolution;
}

export function isResolvedGuardToolFor(
  resolution: unknown,
  adapter: GuardAdapter,
  rawToolName: string,
  rawInput: JsonValue,
): resolution is ResolvedGuardTool {
  if (typeof resolution !== "object" || resolution === null) return false;
  const binding = genuineResolutions.get(resolution);
  if (!binding || binding.adapter !== adapter || binding.rawToolName !== rawToolName) return false;
  try {
    return binding.rawInputFingerprint === rawInputFingerprint(rawInput) &&
      (resolution as ResolvedGuardTool).adapter === adapter &&
      (resolution as ResolvedGuardTool).raw_tool_name === rawToolName;
  } catch {
    return false;
  }
}
