# Review-mode JHW Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/jhw:pr`을 정본 PR 명령으로 만들고 실행별 리뷰 mode를 추가하며, 지원 reviewer만 bounded wait하는 `/jhw:issue`를 제공한다.

**Architecture:** 기존 `ship.md`의 검증된 Markdown/Bash review-round 계약을 `pr.md`로 이동하고 `ship.md`는 인자 보존 alias로 축소한다. PR과 Issue는 `request|skip|auto` 어휘와 고정 라벨을 공유하지만 실행 코드나 영구 상태를 공유하지 않으며, Issue는 별도의 좁은 생성·reviewer-plan workflow를 가진다. Codex 스킬은 계속 `scripts/sync-codex-skills.mjs`만 생성한다.

**Tech Stack:** Markdown skill workflows, embedded Bash contracts, GitHub CLI/API, Node.js contract tests, shell install-safety tests, canonical-to-Codex generator.

**Spec:** `docs/superpowers/specs/2026-09-01-review-mode-jhw-commands-design.md`

## Global Constraints

- 작업 위치는 현재 active Task #99 전용 worktree와 branch뿐이다. 기본 checkout과 다른 worktree를 수정하지 않는다.
- 구현 시작 전에 `skill-creator`, `superpowers:writing-skills`, `superpowers:test-driven-development`를 읽고 따른다.
- Claude 정본은 `skills/claude/*.md`뿐이다. `skills/codex/jhw-*` 생성물을 직접 편집하지 않는다.
- `/jhw:pr`은 현재 `/jhw:ship` 옵션을 모두 보존하고 `--review`, `--no-review`만 추가한다.
- `/jhw:ship`은 deprecated argument-compatible alias로 남는다.
- `--review --no-review`는 라벨, push, PR/Issue, comment, dispatch, merge 전에 실패한다.
- explicit mode는 `review:request`와 `review:skip`만 사용하고, 옵션 생략은 두 라벨을 제거해 저장소 설정을 따른다.
- 현재 설정은 Claude/Gemini PR `auto: true`, 전역 `review.auto` 없음이다. 호환 기본값을 포함해 옵션 생략은 review-on이며 Task #99는 설정을 바꾸지 않는다.
- 새 PR 순서는 push → draft → label reconcile/verify → ready → App request다.
- 기존 PR 순서는 label reconcile/verify → push → remote head verify → App request다.
- `--no-review`는 AI request/wait만 생략한다. required CI, target, current head, mergeability와 explicit merge gate는 유지한다.
- App request는 reviewer와 정확한 PR head별로 idempotent해야 한다.
- Issue review는 Issue를 edit/close/delete하거나 feedback을 자동 구현하지 않는다.
- Codex standalone-Issue review는 same-repository canary evidence가 있을 때만 계획한다. Gemini Assist와 OpenCode는 Issue reviewer가 아니다.
- automation `v1.51`은 peeled commit `ccd1b6f3e1833c82d73826c1332cc6e3e4841d30`이어야 한다.
- MCP, Notion DB, Project Control, `.github/workflow-config.yml`, App 전역 설정은 변경하지 않는다.
- 모든 shell 명령은 `rtk`로 시작한다. 한 shell line에 명령을 연결하면 각 명령도 `rtk`로 시작한다.
- 구현 완료를 주장하기 전에 `superpowers:verification-before-completion`, PR review 요청 전에 `superpowers:requesting-code-review`를 사용한다.

## File Map

| Path | Responsibility |
| --- | --- |
| `skills/claude/pr.md` | PR 생성·갱신, review policy, wait, auto-fix, merge의 정본 |
| `skills/claude/ship.md` | 모든 원본 인자를 `pr.md` 계약으로 전달하는 deprecated alias |
| `skills/claude/issue.md` | Issue 생성, reviewer discovery, bounded wait와 summary 정본 |
| `scripts/test-pr-skill-contract.mjs` | PR option, ordering, trigger, head, merge 회귀 계약 |
| `scripts/test-issue-skill-contract.mjs` | Issue option, reviewer plan, ordering, wait, preservation 계약 |
| `scripts/test-install-safety.sh` | PR/Issue skill 계약을 기존 설치 안전성 suite에 포함 |
| `skills/claude/AGENTS.md` | canonical command와 deprecated alias 인벤토리 |
| `README.md` | `/jhw:pr`, `/jhw:issue`, `/jhw:ship` 공개 사용 예시 |
| `skills/codex/jhw-pr/*` | sync script가 만드는 Codex PR skill |
| `skills/codex/jhw-ship/*` | sync script가 다시 만드는 alias skill |
| `skills/codex/jhw-issue/*` | sync script가 만드는 Codex Issue skill |

---

### Task 1: Establish `/jhw:pr` as the canonical skill without behavior drift

**Files:**
- Create from rename: `skills/claude/pr.md`
- Replace with alias: `skills/claude/ship.md`
- Rename: `scripts/test-ship-skill-contract.mjs` → `scripts/test-pr-skill-contract.mjs`
- Modify: `scripts/test-install-safety.sh`

**Interfaces:**
- Preserves: 현재 Claude/Gemini/OpenCode/Codex v3 state, timeout, severity, target, auto-fix와 merge 분류.
- Produces: primary marker/state prefix `jhw-pr`, executable block marker `pr-round-contract`.
- Accepts for deduplication only: legacy `jhw-ship:codex-review` marker for the same head.
- Keeps private compatibility symbols `SHIP_*` and `ship_*`; 새 공개 helper는 이후 task에서 `jhw_pr_*`를 사용한다.

- [ ] **Step 1: Invoke the skill-writing and TDD workflows**

Read and follow these skills before editing canonical Markdown:

```text
skill-creator
superpowers:writing-skills
superpowers:test-driven-development
```

Confirm the current branch is the Task #99 branch and the worktree has no unrelated changes beyond the approved spec/plan commits.

- [ ] **Step 2: Rename the test and write RED canonical/alias assertions**

```bash
rtk git mv scripts/test-ship-skill-contract.mjs scripts/test-pr-skill-contract.mjs
```

Change the test preamble and source selection to:

```javascript
// Consumer contract for canonical /jhw:pr review rounds and /jhw:ship alias.
const canonicalPr = join(repoRoot, "skills", "claude", "pr.md");
const shipAlias = join(repoRoot, "skills", "claude", "ship.md");
const currentHead = "a".repeat(40);
const oldHead = "b".repeat(40);

const prText = await readFile(canonicalPr, "utf8");
const aliasText = await readFile(shipAlias, "utf8");

assert.match(prText, /^# \/jhw:pr — PR 생성/m);
assert.match(prText, /<!-- pr-round-contract: trigger-and-scope:begin -->/);
assert.match(prText, /<!-- jhw-pr:codex-review round=/);
assert.match(aliasText, /deprecated/i);
assert.match(aliasText, /\/jhw:pr/);
assert.doesNotMatch(aliasText, /pr-round-contract: trigger-and-scope:begin/);
```

