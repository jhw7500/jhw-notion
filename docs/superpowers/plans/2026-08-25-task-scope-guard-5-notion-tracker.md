# Task Scope Guard 5: Notion and Issue Mutation Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recheck every authoritative Notion and GitHub Issue mutation at the actual API boundary using the active Task/Claim/session/worktree and atomically consume any prompt permit immediately before the first write.

**Architecture:** Add an explicit bounded `control_context` to mutating MCP inputs, compose the existing Notion authority gate with Guard execution authorization, and provide dedicated tracker commands that resolve the formal parent Issue instead of allowing raw `gh issue` mutation. Parent Issue close requires the pre-close completion evidence recorded by plan 1 for the still-active parent Claim.

**Tech Stack:** TypeScript 5.5 ESM, MCP SDK, Zod, Notion REST client, GitHub CLI GraphQL/API adapter, existing Guard execution receipts, Vitest

**Spec:** `docs/superpowers/specs/2026-08-25-task-scope-guard-design.md`

## Global Constraints

- This is plan 5 of 6 and depends on plans 1–4.
- Hook results are advisory to these boundaries. The MCP handler/tracker command re-resolves and starts execution itself. When a canonical target cannot be known without an execution-layer read (notably delete/append ancestry), the hook allows only the recognized owned MCP boundary and defers request creation to that boundary.
- `control_context` contains coordinates, not authority. The handler verifies every field against Registry/host/worktree state.
- Always-mutating MCP tools require `control_context`. `jhw_report_export` requires it only when `writeBack.enabled === true`.
- Read-only Notion tools and report export without write-back remain callable without a Task.
- Existing Notion authority checks run before permit creation. `AUTHORITY_MOVED`, disabled writes, unknown target database, and route corruption are hard failures.
- A Notion target must resolve to one of the five configured logical database IDs. Unknown/free-form pages cannot receive a permit.
- One multi-write tool call obtains one execution receipt for its complete target set. It never consumes one permit per internal Notion request.
- A partial API failure leaves the receipt FAILED/consumed and requires a fresh permit.
- No raw prompt, Notion content, report body, Issue comment, token, page ID outside the canonical target, or absolute cwd is persisted in Guard state/journal.
- Raw `gh issue close/edit/comment` remains blocked. Project Control's own Issue creation/registration transition is an existing control-plane operation, not an arbitrary workload Issue mutation.
- A child may comment on its formal parent Issue only with an exact parent-Issue `tracker.mutate` grant. A child cannot close the parent Issue.
- Parent/standalone Issue close requires an active formal Claim and its exact immutable completion-evidence record. Close occurs before `task finish`; they remain separate events.
- Prompt permit never bypasses Notion schema checks, tag vocabulary, archive/delete mode rules, Issue identity/revision, completion evidence, or GitHub state.

---

### Task 1: Define MCP control context and a composable mutation boundary

**Files:**
- Create: `mcp-server/src/control/mcp-mutation-guard.ts`
- Create: `mcp-server/src/control/__tests__/mcp-mutation-guard.test.ts`
- Modify: `mcp-server/src/control/guard-protocol.ts`
- Modify: `mcp-server/src/control/operation-normalizer.ts`
- Modify: `mcp-server/src/server.ts`
- Modify: `mcp-server/src/__tests__/server.test.ts`

**Interfaces:**
- Produces: `ControlContextSchema`.
- Produces: `McpMutationGuard.beginNotion(input): Promise<McpMutationDecision>`.
- Produces: `McpMutationGuard.finish(receipt, ok): Promise<void>`.
- Produces: `guardMcpResult(decision)` for normal PERMIT_REQUIRED/DENY tool results.
- Adds lazy dependency injection to `createServer(dependencies?)`.

- [ ] **Step 1: Write failing context and boundary tests**

Pin this strict shape:

```ts
export const ControlContextSchema = z.object({
  protocol_version: z.literal(1),
  task_id: TaskIdSchema,
  claim_id: ClaimIdSchema,
  session_id: BoundedSessionSchema,
  origin_adapter: z.enum(["claude", "codex", "gemini", "opencode"]),
  cwd: z.string().min(1).max(4096),
}).strict();
```

Test:

