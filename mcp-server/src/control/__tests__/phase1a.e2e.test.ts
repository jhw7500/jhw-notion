import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAuthorityService } from "../authority.js";
import { Catalog } from "../catalog.js";
import { ClaimService, type ClaimInspection } from "../claim-service.js";
import { runCli, type CliDependencies } from "../cli.js";
import type { ControlConfig } from "../config.js";
import { ControlError } from "../errors.js";
import { GitHubProjectClient, type GitHubRunner } from "../github-project.js";
import { GitHubSourceService, type GitHubSourceRunner } from "../github-source.js";
import { PilotJournal } from "../journal.js";
import { MutationLock, ProcessRunner, type ProcessResult, type ProcessRunOptions } from "../process.js";
import { PortfolioService, type ProjectSnapshotSource } from "../portfolio.js";
import { PreflightService, type PreflightProjectPort } from "../preflight.js";
import { RegistryGit, type ProcessRunnerLike } from "../registry-git.js";
import { createSensitiveDataPolicy } from "../sensitive-data.js";
import { sourceIndexKey } from "../ids.js";
import { TaskService } from "../task-service.js";
import { WorktreeManager, type WorktreeStateHooks } from "../worktree.js";
import { configFor, git, isolatedRegistryGit, makeRegistryFixture } from "./helpers.js";

interface GateFixture {
  root: string;
  remoteDir: string;
  cloneA: string;
  cloneB: string;
  sourceRepo: string;
  worktreeRoot: string;
  stateDir: string;
  binDir: string;
  cleanup(): Promise<void>;
}

interface Graph {
  config: ControlConfig;
  runner: ProcessRunner;
  registry: RegistryGit;
  catalog: Catalog;
  claims: ClaimService;
  worktrees: WorktreeManager;
  tasks: TaskService;
}

const fixtures: GateFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function makeGateFixture(): Promise<GateFixture> {
  const base = await makeRegistryFixture();
  const cloneA = join(base.root, "clone-a");
  const cloneB = join(base.root, "clone-b");
  await rename(base.registryDir, cloneA);
  await rename(base.otherCloneDir, cloneB);
  const sourceRepo = join(base.root, "source-repo");
  const worktreeRoot = join(base.root, "worktrees");
  const stateDir = join(base.root, "state");
  const binDir = join(base.root, "bin");
  await Promise.all([
    mkdir(worktreeRoot, { mode: 0o700 }),
    mkdir(stateDir, { mode: 0o700 }),
    mkdir(binDir, { mode: 0o700 }),
  ]);
  await git(base.root, "init", "--initial-branch=main", sourceRepo);
  await git(sourceRepo, "config", "user.name", "Phase1A Test");
  await git(sourceRepo, "config", "user.email", "phase1a@example.invalid");
  await writeFile(join(sourceRepo, "README.md"), "# Source\n", "utf8");
  await git(sourceRepo, "add", "README.md");
  await git(sourceRepo, "commit", "-m", "Initial source");
  const fixture = {
    root: base.root,
    remoteDir: base.remoteDir,
    cloneA,
    cloneB,
    sourceRepo,
    worktreeRoot,
    stateDir,
    binDir,
    cleanup: base.cleanup,
  };
  fixtures.push(fixture);
  return fixture;
}

function fixtureConfig(fixture: GateFixture, registryDir: string): ControlConfig {
  return {
    ...configFor(registryDir),
    worktreeRoot: fixture.worktreeRoot,
    stateDir: fixture.stateDir,
  };
}

function graphFor(
  fixture: GateFixture,
  registryDir: string,
  options: { runner?: ProcessRunner; worktreeHooks?: WorktreeStateHooks; now?: () => Date } = {},
): Graph {
  const config = fixtureConfig(fixture, registryDir);
  const runner = options.runner ?? new ProcessRunner();
  const registry = isolatedRegistryGit(config, runner);
  const catalog = new Catalog(config, registry);
  const worktrees = new WorktreeManager(config, runner, options.worktreeHooks);
  const inspection: ClaimInspection = {
    async inspect(claim) {
      try {
        const current = await worktrees.inspect(claim);
        return { process_exists: false, worktree_mapped: true, dirty: current.dirty, ahead: current.ahead };
      } catch (cause) {
        if (cause instanceof ControlError && new Set([
          "HOST_MISMATCH",
          "WORKTREE_NOT_MAPPED",
          "WORKTREE_CREATE_PENDING",
          "WORKTREE_REMOVE_PENDING",
          "WORKTREE_REMOVED",
        ]).has(cause.code)) return { process_exists: false, worktree_mapped: false, dirty: false, ahead: 0 };
        throw cause;
      }
    },
  };
  const claims = new ClaimService(config, registry, catalog, inspection, options.now);
  return {
    config,
    runner,
    registry,
    catalog,
    claims,
    worktrees,
    tasks: new TaskService(config, claims, worktrees, registry, options.now),
  };
}

function noopJournal() {
  return { append: async () => undefined };
}

function cliDependencies(graph: Graph, overrides: Partial<CliDependencies> = {}): CliDependencies {
  const ensureRepository = async () => {
    try {
      return await graph.catalog.getRepository("repo-control");
    } catch (cause) {
      if (!(cause instanceof ControlError && cause.code === "REPOSITORY_NOT_FOUND")) throw cause;
      return (await graph.catalog.registerRepository(repositoryInput)).repository;
    }
  };
  return {
    stateDir: graph.config.stateDir,
    env: {},
    taskService: graph.tasks,
    claimService: graph.claims,
    catalog: graph.catalog,
    source: {
      registerRepository: async (input) => graph.catalog.registerRepository({
        repo_id: input.repo_id,
        slug: input.slug,
        github_node_id: repositoryInput.github_node_id,
      }),
      registerFormalTask: async (input) => {
        await ensureRepository();
        return graph.catalog.registerFormalTask({
          project_id: input.project_id,
          repo_id: input.repo_id,
          issue_node_id: input.expected_issue_node_id ?? issueInput.issue_node_id,
          issue_revision: input.expected_issue_revision ?? issueInput.issue_revision,
          issue_url: input.issue_url,
          alias: issueInput.alias,
        });
      },
      registerTemporaryTask: async (input) => {
        await ensureRepository();
        const { repository_path: _repositoryPath, ...record } = input;
        return graph.catalog.registerTemporaryTask(record);
      },
      prepareExistingTask: async (input) => {
        const task = await graph.catalog.getTask(input.task_id);
        return { task, alias: task.aliases[0]!, source_task_revision: await graph.catalog.getTaskSourceRevision(task.id) };
      },
      promoteTemporaryTask: async (input) => graph.catalog.promoteTemporaryTask(input.task_id, issueInput),
    },
    portfolio: {
      status: async () => ({ page_id: "page-1", markdown: "# Portfolio\n", items: [], truncated: false, total_items: 0 }),
      exportSnapshot: async () => ({
        jsonPath: "2026-08-13T00-00-00.000Z/portfolio.json",
        markdownPath: "2026-08-13T00-00-00.000Z/portfolio.md",
        checksum: "a".repeat(64),
      }),
      registerProject: async (input) => ({ project_id: input.project_id, project_item_id: "PVTI_control", source_node_id: "I_control", issue_number: 1 }),
    },
    preflight: { run: async () => ({
      status: "ready",
      checks: {
        credentials: "ok", authority: "ok", notion_guard: "ok", project: "ok",
        registry_repository: "ok", registry_issue: "ok", registry_git: "ok",
      },
    }) },
    mutationLock: new MutationLock(graph.config, {}),
    journal: noopJournal(),
    ...overrides,
  };
}

const repositoryInput = { repo_id: "repo-control", github_node_id: "R_phase1a", slug: "jhw7500/control" };
const issueInput = {
  project_id: "prj-control",
  repo_id: "repo-control",
  issue_node_id: "I_phase1a",
  issue_revision: "2026-08-13T00:00:00Z",
  issue_url: "https://github.com/jhw7500/control/issues/1",
  alias: "jhw7500/control#1",
};

class PushGateRunner implements ProcessRunnerLike {
  readonly atPush = deferred();
  readonly releasePush = deferred();
  readonly calls: Array<{ command: string; args: string[] }> = [];

  constructor(private readonly delegate: ProcessRunner, private readonly commitDate: string) {}

  async run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ command, args: [...args] });
    if (command === "git" && args[0] === "commit") {
      options = {
        ...options,
        env: { ...options?.env, GIT_AUTHOR_DATE: this.commitDate, GIT_COMMITTER_DATE: this.commitDate },
      };
    }
    if (command === "git" && args[0] === "push") {
      this.atPush.resolve();
      await this.releasePush.promise;
    }
    return this.delegate.run(command, args, options);
  }

  async runRaw(command: string, args: string[], options: ProcessRunOptions | undefined, maximumBytes: number): Promise<Buffer> {
    this.calls.push({ command, args: [...args] });
    return this.delegate.runRaw(command, args, options, maximumBytes);
  }
}

class GateSourceRunner implements GitHubSourceRunner {
  readonly calls: Array<{ command: string; args: string[]; credential?: "project" | "repo" }> = [];
  repository = { node_id: "R_phase1a", full_name: "jhw7500/control", private: true };
  issue = {
    node_id: "I_phase1a",
    number: 1,
    html_url: "https://github.com/jhw7500/control/issues/1",
    updated_at: "2026-08-13T00:00:00Z",
    state: "open" as const,
  };

  constructor(private readonly delegate = new ProcessRunner()) {}

  async run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ command, args: [...args] });
    return this.delegate.run(command, args, options);
  }

  async runGh(args: string[], credential: "project" | "repo"): Promise<ProcessResult> {
    this.calls.push({ command: "gh", args: [...args], credential });
    const target = args[1] ?? "";
    const value = target === "repos/jhw7500/control" ? this.repository : this.issue;
    return { command: "gh", args, stdout: `${JSON.stringify(value)}\n`, stderr: "", exitCode: 0 };
  }
}

class GateProjectRunner implements GitHubRunner {
  readonly calls: Array<{ args: string[]; credential: "project" | "repo" }> = [];
  private readonly responses: Array<unknown | Error> = [];

  enqueue(...responses: Array<unknown | Error>): void {
    this.responses.push(...responses);
  }

  async runGh(args: string[], credential: "project" | "repo"): Promise<ProcessResult> {
    this.calls.push({ args: [...args], credential });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("GateProjectRunner exhausted");
    if (response instanceof Error) throw response;
    return { command: "gh", args, stdout: `${JSON.stringify(response)}\n`, stderr: "", exitCode: 0 };
  }
}

const gateProjectFields = [
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_status", name: "Status", dataType: "SINGLE_SELECT", options: ["proposed", "active", "paused", "completed", "cancelled"].map((name) => ({ id: `status-${name}`, name })) },
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_priority", name: "Priority", dataType: "SINGLE_SELECT", options: ["P0", "P1", "P2", "P3"].map((name) => ({ id: `priority-${name}`, name })) },
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_health", name: "Health", dataType: "SINGLE_SELECT", options: ["on-track", "at-risk", "blocked", "unknown"].map((name) => ({ id: `health-${name}`, name })) },
  { __typename: "ProjectV2Field", id: "PVTF_next", name: "Next Action", dataType: "TEXT" },
  { __typename: "ProjectV2Field", id: "PVTF_reviewed", name: "Last Reviewed", dataType: "DATE" },
];

