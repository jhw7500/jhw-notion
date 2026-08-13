# Project Control Phase 1A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single-build-server Phase 1A tooling needed to trial canonical Registry identities, ownership-safe Task Claims, isolated worktrees, bounded portfolio recall/export, and Notion authority guards without changing the current authority or performing a production cutover.

**Architecture:** Add a framework-free TypeScript control-plane CLI inside the existing `mcp-server` package so the repository keeps one Node toolchain and one install path. The CLI treats a separate private Registry Git checkout as durable state, serializes all Phase 1A mutations with host `flock`, rejects remote divergence instead of retrying, and uses `gh api` only for personal GitHub Project/Issue operations. Existing MCP tools remain the Notion interface, but a central authority-policy reader adds fail-closed write guards that are exercised while the policy remains `legacy`.

**Tech Stack:** TypeScript 5.5 strict ESM, Node.js 20 built-ins, Vitest 4, Git CLI, GitHub CLI (`gh`), Linux `flock`, existing MCP SDK/Zod dependencies.

## Global Constraints

- Phase 1A runs on the current build server only; cross-host Claim retry and durable cross-host Handoff are Phase 1B work.
- The current Notion workspace remains authoritative throughout Phase 1A; Registry and GitHub Project records are marked `trial`.
- Never auto-inject old sessions, raw Evidence, or full timelines into AI context.
- Everyday AI payloads are capped at 12 KiB or 20 items, whichever is reached first, and include truncation metadata plus page IDs.
- Use canonical `prj-*`, `repo-*`, `tsk-<UUIDv7>`, and `clm-<UUIDv7>` identities. Human Issue numbers and temporary names are aliases only.
- Persistent Tasks live separately from active and historical Claims.
- Every Registry mutation is one fast-forward transaction. Phase 1A fails on remote divergence and never rebases, retries, or force-pushes.
- No heartbeat, TTL, automatic takeover, distributed lease service, Context Gateway, object store, or automatic restore tool.
- Do not create GitHub-hosted Actions workflows or spend GitHub Actions minutes.
- Personal Project access uses a short-lived host-only classic PAT. Registry Issue/API access uses a separate repository-scoped credential where possible; Registry Git should use a repository-specific SSH credential.
- Secrets never appear in Git, Handoff, snapshot, logs, command output, or AI context.
- ESM imports include `.js`; production files use named exports; tests are written before implementation.
- Required verification after every code task: `cd mcp-server && npm test && npm run build`.
- Do not modify or stage the unrelated untracked `docs/notion-architecture-review.md`.

## Scope Boundary

This plan implements **Phase 1A tooling and dry-run readiness only**. It does not switch `governance/authority.yaml` to `registry`, migrate existing Notion records, enable cross-host non-fast-forward retry, schedule daily snapshots, or declare the two-week Phase 1B scorecard successful. Those require separate plans after three natural Phase 1A Task cycles demonstrate acceptable friction.

## Planned File Structure

```text
mcp-server/src/control/
  authority.ts          central authority epoch reader and local safety cache
  catalog.ts            Repository/Task/source-index registration and promotion
  claim-service.ts      Claim, finish, recovery, takeover, and history rules
  cli.ts                argument parsing, command dispatch, exit codes
  codec.ts              canonical JSON-subset-of-YAML read/write helpers
  config.ts             non-secret build-server paths and GitHub coordinates
  errors.ts             stable typed control-plane errors
  github-project.ts     gh GraphQL adapter and five-field Project model
  handoff.ts            bounded incomplete-work Handoff construction
  ids.ts                prefixed UUIDv7 and source-index keys
  journal.ts            redacted Phase 1A measurement journal
  portfolio.ts          bounded status and snapshot/Markdown export
  process.ts            injectable subprocess runner
  registry-git.ts       clean-checkout, flock, fast-forward transaction protocol
  schemas.ts            Zod records for authority, project, repository, task, claim
  task-service.ts       Claim plus worktree orchestration used by CLI
  worktree.ts           branch/worktree lifecycle and host-local mapping
mcp-server/src/control/__tests__/
  helpers.ts
  authority.test.ts
  catalog.test.ts
  claim-service.test.ts
  cli.test.ts
  github-project.test.ts
  ids.test.ts
  phase1a.e2e.test.ts
  portfolio.test.ts
  registry-git.test.ts
  task-service.test.ts
  worktree.test.ts
mcp-server/src/notion/authority-guard.ts
mcp-server/src/notion/__tests__/authority-guard.test.ts
skills/claude/task.md
skills/claude/portfolio.md
docs/project-control/phase1a-runbook.md
```

The `.yaml` Registry files use the canonical JSON subset of YAML 1.2 during Phase 1A. This keeps them human-readable and valid YAML without adding a parser dependency; `codec.ts` accepts only this deterministic subset.

---

### Task 1: Domain schemas, canonical IDs, and deterministic Registry codec

**Files:**
- Create: `mcp-server/src/control/errors.ts`
- Create: `mcp-server/src/control/ids.ts`
- Create: `mcp-server/src/control/schemas.ts`
- Create: `mcp-server/src/control/codec.ts`
- Create: `mcp-server/src/control/__tests__/ids.test.ts`
- Create: `mcp-server/src/control/__tests__/codec.test.ts`

**Interfaces:**
- Produces: `newProjectId(slug: string): string`, `newRepositoryId(slug: string): string`, `newTaskId(now?: number): string`, `newClaimId(now?: number): string`, `sourceIndexKey(nodeId: string): string`.
- Produces: `AuthorityRecord`, `RepositoryRecord`, `TaskRecord`, `ActiveClaim`, `ClaimHistory`, `ProjectOperationalFields`, and their exported Zod schemas.
- Produces: `readRecord<T>(path, schema): Promise<T>` and `writeRecord(path, value): Promise<void>`.

- [ ] **Step 1: Write failing ID and codec tests**

```ts
import { describe, expect, it } from "vitest";
import { newClaimId, newTaskId, sourceIndexKey } from "../ids.js";

it("creates RFC 9562 UUIDv7 IDs with prefixes", () => {
  expect(newTaskId(1_723_516_800_000)).toMatch(
    /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(newClaimId(1_723_516_800_000)).toMatch(/^clm-.*-7.*$/);
});

it("encodes immutable source IDs as path-safe keys", () => {
  expect(sourceIndexKey("I_kwDOAb+/=")).toBe("SV9rd0RPQWIrLz0");
});
```

