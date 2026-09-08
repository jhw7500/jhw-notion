# Gemini Code Assist Disable-Preserve Design

**Status:** Approved for implementation by `jhw-notion#128`

**Related:** `jhw7500/jhw-notion#128`, `jhw7500/automation#171`

## Problem

The PR skill currently treats a repository as eligible for the Gemini Code Assist GitHub App when `.gemini/config.yaml` disables only PR-open reviews and a historical App canary exists. The consumer service is no longer usable, so that historical evidence can still cause `/gemini review` requests and waits. The implementation must stop those effects without deleting the Enterprise-capable path.

## Channel Boundary

| Channel | Canonical identifier | Transport | Current policy |
|---|---|---|---|
| Managed Gemini CLI review | `gemini` | `Gemini Auto PR Review`, `@gemini-cli /review`, `GEMINI_API_KEY` | Preserve |
| Gemini Code Assist GitHub App | `gemini-code-assist` | `gemini-code-assist[bot]`, `/gemini review`, `.gemini/config.yaml` | Disable |
| Legacy App alias | `gemini-assist` | Input compatibility only | Normalize to `gemini-code-assist` |

The word `gemini` never identifies the GitHub App. Disabling the App must not disable, rename, or satisfy the managed Gemini workflow.

## Policy Resolution

`jhw_pr_gemini_code_assist_enabled` is the single App policy predicate. It returns success only when a regular, non-symlink `.gemini` directory contains a regular, non-symlink `config.yaml` with both of these unambiguous values under `code_review`:

```yaml
code_review:
  disable: false
  pull_request_opened:
    code_review: false
```

This is an explicit Enterprise/manual-review opt-in. Every other state is disabled, including:

- `disable: true`
- a missing `disable` key
- a missing config file
- malformed or duplicate relevant keys
- automatic PR-open review not set to `false`

The predicate intentionally recognizes only a strict plain-key mapping subset. Quoted, escaped, explicit-key, tagged, list, control-character, nonstandard-line-separator, or otherwise unsupported YAML shapes fail closed even when a general YAML parser could interpret them. Future Enterprise onboarding must keep the two policy coordinates in the documented plain form or deliberately extend this parser and its adversarial fixtures.

The repository's current configuration is:

```yaml
code_review:
  disable: true
  pull_request_opened:
    code_review: false
```

The second setting is retained so a future explicit enable remains manual-only.

## Defense-in-Depth Gates

1. **Discovery:** Do not query the historical App canary unless the explicit enable predicate succeeds.
2. **Plan and wait:** Do not add the App to `JHW_PR_ELIGIBLE_APPS` or expected reviewer state while disabled. Record `gemini-code-assist<TAB>policy_disabled` in `JHW_PR_UNAVAILABLE_APPS`. The generic terminal collector removes both bracketed and unbracketed Code Assist actors unless the App is explicitly enabled and present in `ROUND_EXPECTED_REVIEWERS`; the managed-workflow marker collector always excludes those App actors. Unsolicited App signals therefore cannot satisfy, replace, or fail a planned managed reviewer.
3. **Mutation:** `jhw_pr_request_app_review` checks the policy again after normalizing the legacy alias and before any `gh` call. A disabled direct invocation returns `TRIGGER_FAILED` with `policy_disabled` and performs no lookup or POST. An explicitly enabled invocation then rechecks the same-repository canary before its request lookup or POST and returns `canary_unavailable` if that proof is absent.

When explicitly enabled, the existing same-repository canary remains mandatory. Enablement without a valid current capability canary stays `UNAVAILABLE` with `canary_unavailable`.

## Terminal Semantics

Gemini Code Assist terminal rules remain documented for the future enabled path, but they apply only when `gemini-code-assist` is in the planned reviewer set. `jhw_pr_select_expected_reviewers` builds that set from preflighted workflows and eligible Apps, after canonicalizing the legacy selector. Each terminal row is named `<reviewer>=<STATUS>` and merge/auto-fix validation requires an exact, duplicate-free match with `ROUND_EXPECTED_REVIEWERS`. Anonymous or cross-channel status rows fail closed. An unsolicited `gemini-code-assist[bot]` review therefore cannot replace a failed or missing `Gemini Auto PR Review` run.

## Compatibility

- New plans and request markers use `gemini-code-assist`.
- The legacy `gemini-assist` input remains accepted and normalizes to the canonical identifier before policy evaluation.
- Historical request markers may remain readable as canary evidence after an explicit future enable, but disabled policy prevents them from creating present eligibility.
- Historical documents under `docs/superpowers/plans` and `docs/superpowers/specs` are not rewritten.

## Repository Boundaries

- This Task changes only `jhw7500/jhw-notion`.
- `jhw7500/automation#171` owns the central `.gemini/config.yaml`, active contract, and canonical-tree test changes for that repository.
- No tracked Gemini Code Assist path is currently present in `claude-config`; no change or Issue is needed there unless concrete tracked evidence appears.

## Verification Matrix

| Configuration and evidence | Managed `gemini` | App discovery/plan | `/gemini review` |
|---|---|---|---|
| `disable: true` + valid historical App canary | Preserved | `policy_disabled` | Never |
| missing or malformed App config + valid canary | Preserved | `policy_disabled` | Never |
| `disable: false`, PR-open false, no valid canary | Preserved | `canary_unavailable` | Never |
| `disable: false`, PR-open false, valid canary | Preserved | `gemini-code-assist` eligible | Allowed |
| legacy `gemini-assist` direct input while disabled | Preserved | Canonicalized then blocked | Never |

## Out of Scope

- Enterprise onboarding or Developer Connect setup
- Removing the App implementation or `.gemini/config.yaml`
- Changing managed Gemini workflow files, secrets, triggers, or reviewer identity
- Modifying `automation` or `claude-config` from this Task
