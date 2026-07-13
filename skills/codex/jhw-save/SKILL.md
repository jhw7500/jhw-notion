---
name: jhw-save
description: "Notion 즉시 저장(record+note+delete 통합) · --db 대상DB · --delete <id> 폐기 · --hard 휴지통이동 · --force-tag 미등록 태그 자동등록 Use when the user invokes `/jhw:save`, `$jhw-save`, or asks to run the JHW save command."
---

# jhw-save

Run the JHW `save` command workflow.

## Workflow

1. Read `references/save.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-save`. If the user writes `/jhw:save`, treat it as a request to use this skill.
