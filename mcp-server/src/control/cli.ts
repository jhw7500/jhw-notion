#!/usr/bin/env node
import { constants as fsConstants, realpathSync, writeSync, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readlink,
  realpath,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { TextDecoder } from "node:util";
import { z, type ZodType } from "zod";

import { spawn } from "node:child_process";
import { constants as osConstants, tmpdir } from "node:os";

import { BoardJournal, type BoardJournalPort } from "./board-journal.js";
import {
  BoardService,
  captureLivenessTrio,
  createProcessLivenessProbe,
  type BoardAcquireInput,
  type LivenessProbe,
} from "./board-service.js";
import { Catalog } from "./catalog.js";
import { RegistryRecordStore } from "./codec.js";
import { ClaimService } from "./claim-service.js";
import { loadControlConfig } from "./config.js";
import { ControlContractAuthority } from "./contract-authority.js";
import { ControlError } from "./errors.js";
import { GuardAdapterSchema, GuardWorktreeRefSchema, type GuardAdapter } from "./guard-protocol.js";
import { adapterContractResults, NativeHookOutputSchema, renderStaticHookFailure } from "./hook-codecs.js";
import {
  createProductionGuardRequestStore,
  GuardDigestKey,
  type GuardRequestStore,
} from "./guard-state.js";
import { GitHubProjectClient, type RegistrationRecordWarning } from "./github-project.js";
import { GitHubSourceService, type TaskCoordinateInput } from "./github-source.js";
import { PilotJournal, type JournalPort } from "./journal.js";
import {
  createProductionMutationLock,
  ProcessRunner,
  type MutationLockPort,
} from "./process.js";
import { PortfolioService } from "./portfolio.js";
import { PreflightService } from "./preflight.js";
import { RegistrationHintStore } from "./registration-hint.js";
import { RegistryGit } from "./registry-git.js";
import { createSensitiveDataPolicy } from "./sensitive-data.js";
import {
  TaskService,
  type CurrentTaskContextResult,
  type CurrentTaskSummary,
  type TaskFinishInput,
  type TaskRecoverInput,
} from "./task-service.js";
import { WorktreeManager } from "./worktree.js";
import {
  parseContractIntentFlags,
  parseRequiredForParentFlag,
  parseTaskCompletionEvidenceFlags,
  parseTaskRoleFlag,
  parseWorkContractFlags,
} from "./work-contract-cli.js";
import { assertPhase1ACommittedLegacy, createAuthorityService } from "./authority.js";
import { getNotionClient } from "../notion-client.js";
import { verifyConfiguredNotionAuthorityRoutes } from "../notion/authority-guard.js";
import {
  AuthorityRecordSchema,
  ActiveClaimSchema,
  BoardConflictSummarySchema,
  BoundedPortfolioPayloadSchema,
  COMMAND_FAILURE_STDERR_HEAD_BYTES,
  CommandFailureDetailSchema,
  ConflictingClaimSummarySchema,
  ClaimCoordinateSchema,
  GuardRequestSchema,
  LockHolderSummarySchema,
  ErrorReasonSchema,
  PreflightResultSchema,
  ProjectRecordLinkSchema,
  ProjectRecordUpdateSchema,
  RegisterProjectInputSchema,
  RetainedTaskSummarySchema,
  SnapshotExportResultSchema,
  UpdateProjectInputSchema,
  type ActiveClaim,
  type BoardConflictSummary,
  type BoardMode,
  type BoundedPortfolioPayload,
  type CommandFailureDetail,
  type ConflictingClaimSummary,
  type LockHolderSummary,
  type PreflightResult,
  type ProjectRecordLink,
  type ProjectRecordUpdate,
  type RegisterProjectInput,
  type RetainedTaskSummary,
  type RegistryMutationCommand,
  type SnapshotExportResult,
  type TaskRecord,
  type UpdateProjectInput,
} from "./schemas.js";

const TASK_ID = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_ID = /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID = /^prj-[a-z0-9][a-z0-9-]{1,62}$/;
const REPO_ID = /^repo-[a-z0-9][a-z0-9-]{1,62}$/;
const MAX_CLI_OUTPUT_BYTES = 12 * 1024;
const CLI_RESULT_BUDGET = MAX_CLI_OUTPUT_BYTES - 256;
const maximumGuardClaims = 4_096;

const commandFailureSourceBase = {
  command: ClaimCoordinateSchema,
  args: z.array(z.string()),
};
const CommandFailureSourceSchema = z.union([
  z.object({
    ...commandFailureSourceBase,
    exitCode: z.number().int().positive().safe().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    cause: z.string().optional(),
  }).strict(),
  z.object({
    ...commandFailureSourceBase,
    exitCode: z.null(),
    cause: z.string(),
  }).strict(),
]);

const GuardRequestInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_initialized"), requests: z.array(GuardRequestSchema).length(0) }).strict(),
  z.object({ status: z.literal("ready"), requests: z.array(GuardRequestSchema).max(65_536) }).strict(),
]);
const GuardDigestKeyInspectionSchema = z.object({
  status: z.enum(["not_initialized", "ready"]),
}).strict();
const GuardRequestCountsSchema = z.object({
  PENDING: z.number().int().nonnegative(),
  APPROVED: z.number().int().nonnegative(),
  CONSUMED: z.number().int().nonnegative(),
  COMPLETED: z.number().int().nonnegative(),
  FAILED: z.number().int().nonnegative(),
  EXPIRED: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict();
const GuardRequestStatusSchema = z.union([
  z.object({ safety: z.literal("unavailable") }).strict(),
  z.object({
    safety: z.enum(["ready", "not_initialized"]),
    counts: GuardRequestCountsSchema,
  }).strict(),
]);
const GuardStatusAdapterCoverageEntrySchema = z.object({
  prompt_origin: z.literal("pending"),
  pre_tool_blocking: z.literal("pending"),
  execution_recheck: z.literal("pending"),
}).strict();
const GuardStatusAdapterCoverageSchema = z.object({
  claude: GuardStatusAdapterCoverageEntrySchema,
  codex: GuardStatusAdapterCoverageEntrySchema,
  gemini: GuardStatusAdapterCoverageEntrySchema,
  opencode: GuardStatusAdapterCoverageEntrySchema,
}).strict();
const GuardAdapterCoverageEntrySchema = z.object({
  prompt_origin: z.enum(["ok", "missing", "unsupported"]),
  pre_tool_block: z.enum(["ok", "missing", "unsupported"]),
  post_tool_correlation: z.enum(["ok", "missing", "unsupported"]),
  execution_recheck: z.literal("pending"),
  enforced: z.boolean(),
}).strict();
const GuardAdapterCoverageSchema = z.object({
  claude: GuardAdapterCoverageEntrySchema,
  codex: GuardAdapterCoverageEntrySchema,
  gemini: GuardAdapterCoverageEntrySchema,
  opencode: GuardAdapterCoverageEntrySchema,
}).strict();
const GuardSessionClaimStatusSchema = z.union([
  z.object({ match: z.enum(["none", "ambiguous", "unavailable"]) }).strict(),
  z.object({
    match: z.literal("unique"),
    work_contract_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }).strict(),
]);
const GuardDiagnosticStateSchema = z.object({
  protocol_version: z.literal(1),
  runtime_mode: z.enum(["enforce", "observe"]),
  request_state: GuardRequestStatusSchema,
  digest_key: z.object({ safety: z.enum(["ready", "not_initialized", "unavailable"]) }).strict(),
  registry_claims: z.object({ availability: z.enum(["available", "unavailable"]) }).strict(),
  session_claim: GuardSessionClaimStatusSchema.optional(),
}).strict();
type GuardDiagnosticState = z.infer<typeof GuardDiagnosticStateSchema>;
const GuardStatusResultSchema = GuardDiagnosticStateSchema.extend({
  adapter_coverage: GuardStatusAdapterCoverageSchema,
}).strict();
type GuardStatusResult = z.infer<typeof GuardStatusResultSchema>;
const GuardPreflightDiagnosticsSchema = GuardDiagnosticStateSchema.extend({
  adapter_coverage: GuardAdapterCoverageSchema,
}).strict();
type GuardPreflightDiagnostics = z.infer<typeof GuardPreflightDiagnosticsSchema>;
const GuardPreflightResultSchema = z.object({
  status: z.literal("NO-GO"),
  code: z.literal("GUARD_UNAVAILABLE"),
  diagnostics: GuardPreflightDiagnosticsSchema,
}).strict();

const commandNames = [
  "repository register",
  "task start",
  "task child-start",
  "task contract",
  "task completion-ready",
  "task promote",
  "task handoff",
  "task status",
  "task finish",
  "task recover",
  "task assert-owner",
  "portfolio status",
  "portfolio export",
  "project register",
  "project update",
  "preflight",
  "guard status",
  "guard preflight",
  "board register",
  "board update",
  "board unregister",
  "board list",
  "board status",
  "board acquire",
  "board release",
  "board extend",
  "board share",
  "board reserve",
  "board unreserve",
  "board wait",
  "board recover",
] as const;

const BOARD_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HOLDER_ID = /^hld-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESERVATION_ID = /^rsv-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const osSignals: Partial<Record<string, number>> = osConstants.signals;

type CommandName = (typeof commandNames)[number] | "help" | "invalid";
type FlagValue = string | string[];
type ParsedFlags = Map<string, FlagValue>;

export interface CliResult {
  exitCode: 0 | 1 | 2 | 4 | 75 | 78;
  stdout: string;
  stderr: string;
}

export interface PortfolioPort {
  status(projectId?: string, pageId?: string): Promise<BoundedPortfolioPayload>;
  exportSnapshot(): Promise<SnapshotExportResult>;
  registerProject(input: RegisterProjectInput): Promise<ProjectRecordLink>;
  updateProject(input: UpdateProjectInput): Promise<ProjectRecordUpdate>;
}

export interface PreflightPort {
  run(): Promise<PreflightResult>;
}

interface CodexHookMetadataCommon {
  eventName: string;
  matcher: string | null;
  timeoutSec: number;
  source: string;
  sourcePath: string;
  isManaged: boolean;
  enabled: boolean;
  trustStatus: "managed" | "untrusted" | "trusted" | "modified";
  currentHash: string;
  displayOrder: number;
}

export type CodexHookMetadata = CodexHookMetadataCommon & (
  | { handlerType: "command"; async: boolean; command: string }
  | { handlerType: "mcpTool"; server: string; tool: string }
);

export interface CodexHookProbeResult {
  exitCode: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface CodexHookRuntimeInventory {
  cwd: string;
  hooks: CodexHookMetadata[];
}

export interface CodexHookRuntimePort {
  list(): Promise<CodexHookRuntimeInventory>;
  probe(home: string, command: string, cwd: string): Promise<CodexHookProbeResult>;
}

export interface ClaudeHookRuntimePort {
  probePrompt(home: string): Promise<CodexHookProbeResult>;
  probeCommand(home: string, command: string): Promise<CodexHookProbeResult>;
}

export interface CliDependencies {
  stateDir: string;
  /**
   * Set by the Project client when its durable registration record could not
   * do its job. The command still succeeded, so this rides out on the result
   * rather than changing it — the same shape `journal_warning` uses, and for
   * the same reason: the operator has to be told without the outcome moving.
   */
  registrationRecordWarning?: { code?: RegistrationRecordWarning };
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  taskService: Pick<TaskService,
    "start" | "status" | "finish" | "recover" | "assertOwner" | "handoff" |
    "resumeContext" | "recoveryDiscovery" | "markCompletionReady" | "currentContext">;
  claimService: Pick<ClaimService, "getActive">;
  catalog: Pick<Catalog, "registerFormalTask" | "registerTemporaryTask" | "registerChildTask" | "configureInactiveTask">;
  source: Pick<GitHubSourceService,
    "registerRepository" | "registerFormalTask" | "registerTemporaryTask" | "prepareExistingTask" |
    "withResolvedExistingFormalTask" | "withResolvedTaskStatusContext" | "promoteTemporaryTask">;
  portfolio: PortfolioPort;
  preflight: PreflightPort;
  guardMode: "enforce" | "observe";
  guardRequests: Pick<GuardRequestStore, "inspect">;
  guardDigestKey: Pick<GuardDigestKey, "inspect">;
  guardClaims: Pick<ClaimService, "withCommittedView" | "listActiveClaims">;
  codexRepositoryRoot?: string;
  codexHookRuntime?: CodexHookRuntimePort;
  claudeHookRuntime?: ClaudeHookRuntimePort;
  mutationLock: MutationLockPort;
  journal?: JournalPort;
  boardService: Pick<
    BoardService,
    "register" | "update" | "unregister" | "list" | "status" | "acquire" | "wait" |
    "release" | "extend" | "share" | "reserve" | "unreserve" | "adoptHolder" | "recoverResetState"
  >;
  boardJournal: BoardJournalPort;
  livenessProbe: LivenessProbe;
}

class ParsedCommandFailure extends Error {
  constructor(
    readonly originalCause: unknown,
    readonly flags: ParsedFlags,
  ) {
    super("Command execution failed after parsing");
  }
}

class RetainedTaskFailure extends Error {
  readonly retainedTask: RetainedTaskSummary;

  constructor(
    readonly originalCause: unknown,
    taskId: string,
  ) {
    super("Task start failed after child registration");
    this.retainedTask = RetainedTaskSummarySchema.parse({ task_id: taskId });
  }
}

/** Builds the production graph while retaining explicitly injectable future ports. */
export function createCliDependencies(env: NodeJS.ProcessEnv = process.env): CliDependencies {
  const config = loadControlConfig(env);
  const registrationRecordWarning: { code?: RegistrationRecordWarning } = {};
  const runner = new ProcessRunner(env);
  const sensitiveData = createSensitiveDataPolicy(env, [config.registryDir, config.stateDir, config.worktreeRoot]);
  const registry = new RegistryGit(config, runner, sensitiveData);
  const livenessProbe = createProcessLivenessProbe();
  const boardJournal = new BoardJournal(config.stateDir, {}, sensitiveData);
  const boardService = new BoardService(
    config,
    createProductionMutationLock(config, env, "board"),
    livenessProbe,
    () => new Date(),
    boardJournal,
    {},
    sensitiveData,
  );
  let catalog!: Catalog;
  const contractAuthority = new ControlContractAuthority({
    getRepository: (repoId) => catalog.getRepository(repoId),
    getTask: (taskId) => catalog.getTask(taskId),
    boardStatus: (boardId) => boardService.status(boardId),
  });
  catalog = new Catalog(config, registry, sensitiveData, contractAuthority);
  const githubProject = new GitHubProjectClient({
    githubOwner: config.githubOwner,
    projectNumber: config.projectNumber,
    preflightProjectItemId: config.preflightProjectItemId,
    runner,
    catalog,
    sensitiveData,
    registrationHints: new RegistrationHintStore(config.stateDir),
    // First one wins. Both report sites run the same classifier, so they
    // disagree only if the underlying failure changes between the read and the
    // write; this keeps that case from letting the second reason overwrite the
    // first rather than deciding which is worth more.
    onRegistrationRecordUnavailable: (code) => {
      registrationRecordWarning.code ??= code;
    },
  });
  const source = new GitHubSourceService({ runner, catalog, projects: githubProject, sensitiveData });
  const records = new RegistryRecordStore(config.registryDir, registry, sensitiveData);
  const readCommittedAuthority = async () => {
    try {
      await records.assertCommittedRegularFile("governance/authority.yaml");
      const parsed = AuthorityRecordSchema.safeParse(JSON.parse(await registry.readHeadRegularFile("governance/authority.yaml")));
      if (!parsed.success) throw new Error("invalid authority");
      return parsed.data;
    } catch {
      throw new ControlError("AUTHORITY_UNAVAILABLE", "Committed Registry authority policy is unavailable");
    }
  };
  const preflightAuthority = {
    async observeCommittedLegacy() {
      const central = await readCommittedAuthority();
      const authority = createAuthorityService({
        readCentral: async () => central,
        cachePath: join(config.stateDir, "authority-cache.json"),
        writesDisabled: env.JHW_NOTION_WRITES_DISABLED === "true",
      });
      const decision = await authority.load();
      assertPhase1ACommittedLegacy(central, decision);
    },
  };
  const notionProbe = {
    async verifyReadOnlyRoutes() {
      await verifyConfiguredNotionAuthorityRoutes(getNotionClient());
    },
  };
  const worktrees = new WorktreeManager(config, runner);
  const claims = new ClaimService(config, registry, catalog, {
    async inspect(claim) {
      try {
        const inspection = await worktrees.inspect(claim);
        return {
          // Phase 1A has no PID registry; process liveness is intentionally
          // unavailable rather than inferred from a session label.
          process_exists: false,
          worktree_mapped: true,
          dirty: inspection.dirty,
          ahead: inspection.ahead,
        };
      } catch (cause) {
        if (cause instanceof ControlError && new Set([
          "HOST_MISMATCH",
          "WORKTREE_NOT_MAPPED",
          "WORKTREE_CREATE_PENDING",
          "WORKTREE_REMOVE_PENDING",
          "WORKTREE_REMOVED",
        ]).has(cause.code)) {
          return { process_exists: false, worktree_mapped: false, dirty: false, ahead: 0 };
        }
        throw cause;
      }
    },
  }, () => new Date(), sensitiveData);
  return {
    stateDir: config.stateDir,
    env,
    taskService: new TaskService(config, claims, worktrees, registry, () => new Date(), sensitiveData),
    claimService: claims,
    catalog,
    source,
    portfolio: new PortfolioService({ projectClient: githubProject, repositories: catalog, stateDir: config.stateDir, sensitiveData }),
    preflight: new PreflightService({
      config,
      environment: env,
      runner,
      project: githubProject,
      authority: preflightAuthority,
      notion: notionProbe,
      repository: source,
      registry,
      sensitiveData,
    }),
    guardMode: config.guardMode,
    guardRequests: createProductionGuardRequestStore(config, env),
    guardDigestKey: new GuardDigestKey(config.stateDir),
    guardClaims: claims,
    codexRepositoryRoot: codexRepositoryRoot(),
    codexHookRuntime: createCodexHookRuntime(env),
    claudeHookRuntime: createClaudeHookRuntime(env),
    mutationLock: createProductionMutationLock(config, env),
    // The board lock is a second host-global lock with its own identity: board
    // commands must never contend with registry.lock, and boards.lock waits
    // briefly instead of failing fast because its critical sections are ms-long.
    boardService,
    boardJournal,
    livenessProbe,
    registrationRecordWarning,
  };
}

function usage(message: string): never {
  throw new ControlError("INVALID_CLI_ARGUMENT", message);
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function commandFor(argv: readonly string[]): CommandName {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return "help";
  if (argv[0] === "task" && argv[1] && commandNames.includes(`task ${argv[1]}` as (typeof commandNames)[number])) {
    return `task ${argv[1]}` as CommandName;
  }
  if (argv[0] === "portfolio" && argv[1] && commandNames.includes(`portfolio ${argv[1]}` as (typeof commandNames)[number])) {
    return `portfolio ${argv[1]}` as CommandName;
  }
  if (argv[0] === "board" && argv[1] && commandNames.includes(`board ${argv[1]}` as (typeof commandNames)[number])) {
    return `board ${argv[1]}` as CommandName;
  }
  if (argv[0] === "guard" && argv[1] && commandNames.includes(`guard ${argv[1]}` as (typeof commandNames)[number])) {
    return `guard ${argv[1]}` as CommandName;
  }
  if (argv[0] === "project" && argv[1] === "register") return "project register";
  if (argv[0] === "project" && argv[1] === "update") return "project update";
  if (argv[0] === "repository" && argv[1] === "register") return "repository register";
  if (argv.length === 1 && argv[0] === "preflight") return "preflight";
  return "invalid";
}

function parseFlags(values: readonly string[], allowed: ReadonlySet<string>, repeated = new Set<string>()): ParsedFlags {
  const flags = new Map<string, FlagValue>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !allowed.has(flag) || value === undefined || value.startsWith("--")) {
      usage("Invalid command arguments");
    }
    if (flags.has(flag) && !repeated.has(flag)) usage("Duplicate command flag");
    if (repeated.has(flag)) {
      const current = flags.get(flag);
      flags.set(flag, current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value]);
    } else {
      flags.set(flag, value);
    }
  }
  return flags;
}

function value(flags: ParsedFlags, flag: string): string | undefined {
  const result = flags.get(flag);
  return typeof result === "string" ? result : undefined;
}

function values(flags: ParsedFlags, flag: string): string[] {
  const result = flags.get(flag);
  return result === undefined ? [] : Array.isArray(result) ? result : [result];
}

/** Rejects content flags while treating the checkout path only as a protected term. */
function assertSafeFlags(flags: ParsedFlags, dependencies: CliDependencies): void {
  const checkout = value(flags, "--repo-path");
  const policy = createSensitiveDataPolicy(dependencies.env, [
    dependencies.stateDir,
    ...(checkout && isAbsolute(checkout) ? [checkout] : []),
  ]);
  policy.assertSafe(Object.fromEntries([...flags].filter(([name]) => name !== "--repo-path")));
}

function required(flags: ParsedFlags, flag: string): string {
  const result = value(flags, flag);
  if (!isNonEmpty(result)) usage("Missing required command argument");
  return result;
}

function assertPattern(raw: string, pattern: RegExp): string {
  if (!pattern.test(raw)) usage("Invalid command identifier");
  return raw;
}

function assertPositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) usage("Invalid active-work-minutes");
  return parsed;
}