- missing/extra fields and relative cwd fail;
- caller-supplied context cannot override Claim/host/worktree truth;
- exact Notion target requirements normalize and hash deterministically;
- supported Claude/Codex missing-grant result returns `PERMIT_REQUIRED`;
- unsupported Gemini/OpenCode missing-grant result returns `GUARD_PROMPT_ORIGIN_UNSUPPORTED`, while an in-contract operation can pass execution recheck;
- DENY/PERMIT_REQUIRED becomes structured MCP text without throwing or mutating;
- ALLOW returns a receipt and finish maps success/failure once;
- no context or Notion arguments are copied to journal.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/mcp-mutation-guard.test.ts \
  src/__tests__/server.test.ts
```

- [ ] **Step 3: Implement one target-set operation**

`beginNotion` receives:

```ts
interface BeginNotionMutation {
  tool: "jhw_record" | "jhw_note" | "jhw_delete" |
        "jhw_start" | "jhw_close" | "jhw_append" | "jhw_report_export";
  context: ControlContext;
  databases: DatabaseName[];
  digest_input: unknown;
}
```

It creates sorted unique `notion.mutate + notion_database` requirements, strips `control_context` from digest input, and calls `GuardService.beginExecution` with boundary `notion`. It never calls the Notion client itself.

- [ ] **Step 4: Return policy outcomes as normal MCP results**

`guardMcpResult` emits a bounded JSON object containing the complete Guard decision. `PERMIT_REQUIRED` includes `approval_command` and `approval_expires_at` and uses no exception message. DENY includes stable code/reason. Neither result invokes a write.

- [ ] **Step 5: Make server startup read-safe**

`createServer` accepts injected authority/mutation guards for tests. The default mutation guard is lazy: missing Registry/Guard configuration does not prevent read-only MCP server startup, but the first mutation returns `GUARD_UNAVAILABLE`. Never downgrade to an allow-all default.

- [ ] **Step 6: Verify and commit the shared MCP boundary**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/mcp-mutation-guard.test.ts \
  src/__tests__/server.test.ts
npm run build
npm run typecheck
```

```bash
git add mcp-server/src/control/mcp-mutation-guard.ts \
        mcp-server/src/control/guard-protocol.ts \
        mcp-server/src/control/operation-normalizer.ts \
        mcp-server/src/control/__tests__/mcp-mutation-guard.test.ts \
        mcp-server/src/server.ts \
        mcp-server/src/__tests__/server.test.ts
git commit -m "feat(guard): add MCP mutation boundary"
```

---

### Task 2: Guard always-mutating Notion tools before their first write

**Files:**
- Modify: `mcp-server/src/tools/record.ts`
- Modify: `mcp-server/src/tools/note.ts`
- Modify: `mcp-server/src/tools/start.ts`
- Modify: `mcp-server/src/tools/close.ts`
- Modify: `mcp-server/src/tools/__tests__/record.test.ts`
- Modify: `mcp-server/src/tools/__tests__/note.test.ts`
- Modify: `mcp-server/src/tools/__tests__/start.test.ts`
- Modify: `mcp-server/src/tools/__tests__/close.test.ts`
- Modify: `mcp-server/src/tools/__tests__/project-consistency.test.ts`

**Interfaces:**
- Adds required `control_context` to four always-mutating tool schemas.
- Changes registration functions to receive one injected `McpMutationGuard` in addition to existing Notion authority.

- [ ] **Step 1: Write failing no-write-before-receipt tests**

For every tool, assert:

- missing context returns a schema/tool validation failure;
- authority failure performs no Guard permit mutation and no Notion call;
- PERMIT_REQUIRED/DENY performs no property-builder side effect and no Notion call;
- beginExecution happens once before the first Notion mutation;
- success calls finish(COMPLETED);
- any first or later API failure calls finish(FAILED);
- a multi-write tool does not ask for a second permit after partial success.

Pin exact target sets:

- record: selected `db`;
- note: `knowledgeBase`;
- start: `projects` and `decisionLog`;
- close: `projects` and `knowledgeBase`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/tools/__tests__/record.test.ts \
  src/tools/__tests__/note.test.ts \
  src/tools/__tests__/start.test.ts \
  src/tools/__tests__/close.test.ts \
  src/tools/__tests__/project-consistency.test.ts
