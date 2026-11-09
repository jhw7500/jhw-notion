import { fstatSync } from "node:fs";
import { chmod, link, mkdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessRunner } from "../process.js";
import type { ClaimHistory } from "../schemas.js";
import { historicalCleanupProofSha256, verifyHistoricalCleanupBackupOnly, verifyHistoricalCleanupProof, withVerifiedHistoricalCleanupBackupOnly, withVerifiedHistoricalCleanupProof } from "../worktree-cleanup-proof.js";
import { WorktreeManager, worktreePlan } from "../worktree.js";
import { configFor, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

const fixtures: RegistryFixture[] = [];
const TASK_ID = "tsk-0198aabb-ccdd-7eef-8abc-0123456789ab";
const CLAIM_ID = "clm-0198aabb-ccdd-7eef-8abc-0123456789ab";
const sourceTrust = { assertTrustedSource: async () => undefined };

const filesystemBoundary = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string, flags: string | number | undefined) => Promise<void>),
  afterOpen: undefined as undefined | ((path: string, handle: FileHandle) => Promise<void>),
  softDescriptorLimit: undefined as number | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === "/proc/self/limits" && filesystemBoundary.softDescriptorLimit !== undefined) {
        return Buffer.from(`Max open files            ${filesystemBoundary.softDescriptorLimit}                 1048576              files\n`);
      }
      return actual.readFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      await filesystemBoundary.beforeOpen?.(String(args[0]), args[1]);
      const handle = await actual.open(...args);
      await filesystemBoundary.afterOpen?.(String(args[0]), handle);
      return handle;
    },
  };
});

afterEach(async () => {
  filesystemBoundary.beforeOpen = undefined;
  filesystemBoundary.afterOpen = undefined;
  filesystemBoundary.softDescriptorLimit = undefined;
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function proofFixture() {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const remote = join(fixture.root, "remote.git");
  const source = join(fixture.root, "source");
  const plan = worktreePlan(TASK_ID, "proof:tmp-20261107-01-test");
  const worktree = join(fixture.root, "worktrees", plan.worktree_ref);
  const backup = join(fixture.root, "backup");
  await git(fixture.root, "init", "--bare", remote);
  await git(fixture.root, "init", "--initial-branch=main", source);
  await git(source, "config", "user.name", "Proof Test");
  await git(source, "config", "user.email", "proof@example.invalid");
  await writeFile(join(source, "tracked.txt"), "base\n", "utf8");
  await writeFile(join(source, ".gitignore"), ".review/\n", "utf8");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await mkdir(join(fixture.root, "worktrees"), { recursive: true, mode: 0o700 });
  await git(source, "worktree", "add", "-b", plan.branch, worktree, "HEAD");
  await writeFile(join(worktree, "tracked.txt"), "task bytes\n", "utf8");
  await git(worktree, "add", "tracked.txt");
  await git(worktree, "commit", "-m", "task change");
  const worktreeCommit = (await git(worktree, "rev-parse", "HEAD")).trim();
  await writeFile(join(source, "tracked.txt"), "task bytes\n", "utf8");
  await git(source, "add", "tracked.txt");
  await git(source, "commit", "-m", "integrated independently");
  const integrationCommit = (await git(source, "rev-parse", "HEAD")).trim();
  await git(source, "push", "origin", "main");
  await mkdir(join(worktree, ".review"), { recursive: true });
  await writeFile(join(worktree, ".review", "note.txt"), "private evidence\n", "utf8");
  await chmod(join(worktree, ".review", "note.txt"), 0o600);
  await mkdir(backup, { mode: 0o700 });
  await chmod(backup, 0o700);
  const bundle = join(backup, "recovery.bundle");
  await git(source, "bundle", "create", bundle, "--all");
  await chmod(bundle, 0o600);
  const artifact = join(backup, "artifact-note.txt");
  await writeFile(artifact, "private evidence\n", { mode: 0o600 });
  await chmod(artifact, 0o600);
  const sha256 = async (path: string) => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(await readFile(path)).digest("hex");
  };
  const sourceHead = (await git(source, "rev-parse", "HEAD")).trim();
  const bundleInfo = await stat(bundle);
  const artifactInfo = await stat(artifact);
  const inventory = [{
    path: ".review/note.txt",
    file: artifact,
    sha256: await sha256(artifact),
    bytes: artifactInfo.size,
    mode: "0600",
  }];
  const { createHash } = await import("node:crypto");
  const inventorySha256 = createHash("sha256").update(JSON.stringify(inventory.map(({ file: _file, ...entry }) => entry))).digest("hex");
  const history: ClaimHistory = {
    task_id: TASK_ID,
    task_alias: "proof:tmp-20261107-01-test",
    project_id: "prj-proof",
    repo_id: "repo-proof",
    claim_id: CLAIM_ID,
    origin_adapter: "codex",
    session_id: "private-session",
    host: "cantopsbuildserver",
    branch: plan.branch,
    worktree_ref: plan.worktree_ref,
    source_task_revision: "a".repeat(40),
    started_at: "2026-11-07T01:00:00.000Z",
    released_at: "2026-11-07T02:00:00.000Z",
    status: "completed",
    outcome: "done",
    head_sha: worktreeCommit,
    validation_summary: "tests: pass",
  };
  const manifest = {
    version: 1,
    policy: "historical-exact-patch-v1",
    task_id: TASK_ID,
    claim_id: CLAIM_ID,
    project_id: "prj-proof",
    repo_id: "repo-proof",
    repository_slug: "jhw7500/proof",
    host: "cantopsbuildserver",
    branch: plan.branch,
    worktree_ref: history.worktree_ref,
    registry_head: "b".repeat(40),
    history_sha256: "c".repeat(64),
    mapping_sha256: "d".repeat(64),
    source_ref: "refs/heads/main",
    source_head: sourceHead,
    worktree_head: worktreeCommit,
    commits: [{ worktree_commit: worktreeCommit, integration_commit: integrationCommit }],
    bundle: { file: bundle, sha256: await sha256(bundle), bytes: bundleInfo.size },
    artifacts: inventory,
    inventory_sha256: inventorySha256,
  };
  const proofPath = join(backup, "cleanup-proof.json");
  await writeFile(proofPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await chmod(proofPath, 0o600);
  const commonGitDir = (await git(source, "rev-parse", "--git-common-dir")).trim();
  const commonGitPath = join(source, commonGitDir);
  const baseSha = (await git(worktree, "rev-parse", `${worktreeCommit}^`)).trim();
  const mapping = {
    task_id: history.task_id,
    project_id: history.project_id,
    repo_id: history.repo_id,
    claim_id: history.claim_id,
    session_id: history.session_id,
    host: history.host,
    branch: history.branch,
    repository_path: source,
    repository_identity: commonGitPath,
    path: worktree,
    base_sha: baseSha,
    lifecycle: "active",
  };
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  manifest.mapping_sha256 = createHash("sha256").update(JSON.stringify({
    task_id: mapping.task_id,
    project_id: mapping.project_id,
    repo_id: mapping.repo_id,
    claim_id: mapping.claim_id,
    host: mapping.host,
    branch: mapping.branch,
    base_sha: mapping.base_sha,
    lifecycle: mapping.lifecycle,
    repository_identity: hash(mapping.repository_identity),
    path: hash(mapping.path),
  }), "utf8").digest("hex");
  await writeFile(proofPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await mkdir(join(fixture.root, "state"), { mode: 0o700 });
  await writeFile(join(fixture.root, "state", "worktrees.json"), `${JSON.stringify({
    version: 2,
    worktrees: { [history.worktree_ref]: mapping },
  })}\n`, { mode: 0o600 });
  return { fixture, source, worktree, backup, proofPath, history, manifest, commonGitDir: commonGitPath };
}

async function refreshProofBundle(f: Awaited<ReturnType<typeof proofFixture>>): Promise<void> {
  await unlink(f.manifest.bundle.file);
  await git(f.source, "bundle", "create", f.manifest.bundle.file, "--all");
  await chmod(f.manifest.bundle.file, 0o600);
  const bundle = await readFile(f.manifest.bundle.file);
  const { createHash } = await import("node:crypto");
  f.manifest.bundle.bytes = bundle.length;
  f.manifest.bundle.sha256 = createHash("sha256").update(bundle).digest("hex");
  await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });
}

function bundleSwapRestoreRunner(publicBundlePath: string, validBundle: Buffer) {
  const delegate = new ProcessRunner();
  const consumedBundlePaths: string[] = [];
  const runner = {
    run: async (command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]) => {
      const bundleIndex = args.indexOf("bundle");
      const cloneIndex = args.indexOf("clone");
      const input = bundleIndex >= 0 && args[bundleIndex + 1] === "verify"
        ? args[bundleIndex + 2]
        : cloneIndex >= 0 && args[cloneIndex + 1] === "--mirror"
          ? args[cloneIndex + 2]
          : undefined;
      if (input !== undefined) consumedBundlePaths.push(input);
      if (input !== publicBundlePath) return delegate.run(command, args, options);

      const held = `${publicBundlePath}.manifest-bound`;
      await rename(publicBundlePath, held);
      await writeFile(publicBundlePath, validBundle, { mode: 0o600 });
      await chmod(publicBundlePath, 0o600);
      try {
        return await delegate.run(command, args, options);
      } finally {
        await rm(publicBundlePath, { force: true });
        await rename(held, publicBundlePath);
      }
    },
    runRaw: delegate.runRaw.bind(delegate),
  };
  return { runner, consumedBundlePaths };
}

