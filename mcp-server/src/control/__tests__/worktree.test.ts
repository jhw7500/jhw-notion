import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorktreeManager, worktreePlan } from "../worktree.js";
import { configFor, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

const fixtures: RegistryFixture[] = [];
const TASK_ID = "tsk-0198aabb-ccdd-7eef-8abc-0123456789ab";
const CLAIM_ID = "clm-0198aabb-ccdd-7eef-8abc-0123456789ab";

function claim(overrides: Record<string, string> = {}) {
  const plan = worktreePlan(TASK_ID, "wlan:tmp-20260813-01-fix");
  return {
    task_id: TASK_ID,
    task_alias: "wlan:tmp-20260813-01-fix",
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    claim_id: CLAIM_ID,
    session_id: "codex-a",
    host: "cantopsbuildserver",
    branch: plan.branch,
    worktree_ref: plan.worktree_ref,
    started_at: "2026-08-13T12:34:56.789Z",
    ...overrides,
  };
}

async function worktreeFixture(): Promise<{
  fixture: RegistryFixture;
  repoDir: string;
  manager: WorktreeManager;
}> {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const repoDir = join(fixture.root, "source-repository");
  await git(fixture.root, "init", "--initial-branch=main", repoDir);
  await git(repoDir, "config", "user.name", "Phase1A Test");
  await git(repoDir, "config", "user.email", "phase1a@example.invalid");
  await writeFile(join(repoDir, "README.md"), "# Source\n", "utf8");
  await git(repoDir, "add", "README.md");
  await git(repoDir, "commit", "-m", "Initial source");
  const config = configFor(fixture.registryDir);
  return { fixture, repoDir, manager: new WorktreeManager(config) };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("WorktreeManager", () => {
  it("creates a deterministic logical worktree ref without placing an absolute path in the Claim", () => {
    const plan = worktreePlan(TASK_ID, "WLAN: Roaming/Fix");

    expect(plan.branch).toMatch(/^task\/0123456789ab-wlan-roaming-fix$/);
    expect(plan.worktree_ref).toBe("wt-0123456789ab-wlan-roaming-fix");
    expect(plan.worktree_ref).not.toContain("/");
  });

  it("stores absolute paths only in a private local mapping and reuses the matching same-host worktree", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const initial = claim();

    const created = await manager.createOrReuse(initial, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const stateMode = (await stat(statePath)).mode & 0o777;
    const stateDirMode = (await stat(join(fixture.root, "state"))).mode & 0o777;

    expect(created.reused).toBe(false);
    expect(created.path).toMatch(new RegExp(`^${fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(state.worktrees[initial.worktree_ref]).toMatchObject({
      task_id: initial.task_id,
      claim_id: initial.claim_id,
      path: created.path,
      repository_path: repoDir,
      branch: initial.branch,
    });
    expect(stateMode).toBe(0o600);
    expect(stateDirMode).toBe(0o700);

    const replacement = claim({ claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac", session_id: "codex-b" });
    const reused = await manager.createOrReuse(replacement, repoDir);

    expect(reused).toMatchObject({ path: created.path, reused: true, branch: initial.branch });
    expect(JSON.parse(await readFile(statePath, "utf8")).worktrees[initial.worktree_ref].claim_id).toBe(
      replacement.claim_id,
    );
  });

  it("refuses to remove a dirty worktree and removes a clean worktree without releasing its Claim", async () => {
    const { repoDir, manager } = await worktreeFixture();
    const active = claim();
    const created = await manager.createOrReuse(active, repoDir);
    await writeFile(join(created.path, "uncommitted.txt"), "dirty\n", "utf8");

    await expect(manager.removeIfSafe(active)).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    await expect(stat(created.path)).resolves.toBeDefined();

    await writeFile(join(created.path, "uncommitted.txt"), "", "utf8");
    await git(created.path, "clean", "-fd");
    await expect(manager.removeIfSafe(active)).resolves.toMatchObject({ removed: true });
    await expect(stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let a prior Claim generation inspect or remove a reused worktree", async () => {
    const { repoDir, manager } = await worktreeFixture();
    const original = claim();
    const created = await manager.createOrReuse(original, repoDir);
    const replacement = claim({ claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac", session_id: "codex-b" });
    await manager.createOrReuse(replacement, repoDir);

    await expect(manager.removeIfSafe(original)).rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
    await expect(stat(created.path)).resolves.toBeDefined();
  });

  it("fails closed rather than following a worktree-state symlink", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    await mkdir(join(fixture.root, "state"), { recursive: true });
    await writeFile(join(fixture.root, "outside-state.json"), "{}\n", "utf8");
    await symlink(
      join(fixture.root, "outside-state.json"),
      join(fixture.root, "state", "worktrees.json"),
    );

    await expect(manager.createOrReuse(claim(), repoDir)).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });
  });
});
