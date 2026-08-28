# Task Skill Host-Only Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every canonical `/jhw:task` lifecycle example through the installed secure-store-only v4 host without changing lifecycle policy.

**Architecture:** Keep `skills/claude/task.md` as the single consumer source and make the minimum invocation-only substitutions there. Extend the existing Node contract test with one static host-only boundary; the current executable start/finish/switch oracle remains responsible for argv, ordering, authorization, and reporting regressions, while Codex continues to consume the canonical file through its generated reference symlink.

**Tech Stack:** Markdown skill contracts, Node.js ESM with `node:assert/strict`, Bash installer checks, TypeScript/Vitest MCP regression suite

**Spec:** `docs/superpowers/specs/2026-08-28-jhw-control-host-v4-consumer-design.md`

## Global Constraints

- The installed producer contract must be version `4` with credential policy `secure-store-only` before consumer deployment.
- The canonical Task commands are exactly `start`, `child-start`, `contract`, `completion-ready`, `promote`, `status`, `handoff`, `finish`, `recover`, and `assert-owner`.
- Do not add raw CLI fallback, shell credential export, or config source/read behavior.
- Preserve the existing authorization gate, no-retry, no-takeover, resume/switch/recovery ordering, and four-field start reporting.
- Modify `skills/claude/task.md`; do not directly edit `skills/codex/jhw-task/` generated surfaces.
- Run every shell command through `rtk` as required by the repository host policy.
- Stop the consumer rollout if the v4 contract, preflight, review, merge, install, or sync gate fails.
- Perform the live #74 legacy Task migration separately through `jhw-task` after this consumer is merged and installed; do not persist live Task/Claim coordinates in repository files.

---

### Task 1: Pin and implement the host-only Task lifecycle boundary

**Files:**
- Modify: `scripts/test-task-skill-contract.mjs:620-710`
- Modify: `skills/claude/task.md:133-235`
- Modify: `skills/claude/task.md:403-429`

**Interfaces:**
- Consumes: canonical Markdown text loaded by `assertConsumerContract(label, taskPath)`
- Produces: `assertHostOnlyLifecycleContract(label, markdown)`; exact absolute launcher invocations for the eight lifecycle subcommands not already covered by the executable start/finish oracle

- [ ] **Step 1: Add the failing host-only consumer assertion**

Add this constant and function next to `assertStaticStartContract` in
`scripts/test-task-skill-contract.mjs`:

```javascript
const hostOnlyLifecycleCounts = new Map([
  ["child-start", 1],
  ["contract", 2],
  ["completion-ready", 1],
  ["promote", 1],
  ["status", 1],
  ["handoff", 1],
  ["recover", 4],
  ["assert-owner", 1],
]);

function assertHostOnlyLifecycleContract(label, markdown) {
  assert.doesNotMatch(markdown, /(^|[^-])jhw-control task(?:\s|$)/m,
    `${label}: raw Task lifecycle invocation must not remain`);
  for (const [subcommand, expectedCount] of hostOnlyLifecycleCounts) {
    const absoluteInvocation = new RegExp(
      `^"\\$HOME/\\.local/bin/jhw-control-host" task ${subcommand}(?: \\\\| |$)`,
      "gm",
    );
    assert.equal(markdown.match(absoluteInvocation)?.length ?? 0, expectedCount,
      `${label}: ${subcommand} must use the absolute host exactly ${expectedCount} time(s)`);
  }
}
```

Call it immediately after `const markdown = await readFile(taskPath, "utf8");` in
`assertConsumerContract`:

```javascript
assertHostOnlyLifecycleContract(label, markdown);
```

- [ ] **Step 2: Run the focused contract test and verify the new assertion fails**

Run:

```bash
rtk node scripts/test-task-skill-contract.mjs
```

Expected: FAIL with `raw Task lifecycle invocation must not remain` for the Claude canonical consumer; no repository file outside the test has changed yet.

- [ ] **Step 3: Replace every remaining raw lifecycle invocation in the canonical skill**

Apply these exact invocation-line substitutions in `skills/claude/task.md`; leave flags, argument order, prose, authorization, and error handling unchanged:

```diff
-jhw-control task child-start \
+"$HOME/.local/bin/jhw-control-host" task child-start \
-jhw-control task status --task <tsk-id> [--claim <active-claim-id>]
+"$HOME/.local/bin/jhw-control-host" task status --task <tsk-id> [--claim <active-claim-id>]
-jhw-control task contract --task <tsk-id> --role standalone \
+"$HOME/.local/bin/jhw-control-host" task contract --task <tsk-id> --role standalone \
-jhw-control task contract --task <formal-tsk-id> --role parent \
+"$HOME/.local/bin/jhw-control-host" task contract --task <formal-tsk-id> --role parent \
-jhw-control task handoff --task <tsk-id> [--claim <released-handoff-claim-id>]
+"$HOME/.local/bin/jhw-control-host" task handoff --task <tsk-id> [--claim <released-handoff-claim-id>]
-jhw-control task promote --task <tsk-id> \
+"$HOME/.local/bin/jhw-control-host" task promote --task <tsk-id> \
-jhw-control task completion-ready --task <tsk-id> --claim <current-claim-id> \
+"$HOME/.local/bin/jhw-control-host" task completion-ready --task <tsk-id> --claim <current-claim-id> \
-jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action status
+"$HOME/.local/bin/jhw-control-host" task recover --task <tsk-id> --expect <active-claim-id> --action status
-jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action force-end
+"$HOME/.local/bin/jhw-control-host" task recover --task <tsk-id> --expect <active-claim-id> --action force-end
-jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action takeover \
+"$HOME/.local/bin/jhw-control-host" task recover --task <tsk-id> --expect <active-claim-id> --action takeover \
-jhw-control task recover --task <tsk-id> --expect <released-claim-id> --action cleanup
+"$HOME/.local/bin/jhw-control-host" task recover --task <tsk-id> --expect <released-claim-id> --action cleanup
-jhw-control task assert-owner --task <tsk-id> --claim <current-claim-id>
+"$HOME/.local/bin/jhw-control-host" task assert-owner --task <tsk-id> --claim <current-claim-id>
```

- [ ] **Step 4: Run the focused contract test and verify both consumers pass**

Run:

```bash
rtk node scripts/test-task-skill-contract.mjs
```

Expected: exit 0 and `task skill consumer contracts: ok`. This exercises the canonical Claude file and the Codex reference to the same file.

- [ ] **Step 5: Regenerate and verify Codex skill metadata without editing generated files by hand**

Run:

```bash
rtk node scripts/sync-codex-skills.mjs
rtk node scripts/sync-codex-skills.mjs --check
```

Expected: sync succeeds and the check reports no drift. `skills/codex/jhw-task/references/task.md` remains a symlink resolving to `skills/claude/task.md`.

- [ ] **Step 6: Verify the diff and commit the self-contained consumer change**

Run:

```bash
rtk rg -n '(^|[^-])jhw-control task' skills/claude/task.md
rtk git diff --check
rtk git diff -- scripts/test-task-skill-contract.mjs skills/claude/task.md skills/codex/jhw-task docs/superpowers
```

Expected: the first command exits 1 with no matches; `git diff --check` is clean; the diff contains only the spec, plan, focused test boundary, canonical invocation substitutions, and any deterministic sync output.

Commit:

```bash
rtk git add docs/superpowers/specs/2026-08-28-jhw-control-host-v4-consumer-design.md docs/superpowers/plans/2026-08-28-task-skill-host-only-lifecycle.md scripts/test-task-skill-contract.mjs skills/claude/task.md skills/codex/jhw-task
rtk git commit -m "fix(task): route lifecycle commands through secure host"
```

### Task 2: Run the complete consumer regression and installation gates

**Files:**
- Verify: `scripts/test-task-skill-contract.mjs`
- Verify: `scripts/test-install-safety.sh`
- Verify: `mcp-server/tsconfig.test.json`
- Verify: `mcp-server/package.json`
- Verify: `install.sh`

**Interfaces:**
- Consumes: committed host-only canonical skill and generated Codex reference from Task 1
- Produces: reproducible evidence that the Markdown consumer, installer, TypeScript tests, runtime tests, and build all pass before review

