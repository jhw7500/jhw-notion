import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createCliDependencies, controlErrorResult, requiresMutationLock, runCli, type CliDependencies } from "../cli.js";
import type { ContractAuthorityPort } from "../contract-authority.js";
import { ControlError } from "../errors.js";
import { GuardDigestKey, GuardRequestStore, type GuardRequestInspection } from "../guard-state.js";
import { PortfolioService, type ProjectSnapshotSource } from "../portfolio.js";
import { MutationLock, type MutationLockRuntime } from "../process.js";
import { loadControlConfig, type ControlConfig } from "../config.js";
import type { ContractActiveClaim, GuardRequest, GuardRequestLifecycle } from "../schemas.js";
import { workContractDigest } from "../work-contract.js";

const TASK_ID = "tsk-0198e748-3a00-7000-8000-000000000001";
const CLAIM_ID = "clm-0198e748-3a00-7000-8000-000000000002";
const CHILD_TASK_ID = "tsk-0198e748-3a00-7000-8000-000000000003";
const PROJECT_ID = "prj-control";
const REPO_ID = "repo-control";

function lockConfig(stateDir: string): ControlConfig {
  return {
    registryDir: "/srv/registry",
    registryRemote: "origin",
    registryBranch: "main",
    worktreeRoot: "/srv/worktrees",
    buildHost: "build-host",
    githubOwner: "owner",
    projectNumber: 1,
    registryRepository: "owner/registry",
    preflightProjectItemId: "PVTI_trial",
    preflightRegistryIssueNumber: 1,
    stateDir,
    guardMode: "enforce",
  };
}

function immediateContentionRuntime(): MutationLockRuntime {
  return {
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end();
        child.emit("close", 75);
      });
      return child;
    },
  };
}

const activeClaim = {
  task_id: TASK_ID,
  task_alias: "control-task",
  project_id: PROJECT_ID,
  repo_id: REPO_ID,
  claim_id: CLAIM_ID,
  session_id: "codex-123",
  host: "build-host",
  branch: "task/000000000001-control-task",
  worktree_ref: "wt-000000000001-control-task",
  source_task_revision: "2026-08-13T00:00:00Z",
  started_at: "2026-08-13T00:00:00.000Z",
};

const started = {
  claim: activeClaim,
  branch: activeClaim.branch,
  worktree_ref: activeClaim.worktree_ref,
  reused: false,
};

function formalTask() {
  return {
    id: TASK_ID,
    kind: "formal" as const,
    project_id: PROJECT_ID,
    repo_id: REPO_ID,
    aliases: ["I_control"],
    issue_node_id: "I_control",
    issue_revision: "2026-08-13T00:00:00Z",
    issue_url: "https://github.com/example/control/issues/1",
  };
}

function temporaryTask() {
  return {
    id: TASK_ID,
    kind: "temporary" as const,
    project_id: PROJECT_ID,
    repo_id: REPO_ID,
    aliases: ["control-temp"],
    goal: "do not echo this goal",
    done_conditions: ["targeted test passes"],
    expected_scope: ["src/control"],
    lifecycle: "active",
  };
}

function childTask() {
  return {
    id: CHILD_TASK_ID,
    kind: "child" as const,
    parent_task_id: TASK_ID,
    required_for_parent: true,
    project_id: PROJECT_ID,
    repo_id: REPO_ID,
    aliases: ["local-hardening"],
    goal: "Harden local package changes",
    done_conditions: ["host tests pass"],
    lifecycle: "active" as const,
    work_contract: {
      version: 1 as const,
      task_id: CHILD_TASK_ID,
      grants: [{
        capability: "repo.modify" as const,
        resource: { kind: "repository" as const, id: REPO_ID },
        coordination: "shared" as const,
      }],
      dependencies: [],
    },
  };
}

type Overrides = {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  taskService?: Record<string, unknown>;
  source?: Record<string, unknown>;
  catalog?: Record<string, unknown>;
  portfolio?: Record<string, unknown>;
  preflight?: Record<string, unknown>;
  // vitest erases the generic on `run`, so a behaviourally correct fake cannot
  // satisfy MutationLockPort structurally. Accept either and bridge once below.
  mutationLock?: CliDependencies['mutationLock'] | { run: ReturnType<typeof vi.fn> };
  journal?: { append: ReturnType<typeof vi.fn> };
  boardJournal?: { append: ReturnType<typeof vi.fn> };
  guardMode?: "enforce" | "observe";
  guardRequests?: Pick<GuardRequestStore, "inspect">;
  guardDigestKey?: Pick<GuardDigestKey, "inspect">;
  guardClaims?: Record<string, unknown>;
  registrationRecordWarning?: CliDependencies["registrationRecordWarning"];
};

function makeCliDependencies(overrides: Overrides = {}): CliDependencies {
  const taskService = {
    start: vi.fn().mockResolvedValue(started),
    status: vi.fn().mockResolvedValue({
      active: activeClaim,
      worktree: {
        branch: activeClaim.branch,
        worktree_ref: activeClaim.worktree_ref,
        head_sha: "0123456789abcdef",
        dirty: false,
        dirty_files: [],
        ahead: 0,
        behind: 0,
      },
    }),
    finish: vi.fn().mockResolvedValue({
      history: { ...activeClaim, status: "completed", released_at: "2026-08-13T00:01:00.000Z" },
      worktree_removed: true,
    }),
    handoff: vi.fn().mockResolvedValue({
      handoff_pointer: `handoffs/${TASK_ID}/${CLAIM_ID}.md`,
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      source_task_revision: "2026-08-13T00:00:00Z",
      generated_at: "2026-08-13T00:01:00Z",
      sections: { "Progress Since Last Checkpoint": "bounded" },
    }),
    recover: vi.fn().mockResolvedValue({ kind: "status", active: activeClaim, process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 }),
    assertOwner: vi.fn().mockResolvedValue(activeClaim),
    markCompletionReady: vi.fn().mockResolvedValue({
      version: 1,
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      work_contract_digest: "a".repeat(64),
      recorded_at: "2026-08-13T00:01:00.000Z",
      evidence: { integration_validation: ["integration passes"], child_dispositions: [] },
    }),
    ...overrides.taskService,
  };
  const claimService = {
    getActive: vi.fn().mockResolvedValue(activeClaim),
  };
  const catalog = {
    registerFormalTask: vi.fn().mockResolvedValue({ task: formalTask(), created: true }),
    registerTemporaryTask: vi.fn().mockResolvedValue(temporaryTask()),
    registerChildTask: vi.fn().mockResolvedValue(childTask()),
    configureInactiveTask: vi.fn(async (input) => ({ ...formalTask(), task_role: input.task_role, work_contract: input.work_contract })),
    ...overrides.catalog,
  };
  const source = {
    registerRepository: vi.fn().mockResolvedValue({ repository: { id: REPO_ID, github_node_id: "R_control", slug: "example/control" }, created: true }),
    registerFormalTask: vi.fn().mockResolvedValue({ task: formalTask(), created: true }),
    registerTemporaryTask: vi.fn().mockResolvedValue(temporaryTask()),
    prepareExistingTask: vi.fn().mockResolvedValue({ task: formalTask(), alias: "example/control#1", source_task_revision: "2026-08-13T00:00:00Z" }),
    promoteTemporaryTask: vi.fn().mockResolvedValue(formalTask()),
    ...overrides.source,
  };
  const portfolio = {
    status: vi.fn().mockResolvedValue({
      page_id: "page-1",
      markdown: "# Portfolio\n",
      items: [],
      repositories: [],
      truncated: false,
      total_items: 0,
    }),
    exportSnapshot: vi.fn().mockResolvedValue({
      jsonPath: "2026-08-13T00-00-00.000Z/portfolio.json",
      markdownPath: "2026-08-13T00-00-00.000Z/portfolio.md",
      checksum: "a".repeat(64),
    }),
    registerProject: vi.fn(async (input: { project_id: string }) => ({
      project_id: input.project_id,
      project_item_id: "PVTI_control",
      source_node_id: "DI_control",
    })),
    updateProject: vi.fn(async (input: { project_id: string }) => ({
      project_id: input.project_id,
      project_item_id: "PVTI_control",
      source_node_id: "DI_control",
      fields: updatedFields(),
    })),
    ...overrides.portfolio,
  };
  const preflight = {
    run: vi.fn().mockResolvedValue({
      status: "ready",
      checks: {
        credentials: "ok", authority: "ok", notion_guard: "ok", project: "ok",
        registry_repository: "ok", registry_issue: "ok", registry_git: "ok",
      },
    }),
    ...overrides.preflight,
  };
  const mutationLock = (overrides.mutationLock ?? {
    run: vi.fn(async <T>(callback: () => Promise<T>) => callback()),
  }) as CliDependencies['mutationLock'];
  const guardClaims = {
    withCommittedView: async <T>(read: () => Promise<T>) => read(),
    listActiveClaims: vi.fn().mockResolvedValue([]),
    ...overrides.guardClaims,
  };

  return {
    stateDir: overrides.stateDir ?? join(tmpdir(), "jhw-control-cli-state"),
    env: overrides.env ?? {},
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    taskService,
    claimService,
    catalog,
    source,
    portfolio,
    preflight,
    mutationLock,
    guardMode: overrides.guardMode ?? "enforce",
    guardRequests: overrides.guardRequests ?? { inspect: vi.fn().mockResolvedValue({ status: "ready", requests: [] }) },
    guardDigestKey: overrides.guardDigestKey ?? { inspect: vi.fn().mockResolvedValue({ status: "ready" }) },
    guardClaims,
    ...(overrides.journal ? { journal: overrides.journal } : {}),
    boardJournal: overrides.boardJournal ?? { append: vi.fn().mockResolvedValue(undefined) },
    ...(overrides.registrationRecordWarning ? { registrationRecordWarning: overrides.registrationRecordWarning } : {}),
  } as unknown as CliDependencies;
}

function controlEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: "/fixture/home",
    JHW_REGISTRY_DIR: "/fixture/registry",
    JHW_WORKTREE_ROOT: "/fixture/worktrees",
    JHW_BUILD_HOST: "fixture-host",
    JHW_GITHUB_OWNER: "fixture-owner",
    JHW_PROJECT_NUMBER: "7",
    JHW_REGISTRY_REPOSITORY: "fixture-owner/registry",
    JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
    JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
    ...overrides,
  };
}

const requestContract = {
  version: 1 as const,
  task_id: TASK_ID,
  grants: [{
    capability: "repo.modify" as const,
    resource: { kind: "repository" as const, id: REPO_ID },
    coordination: "shared" as const,
  }],
  dependencies: [],
};

function contractClaim(
  sessionId: string,
  sequence = 1,
): ContractActiveClaim {
  const taskId = `tsk-0198e748-3a00-7000-8000-${String(sequence).padStart(12, "0")}`;
  const claimId = `clm-0198e748-3a00-7000-8000-${String(sequence).padStart(12, "0")}`;
  const workContract = { ...requestContract, task_id: taskId };
  return {
    task_id: taskId,
    task_alias: `guard-task-${sequence}`,
    project_id: PROJECT_ID,
    repo_id: REPO_ID,
    claim_id: claimId,
    origin_adapter: sequence % 2 === 0 ? "gemini" : "codex",
    session_id: sessionId,
    host: `guard-host-${sequence}`,
    branch: `task/${sequence}-guard-task`,
    worktree_ref: `wt-${sequence}-guard-task`,
    source_task_revision: "2026-08-13T00:00:00Z",
    started_at: "2026-08-13T00:00:00.000Z",
    work_contract: workContract,
    work_contract_digest: workContractDigest(workContract),
  };
}

