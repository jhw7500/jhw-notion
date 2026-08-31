# Current Context Repository Identity Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject a host-local worktree mapping whose physical source checkout belongs to a different canonical GitHub repository while continuing to accept independent clones of the same repository.

**Architecture:** Extend the existing pinned current-status callback with the canonical Repository Record slug and carry that internal value through `TaskService` to `WorktreeManager`. Extract the exact-checkout origin resolver already used by `GitHubSourceService`, then require each mapping-owned source checkout to have one canonical fetch origin and one canonical push origin matching the pinned slug before it can participate in current-context classification.

**Tech Stack:** TypeScript 5.5, Node.js ESM, Zod, Vitest, Git CLI.

**Spec:** `docs/superpowers/specs/2026-08-31-review-control-consistency-design.md`

## Global Constraints

- Every shell command in this repository session is prefixed with `rtk`.
- Only the Task #71 worktree and branch may be modified; the protected default checkout remains untouched.
- `GitHubSourceService` remains the authority that pins the live checkout, GitHub repository node identity, canonical Repository Record, and unique Project association.
- The pinned Repository Record slug is internal context only; public `task status` success output remains unchanged.
- `session_id`, absolute checkout/worktree/config paths, repository identity paths, remote URLs, raw credentials, and raw error messages never enter public success or failure output.
- A different Git common directory is allowed when both checkouts resolve to the same canonical GitHub repository slug.
- A mapping-owned checkout with a missing, noncanonical, multiple, divergent, or different-repository origin fails closed with `WORKTREE_REPOSITORY_MISMATCH` and exposes only `worktree_ref` in details.
- `worktrees.json` remains schema version 2 and gains no fields.
- No new stable error code or `ERROR_REASONS` entry is introduced.
- The read-only current-context path must not create, chmod, rewrite, or otherwise mutate host-local state or worktree directories.
- Required final gates are `npm run typecheck`, `npm run build`, `npm test`, review skill contract, Codex skill sync check, and installer safety.

---

### Task 1: Bind mapping-owned checkouts to the pinned canonical repository

**Files:**
- Modify: `mcp-server/src/control/github-source.ts`
- Modify: `mcp-server/src/control/worktree.ts`
- Modify: `mcp-server/src/control/task-service.ts`
- Modify: `mcp-server/src/control/cli.ts`
- Test: `mcp-server/src/control/__tests__/github-source.test.ts`
- Test: `mcp-server/src/control/__tests__/worktree.test.ts`
- Test: `mcp-server/src/control/__tests__/task-service.test.ts`
- Test: `mcp-server/src/control/__tests__/cli.test.ts`
- Test: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`

**Interfaces:**
- Consumes: `VerifiedTaskContext.repository.slug`, an absolute exact queried checkout root, the active Claims for one `repo_id`, and each local mapping's stored `repository_path`.
- Produces: `ResolvedTaskStatusContext.repository_slug: string`, `CurrentTaskContextInput.repository_slug: string`, and `WorktreeManagerPort.claimsMappedToCheckout(claims, repositoryPath, repositorySlug): Promise<ReadonlySet<string>>`.
- Preserves: the exact public `CurrentTaskContextResult` union and CLI projection; neither contains `repository_slug`.

- [ ] **Step 1: Add the failing self-consistent unrelated-repository regression test**

In `worktree.test.ts`, define canonical constants and make `worktreeFixture()` add the canonical origin:

```ts
const CANONICAL_SLUG = "jhw7500/wlan";
const CANONICAL_ORIGIN = `https://github.com/${CANONICAL_SLUG}.git`;

