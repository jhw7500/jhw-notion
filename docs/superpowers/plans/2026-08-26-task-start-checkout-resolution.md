# Task start checkout resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a new Task's canonical Repository and unique Project inside the locked `task start` lifecycle, then replace client-side portfolio pagination with one secure launcher start and route Task finish/switch through launcher v3.

**Architecture:** Add a fail-closed Registry pin/final fence and expose it through one Catalog callback that surrounds the complete Project snapshot read. `GitHubSourceService` accepts an explicit-or-resolved coordinate union, preserves the resolved unique snapshot as its authority point, and feeds the resulting IDs into the existing registration and Claim path. The canonical Task skill becomes a thin launcher workflow; generated Codex entrypoints continue to consume the canonical Claude reference.

**Tech Stack:** TypeScript 5.5 strict ESM, Node.js 20, Zod 3, Vitest 4, Git/GitHub CLI adapters, Markdown contract tests.

**Spec:** `docs/superpowers/specs/2026-08-26-task-start-checkout-resolution-design.md` at approved commit `09d6f19`.

## Global Constraints

- Every command in this environment starts with `rtk`. Run TypeScript test/build commands from `mcp-server/`; run skill/sync commands from the `jhw-notion` worktree root.
- New Formal/Temporary starts accept exactly one coordinate mode: explicit `--project` plus `--repo-id`, or `--resolve-from-checkout true`. The exact literal is `true`; this is not a bare switch.
- Existing explicit starts and `--task` resume remain backward compatible. Resume rejects resolver and registration fields.
- The resolver runs inside the existing host-global `task start` mutation lock and creates no Task, Claim, or worktree on any resolution error.
- Checkout identity requires an exact absolute Git root, exactly one fetch and effective push origin, GitHub-only URLs, and case-insensitive equality across fetch, push, live `full_name`, and Registry slug. HTTPS fetch plus SSH push is valid.
- Repository source lookup, all nested Catalog reads during Project resolution, and the final Registry HEAD comparison use one pinned committed-tree scope. An unavailable final comparison is `REGISTRY_CORRUPT`, never “current”.
- Unique Project association is taken from one complete revision-fenced Project snapshot. Zero matches are `PROJECT_REPOSITORY_NOT_FOUND`; multiple matches are `PROJECT_REPOSITORY_AMBIGUOUS`; both exit 1.
- Resolved unique association is the authority point. Do not replace it with a later membership-only read. Project changes after the successful snapshot/final Registry fence are documented post-check changes, not a distributed transaction.
- Client code never reads raw config/credential stores, invokes raw `jhw-control task start/finish`, guesses IDs, or accumulates `portfolio status` pages.
- Consumer activation requires an installed producer launcher contract v3. New real Task smoke needs explicit user approval; code may merge before smoke, but issues #28/#74 do not close until that evidence exists.

## Planned File Structure

```text
mcp-server/src/control/registry-git.ts
                                  fail-closed committed-tree final fence
mcp-server/src/control/catalog.ts pinned GitHub-node Repository callback
mcp-server/src/control/github-project.ts
                                  unique Repository-to-Project snapshot resolver
mcp-server/src/control/github-source.ts
                                  explicit/resolved coordinate union and verified context
mcp-server/src/control/cli.ts     exact CLI truth table and existing result path
mcp-server/src/control/__tests__/registry-git.test.ts
mcp-server/src/control/__tests__/catalog.test.ts
mcp-server/src/control/__tests__/github-project.test.ts
mcp-server/src/control/__tests__/github-source.test.ts
mcp-server/src/control/__tests__/cli.test.ts
skills/claude/task.md             canonical thin Task lifecycle workflow
scripts/test-task-skill-contract.mjs
                                  executable Claude/Codex workflow contract
skills/codex/jhw-task/            generated/reference consumer, sync-owned only
```

---

### Task 1: Add a fail-closed Registry committed-tree final fence

**Files:**
- Modify: `mcp-server/src/control/registry-git.ts:175-210`
- Modify: `mcp-server/src/control/__tests__/registry-git.test.ts`

**Interfaces:**
- Consumes: the active `withCommittedTree()` scope and private `headCommit()` validator.
- Produces: `RegistryGit.assertCommittedViewCurrent(): Promise<void>`.

- [ ] **Step 1: Write final-fence failure tests**

Add one test that moves Registry HEAD while a committed-tree callback is open and one that makes the final `rev-parse HEAD` fail. Pin these outcomes:

```ts
await expect(registry.withCommittedTree(["repositories"], async () => {
  await commitFile(fixture.registryDir, "repositories/repo-new.yaml", "{}\n");
  await registry.assertCommittedViewCurrent();
})).rejects.toMatchObject({ code: "REGISTRY_MOVED_DURING_READ" });
```

