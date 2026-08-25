import { describe, expect, it } from "vitest";

import {
  ChildDispositionSchema,
  TaskCompletionEvidenceRecordSchema,
  TaskCompletionEvidenceSchema,
  assertParentCompletionReady,
  taskCompletionRelativePath,
} from "../task-completion.js";
import { ClaimHistorySchema, type ChildTask, type FormalTask } from "../schemas.js";

const PARENT_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CHILD_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000002";
const OTHER_CHILD_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000003";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000004";
const DIGEST = "a".repeat(64);

const parent: FormalTask = {
  id: PARENT_ID,
  kind: "formal",
  project_id: "prj-wlan",
  repo_id: "repo-wlan",
  aliases: ["jhw7500/wlan#1"],
  issue_node_id: "I_parent",
  issue_revision: "2026-08-25T00:00:00Z",
  issue_url: "https://github.com/jhw7500/wlan/issues/1",
  task_role: "parent",
  work_contract: { version: 1, task_id: PARENT_ID, grants: [], dependencies: [] },
};

function child(
  lifecycle: ChildTask["lifecycle"],
  required_for_parent = true,
  id = CHILD_ID,
): ChildTask {
  return {
    id,
    kind: "child",
    parent_task_id: PARENT_ID,
    required_for_parent,
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    aliases: [`wlan:${id}`],
    goal: "bounded child work",
    done_conditions: ["done"],
    lifecycle,
    work_contract: { version: 1, task_id: id, grants: [], dependencies: [] },
  };
}

const evidence = {
  integration_validation: ["npm test: pass"],
  child_dispositions: [] as Array<{
    task_id: string;
    disposition: "superseded" | "not-required" | "accepted-risk";
  }>,
};

