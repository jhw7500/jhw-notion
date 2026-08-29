#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$REPO_ROOT/install.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jhw install 'safety.XXXXXX")"
FAKE_BIN="$ROOT/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/npm" <<'EOF'
#!/bin/sh
[ "${JHW_TEST_NPM_FAIL:-0}" = "1" ] && exit 17
exit 0
EOF
chmod +x "$FAKE_BIN/npm"
trap 'rm -rf -- "$ROOT"' EXIT

run_install() {
  local home="$1"
  shift
  if [ "${1:-}" != "--uninstall" ]; then
    provision_valid_control_host "$home"
  fi
  HOME="$home" PATH="$FAKE_BIN:$PATH" bash "$INSTALL" "$@" >"$home/install.log" 2>&1
}

provision_valid_control_host() {
  local home="$1"
  provision_control_host_contract "$home" \
    '{"commands":["unlock","preflight","portfolio status","task start","task child-start","task contract","task completion-ready","task promote","task status","task handoff","task finish","task recover","task assert-owner"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":4}'
}

provision_control_host_contract() {
  local home="$1"
  local contract="$2"
  mkdir -p "$home/.local/bin"
  cat >"$home/.local/bin/jhw-control-host" <<EOF
#!/bin/sh
[ "\$#" -eq 1 ] && [ "\$1" = "--contract" ] || exit 64
printf '%s\\n' '$contract'
EOF
  chmod +x "$home/.local/bin/jhw-control-host"
}

make_tui_roots() {
  local home="$1"
  mkdir -p "$home/.claude" "$home/.gemini" "$home/.config/opencode" "$home/.codex"
}

assert_file_text() {
  local path="$1" expected="$2"
  [ "$(cat -- "$path")" = "$expected" ] || {
    echo "unexpected content: $path" >&2
    return 1
  }
}

test_foreign_skill_fails_closed() {
  local home="$ROOT/foreign-skill-home"
  mkdir -p "$home/.claude/commands/jhw"
  printf 'foreign-marker' >"$home/.claude/commands/jhw/marker"
  if run_install "$home"; then
    echo "foreign canonical skill target was overwritten" >&2
    return 1
  fi
  assert_file_text "$home/.claude/commands/jhw/marker" "foreign-marker"
}

test_every_tui_foreign_target_fails_closed() {
  local label root_relative target_relative kind home target outside
  while IFS='|' read -r label root_relative target_relative kind; do
    home="$ROOT/foreign-$label-home"
    mkdir -p "$home/$root_relative" "$(dirname "$home/$target_relative")"
    target="$home/$target_relative"
    case "$kind" in
      directory) mkdir -p "$target"; printf 'foreign-marker' >"$target/marker" ;;
      file) printf 'foreign-marker' >"$target" ;;
      symlink)
        outside="$ROOT/outside-$label"
        printf 'foreign-marker' >"$outside"
        ln -s "$outside" "$target"
        ;;
    esac
    if run_install "$home"; then
      echo "foreign target was overwritten: $label" >&2
      return 1
    fi
    case "$kind" in
      directory) assert_file_text "$target/marker" "foreign-marker" ;;
      file) assert_file_text "$target" "foreign-marker" ;;
      symlink) [ -L "$target" ] && assert_file_text "$outside" "foreign-marker" ;;
    esac
  done <<'EOF'
claude|.claude|.claude/commands/jhw|directory
gemini|.gemini|.gemini/commands/jhw|symlink
opencode|.config/opencode|.config/opencode/skills/jhw|file
codex-legacy|.codex|.codex/commands/jhw|directory
codex-skill|.codex|.codex/skills/jhw-task|file
codex-prompt|.codex|.codex/prompts/task.md|symlink
EOF
}

