# Task Recovery Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve an existing formal Task and its active/inactive recovery state from an exact checkout root and verified GitHub Issue URL without registration, implicit takeover, or host contract changes.

**Architecture:** Extend the existing `task recover --action status` command with a mutually exclusive checkout-discovery mode. `GitHubSourceService` verifies checkout and Issue identity, `Catalog` pins the canonical Issue source lookup, and `TaskService` returns a privacy-bounded active snapshot or exact-latest-generation Handoff availability.

**Tech Stack:** TypeScript 5.5, Node.js ESM, Zod, Vitest, Git-backed Registry, GitHub CLI source verification, Bash/Node skill contract tests

**Spec:** `docs/superpowers/specs/2026-08-29-task-recovery-discovery-design.md`

## Global Constraints

- Keep the installed launcher contract exact v4 and `credential_policy: secure-store-only`.
- Add no new public command; discovery is only `task recover --action status`.
- Require exactly `--resolve-from-checkout true`, `--repo-path`, and `--issue-url` in discovery mode.
- Never combine discovery fields with `--task`, `--expect`, `--session`, `--origin-adapter`, or a mutating recovery action.
- Discovery must not call Task registration, source refresh, contract migration, takeover, force-end, cleanup, or any Registry mutation.
- Active output exposes only `task_id` plus the six `ConflictingClaimSummarySchema` fields and `process_exists`, `worktree_mapped`, `dirty`, `ahead`.
- Never emit `session_id`, absolute host paths, credentials, Work Contract contents, or raw error messages.
- An inactive result may return Handoff content only from the exact latest Claim generation.
- A newer force-ended or other non-Handoff generation makes `handoff.available` exactly `false`; an older Handoff is never substituted.
- Takeover and force-end retain their separate, immediate user-approval gate.
- Run `npm run typecheck`, `npm run build`, `npm test`, skill sync, Task skill contract, and install safety before completion.

## File Map

- Modify `mcp-server/src/control/catalog.ts`: add clean, pinned formal-Task lookup by GitHub Issue node ID.
- Modify `mcp-server/src/control/github-source.ts`: add verified checkout/Issue resolution for an existing formal Task.
- Modify `mcp-server/src/control/task-service.ts`: add exact-generation resume context and bounded recovery discovery.
- Modify `mcp-server/src/control/cli.ts`: validate the two recovery coordinate modes and project discovery output.
- Modify `mcp-server/src/control/__tests__/catalog.test.ts`: pinning, dirty/moved Registry, missing-source coverage.
- Modify `mcp-server/src/control/__tests__/github-source.test.ts`: checkout/Issue/source binding and no-mutation coverage.
- Modify `mcp-server/src/control/__tests__/task-service.test.ts`: active privacy and exact-latest Handoff coverage.
- Modify `mcp-server/src/control/__tests__/cli.test.ts`: flag matrix, output schema, 12 KiB, and lock behavior.
- Modify `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`: normal handoff, inactive resume, abnormal active Claim, takeover, and force-end scenarios.
- Modify `skills/claude/task.md`: canonical discovery and approval workflow.
- Modify `scripts/test-task-skill-contract.mjs`: executable discovery argv and stop-condition contract.
- Regenerate `skills/codex/jhw-task/SKILL.md` only through `scripts/sync-codex-skills.mjs` if its generated description changes.
- Modify `README.md` and `docs/project-control/phase1a-runbook.md`: public recovery examples and interpretation.
- Do not modify `install.sh` or the host v4 expected command list.

---

### Task 1: Add a clean pinned formal-Task source lookup

**Files:**
- Modify: `mcp-server/src/control/catalog.ts:30-55, 743-850`
- Test: `mcp-server/src/control/__tests__/catalog.test.ts:1-50` and the Catalog source-index tests

**Interfaces:**
- Consumes: `sourceIndexKey(githubNodeId)`, `FormalTask`, `RegistryGit.assertReady()`, `RegistryGit.withCommittedTree()`.
- Produces:

```typescript
withPinnedFormalTaskByGitHubNode<T>(
  githubNodeId: string,
  use: (task: FormalTask) => Promise<T>,
): Promise<T>
```

- [ ] **Step 1: Write failing Catalog tests**

Import `FormalTask` in the test, add a concrete `Catalog` surface assertion, and write the focused behavior tests. Keep the `SourceCatalogPort` change for Task 2 so this task can pass typecheck independently. The callback result proves the method does not merely return an unpinned record.

