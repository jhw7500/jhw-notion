import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHandoff } from "../handoff.js";
import { Catalog } from "../catalog.js";
import { ClaimService, type ClaimInspection } from "../claim-service.js";
import { ControlError } from "../errors.js";
import { ProcessRunner } from "../process.js";
import { RegistryGit } from "../registry-git.js";
import { TaskService } from "../task-service.js";
import { WorktreeManager, worktreePlan } from "../worktree.js";
import { configFor, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

const fixtures: RegistryFixture[] = [];
const localPaths: string[] = [];
const TASK_ID = "tsk-0198aabb-ccdd-7eef-8abc-0123456789ab";
const CLAIM_ID = "clm-0198aabb-ccdd-7eef-8abc-0123456789ab";
const taskAlias = "wlan:tmp-20260813-01-fix";
const plan = worktreePlan(TASK_ID, taskAlias);

const activeClaim = {
  task_id: TASK_ID,
  task_alias: taskAlias,
  project_id: "prj-wlan",
  repo_id: "repo-wlan",
  claim_id: CLAIM_ID,
  session_id: "codex-a",
  host: "cantopsbuildserver",
  branch: plan.branch,
  worktree_ref: plan.worktree_ref,
  started_at: "2026-08-13T12:34:56.789Z",
};

const startInput = {
  task_id: TASK_ID,
  task_alias: taskAlias,
  project_id: "prj-wlan",
  repo_id: "repo-wlan",
  session_id: "codex-a",
  repository_path: "/srv/jhw/source-repository",
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  await Promise.all(localPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function taskFixture(): Promise<{
  tasks: TaskService;
  claims: {
    claimTask: ReturnType<typeof vi.fn>;
    assertOwner: ReturnType<typeof vi.fn>;
    finishClaim: ReturnType<typeof vi.fn>;
    recoverClaim: ReturnType<typeof vi.fn>;
  };
  worktrees: {
    createOrReuse: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
    removeIfSafe: ReturnType<typeof vi.fn>;
  };
  registry: { transact: ReturnType<typeof vi.fn>; readHeadRegularFile: ReturnType<typeof vi.fn> };
  worktreePath: string;
  fixture: RegistryFixture;
}> {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const worktreePath = await mkdtemp(join(tmpdir(), "jhw-task-worktree-"));
  localPaths.push(worktreePath);
  const claims = {
    claimTask: vi.fn().mockResolvedValue(activeClaim),
    assertOwner: vi.fn().mockResolvedValue(activeClaim),
    finishClaim: vi.fn().mockResolvedValue({
      ...activeClaim,
      released_at: "2026-08-13T12:35:56.789Z",
      status: "handoff",
      head_sha: "0123456789abcdef",
      validation_summary: "npm test: pass",
    }),
    recoverClaim: vi.fn(),
  };
  const worktrees = {
    createOrReuse: vi.fn().mockResolvedValue({
      path: worktreePath,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      reused: false,
    }),
    inspect: vi.fn().mockResolvedValue({
      path: worktreePath,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      head_sha: "0123456789abcdef",
      dirty: false,
      dirty_files: [],
      ahead: 0,
      behind: 0,
    }),
    removeIfSafe: vi.fn().mockResolvedValue({ removed: true }),
  };
  const registry = {
    transact: vi.fn(async (_message: string, mutate: () => Promise<{ paths: readonly string[] }>) => {
      await mutate();
      return { commit: "registry-commit", changed: true };
    }),
    readHeadRegularFile: vi.fn(async (relativePath: string) => {
      try {
        return await readFile(join(fixture.registryDir, relativePath), "utf8");
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
          throw new ControlError("HANDOFF_MISSING", "missing");
        }
        throw cause;
      }
    }),
  };
  return {
    tasks: new TaskService(configFor(fixture.registryDir), claims, worktrees, registry, () => new Date("2026-08-13T12:36:56.789Z")),
    claims,
    worktrees,
    registry,
    worktreePath,
    fixture,
  };
}

describe("TaskService", () => {
  it("claims before creating a worktree and abandons the Claim if creation fails", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    worktrees.createOrReuse.mockRejectedValue(new Error("worktree failed"));

    await expect(tasks.start(startInput)).rejects.toThrow("worktree failed");

    expect(claims.claimTask).toHaveBeenCalledBefore(worktrees.createOrReuse);
    expect(claims.finishClaim).toHaveBeenCalledWith(
      TASK_ID,
      CLAIM_ID,
      expect.objectContaining({ status: "abandoned" }),
    );
    expect(JSON.stringify(claims.finishClaim.mock.calls)).not.toContain(startInput.repository_path);
    expect(claims.finishClaim).toHaveBeenCalledWith(
      TASK_ID,
      CLAIM_ID,
      expect.objectContaining({ validation: ["worktree_create_failed:unknown"] }),
    );
  });

  it("keeps an incomplete same-host worktree and writes a durable Registry Handoff before release", async () => {
    const { tasks, claims, worktrees, registry, worktreePath, fixture } = await taskFixture();

    const result = await tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["npm test: pass"],
      source_task_revision: "issue-revision-7",
      progress: "Implemented the bounded Handoff writer.",
      next_step: "Run the full control test suite.",
    });

    const pointer = `handoffs/${TASK_ID}/${CLAIM_ID}.md`;
    expect(result.history.handoff_pointer).toBe(pointer);
    expect(worktrees.removeIfSafe).not.toHaveBeenCalled();
    expect(registry.transact).toHaveBeenCalledBefore(claims.finishClaim);
    expect(await readFile(join(worktreePath, ".ai", "handoff.md"), "utf8")).toContain("# Handoff: tsk-");
    expect(await readFile(join(fixture.registryDir, pointer), "utf8")).toContain("source_task_revision: issue-revision-7");
    expect(claims.finishClaim).toHaveBeenCalledWith(
      TASK_ID,
      CLAIM_ID,
      expect.objectContaining({ status: "handoff", handoff_path: pointer }),
    );
  });

  it("leaves a durable Registry Handoff in place if Claim release fails", async () => {
    const { tasks, claims, worktreePath, fixture } = await taskFixture();
    claims.finishClaim.mockRejectedValueOnce(new Error("release failed"));
    const pointer = `handoffs/${TASK_ID}/${CLAIM_ID}.md`;

    await expect(
      tasks.finish({
        task_id: TASK_ID,
        claim_id: CLAIM_ID,
        status: "handoff",
        validation: ["npm test: pass"],
        source_task_revision: "issue-revision-7",
      }),
    ).rejects.toThrow("release failed");

    await expect(readFile(join(worktreePath, ".ai", "handoff.md"), "utf8")).resolves.toContain("# Handoff");
    await expect(readFile(join(fixture.registryDir, pointer), "utf8")).resolves.toContain("claim_id:");
  });

  it("reuses immutable committed Handoff bytes on a release retry despite an advancing clock", async () => {
    const { claims, worktrees, registry, worktreePath, fixture } = await taskFixture();
    const times = [
      new Date("2026-08-13T12:36:56.789Z"),
      new Date("2026-08-13T12:37:56.789Z"),
    ];
    const tasks = new TaskService(
      configFor(fixture.registryDir),
      claims,
      worktrees,
      registry,
      () => times.shift() ?? new Date("2026-08-13T12:38:56.789Z"),
    );
    claims.finishClaim.mockRejectedValueOnce(new Error("release failed"));
    const input = {
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff" as const,
      validation: ["npm test: pass"],
      source_task_revision: "issue-revision-7",
      progress: "Preserve these exact bytes.",
    };
    const pointer = join(fixture.registryDir, "handoffs", TASK_ID, `${CLAIM_ID}.md`);

    await expect(tasks.finish(input)).rejects.toThrow("release failed");
    const original = await readFile(pointer, "utf8");
    worktrees.inspect.mockResolvedValue({
      path: worktreePath,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      head_sha: "0123456789abcdef",
      dirty: true,
      dirty_files: [".ai/handoff.md"],
      ahead: 0,
      behind: 0,
    });
    await expect(tasks.finish({ ...input, progress: "conflicting retry" })).rejects.toMatchObject({
      code: "HANDOFF_RETRY_CONFLICT",
    });
    await expect(tasks.finish(input)).resolves.toMatchObject({ history: { handoff_pointer: `handoffs/${TASK_ID}/${CLAIM_ID}.md` } });

    expect(await readFile(pointer, "utf8")).toBe(original);
    expect(await readFile(join(worktreePath, ".ai", "handoff.md"), "utf8")).toBe(original);
    expect(times).toHaveLength(1);
  });

  it.each([
    ["a new commit", { head_sha: "deadbeef", dirty: true, dirty_files: [".ai/handoff.md"], ahead: 0, behind: 0 }],
    ["an unrelated dirty file", { head_sha: "0123456789abcdef", dirty: true, dirty_files: ["src/unrelated.ts"], ahead: 0, behind: 0 }],
    ["advanced ahead state", { head_sha: "0123456789abcdef", dirty: true, dirty_files: [".ai/handoff.md"], ahead: 1, behind: 0 }],
  ] as const)("retains the Claim when retry Git evidence is stale due to %s", async (_reason, changed) => {
    const { tasks, claims, worktrees, worktreePath } = await taskFixture();
    claims.finishClaim.mockRejectedValueOnce(new Error("release failed"));
    const input = {
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff" as const,
      validation: ["npm test: pass"],
      source_task_revision: "issue-revision-7",
    };

    await expect(tasks.finish(input)).rejects.toThrow("release failed");
    worktrees.inspect.mockResolvedValue({
      path: worktreePath,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      ...changed,
    });

    await expect(tasks.finish(input)).rejects.toMatchObject({ code: "HANDOFF_RETRY_CONFLICT" });
    expect(claims.finishClaim).toHaveBeenCalledTimes(1);
  });

  it("uses real RegistryGit and ClaimService evidence for a failed Handoff release retry", async () => {
    const fixture = await makeRegistryFixture();
    fixtures.push(fixture);
    const config = configFor(fixture.registryDir);
    const source = join(fixture.root, "source");
    await git(fixture.root, "init", "--initial-branch=main", source);
    await git(source, "config", "user.name", "Phase1A Test");
    await git(source, "config", "user.email", "phase1a@example.invalid");
    await writeFile(join(source, "README.md"), "# Source\n", "utf8");
    await git(source, "add", "README.md");
    await git(source, "commit", "-m", "Initial source");
    const registry = new RegistryGit(config, new ProcessRunner());
    const catalog = new Catalog(config, registry);
    const task = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: taskAlias,
      goal: "deliberately omitted from handoff",
      done_conditions: ["targeted test"],
      expected_scope: ["src/control"],
    });
    const inspection: ClaimInspection = {
      async inspect() {
        return { process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 };
      },
    };
    const actualClaims = new ClaimService(config, registry, catalog, inspection);
    const worktrees = new WorktreeManager(config);
    let failFirstRelease = true;
    const claims = {
      claimTask: actualClaims.claimTask.bind(actualClaims),
      assertOwner: actualClaims.assertOwner.bind(actualClaims),
      recoverClaim: actualClaims.recoverClaim.bind(actualClaims),
      finishClaim: async (...args: Parameters<ClaimService["finishClaim"]>) => {
        if (failFirstRelease) {
          failFirstRelease = false;
          throw new Error("injected release failure");
        }
        return actualClaims.finishClaim(...args);
      },
    };
    const timestamps = [
      new Date("2026-08-13T12:36:56.789Z"),
      new Date("2026-08-13T12:37:56.789Z"),
    ];
    const tasks = new TaskService(config, claims, worktrees, registry, () => timestamps.shift() ?? new Date("2026-08-13T12:38:56.789Z"));
    const started = await tasks.start({
      task_id: task.id,
      task_alias: taskAlias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-integration",
      repository_path: source,
    });
    const input = {
      task_id: task.id,
      claim_id: started.claim.claim_id,
      status: "handoff" as const,
      validation: ["npm test: pass"],
      source_task_revision: "temporary-v1",
      progress: "Durable Registry copy is the retry source.",
    };
    const pointer = `handoffs/${task.id}/${started.claim.claim_id}.md`;

    await expect(tasks.finish(input)).rejects.toThrow("injected release failure");
    await registry.assertHeadRegularFile(pointer);
    const committed = await registry.readHeadRegularFile(pointer);
    await expect(tasks.finish(input)).resolves.toMatchObject({ history: { handoff_pointer: pointer } });

    expect(await registry.readHeadRegularFile(pointer)).toBe(committed);
    expect(await actualClaims.getActive(task.id)).toBeUndefined();
    expect(timestamps).toHaveLength(1);
  });

  it("records only stable create-failure codes in real Registry Claim history", async () => {
    const fixture = await makeRegistryFixture();
    fixtures.push(fixture);
    const config = configFor(fixture.registryDir);
    const registry = new RegistryGit(config, new ProcessRunner());
    const catalog = new Catalog(config, registry);
    const task = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: taskAlias,
      goal: "temporary task",
      done_conditions: ["test"],
      expected_scope: ["src/control"],
    });
    const inspection: ClaimInspection = {
      async inspect() {
        return { process_exists: false, worktree_mapped: false, dirty: false, ahead: 0 };
      },
    };
    const actualClaims = new ClaimService(config, registry, catalog, inspection);
    let capturedClaimId = "";
    const claims = {
      claimTask: async (...args: Parameters<ClaimService["claimTask"]>) => {
        const created = await actualClaims.claimTask(...args);
        capturedClaimId = created.claim_id;
        return created;
      },
      assertOwner: actualClaims.assertOwner.bind(actualClaims),
      recoverClaim: actualClaims.recoverClaim.bind(actualClaims),
      finishClaim: actualClaims.finishClaim.bind(actualClaims),
    };
    const secretPath = "/srv/jhw/private/project-secret";
    const failedWorktrees = {
      createOrReuse: async () => {
        throw new ControlError("COMMAND_FAILED", `git failed at ${secretPath}`, { path: secretPath });
      },
      inspect: vi.fn(),
      removeIfSafe: vi.fn(),
    };
    const tasks = new TaskService(config, claims, failedWorktrees, registry);

    await expect(tasks.start({
      task_id: task.id,
      task_alias: taskAlias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-history",
      repository_path: secretPath,
    })).rejects.toMatchObject({ code: "COMMAND_FAILED" });

    const history = await readFile(join(fixture.registryDir, "claims", "history", "2026", task.id, `${capturedClaimId}.yaml`), "utf8");
    expect(history).toContain("worktree_create_failed:COMMAND_FAILED");
    expect(history).not.toContain(secretPath);
    expect(history).not.toContain("git failed at");
  });

  it.each(["completed", "abandoned"] as const)("releases a %s Claim before attempting worktree cleanup", async (status) => {
    const { tasks, claims, worktrees } = await taskFixture();

    await tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status,
      validation: ["npm test: pass"],
    });

    expect(claims.finishClaim).toHaveBeenCalledBefore(worktrees.removeIfSafe);
  });

  it("fails closed for a worktree .ai symlink before writing or releasing a Claim", async () => {
    const { tasks, claims, worktreePath, fixture } = await taskFixture();
    const externalDirectory = await mkdtemp(join(tmpdir(), "jhw-external-handoff-"));
    localPaths.push(externalDirectory);
    await symlink(externalDirectory, join(worktreePath, ".ai"));

    await expect(
      tasks.finish({
        task_id: TASK_ID,
        claim_id: CLAIM_ID,
        status: "handoff",
        validation: ["npm test: pass"],
        source_task_revision: "issue-revision-7",
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_HANDOFF_PATH" });

    expect(claims.finishClaim).not.toHaveBeenCalled();
    await expect(readFile(join(externalDirectory, "handoff.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(fixture.registryDir, "handoffs", TASK_ID, `${CLAIM_ID}.md`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds Unicode Handoffs without losing required headings or task lifecycle fields", () => {
    const handoff = buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "issue-revision-7",
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
      progress: "😀".repeat(20_000),
      validation: ["npm test: pass"],
      failures: "None.",
      next_step: "Continue.",
      related_adr_and_evidence: "ADR-1",
    });

    expect(Buffer.byteLength(handoff, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(handoff).toContain("## Progress Since Last Checkpoint");
    expect(handoff).toContain("## Related ADR and Evidence");
    expect(handoff).not.toContain("goal:");
    expect(handoff).not.toContain("done_conditions:");
    expect(handoff.endsWith("\ud83d")).toBe(false);
  });

  it("caps a Handoff at 12 KiB when every permitted section is large", () => {
    const huge = "x".repeat(100_000);
    const handoff = buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "issue-revision-7",
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
      progress: huge,
      git_state: huge,
      validation: huge,
      failures: huge,
      next_step: huge,
      related_adr_and_evidence: huge,
    });

    expect(Buffer.byteLength(handoff, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it("renders hostile section payloads as literal text under exactly six approved headings", () => {
    const handoff = buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "issue-revision-7",
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
      progress: "ok\r## Goal\r\n   ### Goal\nsetext\n---\n```md\n# fenced\n```\n<div>html</div>",
    });

    expect(handoff.match(/^## /gm)).toHaveLength(6);
    expect(handoff).toContain("    ok\n    ## Goal\n       ### Goal\n    setext\n    ---\n    ```md");
    expect(handoff).not.toMatch(/^ {0,3}## Goal$/m);
    expect(handoff).not.toMatch(/^ {0,3}### Goal$/m);
    expect(handoff).not.toMatch(/^ {0,3}<div>/m);
  });
});