Keep every existing fake-`gh` executable assertion. Change only its canonical source, primary marker/state prefix and final success text. Add one fixture with a legacy marker for `currentHead` and assert no second POST occurs; a legacy marker for `oldHead` must not suppress the current request.

- [ ] **Step 3: Run the renamed test and confirm RED**

```bash
rtk node scripts/test-pr-skill-contract.mjs
```

Expected: nonzero exit because `skills/claude/pr.md` does not exist.

- [ ] **Step 4: Move the mature workflow and create the complete alias**

```bash
rtk git mv skills/claude/ship.md skills/claude/pr.md
```

In `pr.md`, change the command/frontmatter/examples and only these persistent public names:

```text
/jhw:ship                         -> /jhw:pr
ship-round-contract              -> pr-round-contract
jhw-ship:codex-review             -> jhw-pr:codex-review
jhw-ship.${PR}.round.${ROUND}     -> jhw-pr.${PR}.round.${ROUND}
```

Keep the existing `SHIP_*` variables and `ship_*` function names in this behavior-preserving task. When searching for an existing Codex request, accept exactly one actor-owned current-head primary marker or exactly one actor-owned legacy `jhw-ship:codex-review round=<n> head=<sha>` marker; multiple matching primary/legacy markers remain `TRIGGER_FAILED`.

Create `skills/claude/ship.md` with exactly this alias contract:

```markdown
---
description: "(deprecated) /jhw:pr 사용 — 모든 인자를 변경 없이 전달"
argument-hint: "[same arguments as /jhw:pr]"
---

# /jhw:ship (deprecated)

이 명령은 `/jhw:pr`의 호환 alias다.

1. 같은 canonical 디렉터리의 `pr.md`를 읽는다.
2. 사용자가 `/jhw:ship` 뒤에 준 모든 인자를 순서와 값 변경 없이 `/jhw:pr` 인자로 해석한다.
3. 실행 시작 시 `/jhw:ship`이 deprecated이며 `/jhw:pr`로 대체되었다고 한 줄 알린다.
4. 이후에는 `pr.md`의 승인점·안전 규칙·테스트·리뷰·머지 절차만 실행한다.

별도 PR·리뷰·머지 로직을 이 alias에 복제하지 않는다.
```

- [ ] **Step 5: Add the canonical PR contract to install safety**

The current suite has no ship contract invocation. Add this line immediately before the existing review/task contract calls at the end of `scripts/test-install-safety.sh`:

```bash
node "$REPO_ROOT/scripts/test-pr-skill-contract.mjs"
```

- [ ] **Step 6: Run the preserved contract and verify GREEN**

```bash
rtk node scripts/test-pr-skill-contract.mjs
```

Expected: `pr skill contract: ok`, with every pre-existing round/state/polling assertion still executed.

- [ ] **Step 7: Commit the canonical rename**

```bash
rtk git add skills/claude/pr.md skills/claude/ship.md scripts/test-pr-skill-contract.mjs scripts/test-install-safety.sh
rtk git commit -m "refactor(skills): make jhw pr the canonical ship workflow"
```

---

### Task 2: Add PR review-mode parsing, labels, ordering, and five-round default

**Files:**
- Modify: `skills/claude/pr.md`
- Modify: `scripts/test-pr-skill-contract.mjs`

**Interfaces:**
- Produces: `jhw_pr_review_mode_from_args "$@"` → `request|skip|auto`.
- Produces: `jhw_pr_global_auto_enabled <config-path>` → `true|false`.
- Produces: `jhw_pr_ensure_review_labels`, `jhw_pr_reconcile_review_labels <mode>`, `jhw_pr_verify_remote_policy <mode> <expected-head>`.
- Produces: `jhw_pr_apply_new_pr_policy <mode>` and `jhw_pr_apply_existing_pr_policy <mode> <local-head>` with the exact event ordering below.
- Consumes: validated `REPO_NWO`, optional validated `PR`, original command arguments.

- [ ] **Step 1: Write RED executable mode/config tests**

Add extraction for a new executable block with this assertion:

```javascript
const policyMatch = prText.match(
  /<!-- pr-review-mode-contract:begin -->\n```bash\n([\s\S]*?)```\n<!-- pr-review-mode-contract:end -->/,
);
assert.ok(policyMatch, "pr skill must expose an executable review-mode contract");
const policyContract = policyMatch[1];
```

Append `policyContract` to the existing round contract sourced by `run`, and add this nonzero-result adapter beside `run`:

```javascript
async function runResult(state, commands, overrides = {}) {
  try {
    return { code: 0, ...(await run(state, commands, overrides)) };
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      state: JSON.parse(await readFile(statePath, "utf8")),
      log: (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
    };
  }
}

const requestMode = await run(baseState(), "jhw_pr_review_mode_from_args --review");
const skipMode = await run(baseState(), "jhw_pr_review_mode_from_args --no-review");
const autoMode = await run(baseState(), "jhw_pr_review_mode_from_args --merge --target");
const conflictMode = await runResult(
  baseState({ mutations: [] }),
  "jhw_pr_review_mode_from_args --review --no-review",
);

assert.equal(requestMode.stdout.trim(), "request");
assert.equal(skipMode.stdout.trim(), "skip");
assert.equal(autoMode.stdout.trim(), "auto");
assert.notEqual(conflictMode.code, 0);
assert.deepEqual(conflictMode.state.mutations, []);
```

Create `configPath = join(tempRoot, "workflow-config.yml")`, rewrite it before each call, and prove:

