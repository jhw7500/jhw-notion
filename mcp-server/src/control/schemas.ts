import { z } from "zod";

import {
  ClaimIdSchema,
  GuardAdapterSchema,
  GuardSessionSchema,
  GuardWorktreeRefSchema,
  OperationIdSchema,
  CanonicalOperationRequirementsSchema,
  RequestIdSchema,
} from "./guard-protocol.js";
import { normalizeWorkContract, TaskIdSchema, WorkContractSchema, workContractDigest } from "./work-contract.js";

export { TaskIdSchema } from "./work-contract.js";

const canonicalId = (prefix: "prj" | "repo" | "tsk" | "clm" | "hld" | "rsv") =>
  z.string().regex(new RegExp(`^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));

const projectId = z.string().regex(/^prj-[a-z0-9][a-z0-9-]{1,62}$/);
const repositoryId = z.string().regex(/^repo-[a-z0-9][a-z0-9-]{1,62}$/);
const githubSlugPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const formalAliasPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]*$/;
const canonicalIssueUrlPattern = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/issues\/([1-9][0-9]*)$/;
const boundedUtf8 = (maximumBytes: number) => z.string().min(1).max(maximumBytes)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);
const boundedCoordinate = (maximumBytes: number) => z.string().min(1).max(maximumBytes)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);
const taskAlias = boundedCoordinate(160);
export const ClaimCoordinateSchema = boundedCoordinate(255);
export const GithubNodeIdSchema = z.string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 128);
const githubApiId = z.string().min(1).max(256).refine((value) => Buffer.byteLength(value, "utf8") <= 256);
export const SourceTaskRevisionSchema = boundedCoordinate(256);
export const OffsetDateTimeSchema = z.string().min(1).max(64).datetime({ offset: true });
export const TemporaryLifecycleSchema = z.enum(["active", "handoff", "completed", "abandoned"]);
export type TemporaryLifecycle = z.infer<typeof TemporaryLifecycleSchema>;
export const TaskRoleSchema = z.enum(["standalone", "parent"]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const nextAction = z.string().max(165).refine(
  (value) => /^task:tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
    /^wait:[^\u0000-\u001f\u007f]{1,160}$/.test(value),
  "Invalid Next Action",
);

const authorityBase = {
  authority_epoch: z.number().int().positive().safe(),
  minimum_tool_version: z.string().max(64).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
};
export const AuthorityRecordSchema = z.discriminatedUnion("mode", [
  z.object({ ...authorityBase, mode: z.literal("legacy"), cutover_at: z.null() }).strict(),
  z.object({ ...authorityBase, mode: z.literal("registry"), cutover_at: OffsetDateTimeSchema }).strict(),
]);
export type AuthorityRecord = z.infer<typeof AuthorityRecordSchema>;

export const RepositoryRecordSchema = z
  .object({
    id: repositoryId,
    github_node_id: GithubNodeIdSchema,
    slug: z.string().regex(githubSlugPattern),
    // Explicit operator opt-in: the source repository may be public. Absent
    // means the Phase 1A private requirement stays enforced on every use.
    allow_public: z.literal(true).optional(),
  })
  .strict();
export type RepositoryRecord = z.infer<typeof RepositoryRecordSchema>;

const taskBase = {
  id: canonicalId("tsk"),
  project_id: projectId,
  repo_id: repositoryId,
  aliases: z.array(taskAlias).min(1).max(64)
    .refine((aliases) => new Set(aliases).size === aliases.length, "Duplicate Task alias"),
};

const legacyCompatibleTaskConfiguration = {
  task_role: TaskRoleSchema.optional(),
  work_contract: WorkContractSchema.optional(),
};

export const FormalTaskSchema = z
  .object({
    ...taskBase,
    kind: z.literal("formal"),
    issue_node_id: GithubNodeIdSchema,
    issue_revision: OffsetDateTimeSchema,
    issue_url: z.string().max(512).url(),
    ...legacyCompatibleTaskConfiguration,
  })
  .strict()
  .superRefine((task, context) => {
    const coordinates = task.issue_url.match(canonicalIssueUrlPattern);
    if (!coordinates || !Number.isSafeInteger(Number(coordinates[3]))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["issue_url"], message: "Formal Task requires a canonical safe GitHub Issue URL" });
      return;
    }
    const canonicalAlias = `${coordinates[1]}/${coordinates[2]}#${coordinates[3]}`;
    if (!task.aliases.includes(canonicalAlias)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["aliases"], message: "Formal Task is missing its canonical Issue alias" });
    }
    if (task.aliases.some((alias) => {
      if (!formalAliasPattern.test(alias) || alias === canonicalAlias) return false;
      return alias.slice(alias.lastIndexOf("#") + 1) !== coordinates[3];
    })) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aliases"],
        message: "Historical formal Task alias disagrees with its canonical Issue number",
      });
    }
    if (task.work_contract !== undefined && task.work_contract.task_id !== task.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["work_contract", "task_id"], message: "Work Contract Task ID disagrees with Task record" });
    }
  });