For the failed comparison fixture, inject a Git runner whose final `rev-parse HEAD` throws and expect `REGISTRY_CORRUPT`. Also assert calling the method without an active committed-tree scope fails `REGISTRY_CORRUPT` so callers cannot silently skip the pin.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk npx vitest run src/control/__tests__/registry-git.test.ts`

Run: `rtk npm run typecheck`

Expected: Vitest fails when the test calls the missing runtime method, and typecheck reports that `assertCommittedViewCurrent` does not exist.

- [ ] **Step 3: Implement the exact fence**

```ts
async assertCommittedViewCurrent(): Promise<void> {
  const pinned = this.committedTree?.commit;
  if (pinned === undefined) {
    throw new ControlError("REGISTRY_CORRUPT", "Registry final fence requires a committed-tree scope");
  }
  const current = await this.headCommit();
  if (current !== pinned) {
    throw new ControlError(
      "REGISTRY_MOVED_DURING_READ",
      "Registry HEAD moved while this read was in progress",
    );
  }
}
```

Do not change the existing best-effort `committedViewIsStale()` behavior used by codec diagnostics; the new authority path calls the strict method explicitly.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `rtk npx vitest run src/control/__tests__/registry-git.test.ts`

Run: `rtk npm run typecheck`

Expected: both commands PASS.

- [ ] **Step 5: Commit the final fence**

```bash
rtk git add src/control/registry-git.ts src/control/__tests__/registry-git.test.ts
rtk git commit -m "feat(control): add registry read final fence"
```

---

### Task 2: Resolve a Repository source inside one pinned Catalog callback

**Files:**
- Modify: `mcp-server/src/control/catalog.ts:30-110,480-535,735-790`
- Modify: `mcp-server/src/control/__tests__/catalog.test.ts`

**Interfaces:**
- Consumes: `RegistryGit.withCommittedTree()`, `RegistryGit.assertCommittedViewCurrent()`, `auditRepositorySourceIndexesWithin()`, and `repositoryForSource()`.
- Produces: `Catalog.withPinnedRepositoryByGitHubNode<T>(githubNodeId, use): Promise<T>` and the matching `SourceCatalogPort` contract used in Task 4.

- [ ] **Step 1: Write pinned callback tests**

Cover a valid node lookup, missing index, malformed/reverse-mismatched/duplicate index, callback exception, and HEAD movement during the callback. The success shape is:

```ts
const result = await catalog.withPinnedRepositoryByGitHubNode("R_control", async (repository) => ({
  repo_id: repository.id,
  slug: repository.slug,
}));
expect(result).toEqual({ repo_id: "repo-control", slug: "example/control" });
```

In the movement case, commit to Registry HEAD inside `use` and expect `REGISTRY_MOVED_DURING_READ` after `use` returns. In the callback-error case, expect the original callback error rather than replacing it with a fence result.

- [ ] **Step 2: Run Catalog tests and verify RED**

Run: `rtk npx vitest run src/control/__tests__/catalog.test.ts`

Expected: `withPinnedRepositoryByGitHubNode` does not exist.

- [ ] **Step 3: Implement the single callback port**

```ts
async withPinnedRepositoryByGitHubNode<T>(
  githubNodeId: string,
  use: (repository: RepositoryRecord) => Promise<T>,
): Promise<T> {
  const parsed = githubNodeIdSchema.safeParse(githubNodeId);
  if (!parsed.success) throw new ControlError("INVALID_REPOSITORY_ID", "GitHub Repository node ID is invalid");
  return this.registry.withCommittedTree(["repositories"], async () => {
    await this.auditRepositorySourceIndexesWithin();
    const sourcePath = repositorySourceRelativePath(parsed.data);
    const indexed = await this.repositoryForSource(sourcePath, parsed.data);
    if (!indexed) {
      throw new ControlError("REPOSITORY_NOT_FOUND", "Canonical Repository source is not registered");
    }
    this.sensitiveData.assertSafe(indexed.repository);
    const result = await use(indexed.repository);
    await this.registry.assertCommittedViewCurrent();
    return result;
  });
}
```

Rename the Zod constant and every existing use from `githubNodeId` to `githubNodeIdSchema` before adding the method so the parameter cannot shadow it. Keep the callback and final fence inside the same committed-tree scope.

- [ ] **Step 4: Run Catalog and Registry tests**

Run: `rtk npx vitest run src/control/__tests__/catalog.test.ts src/control/__tests__/registry-git.test.ts`

Run: `rtk npm run typecheck`

Expected: all tests PASS and the new generic callback contract typechecks.

- [ ] **Step 5: Commit the pinned source resolver**

```bash
rtk git add src/control/catalog.ts src/control/__tests__/catalog.test.ts
rtk git commit -m "feat(control): pin repository source resolution"
```

---

### Task 3: Resolve exactly one Project from one complete snapshot

**Files:**
- Modify: `mcp-server/src/control/github-project.ts:845-895`
- Modify: `mcp-server/src/control/__tests__/github-project.test.ts`

**Interfaces:**
- Consumes: `GitHubProjectClient.readAll(): Promise<ProjectSnapshotSource>`.
- Produces: `ResolvedProjectAssociation` and `GitHubProjectClient.resolveUniqueProjectForRepository(repoId)`.

- [ ] **Step 1: Write the 0/1/N Project association tests**

```ts
const one = new QueuedGhRunner();
one.enqueue(projectPage({ records: [recordItem(1)] }));
await expect(client(one).resolveUniqueProjectForRepository("repo-control")).resolves.toEqual({
  project_id: "prj-project-1",
  source_revision: "2026-08-13T00:00:00Z",
});

const none = new QueuedGhRunner();
none.enqueue(projectPage({ records: [recordItem(1)] }));
await expect(client(none).resolveUniqueProjectForRepository("repo-other"))
  .rejects.toMatchObject({ code: "PROJECT_REPOSITORY_NOT_FOUND" });

const many = new QueuedGhRunner();
many.enqueue(projectPage({ records: [recordItem(1), recordItem(2)] }));
await expect(client(many).resolveUniqueProjectForRepository("repo-control"))
  .rejects.toMatchObject({ code: "PROJECT_REPOSITORY_AMBIGUOUS" });
```

Retain existing `readAll()` tests for malformed records, duplicate canonical Project IDs, pagination completeness, and `PROJECT_CHANGED_DURING_READ`.

- [ ] **Step 2: Run the focused Project tests and verify RED**

Run: `rtk npx vitest run src/control/__tests__/github-project.test.ts`

Expected: the new method does not exist.

- [ ] **Step 3: Implement the snapshot resolver**

```ts
export interface ResolvedProjectAssociation {
  project_id: string;
  source_revision: string;
}

async resolveUniqueProjectForRepository(repoId: string): Promise<ResolvedProjectAssociation> {
  const source = await this.readAll();
  const matches = source.items.filter((item) => item.repo_ids.includes(repoId));
  if (matches.length === 0) {
    throw new ControlError("PROJECT_REPOSITORY_NOT_FOUND", "No Project Record contains the Repository");
  }
  if (matches.length !== 1) {
    throw new ControlError("PROJECT_REPOSITORY_AMBIGUOUS", "Multiple Project Records contain the Repository");
  }
  return { project_id: matches[0]!.project_id, source_revision: source.source_revision };
}
```

Do not call `PortfolioService.status()` and do not issue a second independent Project read.

- [ ] **Step 4: Run Project tests and typecheck**

Run: `rtk npx vitest run src/control/__tests__/github-project.test.ts`

Run: `rtk npm run typecheck`

Expected: all tests PASS.

- [ ] **Step 5: Commit the unique association resolver**

```bash
rtk git add src/control/github-project.ts src/control/__tests__/github-project.test.ts
rtk git commit -m "feat(control): resolve unique project association"
```

---

### Task 4: Build explicit and checkout-resolved source contexts

**Files:**
- Modify: `mcp-server/src/control/github-source.ts:1-16,35-75,160-325`
- Modify: `mcp-server/src/control/__tests__/github-source.test.ts`
- Modify: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts:1325-1340,1818-1830`

