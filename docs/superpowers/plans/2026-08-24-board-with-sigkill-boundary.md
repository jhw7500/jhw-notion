# Board With SIGKILL Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the operator-facing board skill state the same `board with` SIGKILL/OOM limitation and guardian evidence gate as the approved Board Lock v1 specification.

**Architecture:** Keep the runtime and persisted board schema unchanged. Revise only the canonical Claude skill text; Codex consumes that canonical source through the existing generated skill/reference layout, and the sync checker proves there is no drift.

**Tech Stack:** Markdown, Node.js skill-sync script, TypeScript/Vitest validation gates

**Spec:** `docs/superpowers/specs/2026-08-22-board-lock-design.md`

## Global Constraints

- Board locking remains advisory and does not physically prevent access.
- Do not add process groups, child PID persistence, a guardian helper, heartbeat, or automatic process termination.
- Do not change `board with` runtime behavior, CLI flags, state schemas, or error vocabulary.
- Treat `SIGINT`/`SIGTERM` graceful forwarding separately from uncatchable `SIGKILL` and selective OOM termination.
- State that a process group alone does not guarantee child termination when its parent dies.
- Reconsider guardian/handshake only after two incidents jointly demonstrate wrapper forced termination, a surviving child, and `holder_reaped` or overlapping follow-up occupancy.

---

### Task 1: Align the canonical board skill with the approved boundary

**Files:**
- Modify: `skills/claude/board.md:121-130`
- Verify: `docs/superpowers/specs/2026-08-22-board-lock-design.md:245-255,329-356,423-429`

**Interfaces:**
- Consumes: the Board Lock v1 §3, §7, §8, and §11 SIGKILL/guardian contract.
- Produces: canonical operator guidance consumed by `/jhw:board` and `$jhw-board`; no runtime API or type is produced.

- [ ] **Step 1: Capture the RED documentation gap**

Run:

```bash
rg -n 'SIGKILL|guardian|process group' skills/claude/board.md
```

Expected: no matches, proving the operator skill does not yet expose the approved limitation.

- [ ] **Step 2: Replace the `with` guarantee with the bounded contract**

In `skills/claude/board.md`, replace the current `with` bullet under `## 대기와 래퍼` with this text:

```markdown
- `with`는 **권장 진입점**이다: 정상 종료와 SIGINT/SIGTERM에서는 래퍼 pid를
  기록하고 signal을 자식에게 전달한 뒤 자식 종료를 기다려 release한다. 자식의
  stdio·exit code는 그대로 전파하며(JSON 봉투 밖 실행), 락 좌표 JSON 1줄은
  stderr로 나온다(기계 파싱은 `--json-fd <n>`). 다만 래퍼가 `SIGKILL` 또는 선택적
  OOM 종료로 먼저 사라지면 자식은 계속 실행될 수 있고, 다음 mutation은 죽은 래퍼
  pid를 근거로 홀더를 reap할 수 있다. 이때 살아 있는 자식과 새 홀더가 보드를 함께
  쓰는 물리 충돌 창이 생긴다. process group만으로 부모 사망 시 자식 종료가
  보장되지는 않는다. v1은 이 advisory 한계를 수용하며, 강제종료 뒤 자식 생존과
  `holder_reaped` 또는 후속 중복 점유가 함께 확인된 incident가 2회 쌓일 때만
  guardian/handshake를 재검토한다.
```

Keep the following `--use-holder`, adoption, lease, and nested-reentry guidance unchanged.

- [ ] **Step 3: Verify the GREEN documentation contract**

Run:

```bash
rg -n 'SIGKILL|process group|guardian/handshake|incident가 2회' skills/claude/board.md
```

Expected: all four contract terms match within the revised `with` guidance.

- [ ] **Step 4: Verify generated skill consistency**

Run:

```bash
node scripts/sync-codex-skills.mjs
node scripts/sync-codex-skills.mjs --check
```

Expected: the update command completes, and `--check` reports `skills/codex 동기화 상태` with no drift.

- [ ] **Step 5: Run the repository-required validation gates**

Run:

```bash
cd mcp-server
npm run build
npm run typecheck
npm test
cd ..
git diff --check
```

Expected: build and typecheck exit 0; Vitest reports all files/tests passed; `git diff --check` emits no output.

- [ ] **Step 6: Commit the operator documentation alignment**

Run:

```bash
git add skills/claude/board.md skills/codex
git commit -m "docs(board): expose wrapper SIGKILL boundary"
```

Expected: the commit contains only the canonical skill update and any deterministic generated skill changes.
