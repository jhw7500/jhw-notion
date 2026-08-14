import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProcessRunner } from "../process.js";
import { ControlError } from "../errors.js";
import { WorktreeManager, worktreePlan } from "../worktree.js";
import type { ClaimHistory } from "../schemas.js";
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
    source_task_revision: "a".repeat(40),
    started_at: "2026-08-13T12:34:56.789Z",
    ...overrides,
  };
}

function takeover(previous = claim(), overrides: Record<string, string> = {}) {
  const successor = claim({
    claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac",
    session_id: "codex-successor",
    ...overrides,
  });
  const history: ClaimHistory = {
    ...previous,
    released_at: "2026-08-13T12:35:56.789Z",
    status: "taken-over",
    successor_claim_id: successor.claim_id,
  };
  return { history, successor };
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

async function worktreeFixtureWithHooks(hooks: { beforeSave?: () => void; afterSave?: () => void }): Promise<{
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
  const Constructor = WorktreeManager as unknown as new (
    config: ReturnType<typeof configFor>,
    runner: undefined,
    hooks: { beforeSave?: () => void; afterSave?: () => void },
  ) => WorktreeManager;
  return { fixture, repoDir, manager: new Constructor(config, undefined, hooks) };
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
      lifecycle: "active",
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

  it("prevalidates and CAS-rebinds an exact active same-host takeover without changing physical identity", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    const created = await manager.createOrReuse(previous, repoDir);
    const { history, successor } = takeover(previous);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const before = JSON.parse(await readFile(statePath, "utf8"));

    await expect(manager.assertTakeoverEligible(previous)).resolves.toBeUndefined();
    await expect(manager.rebindTakeover(history, successor)).resolves.toEqual({ changed: true });

    const after = JSON.parse(await readFile(statePath, "utf8"));
    const ref = previous.worktree_ref;
    expect(after.worktrees[ref]).toEqual({
      ...before.worktrees[ref],
      claim_id: successor.claim_id,
      session_id: successor.session_id,
    });
    await expect(manager.rebindTakeover(history, successor)).resolves.toEqual({ changed: false });
    expect(await readFile(statePath, "utf8")).toBe(`${JSON.stringify(after, null, 2)}\n`);
    await expect(manager.inspect(previous)).rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
    await expect(manager.removeIfSafe(previous)).rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
    await expect(manager.inspect(successor)).resolves.toMatchObject({ path: created.path });
  });

  it("refuses takeover when the exact local mapping is missing", async () => {
    const { manager } = await worktreeFixture();
    const previous = claim();
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_NOT_MAPPED" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_NOT_MAPPED" });
  });

  it.each([
    ["wrong stored Claim generation", "claim_id", "clm-0198aabb-ccdd-7eef-8abc-0123456789ad", "WORKTREE_CLAIM_MISMATCH"],
    ["wrong stored session", "session_id", "codex-other", "WORKTREE_CLAIM_MISMATCH"],
    ["wrong stored host", "host", "other-host", "WORKTREE_MAPPING_MISMATCH"],
    ["wrong stored Task", "task_id", "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac", "WORKTREE_MAPPING_MISMATCH"],
  ])("refuses takeover for %s", async (_name, field, value, code) => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees[previous.worktree_ref][field] = value;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it.each(["path", "repository_path"] as const)("refuses takeover for a wrong stored %s", async (field) => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (field === "path") {
      const wrongPath = join(fixture.root, "worktrees", "wt-wrong-direct-path");
      await mkdir(wrongPath);
      state.worktrees[previous.worktree_ref].path = wrongPath;
    } else {
      state.worktrees[previous.worktree_ref].repository_path = `${repoDir}/../source-repository`;
    }
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);
    const code = field === "path" ? "WORKTREE_MAPPING_MISMATCH" : "WORKTREE_REPOSITORY_MISMATCH";

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("refuses takeover when the actual checkout branch disagrees with the Claim", async () => {
    const { repoDir, manager } = await worktreeFixture();
    const previous = claim();
    const created = await manager.createOrReuse(previous, repoDir);
    await git(created.path, "switch", "-c", "task/unrelated-actual-branch");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_BRANCH_MISMATCH" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_BRANCH_MISMATCH" });
  });

  it("refuses takeover when the physical checkout belongs to another repository", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    const created = await manager.createOrReuse(previous, repoDir);
    await git(repoDir, "worktree", "remove", created.path);
    await git(fixture.root, "init", `--initial-branch=${previous.branch}`, created.path);
    await git(created.path, "config", "user.name", "Phase1A Test");
    await git(created.path, "config", "user.email", "phase1a@example.invalid");
    await writeFile(join(created.path, "README.md"), "# Impostor\n", "utf8");
    await git(created.path, "add", "README.md");
    await git(created.path, "commit", "-m", "Impostor checkout");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_REPOSITORY_MISMATCH" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_REPOSITORY_MISMATCH" });
  });

  it("refuses takeover when the mapping is already bound to a different successor", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees[previous.worktree_ref].claim_id = "clm-0198aabb-ccdd-7eef-8abc-0123456789ad";
    state.worktrees[previous.worktree_ref].session_id = "codex-different-successor";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it.each([
    ["cross-host predecessor", { old: { host: "other-host" } }, "HOST_MISMATCH"],
    ["cross-host successor", { next: { host: "other-host" } }, "HOST_MISMATCH"],
    ["different predecessor session", { old: { session_id: "codex-wrong" } }, "WORKTREE_CLAIM_MISMATCH"],
    ["different successor task", { next: { task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac" } }, "WORKTREE_PLAN_MISMATCH"],
    ["different successor alias", { next: { task_alias: "control:other" } }, "WORKTREE_PLAN_MISMATCH"],
    ["different successor project", { next: { project_id: "prj-other" } }, "WORKTREE_MAPPING_MISMATCH"],
    ["different successor repository", { next: { repo_id: "repo-other" } }, "WORKTREE_MAPPING_MISMATCH"],
    ["different successor branch", { next: { branch: "task/other" } }, "WORKTREE_PLAN_MISMATCH"],
    ["different successor ref", { next: { worktree_ref: "wt-other" } }, "WORKTREE_PLAN_MISMATCH"],
    ["same successor generation", { next: { claim_id: CLAIM_ID } }, "WORKTREE_CLAIM_MISMATCH"],
    ["wrong direct successor link", { link: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad" }, "WORKTREE_CLAIM_MISMATCH"],
  ])("refuses takeover rebind for %s", async (_name, mutation, code) => {
    const { repoDir, manager } = await worktreeFixture();
    const stored = claim();
    await manager.createOrReuse(stored, repoDir);
    const previous = claim((mutation as { old?: Record<string, string> }).old);
    const { history, successor } = takeover(previous, (mutation as { next?: Record<string, string> }).next);
    if ((mutation as { link?: string }).link) history.successor_claim_id = (mutation as { link: string }).link;

    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code });
    await expect(manager.inspect(stored)).resolves.toBeDefined();
  });

  it.each(["pending-create", "pending-remove", "removed"] as const)(
    "refuses takeover rebind while the worktree lifecycle is %s",
    async (lifecycle) => {
      const { fixture, repoDir, manager } = await worktreeFixture();
      const previous = claim();
      await manager.createOrReuse(previous, repoDir);
      const statePath = join(fixture.root, "state", "worktrees.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.worktrees[previous.worktree_ref].lifecycle = lifecycle;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await chmod(statePath, 0o600);
      const { history, successor } = takeover(previous);

      await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({
        code: "WORKTREE_LIFECYCLE_MISMATCH",
      });
    },
  );

  it("refuses a duplicate Task/path/branch mapping without changing the exact owner", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees["wt-duplicate-takeover"] = {
      ...state.worktrees[previous.worktree_ref],
      path: join(fixture.root, "worktrees", "wt-duplicate-takeover"),
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);

    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({
      code: "WORKTREE_MAPPING_AMBIGUOUS",
    });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("refuses a lexically aliased duplicate path even when its other coordinates differ", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees["wt-aliased-takeover"] = {
      ...state.worktrees[previous.worktree_ref],
      task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad",
      branch: "task/unrelated",
      repository_identity: join(fixture.root, "unrelated-git-common"),
      path: `${join(fixture.root, "worktrees")}/alias/../${previous.worktree_ref}`,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const { history, successor } = takeover(previous);

    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({
      code: "WORKTREE_MAPPING_AMBIGUOUS",
    });
  });

  it("refuses a physically aliased duplicate checkout even when its metadata lies", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    const created = await manager.createOrReuse(previous, repoDir);
    const aliasPath = join(fixture.root, "worktrees", "wt-physical-alias");
    await symlink(created.path, aliasPath);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees["wt-physical-alias"] = {
      ...state.worktrees[previous.worktree_ref],
      task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad",
      branch: "task/unrelated",
      repository_identity: join(fixture.root, "unrelated-git-common"),
      path: aliasPath,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
  });

  it("refuses an unrelated active mapping whose physical path escapes through an outward symlink", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const external = join(fixture.root, "external-worktree-alias");
    const aliasPath = join(fixture.root, "worktrees", "wt-outward-alias");
    await mkdir(external);
    await symlink(external, aliasPath);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees["wt-outward-alias"] = {
      ...state.worktrees[previous.worktree_ref],
      task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad",
      branch: "task/unrelated",
      repository_identity: join(fixture.root, "unrelated-git-common"),
      path: aliasPath,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("refuses an unrelated active mapping whose path is not a directory", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const filePath = join(fixture.root, "worktrees", "wt-file-alias");
    await writeFile(filePath, "not a checkout\n", "utf8");
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees["wt-file-alias"] = {
      ...state.worktrees[previous.worktree_ref],
      task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad",
      branch: "task/unrelated",
      repository_identity: join(fixture.root, "unrelated-git-common"),
      path: filePath,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("refuses an unrelated active mapping whose checkout path is missing", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const missingPath = join(fixture.root, "worktrees", "wt-missing-active");
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees["wt-missing-active"] = {
      ...state.worktrees[previous.worktree_ref],
      task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad",
      branch: "task/unrelated",
      repository_identity: join(fixture.root, "unrelated-git-common"),
      path: missingPath,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("canonicalizes unrelated repository identities before branch uniqueness comparison", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const direct = state.worktrees[previous.worktree_ref];
    const aliasPath = join(fixture.root, "worktrees", "wt-repository-alias");
    await mkdir(aliasPath);
    const identityName = direct.repository_identity.split("/").at(-1);
    state.worktrees["wt-repository-alias"] = {
      ...direct,
      task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad",
      repository_identity: `${direct.repository_identity}/../${identityName}`,
      path: aliasPath,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_AMBIGUOUS" });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it.each([
    ["noncanonical Task ID", { task_id: "tsk-not-canonical" }],
    ["empty session", { session_id: "" }],
    ["empty host", { host: "" }],
    ["empty branch", { branch: "" }],
    ["relative repository identity", { repository_identity: ".git" }],
    ["unexpected field", { unexpected: true }],
  ])("rejects an unrelated mapping with %s as invalid state", async (_name, mutation) => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees["wt-malformed-unrelated"] = {
      ...state.worktrees[previous.worktree_ref],
      task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad",
      branch: "task/unrelated",
      path: join(fixture.root, "worktrees", "wt-malformed-unrelated"),
      ...mutation,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "INVALID_WORKTREE_STATE" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "INVALID_WORKTREE_STATE" });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("permits an absent unrelated removed tombstone that aliases no takeover coordinate", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const unrelatedRepo = join(fixture.root, "unrelated-repository");
    await git(fixture.root, "init", "--initial-branch=main", unrelatedRepo);
    await git(unrelatedRepo, "config", "user.name", "Phase1A Test");
    await git(unrelatedRepo, "config", "user.email", "phase1a@example.invalid");
    await writeFile(join(unrelatedRepo, "README.md"), "# Unrelated\n", "utf8");
    await git(unrelatedRepo, "add", "README.md");
    await git(unrelatedRepo, "commit", "-m", "Initial unrelated source");
    const identity = (await git(unrelatedRepo, "rev-parse", "--git-common-dir")).trim();
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees["wt-removed-unrelated"] = {
      ...state.worktrees[previous.worktree_ref],
      task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ac",
      claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ad",
      session_id: "codex-unrelated",
      branch: "task/unrelated",
      repository_path: unrelatedRepo,
      repository_identity: identity.startsWith("/") ? identity : join(unrelatedRepo, identity),
      path: join(fixture.root, "worktrees", "wt-removed-unrelated"),
      lifecycle: "removed",
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).resolves.toBeUndefined();
    await expect(manager.rebindTakeover(history, successor)).resolves.toEqual({ changed: true });
  });

  it("refuses malformed base identity before laundering it through takeover", async () => {
    const { fixture, repoDir, manager } = await worktreeFixture();
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees[previous.worktree_ref].base_sha = "";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(statePath, 0o600);
    const { history, successor } = takeover(previous);

    await expect(manager.assertTakeoverEligible(previous)).rejects.toMatchObject({ code: "INVALID_WORKTREE_STATE" });
    await expect(manager.rebindTakeover(history, successor)).rejects.toMatchObject({ code: "INVALID_WORKTREE_STATE" });
  });

  it("retains old mapping bytes when takeover state persistence fails and converges on retry", async () => {
    let failNextSave = false;
    const { fixture, repoDir, manager } = await worktreeFixtureWithHooks({
      beforeSave: () => {
        if (!failNextSave) return;
        failNextSave = false;
        throw new Error("injected takeover state save failure");
      },
    });
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const before = await readFile(statePath, "utf8");
    const { history, successor } = takeover(previous);
    failNextSave = true;

    await expect(manager.rebindTakeover(history, successor)).rejects.toThrow("injected takeover state save failure");
    expect(await readFile(statePath, "utf8")).toBe(before);
    await expect(manager.rebindTakeover(history, successor)).resolves.toEqual({ changed: true });
    await expect(manager.rebindTakeover(history, successor)).resolves.toEqual({ changed: false });
  });

  it("recognizes a successor mapping after post-save failure and does not rewrite it", async () => {
    let failNextSave = false;
    const { fixture, repoDir, manager } = await worktreeFixtureWithHooks({
      afterSave: () => {
        if (!failNextSave) return;
        failNextSave = false;
        throw new Error("injected takeover post-save failure");
      },
    });
    const previous = claim();
    await manager.createOrReuse(previous, repoDir);
    const statePath = join(fixture.root, "state", "worktrees.json");
    const { history, successor } = takeover(previous);
    failNextSave = true;

    await expect(manager.rebindTakeover(history, successor)).rejects.toThrow("injected takeover post-save failure");
    const successorBytes = await readFile(statePath, "utf8");
    await expect(manager.rebindTakeover(history, successor)).resolves.toEqual({ changed: false });
    expect(await readFile(statePath, "utf8")).toBe(successorBytes);
  });

  it("rejects actual ahead commits as unpushed before removal", async () => {
    const { repoDir, manager } = await worktreeFixture();
    const active = claim();
    const created = await manager.createOrReuse(active, repoDir);
    await writeFile(join(created.path, "committed.txt"), "commit\n", "utf8");
    await git(created.path, "add", "committed.txt");
    await git(created.path, "commit", "-m", "Task change");

    await expect(manager.removeIfSafe(active)).rejects.toMatchObject({ code: "WORKTREE_UNPUSHED" });
    await expect(stat(created.path)).resolves.toBeDefined();
  });

  it("persists pending-create before Git allocation so a post-create state-save failure is recoverable", async () => {
    let saves = 0;
    const { fixture, repoDir, manager } = await worktreeFixtureWithHooks({
      beforeSave: () => {
        saves += 1;
        if (saves === 2) throw new Error("state write failed after git create");
      },
    });
    const active = claim();

    await expect(manager.createOrReuse(active, repoDir)).rejects.toThrow("state write failed after git create");

    const state = JSON.parse(await readFile(join(fixture.root, "state", "worktrees.json"), "utf8"));
    expect(state.worktrees[active.worktree_ref]).toMatchObject({
      claim_id: active.claim_id,
      lifecycle: "pending-create",
    });
    await expect(stat(join(fixture.root, "worktrees", active.worktree_ref))).resolves.toBeDefined();
    const successor = claim({ claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac", session_id: "codex-successor" });
    await expect(manager.createOrReuse(successor, repoDir)).resolves.toMatchObject({ reused: true });
  });

  it("marks pending-remove before deletion and leaves a recoverable tombstone when post-remove state persistence fails", async () => {
    let saves = 0;
    const { fixture, repoDir, manager } = await worktreeFixtureWithHooks({
      beforeSave: () => {
        saves += 1;
        if (saves === 4) throw new Error("state write failed after git remove");
      },
    });
    const active = claim();
    const created = await manager.createOrReuse(active, repoDir);

    await expect(manager.removeIfSafe(active)).rejects.toThrow("state write failed after git remove");
    await expect(stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    const state = JSON.parse(await readFile(join(fixture.root, "state", "worktrees.json"), "utf8"));
    expect(state.worktrees[active.worktree_ref]).toMatchObject({ lifecycle: "pending-remove", claim_id: active.claim_id });
    const successor = claim({ claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac", session_id: "codex-successor" });
    await expect(manager.removeIfSafe(successor)).rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
    await expect(manager.removeIfSafe(active)).resolves.toMatchObject({ removed: true, recovered: true, lifecycle: "removed" });
    await expect(manager.createOrReuse(successor, repoDir)).resolves.toMatchObject({ reused: false });
  });

  it("blocks a new Claim before a pending released generation is explicitly cleaned up", async () => {
    let saves = 0;
    const { repoDir, manager } = await worktreeFixtureWithHooks({
      beforeSave: () => {
        saves += 1;
        if (saves === 4) throw new Error("state write failed after git remove");
      },
    });
    const active = claim();
    await manager.createOrReuse(active, repoDir);
    await expect(manager.removeIfSafe(active)).rejects.toThrow("state write failed after git remove");

    await expect(manager.assertStartReady(active.task_id, active.task_alias)).rejects.toMatchObject({
      code: "WORKTREE_CLEANUP_REQUIRED",
      details: { task_id: active.task_id, worktree_ref: active.worktree_ref },
    });
    await expect(manager.createOrReuse(
      claim({ claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac", session_id: "codex-successor" }),
      repoDir,
    )).rejects.toMatchObject({ code: "WORKTREE_CLEANUP_REQUIRED" });
  });

  it("cleans up only the exact released same-host generation and is idempotent", async () => {
    const { repoDir, manager } = await worktreeFixture();
    const active = claim();
    const created = await manager.createOrReuse(active, repoDir);
    const history: ClaimHistory = {
      ...active,
      released_at: "2026-08-13T12:35:56.789Z",
      status: "completed",
      outcome: "done",
      head_sha: "a".repeat(40),
      validation_summary: "tests: pass",
    };

    await expect(manager.cleanupReleased(history)).resolves.toMatchObject({ removed: true, lifecycle: "removed" });
    await expect(stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.cleanupReleased(history)).resolves.toEqual({ removed: true, recovered: true, lifecycle: "removed" });
    await expect(manager.assertStartReady(active.task_id, active.task_alias)).resolves.toBeUndefined();

    await expect(manager.cleanupReleased({ ...history, claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac" }))
      .rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
    await expect(manager.cleanupReleased({ ...history, host: "another-host" }))
      .rejects.toMatchObject({ code: "HOST_MISMATCH" });
  });

  it("reinspects a same-generation pending removal and retries after a second safety check fails", async () => {
    let saves = 0;
    let root = "";
    const { fixture, repoDir, manager } = await worktreeFixtureWithHooks({
      afterSave: async () => {
        saves += 1;
        if (saves === 3) await writeFile(join(root, "worktrees", claim().worktree_ref, "raced.txt"), "dirty\n", "utf8");
      },
    });
    root = fixture.root;
    const active = claim();
    const created = await manager.createOrReuse(active, repoDir);

    await expect(manager.removeIfSafe(active)).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    await expect(manager.recoveryStatus(active)).resolves.toMatchObject({ lifecycle: "pending-remove", path_exists: true });
    await git(created.path, "clean", "-fd");
    await expect(manager.removeIfSafe(active)).resolves.toMatchObject({ removed: true, recovered: true, lifecycle: "removed" });
  });

  it("retries a failed Git removal for the same pending generation without allowing a successor", async () => {
    const { repoDir, manager } = await worktreeFixture();
    const active = claim();
    const created = await manager.createOrReuse(active, repoDir);
    const realRunner = new ProcessRunner();
    let failRemove = true;
    (manager as unknown as { runner: { run: ProcessRunner["run"] } }).runner = {
      run: async (command, args, options) => {
        if (failRemove && args.includes("worktree") && args.includes("remove")) {
          failRemove = false;
          throw new ControlError("COMMAND_FAILED", "injected git remove failure");
        }
        return realRunner.run(command, args, options);
      },
    };

    await expect(manager.removeIfSafe(active)).rejects.toMatchObject({ code: "COMMAND_FAILED" });
    const successor = claim({ claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ac", session_id: "codex-successor" });
    await expect(manager.removeIfSafe(successor)).rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
    await expect(manager.removeIfSafe(active)).resolves.toMatchObject({ removed: true, recovered: true, lifecycle: "removed" });
    await expect(stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-reads the pending-remove generation before deletion and rejects a successor swap", async () => {
    let saves = 0;
    let fixture: RegistryFixture | undefined;
    const { fixture: createdFixture, repoDir, manager } = await worktreeFixtureWithHooks({
      afterSave: () => {
        saves += 1;
        if (saves !== 3 || !fixture) return;
        const statePath = join(fixture.root, "state", "worktrees.json");
        return readFile(statePath, "utf8").then(async (serialized) => {
          const state = JSON.parse(serialized);
          state.worktrees[claim().worktree_ref].claim_id = "clm-0198aabb-ccdd-7eef-8abc-0123456789ac";
          state.worktrees[claim().worktree_ref].session_id = "codex-successor";
          state.worktrees[claim().worktree_ref].lifecycle = "active";
          await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
          await chmod(statePath, 0o600);
        });
      },
    });
    fixture = createdFixture;
    const active = claim();
    const created = await manager.createOrReuse(active, repoDir);

    await expect(manager.removeIfSafe(active)).rejects.toMatchObject({ code: "WORKTREE_CLAIM_MISMATCH" });
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