test_uninstall_preserves_foreign_links() {
  local home="$ROOT/foreign-links-home" outside="$ROOT/outside"
  make_tui_roots "$home"
  mkdir -p "$outside"
  printf 'outside' >"$outside/target"
  mkdir -p "$home/.claude/commands" "$home/.gemini/commands" \
    "$home/.config/opencode/skills" "$home/.codex/commands" "$home/.codex/skills" "$home/.codex/prompts"
  ln -s "$outside/target" "$home/.claude/commands/jhw"
  ln -s "$outside/target" "$home/.gemini/commands/jhw"
  ln -s "$outside/target" "$home/.config/opencode/skills/jhw"
  ln -s "$outside/target" "$home/.codex/commands/jhw"
  ln -s "$outside/target" "$home/.codex/skills/jhw-task"
  ln -s "$outside/target" "$home/.codex/prompts/task.md"

  run_install "$home" --uninstall

  for link in \
    "$home/.claude/commands/jhw" "$home/.gemini/commands/jhw" \
    "$home/.config/opencode/skills/jhw" "$home/.codex/commands/jhw" \
    "$home/.codex/skills/jhw-task" "$home/.codex/prompts/task.md"; do
    [ -L "$link" ] || { echo "foreign link removed: $link" >&2; return 1; }
  done
  assert_file_text "$outside/target" "outside"
}

test_foreign_json_mcp_fails_closed() {
  local tui home config before
  for tui in claude gemini; do
    home="$ROOT/foreign-json-$tui-home"
    if [ "$tui" = "claude" ]; then
      mkdir -p "$home/.claude"
      config="$home/.claude.json"
    else
      mkdir -p "$home/.gemini"
      config="$home/.gemini/settings.json"
    fi
    printf '%s' '{"keep":true,"mcpServers":{"jhw-notion":{"command":"python","args":["/foreign/server.py"]}}}' >"$config"
    chmod 0640 "$config"
    before="$(sha256sum "$config")"
    if run_install "$home"; then
      echo "foreign JSON MCP entry was overwritten: $tui" >&2
      return 1
    fi
    [ "$(sha256sum "$config")" = "$before" ] || { echo "foreign JSON config changed: $tui" >&2; return 1; }
    [ "$(stat -c '%a' "$config")" = "640" ] || return 1
  done
}

test_foreign_opencode_mcp_fails_closed() {
  local home="$ROOT/foreign-opencode-mcp-home" config before
  mkdir -p "$home/.config/opencode"
  config="$home/.config/opencode/opencode.json"
  printf '%s' '{"keep":true,"mcp":{"jhw-notion":{"type":"local","command":["python","/foreign/server.py"]}}}' >"$config"
  chmod 0640 "$config"
  before="$(sha256sum "$config")"
  if run_install "$home"; then
    echo "foreign OpenCode MCP entry was overwritten" >&2
    return 1
  fi
  [ "$(sha256sum "$config")" = "$before" ] || { echo "foreign OpenCode config changed" >&2; return 1; }
  [ "$(stat -c '%a' "$config")" = "640" ] || return 1
}

test_foreign_toml_mcp_fails_closed() {
  local home="$ROOT/foreign-toml-home" config before
  mkdir -p "$home/.codex"
  config="$home/.codex/config.toml"
  cat >"$config" <<'EOF'
model = "fixture"
[mcp_servers."jhw-notion"] # valid foreign inline comment
command = "python"
args = ["/foreign/server.py"]
EOF
  chmod 0640 "$config"
  before="$(sha256sum "$config")"
  if run_install "$home"; then
    echo "foreign TOML MCP entry was overwritten" >&2
    return 1
  fi
  [ "$(sha256sum "$config")" = "$before" ] || { echo "foreign TOML config changed" >&2; return 1; }
  [ "$(stat -c '%a' "$config")" = "640" ] || return 1
}

test_semantic_toml_mcp_forms_fail_closed() {
  local variant home config before
  for variant in dotted inline unicode parent-table array-table; do
    home="$ROOT/foreign-toml-$variant-home"
    mkdir -p "$home/.codex"
    config="$home/.codex/config.toml"
    case "$variant" in
      dotted)
        cat >"$config" <<'EOF'
