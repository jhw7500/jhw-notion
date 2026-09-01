---
description: (deprecated) → /jhw:recall 사용 (search 모드 자동)
argument-hint: "→ /jhw:recall <키워드>"
---

# /jhw:search — (deprecated)

`/jhw:recall`로 통합. 키워드 입력 시 자동으로 search 모드로 동작.

→ **`/jhw:recall <키워드>` 권장.**

## 동작
1. `/jhw:recall` 정본 절차를 연다.
   - Codex에서는 `$jhw-recall` 스킬을 사용해 그 스킬의 `references/recall.md`를 읽는다.
   - Claude Code·Gemini CLI·OpenCode에서는 같은 canonical 디렉터리의 `recall.md`를 읽는다.
2. 사용자가 `/jhw:search` 뒤에 준 모든 인자를 순서와 값 변경 없이 `/jhw:recall`의 키워드 인자로 해석한다.
3. 실행 시작 시 `/jhw:search`가 deprecated이며 `/jhw:recall`로 대체되었다고 한 줄 알린다.
4. 이후에는 연 `recall.md`의 search 모드 절차만 실행한다.

별도 검색 로직을 이 alias에 복제하지 않는다.
