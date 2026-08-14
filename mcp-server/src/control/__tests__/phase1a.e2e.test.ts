import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAuthorityService } from "../authority.js";
import { Catalog } from "../catalog.js";
import { ClaimService, type ClaimInspection } from "../claim-service.js";
import { runCli, type CliDependencies } from "../cli.js";
import type { ControlConfig } from "../config.js";
import { ControlError } from "../errors.js";
import { PilotJournal } from "../journal.js";
import { MutationLock, ProcessRunner, type ProcessResult, type ProcessRunOptions } from "../process.js";
import { PortfolioService, type ProjectSnapshotSource } from "../portfolio.js";
import { PreflightService, type PreflightProjectPort } from "../preflight.js";
import { RegistryGit, type ProcessRunnerLike } from "../registry-git.js";
import { sourceIndexKey } from "../ids.js";
import { TaskService } from "../task-service.js";
import { WorktreeManager, type WorktreeStateHooks } from "../worktree.js";
import { configFor, git, makeRegistryFixture } from "./helpers.js";

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
  const registry = new RegistryGit(config, runner);
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
  return {
    stateDir: graph.config.stateDir,
    env: {},
    taskService: graph.tasks,
    claimService: graph.claims,
    catalog: graph.catalog,
    portfolio: {
      status: async () => ({ page_id: "page-1", markdown: "# Portfolio\n", items: [], truncated: false, total_items: 0 }),
      exportSnapshot: async () => ({
        jsonPath: "2026-08-13T00-00-00.000Z/portfolio.json",
        markdownPath: "2026-08-13T00-00-00.000Z/portfolio.md",
        checksum: "a".repeat(64),
      }),
      registerProject: async (input) => ({ project_id: input.project_id, project_item_id: "PVTI_control", source_node_id: "I_control", issue_number: 1 }),
    },
    preflight: { run: async () => ({ status: "ready", checks: { credentials: "ok", project: "ok", registry_issue: "ok", registry_git: "ok" } }) },
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
const serialized = JSON.stringify(capture);
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

describe("Phase 1A deterministic adversarial gate", () => {
  it("1. concurrent Repository registration leaves one canonical record and one source mapping", async () => {
    const fixture = await makeGateFixture();
    const leftRunner = new PushGateRunner(new ProcessRunner(), "2026-08-13T00:00:01Z");
    const rightRunner = new PushGateRunner(new ProcessRunner(), "2026-08-13T00:00:02Z");
    const leftConfig = fixtureConfig(fixture, fixture.cloneA);
    const rightConfig = fixtureConfig(fixture, fixture.cloneB);
    const left = new Catalog(leftConfig, new RegistryGit(leftConfig, leftRunner));
    const right = new Catalog(rightConfig, new RegistryGit(rightConfig, rightRunner));

    const results = await runDeterministicPushRace(
      () => left.registerRepository(repositoryInput),
      () => right.registerRepository(repositoryInput),
      leftRunner,
      rightRunner,
    );

    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "REMOTE_DIVERGED" } });
    const audit = await freshAuditClone(fixture, "audit-repository");
    expect(JSON.parse(await readFile(join(audit, "repositories", "repo-control.yaml"), "utf8"))).toEqual({
      id: "repo-control", github_node_id: "R_phase1a", slug: "jhw7500/control",
    });
    const sourcePath = join(audit, "repositories", "by-source", "github", `${sourceIndexKey(repositoryInput.github_node_id)}.yaml`);
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual({ repo_id: "repo-control" });
  });

  it("2. concurrent Issue registration leaves one generated Task and one source mapping", async () => {
    const fixture = await makeGateFixture();
    const leftRunner = new PushGateRunner(new ProcessRunner(), "2026-08-13T00:00:01Z");
    const rightRunner = new PushGateRunner(new ProcessRunner(), "2026-08-13T00:00:02Z");
    const leftConfig = fixtureConfig(fixture, fixture.cloneA);
    const rightConfig = fixtureConfig(fixture, fixture.cloneB);
    const left = new Catalog(leftConfig, new RegistryGit(leftConfig, leftRunner));
    const right = new Catalog(rightConfig, new RegistryGit(rightConfig, rightRunner));

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
    expect(taskFiles.map((entry) => entry.name)).toEqual([`${source.task_id}.yaml`]);
    expect(JSON.parse(await readFile(join(audit, "tasks", `${source.task_id}.yaml`), "utf8"))).toMatchObject({ id: source.task_id, issue_node_id: issueInput.issue_node_id });
  });

  it("3. promotion collision changes neither Task nor Registry HEAD", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
    const temporary = await graph.catalog.registerTemporaryTask({
      project_id: "prj-control", repo_id: "repo-control", alias: "control:temporary", goal: "temporary",
      done_conditions: ["test"], expected_scope: ["src/control"],
    });
    const formal = (await graph.catalog.registerFormalTask(issueInput)).task;
    const head = (await git(fixture.cloneA, "rev-parse", "HEAD")).trim();
    const temporaryBytes = await readFile(join(fixture.cloneA, "tasks", `${temporary.id}.yaml`), "utf8");
    const formalBytes = await readFile(join(fixture.cloneA, "tasks", `${formal.id}.yaml`), "utf8");

    await expect(graph.catalog.promoteTemporaryTask(temporary.id, issueInput)).rejects.toMatchObject({ code: "SOURCE_ALREADY_MAPPED" });
    expect((await git(fixture.cloneA, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await readFile(join(fixture.cloneA, "tasks", `${temporary.id}.yaml`), "utf8")).toBe(temporaryBytes);
    expect(await readFile(join(fixture.cloneA, "tasks", `${formal.id}.yaml`), "utf8")).toBe(formalBytes);
  });

  it("4. two same-host Task starts under one retained lock leave one active Claim", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
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
    };
    const config = fixtureConfig(fixture, fixture.cloneA);
    const registry = new RegistryGit(config, runner);

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
    };
    const racingRegistry = new RegistryGit(fixtureConfig(racingFixture, racingFixture.cloneA), racingRunner);
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

    const finished = await runCli(completedFinishArgs(taskId, newClaimId), dependencies);
    expect(finished.exitCode).toBe(0);
    const oldHistory = JSON.parse(await readFile(join(fixture.cloneA, "claims", "history", "2026", taskId, `${oldClaim.claim_id}.yaml`), "utf8"));
    const middleHistory = JSON.parse(await readFile(join(fixture.cloneA, "claims", "history", "2026", taskId, `${firstSuccessorId}.yaml`), "utf8"));
    const newHistory = JSON.parse(await readFile(join(fixture.cloneA, "claims", "history", "2026", taskId, `${newClaimId}.yaml`), "utf8"));
    expect(oldHistory).toMatchObject({ status: "taken-over", successor_claim_id: firstSuccessorId });
    expect(middleHistory).toMatchObject({ status: "taken-over", successor_claim_id: newClaimId });
    expect(newHistory).toMatchObject({ status: "completed" });
    expect(await graph.claims.getActive(taskId)).toBeUndefined();
    expect(await exists(join(fixture.cloneA, "tasks", `${taskId}.yaml`))).toBe(true);
    expect(JSON.parse(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8")).worktrees[oldClaim.worktree_ref]).toMatchObject({
      claim_id: newClaimId, lifecycle: "removed",
    });
  });

  it("9. offline provisional work is unclaimed and cannot assert ownership", async () => {
    const fixture = await makeGateFixture();
    const graph = graphFor(fixture, fixture.cloneA);
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
      "--source-task-revision", "temporary-v1", "--validation", "checkpoint: pass", "--progress", "gate progress",
      "--active-work-minutes", "1",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    const pointer = `handoffs/${taskId}/${claim.claim_id}.md`;
    const mapping = JSON.parse(await readFile(join(fixture.stateDir, "worktrees.json"), "utf8")).worktrees[claim.worktree_ref];
    expect(await exists(join(fixture.cloneA, "tasks", `${taskId}.yaml`))).toBe(true);
    expect(await readFile(join(fixture.cloneA, pointer), "utf8")).toContain(`# Handoff: ${taskId}`);
    expect(await readFile(join(mapping.path, ".ai", "handoff.md"), "utf8")).toContain(`# Handoff: ${taskId}`);
    expect(await exists(mapping.path)).toBe(true);
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
    await writeFile(join(queueDir, "0000.json"), `${JSON.stringify({
      expect: { operation: "rest:GET:repos/jhw7500/control/issues/1", keys: [] },
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
      stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project, repo\r\n\r\n{}\n",
      stderr: "",
      exitCode: 0,
    })}\n`, { mode: 0o600 });
    const projectToken = "phase1a-project-token-value";
    const repoToken = "phase1a-repo-token-value";
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
    const preflight = new PreflightService({ config: graph.config, environment, runner, project });
    const dependencies = cliDependencies(graph, {
      env: environment,
      preflight,
      mutationLock: { run: async (callback) => callback() },
      journal: new PilotJournal(graph.config.stateDir),
    });

    const caughtMetadata: unknown[] = [];
    const result = await runCli(["preflight"], dependencies).catch((cause: unknown) => {
      caughtMetadata.push(cause);
      throw cause;
    });

    expect(result).toMatchObject({ exitCode: 78 });
    const errorMetadata = JSON.parse(result.stderr);
    expect(errorMetadata).toEqual({ error: { code: "PROJECT_TOKEN_HAS_REPO_SCOPE" } });
    expect((await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { operation: "rest:GET:repos/jhw7500/control/issues/1", keys: [] },
      { operation: "rest:GET:/user", keys: [] },
    ]);
    const queuedArtifacts = await readdir(queueDir);
    expect(queuedArtifacts.filter((name) => /^\d{4}\.json$/.test(name))).toEqual([]);
    expect(queuedArtifacts.filter((name) => /^000[01]\.json\.claimed-\d+$/.test(name))).toHaveLength(2);
    const journal = await readFile(join(fixture.stateDir, "pilot-journal.jsonl"), "utf8");
    expect(JSON.parse(journal)).toMatchObject({ command: "preflight", ok: false, error_code: "PROJECT_TOKEN_HAS_REPO_SCOPE" });
    const artifacts = [
      result.stdout,
      result.stderr,
      JSON.stringify(errorMetadata),
      JSON.stringify(caughtMetadata),
      ...await textArtifacts(fixture.root),
    ];
    for (const token of [projectToken, repoToken]) expect(artifacts.join("\n")).not.toContain(token);
  });
});
