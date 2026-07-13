<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-09 | Updated: 2026-04-09 -->

# skills

## Purpose
TUI 스킬 정의 파일 컨테이너. install.sh가 이 디렉토리를 각 TUI의 commands/skills 경로에 심링크한다.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `claude/` | **정본.** Claude Code / Gemini CLI / OpenCode 공용 스킬 (see `claude/AGENTS.md`) |
| `codex/jhw-<cmd>/` | **생성물.** Codex 스킬 (`SKILL.md` + `references/<cmd>.md` 심링크). 직접 수정 금지 |

## For AI Agents

### Working In This Directory
- `claude/` 디렉토리가 여러 TUI에서 공유됨 (심링크). Claude 전용이 아님.
- 스킬 파일은 마크다운 frontmatter (`description`) + 본문 형식.
- 스킬 추가/수정 시 심링크이므로 TUI 재시작 없이 즉시 반영.

### codex/ 는 손대지 말 것
- `codex/jhw-<cmd>/`는 `claude/*.md`에서 생성된다 (`AGENTS.md`는 제외).
  - `SKILL.md` — 생성물. Codex가 읽는 스킬 정의.
  - `references/<cmd>.md` — `claude/<cmd>.md`를 가리키는 **심링크**. 본문이 낡을 수 없다.
- 스킬을 고칠 때는 `claude/*.md`만 수정하고 아래를 실행한다:
  ```bash
  node scripts/sync-codex-skills.mjs          # 생성/갱신
  node scripts/sync-codex-skills.mjs --check  # 드리프트 검사 (CI가 이걸 돌린다)
  ```
- `install.sh`가 설치 시 자동으로 재생성하며, PR에서는 `.github/workflows/skills-sync.yml`이 드리프트를 막는다.
- 생성물을 직접 고치면 다음 sync 때 덮어써진다.

### Codex가 실제로 스캔하는 경로
- `~/.codex/skills/jhw-*/` — **자동 발견**. `$jhw-save` 형태로 호출. (install.sh가 심링크)
- `~/.codex/prompts/*.md` — `/prompts:save` 형태로 호출. (install.sh가 심링크, 이름 충돌 시 남의 것 보존)
- `~/.codex/commands/*.toml` — **스캔되지 않는다.** 초기 구현이 여기에 TOML을 깔았으나 폐기했다.

<!-- MANUAL: -->
