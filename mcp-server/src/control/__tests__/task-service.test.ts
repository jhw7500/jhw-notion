import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertValidHandoff, buildHandoff, parseHandoffMetadata, parseHandoffSections, writeWorktreeHandoff } from "../handoff.js";
import { Catalog } from "../catalog.js";
import { ClaimService, type ClaimInspection } from "../claim-service.js";
import { ControlError } from "../errors.js";
import { ProcessRunner } from "../process.js";
import { RegistryGit } from "../registry-git.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "../sensitive-data.js";
import { TaskService } from "../task-service.js";
import { WorktreeManager, worktreePlan } from "../worktree.js";
import { configFor, git, isolatedRegistryGit, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

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
  source_task_revision: "issue-revision-7",
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

async function taskFixture(sensitiveData?: SensitiveDataPolicy): Promise<{
  tasks: TaskService;
  claims: {
    claimTask: ReturnType<typeof vi.fn>;
    assertOwner: ReturnType<typeof vi.fn>;
    finishClaim: ReturnType<typeof vi.fn>;
    recoverClaim: ReturnType<typeof vi.fn>;
    getActive: ReturnType<typeof vi.fn>;
    getClaimHistory: ReturnType<typeof vi.fn>;
    latestClaimHistory: ReturnType<typeof vi.fn>;
    latestHandoffHistory: ReturnType<typeof vi.fn>;
  };
  worktrees: {
    createOrReuse: ReturnType<typeof vi.fn>;
    assertStartReady: ReturnType<typeof vi.fn>;
    cleanupReleased: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
    removeIfSafe: ReturnType<typeof vi.fn>;
    assertTakeoverEligible: ReturnType<typeof vi.fn>;
    rebindTakeover: ReturnType<typeof vi.fn>;
  };
  registry: {
    transact: ReturnType<typeof vi.fn>;
    assertHeadRegularFile: ReturnType<typeof vi.fn>;
    readHeadRegularBlob: ReturnType<typeof vi.fn>;
    listHeadDirectoryEntries: ReturnType<typeof vi.fn>;
    readHeadRegularFile: ReturnType<typeof vi.fn>;
  };
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
    getActive: vi.fn().mockResolvedValue(undefined),
    getClaimHistory: vi.fn(),
    latestClaimHistory: vi.fn().mockRejectedValue(new ControlError("CLAIM_HISTORY_NOT_FOUND", "no history")),
    latestHandoffHistory: vi.fn().mockRejectedValue(new ControlError("HANDOFF_NOT_FOUND", "no handoff")),
  };
  const worktrees = {
    createOrReuse: vi.fn().mockResolvedValue({
      path: worktreePath,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      reused: false,
    }),
    assertStartReady: vi.fn().mockResolvedValue(undefined),
    cleanupReleased: vi.fn().mockResolvedValue({ removed: true, recovered: true, lifecycle: "removed" }),
    inspect: vi.fn().mockResolvedValue({
      path: worktreePath,
      repository_path: startInput.repository_path,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      head_sha: "0123456789abcdef",
      dirty: false,
      dirty_files: [],
      ahead: 0,
      behind: 0,
    }),
    removeIfSafe: vi.fn().mockResolvedValue({ removed: true }),
    assertForceEndEligible: vi.fn().mockResolvedValue(undefined),
    assertTakeoverEligible: vi.fn().mockResolvedValue(undefined),
    rebindTakeover: vi.fn().mockResolvedValue({ changed: true }),
  };
  const registry = {
    transact: vi.fn(async (_message: string, mutate: () => Promise<{ paths: readonly string[] }>) => {
      await mutate();
      return { commit: "registry-commit", changed: true };
    }),
    assertHeadRegularFile: vi.fn(async (relativePath: string) => {
      try {
        await readFile(join(fixture.registryDir, relativePath));
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
          throw new ControlError("HANDOFF_MISSING", "missing");
        }
        throw cause;
      }
    }),
    readHeadRegularBlob: vi.fn(async (relativePath: string) => {
      try {
        return await readFile(join(fixture.registryDir, relativePath));
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
          throw new ControlError("HANDOFF_MISSING", "missing");
        }
        throw cause;
      }
    }),
    listHeadDirectoryEntries: vi.fn(async () => []),
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
    tasks: new TaskService(
      configFor(fixture.registryDir), claims, worktrees, registry,
      () => new Date("2026-08-13T12:36:56.789Z"), sensitiveData,
    ),
    claims,
    worktrees,
    registry,
    worktreePath,
    fixture,
  };
}

