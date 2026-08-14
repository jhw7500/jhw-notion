import { join } from "node:path";

import { z, type ZodType } from "zod";

import { RegistryRecordStore } from "./codec.js";
import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { newTaskId, sourceIndexKey } from "./ids.js";
import { RegistryGit, type RegistryMutationResult } from "./registry-git.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import {
  FormalTaskSchema,
  RepositoryRecordSchema,
  TaskRecordSchema,
  TemporaryTaskSchema,
  type FormalTask,
  type RepositoryRecord,
  type TaskRecord,
  type TemporaryTask,
  type TemporaryLifecycle,
} from "./schemas.js";

const projectIdPattern = /^prj-[a-z0-9][a-z0-9-]{1,62}$/;
const repositoryIdPattern = /^repo-[a-z0-9][a-z0-9-]{1,62}$/;
const taskIdPattern = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const githubSlugPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const safeAliasPattern = /^[^\u0000-\u001f\u007f]{1,160}$/;
const formalAliasPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]*$/;
const maximumCatalogEntries = 10_000;
const githubNodeId = z.string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 128);

const RepositorySourceIndexSchema = z.object({ repo_id: z.string().regex(repositoryIdPattern) }).strict();
const TaskSourceIndexSchema = z.object({ task_id: z.string().regex(taskIdPattern) }).strict();

const RegisterRepositoryInputSchema = z.object({
  repo_id: z.string().regex(repositoryIdPattern),
  github_node_id: githubNodeId,
  slug: z.string().regex(githubSlugPattern),
}).strict();

const RegisterFormalTaskInputSchema = z.object({
  project_id: z.string().regex(projectIdPattern),
  repo_id: z.string().regex(repositoryIdPattern),
  issue_node_id: githubNodeId,
  issue_revision: z.string().datetime({ offset: true }),
  issue_url: z.string().url(),
  alias: z.string().regex(formalAliasPattern),
}).strict();

const RegisterTemporaryTaskInputSchema = z.object({
  project_id: z.string().regex(projectIdPattern),
  repo_id: z.string().regex(repositoryIdPattern),
  alias: z.string().regex(safeAliasPattern),
  goal: z.string().min(1),
  done_conditions: z.array(z.string().min(1)).min(1),
  expected_scope: z.array(z.string().min(1)).min(1),
}).strict();

export interface RegisterRepositoryInput {
  repo_id: string;
  github_node_id: string;
  slug: string;
}

export interface RegisterFormalTaskInput {
  project_id: string;
  repo_id: string;
  issue_node_id: string;
  issue_revision: string;
  issue_url: string;
  alias: string;
}

export interface RegisterTemporaryTaskInput {
  project_id: string;
  repo_id: string;
  alias: string;
  goal: string;
  done_conditions: string[];
  expected_scope: string[];
}

export interface RepositoryRegistration {
  repository: RepositoryRecord;
  created: boolean;
}

export interface FormalTaskRegistration {
  task: FormalTask;
  created: boolean;
}

function repositoryRelativePath(repoId: string): string {
  return `repositories/${repoId}.yaml`;
}

function repositorySourceRelativePath(githubNodeId: string): string {
  return `repositories/by-source/github/${sourceIndexKey(githubNodeId)}.yaml`;
}

function taskRelativePath(taskId: string): string {
  return `tasks/${taskId}.yaml`;
}

function taskSourceRelativePath(githubNodeId: string): string {
  return `tasks/by-source/github/${sourceIndexKey(githubNodeId)}.yaml`;
}

function parseInput<T>(schema: ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ControlError(code, "Invalid Catalog input");
}

function record<T>(schema: ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ControlError(code, "Invalid Catalog record");
}

function corruption(message: string, details: Record<string, unknown>): ControlError {
  return new ControlError("REGISTRY_CORRUPT", message, details);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function distinctAliases(aliases: readonly string[], alias: string): string[] {
  return [...new Set([...aliases, alias])];
}

function assertTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId)) {
    throw new ControlError("INVALID_TASK_ID", "Invalid canonical Task ID", { taskId });
  }
}

function assertRepositoryId(repoId: string): void {
  if (!repositoryIdPattern.test(repoId)) {
    throw new ControlError("INVALID_REPOSITORY_ID", "Invalid canonical Repository ID", { repoId });
  }
}

