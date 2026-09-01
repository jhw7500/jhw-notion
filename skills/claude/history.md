---
description: (deprecated) → /jhw:recall <프로젝트명> --history 사용
argument-hint: "→ /jhw:recall <프로젝트명> --history"
---

# /jhw:history — (deprecated)

`/jhw:recall`로 통합. `--history` 플래그로 타임라인 모드.

→ **`/jhw:recall <프로젝트명> --history` 권장.**

## 동작
1. `/jhw:recall` 정본 절차를 연다.
   - Codex에서는 `$jhw-recall` 스킬을 사용해 그 스킬의 `references/recall.md`를 읽는다.
   - Claude Code·Gemini CLI·OpenCode에서는 같은 canonical 디렉터리의 `recall.md`를 읽는다.
2. 사용자가 `/jhw:history` 뒤에 준 프로젝트명과 인자를 `/jhw:recall <프로젝트명> --history`로 해석한다.
3. 실행 시작 시 `/jhw:history`가 deprecated이며 `/jhw:recall --history`로 대체되었다고 한 줄 알린다.
4. 이후에는 연 `recall.md`의 history 모드 절차만 실행한다.

별도 타임라인 조회 로직을 이 alias에 복제하지 않는다.
