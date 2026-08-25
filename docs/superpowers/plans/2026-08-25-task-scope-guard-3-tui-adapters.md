# Task Scope Guard 3: TUI Adapters and Fail-Closed Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the central Guard for verified Claude Code and Codex native prompt/tool events while preserving foreign hook configuration and explicitly reporting Gemini CLI/OpenCode as unsupported until their native contracts are proven.

**Architecture:** Expose one `jhw-control-hook` surface composed of a compiled adapter core and a shorter-deadline fail-closed launcher; it translates adapter-specific JSON to the common Guard protocol and renders native hook responses. jhw-notion owns the core/launcher, fixtures, Codex wiring, install safety, and coverage preflight; claude-config owns only a thin Claude wrapper and its settings wiring.

**Tech Stack:** TypeScript 5.5 ESM, Node.js stdin/stdout, Vitest fixtures, Bash installers, JSON settings editors, Python pytest for claude-config

**Spec:** `docs/superpowers/specs/2026-08-25-task-scope-guard-design.md`

## Global Constraints

- This is plan 3 of 6 and depends on plans 1–2.
- Adapter code performs transport translation only. It must not duplicate capability lists, grant comparison, permit transitions, or shell policy.
- Enable enforcement only for native payloads whose prompt origin and PreToolUse blocking semantics are pinned by fixtures.
- Claude Code and Codex are the initial enforce targets. Gemini CLI and OpenCode remain `unsupported`, receive no blocking hook, and must never be reported as protected.
- `UserPromptSubmit` accepts only the adapter's one authoritative raw `prompt` field. Do not search transcripts or broad fallback fields for an unlock string.
- `PreToolUse` failures, malformed payloads, protocol mismatch, timeout, missing executable, and Guard unavailability must emit a native deny.
- `UserPromptSubmit` failure cannot authorize anything; it injects a bounded Guard-unavailable context and later mutations remain blocked.
- `PostToolUse` failure cannot undo a completed tool; report a bounded warning and leave consumed state unreusable.
- Escape/reminder prefixes such as `#nr`, `#raw`, and `#silent` do not bypass Task Scope Guard.
- Do not create `skills/claude/unlock.md`, a Codex `jhw-unlock` skill, or an agent-callable approval command.
- Preserve existing OMX, repowire, Claude, Codex, and foreign hook groups exactly; add/remove only entries identified by the exact jhw-control-hook command.
- The external claude-config worktree currently contains user-owned untracked `.jhw/`, `.serena/`, and HANDOFF files. Never stage, modify, remove, or hide them.
- Keep jhw-notion and claude-config commits separate.
- Installed runtime defaults to enforce and never auto-falls back to observe.

---

### Task 1: Compile one strict hook executable and native response renderer

**Files:**
- Create: `scripts/jhw-control-hook`
- Create: `mcp-server/src/control/hook-codecs.ts`
- Create: `mcp-server/src/control/hook-adapter.ts`
- Create: `mcp-server/src/control/__tests__/hook-codecs.test.ts`
- Create: `mcp-server/src/control/__tests__/hook-adapter.test.ts`
- Modify: `mcp-server/package.json`
- Modify: `mcp-server/scripts/clean-dist.mjs`

**Interfaces:**
- Produces compiled core: `dist/control/hook-adapter.js`.
- Produces user-facing launcher: `scripts/jhw-control-hook`, installed as `jhw-control-hook`.
- Accepts: `--adapter claude|codex --event UserPromptSubmit|PreToolUse|PostToolUse`.
- Reads one bounded JSON object from stdin and writes at most one bounded native JSON object to stdout.
- Calls only `GuardService.submitUserPrompt`, `evaluatePreTool`, or `completePostTool`.

- [ ] **Step 1: Write failing codec and renderer tests**

Tests must pin:

- snake_case event coordinates `session_id`, `cwd`, `tool_name`, `tool_input`, and `tool_use_id`;
- the single authoritative `prompt` field for UserPromptSubmit;
- event argument and payload `hook_event_name` must agree;
- missing/empty session, cwd, tool name, prompt, or tool-use correlation fails schema validation when required;
- stdin above 128 KiB, multiple JSON values, arrays, and trailing non-whitespace fail;
- no output contains raw `tool_input` or prompt bytes.

