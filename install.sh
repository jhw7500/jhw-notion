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

# config.toml에는 다른 MCP 서버의 시크릿도 들어있다. 백업 사본이 무한히 쌓이지 않도록
# 우리가 만든 것(.bak.YYYYMMDDHHMMSS)만 최근 BACKUP_KEEP개까지 남긴다.
# 다른 도구가 만든 .bak(다른 이름 규칙)은 건드리지 않는다.
BACKUP_KEEP=3

prune_codex_backups() {
  local config_file="$1"
  local dir base
  dir="$(dirname "$config_file")"
  base="$(basename "$config_file")"

  # xargs는 공백이 든 경로를 쪼개 조용히 실패한다. 한 줄씩 그대로 넘긴다.
  find "$dir" -maxdepth 1 -type f -name "$base.bak.*" 2>/dev/null |
    grep -E "\.bak\.[0-9]{14}$" |
    sort -r |
    tail -n +$((BACKUP_KEEP + 1)) |
    while IFS= read -r old; do
      rm -f "$old"
    done
}

# Codex는 JSON이 아니라 ~/.codex/config.toml의 [mcp_servers.<id>] 섹션을 읽는다.
# TOML 파서가 없으므로 섹션 단위로 라인 편집한다(기존 섹션이 있으면 교체, 없으면 추가).
register_codex_mcp() {
  local config_file="$1"

  # 경로를 스크립트에 보간하면 따옴표·역슬래시가 든 경로에서 JS 구문이 깨진다.
  # 환경변수로 넘겨 보간 자체를 없앤다.
  # 내용이 그대로면 백업도 쓰기도 하지 않는다(exit 3) — 재설치마다 사본이 쌓이던 문제.
  if CODEX_CONFIG="$config_file" \
     CODEX_MCP_ENTRY="$MCP_ENTRY" \
     CODEX_BACKUP_STAMP="$(date +%Y%m%d%H%M%S)" \
     node -e "
    const fs = require('fs');
    const p = process.env.CODEX_CONFIG;
    const entry = [
      '[mcp_servers.jhw-notion]',
      'command = \"node\"',
      'args = [' + JSON.stringify(process.env.CODEX_MCP_ENTRY) + ']',
      'startup_timeout_sec = 60.0',
    ];

    const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const lines = src.length ? src.split('\n') : [];
    const start = lines.findIndex((l) => l.trim() === '[mcp_servers.jhw-notion]');

    let out;
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
      while (end > start + 1 && lines[end - 1].trim() === '') end--;   // 섹션 뒤 빈 줄 보존
      out = [...lines.slice(0, start), ...entry, ...lines.slice(end)];
    } else {
      const body = src.replace(/\n+$/, '');
      out = body.length ? [...body.split('\n'), '', ...entry, ''] : [...entry, ''];
    }

    const next = out.join('\n');
    if (next === src) process.exit(3);

    if (src.length) fs.copyFileSync(p, p + '.bak.' + process.env.CODEX_BACKUP_STAMP);
    fs.writeFileSync(p, next);
  "; then
    ok "Codex: config.toml에 jhw-notion 서버 추가"
  else
    local rc=$?
    if [ "$rc" -eq 3 ]; then
      skip "Codex: config.toml 이미 최신 (백업 생성 안 함)"
    else
      fail "Codex: config.toml 갱신 실패"
      exit 1
    fi
  fi

  prune_codex_backups "$config_file"
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

