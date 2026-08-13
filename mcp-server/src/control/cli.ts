#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Catalog } from "./catalog.js";
import { ClaimService } from "./claim-service.js";
import { loadControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { PilotJournal, type JournalPort } from "./journal.js";
import { MutationLock, ProcessRunner, type MutationLockPort } from "./process.js";
import { RegistryGit } from "./registry-git.js";
import { TaskService, type TaskFinishInput, type TaskRecoverInput } from "./task-service.js";
import { WorktreeManager } from "./worktree.js";
import type { ActiveClaim, TaskRecord } from "./schemas.js";

const TASK_ID = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_ID = /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID = /^prj-[a-z0-9][a-z0-9-]{1,62}$/;
const REPO_ID = /^repo-[a-z0-9][a-z0-9-]{1,62}$/;
const SHA = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

const commandNames = [
  "task start",
  "task status",
  "task finish",
  "task recover",
  "task assert-owner",
  "portfolio status",
  "portfolio export",
  "project register",
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
  status(input: { project_id?: string; page_id?: string }): Promise<unknown>;
  export(): Promise<unknown>;
  registerProject(input: { project_id: string; base_sha?: string; head_sha?: string }): Promise<unknown>;
}

export interface PreflightPort {
  run(): Promise<unknown>;
}

export interface CliDependencies {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  taskService: Pick<TaskService, "start" | "status" | "finish" | "recover" | "assertOwner">;
  claimService: Pick<ClaimService, "getActive">;
  catalog: Pick<Catalog, "registerFormalTask" | "registerTemporaryTask">;
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

class UnavailablePortfolioPort implements PortfolioPort {
  async status(): Promise<never> {
    throw new ControlError("PORTFOLIO_UNAVAILABLE", "Portfolio authority is not wired for Phase 1A");
  }

  async export(): Promise<never> {
    throw new ControlError("PORTFOLIO_UNAVAILABLE", "Portfolio authority is not wired for Phase 1A");
  }

  async registerProject(): Promise<never> {
    throw new ControlError("PORTFOLIO_UNAVAILABLE", "Portfolio authority is not wired for Phase 1A");
  }
}

class UnavailablePreflightPort implements PreflightPort {
  async run(): Promise<never> {
    throw new ControlError("PREFLIGHT_UNAVAILABLE", "Preflight authority is not wired for Phase 1A");
  }
}

/** Builds the production graph while retaining explicitly injectable future ports. */
export function createCliDependencies(env: NodeJS.ProcessEnv = process.env): CliDependencies {
  const config = loadControlConfig(env);
  const runner = new ProcessRunner(env);
  const registry = new RegistryGit(config, runner);
  const catalog = new Catalog(config, registry);
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
  });
  return {
    stateDir: config.stateDir,
    env,
    taskService: new TaskService(config, claims, worktrees, registry),
    claimService: claims,
    catalog,
    portfolio: new UnavailablePortfolioPort(),
    preflight: new UnavailablePreflightPort(),
    mutationLock: new MutationLock(config, env),
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

function required(flags: ParsedFlags, flag: string): string {
  const result = value(flags, flag);
  if (!isNonEmpty(result)) usage("Missing required command argument");
  return result;
}

function assertPattern(raw: string, pattern: RegExp): string {
  if (!pattern.test(raw)) usage("Invalid command identifier");
  return raw;
}

function assertSha(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!SHA.test(raw)) usage("Invalid Git SHA");
  return raw.toLowerCase();
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

function errorCode(cause: unknown): string {
  if (!(cause instanceof ControlError) || !/^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code)) return "UNEXPECTED";
  return cause.code;
}

function exitCode(cause: unknown): CliResult["exitCode"] {
  const code = errorCode(cause);
  if (new Set(["TASK_ALREADY_CLAIMED", "CLAIM_MISMATCH", "CLAIM_NOT_FOUND"]).has(code)) return 4;
  if (new Set(["REMOTE_DIVERGED", "REMOTE_VERIFY_FAILED", "REGISTRY_DIRTY", "LOCK_BUSY", "LOCK_CONTENDED"]).has(code)) return 75;
  if (new Set([
    "AUTHORITY_UNAVAILABLE",
    "MISSING_CREDENTIAL",
    "PORTFOLIO_UNAVAILABLE",
    "PREFLIGHT_UNAVAILABLE",
    "INVALID_CONFIG",
  ]).has(code)) return 78;
  if (code === "INVALID_CLI_ARGUMENT") return 2;
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

export function controlErrorResult(cause: unknown): CliResult {
  const retained = retainedClaim(cause);
  const error = { code: errorCode(cause), ...(retained ? { retained_claim: retained } : {}) };
  return { exitCode: exitCode(cause), stdout: "", stderr: `${JSON.stringify({ error })}\n` };
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

  if (command === "task start") {
    const flags = parseFlags(argv.slice(2), new Set([
      "--project", "--repo-id", "--repo-path", "--issue-node-id", "--issue-url", "--issue-revision",
      "--temp-alias", "--goal", "--done", "--scope", "--session",
    ]), new Set(["--done", "--scope"]));
    const project_id = assertPattern(required(flags, "--project"), PROJECT_ID);
    const repo_id = assertPattern(required(flags, "--repo-id"), REPO_ID);
    const repository_path = required(flags, "--repo-path");
    if (!repository_path.startsWith("/")) usage("Repository path must be absolute");
    const session_id = required(flags, "--session");
    const formalFields = ["--issue-node-id", "--issue-url", "--issue-revision"];
    const temporaryFields = ["--temp-alias", "--goal", "--done", "--scope"];
    const hasFormal = formalFields.some((flag) => flags.has(flag));
    const hasTemporary = temporaryFields.some((flag) => flags.has(flag));
    if (hasFormal === hasTemporary) usage("Task start requires exactly one task source");

    let task: TaskRecord;
    let alias: string;
    if (hasFormal) {
      const issue_node_id = required(flags, "--issue-node-id");
      const issue_url = required(flags, "--issue-url");
      try {
        const parsed = new URL(issue_url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") usage("Invalid issue URL");
      } catch (cause) {
        if (cause instanceof ControlError) throw cause;
        usage("Invalid issue URL");
      }
      const issue_revision = required(flags, "--issue-revision");
      const registration = await dependencies.catalog.registerFormalTask({
        project_id,
        repo_id,
        issue_node_id,
        issue_url,
        issue_revision,
        alias: issue_node_id,
      });
      task = registration.task;
      alias = task.aliases[0] ?? issue_node_id;
    } else {
      alias = required(flags, "--temp-alias");
      const goal = required(flags, "--goal");
      const done_conditions = values(flags, "--done").filter((entry) => isNonEmpty(entry));
      const expected_scope = values(flags, "--scope").filter((entry) => isNonEmpty(entry));
      if (done_conditions.length === 0 || expected_scope.length === 0) usage("Temporary task needs done and scope values");
      task = await dependencies.catalog.registerTemporaryTask({ project_id, repo_id, alias, goal, done_conditions, expected_scope });
    }
    const started = await dependencies.taskService.start({
      task_id: task.id,
      task_alias: alias,
      project_id,
      repo_id,
      session_id,
      repository_path,
    });
    return {
      flags,
      result: resultJson(command, {
        task: taskSummary(task),
        claim: activeSummary(started.claim),
        branch: started.branch,
        worktree_ref: started.worktree_ref,
        reused: started.reused,
      }),
    };
  }

  if (command === "task status") {
    const flags = parseFlags(argv.slice(2), new Set(["--task", "--claim"]));
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

  if (command === "task finish") {
    const flags = parseFlags(argv.slice(2), new Set([
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
    if (status === "handoff" && (!source_task_revision || source_task_revision === "unknown")) {
      usage("Handoff Task finish requires source-task-revision");
    }
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
        ...(finished.history.handoff_pointer ? { handoff_pointer: finished.history.handoff_pointer } : {}),
      }),
    };
  }

  if (command === "task recover") {
    const flags = parseFlags(argv.slice(2), new Set(["--task", "--expect", "--action", "--session"]));
    const task_id = requireTaskId(flags);
    const claim_id = requireClaimId(flags, "--expect");
    const actionName = required(flags, "--action");
    let action: TaskRecoverInput["action"];
    if (actionName === "status" || actionName === "force-end") {
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
    const active = await dependencies.taskService.assertOwner(requireTaskId(flags), requireClaimId(flags));
    return { flags, result: resultJson(command, { owned: true, claim: activeSummary(active) }) };
  }

  if (command === "portfolio status") {
    const flags = parseFlags(argv.slice(2), new Set(["--project", "--page"]));
    const project = value(flags, "--project");
    if (project) assertPattern(project, PROJECT_ID);
    const page = value(flags, "--page");
    if (page !== undefined && !isNonEmpty(page)) usage("Invalid portfolio page");
    await dependencies.portfolio.status({ ...(project ? { project_id: project } : {}), ...(page ? { page_id: page } : {}) });
    return { flags, result: resultJson(command, { portfolio_available: true }) };
  }

  if (command === "portfolio export") {
    const flags = parseFlags(argv.slice(2), new Set());
    await dependencies.portfolio.export();
    return { flags, result: resultJson(command, { exported: true }) };
  }

  if (command === "project register") {
    const flags = parseFlags(argv.slice(2), new Set(["--project", "--base-sha", "--head-sha"]));
    const project_id = assertPattern(required(flags, "--project"), PROJECT_ID);
    const base_sha = assertSha(value(flags, "--base-sha"));
    const head_sha = assertSha(value(flags, "--head-sha"));
    await dependencies.portfolio.registerProject({ project_id, ...(base_sha ? { base_sha } : {}), ...(head_sha ? { head_sha } : {}) });
    return { flags, result: resultJson(command, { registered: true }) };
  }

  if (command === "preflight") {
    await dependencies.preflight.run();
    return { result: resultJson(command, { preflight_ready: true }) };
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
    result = execution.result;
    flags = execution.flags;
  } catch (cause) {
    if (cause instanceof ParsedCommandFailure) {
      flags = cause.flags;
      result = controlErrorResult(cause.originalCause);
    } else {
      result = controlErrorResult(cause);
    }
    // Argument rejection is not a command execution and therefore must not
    // invoke the measurement journal.
    if (result.exitCode === 2) return result;
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
    return controlErrorResult(new ControlError("JOURNAL_WRITE_FAILED", "Unable to append the pilot journal"));
  }
  return result;
}

/** True only for lifecycle mutations that require the host-global callback lock. */
export function requiresMutationLock(argv: readonly string[]): boolean {
  if (argv[0] === "task" && (argv[1] === "start" || argv[1] === "finish")) return true;
  if (argv[0] === "project" && argv[1] === "register") return true;
  if (argv[0] !== "task" || argv[1] !== "recover") return false;
  const index = argv.indexOf("--action");
  return argv[index + 1] === "force-end" || argv[index + 1] === "takeover";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (commandFor(argv) === "help") {
    // Help is intentionally configuration-free so an operator can discover the
    // required command contract before host authority has been provisioned.
    process.stdout.write(resultJson("help", { commands: commandNames }).stdout);
    process.exit(0);
    return;
  }
  try {
    const result = await runCli(argv, createCliDependencies(process.env));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  } catch (cause) {
    const result = controlErrorResult(cause);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
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
