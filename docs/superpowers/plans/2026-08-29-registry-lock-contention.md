# Registry Lock Contention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the host-global Registry mutation boundary while making ordinary contention wait up to 30 seconds and return a privacy-bounded holder summary on timeout.

**Architecture:** Keep the existing `registry.lock` inode and callback-wide flock. The production Registry profile changes from `-n` to `-w 30`; Guard continues to call the same concrete lock through its private 5-second override. The holder writes one strict, bounded JSON record into the already-secured lock file, and CLI error serialization emits only a schema-pinned summary.

**Tech Stack:** TypeScript 5.5 strict ESM, Node.js `FileHandle`/`process.kill`, Zod, Linux `/usr/bin/flock`, Vitest 4

**Spec:** `docs/superpowers/specs/2026-08-29-registry-lock-contention-design.md`

## Global Constraints

- Every shell command in this environment starts with `rtk`.
- Work only in `task/d5ccdec7b031-jhw7500-jhw-notion-88`; do not modify the permanent `feat/issue-81-jhw-fetch` checkout or Task 74 worktree.
- Ordinary production Registry writers wait exactly 30 seconds; Guard and Board remain exactly 5 seconds.
- Keep one host-global `registry.lock`; do not split by project or move preflight network work in this change.
- Public holder output is exactly `command`, `acquired_at`, `elapsed_ms`, and `pid_state`; never emit raw PID, session, path, argv, environment, Claim, or project coordinates.
- Holder metadata is diagnostic only. Kernel flock remains the only ownership authority and metadata never permits recovery or mutation.
- `registry_state_lock` must be registered in `ERROR_REASONS` and documented in the canonical Task skill in the same independently passing commit.
- Run TypeScript commands from `mcp-server/`; run skill sync commands from the repository root.

---

### Task 1: Public lock context and bounded error envelope

**Files:**
- Modify: `mcp-server/src/control/schemas.ts:232-310`
- Modify: `mcp-server/src/control/process.ts:496-500`
- Modify: `mcp-server/src/control/cli.ts:45-75, 795-850, 1680-1690, 1795-1810`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts:790-1010, 1535-1565`
- Modify: `mcp-server/src/control/__tests__/error-reasons.test.ts:50-65`
- Modify: `skills/claude/task.md:459-466`

**Interfaces:**
- Produces: `RegistryMutationCommandSchema`, `RegistryMutationCommand`, `LockHolderSummarySchema`, and `LockHolderSummary` from `schemas.ts`.
- Produces: `MutationLockRunContext = { command: RegistryMutationCommand }` and optional second parameter `MutationLockPort.run(callback, context?)` from `process.ts`.
- Produces: private `mutationLockCommand(argv): RegistryMutationCommand | undefined` in `cli.ts`; `requiresMutationLock` becomes its boolean wrapper.
- Consumes later: Task 2 writes `ControlError.details.lock_holder` in the exact `LockHolderSummary` shape.

- [ ] **Step 1: Write failing CLI envelope and dispatch tests**

Add tests that derive expected output as literals:

```ts
it("emits only the bounded Registry lock holder summary", () => {
  const result = controlErrorResult(new ControlError("LOCK_CONTENDED", "private diagnostic", {
    reason: "registry_state_lock",
    lock_holder: {
      command: "preflight",
      acquired_at: "2026-08-29T00:00:00.000Z",
      elapsed_ms: 30_012,
      pid_state: "alive",
    },
    pid: 12345,
    session_id: "private-session",
    repository_path: "/private/repository",
  }));

  expect(JSON.parse(result.stderr)).toEqual({
    error: {
      code: "LOCK_CONTENDED",
      reason: "registry_state_lock",
      lock_holder: {
        command: "preflight",
        acquired_at: "2026-08-29T00:00:00.000Z",
        elapsed_ms: 30_012,
        pid_state: "alive",
      },
    },
  });
  expect(result.stderr).not.toContain("12345");
  expect(result.stderr).not.toContain("private-session");
  expect(result.stderr).not.toContain("/private/repository");
});

it("drops a malformed Registry lock holder instead of forwarding extra fields", () => {
  const result = controlErrorResult(new ControlError("LOCK_CONTENDED", "private diagnostic", {
    reason: "registry_state_lock",
    lock_holder: {
      command: "preflight",
      acquired_at: "2026-08-29T00:00:00.000Z",
      elapsed_ms: 30_012,
      pid_state: "alive",
      pid: 12345,
    },
  }));
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: "LOCK_CONTENDED", reason: "registry_state_lock" },
  });
});
```

Update the existing preflight/portfolio lock test so its fake captures the optional second argument and assert literal contexts:

```ts
expect(mutationLock.run).toHaveBeenNthCalledWith(
  1,
  expect.any(Function),
  { command: "preflight" },
);
expect(mutationLock.run).toHaveBeenNthCalledWith(
  2,
  expect.any(Function),
  { command: "portfolio export" },
);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run from `mcp-server/`:

```bash
rtk npm test -- src/control/__tests__/cli.test.ts
```

Expected: FAIL because `registry_state_lock` and `lock_holder` are dropped and `runCli` passes no lock context.

- [ ] **Step 3: Add strict schemas and the lock context port**

In `schemas.ts`, add the closed mutation-command vocabulary and public summary:

```ts
export const RegistryMutationCommandSchema = z.enum([
  "preflight",
  "repository register",
  "task start",
  "task child-start",
  "task contract",
  "task completion-ready",
  "task finish",
  "task promote",
  "task recover",
  "project register",
  "project update",
  "portfolio export",
]);
export type RegistryMutationCommand = z.infer<typeof RegistryMutationCommandSchema>;

export const LockHolderSummarySchema = z.object({
  command: RegistryMutationCommandSchema,
  acquired_at: OffsetDateTimeSchema,
  elapsed_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pid_state: z.enum(["alive", "dead", "unknown"]),
}).strict();
export type LockHolderSummary = z.infer<typeof LockHolderSummarySchema>;
```

Add `"registry_state_lock"` next to the existing Registry/Board lock reasons. In `process.ts`, add:

```ts
export interface MutationLockRunContext {
  command: RegistryMutationCommand;
}

export interface MutationLockPort {
  run<T>(callback: () => Promise<T>, context?: MutationLockRunContext): Promise<T>;
}
```

- [ ] **Step 4: Route only mutation commands into the lock and whitelist holder output**

Replace the duplicated boolean policy with a mapper whose branches return the exact strings above:

```ts
function mutationLockCommand(argv: readonly string[]): RegistryMutationCommand | undefined {
  if (argv.length === 1 && argv[0] === "preflight") return "preflight";
  if (argv[0] === "repository" && argv[1] === "register") return "repository register";
  if (argv[0] === "task" && new Set([
    "start", "child-start", "contract", "completion-ready", "finish", "promote",
  ]).has(argv[1] ?? "")) return `task ${argv[1]}` as RegistryMutationCommand;
  if (argv[0] === "project" && (argv[1] === "register" || argv[1] === "update")) {
    return `project ${argv[1]}` as RegistryMutationCommand;
  }
  if (argv[0] === "portfolio" && argv[1] === "export") return "portfolio export";
  if (argv[0] !== "task" || argv[1] !== "recover") return undefined;
  const index = argv.indexOf("--action");
  return new Set(["force-end", "takeover", "cleanup"]).has(argv[index + 1] ?? "")
    ? "task recover"
    : undefined;
}
```

Compute this once in `runCli` and pass `{ command: lockCommand }` to `mutationLock.run`. Keep `requiresMutationLock(argv)` as `mutationLockCommand(argv) !== undefined` for callers/tests.

Add a `lockHolder(cause)` helper parallel to `conflictingClaim`, gated to `cause.code === "LOCK_CONTENDED"`, and include only a successful `LockHolderSummarySchema.safeParse(cause.details.lock_holder).data` in `controlErrorResult`.

- [ ] **Step 5: Document and pin the new reason**

Add this canonical Task-skill interpretation:

```md
- `LOCK_CONTENDED` + `registry_state_lock`이면 같은 호스트의 Registry writer가 최대 30초 대기 뒤에도 실행 중인 것이다. optional `lock_holder`의 command·acquired_at·elapsed_ms·pid_state만 보고하며 `registry.lock`을 삭제하거나 holder를 자동 종료하지 않는다.
```

Add an `error-reasons.test.ts` assertion that the source contains `contendedReason: "registry_state_lock"` only after Task 2; for this task, pin vocabulary and documentation:

```ts
expect(ERROR_REASONS).toContain("registry_state_lock");
expect(doc).toContain("`registry_state_lock`");
```

- [ ] **Step 6: Run focused tests and typecheck, then commit**

```bash
rtk npm test -- src/control/__tests__/cli.test.ts src/control/__tests__/error-reasons.test.ts
rtk npm run typecheck
```

Expected: PASS with no TypeScript errors.

```bash
rtk git add mcp-server/src/control/schemas.ts mcp-server/src/control/process.ts mcp-server/src/control/cli.ts mcp-server/src/control/__tests__/cli.test.ts mcp-server/src/control/__tests__/error-reasons.test.ts skills/claude/task.md
rtk git commit -m "feat(control): bound registry lock diagnostics"
```

---

### Task 2: Bounded Registry wait and same-file holder metadata

