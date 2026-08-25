import { createHash } from "node:crypto";
import { z } from "zod";
import { GithubNodeIdSchema, TaskIdSchema } from "./schemas.js";

export const CAPABILITIES = [
  "repo.inspect", "repo.modify", "git.commit", "git.publish",
  "tracker.mutate", "notion.mutate", "test.host",
  "board.observe", "board.execute", "remote.execute",
  "firmware.change", "deploy.execute", "integration.perform",
  "shell.unclassified",
] as const;

export const PERSISTED_CAPABILITIES = [
  "repo.inspect", "repo.modify", "git.commit", "git.publish",
  "tracker.mutate", "notion.mutate", "test.host",
  "board.observe", "board.execute", "remote.execute",
  "firmware.change", "deploy.execute", "integration.perform",
] as const;

export const RESOURCE_KINDS = [
  "repository", "issue", "notion_database", "board",
  "remote_host", "firmware_target", "deployment_target",
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;
export const PersistedCapabilitySchema = z.enum(PERSISTED_CAPABILITIES);
export type PersistedCapability = z.infer<typeof PersistedCapabilitySchema>;
export const ResourceKindSchema = z.enum(RESOURCE_KINDS);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

const resourceId = (prefix?: string) => z.string().regex(
  new RegExp(`^${prefix ?? ""}[a-z0-9][a-z0-9-]{1,62}$`),
);

export const ResourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository"), id: resourceId("repo-") }).strict(),
  z.object({ kind: z.literal("issue"), id: GithubNodeIdSchema }).strict(),
  z.object({ kind: z.literal("notion_database"), id: z.enum(["decisionLog", "preferences", "projects", "references", "knowledgeBase"]) }).strict(),
  z.object({ kind: z.literal("board"), id: resourceId() }).strict(),
  z.object({ kind: z.literal("remote_host"), id: resourceId("rhost-") }).strict(),
  z.object({ kind: z.literal("firmware_target"), id: resourceId("fwt-") }).strict(),
  z.object({ kind: z.literal("deployment_target"), id: resourceId("dpl-") }).strict(),
]);
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const CAPABILITY_RESOURCE_COMPATIBILITY: Record<ResourceKind, readonly PersistedCapability[]> = {
  repository: ["repo.inspect", "repo.modify", "git.commit", "git.publish", "test.host", "integration.perform"],
  issue: ["tracker.mutate"],
  notion_database: ["notion.mutate"],
  board: ["board.observe", "board.execute", "remote.execute", "firmware.change"],
  remote_host: ["remote.execute"],
  firmware_target: ["firmware.change"],
  deployment_target: ["deploy.execute"],
};

export const WorkGrantSchema = z
  .object({
    capability: PersistedCapabilitySchema,
    resource: ResourceRefSchema,
    coordination: z.enum(["exclusive", "shared"]),
  })
  .strict()
  .superRefine((grant, context) => {
    if (!CAPABILITY_RESOURCE_COMPATIBILITY[grant.resource.kind].includes(grant.capability)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capability"],
        message: "Capability is incompatible with resource kind",
      });
    }
  });
export type WorkGrant = z.infer<typeof WorkGrantSchema>;

export const TASK_DEPENDENCY_RELATIONS = ["blocked_by", "observes", "integrates"] as const;
export const TaskDependencySchema = z
  .object({ task_id: TaskIdSchema, relation: z.enum(TASK_DEPENDENCY_RELATIONS) })
  .strict();
export type TaskDependency = z.infer<typeof TaskDependencySchema>;

export const WorkContractSchema = z
  .object({
    version: z.literal(1),
    task_id: TaskIdSchema,
    grants: z.array(WorkGrantSchema),
    dependencies: z.array(TaskDependencySchema),
  })
  .strict()
  .superRefine((contract, context) => {
    const grants = new Set<string>();
    for (const [index, grant] of contract.grants.entries()) {
      const tuple = `${grant.capability}\u0000${grant.resource.kind}\u0000${grant.resource.id}`;
      if (grants.has(tuple)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["grants", index], message: "Duplicate capability and resource grant" });
      }
      grants.add(tuple);
    }
    for (const [index, dependency] of contract.dependencies.entries()) {
      if (dependency.task_id === contract.task_id) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies", index, "task_id"], message: "Task cannot depend on itself" });
      }
    }
  });
export type WorkContract = z.infer<typeof WorkContractSchema>;

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export function normalizeWorkContract(value: unknown): WorkContract {
  const contract = WorkContractSchema.parse(value);
  return {
    ...contract,
    grants: [...contract.grants].sort((left, right) =>
      compare(left.capability, right.capability) ||
      compare(left.resource.kind, right.resource.kind) ||
      compare(left.resource.id, right.resource.id) ||
      compare(left.coordination, right.coordination)),
    dependencies: [...contract.dependencies].sort((left, right) =>
      compare(left.relation, right.relation) || compare(left.task_id, right.task_id)),
  };
}

export function workContractDigest(value: unknown): string {
  const normalized = normalizeWorkContract(value);
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

export function conflictingExclusiveGrant(
  left: WorkContract,
  right: WorkContract,
): WorkGrant | undefined {
  return left.grants.find((grant) => right.grants.some((candidate) =>
    grant.resource.kind === candidate.resource.kind &&
    grant.resource.id === candidate.resource.id &&
    (grant.coordination === "exclusive" || candidate.coordination === "exclusive")));
}
