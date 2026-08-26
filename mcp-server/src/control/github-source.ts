import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type {
  Catalog,
  FormalTaskRegistration,
  RegisterFormalTaskInput,
  RegisterRepositoryInput,
  RegisterTemporaryTaskInput,
  RepositoryRegistration,
} from "./catalog.js";
import { ControlError } from "./errors.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";
import type { FormalTask, RepositoryRecord, TaskRecord, TemporaryTask } from "./schemas.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";

const repoIdPattern = /^repo-[a-z0-9][a-z0-9-]{1,62}$/;
const projectIdPattern = /^prj-[a-z0-9][a-z0-9-]{1,62}$/;
const taskIdPattern = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const slugPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const githubNodeId = z.string().min(1).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 128);

const RepositoryResponseSchema = z.object({
  node_id: githubNodeId,
  full_name: z.string().regex(slugPattern),
  private: z.boolean(),
}).passthrough();

const IssueResponseSchema = z.object({
  node_id: githubNodeId,
  number: z.number().int().positive().safe(),
  html_url: z.string().url(),
  updated_at: z.string().datetime({ offset: true }),
  state: z.enum(["open", "closed"]),
  pull_request: z.unknown().optional(),
}).passthrough();

export interface GitHubSourceRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
  runGh(args: string[], credential: "project" | "repo", options?: ProcessRunOptions): Promise<ProcessResult>;
}

export interface ProjectMembershipPort {
  requireProjectRepository(projectId: string, repoId: string): Promise<void>;
}

export interface SourceCatalogPort {
  registerRepository(input: RegisterRepositoryInput): Promise<RepositoryRegistration>;
  getRepository(repoId: string): Promise<RepositoryRecord>;
  withPinnedRepositoryByGitHubNode<T>(
    githubNodeId: string,
    use: (repository: RepositoryRecord) => Promise<T>,
  ): Promise<T>;
  getTask(taskId: string): Promise<TaskRecord>;
  getTaskSourceRevision(taskId: string): Promise<string>;
  registerFormalTask(input: RegisterFormalTaskInput): Promise<FormalTaskRegistration>;
  registerTemporaryTask(input: RegisterTemporaryTaskInput): Promise<TemporaryTask>;
  promoteTemporaryTask(taskId: string, input: RegisterFormalTaskInput): Promise<FormalTask>;
}

export interface GitHubSourceServiceOptions {
  runner: GitHubSourceRunner;
  catalog: SourceCatalogPort | Catalog;
  projects: ProjectMembershipPort;
  sensitiveData?: SensitiveDataPolicy;
}

interface VerifiedIssue {
  issue_node_id: string;
  issue_revision: string;
  issue_url: string;
  alias: string;
  state: "open" | "closed";
}

function issueRecord(issue: VerifiedIssue): Omit<RegisterFormalTaskInput, "project_id" | "repo_id"> {
  const { state: _state, ...record } = issue;
  return record;
}

export interface ExistingTaskContext {
  task: TaskRecord;
  alias: string;
  source_task_revision: string;
}

function parseJson<T>(stdout: string, schema: z.ZodType<T>, code: string): T {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ControlError(code, "GitHub returned invalid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ControlError(code, "GitHub response failed strict validation");
  return parsed.data;
}

function sameSlug(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Parses only canonical GitHub checkout remotes and returns owner/name. */
export function githubSlugFromRemote(remote: string, sshOnly = false): string {
  const value = remote.trim();
  let match = value.match(/^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/);
  if (!match) {
    match = value.match(/^ssh:\/\/git@github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/);
  }
  if (!match && !sshOnly) {
    match = value.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/);
  }
  if (!match) {
    throw new ControlError(sshOnly ? "REGISTRY_REMOTE_NOT_SSH" : "INVALID_CHECKOUT_ORIGIN", "Remote is not a canonical GitHub URL");
  }
  return `${match[1]}/${match[2]}`;
}

function issueCoordinates(issueUrl: string): { slug: string; number: number; canonicalUrl: string } {
  let url: URL;
  try {
    url = new URL(issueUrl);
  } catch {
    throw new ControlError("INVALID_ISSUE_URL", "Issue URL is invalid");
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/issues\/([1-9][0-9]*)$/);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash || !match) {
    throw new ControlError("INVALID_ISSUE_URL", "Issue URL must be a canonical GitHub Issue URL");
  }
  const slug = `${match[1]}/${match[2]}`;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ControlError("INVALID_ISSUE_URL", "Issue URL contains an unsafe Issue number");
  }
  return { slug, number, canonicalUrl: `https://github.com/${slug}/issues/${match[3]}` };
}