function cleanupOptions(f: Awaited<ReturnType<typeof proofFixture>>) {
  return {
    proofPath: f.proofPath,
    registryHead: f.manifest.registry_head,
    historySha256: f.manifest.history_sha256,
    repositorySlug: f.manifest.repository_slug,
    revalidate: async () => undefined,
  };
}

async function leaveRemovedCheckoutPending(f: Awaited<ReturnType<typeof proofFixture>>) {
  let saves = 0;
  const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {
    beforeSave: () => {
      if (++saves === 2) throw new Error("injected pending completion");
    },
  }, sourceTrust);
  await expect(manager.cleanupReleased(f.history, cleanupOptions(f))).rejects.toThrow("injected pending completion");
  await expect(stat(f.worktree)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectPendingCleanup(f: Awaited<ReturnType<typeof proofFixture>>) {
  const state = JSON.parse(await readFile(join(f.fixture.root, "state", "worktrees.json"), "utf8"));
  expect(state.worktrees[f.history.worktree_ref].lifecycle).toBe("pending-remove-equivalent");
  expect(state.worktrees[f.history.worktree_ref].cleanup_intent.proof_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect((await git(f.source, "rev-parse", `refs/heads/${f.history.branch}`)).trim()).toBe(f.manifest.worktree_head);
}

async function replaceBackupFile(path: string) {
  const bytes = await readFile(path);
  await rename(path, `${path}.previous`);
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

describe("historical cleanup proof", () => {
  it.each([
    ["manifest", 0o4600], ["manifest", 0o2600], ["manifest", 0o1600],
    ["bundle", 0o4600], ["bundle", 0o2600], ["bundle", 0o1600],
    ["backup", 0o4600], ["backup", 0o2600], ["backup", 0o1600],
    ["source", 0o4600], ["source", 0o2600], ["source", 0o1600],
    ["parent", 0o4700], ["parent", 0o2700], ["parent", 0o1700],
  ] as const)("rejects special permission bits on %s (%i)", async (target, mode) => {
    const f = await proofFixture();
    const path = target === "manifest" ? f.proofPath : target === "bundle" ? f.manifest.bundle.file
      : target === "backup" ? f.manifest.artifacts[0]!.file
        : target === "source" ? join(f.worktree, f.manifest.artifacts[0]!.path) : f.backup;
    await chmod(path, mode);
    expect((await stat(path)).mode & 0o7777).toBe(mode);

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "backup_invalid" } });
  });

  it.each(["manifest", "parent"] as const)("rejects special permission bits in the standalone %s reader", async (target) => {
    const f = await proofFixture();
    await chmod(target === "manifest" ? f.proofPath : f.backup, target === "manifest" ? 0o4600 : 0o2700);
    await expect(historicalCleanupProofSha256(f.proofPath)).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
  });

  it.each([0o644, 0o755])("preserves the declared ordinary artifact mode %i", async (mode) => {
    const f = await proofFixture();
    const entry = f.manifest.artifacts[0]!;
    await chmod(join(f.worktree, entry.path), mode);
    await chmod(entry.file, mode);
    entry.mode = `0${mode.toString(8)}`;
    const { createHash } = await import("node:crypto");
    f.manifest.inventory_sha256 = createHash("sha256")
      .update(JSON.stringify(f.manifest.artifacts.map(({ file: _file, ...artifact }) => artifact))).digest("hex");
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });
    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).resolves.toMatchObject({ inventorySha256: f.manifest.inventory_sha256 });
  });

  it.each(["manifest", "bundle", "artifact", "parent", "missing"] as const)(
    "keeps recovery pending when its verified %s changes during the callback", async (target) => {
      const f = await proofFixture();
      await leaveRemovedCheckoutPending(f);
      const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {}, sourceTrust);
      await expect(manager.cleanupReleased(f.history, {
        ...cleanupOptions(f),
        revalidate: async () => {
          if (target === "parent") {
            const files = await Promise.all([f.proofPath, f.manifest.bundle.file, f.manifest.artifacts[0]!.file]
              .map(async (path) => ({ name: path.slice(f.backup.length + 1), bytes: await readFile(path) })));
            await rename(f.backup, `${f.backup}.previous`);
            await mkdir(f.backup, { mode: 0o700 });
            for (const file of files) await writeFile(join(f.backup, file.name), file.bytes, { mode: 0o600 });
          } else if (target === "missing") {
            await unlink(f.manifest.artifacts[0]!.file);
          } else {
            await replaceBackupFile(target === "manifest" ? f.proofPath : target === "bundle"
              ? f.manifest.bundle.file : f.manifest.artifacts[0]!.file);
          }
        },
      })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
      await expectPendingCleanup(f);
    },
  );

  it.each([false, true])("checks backups after the state preparation hook (recovery=%s)", async (recovery) => {
    const f = await proofFixture();
    if (recovery) await leaveRemovedCheckoutPending(f);
    let saves = 0;
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {
      beforeSave: async () => {
        if (++saves === (recovery ? 1 : 2)) await replaceBackupFile(f.manifest.artifacts[0]!.file);
      },
    }, sourceTrust);
    await expect(manager.cleanupReleased(f.history, cleanupOptions(f)))
      .rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
    await expectPendingCleanup(f);
  });

  it.each([false, true])("preserves a newer mapping during state preparation (recovery=%s)", async (recovery) => {
    const f = await proofFixture();
    if (recovery) await leaveRemovedCheckoutPending(f);
    let saves = 0;
    const statePath = join(f.fixture.root, "state", "worktrees.json");
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {
      beforeSave: async () => {
        if (++saves !== (recovery ? 1 : 2)) return;
        const state = JSON.parse(await readFile(statePath, "utf8"));
        state.worktrees[f.history.worktree_ref].session_id = "newer-session";
        await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      },
    }, sourceTrust);
    await expect(manager.cleanupReleased(f.history, cleanupOptions(f)))
      .rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
    await expectPendingCleanup(f);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.worktrees[f.history.worktree_ref].session_id).toBe("newer-session");
  });

  it("rejects an artifact backup inside a managed root during backup-only verification", async () => {
    const f = await proofFixture();
    const file = join(f.fixture.root, "state", "artifact-note.txt");
    await writeFile(file, await readFile(f.manifest.artifacts[0]!.file), { mode: 0o600 });
    f.manifest.artifacts[0]!.file = file;
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });
    await expect(verifyHistoricalCleanupBackupOnly({
      proofPath: f.proofPath, sourcePath: f.source, worktreePath: f.worktree,
      commonGitDir: f.commonGitDir, managedRoots: [join(f.fixture.root, "state")], runner: new ProcessRunner(),
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "backup_invalid" } });
  });

  it.each([false, true])("rechecks backups after syncing the temporary state file (recovery=%s)", async (recovery) => {
    const f = await proofFixture();
    if (recovery) await leaveRemovedCheckoutPending(f);
    let saves = 0;
    let changed = false;
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {
      beforeSave: () => {
        if (++saves !== (recovery ? 1 : 2)) return;
        filesystemBoundary.afterOpen = async (path, handle) => {
          if (!basename(path).startsWith(".worktrees.") || !path.endsWith(".tmp")) return;
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
            await sync();
            await replaceBackupFile(f.manifest.artifacts[0]!.file);
            changed = true;
          });
        };
      },
    }, sourceTrust);

    await expect(manager.cleanupReleased(f.history, cleanupOptions(f)))
      .rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
    expect(changed).toBe(true);
    await expectPendingCleanup(f);
  });

  it.each([false, true])("preserves a newer mapping while checking backup identities (recovery=%s)", async (recovery) => {
    const f = await proofFixture();
    if (recovery) await leaveRemovedCheckoutPending(f);
    const statePath = join(f.fixture.root, "state", "worktrees.json");
    let saves = 0;
    let changed = false;
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {
      beforeSave: () => {
        if (++saves !== (recovery ? 1 : 2)) return;
        filesystemBoundary.beforeOpen = async (path) => {
          if (changed || basename(path) !== basename(f.manifest.artifacts[0]!.file)) return;
          changed = true;
          const state = JSON.parse(await readFile(statePath, "utf8"));
          state.worktrees[f.history.worktree_ref].session_id = "newest-session";
          await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        };
      },
    }, sourceTrust);
    await expect(manager.cleanupReleased(f.history, cleanupOptions(f)))
      .rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
    expect(changed).toBe(true);
    await expectPendingCleanup(f);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.worktrees[f.history.worktree_ref].session_id).toBe("newest-session");
  });

  it.each(["branch", "checkout", "registration"] as const)("rechecks %s metadata immediately before recovery publication", async (target) => {
    const f = await proofFixture();
    await leaveRemovedCheckoutPending(f);
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {
      beforeSave: async () => {
        if (target === "branch") {
          await git(f.source, "update-ref", `refs/heads/${f.history.branch}`, f.manifest.source_head);
        } else {
          await git(f.source, "worktree", "add", "--detach", f.worktree, f.manifest.source_head);
          if (target === "registration") await rm(f.worktree, { recursive: true, force: true });
        }
      },
    }, sourceTrust);
    await expect(manager.cleanupReleased(f.history, cleanupOptions(f)))
      .rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
    const state = JSON.parse(await readFile(join(f.fixture.root, "state", "worktrees.json"), "utf8"));
    expect(state.worktrees[f.history.worktree_ref].lifecycle).toBe("pending-remove-equivalent");
    const head = (await git(f.source, "rev-parse", `refs/heads/${f.history.branch}`)).trim();
    expect(head).toBe(target === "branch" ? f.manifest.source_head : f.manifest.worktree_head);
  });

  it("retains all verified backup files throughout absent-checkout completion and closes them afterwards", async () => {
    const f = await proofFixture();
    await leaveRemovedCheckoutPending(f);
    const files = new Set([f.proofPath, f.manifest.bundle.file, f.manifest.artifacts[0]!.file]);
    const opened: FileHandle[] = [];
    filesystemBoundary.afterOpen = async (_path, handle) => {
      const path = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!files.has(path)) return;
      opened.push(handle);
    };
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {}, sourceTrust);
    await expect(manager.cleanupReleased(f.history, {
      ...cleanupOptions(f),
      revalidate: async () => {
        const retained = opened.filter((handle) => handle.fd >= 0);
        expect(retained).toHaveLength(3);
        for (const handle of retained) expect(fstatSync(handle.fd).isFile()).toBe(true);
      },
    })).resolves.toMatchObject({ recovered: true, removed: true });
    expect(opened.length).toBeGreaterThanOrEqual(3);
    for (const handle of opened) expect(handle.fd).toBe(-1);
  });

  it("rejects an ancestor relationship change while acquiring the artifact backup parent", async () => {
    const f = await proofFixture();
    const container = join(f.fixture.root, "external");
    const parent = join(container, "backup");
    const managed = join(f.fixture.root, "state", "nested");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await mkdir(join(managed, "backup"), { recursive: true, mode: 0o700 });
    const entry = f.manifest.artifacts[0]!;
    const name = "artifact-note.txt";
    for (const directory of [parent, join(managed, "backup")]) {
      await writeFile(join(directory, name), await readFile(entry.file), { mode: 0o600 });
    }
    entry.file = join(parent, name);
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });
    let changed = false;
    filesystemBoundary.beforeOpen = async (path) => {
      if (changed || basename(path) !== "backup" || await realpath(dirname(path)) !== container) return;
      changed = true;
      await rename(container, `${container}.previous`);
      await symlink(managed, container, "dir");
    };
    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
    expect(changed).toBe(true);
  });

  it("rejects a changed forbidden-root identity during the verified scope", async () => {
    const f = await proofFixture();
    const managed = join(f.fixture.root, "state");
    await expect(withVerifiedHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [managed],
      runner: new ProcessRunner(), sourceTrust,
    }, async (scope) => {
      await rename(managed, `${managed}.previous`);
      await mkdir(managed, { mode: 0o700 });
      await scope.assertArtifactsUnchanged();
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
  });

  it.each(["success", "callback failure", "invalid backup"] as const)("closes acquired file and parent descriptors on %s", async (outcome) => {
    const f = await proofFixture();
    if (outcome === "invalid backup") {
      await writeFile(f.manifest.artifacts[0]!.file, "invalid backup bytes\n", { mode: 0o600 });
    }
    const opened: FileHandle[] = [];
    filesystemBoundary.afterOpen = async (_path, handle) => { opened.push(handle); };
    const operation = withVerifiedHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    }, async () => {
      if (outcome === "callback failure") throw new Error("injected callback failure");
    });
    if (outcome === "success") await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toThrow();
    expect(opened.length).toBeGreaterThan(0);
    for (const handle of opened) expect(handle.fd).toBe(-1);
  });

  it("shares retained directory identities and closes each acquired descriptor exactly once", async () => {
    const f = await proofFixture();
    const opened: Array<{ handle: FileHandle; close: ReturnType<typeof vi.spyOn> }> = [];
    filesystemBoundary.afterOpen = async (_path, handle) => { opened.push({ handle, close: vi.spyOn(handle, "close") }); };
    await withVerifiedHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    }, async () => {
      const directories = opened.filter(({ handle }) => handle.fd >= 0 && fstatSync(handle.fd).isDirectory());
      const identities = directories.map(({ handle }) => { const info = fstatSync(handle.fd); return `${info.dev}:${info.ino}`; });
      expect(identities.length).toBeGreaterThan(0);
      expect(new Set(identities).size).toBe(identities.length);
    });
    for (const { handle, close } of opened) { expect(handle.fd).toBe(-1); expect(close).toHaveBeenCalledTimes(1); }
  });

  it.each(["normal", "recovery"] as const)("rejects an insufficient descriptor budget before the %s mutation callback", async (route) => {
    const f = await proofFixture();
    if (route === "recovery") await leaveRemovedCheckoutPending(f);
    const statePath = join(f.fixture.root, "state", "worktrees.json");
    const before = await readFile(statePath);
    filesystemBoundary.softDescriptorLimit = 1;
    let callbacks = 0;
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {}, sourceTrust);
    await expect(manager.cleanupReleased(f.history, {
      ...cleanupOptions(f), revalidate: async () => { callbacks += 1; },
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "scope_unsupported" } });
    expect(callbacks).toBe(0);
    expect(await readFile(statePath)).toEqual(before);
    if (route === "normal") await expect(stat(f.worktree)).resolves.toBeDefined();
    expect(await git(f.source, "show-ref", "--verify", `refs/heads/${f.history.branch}`)).toContain(f.manifest.worktree_head);
  });

  it("normalizes a retained boundary I/O failure without rewriting callback failures", async () => {
    const f = await proofFixture();
    const managed = join(f.fixture.root, "state");
    let boundary: FileHandle | undefined;
    filesystemBoundary.afterOpen = async (_path, handle) => {
      if (await realpath(`/proc/self/fd/${handle.fd}`) === managed) boundary = handle;
    };
    const input = { proofPath: f.proofPath, sourcePath: f.source, worktreePath: f.worktree,
      commonGitDir: f.commonGitDir, managedRoots: [managed], runner: new ProcessRunner() };
    await expect(withVerifiedHistoricalCleanupBackupOnly(input, async (scope) => {
      expect(boundary).toBeDefined();
      vi.spyOn(boundary!, "stat").mockRejectedValueOnce(Object.assign(new Error("injected I/O error"), { code: "EIO" }));
      await scope.assertBackupsUnchanged();
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "snapshot_changed" } });
    const callbackError = new Error("callback identity must survive");
    await expect(withVerifiedHistoricalCleanupBackupOnly(input, async () => { throw callbackError; })).rejects.toBe(callbackError);
  });

  it("accepts a complete exact commit tuple, full bundle, and every ignored artifact", async () => {
    const f = await proofFixture();

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath,
      history: f.history,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source,
      worktreePath: f.worktree,
      commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug,
      managedRoots: [join(f.fixture.root, "state"), join(f.fixture.root, "worktrees")],
      runner: new ProcessRunner(),
      sourceTrust,
    })).resolves.toMatchObject({
      policy: "historical-exact-patch-v1",
      sourceHead: f.manifest.source_head,
      worktreeHead: f.manifest.worktree_head,
    });
  });

  it("accepts an exact proof when the ignored artifact inventory is empty", async () => {
    const f = await proofFixture();
    await unlink(join(f.worktree, ".review", "note.txt"));
    const { createHash } = await import("node:crypto");
    f.manifest.artifacts = [];
    f.manifest.inventory_sha256 = createHash("sha256").update("[]").digest("hex");
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).resolves.toMatchObject({ inventorySha256: f.manifest.inventory_sha256 });
  });

  it("rejects a partial commit correspondence even when one mapped patch is exact", async () => {
    const f = await proofFixture();
    await writeFile(join(f.worktree, "second.txt"), "second\n", "utf8");
    await git(f.worktree, "add", "second.txt");
    await git(f.worktree, "commit", "-m", "unmapped second change");
    const secondCommit = (await git(f.worktree, "rev-parse", "HEAD")).trim();
    f.history.head_sha = secondCommit;
    f.manifest.worktree_head = secondCommit;
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath,
      history: f.history,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source,
      worktreePath: f.worktree,
      commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug,
      managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(),
      sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "patch_mismatch" } });
  });

  it("keeps the verified source descriptor open for the callback and closes it after success", async () => {
    const f = await proofFixture();
    let descriptor = -1;

    await withVerifiedHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    }, async (scope) => {
      descriptor = scope.sourceArtifacts[0]!.descriptor;
      expect(fstatSync(descriptor).isFile()).toBe(true);
      await scope.assertArtifactsUnchanged();
      expect(scope.sourceArtifacts[0]!.descriptor).toBe(descriptor);
      expect(fstatSync(descriptor).isFile()).toBe(true);
    });

    expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("closes the verified source descriptor when the callback fails", async () => {
    const f = await proofFixture();
    let descriptor = -1;

    await expect(withVerifiedHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    }, async (scope) => {
      descriptor = scope.sourceArtifacts[0]!.descriptor;
      throw new Error("injected callback failure");
    })).rejects.toThrow("injected callback failure");

    expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it.each([
    ["different bytes", "replacement bytes\n"],
    ["byte-identical new inode", "private evidence\n"],
  ])("binds the verified source descriptor to its original path across the callback: %s", async (_case, replacement) => {
    const f = await proofFixture();
    const artifactPath = join(f.worktree, f.manifest.artifacts[0]!.path);

    await expect(withVerifiedHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    }, async (scope) => {
      await rename(artifactPath, join(f.worktree, ".review", "verified-note.txt"));
      await writeFile(artifactPath, replacement, { mode: 0o600 });
      await scope.assertArtifactsUnchanged();
    })).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "snapshot_changed" },
    });
    await expect(stat(f.worktree)).resolves.toBeDefined();
  });

  it.each(["manifest", "bundle", "artifact backup"] as const)("rejects replacement of the verified %s during the callback", async (target) => {
    const f = await proofFixture();
    const path = target === "manifest" ? f.proofPath : target === "bundle" ? f.manifest.bundle.file : f.manifest.artifacts[0]!.file;
    const original = await readFile(path);

    await expect(withVerifiedHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    }, async (scope) => {
      await rename(path, `${path}.verified`);
      await writeFile(path, original, { mode: 0o600 });
      await scope.assertArtifactsUnchanged();
    })).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "snapshot_changed" },
    });
  });

  it.each(["mode", "link", "parent"] as const)("rejects source artifact %s replacement during the callback", async (mutation) => {
    const f = await proofFixture();
    const artifactPath = join(f.worktree, f.manifest.artifacts[0]!.path);

    await expect(withVerifiedHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    }, async (scope) => {
      if (mutation === "mode") await chmod(artifactPath, 0o640);
      if (mutation === "link") await link(artifactPath, join(f.worktree, ".review", "linked-note.txt"));
      if (mutation === "parent") {
        await rename(join(f.worktree, ".review"), join(f.worktree, ".review-verified"));
        await mkdir(join(f.worktree, ".review"));
        await writeFile(artifactPath, "private evidence\n", { mode: 0o600 });
      }
      await scope.assertArtifactsUnchanged();
    })).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "snapshot_changed" },
    });
  });

  it("rejects source bytes changed while proof verification is in progress", async () => {
    const f = await proofFixture();
    const delegate = new ProcessRunner();
    let changed = false;
    const runner = {
      run: delegate.run.bind(delegate),
      runRaw: async (...args: Parameters<ProcessRunner["runRaw"]>) => {
        const output = await delegate.runRaw(...args);
        const commandArgs = args[1];
        if (!changed && commandArgs.includes("ls-files")) {
          changed = true;
          await writeFile(join(f.worktree, f.manifest.artifacts[0]!.path), "changed during verification\n", { mode: 0o600 });
        }
        return output;
      },
    };

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner, sourceTrust,
    })).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "backup_invalid" },
    });
    await expect(stat(f.worktree)).resolves.toBeDefined();
  });

  it("rejects a source origin that is not the pinned canonical Repository slug", async () => {
    const f = await proofFixture();
    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath,
      history: f.history,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source,
      worktreePath: f.worktree,
      commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug,
      managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(),
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "integration_untrusted" } });
  });

  it.each(["fetch", "push"] as const)("rejects a canonical origin whose effective %s URL alone is retargeted", async (retargeted) => {
    const f = await proofFixture();
    const local = (await git(f.source, "remote", "get-url", "origin")).trim();
    const canonical = "https://github.com/jhw7500/proof.git";
    await git(f.source, "remote", "set-url", "origin", retargeted === "fetch" ? local : canonical);
    await git(f.source, "remote", "set-url", "--push", "origin", retargeted === "push" ? local : canonical);

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(),
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "integration_untrusted" } });
  });

  it("rejects a hash-consistent file that is not a valid full Git bundle", async () => {
    const f = await proofFixture();
    const invalid = Buffer.from("not a git bundle\n");
    await writeFile(f.manifest.bundle.file, invalid, { mode: 0o600 });
    const { createHash } = await import("node:crypto");
    f.manifest.bundle.bytes = invalid.length;
    f.manifest.bundle.sha256 = createHash("sha256").update(invalid).digest("hex");
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "backup_invalid" } });
  });

  it("rejects an artifact backup hardlinked to the worktree source", async () => {
    const f = await proofFixture();
    await unlink(f.manifest.artifacts[0]!.file);
    await link(join(f.worktree, f.manifest.artifacts[0]!.path), f.manifest.artifacts[0]!.file);

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "backup_invalid" } });
  });

  it("compares raw path bytes instead of collapsing invalid UTF-8 names", async () => {
    const f = await proofFixture();
    await writeFile(Buffer.concat([Buffer.from(`${f.worktree}/`), Buffer.from([0x80])]), "same bytes\n");
    await git(f.worktree, "add", "-A");
    await git(f.worktree, "commit", "-m", "raw task path");
    const taskCommit = (await git(f.worktree, "rev-parse", "HEAD")).trim();
    await writeFile(Buffer.concat([Buffer.from(`${f.source}/`), Buffer.from([0x81])]), "same bytes\n");
    await git(f.source, "add", "-A");
    await git(f.source, "commit", "-m", "raw integration path");
    const integrationCommit = (await git(f.source, "rev-parse", "HEAD")).trim();
    await git(f.source, "push", "origin", "main");
    f.history.head_sha = taskCommit;
    f.manifest.worktree_head = taskCommit;
    f.manifest.source_head = integrationCommit;
    f.manifest.commits.push({ worktree_commit: taskCommit, integration_commit: integrationCommit });
    await unlink(f.manifest.bundle.file);
    await git(f.source, "bundle", "create", f.manifest.bundle.file, "--all");
    await chmod(f.manifest.bundle.file, 0o600);
    const bundle = await readFile(f.manifest.bundle.file);
    const { createHash } = await import("node:crypto");
    f.manifest.bundle.bytes = bundle.length;
    f.manifest.bundle.sha256 = createHash("sha256").update(bundle).digest("hex");
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath,
      history: f.history,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source,
      worktreePath: f.worktree,
      commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug,
      managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(),
      sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "patch_mismatch" } });
  });

  it("accepts equal binary executable patches using their exact Git mode and object bytes", async () => {
    const f = await proofFixture();
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x0a]);
    await writeFile(join(f.worktree, "binary-tool"), binary);
    await chmod(join(f.worktree, "binary-tool"), 0o755);
    await git(f.worktree, "add", "binary-tool");
    await git(f.worktree, "commit", "-m", "binary task patch");
    const taskCommit = (await git(f.worktree, "rev-parse", "HEAD")).trim();
    await writeFile(join(f.source, "binary-tool"), binary);
    await chmod(join(f.source, "binary-tool"), 0o755);
    await git(f.source, "add", "binary-tool");
    await git(f.source, "commit", "-m", "binary integration patch");
    const integrationCommit = (await git(f.source, "rev-parse", "HEAD")).trim();
    await git(f.source, "push", "origin", "main");
    f.history.head_sha = taskCommit;
    f.manifest.worktree_head = taskCommit;
    f.manifest.source_head = integrationCommit;
    f.manifest.commits.push({ worktree_commit: taskCommit, integration_commit: integrationCommit });
    await unlink(f.manifest.bundle.file);
    await git(f.source, "bundle", "create", f.manifest.bundle.file, "--all");
    await chmod(f.manifest.bundle.file, 0o600);
    const bundle = await readFile(f.manifest.bundle.file);
    const { createHash } = await import("node:crypto");
    f.manifest.bundle.bytes = bundle.length;
    f.manifest.bundle.sha256 = createHash("sha256").update(bundle).digest("hex");
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).resolves.toMatchObject({ worktreeHead: taskCommit, sourceHead: integrationCommit });
  });

  it("rejects unsupported Git object types even when both commits contain the same symlink", async () => {
    const f = await proofFixture();
    await symlink("tracked.txt", join(f.worktree, "linked"));
    await git(f.worktree, "add", "linked");
    await git(f.worktree, "commit", "-m", "symlink task patch");
    const taskCommit = (await git(f.worktree, "rev-parse", "HEAD")).trim();
    await symlink("tracked.txt", join(f.source, "linked"));
    await git(f.source, "add", "linked");
    await git(f.source, "commit", "-m", "symlink integration patch");
    const integrationCommit = (await git(f.source, "rev-parse", "HEAD")).trim();
    f.history.head_sha = taskCommit;
    f.manifest.worktree_head = taskCommit;
    f.manifest.source_head = integrationCommit;
    f.manifest.commits.push({ worktree_commit: taskCommit, integration_commit: integrationCommit });
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "scope_unsupported" } });
  });

  it("rejects a root integration commit before patch comparison", async () => {
    const f = await proofFixture();
    const rootCommit = (await git(f.source, "rev-list", "--max-parents=0", "HEAD")).trim();
    f.manifest.commits[0]!.integration_commit = rootCommit;
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "scope_unsupported" } });
  });

  it("rejects a merge integration commit before patch comparison", async () => {
    const f = await proofFixture();
    const base = (await git(f.source, "rev-parse", "HEAD^")).trim();
    await git(f.source, "checkout", "-b", "merge-side", base);
    await writeFile(join(f.source, "side.txt"), "side\n", "utf8");
    await git(f.source, "add", "side.txt");
    await git(f.source, "commit", "-m", "side commit");
    await git(f.source, "checkout", "main");
    await git(f.source, "merge", "--no-ff", "merge-side", "-m", "merge side");
    const mergeCommit = (await git(f.source, "rev-parse", "HEAD")).trim();
    f.manifest.source_head = mergeCommit;
    f.manifest.commits[0]!.integration_commit = mergeCommit;
    await refreshProofBundle(f);

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "scope_unsupported" } });
  });

  it("rejects a suffix longer than 32 commits before correspondence", async () => {
    const f = await proofFixture();
    for (let index = 0; index < 32; index += 1) {
      await git(f.worktree, "commit", "--allow-empty", "-m", `extra ${index}`);
    }
    const head = (await git(f.worktree, "rev-parse", "HEAD")).trim();
    f.history.head_sha = head;
    f.manifest.worktree_head = head;
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "scope_unsupported" } });
  });

  it("rejects duplicate integration commits before patch comparison", async () => {
    const f = await proofFixture();
    await git(f.worktree, "commit", "--allow-empty", "-m", "second task commit");
    const secondTask = (await git(f.worktree, "rev-parse", "HEAD")).trim();
    f.history.head_sha = secondTask;
    f.manifest.worktree_head = secondTask;
    f.manifest.commits.push({ worktree_commit: secondTask, integration_commit: f.manifest.commits[0]!.integration_commit });
    await refreshProofBundle(f);

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "integration_untrusted" } });
  });

  it("rejects exact but out-of-order distinct integration commits", async () => {
    const f = await proofFixture();
    const base = (await git(f.worktree, "rev-parse", `${f.manifest.worktree_head}^`)).trim();
    await writeFile(join(f.worktree, "second.txt"), "second\n", "utf8");
    await git(f.worktree, "add", "second.txt");
    await git(f.worktree, "commit", "-m", "task second patch");
    const secondTask = (await git(f.worktree, "rev-parse", "HEAD")).trim();

    await git(f.source, "reset", "--hard", base);
    await writeFile(join(f.source, "second.txt"), "second\n", "utf8");
    await git(f.source, "add", "second.txt");
    await git(f.source, "commit", "-m", "integration second patch first");
    const integrationSecond = (await git(f.source, "rev-parse", "HEAD")).trim();
    await writeFile(join(f.source, "tracked.txt"), "task bytes\n", "utf8");
    await git(f.source, "add", "tracked.txt");
    await git(f.source, "commit", "-m", "integration first patch second");
    const integrationFirst = (await git(f.source, "rev-parse", "HEAD")).trim();

    f.history.head_sha = secondTask;
    f.manifest.worktree_head = secondTask;
    f.manifest.source_head = integrationFirst;
    f.manifest.commits = [
      { worktree_commit: f.manifest.commits[0]!.worktree_commit, integration_commit: integrationFirst },
      { worktree_commit: secondTask, integration_commit: integrationSecond },
    ];
    await refreshProofBundle(f);

    await expect(verifyHistoricalCleanupProof({
      proofPath: f.proofPath, history: f.history, registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256, mappingSha256: f.manifest.mapping_sha256,
      sourcePath: f.source, worktreePath: f.worktree, commonGitDir: f.commonGitDir,
      repositorySlug: f.manifest.repository_slug, managedRoots: [join(f.fixture.root, "state")],
      runner: new ProcessRunner(), sourceTrust,
    })).rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE", details: { reason: "integration_untrusted" } });
  });

  it("removes only the worktree, preserving its branch and external recovery backup", async () => {
    const f = await proofFixture();
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {}, sourceTrust);

    await expect(manager.cleanupReleased(f.history, {
      proofPath: f.proofPath,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      repositorySlug: f.manifest.repository_slug,
      revalidate: async () => undefined,
    })).resolves.toMatchObject({
      removed: true,
      cleanup_policy: "historical-exact-patch-v1",
      branch_preserved: true,
      proof_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(stat(f.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(f.source, "show-ref", "--verify", `refs/heads/${f.history.branch}`)).toContain(f.manifest.worktree_head);
    await expect(stat(f.manifest.bundle.file)).resolves.toBeDefined();
    await expect(stat(f.manifest.artifacts[0]!.file)).resolves.toBeDefined();
  });

  it.each(["branch SHA", "symbolic HEAD", "fetch URL", "push URL"] as const)(
    "preserves the worktree and backup when the remote %s changes at the final callback fence",
    async (changed) => {
      const f = await proofFixture();
      const remote = (await git(f.source, "remote", "get-url", "origin")).trim();
      await git(f.source, "remote", "set-url", "origin", "https://github.com/jhw7500/proof.git");
      const delegate = new ProcessRunner();
      let removeAttempts = 0;
      const runner = {
        run: async (...args: Parameters<ProcessRunner["run"]>) => {
          const [command, commandArgs, options] = args;
          if (commandArgs.includes("worktree") && commandArgs.includes("remove")) removeAttempts += 1;
          // Keep production origin validation; only route network transport to the real local bare repository.
          const transportArgs = commandArgs.includes("ls-remote")
            ? commandArgs.map((arg) => arg === "origin" ? remote : arg)
            : commandArgs;
          return delegate.run(command, transportArgs, options);
        },
        runRaw: delegate.runRaw.bind(delegate),
      };
      const manager = new WorktreeManager(configFor(f.fixture.registryDir), runner);
      const backups = [f.proofPath, f.manifest.bundle.file, f.manifest.artifacts[0]!.file];
      const originalBytes = await Promise.all(backups.map((path) => readFile(path)));
      let validations = 0;

      await expect(manager.cleanupReleased(f.history, {
        proofPath: f.proofPath,
        registryHead: f.manifest.registry_head,
        historySha256: f.manifest.history_sha256,
        repositorySlug: f.manifest.repository_slug,
        revalidate: async () => {
          validations += 1;
          if (changed === "branch SHA") {
            await git(remote, "update-ref", "refs/heads/main", `${f.manifest.source_head}^`);
          } else if (changed === "symbolic HEAD") {
            await git(remote, "symbolic-ref", "HEAD", "refs/heads/other");
          } else {
            await git(f.source, "remote", "set-url", ...(changed === "push URL" ? ["--push"] : []),
              "origin", "https://github.com/other/untrusted.git");
          }
        },
      })).rejects.toMatchObject({
        code: "WORKTREE_EQUIVALENCE_UNSAFE",
        details: { reason: "integration_untrusted" },
      });

      expect(validations).toBe(1);
      expect(removeAttempts).toBe(0);
      await expect(stat(f.worktree)).resolves.toBeDefined();
      expect((await git(f.source, "rev-parse", "HEAD")).trim()).toBe(f.manifest.source_head);
      expect(await git(f.source, "show-ref", "--verify", `refs/heads/${f.history.branch}`)).toContain(f.manifest.worktree_head);
      const state = JSON.parse(await readFile(join(f.fixture.root, "state", "worktrees.json"), "utf8"));
      expect(state.worktrees[f.history.worktree_ref].lifecycle).toBe("pending-remove-equivalent");
      expect(await Promise.all(backups.map((path) => readFile(path)))).toEqual(originalBytes);
    },
  );

  it.each([
    "artifact bytes", "artifact inode", "ignored inventory", "source HEAD",
    "worktree HEAD", "worktree status", "mapping",
  ] as const)("rejects %s changed during the final source-trust check", async (changed) => {
    const f = await proofFixture();
    const artifactPath = join(f.worktree, f.manifest.artifacts[0]!.path);
    const statePath = join(f.fixture.root, "state", "worktrees.json");
    const delegate = new ProcessRunner();
    let removeAttempts = 0;
    const runner = {
      run: async (...args: Parameters<ProcessRunner["run"]>) => {
        if (args[1].includes("worktree") && args[1].includes("remove")) removeAttempts += 1;
        return delegate.run(...args);
      },
      runRaw: delegate.runRaw.bind(delegate),
    };
    let trustChecks = 0;
    const delayedTrust = {
      assertTrustedSource: async () => {
        trustChecks += 1;
        if (trustChecks !== 2) return;
        if (changed === "artifact bytes" || changed === "artifact inode") {
          await unlink(artifactPath);
          await writeFile(artifactPath, changed === "artifact bytes" ? "new unbacked bytes\n" : "private evidence\n", { mode: 0o600 });
        } else if (changed === "ignored inventory") {
          await writeFile(join(f.worktree, ".review", "new-note.txt"), "new unbacked evidence\n", { mode: 0o600 });
        } else if (changed === "source HEAD" || changed === "worktree HEAD") {
          await git(changed === "source HEAD" ? f.source : f.worktree, "commit", "--allow-empty", "-m", "concurrent change");
        } else if (changed === "worktree status") {
          await writeFile(join(f.worktree, "tracked.txt"), "concurrent unsaved change\n", "utf8");
        } else {
          const state = JSON.parse(await readFile(statePath, "utf8"));
          state.worktrees[f.history.worktree_ref].session_id = "changed-during-source-trust";
          await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        }
      },
    };
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), runner, {}, delayedTrust);
    const backups = [f.proofPath, f.manifest.bundle.file, f.manifest.artifacts[0]!.file];
    const originalBackups = await Promise.all(backups.map((path) => readFile(path)));

    await expect(manager.cleanupReleased(f.history, {
      proofPath: f.proofPath,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      repositorySlug: f.manifest.repository_slug,
      revalidate: async () => undefined,
    })).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "snapshot_changed" },
    });

    expect(trustChecks).toBe(2);
    expect(removeAttempts).toBe(0);
    await expect(stat(f.worktree)).resolves.toBeDefined();
    const head = (await git(f.worktree, "rev-parse", "HEAD")).trim();
    expect(await git(f.source, "show-ref", "--verify", `refs/heads/${f.history.branch}`)).toContain(head);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.worktrees[f.history.worktree_ref].lifecycle).toBe("pending-remove-equivalent");
    expect(await Promise.all(backups.map((path) => readFile(path)))).toEqual(originalBackups);
    if (changed === "artifact bytes") expect(await readFile(artifactPath, "utf8")).toBe("new unbacked bytes\n");
    if (changed === "ignored inventory") {
      expect(await readFile(join(f.worktree, ".review", "new-note.txt"), "utf8")).toBe("new unbacked evidence\n");
    }
    if (changed === "worktree status") expect(await readFile(join(f.worktree, "tracked.txt"), "utf8")).toBe("concurrent unsaved change\n");
    if (changed === "mapping") expect(state.worktrees[f.history.worktree_ref].session_id).toBe("changed-during-source-trust");
  });

  it("does not authorize active removal by validating a swapped public bundle instead of manifest-bound bytes", async () => {
    const f = await proofFixture();
    const validBundle = await readFile(f.manifest.bundle.file);
    const invalidBundle = Buffer.from("manifest-bound but not a bundle\n");
    const { createHash } = await import("node:crypto");
    await writeFile(f.manifest.bundle.file, invalidBundle, { mode: 0o600 });
    f.manifest.bundle.bytes = invalidBundle.length;
    f.manifest.bundle.sha256 = createHash("sha256").update(invalidBundle).digest("hex");
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });
    const { runner, consumedBundlePaths } = bundleSwapRestoreRunner(f.manifest.bundle.file, validBundle);
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), runner, {}, sourceTrust);

    await expect(manager.cleanupReleased(f.history, {
      proofPath: f.proofPath,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      repositorySlug: f.manifest.repository_slug,
      revalidate: async () => undefined,
    })).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "backup_invalid" },
    });
    expect(consumedBundlePaths.length).toBeGreaterThan(0);
    expect(consumedBundlePaths).not.toContain(f.manifest.bundle.file);
    await expect(stat(f.worktree)).resolves.toBeDefined();
  });

  it.each([
    ["different bytes", "replacement bytes\n"],
    ["byte-identical new inode", "private evidence\n"],
  ])("rejects an artifact path swapped at the final callback fence: %s", async (_case, replacement) => {
    const f = await proofFixture();
    const manager = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {}, sourceTrust);
    let validations = 0;

    await expect(manager.cleanupReleased(f.history, {
      proofPath: f.proofPath,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      repositorySlug: f.manifest.repository_slug,
      revalidate: async () => {
        validations += 1;
        if (validations !== 1) return;
        const artifactPath = join(f.worktree, f.manifest.artifacts[0]!.path);
        await rename(artifactPath, join(f.worktree, ".review", "old-note.txt"));
        await writeFile(artifactPath, replacement, { mode: 0o600 });
      },
    })).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "snapshot_changed" },
    });
    await expect(stat(f.worktree)).resolves.toBeDefined();
  });

  it("preserves the full artifact inventory and resumes with the same proof after Git removal fails", async () => {
    const f = await proofFixture();
    const delegate = new ProcessRunner();
    let failed = false;
    const runner = {
      run: async (command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]) => {
        if (!failed && command === "git" && args.includes("worktree") && args.includes("remove")) {
          failed = true;
          throw new Error("injected git worktree remove failure");
        }
        return delegate.run(command, args, options);
      },
      runRaw: delegate.runRaw.bind(delegate),
    };
    const options = {
      proofPath: f.proofPath,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      repositorySlug: f.manifest.repository_slug,
      revalidate: async () => undefined,
    };
    const failing = new WorktreeManager(configFor(f.fixture.registryDir), runner, {}, sourceTrust);

    await expect(failing.cleanupReleased(f.history, options)).rejects.toThrow("injected git worktree remove failure");
    await expect(readFile(join(f.worktree, f.manifest.artifacts[0]!.path), "utf8")).resolves.toBe("private evidence\n");
    const retry = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {}, sourceTrust);
    await expect(retry.cleanupReleased(f.history, options)).resolves.toMatchObject({
      removed: true,
      cleanup_policy: "historical-exact-patch-v1",
    });
  });

  it("resumes an absent checkout only with the same proof after tombstone persistence fails", async () => {
    const f = await proofFixture();
    let saves = 0;
    const options = {
      proofPath: f.proofPath,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      repositorySlug: f.manifest.repository_slug,
      revalidate: async () => undefined,
    };
    const failing = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {
      beforeSave: () => {
        saves += 1;
        if (saves === 2) throw new Error("injected final tombstone failure");
      },
    }, sourceTrust);

    await expect(failing.cleanupReleased(f.history, options)).rejects.toThrow("injected final tombstone failure");
    await expect(stat(f.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    const retry = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {}, sourceTrust);

    await git(f.source, "worktree", "add", "--detach", f.worktree, f.manifest.source_head);
    await rm(f.worktree, { recursive: true, force: true });
    await expect(retry.cleanupReleased(f.history, options)).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "snapshot_changed" },
    });
    await git(f.source, "worktree", "prune", "--expire", "now");

    await git(f.source, "update-ref", `refs/heads/${f.history.branch}`, f.manifest.source_head);
    await expect(retry.cleanupReleased(f.history, options)).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "snapshot_changed" },
    });
    await git(f.source, "update-ref", `refs/heads/${f.history.branch}`, f.manifest.worktree_head);

    await expect(retry.cleanupReleased(f.history, { ...options, proofPath: join(f.backup, "other.json") }))
      .rejects.toMatchObject({ code: "WORKTREE_EQUIVALENCE_UNSAFE" });
    await expect(retry.cleanupReleased(f.history, options)).resolves.toMatchObject({
      removed: true,
      recovered: true,
      cleanup_policy: "historical-exact-patch-v1",
    });
  });

  it("does not complete absent-checkout recovery by validating a swapped public bundle", async () => {
    const f = await proofFixture();
    const validBundle = await readFile(f.manifest.bundle.file);
    let saves = 0;
    const options = {
      proofPath: f.proofPath,
      registryHead: f.manifest.registry_head,
      historySha256: f.manifest.history_sha256,
      repositorySlug: f.manifest.repository_slug,
      revalidate: async () => undefined,
    };
    const removing = new WorktreeManager(configFor(f.fixture.registryDir), new ProcessRunner(), {
      beforeSave: () => {
        saves += 1;
        if (saves === 2) throw new Error("injected final tombstone failure");
      },
    }, sourceTrust);
    await expect(removing.cleanupReleased(f.history, options)).rejects.toThrow("injected final tombstone failure");
    await expect(stat(f.worktree)).rejects.toMatchObject({ code: "ENOENT" });

    const invalidBundle = Buffer.from("manifest-bound but not a bundle\n");
    const { createHash } = await import("node:crypto");
    await writeFile(f.manifest.bundle.file, invalidBundle, { mode: 0o600 });
    f.manifest.bundle.bytes = invalidBundle.length;
    f.manifest.bundle.sha256 = createHash("sha256").update(invalidBundle).digest("hex");
    await writeFile(f.proofPath, `${JSON.stringify(f.manifest)}\n`, { mode: 0o600 });
    const proofSha256 = createHash("sha256").update(await readFile(f.proofPath)).digest("hex");
    const statePath = join(f.fixture.root, "state", "worktrees.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.worktrees[f.history.worktree_ref].cleanup_intent.proof_sha256 = proofSha256;
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await chmod(statePath, 0o600);

    const { runner, consumedBundlePaths } = bundleSwapRestoreRunner(f.manifest.bundle.file, validBundle);
    const retry = new WorktreeManager(configFor(f.fixture.registryDir), runner, {}, sourceTrust);
    await expect(retry.cleanupReleased(f.history, options)).rejects.toMatchObject({
      code: "WORKTREE_EQUIVALENCE_UNSAFE",
      details: { reason: "backup_invalid" },
    });
    expect(consumedBundlePaths.length).toBeGreaterThan(0);
    expect(consumedBundlePaths).not.toContain(f.manifest.bundle.file);
    const unchanged = JSON.parse(await readFile(statePath, "utf8"));
    expect(unchanged.worktrees[f.history.worktree_ref].lifecycle).toBe("pending-remove-equivalent");
  });
});
