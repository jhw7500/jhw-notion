# Task Scope Guard 6: Board, Remote, Firmware, and Production Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind board/SSH/F/W execution to the active Task's exact board resource, retain the independent Board holder/reservation authority, and prove with the WLAN scenario that the local-hardening session cannot take over target-matrix work.

**Architecture:** Extend `board with` into the board execution boundary, derive board/remote/firmware requirements from the exact child argv and registered board interfaces, consume any permit before Board acquisition, and then run the existing holder/liveness/signal lifecycle unchanged. Finish with adversarial E2E, installation, and production-readiness gates.

**Tech Stack:** TypeScript 5.5 ESM, existing BoardService/MutationLock/liveness probes, Node.js child processes, Git/Registry fixtures, Vitest fake time/concurrency, Bash smoke tests

**Spec:** `docs/superpowers/specs/2026-08-25-task-scope-guard-design.md`

## Global Constraints

- This is plan 6 of 6 and depends on plans 1–5.
- Board Work Contract assignment and Board holder/reservation state remain separate authorities. Both must allow execution.
- `board with` requires exact Task, Claim, session, origin adapter, board ID, and current worktree.
- Always require `board.execute` on the exact board resource.
- Require `remote.execute` on that same board resource for SSH/SCP/remote commands.
- Require `firmware.change` on that same board resource for flash, reset, reboot, module/driver replacement, target network configuration mutation, and other recognized target-state changes.
- Registered Board interface address is connection metadata, not resource identity. The resource ID remains the canonical board ID, but remote target/address must match registered metadata.
- Unknown board child commands retain `shell.unclassified` and exact digest requirements; known remote/firmware markers are additive and can never be downgraded.
- Another active Task's exclusive board contract is hard DENY with no unlock request.
- A Board holder/reservation conflict remains hard failure even after a permit is consumed.
- Consume before Board acquire/spawn. Board contention or spawn failure does not restore the permit.
- A consumed permit does not expire during a long matrix run. Board lease/command timeout remains the runtime limit.
- Preserve the approved Board SIGKILL/OOM limitation: wrapper death can leave a child alive while holder liveness is later reaped. Do not claim process-group isolation fixes it.
- Direct standalone remote-host, firmware-target, and deployment-target authority remains unsupported. Do not invent canonical IDs from IPs, hostnames, device paths, or deployment names.
- `deploy.execute` remains fail-closed/unsupported at final acceptance until a separate registered deployment authority is designed.
- No production board command is executed by automated tests; use fakes/local child processes and an operator-controlled smoke command.

---

### Task 1: Normalize board-scoped child operations against registered interfaces

**Files:**
- Create: `mcp-server/src/control/board-operation.ts`
- Create: `mcp-server/src/control/__tests__/board-operation.test.ts`
- Modify: `mcp-server/src/control/shell-classifier.ts`
- Modify: `mcp-server/src/control/operation-normalizer.ts`
- Modify: `mcp-server/src/control/board-service.ts`
- Modify: `mcp-server/src/control/__tests__/board-service.test.ts`

**Interfaces:**
- Produces: `normalizeBoardOperation(input, claim, board): ResolvedBoardOperation`.
- Produces: `BoardService.executionMetadata(boardId)` with canonical ID and bounded interfaces only.
- Produces requirements bound to `{ kind: "board", id: boardId }`.

- [ ] **Step 1: Write failing board classifier tests**

Test exact examples:

- `ssh root@192.0.2.40 ethtool -i wlan0` → `board.execute + remote.execute`;
- `ssh root@192.0.2.40 iw dev wlan0 set power_save off` → add `firmware.change`;
- `ssh root@192.0.2.40 wpa_cli status` → remote only;
- `ssh root@192.0.2.40 wpa_cli set_network 0 psk value` → add firmware/state-change capability while excluding the value from persisted output;
- `ssh ... antcfg ...`, `flashcp`, `mtd`, `sysupgrade`, `fw_setenv`, `modprobe`, driver replacement, reboot/reset → add `firmware.change`;
- host/port not matching a registered ethernet/wireless interface → `GUARD_BOARD_TARGET_MISMATCH`;
- a serial command must reference the exact registered serial address in a recognized argument position;
- a quote/control/pipeline/remote shell ambiguity adds `shell.unclassified` but retains remote/firmware requirements found by the high-risk scan;
- raw command, PSK, firmware bytes/path, and address do not appear in the persisted summary/journal;
- changing remote address, command, script content, or board ID changes the digest.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/board-operation.test.ts \
  src/control/__tests__/board-service.test.ts \
  src/control/__tests__/shell-classifier.test.ts \
  src/control/__tests__/operation-normalizer.test.ts