/** Canonical Registry catalog with source-index collision protection. */
export class Catalog {
  readonly records: RegistryRecordStore;
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(
    private readonly config: ControlConfig,
    private readonly registry: RegistryGit,
    sensitiveData?: SensitiveDataPolicy,
  ) {
    this.records = new RegistryRecordStore(config.registryDir, registry);
    this.sensitiveData = sensitiveData ?? createSensitiveDataPolicy(process.env, [
      config.registryDir,
      config.stateDir,
      config.worktreeRoot,
    ]);
  }

  async registerRepository(rawInput: RegisterRepositoryInput): Promise<RepositoryRegistration> {
    this.sensitiveData.assertSafe(rawInput);
    const input = parseInput(RegisterRepositoryInputSchema, rawInput, "INVALID_REPOSITORY");
    let registration: RepositoryRegistration | undefined;
    await this.registry.transact(`registry: register repository ${input.repo_id}`, async () => {
      await this.auditRepositorySourceIndexes();
      const sourcePath = repositorySourceRelativePath(input.github_node_id);
      const indexed = await this.repositoryForSource(sourcePath, input.github_node_id);
      if (indexed) {
        if (indexed.repoId !== input.repo_id) {
          throw new ControlError("SOURCE_ALREADY_MAPPED", "GitHub Repository source is already mapped to another repo_id", {
            github_node_id: input.github_node_id,
            existing_repo_id: indexed.repoId,
            requested_repo_id: input.repo_id,
          });
        }
        if (indexed.repository.slug === input.slug) {
          registration = { repository: indexed.repository, created: false };
          return noChanges();
        }
        await this.assertRepositoryRenameAllowed(indexed.repository.id);
        const renamed = record(
          RepositoryRecordSchema,
          { ...indexed.repository, slug: input.slug },
          "INVALID_REPOSITORY",
        );
        await this.records.writeJson(repositoryRelativePath(renamed.id), renamed);
        registration = { repository: renamed, created: false };
        return stage([repositoryRelativePath(renamed.id)]);
      }

      const existing = await this.repositoryAt(input.repo_id);
      if (existing) {
        if (existing.github_node_id !== input.github_node_id) {
          throw new ControlError("REPOSITORY_ID_COLLISION", "repo_id is already mapped to another GitHub Repository", {
            repo_id: input.repo_id,
            existing_github_node_id: existing.github_node_id,
            requested_github_node_id: input.github_node_id,
          });
        }
        if (existing.slug !== input.slug) await this.assertRepositoryRenameAllowed(existing.id);
        const renamed = existing.slug === input.slug
          ? existing
          : record(RepositoryRecordSchema, { ...existing, slug: input.slug }, "INVALID_REPOSITORY");
        if (renamed !== existing) await this.records.writeJson(repositoryRelativePath(renamed.id), renamed);
        await this.records.writeJson(sourcePath, { repo_id: renamed.id });
        registration = { repository: renamed, created: false };
        return stage([
          ...(renamed === existing ? [] : [repositoryRelativePath(renamed.id)]),
          repositorySourceRelativePath(input.github_node_id),
        ]);
      }

      const repository = record(
        RepositoryRecordSchema,
        { id: input.repo_id, github_node_id: input.github_node_id, slug: input.slug },
        "INVALID_REPOSITORY",
      );
      await this.records.writeJson(repositoryRelativePath(repository.id), repository);
      await this.records.writeJson(sourcePath, { repo_id: repository.id });
      registration = { repository, created: true };
      return stage([repositoryRelativePath(repository.id), repositorySourceRelativePath(repository.github_node_id)]);
    });

    return requiredRegistration(registration);
  }

