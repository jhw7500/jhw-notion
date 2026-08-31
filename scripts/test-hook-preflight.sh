#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/mcp-server/dist/control/cli.js"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jhw hook preflight 'runtime.XXXXXX")"
FAKE_BIN="$ROOT/fake-bin"
mkdir -p "$FAKE_BIN"
REAL_TIMEOUT="$(command -v timeout)"
cat >"$FAKE_BIN/timeout" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >>"\${JHW_FAKE_PROBE_LOG:?}"
printf '%s\n' "\$PWD" >"\${JHW_FAKE_PROBE_CWD_LOG:?}"
exec "$REAL_TIMEOUT" "\$@"
EOF
chmod +x "$FAKE_BIN/timeout"
cat >"$FAKE_BIN/codex" <<'EOF'
#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const args = process.argv.slice(2);
const logPath = process.env.JHW_FAKE_CODEX_LOG;
const mode = process.env.JHW_FAKE_CODEX_MODE;
const append = (line) => fs.appendFileSync(logPath, `${line}\n`, "utf8");
const fail = (message, code = 64) => {
  append(`failure:${message}`);
  process.exit(code);
};
append(`invoke:${JSON.stringify(args)}`);
const stdioSurface = args.length === 1 ||
  (args.length === 2 && args[1] === "--stdio") ||
  (args.length === 3 && args[1] === "--listen" && args[2] === "stdio://");
if (args[0] !== "app-server" || !stdioSurface) fail("unexpected-app-server-surface");
if (mode === "unavailable") process.exit(17);
if (mode === "stubborn") {
  fs.writeFileSync(process.env.JHW_FAKE_CODEX_PID, String(process.pid), "utf8");
  process.on("SIGTERM", () => append("ignored:SIGTERM"));
  setInterval(() => {}, 1_000);
  return;
}
if (!["trusted", "untrusted", "wrong-source", "duplicate", "foreign-trusted-after", "mcp-untrusted", "guard-async", "missing-display-order"].includes(mode)) {
  fail("unexpected-mode");
}

let stage = 0;
const send = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { fail("malformed-client-json"); }
  if (message.method === "initialize") {
    if (stage !== 0 || message.id === undefined || message.params?.clientInfo?.name === undefined ||
        message.params?.capabilities?.experimentalApi !== true) fail("invalid-initialize");
    append("initialize");
    stage = 1;
    send(message.id, { userAgent: "fixture-codex", platformFamily: "unix", platformOs: "linux", codexHome: process.env.HOME });
    return;
  }
  if (message.method === "initialized") {
    if (stage !== 1 || message.id !== undefined) fail("invalid-initialized");
    append("initialized");
    stage = 2;
    return;
  }
  if (message.method === "hooks/list") {
    if (stage !== 2 || message.id === undefined || !Array.isArray(message.params?.cwds) ||
        message.params.cwds.length !== 1 || message.params.cwds[0] !== process.cwd()) {
      fail("invalid-hooks-list");
    }
    append("hooks/list");
    const hooksPath = `${process.env.HOME}/.codex/hooks.json`;
    const events = [
      ["userPromptSubmit", "UserPromptSubmit"],
      ["preToolUse", "PreToolUse"],
      ["postToolUse", "PostToolUse"],
    ];
    const hooks = events.map(([eventName, cliEvent], index) => ({
      key: `fixture-${eventName}`,
      eventName,
      handlerType: "command",
      command: `"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${cliEvent}`,
      async: mode === "guard-async" && eventName === "preToolUse",
      matcher: null,
      timeoutSec: 12,
      source: mode === "wrong-source" ? "project" : "user",
      sourcePath: hooksPath,
      enabled: true,
      trustStatus: mode === "untrusted" ? "untrusted" : "trusted",
      currentHash: `opaque-runtime-${eventName}-v1`,
      displayOrder: (index + 1) * 10,
      isManaged: false,
    }));
    if (mode === "duplicate") hooks.push({ ...hooks[0], key: "fixture-userPromptSubmit-duplicate", displayOrder: 40 });
    if (mode === "foreign-trusted-after") hooks.push({
      ...hooks[1],
      key: "fixture-preToolUse-foreign-trusted-after",
      command: "/private/foreign-trusted-after-runtime",
      source: "project",
      sourcePath: "/private/project-hooks.json",
      trustStatus: "trusted",
      displayOrder: 100,
    });
    if (mode === "mcp-untrusted") hooks.push({
      key: "fixture-preToolUse-mcp-untrusted",
      eventName: "preToolUse",
      handlerType: "mcpTool",
      server: "fixture-server",
      tool: "fixture-tool",
      matcher: null,
      timeoutSec: 12,
      source: "project",
      sourcePath: "/private/project-hooks.json",
      enabled: true,
      trustStatus: "untrusted",
      currentHash: "opaque-runtime-mcp-tool-v1",
      displayOrder: 100,
      isManaged: false,
    });
    if (mode === "missing-display-order") delete hooks[1].displayOrder;
    stage = 3;
    send(message.id, { data: [{ cwd: message.params.cwds[0], hooks, errors: [], warnings: [] }] });
    setImmediate(() => process.exit(0));
    return;
  }
  fail("unexpected-method");
});
input.on("close", () => {
  if (stage !== 3) fail("client-closed-early");
});
EOF
chmod +x "$FAKE_BIN/codex"
trap 'rm -rf -- "$ROOT"' EXIT