```

- [ ] **Step 3: Expose bounded read-only execution metadata**

`executionMetadata` returns:

```ts
interface BoardExecutionMetadata {
  board_id: string;
  interfaces: Array<{
    type: "ethernet" | "wireless" | "serial";
    address: string;
  }>;
}
```

It reads the existing board state without mutation and never returns holders, reservations, purpose text, credentials, or a new Task linkage field. Missing/corrupt board state is a hard authority failure.

- [ ] **Step 4: Implement additive board requirement classification**

Start every operation with:

```ts
{
  capability: "board.execute",
  resource: { kind: "board", id: boardId },
}
```

Add remote/firmware requirements based on the conservative classifier. For ambiguous child argv, add `shell.unclassified` bound to the current repository as well as every detected board requirement. Sort/deduplicate before digesting.

- [ ] **Step 5: Verify and commit board normalization**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/board-operation.test.ts \
  src/control/__tests__/board-service.test.ts \
  src/control/__tests__/shell-classifier.test.ts \
  src/control/__tests__/operation-normalizer.test.ts
npm run typecheck
```

```bash
git add mcp-server/src/control/board-operation.ts \
        mcp-server/src/control/board-service.ts \
        mcp-server/src/control/shell-classifier.ts \
        mcp-server/src/control/operation-normalizer.ts \
        mcp-server/src/control/__tests__
git commit -m "feat(guard): normalize board execution scope"
```

---

### Task 2: Recheck and consume Guard authority in `board with`

**Files:**
- Modify: `mcp-server/src/control/cli.ts`
- Modify: `mcp-server/src/control/guard-service.ts`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts`
- Modify: `mcp-server/src/control/__tests__/guard-execution.test.ts`
- Create: `mcp-server/src/control/__tests__/board-with.test.ts`

**Interfaces:**
- Changes `board with` to require `--task`, `--claim`, `--session`, and `--origin-adapter`.
- Uses `GuardService.beginExecution(... boundary: "board")`.
- Keeps existing BoardService holder schema and acquire/release semantics unchanged.

- [ ] **Step 1: Write failing board-wrapper order tests**

Pin call order and outcomes:

1. parse/resolve child operation;
2. begin Guard execution and consume permit if needed;
3. capture wrapper liveness;
4. acquire Board holder;
5. spawn child;
6. forward/wait signals;
7. release holder;
8. finish Guard receipt.

Test:

- missing Task/Claim/origin flags fails before Guard/Board mutation;
- Claim/session/worktree mismatch does not acquire;
- other Task exclusive contract returns hard DENY and no request;
- missing grant with no exclusive owner returns exact approval command and does not acquire;
- exact approved retry consumes before acquire;
- Board busy/reserved after consume does not restore permit;
- child spawn failure releases holder, marks Guard FAILED, and does not restore permit;
- child exit preserves status, releases holder, and marks receipt;
- a simulated 30-minute child is not stopped by permit TTL;
- Board lease timeout remains independent;
- nested/reentry holder behavior retains current BoardService rules.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/board-with.test.ts \
  src/control/__tests__/guard-execution.test.ts \
  src/control/__tests__/cli.test.ts
```

- [ ] **Step 3: Extend the special wrapper parser**

Required syntax:

```bash
jhw-control board with \
  --board wlan-target-board \
  --mode exclusive \
  --task tsk-... \
  --claim clm-... \
  --session codex-target-matrix \
  --origin-adapter codex \
  --purpose "wlan target matrix" \
  -- ssh root@192.0.2.40 ethtool -i wlan0
```

Do not accept caller-supplied cwd, worktree ref, capability, resource, digest, or permit ID. Derive all from current process, Registry, board ID, and child argv.

- [ ] **Step 4: Begin Guard before Board acquisition**

Call `beginExecution` with resolved board operation. If result is PERMIT_REQUIRED/DENY, emit its bounded normal decision and do not acquire. On receipt:

- acquire through existing BoardService;
- include no Task/Claim fields in Board state;
- keep `purpose` display-only;
- never treat an existing holder as Work Contract authority.

- [ ] **Step 5: Preserve release and fatal-signal boundaries**

Maintain existing child stdio, exit-code, SIGINT/SIGTERM forwarding, liveness trio, lease, release, adoption, and SIGKILL/OOM documentation. Guard completion is best effort after Board release; a receipt left CONSUMED by wrapper death cannot be reused.

- [ ] **Step 6: Verify and commit board execution enforcement**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/board-with.test.ts \
  src/control/__tests__/guard-execution.test.ts \
  src/control/__tests__/cli.test.ts
