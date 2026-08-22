---
name: jhw-board
description: "Use when the user explicitly requests target-board occupancy, sharing, reservation, waiting, release, or board registry maintenance Use when the user invokes `/jhw:board`, `$jhw-board`, or asks to run the JHW board command."
---

# jhw-board

Run the JHW `board` command workflow.

## Workflow

1. Read `references/board.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-board`. If the user writes `/jhw:board`, treat it as a request to use this skill.