export class GitHubSourceService {
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(private readonly options: GitHubSourceServiceOptions) {
    this.sensitiveData = options.sensitiveData ?? createSensitiveDataPolicy();
  }

  async registerRepository(input: Pick<RegisterRepositoryInput, "repo_id" | "slug" | "allow_public"> & { repository_path: string }): Promise<RepositoryRegistration> {
    if (!repoIdPattern.test(input.repo_id) || !slugPattern.test(input.slug)) {
      throw new ControlError("INVALID_REPOSITORY", "Repository registration coordinates are invalid");
    }
    this.assertCheckoutSafe({ repo_id: input.repo_id, slug: input.slug }, input.repository_path);
    await this.verifyCheckout(input.repository_path, input.slug);
    const resolved = await this.resolveRepository(input.slug, input.allow_public === true);
    this.assertCheckoutSafe(resolved, input.repository_path);
    return this.options.catalog.registerRepository({
      repo_id: input.repo_id,
      slug: resolved.full_name,
      github_node_id: resolved.node_id,
      ...(input.allow_public === true ? { allow_public: true as const } : {}),
    });
  }

  async verifyPrivateRepository(slug: string): Promise<void> {
    if (!slugPattern.test(slug)) throw new ControlError("INVALID_REPOSITORY", "Repository slug is invalid");
    await this.resolveRepository(slug, false);
  }

  async registerFormalTask(input: {
    project_id: string;
    repo_id: string;
    repository_path: string;
    issue_url: string;
    expected_issue_node_id?: string;
    expected_issue_revision?: string;
  }): Promise<FormalTaskRegistration> {
    issueCoordinates(input.issue_url);
    const { repository_path: _repositoryPath, ...content } = input;
    this.assertCheckoutSafe(content, input.repository_path);
    const context = await this.requireContext(input.project_id, input.repo_id, input.repository_path);
    const issue = await this.resolveIssue(context.repository, input.issue_url);
    this.assertCheckoutSafe(issue, input.repository_path);
    if (issue.state === "closed") throw new ControlError("TASK_COMPLETED", "Closed GitHub Issues cannot create Task ownership");
    if (input.expected_issue_node_id !== undefined && input.expected_issue_node_id !== issue.issue_node_id) {
      throw new ControlError("ISSUE_IDENTITY_MISMATCH", "Caller Issue node ID disagrees with the verified Issue");
    }
    if (input.expected_issue_revision !== undefined && input.expected_issue_revision !== issue.issue_revision) {
      throw new ControlError("ISSUE_REVISION_MISMATCH", "Caller Issue revision disagrees with the verified Issue");
    }
    return this.options.catalog.registerFormalTask({
      project_id: input.project_id,
      repo_id: input.repo_id,
      ...issueRecord(issue),
    });
  }

  async registerTemporaryTask(input: RegisterTemporaryTaskInput & { repository_path: string }): Promise<TemporaryTask> {
    const { repository_path: _repositoryPath, ...record } = input;
    this.assertCheckoutSafe(record, input.repository_path);
    await this.requireContext(input.project_id, input.repo_id, input.repository_path);
    return this.options.catalog.registerTemporaryTask(record);
  }

