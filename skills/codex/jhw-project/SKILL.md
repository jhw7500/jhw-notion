---
name: jhw-project
description: "Use when the user explicitly requests a JHW project start, close, selection, or Phase 1A trial registration Use when the user invokes `/jhw:project`, `$jhw-project`, or asks to run the JHW project command."
---

# jhw-project

Run the JHW `project` command workflow.

## Workflow

1. Read `references/project.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-project`. If the user writes `/jhw:project`, treat it as a request to use this skill.