```

- [ ] **Step 3: Preserve authority-before-permit ordering**

For each handler:

1. validate input and known database;
2. call existing `assertNotionWriteAllowed` for every target;
3. call `beginNotion` once with all targets;
4. return policy result immediately unless ALLOW;
5. perform existing schema/property/API work;
6. finish the receipt in `try/catch/finally` without masking the original API result.

For `start` and `close`, include all actual write targets in one operation even when a later branch might skip one internal write.

- [ ] **Step 4: Keep existing validation semantics hard**

Do not let a receipt bypass:

- DB/property vocabulary;
- relation resolution;
- multi-select registration opt-in;
- rich-text/block limits;
- Registry authority route;
- retry/partial-failure semantics.

The Guard decides scope; the existing handlers still decide whether the Notion operation itself is valid.

- [ ] **Step 5: Verify and commit always-mutating tools**

```bash
cd mcp-server
npx vitest run \
  src/tools/__tests__/record.test.ts \
  src/tools/__tests__/note.test.ts \
  src/tools/__tests__/start.test.ts \
  src/tools/__tests__/close.test.ts \
  src/tools/__tests__/project-consistency.test.ts
npm run typecheck
```

```bash
git add mcp-server/src/tools/record.ts \
        mcp-server/src/tools/note.ts \
        mcp-server/src/tools/start.ts \
        mcp-server/src/tools/close.ts \
        mcp-server/src/tools/__tests__
git commit -m "feat(guard): enforce Notion create mutations"
```

---

### Task 3: Guard resolved-target and conditional Notion mutations

**Files:**
- Modify: `mcp-server/src/tools/delete.ts`
- Modify: `mcp-server/src/tools/append.ts`
- Modify: `mcp-server/src/tools/report-export.ts`
- Modify: `mcp-server/src/notion/authority-guard.ts`
- Modify: `mcp-server/src/tools/__tests__/delete.test.ts`
- Modify: `mcp-server/src/tools/__tests__/append.test.ts`
- Modify: `mcp-server/src/tools/__tests__/report-export.test.ts`
- Modify: `mcp-server/src/notion/__tests__/authority-guard.test.ts`

**Interfaces:**
- Adds required `control_context` to delete/append.
- Adds optional `control_context` to report export and requires it when write-back is enabled.
- Changes unknown `page` targets from permissive fallback to hard `GUARD_RESOURCE_AUTHORITY_UNAVAILABLE`.

- [ ] **Step 1: Write failing target-resolution tests**

Assert:

- delete/append may perform only the read required to resolve ancestry before Guard execution;
- their PreToolUse path marks canonical resource resolution as deferred, creates no permit request, and permits only entry into the owned MCP handler;
- a Projects, Decision Log, Preferences, References, or Knowledge Base descendant maps to the exact logical database resource;
- unknown page, ancestor cycle, conflicting parents, or read failure performs no Guard request and no mutation;
- delete archive fallback is covered by the same already-consumed receipt;
- append partial batch failure marks FAILED and does not create a new request;
- report export without write-back remains read-only and ignores absent context;
- enabled write-back requires context, exact selected DB authority, and one receipt.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/tools/__tests__/delete.test.ts \
  src/tools/__tests__/append.test.ts \
  src/tools/__tests__/report-export.test.ts \
  src/notion/__tests__/authority-guard.test.ts
```

- [ ] **Step 3: Resolve canonical target before permit creation**

Reuse `resolveTargetDatabase`, but do not map unresolved `page` to a broad logical resource. Return a stable hard-deny result because no canonical Work Contract tuple can represent it.

After resolution:

1. run existing authority check;
2. call `beginNotion`;
3. mutate only after receipt;
4. finish once for the whole tool call.

- [ ] **Step 4: Handle conditional report write-back explicitly**

Because `server.tool(..., ExportInput.shape, handler)` does not retain a Zod object-level refinement, keep `control_context` optional in the exposed shape and perform this explicit handler check:

```ts
if (args.writeBack?.enabled && args.control_context === undefined) {
  return guardMcpResult({
    decision: "DENY",
    code: "GUARD_CLAIM_REQUIRED",
    summary: "jhw_report_export write-back requires control_context",
  });
}
```

Do not require context when `enabled` is absent/false.

- [ ] **Step 5: Verify and commit resolved/conditional tools**

```bash
cd mcp-server
npx vitest run \
  src/tools/__tests__/delete.test.ts \
  src/tools/__tests__/append.test.ts \
  src/tools/__tests__/report-export.test.ts \
  src/notion/__tests__/authority-guard.test.ts
npm run build
npm run typecheck
```

```bash
git add mcp-server/src/tools/delete.ts \
        mcp-server/src/tools/append.ts \
        mcp-server/src/tools/report-export.ts \
        mcp-server/src/notion/authority-guard.ts \
        mcp-server/src/tools/__tests__ \
        mcp-server/src/notion/__tests__/authority-guard.test.ts
git commit -m "feat(guard): enforce resolved Notion mutations"
```