**Files:**
- Modify: `mcp-server/src/control/process.ts:490-850`
- Modify: `mcp-server/src/control/__tests__/lock.test.ts:1-220`
- Modify: `mcp-server/src/control/__tests__/guard-production-provenance.test.ts:340-365`
- Modify: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts:690-745`
- Modify: `mcp-server/src/control/__tests__/error-reasons.test.ts:50-65`

**Interfaces:**
- Consumes: `MutationLockRunContext` and `RegistryMutationCommandSchema` from Task 1.
- Produces: private strict `LockHolderRecordSchema` with `{ version, command, acquired_at, pid }`.
- Produces: best-effort `writeLockHolderRecord`, `readLockHolderSummary`, and `pidState` helpers in `process.ts`.
- Produces: production Registry options `{ waitSeconds: 30, contendedReason: "registry_state_lock" }` while `runGuard` overrides wait with 5.

- [ ] **Step 1: Write failing lock-policy and real contention tests**

Change the existing Guard wait test to construct a Registry writer with 30 seconds and assert the Guard override remains 5:

```ts
const lock = new MutationLock(configFor(join(root, "state")), {}, runtime, {}, {
  waitSeconds: 30,
  contendedReason: "registry_state_lock",
});
const authority = createGuardMutationLockAuthorityForTesting(lock);
await lock.run(async () => undefined, { command: "preflight" });
await runWithGuardMutationLockAuthority(authority, async () => undefined);
expect(seen).toEqual([
  ["-w", "30", "-E", "75", "3"],
  ["-w", "5", "-E", "75", "3"],
]);
```

Add a real two-lock test using one shared state directory but different `registryDir` values. Hold the first lock with `{ command: "preflight" }`; configure the second with a one-second test wait and `registry_state_lock`. Assert its callback never runs and the thrown details contain only a valid holder summary with `command: "preflight"` and `pid_state: "alive"`. This test catches project sharding, missing metadata, wrong timeout reason, and callback execution after failed acquisition.

Add a recovery characterization using `/usr/bin/flock --no-fork`: wait for its child command to print a readiness byte after acquisition, confirm the lock is contended, send `SIGKILL`, await process close, and assert a new `MutationLock` succeeds without deleting `registry.lock`. This pins the kernel-FD recovery boundary; metadata is not consulted for recovery.

- [ ] **Step 2: Rewrite the Task overlap e2e expectation before implementation**

Start the contender without awaiting it, observe that it remains unsettled during a 50ms overlap, then release the first Task start:

```ts
let contenderSettled = false;
const contenderPromise = runCli(formalStartArgs("codex-b"), contenderDependencies)
  .finally(() => { contenderSettled = true; });
await new Promise((resolve) => setTimeout(resolve, 50));
const waitedInsteadOfFailingFast = !contenderSettled;
release.resolve();
const [first, contender] = await Promise.all([firstPromise, contenderPromise]);

expect(waitedInsteadOfFailingFast).toBe(true);
expect(first.exitCode).toBe(0);
expect(contender.exitCode).toBe(4);
expect(JSON.parse(contender.stderr).error.code).toBe("TASK_ALREADY_CLAIMED");
```

Keep the exact-one-active-Claim assertions. This proves the second session waited, acquired the same host-global lock, and then received the authoritative Task conflict instead of `LOCK_CONTENDED`.

- [ ] **Step 3: Rewrite the production Guard exclusion test before implementation**

Start `second.run` while `first.run` holds the production lock, record that the second callback has not entered, release the first, and assert the second then succeeds. This test must not await a 30-second failure before releasing the first holder.

- [ ] **Step 4: Run the focused tests and verify RED**

```bash
rtk npm test -- src/control/__tests__/lock.test.ts src/control/__tests__/guard-production-provenance.test.ts src/control/__tests__/phase1a.e2e.test.ts
```

Expected: FAIL because a 30-second direct Registry lock is currently Guard-ineligible, production Registry writers still use `-n`, no holder metadata is written, and the e2e contender fails immediately.

- [ ] **Step 5: Implement bounded production policy without weakening Guard provenance**

Set the production Registry profile to:

```ts
if (profile === "registry") return Object.freeze({
  waitSeconds: 30,
  contendedReason: "registry_state_lock",
});
```

Change `guardEligible` to require the `registry.lock` identity rather than requiring an undefined public wait. Keep all existing concrete instance, exact prototype, intrinsic method, and production-factory provenance checks. `runGuard` continues to call `#runLocked(callback, 5)`.

- [ ] **Step 6: Implement strict same-file metadata**

Define a 1KiB maximum and strict internal record:

```ts
const LOCK_HOLDER_RECORD_MAX_BYTES = 1024;
const LockHolderRecordSchema = z.object({
  version: z.literal(1),
  command: RegistryMutationCommandSchema,
  acquired_at: OffsetDateTimeSchema,
  pid: z.number().int().positive().max(2_147_483_647),
}).strict();
```

