# Active-session-safe jhw-notion deployment design

Date: 2026-09-12
Issue: https://github.com/jhw7500/jhw-notion/issues/153
Status: Approved for implementation; live rollout deferred

## 1. Decision summary

jhw-notion runtime artifacts will be built as immutable generations and exposed
through one stable `current` symlink. A deployment builds and validates a new
generation without modifying the live `dist` or `node_modules`, then atomically
switches `current` to the complete generation.

Processes that started before the switch continue using their old generation.
Processes started after the switch use the new generation. No deployment action
kills, restarts, finishes, releases, or takes over a Task or Claim.

The implementation, tests, documentation, commits, and review may proceed under
Issue #153. The first live activation is explicitly outside this implementation
run and requires a separate deployment approval. A server reboot is not an
activation prerequisite: existing sessions remain on their physical old release,
and only sessions started after activation resolve the new release.

## 2. Current problem

The current installer runs `npm ci` and `npm run build` directly in the checkout's
`mcp-server` directory. Global control links, TUI skill links, MCP registrations,
and Guard hook wiring also resolve directly into that checkout.

This creates three unsafe deployment windows:

1. A running or newly starting process can observe `node_modules` while `npm ci`
   replaces it.
2. A newly starting process can observe `dist` while the build cleans and
   regenerates it.
3. Updating several global links and configuration records can temporarily mix
   old and new entry points.

Stopping every session first would avoid some races, but it is not practical on
the shared build server. Read-only inspection recently found many MCP processes
using the same runtime checkout. Process discovery is also inherently racy, so a
zero-process observation cannot be the primary safety boundary.

## 3. Goals

- Never run dependency installation or compilation inside the live generation.
- Ensure a new invocation observes either one complete old generation or one
  complete new generation.
- Allow already-running MCP sessions to finish on the old generation without a
  forced restart.
- Report bounded active-process counts for the legacy path and each retained
  generation.
- Support a validated, atomic rollback to the predecessor generation.
- Keep Task/Claim lifecycle, automation #175, and Phase 1B authority cutover out
  of the deployment path.
- Preserve the installer's existing fail-closed ownership rules for links,
  configuration, hooks, and private transaction artifacts.

## 4. Non-goals

- Hot-reloading an already-running MCP process.
- Making all sessions change version at the same instant.
- Automatically terminating processes or restarting TUI sessions.
- Requiring or attempting to prove a host reboot before activation.
- Automatically deleting retained generations.
- Changing Notion credentials or copying `.env` secret bytes into a release.
- Changing the Project Control authority epoch or performing Phase 1B cutover.
- Deploying the implementation produced by Issue #153.

## 5. Runtime layout

The release store remains inside the canonical runtime checkout so existing
repository ownership checks remain meaningful and the ignored `.env` stays in
its current location.

```text
<runtime-checkout>/.jhw-runtime/
|-- deploy.lock
|-- current -> activations/<activation-id>
|-- activations/
|   |-- <activation-id>/
|   |   |-- manifest.json
|   |   |-- mcp-server -> ../../releases/<release-id>/mcp-server
|   |   |-- scripts -> ../../releases/<release-id>/scripts
|   |   `-- skills -> ../../releases/<release-id>/skills
|   `-- <older-activation-id>/...
|-- releases/
|   |-- <release-id>/
|   |   |-- manifest.json
|   |   |-- mcp-server/
|   |   |   |-- dist/
|   |   |   |-- node_modules/
|   |   |   |-- package.json
|   |   |   |-- package-lock.json
|   |   |   `-- .env -> <runtime-checkout>/mcp-server/.env
|   |   |-- scripts/jhw-control-hook
|   |   `-- skills/
|   `-- <older-release-id>/...
`-- .stage.<random>/
```

`.jhw-runtime/` is ignored by Git. Its directory, lock, manifests, releases, and
symlinks must be owned by the current user and must not traverse an unverified
symlink. Staging directories use mode `0700` and are never valid execution
targets.

Release IDs use a strict closed format derived from the source revision and a
content digest. A release `manifest.json` records the exact release ID, source
revision, content digest, creation time, and expected runtime entry digests.

