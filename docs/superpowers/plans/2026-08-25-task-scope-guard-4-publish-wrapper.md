# Task Scope Guard 4: Guarded Publish Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Git push, PR creation/merge, and release publication execute only through a wrapper that re-resolves the live Claim/worktree/repository, re-normalizes the exact operation, and atomically consumes any one-time permit at process start.

**Architecture:** Add an execution authorization API to Guard, a publish-specific authority resolver, and an argv-only child runner. The TUI hook recognizes the wrapper but does not consume high-risk permits; `jhw-control guard with` performs the authoritative start transition immediately before spawn and records completion after child exit.

**Tech Stack:** TypeScript 5.5 ESM, Node.js child_process, Git CLI, GitHub CLI, existing ProcessRunner credential isolation, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-08-25-task-scope-guard-design.md`

## Global Constraints

- This is plan 4 of 6 and depends on plans 1–3.
- Hook ALLOW is never execution authority for publish operations.
- The wrapper accepts argv after `--`; it never evaluates a shell command string.
- Initial supported operations are `git push`, `gh pr create`, `gh pr merge`, and `gh release create` for the active Claim repository.
- Direct raw forms remain `GUARD_WRAPPER_REQUIRED`.
- `--force`, `--force-with-lease`, ref deletion, `--mirror`, pushing from another branch/worktree, and cross-repository targets are hard denied as destructive/precondition failures; prompt permits do not override them.
- The wrapper rechecks the current active Claim generation, session, configured host, branch, worktree, repository identity, normalized arguments, local HEAD, and resolved remote/PR/release coordinates.
- Permit matching binds the originating TUI adapter separately from the operation digest. The wrapper requires `--origin-adapter claude|codex|gemini|opencode`; it must match the operation. Only Claude/Codex can consume prompt-origin permits in the initial rollout, while an already in-contract execution may still pass the wrapper recheck from another adapter.
- A permit is consumed immediately before spawn. Spawn failure, nonzero exit, timeout, or signal still requires a new permit.
- Once consumed, the 10-minute start deadline is not checked again.
- Child stdout/stderr and exit status are operator output, not Guard journal data. Never persist them in permit state.
- Do not add generic SSH, board, firmware, deploy, Notion, or Issue execution here; later plans own those authorities.

---

### Task 1: Add execution-start authorization and receipt completion

**Files:**
- Modify: `mcp-server/src/control/guard-service.ts`
- Modify: `mcp-server/src/control/guard-protocol.ts`
- Modify: `mcp-server/src/control/guard-state.ts`
- Create: `mcp-server/src/control/__tests__/guard-execution.test.ts`
- Modify: `mcp-server/src/control/__tests__/guard-concurrency.test.ts`

**Interfaces:**
- Produces: `GuardService.beginExecution(input): Promise<GuardExecutionDecision>`.
- Produces: `GuardService.finishExecution(receipt, result): Promise<GuardExecutionCompletion>`.
- Produces: `GuardExecutionReceiptSchema`.
- Preserves: the approved request's origin adapter while recomputing with `evaluation_stage: "execution"`; stage is not part of the digest.

- [ ] **Step 1: Write failing execution boundary tests**

Cover:

- contract-covered publish returns an execution receipt without a permit;
- missing grant from Claude/Codex returns or reuses `PERMIT_REQUIRED`;
- missing grant from Gemini/OpenCode returns `GUARD_PROMPT_ORIGIN_UNSUPPORTED` without creating a request;
- an exact APPROVED request is consumed once at beginExecution;
- adapter, Task, Claim, session, worktree, requirement, argument, remote, HEAD, or digest change fails;
- a hook evaluation does not consume a publish permit;
- two concurrent beginExecution calls produce one receipt and one consumed/mismatch denial;
- finish after the start deadline succeeds because the receipt is already consumed;
- spawn failure finishes FAILED and cannot reapprove/reuse the same request;
- receipt completion can happen once only;
- journal failure returns a warning but does not change execution authority.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-execution.test.ts \
  src/control/__tests__/guard-concurrency.test.ts
```

- [ ] **Step 3: Define a bounded receipt**

```ts
export const GuardExecutionReceiptSchema = z.object({
  protocol_version: z.literal(1),
  operation_id: OperationIdSchema,
  execution_boundary: z.enum(["guarded_command", "tracker", "notion", "board"]),
  task_id: TaskIdSchema,
  claim_id: ClaimIdSchema,
  session_id: BoundedSessionSchema,
  origin_adapter: z.enum(["claude", "codex", "gemini", "opencode"]),
  operation_digest: z.string().regex(/^[0-9a-f]{64}$/),
  started_at: OffsetDateTimeSchema,
  request_id: RequestIdSchema.optional(),
}).strict();
```

Do not include argv, cwd, output, environment, or credentials.

- [ ] **Step 4: Re-run every hard invariant at beginExecution**

`beginExecution` must:

1. validate the boundary input;
2. resolve current Claim by Task/Claim/session/host;
3. inspect branch/worktree/cwd;
4. revalidate resource authority and active exclusive conflicts;
5. normalize and HMAC current execution inputs with the approved origin adapter and execution stage;
6. compare the immutable Claim contract;
7. when grants are missing, atomically consume one exact APPROVED request bound to `origin_adapter`;
8. return the receipt only after successful consume or contract match.

