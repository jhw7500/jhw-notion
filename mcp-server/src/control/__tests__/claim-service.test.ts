import { link, mkdir, readFile, rename, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Catalog } from "../catalog.js";
import { ClaimService, type ClaimInspection } from "../claim-service.js";
import { ControlError } from "../errors.js";
import { ProcessRunner } from "../process.js";
import { RegistryGit } from "../registry-git.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "../sensitive-data.js";
import { taskCompletionEvidenceDigest } from "../task-completion.js";
import { normalizeWorkContract, workContractDigest } from "../work-contract.js";
import { commitFile, configFor, emptyTaskContractIntent, git, isolatedRegistryGit, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

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

async function claimsFixture(now: () => Date = () => fixedNow, sensitiveData?: SensitiveDataPolicy): Promise<{
  fixture: RegistryFixture;
  claims: ClaimService;
  catalog: Catalog;
  task: Awaited<ReturnType<Catalog["registerTemporaryTask"]>>;
}> {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const config = configFor(fixture.registryDir);
  const registry = isolatedRegistryGit(config, new ProcessRunner());
  const catalog = new Catalog(config, registry, undefined, {
    assertKnownContract: async () => undefined,
    assertKnownRequirement: async () => undefined,
  });
  await catalog.registerRepository({ repo_id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" });
  const task = await catalog.registerTemporaryTask({
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    alias: "wlan:tmp-20260813-01-fix",
    goal: "fix roaming regression",
    done_conditions: ["targeted test passes"],
    expected_scope: ["src/roaming.ts"],
    ...emptyTaskContractIntent(),
  });
  return {
    fixture,
    claims: new ClaimService(config, registry, catalog, inspection, now, sensitiveData),
    catalog,
    task,
  };
}

async function formalClaimsFixture(taskRole: "standalone" | "parent" = "standalone") {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const config = configFor(fixture.registryDir);
  const registry = isolatedRegistryGit(config, new ProcessRunner());
  const catalog = new Catalog(config, registry, undefined, {
    assertKnownContract: async () => undefined,
    assertKnownRequirement: async () => undefined,
  });
  await catalog.registerRepository({ repo_id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" });
  const task = (await catalog.registerFormalTask({
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    issue_node_id: "I_wlan_1",
    issue_revision: "2026-08-25T00:00:00Z",
    issue_url: "https://github.com/jhw7500/wlan/issues/1",
    alias: "jhw7500/wlan#1",
    task_role: taskRole,
    grants: [],
    dependencies: [],
  })).task;
  let clockTick = 0;
  return {
    fixture,
    catalog,
    task,
    claims: new ClaimService(config, registry, catalog, inspection, () =>
      new Date(fixedNow.getTime() + clockTick++ * 1_000)),
  };
}

function claimInput(
  taskId: string,
  overrides: Partial<{
    task_alias: string;
    project_id: string;
    repo_id: string;
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

async function commitRegistrySymlink(fixture: RegistryFixture, path: string, target: string): Promise<void> {
  const link = join(fixture.registryDir, path);
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
  await git(fixture.registryDir, "add", "--", path);
  await git(fixture.registryDir, "commit", "-m", `Add symlink ${path}`);
  await git(fixture.registryDir, "push", "origin", "main");
}

async function replaceActiveWithExternalSymlink(
  fixture: RegistryFixture,
  active: { task_id: string; claim_id: string },
  content: string,
): Promise<{ externalDir: string; externalPath: string }> {
  const externalDir = join(fixture.root, `external-active-${active.claim_id}`);
  const externalPath = join(externalDir, `${active.task_id}.yaml`);
  await mkdir(externalDir, { recursive: true });
  await writeFile(externalPath, content, "utf8");
  await unlink(join(fixture.registryDir, "claims", "active", `${active.task_id}.yaml`));
  await rmdir(join(fixture.registryDir, "claims", "active"));
  await symlink(externalDir, join(fixture.registryDir, "claims", "active"));
  await git(fixture.registryDir, "add", "-A", "--", "claims/active");
  await git(fixture.registryDir, "commit", "-m", "Redirect active claims");
  await git(fixture.registryDir, "push", "origin", "main");
  return { externalDir, externalPath };
}

describe("ClaimService", () => {
  it("records immutable standalone completion evidence for the exact active owner", async () => {
    const { claims, task, fixture } = await formalClaimsFixture();
    const active = await claims.claimTask(claimInput(task.id, { task_alias: task.aliases[0] }));
    const evidence = { integration_validation: ["npm test: pass"], child_dispositions: [] };
    const taskPath = join(fixture.registryDir, "tasks", `${task.id}.yaml`);
    const issueBytes = await readFile(taskPath, "utf8");

    const first = await claims.markCompletionReady(task.id, active.claim_id, evidence);
    const evidencePath = join(fixture.registryDir, "task-completion", task.id, `${active.claim_id}.yaml`);
    const bytes = await readFile(evidencePath, "utf8");
    const head = await git(fixture.registryDir, "rev-parse", "HEAD");
    const retry = await claims.markCompletionReady(task.id, active.claim_id, evidence);

    expect(first).toEqual({
      version: 1,
      task_id: task.id,
      claim_id: active.claim_id,
      work_contract_digest: active.work_contract_digest,
      recorded_at: new Date(fixedNow.getTime() + 1_000).toISOString(),
      evidence,
    });
    expect(retry).toEqual(first);
    expect(await readFile(evidencePath, "utf8")).toBe(bytes);
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(taskPath, "utf8")).toBe(issueBytes);
    await expect(claims.assertOwner(task.id, active.claim_id)).resolves.toEqual(active);
  });

  it("rejects changed or non-owner evidence without any Registry write", async () => {
    const { claims, task, fixture } = await formalClaimsFixture();
    const active = await claims.claimTask(claimInput(task.id, { task_alias: task.aliases[0] }));
    await claims.markCompletionReady(task.id, active.claim_id, {
      integration_validation: ["npm test: pass"], child_dispositions: [],
    });
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");

    await expect(claims.markCompletionReady(task.id, active.claim_id, {
      integration_validation: ["npm test: changed"], child_dispositions: [],
    })).rejects.toMatchObject({ code: "COMPLETION_EVIDENCE_CONFLICT" });
    await expect(claims.markCompletionReady(
      task.id,
      "clm-018f21e0-7b2c-7a00-8000-000000000099",
      { integration_validation: ["npm test: pass"], child_dispositions: [] },
    )).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("requires parent gates before writing evidence", async () => {
    const { claims, task, catalog, fixture } = await formalClaimsFixture("parent");
    const active = await claims.claimTask(claimInput(task.id, { task_alias: task.aliases[0] }));
    await catalog.registerChildTask({
      parent_task_id: task.id,
      alias: "wlan:required-child",
      required_for_parent: true,
      goal: "required work",
      done_conditions: ["done"],
      grants: [],
      dependencies: [],
    });
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");

    await expect(claims.markCompletionReady(task.id, active.claim_id, {
      integration_validation: ["npm test: pass"], child_dispositions: [],
    })).rejects.toMatchObject({ code: "PARENT_CHILDREN_INCOMPLETE" });
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
    await expect(readFile(join(
      fixture.registryDir, "task-completion", task.id, `${active.claim_id}.yaml`,
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates parent readiness at completed release after a new required child is registered", async () => {
    const { claims, task, catalog, fixture } = await formalClaimsFixture("parent");
    const active = await claims.claimTask(claimInput(task.id, { task_alias: task.aliases[0] }));
    await claims.markCompletionReady(task.id, active.claim_id, {
      integration_validation: ["npm test: pass"],
      child_dispositions: [],
    });
    await catalog.registerChildTask({
      parent_task_id: task.id,
      alias: "wlan:late-required-child",
      required_for_parent: true,
      goal: "late required work",
      done_conditions: ["done"],
      grants: [],
      dependencies: [],
    });
    const activePath = join(fixture.registryDir, "claims", "active", `${task.id}.yaml`);
    const evidencePath = join(fixture.registryDir, "task-completion", task.id, `${active.claim_id}.yaml`);
    const activeBytes = await readFile(activePath, "utf8");
    const evidenceBytes = await readFile(evidencePath, "utf8");
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");

    await expect(claims.finishClaim(task.id, active.claim_id, {
      status: "completed",
      outcome: "done",
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    })).rejects.toMatchObject({ code: "PARENT_CHILDREN_INCOMPLETE" });

    expect(await readFile(activePath, "utf8")).toBe(activeBytes);
    expect(await readFile(evidencePath, "utf8")).toBe(evidenceBytes);
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
    await expect(readFile(join(fixture.registryDir, historyRelativePath(active))))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates standalone empty dispositions at completed release", async () => {
    const { claims, task, fixture } = await formalClaimsFixture();
    const active = await claims.claimTask(claimInput(task.id, { task_alias: task.aliases[0] }));
    const evidence = await claims.markCompletionReady(task.id, active.claim_id, {
      integration_validation: ["npm test: pass"],
      child_dispositions: [],
    });
    const evidenceRelative = `task-completion/${task.id}/${active.claim_id}.yaml`;
    await commitRegistryFile(fixture, evidenceRelative, `${JSON.stringify({
      ...evidence,
      evidence: {
        ...evidence.evidence,
        child_dispositions: [{
          task_id: "tsk-018f21e0-7b2c-7a00-8000-000000000099",
          disposition: "accepted-risk",
        }],
      },
    }, null, 2)}\n`);
    const activePath = join(fixture.registryDir, "claims", "active", `${task.id}.yaml`);
    const evidencePath = join(fixture.registryDir, evidenceRelative);
    const activeBytes = await readFile(activePath, "utf8");
    const evidenceBytes = await readFile(evidencePath, "utf8");
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");

    await expect(claims.finishClaim(task.id, active.claim_id, {
      status: "completed",
      outcome: "done",
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    })).rejects.toMatchObject({ code: "INVALID_PARENT_COMPLETION" });

    expect(await readFile(activePath, "utf8")).toBe(activeBytes);
    expect(await readFile(evidencePath, "utf8")).toBe(evidenceBytes);
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
    await expect(readFile(join(fixture.registryDir, historyRelativePath(active))))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses formal completion evidence on temporary and child Task flows", async () => {
    const temporary = await claimsFixture();
    const temporaryClaim = await temporary.claims.claimTask(claimInput(temporary.task.id));
    const temporaryHead = await git(temporary.fixture.registryDir, "rev-parse", "HEAD");
    await expect(temporary.claims.markCompletionReady(temporary.task.id, temporaryClaim.claim_id, {
      integration_validation: ["npm test: pass"], child_dispositions: [],
    })).rejects.toMatchObject({ code: "TASK_COMPLETION_FORMAL_REQUIRED" });
    expect(await git(temporary.fixture.registryDir, "rev-parse", "HEAD")).toBe(temporaryHead);

    const formal = await formalClaimsFixture("parent");
    const child = await formal.catalog.registerChildTask({
      parent_task_id: formal.task.id,
      alias: "wlan:no-formal-evidence",
      required_for_parent: false,
      goal: "child work",
      done_conditions: ["done"],
      grants: [],
      dependencies: [],
    });
    const childClaim = await formal.claims.claimTask(claimInput(child.id, {
      task_alias: child.aliases[0],
      session_id: "codex-child-evidence",
    }));
    const childHead = await git(formal.fixture.registryDir, "rev-parse", "HEAD");
    await expect(formal.claims.markCompletionReady(child.id, childClaim.claim_id, {
      integration_validation: ["npm test: pass"], child_dispositions: [],
    })).rejects.toMatchObject({ code: "TASK_COMPLETION_FORMAL_REQUIRED" });
    expect(await git(formal.fixture.registryDir, "rev-parse", "HEAD")).toBe(childHead);
  });

  it("requires exact evidence to complete a formal Claim and copies its pointer and digest only to completed history", async () => {
    const { claims, task, fixture } = await formalClaimsFixture();
    const active = await claims.claimTask(claimInput(task.id, { task_alias: task.aliases[0] }));
    const finish = {
      status: "completed" as const,
      outcome: "done",
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    };

    await expect(claims.finishClaim(task.id, active.claim_id, finish)).rejects.toMatchObject({
      code: "COMPLETION_EVIDENCE_REQUIRED",
    });
    await expect(claims.assertOwner(task.id, active.claim_id)).resolves.toEqual(active);
    const record = await claims.markCompletionReady(task.id, active.claim_id, {
      integration_validation: ["npm test: pass"], child_dispositions: [],
    });
    const issueBytes = await readFile(join(fixture.registryDir, "tasks", `${task.id}.yaml`), "utf8");
    const history = await claims.finishClaim(task.id, active.claim_id, finish);

    expect(history).toMatchObject({
      status: "completed",
      completion_evidence_path: `task-completion/${task.id}/${active.claim_id}.yaml`,
      completion_evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      work_contract_digest: record.work_contract_digest,
    });
    expect(history.completion_evidence_digest).toBe(taskCompletionEvidenceDigest(record));
    expect(await readFile(join(fixture.registryDir, "tasks", `${task.id}.yaml`), "utf8")).toBe(issueBytes);
    await expect(claims.getActive(task.id)).resolves.toBeUndefined();
  });

  it("keeps old evidence historical but unusable after handoff and reclaim", async () => {
    const { claims, task, fixture } = await formalClaimsFixture();
    const first = await claims.claimTask(claimInput(task.id, { task_alias: task.aliases[0] }));
    const oldEvidence = await claims.markCompletionReady(task.id, first.claim_id, {
      integration_validation: ["npm test: first"], child_dispositions: [],
    });
    await commitRegistryFile(fixture, handoffRelativePath(first), "# committed handoff fixture\n");
    await claims.finishClaim(task.id, first.claim_id, {
      status: "handoff",
      branch: first.branch,
      head_sha: "0123456789abcdef",
      validation: ["handoff prepared"],
      handoff_path: handoffRelativePath(first),
    });
    const second = await claims.claimTask(claimInput(task.id, {
      task_alias: task.aliases[0],
      session_id: "codex-second",
    }));

    await expect(claims.getCompletionEvidence(task.id, first.claim_id)).resolves.toEqual(oldEvidence);
    await expect(claims.finishClaim(task.id, second.claim_id, {
      status: "completed",
      outcome: "done",
      branch: second.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    })).rejects.toMatchObject({ code: "COMPLETION_EVIDENCE_REQUIRED" });
    await expect(claims.assertOwner(task.id, second.claim_id)).resolves.toEqual(second);
  });

  it("moves a child through handoff, permits resume, and rejects terminal reclaim", async () => {
    const { claims, task, catalog, fixture } = await formalClaimsFixture("parent");
    const child = await catalog.registerChildTask({
      parent_task_id: task.id,
      alias: "wlan:resumable-child",
      required_for_parent: true,
      goal: "child work",
      done_conditions: ["done"],
      grants: [],
      dependencies: [],
    });
    const first = await claims.claimTask(claimInput(child.id, {
      task_alias: child.aliases[0],
      session_id: "codex-child-first",
    }));
    await commitRegistryFile(fixture, handoffRelativePath(first), "# committed child handoff fixture\n");
    await claims.finishClaim(child.id, first.claim_id, {
      status: "handoff",
      branch: first.branch,
      head_sha: "0123456789abcdef",
      validation: ["handoff ready"],
      handoff_path: handoffRelativePath(first),
    });
    expect((await catalog.getTask(child.id) as { lifecycle: string }).lifecycle).toBe("handoff");

    const resumed = await claims.claimTask(claimInput(child.id, {
      task_alias: child.aliases[0],
      session_id: "codex-child-resumed",
    }));
    expect((await catalog.getTask(child.id) as { lifecycle: string }).lifecycle).toBe("active");
    await claims.finishClaim(child.id, resumed.claim_id, {
      status: "abandoned",
      outcome: "not needed",
      branch: resumed.branch,
      head_sha: "0123456789abcdef",
      validation: ["parent replanned"],
    });
    await expect(claims.claimTask(claimInput(child.id, {
      task_alias: child.aliases[0],
      session_id: "codex-child-terminal",
    }))).rejects.toMatchObject({ code: "TASK_TERMINAL" });
  });

  it("refuses to claim a legacy Task without an explicit Work Contract", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const taskPath = `tasks/${task.id}.yaml`;
    const legacy = JSON.parse(await readFile(join(fixture.registryDir, taskPath), "utf8"));
    delete legacy.task_role;
    delete legacy.work_contract;
    await commitRegistryFile(fixture, taskPath, `${JSON.stringify(legacy)}\n`);

    await expect(claims.claimTask(claimInput(task.id))).rejects.toMatchObject({
      code: "TASK_CONTRACT_REQUIRED",
    });
    await expect(claims.getActive(task.id)).resolves.toBeUndefined();
  });

  it("freezes the normalized Task Work Contract and digest in the active Claim", async () => {
    const { claims, catalog, task } = await claimsFixture();
    const configured = await catalog.configureInactiveTask({
      task_id: task.id,
      task_role: "standalone",
      work_contract: {
        version: 1,
        task_id: task.id,
        grants: [
          { capability: "test.host", resource: { kind: "repository", id: "repo-wlan" }, coordination: "shared" },
          { capability: "repo.modify", resource: { kind: "repository", id: "repo-wlan" }, coordination: "shared" },
        ],
        dependencies: [],
      },
    });

    const active = await claims.claimTask(claimInput(task.id));
    const expected = normalizeWorkContract(configured.work_contract);

    expect(active.work_contract).toEqual(expected);
    expect(active.work_contract_digest).toBe(workContractDigest(expected));
    expect(active.work_contract_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the active Claim snapshot unchanged when the Task record changes later", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const originalContract = normalizeWorkContract(task.work_contract);
    const taskPath = `tasks/${task.id}.yaml`;
    const changed = JSON.parse(await readFile(join(fixture.registryDir, taskPath), "utf8"));
    changed.work_contract = {
      version: 1,
      task_id: task.id,
      grants: [{
        capability: "repo.inspect",
        resource: { kind: "repository", id: "repo-wlan" },
        coordination: "shared",
      }],
      dependencies: [],
    };
    await commitRegistryFile(fixture, taskPath, `${JSON.stringify(changed)}\n`);

    const reread = await claims.getActive(task.id);
    expect(active.work_contract).toEqual(originalContract);
    expect(reread).toMatchObject({
      work_contract: originalContract,
      work_contract_digest: workContractDigest(originalContract),
    });
  });

  it("rejects a different Task owned by the same exact host session", async () => {
    const { claims, catalog, task } = await claimsFixture();
    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: "wlan:tmp-20260813-02-fix",
      goal: "fix another regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/other.ts"],
      ...emptyTaskContractIntent(),
    });
    const owner = await claims.claimTask(claimInput(task.id));

    await expect(claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      branch: "task/wlan-other-fix",
      worktree_ref: "wt-wlan-other-fix",
    }))).rejects.toMatchObject({ code: "TASK_SESSION_BUSY" });
    await expect(claims.assertOwner(task.id, owner.claim_id)).resolves.toEqual(owner);
    await expect(claims.getActive(other.id)).resolves.toBeUndefined();
  });

  it("allows shared repository grants in different Tasks and worktrees", async () => {
    const { claims, catalog, task } = await claimsFixture();
    const sharedGrant = {
      capability: "repo.modify" as const,
      resource: { kind: "repository" as const, id: "repo-wlan" },
      coordination: "shared" as const,
    };
    await catalog.configureInactiveTask({
      task_id: task.id,
      task_role: "standalone",
      work_contract: { version: 1, task_id: task.id, grants: [sharedGrant], dependencies: [] },
    });
    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: "wlan:tmp-20260813-03-fix",
      goal: "fix a parallel regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/parallel.ts"],
      grants: [sharedGrant],
      dependencies: [],
    });

    const first = await claims.claimTask(claimInput(task.id, {
      session_id: "codex-shared-a",
      branch: "task/wlan-shared-a",
      worktree_ref: "wt-wlan-shared-a",
    }));
    const second = await claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      session_id: "codex-shared-b",
      branch: "task/wlan-shared-b",
      worktree_ref: "wt-wlan-shared-b",
    }));

    expect(second.worktree_ref).not.toBe(first.worktree_ref);
    await expect(claims.assertOwner(first.task_id, first.claim_id)).resolves.toEqual(first);
    await expect(claims.assertOwner(second.task_id, second.claim_id)).resolves.toEqual(second);
  });

  it.each([
    ["existing", "exclusive", "shared"],
    ["requested", "shared", "exclusive"],
  ] as const)("rejects an exact board resource made exclusive by the %s contract", async (_side, firstCoordination, secondCoordination) => {
    const { claims, catalog, task } = await claimsFixture();
    const boardGrant = (coordination: "exclusive" | "shared") => ({
      capability: "board.execute" as const,
      resource: { kind: "board" as const, id: "wlan-target-board" },
      coordination,
    });
    await catalog.configureInactiveTask({
      task_id: task.id,
      task_role: "standalone",
      work_contract: { version: 1, task_id: task.id, grants: [boardGrant(firstCoordination)], dependencies: [] },
    });
    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: `wlan:tmp-20260813-${firstCoordination}-board`,
      goal: "exercise the target board",
      done_conditions: ["board test passes"],
      expected_scope: ["board"],
      grants: [boardGrant(secondCoordination)],
      dependencies: [],
    });
    const owner = await claims.claimTask(claimInput(task.id, { session_id: `codex-board-${firstCoordination}` }));

    await expect(claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      session_id: `codex-board-${secondCoordination}`,
      branch: `task/wlan-board-${secondCoordination}`,
      worktree_ref: `wt-wlan-board-${secondCoordination}`,
    }))).rejects.toMatchObject({ code: "TASK_RESOURCE_CONFLICT" });
    await expect(claims.assertOwner(owner.task_id, owner.claim_id)).resolves.toEqual(owner);
    await expect(claims.getActive(other.id)).resolves.toBeUndefined();
  });

  it("fails closed when any existing active Claim lacks a contract snapshot", async () => {
    const { claims, catalog, fixture, task } = await claimsFixture();
    const legacyOwner = await claims.claimTask(claimInput(task.id, { session_id: "codex-legacy-owner" }));
    const activePath = `claims/active/${task.id}.yaml`;
    const legacy = JSON.parse(await readFile(join(fixture.registryDir, activePath), "utf8"));
    delete legacy.work_contract;
    delete legacy.work_contract_digest;
    await commitRegistryFile(fixture, activePath, `${JSON.stringify(legacy)}\n`);
    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: "wlan:tmp-20260813-legacy-collision",
      goal: "continue after a legacy owner",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/legacy.ts"],
      ...emptyTaskContractIntent(),
    });

    await expect(claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      session_id: "codex-new-owner",
      branch: "task/wlan-new-owner",
      worktree_ref: "wt-wlan-new-owner",
    }))).rejects.toMatchObject({ code: "ACTIVE_CLAIM_CONTRACT_REQUIRED" });
    await expect(claims.assertOwner(task.id, legacyOwner.claim_id)).resolves.toMatchObject({ claim_id: legacyOwner.claim_id });
  });

  it("resolves one exact host session, returns undefined for none, and rejects duplicate ownership", async () => {
    const { claims, catalog, fixture, task } = await claimsFixture();
    const first = await claims.claimTask(claimInput(task.id, { session_id: "codex-resolve" }));

    await expect(claims.resolveSessionClaim("codex", "codex-resolve", "cantopsbuildserver")).resolves.toEqual(first);
    await expect(claims.resolveSessionClaim("codex", "codex-resolve", "other-host")).resolves.toBeUndefined();
    await expect(claims.resolveSessionClaim("codex", "codex-missing", "cantopsbuildserver")).resolves.toBeUndefined();

    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: "wlan:tmp-20260813-duplicate-session",
      goal: "create a duplicate fixture",
      done_conditions: ["fixture is committed"],
      expected_scope: ["src/duplicate.ts"],
      ...emptyTaskContractIntent(),
    });
    const second = await claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      session_id: "codex-distinct",
      branch: "task/wlan-distinct",
      worktree_ref: "wt-wlan-distinct",
    }));
    const secondPath = `claims/active/${other.id}.yaml`;
    const duplicate = JSON.parse(await readFile(join(fixture.registryDir, secondPath), "utf8"));
    duplicate.session_id = first.session_id;
    duplicate.host = first.host;
    await commitRegistryFile(fixture, secondPath, `${JSON.stringify(duplicate)}\n`);

    await expect(claims.resolveSessionClaim("codex", first.session_id, first.host)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(second.claim_id).not.toBe(first.claim_id);
  });

  it("lists every validated active Claim through a bounded read-only audit", async () => {
    const { claims, catalog, task } = await claimsFixture();
    const first = await claims.claimTask(claimInput(task.id, { session_id: "codex-list-first" }));
    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: "wlan:tmp-20260813-list-second",
      goal: "list a second active owner",
      done_conditions: ["both owners are visible"],
      expected_scope: ["src/list.ts"],
      ...emptyTaskContractIntent(),
    });
    const second = await claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      session_id: "codex-list-second",
      branch: "task/wlan-list-second",
      worktree_ref: "wt-wlan-list-second",
    }));

    await expect(claims.listActiveClaims()).resolves.toEqual([first, second]);
  });

  it("copies the active Work Contract digest into newly released history", async () => {
    const { claims, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));

    const history = await claims.finishClaim(task.id, active.claim_id, {
      status: "completed",
      outcome: "done",
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    });

    expect(history.work_contract_digest).toBe(active.work_contract_digest);
    expect(history.work_contract_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not let takeover move a Claim into another Task's exact host session", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, catalog, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: "wlan:tmp-20260813-takeover-session",
      goal: "own the takeover target session",
      done_conditions: ["ownership remains exact"],
      expected_scope: ["src/takeover.ts"],
      ...emptyTaskContractIntent(),
    });
    const first = await claims.claimTask(claimInput(task.id, { session_id: "codex-takeover-source" }));
    await claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      session_id: "codex-takeover-target",
      branch: "task/wlan-takeover-target",
      worktree_ref: "wt-wlan-takeover-target",
    }));

    await expect(claims.recoverClaim(task.id, first.claim_id, {
      kind: "takeover",
      session_id: "codex-takeover-target",
    })).rejects.toMatchObject({ code: "TASK_SESSION_BUSY" });
    await expect(claims.assertOwner(task.id, first.claim_id)).resolves.toEqual(first);
  });

  it("does not mint a replacement generation from a legacy active Claim", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const activePath = `claims/active/${task.id}.yaml`;
    const legacy = JSON.parse(await readFile(join(fixture.registryDir, activePath), "utf8"));
    delete legacy.work_contract;
    delete legacy.work_contract_digest;
    await commitRegistryFile(fixture, activePath, `${JSON.stringify(legacy)}\n`);

    await expect(claims.recoverClaim(task.id, active.claim_id, {
      kind: "takeover",
      session_id: "codex-takeover",
    })).rejects.toMatchObject({ code: "ACTIVE_CLAIM_CONTRACT_REQUIRED" });
    await expect(claims.assertOwner(task.id, active.claim_id)).resolves.toMatchObject({ claim_id: active.claim_id });
  });

  it("blocks takeover when another active Claim is legacy and preserves the original generation", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, catalog, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: "wlan:tmp-20260813-takeover-legacy-other",
      goal: "provide legacy conflicting ownership",
      done_conditions: ["takeover remains blocked"],
      expected_scope: ["src/legacy-other.ts"],
      ...emptyTaskContractIntent(),
    });
    const requested = await claims.claimTask(claimInput(task.id, { session_id: "codex-takeover-requested" }));
    const legacyOwner = await claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      session_id: "codex-takeover-legacy-other",
      branch: "task/wlan-takeover-legacy-other",
      worktree_ref: "wt-wlan-takeover-legacy-other",
    }));
    const legacyPath = `claims/active/${other.id}.yaml`;
    const legacy = JSON.parse(await readFile(join(fixture.registryDir, legacyPath), "utf8"));
    delete legacy.work_contract;
    delete legacy.work_contract_digest;
    await commitRegistryFile(fixture, legacyPath, `${JSON.stringify(legacy)}\n`);
    const requestedPath = join(fixture.registryDir, "claims", "active", `${task.id}.yaml`);
    const beforeBytes = await readFile(requestedPath, "utf8");
    const beforeHead = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(claims.recoverClaim(task.id, requested.claim_id, {
      kind: "takeover",
      session_id: "codex-takeover-successor",
    })).rejects.toMatchObject({ code: "ACTIVE_CLAIM_CONTRACT_REQUIRED" });

    expect(await readFile(requestedPath, "utf8")).toBe(beforeBytes);
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(beforeHead);
    expect(await exists(join(fixture.registryDir, historyRelativePath(requested)))).toBe(false);
    await expect(claims.assertOwner(other.id, legacyOwner.claim_id)).resolves.toMatchObject({ claim_id: legacyOwner.claim_id });
  });

  it.each([
    ["requested", 0],
    ["existing", 1],
  ] as const)("blocks takeover when the %s Claim makes an exact resource exclusive", async (_side, exclusiveIndex) => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, catalog, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const sharedGrant = {
      capability: "repo.modify" as const,
      resource: { kind: "repository" as const, id: "repo-wlan" },
      coordination: "shared" as const,
    };
    await catalog.configureInactiveTask({
      task_id: task.id,
      task_role: "standalone",
      work_contract: { version: 1, task_id: task.id, grants: [sharedGrant], dependencies: [] },
    });
    const other = await catalog.registerTemporaryTask({
      project_id: task.project_id,
      repo_id: task.repo_id,
      alias: `wlan:tmp-20260813-takeover-exclusive-${exclusiveIndex}`,
      goal: "provide a symmetric resource conflict",
      done_conditions: ["takeover remains blocked"],
      expected_scope: ["src/exclusive.ts"],
      grants: [sharedGrant],
      dependencies: [],
    });
    const requested = await claims.claimTask(claimInput(task.id, { session_id: "codex-takeover-resource" }));
    const existing = await claims.claimTask(claimInput(other.id, {
      task_alias: other.aliases[0],
      session_id: "codex-takeover-resource-other",
      branch: "task/wlan-takeover-resource-other",
      worktree_ref: "wt-wlan-takeover-resource-other",
    }));
    const activeClaims = [requested, existing];
    const exclusive = activeClaims[exclusiveIndex];
    const exclusivePath = `claims/active/${exclusive.task_id}.yaml`;
    const injected = JSON.parse(await readFile(join(fixture.registryDir, exclusivePath), "utf8"));
    injected.work_contract.grants[0].coordination = "exclusive";
    injected.work_contract_digest = workContractDigest(injected.work_contract);
    await commitRegistryFile(fixture, exclusivePath, `${JSON.stringify(injected)}\n`);
    const requestedPath = join(fixture.registryDir, "claims", "active", `${task.id}.yaml`);
    const beforeBytes = await readFile(requestedPath, "utf8");
    const beforeHead = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(claims.recoverClaim(task.id, requested.claim_id, {
      kind: "takeover",
      session_id: "codex-takeover-resource-successor",
    })).rejects.toMatchObject({ code: "TASK_RESOURCE_CONFLICT" });

    expect(await readFile(requestedPath, "utf8")).toBe(beforeBytes);
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(beforeHead);
    expect(await exists(join(fixture.registryDir, historyRelativePath(requested)))).toBe(false);
  });

  it.each(["wrong-task-id", "non-normalized", "digest"] as const)(
    "rejects %s corruption in an active Claim before another Task acquisition",
    async (variant) => {
      const { claims, catalog, fixture, task } = await claimsFixture();
      await catalog.configureInactiveTask({
        task_id: task.id,
        task_role: "standalone",
        work_contract: {
          version: 1,
          task_id: task.id,
          grants: [
            { capability: "test.host", resource: { kind: "repository", id: "repo-wlan" }, coordination: "shared" },
            { capability: "repo.modify", resource: { kind: "repository", id: "repo-wlan" }, coordination: "shared" },
          ],
          dependencies: [],
        },
      });
      const owner = await claims.claimTask(claimInput(task.id, { session_id: "codex-corrupt-owner" }));
      const ownerPath = `claims/active/${task.id}.yaml`;
      const corrupted = JSON.parse(await readFile(join(fixture.registryDir, ownerPath), "utf8"));
      if (variant === "wrong-task-id") {
        corrupted.work_contract.task_id = "tsk-0198aabb-ccdd-7eef-8abc-0123456789ff";
        corrupted.work_contract_digest = workContractDigest(corrupted.work_contract);
      } else if (variant === "non-normalized") {
        corrupted.work_contract.grants.reverse();
      } else {
        corrupted.work_contract_digest = "f".repeat(64);
      }
      await commitRegistryFile(fixture, ownerPath, `${JSON.stringify(corrupted)}\n`);
      const other = await catalog.registerTemporaryTask({
        project_id: task.project_id,
        repo_id: task.repo_id,
        alias: `wlan:tmp-20260813-corrupt-acquire-${variant}`,
        goal: "attempt acquisition around corruption",
        done_conditions: ["acquisition fails closed"],
        expected_scope: ["src/corrupt-acquire.ts"],
        ...emptyTaskContractIntent(),
      });
      const beforeBytes = await readFile(join(fixture.registryDir, ownerPath), "utf8");
      const beforeHead = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

      await expect(claims.claimTask(claimInput(other.id, {
        task_alias: other.aliases[0],
        session_id: `codex-corrupt-acquire-${variant}`,
        branch: `task/wlan-corrupt-acquire-${variant}`,
        worktree_ref: `wt-wlan-corrupt-acquire-${variant}`,
      }))).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

      expect(await readFile(join(fixture.registryDir, ownerPath), "utf8")).toBe(beforeBytes);
      expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(beforeHead);
      await expect(claims.getActive(other.id)).resolves.toBeUndefined();
      expect(owner.claim_id).toBe(corrupted.claim_id);
    },
  );

  it.each(["wrong-task-id", "non-normalized", "digest"] as const)(
    "rejects %s corruption before takeover writes replacement or history",
    async (variant) => {
      const { claims, catalog, fixture, task } = await claimsFixture();
      await catalog.configureInactiveTask({
        task_id: task.id,
        task_role: "standalone",
        work_contract: {
          version: 1,
          task_id: task.id,
          grants: [
            { capability: "test.host", resource: { kind: "repository", id: "repo-wlan" }, coordination: "shared" },
            { capability: "repo.modify", resource: { kind: "repository", id: "repo-wlan" }, coordination: "shared" },
          ],
          dependencies: [],
        },
      });
      const active = await claims.claimTask(claimInput(task.id, { session_id: "codex-corrupt-takeover" }));
      const activePath = `claims/active/${task.id}.yaml`;
      const corrupted = JSON.parse(await readFile(join(fixture.registryDir, activePath), "utf8"));
      if (variant === "wrong-task-id") {
        corrupted.work_contract.task_id = "tsk-0198aabb-ccdd-7eef-8abc-0123456789ff";
        corrupted.work_contract_digest = workContractDigest(corrupted.work_contract);
      } else if (variant === "non-normalized") {
        corrupted.work_contract.grants.reverse();
      } else {
        corrupted.work_contract_digest = "f".repeat(64);
      }
      await commitRegistryFile(fixture, activePath, `${JSON.stringify(corrupted)}\n`);
      const beforeBytes = await readFile(join(fixture.registryDir, activePath), "utf8");
      const beforeHead = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

      await expect(claims.recoverClaim(task.id, active.claim_id, {
        kind: "takeover",
        session_id: `codex-corrupt-takeover-${variant}`,
      })).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

      expect(await readFile(join(fixture.registryDir, activePath), "utf8")).toBe(beforeBytes);
      expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(beforeHead);
      expect(await exists(join(fixture.registryDir, historyRelativePath(active)))).toBe(false);
    },
  );

  it.each([
    ["completed release without an outcome", { status: "completed" }],
    ["Handoff release without a pointer", { status: "handoff" }],
    ["non-Handoff release with a pointer", { status: "abandoned", handoff_path: `handoffs/tsk-0198aabb-ccdd-7eef-8abc-0123456789ab/clm-0198aabb-ccdd-7eef-8abc-0123456789ab.md` }],
  ])("rejects an incoherent %s before mutating Registry authority", async (_description, fields) => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");

    await expect(claims.finishClaim(active.task_id, active.claim_id, {
      ...fields,
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    } as never)).rejects.toMatchObject({ code: "INVALID_FINISH_OUTCOME" });

    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
    await expect(claims.assertOwner(active.task_id, active.claim_id)).resolves.toEqual(active);
  });

  it("rejects protected invalid-enum input without reflecting its received value", async () => {
    const secret = "unmistakably-fake-finish-token";
    const { claims, fixture, task } = await claimsFixture(
      () => fixedNow,
      createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    );
    const active = await claims.claimTask(claimInput(task.id));
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");

    const error = await claims.finishClaim(active.task_id, active.claim_id, {
      status: secret,
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    } as never).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("rejects protected Claim content before creating active ownership", async () => {
    const secret = "unmistakably-fake-claim-token";
    const { claims, fixture, task } = await claimsFixture(
      () => fixedNow,
      createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    );
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");

    const error = await claims.claimTask(claimInput(task.id, { session_id: secret })).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("creates the normal absent active-Claim directory inside the Registry", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const path = join(fixture.registryDir, "claims", "active", `${task.id}.yaml`);

    expect(await exists(path)).toBe(false);
    const active = await claims.claimTask(claimInput(task.id));

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(active);
    expect(active.source_task_revision).toBe(
      (await git(fixture.registryDir, "rev-parse", `HEAD:tasks/${task.id}.yaml`)).trim(),
    );
  });

  it("updates temporary lifecycle atomically with release and refuses completed reclaim", async () => {
    const { claims, task, fixture } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    await claims.finishClaim(task.id, active.claim_id, {
      status: "completed",
      outcome: "done",
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    });

    const record = JSON.parse(await readFile(join(fixture.registryDir, "tasks", `${task.id}.yaml`), "utf8"));
    expect(record.lifecycle).toBe("completed");
    await expect(claims.claimTask(claimInput(task.id, { session_id: "codex-resume" }))).rejects.toMatchObject({
      code: "TASK_COMPLETED",
    });
  });

  it("marks force-ended temporary work resumable as handoff", async () => {
    const { claims, task, fixture } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));

    await claims.recoverClaim(task.id, active.claim_id, { kind: "force-end" });

    const record = JSON.parse(await readFile(join(fixture.registryDir, "tasks", `${task.id}.yaml`), "utf8"));
    expect(record.lifecycle).toBe("handoff");
    await expect(claims.claimTask(claimInput(task.id, { session_id: "codex-resume" }))).resolves.toMatchObject({
      task_id: task.id,
      session_id: "codex-resume",
      predecessor_claim_id: active.claim_id,
    });
    const resumed = JSON.parse(await readFile(join(fixture.registryDir, "tasks", `${task.id}.yaml`), "utf8"));
    expect(resumed.lifecycle).toBe("active");
  });

  it("rejects a caller-supplied predecessor instead of trusting a forged recovery link", async () => {
    const { claims, task } = await claimsFixture();
    const forged = {
      ...claimInput(task.id),
      predecessor_claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ff",
    };

    await expect(claims.claimTask(forged as never)).rejects.toMatchObject({ code: "INVALID_CLAIM" });
    await expect(claims.getActive(task.id)).resolves.toBeUndefined();
  });

  it("rejects a second active Claim for the same canonical Task", async () => {
    const { claims, task } = await claimsFixture();
    const ownerA = claimInput(task.id, {
      session_id: "codex-a-secret-session",
      host: "safe-build-host",
      branch: "task/safe-conflict",
      worktree_ref: "wt-safe-conflict",
    });
    const ownerB = claimInput(task.id, { session_id: "codex-b" });
    const first = await claims.claimTask(ownerA);

    const conflict = await claims.claimTask(ownerB).catch((cause: unknown) => cause);

    expect(conflict).toMatchObject({
      code: "TASK_ALREADY_CLAIMED",
      details: {
        conflicting_claim: {
          task_id: first.task_id,
          claim_id: first.claim_id,
          host: "safe-build-host",
          branch: "task/safe-conflict",
          worktree_ref: "wt-safe-conflict",
          started_at: first.started_at,
        },
      },
    });
    expect((conflict as ControlError).details).toEqual({
      conflicting_claim: {
        task_id: first.task_id,
        claim_id: first.claim_id,
        host: "safe-build-host",
        branch: "task/safe-conflict",
        worktree_ref: "wt-safe-conflict",
        started_at: first.started_at,
      },
    });
    expect(JSON.stringify(conflict)).not.toContain("codex-a-secret-session");
    expect(JSON.stringify(conflict)).not.toContain(task.project_id);
    expect(JSON.stringify(conflict)).not.toContain(task.repo_id);
    expect((await claims.getActive(first.task_id))?.claim_id).toBe(first.claim_id);
  });

  it("rejects claim creation when the active-Claim ancestor is an external symlink", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const externalDir = join(fixture.root, "external-active-create");
    await mkdir(externalDir, { recursive: true });
    await commitRegistrySymlink(fixture, "claims/active", externalDir);

    await expect(claims.claimTask(claimInput(task.id))).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await exists(join(externalDir, `${task.id}.yaml`))).toBe(false);
  });

  it("rejects getActive and assertOwner when active-Claim reads traverse an external symlink", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const externalDir = join(fixture.root, "external-active-read");
    const externalClaim = {
      ...claimInput(task.id),
      claim_id: "clm-00000000-0000-7000-8000-000000000000",
      started_at: fixedNow.toISOString(),
    };
    await mkdir(externalDir, { recursive: true });
    const externalPath = join(externalDir, `${task.id}.yaml`);
    const content = `${JSON.stringify(externalClaim)}\n`;
    await writeFile(externalPath, content, "utf8");
    await commitRegistrySymlink(fixture, "claims/active", externalDir);

    await expect(claims.getActive(task.id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    await expect(claims.assertOwner(task.id, externalClaim.claim_id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await readFile(externalPath, "utf8")).toBe(content);
  });

  it("rejects a multi-link active Claim before trusting ownership", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const activePath = join(fixture.registryDir, "claims", "active", `${active.task_id}.yaml`);
    await link(activePath, join(fixture.root, "active-claim-hardlink.yaml"));

    await expect(claims.getActive(active.task_id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    await expect(claims.assertOwner(active.task_id, active.claim_id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await git(fixture.registryDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("cannot release a Claim owned by another generation", async () => {
    const { claims, task } = await claimsFixture();
    const first = await claims.claimTask(claimInput(task.id, { session_id: "codex-a" }));

    await expect(
      claims.finishClaim(first.task_id, "clm-00000000-0000-7000-8000-000000000000", {
        status: "completed",
        outcome: "done",
        branch: "task/example",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
      }),
    ).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
  });

  it("takeover archives the old Claim with a typed direct link to its fresh successor", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id, { session_id: "codex-a" }));

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
      host: "cantopsbuildserver",
      successor_claim_id: recovered.active.claim_id,
    });
    await expect(claims.assertOwner(first.task_id, first.claim_id)).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
    expect(await claims.assertOwner(first.task_id, recovered.active.claim_id)).toEqual(recovered.active);
    expect(await exists(join(fixture.registryDir, "claims", "history", "2026", first.task_id, `${first.claim_id}.yaml`))).toBe(true);
  });

  it("clears an allocation predecessor when takeover rotates a resumed Claim", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
      new Date("2026-08-13T12:34:59.789Z"),
      new Date("2026-08-13T12:35:00.789Z"),
    ];
    const { claims, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id));
    await claims.recoverClaim(task.id, first.claim_id, { kind: "force-end" });
    const resumed = await claims.claimTask(claimInput(task.id, { session_id: "codex-resume" }));
    expect(resumed.predecessor_claim_id).toBe(first.claim_id);

    const takeover = await claims.recoverClaim(task.id, resumed.claim_id, {
      kind: "takeover",
      session_id: "codex-takeover",
    });

    expect(takeover.active.predecessor_claim_id).toBeUndefined();
    expect(takeover.history.successor_claim_id).toBe(takeover.active.claim_id);
  });

  it("reconciles only the exact remotely linked takeover retry without another commit", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id));
    const takeover = { kind: "takeover" as const, session_id: "codex-new" };
    const recovered = await claims.recoverClaim(first.task_id, first.claim_id, takeover);
    const head = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(claims.recoverClaim(first.task_id, first.claim_id, takeover)).resolves.toEqual(recovered);
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await git(fixture.registryDir, "status", "--porcelain")).toBe("");
  });

  it("rejects takeover retry for a different successor session", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id));
    await claims.recoverClaim(first.task_id, first.claim_id, { kind: "takeover", session_id: "codex-new" });

    await expect(claims.recoverClaim(first.task_id, first.claim_id, {
      kind: "takeover",
      session_id: "codex-other",
    })).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
  });

  it.each(["legacy-unlinked", "wrong-link"])(
    "rejects a %s takeover history as idempotent authority",
    async (variant) => {
      const times = [
        new Date("2026-08-13T12:34:56.789Z"),
        new Date("2026-08-13T12:34:57.789Z"),
        new Date("2026-08-13T12:34:58.789Z"),
      ];
      const { claims, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
      const first = await claims.claimTask(claimInput(task.id));
      const takeover = { kind: "takeover" as const, session_id: "codex-new" };
      await claims.recoverClaim(first.task_id, first.claim_id, takeover);
      const relative = historyRelativePath(first);
      const path = join(fixture.registryDir, relative);
      const history = JSON.parse(await readFile(path, "utf8"));
      if (variant === "legacy-unlinked") delete history.successor_claim_id;
      else history.successor_claim_id = "clm-0198aabb-ccdd-7eef-8abc-0123456789ad";
      await commitRegistryFile(fixture, relative, `${JSON.stringify(history)}\n`);
      const head = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

      await expect(claims.recoverClaim(first.task_id, first.claim_id, takeover)).rejects.toMatchObject({
        code: "CLAIM_MISMATCH",
      });
      expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(head);
    },
  );

  it("rejects an older linked predecessor after its direct successor was itself taken over", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
      new Date("2026-08-13T12:34:59.789Z"),
      new Date("2026-08-13T12:35:00.789Z"),
    ];
    const { claims, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id));
    const second = await claims.recoverClaim(first.task_id, first.claim_id, {
      kind: "takeover",
      session_id: "codex-second",
    });
    await claims.recoverClaim(second.active.task_id, second.active.claim_id, {
      kind: "takeover",
      session_id: "codex-third",
    });

    await expect(claims.recoverClaim(first.task_id, first.claim_id, {
      kind: "takeover",
      session_id: "codex-second",
    })).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
  });

  it("finds a remotely linked predecessor across a retry clock year boundary", async () => {
    const times = [
      new Date("2026-12-31T23:59:57.000Z"),
      new Date("2026-12-31T23:59:58.000Z"),
      new Date("2026-12-31T23:59:59.000Z"),
      new Date("2027-01-01T00:00:01.000Z"),
    ];
    const { claims, fixture, task } = await claimsFixture(() => times.shift() ?? new Date("2027-01-01T00:00:02.000Z"));
    const first = await claims.claimTask(claimInput(task.id));
    const takeover = { kind: "takeover" as const, session_id: "codex-new" };
    const recovered = await claims.recoverClaim(first.task_id, first.claim_id, takeover);
    const head = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(claims.recoverClaim(first.task_id, first.claim_id, takeover)).resolves.toEqual(recovered);
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(head);
    await expect(readFile(join(fixture.registryDir, "claims", "history", "2026", first.task_id, `${first.claim_id}.yaml`), "utf8"))
      .resolves.toContain(recovered.active.claim_id);
  });

  it("rejects a remotely linked predecessor stored outside its released_at UTC year", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id));
    const takeover = { kind: "takeover" as const, session_id: "codex-new" };
    await claims.recoverClaim(first.task_id, first.claim_id, takeover);
    const canonical = join(fixture.registryDir, historyRelativePath(first));
    const misplacedRelative = `claims/history/2025/${first.task_id}/${first.claim_id}.yaml`;
    const misplaced = join(fixture.registryDir, misplacedRelative);
    await mkdir(dirname(misplaced), { recursive: true });
    await rename(canonical, misplaced);
    await git(fixture.registryDir, "add", "-A", "--", "claims/history");
    await git(fixture.registryDir, "commit", "-m", "Mispartition takeover history");
    await git(fixture.registryDir, "push", "origin", "main");
    const head = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(claims.recoverClaim(first.task_id, first.claim_id, takeover)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
    });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(head);
  });

  it("rejects duplicate exact predecessor history across canonical year directories", async () => {
    const times = [
      new Date("2026-08-13T12:34:56.789Z"),
      new Date("2026-08-13T12:34:57.789Z"),
      new Date("2026-08-13T12:34:58.789Z"),
    ];
    const { claims, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id));
    const takeover = { kind: "takeover" as const, session_id: "codex-new" };
    await claims.recoverClaim(first.task_id, first.claim_id, takeover);
    const duplicate = `claims/history/2025/${first.task_id}/${first.claim_id}.yaml`;
    await commitRegistryFile(fixture, duplicate, await readFile(join(fixture.registryDir, historyRelativePath(first)), "utf8"));

    await expect(claims.recoverClaim(first.task_id, first.claim_id, takeover)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
    });
  });

  it("rejects cross-host takeover before rotating Registry ownership", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const first = await claims.claimTask(claimInput(task.id, { host: "other-build-host" }));
    const head = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(claims.recoverClaim(first.task_id, first.claim_id, {
      kind: "takeover",
      session_id: "codex-new",
    })).rejects.toMatchObject({ code: "HOST_MISMATCH" });
    await expect(claims.assertOwner(first.task_id, first.claim_id)).resolves.toEqual(first);
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(head);
  });

  it("rejects finish when the active Claim is redirected outside the Registry", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const content = `${JSON.stringify(active)}\n`;
    const { externalDir, externalPath } = await replaceActiveWithExternalSymlink(fixture, active, content);

    await expect(
      claims.finishClaim(active.task_id, active.claim_id, {
        status: "completed",
        outcome: "done",
        branch: "task/wlan-roaming-fix",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await readFile(externalPath, "utf8")).toBe(content);
    expect(await exists(join(externalDir, `${active.claim_id}.yaml`))).toBe(false);
  });

  it("rejects force-end when the active Claim is redirected outside the Registry", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const content = `${JSON.stringify(active)}\n`;
    const { externalPath } = await replaceActiveWithExternalSymlink(fixture, active, content);

    await expect(claims.recoverClaim(active.task_id, active.claim_id, { kind: "force-end" })).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
    });
    expect(await readFile(externalPath, "utf8")).toBe(content);
  });

  it("rejects takeover when the active Claim is redirected outside the Registry", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const content = `${JSON.stringify(active)}\n`;
    const { externalDir, externalPath } = await replaceActiveWithExternalSymlink(fixture, active, content);

    await expect(
      claims.recoverClaim(active.task_id, active.claim_id, { kind: "takeover", session_id: "codex-new" }),
    ).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await readFile(externalPath, "utf8")).toBe(content);
    expect(await exists(join(externalDir, `${active.claim_id}.yaml`))).toBe(false);
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
    await expect(claims.latestClaimHistory(active.task_id)).resolves.toEqual(history);
  });

  it("rejects protected content restored through latest Claim-history enumeration", async () => {
    const secret = "unmistakably-fake-restored-history-token";
    const { claims, fixture, task } = await claimsFixture(
      () => fixedNow,
      createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    );
    const active = await claims.claimTask(claimInput(task.id));
    const history = await claims.finishClaim(active.task_id, active.claim_id, {
      status: "completed",
      outcome: "done",
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    });
    await commitRegistryFile(fixture, historyRelativePath(active), `${JSON.stringify({ ...history, outcome: secret })}\n`);

    const error = await claims.latestClaimHistory(active.task_id).catch((cause) => cause);
    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("rejects restored Claim history without its frozen source revision", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const history = await claims.finishClaim(active.task_id, active.claim_id, {
      status: "completed",
      outcome: "done",
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    });
    const malformed = { ...history } as Partial<typeof history>;
    delete malformed.source_task_revision;
    await commitRegistryFile(fixture, historyRelativePath(active), `${JSON.stringify(malformed)}\n`);

    await expect(claims.latestClaimHistory(active.task_id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("orders offset Claim history by instant and rejects equal-instant ambiguity", async () => {
    const times = [
      new Date("2026-08-13T10:00:00Z"), new Date("2026-08-13T10:30:00Z"),
      new Date("2026-08-14T11:00:00Z"), new Date("2026-08-14T11:45:00Z"),
    ];
    const { claims, fixture, task } = await claimsFixture(() => times.shift() ?? fixedNow);
    const first = await claims.claimTask(claimInput(task.id));
    const firstHistory = (await claims.recoverClaim(task.id, first.claim_id, { kind: "force-end" })).history;
    const second = await claims.claimTask(claimInput(task.id, { session_id: "codex-second" }));
    const secondHistory = (await claims.recoverClaim(task.id, second.claim_id, { kind: "force-end" })).history;
    await commitRegistryFile(fixture, historyRelativePath(first), `${JSON.stringify({
      ...firstHistory, released_at: "2026-08-14T00:30:00+14:00",
    })}\n`);
    await commitRegistryFile(fixture, historyRelativePath(second), `${JSON.stringify({
      ...secondHistory, released_at: "2026-08-13T23:45:00-12:00",
    })}\n`);

    await expect(claims.latestClaimHistory(task.id)).resolves.toMatchObject({ claim_id: second.claim_id });

    await commitRegistryFile(fixture, historyRelativePath(second), `${JSON.stringify({
      ...secondHistory, released_at: "2026-08-13T10:30:00Z",
    })}\n`);
    await expect(claims.latestClaimHistory(task.id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("rejects a dirty deletion that would hide committed Claim history", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    await claims.finishClaim(active.task_id, active.claim_id, {
      status: "completed",
      outcome: "done",
      branch: active.branch,
      head_sha: "0123456789abcdef",
      validation: ["targeted test passes"],
    });
    await unlink(join(fixture.registryDir, historyRelativePath(active)));

    await expect(claims.latestClaimHistory(active.task_id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("rejects archived Claim scope that disagrees with the canonical Task", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const history = await claims.finishClaim(active.task_id, active.claim_id, {
      status: "abandoned", branch: active.branch, head_sha: "0123456789abcdef", validation: ["stopped"],
    });
    await commitRegistryFile(fixture, historyRelativePath(active), `${JSON.stringify({
      ...history,
      repo_id: "repo-other",
    })}\n`);

    await expect(claims.getClaimHistory(active.task_id, active.claim_id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
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
        outcome: "done",
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

  it("rejects an intermediate history symlink without writing outside the Registry", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const externalHistory = join(fixture.root, "external-history");
    await mkdir(externalHistory, { recursive: true });
    await commitRegistrySymlink(fixture, `claims/history/2026/${active.task_id}`, externalHistory);

    await expect(
      claims.finishClaim(active.task_id, active.claim_id, {
        status: "completed",
        outcome: "done",
        branch: "task/wlan-roaming-fix",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await exists(join(externalHistory, `${active.claim_id}.yaml`))).toBe(false);
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

  it("rejects an ignored untracked Handoff file even when it is a regular file", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const handoffPath = handoffRelativePath(active);
    await commitRegistryFile(fixture, ".gitignore", `${handoffPath}\n`);
    await mkdir(dirname(join(fixture.registryDir, handoffPath)), { recursive: true });
    await writeFile(join(fixture.registryDir, handoffPath), "# Untracked handoff\n", "utf8");

    await expect(
      claims.finishClaim(active.task_id, active.claim_id, {
        status: "handoff",
        branch: "task/wlan-roaming-fix",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
        handoff_path: handoffPath,
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_DIRTY" });
    expect(await claims.getActive(active.task_id)).toEqual(active);
  });

  it("rejects a committed Handoff symlink even when its external target is regular", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const externalHandoff = join(fixture.root, "external-handoff.md");
    await writeFile(externalHandoff, "# External handoff\n", "utf8");
    await commitRegistrySymlink(fixture, handoffRelativePath(active), externalHandoff);

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

  it("rejects a multi-link committed Handoff and retains the active Claim", async () => {
    const { claims, fixture, task } = await claimsFixture();
    const active = await claims.claimTask(claimInput(task.id));
    const relative = handoffRelativePath(active);
    await commitRegistryFile(fixture, relative, "# Handoff\n\nDurable content.\n");
    await link(join(fixture.registryDir, relative), join(fixture.root, "handoff-hardlink.md"));

    await expect(
      claims.finishClaim(active.task_id, active.claim_id, {
        status: "handoff",
        branch: "task/wlan-roaming-fix",
        head_sha: "0123456789abcdef",
        validation: ["npm test: pass"],
        handoff_path: relative,
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
