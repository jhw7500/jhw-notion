import { createHash } from "node:crypto";

import type {
  ClaimTaskInput,
  FinishOutcome,
  RecoveryAction,
  RecoveryResult,
} from "./claim-service.js";
import type { ControlConfig } from "./config.js";
import { RegistryRecordStore, type RegistryDirectoryEntry } from "./codec.js";
import { ControlError } from "./errors.js";
import {
  buildHandoff,
  canonicalHandoffPath,
  assertValidHandoff,
  parseHandoffSections,
  MAX_HANDOFF_BYTES,
  writeRegistryHandoff,
  writeWorktreeHandoff,
  type HandoffInput,
} from "./handoff.js";
import type { RegistryMutationResult, RegistryTransactionResult } from "./registry-git.js";
import type { ActiveClaim, ClaimHistory } from "./schemas.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import { worktreePlan, type WorktreeCreateResult, type WorktreeInspection, type WorktreeRemovalResult } from "./worktree.js";

export interface ClaimServicePort {
  claimTask(input: ClaimTaskInput): Promise<ActiveClaim>;
  finishClaim(taskId: string, claimId: string, outcome: FinishOutcome): Promise<ClaimHistory>;
  recoverClaim(taskId: string, claimId: string, action: RecoveryAction): Promise<RecoveryResult>;
  assertOwner(taskId: string, claimId: string): Promise<ActiveClaim>;
  getClaimHistory(taskId: string, claimId: string): Promise<ClaimHistory>;
  latestClaimHistory(taskId: string): Promise<ClaimHistory>;
  latestHandoffHistory(taskId: string): Promise<ClaimHistory>;
  getActive(taskId: string): Promise<ActiveClaim | undefined>;
}

export interface WorktreeManagerPort {
  assertStartReady(
    taskId: string,
    taskAlias: string,
    retained?: Pick<ActiveClaim, "claim_id" | "worktree_ref"> & {
      disposition: "active" | "handoff" | "force-ended" | "create-failed";
    },
  ): Promise<void>;
  createOrReuse(claim: ActiveClaim, repositoryPath: string): Promise<WorktreeCreateResult>;
  inspect(claim: ActiveClaim): Promise<WorktreeInspection>;
  removeIfSafe(claim: ActiveClaim): Promise<WorktreeRemovalResult>;
  assertForceEndEligible(previous: ActiveClaim): Promise<void>;
  assertTakeoverEligible(previous: ActiveClaim): Promise<void>;
  rebindTakeover(previous: ClaimHistory, successor: ActiveClaim): Promise<{ changed: boolean }>;
  cleanupReleased(history: ClaimHistory): Promise<WorktreeRemovalResult>;
}

