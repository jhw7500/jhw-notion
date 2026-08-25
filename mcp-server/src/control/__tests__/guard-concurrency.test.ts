import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ControlConfig } from "../config.js";
import {
  createGuardServiceComposition,
  type GuardServiceOptions,
} from "../guard-service.js";
import { GuardRequestStore } from "../guard-state.js";
import type { GuardJournalEvent, GuardJournalPort } from "../guard-journal.js";
import { MutationLock } from "../process.js";
import {
  ContractActiveClaimSchema,
  type ContractActiveClaim,
  type TaskRecord,
} from "../schemas.js";
import {
  normalizeWorkContract,
  workContractDigest,
  type WorkContract,
} from "../work-contract.js";

const runFile = promisify(execFile);
const roots: string[] = [];
const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000002";
const SESSION_ID = "codex-guard-concurrency";
const HOST = "cantopsbuildserver";

class MemoryJournal implements GuardJournalPort {
  readonly events: GuardJournalEvent[] = [];

  async append(event: GuardJournalEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

function configFor(stateDir: string): ControlConfig {
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
  };
}

function contract(): WorkContract {
  return normalizeWorkContract({
    version: 1,
    task_id: TASK_ID,
    grants: [{
      capability: "repo.inspect",
      resource: { kind: "repository", id: "repo-guard" },
      coordination: "shared",
    }],
    dependencies: [],
  });
}

function task(workContract: WorkContract): TaskRecord {
  return {
    id: TASK_ID,
    kind: "temporary",
    project_id: "prj-guard",
    repo_id: "repo-guard",
    aliases: ["guard-concurrency"],
    goal: "Guard concurrency fixture",
    done_conditions: ["one permit consumer"],
    expected_scope: ["repository"],
    lifecycle: "active",
    task_role: "standalone",
    work_contract: workContract,
  };
}

function claim(workContract: WorkContract): ContractActiveClaim {
  return ContractActiveClaimSchema.parse({
    task_id: TASK_ID,
    task_alias: "guard-concurrency",
    project_id: "prj-guard",
    repo_id: "repo-guard",
    claim_id: CLAIM_ID,
    origin_adapter: "codex",
    session_id: SESSION_ID,
    host: HOST,
    branch: "task/guard-concurrency",
    worktree_ref: "wt-guard-concurrency",
    source_task_revision: "2026-08-25T00:00:00.000Z",
    started_at: "2026-08-25T00:00:00.000Z",
    work_contract: workContract,
    work_contract_digest: workContractDigest(workContract),
  });
}

function preTool(cwd: string, toolUseId: string): unknown {
  return {
    protocol_version: 1,
    adapter: "codex",
    event: "pre_tool_use",
    session_id: SESSION_ID,
    cwd,
    tool_name: "Edit",
    tool_input: { file_path: "src/file.ts", old_string: "a", new_string: "b" },
    tool_use_id: toolUseId,
  };
}

function prompt(command: string): unknown {
  return {
    protocol_version: 1,
    adapter: "codex",
    event: "user_prompt_submit",
    session_id: SESSION_ID,
    prompt: command,
  };
}

function postTool(toolUseId: string): unknown {
  return {
    protocol_version: 1,
    adapter: "codex",
    event: "post_tool_use",
    session_id: SESSION_ID,
    tool_use_id: toolUseId,
    ok: true,
  };
}

async function fixture(options: {
  afterGuardStateFileSync?: () => Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-guard-concurrency-"));
  roots.push(root);
  const cwd = join(root, "src");
  await runFile("git", ["init", "--quiet", root]);
  await mkdir(cwd);
  await writeFile(join(cwd, "file.ts"), "a\n", "utf8");
  const stateDir = join(root, "state");
  const config = configFor(stateDir);
  const registryMutationLock = new MutationLock(config, {});
  const journal = new MemoryJournal();
  const requestStore = new GuardRequestStore(config, {
    journal,
    environment: {},
    ...(options.afterGuardStateFileSync
      ? { stateHooks: { afterStateFileSync: options.afterGuardStateFileSync } }
      : {}),
  });
  const currentContract = contract();
  const currentTask = task(currentContract);
  const currentClaim = claim(currentContract);
  const serviceOptions: Omit<GuardServiceOptions, "registry_mutation_barrier"> = {
    host: HOST,
    digest_key: Buffer.alloc(32, 7),
    claims: {
      resolveSessionClaim: async () => currentClaim,
      listActiveClaims: async () => [currentClaim],
    },
    tasks: {
      getTask: async () => currentTask,
      inspectForGuard: async () => ({
        active: currentClaim,
        worktree: {
          path: root,
          repository_path: root,
          branch: currentClaim.branch,
          worktree_ref: currentClaim.worktree_ref,
          head_sha: "a".repeat(40),
          dirty: false,
          dirty_files: [],
          ahead: 0,
          behind: 0,
        },
      }),
      sourceRevisionForGuard: async () => currentClaim.source_task_revision,
    },
    authority: { assertKnownRequirement: async () => undefined },
    registry_view: {
      withCommittedView: async <T>(read: () => Promise<T>) => read(),
      committedViewIsStale: async () => false,
    },
    guard_request_store: requestStore,
  };
  const composition = createGuardServiceComposition(registryMutationLock, serviceOptions);
  return { root, cwd, stateDir, requestStore, journal, registryMutationLock, composition };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GuardService concurrency and Registry composition", () => {
  it("composes the Guard barrier from the exact Registry-writer MutationLock object", async () => {
    const { registryMutationLock, composition } = await fixture();

    expect(composition.registry_mutation_lock).toBe(registryMutationLock);
  });

  it("holds the Registry writer lock before entering the independent Guard state mutation", async () => {
    let stateMutationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { stateMutationEntered = resolve; });
    let releaseStateMutation!: () => void;
    const release = new Promise<void>((resolve) => { releaseStateMutation = resolve; });
    const { cwd, composition } = await fixture({
      afterGuardStateFileSync: async () => {
        stateMutationEntered();
        await release;
      },
    });
    let writerEntered = false;
    const evaluation = composition.service.evaluatePreTool(preTool(cwd, "call-lock-order"));
    await entered;

    await expect(composition.registry_mutation_lock.run(async () => {
      writerEntered = true;
    })).rejects.toMatchObject({ code: "LOCK_CONTENDED" });
    expect(writerEntered).toBe(false);

    releaseStateMutation();
    await expect(evaluation).resolves.toMatchObject({ decision: "PERMIT_REQUIRED" });
  });

  it("allows exactly one of two simultaneous approved hook retries and stably denies the replay", async () => {
    const { cwd, composition, requestStore } = await fixture();
    const first = await composition.service.evaluatePreTool(preTool(cwd, "call-request"));
    if (first.decision !== "PERMIT_REQUIRED") throw new Error("expected permit request");
    await expect(composition.service.submitUserPrompt(prompt(first.approval_command)))
      .resolves.toMatchObject({ status: "APPROVED", request_id: first.request_id });

    const outcomes = await Promise.all([
      composition.service.evaluatePreTool(preTool(cwd, "call-race-a")),
      composition.service.evaluatePreTool(preTool(cwd, "call-race-b")),
    ]);

    expect(outcomes.filter((entry) => entry.decision === "ALLOW")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.decision === "DENY" && entry.code === "GUARD_PERMIT_CONSUMED"))
      .toHaveLength(1);
    const inspected = await requestStore.inspect();
    expect(inspected).toMatchObject({
      status: "ready",
      requests: [expect.objectContaining({
        request_id: first.request_id,
        state: "CONSUMED",
        correlation_id: expect.stringMatching(/^call-race-[ab]$/u),
      })],
    });
  });

  it("holds the Registry writer lock before completing consumed Guard state", async () => {
    let blockCompletion = false;
    let completionMutationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { completionMutationEntered = resolve; });
    let releaseCompletionMutation!: () => void;
    const release = new Promise<void>((resolve) => { releaseCompletionMutation = resolve; });
    const { cwd, composition } = await fixture({
      afterGuardStateFileSync: async () => {
        if (!blockCompletion) return;
        completionMutationEntered();
        await release;
      },
    });
    const first = await composition.service.evaluatePreTool(preTool(cwd, "call-completion-request"));
    if (first.decision !== "PERMIT_REQUIRED") throw new Error("expected permit request");
    await composition.service.submitUserPrompt(prompt(first.approval_command));
    await composition.service.evaluatePreTool(preTool(cwd, "call-completion"));

    blockCompletion = true;
    const completion = composition.service.completePostTool(postTool("call-completion"));
    await entered;

    await expect(composition.registry_mutation_lock.run(async () => undefined))
      .rejects.toMatchObject({ code: "LOCK_CONTENDED" });

    releaseCompletionMutation();
    await expect(completion).resolves.toMatchObject({ status: "COMPLETED" });
  });
});