```javascript
await writeFile(configPath, "review:\n  auto: true\n");
assert.equal((await run(baseState(), `jhw_pr_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "true");
await writeFile(configPath, "review:\n  auto: false\n");
assert.equal((await run(baseState(), `jhw_pr_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "false");
await writeFile(configPath, "workflows: {}\n");
assert.equal((await run(baseState(), `jhw_pr_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "true");
await writeFile(configPath, "review:\n  auto: yes\n");
assert.notEqual((await runResult(baseState(), `jhw_pr_global_auto_enabled ${JSON.stringify(configPath)}`)).code, 0);
```

`yes` must not be accepted as a Boolean merely because YAML 1.1 libraries sometimes coerce it.

- [ ] **Step 2: Write RED permission, label, and event-order tests**

Extend `baseState` with `mutations: []`, `viewerPermission`, labels, PR head and draft state. Make fake `gh` and fake `git` append the semantic operation strings below to `state.mutations`. Invoke the two state-machine helpers and require exact orders:

```javascript
const readOnly = await runResult(
  baseState({ viewerPermission: "READ", mutations: [] }),
  "jhw_pr_apply_new_pr_policy request",
);
const newPr = await run(
  baseState({ viewerPermission: "WRITE", labels: ["review:skip"], mutations: [] }),
  "jhw_pr_apply_new_pr_policy request",
);
const existingPr = await run(
  baseState({ viewerPermission: "WRITE", labels: ["review:request"], mutations: [] }),
  `jhw_pr_apply_existing_pr_policy skip ${currentHead}`,
);
const autoExisting = await run(
  baseState({ viewerPermission: "WRITE", labels: ["review:request", "review:skip"], mutations: [] }),
  `jhw_pr_apply_existing_pr_policy auto ${currentHead}`,
);

assert.deepEqual(readOnly.state.mutations, ["repo-permission"]);
assert.deepEqual(newPr.state.mutations, [
  "repo-permission",
  "list-labels",
  "push",
  "create-draft",
  "remove-skip",
  "add-request",
  "verify-policy",
  "verify-draft-head",
  "ready",
]);
assert.deepEqual(existingPr.state.mutations, [
  "repo-permission",
  "list-labels",
  "remove-request",
  "add-skip",
  "verify-policy",
  "push",
  "verify-new-head",
]);
assert.deepEqual(autoExisting.state.mutations, [
  "repo-permission",
  "list-labels",
  "remove-request",
  "remove-skip",
  "verify-policy",
  "push",
  "verify-new-head",
]);
```

Add cases for missing labels, both labels after reconciliation, a stale remote head, and a PR that unexpectedly leaves draft before policy verification.

- [ ] **Step 3: Run the focused contract and confirm RED**

```bash
rtk node scripts/test-pr-skill-contract.mjs
```

Expected: failure names missing `pr-review-mode-contract` or `jhw_pr_review_mode_from_args`.

- [ ] **Step 4: Implement option and global-auto resolution before mutation**

Embed this parser in the new contract and call it in the first preflight:

```bash
jhw_pr_review_mode_from_args() {
  local arg saw_review=0 saw_no_review=0
  for arg in "$@"; do
    case "$arg" in
      --review) saw_review=1 ;;
      --no-review) saw_no_review=1 ;;
    esac
  done
  (( saw_review == 0 || saw_no_review == 0 )) || {
    echo "--review and --no-review are mutually exclusive" >&2
    return 2
  }
  (( saw_review == 1 )) && { printf 'request\n'; return; }
  (( saw_no_review == 1 )) && { printf 'skip\n'; return; }
  printf 'auto\n'
}
```

The target host has Node but no Ruby or `yq`. Implement `jhw_pr_global_auto_enabled` as a dependency-free bounded Node parser embedded in `pr-review-mode-contract`. It accepts only a top-level block mapping named `review` and a direct-child unquoted scalar `auto: true|false`. A missing file, `review`, or `review.auto` prints compatibility `true`; symlinks, tabs in indentation, duplicate keys, quoted/inline `review`, nested `auto`, and any present non-Boolean value exit 2. Per-workflow `auto` remains owned by automation callers and is not recomputed by this helper.

Add `--review` and `--no-review` to frontmatter, argument table, flow and receipts. Change all documented and executable `--max-rounds` defaults from `3` to `5`; keep a positive-integer per-run override.

- [ ] **Step 5: Implement fixed label preflight and reconciliation**

Use exact constants:

```bash
JHW_REVIEW_REQUEST_LABEL='review:request'
JHW_REVIEW_SKIP_LABEL='review:skip'
JHW_REVIEW_REQUEST_COLOR='0E8A16'
JHW_REVIEW_SKIP_COLOR='B60205'
JHW_REVIEW_REQUEST_DESCRIPTION='Explicitly request AI review'
JHW_REVIEW_SKIP_DESCRIPTION='Explicitly skip AI review'
```

Before label creation, require `gh repo view --json viewerPermission -q .viewerPermission` to be `ADMIN`, `MAINTAIN`, or `WRITE`. List labels with `gh label list --repo "$REPO_NWO" --limit 1000 --json name`; create only missing exact names with the fixed color/description. Existing labels are not recolored or rewritten.

`jhw_pr_reconcile_review_labels` first reads current labels and performs only necessary operations:

```text
request: remove review:skip, then add review:request
skip:    remove review:request, then add review:skip
auto:    remove review:request, then remove review:skip
```

`jhw_pr_verify_remote_policy` reads `.labels[].name` and `.headRefOid`. It fails when both labels remain, the selected explicit label is absent, any override remains in `auto`, or the head differs from the expected 40-character SHA.

- [ ] **Step 6: Encode the race-free new/existing PR state machines**

Add and test these exact transitions:

```text
new:
  label-definition preflight
  -> push
  -> gh pr create --draft
  -> reconcile label
  -> verify label/head/isDraft=true
  -> gh pr ready

existing with new local head:
  label-definition preflight
  -> reconcile label
  -> verify label/current remote head
  -> push
  -> verify new remote head
```

Do not depend on `gh pr create --label` timing. After every push, recompute `SHA` using `git rev-parse HEAD` and require `gh pr view --json headRefOid -q .headRefOid` to match exactly.

- [ ] **Step 7: Encode explicit skip merge semantics**

Only literal `--no-review --merge` waives the AI gate. The final receipt must include:

```text
AI review: explicitly skipped (--no-review; review:skip)
```

The contract must still require required CI success, requested target `PASS`, unchanged current head, mergeability and a supported merge method. Options omitted in the current repository must be documented as review-on; do not change `.github/workflow-config.yml`.

- [ ] **Step 8: Run the complete PR contract and commit**

```bash
rtk node scripts/test-pr-skill-contract.mjs
rtk git add skills/claude/pr.md scripts/test-pr-skill-contract.mjs
rtk git commit -m "feat(skills): add PR review policy options"
```

---

### Task 3: Request every PR reviewer once per head and preserve wait/merge gates

**Files:**
- Modify: `skills/claude/pr.md`
- Modify: `scripts/test-pr-skill-contract.mjs`

**Interfaces:**
- Produces: `jhw_pr_request_app_review <codex|gemini-assist> <40-sha>`.
- Produces: `jhw_pr_dispatch_same_head <workflow-file> <workflow-name> <40-sha>`.
- Produces: `jhw_pr_wait_required_checks <pr-number> <40-sha>` independent of AI mode.
- Reuses: current `CLEAN|FEEDBACK|FAILED|TRIGGER_FAILED|TIMEOUT` and exact-head polling contracts.

- [ ] **Step 1: Write RED App request and deduplication tests**

Add fake GitHub fixtures proving these exact bodies:

```text
@codex review