It must not accept a prior hook decision, operation ID, or caller-supplied digest as proof.

- [ ] **Step 5: Complete receipts without reopening authorization**

`finishExecution` records `completed | failed` once. It never moves FAILED/COMPLETED back to APPROVED and never releases a new permit. A process that dies before completion leaves CONSUMED evidence, which is intentionally non-reusable.

- [ ] **Step 6: Verify and commit execution authorization**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-execution.test.ts \
  src/control/__tests__/guard-concurrency.test.ts
npm run build
npm run typecheck
```

```bash
git add mcp-server/src/control
git commit -m "feat(guard): authorize execution starts"
```

---

### Task 2: Resolve exact publish authority and destructive preconditions

**Files:**
- Create: `mcp-server/src/control/publish-authority.ts`
- Create: `mcp-server/src/control/__tests__/publish-authority.test.ts`
- Modify: `mcp-server/src/control/operation-normalizer.ts`
- Modify: `mcp-server/src/control/shell-classifier.ts`
- Modify: `mcp-server/src/control/__tests__/operation-normalizer.test.ts`
- Modify: `mcp-server/src/control/__tests__/shell-classifier.test.ts`

**Interfaces:**
- Produces: `PublishAuthority.resolve(argv, claim, cwd): Promise<ResolvedPublishOperation>`.
- Produces canonical resolved variants: `git_push | pr_create | pr_merge | release_create`.
- Adds live Git/gh evidence to digest material without exposing it in journal summaries.

- [ ] **Step 1: Write failing publish authority tests**

Use local bare-remotes and a fake gh port to prove:

- `git push origin HEAD` resolves exact remote URL, remote name, source HEAD OID, destination ref, and current Claim branch;
- explicit refspec for another local branch fails;
- force, delete, mirror, multiple remotes/refspecs, URL remote arguments, and unknown options fail `GUARD_DESTRUCTIVE_PRECONDITION`;
- remote URL must match the Registry Repository slug and allowed transport;
- `gh pr create` requires noninteractive title/body flags and the current Claim branch;
- `gh pr merge` resolves one PR in the canonical repository and pins PR node ID, head OID, head branch, and base branch;
- another Task/branch PR fails;
- `gh release create` pins exact tag and commit and rejects an unresolved/moving tag;
- changed remote, HEAD, PR head OID, base, or tag after approval changes the digest.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/publish-authority.test.ts \
  src/control/__tests__/operation-normalizer.test.ts \
  src/control/__tests__/shell-classifier.test.ts
```

- [ ] **Step 3: Implement argv allowlists without shell evaluation**

Reject `bash -c`, `sh -c`, aliases, environment-prefix commands, and executables outside the exact `git`/`gh` names at the publish boundary.

For each supported command, parse only a documented closed option set. Unknown options fail closed rather than being forwarded. Require noninteractive gh inputs so the child cannot widen scope after authorization.

- [ ] **Step 4: Resolve repository and live remote/PR/release evidence**

Inject ports for:

- trusted Git queries in the active Claim worktree;
- Registry Repository lookup;
- read-only GitHub PR/release resolution through the repository credential.

Resolution happens before permit consume so the user approves the live canonical target. `beginExecution` repeats resolution and digesting immediately before spawn; a changed target yields mismatch instead of consuming the old approval.

- [ ] **Step 5: Teach hook normalization to unwrap the owned wrapper**

For:

```bash
jhw-control guard with \
  --task tsk-... \
  --claim clm-... \
  --session codex-local-hardening \
  --origin-adapter codex \
  -- git push origin HEAD
```

the hook canonical operation must describe the child publish, not a generic `jhw-control` invocation. Keep Task/Claim/session/origin-adapter as bindings, not authority claims.

- [ ] **Step 6: Verify and commit publish resolution**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/publish-authority.test.ts \
  src/control/__tests__/operation-normalizer.test.ts \
  src/control/__tests__/shell-classifier.test.ts
npm run typecheck
```

```bash
git add mcp-server/src/control/publish-authority.ts \
        mcp-server/src/control/operation-normalizer.ts \
        mcp-server/src/control/shell-classifier.ts \
        mcp-server/src/control/__tests__
git commit -m "feat(guard): resolve exact publish targets"
```

---

### Task 3: Implement the guarded argv runner and `guard with` CLI

**Files:**
- Create: `mcp-server/src/control/guarded-command.ts`
- Create: `mcp-server/src/control/__tests__/guarded-command.test.ts`
- Modify: `mcp-server/src/control/process.ts`
- Modify: `mcp-server/src/control/cli.ts`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts`

**Interfaces:**
- Adds: `jhw-control guard with --task --claim --session --origin-adapter -- <argv>`.
- Produces: `runGuardWith(argv, dependencies): Promise<number>`.
- Produces: `GuardedCommandRunner.spawnResolved(operation, signal): Promise<number>`.

- [ ] **Step 1: Write failing runner and CLI tests**

