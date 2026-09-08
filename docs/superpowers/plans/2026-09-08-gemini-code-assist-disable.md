# Gemini Code Assist Disable-Preserve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable every current Gemini Code Assist App effect while preserving a separately named, explicitly reactivatable Enterprise path and all managed Gemini CLI review behavior.

**Architecture:** A single fail-closed config predicate makes explicit `disable: false` plus manual-only PR-open configuration necessary for App eligibility. Discovery, reviewer planning, and the final request mutation each enforce that predicate; the managed `gemini` workflow remains independent. The contract harness executes the Markdown Bash helpers against a fake GitHub boundary to prove both disabled and future-enabled behavior.

**Tech Stack:** Bash embedded in Markdown, Node.js contract harness, GitHub CLI boundary fixtures, YAML configuration

**Spec:** `docs/superpowers/specs/2026-09-08-gemini-code-assist-disable-design.md`

## Global Constraints

- `gemini` means the managed Gemini CLI review workflow; `gemini-code-assist` means the GitHub App.
- The App is disabled unless `.gemini/config.yaml` explicitly sets `code_review.disable: false` and `pull_request_opened.code_review: false`.
- Missing, malformed, duplicate, or ambiguous App configuration fails closed.
- `automation#171` remains a separate repository Task; do not modify it here.
- Preserve historical plan/spec files; update only active documentation plus this Task's new records.
- Do not commit, push, open a PR, merge, install into user configuration, or finish the Formal Task without the separately required authority/workflow step.

---

### Task 1: Add failing executable policy and mutation tests

**Files:**
- Modify: `scripts/test-pr-skill-contract.mjs`
- Modify: `scripts/test-issue-skill-contract.mjs`

**Interfaces:**
- Consumes: the executable `pr-review-mode-contract` and `pr-round-contract` blocks from `skills/claude/pr.md`.
- Produces: fixture evidence for `jhw_pr_gemini_code_assist_enabled`, canonical reviewer name `gemini-code-assist`, and zero GitHub mutations while disabled.

- [x] **Step 1: Make the default fixture explicitly disabled**

```js
await writeFile(
  geminiConfigPath,
  "code_review:\n  disable: true\n  pull_request_opened:\n    code_review: false\n",
);
```

- [x] **Step 2: Add a discovery and plan regression**

Run the real extracted helpers with a valid historical `gemini-code-assist[bot]` canary and assert literal outcomes:

```js
assert.equal(disabledDiscovery.stdout, "codex\n");
assert.match(disabledPlan.stdout, /^eligible=codex$/m);
assert.match(disabledPlan.stdout, /^unavailable=.*gemini-code-assist\tpolicy_disabled/m);
```

- [x] **Step 3: Add the mutation-boundary regression**

Invoke both `gemini-code-assist` and legacy `gemini-assist` directly while disabled. Assert a non-zero result, `policy_disabled`, and `mutationCalls(result.log)` equal to `[]`.

- [x] **Step 4: Add the preserved Enterprise-path regression**

Rewrite only the temporary fixture to `disable: false` plus PR-open false. Assert discovery returns `codex\ngemini-code-assist\n` and the canonical request creates exactly one `/gemini review` comment whose marker names `gemini-code-assist`.

- [x] **Step 5: Fix active-document expectations to use the full product name**

Change the Issue-skill/README expectation from `Gemini Assist` to `Gemini Code Assist` while keeping it non-eligible for standalone Issues.

- [x] **Step 6: Run the contract and verify RED**

Run: `node scripts/test-pr-skill-contract.mjs`

Expected: FAIL because the current predicate ignores `disable: true`, current plans use `gemini-assist`, and the direct helper still posts `/gemini review`.

Run: `node scripts/test-issue-skill-contract.mjs`

Expected: FAIL until active naming is updated.

### Task 2: Implement the fail-closed App policy and three gates

**Files:**
- Modify: `skills/claude/pr.md`

**Interfaces:**
- Produces: `jhw_pr_gemini_code_assist_enabled() -> exit 0 only for explicit manual Enterprise opt-in`.
- Produces: canonical App reviewer identifier `gemini-code-assist`; legacy `gemini-assist` is input-only compatibility.
- Produces: `JHW_PR_UNAVAILABLE_APPS` row `gemini-code-assist<TAB>policy_disabled` while disabled.

- [x] **Step 1: Replace the permissive config predicate**

Implement `jhw_pr_gemini_code_assist_enabled` so its Node parser accepts exactly one relevant `disable: false` and exactly one nested `code_review: false`. Require both the `.gemini` directory and `config.yaml` leaf to be regular, non-symlink paths. Any other relevant shape exits non-zero, including control characters or nonstandard line separators that could conceal a duplicate key from the strict line parser.

- [x] **Step 2: Gate discovery before canary access**