```ts
import { expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryRecordSchema } from "../schemas.js";
import { readRecord, writeRecord } from "../codec.js";

it("round-trips deterministic JSON-subset YAML with a trailing newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "jhw-codec-"));
  const file = join(root, "repositories", "repo-a.yaml");
  const value = { id: "repo-a", github_node_id: "R_1", slug: "jhw/a" };
  await writeRecord(file, value);
  expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
  expect(await readRecord(file, RepositoryRecordSchema)).toEqual(value);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd mcp-server && npx vitest run src/control/__tests__/ids.test.ts src/control/__tests__/codec.test.ts`

Expected: FAIL because the control modules do not exist.

- [ ] **Step 3: Implement prefixed UUIDv7 and stable source keys**

```ts
import { randomBytes } from "node:crypto";

function uuid7(now = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(now);
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const newTaskId = (now?: number) => `tsk-${uuid7(now)}`;
export const newClaimId = (now?: number) => `clm-${uuid7(now)}`;
export const sourceIndexKey = (nodeId: string) => Buffer.from(nodeId).toString("base64url");
```

Add slug validation (`^[a-z0-9][a-z0-9-]{1,62}$`) for project/repository IDs. Define discriminated formal/temporary Task schemas so formal Tasks contain only source identity/URL/project/repository/aliases, while temporary Tasks additionally own goal, done conditions, scope, and lifecycle. Define `ActiveClaimSchema` with immutable `claim_id`, owner session/host, branch/worktree reference, and start time. Define history statuses exactly as `completed | handoff | abandoned | force-ended | taken-over`.

- [ ] **Step 4: Implement strict codec and typed errors**

```ts
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
```

`readRecord` must parse JSON, validate with the supplied Zod schema, and return `INVALID_RECORD` with the file path on failure. `writeRecord` must create the parent directory, write a same-directory temporary file with mode `0600`, `fsync`, and rename atomically.

- [ ] **Step 5: Run tests, full suite, and build**

Run: `cd mcp-server && npm test && npm run build`

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/control
git commit -m "feat(control): define registry domain records"
```

---

### Task 2: Non-secret configuration, redacted process runner, and host-global lock

**Files:**
- Create: `mcp-server/src/control/config.ts`
- Create: `mcp-server/src/control/process.ts`
- Create: `mcp-server/src/control/__tests__/process.test.ts`
- Modify: `mcp-server/.env.example`

**Interfaces:**
- Produces: `loadControlConfig(env?: NodeJS.ProcessEnv): ControlConfig`.
- Produces: `ProcessRunner.run(command, args, options): Promise<ProcessResult>`.
- Produces: `reexecUnderMutationLock(argv: string[], config: ControlConfig): never | void`.
- Produces test helpers: `git(cwd, ...args)`, `commitFile(cwd, path, content)`, `makeRegistryFixture()`, and `configFor(registryDir)` in `mcp-server/src/control/__tests__/helpers.ts`.

- [ ] **Step 1: Write failing config and redaction tests**

```ts
it("never includes secret environment values in a failed command", async () => {
  const runner = new ProcessRunner({ GH_PROJECT_TOKEN: "secret-project-token" });
  const error = await runner
    .run("bash", ["-c", "echo boom >&2; exit 2"])
    .catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "COMMAND_FAILED" });
  expect(JSON.stringify(error)).not.toContain("secret-project-token");
});