  async registerFormalTask(rawInput: RegisterFormalTaskInput): Promise<FormalTaskRegistration> {
    this.sensitiveData.assertSafe(rawInput);
    const input = parseInput(RegisterFormalTaskInputSchema, rawInput, "INVALID_FORMAL_TASK");
    let registration: FormalTaskRegistration | undefined;
    await this.registry.transact(`registry: register formal task ${input.alias}`, async () => {
      await this.auditRepositorySourceIndexes();
      await this.requireRepository(input.repo_id);
      await this.auditTaskSourceIndexes();
      const sourcePath = taskSourceRelativePath(input.issue_node_id);
      const indexed = await this.formalTaskForSource(sourcePath, input.issue_node_id);
      await this.assertAliasAvailable(input.alias, indexed?.taskId);
      if (indexed) {
        const current = indexed.task;
        if (
          current.project_id !== input.project_id ||
          current.repo_id !== input.repo_id ||
          current.issue_node_id !== input.issue_node_id ||
          current.issue_url !== input.issue_url
        ) {
          throw new ControlError("FORMAL_TASK_SOURCE_MISMATCH", "Formal Task immutable source coordinates disagree");
        }
        const currentRevision = Date.parse(current.issue_revision);
        const requestedRevision = Date.parse(input.issue_revision);
        if (requestedRevision < currentRevision) {
          throw new ControlError("STALE_SOURCE_REVISION", "Verified Issue revision is older than the canonical Task revision");
        }
        const aliases = distinctAliases(current.aliases, input.alias);
        if (requestedRevision === currentRevision && aliases.length === current.aliases.length) {
          registration = { task: current, created: false };
          return noChanges();
        }
        const updated = record(FormalTaskSchema, {
          ...current,
          aliases,
          issue_revision: input.issue_revision,
        }, "INVALID_FORMAL_TASK");
        await this.records.writeJson(taskRelativePath(updated.id), updated);
        registration = { task: updated, created: false };
        return stage([taskRelativePath(updated.id)]);
      }

      const task = record(
        FormalTaskSchema,
        {
          id: newTaskId(),
          kind: "formal",
          project_id: input.project_id,
          repo_id: input.repo_id,
          aliases: [input.alias],
          issue_node_id: input.issue_node_id,
          issue_revision: input.issue_revision,
          issue_url: input.issue_url,
        },
        "INVALID_FORMAL_TASK",
      );
      await this.records.writeJson(taskRelativePath(task.id), task);
      await this.records.writeJson(sourcePath, { task_id: task.id });
      registration = { task, created: true };
      return stage([taskRelativePath(task.id), taskSourceRelativePath(input.issue_node_id)]);
    });

    return requiredRegistration(registration);
  }

  async registerTemporaryTask(rawInput: RegisterTemporaryTaskInput): Promise<TemporaryTask> {
    this.sensitiveData.assertSafe(rawInput);
    const input = parseInput(RegisterTemporaryTaskInputSchema, rawInput, "INVALID_TEMPORARY_TASK");
    let task: TemporaryTask | undefined;
    await this.registry.transact(`registry: register temporary task ${input.alias}`, async () => {
      await this.auditRepositorySourceIndexes();
      await this.requireRepository(input.repo_id);
      const aliases = await this.tasksForAlias(input.alias);
      if (aliases.length > 1) throw corruption("Temporary Task alias is mapped more than once", { alias: input.alias });
      if (aliases.length === 1) {
        const existing = aliases[0] as TaskRecord;
        if (existing.kind !== "temporary") {
          throw new ControlError("TEMPORARY_ALIAS_CONFLICT", "Temporary Task alias already belongs to a formal Task");
        }
        if (
          existing.project_id !== input.project_id || existing.repo_id !== input.repo_id ||
          existing.goal !== input.goal || existing.lifecycle !== "active" ||
          JSON.stringify(existing.done_conditions) !== JSON.stringify(input.done_conditions) ||
          JSON.stringify(existing.expected_scope) !== JSON.stringify(input.expected_scope)
        ) {
          throw new ControlError("TEMPORARY_ALIAS_CONFLICT", "Temporary Task alias already identifies different work");
        }
        task = existing;
        return noChanges();
      }
      task = record(
        TemporaryTaskSchema,
        {
          id: newTaskId(),
          kind: "temporary",
          project_id: input.project_id,
          repo_id: input.repo_id,
          aliases: [input.alias],
          goal: input.goal,
          done_conditions: input.done_conditions,
          expected_scope: input.expected_scope,
          lifecycle: "active",
        },
        "INVALID_TEMPORARY_TASK",
      );
      await this.records.writeJson(taskRelativePath(task.id), task);
      return stage([taskRelativePath(task.id)]);
    });

    if (!task) throw new Error("Temporary Task registration did not produce a record");
    return task;
  }