Every publication creates a separate immutable activation directory with a
strict closed activation ID. Its manifest records the activation ID, selected
release ID, predecessor activation ID, creation time, and the exact prior
`current` observation. Its three relative links expose only the selected
validated release. `current` points to an activation rather than directly to a
release, so rollback history never requires mutating an immutable release.
Neither manifest contains a credential, absolute process command line, session
ID, Task coordinate, or Claim coordinate.

The release-local `.env` is an installer-created link to the checkout's existing
ignored `mcp-server/.env`. The installer never reads or copies its contents. A
missing source `.env` preserves the current shell-fallback behavior and warning.

## 6. Components

### 6.1 Runtime release helper

A focused Node helper owns release-store parsing and filesystem transitions. It
provides closed subcommands to:

- stage a release from an allowlisted source snapshot;
- validate a staged or retained release and its manifest;
- create an immutable activation for a validated release and publish it through
  an atomic `current` symlink rename;
- report current, predecessor, legacy, and active-process counts;
- atomically roll `current` back to its validated predecessor.

It returns bounded JSON. It rejects unknown keys, malformed release IDs,
non-regular runtime files, unsafe symlinks, ownership mismatches, unexpected
directory modes, manifest/digest mismatches, and concurrent state changes.

The helper serializes stage/publish/rollback operations with `deploy.lock`.
Lock contention fails with a stable diagnostic; it never removes a lock file or
terminates a holder.

### 6.2 Installer orchestration

`install.sh` keeps its existing ownership and TUI wiring responsibilities but
delegates runtime generation work to the helper.

The supported paths are:

- default install: stage, validate, wire stable consumer paths, and activate;
- prepare-only: stage and validate without changing `current` or global wiring;
- activate: validate a named prepared release, then switch it live;
- status: read-only bounded release/process diagnostics;
- rollback: validate the predecessor and switch `current` back;
- uninstall: remove only verified installer-owned wiring, preserving releases
  and any process still using them.

The formal rollout runbook uses prepare-only and activate as separate commands.
The default path remains available for a fresh installation, but it uses the same
staging and atomic publication machinery and never rebuilds the live generation.

### 6.3 Stable consumer paths

After the one-time migration, consumers point only through `.jhw-runtime/current`:

- MCP registrations use `current/mcp-server/dist/index.js`;
- `jhw-control` uses `current/mcp-server/dist/control/cli.js`;
- `jhw-control-hook` uses `current/scripts/jhw-control-hook`;
- TUI skills and prompts use `current/skills/...`.

Node resolves the launched entry through the activation links to its physical
generation. The hook launcher already resolves its own symlink before locating
the compiled core. Therefore a process that starts before publication remains
bound to the old physical release, while a later invocation resolves through the
new `current` target.

The first migration may update consumer records one at a time, but every record
always points to a complete validated generation. It never exposes a staging
directory or a partially built tree. Subsequent deployments require only the
single atomic `current` transition.

## 7. Data flow

### 7.1 Prepare

1. Validate the source checkout and release-store parents.
2. Acquire the deployment lock.
3. Create a private same-store staging directory.
4. Copy only the MCP build inputs, skill tree, and hook launcher. Preserve only
   repository-internal relative skill links; reject escaping or special entries.
5. Run `npm ci` and `npm run build` inside staging.
6. Verify executable control/hook cores, MCP entry, package lock, file types,
   ownership, modes, and content digests.
7. Write and fsync the manifest.
8. Rename the completed directory into `releases/<release-id>` and fsync the
   releases parent.
9. Return the bounded release ID and validation state. Do not change `current`.

A failure removes only the invocation's private staging directory. It does not
modify the current release, legacy `dist`, legacy `node_modules`, global links,
or TUI configuration.

### 7.2 Activate

1. Acquire the deployment lock and re-read the exact `current` activation.
2. Validate the requested retained release and all manifest digests.
3. Create and fsync a private activation directory containing the selected
   release links and a manifest that names the observed activation as its
   predecessor.