```typescript
type CatalogPinnedFormalTaskContract = Assert<Catalog extends {
  withPinnedFormalTaskByGitHubNode<T>(
    githubNodeId: string,
    use: (task: FormalTask) => Promise<T>,
  ): Promise<T>;
} ? true : false>;

it("resolves one formal Task from its Issue source without changing Registry HEAD", async () => {
  const { catalog, fixture } = await catalogFixture();
  await catalog.registerRepository(repositoryInput);
  const formal = (await catalog.registerFormalTask(issueInput)).task;
  const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

  const selected = await catalog.withPinnedFormalTaskByGitHubNode(
    issueInput.issue_node_id,
    async (task) => ({ id: task.id, kind: task.kind }),
  );

  expect(selected).toEqual({ id: formal.id, kind: "formal" });
  expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
});

it("fails closed when the verified Issue source is not registered", async () => {
  const { catalog } = await catalogFixture();
  await catalog.registerRepository(repositoryInput);

  await expect(catalog.withPinnedFormalTaskByGitHubNode(
    "I_unregistered",
    async (task) => task.id,
  )).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
});

it("rejects a dirty Registry before invoking the formal Task callback", async () => {
  const { catalog, fixture } = await catalogFixture();
  await catalog.registerRepository(repositoryInput);
  await catalog.registerFormalTask(issueInput);
  await writeFile(join(fixture.registryDir, "dirty-untracked"), "dirty\n", "utf8");
  const use = vi.fn(async (task: FormalTask) => task.id);

  await expect(catalog.withPinnedFormalTaskByGitHubNode(
    issueInput.issue_node_id,
    use,
  )).rejects.toMatchObject({ code: "REGISTRY_DIRTY" });
  expect(use).not.toHaveBeenCalled();
});
```

Add malformed, reverse-mismatched, and duplicate source-index cases. Commit and push each corrupt fixture before lookup so `assertReady()` reaches the audit and the cases end with `REGISTRY_CORRUPT`, not `REMOTE_DIVERGED`. Add a final-fence test whose callback uses the existing `commitFile` helper in the Registry checkout to move local HEAD; expect `REGISTRY_MOVED_DURING_READ` and discard the callback result. Also mirror the existing pinned-Repository test that preserves a callback exception even if that callback moves HEAD.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/catalog.test.ts
```

Expected: TypeScript/Vitest failure because `withPinnedFormalTaskByGitHubNode` does not exist.

- [ ] **Step 3: Implement the minimal pinned lookup**

Reuse the existing `FormalTask` type import and add this method next to `withPinnedRepositoryByGitHubNode`:

```typescript
async withPinnedFormalTaskByGitHubNode<T>(
  githubNodeId: string,
  use: (task: FormalTask) => Promise<T>,
): Promise<T> {
  const parsed = githubNodeIdSchema.safeParse(githubNodeId);
  if (!parsed.success) {
    throw new ControlError("INVALID_ISSUE_ID", "GitHub Issue node ID is invalid");
  }
  await this.registry.assertReady();
  return this.registry.withCommittedTree(["tasks", "repositories"], async () => {
    await this.auditTaskSourceIndexesWithin();
    const sourcePath = taskSourceRelativePath(parsed.data);
    const indexed = await this.formalTaskForSource(sourcePath, parsed.data);
    if (!indexed) {
      throw new ControlError("TASK_NOT_FOUND", "Verified Issue has no canonical Task");
    }
    this.sensitiveData.assertSafe(indexed.task);
    const result = await use(indexed.task);
    await this.registry.assertCommittedViewCurrent();
    return result;
  });
}
```

Do not call `registerFormalTask`, write a source index, or accept aliases as lookup keys.

- [ ] **Step 4: Run Catalog tests and typecheck**

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/catalog.test.ts
rtk npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit Task 1**

```bash
rtk git add mcp-server/src/control/catalog.ts mcp-server/src/control/__tests__/catalog.test.ts
rtk git commit -m "feat(control): resolve pinned formal task sources"
```

---

### Task 2: Verify checkout and Issue identity without registration

**Files:**
- Modify: `mcp-server/src/control/github-source.ts:1-140, 230-390`
- Test: `mcp-server/src/control/__tests__/github-source.test.ts:1-140` and resolved-source tests

**Interfaces:**
- Consumes: Task 1's `withPinnedFormalTaskByGitHubNode` and existing `requireContext`/`resolveIssue` verification.
- Produces:

```typescript
export interface ExistingFormalTaskResolution {
  task: FormalTask;
  alias: string;
}

withResolvedExistingFormalTask<T>(
  input: { repository_path: string; issue_url: string },
  use: (resolved: ExistingFormalTaskResolution) => Promise<T>,
): Promise<T>
```

- [ ] **Step 1: Extend the source fixture and write failing tests**

Add `withPinnedFormalTaskByGitHubNode` to `SourceCatalogPort` and the fake catalog, record its calls, and add a compile-time port assertion. Cover success, cross-repository rejection, ambiguous Project association, canonical source mismatch, and callback fence propagation.

```typescript
it("resolves an existing formal Task from the exact checkout and verified Issue", async () => {
  const { service, catalog, pinnedFormalTaskLookup } = fixture();
  const selected = await service.withResolvedExistingFormalTask({
    repository_path: checkout,
    issue_url: "https://github.com/jhw7500/wlan/issues/7",
  }, async ({ task, alias }) => ({ task_id: task.id, alias }));

  expect(selected).toEqual({
    task_id: formal.id,
    alias: "jhw7500/wlan#7",
  });
  expect(pinnedFormalTaskLookup).toHaveBeenCalledWith("I_wlan_7");
  expect(catalog.registerFormalTask).not.toHaveBeenCalled();
  expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
});

