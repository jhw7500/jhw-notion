import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GuardDecisionSchema,
  GuardService,
  GuardSideEventResultSchema,
  type GuardPermitDecisionPort,
  type GuardServiceOptions,
} from "../guard-service.js";
import type { OperationRequirement } from "../guard-protocol.js";
import {
  ContractActiveClaimSchema,
  type ActiveClaim,
  type ContractActiveClaim,
  type TaskRecord,
} from "../schemas.js";
import type { WorktreeInspection } from "../worktree.js";
import {
  normalizeWorkContract,
  workContractDigest,
  type WorkContract,
  type WorkGrant,
} from "../work-contract.js";

const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const OTHER_TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000002";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000003";
const OTHER_CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000004";
const REQUEST_ID = "req-018f21e0-7b2c-7a00-8000-000000000005";
const SESSION_ID = "codex-guard-task";
const HOST = "cantopsbuildserver";
const REPOSITORY = { kind: "repository", id: "repo-guard" } as const;
const BOARD = { kind: "board", id: "board-alpha" } as const;
const runFile = promisify(execFile);

function contract(taskId: string, grants: WorkGrant[]): WorkContract {
  return normalizeWorkContract({ version: 1, task_id: taskId, grants, dependencies: [] });
}

function grant(
  capability: WorkGrant["capability"],
  resource: WorkGrant["resource"] = REPOSITORY,
  coordination: WorkGrant["coordination"] = "shared",
): WorkGrant {
  return { capability, resource, coordination };
}

function taskWith(workContract: WorkContract): TaskRecord {
  return {
    id: TASK_ID,
    kind: "temporary",
    project_id: "prj-guard",
    repo_id: REPOSITORY.id,
    aliases: ["guard-task"],
    goal: "Guard policy fixture",
    done_conditions: ["bounded decisions"],
    expected_scope: ["repository"],
    lifecycle: "active",
    task_role: "standalone",
    work_contract: workContract,
  };
}

function activeClaim(workContract: WorkContract): ContractActiveClaim {
  return ContractActiveClaimSchema.parse({
    task_id: workContract.task_id,
    task_alias: workContract.task_id === TASK_ID ? "guard-task" : "other-task",
    project_id: "prj-guard",
    repo_id: REPOSITORY.id,
    claim_id: workContract.task_id === TASK_ID ? CLAIM_ID : OTHER_CLAIM_ID,
    origin_adapter: "codex",
    session_id: workContract.task_id === TASK_ID ? SESSION_ID : "codex-other-task",
    host: HOST,
    branch: workContract.task_id === TASK_ID ? "task/guard-task" : "task/other-task",
    worktree_ref: workContract.task_id === TASK_ID ? "wt-guard-task" : "wt-other-task",
    source_task_revision: "2026-08-25T00:00:00.000Z",
    started_at: "2026-08-25T00:00:00.000Z",
    work_contract: workContract,
    work_contract_digest: workContractDigest(workContract),
  });
}

function legacyClaim(): ActiveClaim {
  const { work_contract: _contract, work_contract_digest: _digest, ...legacy } = activeClaim(
    contract(OTHER_TASK_ID, [grant("repo.inspect")]),
  );
  return legacy;
}

function preTool(
  cwd: string,
  tool_name = "Edit",
  tool_input: unknown = { file_path: "src/file.ts", old_string: "a", new_string: "b" },
): unknown {
  return {
    protocol_version: 1,
    adapter: "codex",
    event: "pre_tool_use",
    session_id: SESSION_ID,
    cwd,
    tool_name,
    tool_input,
    tool_use_id: "call-guard-1",
  };
}

interface Fixture {
  root: string;
  cwd: string;
  currentContract: WorkContract;
  currentTask: TaskRecord;
  currentClaim?: ContractActiveClaim;
  activeClaims: ActiveClaim[];
  inspection: WorktreeInspection;
  permitCalls: number;
  barrierCalls: number;
  claimLookups: number;
  authorityCalls: number;
  authorityFailure?: Error;
  permit?: GuardPermitDecisionPort;
  options(overrides?: Partial<GuardServiceOptions>): GuardServiceOptions;
  service(overrides?: Partial<GuardServiceOptions>): GuardService;
}