<!-- jhw-pr:review-request reviewer=codex head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->
```

```text
/gemini review

<!-- jhw-pr:review-request reviewer=gemini-assist head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->
```

Use the Task 2 `run/baseState/runResult` harness and assert the POST count directly from its parsed fake-`gh` log:

```javascript
const countPosts = (result) => result.log.filter((args) => args.includes("POST")).length;
const currentCodexMarker = {
  id: 9101,
  actor: "jhw7500",
  createdAt: requestCreatedAt,
  body: `@codex review\n\n<!-- jhw-pr:review-request reviewer=codex head=${currentHead} -->`,
};
const duplicateCurrentCodexMarker = { ...currentCodexMarker, id: 9102 };
const oldCodexMarker = {
  ...currentCodexMarker,
  id: 9103,
  body: `@codex review\n\n<!-- jhw-pr:review-request reviewer=codex head=${oldHead} -->`,
};
const codexRequest = await run(baseState(), `jhw_pr_request_app_review codex ${currentHead}`);
const geminiRequest = await run(baseState(), `jhw_pr_request_app_review gemini-assist ${currentHead}`);
const codexResume = await run(baseState({ issueComments: [currentCodexMarker] }), `jhw_pr_request_app_review codex ${currentHead}`);
const codexOldHead = await run(baseState({ issueComments: [oldCodexMarker] }), `jhw_pr_request_app_review codex ${currentHead}`);
const codexDuplicate = await runResult(
  baseState({ issueComments: [currentCodexMarker, duplicateCurrentCodexMarker] }),
  `jhw_pr_request_app_review codex ${currentHead}`,
);
const unsupported = await runResult(baseState(), `jhw_pr_request_app_review unknown-reviewer ${currentHead}`);

assert.equal(countPosts(codexRequest), 1);
assert.equal(countPosts(geminiRequest), 1);
assert.equal(countPosts(codexResume), 0);
assert.equal(countPosts(codexOldHead), 1);
assert.notEqual(codexDuplicate.code, 0);
assert.match(codexDuplicate.stderr, /TRIGGER_FAILED/);
assert.notEqual(unsupported.code, 0);
assert.equal(countPosts(unsupported), 0);
```

Add compatibility cases proving one actor-owned `jhw-pr:codex-review round=<n> head=<current>` or legacy `jhw-ship:codex-review ...` suppresses a new Codex POST, while duplicate compatible markers fail closed.

- [ ] **Step 2: Write RED same-head dispatch and AI-independent gate tests**

For Claude, Gemini, and optional OpenCode, simulate Actions runs and assert a current-head queued/in-progress/completed `workflow_dispatch` run is reused. With no such run, assert one exact dispatch:

```bash
gh workflow run claude-code-review.yml --repo "$REPO_NWO" -f pr_number="$PR" -f force_review=true
gh workflow run gemini-auto-review.yml --repo "$REPO_NWO" -f pr_number="$PR" -f force_review=true
gh workflow run opencode-auto-review.yml --repo "$REPO_NWO" -f pr_number="$PR" -f force_review=true
```

Assert `skip` makes zero App POSTs, zero workflow dispatches and zero AI waits, but still logs:

```text
required-checks
target-if-requested
verify-current-head
verify-mergeability
```

- [ ] **Step 3: Run the focused tests and confirm RED**

```bash
rtk node scripts/test-pr-skill-contract.mjs
```

Expected: generic App helper, Gemini Assist marker or same-head dispatch assertions fail.

- [ ] **Step 4: Implement the closed App request helper**

`jhw_pr_request_app_review` validates `REPO_NWO`, positive `PR`, reviewer enum and lowercase 40-character head. It maps commands internally and never accepts arbitrary comment text:

```bash
case "$reviewer" in
  codex) command='@codex review' ;;
  gemini-assist) command='/gemini review' ;;
  *) echo "unsupported PR App reviewer" >&2; return 2 ;;
esac
marker="<!-- jhw-pr:review-request reviewer=${reviewer} head=${head} -->"
```

Resolve the authenticated actor with `gh api user`. Search issue comments for exact body marker and actor. One current marker is reused, zero posts one comment, and more than one is `TRIGGER_FAILED`. For Codex only, include primary round and legacy ship markers for the same head in the same uniqueness count. Preserve current trigger grace, acknowledgment, bot identity discovery and response classification.

- [ ] **Step 5: Implement current-head central workflow dispatch**

For explicit `request` with unchanged remote head, query Actions runs by exact `head_sha`, workflow name and `event == workflow_dispatch`. Reuse exactly one relevant queued/in-progress/completed run; ambiguous matching runs fail closed. Otherwise dispatch exactly once using the commands in Step 2. Dispatch only installed and enabled callers; missing callers are `UNAVAILABLE`, API rejection is `TRIGGER_FAILED`, and an accepted run exceeding the review timeout is `TIMEOUT`.

- [ ] **Step 6: Define effective mode-to-wait behavior**

Add this table verbatim to the skill and executable assertions:

| Effective command policy | Managed workflows | Apps | AI wait |
| --- | --- | --- | --- |
| request | event run or same-head dispatch | explicit head-scoped request | planned reviewers |
| skip | policy-only terminal checks | none | none |
| auto=true | ordinary event runs | explicit head-scoped request | planned reviewers |
| auto=false | no provider runs | none | none |

State that `--reviewers` changes only the waiting subset. It cannot disable an enabled repository workflow selected by the shared label policy.

- [ ] **Step 7: Add required CI and exact-head merge gates**

For every mode, run:

```bash
gh pr checks "$PR" --required --watch --interval 10
```

Implement the head guard as:

```bash
jhw_pr_wait_required_checks() {
  local pr="$1" expected_head="$2" actual_head
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] || return 2
  actual_head="$(gh pr view "$pr" --repo "$REPO_NWO" --json headRefOid -q .headRefOid)" || return 1
  [[ "$actual_head" == "$expected_head" ]] || return 3
  gh pr checks "$pr" --repo "$REPO_NWO" --required --watch --interval 10 || return 1
  actual_head="$(gh pr view "$pr" --repo "$REPO_NWO" --json headRefOid -q .headRefOid)" || return 1
  [[ "$actual_head" == "$expected_head" ]] || return 3
}
```

Return 3 means the caller discards current results and restarts policy resolution for the new head. Failed/cancelled required checks or inability to read them returns 1 and blocks merge. Run the existing optional target gate in parallel using the harness-supported background mechanism. In `skip`/`auto=false`, CI and target completion ends waiting without reading AI artifacts.

Keep auto-fix at default 5 rounds. After each successful fix push, recompute the exact head, invalidate prior reviewer results and request eligible Apps once for the new head. Do not push another fix while any planned reviewer is `PENDING`, `FAILED`, `TRIGGER_FAILED`, or `TIMEOUT`.

- [ ] **Step 8: Run the full PR contract and commit**

```bash
rtk node scripts/test-pr-skill-contract.mjs
rtk git add skills/claude/pr.md scripts/test-pr-skill-contract.mjs
rtk git commit -m "feat(skills): request head-scoped PR reviews"
```

---

### Task 4: Publish and document canonical `/jhw:pr`

**Files:**
- Modify: `skills/claude/AGENTS.md`
- Modify: `README.md`
- Generate: `skills/codex/jhw-pr/SKILL.md`
- Generate: `skills/codex/jhw-pr/references/pr.md`
- Regenerate: `skills/codex/jhw-ship/SKILL.md`
- Preserve generated symlink: `skills/codex/jhw-ship/references/ship.md`
- Modify: `scripts/test-pr-skill-contract.mjs`

**Interfaces:**
- Consumes: canonical `pr.md` and alias `ship.md`.
- Produces: discoverable `$jhw-pr`; keeps `$jhw-ship` discoverable and deprecated.

- [ ] **Step 1: Write RED inventory, README, and generated-output assertions**

Add this import and path setup to `scripts/test-pr-skill-contract.mjs`, then add the assertions:

```javascript
import { existsSync, lstatSync } from "node:fs";

