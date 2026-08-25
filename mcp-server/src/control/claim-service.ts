import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { z, type ZodType } from "zod";

import { Catalog } from "./catalog.js";
import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { GuardAdapterSchema, type GuardAdapter } from "./guard-protocol.js";
import { newClaimId } from "./ids.js";
import { RegistryGit, type RegistryMutationResult } from "./registry-git.js";
import { activeClaimRelativePath, taskRelativePath } from "./registry-paths.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import {
  TaskCompletionEvidenceRecordSchema,
  TaskCompletionEvidenceSchema,
  assertParentCompletionReady,
  taskCompletionEvidenceDigest,
  taskCompletionRelativePath,
  type TaskCompletionEvidence,
  type TaskCompletionEvidenceRecord,
} from "./task-completion.js";
import {
  ActiveClaimSchema,
  ClaimCoordinateSchema,
  ClaimHistorySchema,
  ConflictingClaimSummarySchema,
  ContractActiveClaimSchema,
  type ActiveClaim,
  type ClaimHistory,
  type ContractActiveClaim,
  type TaskRecord,
} from "./schemas.js";
import {
  conflictingExclusiveGrant,
  normalizeWorkContract,
  workContractDigest,
  type WorkContract,
} from "./work-contract.js";

const taskIdPattern = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const claimIdPattern = /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const projectIdPattern = /^prj-[a-z0-9][a-z0-9-]{1,62}$/;
const repositoryIdPattern = /^repo-[a-z0-9][a-z0-9-]{1,62}$/;
const historyYearDirectoryPattern = /^\d{4}$/;
const maximumHistoryYearDirectories = 10_000;
const maximumActiveClaims = 10_000;
const boundedCoordinate = (maximumBytes: number) => z.string().min(1).max(maximumBytes)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);
const boundedText = (maximumBytes: number) => z.string().min(1).max(maximumBytes)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);

const ClaimTaskInputSchema = z.object({
  task_id: z.string().regex(taskIdPattern),
  task_alias: boundedCoordinate(160),
  project_id: z.string().regex(projectIdPattern),
  repo_id: z.string().regex(repositoryIdPattern),
  session_id: ClaimCoordinateSchema,
  host: ClaimCoordinateSchema,
  branch: ClaimCoordinateSchema,
  worktree_ref: ClaimCoordinateSchema,
}).strict();

const FinishOutcomeSchema = z.object({
  status: z.enum(["completed", "handoff", "abandoned"]),
  outcome: boundedText(4096).optional(),
  branch: ClaimCoordinateSchema,
  head_sha: boundedCoordinate(128),
  validation: z.array(boundedText(512).refine((value) => value.trim().length > 0)).min(1).max(64),
  handoff_path: z.string().max(160).regex(/^handoffs\/tsk-[0-9a-f-]+\/clm-[0-9a-f-]+\.md$/).optional(),
}).strict().superRefine((outcome, context) => {
  if (outcome.status === "completed" && outcome.outcome === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Completed releases require an outcome" });
  }
  if ((outcome.handoff_path !== undefined) !== (outcome.status === "handoff")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["handoff_path"], message: "Only Handoff releases carry a Handoff pointer" });
  }
});