- [ ] **Step 1: Re-run the focused skill and sync gates from the committed tree**

Run:

```bash
rtk node scripts/test-task-skill-contract.mjs
rtk node scripts/sync-codex-skills.mjs --check
```

Expected: both commands exit 0; the focused test prints `task skill consumer contracts: ok`.

- [ ] **Step 2: Run the installer safety suite**

Run:

```bash
rtk bash scripts/test-install-safety.sh
```

Expected: exit 0. This suite invokes the Task skill consumer contract and verifies install/uninstall behavior in its isolated test environment.

- [ ] **Step 3: Run the mandatory MCP type gate**

Run:

```bash
rtk npm run typecheck --prefix mcp-server
```

Expected: exit 0 with no TypeScript errors, including test sources.

- [ ] **Step 4: Run the full MCP test suite**

Run:

```bash
rtk npm test --prefix mcp-server
```

Expected: Vitest exits 0 with every test passing.

- [ ] **Step 5: Run the production build and final cleanliness checks**

Run:

```bash
rtk npm run build --prefix mcp-server
rtk git diff --check
rtk git status --short --branch
```

Expected: build exits 0; diff check is clean; the branch has no uncommitted tracked or untracked implementation artifacts.

### Task 3: Review, integrate, and install the consumer before live migration

**Files:**
- Review: `docs/superpowers/specs/2026-08-28-jhw-control-host-v4-consumer-design.md`
- Review: `scripts/test-task-skill-contract.mjs`
- Review: `skills/claude/task.md`
- Deploy: `install.sh`

**Interfaces:**
- Consumes: clean Task branch and Task 2 validation evidence
- Produces: reviewed change merged to `main`, installed canonical consumer, and a clear stop point before the separate live #74 migration

- [ ] **Step 1: Request an independent code review against the local spec**

Use `superpowers:requesting-code-review` with the Task 1 commit range and require findings to cite the local spec. Resolve every Critical or Important finding, rerun the focused contract and affected full gates, and request a fresh review after any fix.

- [ ] **Step 2: Recheck Task ownership immediately before the shared Git boundary**

Use the active bounded #74 Task/Claim coordinates already verified by `jhw-task` in the executor session. Run `task assert-owner` through the absolute v4 host immediately before push; stop without pushing if ownership is not exact. Do not write those live coordinates into this plan or another repository file.

- [ ] **Step 3: Push the Task branch and create the consumer PR**

Run:

```bash
rtk git push origin task/3fa8c9d1e7ea-jhw7500-jhw-notion-74
rtk gh pr create --repo jhw7500/jhw-notion --base main --head task/3fa8c9d1e7ea-jhw7500-jhw-notion-74 --title "fix(task): route lifecycle commands through secure host" --body "Closes the secure-store-only consumer gap for #74. Preserves existing lifecycle policy and adds a host-only contract gate."
```

Expected: the push and PR creation succeed. If a PR already exists for the new commit range, reuse it rather than creating a duplicate.

- [ ] **Step 4: Merge only after required review and target gates are clean**

Re-run the ownership assertion immediately before merge. Merge only when the independent review has no Critical or Important finding and the focused contract, sync check, install safety, typecheck, test, and build gates are green. Stop on conflicting review, failing gate, or ownership mismatch.

- [ ] **Step 5: Install from the merged stable checkout and verify the installed consumer**

Fast-forward the stable `main` checkout to the merged commit without touching its preserved `.serena/` directory, then run:

```bash
rtk bash install.sh
rtk node scripts/sync-codex-skills.mjs --check
rtk node scripts/test-task-skill-contract.mjs
```

Expected: install succeeds, sync has no drift, and the installed source contract passes. Confirm the installed Codex `jhw-task` reference resolves to the same canonical `skills/claude/task.md` content.

- [ ] **Step 6: Stop at the consumer rollout boundary and hand off to the live Task migration workflow**

Do not run live registry mutation as part of this implementation plan. Continue separately with `jhw-task` using the approved sequence `status → finish --status handoff → contract → start → completion-ready → finish --status completed`, the bounded coordinates returned at each step, and the workflow's mutation approval rules. Check worktree cleanup and GitHub Issue state after the completed finish.
