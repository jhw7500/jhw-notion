---
name: jhw-pr
description: "--review 리뷰요청 · --no-review 리뷰생략 · --merge 자동머지 · --target[=cmd] 타겟테스트 게이트 · --auto-fix 자동수정·재리뷰 · --base PR base · --reviewers 대기리뷰어 · --timeout 라운드대기 · --max-rounds 라운드상한 · --block-on 블로킹임계(기본 must-fix) Use when the user invokes `/jhw:pr`, `$jhw-pr`, or asks to run the JHW pr command."
---

# jhw-pr

Run the JHW `pr` command workflow.

## Workflow

1. Read `references/pr.md` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use `$jhw-pr`. If the user writes `/jhw:pr`, treat it as a request to use this skill.