  async promoteTemporaryTask(taskId: string, rawInput: RegisterFormalTaskInput): Promise<FormalTask> {
    assertTaskId(taskId);
    this.sensitiveData.assertSafe(rawInput);
    const input = parseInput(RegisterFormalTaskInputSchema, rawInput, "INVALID_FORMAL_TASK");
    let promoted: FormalTask | undefined;
    await this.registry.transact(`registry: promote temporary task ${taskId}`, async () => {
      await this.auditRepositorySourceIndexes();
      await this.requireRepository(input.repo_id);
      await this.auditTaskSourceIndexes();
      const sourcePath = taskSourceRelativePath(input.issue_node_id);
      const indexed = await this.formalTaskForSource(sourcePath, input.issue_node_id);
      if (indexed && indexed.taskId !== taskId) {
        throw new ControlError("SOURCE_ALREADY_MAPPED", "GitHub Issue source is already mapped to another Task", {
          issue_node_id: input.issue_node_id,
          existing_task_id: indexed.taskId,
          requested_task_id: taskId,
        });
      }
      await this.assertAliasAvailable(input.alias, taskId);

      const current = await this.taskAt(taskId);
      if (current.kind === "formal") {
        if (
          current.project_id !== input.project_id ||
          current.repo_id !== input.repo_id ||
          current.issue_node_id !== input.issue_node_id ||
          current.issue_url !== input.issue_url
        ) {
          throw new ControlError("FORMAL_TASK_SOURCE_MISMATCH", "Formal Task immutable source coordinates disagree");
        }
        const currentRevision = Date.parse(current.issue_revision);
        const requestedRevision = Date.parse(input.issue_revision);
        if (requestedRevision < currentRevision) {
          throw new ControlError("STALE_SOURCE_REVISION", "Verified Issue revision is older than the canonical Task revision");
        }
        const aliases = distinctAliases(current.aliases, input.alias);
        const changedTask = requestedRevision !== currentRevision || aliases.length !== current.aliases.length;
        promoted = changedTask
          ? record(FormalTaskSchema, { ...current, aliases, issue_revision: input.issue_revision }, "INVALID_FORMAL_TASK")
          : current;
        if (changedTask) await this.records.writeJson(taskRelativePath(current.id), promoted);
        if (!indexed) await this.records.writeJson(sourcePath, { task_id: current.id });
        const paths = [
          ...(changedTask ? [taskRelativePath(current.id)] : []),
          ...(!indexed ? [taskSourceRelativePath(input.issue_node_id)] : []),
        ];
        return paths.length > 0 ? stage(paths) : noChanges();
      }

      if (current.lifecycle === "completed") {
        throw new ControlError("TASK_COMPLETED", "Completed temporary Tasks cannot be promoted");
      }

      if (current.project_id !== input.project_id || current.repo_id !== input.repo_id) {
        throw new ControlError("TASK_SCOPE_MISMATCH", "Temporary Task project/repository does not match the GitHub Issue", {
          task_id: taskId,
          task_project_id: current.project_id,
          task_repo_id: current.repo_id,
          issue_project_id: input.project_id,
          issue_repo_id: input.repo_id,
        });
      }

      const formal = record(
        FormalTaskSchema,
        {
          id: current.id,
          kind: "formal",
          project_id: input.project_id,
          repo_id: input.repo_id,
          aliases: distinctAliases(current.aliases, input.alias),
          issue_node_id: input.issue_node_id,
          issue_revision: input.issue_revision,
          issue_url: input.issue_url,
        },
        "INVALID_FORMAL_TASK",
      );
      await this.records.writeJson(taskRelativePath(current.id), formal);
      if (!indexed) await this.records.writeJson(sourcePath, { task_id: current.id });
      promoted = formal;
      return stage([
        taskRelativePath(current.id),
        ...(indexed ? [] : [taskSourceRelativePath(input.issue_node_id)]),
      ]);
    });

    if (!promoted) throw new Error("Temporary Task promotion did not produce a formal record");
    return promoted;
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    assertTaskId(taskId);
    await this.auditTaskSourceIndexes();
    return this.taskAt(taskId);
  }

  async getTaskSourceRevision(taskId: string): Promise<string> {
    const task = await this.getTask(taskId);
    return task.kind === "formal"
      ? task.issue_revision
      : this.registry.headRegularBlobObjectId(taskRelativePath(task.id));
  }

