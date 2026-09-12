# Active-session-safe jhw-notion deployment design

Date: 2026-09-12
Issue: https://github.com/jhw7500/jhw-notion/issues/153
Status: Design direction approved; written revision pending review;
implementation and live rollout deferred

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
be activated. The first implementation and the first live activation are both
deferred. Live activation requires a separate deployment approval even after
implementation is reviewed and merged. A server reboot is optional after all
work has stopped; it is neither inferred nor performed by the deployment tool.

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
- Deploying the implementation produced by Issue #153.

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
|   `-- jhw-runtime-entry
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

`.jhw-runtime/` is ignored by Git. Its directory, locks, bootstrap, manifests,
releases, and symlinks must be owned by the current user and must not traverse an
unverified symlink. Staging directories use mode `0700` and are never valid
execution targets. The bootstrap manifest pins the entry digest and closed set
of supported selectors; bootstrap replacement is allowed only under the same
quiescent maintenance gate as first migration.

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
delegates runtime generation work to the helper.

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
quiescence gate passes. Every record points to a complete validated generation;
it never exposes a staging directory or a partially built tree. Existing
configuration/hook transaction evidence restores prior wiring if migration
fails. Subsequent deployments require only the single atomic `current`
transition and do not rewrite TUI configuration.

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

1. Require the separately approved maintenance-window invocation and run an
   initial bounded supported-consumer inventory.
2. Refuse immediately if any supported consumer exists or any required
   observation is uncertain. Do not create a maintenance marker or change shared
   state.
3. Acquire `deploy.lock`, then acquire `admission.lock` exclusively without
   forcing or terminating a shared holder.
4. Repeat the complete supported-consumer inventory while holding both locks.
   Refuse and release both locks on any match or uncertainty.
5. Re-read the exact `current` activation and validate the requested retained
   release and all manifest digests.
6. Create and fsync a private activation directory containing the selected
   release links and a manifest that names the observed activation as its
   predecessor.
7. Rename the complete activation into `activations/<activation-id>` and fsync
   the activations parent.
8. Revalidate that `current` still has the exact observation captured in step 5.
9. Build a same-parent temporary symlink to the new activation.
10. Atomically rename that symlink over `current` and fsync the store parent.
11. Re-read and validate the live activation and selected release.
12. Report the previous/new release IDs and the all-zero gated inventory, then
    release both locks.

No process signal or Task lifecycle command is issued. Managed entry points fail
immediately with a stable bounded maintenance diagnostic while the exclusive
admission lease is held; they never race the pointer transition.

### 7.3 Rollback

1. Pass the same pre-lock and post-lock quiescence checks used by activation.
2. Acquire the same deployment and exclusive admission leases and validate
   current state.
3. Read the predecessor activation from the current activation's committed
   manifest.
4. Validate that activation and its selected release exactly.
5. Atomically replace `current` with a symlink to the predecessor activation.
6. Re-read the pointer, report bounded release IDs and the all-zero gated
   inventory, and release both locks.

Rollback is not attempted after sessions have reopened. If verification of the
new release fails, consumers remain stopped and the operator separately approves
or invokes the validated rollback while the maintenance boundary is still held.
The tool never kills or restarts them automatically.

## 8. Active-process diagnostics

Linux `/proc` inspection matches only current-user processes using an allowlist
of supported TUI, app-server, legacy runtime, bootstrap, and retained runtime
identities. Runtime output is grouped by `legacy`, `current`, or a bounded
release ID; TUI and app-server output is grouped by bounded consumer class. It
never emits a PID, full argv, absolute path, environment, Task, Claim, or session
identifier.

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
- Active or uncertain consumer inventory: refuse before shared mutation and
  return a stable bounded diagnostic naming only consumer classes and counts.
- Admission contention: refuse without waiting indefinitely, deleting the lock,
  or signaling its holder.
- Pointer changed during validation: fail closed; do not retry automatically.
- Lock contention: report one bounded error; do not delete the lock or kill the
  holder.
- Publication read-back mismatch: stop and report current state without guessing
  which release is active.
- Missing or invalid predecessor: refuse rollback.
- First-migration wiring failure: preserve complete release artifacts and use the
  existing configuration/hook transaction evidence; never fall back to an
  in-place build.
- Crash while holding a file lease: the operating system releases the lease;
  the next status validates pointer, activation, and transaction evidence before
  any recovery action.

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
cd mcp-server && npm run build
cd mcp-server && npm run typecheck
cd mcp-server && npm test
bash scripts/test-install-safety.sh
```

No live `install.sh`, activate, rollback, cleanup, process termination, server
reboot, or real TUI configuration mutation is part of Issue #153 verification.

## 11. Rollout boundary

The implementation branch may be reviewed and merged independently of live
activation. The first live rollout is deliberately postponed until all current
project work can stop. It follows this separate sequence:

1. Complete or durably hand off current work and normally release its active
   Claims. Claim release is coordination evidence, not deployment authority.
2. Stop every supported TUI and app server that consumes jhw-notion. Do not have
   the deployment tool terminate them.
3. Optionally reboot the server if the operator wants the strongest practical
   cleanup of leftover processes. A reboot requires its own explicit approval
   and is not required by the tool.
4. Obtain a new, explicit approval for the exact deployment run.
5. Prepare and validate the exact release in the private store; inspect bounded
   status without changing live wiring.
6. Reconfirm that no unrelated maintenance, automation #175 work, or Phase 1B
   cutover is in progress, and prevent new TUI/app-server starts for the window.
7. Activate the exact prepared release. The command must acquire the exclusive
   admission lease and pass both all-clear consumer inventories or refuse without
   shared mutation.
8. Before reopening normal work, verify the host launcher contract, control
   preflight, MCP startup, release pointer read-back, and rollback coordinate
   from one fresh validation session.
9. If verification fails, close that validation session and perform only the
   validated predecessor rollback under the same maintenance gate.
10. Start fresh working sessions only after activation or rollback verification
    succeeds and the maintenance window is closed.

Until step 4 is satisfied, agents must not perform live activation. Approval to
implement, test, commit, review, merge, prepare, reboot, or stop a process is not
deployment approval, and none of those approvals implies another.
