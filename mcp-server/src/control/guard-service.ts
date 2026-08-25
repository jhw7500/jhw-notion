import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  ClaimIdSchema,
  exactGuardUnlockRequestId,
  GuardAdapterSchema,
  GuardPromptContextSchema,
  GuardSessionSchema,
  GuardWorktreeRefSchema,
  OperationRequirementSchema,
  RequestIdSchema,
  type CanonicalOperation,
  type GuardAdapter,
  type GuardPromptContext,
  type OperationRequirement,
  type PreToolUseEvent,
} from "./guard-protocol.js";
import { ControlError } from "./errors.js";
import {
  GuardCommonEventSchema,
  PostToolUseEventSchema,
  UserPromptSubmitEventSchema,
} from "./guard-protocol.js";
import { newOperationId } from "./ids.js";
import {
  normalizeOperation,
  OperationNormalizationError,
  type NormalizeOperationContext,
} from "./operation-normalizer.js";
import { isDirectMutationLock, MutationLock } from "./process.js";
import {
  GuardRequestStore,
  type GuardCompleteResult,
  type GuardConsumeResult,
  type GuardPendingResult,
  type GuardPromptApprovalResult,
  type GuardRequest,
  type GuardRequestInspection,
} from "./guard-state.js";
import {
  ContractActiveClaimSchema,
  GuardDecisionSchema,
  GuardDenyCodeSchema,
  ErrorReasonSchema,
  GuardEvaluationModeSchema,
  GuardJournalWarningSchema,
  OffsetDateTimeSchema,
  GuardSummarySchema,
  type ActiveClaim,
  type ContractActiveClaim,
  type GuardDecision,
  type GuardDenyCode,
  type GuardEvaluationMode,
  type ErrorReason,
  type TaskRecord,
} from "./schemas.js";
import {
  classifyShell,
  detectGuardSelfApproval,
  ShellClassificationError,
  type ExecutionBoundary,
  type ShellClassification,
} from "./shell-classifier.js";
import type { GuardTaskInspection } from "./task-service.js";
import { TaskIdSchema, type WorkGrant } from "./work-contract.js";

export { GuardDecisionSchema } from "./schemas.js";
export type { GuardDecision } from "./schemas.js";

const SideEventKindSchema = z.enum(["user_prompt_submit", "post_tool_use"]);
export const GuardSideEventResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("NO_STATE_CHANGE"),
    event: SideEventKindSchema,
    summary: GuardSummarySchema,
    context: GuardPromptContextSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("APPROVED"),
    event: z.literal("user_prompt_submit"),
    request_id: RequestIdSchema,
    context: GuardPromptContextSchema,
    start_by: OffsetDateTimeSchema,
    execution_consumes_permit: z.literal(true),
    summary: GuardSummarySchema,
    journal_warning: GuardJournalWarningSchema.optional(),
  }).strict(),
  z.object({
    status: z.enum(["COMPLETED", "FAILED"]),
    event: z.literal("post_tool_use"),
    request_id: RequestIdSchema,
    task_id: TaskIdSchema,
    claim_id: ClaimIdSchema,
    summary: GuardSummarySchema,
    journal_warning: GuardJournalWarningSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("DENY"),
    code: GuardDenyCodeSchema,
    event: SideEventKindSchema.optional(),
    summary: GuardSummarySchema,
    context: GuardPromptContextSchema.optional(),
    journal_warning: GuardJournalWarningSchema.optional(),
    reason: ErrorReasonSchema.optional(),
  }).strict(),
]);
export type GuardSideEventResult = z.infer<typeof GuardSideEventResultSchema>;

interface GuardRequestStoreAuthority {
  inspect(): Promise<GuardRequestInspection>;
  createOrReusePending(operation: CanonicalOperation): Promise<GuardPendingResult>;
  approveFromPrompt(
    originAdapter: GuardAdapter,
    session: string,
    rawPrompt: string,
  ): Promise<GuardPromptApprovalResult>;
  consumeMatching(operation: CanonicalOperation, correlation: string): Promise<GuardConsumeResult>;
  complete(correlation: string, ok: boolean): Promise<GuardCompleteResult>;
}

const guardStoreInspect = GuardRequestStore.prototype.inspect;
const guardStoreCreateOrReuse = GuardRequestStore.prototype.createOrReusePending;
const guardStoreApprove = GuardRequestStore.prototype.approveFromPrompt;
const guardStoreConsume = GuardRequestStore.prototype.consumeMatching;
const guardStoreComplete = GuardRequestStore.prototype.complete;

function captureGuardRequestStore(store: GuardRequestStore | undefined): GuardRequestStoreAuthority | undefined {
  if (!store) return undefined;
  if (
    Object.getPrototypeOf(store) !== GuardRequestStore.prototype ||
    store.inspect !== guardStoreInspect ||
    store.createOrReusePending !== guardStoreCreateOrReuse ||
    store.approveFromPrompt !== guardStoreApprove ||
    store.consumeMatching !== guardStoreConsume ||
    store.complete !== guardStoreComplete
  ) {
    return undefined;
  }
  return {
    inspect: () => guardStoreInspect.call(store),
    createOrReusePending: (operation) => guardStoreCreateOrReuse.call(store, operation),
    approveFromPrompt: (adapter, session, prompt) => guardStoreApprove.call(store, adapter, session, prompt),
    consumeMatching: (operation, correlation) => guardStoreConsume.call(store, operation, correlation),
    complete: (correlation, ok) => guardStoreComplete.call(store, correlation, ok),
  };
}

export interface GuardClaimServicePort {
  resolveSessionClaim(
    originAdapter: GuardAdapter,
    sessionId: string,
    host: string,
  ): Promise<ActiveClaim | undefined>;
  listActiveClaims(): Promise<ActiveClaim[]>;
}

export interface GuardRegistryViewPort {
  withCommittedView<T>(read: () => Promise<T>): Promise<T>;
  committedViewIsStale(): Promise<boolean>;
}

const guardRegistryMutationBarrierBrand = Symbol("guard-registry-mutation-barrier");
type GuardRegistryMutationBarrierRunner = <T>(callback: () => Promise<T>) => Promise<T>;
const guardRegistryMutationBarrierRunners = new WeakMap<object, GuardRegistryMutationBarrierRunner>();
const guardRegistryMutationBarrierQueues = new WeakMap<MutationLock, Promise<void>>();

async function runQueuedGuardRegistryMutation<T>(
  mutationLock: MutationLock,
  concreteRun: MutationLock["run"],
  callback: () => Promise<T>,
): Promise<T> {
  const previous = guardRegistryMutationBarrierQueues.get(mutationLock) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  guardRegistryMutationBarrierQueues.set(mutationLock, tail);
  await previous.catch(() => undefined);
  try {
    return await concreteRun.call(mutationLock, callback) as T;
  } finally {
    release();
    if (guardRegistryMutationBarrierQueues.get(mutationLock) === tail) {
      guardRegistryMutationBarrierQueues.delete(mutationLock);
    }
  }
}

