import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHandoff } from "../handoff.js";
import { TaskService } from "../task-service.js";
import { worktreePlan } from "../worktree.js";
import { configFor, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

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
  registry: { transact: ReturnType<typeof vi.fn> };
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
});