---

### Task 4: Add dedicated tracker comment/close execution boundaries

**Files:**
- Create: `mcp-server/src/control/tracker-service.ts`
- Create: `mcp-server/src/control/__tests__/tracker-service.test.ts`
- Modify: `mcp-server/src/control/github-source.ts`
- Modify: `mcp-server/src/control/task-completion.ts`
- Modify: `mcp-server/src/control/task-service.ts`
- Modify: `mcp-server/src/control/operation-normalizer.ts`
- Modify: `mcp-server/src/control/shell-classifier.ts`
- Modify: `mcp-server/src/control/cli.ts`
- Modify: `mcp-server/src/control/__tests__/task-service.test.ts`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts`

**Interfaces:**
- Adds: `jhw-control tracker comment --task --claim --session --origin-adapter --body-file <path>`.
- Adds: `jhw-control tracker close --task --claim --session --origin-adapter`.
- Produces: `GitHubSourceService.resolveTaskIssue(taskId)`.
- Reuses: `GuardService.beginExecution(... boundary: "tracker")`.
- Changes: formal `task finish --status completed` requires the same active Claim's source Issue to be live-closed; child/temporary finish semantics remain unchanged.

- [ ] **Step 1: Write failing tracker authority tests**

Test:

- formal standalone/parent resolves its own Issue node ID;
- child comment resolves the formal parent Issue and requires its exact grant;
- child close fails `TRACKER_CLOSE_REQUIRES_FORMAL_TASK`;
- parent close without same-Claim completion evidence fails `TASK_COMPLETION_EVIDENCE_REQUIRED`;
- evidence for another Claim/contract digest fails;
- required child state/dispositions are rechecked immediately before close;
- formal completed finish while the source Issue is open fails `TASK_ISSUE_STILL_OPEN` before Claim release, while finish after the guarded close succeeds;
- body file must be a bounded regular non-symlink file inside the Claim worktree;
- body content digest participates in execution-layer approval binding but body text is never journaled;
- PreToolUse permits entry only into the recognized tracker command and defers live Issue/body authority resolution to TrackerService;
- live Issue node ID, repository, open state, and source revision are pinned and re-resolved before consume;
- comment/close API begins only after execution receipt;
- API failure consumes the permit and records FAILED;
- raw `gh issue` remains wrapper-required/hard denied.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/tracker-service.test.ts \
  src/control/__tests__/cli.test.ts \
  src/control/__tests__/operation-normalizer.test.ts \
  src/control/__tests__/shell-classifier.test.ts
```

- [ ] **Step 3: Implement exact Issue resolution**

`resolveTaskIssue`:

- formal Task → exact source Issue;
- child → load formal parent and exact source Issue for comment only;
- temporary → `TASK_HAS_NO_ISSUE`;
- verify Registry Repository slug/node identity and live GitHub Issue node ID/revision/state;
- return bounded canonical coordinates, never a free-text URL as authority.

Digest material includes Issue node ID, repository node ID, live revision/state, operation kind, and body SHA-256 where applicable.

- [ ] **Step 4: Enforce pre-close evidence while Claim is active**

`tracker close` order:

1. assert active formal Task/Claim/session/worktree owner;
2. load exact `task-completion/<task>/<claim>.yaml`;
3. compare Task, Claim, and Work Contract digest;
4. reload children and run `assertParentCompletionReady`;
5. resolve live open Issue;
6. begin tracker execution/consume permit;
7. close the exact Issue node through `gh api`;
8. finish receipt.

The caller then runs ordinary `task finish --status completed`, which archives the Claim with the evidence pointer. Issue close and Claim finish are separate ordered operations.

Before a formal standalone/parent completed finish releases the Claim, `TaskService` must resolve the exact source coordinates again and require the live Issue state to be `closed`. The check uses the Task's canonical repository/Issue identity rather than free text; it does not require the pre-close source revision to remain equal because closing the Issue changes that revision. An open or mismatched Issue leaves the Claim active. Handoff/abandoned outcomes and child/temporary lifecycle transitions retain their existing rules.

- [ ] **Step 5: Keep Project Control source creation separate**

Do not route `task start`, temporary promotion, repository registration, or Project registration through `tracker comment/close`. Their existing explicit control-plane workflows and source checks remain intact. The shell classifier recognizes those exact `jhw-control` transitions and does not misclassify them as raw workload Issue mutation.