/**
 * Opaque authority to run one Guard evaluation under the Registry writer lock.
 * Task 4 must create it from the exact same concrete host MutationLock object
 * used by Registry writers; arbitrary structural callback runners are not authority.
 */
export interface GuardRegistryMutationBarrierPort {
  readonly [guardRegistryMutationBarrierBrand]: true;
}

/**
 * Binds Guard authority to the exact production MutationLock implementation.
 * MutationLock's runtime and secure-directory hooks remain its unit-test seams;
 * subclasses, overridden methods, and MutationLockPort-shaped fakes cannot be
 * promoted into a Guard commit barrier.
 */
export function createGuardRegistryMutationBarrier(
  mutationLock: MutationLock,
): GuardRegistryMutationBarrierPort {
  const concreteRun = MutationLock.prototype.run;
  if (
    !isDirectMutationLock(mutationLock)
    || Object.getPrototypeOf(mutationLock) !== MutationLock.prototype
    || mutationLock.run !== concreteRun
  ) {
    throw new TypeError("Guard Registry barrier requires the concrete MutationLock implementation");
  }
  const barrier = Object.freeze({
    [guardRegistryMutationBarrierBrand]: true,
  }) as GuardRegistryMutationBarrierPort;
  guardRegistryMutationBarrierRunners.set(
    barrier,
    <T>(callback: () => Promise<T>) => runQueuedGuardRegistryMutation(mutationLock, concreteRun, callback),
  );
  return barrier;
}

function guardRegistryMutationBarrierRunner(
  barrier: unknown,
): GuardRegistryMutationBarrierRunner | undefined {
  return typeof barrier === "object" && barrier !== null
    ? guardRegistryMutationBarrierRunners.get(barrier)
    : undefined;
}

export interface GuardTaskServicePort {
  getTask(taskId: string): Promise<TaskRecord>;
  inspectForGuard(taskId: string, claimId: string): Promise<GuardTaskInspection>;
  sourceRevisionForGuard(task: TaskRecord): Promise<string>;
}

export interface GuardContractAuthorityPort {
  assertKnownRequirement(task: TaskRecord, requirement: OperationRequirement): Promise<void>;
}

/** Task 3/4 supplies this boundary. Task 2 deliberately cannot create a request. */
export interface GuardPermitDecisionPort {
  decideMissingGrant(
    operation: CanonicalOperation,
    missingRequirements: readonly OperationRequirement[],
  ): Promise<unknown>;
}