self_test_fake_app_server() {
  local home="$ROOT/fake-self-test-home" log="$ROOT/fake-self-test.log" output="$ROOT/fake-self-test.out"
  mkdir -p "$home/.codex" "$home/.local/bin"
  printf '%s\n' \
    '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"fixture-preflight","version":"1"},"capabilities":{"experimentalApi":true}}}' \
    '{"method":"initialized"}' \
    "{\"id\":2,\"method\":\"hooks/list\",\"params\":{\"cwds\":[\"$REPO_ROOT\"]}}" |
    HOME="$home" JHW_FAKE_CODEX_MODE="trusted" JHW_FAKE_CODEX_LOG="$log" \
      "$FAKE_BIN/codex" app-server --stdio >"$output"
  node - "$log" "$output" "$home" <<'EOF'
const fs = require("node:fs");
const [logPath, outputPath, home] = process.argv.slice(2);
const log = fs.readFileSync(logPath, "utf8").trim().split("\n");
if (JSON.stringify(log.slice(1)) !== JSON.stringify(["initialize", "initialized", "hooks/list"])) process.exit(1);
const responses = fs.readFileSync(outputPath, "utf8").trim().split("\n").map(JSON.parse);
if (responses.length !== 2 || responses[0].id !== 1 || responses[1].id !== 2) process.exit(1);
const hooks = responses[1].result?.data?.[0]?.hooks;
if (!Array.isArray(hooks) || hooks.length !== 3) process.exit(1);
for (const hook of hooks) {
  if (hook.handlerType !== "command" || hook.async !== false || hook.matcher !== null || hook.timeoutSec !== 12 ||
      hook.source !== "user" || hook.sourcePath !== `${home}/.codex/hooks.json` || hook.isManaged !== false || hook.enabled !== true ||
      hook.trustStatus !== "trusted" || typeof hook.currentHash !== "string" || !hook.currentHash ||
      !Number.isInteger(hook.displayOrder) || hook.displayOrder < 0) process.exit(1);
}
EOF
}

self_test_fake_app_server

(cd "$REPO_ROOT/mcp-server" && npm run build >/dev/null)
[ -x "$CLI" ] || { echo "built jhw-control entry is not executable" >&2; exit 1; }

owned_group_json() {
  local event="$1"
  node -e 'process.stdout.write(JSON.stringify({hooks:[{type:"command",command:`"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${process.argv[1]}`,timeout:12}]}))' "$event"
}