function guardRequest(state: GuardRequestLifecycle, sequence: number): GuardRequest {
  const requestedAt = "2026-08-13T00:00:00.000Z";
  const approvalExpiresAt = "2026-08-13T00:10:00.000Z";
  const approvedAt = "2026-08-13T00:01:00.000Z";
  const startBy = "2026-08-13T00:11:00.000Z";
  const consumedAt = "2026-08-13T00:02:00.000Z";
  const base = {
    request_id: `req-0198e748-3a00-7000-8000-${String(sequence).padStart(12, "0")}`,
    state,
    origin_adapter: "codex" as const,
    session_id: `guard-session-${sequence}`,
    task_id: TASK_ID,
    claim_id: CLAIM_ID,
    cwd_worktree_ref: `wt-guard-${sequence}`,
    requirements: [{
      capability: "repo.modify" as const,
      resource: { kind: "repository" as const, id: REPO_ID },
    }],
    operation_digest: sequence.toString(16).padStart(64, "0"),
    summary: `bounded operation ${sequence}`,
    requested_at: requestedAt,
    approval_expires_at: approvalExpiresAt,
  };
  if (state === "PENDING") return base;
  if (state === "EXPIRED") return { ...base, finished_at: approvalExpiresAt };
  const approved = { ...base, approved_at: approvedAt, start_by: startBy };
  if (state === "APPROVED") return approved;
  const consumed = { ...approved, consumed_at: consumedAt, correlation_id: `tool-use-${sequence}` };
  if (state === "CONSUMED") return consumed;
  return { ...consumed, finished_at: "2026-08-13T00:03:00.000Z" };
}

function formalStartArgs(): string[] {
  return [
    "task", "start",
    "--project", PROJECT_ID,
    "--repo-id", REPO_ID,
    "--repo-path", "/private/source/control",
    "--issue-node-id", "I_control",
    "--issue-url", "https://github.com/example/control/issues/1",
    "--issue-revision", "2026-08-13T00:00:00Z",
    "--grant", `repo.modify:repository:${REPO_ID}:shared`,
    "--origin-adapter", "codex",
    "--session", "codex-123",
  ];
}

function resolvedFormalStartArgs(): string[] {
  return [
    "task", "start",
    "--resolve-from-checkout", "true",
    "--repo-path", "/private/source/control",
    "--issue-url", "https://github.com/example/control/issues/1",
    "--origin-adapter", "codex",
    "--session", "codex-resolved",
  ];
}

function resolvedTemporaryStartArgs(): string[] {
  return [
    "task", "start",
    "--resolve-from-checkout", "true",
    "--repo-path", "/private/source/control",
    "--temp-alias", "resolved-temp",
    "--goal", "complete the resolved task",
    "--done", "targeted test passes",
    "--scope", "src/control",
    "--origin-adapter", "codex",
    "--session", "codex-resolved",
  ];
}

function childStartArgs(): string[] {
  return [
    "task", "child-start",
    "--parent", TASK_ID,
    "--alias", "local-hardening",
    "--repo-path", "/srv/src/wlan-package",
    "--goal", "Harden local package changes",
    "--done", "host tests pass",
    "--required-for-parent", "true",
    "--grant", `repo.modify:repository:${REPO_ID}:shared`,
    "--origin-adapter", "codex",
    "--session", "codex-local-hardening",
  ];
}

function registerArgs(): string[] {
  return [
    "project", "register",
    "--project", PROJECT_ID,
    "--title", "Control Trial",
    "--objective", "Prove the control flow",
    "--repo-id", REPO_ID,
    "--status", "proposed",
    "--priority", "P2",
    "--health", "unknown",
    "--next-action", "wait:select-first-task",
    "--last-reviewed", "2026-08-13",
  ];
}

function updatedFields() {
  return {
    status: "active" as const,
    priority: "P2" as const,
    health: "unknown" as const,
    next_action: `task:${TASK_ID}`,
    last_reviewed: "2026-08-13",
  };
}

function updateArgs(): string[] {
  return ["project", "update", "--project", PROJECT_ID, "--status", "active", "--next-action", `task:${TASK_ID}`];
}

function nearCliLimitPortfolioSource(): ProjectSnapshotSource {
  const items = Array.from({ length: 23 }, (_, index) => ({
    project_item_id: `PVTI_${index + 1}`,
    source_node_id: `I_${index + 1}`,
    project_id: `prj-project-${index + 1}`,
    title: `Project ${index + 1}`,
    objective: "x".repeat(487),
    repo_ids: [REPO_ID],
    fields: {
      status: "active" as const,
      priority: "P2" as const,
      health: "on-track" as const,
      next_action: "wait:fixture",
      last_reviewed: "2026-08-13",
    },
    stale: false,
  }));
  return {
    project_node_id: "PVT_project",
    source_revision: "2026-08-13T00:00:00Z",
    field_definitions: [
      { id: "PVTF_status", name: "Status", data_type: "SINGLE_SELECT", options: [{ id: "status-active", name: "active" }] },
      { id: "PVTF_priority", name: "Priority", data_type: "SINGLE_SELECT", options: [{ id: "priority-P2", name: "P2" }] },
      { id: "PVTF_health", name: "Health", data_type: "SINGLE_SELECT", options: [{ id: "health-on-track", name: "on-track" }] },
      { id: "PVTF_next", name: "Next Action", data_type: "TEXT" },
      { id: "PVTF_reviewed", name: "Last Reviewed", data_type: "DATE" },
    ],
    items,
    total_count: items.length,
  };
}