export type FormalTask = z.infer<typeof FormalTaskSchema>;

export const TemporaryTaskSchema = z
  .object({
    ...taskBase,
    kind: z.literal("temporary"),
    goal: boundedUtf8(32 * 1024),
    done_conditions: z.array(boundedUtf8(256)).min(1).max(32),
    expected_scope: z.array(boundedUtf8(256)).min(1).max(32),
    lifecycle: TemporaryLifecycleSchema,
    ...legacyCompatibleTaskConfiguration,
  })
  .strict()
  .superRefine((task, context) => {
    if (task.work_contract !== undefined && task.work_contract.task_id !== task.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["work_contract", "task_id"], message: "Work Contract Task ID disagrees with Task record" });
    }
  });
export type TemporaryTask = z.infer<typeof TemporaryTaskSchema>;

export const ChildTaskSchema = z
  .object({
    ...taskBase,
    kind: z.literal("child"),
    parent_task_id: canonicalId("tsk"),
    required_for_parent: z.boolean(),
    goal: boundedUtf8(32 * 1024),
    done_conditions: z.array(boundedUtf8(256)).min(1).max(32),
    lifecycle: TemporaryLifecycleSchema,
    work_contract: WorkContractSchema,
  })
  .strict()
  .superRefine((task, context) => {
    if (task.work_contract.task_id !== task.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["work_contract", "task_id"], message: "Work Contract Task ID disagrees with Task record" });
    }
  });
export type ChildTask = z.infer<typeof ChildTaskSchema>;

export const TaskRecordSchema = z.union([FormalTaskSchema, TemporaryTaskSchema, ChildTaskSchema]);
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

const ActiveClaimBaseSchema = z.object({
    task_id: canonicalId("tsk"),
    task_alias: taskAlias,
    project_id: projectId,
    repo_id: repositoryId,
    claim_id: canonicalId("clm"),
    predecessor_claim_id: canonicalId("clm").optional(),
    session_id: ClaimCoordinateSchema,
    host: ClaimCoordinateSchema,
    branch: ClaimCoordinateSchema,
    worktree_ref: ClaimCoordinateSchema,
    source_task_revision: SourceTaskRevisionSchema,
    started_at: OffsetDateTimeSchema,
  });

export const LegacyActiveClaimSchema = ActiveClaimBaseSchema.strict();
export const AdapterLegacyActiveClaimSchema = ActiveClaimBaseSchema.extend({
  origin_adapter: GuardAdapterSchema,
}).strict();
const contractClaimFields = {
  work_contract: WorkContractSchema,
  work_contract_digest: z.string().regex(/^[0-9a-f]{64}$/),
};
function validateContractClaim(
  claim: z.infer<typeof ActiveClaimBaseSchema> & z.infer<z.ZodObject<typeof contractClaimFields>>,
  context: z.RefinementCtx,
): void {
  if (claim.work_contract.task_id !== claim.task_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["work_contract", "task_id"],
      message: "Claim Work Contract Task ID disagrees with active Claim",
    });
  }
  const normalized = normalizeWorkContract(claim.work_contract);
  if (JSON.stringify(normalized) !== JSON.stringify(claim.work_contract)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["work_contract"],
      message: "Active Claim Work Contract snapshot is not canonical",
    });
  }
  if (workContractDigest(normalized) !== claim.work_contract_digest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["work_contract_digest"],
      message: "Active Claim Work Contract digest disagrees with its snapshot",
    });
  }
}

/** Pre-adapter contract Claims stay readable for recovery, never Guard authority. */
export const LegacyContractActiveClaimSchema = ActiveClaimBaseSchema.extend(contractClaimFields)
  .strict()
  .superRefine(validateContractClaim);