**Interfaces:**
- Consumes: `SourceCatalogPort.withPinnedRepositoryByGitHubNode()`, `ProjectMembershipPort.requireProjectRepository()`, and `ProjectMembershipPort.resolveUniqueProjectForRepository()`.
- Produces: `TaskCoordinateInput`, `VerifiedTaskContext`, and coordinate-aware `registerFormalTask()` / `registerTemporaryTask()`.

- [ ] **Step 1: Extend test fixture ports and write resolved-context tests**

Create a separate spy before the `catalog` literal, then add a plain generic method inside the literal. Do not wrap the generic method itself in `vi.fn`, because that erases `Promise<T>` to `Promise<unknown>` under strict TypeScript:

```ts
const pinnedRepositoryLookup = vi.fn();

async withPinnedRepositoryByGitHubNode<T>(
  nodeId: string,
  use: (record: RepositoryRecord) => Promise<T>,
): Promise<T> {
  pinnedRepositoryLookup(nodeId);
  return use(repository);
},
```

Replace the current one-line `projects` fixture with this complete literal:

```ts
const projects = {
  requireProjectRepository: vi.fn(async () => undefined),
  resolveUniqueProjectForRepository: vi.fn(async () => ({
    project_id: "prj-wlan",
    source_revision: "2026-08-26T00:00:00Z",
  })),
};
```

The required port method also changes two structural fixtures in `phase1a.e2e.test.ts`. Keep them explicit-flow-only by adding implementations that fail if resolved mode is reached accidentally. Extend the first fixture's existing `projects` literal with:

```ts
async resolveUniqueProjectForRepository() {
  throw new ControlError(
    "PROJECT_REPOSITORY_NOT_FOUND",
    "resolved mode is not exercised by this explicit-flow fixture",
  );
},
```

Replace the second fixture's one-line `projects` literal with:

```ts
projects: {
  requireProjectRepository: async () => undefined,
  resolveUniqueProjectForRepository: async () => {
    throw new ControlError(
      "PROJECT_REPOSITORY_NOT_FOUND",
      "resolved mode is not exercised by this repository-registration fixture",
    );
  },
},
```

Return `pinnedRepositoryLookup` from `fixture()`. Write Formal and Temporary tests using `{ resolve_from_checkout: true, repository_path: checkout }`. Assert the Catalog registration receives `prj-wlan`/`repo-wlan`, `pinnedRepositoryLookup` and the unique Project resolver each run once, and `requireProjectRepository` does not run. Assert a Project resolver error and final-fence error produce no `registerFormalTask`/`registerTemporaryTask` call.

- [ ] **Step 2: Write identity and compatibility tests**

Cover exact root rejection, multiple fetch/push URLs, HTTPS fetch plus SSH push, case-only slug differences, a `.github` repository name, live node mismatch, rename mismatch, private repository, public repository with/without persisted `allow_public: true`, and protected-response rejection. Keep existing explicit and resume tests asserting `requireProjectRepository(projectId, repoId)` still runs.

- [ ] **Step 3: Run source tests and verify RED**

Run: `rtk npx vitest run src/control/__tests__/github-source.test.ts`

Run: `rtk npm run typecheck`

Expected: Vitest fails on the missing resolved-context behavior, and typecheck reports the unresolved registration inputs and ports.

- [ ] **Step 4: Define the coordinate union and verified context**

Add the Project resolver result type import:

```ts
import type { ResolvedProjectAssociation } from "./github-project.js";
```

```ts
export type TaskCoordinateInput =
  | { project_id: string; repo_id: string; resolve_from_checkout?: never }
  | { resolve_from_checkout: true; project_id?: never; repo_id?: never };

export type RegisterFormalTaskFromSourceInput = TaskCoordinateInput & {
  repository_path: string;
  issue_url: string;
  expected_issue_node_id?: string;
  expected_issue_revision?: string;
};

export type RegisterTemporaryTaskFromSourceInput = TaskCoordinateInput
  & Omit<RegisterTemporaryTaskInput, "project_id" | "repo_id">
  & { repository_path: string };

interface VerifiedTaskContext {
  project_id: string;
  repo_id: string;
  repository: RepositoryRecord;
  project_source_revision?: string;
}

export interface ProjectMembershipPort {
  requireProjectRepository(projectId: string, repoId: string): Promise<void>;
  resolveUniqueProjectForRepository(repoId: string): Promise<ResolvedProjectAssociation>;
}

export interface SourceCatalogPort {
  withPinnedRepositoryByGitHubNode<T>(
    githubNodeId: string,
    use: (repository: RepositoryRecord) => Promise<T>,
  ): Promise<T>;
}
```

Add `withPinnedRepositoryByGitHubNode()` to the existing `SourceCatalogPort` interface without removing its current members. Change the source methods to `registerFormalTask(input: RegisterFormalTaskFromSourceInput)` and `registerTemporaryTask(input: RegisterTemporaryTaskFromSourceInput)`. Do not make Project/Repository IDs optional on the Catalog record types.

- [ ] **Step 5: Factor checkout and live Repository identity**

Refactor `verifyCheckout()` into an exact-root helper that returns the fetch slug after proving one fetch URL, one effective push URL, and `sameSlug(fetch, push)`. Factor the GitHub API parser from privacy enforcement:

```ts
private async checkoutSlug(repositoryPath: string): Promise<string> {
  if (!isAbsolute(repositoryPath)) {
    throw new ControlError("INVALID_CHECKOUT_PATH", "Repository checkout path must be absolute");
  }
  const root = (await this.options.runner.run(
    "git", ["rev-parse", "--show-toplevel"], { cwd: repositoryPath },
  )).stdout.trim();
  if (!isAbsolute(root) || resolve(root) !== resolve(repositoryPath)) {
    throw new ControlError("CHECKOUT_ROOT_MISMATCH", "Repository path is not the exact checkout root");
  }
  const fetch = remoteLines(await this.options.runner.run(
    "git", ["remote", "get-url", "--all", "origin"], { cwd: repositoryPath },
  ));
  const push = remoteLines(await this.options.runner.run(
    "git", ["remote", "get-url", "--push", "--all", "origin"], { cwd: repositoryPath },
  ));
  if (fetch.length !== 1 || push.length !== 1) {
    throw new ControlError("AMBIGUOUS_CHECKOUT_ORIGIN", "Checkout must have one fetch and push URL");
  }
  const fetchSlug = githubSlugFromRemote(fetch[0]!);
  const pushSlug = githubSlugFromRemote(push[0]!);
  if (!sameSlug(fetchSlug, pushSlug)) {
    throw new ControlError("CHECKOUT_REMOTE_MISMATCH", "Checkout fetch and push remotes disagree");
  }
  return fetchSlug;
}

private async readLiveRepository(slug: string): Promise<z.infer<typeof RepositoryResponseSchema>> {
  const live = parseJson(
    (await this.options.runner.runGh(["api", `repos/${slug}`], "repo")).stdout,
    RepositoryResponseSchema,
    "INVALID_REPOSITORY_RESPONSE",
  );
  if (!sameSlug(live.full_name, slug)) {
    throw new ControlError("REPOSITORY_IDENTITY_MISMATCH", "GitHub repository slug disagrees");
  }
  this.sensitiveData.assertSafe(live);
  return live;
}

private assertRepositoryPolicy(
  live: z.infer<typeof RepositoryResponseSchema>,
  repository: RepositoryRecord,
): void {
  if (!live.private && repository.allow_public !== true) {
    throw new ControlError("REPOSITORY_NOT_PRIVATE", "Repository Record lacks public opt-in");
  }
}
```

