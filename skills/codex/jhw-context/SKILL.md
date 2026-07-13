---
name: jhw-context
description: "(deprecated) → /jhw:recall <프로젝트명> 사용 Use when the user invokes `/jhw:context`, `$jhw-context`, or asks to run the JHW context command."
---

# jhw-context

Run the JHW `context` command workflow.

## Workflow

1. Read `references/context.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-context`. If the user writes `/jhw:context`, treat it as a request to use this skill.