mcp_servers.jhw-notion = { command = "python", args = ["/foreign/server.py"] }
EOF
        ;;
      inline)
        cat >"$config" <<'EOF'
mcp_servers = { jhw-notion = { command = "python", args = ["/foreign/server.py"] } }
EOF
        ;;
      unicode)
        cat >"$config" <<'EOF'
[mcp_servers."jhw\U0000002dnotion"]
command = "python"
args = ["/foreign/server.py"]
EOF
        ;;
      parent-table)
        cat >"$config" <<'EOF'
[mcp_servers]
jhw-notion = { command = "python", args = ["/foreign/server.py"] }
EOF
        ;;
      array-table)
        cat >"$config" <<'EOF'
[[mcp_servers.jhw-notion]]
command = "python"
args = ["/foreign/server.py"]
EOF
        ;;
    esac
    before="$(sha256sum "$config")"
    if run_install "$home"; then
      echo "semantic foreign TOML MCP entry was accepted: $variant" >&2
      return 1
    fi
    [ "$(sha256sum "$config")" = "$before" ] || {
      echo "semantic foreign TOML config changed: $variant" >&2
      return 1
    }
  done
}

test_noncontiguous_codex_child_fails_closed() {
  local home="$ROOT/noncontiguous-codex-home" config before
  mkdir -p "$home/.codex"
  config="$home/.codex/config.toml"
  cat >"$config" <<EOF
[mcp_servers.jhw-notion]
command = "node"
args = [$(node -p 'JSON.stringify(process.argv[1])' "$REPO_ROOT/mcp-server/dist/index.js")]

[mcp_servers.other]
command = "node"
args = ["/foreign/other.js"]

[mcp_servers.jhw-notion.env]
FOREIGN = "preserve"
EOF
  before="$(sha256sum "$config")"
  if run_install "$home"; then
    echo "noncontiguous same-name Codex child was accepted" >&2
    return 1
  fi
  [ "$(sha256sum "$config")" = "$before" ] || return 1
}

test_uninstall_preserves_foreign_mcp_configs() {
  local home="$ROOT/foreign-unregister-home" before
  make_tui_roots "$home"
  printf '%s' '{"mcpServers":{"jhw-notion":{"command":"python","args":["/foreign/claude.py"]}}}' >"$home/.claude.json"
  printf '%s' '{"mcpServers":{"jhw-notion":{"command":"python","args":["/foreign/gemini.py"]}}}' >"$home/.gemini/settings.json"
  printf '%s' '{"mcp":{"jhw-notion":{"type":"local","command":["python","/foreign/opencode.py"]}}}' >"$home/.config/opencode/opencode.json"
  cat >"$home/.codex/config.toml" <<'EOF'
[mcp_servers.jhw-notion]
command = "python"
args = ["/foreign/codex.py"]
EOF
  for stamp in 20260101000001 20260101000002 20260101000003 20260101000004; do
    printf 'foreign-backup-%s' "$stamp" >"$home/.codex/config.toml.bak.$stamp"
    printf 'marked-sentinel-%s' "$stamp" >"$home/.codex/config.toml.bak.jhw-notion.$stamp.00000000-0000-4000-8000-${stamp:2}"
  done
  before="$(sha256sum "$home/.claude.json" "$home/.gemini/settings.json" \
    "$home/.config/opencode/opencode.json" "$home/.codex/config.toml" \
    "$home/.codex/config.toml.bak."*)"

  run_install "$home" --uninstall

  [ "$(sha256sum "$home/.claude.json" "$home/.gemini/settings.json" \
    "$home/.config/opencode/opencode.json" "$home/.codex/config.toml" \
    "$home/.codex/config.toml.bak."*)" = "$before" ] || {
    echo "foreign MCP config changed during uninstall" >&2
    return 1
  }
}