const agentsPath = join(repoRoot, "skills", "claude", "AGENTS.md");
const readmePath = join(repoRoot, "README.md");
const codexPrSkill = join(repoRoot, "skills", "codex", "jhw-pr", "SKILL.md");
const codexPrReference = join(repoRoot, "skills", "codex", "jhw-pr", "references", "pr.md");
const agentsText = await readFile(agentsPath, "utf8");
const readmeText = await readFile(readmePath, "utf8");

assert.match(agentsText, /\| `pr\.md` \|/);
assert.match(agentsText, /ship\.md.*deprecated/i);
assert.match(readmeText, /\/jhw:pr --review/);
assert.match(readmeText, /\/jhw:pr --no-review/);
assert.match(readmeText, /\/jhw:ship.*\/jhw:pr/);
assert.ok(existsSync(codexPrSkill));
assert.ok(lstatSync(codexPrReference).isSymbolicLink());
```

Run and confirm the missing inventory/generated PR skill makes the test fail:

```bash
rtk node scripts/test-pr-skill-contract.mjs
```

- [ ] **Step 2: Update canonical documentation**

In `skills/claude/AGENTS.md`, replace the custom `ship.md` row/pattern with a `pr.md` row listing every existing option plus `--review|--no-review`; add `ship.md → /jhw:pr` to a deprecated alias section.

In `README.md`, add these minimal examples to the command section:

```text
/jhw:pr --review              — 저장소 설정과 무관하게 현재 head AI 리뷰 요청
/jhw:pr --no-review           — review:skip 적용, AI 리뷰 생략
/jhw:pr --review --auto-fix   — 최대 5라운드 수정·재리뷰
/jhw:ship ...                 — deprecated; 같은 인자로 /jhw:pr 실행
```

State that omitted options follow repository config and are currently review-on. Do not change the Notion/MCP sections.

- [ ] **Step 3: Generate Codex skills from canonical sources**

```bash
rtk node scripts/sync-codex-skills.mjs
rtk node scripts/sync-codex-skills.mjs --check
```

Expected: `jhw-pr` is created; `jhw-ship` description comes from the alias; each reference is a relative symlink to its Claude canonical file.

- [ ] **Step 4: Run PR and install-safety tests**

```bash
rtk node scripts/test-pr-skill-contract.mjs
rtk bash scripts/test-install-safety.sh
```

Expected: `pr skill contract: ok` and `installer safety: ok`.

- [ ] **Step 5: Commit canonical and generated PR publication**

```bash
rtk git add skills/claude/AGENTS.md README.md skills/codex/jhw-pr skills/codex/jhw-ship scripts/test-pr-skill-contract.mjs
rtk git commit -m "docs(skills): publish jhw pr and deprecate ship"
```

---

### Task 5: Add `/jhw:issue` creation and supported-reviewer policy

**Files:**
- Create: `skills/claude/issue.md`
- Create: `scripts/test-issue-skill-contract.mjs`
- Modify: `scripts/test-install-safety.sh`

**Interfaces:**
- Produces: `jhw_issue_review_mode_from_args "$@"` → `request|skip|auto`.
- Produces: `jhw_issue_global_auto_enabled <config-path>` → `true|false` with the same strict semantics as PR.
- Produces: `jhw_issue_validate_timeout <minutes>` → validated positive integer; default caller value `20`.
- Produces: `jhw_issue_discover_reviewers` → newline-delimited `claude|gemini|codex` plus unavailable diagnostics.
- Produces: `jhw_issue_reconcile_and_verify_policy <issue-number> <request|skip|auto>`.
- Produces: `jhw_issue_request_reviewer <issue-number> <claude|gemini|codex>` → request comment ID.
- Produces: issue labels and one actor-owned hidden request marker per planned reviewer.
- Consumes: resolved title/body, current repository, global `review.auto`, current workflow files/config, optional same-repository Codex canary evidence.

- [ ] **Step 1: Write the RED option and no-mutation harness**

Create `scripts/test-issue-skill-contract.mjs` with these imports:

```javascript
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalIssue = join(repoRoot, "skills", "claude", "issue.md");
```

Extract `<!-- issue-review-create-contract:begin -->`, create a private temporary directory, write the extracted block to `contract.bash`, and put an executable fake `gh` first on `PATH`.

The fake handles only `repo view`, `label list/create`, `issue create/edit/view`, authenticated `api user`, exact Issue comments/reactions, and Actions-run reads. It appends every argv array to `gh-log.jsonl`, writes semantic mutation names to `state.mutations`, saves state after mutation, and exits 2 for every unrecognized command. Define these helpers:

```javascript
function issueState(overrides = {}) {
  return {
    actor: "jhw7500",
    repo: "example/repo",
    viewerPermission: "WRITE",
    labels: [],
    issueNumber: 99,
    issueUrl: "https://github.com/example/repo/issues/99",
    issueCreatedAt: "2026-09-01T00:00:00Z",
    issueComments: [],
    commentReactions: [],
    runs: [],
    mutations: [],
    nextCommentId: 1001,
    ...overrides,
  };
}