const RecoveryStatusActionSchema = z.object({ kind: z.literal("status") }).strict();
const RecoveryForceEndActionSchema = z.object({ kind: z.literal("force-end") }).strict();
const RecoveryTakeoverActionSchema = z.object({
  kind: z.literal("takeover"),
  session_id: ClaimCoordinateSchema,
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
  active: ContractActiveClaim;
  history: ClaimHistory;
}

export type RecoveryResult = RecoveryStatus | RecoveryForceEnd | RecoveryTakeover;

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
  throw new ControlError(code, message);
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

  async claimTask(rawInput: ClaimTaskInput): Promise<ContractActiveClaim> {
    this.sensitiveData.assertSafe(rawInput);
    const input = parse(ClaimTaskInputSchema, rawInput, "INVALID_CLAIM", "Invalid Claim input");
    await this.assertActivePathComponents(input.task_id);
    let claimed: ContractActiveClaim | undefined;

    await this.registry.transact(`registry: claim task ${input.task_id}`, async () => {
      const task = await this.catalog.getTask(input.task_id);
      const workContract = this.requireTaskContract(task);
      const sourceTaskRevision = await this.taskSourceRevision(task);
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
      const activeClaims = await this.readAllActiveClaims(input.task_id);
      this.assertSessionAvailable(activeClaims, input.session_id, input.host, input.task_id);
      this.assertResourcesAvailable(activeClaims, workContract, input.task_id);
      const predecessor = await this.latestReusablePredecessor(task, input);
      const lifecyclePaths = await this.catalog.transitionTaskLifecycle(task.id, "active");

      const started = this.timestamp();
      claimed = parse(
        ContractActiveClaimSchema,
        {
          ...input,
          source_task_revision: sourceTaskRevision,
          claim_id: newClaimId(Date.parse(started)),
          started_at: started,
          work_contract: workContract,
          work_contract_digest: workContractDigest(workContract),
          ...(predecessor ? { predecessor_claim_id: predecessor.claim_id } : {}),
        },
        "INVALID_CLAIM",
        "Claim record failed validation",
      );
      await this.catalog.records.writeJson(activeClaimRelativePath(input.task_id), claimed);
      return stage([...lifecyclePaths, activeClaimRelativePath(input.task_id)]);
    });

    if (!claimed) throw new Error("Claim transaction did not produce an active Claim");
    return this.requireContractActiveClaim(await this.assertOwner(input.task_id, claimed.claim_id));
  }

  /** Resolves exact adapter/session/host ownership without aliases or prefixes. */
  async resolveSessionClaim(originAdapter: GuardAdapter, sessionId: string, host: string): Promise<ActiveClaim | undefined> {
    this.sensitiveData.assertSafe({ origin_adapter: originAdapter, session_id: sessionId, host });
    const lookup = parse(
      z.object({
        origin_adapter: GuardAdapterSchema,
        session_id: ClaimCoordinateSchema,
        host: ClaimCoordinateSchema,
      }).strict(),
      { origin_adapter: originAdapter, session_id: sessionId, host },
      "INVALID_CLAIM",
      "Invalid Claim session lookup",
    );
    const matches = (await this.readAllActiveClaims()).filter((active) =>
      active.session_id === lookup.session_id && active.host === lookup.host);
    if (matches.length > 1) {
      throw corruption("Exact session owns more than one active Task", {
        candidate_count: matches.length,
      });
    }
    return matches[0];
  }

  /** Bounded read-only enumeration used by Guard ownership conflict audits. */
  async listActiveClaims(): Promise<ActiveClaim[]> {
    return this.readAllActiveClaims();
  }

  async finishClaim(taskId: string, expectedClaimId: string, rawOutcome: FinishOutcome): Promise<ClaimHistory> {
    assertTaskId(taskId);
    assertClaimId(expectedClaimId);
    this.sensitiveData.assertSafe(rawOutcome);
    const outcome = parse(FinishOutcomeSchema, rawOutcome, "INVALID_FINISH_OUTCOME", "Invalid Claim finish outcome");
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
      let completionBinding: {
        completion_evidence_path: string;
        completion_evidence_digest: string;
      } | undefined;
      if (task.kind === "formal" && outcome.status === "completed") {
        const contractActive = this.requireContractActiveClaim(active);
        const completion = await this.completionEvidenceAt(task.id, active.claim_id);
        if (!completion) {
          throw new ControlError(
            "COMPLETION_EVIDENCE_REQUIRED",
            "Formal Claim completion requires evidence from the active generation",
          );
        }
        if (
          completion.task_id !== contractActive.task_id ||
          completion.claim_id !== contractActive.claim_id ||
          completion.work_contract_digest !== contractActive.work_contract_digest
        ) {
          throw new ControlError(
            "COMPLETION_EVIDENCE_MISMATCH",
            "Completion evidence does not match the active Claim and Work Contract",
          );
        }
        await this.assertFormalCompletionSemantics(task, completion.evidence);
        completionBinding = {
          completion_evidence_path: taskCompletionRelativePath(task.id, active.claim_id),
          completion_evidence_digest: taskCompletionEvidenceDigest(completion),
        };
      }
      history = this.finishHistory(active, outcome, releasedAt, completionBinding);
      await this.assertHistoryDestinationAbsent(historyRelative, taskId, expectedClaimId);
      await this.catalog.records.writeJson(historyRelative, history);
      await this.catalog.records.remove(activeClaimRelativePath(taskId));
      const lifecyclePaths = await this.catalog.transitionTaskLifecycle(taskId, outcome.status);
      return stage([historyRelativePath(year, taskId, expectedClaimId), activeClaimRelativePath(taskId), ...lifecyclePaths]);
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
    this.sensitiveData.assertSafe(rawAction);
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

  async markCompletionReady(
    taskId: string,
    expectedClaimId: string,
    rawEvidence: TaskCompletionEvidence,
  ): Promise<TaskCompletionEvidenceRecord> {
    assertTaskId(taskId);
    assertClaimId(expectedClaimId);
    this.sensitiveData.assertSafe(rawEvidence);
    const completionPath = taskCompletionRelativePath(taskId, expectedClaimId);
    await this.assertRegistryPathComponents(completionPath);
    let result: TaskCompletionEvidenceRecord | undefined;

    await this.registry.transact(`registry: mark task completion ready ${expectedClaimId}`, async () => {
      const task = await this.catalog.getTask(taskId);
      const active = this.requireContractActiveClaim(await this.requireOwner(task, expectedClaimId));
      if (task.kind !== "formal" || task.task_role === undefined || task.work_contract === undefined) {
        throw new ControlError(
          "TASK_COMPLETION_FORMAL_REQUIRED",
          "Completion readiness requires a configured formal standalone or parent Task",
        );
      }
      if (
        task.task_role === "parent" &&
        (!Array.isArray(rawEvidence?.integration_validation) ||
          rawEvidence.integration_validation.length === 0 ||
          rawEvidence.integration_validation.some((entry) => typeof entry !== "string" || !entry.trim()))
      ) {
        throw new ControlError(
          "PARENT_INTEGRATION_VALIDATION_REQUIRED",
          "Parent completion requires bounded integration validation",
        );
      }
      const evidence = parse(
        TaskCompletionEvidenceSchema,
        rawEvidence,
        "INVALID_COMPLETION_EVIDENCE",
        "Completion evidence failed validation",
      );
      await this.assertFormalCompletionSemantics(task, evidence);

      const existing = await this.completionEvidenceAt(taskId, expectedClaimId);
      if (existing) {
        if (
          existing.task_id !== task.id ||
          existing.claim_id !== active.claim_id ||
          existing.work_contract_digest !== active.work_contract_digest
        ) {
          throw corruption("Completion evidence binding disagrees with the active Claim", {
            task_id: task.id,
            claim_id: active.claim_id,
          });
        }
        if (JSON.stringify(existing.evidence) !== JSON.stringify(evidence)) {
          throw new ControlError(
            "COMPLETION_EVIDENCE_CONFLICT",
            "Completion evidence is immutable for one Claim generation",
          );
        }
        result = existing;
        return stage([]);
      }

      result = parse(
        TaskCompletionEvidenceRecordSchema,
        {
          version: 1,
          task_id: task.id,
          claim_id: active.claim_id,
          work_contract_digest: active.work_contract_digest,
          recorded_at: this.timestamp(),
          evidence,
        },
        "INVALID_COMPLETION_EVIDENCE",
        "Completion evidence record failed validation",
      );
      await this.catalog.records.writeJson(completionPath, result);
      return stage([completionPath]);
    });

    if (!result) throw new Error("Completion readiness transaction did not produce evidence");
    return result;
  }

  async getCompletionEvidence(taskId: string, claimId: string): Promise<TaskCompletionEvidenceRecord> {
    assertTaskId(taskId);
    assertClaimId(claimId);
    const completionPath = taskCompletionRelativePath(taskId, claimId);
    await this.assertRegistryPathComponents(completionPath);
    const record = await this.completionEvidenceAt(taskId, claimId);
    if (!record) {
      throw new ControlError(
        "COMPLETION_EVIDENCE_NOT_FOUND",
        "Exact Task completion evidence does not exist",
      );
    }
    return record;
  }

  async getClaimHistory(taskId: string, claimId: string): Promise<ClaimHistory> {
    assertTaskId(taskId);
    assertClaimId(claimId);
    const task = await this.catalog.getTask(taskId);
    const candidates = await this.claimHistoryCandidates(taskId, claimId);
    if (candidates.length === 0) {
      throw new ControlError("CLAIM_HISTORY_NOT_FOUND", "Exact released Claim history does not exist");
    }
    if (candidates.length !== 1) throw corruption("Exact released Claim history is ambiguous", { task_id: taskId });
    const history = candidates[0] as ClaimHistory;
    this.assertHistoryMatchesTask(history, task);
    return history;
  }

  async latestHandoffHistory(taskId: string): Promise<ClaimHistory> {
    assertTaskId(taskId);
    const candidates = (await this.taskHistory(taskId)).filter((history) =>
      history.status === "handoff" && history.handoff_path);
    if (candidates.length === 0) throw new ControlError("HANDOFF_NOT_FOUND", "Task has no committed Handoff history");
    return this.latestUniqueHistory(taskId, candidates);
  }

  /** Returns the exact newest committed release for start/recovery policy. */
  async latestClaimHistory(taskId: string): Promise<ClaimHistory> {
    assertTaskId(taskId);
    const candidates = await this.taskHistory(taskId);
    if (candidates.length === 0) throw new ControlError("CLAIM_HISTORY_NOT_FOUND", "Task has no committed Claim history");
    return this.latestUniqueHistory(taskId, candidates);
  }

  private async taskHistory(taskId: string): Promise<ClaimHistory[]> {
    const task = await this.catalog.getTask(taskId);
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
        this.assertHistoryMatchesTask(history, task);
        this.sensitiveData.assertSafe(history);
        candidates.push(history);
      }
    }
    return candidates;
  }

  private latestUniqueHistory(taskId: string, candidates: ClaimHistory[]): ClaimHistory {
    candidates.sort((left, right) => Date.parse(right.released_at) - Date.parse(left.released_at));
    if (candidates[1] && Date.parse(candidates[1].released_at) === Date.parse(candidates[0]?.released_at ?? "")) {
      throw corruption("Latest Task Claim history is ambiguous", { task_id: taskId });
    }
    return candidates[0] as ClaimHistory;
  }

  private async latestReusablePredecessor(
    task: TaskRecord,
    input: ClaimTaskInput,
  ): Promise<ClaimHistory | undefined> {
    let latest: ClaimHistory;
    try {
      latest = await this.latestClaimHistory(task.id);
    } catch (cause) {
      if (cause instanceof ControlError && cause.code === "CLAIM_HISTORY_NOT_FOUND") return undefined;
      throw cause;
    }
    const reusable = latest.status === "handoff" ||
      latest.status === "force-ended" ||
      (latest.status === "abandoned" && latest.outcome === "worktree_create_failed");
    if (!reusable) return undefined;
    if (
      latest.task_id !== input.task_id ||
      latest.task_alias !== input.task_alias ||
      latest.project_id !== input.project_id ||
      latest.repo_id !== input.repo_id ||
      latest.host !== input.host ||
      latest.branch !== input.branch ||
      latest.worktree_ref !== input.worktree_ref
    ) {
      throw corruption("Reusable Claim predecessor disagrees with the requested successor coordinates", {
        task_id: task.id,
        claim_id: latest.claim_id,
      });
    }
    return latest;
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
      await this.catalog.records.remove(activeClaimRelativePath(taskId));
      const lifecyclePaths = await this.catalog.transitionTaskLifecycle(taskId, "handoff");
      return stage([historyRelativePath(year, taskId, expectedClaimId), activeClaimRelativePath(taskId), ...lifecyclePaths]);
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
    let replacement: ContractActiveClaim | undefined;
    await this.registry.transact(`registry: take over claim ${expectedClaimId}`, async () => {
      const task = await this.catalog.getTask(taskId);
      const active = await this.readActive(task);
      if (!active) {
        throw new ControlError("CLAIM_NOT_FOUND", "Task does not have an active Claim", { task_id: task.id });
      }
      if (active.claim_id !== expectedClaimId) {
        history = await this.requireLinkedTakeoverRetry(task, expectedClaimId, active, sessionId);
        replacement = this.requireContractActiveClaim(active);
        return stage([]);
      }
      if (active.host !== this.config.buildHost) {
        throw new ControlError("HOST_MISMATCH", "Claim takeover is allowed only on the recorded host", {
          claim_host: active.host,
          build_host: this.config.buildHost,
        });
      }
      const contractActive = this.requireContractActiveClaim(active);
      const activeClaims = await this.readAllActiveClaims(task.id);
      this.assertSessionAvailable(activeClaims, sessionId, this.config.buildHost, task.id);
      this.assertResourcesAvailable(activeClaims, contractActive.work_contract, task.id);
      const started = this.timestamp();
      const { predecessor_claim_id: _allocationPredecessor, ...takeoverBase } = contractActive;
      replacement = parse(
        ContractActiveClaimSchema,
        {
          ...takeoverBase,
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
      history = this.takeoverHistory(contractActive, releasedAt, replacement.claim_id);
      await this.assertHistoryDestinationAbsent(historyRelative, taskId, expectedClaimId);
      await this.catalog.records.writeJson(historyRelative, history);
      await this.catalog.records.remove(activeClaimRelativePath(taskId));
      await this.catalog.records.writeJson(activeClaimRelativePath(taskId), replacement);
      return stage([historyRelative, activeClaimRelativePath(taskId)]);
    });

    if (!history || !replacement) throw new Error("Claim takeover transaction did not produce both records");
    const verified = this.requireContractActiveClaim(await this.assertOwner(taskId, replacement.claim_id));
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
      await this.registry.assertHeadRegularFile(activeClaimRelativePath(task.id));
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
    const recordPath = activeClaimRelativePath(task.id);
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

  private async completionEvidenceAt(
    taskId: string,
    claimId: string,
  ): Promise<TaskCompletionEvidenceRecord | undefined> {
    const record = await this.catalog.records.readOptionalJson(
      taskCompletionRelativePath(taskId, claimId),
      TaskCompletionEvidenceRecordSchema,
      { field: "claim_id", value: claimId },
    );
    if (record && (record.task_id !== taskId || record.claim_id !== claimId)) {
      throw corruption("Completion evidence path and embedded identity disagree", {
        task_id: taskId,
        claim_id: claimId,
      });
    }
    if (record) this.sensitiveData.assertSafe(record);
    return record;
  }

  private async assertFormalCompletionSemantics(
    task: TaskRecord,
    evidence: TaskCompletionEvidence,
  ): Promise<void> {
    if (task.kind !== "formal" || task.task_role === undefined || task.work_contract === undefined) {
      throw new ControlError(
        "TASK_COMPLETION_FORMAL_REQUIRED",
        "Completion readiness requires a configured formal standalone or parent Task",
      );
    }
    if (task.task_role === "parent") {
      assertParentCompletionReady(task, await this.catalog.listChildren(task.id), evidence);
    } else if (evidence.child_dispositions.length !== 0) {
      throw new ControlError(
        "INVALID_PARENT_COMPLETION",
        "Standalone Task completion cannot carry child dispositions",
      );
    }
  }

  private requireTaskContract(task: TaskRecord): WorkContract {
    if ((task.kind !== "child" && task.task_role === undefined) || task.work_contract === undefined) {
      throw new ControlError("TASK_CONTRACT_REQUIRED", "Task must be configured with a Work Contract before Claim acquisition", {
        task_id: task.id,
      });
    }
    if (task.work_contract.task_id !== task.id) {
      throw corruption("Task Work Contract identity disagrees with its Registry Task", { task_id: task.id });
    }
    try {
      return normalizeWorkContract(task.work_contract);
    } catch (cause) {
      throw corruption("Task Work Contract could not be normalized", {
        task_id: task.id,
        cause: errorMessage(cause),
      });
    }
  }

  private async taskSourceRevision(task: TaskRecord): Promise<string> {
    return task.kind === "formal"
      ? task.issue_revision
      : this.registry.headRegularBlobObjectId(taskRelativePath(task.id));
  }

  private async readAllActiveClaims(referenceTaskId = "tsk-00000000-0000-7000-8000-000000000000"): Promise<ActiveClaim[]> {
    const directory = dirname(activeClaimRelativePath(referenceTaskId));
    const entries = await this.catalog.records.listDirectoryEntries(directory, maximumActiveClaims);
    const claims: ActiveClaim[] = [];
    for (const entry of entries) {
      const match = entry.kind === "file" ? entry.name.match(/^(tsk-[0-9a-f-]+)\.yaml$/) : undefined;
      if (!match || !taskIdPattern.test(match[1] as string)) {
        throw corruption("Active Claim directory contains a malformed entry", {});
      }
      const task = await this.catalog.getTask(match[1] as string);
      const active = await this.readActive(task);
      if (!active) {
        throw corruption("Enumerated active Claim is missing", { task_id: task.id });
      }
      claims.push(active);
    }
    return claims;
  }

  private assertSessionAvailable(
    activeClaims: ActiveClaim[],
    sessionId: string,
    host: string,
    requestedTaskId: string,
  ): void {
    const conflicting = activeClaims.find((active) =>
      active.task_id !== requestedTaskId && active.session_id === sessionId && active.host === host);
    if (!conflicting) return;
    const summary = ConflictingClaimSummarySchema.safeParse(conflicting);
    throw new ControlError(
      "TASK_SESSION_BUSY",
      "Exact host session already owns a different active Task",
      summary.success ? { conflicting_claim: summary.data } : {},
    );
  }

  private assertResourcesAvailable(
    activeClaims: ActiveClaim[],
    requestedContract: WorkContract,
    requestedTaskId: string,
  ): void {
    for (const active of activeClaims) {
      if (active.task_id === requestedTaskId) continue;
      const contractActive = this.requireContractActiveClaim(active);
      const conflict = conflictingExclusiveGrant(requestedContract, contractActive.work_contract);
      if (!conflict) continue;
      const summary = ConflictingClaimSummarySchema.safeParse(active);
      throw new ControlError(
        "TASK_RESOURCE_CONFLICT",
        "An exact Work Contract resource conflicts with an active Claim",
        {
          resource: conflict.resource,
          ...(summary.success ? { conflicting_claim: summary.data } : {}),
        },
      );
    }
  }

  private requireContractActiveClaim(active: ActiveClaim): ContractActiveClaim {
    const parsed = ContractActiveClaimSchema.safeParse(active);
    if (parsed.success) return parsed.data;
    if (ActiveClaimSchema.safeParse(active).success) {
      throw new ControlError(
        "ACTIVE_CLAIM_CONTRACT_REQUIRED",
        "Active Claim lacks the immutable Work Contract snapshot required for acquisition",
        { task_id: active.task_id, claim_id: active.claim_id },
      );
    }
    throw corruption("Active Claim Work Contract integrity validation failed", {
      task_id: active.task_id,
      claim_id: active.claim_id,
    });
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

  private assertHistoryMatchesTask(history: ClaimHistory, task: TaskRecord): void {
    if (
      history.task_id !== task.id ||
      history.project_id !== task.project_id ||
      history.repo_id !== task.repo_id ||
      (history.task_alias !== undefined && !task.aliases.includes(history.task_alias))
    ) {
      throw corruption("Archived Claim and canonical Task disagree", {
        task_id: task.id,
        claim_id: history.claim_id,
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
    await this.assertRegistryPathComponents(activeClaimRelativePath(taskId));
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

  private finishHistory(
    active: ActiveClaim,
    outcome: FinishOutcome,
    releasedAt: string,
    completionBinding?: {
      completion_evidence_path: string;
      completion_evidence_digest: string;
    },
  ): ClaimHistory {
    return parse(
      ClaimHistorySchema,
      {
        ...this.claimHistoryBase(active),
        branch: outcome.branch,
        head_sha: outcome.head_sha,
        validation_summary: outcome.validation.join("\n"),
        released_at: releasedAt,
        status: outcome.status,
        ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
        ...(outcome.handoff_path ? { handoff_path: outcome.handoff_path } : {}),
        ...completionBinding,
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
        ...this.claimHistoryBase(active),
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
        ...this.claimHistoryBase(active),
        released_at: releasedAt,
        status: "taken-over",
        successor_claim_id: successorClaimId,
      },
      "INVALID_CLAIM_HISTORY",
      "Claim history record failed validation",
    );
  }

  private claimHistoryBase(active: ActiveClaim): Omit<ContractActiveClaim, "work_contract"> | ActiveClaim {
    if (!("work_contract" in active)) return active;
    const { work_contract: _snapshot, ...historyBase } = active;
    return historyBase;
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
