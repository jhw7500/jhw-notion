import { expect, it } from "vitest";
import { ClaimHistorySchema, RepositoryRecordSchema } from "../schemas.js";
import * as codec from "../codec.js";

it("does not expose legacy path-based Registry persistence helpers", () => {
  expect(codec).not.toHaveProperty("readRecord");
  expect(codec).not.toHaveProperty("writeRecord");
});

it("rejects repository records without a canonical repo ID", () => {
  expect(
    RepositoryRecordSchema.safeParse({
      id: "repo-a",
      github_node_id: "R_1",
      slug: "jhw/a",
    }).success,
  ).toBe(false);
});

it("accepts legacy takeover history but reserves a typed successor link for takeovers", () => {
  const base = {
    task_id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ab",
    task_alias: "control:task",
    project_id: "prj-control",
    repo_id: "repo-control",
    claim_id: "clm-0198aabb-ccdd-7eef-8abc-0123456789ab",
    session_id: "codex-old",
    host: "build-host",
    branch: "task/example",
    worktree_ref: "wt-example",
    source_task_revision: "revision-1",
    started_at: "2026-08-13T00:00:00.000Z",
    released_at: "2026-08-13T01:00:00.000Z",
  };
  const successor = "clm-0198aabb-ccdd-7eef-8abc-0123456789ac";

  expect(ClaimHistorySchema.safeParse({ ...base, status: "taken-over" }).success).toBe(true);
  expect(ClaimHistorySchema.safeParse({ ...base, status: "taken-over", successor_claim_id: successor }).success).toBe(true);
  expect(ClaimHistorySchema.safeParse({ ...base, status: "completed", successor_claim_id: successor }).success).toBe(false);
  expect(ClaimHistorySchema.safeParse({ ...base, status: "taken-over", successor_claim_id: "not-a-claim" }).success).toBe(false);
});
