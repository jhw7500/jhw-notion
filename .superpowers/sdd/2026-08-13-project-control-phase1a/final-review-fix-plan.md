# Phase 1A Final Whole-Branch Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans in this sole-owner worktree. Every production correction below is strict RED→GREEN; no production edit may precede its focused failing test.

**Goal:** Close every Critical/Important item in the binding final-review brief while keeping Notion authoritative, Phase 1A single-host/explicit, and all persistence/output fail-closed and secret-free.

**Architecture:** Retain the existing one-CLI/service/port design. Add one descriptor-anchored Registry record store shared by Catalog, Claim, Task, Handoff, history, and authority reads; one GitHub source verifier/task-authority service for repository/checkout/Issue/project binding; and one centralized reject-not-redact persistence policy. Extend existing lifecycle, preflight, ProcessRunner, installer, and durability paths rather than introducing schedulers, leases, retries, or new frameworks.

**Tech Stack:** TypeScript/Node 20 ESM, Zod, installed `@notionhq/client` v5 types, installed Vitest 4.1.3, Bash, local Git/bare remotes and fake `gh` only.

## Global Constraints

- Existing Notion remains authority; no live `governance/authority.yaml`, migration, authority flip, live GitHub/Notion call, or synthetic pilot evidence.
- No cross-host retry, rebase/force, heartbeat/TTL/takeover automation, Actions, scheduler, automatic context, restore, dependency upgrade, `npx`, network, or `node_modules` edit.
- Canonical Claude skills first; regenerate Codex. Preserve `install.sh` mode `775` and foreign installs.
- Every mutation remains under the host lock and one non-forced Registry transaction.
- Tests use deterministic hooks/barriers and isolated paths; fake secrets are unmistakably fake.
- Pinned E2E runs twice as two fresh processes, never `--repeat`.

## File / Interface Map

- `mcp-server/src/control/codec.ts`: replace path-only helpers with `RegistryRecordStore`; descriptor-relative `readJson`, `readCommittedText`, `writeJson`, `writeText`, `remove`, `list`, and `headBlobId` operations.
- `mcp-server/src/control/persistence-policy.ts` (new): `PersistencePolicy.assertSafe(value, context, extraPrivatePaths?)`; exact non-short secret/private-path rejection only.
- `mcp-server/src/control/github-source.ts` (new): `verifyRepository`, `verifyCheckout`, `verifyIssue`, `registerRepository`, task scope/membership validation, and promotion inputs; only `repo` credential.
- `catalog.ts`, `claim-service.ts`, `task-service.ts`, `handoff.ts`, `registry-git.ts`, `schemas.ts`: consume the shared record store, enforce canonical relations/revisions/lifecycle, and expose resume/Handoff/cleanup.
- `github-project.ts`: private Project proof, exact Project membership, duplicate rejection, partial item adoption/reverification, permission/integrity classification.
- `authority.ts`, `preflight.ts`, `notion/authority-guard.ts`: committed authority prerequisite, service-level minimum-version enforcement, legacy trial check, privacy/remote/scope checks, and recursive database/data-source ancestry.
- `process.ts`, `cli.ts`: bounded noninteractive children, selected-token isolation, journal warning preservation, explicit commands, awaited stream flush.
- `install.sh`, `scripts/test-install.sh` (new): all-TUI skill/MCP ownership and atomic config durability.
- `journal.ts`, `worktree.ts`, `portfolio.ts`: hardlink rejection and fsync durability.
- Canonical `skills/claude/{task,project,portfolio}.md`, generated `skills/codex/**`, `README.md`, `DESIGN.md`, runbook, and tracked Task 3 report: only implemented Phase 1A flow.

## Contradiction / Scope Scan

