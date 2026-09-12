# Active-session-safe jhw-notion deployment design

Date: 2026-09-12
Issue: https://github.com/jhw7500/jhw-notion/issues/153
Status: Implementation and isolated readiness verification complete; final
whole-branch review and post-reboot first live rollout pending

## 1. Decision summary

jhw-notion runtime artifacts will be built as immutable generations and exposed
through one stable `current` symlink. Preparation builds and validates a new
generation without modifying live `dist`, `node_modules`, links, hooks, or TUI
configuration. Activation atomically switches `current` only inside a deliberate
quiescent maintenance window.

Activation and rollback are refused before any shared mutation when a supported
TUI, app server, MCP, control, or hook consumer is active. Managed runtime entry
points share an admission gate with deployment so a new managed consumer cannot
race the final quiescence check. Deployment never kills or restarts a process and
never finishes, releases, or takes over a Task or Claim.

This design deliberately does not support old and new sessions concurrently.
The current work is completed or handed off first, its Claims are normally
released, all consumers are stopped, and only then may an exact prepared release
be activated. The implementation and private-fixture verification are complete;
they did not prepare or activate a live artifact. The first live activation is
part of Issue #153 and remains pending until the planned reboot. It requires a
separate approval for the exact retained release. A server reboot has its own
approval and is neither inferred nor performed by the deployment tool.

## 2. Current problem

Before this implementation, the installer ran `npm ci` and `npm run build`
directly in the checkout's `mcp-server` directory. Global control links, TUI
skill links, MCP registrations, and Guard hook wiring also resolved directly
into that checkout.

This creates three unsafe deployment windows:

1. A running or newly starting process can observe `node_modules` while `npm ci`
   replaces it.
2. A newly starting process can observe `dist` while the build cleans and
   regenerates it.
3. Updating several global links and configuration records can temporarily mix
   old and new entry points.

Read-only inspection recently found many MCP processes using the same runtime
checkout. More importantly, MCP processes are not the only consumers: an already
open TUI session can invoke a new hook or control subprocess after an activation.
A shared `current` pointer therefore cannot guarantee session-level pinning.

The selected policy prioritizes zero impact to existing sessions over continuous
deployment. It waits until current work is finished, establishes a closed
maintenance boundary, verifies quiescence, performs one atomic activation, and
then starts fresh sessions. A momentary zero-process observation alone is racy,
so managed entry points and activation must also coordinate through one admission
gate.

## 3. Goals

- Never run dependency installation or compilation inside the live generation.
- Ensure a new invocation observes either one complete old generation or one
  complete new generation.
- Refuse activation and rollback while any supported existing session or runtime
  consumer is active.
- Prevent new managed runtime consumers from racing the final quiescence check.
- Report bounded active-consumer counts by supported consumer class and retained
  generation.
- Support a validated, atomic rollback to the predecessor generation.
- Keep Task/Claim lifecycle, automation #175, and Phase 1B authority cutover out
  of the deployment path.
- Preserve the installer's existing fail-closed ownership rules for links,
  configuration, hooks, and private transaction artifacts.

## 4. Non-goals

- Hot-reloading an already-running MCP process.
- Per-session release profiles or routing old and new live sessions to different
  generations.
- Activating while an existing supported session remains open, even when its MCP
  child is momentarily idle.
- Automatically terminating processes or restarting TUI sessions.
- Requiring or attempting to prove a host reboot before activation.
- Automatically deleting retained generations.
- Changing Notion credentials or copying `.env` secret bytes into a release.
- Changing the Project Control authority epoch or performing Phase 1B cutover.
- Performing the live deployment during the implementation/readiness checkpoint.

## 5. Runtime layout

The release store remains inside the canonical runtime checkout so existing
repository ownership checks remain meaningful and the ignored `.env` stays in
its current location.

