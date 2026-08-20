#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import type { ZodType } from "zod";

import { Catalog } from "./catalog.js";
import { RegistryRecordStore } from "./codec.js";
import { ClaimService } from "./claim-service.js";
import { loadControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { GitHubProjectClient, type RegistrationRecordWarning } from "./github-project.js";
import { GitHubSourceService } from "./github-source.js";
import { PilotJournal, type JournalPort } from "./journal.js";
import { MutationLock, ProcessRunner, type MutationLockPort } from "./process.js";
import { PortfolioService } from "./portfolio.js";
import { PreflightService } from "./preflight.js";
import { RegistrationHintStore } from "./registration-hint.js";
import { RegistryGit } from "./registry-git.js";
import { createSensitiveDataPolicy } from "./sensitive-data.js";
import { TaskService, type TaskFinishInput, type TaskRecoverInput } from "./task-service.js";
import { WorktreeManager } from "./worktree.js";
import { assertPhase1ACommittedLegacy, createAuthorityService } from "./authority.js";
import { getNotionClient } from "../notion-client.js";
import { verifyConfiguredNotionAuthorityRoutes } from "../notion/authority-guard.js";
import {
  AuthorityRecordSchema,
  BoundedPortfolioPayloadSchema,
  ConflictingClaimSummarySchema,
  PreflightResultSchema,
  ProjectRecordLinkSchema,
  ProjectRecordUpdateSchema,
  RegisterProjectInputSchema,
  SnapshotExportResultSchema,
  UpdateProjectInputSchema,
  type ActiveClaim,
  type BoundedPortfolioPayload,
  type ConflictingClaimSummary,
  type PreflightResult,
  type ProjectRecordLink,
  type ProjectRecordUpdate,
  type RegisterProjectInput,
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

const commandNames = [
  "repository register",
  "task start",
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
] as const;

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
  taskService: Pick<TaskService, "start" | "status" | "finish" | "recover" | "assertOwner" | "handoff">;
  claimService: Pick<ClaimService, "getActive">;
  catalog: Pick<Catalog, "registerFormalTask" | "registerTemporaryTask">;
  source: Pick<GitHubSourceService,
    "registerRepository" | "registerFormalTask" | "registerTemporaryTask" | "prepareExistingTask" | "promoteTemporaryTask">;
  portfolio: PortfolioPort;
  preflight: PreflightPort;
  mutationLock: MutationLockPort;
  journal?: JournalPort;
}

class ParsedCommandFailure extends Error {
  constructor(
    readonly originalCause: unknown,
    readonly flags: ParsedFlags,
  ) {
    super("Command execution failed after parsing");
  }
}

/** Builds the production graph while retaining explicitly injectable future ports. */
export function createCliDependencies(env: NodeJS.ProcessEnv = process.env): CliDependencies {
  const config = loadControlConfig(env);
  const registrationRecordWarning: { code?: RegistrationRecordWarning } = {};
  const runner = new ProcessRunner(env);
  const sensitiveData = createSensitiveDataPolicy(env, [config.registryDir, config.stateDir, config.worktreeRoot]);
  const registry = new RegistryGit(config, runner, sensitiveData);
  const catalog = new Catalog(config, registry, sensitiveData);
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
    mutationLock: new MutationLock(config, env),
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

function taskSummary(task: TaskRecord): Record<string, unknown> {
  return { task_id: task.id, kind: task.kind, project_id: task.project_id, repo_id: task.repo_id };
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

function validatedPortResult<T>(schema: ZodType<T>, raw: unknown, code: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ControlError(code, "A control port returned an invalid result");
  return parsed.data;
}

function errorCode(cause: unknown): string {
  if (!(cause instanceof ControlError) || !/^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code)) return "UNEXPECTED";
  return cause.code;
}

function exitCode(cause: unknown, command?: CommandName): CliResult["exitCode"] {
  const code = errorCode(cause);
  if (new Set(["TASK_ALREADY_CLAIMED", "CLAIM_MISMATCH", "CLAIM_NOT_FOUND"]).has(code)) return 4;
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

function conflictingClaim(cause: unknown): ConflictingClaimSummary | undefined {
  if (!(cause instanceof ControlError) || cause.code !== "TASK_ALREADY_CLAIMED") return undefined;
  const parsed = ConflictingClaimSummarySchema.safeParse(cause.details.conflicting_claim);
  return parsed.success ? parsed.data : undefined;
}

export function controlErrorResult(cause: unknown, command?: CommandName): CliResult {
  const code = errorCode(cause);
  const conflict = conflictingClaim(cause);
  const retained = code === "TASK_ALREADY_CLAIMED" ? undefined : retainedClaim(cause);
  const error = {
    code,
    ...(conflict ? { conflicting_claim: conflict } : {}),
    ...(retained ? { retained_claim: retained } : {}),
  };
  return { exitCode: exitCode(cause, command), stdout: "", stderr: `${JSON.stringify({ error })}\n` };
}

function journalMetadata(command: CommandName, flags: ParsedFlags | undefined): {
  task_id?: string;
  claim_id?: string;
  active_work_minutes?: number;
} {
  if (!flags) return {};
  const rawTask = value(flags, "--task");
  const rawClaim = value(flags, "--claim") ?? value(flags, "--expect");
  return {
    ...(rawTask && TASK_ID.test(rawTask) ? { task_id: rawTask } : {}),
    ...(rawClaim && CLAIM_ID.test(rawClaim) ? { claim_id: rawClaim } : {}),
    ...(command === "task finish" ? { active_work_minutes: assertPositiveNumber(value(flags, "--active-work-minutes")) } : {}),
  };
}

async function execute(command: CommandName, argv: readonly string[], dependencies: CliDependencies): Promise<{ result: CliResult; flags?: ParsedFlags }> {
  if (command === "help") {
    return { result: resultJson(command, { commands: commandNames }) };
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
    const flags = parseFlags(argv.slice(2), new Set([
      "--task",
      "--project", "--repo-id", "--repo-path", "--issue-node-id", "--issue-url", "--issue-revision",
      "--temp-alias", "--goal", "--done", "--scope", "--session",
    ]), new Set(["--done", "--scope"]));
    assertSafeFlags(flags, dependencies);
    const repository_path = required(flags, "--repo-path");
    if (!repository_path.startsWith("/")) usage("Repository path must be absolute");
    const session_id = required(flags, "--session");
    const formalFields = ["--issue-node-id", "--issue-url", "--issue-revision"];
    const temporaryFields = ["--temp-alias", "--goal", "--done", "--scope"];
    const hasFormal = formalFields.some((flag) => flags.has(flag));
    const hasTemporary = temporaryFields.some((flag) => flags.has(flag));
    const existingTaskId = value(flags, "--task");
    const hasExisting = existingTaskId !== undefined;
    if (hasExisting && (hasFormal || hasTemporary || flags.has("--project") || flags.has("--repo-id"))) {
      usage("Existing Task resume cannot include registration fields");
    }
    if (!hasExisting && hasFormal === hasTemporary) usage("Task start requires exactly one task source");

    let task: TaskRecord;
    let alias: string;
    let project_id: string;
    let repo_id: string;
    if (hasExisting) {
      const existing = await dependencies.source.prepareExistingTask({
        task_id: assertPattern(existingTaskId, TASK_ID),
        repository_path,
      });
      task = existing.task;
      alias = existing.alias;
      project_id = task.project_id;
      repo_id = task.repo_id;
    } else if (hasFormal) {
      project_id = assertPattern(required(flags, "--project"), PROJECT_ID);
      repo_id = assertPattern(required(flags, "--repo-id"), REPO_ID);
      const issue_url = required(flags, "--issue-url");
      try {
        const parsed = new URL(issue_url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") usage("Invalid issue URL");
      } catch (cause) {
        if (cause instanceof ControlError) throw cause;
        usage("Invalid issue URL");
      }
      const registration = await dependencies.source.registerFormalTask({
        project_id,
        repo_id,
        repository_path,
        issue_url,
        ...(value(flags, "--issue-node-id") ? { expected_issue_node_id: value(flags, "--issue-node-id") } : {}),
        ...(value(flags, "--issue-revision") ? { expected_issue_revision: value(flags, "--issue-revision") } : {}),
      });
      task = registration.task;
      alias = task.aliases[0] ?? usage("Formal Task has no canonical alias");
    } else {
      project_id = assertPattern(required(flags, "--project"), PROJECT_ID);
      repo_id = assertPattern(required(flags, "--repo-id"), REPO_ID);
      alias = required(flags, "--temp-alias");
      const goal = required(flags, "--goal");
      const done_conditions = values(flags, "--done").filter((entry) => isNonEmpty(entry));
      const expected_scope = values(flags, "--scope").filter((entry) => isNonEmpty(entry));
      if (done_conditions.length === 0 || expected_scope.length === 0) usage("Temporary task needs done and scope values");
      task = await dependencies.source.registerTemporaryTask({
        project_id, repo_id, repository_path, alias, goal, done_conditions, expected_scope,
      });
    }
    let latestHandoff: Awaited<ReturnType<CliDependencies["taskService"]["handoff"]>> | undefined;
    if (hasExisting) {
      try {
        latestHandoff = await dependencies.taskService.handoff(task.id);
      } catch (cause) {
        if (!(cause instanceof ControlError && new Set(["HANDOFF_NOT_FOUND", "CLAIM_HISTORY_NOT_FOUND"]).has(cause.code))) {
          throw cause;
        }
      }
    }
    const started = await dependencies.taskService.start({
      task_id: task.id,
      task_alias: alias,
      project_id,
      repo_id,
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

  if (command === "task promote") {
    const flags = parseFlags(argv.slice(2), new Set([
      "--task", "--repo-path", "--issue-url", "--issue-node-id", "--issue-revision",
    ]));
    assertSafeFlags(flags, dependencies);
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
    const flags = parseFlags(argv.slice(2), new Set(["--task", "--claim"]));
    assertSafeFlags(flags, dependencies);
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
    const flags = parseFlags(argv.slice(2), new Set(["--task", "--claim"]));
    assertSafeFlags(flags, dependencies);
    const taskId = requireTaskId(flags);
    const claim = value(flags, "--claim");
    const handoff = await dependencies.taskService.handoff(
      taskId,
      claim === undefined ? undefined : assertPattern(claim, CLAIM_ID),
    );
    return { flags, result: boundedHandoffResult(command, handoff, (summary) => summary) };
  }

  if (command === "task finish") {
    const flags = parseFlags(argv.slice(2), new Set([
      "--task", "--claim", "--status", "--validation", "--outcome", "--source-task-revision",
      "--progress", "--failures", "--next-step", "--related-adr-and-evidence", "--active-work-minutes",
    ]), new Set(["--validation"]));
    assertSafeFlags(flags, dependencies);
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
    const flags = parseFlags(argv.slice(2), new Set(["--task", "--expect", "--action", "--session"]));
    assertSafeFlags(flags, dependencies);
    const task_id = requireTaskId(flags);
    const claim_id = requireClaimId(flags, "--expect");
    const actionName = required(flags, "--action");
    let action: TaskRecoverInput["action"];
    if (actionName === "status" || actionName === "force-end" || actionName === "cleanup") {
      // The documented session is advisory for non-takeover recovery.
      action = { kind: actionName };
    } else if (actionName === "takeover") {
      action = { kind: "takeover", session_id: required(flags, "--session") };
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
        } : {}),
        ...(recovered.kind === "takeover" ? {
          active: {
            task_id: recovered.active.task_id,
            claim_id: recovered.active.claim_id,
          },
        } : {}),
      }),
    };
  }

  if (command === "task assert-owner") {
    const flags = parseFlags(argv.slice(2), new Set(["--task", "--claim"]));
    assertSafeFlags(flags, dependencies);
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
  let flags: ParsedFlags | undefined;
  let result: CliResult;
  try {
    // Lifecycle work cannot reach a production service path without first
    // acquiring the injected host-global callback lock. Read-only commands
    // intentionally remain lock-free.
    const execution = requiresMutationLock(argv)
      ? await dependencies.mutationLock.run(() => execute(command, argv, dependencies))
      : await execute(command, argv, dependencies);
    if (Buffer.byteLength(execution.result.stdout || execution.result.stderr, "utf8") > CLI_RESULT_BUDGET) {
      throw new ControlError("CLI_OUTPUT_TOO_LARGE", "A control command exceeded the bounded output envelope");
    }
    result = execution.result;
    flags = execution.flags;
  } catch (cause) {
    if (cause instanceof ParsedCommandFailure) {
      flags = cause.flags;
      result = controlErrorResult(cause.originalCause, command);
    } else {
      result = controlErrorResult(cause, command);
    }
    // Argument rejection is not a command execution and therefore must not
    // invoke the measurement journal.
    if (result.exitCode === 2) return result;
  }

  // A warning here means the record write failed, so this registration has no
  // coordinates to resume from — and a failure after that point is exactly
  // when the operator is told to retry. Rides the failing stream too, the way
  // journal_warning does.
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
    const metadata = journalMetadata(command, flags);
    await (dependencies.journal ?? new PilotJournal(dependencies.stateDir)).append({
      command,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      elapsed_ms: elapsed,
      ok: result.exitCode === 0,
      ...(result.exitCode === 0 ? {} : { error_code: JSON.parse(result.stderr).error.code }),
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

/** True only for lifecycle mutations that require the host-global callback lock. */
export function requiresMutationLock(argv: readonly string[]): boolean {
  if (argv.length === 1 && argv[0] === "preflight") return true;
  if (argv[0] === "repository" && argv[1] === "register") return true;
  if (argv[0] === "task" && (argv[1] === "start" || argv[1] === "finish" || argv[1] === "promote")) return true;
  if (argv[0] === "project" && (argv[1] === "register" || argv[1] === "update")) return true;
  if (argv[0] === "portfolio" && argv[1] === "export") return true;
  if (argv[0] !== "task" || argv[1] !== "recover") return false;
  const index = argv.indexOf("--action");
  return argv[index + 1] === "force-end" || argv[index + 1] === "takeover" || argv[index + 1] === "cleanup";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