export const ContractActiveClaimSchema = ActiveClaimBaseSchema.extend({
  origin_adapter: GuardAdapterSchema,
  ...contractClaimFields,
}).strict().superRefine(validateContractClaim);
export const ActiveClaimSchema = z.union([
  ContractActiveClaimSchema,
  LegacyContractActiveClaimSchema,
  AdapterLegacyActiveClaimSchema,
  LegacyActiveClaimSchema,
]);
export type ActiveClaim = z.infer<typeof ActiveClaimSchema>;
export type ContractActiveClaim = z.infer<typeof ContractActiveClaimSchema>;
export type LegacyContractActiveClaim = z.infer<typeof LegacyContractActiveClaimSchema>;

const safeClaimConflictText = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/u);

/** Deliberately bounded public coordinates for an already-owned Task. */
export const ConflictingClaimSummarySchema = ActiveClaimBaseSchema.pick({
  task_id: true,
  claim_id: true,
  host: true,
  branch: true,
  worktree_ref: true,
  started_at: true,
}).extend({
  host: safeClaimConflictText,
  branch: safeClaimConflictText,
  worktree_ref: safeClaimConflictText,
  started_at: OffsetDateTimeSchema,
}).strict();
export type ConflictingClaimSummary = z.infer<typeof ConflictingClaimSummarySchema>;

/** Closed command labels that may be persisted in Registry lock diagnostics. */
export const RegistryMutationCommandSchema = z.enum([
  "preflight",
  "repository register",
  "task start",
  "task child-start",
  "task contract",
  "task completion-ready",
  "task finish",
  "task promote",
  "task recover",
  "project register",
  "project update",
  "portfolio export",
]);
export type RegistryMutationCommand = z.infer<typeof RegistryMutationCommandSchema>;

/** The complete public diagnosis for one contended Registry lock holder. */
export const LockHolderSummarySchema = z.object({
  command: RegistryMutationCommandSchema,
  acquired_at: OffsetDateTimeSchema,
  elapsed_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pid_state: z.enum(["alive", "dead", "unknown"]),
}).strict();
export type LockHolderSummary = z.infer<typeof LockHolderSummarySchema>;

/** The only child-registration coordinate an error envelope may retain. */
export const RetainedTaskSummarySchema = z.object({
  task_id: TaskIdSchema,
}).strict();
export type RetainedTaskSummary = z.infer<typeof RetainedTaskSummarySchema>;

/**
 * The closed vocabulary of machine-readable causes emitted next to a stable
 * error code when one code covers operator actions that differ. Emission is
 * membership: a value not registered here is dropped, so a throw site cannot
 * invent a synonym or leak free text. Registering an entry carries two duties
 * a test walks: the untyped `reason:` literals in control sources must come
 * from this list, and the operator doc that interprets the axis must name it.
 */
export const ERROR_REASONS = [
  // HANDOFF_RETRY_CONFLICT — committed-handoff parse failures; one operator
  // action for all seven: the committed artifact is corrupt.
  "invalid_git_state_line",
  "duplicate_git_state_key",
  "unexpected_git_state_key",
  "missing_git_state_key",
  "invalid_git_state_count",
  "missing_git_identity",
  "invalid_dirty_digest",
  // HANDOFF_RETRY_CONFLICT — axes whose operator actions differ.
  "legacy_dirty_evidence_ambiguous",
  "git_identity_changed",
  "dirty_delta_changed",
  "handoff_metadata_mismatch",
  "retry_fields_changed",
  // INVALID_WORKTREE_INSPECTION
  "duplicate_dirty_files",
  // WORKTREE_DIRTY
  "handoff_copy_not_plain_file",
  // BOARD_BUSY — which holder class blocks, so the caller can tell "wait or
  // share" apart from "the blocker has already overstayed its lease".
  "exclusive_holder",
  "shared_holders_block_exclusive",
  "overstay_holder",
  // BOARD_RESERVED — a live reservation window versus a mid-window fence the
  // caller declined to accept as a shortened grant.
  "reservation_window_active",
  "shortening_not_accepted",
  // RESERVATION_CONFLICT
  "overlaps_reservation",
  "overlaps_active_grant",
  "mode_mismatch",
  "reservation_not_started",
  // BOARD_LIMIT_EXCEEDED
  "lease_too_long",
  "reservation_too_long",
  "reservation_horizon",
  "reservation_count",
  "holder_count",
  // HOLDER_MISMATCH — the coordinate matched but the operation's condition
  // did not.
  "cross_session_flag_required",
  "live_pid_recorded",
  // LOCK_CONTENDED — boards.lock, distinguished from registry.lock contention.
  "board_state_lock",
  // LOCK_CONTENDED — the host-global Registry writer lock.
  "registry_state_lock",
  // LOCK_CONTENDED — the independent one-time Guard request state lock.
  "guard_state_lock",
] as const;
export const ErrorReasonSchema = z.enum(ERROR_REASONS);
export type ErrorReason = z.infer<typeof ErrorReasonSchema>;