function requireTaskId(flags: ParsedFlags, flag = "--task"): string {
  return assertPattern(required(flags, flag), TASK_ID);
}

function requireClaimId(flags: ParsedFlags, flag = "--claim"): string {
  return assertPattern(required(flags, flag), CLAIM_ID);
}

function requireClaimCoordinate(flags: ParsedFlags, flag: string): string {
  const parsed = ClaimCoordinateSchema.safeParse(required(flags, flag));
  if (!parsed.success) usage("Invalid Claim coordinate");
  return parsed.data;
}

function requireOriginAdapter(flags: ParsedFlags): GuardAdapter {
  const parsed = GuardAdapterSchema.safeParse(required(flags, "--origin-adapter"));
  if (!parsed.success) usage("Invalid origin adapter");
  return parsed.data;
}

function activeSummary(active: ActiveClaim): Record<string, unknown> {
  return {
    task_id: active.task_id,
    claim_id: active.claim_id,
    project_id: active.project_id,
    repo_id: active.repo_id,
    host: active.host,
    branch: active.branch,
    worktree_ref: active.worktree_ref,
    started_at: active.started_at,
  };
}

function currentTaskSummaryProjection(task: CurrentTaskSummary): Record<string, unknown> {
  if (task.kind === "formal") {
    return {
      task_id: task.task_id,
      kind: "formal",
      issue_url: task.issue_url,
      ...(task.task_role === undefined ? {} : { task_role: task.task_role }),
    };
  }
  if (task.kind === "temporary") {
    return { task_id: task.task_id, kind: "temporary", lifecycle: task.lifecycle };
  }
  return {
    task_id: task.task_id,
    kind: "child",
    lifecycle: task.lifecycle,
    parent_task_id: task.parent_task_id,
  };
}

/** Explicit public projection: checkout paths and session coordinates never escape status. */
function currentTaskStatusProjection(status: CurrentTaskContextResult): Record<string, unknown> {
  if (status.match === "none") {
    return {
      kind: "resolved",
      project_id: status.project_id,
      repo_id: status.repo_id,
      match: "none",
    };
  }
  if (status.match === "ambiguous") {
    return {
      kind: "resolved",
      project_id: status.project_id,
      repo_id: status.repo_id,
      match: "ambiguous",
      candidate_count: status.candidate_count,
    };
  }
  return {
    kind: "resolved",
    project_id: status.project_id,
    repo_id: status.repo_id,
    match: "unique",
    task: currentTaskSummaryProjection(status.task),
    claim: {
      task_id: status.claim.task_id,
      claim_id: status.claim.claim_id,
      host: status.claim.host,
      branch: status.claim.branch,
      worktree_ref: status.claim.worktree_ref,
      started_at: status.claim.started_at,
    },
    relation: {
      session_match: status.relation.session_match,
      worktree_match: status.relation.worktree_match,
      owner: status.relation.owner,
    },
  };
}

function taskSummary(task: TaskRecord): Record<string, unknown> {
  return {
    task_id: task.id,
    kind: task.kind,
    project_id: task.project_id,
    repo_id: task.repo_id,
    ...(task.kind === "child" ? {
      parent_task_id: task.parent_task_id,
      required_for_parent: task.required_for_parent,
    } : {
      task_role: task.task_role,
    }),
  };
}

function resultJson(command: CommandName, result: unknown): CliResult {
  return { exitCode: 0, stdout: `${JSON.stringify({ command, result })}\n`, stderr: "" };
}

type CliHandoff = Awaited<ReturnType<CliDependencies["taskService"]["handoff"]>>;
type BoundedCliHandoff = Omit<CliHandoff, "sections"> & {
  sections: Record<string, string>;
  truncated: boolean;
};

function scaledSection(value: string, scale: number): string {
  const characters = Array.from(value);
  const retained = Math.floor(characters.length * scale / MAX_CLI_OUTPUT_BYTES);
  if (retained >= characters.length) return value;
  return `${characters.slice(0, retained).join("")}\u2026`;
}

function boundedHandoffResult(
  command: CommandName,
  handoff: CliHandoff,
  payload: (summary: BoundedCliHandoff) => unknown,
): CliResult {
  const entries = Object.entries(handoff.sections);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new ControlError("INVALID_HANDOFF_RESULT", "Handoff service returned invalid section content");
  }
  const render = (sections: Record<string, string>, truncated: boolean) => resultJson(command, payload({
    ...handoff,
    sections,
    truncated,
  }));
  const fullSections = Object.fromEntries(entries);
  const full = render(fullSections, false);
  if (Buffer.byteLength(full.stdout, "utf8") <= CLI_RESULT_BUDGET) return full;

  let low = 0;
  let high = MAX_CLI_OUTPUT_BYTES;
  let best: CliResult | undefined;
  while (low <= high) {
    const scale = Math.floor((low + high) / 2);
    const sections = Object.fromEntries(entries.map(([name, value]) => [name, scaledSection(value, scale)]));
    const candidate = render(sections, true);
    if (Buffer.byteLength(candidate.stdout, "utf8") <= CLI_RESULT_BUDGET) {
      best = candidate;
      low = scale + 1;
    } else {
      high = scale - 1;
    }
  }
  if (!best) throw new ControlError("HANDOFF_PAYLOAD_TOO_LARGE", "Handoff metadata exceeds the CLI output boundary");
  return best;
}

function boardSummaryId(summary: Record<string, unknown>): string {
  const boardId = summary.board_id;
  if (typeof boardId !== "string" || !BOARD_ID.test(boardId)) {
    throw new ControlError("BOARD_STATE_CORRUPT", "Board summary has an invalid identifier");
  }
  return boardId;
}

/**
 * Pages compact all-board views by their actual serialized envelope size.
 * A deleted cursor still resumes at the next lexicographic board id.
 */
function boundedBoardCollectionResult(
  command: CommandName,
  collection: { boards: Array<Record<string, unknown>> },
  after?: string,
): CliResult {
  const allBoards = [...collection.boards].sort((left, right) => {
    const leftId = boardSummaryId(left);
    const rightId = boardSummaryId(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const remaining = after === undefined
    ? allBoards
    : allBoards.filter((board) => boardSummaryId(board) > after);
  let selected: Array<Record<string, unknown>> = [];

  const render = (boards: Array<Record<string, unknown>>, truncated: boolean): CliResult => resultJson(command, {
    boards,
    total_boards: allBoards.length,
    truncated,
    ...(truncated ? { next_after: boardSummaryId(boards[boards.length - 1] as Record<string, unknown>) } : {}),
  });

  for (let index = 0; index < remaining.length; index += 1) {
    const candidateBoards = [...selected, remaining[index] as Record<string, unknown>];
    const candidate = render(candidateBoards, index + 1 < remaining.length);
    if (Buffer.byteLength(candidate.stdout, "utf8") > CLI_RESULT_BUDGET) break;
    selected = candidateBoards;
  }

  if (selected.length === 0 && remaining.length > 0) {
    throw new ControlError("CLI_OUTPUT_TOO_LARGE", "One board summary exceeded the bounded output envelope");
  }
  return render(selected, selected.length < remaining.length);
}

function validatedPortResult<T>(schema: ZodType<T>, raw: unknown, code: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ControlError(code, "A control port returned an invalid result");
  return parsed.data;
}

const codexHookEvents = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"] as const;
const codexRuntimeEventNames = {
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  SessionEnd: "sessionEnd",
} as const;
const maximumCodexHooksBytes = 128 * 1024;
const maximumCodexRuntimeEntries = 256;
const maximumCodexProbeBytes = 12 * 1024;
const maximumClaudeProbeLines = 64;
const claudeProbeStopMarker = "jhw-claude-preflight-stop";

const CodexHookMetadataCommonSchema = z.object({
  eventName: z.string().min(1).max(255),
  matcher: z.string().max(4_096).nullable(),
  timeoutSec: z.number().int().nonnegative().max(86_400),
  source: z.string().min(1).max(255),
  sourcePath: z.string().min(1).max(4_096),
  isManaged: z.boolean(),
  enabled: z.boolean(),
  trustStatus: z.enum(["managed", "untrusted", "trusted", "modified"]),
  currentHash: z.string().min(1).max(4_096),
  displayOrder: z.number().int().nonnegative().max(1_000_000),
}).passthrough();
const CodexHookMetadataSchema = z.discriminatedUnion("handlerType", [
  CodexHookMetadataCommonSchema.extend({
    handlerType: z.literal("command"),
    async: z.boolean(),
    command: z.string().min(1).max(4_096),
  }),
  CodexHookMetadataCommonSchema.extend({
    handlerType: z.literal("mcpTool"),
    server: z.string().min(1).max(4_096),
    tool: z.string().min(1).max(4_096),
  }),
]);
const CodexHookMetadataListSchema = z.array(CodexHookMetadataSchema).max(maximumCodexRuntimeEntries);
const CodexHooksListResultSchema = z.object({
  data: z.array(z.object({
    cwd: z.string().min(1).max(4_096),
    hooks: z.array(CodexHookMetadataSchema).max(maximumCodexRuntimeEntries),
    errors: z.array(z.unknown()).max(0),
    warnings: z.array(z.unknown()).max(maximumCodexRuntimeEntries),
  }).passthrough()).length(1),
}).passthrough();
const CodexHookProbeResultSchema = z.object({
  exitCode: z.number().int().nonnegative().max(255).nullable(),
  signal: z.string().min(1).max(64).nullable(),
  stdout: z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.byteLength <= maximumCodexProbeBytes),
  stderr: z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.byteLength <= maximumCodexProbeBytes),
}).strict();

function codexRepositoryRoot(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function expectedHookCommand(
  adapter: "claude" | "codex",
  eventName: typeof codexHookEvents[number],
): string {
  return `"$HOME/.local/bin/jhw-control-hook" --adapter ${adapter} --event ${eventName}`;
}

function expectedCodexHookCommand(eventName: typeof codexHookEvents[number]): string {
  return expectedHookCommand("codex", eventName);
}

function expectedCodexHookTimeout(eventName: typeof codexHookEvents[number]): number {
  return eventName === "SessionEnd" ? 3 : 12;
}

function isExactHookGroup(
  value: unknown,
  adapter: "claude" | "codex",
  eventName: typeof codexHookEvents[number],
): boolean {
  if (!exactObjectKeys(value, ["hooks"]) || !Array.isArray(value.hooks) || value.hooks.length !== 1) return false;
  const handler = value.hooks[0];
  return exactObjectKeys(handler, ["type", "command", "timeout"]) &&
    handler.type === "command" && handler.command === expectedHookCommand(adapter, eventName) &&
    handler.timeout === expectedCodexHookTimeout(eventName);
}

async function readBoundedNoFollowRegularFile(file: string, maximumBytes: number): Promise<Buffer | undefined> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) return undefined;
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) return undefined;
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function topLevelJsonKeyCount(text: string, expectedKey: string): number {
  let depth = 0;
  let stringStart = -1;
  let escaped = false;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (stringStart >= 0) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        if (depth === 1) {
          let next = index + 1;
          while (next < text.length && /\s/u.test(text[next] as string)) next += 1;
          if (text[next] === ":") {
            const key = JSON.parse(text.slice(stringStart, index + 1)) as unknown;
            if (key === expectedKey) count += 1;
          }
        }
        stringStart = -1;
      }
      continue;
    }
    if (character === '"') {
      stringStart = index;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return count;
}

function nodeErrorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause &&
    typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : undefined;
}

async function openDescriptorChild(directory: FileHandle, name: string, flags: number): Promise<FileHandle> {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid descriptor-relative path component");
  }
  let lastCause: unknown;
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return await open(`${root}/${directory.fd}/${name}`, flags);
    } catch (cause) {
      lastCause = cause;
    }
  }
  throw lastCause;
}

