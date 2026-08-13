---
name: jhw-status
description: "Use when the user requests status for the existing Notion AI Workspace or one of its databases Use when the user invokes `/jhw:status`, `$jhw-status`, or asks to run the JHW status command."
---

# jhw-status

Run the JHW `status` command workflow.

## Workflow

1. Read `references/status.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-status`. If the user writes `/jhw:status`, treat it as a request to use this skill.