After successful flock acquisition and before the callback, write at position zero and truncate to the encoded length. If no context exists, truncate to zero so a Guard/internal holder cannot leave a previous CLI holder record looking current. All metadata write failures are swallowed as diagnostics-only failures.

On `LOCK_CONTENDED`, read only when file size is `1..1024`, parse strict JSON, compute `elapsed_ms = Math.max(0, Date.now() - Date.parse(acquired_at))`, and map liveness:

```ts
function hasErrno(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

function pidState(pid: number): LockHolderSummary["pid_state"] {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (cause) {
    if (hasErrno(cause, "ESRCH")) return "dead";
    if (hasErrno(cause, "EPERM")) return "alive";
    return "unknown";
  }
}
```

Re-throw a new `ControlError("LOCK_CONTENDED", cause.message, { ...cause.details, lock_holder })` only when parsing succeeds; otherwise preserve the stable code/reason without a holder.

- [ ] **Step 7: Pin source reason, run GREEN gates, and commit**

Extend `error-reasons.test.ts` to assert `process.ts` contains the typed production literal. Run:

```bash
rtk npm test -- src/control/__tests__/lock.test.ts src/control/__tests__/cli.test.ts src/control/__tests__/error-reasons.test.ts src/control/__tests__/guard-production-provenance.test.ts src/control/__tests__/phase1a.e2e.test.ts
rtk npm run typecheck
```

Expected: PASS; the real long-holder test takes about one second, not 30 seconds.

```bash
rtk git add mcp-server/src/control/process.ts mcp-server/src/control/__tests__/lock.test.ts mcp-server/src/control/__tests__/guard-production-provenance.test.ts mcp-server/src/control/__tests__/phase1a.e2e.test.ts mcp-server/src/control/__tests__/error-reasons.test.ts
rtk git commit -m "fix(control): wait for registry lock contention"
```

---

### Task 3: Operator documentation and skill synchronization

**Files:**
- Modify: `DESIGN.md:64`
- Modify: `docs/project-control/phase1a-runbook.md:42,196`
- Modify: `skills/claude/project.md:81`

**Interfaces:**
- Consumes: Task 2's 30-second production policy and Task 1's public error shape.
- Produces: one consistent operator rule: all projects share the same host lock; ordinary writers wait up to 30 seconds; timeout diagnostics are observational and never justify deleting the lock file.

- [ ] **Step 1: Update the architecture and runbook statements**

Replace every statement that says another lifecycle command fails immediately. State instead that it waits up to 30 seconds, then returns exit 75 with `registry_state_lock` and optional bounded holder diagnostics. Preserve the warning that long Project registration is normal and must not be interrupted.

- [ ] **Step 2: Update the canonical Project skill**

Change the Project registration paragraph to say overlapping lifecycle commands wait up to 30 seconds and may then return `LOCK_CONTENDED`; tell the operator not to delete `registry.lock` or kill a holder based only on metadata.

- [ ] **Step 3: Synchronize and verify skills**

From the repository root:

```bash
rtk node scripts/sync-codex-skills.mjs
rtk node scripts/sync-codex-skills.mjs --check
```

Expected: generated consumers are synchronized and the check reports no drift.

- [ ] **Step 4: Run documentation-coupled tests and commit**

From `mcp-server/`:

```bash
rtk npm test -- src/control/__tests__/error-reasons.test.ts
```

Expected: PASS.

```bash
rtk git add DESIGN.md docs/project-control/phase1a-runbook.md skills/claude/project.md
rtk git commit -m "docs(control): explain bounded Registry contention"
```

---

### Task 4: Full verification and branch handoff

**Files:**
- Verify only: all files changed in Tasks 1-3

**Interfaces:**
- Consumes: complete implementation and documentation.
- Produces: fresh evidence for review and branch integration.

- [ ] **Step 1: Run all mandatory MCP gates**

From `mcp-server/`:

```bash
rtk npm run typecheck
rtk npm run build
rtk npm test
```

Expected: all commands exit 0; the full Vitest count is reported and no suite fails.

- [ ] **Step 2: Re-run skill and diff hygiene gates**

From the repository root:

```bash
rtk node scripts/sync-codex-skills.mjs --check
rtk git diff --check origin/main...HEAD
rtk git status --short --branch
```

Expected: no skill drift, no whitespace errors, and a clean Task branch.

- [ ] **Step 3: Review the committed diff against the spec**

```bash
rtk git diff --stat origin/main...HEAD
rtk git log --oneline origin/main..HEAD
```

Confirm: no preflight split, no project sharding, no raw PID/session/path output, Guard remains 5 seconds, and only the intended Task worktree changed.

- [ ] **Step 4: Use the finishing-development-branch workflow**

Load `superpowers:finishing-a-development-branch`, re-run its required verification, and present the permitted integration choices without modifying the permanent checkout.
