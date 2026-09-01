---
name: jhw-issue
description: "GitHub 이슈 생성 · --review 지원 리뷰어 요청·대기·요약 · --no-review 리뷰 생략 · --timeout 대기한도 Use when the user invokes `/jhw:issue`, `$jhw-issue`, or asks to run the JHW issue command."
---

# jhw-issue

Run the JHW `issue` command workflow.

## Workflow

1. Read `references/issue.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-issue`. If the user writes `/jhw:issue`, treat it as a request to use this skill.