describe("Guard runtime configuration", () => {
  it.each([
    ["missing", {}],
    ["empty", { JHW_GUARD_MODE: "" }],
    ["enforce", { JHW_GUARD_MODE: "enforce" }],
  ])("defaults or accepts exact enforce mode for %s input", (_name, overrides) => {
    expect(loadControlConfig(controlEnv(overrides)).guardMode).toBe("enforce");
  });

  it.each(["invalid", " enforce ", "OBSERVE", "true"])('rejects non-canonical mode %j', (guardMode) => {
    expect(() => loadControlConfig(controlEnv({ JHW_GUARD_MODE: guardMode })))
      .toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it.each([undefined, "", "TRUE", "true "])(
    "rejects observe without exact opt-in %j",
    (allowObserve) => {
      const env = controlEnv({ JHW_GUARD_MODE: "observe" });
      if (allowObserve !== undefined) env.JHW_GUARD_ALLOW_OBSERVE = allowObserve;
      expect(() => loadControlConfig(env)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    },
  );

  it("accepts observe only with exact development opt-in", () => {
    expect(loadControlConfig(controlEnv({
      JHW_GUARD_MODE: "observe",
      JHW_GUARD_ALLOW_OBSERVE: "true",
    })).guardMode).toBe("observe");
  });
});

describe("runCli", () => {
  it("registers a Repository through verified source authority under the mutation lock", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "repository", "register", "--repo-id", REPO_ID, "--slug", "example/control", "--repo-path", "/srv/source/control",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.source.registerRepository).toHaveBeenCalledWith({
      repo_id: REPO_ID, slug: "example/control", repository_path: "/srv/source/control",
    });
    expect(dependencies.mutationLock.run).toHaveBeenCalledTimes(1);
    expect(result.stdout).not.toContain("/srv/source/control");
  });

  it("accepts the public opt-in only as the exact literal true", async () => {
    const dependencies = makeCliDependencies();
    const accepted = await runCli([
      "repository", "register", "--repo-id", REPO_ID, "--slug", "example/control",
      "--repo-path", "/srv/source/control", "--allow-public", "true",
    ], dependencies);
    expect(accepted.exitCode).toBe(0);
    expect(dependencies.source.registerRepository).toHaveBeenCalledWith({
      repo_id: REPO_ID, slug: "example/control", repository_path: "/srv/source/control", allow_public: true,
    });

    const rejected = await runCli([
      "repository", "register", "--repo-id", REPO_ID, "--slug", "example/control",
      "--repo-path", "/srv/source/control", "--allow-public", "yes",
    ], makeCliDependencies());
    expect(rejected.exitCode).toBe(2);
  });

  it("exposes the persisted public opt-in state in the registration result", async () => {
    const dependencies = makeCliDependencies();
    vi.mocked(dependencies.source.registerRepository).mockResolvedValueOnce({
      repository: { id: REPO_ID, github_node_id: "R_control", slug: "example/control", allow_public: true },
      created: true,
    });
    const optIn = await runCli([
      "repository", "register", "--repo-id", REPO_ID, "--slug", "example/control",
      "--repo-path", "/srv/source/control", "--allow-public", "true",
    ], dependencies);
    expect(optIn.exitCode).toBe(0);
    expect(JSON.parse(optIn.stdout).result).toMatchObject({ allow_public: true });

    const revoked = await runCli([
      "repository", "register", "--repo-id", REPO_ID, "--slug", "example/control",
      "--repo-path", "/srv/source/control",
    ], dependencies);
    expect(revoked.exitCode).toBe(0);
    expect(JSON.parse(revoked.stdout).result).toMatchObject({ allow_public: false });
  });

  it("resumes an existing immutable Task only after source context validation", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "task", "start", "--task", TASK_ID, "--repo-path", "/srv/source/control", "--session", "codex-resume", "--origin-adapter", "codex",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.source.prepareExistingTask).toHaveBeenCalledWith({
      task_id: TASK_ID, repository_path: "/srv/source/control",
    });
    expect(dependencies.taskService.start).toHaveBeenCalledWith(expect.objectContaining({
      task_id: TASK_ID, task_alias: "example/control#1", session_id: "codex-resume",
    }));
    expect(dependencies.source.registerFormalTask).not.toHaveBeenCalled();
    expect(dependencies.source.registerTemporaryTask).not.toHaveBeenCalled();
  });

  it("starts a checkout-resolved Formal Task with the canonical Task coordinates", async () => {
    const canonicalTask = { ...formalTask(), project_id: "prj-resolved", repo_id: "repo-resolved" };
    const dependencies = makeCliDependencies({
      source: { registerFormalTask: vi.fn().mockResolvedValue({ task: canonicalTask, created: true }) },
    });

    const result = await runCli(resolvedFormalStartArgs(), dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.source.registerFormalTask).toHaveBeenCalledWith({
      resolve_from_checkout: true,
      repository_path: "/private/source/control",
      issue_url: "https://github.com/example/control/issues/1",
      task_role: "standalone",
    });
    expect(dependencies.taskService.start).toHaveBeenCalledWith(expect.objectContaining({
      task_id: TASK_ID,
      project_id: "prj-resolved",
      repo_id: "repo-resolved",
      session_id: "codex-resolved",
    }));
    expect(dependencies.mutationLock.run).toHaveBeenCalledTimes(1);
  });

  it("starts a checkout-resolved Temporary Task with the canonical Task coordinates", async () => {
    const canonicalTask = { ...temporaryTask(), project_id: "prj-resolved", repo_id: "repo-resolved" };
    const dependencies = makeCliDependencies({
      source: { registerTemporaryTask: vi.fn().mockResolvedValue(canonicalTask) },
    });

    const result = await runCli(resolvedTemporaryStartArgs(), dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.source.registerTemporaryTask).toHaveBeenCalledWith({
      resolve_from_checkout: true,
      repository_path: "/private/source/control",
      alias: "resolved-temp",
      goal: "complete the resolved task",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/control"],
    });
    expect(dependencies.taskService.start).toHaveBeenCalledWith(expect.objectContaining({
      task_id: TASK_ID,
      project_id: "prj-resolved",
      repo_id: "repo-resolved",
      session_id: "codex-resolved",
    }));
    expect(dependencies.mutationLock.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Formal", "--grant", "notion.mutate:notion_database:knowledgeBase:shared", resolvedFormalStartArgs],
    ["Formal", "--depends", `observes:${CHILD_TASK_ID}`, resolvedFormalStartArgs],
    ["Temporary", "--grant", "notion.mutate:notion_database:knowledgeBase:shared", resolvedTemporaryStartArgs],
    ["Temporary", "--depends", `observes:${CHILD_TASK_ID}`, resolvedTemporaryStartArgs],
  ] as const)("rejects checkout-resolved %s caller contract flag %s before source or Claim mutation", async (
    _kind,
    flag,
    value,
    args,
  ) => {
    const dependencies = makeCliDependencies();

    const result = await runCli([...args(), flag, value], dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.source.registerFormalTask).not.toHaveBeenCalled();
    expect(dependencies.source.registerTemporaryTask).not.toHaveBeenCalled();
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it.each(["PROJECT_REPOSITORY_NOT_FOUND", "PROJECT_REPOSITORY_AMBIGUOUS"] as const)(
    "projects checkout resolver association failure %s before Claim creation",
    async (code) => {
      const dependencies = makeCliDependencies();
      vi.mocked(dependencies.source.registerFormalTask).mockRejectedValueOnce(new ControlError(code, "safe"));

      const result = await runCli(resolvedFormalStartArgs(), dependencies);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toEqual({ error: { code } });
      expect(dependencies.taskService.start).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["rejects false resolver", ["task", "start", "--resolve-from-checkout", "false", "--repo-path", "/private/source/control", "--issue-url", "https://github.com/example/control/issues/1", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects yes resolver", ["task", "start", "--resolve-from-checkout", "yes", "--repo-path", "/private/source/control", "--issue-url", "https://github.com/example/control/issues/1", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects empty resolver", ["task", "start", "--resolve-from-checkout", "", "--repo-path", "/private/source/control", "--issue-url", "https://github.com/example/control/issues/1", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects resolver plus Project", [...resolvedFormalStartArgs(), "--project", PROJECT_ID]],
    ["rejects resolver plus Repository", [...resolvedFormalStartArgs(), "--repo-id", REPO_ID]],
    ["rejects partial Project coordinates", ["task", "start", "--project", PROJECT_ID, "--repo-path", "/private/source/control", "--issue-url", "https://github.com/example/control/issues/1", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects partial Repository coordinates", ["task", "start", "--repo-id", REPO_ID, "--repo-path", "/private/source/control", "--issue-url", "https://github.com/example/control/issues/1", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects no coordinate mode", ["task", "start", "--repo-path", "/private/source/control", "--issue-url", "https://github.com/example/control/issues/1", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects resolver on resume", ["task", "start", "--task", TASK_ID, "--resolve-from-checkout", "true", "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects issue node registration on resume", ["task", "start", "--task", TASK_ID, "--issue-node-id", "I_control", "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects issue URL registration on resume", ["task", "start", "--task", TASK_ID, "--issue-url", "https://github.com/example/control/issues/1", "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects issue revision registration on resume", ["task", "start", "--task", TASK_ID, "--issue-revision", "2026-08-13T00:00:00Z", "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects Temporary alias registration on resume", ["task", "start", "--task", TASK_ID, "--temp-alias", "resolved-temp", "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects Temporary goal registration on resume", ["task", "start", "--task", TASK_ID, "--goal", "complete the resolved task", "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects Temporary done registration on resume", ["task", "start", "--task", TASK_ID, "--done", "targeted test passes", "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects Temporary scope registration on resume", ["task", "start", "--task", TASK_ID, "--scope", "src/control", "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects Project coordinates on resume", ["task", "start", "--task", TASK_ID, "--project", PROJECT_ID, "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
    ["rejects Repository coordinates on resume", ["task", "start", "--task", TASK_ID, "--repo-id", REPO_ID, "--repo-path", "/private/source/control", "--session", "codex-invalid", "--origin-adapter", "codex"]],
  ] as const)("%s before source registration or Claim creation", async (_name, argv) => {
    const dependencies = makeCliDependencies();

    const result = await runCli([...argv], dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.source.registerFormalTask).not.toHaveBeenCalled();
    expect(dependencies.source.registerTemporaryTask).not.toHaveBeenCalled();
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it("requires and forwards an exact origin adapter for start, child-start, and takeover", async () => {
    const startDependencies = makeCliDependencies();
    const missing = await runCli([
      "task", "start", "--task", TASK_ID, "--repo-path", "/srv/source/control", "--session", "shared-session",
    ], startDependencies);
    const started = await runCli([
      "task", "start", "--task", TASK_ID, "--repo-path", "/srv/source/control",
      "--session", "shared-session", "--origin-adapter", "codex",
    ], startDependencies);
    const childDependencies = makeCliDependencies();
    const childArgs = childStartArgs();
    childArgs[childArgs.indexOf("--origin-adapter") + 1] = "claude";
    const child = await runCli(childArgs, childDependencies);
    const recoverDependencies = makeCliDependencies();
    const takeover = await runCli([
      "task", "recover", "--task", TASK_ID, "--expect", CLAIM_ID, "--action", "takeover",
      "--session", "shared-session", "--origin-adapter", "gemini",
    ], recoverDependencies);

    expect(missing.exitCode).toBe(2);
    expect(started.exitCode).toBe(0);
    expect(startDependencies.taskService.start).toHaveBeenLastCalledWith(expect.objectContaining({
      origin_adapter: "codex",
      session_id: "shared-session",
    }));
    expect(child.exitCode).toBe(0);
    expect(childDependencies.taskService.start).toHaveBeenLastCalledWith(expect.objectContaining({
      origin_adapter: "claude",
    }));
    expect(takeover.exitCode).toBe(0);
    expect(recoverDependencies.taskService.recover).toHaveBeenLastCalledWith({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      action: { kind: "takeover", origin_adapter: "gemini", session_id: "shared-session" },
    });
  });

  it("validates the latest Handoff before an existing Task can acquire a Claim", async () => {
    const dependencies = makeCliDependencies({
      taskService: {
        handoff: vi.fn().mockRejectedValue(new ControlError("REGISTRY_CORRUPT", "invalid committed Handoff")),
      },
    });

    const result = await runCli([
      "task", "start", "--task", TASK_ID, "--repo-path", "/fixture/private-source/control", "--session", "codex-resume", "--origin-adapter", "codex",
    ], dependencies);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "REGISTRY_CORRUPT" } });
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it("promotes a temporary Task only through verified Issue authority", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "task", "promote", "--task", TASK_ID, "--repo-path", "/srv/source/control",
      "--issue-url", "https://github.com/example/control/issues/1",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.source.promoteTemporaryTask).toHaveBeenCalledWith({
      task_id: TASK_ID,
      repository_path: "/srv/source/control",
      issue_url: "https://github.com/example/control/issues/1",
    });
    expect(vi.mocked(dependencies.source.promoteTemporaryTask).mock.calls[0]?.[0]).not.toHaveProperty("resolve_from_checkout");
    expect(dependencies.mutationLock.run).toHaveBeenCalledTimes(1);
  });

  it("retrieves bounded Handoff evidence explicitly without acquiring the mutation lock", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli(["task", "handoff", "--task", TASK_ID, "--claim", CLAIM_ID], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.taskService.handoff).toHaveBeenCalledWith(TASK_ID, CLAIM_ID);
    expect(dependencies.mutationLock.run).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({
      result: { task_id: TASK_ID, claim_id: CLAIM_ID, handoff_pointer: `handoffs/${TASK_ID}/${CLAIM_ID}.md` },
    });
  });

  it.each(["handoff", "resume"] as const)("keeps escaped %s Handoff JSON within the 12 KiB CLI envelope", async (kind) => {
    const sections = Object.fromEntries([
      "Progress Since Last Checkpoint",
      "Git State",
      "Validation",
      "Failures and Dead Ends",
      "Exact Next Step",
      "Related ADR and Evidence",
    ].map((name) => [name, "\\".repeat(2_000)]));
    const journal = { append: vi.fn().mockRejectedValue(new Error("injected journal gap")) };
    const dependencies = makeCliDependencies({
      journal,
      taskService: { handoff: vi.fn().mockResolvedValue({
        handoff_pointer: `handoffs/${TASK_ID}/${CLAIM_ID}.md`,
        task_id: TASK_ID,
        claim_id: CLAIM_ID,
        source_task_revision: "2026-08-13T00:00:00Z",
        generated_at: "2026-08-13T00:01:00Z",
        sections,
      }) },
    });
    const argv = kind === "handoff"
      ? ["task", "handoff", "--task", TASK_ID, "--claim", CLAIM_ID]
      : ["task", "start", "--task", TASK_ID, "--repo-path", "/fixture/private-source/control", "--session", "codex-resume", "--origin-adapter", "codex"];

    const result = await runCli(argv, dependencies);
    const payload = JSON.parse(result.stdout);
    const summary = kind === "handoff" ? payload.result : payload.result.latest_handoff;

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(summary.truncated).toBe(true);
    expect(Object.keys(summary.sections)).toEqual(Object.keys(sections));
    expect(payload.journal_warning).toEqual({ code: "JOURNAL_WRITE_FAILED" });
  });

  // The branch and worktree ref here carry slashes on purpose: they are the
  // only diagnosis a Claim conflict gives anyone, and redaction that reached
  // them would leave the operator with a code and nothing to act on.
  it("returns stable JSON and exit code 4 for a Claim conflict", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-conflict-"));
    const conflictingClaim = {
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      host: "build-host",
      branch: "task/000000000001-control-task",
      worktree_ref: "wt-000000000001-control-task",
      started_at: "2026-08-13T00:00:00.000Z",
    };
    const dependencies = makeCliDependencies({
      stateDir,
      taskService: {
        start: async () => {
          throw new ControlError("TASK_ALREADY_CLAIMED", "occupied with raw-secret-message", {
            conflicting_claim: conflictingClaim,
            session_id: "codex-secret-session",
            repository_path: "/private/source/control",
            token: "secret-token",
          });
        },
      },
    });

    const result = await runCli(formalStartArgs(), dependencies);
    const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "TASK_ALREADY_CLAIMED", conflicting_claim: conflictingClaim },
    });
    expect(`${result.stderr}${journal}`).not.toContain("codex-secret-session");
    expect(`${result.stderr}${journal}`).not.toContain("secret-token");
    expect(`${result.stderr}${journal}`).not.toContain("raw-secret-message");
    expect(`${result.stderr}${journal}`).not.toContain("/private/source/control");
    expect(JSON.parse(journal)).toMatchObject({ ok: false, error_code: "TASK_ALREADY_CLAIMED" });
    expect(JSON.parse(journal)).not.toHaveProperty("error_reason");
  });

  it("returns bounded owner coordinates and exit code 4 for exact session occupancy", () => {
    const conflictingClaim = {
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      host: "build-host",
      branch: "task/000000000001-control-task",
      worktree_ref: "wt-000000000001-control-task",
      started_at: "2026-08-13T00:00:00.000Z",
    };
    const result = controlErrorResult(new ControlError(
      "TASK_SESSION_BUSY",
      "occupied with raw-secret-message",
      {
        conflicting_claim: conflictingClaim,
        session_id: "codex-secret-session",
        repository_path: "/private/source/control",
        token: "secret-token",
      },
    ), "task start");

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "TASK_SESSION_BUSY", conflicting_claim: conflictingClaim },
    });
    expect(result.stderr).not.toContain("codex-secret-session");
    expect(result.stderr).not.toContain("secret-token");
    expect(result.stderr).not.toContain("raw-secret-message");
    expect(result.stderr).not.toContain("/private/source/control");
  });

  it.each([
    ["TASK_ALREADY_CLAIMED", "missing", undefined],
    ["TASK_SESSION_BUSY", "missing", undefined],
    ["TASK_ALREADY_CLAIMED", "extra-field", {
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      host: "build-host",
      branch: "task/control",
      worktree_ref: "wt-control",
      started_at: "2026-08-13T00:00:00.000Z",
      session_id: "must-reject-extra-field",
    }],
    ["TASK_SESSION_BUSY", "extra-field", {
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      host: "build-host",
      branch: "task/control",
      worktree_ref: "wt-control",
      started_at: "2026-08-13T00:00:00.000Z",
      session_id: "must-reject-extra-field",
    }],
  ] as const)("fails closed for %s when Claim-conflict coordinates are %s", async (code, _shape, conflicting_claim) => {
    const result = await runCli(formalStartArgs(), makeCliDependencies({
      taskService: {
        start: async () => {
          throw new ControlError(code, "occupied", {
            ...(conflicting_claim ? { conflicting_claim } : {}),
          });
        },
      },
    }));

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code } });
    expect(result.stderr).not.toContain("must-reject-extra-field");
  });

  it("emits the schema-pinned reason for a Handoff retry conflict and journals it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-reason-"));
    const result = await runCli([
      "task", "finish", "--task", TASK_ID, "--claim", CLAIM_ID, "--status", "handoff", "--validation", "npm test: pass",
    ], makeCliDependencies({
      stateDir,
      taskService: {
        finish: async () => {
          throw new ControlError("HANDOFF_RETRY_CONFLICT", "Committed Handoff conflicts with current Git evidence", {
            handoff_path: "/registry/handoffs/committed.md",
            reason: "git_identity_changed",
          });
        },
      },
    }));
    const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "HANDOFF_RETRY_CONFLICT", reason: "git_identity_changed" },
    });
    expect(result.stderr).not.toContain("registry");
    expect(JSON.parse(journal)).toMatchObject({
      ok: false,
      error_code: "HANDOFF_RETRY_CONFLICT",
      error_reason: "git_identity_changed",
    });
  });

  it("carries the reason that tells a malformed handoff copy apart from operator work", () => {
    const result = controlErrorResult(new ControlError(
      "WORKTREE_DIRTY",
      "Refusing to remove a worktree whose handoff copy is not a plain file",
      {
        worktree_ref: "wt-000000000001-control-task",
        dirty_files: [".ai/handoff.md"],
        reason: "handoff_copy_not_plain_file",
      },
    ));

    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "WORKTREE_DIRTY", reason: "handoff_copy_not_plain_file" },
    });
  });

  it.each([
    42,
    "worktree moved underneath",
    "task/branch-moved",
    "GIT_IDENTITY_CHANGED",
    "x",
    "_leading_underscore",
    "git_identity_change", // a plausible typo: the shape allows it, only membership rejects it
  ])("fails closed instead of emitting a reason that is not in the registered vocabulary: %s", (reason) => {
    const result = controlErrorResult(new ControlError("HANDOFF_RETRY_CONFLICT", "conflict", { reason }));

    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "HANDOFF_RETRY_CONFLICT" } });
  });

  it("never emits conflicting_claim for unrelated errors", async () => {
    const result = await runCli(formalStartArgs(), makeCliDependencies({
      taskService: {
        start: async () => {
          throw new ControlError("COMMAND_FAILED", "raw-secret-message", {
            conflicting_claim: {
              task_id: TASK_ID,
              claim_id: CLAIM_ID,
              host: "build-host",
              branch: "task/control",
              worktree_ref: "wt-control",
              started_at: "2026-08-13T00:00:00.000Z",
            },
          });
        },
      },
    }));

    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "COMMAND_FAILED" } });
    expect(result.stderr).not.toContain("conflicting_claim");
  });

  it("never writes tokens to output or the measurement journal", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-"));
    const result = await runCli(["portfolio", "status"], makeCliDependencies({
      stateDir,
      env: { GH_PROJECT_TOKEN: "secret-token" },
    }));

    const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");
    expect(`${result.stdout}${result.stderr}${journal}`).not.toContain("secret-token");
    expect((await stat(join(stateDir, "pilot-journal.jsonl"))).mode & 0o777).toBe(0o600);
  });

  // The record is deliberately allowed to fail without failing registration,
  // so the only way an operator learns the store stopped working is here.
  it("rides a registration-record warning out on the successful result", async () => {
    for (const code of [
      "REGISTRATION_RECORD_UNREADABLE",
      "REGISTRATION_RECORD_UNWRITABLE",
      "REGISTRATION_RECORD_AT_CAPACITY",
    ] as const) {
      const dependencies = makeCliDependencies({ registrationRecordWarning: { code } });

      const result = await runCli(registerArgs(), dependencies);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        result: { project_id: PROJECT_ID },
        registration_record_warning: { code },
      });
    }
  });

  // The record is written before the field writes, so a registration that fails
  // afterwards has already lost its coordinates — and the retry the runbook
  // prescribes is the one that would pay for it.
  it("rides the warning out on a failed registration too", async () => {
    const dependencies = makeCliDependencies({
      registrationRecordWarning: { code: "REGISTRATION_RECORD_UNREADABLE" },
      portfolio: {
        registerProject: vi.fn().mockRejectedValue(
          new ControlError("PROJECT_REGISTRATION_UNSETTLED", "did not settle"),
        ),
      },
    });

    const result = await runCli(registerArgs(), dependencies);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "PROJECT_REGISTRATION_UNSETTLED" },
      registration_record_warning: { code: "REGISTRATION_RECORD_UNREADABLE" },
    });
    expect(result.stdout).toBe("");
  });

  it("leaves a successful registration unmarked when the record did its job", async () => {
    const result = await runCli(registerArgs(), makeCliDependencies());

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("registration_record_warning");
  });

  // Both warnings ride the same result, and the journal one must not drop the
  // other while rewriting the payload.
  it("keeps both warnings when the journal fails during a degraded registration", async () => {
    const dependencies = makeCliDependencies({
      registrationRecordWarning: { code: "REGISTRATION_RECORD_AT_CAPACITY" },
      journal: { append: vi.fn().mockRejectedValue(new Error("injected journal failure")) },
    });

    const result = await runCli(registerArgs(), dependencies);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      registration_record_warning: { code: "REGISTRATION_RECORD_AT_CAPACITY" },
      journal_warning: { code: "JOURNAL_WRITE_FAILED" },
    });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it("keeps authoritative success coordinates when the derived journal append fails", async () => {
    const dependencies = makeCliDependencies({
      journal: { append: vi.fn().mockRejectedValue(new Error("injected journal failure")) },
    });

    const result = await runCli(formalStartArgs(), dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.taskService.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      result: { claim: { task_id: TASK_ID, claim_id: CLAIM_ID } },
      journal_warning: { code: "JOURNAL_WRITE_FAILED" },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("injected journal failure");
  });

  it("reserves enough portfolio output for a journal-gap warning without crossing 12 KiB", async () => {
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => nearCliLimitPortfolioSource() },
      repositories: { listRepositories: async () => [] },
      stateDir: "/unused",
    });
    const dependencies = makeCliDependencies({
      portfolio: { status: portfolio.status.bind(portfolio) },
      journal: { append: vi.fn().mockRejectedValue(new Error("injected journal failure")) },
    });

    const result = await runCli(["portfolio", "status"], dependencies);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ journal_warning: { code: "JOURNAL_WRITE_FAILED" } });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it("keeps the original command error when its derived journal append also fails", async () => {
    const dependencies = makeCliDependencies({
      taskService: { status: vi.fn().mockRejectedValue(new ControlError("CLAIM_MISMATCH", "untrusted detail")) },
      journal: { append: vi.fn().mockRejectedValue(new Error("injected journal failure")) },
    });

    const result = await runCli(["task", "status", "--task", TASK_ID, "--claim", CLAIM_ID], dependencies);

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "CLAIM_MISMATCH" },
      journal_warning: { code: "JOURNAL_WRITE_FAILED" },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("untrusted detail");
    expect(`${result.stdout}${result.stderr}`).not.toContain("injected journal failure");
  });

  it("rejects unknown flags and mixed formal/temporary task inputs before calling services", async () => {
    const dependencies = makeCliDependencies();

    const unknown = await runCli(["task", "status", "--task", TASK_ID, "--bogus", "x"], dependencies);
    const mixed = await runCli([
      ...formalStartArgs(),
      "--temp-alias", "control-temp",
      "--goal", "do not persist",
      "--done", "test",
      "--scope", "src/control",
    ], dependencies);
    const invalidId = await runCli(["task", "status", "--task", "tsk-a"], dependencies);

    expect(unknown.exitCode).toBe(2);
    expect(mixed.exitCode).toBe(2);
    expect(invalidId.exitCode).toBe(2);
    expect(dependencies.taskService.status).not.toHaveBeenCalled();
    expect(dependencies.catalog.registerFormalTask).not.toHaveBeenCalled();
    expect(dependencies.catalog.registerTemporaryTask).not.toHaveBeenCalled();
  });

  it("starts a formal task without echoing its repository path or issue input", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-"));
    const dependencies = makeCliDependencies({ stateDir });

    const result = await runCli(formalStartArgs(), dependencies);
    const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(dependencies.source.registerFormalTask).toHaveBeenCalledWith(expect.objectContaining({
      project_id: PROJECT_ID,
      repo_id: REPO_ID,
      expected_issue_node_id: "I_control",
      task_role: "standalone",
      grants: [{
        capability: "repo.modify",
        resource: { kind: "repository", id: REPO_ID },
        coordination: "shared",
      }],
      dependencies: [],
    }));
    expect(dependencies.taskService.start).toHaveBeenCalledWith(expect.objectContaining({
      task_id: TASK_ID,
      repository_path: "/private/source/control",
    }));
    expect(`${result.stdout}${result.stderr}${journal}`).not.toContain("/private/source/control");
    expect(`${result.stdout}${result.stderr}${journal}`).not.toContain("I_control");
  });

  it("composes Catalog board contracts with the production BoardService authority port", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-authority-"));
    const dependencies = createCliDependencies({
      HOME: stateDir,
      JHW_REGISTRY_DIR: join(stateDir, "registry"),
      JHW_WORKTREE_ROOT: join(stateDir, "worktrees"),
      JHW_CONTROL_STATE_DIR: join(stateDir, "state"),
      JHW_BUILD_HOST: "build-host",
      JHW_GITHUB_OWNER: "example",
      JHW_PROJECT_NUMBER: "1",
      JHW_REGISTRY_REPOSITORY: "example/registry",
      JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
      JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
    });
    await dependencies.boardService.register({
      board_id: "wlan-target-board",
      interfaces: [],
      session: "codex-authority",
    });
    const contract = {
      version: 1 as const,
      task_id: TASK_ID,
      grants: [{
        capability: "board.execute" as const,
        resource: { kind: "board" as const, id: "wlan-target-board" },
        coordination: "exclusive" as const,
      }],
      dependencies: [],
    };
    const authority = (dependencies.catalog as unknown as { contractAuthority: ContractAuthorityPort }).contractAuthority;

    await expect(authority.assertKnownContract({ ...formalTask(), work_contract: contract }, contract)).resolves.toBeUndefined();
  });

  it("rejects a new Task without grants before registration or Claim mutation", async () => {
    const dependencies = makeCliDependencies();
    const args = formalStartArgs();
    args.splice(args.indexOf("--grant"), 2);

    const result = await runCli(args, dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.source.registerFormalTask).not.toHaveBeenCalled();
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it("registers a child through Catalog and immediately claims its generated identity", async () => {
    const child = childTask();
    const childClaim = { ...activeClaim, task_id: child.id, task_alias: child.aliases[0] };
    const dependencies = makeCliDependencies({
      taskService: { start: vi.fn().mockResolvedValue({ ...started, claim: childClaim }) },
    });

    const result = await runCli([
      "task", "child-start",
      "--parent", TASK_ID,
      "--alias", "local-hardening",
      "--repo-path", "/srv/src/wlan-package",
      "--goal", "Harden local package changes",
      "--done", "host tests pass",
      "--required-for-parent", "true",
      "--grant", `repo.modify:repository:${REPO_ID}:shared`,
      "--grant", `git.commit:repository:${REPO_ID}:shared`,
      "--origin-adapter", "codex",
      "--session", "codex-local-hardening",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.catalog.registerChildTask).toHaveBeenCalledWith({
      parent_task_id: TASK_ID,
      alias: "local-hardening",
      required_for_parent: true,
      goal: "Harden local package changes",
      done_conditions: ["host tests pass"],
      grants: [
        {
          capability: "git.commit",
          resource: { kind: "repository", id: REPO_ID },
          coordination: "shared",
        },
        {
          capability: "repo.modify",
          resource: { kind: "repository", id: REPO_ID },
          coordination: "shared",
        },
      ],
      dependencies: [],
    });
    expect(dependencies.taskService.start).toHaveBeenCalledWith({
      task_id: CHILD_TASK_ID,
      task_alias: "local-hardening",
      project_id: PROJECT_ID,
      repo_id: REPO_ID,
      origin_adapter: "codex",
      session_id: "codex-local-hardening",
      repository_path: "/srv/src/wlan-package",
    });
    expect(JSON.parse(result.stdout).result.task).toMatchObject({ task_id: CHILD_TASK_ID, parent_task_id: TASK_ID });
  });

  it("retains the registered child coordinate alongside worktree Claim recovery coordinates", async () => {
    const secretPath = "/private/worktree/secret";
    const dependencies = makeCliDependencies({
      taskService: {
        start: vi.fn().mockRejectedValue(new ControlError("WORKTREE_PATH_EXISTS", "failed", {
          task_id: CHILD_TASK_ID,
          claim_id: CLAIM_ID,
          claim_state: "released",
          path: secretPath,
        })),
      },
    });

    const result = await runCli(childStartArgs(), dependencies);

    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "WORKTREE_PATH_EXISTS",
        retained_claim: { task_id: CHILD_TASK_ID, claim_id: CLAIM_ID, state: "released" },
        retained_task: { task_id: CHILD_TASK_ID },
      },
    });
    expect(result.stderr).not.toContain(secretPath);
  });

  it("does not emit retained_task when child registration itself fails", async () => {
    const dependencies = makeCliDependencies({
      catalog: {
        registerChildTask: vi.fn().mockRejectedValue(new ControlError("TASK_PARENT_REQUIRED", "missing parent", {
          path: "/private/registry/task",
          retained_task: { task_id: CHILD_TASK_ID },
        })),
      },
    });

    const result = await runCli(childStartArgs(), dependencies);

    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "TASK_PARENT_REQUIRED" } });
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it("fails closed instead of emitting an invalid retained_task coordinate", () => {
    const result = controlErrorResult(new ControlError("TASK_SESSION_BUSY", "busy", {
      retained_task: { task_id: "../not-a-task" },
    }));

    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "TASK_SESSION_BUSY" } });
  });

  it("does not call TaskService.start when source reuse rejects explicit contract intent", async () => {
    const dependencies = makeCliDependencies({
      source: {
        registerFormalTask: vi.fn().mockRejectedValue(new ControlError("TASK_CONTRACT_MISMATCH", "stored contract differs")),
      },
    });

    const result = await runCli(formalStartArgs(), dependencies);

    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "TASK_CONTRACT_MISMATCH" } });
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it("defaults an omitted required-for-parent flag to true before child registration", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "task", "child-start",
      "--parent", TASK_ID,
      "--alias", "local-hardening",
      "--repo-path", "/srv/src/wlan-package",
      "--goal", "Harden local package changes",
      "--done", "host tests pass",
      "--grant", `repo.modify:repository:${REPO_ID}:shared`,
      "--origin-adapter", "codex",
      "--session", "codex-local-hardening",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.catalog.registerChildTask).toHaveBeenCalledWith(expect.objectContaining({
      required_for_parent: true,
    }));
  });

  it.each([
    ["256-byte", "s".repeat(256)],
    ["multibyte-overflow", "가".repeat(86)],
    ["control-character", "codex\u0007child"],
  ])("rejects a %s child session before Registry or Claim mutation", async (_case, session) => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "task", "child-start",
      "--parent", TASK_ID,
      "--alias", "local-hardening",
      "--repo-path", "/srv/src/wlan-package",
      "--goal", "Harden local package changes",
      "--done", "host tests pass",
      "--required-for-parent", "true",
      "--grant", `repo.modify:repository:${REPO_ID}:shared`,
      "--session", session,
    ], dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.catalog.registerChildTask).not.toHaveBeenCalled();
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed child fields before Catalog mutation", async () => {
    for (const tail of [
      [],
      ["--required-for-parent", "yes", "--grant", `repo.modify:repository:${REPO_ID}:shared`],
    ]) {
      const dependencies = makeCliDependencies();
      const result = await runCli([
        "task", "child-start", "--parent", TASK_ID, "--alias", "local-hardening",
        "--repo-path", "/srv/src/wlan-package", "--goal", "Harden local package changes",
        "--done", "host tests pass", "--session", "codex-local-hardening", ...tail,
      ], dependencies);
      expect(result.exitCode).toBe(2);
      expect(dependencies.catalog.registerChildTask).not.toHaveBeenCalled();
      expect(dependencies.taskService.start).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing child session before the child record is written", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "task", "child-start", "--parent", TASK_ID, "--alias", "local-hardening",
      "--repo-path", "/srv/src/wlan-package", "--goal", "Harden local package changes",
      "--done", "host tests pass", "--required-for-parent", "true",
      "--grant", `repo.modify:repository:${REPO_ID}:shared`,
    ], dependencies);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).not.toHaveProperty("error.retained_task");
    expect(dependencies.catalog.registerChildTask).not.toHaveBeenCalled();
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it.each([
    ["--project", PROJECT_ID],
    ["--repo-id", REPO_ID],
    ["--issue-node-id", "I_control"],
    ["--issue-url", "https://github.com/example/control/issues/1"],
    ["--issue-revision", "2026-08-13T00:00:00Z"],
    ["--temp-alias", "control-temp"],
    ["--goal", "goal"],
    ["--done", "done"],
    ["--scope", "src/control"],
    ["--role", "standalone"],
    ["--grant", `repo.modify:repository:${REPO_ID}:shared`],
    ["--depends", `observes:${CHILD_TASK_ID}`],
  ])("rejects registration/contract flag %s on existing Task start", async (flag, input) => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "task", "start", "--task", TASK_ID, "--repo-path", "/srv/source/control",
      "--session", "codex-resume", "--origin-adapter", "codex", flag, input,
    ], dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.source.prepareExistingTask).not.toHaveBeenCalled();
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
  });

  it("configures an inactive Task contract without inventing a Task identity", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "task", "contract", "--task", TASK_ID, "--role", "parent",
      "--grant", `repo.modify:repository:${REPO_ID}:shared`,
      "--depends", `observes:${CHILD_TASK_ID}`,
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.catalog.configureInactiveTask).toHaveBeenCalledWith({
      task_id: TASK_ID,
      task_role: "parent",
      work_contract: {
        version: 1,
        task_id: TASK_ID,
        grants: [{
          capability: "repo.modify",
          resource: { kind: "repository", id: REPO_ID },
          coordination: "shared",
        }],
        dependencies: [{ relation: "observes", task_id: CHILD_TASK_ID }],
      },
    });
  });

  it("surfaces active-Claim contract replacement refusal without starting or releasing a Claim", async () => {
    const dependencies = makeCliDependencies({
      catalog: { configureInactiveTask: vi.fn().mockRejectedValue(new ControlError("TASK_CONTRACT_ACTIVE", "active")) },
    });
    const result = await runCli([
      "task", "contract", "--task", TASK_ID, "--role", "standalone",
      "--grant", `repo.modify:repository:${REPO_ID}:shared`,
    ], dependencies);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "TASK_CONTRACT_ACTIVE" } });
    expect(dependencies.taskService.start).not.toHaveBeenCalled();
    expect(dependencies.taskService.finish).not.toHaveBeenCalled();
  });

  it("records structured completion readiness without closing or releasing the Claim", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "task", "completion-ready", "--task", TASK_ID, "--claim", CLAIM_ID,
      "--integration-validation", "host tests pass",
      "--integration-validation", "integration smoke passes",
      "--child-disposition", `${CHILD_TASK_ID}:accepted-risk`,
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.taskService.markCompletionReady).toHaveBeenCalledWith({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      integration_validation: ["host tests pass", "integration smoke passes"],
      child_dispositions: [{ task_id: CHILD_TASK_ID, disposition: "accepted-risk" }],
    });
    expect(dependencies.taskService.finish).not.toHaveBeenCalled();
  });

  it.each([
    ["task", "finish", "--task", TASK_ID, "--claim", CLAIM_ID, "--status", "completed", "--outcome", "shipped", "--validation", "pass", "--integration-validation", "must reject"],
    ["task", "status", "--task", TASK_ID, "--claim", CLAIM_ID, "--child-disposition", `${CHILD_TASK_ID}:superseded`],
  ])("rejects completion evidence fields outside completion-ready", async (...args) => {
    const dependencies = makeCliDependencies();
    const result = await runCli(args, dependencies);
    expect(result.exitCode).toBe(2);
    expect(dependencies.taskService.markCompletionReady).not.toHaveBeenCalled();
    expect(dependencies.taskService.finish).not.toHaveBeenCalled();
  });

  it("preserves the same-Claim completion evidence refusal from TaskService", async () => {
    const dependencies = makeCliDependencies({
      taskService: { finish: vi.fn().mockRejectedValue(new ControlError("COMPLETION_EVIDENCE_REQUIRED", "missing")) },
    });
    const result = await runCli([
      "task", "finish", "--task", TASK_ID, "--claim", CLAIM_ID,
      "--status", "completed", "--outcome", "shipped", "--validation", "pass",
    ], dependencies);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "COMPLETION_EVIDENCE_REQUIRED" } });
  });

  it("resolves an omitted status Claim through ClaimService without exposing host paths", async () => {
    const dependencies = makeCliDependencies();

    const result = await runCli(["task", "status", "--task", TASK_ID], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.claimService.getActive).toHaveBeenCalledWith(TASK_ID);
    expect(dependencies.taskService.status).toHaveBeenCalledWith(TASK_ID, CLAIM_ID);
    expect(result.stdout).not.toContain("/private");
  });

  it("classifies only lifecycle mutations for host locking", () => {
    expect(requiresMutationLock(["task", "start"])).toBe(true);
    expect(requiresMutationLock(["task", "child-start"])).toBe(true);
    expect(requiresMutationLock(["task", "contract"])).toBe(true);
    expect(requiresMutationLock(["task", "completion-ready"])).toBe(true);
    expect(requiresMutationLock(["task", "finish"])).toBe(true);
    expect(requiresMutationLock(["task", "recover", "--action", "takeover"])).toBe(true);
    expect(requiresMutationLock(["task", "recover", "--action", "cleanup"])).toBe(true);
    expect(requiresMutationLock(["project", "register"])).toBe(true);
    expect(requiresMutationLock(["project", "update"])).toBe(true);
    expect(requiresMutationLock(["preflight"])).toBe(true);
    expect(requiresMutationLock(["task", "status"])).toBe(false);
    expect(requiresMutationLock(["task", "recover", "--action", "status"])).toBe(false);
    expect(requiresMutationLock(["portfolio", "status"])).toBe(false);
    expect(requiresMutationLock(["portfolio", "export"])).toBe(true);
  });

  it("locks preflight and portfolio export while portfolio status remains read-only", async () => {
    const mutationLock = { run: vi.fn(async <T>(callback: () => Promise<T>) => callback()) };
    const dependencies = makeCliDependencies({ mutationLock });

    const preflight = await runCli(["preflight"], dependencies);
    const status = await runCli(["portfolio", "status"], dependencies);
    const exported = await runCli(["portfolio", "export"], dependencies);

    expect(preflight.exitCode).toBe(0);
    expect(status.exitCode).toBe(0);
    expect(exported.exitCode).toBe(0);
    expect(mutationLock.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["LOCK_CONTENDED", 75],
    ["LOCK_SPAWN_FAILED", 1],
    ["LOCK_ACQUIRE_FAILED", 1],
  ] as const)("journals stable %s lock failures before a mutation runs", async (code, expectedExit) => {
    const journal = { append: vi.fn() };
    const mutationLock = {
      run: vi.fn(async () => { throw new ControlError(code, "untrusted lock diagnostic"); }),
    };
    const dependencies = makeCliDependencies({ mutationLock, journal });

    const result = await runCli(registerArgs(), dependencies);

    expect(result.exitCode).toBe(expectedExit);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code } });
    expect(dependencies.portfolio.registerProject).not.toHaveBeenCalled();
    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({ command: "project register", ok: false, error_code: code }));
  });

  it("maps immediate contention to exit 75 and appends one complete journal event per concurrent command", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-contention-"));
    const mutationLock = new MutationLock(lockConfig(stateDir), {}, immediateContentionRuntime());
    const dependencies = makeCliDependencies({ stateDir, mutationLock });
    const args = registerArgs();

    const results = await Promise.all(Array.from({ length: 20 }, () => runCli(args, dependencies)));
    const lines = (await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8")).trim().split("\n");

    expect(results).toHaveLength(20);
    for (const result of results) {
      expect(result.exitCode).toBe(75);
      expect(JSON.parse(result.stderr)).toEqual({ error: { code: "LOCK_CONTENDED" } });
    }
    expect(lines).toHaveLength(20);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ command: "project register", error_code: "LOCK_CONTENDED" });
    }
  });

  it("requires a non-unknown revision for Handoff and an outcome for completion", async () => {
    const dependencies = makeCliDependencies();
    const common = ["task", "finish", "--task", TASK_ID, "--claim", CLAIM_ID, "--validation", "npm test: pass"];

    const handoff = await runCli([...common, "--status", "handoff", "--source-task-revision", "unknown"], dependencies);
    const completed = await runCli([...common, "--status", "completed", "--outcome", "  "], dependencies);

    expect(handoff.exitCode).toBe(2);
    expect(completed.exitCode).toBe(2);
    expect(dependencies.taskService.finish).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "NaN", "Infinity"])("rejects invalid active-work-minutes %s before service or journal mutation", async (minutes) => {
    const journal = { append: vi.fn() };
    const dependencies = makeCliDependencies({ journal });

    const result = await runCli([
      "task", "finish",
      "--task", TASK_ID,
      "--claim", CLAIM_ID,
      "--status", "completed",
      "--outcome", "shipped",
      "--validation", "targeted test",
      "--active-work-minutes", minutes,
    ], dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.taskService.finish).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("records active work minutes without writing validation text to the journal", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-"));
    const dependencies = makeCliDependencies({ stateDir });
    const validation = "validation must not enter journal";

    const result = await runCli([
      "task", "finish",
      "--task", TASK_ID,
      "--claim", CLAIM_ID,
      "--status", "completed",
      "--outcome", "shipped",
      "--validation", validation,
      "--active-work-minutes", "12.5",
    ], dependencies);
    const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(journal)).toMatchObject({
      command: "task finish",
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      active_work_minutes: 12.5,
      ok: true,
    });
    expect(journal).not.toContain(validation);
  });

  it("retains active-work minutes in the journal when finish fails after parsing", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-"));
    const result = await runCli([
      "task", "finish",
      "--task", TASK_ID,
      "--claim", CLAIM_ID,
      "--status", "completed",
      "--outcome", "shipped",
      "--validation", "targeted test",
      "--active-work-minutes", "9",
    ], makeCliDependencies({
      stateDir,
      taskService: { finish: async () => { throw new ControlError("REMOTE_DIVERGED", "stale remote"); } },
    }));
    const journal = JSON.parse(await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8"));

    expect(result.exitCode).toBe(75);
    expect(journal).toMatchObject({
      command: "task finish",
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      active_work_minutes: 9,
      ok: false,
      error_code: "REMOTE_DIVERGED",
    });
  });

  it("surfaces only retained Claim coordinates when task start reports a retained Claim", async () => {
    const dependencies = makeCliDependencies({
      taskService: {
        start: async () => {
          throw new ControlError("COMMAND_FAILED", "git failed at /private/secret", {
            task_id: TASK_ID,
            claim_id: CLAIM_ID,
            claim_state: "active",
            path: "/private/secret",
          });
        },
      },
    });

    const result = await runCli(formalStartArgs(), dependencies);
    const parsed = JSON.parse(result.stderr);

    expect(parsed).toMatchObject({ error: { code: "COMMAND_FAILED", retained_claim: { task_id: TASK_ID, claim_id: CLAIM_ID, state: "active" } } });
    expect(result.stderr).not.toContain("/private/secret");
  });

  it("passes one explicit approved registration payload without hidden defaults", async () => {
    const dependencies = makeCliDependencies();
    const result = await runCli([
      "project", "register",
      "--project", "prj-example",
      "--title", "Example",
      "--objective", "Prove the trial flow",
      "--repo-id", "repo-example",
      "--status", "proposed",
      "--priority", "P2",
      "--health", "unknown",
      "--next-action", "wait:select-first-task",
      "--last-reviewed", "2026-08-13",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.portfolio.registerProject).toHaveBeenCalledWith({
      project_id: "prj-example",
      title: "Example",
      objective: "Prove the trial flow",
      repo_ids: ["repo-example"],
      fields: {
        status: "proposed",
        priority: "P2",
        health: "unknown",
        next_action: "wait:select-first-task",
        last_reviewed: "2026-08-13",
      },
    });
    expect(result.stdout).not.toContain("Prove the trial flow");
  });

  it("rejects oversized Project coordinates at the result schema boundary", async () => {
    const dependencies = makeCliDependencies({
      portfolio: {
        registerProject: vi.fn().mockResolvedValue({
          project_id: PROJECT_ID,
          project_item_id: `PVTI_${"a".repeat(20_000)}`,
          source_node_id: `DI_${"b".repeat(20_000)}`,
        }),
      },
    });

    const result = await runCli(registerArgs(), dependencies);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "INVALID_PROJECT_REGISTRATION_RESULT" } });
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it("rejects any remaining oversized read-only command envelope", async () => {
    const dependencies = makeCliDependencies({
      taskService: {
        status: vi.fn().mockResolvedValue({
          active: { ...activeClaim, host: "h".repeat(20_000) },
          worktree: {
            branch: activeClaim.branch,
            worktree_ref: activeClaim.worktree_ref,
            head_sha: "0123456789abcdef",
            dirty: false,
            dirty_files: [],
            ahead: 0,
            behind: 0,
          },
        }),
      },
    });

    const result = await runCli(["task", "status", "--task", TASK_ID, "--claim", CLAIM_ID], dependencies);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "CLI_OUTPUT_TOO_LARGE" } });
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  // Each argument list is paired with a label so vitest passes the list as one
  // value instead of spreading it, and so a failure names the case.
  it.each([
    ["a missing required flag", registerArgs().filter((_, index) => index < 4 || index > 5)],
    ["an unknown flag", [...registerArgs(), "--base-sha", "a".repeat(40)]],
    ["an invalid calendar date", [...registerArgs().slice(0, -1), "2026-02-30"]],
  ])("rejects registration input with %s before the port", async (_label, args) => {
    const dependencies = makeCliDependencies();
    const result = await runCli(args, dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.portfolio.registerProject).not.toHaveBeenCalled();
  });

  it("passes only the explicitly supplied operating fields to the update port", async () => {
    const dependencies = makeCliDependencies();

    const result = await runCli(updateArgs(), dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.portfolio.updateProject).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      fields: { status: "active", next_action: `task:${TASK_ID}` },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      command: "project update",
      result: {
        project_id: PROJECT_ID,
        project_item_id: "PVTI_control",
        source_node_id: "DI_control",
        fields: updatedFields(),
      },
    });
  });

  it.each([
    ["project", "update", "--project", PROJECT_ID],
    ["project", "update", "--project", PROJECT_ID, "--title", "Renamed"],
    ["project", "update", "--project", PROJECT_ID, "--last-reviewed", "2026-02-30"],
    ["project", "update", "--status", "active"],
    ["project", "update", "--project", PROJECT_ID, "--status", ""],
    ["project", "update", "--project", PROJECT_ID, "--next-action", "   "],
    ["project", "update", "--project", PROJECT_ID, "--priority", "P1", "--priority", "P2"],
    ["project", "update", "--project", PROJECT_ID, "--next-action", "--status"],
  ])("rejects an empty, identity-bearing, or invalid update patch before the port", async (...args) => {
    const dependencies = makeCliDependencies();

    const result = await runCli(args, dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.portfolio.updateProject).not.toHaveBeenCalled();
  });

  it("rejects an update result that is oversized or names another Project", async () => {
    for (const invalid of [
      { project_id: PROJECT_ID, project_item_id: `PVTI_${"a".repeat(20_000)}`, source_node_id: "DI_control", fields: updatedFields() },
      { project_id: "prj-other", project_item_id: "PVTI_control", source_node_id: "DI_control", fields: updatedFields() },
    ]) {
      const dependencies = makeCliDependencies({
        portfolio: { updateProject: vi.fn().mockResolvedValue(invalid) },
      });

      const result = await runCli(updateArgs(), dependencies);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toEqual({ error: { code: "INVALID_PROJECT_UPDATE_RESULT" } });
      expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(12 * 1024);
    }
  });

  it("allows an optional session for status/force-end recovery without echoing a takeover session", async () => {
    const replacement = {
      ...activeClaim,
      claim_id: "clm-0198e748-3a00-7000-8000-000000000003",
      session_id: "codex-new",
      host: "new-host",
    };
    const dependencies = makeCliDependencies({
      taskService: {
        recover: vi.fn()
          .mockResolvedValueOnce({ kind: "status", active: activeClaim, process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 })
          .mockResolvedValueOnce({ kind: "force-end", history: { ...activeClaim, status: "force-ended", released_at: "2026-08-13T00:01:00.000Z" } })
          .mockResolvedValueOnce({ kind: "takeover", active: replacement, history: { ...replacement, status: "taken-over", released_at: "2026-08-13T00:01:00.000Z" } }),
      },
    });

    const status = await runCli(["task", "recover", "--task", TASK_ID, "--expect", CLAIM_ID, "--action", "status", "--session", "optional-session"], dependencies);
    const forceEnd = await runCli(["task", "recover", "--task", TASK_ID, "--expect", CLAIM_ID, "--action", "force-end", "--session", "optional-session"], dependencies);
    const takeover = await runCli([
      "task", "recover", "--task", TASK_ID, "--expect", CLAIM_ID, "--action", "takeover",
      "--session", "codex-new", "--origin-adapter", "codex",
    ], dependencies);
    const newClaim = JSON.parse(takeover.stdout).result.active.claim_id;
    const owner = await runCli(["task", "assert-owner", "--task", TASK_ID, "--claim", newClaim], dependencies);

    expect(status.exitCode).toBe(0);
    expect(forceEnd.exitCode).toBe(0);
    expect(takeover.exitCode).toBe(0);
    expect(dependencies.taskService.recover).toHaveBeenNthCalledWith(1, { task_id: TASK_ID, claim_id: CLAIM_ID, action: { kind: "status" } });
    expect(dependencies.taskService.recover).toHaveBeenNthCalledWith(2, { task_id: TASK_ID, claim_id: CLAIM_ID, action: { kind: "force-end" } });
    expect(dependencies.taskService.recover).toHaveBeenNthCalledWith(3, {
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      action: { kind: "takeover", origin_adapter: "codex", session_id: "codex-new" },
    });
    expect(JSON.parse(takeover.stdout)).toMatchObject({
      result: { kind: "takeover", active: { task_id: TASK_ID, claim_id: replacement.claim_id } },
    });
    expect(takeover.stdout).not.toContain("codex-new");
    expect(takeover.stdout).not.toContain("new-host");
    expect(newClaim).toBe(replacement.claim_id);
    expect(owner.exitCode).toBe(0);
    expect(dependencies.taskService.assertOwner).toHaveBeenLastCalledWith(TASK_ID, replacement.claim_id);
  });

  it("routes exact released-generation cleanup through locked Task recovery", async () => {
    const cleanup = {
      kind: "cleanup" as const,
      history: { ...activeClaim, status: "completed", released_at: "2026-08-13T00:01:00.000Z" },
      worktree: { removed: true, recovered: true, lifecycle: "removed" as const },
    };
    const mutationLock = { run: vi.fn(async <T>(callback: () => Promise<T>) => callback()) };
    const dependencies = makeCliDependencies({
      mutationLock,
      taskService: { recover: vi.fn().mockResolvedValue(cleanup) },
    });

    const result = await runCli([
      "task", "recover", "--task", TASK_ID, "--expect", CLAIM_ID, "--action", "cleanup",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(dependencies.taskService.recover).toHaveBeenCalledWith({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      action: { kind: "cleanup" },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ result: { kind: "cleanup", task_id: TASK_ID } });
    expect(mutationLock.run).toHaveBeenCalledTimes(1);
  });

  it.each(['"', "error", "a"])("keeps JSON valid for hostile ambient secret value %j", async (secret) => {
    const result = await runCli(["preflight"], makeCliDependencies({
      env: { GH_PROJECT_TOKEN: secret },
      preflight: { run: async () => { throw new ControlError("PREFLIGHT_UNAVAILABLE", `untrusted ${secret}`); } },
    }));

    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "PREFLIGHT_UNAVAILABLE" } });
    expect(Object.keys(JSON.parse(result.stderr).error)).toEqual(["code"]);
  });

  it("maps an ownership Claim conflict to exit code 4", async () => {
    const result = await runCli(["task", "assert-owner", "--task", TASK_ID, "--claim", CLAIM_ID], makeCliDependencies({
      taskService: { assertOwner: async () => { throw new ControlError("CLAIM_MISMATCH", "stale owner"); } },
    }));

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "CLAIM_MISMATCH" } });
  });

  it("maps unavailable authority and remote divergence to stable exit codes", async () => {
    const unavailable = await runCli(["preflight"], makeCliDependencies({
      preflight: { run: async () => { throw new ControlError("PREFLIGHT_UNAVAILABLE", "not wired"); } },
    }));
    const diverged = await runCli(["portfolio", "export"], makeCliDependencies({
      portfolio: { exportSnapshot: async () => { throw new ControlError("REMOTE_DIVERGED", "fetch failed"); } },
    }));

    expect(unavailable.exitCode).toBe(78);
    expect(diverged.exitCode).toBe(75);
  });

  it.each([
    "CREDENTIALS_NOT_SEPARATE",
    "PROJECT_SCOPE_UNVERIFIABLE",
    "PROJECT_TOKEN_HAS_REPO_SCOPE",
    "PROJECT_SCOPE_MISSING",
    "UNSUPPORTED_REGISTRY_OWNER",
    "REGISTRY_REMOTE_NOT_SSH",
    "COMMAND_TIMEOUT",
  ])("maps preflight policy-unavailable error %s to exit 78", async (code) => {
    const result = await runCli(["preflight"], makeCliDependencies({
      preflight: { run: async () => { throw new ControlError(code, "untrusted policy diagnostic"); } },
    }));

    expect(result.exitCode).toBe(78);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code } });
  });

  it.each([
    "PREFLIGHT_RESTORE_FAILED",
    "PREFLIGHT_PROJECT_INTEGRITY",
    "INVALID_PREFLIGHT_ISSUE",
    "INVALID_PREFLIGHT_ITEM",
    "INVALID_PROJECT_FIELDS",
    "INVALID_PROJECT_RESPONSE",
    "INVALID_REPOSITORY_RESPONSE",
    "COMMAND_ABORTED",
    "SENSITIVE_DATA_REJECTED",
  ])("maps malformed or indeterminate preflight error %s to exit 78", async (code) => {
    const result = await runCli(["preflight"], makeCliDependencies({
      preflight: { run: async () => { throw new ControlError(code, "untrusted diagnostic"); } },
    }));

    expect(result.exitCode).toBe(78);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code } });
  });

  it("maps a preflight lock-acquisition timeout to retryable exit 75", async () => {
    const result = await runCli(["preflight"], makeCliDependencies({
      preflight: { run: async () => { throw new ControlError("LOCK_ACQUIRE_TIMEOUT", "untrusted diagnostic"); } },
    }));

    expect(result.exitCode).toBe(75);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "LOCK_ACQUIRE_TIMEOUT" } });
  });

  it("lists every Phase 1A command in JSON help output", async () => {
    const result = await runCli(["--help"], makeCliDependencies());
    const help = result.stdout;

    expect(result.exitCode).toBe(0);
    for (const command of [
      "task start",
      "task child-start",
      "task contract",
      "task completion-ready",
      "task status",
      "task finish",
      "task recover",
      "task assert-owner",
      "portfolio status",
      "portfolio export",
      "project register",
      "preflight",
      "guard status",
      "guard preflight",
    ]) expect(help).toContain(command);
  });

  it("parses only the exact Guard diagnostic command surfaces", async () => {
    const dependencies = makeCliDependencies();
    const validStatus = await runCli(["guard", "status"], dependencies);
    const validSessionStatus = await runCli(["guard", "status", "--session", "exact-session"], dependencies);
    const validPreflight = await runCli(["guard", "preflight"], dependencies);

    expect(validStatus.exitCode).toBe(0);
    expect(validSessionStatus.exitCode).toBe(0);
    expect(validPreflight.exitCode).toBe(78);
    for (const invalid of [
      ["guard"],
      ["guard", "status", "--session"],
      ["guard", "status", "--session", "first", "--session", "second"],
      ["guard", "status", "--extra", "value"],
      ["guard", "status", "trailing"],
      ["guard", "status", "--session", "bad\nsession"],
      ["guard", "preflight", "--session", "exact-session"],
      ["guard", "preflight", "trailing"],
    ]) {
      expect((await runCli(invalid, dependencies)).exitCode).toBe(2);
    }
  });

  it("keeps Guard diagnostics lock-free while preserving the top-level preflight lock", () => {
    expect(requiresMutationLock(["guard", "status"])).toBe(false);
    expect(requiresMutationLock(["guard", "status", "--session", "exact-session"])).toBe(false);
    expect(requiresMutationLock(["guard", "preflight"])).toBe(false);
    expect(requiresMutationLock(["preflight"])).toBe(true);
  });

  it("renders closed ready counts, mode, Registry availability, and fixed pending coverage", async () => {
    const requests = (["PENDING", "APPROVED", "CONSUMED", "COMPLETED", "FAILED", "EXPIRED"] as const)
      .map((state, index) => ({
        ...guardRequest(state, index + 1),
        summary: index === 0 ? "secret-token /private/raw-command --argv" : `bounded operation ${index + 1}`,
      }));
    const result = await runCli(["guard", "status"], makeCliDependencies({
      guardMode: "observe",
      guardRequests: { inspect: vi.fn().mockResolvedValue({ status: "ready", requests }) },
      guardDigestKey: { inspect: vi.fn().mockResolvedValue({ status: "ready" }) },
      guardClaims: { listActiveClaims: vi.fn().mockResolvedValue([]) },
    }));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      command: "guard status",
      result: {
        protocol_version: 1,
        runtime_mode: "observe",
        request_state: {
          safety: "ready",
          counts: { PENDING: 1, APPROVED: 1, CONSUMED: 1, COMPLETED: 1, FAILED: 1, EXPIRED: 1, total: 6 },
        },
        digest_key: { safety: "ready" },
        registry_claims: { availability: "available" },
        adapter_coverage: {
          claude: { prompt_origin: "pending", pre_tool_blocking: "pending", execution_recheck: "pending" },
          codex: { prompt_origin: "pending", pre_tool_blocking: "pending", execution_recheck: "pending" },
          gemini: { prompt_origin: "pending", pre_tool_blocking: "pending", execution_recheck: "pending" },
          opencode: { prompt_origin: "pending", pre_tool_blocking: "pending", execution_recheck: "pending" },
        },
      },
    });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(result.stdout).not.toContain("secret-token");
    expect(result.stdout).not.toContain("/private/raw-command");
    expect(result.stdout).not.toContain("--argv");
  });

  it("reports safe uninitialized state and never creates request or digest-key files", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-guard-status-uninitialized-"));
    const before = await stat(stateDir);
    const result = await runCli(["guard", "status"], makeCliDependencies({
      stateDir,
      guardRequests: new GuardRequestStore(lockConfig(stateDir), { environment: {} }),
      guardDigestKey: new GuardDigestKey(stateDir),
    }));
    const after = await stat(stateDir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result).toMatchObject({
      request_state: {
        safety: "not_initialized",
        counts: { PENDING: 0, APPROVED: 0, CONSUMED: 0, COMPLETED: 0, FAILED: 0, EXPIRED: 0, total: 0 },
      },
      digest_key: { safety: "not_initialized" },
    });
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(readFile(join(stateDir, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(stateDir, "guard-digest.key"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("counts an expired-by-clock persisted PENDING snapshot without cleanup or byte/mtime changes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-guard-status-persisted-"));
    const statePath = join(stateDir, "guard-requests.yaml");
    const keyPath = join(stateDir, "guard-digest.key");
    await writeFile(statePath, JSON.stringify({ version: 1, requests: [guardRequest("PENDING", 1)] }), { mode: 0o600 });
    await writeFile(keyPath, Buffer.alloc(32, 0x6b), { mode: 0o600 });
    const beforeBytes = await readFile(statePath);
    const beforeState = await stat(statePath);
    const beforeKey = await stat(keyPath);

    const result = await runCli(["guard", "status"], makeCliDependencies({
      stateDir,
      guardRequests: new GuardRequestStore(lockConfig(stateDir), { environment: {} }),
      guardDigestKey: new GuardDigestKey(stateDir),
    }));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result).toMatchObject({
      request_state: { safety: "ready", counts: { PENDING: 1, EXPIRED: 0, total: 1 } },
      digest_key: { safety: "ready" },
    });
    expect(await readFile(statePath)).toEqual(beforeBytes);
    expect((await stat(statePath)).mtimeMs).toBe(beforeState.mtimeMs);
    expect((await stat(keyPath)).mtimeMs).toBe(beforeKey.mtimeMs);
    expect(result.stdout).not.toContain(Buffer.alloc(32, 0x6b).toString("hex"));
  });

  it("keeps corrupt Guard state byte-for-byte untouched, status available, and preflight fail-closed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-guard-status-corrupt-"));
    const statePath = join(stateDir, "guard-requests.yaml");
    const raw = '{"raw_operation":"secret-token /private/worktree --force"}';
    await writeFile(statePath, raw, { mode: 0o600 });
    const before = await stat(statePath);
    const dependencies = makeCliDependencies({
      stateDir,
      guardRequests: new GuardRequestStore(lockConfig(stateDir), { environment: {} }),
      guardDigestKey: new GuardDigestKey(stateDir),
    });

    const statusResult = await runCli(["guard", "status"], dependencies);
    const preflightResult = await runCli(["guard", "preflight"], dependencies);

    expect(statusResult.exitCode).toBe(0);
    expect(JSON.parse(statusResult.stdout).result.request_state).toEqual({ safety: "unavailable" });
    expect(preflightResult.exitCode).toBe(78);
    expect(JSON.parse(preflightResult.stderr)).toMatchObject({
      command: "guard preflight",
      result: {
        status: "NO-GO",
        code: "GUARD_UNAVAILABLE",
        diagnostics: {
          protocol_version: 1,
          runtime_mode: "enforce",
          request_state: { safety: "unavailable" },
          digest_key: { safety: "not_initialized" },
          registry_claims: { availability: "available" },
        },
      },
    });
    expect(await readFile(statePath, "utf8")).toBe(raw);
    expect((await stat(statePath)).mtimeMs).toBe(before.mtimeMs);
    expect(`${statusResult.stdout}${preflightResult.stderr}`).not.toContain("secret-token");
    expect(`${statusResult.stdout}${preflightResult.stderr}`).not.toContain("/private/worktree");
    expect(`${statusResult.stdout}${preflightResult.stderr}`).not.toContain("--force");
  });

  it("reports digest-key ready, missing, or unsafe without creation or repair", async () => {
    for (const scenario of ["ready", "missing", "unsafe"] as const) {
      const stateDir = await mkdtemp(join(tmpdir(), `jhw-guard-key-${scenario}-`));
      const keyPath = join(stateDir, "guard-digest.key");
      if (scenario !== "missing") {
        await writeFile(keyPath, Buffer.alloc(32, 0x73), { mode: 0o600 });
        if (scenario === "unsafe") await chmod(keyPath, 0o644);
      }
      const before = scenario === "missing" ? undefined : await stat(keyPath);
      const result = await runCli(["guard", "status"], makeCliDependencies({
        stateDir,
        guardRequests: new GuardRequestStore(lockConfig(stateDir), { environment: {} }),
        guardDigestKey: new GuardDigestKey(stateDir),
      }));

      expect(JSON.parse(result.stdout).result.digest_key.safety).toBe(
        scenario === "ready" ? "ready" : scenario === "missing" ? "not_initialized" : "unavailable",
      );
      if (before) {
        const after = await stat(keyPath);
        expect(after.mode & 0o777).toBe(before.mode & 0o777);
        expect(after.mtimeMs).toBe(before.mtimeMs);
      } else {
        await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(result.stdout).not.toContain(Buffer.alloc(32, 0x73).toString("hex"));
    }
  });

  it("distinguishes Registry unavailable from empty available and reports only bounded exact-session matches", async () => {
    const empty = await runCli(["guard", "status", "--session", "missing-session"], makeCliDependencies());
    const uniqueClaim = contractClaim("exact-session", 1);
    const unique = await runCli(["guard", "status", "--session", "exact-session"], makeCliDependencies({
      guardClaims: { listActiveClaims: vi.fn().mockResolvedValue([uniqueClaim]) },
    }));
    const ambiguous = await runCli(["guard", "status", "--session", "exact-session"], makeCliDependencies({
      guardClaims: { listActiveClaims: vi.fn().mockResolvedValue([uniqueClaim, contractClaim("exact-session", 2)]) },
    }));
    const unavailable = await runCli(["guard", "status", "--session", "exact-session"], makeCliDependencies({
      guardClaims: { withCommittedView: async () => { throw new Error("/private/registry secret-token"); } },
    }));

    expect(JSON.parse(empty.stdout).result).toMatchObject({
      registry_claims: { availability: "available" },
      session_claim: { match: "none" },
    });
    expect(JSON.parse(unique.stdout).result.session_claim).toEqual({
      match: "unique",
      work_contract_digest: uniqueClaim.work_contract_digest,
    });
    expect(JSON.parse(ambiguous.stdout).result.session_claim).toEqual({ match: "ambiguous" });
    expect(JSON.parse(unavailable.stdout).result).toMatchObject({
      registry_claims: { availability: "unavailable" },
      session_claim: { match: "unavailable" },
    });
    expect(`${unique.stdout}${ambiguous.stdout}${unavailable.stdout}`).not.toContain("guard-host");
    expect(`${unique.stdout}${ambiguous.stdout}${unavailable.stdout}`).not.toContain("task/");
    expect(unavailable.stdout).not.toContain("/private/registry");
    expect(unavailable.stdout).not.toContain("secret-token");
  });

  it("fails closed on malformed inspector values instead of exposing extra fields", async () => {
    const result = await runCli(["guard", "status"], makeCliDependencies({
      guardRequests: {
        inspect: vi.fn().mockResolvedValue({
          status: "ready",
          requests: [],
          raw_path: "/private/state",
          credential: "secret-token",
        }) as unknown as () => Promise<GuardRequestInspection>,
      },
      guardDigestKey: { inspect: vi.fn().mockResolvedValue({ status: "ready", key: "secret-key" }) },
      guardClaims: { listActiveClaims: vi.fn().mockResolvedValue([{ path: "/private/claim" }]) },
    }));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result).toMatchObject({
      request_state: { safety: "unavailable" },
      digest_key: { safety: "unavailable" },
      registry_claims: { availability: "unavailable" },
    });
    expect(result.stdout).not.toContain("/private");
    expect(result.stdout).not.toContain("secret");
  });

  it("bypasses both Pilot and Board measurement journals for both Guard diagnostics", async () => {
    const journal = { append: vi.fn().mockRejectedValue(new Error("pilot journal must not run")) };
    const boardJournal = { append: vi.fn().mockRejectedValue(new Error("board journal must not run")) };
    const mutationLock = { run: vi.fn(async <T>(callback: () => Promise<T>) => callback()) };
    const dependencies = makeCliDependencies({ journal, boardJournal, mutationLock });

    const statusResult = await runCli(["guard", "status"], dependencies);
    const preflightResult = await runCli(["guard", "preflight"], dependencies);

    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).not.toContain("journal_warning");
    expect(preflightResult.exitCode).toBe(78);
    expect(preflightResult.stderr).not.toContain("journal_warning");
    expect(mutationLock.run).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
    expect(boardJournal.append).not.toHaveBeenCalled();
  });

  it("keeps concurrent read-only journal events as complete redacted lines", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-"));
    const dependencies = makeCliDependencies({
      stateDir,
      env: { GH_PROJECT_TOKEN: "journal-token" },
    });

    await Promise.all(Array.from({ length: 24 }, () => runCli(["portfolio", "status"], dependencies)));
    const lines = (await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8")).trim().split("\n");

    expect(lines).toHaveLength(24);
    expect(lines.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "portfolio status", ok: true }),
    ]));
    expect(lines.join("\n")).not.toContain("journal-token");
  });

  it("returns the bounded actual portfolio result and rejects an untrusted deferred-port response", async () => {
    const dependencies = makeCliDependencies({
      portfolio: {
        status: vi.fn()
          .mockResolvedValueOnce({ page_id: "page-1", markdown: "# Portfolio\n", items: [], repositories: [], truncated: false, total_items: 0 })
          .mockResolvedValueOnce({ page_id: "raw-page-input", nested: { path: "/private/portfolio" } }),
      },
    });

    const valid = await runCli(["portfolio", "status"], dependencies);
    const invalid = await runCli(["portfolio", "status", "--page", "raw-page-input"], dependencies);

    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ result: { page_id: "page-1", total_items: 0 } });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).not.toContain("raw-page-input");
    expect(invalid.stderr).not.toContain("/private/portfolio");
  });

  it("rejects non-snapshot-relative export paths from an injected portfolio port", async () => {
    const result = await runCli(["portfolio", "export"], makeCliDependencies({
      portfolio: {
        exportSnapshot: async () => ({
          jsonPath: "../portfolio.json",
          markdownPath: "../portfolio.md",
          checksum: "a".repeat(64),
        }),
      },
    }));

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "INVALID_SNAPSHOT_RESULT" } });
    expect(`${result.stdout}${result.stderr}`).not.toContain("../");
  });

  it("rejects swapped JSON/Markdown snapshot paths from an injected portfolio port", async () => {
    const prefix = "2026-08-13T00-00-00.000Z";
    const result = await runCli(["portfolio", "export"], makeCliDependencies({
      portfolio: {
        exportSnapshot: async () => ({
          jsonPath: `${prefix}/portfolio.md`,
          markdownPath: `${prefix}/portfolio.json`,
          checksum: "a".repeat(64),
        }),
      },
    }));

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "INVALID_SNAPSHOT_RESULT" } });
  });
});
