---
description: (deprecated) → /jhw:recall <프로젝트명> 사용
argument-hint: "→ /jhw:recall <프로젝트명>"
---

# /jhw:context — (deprecated)

`/jhw:recall`로 통합. 프로젝트명 입력 시 자동으로 context 모드.

→ **`/jhw:recall <프로젝트명>` 권장.**

## 동작
1. `/jhw:recall` 정본 절차를 연다.
   - Codex에서는 `$jhw-recall` 스킬을 사용해 그 스킬의 `references/recall.md`를 읽는다.
   - Claude Code·Gemini CLI·OpenCode에서는 같은 canonical 디렉터리의 `recall.md`를 읽는다.
2. 사용자가 `/jhw:context` 뒤에 준 프로젝트명을 `/jhw:recall`의 context 입력으로 해석한다.
3. 실행 시작 시 `/jhw:context`가 deprecated이며 `/jhw:recall`로 대체되었다고 한 줄 알린다.
4. 이후에는 연 `recall.md`의 context 모드 절차만 실행한다.

별도 컨텍스트 조회 로직을 이 alias에 복제하지 않는다.