Add this file-local parser:

```ts
function remoteLines(result: ProcessResult): string[] {
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}
```

Existing `resolveRepository(slug, allowPublic)` calls `readLiveRepository()` and enforces its boolean policy so repository registration and preflight behavior remain compatible.

Keep the current repository-registration call site compiling by replacing the old `verifyCheckout()` body with this wrapper over the new slug fact:

```ts
private async verifyCheckout(repositoryPath: string, expectedSlug: string): Promise<void> {
  const actualSlug = await this.checkoutSlug(repositoryPath);
  if (!sameSlug(actualSlug, expectedSlug)) {
    throw new ControlError("CHECKOUT_REMOTE_MISMATCH", "Checkout origin disagrees with requested Repository");
  }
}
```

Keep explicit mode in a separate helper so its membership semantics do not leak into resolved mode:

```ts
private async requireExplicitContext(
  projectId: string,
  repoId: string,
  repositoryPath: string,
): Promise<VerifiedTaskContext> {
  if (!projectIdPattern.test(projectId) || !repoIdPattern.test(repoId)) {
    throw new ControlError("INVALID_TASK_SCOPE", "Task Project/Repository coordinates are invalid");
  }
  const repository = await this.options.catalog.getRepository(repoId);
  this.assertCheckoutSafe(repository, repositoryPath);
  await this.options.projects.requireProjectRepository(projectId, repoId);
  const checkoutSlug = await this.checkoutSlug(repositoryPath);
  if (!sameSlug(checkoutSlug, repository.slug)) {
    throw new ControlError("CHECKOUT_REMOTE_MISMATCH", "Checkout origin disagrees with Repository Record");
  }
  const live = await this.readLiveRepository(repository.slug);
  this.assertCheckoutSafe(live, repositoryPath);
  this.assertRepositoryPolicy(live, repository);
  if (live.node_id !== repository.github_node_id) {
    throw new ControlError("REPOSITORY_IDENTITY_MISMATCH", "Repository Record and GitHub node disagree");
  }
  const context: VerifiedTaskContext = { project_id: projectId, repo_id: repoId, repository };
  this.assertCheckoutSafe(context, repositoryPath);
  return context;
}
```

The explicit path compares the returned slug to the requested Registry record, calls `readLiveRepository()`, checks node ID and policy, and runs existing membership validation. The resolved path reads live identity first, then enters the pinned Catalog callback.

- [ ] **Step 6: Implement coordinate-mode context selection**

```ts
private async requireContext(
  coordinates: TaskCoordinateInput,
  repositoryPath: string,
): Promise<VerifiedTaskContext> {
  if (coordinates.resolve_from_checkout === true) {
    const checkoutSlug = await this.checkoutSlug(repositoryPath);
    const live = await this.readLiveRepository(checkoutSlug);
    this.assertCheckoutSafe(live, repositoryPath);
    return this.options.catalog.withPinnedRepositoryByGitHubNode(live.node_id, async (repository) => {
      this.assertCheckoutSafe(repository, repositoryPath);
      if (!sameSlug(checkoutSlug, repository.slug) || !sameSlug(live.full_name, repository.slug)) {
        throw new ControlError("REPOSITORY_IDENTITY_MISMATCH", "Checkout, GitHub, and Registry disagree");
      }
      if (live.node_id !== repository.github_node_id) {
        throw new ControlError("REPOSITORY_IDENTITY_MISMATCH", "Repository node identity disagrees");
      }
      this.assertRepositoryPolicy(live, repository);
      const project = await this.options.projects.resolveUniqueProjectForRepository(repository.id);
      this.assertCheckoutSafe(project, repositoryPath);
      const context: VerifiedTaskContext = {
        project_id: project.project_id,
        repo_id: repository.id,
        repository,
        project_source_revision: project.source_revision,
      };
      this.assertCheckoutSafe(context, repositoryPath);
      return context;
    });
  }
  return this.requireExplicitContext(coordinates.project_id, coordinates.repo_id, repositoryPath);
}
```

Resolved mode must not call `requireProjectRepository()` after this return; the unique Project snapshot remains its authority point.

- [ ] **Step 7: Feed verified coordinates into existing registration**

Before either registration performs a GitHub runner call or Catalog mutation, remove only the trusted checkout path and scan every remaining caller field:

```ts
const { repository_path: repositoryPath, ...formalRequest } = input;
this.assertCheckoutSafe(formalRequest, repositoryPath);
const context = await this.requireContext(formalRequest, repositoryPath);
```

```ts
const { repository_path: repositoryPath, ...temporaryRequest } = input;
this.assertCheckoutSafe(temporaryRequest, repositoryPath);
const context = await this.requireContext(temporaryRequest, repositoryPath);
```

For Formal and Temporary registration, build the Catalog input from `context.project_id` and `context.repo_id`, not caller fields:

```ts
return this.options.catalog.registerFormalTask({
  project_id: context.project_id,
  repo_id: context.repo_id,
  ...issueRecord(issue),
});
```

```ts
const {
  project_id: _projectId,
  repo_id: _repoId,
  resolve_from_checkout: _resolve,
  ...temporary
} = temporaryRequest;
return this.options.catalog.registerTemporaryTask({
  ...temporary,
  project_id: context.project_id,
  repo_id: context.repo_id,
});
```

Preserve Issue URL/node/revision/open validation, temporary goal/done/scope validation, sensitive-data checks on every input/live/record/project/returned context shown above, idempotent registration, and existing resume/promote explicit context.

