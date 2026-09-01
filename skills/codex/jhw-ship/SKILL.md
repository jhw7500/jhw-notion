---
name: jhw-ship
description: "(deprecated) /jhw:pr 사용 — 모든 인자를 변경 없이 전달 Use when the user invokes `/jhw:ship`, `$jhw-ship`, or asks to run the JHW ship command."
---

# jhw-ship

Run the JHW `ship` command workflow.

## Workflow

1. Read `references/ship.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-ship`. If the user writes `/jhw:ship`, treat it as a request to use this skill.