function gateProjectPage(item: Record<string, unknown> | undefined) {
  return {
    data: { user: { projectV2: {
      id: "PVT_project", public: false, updatedAt: "2026-08-13T00:00:00Z",
      fields: { totalCount: gateProjectFields.length, nodes: gateProjectFields, pageInfo: { hasNextPage: false, endCursor: null } },
      items: { totalCount: item ? 1 : 0, nodes: item ? [item] : [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } },
  };
}

function gateProjectItem(complete: boolean) {
  return {
    id: "PVTI_existing", isArchived: false, type: "ISSUE",
    content: { __typename: "Issue", id: "I_existing" },
    status: complete ? { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "status-proposed", name: "proposed" } : null,
    priority: complete ? { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "priority-P2", name: "P2" } : null,
    health: complete ? { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "health-unknown", name: "unknown" } : null,
    nextAction: complete ? { __typename: "ProjectV2ItemFieldTextValue", text: "wait:select" } : null,
    lastReviewed: complete ? { __typename: "ProjectV2ItemFieldDateValue", date: "2026-08-13" } : null,
  };
}

async function runDeterministicPushRace<T>(left: () => Promise<T>, right: () => Promise<T>, leftRunner: PushGateRunner, rightRunner: PushGateRunner) {
  const leftResult = left().then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
  const rightResult = right().then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
  await Promise.all([leftRunner.atPush.promise, rightRunner.atPush.promise]);
  leftRunner.releasePush.resolve();
  const winner = await leftResult;
  rightRunner.releasePush.resolve();
  return [winner, await rightResult] as const;
}

async function freshAuditClone(fixture: GateFixture, name: string): Promise<string> {
  const path = join(fixture.root, name);
  await git(fixture.root, "clone", fixture.remoteDir, path);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

function temporaryStartArgs(alias: string, sourceRepo: string, session: string): string[] {
  return [
    "task", "start", "--project", "prj-control", "--repo-id", "repo-control", "--repo-path", sourceRepo,
    "--temp-alias", alias, "--goal", "exercise the deterministic gate", "--done", "gate passes",
    "--scope", "src/control", "--session", session,
  ];
}

function completedFinishArgs(taskId: string, claimId: string): string[] {
  return [
    "task", "finish", "--task", taskId, "--claim", claimId, "--status", "completed", "--outcome", "verified",
    "--validation", "phase1a gate: pass", "--active-work-minutes", "1",
  ];
}

function projectSource(count = 23): ProjectSnapshotSource {
  return {
    project_node_id: "PVT_phase1a",
    source_revision: "2026-08-13T00:00:00Z",
    field_definitions: [
      { id: "status", name: "Status", data_type: "SINGLE_SELECT", options: [{ id: "active", name: "active" }] },
      { id: "priority", name: "Priority", data_type: "SINGLE_SELECT", options: [{ id: "p2", name: "P2" }] },
      { id: "health", name: "Health", data_type: "SINGLE_SELECT", options: [{ id: "on-track", name: "on-track" }] },
      { id: "next", name: "Next Action", data_type: "TEXT" },
      { id: "reviewed", name: "Last Reviewed", data_type: "DATE" },
    ],
    items: Array.from({ length: count }, (_, index) => ({
      project_item_id: `PVTI_${index + 1}`,
      source_node_id: `I_${index + 1}`,
      project_id: `prj-project-${index + 1}`,
      title: `Project ${index + 1}`,
      objective: `Objective ${index + 1} ${"x".repeat(900)}`,
      repo_ids: ["repo-control"],
      fields: { status: "active", priority: "P2", health: "on-track", next_action: "wait:fixture", last_reviewed: "2026-08-13" },
      stale: false,
    })),
    total_count: count,
  };
}

async function writeFakeGh(fixture: GateFixture): Promise<{ queueDir: string; logPath: string }> {
  const queueDir = join(fixture.root, "fake-gh");
  const logPath = join(queueDir, "operations.jsonl");
  await mkdir(queueDir, { mode: 0o700 });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.env.JHW_FAKE_GH_DIR;
if (!root) process.exit(97);
const argv = process.argv.slice(2);
const raw = JSON.stringify(argv);
const fingerprints = JSON.parse(process.env.JHW_FAKE_SECRET_FINGERPRINTS || "[]");
const containsSecret = (value) => fingerprints.some(({ length, sha256 }) => {
  for (let index = 0; index + length <= value.length; index += 1) {
    if (crypto.createHash("sha256").update(value.slice(index, index + length)).digest("hex") === sha256) return true;
  }
  return false;
});
if (containsSecret(raw)) process.exit(96);
let method = "GET";
const methodIndex = argv.indexOf("--method");
if (methodIndex >= 0) method = argv[methodIndex + 1] || "";
const apiIndex = argv.indexOf("api");
const target = argv.slice(apiIndex + 1).find((value) => !value.startsWith("-")) || "";
const keys = [];
for (let index = 0; index < argv.length - 1; index += 1) {
  if (argv[index] === "--field" || argv[index] === "--raw-field") keys.push(String(argv[index + 1]).split("=", 1)[0]);
}
const capture = { operation: "rest:" + method + ":" + target, keys: keys.sort() };
const queued = fs.readdirSync(root).filter((name) => /^\\d{4}\\.json$/.test(name)).sort();
if (queued.length === 0) process.exit(95);
const source = path.join(root, queued[0]);
const claimed = source + ".claimed-" + process.pid;
fs.renameSync(source, claimed);
const response = JSON.parse(fs.readFileSync(claimed, "utf8"));
if (JSON.stringify(capture) !== JSON.stringify(response.expect)) process.exit(94);
const selectedTokenSha256 = crypto.createHash("sha256").update(String(process.env.GH_TOKEN || "")).digest("hex");
const sourceCredentialsAbsent = !process.env.GH_PROJECT_TOKEN && !process.env.GH_REPO_TOKEN;
if (!sourceCredentialsAbsent || selectedTokenSha256 !== response.expectTokenSha256) process.exit(92);
const audit = { ...capture, selected_token_sha256: selectedTokenSha256, source_credentials_absent: sourceCredentialsAbsent };
const serialized = JSON.stringify(audit);
if (containsSecret(serialized) || containsSecret(JSON.stringify(response)) || containsSecret(String(response.stdout || "")) || containsSecret(String(response.stderr || ""))) process.exit(93);
fs.appendFileSync(path.join(root, "operations.jsonl"), serialized + "\\n", { mode: 0o600 });
process.stdout.write(String(response.stdout || ""));
process.stderr.write(String(response.stderr || ""));
process.exit(Number(response.exitCode || 0));
`;
  const executable = join(fixture.binDir, "gh");
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { queueDir, logPath };
}

async function textArtifacts(root: string): Promise<string[]> {
  const artifacts: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    artifacts.push(entry.name);
    if (entry.isDirectory()) artifacts.push(...await textArtifacts(path));
    else if (entry.isFile()) artifacts.push(await readFile(path, "utf8"));
  }
  return artifacts;
}

interface RawErrorAudit {
  name: string;
  message: string;
  code?: unknown;
  details?: unknown;
}

function rawErrorAudit(cause: unknown): RawErrorAudit {
  const record = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : undefined;
  return {
    name: cause instanceof Error ? cause.name : typeof cause,
    message: cause instanceof Error ? cause.message : String(cause),
    ...(record && "code" in record ? { code: record.code } : {}),
    ...(record && "details" in record ? { details: record.details } : {}),
  };
}

describe("Phase 1A deterministic adversarial gate", () => {
  it("1. concurrent Repository registration leaves one canonical record and one source mapping", async () => {
    const fixture = await makeGateFixture();
    const leftRunner = new PushGateRunner(new ProcessRunner(), "2026-08-13T00:00:01Z");
    const rightRunner = new PushGateRunner(new ProcessRunner(), "2026-08-13T00:00:02Z");
    const leftConfig = fixtureConfig(fixture, fixture.cloneA);
    const rightConfig = fixtureConfig(fixture, fixture.cloneB);
    const left = new Catalog(leftConfig, isolatedRegistryGit(leftConfig, leftRunner));
    const right = new Catalog(rightConfig, isolatedRegistryGit(rightConfig, rightRunner));

    const results = await runDeterministicPushRace(
      () => left.registerRepository(repositoryInput),
      () => right.registerRepository(repositoryInput),
      leftRunner,
      rightRunner,
    );

    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "REMOTE_DIVERGED" } });
    const audit = await freshAuditClone(fixture, "audit-repository");
    const repositoryRecords = (await readdir(join(audit, "repositories"), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const sourceMappings = (await readdir(join(audit, "repositories", "by-source", "github"), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(repositoryRecords).toEqual(["repo-control.yaml"]);
    expect(sourceMappings).toEqual([`${sourceIndexKey(repositoryInput.github_node_id)}.yaml`]);
    expect(JSON.parse(await readFile(join(audit, "repositories", "repo-control.yaml"), "utf8"))).toEqual({
      id: "repo-control", github_node_id: "R_phase1a", slug: "jhw7500/control",
    });
    const sourcePath = join(audit, "repositories", "by-source", "github", `${sourceIndexKey(repositoryInput.github_node_id)}.yaml`);
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual({ repo_id: "repo-control" });
  });

  it("2. concurrent Issue registration leaves one generated Task and one source mapping", async () => {
    const fixture = await makeGateFixture();
    const seed = graphFor(fixture, fixture.cloneA);
    await seed.catalog.registerRepository(repositoryInput);
    await git(fixture.cloneB, "pull", "--ff-only", "origin", "main");
    const leftRunner = new PushGateRunner(new ProcessRunner(), "2026-08-13T00:00:01Z");
    const rightRunner = new PushGateRunner(new ProcessRunner(), "2026-08-13T00:00:02Z");
    const leftConfig = fixtureConfig(fixture, fixture.cloneA);
    const rightConfig = fixtureConfig(fixture, fixture.cloneB);
    const left = new Catalog(leftConfig, isolatedRegistryGit(leftConfig, leftRunner));
    const right = new Catalog(rightConfig, isolatedRegistryGit(rightConfig, rightRunner));

    const results = await runDeterministicPushRace(
      () => left.registerFormalTask(issueInput),
      () => right.registerFormalTask(issueInput),
      leftRunner,
      rightRunner,
    );

    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "REMOTE_DIVERGED" } });
    const audit = await freshAuditClone(fixture, "audit-task");
    const source = JSON.parse(await readFile(join(audit, "tasks", "by-source", "github", `${sourceIndexKey(issueInput.issue_node_id)}.yaml`), "utf8"));
    const taskFiles = (await readdir(join(audit, "tasks"), { withFileTypes: true })).filter((entry) => entry.isFile());
    const sourceFiles = (await readdir(join(audit, "tasks", "by-source", "github"), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(taskFiles.map((entry) => entry.name)).toEqual([`${source.task_id}.yaml`]);
    expect(sourceFiles).toEqual([`${sourceIndexKey(issueInput.issue_node_id)}.yaml`]);
    expect(JSON.parse(await readFile(join(audit, "tasks", `${source.task_id}.yaml`), "utf8"))).toMatchObject({ id: source.task_id, issue_node_id: issueInput.issue_node_id });
  });

  it("3. promotion collision changes neither Task nor Registry HEAD", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    await graph.catalog.registerRepository(repositoryInput);
    const temporary = await graph.catalog.registerTemporaryTask({
      project_id: "prj-control", repo_id: "repo-control", alias: "control:temporary", goal: "temporary",
      done_conditions: ["test"], expected_scope: ["src/control"],
    });
    const formal = (await graph.catalog.registerFormalTask(issueInput)).task;
    const head = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
    const temporaryBytes = await readFile(join(fixture.cloneA, "tasks", `${temporary.id}.yaml`), "utf8");
    const formalBytes = await readFile(join(fixture.cloneA, "tasks", `${formal.id}.yaml`), "utf8");
    const sourcePath = join(fixture.cloneA, "tasks", "by-source", "github", `${sourceIndexKey(issueInput.issue_node_id)}.yaml`);
    const sourceBytes = await readFile(sourcePath, "utf8");

    await expect(graph.catalog.promoteTemporaryTask(temporary.id, issueInput)).rejects.toMatchObject({ code: "SOURCE_ALREADY_MAPPED" });
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await readFile(join(fixture.cloneA, "tasks", `${temporary.id}.yaml`), "utf8")).toBe(temporaryBytes);
    expect(await readFile(join(fixture.cloneA, "tasks", `${formal.id}.yaml`), "utf8")).toBe(formalBytes);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
    expect(await git(fixture.cloneA, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("4. two same-host Task starts under one retained lock leave one active Claim", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    await graph.catalog.registerRepository(repositoryInput);
    const canonical = (await graph.catalog.registerFormalTask(issueInput)).task;
    const enteredStart = deferred();
    const release = deferred();
    const coordinatedTasks = Object.create(graph.tasks) as TaskService;
    coordinatedTasks.start = async (input) => {
      enteredStart.resolve();
      await release.promise;
      return graph.tasks.start(input);
    };
    const heldDependencies = cliDependencies(graph, {
      taskService: coordinatedTasks,
    });
    const contenderDependencies = cliDependencies(graph);
    const formalStartArgs = (session: string) => [
      "task", "start", "--project", issueInput.project_id, "--repo-id", issueInput.repo_id,
      "--repo-path", fixture.sourceRepo, "--issue-node-id", issueInput.issue_node_id,
      "--issue-url", issueInput.issue_url, "--issue-revision", issueInput.issue_revision, "--session", session,
    ];
    const firstPromise = runCli(formalStartArgs("codex-a"), heldDependencies);
    await enteredStart.promise;
    const contender = await runCli(formalStartArgs("codex-b"), contenderDependencies);
    release.resolve();
    const first = await firstPromise;

    expect(first.exitCode).toBe(0);
    expect(contender).toMatchObject({ exitCode: 75 });
    expect(JSON.parse(contender.stderr)).toEqual({ error: { code: "LOCK_CONTENDED" } });
    const started = JSON.parse(first.stdout).result;
    expect(started.task.task_id).toBe(canonical.id);
    expect(await graph.claims.getActive(started.task.task_id)).toMatchObject({ claim_id: started.claim.claim_id });
    const audit = await freshAuditClone(fixture, "claim-contention-audit");
    const activeFiles = (await readdir(join(audit, "claims", "active"), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(activeFiles).toEqual([`${canonical.id}.yaml`]);
    expect(JSON.parse(await readFile(join(audit, "claims", "active", activeFiles[0]!), "utf8"))).toMatchObject({
      task_id: canonical.id,
      claim_id: started.claim.claim_id,
      session_id: "codex-a",
    });
  });

  it("5. remote divergence fails without rebase, retry, or force", async () => {
    const fixture = await makeGateFixture();
    await writeFile(join(fixture.cloneB, "winner.json"), "{}\n", "utf8");
    await git(fixture.cloneB, "add", "winner.json");
    await git(fixture.cloneB, "commit", "-m", "Advance remote");
    await git(fixture.cloneB, "push", "origin", "main");
    const calls: string[][] = [];
    const delegate = new ProcessRunner();
    const runner: ProcessRunnerLike = {
      async run(command, args, options) {
        calls.push([...args]);
        return delegate.run(command, args, options);
      },
      async runRaw(command, args, options, maximumBytes) {
        calls.push([...args]);
        return delegate.runRaw(command, args, options, maximumBytes);
      },
    };
    const config = fixtureConfig(fixture, fixture.cloneA);
    const registry = isolatedRegistryGit(config, runner);

    await expect(registry.transact("must diverge", async () => ({ paths: [] }))).rejects.toMatchObject({ code: "REMOTE_DIVERGED" });
    const flat = calls.flat();
    expect(flat).not.toContain("rebase");
    expect(flat).not.toContain("--force");
    expect(flat).not.toContain("--force-with-lease");
    expect(calls.filter((args) => args[0] === "fetch")).toHaveLength(1);

    const racingFixture = await makeGateFixture();
    const racingCalls: string[][] = [];
    const racingDelegate = new ProcessRunner();
    const racingRunner: ProcessRunnerLike = {
      async run(command, args, options) {
        racingCalls.push([...args]);
        return racingDelegate.run(command, args, options);
      },
      async runRaw(command, args, options, maximumBytes) {
        racingCalls.push([...args]);
        return racingDelegate.runRaw(command, args, options, maximumBytes);
      },
    };
    const racingRegistry = isolatedRegistryGit(fixtureConfig(racingFixture, racingFixture.cloneA), racingRunner);
    await expect(racingRegistry.transact("lose deterministic push window", async () => {
      const localPath = "governance/push-window-loser.json";
      await Promise.all([
        mkdir(join(racingFixture.cloneA, "governance"), { recursive: true }),
        mkdir(join(racingFixture.cloneB, "governance"), { recursive: true }),
      ]);
      await writeFile(join(racingFixture.cloneA, localPath), "{}\n", "utf8");
      await writeFile(join(racingFixture.cloneB, "governance/push-window-winner.json"), "{}\n", "utf8");
      await git(racingFixture.cloneB, "add", "governance/push-window-winner.json");
      await git(racingFixture.cloneB, "commit", "-m", "Win deterministic push window");
      await git(racingFixture.cloneB, "push", "origin", "main");
      return { paths: [localPath] };
    })).rejects.toMatchObject({ code: "REMOTE_DIVERGED" });

    const racingFlat = racingCalls.flat();
    expect(racingFlat).not.toContain("rebase");
    expect(racingFlat).not.toContain("--force");
    expect(racingFlat).not.toContain("--force-with-lease");
    expect(racingCalls.filter((args) => args[0] === "push")).toHaveLength(1);
    expect(racingCalls.filter((args) => args[0] === "fetch")).toHaveLength(1);
    const audit = await freshAuditClone(racingFixture, "push-window-audit");
    await expect(readFile(join(audit, "governance/push-window-winner.json"), "utf8")).resolves.toBe("{}\n");
    await expect(exists(join(audit, "governance/push-window-loser.json"))).resolves.toBe(false);
  });

  it("6. wrong immutable Claim release and assert-owner leave the owner and HEAD unchanged", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const started = await runCli(temporaryStartArgs("control:wrong-owner", fixture.sourceRepo, "codex-a"), cliDependencies(graph));
    const { task, claim } = JSON.parse(started.stdout).result;
    const taskId = task.task_id as string;
    const wrong = "clm-0198aabb-ccdd-7eef-8abc-0123456789ab";
    const head = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
    const activeBytes = await readFile(join(fixture.cloneA, "claims", "active", `${taskId}.yaml`), "utf8");

    const finish = await runCli(completedFinishArgs(taskId, wrong), cliDependencies(graph));
    const assertOwner = await runCli(["task", "assert-owner", "--task", taskId, "--claim", wrong], cliDependencies(graph));

    expect(finish).toMatchObject({ exitCode: 4 });
    expect(assertOwner).toMatchObject({ exitCode: 4 });
    expect((await graph.claims.getActive(taskId))?.claim_id).toBe(claim.claim_id);
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await readFile(join(fixture.cloneA, "claims", "active", `${taskId}.yaml`), "utf8")).toBe(activeBytes);
  });

  it("7. client death after successful Claim push recovers from remote authority", async () => {
    const fixture = await makeGateFixture();
    const graphA = graphFor(fixture, fixture.cloneA);
    await graphA.catalog.registerRepository(repositoryInput);
    const task = await graphA.catalog.registerTemporaryTask({
      project_id: "prj-control", repo_id: "repo-control", alias: "control:death", goal: "recover",
      done_conditions: ["status"], expected_scope: ["src/control"],
    });
    const delegate = new ProcessRunner();
    let pushed = false;
    let injected = false;
    const runner = new ProcessRunner() as ProcessRunner & { run: ProcessRunner["run"] };
    runner.run = async (command, args, options) => {
      if (command === "git" && args[0] === "push") pushed = true;
      if (pushed && !injected && command === "git" && args[0] === "fetch") {
        injected = true;
        throw new ControlError("COMMAND_FAILED", "injected post-push client death");
      }
      return delegate.run(command, args, options);
    };
    const dying = graphFor(fixture, fixture.cloneA, { runner });
    let capturedClaimId = "";
    const originalClaim = dying.claims.claimTask.bind(dying.claims);
    dying.claims.claimTask = async (input) => {
      try {
        return await originalClaim(input);
      } finally {
        const path = join(fixture.cloneA, "claims", "active", `${task.id}.yaml`);
        if (await exists(path)) capturedClaimId = JSON.parse(await readFile(path, "utf8")).claim_id;
      }
    };
    const planAlias = task.aliases[0]!;
    await expect(dying.tasks.start({
      task_id: task.id, task_alias: planAlias, project_id: task.project_id, repo_id: task.repo_id,
      session_id: "codex-dead", repository_path: fixture.sourceRepo,
    })).rejects.toMatchObject({ code: "REMOTE_VERIFY_FAILED" });

    await git(fixture.cloneB, "pull", "--ff-only", "origin", "main");
    const graphB = graphFor(fixture, fixture.cloneB);
    const recovered = await graphB.claims.getActive(task.id);
    expect(recovered).toMatchObject({ claim_id: capturedClaimId, session_id: "codex-dead" });
    await expect(graphB.claims.recoverClaim(task.id, capturedClaimId, { kind: "status" })).resolves.toMatchObject({
      kind: "status", active: { claim_id: capturedClaimId },
    });
  });

  it("8. full takeover reconciles both Registry-to-local failure windows and invalidates the old owner", async () => {
    const fixture = await makeGateFixture();
    let failBeforeSave = false;
    let armPostPushFetchFailure = false;
    let failFollowingFetch = false;
    const hooks: WorktreeStateHooks = {
      beforeSave: () => {
        if (!failBeforeSave) return;
        failBeforeSave = false;
        throw new Error("injected takeover state failure");
      },
    };
    const clockValues = [
      "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:01.000Z", "2026-08-13T00:00:02.000Z",
      "2026-08-13T00:00:03.000Z", "2026-08-13T00:00:04.000Z", "2026-08-13T00:00:05.000Z",
    ].map((value) => new Date(value));
    const now = () => clockValues.shift() ?? new Date("2026-08-13T00:00:06.000Z");
    const delegate = new ProcessRunner();
    const injectedRunner = new ProcessRunner() as ProcessRunner & { run: ProcessRunner["run"] };
    injectedRunner.run = async (command, args, options) => {
      if (command === "git" && args[0] === "fetch" && failFollowingFetch) {
        failFollowingFetch = false;
        throw new ControlError("COMMAND_FAILED", "injected takeover post-push verification failure");
      }
      const result = await delegate.run(command, args, options);
      if (command === "git" && args[0] === "push" && armPostPushFetchFailure) {
        armPostPushFetchFailure = false;
        failFollowingFetch = true;
      }
      return result;
    };
    const graph = graphFor(fixture, fixture.cloneA, { runner: injectedRunner, worktreeHooks: hooks, now });
    const dependencies = cliDependencies(graph);
    const started = await runCli(temporaryStartArgs("control:takeover", fixture.sourceRepo, "codex-old"), dependencies);
    const { task, claim: oldClaim } = JSON.parse(started.stdout).result;
    const taskId = task.task_id as string;
    const fullOldClaim = await graph.claims.getActive(taskId);
    expect(fullOldClaim).toBeDefined();
    const firstTakeoverArgs = ["task", "recover", "--task", taskId, "--expect", oldClaim.claim_id, "--action", "takeover", "--session", "codex-new"];
    armPostPushFetchFailure = true;
    const postPushFailure = await runCli(firstTakeoverArgs, dependencies);
    expect(postPushFailure).toMatchObject({ exitCode: 75 });
    expect(JSON.parse(postPushFailure.stderr)).toEqual({ error: { code: "REMOTE_VERIFY_FAILED" } });
    const firstRemoteHead = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
    const firstSuccessor = await graph.claims.getActive(taskId);
    expect(firstSuccessor?.claim_id).not.toBe(oldClaim.claim_id);
    expect((await graph.worktrees.recoveryStatus(fullOldClaim!)).claim_id).toBe(oldClaim.claim_id);

    const postPushRetry = await runCli(firstTakeoverArgs, dependencies);
    expect(postPushRetry.exitCode).toBe(0);
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(firstRemoteHead);
    const firstSuccessorId = JSON.parse(postPushRetry.stdout).result.active.claim_id;
    expect(firstSuccessorId).toBe(firstSuccessor?.claim_id);

    failBeforeSave = true;
    const secondTakeoverArgs = ["task", "recover", "--task", taskId, "--expect", firstSuccessorId, "--action", "takeover", "--session", "codex-final"];
    const stateFailure = await runCli(secondTakeoverArgs, dependencies);
    expect(stateFailure).toMatchObject({ exitCode: 1 });
    const secondRemoteHead = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
    const secondSuccessor = await graph.claims.getActive(taskId);
    expect(secondSuccessor?.claim_id).not.toBe(firstSuccessorId);

    const stateRetry = await runCli(secondTakeoverArgs, dependencies);
    expect(stateRetry.exitCode).toBe(0);
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(secondRemoteHead);
    const newClaimId = JSON.parse(stateRetry.stdout).result.active.claim_id;
    const stateBytes = await readFile(join(fixture.stateDir, "worktrees.json"), "utf8");
    const retriedAgain = await runCli(secondTakeoverArgs, dependencies);
    expect(retriedAgain.exitCode).toBe(0);
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(secondRemoteHead);
    expect(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8")).toBe(stateBytes);

    const newStatus = await runCli(["task", "status", "--task", taskId, "--claim", newClaimId], dependencies);
    expect(newStatus.exitCode).toBe(0);
    for (const result of [
      await runCli(["task", "status", "--task", taskId, "--claim", oldClaim.claim_id], dependencies),
      await runCli(["task", "assert-owner", "--task", taskId, "--claim", oldClaim.claim_id], dependencies),
      await runCli(completedFinishArgs(taskId, oldClaim.claim_id), dependencies),
      await runCli(["task", "status", "--task", taskId, "--claim", firstSuccessorId], dependencies),
      await runCli(["task", "assert-owner", "--task", taskId, "--claim", firstSuccessorId], dependencies),
      await runCli(completedFinishArgs(taskId, firstSuccessorId), dependencies),
    ]) expect(result.exitCode).toBe(4);
    expect((await graph.claims.getActive(taskId))?.claim_id).toBe(newClaimId);

    const mappingBeforeFinish = JSON.parse(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8"))
      .worktrees[oldClaim.worktree_ref];
    const physicalWorktreePath = mappingBeforeFinish.path as string;
    expect(mappingBeforeFinish).toMatchObject({ claim_id: newClaimId, lifecycle: "active" });
    expect(await exists(physicalWorktreePath)).toBe(true);
    const finished = await runCli(completedFinishArgs(taskId, newClaimId), dependencies);
    expect(finished.exitCode).toBe(0);
    expect(JSON.parse(finished.stdout).result.worktree_removed).toBe(true);
    const oldHistory = JSON.parse(await readFile(join(fixture.cloneA, "claims", "history", "2026", taskId, `${oldClaim.claim_id}.yaml`), "utf8"));
    const middleHistory = JSON.parse(await readFile(join(fixture.cloneA, "claims", "history", "2026", taskId, `${firstSuccessorId}.yaml`), "utf8"));
    const newHistory = JSON.parse(await readFile(join(fixture.cloneA, "claims", "history", "2026", taskId, `${newClaimId}.yaml`), "utf8"));
    expect(oldHistory).toMatchObject({ status: "taken-over", successor_claim_id: firstSuccessorId });
    expect(middleHistory).toMatchObject({ status: "taken-over", successor_claim_id: newClaimId });
    expect(newHistory).toMatchObject({ status: "completed" });
    expect(await graph.claims.getActive(taskId)).toBeUndefined();
    expect(await exists(join(fixture.cloneA, "tasks", `${taskId}.yaml`))).toBe(true);
    const removedMapping = JSON.parse(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8"))
      .worktrees[oldClaim.worktree_ref];
    expect(removedMapping).toMatchObject({
      claim_id: newClaimId, lifecycle: "removed",
    });
    expect(await exists(physicalWorktreePath)).toBe(false);
  }, 15_000);

  it("9. offline provisional work is unclaimed and cannot assert ownership", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    await graph.catalog.registerRepository(repositoryInput);
    const task = await graph.catalog.registerTemporaryTask({
      project_id: "prj-control", repo_id: "repo-control", alias: "control:offline", goal: "offline",
      done_conditions: ["later"], expected_scope: ["src/control"],
    });
    const provisional = join(fixture.worktreeRoot, "offline-provisional");
    await git(fixture.sourceRepo, "worktree", "add", "-b", "provisional/offline", provisional, "HEAD");
    const dependencies = cliDependencies(graph);

    expect((await runCli(["task", "status", "--task", task.id], dependencies)).exitCode).toBe(4);
    expect((await runCli(["task", "assert-owner", "--task", task.id, "--claim", "clm-0198aabb-ccdd-7eef-8abc-0123456789ab"], dependencies)).exitCode).toBe(4);
    expect(await exists(join(fixture.cloneA, "claims", "active", `${task.id}.yaml`))).toBe(false);
  });

  it("10. Handoff release retains the Task, committed checkpoint, mapping, and worktree", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const dependencies = cliDependencies(graph);
    const started = await runCli(temporaryStartArgs("control:handoff", fixture.sourceRepo, "codex-handoff"), dependencies);
    const { task, claim } = JSON.parse(started.stdout).result;
    const taskId = task.task_id as string;
    const result = await runCli([
      "task", "finish", "--task", taskId, "--claim", claim.claim_id, "--status", "handoff",
      "--validation", "checkpoint: pass", "--progress", "gate progress",
      "--active-work-minutes", "1",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    const finished = JSON.parse(result.stdout).result;
    const pointer = `handoffs/${taskId}/${claim.claim_id}.md`;
    const mapping = JSON.parse(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8")).worktrees[claim.worktree_ref];
    const localHandoff = await readFile(join(mapping.path, ".ai", "handoff.md"), "utf8");
    const audit = await freshAuditClone(fixture, "handoff-audit");
    const remoteHead = (await git(fixture.root, "ls-remote", fixture.remoteDir, "refs/heads/main")).trim().split(/\s+/)[0];
    expect((await git(audit, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(await git(audit, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(JSON.parse(await readFile(join(audit, "tasks", `${taskId}.yaml`), "utf8"))).toMatchObject({ id: taskId });
    const committedHandoff = await readFile(join(audit, pointer), "utf8");
    expect(committedHandoff).toBe(localHandoff);
    expect(committedHandoff).toContain(`# Handoff: ${taskId}`);
    const history = JSON.parse(await readFile(
      join(audit, "claims", "history", finished.released_at.slice(0, 4), taskId, `${claim.claim_id}.yaml`),
      "utf8",
    ));
    expect(history).toMatchObject({
      task_id: taskId,
      claim_id: claim.claim_id,
      status: "handoff",
      handoff_path: pointer,
    });
    expect(finished).toMatchObject({
      task_id: taskId,
      claim_id: claim.claim_id,
      status: "handoff",
      handoff_pointer: pointer,
      worktree_removed: false,
    });
    expect(await exists(join(audit, "claims", "active", `${taskId}.yaml`))).toBe(false);
    expect(mapping).toMatchObject({
      task_id: taskId,
      claim_id: claim.claim_id,
      session_id: "codex-handoff",
      host: graph.config.buildHost,
      branch: claim.branch,
      lifecycle: "active",
      path: join(fixture.worktreeRoot, claim.worktree_ref),
    });
    expect(await exists(mapping.path)).toBe(true);
    expect(await readFile(join(mapping.path, ".ai", "handoff.md"), "utf8")).toBe(committedHandoff);
    expect(await graph.claims.getActive(taskId)).toBeUndefined();
  });

  it("11. completed release records history but refuses unsafe dirty cleanup", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const dependencies = cliDependencies(graph);
    const started = await runCli(temporaryStartArgs("control:dirty", fixture.sourceRepo, "codex-dirty"), dependencies);
    const { task, claim } = JSON.parse(started.stdout).result;
    const taskId = task.task_id as string;
    const mapping = JSON.parse(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8")).worktrees[claim.worktree_ref];
    await writeFile(join(mapping.path, "dirty.txt"), "dirty\n", "utf8");

    const result = await runCli(completedFinishArgs(taskId, claim.claim_id), dependencies);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result.worktree_removed).toBe(false);
    expect(await graph.claims.getActive(taskId)).toBeUndefined();
    expect(await exists(join(fixture.cloneA, "claims", "history", "2026", taskId, `${claim.claim_id}.yaml`))).toBe(true);
    expect(await exists(mapping.path)).toBe(true);
  });

  it("12. portfolio pages keep the exact CLI envelope within 12 KiB and 20 items", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const portfolio = new PortfolioService({ projectClient: { readAll: async () => projectSource() }, stateDir: fixture.stateDir });
    const dependencies = cliDependencies(graph, { portfolio: { ...cliDependencies(graph).portfolio, status: portfolio.status.bind(portfolio) } });
    let page: string | undefined;
    const observed: string[] = [];
    let pageNumber = 1;
    do {
      const result = await runCli(["portfolio", "status", ...(page ? ["--page", page] : [])], dependencies);
      expect(result.exitCode).toBe(0);
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
      const payload = JSON.parse(result.stdout).result;
      expect(payload.page_id).toBe(`page-${pageNumber}`);
      expect(payload.items.length).toBeLessThanOrEqual(20);
      expect(payload.total_items).toBe(23);
      expect(payload.truncated).toBe(payload.next_page_id !== undefined);
      observed.push(...payload.items.map((item: { project_id: string }) => item.project_id));
      page = payload.next_page_id;
      pageNumber += 1;
    } while (page);
    expect(new Set(observed).size).toBe(23);
    expect(observed).toHaveLength(23);
  });

  it("13. cached registry authority rejects rollback and central unavailability", async () => {
    const fixture = await makeGateFixture();
    const cachePath = join(fixture.stateDir, "authority-cache.json");
    await writeFile(cachePath, `${JSON.stringify({ authority_epoch: 4, mode: "registry" })}\n`, { mode: 0o600 });
    let central: Parameters<typeof createAuthorityService>[0]["readCentral"] extends () => Promise<infer R> ? R : never = {
      authority_epoch: 3, mode: "legacy", cutover_at: null, minimum_tool_version: "1.0.0",
    };
    const authority = createAuthorityService({ readCentral: async () => central, cachePath, writesDisabled: false });

    await expect(authority.load()).rejects.toMatchObject({ code: "AUTHORITY_EPOCH_ROLLBACK" });
    central = null;
    await expect(authority.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ authority_epoch: 4, mode: "registry" });
  });

  it("14. real preflight rejects repo-scoped Project token through a self-auditing fake gh", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const { queueDir, logPath } = await writeFakeGh(fixture);
    const projectToken = "phase1a-project-token-value";
    const repoToken = "phase1a-repo-token-value";
    const projectTokenSha256 = createHash("sha256").update(projectToken).digest("hex");
    const repoTokenSha256 = createHash("sha256").update(repoToken).digest("hex");
    await writeFile(join(queueDir, "0000.json"), `${JSON.stringify({
      expect: { operation: "rest:GET:repos/jhw7500/control/issues/1", keys: [] },
      expectTokenSha256: repoTokenSha256,
      stdout: `${JSON.stringify({
        node_id: "I_fixture",
        title: "trial",
        body: "unchanged",
        labels: [{ name: "trial", color: "ededed" }],
      })}\n`,
      stderr: "",
      exitCode: 0,
    })}\n`, { mode: 0o600 });
    await writeFile(join(queueDir, "0001.json"), `${JSON.stringify({
      expect: { operation: "rest:GET:/user", keys: [] },
      expectTokenSha256: projectTokenSha256,
      stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project, repo\r\n\r\n{}\n",
      stderr: "",
      exitCode: 0,
    })}\n`, { mode: 0o600 });
    const fingerprints = [projectToken, repoToken].map((token) => ({
      length: token.length,
      sha256: createHash("sha256").update(token).digest("hex"),
    }));
    const environment = {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      JHW_FAKE_GH_DIR: queueDir,
      JHW_FAKE_SECRET_FINGERPRINTS: JSON.stringify(fingerprints),
      GH_PROJECT_TOKEN: projectToken,
      GH_REPO_TOKEN: repoToken,
    };
    const runner = new ProcessRunner(environment);
    const realisticIssue = JSON.parse((await runner.runGh([
      "api", "repos/jhw7500/control/issues/1",
    ], "repo")).stdout);
    expect(realisticIssue.labels).toEqual([{ name: "trial", color: "ededed" }]);
    const project: PreflightProjectPort = {
      verifyFields: async () => undefined,
      addPreflightItem: async () => "PVTI_trial",
      verifyItemContentId: async () => "I_fixture",
      readLastReviewed: async () => undefined,
      writeLastReviewed: async () => undefined,
      clearLastReviewed: async () => undefined,
    };
    const preflight = new PreflightService({
      config: graph.config,
      environment,
      runner,
      project,
      authority: { observeCommittedLegacy: async () => undefined },
      notion: { verifyReadOnlyRoutes: async () => undefined },
      repository: { verifyPrivateRepository: async () => undefined },
      registry: { assertReady: async () => undefined },
    });
    const caughtMetadata: RawErrorAudit[] = [];
    const auditedPreflight = {
      async run() {
        try {
          return await preflight.run();
        } catch (cause) {
          caughtMetadata.push(rawErrorAudit(cause));
          throw cause;
        }
      },
    };
    const dependencies = cliDependencies(graph, {
      env: environment,
      preflight: auditedPreflight,
      mutationLock: { run: async (callback) => callback() },
      journal: new PilotJournal(graph.config.stateDir),
    });

    const result = await runCli(["preflight"], dependencies);

    expect(result).toMatchObject({ exitCode: 78 });
    expect(caughtMetadata).toHaveLength(1);
    expect(caughtMetadata[0]).toEqual({
      name: "ControlError",
      message: "Project token must not expose repo scope",
      code: "PROJECT_TOKEN_HAS_REPO_SCOPE",
      details: {},
    });
    const errorMetadata = JSON.parse(result.stderr);
    expect(errorMetadata).toEqual({ error: { code: "PROJECT_TOKEN_HAS_REPO_SCOPE" } });
    const operationLog = await readFile(logPath, "utf8");
    expect(operationLog.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      {
        operation: "rest:GET:repos/jhw7500/control/issues/1", keys: [],
        selected_token_sha256: repoTokenSha256, source_credentials_absent: true,
      },
      {
        operation: "rest:GET:/user", keys: [],
        selected_token_sha256: projectTokenSha256, source_credentials_absent: true,
      },
    ]);
    const queuedArtifacts = await readdir(queueDir);
    expect(queuedArtifacts.filter((name) => /^\d{4}\.json$/.test(name))).toEqual([]);
    expect(queuedArtifacts.filter((name) => /^000[01]\.json\.claimed-\d+$/.test(name))).toHaveLength(2);
    const journal = await readFile(join(fixture.stateDir, "pilot-journal.jsonl"), "utf8");
    expect(JSON.parse(journal)).toMatchObject({ command: "preflight", ok: false, error_code: "PROJECT_TOKEN_HAS_REPO_SCOPE" });
    const rawErrorArtifact = JSON.stringify(caughtMetadata);
    const artifacts = [
      result.stdout,
      result.stderr,
      JSON.stringify(errorMetadata),
      rawErrorArtifact,
      journal,
      operationLog,
      await readFile(join(fixture.binDir, "gh"), "utf8"),
      ...await textArtifacts(queueDir),
      ...await textArtifacts(fixture.stateDir),
      ...await textArtifacts(fixture.root),
    ];
    for (const token of [projectToken, repoToken]) expect(artifacts.join("\n")).not.toContain(token);
  });

  it("15. journal failure preserves successful Task coordinates and idempotent retry", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const dependencies = cliDependencies(graph, {
      journal: { append: async () => { throw new Error("injected journal outage"); } },
    });
    const args = temporaryStartArgs("control:journal-gap", fixture.sourceRepo, "codex-journal-gap");

    const first = await runCli(args, dependencies);
    const retry = await runCli(args, dependencies);

    expect(first.exitCode).toBe(0);
    expect(retry.exitCode).toBe(0);
    const firstPayload = JSON.parse(first.stdout);
    const retryPayload = JSON.parse(retry.stdout);
    expect(firstPayload.journal_warning).toEqual({ code: "JOURNAL_WRITE_FAILED" });
    expect(retryPayload.journal_warning).toEqual({ code: "JOURNAL_WRITE_FAILED" });
    expect(retryPayload.result.task.task_id).toBe(firstPayload.result.task.task_id);
    expect(retryPayload.result.claim.claim_id).toBe(firstPayload.result.claim.claim_id);
    const taskFiles = (await readdir(join(fixture.cloneA, "tasks"), { withFileTypes: true }))
      .filter((entry) => entry.isFile());
    expect(taskFiles).toHaveLength(1);
  }, 15_000);

  it("16. explicit existing-Task resume returns only the bounded latest Handoff and reuses the worktree", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const dependencies = cliDependencies(graph);
    const started = await runCli(temporaryStartArgs("control:explicit-resume", fixture.sourceRepo, "codex-before-handoff"), dependencies);
    const first = JSON.parse(started.stdout).result;
    const released = await runCli([
      "task", "finish", "--task", first.task.task_id, "--claim", first.claim.claim_id,
      "--status", "handoff", "--validation", "focused e2e: pass", "--progress", "bounded resume context",
    ], dependencies);
    expect(released.exitCode).toBe(0);

    const resumed = await runCli([
      "task", "start", "--task", first.task.task_id, "--repo-path", fixture.sourceRepo,
      "--session", "codex-after-handoff",
    ], dependencies);

    expect(resumed.exitCode).toBe(0);
    expect(Buffer.byteLength(resumed.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(JSON.parse(resumed.stdout).result).toMatchObject({
      task: { task_id: first.task.task_id },
      reused: true,
      latest_handoff: {
        claim_id: first.claim.claim_id,
        sections: { "Progress Since Last Checkpoint": "bounded resume context" },
      },
    });
  }, 15_000);

  it("17. completed formal Claim history does not replace an open Issue as lifecycle authority", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    await graph.catalog.registerRepository(repositoryInput);
    const formal = (await graph.catalog.registerFormalTask(issueInput)).task;
    const dependencies = cliDependencies(graph);
    const first = await runCli([
      "task", "start", "--task", formal.id, "--repo-path", fixture.sourceRepo, "--session", "codex-formal-first",
    ], dependencies);
    const firstClaim = JSON.parse(first.stdout).result.claim.claim_id;
    expect((await runCli(completedFinishArgs(formal.id, firstClaim), dependencies)).exitCode).toBe(0);

    const reopened = await runCli([
      "task", "start", "--task", formal.id, "--repo-path", fixture.sourceRepo, "--session", "codex-formal-open",
    ], dependencies);

    expect(reopened.exitCode).toBe(0);
    expect(JSON.parse(reopened.stdout).result).toMatchObject({ task: { task_id: formal.id } });
    expect(JSON.parse(reopened.stdout).result.claim.claim_id).not.toBe(firstClaim);
  }, 15_000);

  it("18. abandoned cleanup blocks a successor until exact released-generation recovery completes", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const dependencies = cliDependencies(graph);
    const started = await runCli(temporaryStartArgs("control:cleanup-recovery", fixture.sourceRepo, "codex-cleanup-first"), dependencies);
    const first = JSON.parse(started.stdout).result;
    const mapping = JSON.parse(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8"))
      .worktrees[first.claim.worktree_ref];
    const dirtyPath = join(mapping.path, "dirty-after-release.txt");
    await writeFile(dirtyPath, "dirty\n", "utf8");
    const abandoned = await runCli([
      "task", "finish", "--task", first.task.task_id, "--claim", first.claim.claim_id,
      "--status", "abandoned", "--validation", "cleanup recovery e2e",
    ], dependencies);
    expect(abandoned.exitCode).toBe(0);
    expect(JSON.parse(abandoned.stdout).result.worktree_removed).toBe(false);

    const blocked = await runCli([
      "task", "start", "--task", first.task.task_id, "--repo-path", fixture.sourceRepo, "--session", "codex-cleanup-blocked",
    ], dependencies);
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stderr)).toEqual({ error: { code: "WORKTREE_CLEANUP_REQUIRED" } });
    expect(await graph.claims.getActive(first.task.task_id)).toBeUndefined();

    await unlink(dirtyPath);
    const cleanup = await runCli([
      "task", "recover", "--task", first.task.task_id, "--expect", first.claim.claim_id, "--action", "cleanup",
    ], dependencies);
    expect(cleanup.exitCode).toBe(0);
    expect(JSON.parse(cleanup.stdout).result).toMatchObject({ kind: "cleanup", task_id: first.task.task_id });
    expect(JSON.parse(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8"))
      .worktrees[first.claim.worktree_ref]).toMatchObject({ lifecycle: "removed" });
    const resumed = await runCli([
      "task", "start", "--task", first.task.task_id, "--repo-path", fixture.sourceRepo, "--session", "codex-cleanup-recovered",
    ], dependencies);
    expect(resumed.exitCode).toBe(0);
  }, 15_000);

  it("19. centralized persistence policy rejects injected credential and private source path with clean authority", async () => {
    const fixture = await makeGateFixture();
    const config = fixtureConfig(fixture, fixture.cloneA);
    const registry = isolatedRegistryGit(config, new ProcessRunner());
    const secret = "unmistakably-fake-e2e-persistence-token";
    const catalog = new Catalog(config, registry, createSensitiveDataPolicy(
      { FAKE_API_TOKEN: secret },
      [fixture.sourceRepo, fixture.cloneA, fixture.stateDir, fixture.worktreeRoot],
    ));
    await catalog.registerRepository(repositoryInput);
    const before = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();

    for (const goal of [`do not persist ${secret}`, `do not persist ${fixture.sourceRepo}/private.ts`]) {
      await expect(catalog.registerTemporaryTask({
        project_id: "prj-control", repo_id: "repo-control", alias: `control:rejected-${goal === secret ? "secret" : createHash("sha256").update(goal).digest("hex").slice(0, 8)}`,
        goal, done_conditions: ["reject"], expected_scope: ["src/control"],
      })).rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    }
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(before);
    expect(await git(fixture.cloneA, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const audit = await freshAuditClone(fixture, "persistence-policy-audit");
    const artifacts = await textArtifacts(audit);
    expect(artifacts.join("\n")).not.toContain(secret);
    expect(artifacts.join("\n")).not.toContain(fixture.sourceRepo);
  }, 15_000);

  it("20. descriptor-hostile Registry ancestors, leaves, and hardlinks preserve the outside sentinel and Git authority", async () => {
    for (const kind of ["ancestor-symlink", "leaf-symlink", "hardlink"] as const) {
      const fixture = await makeGateFixture();
      const graph = graphFor(fixture, fixture.cloneA);
      const outside = join(fixture.root, `${kind}-outside`);
      const sentinel = kind === "ancestor-symlink" ? join(outside, "sentinel.txt") : outside;
      if (kind === "ancestor-symlink") {
        await mkdir(outside);
        await writeFile(sentinel, "outside-sentinel\n", "utf8");
        await symlink(outside, join(fixture.cloneA, "repositories"));
        await git(fixture.cloneA, "add", "--", "repositories");
        await git(fixture.cloneA, "commit", "-m", "Add hostile repositories ancestor");
        await git(fixture.cloneA, "push", "origin", "main");
      } else if (kind === "leaf-symlink") {
        await writeFile(sentinel, `${JSON.stringify({ id: "repo-hostile", github_node_id: "R_hostile", slug: "jhw7500/hostile" })}\n`, "utf8");
        await mkdir(join(fixture.cloneA, "repositories"));
        await symlink(sentinel, join(fixture.cloneA, "repositories", "repo-hostile.yaml"));
        await git(fixture.cloneA, "add", "--", "repositories");
        await git(fixture.cloneA, "commit", "-m", "Add hostile Repository leaf");
        await git(fixture.cloneA, "push", "origin", "main");
      } else {
        await graph.catalog.registerRepository(repositoryInput);
        await link(join(fixture.cloneA, "repositories", "repo-control.yaml"), sentinel);
      }
      const beforeSentinel = await readFile(sentinel, "utf8");
      const beforeStatus = await git(fixture.cloneA, "status", "--porcelain", "--untracked-files=all");
      const beforeHead = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
      const beforeRemote = (await git(fixture.root, "ls-remote", fixture.remoteDir, "refs/heads/main")).trim();

      const operation = kind === "hardlink"
        ? graph.catalog.getRepository("repo-control")
        : graph.catalog.registerRepository({ repo_id: "repo-hostile", github_node_id: "R_hostile", slug: "jhw7500/hostile" });
      await expect(operation, kind).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

      expect(await readFile(sentinel, "utf8"), kind).toBe(beforeSentinel);
      expect(await git(fixture.cloneA, "status", "--porcelain", "--untracked-files=all"), kind).toBe(beforeStatus);
      expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim(), kind).toBe(beforeHead);
      expect((await git(fixture.root, "ls-remote", fixture.remoteDir, "refs/heads/main")).trim(), kind).toBe(beforeRemote);
    }
  }, 30_000);

  it("21. public Repository and formal Task flow verifies membership, checkout, Issue coordinates, and source authority before Claim", async () => {
    const fixture = await makeGateFixture();
    await git(fixture.sourceRepo, "remote", "add", "origin", "https://github.com/jhw7500/control.git");
    const graph = graphFor(fixture, fixture.cloneA);
    const runner = new GateSourceRunner();
    let membershipFailure: string | undefined;
    const membershipCalls: Array<[string, string]> = [];
    const source = new GitHubSourceService({
      runner,
      catalog: graph.catalog,
      projects: {
        async requireProjectRepository(projectId, repoId) {
          membershipCalls.push([projectId, repoId]);
          if (membershipFailure) throw new ControlError(membershipFailure, "injected membership refusal");
        },
      },
    });
    const dependencies = cliDependencies(graph, { source });
    const registered = await runCli([
      "repository", "register", "--repo-id", "repo-control", "--slug", "jhw7500/control",
      "--repo-path", fixture.sourceRepo,
    ], dependencies);
    expect(registered.exitCode).toBe(0);
    expect(JSON.parse(registered.stdout).result).toMatchObject({ repo_id: "repo-control", slug: "jhw7500/control", created: true });

    const formalArgs = (session: string, overrides: {
      repositoryPath?: string; issueUrl?: string; issueNodeId?: string; issueRevision?: string;
    } = {}) => [
      "task", "start", "--project", "prj-control", "--repo-id", "repo-control",
      "--repo-path", overrides.repositoryPath ?? fixture.sourceRepo,
      "--issue-url", overrides.issueUrl ?? issueInput.issue_url,
      "--issue-node-id", overrides.issueNodeId ?? issueInput.issue_node_id,
      "--issue-revision", overrides.issueRevision ?? issueInput.issue_revision,
      "--session", session,
    ];
    const initialHead = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
    membershipFailure = "PROJECT_RECORD_NOT_FOUND";
    const missingMembership = await runCli(formalArgs("source-membership-missing"), dependencies);
    expect(JSON.parse(missingMembership.stderr)).toEqual({ error: { code: "PROJECT_RECORD_NOT_FOUND" } });
    membershipFailure = undefined;

    const wrongRepository = await runCli(formalArgs("source-wrong-repository", {
      issueUrl: "https://github.com/other/repository/issues/1",
    }), dependencies);
    expect(JSON.parse(wrongRepository.stderr)).toEqual({ error: { code: "ISSUE_REPOSITORY_MISMATCH" } });
    const wrongNode = await runCli(formalArgs("source-wrong-node", { issueNodeId: "I_wrong" }), dependencies);
    expect(JSON.parse(wrongNode.stderr)).toEqual({ error: { code: "ISSUE_IDENTITY_MISMATCH" } });
    const wrongRevision = await runCli(formalArgs("source-wrong-revision", {
      issueRevision: "2026-08-13T00:00:01Z",
    }), dependencies);
    expect(JSON.parse(wrongRevision.stderr)).toEqual({ error: { code: "ISSUE_REVISION_MISMATCH" } });
    runner.repository = { ...runner.repository, node_id: "R_other" };
    const wrongNodeRepository = await runCli(formalArgs("source-wrong-repository-node"), dependencies);
    expect(JSON.parse(wrongNodeRepository.stderr)).toEqual({ error: { code: "REPOSITORY_IDENTITY_MISMATCH" } });
    runner.repository = { ...runner.repository, node_id: repositoryInput.github_node_id };

    const wrongCheckout = join(fixture.root, "wrong-checkout");
    await git(fixture.root, "init", "--initial-branch=main", wrongCheckout);
    await git(wrongCheckout, "config", "user.name", "Phase1A Test");
    await git(wrongCheckout, "config", "user.email", "phase1a@example.invalid");
    await writeFile(join(wrongCheckout, "README.md"), "wrong\n", "utf8");
    await git(wrongCheckout, "add", "README.md");
    await git(wrongCheckout, "commit", "-m", "wrong checkout");
    await git(wrongCheckout, "remote", "add", "origin", "https://github.com/other/repository.git");
    const checkoutFailure = await runCli(formalArgs("source-wrong-checkout", { repositoryPath: wrongCheckout }), dependencies);
    expect(JSON.parse(checkoutFailure.stderr)).toEqual({ error: { code: "CHECKOUT_REMOTE_MISMATCH" } });
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(await exists(join(fixture.cloneA, "claims", "active"))).toBe(false);

    const correct = await runCli(formalArgs("source-verified"), dependencies);
    expect(correct.exitCode).toBe(0);
    const correctResult = JSON.parse(correct.stdout).result;
    expect(correctResult).toMatchObject({ task: { kind: "formal" } });
    expect(await graph.catalog.getTask(correctResult.task.task_id)).toMatchObject({
      kind: "formal", aliases: ["jhw7500/control#1"],
    });
    expect(await graph.claims.getActive(correctResult.task.task_id)).toMatchObject({
      claim_id: correctResult.claim.claim_id, session_id: "source-verified",
    });
    expect(membershipCalls).toContainEqual(["prj-control", "repo-control"]);
    expect(runner.calls.filter((call) => call.command === "gh").every((call) => call.credential === "repo")).toBe(true);
  }, 30_000);

  it("22. a duplicate formal source relation fails closed without changing local or remote Registry authority", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    await graph.catalog.registerRepository(repositoryInput);
    const taskIds = [
      "tsk-0198aabb-ccdd-7eef-8abc-0123456789ab",
      "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
    ];
    const duplicateIssue = { ...issueInput, issue_node_id: "I_duplicate", issue_url: "https://github.com/jhw7500/control/issues/2", alias: "jhw7500/control#2" };
    for (const id of taskIds) {
      await mkdir(join(fixture.cloneA, "tasks"), { recursive: true });
      await writeFile(join(fixture.cloneA, "tasks", `${id}.yaml`), `${JSON.stringify({
        id, kind: "formal", project_id: duplicateIssue.project_id, repo_id: duplicateIssue.repo_id,
        aliases: [duplicateIssue.alias], issue_node_id: duplicateIssue.issue_node_id,
        issue_revision: duplicateIssue.issue_revision, issue_url: duplicateIssue.issue_url,
      })}\n`, "utf8");
    }
    const indexDirectory = join(fixture.cloneA, "tasks", "by-source", "github");
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(join(indexDirectory, `${sourceIndexKey(duplicateIssue.issue_node_id)}.yaml`), `${JSON.stringify({ task_id: taskIds[0] })}\n`, "utf8");
    await git(fixture.cloneA, "add", "--", "tasks");
    await git(fixture.cloneA, "commit", "-m", "Inject duplicate formal source fixture");
    await git(fixture.cloneA, "push", "origin", "main");
    const beforeHead = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
    const beforeRemote = (await git(fixture.root, "ls-remote", fixture.remoteDir, "refs/heads/main")).trim();

    await expect(graph.catalog.registerFormalTask(duplicateIssue)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(beforeHead);
    expect((await git(fixture.root, "ls-remote", fixture.remoteDir, "refs/heads/main")).trim()).toBe(beforeRemote);
    expect(await git(fixture.cloneA, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }, 15_000);

  it("23. Project registration retries an attached partial record and re-verifies all five fields without duplicate attachment", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    await graph.catalog.registerRepository(repositoryInput);
    const input = {
      project_id: "prj-example", title: "Example", objective: "Prove the trial flow", repo_ids: ["repo-control"],
      fields: { status: "proposed" as const, priority: "P2" as const, health: "unknown" as const, next_action: "wait:select", last_reviewed: "2026-08-13" },
    };
    const issue = {
      node_id: "I_existing", number: 77, title: input.title,
      body: JSON.stringify({ id: input.project_id, objective: input.objective, repositories: input.repo_ids }),
      labels: [{ name: "trial" }, { name: "project-record" }],
    };
    const mutation = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_existing" } } } };
    const interruptedRunner = new GateProjectRunner();
    interruptedRunner.enqueue(
      gateProjectPage(gateProjectItem(false)), [[issue]], issue,
      mutation, mutation, new Error("injected third-field boundary"),
    );
    const interrupted = new GitHubProjectClient({
      githubOwner: "jhw7500", projectNumber: 7, registryRepository: "jhw7500/project-registry",
      preflightProjectItemId: "PVTI_trial", runner: interruptedRunner, catalog: graph.catalog,
    });
    await expect(interrupted.registerProject(input)).rejects.toThrow("injected third-field boundary");
    expect(interruptedRunner.calls.some((call) => call.args.join(" ").includes("addProjectV2ItemById"))).toBe(false);

    const retryRunner = new GateProjectRunner();
    retryRunner.enqueue(
      gateProjectPage(gateProjectItem(false)), [[issue]], issue,
      mutation, mutation, mutation, mutation, mutation,
      gateProjectPage(gateProjectItem(true)),
    );
    const retry = new GitHubProjectClient({
      githubOwner: "jhw7500", projectNumber: 7, registryRepository: "jhw7500/project-registry",
      preflightProjectItemId: "PVTI_trial", runner: retryRunner, catalog: graph.catalog,
    });
    const dependencies = cliDependencies(graph, {
      portfolio: { ...cliDependencies(graph).portfolio, registerProject: retry.registerProject.bind(retry) },
    });
    const result = await runCli([
      "project", "register", "--project", input.project_id, "--title", input.title, "--objective", input.objective,
      "--repo-id", "repo-control", "--status", "proposed", "--priority", "P2", "--health", "unknown",
      "--next-action", "wait:select", "--last-reviewed", "2026-08-13",
    ], dependencies);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result).toEqual({
      project_id: "prj-example", project_item_id: "PVTI_existing", source_node_id: "I_existing", issue_number: 77,
    });
    expect(retryRunner.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"))).toHaveLength(5);
    expect(retryRunner.calls.some((call) => call.args.join(" ").includes("addProjectV2ItemById"))).toBe(false);
  }, 20_000);

  it("24. cleanup recovery resumes failures after release, pending-remove persistence, and physical removal before any successor Claim", async () => {
    for (const boundary of ["after-release", "after-pending-remove", "after-physical-remove"] as const) {
      let saves = 0;
      let injected = false;
      const fixture = await makeGateFixture();
      const graph = graphFor(fixture, fixture.cloneA, {
        worktreeHooks: boundary === "after-release" ? undefined : {
          beforeSave: () => {
            saves += 1;
            const target = boundary === "after-pending-remove" ? 3 : 4;
            if (!injected && saves === target) {
              injected = true;
              throw new Error(`injected ${boundary}`);
            }
          },
        },
      });
      let releaseFailure = boundary === "after-release";
      const worktrees = boundary === "after-release" ? {
        assertStartReady: graph.worktrees.assertStartReady.bind(graph.worktrees),
        createOrReuse: graph.worktrees.createOrReuse.bind(graph.worktrees),
        inspect: graph.worktrees.inspect.bind(graph.worktrees),
        removeIfSafe: async (...args: Parameters<WorktreeManager["removeIfSafe"]>) => {
          if (releaseFailure) {
            releaseFailure = false;
            throw new Error("injected post-release cleanup failure");
          }
          return graph.worktrees.removeIfSafe(...args);
        },
        assertForceEndEligible: graph.worktrees.assertForceEndEligible.bind(graph.worktrees),
        assertTakeoverEligible: graph.worktrees.assertTakeoverEligible.bind(graph.worktrees),
        rebindTakeover: graph.worktrees.rebindTakeover.bind(graph.worktrees),
        cleanupReleased: graph.worktrees.cleanupReleased.bind(graph.worktrees),
      } : graph.worktrees;
      const tasks = boundary === "after-release"
        ? new TaskService(graph.config, graph.claims, worktrees, graph.registry)
        : graph.tasks;
      const dependencies = cliDependencies(graph, { taskService: tasks });
      const started = await runCli(temporaryStartArgs(`control:${boundary}`, fixture.sourceRepo, `session-${boundary}`), dependencies);
      const first = JSON.parse(started.stdout).result;
      const finished = await runCli([
        "task", "finish", "--task", first.task.task_id, "--claim", first.claim.claim_id,
        "--status", "abandoned", "--validation", `boundary ${boundary}`,
      ], dependencies);
      expect(finished.exitCode, boundary).toBe(0);
      expect(JSON.parse(finished.stdout).result.worktree_removed, boundary).toBe(false);
      expect(await graph.claims.getActive(first.task.task_id), boundary).toBeUndefined();
      const blocked = await runCli([
        "task", "start", "--task", first.task.task_id, "--repo-path", fixture.sourceRepo, "--session", `blocked-${boundary}`,
      ], dependencies);
      expect(JSON.parse(blocked.stderr), boundary).toEqual({ error: { code: "WORKTREE_CLEANUP_REQUIRED" } });
      expect(await graph.claims.getActive(first.task.task_id), boundary).toBeUndefined();
      const recovered = await runCli([
        "task", "recover", "--task", first.task.task_id, "--expect", first.claim.claim_id, "--action", "cleanup",
      ], dependencies);
      expect(recovered.exitCode, boundary).toBe(0);
      const successor = await runCli([
        "task", "start", "--task", first.task.task_id, "--repo-path", fixture.sourceRepo, "--session", `recovered-${boundary}`,
      ], dependencies);
      expect(successor.exitCode, boundary).toBe(0);
    }
  }, 40_000);

  it("25. Project, Handoff, Registry restore, and snapshot injection paths reject before authoritative output", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    await graph.catalog.registerRepository(repositoryInput);
    const secret = "unmistakably-fake-cross-boundary-secret";
    const projectRunner = new GateProjectRunner();
    const project = new GitHubProjectClient({
      githubOwner: "jhw7500", projectNumber: 7, registryRepository: "jhw7500/project-registry",
      preflightProjectItemId: "PVTI_trial", runner: projectRunner, catalog: graph.catalog,
      sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    });
    for (const objective of [
      `contains ${secret}`,
      `contains,${fixture.sourceRepo}/project-objective`,
      `contains,file://localhost${fixture.sourceRepo}/project-objective`,
    ]) {
      await expect(project.registerProject({
        project_id: "prj-injected", title: "Rejected", objective,
        repo_ids: ["repo-control"],
        fields: { status: "proposed", priority: "P2", health: "unknown", next_action: "wait:reject", last_reviewed: "2026-08-13" },
      })).rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    }
    expect(projectRunner.calls).toEqual([]);

    const dependencies = cliDependencies(graph);
    const started = await runCli(temporaryStartArgs("control:handoff-injection", fixture.sourceRepo, "handoff-injection"), dependencies);
    const active = JSON.parse(started.stdout).result;
    const beforeHandoff = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
    const rejectedHandoff = await runCli([
      "task", "finish", "--task", active.task.task_id, "--claim", active.claim.claim_id, "--status", "handoff",
      "--validation", "reject injected path", "--progress", `${fixture.sourceRepo}/progress`,
      "--failures", `${fixture.sourceRepo}/failure`, "--next-step", `${fixture.sourceRepo}/next`,
    ], dependencies);
    expect(JSON.parse(rejectedHandoff.stderr)).toEqual({ error: { code: "SENSITIVE_DATA_REJECTED" } });
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(beforeHandoff);
    expect(await graph.claims.getActive(active.task.task_id)).toMatchObject({ claim_id: active.claim.claim_id });
    expect(await exists(join(fixture.cloneA, "handoffs", active.task.task_id))).toBe(false);

    const taskPath = join(fixture.cloneA, "tasks", `${active.task.task_id}.yaml`);
    const restored = JSON.parse(await readFile(taskPath, "utf8"));
    restored.goal = `${fixture.sourceRepo}/restored-content`;
    await writeFile(taskPath, `${JSON.stringify(restored)}\n`, "utf8");
    await git(fixture.cloneA, "add", "--", `tasks/${active.task.task_id}.yaml`);
    await git(fixture.cloneA, "commit", "-m", "Inject isolated restored record fixture");
    const remoteBeforeRestoreRead = (await git(fixture.root, "ls-remote", fixture.remoteDir, "refs/heads/main")).trim();
    const restorePolicyCatalog = new Catalog(
      graph.config,
      graph.registry,
      createSensitiveDataPolicy({}, [fixture.sourceRepo, fixture.cloneA, fixture.stateDir, fixture.worktreeRoot]),
    );
    await expect(restorePolicyCatalog.getTask(active.task.task_id)).rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect((await git(fixture.root, "ls-remote", fixture.remoteDir, "refs/heads/main")).trim()).toBe(remoteBeforeRestoreRead);

    const snapshotSource = projectSource(1);
    snapshotSource.items[0]!.objective = `${fixture.sourceRepo}/snapshot-source`;
    const snapshots = new PortfolioService({ projectClient: { readAll: async () => snapshotSource }, stateDir: fixture.stateDir });
    await expect(snapshots.exportSnapshot()).rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(await exists(join(fixture.stateDir, "snapshots"))).toBe(false);
  }, 25_000);

  it("26. live preflight rejects a noncanonical Registry remote before any Project mutation", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const delegate = new ProcessRunner();
    const runner = {
      run: delegate.run.bind(delegate),
      async runGh(args: string[], credential: "project" | "repo"): Promise<ProcessResult> {
        return {
          command: "gh", args, stderr: "", exitCode: 0,
          stdout: credential === "project" ? "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n" : "{}\n",
        };
      },
    };
    let projectCalls = 0;
    const project: PreflightProjectPort = {
      verifyFields: async () => { projectCalls += 1; },
      addPreflightItem: async () => { projectCalls += 1; return "PVTI_trial"; },
      verifyItemContentId: async () => { projectCalls += 1; return "I_trial"; },
      readLastReviewed: async () => { projectCalls += 1; return undefined; },
      writeLastReviewed: async () => { projectCalls += 1; },
      clearLastReviewed: async () => { projectCalls += 1; },
    };
    const preflight = new PreflightService({
      config: graph.config,
      environment: { GH_PROJECT_TOKEN: "fake-project-token", GH_REPO_TOKEN: "fake-repository-token" },
      runner,
      project,
      authority: { observeCommittedLegacy: async () => undefined },
      notion: { verifyReadOnlyRoutes: async () => undefined },
      repository: { verifyPrivateRepository: async () => undefined },
      registry: { assertReady: async () => undefined },
    });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REGISTRY_REMOTE_NOT_SSH" });
    expect(projectCalls).toBe(0);
    expect(await git(fixture.cloneA, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }, 15_000);

  it("27. journal gaps preserve Project registration and Task finish success coordinates without duplicate pressure", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const projectLinks = new Map<string, { project_id: string; project_item_id: string; source_node_id: string; issue_number: number }>();
    let projectCreates = 0;
    const failingJournal = { append: async () => { throw new Error("injected measurement outage"); } };
    const projectPort = {
      ...cliDependencies(graph).portfolio,
      async registerProject(input: { project_id: string }) {
        let link = projectLinks.get(input.project_id);
        if (!link) {
          projectCreates += 1;
          link = { project_id: input.project_id, project_item_id: "PVTI_journal", source_node_id: "I_journal", issue_number: 91 };
          projectLinks.set(input.project_id, link);
        }
        return link;
      },
    };
    const journalDependencies = cliDependencies(graph, { journal: failingJournal, portfolio: projectPort });
    const projectArgs = [
      "project", "register", "--project", "prj-journal", "--title", "Journal Project",
      "--objective", "prove authoritative success", "--repo-id", "repo-control", "--status", "proposed",
      "--priority", "P2", "--health", "unknown", "--next-action", "wait:approval", "--last-reviewed", "2026-08-13",
    ];

    const firstProject = await runCli(projectArgs, journalDependencies);
    const retryProject = await runCli(projectArgs, journalDependencies);
    expect(firstProject.exitCode).toBe(0);
    expect(retryProject.exitCode).toBe(0);
    expect(JSON.parse(firstProject.stdout)).toEqual(JSON.parse(retryProject.stdout));
    expect(JSON.parse(firstProject.stdout)).toMatchObject({
      result: { project_id: "prj-journal", project_item_id: "PVTI_journal", source_node_id: "I_journal", issue_number: 91 },
      journal_warning: { code: "JOURNAL_WRITE_FAILED" },
    });
    expect(projectCreates).toBe(1);

    const started = await runCli(
      temporaryStartArgs("control:finish-journal-gap", fixture.sourceRepo, "finish-journal-session"),
      cliDependencies(graph),
    );
    const active = JSON.parse(started.stdout).result;
    const finishArgs = completedFinishArgs(active.task.task_id, active.claim.claim_id);
    const firstFinish = await runCli(finishArgs, journalDependencies);
    expect(firstFinish.exitCode).toBe(0);
    expect(JSON.parse(firstFinish.stdout)).toMatchObject({
      result: { task_id: active.task.task_id, claim_id: active.claim.claim_id, status: "completed" },
      journal_warning: { code: "JOURNAL_WRITE_FAILED" },
    });
    expect(await graph.claims.getActive(active.task.task_id)).toBeUndefined();
    const historyDirectory = join(fixture.cloneA, "claims", "history", "2026", active.task.task_id);
    expect((await readdir(historyDirectory)).filter((name) => name === `${active.claim.claim_id}.yaml`)).toHaveLength(1);
  }, 20_000);

  it("28. verified same-node Repository rename migrates a formal Task and keeps explicit resume usable", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    await graph.catalog.registerRepository(repositoryInput);
    const formal = (await graph.catalog.registerFormalTask(issueInput)).task;
    const secondIssue = {
      ...issueInput,
      issue_node_id: "I_phase1a_second",
      issue_url: "https://github.com/jhw7500/control/issues/2",
      alias: "jhw7500/control#2",
    };
    const releasedBeforeRename = (await graph.catalog.registerFormalTask(secondIssue)).task;
    const initialDependencies = cliDependencies(graph);
    const initialStart = await runCli([
      "task", "start", "--task", formal.id, "--repo-path", fixture.sourceRepo, "--session", "codex-before-repository-rename",
    ], initialDependencies);
    expect(initialStart.exitCode).toBe(0);
    const initialClaimId = JSON.parse(initialStart.stdout).result.claim.claim_id as string;
    const releasedStart = await runCli([
      "task", "start", "--task", releasedBeforeRename.id, "--repo-path", fixture.sourceRepo,
      "--session", "codex-released-before-repository-rename",
    ], initialDependencies);
    expect(releasedStart.exitCode).toBe(0);
    const releasedClaimId = JSON.parse(releasedStart.stdout).result.claim.claim_id as string;
    expect((await runCli([
      "task", "finish", "--task", releasedBeforeRename.id, "--claim", releasedClaimId, "--status", "handoff",
      "--validation", "pre-rename handoff: pass", "--progress", "resume after the repository rename",
    ], initialDependencies)).exitCode).toBe(0);
    const renamedSlug = "jhw7500/control-renamed";
    await git(fixture.sourceRepo, "remote", "add", "origin", `git@github.com:${renamedSlug}.git`);

    const sourceRunner: GitHubSourceRunner = {
      run: graph.runner.run.bind(graph.runner),
      async runGh(args: string[], credential: "project" | "repo"): Promise<ProcessResult> {
        expect(credential).toBe("repo");
        const route = args[1];
        if (route === `repos/${renamedSlug}`) {
          return {
            command: "gh", args, stderr: "", exitCode: 0,
            stdout: `${JSON.stringify({ node_id: repositoryInput.github_node_id, full_name: renamedSlug, private: true })}\n`,
          };
        }
        if (route === `repos/${renamedSlug}/issues/1`) {
          return {
            command: "gh", args, stderr: "", exitCode: 0,
            stdout: `${JSON.stringify({
              node_id: issueInput.issue_node_id,
              number: 1,
              html_url: `https://github.com/${renamedSlug}/issues/1`,
              updated_at: issueInput.issue_revision,
              state: "open",
            })}\n`,
          };
        }
        if (route === `repos/${renamedSlug}/issues/2`) {
          return {
            command: "gh", args, stderr: "", exitCode: 0,
            stdout: `${JSON.stringify({
              node_id: secondIssue.issue_node_id,
              number: 2,
              html_url: `https://github.com/${renamedSlug}/issues/2`,
              updated_at: secondIssue.issue_revision,
              state: "open",
            })}\n`,
          };
        }
        throw new Error(`Unexpected fake GitHub route: ${route ?? "missing"}`);
      },
    };
    const source = new GitHubSourceService({
      runner: sourceRunner,
      catalog: graph.catalog,
      projects: { requireProjectRepository: async () => undefined },
    });

    await expect(source.registerRepository({
      repo_id: repositoryInput.repo_id,
      slug: renamedSlug,
      repository_path: fixture.sourceRepo,
    })).resolves.toMatchObject({
      repository: { id: repositoryInput.repo_id, github_node_id: repositoryInput.github_node_id, slug: renamedSlug },
      created: false,
    });
    await expect(graph.catalog.getTask(formal.id)).resolves.toMatchObject({
      id: formal.id,
      issue_node_id: issueInput.issue_node_id,
      issue_url: `https://github.com/${renamedSlug}/issues/1`,
      aliases: [`${renamedSlug}#1`, issueInput.alias],
    });
    await expect(graph.catalog.getTask(releasedBeforeRename.id)).resolves.toMatchObject({
      id: releasedBeforeRename.id,
      issue_node_id: secondIssue.issue_node_id,
      issue_url: `https://github.com/${renamedSlug}/issues/2`,
      aliases: [`${renamedSlug}#2`, secondIssue.alias],
    });

    const renamedDependencies = cliDependencies(graph, { source });
    expect((await runCli([
      "task", "status", "--task", formal.id, "--claim", initialClaimId,
    ], renamedDependencies)).exitCode).toBe(0);
    expect((await runCli([
      "task", "recover", "--task", formal.id, "--expect", initialClaimId, "--action", "status",
    ], renamedDependencies)).exitCode).toBe(0);
    expect((await runCli([
      "task", "finish", "--task", formal.id, "--claim", initialClaimId, "--status", "handoff",
      "--validation", "rename lifecycle: pass", "--progress", "resume after verified rename",
    ], renamedDependencies)).exitCode).toBe(0);

    const resumed = await runCli([
      "task", "start", "--task", formal.id, "--repo-path", fixture.sourceRepo, "--session", "codex-after-repository-rename",
    ], renamedDependencies);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout).result).toMatchObject({
      task: { task_id: formal.id },
      claim: { task_id: formal.id },
    });
    await expect(graph.claims.getActive(formal.id)).resolves.toMatchObject({
      task_id: formal.id,
      task_alias: issueInput.alias,
    });
    const resumedReleased = await runCli([
      "task", "start", "--task", releasedBeforeRename.id, "--repo-path", fixture.sourceRepo,
      "--session", "codex-after-pre-rename-handoff",
    ], renamedDependencies);
    expect(resumedReleased.exitCode).toBe(0);
    await expect(graph.claims.getActive(releasedBeforeRename.id)).resolves.toMatchObject({
      task_id: releasedBeforeRename.id,
      task_alias: secondIssue.alias,
    });
  }, 30_000);
});
