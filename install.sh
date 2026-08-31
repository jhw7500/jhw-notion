#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_ENTRY="$SCRIPT_DIR/mcp-server/dist/index.js"
CONTROL_ENTRY="$SCRIPT_DIR/mcp-server/dist/control/cli.js"
CONTROL_LINK="$HOME/.local/bin/jhw-control"
HOST_LAUNCHER="$HOME/.local/bin/jhw-control-host"
CONTROL_HOOK_ENTRY="$SCRIPT_DIR/scripts/jhw-control-hook"
CONTROL_HOOK_LINK="$HOME/.local/bin/jhw-control-hook"
CONFIG_EDITOR="$SCRIPT_DIR/scripts/install-config.mjs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { echo -e "  ${GREEN}✅ $1${NC}"; }
skip() { echo -e "  ${YELLOW}⏭️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; }

require_control_host() {
  local contract
  if [ ! -x "$HOST_LAUNCHER" ]; then
    fail "jhw-control-host v4가 필요합니다. claude-config/install.sh를 먼저 실행하세요."
    exit 1
  fi
  if ! contract="$("$HOST_LAUNCHER" --contract 2>/dev/null)"; then
    fail "jhw-control-host 계약을 확인할 수 없습니다. claude-config/install.sh를 다시 실행하세요."
    exit 1
  fi
  if ! JHW_CONTROL_HOST_CONTRACT="$contract" node -e '
    const { isDeepStrictEqual } = require("node:util");
    const expected = {
      commands: ["unlock", "preflight", "portfolio status", "task start", "task child-start", "task contract", "task completion-ready", "task promote", "task status", "task handoff", "task finish", "task recover", "task assert-owner"],
      credential_policy: "secure-store-only",
      name: "jhw-control-host",
      version: 4,
    };
    let actual;
    try {
      actual = JSON.parse(process.env.JHW_CONTROL_HOST_CONTRACT);
    } catch {
      process.exit(1);
    }
    process.exit(isDeepStrictEqual(actual, expected) ? 0 : 1);
  '; then
    fail "jhw-control-host v4 secure-store-only 계약이 필요합니다. claude-config/install.sh를 다시 실행하세요."
    exit 1
  fi
}

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

HOOK_LINK_CREATED=0
INSTALL_TRANSACTION_ACTIVE=0
HOOKS_CONFIG_CHANGED=0
HOOKS_CONFIG_FILE=""
HOOKS_TRANSACTION_DIR=""
HOOKS_TRANSACTION_STAGE=""
HOOKS_TRANSACTION_METADATA=""
HOOKS_TRANSACTION_PRESERVE=0
CONTROL_HOOK_LINK_TRANSACTION_DIR=""
CONTROL_HOOK_LINK_TRANSACTION_STAGE=""
CONTROL_HOOK_LINK_TRANSACTION_METADATA=""
CONTROL_HOOK_LINK_TRANSACTION_PRESERVE=0
CONTROL_HOOK_LINK_REMOVE_OUTCOME=""
INSTALL_UNPROTECTED=0

validate_control_artifacts() {
  if [ ! -x "$CONTROL_ENTRY" ]; then
    fail "jhw-control 빌드 결과가 없거나 실행할 수 없습니다: $CONTROL_ENTRY"
    exit 1
  fi
  if [ ! -x "$CONTROL_HOOK_ENTRY" ]; then
    fail "jhw-control-hook 실행 파일이 없거나 실행할 수 없습니다: $CONTROL_HOOK_ENTRY"
    exit 1
  fi
  if { [ -e "$CONTROL_LINK" ] || [ -L "$CONTROL_LINK" ]; } && ! is_repo_owned_symlink "$CONTROL_LINK"; then
    fail "$CONTROL_LINK 가 다른 파일/링크입니다. 보존을 위해 설치를 중단합니다."
    exit 1
  fi
  if [ -e "$CONTROL_HOOK_LINK" ] || [ -L "$CONTROL_HOOK_LINK" ]; then
    if ! { [ -L "$CONTROL_HOOK_LINK" ] &&
           [ "$(readlink -- "$CONTROL_HOOK_LINK" 2>/dev/null)" = "$CONTROL_HOOK_ENTRY" ]; }; then
      fail "$CONTROL_HOOK_LINK 가 다른 파일/링크입니다. 보존을 위해 설치를 중단합니다."
      exit 1
    fi
  fi
}

install_control_hook() {
  if [ ! -x "$CONTROL_HOOK_ENTRY" ]; then
    fail "jhw-control-hook 실행 파일이 없거나 실행할 수 없습니다: $CONTROL_HOOK_ENTRY"
    exit 1
  fi
  mkdir -p "$(dirname "$CONTROL_HOOK_LINK")"
  if [ -e "$CONTROL_HOOK_LINK" ] || [ -L "$CONTROL_HOOK_LINK" ]; then
    if [ -L "$CONTROL_HOOK_LINK" ] &&
       [ "$(readlink -- "$CONTROL_HOOK_LINK" 2>/dev/null)" = "$CONTROL_HOOK_ENTRY" ]; then
      HOOK_LINK_CREATED=0
      skip "$CONTROL_HOOK_LINK 이미 최신"
      return
    fi
    fail "$CONTROL_HOOK_LINK 가 다른 파일/링크입니다. 보존을 위해 설치를 중단합니다."
    exit 1
  fi
  ln -s -- "$CONTROL_HOOK_ENTRY" "$CONTROL_HOOK_LINK"
  HOOK_LINK_CREATED=1
  ok "$CONTROL_HOOK_LINK → $CONTROL_HOOK_ENTRY"
}

rollback_new_control_hook() {
  [ "$HOOK_LINK_CREATED" -eq 1 ] || return 0
  if [ -n "$CONTROL_HOOK_LINK_TRANSACTION_DIR" ]; then
    report_control_hook_link_transaction
    return 1
  fi
  if ! remove_control_hook_link_transaction; then
    fail "새 hook launcher 제거를 안전하게 확인하지 못했습니다."
    return 1
  fi
  HOOK_LINK_CREATED=0
}

allocate_control_hook_link_transaction() {
  local directory
  directory="$(dirname "$CONTROL_HOOK_LINK")"
  CONTROL_HOOK_LINK_TRANSACTION_STAGE=""
  CONTROL_HOOK_LINK_TRANSACTION_METADATA=""
  CONTROL_HOOK_LINK_TRANSACTION_PRESERVE=0
  CONTROL_HOOK_LINK_REMOVE_OUTCOME=""
  CONTROL_HOOK_LINK_TRANSACTION_DIR="$(mktemp -d "$directory/.jhw-control-hook-link-txn.XXXXXX")"
  chmod 0700 "$CONTROL_HOOK_LINK_TRANSACTION_DIR"
}

inspect_control_hook_link_transaction() {
  [ -n "$CONTROL_HOOK_LINK_TRANSACTION_DIR" ] || return 1
  if ! CONTROL_HOOK_LINK_TRANSACTION_METADATA="$(node "$CONFIG_EDITOR" \
      "inspect-control-hook-link-transaction" "$CONTROL_HOOK_LINK" "$CONTROL_HOOK_ENTRY" \
      "$SCRIPT_DIR" "$CONTROL_HOOK_LINK_TRANSACTION_DIR" 2>/dev/null)"; then
    return 1
  fi
  CONTROL_HOOK_LINK_TRANSACTION_STAGE="$(node -e '
    const value = JSON.parse(process.argv[1]);
    if (!value || typeof value.stage !== "string") process.exit(1);
    process.stdout.write(value.stage);
  ' "$CONTROL_HOOK_LINK_TRANSACTION_METADATA" 2>/dev/null)"
}

report_control_hook_link_transaction() {
  if [ ! -e "$CONTROL_HOOK_LINK_TRANSACTION_DIR" ] && [ ! -L "$CONTROL_HOOK_LINK_TRANSACTION_DIR" ]; then
    fail "hook launcher transaction evidence was removed; parent-directory durability is unconfirmed"
    return
  fi
  fail "private hook launcher transaction path: $CONTROL_HOOK_LINK_TRANSACTION_DIR"
  if inspect_control_hook_link_transaction; then
    fail "hook launcher transaction metadata: $CONTROL_HOOK_LINK_TRANSACTION_METADATA"
  else
    fail "hook launcher transaction metadata를 안전하게 확인할 수 없습니다. evidence를 보존합니다."
  fi
}

report_control_hook_link_manual_recovery() {
  local evidence="$CONTROL_HOOK_LINK_TRANSACTION_DIR/captured-link"
  CONTROL_HOOK_LINK_TRANSACTION_PRESERVE=1
  fail "manual recovery required"
  if [ -L "$evidence" ]; then
    fail "preserved recovery object: $evidence"
  elif [ -d "$evidence" ]; then
    fail "preserved subtree: $evidence"
  elif [ -e "$evidence" ]; then
    fail "preserved recovery object: $evidence"
  else
    fail "captured launcher evidence is unknown or absent"
  fi
  if [ -L "$CONTROL_HOOK_LINK" ]; then
    fail "live hook launcher currently contains a symlink; captured restoration is unconfirmed"
  elif [ -d "$CONTROL_HOOK_LINK" ]; then
    fail "live hook launcher currently contains a directory; captured restoration is unconfirmed"
  elif [ -e "$CONTROL_HOOK_LINK" ]; then
    fail "live hook launcher currently contains an object; captured restoration is unconfirmed"
  else
    fail "live hook launcher is unknown or absent; captured restoration is unconfirmed"
  fi
  report_control_hook_link_transaction
}

finalize_control_hook_link_transaction() {
  local expected_stage="$1" rc
  if node "$CONFIG_EDITOR" "finalize-control-hook-link-transaction" \
      "$CONTROL_HOOK_LINK" "$CONTROL_HOOK_ENTRY" "$SCRIPT_DIR" \
      "$CONTROL_HOOK_LINK_TRANSACTION_DIR" "$expected_stage" 2>/dev/null; then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -eq 7 ]; then
    fail "hook launcher transaction evidence was removed; parent-directory durability is unconfirmed"
    return 7
  fi
  [ "$rc" -eq 0 ] || return "$rc"
  CONTROL_HOOK_LINK_TRANSACTION_DIR=""
  CONTROL_HOOK_LINK_TRANSACTION_STAGE=""
  CONTROL_HOOK_LINK_TRANSACTION_METADATA=""
}

