import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { z, type ZodType } from "zod";

import { Catalog } from "./catalog.js";
import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { newClaimId } from "./ids.js";
import { RegistryGit, type RegistryMutationResult } from "./registry-git.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import {
  ActiveClaimSchema,
  ClaimHistorySchema,
  ConflictingClaimSummarySchema,
  type ActiveClaim,
  type ClaimHistory,
  type TaskRecord,
} from "./schemas.js";

const taskIdPattern = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const claimIdPattern = /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const projectIdPattern = /^prj-[a-z0-9][a-z0-9-]{1,62}$/;
const repositoryIdPattern = /^repo-[a-z0-9][a-z0-9-]{1,62}$/;
const historyYearDirectoryPattern = /^\d{4}$/;
const maximumHistoryYearDirectories = 10_000;

const ClaimTaskInputSchema = z.object({
  task_id: z.string().regex(taskIdPattern),
  task_alias: z.string().min(1),
  project_id: z.string().regex(projectIdPattern),
  repo_id: z.string().regex(repositoryIdPattern),
  session_id: z.string().min(1),
  host: z.string().min(1),
  branch: z.string().min(1),
  worktree_ref: z.string().min(1),
}).strict();

const FinishOutcomeSchema = z.object({
  status: z.enum(["completed", "handoff", "abandoned"]),
  outcome: z.string().min(1).optional(),
  branch: z.string().min(1),
  head_sha: z.string().min(1),
  validation: z.array(z.string().min(1)).min(1),
  handoff_path: z.string().min(1).optional(),
}).strict();

const RecoveryStatusActionSchema = z.object({ kind: z.literal("status") }).strict();
const RecoveryForceEndActionSchema = z.object({ kind: z.literal("force-end") }).strict();
const RecoveryTakeoverActionSchema = z.object({
  kind: z.literal("takeover"),
  session_id: z.string().min(1),
}).strict();
const RecoveryActionSchema = z.discriminatedUnion("kind", [
  RecoveryStatusActionSchema,
  RecoveryForceEndActionSchema,
  RecoveryTakeoverActionSchema,
]);

const InspectionResultSchema = z.object({
  process_exists: z.boolean(),
  worktree_mapped: z.boolean(),
  dirty: z.boolean(),
  ahead: z.number().int().nonnegative(),
}).strict();

export type ClaimTaskInput = z.infer<typeof ClaimTaskInputSchema>;
export type FinishOutcome = z.infer<typeof FinishOutcomeSchema>;
export type RecoveryStatusAction = z.infer<typeof RecoveryStatusActionSchema>;
export type RecoveryForceEndAction = z.infer<typeof RecoveryForceEndActionSchema>;
export type RecoveryTakeoverAction = z.infer<typeof RecoveryTakeoverActionSchema>;
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;
export type ClaimInspectionResult = z.infer<typeof InspectionResultSchema>;

/** Read-only host observations used by `recoverClaim({ kind: "status" })`. */
export interface ClaimInspection {
  inspect(claim: ActiveClaim): Promise<ClaimInspectionResult>;
}

export interface RecoveryStatus {
  kind: "status";
  active: ActiveClaim;
  recorded: Pick<ActiveClaim, "host" | "session_id">;
  process_exists: boolean;
  worktree_mapped: boolean;
  dirty: boolean;
  ahead: number;
}

export interface RecoveryForceEnd {
  kind: "force-end";
  history: ClaimHistory;
}

export interface RecoveryTakeover {
  kind: "takeover";
  active: ActiveClaim;
  history: ClaimHistory;
}

export type RecoveryResult = RecoveryStatus | RecoveryForceEnd | RecoveryTakeover;

function activeRelativePath(taskId: string): string {
  return `claims/active/${taskId}.yaml`;
}

function historyRelativePath(year: number | string, taskId: string, claimId: string): string {
  return `claims/history/${year}/${taskId}/${claimId}.yaml`;
}

function expectedHandoffPath(taskId: string, claimId: string): string {
  return `handoffs/${taskId}/${claimId}.md`;
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function parse<T>(schema: ZodType<T>, value: unknown, code: string, message: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ControlError(code, message, { issues: result.error.issues });
}

function assertTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId)) {
    throw new ControlError("INVALID_TASK_ID", "Invalid canonical Task ID", { taskId });
  }
}