/** Stable, closed Guard policy codes. Normal denials use this schema, not exceptions. */
export const GuardDenyCodeSchema = z.enum([
  "GUARD_CLAIM_REQUIRED",
  "GUARD_CLAIM_MISMATCH",
  "GUARD_WORKTREE_MISMATCH",
  "GUARD_RESOURCE_OWNED",
  "GUARD_REQUEST_NOT_FOUND",
  "GUARD_REQUEST_EXPIRED",
  "GUARD_PERMIT_MISMATCH",
  "GUARD_PERMIT_CONSUMED",
  "GUARD_PROMPT_ORIGIN_UNSUPPORTED",
  "GUARD_UNAVAILABLE",
  "GUARD_PROTOCOL_MISMATCH",
  "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE",
  "GUARD_WRAPPER_REQUIRED",
  "GUARD_SELF_APPROVAL_DENIED",
  "GUARD_STATE_LIMIT",
]);
export type GuardDenyCode = z.infer<typeof GuardDenyCodeSchema>;

export const GuardEvaluationModeSchema = z.enum(["enforce", "observe"]);
export type GuardEvaluationMode = z.infer<typeof GuardEvaluationModeSchema>;

export const GuardSummarySchema = boundedCoordinate(512);
export const GuardExecutionBoundarySchema = z.enum(["hook", "guarded_command", "tracker", "notion", "board"]);
export const GuardJournalWarningSchema = z.literal("GUARD_JOURNAL_UNAVAILABLE");

export const GuardRequestLifecycleSchema = z.enum([
  "PENDING",
  "APPROVED",
  "CONSUMED",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
]);
export type GuardRequestLifecycle = z.infer<typeof GuardRequestLifecycleSchema>;
export const GUARD_REQUEST_TTL_MS = 10 * 60 * 1_000;