- No binding contradiction found. Repository bootstrap, immutable resume, Handoff read, promotion, and cleanup are explicit operator surfaces already permitted by the approved design.
- Force-end rule: a temporary Task becomes `handoff` (explicitly resumable); takeover and a newly resumed Task are `active`; `completed` is terminal. This is within the brief’s allowed documented choice.
- Formal content/lifecycle remains GitHub Issue authority; Registry stores only verified coordinates/revision/aliases.
- Authority compatibility remains available to legacy MCP calls, but live control preflight requires a committed `legacy` record and rejects compatibility/missing state.
- The Task 7 local official-API artifact plus installed Notion SDK types resolve current response shapes; no web lookup is presently needed.

---

### Task 1: Descriptor-Anchored Registry Boundary and Canonical Source Relations

**Files:**
- Modify: `mcp-server/src/control/{codec,config,registry-git,catalog,claim-service,handoff,schemas}.ts`
- Create: `mcp-server/src/control/github-source.ts`
- Test: `mcp-server/src/control/__tests__/{codec,catalog,claim-service,github-source}.test.ts`
- Expand: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`

**Interfaces:**
- `new RegistryRecordStore(root, head, policy)` requires an absolute root and anchors it once per operation.
- `readJson(relativePath, schema, expectedIdentity?)`, `writeJson`, `writeText`, `remove`, `readCommittedText`, `headBlobId`, and bounded `list` reject traversal, symlink/non-directory ancestors, symlink/nonregular/multi-link leaves, and identity mismatch.
- `GitHubSourceService.registerRepository({repo_id, slug, repository_path})` derives node ID/private state; callers never supply node ID.
- `verifyTaskScope(taskId, checkout)` proves Repository Record, Project membership, checkout origin, private repo, and formal Issue freshness.

- [ ] **Step 1: RED Registry hostile paths.** Add literal tests that replace `tasks`, `repositories`, Claim/history ancestors, or leaves with symlinks/hardlinks; assert `REGISTRY_CORRUPT`/`UNSAFE_REGISTRY_PATH`, unchanged outside sentinel, unchanged local/remote HEAD, and clean status.
- [ ] **Step 2: Run RED.** `cd mcp-server && ./node_modules/.bin/vitest run src/control/__tests__/codec.test.ts src/control/__tests__/catalog.test.ts src/control/__tests__/claim-service.test.ts`; expect current path helpers to follow at least the Catalog ancestor/leaf fixtures.
- [ ] **Step 3: GREEN shared store.** Implement descriptor walking using retained `/proc/self/fd/<fd>` anchors and `O_NOFOLLOW`; private unique temp → full write → file fsync → descriptor rename → leaf/type/nlink/byte verification → directory/created-ancestor fsync; cleanup temp on every failure. Route Catalog/Claim/Handoff/history reads/writes/deletes through it and require regular HEAD blobs for existing authority.
- [ ] **Step 4: GREEN verification.** Re-run focused files; mutation check by changing nlink/type/embedded ID and confirm a test fails.
- [ ] **Step 5: RED source/bootstrap relations.** Add tests for relative Registry root; missing Repository/Project membership; wrong checkout/origin; public repo; caller node mismatch; slug rename/conflicting node; malformed/duplicate source; wrong-repo Issue; URL/node/number/revision mismatch; formal alias literal `owner/name#17`; bounded temporary alias collision.
- [ ] **Step 6: Run RED.** Focus `catalog.test.ts`, new `github-source.test.ts`, and matching E2E cases; expect missing command/service and permissive Catalog failures.
- [ ] **Step 7: GREEN source services.** Parse only canonical GitHub SSH/HTTPS origins, query complete repository/Issue shapes with `GH_REPO_TOKEN`, require `private:true`, derive formal alias/revision, verify Project Record membership, make exact repository identity idempotent/rename-safe, make formal adoption compare immutable coordinates and explicitly advance only verified newer revisions, make temporary alias reuse exact-idempotent/conflict-closed, and enforce Repository presence in Catalog.
- [ ] **Step 8: Verify and commit.** Run focused tests + `npm run build`; commit `fix(control): anchor registry records and source identity`.

