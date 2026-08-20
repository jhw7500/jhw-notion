import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ActiveClaimSchema, ClaimHistorySchema, type ActiveClaim, type ClaimHistory } from "./schemas.js";
import { LOCAL_HANDOFF_DIRECTORY, LOCAL_HANDOFF_RELATIVE_PATH } from "./handoff.js";
import { openSecureStateDirectory, type SecureStateDirectory } from "./journal.js";
import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { ProcessRunner, type ProcessResult, type ProcessRunOptions } from "./process.js";

const STATE_VERSION = 2;
const WORKTREE_STATE_FILE = "worktrees.json";
const stateReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const stateCreateFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
// Removal tolerates exactly the tool's own local handoff copy: its durable
// copy lives in the Registry, so it is not evidence worth blocking on, while
// any other residue keeps the fail-stop. The tolerance is limited to the
// untracked status entry — a tracked `.ai/handoff.md`, or tracked changes to
// it, are repository content and keep blocking like any other file.
//
// This is deliberately stricter than the retry-evidence tolerance in
// `task-service.ts`, which excuses the same artifact by path alone. That one
// only decides whether two inspections describe the same worktree; this one
// decides whether to delete a file. Only one of them can lose an operator's
// work, so only one insists the file be untracked. Do not harmonize them.
const EXPECTED_LOCAL_HANDOFF_ENTRY = `?? ${LOCAL_HANDOFF_RELATIVE_PATH}`;

function removalBlockingEntries(statusEntries: readonly string[]): string[] {
  const index = statusEntries.indexOf(EXPECTED_LOCAL_HANDOFF_ENTRY);
  if (index < 0) return [...statusEntries];
  return statusEntries.filter((_, current) => current !== index);
}
const canonicalTaskId = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalClaimId = /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalProjectId = /^prj-[a-z0-9][a-z0-9-]{1,62}$/;
const canonicalRepositoryId = /^repo-[a-z0-9][a-z0-9-]{1,62}$/;
const canonicalGitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const logicalRef = /^wt-[a-z0-9][a-z0-9-]{1,120}$/;

export type WorktreeLifecycle = "pending-create" | "active" | "pending-remove" | "removed";

export interface WorktreePlan {
  branch: string;
  worktree_ref: string;
}

export interface WorktreeCreateResult {
  path: string;
  branch: string;
  worktree_ref: string;
  reused: boolean;
}

interface FullWorktreeInspection {
  inspection: WorktreeInspection;
  // Raw porcelain entries (`XY path`) so removal tolerance can distinguish
  // the untracked tool copy from tracked changes to the same path. Kept off
  // the public inspection shape so status payloads are unchanged.
  status_entries: string[];
}

export interface WorktreeInspection {
  /** Host-local absolute path. Never persist this in a Claim or Registry record. */
  path: string;
  /** Trusted source checkout root. Never return it through the public CLI. */
  repository_path: string;
  branch: string;
  worktree_ref: string;
  head_sha: string;
  dirty: boolean;
  dirty_files: string[];
  ahead: number;
  behind: number;
}

export interface WorktreeRemovalResult {
  removed: boolean;
  /** True when this invocation completed a prior durable pending-remove intent. */
  recovered: boolean;
  lifecycle: "removed";
}

/** A non-destructive view used by a future CLI to guide pending recovery. */
export interface WorktreeRecoveryStatus {
  worktree_ref: string;
  claim_id: string;
  lifecycle: WorktreeLifecycle;
  path_exists: boolean;
}

export type RetainedWorktreeDisposition = "active" | "handoff" | "force-ended" | "create-failed";

export interface RetainedWorktreeGeneration {
  claim_id: string;
  worktree_ref: string;
  disposition: RetainedWorktreeDisposition;
  successor_claim_id?: string;
  linked_predecessors?: ReadonlyArray<{
    claim_id: string;
    disposition: Exclude<RetainedWorktreeDisposition, "active">;
  }>;
}

export interface WorktreeRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}

/** Test-only fault boundaries for durable state failure-window coverage. */
export interface WorktreeStateHooks {
  beforeSave?: () => void | Promise<void>;
  afterPublish?: (statePath: string) => void | Promise<void>;
  syncPublishedFile?: (file: FileHandle) => void | Promise<void>;
  syncStateDirectory?: (directory: SecureStateDirectory) => void | Promise<void>;
  afterSave?: () => void | Promise<void>;
}

type WorktreeClaim = Pick<
  ActiveClaim,
  "task_id" | "task_alias" | "project_id" | "repo_id" | "claim_id" | "session_id" | "host" | "branch" | "worktree_ref"
>;

export interface WorktreeTakeoverRebindResult {
  changed: boolean;
}

interface WorktreeMapping {
  task_id: string;
  project_id: string;
  repo_id: string;
  claim_id: string;
  session_id: string;
  host: string;
  branch: string;
  repository_path: string;
  repository_identity: string;
  path: string;
  base_sha: string;
  lifecycle: WorktreeLifecycle;
}

interface WorktreeState {
  version: 2;
  worktrees: Record<string, WorktreeMapping>;
}

