# Stale Mapping Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unrelated stale host mappings from blocking an explicitly approved Task takeover, add an exact-coordinate orphan-mapping repair command, and record normal session-end Git evidence without releasing Task ownership.

**Architecture:** Keep Registry Claim history authoritative and `worktrees.json` host-local. Takeover first validates its direct target and then physically inspects only mappings whose stored coordinates could collide. `repair-mapping` runs under the existing host-global mutation lock, proves an exact mapping orphaned against committed Registry state, compare-and-swaps the mapping to a durable `removed` tombstone, and never mutates Claims. `SessionEnd` is a bounded advisory hook that can append verified coordinates to a derived journal but has no lifecycle service dependency and no release/takeover path.

**Tech Stack:** TypeScript, Zod, Vitest, Node.js filesystem/Git process adapters, shell installer tests.

**Spec:** GitHub Issue #136 (`fix(control): prevent unrelated stale mappings from blocking takeover`).

## Global Constraints

- Preserve exact Task, Claim, worktree-ref, repository, branch, and host coordinates; never infer a repair target from a basename, session transcript, or directory scan.
- All repair inspection and publication runs under the host-global mutation lock with a mapping snapshot/CAS check.
- Only an absent checkout plus an absent active Registry Claim can become a `removed` tombstone. Live, dirty, aliased, symlinked, mismatched, changed, or otherwise uncertain state fails closed and leaves bytes unchanged.
- Session-end handling is best-effort and evidence-only. It may inspect the exact current session mapping and append bounded Git coordinates, but it never releases, finishes, force-ends, takes over, or repairs a Claim/mapping.
- Public payloads and journals contain bounded logical coordinates only; no absolute/private paths or session transcript contents.
- Every new `ControlError` reason is registered in `ERROR_REASONS` and documented in `skills/claude/task.md` in the same change.
- Mandatory final gates are `npm run build`, `npm run typecheck`, and `npm test` from `mcp-server/`, plus installer uninstall/reinstall safety coverage.

---

### Task 1: Make takeover validation target-centered

**Files:**
- Modify: `mcp-server/src/control/__tests__/worktree.test.ts`
- Modify: `mcp-server/src/control/worktree.ts`

- [x] Add regression tests proving a missing active mapping with distinct task/path/repository+branch coordinates cannot block the exact takeover target.
- [x] Add fail-closed tests for missing/invalid direct targets and potentially colliding mappings (same task, path, or repository+branch), including removed-checkout reappearance.
- [x] Run the focused tests and confirm the new unrelated-mapping test fails for the current eager validation order.
- [x] Filter by stored logical collision coordinates before any unrelated physical path/repository inspection, while preserving full direct-target validation.
- [x] Re-run focused worktree tests and commit the slice.

### Task 2: Add exact orphan-mapping repair

**Files:**
- Modify: `mcp-server/src/control/__tests__/worktree.test.ts`
- Modify: `mcp-server/src/control/__tests__/task-service.test.ts`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts`
- Modify: `mcp-server/src/control/__tests__/phase1a.e2e.test.ts`
- Modify: `mcp-server/src/control/worktree.ts`
- Modify: `mcp-server/src/control/task-service.ts`
- Modify: `mcp-server/src/control/cli.ts`
- Modify: `mcp-server/src/control/schemas.ts`
- Modify: `skills/claude/task.md`

- [ ] Add failing manager tests for exact coordinate matching, absent checkout, idempotent tombstones, changed-state CAS, and byte-preserving refusals for live/symlink/alias/mismatch/pending cases.
- [ ] Add failing service tests proving committed Task coordinates and Registry Claim absence/release are authoritative, and that repair never calls Claim mutation APIs.
- [ ] Add failing CLI tests for `task recover --action repair-mapping --task <task> --expect <claim> --worktree-ref <ref>`, bounded output, required mutation lock, and safe journal metadata.
- [ ] Implement the manager CAS tombstone transition and service orchestration with stable error codes/reasons.
- [ ] Implement strict CLI parsing/output and include `repair-mapping` in the mutation-lock classifier.
- [ ] Add an end-to-end orphan repair/retry case and re-run all focused tests.
- [ ] Synchronize generated Codex skills and commit the slice.

### Task 3: Record advisory SessionEnd evidence without authority

**Files:**
- Modify: `mcp-server/src/control/__tests__/hook-codecs.test.ts`
- Modify: `mcp-server/src/control/__tests__/hook-adapter.test.ts`
- Modify: `mcp-server/src/control/__tests__/hook-contract.test.ts`
- Modify: `mcp-server/src/control/__tests__/guard-journal.test.ts`
- Modify: `mcp-server/src/control/hook-codecs.ts`
- Modify: `mcp-server/src/control/hook-adapter.ts`
- Modify: `mcp-server/src/control/guard-protocol.ts`
- Modify: `mcp-server/src/control/guard-journal.ts`
- Modify: `scripts/install-config.mjs`
- Modify: `scripts/test-hook-preflight.sh`
- Modify: `scripts/test-install-safety.sh`

- [ ] Add native Claude/Codex SessionEnd fixtures and strict decode/contract tests.
- [ ] Add adapter tests proving SessionEnd only invokes the evidence recorder, emits a neutral bounded response, and converts recorder/timeout failures into advisory output without lifecycle mutation.
- [ ] Add journal schema tests for a bounded `session-ended` event with Task/Claim/worktree-ref/branch/head/dirty/ahead/behind coordinates and no path/transcript data.
- [ ] Implement an evidence-only recorder composed from read-only Claim/worktree inspection and the derived Guard journal; do not expose Claim lifecycle methods on its port.
- [ ] Register SessionEnd in installed hook configuration with a bounded timeout and update install/preflight assertions.
- [ ] Re-run focused hook, journal, and installer tests and commit the slice.

### Task 4: Document, verify, review, and ship

**Files:**
- Modify: `README.md`
- Modify: `DESIGN.md`
- Modify: `skills/claude/task.md`
- Modify: generated Codex skill artifacts via `scripts/sync-codex-skills.mjs`

- [ ] Document explicit takeover approval, exact repair syntax/refusals, tombstone semantics, and evidence-only SessionEnd behavior.
- [ ] Run `node scripts/sync-codex-skills.mjs` and `node scripts/sync-codex-skills.mjs --check`.
- [ ] Run focused concurrency/failure tests, then `npm run build`, `npm run typecheck`, and `npm test` in `mcp-server/`.
- [ ] Run installer uninstall/reinstall validation without overwriting unrelated user configuration.
- [ ] Review the final diff for absolute paths, session IDs, unregistered reasons, placeholder text, and accidental Claim mutation from SessionEnd/repair.
- [ ] Run the required pre-PR tribunal with independently secured reviewer reports, finalize only after owner/type/mode verification, then create/merge the PR and deploy from the authoritative runtime checkout.