test_uninstall_preserves_foreign_config_symlink() {
  local home="$ROOT/foreign-config-symlink-home" outside="$ROOT/foreign-config-symlink"
  mkdir -p "$home/.config/opencode"
  printf '%s' '{"mcp":{"jhw-notion":{"command":["python","/foreign.py"]}}}' >"$outside"
  ln -s "$outside" "$home/.config/opencode/opencode.json"
  run_install "$home" --uninstall
  [ -L "$home/.config/opencode/opencode.json" ] || return 1
  assert_file_text "$outside" '{"mcp":{"jhw-notion":{"command":["python","/foreign.py"]}}}'
}

test_atomic_config_syncs_mode_before_content() {
  local home="$ROOT/atomic-order-home" hook="$ROOT/fs-order-hook.cjs" log="$ROOT/fs-order.log"
  mkdir -p "$home/.gemini"
  cat >"$hook" <<'EOF'
const fs = require("node:fs");
for (const name of ["fchmodSync", "fsyncSync"]) {
  const original = fs[name];
  fs[name] = (...args) => {
    require("node:fs").appendFileSync(process.env.JHW_FS_ORDER_LOG, `${name}\n`);
    return original(...args);
  };
}
EOF
  : >"$log"
  NODE_OPTIONS="--require \"$hook\"" JHW_FS_ORDER_LOG="$log" node "$REPO_ROOT/scripts/install-config.mjs" \
    register-stdio "$home/.gemini/settings.json" "$REPO_ROOT/mcp-server/dist/index.js" "$REPO_ROOT" unused
  [ "$(sed -n '1p' "$log")" = "fchmodSync" ] || {
    echo "config content was synced before its preserved mode" >&2
    cat "$log" >&2
    return 1
  }
}

test_npm_pipeline_failure_stops_install() {
  local home="$ROOT/npm-failure-home"
  mkdir -p "$home"
  provision_valid_control_host "$home"
  if HOME="$home" PATH="$FAKE_BIN:$PATH" JHW_TEST_NPM_FAIL=1 bash "$INSTALL" >"$home/install.log" 2>&1; then
    echo "npm pipeline failure was masked" >&2
    return 1
  fi
  [ ! -e "$home/.local/bin/jhw-control" ] && [ ! -L "$home/.local/bin/jhw-control" ] || return 1
}

test_missing_control_host_fails_before_activation() {
  local home="$ROOT/missing-control-host-home"
  make_tui_roots "$home"

  if HOME="$home" PATH="$FAKE_BIN:$PATH" bash "$INSTALL" >"$home/install.log" 2>&1; then
    echo "missing jhw-control-host contract was accepted" >&2
    return 1
  fi

  [ ! -e "$home/.local/bin/jhw-control" ] && [ ! -L "$home/.local/bin/jhw-control" ] || return 1
  [ ! -e "$home/.claude/commands/jhw" ] && [ ! -L "$home/.claude/commands/jhw" ] || return 1
  [ ! -e "$home/.codex/skills/jhw-task" ] && [ ! -L "$home/.codex/skills/jhw-task" ] || return 1
  [ ! -e "$home/.claude.json" ] || return 1
  [ ! -e "$home/.codex/config.toml" ] || return 1
}