Render an exact deny shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "GUARD_WORKTREE_MISMATCH"
  },
  "systemMessage": "GUARD_WORKTREE_MISMATCH"
}
```

For `PERMIT_REQUIRED`, the reason/system message must include the Guard-provided bounded summary and exact approval command once.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/hook-codecs.test.ts \
  src/control/__tests__/hook-adapter.test.ts
```

- [ ] **Step 3: Implement adapter-specific input codecs**

Translate native payload to `GuardCommonEvent` without policy:

```ts
export interface HookCodec {
  decode(event: HookEventName, raw: unknown): GuardCommonEvent;
  renderPrompt(result: GuardPromptResult): unknown;
  renderPreTool(result: GuardDecision): unknown;
  renderPostTool(result: GuardPostResult): unknown;
  renderFailure(event: HookEventName, code: "GUARD_UNAVAILABLE" | "GUARD_PROTOCOL_MISMATCH"): unknown;
}
```

The Claude and Codex codecs are separate objects even where current fields match. This makes drift explicit and prevents a permissive shared fallback parser.

- [ ] **Step 4: Implement fail-closed main, watchdog launcher, and bounded output**

`hook-adapter.ts` must:

1. parse exact CLI flags;
2. read bounded stdin;
3. decode through the selected codec;
4. call the central service;
5. validate the Guard result and rendered native output;
6. write one JSON line.

Catch every failure at the executable boundary. For PreToolUse, render a deny instead of exiting silently. For UserPromptSubmit/PostToolUse, render bounded context/warning. Exit 0 after a valid native response so the TUI interprets the JSON decision rather than a shell failure.

The user-facing shell launcher runs the compiled core under an 8-second `timeout --foreground` watchdog, while native hook configuration uses a 12-second timeout. It validates exact adapter/event flags, forwards stdin directly without storing it, captures only bounded core output, and renders the same static native failure response on missing `timeout`, missing core, timeout, nonzero exit, empty output, or malformed JSON. This inner deadline guarantees a deny is emitted before the TUI's outer deadline.

- [ ] **Step 5: Add the second package binary and build permissions**

Update `package.json`:

```json
{
  "bin": {
    "jhw-control": "dist/control/cli.js",
    "jhw-control-hook-core": "dist/control/hook-adapter.js"
  }
}
```

Change the build script to chmod both generated files. Keep `clean-dist.mjs` scoped to the existing dist directory.

- [ ] **Step 6: Verify executable behavior and commit**

```bash
cd mcp-server
npm run build
npm run typecheck
npx vitest run \
  src/control/__tests__/hook-codecs.test.ts \
  src/control/__tests__/hook-adapter.test.ts
test -x dist/control/cli.js
test -x dist/control/hook-adapter.js
```

```bash
git add mcp-server/package.json \
        scripts/jhw-control-hook \
        mcp-server/src/control/hook-codecs.ts \
        mcp-server/src/control/hook-adapter.ts \
        mcp-server/src/control/__tests__/hook-codecs.test.ts \
        mcp-server/src/control/__tests__/hook-adapter.test.ts
git commit -m "feat(guard): add native hook adapter"
```

---

### Task 2: Pin Claude and Codex native contracts with recorded fixtures

**Files:**
- Create: `mcp-server/src/control/__fixtures__/hooks/claude/user-prompt-submit.json`
- Create: `mcp-server/src/control/__fixtures__/hooks/claude/pre-tool-edit.json`
- Create: `mcp-server/src/control/__fixtures__/hooks/claude/post-tool-edit.json`
- Create: `mcp-server/src/control/__fixtures__/hooks/codex/user-prompt-submit.json`
- Create: `mcp-server/src/control/__fixtures__/hooks/codex/pre-tool-edit.json`
- Create: `mcp-server/src/control/__fixtures__/hooks/codex/post-tool-edit.json`
- Create: `mcp-server/src/control/__tests__/hook-contract.test.ts`
- Modify: `mcp-server/src/control/hook-codecs.ts`

**Interfaces:**
- Establishes protocol evidence for `prompt-origin`, `pre-tool-block`, and `post-tool-correlation`.
- Produces: `AdapterContractResult` consumed by Guard preflight.

- [ ] **Step 1: Add sanitized recorded payload fixtures**

Fixtures contain realistic native key names but only synthetic session/path/content values. Each includes `hook_event_name`; prompt fixtures use only `prompt`. Tool fixtures include exact `tool_use_id`.