remove_control_hook_link_transaction() {
  local rc
  allocate_control_hook_link_transaction
  if node "$CONFIG_EDITOR" "remove-control-hook-link-transaction" \
      "$CONTROL_HOOK_LINK" "$CONTROL_HOOK_ENTRY" "$SCRIPT_DIR" \
      "$CONTROL_HOOK_LINK_TRANSACTION_DIR" 2>/dev/null; then
    rc=0
  else
    rc=$?
  fi
  if ! inspect_control_hook_link_transaction; then
    CONTROL_HOOK_LINK_TRANSACTION_PRESERVE=1
    fail "hook launcher removal transaction을 안전하게 확인하지 못했습니다. live 상태는 확인되지 않았습니다."
    report_control_hook_link_transaction
    return 1
  fi
  case "$CONTROL_HOOK_LINK_TRANSACTION_STAGE" in
    removed-owned)
      CONTROL_HOOK_LINK_REMOVE_OUTCOME="removed"
      ;;
    unchanged-absent)
      CONTROL_HOOK_LINK_REMOVE_OUTCOME="absent"
      ;;
    foreign-untouched|foreign-republished)
      CONTROL_HOOK_LINK_REMOVE_OUTCOME="foreign"
      ;;
    manual-recovery-required)
      report_control_hook_link_manual_recovery
      return 1
      ;;
    *)
      CONTROL_HOOK_LINK_TRANSACTION_PRESERVE=1
      fail "hook launcher removal은 recovery가 필요한 상태입니다 (rc=$rc, stage=$CONTROL_HOOK_LINK_TRANSACTION_STAGE)."
      report_control_hook_link_transaction
      return 1
      ;;
  esac
  if ! finalize_control_hook_link_transaction "$CONTROL_HOOK_LINK_TRANSACTION_STAGE"; then
    CONTROL_HOOK_LINK_TRANSACTION_PRESERVE=1
    fail "확인된 hook launcher transaction evidence 정리에 실패했습니다."
    report_control_hook_link_transaction
    return 1
  fi
}

