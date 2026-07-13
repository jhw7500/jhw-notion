---
name: jhw-note
description: "(deprecated) → /jhw:save 사용 (knowledgeBase 자동 라우팅) Use when the user invokes `/jhw:note`, `$jhw-note`, or asks to run the JHW note command."
---

# jhw-note

Run the JHW `note` command workflow.

## Workflow

1. Read `references/note.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-note`. If the user writes `/jhw:note`, treat it as a request to use this skill.
