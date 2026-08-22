---
name: jhw-task
description: "Use when the user explicitly requests a Project Control Task start, existing-Task resume, promotion, Handoff, finish, a finish-then-start switch to another Task/Issue, or recovery Use when the user invokes `/jhw:task`, `$jhw-task`, or asks to run the JHW task command."
---

# jhw-task

Run the JHW `task` command workflow.

## Workflow

1. Read `references/task.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-task`. If the user writes `/jhw:task`, treat it as a request to use this skill.