make_home() {
  local scenario="$1" home="$ROOT/$scenario-home" hooks="$ROOT/$scenario-home/.codex/hooks.json"
  mkdir -p "$home/.codex" "$home/.local/bin" "$home/registry" "$home/worktrees" "$home/state"
  case "$scenario" in
    launcher-missing) ;;
    launcher-regular) printf 'private-regular-launcher-marker' >"$home/.local/bin/jhw-control-hook" ;;
    launcher-foreign)
      printf 'private-foreign-launcher-marker' >"$home/private-foreign-launcher-target"
      ln -s "$home/private-foreign-launcher-target" "$home/.local/bin/jhw-control-hook"
      ;;
    *) ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$home/.local/bin/jhw-control-hook" ;;
  esac
  case "$scenario" in
    exact-trusted|exact-invalid-shell|exact-untrusted|exact-unavailable|exact-runtime-source|exact-runtime-duplicate|exact-stubborn|exact-foreign-trusted-after|exact-mcp-untrusted|exact-guard-async|exact-missing-display-order|launcher-missing|launcher-regular|launcher-foreign)
      printf '{"hooks":{"UserPromptSubmit":[%s],"PreToolUse":[%s],"PostToolUse":[%s]}}\n' \
        "$(owned_group_json UserPromptSubmit)" \
        "$(owned_group_json PreToolUse)" \
        "$(owned_group_json PostToolUse)" >"$hooks"
      ;;
    duplicate-config)
      printf '{"hooks":{"UserPromptSubmit":[%s],"PreToolUse":[%s,%s],"PostToolUse":[%s]}}\n' \
        "$(owned_group_json UserPromptSubmit)" \
        "$(owned_group_json PreToolUse)" \
        "$(owned_group_json PreToolUse)" \
        "$(owned_group_json PostToolUse)" >"$hooks"
      ;;
    missing) ;;
    malformed) printf '%s' '{"hooks":{"PreToolUse":["private-secret-marker"],' >"$hooks" ;;
    foreign)
      printf '%s' '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"/private/foreign-secret","timeout":12}]}],"PreToolUse":[],"PostToolUse":[]}}' >"$hooks"
      ;;
  esac
  [ ! -e "$hooks" ] || chmod 0600 "$hooks"
  printf '%s\n' "$home"
}

run_preflight() {
  local scenario="$1" home="$2" output="$home/preflight.out" error="$home/preflight.err" rc mode log probe_log probe_cwd_log runtime_shell
  case "$scenario" in
    exact-trusted) mode="trusted" ;;
    exact-invalid-shell) mode="trusted" ;;
    exact-untrusted) mode="untrusted" ;;
    exact-unavailable) mode="unavailable" ;;
    exact-runtime-source) mode="wrong-source" ;;
    exact-runtime-duplicate) mode="duplicate" ;;
    exact-stubborn) mode="stubborn" ;;
    exact-foreign-trusted-after) mode="foreign-trusted-after" ;;
    exact-mcp-untrusted) mode="mcp-untrusted" ;;
    exact-guard-async) mode="guard-async" ;;
    exact-missing-display-order) mode="missing-display-order" ;;
    *) mode="trusted" ;;
  esac
  log="$ROOT/$scenario-app-server.log"
  probe_log="$ROOT/$scenario-shell-probe.log"
  probe_cwd_log="$ROOT/$scenario-shell-probe-cwd.log"
  runtime_shell="${SHELL:-/bin/sh}"
  [ "$scenario" != "exact-invalid-shell" ] || runtime_shell="$home/private-missing-shell"
  local started_ms finished_ms elapsed_ms stubborn_pid
  started_ms="$(date +%s%3N)"
  if HOME="$home" PATH="$FAKE_BIN:$PATH" SHELL="$runtime_shell" \
      JHW_FAKE_CODEX_MODE="$mode" \
      JHW_FAKE_CODEX_LOG="$log" \
      JHW_FAKE_CODEX_PID="$ROOT/$scenario-app-server.pid" \
      JHW_FAKE_PROBE_LOG="$probe_log" \
      JHW_FAKE_PROBE_CWD_LOG="$probe_cwd_log" \
      JHW_REGISTRY_DIR="$home/registry" \
      JHW_WORKTREE_ROOT="$home/worktrees" \
      JHW_BUILD_HOST="fixture-host" \
      JHW_GITHUB_OWNER="fixture-owner" \
      JHW_PROJECT_NUMBER="1" \
      JHW_REGISTRY_REPOSITORY="fixture-owner/registry" \
      JHW_PREFLIGHT_PROJECT_ITEM_ID="PVTI_fixture" \
      JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER="1" \
      JHW_CONTROL_STATE_DIR="$home/state" \
      JHW_GUARD_MODE="enforce" \
      "$CLI" guard preflight >"$output" 2>"$error"; then
    rc=0
  else
    rc=$?
  fi
  finished_ms="$(date +%s%3N)"
  elapsed_ms=$((finished_ms - started_ms))
  [ "$rc" -eq 0 ] || [ "$rc" -eq 78 ] || {
    echo "unexpected guard preflight exit for $scenario: $rc" >&2
    return 1
  }
  if [ "$scenario" = "exact-stubborn" ]; then
    [ "$elapsed_ms" -lt 8000 ] || {
      echo "stubborn Codex app-server kept the public CLI alive for ${elapsed_ms}ms" >&2
      return 1
    }
    stubborn_pid="$(cat "$ROOT/$scenario-app-server.pid")"
    if kill -0 "$stubborn_pid" 2>/dev/null; then
      echo "stubborn Codex app-server was not forcibly reaped" >&2
      return 1
    fi
  fi
  node - "$scenario" "$output" "$error" "$log" "$probe_log" "$probe_cwd_log" "$REPO_ROOT" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [scenario, stdoutPath, stderrPath, logPath, probeLogPath, probeCwdLogPath, expectedProbeCwd] = process.argv.slice(2);