  /** Mutates a temporary lifecycle only inside the caller's Registry transaction. */
  async transitionTemporaryLifecycle(taskId: string, lifecycle: TemporaryLifecycle): Promise<string[]> {
    const current = await this.taskAt(taskId);
    if (current.kind === "formal") return [];
    if (current.lifecycle === "completed" && lifecycle !== "completed") {
      throw new ControlError("TASK_COMPLETED", "Completed temporary Tasks cannot transition or be reclaimed");
    }
    if (current.lifecycle === lifecycle) return [];
    const updated = record(TemporaryTaskSchema, { ...current, lifecycle }, "INVALID_TEMPORARY_TASK");
    await this.records.writeJson(taskRelativePath(updated.id), updated);
    return [taskRelativePath(updated.id)];
  }

  async getRepository(repoId: string): Promise<RepositoryRecord> {
    assertRepositoryId(repoId);
    await this.auditRepositorySourceIndexes();
    const repository = await this.repositoryAt(repoId);
    if (!repository) throw new ControlError("REPOSITORY_NOT_FOUND", "Canonical Repository record does not exist", { repo_id: repoId });
    if (repository) this.sensitiveData.assertSafe(repository);
    return repository;
  }

  private async repositoryForSource(
    sourceIndexPath: string,
    expectedGithubNodeId: string,
  ): Promise<{ repoId: string; repository: RepositoryRecord } | undefined> {
    const source = await this.sourceIndex(sourceIndexPath, RepositorySourceIndexSchema);
    if (!source) return undefined;
    const repository = await this.repositoryAt(source.repo_id, sourceIndexPath);
    if (!repository) {
      throw corruption("Repository source index points to a missing record", {
        sourceIndexPath,
        recordPath: join(this.config.registryDir, repositoryRelativePath(source.repo_id)),
        expectedRecordId: source.repo_id,
      });
    }
    if (repository.github_node_id !== expectedGithubNodeId) {
      throw corruption("Repository source index and canonical record disagree on GitHub node ID", {
        sourceIndexPath,
        recordPath: join(this.config.registryDir, repositoryRelativePath(source.repo_id)),
        expectedRecordId: source.repo_id,
        actualRecordId: repository.id,
        expectedGithubNodeId,
        actualGithubNodeId: repository.github_node_id,
      });
    }
    return { repoId: source.repo_id, repository };
  }

  private async formalTaskForSource(
    sourceIndexPath: string,
    expectedIssueNodeId: string,
  ): Promise<{ taskId: string; task: FormalTask } | undefined> {
    const source = await this.sourceIndex(sourceIndexPath, TaskSourceIndexSchema);
    if (!source) return undefined;
    const task = await this.taskAt(source.task_id, sourceIndexPath);
    if (task.kind !== "formal") {
      throw corruption("Task source index points to a non-formal Task", {
        sourceIndexPath,
        recordPath: join(this.config.registryDir, taskRelativePath(source.task_id)),
        expectedRecordId: source.task_id,
        actualRecordId: task.id,
        actualKind: task.kind,
      });
    }
    if (task.issue_node_id !== expectedIssueNodeId) {
      throw corruption("Task source index and canonical record disagree on Issue node ID", {
        sourceIndexPath,
        recordPath: join(this.config.registryDir, taskRelativePath(source.task_id)),
        expectedRecordId: source.task_id,
        actualRecordId: task.id,
        expectedIssueNodeId,
        actualIssueNodeId: task.issue_node_id,
      });
    }
    return { taskId: source.task_id, task };
  }

  private async sourceIndex<T>(path: string, schema: ZodType<T>): Promise<T | undefined> {
    try {
      return await this.records.readOptionalJson(path, schema);
    } catch (cause) {
      throw corruption("Registry source index is invalid", {
        sourceIndexPath: join(this.config.registryDir, path),
        cause: errorMessage(cause),
      });
    }
  }

  private async repositoryAt(repoId: string, sourceIndexPath?: string): Promise<RepositoryRecord | undefined> {
    const relativePath = repositoryRelativePath(repoId);
    const recordPath = join(this.config.registryDir, relativePath);
    let repository: RepositoryRecord | undefined;
    try {
      repository = await this.records.readOptionalJson(relativePath, RepositoryRecordSchema, { field: "id", value: repoId });
    } catch (cause) {
      throw corruption("Repository record referenced by Registry is invalid", {
        sourceIndexPath,
        recordPath,
        expectedRecordId: repoId,
        cause: errorMessage(cause),
      });
    }
    if (repository && repository.id !== repoId) {
      throw corruption("Repository record path and embedded ID disagree", {
        sourceIndexPath,
        recordPath,
        expectedRecordId: repoId,
        actualRecordId: repository.id,
      });
    }
    return repository;
  }