### Task 2: Complete Atomic Task Lifecycle, Resume, Promotion, Handoff, and Cleanup

**Files:**
- Modify: `mcp-server/src/control/{schemas,catalog,claim-service,task-service,worktree,cli,handoff,registry-git}.ts`
- Test: `mcp-server/src/control/__tests__/{claim-service,task-service,worktree,cli,cli-entry}.test.ts`
- Expand: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`

**Interfaces:**
- `ActiveClaim.source_task_revision: string` is mandatory and service-derived.
- `TemporaryTask.lifecycle` is `active | handoff | completed | abandoned`.
- `task start --task ...`, `task handoff --task ... [--claim ...]`, `task promote ...`, and `task recover --action cleanup ...` are public and locked where mutating.
- `TaskService.start` validates task scope and `WorktreeManager.assertStartReady` before Claim creation.
- `ClaimService.readHistory` and `TaskService.recoverCleanup` anchor cleanup to one immutable archived Claim.

- [ ] **Step 1: RED canonical revision/lifecycle.** Tests assert formal Claim revision equals verified Task revision, temporary Claim revision equals committed Task blob ID, caller mismatch is rejected, finish/force-end/resume update temporary lifecycle in the same staged transaction, completed cannot claim, takeover stays active, and retry bytes remain stable.
- [ ] **Step 2: Run RED.** Focus Claim/Task/Catalog tests; expect missing Claim field, free-text Handoff evidence, and free lifecycle schema failures.
- [ ] **Step 3: GREEN atomic lifecycle.** Derive revision inside Claim transaction, use strict lifecycle enum, stage Task lifecycle beside Claim history/active removal or acquisition, and validate generated Handoff by parsing metadata + all six sections before persistence.
- [ ] **Step 4: RED explicit resume/Handoff/promotion.** CLI/service tests require immutable Task resume, same worktree reconcile, completed refusal, only latest unambiguous or exact committed Handoff, bounded pointer/summary, and promotion preserving Task ID while rejecting conflicting mapping.
- [ ] **Step 5: GREEN explicit surfaces.** Implement the four command paths with no timeline/session auto-load; resume returns only bounded Handoff metadata/progress/next-step; promotion uses verified Issue coordinates.
- [ ] **Step 6: RED cleanup crash windows.** Deterministic Worktree state hooks fail after Claim release, after `pending-remove`, after physical removal, and after tombstone save; assert successor start receives stable cleanup instruction and succeeds only after exact same-host archived cleanup.
- [ ] **Step 7: GREEN cleanup recovery.** Verify history task/ref/branch/repo/host/path against one mapping; refuse active successor, dirty, ahead, cross-host, alias/duplicate mapping; resume missing-path tombstone idempotently; sync state before/after physical removal.
- [ ] **Step 8: RED/GREEN journal success.** Inject post-success append failure for repository/project/temp start/finish; preserve exit 0 + coordinates and attach `{journal_warning:"JOURNAL_WRITE_FAILED"}` without retry pressure. If command also failed, preserve original error code and do not replace it.
- [ ] **Step 9: Verify and commit.** Focus lifecycle/CLI/E2E + build; commit `feat(control): complete explicit task recovery lifecycle`.

### Task 3: Truthful Authority Preflight, Recursive Notion Routing, Privacy, and Persistence Safety

**Files:**
- Create: `mcp-server/src/control/persistence-policy.ts`
- Modify: `mcp-server/src/control/{authority,preflight,process,cli,github-project,portfolio,registry-git,catalog,task-service,config,schemas}.ts`
- Modify: `mcp-server/src/notion/authority-guard.ts`
- Test: `mcp-server/src/control/__tests__/{authority,preflight,process,cli,cli-entry,github-project,portfolio,catalog,task-service}.test.ts`
- Test: `mcp-server/src/notion/__tests__/authority-guard.test.ts`
- Expand: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`