const stdout = fs.readFileSync(stdoutPath, "utf8");
const stderr = fs.readFileSync(stderrPath, "utf8");
const raw = stdout || stderr;
const fail = (message) => { console.error(`${scenario}: ${message}`); process.exit(1); };
if (!raw) fail("preflight returned no JSON");
if (stdout && stderr) fail("preflight wrote both stdout and stderr");
if (Buffer.byteLength(raw, "utf8") > 12 * 1024) fail("preflight exceeded 12 KiB");
const payload = JSON.parse(raw);
const coverage = payload.result?.diagnostics?.adapter_coverage;
if (!coverage) fail("adapter_coverage is absent");
if (JSON.stringify(Object.keys(coverage).sort()) !== JSON.stringify(["claude", "codex", "gemini", "opencode"])) {
  fail("adapter set is not exactly claude/codex/gemini/opencode");
}
const axes = ["enforced", "execution_recheck", "post_tool_correlation", "pre_tool_block", "prompt_origin"];
for (const [adapter, value] of Object.entries(coverage)) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(axes)) {
    fail(`${adapter} does not expose the exact five coverage axes`);
  }
}
const staticExpected = {
  claude: { prompt_origin: "missing", pre_tool_block: "missing", post_tool_correlation: "missing", execution_recheck: "pending", enforced: false },
  gemini: { prompt_origin: "unsupported", pre_tool_block: "unsupported", post_tool_correlation: "unsupported", execution_recheck: "pending", enforced: false },
  opencode: { prompt_origin: "unsupported", pre_tool_block: "unsupported", post_tool_correlation: "unsupported", execution_recheck: "pending", enforced: false },
};
for (const [adapter, expected] of Object.entries(staticExpected)) {
  if (JSON.stringify(coverage[adapter]) !== JSON.stringify(expected)) fail(`${adapter} coverage is not truthful`);
}
const installedAxes = scenario.startsWith("exact-") ? "ok" : "missing";
const expectedCodex = {
  prompt_origin: installedAxes,
  pre_tool_block: installedAxes,
  post_tool_correlation: installedAxes,
  execution_recheck: "pending",
  enforced: scenario === "exact-trusted" || scenario === "exact-mcp-untrusted",
};
if (JSON.stringify(coverage.codex) !== JSON.stringify(expectedCodex)) fail("Codex installed/runtime coverage is not truthful");
if (raw.includes("private-secret-marker") || raw.includes("/private/foreign-secret") ||
    raw.includes("private-regular-launcher-marker") || raw.includes("private-foreign-launcher-marker") ||
    raw.includes(path.dirname(stdoutPath))) {
  fail("preflight exposed private fixture data");
}
if (scenario.startsWith("exact-")) {
  if (!fs.existsSync(logPath)) fail("production preflight did not invoke the Codex app-server inspector");
  const log = fs.readFileSync(logPath, "utf8").trim().split("\n");
  if (!log[0]?.startsWith("invoke:[\"app-server\"")) fail("Codex inspector used the wrong executable surface");
  if (scenario === "exact-unavailable") {
    if (log.length !== 1) fail("unavailable Codex inspector unexpectedly entered the protocol");
  } else if (scenario === "exact-stubborn") {
    if (JSON.stringify(log.slice(1)) !== JSON.stringify(["ignored:SIGTERM"])) {
      fail("stubborn Codex inspector did not receive bounded termination escalation");
    }
  } else if (JSON.stringify(log.slice(1)) !== JSON.stringify(["initialize", "initialized", "hooks/list"])) {
    fail("Codex inspector did not complete initialize/initialized/hooks/list");
  }
}
if (scenario === "exact-trusted" || scenario === "exact-mcp-untrusted") {
  if (!fs.existsSync(probeLogPath)) fail("production preflight did not execute the stored canonical command");
  const probe = fs.readFileSync(probeLogPath, "utf8").trim().split("\n");
  if (probe.length !== 1 || !probe[0].startsWith("--foreground 8 ")) {
    fail("shell probe did not traverse the canonical launcher timeout boundary exactly once");
  }
  if (!fs.existsSync(probeCwdLogPath) || fs.readFileSync(probeCwdLogPath, "utf8").trim() !== expectedProbeCwd) {
    fail("shell probe did not use the Codex inventory cwd");
  }
}
EOF
}

