# Phase 1A Final Whole-Branch Fix Report

**Date:** 2026-08-14
**Branch:** `feat/project-control-phase1a`
**Base:** `9fbd7983c80ad19a7fb0a51e201f67ba60ee1133`
**Validated implementation HEAD:** `0e7b566` (report refresh follows)
**Status:** implementation and local deterministic gates complete; independent final scoped re-review CLEAN.

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
| Rename lifecycle compatibility | the first rename correction removed the frozen alias used by existing active/history Claims | the verified current alias is added first while prior same-Issue aliases remain globally unique compatibility locators; active status/recover/finish and pre-rename Handoff resume pass E2E |

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
| `npm test` | **51 files, 875/875 tests GREEN** |
| `npm run build` | GREEN |
| pinned `phase1a.e2e.test.ts`, fresh process 1 | **28/28 GREEN**, 69.64 s |
| pinned `phase1a.e2e.test.ts`, fresh process 2 | **28/28 GREEN**, 72.83 s |
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
0e7b566  Claim-alias compatibility across verified renames
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

The first exact-HEAD independent scoped re-review returned **Critical 0 / Important 2**. Both findings were reproduced before correction: absolute-path Handoff content completed release but failed later read/resume, and a verified same-node Repository rename was blocked when a formal Task existed. Commit `08cbff0` closed those direct paths. Its fix-round re-review then found **Critical 0 / Important 1**: replacing the old canonical alias stranded immutable active/history Claims. Commit `0e7b566` preserves globally unique prior same-Issue aliases and proves both active-Claim operations and a pre-rename Handoff resume. The final exact-HEAD scoped re-review returned **CLEAN — Critical 0 / Important 0**.

**The original local gate had insufficient live evidence.** The later trial first recorded one fail-closed preflight and a reversible DraftIssue create/read/delete capability probe, then completed the corrected fixed-fixture preflight described below. No natural Task cycle, Notion mutation, authority flip, cutover, or synthetic evidence occurred. Deployment readiness still requires the natural-cycle evidence described below. Phase 1B, distributed locks/retries, scheduler/Actions, TTL/heartbeat, automatic context loading, and cutover remain out of scope.

The only nonblocking WATCH is that historical formal aliases are constrained by Issue number rather than by a separately persisted repository-slug lineage. Immutable Issue node/source indexes, canonical `task_id`, and global alias uniqueness retain Phase 1A authority and collision safety; no Phase 1B mechanism was added.

## Live Trial Correction — Project Records as DraftIssues

The first approved live preflight exposed a physical least-privilege contradiction that local fakes could not prove: the exact classic `project`-only credential could enumerate the private Project item but returned `content: null` for its private Registry Issue, while the separate repository credential could read the Issue but not the personal Project. The old immutable-node join therefore failed closed with `PREFLIGHT_PROJECT_INTEGRITY`. No scope was broadened, no Notion mutation or authority transition occurred, and the Registry Issue body, labels, Git HEAD, and remote remained unchanged.

A reversible live capability probe then proved that the exact Project-only credential can create, read, and delete a ProjectV2 DraftIssue. The approved minimal correction is therefore:

- Project Records are canonical ProjectV2 DraftIssues, not Registry Issues.
- DraftIssue title plus exact `{id, objective, repositories}` body and the same item's five operational fields form one Project Record.
- Project read/register uses only `GH_PROJECT_TOKEN`; Issue/null/unknown Project content fails closed and never falls back to `GH_REPO_TOKEN`.
- `JHW_PREFLIGHT_PROJECT_ITEM_ID` remains a fixed item coordinate, but it must identify the exact reserved DraftIssue titled `[TRIAL] Project Control Preflight Fixture` with body `unchanged` before it can be excluded from Project Records.
- The configured Registry Issue remains an independent trial-only repo-token read/byte-identical unchanged-write fixture and is never attached or identity-joined to the Project fixture.
- Registration is idempotent at the DraftIssue boundary: zero exact records creates one, one byte-identical partial record is resumed, and duplicates or mismatched identity/title/body/fields fail closed without automatic deletion.
- Public registration output is now only `project_id`, `project_item_id`, and DraftIssue `source_node_id`.

Focused correction evidence:

- Project adapter, dedicated DraftIssue contract, and preflight: **59/59 GREEN**.
- Latest complete MCP suite: **52 files, 873/873 GREEN**.
- DraftIssue partial-registration E2E scenario: GREEN, including no duplicate create on retry and five-field final reread.
- Full Phase 1A adversarial gate: **28/28 GREEN**.
- TypeScript build and canonical skill sync: GREEN.
- A host-state isolation regression in three pre-existing Notion write tests was reproduced after live authority-cache creation; those tests now inject the intended legacy authority explicitly rather than consulting operator state. Focused result: **13/13 GREEN**.

The existing Issue-backed Project fixture is intentionally not migrated by code. The approved operator fixture conversion is explicit and fail-stop rather than automatically reversible: preserve the old coordinates as private evidence, create and validate the fixed DraftIssue, update the non-secret item coordinate, remove only the old Issue-backed Project attachment, retain the Registry Issue itself, then require corrected live preflight plus portfolio status. On failure the operator stops without touching Notion, authority, Registry Issue content, or Registry Git records. Existing Notion data remains unchanged and authoritative throughout Phase 1A.

Independent correction review converged to **CLEAN — Critical 0 / Important 0** in both code and architecture lanes. The final proof set also covers secret- and absolute-host-path-bearing Draft mutation coordinates before any field write. The only remaining deployment WATCH is the deliberately separate natural Task-cycle evidence.

## Corrected Live Fixture Validation

After commit `6135170`, the approved fixture-only conversion was executed with the exact Project-only credential:

1. The old Issue-backed item coordinate and Registry Issue number were preserved in owner-only operator evidence.
2. Exactly one fixed DraftIssue was created and its item/source identity, title, and body were read back.
3. The non-secret configured item coordinate was atomically replaced with mode `0600` preserved.
4. Only the old Project attachment was removed. The first post-delete read observed GitHub's transient item-count lag; the bounded retry reconciled the lost response by proving the old item absent and the single exact DraftIssue present, without issuing a second delete.
5. A fresh live `jhw-control preflight` returned exit `0`, `status: ready`, and all seven checks `ok`.
6. A fresh live `portfolio status` returned zero Project Records, proving that the fixed fixture is excluded and no Issue/null item remains.

The post-run audit found the independent Registry Issue still open with byte-identical body `unchanged` and only the `trial` label. Registry Git was clean and equal to its fetched remote (`0/0` ahead/behind). Authority-cache, pilot journal, and conversion evidence remained owner-only mode `0600`. Notion access was limited to the configured read-only ancestry proof; authority epoch/mode/cutover and existing Notion data were not changed.