Update the two existing callers that still pass three positional context arguments. `prepareExistingTask()` uses:

```ts
const context = await this.requireContext(
  { project_id: task.project_id, repo_id: task.repo_id },
  input.repository_path,
);
```

`promoteTemporaryTask()` uses:

```ts
const context = await this.requireContext(
  { project_id: current.project_id, repo_id: current.repo_id },
  input.repository_path,
);
```

The existing `registerRepository()` call remains `await this.verifyCheckout(input.repository_path, input.slug)` and now reaches the wrapper from Step 5.

- [ ] **Step 8: Run source, Project, Catalog, and affected E2E tests**

Run: `rtk npx vitest run src/control/__tests__/github-source.test.ts src/control/__tests__/github-project.test.ts src/control/__tests__/catalog.test.ts src/control/__tests__/phase1a.e2e.test.ts`

Run: `rtk npm run typecheck`

Expected: all tests PASS.

- [ ] **Step 9: Commit resolved source contexts**

```bash
rtk git add src/control/github-source.ts src/control/__tests__/github-source.test.ts src/control/__tests__/phase1a.e2e.test.ts
rtk git commit -m "feat(control): derive task context from checkout"
```

---

### Task 5: Add the exact CLI coordinate-mode truth table

**Files:**
- Modify: `mcp-server/src/control/cli.ts:20-30,890-1005`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: coordinate-aware source registration methods from Task 4.
- Produces: `task start --resolve-from-checkout true` without changing success envelope or mutation-lock classification.

- [ ] **Step 1: Write resolved Formal and Temporary CLI tests**

Add arguments that omit Project/Repository IDs and include the exact resolver pair. Assert source registration receives `resolve_from_checkout: true`, returns canonical Task IDs, `taskService.start()` receives the Task's Project/Repository IDs, and `mutationLock.run()` is called once.

```ts
const args = [
  "task", "start", "--resolve-from-checkout", "true",
  "--repo-path", "/private/source/control",
  "--issue-url", "https://github.com/example/control/issues/1",
  "--session", "codex-resolved",
];
```

Temporary uses the same coordinate pair plus exact alias/goal/done/scope fields.

For both new association error codes, make the source registration mock reject and assert exact exit 1 projection plus `taskService.start()` not called. This proves resolver failure cannot reach Claim/worktree creation:

```ts
for (const code of ["PROJECT_REPOSITORY_NOT_FOUND", "PROJECT_REPOSITORY_AMBIGUOUS"] as const) {
  const dependencies = makeCliDependencies();
  vi.mocked(dependencies.source.registerFormalTask).mockRejectedValueOnce(new ControlError(code, "safe"));
  const result = await runCli(args, dependencies);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: { code } });
  expect(dependencies.taskService.start).not.toHaveBeenCalled();
}
```

- [ ] **Step 2: Write the full rejection matrix**

Parameterize resolver value `false`, `yes`, and empty; resolver mixed with either ID; partial explicit IDs; missing both modes; resolver plus `--task`; and resume plus any registration field. Assert exit 2 and no source registration or `taskService.start()` call. Keep the explicit and resume success tests unchanged. Retain the existing `task promote` regression with its exact input `{ task_id, repository_path, issue_url }`; assert it does not receive `resolve_from_checkout` and still acquires the mutation lock once.

- [ ] **Step 3: Run CLI tests and verify RED**

Run: `rtk npx vitest run src/control/__tests__/cli.test.ts`

Expected: `--resolve-from-checkout` is an unknown flag.

- [ ] **Step 4: Parse the exact pair without changing parseFlags**

Import the coordinate union with the source service:

```ts
import { GitHubSourceService, type TaskCoordinateInput } from "./github-source.js";
```

Add the flag to the allowed set and use existing pair parsing:

```ts
const resolveFromCheckout = value(flags, "--resolve-from-checkout");
if (resolveFromCheckout !== undefined && resolveFromCheckout !== "true") {
  usage("Checkout resolver must be the exact literal true");
}
const hasResolved = resolveFromCheckout === "true";
const hasProject = flags.has("--project");
const hasRepository = flags.has("--repo-id");
if (hasProject !== hasRepository) usage("Explicit coordinates require both Project and Repository IDs");
const hasExplicit = hasProject && hasRepository;
if (!hasExisting && hasResolved === hasExplicit) usage("New Task start requires exactly one coordinate mode");
if (hasExisting && (hasFormal || hasTemporary || hasProject || hasRepository || hasResolved)) {
  usage("Existing Task resume cannot include registration fields");
}
```

Build the union once for new Tasks, pass it into either registration branch, then derive the Claim coordinates from the canonical Task returned by registration:

```ts
let coordinates: TaskCoordinateInput | undefined;
if (!hasExisting) {
  coordinates = hasResolved
    ? { resolve_from_checkout: true }
    : {
        project_id: assertPattern(required(flags, "--project"), PROJECT_ID),
        repo_id: assertPattern(required(flags, "--repo-id"), REPO_ID),
      };
}

if (coordinates === undefined) usage("New Task coordinate mode is missing");
const registration = await dependencies.source.registerFormalTask({
  ...coordinates,
  repository_path,
  issue_url,
  ...(value(flags, "--issue-node-id")
    ? { expected_issue_node_id: value(flags, "--issue-node-id") }
    : {}),
  ...(value(flags, "--issue-revision")
    ? { expected_issue_revision: value(flags, "--issue-revision") }
    : {}),
});
task = registration.task;
alias = task.aliases[0] ?? usage("Formal Task has no canonical alias");
```

The Temporary branch performs its own narrowing and preserves its required source fields:

```ts
if (coordinates === undefined) usage("New Task coordinate mode is missing");
alias = required(flags, "--temp-alias");
const goal = required(flags, "--goal");
const done_conditions = values(flags, "--done").filter((entry) => isNonEmpty(entry));
const expected_scope = values(flags, "--scope").filter((entry) => isNonEmpty(entry));
if (done_conditions.length === 0 || expected_scope.length === 0) {
  usage("Temporary task needs done and scope values");
}
task = await dependencies.source.registerTemporaryTask({
  ...coordinates,
  repository_path,
  alias,
  goal,
  done_conditions,
  expected_scope,
});
```

After the Formal/Temporary/resume branches converge, bind the Claim only to canonical Task coordinates:

```ts
const project_id = task.project_id;
const repo_id = task.repo_id;
```

Preserve the existing output and Claim call.

- [ ] **Step 5: Run CLI tests, typecheck, and build**

