#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_ENTRY="$SCRIPT_DIR/mcp-server/dist/index.js"
CONTROL_ENTRY="$SCRIPT_DIR/mcp-server/dist/control/cli.js"
CONTROL_LINK="$HOME/.local/bin/jhw-control"
CONFIG_EDITOR="$SCRIPT_DIR/scripts/install-config.mjs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { echo -e "  ${GREEN}✅ $1${NC}"; }
skip() { echo -e "  ${YELLOW}⏭️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; }

usage() {
  echo "Usage: $0 [--uninstall]"
  echo "  (no args)    설치: MCP 서버 빌드 + jhw-control/스킬 심링크 + MCP 등록"
  echo "  --uninstall  제거: 이 저장소 소유 심링크 삭제 + MCP 등록 해제"
  exit 0
}

# readlink -f 결과가 저장소 root와 같거나 그 아래일 때만 project-owned로
# 취급한다. 단순 문자열 prefix 비교(`/repo-foreign`)는 허용하지 않는다.
is_repo_owned_symlink() {
  local link="$1"
  local resolved_link resolved_repo
  [ -L "$link" ] || return 1
  resolved_link="$(readlink -f -- "$link" 2>/dev/null)" || return 1
  resolved_repo="$(readlink -f -- "$SCRIPT_DIR" 2>/dev/null)" || return 1
  case "$resolved_link" in
    "$resolved_repo"|"$resolved_repo"/*) return 0 ;;
    *) return 1 ;;
  esac
}

install_control_cli() {
  if [ ! -x "$CONTROL_ENTRY" ]; then
    fail "jhw-control 빌드 결과가 없거나 실행할 수 없습니다: $CONTROL_ENTRY"
    exit 1
  fi

  mkdir -p "$(dirname "$CONTROL_LINK")"
  if [ -e "$CONTROL_LINK" ] || [ -L "$CONTROL_LINK" ]; then
    if is_repo_owned_symlink "$CONTROL_LINK"; then
      rm -- "$CONTROL_LINK"
    else
      fail "$CONTROL_LINK 가 다른 파일/링크입니다. 보존을 위해 설치를 중단합니다."
      exit 1
    fi
  fi
  ln -s "$CONTROL_ENTRY" "$CONTROL_LINK"
  ok "$CONTROL_LINK → $CONTROL_ENTRY"
}

uninstall_control_cli() {
  if is_repo_owned_symlink "$CONTROL_LINK"; then
    rm -- "$CONTROL_LINK"
    ok "$CONTROL_LINK 심링크 제거"
  elif [ -e "$CONTROL_LINK" ] || [ -L "$CONTROL_LINK" ]; then
    skip "$CONTROL_LINK 는 이 저장소 소유가 아니므로 보존"
  fi
}

install_owned_symlink() {
  local target="$1"
  local source="$2"
  local label="$3"
  mkdir -p "$(dirname "$target")"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if is_repo_owned_symlink "$target"; then
      rm -- "$target"
    else
      fail "$label 대상이 다른 파일/링크입니다. 보존을 위해 설치를 중단합니다."
      exit 1
    fi
  fi
  ln -s -- "$source" "$target"
  ok "$label 심링크 설치"
}

uninstall_owned_symlink() {
  local target="$1"
  local label="$2"
  if is_repo_owned_symlink "$target"; then
    rm -- "$target"
    ok "$label 심링크 제거"
  elif [ -e "$target" ] || [ -L "$target" ]; then
    skip "$label 는 이 저장소 소유가 아니므로 보존"
  fi
}

run_config_editor() {
  local operation="$1"
  local settings_file="$2"
  local changed_message="$3"
  local unchanged_message="$4"
  local stamp="${5:-unused}"
  local rc
  case "$operation" in
    register-*) mkdir -p "$(dirname "$settings_file")" ;;
  esac
  if node "$CONFIG_EDITOR" "$operation" "$settings_file" "$MCP_ENTRY" "$SCRIPT_DIR" "$stamp"; then
    CONFIG_EDITOR_CHANGED=1
    ok "$changed_message"
    return
  else
    rc=$?
  fi
  if [ "$rc" -eq 3 ]; then
    CONFIG_EDITOR_CHANGED=0
    skip "$unchanged_message"
    return
  fi
  if [ "$rc" -eq 4 ]; then
    fail "동일 이름의 외부 MCP 등록을 보존하기 위해 설치를 중단합니다."
    exit 1
  fi
  fail "MCP 설정을 안전하게 갱신하지 못했습니다."
  exit 1
}

register_mcp() {
  local settings_file="$1"
  local tui_name="$2"

  run_config_editor \
    "register-stdio" "$settings_file" \
    "$tui_name: jhw-notion 서버 추가" \
    "$tui_name: jhw-notion 서버 이미 최신"
}

register_opencode_mcp() {
  local settings_file="$1"

  run_config_editor \
    "register-opencode" "$settings_file" \
    "OpenCode: jhw-notion 서버 추가" \
    "OpenCode: jhw-notion 서버 이미 최신"
}

# config.toml에는 다른 MCP 서버의 시크릿도 들어있다. 백업 사본이 무한히 쌓이지 않도록
# 우리가 만든 것(.bak.jhw-notion.YYYYMMDDHHMMSS.UUID)만 최근 BACKUP_KEEP개까지 남긴다.
# 다른 도구가 만든 .bak(다른 이름 규칙)은 건드리지 않는다.
BACKUP_KEEP=3

prune_codex_backups() {
  local config_file="$1"
  local dir base
  dir="$(dirname "$config_file")"
  base="$(basename "$config_file")"

  # xargs는 공백이 든 경로를 쪼개 조용히 실패한다. 한 줄씩 그대로 넘긴다.
  while IFS= read -r old; do
    [ -n "$old" ] && rm -f -- "$old"
  done < <(
    find "$dir" -maxdepth 1 -type f -name "$base.bak.jhw-notion.*" 2>/dev/null |
      grep -E "\.bak\.jhw-notion\.[0-9]{14}\.[0-9a-f-]{36}$" |
      sort -r |
      tail -n +$((BACKUP_KEEP + 1))
  )
}

# Codex는 JSON이 아니라 ~/.codex/config.toml의 [mcp_servers.<id>] 섹션을 읽는다.
# TOML 파서가 없으므로 섹션 단위로 라인 편집한다(기존 섹션이 있으면 교체, 없으면 추가).
register_codex_mcp() {
  local config_file="$1"

  run_config_editor \
    "register-codex" "$config_file" \
    "Codex: jhw-notion 서버 추가" \
    "Codex: config.toml 이미 최신 (백업 생성 안 함)" \
    "$(date +%Y%m%d%H%M%S)"
  if [ "$CONFIG_EDITOR_CHANGED" -eq 1 ]; then
    prune_codex_backups "$config_file"
  fi
}

unregister_mcp() {
  local settings_file="$1"
  local tui_name="$2"

  run_config_editor \
    "unregister-stdio" "$settings_file" \
    "$tui_name: jhw-notion 서버 제거" \
    "$tui_name: 소유한 jhw-notion 등록 없음"
}

unregister_codex_mcp() {
  local config_file="$1"

  run_config_editor \
    "unregister-codex" "$config_file" \
    "Codex: jhw-notion 서버 제거" \
    "Codex: 소유한 jhw-notion 등록 없음" \
    "$(date +%Y%m%d%H%M%S)"
  if [ "$CONFIG_EDITOR_CHANGED" -eq 1 ]; then
    prune_codex_backups "$config_file"
  fi
}

unregister_opencode_mcp() {
  local settings_file="$1"

  run_config_editor \
    "unregister-opencode" "$settings_file" \
    "OpenCode: jhw-notion 서버 제거" \
    "OpenCode: 소유한 jhw-notion 등록 없음"
}

# --- Uninstall ---
if [ "${1:-}" = "--uninstall" ]; then
  echo "jhw-notion 제거를 시작합니다..."
  echo ""

  echo "[1/3] jhw-control 심링크 제거"
  uninstall_control_cli

  echo "[2/3] 스킬 심링크 제거"
  uninstall_owned_symlink "$HOME/.claude/commands/jhw" "Claude jhw"
  uninstall_owned_symlink "$HOME/.gemini/commands/jhw" "Gemini jhw"
  uninstall_owned_symlink "$HOME/.config/opencode/skills/jhw" "OpenCode jhw"
  uninstall_owned_symlink "$HOME/.codex/commands/jhw" "Codex legacy jhw"

  # Codex prompts는 평평한 디렉토리라 파일별 심링크로 깔려 있다.
  # 이 저장소를 가리키는 것만 제거하고 남의 프롬프트는 건드리지 않는다.
  # readlink -f는 BSD(macOS)에 없다. 우리가 만든 링크는 항상 절대 경로라 -f가 필요 없다.
  # 이 저장소를 가리키는 링크만 제거하고 남의 프롬프트/스킬은 건드리지 않는다.
  removed=0
  for link in "$HOME/.codex/prompts"/*.md; do
    [ -L "$link" ] || continue
    if is_repo_owned_symlink "$link"; then
      rm -- "$link"
      removed=$((removed + 1))
    fi
  done
  [ "$removed" -gt 0 ] && ok "$HOME/.codex/prompts 심링크 ${removed}개 제거"

  removed=0
  for link in "$HOME/.codex/skills"/jhw-*; do
    [ -L "$link" ] || continue
    if is_repo_owned_symlink "$link"; then
      rm -- "$link"
      removed=$((removed + 1))
    fi
  done
  [ "$removed" -gt 0 ] && ok "$HOME/.codex/skills 심링크 ${removed}개 제거"

  echo "[3/3] MCP 서버 등록 해제"
  unregister_mcp "$HOME/.claude.json" "Claude"
  unregister_mcp "$HOME/.gemini/settings.json" "Gemini"
  unregister_opencode_mcp "$HOME/.config/opencode/opencode.json"
  unregister_codex_mcp "$HOME/.codex/config.toml"

  echo ""
  echo "제거 완료!"
  exit 0
fi

# --- Install ---
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; fi

echo "jhw-notion 설치를 시작합니다..."
echo ""

# [1/5] MCP 서버 빌드
echo "[1/5] MCP 서버 빌드"
cd "$SCRIPT_DIR/mcp-server"
npm install --silent 2>&1 | tail -1
npm run build 2>&1
ok "빌드 완료"
cd "$SCRIPT_DIR"

# [2/5] jhw-control 심링크
echo ""
echo "[2/5] jhw-control 심링크"
install_control_cli

# [3/5] TUI 감지
echo ""
echo "[3/5] TUI 감지"
CLAUDE_DIR="$HOME/.claude"
GEMINI_DIR="$HOME/.gemini"
OPENCODE_DIR="$HOME/.config/opencode"
CODEX_DIR="$HOME/.codex"

[ -d "$CLAUDE_DIR" ] && ok "Claude Code ($CLAUDE_DIR)" || skip "Claude Code (미설치)"
[ -d "$GEMINI_DIR" ] && ok "Gemini CLI ($GEMINI_DIR)" || skip "Gemini CLI (미설치)"
[ -d "$OPENCODE_DIR" ] && ok "OpenCode ($OPENCODE_DIR)" || skip "OpenCode (미설치)"
[ -d "$CODEX_DIR" ] && ok "Codex CLI ($CODEX_DIR)" || skip "Codex CLI (미설치)"

# [4/5] 스킬 심링크
echo ""
echo "[4/5] 스킬 심링크"

# Codex용 TOML은 skills/claude/*.md에서 생성된다 (정본 1개 유지).
# 파이프로 넘기면 종료 코드가 묻히므로, 출력을 받아둔 뒤 실패를 명시적으로 확인한다.
if SYNC_OUT="$(node "$SCRIPT_DIR/scripts/sync-codex-skills.mjs" 2>&1)"; then
  echo "$SYNC_OUT" | sed 's/^/  /'
else
  echo "$SYNC_OUT" | sed 's/^/  /'
  fail "codex 스킬 동기화 실패 — 설치를 중단합니다"
  exit 1
fi

if [ -d "$CLAUDE_DIR" ]; then
  install_owned_symlink "$CLAUDE_DIR/commands/jhw" "$SCRIPT_DIR/skills/claude" "Claude jhw"
fi
if [ -d "$GEMINI_DIR" ]; then
  install_owned_symlink "$GEMINI_DIR/commands/jhw" "$SCRIPT_DIR/skills/claude" "Gemini jhw"
fi
if [ -d "$OPENCODE_DIR" ]; then
  install_owned_symlink "$OPENCODE_DIR/skills/jhw" "$SCRIPT_DIR/skills/claude" "OpenCode jhw"
fi
if [ -d "$CODEX_DIR" ]; then
  # Codex는 $CODEX_HOME/skills 의 스킬 디렉토리를 자동 발견한다.
  # (~/.codex/commands/*.toml은 스캔하지 않으므로 예전 TOML 배선은 제거한다.)
  LEGACY="$CODEX_DIR/commands/jhw"
  if [ -e "$LEGACY" ] || [ -L "$LEGACY" ]; then
    if is_repo_owned_symlink "$LEGACY"; then
      rm -- "$LEGACY"
      ok "Codex: 소유한 legacy commands/jhw 배선 제거"
    else
      fail "Codex legacy commands/jhw가 외부 파일/링크이므로 보존하고 설치를 중단합니다."
      exit 1
    fi
  fi

  mkdir -p "$CODEX_DIR/skills"
  LINKED=0
  for SRC in "$SCRIPT_DIR"/skills/codex/jhw-*; do
    [ -d "$SRC" ] || continue
    NAME="$(basename "$SRC")"
    TARGET="$CODEX_DIR/skills/$NAME"
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
      if is_repo_owned_symlink "$TARGET"; then
        rm -- "$TARGET"
      else
        fail "Codex 스킬 이름 충돌을 보존하기 위해 설치를 중단합니다."
        exit 1
      fi
    fi
    ln -s -- "$SRC" "$TARGET"
    LINKED=$((LINKED + 1))
  done
  ok "Codex: $CODEX_DIR/skills/jhw-* → skills/codex/jhw-* (심링크 ${LINKED}개)"

  # prompts(/prompts:<name>)는 평평한 디렉토리라 파일별 심링크로 깐다.
  # review.md/status.md 같은 흔한 이름이 이미 있으면 남의 프롬프트를 밀어내지 않고 건너뛴다.
  mkdir -p "$CODEX_DIR/prompts"
  PLINKED=0
  for SRC in "$SCRIPT_DIR"/skills/claude/*.md; do
    NAME="$(basename "$SRC")"
    [ "$NAME" = "AGENTS.md" ] && continue
    TARGET="$CODEX_DIR/prompts/$NAME"
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
      if is_repo_owned_symlink "$TARGET"; then
        rm -- "$TARGET"
      else
        fail "Codex 프롬프트 이름 충돌을 보존하기 위해 설치를 중단합니다."
        exit 1
      fi
    fi
    ln -s -- "$SRC" "$TARGET"
    PLINKED=$((PLINKED + 1))
  done
  ok "Codex: $CODEX_DIR/prompts/*.md → skills/claude/*.md (심링크 ${PLINKED}개)"
fi

# [5/5] MCP 서버 등록
echo ""
echo "[5/5] MCP 서버 등록"
if [ -d "$CLAUDE_DIR" ]; then
  register_mcp "$HOME/.claude.json" "Claude"
fi
if [ -d "$GEMINI_DIR" ]; then
  register_mcp "$GEMINI_DIR/settings.json" "Gemini"
fi
if [ -d "$OPENCODE_DIR" ]; then
  register_opencode_mcp "$OPENCODE_DIR/opencode.json"
fi
if [ -d "$CODEX_DIR" ]; then
  register_codex_mcp "$CODEX_DIR/config.toml"
fi

# .env 확인
echo ""
echo "──────────────────────────────────"
echo "설치 완료!"
echo ""
if [ ! -f "$SCRIPT_DIR/mcp-server/.env" ]; then
  echo -e "${YELLOW}⚠️  .env 설정 필요:${NC}"
  echo "  cp $SCRIPT_DIR/mcp-server/.env.example $SCRIPT_DIR/mcp-server/.env"
  echo "  NOTION_API_KEY를 입력하세요"
else
  ok ".env 파일 존재"
fi
echo ""
echo "등록된 MCP 서버:"
echo "  node $MCP_ENTRY"
echo "──────────────────────────────────"