it("rejects a cross-repository Issue before formal Task lookup", async () => {
  const { service, pinnedFormalTaskLookup } = fixture();

  await expect(service.withResolvedExistingFormalTask({
    repository_path: checkout,
    issue_url: "https://github.com/jhw7500/other/issues/7",
  }, async ({ task }) => task.id)).rejects.toMatchObject({
    code: "ISSUE_REPOSITORY_MISMATCH",
  });
  expect(pinnedFormalTaskLookup).not.toHaveBeenCalled();
});

it("rejects an ambiguous Project association before formal Task lookup", async () => {
  const { service, projects, pinnedFormalTaskLookup } = fixture();
  projects.resolveUniqueProjectForRepository.mockRejectedValueOnce(
    new ControlError("PROJECT_REPOSITORY_AMBIGUOUS", "injected ambiguity"),
  );

  await expect(service.withResolvedExistingFormalTask({
    repository_path: checkout,
    issue_url: "https://github.com/jhw7500/wlan/issues/7",
  }, async ({ task }) => task.id)).rejects.toMatchObject({
    code: "PROJECT_REPOSITORY_AMBIGUOUS",
  });
  expect(pinnedFormalTaskLookup).not.toHaveBeenCalled();
});

it("rejects a Task whose stored source disagrees with the verified context", async () => {
  const { service } = fixture({
    formalTask: { ...formal, project_id: "prj-other" },
  });

  await expect(service.withResolvedExistingFormalTask({
    repository_path: checkout,
    issue_url: "https://github.com/jhw7500/wlan/issues/7",
  }, async ({ task }) => task.id)).rejects.toMatchObject({
    code: "FORMAL_TASK_SOURCE_MISMATCH",
  });
});
```

Also assert that a newer live `issue_revision` does not invoke registration or change the returned stored Task record.

- [ ] **Step 2: Run the source test and confirm RED**

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/github-source.test.ts
```

Expected: failure because the new source method and port are absent.

- [ ] **Step 3: Implement the verified existing-Task resolver**

Add the Task 1 method to `SourceCatalogPort`. Implement:

```typescript
async withResolvedExistingFormalTask<T>(
  input: { repository_path: string; issue_url: string },
  use: (resolved: ExistingFormalTaskResolution) => Promise<T>,
): Promise<T> {
  issueCoordinates(input.issue_url);
  this.assertCheckoutSafe({ issue_url: input.issue_url }, input.repository_path);
  const context = await this.requireContext(
    { resolve_from_checkout: true },
    input.repository_path,
  );
  const issue = await this.resolveIssue(context.repository, input.issue_url);
  this.assertCheckoutSafe(issue, input.repository_path);
  return this.options.catalog.withPinnedFormalTaskByGitHubNode(
    issue.issue_node_id,
    async (task) => {
      if (
        task.project_id !== context.project_id ||
        task.repo_id !== context.repo_id ||
        task.issue_node_id !== issue.issue_node_id ||
        task.issue_url !== issue.issue_url ||
        !task.aliases.includes(issue.alias)
      ) {
        throw new ControlError(
          "FORMAL_TASK_SOURCE_MISMATCH",
          "Verified Issue and canonical Task source disagree",
        );
      }
      const resolved = { task, alias: issue.alias };
      this.assertCheckoutSafe(resolved, input.repository_path);
      return use(resolved);
    },
  );
}
```

Do not reject a closed Issue during discovery; this read-only path must still locate an active Claim for safe recovery. Existing `task start --task` remains responsible for refusing a closed Issue resume.

- [ ] **Step 4: Run source tests and typecheck**

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/github-source.test.ts
rtk npm run typecheck
```

Expected: both pass and no registration mock is called by discovery.

- [ ] **Step 5: Commit Task 2**

```bash
rtk git add mcp-server/src/control/github-source.ts mcp-server/src/control/__tests__/github-source.test.ts
rtk git commit -m "feat(control): verify existing task recovery sources"
```

---

### Task 3: Build a privacy-bounded exact-generation recovery snapshot

**Files:**
- Modify: `mcp-server/src/control/task-service.ts:1-165, 500-560`
- Test: `mcp-server/src/control/__tests__/task-service.test.ts:1-150` and Handoff/recovery tests

**Interfaces:**
- Consumes: `ClaimServicePort.getActive`, `recoverClaim`, `latestClaimHistory`, and exact `handoff(taskId, claimId)`.
- Produces:

```typescript
export type TaskResumeContext =
  | { available: false }
  | { available: true; handoff: TaskHandoffResult };