const GuardPermitBindingSchema = z.object({
  task_id: z.string().regex(/^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  claim_id: ClaimIdSchema,
  origin_adapter: GuardAdapterSchema,
  session_id: GuardSessionSchema,
  cwd_worktree_ref: GuardWorktreeRefSchema,
  requirements: z.array(OperationRequirementSchema).min(1).max(32),
  missing_requirements: z.array(OperationRequirementSchema).min(1).max(32),
  operation_digest: z.string().regex(/^[0-9a-f]{64}$/),
  request_state: z.enum(["PENDING", "APPROVED"]),
  request_id: RequestIdSchema,
  approval_expires_at: OffsetDateTimeSchema,
  journal_warning: GuardJournalWarningSchema.optional(),
}).strict();

const GuardPermitStateDenySchema = z.object({
  decision: z.literal("DENY"),
  code: z.enum(["GUARD_STATE_LIMIT", "GUARD_UNAVAILABLE"]),
}).strict();

const GuardPermitPublicStateDenySchema = GuardPermitStateDenySchema.extend({
  summary: GuardSummarySchema,
}).strict();

const GuardPermitResultSchema = z.union([
  GuardPermitBindingSchema,
  GuardPermitStateDenySchema,
  GuardPermitPublicStateDenySchema,
]);

export interface GuardServiceOptions {
  host: string;
  digest_key: Uint8Array;
  claims: GuardClaimServicePort;
  tasks: GuardTaskServicePort;
  authority: GuardContractAuthorityPort;
  registry_view: GuardRegistryViewPort;
  registry_mutation_barrier: GuardRegistryMutationBarrierPort;
  permit_decisions?: GuardPermitDecisionPort;
  guard_request_store?: GuardRequestStore;
  mode?: GuardEvaluationMode;
  /** Strict read-only inspection seam. It must never create, clean, or lock state. */
  inspect_guard_state?: () => Promise<boolean>;
}

const summaryByCode: Record<GuardDenyCode, string> = {
  GUARD_CLAIM_REQUIRED: "An active Claim is required",
  GUARD_CLAIM_MISMATCH: "Claim session identity does not match",
  GUARD_WORKTREE_MISMATCH: "Worktree identity does not match",
  GUARD_RESOURCE_OWNED: "Another active Task owns the resource",
  GUARD_REQUEST_NOT_FOUND: "Guard request was not found",
  GUARD_REQUEST_EXPIRED: "Guard request has expired",
  GUARD_PERMIT_MISMATCH: "Guard permit binding does not match",
  GUARD_PERMIT_CONSUMED: "Guard permit was already consumed",
  GUARD_PROMPT_ORIGIN_UNSUPPORTED: "Prompt origin is unsupported",
  GUARD_UNAVAILABLE: "Guard state or authority is unavailable",
  GUARD_PROTOCOL_MISMATCH: "Guard protocol input is invalid",
  GUARD_RESOURCE_AUTHORITY_UNAVAILABLE: "Resource authority is unavailable",
  GUARD_WRAPPER_REQUIRED: "A guarded execution wrapper is required",
  GUARD_SELF_APPROVAL_DENIED: "Agent-origin permit approval is denied",
  GUARD_STATE_LIMIT: "Guard request state limit was reached",
};

const hardObserveCodes = new Set<GuardDenyCode>([
  "GUARD_PROTOCOL_MISMATCH",
  "GUARD_UNAVAILABLE",
  "GUARD_SELF_APPROVAL_DENIED",
]);

const fileModifyTools = new Set([
  "edit", "edit_file", "write", "write_file", "notebookedit", "notebook_edit", "apply_patch", "functions_apply_patch",
]);
const shellTools = new Set(["bash", "shell", "exec_command", "run_command", "terminal"]);
const directHighRiskTools = new Set([
  "jhw_record", "jhw_save", "jhw_delete", "jhw_note",
  "github_issue_close", "github_issue_edit", "github_issue_comment",
]);
const notionDatabaseIds = new Set(["decisionLog", "preferences", "projects", "references", "knowledgeBase"]);
const claimFreeStatusCommands = new Set([
  "git status",
  "git status --short",
  "git status --porcelain",
  "jhw-control guard status",
  "jhw-control guard preflight",
  "jhw-control board list",
]);

function canonicalToolAlias(toolName: string): string {
  const tail = toolName.trim().toLowerCase().split(/__+|[.:/]+/u).filter(Boolean).at(-1) ?? "";
  return tail.replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function commandFrom(event: PreToolUseEvent): string | undefined {
  const command = asObject(event.tool_input)?.command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

function notionDatabaseFrom(event: PreToolUseEvent): NormalizeOperationContext["notion_database"] | undefined {
  const alias = canonicalToolAlias(event.tool_name);
  if (!new Set(["jhw_record", "jhw_save", "jhw_delete", "jhw_note"]).has(alias)) return undefined;
  const db = alias === "jhw_note" ? "knowledgeBase" : asObject(event.tool_input)?.db;
  return typeof db === "string" && notionDatabaseIds.has(db)
    ? { kind: "notion_database", id: db as "decisionLog" | "preferences" | "projects" | "references" | "knowledgeBase" }
    : undefined;
}

const exactClaimFreeShellTools = new Set(["Bash", "exec_command"]);
const runFile = promisify(execFile);
const sensitiveReadComponent = /^(?:\.env(?:\..*)?|\.git|\.netrc|\.npmrc|\.pypirc|credentials?|secrets?|tokens?|id_rsa|id_ed25519)$/iu;

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function safeLocalRelativePath(raw: string, allowDot = false): boolean {
  if (!raw || isAbsolute(raw) || raw.includes("\\") || /[\u0000\r\n]/u.test(raw)) return false;
  const components = raw.split("/");
  if (components.some((component) => !component || component === ".." || (!allowDot && component === "."))) return false;
  return components.every((component) => component === "." || !sensitiveReadComponent.test(component));
}

async function trustedRepositoryRoot(cwd: string): Promise<string | undefined> {
  try {
    const trustedCwd = await realpath(cwd);
    const result = await runFile("git", ["-C", trustedCwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const rawRoot = result.stdout.trim();
    if (!rawRoot || !isAbsolute(rawRoot)) return undefined;
    const root = await realpath(rawRoot);
    return isWithin(root, trustedCwd) ? root : undefined;
  } catch {
    return undefined;
  }
}

async function noFollowEntry(root: string, rawPath: string): Promise<{ path: string; kind: "file" | "directory" } | undefined> {
  if (!safeLocalRelativePath(rawPath, rawPath === ".")) return undefined;
  let current = root;
  for (const component of rawPath.split("/")) {
    if (component === ".") continue;
    current = resolve(current, component);
    if (!isWithin(root, current)) return undefined;
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) return undefined;
      if (!entry.isDirectory() && !entry.isFile()) return undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) return undefined;
    const resolved = await realpath(current);
    if (!isWithin(root, resolved)) return undefined;
    if (entry.isFile()) return { path: resolved, kind: "file" };
    if (entry.isDirectory()) return { path: resolved, kind: "directory" };
  } catch {
    return undefined;
  }
  return undefined;
}

async function claimFreeReadSummary(
  event: PreToolUseEvent,
): Promise<"Local repository read" | "Local repository status" | undefined> {
  const input = asObject(event.tool_input);
  if (!input) return undefined;
  const root = await trustedRepositoryRoot(event.cwd);
  if (!root) return undefined;
  if (exactClaimFreeShellTools.has(event.tool_name)) {
    if (!exactKeys(input, ["command"]) || typeof input.command !== "string") return undefined;
    return claimFreeStatusCommands.has(input.command) ? "Local repository status" : undefined;
  }
  if (event.tool_name !== "Read") return undefined;
  if (!exactKeys(input, ["file_path", "offset", "limit"]) || typeof input.file_path !== "string") return undefined;
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 1)) return undefined;
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100_000)) return undefined;
  return (await noFollowEntry(root, input.file_path))?.kind === "file" ? "Local repository read" : undefined;
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function notFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

async function safeMutationTarget(root: string, cwd: string, rawPath: string): Promise<boolean> {
  if (!rawPath || /[\u0000\r\n]/u.test(rawPath)) return false;
  let trustedRoot: string;
  try {
    trustedRoot = await realpath(root);
  } catch {
    return false;
  }

  const candidates = isAbsolute(rawPath)
    ? [resolve(rawPath)]
    : [resolve(cwd, rawPath), resolve(trustedRoot, rawPath)];
  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    let targetStat;
    try {
      targetStat = await lstat(candidate);
    } catch (cause) {
      if (!notFound(cause)) return false;
      let parent: string;
      try {
        parent = await realpath(dirname(candidate));
      } catch {
        continue;
      }
      if (isWithin(trustedRoot, parent)) return true;
      continue;
    }
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) return false;
    let resolvedTarget: string;
    try {
      resolvedTarget = await realpath(candidate);
    } catch {
      return false;
    }
    return isWithin(trustedRoot, resolvedTarget);
  }
  return false;
}

function patchTargets(input: unknown): string[] | undefined {
  const patch = typeof input === "string" ? input : asObject(input)?.patch;
  if (typeof patch !== "string") return undefined;
  const targets: string[] = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/u) ??
      line.match(/^\*\*\* Move to: (.+)$/u);
    if (match?.[1]) targets.push(match[1]);
  }
  return targets.length > 0 ? targets : undefined;
}

function mutationTargets(event: PreToolUseEvent): string[] | undefined {
  const alias = canonicalToolAlias(event.tool_name);
  if (!fileModifyTools.has(alias)) return [];
  if (alias === "apply_patch" || alias === "functions_apply_patch") return patchTargets(event.tool_input);
  const input = asObject(event.tool_input);
  if (!input) return undefined;
  const targets = [input.file_path, input.path, input.notebook_path]
    .filter((value): value is string => typeof value === "string");
  return targets.length > 0 ? [...new Set(targets)] : undefined;
}

async function mutationPathsAreSafe(event: PreToolUseEvent, worktreePath: string): Promise<boolean> {
  const targets = mutationTargets(event);
  if (targets === undefined) return false;
  for (const target of targets) {
    if (!await safeMutationTarget(worktreePath, event.cwd, target)) return false;
  }
  return true;
}

interface WrapperCoordinates {
  task?: string;
  claim?: string;
  session?: string;
  adapter?: string;
  board?: string;
}

