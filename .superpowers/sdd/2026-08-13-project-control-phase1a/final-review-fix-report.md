# Phase 1A Final Whole-Branch Fix Report

**Date:** 2026-08-14
**Branch:** `feat/project-control-phase1a`
**Base:** `9fbd7983c80ad19a7fb0a51e201f67ba60ee1133`
**Validated implementation HEAD:** `d951d35` (report refresh follows)
**Status:** implementation and local deterministic gates complete; independent final re-review pending at report authoring.

## Outcome

The consolidated Critical/Important findings in `final-review-fix-brief.md` were reproduced or disproved against the branch before changes. The accepted fixes preserve the approved Phase 1A boundary: existing Notion remains authority, the central authority policy remains `legacy`, no cutover/migration/Phase 1B behavior was added, and no live GitHub/Notion operation was run.

Implemented outcomes:

- Registry authority now uses one descriptor-anchored, no-follow, HEAD-proven record store with bounded exact-tree enumeration, canonical relation audits, atomic durable publication, and sensitive-content rejection.
- Repository, Project, Issue, checkout, source-revision, alias, and Project-item relations are verified at service boundaries and exposed through locked CLI flows.
- Claim source revisions are frozen at acquisition; temporary lifecycle, resume/Handoff/promotion, cleanup, takeover, and linked crash recovery are deterministic and bounded.
- Journal failure cannot replace authoritative success or create duplicate-retry pressure.
- Live preflight proves Registry identity/readiness before monotonic authority observation, exact token scope/privacy, committed authority/tool version, Notion routes, fixture identity/read/write/restore, and Git remote equality.
- Subprocesses, CLI output, persistence/outbound content, direct errors, installer ownership, and local durability are bounded and fail closed.
- Canonical skills, generated Codex skills, help, README, design, and runbook describe only the implemented Phase 1A operator flow.

## TDD Evidence

Production behavior was changed only after focused RED evidence. Representative correction slices:

| Slice | RED evidence | GREEN evidence |
|---|---|---|
| Registry descriptor/HEAD authority | hostile ancestor/leaf/hardlink/FIFO and dirty-HEAD records were accepted or could escape/hang | descriptor store, exact HEAD bytes/tree, canonical relation audits, and sentinel/Git invariants pass in Catalog/Claim/Registry and E2E |
| Source authority and Project recovery | caller-controlled Repository/Issue coordinates, incomplete membership, and partial Project writes exposed gaps | verified GitHub source service plus exact Project attachment/five-field recovery; focused domain suites and corrected E2E pass |
| Claim/lifecycle/recovery | source revision was caller-time, resume/promotion/cleanup surfaces were incomplete, and injected crash windows stranded generations | frozen revision, atomic lifecycle/history, explicit resume/Handoff/promote/cleanup, linked predecessor recovery, and deterministic worktree reconciliation pass |
| Journal semantics | a derivative journal error replaced an already-successful command | success coordinates/exit remain authoritative with a bounded warning; retry is idempotent |
| Authority/preflight/Notion | authority/tool/Notion/private remote evidence was incomplete and Notion ancestry could fail open | committed authority, minimum version, exact routes/scope/privacy/remote, readback/restore, and exit semantics pass |
| Security/process bounds | secrets/private paths could reach persistence/errors and descendant processes/capture could outlive bounds | centralized reject-not-redact policy, safe direct errors, process-group deadlines, overflow rejection, and installed output drain pass |
| Installer/durability | foreign links/configs could be replaced, TOML equivalents bypassed ownership, and fsync/hardlink edges were incomplete | isolated-HOME ownership round trip and durability/fault boundaries pass |
| Final authority-order correction | focused preflight RED: wrong remote still called the monotonic authority observer once (expected zero) | observer moved after exact Registry proof; `preflight` **35/35** GREEN |
| Strict Notion response fixtures | full-suite RED after strict object validation: **7 failed / 844 passed** because seven test fixtures omitted the official object discriminator | fixture-only correction: append/delete **23/23**, fresh full suite GREEN |
| Corrected adversarial gate | first expanded run found two test-harness expectation defects; no production defect was hidden | pinned gate expanded **19 → 27** deterministic cases and passed twice as fresh processes |
| Framed private-path rejection | punctuation- and `file://`-framed absolute paths bypassed the content boundary | delimiter-aware rejection passes focused policy/E2E regressions; URLs and repository slugs remain accepted |
| Takeover gate runtime bound | the real-Git takeover scenario passed alone but exceeded Vitest's generic 5-second per-test limit in the full gate | the single multi-window scenario has an explicit 15-second ceiling and passed in two fresh complete E2E processes |
| Final re-review round-trip corrections | Handoff absolute paths could be written but not read, and a verified same-node Repository rename stranded formal Tasks | all Handoff creation/write ports reject Unix/Windows/file-URI host paths before mutation; a same-node rename atomically migrates derived Issue URL/alias and the existing formal Task resumes in E2E |
| Angle-framed path self-review | a temporary HTML false-positive exception also permitted `</absolute/path>` framing | the exception was removed; angle-framed paths fail focused policy tests while non-closing literal HTML remains renderable |

Focused evidence retained from the thematic slices includes:

