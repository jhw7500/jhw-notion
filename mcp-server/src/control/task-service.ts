import type {
  ClaimTaskInput,
  FinishOutcome,
  RecoveryAction,
  RecoveryResult,
} from "./claim-service.js";
import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import {
  buildHandoff,
  canonicalHandoffPath,
  writeRegistryHandoff,
  writeWorktreeHandoff,
  type HandoffInput,
} from "./handoff.js";
import type { RegistryMutationResult, RegistryTransactionResult } from "./registry-git.js";
import type { ActiveClaim, ClaimHistory } from "./schemas.js";
import { worktreePlan, type WorktreeCreateResult, type WorktreeInspection, type WorktreeRemovalResult } from "./worktree.js";

export interface ClaimServicePort {
  claimTask(input: ClaimTaskInput): Promise<ActiveClaim>;
  finishClaim(taskId: string, claimId: string, outcome: FinishOutcome): Promise<ClaimHistory>;
  recoverClaim(taskId: string, claimId: string, action: RecoveryAction): Promise<RecoveryResult>;
  assertOwner(taskId: string, claimId: string): Promise<ActiveClaim>;
}

export interface WorktreeManagerPort {
  createOrReuse(claim: ActiveClaim, repositoryPath: string): Promise<WorktreeCreateResult>;
  inspect(claim: ActiveClaim): Promise<WorktreeInspection>;
  removeIfSafe(claim: ActiveClaim): Promise<WorktreeRemovalResult>;
}

export interface RegistryGitPort {
  transact(message: string, mutate: () => Promise<RegistryMutationResult>): Promise<RegistryTransactionResult>;
}

export interface TaskStartInput {
  task_id: string;
  task_alias: string;
  project_id: string;
  repo_id: string;
  session_id: string;
  repository_path: string;
}

export interface TaskStartResult {
  claim: ActiveClaim;
  worktree_ref: string;
  branch: string;
  reused: boolean;
}

export interface TaskStatusResult {
  active: ActiveClaim;
  worktree: Omit<WorktreeInspection, "path">;
}

export interface TaskFinishInput {
  task_id: string;
  claim_id: string;
  status: "completed" | "handoff" | "abandoned";
  validation: string[];
  outcome?: string;
  source_task_revision?: string;
  progress?: HandoffInput["progress"];
  failures?: HandoffInput["failures"];
  next_step?: HandoffInput["next_step"];
  related_adr_and_evidence?: HandoffInput["related_adr_and_evidence"];
}

export interface TaskFinishHistory extends ClaimHistory {
  handoff_pointer?: string;
}

export interface TaskFinishResult {
  history: TaskFinishHistory;
  worktree_removed: boolean;
  cleanup_error?: string;
}