async function openAbsoluteDirectoryChain(directoryPath: string): Promise<FileHandle[]> {
  if (!isAbsolute(directoryPath) || resolvePath(directoryPath) !== directoryPath) {
    throw new Error("Claude discovery cwd is not an absolute normalized path");
  }
  const root = parse(directoryPath).root;
  const handles: FileHandle[] = [];
  try {
    const rootHandle = await open(
      root,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    handles.push(rootHandle);
    for (const component of directoryPath.slice(root.length).split(sep).filter(Boolean)) {
      const next = await openDescriptorChild(
        handles[handles.length - 1] as FileHandle,
        component,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const info = await next.stat({ bigint: true });
      if (!info.isDirectory()) {
        await next.close();
        throw new Error("Claude discovery ancestor is not a directory");
      }
      handles.push(next);
    }
    return handles;
  } catch (cause) {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw cause;
  }
}

type TrustedDirectoryChain = {
  handles: FileHandle[];
  observations: BigIntStats[];
};

const maximumTrustedHookArtifactBytes = 8 * 1024 * 1024;

function sameStableFsObject(before: BigIntStats, after: BigIntStats): boolean {
  return after.dev === before.dev
    && after.ino === before.ino
    && after.uid === before.uid
    && after.gid === before.gid
    && after.mode === before.mode
    && after.nlink === before.nlink
    && after.size === before.size
    && after.mtimeNs === before.mtimeNs
    && after.ctimeNs === before.ctimeNs;
}

function sameStableDirectory(before: BigIntStats, after: BigIntStats): boolean {
  return after.dev === before.dev
    && after.ino === before.ino
    && after.uid === before.uid
    && after.gid === before.gid
    && after.mode === before.mode;
}

function isTrustedArtifactDirectory(info: BigIntStats, currentUid: bigint): boolean {
  const stickyRootDirectory = info.uid === 0n && (info.mode & 0o1000n) !== 0n;
  return info.isDirectory()
    && (info.uid === currentUid || info.uid === 0n)
    && ((info.mode & 0o022n) === 0n || stickyRootDirectory);
}

async function closeDirectoryChain(chain: TrustedDirectoryChain | undefined): Promise<void> {
  if (!chain) return;
  for (const handle of chain.handles.reverse()) await handle.close().catch(() => undefined);
}

async function openTrustedArtifactDirectoryChain(
  directoryPath: string,
  currentUid: bigint,
): Promise<TrustedDirectoryChain> {
  const handles = await openAbsoluteDirectoryChain(directoryPath);
  try {
    const observations: BigIntStats[] = [];
    for (const handle of handles) {
      const info = await handle.stat({ bigint: true });
      if (!isTrustedArtifactDirectory(info, currentUid)) {
        throw new Error("Unsafe executable artifact directory");
      }
      observations.push(info);
    }
    return { handles, observations };
  } catch (cause) {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw cause;
  }
}

async function trustedArtifactDirectoryChainRemainsStable(
  directoryPath: string,
  chain: TrustedDirectoryChain,
  currentUid: bigint,
): Promise<boolean> {
  for (let index = 0; index < chain.handles.length; index += 1) {
    const current = await (chain.handles[index] as FileHandle).stat({ bigint: true });
    if (!sameStableDirectory(chain.observations[index] as BigIntStats, current)) return false;
  }
  let reopened: TrustedDirectoryChain | undefined;
  try {
    reopened = await openTrustedArtifactDirectoryChain(directoryPath, currentUid);
    return reopened.observations.length === chain.observations.length
      && reopened.observations.every((current, index) =>
        sameStableDirectory(chain.observations[index] as BigIntStats, current));
  } catch {
    return false;
  } finally {
    await closeDirectoryChain(reopened);
  }
}

async function descriptorChildOperation<T>(
  directory: FileHandle,
  name: string,
  operation: (path: string) => Promise<T>,
): Promise<T> {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid descriptor-relative path component");
  }
  let lastCause: unknown;
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return await operation(`${root}/${directory.fd}/${name}`);
    } catch (cause) {
      lastCause = cause;
    }
  }
  throw lastCause;
}

async function lstatDescriptorChild(directory: FileHandle, name: string): Promise<BigIntStats> {
  return descriptorChildOperation(directory, name, (path) => lstat(path, { bigint: true }));
}

async function readlinkDescriptorChild(directory: FileHandle, name: string): Promise<string> {
  return descriptorChildOperation(directory, name, (path) => readlink(path));
}

async function inspectTrustedExecutableArtifact(file: string, currentUid: bigint): Promise<boolean> {
  const parentPath = dirname(file);
  const name = basename(file);
  let chain: TrustedDirectoryChain | undefined;
  let handle: FileHandle | undefined;
  let currentHandle: FileHandle | undefined;
  try {
    chain = await openTrustedArtifactDirectoryChain(parentPath, currentUid);
    const parent = chain.handles[chain.handles.length - 1] as FileHandle;
    handle = await openDescriptorChild(
      parent,
      name,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.uid !== currentUid
      || before.nlink !== 1n
      || (before.mode & 0o022n) !== 0n
      || (before.mode & 0o111n) === 0n
      || before.size > BigInt(maximumTrustedHookArtifactBytes)
    ) return false;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumTrustedHookArtifactBytes) return false;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(total) !== before.size || !sameStableFsObject(before, after)) return false;
    currentHandle = await openDescriptorChild(
      parent,
      name,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const current = await currentHandle.stat({ bigint: true });
    if (!current.isFile() || !sameStableFsObject(after, current)) return false;
    return await trustedArtifactDirectoryChainRemainsStable(parentPath, chain, currentUid);
  } catch {
    return false;
  } finally {
    await currentHandle?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await closeDirectoryChain(chain);
  }
}

async function inspectTrustedLauncherSymlink(
  launcherPath: string,
  expectedTarget: string,
  currentUid: bigint,
): Promise<boolean> {
  const parentPath = dirname(launcherPath);
  const name = basename(launcherPath);
  let chain: TrustedDirectoryChain | undefined;
  try {
    chain = await openTrustedArtifactDirectoryChain(parentPath, currentUid);
    const parent = chain.handles[chain.handles.length - 1] as FileHandle;
    const before = await lstatDescriptorChild(parent, name);
    if (!before.isSymbolicLink() || before.uid !== currentUid || before.nlink !== 1n) return false;
    const target = await readlinkDescriptorChild(parent, name);
    const after = await lstatDescriptorChild(parent, name);
    if (target !== expectedTarget || !sameStableFsObject(before, after)) return false;
    return await trustedArtifactDirectoryChainRemainsStable(parentPath, chain, currentUid);
  } catch {
    return false;
  } finally {
    await closeDirectoryChain(chain);
  }
}

async function inspectTrustedClaudeExecutableArtifacts(
  home: string,
  repositoryRoot: string,
): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const currentUid = BigInt(uid);
  const launcherPath = join(home, ".local", "bin", "jhw-control-hook");
  const expectedLauncher = join(repositoryRoot, "scripts", "jhw-control-hook");
  const corePath = join(repositoryRoot, "mcp-server", "dist", "control", "hook-adapter.js");
  return await inspectTrustedLauncherSymlink(launcherPath, expectedLauncher, currentUid)
    && await inspectTrustedExecutableArtifact(expectedLauncher, currentUid)
    && await inspectTrustedExecutableArtifact(corePath, currentUid);
}

type ClaudeSettingsObservation =
  | { state: "absent" }
  | { state: "unsafe" }
  | { state: "present"; disablesHooks: boolean; text: string };