allocate_codex_hook_transaction() {
  local hooks_file="$1" directory
  HOOKS_CONFIG_FILE="$hooks_file"
  HOOKS_CONFIG_CHANGED=0
  HOOKS_TRANSACTION_STAGE=""
  HOOKS_TRANSACTION_METADATA=""
  HOOKS_TRANSACTION_PRESERVE=0
  directory="$(dirname "$hooks_file")"
  mkdir -p "$directory"
  HOOKS_TRANSACTION_DIR="$(mktemp -d "$directory/.hooks.json.jhw-txn.XXXXXX")"
  chmod 0700 "$HOOKS_TRANSACTION_DIR"
}

reject_stale_codex_hook_transactions() {
  local candidate found=0
  [ -d "$HOME/.codex" ] || return 0
  for candidate in "$HOME/.codex"/.hooks.json.jhw-txn.*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    if [ "$found" -eq 0 ]; then
      fail "abandoned Codex hook transaction evidence blocks this operation: $candidate"
    else
      fail "additional abandoned Codex hook transaction evidence: $candidate"
    fi
    found=1
  done
  if [ "$found" -eq 1 ]; then
    fail "Review and recover/remove the private transaction path before retrying; its contents were not printed."
    return 1
  fi
}

reject_stale_control_hook_link_transactions() {
  local candidate found=0 directory
  directory="$(dirname "$CONTROL_HOOK_LINK")"
  [ -d "$directory" ] || return 0
  for candidate in "$directory"/.jhw-control-hook-link-txn.*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    if [ "$found" -eq 0 ]; then
      fail "abandoned hook launcher transaction evidence blocks this operation: $candidate"
    else
      fail "additional abandoned hook launcher transaction evidence: $candidate"
    fi
    found=1
  done
  if [ "$found" -eq 1 ]; then
    fail "Review and recover/remove the private launcher transaction path before retrying; its contents were not printed."
    return 1
  fi
}

