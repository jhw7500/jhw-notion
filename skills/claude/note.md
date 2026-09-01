---
description: (deprecated) → /jhw:save 사용 (knowledgeBase 자동 라우팅)
argument-hint: "→ /jhw:save <메모>"
---

# /jhw:note — (deprecated)

`/jhw:save`로 통합되었습니다. 기술 지식/메모는 `/jhw:save`가 자동으로 knowledgeBase로 라우팅.

→ **`/jhw:save <메모>` 권장.** (다음 메이저 릴리스에서 삭제 예정)

## 동작
1. `/jhw:save` 정본 절차를 연다.
   - Codex에서는 `$jhw-save` 스킬을 사용해 그 스킬의 `references/save.md`를 읽는다.
   - Claude Code·Gemini CLI·OpenCode에서는 같은 canonical 디렉터리의 `save.md`를 읽는다.
2. 사용자가 `/jhw:note` 뒤에 준 인자를 `/jhw:save --db knowledgeBase`의 내용 인자로 해석한다.
3. 실행 시작 시 `/jhw:note`가 deprecated이며 `/jhw:save`가 기술 지식·메모를 자동 라우팅한다고 한 줄 알린다.
4. 이후에는 연 `save.md`의 승인점·안전 규칙·저장 절차만 실행한다.

별도 저장 로직을 이 alias에 복제하지 않는다.