- [ ] **Step 6: Verify and commit tracker boundaries**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/tracker-service.test.ts \
  src/control/__tests__/task-completion.test.ts \
  src/control/__tests__/task-service.test.ts \
  src/control/__tests__/cli.test.ts \
  src/control/__tests__/operation-normalizer.test.ts \
  src/control/__tests__/shell-classifier.test.ts
npm run build
npm run typecheck
npm test
```

```bash
git add mcp-server/src/control
git commit -m "feat(guard): enforce issue mutation boundaries"
```

---

### Task 5: Update all write workflows, adapter fixtures, preflight, and E2E gates

**Files:**
- Modify: `skills/claude/save.md`
- Modify: `skills/claude/report.md`
- Modify: `skills/claude/project.md`
- Modify: `skills/claude/review.md`
- Modify: `skills/claude/compact.md`
- Modify: `skills/claude/match.md`
- Modify: `skills/claude/task.md`
- Regenerate: affected `skills/codex/jhw-*/SKILL.md`
- Modify: `mcp-server/src/control/__fixtures__/hooks/claude/pre-tool-edit.json`
- Modify: `mcp-server/src/control/__fixtures__/hooks/codex/pre-tool-edit.json`
- Create: `mcp-server/src/control/__tests__/notion-tracker.e2e.test.ts`
- Modify: `scripts/test-hook-preflight.sh`
- Modify: `README.md`

**Interfaces:**
- Teaches mutating skill calls to include exact active control context.
- Changes preflight `execution_recheck.notion` and `execution_recheck.tracker` to `ok`.

- [ ] **Step 1: Add MCP/tracker adapter contract fixtures**

For Claude and Codex, prove hook and execution normalization produce the same digest material whenever the canonical target is present in tool arguments:

- `jhw_record` to one database;
- `jhw_start` to two databases;
- `jhw_delete`/`jhw_append` PreToolUse defers target resolution without creating a request, while the handler produces a stable digest after ancestry resolution;
- report export with and without write-back;
- tracker comment/close PreToolUse defers live Issue/evidence resolution, while TrackerService produces the stable body/evidence-bound digest.

Changing Task/Claim/session/origin/cwd/DB/Issue/body after approval must fail mismatch.

- [ ] **Step 2: Update canonical skill instructions**

Every write-capable path must:

1. obtain current Task/Claim/session/worktree from Project Control;
2. include `control_context` on a mutating MCP call;
3. surface Guard's exact approval command unchanged;
4. retry the exact tool call only after exact user unlock;
5. never treat `ok`, `진행`, or `다음` as scope approval.

Read-only review/match/report preview remains usable without context. Do not add an unlock skill.

- [ ] **Step 3: Add E2E scope-isolation scenarios**

Test:

1. local-hardening has `notion.mutate` for Knowledge Base and can save its local result.
2. It lacks Decision Log grant, receives a one-use request, and exact approval permits only that one write.
3. target-matrix's Issue status is visible as a dependency but supplies no tracker grant.
4. A child with parent-Issue comment grant can comment but cannot close.
5. Parent close fails before completion-ready evidence, succeeds once with evidence and active Claim, then the Claim can finish.
6. Hook bypass still reaches the MCP/tracker execution check.
7. Notion/API failure cannot reuse the consumed permit.

- [ ] **Step 4: Run complete repository and sync gates**

```bash
cd mcp-server
npm run build
npm run typecheck
npm test
cd ..
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
bash scripts/test-hook-preflight.sh
git diff --check
```

- [ ] **Step 5: Commit docs, fixtures, and E2E coverage**

```bash
git add skills/claude \
        skills/codex \
        mcp-server/src/control/__fixtures__/hooks \
        mcp-server/src/control/__tests__/notion-tracker.e2e.test.ts \
        scripts/test-hook-preflight.sh \
        README.md
git commit -m "docs(guard): route Notion and issue mutations"
```

---

## Plan 5 completion gate

Before board/firmware work:

1. Every Notion API mutation begins after one current execution receipt.
2. Conditional report export stays read-only without write-back.
3. Unknown page ancestry cannot be unlocked.
4. Raw Issue mutation remains blocked; dedicated commands use exact Issue node identity.
5. Parent Issue close requires active Claim-bound completion evidence and current child gates.
6. Formal completed Claim finish follows Issue close, refuses a still-open source Issue, and remains a separate recorded event.
7. Hook bypass, API partial failure, and changed target all fail safely.
8. Preflight reports publish, Notion, and tracker rechecks `ok`; board/remote/firmware remain pending.