async function inspectClaudeSettingsFile(
  directory: FileHandle,
  name: "settings.json" | "settings.local.json",
  currentUid: bigint,
): Promise<ClaudeSettingsObservation> {
  let handle: FileHandle;
  try {
    handle = await openDescriptorChild(
      directory,
      name,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (cause) {
    return nodeErrorCode(cause) === "ENOENT" ? { state: "absent" } : { state: "unsafe" };
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.uid !== currentUid
      || before.nlink !== 1n
      || (before.mode & 0o022n) !== 0n
      || before.size > BigInt(maximumCodexHooksBytes)
    ) return { state: "unsafe" };
    const buffer = Buffer.alloc(maximumCodexHooksBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset > maximumCodexHooksBytes
      || BigInt(offset) !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.uid !== before.uid
      || after.mode !== before.mode
      || after.nlink !== before.nlink
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) return { state: "unsafe" };
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(buffer.subarray(0, offset));
    const document: unknown = JSON.parse(text);
    if (!document || typeof document !== "object" || Array.isArray(document)) return { state: "unsafe" };
    const disableKeyCount = topLevelJsonKeyCount(text, "disableAllHooks");
    if (disableKeyCount > 1) return { state: "unsafe" };
    const settings = document as Record<string, unknown>;
    return {
      state: "present",
      disablesHooks: disableKeyCount === 1 && settings.disableAllHooks !== false,
      text,
    };
  } catch {
    return { state: "unsafe" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTrustedClaudeGlobalSettings(home: string): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  let ancestors: FileHandle[] = [];
  let claudeDirectory: FileHandle | undefined;
  try {
    ancestors = await openAbsoluteDirectoryChain(home);
    claudeDirectory = await openDescriptorChild(
      ancestors[ancestors.length - 1] as FileHandle,
      ".claude",
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const before = await claudeDirectory.stat({ bigint: true });
    if (
      !before.isDirectory()
      || before.uid !== BigInt(uid)
      || (before.mode & 0o022n) !== 0n
    ) return undefined;
    const observation = await inspectClaudeSettingsFile(claudeDirectory, "settings.json", BigInt(uid));
    const after = await claudeDirectory.stat({ bigint: true });
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.uid !== before.uid
      || after.mode !== before.mode
      || after.nlink !== before.nlink
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) return undefined;
    return observation.state === "present" ? observation.text : undefined;
  } catch {
    return undefined;
  } finally {
    await claudeDirectory?.close().catch(() => undefined);
    for (const ancestor of ancestors.reverse()) await ancestor.close().catch(() => undefined);
  }
}

async function claudeSettingsHierarchyAllowsHooks(cwd: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  let ancestors: FileHandle[] = [];
  try {
    ancestors = await openAbsoluteDirectoryChain(cwd);
    for (const ancestor of [...ancestors].reverse()) {
      let claudeDirectory: FileHandle;
      try {
        claudeDirectory = await openDescriptorChild(
          ancestor,
          ".claude",
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
      } catch (cause) {
        if (nodeErrorCode(cause) === "ENOENT") continue;
        return false;
      }
      try {
        const info = await claudeDirectory.stat({ bigint: true });
        if (!info.isDirectory() || info.uid !== BigInt(uid) || (info.mode & 0o022n) !== 0n) return false;
        for (const name of ["settings.json", "settings.local.json"] as const) {
          const observation = await inspectClaudeSettingsFile(claudeDirectory, name, BigInt(uid));
          if (observation.state === "unsafe" || observation.state === "present" && observation.disablesHooks) {
            return false;
          }
        }
      } finally {
        await claudeDirectory.close().catch(() => undefined);
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    for (const ancestor of ancestors.reverse()) await ancestor.close().catch(() => undefined);
  }
}

type ExactHookInstallationEvidence = {
  probeCommand: string;
};

async function inspectExactHookInstallation(
  home: string,
  repositoryRoot: string,
  adapter: "claude" | "codex",
): Promise<ExactHookInstallationEvidence | undefined> {
  if (!isAbsolute(home) || !isAbsolute(repositoryRoot)) return undefined;
  const launcherPath = join(home, ".local", "bin", "jhw-control-hook");
  const expectedLauncher = join(repositoryRoot, "scripts", "jhw-control-hook");
  const corePath = join(repositoryRoot, "mcp-server", "dist", "control", "hook-adapter.js");
  const hooksPath = adapter === "claude"
    ? join(home, ".claude", "settings.json")
    : join(home, ".codex", "hooks.json");
  try {
    if (adapter === "claude") {
      if (!await inspectTrustedClaudeExecutableArtifacts(home, repositoryRoot)) return undefined;
    } else {
      const launcherInfo = await lstat(launcherPath);
      if (!launcherInfo.isSymbolicLink() || await readlink(launcherPath) !== expectedLauncher) return undefined;
      const resolvedLauncherInfo = await stat(launcherPath);
      if (!resolvedLauncherInfo.isFile() || (resolvedLauncherInfo.mode & 0o111) === 0) return undefined;
      const coreInfo = await lstat(corePath);
      if (!coreInfo.isFile() || coreInfo.isSymbolicLink() || (coreInfo.mode & 0o111) === 0) return undefined;
    }
    let settingsText: string | undefined;
    if (adapter === "claude") {
      settingsText = await readTrustedClaudeGlobalSettings(home);
    } else {
      const bytes = await readBoundedNoFollowRegularFile(hooksPath, maximumCodexHooksBytes);
      if (bytes) settingsText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    if (settingsText === undefined) return undefined;
    const document: unknown = JSON.parse(settingsText);
    if (!document || typeof document !== "object" || Array.isArray(document)) return undefined;
    const settings = document as Record<string, unknown>;
    if (adapter === "claude") {
      const disableKeyCount = topLevelJsonKeyCount(settingsText, "disableAllHooks");
      if (disableKeyCount > 1 || disableKeyCount === 1 && settings.disableAllHooks !== false) return undefined;
    }
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
    const exact = codexHookEvents.every((eventName) => {
      const groups = (hooks as Record<string, unknown>)[eventName];
      return Array.isArray(groups) && groups.length > 0 && isExactHookGroup(groups[0], adapter, eventName) &&
        groups.filter((group) => isExactHookGroup(group, adapter, eventName)).length === 1;
    });
    if (!exact) return undefined;
    const preToolGroups = (hooks as Record<string, unknown>).PreToolUse as Array<{ hooks: Array<{ command: string }> }>;
    return { probeCommand: preToolGroups[0]?.hooks[0]?.command as string };
  } catch {
    return undefined;
  }
}

async function inspectExactCodexInstallation(
  home: string,
  repositoryRoot: string = codexRepositoryRoot(),
): Promise<ExactHookInstallationEvidence | undefined> {
  return inspectExactHookInstallation(home, repositoryRoot, "codex");
}

async function inspectExactClaudeInstallation(
  home: string,
  repositoryRoot: string = codexRepositoryRoot(),
): Promise<ExactHookInstallationEvidence | undefined> {
  return inspectExactHookInstallation(home, repositoryRoot, "claude");
}

function isExactTrustedCodexRuntimeEntry(
  entry: z.infer<typeof CodexHookMetadataSchema>,
  home: string,
  eventName: typeof codexHookEvents[number],
): boolean {
  return entry.eventName === codexRuntimeEventNames[eventName] &&
    entry.handlerType === "command" &&
    entry.async === false &&
    entry.command === expectedCodexHookCommand(eventName) &&
    entry.matcher === null &&
    entry.timeoutSec === expectedCodexHookTimeout(eventName) &&
    entry.source === "user" &&
    entry.sourcePath === join(home, ".codex", "hooks.json") &&
    entry.isManaged === false &&
    entry.enabled === true &&
    entry.trustStatus === "trusted" &&
    entry.currentHash.length > 0 && entry.currentHash.length <= 4_096;
}

function hasEffectiveTrustedCodexRuntime(
  raw: unknown,
  home: string,
): boolean {
  const parsed = CodexHookMetadataListSchema.safeParse(raw);
  if (!parsed.success) return false;
  return codexHookEvents.every((eventName) => {
    const handlers = parsed.data.filter((entry) =>
      entry.eventName === codexRuntimeEventNames[eventName]);
    const exact = handlers.filter((entry) => isExactTrustedCodexRuntimeEntry(entry, home, eventName));
    if (exact.length !== 1) return false;
    return !handlers.some((entry) => entry !== exact[0] &&
      entry.enabled &&
      (entry.handlerType === "mcpTool" || entry.async === false) &&
      (entry.isManaged || entry.trustStatus === "managed" || entry.trustStatus === "trusted"));
  });
}

function hasExactCodexHookProbe(raw: unknown): boolean {
  const parsed = CodexHookProbeResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.exitCode !== 0 || parsed.data.signal !== null || parsed.data.stderr.byteLength !== 0) {
    return false;
  }
  const expectedValue = renderStaticHookFailure("PreToolUse", "GUARD_PROTOCOL_MISMATCH");
  const expected = Buffer.from(`${JSON.stringify(expectedValue)}\n`, "utf8");
  const stdout = Buffer.from(parsed.data.stdout);
  if (!stdout.equals(expected)) return false;
  try {
    return NativeHookOutputSchema.safeParse(JSON.parse(stdout.toString("utf8"))).success;
  } catch {
    return false;
  }
}

function hasExactClaudePromptProbe(raw: unknown): boolean {
  const parsed = CodexHookProbeResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.exitCode !== 0 || parsed.data.signal !== null || parsed.data.stderr.byteLength !== 0) {
    return false;
  }
  let lines: unknown[];
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(parsed.data.stdout);
    if (!text.endsWith("\n")) return false;
    const rawLines = text.slice(0, -1).split("\n");
    if (rawLines.length === 0 || rawLines.length > maximumClaudeProbeLines || rawLines.some((line) => !line)) {
      return false;
    }
    lines = rawLines.map((line) => JSON.parse(line));
  } catch {
    return false;
  }
  const objects = lines.filter((line): line is Record<string, unknown> =>
    typeof line === "object" && line !== null && !Array.isArray(line));
  if (objects.length !== lines.length) return false;
  const responses = objects.filter((line) =>
    line.type === "system" && line.subtype === "hook_response" &&
    line.hook_name === "UserPromptSubmit" && line.hook_event === "UserPromptSubmit");
  if (responses.length !== 2) return false;
  const stopLine = `${claudeProbeStopMarker}\n`;
  const blocking = responses.filter((line) =>
    line.output === stopLine && line.stdout === "" &&
    line.stderr === stopLine && line.exit_code === 2 && line.outcome === "error");
  const owned = responses.filter((line) => {
    if (
      typeof line.stdout !== "string" || line.output !== line.stdout || line.stderr !== "" ||
      line.exit_code !== 0 || line.outcome !== "success"
    ) return false;
    if (!line.stdout.endsWith("\n")) return false;
    const nativeLine = line.stdout.slice(0, -1);
    if (!nativeLine || nativeLine.includes("\n") || nativeLine.includes("\r")) return false;
    try {
      const native = NativeHookOutputSchema.safeParse(JSON.parse(nativeLine));
      return native.success && "hookSpecificOutput" in native.data &&
        native.data.hookSpecificOutput.hookEventName === "UserPromptSubmit";
    } catch {
      return false;
    }
  });
  if (blocking.length !== 1 || owned.length !== 1) return false;
  const blockingId = blocking[0]?.hook_id;
  const ownedId = owned[0]?.hook_id;
  if (
    typeof blockingId !== "string" || blockingId.length === 0 || blockingId.length > 255 ||
    typeof ownedId !== "string" || ownedId.length === 0 || ownedId.length > 255 ||
    blockingId === ownedId
  ) return false;
  const results = objects.filter((line) => line.type === "result");
  if (results.length !== 1) return false;
  const result = results[0];
  return result?.subtype === "success" && result.is_error === false &&
    result.duration_api_ms === 0 && result.num_turns === 0 && result.total_cost_usd === 0 &&
    exactObjectKeys(result.modelUsage, []);
}

async function inspectAdapterCoverage(
  dependencies: CliDependencies,
): Promise<z.infer<typeof GuardAdapterCoverageSchema>> {
  const repositoryRoot = dependencies.codexRepositoryRoot ?? codexRepositoryRoot();
  const installation = dependencies.env.HOME !== undefined &&
    adapterContractResults.codex.fixture_axes.prompt_origin &&
    adapterContractResults.codex.fixture_axes.pre_tool_block &&
    adapterContractResults.codex.fixture_axes.post_tool_correlation &&
    adapterContractResults.codex.fixture_axes.session_end_evidence &&
    await inspectExactCodexInstallation(
      dependencies.env.HOME,
      repositoryRoot,
    );
  const installed = installation !== false && installation !== undefined;
  const home = dependencies.env.HOME;
  const claudeConfigOverride = dependencies.env.CLAUDE_CONFIG_DIR?.trim();
  const standardClaudeConfig = home !== undefined && (
    !claudeConfigOverride ||
    isAbsolute(claudeConfigOverride) && resolvePath(claudeConfigOverride) === join(home, ".claude")
  );
  const claudeInstallation = home !== undefined && standardClaudeConfig &&
    adapterContractResults.claude.fixture_axes.prompt_origin &&
    adapterContractResults.claude.fixture_axes.pre_tool_block &&
    adapterContractResults.claude.fixture_axes.post_tool_correlation &&
    adapterContractResults.claude.fixture_axes.session_end_evidence &&
    await inspectExactClaudeInstallation(home, repositoryRoot);
  const claudeInstalled = claudeInstallation !== false && claudeInstallation !== undefined;
  let claudePromptTrusted = false;
  let claudeCommandTrusted = false;
  if (claudeInstalled && dependencies.claudeHookRuntime) {
    try {
      const cwd = process.cwd();
      if (await claudeSettingsHierarchyAllowsHooks(cwd)) {
        claudePromptTrusted = hasExactClaudePromptProbe(
          await dependencies.claudeHookRuntime.probePrompt(dependencies.env.HOME as string),
        );
        if (claudePromptTrusted) {
          claudeCommandTrusted = hasExactCodexHookProbe(
            await dependencies.claudeHookRuntime.probeCommand(
              dependencies.env.HOME as string,
              (claudeInstallation as ExactHookInstallationEvidence).probeCommand,
            ),
          );
        }
      }
    } catch {
      claudePromptTrusted = false;
      claudeCommandTrusted = false;
    }
  }
  let runtimeTrusted = false;
  let probeTrusted = false;
  if (installed && dependencies.codexHookRuntime) {
    try {
      const inventory = await dependencies.codexHookRuntime.list();
      const inventoryCwdInfo = isAbsolute(inventory.cwd) ? await stat(inventory.cwd) : undefined;
      runtimeTrusted = hasEffectiveTrustedCodexRuntime(
        inventoryCwdInfo?.isDirectory() ? inventory.hooks : undefined,
        dependencies.env.HOME as string,
      );
      if (runtimeTrusted) {
        probeTrusted = hasExactCodexHookProbe(await dependencies.codexHookRuntime.probe(
          dependencies.env.HOME as string,
          (installation as ExactHookInstallationEvidence).probeCommand,
          inventory.cwd,
        ));
      }
    } catch {
      runtimeTrusted = false;
      probeTrusted = false;
    }
  }
  const missing = {
    prompt_origin: "missing" as const,
    pre_tool_block: "missing" as const,
    post_tool_correlation: "missing" as const,
    execution_recheck: "pending" as const,
    enforced: false,
  };
  const unsupported = {
    prompt_origin: "unsupported" as const,
    pre_tool_block: "unsupported" as const,
    post_tool_correlation: "unsupported" as const,
    execution_recheck: "pending" as const,
    enforced: false,
  };
  return {
    claude: claudeInstalled ? {
      prompt_origin: "ok",
      pre_tool_block: "ok",
      post_tool_correlation: "ok",
      execution_recheck: "pending",
      enforced: dependencies.guardMode === "enforce" && claudePromptTrusted && claudeCommandTrusted,
    } : { ...missing },
    codex: installed ? {
      prompt_origin: "ok",
      pre_tool_block: "ok",
      post_tool_correlation: "ok",
      execution_recheck: "pending",
      enforced: dependencies.guardMode === "enforce" && runtimeTrusted && probeTrusted,
    } : { ...missing },
    gemini: { ...unsupported },
    opencode: { ...unsupported },
  };
}

async function listCodexRuntimeHooks(env: NodeJS.ProcessEnv): Promise<CodexHookRuntimeInventory> {
  const requestedCwd = process.cwd();
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let shuttingDown = false;
    let outcomeCause: unknown;
    let outcomeValue: CodexHookRuntimeInventory | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let stdout = "";
    let outputBytes = 0;
    let initialized = false;
    const requestShutdown = (cause?: unknown, value?: CodexHookRuntimeInventory) => {
      if (settled || shuttingDown) return;
      shuttingDown = true;
      outcomeCause = cause;
      outcomeValue = value;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 250);
    };
    const timer = setTimeout(() => requestShutdown(new Error("Codex hook inventory timed out")), 5_000);
    const writeMessage = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", (cause) => {
      if (settled) return;
      if (child.pid !== undefined) {
        requestShutdown(cause);
        return;
      }
      clearTimeout(timer);
      settled = true;
      reject(cause);
    });
    child.stdin.on("error", (cause) => {
      if (!shuttingDown) requestShutdown(cause);
    });
    child.on("close", () => {
      if (settled) return;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      settled = true;
      if (!shuttingDown) reject(new Error("Codex hook inventory closed early"));
      else if (outcomeCause !== undefined) reject(outcomeCause);
      else if (outcomeValue !== undefined) resolve(outcomeValue);
      else reject(new Error("Codex hook inventory returned no result"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumCodexHooksBytes) requestShutdown(new Error("Codex hook inventory output exceeded its bound"));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumCodexHooksBytes) {
        requestShutdown(new Error("Codex hook inventory output exceeded its bound"));
        return;
      }
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch {
          requestShutdown(new Error("Codex hook inventory returned invalid JSON"));
          return;
        }
        if (!message || typeof message !== "object") continue;
        const response = message as { id?: unknown; result?: unknown; error?: unknown };
        if (response.id === 1) {
          if (response.error !== undefined || initialized) {
            requestShutdown(new Error("Codex hook inventory initialization failed"));
            return;
          }
          initialized = true;
          writeMessage({ method: "initialized" });
          writeMessage({ id: 2, method: "hooks/list", params: { cwds: [requestedCwd] } });
        } else if (response.id === 2) {
          if (response.error !== undefined || !initialized) {
            requestShutdown(new Error("Codex hook inventory request failed"));
            return;
          }
          const parsed = CodexHooksListResultSchema.safeParse(response.result);
          if (!parsed.success) {
            requestShutdown(new Error("Codex hook inventory response was invalid"));
            return;
          }
          const inventory = parsed.data.data[0];
          if (!inventory || !isAbsolute(inventory.cwd) || inventory.cwd !== requestedCwd) {
            requestShutdown(new Error("Codex hook inventory cwd was invalid"));
            return;
          }
          requestShutdown(undefined, { cwd: inventory.cwd, hooks: inventory.hooks });
          return;
        }
      }
    });
    writeMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "jhw-control", version: "1" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

async function probeCodexHookCommand(
  env: NodeJS.ProcessEnv,
  home: string,
  command: string,
  cwd: string,
): Promise<CodexHookProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(env.SHELL ?? "/bin/sh", ["-lc", command], {
      cwd,
      detached: true,
      env: { ...env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let shutdownRequested = false;
    let terminalError: unknown;
    let forceTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const requestShutdown = (cause: unknown) => {
      if (settled || shutdownRequested) return;
      shutdownRequested = true;
      terminalError = cause;
      child.stdin.end();
      signalGroup("SIGTERM");
      forceTimer = setTimeout(() => signalGroup("SIGKILL"), 250);
    };
    const timer = setTimeout(() => requestShutdown(new Error("Codex hook probe timed out")), 9_000);
    const capture = (target: Buffer[], stream: "stdout" | "stderr", chunk: Buffer) => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > maximumCodexProbeBytes || stderrBytes > maximumCodexProbeBytes) {
        requestShutdown(new Error("Codex hook probe output exceeded its bound"));
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.on("error", (cause) => {
      if (settled) return;
      if (child.pid === undefined) {
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        reject(cause);
        return;
      }
      requestShutdown(cause);
    });
    child.stdin.on("error", (cause) => requestShutdown(cause));
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, "stderr", chunk));
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      });
    });
    child.stdin.end('{"hook_event_name":"PreToolUse"}\n');
  });
}

function sanitizedProbePath(): string {
  return [...new Set([dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"])]
    .filter(isAbsolute)
    .join(delimiter);
}

function minimalProbeEnvironment(
  env: NodeJS.ProcessEnv,
  home: string,
  temporaryDirectory: string,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: sanitizedProbePath(),
    SHELL: "/bin/sh",
    TMPDIR: temporaryDirectory,
  };
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    if (typeof env[name] === "string") childEnvironment[name] = env[name];
  }
  return childEnvironment;
}

async function resolveExecutableOnPath(name: string, pathValue: string | undefined): Promise<string> {
  if (!name || name.includes("/") || name.includes("\\")) throw new Error("Invalid executable name");
  const currentUid = process.getuid?.();
  for (const directory of (pathValue ?? sanitizedProbePath()).split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const resolved = await realpath(join(directory, name));
      const info = await stat(resolved);
      if (
        info.isFile()
        && (info.mode & 0o111) !== 0
        && (info.uid === 0 || currentUid !== undefined && info.uid === currentUid)
      ) return resolved;
    } catch {
      // Continue through the bounded caller PATH without exposing candidates.
    }
  }
  throw new Error("Claude executable is unavailable");
}

async function runBoundedClaudeProbe(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin?: string;
    timeoutMs: number;
    timeoutMessage: string;
  },
): Promise<CodexHookProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let shutdownRequested = false;
    let terminalError: unknown;
    let forceTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const requestShutdown = (cause: unknown) => {
      if (settled || shutdownRequested) return;
      shutdownRequested = true;
      terminalError = cause;
      child.stdin?.end();
      signalGroup("SIGTERM");
      forceTimer = setTimeout(() => signalGroup("SIGKILL"), 250);
    };
    const timer = setTimeout(() => requestShutdown(new Error(options.timeoutMessage)), options.timeoutMs);
    const capture = (target: Buffer[], stream: "stdout" | "stderr", chunk: Buffer) => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > maximumCodexProbeBytes || stderrBytes > maximumCodexProbeBytes) {
        requestShutdown(new Error("Claude hook runtime probe output exceeded its bound"));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.on("error", (cause) => {
      if (settled) return;
      if (child.pid === undefined) {
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        reject(cause);
        return;
      }
      requestShutdown(cause);
    });
    child.stdin?.on("error", (cause) => requestShutdown(cause));
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, "stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, "stderr", chunk));
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      });
    });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

async function probeClaudePromptHooks(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<CodexHookProbeResult> {
  const claudeExecutable = await resolveExecutableOnPath("claude", env.PATH);
  const probeConfigDir = await mkdtemp(join(tmpdir(), "jhw-claude-hook-preflight-"));
  await chmod(probeConfigDir, 0o700);
  const signalPath = join(probeConfigDir, "owned-hook-complete");
  const ownedCommand = `${expectedHookCommand("claude", "UserPromptSubmit")}; status=$?; ` +
    `/usr/bin/touch -- "$JHW_CLAUDE_PROBE_SIGNAL"; exit "$status"`;
  const blockingCommand = `i=0; while [ ! -f "$JHW_CLAUDE_PROBE_SIGNAL" ] && [ "$i" -lt 200 ]; do ` +
    `/usr/bin/sleep 0.05; i=$((i+1)); done; [ -f "$JHW_CLAUDE_PROBE_SIGNAL" ] || exit 3; ` +
    `/usr/bin/sleep 1; printf '${claudeProbeStopMarker}\\n' >&2; exit 2`;
  const inlineSettings = JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: ownedCommand, timeout: 12 }],
        },
        {
          hooks: [{
            type: "command",
            command: blockingCommand,
            timeout: 12,
          }],
        },
      ],
    },
  });
  const args = [
    "-p",
    "--verbose",
    "--no-session-persistence",
    "--restricted",
    "--settings", inlineSettings,
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--include-hook-events",
    "--output-format", "stream-json",
    "--max-budget-usd", "0.000001",
    "jhw-claude-preflight-probe",
  ];
  try {
    const childEnvironment = minimalProbeEnvironment(env, home, probeConfigDir);
    childEnvironment.CLAUDE_CONFIG_DIR = probeConfigDir;
    childEnvironment.JHW_CLAUDE_PROBE_SIGNAL = signalPath;
    childEnvironment.ANTHROPIC_API_KEY = "jhw-preflight-no-network";
    childEnvironment.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
    childEnvironment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    childEnvironment.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
    childEnvironment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    childEnvironment.DISABLE_TELEMETRY = "1";
    return await runBoundedClaudeProbe(claudeExecutable, args, {
      cwd: probeConfigDir,
      env: childEnvironment,
      timeoutMs: 15_000,
      timeoutMessage: "Claude hook runtime probe timed out",
    });
  } finally {
    await rm(probeConfigDir, { recursive: true, force: true });
  }
}