inspect_codex_hook_transaction() {
  [ -n "$HOOKS_TRANSACTION_DIR" ] || return 1
  if ! HOOKS_TRANSACTION_METADATA="$(node "$CONFIG_EDITOR" "inspect-codex-hooks-transaction" \
      "$HOOKS_CONFIG_FILE" "$MCP_ENTRY" "$SCRIPT_DIR" "$HOOKS_TRANSACTION_DIR" 2>/dev/null)"; then
    return 1
  fi
  HOOKS_TRANSACTION_STAGE="$(node -e '
    const value = JSON.parse(process.argv[1]);
    if (!value || typeof value.stage !== "string") process.exit(1);
    process.stdout.write(value.stage);
  ' "$HOOKS_TRANSACTION_METADATA" 2>/dev/null)"
}

report_codex_hook_transaction() {
  if [ ! -e "$HOOKS_TRANSACTION_DIR" ] && [ ! -L "$HOOKS_TRANSACTION_DIR" ]; then
    fail "transaction evidence was removed; parent-directory durability is unconfirmed"
    return
  fi
  fail "private hook transaction path: $HOOKS_TRANSACTION_DIR"
  if inspect_codex_hook_transaction; then
    fail "transaction metadata: $HOOKS_TRANSACTION_METADATA"
  else
    fail "transaction metadata를 안전하게 확인할 수 없습니다. directory를 그대로 보존합니다."
  fi
}

report_durable_manual_hook_recovery() {
  local evidence_path="$HOOKS_TRANSACTION_DIR/$1"
  [ "$HOOKS_TRANSACTION_STAGE" = "manual-recovery-required" ] || return 1
  [ -e "$evidence_path" ] || [ -L "$evidence_path" ] || return 1

  HOOKS_TRANSACTION_PRESERVE=1
  fail "manual recovery required"
  if [ -L "$evidence_path" ]; then
    fail "preserved recovery object: $evidence_path"
  elif [ -d "$evidence_path" ]; then
    fail "preserved subtree: $evidence_path"
  else
    fail "preserved recovery object: $evidence_path"
  fi

  if [ -L "$HOOKS_CONFIG_FILE" ]; then
    fail "live hooks path currently contains a symlink; restoration is unconfirmed"
  elif [ -d "$HOOKS_CONFIG_FILE" ]; then
    fail "live hooks path currently contains a directory; restoration is unconfirmed"
  elif [ -e "$HOOKS_CONFIG_FILE" ]; then
    fail "live hooks path currently contains an object; restoration is unconfirmed"
  else
    fail "live hooks path is unknown or absent; it was not restored"
  fi
  report_codex_hook_transaction
  fail "repository hook launcher는 수동 복구가 끝날 때까지 보존합니다."
}

finalize_codex_hook_transaction() {
  local expected_stage="$1" rc
  [ -n "$HOOKS_TRANSACTION_DIR" ] || return 0
  if node "$CONFIG_EDITOR" "finalize-codex-hooks-transaction" "$HOOKS_CONFIG_FILE" \
      "$MCP_ENTRY" "$SCRIPT_DIR" "$HOOKS_TRANSACTION_DIR" "$expected_stage" 2>/dev/null; then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -eq 7 ]; then
    fail "transaction evidence was removed; parent-directory durability is unconfirmed"
    return 7
  fi
  [ "$rc" -eq 0 ] || return "$rc"
  HOOKS_TRANSACTION_DIR=""
  HOOKS_TRANSACTION_STAGE=""
  HOOKS_TRANSACTION_METADATA=""
}

rollback_codex_hooks() {
  local rc
  [ "$HOOKS_CONFIG_CHANGED" -eq 1 ] && [ "$HOOKS_TRANSACTION_PRESERVE" -eq 0 ] || return 1
  if node "$CONFIG_EDITOR" "rollback-codex-hooks-transaction" "$HOOKS_CONFIG_FILE" \
      "$MCP_ENTRY" "$SCRIPT_DIR" "$HOOKS_TRANSACTION_DIR" 2>/dev/null; then
    rc=0
  else
    rc=$?
  fi
  if ! inspect_codex_hook_transaction; then
    fail "Codex hooks.json rollback 결과를 확인할 수 없습니다. current path를 단정하지 않습니다."
    report_codex_hook_transaction
    return 1
  fi
  if report_durable_manual_hook_recovery "candidate-live"; then
    return 1
  fi
  if [ "$rc" -eq 0 ] && [ "$HOOKS_TRANSACTION_STAGE" = "rollback-restored" ]; then
    if ! finalize_codex_hook_transaction "rollback-restored"; then
      fail "확인된 rollback의 private evidence 정리에 실패했습니다."
      report_codex_hook_transaction
      return 1
    fi
    HOOKS_CONFIG_CHANGED=0
    return 0
  fi
  if [ "$HOOKS_TRANSACTION_STAGE" = "rollback-capture-intent" ] &&
     { [ -e "$HOOKS_TRANSACTION_DIR/candidate-live" ] || [ -L "$HOOKS_TRANSACTION_DIR/candidate-live" ]; }; then
    fail "rollback candidate durability/recovery is incomplete (rc=$rc)."
    if [ -L "$HOOKS_TRANSACTION_DIR/candidate-live" ]; then
      fail "preserved recovery object: $HOOKS_TRANSACTION_DIR/candidate-live"
    elif [ -d "$HOOKS_TRANSACTION_DIR/candidate-live" ]; then
      fail "preserved subtree: $HOOKS_TRANSACTION_DIR/candidate-live"
    else
      fail "preserved recovery object: $HOOKS_TRANSACTION_DIR/candidate-live"
    fi
    fail "live hooks path is unknown or absent; it was not restored"
    report_codex_hook_transaction
    fail "repository hook launcher는 수동 검토가 끝날 때까지 보존합니다."
    return 1
  fi
  if [ "$HOOKS_TRANSACTION_STAGE" = "rollback-capture-recovered" ]; then
    fail "rollback candidate state was recovered without clobbering, but original rollback did not complete (rc=$rc)."
    fail "preserved rollback candidate: $HOOKS_TRANSACTION_DIR/candidate-live"
    report_codex_hook_transaction
    fail "repository hook launcher는 수동 검토가 끝날 때까지 보존합니다."
    return 1
  fi
  fail "Codex hooks.json rollback이 concurrent/ambiguous 상태로 끝났습니다 (rc=$rc). current path를 단정하지 않습니다."
  report_codex_hook_transaction
  fail "repository hook launcher는 수동 검토가 끝날 때까지 보존합니다."
  return 1
}

