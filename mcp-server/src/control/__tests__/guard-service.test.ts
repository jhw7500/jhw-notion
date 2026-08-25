import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGuardRegistryMutationBarrier,
  GuardDecisionSchema,
  GuardService,
  GuardSideEventResultSchema,
  type GuardPermitDecisionPort,
  type GuardRegistryMutationBarrierPort,
  type GuardServiceOptions,
} from "../guard-service.js";
import type { ControlConfig } from "../config.js";
import type { OperationRequirement } from "../guard-protocol.js";
import { GuardRequestStore, type GuardRequest } from "../guard-state.js";
import { GuardJournal, type GuardJournalEvent, type GuardJournalPort } from "../guard-journal.js";
import type { SecureStateDirectoryHooks } from "../journal.js";
import { MutationLock, type MutationLockRuntime } from "../process.js";
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

function lockConfig(stateDir: string): ControlConfig {
  return {
    registryDir: "/srv/registry",
    registryRemote: "origin",
    registryBranch: "main",
    worktreeRoot: "/srv/worktrees",
    buildHost: HOST,
    githubOwner: "owner",
    projectNumber: 1,
    registryRepository: "owner/registry",
    preflightProjectItemId: "PVTI_guard",
    preflightRegistryIssueNumber: 1,
    stateDir,
    guardMode: "enforce",
  };
}

function completedLockAcquisition(status = 0): ReturnType<MutationLockRuntime["spawn"]> {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  queueMicrotask(() => child.emit("close", status));
  return child;
}

function trustedBarrier(
  stateDir: string,
  options: {
    acquisitionStatus?: number;
    onAcquire?: () => void;
    secureDirectoryHooks?: SecureStateDirectoryHooks;
  } = {},
): GuardRegistryMutationBarrierPort {
  const runtime: MutationLockRuntime = {
    spawn: () => {
      options.onAcquire?.();
      return completedLockAcquisition(options.acquisitionStatus);
    },
  };
  return createGuardRegistryMutationBarrier(new MutationLock(
    lockConfig(stateDir),
    {},
    runtime,
    options.secureDirectoryHooks,
  ));
}

function untrustedBarrier(run: unknown): GuardRegistryMutationBarrierPort {
  return { run } as unknown as GuardRegistryMutationBarrierPort;
}

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
  tool_use_id = "call-guard-1",
): unknown {
  return {
    protocol_version: 1,
    adapter: "codex",
    event: "pre_tool_use",
    session_id: SESSION_ID,
    cwd,
    tool_name,
    tool_input,
    tool_use_id,
  };
}

function promptEvent(prompt: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    protocol_version: 1,
    adapter: "codex",
    event: "user_prompt_submit",
    session_id: SESSION_ID,
    prompt,
    ...overrides,
  };
}

function postToolEvent(
  toolUseId: string,
  ok: boolean,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    protocol_version: 1,
    adapter: "codex",
    event: "post_tool_use",
    session_id: SESSION_ID,
    tool_use_id: toolUseId,
    ok,
    ...overrides,
  };
}

class MemoryGuardJournal implements GuardJournalPort {
  readonly events: GuardJournalEvent[] = [];

