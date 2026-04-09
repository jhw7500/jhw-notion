<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-09 | Updated: 2026-04-09 -->

# skills

## Purpose
TUI 스킬 정의 파일 컨테이너. install.sh가 이 디렉토리를 각 TUI의 commands/skills 경로에 심링크한다.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `claude/` | Claude Code / Gemini CLI / OpenCode 공용 스킬 10개 (see `claude/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- `claude/` 디렉토리가 여러 TUI에서 공유됨 (심링크). Claude 전용이 아님.
- 스킬 파일은 마크다운 frontmatter (`description`) + 본문 형식.
- 스킬 추가/수정 시 심링크이므로 TUI 재시작 없이 즉시 반영.

<!-- MANUAL: -->
