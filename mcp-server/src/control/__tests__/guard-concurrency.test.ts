import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { GuardJournal, type GuardJournalEvent, type GuardJournalPort } from "../guard-journal.js";
import { MutationLock, type MutationLockRuntime } from "../process.js";
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
  afterDecisionJournalSync?: () => Promise<void>;
  registryLockRuntime?: MutationLockRuntime;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-guard-concurrency-"));
  roots.push(root);
  const cwd = join(root, "src");
  await runFile("git", ["init", "--quiet", root]);
  await mkdir(cwd);
  await writeFile(join(cwd, "file.ts"), "a\n", "utf8");
  const stateDir = join(root, "state");
  const config = configFor(stateDir);
  const registryMutationLock = new MutationLock(config, {}, options.registryLockRuntime);
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
  const registryView = {
    withCommittedView: async <T>(read: () => Promise<T>) => read(),
    committedViewIsStale: async () => false,
  };
  const decisionJournal = new GuardJournal(stateDir, options.afterDecisionJournalSync
    ? { afterJournalSync: options.afterDecisionJournalSync }
    : {});
  const serviceOptions = {
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
    registry_view: registryView,
    guard_request_store: requestStore,
    guard_journal: decisionJournal,
  } as Omit<GuardServiceOptions, "registry_mutation_barrier"> & { guard_journal: GuardJournal };
  const composition = createGuardServiceComposition(registryMutationLock, serviceOptions);
  return {
    root,
    cwd,
    stateDir,
    config,
    requestStore,
    journal,
    decisionJournal,
    registryView,
    serviceOptions,
    registryMutationLock,
    composition,
  };
}