describe("Task completion evidence schemas", () => {
  it("accepts only the closed child-disposition vocabulary", () => {
    expect(ChildDispositionSchema.safeParse("superseded").success).toBe(true);
    expect(ChildDispositionSchema.safeParse("not-required").success).toBe(true);
    expect(ChildDispositionSchema.safeParse("accepted-risk").success).toBe(true);
    expect(ChildDispositionSchema.safeParse("ignored").success).toBe(false);
  });

  it("strictly bounds evidence and its immutable record", () => {
    expect(TaskCompletionEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(TaskCompletionEvidenceSchema.safeParse({ ...evidence, unknown: true }).success).toBe(false);
    expect(TaskCompletionEvidenceSchema.safeParse({
      ...evidence,
      integration_validation: ["x".repeat(513)],
    }).success).toBe(false);
    expect(TaskCompletionEvidenceSchema.safeParse({
      ...evidence,
      child_dispositions: Array.from({ length: 65 }, () => ({
        task_id: CHILD_ID,
        disposition: "superseded",
      })),
    }).success).toBe(false);

    const record = {
      version: 1,
      task_id: PARENT_ID,
      claim_id: CLAIM_ID,
      work_contract_digest: DIGEST,
      recorded_at: "2026-08-25T00:00:00Z",
      evidence,
    };
    expect(TaskCompletionEvidenceRecordSchema.safeParse(record).success).toBe(true);
    expect(TaskCompletionEvidenceRecordSchema.safeParse({ ...record, claim_id: "clm-bad" }).success).toBe(false);
    expect(TaskCompletionEvidenceRecordSchema.safeParse({ ...record, extra: true }).success).toBe(false);
  });

  it("constructs only the bounded canonical Task/Claim evidence path", () => {
    expect(taskCompletionRelativePath(PARENT_ID, CLAIM_ID)).toBe(
      `task-completion/${PARENT_ID}/${CLAIM_ID}.yaml`,
    );
    expect(() => taskCompletionRelativePath("../tasks", CLAIM_ID)).toThrowError(
      expect.objectContaining({ code: "INVALID_TASK_COMPLETION_PATH" }),
    );
    expect(() => taskCompletionRelativePath(PARENT_ID, `${CLAIM_ID}/extra`)).toThrowError(
      expect.objectContaining({ code: "INVALID_TASK_COMPLETION_PATH" }),
    );
  });

  it("permits an exact evidence pointer only on matching completed history", () => {
    const history = {
      task_id: PARENT_ID,
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      claim_id: CLAIM_ID,
      session_id: "codex-a",
      host: "build-host",
      branch: "task/wlan-parent",
      worktree_ref: "wt-wlan-parent",
      source_task_revision: "2026-08-25T00:00:00Z",
      started_at: "2026-08-25T00:00:00Z",
      released_at: "2026-08-25T01:00:00Z",
      status: "completed" as const,
      outcome: "done",
      completion_evidence_path: taskCompletionRelativePath(PARENT_ID, CLAIM_ID),
      completion_evidence_digest: DIGEST,
    };
    expect(ClaimHistorySchema.safeParse(history).success).toBe(true);
    expect(ClaimHistorySchema.safeParse({ ...history, status: "handoff" }).success).toBe(false);
    expect(ClaimHistorySchema.safeParse({
      ...history,
      completion_evidence_path: taskCompletionRelativePath(OTHER_CHILD_ID, CLAIM_ID),
    }).success).toBe(false);
    const { completion_evidence_digest: _digest, ...withoutDigest } = history;
    expect(ClaimHistorySchema.safeParse(withoutDigest).success).toBe(false);
  });
});

describe("assertParentCompletionReady", () => {
  it.each(["active", "handoff"] as const)(
    "rejects a required %s child because handoff is non-terminal",
    (lifecycle) => {
      expect(() => assertParentCompletionReady(parent, [child(lifecycle)], evidence)).toThrowError(
        expect.objectContaining({ code: "PARENT_CHILDREN_INCOMPLETE" }),
      );
    },
  );

  it("requires exactly one disposition for every required abandoned child", () => {
    expect(() => assertParentCompletionReady(parent, [child("abandoned")], evidence)).toThrowError(
      expect.objectContaining({ code: "PARENT_DISPOSITION_REQUIRED" }),
    );
    expect(() => assertParentCompletionReady(parent, [child("abandoned")], {
      ...evidence,
      child_dispositions: [
        { task_id: CHILD_ID, disposition: "superseded" },
        { task_id: CHILD_ID, disposition: "accepted-risk" },
      ],
    })).toThrowError(expect.objectContaining({ code: "INVALID_PARENT_COMPLETION" }));
  });

  it("rejects a disposition outside the closed schema at the pure gate", () => {
    expect(() => assertParentCompletionReady(parent, [child("abandoned")], {
      ...evidence,
      child_dispositions: [{ task_id: CHILD_ID, disposition: "ignored" }],
    } as never)).toThrowError(expect.objectContaining({ code: "INVALID_PARENT_COMPLETION" }));
  });

  it.each([
    ["completed child", [child("completed")], CHILD_ID],
    ["optional child", [child("abandoned", false)], CHILD_ID],
    ["unknown child", [child("completed")], OTHER_CHILD_ID],
  ] as const)("rejects a disposition for a %s", (_name, children, taskId) => {
    expect(() => assertParentCompletionReady(parent, [...children], {
      ...evidence,
      child_dispositions: [{ task_id: taskId, disposition: "not-required" }],
    })).toThrowError(expect.objectContaining({ code: "INVALID_PARENT_COMPLETION" }));
  });

  it("requires nonempty bounded integration validation", () => {
    expect(() => assertParentCompletionReady(parent, [child("completed")], {
      ...evidence,
      integration_validation: [],
    })).toThrowError(expect.objectContaining({ code: "PARENT_INTEGRATION_VALIDATION_REQUIRED" }));
    expect(() => assertParentCompletionReady(parent, [child("completed")], {
      ...evidence,
      integration_validation: ["   "],
    })).toThrowError(expect.objectContaining({ code: "PARENT_INTEGRATION_VALIDATION_REQUIRED" }));
  });

  it("allows optional children to remain non-terminal", () => {
    expect(() => assertParentCompletionReady(parent, [
      child("completed"),
      child("active", false, OTHER_CHILD_ID),
    ], evidence)).not.toThrow();
  });

  it("accepts one exact disposition for a required abandoned child", () => {
    expect(() => assertParentCompletionReady(parent, [child("abandoned")], {
      ...evidence,
      child_dispositions: [{ task_id: CHILD_ID, disposition: "accepted-risk" }],
    })).not.toThrow();
  });
});
