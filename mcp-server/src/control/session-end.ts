import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { RegistryRecordStore } from "./codec.js";
import { loadControlConfig, type ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { SessionEndEventSchema } from "./guard-protocol.js";
import { createProductionGuardJournal, type GuardJournalPort } from "./guard-journal.js";
import { ProcessRunner } from "./process.js";
import { RegistryGit } from "./registry-git.js";
import { activeClaimRelativePath, taskRelativePath } from "./registry-paths.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import { ActiveClaimSchema, TaskRecordSchema, type ActiveClaim, type TaskRecord } from "./schemas.js";
import type { GuardTaskInspection } from "./task-service.js";
import { WorktreeManager } from "./worktree.js";

const activeTaskId = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumActiveClaims = 10_000;

export type SessionEndEvidenceResult = Readonly<{
  status: "RECORDED" | "NO_MATCH" | "AMBIGUOUS" | "UNVERIFIED";
}>;

export interface SessionEndRecorderOptions {
  host: string;
  claims: {
    listActiveClaims(): Promise<ActiveClaim[]>;
  };
  tasks: {
    inspectForGuard(taskId: string, claimId: string): Promise<GuardTaskInspection>;
  };
  journal: GuardJournalPort;
  now?: () => Date;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function exactInspection(inspection: GuardTaskInspection, claim: ActiveClaim): boolean {
  return inspection.active.task_id === claim.task_id &&
    inspection.active.claim_id === claim.claim_id &&
    inspection.active.session_id === claim.session_id &&
    inspection.active.host === claim.host &&
    inspection.active.branch === claim.branch &&
    inspection.active.worktree_ref === claim.worktree_ref &&
    inspection.worktree.branch === claim.branch &&
    inspection.worktree.worktree_ref === claim.worktree_ref;
}

function corruptRegistry(): ControlError {
  return new ControlError("REGISTRY_CORRUPT", "SessionEnd Registry coordinates are inconsistent");
}

/** Minimal read graph for SessionEnd; it has no Claim or Guard mutation service. */
class ProductionSessionEndReader {
  constructor(
    private readonly records: RegistryRecordStore,
    private readonly worktrees: WorktreeManager,
    private readonly sensitiveData: SensitiveDataPolicy,
  ) {}

  async listActiveClaims(): Promise<ActiveClaim[]> {
    const entries = await this.records.listDirectoryEntries("claims/active", maximumActiveClaims);
    const claims: ActiveClaim[] = [];
    for (const entry of entries) {
      const match = entry.kind === "file" ? entry.name.match(/^(tsk-[0-9a-f-]+)\.yaml$/) : undefined;
      if (!match || !activeTaskId.test(match[1] as string)) throw corruptRegistry();
      const task = await this.task(match[1] as string);
      claims.push(await this.active(task));
    }
    return claims;
  }

  async inspectForGuard(taskId: string, claimId: string): Promise<GuardTaskInspection> {
    if (!activeTaskId.test(taskId)) throw corruptRegistry();
    const task = await this.task(taskId);
    const active = await this.active(task);
    if (active.claim_id !== claimId) throw corruptRegistry();
    return { active, worktree: await this.worktrees.inspect(active) };
  }

  private async task(taskId: string): Promise<TaskRecord> {
    return this.records.readJson(
      taskRelativePath(taskId),
      TaskRecordSchema,
      { field: "id", value: taskId },
    );
  }

  private async active(task: TaskRecord): Promise<ActiveClaim> {
    const active = await this.records.readJson(
      activeClaimRelativePath(task.id),
      ActiveClaimSchema,
      { field: "task_id", value: task.id },
    );
    if (
      active.project_id !== task.project_id ||
      active.repo_id !== task.repo_id ||
      !task.aliases.includes(active.task_alias)
    ) throw corruptRegistry();
    this.sensitiveData.assertSafe(active);
    return active;
  }
}

/** Builds only the read/append dependencies used by a production SessionEnd. */
export function createProductionSessionEndRecorder(
  environment: NodeJS.ProcessEnv = process.env,
): SessionEndRecorder {
  const config: ControlConfig = loadControlConfig(environment);
  const runner = new ProcessRunner(environment);
  const sensitiveData = createSensitiveDataPolicy(environment, [
    config.registryDir,
    config.stateDir,
    config.worktreeRoot,
  ]);
  const registry = new RegistryGit(config, runner, sensitiveData);
  const reader = new ProductionSessionEndReader(
    new RegistryRecordStore(config.registryDir, registry, sensitiveData),
    new WorktreeManager(config, runner),
    sensitiveData,
  );
  return new SessionEndRecorder({
    host: config.buildHost,
    claims: reader,
    tasks: reader,
    journal: createProductionGuardJournal(config.stateDir, environment),
  });
}

/** Read-only session termination evidence. This class has no lifecycle mutation port. */
export class SessionEndRecorder {
  private readonly now: () => Date;

  constructor(private readonly options: SessionEndRecorderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async record(input: unknown): Promise<SessionEndEvidenceResult> {
    const parsed = SessionEndEventSchema.safeParse(input);
    if (!parsed.success) return { status: "UNVERIFIED" };
    const event = parsed.data;
    let active: ActiveClaim[];
    try {
      active = await this.options.claims.listActiveClaims();
    } catch {
      return { status: "UNVERIFIED" };
    }
    const exact = active.filter((claim) =>
      "origin_adapter" in claim &&
      claim.origin_adapter === event.adapter &&
      claim.session_id === event.session_id &&
      claim.host === this.options.host);
    if (exact.length === 0) return { status: "NO_MATCH" };
    if (exact.length !== 1) return { status: "AMBIGUOUS" };
    const claim = exact[0] as ActiveClaim;

    let inspection: GuardTaskInspection;
    try {
      inspection = await this.options.tasks.inspectForGuard(claim.task_id, claim.claim_id);
      if (!exactInspection(inspection, claim)) return { status: "UNVERIFIED" };
      const [worktreeRoot, currentDirectory] = await Promise.all([
        realpath(inspection.worktree.path),
        realpath(event.cwd),
      ]);
      if (!isWithin(worktreeRoot, currentDirectory)) return { status: "UNVERIFIED" };
    } catch {
      return { status: "UNVERIFIED" };
    }

    const occurredAt = this.now();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      return { status: "UNVERIFIED" };
    }
    await this.options.journal.append({
      protocol_version: 1,
      origin_adapter: event.adapter,
      event: "session-ended",
      task_id: claim.task_id,
      claim_id: claim.claim_id,
      worktree_ref: inspection.worktree.worktree_ref,
      branch: inspection.worktree.branch,
      head_sha: inspection.worktree.head_sha,
      dirty: inspection.worktree.dirty,
      ahead: inspection.worktree.ahead,
      behind: inspection.worktree.behind,
      occurred_at: occurredAt.toISOString(),
    });
    return { status: "RECORDED" };
  }
}