Test:

- missing `--`, child argv, or binding flags fails before Guard mutation;
- duplicate/unknown flags fail;
- cwd is taken from the real process and cannot be overridden by a flag;
- permit required prints a bounded structured decision with exact approval command and does not spawn;
- hard deny does not spawn;
- ALLOW calls beginExecution, then spawns exactly the resolved argv;
- consume occurs before spawn;
- spawn exception finishes FAILED;
- child exit 0/nonzero and SIGINT/SIGTERM are propagated;
- completion is attempted after every observed child exit;
- stdout/stderr are inherited and never copied into Guard state/journal;
- the long child continues after the original permit deadline.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guarded-command.test.ts \
  src/control/__tests__/cli.test.ts
```

- [ ] **Step 3: Add credential-isolated inherited-stdio execution**

Extend ProcessRunner with explicit methods instead of exposing token values:

```ts
spawnGitInherited(args, options): Promise<number>
spawnGhInherited(args, "repo", options): Promise<number>
```

Both use sanitized child environments. The gh variant exposes only `GH_REPO_TOKEN` as child `GH_TOKEN`, sets noninteractive behavior, and never returns/logs the token. Use a detached process group on Linux, forward SIGINT/SIGTERM, wait for child close, and bound wrapper setup time separately from child runtime.

- [ ] **Step 4: Keep long-running wrapper outside the ordinary CLI JSON envelope**

Mirror the existing `board with` dispatch boundary:

- special-case `guard with` before ordinary `runCli`;
- emit one bounded coordinate/decision line to stderr or caller-selected `--json-fd`;
- preserve child stdout/stderr and exit status;
- do not hold the Registry mutation lock during the child process;
- rely on the Guard request lock only for short state transitions.

- [ ] **Step 5: Mark execution result**

After beginExecution:

- spawn success + exit 0 → COMPLETED;
- spawn success + nonzero/signal → FAILED;
- spawn exception → FAILED;
- completion-journal warning does not change the child exit status;
- if completion state itself cannot be written, return the child result plus a bounded warning and leave the permit non-reusable.

- [ ] **Step 6: Verify and commit the wrapper**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guarded-command.test.ts \
  src/control/__tests__/guard-execution.test.ts \
  src/control/__tests__/cli.test.ts
npm run build
npm run typecheck
npm test
```

```bash
git add mcp-server/src/control/process.ts \
        mcp-server/src/control/guarded-command.ts \
        mcp-server/src/control/cli.ts \
        mcp-server/src/control/__tests__
git commit -m "feat(guard): wrap publish execution"
```

---

### Task 4: Expose publish-wrapper guidance, preflight, and smoke tests

**Files:**
- Create: `scripts/test-guarded-publish.sh`
- Modify: `scripts/test-hook-preflight.sh`
- Modify: `skills/claude/task.md`
- Regenerate: `skills/codex/jhw-task/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Changes preflight `execution_recheck.publish` from `pending` to `ok`.
- Documents exact wrapper syntax and unsupported destructive forms.

- [ ] **Step 1: Add an isolated bare-remote smoke test**

The script creates temporary Registry/worktree/bare Git repositories and fake gh resolution. Prove:

1. direct publish fixture is denied by the hook adapter;
2. wrapper without `git.publish` returns exact unlock command;
3. exact prompt approval followed by exact retry starts once;
4. push reaches only the expected bare remote/ref;
5. second retry fails consumed;
6. changed HEAD/refspec/remote after approval fails mismatch;
7. force/delete never produces a permit request.

No network or real GitHub mutation is used by this smoke test.

- [ ] **Step 2: Update operator guidance**

Document the exact pattern:

```bash
jhw-control guard with \
  --task "$TASK_ID" \
  --claim "$CLAIM_ID" \
  --session "$SESSION_ID" \
  --origin-adapter codex \
  -- git push origin HEAD
```

Explain that the Guard displays `/jhw:unlock req-id` when only the contract grant is missing, and that approval does not waive branch, remote, fast-forward, destructive, or repository checks.

- [ ] **Step 3: Run repository and wrapper gates**

```bash
cd mcp-server
npm run build
npm run typecheck
npm test
cd ..
bash scripts/test-guarded-publish.sh
bash scripts/test-hook-preflight.sh
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
git diff --check
```

- [ ] **Step 4: Commit publish rollout**

```bash
git add scripts/test-guarded-publish.sh \
        scripts/test-hook-preflight.sh \
        skills/claude/task.md \
        skills/codex/jhw-task \
        README.md
git commit -m "docs(guard): require guarded publish execution"
```

---

## Plan 4 completion gate

Before adding Notion, tracker, or board boundaries, prove:

1. Hook evaluation never consumes a publish permit.
2. Execution begin re-resolves the active Claim, worktree, remote/PR/release target, and digest.
3. Publish can affect only the active Claim repository and branch.
4. Destructive/cross-repository forms are hard denied without an unlock request.
5. A consumed permit is not reusable after spawn failure or nonzero child exit.
6. Long operations are not interrupted by permit expiry.
7. Preflight reports publish recheck `ok` while Notion/tracker/board remain pending.
