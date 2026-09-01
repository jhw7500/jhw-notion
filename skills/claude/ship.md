---
description: "(deprecated) /jhw:pr 사용 — 모든 인자를 변경 없이 전달"
argument-hint: "[same arguments as /jhw:pr]"
---

# /jhw:ship (deprecated)

이 명령은 `/jhw:pr`의 호환 alias다.

1. `/jhw:pr` 정본 절차를 연다.
   - Codex에서는 `$jhw-pr` 스킬을 사용해 그 스킬의 `references/pr.md`를 읽는다.
   - Claude Code·Gemini CLI·OpenCode에서는 같은 canonical 디렉터리의 `pr.md`를 읽는다.
2. 사용자가 `/jhw:ship` 뒤에 준 모든 인자를 순서와 값 변경 없이 `/jhw:pr` 인자로 해석한다.
3. 실행 시작 시 `/jhw:ship`이 deprecated이며 `/jhw:pr`로 대체되었다고 한 줄 알린다.
4. 이후에는 연 `pr.md`의 승인점·안전 규칙·테스트·리뷰·머지 절차만 실행한다.

별도 PR·리뷰·머지 로직을 이 alias에 복제하지 않는다.
