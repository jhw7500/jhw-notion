# Active-session-safe deployment implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Work in the existing Issue #153 worktree. Do not commit, push, merge, reboot, or deploy the user's runtime during implementation.

**Goal:** Implement and verify preparation, maintenance-only activation, managed consumer admission, and rollback so the first live deployment can be performed after the planned reboot.

**Architecture:** Built artifacts live in immutable, validated release directories. A stable bootstrap takes an OS-backed shared admission lease before resolving the active release; deployment takes the exclusive lease and checks supported consumers twice. Existing installer ownership and hook transactions remain the migration boundary, with explicit prepare and activate commands replacing in-place updates.

**Tech Stack:** Node.js ESM and built-in modules, Linux `/proc`, the existing host `/usr/bin/flock`, Bash, Node's test runner, TypeScript/Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-active-session-safe-deployment-design.md`; Issue #153's current scope includes the later first deployment, while this execution prepares code and verification only.

## Global Constraints

- Never build in live `dist` or `node_modules`, alter the user's actual TUI configuration, or run the live installer during implementation or testing.
- No dependency additions, process termination, Task/Claim lifecycle changes by deployment, automatic release deletion, reboot, or Phase 1B cutover.
- Preserve existing installer ownership checks, private transaction evidence, file modes, hook behavior, and foreign configuration content.
- Preparation may run with active consumers. Activation, rollback, migration, and uninstall require no supported consumers and an exclusive admission lease. No force option.
- Inventory is current-user-only and bounded; errors or uncertain observations fail closed. Output never includes PIDs, argv, environment, absolute paths, or Task/session coordinates.
- Runtime safety is limited to supported managed consumers; the operator must prevent new TUI/app-server sessions during the maintenance window.
- Tests use private temporary roots and real filesystem/process/lock behavior. Test fixtures are injected through module APIs, never through production CLI bypass flags or environment switches.
- Build, typecheck, the full Vitest suite, Node deployment tests, and the isolated installer uninstall/reinstall suite are required before readiness is claimed.

## File ownership and interfaces

| Task | Owned implementation | Owned tests |
| --- | --- | --- |
| 1 | `scripts/runtime-safety.mjs` | `scripts/test-runtime-safety.mjs` |
| 2 | `scripts/runtime-store.mjs`, `.gitignore` | `scripts/test-runtime-store.mjs` |
| 3 | `scripts/runtime-entry.mjs`, bootstrap launcher | `scripts/test-runtime-entry.mjs` |
| 4 | `install.sh`, `scripts/runtime-deploy.mjs`, `scripts/install-config.mjs`, required hook trust integration in `mcp-server/src/control/cli.ts` | installer/deploy integration tests and affected existing tests |
| 5 | README, DESIGN, runbook, spec consistency | full verification and final review |

### Task 1: Trusted filesystem, leases, and bounded consumer inventory

**Files:** Create `scripts/runtime-safety.mjs` and `scripts/test-runtime-safety.mjs`.

**Interfaces:**

```js
export class DeploymentError extends Error { /* public .code and optional .reason */ }
export function trustedDirectory(directory, { uid = process.getuid() } = {}) {}
export function trustedFile(file, { uid = process.getuid(), executable = false } = {}) {}
export function acquireLease(file, { shared = false, create = false } = {}) {
  // Returns { fd, close() }; throws DeploymentError on uncertainty/contention.
}
export function inspectConsumers({ repositoryRoot, procRoot = '/proc',
  uid = process.getuid(), excludePids = [], maxEntries = 32768,
  maxArgvBytes = 131072 } = {}) {
  // Returns { clear: boolean, counts: { tui, app_server, legacy, managed }, uncertain: number }.
}
export function requireQuiescence(options) {
  // Returns the inventory or throws a bounded DeploymentError.
}
```

- [ ] Write tests that trusted files reject symlinks, special files, hard links, wrong ownership where testable, and writable-by-others objects; root/current-user-owned sticky ancestors such as `/tmp` remain valid.
- [ ] Write real OS-lock tests: multiple shared holders coexist, an exclusive attempt fails while a shared holder exists, and the lock remains held while a descriptor inherited by a child remains open. Closing descriptors releases it without deleting the lock file.
- [ ] Write synthetic `/proc` fixture tests for supported TUI names and interpreter script argv, Codex app-server, exact legacy/runtime paths, unrelated Node commands, another UID, unreadable/missing/changing required records, and limits. Count only known consumer identities, not substring matches in arbitrary arguments. Do not expose fixture paths or PIDs in returned/error objects.