**Interfaces:**
- `createAuthorityService({..., toolVersion})` rejects malformed/future minimum versions inside `load()`.
- `PreflightService` requires a committed regular authority record, source=`central`, mode=`legacy`, private Project/Registry, exact `{project}` classic scope, exact GitHub SSH Registry remote, and a pure Notion-routing proof.
- `resolveTargetDatabase(pageId, Pick<Client,"pages"|"databases"|"dataSources">)` recursively traverses normalized/cycle-safe database and data-source parents.
- `PersistencePolicy.assertSafe` rejects, never redacts, known long secrets and configured private absolute paths before persistence/outbound and on restored content.
- `ProcessRunOptions.timeoutMs`; timeout maps to `COMMAND_TIMEOUT`; child env is noninteractive and credential-minimal.

- [ ] **Step 1: RED authority/preflight.** Add isolated authority fixtures for missing/malformed/nonregular/rollback/future-version/registry-mode; Project `public:true`; Registry `private:false`; unexpected classic scopes; non-GitHub/mismatched/multi remote; guard-indeterminate. Assert stable exit 78 and zero live mutation ports.
- [ ] **Step 2: GREEN authority/preflight.** Expose bounded committed-blob reads, enforce numeric semver minimum in authority service, add privacy fields/queries, exact scope set, canonical remote comparison, central legacy requirement, and pure protected/allowed target proof.
- [ ] **Step 3: RED nested Notion ancestry.** Fixtures cover protected/allowed nested databases, data-source→database and data-source chains, conflicting IDs, partial/unknown objects, cycle, depth 16, API failure, and zero mutation.
- [ ] **Step 4: GREEN Notion ancestry.** Use installed SDK `databases.retrieve` and `dataSources.retrieve` full response parents; normalize every ID, require consistent database/data-source pair, recurse until known configured target or workspace/page, and fail closed on ambiguity/unavailable/depth.
- [ ] **Step 5: RED persistence rejection.** Inject fake Project/repo/Notion/other secret values and Registry/state/worktree/checkout paths into objective, temp goal/done/scope, formal/Handoff fields, committed restore, and snapshot source. Assert no Registry/remote/API/journal/snapshot/output artifact changes or matching text.
- [ ] **Step 6: GREEN centralized policy.** Install policy at CLI plus Catalog/GitHub/Task/Handoff/Portfolio/committed-read boundaries; ignore empty/short/common values; return only stable `UNSAFE_PERSISTENCE_CONTENT` code/context.
- [ ] **Step 7: RED/GREEN process bounds and flush.** Use injected timeout trigger/fake child barrier (no sleeps), assert `GIT_TERMINAL_PROMPT=0`, batch SSH, exact selected `GH_TOKEN`, and absence of source credentials. Spawn installed/symlinked CLI with near-12-KiB stdout and bounded stderr; then await stream callbacks/use `process.exitCode` and add bounded child termination.
- [ ] **Step 8: Verify and commit.** Focus tests + build; commit `fix(control): make preflight and persistence fail closed`.

### Task 4: Installer Ownership and Local Durability

**Files:**
- Modify: `install.sh`
- Create: `scripts/test-install.sh`
- Modify: `mcp-server/src/control/{journal,worktree,portfolio,handoff,process}.ts`
- Test: `mcp-server/src/control/__tests__/{journal,lock,worktree,portfolio,task-service}.test.ts`

