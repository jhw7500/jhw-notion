import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Catalog } from "../catalog.js";
import { ClaimService, type ClaimInspection } from "../claim-service.js";
import { ControlError } from "../errors.js";
import {
  createGuardRegistryMutationBarrier,
  GuardService,
  type GuardServiceOptions,
} from "../guard-service.js";
import { GuardRequestStore } from "../guard-state.js";
import { MutationLock, ProcessRunner } from "../process.js";
import * as processModule from "../process.js";
import { type ProcessRunnerLike, RegistryGit } from "../registry-git.js";
import type { ContractActiveClaim, TaskRecord } from "../schemas.js";
import {
  commitFile,
  configFor,
  isolatedRegistryGit,
  makeRegistryFixture,
  type RegistryFixture,
} from "./helpers.js";

const fixtures: RegistryFixture[] = [];
const HOST = "cantopsbuildserver";
const SESSION = "codex-registry-freshness";
const REPOSITORY = { kind: "repository", id: "repo-freshness" } as const;

const inspection: ClaimInspection = {
  async inspect() {
    return { process_exists: false, worktree_mapped: true, dirty: false, ahead: 0 };
  },
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function registryBarrier(config: ReturnType<typeof configFor>) {
  const productionFactory = (processModule as unknown as {
    createProductionMutationLock?: (
      input: ReturnType<typeof configFor>,
      env?: NodeJS.ProcessEnv,
    ) => MutationLock;
  }).createProductionMutationLock;
  const lock = productionFactory ? productionFactory(config, {}) : new MutationLock(config, {});
  return createGuardRegistryMutationBarrier(lock);
}

function laterHeadFailureRunner(): { runner: ProcessRunnerLike; headCalls: () => number } {
  const real = new ProcessRunner();
  let calls = 0;
  return {
    runner: {
      async run(command, args, options) {
        if (args[0] === "rev-parse" && args[1] === "HEAD" && ++calls > 1) {
          throw new ControlError("COMMAND_FAILED", "injected later Registry HEAD failure");
        }
        return real.run(command, args, options);
      },
      runRaw: real.runRaw.bind(real),
    },
    headCalls: () => calls,
  };
}

interface FreshnessFixture {
  fixture: RegistryFixture;
  task: TaskRecord;
  claim: ContractActiveClaim;
  requestStore: GuardRequestStore;
  stableService: GuardService;
  flakyService: GuardService;
  flakyHeadCalls(): number;
  event(toolUseId?: string): unknown;
}

async function freshnessFixture(includeModifyGrant: boolean): Promise<FreshnessFixture> {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const config = configFor(fixture.registryDir);
  const stableRegistry = isolatedRegistryGit(config, new ProcessRunner());
  const authority = {
    assertKnownContract: async () => undefined,
    assertKnownRequirement: async () => undefined,
  };
  const stableCatalog = new Catalog(config, stableRegistry, undefined, authority);
  await stableCatalog.registerRepository({
    repo_id: REPOSITORY.id,
    github_node_id: "R_freshness",
    slug: "jhw7500/freshness",
  });
  const grants = [
    { capability: "repo.inspect" as const, resource: { ...REPOSITORY }, coordination: "shared" as const },
    ...(includeModifyGrant
      ? [{ capability: "repo.modify" as const, resource: { ...REPOSITORY }, coordination: "shared" as const }]
      : []),
  ];
  const task = await stableCatalog.registerTemporaryTask({
    project_id: "prj-freshness",
    repo_id: REPOSITORY.id,
    alias: "freshness:tmp-20260826-01-guard",
    goal: "prove Registry freshness failure propagation",
    done_conditions: ["authority is denied before mutation"],
    expected_scope: ["src/file.ts"],
    grants,
    dependencies: [],
  });
  const stableClaims = new ClaimService(config, stableRegistry, stableCatalog, inspection);
  const claim = await stableClaims.claimTask({
    task_id: task.id,
    task_alias: task.aliases[0] as string,
    project_id: task.project_id,
    repo_id: task.repo_id,
    origin_adapter: "codex",
    session_id: SESSION,
    host: HOST,
    branch: "task/registry-freshness",
    worktree_ref: "wt-registry-freshness",
  });

  const worktree = join(fixture.root, "guard-worktree");
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, "src", "file.ts"), "a\n", "utf8");
  const requestStore = new GuardRequestStore({ ...config, stateDir: join(fixture.root, "guard-state") }, {
    environment: {},
  });
  const barrier = registryBarrier(config);
  const taskPort = {
    getTask: async () => task,
    inspectForGuard: async () => ({
      active: claim,
      worktree: {
        path: worktree,
        repository_path: worktree,
        branch: claim.branch,
        worktree_ref: claim.worktree_ref,
        head_sha: "a".repeat(40),
        dirty: false,
        dirty_files: [],
        ahead: 0,
        behind: 0,
      },
    }),
    sourceRevisionForGuard: async () => claim.source_task_revision,
  };
  const common = {
    host: HOST,
    digest_key: Buffer.alloc(32, 0x53),
    tasks: taskPort,
    authority: { assertKnownRequirement: async () => undefined },
    registry_mutation_barrier: barrier,
    guard_request_store: requestStore,
    mode: "enforce" as const,
  };
  const stableService = new GuardService({
    ...common,
    claims: stableClaims,
    registry_view: stableClaims,
  });

  const laterHead = laterHeadFailureRunner();
  const flakyRegistry = isolatedRegistryGit(config, laterHead.runner);
  const flakyCatalog = new Catalog(config, flakyRegistry, undefined, authority);
  const flakyClaims = new ClaimService(config, flakyRegistry, flakyCatalog, inspection);
  const flakyService = new GuardService({
    ...common,
    claims: flakyClaims,
    registry_view: flakyClaims,
  });

  return {
    fixture,
    task,
    claim,
    requestStore,
    stableService,
    flakyService,
    flakyHeadCalls: laterHead.headCalls,
    event: (toolUseId = "call-freshness") => ({
      protocol_version: 1,
      adapter: "codex",
      event: "pre_tool_use",
      session_id: SESSION,
      cwd: worktree,
      tool_name: "Edit",
      tool_input: { file_path: "src/file.ts", old_string: "a", new_string: "b" },
      tool_use_id: toolUseId,
    }),
  };
}