interface RepositoryInfo {
  root: string;
  identity: string;
  head: string;
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function safeAlias(alias: string): string {
  const sanitized = alias
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return sanitized || "task";
}

function taskSuffix(taskId: string): string {
  if (!canonicalTaskId.test(taskId)) {
    throw new ControlError("INVALID_TASK_ID", "Worktree planning requires a canonical Task ID", { task_id: taskId });
  }
  return taskId.slice(-12);
}

/** Derives deterministic, filesystem-safe logical coordinates from the canonical Task. */
export function worktreePlan(taskId: string, alias: string): WorktreePlan {
  const suffix = taskSuffix(taskId);
  const name = `${suffix}-${safeAlias(alias)}`;
  return { branch: `task/${name}`, worktree_ref: `wt-${name}` };
}

function validateClaim(claim: WorktreeClaim): WorktreePlan {
  if (!canonicalClaimId.test(claim.claim_id)) {
    throw new ControlError("INVALID_CLAIM_ID", "Worktree operation requires a canonical Claim ID", {
      claim_id: claim.claim_id,
    });
  }
  const plan = worktreePlan(claim.task_id, claim.task_alias);
  if (claim.branch !== plan.branch || claim.worktree_ref !== plan.worktree_ref || !logicalRef.test(claim.worktree_ref)) {
    throw new ControlError("WORKTREE_PLAN_MISMATCH", "Claim worktree coordinates do not match the canonical Task plan", {
      task_id: claim.task_id,
      branch: claim.branch,
      worktree_ref: claim.worktree_ref,
      expected_branch: plan.branch,
      expected_worktree_ref: plan.worktree_ref,
    });
  }
  return plan;
}

function isLifecycle(value: unknown): value is WorktreeLifecycle {
  return value === "pending-create" || value === "active" || value === "pending-remove" || value === "removed";
}

function asMapping(value: unknown, ref: string): WorktreeMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree mapping is not an object", { worktree_ref: ref });
  }
  const record = value as Record<string, unknown>;
  const required = [
    "task_id",
    "project_id",
    "repo_id",
    "claim_id",
    "session_id",
    "host",
    "branch",
    "repository_path",
    "repository_identity",
    "path",
    "base_sha",
    "lifecycle",
  ];
  if (
    Object.keys(record).length !== required.length ||
    required.some((key) => !(key in record)) ||
    required.slice(0, -1).some((key) => typeof record[key] !== "string") ||
    !isLifecycle(record.lifecycle)
  ) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree mapping has invalid fields", { worktree_ref: ref });
  }
  if (
    !canonicalTaskId.test(record.task_id as string) ||
    !canonicalProjectId.test(record.project_id as string) ||
    !canonicalRepositoryId.test(record.repo_id as string) ||
    !canonicalClaimId.test(record.claim_id as string) ||
    !(record.session_id as string).trim() ||
    !(record.host as string).trim() ||
    !(record.branch as string).trim() ||
    !isAbsolute(record.repository_path as string) ||
    !isAbsolute(record.repository_identity as string) ||
    !isAbsolute(record.path as string)
  ) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree mapping must contain absolute host-local paths", {
      worktree_ref: ref,
    });
  }
  if (!canonicalGitObjectId.test(record.base_sha as string)) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree mapping contains an invalid base Git object ID", {
      worktree_ref: ref,
    });
  }
  return record as unknown as WorktreeMapping;
}

function parseState(value: unknown): WorktreeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree state is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== STATE_VERSION || !record.worktrees || typeof record.worktrees !== "object" || Array.isArray(record.worktrees)) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree state has an unsupported schema");
  }
  const worktrees: Record<string, WorktreeMapping> = {};
  for (const [ref, mapping] of Object.entries(record.worktrees as Record<string, unknown>)) {
    if (!logicalRef.test(ref)) {
      throw new ControlError("INVALID_WORKTREE_STATE", "Worktree state contains an unsafe logical ref", { worktree_ref: ref });
    }
    worktrees[ref] = asMapping(mapping, ref);
  }
  return { version: STATE_VERSION, worktrees };
}

function parseCount(value: string, code: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ControlError(code, "Git returned an invalid commit count", { value });
  }
  return parsed;
}

function parseAheadBehind(value: string): { behind: number; ahead: number } {
  const pieces = value.trim().split(/\s+/);
  if (pieces.length !== 2) {
    throw new ControlError("INVALID_GIT_STATE", "Git returned invalid ahead/behind counts", { value });
  }
  return { behind: parseCount(pieces[0], "INVALID_GIT_STATE"), ahead: parseCount(pieces[1], "INVALID_GIT_STATE") };
}

/** Host-local worktree lifecycle; it intentionally never calls ClaimService. */
export class WorktreeManager {
  constructor(
    private readonly config: ControlConfig,
    private readonly runner: WorktreeRunner = new ProcessRunner(),
    private readonly stateHooks: WorktreeStateHooks = {},
  ) {}

  async createOrReuse(claim: WorktreeClaim, repositoryPath: string): Promise<WorktreeCreateResult> {
    validateClaim(claim);
    this.assertLocalHost(claim);
    const repository = await this.repositoryInfo(repositoryPath);
    const state = await this.loadState();
    const root = await this.worktreeRoot();
    let mapping = state.worktrees[claim.worktree_ref];

    if (mapping) {
      this.assertCoordinates(mapping, claim, repository.identity, root);
      if (mapping.lifecycle === "pending-remove") {
        throw new ControlError(
          "WORKTREE_CLEANUP_REQUIRED",
          "A released worktree generation requires explicit cleanup recovery before Task start",
          { task_id: claim.task_id, worktree_ref: claim.worktree_ref },
        );
      }
      if (mapping.lifecycle === "active") {
        await this.verifyWorktree(mapping.path, claim.branch, repository.identity, root);
        this.adoptClaim(mapping, claim, repository);
        await this.saveState(state);
        return this.created(mapping, true);
      }
      if (mapping.lifecycle === "pending-create" && await this.mappedWorktreeExists(mapping.path, root)) {
        await this.verifyWorktree(mapping.path, claim.branch, repository.identity, root);
        this.adoptClaim(mapping, claim, repository);
        mapping.lifecycle = "active";
        await this.saveState(state);
        return this.created(mapping, true);
      }
    }

    mapping = this.pendingCreateMapping(claim, repository, root);
    state.worktrees[claim.worktree_ref] = mapping;
    // Persist this intent before Git can create any filesystem artifact.
    await this.saveState(state);
    const addArguments = await this.branchExists(repository.root, claim.branch)
      ? ["-C", repository.root, "worktree", "add", mapping.path, claim.branch]
      : ["-C", repository.root, "worktree", "add", "-b", claim.branch, mapping.path, "HEAD"];
    await this.git(addArguments);
    await this.verifyWorktree(mapping.path, mapping.branch, mapping.repository_identity, root);
    mapping.lifecycle = "active";
    // A failure here leaves the durable pending-create record for recovery.
    await this.saveState(state);
    return this.created(mapping, false);
  }