function assertClaimId(claimId: string): void {
  if (!claimIdPattern.test(claimId)) {
    throw new ControlError("INVALID_CLAIM_ID", "Invalid canonical Claim ID", { claimId });
  }
}

function corruption(message: string, details: Record<string, unknown>): ControlError {
  return new ControlError("REGISTRY_CORRUPT", message, details);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function stage(paths: string[]): RegistryMutationResult {
  return { paths };
}

/** Ownership-safe active Claim lifecycle backed by the canonical Registry. */
export class ClaimService {
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(
    private readonly config: ControlConfig,
    private readonly registry: RegistryGit,
    private readonly catalog: Catalog,
    private readonly inspection: ClaimInspection,
    private readonly now: () => Date = () => new Date(),
    sensitiveData?: SensitiveDataPolicy,
  ) {
    this.sensitiveData = sensitiveData ?? createSensitiveDataPolicy(process.env, [
      config.registryDir,
      config.stateDir,
      config.worktreeRoot,
    ]);
  }

  async claimTask(rawInput: ClaimTaskInput): Promise<ActiveClaim> {
    const input = parse(ClaimTaskInputSchema, rawInput, "INVALID_CLAIM", "Invalid Claim input");
    this.sensitiveData.assertSafe(input);
    await this.assertActivePathComponents(input.task_id);
    const sourceTaskRevision = await this.catalog.getTaskSourceRevision(input.task_id);
    let claimed: ActiveClaim | undefined;

    await this.registry.transact(`registry: claim task ${input.task_id}`, async () => {
      const task = await this.catalog.getTask(input.task_id);
      this.assertClaimInputMatchesTask(input, task);
      const existing = await this.readActive(task);
      if (existing) {
        const summary = ConflictingClaimSummarySchema.safeParse({
          task_id: existing.task_id,
          claim_id: existing.claim_id,
          host: existing.host,
          branch: existing.branch,
          worktree_ref: existing.worktree_ref,
          started_at: existing.started_at,
        });
        throw new ControlError(
          "TASK_ALREADY_CLAIMED",
          "Task already has an active Claim",
          summary.success ? { conflicting_claim: summary.data } : {},
        );
      }
      const lifecyclePaths = await this.catalog.transitionTemporaryLifecycle(task.id, "active");

      const started = this.timestamp();
      claimed = parse(
        ActiveClaimSchema,
        {
          ...input,
          source_task_revision: sourceTaskRevision,
          claim_id: newClaimId(Date.parse(started)),
          started_at: started,
        },
        "INVALID_CLAIM",
        "Claim record failed validation",
      );
      await this.catalog.records.writeJson(activeRelativePath(input.task_id), claimed);
      return stage([...lifecyclePaths, activeRelativePath(input.task_id)]);
    });

    if (!claimed) throw new Error("Claim transaction did not produce an active Claim");
    return this.assertOwner(input.task_id, claimed.claim_id);
  }

  async finishClaim(taskId: string, expectedClaimId: string, rawOutcome: FinishOutcome): Promise<ClaimHistory> {
    assertTaskId(taskId);
    assertClaimId(expectedClaimId);
    const outcome = parse(FinishOutcomeSchema, rawOutcome, "INVALID_FINISH_OUTCOME", "Invalid Claim finish outcome");
    this.sensitiveData.assertSafe(outcome);
    this.assertHandoffPath(outcome.handoff_path, taskId, expectedClaimId);
    await this.assertActivePathComponents(taskId);
    const releasedAt = this.timestamp();
    const year = this.historyYear(releasedAt);
    const historyRelative = historyRelativePath(year, taskId, expectedClaimId);
    await this.assertRegistryPathComponents(historyRelative);
    await this.assertRegistryPathComponents(outcome.handoff_path);
    let history: ClaimHistory | undefined;

    await this.registry.transact(`registry: finish claim ${expectedClaimId}`, async () => {
      const task = await this.catalog.getTask(taskId);
      const active = await this.requireOwner(task, expectedClaimId);
      await this.assertHandoffAvailable(outcome.handoff_path);
      history = this.finishHistory(active, outcome, releasedAt);
      await this.assertHistoryDestinationAbsent(historyRelative, taskId, expectedClaimId);
      await this.catalog.records.writeJson(historyRelative, history);
      await this.catalog.records.remove(activeRelativePath(taskId));
      const lifecyclePaths = await this.catalog.transitionTemporaryLifecycle(taskId, outcome.status);
      return stage([historyRelativePath(year, taskId, expectedClaimId), activeRelativePath(taskId), ...lifecyclePaths]);
    });

    if (!history) throw new Error("Claim finish transaction did not produce history");
    return history;
  }

  async recoverClaim(taskId: string, expectedClaimId: string, action: RecoveryStatusAction): Promise<RecoveryStatus>;
  async recoverClaim(taskId: string, expectedClaimId: string, action: RecoveryForceEndAction): Promise<RecoveryForceEnd>;
  async recoverClaim(taskId: string, expectedClaimId: string, action: RecoveryTakeoverAction): Promise<RecoveryTakeover>;
  async recoverClaim(taskId: string, expectedClaimId: string, action: RecoveryAction): Promise<RecoveryResult>;
  async recoverClaim(taskId: string, expectedClaimId: string, rawAction: RecoveryAction): Promise<RecoveryResult> {
    assertTaskId(taskId);
    assertClaimId(expectedClaimId);
    const action = parse(RecoveryActionSchema, rawAction, "INVALID_RECOVERY_ACTION", "Invalid Claim recovery action");
    this.sensitiveData.assertSafe(action);

    if (action.kind === "status") return this.recoveryStatus(taskId, expectedClaimId);
    if (action.kind === "force-end") return this.forceEnd(taskId, expectedClaimId);
    return this.takeover(taskId, expectedClaimId, action.session_id);
  }

  /** Returns the active Claim after validating the persistent Task and Claim record. */
  async getActive(taskId: string): Promise<ActiveClaim | undefined> {
    assertTaskId(taskId);
    const task = await this.catalog.getTask(taskId);
    return this.readActive(task);
  }

  /** Returns the active Claim only if `expectedClaimId` is the current generation. */
  async assertOwner(taskId: string, expectedClaimId: string): Promise<ActiveClaim> {
    assertTaskId(taskId);
    assertClaimId(expectedClaimId);
    const task = await this.catalog.getTask(taskId);
    return this.requireOwner(task, expectedClaimId);
  }

  async getClaimHistory(taskId: string, claimId: string): Promise<ClaimHistory> {
    assertTaskId(taskId);
    assertClaimId(claimId);
    const candidates = await this.claimHistoryCandidates(taskId, claimId);
    if (candidates.length === 0) {
      throw new ControlError("CLAIM_HISTORY_NOT_FOUND", "Exact released Claim history does not exist");
    }
    if (candidates.length !== 1) throw corruption("Exact released Claim history is ambiguous", { task_id: taskId });
    return candidates[0] as ClaimHistory;
  }

  async latestHandoffHistory(taskId: string): Promise<ClaimHistory> {
    assertTaskId(taskId);
    const years = await this.historyYears();
    const candidates: ClaimHistory[] = [];
    let inspected = 0;
    for (const year of years) {
      const directory = `claims/history/${year}/${taskId}`;
      const entries = await this.catalog.records.listDirectoryEntries(directory, maximumHistoryYearDirectories);
      for (const entry of entries) {
        if (++inspected > maximumHistoryYearDirectories) {
          throw corruption("Claim Handoff lookup exceeded its deterministic bound", { task_id: taskId });
        }
        const match = entry.kind === "file" ? entry.name.match(/^(clm-[0-9a-f-]+)\.yaml$/) : undefined;
        if (!match || !claimIdPattern.test(match[1] as string)) {
          throw corruption("Claim history directory contains a malformed entry", { task_id: taskId });
        }
        const history = await this.catalog.records.readJson(
          `${directory}/${entry.name}`,
          ClaimHistorySchema,
          { field: "claim_id", value: match[1] as string },
        );
        if (history.task_id !== taskId || String(this.historyYear(history.released_at)).padStart(4, "0") !== year) {
          throw corruption("Claim history path and canonical coordinates disagree", { task_id: taskId });
        }
        if (history.status === "handoff" && history.handoff_path) candidates.push(history);
      }
    }
    if (candidates.length === 0) throw new ControlError("HANDOFF_NOT_FOUND", "Task has no committed Handoff history");
    candidates.sort((left, right) => right.released_at.localeCompare(left.released_at));
    if (candidates[1]?.released_at === candidates[0]?.released_at) {
      throw corruption("Latest Task Handoff history is ambiguous", { task_id: taskId });
    }
    return candidates[0] as ClaimHistory;
  }

  private async recoveryStatus(taskId: string, expectedClaimId: string): Promise<RecoveryStatus> {
    const active = await this.assertOwner(taskId, expectedClaimId);
    const observed = parse(
      InspectionResultSchema,
      await this.inspection.inspect(active),
      "INVALID_INSPECTION_RESULT",
      "Claim inspection returned invalid status data",
    );
    return {
      kind: "status",
      active,
      recorded: { host: active.host, session_id: active.session_id },
      ...observed,
    };
  }

  private async forceEnd(taskId: string, expectedClaimId: string): Promise<RecoveryForceEnd> {
    await this.assertActivePathComponents(taskId);
    const releasedAt = this.timestamp();
    const year = this.historyYear(releasedAt);
    const historyRelative = historyRelativePath(year, taskId, expectedClaimId);
    await this.assertRegistryPathComponents(historyRelative);
    let history: ClaimHistory | undefined;
    await this.registry.transact(`registry: force-end claim ${expectedClaimId}`, async () => {
      const task = await this.catalog.getTask(taskId);
      const active = await this.requireOwner(task, expectedClaimId);
      history = this.recoveryHistory(active, "force-ended", releasedAt);
      await this.assertHistoryDestinationAbsent(historyRelative, taskId, expectedClaimId);
      await this.catalog.records.writeJson(historyRelative, history);
      await this.catalog.records.remove(activeRelativePath(taskId));
      const lifecyclePaths = await this.catalog.transitionTemporaryLifecycle(taskId, "handoff");
      return stage([historyRelativePath(year, taskId, expectedClaimId), activeRelativePath(taskId), ...lifecyclePaths]);
    });
    if (!history) throw new Error("Claim force-end transaction did not produce history");
    return { kind: "force-end", history };
  }

  private async takeover(taskId: string, expectedClaimId: string, sessionId: string): Promise<RecoveryTakeover> {
    await this.assertActivePathComponents(taskId);
    const releasedAt = this.timestamp();
    const year = this.historyYear(releasedAt);
    const historyRelative = historyRelativePath(year, taskId, expectedClaimId);
    await this.assertRegistryPathComponents(historyRelative);
    let history: ClaimHistory | undefined;
    let replacement: ActiveClaim | undefined;
    await this.registry.transact(`registry: take over claim ${expectedClaimId}`, async () => {
      const task = await this.catalog.getTask(taskId);
      const active = await this.readActive(task);
      if (!active) {
        throw new ControlError("CLAIM_NOT_FOUND", "Task does not have an active Claim", { task_id: task.id });
      }
      if (active.claim_id !== expectedClaimId) {
        history = await this.requireLinkedTakeoverRetry(task, expectedClaimId, active, sessionId);
        replacement = active;
        return stage([]);
      }
      if (active.host !== this.config.buildHost) {
        throw new ControlError("HOST_MISMATCH", "Claim takeover is allowed only on the recorded host", {
          claim_host: active.host,
          build_host: this.config.buildHost,
        });
      }
      const started = this.timestamp();
      replacement = parse(
        ActiveClaimSchema,
        {
          ...active,
          claim_id: newClaimId(Date.parse(started)),
          session_id: sessionId,
          host: this.config.buildHost,
          started_at: started,
        },
        "INVALID_CLAIM",
        "Replacement Claim record failed validation",
      );
      if (replacement.claim_id === expectedClaimId) {
        throw corruption("Replacement Claim did not rotate its immutable generation", {
          task_id: taskId,
          claim_id: expectedClaimId,
        });
      }
      history = this.takeoverHistory(active, releasedAt, replacement.claim_id);
      await this.assertHistoryDestinationAbsent(historyRelative, taskId, expectedClaimId);
      await this.catalog.records.writeJson(historyRelative, history);
      await this.catalog.records.remove(activeRelativePath(taskId));
      await this.catalog.records.writeJson(activeRelativePath(taskId), replacement);
      return stage([historyRelative, activeRelativePath(taskId)]);
    });

    if (!history || !replacement) throw new Error("Claim takeover transaction did not produce both records");
    const verified = await this.assertOwner(taskId, replacement.claim_id);
    return { kind: "takeover", active: verified, history };
  }

  private async requireLinkedTakeoverRetry(
    task: TaskRecord,
    expectedClaimId: string,
    active: ActiveClaim,
    requestedSessionId: string,
  ): Promise<ClaimHistory> {
    if (active.host !== this.config.buildHost) {
      throw new ControlError("HOST_MISMATCH", "Claim takeover retry is allowed only on the active Claim host", {
        claim_host: active.host,
        build_host: this.config.buildHost,
      });
    }
    try {
      await this.registry.assertHeadRegularFile(activeRelativePath(task.id));
    } catch (cause) {
      throw corruption("Active takeover successor is not a committed regular Registry record", {
        task_id: task.id,
        claim_id: active.claim_id,
        cause: errorMessage(cause),
      });
    }
    const candidates = await this.claimHistoryCandidates(task.id, expectedClaimId);
    if (candidates.length === 0) {
      throw new ControlError("CLAIM_MISMATCH", "Claim generation is not the directly linked takeover predecessor", {
        task_id: task.id,
        expected_claim_id: expectedClaimId,
        actual_claim_id: active.claim_id,
      });
    }
    if (candidates.length !== 1) {
      throw corruption("Claim takeover history is ambiguous", {
        task_id: task.id,
        claim_id: expectedClaimId,
        candidate_count: candidates.length,
      });
    }

    const history = candidates[0];
    if (
      history.status !== "taken-over" ||
      history.claim_id !== expectedClaimId ||
      history.successor_claim_id !== active.claim_id ||
      active.claim_id === expectedClaimId ||
      active.session_id !== requestedSessionId
    ) {
      throw new ControlError("CLAIM_MISMATCH", "Claim generation is not the requested direct takeover predecessor", {
        task_id: task.id,
        expected_claim_id: expectedClaimId,
        actual_claim_id: active.claim_id,
      });
    }
    if (history.host !== this.config.buildHost) {
      throw new ControlError("HOST_MISMATCH", "Claim takeover history belongs to another host", {
        claim_host: history.host,
        build_host: this.config.buildHost,
      });
    }
    if (
      history.task_id !== active.task_id ||
      history.task_alias !== active.task_alias ||
      history.project_id !== active.project_id ||
      history.repo_id !== active.repo_id ||
      history.branch !== active.branch ||
      history.worktree_ref !== active.worktree_ref
    ) {
      throw corruption("Linked takeover Claim records disagree on canonical coordinates", {
        task_id: task.id,
        predecessor_claim_id: expectedClaimId,
        successor_claim_id: active.claim_id,
      });
    }
    return history;
  }

  private async claimHistoryCandidates(taskId: string, claimId: string): Promise<ClaimHistory[]> {
    const years = await this.historyYears();
    const candidates: ClaimHistory[] = [];
    for (const year of years) {
      const relativePath = historyRelativePath(year, taskId, claimId);
      try {
        const candidate = await this.catalog.records.readOptionalJson(relativePath, ClaimHistorySchema, {
          field: "claim_id",
          value: claimId,
        });
        if (!candidate) continue;
        if (candidate.task_id !== taskId || candidate.claim_id !== claimId) {
          throw corruption("Claim takeover history path and record identity disagree", {
            task_id: taskId,
            claim_id: claimId,
            year,
          });
        }
        const releasedYear = String(this.historyYear(candidate.released_at)).padStart(4, "0");
        if (year !== releasedYear) {
          throw corruption("Claim takeover history is outside its released_at UTC year", {
            task_id: taskId,
            claim_id: claimId,
            year,
            released_year: releasedYear,
          });
        }
        this.sensitiveData.assertSafe(candidate);
        candidates.push(candidate);
      } catch (cause) {
        if (cause instanceof ControlError && cause.code.startsWith("SENSITIVE_")) throw cause;
        if (cause instanceof ControlError && cause.code === "REGISTRY_CORRUPT") throw cause;
        throw corruption("Claim takeover history is invalid", {
          task_id: taskId,
          claim_id: claimId,
          year,
          cause: errorMessage(cause),
        });
      }
    }
    return candidates;
  }

  private async historyYears(): Promise<string[]> {
    const entries = await this.catalog.records.listDirectoryEntries("claims/history", maximumHistoryYearDirectories);
    const years: string[] = [];
    for (const entry of entries) {
      if (entry.kind !== "directory" || !historyYearDirectoryPattern.test(entry.name)) {
        throw corruption("Claim history root contains a malformed year entry", {});
      }
      years.push(entry.name);
    }
    return years;
  }

  private async readActive(task: TaskRecord): Promise<ActiveClaim | undefined> {
    await this.assertActivePathComponents(task.id);
    const recordPath = activeRelativePath(task.id);
    let active: ActiveClaim | undefined;
    try {
      active = await this.catalog.records.readOptionalJson(recordPath, ActiveClaimSchema, {
        field: "task_id",
        value: task.id,
      });
    } catch (cause) {
      throw corruption("Active Claim record is invalid", {
        recordPath,
        expectedTaskId: task.id,
        cause: errorMessage(cause),
      });
    }
    if (!active) return undefined;
    this.assertActiveMatchesTask(active, task, recordPath);
    this.sensitiveData.assertSafe(active);
    return active;
  }

  private async requireOwner(task: TaskRecord, expectedClaimId: string): Promise<ActiveClaim> {
    const active = await this.readActive(task);
    if (!active) {
      throw new ControlError("CLAIM_NOT_FOUND", "Task does not have an active Claim", { task_id: task.id });
    }
    if (active.claim_id !== expectedClaimId) {
      throw new ControlError("CLAIM_MISMATCH", "Claim generation does not own the Task", {
        task_id: task.id,
        expected_claim_id: expectedClaimId,
        actual_claim_id: active.claim_id,
      });
    }
    return active;
  }

  private assertClaimInputMatchesTask(input: ClaimTaskInput, task: TaskRecord): void {
    if (input.project_id !== task.project_id || input.repo_id !== task.repo_id) {
      throw new ControlError("TASK_SCOPE_MISMATCH", "Claim project/repository does not match its canonical Task", {
        task_id: task.id,
        task_project_id: task.project_id,
        task_repo_id: task.repo_id,
        claim_project_id: input.project_id,
        claim_repo_id: input.repo_id,
      });
    }
    if (!task.aliases.includes(input.task_alias)) {
      throw new ControlError("TASK_ALIAS_MISMATCH", "Claim alias is not registered for its canonical Task", {
        task_id: task.id,
        task_alias: input.task_alias,
      });
    }
  }

  private assertActiveMatchesTask(active: ActiveClaim, task: TaskRecord, recordPath: string): void {
    if (
      active.task_id !== task.id ||
      active.project_id !== task.project_id ||
      active.repo_id !== task.repo_id ||
      !task.aliases.includes(active.task_alias)
    ) {
      throw corruption("Active Claim and canonical Task disagree", {
        recordPath,
        expectedTaskId: task.id,
        activeTaskId: active.task_id,
        expectedProjectId: task.project_id,
        activeProjectId: active.project_id,
        expectedRepoId: task.repo_id,
        activeRepoId: active.repo_id,
        activeTaskAlias: active.task_alias,
      });
    }
  }

  private assertHandoffPath(handoffPath: string | undefined, taskId: string, claimId: string): void {
    if (handoffPath && handoffPath !== expectedHandoffPath(taskId, claimId)) {
      throw new ControlError("INVALID_HANDOFF_PATH", "Handoff pointer must use the canonical Claim path", {
        handoff_path: handoffPath,
        expected_handoff_path: expectedHandoffPath(taskId, claimId),
      });
    }
  }

  private async assertActivePathComponents(taskId: string): Promise<void> {
    await this.assertRegistryPathComponents(activeRelativePath(taskId));
  }

  private async assertHandoffAvailable(handoffPath: string | undefined): Promise<void> {
    if (!handoffPath) return;
    try {
      await this.catalog.records.assertCommittedRegularFile(handoffPath);
    } catch (cause) {
      if (cause instanceof ControlError && cause.code === "HANDOFF_MISSING") throw cause;
      throw corruption("Committed Handoff is unavailable or unsafe", {
        handoff_path: handoffPath,
        cause: errorMessage(cause),
      });
    }
  }

  private async assertHistoryDestinationAbsent(
    historyRelative: string,
    taskId: string,
    claimId: string,
  ): Promise<void> {
    try {
      await this.catalog.records.assertAbsent(historyRelative);
    } catch (cause) {
      throw corruption("Claim history destination is unavailable", {
        task_id: taskId,
        claim_id: claimId,
        cause: errorMessage(cause),
      });
    }
  }

  private async assertRegistryPathComponents(relativePath: string | undefined): Promise<void> {
    if (!relativePath) return;
    const components = relativePath.split("/");
    if (components.some((component) => !component || component === "." || component === "..")) {
      throw corruption("Registry path contains an unsafe component", { relativePath });
    }

    let registryRoot: string;
    try {
      registryRoot = await realpath(this.config.registryDir);
    } catch (cause) {
      throw corruption("Registry root could not be resolved", {
        registryDir: this.config.registryDir,
        cause: errorMessage(cause),
      });
    }

    let path = this.config.registryDir;
    for (let index = 0; index < components.length; index += 1) {
      path = join(path, components[index]);
      let entry: Awaited<ReturnType<typeof lstat>>;
      try {
        entry = await lstat(path);
      } catch (cause) {
        if (isNotFound(cause)) return;
        throw corruption("Registry path component could not be inspected", {
          relativePath,
          recordPath: path,
          cause: errorMessage(cause),
        });
      }
      if (entry.isSymbolicLink()) {
        throw corruption("Registry path contains a symbolic-link component", { relativePath, recordPath: path });
      }

      let resolved: string;
      try {
        resolved = await realpath(path);
      } catch (cause) {
        throw corruption("Registry path component could not be resolved", {
          relativePath,
          recordPath: path,
          cause: errorMessage(cause),
        });
      }
      if (!isWithin(registryRoot, resolved)) {
        throw corruption("Registry path component escapes the Registry root", {
          relativePath,
          registryRoot,
          recordPath: path,
          resolvedPath: resolved,
        });
      }
      if (index < components.length - 1 && !entry.isDirectory()) {
        throw corruption("Registry path contains a non-directory ancestor", { relativePath, recordPath: path });
      }
    }
  }

  private finishHistory(active: ActiveClaim, outcome: FinishOutcome, releasedAt: string): ClaimHistory {
    return parse(
      ClaimHistorySchema,
      {
        ...active,
        branch: outcome.branch,
        head_sha: outcome.head_sha,
        validation_summary: outcome.validation.join("\n"),
        released_at: releasedAt,
        status: outcome.status,
        ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
        ...(outcome.handoff_path ? { handoff_path: outcome.handoff_path } : {}),
      },
      "INVALID_CLAIM_HISTORY",
      "Claim history record failed validation",
    );
  }

  private recoveryHistory(
    active: ActiveClaim,
    status: "force-ended",
    releasedAt: string,
  ): ClaimHistory {
    return parse(
      ClaimHistorySchema,
      {
        ...active,
        released_at: releasedAt,
        status,
      },
      "INVALID_CLAIM_HISTORY",
      "Claim history record failed validation",
    );
  }

  private takeoverHistory(active: ActiveClaim, releasedAt: string, successorClaimId: string): ClaimHistory {
    return parse(
      ClaimHistorySchema,
      {
        ...active,
        released_at: releasedAt,
        status: "taken-over",
        successor_claim_id: successorClaimId,
      },
      "INVALID_CLAIM_HISTORY",
      "Claim history record failed validation",
    );
  }

  private timestamp(): string {
    const now = this.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new ControlError("INVALID_CLOCK", "Claim clock must return a valid Date");
    }
    return now.toISOString();
  }

  private historyYear(timestamp: string): number {
    const time = new Date(timestamp);
    if (Number.isNaN(time.getTime())) {
      throw new ControlError("INVALID_CLOCK", "Claim release timestamp must be valid", { timestamp });
    }
    return time.getUTCFullYear();
  }
}