export interface TaskRecoverInput {
  task_id: string;
  claim_id: string;
  action: RecoveryAction;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertValidation(validation: string[]): void {
  if (!Array.isArray(validation) || validation.length === 0 || validation.some((line) => !line.trim())) {
    throw new ControlError("INVALID_FINISH_OUTCOME", "Task finish requires at least one non-empty validation result");
  }
}

/**
 * High-level Task lifecycle coordinator. Registry Claim changes remain the sole
 * source of release; host-local worktree removal is strictly post-release cleanup.
 */
export class TaskService {
  constructor(
    private readonly config: ControlConfig,
    private readonly claims: ClaimServicePort,
    private readonly worktrees: WorktreeManagerPort,
    private readonly registry: RegistryGitPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(input: TaskStartInput): Promise<TaskStartResult> {
    const plan = worktreePlan(input.task_id, input.task_alias);
    const claim = await this.claims.claimTask({
      task_id: input.task_id,
      task_alias: input.task_alias,
      project_id: input.project_id,
      repo_id: input.repo_id,
      session_id: input.session_id,
      host: this.config.buildHost,
      branch: plan.branch,
      worktree_ref: plan.worktree_ref,
    });

    let created: WorktreeCreateResult;
    try {
      created = await this.worktrees.createOrReuse(claim, input.repository_path);
    } catch (cause) {
      // Do not leave an uncontended Claim after local allocation failed.  Preserve
      // the original failure even if the best-effort archival transaction also fails.
      await this.claims.finishClaim(claim.task_id, claim.claim_id, {
        status: "abandoned",
        outcome: "worktree creation failed",
        branch: claim.branch,
        head_sha: "unavailable",
        validation: [`worktree creation failed: ${errorMessage(cause)}`],
      }).catch(() => undefined);
      throw cause;
    }

    const owner = await this.claims.assertOwner(claim.task_id, claim.claim_id);
    return {
      claim: owner,
      worktree_ref: owner.worktree_ref,
      branch: owner.branch,
      reused: created.reused,
    };
  }

  async assertOwner(taskId: string, claimId: string): Promise<ActiveClaim> {
    return this.claims.assertOwner(taskId, claimId);
  }

  async status(taskId: string, claimId: string): Promise<TaskStatusResult> {
    const active = await this.assertOwner(taskId, claimId);
    const inspection = await this.worktrees.inspect(active);
    const { path: _path, ...worktree } = inspection;
    return { active, worktree };
  }

  async finish(input: TaskFinishInput): Promise<TaskFinishResult> {
    assertValidation(input.validation);
    const active = await this.assertOwner(input.task_id, input.claim_id);
    const inspection = await this.worktrees.inspect(active);
    let handoffPath: string | undefined;

    if (input.status === "handoff") {
      handoffPath = canonicalHandoffPath(active.task_id, active.claim_id);
      const handoff = buildHandoff({
        task_id: active.task_id,
        source_task_revision: input.source_task_revision ?? "unknown",
        claim_id: active.claim_id,
        generated_at: this.timestamp(),
        progress: input.progress,
        git_state: this.gitState(inspection),
        validation: input.validation,
        failures: input.failures,
        next_step: input.next_step,
        related_adr_and_evidence: input.related_adr_and_evidence,
      });

      await writeWorktreeHandoff(inspection.path, handoff);
      // This transaction must complete (including push verification) before the
      // Claim release transaction; a failed release intentionally leaves this copy.
      await this.registry.transact(`registry: handoff ${active.claim_id}`, async () => {
        const result = await writeRegistryHandoff(this.config.registryDir, active.task_id, active.claim_id, handoff);
        return { paths: result.changed ? [result.path] : [] };
      });
    }

    const history = await this.claims.finishClaim(active.task_id, active.claim_id, {
      status: input.status,
      ...(input.outcome ? { outcome: input.outcome } : {}),
      branch: inspection.branch,
      head_sha: inspection.head_sha,
      validation: input.validation,
      ...(handoffPath ? { handoff_path: handoffPath } : {}),
    });

    if (input.status === "handoff") {
      return {
        history: { ...history, handoff_pointer: handoffPath },
        worktree_removed: false,
      };
    }

    try {
      await this.worktrees.removeIfSafe(active);
      return { history, worktree_removed: true };
    } catch (cause) {
      // The Claim was already durably released.  Retain an unsafe worktree for
      // recovery rather than falsely treating host cleanup as a Claim operation.
      return { history, worktree_removed: false, cleanup_error: errorMessage(cause) };
    }
  }

  async recover(input: TaskRecoverInput): Promise<RecoveryResult> {
    return this.claims.recoverClaim(input.task_id, input.claim_id, input.action);
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ControlError("INVALID_CLOCK", "Task clock must return a valid Date");
    }
    return value.toISOString();
  }

  private gitState(inspection: WorktreeInspection): string[] {
    return [
      `branch: ${inspection.branch}`,
      `head_sha: ${inspection.head_sha}`,
      `dirty_files: ${inspection.dirty_files.length}`,
      `ahead: ${inspection.ahead}`,
      `behind: ${inspection.behind}`,
    ];
  }
}