  /**
   * Non-mutating pre-Claim barrier. A pending destructive intent must be
   * reconciled through its archived Claim generation, never by a successor.
   */
  async assertStartReady(
    taskId: string,
    taskAlias: string,
    retained?: RetainedWorktreeGeneration,
  ): Promise<void> {
    const plan = worktreePlan(taskId, taskAlias);
    const state = await this.loadState();
    const root = await this.worktreeRoot();
    const planned = state.worktrees[plan.worktree_ref];
    if (planned?.task_id !== undefined && planned.task_id !== taskId) {
      throw new ControlError("WORKTREE_MAPPING_MISMATCH", "Task worktree reference belongs to another Task", {
        task_id: taskId,
        worktree_ref: plan.worktree_ref,
      });
    }
    for (const [ref, mapping] of Object.entries(state.worktrees)) {
      if (mapping.task_id === taskId && mapping.lifecycle === "removed" && await this.mappedWorktreeExists(mapping.path, root)) {
        throw new ControlError("WORKTREE_LIFECYCLE_MISMATCH", "Removed worktree tombstone still has a checkout", {
          worktree_ref: ref,
        });
      }
    }
    const candidates = Object.entries(state.worktrees).filter(([, mapping]) =>
      mapping.task_id === taskId && mapping.lifecycle !== "removed");
    if (candidates.length > 1) {
      throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Task has more than one unreconciled worktree generation", {
        task_id: taskId,
        worktree_refs: candidates.map(([ref]) => ref).sort(),
      });
    }
    const [entry] = candidates;
    if (!entry) return;
    const [worktreeRef, mapping] = entry;
    const matchedDisposition = retained?.claim_id === mapping.claim_id
      ? retained.disposition
      : retained?.successor_claim_id === mapping.claim_id
        ? "active"
        : retained?.linked_predecessors?.find((generation) => generation.claim_id === mapping.claim_id)?.disposition;
    const retainedMatches = retained !== undefined && matchedDisposition !== undefined &&
      retained.worktree_ref === worktreeRef &&
      plan.worktree_ref === worktreeRef;
    const lifecycleAllowed = matchedDisposition === "active" || matchedDisposition === "create-failed"
      ? mapping.lifecycle === "active" || mapping.lifecycle === "pending-create"
      : matchedDisposition === "handoff" || matchedDisposition === "force-ended"
        ? mapping.lifecycle === "active"
        : false;
    if (mapping.lifecycle === "pending-create" && !(retainedMatches && lifecycleAllowed)) {
      throw new ControlError("WORKTREE_CREATE_PENDING", "Worktree creation requires recovery before Task start", {
        task_id: taskId,
        worktree_ref: worktreeRef,
      });
    }
    if (
      mapping.lifecycle === "active" &&
      retainedMatches && lifecycleAllowed
    ) return;
    if (mapping.lifecycle === "pending-create" && retainedMatches && lifecycleAllowed) return;
    if (mapping.lifecycle === "active" || mapping.lifecycle === "pending-remove") {
      throw new ControlError(
        "WORKTREE_CLEANUP_REQUIRED",
        "A released worktree generation requires explicit cleanup recovery before Task start",
        { task_id: taskId, worktree_ref: worktreeRef },
      );
    }
  }

  /** Clean up exactly one committed, released Claim generation. */
  async cleanupReleased(rawHistory: ClaimHistory): Promise<WorktreeRemovalResult> {
    const result = ClaimHistorySchema.safeParse(rawHistory);
    if (!result.success || !result.data.task_alias) {
      throw new ControlError("INVALID_CLAIM_HISTORY", "Cleanup requires canonical released Claim history");
    }
    const history = result.data as ClaimHistory & { task_alias: string };
    if (!new Set(["completed", "abandoned", "force-ended"]).has(history.status)) {
      throw new ControlError("WORKTREE_CLEANUP_NOT_ALLOWED", "This released Claim status does not permit worktree cleanup", {
        task_id: history.task_id,
        claim_id: history.claim_id,
        status: history.status,
      });
    }
    validateClaim(history);
    this.assertLocalHost(history);
    const state = await this.loadState();
    const root = await this.worktreeRoot();
    const mapping = state.worktrees[history.worktree_ref];
    if (!mapping) {
      throw new ControlError("WORKTREE_NOT_MAPPED", "Released Claim has no host-local worktree mapping", {
        worktree_ref: history.worktree_ref,
      });
    }
    if (mapping.claim_id !== history.claim_id) {
      throw new ControlError("WORKTREE_CLAIM_MISMATCH", "Worktree cleanup belongs to a different Claim generation", {
        worktree_ref: history.worktree_ref,
      });
    }
    this.assertCoordinates(mapping, history, mapping.repository_identity, root);
    if (mapping.lifecycle === "removed") {
      if (await this.mappedWorktreeExists(mapping.path, root)) {
        throw new ControlError("WORKTREE_LIFECYCLE_MISMATCH", "Removed worktree tombstone still has a checkout", {
          worktree_ref: history.worktree_ref,
        });
      }
      return { removed: true, recovered: true, lifecycle: "removed" };
    }
    if (mapping.lifecycle === "pending-create") {
      throw new ControlError("WORKTREE_CREATE_PENDING", "Worktree creation requires recovery before cleanup", {
        worktree_ref: history.worktree_ref,
      });
    }
    return this.removeIfSafe(history);
  }

  async inspect(claim: WorktreeClaim): Promise<WorktreeInspection> {
    return (await this.inspectClaimFull(claim)).inspection;
  }

  private async inspectClaimFull(claim: WorktreeClaim): Promise<FullWorktreeInspection> {
    validateClaim(claim);
    this.assertLocalHost(claim);
    const state = await this.loadState();
    const root = await this.worktreeRoot();
    const mapping = state.worktrees[claim.worktree_ref];
    if (!mapping) {
      throw new ControlError("WORKTREE_NOT_MAPPED", "Claim has no host-local worktree mapping", {
        task_id: claim.task_id,
        claim_id: claim.claim_id,
        worktree_ref: claim.worktree_ref,
      });
    }
    if (mapping.lifecycle === "pending-create") {
      throw new ControlError("WORKTREE_CREATE_PENDING", "Worktree creation requires recovery before inspection", { worktree_ref: claim.worktree_ref });
    }
    if (mapping.lifecycle === "pending-remove") {
      throw new ControlError("WORKTREE_REMOVE_PENDING", "Worktree removal requires recovery before inspection", { worktree_ref: claim.worktree_ref });
    }
    if (mapping.lifecycle === "removed") {
      throw new ControlError("WORKTREE_REMOVED", "Worktree has a durable removal tombstone", { worktree_ref: claim.worktree_ref });
    }
    const repository = await this.repositoryInfo(mapping.repository_path);
    this.assertExactGeneration(mapping, claim, repository.identity, root, "active");
    return this.inspectMappedFull(mapping, claim, root);
  }

  async assertTakeoverEligible(previous: ActiveClaim): Promise<void> {
    const parsed = ActiveClaimSchema.safeParse(previous);
    if (!parsed.success) {
      throw new ControlError("INVALID_CLAIM", "Takeover predecessor is not a canonical active Claim");
    }
    validateClaim(parsed.data);
    this.assertLocalHost(parsed.data);
    const state = await this.loadState();
    const root = await this.worktreeRoot();
    const mapping = await this.uniqueTakeoverMapping(state, parsed.data, root);
    const repository = await this.repositoryInfo(mapping.repository_path);
    this.assertTakeoverMapping(mapping, parsed.data, repository, root, "active");
    await this.verifyWorktree(mapping.path, parsed.data.branch, repository.identity, root);
  }

  async assertForceEndEligible(previous: ActiveClaim): Promise<void> {
    const status = await this.recoveryStatus(previous);
    if (status.lifecycle === "active") return;
    if (status.lifecycle === "pending-create") {
      throw new ControlError("WORKTREE_CREATE_PENDING", "Worktree creation must be reconciled before force-end");
    }
    if (status.lifecycle === "pending-remove") {
      throw new ControlError("WORKTREE_REMOVE_PENDING", "Worktree removal must be reconciled before force-end");
    }
    throw new ControlError("WORKTREE_REMOVED", "Removed worktree generation cannot be force-ended");
  }

  async rebindTakeover(previous: ClaimHistory, successor: ActiveClaim): Promise<WorktreeTakeoverRebindResult> {
    const predecessorResult = ClaimHistorySchema.safeParse(previous);
    if (!predecessorResult.success || predecessorResult.data.status !== "taken-over") {
      throw new ControlError("WORKTREE_CLAIM_MISMATCH", "Takeover rebind requires canonical taken-over history");
    }
    const successorResult = ActiveClaimSchema.safeParse(successor);
    if (!successorResult.success) {
      throw new ControlError("INVALID_CLAIM", "Takeover successor is not a canonical active Claim");
    }
    if (!predecessorResult.data.task_alias) {
      throw new ControlError("WORKTREE_MAPPING_MISMATCH", "Takeover predecessor lacks its canonical Task alias");
    }
    const predecessor = {
      ...predecessorResult.data,
      task_alias: predecessorResult.data.task_alias,
    };
    const next = successorResult.data;
    validateClaim(predecessor);
    validateClaim(next);
    this.assertLocalHost(predecessor);
    this.assertLocalHost(next);
    if (predecessor.claim_id === next.claim_id || predecessor.successor_claim_id !== next.claim_id) {
      throw new ControlError("WORKTREE_CLAIM_MISMATCH", "Takeover history does not directly identify the successor", {
        worktree_ref: predecessor.worktree_ref,
      });
    }
    this.assertTakeoverCoordinatesMatch(predecessor, next);

    const state = await this.loadState();
    const root = await this.worktreeRoot();
    const mapping = await this.uniqueTakeoverMapping(state, predecessor, root);
    const repository = await this.repositoryInfo(mapping.repository_path);
    const alreadyBound = mapping.claim_id === next.claim_id && mapping.session_id === next.session_id;
    if (alreadyBound) {
      this.assertTakeoverMapping(mapping, next, repository, root, "active");
      await this.verifyWorktree(mapping.path, next.branch, repository.identity, root);
      return { changed: false };
    }
    this.assertTakeoverMapping(mapping, predecessor, repository, root, "active");
    await this.verifyWorktree(mapping.path, predecessor.branch, repository.identity, root);
    mapping.claim_id = next.claim_id;
    mapping.session_id = next.session_id;
    await this.saveState(state);

    const verifiedState = await this.loadState();
    const verified = await this.uniqueTakeoverMapping(verifiedState, next, root);
    const verifiedRepository = await this.repositoryInfo(verified.repository_path);
    this.assertTakeoverMapping(verified, next, verifiedRepository, root, "active");
    await this.verifyWorktree(verified.path, next.branch, verifiedRepository.identity, root);
    return { changed: true };
  }

  async removeIfSafe(claim: WorktreeClaim): Promise<WorktreeRemovalResult> {
    validateClaim(claim);
    this.assertLocalHost(claim);
    const firstState = await this.loadState();
    const root = await this.worktreeRoot();
    const first = firstState.worktrees[claim.worktree_ref];
    if (first?.lifecycle === "pending-remove") {
      return this.resumePendingRemove(claim, root, true);
    }

    const { inspection, status_entries } = await this.inspectClaimFull(claim);
    if (removalBlockingEntries(status_entries).length > 0) {
      throw new ControlError("WORKTREE_DIRTY", "Refusing to remove a dirty worktree", {
        worktree_ref: inspection.worktree_ref,
        dirty_files: inspection.dirty_files,
      });
    }
    if (inspection.ahead > 0 && !await this.isIntegrated(inspection.repository_path, inspection.head_sha)) {
      throw new ControlError("WORKTREE_UNPUSHED", "Refusing to remove a worktree with unintegrated commits", {
        worktree_ref: inspection.worktree_ref,
        ahead: inspection.ahead,
      });
    }

    const state = await this.loadState();
    const mapping = state.worktrees[claim.worktree_ref];
    if (!mapping) throw new ControlError("WORKTREE_NOT_MAPPED", "Claim has no host-local worktree mapping", { worktree_ref: claim.worktree_ref });
    const repository = await this.repositoryInfo(mapping.repository_path);
    this.assertExactGeneration(mapping, claim, repository.identity, root, "active");
    mapping.lifecycle = "pending-remove";
    // Persist the destructive intent before invoking Git.
    await this.saveState(state);

    return this.resumePendingRemove(claim, root, false);
  }

  /**
   * Gives recovery callers a durable lifecycle plus only logical coordinates.
   * It deliberately validates Claim ownership before exposing a prior
   * generation's host-local record.
   */
  async recoveryStatus(claim: WorktreeClaim): Promise<WorktreeRecoveryStatus> {
    validateClaim(claim);
    this.assertLocalHost(claim);
    const state = await this.loadState();
    const root = await this.worktreeRoot();
    const mapping = state.worktrees[claim.worktree_ref];
    if (!mapping) {
      throw new ControlError("WORKTREE_NOT_MAPPED", "Claim has no host-local worktree mapping", {
        worktree_ref: claim.worktree_ref,
      });
    }
    if (mapping.claim_id !== claim.claim_id) {
      throw new ControlError("WORKTREE_CLAIM_MISMATCH", "Worktree recovery belongs to a different Claim generation", {
        worktree_ref: claim.worktree_ref,
      });
    }
    this.assertCoordinates(mapping, claim, mapping.repository_identity, root);
    return {
      worktree_ref: claim.worktree_ref,
      claim_id: claim.claim_id,
      lifecycle: mapping.lifecycle,
      path_exists: await this.mappedWorktreeExists(mapping.path, root),
    };
  }

  private created(mapping: WorktreeMapping, reused: boolean): WorktreeCreateResult {
    return { path: mapping.path, branch: mapping.branch, worktree_ref: this.refFor(mapping), reused };
  }

  private refFor(mapping: WorktreeMapping): string {
    const ref = mapping.path.split(sep).at(-1) ?? "";
    if (!logicalRef.test(ref)) throw new ControlError("INVALID_WORKTREE_STATE", "Worktree mapping path has no logical ref", { path: mapping.path });
    return ref;
  }

  private pendingCreateMapping(claim: WorktreeClaim, repository: RepositoryInfo, root: string): WorktreeMapping {
    return {
      task_id: claim.task_id,
      project_id: claim.project_id,
      repo_id: claim.repo_id,
      claim_id: claim.claim_id,
      session_id: claim.session_id,
      host: claim.host,
      branch: claim.branch,
      repository_path: repository.root,
      repository_identity: repository.identity,
      path: this.worktreePath(root, claim.worktree_ref),
      base_sha: repository.head,
      lifecycle: "pending-create",
    };
  }

  private adoptClaim(mapping: WorktreeMapping, claim: WorktreeClaim, repository: RepositoryInfo): void {
    mapping.claim_id = claim.claim_id;
    mapping.session_id = claim.session_id;
    mapping.repository_path = repository.root;
    mapping.base_sha = mapping.base_sha || repository.head;
  }

  /**
   * Resumes a durable destructive intent.  The state is re-read from disk so
   * a stale caller can never remove a successor generation.  If Git already
   * removed the path but persisting the tombstone failed, the same routine
   * merely finalizes that tombstone on retry.
   */
  private async resumePendingRemove(
    claim: WorktreeClaim,
    root: string,
    recovered: boolean,
  ): Promise<WorktreeRemovalResult> {
    const state = await this.loadState();
    const mapping = state.worktrees[claim.worktree_ref];
    if (!mapping) {
      throw new ControlError("WORKTREE_NOT_MAPPED", "Pending removal state disappeared", { worktree_ref: claim.worktree_ref });
    }
    // Validate the logical generation before even finalizing an already absent
    // path.  That needs no repository I/O and lets a durable tombstone recover
    // after a host cleanup has already removed the checkout.
    if (mapping.claim_id !== claim.claim_id) {
      throw new ControlError("WORKTREE_CLAIM_MISMATCH", "Pending worktree removal belongs to a different Claim generation", {
        worktree_ref: claim.worktree_ref,
      });
    }
    this.assertCoordinates(mapping, claim, mapping.repository_identity, root);
    if (mapping.lifecycle !== "pending-remove") {
      throw new ControlError("WORKTREE_LIFECYCLE_MISMATCH", "Worktree state changed during lifecycle operation", {
        worktree_ref: claim.worktree_ref,
        expected_lifecycle: "pending-remove",
        actual_lifecycle: mapping.lifecycle,
      });
    }

    if (!await this.mappedWorktreeExists(mapping.path, root)) {
      mapping.lifecycle = "removed";
      // A failed final save deliberately retains the pending-remove tombstone.
      await this.saveState(state);
      return { removed: true, recovered, lifecycle: "removed" };
    }

    const repository = await this.repositoryInfo(mapping.repository_path);
    this.assertExactGeneration(mapping, claim, repository.identity, root, "pending-remove");

    // This is deliberately after the durable intent write and immediately
    // before `git worktree remove`: dirty/ahead state can change meanwhile.
    const { inspection: current, status_entries } = await this.inspectMappedFull(mapping, claim, root);
    if (removalBlockingEntries(status_entries).length > 0) {
      throw new ControlError("WORKTREE_DIRTY", "Refusing to remove a newly dirty worktree", {
        worktree_ref: current.worktree_ref,
        dirty_files: current.dirty_files,
      });
    }
    if (current.ahead > 0 && !await this.isIntegrated(current.repository_path, current.head_sha)) {
      throw new ControlError("WORKTREE_UNPUSHED", "Refusing to remove a worktree with newly unintegrated commits", {
        worktree_ref: current.worktree_ref,
        ahead: current.ahead,
      });
    }

    // Drop the tool's own handoff copy so plain `git worktree remove` can
    // proceed — but only when the tolerance actually applied: the copy must
    // be the untracked entry the inspection saw, a plain directory, and a
    // regular file. lstat cannot fully close the swap race (there is no
    // unlinkat), yet a late symlink swap can remove at most one link name,
    // and any other new file keeps `git worktree remove` refusing below.
    //
    // Only the regular-file half is reachable from a file layout: a symlinked
    // copy still reports as `?? .ai/handoff.md`. The directory half cannot be,
    // because Git never produces that entry when `.ai` is a symlink — it
    // reports `?? .ai` when the link is untracked and says nothing at all when
    // the link is committed, since it does not descend through one. The same
    // holds for the directory being absent or not a directory at all: none of
    // those coexist with the entry. That half exists for the swap race alone,
    // which is why no fixture reaches it — the symlinked-directory test is
    // stopped by the dirty check above, before this tolerance is consulted.
    if (status_entries.includes(EXPECTED_LOCAL_HANDOFF_ENTRY)) {
      const localHandoffDirectory = join(current.path, LOCAL_HANDOFF_DIRECTORY);
      const localHandoffPath = join(current.path, LOCAL_HANDOFF_RELATIVE_PATH);
      const directoryInfo = await lstat(localHandoffDirectory).catch(() => null);
      const fileInfo = await lstat(localHandoffPath).catch(() => null);
      if (!directoryInfo?.isDirectory() || !fileInfo?.isFile()) {
        // Reuses WORKTREE_DIRTY because the outcome is the same fail-stop, but
        // the reason distinguishes it: the worktree is not dirty with operator
        // work, the artifact this tolerance exists for is not what it claimed.
        throw new ControlError("WORKTREE_DIRTY", "Refusing to remove a worktree whose handoff copy is not a plain file", {
          worktree_ref: current.worktree_ref,
          dirty_files: current.dirty_files,
          reason: "handoff_copy_not_plain_file",
        });
      }
      await unlink(localHandoffPath).catch((cause) => {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          // The errno is the whole diagnosis here — a permission problem and a
          // path that turned into something else need different responses.
          throw new ControlError("WORKTREE_CLEANUP_FAILED", "Failed to drop the local handoff copy before removal", {
            worktree_ref: current.worktree_ref,
            errno: code ?? "unknown",
          });
        }
      });
      // ENOTEMPTY is tolerated: something else lives in `.ai`, which is not
      // this tolerance's business. `git worktree remove` below still refuses
      // if that leftover matters, so nothing is silently discarded.
      await rmdir(localHandoffDirectory).catch((cause) => {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") {
          throw new ControlError("WORKTREE_CLEANUP_FAILED", "Failed to drop the local handoff directory before removal", {
            worktree_ref: current.worktree_ref,
            errno: code ?? "unknown",
          });
        }
      });
    }
    await this.git(["-C", mapping.repository_path, "worktree", "remove", current.path]);
    mapping.lifecycle = "removed";
    // If this persistence fails, the original pending-remove state remains a
    // recoverable tombstone and a successor cannot be mistaken for it.
    await this.saveState(state);
    return { removed: true, recovered, lifecycle: "removed" };
  }

  private assertLocalHost(claim: WorktreeClaim): void {
    if (claim.host !== this.config.buildHost) {
      throw new ControlError("HOST_MISMATCH", "Worktree operations are allowed only on the Claim host", {
        claim_host: claim.host,
        build_host: this.config.buildHost,
      });
    }
  }

  private async repositoryInfo(repositoryPath: string): Promise<RepositoryInfo> {
    if (!isAbsolute(repositoryPath)) {
      throw new ControlError("INVALID_REPOSITORY_PATH", "Repository path must be absolute", { repository_path: repositoryPath });
    }
    const root = (await this.git(["-C", repositoryPath, "rev-parse", "--show-toplevel"])).stdout.trim();
    if (!isAbsolute(root)) throw new ControlError("INVALID_REPOSITORY_PATH", "Git returned a non-absolute repository root", { root });
    const resolvedRoot = await realpath(root);
    const commonDirectory = (await this.git(["-C", resolvedRoot, "rev-parse", "--git-common-dir"])).stdout.trim();
    const identity = await realpath(isAbsolute(commonDirectory) ? commonDirectory : resolve(resolvedRoot, commonDirectory));
    const head = (await this.git(["-C", resolvedRoot, "rev-parse", "HEAD"])).stdout.trim();
    if (!head) throw new ControlError("INVALID_GIT_STATE", "Repository HEAD is empty", { repository_path: resolvedRoot });
    return { root: resolvedRoot, identity, head };
  }

  private async branchExists(repositoryPath: string, branch: string): Promise<boolean> {
    const output = (await this.git([
      "-C",
      repositoryPath,
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${branch}`,
    ])).stdout.trim();
    return output === `refs/heads/${branch}`;
  }

  private async inspectMappedFull(mapping: WorktreeMapping, claim: WorktreeClaim, root: string): Promise<FullWorktreeInspection> {
    await this.verifyWorktree(mapping.path, claim.branch, mapping.repository_identity, root);
    // Enumerate untracked files rather than collapsing a new `.ai/` directory;
    // retry evidence permits exactly `.ai/handoff.md`, never an opaque folder.
    const status = await this.git(["-C", mapping.path, "status", "--porcelain", "--untracked-files=all"]);
    const statusEntries = status.stdout.split("\n").filter(Boolean);
    const dirtyFiles = statusEntries.map((line) => line.slice(3));
    const head = (await this.git(["-C", mapping.path, "rev-parse", "HEAD"])).stdout.trim();
    const upstream = (await this.git([
      "-C",
      mapping.path,
      "for-each-ref",
      "--format=%(upstream:short)",
      `refs/heads/${claim.branch}`,
    ])).stdout.trim();
    const counts = upstream
      ? parseAheadBehind((await this.git(["-C", mapping.path, "rev-list", "--left-right", "--count", `${upstream}...HEAD`])).stdout)
      : { behind: 0, ahead: parseCount((await this.git(["-C", mapping.path, "rev-list", "--count", `${mapping.base_sha}..HEAD`])).stdout, "INVALID_GIT_STATE") };
    return {
      inspection: {
        path: mapping.path,
        repository_path: mapping.repository_path,
        branch: claim.branch,
        worktree_ref: claim.worktree_ref,
        head_sha: head,
        dirty: dirtyFiles.length > 0,
        dirty_files: dirtyFiles,
        ahead: counts.ahead,
        behind: counts.behind,
      },
      status_entries: statusEntries,
    };
  }

  private async verifyWorktree(path: string, branch: string, repositoryIdentity: string, root: string): Promise<void> {
    await this.assertMappedPath(path, root);
    const currentBranch = (await this.git(["-C", path, "branch", "--show-current"])).stdout.trim();
    if (currentBranch !== branch) {
      throw new ControlError("WORKTREE_BRANCH_MISMATCH", "Mapped worktree is on a different branch", {
        path,
        expected_branch: branch,
        actual_branch: currentBranch,
      });
    }
    const commonDirectory = (await this.git(["-C", path, "rev-parse", "--git-common-dir"])).stdout.trim();
    const actualIdentity = await realpath(isAbsolute(commonDirectory) ? commonDirectory : resolve(path, commonDirectory));
    if (actualIdentity !== repositoryIdentity) {
      throw new ControlError("WORKTREE_REPOSITORY_MISMATCH", "Mapped worktree belongs to a different repository", {
        path,
        expected_repository_identity: repositoryIdentity,
        actual_repository_identity: actualIdentity,
      });
    }
  }

  private assertCoordinates(mapping: WorktreeMapping, claim: WorktreeClaim, repositoryIdentity: string, root: string): void {
    const expectedPath = this.worktreePath(root, claim.worktree_ref);
    if (
      mapping.task_id !== claim.task_id ||
      mapping.project_id !== claim.project_id ||
      mapping.repo_id !== claim.repo_id ||
      mapping.host !== claim.host ||
      mapping.branch !== claim.branch ||
      mapping.repository_identity !== repositoryIdentity ||
      mapping.path !== expectedPath
    ) {
      throw new ControlError("WORKTREE_MAPPING_MISMATCH", "Host-local worktree mapping does not match the active Claim", {
        task_id: claim.task_id,
        claim_id: claim.claim_id,
        worktree_ref: claim.worktree_ref,
      });
    }
  }

  private assertTakeoverCoordinatesMatch(previous: ClaimHistory, successor: ActiveClaim): void {
    if (
      previous.task_id !== successor.task_id ||
      previous.task_alias !== successor.task_alias ||
      previous.project_id !== successor.project_id ||
      previous.repo_id !== successor.repo_id ||
      previous.host !== successor.host ||
      previous.branch !== successor.branch ||
      previous.worktree_ref !== successor.worktree_ref
    ) {
      throw new ControlError("WORKTREE_MAPPING_MISMATCH", "Takeover Claim records disagree on worktree coordinates", {
        worktree_ref: previous.worktree_ref,
      });
    }
  }

  private async uniqueTakeoverMapping(state: WorktreeState, claim: WorktreeClaim, root: string): Promise<WorktreeMapping> {
    this.worktreePath(root, claim.worktree_ref);
    const direct = state.worktrees[claim.worktree_ref];
    if (!direct) {
      throw new ControlError("WORKTREE_NOT_MAPPED", "Takeover Claim has no host-local worktree mapping", {
        worktree_ref: claim.worktree_ref,
      });
    }
    const directPhysicalPath = await this.physicalMappingPath(direct, root);
    const directRepositoryIdentity = await this.physicalRepositoryIdentity(direct.repository_identity);
    for (const [ref, mapping] of Object.entries(state.worktrees)) {
      if (ref === claim.worktree_ref) continue;
      if (mapping.lifecycle === "removed") {
        if (await this.mappedWorktreeExists(mapping.path, root)) {
          throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Removed worktree tombstone still has a checkout", {
            worktree_ref: ref,
          });
        }
        continue;
      }
      const physicalPath = await this.physicalMappingPath(mapping, root);
      const repositoryIdentity = await this.physicalRepositoryIdentity(mapping.repository_identity);
      if (
        mapping.task_id === claim.task_id ||
        resolve(mapping.path) === resolve(direct.path) ||
        physicalPath === directPhysicalPath ||
        (repositoryIdentity === directRepositoryIdentity && mapping.branch === direct.branch)
      ) {
        throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Takeover worktree mapping is duplicated or aliased", {
          worktree_ref: claim.worktree_ref,
        });
      }
    }
    return direct;
  }

  private async physicalRepositoryIdentity(identity: string): Promise<string> {
    try {
      const entry = await lstat(identity);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Takeover repository identity is not a regular directory");
      }
      return await realpath(identity);
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Takeover repository identity could not be resolved");
    }
  }

  private async physicalMappingPath(mapping: WorktreeMapping, root: string): Promise<string> {
    const { path } = mapping;
    if (!isAbsolute(path) || !isWithin(root, path)) {
      throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Takeover mapping contains an unsafe aliased path");
    }
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Takeover mapping path is not a regular directory");
      }
      const physical = await realpath(path);
      if (!isWithin(root, physical)) {
        throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Takeover mapping resolves outside the configured root");
      }
      return physical;
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      if (isNotFound(cause) && mapping.lifecycle !== "active") return resolve(path);
      throw new ControlError("WORKTREE_MAPPING_AMBIGUOUS", "Takeover mapping physical path could not be resolved");
    }
  }

  private assertTakeoverMapping(
    mapping: WorktreeMapping,
    claim: WorktreeClaim,
    repository: RepositoryInfo,
    root: string,
    lifecycle: WorktreeLifecycle,
  ): void {
    if (mapping.claim_id !== claim.claim_id || mapping.session_id !== claim.session_id) {
      throw new ControlError("WORKTREE_CLAIM_MISMATCH", "Takeover worktree mapping belongs to another Claim generation", {
        worktree_ref: claim.worktree_ref,
      });
    }
    if (mapping.repository_path !== repository.root) {
      throw new ControlError("WORKTREE_REPOSITORY_MISMATCH", "Stored repository root does not match its resolved identity", {
        worktree_ref: claim.worktree_ref,
      });
    }
    this.assertCoordinates(mapping, claim, repository.identity, root);
    if (mapping.lifecycle !== lifecycle) {
      throw new ControlError("WORKTREE_LIFECYCLE_MISMATCH", "Takeover requires an active worktree lifecycle", {
        worktree_ref: claim.worktree_ref,
        expected_lifecycle: lifecycle,
        actual_lifecycle: mapping.lifecycle,
      });
    }
  }

  private assertExactGeneration(
    mapping: WorktreeMapping,
    claim: WorktreeClaim,
    repositoryIdentity: string,
    root: string,
    lifecycle: WorktreeLifecycle,
  ): void {
    if (mapping.claim_id !== claim.claim_id) {
      throw new ControlError("WORKTREE_CLAIM_MISMATCH", "Host-local worktree mapping belongs to a different Claim generation", {
        task_id: claim.task_id,
        expected_claim_id: claim.claim_id,
        actual_claim_id: mapping.claim_id,
        worktree_ref: claim.worktree_ref,
      });
    }
    this.assertCoordinates(mapping, claim, repositoryIdentity, root);
    if (mapping.lifecycle !== lifecycle) {
      throw new ControlError("WORKTREE_LIFECYCLE_MISMATCH", "Worktree state changed during lifecycle operation", {
        worktree_ref: claim.worktree_ref,
        expected_lifecycle: lifecycle,
        actual_lifecycle: mapping.lifecycle,
      });
    }
  }

  private async worktreeRoot(): Promise<string> {
    if (!isAbsolute(this.config.worktreeRoot)) {
      throw new ControlError("UNSAFE_WORKTREE_ROOT", "Worktree root must be absolute", { worktree_root: this.config.worktreeRoot });
    }
    await mkdir(this.config.worktreeRoot, { recursive: true, mode: 0o700 });
    const entry = await lstat(this.config.worktreeRoot);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ControlError("UNSAFE_WORKTREE_ROOT", "Worktree root must be a non-symbolic directory", {
        worktree_root: this.config.worktreeRoot,
      });
    }
    await chmod(this.config.worktreeRoot, 0o700);
    return realpath(this.config.worktreeRoot);
  }

  private worktreePath(root: string, ref: string): string {
    if (!logicalRef.test(ref)) throw new ControlError("INVALID_WORKTREE_REF", "Invalid logical worktree ref", { worktree_ref: ref });
    const path = join(root, ref);
    if (!isWithin(root, path)) throw new ControlError("UNSAFE_WORKTREE_PATH", "Worktree path escapes configured root", { root, path });
    return path;
  }

  private async mappedWorktreeExists(path: string, root: string): Promise<boolean> {
    try {
      await this.assertMappedPath(path, root);
      return true;
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
  }

  private async assertMappedPath(path: string, root: string): Promise<void> {
    if (!isAbsolute(path) || !isWithin(root, path)) {
      throw new ControlError("UNSAFE_WORKTREE_PATH", "Mapped worktree path escapes configured root", { root, path });
    }
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ControlError("UNSAFE_WORKTREE_PATH", "Mapped worktree path is not a regular directory", { path });
    }
    const resolved = await realpath(path);
    if (!isWithin(root, resolved)) {
      throw new ControlError("UNSAFE_WORKTREE_PATH", "Mapped worktree path resolves outside configured root", { root, path, resolved });
    }
  }

  private async loadState(): Promise<WorktreeState> {
    return this.withStateDirectory(async (directory) => {
      let file;
      try {
        file = await directory.openFile(WORKTREE_STATE_FILE, stateReadFlags);
      } catch (cause) {
        if (isNotFound(cause)) return { version: STATE_VERSION, worktrees: {} };
        throw new ControlError("UNSAFE_STATE_PATH", "Worktree state must be a regular file");
      }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) {
          throw new ControlError("UNSAFE_STATE_PATH", "Worktree state must be a regular file");
        }
        return parseState(JSON.parse(await file.readFile("utf8")));
      } catch (cause) {
        if (cause instanceof ControlError) throw cause;
        throw new ControlError("INVALID_WORKTREE_STATE", "Worktree state could not be parsed", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        await file.close().catch(() => undefined);
      }
    });
  }

  private async saveState(state: WorktreeState): Promise<void> {
    await this.stateHooks.beforeSave?.();
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await this.withStateDirectory(async (directory) => {
      const temporary = `.worktrees.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<SecureStateDirectory["openFile"]>> | undefined;
      try {
        handle = await directory.openFile(temporary, stateCreateFlags, 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await directory.renameWithin(temporary, WORKTREE_STATE_FILE);
        await this.stateHooks.afterPublish?.(join(directory.path, WORKTREE_STATE_FILE));
        await this.verifyPublishedState(directory, serialized);
      } catch (cause) {
        if (handle) await handle.close().catch(() => undefined);
        await directory.unlinkWithin(temporary).catch(() => undefined);
        throw cause;
      }
    });
    await this.stateHooks.afterSave?.();
  }

  private async verifyPublishedState(directory: SecureStateDirectory, expected: string): Promise<void> {
    let published: Awaited<ReturnType<SecureStateDirectory["openFile"]>> | undefined;
    try {
      published = await directory.openFile(WORKTREE_STATE_FILE, stateReadFlags);
      const info = await published.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error("unsafe published state");
      const actual = await published.readFile("utf8");
      if (actual !== expected) throw new Error("published state differs");
      parseState(JSON.parse(actual));
      if (this.stateHooks.syncPublishedFile) await this.stateHooks.syncPublishedFile(published);
      else await published.sync();

      if (this.stateHooks.syncStateDirectory) await this.stateHooks.syncStateDirectory(directory);
      else await directory.sync();
    } catch {
      throw new ControlError("WORKTREE_STATE_WRITE_FAILED", "Published worktree state failed durability verification");
    } finally {
      await published?.close().catch(() => undefined);
    }
  }

  /**
   * Every state operation runs against one retained descriptor rather than
   * re-resolving the configured directory, which is what let an ancestor
   * symlink through and what left a window between each check and the open
   * that followed it.
   *
   * A load and the save that follows it take separate descriptors, because a
   * `git worktree add` runs between them. That is safe because every command
   * that writes this state holds the host-global mutation lock — start,
   * finish, and the recovering actions all do — while the commands that only
   * read it see whatever the last rename published, which is a whole state or
   * the one before it, never half of either.
   */
  private async withStateDirectory<T>(operation: (directory: SecureStateDirectory) => Promise<T>): Promise<T> {
    const directory = await openSecureStateDirectory(this.config.stateDir);
    try {
      return await operation(directory);
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  /**
   * True when the source checkout already reaches this commit. The recorded
   * base only answers "did this branch commit at all", which stays true forever
   * once a Task has done its job, so it cannot decide whether removing the
   * worktree would lose work. Reachability from the checkout can.
   */
  private async isIntegrated(repositoryPath: string, headSha: string): Promise<boolean> {
    if (!canonicalGitObjectId.test(headSha)) {
      throw new ControlError("INVALID_GIT_STATE", "Worktree HEAD is not a canonical object ID");
    }
    // Only an attached branch is an integration point. A detached HEAD is a
    // transient inspection state, and one parked on the Task tip would report
    // the branch as integrated when nothing has merged it.
    const checkedOut = (await this.git(["-C", repositoryPath, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (!checkedOut || checkedOut === "HEAD") return false;
    const counted = (await this.git(["-C", repositoryPath, "rev-list", "--count", `HEAD..${headSha}`])).stdout.trim();
    // A safety predicate must never read absent output as permission.
    if (!counted) throw new ControlError("INVALID_GIT_STATE", "Source checkout returned no integration count");
    return parseCount(counted, "INVALID_GIT_STATE") === 0;
  }

  private async git(args: string[]): Promise<ProcessResult> {
    return this.runner.run("git", args);
  }
}