unregister_codex_mcp() {
  local config_file="$1"

  if [ ! -f "$config_file" ]; then return; fi
  if ! grep -q '^\[mcp_servers\.jhw-notion\]' "$config_file"; then return; fi

  # 실제로 섹션이 있을 때만 여기 도달하므로 이 백업은 항상 의미가 있다.
  cp "$config_file" "$config_file.bak.$(date +%Y%m%d%H%M%S)"

  CODEX_CONFIG="$config_file" node -e "
    const fs = require('fs');
    const p = process.env.CODEX_CONFIG;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === '[mcp_servers.jhw-notion]');
    if (start < 0) process.exit(0);

    // [mcp_servers.jhw-notion.env] 같은 자식 테이블도 함께 지운다.
    // 남겨두면 command 없는 jhw-notion 서버가 되살아난다.
    const ours = (l) => {
      const t = l.trim();
      return t === '[mcp_servers.jhw-notion]' || t.startsWith('[mcp_servers.jhw-notion.');
    };

    let end = start + 1;
    while (end < lines.length) {
      if (/^\s*\[/.test(lines[end]) && !ours(lines[end])) break;
      end++;
    }
    fs.writeFileSync(p, [...lines.slice(0, start), ...lines.slice(end)].join('\n'));
  "
  ok "Codex: jhw-notion 서버 제거"

  prune_codex_backups "$config_file"
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
  for link in "$HOME/.claude/commands/jhw" "$HOME/.gemini/commands/jhw" "$HOME/.config/opencode/skills/jhw" "$HOME/.codex/commands/jhw"; do
    if [ -L "$link" ]; then
      rm "$link"
      ok "$(dirname "$link") 심링크 제거"
    fi
  done

  # Codex prompts는 평평한 디렉토리라 파일별 심링크로 깔려 있다.
  # 이 저장소를 가리키는 것만 제거하고 남의 프롬프트는 건드리지 않는다.
  # readlink -f는 BSD(macOS)에 없다. 우리가 만든 링크는 항상 절대 경로라 -f가 필요 없다.
  # 이 저장소를 가리키는 링크만 제거하고 남의 프롬프트/스킬은 건드리지 않는다.
  removed=0
  for link in "$HOME/.codex/prompts"/*.md; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$SCRIPT_DIR"/skills/claude/*) rm "$link"; removed=$((removed + 1)) ;;
    esac
  done
  [ "$removed" -gt 0 ] && ok "$HOME/.codex/prompts 심링크 ${removed}개 제거"

  removed=0
  for link in "$HOME/.codex/skills"/jhw-*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$SCRIPT_DIR"/skills/codex/*) rm "$link"; removed=$((removed + 1)) ;;
    esac
  done
  [ "$removed" -gt 0 ] && ok "$HOME/.codex/skills 심링크 ${removed}개 제거"

  echo "[2/2] MCP 서버 등록 해제"
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
CODEX_DIR="$HOME/.codex"

[ -d "$CLAUDE_DIR" ] && ok "Claude Code ($CLAUDE_DIR)" || skip "Claude Code (미설치)"
[ -d "$GEMINI_DIR" ] && ok "Gemini CLI ($GEMINI_DIR)" || skip "Gemini CLI (미설치)"
[ -d "$OPENCODE_DIR" ] && ok "OpenCode ($OPENCODE_DIR)" || skip "OpenCode (미설치)"
[ -d "$CODEX_DIR" ] && ok "Codex CLI ($CODEX_DIR)" || skip "Codex CLI (미설치)"

# [3/4] 스킬 심링크
echo ""
echo "[3/4] 스킬 심링크"

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
if [ -d "$CODEX_DIR" ]; then
  # Codex는 $CODEX_HOME/skills 의 스킬 디렉토리를 자동 발견한다.
  # (~/.codex/commands/*.toml은 스캔하지 않으므로 예전 TOML 배선은 제거한다.)
  LEGACY="$CODEX_DIR/commands/jhw"
  if [ -L "$LEGACY" ]; then
    rm "$LEGACY"
    ok "Codex: 스캔되지 않는 commands/jhw 배선 제거"
  fi

  mkdir -p "$CODEX_DIR/skills"
  SKILL_BAK=""
  LINKED=0
  for SRC in "$SCRIPT_DIR"/skills/codex/jhw-*; do
    [ -d "$SRC" ] || continue
    NAME="$(basename "$SRC")"
    TARGET="$CODEX_DIR/skills/$NAME"
    # 우리 링크가 아닌 기존 스킬(수동 복사본 등)은 지우지 말고 백업한다.
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
      case "$(readlink "$TARGET" 2>/dev/null)" in
        "$SCRIPT_DIR"/skills/codex/*) : ;;   # 이미 우리 링크 → 그대로 갱신
        *)
          if [ -z "$SKILL_BAK" ]; then
            SKILL_BAK="$CODEX_DIR/skills.bak.$(date +%Y%m%d%H%M%S)"
            mkdir -p "$SKILL_BAK"
          fi
          mv "$TARGET" "$SKILL_BAK/"
          ;;
      esac
    fi
    ln -sfn "$SRC" "$TARGET"
    LINKED=$((LINKED + 1))
  done
  [ -n "$SKILL_BAK" ] && ok "Codex: 기존 jhw 스킬 백업 → $SKILL_BAK"
  ok "Codex: $CODEX_DIR/skills/jhw-* → skills/codex/jhw-* (심링크 ${LINKED}개)"

  # prompts(/prompts:<name>)는 평평한 디렉토리라 파일별 심링크로 깐다.
  # review.md/status.md 같은 흔한 이름이 이미 있으면 남의 프롬프트를 밀어내지 않고 건너뛴다.
  mkdir -p "$CODEX_DIR/prompts"
  PLINKED=0
  PSKIPPED=0
  for SRC in "$SCRIPT_DIR"/skills/claude/*.md; do
    NAME="$(basename "$SRC")"
    [ "$NAME" = "AGENTS.md" ] && continue
    TARGET="$CODEX_DIR/prompts/$NAME"
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
      case "$(readlink "$TARGET" 2>/dev/null)" in
        "$SCRIPT_DIR"/skills/claude/*) : ;;   # 우리 링크 → 갱신
        *) PSKIPPED=$((PSKIPPED + 1)); continue ;;   # 남의 프롬프트 → 보존
      esac
    fi
    ln -sfn "$SRC" "$TARGET"
    PLINKED=$((PLINKED + 1))
  done
  ok "Codex: $CODEX_DIR/prompts/*.md → skills/claude/*.md (심링크 ${PLINKED}개)"
  [ "$PSKIPPED" -gt 0 ] && skip "Codex: 이름이 겹치는 기존 프롬프트 ${PSKIPPED}개는 보존 (스킬 \$jhw-* 로 사용 가능)"
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
