---
name: jhw-import
description: "Notion AI Workspace에서 프로젝트/키워드 관련 내용을 검색하여 현재 프로젝트 memory 폴더로 불러오기 Use when the user invokes `/jhw:import`, `$jhw-import`, or asks to run the JHW import command."
---

# jhw-import

Run the JHW `import` command workflow.

## Workflow

1. Read `references/import.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-import`. If the user writes `/jhw:import`, treat it as a request to use this skill.