export type TaskRecoveryDiscovery =
  | {
      state: "inactive";
      handoff: TaskResumeContext;
    }
  | {
      state: "active";
      claim: ConflictingClaimSummary;
      recovery: {
        process_exists: boolean;
        worktree_mapped: boolean;
        dirty: boolean;
        ahead: number;
      };
    };

resumeContext(taskId: string): Promise<TaskResumeContext>
recoveryDiscovery(taskId: string): Promise<TaskRecoveryDiscovery>
```

- [ ] **Step 1: Write failing TaskService tests**

```typescript
it("reports inactive with no Handoff when Claim history is absent", async () => {
  const { tasks } = await taskFixture();
  await expect(tasks.recoveryDiscovery(TASK_ID)).resolves.toEqual({
    state: "inactive",
    handoff: { available: false },
  });
});

it("uses only the exact latest Handoff generation as resume context", async () => {
  const { tasks, claims, fixture } = await taskFixture();
  const handoffPath = "handoffs/" + TASK_ID + "/" + CLAIM_ID + ".md";
  await mkdir(join(fixture.registryDir, "handoffs", TASK_ID), { recursive: true });
  await writeFile(join(fixture.registryDir, handoffPath), buildHandoff({
    task_id: TASK_ID,
    claim_id: CLAIM_ID,
    source_task_revision: activeClaim.source_task_revision,
    generated_at: "2026-08-13T12:36:56.789Z",
    progress: "resume this exact generation",
  }), "utf8");
  claims.latestClaimHistory.mockResolvedValue({
    ...activeClaim,
    released_at: "2026-08-13T12:36:56.789Z",
    status: "handoff",
    handoff_path: handoffPath,
  });
  claims.getClaimHistory.mockResolvedValue({
    ...activeClaim,
    released_at: "2026-08-13T12:36:56.789Z",
    status: "handoff",
    handoff_path: handoffPath,
  });

  await expect(tasks.resumeContext(TASK_ID)).resolves.toMatchObject({
    available: true,
    handoff: {
      claim_id: CLAIM_ID,
      sections: { "Progress Since Last Checkpoint": "resume this exact generation" },
    },
  });
  expect(claims.latestHandoffHistory).not.toHaveBeenCalled();
});

it("does not substitute an older Handoff after a newer force-end", async () => {
  const { tasks, claims } = await taskFixture();
  claims.latestClaimHistory.mockResolvedValue({
    ...activeClaim,
    released_at: "2026-08-13T12:40:00.000Z",
    status: "force-ended",
  });

  await expect(tasks.resumeContext(TASK_ID)).resolves.toEqual({ available: false });
  expect(claims.latestHandoffHistory).not.toHaveBeenCalled();
  expect(claims.getClaimHistory).not.toHaveBeenCalled();
});