function completedLockAcquisition(status = 0): ReturnType<MutationLockRuntime["spawn"]> {
  const emitter = new EventEmitter();
  queueMicrotask(() => emitter.emit("close", status));
  return emitter as ReturnType<MutationLockRuntime["spawn"]>;
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

  it("rejects a genuine decision journal on a different host state coordinate before it can write there", async () => {
    const fixtureValue = await fixture();
    const unrelatedStateDir = join(fixtureValue.root, "unrelated-state");

    expect(() => createGuardServiceComposition(fixtureValue.registryMutationLock, {
      ...fixtureValue.serviceOptions,
      guard_journal: new GuardJournal(unrelatedStateDir),
    })).toThrow(TypeError);
    await expect(readFile(join(unrelatedStateDir, "guard-journal.jsonl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects genuine request state on a different host coordinate from Registry and decision journal", async () => {
    const fixtureValue = await fixture();
    const unrelatedConfig = configFor(join(fixtureValue.root, "unrelated-request-state"));
    const unrelatedStore = new GuardRequestStore(unrelatedConfig, {
      journal: new MemoryJournal(),
      environment: {},
    });

    expect(() => createGuardServiceComposition(fixtureValue.registryMutationLock, {
      ...fixtureValue.serviceOptions,
      guard_request_store: unrelatedStore,
    })).toThrow(TypeError);
  });

  it("composes exact matching coordinates and writes the decision journal at that coordinate", async () => {
    const fixtureValue = await fixture();

    await expect(fixtureValue.composition.service.evaluatePreTool({ protocol_version: 2 }))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_PROTOCOL_MISMATCH" });
    const rows = (await readFile(join(fixtureValue.stateDir, "guard-journal.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as GuardJournalEvent);
    expect(rows).toEqual([
      expect.objectContaining({ event: "decision", decision_code: "GUARD_PROTOCOL_MISMATCH" }),
    ]);
  });

  it("normalizes equivalent host coordinate spellings before composing all three authorities", async () => {
    const fixtureValue = await fixture();
    const spellingDirectory = join(fixtureValue.root, "coordinate-spelling");
    await mkdir(spellingDirectory);
    const equivalentStateDir = `${spellingDirectory}/../state`;
    const equivalentStore = new GuardRequestStore(configFor(equivalentStateDir), {
      journal: new MemoryJournal(),
      environment: {},
    });
    const composition = createGuardServiceComposition(fixtureValue.registryMutationLock, {
      ...fixtureValue.serviceOptions,
      guard_request_store: equivalentStore,
      guard_journal: new GuardJournal(equivalentStateDir),
    });

    await expect(composition.service.evaluatePreTool(preTool(
      fixtureValue.cwd,
      "call-normalized-coordinate",
    ))).resolves.toMatchObject({ decision: "PERMIT_REQUIRED" });
    await expect(readFile(join(fixtureValue.stateDir, "guard-journal.jsonl"), "utf8"))
      .resolves.toContain('"event":"decision"');
  });

  it("does not treat a symlink spelling as matching host coordinate authority", async () => {
    const fixtureValue = await fixture();
    const aliasStateDir = join(fixtureValue.root, "state-alias");
    await symlink(fixtureValue.stateDir, aliasStateDir, "dir");

    expect(() => createGuardServiceComposition(fixtureValue.registryMutationLock, {
      ...fixtureValue.serviceOptions,
      guard_journal: new GuardJournal(aliasStateDir),
    })).toThrow(TypeError);
  });

  it("pins Registry and request-state I/O against post-construction config retargeting", async () => {
    const fixtureValue = await fixture();
    const retargetedStateDir = join(fixtureValue.root, "retargeted-state");
    fixtureValue.config.stateDir = retargetedStateDir;

    await expect(fixtureValue.composition.service.evaluatePreTool(preTool(
      fixtureValue.cwd,
      "call-config-retarget",
    ))).resolves.toMatchObject({ decision: "PERMIT_REQUIRED" });
    const state = JSON.parse(
      await readFile(join(fixtureValue.stateDir, "guard-requests.yaml"), "utf8"),
    ) as { requests: Array<{ state: string }> };
    expect(state.requests).toEqual([expect.objectContaining({ state: "PENDING" })]);
    await expect(readFile(join(retargetedStateDir, "guard-requests.yaml"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins decision-journal I/O against a public-property retarget attempt", async () => {
    const fixtureValue = await fixture();
    const retargetedStateDir = join(fixtureValue.root, "retargeted-journal");
    (fixtureValue.decisionJournal as unknown as { stateDir: string }).stateDir = retargetedStateDir;

    await expect(fixtureValue.composition.service.evaluatePreTool({ protocol_version: 2 }))
      .resolves.toMatchObject({ decision: "DENY", code: "GUARD_PROTOCOL_MISMATCH" });
    await expect(readFile(join(fixtureValue.stateDir, "guard-journal.jsonl"), "utf8"))
      .resolves.toContain('"decision_code":"GUARD_PROTOCOL_MISMATCH"');
    await expect(readFile(join(retargetedStateDir, "guard-journal.jsonl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects derived, overridden, and provenance-less journal authorities at composition", async () => {
    const fixtureValue = await fixture();
    class DerivedGuardJournal extends GuardJournal {}
    const overridden = new GuardJournal(fixtureValue.stateDir);
    Object.defineProperty(overridden, "append", { value: vi.fn(async () => undefined) });
    const provenanceLess = Object.create(GuardJournal.prototype) as GuardJournal;
    const candidates = [
      new DerivedGuardJournal(fixtureValue.stateDir),
      overridden,
      provenanceLess,
    ];

    for (const guardJournal of candidates) {
      expect(() => createGuardServiceComposition(fixtureValue.registryMutationLock, {
        ...fixtureValue.serviceOptions,
        guard_journal: guardJournal,
      })).toThrow(TypeError);
    }
  });

  it("rejects a provenance-less request store at composition", async () => {
    const fixtureValue = await fixture();
    const provenanceLess = Object.create(GuardRequestStore.prototype) as GuardRequestStore;

    expect(() => createGuardServiceComposition(fixtureValue.registryMutationLock, {
      ...fixtureValue.serviceOptions,
      guard_request_store: provenanceLess,
    })).toThrow(TypeError);
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

  it("serializes exact retries across distinct concrete Registry locks and request stores on one host coordinate", async () => {
    let blockConsume = false;
    let consumeEntered!: () => void;
    const entered = new Promise<void>((resolve) => { consumeEntered = resolve; });
    let releaseConsume!: () => void;
    const release = new Promise<void>((resolve) => { releaseConsume = resolve; });
    const fixtureValue = await fixture({
      afterGuardStateFileSync: async () => {
        if (!blockConsume) return;
        consumeEntered();
        await release;
      },
    });
    const secondStore = new GuardRequestStore(fixtureValue.config, {
      journal: new MemoryJournal(),
      environment: {},
    });
    const secondLock = new MutationLock(fixtureValue.config, {});
    const secondComposition = createGuardServiceComposition(secondLock, {
      ...fixtureValue.serviceOptions,
      guard_request_store: secondStore,
      guard_journal: new GuardJournal(fixtureValue.stateDir),
    });
    const first = await fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-cross-object-request"),
    );
    if (first.decision !== "PERMIT_REQUIRED") throw new Error("expected permit request");
    await fixtureValue.composition.service.submitUserPrompt(prompt(first.approval_command));

    blockConsume = true;
    const firstRetry = fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-cross-object-a"),
    );
    await entered;
    const secondRetry = secondComposition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-cross-object-b"),
    );
    const beforeRelease = await Promise.race([
      secondRetry.then((decision) => ({ status: "settled" as const, decision })),
      new Promise<{ status: "waiting" }>((resolve) => setTimeout(() => resolve({ status: "waiting" }), 150)),
    ]);
    releaseConsume();
    const outcomes = await Promise.all([firstRetry, secondRetry]);

    expect(beforeRelease).toEqual({ status: "waiting" });
    expect(outcomes.filter((entry) => entry.decision === "ALLOW")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.decision === "DENY" && entry.code === "GUARD_PERMIT_CONSUMED"))
      .toHaveLength(1);
  });

  it("fails same-async-chain Guard reentrancy before enqueue without deadlocking the outer evaluation", async () => {
    const fixtureValue = await fixture();
    const originalView = fixtureValue.registryView.withCommittedView;
    let recursed = false;
    let nestedResult: unknown;
    let nestedCompletion: Promise<unknown> | undefined;
    fixtureValue.registryView.withCommittedView = async <T>(read: () => Promise<T>): Promise<T> => {
      if (!recursed) {
        recursed = true;
        const nested = fixtureValue.composition.service.evaluatePreTool(
          preTool(fixtureValue.cwd, "call-reentrant-inner"),
        );
        nestedCompletion = nested;
        nestedResult = await Promise.race([
          nested,
          new Promise((resolve) => setTimeout(() => resolve("timed-out"), 150)),
        ]);
      }
      return originalView(read);
    };

    const outer = await fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-reentrant-outer"),
    );
    await nestedCompletion;

    expect(nestedResult).toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    expect(outer).toMatchObject({ decision: "PERMIT_REQUIRED" });
  });

  it("bounds Guard waiters and cleans admission after the held evaluation drains", async () => {
    let stateMutationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { stateMutationEntered = resolve; });
    let releaseStateMutation!: () => void;
    const release = new Promise<void>((resolve) => { releaseStateMutation = resolve; });
    const fixtureValue = await fixture({
      afterGuardStateFileSync: async () => {
        stateMutationEntered();
        await release;
      },
    });
    const held = fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-capacity-held"),
    );
    await entered;
    const contenders = Array.from({ length: 17 }, (_, index) =>
      fixtureValue.composition.service.evaluatePreTool(
        preTool(fixtureValue.cwd, `call-capacity-${index}`),
      ));
    const overflow = await Promise.race([
      Promise.any(contenders.map(async (result) => {
        const decision = await result;
        if (decision.decision === "DENY" && decision.code === "GUARD_UNAVAILABLE") return decision;
        return new Promise<never>(() => undefined);
      })),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
    ]);

    releaseStateMutation();
    await Promise.all([held, ...contenders]);
    expect(overflow).toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    await expect(fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-capacity-after-drain"),
    )).resolves.toMatchObject({ decision: "PERMIT_REQUIRED" });
  });

  it("drains Guard admission after callback and acquisition failures", async () => {
    let acquisition = 0;
    const acquisitionStatuses = [75, 1, 0, 0, 0];
    const fixtureValue = await fixture({
      registryLockRuntime: {
        spawn: () => completedLockAcquisition(acquisitionStatuses[acquisition++] ?? 0),
      },
    });

    await expect(fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-acquire-contention"),
    )).resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    await expect(fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-acquire-nonzero"),
    )).resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    await expect(fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-after-acquire-failure"),
    )).resolves.toMatchObject({ decision: "PERMIT_REQUIRED" });

    const originalView = fixtureValue.registryView.withCommittedView;
    fixtureValue.registryView.withCommittedView = async () => {
      throw new Error("callback failed");
    };
    await expect(fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-callback-failure"),
    )).resolves.toMatchObject({ decision: "DENY", code: "GUARD_UNAVAILABLE" });
    fixtureValue.registryView.withCommittedView = originalView;
    await expect(fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-after-callback-failure"),
    )).resolves.toMatchObject({ decision: "PERMIT_REQUIRED" });
  });

  it("appends the decision journal only after releasing the Registry writer lock", async () => {
    let journalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { journalEntered = resolve; });
    let releaseJournal!: () => void;
    const release = new Promise<void>((resolve) => { releaseJournal = resolve; });
    const fixtureValue = await fixture({
      afterDecisionJournalSync: async () => {
        journalEntered();
        await release;
      },
    });
    const evaluation = fixtureValue.composition.service.evaluatePreTool(
      preTool(fixtureValue.cwd, "call-decision-journal-order"),
    );
    const reachedJournal = await Promise.race([
      entered.then(() => true),
      evaluation.then(() => false),
    ]);
    let writerEntered = false;
    if (reachedJournal) {
      await fixtureValue.registryMutationLock.run(async () => {
        writerEntered = true;
      });
      releaseJournal();
    }
    await evaluation;

    expect(reachedJournal).toBe(true);
    expect(writerEntered).toBe(true);
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