/** Exact private permit binding and lifecycle metadata; no transport payloads. */
export const GuardRequestSchema = z.object({
  request_id: RequestIdSchema,
  state: GuardRequestLifecycleSchema,
  origin_adapter: GuardAdapterSchema,
  session_id: GuardSessionSchema,
  task_id: TaskIdSchema,
  claim_id: ClaimIdSchema,
  cwd_worktree_ref: GuardWorktreeRefSchema,
  requirements: CanonicalOperationRequirementsSchema,
  operation_digest: z.string().regex(/^[0-9a-f]{64}$/),
  summary: GuardSummarySchema,
  requested_at: OffsetDateTimeSchema,
  approval_expires_at: OffsetDateTimeSchema,
  approved_at: OffsetDateTimeSchema.optional(),
  start_by: OffsetDateTimeSchema.optional(),
  consumed_at: OffsetDateTimeSchema.optional(),
  finished_at: OffsetDateTimeSchema.optional(),
  correlation_id: boundedCoordinate(255).optional(),
}).strict().superRefine((request, context) => {
  const requestedAt = Date.parse(request.requested_at);
  const approvalExpiresAt = Date.parse(request.approval_expires_at);
  if (approvalExpiresAt !== requestedAt + GUARD_REQUEST_TTL_MS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["approval_expires_at"], message: "Approval deadline is not exactly ten minutes" });
  }
  const approved = request.approved_at !== undefined && request.start_by !== undefined;
  if ((request.approved_at !== undefined) !== (request.start_by !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["approved_at"], message: "Approval timestamps are atomic" });
  }
  if (["APPROVED", "CONSUMED", "COMPLETED", "FAILED"].includes(request.state) && !approved) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["approved_at"], message: "Approved lifecycle requires approval timestamps" });
  }
  if (approved) {
    const approvedAt = Date.parse(request.approved_at as string);
    const startBy = Date.parse(request.start_by as string);
    if (approvedAt < requestedAt || approvedAt >= approvalExpiresAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["approved_at"], message: "Approval timestamp is outside its pending window" });
    }
    if (startBy !== approvedAt + GUARD_REQUEST_TTL_MS) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["start_by"], message: "Start deadline is not exactly ten minutes" });
    }
  }
  const consumed = request.consumed_at !== undefined && request.correlation_id !== undefined;
  if ((request.consumed_at !== undefined) !== (request.correlation_id !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["consumed_at"], message: "Consumption coordinates are atomic" });
  }
  if (["CONSUMED", "COMPLETED", "FAILED"].includes(request.state) && !consumed) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["consumed_at"], message: "Consumed lifecycle requires correlation" });
  }
  if (consumed && approved) {
    const consumedAt = Date.parse(request.consumed_at as string);
    if (consumedAt < Date.parse(request.approved_at as string) || consumedAt >= Date.parse(request.start_by as string)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["consumed_at"], message: "Consumption timestamp is outside its approved window" });
    }
  }
  if (["COMPLETED", "FAILED", "EXPIRED"].includes(request.state) !== (request.finished_at !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["finished_at"], message: "Terminal lifecycle requires one finish timestamp" });
  }
  if (request.state === "PENDING" && (approved || consumed)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Pending request carries later lifecycle fields" });
  }
  if (request.state === "APPROVED" && consumed) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Approved request carries consumption fields" });
  }
  if (request.state === "EXPIRED" && consumed) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Expired request carries consumption fields" });
  }
  if (request.finished_at !== undefined) {
    const finishedAt = Date.parse(request.finished_at);
    const earliest = request.state === "EXPIRED"
      ? Date.parse(request.start_by ?? request.approval_expires_at)
      : Date.parse(request.consumed_at as string);
    if (finishedAt < earliest) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["finished_at"], message: "Finish timestamp precedes its terminal boundary" });
    }
  }
});
export type GuardRequest = z.infer<typeof GuardRequestSchema>;

export const GuardRequestStateSchema = z.object({
  version: z.literal(1),
  requests: z.array(GuardRequestSchema)
    .refine((requests) => new Set(requests.map((request) => request.request_id)).size === requests.length, "Duplicate Guard request ID")
    .refine((requests) => {
      const correlations = requests.flatMap((request) => request.correlation_id === undefined ? [] : [request.correlation_id]);
      return new Set(correlations).size === correlations.length;
    }, "Duplicate Guard correlation ID")
    .refine((requests) => {
      const liveBindings = requests
        .filter((request) => request.state === "PENDING" || request.state === "APPROVED" || request.state === "CONSUMED")
        .map((request) => JSON.stringify([
          request.task_id,
          request.claim_id,
          request.origin_adapter,
          request.session_id,
          request.cwd_worktree_ref,
          request.requirements,
          request.operation_digest,
        ]));
      return new Set(liveBindings).size === liveBindings.length;
    }, "Duplicate live Guard operation binding"),
}).strict();
export type GuardRequestState = z.infer<typeof GuardRequestStateSchema>;

const GuardAllowDecisionSchema = z.object({
  decision: z.literal("ALLOW"),
  operation_id: OperationIdSchema,
  summary: GuardSummarySchema,
  execution_boundary: GuardExecutionBoundarySchema,
  consumed_request_id: RequestIdSchema.optional(),
  observed_decision: z.enum(["PERMIT_REQUIRED", "DENY"]).optional(),
  journal_warning: GuardJournalWarningSchema.optional(),
}).strict();

const GuardPermitRequiredDecisionSchema = z.object({
  decision: z.literal("PERMIT_REQUIRED"),
  operation_id: OperationIdSchema,
  request_id: RequestIdSchema,
  summary: GuardSummarySchema,
  approval_command: z.string().min(1).max(96),
  approval_expires_at: OffsetDateTimeSchema,
  journal_warning: GuardJournalWarningSchema.optional(),
}).strict();

const GuardDenyDecisionSchema = z.object({
  decision: z.literal("DENY"),
  code: GuardDenyCodeSchema,
  reason: ErrorReasonSchema.optional(),
  task_id: TaskIdSchema.optional(),
  claim_id: canonicalId("clm").optional(),
  summary: GuardSummarySchema,
  journal_warning: GuardJournalWarningSchema.optional(),
}).strict();