it("strips session identity from active discovery", async () => {
  const { tasks, claims } = await taskFixture();
  claims.getActive.mockResolvedValue(activeClaim);
  claims.recoverClaim.mockResolvedValue({
    kind: "status",
    active: activeClaim,
    recorded: { host: activeClaim.host, session_id: activeClaim.session_id },
    process_exists: false,
    worktree_mapped: true,
    dirty: false,
    ahead: 0,
  });

  const discovered = await tasks.recoveryDiscovery(TASK_ID);
  expect(discovered).toEqual({
    state: "active",
    claim: {
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      host: activeClaim.host,
      branch: activeClaim.branch,
      worktree_ref: activeClaim.worktree_ref,
      started_at: activeClaim.started_at,
    },
    recovery: {
      process_exists: false,
      worktree_mapped: true,
      dirty: false,
      ahead: 0,
    },
  });
  expect(JSON.stringify(discovered)).not.toContain(activeClaim.session_id);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/task-service.test.ts
```

Expected: failure because `resumeContext` and `recoveryDiscovery` are missing.

- [ ] **Step 3: Implement exact resume context**

```typescript
async resumeContext(taskId: string): Promise<TaskResumeContext> {
  let latest: ClaimHistory;
  try {
    latest = await this.claims.latestClaimHistory(taskId);
  } catch (cause) {
    if (cause instanceof ControlError && cause.code === "CLAIM_HISTORY_NOT_FOUND") {
      return { available: false };
    }
    throw cause;
  }
  if (latest.status !== "handoff" || !latest.handoff_path) {
    return { available: false };
  }
  return {
    available: true,
    handoff: await this.handoff(taskId, latest.claim_id),
  };
}
```

- [ ] **Step 4: Implement bounded active/inactive discovery**

Import `ConflictingClaimSummarySchema` and its inferred type. Project the active record before returning:

```typescript
async recoveryDiscovery(taskId: string): Promise<TaskRecoveryDiscovery> {
  const active = await this.claims.getActive(taskId);
  if (!active) {
    return { state: "inactive", handoff: await this.resumeContext(taskId) };
  }
  const status = await this.claims.recoverClaim(
    taskId,
    active.claim_id,
    { kind: "status" },
  );
  if (status.kind !== "status") {
    throw new ControlError(
      "INVALID_RECOVERY_RESULT",
      "Recovery discovery did not return status",
    );
  }
  const claim = ConflictingClaimSummarySchema.parse({
    task_id: active.task_id,
    claim_id: active.claim_id,
    host: active.host,
    branch: active.branch,
    worktree_ref: active.worktree_ref,
    started_at: active.started_at,
  });
  return {
    state: "active",
    claim,
    recovery: {
      process_exists: status.process_exists,
      worktree_mapped: status.worktree_mapped,
      dirty: status.dirty,
      ahead: status.ahead,
    },
  };
}
```

- [ ] **Step 5: Run TaskService tests and typecheck**

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/task-service.test.ts
rtk npm run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit Task 3**

```bash
rtk git add mcp-server/src/control/task-service.ts mcp-server/src/control/__tests__/task-service.test.ts
rtk git commit -m "feat(control): expose bounded recovery discovery"
```

---

### Task 4: Wire checkout discovery into `task recover --action status`

**Files:**
- Modify: `mcp-server/src/control/cli.ts:156-240, 1180-1320, 1510-1565`
- Test: `mcp-server/src/control/__tests__/cli.test.ts:180-330, 760-860, 1880-1960`

**Interfaces:**
- Consumes: Task 2's `withResolvedExistingFormalTask` and Task 3's `recoveryDiscovery`/`resumeContext`.
- Produces: the spec's `kind: "resolved"` active/inactive JSON while preserving all existing exact recovery results.

- [ ] **Step 1: Extend the CLI ports/fakes and write the discovery flag matrix**

Add `resumeContext` and `recoveryDiscovery` to the `taskService` `Pick`, add `withResolvedExistingFormalTask` to the `source` `Pick`, and add all three methods to `makeCliDependencies`. Then add tests for the only valid discovery argv and every forbidden mixture.

```typescript
function recoveryDiscoveryArgs(): string[] {
  return [
    "task", "recover",
    "--action", "status",
    "--resolve-from-checkout", "true",
    "--repo-path", "/private/source/control",
    "--issue-url", "https://github.com/example/control/issues/1",
  ];
}

it.each([
  ["false resolver", ["--resolve-from-checkout", "false"]],
  ["missing Issue", ["--issue-url", undefined]],
  ["exact Task mixed in", ["--task", TASK_ID]],
  ["exact Claim mixed in", ["--expect", CLAIM_ID]],
  ["session mixed in", ["--session", "private-session"]],
  ["adapter mixed in", ["--origin-adapter", "codex"]],
  ["takeover action", ["--action", "takeover"]],
] as const)("rejects discovery mode with %s before calling source or Task ports", async (_name, mutation) => {
  const dependencies = makeCliDependencies();
  const argv = recoveryDiscoveryArgs();
  const index = argv.indexOf(mutation[0]);
  if (mutation[1] === undefined) {
    argv.splice(index, 2);
  } else if (index >= 0) {
    argv[index + 1] = mutation[1];
  } else {
    argv.push(mutation[0], mutation[1]);
  }

  const result = await runCli(argv, dependencies);
  expect(result.exitCode).toBe(2);
  expect(dependencies.source.withResolvedExistingFormalTask).not.toHaveBeenCalled();
  expect(dependencies.taskService.recoveryDiscovery).not.toHaveBeenCalled();
});
```

Use separate cases for a missing resolver/root so the test never relies on tuple mutation ambiguity.

- [ ] **Step 2: Write active, inactive, Handoff-bound, and privacy tests**

```typescript
it("returns the bounded active recovery snapshot without a mutation lock", async () => {
  const dependencies = makeCliDependencies({
    taskService: {
      recoveryDiscovery: vi.fn().mockResolvedValue({
        state: "active",
        claim: conflictingClaim,
        recovery: {
          process_exists: false,
          worktree_mapped: true,
          dirty: false,
          ahead: 0,
        },
      }),
    },
  });

  const result = await runCli(recoveryDiscoveryArgs(), dependencies);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    command: "task recover",
    result: {
      kind: "resolved",
      task_id: TASK_ID,
      state: "active",
      claim: conflictingClaim,
      recovery: {
        process_exists: false,
        worktree_mapped: true,
        dirty: false,
        ahead: 0,
      },
    },
  });
  expect(dependencies.mutationLock.run).not.toHaveBeenCalled();
  expect(result.stdout).not.toContain("private-session");
  expect(result.stdout).not.toContain("/private/source/control");
});

