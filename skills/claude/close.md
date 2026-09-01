---
description: (deprecated) → /jhw:project --close 사용
argument-hint: "→ /jhw:project --close [name]"
---

# /jhw:close — (deprecated)

`/jhw:project`로 통합. `--close` 플래그로 종료 + 회고 모드.

→ **`/jhw:project --close [name]` 권장.**

## 동작
1. `/jhw:project` 정본 절차를 연다.
   - Codex에서는 `$jhw-project` 스킬을 사용해 그 스킬의 `references/project.md`를 읽는다.
   - Claude Code·Gemini CLI·OpenCode에서는 같은 canonical 디렉터리의 `project.md`를 읽는다.
2. 사용자가 `/jhw:close` 뒤에 준 프로젝트명과 인자를 `/jhw:project --close` 인자로 해석한다.
3. 실행 시작 시 `/jhw:close`가 deprecated이며 `/jhw:project --close`로 대체되었다고 한 줄 알린다.
4. 이후에는 연 `project.md`의 승인점·안전 규칙·종료 절차만 실행한다.

별도 프로젝트 종료 로직을 이 alias에 복제하지 않는다.
