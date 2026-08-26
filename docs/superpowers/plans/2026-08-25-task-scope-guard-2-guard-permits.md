# Task Scope Guard 2: Guard Decisions and One-Time Permits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the central `ALLOW | PERMIT_REQUIRED | DENY` policy engine, conservative operation normalization, and atomic prompt-origin one-use permits without depending on any TUI-specific hook format.

**Architecture:** Translate a strict common event into a canonical operation, verify current Claim/worktree/resource ownership before comparing its immutable Work Contract, and keep short-lived permit state under a separate hardened host-local lock. Only Work Contract insufficiency can create a request; identity, worktree, exclusive-resource, authority, and state failures remain hard denials.

**Tech Stack:** TypeScript 5.5 strict ESM, Zod, Node.js HMAC/SHA-256 and filesystem APIs, Linux `flock`, existing secure state-directory primitives, Vitest fake clocks

**Spec:** `docs/superpowers/specs/2026-08-25-task-scope-guard-design.md`

## Global Constraints

- This is plan 2 of 6 and depends on plan 1's Task contracts, Claim snapshots, session lookup, and exclusive-conflict rules.
- Central Guard code owns all capability classification and policy. Future TUI adapters only translate payloads and outputs.
- Policy order is fixed: protocol/schema → Claim/session/host/worktree → authority/exclusive conflicts → normalization → contract → permit.
- Claim, session, host, branch, worktree, resource ownership, Board authority, takeover, destructive preconditions, and state integrity are never prompt-unlockable.
- `PERMIT_REQUIRED` is a normal structured result and always includes the exact `/jhw:unlock req-...` command.
- `ControlError` messages are debug-only. Operator behavior depends on stable decision code/reason fields.
- The only approval source is a validated `user_prompt_submit` common event carrying exact raw bytes from a supported native adapter.
- Exact approval syntax is one line: `/jhw:unlock req-<UUIDv7>`. No trim, case folding, code block, quote, suffix, or generic acknowledgement is accepted.
- PENDING approval deadline and APPROVED execution-start deadline are independently 10 minutes.
- `APPROVED → CONSUMED` is atomic. A consumed permit has no TTL and cannot be retried, including after spawn failure.
- Persist no raw prompt, command, script content, environment value, credential, or private path.
- `shell.unclassified` is permit-only and binds to the exact HMAC digest; known high-risk commands cannot be downgraded to it.
- State limits are 16 live requests per session and 256 live requests per host.
- Guard mutation/state failure is fail-closed. Guard status remains read-only.
- Runtime defaults to `enforce`. `observe` requires both `JHW_GUARD_MODE=observe` and `JHW_GUARD_ALLOW_OBSERVE=true`; no failure path silently changes mode.

---

### Task 1: Define the common event, canonical operation, and conservative classifier

**Files:**
- Create: `mcp-server/src/control/guard-protocol.ts`
- Create: `mcp-server/src/control/shell-classifier.ts`
- Create: `mcp-server/src/control/operation-normalizer.ts`
- Create: `mcp-server/src/control/__tests__/guard-protocol.test.ts`
- Create: `mcp-server/src/control/__tests__/shell-classifier.test.ts`
- Create: `mcp-server/src/control/__tests__/operation-normalizer.test.ts`
- Modify: `mcp-server/src/control/ids.ts`
- Modify: `mcp-server/src/control/__tests__/ids.test.ts`

**Interfaces:**
- Produces: `GuardCommonEventSchema` for `pre_tool_use | post_tool_use | user_prompt_submit`.
- Produces: `CanonicalOperationSchema`, `OperationRequirementSchema`, and `GuardProtocolVersion = 1`.
- Produces: `classifyShell(input, context): ShellClassification`.
- Produces: `normalizeOperation(event, context, digestKey): Promise<CanonicalOperation>`.
- Produces: `newRequestId()` and `newOperationId()`.

- [ ] **Step 1: Write failing protocol and classifier tests**

Pin strict top-level fields and bounded sizes. A representative common event is:

```ts
const event = {
  protocol_version: 1,
  adapter: "codex",
  event: "pre_tool_use",
  session_id: "codex-local-hardening",
  cwd: "/srv/worktrees/tsk-local/clm-local",
  tool_name: "Bash",
  tool_input: { command: "git push origin HEAD" },
  tool_use_id: "call-17",
};
```