it("returns explicit inactive Handoff absence", async () => {
  const dependencies = makeCliDependencies({
    taskService: {
      recoveryDiscovery: vi.fn().mockResolvedValue({
        state: "inactive",
        handoff: { available: false },
      }),
    },
  });

  const result = await runCli(recoveryDiscoveryArgs(), dependencies);
  expect(JSON.parse(result.stdout).result).toEqual({
    kind: "resolved",
    task_id: TASK_ID,
    state: "inactive",
    handoff: { available: false },
  });
});
```

Add an escaped-section test using the existing large Handoff fixture and assert the complete envelope remains at most 12 KiB.

- [ ] **Step 3: Confirm CLI tests are RED**

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/cli.test.ts
```

Expected: missing dependency methods and rejected discovery flags.

- [ ] **Step 4: Implement mutually exclusive recovery modes**

Expand the allowed recover flags to include `--resolve-from-checkout`, `--repo-path`, and `--issue-url`. Before the exact recovery branch:

```typescript
const discoveryNames = [
  "--resolve-from-checkout",
  "--repo-path",
  "--issue-url",
] as const;
const discoveryCount = discoveryNames.filter((name) => flags.has(name)).length;
if (discoveryCount > 0) {
  if (
    actionName !== "status" ||
    discoveryCount !== discoveryNames.length ||
    value(flags, "--resolve-from-checkout") !== "true" ||
    flags.has("--task") ||
    flags.has("--expect") ||
    flags.has("--session") ||
    flags.has("--origin-adapter")
  ) {
    usage("Recovery discovery requires only checkout, Issue, and status");
  }
  const repository_path = required(flags, "--repo-path");
  if (!repository_path.startsWith("/")) {
    usage("Repository path must be absolute");
  }
  const discovered = await dependencies.source.withResolvedExistingFormalTask({
    repository_path,
    issue_url: required(flags, "--issue-url"),
  }, async ({ task }) => ({
    task_id: task.id,
    snapshot: await dependencies.taskService.recoveryDiscovery(task.id),
  }));
  if (discovered.snapshot.state === "active") {
    return {
      flags,
      result: resultJson(command, {
        kind: "resolved",
        task_id: discovered.task_id,
        state: "active",
        claim: discovered.snapshot.claim,
        recovery: discovered.snapshot.recovery,
      }),
    };
  }
  if (!discovered.snapshot.handoff.available) {
    return {
      flags,
      result: resultJson(command, {
        kind: "resolved",
        task_id: discovered.task_id,
        state: "inactive",
        handoff: { available: false },
      }),
    };
  }
  return {
    flags,
    result: boundedHandoffResult(
      command,
      discovered.snapshot.handoff.handoff,
      (handoff) => ({
        kind: "resolved",
        task_id: discovered.task_id,
        state: "inactive",
        handoff: {
          available: true,
          claim_id: handoff.claim_id,
          handoff_pointer: handoff.handoff_pointer,
          generated_at: handoff.generated_at,
          sections: handoff.sections,
          truncated: handoff.truncated,
        },
      }),
    ),
  };
}
```

Keep the existing `--task/--expect` action handling byte-for-byte after this branch. Do not spread the internal Handoff object: nested `task_id` and `source_task_revision` are intentionally outside the public discovery result contract.

- [ ] **Step 5: Make existing Task start use exact resume context**

Replace the pre-start `taskService.handoff(task.id)` lookup with:

```typescript
let latestHandoff: TaskHandoffResult | undefined;
if (hasExisting) {
  const context = await dependencies.taskService.resumeContext(task.id);
  if (context.available) latestHandoff = context.handoff;
}
```

Do not change explicit `task handoff --task` semantics; it remains the operator's historical latest-Handoff query.

- [ ] **Step 6: Run CLI, TaskService, and type gates**

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/cli.test.ts src/control/__tests__/task-service.test.ts
rtk npm run typecheck
rtk npm run build
```

Expected: all pass, discovery status does not acquire the mutation lock, and existing exact recovery tests remain unchanged.

- [ ] **Step 7: Commit Task 4**

```bash
rtk git add mcp-server/src/control/cli.ts mcp-server/src/control/__tests__/cli.test.ts
rtk git commit -m "feat(control): discover task recovery from checkout"
```

---

### Task 5: Prove the lifecycle scenarios end to end

**Files:**
- Modify: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts:60-280` and lifecycle cases near the existing explicit-resume test

**Interfaces:**
- Consumes: Tasks 1-4 through real `Catalog`, `GitHubSourceService`, `ClaimService`, `TaskService`, and `runCli`.
- Produces: executable acceptance evidence for normal handoff, abnormal active Claim, inactive resume, takeover, and force-end absence.

