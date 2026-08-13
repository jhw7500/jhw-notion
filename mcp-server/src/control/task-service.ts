import { createHash } from "node:crypto";

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
  parseHandoffMetadata,
  parseHandoffSections,
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
  readHeadRegularFile(relativePath: string): Promise<string>;
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

const safeWorktreeCreateCodes = new Set([
  "COMMAND_FAILED",
  "HOST_MISMATCH",
  "INVALID_GIT_STATE",
  "INVALID_REPOSITORY_PATH",
  "UNSAFE_STATE_PATH",
  "UNSAFE_WORKTREE_PATH",
  "UNSAFE_WORKTREE_ROOT",
  "WORKTREE_BRANCH_MISMATCH",
  "WORKTREE_MAPPING_MISMATCH",
  "WORKTREE_PATH_EXISTS",
  "WORKTREE_REPOSITORY_MISMATCH",
]);

function worktreeCreateValidation(cause: unknown): string {
  const code = cause instanceof ControlError && safeWorktreeCreateCodes.has(cause.code) ? cause.code : "unknown";
  return `worktree_create_failed:${code}`;
}

function assertValidation(validation: string[]): void {
  if (!Array.isArray(validation) || validation.length === 0 || validation.some((line) => !line.trim())) {
    throw new ControlError("INVALID_FINISH_OUTCOME", "Task finish requires at least one non-empty validation result");
  }
}

interface HandoffGitState {
  branch: string;
  head_sha: string;
  dirty_count: number;
  dirty_digest: string;
  ahead: number;
  behind: number;
}

function handoffRetryConflict(handoffPath: string, reason: string): ControlError {
  return new ControlError("HANDOFF_RETRY_CONFLICT", "Committed Handoff conflicts with current Git evidence", {
    handoff_path: handoffPath,
    reason,
  });
}

function canonicalDirtyPaths(paths: readonly string[]): string {
  // JSON string encoding is unambiguous for arbitrary path characters; sorting
  // makes Git status enumeration order irrelevant without storing paths in the
  // bounded Handoff evidence.
  return JSON.stringify([...paths].sort());
}

function dirtyEvidence(paths: readonly string[]): Pick<HandoffGitState, "dirty_count" | "dirty_digest"> {
  return {
    dirty_count: paths.length,
    dirty_digest: createHash("sha256").update(canonicalDirtyPaths(paths), "utf8").digest("hex"),
  };
}

function withoutExpectedLocalHandoff(paths: readonly string[]): string[] {
  const index = paths.indexOf(".ai/handoff.md");
  if (index < 0) return [...paths];
  // Remove one precise expected retry delta. A duplicated entry remains part
  // of evidence and therefore fails closed rather than being silently hidden.
  return paths.filter((_, current) => current !== index);
}