Run: `rtk npx vitest run src/control/__tests__/cli.test.ts`

Run: `rtk npm run typecheck`

Run: `rtk npm run build`

Expected: all commands PASS; `requiresMutationLock(["task", "start"])` remains true.

- [ ] **Step 6: Commit the CLI resolver**

```bash
rtk git add src/control/cli.ts src/control/__tests__/cli.test.ts
rtk git commit -m "feat(control): add checkout-resolved task start"
```

---

### Task 6: Replace client pagination with one resolver start

**Files:**
- Modify: `skills/claude/task.md:20-260`
- Modify: `scripts/test-task-skill-contract.mjs`
- Verify/regenerate only: `skills/codex/jhw-task/`

**Interfaces:**
- Consumes: installed launcher v3 and server CLI from Task 5.
- Produces: preflight followed by exactly one Formal/Temporary resolver start, or one existing-Task resume.

- [ ] **Step 1: Gate every canonical skill edit on the installed v3 contract**

Run this exact structural assertion before modifying `skills/claude/task.md`, its contract test, or generated Codex references:

```bash
rtk python3 -c 'import json, pathlib, subprocess; launcher=str(pathlib.Path.home()/".local/bin/jhw-control-host"); expected={"commands":["unlock","preflight","portfolio status","task start","task finish"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":3}; actual=json.loads(subprocess.check_output([launcher,"--contract"], text=True)); assert actual == expected, actual'
```

Expected: exit 0. If the executable is missing or the assertion fails, stop without editing any Task skill file; execute, review, merge, and install `claude-config/docs/superpowers/plans/2026-08-26-jhw-control-host-v3.md`, then rerun this gate.

- [ ] **Step 2: Replace pagination contract tests with resolver-call tests**

Remove `validPortfolio`, page fixtures, pagination aggregation assertions, remote schema duplication, and fake launcher `portfolio status` branches. Change expected calls:

```js
assert.deepEqual(success.calls.map(commandName), ["preflight", "task start"]);
assert.match(success.calls[1], /task start --resolve-from-checkout true/);
assert.doesNotMatch(success.calls[1], /--project|--repo-id|portfolio status/);
```

For resume, assert the second call contains `--task <tsk-id>` and does not contain resolver/Project/Repository flags. Preflight nonzero must leave calls exactly `["preflight"]`.

Extend `runWorkflow()` with a `taskStartError` option and make the fake v3 launcher emit a real failure envelope on stderr:

```bash
if [ -n "$JHW_TASK_CONTRACT_TASK_START_ERROR" ]; then
  printf '{"error":{"code":"%s"}}\n' "$JHW_TASK_CONTRACT_TASK_START_ERROR" >&2
  exit 1
fi
```

Add `taskStartError = ""` to the existing `runWorkflow()` option destructuring, bind it into the child environment, and return stderr on both process branches:

```js
taskStartError = "",
JHW_TASK_CONTRACT_TASK_START_ERROR: taskStartError,

}).then(
  ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
  (error) => ({
    exitCode: error.code,
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? "",
  }),
);
```

Return `stderr` from both the success and rejected `execFileAsync` branches, then exercise both association errors at runtime:

```js
for (const code of ["PROJECT_REPOSITORY_NOT_FOUND", "PROJECT_REPOSITORY_AMBIGUOUS"]) {
  const failed = await runWorkflow(markdown, routes[0], { taskStartError: code });
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.calls.map(commandName), ["preflight", "task start"]);
  assert.deepEqual(JSON.parse(failed.stderr), { error: { code } });
  assert.equal(failed.calls.filter((call) => commandName(call) === "task start").length, 1);
  assert.doesNotMatch(failed.calls.join("\n"), /portfolio status|--project|--repo-id/);
}

const moved = await runWorkflow(markdown, routes[0], {
  taskStartError: "REGISTRY_MOVED_DURING_READ",
});
assert.equal(moved.exitCode, 1);
assert.deepEqual(moved.calls.map(commandName), ["preflight", "task start"]);
assert.deepEqual(JSON.parse(moved.stderr), {
  error: { code: "REGISTRY_MOVED_DURING_READ" },
});
```

This is the runtime propagation contract: one preflight, one start, exact safe code, then stop with no retry or fallback, including Registry movement during a resolver mutation.

- [ ] **Step 3: Add static operator-action and deletion assertions**

Require the exact actions for `PROJECT_REPOSITORY_NOT_FOUND` and `PROJECT_REPOSITORY_AMBIGUOUS`; forbid automatic explicit fallback and arbitrary selection. Require result guidance to say a resolver `task start` that returns `REGISTRY_MOVED_DURING_READ` stops without automatic retry, while any read-only retry guidance is explicitly limited to `status`, `handoff`, `assert-owner`, and `recover --action status`. Assert canonical Task Markdown contains none of `portfolio_state`, `bind_portfolio_coordinates`, `verified_checkout_slug`, launcher `portfolio status`, raw `jhw-control task start`, or `rtk git`.

- [ ] **Step 4: Run the consumer contract and verify RED**

Run: `rtk node scripts/test-task-skill-contract.mjs`

Expected: current workflow calls portfolio status and the pagination implementation remains present.

- [ ] **Step 5: Reduce the canonical authorization gate**

The executable flow in `skills/claude/task.md` becomes:

```bash
"$HOME/.local/bin/jhw-control-host" preflight >/dev/null || exit $?
REPOSITORY_PATH="$(git rev-parse --show-toplevel)" || exit $?
test -n "$REPOSITORY_PATH" || exit 1
"$HOME/.local/bin/jhw-control-host" task start \
  --resolve-from-checkout true \
  --repo-path "$REPOSITORY_PATH" \
  --session <session-id>
```

Formal/Temporary sections append their existing source fields; resume uses `--task` instead of the resolver pair. Remove all Project-page aggregation and remote/schema parsing. Report only `task_id`, `claim_id`, `branch`, and `worktree_ref` from launcher output. Run the contract child shell with `PATH=/usr/bin:/bin` so the supported RTK-absent installation is exercised.

- [ ] **Step 6: Document fail-closed resolver actions**

State that not-found requires registering the Repository in the correct Project Record, ambiguous requires reducing association to one, and neither error permits guessing, arbitrary selection, automatic retry, or explicit-mode fallback. Replace the current unconditional `REGISTRY_MOVED_DURING_READ` rerun instruction: resolver start/finish movement stops and is reported without automatic rerun; only the enumerated read-only commands retain manual rerun guidance.

