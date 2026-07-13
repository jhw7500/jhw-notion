---
name: jhw-search
description: "(deprecated) → /jhw:recall 사용 (search 모드 자동) Use when the user invokes `/jhw:search`, `$jhw-search`, or asks to run the JHW search command."
---

# jhw-search

Run the JHW `search` command workflow.

## Workflow

1. Read `references/search.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-search`. If the user writes `/jhw:search`, treat it as a request to use this skill.