test_non_v4_control_host_contract_fails_before_activation() {
  local label home contract
  while IFS='|' read -r label contract; do
    home="$ROOT/invalid-control-host-$label-home"
    make_tui_roots "$home"
    provision_control_host_contract "$home" "$contract"

    if HOME="$home" PATH="$FAKE_BIN:$PATH" bash "$INSTALL" >"$home/install.log" 2>&1; then
      echo "non-v4 jhw-control-host contract was accepted: $label" >&2
      return 1
    fi

    [ ! -e "$home/.local/bin/jhw-control" ] && [ ! -L "$home/.local/bin/jhw-control" ] || return 1
    [ ! -e "$home/.claude/commands/jhw" ] && [ ! -L "$home/.claude/commands/jhw" ] || return 1
    [ ! -e "$home/.codex/skills/jhw-task" ] && [ ! -L "$home/.codex/skills/jhw-task" ] || return 1
    [ ! -e "$home/.claude.json" ] || return 1
    [ ! -e "$home/.codex/config.toml" ] || return 1
  done <<'EOF'
former-v3|{"commands":["unlock","preflight","portfolio status","task start","task finish"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":3}
unsafe-policy|{"commands":["unlock","preflight","portfolio status","task start","task child-start","task contract","task completion-ready","task promote","task status","task handoff","task finish","task recover","task assert-owner"],"credential_policy":"environment-fallback","name":"jhw-control-host","version":4}
missing-lifecycle-command|{"commands":["unlock","preflight","portfolio status","task start","task child-start","task contract","task completion-ready","task promote","task status","task handoff","task recover","task assert-owner"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":4}
extra-command|{"commands":["unlock","preflight","portfolio status","task start","task child-start","task contract","task completion-ready","task promote","task status","task handoff","task finish","task recover","task assert-owner","task unsupported"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":4}
malformed|not-json
EOF
}

test_empty_uninstall_creates_nothing() {
  local home="$ROOT/empty-uninstall-home"
  mkdir -p "$home"
  run_install "$home" --uninstall
  [ "$(find "$home" -mindepth 1 ! -name install.log -print -quit)" = "" ] || {
    echo "empty uninstall created installation state" >&2
    return 1
  }
}

test_owned_round_trip() {
  local home="$ROOT/round trip 'home" json codex first_hash
  make_tui_roots "$home"
  mkdir -p "$home/.codex/commands" "$home/.codex/prompts"
  printf 'foreign-unrelated' >"$home/.codex/prompts/unrelated.md"
  printf '%s' '{"keep":"claude"}' >"$home/.claude.json"
  printf '%s' '{"keep":"gemini"}' >"$home/.gemini/settings.json"
  printf '%s' '{"keep":"opencode"}' >"$home/.config/opencode/opencode.json"
  printf 'model = "fixture"\n' >"$home/.codex/config.toml"
  chmod 0640 "$home/.claude.json" "$home/.gemini/settings.json" \
    "$home/.config/opencode/opencode.json" "$home/.codex/config.toml"
  ln -s "$REPO_ROOT/skills/claude" "$home/.codex/commands/jhw"

  run_install "$home"
  for config in "$home/.claude.json" "$home/.gemini/settings.json" \
    "$home/.config/opencode/opencode.json" "$home/.codex/config.toml"; do
    [ "$(stat -c '%a' "$config")" = "640" ] || { echo "config mode changed: $config" >&2; return 1; }
  done
  [ ! -e "$home/.codex/commands/jhw" ] && [ ! -L "$home/.codex/commands/jhw" ] || {
    echo "owned Codex legacy link survived install" >&2
    return 1
  }
  for link in "$home/.claude/commands/jhw" "$home/.gemini/commands/jhw" "$home/.config/opencode/skills/jhw"; do
    [ -L "$link" ] || { echo "owned skill link missing: $link" >&2; return 1; }
  done
  [ -L "$home/.codex/skills/jhw-task" ] || return 1
  [ -L "$home/.codex/prompts/task.md" ] || return 1
  assert_file_text "$home/.codex/prompts/unrelated.md" "foreign-unrelated"
  json="$home/.gemini/settings.json"
  codex="$home/.codex/config.toml"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.mcpServers["jhw-notion"].command!=="node") process.exit(1)' "$home/.claude.json"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.mcpServers["jhw-notion"].command!=="node") process.exit(1)' "$json"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s["$schema"]!=="https://opencode.ai/config.json" || s.mcp["jhw-notion"].command[0]!=="node") process.exit(1)' "$home/.config/opencode/opencode.json"
  grep -q '^command = "node"$' "$codex"
  first_hash="$(sha256sum "$home/.claude.json" "$json" "$home/.config/opencode/opencode.json" "$codex")"

  run_install "$home"
  [ "$(sha256sum "$home/.claude.json" "$json" "$home/.config/opencode/opencode.json" "$codex")" = "$first_hash" ] || {
    echo "idempotent reinstall changed config bytes" >&2
    return 1
  }

  run_install "$home" --uninstall
  for link in \
    "$home/.local/bin/jhw-control" "$home/.claude/commands/jhw" "$home/.gemini/commands/jhw" \
    "$home/.config/opencode/skills/jhw" "$home/.codex/skills/jhw-task" "$home/.codex/prompts/task.md"; do
    [ ! -e "$link" ] && [ ! -L "$link" ] || { echo "owned link survived uninstall: $link" >&2; return 1; }
  done
  assert_file_text "$home/.codex/prompts/unrelated.md" "foreign-unrelated"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.keep!=="claude" || s.mcpServers?.["jhw-notion"]) process.exit(1)' "$home/.claude.json"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.keep!=="gemini" || s.mcpServers?.["jhw-notion"]) process.exit(1)' "$json"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.keep!=="opencode" || s.mcp?.["jhw-notion"] || s.mcpServers?.["jhw-notion"]) process.exit(1)' "$home/.config/opencode/opencode.json"
  if grep -q '^\[mcp_servers\.jhw-notion\]' "$codex"; then
    echo "owned Codex MCP entry survived uninstall" >&2
    return 1
  fi
  grep -q '^model = "fixture"$' "$codex"
  for config in "$home/.claude.json" "$json" "$home/.config/opencode/opencode.json" "$codex"; do
    [ "$(stat -c '%a' "$config")" = "640" ] || { echo "config mode changed after uninstall: $config" >&2; return 1; }
  done

  run_install "$home"
  [ -L "$home/.local/bin/jhw-control" ] || return 1
  [ -L "$home/.claude/commands/jhw" ] || return 1
  [ -L "$home/.gemini/commands/jhw" ] || return 1
  [ -L "$home/.config/opencode/skills/jhw" ] || return 1
  [ -L "$home/.codex/skills/jhw-task" ] || return 1
  [ -L "$home/.codex/prompts/task.md" ] || return 1
  [ ! -e "$home/.codex/commands/jhw" ] && [ ! -L "$home/.codex/commands/jhw" ] || return 1
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.mcpServers["jhw-notion"].command!=="node") process.exit(1)' "$home/.claude.json"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.mcpServers["jhw-notion"].command!=="node") process.exit(1)' "$json"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s["$schema"]!=="https://opencode.ai/config.json" || s.mcp["jhw-notion"].command[0]!=="node") process.exit(1)' "$home/.config/opencode/opencode.json"
  grep -q '^command = "node"$' "$codex"
  for config in "$home/.claude.json" "$json" "$home/.config/opencode/opencode.json" "$codex"; do
    [ "$(stat -c '%a' "$config")" = "640" ] || { echo "config mode changed after reinstall: $config" >&2; return 1; }
  done
}

test_foreign_skill_fails_closed
test_every_tui_foreign_target_fails_closed
test_uninstall_preserves_foreign_links
test_foreign_json_mcp_fails_closed
test_foreign_opencode_mcp_fails_closed
test_foreign_toml_mcp_fails_closed
test_semantic_toml_mcp_forms_fail_closed
test_noncontiguous_codex_child_fails_closed
test_uninstall_preserves_foreign_mcp_configs
test_uninstall_preserves_foreign_config_symlink
test_atomic_config_syncs_mode_before_content
test_npm_pipeline_failure_stops_install
test_missing_control_host_fails_before_activation
test_empty_uninstall_creates_nothing
test_owned_round_trip
test_non_v4_control_host_contract_fails_before_activation
node "$REPO_ROOT/scripts/test-ship-skill-contract.mjs"
node "$REPO_ROOT/scripts/test-task-skill-contract.mjs"
echo "installer safety: ok"