it("requires build-server coordinates but not tokens in config files", () => {
  const c = loadControlConfig({
    HOME: "/home/jhw",
    JHW_REGISTRY_DIR: "/srv/jhw/project-registry",
    JHW_WORKTREE_ROOT: "/srv/jhw/worktrees",
    JHW_BUILD_HOST: "cantopsbuildserver",
    JHW_GITHUB_OWNER: "jhw7500",
    JHW_PROJECT_NUMBER: "7",
  });
  expect(c.registryBranch).toBe("main");
  expect(JSON.stringify(c)).not.toContain("TOKEN");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd mcp-server && npx vitest run src/control/__tests__/process.test.ts`

Expected: FAIL because `config.ts` and `process.ts` do not exist.

- [ ] **Step 3: Implement configuration and subprocess boundaries**

Use these exact environment keys:

```text
JHW_REGISTRY_DIR
JHW_REGISTRY_REMOTE=origin
JHW_REGISTRY_BRANCH=main
JHW_WORKTREE_ROOT
JHW_BUILD_HOST
JHW_GITHUB_OWNER
JHW_PROJECT_NUMBER
JHW_CONTROL_STATE_DIR=$HOME/.local/state/jhw-control
GH_PROJECT_TOKEN
GH_REPO_TOKEN
```

The first seven values are non-secret configuration. Tokens are read only when constructing the environment for a `gh` child process and are absent from `ControlConfig`, logs, journals, errors, and snapshots. `ProcessRunner` uses `spawn`, captures bounded stdout/stderr (1 MiB each), reports command and exit code, and redacts values of all environment keys ending in `_TOKEN`, `_KEY`, or `_SECRET`.

Add `mcp-server/src/control/__tests__/helpers.ts` with subprocess-backed `git`, temporary bare-remote/two-clone setup, deterministic commit identity (`Phase1A Test <phase1a@example.invalid>`), file commit helper, and `ControlConfig` construction. Later test tasks import these helpers rather than redefining Git fixtures.

- [ ] **Step 4: Implement mutation re-exec through Linux `flock`**

```ts
export function reexecUnderMutationLock(argv: string[], config: ControlConfig): void {
  if (process.env.JHW_CONTROL_LOCK_HELD === "1") return;
  const lock = join(config.stateDir, "registry.lock");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const child = spawnSync(
    "flock",
    ["-n", lock, process.execPath, fileURLToPath(import.meta.url), ...argv],
    { stdio: "inherit", env: { ...process.env, JHW_CONTROL_LOCK_HELD: "1" } },
  );
  process.exit(child.status ?? 75);
}
```

Apply it only to mutating commands: project/repository/task registration, task start/finish/recover mutations, and portfolio field mutation. Status/export remain lock-free. Exit code `75` means temporary lock contention.

- [ ] **Step 5: Document non-secret variables only**

Add the seven non-secret keys to `mcp-server/.env.example`. Add comments that `GH_PROJECT_TOKEN` and `GH_REPO_TOKEN` must be injected by the host credential store rather than committed to `.env`.

- [ ] **Step 6: Verify and commit**

Run: `cd mcp-server && npm test && npm run build`

```bash
git add mcp-server/src/control mcp-server/.env.example
git commit -m "feat(control): add secure host command boundary"
```

---

### Task 3: Fast-forward Registry transaction and canonical catalog

**Files:**
- Create: `mcp-server/src/control/registry-git.ts`
- Create: `mcp-server/src/control/catalog.ts`
- Create: `mcp-server/src/control/__tests__/registry-git.test.ts`
- Create: `mcp-server/src/control/__tests__/catalog.test.ts`

**Interfaces:**
- Produces: `RegistryGit.transact(message, mutate): Promise<{ commit: string; changed: boolean }>`.
- Produces: `Catalog.registerRepository`, `registerFormalTask`, `registerTemporaryTask`, `promoteTemporaryTask`, `getTask`.
- Consumes: schemas, codec, IDs, config, and process runner from Tasks 1–2.

- [ ] **Step 1: Write failing transaction tests using a temporary bare remote**

```ts
it("rejects a dirty checkout and remote divergence without rebase or force", async () => {
  const { remote, first, second } = await makeRegistryFixture();
  await commitFile(second, "governance/other.json", "{}\n");
  await git(second, "push", "origin", "main");
  const registry = new RegistryGit(configFor(first), runner);
  await expect(registry.transact("test", async () => undefined)).rejects.toMatchObject({
    code: "REMOTE_DIVERGED",
  });
  expect(await git(first, "status", "--porcelain")).toBe("");
});
```

Also test a clean transaction creates one commit, pushes fast-forward, refetches, and verifies local HEAD equals `origin/main`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd mcp-server && npx vitest run src/control/__tests__/registry-git.test.ts src/control/__tests__/catalog.test.ts`

Expected: FAIL because Registry transaction and catalog modules do not exist.

- [ ] **Step 3: Implement the Phase 1A transaction protocol**

`RegistryGit.transact` must execute this exact sequence while the CLI process already holds the host lock:

1. `git status --porcelain` and reject any pre-existing change as `REGISTRY_DIRTY`.
2. `git fetch <remote> <branch>`.
3. compare `git rev-parse HEAD` to `git rev-parse <remote>/<branch>`; reject mismatch as `REMOTE_DIVERGED`.
4. run the mutation callback.
5. if no files changed, return the existing commit as an idempotent success.
6. `git add --` only paths returned by the mutation callback.
7. commit with the supplied operation message.
8. push `HEAD:<branch>` without force.
9. fetch and verify local HEAD equals remote branch; otherwise return `REMOTE_VERIFY_FAILED`.

A rejected push becomes `REMOTE_DIVERGED`; Phase 1A does not retry.

- [ ] **Step 4: Write catalog collision tests**

Cover these exact cases:

```ts
it("adopts the existing Task ID for an already indexed Issue", async () => {
  const issueInput = {
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    issue_node_id: "I_kwDOExample",
    issue_revision: "2026-08-13T00:00:00Z",
    issue_url: "https://github.com/jhw7500/wlan/issues/1",
    alias: "jhw7500/wlan#1",
  };
  const a = await catalog.registerFormalTask(issueInput);
  const b = await catalog.registerFormalTask(issueInput);
  expect(b.task.id).toBe(a.task.id);
  expect(b.created).toBe(false);
});

it("refuses promotion when the Issue maps to another Task", async () => {
  const tempInput = {
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    alias: "wlan:tmp-20260813-01-fix",
    goal: "fix roaming regression",
    done_conditions: ["targeted test passes"],
    expected_scope: ["src/roaming.ts"],
  };
  const issueInput = {
    project_id: "prj-wlan",
    repo_id: "repo-wlan",
    issue_node_id: "I_kwDOExample",
    issue_revision: "2026-08-13T00:00:00Z",
    issue_url: "https://github.com/jhw7500/wlan/issues/1",
    alias: "jhw7500/wlan#1",
  };
  const temp = await catalog.registerTemporaryTask(tempInput);
  await catalog.registerFormalTask(issueInput);
  await expect(catalog.promoteTemporaryTask(temp.id, issueInput)).rejects.toMatchObject({
    code: "SOURCE_ALREADY_MAPPED",
  });
});
```

Also test one Repository node ID maps to one `repo_id`, while many Project Records may reference that ID.

- [ ] **Step 5: Implement catalog paths and atomic source registration**

Use these exact paths:

```text
repositories/<repo_id>.yaml
repositories/by-source/github/<base64url-node-id>.yaml
tasks/<task_id>.yaml
tasks/by-source/github/<base64url-node-id>.yaml
```

Repository and source-index creation occur in one Registry transaction. Formal Task registration stores only canonical ID, immutable Issue node ID/revision, aliases, `project_id`, `repo_id`, and URL. Temporary Task registration owns goal, done conditions, expected scope, and lifecycle. Promotion updates the source index and Task in one transaction, succeeds idempotently for the same ID, and fails closed for a different mapped ID without changing either record.

- [ ] **Step 6: Verify and commit**

Run: `cd mcp-server && npm test && npm run build`

```bash
git add mcp-server/src/control
git commit -m "feat(control): add canonical registry catalog"
```

---

### Task 4: Claim lifecycle with conditional release and manual recovery

**Files:**
- Create: `mcp-server/src/control/claim-service.ts`
- Create: `mcp-server/src/control/__tests__/claim-service.test.ts`

**Interfaces:**
- Produces: `claimTask(input): Promise<ActiveClaim>`.
- Produces: `finishClaim(taskId, expectedClaimId, outcome): Promise<ClaimHistory>`.
- Produces: `recoverClaim(taskId, expectedClaimId, action): Promise<RecoveryResult>`.
- Produces: `assertOwner(taskId, expectedClaimId): Promise<ActiveClaim>`.

- [ ] **Step 1: Write failing ownership tests**

```ts
it("rejects a second active Claim for the same canonical Task", async () => {
  const ownerA = claimInput({ session_id: "codex-a" });
  const ownerB = claimInput({ session_id: "codex-b" });
  const first = await claims.claimTask(ownerA);
  await expect(claims.claimTask(ownerB)).rejects.toMatchObject({ code: "TASK_ALREADY_CLAIMED" });
  expect((await claims.getActive(first.task_id))?.claim_id).toBe(first.claim_id);
});

it("cannot release a Claim owned by another generation", async () => {
  const ownerA = claimInput({ session_id: "codex-a" });
  const first = await claims.claimTask(ownerA);
  await expect(
    claims.finishClaim(first.task_id, "clm-00000000-0000-7000-8000-000000000000", {
      status: "completed",
      branch: "task/example",
      head_sha: "0123456789abcdef",
      validation: ["npm test: pass"],
    }),
  ).rejects.toMatchObject({ code: "CLAIM_MISMATCH" });
});

it("takeover archives the old Claim and installs a fresh Claim ID atomically", async () => {
  const ownerA = claimInput({ session_id: "codex-a" });
  const first = await claims.claimTask(ownerA);
  const recovered = await claims.recoverClaim(first.task_id, first.claim_id, {
    kind: "takeover",
    session_id: "codex-new",
  });
  expect(recovered.active.claim_id).not.toBe(first.claim_id);
  await expect(claims.assertOwner(first.task_id, first.claim_id)).rejects.toMatchObject({
    code: "CLAIM_MISMATCH",
  });
});
```

In this test file, `claimInput({session_id})` is a local factory returning the already-seeded canonical Task ID, `prj-wlan`, `repo-wlan`, build host, deterministic branch/worktree reference, and the supplied session. It never supplies a `claim_id`; the service must generate it.

- [ ] **Step 2: Run focused test and verify RED**

Run: `cd mcp-server && npx vitest run src/control/__tests__/claim-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement active/history Claim transactions**

Use paths:

```text
claims/active/<task_id>.yaml
claims/history/<YYYY>/<task_id>/<claim_id>.yaml
handoffs/<task_id>/<claim_id>.md
```

`claimTask` checks that the persistent Task exists and the active Claim does not, writes a fresh Claim, pushes, then refetches and validates both `task_id` and `claim_id`. `finishClaim` compares the expected Claim ID, writes history with start/release timestamps, outcome, branch, head SHA, validation summary and optional Handoff pointer, and removes the active Claim in the same transaction. Persistent Tasks are never removed.

`recoverClaim(..., {kind: "status"})` performs no mutation and reports active Claim, recorded host/session, local process existence, worktree mapping, dirty state, and unpushed commits. `{kind: "force-end"}` archives/removes only the expected Claim. `{kind: "takeover"}` archives the expected old Claim as `taken-over` and installs a fresh `claim_id`, session, and host in one transaction.

- [ ] **Step 4: Verify and commit**

Run: `cd mcp-server && npm test && npm run build`

```bash
git add mcp-server/src/control
git commit -m "feat(control): add ownership-safe task claims"
```

---

### Task 5: Worktree, Handoff, and high-level Task orchestration

**Files:**
- Create: `mcp-server/src/control/worktree.ts`
- Create: `mcp-server/src/control/handoff.ts`
- Create: `mcp-server/src/control/task-service.ts`
- Create: `mcp-server/src/control/__tests__/worktree.test.ts`
- Create: `mcp-server/src/control/__tests__/task-service.test.ts`

**Interfaces:**
- Produces: `WorktreeManager.createOrReuse`, `inspect`, and `removeIfSafe`.
- Produces: `buildHandoff(input): string` capped at 12 KiB.
- Produces: `TaskService.start`, `status`, `finish`, `recover`, `assertOwner`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it("claims before creating a worktree and abandons the Claim if creation fails", async () => {
  worktrees.createOrReuse.mockRejectedValue(new Error("worktree failed"));
  await expect(tasks.start(startInput)).rejects.toThrow("worktree failed");
  expect(claims.claimTask).toHaveBeenCalledBefore(worktrees.createOrReuse);
  expect(claims.finishClaim).toHaveBeenCalledWith(
    expect.any(String), expect.any(String), expect.objectContaining({ status: "abandoned" }),
  );
});

it("keeps an incomplete same-host worktree and writes a durable Registry Handoff", async () => {
  const result = await tasks.finish({
    task_id: "tsk-a",
    claim_id: "clm-a",
    status: "handoff",
    validation: ["npm test: pass"],
  });
  expect(result.history.handoff_pointer).toBe("handoffs/tsk-a/clm-a.md");
  expect(worktrees.removeIfSafe).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd mcp-server && npx vitest run src/control/__tests__/worktree.test.ts src/control/__tests__/task-service.test.ts`

Expected: FAIL because worktree orchestration is absent.

- [ ] **Step 3: Implement host-local worktree mappings**

Store actual absolute paths in `${JHW_CONTROL_STATE_DIR}/worktrees.json` with directory mode `0700` and file mode `0600`; Claims contain only a logical `worktree_ref`. Branch names use `task/<task-id-suffix>-<sanitized-alias>`. `createOrReuse` reuses an existing same-host incomplete Task worktree after verifying branch and repository identity. New worktrees use `git -C <repo> worktree add -b <branch> <path> HEAD`.

`inspect` reports dirty files and ahead/behind counts. `removeIfSafe` rejects dirty files or unpushed commits. Worktree removal never releases a Claim.

- [ ] **Step 4: Implement bounded Handoff and ordered finish**

A Handoff contains exactly:

```markdown
# Handoff: tsk-...
source_task_id: tsk-...
source_task_revision: ...
claim_id: clm-...
generated_at: ...

## Progress Since Last Checkpoint
## Git State
## Validation Performed
## Failures and Uncertainty
## Session-Local Next Step
## Related ADR and Evidence
```

It does not duplicate goal, done conditions, official lifecycle, or full session history. It writes `.ai/handoff.md` in the worktree and a Claim-scoped Registry copy before release. Same-host Phase 1A permits a local checkpoint commit. `completed` writes result/validation/history, conditionally releases, then removes only a safe worktree. `handoff` retains the worktree. `abandoned` records history and removes only if safe.

- [ ] **Step 5: Verify and commit**

Run: `cd mcp-server && npm test && npm run build`

```bash
git add mcp-server/src/control
git commit -m "feat(control): orchestrate claims and worktrees"
```

---

### Task 6: Explicit CLI commands and redacted pilot measurement journal

**Files:**
- Create: `mcp-server/src/control/journal.ts`
- Create: `mcp-server/src/control/cli.ts`
- Create: `mcp-server/src/control/__tests__/cli.test.ts`
- Modify: `mcp-server/package.json`

**Interfaces:**
- Produces executable: `mcp-server/dist/control/cli.js` installed as `jhw-control`.
- Produces testable dispatcher: `runCli(argv: string[], dependencies: CliDependencies): Promise<CliResult>`; only the shebang entry calls `process.exit`.
- Produces exact commands: `task start`, `task status`, `task finish`, `task recover`, `task assert-owner`, `portfolio status`, `portfolio export`, `project register`, `preflight`.

- [ ] **Step 1: Write failing CLI contract tests**

```ts
it("returns stable JSON and exit code 4 for a Claim conflict", async () => {
  const dependencies = makeCliDependencies({
    taskService: {
      start: async () => { throw new ControlError("TASK_ALREADY_CLAIMED", "occupied"); },
    },
  });
  const result = await runCli(["task", "start", "--task", "tsk-a"], dependencies);
  expect(result.exitCode).toBe(4);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "TASK_ALREADY_CLAIMED" } });
});

it("never writes tokens to output or measurement journal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "jhw-cli-"));
  const result = await runCli(["portfolio", "status"], makeCliDependencies({
    stateDir,
    env: { GH_PROJECT_TOKEN: "secret-token" },
  }));
  const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");
  expect(`${result.stdout}${result.stderr}${journal}`).not.toContain("secret-token");
});
```

- [ ] **Step 2: Run focused test and verify RED**

Run: `cd mcp-server && npx vitest run src/control/__tests__/cli.test.ts`

Expected: FAIL because the CLI does not exist.

- [ ] **Step 3: Implement strict command parsing without a new framework**

Accept these Phase 1A forms:

```text
jhw-control task start --project prj-x --repo-id repo-x --repo-path /src/x --issue-node-id I_x --issue-url https://github.com/o/r/issues/1 --issue-revision 2026-08-13T00:00:00Z --session codex-123
jhw-control task start --project prj-x --repo-id repo-x --repo-path /src/x --temp-alias x:tmp-20260813-01-fix --goal "fix" --done "test passes" --scope "src/a.ts" --session codex-123
jhw-control task status --task tsk-... [--claim clm-...]
jhw-control task finish --task tsk-... --claim clm-... --status completed|handoff|abandoned --validation "npm test: pass"
jhw-control task recover --task tsk-... --expect clm-... --action status|force-end|takeover --session codex-new
jhw-control task assert-owner --task tsk-... --claim clm-...
jhw-control portfolio status [--project prj-x] [--page page-id]
jhw-control portfolio export
jhw-control preflight
```

Unknown flags, missing required values, invalid IDs, or mixed formal/temporary Task arguments exit `2`. Claim conflicts exit `4`; remote divergence/lock contention exit `75`; unavailable authority or credentials exit `78`; unexpected failures exit `1`. Success output is JSON on stdout; errors are JSON on stderr.

- [ ] **Step 4: Implement the measurement journal**

Append one JSON line per command to `${JHW_CONTROL_STATE_DIR}/pilot-journal.jsonl` with mode `0600`:

```ts
interface JournalEvent {
  command: string;
  task_id?: string;
  claim_id?: string;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  ok: boolean;
  error_code?: string;
  bypass_reason?: string;
  payload_bytes: number;
}
```

Do not record raw arguments, goals, paths, Handoff bodies, GitHub responses, environment values, or tokens. `task finish` accepts `--active-work-minutes <positive-number>` and records that number for the Phase 1A friction score.

- [ ] **Step 5: Wire the executable**

Add a shebang to `cli.ts` and this package entry:

```json
{
  "bin": { "jhw-control": "dist/control/cli.js" }
}
```

Run `npm install --package-lock-only` after changing `package.json` so the root package metadata in `package-lock.json` matches the executable declaration without adding dependencies.

- [ ] **Step 6: Verify and commit**

Run: `cd mcp-server && npm test && npm run build && node dist/control/cli.js --help`

Expected: tests/build PASS; help lists the exact Phase 1A commands and contains no environment values.

```bash
git add mcp-server/src/control mcp-server/package.json mcp-server/package-lock.json
git commit -m "feat(control): expose explicit phase1a commands"
```

---

### Task 7: GitHub Project adapter, bounded portfolio status, and on-demand snapshot

**Files:**
- Create: `mcp-server/src/control/github-project.ts`
- Create: `mcp-server/src/control/portfolio.ts`
- Create: `mcp-server/src/control/__tests__/github-project.test.ts`
- Create: `mcp-server/src/control/__tests__/portfolio.test.ts`

**Interfaces:**
- Produces: `GitHubProjectClient.readAll(): Promise<ProjectSnapshotSource>` and `registerProject(input): Promise<ProjectRecordLink>`.
- Produces: `PortfolioService.status(projectId?, pageId?): Promise<BoundedPayload>`.
- Produces: `PortfolioService.exportSnapshot(): Promise<{ jsonPath; markdownPath; checksum }>`.

- [ ] **Step 1: Write failing pagination and cap tests**

```ts
it("continues until hasNextPage is false and rejects totalCount mismatch", async () => {
  const page1WithNextCursor = projectPageFixture({ count: 100, totalCount: 101, hasNextPage: true, endCursor: "c1" });
  const page2Final = projectPageFixture({ count: 1, totalCount: 101, hasNextPage: false, endCursor: null });
  gh.enqueue(page1WithNextCursor, page2Final);
  const source = await client.readAll();
  expect(source.items).toHaveLength(101);
  expect(gh.calls).toHaveLength(2);
  gh.enqueue({ ...page2Final, totalCount: 102 });
  await expect(client.readAll()).rejects.toMatchObject({ code: "INCOMPLETE_PROJECT_READ" });
});

it("caps portfolio markdown at 12 KiB or 20 items and emits page IDs", async () => {
  const output = await portfolio.status(undefined, undefined);
  expect(Buffer.byteLength(output.markdown)).toBeLessThanOrEqual(12 * 1024);
  expect(output.items).toHaveLength(20);
  expect(output).toMatchObject({ truncated: true, total_items: 23, next_page_id: "page-2" });
});
```

`projectPageFixture` and the queued fake `gh` runner are local test helpers in `github-project.test.ts`; the fixture emits the exact GraphQL `data.user.projectV2.fields` and `data.user.projectV2.items` shape consumed by `GitHubProjectClient`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd mcp-server && npx vitest run src/control/__tests__/github-project.test.ts src/control/__tests__/portfolio.test.ts`

Expected: FAIL because Project/portfolio modules do not exist.

- [ ] **Step 3: Implement the `gh api graphql` adapter**

Use `GH_PROJECT_TOKEN` only for the personal Project query/mutation process and `GH_REPO_TOKEN` only for Registry Issue operations. For each subprocess, map the selected source variable to child `GH_TOKEN` and omit both source token variables from the child environment. Query the configured personal Project by owner and number; enumerate field definitions, item IDs, source node IDs, and field values until `hasNextPage=false`. Fetch private Registry Issue title/body separately with the repository-scoped token and join by immutable source node ID, so the classic Project token never needs `repo`. Require exactly these user fields and option names:

```text
Status: proposed | active | paused | completed | cancelled
Priority: P0 | P1 | P2 | P3
Health: on-track | at-risk | blocked | unknown
Next Action: task:<canonical-task-id> | wait:<short-condition>
Last Reviewed: YYYY-MM-DD
```

The Project item title is the linked Project Record Issue title; do not create a duplicate Project/title custom field. `registerProject` creates a `trial`-labeled Issue in the private Registry repository with `id`, `objective`, and `repo_id` list, adds it to the Project, and writes the five fields. It rejects a non-canonical Task Next Action and computes stale using the shortest applicable cadence.

- [ ] **Step 4: Implement export integrity and paging**

Write snapshots below `${JHW_CONTROL_STATE_DIR}/snapshots/<generated-at>/` with directory `0700`, files `0600`, and a `current` pointer updated only after complete validation. `portfolio.json` includes `schema_version`, `generated_at`, source revision, field definitions/options, item/source IDs, total count, and SHA-256 checksum. `portfolio.md` is a bounded L0 index containing only IDs, title, Status, Priority, Health, Next Action, Last Reviewed, and stale warning. Extra items go to `portfolio.page-2.md`, `portfolio.page-3.md`, and so on.

Never include tokens, raw API responses, private absolute paths, raw Evidence, or Notion content. Export is one-way; no import path is implemented.

- [ ] **Step 5: Implement credential preflight**

`jhw-control preflight` must:

1. require distinct `GH_PROJECT_TOKEN` and `GH_REPO_TOKEN` values without printing either;
2. inspect classic PAT response scopes and reject `repo` on the Project token;
3. read the configured trial Project and its five field definitions;
4. update and restore `Last Reviewed` on a designated trial item to prove write access;
5. verify Registry Issue read/write with the repository-scoped token;
6. verify Registry Git fetch/push using its configured SSH remote;
7. fail closed if any check fails.

If personal Project mutation requires `repo`, report `PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE` and stop; do not add the scope automatically.

- [ ] **Step 6: Verify and commit**

Run: `cd mcp-server && npm test && npm run build`

```bash
git add mcp-server/src/control
git commit -m "feat(control): add bounded portfolio export"
```

---

### Task 8: Central authority epoch and server-side Notion write guards

**Files:**
- Create: `mcp-server/src/control/authority.ts`
- Create: `mcp-server/src/notion/authority-guard.ts`
- Create: `mcp-server/src/control/__tests__/authority.test.ts`
- Create: `mcp-server/src/notion/__tests__/authority-guard.test.ts`
- Modify: `mcp-server/src/tools/start.ts`
- Modify: `mcp-server/src/tools/close.ts`
- Modify: `mcp-server/src/tools/record.ts`
- Modify: `mcp-server/src/tools/delete.ts`
- Modify: `mcp-server/src/tools/append.ts`

**Interfaces:**
- Produces: `loadAuthorityPolicy(): Promise<AuthorityDecision>`.
- Produces injectable constructor: `createAuthorityService({ readCentral, cachePath, writesDisabled }): AuthorityService` for deterministic tests.
- Produces: `assertNotionWriteAllowed(db: DatabaseName, operation: string): Promise<void>`.
- Produces: `resolveTargetDatabase(pageId, notion): Promise<DatabaseName | "page">` for append/delete guards.

- [ ] **Step 1: Write failing epoch and rollback tests**

```ts
it("allows legacy mode but rejects Projects and Decision writes in registry mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "jhw-authority-"));
  const cachePath = join(root, "authority-cache.json");
  let central: AuthorityRecord = { authority_epoch: 1, mode: "legacy", cutover_at: null, minimum_tool_version: "1.0.0" };
  const service = createAuthorityService({ readCentral: async () => central, cachePath, writesDisabled: false });
  await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).resolves.toBeUndefined();
  central = { authority_epoch: 2, mode: "registry", cutover_at: "2026-08-20T00:00:00Z", minimum_tool_version: "1.1.0" };
  await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({ code: "AUTHORITY_MOVED" });
  await expect(service.assertNotionWriteAllowed("decisionLog", "jhw_record")).rejects.toMatchObject({ code: "AUTHORITY_MOVED" });
  await expect(service.assertNotionWriteAllowed("knowledgeBase", "jhw_record")).resolves.toBeUndefined();
});