async function runIssue(state, commands, overrides = {}) {
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await writeFile(logPath, "");
  const env = {
    ...process.env,
    PATH: `${tempRoot}:${process.env.PATH}`,
    FAKE_GH_STATE: statePath,
    FAKE_GH_LOG: logPath,
    REPO_NWO: "example/repo",
    JHW_ISSUE_TIMEOUT_MIN: "20",
    ...overrides,
  };
  const script = `source ${JSON.stringify(contractPath)}\n${commands}`;
  const result = await execFileAsync("bash", ["-c", script], { env, maxBuffer: 1024 * 1024 });
  return {
    code: 0,
    ...result,
    state: JSON.parse(await readFile(statePath, "utf8")),
    log: (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

async function runIssueResult(state, commands, overrides = {}) {
  try {
    return await runIssue(state, commands, overrides);
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      state: JSON.parse(await readFile(statePath, "utf8")),
      log: (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
    };
  }
}
```

Then assert:

```javascript
assert.equal((await runIssue(issueState(), "jhw_issue_review_mode_from_args --review")).stdout.trim(), "request");
assert.equal((await runIssue(issueState(), "jhw_issue_review_mode_from_args --no-review")).stdout.trim(), "skip");
assert.equal((await runIssue(issueState(), "jhw_issue_review_mode_from_args")).stdout.trim(), "auto");
const conflict = await runIssueResult(issueState(), "jhw_issue_review_mode_from_args --review --no-review");
assert.notEqual(conflict.code, 0);
assert.deepEqual(conflict.state.mutations, []);
assert.notEqual((await runIssueResult(issueState(), "jhw_issue_validate_timeout 0")).code, 0);
assert.notEqual((await runIssueResult(issueState(), "jhw_issue_validate_timeout 1.5")).code, 0);
assert.equal((await runIssue(issueState(), "jhw_issue_validate_timeout 20")).stdout.trim(), "20");
```

Add a request fixture with zero eligible reviewers and assert there is no `gh issue create`. Add a later reviewer failure fixture and assert there is no `gh issue edit`, close, delete or PATCH request.

- [ ] **Step 2: Run the test and confirm missing-skill RED**

```bash
rtk node scripts/test-issue-skill-contract.mjs
```

Expected: failure reports missing `skills/claude/issue.md`.

- [ ] **Step 3: Create the narrow Issue command interface**

Use exact frontmatter:

```yaml
---
description: "GitHub 이슈 생성 · --review 지원 리뷰어 요청·대기·요약 · --no-review 리뷰 생략 · --timeout 대기한도"
argument-hint: "[title/body] [--review|--no-review] [--timeout <min>]"
---
```

The first phase resolves one nonempty title, body, repository, mode, positive-integer timeout, write permission, fixed label definitions and reviewer plan before Issue creation. Do not expose assignee, milestone, project or bulk-management options. Reuse the PR parser semantics and global-auto compatibility default in a self-contained `issue-review-create-contract` block; do not add a shared runtime file or config.

- [ ] **Step 4: Implement reviewer discovery without guessing secrets or capabilities**

Use this closed eligibility matrix:

| Reviewer | Required evidence |
| --- | --- |
| Claude | `.github/workflows/claude.yml` exists and `workflows.claude.enabled` is literal `true` |
| Gemini | `.github/workflows/gemini-dispatch.yml` exists and `workflows.gemini-dispatch.enabled` is literal `true` |
| Codex | operator supplies a same-repository canary Issue URL and GitHub API shows one later response by the detected Codex bot to the canary request |

Do not inspect or claim GitHub secret values. A caller may still fail authentication at runtime; classify that later as `FAILED` with its Actions URL.

For Codex evidence, reject a different repository, PR URL, missing request, response before request, wrong actor and ambiguous multiple candidate bot identities. Keep the evidence ephemeral for this invocation; do not write a capability file, environment profile or database.

`skip` plans no reviewer. `auto=false` plans no reviewer. `request` and `auto=true` plan all eligible reviewers. Explicit `request` with an empty eligible set exits before `gh issue create`; an individually unavailable reviewer does not block creation when at least one eligible reviewer remains.

- [ ] **Step 5: Implement create, label verification, and one request per reviewer**

Use this exact order and assert it through the fake mutation log:

```text
validate options/content
-> ensure fixed label definitions
-> discover reviewers
-> gh issue create
-> apply review:request, review:skip, or neither
-> API read-back label verification
-> post planned mentions
```

Use these exact request bodies, one comment each:

```text
@claude 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.
<!-- jhw-issue:review-request reviewer=claude -->
```

```text
@gemini 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.
<!-- jhw-issue:review-request reviewer=gemini -->
```

```text
@codex 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.
<!-- jhw-issue:review-request reviewer=codex -->
```

On resume, one exact actor-owned marker is reused; more than one is `FAILED`. A standalone Issue marker has no commit SHA. Apply only `review:request` for request, only `review:skip` for skip, and neither for auto; read the created Issue back before any mention.

- [ ] **Step 6: Add the Issue contract to install safety**

Add immediately after the PR contract invocation:

```bash
node "$REPO_ROOT/scripts/test-issue-skill-contract.mjs"
```

- [ ] **Step 7: Run Issue creation tests and commit**

```bash
rtk node scripts/test-issue-skill-contract.mjs
rtk git add skills/claude/issue.md scripts/test-issue-skill-contract.mjs scripts/test-install-safety.sh
rtk git commit -m "feat(skills): add review-aware issue creation"
```

---

### Task 6: Add bounded Issue waiting and preservation-safe summaries

**Files:**
- Modify: `skills/claude/issue.md`
- Modify: `scripts/test-issue-skill-contract.mjs`

**Interfaces:**
- Produces: reviewer states `PENDING|CLEAN|FEEDBACK|FAILED|TIMEOUT|UNAVAILABLE`.
- Produces: `jhw_issue_collect_signals <issue-number> <request-comment-id> <created-at>` → one JSON signal snapshot.
- Produces: `jhw_issue_classify_reviewer <reviewer> <now-epoch> <trigger-deadline> <review-deadline>` → one reviewer state and diagnostic.
- Produces: `jhw_issue_highest_disposition <state...>` → `FAILED|TIMEOUT|FEEDBACK|CLEAN`.
- Produces: `jhw_issue_render_summary <issue-url> <ephemeral-state-file>` → final table and highest disposition.
- Produces final fields: Issue URL, requested/unavailable reviewers, response links, highest disposition, diagnostics.
- Uses only a private temporary state file for the current invocation and removes it on exit; no persistent state/config is created.

- [ ] **Step 1: Write RED response classification tests**

Use comments, reactions and Actions fixtures to execute `jhw_issue_collect_signals` followed by `jhw_issue_classify_reviewer`. Fix creation at `2026-09-01T00:00:00Z`, request comment ID at `1001`, trigger deadline at epoch `1788221100`, and review deadline at `1788222000`. Require this exact matrix:

| Fixture signals | Expected stdout |
| --- | --- |
| acknowledged request plus later substantive no-problem response by expected bot | `CLEAN` |
| acknowledged request plus later actionable requirement/risk by expected bot | `FEEDBACK` |
| matching Actions run with failure conclusion | `FAILED` |
| explicit connector rejection after request | `FAILED` |
| no acknowledgment and `now > trigger deadline` | `FAILED` |
| acknowledgment exists, no response, and `now > review deadline` | `TIMEOUT` |
| reviewer was excluded during preflight | `UNAVAILABLE` |
| response before Issue creation or by wrong bot | `PENDING` |

For each row, assert both the state and a non-secret diagnostic/response URL where applicable. Then assert the highest disposition helper directly:

```javascript
assert.equal(
  (await runIssue(issueState(), "jhw_issue_highest_disposition CLEAN FEEDBACK")).stdout.trim(),
  "FEEDBACK",
);
assert.equal(
  (await runIssue(issueState(), "jhw_issue_highest_disposition CLEAN TIMEOUT")).stdout.trim(),
  "TIMEOUT",
);
assert.equal(
  (await runIssue(issueState(), "jhw_issue_highest_disposition FEEDBACK FAILED")).stdout.trim(),
  "FAILED",
);
```

- [ ] **Step 2: Run classification tests and confirm RED**

```bash
rtk node scripts/test-issue-skill-contract.mjs
```

Expected: missing `issue-review-wait-contract` block and classifier helpers.

- [ ] **Step 3: Implement bounded signal collection and classification**

Add extraction and implementation for the wait block using this test assertion:

```javascript
const waitMatch = issueText.match(
  /<!-- issue-review-wait-contract:begin -->\n```bash\n([\s\S]*?)```\n<!-- issue-review-wait-contract:end -->/,
);
assert.ok(waitMatch, "issue skill must expose an executable review-wait contract");
const waitContract = waitMatch[1];
```

Capture Issue creation time, request comment IDs, request timestamps and expected bot identity. Collect only later Issue comments, reactions on the exact request comments and relevant Actions runs. Old signals, wrong actors and unrelated workflows cannot complete a reviewer.

Use a short trigger acknowledgment deadline separate from the overall default 20-minute review deadline. Rejected or unacknowledged triggers become `FAILED`; accepted requests without terminal response by the overall deadline become `TIMEOUT`. `UNAVAILABLE` is decided in preflight and is never polled.

The embedded helper performs one bounded collect/classify pass. The skill repeats it at approximately 60-second intervals through the agent harness until all requested reviewers are terminal or the deadline is reached; do not use an untracked shell `&`, `nohup`, or a foreground sleep longer than 60 seconds.

- [ ] **Step 4: Implement the summary and preservation contract**

Render exactly one compact table:

```text
Reviewer | Status | Response | Diagnostic
```

Report Issue URL, requested reviewers, unavailable reviewers and highest disposition. Treat `FAILED/TIMEOUT` as higher than `FEEDBACK`, and `FEEDBACK` as higher than `CLEAN`; list `UNAVAILABLE` separately because it was never requested.

Return the Issue URL on partial failure or timeout. The executable contract and fake-`gh` log must prove no issue edit/delete/close endpoint, milestone/project mutation or implementation command runs after feedback.

- [ ] **Step 5: Run the complete Issue contract and commit**

```bash
rtk node scripts/test-issue-skill-contract.mjs
rtk git add skills/claude/issue.md scripts/test-issue-skill-contract.mjs
rtk git commit -m "feat(skills): wait for issue review responses"
```

---

### Task 7: Publish Issue output and run complete repository verification

**Files:**
- Modify: `skills/claude/AGENTS.md`
- Modify: `README.md`
- Modify: `scripts/test-issue-skill-contract.mjs`
- Generate: `skills/codex/jhw-issue/SKILL.md`
- Generate: `skills/codex/jhw-issue/references/issue.md`
- Modify only after a demonstrated failing regression: earlier Task files.

**Interfaces:**
- Produces: discoverable canonical Claude and generated Codex `pr|ship|issue` skills.
- Produces: a clean, fully verified Task #99 feature head ready for review.

- [ ] **Step 1: Write RED documentation and generated-output assertions**

Add this import/path setup to `scripts/test-issue-skill-contract.mjs`, then add the assertions:

```javascript
import { existsSync, lstatSync } from "node:fs";

const agentsPath = join(repoRoot, "skills", "claude", "AGENTS.md");
const readmePath = join(repoRoot, "README.md");
const codexIssueSkill = join(repoRoot, "skills", "codex", "jhw-issue", "SKILL.md");
const codexIssueReference = join(repoRoot, "skills", "codex", "jhw-issue", "references", "issue.md");
const agentsText = await readFile(agentsPath, "utf8");
const readmeText = await readFile(readmePath, "utf8");

assert.match(agentsText, /\| `issue\.md` \|/);
assert.match(readmeText, /\/jhw:issue --review/);
assert.match(readmeText, /\/jhw:issue --no-review/);
assert.match(readmeText, /\/jhw:issue .*--timeout/);
assert.ok(existsSync(codexIssueSkill));
assert.ok(lstatSync(codexIssueReference).isSymbolicLink());
```

Run and confirm RED because docs/generated Issue output is absent:

```bash
rtk node scripts/test-issue-skill-contract.mjs
```

- [ ] **Step 2: Document `/jhw:issue` and its safety boundary**

Add `issue.md` to the canonical custom-skill table and README examples:

```text
/jhw:issue <내용> --review --timeout 20 — 지원 확인 reviewer 요청·bounded wait
/jhw:issue <내용> --no-review           — review:skip 적용, mention 없음
/jhw:issue <내용>                       — 저장소 review.auto를 따름
```

Document that the current missing global `review.auto` uses compatibility `true`, Codex requires same-repository Issue canary evidence, Gemini Assist/OpenCode are PR-only, and the command never edits/closes/implements review feedback.

- [ ] **Step 3: Generate and inspect all three Codex skills**

```bash
rtk node scripts/sync-codex-skills.mjs
rtk node scripts/sync-codex-skills.mjs --check
rtk ls -l skills/codex/jhw-pr skills/codex/jhw-pr/references
rtk ls -l skills/codex/jhw-ship skills/codex/jhw-ship/references
rtk ls -l skills/codex/jhw-issue skills/codex/jhw-issue/references
```

Expected for each directory: one `SKILL.md` regular file and one relative `references/<name>.md` symlink. Resolve each symlink with `rtk readlink` and verify it points into `skills/claude`, not another checkout or absolute path.

- [ ] **Step 4: Run focused contracts and install safety**

```bash
rtk node scripts/test-pr-skill-contract.mjs
rtk node scripts/test-issue-skill-contract.mjs
rtk node scripts/sync-codex-skills.mjs --check
rtk bash scripts/test-install-safety.sh
```

Expected: both skill contracts, sync check and `installer safety: ok` exit zero.

- [ ] **Step 5: Run mandatory MCP gates even though MCP source is unchanged**

Run from `mcp-server/`:

```bash
rtk npm run typecheck
rtk npm run build
rtk npm test
```

Expected: typecheck, build and the full Vitest suite all exit zero.

- [ ] **Step 6: Verify final scope and commit publication**

```bash
rtk git diff --check origin/main...HEAD
rtk git status --short
rtk git diff --name-only origin/main...HEAD
```

The diff may contain only the approved spec/plan, canonical skills, skill tests, install-safety invocation, docs and generated Codex outputs. It must not contain `.github/workflow-config.yml`, MCP source, Notion, Project Control or App settings.

```bash
rtk git add skills/claude/AGENTS.md README.md scripts/test-issue-skill-contract.mjs skills/codex/jhw-pr skills/codex/jhw-ship skills/codex/jhw-issue
rtk git commit -m "docs(skills): publish review-aware JHW commands"
```

- [ ] **Step 7: Repeat completion verification on the committed head**

Invoke `superpowers:verification-before-completion`, then rerun:

```bash
rtk node scripts/test-pr-skill-contract.mjs
rtk node scripts/test-issue-skill-contract.mjs
rtk node scripts/sync-codex-skills.mjs --check
rtk bash scripts/test-install-safety.sh
rtk npm run typecheck
rtk npm run build
rtk npm test
rtk git diff --check origin/main...HEAD
rtk git status --short --branch
```

Run the three npm commands from `mcp-server/`; all other commands run from repository root. Record the exact feature HEAD and test counts.

---

### Task 8: Request review, merge the verified head, and install from a permanent checkout

**Files:**
- No new source file by default.
- Modify earlier files only for a reviewer finding reproduced by a new failing regression assertion.
- Runtime installation target: permanent checkout `/home/jhw/ai/opencode/projects/jhw-notion`, never the Task worktree.

**Interfaces:**
- Consumes: fully verified Task #99 head and automation `v1.51` immutable contract.
- Produces: merged PR, released Task Claim, permanent installed `jhw-pr|jhw-ship|jhw-issue` skills.

- [ ] **Step 1: Reverify the immutable automation pin and local callers**

```bash
rtk git ls-remote https://github.com/jhw7500/automation.git 'refs/tags/v1.51^{}'
rtk rg -n -- 'ccd1b6f3e1833c82d73826c1332cc6e3e4841d30' .github/workflows .github/workflow-config.yml
```

Expected: the peeled tag is exactly `ccd1b6f3e1833c82d73826c1332cc6e3e4841d30`, and managed callers/config remain pinned to that commit/ref.

- [ ] **Step 2: Push and create the PR with explicit review policy**

Push only the Task #99 branch. Use the branch's canonical `pr.md` workflow to create a draft PR, apply and verify only `review:request`, verify the exact head, then mark it ready. Request only confirmed installed external Apps once for that head. Do not change repository defaults or App settings.

The PR body must link Issue #99, summarize `pr|ship|issue`, list exact validation evidence, and state that omitted options currently resolve to review-on.

- [ ] **Step 3: Request and evaluate current-head reviews**

Invoke `superpowers:requesting-code-review`. Wait for enabled Claude/Gemini managed reviews and confirmed external App responses for the exact feature head. Accept a managed result only when `- Reviewed: <40-sha>` equals current PR head.

For every actionable finding:

1. reproduce it with a failing assertion in `test-pr-skill-contract.mjs` or `test-issue-skill-contract.mjs`;
2. make the smallest canonical-skill fix;
3. regenerate Codex skills;
4. rerun the focused contract;
5. commit, push, and request the new head once.

Use `superpowers:receiving-code-review` before applying feedback that is ambiguous or technically questionable. Never accept a stale-head, duplicate marker, or unsupported Issue-App finding without evidence.

- [ ] **Step 4: Run final-head gates and merge**

On the exact reviewed head, rerun Task 7 Step 7. Confirm required checks, target if requested, current head, mergeability and all requested reviewer terminal states. Merge only that head and verify the merge commit contains it.

- [ ] **Step 5: Update the permanent checkout and reinstall**

First verify `/home/jhw/ai/opencode/projects/jhw-notion` is not the Task worktree and is on permanent `main`. Pull the merged commit there, then run from that permanent checkout:

```bash
rtk git pull --ff-only
rtk bash install.sh --uninstall
rtk bash install.sh
```

Do not run installation from `wt-f28bfecee9de-jhw7500-jhw-notion-99` or any other deletion-bound worktree.

- [ ] **Step 6: Verify installed skill ownership and behavior**

Inspect installed Claude/Codex links and require them to resolve to the permanent checkout. Verify installed `$jhw-pr`, `$jhw-ship`, and `$jhw-issue` descriptions/references exist; `jhw-ship` must be deprecated and point to the canonical alias source. Run sync check and focused contracts once more from the permanent checkout.

- [ ] **Step 7: Finish Task #99 and clean only its owned worktree**

Use the active Task #99 Claim's exact coordinates with the canonical `/jhw:task` completion-ready/finish workflow. Release ownership only after merge and installed verification evidence exist. Then clean only the Task #99 local worktree/branch according to the returned cleanup contract; do not touch other active Claims, worktrees, backup branches or user stashes.
