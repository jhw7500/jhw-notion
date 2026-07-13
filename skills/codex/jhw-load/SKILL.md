---
name: jhw-load
description: "세션·노션·깃 작업내역 시간순 머지 · --source 소스선택 · --last N 최근N · --since 기간 · --tools 도구호출포함 · --author 깃author Use when the user invokes `/jhw:load`, `$jhw-load`, or asks to run the JHW load command."
---

# jhw-load

Run the JHW `load` command workflow.

## Workflow

1. Read `references/load.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-load`. If the user writes `/jhw:load`, treat it as a request to use this skill.