Tests must prove:

- unknown protocol versions and fields fail schema validation;
- serialized `tool_input` above 64 KiB fails before normalization;
- `git commit` maps to `git.commit` on the current repository;
- `git push`, `gh pr create`, `gh pr merge`, and `gh release create` map to `git.publish` and require the guarded-command boundary;
- `gh issue close/edit/comment` maps to `tracker.mutate` and requires the tracker boundary;
- `ssh`, `scp`, and firmware/board commands require a board or remote boundary and never become only `shell.unclassified`;
- exact `jhw-control guard prompt/approve/consume` attempts classify as self-approval and hard deny;
- a simple unknown command maps to `shell.unclassified`;
- shell control syntax or `bash -c` remains unknown while retaining every lexically detected high-risk requirement;
- a local executable script adds a bounded content hash to digest material;
- symlink, non-regular, outside-worktree, or over-1-MiB scripts fail closed.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-protocol.test.ts \
  src/control/__tests__/shell-classifier.test.ts \
  src/control/__tests__/operation-normalizer.test.ts \
  src/control/__tests__/ids.test.ts
```

Expected: FAIL because the Guard modules and ID constructors do not exist.

- [ ] **Step 3: Define strict common and canonical schemas**

The common event is transport input and may contain raw data in memory. The canonical operation is the bounded, safe policy object:

`GuardCommonEventSchema` retains the transport field name `adapter`; normalization maps it exactly once to canonical `origin_adapter`. No downstream policy or persisted state uses the ambiguous transport name.

```ts
export const CanonicalOperationSchema = z.object({
  protocol_version: z.literal(1),
  operation_id: OperationIdSchema,
  origin_adapter: z.enum(["claude", "codex", "gemini", "opencode"]),
  evaluation_stage: z.enum(["hook", "execution"]),
  session_id: BoundedSessionSchema,
  task_id: TaskIdSchema,
  claim_id: ClaimIdSchema,
  cwd_worktree_ref: BoundedWorktreeRefSchema,
  tool: z.string().min(1).max(64),
  requirements: z.array(OperationRequirementSchema).min(1).max(32),
  risk: z.enum(["low", "medium", "high"]),
  execution_boundary: z.enum(["hook", "guarded_command", "tracker", "notion", "board"]),
  summary: z.string().min(1).max(512),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
```

Do not include raw `tool_input`, raw command, absolute cwd, or script bytes in `CanonicalOperation`. Sort and deduplicate requirements by capability/kind/ID. `origin_adapter` remains stable between hook and execution recheck; `evaluation_stage` records where evaluation occurred but is excluded from the operation digest so both stages can compare the same exact operation.

- [ ] **Step 4: Implement a conservative shell lexer/classifier**

Implement a bounded quote-aware scanner that recognizes command boundaries and literal argv without evaluating substitutions. Classification rules:

1. Scan the raw bytes for known high-risk executable/subcommand patterns first.
2. Parse one simple argv only when no control operator, substitution, redirection, or unterminated quote exists.
3. Unwrap only exact owned wrappers (`jhw-control guard with`, `jhw-control board with`) and classify their argv after `--`.
4. For ambiguous input, return `shell.unclassified` plus every high-risk requirement discovered in step 1.
5. Never invoke a shell during classification.

Use the active Claim's repository resource for local Git operations. Board/remote/firmware resolution is intentionally deferred to the dedicated execution boundary; the classifier marks the required boundary instead of inventing a resource ID.

- [ ] **Step 5: Implement keyed operation digesting**

Build canonical digest material from:

- protocol version, canonical tool, and origin adapter;
- Task/Claim/session coordinates;
- worktree reference;
- normalized requirements;
- execution-affecting tool arguments;
- resolved local script content SHA-256 when applicable.

Then compute:

```ts
createHmac("sha256", digestKey)
  .update(stableCanonicalJson(digestMaterial), "utf8")
  .digest("hex");
```

`tool_use_id` and `evaluation_stage` are correlation metadata and must not enter the approval digest because the post-approval retry receives a new tool-use ID and the execution wrapper necessarily runs at a different stage.

- [ ] **Step 6: Verify and commit normalization**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-protocol.test.ts \
  src/control/__tests__/shell-classifier.test.ts \
  src/control/__tests__/operation-normalizer.test.ts \
  src/control/__tests__/ids.test.ts
npm run typecheck
```

```bash
git add mcp-server/src/control
git commit -m "feat(guard): normalize scoped operations"
```

---

### Task 2: Implement stable Guard decisions and ownership-first evaluation

**Files:**
- Create: `mcp-server/src/control/guard-service.ts`
- Create: `mcp-server/src/control/__tests__/guard-service.test.ts`
- Modify: `mcp-server/src/control/claim-service.ts`
- Modify: `mcp-server/src/control/task-service.ts`
- Modify: `mcp-server/src/control/contract-authority.ts`
- Modify: `mcp-server/src/control/schemas.ts`

**Interfaces:**
- Produces: discriminated `GuardDecisionSchema` with `ALLOW | PERMIT_REQUIRED | DENY`.
- Produces: `GuardService.evaluatePreTool(event)`.
- Produces: `GuardService.submitUserPrompt(event)`.
- Produces: `GuardService.completePostTool(event)`.
- Adds: bounded `ClaimService.listActiveClaims()` for policy conflict audits.

- [ ] **Step 1: Write failing decision-order tests**

Test the exact precedence:

1. malformed/version mismatch → `DENY/GUARD_PROTOCOL_MISMATCH`;
2. mutation without active Claim → `DENY/GUARD_CLAIM_REQUIRED`;
3. session/Claim/host mismatch → `DENY/GUARD_CLAIM_MISMATCH`;
4. cwd, branch, or worktree mismatch → `DENY/GUARD_WORKTREE_MISMATCH`;
5. another active exclusive contract → `DENY/GUARD_RESOURCE_OWNED`;
6. invalid or now-unregistered resource → `DENY/GUARD_RESOURCE_AUTHORITY_UNAVAILABLE`;
7. all exact grants present → `ALLOW`;
8. only contract grant missing → `PERMIT_REQUIRED`;
9. a permit never turns cases 1–6 into ALLOW.

Also prove local read-only/status events can be allowed without a Claim, while credentialed remote reads require the same ownership path as mutations.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd mcp-server
npx vitest run src/control/__tests__/guard-service.test.ts
```

- [ ] **Step 3: Define bounded normal decisions**

```ts
export const GuardDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("ALLOW"),
    operation_id: OperationIdSchema,
    summary: BoundedSummarySchema,
    execution_boundary: ExecutionBoundarySchema,
    consumed_request_id: RequestIdSchema.optional(),
    observed_decision: z.enum(["PERMIT_REQUIRED", "DENY"]).optional(),
  }).strict(),
  z.object({
    decision: z.literal("PERMIT_REQUIRED"),
    operation_id: OperationIdSchema,
    request_id: RequestIdSchema,
    summary: BoundedSummarySchema,
    approval_command: z.string().regex(/^\/jhw:unlock req-[0-9a-f-]+$/),
    approval_expires_at: OffsetDateTimeSchema,
  }).strict(),
  z.object({
    decision: z.literal("DENY"),
    code: GuardDenyCodeSchema,
    reason: ErrorReasonSchema.optional(),
    task_id: TaskIdSchema.optional(),
    claim_id: ClaimIdSchema.optional(),
    summary: BoundedSummarySchema,
  }).strict(),
]);
```

The initial deny-code enum contains exactly the approved design codes plus:

- `GUARD_PROTOCOL_MISMATCH`
- `GUARD_RESOURCE_AUTHORITY_UNAVAILABLE`
- `GUARD_WRAPPER_REQUIRED`
- `GUARD_SELF_APPROVAL_DENIED`
- `GUARD_STATE_LIMIT`

Do not put remediation solely in a thrown message.

- [ ] **Step 4: Implement context resolution and invariant checks**

Resolve the Claim by exact adapter session and configured host. Then:

- call the existing worktree inspection path and compare branch/worktree/cwd;
- resolve mutation paths beneath the trusted worktree using realpath/lstat without following a target symlink;
- revalidate every operation resource through `ControlContractAuthority`;
- enumerate active Claims and reject an exact resource where another contract is exclusive;
- treat any active legacy Claim without a contract as indeterminate and deny;
- compare requirements only after all hard invariants pass.

Dependencies are never read by the grant comparator.

- [ ] **Step 5: Distinguish direct high-risk calls from controlled wrappers**

Even with a matching contract:

- direct raw publish/tracker/Notion/board/SSH/firmware/deploy commands return `GUARD_WRAPPER_REQUIRED`;
- recognized owned wrapper invocations return their execution boundary;
- a later plan's execution wrapper must re-evaluate current state and cannot trust this hook result.

For a hook-only local modification, ALLOW may be final. For a high-risk boundary, ALLOW means only “the wrapper may start its own recheck.”

- [ ] **Step 6: Verify and commit the policy engine**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-service.test.ts \
  src/control/__tests__/claim-service.test.ts \
  src/control/__tests__/task-service.test.ts
npm run build
npm run typecheck
```