  private async requireRepository(repoId: string): Promise<RepositoryRecord> {
    const repository = await this.repositoryAt(repoId);
    if (!repository) {
      throw new ControlError("REPOSITORY_NOT_FOUND", "Canonical Repository record does not exist", { repo_id: repoId });
    }
    return repository;
  }

  private async tasksForAlias(alias: string): Promise<TaskRecord[]> {
    const names = await this.records.listRegularFileNames("tasks", maximumCatalogEntries);
    const matches: TaskRecord[] = [];
    for (const name of names) {
      if (!/^tsk-[0-9a-f-]+\.yaml$/.test(name)) {
        throw corruption("Task directory contains a non-canonical record name", { entry: name });
      }
      const id = name.slice(0, -".yaml".length);
      if (!taskIdPattern.test(id)) throw corruption("Task directory contains a malformed Task ID", { entry: name });
      const task = await this.taskAt(id);
      if (task.aliases.includes(alias)) matches.push(task);
    }
    return matches;
  }

  private async assertAliasAvailable(alias: string, ownerTaskId?: string): Promise<void> {
    const matches = await this.tasksForAlias(alias);
    if (matches.length > 1) throw corruption("Task alias is mapped more than once", { alias });
    const owner = matches[0];
    if (owner && owner.id !== ownerTaskId) {
      throw new ControlError("TASK_ALIAS_CONFLICT", "Task alias already belongs to another canonical Task");
    }
  }

  private async assertRepositoryRenameAllowed(repoId: string): Promise<void> {
    await this.auditTaskSourceIndexes();
    const names = await this.records.listRegularFileNames("tasks", maximumCatalogEntries);
    for (const name of names) {
      if (!/^tsk-[0-9a-f-]+\.yaml$/.test(name)) {
        throw corruption("Task directory contains a non-canonical record name", { entry: name });
      }
      const taskId = name.slice(0, -".yaml".length);
      if (!taskIdPattern.test(taskId)) throw corruption("Task directory contains a malformed Task ID", { entry: name });
      const task = await this.taskAt(taskId);
      if (task.kind === "formal" && task.repo_id === repoId) {
        throw new ControlError(
          "REPOSITORY_RENAME_CONFLICT",
          "Repository slug cannot change while canonical formal Tasks depend on it",
        );
      }
    }
  }

  private async auditTaskSourceIndexes(): Promise<void> {
    const directory = "tasks/by-source/github";
    const indexEntries = await this.records.listDirectoryEntries(directory, maximumCatalogEntries);
    const seenSources = new Set<string>();
    const seenTasks = new Set<string>();
    for (const entry of indexEntries) {
      if (entry.kind !== "file") throw corruption("Task source index contains a non-file entry", { entry: entry.name });
      const name = entry.name;
      if (!/^[A-Za-z0-9_-]+\.yaml$/.test(name)) {
        throw corruption("Task source index has a malformed filename", { entry: name });
      }
      const path = `${directory}/${name}`;
      const source = await this.sourceIndex(path, TaskSourceIndexSchema);
      if (!source) throw corruption("Task source index disappeared during audit", { sourceIndexPath: path });
      const task = await this.taskAt(source.task_id, path);
      if (task.kind !== "formal" || `${sourceIndexKey(task.issue_node_id)}.yaml` !== name) {
        throw corruption("Task source index filename and canonical source disagree", { sourceIndexPath: path });
      }
      if (seenSources.has(task.issue_node_id) || seenTasks.has(task.id)) {
        throw corruption("Task source index is duplicated", { sourceIndexPath: path });
      }
      seenSources.add(task.issue_node_id);
      seenTasks.add(task.id);
    }
    const taskEntries = await this.records.listDirectoryEntries("tasks", maximumCatalogEntries);
    const seenAliases = new Set<string>();
    for (const entry of taskEntries) {
      if (entry.kind === "directory") {
        if (entry.name !== "by-source") throw corruption("Task directory contains an unexpected subdirectory", { entry: entry.name });
        continue;
      }
      if (!/^tsk-[0-9a-f-]+\.yaml$/.test(entry.name)) {
        throw corruption("Task directory contains a non-canonical record name", { entry: entry.name });
      }
      const id = entry.name.slice(0, -".yaml".length);
      if (!taskIdPattern.test(id)) throw corruption("Task directory contains a malformed Task ID", { entry: entry.name });
      const task = await this.taskAt(id);
      for (const alias of task.aliases) {
        if (seenAliases.has(alias)) throw corruption("Task alias is mapped more than once", { alias });
        seenAliases.add(alias);
      }
      if (task.kind === "formal" && !seenTasks.has(task.id)) {
        throw corruption("Formal Task record has no exact source index", { task_id: task.id });
      }
      if (task.kind === "temporary" && seenTasks.has(task.id)) {
        throw corruption("Temporary Task is referenced by a formal source index", { task_id: task.id });
      }
    }
  }