Do not include transcripts, real repositories, credentials, API tokens, user prompts, or home paths.

- [ ] **Step 2: Write contract tests over fixture bytes**

For both adapters, prove:

- identical semantic operations normalize to identical requirements/risk/boundary;
- origin-adapter identity remains part of the permit binding and digest, while hook/execution stage is excluded;
- exact unlock raw bytes reach `submitUserPrompt` unchanged;
- `user_prompt`, `input`, transcript text, and assistant text are not accepted as authoritative prompt fallback;
- a deny response survives native output sanitization with its approval command;
- ALLOW emits no permission override;
- PostToolUse supplies the exact correlation ID.

- [ ] **Step 3: Add hostile fixture variants in tests**

Programmatically mutate fixture copies for:

- unknown event;
- mismatched `--event`;
- omitted prompt;
- extra unlock line;
- malformed tool input;
- adapter protocol version mismatch;
- a changed cwd or file path after approval.

Every mutation must fail closed or produce permit mismatch, never silent ALLOW.

- [ ] **Step 4: Verify and commit contract evidence**

```bash
cd mcp-server
npx vitest run \
  src/control/__tests__/hook-contract.test.ts \
  src/control/__tests__/hook-codecs.test.ts \
  src/control/__tests__/hook-adapter.test.ts
npm run typecheck
```

```bash
git add mcp-server/src/control/__fixtures__/hooks \
        mcp-server/src/control/__tests__/hook-contract.test.ts \
        mcp-server/src/control/hook-codecs.ts
git commit -m "test(guard): pin native hook contracts"
```

---

### Task 3: Install the common executable and owned Codex hook entries safely

**Files:**
- Modify: `install.sh`
- Modify: `scripts/install-config.mjs`
- Modify: `scripts/test-install-safety.sh`
- Create: `scripts/test-hook-preflight.sh`
- Modify: `mcp-server/src/control/cli.ts`
- Modify: `mcp-server/src/control/__tests__/cli.test.ts`
- Modify: `README.md`

**Interfaces:**
- Installs: `$HOME/.local/bin/jhw-control-hook` as a repository-owned symlink to `scripts/jhw-control-hook`.
- Adds/removes exact owned groups in `$HOME/.codex/hooks.json`.
- Extends: `jhw-control guard preflight` with per-adapter coverage.

- [ ] **Step 1: Write failing installer safety cases**

In temporary HOME fixtures, test:

- fresh install creates both control symlinks;
- foreign `hooks.json` groups and ordering remain byte-equivalent apart from the owned additions;
- rerun is idempotent;
- an exact external file/symlink collision at `jhw-control-hook` aborts without overwriting;
- uninstall removes only the repository-owned executable and exact hook groups;
- foreign entries using another command survive uninstall;
- corrupt/non-object hooks JSON fails closed with a private backup and no partial replacement;
- installed hook file mode remains 0600 when the file is created;
- Gemini/OpenCode receive no Guard hook wiring.

- [ ] **Step 2: Add exact Codex hook ownership operations**

Extend `install-config.mjs` with `register-codex-hooks` and `unregister-codex-hooks`. Own only groups whose sole command equals and whose native timeout is exactly 12 seconds:

```text
$HOME/.local/bin/jhw-control-hook --adapter codex --event UserPromptSubmit
$HOME/.local/bin/jhw-control-hook --adapter codex --event PreToolUse
$HOME/.local/bin/jhw-control-hook --adapter codex --event PostToolUse
```

Do not add a PreToolUse matcher; every tool must reach the central classifier. Append owned groups without reordering existing groups. On uninstall, remove only exact owned groups and delete an empty event array only when this installer made it empty.

- [ ] **Step 3: Extend install/uninstall transaction order**

Installation order:

1. build the CLI/hook core and validate the launcher executable;
2. install both owned symlinks;
3. install skills/MCP entries;
4. install Codex hooks;
5. run Guard preflight.

Uninstall reverses only owned artifacts. If Codex hook registration fails, remove the newly installed hook symlink and leave foreign configuration intact; do not leave a “protected” success message.

- [ ] **Step 4: Report truthful adapter coverage**

Preflight result per adapter:

```json
{
  "codex": {
    "prompt_origin": "ok",
    "pre_tool_block": "ok",
    "post_tool_correlation": "ok",
    "execution_recheck": "pending",
    "enforced": true
  },
  "gemini": {
    "prompt_origin": "unsupported",
    "pre_tool_block": "unsupported",
    "post_tool_correlation": "unsupported",
    "execution_recheck": "pending",
    "enforced": false
  }
}
```