- [ ] **Step 1: RED installer ownership.** Isolated HOME fixtures for Claude/Gemini/OpenCode canonical links, Codex skills/prompts/legacy link, JSON/OpenCode/Codex same-name MCP entries, foreign file/symlink, install/uninstall/reinstall. Assert foreign bytes/targets/modes unchanged and install nonzero.
- [ ] **Step 2: Run RED.** `npm_config_offline=true bash scripts/test-install.sh`; expect destructive foreign TUI/MCP cases to fail assertions.
- [ ] **Step 3: GREEN installer.** Set `set -euo pipefail`; ownership-check every link/registration before any destructive action; pass config/root/entry via argv/env; use private temp + fsync + atomic rename with prior mode; preserve foreign entries; remove only current-repo entries; remove `$schema` interpolation; make npm pipeline status authoritative.
- [ ] **Step 4: RED durability.** Hardlink journal/lock tests, journal sync fault, Worktree post-rename directory-sync fault, first `snapshots/` parent-sync fault, and Handoff truncation exactly at newline/parser boundary.
- [ ] **Step 5: GREEN durability.** Require `nlink===1`, sync journal after bounded append, fsync Worktree state file + state directory, sync state parent when snapshot namespace first appears, and self-parse every generated/truncated Handoff.
- [ ] **Step 6: Verify and commit.** Installer test, focused unit files, `bash -n`, build, mode `775`; commit `fix(install): preserve ownership and local durability`.

### Task 5: Canonical Skills, Runbook, Adversarial Gate, and Final Evidence

**Files:**
- Modify: `skills/claude/{task,project,portfolio}.md`
- Regenerate: `skills/codex/**`
- Modify: `README.md`, `DESIGN.md`, `docs/project-control/phase1a-runbook.md`
- Modify: `.superpowers/sdd/2026-08-13-project-control-phase1a/task-3-report.md`
- Expand: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`
- Write ignored report: `.superpowers/sdd/2026-08-13-project-control-phase1a/final-review-fix-report.md`

- [ ] **Step 1: RED skill pressure tests/checklist.** Validate canonical skill commands exactly match CLI help for repository bootstrap, Project approval, formal/temp/existing resume, promotion, Handoff, cleanup; no recall/history/auto context; advisory raw `assert-owner` race stated.
- [ ] **Step 2: GREEN docs/skills.** Update Claude only, regenerate Codex, add executable dirty/ahead fail-stop recovery and immutable host state/Registry identity, preserve Notion/legacy and insufficient-evidence statements, correct Task 3 superseded wording.
- [ ] **Step 3: Expand local E2E.** Add deterministic high-risk cases from every workstream, including outside sentinel/Git state, membership/Issue mismatch/duplicate source, journal gaps, cleanup crash windows, authority/privacy/remote/scope, secret/path artifact audit, and fake-gh selected-token environment.
- [ ] **Step 4: Run two fresh E2E processes.** `cd mcp-server && ./node_modules/.bin/vitest run src/control/__tests__/phase1a.e2e.test.ts` twice; both must pass independently.
- [ ] **Step 5: Full gates.** `npm test`; `npm run build`; skill sync/check; `npm_config_offline=true bash scripts/test-install.sh`; `bash -n install.sh`; installed-bin near-cap test; `git diff --check`; mode/path/secret scans; base-diff self-review.
- [ ] **Step 6: Report and commit.** Write RED/GREEN counts, exact commands, thematic commits, concerns, and “live evidence remains insufficient”; commit docs/tests as `docs(control): finalize phase1a operator contract`.
- [ ] **Step 7: Completion verification.** Invoke verification-before-completion, rerun final required checks after the last commit, require `git status --short` empty, and return `DONE` only if no Critical/Important remains; otherwise exact `DONE_WITH_CONCERNS`.

## Final Plan Self-Review

- Spec coverage: 1A–1D → Tasks 1/3; 2A–2F → Task 2; 3A–3E → Task 3; 4A–4B → Task 4; docs/E2E/gates → Task 5.
- Placeholder scan: no TBD/TODO/deferred implementation placeholder; accepted deferrals remain excluded.
- Type consistency: source revision is Claim-owned throughout; resume/promote/cleanup use canonical Task/Claim IDs; all path persistence uses one policy/store; preflight policy errors map to 78.