export const GuardDecisionSchema = z.discriminatedUnion("decision", [
  GuardAllowDecisionSchema,
  GuardPermitRequiredDecisionSchema,
  GuardDenyDecisionSchema,
]).superRefine((decision, context) => {
  if (
    decision.decision === "PERMIT_REQUIRED" &&
    decision.approval_command !== `/jhw:unlock ${decision.request_id}`
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approval_command"],
      message: "Approval command must exactly identify its request",
    });
  }
});
export type GuardDecision = z.infer<typeof GuardDecisionSchema>;

export const BoardIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const BoardModeSchema = z.enum(["exclusive", "shared"]);
export type BoardMode = z.infer<typeof BoardModeSchema>;

// Display-only connection metadata: it never participates in lock decisions,
// and the address is deliberately an opaque bounded string (a serial device
// path or an IP), never parsed and never a credential.
export const BoardInterfaceSchema = z
  .object({
    type: z.enum(["ethernet", "wireless", "serial"]),
    address: boundedCoordinate(255),
  })
  .strict();
export type BoardInterface = z.infer<typeof BoardInterfaceSchema>;

export const BoardHolderSchema = z
  .object({
    holder_id: canonicalId("hld"),
    session: ClaimCoordinateSchema,
    pid: z.number().int().gt(1).nullable(),
    pid_start_time: boundedCoordinate(64).nullable(),
    boot_id: boundedCoordinate(64).nullable(),
    mode: BoardModeSchema,
    purpose: boundedCoordinate(255),
    acquired_at: OffsetDateTimeSchema,
    granted_until: OffsetDateTimeSchema,
    extended_after_expiry: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((holder, context) => {
    // The liveness trio is atomic: a pid without its reuse fences would revive
    // the pid-recycling misjudgement the fences exist to block.
    const nulls = [holder.pid, holder.pid_start_time, holder.boot_id].filter((value) => value === null).length;
    if (nulls !== 0 && nulls !== 3) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["pid"], message: "pid, pid_start_time, boot_id are recorded atomically" });
    }
  });
export type BoardHolder = z.infer<typeof BoardHolderSchema>;

export const BoardReservationSchema = z
  .object({
    reservation_id: canonicalId("rsv"),
    session: ClaimCoordinateSchema,
    mode: BoardModeSchema,
    from: OffsetDateTimeSchema,
    to: OffsetDateTimeSchema,
    purpose: boundedCoordinate(255),
    created_at: OffsetDateTimeSchema,
    consumed_by: canonicalId("hld").nullable(),
  })
  .strict();
export type BoardReservation = z.infer<typeof BoardReservationSchema>;

export const BoardRecordSchema = z
  .object({
    description: boundedCoordinate(255).optional(),
    interfaces: z.array(BoardInterfaceSchema).max(8),
    registered_at: OffsetDateTimeSchema,
    holders: z.array(BoardHolderSchema).max(16)
      .refine((holders) => new Set(holders.map((holder) => holder.holder_id)).size === holders.length, "Duplicate holder"),
    reservations: z.array(BoardReservationSchema).max(32)
      .refine((entries) => new Set(entries.map((entry) => entry.reservation_id)).size === entries.length, "Duplicate reservation"),
  })
  .strict();
export type BoardRecord = z.infer<typeof BoardRecordSchema>;

export const BoardStateSchema = z
  .object({
    version: z.literal(1),
    boards: z.record(BoardIdSchema, BoardRecordSchema),
  })
  .strict();
export type BoardState = z.infer<typeof BoardStateSchema>;

/** Deliberately bounded public coordinates for a blocking holder or reservation. */
export const BoardConflictSummarySchema = z
  .object({
    board_id: BoardIdSchema,
    holder_id: canonicalId("hld").optional(),
    reservation_id: canonicalId("rsv").optional(),
    mode: BoardModeSchema,
    purpose: safeClaimConflictText.optional(),
    granted_until: OffsetDateTimeSchema.optional(),
    from: OffsetDateTimeSchema.optional(),
    to: OffsetDateTimeSchema.optional(),
  })
  .strict();
export type BoardConflictSummary = z.infer<typeof BoardConflictSummarySchema>;

