---
name: jhw-match
description: "신규 내용을 기존 Notion과 대조(중복/보강/유사) · --from-review 직전 review 후보 · --db 대상DB · --report 대상보고서 Use when the user invokes `/jhw:match`, `$jhw-match`, or asks to run the JHW match command."
---

# jhw-match

Run the JHW `match` command workflow.

## Workflow

1. Read `references/match.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-match`. If the user writes `/jhw:match`, treat it as a request to use this skill.