function optionValue(command: string, option: string): string | undefined {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...command.matchAll(new RegExp(`(?:^|\\s)${escaped}\\s+([^\\s]+)`, "gu"))];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function wrapperCoordinates(command: string): WrapperCoordinates {
  const separator = command.search(/\s--\s/u);
  const wrapperPrefix = separator >= 0 ? command.slice(0, separator) : command;
  return {
    task: optionValue(wrapperPrefix, "--task"),
    claim: optionValue(wrapperPrefix, "--claim"),
    session: optionValue(wrapperPrefix, "--session"),
    adapter: optionValue(wrapperPrefix, "--origin-adapter"),
    board: optionValue(wrapperPrefix, "--board"),
  };
}

function wrapperMatches(
  classification: ShellClassification,
  command: string,
  event: PreToolUseEvent,
  claim: ActiveClaim,
): boolean {
  if (!classification.owned_wrapper) return true;
  const coordinates = wrapperCoordinates(command);
  return coordinates.task === claim.task_id &&
    coordinates.claim === claim.claim_id &&
    coordinates.session === event.session_id &&
    coordinates.adapter === event.adapter &&
    (classification.owned_wrapper !== "board" || coordinates.board !== undefined);
}

function boardFromOwnedWrapper(command: string): NormalizeOperationContext["board"] | undefined {
  const board = wrapperCoordinates(command).board;
  return board && /^[a-z0-9][a-z0-9-]{1,62}$/u.test(board)
    ? { kind: "board", id: board }
    : undefined;
}

function exactRequirement(left: Pick<WorkGrant, "capability" | "resource">, right: OperationRequirement): boolean {
  return left.capability === right.capability &&
    left.resource.kind === right.resource.kind &&
    left.resource.id === right.resource.id;
}

function sameResource(left: WorkGrant["resource"], right: OperationRequirement["resource"]): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function sameRequirements(left: readonly OperationRequirement[], right: readonly OperationRequirement[]): boolean {
  return left.length === right.length && left.every((requirement, index) =>
    requirement.capability === right[index]?.capability &&
    requirement.resource.kind === right[index]?.resource.kind &&
    requirement.resource.id === right[index]?.resource.id);
}

function sameRequestBinding(request: GuardRequest, operation: CanonicalOperation): boolean {
  return request.task_id === operation.task_id &&
    request.claim_id === operation.claim_id &&
    request.origin_adapter === operation.origin_adapter &&
    request.session_id === operation.session_id &&
    request.cwd_worktree_ref === operation.cwd_worktree_ref &&
    request.operation_digest === operation.digest &&
    sameRequirements(request.requirements, operation.requirements);
}

function inspectionMatchesClaim(inspection: GuardTaskInspection, claim: ActiveClaim): boolean {
  const active = inspection.active;
  return active.task_id === claim.task_id &&
    active.claim_id === claim.claim_id &&
    ("origin_adapter" in active) === ("origin_adapter" in claim) &&
    (!("origin_adapter" in active) || !("origin_adapter" in claim) || active.origin_adapter === claim.origin_adapter) &&
    active.session_id === claim.session_id &&
    active.host === claim.host &&
    active.branch === claim.branch &&
    active.worktree_ref === claim.worktree_ref &&
    active.repo_id === claim.repo_id &&
    inspection.worktree.branch === claim.branch &&
    inspection.worktree.worktree_ref === claim.worktree_ref;
}

interface EvaluationContext {
  event: PreToolUseEvent;
  claim: ActiveClaim;
  task: TaskRecord;
  inspection: GuardTaskInspection;
  classification?: ShellClassification;
}

interface CurrentPromptContext {
  claim: ContractActiveClaim;
  context: GuardPromptContext;
}

interface PermitLifecycleBoundary {
  mayCommit(): Promise<boolean>;
  complete(decision: GuardDecision): void;
}

export class GuardService {
  private readonly mode: GuardEvaluationMode | undefined;
  private readonly requestStoreConfigured: boolean;
  private readonly requestStore: GuardRequestStoreAuthority | undefined;

  constructor(private readonly options: GuardServiceOptions) {
    this.mode = GuardEvaluationModeSchema.safeParse(options.mode ?? "enforce").data;
    this.requestStoreConfigured = options.guard_request_store !== undefined;
    this.requestStore = captureGuardRequestStore(options.guard_request_store);
  }

  async evaluatePreTool(eventInput: unknown): Promise<GuardDecision> {
    const eventResult = this.safeCommonEvent(eventInput);
    if (!eventResult.success || eventResult.data.event !== "pre_tool_use") {
      return this.deny("GUARD_PROTOCOL_MISMATCH");
    }
    const event = eventResult.data;
    if (!this.mode) return this.deny("GUARD_UNAVAILABLE");
    if (this.mode === "observe" && !await this.observeStateAvailable()) {
      return this.deny("GUARD_UNAVAILABLE");
    }

    const earlyCommand = commandFrom(event);
    if (earlyCommand && detectGuardSelfApproval(earlyCommand)) {
      return this.deny("GUARD_SELF_APPROVAL_DENIED");
    }

    const claimFree = await claimFreeReadSummary(event);
    if (claimFree) {
      return GuardDecisionSchema.parse({
        decision: "ALLOW",
        operation_id: newOperationId(),
        summary: claimFree,
        execution_boundary: "hook",
      });
    }

    const runWithinRegistryBarrier = guardRegistryMutationBarrierRunner(
      this.options.registry_mutation_barrier,
    );
    if (!this.options.registry_view || !runWithinRegistryBarrier) {
      return this.deny("GUARD_UNAVAILABLE");
    }

    let authoritativeDecision: GuardDecision | undefined;
    const evaluateWithinBarrier = async (): Promise<GuardDecision> =>
      this.options.registry_view.withCommittedView(async () => {
        const decision = await this.evaluatePinned(event, {
          mayCommit: async () => {
            try {
              if (await this.options.registry_view.committedViewIsStale()) return false;
            } catch {
              return false;
            }
            return true;
          },
          complete: (committedDecision) => {
            if (authoritativeDecision) {
              throw new Error("Guard permit decision completed more than once");
            }
            authoritativeDecision = committedDecision;
          },
        });
        if (authoritativeDecision) return authoritativeDecision;
        if (await this.options.registry_view.committedViewIsStale()) {
          return this.deny("GUARD_UNAVAILABLE");
        }
        return decision;
      });

    try {
      const callbackDecision = await runWithinRegistryBarrier(evaluateWithinBarrier);
      return authoritativeDecision ?? callbackDecision;
    } catch {
      return authoritativeDecision ?? this.deny("GUARD_UNAVAILABLE");
    }
  }

