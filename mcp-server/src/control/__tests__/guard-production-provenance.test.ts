import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ControlConfig } from "../config.js";
import * as guardJournalModule from "../guard-journal.js";
import { GuardJournal } from "../guard-journal.js";
import type { CanonicalOperation } from "../guard-protocol.js";
import * as guardServiceModule from "../guard-service.js";
import {
  createGuardServiceComposition,
  type GuardServiceComposition,
  type GuardServiceOptions,
} from "../guard-service.js";
import * as guardStateModule from "../guard-state.js";
import { GuardRequestStore } from "../guard-state.js";
import * as processModule from "../process.js";
import { MutationLock, type MutationLockRuntime } from "../process.js";

const roots: string[] = [];
const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000002";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function configFor(stateDir: string): ControlConfig {
  return {
    registryDir: join(stateDir, "registry"),
    registryRemote: "origin",
    registryBranch: "main",
    worktreeRoot: join(stateDir, "worktrees"),
    buildHost: "cantopsbuildserver",
    githubOwner: "owner",
    projectNumber: 1,
    registryRepository: "owner/registry",
    preflightProjectItemId: "PVTI_guard",
    preflightRegistryIssueNumber: 1,
    stateDir,
    guardMode: "enforce",
  };
}

function completedRuntime(): MutationLockRuntime {
  return {
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }),
  };
}

function serviceOptions(
  requestStore: GuardRequestStore,
  journal: GuardJournal,
): Omit<GuardServiceOptions, "registry_mutation_barrier" | "guard_journal"> & { guard_journal: GuardJournal } {
  return {
    host: "cantopsbuildserver",
    digest_key: Buffer.alloc(32, 0x61),
    claims: {
      resolveSessionClaim: async () => undefined,
      listActiveClaims: async () => [],
    },
    tasks: {
      getTask: async () => { throw new Error("not used"); },
      inspectForGuard: async () => { throw new Error("not used"); },
      sourceRevisionForGuard: async () => { throw new Error("not used"); },
    },
    authority: { assertKnownRequirement: async () => undefined },
    registry_view: {
      withCommittedView: async (read) => read(),
      committedViewIsStale: async () => false,
    },
    guard_request_store: requestStore,
    guard_journal: journal,
    mode: "enforce",
  };
}

interface ProductionFactories {
  lock(config: ControlConfig, env?: NodeJS.ProcessEnv, profile?: "registry" | "board"): MutationLock;
  journal(stateDir: string, env?: NodeJS.ProcessEnv): GuardJournal;
  store(config: ControlConfig, env?: NodeJS.ProcessEnv): GuardRequestStore;
}

interface HostileEnvironmentFixture {
  environment: NodeJS.ProcessEnv;
  shimMarker: string;
  shellMarker: string;
}

async function hostileEnvironment(root: string): Promise<HostileEnvironmentFixture> {
  const shimDir = join(root, "hostile-bin");
  const shimMarker = join(root, "hostile-flock-ran");
  const shellMarker = join(root, "hostile-shell-control-ran");
  const shellControl = join(root, "hostile-shell-control.sh");
  await mkdir(shimDir);
  await writeFile(shellControl, `printf shell-control > "${shellMarker}"\n`, { mode: 0o600 });
  await writeFile(
    join(shimDir, "flock"),
    `#!/bin/bash\nprintf redirected > "${shimMarker}"\nexit 0\n`,
    { mode: 0o700 },
  );
  await chmod(join(shimDir, "flock"), 0o700);
  return {
    environment: {
      ...process.env,
      PATH: shimDir,
      LD_PRELOAD: join(root, "hostile-preload.so"),
      LD_LIBRARY_PATH: shimDir,
      BASH_ENV: shellControl,
      ENV: shellControl,
    },
    shimMarker,
    shellMarker,
  };
}

async function directChildPids(): Promise<Set<number>> {
  const taskRoot = `/proc/${process.pid}/task`;
  const taskIds = await readdir(taskRoot);
  const childLists = await Promise.all(taskIds.map(async (taskId) =>
    readFile(join(taskRoot, taskId, "children"), "utf8").catch(() => "")));
  return new Set(childLists.flatMap((children) => children.trim().split(/\s+/u))
    .filter(Boolean)
    .map(Number)
    .filter(Number.isSafeInteger));
}

type HelperObservation =
  | { status: "helper"; pid: number }
  | { status: "callback_entered" }
  | { status: "timeout" };