  private async auditRepositorySourceIndexes(): Promise<void> {
    const directory = "repositories/by-source/github";
    const indexEntries = await this.records.listDirectoryEntries(directory, maximumCatalogEntries);
    const seenRepositories = new Set<string>();
    for (const entry of indexEntries) {
      if (entry.kind !== "file" || !/^[A-Za-z0-9_-]+\.yaml$/.test(entry.name)) {
        throw corruption("Repository source index contains a malformed entry", { entry: entry.name });
      }
      const path = `${directory}/${entry.name}`;
      const source = await this.sourceIndex(path, RepositorySourceIndexSchema);
      if (!source) throw corruption("Repository source index disappeared during audit", { sourceIndexPath: path });
      const repository = await this.repositoryAt(source.repo_id, path);
      if (!repository) {
        throw corruption("Repository source index points to a missing record", {
          sourceIndexPath: path,
          expectedRecordId: source.repo_id,
        });
      }
      if (`${sourceIndexKey(repository.github_node_id)}.yaml` !== entry.name) {
        throw corruption("Repository source index and canonical source disagree", {
          sourceIndexPath: path,
          expectedRecordId: repository.id,
        });
      }
      if (seenRepositories.has(repository.id)) {
        throw corruption("Repository source index is duplicated", { sourceIndexPath: path });
      }
      seenRepositories.add(repository.id);
    }
    const repositoryEntries = await this.records.listDirectoryEntries("repositories", maximumCatalogEntries);
    for (const entry of repositoryEntries) {
      if (entry.kind === "directory") {
        if (entry.name !== "by-source") {
          throw corruption("Repository directory contains an unexpected subdirectory", { entry: entry.name });
        }
        continue;
      }
      const match = entry.name.match(/^(repo-[a-z0-9][a-z0-9-]{1,62})\.yaml$/);
      if (!match) throw corruption("Repository directory contains a malformed record", { entry: entry.name });
      const repository = await this.repositoryAt(match[1] as string);
      if (!repository || !seenRepositories.has(repository.id)) {
        throw corruption("Repository record has no exact source index", { repo_id: match[1] });
      }
    }
  }

  private async taskAt(taskId: string, sourceIndexPath?: string): Promise<TaskRecord> {
    const relativePath = taskRelativePath(taskId);
    const recordPath = join(this.config.registryDir, relativePath);
    let task: TaskRecord;
    try {
      task = await this.records.readJson(relativePath, TaskRecordSchema, { field: "id", value: taskId });
    } catch (cause) {
      throw corruption("Task record referenced by Registry is invalid or missing", {
        sourceIndexPath,
        recordPath,
        expectedRecordId: taskId,
        cause: errorMessage(cause),
      });
    }
    if (task.id !== taskId) {
      throw corruption("Task record path and embedded ID disagree", {
        sourceIndexPath,
        recordPath,
        expectedRecordId: taskId,
        actualRecordId: task.id,
      });
    }
    this.sensitiveData.assertSafe(task);
    return task;
  }
}

function noChanges(): RegistryMutationResult {
  return { paths: [] };
}

function stage(paths: string[]): RegistryMutationResult {
  return { paths };
}

function requiredRegistration<T>(registration: T | undefined): T {
  if (!registration) throw new Error("Catalog registration did not produce a result");
  return registration;
}