  private async evaluatePinned(
    event: PreToolUseEvent,
    permitLifecycle: PermitLifecycleBoundary,
  ): Promise<GuardDecision> {
    let activeClaims: ActiveClaim[];
    let claim: ActiveClaim | undefined;
    try {
      activeClaims = await this.options.claims.listActiveClaims();
    } catch {
      return this.deny("GUARD_UNAVAILABLE");
    }
    const exactClaims = activeClaims.filter((candidate) =>
      "origin_adapter" in candidate && candidate.origin_adapter === event.adapter &&
      candidate.session_id === event.session_id && candidate.host === this.options.host);
    if (exactClaims.length !== 1) {
      if (exactClaims.length > 1) return this.deny("GUARD_UNAVAILABLE");
      const sameSession = activeClaims.some((candidate) => candidate.session_id === event.session_id);
      return this.deny(sameSession ? "GUARD_CLAIM_MISMATCH" : "GUARD_CLAIM_REQUIRED");
    }
    claim = exactClaims[0] as ActiveClaim;

    let inspection: GuardTaskInspection;
    let task: TaskRecord;
    let sourceTaskRevision: string;
    try {
      inspection = await this.options.tasks.inspectForGuard(claim.task_id, claim.claim_id);
      task = await this.options.tasks.getTask(claim.task_id);
      sourceTaskRevision = await this.options.tasks.sourceRevisionForGuard(task);
    } catch {
      return this.deny("GUARD_UNAVAILABLE", claim);
    }
    if (!inspectionMatchesClaim(inspection, claim)) return this.deny("GUARD_WORKTREE_MISMATCH", claim);
    if (task.id !== claim.task_id || task.repo_id !== claim.repo_id) return this.deny("GUARD_UNAVAILABLE", claim);
    if ((task.kind === "temporary" || task.kind === "child") && task.lifecycle !== "active") {
      return this.deny("GUARD_UNAVAILABLE", claim);
    }
    if (sourceTaskRevision !== claim.source_task_revision) return this.deny("GUARD_UNAVAILABLE", claim);
    const boundClaim = ContractActiveClaimSchema.safeParse(claim);
    if (!boundClaim.success || task.work_contract === undefined ||
      JSON.stringify(task.work_contract) !== JSON.stringify(boundClaim.data.work_contract)) {
      return this.deny("GUARD_RESOURCE_AUTHORITY_UNAVAILABLE", claim);
    }
    if (!await mutationPathsAreSafe(event, inspection.worktree.path)) {
      return this.deny("GUARD_WORKTREE_MISMATCH", claim);
    }

    const context = await this.normalizationContext(event, claim, task, inspection);
    if (!context) return this.deny("GUARD_UNAVAILABLE", claim);

    let classification: ShellClassification | undefined;
    let directHighRisk = false;
    const command = commandFrom(event);
    if (shellTools.has(canonicalToolAlias(event.tool_name))) {
      if (!command) return this.deny("GUARD_WRAPPER_REQUIRED", claim);
      try {
        classification = await classifyShell(command, {
          trusted_worktree_path: inspection.worktree.path,
          cwd: event.cwd,
          repository: context.repository,
          ...(context.issue ? { issue: context.issue } : {}),
          ...(context.board ? { board: context.board } : {}),
        });
      } catch (cause) {
        return this.deny(cause instanceof ShellClassificationError && cause.code === "unsafe_local_script"
          ? "GUARD_WORKTREE_MISMATCH"
          : "GUARD_WRAPPER_REQUIRED", claim);
      }
      if (classification.self_approval) return this.deny("GUARD_SELF_APPROVAL_DENIED", claim);
      if (!wrapperMatches(classification, command, event, claim)) return this.deny("GUARD_CLAIM_MISMATCH", claim);
      if (classification.unresolved_signals.length > 0) {
        return this.deny("GUARD_WRAPPER_REQUIRED", claim, undefined, classification.execution_boundary);
      }
    } else if (directHighRiskTools.has(canonicalToolAlias(event.tool_name))) {
      directHighRisk = true;
    }

    let operation: Awaited<ReturnType<typeof normalizeOperation>>;
    try {
      operation = await normalizeOperation(event, context, this.options.digest_key);
    } catch (cause) {
      if (cause instanceof OperationNormalizationError) {
        if (cause.code === "self_approval") return this.deny("GUARD_SELF_APPROVAL_DENIED", claim);
        if (cause.code === "cwd_outside_worktree") return this.deny("GUARD_WORKTREE_MISMATCH", claim);
        if (cause.code === "unresolved_boundary") return this.deny("GUARD_WRAPPER_REQUIRED", claim);
      }
      return this.deny("GUARD_UNAVAILABLE", claim);
    }

    const evaluation: EvaluationContext = { event, claim, task, inspection, ...(classification ? { classification } : {}) };
    const ownership = this.ownershipDecision(evaluation, operation.requirements, activeClaims);
    if (ownership) return this.deny(ownership, claim, operation);

    for (const requirement of operation.requirements) {
      try {
        await this.options.authority.assertKnownRequirement(task, requirement);
      } catch {
        return this.deny("GUARD_RESOURCE_AUTHORITY_UNAVAILABLE", claim, operation);
      }
    }

    if (await this.options.registry_view.committedViewIsStale()) {
      return this.deny("GUARD_UNAVAILABLE", claim, operation);
    }

    if (classification?.direct_high_risk || directHighRisk) {
      return this.deny(
        "GUARD_WRAPPER_REQUIRED",
        claim,
        operation,
        classification?.execution_boundary ?? operation.execution_boundary,
      );
    }

    const contractClaim = ContractActiveClaimSchema.safeParse(claim);
    if (!contractClaim.success) return this.deny("GUARD_RESOURCE_AUTHORITY_UNAVAILABLE", claim, operation);
    const missing = operation.requirements.filter((requirement) =>
      !contractClaim.data.work_contract.grants.some((candidate) => exactRequirement(candidate, requirement)));
    if (missing.length === 0) {
      return GuardDecisionSchema.parse({
        decision: "ALLOW",
        operation_id: operation.operation_id,
        summary: operation.summary,
        execution_boundary: operation.execution_boundary,
      });
    }

    if (this.mode === "observe") {
      return GuardDecisionSchema.parse({
        decision: "ALLOW",
        operation_id: operation.operation_id,
        summary: operation.summary,
        execution_boundary: operation.execution_boundary,
        observed_decision: "PERMIT_REQUIRED",
      });
    }
    if ((this.requestStoreConfigured && !this.requestStore) ||
      (!this.requestStore && !this.options.permit_decisions)) {
      return this.deny("GUARD_UNAVAILABLE", claim, operation);
    }
    try {
      if (!await permitLifecycle.mayCommit()) return this.deny("GUARD_UNAVAILABLE", claim, operation);
      const result = GuardPermitResultSchema.safeParse(
        await this.decideMissingGrant(operation, missing),
      );
      if (!result.success) return this.deny("GUARD_UNAVAILABLE", claim, operation);
      if ("decision" in result.data) {
        const decision = this.deny(result.data.code, claim, operation);
        permitLifecycle.complete(decision);
        return decision;
      }
      if (
        result.data.task_id !== operation.task_id ||
        result.data.claim_id !== operation.claim_id ||
        result.data.origin_adapter !== operation.origin_adapter ||
        result.data.session_id !== operation.session_id ||
        result.data.cwd_worktree_ref !== operation.cwd_worktree_ref ||
        result.data.operation_digest !== operation.digest ||
        !sameRequirements(result.data.requirements, operation.requirements) ||
        !sameRequirements(result.data.missing_requirements, missing)
      ) return this.deny("GUARD_UNAVAILABLE", claim, operation);
      if (result.data.request_state === "APPROVED") {
        if (operation.execution_boundary !== "hook") {
          const decision = GuardDecisionSchema.parse({
            decision: "ALLOW",
            operation_id: operation.operation_id,
            summary: operation.summary,
            execution_boundary: operation.execution_boundary,
            ...(result.data.journal_warning ? { journal_warning: result.data.journal_warning } : {}),
          });
          permitLifecycle.complete(decision);
          return decision;
        }
        if (!this.requestStore) return this.deny("GUARD_UNAVAILABLE", claim, operation);
        const consumed = await this.requestStore.consumeMatching(operation, event.tool_use_id);
        if (!sameRequestBinding(consumed.request, operation)) {
          return this.deny("GUARD_UNAVAILABLE", claim, operation);
        }
        const decision = GuardDecisionSchema.parse({
          decision: "ALLOW",
          operation_id: operation.operation_id,
          summary: operation.summary,
          execution_boundary: operation.execution_boundary,
          consumed_request_id: consumed.request.request_id,
          ...(consumed.journal_warning ? { journal_warning: consumed.journal_warning } : {}),
        });
        permitLifecycle.complete(decision);
        return decision;
      }
      const decision = GuardDecisionSchema.parse({
        decision: "PERMIT_REQUIRED",
        operation_id: operation.operation_id,
        request_id: result.data.request_id,
        summary: operation.summary,
        approval_command: `/jhw:unlock ${result.data.request_id}`,
        approval_expires_at: result.data.approval_expires_at,
        ...(result.data.journal_warning ? { journal_warning: result.data.journal_warning } : {}),
      });
      permitLifecycle.complete(decision);
      return decision;
    } catch (cause) {
      const decision = this.denyForStateFailure(cause, claim, operation);
      permitLifecycle.complete(decision);
      return decision;
    }
  }

