import { describe, expect, it } from "vitest";
import {
  CAPABILITY_RESOURCE_COMPATIBILITY,
  CapabilitySchema,
  conflictingExclusiveGrant,
  PersistedCapabilitySchema,
  ResourceRefSchema,
  WorkContractSchema,
  normalizeWorkContract,
  workContractDigest,
} from "../work-contract.js";

const taskId = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const dependencyTaskId = "tsk-018f21e0-7b2c-7a00-8000-000000000002";

const repositoryGrant = (capability: "repo.inspect" | "repo.modify" | "git.commit" | "git.publish" | "test.host" | "integration.perform", coordination: "exclusive" | "shared" = "shared") => ({
  capability,
  resource: { kind: "repository" as const, id: "repo-wlan-package" },
  coordination,
});

describe("work contracts", () => {
  it("normalizes exact grants and dependencies before hashing", () => {
    const input = {
      version: 1 as const,
      task_id: taskId,
      grants: [
        repositoryGrant("git.commit"),
        repositoryGrant("repo.modify"),
      ],
      dependencies: [
        { task_id: dependencyTaskId, relation: "observes" as const },
        { task_id: taskId.replace("001", "003"), relation: "blocked_by" as const },
      ],
    };
    const reversed = {
      ...input,
      grants: [...input.grants].reverse(),
      dependencies: [...input.dependencies].reverse(),
    };

    expect(normalizeWorkContract(input)).toEqual({
      version: 1,
      task_id: taskId,
      grants: [
        repositoryGrant("git.commit"),
        repositoryGrant("repo.modify"),
      ],
      dependencies: [
        { task_id: taskId.replace("001", "003"), relation: "blocked_by" },
        { task_id: dependencyTaskId, relation: "observes" },
      ],
    });
    expect(normalizeWorkContract(input)).toEqual(normalizeWorkContract(reversed));
    expect(workContractDigest(input)).toBe(workContractDigest(reversed));
    expect(workContractDigest(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts only compatible exact capability and resource grants", () => {
    const compatibleGrants = [
      repositoryGrant("repo.inspect"),
      repositoryGrant("repo.modify"),
      repositoryGrant("git.commit"),
      repositoryGrant("git.publish"),
      repositoryGrant("test.host"),
      repositoryGrant("integration.perform"),
      { capability: "tracker.mutate", resource: { kind: "issue", id: "I_kwDOAb-123" }, coordination: "shared" },
      { capability: "notion.mutate", resource: { kind: "notion_database", id: "decisionLog" }, coordination: "shared" },
      { capability: "board.observe", resource: { kind: "board", id: "board-alpha" }, coordination: "shared" },
      { capability: "board.execute", resource: { kind: "board", id: "board-alpha" }, coordination: "shared" },
      { capability: "remote.execute", resource: { kind: "board", id: "board-alpha" }, coordination: "shared" },
      { capability: "firmware.change", resource: { kind: "board", id: "board-alpha" }, coordination: "shared" },
      { capability: "remote.execute", resource: { kind: "remote_host", id: "rhost-alpha" }, coordination: "shared" },
      { capability: "firmware.change", resource: { kind: "firmware_target", id: "fwt-alpha" }, coordination: "shared" },
      { capability: "deploy.execute", resource: { kind: "deployment_target", id: "dpl-alpha" }, coordination: "shared" },
    ];

    for (const grant of compatibleGrants) {
      expect(WorkContractSchema.safeParse({ version: 1, task_id: taskId, grants: [grant], dependencies: [] }).success).toBe(true);
    }
    expect(CAPABILITY_RESOURCE_COMPATIBILITY.repository).toEqual([
      "repo.inspect", "repo.modify", "git.commit", "git.publish", "test.host", "integration.perform",
    ]);
  });

  it("rejects unknown fields, aliases, wildcards, and incompatible grants", () => {
    const contract = { version: 1, task_id: taskId, grants: [repositoryGrant("repo.inspect")], dependencies: [] };
    const invalidContracts = [
      { ...contract, unknown: true },
      { ...contract, grants: [{ ...repositoryGrant("repo.inspect"), capability: "repo.write" }] },
      { ...contract, grants: [{ ...repositoryGrant("repo.inspect"), capability: "repo.*" }] },
      { ...contract, grants: [{ ...repositoryGrant("repo.inspect"), capability_alias: "repo.inspect" }] },
      { ...contract, grants: [{ ...repositoryGrant("repo.inspect"), resource: { kind: "repository", id: "*" } }] },
      { ...contract, grants: [{ ...repositoryGrant("repo.inspect"), resource: { kind: "issue", id: "I_kwDOAb-123" } }] },
    ];

    for (const invalidContract of invalidContracts) {
      expect(WorkContractSchema.safeParse(invalidContract).success).toBe(false);
    }
  });

  it("uses strict canonical resource references", () => {
    const validReferences = [
      { kind: "repository", id: "repo-wlan-package" },
      { kind: "issue", id: "I_kwDOAb-123" },
      { kind: "notion_database", id: "knowledgeBase" },
      { kind: "board", id: "board-alpha" },
      { kind: "remote_host", id: "rhost-alpha" },
      { kind: "firmware_target", id: "fwt-alpha" },
      { kind: "deployment_target", id: "dpl-alpha" },
    ];

    for (const reference of validReferences) expect(ResourceRefSchema.safeParse(reference).success).toBe(true);
    expect(ResourceRefSchema.safeParse({ kind: "repository", id: "repo-wlan-package", extra: true }).success).toBe(false);
    expect(ResourceRefSchema.safeParse({ kind: "notion_database", id: "projects" }).success).toBe(true);
    expect(ResourceRefSchema.safeParse({ kind: "notion_database", id: "project" }).success).toBe(false);
  });

  it("rejects duplicate grants even when coordination differs and rejects self-dependencies", () => {
    expect(WorkContractSchema.safeParse({
      version: 1,
      task_id: taskId,
      grants: [repositoryGrant("repo.modify", "shared"), repositoryGrant("repo.modify", "exclusive")],
      dependencies: [],
    }).success).toBe(false);
    expect(WorkContractSchema.safeParse({
      version: 1,
      task_id: taskId,
      grants: [],
      dependencies: [{ task_id: taskId, relation: "blocked_by" }],
    }).success).toBe(false);
  });

  it("does not persist the unknown-shell sentinel", () => {
    expect(CapabilitySchema.safeParse("shell.unclassified").success).toBe(true);
    expect(PersistedCapabilitySchema.safeParse("shell.unclassified").success).toBe(false);
    expect(WorkContractSchema.safeParse({
      version: 1,
      task_id: taskId,
      grants: [{
        capability: "shell.unclassified",
        resource: { kind: "repository", id: "repo-wlan-package" },
        coordination: "shared",
      }],
      dependencies: [],
    }).success).toBe(false);
  });

  it("finds an exclusive conflict by exact canonical resource regardless of capability", () => {
    const left = WorkContractSchema.parse({
      version: 1,
      task_id: taskId,
      grants: [repositoryGrant("repo.inspect", "shared")],
      dependencies: [],
    });
    const right = WorkContractSchema.parse({
      version: 1,
      task_id: dependencyTaskId,
      grants: [repositoryGrant("git.commit", "exclusive")],
      dependencies: [],
    });

    expect(conflictingExclusiveGrant(left, right)).toEqual(repositoryGrant("repo.inspect", "shared"));
  });
});