- [ ] **Step 7: Run Task contract and Codex sync**

Run: `rtk node scripts/test-task-skill-contract.mjs`

Run: `rtk node scripts/sync-codex-skills.mjs`

Run: `rtk node scripts/sync-codex-skills.mjs --check`

Expected: all commands PASS; generated/reference files are sync-clean.

- [ ] **Step 8: Commit the thin start workflow**

```bash
rtk git add skills/claude/task.md scripts/test-task-skill-contract.mjs skills/codex/jhw-task
rtk git commit -m "docs(task): use checkout resolver for starts"
```

If sync produces no generated diff, `rtk git add` simply stages the two canonical files; do not create an empty generated-only commit.

---

### Task 7: Route finish and switch through launcher v3

**Files:**
- Modify: `skills/claude/task.md:260-390`
- Modify: `scripts/test-task-skill-contract.mjs`
- Verify/regenerate only: `skills/codex/jhw-task/`

**Interfaces:**
- Consumes: launcher v3 `task finish` and the start routes from Task 6.
- Produces: one exact host finish followed by at most one host start; finish success/start failure is explicit partial completion.

- [ ] **Step 1: Recheck launcher v3 before the independently executable skill task**

Run this exact structural assertion before modifying `skills/claude/task.md`, its contract test, or generated Codex references:

```bash
rtk python3 -c 'import json, pathlib, subprocess; launcher=str(pathlib.Path.home()/".local/bin/jhw-control-host"); expected={"commands":["unlock","preflight","portfolio status","task start","task finish"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":3}; actual=json.loads(subprocess.check_output([launcher,"--contract"], text=True)); assert actual == expected, actual'
```

Expected: exit 0. If it fails, stop without editing canonical or generated skill files and complete the producer v3 rollout first.

- [ ] **Step 2: Add finish and the complete 3×3 switch matrix as RED tests**

Extend the fake installed launcher with a `task finish` result/error branch. For standalone finish and switch, assert there is no raw-control fake invocation. Add the switch success order:

```js
assert.deepEqual(success.calls.map(commandName), ["task finish", "task start"]);
```

Pin all nine status/target combinations literally:

```js
const switchCases = [
  { status: "completed", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
  { status: "completed", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
  { status: "completed", target: "resume", start: new RegExp(`--task ${taskId}`) },
  { status: "handoff", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
  { status: "handoff", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
  { status: "handoff", target: "resume", start: new RegExp(`--task ${taskId}`) },
  { status: "abandoned", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
  { status: "abandoned", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
  { status: "abandoned", target: "resume", start: new RegExp(`--task ${taskId}`) },
];

for (const testCase of switchCases) {
  const result = await runSwitchWorkflow(markdown, testCase);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.calls.map(commandName), ["task finish", "task start"]);
  assert.match(result.calls[0], new RegExp(`--status ${testCase.status}`));
  assert.match(result.calls[0], /--validation verified-validation/);
  assert.equal(result.calls[0].includes("--outcome verified-result"), testCase.status === "completed");
  if (testCase.status === "handoff") assert.match(result.calls[0], /--progress verified-progress/);
  assert.match(result.calls[1], testCase.start);
  if (testCase.target === "resume") {
    assert.doesNotMatch(result.calls[1], /--resolve-from-checkout|--project|--repo-id/);
  } else {
    assert.doesNotMatch(result.calls[1], /--project|--repo-id/);
  }
}
```

Implement `runSwitchWorkflow(markdown, { status, target, finishExit = 0, taskStartExit = 0 })` in the test harness by materializing exact `switch-formal`, `switch-temporary`, and `switch-resume` contract blocks with `<finish-status>`, `<result>`, `<progress>`, and their target registration fields. Extend the fake installed launcher with `task finish` success/error branches; never invoke the raw-control fake.

Add these literal assertions while editing the result-guidance range, then keep the existing distinct recovery text for every group:

```js
for (const literal of [
  "HANDOFF_RETRY_CONFLICT",
  "invalid_git_state_line",
  "duplicate_git_state_key",
  "unexpected_git_state_key",
  "missing_git_state_key",
  "invalid_git_state_count",
  "missing_git_identity",
  "invalid_dirty_digest",
  "legacy_dirty_evidence_ambiguous",
  "git_identity_changed",
  "dirty_delta_changed",
  "handoff_metadata_mismatch",
  "retry_fields_changed",
  "WORKTREE_DIRTY",
  "handoff_copy_not_plain_file",
  "INVALID_WORKTREE_INSPECTION",
  "duplicate_dirty_files",
]) assert.match(markdown, new RegExp(literal));
assert.match(markdown, /커밋된 Handoff가 정본/);
assert.match(markdown, /자동 overwrite나 finish 재실행을 하지 않는다/);
```

Add the exact sentence `자동 overwrite나 finish 재실행을 하지 않는다.` to the recovery paragraph. `git_identity_changed`/`dirty_delta_changed`, legacy evidence, retry-field/metadata mismatch, malformed Git-state evidence, malformed local Handoff copy, and duplicate inspection entries retain separate stop/recovery actions.

- [ ] **Step 3: Pin partial-completion behavior**

Assert target Git-root validation failure makes zero lifecycle calls, finish failure leaves calls `["task finish"]`, and start failure leaves exactly `["task finish", "task start"]` with no refinish. Formal/Temporary targets use resolver; existing targets use `--task`. The reported start failure must include that the prior Claim is already released and must not promise rollback.

- [ ] **Step 4: Run switch contract and verify RED**

Run: `rtk node scripts/test-task-skill-contract.mjs`

Expected: current finish uses raw `jhw-control`, switch hardcodes handoff status, or portfolio coordinate prevalidation remains.

- [ ] **Step 5: Replace standalone and switch finish commands**

Use the absolute launcher path for every Task release:

```bash
"$HOME/.local/bin/jhw-control-host" task finish \
  --task <tsk-id> \
  --claim <claim-id> \
  --status <finish-status> \
  --validation <validation>
```

Append `--outcome` only for completed and preserve the existing Handoff/abandoned field contracts. The launcher performs hidden preflight; do not source config or inspect credentials.

- [ ] **Step 6: Implement the exact switch sequence**

Validate the target absolute Git root before finish:

```bash
target_checkout="<absolute-target-checkout-root>"
case "$target_checkout" in
  /*) ;;
  *) exit 1 ;;
esac
target_root="$(git -C "$target_checkout" rev-parse --show-toplevel)" || exit $?
test "$target_root" = "$target_checkout" || exit 1
```