rollback_install_transaction_on_exit() {
  local rc=$? hooks_rollback_ok=1
  if [ "$rc" -ne 0 ] && [ "$INSTALL_TRANSACTION_ACTIVE" -eq 1 ]; then
    if [ "$HOOKS_CONFIG_CHANGED" -eq 1 ] && [ "$HOOKS_TRANSACTION_PRESERVE" -eq 0 ]; then
      if ! rollback_codex_hooks; then hooks_rollback_ok=0; fi
    elif [ -n "$HOOKS_TRANSACTION_DIR" ]; then
      hooks_rollback_ok=0
      report_codex_hook_transaction
    fi
    if [ "$hooks_rollback_ok" -eq 1 ]; then
      if ! rollback_new_control_hook; then :; fi
    fi
  fi
  trap - EXIT
  exit "$rc"
}

uninstall_control_hook() {
  if [ ! -e "$CONTROL_HOOK_LINK" ] && [ ! -L "$CONTROL_HOOK_LINK" ]; then
    skip "$CONTROL_HOOK_LINK 소유 hook launcher 없음"
    return
  fi
  if ! remove_control_hook_link_transaction; then
    fail "$CONTROL_HOOK_LINK 제거를 안전하게 완료하지 못했습니다."
    exit 1
  fi
  case "$CONTROL_HOOK_LINK_REMOVE_OUTCOME" in
    removed) ok "$CONTROL_HOOK_LINK 심링크 제거" ;;
    absent) skip "$CONTROL_HOOK_LINK 소유 hook launcher 없음" ;;
    foreign) skip "$CONTROL_HOOK_LINK 는 이 transaction이 소유한 hook launcher가 아니므로 보존" ;;
    *)
      fail "$CONTROL_HOOK_LINK 제거 결과를 확인하지 못했습니다."
      exit 1
      ;;
  esac
}

