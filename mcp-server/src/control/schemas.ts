import { z } from "zod";

const canonicalId = (prefix: "prj" | "repo" | "tsk" | "clm") =>
  z.string().regex(new RegExp(`^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));

const projectId = z.string().regex(/^prj-[a-z0-9][a-z0-9-]{1,62}$/);
const repositoryId = z.string().regex(/^repo-[a-z0-9][a-z0-9-]{1,62}$/);
const timestamp = z.string().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const nextAction = z.string().max(165).refine(
  (value) => /^task:tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
    /^wait:[^\u0000-\u001f\u007f]{1,160}$/.test(value),
  "Invalid Next Action",
);

export const AuthorityRecordSchema = z
  .object({
    authority_epoch: z.number().int().nonnegative(),
    mode: z.enum(["legacy", "registry"]),
    cutover_at: timestamp.nullable(),
    minimum_tool_version: z.string().min(1),
  })
  .strict();
export type AuthorityRecord = z.infer<typeof AuthorityRecordSchema>;

export const RepositoryRecordSchema = z
  .object({
    id: repositoryId,
    github_node_id: z.string().min(1),
    slug: z.string().min(1),
  })
  .strict();
export type RepositoryRecord = z.infer<typeof RepositoryRecordSchema>;

const taskBase = {
  id: canonicalId("tsk"),
  project_id: projectId,
  repo_id: repositoryId,
  aliases: z.array(z.string().min(1)),
};

export const FormalTaskSchema = z
  .object({
    ...taskBase,
    kind: z.literal("formal"),
    issue_node_id: z.string().min(1),
    issue_revision: z.string().min(1),
    issue_url: z.string().url(),
  })
  .strict();
export type FormalTask = z.infer<typeof FormalTaskSchema>;

export const TemporaryTaskSchema = z
  .object({
    ...taskBase,
    kind: z.literal("temporary"),
    goal: z.string().min(1),
    done_conditions: z.array(z.string().min(1)).min(1),
    expected_scope: z.array(z.string().min(1)).min(1),
    lifecycle: z.string().min(1),
  })
  .strict();
export type TemporaryTask = z.infer<typeof TemporaryTaskSchema>;

export const TaskRecordSchema = z.discriminatedUnion("kind", [FormalTaskSchema, TemporaryTaskSchema]);
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const ActiveClaimSchema = z
  .object({
    task_id: canonicalId("tsk"),
    task_alias: z.string().min(1),
    project_id: projectId,
    repo_id: repositoryId,
    claim_id: canonicalId("clm"),
    session_id: z.string().min(1),
    host: z.string().min(1),
    branch: z.string().min(1),
    worktree_ref: z.string().min(1),
    started_at: timestamp,
  })
  .strict();
export type ActiveClaim = z.infer<typeof ActiveClaimSchema>;

export const ClaimHistorySchema = z
  .object({
    task_id: canonicalId("tsk"),
    task_alias: z.string().min(1).optional(),
    project_id: projectId,
    repo_id: repositoryId,
    claim_id: canonicalId("clm"),
    session_id: z.string().min(1),
    host: z.string().min(1),
    branch: z.string().min(1),
    worktree_ref: z.string().min(1),
    started_at: timestamp,
    released_at: timestamp,
    status: z.enum(["completed", "handoff", "abandoned", "force-ended", "taken-over"]),
    outcome: z.string().optional(),
    head_sha: z.string().optional(),
    validation_summary: z.string().optional(),
    handoff_path: z.string().optional(),
  })
  .strict();
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

export const ProjectFieldOptionSchema = z.object({ id: z.string().min(1), name: z.string().min(1) }).strict();
export type ProjectFieldOption = z.infer<typeof ProjectFieldOptionSchema>;

export const ProjectFieldDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.enum(["Status", "Priority", "Health", "Next Action", "Last Reviewed"]),
    data_type: z.enum(["SINGLE_SELECT", "TEXT", "DATE"]),
    options: z.array(ProjectFieldOptionSchema).optional(),
  })
  .strict();
export type ProjectFieldDefinition = z.infer<typeof ProjectFieldDefinitionSchema>;

export const ProjectSnapshotItemSchema = z
  .object({
    project_item_id: z.string().min(1),
    source_node_id: z.string().min(1),
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
    project_node_id: z.string().min(1),
    source_revision: z.string().min(1),
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
    project_item_id: z.string().min(1),
    source_node_id: z.string().min(1),
    issue_number: z.number().int().positive(),
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
        project: z.literal("ok"),
        registry_issue: z.literal("ok"),
        registry_git: z.literal("ok"),
      })
      .strict(),
  })
  .strict();
export type PreflightResult = z.infer<typeof PreflightResultSchema>;