Claude coverage remains `missing` until claude-config task 4 is installed. OpenCode remains unsupported.

- [ ] **Step 5: Run installer and preflight tests**

```bash
bash scripts/test-install-safety.sh
bash scripts/test-hook-preflight.sh
cd mcp-server
npx vitest run src/control/__tests__/cli.test.ts
npm run build
npm run typecheck
```

- [ ] **Step 6: Commit jhw-notion installation support**

```bash
git add install.sh \
        scripts/install-config.mjs \
        scripts/test-install-safety.sh \
        scripts/test-hook-preflight.sh \
        mcp-server/src/control/cli.ts \
        mcp-server/src/control/__tests__/cli.test.ts \
        README.md
git commit -m "feat(install): wire Codex scope guard hooks"
```

---

### Task 4: Wire Claude through claude-config as the documented fail-closed exception

**Repository:** `/home/jhw/ai/opencode/projects/claude-config`

**Files:**
- Create: `hooks/task-scope-guard.sh`
- Create: `tests/test_task_scope_guard.py`
- Modify: `install.sh`
- Modify: `hooks/README.md`
- Modify: `claude-md/global-guidance.md`
- Modify: `tests/test_installer_private_config.py`
- Modify: `tests/test_hook_payload_guard.py`
- Modify: `tests/test_hook_selfcheck.py`

**Interfaces:**
- Adds exact Claude commands:
  - `$HOME/.claude/hooks/task-scope-guard.sh --event UserPromptSubmit`
  - `$HOME/.claude/hooks/task-scope-guard.sh --event PreToolUse`
  - `$HOME/.claude/hooks/task-scope-guard.sh --event PostToolUse`
- Delegates every policy decision to `$HOME/.local/bin/jhw-control-hook --adapter claude`.

- [ ] **Step 1: Record and preserve the dirty-worktree boundary**

Run read-only status first:

```bash
git -C /home/jhw/ai/opencode/projects/claude-config status --short
```

Expected existing untracked paths:

```text
.jhw/
.serena/
HANDOFF.claude-config-claude-code.md
HANDOFF.projects-claude-code.md
```

Do not stage them. If tracked files already contain unrelated edits when execution begins, stop this task and ask the user how to isolate them.

- [ ] **Step 2: Write failing wrapper and installer tests**

`test_task_scope_guard.py` must prove:

- stdin bytes and exact event flag are forwarded to the common executable;
- a valid executable response is passed through unchanged;
- missing executable, timeout, nonzero exit, malformed output, and empty output emit PreToolUse deny JSON;
- the same failures on UserPromptSubmit inject Guard-unavailable context and cannot approve;
- PostToolUse failure emits a warning;
- wrapper always exits 0 after producing a valid native response;
- reminder escape prefixes have no effect.

Update installer expectations from 14 to 17 hook commands and assert exact event wiring with no PreToolUse matcher.

- [ ] **Step 3: Implement the policy-free wrapper**

`task-scope-guard.sh` accepts only one exact `--event` value, chooses no capability, and invokes:

```bash
"$HOME/.local/bin/jhw-control-hook" \
  --adapter claude \
  --event "$EVENT"
```

It must not use `jq`, inspect prompts, interpret request IDs, or apply escape prefixes. Its fallback renderer is static and bounded.

- [ ] **Step 4: Add Claude settings wiring**

Use claude-config's existing atomic settings editor and exact-command idempotency. Register all three events with a 12-second native timeout, longer than the common launcher's 8-second watchdog. Keep `task-nudge.sh` as an advisory reminder, but make the new guard a separate no-matcher PreToolUse group.

Uninstall/rerun semantics must preserve foreign settings and private backups exactly as existing tests require.

- [ ] **Step 5: Update the fail-open policy documentation deliberately**

Revise `hooks/README.md`:

- existing reminder/measurement hooks remain fail-open;
- `task-scope-guard.sh` is the sole documented fail-closed mutation guard;
- Guard failure emits a native deny, not a silent exit;
- escape prefixes do not apply;
- native prompt origin is required for unlock.

