import { z } from "zod";

const canonicalId = (prefix: "prj" | "repo" | "tsk" | "clm") =>
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
const claimCoordinate = boundedCoordinate(255);
const githubNodeId = z.string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 128);
const githubApiId = z.string().min(1).max(256).refine((value) => Buffer.byteLength(value, "utf8") <= 256);
export const SourceTaskRevisionSchema = boundedCoordinate(256);
export const OffsetDateTimeSchema = z.string().min(1).max(64).datetime({ offset: true });
export const TemporaryLifecycleSchema = z.enum(["active", "handoff", "completed", "abandoned"]);
export type TemporaryLifecycle = z.infer<typeof TemporaryLifecycleSchema>;
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
    github_node_id: githubNodeId,
    slug: z.string().regex(githubSlugPattern),
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

export const FormalTaskSchema = z
  .object({
    ...taskBase,
    kind: z.literal("formal"),
    issue_node_id: githubNodeId,
    issue_revision: OffsetDateTimeSchema,
    issue_url: z.string().max(512).url(),
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
  })
  .strict();
export type TemporaryTask = z.infer<typeof TemporaryTaskSchema>;

export const TaskRecordSchema = z.union([FormalTaskSchema, TemporaryTaskSchema]);
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const ActiveClaimSchema = z
  .object({
    task_id: canonicalId("tsk"),
    task_alias: taskAlias,
    project_id: projectId,
    repo_id: repositoryId,
    claim_id: canonicalId("clm"),
    predecessor_claim_id: canonicalId("clm").optional(),
    session_id: claimCoordinate,
    host: claimCoordinate,
    branch: claimCoordinate,
    worktree_ref: claimCoordinate,
    source_task_revision: SourceTaskRevisionSchema,
    started_at: OffsetDateTimeSchema,
  })
  .strict();
export type ActiveClaim = z.infer<typeof ActiveClaimSchema>;

const safeClaimConflictText = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/u);

/** Deliberately bounded public coordinates for an already-owned Task. */
export const ConflictingClaimSummarySchema = ActiveClaimSchema.pick({
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

export const ClaimHistorySchema = z
  .object({
    task_id: canonicalId("tsk"),
    task_alias: taskAlias.optional(),
    project_id: projectId,
    repo_id: repositoryId,
    claim_id: canonicalId("clm"),
    predecessor_claim_id: canonicalId("clm").optional(),
    session_id: claimCoordinate,
    host: claimCoordinate,
    branch: claimCoordinate,
    worktree_ref: claimCoordinate,
    source_task_revision: SourceTaskRevisionSchema,
    started_at: OffsetDateTimeSchema,
    released_at: OffsetDateTimeSchema,
    status: z.enum(["completed", "handoff", "abandoned", "force-ended", "taken-over"]),
    outcome: boundedUtf8(4096).optional(),
    head_sha: boundedCoordinate(128).optional(),
    validation_summary: boundedUtf8(33 * 1024).optional(),
    handoff_path: z.string().max(160).regex(/^handoffs\/tsk-[0-9a-f-]+\/clm-[0-9a-f-]+\.md$/).optional(),
    successor_claim_id: canonicalId("clm").optional(),
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
    source_node_id: githubNodeId,
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
    source_node_id: githubNodeId,
    issue_number: z.number().int().positive().safe(),
  })
  .strict();
export type ProjectRecordLink = z.infer<typeof ProjectRecordLinkSchema>;

export const BoundedPortfolioPayloadSchema = z
  .object({
    page_id: z.string().regex(/^page-[1-9][0-9]*$/),
    markdown: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 12 * 1024),
    items: z.array(ProjectSnapshotItemSchema).max(20),
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
