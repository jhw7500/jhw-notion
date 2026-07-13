---
name: jhw-cclog
description: "Claude Code 세션 대화기록 시간순 조회 · --tools 도구호출포함 · --last N 최근N턴 · 인자로 세션경로|all Use when the user invokes `/jhw:cclog`, `$jhw-cclog`, or asks to run the JHW cclog command."
---

# jhw-cclog

Run the JHW `cclog` command workflow.

## Workflow

1. Read `references/cclog.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-cclog`. If the user writes `/jhw:cclog`, treat it as a request to use this skill.