```js
test('exclusive deployment cannot cross a managed reader', () => {
  const reader = acquireLease(lockPath, { shared: true, create: true });
  try { assert.throws(() => acquireLease(lockPath), { code: 'DEPLOY_LOCK_CONTENDED' }); }
  finally { reader.close(); }
  const writer = acquireLease(lockPath); writer.close();
});
```

- [ ] Run `node --test scripts/test-runtime-safety.mjs`, observe missing behavior, then implement and repeat until passing.
- [ ] Validate all path ancestors without following unverified links. Open lease files with `O_NOFOLLOW`, verify current user, regular single-link type, mode `0600`, and descriptor/path identity. Acquire `/usr/bin/flock` through an inherited descriptor, keeping the same open-file description in the caller; never lock by an unchecked pathname.
- [ ] Inventory only the current user's processes; prove stable UID/stat/argv observations and fail closed on uncertainty. Exclude only explicit current orchestration PIDs, not whole process ancestry (an ancestor TUI must block deployment).
- [ ] Write the test evidence and limitations to the task report for independent review.

### Task 2: Immutable release preparation and activation history

**Files:** Create `scripts/runtime-store.mjs`, `scripts/test-runtime-store.mjs`; add `.jhw-runtime/` to `.gitignore`.

**Consumes:** Task 1's trusted filesystem and `DeploymentError`.

**Produces:**

```js
export async function prepareRelease({ repositoryRoot, build }) {}
export function validateRelease({ repositoryRoot, releaseId }) {}
export function readActivation({ repositoryRoot }) {}
export function publishActivation({ repositoryRoot, releaseId, expectedCurrent }) {}
export function rollbackActivation({ repositoryRoot, expectedCurrent }) {}
// prepare returns a bounded manifest summary; read returns validated relative IDs only.
// publish/rollback are called only with Task 4's held leases and quiescence gate.
```

- [ ] Test preparation against temporary Git/source fixtures and an injected build callback that writes realistic entry artifacts. Assert live `dist`, `node_modules`, links, and config bytes do not change on success or build failure.
- [ ] Test strict ID/manifest schemas, full artifact digests and modes, internal dependency symlinks, missing/tampered artifacts, special files, unsafe paths, and the single permitted credential link. Never read/copy `.env` bytes.
- [ ] Test two activations followed by rollback, pointer changes between observation and publish, malformed predecessor data, and preservation of all generations.

```js
const original = readActivation({ repositoryRoot });
publishActivation({ repositoryRoot, releaseId: a.releaseId, expectedCurrent: original });
const first = readActivation({ repositoryRoot });
publishActivation({ repositoryRoot, releaseId: b.releaseId, expectedCurrent: first });
rollbackActivation({ repositoryRoot, expectedCurrent: readActivation({ repositoryRoot }) });
assert.equal(readActivation({ repositoryRoot }).releaseId, a.releaseId);
```

- [ ] Run `node --test scripts/test-runtime-store.mjs` red, then implement staging from an explicit source allowlist. Build only under `.jhw-runtime/.stage.*`, compute source and artifact digests, fsync immutable manifests, and rename complete objects before publishing a symlink.
- [ ] Permit only bounded release/activation ID formats, exact manifest keys, repository-internal links, and the installer-created `.env` link to the canonical source. Revalidate ownership, types, bytes and pointer identity before transitions.
- [ ] Preserve valid staged releases on activation failure and prior generations on every failure; report uncertainty without automatic fallback or repair.
- [ ] Run focused tests and provide review evidence.

### Task 3: Stable managed bootstrap and admission lifetime

**Files:** Create `scripts/runtime-entry.mjs` and the small executable bootstrap launcher; create `scripts/test-runtime-entry.mjs`.

**Consumes:** Task 1 leases and Task 2 validated activation/release data.

**Produces:** Stable closed selectors `mcp`, `control`, `hook`, plus installer-owned `jhw-control` and `jhw-control-hook` launcher names. Runtime startup acquires the shared lease before resolving `current` and retains it for the entire child lifetime.

