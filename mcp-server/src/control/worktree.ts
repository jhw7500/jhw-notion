import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ActiveClaim } from "./schemas.js";
import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { ProcessRunner, type ProcessResult, type ProcessRunOptions } from "./process.js";

const STATE_VERSION = 1;
const canonicalTaskId = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalClaimId = /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const logicalRef = /^wt-[a-z0-9][a-z0-9-]{1,120}$/;

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

export interface WorktreeInspection {
  /** Host-local absolute path. Never persist this in a Claim or Registry record. */
  path: string;
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
}

export interface WorktreeRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}

type WorktreeClaim = Pick<
  ActiveClaim,
  "task_id" | "task_alias" | "claim_id" | "session_id" | "host" | "branch" | "worktree_ref"
>;

interface WorktreeMapping {
  task_id: string;
  claim_id: string;
  session_id: string;
  host: string;
  branch: string;
  repository_path: string;
  repository_identity: string;
  path: string;
  base_sha: string;
  incomplete: true;
}

interface WorktreeState {
  version: 1;
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

function asMapping(value: unknown, ref: string): WorktreeMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree mapping is not an object", { worktree_ref: ref });
  }
  const record = value as Record<string, unknown>;
  const required = [
    "task_id",
    "claim_id",
    "session_id",
    "host",
    "branch",
    "repository_path",
    "repository_identity",
    "path",
    "base_sha",
  ];
  if (required.some((key) => typeof record[key] !== "string") || record.incomplete !== true) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree mapping has invalid fields", { worktree_ref: ref });
  }
  if (!isAbsolute(record.repository_path as string) || !isAbsolute(record.path as string)) {
    throw new ControlError("INVALID_WORKTREE_STATE", "Worktree mapping must contain absolute host-local paths", {
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
  ) {}

  async createOrReuse(claim: WorktreeClaim, repositoryPath: string): Promise<WorktreeCreateResult> {
    validateClaim(claim);
    this.assertLocalHost(claim);
    const repository = await this.repositoryInfo(repositoryPath);
    const state = await this.loadState();
    const root = await this.worktreeRoot();
    const existing = state.worktrees[claim.worktree_ref];

    if (existing) {
      this.assertExistingMapping(existing, claim, repository.identity, root, true);
      await this.verifyWorktree(existing.path, claim.branch, repository.identity, root);
      existing.claim_id = claim.claim_id;
      existing.session_id = claim.session_id;
      existing.repository_path = repository.root;
      await this.saveState(state);
      return { path: existing.path, branch: existing.branch, worktree_ref: claim.worktree_ref, reused: true };
    }

    const path = this.worktreePath(root, claim.worktree_ref);
    try {
      await lstat(path);
      throw new ControlError("WORKTREE_PATH_EXISTS", "A worktree path exists without a host-local mapping", {
        path,
        worktree_ref: claim.worktree_ref,
      });
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      if (!isNotFound(cause)) throw cause;
    }

    await this.git(["-C", repository.root, "worktree", "add", "-b", claim.branch, path, "HEAD"]);
    const mapping: WorktreeMapping = {
      task_id: claim.task_id,
      claim_id: claim.claim_id,
      session_id: claim.session_id,
      host: claim.host,
      branch: claim.branch,
      repository_path: repository.root,
      repository_identity: repository.identity,
      path,
      base_sha: repository.head,
      incomplete: true,
    };
    await this.verifyWorktree(mapping.path, mapping.branch, mapping.repository_identity, root);
    state.worktrees[claim.worktree_ref] = mapping;
    await this.saveState(state);
    return { path, branch: claim.branch, worktree_ref: claim.worktree_ref, reused: false };
  }

  async inspect(claim: WorktreeClaim): Promise<WorktreeInspection> {
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
    const repository = await this.repositoryInfo(mapping.repository_path);
    this.assertExistingMapping(mapping, claim, repository.identity, root);
    await this.verifyWorktree(mapping.path, claim.branch, repository.identity, root);

    const status = await this.git(["-C", mapping.path, "status", "--porcelain"]);
    const dirtyFiles = status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
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
      path: mapping.path,
      branch: claim.branch,
      worktree_ref: claim.worktree_ref,
      head_sha: head,
      dirty: dirtyFiles.length > 0,
      dirty_files: dirtyFiles,
      ahead: counts.ahead,
      behind: counts.behind,
    };
  }

  async removeIfSafe(claim: WorktreeClaim): Promise<WorktreeRemovalResult> {
    const inspection = await this.inspect(claim);
    if (inspection.dirty) {
      throw new ControlError("WORKTREE_DIRTY", "Refusing to remove a dirty worktree", {
        worktree_ref: inspection.worktree_ref,
        dirty_files: inspection.dirty_files,
      });
    }
    if (inspection.ahead > 0) {
      throw new ControlError("WORKTREE_UNPUSHED", "Refusing to remove a worktree with unpushed commits", {
        worktree_ref: inspection.worktree_ref,
        ahead: inspection.ahead,
      });
    }

    const state = await this.loadState();
    const mapping = state.worktrees[claim.worktree_ref];
    if (!mapping) throw new ControlError("WORKTREE_NOT_MAPPED", "Claim has no host-local worktree mapping", { worktree_ref: claim.worktree_ref });
    await this.git(["-C", mapping.repository_path, "worktree", "remove", inspection.path]);
    delete state.worktrees[claim.worktree_ref];
    await this.saveState(state);
    return { removed: true };
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

  private assertExistingMapping(
    mapping: WorktreeMapping,
    claim: WorktreeClaim,
    repositoryIdentity: string,
    root: string,
    allowClaimReplacement = false,
  ): void {
    if (!allowClaimReplacement && mapping.claim_id !== claim.claim_id) {
      throw new ControlError("WORKTREE_CLAIM_MISMATCH", "Host-local worktree mapping belongs to a different Claim generation", {
        task_id: claim.task_id,
        expected_claim_id: claim.claim_id,
        actual_claim_id: mapping.claim_id,
        worktree_ref: claim.worktree_ref,
      });
    }
    if (
      mapping.task_id !== claim.task_id ||
      mapping.host !== claim.host ||
      mapping.branch !== claim.branch ||
      mapping.repository_identity !== repositoryIdentity ||
      !mapping.incomplete
    ) {
      throw new ControlError("WORKTREE_MAPPING_MISMATCH", "Host-local worktree mapping does not match the active Claim", {
        task_id: claim.task_id,
        claim_id: claim.claim_id,
        worktree_ref: claim.worktree_ref,
      });
    }
    void root;
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
    const statePath = await this.statePath();
    try {
      const entry = await lstat(statePath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new ControlError("UNSAFE_STATE_PATH", "Worktree state must be a regular file", { path: statePath });
      }
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      if (isNotFound(cause)) return { version: STATE_VERSION, worktrees: {} };
      throw cause;
    }
    try {
      return parseState(JSON.parse(await readFile(statePath, "utf8")));
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw new ControlError("INVALID_WORKTREE_STATE", "Worktree state could not be parsed", {
        path: statePath,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private async saveState(state: WorktreeState): Promise<void> {
    const statePath = await this.statePath();
    try {
      const existing = await lstat(statePath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new ControlError("UNSAFE_STATE_PATH", "Worktree state must be a regular file", { path: statePath });
      }
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      if (!isNotFound(cause)) throw cause;
    }
    const temporary = join(this.config.stateDir, `.worktrees.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, statePath);
      await chmod(statePath, 0o600);
    } catch (cause) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
  }

  private async statePath(): Promise<string> {
    if (!isAbsolute(this.config.stateDir)) {
      throw new ControlError("UNSAFE_STATE_PATH", "Control state directory must be absolute", { state_dir: this.config.stateDir });
    }
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const entry = await lstat(this.config.stateDir);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ControlError("UNSAFE_STATE_PATH", "Control state directory must be a non-symbolic directory", {
        state_dir: this.config.stateDir,
      });
    }
    await chmod(this.config.stateDir, 0o700);
    const root = await realpath(this.config.stateDir);
    const path = join(root, "worktrees.json");
    if (!isWithin(root, path)) throw new ControlError("UNSAFE_STATE_PATH", "Worktree state path escapes state directory", { root, path });
    return path;
  }

  private async git(args: string[]): Promise<ProcessResult> {
    return this.runner.run("git", args);
  }
}
