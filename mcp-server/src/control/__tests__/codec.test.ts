import { expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimHistorySchema, RepositoryRecordSchema } from "../schemas.js";
import { readRecord, writeRecord } from "../codec.js";

it("round-trips deterministic JSON-subset YAML with a trailing newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "jhw-codec-"));
  const file = join(root, "repositories", "repo-ab.yaml");
  const value = { id: "repo-ab", github_node_id: "R_1", slug: "jhw/a" };
  await writeRecord(file, value);
  expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
  expect(await readRecord(file, RepositoryRecordSchema)).toEqual(value);
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
    started_at: "2026-08-13T00:00:00.000Z",
    released_at: "2026-08-13T01:00:00.000Z",
  };
  const successor = "clm-0198aabb-ccdd-7eef-8abc-0123456789ac";

  expect(ClaimHistorySchema.safeParse({ ...base, status: "taken-over" }).success).toBe(true);
  expect(ClaimHistorySchema.safeParse({ ...base, status: "taken-over", successor_claim_id: successor }).success).toBe(true);
  expect(ClaimHistorySchema.safeParse({ ...base, status: "completed", successor_claim_id: successor }).success).toBe(false);
  expect(ClaimHistorySchema.safeParse({ ...base, status: "taken-over", successor_claim_id: "not-a-claim" }).success).toBe(false);
});
