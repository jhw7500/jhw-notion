import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionEndRecorder } from "../session-end.js";
import { workContractDigest } from "../work-contract.js";

const roots: string[] = [];
const taskId = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const claimId = "clm-018f21e0-7b2c-7a00-8000-000000000002";
const workContract = { version: 1 as const, task_id: taskId, grants: [], dependencies: [] };
const claim = {
  task_id: taskId,
  task_alias: "control:session-end",
  project_id: "prj-control",
  repo_id: "repo-control",
  claim_id: claimId,
  origin_adapter: "codex" as const,
  session_id: "codex-session-end",
  host: "build-host",
  branch: "task/000000000001-control-session-end",
  worktree_ref: "wt-000000000001-control-session-end",
  source_task_revision: "2026-08-13T00:00:00Z",
  started_at: "2026-08-13T00:00:00.000Z",
  work_contract: workContract,
  work_contract_digest: workContractDigest(workContract),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jhw-session-end-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  const nested = join(worktree, "src");
  await mkdir(nested, { recursive: true });
  const claims = { listActiveClaims: vi.fn().mockResolvedValue([claim]) };
  const tasks = {
    inspectForGuard: vi.fn().mockResolvedValue({
      active: claim,
      worktree: {
        path: worktree,
        repository_path: join(root, "repository"),
        branch: claim.branch,
        worktree_ref: claim.worktree_ref,
        head_sha: "a".repeat(40),
        dirty: true,
        dirty_files: ["src/changed.ts"],
        ahead: 2,
        behind: 1,
      },
    }),
  };
  const journal = { append: vi.fn().mockResolvedValue(undefined) };
  const recorder = new SessionEndRecorder({
    host: "build-host",
    claims,
    tasks,
    journal,
    now: () => new Date("2026-09-09T10:00:00.000Z"),
  });
  return { recorder, claims, tasks, journal, root, worktree, nested };
}

describe("SessionEndRecorder", () => {
  it("records only verified logical Git coordinates and omits session/private paths", async () => {
    const { recorder, journal, nested, root } = await fixture();

    await expect(recorder.record({
      protocol_version: 1,
      adapter: "codex",
      event: "session_end",
      session_id: claim.session_id,
      cwd: nested,
    })).resolves.toEqual({ status: "RECORDED" });

    expect(journal.append).toHaveBeenCalledWith({
      protocol_version: 1,
      origin_adapter: "codex",
      event: "session-ended",
      task_id: taskId,
      claim_id: claimId,
      worktree_ref: claim.worktree_ref,
      branch: claim.branch,
      head_sha: "a".repeat(40),
      dirty: true,
      ahead: 2,
      behind: 1,
      occurred_at: "2026-09-09T10:00:00.000Z",
    });
    const persisted = JSON.stringify(journal.append.mock.calls[0]);
    expect(persisted).not.toContain(claim.session_id);
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain("src/changed.ts");
  });

  it("does nothing when no exact adapter/session/host Claim exists", async () => {
    const { recorder, claims, tasks, journal, nested } = await fixture();
    claims.listActiveClaims.mockResolvedValue([{ ...claim, session_id: "other-session" }]);

    await expect(recorder.record({
      protocol_version: 1,
      adapter: "codex",
      event: "session_end",
      session_id: claim.session_id,
      cwd: nested,
    })).resolves.toEqual({ status: "NO_MATCH" });

    expect(tasks.inspectForGuard).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("fails closed without journaling for ambiguous Claims, cwd escape, or inspection mismatch", async () => {
    const { recorder, claims, tasks, journal, nested, root } = await fixture();
    const event = {
      protocol_version: 1,
      adapter: "codex",
      event: "session_end",
      session_id: claim.session_id,
      cwd: nested,
    };
    claims.listActiveClaims.mockResolvedValue([claim, { ...claim, claim_id: "clm-018f21e0-7b2c-7a00-8000-000000000003" }]);
    await expect(recorder.record(event)).resolves.toEqual({ status: "AMBIGUOUS" });
    expect(journal.append).not.toHaveBeenCalled();

    claims.listActiveClaims.mockResolvedValue([claim]);
    await expect(recorder.record({ ...event, cwd: root })).resolves.toEqual({ status: "UNVERIFIED" });
    expect(journal.append).not.toHaveBeenCalled();

    tasks.inspectForGuard.mockResolvedValueOnce({
      ...(await tasks.inspectForGuard(taskId, claimId)),
      active: { ...claim, claim_id: "clm-018f21e0-7b2c-7a00-8000-000000000003" },
    });
    await expect(recorder.record(event)).resolves.toEqual({ status: "UNVERIFIED" });
    expect(journal.append).not.toHaveBeenCalled();
  });
});