describe("TaskService", () => {
  it("rejects an incoherent completed release before reading or mutating authority", async () => {
    const { tasks, claims, worktrees, registry } = await taskFixture();

    await expect(tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "completed",
      validation: ["targeted tests pass"],
    })).rejects.toMatchObject({ code: "INVALID_FINISH_OUTCOME" });

    expect(claims.assertOwner).not.toHaveBeenCalled();
    expect(worktrees.inspect).not.toHaveBeenCalled();
    expect(registry.transact).not.toHaveBeenCalled();
    expect(claims.finishClaim).not.toHaveBeenCalled();
  });

  it("rejects oversized validation before publishing either Handoff copy", async () => {
    const { tasks, claims, worktrees, registry, worktreePath } = await taskFixture();

    await expect(tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["v".repeat(65 * 1024)],
    })).rejects.toMatchObject({ code: "INVALID_FINISH_OUTCOME" });

    expect(claims.assertOwner).not.toHaveBeenCalled();
    expect(worktrees.inspect).not.toHaveBeenCalled();
    expect(registry.transact).not.toHaveBeenCalled();
    expect(claims.finishClaim).not.toHaveBeenCalled();
    await expect(readFile(join(worktreePath, ".ai", "handoff.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the trusted source-checkout path in Handoff fields before persistence or release", async () => {
    const { tasks, claims, registry, worktreePath } = await taskFixture();

    const error = await tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      progress: `do not persist ${startInput.repository_path}`,
      validation: ["targeted tests pass"],
    }).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(startInput.repository_path);
    expect(registry.transact).not.toHaveBeenCalled();
    expect(claims.finishClaim).not.toHaveBeenCalled();
    await expect(readFile(join(worktreePath, ".ai", "handoff.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "continue from /tmp/private-note",
    "continue from C:\\private\\note.txt",
    "continue from file:///tmp/private-note",
  ])("rejects absolute-path Handoff content before any mutation: %s", async (progress) => {
    const { tasks, claims, worktrees, registry, worktreePath } = await taskFixture();

    await expect(tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      progress,
      validation: ["targeted tests pass"],
    })).rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });

    expect(claims.assertOwner).not.toHaveBeenCalled();
    expect(worktrees.inspect).not.toHaveBeenCalled();
    expect(registry.transact).not.toHaveBeenCalled();
    expect(claims.finishClaim).not.toHaveBeenCalled();
    await expect(readFile(join(worktreePath, ".ai", "handoff.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects protected finish content before reading or mutating Claim/worktree state", async () => {
    const secret = "unmistakably-fake-task-token";
    const { tasks, claims, worktrees } = await taskFixture(createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }));

    const error = await tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      progress: `contains ${secret}`,
      validation: ["targeted tests pass"],
    }).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(claims.assertOwner).not.toHaveBeenCalled();
    expect(worktrees.inspect).not.toHaveBeenCalled();
  });

  it("rejects protected content at the standalone Handoff builder boundary", () => {
    const secret = "unmistakably-fake-handoff-token";
    const policy = createSensitiveDataPolicy({ FAKE_API_TOKEN: secret });
    expect(() => buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "revision-1",
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:34:56.789Z",
      progress: secret,
    }, policy)).toThrowError(expect.objectContaining({ code: "SENSITIVE_DATA_REJECTED" }));
  });

  it("checks local cleanup readiness before creating Registry ownership", async () => {
    const { tasks, claims, worktrees } = await taskFixture();

    await tasks.start(startInput);

    expect(claims.getActive).toHaveBeenCalledWith(startInput.task_id);
    expect(claims.getActive).toHaveBeenCalledBefore(worktrees.assertStartReady);
    expect(worktrees.assertStartReady).toHaveBeenCalledWith(startInput.task_id, startInput.task_alias, undefined);
    expect(worktrees.assertStartReady).toHaveBeenCalledBefore(claims.claimTask);
  });

  it("passes the exact current Claim to the cleanup barrier without creating successor ownership", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    claims.getActive.mockResolvedValueOnce(activeClaim);
    worktrees.assertStartReady.mockRejectedValueOnce(new ControlError("CLAIM_ALREADY_ACTIVE", "still active"));

    await expect(tasks.start(startInput)).rejects.toMatchObject({ code: "CLAIM_ALREADY_ACTIVE" });

    expect(worktrees.assertStartReady).toHaveBeenCalledWith(startInput.task_id, startInput.task_alias, {
      claim_id: activeClaim.claim_id,
      worktree_ref: activeClaim.worktree_ref,
      disposition: "active",
    });
    expect(claims.claimTask).not.toHaveBeenCalled();
  });

  it("does not treat completed Claim history as reusable worktree authority", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    claims.latestClaimHistory.mockResolvedValueOnce({
      ...activeClaim,
      released_at: "2026-08-13T12:35:56.789Z",
      status: "completed",
      outcome: "done",
      head_sha: "a".repeat(40),
      validation_summary: "tests: pass",
    });

    worktrees.assertStartReady.mockRejectedValueOnce(new ControlError("WORKTREE_CLEANUP_REQUIRED", "cleanup"));
    await expect(tasks.start(startInput)).rejects.toMatchObject({ code: "WORKTREE_CLEANUP_REQUIRED" });

    expect(worktrees.assertStartReady).toHaveBeenCalledWith(startInput.task_id, startInput.task_alias, undefined);
    expect(claims.claimTask).not.toHaveBeenCalled();
  });

  it("reuses only the exact force-ended generation under the resumable lifecycle rule", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    claims.latestClaimHistory.mockResolvedValueOnce({
      ...activeClaim,
      released_at: "2026-08-13T12:35:56.789Z",
      status: "force-ended",
    });

    await tasks.start(startInput);

    expect(worktrees.assertStartReady).toHaveBeenCalledWith(startInput.task_id, startInput.task_alias, {
      claim_id: activeClaim.claim_id,
      worktree_ref: activeClaim.worktree_ref,
      disposition: "force-ended",
    });
  });

  it("reconciles a directly linked successor after crashing between Claim commit and local rebind", async () => {
    const { claims, worktrees, registry, fixture } = await taskFixture();
    const predecessor = {
      ...activeClaim,
      released_at: "2026-08-13T12:35:56.789Z",
      status: "handoff" as const,
      handoff_path: `handoffs/${TASK_ID}/${CLAIM_ID}.md`,
    };
    const successor = {
      ...activeClaim,
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac",
      predecessor_claim_id: CLAIM_ID,
      started_at: "2026-08-13T12:36:56.789Z",
    };
    claims.latestClaimHistory.mockResolvedValue(predecessor);
    claims.claimTask.mockResolvedValue(successor);
    const Constructor = TaskService as unknown as new (
      config: ReturnType<typeof configFor>,
      claimPort: typeof claims,
      worktreePort: typeof worktrees,
      registryPort: typeof registry,
      now?: () => Date,
      sensitiveData?: SensitiveDataPolicy,
      hooks?: { afterClaim?: () => void | Promise<void> },
    ) => TaskService;
    const crashed = new Constructor(
      configFor(fixture.registryDir), claims, worktrees, registry, undefined, undefined,
      { afterClaim: () => { throw new Error("injected post-Claim crash"); } },
    );

    await expect(crashed.start(startInput)).rejects.toThrow("injected post-Claim crash");
    expect(worktrees.createOrReuse).not.toHaveBeenCalled();

    claims.getActive.mockResolvedValue(successor);
    claims.assertOwner.mockResolvedValue(successor);
    const restarted = new TaskService(configFor(fixture.registryDir), claims, worktrees, registry);
    await expect(restarted.start(startInput)).resolves.toMatchObject({ claim: successor });

    expect(claims.claimTask).toHaveBeenCalledTimes(1);
    expect(worktrees.assertStartReady).toHaveBeenLastCalledWith(startInput.task_id, startInput.task_alias, {
      claim_id: predecessor.claim_id,
      successor_claim_id: successor.claim_id,
      worktree_ref: predecessor.worktree_ref,
      disposition: "handoff",
    });
    expect(worktrees.createOrReuse).toHaveBeenCalledWith(successor, startInput.repository_path);
  });

  it("claims before creating a worktree and abandons the Claim if creation fails", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    worktrees.createOrReuse.mockRejectedValue(new Error("worktree failed"));

    const error = await tasks.start(startInput).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "TASK_START_FAILED", message: "Worktree allocation failed" });
    expect(JSON.stringify(error)).not.toContain("worktree failed");

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

  it("does not abandon a pre-existing same-session Claim when retry allocation fails", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    claims.getActive.mockResolvedValueOnce(activeClaim);
    worktrees.createOrReuse.mockRejectedValueOnce(
      new ControlError("WORKTREE_MAPPING_MISMATCH", "injected existing mapping failure"),
    );

    await expect(tasks.start(startInput)).rejects.toMatchObject({
      code: "WORKTREE_MAPPING_MISMATCH",
      details: { task_id: activeClaim.task_id, claim_id: activeClaim.claim_id, claim_state: "active" },
    });

    expect(claims.claimTask).not.toHaveBeenCalled();
    expect(claims.finishClaim).not.toHaveBeenCalled();
  });

  it("prevalidates a fresh takeover before Registry rotation and then rebinds its direct successor", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    const successor = { ...activeClaim, claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac", session_id: "codex-new" };
    const history = {
      ...activeClaim,
      released_at: "2026-08-13T12:35:56.789Z",
      status: "taken-over" as const,
      successor_claim_id: successor.claim_id,
    };
    claims.recoverClaim.mockResolvedValue({ kind: "takeover", active: successor, history });

    await expect(tasks.recover({
      task_id: activeClaim.task_id,
      claim_id: activeClaim.claim_id,
      action: { kind: "takeover", session_id: successor.session_id },
    })).resolves.toEqual({ kind: "takeover", active: successor, history });

    expect(claims.assertOwner).toHaveBeenCalledBefore(worktrees.assertTakeoverEligible);
    expect(worktrees.assertTakeoverEligible).toHaveBeenCalledBefore(claims.recoverClaim);
    expect(claims.recoverClaim).toHaveBeenCalledBefore(worktrees.rebindTakeover);
    expect(worktrees.assertTakeoverEligible).toHaveBeenCalledWith(activeClaim);
    expect(worktrees.rebindTakeover).toHaveBeenCalledWith(history, successor);
  });

  it("reconciles only an exact ownership mismatch through the linked takeover retry", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    const successor = { ...activeClaim, claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac", session_id: "codex-new" };
    const history = {
      ...activeClaim,
      released_at: "2026-08-13T12:35:56.789Z",
      status: "taken-over" as const,
      successor_claim_id: successor.claim_id,
    };
    claims.assertOwner.mockRejectedValueOnce(new ControlError("CLAIM_MISMATCH", "already rotated"));
    claims.recoverClaim.mockResolvedValue({ kind: "takeover", active: successor, history });

    await expect(tasks.recover({
      task_id: activeClaim.task_id,
      claim_id: activeClaim.claim_id,
      action: { kind: "takeover", session_id: successor.session_id },
    })).resolves.toMatchObject({ kind: "takeover", active: successor });

    expect(worktrees.assertTakeoverEligible).not.toHaveBeenCalled();
    expect(claims.recoverClaim).toHaveBeenCalledTimes(1);
    expect(worktrees.rebindTakeover).toHaveBeenCalledWith(history, successor);
  });

  it.each(["CLAIM_NOT_FOUND", "REGISTRY_CORRUPT", "HOST_MISMATCH"])(
    "does not reconcile a takeover after %s ownership failure",
    async (code) => {
      const { tasks, claims, worktrees } = await taskFixture();
      claims.assertOwner.mockRejectedValueOnce(new ControlError(code, "stop"));

      await expect(tasks.recover({
        task_id: activeClaim.task_id,
        claim_id: activeClaim.claim_id,
        action: { kind: "takeover", session_id: "codex-new" },
      })).rejects.toMatchObject({ code });

      expect(claims.recoverClaim).not.toHaveBeenCalled();
      expect(worktrees.rebindTakeover).not.toHaveBeenCalled();
    },
  );

  it("does not rotate Registry ownership when takeover worktree eligibility fails", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    worktrees.assertTakeoverEligible.mockRejectedValueOnce(new ControlError("WORKTREE_LIFECYCLE_MISMATCH", "pending"));

    await expect(tasks.recover({
      task_id: activeClaim.task_id,
      claim_id: activeClaim.claim_id,
      action: { kind: "takeover", session_id: "codex-new" },
    })).rejects.toMatchObject({ code: "WORKTREE_LIFECYCLE_MISMATCH" });

    expect(claims.recoverClaim).not.toHaveBeenCalled();
  });

  it("does not force-end Registry ownership while local creation still needs recovery", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    worktrees.assertForceEndEligible.mockRejectedValueOnce(
      new ControlError("WORKTREE_CREATE_PENDING", "creation recovery required"),
    );

    await expect(tasks.recover({
      task_id: activeClaim.task_id,
      claim_id: activeClaim.claim_id,
      action: { kind: "force-end" },
    })).rejects.toMatchObject({ code: "WORKTREE_CREATE_PENDING" });

    expect(claims.recoverClaim).not.toHaveBeenCalled();
  });

  it.each(["status", "force-end"] as const)("preserves direct %s recovery without takeover worktree mutation", async (kind) => {
    const { tasks, claims, worktrees } = await taskFixture();
    claims.recoverClaim.mockResolvedValue({ kind });

    await tasks.recover({
      task_id: activeClaim.task_id,
      claim_id: activeClaim.claim_id,
      action: { kind },
    });

    expect(worktrees.assertTakeoverEligible).not.toHaveBeenCalled();
    expect(worktrees.rebindTakeover).not.toHaveBeenCalled();
  });

  it("recovers cleanup from exact released history only when no active successor exists", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    const history = {
      ...activeClaim,
      released_at: "2026-08-13T12:35:56.789Z",
      status: "completed" as const,
      outcome: "done",
      head_sha: "a".repeat(40),
      validation_summary: "tests: pass",
    };
    claims.getClaimHistory.mockResolvedValue(history);

    await expect(tasks.recover({
      task_id: activeClaim.task_id,
      claim_id: activeClaim.claim_id,
      action: { kind: "cleanup" },
    })).resolves.toEqual({
      kind: "cleanup",
      history,
      worktree: { removed: true, recovered: true, lifecycle: "removed" },
    });
    expect(claims.getActive).toHaveBeenCalledBefore(worktrees.cleanupReleased);
    expect(worktrees.cleanupReleased).toHaveBeenCalledWith(history);

    claims.getActive.mockResolvedValueOnce({ ...activeClaim, claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac" });
    await expect(tasks.recover({
      task_id: activeClaim.task_id,
      claim_id: activeClaim.claim_id,
      action: { kind: "cleanup" },
    })).rejects.toMatchObject({ code: "WORKTREE_ACTIVE_SUCCESSOR" });
    expect(worktrees.cleanupReleased).toHaveBeenCalledTimes(1);
  });

  it("blocks a successor after Claim release crashes before local cleanup, then resumes exact cleanup", async () => {
    const fixture = await makeRegistryFixture();
    fixtures.push(fixture);
    const config = configFor(fixture.registryDir);
    const source = join(fixture.root, "source-release-crash");
    await git(fixture.root, "init", "--initial-branch=main", source);
    await git(source, "config", "user.name", "Phase1A Test");
    await git(source, "config", "user.email", "phase1a@example.invalid");
    await writeFile(join(source, "README.md"), "# Source\n", "utf8");
    await git(source, "add", "README.md");
    await git(source, "commit", "-m", "Initial source");
    const registry = isolatedRegistryGit(config, new ProcessRunner());
    const catalog = new Catalog(config, registry);
    await catalog.registerRepository({ repo_id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" });
    const alias = `${taskAlias}-release-crash`;
    const task = await catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias,
      goal: "recover a released worktree", done_conditions: ["cleanup"], expected_scope: ["src/control"],
    });
    const claims = new ClaimService(config, registry, catalog, {
      async inspect() { return { process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 }; },
    });
    const worktrees = new WorktreeManager(config);
    let crashAfterRelease = true;
    const taskWorktrees = {
      assertStartReady: worktrees.assertStartReady.bind(worktrees),
      createOrReuse: worktrees.createOrReuse.bind(worktrees),
      inspect: worktrees.inspect.bind(worktrees),
      removeIfSafe: async (...args: Parameters<WorktreeManager["removeIfSafe"]>) => {
        if (crashAfterRelease) {
          crashAfterRelease = false;
          throw new Error("injected cleanup crash");
        }
        return worktrees.removeIfSafe(...args);
      },
      assertTakeoverEligible: worktrees.assertTakeoverEligible.bind(worktrees),
      rebindTakeover: worktrees.rebindTakeover.bind(worktrees),
      cleanupReleased: worktrees.cleanupReleased.bind(worktrees),
    };
    const tasks = new TaskService(config, claims, taskWorktrees, registry);
    const input = {
      task_id: task.id, task_alias: alias, project_id: task.project_id, repo_id: task.repo_id,
      session_id: "codex-release-crash", repository_path: source,
    };
    const started = await tasks.start(input);

    const released = await tasks.finish({
      task_id: task.id, claim_id: started.claim.claim_id, status: "abandoned", validation: ["stopped safely"],
    });
    expect(released).toMatchObject({ worktree_removed: false, cleanup_error: "WORKTREE_CLEANUP_FAILED" });
    expect(JSON.stringify(released)).not.toContain("injected cleanup crash");
    await expect(claims.getActive(task.id)).resolves.toBeUndefined();
    await expect(tasks.start({ ...input, session_id: "codex-successor" })).rejects.toMatchObject({
      code: "WORKTREE_CLEANUP_REQUIRED",
    });
    await expect(claims.getActive(task.id)).resolves.toBeUndefined();

    await expect(tasks.recover({
      task_id: task.id, claim_id: started.claim.claim_id, action: { kind: "cleanup" },
    })).resolves.toMatchObject({ kind: "cleanup", worktree: { removed: true, lifecycle: "removed" } });
    await expect(tasks.start({ ...input, session_id: "codex-after-cleanup" })).resolves.toMatchObject({ reused: false });
  });

  it("reports retained Claim coordinates after a worktree creation failure", async () => {
    const { tasks, claims, worktrees } = await taskFixture();
    const privatePath = "/private/worktree";
    worktrees.createOrReuse.mockRejectedValue(new ControlError("COMMAND_FAILED", `git failed at ${privatePath}`, { path: privatePath }));
    claims.finishClaim.mockRejectedValueOnce(new Error("archive failed"));

    const failure = await tasks.start(startInput).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      code: "COMMAND_FAILED",
      details: { task_id: TASK_ID, claim_id: CLAIM_ID, claim_state: "active" },
    });
    expect(JSON.stringify(failure)).not.toContain(privatePath);
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

  it("derives Handoff source revision from the active Claim and rejects caller drift", async () => {
    const { tasks, claims, fixture } = await taskFixture();

    await expect(tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["npm test: pass"],
    })).resolves.toMatchObject({ history: { handoff_pointer: `handoffs/${TASK_ID}/${CLAIM_ID}.md` } });
    expect(await readFile(join(fixture.registryDir, "handoffs", TASK_ID, `${CLAIM_ID}.md`), "utf8"))
      .toContain("source_task_revision: issue-revision-7");

    await expect(tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["npm test: pass"],
      source_task_revision: "caller-forged-revision",
    })).rejects.toMatchObject({ code: "SOURCE_REVISION_MISMATCH" });
    expect(claims.finishClaim).toHaveBeenCalledTimes(1);
  });

  it("retrieves only an exact committed Handoff bound to Claim history", async () => {
    const { tasks, claims, fixture } = await taskFixture();
    const relativePath = `handoffs/${TASK_ID}/${CLAIM_ID}.md`;
    const content = buildHandoff({
      task_id: TASK_ID,
      source_task_revision: activeClaim.source_task_revision,
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
      progress: "bounded progress",
    });
    await mkdir(join(fixture.registryDir, "handoffs", TASK_ID), { recursive: true });
    await writeFile(join(fixture.registryDir, relativePath), content, "utf8");
    claims.getClaimHistory.mockResolvedValue({
      ...activeClaim,
      released_at: "2026-08-13T12:36:56.789Z",
      status: "handoff",
      handoff_path: relativePath,
    });

    await expect(tasks.handoff(TASK_ID, CLAIM_ID)).resolves.toMatchObject({
      handoff_pointer: relativePath,
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      source_task_revision: activeClaim.source_task_revision,
      sections: { "Progress Since Last Checkpoint": "bounded progress" },
    });
    expect(claims.getClaimHistory).toHaveBeenCalledWith(TASK_ID, CLAIM_ID);
    expect(claims.latestHandoffHistory).not.toHaveBeenCalled();
  });

  it("rejects an absolute host path restored from a committed Handoff", async () => {
    const { tasks, claims, fixture } = await taskFixture();
    const relativePath = `handoffs/${TASK_ID}/${CLAIM_ID}.md`;
    const content = buildHandoff({
      task_id: TASK_ID,
      source_task_revision: activeClaim.source_task_revision,
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
      progress: "safe placeholder",
    }).replace("safe placeholder", "Continue from /srv/private/source-checkout/src/control/task-service.ts");
    await mkdir(join(fixture.registryDir, "handoffs", TASK_ID), { recursive: true });
    await writeFile(join(fixture.registryDir, relativePath), content, "utf8");
    claims.getClaimHistory.mockResolvedValue({
      ...activeClaim,
      released_at: "2026-08-13T12:36:56.789Z",
      status: "handoff",
      handoff_path: relativePath,
    });

    await expect(tasks.handoff(TASK_ID, CLAIM_ID)).rejects.toMatchObject({
      code: "SENSITIVE_DATA_REJECTED",
    });
  });

  it("rejects a committed Handoff with bytes outside the fixed schema", async () => {
    const { tasks, claims, fixture } = await taskFixture();
    const relativePath = `handoffs/${TASK_ID}/${CLAIM_ID}.md`;
    const valid = buildHandoff({
      task_id: TASK_ID,
      source_task_revision: activeClaim.source_task_revision,
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
    });
    const invalid = valid.replace(
      "    None recorded.\n## Git State",
      "    safe\r## ATTACKER-CONTROLLED-HEADING\n## Git State",
    );
    await mkdir(join(fixture.registryDir, "handoffs", TASK_ID), { recursive: true });
    await writeFile(join(fixture.registryDir, relativePath), invalid, "utf8");
    claims.getClaimHistory.mockResolvedValue({
      ...activeClaim,
      released_at: "2026-08-13T12:36:56.789Z",
      status: "handoff",
      handoff_path: relativePath,
    });

    await expect(tasks.handoff(TASK_ID, CLAIM_ID)).rejects.toMatchObject({ code: "INVALID_HANDOFF_EVIDENCE" });
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

  it("rejects a multi-link Registry Handoff destination before release", async () => {
    const { tasks, claims, fixture } = await taskFixture();
    const pointer = join(fixture.registryDir, "handoffs", TASK_ID, `${CLAIM_ID}.md`);
    const outside = join(fixture.root, "outside-handoff.md");
    await mkdir(join(fixture.registryDir, "handoffs", TASK_ID), { recursive: true });
    await writeFile(outside, "outside sentinel\n", "utf8");
    await link(outside, pointer);

    await expect(tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["npm test: pass"],
      source_task_revision: "issue-revision-7",
    })).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

    expect(await readFile(outside, "utf8")).toBe("outside sentinel\n");
    expect(claims.finishClaim).not.toHaveBeenCalled();
  });

  it("rejects duplicate pre-existing local Handoff entries before generating evidence", async () => {
    const { tasks, claims, worktrees, registry, worktreePath } = await taskFixture();
    worktrees.inspect.mockResolvedValue({
      path: worktreePath,
      repository_path: startInput.repository_path,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      head_sha: "0123456789abcdef",
      dirty: true,
      dirty_files: [".ai/handoff.md", ".ai/handoff.md"],
      ahead: 0,
      behind: 0,
    });

    const failure = await tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["npm test: pass"],
      source_task_revision: "issue-revision-7",
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      code: "INVALID_WORKTREE_INSPECTION",
      message: "Worktree inspection contains duplicate dirty-file entries",
      details: { reason: "duplicate_dirty_files" },
    });
    expect(JSON.stringify(failure)).not.toContain(".ai/handoff.md");
    expect(registry.transact).not.toHaveBeenCalled();
    expect(claims.finishClaim).not.toHaveBeenCalled();
  });

  it("rejects a duplicate local Handoff entry introduced only on retry", async () => {
    const { tasks, claims, worktrees, worktreePath } = await taskFixture();
    claims.finishClaim.mockRejectedValueOnce(new Error("release failed"));
    worktrees.inspect.mockResolvedValueOnce({
      path: worktreePath,
      repository_path: startInput.repository_path,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      head_sha: "0123456789abcdef",
      dirty: true,
      dirty_files: [".ai/handoff.md"],
      ahead: 0,
      behind: 0,
    });
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
      repository_path: startInput.repository_path,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      head_sha: "0123456789abcdef",
      dirty: true,
      dirty_files: [".ai/handoff.md", ".ai/handoff.md"],
      ahead: 0,
      behind: 0,
    });

    await expect(tasks.finish(input)).rejects.toMatchObject({
      code: "INVALID_WORKTREE_INSPECTION",
      details: { reason: "duplicate_dirty_files" },
    });
    expect(claims.finishClaim).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate unrelated dirty paths without exposing the path", async () => {
    const { tasks, claims, worktrees, registry, worktreePath } = await taskFixture();
    const privatePath = "src/customer-secret.ts";
    worktrees.inspect.mockResolvedValue({
      path: worktreePath,
      repository_path: startInput.repository_path,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      head_sha: "0123456789abcdef",
      dirty: true,
      dirty_files: [privatePath, privatePath],
      ahead: 0,
      behind: 0,
    });

    const failure = await tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["npm test: pass"],
      source_task_revision: "issue-revision-7",
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      code: "INVALID_WORKTREE_INSPECTION",
      details: { reason: "duplicate_dirty_files" },
    });
    expect(JSON.stringify(failure)).not.toContain(privatePath);
    expect(registry.transact).not.toHaveBeenCalled();
    expect(claims.finishClaim).not.toHaveBeenCalled();
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
      repository_path: startInput.repository_path,
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
      repository_path: startInput.repository_path,
      worktree_ref: plan.worktree_ref,
      branch: plan.branch,
      ...changed,
    });

    await expect(tasks.finish(input)).rejects.toMatchObject({ code: "HANDOFF_RETRY_CONFLICT" });
    expect(claims.finishClaim).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a non-canonical count", "01", "0".repeat(64)],
    ["a non-hex digest", "0", "G".repeat(64)],
  ])("fails closed for committed dirty digest evidence with %s", async (_reason, dirtyCount, dirtyDigest) => {
    const { tasks, claims, fixture } = await taskFixture();
    const pointer = join(fixture.registryDir, "handoffs", TASK_ID, `${CLAIM_ID}.md`);
    await mkdir(join(fixture.registryDir, "handoffs", TASK_ID), { recursive: true });
    await writeFile(pointer, buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "issue-revision-7",
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
      git_state: [
        `branch: ${plan.branch}`,
        "head_sha: 0123456789abcdef",
        `dirty_count: ${dirtyCount}`,
        `dirty_digest: ${dirtyDigest}`,
        "ahead: 0",
        "behind: 0",
      ],
      validation: ["npm test: pass"],
    }), "utf8");

    await expect(tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["npm test: pass"],
      source_task_revision: "issue-revision-7",
    })).rejects.toMatchObject({ code: "HANDOFF_RETRY_CONFLICT" });
    expect(claims.finishClaim).not.toHaveBeenCalled();
  });

  it("accepts only safely verifiable empty legacy dirty evidence", async () => {
    const { tasks, claims, fixture } = await taskFixture();
    const pointer = join(fixture.registryDir, "handoffs", TASK_ID, `${CLAIM_ID}.md`);
    await mkdir(join(fixture.registryDir, "handoffs", TASK_ID), { recursive: true });
    await writeFile(pointer, buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "issue-revision-7",
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
      git_state: [
        `branch: ${plan.branch}`,
        "head_sha: 0123456789abcdef",
        "dirty_files: 0",
        "dirty_paths: []",
        "ahead: 0",
        "behind: 0",
      ],
      validation: ["npm test: pass"],
    }), "utf8");

    await expect(tasks.finish({
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      status: "handoff",
      validation: ["npm test: pass"],
      source_task_revision: "issue-revision-7",
    })).resolves.toMatchObject({ worktree_removed: false });
    expect(claims.finishClaim).toHaveBeenCalledTimes(1);
  });

  it("uses bounded dirty evidence for a visible .ai Handoff with long reordered paths", async () => {
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
    const registry = isolatedRegistryGit(config, new ProcessRunner());
    const catalog = new Catalog(config, registry);
    await catalog.registerRepository({ repo_id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" });
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
    let reorderInspection = false;
    const taskWorktrees = {
      assertStartReady: worktrees.assertStartReady.bind(worktrees),
      createOrReuse: worktrees.createOrReuse.bind(worktrees),
      inspect: async (...args: Parameters<WorktreeManager["inspect"]>) => {
        const current = await worktrees.inspect(...args);
        return reorderInspection ? { ...current, dirty_files: [...current.dirty_files].reverse() } : current;
      },
      removeIfSafe: worktrees.removeIfSafe.bind(worktrees),
      assertTakeoverEligible: worktrees.assertTakeoverEligible.bind(worktrees),
      rebindTakeover: worktrees.rebindTakeover.bind(worktrees),
      cleanupReleased: worktrees.cleanupReleased.bind(worktrees),
    };
    let failFirstRelease = true;
    const claims = {
      claimTask: actualClaims.claimTask.bind(actualClaims),
      assertOwner: actualClaims.assertOwner.bind(actualClaims),
      recoverClaim: actualClaims.recoverClaim.bind(actualClaims),
      getActive: actualClaims.getActive.bind(actualClaims),
      getClaimHistory: actualClaims.getClaimHistory.bind(actualClaims),
      latestClaimHistory: actualClaims.latestClaimHistory.bind(actualClaims),
      latestHandoffHistory: actualClaims.latestHandoffHistory.bind(actualClaims),
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
    const tasks = new TaskService(config, claims, taskWorktrees, registry, () => timestamps.shift() ?? new Date("2026-08-13T12:38:56.789Z"));
    const started = await tasks.start({
      task_id: task.id,
      task_alias: taskAlias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-integration",
      repository_path: source,
    });
    const formalAlias = "jhw7500/wlan#77";
    await catalog.promoteTemporaryTask(task.id, {
      project_id: task.project_id,
      repo_id: task.repo_id,
      issue_node_id: "I_promoted_handoff",
      issue_revision: "2026-08-13T12:36:00Z",
      issue_url: "https://github.com/jhw7500/wlan/issues/77",
      alias: formalAlias,
    });
    const input = {
      task_id: task.id,
      claim_id: started.claim.claim_id,
      status: "handoff" as const,
      validation: ["npm test: pass"],
      progress: "Durable Registry copy is the retry source.",
    };
    const pointer = `handoffs/${task.id}/${started.claim.claim_id}.md`;
    const allocation = await worktrees.inspect(started.claim);
    const dirtyDirectory = join(allocation.path, "dirty");
    await mkdir(dirtyDirectory, { recursive: true });
    const dirtyCount = 48;
    await Promise.all(Array.from({ length: dirtyCount }, async (_, index) => {
      await writeFile(join(dirtyDirectory, `${String(index).padStart(3, "0")}-${"x".repeat(64)}.txt`), "dirty\n", "utf8");
    }));

    await expect(tasks.finish(input)).rejects.toThrow("injected release failure");
    await registry.assertHeadRegularFile(pointer);
    const committed = await registry.readHeadRegularFile(pointer);
    expect(committed).toContain(`dirty_count: ${dirtyCount}`);
    expect(committed).toMatch(/dirty_digest: [0-9a-f]{64}/);
    expect(committed).not.toContain("dirty_paths:");
    expect(committed).not.toContain("dirty/000-");
    expect(Buffer.byteLength(committed, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect((await worktrees.inspect(started.claim)).dirty_files).toContain(".ai/handoff.md");

    const unrelated = join(allocation.path, "unrelated-change.txt");
    await writeFile(unrelated, "unrelated\n", "utf8");
    reorderInspection = true;
    await expect(tasks.finish(input)).rejects.toMatchObject({ code: "HANDOFF_RETRY_CONFLICT" });
    await expect(actualClaims.getActive(task.id)).resolves.toMatchObject({ claim_id: started.claim.claim_id });
    await unlink(unrelated);
    await expect(tasks.finish(input)).resolves.toMatchObject({ history: { handoff_pointer: pointer } });

    expect(await registry.readHeadRegularFile(pointer)).toBe(committed);
    expect(await actualClaims.getActive(task.id)).toBeUndefined();
    expect(timestamps).toHaveLength(1);

    await expect(tasks.start({
      task_id: task.id,
      task_alias: formalAlias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-resume",
      repository_path: source,
    })).resolves.toMatchObject({ reused: true, claim: { task_alias: taskAlias } });
  });

  it("accepts an ignored .ai Handoff retry when Git exposes no local delta", async () => {
    const fixture = await makeRegistryFixture();
    fixtures.push(fixture);
    const config = configFor(fixture.registryDir);
    const source = join(fixture.root, "source-ignored-ai");
    await git(fixture.root, "init", "--initial-branch=main", source);
    await git(source, "config", "user.name", "Phase1A Test");
    await git(source, "config", "user.email", "phase1a@example.invalid");
    await writeFile(join(source, ".gitignore"), ".ai/\n", "utf8");
    await writeFile(join(source, "README.md"), "# Source\n", "utf8");
    await git(source, "add", ".gitignore", "README.md");
    await git(source, "commit", "-m", "Ignore local AI handoffs");
    const registry = isolatedRegistryGit(config, new ProcessRunner());
    const catalog = new Catalog(config, registry);
    await catalog.registerRepository({ repo_id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" });
    const task = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: `${taskAlias}-ignored`,
      goal: "temporary ignored handoff",
      done_conditions: ["retry"],
      expected_scope: ["src/control"],
    });
    const actualClaims = new ClaimService(config, registry, catalog, {
      async inspect() {
        return { process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 };
      },
    });
    const worktrees = new WorktreeManager(config);
    let failFirstRelease = true;
    const claims = {
      claimTask: actualClaims.claimTask.bind(actualClaims),
      assertOwner: actualClaims.assertOwner.bind(actualClaims),
      recoverClaim: actualClaims.recoverClaim.bind(actualClaims),
      getActive: actualClaims.getActive.bind(actualClaims),
      getClaimHistory: actualClaims.getClaimHistory.bind(actualClaims),
      latestClaimHistory: actualClaims.latestClaimHistory.bind(actualClaims),
      latestHandoffHistory: actualClaims.latestHandoffHistory.bind(actualClaims),
      finishClaim: async (...args: Parameters<ClaimService["finishClaim"]>) => {
        if (failFirstRelease) {
          failFirstRelease = false;
          throw new Error("injected release failure");
        }
        return actualClaims.finishClaim(...args);
      },
    };
    const tasks = new TaskService(config, claims, worktrees, registry);
    const started = await tasks.start({
      task_id: task.id,
      task_alias: `${taskAlias}-ignored`,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-ignored-ai",
      repository_path: source,
    });
    const input = {
      task_id: task.id,
      claim_id: started.claim.claim_id,
      status: "handoff" as const,
      validation: ["npm test: pass"],
    };

    await expect(tasks.finish(input)).rejects.toThrow("injected release failure");
    const current = await worktrees.inspect(started.claim);
    expect(current.dirty).toBe(false);
    expect(current.dirty_files).toEqual([]);
    await expect(readFile(join(current.path, ".ai", "handoff.md"), "utf8")).resolves.toContain("# Handoff:");
    await expect(tasks.finish(input)).resolves.toMatchObject({ worktree_removed: false });
  });

  it("recovers the exact Handoff predecessor after successor rebind persistence fails", async () => {
    const fixture = await makeRegistryFixture();
    fixtures.push(fixture);
    const config = configFor(fixture.registryDir);
    const source = join(fixture.root, "source-rebind-recovery");
    await git(fixture.root, "init", "--initial-branch=main", source);
    await git(source, "config", "user.name", "Phase1A Test");
    await git(source, "config", "user.email", "phase1a@example.invalid");
    await writeFile(join(source, "README.md"), "# Source\n", "utf8");
    await git(source, "add", "README.md");
    await git(source, "commit", "-m", "Initial source");

    const registry = isolatedRegistryGit(config, new ProcessRunner());
    const catalog = new Catalog(config, registry);
    await catalog.registerRepository({ repo_id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" });
    const alias = `${taskAlias}-rebind-recovery`;
    const task = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias,
      goal: "recover an exact failed Handoff successor rebind",
      done_conditions: ["same worktree is reused"],
      expected_scope: ["src/control"],
    });
    const claims = new ClaimService(config, registry, catalog, {
      async inspect() {
        return { process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 };
      },
    });
    const initialWorktrees = new WorktreeManager(config);
    const initialTasks = new TaskService(config, claims, initialWorktrees, registry);
    const first = await initialTasks.start({
      task_id: task.id,
      task_alias: alias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-rebind-first",
      repository_path: source,
    });
    await initialTasks.finish({
      task_id: task.id,
      claim_id: first.claim.claim_id,
      status: "handoff",
      validation: ["focused test: pass"],
    });

    const failedRebindWorktrees = new WorktreeManager(config, new ProcessRunner(), {
      beforeSave: () => {
        throw new ControlError("STATE_PERSIST_FAILED", "injected successor rebind failure");
      },
    });
    const failedResume = new TaskService(config, claims, failedRebindWorktrees, registry);
    await expect(failedResume.start({
      task_id: task.id,
      task_alias: alias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-rebind-failed",
      repository_path: source,
    })).rejects.toMatchObject({ code: "STATE_PERSIST_FAILED" });
    const failedHistory = await claims.latestClaimHistory(task.id);
    expect(failedHistory).toMatchObject({
      status: "abandoned",
      outcome: "worktree_create_failed",
      predecessor_claim_id: first.claim.claim_id,
    });

    const recovered = await new TaskService(config, claims, new WorktreeManager(config), registry).start({
      task_id: task.id,
      task_alias: alias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-rebind-recovered",
      repository_path: source,
    });
    expect(recovered).toMatchObject({ reused: true, claim: { predecessor_claim_id: failedHistory.claim_id } });
    await expect(new WorktreeManager(config).inspect(recovered.claim)).resolves.toMatchObject({
      worktree_ref: first.worktree_ref,
    });
  });

  it("retries a reused worktree when the original dirty evidence already included a visible local Handoff", async () => {
    const fixture = await makeRegistryFixture();
    fixtures.push(fixture);
    const config = configFor(fixture.registryDir);
    const source = join(fixture.root, "source-reused-handoff");
    await git(fixture.root, "init", "--initial-branch=main", source);
    await git(source, "config", "user.name", "Phase1A Test");
    await git(source, "config", "user.email", "phase1a@example.invalid");
    await writeFile(join(source, "README.md"), "# Source\n", "utf8");
    await git(source, "add", "README.md");
    await git(source, "commit", "-m", "Initial source");

    const registry = isolatedRegistryGit(config, new ProcessRunner());
    const catalog = new Catalog(config, registry);
    await catalog.registerRepository({ repo_id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" });
    const alias = `${taskAlias}-reused-handoff`;
    const task = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias,
      goal: "retry a reused worktree with an existing local handoff",
      done_conditions: ["release retry succeeds"],
      expected_scope: ["src/control"],
    });
    const actualClaims = new ClaimService(config, registry, catalog, {
      async inspect() {
        return { process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 };
      },
    });
    const worktrees = new WorktreeManager(config);
    const coordinates = worktreePlan(task.id, alias);
    const priorClaim = await actualClaims.claimTask({
      task_id: task.id,
      task_alias: alias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-prior",
      host: config.buildHost,
      branch: coordinates.branch,
      worktree_ref: coordinates.worktree_ref,
    });
    const seeded = await worktrees.createOrReuse(priorClaim, source);
    await mkdir(join(seeded.path, ".ai"), { recursive: true });
    await writeFile(join(seeded.path, ".ai", "handoff.md"), "pre-existing visible handoff\n", "utf8");
    await expect(worktrees.inspect(priorClaim)).resolves.toMatchObject({
      dirty: true,
      dirty_files: [".ai/handoff.md"],
    });
    await actualClaims.finishClaim(task.id, priorClaim.claim_id, {
      status: "abandoned",
      outcome: "worktree_create_failed",
      branch: priorClaim.branch,
      head_sha: "a".repeat(40),
      validation: ["worktree_create_failed:COMMAND_FAILED"],
    });

    let failFirstRelease = true;
    const claims = {
      claimTask: actualClaims.claimTask.bind(actualClaims),
      assertOwner: actualClaims.assertOwner.bind(actualClaims),
      recoverClaim: actualClaims.recoverClaim.bind(actualClaims),
      getActive: actualClaims.getActive.bind(actualClaims),
      getClaimHistory: actualClaims.getClaimHistory.bind(actualClaims),
      latestClaimHistory: actualClaims.latestClaimHistory.bind(actualClaims),
      latestHandoffHistory: actualClaims.latestHandoffHistory.bind(actualClaims),
      finishClaim: async (...args: Parameters<ClaimService["finishClaim"]>) => {
        if (failFirstRelease) {
          failFirstRelease = false;
          throw new Error("injected release failure after Handoff commit");
        }
        return actualClaims.finishClaim(...args);
      },
    };
    const tasks = new TaskService(config, claims, worktrees, registry);
    const started = await tasks.start({
      task_id: task.id,
      task_alias: alias,
      project_id: task.project_id,
      repo_id: task.repo_id,
      session_id: "codex-reused",
      repository_path: source,
    });
    expect(started.reused).toBe(true);
    const input = {
      task_id: task.id,
      claim_id: started.claim.claim_id,
      status: "handoff" as const,
      validation: ["npm test: pass"],
    };
    const pointer = `handoffs/${task.id}/${started.claim.claim_id}.md`;

    await expect(tasks.finish(input)).rejects.toThrow("injected release failure after Handoff commit");
    expect(await registry.readHeadRegularFile(pointer)).toContain("dirty_count: 1");
    await expect(worktrees.inspect(started.claim)).resolves.toMatchObject({
      dirty: true,
      dirty_files: [".ai/handoff.md"],
    });

    const unrelated = join(seeded.path, "unrelated-change.txt");
    await writeFile(unrelated, "unrelated\n", "utf8");
    await expect(tasks.finish(input)).rejects.toMatchObject({ code: "HANDOFF_RETRY_CONFLICT" });
    await expect(actualClaims.getActive(task.id)).resolves.toMatchObject({ claim_id: started.claim.claim_id });
    await unlink(unrelated);

    await expect(tasks.finish(input)).resolves.toMatchObject({
      history: { handoff_pointer: pointer },
      worktree_removed: false,
    });
    await expect(actualClaims.getActive(task.id)).resolves.toBeUndefined();
  });

  it("records only stable create-failure codes in real Registry Claim history", async () => {
    const fixture = await makeRegistryFixture();
    fixtures.push(fixture);
    const config = configFor(fixture.registryDir);
    const registry = isolatedRegistryGit(config, new ProcessRunner());
    const catalog = new Catalog(config, registry);
    await catalog.registerRepository({ repo_id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" });
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
      getActive: actualClaims.getActive.bind(actualClaims),
      getClaimHistory: actualClaims.getClaimHistory.bind(actualClaims),
      latestClaimHistory: actualClaims.latestClaimHistory.bind(actualClaims),
      latestHandoffHistory: actualClaims.latestHandoffHistory.bind(actualClaims),
      finishClaim: actualClaims.finishClaim.bind(actualClaims),
    };
    const secretPath = "/srv/jhw/private/project-secret";
    const failedWorktrees = {
      assertStartReady: vi.fn(),
      createOrReuse: async () => {
        throw new ControlError("COMMAND_FAILED", `git failed at ${secretPath}`, { path: secretPath });
      },
      inspect: vi.fn(),
      removeIfSafe: vi.fn(),
      assertTakeoverEligible: vi.fn(),
      rebindTakeover: vi.fn(),
      cleanupReleased: vi.fn(),
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
      ...(status === "completed" ? { outcome: "done" } : {}),
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
    expect(() => parseHandoffMetadata(handoff)).not.toThrow();
    expect(() => parseHandoffSections(handoff)).not.toThrow();
    expect(handoff.endsWith("\n")).toBe(false);
  });

  it("keeps an exact newline truncation boundary parseable without a blank payload line", () => {
    const multiline = "x\n".repeat(100_000);
    const handoff = buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "issue-revision-7",
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
      progress: multiline,
      git_state: multiline,
      validation: multiline,
      failures: multiline,
      next_step: multiline,
      related_adr_and_evidence: multiline,
    });
    const firstPayloadStart = handoff.indexOf("\n## Progress Since Last Checkpoint\n") +
      "\n## Progress Since Last Checkpoint\n".length;
    const firstPayloadEnd = handoff.indexOf("\n## Git State\n", firstPayloadStart);

    expect(firstPayloadEnd).toBeGreaterThan(firstPayloadStart);
    expect(handoff.slice(firstPayloadStart, firstPayloadEnd).endsWith("\n")).toBe(false);
    expect(() => parseHandoffSections(handoff)).not.toThrow();
  });

  it("rejects Handoff preamble bytes, loose timestamps, and oversized revisions", () => {
    const valid = buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "issue-revision-7",
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
    });
    const preamble = valid.replace(
      "generated_at: 2026-08-13T12:36:56.789Z\n\n##",
      "generated_at: 2026-08-13T12:36:56.789Z\nATTACKER-CONTROLLED-PREAMBLE\n\n##",
    );

    expect(() => assertValidHandoff(preamble)).toThrowError(expect.objectContaining({ code: "INVALID_HANDOFF_EVIDENCE" }));
    const carriageReturnHeading = valid.replace(
      "    None recorded.\n## Git State",
      "    safe\r## ATTACKER-CONTROLLED-HEADING\n## Git State",
    );
    expect(() => assertValidHandoff(carriageReturnHeading)).toThrowError(expect.objectContaining({ code: "INVALID_HANDOFF_EVIDENCE" }));
    for (const generated_at of ["0", "2026", "Aug 13 2026", "2026-08-13"]) {
      expect(() => buildHandoff({
        task_id: TASK_ID,
        source_task_revision: "issue-revision-7",
        claim_id: CLAIM_ID,
        generated_at,
      })).toThrowError(expect.objectContaining({ code: "INVALID_HANDOFF_EVIDENCE" }));
    }
    expect(() => buildHandoff({
      task_id: TASK_ID,
      source_task_revision: "x".repeat(257),
      claim_id: CLAIM_ID,
      generated_at: "2026-08-13T12:36:56.789Z",
    })).toThrowError(expect.objectContaining({ code: "INVALID_HANDOFF_EVIDENCE" }));
  });

  it("self-validates malformed Handoff content before creating a worktree artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-invalid-handoff-"));
    localPaths.push(root);

    await expect(writeWorktreeHandoff(root, "# malformed\n")).rejects.toMatchObject({ code: "INVALID_HANDOFF_EVIDENCE" });
    await expect(readFile(join(root, ".ai", "handoff.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