export const ClaimHistorySchema = z
  .object({
    task_id: canonicalId("tsk"),
    task_alias: taskAlias.optional(),
    project_id: projectId,
    repo_id: repositoryId,
    claim_id: canonicalId("clm"),
    predecessor_claim_id: canonicalId("clm").optional(),
    origin_adapter: GuardAdapterSchema.optional(),
    session_id: ClaimCoordinateSchema,
    host: ClaimCoordinateSchema,
    branch: ClaimCoordinateSchema,
    worktree_ref: ClaimCoordinateSchema,
    source_task_revision: SourceTaskRevisionSchema,
    started_at: OffsetDateTimeSchema,
    released_at: OffsetDateTimeSchema,
    status: z.enum(["completed", "handoff", "abandoned", "force-ended", "taken-over"]),
    outcome: boundedUtf8(4096).optional(),
    head_sha: boundedCoordinate(128).optional(),
    validation_summary: boundedUtf8(33 * 1024).optional(),
    handoff_path: z.string().max(160).regex(/^handoffs\/tsk-[0-9a-f-]+\/clm-[0-9a-f-]+\.md$/).optional(),
    successor_claim_id: canonicalId("clm").optional(),
    work_contract_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    completion_evidence_path: z.string().max(160).regex(
      /^task-completion\/(tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.yaml$/,
    ).optional(),
    completion_evidence_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .superRefine((history, context) => {
    if (history.successor_claim_id !== undefined && history.status !== "taken-over") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["successor_claim_id"],
        message: "Only taken-over Claim history may identify a successor",
      });
    }
    if (history.status === "completed" && history.outcome === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Completed Claim history requires an outcome" });
    }
    if ((history.handoff_path !== undefined) !== (history.status === "handoff")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["handoff_path"], message: "Only Handoff history carries a Handoff pointer" });
    }
    if ((history.completion_evidence_path !== undefined) !== (history.completion_evidence_digest !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completion_evidence_path"],
        message: "Completion evidence pointer and digest are atomic",
      });
    }
    if (history.completion_evidence_path !== undefined) {
      if (history.status !== "completed") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completion_evidence_path"],
          message: "Only completed Claim history carries completion evidence",
        });
      }
      const match = history.completion_evidence_path.match(
        /^task-completion\/(tsk-[0-9a-f-]+)\/(clm-[0-9a-f-]+)\.yaml$/,
      );
      if (!match || match[1] !== history.task_id || match[2] !== history.claim_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completion_evidence_path"],
          message: "Completion evidence pointer disagrees with Claim history coordinates",
        });
      }
    }
  });
export type ClaimHistory = z.infer<typeof ClaimHistorySchema>;

export const ProjectOperationalFieldsSchema = z
  .object({
    status: z.enum(["proposed", "active", "paused", "completed", "cancelled"]),
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    health: z.enum(["on-track", "at-risk", "blocked", "unknown"]),
    next_action: nextAction,
    last_reviewed: date,
  })
  .strict();
export type ProjectOperationalFields = z.infer<typeof ProjectOperationalFieldsSchema>;

export const RegisterProjectInputSchema = z
  .object({
    project_id: projectId,
    title: z.string().trim().min(1).max(256),
    objective: z.string().trim().min(1).max(4096),
    repo_ids: z.array(repositoryId).min(1).max(64).refine((values) => new Set(values).size === values.length, "Duplicate repo_id"),
    fields: ProjectOperationalFieldsSchema,
  })
  .strict();
export type RegisterProjectInput = z.infer<typeof RegisterProjectInputSchema>;

export const UpdateProjectInputSchema = z
  .object({
    project_id: projectId,
    fields: ProjectOperationalFieldsSchema.partial()
      .refine((fields) => Object.values(fields).some((value) => value !== undefined), "At least one operating field is required"),
  })
  .strict();
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const ProjectRecordBodySchema = z
  .object({
    id: projectId,
    objective: z.string().min(1).max(4096),
    repositories: z.array(repositoryId).min(1).max(64).refine((values) => new Set(values).size === values.length),
  })
  .strict();
export type ProjectRecordBody = z.infer<typeof ProjectRecordBodySchema>;

export const ProjectFieldOptionSchema = z.object({ id: githubApiId, name: z.string().min(1).max(256) }).strict();
export type ProjectFieldOption = z.infer<typeof ProjectFieldOptionSchema>;