await git(repoDir, "remote", "add", "origin", CANONICAL_ORIGIN);
```

Update every `claimsMappedToCheckout` call to pass `CANONICAL_SLUG`. Add this regression using the real Git repositories and real worktree validation:

```ts
it("rejects a self-consistent mapping owned by a different canonical repository", async () => {
  const { fixture, repoDir, manager } = await worktreeFixture();
  const active = claim();
  const created = await manager.createOrReuse(active, repoDir);
  const unrelated = join(fixture.root, "unrelated-source-repository");
  await git(fixture.root, "init", "--initial-branch=main", unrelated);
  await git(unrelated, "config", "user.name", "Phase1A Test");
  await git(unrelated, "config", "user.email", "phase1a@example.invalid");
  await writeFile(join(unrelated, "README.md"), "# Unrelated\n", "utf8");
  await git(unrelated, "add", "README.md");
  await git(unrelated, "commit", "-m", "Initial unrelated source");
  await git(unrelated, "remote", "add", "origin", "https://github.com/other-owner/other-repository.git");
  await git(unrelated, "branch", active.branch);
  await git(repoDir, "worktree", "remove", created.path);
  await git(unrelated, "worktree", "add", created.path, active.branch);

  const statePath = join(fixture.root, "state", "worktrees.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    worktrees: Record<string, { repository_path: string; repository_identity: string }>;
  };
  state.worktrees[active.worktree_ref].repository_path = unrelated;
  state.worktrees[active.worktree_ref].repository_identity = await realpath(join(unrelated, ".git"));
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await expect(manager.claimsMappedToCheckout([active], repoDir, CANONICAL_SLUG)).rejects.toMatchObject({
    code: "WORKTREE_REPOSITORY_MISMATCH",
    details: { worktree_ref: active.worktree_ref },
  });
});
```

The production mutation this test catches is removal of the mapping-owned canonical-origin comparison. Its expected code and bounded details are literal, and its physical mapping is otherwise self-consistent.

- [ ] **Step 2: Run the regression and verify RED**

Working directory: `mcp-server`

```bash
rtk npm test -- src/control/__tests__/worktree.test.ts -t "different canonical repository"
```

Expected: FAIL because the current implementation treats the unrelated mapping as a harmless non-match instead of throwing `WORKTREE_REPOSITORY_MISMATCH`.

- [ ] **Step 3: Extract the existing exact-checkout GitHub slug resolver**

In `github-source.ts`, add an exported resolver with the structural runner type already used by the service:

```ts
export async function githubSlugFromCheckout(
  runner: Pick<GitHubSourceRunner, "run">,
  repositoryPath: string,
): Promise<string> {
  if (!isAbsolute(repositoryPath)) {
    throw new ControlError("INVALID_CHECKOUT_PATH", "Repository checkout path must be absolute");
  }
  const root = (await runner.run("git", ["rev-parse", "--show-toplevel"], { cwd: repositoryPath })).stdout.trim();
  if (!isAbsolute(root) || resolve(root) !== resolve(repositoryPath)) {
    throw new ControlError("CHECKOUT_ROOT_MISMATCH", "Repository path is not the exact checkout root");
  }
  const fetch = remoteLines(await runner.run(
    "git",
    ["remote", "get-url", "--all", "origin"],
    { cwd: repositoryPath },
  ));
  const push = remoteLines(await runner.run(
    "git",
    ["remote", "get-url", "--push", "--all", "origin"],
    { cwd: repositoryPath },
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
```

Replace the private `GitHubSourceService.checkoutSlug` body with:

```ts
return githubSlugFromCheckout(this.options.runner, repositoryPath);
```

This keeps one implementation of exact-root, cardinality, canonical-URL, and fetch/push agreement rules.

- [ ] **Step 4: Carry the pinned canonical slug through internal current-context inputs**

Extend the source callback type and projection:

```ts
export interface ResolvedTaskStatusContext {
  project_id: string;
  repo_id: string;
  repository_slug: string;
}

const resolved = {
  project_id: context.project_id,
  repo_id: context.repo_id,
  repository_slug: context.repository.slug,
};
```

Add `repository_slug: string` to `CurrentTaskContextInput`, pass it from `cli.ts`, and change the port and call to:

```ts
claimsMappedToCheckout(
  claims: readonly ActiveClaim[],
  repositoryPath: string,
  repositorySlug: string,
): Promise<ReadonlySet<string>>;

const worktreeMatches = await this.worktrees.claimsMappedToCheckout(
  repositoryClaims,
  input.repository_path,
  input.repository_slug,
);
```

Update source, service, CLI, sensitive-data, and Phase 1A fixtures with the complete internal context. Keep all public result literals unchanged and use exact equality where a success projection is asserted.

- [ ] **Step 5: Reject mapping-owned canonical-origin disagreement**

Import `githubSlugFromCheckout` into `worktree.ts`, make `claimsMappedToCheckout` require `repositorySlug`, and after validating the mapping's stored root/common-directory identity and exact Claim generation, resolve the mapping-owned checkout slug. Convert any resolver failure or slug disagreement to the existing bounded error:

```ts
let mappedRepositorySlug: string;
try {
  mappedRepositorySlug = await githubSlugFromCheckout(this.runner, mapping.repository_path);
} catch {
  throw new ControlError(
    "WORKTREE_REPOSITORY_MISMATCH",
    "Mapped repository does not have one canonical GitHub origin",
    { worktree_ref: claim.worktree_ref },
  );
}
if (mappedRepositorySlug.toLowerCase() !== repositorySlug.toLowerCase()) {
  throw new ControlError(
    "WORKTREE_REPOSITORY_MISMATCH",
    "Mapped repository origin disagrees with the pinned Repository",
    { worktree_ref: claim.worktree_ref },
  );
}
```

Perform this check before `verifyWorktree` and before final exact-root classification. Do not persist the slug or remote URL.

- [ ] **Step 6: Add integration and privacy regression assertions**

Update `github-source.test.ts` to expect the pinned internal value:

```ts
expect(result).toEqual({
  project_id: "prj-wlan",
  repo_id: "repo-wlan",
  repository_slug: "jhw7500/wlan",
});
```

Keep the independent-clone worktree test passing with identical canonical origins and different Git common directories. In `cli.test.ts` and `phase1a.e2e.test.ts`, assert the service receives `repository_slug` internally while the exact public JSON result has no `repository_slug`, remote URL, `session_id`, or absolute repository/worktree path.

- [ ] **Step 7: Run focused GREEN verification**

Working directory: `mcp-server`

```bash
rtk npm test -- src/control/__tests__/worktree.test.ts src/control/__tests__/github-source.test.ts src/control/__tests__/task-service.test.ts src/control/__tests__/cli.test.ts src/control/__tests__/phase1a.e2e.test.ts
rtk npm run typecheck
```

Expected: all selected test files pass and TypeScript reports no errors.

- [ ] **Step 8: Run the complete repository gates**

From `mcp-server`:

```bash
rtk npm run typecheck
rtk npm run build
rtk npm test
```

From the repository root:

```bash
rtk node scripts/test-review-skill-contract.mjs
rtk node scripts/sync-codex-skills.mjs --check
rtk bash scripts/test-install-safety.sh
rtk git diff --check
```

Expected: every command exits 0. Record the exact test-file and test-count summary; keep any pre-existing Node FileHandle deprecation warning visible rather than suppressing it.

- [ ] **Step 9: Commit the focused fix**

```bash
rtk git add mcp-server/src/control/github-source.ts mcp-server/src/control/worktree.ts mcp-server/src/control/task-service.ts mcp-server/src/control/cli.ts mcp-server/src/control/__tests__/github-source.test.ts mcp-server/src/control/__tests__/worktree.test.ts mcp-server/src/control/__tests__/task-service.test.ts mcp-server/src/control/__tests__/cli.test.ts mcp-server/src/control/__tests__/phase1a.e2e.test.ts
rtk git commit -m "fix(control): bind current context to repository origin"
```
