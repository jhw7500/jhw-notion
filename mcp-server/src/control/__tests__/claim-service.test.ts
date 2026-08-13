import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Catalog } from "../catalog.js";
import { ClaimService, type ClaimInspection } from "../claim-service.js";
import { ProcessRunner } from "../process.js";
import { RegistryGit } from "../registry-git.js";
import { commitFile, configFor, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

const fixtures: RegistryFixture[] = [];
const fixedNow = new Date("2026-08-13T12:34:56.789Z");

const inspection: ClaimInspection = {
  async inspect(): Promise<{ process_exists: boolean; worktree_mapped: boolean; dirty: boolean; ahead: number }> {
    return { process_exists: false, worktree_mapped: true, dirty: true, ahead: 2 };
  },
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function claimsFixture(now: () => Date = () => fixedNow): Promise<{
  fixture: RegistryFixture;
  claims: ClaimService;
  task: Awaited<ReturnType<Catalog["registerTemporaryTask"]>>;
}> {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const config = configFor(fixture.registryDir);
  const registry = new RegistryGit(config, new ProcessRunner());
  const catalog = new Catalog(config, registry);
  const task = await catalog.registerTemporaryTask({
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    alias: "wlan:tmp-20260813-01-fix",
    goal: "fix roaming regression",
    done_conditions: ["targeted test passes"],
    expected_scope: ["src/roaming.ts"],
  });
  return {
    fixture,
    claims: new ClaimService(config, registry, catalog, inspection, now),
    task,
  };
}

function claimInput(
  taskId: string,
  overrides: Partial<{
    session_id: string;
    host: string;
    branch: string;
    worktree_ref: string;
  }> = {},
) {
  return {
    task_id: taskId,
    task_alias: "wlan:tmp-20260813-01-fix",
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    host: "cantopsbuildserver",
    branch: "task/wlan-roaming-fix",
    worktree_ref: "/srv/jhw/worktrees/wlan-roaming-fix",
    session_id: "codex-a",
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function historyRelativePath(active: { task_id: string; claim_id: string }): string {
  return `claims/history/2026/${active.task_id}/${active.claim_id}.yaml`;
}

function handoffRelativePath(active: { task_id: string; claim_id: string }): string {
  return `handoffs/${active.task_id}/${active.claim_id}.md`;
}

async function commitRegistryFile(fixture: RegistryFixture, path: string, content: string): Promise<void> {
  await commitFile(fixture.registryDir, path, content);
  await git(fixture.registryDir, "push", "origin", "main");
}

describe("ClaimService", () => {
  it("rejects a second active Claim for the same canonical Task", async () => {
    const { claims, task } = await claimsFixture();
    const ownerA = claimInput(task.id, { session_id: "codex-a" });
    const ownerB = claimInput(task.id, { session_id: "codex-b" });
    const first = await claims.claimTask(ownerA);

    await expect(claims.claimTask(ownerB)).rejects.toMatchObject({ code: "TASK_ALREADY_CLAIMED" });
    expect((await claims.getActive(first.task_id))?.claim_id).toBe(first.claim_id);
  });

  it("cannot release a Claim owned by another generation", async () => {
    const { claims, task } = await claimsFixture();
    const first = await claims.claimTask(claimInput(task.id, { session_id: "codex-a" }));

    await expect(
      claims.finishClaim(first.task_id, "clm-00000000-0000-7000-8000-000000000000", {
        status: "completed",
        branch: "task/example",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
      }),
    ).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
  });

  it("takeover archives the old Claim and installs a fresh configured-host Claim atomically", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id, { session_id: "codex-a", host: "old-build-host" }));

    const recovered = await claims.recoverClaim(first.task_id, first.claim_id, {
      kind: "takeover",
      session_id: "codex-new",
    });

    expect(recovered.active.claim_id).not.toBe(first.claim_id);
    expect(recovered.active.session_id).toBe("codex-new");
    expect(recovered.active.host).toBe("cantopsbuildserver");
    expect(new Date(recovered.active.started_at).getTime()).toBeGreaterThan(new Date(first.started_at).getTime());
    expect(recovered.history).toMatchObject({
      claim_id: first.claim_id,
      status: "taken-over",
      session_id: "codex-a",
      host: "old-build-host",
    });
    await expect(claims.assertOwner(first.task_id, first.claim_id)).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
    expect(await claims.assertOwner(first.task_id, recovered.active.claim_id)).toEqual(recovered.active);
    expect(await exists(join(fixture.registryDir, "claims", "history", "2026", first.task_id, `${first.claim_id}.yaml`))).toBe(true);
  });

  it("finishes by atomically archiving the expected Claim and removing the active record", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));

    const history = await claims.finishClaim(active.task_id, active.claim_id, {
      status: "completed",
      outcome: "implemented roaming fix",
      branch: "task/wlan-roaming-fix",
      head_sha: "0123456789abcdef",
      validation: ["npm test: pass", "npm run build: pass"],
    });

    expect(history).toMatchObject({
      claim_id: active.claim_id,
      status: "completed",
      released_at: fixedNow.toISOString(),
      validation_summary: "npm test: pass\nnpm run build: pass",
    });
    expect(await claims.getActive(active.task_id)).toBeUndefined();
    expect(
      JSON.parse(
        await readFile(
          join(fixture.registryDir, "claims", "history", "2026", active.task_id, `${active.claim_id}.yaml`),
          "utf8",
        ),
      ),
    ).toEqual(history);
  });

  it("fails closed for a valid existing completed-history path and retains the active Claim", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    await commitRegistryFile(
      fixture,
      historyRelativePath(active),
      `${JSON.stringify({
        ...active,
        claim_id: "clm-00000000-0000-7000-8000-000000000000",
        released_at: fixedNow.toISOString(),
        status: "completed",
      })}\n`,
    );

    await expect(
      claims.finishClaim(active.task_id, active.claim_id, {
        status: "completed",
        branch: "task/wlan-roaming-fix",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await claims.getActive(active.task_id)).toEqual(active);
  });

  it("fails closed for an invalid existing force-end history path and retains the active Claim", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    await commitRegistryFile(fixture, historyRelativePath(active), "not a ClaimHistory record\n");

    await expect(claims.recoverClaim(active.task_id, active.claim_id, { kind: "force-end" })).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
    });
    expect(await claims.getActive(active.task_id)).toEqual(active);
  });

  it("fails closed for a non-regular existing takeover history path and retains the active Claim", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    await commitRegistryFile(fixture, `${historyRelativePath(active)}/marker`, "directory entry\n");

    await expect(
      claims.recoverClaim(active.task_id, active.claim_id, { kind: "takeover", session_id: "codex-new" }),
    ).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await claims.getActive(active.task_id)).toEqual(active);
  });

  it("rejects a missing canonical Handoff pointer and retains the active Claim", async () => {
    const { claims, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));

    await expect(
      claims.finishClaim(active.task_id, active.claim_id, {
        status: "handoff",
        branch: "task/wlan-roaming-fix",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
        handoff_path: handoffRelativePath(active),
      }),
    ).rejects.toMatchObject({ code: "HANDOFF_MISSING" });
    expect(await claims.getActive(active.task_id)).toEqual(active);
  });

  it("rejects a non-regular canonical Handoff pointer and retains the active Claim", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    await commitRegistryFile(fixture, `${handoffRelativePath(active)}/marker`, "directory entry\n");

    await expect(
      claims.finishClaim(active.task_id, active.claim_id, {
        status: "handoff",
        branch: "task/wlan-roaming-fix",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
        handoff_path: handoffRelativePath(active),
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await claims.getActive(active.task_id)).toEqual(active);
  });

  it("finishes only after the canonical Handoff file is durably committed", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    await commitRegistryFile(fixture, handoffRelativePath(active), "# Handoff\n\nDurable content.\n");

    const history = await claims.finishClaim(active.task_id, active.claim_id, {
      status: "handoff",
      branch: "task/wlan-roaming-fix",
      head_sha: "0123456789abcdef",
      validation: ["npm test: pass"],
      handoff_path: handoffRelativePath(active),
    });

    expect(history).toMatchObject({ status: "handoff", handoff_path: handoffRelativePath(active) });
    expect(await claims.getActive(active.task_id)).toBeUndefined();
  });

  it("reports recovery status without creating a Registry commit", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const head = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    const result = await claims.recoverClaim(active.task_id, active.claim_id, { kind: "status" });

    expect(result).toEqual({
      kind: "status",
      active,
      recorded: { host: "cantopsbuildserver", session_id: "codex-a" },
      process_exists: false,
      worktree_mapped: true,
      dirty: true,
      ahead: 2,
    });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await git(fixture.registryDir, "status", "--porcelain")).toBe("");
  });

  it("force-ends only the expected active Claim", async () => {
    const { claims, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));

    await expect(
      claims.recoverClaim(task.id, "clm-00000000-0000-7000-8000-000000000000", { kind: "force-end" }),
    ).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
    const result = await claims.recoverClaim(active.task_id, active.claim_id, { kind: "force-end" });

    expect(result).toMatchObject({ history: { claim_id: active.claim_id, status: "force-ended" } });
    await expect(claims.assertOwner(active.task_id, active.claim_id)).rejects.toMatchObject({ code: "CLAIM_NOT_FOUND" });
  });

  it("validates public Task and Claim IDs before constructing Registry paths", async () => {
    const { claims, fixture } = await claimsFixture();
    const escapedActivePath = join(fixture.registryDir, "escaped.yaml");
    await writeFile(escapedActivePath, "not a claim\n", "utf8");

    await expect(claims.getActive("../escaped")).rejects.toMatchObject({ code: "INVALID_TASK_ID" });
    await expect(claims.assertOwner("../escaped", "clm-00000000-0000-7000-8000-000000000000")).rejects.toMatchObject({
      code: "INVALID_TASK_ID",
    });
    await expect(
      claims.finishClaim("tsk-00000000-0000-7000-8000-000000000000", "../escaped", {
        status: "completed",
        branch: "task/example",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CLAIM_ID" });
    expect(await readFile(escapedActivePath, "utf8")).toBe("not a claim\n");
  });

  it("fails closed when the active Claim record does not match its canonical Task", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    await writeFile(
      join(fixture.registryDir, "claims", "active", `${active.task_id}.yaml`),
      `${JSON.stringify({ ...active, project_id: "prj-other" })}\n`,
      "utf8",
    );

    await expect(claims.assertOwner(active.task_id, active.claim_id)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
    });
  });
});