- Catalog/sensitive policy/Task/codec: **106/106**.
- Process/worktree/Task: **158/158**.
- Notion append/delete: **23/23**.
- Preflight: **35/35**.
- Installed/symlinked CLI entry, including near-cap Handoff drain: **5/5**.
- Corrected high-risk E2E families: descriptor outside-sentinel/Git authority; real Repository + Project membership + checkout + Issue URL/node/revision/wrong-repository validation; duplicate source rejection; five-field partial recovery; three cleanup crash windows; Project/Handoff/restored/snapshot injection; exact remote preflight refusal.

No sleeps, external network, live GitHub/Notion, `npx`, dependency upgrade, or `node_modules` patching were used.

## Final Local Gates

All commands below were run from the repository or `mcp-server` as appropriate after the final implementation commits:

| Gate | Result |
|---|---|
| `npm test` | **51 files, 874/874 tests GREEN** |
| `npm run build` | GREEN |
| pinned `phase1a.e2e.test.ts`, fresh process 1 | **28/28 GREEN**, 59.96 s |
| pinned `phase1a.e2e.test.ts`, fresh process 2 | **28/28 GREEN**, 52.53 s |
| `npm test -- --run cli-entry` | **5/5 GREEN** |
| `bash -n install.sh` | GREEN |
| isolated-HOME `scripts/test-install-safety.sh` | `installer safety: ok` |
| `scripts/sync-codex-skills.mjs --check` | **22 canonical skills synchronized** |
| `git diff --check` | GREEN |
| `install.sh` mode | executable mode preserved (`775`) |
| added-line credential/private-home scan | GREEN |
| forbidden `.env` / authority / state / snapshot / `PLAN.md` path scan | GREEN |
| tracked tree before report | clean |

The pinned Vitest version has no supported repeat flag, so the E2E gate was intentionally run as two separate fresh processes.

## Thematic Commits

The branch remains reviewable as small RED→GREEN themes:

```text
4d7c631  Registry descriptor anchoring
 e4902d9  Repository/Issue verification
1fd1cb4  Claim revision and released-worktree recovery
 e905b06  Journal outcome preservation
2bf0e25  Authority/ancestry preflight
2f378a5  Trust-boundary protected-data rejection
3ca04db  Bounded subprocess and CLI drain
f6bcaa6  Foreign-safe installer ownership
f596003  Durable local evidence
caa2cc6  Shared Notion route proof
5028137  Operator contract docs
75b259b..2c3ef5d  Process-tree, authority-lock, source-path, Handoff, secret, and linked-claim hardening
2b050be..affedca  Registry identity, bounded authority, exact preflight/readiness, and local envelopes
9d1b8f5..2c5249c  Catalog bijection, Project API authority, promotion/release validation, safe errors, malformed-record refusal
 ec73fa2  Registry record policy
028da0e  Restored Handoff path rejection
f45e2e5  Linked worktree generation recovery
c6811c4  Restored source binding
34073cf  Command-output overflow rejection
af13985  Preflight fixture pre-verification
8e70c25  Initial corrected-flow E2E expansion
 e7aa288  Formal Claim completion documentation
 a9ce535  Complete Notion authority fixtures
4df06fa  Registry-proof-before-authority observation
5daf625  Full corrected high-risk adversarial gate
c186ff7  Explicit fake home fixtures
ca12cd0  Project/register + Task/finish journal-gap gates
c5257a6  Punctuation-framed host-path rejection
6b28720  Framed file-URI path rejection
79c4053  Explicit takeover E2E runtime bound
08cbff0  Handoff and verified Repository-rename round trips
d951d35  Angle-framed host-path rejection regression
```

The complete ordered commit list is available via:

```text
git log --reverse --oneline 9fbd7983c80ad19a7fb0a51e201f67ba60ee1133..HEAD
```

## Security and Boundary Audit

- Test credentials are unmistakably fake; fake `gh` verifies the selected credential fingerprint while source credential variables are absent from the child environment.
- No raw credential or configured private path is included in prompts, report content, public result/error metadata, or added branch content.
- No `.env`, live authority, live state, snapshot, workflow, or natural-cycle evidence file is tracked.
- `PLAN.md` and live operator data remain untouched.
- Canonical skills were edited only under `skills/claude`; Codex output was regenerated and checked.

## Concerns / Accepted Limits

The first exact-HEAD independent scoped re-review returned **Critical 0 / Important 2**. Both findings were reproduced before correction: absolute-path Handoff content completed release but failed later read/resume, and a verified same-node Repository rename was blocked when a formal Task existed. Commit `08cbff0` closes both with mutation-before-rejection tests and a real rename-to-existing-Task-resume E2E. The corrected HEAD is undergoing the required bounded re-review; it is not declared CLEAN until that verdict is recorded here.

**Live evidence remains insufficient.** This implementation intentionally did not run live preflight, mutate live GitHub/Notion, flip authority, or create synthetic natural-cycle evidence. Deployment readiness still requires the separately governed live trial and natural-cycle evidence described by the approved design. Phase 1B, distributed locks/retries, scheduler/Actions, TTL/heartbeat, automatic context loading, and cutover remain out of scope.

Independent final whole-diff re-review is mandatory. At report authoring it was still running; this report must be updated with its final CLEAN verdict before returning `DONE`.
