---
name: jhw-commit
description: "Change Evidence Contract v1에 맞는 Git commit 작성 · 직접 커밋과 PR 작업 공용 Use when the user invokes `/jhw:commit`, `$jhw-commit`, or asks to run the JHW commit command."
---

# jhw-commit

Run the JHW `commit` command workflow.

## Workflow

1. Read `references/commit.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-commit`. If the user writes `/jhw:commit`, treat it as a request to use this skill.