  async append(event: GuardJournalEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
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
  requestStore: GuardRequestStore;
  guardJournal: MemoryGuardJournal;
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
    const registryMutationBarrier = trustedBarrier(join(root, "registry-state"), {
      onAcquire: () => {
        fixture.barrierCalls += 1;
      },
    });
    const guardJournal = new MemoryGuardJournal();
    const requestStore = new GuardRequestStore(lockConfig(join(root, "guard-state")), {
      journal: guardJournal,
      lockRuntime: { spawn: () => completedLockAcquisition() },
      environment: {},
    });

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
      requestStore,
      guardJournal,
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
            request_state: "PENDING",
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
              if (taskId === fixture.currentTask.id) return fixture.currentTask;
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
          registry_mutation_barrier: registryMutationBarrier,
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

  it("journals protocol and Claim-free decisions with only legitimately known coordinates", async () => {
    const stateDir = join(fixture.root, "early-decision-journal");
    const service = fixture.service({
      guard_journal: new GuardJournal(stateDir),
    } as unknown as Partial<GuardServiceOptions>);
    await service.evaluatePreTool({
      ...preTool(fixture.cwd) as object,
      protocol_version: 2,
      raw_command: "must not be journaled",
    });
    fixture.currentClaim = undefined;
    fixture.activeClaims = [];
    await service.evaluatePreTool(preTool(fixture.cwd, "Read", { file_path: "src/file.ts" }));

    const rows = (await readFile(join(stateDir, "guard-journal.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as GuardJournalEvent);
    expect(rows).toEqual([
      {
        protocol_version: 1,
        evaluation_stage: "hook",
        event: "decision",
        occurred_at: expect.any(String),
        decision_code: "GUARD_PROTOCOL_MISMATCH",
      },
      {
        protocol_version: 1,
        origin_adapter: "codex",
        evaluation_stage: "hook",
        event: "decision",
        session_id: SESSION_ID,
        occurred_at: expect.any(String),
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("must not be journaled");
    expect(JSON.stringify(rows)).not.toContain("src/file.ts");
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

  it.each(["Bash", "exec_command"] as const)(
    "allows only the CLI-supported Guard diagnostics without a Claim through %s",
    async (toolName) => {
      fixture.currentClaim = undefined;
      fixture.activeClaims = [];

      for (const command of [
        "jhw-control guard status",
        `jhw-control guard status --session ${SESSION_ID}`,
        "jhw-control guard preflight",
      ]) {
        await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, toolName, { command })))
          .resolves.toMatchObject({
            decision: "ALLOW",
            execution_boundary: "hook",
            summary: "Local repository status",
          });
      }

      expect(fixture.claimLookups).toBe(0);
      expect(fixture.permitCalls).toBe(0);
    },
  );

  it.each(["Bash", "exec_command"] as const)(
    "keeps hostile scoped Guard status shapes Claim-bound through %s",
    async (toolName) => {
      fixture.currentClaim = undefined;
      fixture.activeClaims = [];
      const hostileCommands = [
        ["missing session", "jhw-control guard status --session"],
        ["flag-shaped missing session", "jhw-control guard status --session --json"],
        ["duplicate session", `jhw-control guard status --session ${SESSION_ID} --session ${SESSION_ID}`],
        ["extra suffix", `jhw-control guard status --session ${SESSION_ID} extra`],
        ["extra flag", `jhw-control guard status --session ${SESSION_ID} --json`],
        ["joined flag", `jhw-control guard status --session=${SESSION_ID}`],
        ["semicolon composition", `jhw-control guard status --session ${SESSION_ID}; git status`],
        ["and composition", `jhw-control guard status --session ${SESSION_ID} && git status`],
        ["pipeline composition", `jhw-control guard status --session ${SESSION_ID} | git status`],
        ["newline composition", `jhw-control guard status --session ${SESSION_ID}\ngit status`],
        ["redirection", `jhw-control guard status --session ${SESSION_ID} > /tmp/guard-status`],
        ["command substitution", "jhw-control guard status --session $(printf codex-guard-task)"],
        ["backtick substitution", "jhw-control guard status --session `printf codex-guard-task`"],
        ["env wrapper", `env jhw-control guard status --session ${SESSION_ID}`],
        ["assignment prefix", `JHW_TEST=1 jhw-control guard status --session ${SESSION_ID}`],
        ["command wrapper", `command jhw-control guard status --session ${SESSION_ID}`],
        ["shell wrapper", `bash -c 'jhw-control guard status --session ${SESSION_ID}'`],
        ["unterminated quote", `jhw-control guard status --session "${SESSION_ID}`],
        ["unterminated escape", `jhw-control guard status --session ${SESSION_ID}\\`],
        ["empty coordinate", 'jhw-control guard status --session ""'],
        ["control coordinate", "jhw-control guard status --session codex\u0007guard"],
        ["oversize coordinate", `jhw-control guard status --session ${"x".repeat(256)}`],
        ["oversize UTF-8 coordinate", `jhw-control guard status --session ${"é".repeat(128)}`],
      ] as const;

      for (const [label, command] of hostileCommands) {
        const result = await fixture.service().evaluatePreTool(preTool(fixture.cwd, toolName, { command }));
        expect(result, `${toolName}: ${label}`).toMatchObject({
          decision: "DENY",
          code: "GUARD_CLAIM_REQUIRED",
        });
      }

      await expect(fixture.service().evaluatePreTool(preTool(fixture.cwd, toolName, {
        command: `jhw-control guard status --session ${SESSION_ID}`,
        timeout_ms: 1_000,
      }))).resolves.toMatchObject({ decision: "DENY", code: "GUARD_CLAIM_REQUIRED" });
      expect(fixture.permitCalls).toBe(0);
    },
  );

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

  it("accepts an unmodified directly constructed MutationLock as Guard barrier authority", () => {
    const direct = new MutationLock(
      lockConfig(join(fixture.root, "direct-registry-state")),
      {},
      { spawn: () => completedLockAcquisition() },
    );

    expect(() => createGuardRegistryMutationBarrier(direct)).not.toThrow();
  });

  it("rejects a provenance-less object with the concrete MutationLock surface", () => {
    const provenanceLess = Object.create(MutationLock.prototype) as MutationLock;

    expect(Object.getPrototypeOf(provenanceLess)).toBe(MutationLock.prototype);
    expect(provenanceLess.run).toBe(MutationLock.prototype.run);
    expect(() => createGuardRegistryMutationBarrier(provenanceLess)).toThrow("concrete MutationLock");
  });

  it("rejects a subclass even after its instance is made prototype-compatible", () => {
    class DerivedMutationLock extends MutationLock {
      constructor() {
        super(
          lockConfig(join(fixture.root, "derived-registry-state")),
          {},
          { spawn: () => completedLockAcquisition() },
        );
      }
    }

    const derived = new DerivedMutationLock();
    Object.setPrototypeOf(derived, MutationLock.prototype);

    expect(Object.getPrototypeOf(derived)).toBe(MutationLock.prototype);
    expect(derived.run).toBe(MutationLock.prototype.run);
    expect(() => createGuardRegistryMutationBarrier(derived)).toThrow("concrete MutationLock");
  });

  it("rejects structural and instance-overridden MutationLock candidates", () => {
    const structuralFake = { run: vi.fn(async <T>(callback: () => Promise<T>) => callback()) };
    const overridden = new MutationLock(
      lockConfig(join(fixture.root, "overridden-registry-state")),
      {},
      { spawn: () => completedLockAcquisition() },
    );
    Object.defineProperty(overridden, "run", {
      value: async <T>(callback: () => Promise<T>) => callback(),
    });

    expect(() => createGuardRegistryMutationBarrier(structuralFake as unknown as MutationLock))
      .toThrow("concrete MutationLock");
    expect(() => createGuardRegistryMutationBarrier(overridden)).toThrow("concrete MutationLock");
    expect(structuralFake.run).not.toHaveBeenCalled();
  });

  it("awaits an accepted concrete MutationLock callback before publishing its decision", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const basePermit = fixture.permit as GuardPermitDecisionPort;
    let entered!: () => void;
    const permitEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const permitGate = new Promise<void>((resolve) => { release = resolve; });

    const evaluation = fixture.service({
      permit_decisions: {
        decideMissingGrant: async (operation, missing) => {
          entered();
          await permitGate;
          return basePermit.decideMissingGrant(operation, missing);
        },
      },
    }).evaluatePreTool(preTool(fixture.cwd));

    await permitEntered;
    const stateBeforeRelease = await Promise.race([
      evaluation.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    expect(stateBeforeRelease).toBe("pending");

    release();
    await expect(evaluation).resolves.toMatchObject({
      decision: "PERMIT_REQUIRED",
      request_id: REQUEST_ID,
    });
    expect(fixture.permitCalls).toBe(1);
  });

  it("fails closed before permit evaluation when concrete MutationLock acquisition fails", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    await expect(fixture.service({
      registry_mutation_barrier: trustedBarrier(join(fixture.root, "failed-registry-state"), {
        acquisitionStatus: 75,
      }),
    }).evaluatePreTool(preTool(fixture.cwd)))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(fixture.permitCalls).toBe(0);
  });

  it.each(["lock file", "state directory"] as const)(
    "preserves an exact committed permit decision when %s cleanup rejects after callback completion",
    async (cleanupTarget) => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];

    const result = await fixture.service({
      registry_mutation_barrier: trustedBarrier(join(fixture.root, "release-failure-state"), {
        secureDirectoryHooks: {
          afterDirectoryOpen: (directory) => {
            if (cleanupTarget === "lock file") {
              const openFile = directory.openFile.bind(directory);
              directory.openFile = async (name, flags, mode) => {
                const file = await openFile(name, flags, mode);
                const close = file.close.bind(file);
                file.close = async () => {
                  await close();
                  throw new Error("bounded post-callback lock-file release failure");
                };
                return file;
              };
            } else {
              const close = directory.close.bind(directory);
              directory.close = async () => {
                await close();
                throw new Error("bounded post-callback directory release failure");
              };
            }
          },
        },
      }),
    }).evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({
      decision: "PERMIT_REQUIRED",
      request_id: REQUEST_ID,
      approval_command: `/jhw:unlock ${REQUEST_ID}`,
    });
    expect(fixture.permitCalls).toBe(1);
    },
  );

  it("does not trust a barrier result when its callback was never entered", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const fabricated = GuardDecisionSchema.parse({
      decision: "ALLOW",
      operation_id: "op-018f21e0-7b2c-7a00-8000-000000000099",
      summary: "fabricated barrier result",
      execution_boundary: "hook",
    });
    const run = vi.fn(async <T>() => fabricated as T);

    const result = await fixture.service({
      registry_mutation_barrier: untrustedBarrier(run),
    }).evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
    expect(fixture.permitCalls).toBe(0);
  });

  it("rejects an untrusted barrier that would substitute a fabricated callback return", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const fabricated = GuardDecisionSchema.parse({
      decision: "ALLOW",
      operation_id: "op-018f21e0-7b2c-7a00-8000-000000000099",
      summary: "fabricated barrier result",
      execution_boundary: "hook",
    });
    const run = vi.fn(async <T>(read: () => Promise<T>) => {
      await read();
      return fabricated as T;
    });

    const result = await fixture.service({
      registry_mutation_barrier: untrustedBarrier(run),
    }).evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
    expect(fixture.permitCalls).toBe(0);
  });

  it("does not let a barrier that returns before callback completion create request state later", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let background: Promise<unknown> | undefined;
    const claims = fixture.options().claims;
    const run = vi.fn(async <T>(read: () => Promise<T>) => {
      background = read();
      return undefined as T;
    });

    const result = await fixture.service({
      claims: {
        ...claims,
        listActiveClaims: async () => {
          await gate;
          return fixture.activeClaims;
        },
      },
      registry_mutation_barrier: untrustedBarrier(run),
    }).evaluatePreTool(preTool(fixture.cwd));
    release();
    await background;

    expect(result).toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
    expect(fixture.permitCalls).toBe(0);
  });

  it("rejects an untrusted early-returning barrier before the permit-adjacent freshness boundary", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    let staleCalls = 0;
    let permitAdjacentReadStarted!: () => void;
    const permitAdjacentStarted = new Promise<void>((resolve) => {
      permitAdjacentReadStarted = resolve;
    });
    let resolvePermitAdjacent!: (stale: boolean) => void;
    const permitAdjacentRead = new Promise<boolean>((resolve) => {
      resolvePermitAdjacent = resolve;
    });
    let background: Promise<unknown> | undefined;
    const run = vi.fn(async <T>(read: () => Promise<T>) => {
      background = read();
      await permitAdjacentStarted;
      resolvePermitAdjacent(false);
      return undefined as T;
    });

    const result = await fixture.service({
      registry_view: {
        withCommittedView: async <T>(read: () => Promise<T>) => read(),
        committedViewIsStale: () => {
          staleCalls += 1;
          if (staleCalls === 2) {
            permitAdjacentReadStarted();
            return permitAdjacentRead;
          }
          return Promise.resolve(false);
        },
      },
      registry_mutation_barrier: untrustedBarrier(run),
    }).evaluatePreTool(preTool(fixture.cwd));
    await background;

    expect(result).toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(staleCalls).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(fixture.permitCalls).toBe(0);
  });