async function probeClaudeHookCommand(
  env: NodeJS.ProcessEnv,
  home: string,
  command: string,
): Promise<CodexHookProbeResult> {
  if (command !== expectedHookCommand("claude", "PreToolUse")) {
    throw new Error("Claude hook command is not canonical");
  }
  const probeDirectory = await mkdtemp(join(tmpdir(), "jhw-claude-command-preflight-"));
  await chmod(probeDirectory, 0o700);
  try {
    return await runBoundedClaudeProbe(
      "/usr/bin/bash",
      [join(home, ".local", "bin", "jhw-control-hook"), "--adapter", "claude", "--event", "PreToolUse"],
      {
        cwd: probeDirectory,
        env: minimalProbeEnvironment(env, home, probeDirectory),
        stdin: '{"hook_event_name":"PreToolUse"}\n',
        timeoutMs: 9_000,
        timeoutMessage: "Claude hook command probe timed out",
      },
    );
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

function createCodexHookRuntime(env: NodeJS.ProcessEnv): CodexHookRuntimePort {
  return {
    list: () => listCodexRuntimeHooks(env),
    probe: (home, command, cwd) => probeCodexHookCommand(env, home, command, cwd),
  };
}

function createClaudeHookRuntime(env: NodeJS.ProcessEnv): ClaudeHookRuntimePort {
  return {
    probePrompt: (home) => probeClaudePromptHooks(env, home),
    probeCommand: (home, command) => probeClaudeHookCommand(env, home, command),
  };
}

function guardRequestCounts(requests: z.infer<typeof GuardRequestSchema>[]): z.infer<typeof GuardRequestCountsSchema> {
  const counts = {
    PENDING: 0,
    APPROVED: 0,
    CONSUMED: 0,
    COMPLETED: 0,
    FAILED: 0,
    EXPIRED: 0,
    total: requests.length,
  };
  for (const request of requests) counts[request.state] += 1;
  return GuardRequestCountsSchema.parse(counts);
}

function pendingAdapterCoverage(): z.infer<typeof GuardStatusAdapterCoverageSchema> {
  const pending = () => ({
    prompt_origin: "pending" as const,
    pre_tool_blocking: "pending" as const,
    execution_recheck: "pending" as const,
  });
  return {
    claude: pending(),
    codex: pending(),
    gemini: pending(),
    opencode: pending(),
  };
}

async function inspectGuardState(
  dependencies: CliDependencies,
  session?: string,
): Promise<GuardDiagnosticState> {
  let requestState: z.infer<typeof GuardRequestStatusSchema>;
  try {
    const inspected = GuardRequestInspectionSchema.parse(await dependencies.guardRequests.inspect());
    requestState = {
      safety: inspected.status,
      counts: guardRequestCounts(inspected.requests),
    };
  } catch {
    requestState = { safety: "unavailable" };
  }

  let digestKey: GuardDiagnosticState["digest_key"];
  try {
    const inspected = GuardDigestKeyInspectionSchema.parse(await dependencies.guardDigestKey.inspect());
    digestKey = { safety: inspected.status };
  } catch {
    digestKey = { safety: "unavailable" };
  }

  let registryClaims: GuardDiagnosticState["registry_claims"];
  let sessionClaim: GuardDiagnosticState["session_claim"];
  try {
    const rawClaims = await dependencies.guardClaims.withCommittedView(
      () => dependencies.guardClaims.listActiveClaims(),
    );
    const claims = z.array(ActiveClaimSchema).max(maximumGuardClaims).parse(rawClaims);
    registryClaims = { availability: "available" };
    if (session !== undefined) {
      const matches = claims.filter((claim) => claim.session_id === session);
      if (matches.length === 0) {
        sessionClaim = { match: "none" };
      } else if (matches.length > 1) {
        sessionClaim = { match: "ambiguous" };
      } else {
        const claim = matches[0] as ActiveClaim;
        sessionClaim = {
          match: "unique",
          ...("work_contract_digest" in claim ? { work_contract_digest: claim.work_contract_digest } : {}),
        };
      }
    }
  } catch {
    registryClaims = { availability: "unavailable" };
    if (session !== undefined) sessionClaim = { match: "unavailable" };
  }

  return GuardDiagnosticStateSchema.parse({
    protocol_version: 1,
    runtime_mode: dependencies.guardMode,
    request_state: requestState,
    digest_key: digestKey,
    registry_claims: registryClaims,
    ...(sessionClaim ? { session_claim: sessionClaim } : {}),
  });
}

async function inspectGuardStatus(
  dependencies: CliDependencies,
  session?: string,
): Promise<GuardStatusResult> {
  return GuardStatusResultSchema.parse({
    ...await inspectGuardState(dependencies, session),
    adapter_coverage: pendingAdapterCoverage(),
  });
}

async function inspectGuardPreflight(dependencies: CliDependencies): Promise<GuardPreflightDiagnostics> {
  return GuardPreflightDiagnosticsSchema.parse({
    ...await inspectGuardState(dependencies),
    adapter_coverage: await inspectAdapterCoverage(dependencies),
  });
}

function guardPreflightNoGo(command: "guard preflight", diagnostics: GuardPreflightDiagnostics): CliResult {
  const result = GuardPreflightResultSchema.parse({
    status: "NO-GO",
    code: "GUARD_UNAVAILABLE",
    diagnostics,
  });
  return {
    exitCode: 78,
    stdout: "",
    stderr: `${JSON.stringify({ command, result })}\n`,
  };
}

function errorCode(cause: unknown): string {
  if (!(cause instanceof ControlError) || !/^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code)) return "UNEXPECTED";
  return cause.code;
}

function exitCode(cause: unknown, command?: CommandName): CliResult["exitCode"] {
  const code = errorCode(cause);
  if (new Set([
    "TASK_ALREADY_CLAIMED", "TASK_SESSION_BUSY", "CLAIM_MISMATCH", "CLAIM_NOT_FOUND",
    // Board occupancy/coordinate conflicts are the same family: a script must
    // tell "the board is busy" apart from a crash.
    "BOARD_NOT_FOUND", "BOARD_ALREADY_REGISTERED", "BOARD_NOT_EMPTY", "BOARD_BUSY", "BOARD_RESERVED",
    "RESERVATION_CONFLICT", "HOLDER_NOT_FOUND", "RESERVATION_NOT_FOUND", "HOLDER_AMBIGUOUS", "HOLDER_MISMATCH",
    // A full board or reservation table is a transient occupancy refusal with
    // a reason axis, not a crash.
    "BOARD_LIMIT_EXCEEDED",
  ]).has(code)) return 4;
  if (new Set([
    "REMOTE_DIVERGED", "REMOTE_VERIFY_FAILED", "REGISTRY_DIRTY", "LOCK_BUSY", "LOCK_CONTENDED", "LOCK_ACQUIRE_TIMEOUT",
  ]).has(code)) return 75;
  if (code === "INVALID_CLI_ARGUMENT") return 2;
  // A syntactically valid live-preflight invocation is a go/no-go probe. Any
  // indeterminate, malformed, unavailable, privacy, or restore failure is a
  // stable configuration/policy NO-GO rather than an ordinary command error.
  if (command === "preflight") return 78;
  if (new Set([
    "AUTHORITY_UNAVAILABLE",
    "AUTHORITY_EPOCH_ROLLBACK",
    "AUTHORITY_POLICY_NOT_LEGACY",
    "TOOL_VERSION_TOO_OLD",
    "NOTION_GUARD_INDETERMINATE",
    "MISSING_CREDENTIAL",
    "PORTFOLIO_UNAVAILABLE",
    "PREFLIGHT_UNAVAILABLE",
    "INVALID_CONFIG",
    "CREDENTIALS_NOT_SEPARATE",
    "PROJECT_SCOPE_UNVERIFIABLE",
    "PROJECT_TOKEN_HAS_REPO_SCOPE",
    "PROJECT_SCOPE_MISSING",
    "PROJECT_SCOPE_NOT_EXACT",
    "UNSUPPORTED_REGISTRY_OWNER",
    "REGISTRY_REMOTE_NOT_SSH",
    "REGISTRY_REMOTE_MISMATCH",
    "AMBIGUOUS_REGISTRY_REMOTE",
    "PROJECT_NOT_PRIVATE",
    "REPOSITORY_NOT_PRIVATE",
    "COMMAND_TIMEOUT",
  ]).has(code)) return 78;
  return 1;
}

function retainedClaim(cause: unknown): Record<string, string> | undefined {
  if (!(cause instanceof ControlError)) return undefined;
  const { task_id, claim_id, claim_state } = cause.details;
  if (
    typeof task_id !== "string" || !TASK_ID.test(task_id) ||
    typeof claim_id !== "string" || !CLAIM_ID.test(claim_id) ||
    (claim_state !== "active" && claim_state !== "released")
  ) return undefined;
  return { task_id, claim_id, state: claim_state };
}

function retainedTask(value: unknown): RetainedTaskSummary | undefined {
  const parsed = RetainedTaskSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function errorReason(cause: unknown): string | undefined {
  if (!(cause instanceof ControlError)) return undefined;
  const parsed = ErrorReasonSchema.safeParse(cause.details.reason);
  return parsed.success ? parsed.data : undefined;
}

const AmbiguousMappingDiagnosticSchema = z.object({
  reason: z.enum([
    "removed_checkout_present",
    "mapping_target_invalid",
    "mapping_duplicate",
  ]),
  worktree_ref: GuardWorktreeRefSchema,
});

function ambiguousMappingDiagnostic(cause: unknown): z.infer<typeof AmbiguousMappingDiagnosticSchema> | undefined {
  if (!(cause instanceof ControlError) || cause.code !== "WORKTREE_MAPPING_AMBIGUOUS") return undefined;
  const parsed = AmbiguousMappingDiagnosticSchema.safeParse({
    reason: cause.details.reason,
    worktree_ref: cause.details.worktree_ref,
  });
  return parsed.success ? parsed.data : undefined;
}

const RepairMappingDiagnosticSchema = z.object({
  reason: z.enum([
    "repair_checkout_present",
    "repair_checkout_unsafe",
    "repair_lifecycle_uncertain",
    "repair_state_changed",
  ]),
  worktree_ref: GuardWorktreeRefSchema,
});

function repairMappingDiagnostic(cause: unknown): z.infer<typeof RepairMappingDiagnosticSchema> | undefined {
  if (!(cause instanceof ControlError) || cause.code !== "WORKTREE_MAPPING_REPAIR_UNSAFE") return undefined;
  const parsed = RepairMappingDiagnosticSchema.safeParse({
    reason: cause.details.reason,
    worktree_ref: cause.details.worktree_ref,
  });
  return parsed.success ? parsed.data : undefined;
}

function utf8Head(value: string, maximumBytes: number): string {
  let bytes = 0;
  let head = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    head += character;
    bytes += characterBytes;
  }
  return head;
}

function commandFailureDetail(cause: unknown): CommandFailureDetail | undefined {
  if (!(cause instanceof ControlError) || cause.code !== "COMMAND_FAILED") return undefined;
  const parsed = CommandFailureSourceSchema.safeParse(cause.details);
  if (!parsed.success) return undefined;
  const stderr = "stderr" in parsed.data ? parsed.data.stderr : undefined;
  const stderrHead = stderr === undefined
    ? ""
    : utf8Head(stderr, COMMAND_FAILURE_STDERR_HEAD_BYTES);
  const detail = CommandFailureDetailSchema.safeParse({
    command: parsed.data.command,
    exit_code: parsed.data.exitCode,
    ...(stderrHead ? { stderr_head: stderrHead } : {}),
  });
  return detail.success ? detail.data : undefined;
}

function lockHolder(cause: unknown): LockHolderSummary | undefined {
  if (!(cause instanceof ControlError) || cause.code !== "LOCK_CONTENDED") return undefined;
  const parsed = LockHolderSummarySchema.safeParse(cause.details.lock_holder);
  return parsed.success ? parsed.data : undefined;
}

function conflictingClaim(cause: unknown): ConflictingClaimSummary | undefined {
  if (
    !(cause instanceof ControlError) ||
    !new Set(["TASK_ALREADY_CLAIMED", "TASK_SESSION_BUSY"]).has(cause.code)
  ) return undefined;
  const parsed = ConflictingClaimSummarySchema.safeParse(cause.details.conflicting_claim);
  return parsed.success ? parsed.data : undefined;
}

function conflictingBoard(cause: unknown): BoardConflictSummary | undefined {
  if (!(cause instanceof ControlError)) return undefined;
  const parsed = BoardConflictSummarySchema.safeParse(cause.details.conflicting_board);
  return parsed.success ? parsed.data : undefined;
}

// Mirrors the emitted envelope, never raw details: the journal records the
// reason exactly when the operator saw one.
function journalErrorFields(stderr: string): { error_code: string; error_reason?: string } {
  const error = JSON.parse(stderr).error as { code: string; reason?: string };
  return { error_code: error.code, ...(error.reason ? { error_reason: error.reason } : {}) };
}

function pilotJournalErrorFields(stderr: string): {
  error_code: string;
  error_reason?: string;
  error_detail?: CommandFailureDetail;
} {
  const error = JSON.parse(stderr).error as { code: string; reason?: string; detail?: unknown };
  const detail = CommandFailureDetailSchema.safeParse(error.detail);
  return {
    error_code: error.code,
    ...(error.reason ? { error_reason: error.reason } : {}),
    ...(detail.success ? { error_detail: detail.data } : {}),
  };
}

export function controlErrorResult(cause: unknown, command?: CommandName, retainedTaskValue?: unknown): CliResult {
  const code = errorCode(cause);
  const ambiguity = ambiguousMappingDiagnostic(cause);
  const repair = repairMappingDiagnostic(cause);
  const reason = code === "WORKTREE_MAPPING_AMBIGUOUS" || code === "WORKTREE_MAPPING_REPAIR_UNSAFE"
    ? undefined
    : errorReason(cause);
  const detail = commandFailureDetail(cause);
  const holder = lockHolder(cause);
  const conflict = conflictingClaim(cause);
  const boardConflict = conflictingBoard(cause);
  const retained = code === "TASK_ALREADY_CLAIMED" ? undefined : retainedClaim(cause);
  const retainedRegisteredTask = retainedTask(retainedTaskValue);
  const error = {
    code,
    ...(reason ? { reason } : {}),
    ...ambiguity,
    ...repair,
    ...(detail ? { detail } : {}),
    ...(holder ? { lock_holder: holder } : {}),
    ...(conflict ? { conflicting_claim: conflict } : {}),
    ...(boardConflict ? { conflicting_board: boardConflict } : {}),
    ...(retained ? { retained_claim: retained } : {}),
    ...(retainedRegisteredTask ? { retained_task: retainedRegisteredTask } : {}),
  };
  return { exitCode: exitCode(cause, command), stdout: "", stderr: `${JSON.stringify({ error })}\n` };
}

function journalMetadata(command: CommandName, flags: ParsedFlags | undefined, result: CliResult): {
  task_id?: string;
  claim_id?: string;
  worktree_ref?: string;
  recovery_action?: "repair-mapping";
  mapping_changed?: boolean;
  active_work_minutes?: number;
} {
  if (!flags) return {};
  const rawTask = value(flags, "--task");
  const rawClaim = value(flags, "--claim") ?? value(flags, "--expect");
  const rawWorktreeRef = value(flags, "--worktree-ref");
  let repairOutcome: { kind?: unknown; changed?: unknown } = {};
  if (command === "task recover" && result.exitCode === 0) {
    try {
      repairOutcome = (JSON.parse(result.stdout) as { result?: typeof repairOutcome }).result ?? {};
    } catch {
      repairOutcome = {};
    }
  }
  const repair = repairOutcome.kind === "repair-mapping" && typeof repairOutcome.changed === "boolean";
  return {
    ...(rawTask && TASK_ID.test(rawTask) ? { task_id: rawTask } : {}),
    ...(rawClaim && CLAIM_ID.test(rawClaim) ? { claim_id: rawClaim } : {}),
    ...(rawWorktreeRef && GuardWorktreeRefSchema.safeParse(rawWorktreeRef).success
      ? { worktree_ref: rawWorktreeRef }
      : {}),
    ...(repair ? { recovery_action: "repair-mapping" as const, mapping_changed: repairOutcome.changed as boolean } : {}),
    ...(command === "task finish" ? { active_work_minutes: assertPositiveNumber(value(flags, "--active-work-minutes")) } : {}),
  };
}

/** Durations are explicit minute/hour literals; no default lease exists on purpose. */
function parseBoardDuration(raw: string): number {
  const match = raw.match(/^([1-9]\d{0,4})([mh])$/);
  if (!match) usage("Invalid duration");
  const amount = Number(match[1]);
  return match[2] === "h" ? amount * 60 : amount;
}

/** Board booleans follow the --allow-public precedent: the exact literal true. */
function boardBoolean(flags: ParsedFlags, flag: string): boolean {
  const raw = value(flags, flag);
  if (raw === undefined) return false;
  if (raw !== "true") usage("Board flag opt-in must be the exact literal true");
  return true;
}

function requireBoardPositional(argv: readonly string[]): string {
  const raw = argv[2];
  if (!raw || raw.startsWith("--") || !BOARD_ID.test(raw)) usage("Invalid board identifier");
  return raw;
}

function parseBoardInterfaces(flags: ParsedFlags): Array<{ type: "ethernet" | "wireless" | "serial"; address: string }> {
  return values(flags, "--interface").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) usage("Interface must be type=address");
    const type = entry.slice(0, separator);
    const address = entry.slice(separator + 1);
    if (type !== "ethernet" && type !== "wireless" && type !== "serial") usage("Invalid interface type");
    if (!isNonEmpty(address)) usage("Interface requires an address");
    return { type, address };
  });
}

