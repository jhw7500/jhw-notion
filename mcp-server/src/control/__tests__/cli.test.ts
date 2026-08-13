import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { requiresMutationLock, runCli, type CliDependencies } from "../cli.js";
import { ControlError } from "../errors.js";

const TASK_ID = "tsk-0198e748-3a00-7000-8000-000000000001";
const CLAIM_ID = "clm-0198e748-3a00-7000-8000-000000000002";
const PROJECT_ID = "prj-control";
const REPO_ID = "repo-control";

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

type Overrides = {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  taskService?: Record<string, unknown>;
  catalog?: Record<string, unknown>;
  portfolio?: Record<string, unknown>;
  preflight?: Record<string, unknown>;
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
    recover: vi.fn().mockResolvedValue({ kind: "status", active: activeClaim, process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 }),
    assertOwner: vi.fn().mockResolvedValue(activeClaim),
    ...overrides.taskService,
  };
  const claimService = {
    getActive: vi.fn().mockResolvedValue(activeClaim),
  };
  const catalog = {
    registerFormalTask: vi.fn().mockResolvedValue({ task: formalTask(), created: true }),
    registerTemporaryTask: vi.fn().mockResolvedValue(temporaryTask()),
    ...overrides.catalog,
  };
  const portfolio = {
    status: vi.fn().mockResolvedValue({ projects: [] }),
    export: vi.fn().mockResolvedValue({ projects: [] }),
    registerProject: vi.fn().mockResolvedValue({ registered: true }),
    ...overrides.portfolio,
  };
  const preflight = {
    run: vi.fn().mockResolvedValue({ ready: true }),
    ...overrides.preflight,
  };

  return {
    stateDir: overrides.stateDir ?? join(tmpdir(), "jhw-control-cli-state"),
    env: overrides.env ?? {},
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    taskService,
    claimService,
    catalog,
    portfolio,
    preflight,
  } as unknown as CliDependencies;
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
    "--session", "codex-123",
  ];
}

describe("runCli", () => {
  it("returns stable JSON and exit code 4 for a Claim conflict", async () => {
    const dependencies = makeCliDependencies({
      taskService: {
        start: async () => { throw new ControlError("TASK_ALREADY_CLAIMED", "occupied"); },
      },
    });

    const result = await runCli(formalStartArgs(), dependencies);

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "TASK_ALREADY_CLAIMED" } });
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
    expect(dependencies.catalog.registerFormalTask).toHaveBeenCalledWith(expect.objectContaining({
      project_id: PROJECT_ID,
      repo_id: REPO_ID,
      issue_node_id: "I_control",
    }));
    expect(dependencies.taskService.start).toHaveBeenCalledWith(expect.objectContaining({
      task_id: TASK_ID,
      repository_path: "/private/source/control",
    }));
    expect(`${result.stdout}${result.stderr}${journal}`).not.toContain("/private/source/control");
    expect(`${result.stdout}${result.stderr}${journal}`).not.toContain("I_control");
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
    expect(requiresMutationLock(["task", "finish"])).toBe(true);
    expect(requiresMutationLock(["task", "recover", "--action", "takeover"])).toBe(true);
    expect(requiresMutationLock(["project", "register"])).toBe(true);
    expect(requiresMutationLock(["task", "status"])).toBe(false);
    expect(requiresMutationLock(["task", "recover", "--action", "status"])).toBe(false);
    expect(requiresMutationLock(["portfolio", "export"])).toBe(false);
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

  it("validates base and head SHA values before an unavailable project registration port runs", async () => {
    const dependencies = makeCliDependencies({
      portfolio: { registerProject: vi.fn(async () => { throw new ControlError("PORTFOLIO_UNAVAILABLE", "not wired"); }) },
    });

    const result = await runCli([
      "project", "register",
      "--project", PROJECT_ID,
      "--base-sha", "not-a-sha",
      "--head-sha", "0123456789abcdef",
    ], dependencies);

    expect(result.exitCode).toBe(2);
    expect(dependencies.portfolio.registerProject).not.toHaveBeenCalled();
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
      portfolio: { export: async () => { throw new ControlError("REMOTE_DIVERGED", "fetch failed"); } },
    }));

    expect(unavailable.exitCode).toBe(78);
    expect(diverged.exitCode).toBe(75);
  });

  it("lists every Phase 1A command in JSON help output", async () => {
    const result = await runCli(["--help"], makeCliDependencies());
    const help = result.stdout;

    expect(result.exitCode).toBe(0);
    for (const command of [
      "task start",
      "task status",
      "task finish",
      "task recover",
      "task assert-owner",
      "portfolio status",
      "portfolio export",
      "project register",
      "preflight",
    ]) expect(help).toContain(command);
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

  it("does not echo an untrusted deferred-port response", async () => {
    const dependencies = makeCliDependencies({
      portfolio: {
        status: vi.fn().mockResolvedValue({ page_id: "raw-page-input", nested: { path: "/private/portfolio" } }),
      },
    });

    const result = await runCli(["portfolio", "status", "--page", "raw-page-input"], dependencies);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("raw-page-input");
    expect(result.stdout).not.toContain("/private/portfolio");
  });
});