function prompt(requestId: string): unknown {
  return {
    protocol_version: 1,
    adapter: "codex",
    event: "user_prompt_submit",
    session_id: SESSION,
    prompt: `/jhw:unlock ${requestId}`,
  };
}

describe("Guard Registry freshness adapter", () => {
  it("denies an ordinary in-contract ALLOW when genuine later Registry HEAD inspection fails", async () => {
    const graph = await freshnessFixture(true);

    await expect(graph.flakyService.evaluatePreTool(graph.event())).resolves.toMatchObject({
      decision: "DENY",
      code: "GUARD_UNAVAILABLE",
    });
    expect(graph.flakyHeadCalls()).toBe(2);
    await expect(graph.requestStore.inspect()).resolves.toEqual({ status: "not_initialized", requests: [] });
  });

  it("denies before a missing-grant request can be created or reused", async () => {
    const graph = await freshnessFixture(false);

    await expect(graph.flakyService.evaluatePreTool(graph.event())).resolves.toMatchObject({
      decision: "DENY",
      code: "GUARD_UNAVAILABLE",
    });
    expect(graph.flakyHeadCalls()).toBeGreaterThanOrEqual(2);
    await expect(graph.requestStore.inspect()).resolves.toEqual({ status: "not_initialized", requests: [] });
  });

  it("denies before prompt approval and leaves the genuine pending row unchanged", async () => {
    const graph = await freshnessFixture(false);
    const requested = await graph.stableService.evaluatePreTool(graph.event());
    if (requested.decision !== "PERMIT_REQUIRED") throw new Error("expected pending Guard request");

    await expect(graph.flakyService.submitUserPrompt(prompt(requested.request_id))).resolves.toMatchObject({
      status: "DENY",
      event: "user_prompt_submit",
      code: "GUARD_UNAVAILABLE",
    });
    const inspected = await graph.requestStore.inspect();
    expect(inspected.requests).toEqual([
      expect.objectContaining({ request_id: requested.request_id, state: "PENDING" }),
    ]);
  });

  it("denies before approved permit consume/start and leaves the row approved", async () => {
    const graph = await freshnessFixture(false);
    const requested = await graph.stableService.evaluatePreTool(graph.event());
    if (requested.decision !== "PERMIT_REQUIRED") throw new Error("expected pending Guard request");
    await expect(graph.stableService.submitUserPrompt(prompt(requested.request_id)))
      .resolves.toMatchObject({ status: "APPROVED" });

    await expect(graph.flakyService.evaluatePreTool(graph.event("call-consume"))).resolves.toMatchObject({
      decision: "DENY",
      code: "GUARD_UNAVAILABLE",
    });
    const inspected = await graph.requestStore.inspect();
    expect(inspected.requests).toEqual([
      expect.objectContaining({ request_id: requested.request_id, state: "APPROVED" }),
    ]);
  });

  it("still completes an exact consumed correlation after Registry and Claim freshness changes", async () => {
    const graph = await freshnessFixture(false);
    const requested = await graph.stableService.evaluatePreTool(graph.event());
    if (requested.decision !== "PERMIT_REQUIRED") throw new Error("expected pending Guard request");
    await graph.stableService.submitUserPrompt(prompt(requested.request_id));
    await expect(graph.stableService.evaluatePreTool(graph.event("call-complete")))
      .resolves.toMatchObject({ decision: "ALLOW", consumed_request_id: requested.request_id });
    await commitFile(graph.fixture.registryDir, "governance/moved-after-consume.json", "{}\n");

    const completionOnly = new GuardService({
      host: HOST,
      digest_key: Buffer.alloc(32, 0x53),
      claims: {
        resolveSessionClaim: async () => { throw new Error("Claim changed after effect"); },
        listActiveClaims: async () => { throw new Error("Claim changed after effect"); },
      },
      tasks: {
        getTask: async () => { throw new Error("must not reauthorize completion"); },
        inspectForGuard: async () => { throw new Error("must not reauthorize completion"); },
        sourceRevisionForGuard: async () => { throw new Error("must not reauthorize completion"); },
      },
      authority: { assertKnownRequirement: async () => { throw new Error("must not reauthorize completion"); } },
      registry_view: {
        withCommittedView: async () => { throw new Error("must not inspect Registry completion freshness"); },
        committedViewIsStale: async () => { throw new Error("must not inspect Registry completion freshness"); },
      },
      registry_mutation_barrier: registryBarrier(configFor(graph.fixture.registryDir)),
      guard_request_store: graph.requestStore,
      mode: "enforce",
    } satisfies GuardServiceOptions);

    await expect(completionOnly.completePostTool({
      protocol_version: 1,
      adapter: "codex",
      event: "post_tool_use",
      session_id: SESSION,
      tool_use_id: "call-complete",
      ok: true,
    })).resolves.toMatchObject({
      status: "COMPLETED",
      request_id: requested.request_id,
      task_id: graph.task.id,
      claim_id: graph.claim.claim_id,
    });
  });
});