it("rejects a lower central epoch and fails closed when cached registry authority is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "jhw-authority-"));
  const cachePath = join(root, "authority-cache.json");
  await writeFile(cachePath, JSON.stringify({ authority_epoch: 4, mode: "registry" }));
  let central: AuthorityRecord | null = { authority_epoch: 3, mode: "legacy", cutover_at: null, minimum_tool_version: "1.0.0" };
  const service = createAuthorityService({ readCentral: async () => central, cachePath, writesDisabled: false });
  await expect(service.load()).rejects.toMatchObject({ code: "AUTHORITY_EPOCH_ROLLBACK" });
  central = null;
  await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
    code: "AUTHORITY_UNAVAILABLE",
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd mcp-server && npx vitest run src/control/__tests__/authority.test.ts src/notion/__tests__/authority-guard.test.ts`

Expected: FAIL because no authority modules or guards exist.

- [ ] **Step 3: Implement central policy plus a monotonic local safety cache**

Read `governance/authority.yaml` from the Registry checkout using `AuthorityRecordSchema`:

```json
{
  "authority_epoch": 1,
  "mode": "legacy",
  "cutover_at": null,
  "minimum_tool_version": "1.0.0"
}
```

The central file is the only authority selector. `${JHW_CONTROL_STATE_DIR}/authority-cache.json` only remembers the highest observed epoch/mode to prevent a stale local checkout or outage from reopening Notion writes; it cannot select a lower/different authority. Local `writes_disabled=true` may block more writes but cannot enable them.

Before the first cutover, absence of both central record and cache permits legacy behavior for backward compatibility. Once a `registry` epoch has been observed, inability to read the same or higher central epoch rejects protected writes.

- [ ] **Step 4: Guard every protected Notion mutation before its first API write**

Apply guards as follows:

```text
start.ts              projects + decisionLog: reject entire operation in registry mode
close.ts              projects: reject entire operation before search/update/retro
record.ts             reject db=projects or db=decisionLog
append.ts             retrieve target page parent, reject projects/decisionLog targets
delete.ts             retrieve target page parent, reject projects/decisionLog targets
```

Knowledge Base Inbox, Preferences, References, and Reports remain allowed. Guard errors return stable structured MCP text containing the Registry routing instruction; warning-and-write behavior is forbidden.

- [ ] **Step 5: Extend existing tool tests**

For each protected tool, mock registry authority and assert the Notion client received zero mutation calls under `registry` mode. Also retain one legacy-mode happy-path test for each tool. The tests set registry mode only in fixtures; Phase 1A runtime configuration remains legacy.

- [ ] **Step 6: Verify and commit**

Run: `cd mcp-server && npm test && npm run build`

```bash
git add mcp-server/src/control mcp-server/src/notion mcp-server/src/tools
git commit -m "feat(control): fail closed on moved notion authority"
```

---

### Task 9: TUI skill surfaces, installation, and operator documentation

**Files:**
- Create: `skills/claude/task.md`
- Create: `skills/claude/portfolio.md`
- Modify: `skills/claude/project.md`
- Modify: `skills/claude/status.md`
- Modify: `install.sh`
- Modify: `README.md`
- Modify: `DESIGN.md`
- Create: `docs/project-control/phase1a-runbook.md`
- Regenerate: `skills/codex/jhw-task/`
- Regenerate: `skills/codex/jhw-portfolio/`

**Interfaces:**
- Produces explicit `/jhw:task` and `/jhw:portfolio` workflows that invoke `jhw-control`; neither auto-loads prior context.
- Produces installation/removal of `~/.local/bin/jhw-control`.

- [ ] **Step 1: Write skill behavior before installation changes**

`task.md` must require an explicit Task/Issue/temporary-work request, run `jhw-control task status` before resuming, show Claim owner conflicts without takeover, request user approval before `force-end` or `takeover`, and run `task assert-owner` before shared push/PR/merge/deploy. It must never auto-call recall or load session history.

`portfolio.md` must expose only `status`, `export`, and `preflight`; display truncation/page metadata; and fetch another page only when the user asks.

Update `project.md` and `status.md` to state that Phase 1A trial control uses the explicit new skills while existing Notion operations remain the live authority. Do not route normal `/jhw:project` writes to Registry in this plan.

- [ ] **Step 2: Regenerate and verify Codex skills**

Run:

```bash
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
```

Expected: generated `jhw-task` and `jhw-portfolio` skills exist and drift check exits 0.

- [ ] **Step 3: Add reversible CLI installation**

After `npm run build`, `install.sh` creates `~/.local/bin` and links `~/.local/bin/jhw-control` to `mcp-server/dist/control/cli.js`. On uninstall, remove it only when `readlink -f` resolves inside this repository. Preserve `install.sh` executable mode.

- [ ] **Step 4: Write the Phase 1A runbook**

Include exact sections:

1. prerequisites (`git`, `gh`, `flock`, Node 20, private Registry repo, trial personal Project);
2. non-secret config paths and host credential-store injection;
3. initialize `governance/authority.yaml` at epoch 1, mode `legacy`;
4. run `jhw-control preflight` and interpret all stable exit codes;
5. register only 2–3 active trial projects and their Repository Records;
6. capture five existing-Notion baseline lookups;
7. run exactly three natural Task cycles without fabricating work;
8. inspect Claim history, bypass reasons, elapsed admin time, and payload size;
9. stop if any duplicate Claim, wrong-owner release, Notion guard bypass, secret leak, or unacceptable friction occurs;
10. state that Phase 1B cutover requires a new approved plan.

- [ ] **Step 5: Update top-level architecture docs**

Document the separate Registry checkout, the control CLI, authority guard, explicit context flow, Phase 1A/1B boundary, personal Project PAT limitation, and why no Actions workflow exists. Keep `PLAN.md` described as the original snapshot rather than rewriting it as live truth.

- [ ] **Step 6: Verify install/uninstall/reinstall**

Run from a clean shell while preserving existing user configuration backups:

```bash
./install.sh --uninstall
./install.sh
test -x install.sh
test "$(readlink -f "$HOME/.local/bin/jhw-control")" = "$(readlink -f mcp-server/dist/control/cli.js)"
node scripts/sync-codex-skills.mjs --check
cd mcp-server && npm test && npm run build
```

Expected: uninstall removes only project-owned links/registrations; reinstall rebuilds and restores MCP/skill/CLI links; tests/build/drift check PASS.

- [ ] **Step 7: Commit**

```bash
git add install.sh README.md DESIGN.md docs/project-control skills/claude skills/codex
git commit -m "docs(control): add phase1a operator workflows"
```

---

### Task 10: Deterministic Phase 1A adversarial verification gate

**Files:**
- Create: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`
- Modify: `docs/project-control/phase1a-runbook.md`

**Interfaces:**
- Consumes all Phase 1A services and CLI commands.
- Produces a local-only test report with no credential or external GitHub dependency.

- [ ] **Step 1: Build a local fixture with a bare Registry, two clones, and fake `gh`**

The fixture creates:

```text
<tmp>/registry.git
<tmp>/clone-a
<tmp>/clone-b
<tmp>/source-repo
<tmp>/worktrees
<tmp>/state
<tmp>/bin/gh
```

The fake `gh` reads queued JSON responses from the fixture directory and records only operation names and non-secret variable keys. It must fail the test if a token value appears in captured output.

- [ ] **Step 2: Add all deterministic concurrency and recovery scenarios**

Implement separate tests for:

1. simultaneous registration of one GitHub Repository node ID leaves one Repository Record/source mapping;
2. simultaneous registration of one GitHub Issue node ID leaves one Task/source mapping;
3. promotion to an Issue already mapped to another Task fails without changing either Task;
4. two same-host processes claiming one canonical Task leave one active Claim;
5. Phase 1A remote divergence fails without rebase/retry/force;
6. wrong `claim_id` release and `assert-owner` fail;
7. simulated client death after successful Claim push is recoverable from remote state;
8. takeover archives old Claim, rotates `claim_id`, and invalidates old owner;
9. offline provisional work cannot be reported as claimed and cannot pass `assert-owner`;
10. Handoff release leaves persistent Task and same-host checkpoint/worktree state;
11. completed finish records history and refuses unsafe worktree removal;
12. portfolio output truncates at 12 KiB/20 items with page metadata;
13. cached registry authority rejects a lower legacy epoch and unavailable central policy;
14. Project token scope preflight rejects `repo` and never prints token values.

- [ ] **Step 3: Run the adversarial gate twice**

Run:

```bash
cd mcp-server
npx vitest run src/control/__tests__/phase1a.e2e.test.ts --repeat=2
npm test
npm run build
```

Expected: both adversarial repetitions, the full unit suite, and TypeScript build PASS with zero external network calls.

- [ ] **Step 4: Run repository-wide static checks**

Run:

```bash
git diff --check
node scripts/sync-codex-skills.mjs --check
bash -n install.sh
git status --short
```

Expected: no whitespace errors, no skill drift, valid shell syntax, and no `.env`, token, snapshot, state directory, or unrelated `docs/notion-architecture-review.md` in staged changes.

- [ ] **Step 5: Record the implementation stop condition in the runbook**

State that tooling completion does not equal Phase 1A pilot success. After merge, the operator runs preflight and three natural Task cycles. If those cycles do not occur, the evidence state is `insufficient evidence`; no Phase 1B plan or cutover may claim approval.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/control/__tests__/phase1a.e2e.test.ts docs/project-control/phase1a-runbook.md
git commit -m "test(control): gate phase1a concurrency and recovery"
```

---

## Spec Coverage Map

| Final design area | Implemented by this plan | Deferred with explicit reason |
|---|---|---|
| Authority map and physical Registry paths | Tasks 1, 3, 7, 8 | None for Phase 1A objects |
| Project/Repository canonical identity | Tasks 3 and 7 | Existing Notion bulk classification remains Phase 3 |
| Formal/temporary Task identity and Issue promotion | Tasks 1 and 3 | None |
| Single-writer Claim, recovery, takeover | Tasks 2, 4, 5, 10 | Cross-host retry, heartbeat, TTL remain evidence-gated |
| Worktree and incomplete Handoff | Task 5 | Cross-host branch-push Handoff is Phase 1B because Phase 1A is single-host |
| Portfolio fields, stale cadence, bounded Recall/export | Tasks 6 and 7 | Daily timer begins only at Phase 1B cutover |
| Notion authority boundary | Task 8 | Actual `legacy → registry` cutover and reverse-cutover are separate plans |
| Token/security boundary | Tasks 2, 6, 7, 10 | Organization Project/GitHub App considered only if personal Project isolation becomes mandatory |
| Snapshot integrity | Task 7 | Off-host backup and restore drill occur during the cutover pilot |
| Skills/install/operator flow | Task 9 | Automatic context injection is intentionally absent |
| Phase 1A evidence gates | Tasks 6, 9, 10 | Three natural cycles must be run by the operator after tooling merge |
| Knowledge/Evidence lifecycle | Existing design remains authoritative | No new catalog/object store is justified in Phase 1A |

Self-review found no uncovered Phase 1A requirement. Deferred rows match the final design's explicit phase or evidence gates and must not be pulled into this implementation batch.

---

## Final Self-Review Checklist

Before handing this plan to an implementation workflow, verify:

- Every persistent identity in the design has one file/path authority and every projection is read-only.
- Project Record references only `repo_id`; Repository node ID/slug mapping exists only in Repository Record/source index.
- Formal Task content remains in GitHub Issue; temporary Task content remains in Registry until successful promotion.
- Active Claim removal never removes the persistent Task.
- All release/takeover/shared-operation checks compare the expected immutable `claim_id`.
- Phase 1A host lock spans fetch/check/mutate/commit/push/refetch because the entire mutating CLI process runs under `flock`.
- Remote divergence has no retry path in Phase 1A.
- Notion remains authority and `governance/authority.yaml` remains `legacy` during the trial.
- Registry-mode tests prove fail-closed behavior but do not perform a real cutover.
- Portfolio and Handoff payload caps apply before AI output.
- Tokens and private paths are absent from all output, journal, snapshot, and tests.
- No GitHub-hosted workflow, heartbeat, TTL, distributed Lease, Gateway, object store, or auto-restore is introduced.
- Three natural Task cycles and the two-week cutover pilot are not fabricated by tests.
