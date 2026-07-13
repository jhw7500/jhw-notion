---
name: jhw-recall
description: "Notion 통합 회상(검색+컨텍스트+타임라인) · --mode search|context|history 모드강제 Use when the user invokes `/jhw:recall`, `$jhw-recall`, or asks to run the JHW recall command."
---

# jhw-recall

Run the JHW `recall` command workflow.

## Workflow

1. Read `references/recall.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-recall`. If the user writes `/jhw:recall`, treat it as a request to use this skill.