  async submitUserPrompt(eventInput: unknown): Promise<GuardSideEventResult> {
    const result = this.safeVariant(UserPromptSubmitEventSchema, eventInput);
    if (!result.success) return this.sideProtocolDeny();
    const event = result.data;
    const requestId = exactGuardUnlockRequestId(event.prompt);
    if (!requestId || this.mode === "observe") {
      const current = await this.readCurrentPromptContext(event.adapter, event.session_id);
      return GuardSideEventResultSchema.parse({
        status: "NO_STATE_CHANGE",
        event: "user_prompt_submit",
        summary: requestId ? "Observe mode does not approve permits" : "Prompt did not change Guard authority",
        ...(current?.context ? { context: current.context } : {}),
      });
    }
    if (!this.mode || !this.requestStore) {
      return this.sideDeny("GUARD_UNAVAILABLE", "user_prompt_submit");
    }
    const runWithinRegistryBarrier = guardRegistryMutationBarrierRunner(
      this.options.registry_mutation_barrier,
    );
    if (!this.options.registry_view || !runWithinRegistryBarrier) {
      return this.sideDeny("GUARD_UNAVAILABLE", "user_prompt_submit");
    }

    let authoritative: GuardSideEventResult | undefined;
    try {
      const callbackResult = await runWithinRegistryBarrier(async () =>
        this.options.registry_view.withCommittedView(async () => {
          let inspected: GuardRequestInspection;
          try {
            inspected = await this.requestStore!.inspect();
          } catch (cause) {
            return this.sideDenyForStateFailure(cause, "user_prompt_submit");
          }
          const request = inspected.requests.find((candidate) => candidate.request_id === requestId);
          if (!request) return this.sideDeny("GUARD_REQUEST_NOT_FOUND", "user_prompt_submit");
          if (request.origin_adapter !== event.adapter || request.session_id !== event.session_id) {
            return this.sideDeny("GUARD_PERMIT_MISMATCH", "user_prompt_submit");
          }
          const current = await this.resolveCurrentPromptContext(event.adapter, event.session_id);
          if ("code" in current) return this.sideDeny(current.code, "user_prompt_submit");
          if (request.task_id !== current.claim.task_id || request.claim_id !== current.claim.claim_id) {
            return this.sideDeny("GUARD_PERMIT_MISMATCH", "user_prompt_submit", current.context);
          }
          if (await this.options.registry_view.committedViewIsStale()) {
            return this.sideDeny("GUARD_UNAVAILABLE", "user_prompt_submit", current.context);
          }
          try {
            const approved = await this.requestStore!.approveFromPrompt(
              event.adapter,
              event.session_id,
              event.prompt,
            );
            if (approved.status !== "APPROVED" || approved.request.request_id !== requestId ||
              approved.request.task_id !== current.claim.task_id ||
              approved.request.claim_id !== current.claim.claim_id) {
              return this.sideDeny("GUARD_UNAVAILABLE", "user_prompt_submit", current.context);
            }
            const sideResult = GuardSideEventResultSchema.parse({
              status: "APPROVED",
              event: "user_prompt_submit",
              request_id: approved.request.request_id,
              context: current.context,
              start_by: approved.request.start_by,
              execution_consumes_permit: true,
              summary: "One-time permit approved; execution consumes it at start",
              ...(approved.journal_warning ? { journal_warning: approved.journal_warning } : {}),
            });
            authoritative = sideResult;
            return sideResult;
          } catch (cause) {
            const sideResult = this.sideDenyForStateFailure(
              cause,
              "user_prompt_submit",
              current.context,
            );
            authoritative = sideResult;
            return sideResult;
          }
        }));
      return authoritative ?? callbackResult;
    } catch {
      return authoritative ?? this.sideDeny("GUARD_UNAVAILABLE", "user_prompt_submit");
    }
  }