describe("GuardService", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-service-"));
    const cwd = join(root, "src");
    await runFile("git", ["init", "--quiet", root]);
    await mkdir(cwd);
    await writeFile(join(cwd, "file.ts"), "a\n", "utf8");
    const currentContract = contract(TASK_ID, [grant("repo.inspect"), grant("repo.modify")]);
    const currentClaim = activeClaim(currentContract);
    const inspection: WorktreeInspection = {
      path: root,
      repository_path: root,
      branch: currentClaim.branch,
      worktree_ref: currentClaim.worktree_ref,
      head_sha: "a".repeat(40),
      dirty: false,
      dirty_files: [],
      ahead: 0,
      behind: 0,
    };

    fixture = {
      root,
      cwd,
      currentContract,
      currentTask: taskWith(currentContract),
      currentClaim,
      activeClaims: [currentClaim],
      inspection,
      permitCalls: 0,
      barrierCalls: 0,
      claimLookups: 0,
      authorityCalls: 0,
      permit: {
        decideMissingGrant: async (operation, missing) => {
          fixture.permitCalls += 1;
          return {
            task_id: operation.task_id,
            claim_id: operation.claim_id,
            origin_adapter: operation.origin_adapter,
            session_id: operation.session_id,
            cwd_worktree_ref: operation.cwd_worktree_ref,
            requirements: operation.requirements,
            missing_requirements: missing,
            operation_digest: operation.digest,
            request_id: REQUEST_ID,
            approval_expires_at: "2026-08-25T10:10:00+09:00",
          };
        },
      },
      options(overrides = {}) {
        const base: GuardServiceOptions = {
          host: HOST,
          digest_key: Buffer.alloc(32, 7),
          claims: {
            resolveSessionClaim: async (_adapter, sessionId, host) => {
              fixture.claimLookups += 1;
              return fixture.currentClaim?.session_id === sessionId && fixture.currentClaim.host === host
                ? fixture.currentClaim
                : undefined;
            },
            listActiveClaims: async () => fixture.activeClaims,
          },
          tasks: {
            getTask: async (taskId) => {
              if (taskId === TASK_ID) return fixture.currentTask;
              throw new Error("unknown task");
            },
            inspectForGuard: async () => {
              if (!fixture.currentClaim) throw new Error("claim disappeared");
              return { active: fixture.currentClaim, worktree: fixture.inspection };
            },
            sourceRevisionForGuard: async () => fixture.currentClaim?.source_task_revision ?? "missing",
          },
          authority: {
            assertKnownRequirement: async (_task, _requirement) => {
              fixture.authorityCalls += 1;
              if (fixture.authorityFailure) throw fixture.authorityFailure;
            },
          },
          permit_decisions: fixture.permit,
          registry_view: {
            withCommittedView: async <T>(read: () => Promise<T>) => read(),
            committedViewIsStale: async () => false,
          },
          registry_mutation_barrier: {
            run: async <T>(read: () => Promise<T>) => {
              fixture.barrierCalls += 1;
              return read();
            },
          },
        };
        return { ...base, ...overrides };
      },
      service(overrides = {}) {
        return new GuardService(fixture.options(overrides));
      },
    };
  });

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  it("denies malformed protocol before Claim lookup or permit policy", async () => {
    const result = await fixture.service().evaluatePreTool({
      ...preTool(fixture.cwd) as object,
      protocol_version: 2,
      raw_command: "do not expose",
    });

    expect(result).toEqual({
      decision: "DENY",
      code: "GUARD_PROTOCOL_MISMATCH",
      summary: "Guard protocol input is invalid",
    });
    expect(fixture.claimLookups).toBe(0);
    expect(fixture.permitCalls).toBe(0);
  });

  it("allows only the closed local read and status fast path without a Claim", async () => {
    fixture.currentClaim = undefined;
    fixture.activeClaims = [];

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Read", { file_path: "src/file.ts" })))
      .resolves.toMatchObject({ decision: "ALLOW", execution_boundary: "hook", summary: "Local repository read" });
    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Bash", { command: "git status --short" })))
      .resolves.toMatchObject({ decision: "ALLOW", execution_boundary: "hook", summary: "Local repository status" });
    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "WebFetch", { url: "https://example.invalid" })))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_CLAIM_REQUIRED" });
    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Bash", { command: "ssh host cat /etc/os-release" })))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_CLAIM_REQUIRED" });
  });

  it("does not treat suffix aliases, outside paths, sensitive files, or symlinks as Claim-free reads", async () => {
    fixture.currentClaim = undefined;
    fixture.activeClaims = [];
    await writeFile(join(fixture.root, ".env"), "bounded fixture\n", "utf8");
    await symlink(join(fixture.cwd, "file.ts"), join(fixture.cwd, "linked-read.ts"));

    for (const event of [
      preTool(fixture.cwd, "mcp__remote__read", { file_path: "src/file.ts" }),
      preTool(fixture.cwd, "Read", { file_path: "/etc/shadow" }),
      preTool(fixture.cwd, "Read", { file_path: "../outside" }),
      preTool(fixture.cwd, "Read", { file_path: ".env" }),
      preTool(fixture.cwd, "Read", { file_path: "src/linked-read.ts" }),
      preTool(fixture.cwd, "Read", { file_path: "src/file.ts", url: "https://example.invalid" }),
      preTool(fixture.cwd, "Grep", { pattern: "token", path: "../" }),
    ]) {
      await expect(fixture.service().evaluatePreTool(event)).resolves.toMatchObject({
        decision: "DENY",
        code: "GUARD_CLAIM_REQUIRED",
      });
    }
  });

  it("fails closed for unproved native Glob and Grep match sets while retaining an exact nested Read", async () => {
    fixture.currentClaim = undefined;
    fixture.activeClaims = [];
    await writeFile(join(fixture.root, ".env"), "bounded fixture\n", "utf8");
    await writeFile(join(fixture.root, "credentials"), "bounded fixture\n", "utf8");
    await writeFile(join(fixture.root, ".notes"), "bounded fixture\n", "utf8");
    await mkdir(join(fixture.root, "nested"));
    await writeFile(join(fixture.root, "nested", "inside.ts"), "safe\n", "utf8");
    await symlink(join(fixture.cwd, "file.ts"), join(fixture.root, "root-link"));

    for (const event of [
      preTool(fixture.cwd, "Glob", { pattern: "**/*", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: "root-link", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: ".env", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: "credentials", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: ".*", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: "nested/*.ts", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: "*.ts", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: "{src,nested}/*.ts", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: "@(src|nested)/*.ts", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: "[a-z]*.ts", path: "." }),
      preTool(fixture.cwd, "Glob", { pattern: "nested\\*.ts", path: "." }),
      preTool(fixture.cwd, "Grep", { pattern: "safe", path: "nested" }),
    ]) {
      await expect(fixture.service().evaluatePreTool(event)).resolves.toMatchObject({
        decision: "DENY",
        code: "GUARD_CLAIM_REQUIRED",
      });
    }

    await expect(fixture.service().evaluatePreTool(preTool(
      fixture.cwd,
      "Read",
      { file_path: "nested/inside.ts" },
    ))).resolves.toMatchObject({ decision: "ALLOW", summary: "Local repository read" });
  });

  it("requires a trusted local Git cwd even for an exact Claim-free status command", async () => {
    fixture.currentClaim = undefined;
    fixture.activeClaims = [];
    const outside = await mkdtemp(join(tmpdir(), "jhw-guard-untrusted-"));
    try {
      await expect(fixture.service().evaluatePreTool(preTool(outside, "Bash", { command: "git status --short" })))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_CLAIM_REQUIRED" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("denies mutation without an active Claim", async () => {
    fixture.currentClaim = undefined;
    fixture.activeClaims = [];

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_CLAIM_REQUIRED" });
    expect(fixture.permitCalls).toBe(0);
  });

  it("distinguishes an existing session on another host as a Claim mismatch", async () => {
    const otherHost = { ...activeClaim(fixture.currentContract), host: "other-build-host" };
    fixture.currentClaim = undefined;
    fixture.activeClaims = [otherHost];

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_CLAIM_MISMATCH" });
  });

  it.each([
    ["branch", "other/branch"],
    ["worktree_ref", "wt-other-ref"],
  ] as const)("denies audited worktree %s mismatch", async (field, value) => {
    fixture.inspection = { ...fixture.inspection, [field]: value };

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_WORKTREE_MISMATCH" });
    expect(fixture.permitCalls).toBe(0);
  });

  it("denies cwd outside the audited Claim worktree", async () => {
    const outside = await mkdtemp(join(tmpdir(), "jhw-guard-outside-"));
    try {
      await expect(fixture.service().evaluatePreTool(preTool(outside)))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_WORKTREE_MISMATCH" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("denies file mutation targets outside the worktree or through a target symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "jhw-guard-target-"));
    const outsideFile = join(outside, "outside.ts");
    await writeFile(outsideFile, "outside\n", "utf8");
    await symlink(outsideFile, join(fixture.cwd, "linked.ts"));
    try {
      await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Write", { file_path: outsideFile, content: "x" })))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_WORKTREE_MISMATCH" });
      await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Edit", {
        file_path: "linked.ts", old_string: "a", new_string: "b",
      }))).resolves.toMatchObject({ decision: "DENY", code: "GUARD_WORKTREE_MISMATCH" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("checks all apply_patch targets and rejects one escaping target", async () => {
    const patch = "*** Begin Patch\n*** Update File: src/file.ts\n*** Update File: ../outside.ts\n*** End Patch";

    await expect(fixture.service().evaluatePreTool(preTool(fixture.root, "apply_patch", patch)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_WORKTREE_MISMATCH" });
  });

  it("denies another active exclusive owner before resource authority or permit", async () => {
    const other = activeClaim(contract(OTHER_TASK_ID, [grant("repo.inspect", REPOSITORY, "exclusive")]));
    fixture.activeClaims = [fixture.currentClaim as ContractActiveClaim, other];
    fixture.authorityFailure = new Error("must not win precedence");

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_RESOURCE_OWNED" });
    expect(fixture.authorityCalls).toBe(0);
    expect(fixture.permitCalls).toBe(0);
  });

  it("treats current exclusive coordination as conflicting with another shared owner", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.modify", REPOSITORY, "exclusive")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    const other = activeClaim(contract(OTHER_TASK_ID, [grant("repo.inspect", REPOSITORY, "shared")]));
    fixture.activeClaims = [fixture.currentClaim, other];

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_RESOURCE_OWNED" });
  });

  it("fails closed when any active Claim has indeterminate legacy ownership", async () => {
    fixture.activeClaims = [fixture.currentClaim as ContractActiveClaim, legacyClaim()];

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE" });
    expect(fixture.authorityCalls).toBe(0);
    expect(fixture.permitCalls).toBe(0);
  });

  it("denies invalid or moved resource authority before contract comparison", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    fixture.authorityFailure = new Error("repository moved");

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE" });
    expect(fixture.permitCalls).toBe(0);
  });

  it("allows an exact capability and resource grant without reading dependencies", async () => {
    fixture.currentContract = normalizeWorkContract({
      ...fixture.currentContract,
      dependencies: [{ task_id: OTHER_TASK_ID, relation: "observes" }],
    });
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    const result = await fixture.service().evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({ decision: "ALLOW", execution_boundary: "hook" });
    expect(fixture.permitCalls).toBe(0);
  });

  it("rejects a resolved Claim that is absent from the pinned active-Claim set", async () => {
    fixture.activeClaims = [];

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
      decision: "DENY",
      code: "GUARD_CLAIM_REQUIRED",
    });
    expect(fixture.authorityCalls).toBe(0);
    expect(fixture.permitCalls).toBe(0);
  });

  it("rejects a takeover replacement that no longer matches the audited active generation", async () => {
    const replacement = {
      ...fixture.currentClaim as ContractActiveClaim,
      claim_id: OTHER_CLAIM_ID,
    };
    fixture.activeClaims = [replacement];

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
      decision: "DENY",
      code: "GUARD_WORKTREE_MISMATCH",
    });
    expect(fixture.permitCalls).toBe(0);
  });

  it.each([
    ["inactive lifecycle", { task: { lifecycle: "handoff" }, revision: undefined }],
    ["moved source generation", { task: {}, revision: "b".repeat(40) }],
  ])("rejects %s before normalization or permit policy", async (_name, mutation) => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = { ...taskWith(fixture.currentContract), ...mutation.task } as TaskRecord;
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const options = fixture.options({
      tasks: {
        ...fixture.options().tasks,
        sourceRevisionForGuard: async () => mutation.revision ?? fixture.currentClaim?.source_task_revision ?? "missing",
      },
    });

    await expect(new GuardService(options).evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
      decision: "DENY",
      code: "GUARD_UNAVAILABLE",
    });
    expect(fixture.authorityCalls).toBe(0);
    expect(fixture.permitCalls).toBe(0);
  });

  it("rejects a Registry view that moves after host inspection and never reaches the permit seam", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const withCommittedView = vi.fn(async <T>(read: () => Promise<T>) => read());
    const committedViewIsStale = vi.fn().mockResolvedValue(true);
    const options = {
      ...fixture.options(),
      registry_view: { withCommittedView, committedViewIsStale },
    } as GuardServiceOptions;

    await expect(new GuardService(options).evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
      decision: "DENY",
      code: "GUARD_UNAVAILABLE",
    });
    expect(withCommittedView).toHaveBeenCalledTimes(1);
    expect(committedViewIsStale).toHaveBeenCalled();
    expect(fixture.permitCalls).toBe(0);
  });

  it("fails closed before permit evaluation when the Registry mutation barrier is absent", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const { registry_mutation_barrier: _barrier, ...withoutBarrier } = fixture.options();

    await expect(new GuardService(withoutBarrier as GuardServiceOptions).evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(fixture.permitCalls).toBe(0);
  });

  it("fails closed before permit evaluation when the Registry mutation barrier throws", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    await expect(fixture.service({
      registry_mutation_barrier: {
        run: async () => { throw new Error("bounded barrier failure"); },
      },
    }).evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(fixture.permitCalls).toBe(0);
  });

  it.each(["before", "during"] as const)(
    "queues a cooperating Registry writer %s the permit seam until the decision is stable",
    async (timing) => {
      fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
      fixture.currentTask = taskWith(fixture.currentContract);
      fixture.currentClaim = activeClaim(fixture.currentContract);
      fixture.activeClaims = [fixture.currentClaim];
      let barrierHeld = false;
      let writerQueued = false;
      let registryMoved = false;
      const attemptRegistryWrite = (): void => {
        if (barrierHeld) writerQueued = true;
        else registryMoved = true;
      };
      const basePermit = fixture.permit as GuardPermitDecisionPort;

      const result = await fixture.service({
        registry_view: {
          withCommittedView: async <T>(read: () => Promise<T>) => read(),
          committedViewIsStale: async () => registryMoved,
        },
        registry_mutation_barrier: {
          run: async <T>(read: () => Promise<T>) => {
            barrierHeld = true;
            try {
              return await read();
            } finally {
              barrierHeld = false;
              if (writerQueued) registryMoved = true;
            }
          },
        },
        authority: {
          assertKnownRequirement: async () => {
            if (timing === "before") attemptRegistryWrite();
          },
        },
        permit_decisions: {
          decideMissingGrant: async (operation, missing) => {
            if (timing === "during") attemptRegistryWrite();
            return basePermit.decideMissingGrant(operation, missing);
          },
        },
      }).evaluatePreTool(preTool(fixture.cwd));

      expect(result).toMatchObject({ decision: "PERMIT_REQUIRED", request_id: REQUEST_ID });
      expect(registryMoved).toBe(true);
      expect(fixture.permitCalls).toBe(1);
    },
  );

  it("uses only the injected lifecycle seam for an exact missing grant", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    const result = await fixture.service().evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({
      decision: "PERMIT_REQUIRED",
      request_id: REQUEST_ID,
      approval_command: `/jhw:unlock ${REQUEST_ID}`,
    });
    expect(fixture.permitCalls).toBe(1);
    expect(fixture.barrierCalls).toBe(1);
  });

  it("accepts only an exact private permit binding and constructs public metadata itself", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    const result = await fixture.service({
      permit_decisions: {
        decideMissingGrant: async (operation, missing) => ({
          task_id: operation.task_id,
          claim_id: operation.claim_id,
          origin_adapter: operation.origin_adapter,
          session_id: operation.session_id,
          cwd_worktree_ref: operation.cwd_worktree_ref,
          requirements: operation.requirements,
          missing_requirements: missing,
          operation_digest: operation.digest,
          request_id: REQUEST_ID,
          approval_expires_at: "2026-08-25T10:10:00+09:00",
        }),
      },
    }).evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({
      decision: "PERMIT_REQUIRED",
      request_id: REQUEST_ID,
      approval_command: `/jhw:unlock ${REQUEST_ID}`,
    });
  });

  it.each([
    ["task", { task_id: OTHER_TASK_ID }],
    ["adapter", { origin_adapter: "claude" }],
    ["digest", { operation_digest: "f".repeat(64) }],
    ["extra field", { private_note: "must not pass" }],
  ])("fails closed for a permit binding with wrong %s", async (_name, mutation) => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    const result = await fixture.service({
      permit_decisions: {
        decideMissingGrant: async (operation, missing) => ({
          task_id: operation.task_id,
          claim_id: operation.claim_id,
          origin_adapter: operation.origin_adapter,
          session_id: operation.session_id,
          cwd_worktree_ref: operation.cwd_worktree_ref,
          requirements: operation.requirements,
          missing_requirements: missing,
          operation_digest: operation.digest,
          request_id: REQUEST_ID,
          approval_expires_at: "2026-08-25T10:10:00+09:00",
          ...mutation,
        }),
      },
    }).evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
  });

  it("fails closed instead of minting a request when the permit seam is absent", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    await expect(fixture.service({ permit_decisions: undefined }).evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(fixture.permitCalls).toBe(0);
  });

  it("preserves the permit lifecycle state-limit denial without exposing seam metadata", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    await expect(fixture.service({
      permit_decisions: {
        decideMissingGrant: async () => ({
          decision: "DENY",
          code: "GUARD_STATE_LIMIT",
          summary: "bounded lifecycle result",
        }),
      },
    }).evaluatePreTool(preTool(fixture.cwd))).resolves.toEqual({
      decision: "DENY",
      code: "GUARD_STATE_LIMIT",
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      summary: "Guard request state limit was reached",
    });
  });

  it("rejects invalid permit metadata rather than exposing a fake unlock", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    await expect(fixture.service({
      permit_decisions: {
        decideMissingGrant: async () => ({
          decision: "PERMIT_REQUIRED",
          operation_id: "op-018f21e0-7b2c-7a00-8000-000000000099",
          request_id: REQUEST_ID,
          summary: "safe",
          approval_command: `/jhw:unlock ${REQUEST_ID}\nextra`,
          approval_expires_at: "2026-08-25T10:10:00+09:00",
        }),
      },
    }).evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
      decision: "DENY",
      code: "GUARD_UNAVAILABLE",
    });
  });

  it("requires the owned wrapper for a direct high-risk publish even with an exact grant", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("git.publish")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Bash", { command: "git push origin HEAD" })))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_WRAPPER_REQUIRED" });
    expect(fixture.permitCalls).toBe(0);
  });

  it("keeps exclusive ownership and authority ahead of a direct Notion wrapper denial", async () => {
    const notion = { kind: "notion_database", id: "knowledgeBase" } as const;
    fixture.currentContract = contract(TASK_ID, [grant("notion.mutate", notion, "shared")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    const other = activeClaim(contract(OTHER_TASK_ID, [grant("notion.mutate", notion, "exclusive")]));
    fixture.activeClaims = [fixture.currentClaim, other];

    await expect(fixture.service().evaluatePreTool(preTool(
      fixture.cwd,
      "jhw_record",
      { db: "knowledgeBase", title: "bounded" },
    ))).resolves.toMatchObject({ decision: "DENY", code: "GUARD_RESOURCE_OWNED" });

    fixture.activeClaims = [fixture.currentClaim];
    fixture.authorityFailure = new Error("Notion authority unavailable");
    await expect(fixture.service().evaluatePreTool(preTool(
      fixture.cwd,
      "jhw_record",
      { db: "knowledgeBase", title: "bounded" },
    ))).resolves.toMatchObject({ decision: "DENY", code: "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE" });
    expect(fixture.permitCalls).toBe(0);
  });

  it("allows an exact owned publish wrapper only through its execution boundary", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("git.publish")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const command = `jhw-control guard with --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex -- git push origin HEAD`;

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Bash", { command })))
      .resolves.toMatchObject({ decision: "ALLOW", execution_boundary: "guarded_command" });
  });

  it("denies an owned wrapper whose embedded Claim coordinates differ", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("git.publish")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const command = `jhw-control guard with --task ${OTHER_TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex -- git push origin HEAD`;

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Bash", { command })))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_CLAIM_MISMATCH" });
  });

  it("reads wrapper authority coordinates only before the literal command separator", async () => {
    const command = `jhw-control guard with --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex -- custom-tool --task ${OTHER_TASK_ID}`;

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Bash", { command })))
      .resolves.toMatchObject({ decision: "PERMIT_REQUIRED", request_id: REQUEST_ID });
    expect(fixture.permitCalls).toBe(1);
  });

  it("hard-denies agent self-approval before contract or permit policy", async () => {
    await expect(fixture.service().evaluatePreTool(preTool(
      fixture.cwd,
      "Bash",
      { command: `jhw-control guard approve ${REQUEST_ID}` },
    ))).resolves.toMatchObject({ decision: "DENY", code: "GUARD_SELF_APPROVAL_DENIED" });
    expect(fixture.authorityCalls).toBe(0);
    expect(fixture.permitCalls).toBe(0);
  });

  it("keeps unresolved SSH and firmware signals wrapper-required without fabricating resources", async () => {
    const command = `jhw-control guard with --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex -- ssh target.example reboot`;

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Bash", { command })))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_WRAPPER_REQUIRED" });
    expect(fixture.authorityCalls).toBe(0);
    expect(fixture.permitCalls).toBe(0);
  });

  it("recognizes a coordinate-bearing board wrapper and preserves the board boundary", async () => {
    fixture.currentContract = contract(TASK_ID, [
      grant("board.execute", BOARD, "exclusive"),
      grant("firmware.change", BOARD, "exclusive"),
    ]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const command = `jhw-control board with --board ${BOARD.id} --mode exclusive --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex --purpose bounded -- flashrom -w firmware.bin`;

    await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, "Bash", { command })))
      .resolves.toMatchObject({ decision: "ALLOW", execution_boundary: "board" });
  });

  it("observe mode never calls the permit seam and surfaces the missing-grant policy result", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    await expect(fixture.service({ mode: "observe", inspect_guard_state: async () => true })
      .evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
      decision: "ALLOW",
      observed_decision: "PERMIT_REQUIRED",
    });
    expect(fixture.permitCalls).toBe(0);
    expect(fixture.barrierCalls).toBe(1);
  });

  it.each([
    ["state unavailable", { mode: "observe" as const, inspect_guard_state: async (): Promise<boolean> => false }],
    ["self approval", { mode: "observe" as const, inspect_guard_state: async (): Promise<boolean> => true }],
  ])("does not observe-convert hard %s denial", async (kind, overrides) => {
    const event = kind === "self approval"
      ? preTool(fixture.cwd, "Bash", { command: `jhw-control guard consume ${REQUEST_ID}` })
      : preTool(fixture.cwd);

    const result = await fixture.service(overrides).evaluatePreTool(event);

    expect(result).toMatchObject({
      decision: "DENY",
      code: kind === "self approval" ? "GUARD_SELF_APPROVAL_DENIED" : "GUARD_UNAVAILABLE",
    });
  });

  it("hard-denies quote-composed self approval before Claim lookup in enforce and observe modes", async () => {
    fixture.currentClaim = undefined;
    fixture.activeClaims = [];
    const event = preTool(fixture.cwd, "Bash", {
      command: `jhw-control g'u'ard approve ${REQUEST_ID}`,
    });

    for (const service of [
      fixture.service(),
      fixture.service({ mode: "observe", inspect_guard_state: async () => true }),
    ]) {
      await expect(service.evaluatePreTool(event)).resolves.toMatchObject({
        decision: "DENY",
        code: "GUARD_SELF_APPROVAL_DENIED",
      });
    }
    expect(fixture.claimLookups).toBe(0);
    expect(fixture.permitCalls).toBe(0);
  });

  it("safe-parses prompt and post-tool events without changing authority before state integration", async () => {
    const service = fixture.service();

    await expect(service.submitUserPrompt({
      protocol_version: 1,
      adapter: "codex",
      event: "user_prompt_submit",
      session_id: SESSION_ID,
      prompt: `/jhw:unlock ${REQUEST_ID}`,
    })).resolves.toEqual({
      status: "NO_STATE_CHANGE",
      event: "user_prompt_submit",
      summary: "Prompt permit state is not integrated",
    });
    await expect(service.completePostTool({
      protocol_version: 1,
      adapter: "codex",
      event: "post_tool_use",
      session_id: SESSION_ID,
      tool_use_id: "call-guard-1",
      ok: true,
    })).resolves.toEqual({
      status: "NO_STATE_CHANGE",
      event: "post_tool_use",
      summary: "Tool completion state is not integrated",
    });
    expect(fixture.permitCalls).toBe(0);
  });

  it("returns bounded protocol denial for malformed side events", async () => {
    const service = fixture.service();
    const expected = {
      status: "DENY",
      code: "GUARD_PROTOCOL_MISMATCH",
      summary: "Guard protocol input is invalid",
    };

    expect(await service.submitUserPrompt({ event: "user_prompt_submit", prompt: "secret" })).toEqual(expected);
    expect(await service.completePostTool({ event: "post_tool_use", output: "secret" })).toEqual(expected);
    expect(GuardSideEventResultSchema.parse(expected)).toEqual(expected);
  });
});