Revise `global-guidance.md` so “Task 없이 진행” remains valid only for read-only/unregistered/non-protected work. It must not be presented as an option after Guard blocks a protected mutation. Include the exact `/jhw:unlock req-id` response and explain that `ok` or `진행` is not approval.

- [ ] **Step 6: Run claude-config tests and commit only owned paths**

```bash
cd /home/jhw/ai/opencode/projects/claude-config
pytest -q \
  tests/test_task_scope_guard.py \
  tests/test_installer_private_config.py \
  tests/test_hook_payload_guard.py \
  tests/test_hook_selfcheck.py
git diff --check
```

Stage explicitly:

```bash
git add hooks/task-scope-guard.sh \
        tests/test_task_scope_guard.py \
        install.sh \
        hooks/README.md \
        claude-md/global-guidance.md \
        tests/test_installer_private_config.py \
        tests/test_hook_payload_guard.py \
        tests/test_hook_selfcheck.py
git commit -m "feat(hooks): enforce project task scope"
```

Verify the four pre-existing untracked paths remain untracked after commit.

---

### Task 5: Validate cross-repository installation and truthful rollout state

**Files:**
- Modify: `README.md`
- Modify: `skills/claude/task.md`
- Regenerate: `skills/codex/jhw-task/SKILL.md`
- Modify: `scripts/test-hook-preflight.sh`

**Interfaces:**
- Documents Claude/Codex enforcement, Gemini/OpenCode unsupported status, and pending execution-layer coverage.
- Demonstrates uninstall/reinstall ownership safety for both repositories.

- [ ] **Step 1: Add cross-repository smoke scenarios**

With temporary HOME:

1. install jhw-notion;
2. install claude-config;
3. run preflight;
4. assert Claude and Codex prompt/pre/post coverage is `ok`;
5. assert execution recheck is `pending`;
6. assert Gemini/OpenCode are unsupported;
7. uninstall jhw-notion and verify claude-config wrapper remains but denies because the executable is absent;
8. reinstall jhw-notion and verify protection returns without editing Claude settings again.

- [ ] **Step 2: Validate real native output shapes without mutating user state**

Pipe sanitized fixtures into the built executable for all six adapter/event combinations. Assert:

- deny shapes are accepted by the native contract fixture;
- `PERMIT_REQUIRED` displays the exact command once;
- exact unlock returns a separate `start_by`;
- generic Korean continuation prompts do not approve;
- protocol mismatch denies.

- [ ] **Step 3: Update operator docs and generated skill**

State clearly:

- hooks protect normal tool paths, not malicious same-UID direct processes;
- high-risk execution boundaries remain unavailable/pending until plans 4–6;
- direct high-risk commands are blocked instead of temporarily allowed;
- no unlock skill exists;
- Guard status/preflight commands are read-only.

Run the Codex skill generator and drift check.

- [ ] **Step 4: Run all gates in both repositories**

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion/mcp-server
npm run build
npm run typecheck
npm test
cd ..
bash scripts/test-install-safety.sh
bash scripts/test-hook-preflight.sh
node scripts/sync-codex-skills.mjs --check

cd /home/jhw/ai/opencode/projects/claude-config
pytest -q
```

- [ ] **Step 5: Perform the required jhw-notion uninstall/reinstall check**

After isolated-HOME tests pass, run the repository-required real installation gate:

```bash
cd /home/jhw/ai/opencode/projects/jhw-notion
./install.sh --uninstall
./install.sh
jhw-control guard preflight
```

Expected: only repository-owned symlinks/config groups are removed and restored; Claude and Codex are reported protected at the hook layer; execution recheck remains pending.

- [ ] **Step 6: Commit final adapter documentation**

```bash
git add README.md \
        skills/claude/task.md \
        skills/codex/jhw-task \
        scripts/test-hook-preflight.sh
git commit -m "docs(guard): publish adapter coverage"
```

---

## Plan 3 completion gate

Do not start execution-layer work until:

1. Claude and Codex recorded native fixtures prove prompt origin, PreToolUse denial, and PostToolUse correlation.
2. Missing/broken Guard emits a mutation deny in both adapters.
3. Exact unlock works only through UserPromptSubmit.
4. Foreign hook entries survive install, rerun, and uninstall.
5. claude-config's old global fail-open statement explicitly excludes Task Scope Guard.
6. Gemini/OpenCode are reported unsupported rather than protected.
7. Preflight truthfully reports high-risk execution recheck as pending.