```bash
if jhw_pr_gemini_code_assist_enabled &&
  app_actor="$(jhw_pr_repo_has_app_canary gemini-code-assist)"; then
  printf 'gemini-code-assist\n'
fi
```

- [x] **Step 3: Gate capability planning and expose the reason**

Add the App only after the policy and canary succeed. When the policy fails, append exactly `gemini-code-assist<TAB>policy_disabled`; when enabled without canary, append `gemini-code-assist<TAB>canary_unavailable`.

Filter bracketed and unbracketed Code Assist actors from the generic terminal snapshot unless the App is both policy-enabled and present in the canonical expected set. Always exclude those App actors from the dedicated managed-workflow marker collector while preserving legitimate managed Gemini marker/run evidence.

- [x] **Step 4: Guard the mutation boundary**

Normalize `gemini-assist` to `gemini-code-assist`, re-evaluate the predicate, and call `jhw_pr_app_request_failed policy_disabled` before any `gh` call. For an enabled config, recheck the same-repository App canary before the request lookup or POST and fail with `canary_unavailable` if it is absent.

- [x] **Step 5: Keep the future request path canonical**

When enabled, post `/gemini review` with `reviewer=gemini-code-assist` in the head/base marker. Continue reading legacy marker forms only as historical canary input.

- [x] **Step 6: Run the PR contract and verify GREEN**

Run: `node scripts/test-pr-skill-contract.mjs`

Expected: `pr skill contract: ok`.

### Task 3: Apply current disable configuration and active guidance

**Files:**
- Modify: `.gemini/config.yaml`
- Modify: `skills/claude/pr.md`
- Modify: `skills/claude/issue.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the policy behavior implemented in Task 2.
- Produces: operator guidance that never conflates managed Gemini CLI and Gemini Code Assist.

- [x] **Step 1: Set the repository App policy**

```yaml
code_review:
  disable: true
  pull_request_opened:
    code_review: false
```

- [x] **Step 2: Update the reviewer registry and examples**

Name the managed workflow `gemini` and the App `gemini-code-assist`. Mark the App disabled by policy and document legacy alias normalization.

- [x] **Step 3: Bind terminal semantics to the planned set**

Build `ROUND_EXPECTED_REVIEWERS` from only preflighted workflows and eligible Apps, canonicalize the legacy selector, and store terminal rows as `<reviewer>=<STATUS>`. Merge and auto-fix helpers must reject anonymous, missing, duplicate, or cross-channel rows. State that unsolicited App output is ignored while disabled and cannot replace a failed managed Gemini run. Preserve terminal rules only for an explicitly enabled and planned App.

- [x] **Step 4: Update active README and Issue guidance**

Document the same channel boundary and keep Gemini Code Assist out of standalone Issue review. Do not rewrite historical specs/plans.

- [x] **Step 5: Run both active skill contracts**

Run: `node scripts/test-pr-skill-contract.mjs`

Run: `node scripts/test-issue-skill-contract.mjs`

Expected: both print their `contract: ok` terminal message.

### Task 4: Synchronize generated Codex metadata and verify the repository

**Files:**
- Regenerate if required: `skills/codex/jhw-pr/SKILL.md`
- Regenerate if required: `skills/codex/jhw-issue/SKILL.md`

**Interfaces:**
- Consumes: canonical `skills/claude/*.md` frontmatter and references.
- Produces: zero sync drift and a verified Task diff.

- [x] **Step 1: Run the generator and drift check**

Run: `node scripts/sync-codex-skills.mjs`

Run: `node scripts/sync-codex-skills.mjs --check`

Expected: generation succeeds and check reports no drift.

- [x] **Step 2: Run the root safety contract**

Run: `bash scripts/test-install-safety.sh`

Expected: exit 0, including PR and Issue skill contracts.

- [x] **Step 3: Run mandatory MCP gates**

From `mcp-server/` run:

```bash
npm run build
npm run typecheck
npm test
```

Expected: all commands exit 0.

- [x] **Step 4: Inspect the final diff and scope**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff -- . ':(exclude)docs/superpowers/plans/2026-09-01-review-mode-jhw-commands.md' ':(exclude)docs/superpowers/specs/2026-09-01-review-mode-jhw-commands-design.md'`

Confirm there are no `automation`, `claude-config`, secret, dependency, or historical-document changes.

## Self-Review

- Spec coverage: each policy state in the verification matrix maps to Task 1 tests and Task 2 gates.
- Placeholder scan: no deferred implementation placeholders remain.
- Type/name consistency: `gemini` is managed; `gemini-code-assist` is canonical App; `gemini-assist` is legacy input only.
- Execution choice: this active Formal Task proceeds inline with `superpowers:executing-plans`; no implementation subproject requires a separate repository Claim.