all_scenarios=(
  exact-trusted exact-invalid-shell exact-untrusted exact-unavailable exact-runtime-source exact-runtime-duplicate exact-stubborn
  exact-foreign-trusted-after exact-mcp-untrusted exact-guard-async exact-missing-display-order
  launcher-missing launcher-regular launcher-foreign duplicate-config missing malformed foreign
)
if [ -n "${JHW_PREFLIGHT_TEST_ONLY:-}" ]; then
  selected=0
  for candidate in "${all_scenarios[@]}"; do
    [ "$candidate" = "$JHW_PREFLIGHT_TEST_ONLY" ] && selected=1
  done
  [ "$selected" -eq 1 ] || { echo "unknown JHW_PREFLIGHT_TEST_ONLY selection" >&2; exit 2; }
  scenarios=("$JHW_PREFLIGHT_TEST_ONLY")
else
  scenarios=("${all_scenarios[@]}")
fi

for scenario in "${scenarios[@]}"; do
  home="$(make_home "$scenario")"
  hooks="$home/.codex/hooks.json"
  launcher="$home/.local/bin/jhw-control-hook"
  if [ -e "$hooks" ]; then
    before="$(sha256sum "$hooks")"
    before_mode="$(stat -c '%a' "$hooks")"
  fi
  if [ -L "$launcher" ]; then
    launcher_kind="symlink"
    launcher_link_before="$(readlink -- "$launcher")"
    launcher_bytes_before="$(sha256sum "$launcher")"
  elif [ -f "$launcher" ]; then
    launcher_kind="file"
    launcher_bytes_before="$(sha256sum "$launcher")"
    launcher_mode_before="$(stat -c '%a' "$launcher")"
  else
    launcher_kind="missing"
  fi
  run_preflight "$scenario" "$home"
  if [ -e "$hooks" ]; then
    [ "$(sha256sum "$hooks")" = "$before" ] || { echo "preflight modified $scenario hooks" >&2; exit 1; }
    [ "$(stat -c '%a' "$hooks")" = "$before_mode" ] || { echo "preflight changed $scenario hook mode" >&2; exit 1; }
  else
    [ ! -e "$hooks" ] || exit 1
  fi
  case "$launcher_kind" in
    symlink)
      [ -L "$launcher" ] && [ "$(readlink -- "$launcher")" = "$launcher_link_before" ] || exit 1
      [ "$(sha256sum "$launcher")" = "$launcher_bytes_before" ] || exit 1
      ;;
    file)
      [ -f "$launcher" ] && [ ! -L "$launcher" ] || exit 1
      [ "$(sha256sum "$launcher")" = "$launcher_bytes_before" ] || exit 1
      [ "$(stat -c '%a' "$launcher")" = "$launcher_mode_before" ] || exit 1
      ;;
    missing) [ ! -e "$launcher" ] && [ ! -L "$launcher" ] || exit 1 ;;
  esac
  [ "$(find "$home/.codex" -maxdepth 1 -type f -name 'hooks.json.bak.*' -print -quit)" = "" ] || {
    echo "read-only preflight created a backup for $scenario" >&2
    exit 1
  }
done

echo "hook preflight: ok"