reject_all_private_hook_transactions() {
  if ! reject_stale_control_hook_link_transactions; then
    return 1
  fi
  reject_stale_codex_hook_transactions
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

register_codex_hooks() {
  local hooks_file="$1" rc
  mkdir -p "$(dirname "$hooks_file")"
  if node "$CONFIG_EDITOR" "register-codex-hooks-transaction" "$hooks_file" \
      "$MCP_ENTRY" "$SCRIPT_DIR" "$HOOKS_TRANSACTION_DIR" 2>/dev/null; then
    rc=0
  else
    rc=$?
  fi
  if ! inspect_codex_hook_transaction; then
    HOOKS_TRANSACTION_PRESERVE=1
    fail "Codex hook transaction manifest를 안전하게 확인하지 못했습니다."
    fail "live hooks path 상태는 확인되지 않았습니다."
    report_codex_hook_transaction
    exit 1
  fi
  if report_durable_manual_hook_recovery "captured-live"; then
    exit 1
  fi
  if [ "$rc" -eq 0 ] && [ "$HOOKS_TRANSACTION_STAGE" = "activated" ]; then
    HOOKS_CONFIG_CHANGED=1
    ok "Codex: Guard hook 그룹 등록"
    return
  fi
  if [ "$rc" -eq 3 ] && [ "$HOOKS_TRANSACTION_STAGE" = "unchanged-restored" ]; then
    HOOKS_CONFIG_CHANGED=0
    if ! finalize_codex_hook_transaction "unchanged-restored"; then
      HOOKS_TRANSACTION_PRESERVE=1
      fail "unchanged hook transaction evidence 정리에 실패했습니다."
      report_codex_hook_transaction
      exit 1
    fi
    skip "Codex: Guard hook 그룹 이미 최신"
    return
  fi
  if [ "$rc" -eq 4 ] && { [ "$HOOKS_TRANSACTION_STAGE" = "foreign-restored" ] ||
      [ "$HOOKS_TRANSACTION_STAGE" = "foreign-untouched" ]; }; then
    HOOKS_CONFIG_CHANGED=0
    if ! finalize_codex_hook_transaction "$HOOKS_TRANSACTION_STAGE"; then
      HOOKS_TRANSACTION_PRESERVE=1
      fail "foreign hook transaction evidence 정리에 실패했습니다."
      report_codex_hook_transaction
      exit 1
    fi
    rollback_new_control_hook
    fail "Codex hooks.json이 안전한 객체 파일이 아니거나 소유 그룹이 중복되어 설치를 중단합니다."
    exit 1
  fi
  HOOKS_TRANSACTION_PRESERVE=1
  fail "Codex hooks.json capture/publish가 concurrent 또는 ambiguous 상태입니다 (rc=$rc, stage=$HOOKS_TRANSACTION_STAGE)."
  report_codex_hook_transaction
  fail "live hooks path 상태는 확인되지 않았으며 repository hook launcher는 transaction 검토가 끝날 때까지 보존합니다."
  exit 1
}

control_coordinates_absent() {
  local key
  for key in \
    JHW_REGISTRY_DIR JHW_WORKTREE_ROOT JHW_BUILD_HOST JHW_GITHUB_OWNER \
    JHW_PROJECT_NUMBER JHW_REGISTRY_REPOSITORY JHW_PREFLIGHT_PROJECT_ITEM_ID \
    JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER JHW_CONTROL_STATE_DIR JHW_REGISTRY_REMOTE \
    JHW_REGISTRY_BRANCH JHW_GUARD_MODE JHW_GUARD_ALLOW_OBSERVE; do
    [ -z "${!key+x}" ] || return 1
  done
  return 0
}

is_unprovisioned_control_diagnostic() {
  local output="$1" rc="$2"
  [ "$rc" -eq 78 ] && control_coordinates_absent || return 1
  node -e '
    const fs = require("node:fs");
    let payload;
    try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) process.exit(1);
    if (JSON.stringify(Object.keys(payload)) !== JSON.stringify(["error"])) process.exit(1);
    if (!payload.error || typeof payload.error !== "object" || Array.isArray(payload.error)) process.exit(1);
    if (JSON.stringify(Object.keys(payload.error)) !== JSON.stringify(["code"])) process.exit(1);
    if (payload.error.code !== "INVALID_CONFIG") process.exit(1);
  ' <<<"$output"
}

validate_guard_preflight_diagnostic() {
  local output="$1" rc="$2"
  GUARD_PREFLIGHT_RC="$rc" node -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(0, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 12 * 1024) process.exit(1);
    let payload;
    try { payload = JSON.parse(raw); } catch { process.exit(1); }
    const exact = (value, keys) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const actual = Object.keys(value).sort();
      const expected = [...keys].sort();
      return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
    };
    const oneOf = (value, choices) => choices.includes(value);
    const nonnegativeInteger = (value) => Number.isInteger(value) && value >= 0;
    const validCounts = (value) => {
      const keys = ["PENDING", "APPROVED", "CONSUMED", "COMPLETED", "FAILED", "EXPIRED", "total"];
      if (!exact(value, keys) || !keys.every((key) => nonnegativeInteger(value[key]))) return false;
      return value.total === keys.slice(0, -1).reduce((sum, key) => sum + value[key], 0);
    };
    const validRequestState = (value) => {
      if (exact(value, ["safety"]) && value.safety === "unavailable") return true;
      return exact(value, ["safety", "counts"]) &&
        oneOf(value.safety, ["ready", "not_initialized"]) && validCounts(value.counts);
    };
    const validCoverageEntry = (value) => exact(value, [
      "prompt_origin", "pre_tool_block", "post_tool_correlation", "execution_recheck", "enforced",
    ]) && oneOf(value.prompt_origin, ["ok", "missing", "unsupported"]) &&
      oneOf(value.pre_tool_block, ["ok", "missing", "unsupported"]) &&
      oneOf(value.post_tool_correlation, ["ok", "missing", "unsupported"]) &&
      value.execution_recheck === "pending" && typeof value.enforced === "boolean";
    const exactStaticCoverage = (value, state) => validCoverageEntry(value) &&
      value.prompt_origin === state && value.pre_tool_block === state &&
      value.post_tool_correlation === state && value.enforced === false;
    const rc = Number(process.env.GUARD_PREFLIGHT_RC);
    if (rc !== 78 || !exact(payload, ["command", "result"]) || payload.command !== "guard preflight") process.exit(1);
    const result = payload.result;
    if (!exact(result, ["status", "code", "diagnostics"]) ||
        result.status !== "NO-GO" || result.code !== "GUARD_UNAVAILABLE") process.exit(1);
    const diagnostics = result.diagnostics;
    if (!exact(diagnostics, [
      "protocol_version", "runtime_mode", "request_state", "digest_key", "registry_claims", "adapter_coverage",
    ]) || diagnostics.protocol_version !== 1 ||
        !oneOf(diagnostics.runtime_mode, ["enforce", "observe"]) ||
        !validRequestState(diagnostics.request_state) ||
        !exact(diagnostics.digest_key, ["safety"]) ||
        !oneOf(diagnostics.digest_key.safety, ["ready", "not_initialized", "unavailable"]) ||
        !exact(diagnostics.registry_claims, ["availability"]) ||
        !oneOf(diagnostics.registry_claims.availability, ["available", "unavailable"])) process.exit(1);
    const coverage = diagnostics.adapter_coverage;
    if (!exact(coverage, ["claude", "codex", "gemini", "opencode"]) ||
        !exactStaticCoverage(coverage.claude, "missing") ||
        !validCoverageEntry(coverage.codex) ||
        coverage.codex.prompt_origin !== "ok" || coverage.codex.pre_tool_block !== "ok" ||
        coverage.codex.post_tool_correlation !== "ok" ||
        (diagnostics.runtime_mode !== "enforce" && coverage.codex.enforced) ||
        !exactStaticCoverage(coverage.gemini, "unsupported") ||
        !exactStaticCoverage(coverage.opencode, "unsupported")) process.exit(1);
    process.stdout.write(JSON.stringify(payload));
  ' <<<"$output"
}

