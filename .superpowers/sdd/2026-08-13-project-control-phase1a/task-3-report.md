# Task 3 Report — Fast-forward Registry Transaction and Canonical Catalog

## Status

Completed; commit recorded below after the final verification gate.

## Design

- `RegistryGit.transact()` is intentionally lock-agnostic: the future CLI holds the host lock before invoking it. It checks a clean checkout, fetches, compares `HEAD` to `origin/main`, runs a typed mutation callback, stages only its exact relative paths, commits, makes a non-forced `HEAD:main` push, refetches, and verifies remote equality.
- The mutation callback returns `RegistryMutationResult { paths }`; empty paths are the explicit idempotent no-change result. Registry changes absent from that list are rejected rather than inferred or staged. Path traversal and absolute staging paths are rejected.
- A real non-fast-forward push rejection becomes `REMOTE_DIVERGED` without rebase, retry, or force. Authentication/transport/server failures remain `COMMAND_FAILED`; post-push fetch/compare failure is `REMOTE_VERIFY_FAILED`.
- `Catalog` persists JSON-subset YAML at the required repository/task and base64url GitHub-source-index paths. Repository creation and its index, formal task creation and its index, and temporary-task promotion plus its index each occur in one Registry transaction.
- Existing Issue mappings adopt their canonical Task ID. Promotion fails closed when the Issue index points to another Task, and is idempotent for the same Task. Formal records retain only canonical/source/relationship fields; temporary records own goal, done conditions, scope, and lifecycle.

## Files

- `mcp-server/src/control/registry-git.ts`
- `mcp-server/src/control/catalog.ts`
- `mcp-server/src/control/__tests__/registry-git.test.ts`
- `mcp-server/src/control/__tests__/catalog.test.ts`

## TDD evidence

### RED

1. `cd mcp-server && npx vitest run src/control/__tests__/registry-git.test.ts src/control/__tests__/catalog.test.ts`
   - Failed as expected before implementation: both suites could not import the missing `registry-git.js` / `catalog.js` modules.
2. Traversal regression: `catalog.registerRepository({ repo_id: "../escaped", ... })`
   - Failed before the input-boundary fix: it adopted a valid record outside `repositories/` and returned `{ created: false }` instead of `INVALID_REPOSITORY`.
3. Non-divergence push regression (temporarily restored the former broad push-error mapping): `npx vitest run src/control/__tests__/registry-git.test.ts --reporter=dot`
   - Failed as expected: permission-denied push was incorrectly surfaced as `REMOTE_DIVERGED` instead of `COMMAND_FAILED`.
4. Exact-mutation regression: `npx vitest run src/control/__tests__/registry-git.test.ts --reporter=dot`
   - Failed as expected: a callback that changed `governance/staged.json` and undeclared `governance/unrelated.json` committed the declared path rather than raising `MUTATION_PATH_MISMATCH`.
5. Protected-branch classification regression: `npx vitest run src/control/__tests__/registry-git.test.ts --reporter=dot`
   - Failed as expected: `[remote rejected] ... (pre-receive hook declined)` plus `failed to push some refs` was incorrectly classified as `REMOTE_DIVERGED`; only non-fast-forward indicators now receive that code.

### GREEN

`cd mcp-server && npx vitest run src/control/__tests__/registry-git.test.ts src/control/__tests__/catalog.test.ts && npm run build`

- Passed: 2 files / 18 tests.
- TypeScript build exited 0.

## Full verification

`cd mcp-server && npm test && npm run build`

- Passed: 36 test files / 311 tests.
- Passed: TypeScript `tsc` build with exit code 0.
- `git diff --check` passed with no whitespace errors.

## Self-review

- Confirmed the protocol is dirty-check → fetch → exact `HEAD`/remote comparison → mutation → no-change return → explicit `git add -- <paths>` → commit → non-force push → fetch/verify.
- Confirmed no `git add -A`, rebase, retry, or force-push path exists.
- Confirmed post-mutation status includes individual untracked files, so undeclared writes cannot be silently left dirty after a successful partial commit.
- Confirmed catalog stage paths are relative required paths and multi-file catalog operations return both record and source-index paths.
- Confirmed repository IDs are validated before constructing any record path, preventing traversal through user input.
- Independent review fixed the path-boundary and push-error classification findings; protected-branch/pre-receive hook errors are not treated as divergence. Architect review left a non-blocking source-index reverse-integrity watch listed below.

## Commit

`c50493f844f137eea08163841cd45ac075a2ea2f` (`feat(control): add canonical registry catalog`), amended after the final review correction.

## Concerns

- `Catalog` currently trusts a valid source-index-to-canonical-record mapping without reverse-validating that the canonical record's immutable GitHub node ID equals the index key. Normal writes preserve this invariant; a manually corrupted Registry should be rejected with a dedicated corruption error in a later hardening pass.
- A rejected non-fast-forward push deliberately leaves the local commit ahead while raising `REMOTE_DIVERGED`; Phase 1A does not auto-rebase, retry, force, or claim that unpushed local state is durable remotely.


---

## Fix round 1/5 — catalog integrity and public input validation

### Changes

- Added strict Zod input validators for all Catalog public mutation inputs before any Registry path construction or read. Repository, Issue, relation, URL, alias/revision, and temporary content values therefore cannot be bypassed through an existing source-index fast path.
- Added `REGISTRY_CORRUPT` as the stable fail-closed integrity result. Source-index resolution now validates index syntax, referenced record existence, record-path/embedded-ID equality, and immutable GitHub Repository/Issue node-ID equality before adoption or promotion.
- Promotion now validates the requested Task path's embedded ID before writing its formal record or Issue index.
- Added hostile fixtures for mismatched source node IDs, missing and path-mismatched Repository records, malformed idempotent-path inputs, and promotion path-ID corruption.

### TDD evidence

**RED:** With `catalog.ts` temporarily restored to Task 3 base `c50493f`, `cd mcp-server && npx vitest run src/control/__tests__/catalog.test.ts --reporter=dot` produced **6 expected failures**. The base implementation silently adopted mismatched Repository/Issue records, reported a missing indexed repository as `SOURCE_ALREADY_MAPPED`, bypassed malformed idempotent inputs, and promoted a Task whose path and embedded ID disagreed.

**GREEN:** `cd mcp-server && npx vitest run src/control/__tests__/registry-git.test.ts src/control/__tests__/catalog.test.ts && npm run build` passed **2 files / 24 tests** and TypeScript build exited 0.

### Full verification

`cd mcp-server && npm test && npm run build`

- Passed: 36 test files / 317 tests; TypeScript `tsc` build exited 0; `git diff --check` found no whitespace errors.

### Self-review

- Confirmed `REGISTRY_CORRUPT` details include source-index and record paths plus expected/actual IDs whenever those values exist.
- Confirmed a referenced missing or invalid record is corruption before any `SOURCE_ALREADY_MAPPED` adoption result.
- Confirmed external public input interfaces are unchanged and all runtime inputs are strictly parsed at method entry.
- Confirmed no deferred porcelain, Project Record, or remote verification work was broadened into this fix.

### Recovery caveat

`RegistryGit` remains intentionally fail-stop: if a mutation callback or declared-path integrity check rejects after writing, its checkout can remain dirty and the next mutation stops at `REGISTRY_DIRTY`. The operator must inspect and recover/clean that checkout; this round does not add rollback behavior.

### Fix commit

Created immediately after this final verification; recorded by the repository history alongside this report.

### Concerns

- A corrupted Registry is now rejected rather than silently adopted. Repairing such data remains an explicit operator action and is outside this transaction primitive.