async function observeContendedProductionHelper(
  baseline: ReadonlySet<number>,
  callbackEntered: () => boolean,
  timeoutMs = 2_000,
): Promise<HelperObservation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (callbackEntered()) return { status: "callback_entered" };
    for (const pid of await directChildPids()) {
      if (baseline.has(pid)) continue;
      const executable = await readlink(`/proc/${pid}/exe`).catch(() => undefined);
      if (executable === "/usr/bin/flock") return { status: "helper", pid };
    }
    await delay(10);
  }
  return { status: "timeout" };
}

function productionFactories(): ProductionFactories | undefined {
  const lock = (processModule as unknown as { createProductionMutationLock?: ProductionFactories["lock"] })
    .createProductionMutationLock;
  const journal = (guardJournalModule as unknown as { createProductionGuardJournal?: ProductionFactories["journal"] })
    .createProductionGuardJournal;
  const store = (guardStateModule as unknown as { createProductionGuardRequestStore?: ProductionFactories["store"] })
    .createProductionGuardRequestStore;
  return lock && journal && store ? { lock, journal, store } : undefined;
}

function operation(): CanonicalOperation {
  return {
    protocol_version: 1,
    operation_id: "op-018f21e0-7b2c-7a00-8000-000000000003",
    origin_adapter: "codex",
    evaluation_stage: "hook",
    session_id: "codex-production-provenance",
    task_id: TASK_ID,
    claim_id: CLAIM_ID,
    cwd_worktree_ref: "wt-production-provenance",
    tool: "file.modify",
    requirements: [{
      capability: "repo.modify",
      resource: { kind: "repository", id: "repo-production" },
    }],
    risk: "medium",
    execution_boundary: "hook",
    summary: "repo.modify repository:repo-production",
    digest: "a".repeat(64),
  };
}