unregister_codex_hooks() {
  local hooks_file="$1" rc
  if [ ! -e "$hooks_file" ] && [ ! -L "$hooks_file" ]; then
    skip "Codex: 소유한 Guard hook 그룹 없음"
    return
  fi
  allocate_codex_hook_transaction "$hooks_file"
  if node "$CONFIG_EDITOR" "unregister-codex-hooks-transaction" "$hooks_file" \
      "$MCP_ENTRY" "$SCRIPT_DIR" "$HOOKS_TRANSACTION_DIR" 2>/dev/null; then rc=0; else rc=$?; fi
  if ! inspect_codex_hook_transaction; then
    HOOKS_TRANSACTION_PRESERVE=1
    fail "Codex hook uninstall transaction manifest를 안전하게 확인하지 못했습니다."
    fail "live hooks path 상태는 확인되지 않았습니다."
    report_codex_hook_transaction
    exit 1
  fi
  if report_durable_manual_hook_recovery "captured-live"; then
    exit 1
  fi
  if [ "$rc" -eq 0 ] && [ "$HOOKS_TRANSACTION_STAGE" = "activated" ]; then
    if ! finalize_codex_hook_transaction "activated"; then
      HOOKS_TRANSACTION_PRESERVE=1
      fail "Codex hook uninstall finalize를 확인하지 못했습니다."
      report_codex_hook_transaction
      exit 1
    fi
    ok "Codex: 소유한 Guard hook 그룹 제거"
    return
  fi
  if [ "$rc" -eq 3 ] && [ "$HOOKS_TRANSACTION_STAGE" = "unchanged-restored" ]; then
    if ! finalize_codex_hook_transaction "unchanged-restored"; then
      HOOKS_TRANSACTION_PRESERVE=1
      report_codex_hook_transaction
      exit 1
    fi
    skip "Codex: 소유한 Guard hook 그룹 없음"
    return
  fi
  if [ "$rc" -eq 4 ] && { [ "$HOOKS_TRANSACTION_STAGE" = "foreign-restored" ] ||
      [ "$HOOKS_TRANSACTION_STAGE" = "foreign-untouched" ]; }; then
    if ! finalize_codex_hook_transaction "$HOOKS_TRANSACTION_STAGE"; then
      HOOKS_TRANSACTION_PRESERVE=1
      report_codex_hook_transaction
      exit 1
    fi
    fail "Codex hooks.json을 안전하게 읽지 못해 hook 그룹을 보존합니다."
    exit 1
  fi
  HOOKS_TRANSACTION_PRESERVE=1
  fail "Codex hook uninstall은 concurrent/ambiguous 상태입니다 (rc=$rc, stage=$HOOKS_TRANSACTION_STAGE)."
  report_codex_hook_transaction
  fail "live hooks path 상태를 확인하지 못했습니다."
  fail "repository hook launcher는 transaction 검토가 끝날 때까지 보존합니다."
  exit 1
}

