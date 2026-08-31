---
name: jhw-review
description: "세션 마무리 시 Notion 저장 후보 정리·저장가치 평가 및 승인 저장 · --match 기존 Notion 대조 · --control Issue·Project·Task 정합성 제안 Use when the user invokes `/jhw:review`, `$jhw-review`, or asks to run the JHW review command."
---

# jhw-review

Run the JHW `review` command workflow.

## Workflow

1. Read `references/review.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-review`. If the user writes `/jhw:review`, treat it as a request to use this skill.