npm run build
npm run typecheck
npm test
```

```bash
git add mcp-server/src/control/cli.ts \
        mcp-server/src/control/guard-service.ts \
        mcp-server/src/control/__tests__
git commit -m "feat(guard): recheck board wrapper execution"
```

---

### Task 3: Close alternate Board-use paths without breaking recovery

**Files:**
- Modify: `mcp-server/src/control/cli.ts`
- Modify: `mcp-server/src/control/__tests__/board-cli.test.ts`
- Modify: `skills/claude/board.md`
- Modify: `skills/claude/task.md`
- Regenerate: `skills/codex/jhw-board/SKILL.md`
- Regenerate: `skills/codex/jhw-task/SKILL.md`

**Interfaces:**
- Requires Task/Claim/origin binding for direct `board acquire`, `adopt`, and `extend`.
- Keeps `board release`, status/list, reservation cleanup, and corrupt-state recovery available under their existing ownership/recovery rules.
- States that holder possession never authorizes raw SSH/F/W commands.

- [ ] **Step 1: Write failing alternate-path tests**

Assert:

- direct acquire/adopt/extend without active Task binding fails before Board mutation;
- direct acquire requires `board.execute` and consumes a one-use permit at acquisition start;
- a later remote/F/W command still requires its own matching contract/permit and controlled wrapper;
- release by the recorded session remains available for cleanup even after Claim finish;
- cross-session release/adoption retains existing explicit flags and liveness gates;
- reserve/cancel/register/update/unregister/recover remain Board administration and do not grant target execution;
- raw SSH after manual holder acquire is still blocked by the hook classifier;
- no Board `purpose` string is parsed as Task ID or capability.

- [ ] **Step 2: Route direct holder-start operations through Guard**

Use the same board operation with no child argv for acquire/adopt/extend, requiring `board.execute`. Consume before state mutation. Do not require Guard to release a holder, because fail-closed release would strand physical occupancy; existing session/holder checks remain the release authority.

- [ ] **Step 3: Update board and task operator docs**

Document:

- `board with` is the production execution entry point;
- exact Task/Claim/origin flags;
- direct holder commands do not authorize child operations;
- Board Claim conflicts cannot be unlocked;
- permit expiry is start-only;
- Board lease is runtime;
- known SIGKILL/OOM child-survival boundary remains unchanged;
- deploy and standalone remote targets remain unsupported.

- [ ] **Step 4: Sync generated skills and verify**

```bash
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
cd mcp-server
npx vitest run src/control/__tests__/board-cli.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit alternate-path closure**

```bash
git add mcp-server/src/control/cli.ts \
        mcp-server/src/control/__tests__/board-cli.test.ts \
        skills/claude/board.md \
        skills/claude/task.md \
        skills/codex/jhw-board \
        skills/codex/jhw-task
git commit -m "feat(board): bind holder starts to task scope"
```

---

### Task 4: Prove the WLAN isolation scenario and production rollout gates

**Files:**
- Create: `mcp-server/src/control/__tests__/task-scope-wlan.e2e.test.ts`
- Create: `scripts/test-task-scope-guard.sh`
- Modify: `scripts/test-hook-preflight.sh`
- Modify: `README.md`
- Modify: `DESIGN.md`
- Modify: `docs/project-control/phase1a-runbook.md`
- Modify: `skills/claude/board.md`
- Modify: `skills/claude/task.md`
- Regenerate: affected `skills/codex/jhw-*/SKILL.md`

**Interfaces:**
- Changes preflight board/remote/firmware execution rechecks to `ok`.
- Keeps deployment authority `unsupported`.
- Establishes final acceptance evidence for the user's original scope-drift incident.

- [ ] **Step 1: Build the exact same-repository Task fixture**

Create one formal parent and two children:

```text
parent: wlan-package Issue / integration
├── local-hardening
│   ├── repo.modify(repository repo-wlan-package, shared)
│   ├── git.commit(repository repo-wlan-package, shared)
│   ├── test.host(repository repo-wlan-package, shared)
│   └── observes target-matrix
└── target-matrix
    ├── repo.inspect(repository repo-wlan-package, shared)
    ├── board.execute(board wlan-target-board, exclusive)
    ├── remote.execute(board wlan-target-board, exclusive)
    └── firmware.change(board wlan-target-board, exclusive)
```

Claim both children in distinct sessions/worktrees. The shared repository grants must coexist; target-matrix alone owns the exclusive board assignment.

- [ ] **Step 2: Encode adversarial incident regressions**

Prove:

