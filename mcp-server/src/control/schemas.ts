import { z } from "zod";

const canonicalId = (prefix: "prj" | "repo" | "tsk" | "clm") =>
  z.string().regex(new RegExp(`^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));

const projectId = z.string().regex(/^prj-[a-z0-9][a-z0-9-]{1,62}$/);
const repositoryId = z.string().regex(/^repo-[a-z0-9][a-z0-9-]{1,62}$/);
const timestamp = z.string().min(1);

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
    id: z.string().min(1),
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
    next_action: z.string().min(1),
    last_reviewed: z.string().min(1),
  })
  .strict();
export type ProjectOperationalFields = z.infer<typeof ProjectOperationalFieldsSchema>;