function parseHandoffGitState(value: string, handoffPath: string): HandoffGitState {
  const values = new Map<string, string>();
  for (const line of value.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) throw handoffRetryConflict(handoffPath, "invalid_git_state_line");
    const key = line.slice(0, separator);
    if (values.has(key)) throw handoffRetryConflict(handoffPath, "duplicate_git_state_key");
    values.set(key, line.slice(separator + 2));
  }
  const currentKeys = new Set(["branch", "head_sha", "dirty_count", "dirty_digest", "ahead", "behind"]);
  const legacyKeys = new Set(["branch", "head_sha", "dirty_files", "dirty_paths", "ahead", "behind"]);
  const hasCurrentEvidence = values.has("dirty_count") || values.has("dirty_digest");
  const allowed = hasCurrentEvidence ? currentKeys : legacyKeys;
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    throw handoffRetryConflict(handoffPath, "unexpected_git_state_key");
  }
  const required = hasCurrentEvidence
    ? ["branch", "head_sha", "dirty_count", "dirty_digest", "ahead", "behind"]
    : ["branch", "head_sha", "dirty_files", "ahead", "behind"];
  if (required.some((key) => !values.has(key))) throw handoffRetryConflict(handoffPath, "missing_git_state_key");
  const count = (key: string): number => {
    const raw = values.get(key) ?? "";
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw handoffRetryConflict(handoffPath, "invalid_git_state_count");
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) throw handoffRetryConflict(handoffPath, "invalid_git_state_count");
    return parsed;
  };
  const branch = values.get("branch") ?? "";
  const head_sha = values.get("head_sha") ?? "";
  if (!branch || !head_sha) throw handoffRetryConflict(handoffPath, "missing_git_identity");
  if (hasCurrentEvidence) {
    const dirty_digest = values.get("dirty_digest") ?? "";
    if (!/^[0-9a-f]{64}$/.test(dirty_digest)) {
      throw handoffRetryConflict(handoffPath, "invalid_dirty_digest");
    }
    return {
      branch,
      head_sha,
      dirty_count: count("dirty_count"),
      dirty_digest,
      ahead: count("ahead"),
      behind: count("behind"),
    };
  }

  // Round-2 paths can be safely verified only for the empty original set.
  // Any nonempty legacy evidence is deliberately fail-closed rather than
  // retaining its unbounded/truncatable path list in the new contract.
  if (count("dirty_files") !== 0) throw handoffRetryConflict(handoffPath, "legacy_dirty_evidence_ambiguous");
  if (values.has("dirty_paths") && values.get("dirty_paths") !== "[]") {
    throw handoffRetryConflict(handoffPath, "legacy_dirty_evidence_ambiguous");
  }
  return {
    branch,
    head_sha,
    ...dirtyEvidence([]),
    ahead: count("ahead"),
    behind: count("behind"),
  };
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
        outcome: "worktree_create_failed",
        branch: claim.branch,
        head_sha: "unavailable",
        validation: [worktreeCreateValidation(cause)],
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
    let evidenceGitState: HandoffGitState | undefined;

    if (input.status === "handoff") {
      handoffPath = canonicalHandoffPath(active.task_id, active.claim_id);
      const revision = input.source_task_revision ?? "unknown";
      const committed = await this.committedHandoff(handoffPath);
      let handoff: string;
      if (committed) {
        const metadata = parseHandoffMetadata(committed);
        if (
          metadata.task_id !== active.task_id ||
          metadata.claim_id !== active.claim_id ||
          metadata.source_task_revision !== revision
        ) {
          throw new ControlError("HANDOFF_RETRY_CONFLICT", "Committed Handoff metadata conflicts with the requested release", {
            handoff_path: handoffPath,
          });
        }
        const sections = parseHandoffSections(committed);
        evidenceGitState = parseHandoffGitState(sections["Git State"], handoffPath);
        this.assertRetryGitEvidence(inspection, evidenceGitState, handoffPath);
        // Reuse the committed Git snapshot while validating every
        // caller-controlled section against its immutable bytes.
        const requested = this.buildRequestedHandoff(
          active,
          inspection,
          input,
          metadata.generated_at,
          sections["Git State"],
        );
        if (requested !== committed) {
          throw new ControlError("HANDOFF_RETRY_CONFLICT", "Committed Handoff conflicts with requested retry fields", {
            handoff_path: handoffPath,
          });
        }
        handoff = committed;
      } else {
        evidenceGitState = this.handoffGitState(inspection);
        handoff = this.buildRequestedHandoff(active, inspection, input, this.timestamp());
      }

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
      // The release history is bound to the committed evidence.  A retry was
      // already rejected if live state differs, but using evidence directly
      // keeps that invariant explicit at this critical boundary.
      branch: evidenceGitState?.branch ?? inspection.branch,
      head_sha: evidenceGitState?.head_sha ?? inspection.head_sha,
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
    const state = this.handoffGitState(inspection);
    return [
      `branch: ${state.branch}`,
      `head_sha: ${state.head_sha}`,
      `dirty_count: ${state.dirty_count}`,
      `dirty_digest: ${state.dirty_digest}`,
      `ahead: ${state.ahead}`,
      `behind: ${state.behind}`,
    ];
  }

  private handoffGitState(inspection: WorktreeInspection): HandoffGitState {
    return {
      branch: inspection.branch,
      head_sha: inspection.head_sha,
      // This runs before the local Handoff write, so it records the complete
      // original dirty set rather than an expected retry-only local delta.
      ...dirtyEvidence(inspection.dirty_files),
      ahead: inspection.ahead,
      behind: inspection.behind,
    };
  }

  private assertRetryGitEvidence(
    inspection: WorktreeInspection,
    evidence: HandoffGitState,
    handoffPath: string,
  ): void {
    if (
      inspection.branch !== evidence.branch ||
      inspection.head_sha !== evidence.head_sha ||
      inspection.ahead !== evidence.ahead ||
      inspection.behind !== evidence.behind
    ) {
      throw handoffRetryConflict(handoffPath, "git_identity_changed");
    }
    const current = dirtyEvidence(inspection.dirty_files);
    const withoutLocalHandoff = dirtyEvidence(withoutExpectedLocalHandoff(inspection.dirty_files));
    const matchesCommittedDirtyEvidence = (candidate: Pick<HandoffGitState, "dirty_count" | "dirty_digest">): boolean =>
      candidate.dirty_count === evidence.dirty_count && candidate.dirty_digest === evidence.dirty_digest;
    if (
      inspection.dirty !== (inspection.dirty_files.length > 0) ||
      (!matchesCommittedDirtyEvidence(current) && !matchesCommittedDirtyEvidence(withoutLocalHandoff))
    ) {
      throw handoffRetryConflict(handoffPath, "dirty_delta_changed");
    }
  }

  private buildRequestedHandoff(
    active: ActiveClaim,
    inspection: WorktreeInspection,
    input: TaskFinishInput,
    generatedAt: string,
    gitState: HandoffInput["git_state"] = this.gitState(inspection),
  ): string {
    return buildHandoff({
      task_id: active.task_id,
      source_task_revision: input.source_task_revision ?? "unknown",
      claim_id: active.claim_id,
      generated_at: generatedAt,
      progress: input.progress,
      git_state: gitState,
      validation: input.validation,
      failures: input.failures,
      next_step: input.next_step,
      related_adr_and_evidence: input.related_adr_and_evidence,
    });
  }

  private async committedHandoff(relativePath: string): Promise<string | undefined> {
    try {
      return await this.registry.readHeadRegularFile(relativePath);
    } catch (cause) {
      if (cause instanceof ControlError && cause.code === "HANDOFF_MISSING") return undefined;
      throw cause;
    }
  }
}