  async prepareExistingTask(input: { task_id: string; repository_path: string }): Promise<ExistingTaskContext> {
    if (!taskIdPattern.test(input.task_id)) throw new ControlError("INVALID_TASK_ID", "Task ID is invalid");
    this.assertCheckoutSafe({ task_id: input.task_id }, input.repository_path);
    let task = await this.options.catalog.getTask(input.task_id);
    this.assertCheckoutSafe(task, input.repository_path);
    const context = await this.requireContext(task.project_id, task.repo_id, input.repository_path);
    if (task.kind === "formal") {
      issueCoordinates(task.issue_url);
      const issue = await this.resolveIssue(context.repository, task.issue_url);
      if (issue.issue_node_id !== task.issue_node_id) {
        throw new ControlError("ISSUE_IDENTITY_MISMATCH", "Canonical Task and verified Issue node ID disagree");
      }
      this.assertCheckoutSafe(issue, input.repository_path);
      if (issue.state === "closed") throw new ControlError("TASK_COMPLETED", "Closed formal Tasks cannot be resumed");
      task = (await this.options.catalog.registerFormalTask({
        project_id: task.project_id,
        repo_id: task.repo_id,
        ...issueRecord(issue),
      })).task;
    }
    if (task.kind === "temporary" && task.lifecycle === "completed") {
      throw new ControlError("TASK_COMPLETED", "Completed temporary Tasks cannot be resumed");
    }
    const alias = task.kind === "formal"
      ? task.aliases.find((candidate) => candidate === `${context.repository.slug}#${issueCoordinates(task.issue_url).number}`)
      : task.aliases[0];
    if (!alias) throw new ControlError("REGISTRY_CORRUPT", "Task has no usable canonical alias");
    return {
      task,
      alias,
      source_task_revision: await this.options.catalog.getTaskSourceRevision(task.id),
    };
  }

  async promoteTemporaryTask(input: {
    task_id: string;
    repository_path: string;
    issue_url: string;
    expected_issue_node_id?: string;
    expected_issue_revision?: string;
  }): Promise<FormalTask> {
    issueCoordinates(input.issue_url);
    const { repository_path: _repositoryPath, ...content } = input;
    this.assertCheckoutSafe(content, input.repository_path);
    const current = await this.options.catalog.getTask(input.task_id);
    this.assertCheckoutSafe(current, input.repository_path);
    const context = await this.requireContext(current.project_id, current.repo_id, input.repository_path);
    const issue = await this.resolveIssue(context.repository, input.issue_url);
    this.assertCheckoutSafe(issue, input.repository_path);
    if (issue.state === "closed") throw new ControlError("TASK_COMPLETED", "Closed GitHub Issues cannot promote Task ownership");
    if (input.expected_issue_node_id !== undefined && input.expected_issue_node_id !== issue.issue_node_id) {
      throw new ControlError("ISSUE_IDENTITY_MISMATCH", "Caller Issue node ID disagrees with the verified Issue");
    }
    if (input.expected_issue_revision !== undefined && input.expected_issue_revision !== issue.issue_revision) {
      throw new ControlError("ISSUE_REVISION_MISMATCH", "Caller Issue revision disagrees with the verified Issue");
    }
    return this.options.catalog.promoteTemporaryTask(current.id, {
      project_id: current.project_id,
      repo_id: current.repo_id,
      ...issueRecord(issue),
    });
  }

  private async requireContext(projectId: string, repoId: string, repositoryPath: string): Promise<{ repository: RepositoryRecord }> {
    if (!projectIdPattern.test(projectId) || !repoIdPattern.test(repoId)) {
      throw new ControlError("INVALID_TASK_SCOPE", "Task Project/Repository coordinates are invalid");
    }
    const repository = await this.options.catalog.getRepository(repoId);
    this.assertCheckoutSafe(repository, repositoryPath);
    await this.options.projects.requireProjectRepository(projectId, repoId);
    await this.verifyCheckout(repositoryPath, repository.slug);
    const actual = await this.resolveRepository(repository.slug, repository.allow_public === true);
    this.assertCheckoutSafe(actual, repositoryPath);
    if (actual.node_id !== repository.github_node_id) {
      throw new ControlError("REPOSITORY_IDENTITY_MISMATCH", "Repository Record and GitHub node identity disagree");
    }
    return { repository };
  }