  async completePostTool(eventInput: unknown): Promise<GuardSideEventResult> {
    const result = this.safeVariant(PostToolUseEventSchema, eventInput);
    if (!result.success) return this.sideProtocolDeny();
    if (!this.mode) return this.sideDeny("GUARD_UNAVAILABLE", "post_tool_use");
    if (this.mode === "observe") {
      return GuardSideEventResultSchema.parse({
        status: "NO_STATE_CHANGE",
        event: "post_tool_use",
        summary: "Observe mode does not complete permits",
      });
    }
    if (!this.requestStore) {
      return this.requestStoreConfigured
        ? this.sideDeny("GUARD_UNAVAILABLE", "post_tool_use")
        : GuardSideEventResultSchema.parse({
          status: "NO_STATE_CHANGE",
          event: "post_tool_use",
          summary: "Tool completion state is not integrated",
        });
    }
    const event = result.data;
    const runWithinRegistryBarrier = guardRegistryMutationBarrierRunner(
      this.options.registry_mutation_barrier,
    );
    if (!runWithinRegistryBarrier) {
      return this.sideDeny("GUARD_UNAVAILABLE", "post_tool_use");
    }
    let authoritative: GuardSideEventResult | undefined;
    try {
      const callbackResult = await runWithinRegistryBarrier(async () => {
        const completed = await this.completePostToolPinned(event);
        if (completed.status === "COMPLETED" || completed.status === "FAILED") {
          authoritative = completed;
        }
        return completed;
      });
      return authoritative ?? callbackResult;
    } catch {
      return authoritative ?? this.sideDeny("GUARD_UNAVAILABLE", "post_tool_use");
    }
  }

  private async completePostToolPinned(
    event: z.infer<typeof PostToolUseEventSchema>,
  ): Promise<GuardSideEventResult> {
    let inspected: GuardRequestInspection;
    try {
      inspected = await this.requestStore!.inspect();
    } catch (cause) {
      return this.sideDenyForStateFailure(cause, "post_tool_use");
    }
    const request = inspected.requests.find((candidate) => candidate.correlation_id === event.tool_use_id);
    if (!request) return this.sideDeny("GUARD_REQUEST_NOT_FOUND", "post_tool_use");
    if (request.origin_adapter !== event.adapter || request.session_id !== event.session_id) {
      return this.sideDeny("GUARD_PERMIT_MISMATCH", "post_tool_use");
    }
    if (request.state !== "CONSUMED") {
      return this.sideDeny("GUARD_PERMIT_CONSUMED", "post_tool_use");
    }
    try {
      const completed = await this.requestStore!.complete(event.tool_use_id, event.ok);
      if (
        completed.request.request_id !== request.request_id ||
        completed.request.task_id !== request.task_id ||
        completed.request.claim_id !== request.claim_id ||
        completed.request.origin_adapter !== event.adapter ||
        completed.request.session_id !== event.session_id
      ) return this.sideDeny("GUARD_UNAVAILABLE", "post_tool_use");
      return GuardSideEventResultSchema.parse({
        status: completed.status,
        event: "post_tool_use",
        request_id: completed.request.request_id,
        task_id: completed.request.task_id,
        claim_id: completed.request.claim_id,
        summary: completed.status === "COMPLETED" ? "Guarded tool completed" : "Guarded tool failed",
        ...(completed.journal_warning ? { journal_warning: completed.journal_warning } : {}),
      });
    } catch (cause) {
      return this.sideDenyForStateFailure(cause, "post_tool_use");
    }
  }

  private async decideMissingGrant(
    operation: CanonicalOperation,
    missing: readonly OperationRequirement[],
  ): Promise<unknown> {
    if (this.requestStoreConfigured && !this.requestStore) {
      throw new ControlError("GUARD_UNAVAILABLE", "Guard request state authority is unavailable");
    }
    if (!this.requestStore) {
      return this.options.permit_decisions?.decideMissingGrant(operation, missing);
    }
    const result = await this.requestStore.createOrReusePending(operation);
    const request = result.request;
    if ((request.state !== "PENDING" && request.state !== "APPROVED") ||
      !sameRequestBinding(request, operation)) {
      throw new ControlError("GUARD_UNAVAILABLE", "Guard request binding is unavailable");
    }
    return {
      task_id: request.task_id,
      claim_id: request.claim_id,
      origin_adapter: request.origin_adapter,
      session_id: request.session_id,
      cwd_worktree_ref: request.cwd_worktree_ref,
      requirements: request.requirements,
      missing_requirements: missing,
      operation_digest: request.operation_digest,
      request_state: request.state,
      request_id: request.request_id,
      approval_expires_at: request.approval_expires_at,
      ...(result.journal_warning ? { journal_warning: result.journal_warning } : {}),
    };
  }

  private async readCurrentPromptContext(
    adapter: GuardAdapter,
    sessionId: string,
  ): Promise<CurrentPromptContext | undefined> {
    if (!this.options.registry_view) return undefined;
    try {
      return await this.options.registry_view.withCommittedView(async () => {
        const current = await this.resolveCurrentPromptContext(adapter, sessionId);
        if ("code" in current || await this.options.registry_view.committedViewIsStale()) return undefined;
        return current;
      });
    } catch {
      return undefined;
    }
  }

  private async resolveCurrentPromptContext(
    adapter: GuardAdapter,
    sessionId: string,
  ): Promise<CurrentPromptContext | { code: GuardDenyCode }> {
    let activeClaims: ActiveClaim[];
    try {
      activeClaims = await this.options.claims.listActiveClaims();
    } catch {
      return { code: "GUARD_UNAVAILABLE" };
    }
    const exact = activeClaims.filter((candidate) =>
      "origin_adapter" in candidate && candidate.origin_adapter === adapter &&
      candidate.session_id === sessionId && candidate.host === this.options.host);
    if (exact.length !== 1) {
      if (exact.length > 1) return { code: "GUARD_UNAVAILABLE" };
      return {
        code: activeClaims.some((candidate) => candidate.session_id === sessionId)
          ? "GUARD_CLAIM_MISMATCH"
          : "GUARD_CLAIM_REQUIRED",
      };
    }
    const bound = ContractActiveClaimSchema.safeParse(exact[0]);
    if (!bound.success) return { code: "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE" };
    return {
      claim: bound.data,
      context: GuardPromptContextSchema.parse({
        task_id: bound.data.task_id,
        claim_id: bound.data.claim_id,
        task_alias: bound.data.task_alias,
        work_contract_digest: bound.data.work_contract_digest,
      }),
    };
  }

  private stateFailure(cause: unknown): {
    code: GuardDenyCode;
    journalWarning?: "GUARD_JOURNAL_UNAVAILABLE";
    reason?: ErrorReason;
  } {
    if (cause instanceof ControlError) {
      const code = GuardDenyCodeSchema.safeParse(cause.code);
      const reason = ErrorReasonSchema.safeParse(cause.details.reason);
      const journalWarning = cause.details.journal_warning === "GUARD_JOURNAL_UNAVAILABLE"
        ? "GUARD_JOURNAL_UNAVAILABLE" as const
        : undefined;
      return {
        code: code.success ? code.data : "GUARD_UNAVAILABLE",
        ...(journalWarning ? { journalWarning } : {}),
        ...(reason.success ? { reason: reason.data } : {}),
      };
    }
    return { code: "GUARD_UNAVAILABLE" };
  }