4. Rename the complete activation into `activations/<activation-id>` and fsync
   the activations parent.
5. Revalidate that `current` still has the exact observation captured in step 1.
6. Build a same-parent temporary symlink to the new activation.
7. Atomically rename that symlink over `current` and fsync the store parent.
8. Re-read and validate the live activation and selected release.
9. Report the previous/new release IDs and bounded active-process counts.

No process signal or Task lifecycle command is issued. An invocation racing the
rename resolves either the old or new complete target.

### 7.3 Rollback

1. Acquire the deployment lock and validate current state.
2. Read the predecessor activation from the current activation's committed
   manifest.
3. Validate that activation and its selected release exactly.
4. Atomically replace `current` with a symlink to the predecessor activation.
5. Re-read the pointer and report bounded release IDs and process counts.

Rollback affects only new invocations. Processes already bound to the failed
generation are reported and require an operator-directed restart if necessary;
the tool never kills them automatically.

## 8. Active-process diagnostics

Linux `/proc` inspection matches only current-user processes whose NUL-delimited
argv identifies the exact legacy or retained MCP/control entry. Output contains
counts grouped by `legacy`, `current`, or a bounded release ID; it never emits a
PID, full argv, absolute path, environment, Task, Claim, or session identifier.

Inspection has strict entry and byte limits. Missing, changing, or unreadable
process records are counted as skipped observations. The result is advisory and
cannot authorize deletion or prove quiescence. Safety comes from immutable
generations and retaining old releases, not from a momentary process count.

## 9. Failure and recovery rules

- Build failure: current and all global wiring remain unchanged.
- Invalid staged release: refuse publication and retain the current release.
- Pointer changed during validation: fail closed; do not retry automatically.
- Lock contention: report one bounded error; do not delete the lock or kill the
  holder.
- Publication read-back mismatch: stop and report current state without guessing
  which release is active.
- Missing or invalid predecessor: refuse rollback.
- Active old processes: retain their releases and report counts.
- First-migration wiring failure: preserve complete release artifacts and use the
  existing configuration/hook transaction evidence; never fall back to an
  in-place build.

## 10. Testing strategy

All installer integration tests use private temporary HOME, runtime, source, and
process-fixture directories. Tests must never point at the live runtime checkout
or the user's actual TUI configuration.

Required regression coverage:

- `npm ci` and build run only in staging;
- build failure leaves live `dist`, `node_modules`, `current`, and wiring intact;
- staged content is unreachable through `current` before activation;
- publication exposes only a complete old or new release;
- a process started through old `current` remains bound to the old physical tree;
- new processes resolve the new tree after activation;
- status output is bounded and does not expose PIDs, argv, or absolute paths;
- rollback selects only the activation-manifest-recorded validated predecessor;
- active releases and legacy artifacts are never automatically deleted;
- concurrent activation and changed-pointer races fail closed;
- foreign links, unsafe filesystem objects, and malformed manifests are preserved
  and rejected;
- existing install ownership, hook transaction, uninstall, and npm-lockfile tests
  continue to pass.

Repository gates remain:

```text
cd mcp-server && npm run build
cd mcp-server && npm run typecheck
cd mcp-server && npm test
bash scripts/test-install-safety.sh
```

No live `install.sh`, activate, rollback, cleanup, process termination, or real
TUI configuration mutation is part of Issue #153 verification.

## 11. Rollout boundary

The implementation branch may be reviewed and merged independently of live
activation. The first live rollout follows this separate sequence:

1. Obtain a new, explicit deployment approval.
2. Run prepare-only and inspect the bounded status output.
3. Reconfirm there is no unrelated maintenance or Phase 1B cutover in progress.
4. Activate the exact prepared release.
5. Verify the host launcher contract, control preflight, MCP startup, release
   pointer read-back, and rollback coordinate from a new session.
6. Leave sessions that started before activation on their old physical release.
7. Restart an old session only when the user separately chooses version
   convergence for that session.

Until step 1 is satisfied, agents must not recommend or perform the live
activation. Approval to implement, test, commit, review, or merge is not
deployment approval.