export const ProjectFieldDefinitionSchema = z
  .object({
    id: githubApiId,
    name: z.enum(["Status", "Priority", "Health", "Next Action", "Last Reviewed"]),
    data_type: z.enum(["SINGLE_SELECT", "TEXT", "DATE"]),
    options: z.array(ProjectFieldOptionSchema).optional(),
  })
  .strict();
export type ProjectFieldDefinition = z.infer<typeof ProjectFieldDefinitionSchema>;

export const ProjectSnapshotItemSchema = z
  .object({
    project_item_id: githubApiId,
    source_node_id: GithubNodeIdSchema,
    project_id: projectId,
    title: z.string().min(1).max(256),
    objective: z.string().min(1).max(4096),
    repo_ids: z.array(repositoryId).min(1).max(64),
    fields: ProjectOperationalFieldsSchema,
    stale: z.boolean(),
  })
  .strict();
export type ProjectSnapshotItem = z.infer<typeof ProjectSnapshotItemSchema>;

export const ProjectSnapshotSourceSchema = z
  .object({
    project_node_id: githubApiId,
    source_revision: OffsetDateTimeSchema,
    field_definitions: z.array(ProjectFieldDefinitionSchema).length(5),
    items: z.array(ProjectSnapshotItemSchema),
    total_count: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.items.length === value.total_count, "Project source count mismatch");
export type ProjectSnapshotSource = z.infer<typeof ProjectSnapshotSourceSchema>;

export const ProjectRecordLinkSchema = z
  .object({
    project_id: projectId,
    project_item_id: githubApiId,
    source_node_id: GithubNodeIdSchema,
  })
  .strict();
export type ProjectRecordLink = z.infer<typeof ProjectRecordLinkSchema>;

export const ProjectRecordUpdateSchema = ProjectRecordLinkSchema
  .extend({ fields: ProjectOperationalFieldsSchema })
  .strict();
export type ProjectRecordUpdate = z.infer<typeof ProjectRecordUpdateSchema>;

export const PortfolioRepositorySummarySchema = z
  .object({
    repo_id: repositoryId,
    slug: z.string().regex(githubSlugPattern),
    // Registry-record derivation: true reflects the persisted operator opt-in,
    // not the repository's live GitHub visibility.
    allow_public: z.boolean(),
  })
  .strict();
export type PortfolioRepositorySummary = z.infer<typeof PortfolioRepositorySummarySchema>;

export const BoundedPortfolioPayloadSchema = z
  .object({
    page_id: z.string().regex(/^page-[1-9][0-9]*$/),
    markdown: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 12 * 1024),
    items: z.array(ProjectSnapshotItemSchema).max(20),
    // Bounded by the Registry catalog listing limit (maximumCatalogEntries),
    // not the per-project repo_ids cap — the byte envelope is the real gate.
    repositories: z.array(PortfolioRepositorySummarySchema).max(10_000),
    truncated: z.boolean(),
    total_items: z.number().int().nonnegative(),
    next_page_id: z.string().regex(/^page-[1-9][0-9]*$/).optional(),
  })
  .strict()
  .refine((value) => value.truncated === (value.next_page_id !== undefined), "Truncation metadata mismatch");
export type BoundedPortfolioPayload = z.infer<typeof BoundedPortfolioPayloadSchema>;

const snapshotDirectoryPattern = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z";
const snapshotJsonPath = z.string().regex(new RegExp(`^${snapshotDirectoryPattern}/portfolio\\.json$`));
const snapshotMarkdownPath = z.string().regex(new RegExp(`^${snapshotDirectoryPattern}/portfolio\\.md$`));
export const SnapshotExportResultSchema = z
  .object({
    jsonPath: snapshotJsonPath,
    markdownPath: snapshotMarkdownPath,
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type SnapshotExportResult = z.infer<typeof SnapshotExportResultSchema>;

export const PreflightResultSchema = z
  .object({
    status: z.literal("ready"),
    checks: z
      .object({
        credentials: z.literal("ok"),
        authority: z.literal("ok"),
        notion_guard: z.literal("ok"),
        project: z.literal("ok"),
        registry_repository: z.literal("ok"),
        registry_issue: z.literal("ok"),
        registry_git: z.literal("ok"),
      })
      .strict(),
  })
  .strict();
export type PreflightResult = z.infer<typeof PreflightResultSchema>;
