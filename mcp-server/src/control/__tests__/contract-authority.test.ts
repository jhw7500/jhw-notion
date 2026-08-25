import { describe, expect, it } from "vitest";

import { ControlContractAuthority } from "../contract-authority.js";
import type { TaskRecord } from "../schemas.js";
import type { WorkContract } from "../work-contract.js";

const parentId = "tsk-0181f8f0-0000-7000-8000-000000000001";
const childId = "tsk-0181f8f0-0000-7000-8000-000000000002";
const dependencyId = "tsk-0181f8f0-0000-7000-8000-000000000003";

const parent = {
  id: parentId,
  kind: "formal",
  project_id: "prj-wlan",
  repo_id: "repo-wlan",
  aliases: ["jhw7500/wlan#1"],
  issue_node_id: "I_kwDOExample",
  issue_revision: "2026-08-13T00:00:00Z",
  issue_url: "https://github.com/jhw7500/wlan/issues/1",
  task_role: "parent",
  work_contract: { version: 1, task_id: parentId, grants: [], dependencies: [] },
} as TaskRecord;

const child = {
  id: childId,
  kind: "child",
  parent_task_id: parentId,
  required_for_parent: true,
  project_id: "prj-wlan",
  repo_id: "repo-wlan",
  aliases: ["wlan:child"],
  goal: "child work",
  done_conditions: ["done"],
  lifecycle: "active",
  work_contract: { version: 1, task_id: childId, grants: [], dependencies: [] },
} as TaskRecord;

function contract(taskId: string, grants: WorkContract["grants"], dependencies: WorkContract["dependencies"] = []): WorkContract {
  return { version: 1, task_id: taskId, grants, dependencies };
}

function fixture(tasks: TaskRecord[] = [parent, child]) {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const resolvedBoards: string[] = [];
  return {
    resolvedBoards,
    authority: new ControlContractAuthority({
      async getRepository(repoId) {
        if (repoId !== "repo-wlan") throw Object.assign(new Error("missing"), { code: "REPOSITORY_NOT_FOUND" });
        return { id: "repo-wlan", github_node_id: "R_kwDOExample", slug: "jhw7500/wlan" };
      },
      async getTask(taskId) {
        const task = taskMap.get(taskId);
        if (!task) throw Object.assign(new Error("missing"), { code: "TASK_NOT_FOUND" });
        return task;
      },
      async boardStatus(boardId) {
        if (boardId !== "wlan-board") throw Object.assign(new Error("missing"), { code: "BOARD_NOT_FOUND" });
        resolvedBoards.push(boardId);
        return { boards: [{ board_id: boardId }] };
      },
    }),
  };
}

describe("ControlContractAuthority", () => {
  it("accepts only the exact repository and formal Issue identities in Task authority", async () => {
    const { authority } = fixture();
    await expect(authority.assertKnownContract(parent, contract(parent.id, [
      { capability: "repo.modify", resource: { kind: "repository", id: "repo-wlan" }, coordination: "exclusive" },
      { capability: "tracker.mutate", resource: { kind: "issue", id: "I_kwDOExample" }, coordination: "shared" },
    ]))).resolves.toBeUndefined();

    await expect(authority.assertKnownContract(parent, contract(parent.id, [
      { capability: "repo.inspect", resource: { kind: "repository", id: "repo-other" }, coordination: "shared" },
    ]))).rejects.toMatchObject({ code: "RESOURCE_AUTHORITY_MISMATCH" });
    await expect(authority.assertKnownContract(parent, contract(parent.id, [
      { capability: "tracker.mutate", resource: { kind: "issue", id: "I_other" }, coordination: "shared" },
    ]))).rejects.toMatchObject({ code: "RESOURCE_AUTHORITY_MISMATCH" });
  });

  it("uses a child's formal parent Issue identity and resolves board resources", async () => {
    const { authority, resolvedBoards } = fixture();
    await expect(authority.assertKnownContract(child, contract(child.id, [
      { capability: "tracker.mutate", resource: { kind: "issue", id: "I_kwDOExample" }, coordination: "shared" },
      { capability: "board.observe", resource: { kind: "board", id: "wlan-board" }, coordination: "shared" },
    ]))).resolves.toBeUndefined();
    expect(resolvedBoards).toEqual(["wlan-board"]);
  });

  it("rejects unsupported standalone host, firmware, and deployment authority", async () => {
    const { authority } = fixture();
    for (const grant of [
      { capability: "remote.execute" as const, resource: { kind: "remote_host" as const, id: "rhost-lab" }, coordination: "exclusive" as const },
      { capability: "firmware.change" as const, resource: { kind: "firmware_target" as const, id: "fwt-radio" }, coordination: "exclusive" as const },
      { capability: "deploy.execute" as const, resource: { kind: "deployment_target" as const, id: "dpl-staging" }, coordination: "exclusive" as const },
    ]) {
      await expect(authority.assertKnownContract(parent, contract(parent.id, [grant])))
        .rejects.toMatchObject({ code: "RESOURCE_AUTHORITY_UNSUPPORTED" });
    }
  });

  it("requires every dependency to exist without treating it as a grant", async () => {
    const dependency = { ...child, id: dependencyId, work_contract: { ...child.work_contract, task_id: dependencyId } } as TaskRecord;
    const { authority } = fixture([parent, child, dependency]);
    await expect(authority.assertKnownContract(parent, contract(parent.id, [], [
      { task_id: dependencyId, relation: "blocked_by" },
    ]))).resolves.toBeUndefined();
    await expect(authority.assertKnownContract(parent, contract(parent.id, [], [
      { task_id: "tsk-0181f8f0-0000-7000-8000-000000000004", relation: "blocked_by" },
    ]))).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});