run_guard_preflight() {
  local output rc validated_output
  if output="$("$CONTROL_LINK" guard preflight 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  if is_unprovisioned_control_diagnostic "$output" "$rc"; then
    INSTALL_UNPROTECTED=1
    printf '  %s\n' '{"error":{"code":"INVALID_CONFIG"}}'
    echo -e "  ${YELLOW}⚠️  UNPROTECTED: Project Control coordinates are not configured.${NC}"
    echo "  Configure JHW_REGISTRY_DIR, JHW_WORKTREE_ROOT, GitHub Project/Registry coordinates, then rerun jhw-control guard preflight."
    return
  fi
  if ! validated_output="$(validate_guard_preflight_diagnostic "$output" "$rc")"; then
    fail "Guard preflight가 진단 결과가 아닌 오류를 반환했습니다. 설치를 중단합니다."
    exit 1
  fi
  [ -z "$validated_output" ] || printf '%s\n' "$validated_output" | sed 's/^/  /'
  skip "Guard preflight는 NO-GO — hook 신뢰 검토 또는 미구현 adapter가 남아 있습니다."
}

# --- Uninstall ---
if [ "${1:-}" = "--uninstall" ]; then
  reject_all_private_hook_transactions || exit 1
  echo "jhw-notion 제거를 시작합니다..."
  echo ""

  echo "[1/4] Codex Guard hook 등록 해제"
  unregister_codex_hooks "$HOME/.codex/hooks.json"
  uninstall_control_hook

  echo "[2/4] jhw-control 심링크 제거"
  uninstall_control_cli

  echo "[3/4] 스킬 심링크 제거"
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

  echo "[4/4] MCP 서버 등록 해제"
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

require_control_host
reject_all_private_hook_transactions || exit 1

echo "jhw-notion 설치를 시작합니다..."
echo ""

# [1/6] MCP 서버 빌드
echo "[1/6] MCP 서버 빌드"
cd "$SCRIPT_DIR/mcp-server"
npm ci --silent 2>&1 | tail -1
npm run build 2>&1
ok "빌드 완료"
cd "$SCRIPT_DIR"

# [2/6] jhw-control 심링크
echo ""
echo "[2/6] control 심링크"
validate_control_artifacts
install_control_cli
install_control_hook
INSTALL_TRANSACTION_ACTIVE=1
trap rollback_install_transaction_on_exit EXIT

# [3/6] TUI 감지
echo ""
echo "[3/6] TUI 감지"
CLAUDE_DIR="$HOME/.claude"
GEMINI_DIR="$HOME/.gemini"
OPENCODE_DIR="$HOME/.config/opencode"
CODEX_DIR="$HOME/.codex"

[ -d "$CLAUDE_DIR" ] && ok "Claude Code ($CLAUDE_DIR)" || skip "Claude Code (미설치)"
[ -d "$GEMINI_DIR" ] && ok "Gemini CLI ($GEMINI_DIR)" || skip "Gemini CLI (미설치)"
[ -d "$OPENCODE_DIR" ] && ok "OpenCode ($OPENCODE_DIR)" || skip "OpenCode (미설치)"
[ -d "$CODEX_DIR" ] && ok "Codex CLI ($CODEX_DIR)" || skip "Codex CLI (미설치)"

# [4/6] 스킬 심링크
echo ""
echo "[4/6] 스킬 심링크"

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

# [5/6] MCP 서버 등록
echo ""
echo "[5/6] MCP 서버 등록"
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

# [6/6] Codex Guard hook 등록. 신뢰 여부는 Codex가 관리하므로 설치기는 절대 승인하지 않는다.
echo ""
echo "[6/6] Codex Guard hook 등록"
if control_coordinates_absent; then
  run_guard_preflight
  if [ -d "$CODEX_DIR" ]; then
    unregister_codex_hooks "$CODEX_DIR/hooks.json"
    skip "Codex: Project Control 미설정 — Guard hook 그룹 비활성"
  else
    skip "Codex CLI 미설치 — Guard hook 배선 생략"
  fi
else
  if [ -d "$CODEX_DIR" ]; then
    allocate_codex_hook_transaction "$CODEX_DIR/hooks.json"
    register_codex_hooks "$CODEX_DIR/hooks.json"
    echo "  Codex /hooks 화면에서 세 hook을 검토하고 신뢰 상태를 확인하세요."
  else
    skip "Codex CLI 미설치 — Guard hook 배선 생략"
  fi
  run_guard_preflight
fi

if [ -n "$HOOKS_TRANSACTION_DIR" ]; then
  if ! inspect_codex_hook_transaction || [ "$HOOKS_TRANSACTION_STAGE" != "activated" ] ||
      ! finalize_codex_hook_transaction "activated"; then
    HOOKS_TRANSACTION_PRESERVE=1
    fail "설치는 publish됐지만 private hook transaction finalize를 확인하지 못했습니다."
    report_codex_hook_transaction
    exit 1
  fi
fi
INSTALL_TRANSACTION_ACTIVE=0
trap - EXIT

# .env 확인
echo ""
echo "──────────────────────────────────"
if [ "$INSTALL_UNPROTECTED" -eq 1 ]; then
  echo "설치 완료! (UNPROTECTED)"
else
  echo "설치 완료!"
fi
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
