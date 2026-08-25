import { createHash } from "node:crypto";

import { z } from "zod";

import { ControlError } from "./errors.js";
import { OffsetDateTimeSchema, type ChildTask, type FormalTask } from "./schemas.js";
import { TaskIdSchema } from "./work-contract.js";

const ClaimIdSchema = z.string().regex(
  /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const boundedUtf8 = (maximumBytes: number) => z.string().min(1).max(maximumBytes)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);

export const ChildDispositionSchema = z.enum(["superseded", "not-required", "accepted-risk"]);
export type ChildDisposition = z.infer<typeof ChildDispositionSchema>;

export const TaskCompletionEvidenceSchema = z.object({
  integration_validation: z.array(
    boundedUtf8(512).refine((value) => value.trim().length > 0),
  ).min(1).max(64),
  child_dispositions: z.array(z.object({
    task_id: TaskIdSchema,
    disposition: ChildDispositionSchema,
  }).strict()).max(64).refine(
    (entries) => new Set(entries.map((entry) => entry.task_id)).size === entries.length,
    "Duplicate child disposition",
  ),
}).strict();
export type TaskCompletionEvidence = z.infer<typeof TaskCompletionEvidenceSchema>;

export const TaskCompletionEvidenceRecordSchema = z.object({
  version: z.literal(1),
  task_id: TaskIdSchema,
  claim_id: ClaimIdSchema,
  work_contract_digest: z.string().regex(/^[0-9a-f]{64}$/),
  recorded_at: OffsetDateTimeSchema,
  evidence: TaskCompletionEvidenceSchema,
}).strict();
export type TaskCompletionEvidenceRecord = z.infer<typeof TaskCompletionEvidenceRecordSchema>;

export function taskCompletionRelativePath(taskId: string, claimId: string): string {
  if (!TaskIdSchema.safeParse(taskId).success || !ClaimIdSchema.safeParse(claimId).success) {
    throw new ControlError(
      "INVALID_TASK_COMPLETION_PATH",
      "Task completion evidence requires exact canonical Task and Claim IDs",
    );
  }
  return `task-completion/${taskId}/${claimId}.yaml`;
}

export function taskCompletionEvidenceDigest(record: TaskCompletionEvidenceRecord): string {
  const parsed = TaskCompletionEvidenceRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new ControlError("INVALID_COMPLETION_EVIDENCE", "Task completion evidence record failed validation");
  }
  return createHash("sha256").update(JSON.stringify(parsed.data), "utf8").digest("hex");
}

export function assertParentCompletionReady(
  parent: FormalTask,
  children: readonly ChildTask[],
  evidence: TaskCompletionEvidence,
): void {
  if (parent.kind !== "formal" || parent.task_role !== "parent") {
    throw new ControlError("INVALID_PARENT_COMPLETION", "Completion gate requires a formal parent Task");
  }
  if (
    !Array.isArray(evidence.integration_validation) ||
    evidence.integration_validation.length === 0 ||
    evidence.integration_validation.length > 64 ||
    evidence.integration_validation.some((entry) =>
      typeof entry !== "string" || !entry.trim() || Buffer.byteLength(entry, "utf8") > 512)
  ) {
    throw new ControlError(
      "PARENT_INTEGRATION_VALIDATION_REQUIRED",
      "Parent completion requires bounded integration validation",
    );
  }
  const parsedEvidence = TaskCompletionEvidenceSchema.safeParse(evidence);
  if (!parsedEvidence.success) {
    throw new ControlError("INVALID_PARENT_COMPLETION", "Parent completion evidence failed validation");
  }
  const validatedEvidence = parsedEvidence.data;

  const childById = new Map<string, ChildTask>();
  for (const child of children) {
    if (child.parent_task_id !== parent.id || childById.has(child.id)) {
      throw new ControlError("INVALID_PARENT_COMPLETION", "Parent child set is inconsistent");
    }
    childById.set(child.id, child);
  }

  const dispositionById = new Map<string, ChildDisposition>();
  for (const entry of validatedEvidence.child_dispositions) {
    if (dispositionById.has(entry.task_id)) {
      throw new ControlError("INVALID_PARENT_COMPLETION", "A child has more than one disposition");
    }
    const child = childById.get(entry.task_id);
    if (!child || !child.required_for_parent || child.lifecycle !== "abandoned") {
      throw new ControlError(
        "INVALID_PARENT_COMPLETION",
        "Only required abandoned children may carry a parent disposition",
      );
    }
    dispositionById.set(entry.task_id, entry.disposition);
  }

  const incomplete = children.find((child) =>
    child.required_for_parent && child.lifecycle !== "completed" && child.lifecycle !== "abandoned");
  if (incomplete) {
    throw new ControlError("PARENT_CHILDREN_INCOMPLETE", "A required child is not terminal", {
      task_id: incomplete.id,
    });
  }

  const undisposed = children.find((child) =>
    child.required_for_parent && child.lifecycle === "abandoned" && !dispositionById.has(child.id));
  if (undisposed) {
    throw new ControlError(
      "PARENT_DISPOSITION_REQUIRED",
      "A required abandoned child needs one exact disposition",
      { task_id: undisposed.id },
    );
  }
}