function boardMode(flags: ParsedFlags): BoardMode {
  const raw = required(flags, "--mode");
  if (raw !== "exclusive" && raw !== "shared") usage("Invalid board mode");
  return raw;
}

async function boardWindowAndLiveness(
  flags: ParsedFlags,
  dependencies: CliDependencies,
): Promise<Pick<BoardAcquireInput, "for_minutes" | "until" | "liveness">> {
  const rawFor = value(flags, "--for");
  const rawUntil = value(flags, "--until");
  if ((rawFor === undefined) === (rawUntil === undefined)) usage("Exactly one of --for or --until is required");
  const rawPid = value(flags, "--pid");
  let liveness: BoardAcquireInput["liveness"];
  if (rawPid !== undefined) {
    if (!/^[1-9]\d{0,9}$/.test(rawPid) || Number(rawPid) <= 1) usage("Invalid pid");
    liveness = await captureLivenessTrio(dependencies.livenessProbe, Number(rawPid));
  }
  return {
    ...(rawFor !== undefined ? { for_minutes: parseBoardDuration(rawFor) } : {}),
    ...(rawUntil !== undefined ? { until: rawUntil } : {}),
    ...(liveness ? { liveness } : {}),
  };
}

async function executeBoard(
  command: CommandName,
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<{ result: CliResult; flags?: ParsedFlags }> {
  const board = dependencies.boardService;

  if (command === "board list") {
    const flags = parseFlags(argv.slice(2), new Set(["--after"]));
    assertSafeFlags(flags, dependencies);
    const after = value(flags, "--after");
    if (after !== undefined && !BOARD_ID.test(after)) usage("Invalid board page cursor");
    return { flags, result: boundedBoardCollectionResult(command, await board.list(), after) };
  }

  if (command === "board status") {
    const positional = argv[2] !== undefined && !argv[2].startsWith("--") ? requireBoardPositional(argv) : undefined;
    const flags = parseFlags(
      argv.slice(positional === undefined ? 2 : 3),
      new Set(positional === undefined ? ["--after"] : []),
    );
    assertSafeFlags(flags, dependencies);
    if (positional !== undefined) return { flags, result: resultJson(command, await board.status(positional)) };
    const after = value(flags, "--after");
    if (after !== undefined && !BOARD_ID.test(after)) usage("Invalid board page cursor");
    return { flags, result: boundedBoardCollectionResult(command, await board.status(undefined), after) };
  }

  if (command === "board recover") {
    const flags = parseFlags(argv.slice(2), new Set(["--action", "--confirm", "--session"]));
    assertSafeFlags(flags, dependencies);
    if (required(flags, "--action") !== "reset-state") usage("Invalid recovery action");
    // Non-interactive contract: the confirmation is an exact literal argument.
    if (required(flags, "--confirm") !== "reset-state") usage("Reset requires the exact literal confirmation");
    const result = await board.recoverResetState({ session: required(flags, "--session") });
    return { flags, result: resultJson(command, result) };
  }

  const boardId = requireBoardPositional(argv);
  const rest = argv.slice(3);

  if (command === "board register" || command === "board update") {
    const flags = parseFlags(rest, new Set(["--description", "--interface", "--session"]), new Set(["--interface"]));
    assertSafeFlags(flags, dependencies);
    const session = required(flags, "--session");
    const description = value(flags, "--description");
    const interfaces = parseBoardInterfaces(flags);
    const result = command === "board register"
      ? await board.register({ board_id: boardId, ...(description ? { description } : {}), interfaces, session })
      : await board.update({
        board_id: boardId,
        ...(description !== undefined ? { description } : {}),
        ...(flags.has("--interface") ? { interfaces } : {}),
        session,
      });
    return { flags, result: resultJson(command, result) };
  }

  if (command === "board unregister") {
    const flags = parseFlags(rest, new Set(["--session"]));
    assertSafeFlags(flags, dependencies);
    return { flags, result: resultJson(command, await board.unregister({ board_id: boardId, session: required(flags, "--session") })) };
  }

  if (command === "board acquire" || command === "board wait") {
    const allowed = new Set([
      "--mode", "--for", "--until", "--session", "--purpose", "--pid",
      "--consume", "--claim-expired", "--accept-shortened", "--long-lease", "--cross-session",
      ...(command === "board wait" ? ["--timeout"] : []),
    ]);
    const flags = parseFlags(rest, allowed);
    assertSafeFlags(flags, dependencies);
    const consume = value(flags, "--consume");
    if (consume !== undefined && !RESERVATION_ID.test(consume)) usage("Invalid reservation coordinate");
    const input: BoardAcquireInput = {
      board_id: boardId,
      mode: boardMode(flags),
      session: required(flags, "--session"),
      purpose: required(flags, "--purpose"),
      ...(await boardWindowAndLiveness(flags, dependencies)),
      ...(consume !== undefined ? { consume } : {}),
      ...(boardBoolean(flags, "--claim-expired") ? { claim_expired: true } : {}),
      ...(boardBoolean(flags, "--accept-shortened") ? { accept_shortened: true } : {}),
      ...(boardBoolean(flags, "--long-lease") ? { long_lease: true } : {}),
      ...(boardBoolean(flags, "--cross-session") ? { cross_session: true } : {}),
    };
    if (command === "board acquire") {
      return { flags, result: resultJson(command, await board.acquire(input)) };
    }
    const rawTimeout = value(flags, "--timeout");
    const options = rawTimeout !== undefined ? { timeout_ms: parseBoardDuration(rawTimeout) * 60_000 } : {};
    return { flags, result: resultJson(command, await board.wait(input, options)) };
  }

  if (command === "board release") {
    const flags = parseFlags(rest, new Set(["--holder", "--session", "--cross-session"]));
    assertSafeFlags(flags, dependencies);
    const holder = value(flags, "--holder");
    if (holder !== undefined && !HOLDER_ID.test(holder)) usage("Invalid holder coordinate");
    return {
      flags,
      result: resultJson(command, await board.release({
        board_id: boardId,
        ...(holder !== undefined ? { holder_id: holder } : {}),
        session: required(flags, "--session"),
        ...(boardBoolean(flags, "--cross-session") ? { cross_session: true } : {}),
      })),
    };
  }

  if (command === "board extend") {
    const flags = parseFlags(rest, new Set(["--holder", "--for", "--session", "--long-lease", "--cross-session"]));
    assertSafeFlags(flags, dependencies);
    return {
      flags,
      result: resultJson(command, await board.extend({
        board_id: boardId,
        holder_id: assertPattern(required(flags, "--holder"), HOLDER_ID),
        for_minutes: parseBoardDuration(required(flags, "--for")),
        session: required(flags, "--session"),
        ...(boardBoolean(flags, "--long-lease") ? { long_lease: true } : {}),
        ...(boardBoolean(flags, "--cross-session") ? { cross_session: true } : {}),
      })),
    };
  }

  if (command === "board share") {
    const flags = parseFlags(rest, new Set(["--holder", "--exclusive", "--session", "--cross-session"]));
    assertSafeFlags(flags, dependencies);
    return {
      flags,
      result: resultJson(command, await board.share({
        board_id: boardId,
        holder_id: assertPattern(required(flags, "--holder"), HOLDER_ID),
        ...(boardBoolean(flags, "--exclusive") ? { exclusive: true } : {}),
        session: required(flags, "--session"),
        ...(boardBoolean(flags, "--cross-session") ? { cross_session: true } : {}),
      })),
    };
  }

  if (command === "board reserve") {
    const flags = parseFlags(rest, new Set(["--mode", "--from", "--to", "--session", "--purpose"]));
    assertSafeFlags(flags, dependencies);
    return {
      flags,
      result: resultJson(command, await board.reserve({
        board_id: boardId,
        mode: boardMode(flags),
        from: required(flags, "--from"),
        to: required(flags, "--to"),
        session: required(flags, "--session"),
        purpose: required(flags, "--purpose"),
      })),
    };
  }

  if (command === "board unreserve") {
    const flags = parseFlags(rest, new Set(["--reservation", "--session", "--cross-session"]));
    assertSafeFlags(flags, dependencies);
    return {
      flags,
      result: resultJson(command, await board.unreserve({
        board_id: boardId,
        reservation_id: assertPattern(required(flags, "--reservation"), RESERVATION_ID),
        session: required(flags, "--session"),
        ...(boardBoolean(flags, "--cross-session") ? { cross_session: true } : {}),
      })),
    };
  }

  usage("Unknown command");
}

async function execute(
  command: CommandName,
  argv: readonly string[],
  dependencies: CliDependencies,
  retainTaskFlags: (flags: ParsedFlags) => void,
): Promise<{ result: CliResult; flags?: ParsedFlags }> {
  const parseTaskFlags = (allowed: ReadonlySet<string>, repeated?: Set<string>): ParsedFlags => {
    const flags = parseFlags(argv.slice(2), allowed, repeated);
    assertSafeFlags(flags, dependencies);
    // Keep validated input coordinates available if a later service call throws.
    // This runs inside the existing dispatch/lock boundary, never before it.
    retainTaskFlags(flags);
    return flags;
  };

  if (command === "help") {
    return { result: resultJson(command, { commands: commandNames }) };
  }

  if (command.startsWith("board ")) {
    return executeBoard(command, argv, dependencies);
  }

  if (command === "repository register") {
    const flags = parseFlags(argv.slice(2), new Set(["--repo-id", "--slug", "--repo-path", "--allow-public"]));
    assertSafeFlags(flags, dependencies);
    const repo_id = assertPattern(required(flags, "--repo-id"), REPO_ID);
    const slug = required(flags, "--slug");
    const repository_path = required(flags, "--repo-path");
    if (!repository_path.startsWith("/")) usage("Repository path must be absolute");
    const allowPublic = value(flags, "--allow-public");
    if (allowPublic !== undefined && allowPublic !== "true") usage("Public opt-in must be the exact literal true");
    const registered = await dependencies.source.registerRepository({
      repo_id,
      slug,
      repository_path,
      ...(allowPublic === "true" ? { allow_public: true as const } : {}),
    });
    return {
      flags,
      result: resultJson(command, {
        repo_id: registered.repository.id,
        slug: registered.repository.slug,
        allow_public: registered.repository.allow_public === true,
        created: registered.created,
      }),
    };
  }

  if (command === "task start") {
    const flags = parseTaskFlags(new Set([
      "--task",
      "--project", "--repo-id", "--repo-path", "--issue-node-id", "--issue-url", "--issue-revision",
      "--resolve-from-checkout",
      "--temp-alias", "--goal", "--done", "--scope", "--session", "--role", "--grant", "--depends",
      "--origin-adapter",
    ]), new Set(["--done", "--scope", "--grant", "--depends"]));
    const repository_path = required(flags, "--repo-path");
    if (!repository_path.startsWith("/")) usage("Repository path must be absolute");
    const session_id = requireClaimCoordinate(flags, "--session");
    const origin_adapter = requireOriginAdapter(flags);
    const formalFields = ["--issue-node-id", "--issue-url", "--issue-revision"];
    const temporaryFields = ["--temp-alias", "--goal", "--done", "--scope"];
    const hasFormal = formalFields.some((flag) => flags.has(flag));
    const hasTemporary = temporaryFields.some((flag) => flags.has(flag));
    const existingTaskId = value(flags, "--task");
    const hasExisting = existingTaskId !== undefined;
    const resolveFromCheckout = value(flags, "--resolve-from-checkout");
    if (resolveFromCheckout !== undefined && resolveFromCheckout !== "true") {
      usage("Checkout resolver must be the exact literal true");
    }
    const hasResolved = resolveFromCheckout === "true";
    const hasProject = flags.has("--project");
    const hasRepository = flags.has("--repo-id");
    if (hasProject !== hasRepository) usage("Explicit coordinates require both Project and Repository IDs");
    const hasExplicit = hasProject && hasRepository;
    if (!hasExisting && hasResolved === hasExplicit) usage("New Task start requires exactly one coordinate mode");
    if (hasExisting && (
      hasFormal || hasTemporary || hasProject || hasRepository || hasResolved ||
      flags.has("--role") || flags.has("--grant") || flags.has("--depends")
    )) {
      usage("Existing Task resume cannot include registration fields");
    }
    if (hasResolved && (flags.has("--grant") || flags.has("--depends"))) {
      usage("Checkout-resolved Task start cannot include caller contract fields");
    }
    if (!hasExisting && hasFormal === hasTemporary) usage("Task start requires exactly one task source");

    const rawGrants = values(flags, "--grant");
    const rawDependencies = values(flags, "--depends");
    const contractIntent = hasExisting || hasResolved
      ? undefined
      : parseContractIntentFlags(rawGrants, rawDependencies);
    const taskRole = hasExisting ? undefined : parseTaskRoleFlag(value(flags, "--role"));

    let task: TaskRecord;
    let alias: string;
    let coordinates: TaskCoordinateInput | undefined;
    if (!hasExisting) {
      coordinates = hasResolved
        ? { resolve_from_checkout: true }
        : {
            project_id: assertPattern(required(flags, "--project"), PROJECT_ID),
            repo_id: assertPattern(required(flags, "--repo-id"), REPO_ID),
          };
    }
    if (hasExisting) {
      const existing = await dependencies.source.prepareExistingTask({
        task_id: assertPattern(existingTaskId, TASK_ID),
        repository_path,
      });
      task = existing.task;
      alias = existing.alias;
    } else if (hasFormal) {
      if (coordinates === undefined) usage("New Task coordinate mode is missing");
      const issue_url = required(flags, "--issue-url");
      try {
        const parsed = new URL(issue_url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") usage("Invalid issue URL");
      } catch (cause) {
        if (cause instanceof ControlError) throw cause;
        usage("Invalid issue URL");
      }
      const sourceInput = {
        repository_path,
        issue_url,
        ...(taskRole !== undefined ? { task_role: taskRole } : {}),
        ...(value(flags, "--issue-node-id") ? { expected_issue_node_id: value(flags, "--issue-node-id") } : {}),
        ...(value(flags, "--issue-revision") ? { expected_issue_revision: value(flags, "--issue-revision") } : {}),
      };
      const registration = coordinates.resolve_from_checkout === true
        ? await dependencies.source.registerFormalTask({ ...coordinates, ...sourceInput })
        : await dependencies.source.registerFormalTask({
            ...coordinates,
            ...sourceInput,
            ...(contractIntent !== undefined ? {
              grants: contractIntent.grants,
              dependencies: contractIntent.dependencies,
            } : {}),
          });
      task = registration.task;
      alias = task.aliases[0] ?? usage("Formal Task has no canonical alias");
    } else {
      if (coordinates === undefined) usage("New Task coordinate mode is missing");
      alias = required(flags, "--temp-alias");
      const goal = required(flags, "--goal");
      const done_conditions = values(flags, "--done").filter((entry) => isNonEmpty(entry));
      const expected_scope = values(flags, "--scope").filter((entry) => isNonEmpty(entry));
      if (done_conditions.length === 0 || expected_scope.length === 0) usage("Temporary task needs done and scope values");
      if (taskRole !== "standalone") usage("Temporary Tasks must use the standalone role");
      task = coordinates.resolve_from_checkout === true
        ? await dependencies.source.registerTemporaryTask({
            ...coordinates, repository_path, alias, goal, done_conditions, expected_scope,
          })
        : await dependencies.source.registerTemporaryTask({
            ...coordinates, repository_path, alias, goal, done_conditions, expected_scope,
            ...(contractIntent !== undefined ? {
              grants: contractIntent.grants,
              dependencies: contractIntent.dependencies,
            } : {}),
          });
    }
    const project_id = task.project_id;
    const repo_id = task.repo_id;
    let latestHandoff: Awaited<ReturnType<CliDependencies["taskService"]["handoff"]>> | undefined;
    if (hasExisting) {
      const context = await dependencies.taskService.resumeContext(task.id);
      if (context.available) latestHandoff = context.handoff;
    }
    const started = await dependencies.taskService.start({
      task_id: task.id,
      task_alias: alias,
      project_id,
      repo_id,
      origin_adapter,
      session_id,
      repository_path,
    });
    const startPayload = (latest?: {
      handoff_pointer: string;
      claim_id: string;
      generated_at: string;
      sections: Record<string, string>;
      truncated: boolean;
    }) => ({
      task: taskSummary(task),
      claim: activeSummary(started.claim),
      branch: started.branch,
      worktree_ref: started.worktree_ref,
      reused: started.reused,
      ...(latest ? { latest_handoff: latest } : {}),
    });
    if (latestHandoff) {
      return {
        flags,
        result: boundedHandoffResult(command, latestHandoff, (summary) => startPayload({
          handoff_pointer: summary.handoff_pointer,
          claim_id: summary.claim_id,
          generated_at: summary.generated_at,
          sections: summary.sections,
          truncated: summary.truncated,
        })),
      };
    }
    return {
      flags,
      result: resultJson(command, startPayload()),
    };
  }

  if (command === "task child-start") {
    const flags = parseTaskFlags(new Set([
      "--parent", "--alias", "--repo-path", "--goal", "--done", "--required-for-parent",
      "--grant", "--depends", "--session",
      "--origin-adapter",
    ]), new Set(["--done", "--grant", "--depends"]));
    const repository_path = required(flags, "--repo-path");
    if (!repository_path.startsWith("/")) usage("Repository path must be absolute");
    const done_conditions = values(flags, "--done").filter((entry) => isNonEmpty(entry));
    if (done_conditions.length === 0) usage("Child Task needs done values");
    const contractIntent = parseContractIntentFlags(values(flags, "--grant"), values(flags, "--depends"));
    const parent_task_id = requireTaskId(flags, "--parent");
    const aliasInput = required(flags, "--alias");
    const required_for_parent = parseRequiredForParentFlag(value(flags, "--required-for-parent"));
    const goal = required(flags, "--goal");
    const session_id = requireClaimCoordinate(flags, "--session");
    const origin_adapter = requireOriginAdapter(flags);
    const child = await dependencies.catalog.registerChildTask({
      parent_task_id,
      alias: aliasInput,
      required_for_parent,
      goal,
      done_conditions,
      grants: contractIntent.grants,
      dependencies: contractIntent.dependencies,
    });
    const alias = child.aliases[0] ?? usage("Child Task has no canonical alias");
    let started: Awaited<ReturnType<CliDependencies["taskService"]["start"]>>;
    try {
      started = await dependencies.taskService.start({
        task_id: child.id,
        task_alias: alias,
        project_id: child.project_id,
        repo_id: child.repo_id,
        origin_adapter,
        session_id,
        repository_path,
      });
    } catch (cause) {
      throw new RetainedTaskFailure(cause, child.id);
    }
    return {
      flags,
      result: resultJson(command, {
        task: taskSummary(child),
        claim: activeSummary(started.claim),
        branch: started.branch,
        worktree_ref: started.worktree_ref,
        reused: started.reused,
      }),
    };
  }

  if (command === "task contract") {
    const flags = parseTaskFlags(new Set([
      "--task", "--role", "--grant", "--depends",
    ]), new Set(["--grant", "--depends"]));
    const task_id = requireTaskId(flags);
    const configured = await dependencies.catalog.configureInactiveTask({
      task_id,
      task_role: parseTaskRoleFlag(required(flags, "--role")),
      work_contract: parseWorkContractFlags(
        task_id,
        values(flags, "--grant"),
        values(flags, "--depends"),
      ),
    });
    return { flags, result: resultJson(command, { task: taskSummary(configured) }) };
  }

  if (command === "task completion-ready") {
    const flags = parseTaskFlags(new Set([
      "--task", "--claim", "--integration-validation", "--child-disposition",
    ]), new Set(["--integration-validation", "--child-disposition"]));
    const evidence = parseTaskCompletionEvidenceFlags(
      values(flags, "--integration-validation"),
      values(flags, "--child-disposition"),
    );
    const recorded = await dependencies.taskService.markCompletionReady({
      task_id: requireTaskId(flags),
      claim_id: requireClaimId(flags),
      integration_validation: evidence.integration_validation,
      child_dispositions: evidence.child_dispositions,
    });
    return {
      flags,
      result: resultJson(command, {
        task_id: recorded.task_id,
        claim_id: recorded.claim_id,
        work_contract_digest: recorded.work_contract_digest,
        recorded_at: recorded.recorded_at,
      }),
    };
  }

  if (command === "task promote") {
    const flags = parseTaskFlags(new Set([
      "--task", "--repo-path", "--issue-url", "--issue-node-id", "--issue-revision",
    ]));
    const repository_path = required(flags, "--repo-path");
    if (!repository_path.startsWith("/")) usage("Repository path must be absolute");
    const promoted = await dependencies.source.promoteTemporaryTask({
      task_id: requireTaskId(flags),
      repository_path,
      issue_url: required(flags, "--issue-url"),
      ...(value(flags, "--issue-node-id") ? { expected_issue_node_id: value(flags, "--issue-node-id") } : {}),
      ...(value(flags, "--issue-revision") ? { expected_issue_revision: value(flags, "--issue-revision") } : {}),
    });
    return { flags, result: resultJson(command, { task: taskSummary(promoted) }) };
  }

  if (command === "task status") {
    const flags = parseTaskFlags(new Set([
      "--task", "--claim", "--resolve-from-checkout", "--repo-path", "--origin-adapter", "--session",
    ]));
    const resolveFromCheckout = value(flags, "--resolve-from-checkout");
    const currentFields = ["--resolve-from-checkout", "--repo-path", "--origin-adapter", "--session"] as const;
    const currentCount = currentFields.filter((flag) => flags.has(flag)).length;
    if (currentCount > 0) {
      if (currentCount !== currentFields.length || resolveFromCheckout !== "true" ||
          flags.has("--task") || flags.has("--claim")) {
        usage("Current Task status requires only checkout, adapter, and session coordinates");
      }
      const repository_path = required(flags, "--repo-path");
      if (!repository_path.startsWith("/")) usage("Repository path must be absolute");
      const resolved = await dependencies.source.withResolvedTaskStatusContext(
        { repository_path },
        (context) => dependencies.taskService.currentContext({
          project_id: context.project_id,
          repo_id: context.repo_id,
          repository_slug: context.repository_slug,
          repository_path,
          origin_adapter: requireOriginAdapter(flags),
          session_id: requireClaimCoordinate(flags, "--session"),
        }),
      );
      return { flags, result: resultJson(command, currentTaskStatusProjection(resolved)) };
    }
    const task_id = requireTaskId(flags);
    const requestedClaim = value(flags, "--claim");
    const claim_id = requestedClaim ? assertPattern(requestedClaim, CLAIM_ID) : (await dependencies.claimService.getActive(task_id))?.claim_id;
    if (!claim_id) throw new ControlError("CLAIM_NOT_FOUND", "Task does not have an active Claim");
    const status = await dependencies.taskService.status(task_id, claim_id);
    return {
      flags,
      result: resultJson(command, {
        claim: activeSummary(status.active),
        worktree: {
          branch: status.worktree.branch,
          worktree_ref: status.worktree.worktree_ref,
          head_sha: status.worktree.head_sha,
          dirty: status.worktree.dirty,
          ahead: status.worktree.ahead,
          behind: status.worktree.behind,
        },
      }),
    };
  }

  if (command === "task handoff") {
    const flags = parseTaskFlags(new Set(["--task", "--claim"]));
    const taskId = requireTaskId(flags);
    const claim = value(flags, "--claim");
    const handoff = await dependencies.taskService.handoff(
      taskId,
      claim === undefined ? undefined : assertPattern(claim, CLAIM_ID),
    );
    return { flags, result: boundedHandoffResult(command, handoff, (summary) => summary) };
  }

  if (command === "task finish") {
    const flags = parseTaskFlags(new Set([
      "--task", "--claim", "--status", "--validation", "--outcome", "--source-task-revision",
      "--progress", "--failures", "--next-step", "--related-adr-and-evidence", "--active-work-minutes",
    ]), new Set(["--validation"]));
    const task_id = requireTaskId(flags);
    const claim_id = requireClaimId(flags);
    const status = required(flags, "--status");
    if (status !== "completed" && status !== "handoff" && status !== "abandoned") usage("Invalid Task finish status");
    const validation = values(flags, "--validation").filter((entry) => isNonEmpty(entry));
    if (validation.length === 0) usage("Task finish requires validation");
    const outcome = value(flags, "--outcome")?.trim();
    const source_task_revision = value(flags, "--source-task-revision")?.trim();
    // Validate friction input before the lifecycle service or journal can mutate.
    assertPositiveNumber(value(flags, "--active-work-minutes"));
    if (status === "completed" && !outcome) usage("Completed Task finish requires outcome");
    if (source_task_revision === "unknown") usage("Unknown source-task-revision is not valid evidence");
    const input: TaskFinishInput = {
      task_id,
      claim_id,
      status,
      validation,
      ...(outcome ? { outcome } : {}),
      ...(source_task_revision ? { source_task_revision } : {}),
      ...(value(flags, "--progress") ? { progress: value(flags, "--progress") } : {}),
      ...(value(flags, "--failures") ? { failures: value(flags, "--failures") } : {}),
      ...(value(flags, "--next-step") ? { next_step: value(flags, "--next-step") } : {}),
      ...(value(flags, "--related-adr-and-evidence") ? { related_adr_and_evidence: value(flags, "--related-adr-and-evidence") } : {}),
    };
    let finished: Awaited<ReturnType<CliDependencies["taskService"]["finish"]>>;
    try {
      finished = await dependencies.taskService.finish(input);
    } catch (cause) {
      throw new ParsedCommandFailure(cause, flags);
    }
    return {
      flags,
      result: resultJson(command, {
        task_id: finished.history.task_id,
        claim_id: finished.history.claim_id,
        status: finished.history.status,
        released_at: finished.history.released_at,
        worktree_removed: finished.worktree_removed,
        ...(finished.cleanup_error ? { cleanup_error: finished.cleanup_error } : {}),
        ...(finished.history.handoff_pointer ? { handoff_pointer: finished.history.handoff_pointer } : {}),
      }),
    };
  }

  if (command === "task recover") {
    const flags = parseTaskFlags(new Set([
      "--task", "--expect", "--action", "--session", "--origin-adapter",
      "--resolve-from-checkout", "--repo-path", "--issue-url", "--worktree-ref",
    ]));
    const actionName = required(flags, "--action");
    const discoveryNames = [
      "--resolve-from-checkout",
      "--repo-path",
      "--issue-url",
    ] as const;
    const discoveryCount = discoveryNames.filter((name) => flags.has(name)).length;
    if (discoveryCount > 0) {
      if (
        actionName !== "status" ||
        discoveryCount !== discoveryNames.length ||
        value(flags, "--resolve-from-checkout") !== "true" ||
        flags.has("--task") ||
        flags.has("--expect") ||
        flags.has("--session") ||
        flags.has("--origin-adapter") ||
        flags.has("--worktree-ref")
      ) {
        usage("Recovery discovery requires only checkout, Issue, and status");
      }
      const repository_path = required(flags, "--repo-path");
      if (!repository_path.startsWith("/")) usage("Repository path must be absolute");
      const discovered = await dependencies.source.withResolvedExistingFormalTask({
        repository_path,
        issue_url: required(flags, "--issue-url"),
      }, async ({ task }) => ({
        task_id: task.id,
        snapshot: await dependencies.taskService.recoveryDiscovery(task.id),
      }));
      if (discovered.snapshot.state === "active") {
        return {
          flags,
          result: resultJson(command, {
            kind: "resolved",
            task_id: discovered.task_id,
            state: "active",
            claim: discovered.snapshot.claim,
            recovery: discovered.snapshot.recovery,
          }),
        };
      }
      if (!discovered.snapshot.handoff.available) {
        return {
          flags,
          result: resultJson(command, {
            kind: "resolved",
            task_id: discovered.task_id,
            state: "inactive",
            handoff: { available: false },
          }),
        };
      }
      return {
        flags,
        result: boundedHandoffResult(
          command,
          discovered.snapshot.handoff.handoff,
          (handoff) => ({
            kind: "resolved",
            task_id: discovered.task_id,
            state: "inactive",
            handoff: {
              available: true,
              claim_id: handoff.claim_id,
              handoff_pointer: handoff.handoff_pointer,
              generated_at: handoff.generated_at,
              sections: handoff.sections,
              truncated: handoff.truncated,
            },
          }),
        ),
      };
    }
    const task_id = requireTaskId(flags);
    const claim_id = requireClaimId(flags, "--expect");
    let action: TaskRecoverInput["action"];
    if (actionName !== "repair-mapping" && flags.has("--worktree-ref")) {
      usage("Only repair-mapping accepts --worktree-ref");
    }
    if (actionName === "status" || actionName === "force-end" || actionName === "cleanup") {
      // The documented session is advisory for non-takeover recovery.
      action = { kind: actionName };
    } else if (actionName === "takeover") {
      action = {
        kind: "takeover",
        origin_adapter: requireOriginAdapter(flags),
        session_id: requireClaimCoordinate(flags, "--session"),
      };
    } else if (actionName === "repair-mapping") {
      if (flags.has("--session") || flags.has("--origin-adapter")) {
        usage("Mapping repair accepts no session authority");
      }
      const parsedRef = GuardWorktreeRefSchema.safeParse(required(flags, "--worktree-ref"));
      if (!parsedRef.success) usage("Invalid worktree ref");
      action = { kind: "repair-mapping", worktree_ref: parsedRef.data };
    } else {
      usage("Invalid recovery action");
    }
    const recovered = await dependencies.taskService.recover({ task_id, claim_id, action });
    return {
      flags,
      result: resultJson(command, {
        kind: recovered.kind,
        task_id,
        ...(recovered.kind === "status" ? {
          claim_id,
          process_exists: recovered.process_exists,
          worktree_mapped: recovered.worktree_mapped,
          dirty: recovered.dirty,
          ahead: recovered.ahead,
          session_end: recovered.session_end,
        } : {}),
        ...(recovered.kind === "takeover" ? {
          active: {
            task_id: recovered.active.task_id,
            claim_id: recovered.active.claim_id,
          },
        } : {}),
        ...(recovered.kind === "repair-mapping" ? {
          claim_id: recovered.claim_id,
          worktree_ref: recovered.worktree_ref,
          lifecycle: recovered.lifecycle,
          changed: recovered.changed,
        } : {}),
      }),
    };
  }

  if (command === "task assert-owner") {
    const flags = parseTaskFlags(new Set(["--task", "--claim"]));
    const active = await dependencies.taskService.assertOwner(requireTaskId(flags), requireClaimId(flags));
    return { flags, result: resultJson(command, { owned: true, claim: activeSummary(active) }) };
  }

  if (command === "portfolio status") {
    const flags = parseFlags(argv.slice(2), new Set(["--project", "--page"]));
    assertSafeFlags(flags, dependencies);
    const project = value(flags, "--project");
    if (project) assertPattern(project, PROJECT_ID);
    const page = value(flags, "--page");
    if (page !== undefined && !isNonEmpty(page)) usage("Invalid portfolio page");
    const status = validatedPortResult(
      BoundedPortfolioPayloadSchema,
      await dependencies.portfolio.status(project, page),
      "INVALID_PORTFOLIO_RESULT",
    );
    const result = resultJson(command, status);
    if (Buffer.byteLength(result.stdout, "utf8") > 12 * 1024) {
      throw new ControlError("PORTFOLIO_PAYLOAD_TOO_LARGE", "Portfolio CLI payload exceeds the byte boundary");
    }
    return { flags, result };
  }

  if (command === "portfolio export") {
    const flags = parseFlags(argv.slice(2), new Set());
    assertSafeFlags(flags, dependencies);
    const exported = validatedPortResult(
      SnapshotExportResultSchema,
      await dependencies.portfolio.exportSnapshot(),
      "INVALID_SNAPSHOT_RESULT",
    );
    return { flags, result: resultJson(command, exported) };
  }

  if (command === "project register") {
    const flags = parseFlags(argv.slice(2), new Set([
      "--project", "--title", "--objective", "--repo-id", "--status", "--priority", "--health",
      "--next-action", "--last-reviewed",
    ]), new Set(["--repo-id"]));
    assertSafeFlags(flags, dependencies);
    const parsedInput = RegisterProjectInputSchema.safeParse({
      project_id: required(flags, "--project"),
      title: required(flags, "--title"),
      objective: required(flags, "--objective"),
      repo_ids: values(flags, "--repo-id"),
      fields: {
        status: required(flags, "--status"),
        priority: required(flags, "--priority"),
        health: required(flags, "--health"),
        next_action: required(flags, "--next-action"),
        last_reviewed: required(flags, "--last-reviewed"),
      },
    });
    if (!parsedInput.success) usage("Invalid project registration arguments");
    const registered = validatedPortResult(
      ProjectRecordLinkSchema,
      await dependencies.portfolio.registerProject(parsedInput.data),
      "INVALID_PROJECT_REGISTRATION_RESULT",
    );
    if (registered.project_id !== parsedInput.data.project_id) {
      throw new ControlError("INVALID_PROJECT_REGISTRATION_RESULT", "Registered Project ID does not match the request");
    }
    return { flags, result: resultJson(command, registered) };
  }

  if (command === "project update") {
    const flags = parseFlags(argv.slice(2), new Set([
      "--project", "--status", "--priority", "--health", "--next-action", "--last-reviewed",
    ]));
    assertSafeFlags(flags, dependencies);
    // Only the flags the operator actually supplied become the patch, so an
    // omitted field is never silently rewritten to a default.
    const supplied = ([
      ["status", "--status"], ["priority", "--priority"], ["health", "--health"],
      ["next_action", "--next-action"], ["last_reviewed", "--last-reviewed"],
    ] as const).filter(([, flag]) => flags.has(flag));
    const parsedInput = UpdateProjectInputSchema.safeParse({
      project_id: required(flags, "--project"),
      fields: Object.fromEntries(supplied.map(([field, flag]) => [field, required(flags, flag)])),
    });
    if (!parsedInput.success) usage("Invalid project update arguments");
    const updated = validatedPortResult(
      ProjectRecordUpdateSchema,
      await dependencies.portfolio.updateProject(parsedInput.data),
      "INVALID_PROJECT_UPDATE_RESULT",
    );
    if (updated.project_id !== parsedInput.data.project_id) {
      throw new ControlError("INVALID_PROJECT_UPDATE_RESULT", "Updated Project ID does not match the request");
    }
    return { flags, result: resultJson(command, updated) };
  }

  if (command === "guard status") {
    const flags = parseFlags(argv.slice(2), new Set(["--session"]));
    assertSafeFlags(flags, dependencies);
    const rawSession = value(flags, "--session");
    const parsedSession = rawSession === undefined ? undefined : ClaimCoordinateSchema.safeParse(rawSession);
    if (parsedSession !== undefined && !parsedSession.success) usage("Invalid Claim session coordinate");
    const diagnostics = await inspectGuardStatus(
      dependencies,
      parsedSession === undefined ? undefined : parsedSession.data,
    );
    return { flags, result: resultJson(command, diagnostics) };
  }

  if (command === "guard preflight") {
    const flags = parseFlags(argv.slice(2), new Set());
    assertSafeFlags(flags, dependencies);
    return {
      flags,
      result: guardPreflightNoGo(command, await inspectGuardPreflight(dependencies)),
    };
  }

  if (command === "preflight") {
    const flags = parseFlags(argv.slice(1), new Set());
    assertSafeFlags(flags, dependencies);
    const preflight = validatedPortResult(PreflightResultSchema, await dependencies.preflight.run(), "INVALID_PREFLIGHT_RESULT");
    return { flags, result: resultJson(command, preflight) };
  }

  usage("Unknown command");
}

/** Testable command dispatcher. It never writes streams or exits the process. */
export async function runCli(argv: string[], dependencies: CliDependencies): Promise<CliResult> {
  const started = dependencies.now?.() ?? new Date();
  const command = commandFor(argv);
  const lockCommand = mutationLockCommand(argv);
  let flags: ParsedFlags | undefined;
  let result: CliResult;
  const executeCommand = () => execute(command, argv, dependencies, (parsed) => { flags = parsed; });
  try {
    // Lifecycle work cannot reach a production service path without first
    // acquiring the injected host-global callback lock. Read-only commands
    // intentionally remain lock-free.
    const execution = lockCommand
      ? await dependencies.mutationLock.run(
        executeCommand,
        { command: lockCommand },
      )
      : await executeCommand();
    if (Buffer.byteLength(execution.result.stdout || execution.result.stderr, "utf8") > CLI_RESULT_BUDGET) {
      throw new ControlError("CLI_OUTPUT_TOO_LARGE", "A control command exceeded the bounded output envelope");
    }
    result = execution.result;
    flags = execution.flags;
  } catch (cause) {
    if (cause instanceof ParsedCommandFailure) {
      flags = cause.flags;
      result = controlErrorResult(cause.originalCause, command);
    } else if (cause instanceof RetainedTaskFailure) {
      result = controlErrorResult(cause.originalCause, command, cause.retainedTask);
    } else {
      result = controlErrorResult(cause, command);
    }
    // Argument rejection is not a command execution and therefore must not
    // invoke the measurement journal.
    if (result.exitCode === 2) return result;
  }

  // Guard diagnostics are operational safety probes, not Pilot/Board trial
  // measurements. Returning here also prevents a derived journal failure from
  // changing an already-computed bounded status or NO-GO result.
  if (command.startsWith("guard ")) return result;

  // A warning here means the record is unusable, so this registration leaves no
  // coordinates to resume from — and a failure is exactly when the operator is
  // told to retry. Rides the failing stream too, the way journal_warning does.
  const warning = dependencies.registrationRecordWarning?.code;
  if (warning) {
    const stream = result.exitCode === 0 ? result.stdout : result.stderr;
    const warned = `${JSON.stringify({
      ...JSON.parse(stream) as Record<string, unknown>,
      registration_record_warning: { code: warning },
    })}\n`;
    result = result.exitCode === 0 ? { ...result, stdout: warned } : { ...result, stderr: warned };
  }

  const finished = dependencies.now?.() ?? new Date();
  const elapsed = Math.max(0, finished.getTime() - started.getTime());
  try {
    // Board rows go to their own stream and NEVER to the pilot journal: the
    // pilot journal is the Phase 1A trial audit set, and mixing board commands
    // into it would contaminate what that audit measures.
    if (command.startsWith("board ")) {
      const boardId = argv[2] !== undefined && BOARD_ID.test(argv[2]) ? argv[2] : undefined;
      // The journal row records what the service resolved, not just what the
      // flags said: an implicit release still names its holder, and the
      // cross-session audit trail the design's evidence gates rely on comes
      // from the result, never from caller input.
      let resolved: Record<string, unknown> = {};
      if (result.exitCode === 0) {
        try {
          resolved = (JSON.parse(result.stdout) as { result?: Record<string, unknown> }).result ?? {};
        } catch {
          resolved = {};
        }
      }
      const resolvedHolder = resolved.holder_id ?? (resolved.holder as { holder_id?: unknown } | undefined)?.holder_id;
      const holderId = typeof resolvedHolder === "string" ? resolvedHolder : (flags ? value(flags, "--holder") : undefined);
      const resolvedReservation = resolved.reservation_id ?? resolved.consumed_reservation;
      const reservationId = typeof resolvedReservation === "string"
        ? resolvedReservation
        : (flags ? (value(flags, "--reservation") ?? value(flags, "--consume")) : undefined);
      await dependencies.boardJournal.append({
        event: "command",
        command,
        ...(boardId ? { board_id: boardId } : {}),
        ...(holderId && HOLDER_ID.test(holderId) ? { holder_id: holderId } : {}),
        ...(reservationId && RESERVATION_ID.test(reservationId) ? { reservation_id: reservationId } : {}),
        ...(resolved.cross_session === true ? { cross_session: true } : {}),
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        elapsed_ms: elapsed,
        ok: result.exitCode === 0,
        ...(result.exitCode === 0 ? {} : journalErrorFields(result.stderr)),
        payload_bytes: Buffer.byteLength(result.stdout || result.stderr, "utf8"),
      });
      return result;
    }
    const metadata = journalMetadata(command, flags, result);
    await (dependencies.journal ?? new PilotJournal(dependencies.stateDir)).append({
      command,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      elapsed_ms: elapsed,
      ok: result.exitCode === 0,
      ...(result.exitCode === 0 ? {} : pilotJournalErrorFields(result.stderr)),
      payload_bytes: Buffer.byteLength(result.stdout || result.stderr, "utf8"),
      ...metadata,
    });
  } catch {
    // The journal is a derived measurement stream, never lifecycle authority.
    // Preserve the command's already-computed outcome and expose only a stable,
    // bounded gap marker so retrying cannot duplicate a successful mutation.
    const stream = result.exitCode === 0 ? result.stdout : result.stderr;
    const parsed = JSON.parse(stream) as Record<string, unknown>;
    const warned = `${JSON.stringify({
      ...parsed,
      journal_warning: { code: "JOURNAL_WRITE_FAILED" },
    })}\n`;
    return result.exitCode === 0
      ? { ...result, stdout: warned }
      : { ...result, stderr: warned };
  }
  return result;
}

function mutationLockCommand(argv: readonly string[]): RegistryMutationCommand | undefined {
  if (argv.length === 1 && argv[0] === "preflight") return "preflight";
  if (argv[0] === "repository" && argv[1] === "register") return "repository register";
  if (argv[0] === "task") {
    switch (argv[1]) {
      case "start": return "task start";
      case "child-start": return "task child-start";
      case "contract": return "task contract";
      case "completion-ready": return "task completion-ready";
      case "finish": return "task finish";
      case "promote": return "task promote";
      case "recover": {
        const index = argv.indexOf("--action");
        return new Set(["force-end", "takeover", "cleanup", "repair-mapping"]).has(argv[index + 1] ?? "")
          ? "task recover"
          : undefined;
      }
      default: return undefined;
    }
  }
  if (argv[0] === "project" && argv[1] === "register") return "project register";
  if (argv[0] === "project" && argv[1] === "update") return "project update";
  if (argv[0] === "portfolio" && argv[1] === "export") return "portfolio export";
  return undefined;
}

/** True only for lifecycle mutations that require the host-global callback lock. */
export function requiresMutationLock(argv: readonly string[]): boolean {
  return mutationLockCommand(argv) !== undefined;
}

/**
 * `board with` runs outside the JSON envelope on purpose: the child inherits
 * stdio (its output must not hit the 12KiB envelope), its exit code is
 * propagated verbatim, and the wrapper's own pid is the liveness anchor that
 * makes automatic reclamation certain. Signals are forwarded and release only
 * happens after the child has fully exited, so the wrapper never leaves a
 * holderless occupation behind.
 */
export async function runBoardWith(argv: string[], dependencies: CliDependencies): Promise<number> {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) usage("board with requires -- <command>");
  const head = argv.slice(0, separator);
  const childCommand = argv.slice(separator + 1);
  const boardId = requireBoardPositional(head);
  const flags = parseFlags(head.slice(3), new Set([
    "--mode", "--for", "--until", "--session", "--purpose",
    "--consume", "--long-lease", "--cross-session", "--use-holder", "--json-fd",
  ]));
  assertSafeFlags(flags, dependencies);
  const session = required(flags, "--session");
  const useHolder = value(flags, "--use-holder");
  // Adoption keeps the holder's existing mode and lease; accepting acquisition
  // flags here and silently ignoring them would let the operator believe a
  // lease they never received.
  if (useHolder !== undefined) {
    for (const flag of ["--mode", "--for", "--until", "--purpose", "--consume", "--long-lease"]) {
      if (flags.has(flag)) usage("--use-holder adopts the existing grant and takes no acquisition flags");
    }
  }
  const rawJsonFd = value(flags, "--json-fd");
  if (rawJsonFd !== undefined && !/^[1-9]\d{0,2}$/.test(rawJsonFd)) usage("Invalid json fd");
  const trio = await captureLivenessTrio(dependencies.livenessProbe, process.pid);

  let holderId: string;
  let coordinates: unknown;
  if (useHolder !== undefined) {
    const adopted = await dependencies.boardService.adoptHolder({
      board_id: boardId,
      holder_id: assertPattern(useHolder, HOLDER_ID),
      session,
      liveness: trio,
      ...(boardBoolean(flags, "--cross-session") ? { cross_session: true } : {}),
    });
    holderId = adopted.holder_id;
    coordinates = adopted;
  } else {
    const consume = value(flags, "--consume");
    if (consume !== undefined && !RESERVATION_ID.test(consume)) usage("Invalid reservation coordinate");
    const acquired = await dependencies.boardService.acquire({
      board_id: boardId,
      mode: boardMode(flags),
      session,
      purpose: required(flags, "--purpose"),
      ...(await (async () => {
        const rawFor = value(flags, "--for");
        const rawUntil = value(flags, "--until");
        if ((rawFor === undefined) === (rawUntil === undefined)) usage("Exactly one of --for or --until is required");
        return {
          ...(rawFor !== undefined ? { for_minutes: parseBoardDuration(rawFor) } : {}),
          ...(rawUntil !== undefined ? { until: rawUntil } : {}),
        };
      })()),
      liveness: trio,
      ...(consume !== undefined ? { consume } : {}),
      ...(boardBoolean(flags, "--long-lease") ? { long_lease: true } : {}),
      ...(boardBoolean(flags, "--cross-session") ? { cross_session: true } : {}),
    });
    holderId = acquired.holder.holder_id;
    coordinates = acquired;
  }

  const coordinateLine = `${JSON.stringify({ command: "board with", coordinates })}\n`;
  if (rawJsonFd !== undefined) {
    try {
      writeSync(Number(rawJsonFd), coordinateLine);
    } catch {
      await writeStream(process.stderr, coordinateLine);
    }
  } else {
    await writeStream(process.stderr, coordinateLine);
  }

  // The child deliberately inherits the full environment: it is the operator's
  // own test command, not a control subprocess, and stripping credentials here
  // would silently break tests that legitimately need them.
  let childExit = 1;
  try {
    childExit = await new Promise<number>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(childCommand[0] as string, childCommand.slice(1), { stdio: "inherit" });
      } catch {
        resolve(1);
        return;
      }
      const forward = (signal: NodeJS.Signals) => {
        try { child.kill(signal); } catch { /* the child is already gone */ }
      };
      const onInt = () => forward("SIGINT");
      const onTerm = () => forward("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      child.once("error", () => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        resolve(1);
      });
      child.once("close", (code, signal) => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        // Shell convention for every signal, not just the interrupt family: a
        // SIGSEGV crash must surface as 139, never masquerade as Ctrl+C's 130.
        resolve(code ?? (signal ? 128 + (osSignals[signal] ?? 2) : 1));
      });
    });
  } finally {
    try {
      await dependencies.boardService.release({ board_id: boardId, holder_id: holderId, session });
    } catch (cause) {
      // Release failure (for example an eviction that already happened) is a
      // warning; it never overwrites the child's exit code.
      await writeStream(process.stderr, controlErrorResult(cause).stderr);
    }
    try {
      await dependencies.boardJournal.append({
        event: "command",
        command: "board with",
        board_id: boardId,
        holder_id: holderId,
        ok: childExit === 0,
      });
    } catch {
      // The board journal is derived measurement, never lock authority.
    }
  }
  return childExit;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "board" && argv[1] === "with") {
    try {
      process.exitCode = await runBoardWith(argv, createCliDependencies(process.env));
    } catch (cause) {
      const result = controlErrorResult(cause);
      await writeStream(process.stderr, result.stderr);
      process.exitCode = result.exitCode;
    }
    return;
  }
  if (commandFor(argv) === "help") {
    // Help is intentionally configuration-free so an operator can discover the
    // required command contract before host authority has been provisioned.
    await writeStream(process.stdout, resultJson("help", { commands: commandNames }).stdout);
    process.exitCode = 0;
    return;
  }
  try {
    const result = await runCli(argv, createCliDependencies(process.env));
    await writeStream(process.stdout, result.stdout);
    await writeStream(process.stderr, result.stderr);
    process.exitCode = result.exitCode;
  } catch (cause) {
    const result = controlErrorResult(cause);
    await writeStream(process.stderr, result.stderr);
    process.exitCode = result.exitCode;
  }
}

/** Resolves only after Node confirms the complete bounded payload was flushed. */
export async function writeStream(stream: Writable, content: string): Promise<void> {
  if (!content) return;
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause);
    stream.once("error", onError);
    stream.write(content, (cause?: Error | null) => {
      stream.off("error", onError);
      if (cause) reject(cause);
      else resolve();
    });
  });
}

/** Safely recognizes direct or npm-bin symlink execution without trusting argv text. */
export function isCliEntrypointInvocation(invokedPath: string | undefined, modulePath: string): boolean {
  if (!invokedPath) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isCliEntrypointInvocation(process.argv[1], fileURLToPath(import.meta.url))) void main();