describe("Guard production provenance", () => {
  it("rejects direct default base-class objects because only factories mint production provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-default-direct-provenance-"));
    roots.push(root);
    const config = configFor(root);
    const journal = new GuardJournal(root);
    const store = new GuardRequestStore(config);
    const lock = new MutationLock(config);

    expect(() => createGuardServiceComposition(lock, serviceOptions(store, journal))).toThrow(TypeError);
  });

  it("rejects direct base-class objects with a synthetic-success runtime and mutable hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-direct-provenance-"));
    roots.push(root);
    const config = configFor(root);
    const mutableHooks = {};
    const journal = new GuardJournal(root, mutableHooks);
    const store = new GuardRequestStore(config, {
      journal,
      lockRuntime: completedRuntime(),
      secureDirectoryHooks: mutableHooks,
      environment: {},
    });
    const lock = new MutationLock(config, {}, completedRuntime(), mutableHooks);

    expect(() => createGuardServiceComposition(lock, serviceOptions(store, journal))).toThrow(TypeError);
  });

  it("provides a separate test-only composition that cannot mint production provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-test-composition-"));
    roots.push(root);
    const config = configFor(root);
    const journal = new GuardJournal(root);
    const store = new GuardRequestStore(config, {
      journal,
      lockRuntime: completedRuntime(),
      environment: {},
    });
    const lock = new MutationLock(config, {}, completedRuntime());
    const testComposition = (guardServiceModule as unknown as {
      createGuardServiceCompositionForTesting?: (
        registryMutationLock: MutationLock,
        options: ReturnType<typeof serviceOptions>,
      ) => GuardServiceComposition;
    }).createGuardServiceCompositionForTesting;

    expect(testComposition).toBeTypeOf("function");
    if (!testComposition) return;
    expect(testComposition(lock, serviceOptions(store, journal)).registry_mutation_lock).toBe(lock);
    expect(() => createGuardServiceComposition(lock, serviceOptions(store, journal))).toThrow(TypeError);
  });

  it("composes only module-owned production objects and preserves the exact Registry writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-production-composition-"));
    roots.push(root);
    const config = configFor(root);
    const factories = productionFactories();

    expect(factories).toBeDefined();
    if (!factories) return;
    const lock = factories.lock(config, {});
    const journal = factories.journal(root, {});
    const store = factories.store(config, {});
    const composition = createGuardServiceComposition(lock, serviceOptions(store, journal));

    expect(composition.registry_mutation_lock).toBe(lock);
    expect(Object.isFrozen(composition)).toBe(true);
  });

  it("pins the production helper path and environment under a hostile initial environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-production-hostile-lock-"));
    roots.push(root);
    const hostile = await hostileEnvironment(root);
    const factories = productionFactories();

    expect(factories).toBeDefined();
    if (!factories) return;
    const config = configFor(join(root, "state"));
    const first = factories.lock(config, hostile.environment, "board");
    const second = factories.lock(config, hostile.environment, "board");
    let releaseFirst: () => void = () => undefined;
    let markFirstEntered: () => void = () => undefined;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const held = first.run(async () => {
      markFirstEntered();
      await firstGate;
    });
    await firstEntered;
    const baseline = await directChildPids();
    let secondEntered = false;
    const competing = second.run(async () => {
      secondEntered = true;
    });

    try {
      const observation = await observeContendedProductionHelper(baseline, () => secondEntered);
      expect(observation.status).toBe("helper");
      if (observation.status !== "helper") return;
      expect(await readlink(`/proc/${observation.pid}/exe`)).toBe("/usr/bin/flock");
      const helperEnvironment = (await readFile(`/proc/${observation.pid}/environ`, "utf8"))
        .split("\0")
        .filter(Boolean)
        .sort();
      expect(helperEnvironment).toEqual(["LC_ALL=C"]);
      for (const key of ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV"]) {
        expect(helperEnvironment.some((entry) => entry.startsWith(`${key}=`))).toBe(false);
      }
      expect(secondEntered).toBe(false);

      releaseFirst();
      await Promise.all([held, competing]);
      expect(secondEntered).toBe(true);
      await expect(readFile(hostile.shimMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(hostile.shellMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseFirst();
      await Promise.allSettled([held, competing]);
    }
  });

  it("snapshots caller config so later stateDir mutation cannot retarget I/O or host coordinates", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-production-config-"));
    roots.push(root);
    const originalState = join(root, "original-state");
    const retargetedState = join(root, "retargeted-state");
    const callerConfig = configFor(originalState);
    const factories = productionFactories();

    expect(factories).toBeDefined();
    if (!factories) return;
    const lock = factories.lock(callerConfig, process.env);
    const journal = factories.journal(originalState, process.env);
    const store = factories.store(callerConfig, process.env);
    callerConfig.stateDir = retargetedState;

    expect(createGuardServiceComposition(lock, serviceOptions(store, journal)).registry_mutation_lock).toBe(lock);
    await lock.run(async () => undefined);
    await store.createOrReusePending(operation());
    await expect(readFile(join(originalState, "registry.lock"))).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(join(originalState, "guard-requests.yaml"), "utf8")).resolves.toContain(TASK_ID);
    await expect(readFile(join(retargetedState, "registry.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(retargetedState, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains genuine cross-process exclusion for two module-owned production locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-production-lock-"));
    roots.push(root);
    const factories = productionFactories();

    expect(factories).toBeDefined();
    if (!factories) return;
    const config = configFor(root);
    const first = factories.lock(config, process.env);
    const second = factories.lock(config, process.env);
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = first.run(async () => {
      entered();
      await gate;
    });
    await enteredPromise;

    await expect(second.run(async () => undefined)).rejects.toMatchObject({ code: "LOCK_CONTENDED" });
    release();
    await held;
  });

  it("retains exactly-one consume in a module-owned production request store", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-production-store-"));
    roots.push(root);
    const factories = productionFactories();

    expect(factories).toBeDefined();
    if (!factories) return;
    const firstStore = factories.store(configFor(root), process.env);
    const secondStore = factories.store(configFor(root), process.env);
    const pending = await firstStore.createOrReusePending(operation());
    await expect(firstStore.approveFromPrompt(
      "codex",
      operation().session_id,
      `/jhw:unlock ${pending.request.request_id}`,
    )).resolves.toMatchObject({ status: "APPROVED" });

    const outcomes = await Promise.allSettled([
      firstStore.consumeMatching(operation(), "call-production-one"),
      secondStore.consumeMatching(operation(), "call-production-two"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("keeps exactly-one consume under a hostile initial environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "guard-production-hostile-store-"));
    roots.push(root);
    const hostile = await hostileEnvironment(root);
    const factories = productionFactories();

    expect(factories).toBeDefined();
    if (!factories) return;
    for (let round = 0; round < 8; round += 1) {
      const config = configFor(join(root, `state-${round}`));
      const firstStore = factories.store(config, hostile.environment);
      const secondStore = factories.store(config, hostile.environment);
      const pending = await firstStore.createOrReusePending(operation());
      await firstStore.approveFromPrompt(
        "codex",
        operation().session_id,
        `/jhw:unlock ${pending.request.request_id}`,
      );

      const outcomes = await Promise.allSettled([
        firstStore.consumeMatching(operation(), `call-hostile-one-${round}`),
        secondStore.consumeMatching(operation(), `call-hostile-two-${round}`),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(rejected, `round ${round}`).toBeDefined();
      expect(rejected?.reason, `round ${round}`).toMatchObject({ code: "GUARD_PERMIT_CONSUMED" });
    }
    await expect(readFile(hostile.shimMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(hostile.shellMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});