  private denyForStateFailure(
    cause: unknown,
    claim?: ActiveClaim,
    operation?: CanonicalOperation,
  ): GuardDecision {
    const failure = this.stateFailure(cause);
    return this.deny(
      failure.code,
      claim,
      operation,
      "hook",
      failure.journalWarning,
      failure.reason,
    );
  }

  private sideDenyForStateFailure(
    cause: unknown,
    event: "user_prompt_submit" | "post_tool_use",
    context?: GuardPromptContext,
  ): GuardSideEventResult {
    const failure = this.stateFailure(cause);
    return this.sideDeny(failure.code, event, context, failure.journalWarning, failure.reason);
  }

  private safeCommonEvent(value: unknown): ReturnType<typeof GuardCommonEventSchema.safeParse> {
    try {
      return GuardCommonEventSchema.safeParse(value);
    } catch {
      return GuardCommonEventSchema.safeParse(null);
    }
  }

  private safeVariant<T extends z.ZodTypeAny>(schema: T, value: unknown): ReturnType<T["safeParse"]> {
    try {
      return schema.safeParse(value) as ReturnType<T["safeParse"]>;
    } catch {
      return schema.safeParse(null) as ReturnType<T["safeParse"]>;
    }
  }

  private async observeStateAvailable(): Promise<boolean> {
    if (!this.options.inspect_guard_state) return false;
    try {
      return await this.options.inspect_guard_state() === true;
    } catch {
      return false;
    }
  }

  private async normalizationContext(
    event: PreToolUseEvent,
    claim: ActiveClaim,
    task: TaskRecord,
    inspection: GuardTaskInspection,
  ): Promise<NormalizeOperationContext | undefined> {
    let issue: NormalizeOperationContext["issue"];
    if (task.kind === "formal") {
      issue = { kind: "issue", id: task.issue_node_id };
    } else if (task.kind === "child") {
      let parent: TaskRecord;
      try {
        parent = await this.options.tasks.getTask(task.parent_task_id);
      } catch {
        return undefined;
      }
      if (parent.kind !== "formal" || parent.task_role !== "parent") return undefined;
      issue = { kind: "issue", id: parent.issue_node_id };
    }
    const command = commandFrom(event);
    const board = command ? boardFromOwnedWrapper(command) : undefined;
    const notionDatabase = notionDatabaseFrom(event);
    return {
      evaluation_stage: "hook",
      task_id: claim.task_id,
      claim_id: claim.claim_id,
      session_id: claim.session_id,
      cwd_worktree_ref: claim.worktree_ref,
      trusted_worktree_path: inspection.worktree.path,
      repository: { kind: "repository", id: claim.repo_id },
      ...(issue ? { issue } : {}),
      ...(notionDatabase ? { notion_database: notionDatabase } : {}),
      ...(board ? { board } : {}),
    };
  }

  private ownershipDecision(
    context: EvaluationContext,
    requirements: readonly OperationRequirement[],
    activeClaims: readonly ActiveClaim[],
  ): GuardDenyCode | undefined {
    const current = ContractActiveClaimSchema.safeParse(context.claim);
    if (!current.success) return "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE";
    for (const candidate of activeClaims) {
      const candidateContract = ContractActiveClaimSchema.safeParse(candidate);
      if (!candidateContract.success) return "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE";
      if (candidate.claim_id === context.claim.claim_id) continue;
      for (const requirement of requirements) {
        const otherOwns = candidateContract.data.work_contract.grants
          .filter((entry) => sameResource(entry.resource, requirement.resource));
        if (otherOwns.length === 0) continue;
        const currentExclusive = current.data.work_contract.grants.some((entry) =>
          sameResource(entry.resource, requirement.resource) && entry.coordination === "exclusive");
        if (currentExclusive || otherOwns.some((entry) => entry.coordination === "exclusive")) {
          return "GUARD_RESOURCE_OWNED";
        }
      }
    }
    return undefined;
  }

  private deny(
    codeInput: GuardDenyCode,
    claim?: ActiveClaim,
    operation?: Awaited<ReturnType<typeof normalizeOperation>>,
    boundary: ExecutionBoundary = "hook",
    journalWarning?: "GUARD_JOURNAL_UNAVAILABLE",
    reason?: ErrorReason,
  ): GuardDecision {
    const code = GuardDenyCodeSchema.parse(codeInput);
    if (this.mode === "observe" && !hardObserveCodes.has(code)) {
      return GuardDecisionSchema.parse({
        decision: "ALLOW",
        operation_id: operation?.operation_id ?? newOperationId(),
        summary: operation?.summary ?? summaryByCode[code],
        execution_boundary: operation?.execution_boundary ?? boundary,
        observed_decision: "DENY",
        ...(journalWarning ? { journal_warning: journalWarning } : {}),
      });
    }
    return GuardDecisionSchema.parse({
      decision: "DENY",
      code,
      ...(claim ? { task_id: claim.task_id, claim_id: claim.claim_id } : {}),
      summary: summaryByCode[code],
      ...(journalWarning ? { journal_warning: journalWarning } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  private sideDeny(
    codeInput: GuardDenyCode,
    event?: "user_prompt_submit" | "post_tool_use",
    context?: GuardPromptContext,
    journalWarning?: "GUARD_JOURNAL_UNAVAILABLE",
    reason?: ErrorReason,
  ): GuardSideEventResult {
    const code = GuardDenyCodeSchema.parse(codeInput);
    return GuardSideEventResultSchema.parse({
      status: "DENY",
      code,
      ...(event ? { event } : {}),
      summary: summaryByCode[code],
      ...(context ? { context } : {}),
      ...(journalWarning ? { journal_warning: journalWarning } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  private sideProtocolDeny(): GuardSideEventResult {
    return this.sideDeny("GUARD_PROTOCOL_MISMATCH");
  }
}

export interface GuardServiceComposition {
  readonly service: GuardService;
  readonly registry_mutation_lock: MutationLock;
}

/**
 * Production composition seam: the object returned for Registry writers is
 * the exact concrete MutationLock whose captured run method backs Guard.
 */
export function createGuardServiceComposition(
  registryMutationLock: MutationLock,
  options: Omit<GuardServiceOptions, "registry_mutation_barrier">,
): GuardServiceComposition {
  const registryMutationBarrier = createGuardRegistryMutationBarrier(registryMutationLock);
  return Object.freeze({
    service: new GuardService({
      ...options,
      registry_mutation_barrier: registryMutationBarrier,
    }),
    registry_mutation_lock: registryMutationLock,
  });
}