export interface RegistryGitPort {
  transact(message: string, mutate: () => Promise<RegistryMutationResult>): Promise<RegistryTransactionResult>;
  assertHeadRegularFile(relativePath: string): Promise<void>;
  readHeadRegularBlob(relativePath: string): Promise<Buffer>;
  listHeadDirectoryEntries(relativeDirectory: string, maximumEntries: number): Promise<RegistryDirectoryEntry[]>;
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
  worktree: Omit<WorktreeInspection, "path" | "repository_path">;
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

export interface TaskHandoffResult {
  handoff_pointer: string;
  task_id: string;
  claim_id: string;
  source_task_revision: string;
  generated_at: string;
  sections: ReturnType<typeof parseHandoffSections>;
}

export interface TaskRecoverInput {
  task_id: string;
  claim_id: string;
  action: RecoveryAction | { kind: "cleanup" };
}

export interface TaskCleanupRecoveryResult {
  kind: "cleanup";
  history: ClaimHistory;
  worktree: WorktreeRemovalResult;
}

export type TaskRecoveryResult = RecoveryResult | TaskCleanupRecoveryResult;

export interface TaskServiceHooks {
  afterClaim?: (claim: ActiveClaim) => void | Promise<void>;
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
  if (
    !Array.isArray(validation) ||
    validation.length === 0 ||
    validation.length > 64 ||
    validation.some((line) =>
      typeof line !== "string" || !line.trim() || Buffer.byteLength(line, "utf8") > 512)
  ) {
    throw new ControlError("INVALID_FINISH_OUTCOME", "Task finish validation is missing or exceeds its bounded schema");
  }
}

function assertFinishInput(input: TaskFinishInput): void {
  assertValidation(input.validation);
  if (input.outcome !== undefined && (!input.outcome.trim() || Buffer.byteLength(input.outcome, "utf8") > 4096)) {
    throw new ControlError("INVALID_FINISH_OUTCOME", "Task finish outcome is empty or exceeds its bounded schema");
  }
  if (input.status === "completed" && input.outcome === undefined) {
    throw new ControlError("INVALID_FINISH_OUTCOME", "Completed Task finish requires an outcome");
  }
  if (
    input.status !== "handoff" &&
    [input.source_task_revision, input.progress, input.failures, input.next_step, input.related_adr_and_evidence]
      .some((value) => value !== undefined)
  ) {
    throw new ControlError("INVALID_FINISH_OUTCOME", "Only Handoff finish accepts Handoff content fields");
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

function assertUniqueDirtyFiles(inspection: WorktreeInspection): void {
  if (new Set(inspection.dirty_files).size !== inspection.dirty_files.length) {
    throw new ControlError(
      "INVALID_WORKTREE_INSPECTION",
      "Worktree inspection contains duplicate dirty-file entries",
      { reason: "duplicate_dirty_files" },
    );
  }
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
  private readonly records: RegistryRecordStore;
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(
    private readonly config: ControlConfig,
    private readonly claims: ClaimServicePort,
    private readonly worktrees: WorktreeManagerPort,
    private readonly registry: RegistryGitPort,
    private readonly now: () => Date = () => new Date(),
    sensitiveData?: SensitiveDataPolicy,
    private readonly hooks: TaskServiceHooks = {},
  ) {
    this.records = new RegistryRecordStore(config.registryDir, registry);
    this.sensitiveData = sensitiveData ?? createSensitiveDataPolicy(process.env, [
      config.registryDir,
      config.stateDir,
      config.worktreeRoot,
    ]);
  }

  async start(input: TaskStartInput): Promise<TaskStartResult> {
    const { repository_path: _repositoryPath, ...content } = input;
    this.sensitiveData.assertSafe(content);
    createSensitiveDataPolicy(process.env, [input.repository_path]).assertSafe(content);
    const currentActive = await this.claims.getActive(input.task_id);
    let latestHistory: ClaimHistory | undefined;
    try {
      latestHistory = await this.claims.latestClaimHistory(input.task_id);
    } catch (cause) {
      if (!(cause instanceof ControlError && cause.code === "CLAIM_HISTORY_NOT_FOUND")) throw cause;
    }
    const reusableHistory = latestHistory?.task_alias && (
      latestHistory.status === "handoff" ||
      latestHistory.status === "force-ended" ||
      (latestHistory.status === "abandoned" && latestHistory.outcome === "worktree_create_failed")
    ) ? latestHistory : undefined;
    const taskAlias = currentActive?.task_alias ?? reusableHistory?.task_alias ?? input.task_alias;
    const plan = worktreePlan(input.task_id, taskAlias);
    if (reusableHistory && (
      reusableHistory.task_id !== input.task_id ||
      reusableHistory.project_id !== input.project_id ||
      reusableHistory.repo_id !== input.repo_id ||
      reusableHistory.branch !== plan.branch ||
      reusableHistory.worktree_ref !== plan.worktree_ref
    )) {
      throw new ControlError("REGISTRY_CORRUPT", "Released Claim history has inconsistent Task coordinates");
    }
    if (currentActive && (
      currentActive.task_id !== input.task_id ||
      currentActive.project_id !== input.project_id ||
      currentActive.repo_id !== input.repo_id ||
      currentActive.host !== this.config.buildHost ||
      currentActive.branch !== plan.branch ||
      currentActive.worktree_ref !== plan.worktree_ref
    )) {
      throw new ControlError("REGISTRY_CORRUPT", "Active Claim has inconsistent Task/worktree coordinates");
    }
    if (currentActive?.predecessor_claim_id && currentActive.predecessor_claim_id !== reusableHistory?.claim_id) {
      throw new ControlError("REGISTRY_CORRUPT", "Active Claim predecessor is not the exact latest reusable release");
    }
    const retained = currentActive?.predecessor_claim_id && reusableHistory
      ? {
          claim_id: reusableHistory.claim_id,
          successor_claim_id: currentActive.claim_id,
          worktree_ref: reusableHistory.worktree_ref,
          disposition: reusableHistory.status === "handoff"
            ? "handoff" as const
            : reusableHistory.status === "force-ended"
              ? "force-ended" as const
              : "create-failed" as const,
        }
      : currentActive
        ? { claim_id: currentActive.claim_id, worktree_ref: currentActive.worktree_ref, disposition: "active" as const }
      : reusableHistory
        ? {
            claim_id: reusableHistory.claim_id,
            worktree_ref: reusableHistory.worktree_ref,
            disposition: reusableHistory.status === "handoff"
              ? "handoff" as const
              : reusableHistory.status === "force-ended"
                ? "force-ended" as const
                : "create-failed" as const,
          }
        : undefined;
    await this.worktrees.assertStartReady(
      input.task_id,
      taskAlias,
      retained,
    );
    const reusingCurrentClaim = currentActive?.session_id === input.session_id;
    const claim = reusingCurrentClaim
      ? currentActive
      : await this.claims.claimTask({
          task_id: input.task_id,
          task_alias: taskAlias,
          project_id: input.project_id,
          repo_id: input.repo_id,
          session_id: input.session_id,
          host: this.config.buildHost,
          branch: plan.branch,
          worktree_ref: plan.worktree_ref,
        });
    await this.hooks.afterClaim?.(claim);

    let created: WorktreeCreateResult;
    try {
      created = await this.worktrees.createOrReuse(claim, input.repository_path);
    } catch (cause) {
      // Do not leave an uncontended Claim after local allocation failed. If the
      // best-effort release fails, the caller must receive its retained Claim
      // coordinates without leaking the host-local allocation failure details.
      let claimState: "active" | "released" = "active";
      if (!reusingCurrentClaim) {
        await this.claims.finishClaim(claim.task_id, claim.claim_id, {
          status: "abandoned",
          outcome: "worktree_create_failed",
          branch: claim.branch,
          head_sha: "unavailable",
          validation: [worktreeCreateValidation(cause)],
        }).then(() => {
          claimState = "released";
        }).catch(() => undefined);
      }
      if (cause instanceof ControlError) {
        throw new ControlError(cause.code, "Worktree allocation failed", {
          task_id: claim.task_id,
          claim_id: claim.claim_id,
          claim_state: claimState,
        });
      }
      throw new ControlError("TASK_START_FAILED", "Worktree allocation failed", {
        task_id: claim.task_id,
        claim_id: claim.claim_id,
        claim_state: claimState,
      });
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
    const { path: _path, repository_path: _repositoryPath, ...worktree } = inspection;
    const result = { active, worktree };
    this.sensitiveData.assertSafe(result);
    return result;
  }

  async handoff(taskId: string, claimId?: string): Promise<TaskHandoffResult> {
    const history = claimId === undefined
      ? await this.claims.latestHandoffHistory(taskId)
      : await this.claims.getClaimHistory(taskId, claimId);
    if (history.status !== "handoff" || !history.handoff_path || !history.source_task_revision) {
      throw new ControlError("HANDOFF_NOT_FOUND", "Released Claim does not contain canonical Handoff evidence");
    }
    const expectedPath = canonicalHandoffPath(history.task_id, history.claim_id);
    if (history.task_id !== taskId || (claimId !== undefined && history.claim_id !== claimId) || history.handoff_path !== expectedPath) {
      throw new ControlError("REGISTRY_CORRUPT", "Claim history and Handoff coordinates disagree");
    }
    await this.records.assertCommittedRegularFile(expectedPath);
    const content = await this.registry.readHeadRegularFile(expectedPath);
    if (Buffer.byteLength(content, "utf8") > MAX_HANDOFF_BYTES) {
      throw new ControlError("REGISTRY_CORRUPT", "Committed Handoff exceeds its byte boundary");
    }
    const metadata = assertValidHandoff(content);
    if (
      metadata.task_id !== history.task_id ||
      metadata.claim_id !== history.claim_id ||
      metadata.source_task_revision !== history.source_task_revision
    ) {
      throw new ControlError("REGISTRY_CORRUPT", "Committed Handoff metadata disagrees with Claim history");
    }
    const result = {
      handoff_pointer: expectedPath,
      task_id: metadata.task_id,
      claim_id: metadata.claim_id,
      source_task_revision: metadata.source_task_revision,
      generated_at: metadata.generated_at,
      sections: parseHandoffSections(content),
    };
    this.sensitiveData.assertSafe(result);
    return result;
  }

  async finish(input: TaskFinishInput): Promise<TaskFinishResult> {
    this.sensitiveData.assertSafe(input);
    assertFinishInput(input);
    const active = await this.assertOwner(input.task_id, input.claim_id);
    const inspection = await this.worktrees.inspect(active);
    if (typeof inspection.repository_path !== "string") {
      throw new ControlError("WORKTREE_MAPPING_MISMATCH", "Worktree inspection lacks its trusted Repository root");
    }
    createSensitiveDataPolicy({}, [inspection.repository_path]).assertSafe(input);
    // Inspection is a port boundary. Duplicate entries turn the dirty digest
    // into multiset evidence and can make the two-candidate retry check
    // ambiguous, so reject them before either initial generation or retry.
    assertUniqueDirtyFiles(inspection);
    let handoffPath: string | undefined;
    let evidenceGitState: HandoffGitState | undefined;

    if (input.status === "handoff") {
      handoffPath = canonicalHandoffPath(active.task_id, active.claim_id);
      if (input.source_task_revision !== undefined && input.source_task_revision !== active.source_task_revision) {
        throw new ControlError("SOURCE_REVISION_MISMATCH", "Caller source revision disagrees with the active Claim");
      }
      const revision = active.source_task_revision;
      const committed = await this.committedHandoff(handoffPath);
      let handoff: string;
      if (committed) {
        const metadata = assertValidHandoff(committed);
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

      await writeWorktreeHandoff(inspection.path, handoff, this.sensitiveData);
      // This transaction must complete (including push verification) before the
      // Claim release transaction; a failed release intentionally leaves this copy.
      await this.registry.transact(`registry: handoff ${active.claim_id}`, async () => {
        const result = await writeRegistryHandoff(
          this.records, active.task_id, active.claim_id, handoff, committed, this.sensitiveData,
        );
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
      return { history, worktree_removed: false, cleanup_error: "WORKTREE_CLEANUP_FAILED" };
    }
  }

  async recover(input: TaskRecoverInput): Promise<TaskRecoveryResult> {
    this.sensitiveData.assertSafe(input);
    if (input.action.kind === "cleanup") {
      const history = await this.claims.getClaimHistory(input.task_id, input.claim_id);
      const active = await this.claims.getActive(input.task_id);
      if (active) {
        throw new ControlError(
          "WORKTREE_ACTIVE_SUCCESSOR",
          "Refusing archived cleanup while the Task has an active Claim generation",
          { task_id: input.task_id, active_claim_id: active.claim_id },
        );
      }
      return { kind: "cleanup", history, worktree: await this.worktrees.cleanupReleased(history) };
    }
    if (input.action.kind === "force-end") {
      const previous = await this.claims.assertOwner(input.task_id, input.claim_id);
      await this.worktrees.assertForceEndEligible(previous);
      return this.claims.recoverClaim(input.task_id, input.claim_id, input.action);
    }
    if (input.action.kind !== "takeover") {
      return this.claims.recoverClaim(input.task_id, input.claim_id, input.action);
    }

    let previous: ActiveClaim | undefined;
    try {
      previous = await this.claims.assertOwner(input.task_id, input.claim_id);
    } catch (cause) {
      if (!(cause instanceof ControlError && cause.code === "CLAIM_MISMATCH")) throw cause;
      // The only permitted reconciliation path is ClaimService's exact,
      // remotely authoritative old->direct-successor retry below.
    }
    if (previous) await this.worktrees.assertTakeoverEligible(previous);

    const recovered = await this.claims.recoverClaim(input.task_id, input.claim_id, input.action);
    if (recovered.kind !== "takeover") {
      throw new ControlError("INVALID_RECOVERY_RESULT", "Takeover recovery did not return a successor Claim");
    }
    await this.worktrees.rebindTakeover(recovered.history, recovered.active);
    return recovered;
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
      source_task_revision: active.source_task_revision,
      claim_id: active.claim_id,
      generated_at: generatedAt,
      progress: input.progress,
      git_state: gitState,
      validation: input.validation,
      failures: input.failures,
      next_step: input.next_step,
      related_adr_and_evidence: input.related_adr_and_evidence,
    }, this.sensitiveData);
  }

  private async committedHandoff(relativePath: string): Promise<string | undefined> {
    try {
      await this.records.assertCommittedRegularFile(relativePath);
      return await this.registry.readHeadRegularFile(relativePath);
    } catch (cause) {
      if (cause instanceof ControlError && cause.code === "HANDOFF_MISSING") return undefined;
      throw cause;
    }
  }
}