describe("Guard decision schema", () => {
  it("accepts only the approved bounded decision vocabulary", () => {
    expect(GuardDecisionSchema.safeParse({
      decision: "DENY",
      code: "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE",
      summary: "Resource authority is unavailable",
    }).success).toBe(true);
    expect(GuardDecisionSchema.safeParse({
      decision: "DENY",
      code: "GUARD_INVENTED",
      summary: "unsafe",
    }).success).toBe(false);
    expect(GuardDecisionSchema.safeParse({
      decision: "ALLOW",
      operation_id: "op-018f21e0-7b2c-7a00-8000-000000000006",
      summary: "safe",
      execution_boundary: "hook",
      raw_command: "must never appear",
    }).success).toBe(false);
  });

  it("rejects malformed, multiline, or mismatched approval commands", () => {
    const decision = {
      decision: "PERMIT_REQUIRED",
      operation_id: "op-018f21e0-7b2c-7a00-8000-000000000006",
      request_id: REQUEST_ID,
      summary: "repo.modify repository:repo-guard",
      approval_expires_at: "2026-08-25T10:10:00+09:00",
    };

    expect(GuardDecisionSchema.safeParse({
      ...decision,
      approval_command: `/jhw:unlock ${REQUEST_ID}`,
    }).success).toBe(true);
    expect(GuardDecisionSchema.safeParse({
      ...decision,
      approval_command: `/jhw:unlock ${REQUEST_ID}\n`,
    }).success).toBe(false);
    expect(GuardDecisionSchema.safeParse({
      ...decision,
      approval_command: "/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000099",
    }).success).toBe(false);
  });

  it("never admits private classifier or path fields into any decision variant", () => {
    const denied = GuardDecisionSchema.safeParse({
      decision: "DENY",
      code: "GUARD_WORKTREE_MISMATCH",
      summary: "Worktree identity does not match",
      cwd: "/private/worktree",
      command: "git push secret",
      unresolved_signals: [{ capability: "remote.execute", boundary: "guarded_command" }],
    });

    expect(denied.success).toBe(false);
  });
});