1. local-hardening can inspect dependency status but receives no dependency grant.
2. “다음”, “진행”, “ok”, and prose mentioning driver/F/W tests create no approval.
3. local-hardening attempting board/SSH/F/W work receives hard `GUARD_RESOURCE_OWNED`, not an unlock request.
4. target-matrix can begin the board wrapper, acquire the holder, and run a fake child.
5. local-hardening cannot use target-matrix's Claim, worktree, holder, or permit.
6. after target-matrix finishes/releases, a conflict-free one-off board attempt becomes PERMIT_REQUIRED.
7. exact unlock allows one exact fake board operation; a second command/retry needs a new request.
8. an active Board reservation still blocks the approved operation and consumes the permit.
9. a long fake matrix run crosses 10 minutes without permit interruption.
10. audit/state contain no prompt, raw command, interface address, credential, firmware path/content, or private worktree path.

- [ ] **Step 3: Add full smoke script with no production target mutation**

`scripts/test-task-scope-guard.sh` runs:

- build/typecheck/unit suite;
- contract and Claim fixture setup;
- Claude/Codex native hook fixtures;
- exact prompt approval;
- guarded publish fake remote;
- Notion mock execution boundary;
- tracker fake API boundary;
- Board fake child/liveness/reservation boundary;
- install/uninstall ownership tests;
- skill sync drift check.

It must use temporary Registry/state/worktree/HOME roots and local fake processes only.

- [ ] **Step 4: Run manual operator-controlled board smoke**

After automated gates pass, use a harmless read-only command chosen for the registered target, for example `ethtool -i` or `uname -a`, through the exact target-matrix Task/Claim and `board with`. Do not flash, reboot, change driver/F/W, alter `iw`/`wpa`/`antcfg`, or deploy during this smoke.

Record:

- Guard decision/receipt IDs;
- Task/Claim/board coordinates;
- Board acquire/release;
- child exit code;
- absence of secrets/raw command in Guard journal;
- holder cleanup.

- [ ] **Step 5: Update truthful final preflight and runbook**

Final coverage:

- Claude/Codex prompt/pre/post: `ok`;
- publish/Notion/tracker/board/remote/firmware execution recheck: `ok`;
- Gemini/OpenCode native adapter: `unsupported`;
- standalone remote/firmware resource authority: `unsupported`;
- deploy execution authority: `unsupported`;
- runtime mode: `enforce`.

Do not label the whole system “all TUI protected” while unsupported cells remain.

- [ ] **Step 6: Run every required gate**

```bash
cd mcp-server
npm run build
npm run typecheck
npm test
cd ..
bash scripts/test-install-safety.sh
bash scripts/test-hook-preflight.sh
bash scripts/test-guarded-publish.sh
bash scripts/test-task-scope-guard.sh
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
git diff --check
```

Run claude-config tests too:

```bash
cd /home/jhw/ai/opencode/projects/claude-config
pytest -q
```

- [ ] **Step 7: Perform real uninstall/reinstall and preflight**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion
./install.sh --uninstall
./install.sh
jhw-control guard preflight
```

Expected: owned entries round-trip; foreign hooks remain; Claude/Codex and execution boundaries report exact coverage; unsupported adapters/authorities stay explicit.

- [ ] **Step 8: Commit final acceptance artifacts**

```bash
git add mcp-server/src/control/__tests__/task-scope-wlan.e2e.test.ts \
        scripts/test-task-scope-guard.sh \
        scripts/test-hook-preflight.sh \
        README.md \
        DESIGN.md \
        docs/project-control/phase1a-runbook.md \
        skills/claude \
        skills/codex
git commit -m "test(guard): prove WLAN task isolation"
```

---

## Final series completion gate

The six-plan implementation is complete only when all are true:

1. Work Contracts are closed, authority-resolved, Claim-snapshotted, and immutable during a Claim.
2. Same-repository Tasks run in distinct Claims/worktrees and one session cannot own two Tasks.
3. Parent/child source identity, non-inheritance, lifecycle, completion evidence, and Issue close gates hold.
4. Only exact native prompt unlock creates an approval; both 10-minute windows and one-use consume are proven.
5. Claim/worktree/exclusive-resource/Board/destructive/state failures cannot be unlocked.
6. Claude/Codex hooks fail closed and preserve foreign configuration.
7. Publish, Notion, tracker, board, remote, and firmware boundaries recheck actual execution.
8. The local-hardening WLAN session cannot assume target-matrix work while its exclusive Claim is active.
9. Build, typecheck, tests, installer round-trip, hook preflight, wrapper smoke, skill sync, and claude-config tests all pass.
10. Unsupported Gemini/OpenCode/deploy/standalone-remote coverage remains explicit rather than silently allowed.
