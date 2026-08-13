---
name: jhw-portfolio
description: "Use when the user explicitly requests Project Control portfolio status, an on-demand export, or live preflight Use when the user invokes `/jhw:portfolio`, `$jhw-portfolio`, or asks to run the JHW portfolio command."
---

# jhw-portfolio

Run the JHW `portfolio` command workflow.

## Workflow

1. Read `references/portfolio.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-portfolio`. If the user writes `/jhw:portfolio`, treat it as a request to use this skill.
