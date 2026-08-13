import { lstat, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z, type ZodType } from "zod";

import { Catalog } from "./catalog.js";
import { readRecord, writeRecord } from "./codec.js";
import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { newClaimId } from "./ids.js";
import { RegistryGit, type RegistryMutationResult } from "./registry-git.js";
import { ActiveClaimSchema, ClaimHistorySchema, type ActiveClaim, type ClaimHistory, type TaskRecord } from "./schemas.js";

const taskIdPattern = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const claimIdPattern = /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const projectIdPattern = /^prj-[a-z0-9][a-z0-9-]{1,62}$/;
const repositoryIdPattern = /^repo-[a-z0-9][a-z0-9-]{1,62}$/;

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

function activePath(registryDir: string, taskId: string): string {
  return join(registryDir, "claims", "active", `${taskId}.yaml`);
}

function activeRelativePath(taskId: string): string {
  return `claims/active/${taskId}.yaml`;
}

function historyPath(registryDir: string, year: number, taskId: string, claimId: string): string {
  return join(registryDir, "claims", "history", String(year), taskId, `${claimId}.yaml`);
}

function historyRelativePath(year: number, taskId: string, claimId: string): string {
  return `claims/history/${year}/${taskId}/${claimId}.yaml`;
}

function expectedHandoffPath(taskId: string, claimId: string): string {
  return `handoffs/${taskId}/${claimId}.md`;
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

async function readOptionalRecord<T>(path: string, schema: ZodType<T>): Promise<T | undefined> {
  try {
    await stat(path);
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
  return readRecord(path, schema);
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

function stage(paths: string[]): RegistryMutationResult {
  return { paths };
}

/** Ownership-safe active Claim lifecycle backed by the canonical Registry. */
export class ClaimService {
  constructor(
    private readonly config: ControlConfig,
    private readonly registry: RegistryGit,
    private readonly catalog: Catalog,
    private readonly inspection: ClaimInspection,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claimTask(rawInput: ClaimTaskInput): Promise<ActiveClaim> {
    const input = parse(ClaimTaskInputSchema, rawInput, "INVALID_CLAIM", "Invalid Claim input");
    let claimed: ActiveClaim | undefined;

    await this.registry.transact(`registry: claim task ${input.task_id}`, async () => {
      const task = await this.catalog.getTask(input.task_id);
      this.assertClaimInputMatchesTask(input, task);
      const existing = await this.readActive(task);
      if (existing) {
        throw new ControlError("TASK_ALREADY_CLAIMED", "Task already has an active Claim", {
          task_id: input.task_id,
          claim_id: existing.claim_id,
        });
      }

      const started = this.timestamp();
      claimed = parse(
        ActiveClaimSchema,
        {
          ...input,
          claim_id: newClaimId(Date.parse(started)),
          started_at: started,
        },
        "INVALID_CLAIM",
        "Claim record failed validation",
      );
      await writeRecord(activePath(this.config.registryDir, input.task_id), claimed);
      return stage([activeRelativePath(input.task_id)]);
    });

    if (!claimed) throw new Error("Claim transaction did not produce an active Claim");
    return this.assertOwner(input.task_id, claimed.claim_id);
  }

  async finishClaim(taskId: string, expectedClaimId: string, rawOutcome: FinishOutcome): Promise<ClaimHistory> {
    assertTaskId(taskId);
    assertClaimId(expectedClaimId);
    const outcome = parse(FinishOutcomeSchema, rawOutcome, "INVALID_FINISH_OUTCOME", "Invalid Claim finish outcome");
    let history: ClaimHistory | undefined;

    await this.registry.transact(`registry: finish claim ${expectedClaimId}`, async () => {
      const task = await this.catalog.getTask(taskId);
      const active = await this.requireOwner(task, expectedClaimId);
      this.assertHandoffPath(outcome.handoff_path, taskId, expectedClaimId);
      await this.assertHandoffAvailable(outcome.handoff_path);
      history = this.finishHistory(active, outcome);
      const year = this.historyYear(history.released_at);
      const destination = historyPath(this.config.registryDir, year, taskId, expectedClaimId);
      await this.assertHistoryDestinationAbsent(destination, taskId, expectedClaimId);
      await writeRecord(destination, history);
      await unlink(activePath(this.config.registryDir, taskId));
      return stage([historyRelativePath(year, taskId, expectedClaimId), activeRelativePath(taskId)]);
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
    let history: ClaimHistory | undefined;
    await this.registry.transact(`registry: force-end claim ${expectedClaimId}`, async () => {
      const task = await this.catalog.getTask(taskId);
      const active = await this.requireOwner(task, expectedClaimId);
      history = this.recoveryHistory(active, "force-ended");
      const year = this.historyYear(history.released_at);
      const destination = historyPath(this.config.registryDir, year, taskId, expectedClaimId);
      await this.assertHistoryDestinationAbsent(destination, taskId, expectedClaimId);
      await writeRecord(destination, history);
      await unlink(activePath(this.config.registryDir, taskId));
      return stage([historyRelativePath(year, taskId, expectedClaimId), activeRelativePath(taskId)]);
    });
    if (!history) throw new Error("Claim force-end transaction did not produce history");
    return { kind: "force-end", history };
  }

  private async takeover(taskId: string, expectedClaimId: string, sessionId: string): Promise<RecoveryTakeover> {
    let history: ClaimHistory | undefined;
    let replacement: ActiveClaim | undefined;
    await this.registry.transact(`registry: take over claim ${expectedClaimId}`, async () => {
      const task = await this.catalog.getTask(taskId);
      const active = await this.requireOwner(task, expectedClaimId);
      history = this.recoveryHistory(active, "taken-over");
      const year = this.historyYear(history.released_at);
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
      const destination = historyPath(this.config.registryDir, year, taskId, expectedClaimId);
      await this.assertHistoryDestinationAbsent(destination, taskId, expectedClaimId);
      await writeRecord(destination, history);
      await unlink(activePath(this.config.registryDir, taskId));
      await writeRecord(activePath(this.config.registryDir, taskId), replacement);
      return stage([historyRelativePath(year, taskId, expectedClaimId), activeRelativePath(taskId)]);
    });

    if (!history || !replacement) throw new Error("Claim takeover transaction did not produce both records");
    const verified = await this.assertOwner(taskId, replacement.claim_id);
    return { kind: "takeover", active: verified, history };
  }

  private async readActive(task: TaskRecord): Promise<ActiveClaim | undefined> {
    const recordPath = activePath(this.config.registryDir, task.id);
    let active: ActiveClaim | undefined;
    try {
      active = await readOptionalRecord(recordPath, ActiveClaimSchema);
    } catch (cause) {
      throw corruption("Active Claim record is invalid", {
        recordPath,
        expectedTaskId: task.id,
        cause: errorMessage(cause),
      });
    }
    if (!active) return undefined;
    this.assertActiveMatchesTask(active, task, recordPath);
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

  private async assertHandoffAvailable(handoffPath: string | undefined): Promise<void> {
    if (!handoffPath) return;
    const path = join(this.config.registryDir, handoffPath);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(path);
    } catch (cause) {
      if (isNotFound(cause)) {
        throw new ControlError("HANDOFF_MISSING", "Handoff pointer does not reference a committed Registry file", {
          handoff_path: handoffPath,
        });
      }
      throw corruption("Handoff pointer could not be inspected", {
        handoff_path: handoffPath,
        recordPath: path,
        cause: errorMessage(cause),
      });
    }
    if (!entry.isFile()) {
      throw corruption("Handoff pointer does not reference a regular Registry file", {
        handoff_path: handoffPath,
        recordPath: path,
      });
    }
  }

  private async assertHistoryDestinationAbsent(destination: string, taskId: string, claimId: string): Promise<void> {
    try {
      await lstat(destination);
    } catch (cause) {
      if (isNotFound(cause)) return;
      throw corruption("Claim history destination could not be inspected", {
        recordPath: destination,
        task_id: taskId,
        claim_id: claimId,
        cause: errorMessage(cause),
      });
    }
    throw corruption("Claim history destination already exists", {
      recordPath: destination,
      task_id: taskId,
      claim_id: claimId,
    });
  }

  private finishHistory(active: ActiveClaim, outcome: FinishOutcome): ClaimHistory {
    return parse(
      ClaimHistorySchema,
      {
        ...active,
        branch: outcome.branch,
        head_sha: outcome.head_sha,
        validation_summary: outcome.validation.join("\n"),
        released_at: this.timestamp(),
        status: outcome.status,
        ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
        ...(outcome.handoff_path ? { handoff_path: outcome.handoff_path } : {}),
      },
      "INVALID_CLAIM_HISTORY",
      "Claim history record failed validation",
    );
  }

  private recoveryHistory(active: ActiveClaim, status: "force-ended" | "taken-over"): ClaimHistory {
    return parse(
      ClaimHistorySchema,
      {
        ...active,
        released_at: this.timestamp(),
        status,
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
