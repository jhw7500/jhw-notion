---
name: jhw-report
description: "일/주/월 업무 보고서(preview→export) · week|month 기간 · --start/--end 날짜범위 · --report 대상보고서필터 · --db 대상DB · --by db DB별그룹 · --include-none 빈항목포함 Use when the user invokes `/jhw:report`, `$jhw-report`, or asks to run the JHW report command."
---

# jhw-report

Run the JHW `report` command workflow.

## Workflow

1. Read `references/report.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-report`. If the user writes `/jhw:report`, treat it as a request to use this skill.