```text
<runtime-checkout>/.jhw-runtime/
|-- deploy.lock
|-- admission.lock
|-- bootstrap/
|   |-- manifest.json
|   |-- jhw-runtime-entry
|   |-- jhw-runtime-control
|   |-- jhw-runtime-hook
|   `-- runtime-*.mjs
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
|-- .bootstrap.previous.<32hex>/...
|-- .deploy.<32hex>/
|   |-- state.json
|   |-- before.json
|   `-- <phase>.<16hex>.log
`-- .stage.<random>/
```

`.jhw-runtime/` is ignored by Git. Its directory, locks, bootstrap, manifests,
releases, and symlinks must be owned by the current user and must not traverse an
unverified symlink. Staging and deployment directories use mode `0700`; private
state, preimage, manifest, and phase-log files use mode `0600`. Stages and private
fixture releases are never valid live execution targets. The bootstrap manifest
pins the entry digest and closed set of supported selectors. Ordinary activation
retains its independently validated `sourceReleaseId`; adopting changed helper
bytes requires the separately gated uninstall then exact retained-release
activation path, and preserves the previous helper directory.

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
- report current release, predecessor availability, pending recovery count, and
  aggregate supported-consumer counts;
- atomically roll `current` back to its validated predecessor.

It returns bounded JSON. It rejects unknown keys, malformed release IDs,
non-regular runtime files, unsafe symlinks, ownership mismatches, unexpected
directory modes, manifest/digest mismatches, and concurrent state changes.

The helper serializes stage/publish/rollback operations with `deploy.lock`.
Activation and rollback additionally require an exclusive lease on
`admission.lock`. Lock contention fails with a stable diagnostic; the helper
never removes a lock file or terminates a holder.

### 6.2 Runtime admission and quiescence gate

A stable bootstrap outside the versioned release resolves managed MCP, control,
and hook entry points. Before resolving `current`, it acquires a shared lease on
`admission.lock` and retains the lease until the child exits. Activation and
rollback acquire the same lock exclusively. Consequently, a running managed
runtime prevents publication, and a managed runtime cannot begin between the
final check and the pointer transition.

The exclusive lease is necessary but not sufficient because a TUI or app server
can be alive while no child runtime is executing. Before taking the lease and
again after taking it, activation inventories an allowlisted set of supported
TUI, app-server, legacy MCP, control, and hook consumers. Any match, skipped
observation, unreadable required process record, or inventory-limit exhaustion
refuses the operation before shared state changes.

The safety claim is limited to supported, installer-managed host entry points.
An arbitrary direct execution of a release file is outside that claim. During a
maintenance window the operator must also prevent anyone from starting a new TUI
or app server. The one-time migration from legacy entry points is a bootstrap
case: because legacy consumers do not yet honor `admission.lock`, it requires the
same all-consumers-stopped maintenance boundary and refuses on any uncertain
inventory result.

The gate has no force mode. It never treats a released Claim, a SessionEnd event,
or a zero MCP-child count as proof that the corresponding TUI has stopped.

### 6.3 Installer orchestration

`install.sh` keeps its existing ownership and TUI wiring responsibilities but
delegates runtime generation work to the helper. Its public dispatcher requires
Linux `/proc`, Bash, executable `/usr/bin/flock`, and Node.js 22 or newer before
loading the deployment ESM.

The supported paths are:

- prepare-only: stage and validate without changing `current` or global wiring;
- activate: under the quiescence gate, validate an exact prepared release and
  switch it live;
- status: read-only bounded release and consumer diagnostics;
- rollback: under the same quiescence gate, validate the predecessor and switch
  `current` back;
- fresh install: only when no prior installation or consumer exists, run the
  same staged build and quiescence-gated activation path;
- uninstall: remove only verified installer-owned wiring, preserving releases
  and refusing while a supported consumer is active.

The formal rollout runbook uses prepare-only and activate as separate commands.
An existing installation never turns a default install invocation into an
implicit activation. It returns a bounded instruction to prepare and activate in
separate, explicitly approved steps.

### 6.4 Stable consumer paths

After the one-time migration, executable consumers enter through the stable
bootstrap, which selects an entry below `.jhw-runtime/current` only after taking
its admission lease:

- MCP registrations execute `bootstrap/jhw-runtime-entry mcp`;
- `jhw-control` executes the bootstrap's closed `control` selector;
- `jhw-control-hook` executes the bootstrap's closed `hook` selector;
- TUI skills and prompts use `current/skills/...`.

The stable bootstrap acquires its shared admission lease before resolving these
paths. This prevents a running managed child from crossing an activation, but it
does not claim that an open TUI session is pinned to a generation. The separate
TUI/app-server quiescence check is therefore mandatory.

The first migration may update consumer records one at a time only after the
quiescence gate passes. Every record points through the validated bootstrap or
`current/skills`; it never exposes a staging directory or partially built tree.
A durable deployment marker and bounded exact known-wiring preimages exist
before the first mutation worker. EOF, timeout, or failed validation never
claims automatic restoration. Configuration/hook transaction evidence and all
legacy artifacts are retained for inspection.

Subsequent compatible deployments require only the single atomic `current`
transition and do not rewrite TUI configuration. A candidate whose individually
installed Codex skill/prompt name set differs is refused before publication with
`DEPLOY_WIRING_TOPOLOGY_CHANGED` / `guarded_uninstall_reinstall_required`.
Whole-directory adapters continue to follow `current/skills`. Bootstrap helper
or Codex topology changes require guarded uninstall followed by activation of
the exact desired retained release; both commands independently pass the same
maintenance gate.

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

A failure removes only an unchanged, still-trusted invocation stage. A stage
whose identity or trust became uncertain is retained for explicit inspection.
Neither path modifies the current release, legacy `dist`, legacy `node_modules`,
global links, or TUI configuration.

### 7.2 Activate

1. Require the separately approved maintenance-window invocation and run an
   initial bounded supported-consumer inventory before shared mutation.
2. Create or validate the private runtime store, acquire `deploy.lock` and
   exclusive `admission.lock`, then repeat the complete inventory. Refuse on any
   consumer, uncertainty, or contention without forcing or signaling a holder.
3. Validate current/pending state and the exact requested retained release.
   Create and fsync `.deploy.<32hex>/state.json` before any mutation worker.
4. Snapshot whether wiring was successfully installed before this operation,
   independently of the mutable worker-mode flag and retained activation history.
   For managed wiring, verify existing wiring and candidate Codex topology
   before pointer publication. For initial/refresh wiring, record bounded exact
   known-path preimages in private `before.json` before the first mutation.
5. Publish the immutable activation and `current` pointer. First migration also
   installs the stable bootstrap and invokes a fresh wiring worker that inherits
   the actual deploy and exclusive-admission file descriptions.
6. Close exclusive admission while retaining deployment serialization. Invoke a
   fresh validation worker with only the deploy descriptor: exact host contract
   v5, Guard preflight, then a managed MCP initialize/initialized/tools-list
   exchange through normal shared admission.
7. Reacquire exclusive admission and repeat the supported-consumer inventory.
   Failure records `recovery_blocked` and returns `DEPLOY_RECOVERY_REQUIRED` /
   `maintenance_reacquisition_failed`; it never restores automatically.
8. If validation failed, retain the selected pointer and all private evidence.
   With `DEPLOY_VALIDATION_FAILED`, return `validated_rollback_required` only
   for a managed pointer update that began with successfully installed wiring
   and a predecessor, with pending operation `activate`. Initial wiring without
   a predecessor returns `first_migration_recovery_required`; failed reinstallation
   after guarded uninstall returns `wiring_refresh_recovery_required` even with a retained
   predecessor. Both wiring failures require manual operator review of wiring,
   helpers and hook transactions while maintaining the maintenance window.
9. Re-read the exact pointer. A fresh finalization worker inherits the deploy and
   newly acquired exclusive-admission descriptors. Only successful finalization
   records `installed:true`, marks the journal complete and reports the
   previous/new release IDs. Never mark unfinished wiring installed to admit
   recovery.

No process signal or Task lifecycle command is issued. Managed entry points fail
immediately with a stable bounded maintenance diagnostic while the exclusive
admission lease is held; they never race the pointer transition. A mutation
worker retains inherited leases after driver EOF or timeout until that worker
exits; the driver does not signal it or claim restoration.

### 7.3 Rollback

1. Pass the same pre-lock and post-lock quiescence checks used by activation.
2. Acquire the same deployment and exclusive admission leases and validate
   current state.
3. Read the predecessor activation from the current activation's committed
   manifest.
4. Validate that activation and its selected release exactly, including Codex
   individual-link topology compatibility.
5. Atomically replace `current` with a symlink to the predecessor activation.
6. Run the same validation, exclusive-admission reacquisition, final inventory,
   pointer read-back, and fresh finalization phases as activation.

Rollback is not attempted after sessions have reopened. If verification of a
managed pointer update that retained successfully installed wiring fails,
consumers remain stopped and the operator invokes the validated rollback while
the maintenance boundary is still held. The first migration has no managed
predecessor: `--rollback` returns
`DEPLOY_PREDECESSOR_INVALID` and never restores a legacy checkout or wiring.
After guarded uninstall, a failed reinstall can retain a predecessor while
`installed:false` still prevents rollback: `--rollback` returns
`DEPLOY_RECOVERY_REQUIRED` without changing the pointer or retained evidence.
`predecessorAvailable` reports history, not recovery eligibility. Keep maintenance
and all private evidence for manual operator review; do not delete journals or
force `installed:true`. If validation of rollback itself fails, return
`DEPLOY_VALIDATION_FAILED` / `rollback_recovery_required` and retain the selected
pointer and pending evidence for manual operator review with consumers stopped.
A further `--rollback` returns `DEPLOY_RECOVERY_REQUIRED`; pending rollback
operations are not admitted as failed-activation recovery.
Incompatible rollback topology is refused before publication and uses the
separately gated uninstall/activate route only after operator approval. The tool
never kills or restarts consumers automatically.

## 8. Active-process diagnostics

Linux `/proc` inspection matches only current-user processes using an allowlist
of supported TUI, Codex app-server, legacy runtime, bootstrap, and retained
runtime identities. Inventory output has only the aggregate `tui`, `app_server`,
`legacy`, and `managed` counts plus `clear` and `uncertain`; status reports the
selected bounded release ID separately. It never emits a PID, full argv,
absolute path, environment, Task, Claim, or session identifier.

Inspection has strict entry and byte limits. Missing, changing, or unreadable
required process records, skipped observations, or limit exhaustion make the
activation gate fail closed. Read-only `status` remains advisory. The activation
safety boundary is the combination of the exclusive admission lease, two
all-clear inventories, a no-new-TUI operational maintenance window, immutable
generations, and atomic publication; a momentary process count alone is never
described as proof.

## 9. Failure and recovery rules

- Build failure: current and all global wiring remain unchanged.
- Invalid staged release: refuse publication and retain the current release.
- Active or uncertain consumer inventory: refuse before shared mutation with a
  stable bounded code. Advisory `--status` separately exposes only aggregate
  consumer classes and counts.
- Admission contention: refuse without waiting indefinitely, deleting the lock,
  or signaling its holder.
- Pointer changed during validation: fail closed; do not retry automatically.
- Lock contention: report one bounded error; do not delete the lock or kill the
  holder.
- Publication read-back mismatch: stop and report current state without guessing
  which release is active.
- Missing or invalid predecessor: refuse rollback.
- Codex individual skill/prompt topology mismatch: refuse before pointer
  publication with `guarded_uninstall_reinstall_required`; keep current and HOME
  unchanged and leave no pending recovery journal.
- Managed activation validation failure with previously installed wiring: retain
  the selected pointer and evidence; return `validated_rollback_required`.
  Explicit `--rollback` is available only when the pending operation is
  `activate`, wiring remains installed, and the durable current observation and
  committed predecessor match exactly.
- Reinstallation validation failure after guarded uninstall: return
  `DEPLOY_VALIDATION_FAILED` / `wiring_refresh_recovery_required`; a retained
  predecessor does not make unfinished wiring eligible for rollback. Keep
  maintenance and evidence for manual review.
- Rollback validation failure: return `DEPLOY_VALIDATION_FAILED` /
  `rollback_recovery_required`; keep maintenance and evidence for manual review.
  Another `--rollback` refuses with `DEPLOY_RECOVERY_REQUIRED`.
- First-migration wiring failure: return `DEPLOY_WIRING_FAILED` and preserve
  complete releases, exact known-wiring preimages, and configuration/hook
  transaction evidence. First-migration validation failure returns
  `DEPLOY_VALIDATION_FAILED` / `first_migration_recovery_required`. Neither has
  a managed predecessor, legacy rollback, or automatic restore command.
- Exclusive-admission reacquisition or final inventory failure: record
  `recovery_blocked` and `maintenance_reacquisition_failed`; keep maintenance
  open for private evidence review.
- Worker EOF, timeout, or driver exit: never signal the worker. A surviving
  mutation descendant retains inherited deploy/admission file descriptions until
  it exits. Pending state and phase logs remain; no automatic restore occurs.

## 10. Testing strategy

All installer integration tests use private temporary HOME, runtime, source, and
process-fixture directories. Tests must never point at the live runtime checkout
or the user's actual TUI configuration.

Required regression coverage:

- `npm ci` and build run only in staging;
- build failure leaves live `dist`, `node_modules`, `current`, and wiring intact;
- staged content is unreachable through `current` before activation;
- publication exposes only a complete old or new release;
- every managed runtime bootstrap holds a shared admission lease for its child's
  lifetime;
- a shared admission holder prevents activation and leaves `current` and wiring
  unchanged;
- active TUI, app-server, legacy runtime, MCP, control, and hook fixtures each
  refuse activation before shared mutation;
- skipped, unreadable, changing, or over-limit process observations refuse
  activation;
- a managed consumer racing an exclusive activation lease cannot resolve or
  execute across the pointer transition;
- status and refusal output is bounded and does not expose PIDs, argv, absolute
  paths, Task coordinates, or Claim coordinates;
- rollback selects only the activation-manifest-recorded validated predecessor;
- rollback enforces the same quiescence and admission gate as activation;
- active releases and legacy artifacts are never automatically deleted;
- concurrent activation and changed-pointer races fail closed;
- foreign links, unsafe filesystem objects, and malformed manifests are preserved
  and rejected;
- existing install ownership, hook transaction, uninstall, and npm-lockfile tests
  continue to pass.

Repository gates remain:

```text
node --test scripts/test-runtime-safety.mjs scripts/test-runtime-store.mjs scripts/test-runtime-entry.mjs scripts/test-runtime-deploy.mjs
npm run build --prefix mcp-server
npm run typecheck --prefix mcp-server
npm test --prefix mcp-server
bash scripts/test-install-safety.sh
```

The implementation checkpoint completed these gates and a normal staged npm
build, managed hooks, and SDK MCP startup in private source/HOME fixtures. Those
fixture artifacts are not live prepared releases. The final whole-branch review
remains a separate readiness gate. No live `install.sh`, activation, rollback,
cleanup, process termination, reboot, or real HOME mutation occurred during the
implementation checkpoint; the later first live deployment remains part of
Issue #153.

## 11. Rollout boundary

The implementation branch may be reviewed and integrated independently of live
activation. The first live rollout is postponed until the planned reboot and
follows this separate sequence:

1. Finish the whole-branch review and place the approved revision in the
   dedicated canonical trusted runtime checkout. Do not normalize an arbitrary
   live tree merely to pass ownership or mode checks.
2. Before reboot, use an ordinary host shell to run `./install.sh --prepare` and
   `./install.sh --status`. Record the exact returned release ID; preparation
   changes neither HOME wiring nor the live pointer.
3. Complete or durably hand off current work and normally release active Claims.
   Claim release and SessionEnd are coordination evidence, not deployment
   authority or proof that a TUI stopped.
4. Obtain separate reboot approval and perform the planned reboot. An Issue
   reminder does not reboot or deploy automatically.
5. After reboot, use an ordinary SSH shell. Do not start Claude, Codex, Gemini,
   OpenCode, or a Codex app server to drive activation. Prevent new starts,
   inspect auto-started consumers with bounded status, and keep the maintenance
   window closed.
6. Obtain explicit approval for `./install.sh --activate <exact-release-id>` and
   run that exact command in the canonical runtime checkout. Both inventories
   and exclusive admission must pass or the command refuses.
7. Before opening a TUI, verify status pointer read-back, exact host contract v5,
   and `jhw-control guard preflight` from the SSH shell. `DEPLOY_ACTIVATED` already
   requires the normal managed MCP initialize/initialized/tools-list exchange.
   `unprotected: true` and Guard `NO-GO` are not protection success.
8. If a later managed activation fails validation, retain the maintenance window
   and invoke only its validated predecessor rollback. First migration has no
   managed predecessor; retain private evidence and escalate for operator review
   instead of claiming legacy restoration.
9. Start fresh working sessions only after activation or validated rollback and
   all required verification succeed. Keep Issue #153 open until this first live
   deployment evidence is recorded.

Until step 6 is separately approved, agents must not perform live activation.
Approval to implement, test, commit, review, integrate, prepare, reboot, stop a
process, uninstall, or roll back does not imply approval for another action.