Execute host finish once with the user's exact status; on success execute one start using the retained `target_root`. Do not perform portfolio lookup, external gate rerun, finish rollback, or automatic refinish. Document that target not-found/ambiguous may therefore fail after release.

- [ ] **Step 7: Run Task contract and sync checks**

Run: `rtk node scripts/test-task-skill-contract.mjs`

Run: `rtk node scripts/sync-codex-skills.mjs`

Run: `rtk node scripts/sync-codex-skills.mjs --check`

Expected: all commands PASS.

- [ ] **Step 8: Commit secure finish and switch**

```bash
rtk git add skills/claude/task.md scripts/test-task-skill-contract.mjs skills/codex/jhw-task
rtk git commit -m "docs(task): route finish through host v3"
```

---

### Task 8: Run integration, review, and rollout gates

**Files:**
- Verify only: all files changed in Tasks 1-7
- Evidence only: existing `.superpowers/sdd/2026-08-26-jhw-control-host/` review reports

**Interfaces:**
- Consumes: installed producer v3 plus every committed consumer/server task.
- Produces: a clean #74 branch that is safe to merge; issue close remains gated on an approved real resolver smoke.

- [ ] **Step 1: Run focused resolver and consumer gates**

From `mcp-server/` run:

```bash
rtk npx vitest run src/control/__tests__/registry-git.test.ts src/control/__tests__/catalog.test.ts src/control/__tests__/github-project.test.ts src/control/__tests__/github-source.test.ts src/control/__tests__/cli.test.ts
rtk npm run typecheck
rtk npm run build
```

From the repository root run:

```bash
rtk node scripts/test-task-skill-contract.mjs
rtk node scripts/sync-codex-skills.mjs --check
rtk git diff --check
```

Expected: all commands PASS.

- [ ] **Step 2: Run the complete consumer suite**

From `mcp-server/` run: `rtk npm test`

Expected: the full Vitest suite passes with no skipped resolver contract.

- [ ] **Step 3: Verify producer v3 is installed before activation**

Run: `rtk "$HOME/.local/bin/jhw-control-host" --contract`

Expected: version 3, secure-store-only, and exact commands including `task finish`. Stop before merge/activation if the installed launcher is older.

- [ ] **Step 4: Reconcile the current default branch**

Run: `rtk git fetch origin main`

Run: `rtk git merge-tree HEAD origin/main`

Run: `rtk git merge-base --is-ancestor origin/main HEAD`

Expected: `merge-tree` has no conflict markers. If the ancestry check exits 1, run `rtk git merge --no-edit origin/main`; preserve both approved behaviors across overlaps without discarding user work.

- [ ] **Step 5: Rerun focused, full, type, build, and sync gates after reconciliation**

From `mcp-server/` run:

```bash
rtk npx vitest run src/control/__tests__/registry-git.test.ts src/control/__tests__/catalog.test.ts src/control/__tests__/github-project.test.ts src/control/__tests__/github-source.test.ts src/control/__tests__/cli.test.ts
rtk npm run typecheck
rtk npm run build
rtk npm test
```

From the repository root run:

```bash
rtk node scripts/test-task-skill-contract.mjs
rtk node scripts/sync-codex-skills.mjs --check
rtk git diff --check
```

Expected: every post-default-base gate passes.

- [ ] **Step 6: Verify final scope and obtain review on the final combined diff**

Run: `rtk git status --short`

Run: `rtk git diff --stat origin/main...HEAD`

Expected: only #74 design/plan/server/Task-contract changes are present and the worktree is clean. Request independent architecture, security, and consumer-contract review of `origin/main...HEAD`; reviewers verify the pinned interval, no membership-only downgrade, explicit/resume/promote compatibility, no resolver mutation on failure, launcher-only start/finish, all nine switch cases, and absence of client pagination/schema duplication. Stop on any Critical, High, or unresolved Important finding.

- [ ] **Step 7: Integrate the reviewed consumer tree**

Invoke `superpowers:finishing-a-development-branch` and use its local integration path only after Step 6 is clean. Keep `task/3fa8c9d1e7ea-jhw7500-jhw-notion-74` until the default-branch ancestry check passes.

Run: `rtk git -C /home/jhw/ai/opencode/projects/jhw-notion merge-base --is-ancestor task/3fa8c9d1e7ea-jhw7500-jhw-notion-74 main`

Expected: exit 0, proving the independently reviewed consumer branch tip is contained in the stable default branch.

- [ ] **Step 8: Activate the stable consumer build and preserve the smoke boundary**

Before relying on the merged skill, rebuild and reinstall from the stable checkout so the ignored `mcp-server/dist/` and installed raw CLI cannot remain on the pre-resolver version.

Run: `rtk git -C /home/jhw/ai/opencode/projects/jhw-notion branch --show-current`

Run: `rtk git -C /home/jhw/ai/opencode/projects/jhw-notion diff --exit-code HEAD -- mcp-server/src/control mcp-server/src/control/__tests__ skills/claude/task.md scripts/test-task-skill-contract.mjs install.sh`

Run: `rtk /home/jhw/ai/opencode/projects/jhw-notion/install.sh`

Run: `rtk npm --prefix /home/jhw/ai/opencode/projects/jhw-notion/mcp-server run typecheck`

Run: `rtk npm --prefix /home/jhw/ai/opencode/projects/jhw-notion/mcp-server test`

Run: `rtk node /home/jhw/ai/opencode/projects/jhw-notion/scripts/test-task-skill-contract.mjs`

Run: `rtk "$HOME/.local/bin/jhw-control-host" --contract`

Run: `rtk env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH=/usr/bin:/bin "$HOME/.local/bin/jhw-control-host" preflight`

Expected: the stable branch is `main`, listed consumer paths match `HEAD`, install/build succeeds, stable typecheck/full tests and Task contract pass, the installed producer contract remains exact v3 secure-store-only, and clean-environment preflight exits 0 with its validated envelope against the newly installed server. If the keyring is locked, the user runs `jhw-control-host unlock` in their terminal once; do not inspect, print, or migrate credential values. Stop before any real Task start if any check fails.

Do not create a proof-only Task automatically. On the next explicitly approved real Formal/Temporary start, retain the sanitized v3 success envelope as the resolver positive smoke. Until then, code may merge but #28/#74 remain open with the existing operator-attested Task/Claim and the missing original envelope recorded as an audit limitation.

No additional commit is created for verification or smoke deferral.