  it("rejects an untrusted barrier that would enter the callback more than once", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const run = vi.fn(async <T>(read: () => Promise<T>) => {
      const first = await read();
      await read();
      return first;
    });

    const result = await fixture.service({
      registry_mutation_barrier: untrustedBarrier(run),
    }).evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
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
      const registryMutationBarrier = trustedBarrier(join(fixture.root, `writer-${timing}-state`), {
        onAcquire: () => {
          barrierHeld = true;
        },
        secureDirectoryHooks: {
          afterDirectoryOpen: (directory) => {
            const close = directory.close.bind(directory);
            directory.close = async () => {
              try {
                await close();
              } finally {
                barrierHeld = false;
                if (writerQueued) registryMoved = true;
              }
            };
          },
        },
      });

      const result = await fixture.service({
        registry_view: {
          withCommittedView: async <T>(read: () => Promise<T>) => read(),
          committedViewIsStale: async () => registryMoved,
        },
        registry_mutation_barrier: registryMutationBarrier,
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

  it("keeps the concrete MutationLock held for the last Registry freshness read before the permit seam", async () => {
    fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
    fixture.currentTask = taskWith(fixture.currentContract);
    fixture.currentClaim = activeClaim(fixture.currentContract);
    fixture.activeClaims = [fixture.currentClaim];
    const order: string[] = [];
    let barrierHeld = false;
    const basePermit = fixture.permit as GuardPermitDecisionPort;
    const registryMutationBarrier = trustedBarrier(join(fixture.root, "freshness-order-state"), {
      onAcquire: () => {
        barrierHeld = true;
      },
      secureDirectoryHooks: {
        afterDirectoryOpen: (directory) => {
          const close = directory.close.bind(directory);
          directory.close = async () => {
            try {
              await close();
            } finally {
              barrierHeld = false;
            }
          };
        },
      },
    });

    const result = await fixture.service({
      registry_view: {
        withCommittedView: async <T>(read: () => Promise<T>) => read(),
        committedViewIsStale: async () => {
          order.push(barrierHeld ? "freshness-held" : "freshness-unheld");
          return false;
        },
      },
      registry_mutation_barrier: registryMutationBarrier,
      permit_decisions: {
        decideMissingGrant: async (operation, missing) => {
          order.push(barrierHeld ? "permit-held" : "permit-unheld");
          return basePermit.decideMissingGrant(operation, missing);
        },
      },
    }).evaluatePreTool(preTool(fixture.cwd));

    expect(result).toMatchObject({ decision: "PERMIT_REQUIRED", request_id: REQUEST_ID });
    expect(order.slice(-2)).toEqual(["freshness-held", "permit-held"]);
    expect(barrierHeld).toBe(false);
    expect(fixture.permitCalls).toBe(1);
  });

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
          request_state: "PENDING",
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
          request_state: "PENDING",
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

  it.each(["hook", "publish", "board"] as const)(
    "never treats a legacy seam's fabricated APPROVED %s binding as persisted authority",
    async (kind) => {
      fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
      fixture.currentTask = taskWith(fixture.currentContract);
      fixture.currentClaim = activeClaim(fixture.currentContract);
      fixture.activeClaims = [fixture.currentClaim];
      const command = kind === "publish"
        ? `jhw-control guard with --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex -- git push origin HEAD`
        : `jhw-control board with --board ${BOARD.id} --mode exclusive --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex --purpose bounded -- flashrom -w firmware.bin`;
      const event = kind === "hook"
        ? preTool(fixture.cwd)
        : preTool(fixture.cwd, "Bash", { command });
      let seamCalls = 0;
      const service = fixture.service({
        permit_decisions: {
          decideMissingGrant: async (operation, missing) => {
            seamCalls += 1;
            return {
              task_id: operation.task_id,
              claim_id: operation.claim_id,
              origin_adapter: operation.origin_adapter,
              session_id: operation.session_id,
              cwd_worktree_ref: operation.cwd_worktree_ref,
              requirements: operation.requirements,
              missing_requirements: missing,
              operation_digest: operation.digest,
              request_state: "APPROVED",
              request_id: REQUEST_ID,
              approval_expires_at: "2026-08-25T10:10:00+09:00",
            };
          },
        },
      });

      await expect(service.evaluatePreTool(event)).resolves.toMatchObject({
        decision: "DENY",
        code: "GUARD_UNAVAILABLE",
      });
      expect(seamCalls).toBe(1);
    },
  );

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

  describe("integrated one-time permit lifecycle", () => {
    function missingRepositoryModify(): void {
      fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
      fixture.currentTask = taskWith(fixture.currentContract);
      fixture.currentClaim = activeClaim(fixture.currentContract);
      fixture.activeClaims = [fixture.currentClaim];
    }

    function integratedService(overrides: Partial<GuardServiceOptions> = {}): GuardService {
      return fixture.service({
        permit_decisions: undefined,
        guard_request_store: fixture.requestStore,
        ...overrides,
      });
    }

    async function storedRequests(): Promise<GuardRequest[]> {
      const inspected = await fixture.requestStore.inspect();
      return inspected.status === "ready" ? inspected.requests : [];
    }

    async function requestAndApprove(
      event: unknown = preTool(fixture.cwd),
    ): Promise<{ requestId: string; service: GuardService }> {
      const service = integratedService();
      const decision = await service.evaluatePreTool(event);
      if (decision.decision !== "PERMIT_REQUIRED") throw new Error("expected a permit request");
      await expect(service.submitUserPrompt(promptEvent(decision.approval_command))).resolves.toMatchObject({
        status: "APPROVED",
        request_id: decision.request_id,
        context: {
          task_id: TASK_ID,
          claim_id: CLAIM_ID,
          task_alias: "guard-task",
          work_contract_digest: workContractDigest(fixture.currentContract),
        },
        start_by: expect.any(String),
        execution_consumes_permit: true,
      });
      return { requestId: decision.request_id, service };
    }

    it("creates one exact PENDING request and reuses it without consuming quota", async () => {
      missingRepositoryModify();
      const service = integratedService();

      const first = await service.evaluatePreTool(preTool(fixture.cwd));
      const second = await service.evaluatePreTool(preTool(fixture.cwd, "Edit", {
        file_path: "src/file.ts", old_string: "a", new_string: "b",
      }, "call-guard-retry"));

      expect(first).toMatchObject({
        decision: "PERMIT_REQUIRED",
        approval_command: expect.stringMatching(/^\/jhw:unlock req-/u),
      });
      expect(second).toMatchObject({
        decision: "PERMIT_REQUIRED",
        request_id: first.decision === "PERMIT_REQUIRED" ? first.request_id : "unexpected",
        approval_command: first.decision === "PERMIT_REQUIRED" ? first.approval_command : "unexpected",
      });
      expect(await storedRequests()).toEqual([
        expect.objectContaining({ state: "PENDING", task_id: TASK_ID, claim_id: CLAIM_ID }),
      ]);
    });

    it("keeps published lifecycle state authoritative while surfacing bounded journal warnings", async () => {
      missingRepositoryModify();
      const warningStore = new GuardRequestStore(lockConfig(join(fixture.root, "warning-state")), {
        journal: { append: async () => { throw new Error("journal unavailable"); } },
        lockRuntime: { spawn: () => completedLockAcquisition() },
        environment: {},
      });
      const service = integratedService({
        guard_request_store: warningStore,
        guard_journal: new GuardJournal(join(fixture.root, "warning-state"), {
          afterJournalSync: () => { throw new Error("decision journal unavailable"); },
        }),
      });

      const decision = await service.evaluatePreTool(preTool(fixture.cwd));
      expect(decision).toMatchObject({
        decision: "PERMIT_REQUIRED",
        journal_warning: "GUARD_JOURNAL_UNAVAILABLE",
      });
      if (decision.decision !== "PERMIT_REQUIRED") throw new Error("expected a permit request");
      await expect(service.submitUserPrompt(promptEvent(decision.approval_command))).resolves.toMatchObject({
        status: "APPROVED",
        journal_warning: "GUARD_JOURNAL_UNAVAILABLE",
      });
      await expect(service.evaluatePreTool(preTool(
        fixture.cwd,
        "Edit",
        { file_path: "src/file.ts", old_string: "a", new_string: "b" },
        "call-warning-consume",
      ))).resolves.toMatchObject({
        decision: "ALLOW",
        consumed_request_id: decision.request_id,
        journal_warning: "GUARD_JOURNAL_UNAVAILABLE",
      });
      await expect(warningStore.inspect()).resolves.toMatchObject({
        status: "ready",
        requests: [expect.objectContaining({ state: "CONSUMED" })],
      });
    });

    it("keeps a persisted request authoritative when decision journaling fails", async () => {
      missingRepositoryModify();
      const journal = new GuardJournal(join(fixture.root, "guard-state"), {
        afterJournalSync: () => { throw new Error("decision journal unavailable"); },
      });
      const service = integratedService({
        guard_journal: journal,
      } as unknown as Partial<GuardServiceOptions>);

      await expect(service.evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
        decision: "PERMIT_REQUIRED",
        journal_warning: "GUARD_JOURNAL_UNAVAILABLE",
      });
      expect(await storedRequests()).toEqual([
        expect.objectContaining({ state: "PENDING", task_id: TASK_ID, claim_id: CLAIM_ID }),
      ]);
    });

    it("journals bounded authoritative decisions without raw operation material", async () => {
      missingRepositoryModify();
      const journalPath = join(fixture.root, "guard-state", "guard-journal.jsonl");
      const service = integratedService({
        guard_journal: new GuardJournal(join(fixture.root, "guard-state")),
      } as unknown as Partial<GuardServiceOptions>);

      const required = await service.evaluatePreTool(preTool(fixture.cwd));
      if (required.decision !== "PERMIT_REQUIRED") throw new Error("expected permit request");
      await service.submitUserPrompt(promptEvent(required.approval_command));
      await service.evaluatePreTool(preTool(
        fixture.cwd,
        "Edit",
        { file_path: "src/file.ts", old_string: "a", new_string: "b" },
        "call-journal-consume",
      ));

      const rows = (await readFile(journalPath, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as GuardJournalEvent);
      const decisions = rows.filter((row) => row.event === "decision");
      expect(decisions).toEqual([
        expect.objectContaining({
          event: "decision",
          origin_adapter: "codex",
          evaluation_stage: "hook",
          task_id: TASK_ID,
          claim_id: CLAIM_ID,
          session_id: SESSION_ID,
          request_id: required.request_id,
          operation_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          requirements: [{
            capability: "repo.modify",
            resource: { kind: "repository", id: REPOSITORY.id },
          }],
        }),
        expect.objectContaining({
          event: "decision",
          task_id: TASK_ID,
          claim_id: CLAIM_ID,
          request_id: required.request_id,
          operation_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      ]);
      const serialized = JSON.stringify(rows);
      for (const forbidden of [
        "/jhw:unlock",
        "src/file.ts",
        fixture.cwd,
        "old_string",
        "new_string",
      ]) expect(serialized).not.toContain(forbidden);
    });

    it("does not trust an overridden decision journal authority", async () => {
      missingRepositoryModify();
      const journal = new GuardJournal(join(fixture.root, "guard-state"));
      const forged = vi.fn(async () => undefined);
      Object.defineProperty(journal, "append", { value: forged });
      const service = integratedService({
        guard_journal: journal,
      } as unknown as Partial<GuardServiceOptions>);

      await expect(service.evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
        decision: "PERMIT_REQUIRED",
        journal_warning: "GUARD_JOURNAL_UNAVAILABLE",
      });
      expect(forged).not.toHaveBeenCalled();
    });

    it.each([
      "ok",
      "진행",
      "다음",
      "승인",
      "`__UNLOCK__`",
      "```\n__UNLOCK__\n```",
      " __UNLOCK__",
      "__UNLOCK__ ",
      "__UNLOCK__\n",
      "__UNLOCK__\r\n",
      "__UNLOCK__\nsecond line",
    ])("does not approve ordinary or decorated prompt %j", async (template) => {
      missingRepositoryModify();
      const service = integratedService();
      const decision = await service.evaluatePreTool(preTool(fixture.cwd));
      if (decision.decision !== "PERMIT_REQUIRED") throw new Error("expected a permit request");
      const prompt = template.replace("__UNLOCK__", decision.approval_command);

      await expect(service.submitUserPrompt(promptEvent(prompt))).resolves.toMatchObject({
        status: "NO_STATE_CHANGE",
        event: "user_prompt_submit",
        context: {
          task_id: TASK_ID,
          claim_id: CLAIM_ID,
          task_alias: "guard-task",
          work_contract_digest: workContractDigest(fixture.currentContract),
        },
      });
      expect(await storedRequests()).toEqual([
        expect.objectContaining({ request_id: decision.request_id, state: "PENDING" }),
      ]);
    });

    it("does not let a tool-shaped event or wrong adapter/session approve the request", async () => {
      missingRepositoryModify();
      const service = integratedService();
      const decision = await service.evaluatePreTool(preTool(fixture.cwd));
      if (decision.decision !== "PERMIT_REQUIRED") throw new Error("expected a permit request");

      await expect(service.submitUserPrompt(preTool(
        fixture.cwd,
        "Bash",
        { command: decision.approval_command },
      ))).resolves.toMatchObject({ status: "DENY", code: "GUARD_PROTOCOL_MISMATCH" });
      await expect(service.submitUserPrompt(promptEvent(decision.approval_command, { adapter: "claude" })))
        .resolves.toMatchObject({ status: "DENY", code: "GUARD_PERMIT_MISMATCH" });
      await expect(service.submitUserPrompt(promptEvent(decision.approval_command, { session_id: "other-session" })))
        .resolves.toMatchObject({ status: "DENY", code: "GUARD_PERMIT_MISMATCH" });
      expect(await storedRequests()).toEqual([
        expect.objectContaining({ request_id: decision.request_id, state: "PENDING" }),
      ]);
    });

    it("approves only the exact native prompt and atomically consumes the exact hook retry", async () => {
      missingRepositoryModify();
      const { requestId, service } = await requestAndApprove();

      const retry = await service.evaluatePreTool(preTool(
        fixture.cwd,
        "Edit",
        { file_path: "src/file.ts", old_string: "a", new_string: "b" },
        "call-approved-retry",
      ));

      expect(retry).toMatchObject({
        decision: "ALLOW",
        execution_boundary: "hook",
        consumed_request_id: requestId,
      });
      expect(await storedRequests()).toEqual([
        expect.objectContaining({
          request_id: requestId,
          state: "CONSUMED",
          correlation_id: "call-approved-retry",
        }),
      ]);
      await expect(service.evaluatePreTool(preTool(
        fixture.cwd,
        "Edit",
        { file_path: "src/file.ts", old_string: "a", new_string: "b" },
        "call-consumed-replay",
      ))).resolves.toMatchObject({ decision: "DENY", code: "GUARD_PERMIT_CONSUMED" });
    });

    it("cannot execute a persisted APPROVED request after current authority becomes stale", async () => {
      missingRepositoryModify();
      const { requestId, service } = await requestAndApprove();
      fixture.authorityFailure = new Error("repository authority moved");

      await expect(service.evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
        decision: "DENY",
        code: "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE",
      });
      expect(await storedRequests()).toEqual([
        expect.objectContaining({ request_id: requestId, state: "APPROVED" }),
      ]);
    });

    it.each([true, false])("closes only the exact consumed hook correlation when ok=%s", async (ok) => {
      missingRepositoryModify();
      const { requestId, service } = await requestAndApprove();
      await service.evaluatePreTool(preTool(
        fixture.cwd,
        "Edit",
        { file_path: "src/file.ts", old_string: "a", new_string: "b" },
        "call-post-tool",
      ));

      for (const event of [
        postToolEvent("call-unmatched", ok),
        postToolEvent("call-post-tool", ok, { adapter: "claude" }),
        postToolEvent("call-post-tool", ok, { session_id: "other-session" }),
      ]) {
        await expect(service.completePostTool(event)).resolves.toMatchObject({ status: "DENY" });
      }
      expect(await storedRequests()).toEqual([
        expect.objectContaining({ request_id: requestId, state: "CONSUMED" }),
      ]);

      await expect(service.completePostTool(postToolEvent("call-post-tool", ok))).resolves.toMatchObject({
        status: ok ? "COMPLETED" : "FAILED",
        request_id: requestId,
        task_id: TASK_ID,
        claim_id: CLAIM_ID,
      });
      await expect(service.completePostTool(postToolEvent("call-post-tool", ok)))
        .resolves.toMatchObject({ status: "DENY", code: "GUARD_PERMIT_CONSUMED" });
      expect(await storedRequests()).toEqual([
        expect.objectContaining({ request_id: requestId, state: ok ? "COMPLETED" : "FAILED" }),
      ]);
    });

    it("completes hook-started work after legitimate current Claim and authority changes", async () => {
      missingRepositoryModify();
      const { requestId, service } = await requestAndApprove();
      await service.evaluatePreTool(preTool(
        fixture.cwd,
        "Edit",
        { file_path: "src/file.ts", old_string: "a", new_string: "b" },
        "call-post-start-change",
      ));
      fixture.currentClaim = undefined;
      fixture.activeClaims = [];
      fixture.authorityFailure = new Error("authority changed after side effect");

      await expect(service.completePostTool(postToolEvent("call-post-start-change", true)))
        .resolves.toMatchObject({ status: "COMPLETED", request_id: requestId });
      expect(await storedRequests()).toEqual([
        expect.objectContaining({ request_id: requestId, state: "COMPLETED" }),
      ]);
    });

    it.each(["publish", "board"] as const)(
      "leaves an approved %s wrapper permit for execution-layer atomic start",
      async (kind) => {
        const resource = kind === "board" ? BOARD : REPOSITORY;
        fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
        fixture.currentTask = taskWith(fixture.currentContract);
        fixture.currentClaim = activeClaim(fixture.currentContract);
        fixture.activeClaims = [fixture.currentClaim];
        const command = kind === "publish"
          ? `jhw-control guard with --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex -- git push origin HEAD`
          : `jhw-control board with --board ${resource.id} --mode exclusive --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex --purpose bounded -- flashrom -w firmware.bin`;
        const event = preTool(fixture.cwd, "Bash", { command });
        const { requestId, service } = await requestAndApprove(event);

        await expect(service.evaluatePreTool(preTool(
          fixture.cwd,
          "Bash",
          { command },
          "call-high-risk-retry",
        ))).resolves.toMatchObject({
          decision: "ALLOW",
          execution_boundary: kind === "publish" ? "guarded_command" : "board",
        });
        expect(await storedRequests()).toEqual([
          expect.objectContaining({ request_id: requestId, state: "APPROVED" }),
        ]);
      },
    );

    it("never creates a PostTool correlation for a deferred non-hook permit", async () => {
      fixture.currentContract = contract(TASK_ID, [grant("repo.inspect")]);
      fixture.currentTask = taskWith(fixture.currentContract);
      fixture.currentClaim = activeClaim(fixture.currentContract);
      fixture.activeClaims = [fixture.currentClaim];
      const command = `jhw-control guard with --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex -- git push origin HEAD`;
      const event = preTool(fixture.cwd, "Bash", { command });
      const { requestId, service } = await requestAndApprove(event);

      await expect(service.evaluatePreTool(preTool(
        fixture.cwd,
        "Bash",
        { command },
        "call-deferred-no-correlation",
      ))).resolves.toMatchObject({ decision: "ALLOW", execution_boundary: "guarded_command" });
      await expect(service.completePostTool(postToolEvent("call-deferred-no-correlation", true)))
        .resolves.toMatchObject({ status: "DENY", code: "GUARD_REQUEST_NOT_FOUND" });
      const [stored] = await storedRequests();
      expect(stored).toMatchObject({ request_id: requestId, state: "APPROVED" });
      expect(stored).not.toHaveProperty("correlation_id");
    });

    it("fails closed on corrupt request state without creating, reusing, or consuming a request", async () => {
      missingRepositoryModify();
      const service = integratedService();
      const stateDir = join(fixture.root, "guard-state");
      await mkdir(stateDir, { mode: 0o700 });
      const statePath = join(stateDir, "guard-requests.yaml");
      await writeFile(statePath, "{ corrupt", { mode: 0o600 });
      const before = await readFile(statePath);

      await expect(service.evaluatePreTool(preTool(fixture.cwd)))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
      expect(await readFile(statePath)).toEqual(before);
      expect(fixture.guardJournal.events).toEqual([]);
    });

    it("never approves or completes through corrupt state and leaves its bytes untouched", async () => {
      missingRepositoryModify();
      const service = integratedService();
      const stateDir = join(fixture.root, "guard-state");
      await mkdir(stateDir, { mode: 0o700 });
      const statePath = join(stateDir, "guard-requests.yaml");
      await writeFile(statePath, "{ corrupt", { mode: 0o600 });
      const before = await readFile(statePath);

      await expect(service.submitUserPrompt(promptEvent(`/jhw:unlock ${REQUEST_ID}`)))
        .resolves.toMatchObject({ status: "DENY", code: "GUARD_UNAVAILABLE" });
      await expect(service.completePostTool(postToolEvent("call-corrupt", true)))
        .resolves.toMatchObject({ status: "DENY", code: "GUARD_UNAVAILABLE" });
      expect(await readFile(statePath)).toEqual(before);
    });

    it("keeps every hard policy denial ahead of real request-store mutation", async () => {
      const scenarios: Array<{
        name: string;
        arrange(): void;
        event(): unknown;
        code: string;
      }> = [
        {
          name: "protocol",
          arrange: () => missingRepositoryModify(),
          event: () => ({ ...preTool(fixture.cwd) as object, protocol_version: 2 }),
          code: "GUARD_PROTOCOL_MISMATCH",
        },
        {
          name: "Claim",
          arrange: () => { fixture.currentClaim = undefined; fixture.activeClaims = []; },
          event: () => preTool(fixture.cwd),
          code: "GUARD_CLAIM_REQUIRED",
        },
        {
          name: "worktree",
          arrange: () => { missingRepositoryModify(); fixture.inspection = { ...fixture.inspection, branch: "other/branch" }; },
          event: () => preTool(fixture.cwd),
          code: "GUARD_WORKTREE_MISMATCH",
        },
        {
          name: "exclusive",
          arrange: () => {
            missingRepositoryModify();
            fixture.activeClaims = [
              fixture.currentClaim as ContractActiveClaim,
              activeClaim(contract(OTHER_TASK_ID, [grant("repo.inspect", REPOSITORY, "exclusive")])),
            ];
          },
          event: () => preTool(fixture.cwd),
          code: "GUARD_RESOURCE_OWNED",
        },
        {
          name: "authority",
          arrange: () => { missingRepositoryModify(); fixture.authorityFailure = new Error("moved"); },
          event: () => preTool(fixture.cwd),
          code: "GUARD_RESOURCE_AUTHORITY_UNAVAILABLE",
        },
        {
          name: "wrapper",
          arrange: () => missingRepositoryModify(),
          event: () => preTool(fixture.cwd, "Bash", { command: "git push origin HEAD" }),
          code: "GUARD_WRAPPER_REQUIRED",
        },
        {
          name: "self approval",
          arrange: () => missingRepositoryModify(),
          event: () => preTool(fixture.cwd, "Bash", { command: `jhw-control guard approve ${REQUEST_ID}` }),
          code: "GUARD_SELF_APPROVAL_DENIED",
        },
      ];

      for (const scenario of scenarios) {
        await rm(join(fixture.root, "guard-state"), { recursive: true, force: true });
        fixture.inspection = {
          ...fixture.inspection,
          branch: "task/guard-task",
          worktree_ref: "wt-guard-task",
        };
        fixture.authorityFailure = undefined;
        scenario.arrange();

        await expect(integratedService().evaluatePreTool(scenario.event()), scenario.name)
          .resolves.toMatchObject({ decision: "DENY", code: scenario.code });
        await expect(fixture.requestStore.inspect(), scenario.name)
          .resolves.toEqual({ status: "not_initialized", requests: [] });
      }
    });

    it("maps Guard-state lock contention to a registered bounded reason without mutation", async () => {
      missingRepositoryModify();
      const contendedStore = new GuardRequestStore(lockConfig(join(fixture.root, "contended-state")), {
        journal: new MemoryGuardJournal(),
        lockRuntime: { spawn: () => completedLockAcquisition(75) },
        environment: {},
      });

      await expect(integratedService({ guard_request_store: contendedStore })
        .evaluatePreTool(preTool(fixture.cwd))).resolves.toMatchObject({
        decision: "DENY",
        code: "GUARD_UNAVAILABLE",
        reason: "guard_state_lock",
      });
    });

    it("does not trust an instance override of the concrete request store", async () => {
      missingRepositoryModify();
      const forged = vi.fn(async () => ({
        request: { state: "APPROVED" },
        reused: true,
      }));
      Object.defineProperty(fixture.requestStore, "createOrReusePending", { value: forged });

      await expect(fixture.service({ guard_request_store: fixture.requestStore })
        .evaluatePreTool(preTool(fixture.cwd)))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
      expect(forged).not.toHaveBeenCalled();
      expect(fixture.permitCalls).toBe(0);
    });

    it("keeps an approved permit bound across file, command, resource, cwd, script, Task, and Claim changes", async () => {
      const cases: Array<{
        name: string;
        prepare(): Promise<{ original: unknown; changed: unknown; mutate?: () => void }>;
      }> = [
        {
          name: "file",
          prepare: async () => {
            await writeFile(join(fixture.cwd, "other.ts"), "a\n", "utf8");
            return {
              original: preTool(fixture.cwd, "Edit", { file_path: "src/file.ts", old_string: "a", new_string: "b" }),
              changed: preTool(fixture.cwd, "Edit", { file_path: "src/other.ts", old_string: "a", new_string: "b" }),
            };
          },
        },
        {
          name: "command",
          prepare: async () => ({
            original: preTool(fixture.cwd, "Bash", { command: "custom-tool alpha" }),
            changed: preTool(fixture.cwd, "Bash", { command: "custom-tool beta" }),
          }),
        },
        {
          name: "resource",
          prepare: async () => ({
            original: preTool(fixture.cwd, "Bash", {
              command: `jhw-control board with --board board-alpha --mode exclusive --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex --purpose bounded -- flashrom -w firmware.bin`,
            }),
            changed: preTool(fixture.cwd, "Bash", {
              command: `jhw-control board with --board board-beta --mode exclusive --task ${TASK_ID} --claim ${CLAIM_ID} --session ${SESSION_ID} --origin-adapter codex --purpose bounded -- flashrom -w firmware.bin`,
            }),
          }),
        },
        {
          name: "cwd",
          prepare: async () => ({
            original: preTool(fixture.root, "Bash", { command: "custom-tool stable" }),
            changed: preTool(fixture.cwd, "Bash", { command: "custom-tool stable" }),
          }),
        },
        {
          name: "script",
          prepare: async () => {
            const path = join(fixture.root, "bounded-script.sh");
            await writeFile(path, "#!/bin/sh\nprintf first\n", { mode: 0o700 });
            await chmod(path, 0o700);
            return {
              original: preTool(fixture.root, "Bash", { command: "./bounded-script.sh" }),
              changed: preTool(fixture.root, "Bash", { command: "./bounded-script.sh" }),
              mutate: () => { void writeFile(path, "#!/bin/sh\nprintf second\n", { mode: 0o700 }); },
            };
          },
        },
        {
          name: "Task",
          prepare: async () => ({
            original: preTool(fixture.cwd),
            changed: preTool(fixture.cwd),
            mutate: () => {
              const nextContract = contract(OTHER_TASK_ID, [grant("repo.inspect")]);
              fixture.currentTask = {
                ...taskWith(nextContract),
                id: OTHER_TASK_ID,
                aliases: ["other-task"],
              } as TaskRecord;
              fixture.currentClaim = {
                ...activeClaim(nextContract),
                session_id: SESSION_ID,
                branch: fixture.inspection.branch,
                worktree_ref: fixture.inspection.worktree_ref,
              };
              fixture.activeClaims = [fixture.currentClaim];
            },
          }),
        },
        {
          name: "Claim",
          prepare: async () => ({
            original: preTool(fixture.cwd),
            changed: preTool(fixture.cwd),
            mutate: () => {
              fixture.currentClaim = {
                ...fixture.currentClaim as ContractActiveClaim,
                claim_id: OTHER_CLAIM_ID,
              };
              fixture.activeClaims = [fixture.currentClaim];
            },
          }),
        },
      ];

      for (const entry of cases) {
        await rm(join(fixture.root, "guard-state"), { recursive: true, force: true });
        missingRepositoryModify();
        const prepared = await entry.prepare();
        const service = integratedService();
        const first = await service.evaluatePreTool(prepared.original);
        if (first.decision !== "PERMIT_REQUIRED") throw new Error(`expected ${entry.name} request`);
        await service.submitUserPrompt(promptEvent(first.approval_command));
        if (entry.name === "script") {
          await writeFile(join(fixture.root, "bounded-script.sh"), "#!/bin/sh\nprintf second\n", { mode: 0o700 });
        } else {
          prepared.mutate?.();
        }

        const changed = await service.evaluatePreTool(prepared.changed);
        expect(changed, entry.name).toMatchObject({ decision: "PERMIT_REQUIRED" });
        if (changed.decision !== "PERMIT_REQUIRED") throw new Error(`expected fresh ${entry.name} request`);
        expect(changed.request_id, entry.name).not.toBe(first.request_id);
        expect(await storedRequests(), entry.name).toEqual(expect.arrayContaining([
          expect.objectContaining({ request_id: first.request_id, state: "APPROVED" }),
          expect.objectContaining({ request_id: changed.request_id, state: "PENDING" }),
        ]));
      }
    });
  });

  it("fails exact approval closed but keeps PostTool inert when no request store is integrated", async () => {
    const service = fixture.service();

    await expect(service.submitUserPrompt({
      protocol_version: 1,
      adapter: "codex",
      event: "user_prompt_submit",
      session_id: SESSION_ID,
      prompt: `/jhw:unlock ${REQUEST_ID}`,
    })).resolves.toEqual({
      status: "DENY",
      event: "user_prompt_submit",
      code: "GUARD_UNAVAILABLE",
      summary: "Guard state or authority is unavailable",
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