```bash
git add mcp-server/src/control
git commit -m "feat(guard): enforce claim scope decisions"
```

---

### Task 3: Build hardened permit state, digest-key storage, and audit journal

**Files:**
- Create: `mcp-server/src/control/guard-state.ts`
- Create: `mcp-server/src/control/guard-journal.ts`
- Create: `mcp-server/src/control/__tests__/guard-state.test.ts`
- Create: `mcp-server/src/control/__tests__/guard-journal.test.ts`
- Modify: `mcp-server/src/control/journal.ts`
- Modify: `mcp-server/src/control/process.ts`
- Modify: `mcp-server/src/control/schemas.ts`
- Modify: `mcp-server/src/control/__tests__/error-reasons.test.ts`

**Interfaces:**
- Produces: `GuardRequestStore.createOrReusePending(operation)`.
- Produces: `GuardRequestStore.approveFromPrompt(originAdapter, session, rawPrompt)`.
- Produces: `GuardRequestStore.consumeMatching(operation, correlation?)`.
- Produces: `GuardRequestStore.complete(correlation, ok)`.
- Produces: `GuardDigestKey.loadOrCreate()`.
- Produces: `GuardJournal.append(event)`.

- [ ] **Step 1: Write failing state-machine and filesystem tests**

Use fake time to test:

- PENDING is approvable at 9:59.999 and expired at exactly 10:00.000;
- APPROVED is consumable at 9:59.999 and expired at exactly 10:00.000 after approval;
- exactly one of two concurrent consumers wins;
- consumed state remains valid past either TTL until completed/failed;
- spawn failure records FAILED and never reopens the request;
- wrong Task, Claim, origin adapter, session, worktree, requirement set, or digest yields `GUARD_PERMIT_MISMATCH`;
- 17th live request for one session and 257th host request fail `GUARD_STATE_LIMIT`;
- symlink, multi-link, wrong type, unsafe mode, corrupt JSON-subset YAML, and rename/fsync failure fail closed;
- terminal rows older than 24 hours are removed from state on mutation while journal rows remain;
- state contains no raw command, prompt, script, environment, or absolute path.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-state.test.ts \
  src/control/__tests__/guard-journal.test.ts
```

- [ ] **Step 3: Implement the exact persisted state**

Use:

```text
JHW_CONTROL_STATE_DIR/guard-requests.yaml
JHW_CONTROL_STATE_DIR/guard-requests.lock
JHW_CONTROL_STATE_DIR/guard-journal.jsonl
JHW_CONTROL_STATE_DIR/guard-digest.key
```

Persist request bindings and safe summaries only:

```ts
interface GuardRequest {
  request_id: string;
  state: "PENDING" | "APPROVED" | "CONSUMED" | "COMPLETED" | "FAILED" | "EXPIRED";
  origin_adapter: GuardAdapter;
  session_id: string;
  task_id: string;
  claim_id: string;
  cwd_worktree_ref: string;
  requirements: OperationRequirement[];
  operation_digest: string;
  summary: string;
  requested_at: string;
  approval_expires_at: string;
  approved_at?: string;
  start_by?: string;
  consumed_at?: string;
  finished_at?: string;
  correlation_id?: string;
}
```

Use `MutationLock` with `lockFileName: "guard-requests.lock"`, bounded wait, and registered reason `guard_state_lock`. Every mutation is lock → secure read/strict parse → cleanup → transition → temp write/fsync → rename → directory fsync.

- [ ] **Step 4: Create and protect the HMAC key**

Create a 32-byte random key with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, one link, full file sync, and directory sync. Existing keys must be regular, one-link, mode 0600, and exactly 32 bytes. Never print or journal it.

- [ ] **Step 5: Implement exact prompt approval**

The parser is deliberately not forgiving:

```ts
const EXACT_UNLOCK =
  /^\/jhw:unlock (req-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
```

`approveFromPrompt` receives the authoritative raw string. It checks event kind, origin-adapter support, exact session, exact request ID, PENDING state, and approval deadline under the state lock. On success it writes `approved_at` and a separate `start_by`.

Ordinary prompts return “not an unlock prompt” without mutating state. Exact-looking but invalid/expired requests return stable codes and never create a replacement.

- [ ] **Step 6: Implement bounded secret-safe journal rows**

Journal event vocabulary:

```text
decision requested approved consumed completed failed expired
```

Rows include only protocol, origin adapter, evaluation stage, event, Task/Claim/session, request/operation digest, canonical requirements, timestamps, decision code, and registered reason. Reuse `appendBoundedJournalLine`. A journal write failure after authoritative state mutation returns bounded `journal_warning: "GUARD_JOURNAL_UNAVAILABLE"`; it does not roll the state transition back.

Register `guard_state_lock` in `ERROR_REASONS`, document it in the Guard section of `skills/claude/task.md`, and assert source literal → vocabulary → operator documentation coverage.

- [ ] **Step 7: Verify and commit permit storage**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-state.test.ts \
  src/control/__tests__/guard-journal.test.ts \
  src/control/__tests__/error-reasons.test.ts
npm run build
npm run typecheck
```

```bash
git add mcp-server/src/control \
        skills/claude/task.md
git commit -m "feat(guard): persist one-time prompt permits"
```

---

### Task 4: Integrate request reuse, approval, consume, and PostTool completion

**Files:**
- Modify: `mcp-server/src/control/guard-service.ts`
- Modify: `mcp-server/src/control/guard-protocol.ts`
- Modify: `mcp-server/src/control/__tests__/guard-service.test.ts`
- Create: `mcp-server/src/control/__tests__/guard-concurrency.test.ts`

**Interfaces:**
- Changes: missing-grant evaluation creates or reuses one matching PENDING/APPROVED request.
- Changes: hook-only retry consumes an approved request before returning ALLOW.
- Changes: high-risk retry leaves APPROVED state for execution-layer consumption.
- Changes: PostToolUse closes only the exact consumed hook correlation.

- [ ] **Step 1: Write failing end-to-end service tests**

Cover:

1. Missing `repo.modify` creates one PENDING request and returns its exact approval command.
2. Re-evaluating the same operation before expiry reuses that request instead of consuming another quota slot.
3. `ok`, `진행`, `다음`, `승인`, quoted unlock, code-fenced unlock, leading/trailing whitespace, and a second line do nothing.
4. Exact native prompt approves only the bound adapter/session.
5. Retrying the exact local edit atomically consumes the request and returns ALLOW.
6. A changed file path, command, resource, cwd, script content, Task, or Claim fails mismatch and needs a fresh evaluation.
7. PostToolUse marks the exact correlation completed/failed.
8. A publish/Notion/tracker/board wrapper retry remains APPROVED until execution begins.
9. Two simultaneous exact retries produce one ALLOW and one `GUARD_PERMIT_CONSUMED`.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-service.test.ts \
  src/control/__tests__/guard-concurrency.test.ts
```

- [ ] **Step 3: Wire state transitions only after hard invariants**

When grants are missing:

- first check all hard denials;
- normalize and HMAC the exact operation;
- look for a matching live request;
- return existing PENDING, recognize APPROVED, or create a new PENDING;
- never create a request for `GUARD_CLAIM_REQUIRED`, mismatch, exclusive ownership, authority failure, wrapper absence, or corrupt state.

For `execution_boundary: "hook"`, consume before ALLOW and bind the new `tool_use_id` as correlation. For every other boundary, return ALLOW without consuming; the boundary owns atomic start.

- [ ] **Step 4: Implement prompt context without treating prompts as work authorization**

`submitUserPrompt` returns a bounded result containing:

- current Task/Claim alias and contract digest;
- exact result of an unlock attempt, when applicable;
- on success, `start_by` and the statement that execution consumes the permit;
- no authority change for any other prompt.

No skill, slash-command implementation, or agent-generated tool call may call the approval transition.

- [ ] **Step 5: Verify and commit the integrated permit loop**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/guard-service.test.ts \
  src/control/__tests__/guard-concurrency.test.ts
npm run build
npm run typecheck
npm test
```

```bash
git add mcp-server/src/control
git commit -m "feat(guard): consume exact approved operations"
```

---

### Task 5: Add read-only Guard status/preflight and explicit runtime mode

**Files:**
- Modify: `mcp-server/src/control/config.ts`
- Modify: `mcp-server/src/control/cli.ts`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts`
- Modify: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`
- Modify: `mcp-server/.env.example`
- Modify: `skills/claude/task.md`
- Regenerate: `skills/codex/jhw-task/SKILL.md`

**Interfaces:**
- Adds: `jhw-control guard status [--session <id>]`.
- Adds: `jhw-control guard preflight`.
- Adds: `ControlConfig.guardMode: "enforce" | "observe"`.
- Reports: protocol version, state safety, Registry/Claim availability, current contract digest, request counts, and initial adapter coverage states.

- [ ] **Step 1: Write failing CLI/config tests**

Assert:

- missing mode defaults to enforce;
- `observe` without exact development opt-in fails `INVALID_CONFIG`;
- invalid modes fail;
- state corruption makes preflight report `GUARD_UNAVAILABLE` without resetting;
- status does not require a Claim and does not mutate/expire state;
- status output is bounded and never exposes raw operations or absolute paths;
- preflight does not claim any TUI adapter is installed before plan 3.

- [ ] **Step 2: Implement read-only commands**

`guard status` reads a rename-published snapshot without the mutation lock and reports terminal-safe summaries. `guard preflight` checks:

- protocol version;
- enforce/observe mode;
- digest key safety;
- request-state safety;
- Registry readability;
- current session Claim uniqueness when a session is supplied;
- execution recheck coverage as `pending` until plans 4–6.

Neither command approves, consumes, expires, resets, or creates requests.

- [ ] **Step 3: Document operator interpretation**

In `skills/claude/task.md`, document:

- `ALLOW | PERMIT_REQUIRED | DENY`;
- exact approval command and two independent 10-minute windows;
- no mid-operation permit expiry;
- one-use/retry behavior;
- hard-deny categories;
- exact generic prompts that are not approval;
- `/jhw:unlock` is reserved adapter control, not an ordinary skill or shell command;
- status/preflight usage.

Regenerate Codex skills and check drift.

- [ ] **Step 4: Run all repository gates**

```bash
cd mcp-server
npm run build
npm run typecheck
npm test
cd ..
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
git diff --check
```

- [ ] **Step 5: Commit Guard status and documentation**

```bash
git add mcp-server/src/control/config.ts \
        mcp-server/src/control/cli.ts \
        mcp-server/src/control/__tests__/cli.test.ts \
        mcp-server/src/control/__tests__/phase1a.e2e.test.ts \
        mcp-server/.env.example \
        skills/claude/task.md \
        skills/codex/jhw-task
git commit -m "feat(guard): expose fail-closed preflight"
```

---

## Plan 2 completion gate

Before installing any adapter, prove through direct common-event tests:

1. Only contract insufficiency produces `PERMIT_REQUIRED`.
2. Every such result contains one exact copyable approval command.
3. Exact native prompt approval and both 10-minute boundaries behave at millisecond edges.
4. One concurrent execution consumes the permit and all replays fail.
5. A started long operation is not expired by the permit store.
6. Known publish/SSH/board/firmware/deploy patterns cannot hide as only unknown shell.
7. Corrupt/unsafe Guard state blocks mutations and leaves read-only status available.
8. Journal and state scans find no raw prompt, command, credential, script bytes, environment values, or absolute paths.