- [ ] Test a long-running real fixture child: an exclusive writer is refused while the child runs, including when a child retains the inherited descriptor after the supervisor exits. The child must never start while an exclusive lease is held.
- [ ] Test that a paused invocation resolves the release only after acquiring admission, closed selectors reject unexpected values, and startup preserves stdin/stdout/stderr and exit status without leaking deployment JSON into MCP stdout.
- [ ] Test hook maintenance failures render adapter-compatible bounded denial instead of permitting a tool. Keep SessionEnd behavior compatible.

```js
const lease = acquireLease(admissionPath, { shared: true });
try {
  const current = readActivation({ repositoryRoot });
  // Validate bootstrap manifest and chosen executable; pass lease.fd to the child.
  await runSelectedEntrypoint(current, selector, argv, lease.fd);
} finally { lease.close(); }
```

- [ ] Run `node --test scripts/test-runtime-entry.mjs` red, implement the launcher and manifest verification, then run green. Avoid environment-controlled lock bypasses and do not silently support arbitrary executables.
- [ ] Stage bootstrap helpers as a complete validated set. Replacing an existing bootstrap is a migration requiring the same exclusive maintenance boundary, never a prepare-time mutation.
- [ ] Provide independent review evidence.

### Task 4: Explicit installer preparation, activation, migration and rollback

**Files:** Modify `install.sh`, `scripts/install-config.mjs`, affected trust checks and tests; create `scripts/runtime-deploy.mjs` and integration tests.

**Consumes:** All prior tasks. Public CLI: `./install.sh --prepare`, `--status`, `--activate RELEASE_ID`, `--rollback`, and guarded `--uninstall`. Default install on an existing installation returns a bounded prepare/activate instruction without rebuilding or activation. A fresh install uses the same staging and gated activation machinery.

- [ ] Add integration tests proving prepare never invokes wiring, existing default install never builds, active/uncertain consumers refuse before shared mutation, and the inventory runs both before and after acquiring deploy/exclusive-admission leases.
- [ ] Add full private-HOME tests for first migration, later activation with no repeated config writes, rollback, uninstall/reinstall, foreign link/config refusal, failed hook checks, and retained transaction recovery evidence.
- [ ] Preserve old owned MCP `node <legacy-entry>` registrations during ownership recognition, and generate the new closed bootstrap command vectors in JSON/TOML/OpenCode. Existing foreign entries remain unchanged and rejected.
- [ ] Keep hook trust verification compatible with legacy direct launchers and the exact validated managed bootstrap. Never treat any arbitrary bootstrap, unchecked environment root or symlink target as trusted. Tests must prove tampered bootstrap/manifest/core files refuse trust.
- [ ] Run hook validation in a way that does not reacquire a conflicting lease or bypass the maintenance guard. Separate wiring verification, bounded runtime validation, and opening normal sessions explicitly; preserve restoration evidence on failure.
- [ ] Add strict argument parsing before any write; no unsafe internal CLI/environment shortcut may activate without the gate. Preserve executable mode on `install.sh` and launchers.
- [ ] Run Node deployment tests and isolated installer safety tests, repair regressions, and provide independent review evidence.

### Task 5: Deployment readiness documentation and final verification

**Files:** Update `README.md`, `DESIGN.md`, `docs/project-control/phase1a-runbook.md`, and the spec's superseded scope statements.

- [ ] Document exact prepare/status/activate/rollback commands, accepted release identifiers, supported consumer classes, private artifact locations, bootstrap migration, and bounded errors with operator actions.
- [ ] Document that preparation and testing happen before reboot. After reboot, keep new TUI/app-server starts disabled, inspect auto-started consumers, approve the exact activation, verify the pinned release and host contract/preflight/MCP startup, then resume work. A failed verification retains the maintenance window for validated rollback.
- [ ] Keep Issue #153 open until its later first deployment is verified; current implementation readiness is a separate checkpoint.
- [ ] Run the following in the isolated worktree, recording exit status and summary:

```bash
node --test scripts/test-runtime-safety.mjs scripts/test-runtime-store.mjs scripts/test-runtime-entry.mjs scripts/test-runtime-deploy.mjs
npm run build --prefix mcp-server
npm run typecheck --prefix mcp-server
npm test --prefix mcp-server
bash scripts/test-install-safety.sh
git diff --check
```

- [ ] Have an independent reviewer examine the whole implementation, lock lifetime, trust-boundary changes, legacy migration and recovery paths. Address findings and rerun only affected checks before reporting readiness.
- [ ] Report the exact remaining integration/deployment actions and do not claim that a live artifact was prepared, activated, or rolled back unless that exact action was authorized and performed.
