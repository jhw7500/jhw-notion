---
name: jhw-compact
description: "저장 레코드 정리(합치기·요약·저장가치 평가) · --db 대상DB · --report 대상보고서 · --hard 휴지통이동 Use when the user invokes `/jhw:compact`, `$jhw-compact`, or asks to run the JHW compact command."
---

# jhw-compact

Run the JHW `compact` command workflow.

## Workflow

1. Read `references/compact.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-compact`. If the user writes `/jhw:compact`, treat it as a request to use this skill.
