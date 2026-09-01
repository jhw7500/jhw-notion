---
description: (deprecated) → /jhw:save --delete 사용
argument-hint: "→ /jhw:save --delete <id> [--hard]"
---

# /jhw:delete — (deprecated)

`/jhw:save --delete <id>`로 통합. alias로 동일 동작.

→ **`/jhw:save --delete <pageId>` 권장.** (기본은 폐기=`mode: archive`로 status를 '폐기'로 변경, `--hard`는 `mode: delete`로 Notion 휴지통 이동 — **둘 다 영구 삭제 아님, 복구 가능**)

## 동작
1. `/jhw:save` 정본 절차를 연다.
   - Codex에서는 `$jhw-save` 스킬을 사용해 그 스킬의 `references/save.md`를 읽는다.
   - Claude Code·Gemini CLI·OpenCode에서는 같은 canonical 디렉터리의 `save.md`를 읽는다.
2. 사용자가 `/jhw:delete` 뒤에 준 id와 선택적 `--hard`를 `/jhw:save --delete` 인자로 해석한다.
3. 실행 시작 시 `/jhw:delete`가 deprecated이며 `/jhw:save --delete`로 대체되었다고 한 줄 알린다.
4. 이후에는 연 `save.md`의 승인점·안전 규칙·폐기 절차만 실행한다.

별도 삭제 로직을 이 alias에 복제하지 않는다.