  private async verifyCheckout(repositoryPath: string, expectedSlug: string): Promise<void> {
    if (!isAbsolute(repositoryPath)) throw new ControlError("INVALID_CHECKOUT_PATH", "Repository checkout path must be absolute");
    const root = (await this.options.runner.run("git", ["rev-parse", "--show-toplevel"], { cwd: repositoryPath })).stdout.trim();
    if (!isAbsolute(root) || resolve(root) !== resolve(repositoryPath)) {
      throw new ControlError("CHECKOUT_ROOT_MISMATCH", "Repository path is not the exact checkout root");
    }
    const remoteLines = (await this.options.runner.run("git", ["remote", "get-url", "--all", "origin"], { cwd: repositoryPath }))
      .stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (remoteLines.length !== 1) {
      throw new ControlError("AMBIGUOUS_CHECKOUT_ORIGIN", "Checkout must have exactly one origin URL");
    }
    const actualSlug = githubSlugFromRemote(remoteLines[0] as string);
    if (!sameSlug(actualSlug, expectedSlug)) {
      throw new ControlError("CHECKOUT_REMOTE_MISMATCH", "Checkout origin does not match the canonical Repository");
    }
    const pushLines = (await this.options.runner.run(
      "git",
      ["remote", "get-url", "--push", "--all", "origin"],
      { cwd: repositoryPath },
    )).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (pushLines.length !== 1) {
      throw new ControlError("AMBIGUOUS_CHECKOUT_ORIGIN", "Checkout must have exactly one effective push URL");
    }
    const pushSlug = githubSlugFromRemote(pushLines[0] as string);
    if (!sameSlug(pushSlug, expectedSlug)) {
      throw new ControlError("CHECKOUT_REMOTE_MISMATCH", "Checkout push URL does not match the canonical Repository");
    }
  }

  private assertCheckoutSafe(value: unknown, repositoryPath: string): void {
    this.sensitiveData.assertSafe(value);
    createSensitiveDataPolicy({}, [repositoryPath]).assertSafe(value);
  }

  private async resolveRepository(slug: string, allowPublic: boolean): Promise<z.infer<typeof RepositoryResponseSchema>> {
    const resolved = parseJson(
      (await this.options.runner.runGh(["api", `repos/${slug}`], "repo")).stdout,
      RepositoryResponseSchema,
      "INVALID_REPOSITORY_RESPONSE",
    );
    if (!sameSlug(resolved.full_name, slug)) {
      throw new ControlError("REPOSITORY_IDENTITY_MISMATCH", "GitHub repository slug does not match the request");
    }
    // The private requirement stays the default; a public repository passes
    // only through the explicit operator opt-in persisted on its record.
    if (!resolved.private && !allowPublic) {
      throw new ControlError("REPOSITORY_NOT_PRIVATE", "Phase 1A requires a private GitHub repository");
    }
    this.sensitiveData.assertSafe(resolved);
    return resolved;
  }

  private async resolveIssue(repository: RepositoryRecord, issueUrl: string): Promise<VerifiedIssue> {
    const requested = issueCoordinates(issueUrl);
    if (!sameSlug(requested.slug, repository.slug)) {
      throw new ControlError("ISSUE_REPOSITORY_MISMATCH", "Issue URL belongs to another Repository");
    }
    const issue = parseJson(
      (await this.options.runner.runGh(["api", `repos/${repository.slug}/issues/${requested.number}`], "repo")).stdout,
      IssueResponseSchema,
      "INVALID_ISSUE_RESPONSE",
    );
    if (issue.pull_request !== undefined || issue.number !== requested.number || issue.html_url !== requested.canonicalUrl) {
      throw new ControlError("ISSUE_IDENTITY_MISMATCH", "GitHub Issue coordinates disagree with the request");
    }
    const verified = {
      issue_node_id: issue.node_id,
      issue_revision: issue.updated_at,
      issue_url: requested.canonicalUrl,
      alias: `${repository.slug}#${issue.number}`,
      state: issue.state,
    };
    this.sensitiveData.assertSafe(verified);
    return verified;
  }
}