- [ ] **Step 1: Add a real discovery source to the E2E dependency graph**

Configure the source repository with the canonical fake GitHub origin and construct the source service with the existing fake runners:

```typescript
await git(
  fixture.sourceRepo,
  "remote",
  "add",
  "origin",
  "git@github.com:jhw7500/control.git",
);
const sourceRunner = new GateSourceRunner();
const source = new GitHubSourceService({
  runner: sourceRunner,
  catalog: graph.catalog,
  projects: {
    requireProjectRepository: async () => undefined,
    resolveUniqueProjectForRepository: async () => ({
      project_id: "prj-control",
      source_revision: "2026-08-29T00:00:00Z",
    }),
  },
});
const dependencies = cliDependencies(graph, { source });
```

If `Partial<CliDependencies>` cannot accept the concrete source because of its narrower fixture type, update `cliDependencies` to accept `Partial<CliDependencies>` without reconstructing or widening runtime output.

- [ ] **Step 2: Write the normal handoff and inactive-resume scenario**

Register the Repository and formal Task, start it, finish with Handoff, discover from checkout/Issue, and resume by the resolved Task ID:

```typescript
const discovered = await runCli([
  "task", "recover",
  "--action", "status",
  "--resolve-from-checkout", "true",
  "--repo-path", fixture.sourceRepo,
  "--issue-url", issueInput.issue_url,
], dependencies);
expect(JSON.parse(discovered.stdout).result).toMatchObject({
  task_id: formal.id,
  state: "inactive",
  handoff: {
    available: true,
    claim_id: firstClaimId,
  },
});

const resumed = await runCli([
  "task", "start",
  "--task", formal.id,
  "--repo-path", fixture.sourceRepo,
  "--origin-adapter", "codex",
  "--session", "codex-resumed",
], dependencies);
expect(resumed.exitCode).toBe(0);
expect(JSON.parse(resumed.stdout).result.latest_handoff.claim_id).toBe(firstClaimId);
```

- [ ] **Step 3: Write abnormal-active and approved-takeover coverage**

While the resumed Claim is active, discovery must return `process_exists: false` without calling takeover. Then invoke the existing exact takeover only as a separate test action, capture its new Claim ID, and verify:

```typescript
const takeover = await runCli([
  "task", "recover",
  "--task", formal.id,
  "--expect", resumedClaimId,
  "--action", "takeover",
  "--origin-adapter", "codex",
  "--session", "codex-takeover",
], dependencies);
const replacementClaimId = JSON.parse(takeover.stdout).result.active.claim_id;
expect(replacementClaimId).not.toBe(resumedClaimId);

const status = await runCli([
  "task", "status",
  "--task", formal.id,
  "--claim", replacementClaimId,
], dependencies);
expect(status.exitCode).toBe(0);
expect(JSON.parse(status.stdout).result.claim.claim_id).toBe(replacementClaimId);
```

Assert the discovery result never contains `codex-resumed`, `codex-takeover`, or `fixture.sourceRepo`.

- [ ] **Step 4: Write force-end exact-generation absence coverage**

Force-end the replacement Claim. Re-run discovery and assert:

```typescript
expect(JSON.parse(afterForceEnd.stdout).result).toEqual({
  kind: "resolved",
  task_id: formal.id,
  state: "inactive",
  handoff: { available: false },
});
```

This scenario must retain the earlier Handoff in Registry so the assertion proves it was ignored because a newer force-ended generation exists.

- [ ] **Step 5: Run E2E and the focused control suites**

```bash
cd mcp-server
rtk npm test -- src/control/__tests__/phase1a.e2e.test.ts
rtk npm test -- src/control/__tests__/catalog.test.ts src/control/__tests__/github-source.test.ts src/control/__tests__/task-service.test.ts src/control/__tests__/cli.test.ts
```

Expected: all scenarios pass without network access beyond fixture remotes.

- [ ] **Step 6: Commit Task 5**

```bash
rtk git add mcp-server/src/control/__tests__/phase1a.e2e.test.ts
rtk git commit -m "test(control): cover task recovery discovery lifecycle"
```

---

### Task 6: Publish the operator workflow and run every gate

**Files:**
- Modify: `skills/claude/task.md:160-215, 405-455`
- Modify: `scripts/test-task-skill-contract.mjs`
- Modify: `README.md:120-135`
- Modify: `docs/project-control/phase1a-runbook.md:260-330`
- Regenerate if changed: `skills/codex/jhw-task/SKILL.md`

**Interfaces:**
- Consumes: the public result discriminants `state: active|inactive` and `handoff.available`.
- Produces: one canonical agent workflow that never guesses Task IDs or performs automatic takeover.

- [ ] **Step 1: Make the skill contract test fail on missing discovery workflow**

Add a required lifecycle block reader and expected argv:

