#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_ENTRY="$SCRIPT_DIR/mcp-server/dist/index.js"

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
  echo "  (no args)    설치: MCP 서버 빌드 + 스킬 심링크 + MCP 등록"
  echo "  --uninstall  제거: 심링크 삭제 + MCP 등록 해제"
  exit 0
}

register_mcp() {
  local settings_file="$1"
  local tui_name="$2"

  node -e "
    const fs = require('fs');
    const p = '$settings_file';
    const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    s.mcpServers = s.mcpServers || {};
    s.mcpServers['jhw-notion'] = {
      type: 'stdio',
      command: 'node',
      args: ['$MCP_ENTRY'],
      env: { NOTION_API_KEY: '\${NOTION_API_KEY}' }
    };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  "
  ok "$tui_name: $(basename "$settings_file")에 jhw-notion 서버 추가"
}

register_opencode_mcp() {
  local settings_file="$1"

  node -e "
    const fs = require('fs');
    const p = '$settings_file';
    const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};

    s['$schema'] = s['$schema'] || 'https://opencode.ai/config.json';
    s.mcp = s.mcp || {};
    s.mcp['jhw-notion'] = {
      type: 'local',
      command: ['node', '$MCP_ENTRY'],
      enabled: true
    };

    if (s.mcpServers && s.mcpServers['jhw-notion']) {
      delete s.mcpServers['jhw-notion'];
      if (Object.keys(s.mcpServers).length === 0) {
        delete s.mcpServers;
      }
    }

    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  "
  ok "OpenCode: opencode.json에 jhw-notion 서버 추가"
}

unregister_mcp() {
  local settings_file="$1"
  local tui_name="$2"

  if [ ! -f "$settings_file" ]; then return; fi

  node -e "
    const fs = require('fs');
    const p = '$settings_file';
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s.mcpServers && s.mcpServers['jhw-notion']) {
      delete s.mcpServers['jhw-notion'];
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
    }
  "
  ok "$tui_name: jhw-notion 서버 제거"
}

unregister_opencode_mcp() {
  local settings_file="$1"

  if [ ! -f "$settings_file" ]; then return; fi

  node -e "
    const fs = require('fs');
    const p = '$settings_file';
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    let changed = false;

    if (s.mcp && s.mcp['jhw-notion']) {
      delete s.mcp['jhw-notion'];
      if (Object.keys(s.mcp).length === 0) {
        delete s.mcp;
      }
      changed = true;
    }

    if (s.mcpServers && s.mcpServers['jhw-notion']) {
      delete s.mcpServers['jhw-notion'];
      if (Object.keys(s.mcpServers).length === 0) {
        delete s.mcpServers;
      }
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
    }
  "
  ok "OpenCode: jhw-notion 서버 제거"
}

# --- Uninstall ---
if [ "${1:-}" = "--uninstall" ]; then
  echo "jhw-notion 제거를 시작합니다..."
  echo ""

  echo "[1/2] 스킬 심링크 제거"
  for link in "$HOME/.claude/commands/jhw" "$HOME/.gemini/commands/jhw" "$HOME/.config/opencode/skills/jhw"; do
    if [ -L "$link" ]; then
      rm "$link"
      ok "$(dirname "$link") 심링크 제거"
    fi
  done

  echo "[2/2] MCP 서버 등록 해제"
  unregister_mcp "$HOME/.claude.json" "Claude"
  unregister_mcp "$HOME/.gemini/settings.json" "Gemini"
  unregister_opencode_mcp "$HOME/.config/opencode/opencode.json"

  echo ""
  echo "제거 완료!"
  exit 0
fi

# --- Install ---
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; fi

echo "jhw-notion 설치를 시작합니다..."
echo ""

# [1/4] MCP 서버 빌드
echo "[1/4] MCP 서버 빌드"
cd "$SCRIPT_DIR/mcp-server"
npm install --silent 2>&1 | tail -1
npm run build 2>&1
ok "빌드 완료"
cd "$SCRIPT_DIR"

# [2/4] TUI 감지
echo ""
echo "[2/4] TUI 감지"
CLAUDE_DIR="$HOME/.claude"
GEMINI_DIR="$HOME/.gemini"
OPENCODE_DIR="$HOME/.config/opencode"

[ -d "$CLAUDE_DIR" ] && ok "Claude Code ($CLAUDE_DIR)" || skip "Claude Code (미설치)"
[ -d "$GEMINI_DIR" ] && ok "Gemini CLI ($GEMINI_DIR)" || skip "Gemini CLI (미설치)"
[ -d "$OPENCODE_DIR" ] && ok "OpenCode ($OPENCODE_DIR)" || skip "OpenCode (미설치)"

# [3/4] 스킬 심링크
echo ""
echo "[3/4] 스킬 심링크"
if [ -d "$CLAUDE_DIR" ]; then
  mkdir -p "$CLAUDE_DIR/commands"
  TARGET="$CLAUDE_DIR/commands/jhw"
  if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then
    mv "$TARGET" "$TARGET.bak.$(date +%Y%m%d%H%M%S)"
    ok "Claude: 기존 jhw 디렉토리 백업"
  fi
  [ -L "$TARGET" ] && rm "$TARGET"
  ln -sfn "$SCRIPT_DIR/skills/claude" "$TARGET"
  ok "Claude: $TARGET → $SCRIPT_DIR/skills/claude"
fi
if [ -d "$GEMINI_DIR" ]; then
  mkdir -p "$GEMINI_DIR/commands"
  TARGET="$GEMINI_DIR/commands/jhw"
  if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then
    mv "$TARGET" "$TARGET.bak.$(date +%Y%m%d%H%M%S)"
    ok "Gemini: 기존 jhw 디렉토리 백업"
  fi
  [ -L "$TARGET" ] && rm "$TARGET"
  ln -sfn "$SCRIPT_DIR/skills/claude" "$TARGET"
  ok "Gemini: $TARGET → $SCRIPT_DIR/skills/claude"
fi
if [ -d "$OPENCODE_DIR" ]; then
  mkdir -p "$OPENCODE_DIR/skills"
  TARGET="$OPENCODE_DIR/skills/jhw"
  if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then
    mv "$TARGET" "$TARGET.bak.$(date +%Y%m%d%H%M%S)"
    ok "OpenCode: 기존 jhw 디렉토리 백업"
  fi
  [ -L "$TARGET" ] && rm "$TARGET"
  ln -sfn "$SCRIPT_DIR/skills/claude" "$TARGET"
  ok "OpenCode: $TARGET → $SCRIPT_DIR/skills/claude"
fi

# [4/4] MCP 서버 등록
echo ""
echo "[4/4] MCP 서버 등록"
if [ -d "$CLAUDE_DIR" ]; then
  register_mcp "$HOME/.claude.json" "Claude"
fi
if [ -d "$GEMINI_DIR" ]; then
  register_mcp "$GEMINI_DIR/settings.json" "Gemini"
fi
if [ -d "$OPENCODE_DIR" ]; then
  register_opencode_mcp "$OPENCODE_DIR/opencode.json"
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