```javascript
const discoveryArgs = [
  "task", "recover",
  "--action", "status",
  "--resolve-from-checkout", "true",
  "--repo-path", checkoutRoot,
  "--issue-url", issueUrl,
];
assert.ok(
  taskMarkdown.includes("<!-- task-lifecycle-contract: recovery-discovery:begin -->"),
  "task skill must expose executable recovery discovery",
);
```

Extend the fake launcher to accept exact `task recover` discovery argv, emit separately configurable active/inactive envelopes, and reject every other recovery argv. Add assertions that:

- inactive runs `task start --task <resolved-id>` without registration flags;
- active stops after displaying the six Claim fields;
- `TASK_CONTRACT_MISMATCH` routes to discovery;
- `TASK_ALREADY_CLAIMED` routes to exact status and never takeover;
- no raw `jhw-control task` invocation occurs.

- [ ] **Step 2: Run the contract test and confirm RED**

```bash
rtk node scripts/test-task-skill-contract.mjs
```

Expected: failure because the canonical discovery block and interpretation are absent.

- [ ] **Step 3: Add the canonical skill workflow**

Insert this executable block after “기존 Task 재개” and reference it from recovery/error interpretation:

```markdown
<!-- task-lifecycle-contract: recovery-discovery:begin -->
```bash
"$HOME/.local/bin/jhw-control-host" task recover \
  --action status \
  --resolve-from-checkout true \
  --repo-path "$REPOSITORY_PATH" \
  --issue-url "$JHW_TARGET_ISSUE_URL"
```
<!-- task-lifecycle-contract: recovery-discovery:end -->
```

Document these exact branches:

- `inactive`: use the returned `task_id` in the existing resume block and send no registration fields;
- `active`: show only the six Claim coordinates plus recovery observations, then stop for separate approval;
- `handoff.available: false`: state explicitly that the exact latest generation has no Handoff;
- `process_exists: false`: never call it stale;
- takeover success: use only the new Claim ID for `task status`;
- `TASK_CONTRACT_MISMATCH`: run discovery instead of repeating formal registration;
- `TASK_ALREADY_CLAIMED`: inspect the returned exact coordinates, never auto-takeover.

- [ ] **Step 4: Update README and runbook without changing the host contract**

Add the discovery invocation and two result branches to README's Project Control section and the runbook recovery section. Preserve the exact v4 command list; do not add `task resolve`.

- [ ] **Step 5: Regenerate and verify Codex skills**

```bash
rtk node scripts/sync-codex-skills.mjs
rtk node scripts/sync-codex-skills.mjs --check
rtk node scripts/test-task-skill-contract.mjs
```

Expected: all pass and `skills/codex/jhw-task/references/task.md` remains a symlink to the canonical Claude document.

- [ ] **Step 6: Run the complete repository validation**

```bash
cd mcp-server
rtk npm run typecheck
rtk npm run build
rtk npm test
cd ..
rtk node scripts/sync-codex-skills.mjs --check
rtk node scripts/test-task-skill-contract.mjs
rtk bash scripts/test-install-safety.sh
rtk git diff --check
```

Expected: typecheck/build pass, the complete Vitest count passes, both skill checks pass, install safety passes, and `git diff --check` is silent.

- [ ] **Step 7: Commit Task 6**

```bash
rtk git add skills/claude/task.md skills/codex/jhw-task/SKILL.md scripts/test-task-skill-contract.mjs README.md docs/project-control/phase1a-runbook.md
rtk git commit -m "docs(task): guide checkout recovery discovery"
```

If `skills/codex/jhw-task/SKILL.md` is byte-identical after sync, omit it from `git add` rather than forcing a change.

---

## Review, Merge, and Deployment Checklist

- [ ] Re-run `jhw-control-host task status` for the exact Task/Claim and confirm the Task worktree is clean except for planned commits.
- [ ] Run the complete Task 6 validation again after the final commit; record exact test counts and command results.
- [ ] Run a comprehensive code review against the spec, fix every blocking finding with a focused test, and re-run affected plus full gates.
- [ ] Run `jhw-control-host task assert-owner` immediately before push.
- [ ] Push only `task/7aaadeb378fd-jhw7500-jhw-notion-86` and open the Issue #86 PR against `main`.
- [ ] Wait for configured review channels; merge only when all required reviews are clean and the branch is current with `origin/main`.
- [ ] In the permanent runtime checkout, fast-forward `main` and run `install.sh`; never install from the disposable Task worktree.
- [ ] Verify `jhw-control-host --contract` remains exact v4.
- [ ] Verify installed discovery for one inactive and one active fixture, including six-field Claim privacy and `handoff.available: false` after force-end.
- [ ] Close Issue #86 and complete/release the formal Task only after deployed verification succeeds.
- [ ] Remove the Task worktree and branches only after completion; preserve unrelated worktrees and `feat/issue-81-jhw-fetch`.
