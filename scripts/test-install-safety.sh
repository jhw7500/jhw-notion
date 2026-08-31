#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$REPO_ROOT/install.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jhw install 'safety.XXXXXX")"
FAKE_BIN="$ROOT/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/npm" <<'EOF'
#!/bin/sh
[ -z "${JHW_TEST_NPM_LOG:-}" ] || printf '%s\n' "$*" >>"$JHW_TEST_NPM_LOG"
[ "${JHW_TEST_NPM_FAIL:-0}" = "1" ] && exit 17
exit 0
EOF
chmod +x "$FAKE_BIN/npm"
cat >"$FAKE_BIN/codex" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"${JHW_INSTALL_CODEX_LOG:?}"
[ "$1" = "app-server" ] || exit 64
exit 17
EOF
chmod +x "$FAKE_BIN/codex"
REAL_NODE="$(command -v node)"
REAL_RM="$(command -v rm)"
RACE_PRELOAD="$ROOT/link-race-preload.cjs"
cat >"$RACE_PRELOAD" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const operation = process.argv[2] ?? "";
const hooksFile = path.join(process.env.HOME, ".codex", "hooks.json");
const launcherFile = path.join(process.env.HOME, ".local", "bin", "jhw-control-hook");
const expectedLauncherTarget = process.argv[4] ?? "";
const transactionDirectory = process.argv[6] ?? "";
const wanted = process.env.JHW_TEST_LINK_RACE_OPERATION ?? "";
const round5Mode = process.env.JHW_TEST_ROUND5_MODE ?? "";
const launcherRaceMode = process.env.JHW_TEST_LAUNCHER_RACE_MODE ?? "";
const matchingOperation =
  (wanted === "register" && operation === "register-codex-hooks-transaction") ||
  (wanted === "rollback" && operation === "rollback-codex-hooks-transaction") ||
  (wanted === "unregister" && operation === "unregister-codex-hooks-transaction");
let injected = false;
let rollbackCandidateRenamed = false;
let rollbackParentFsyncFailureInjected = false;
let manualManifestPublished = false;
let launcherCapturedManifestPublished = false;
let launcherCapturedLinkDeleted = false;
const rollbackRecoveryMode = round5Mode.startsWith("rollback-intent-") ||
  round5Mode.startsWith("rollback-wave2-") || round5Mode.startsWith("rollback-wave3-");

function marker(name, value) {
  fs.writeFileSync(path.join(process.env.HOME, name), value, { mode: 0o600 });
}

function launcherKind(info) {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isFIFO()) return "fifo";
  return "nonregular";
}

function recordLauncherIdentity(name, file) {
  const info = fs.lstatSync(file);
  const target = info.isSymbolicLink() ? fs.readlinkSync(file) : "";
  marker(name, [launcherKind(info), (info.mode & 0o777).toString(8),
    Number(info.dev), Number(info.ino), target].join("|"));
}

function injectLauncherReplacement() {
  realLinkSync(launcherFile, path.join(process.env.HOME, "launcher-original-inode-held"));
  realUnlinkSync(launcherFile);
  if (launcherRaceMode.endsWith("-symlink")) {
    const target = path.join(process.env.HOME, "foreign-launcher-target");
    fs.writeFileSync(target, "foreign-launcher-target-bytes", { mode: 0o640 });
    fs.symlinkSync(target, launcherFile);
  } else if (launcherRaceMode.endsWith("-same-target")) {
    fs.symlinkSync(expectedLauncherTarget, launcherFile);
  } else {
    fs.writeFileSync(launcherFile, `foreign-launcher-regular-${launcherRaceMode}`, { mode: 0o640 });
  }
  recordLauncherIdentity("launcher-replacement.identity", launcherFile);
}

function appendRecoverySequence(value) {
  fs.appendFileSync(path.join(process.env.HOME, "rollback-recovery-sequence"), `${value}\n`, { mode: 0o600 });
}

function requireCaptureIntent() {
  const manifest = JSON.parse(fs.readFileSync(path.join(transactionDirectory, "manifest.json"), "utf8"));
  marker("capture-intent-observed", String(manifest.stage));
  if (manifest.stage !== "capture-intent") throw new Error(`capture intent was not durable: ${manifest.stage}`);
}

function observeRollbackCaptureIntent() {
  const manifest = JSON.parse(fs.readFileSync(path.join(transactionDirectory, "manifest.json"), "utf8"));
  marker("rollback-capture-intent-observed", String(manifest.stage));
}

const realRenameSync = fs.renameSync.bind(fs);
fs.renameSync = (source, destination) => {
  const capturesHooks =
    ["register-codex-hooks-transaction", "unregister-codex-hooks-transaction"].includes(operation) &&
    path.resolve(source) === path.resolve(hooksFile) && path.basename(destination) === "captured-live";
  const capturesRollbackCandidate = operation === "rollback-codex-hooks-transaction" &&
    path.resolve(source) === path.resolve(hooksFile) && path.basename(destination) === "candidate-live";
  const capturesLauncher = operation === "remove-control-hook-link-transaction" &&
    path.resolve(source) === path.resolve(launcherFile) && path.basename(destination) === "captured-link";
  if (capturesLauncher && ["uninstall-regular", "uninstall-symlink", "uninstall-same-target",
      "rollback-regular", "rollback-winner"].includes(launcherRaceMode)) {
    injectLauncherReplacement();
  }
  if (capturesHooks) {
    if (process.env.JHW_TEST_CAPTURE_MODE) {
      fs.chmodSync(hooksFile, Number.parseInt(process.env.JHW_TEST_CAPTURE_MODE, 8));
      marker("capture-mode-hit", "yes");
    }
    if (round5Mode === "capture-intent-verify") requireCaptureIntent();
    if (round5Mode === "capture-enoent") fs.unlinkSync(hooksFile);
    if (round5Mode.startsWith("substitute-") ||
        ["capture-manual-hard-exit", "unregister-manual-hard-exit"].includes(round5Mode)) {
      fs.unlinkSync(hooksFile);
      if (round5Mode === "substitute-symlink") {
        fs.symlinkSync(process.env.JHW_TEST_SUBSTITUTE_TARGET, hooksFile);
      } else if (round5Mode === "substitute-fifo") {
        const result = require("node:child_process").spawnSync("mkfifo", ["-m", "620", hooksFile]);
        if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr}`);
      } else if (["substitute-directory", "capture-manual-hard-exit", "unregister-manual-hard-exit"].includes(round5Mode)) {
        fs.mkdirSync(hooksFile, { mode: 0o750 });
        const content = round5Mode === "capture-manual-hard-exit" ? "captured-register-subtree" :
          round5Mode === "unregister-manual-hard-exit" ? "captured-unregister-subtree" : "directory-subtree";
        fs.writeFileSync(path.join(hooksFile, "foreign-subtree-marker"), content, { mode: 0o640 });
      }
    }
  }
  if (capturesRollbackCandidate && rollbackRecoveryMode) {
    observeRollbackCaptureIntent();
    if (["rollback-intent-directory", "rollback-wave2-fsync-order",
      "rollback-wave2-fsync-failure", "rollback-wave2-manual-hard-exit"].includes(round5Mode)) {
      fs.unlinkSync(hooksFile);
      fs.mkdirSync(hooksFile, { mode: 0o750 });
      fs.writeFileSync(path.join(hooksFile, "foreign-subtree-marker"), "rollback-directory-subtree", { mode: 0o640 });
    } else if (["rollback-intent-symlink", "rollback-wave3-symlink-dir-fsync-failure"].includes(round5Mode)) {
      fs.unlinkSync(hooksFile);
      const target = path.join(process.env.HOME, "rollback-symlink-target");
      fs.mkdirSync(target, { mode: 0o750 });
      fs.writeFileSync(path.join(target, "external-target-marker"), "must-remain-external", { mode: 0o640 });
      fs.symlinkSync(target, hooksFile);
    } else if (round5Mode === "rollback-intent-fifo") {
      fs.unlinkSync(hooksFile);
      const result = require("node:child_process").spawnSync("mkfifo", ["-m", "620", hooksFile]);
      if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr}`);
    }
  }
  let recoveryManifestKind;
  let launcherManifestStage;
  const captureManualHardExit =
    (round5Mode === "capture-manual-hard-exit" && operation === "register-codex-hooks-transaction") ||
    (round5Mode === "unregister-manual-hard-exit" && operation === "unregister-codex-hooks-transaction");
  if ((rollbackCandidateRenamed && operation === "rollback-codex-hooks-transaction" || captureManualHardExit) &&
      path.resolve(destination) === path.join(path.resolve(transactionDirectory), "manifest.json")) {
    try {
      const nextManifest = JSON.parse(fs.readFileSync(source, "utf8"));
      if (nextManifest.stage === "manual-recovery-required") recoveryManifestKind = "manual";
      else if (nextManifest.candidate || nextManifest.artifacts?.includes("candidate-live")) recoveryManifestKind = "candidate";
    } catch {}
  }
  if (operation === "remove-control-hook-link-transaction" &&
      path.resolve(destination) === path.join(path.resolve(transactionDirectory), "manifest.json")) {
    try {
      launcherManifestStage = JSON.parse(fs.readFileSync(source, "utf8")).stage;
    } catch {}
  }
  const result = realRenameSync(source, destination);
  if (recoveryManifestKind) {
    appendRecoverySequence(`${recoveryManifestKind}-manifest-write`);
    if (recoveryManifestKind === "manual") manualManifestPublished = true;
  }
  if (launcherManifestStage === "captured") launcherCapturedManifestPublished = true;
  if (capturesHooks && ["post-rename-error", "post-rename-extra-error"].includes(round5Mode)) {
    if (round5Mode === "post-rename-extra-error") {
      fs.writeFileSync(path.join(transactionDirectory, "unexpected-intent-artifact"), "private-unexpected-marker", { mode: 0o600 });
    }
    marker("capture-after-rename-hit", destination);
    throw new Error("injected after capture rename before manifest commit");
  }
  if (capturesRollbackCandidate && rollbackRecoveryMode) {
    rollbackCandidateRenamed = true;
    if (round5Mode === "rollback-wave2-substitute-link") {
      fs.copyFileSync(destination, path.join(process.env.HOME, "rollback-candidate-original-witness"));
    }
    marker("rollback-after-rename-hit", destination);
    throw new Error("injected after rollback candidate rename before manifest commit");
  }
  return result;
};

const realLinkSync = fs.linkSync.bind(fs);
fs.linkSync = (source, destination) => {
  if (operation === "remove-control-hook-link-transaction" && launcherRaceMode === "rollback-winner" &&
      path.basename(source) === "captured-link" && path.resolve(destination) === path.resolve(launcherFile)) {
    fs.writeFileSync(launcherFile, "foreign-launcher-winner", { flag: "wx", mode: 0o622 });
    fs.chmodSync(launcherFile, 0o622);
    recordLauncherIdentity("launcher-winner.identity", launcherFile);
  }
  if (operation === "rollback-codex-hooks-transaction" &&
      round5Mode === "rollback-wave2-substitute-link" &&
      path.basename(source) === "candidate-live" && path.resolve(destination) === path.resolve(hooksFile)) {
    realRenameSync(source, path.join(process.env.HOME, "rollback-candidate-original-held"));
    fs.writeFileSync(source, "substituted-candidate-must-not-publish", { mode: 0o622 });
    marker("rollback-candidate-link-substitution-hit", source);
  }
  if (!injected && matchingOperation && path.resolve(destination) === path.resolve(hooksFile)) {
    injected = true;
    const mode = Number.parseInt(process.env.JHW_TEST_LINK_RACE_MODE ?? "622", 8);
    const fd = fs.openSync(hooksFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    try {
      fs.writeFileSync(fd, process.env.JHW_TEST_LINK_RACE_BYTES ?? "foreign-race-winner");
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const parent = fs.openSync(path.dirname(hooksFile), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    fs.writeFileSync(path.join(process.env.HOME, "link-race-hit"), operation, { mode: 0o600 });
  }
  return realLinkSync(source, destination);
};

const realUnlinkSync = fs.unlinkSync.bind(fs);
fs.unlinkSync = (target) => {
  if (operation === "remove-control-hook-link-transaction" &&
      launcherRaceMode === "delete-hard-exit" && path.dirname(target) === path.resolve(transactionDirectory) &&
      path.basename(target) === "captured-link") {
    const manifest = JSON.parse(fs.readFileSync(path.join(transactionDirectory, "manifest.json"), "utf8"));
    marker("launcher-delete-stage-observed", String(manifest.stage));
    const result = realUnlinkSync(target);
    launcherCapturedLinkDeleted = true;
    return result;
  }
  if (operation === "register-codex-hooks-transaction" &&
      round5Mode === "activation-detach-intent" &&
      path.dirname(target) === path.resolve(transactionDirectory) && path.basename(target) === "published-ready") {
    const manifest = JSON.parse(fs.readFileSync(path.join(transactionDirectory, "manifest.json"), "utf8"));
    marker("activation-detach-stage-observed", String(manifest.stage));
    realUnlinkSync(target);
    marker("activation-ready-unlinked", "yes");
    process.exit(93);
  }
  if (!injected && operation === "finalize-codex-hooks-transaction" &&
      round5Mode === "finalize-partial" && path.dirname(target) === path.resolve(transactionDirectory) &&
      path.basename(target) !== "manifest.json") {
    injected = true;
    realUnlinkSync(target);
    marker("finalize-partial-hit", path.basename(target));
    throw new Error("injected after one finalized artifact unlink");
  }
  return realUnlinkSync(target);
};

let removedTransactionDirectory = false;
const realRmdirSync = fs.rmdirSync.bind(fs);
fs.rmdirSync = (target, ...args) => {
  const result = realRmdirSync(target, ...args);
  if (operation === "finalize-codex-hooks-transaction" &&
      round5Mode === "finalize-post-rmdir-fsync" && path.resolve(target) === path.resolve(transactionDirectory)) {
    removedTransactionDirectory = true;
    marker("finalize-rmdir-hit", target);
  }
  return result;
};

const realFsyncSync = fs.fsyncSync.bind(fs);
fs.fsyncSync = (fd) => {
  if (removedTransactionDirectory) {
    removedTransactionDirectory = false;
    throw new Error("injected parent fsync failure after transaction rmdir");
  }
  let fdPath;
  if (rollbackCandidateRenamed || manualManifestPublished ||
      launcherCapturedManifestPublished || launcherCapturedLinkDeleted) {
    try { fdPath = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
  }
  if (fdPath === path.dirname(hooksFile)) {
    if (["rollback-wave2-fsync-failure", "rollback-wave3-symlink-dir-fsync-failure"].includes(round5Mode) &&
        !rollbackParentFsyncFailureInjected) {
      rollbackParentFsyncFailureInjected = true;
      marker("rollback-live-parent-fsync-failure-hit", fdPath);
      throw new Error("injected rollback recovery live-parent fsync failure");
    }
    const result = realFsyncSync(fd);
    appendRecoverySequence("live-parent-fsync");
    return result;
  }
  if (fdPath === path.resolve(transactionDirectory)) {
    const result = realFsyncSync(fd);
    appendRecoverySequence("transaction-parent-fsync");
    if (launcherRaceMode === "capture-hard-exit" && launcherCapturedManifestPublished) {
      marker("launcher-capture-stage-durable", fdPath);
      process.exit(96);
    }
    if (launcherRaceMode === "delete-hard-exit" && launcherCapturedLinkDeleted) {
      marker("launcher-delete-stage-durable", fdPath);
      process.exit(97);
    }
    if (round5Mode === "rollback-wave2-manual-hard-exit" && manualManifestPublished) {
      marker("rollback-manual-stage-durable", fdPath);
      process.exit(94);
    }
    if (round5Mode === "capture-manual-hard-exit" && operation === "register-codex-hooks-transaction" && manualManifestPublished) {
      marker("capture-manual-stage-durable", fdPath);
      process.stderr.write("private-register-helper-stderr-marker\n");
      process.exit(94);
    }
    if (round5Mode === "unregister-manual-hard-exit" && operation === "unregister-codex-hooks-transaction" && manualManifestPublished) {
      marker("unregister-manual-stage-durable", fdPath);
      process.stderr.write("private-unregister-helper-stderr-marker\n");
      process.exit(95);
    }
    return result;
  }
  return realFsyncSync(fd);
};
EOF
cat >"$FAKE_BIN/node" <<EOF
#!/bin/sh
if [ -n "\${JHW_TEST_DIAGNOSTIC_OUTPUT:-}" ] &&
   { [ "\${1:-}" = "$REPO_ROOT/mcp-server/dist/control/cli.js" ] ||
     [ "\${1:-}" = "\${HOME}/.local/bin/jhw-control" ]; }; then
  if [ -n "\${JHW_TEST_CONCURRENT_HOOKS:-}" ]; then
    cp -- "\${HOME}/.codex/hooks.json" "\${HOME}/published-hooks.witness"
    stat -c '%a' "\${HOME}/.codex/hooks.json" >"\${HOME}/published-hooks.mode"
    printf '%s' "\$JHW_TEST_CONCURRENT_HOOKS" >"\${HOME}/.codex/hooks.json"
    chmod "\${JHW_TEST_CONCURRENT_MODE:-0644}" "\${HOME}/.codex/hooks.json"
  fi
  printf '%s\n' "\$JHW_TEST_DIAGNOSTIC_OUTPUT"
  exit "\${JHW_TEST_DIAGNOSTIC_EXIT:-78}"
fi
if [ "\${JHW_TEST_ROUND5_MODE:-}" = "rollback-same-bytes-new-inode" ] &&
   [ "\${1:-}" = "$REPO_ROOT/scripts/install-config.mjs" ] &&
   [ "\${2:-}" = "rollback-codex-hooks-transaction" ]; then
  replacement="\${HOME}/.codex/.hooks.json.same-bytes-replacement"
  if ! cp --preserve=mode -- "\${HOME}/.codex/hooks.json" "\$replacement"; then exit 96; fi
  if ! cp -- "\${HOME}/.codex/hooks.json" "\${HOME}/published-hooks.witness"; then exit 96; fi
  if ! stat -c '%d:%i' "\${HOME}/.codex/hooks.json" >"\${HOME}/published-hooks.identity"; then exit 96; fi
  if ! mv -fT -- "\$replacement" "\${HOME}/.codex/hooks.json"; then exit 96; fi
  if ! ln -- "\${HOME}/.codex/hooks.json" "\${HOME}/replacement-hooks.inode-witness"; then exit 96; fi
  if ! stat -c '%d:%i' "\${HOME}/.codex/hooks.json" >"\${HOME}/replacement-hooks.identity"; then exit 96; fi
fi
if [ "\${JHW_TEST_ROLLBACK_FAIL:-0}" = "1" ] &&
   [ "\${1:-}" = "$REPO_ROOT/scripts/install-config.mjs" ] &&
   [ "\${2:-}" = "rollback-codex-hooks-transaction" ]; then
  exit 19
fi
if [ "\${JHW_TEST_ROLLBACK_AFTER_MUTATION_FAIL:-0}" = "1" ] &&
   [ "\${1:-}" = "$REPO_ROOT/scripts/install-config.mjs" ] &&
   [ "\${2:-}" = "rollback-codex-hooks-transaction" ]; then
  "$REAL_NODE" "\$@"
  helper_rc=\$?
  [ "\$helper_rc" -eq 0 ] || exit "\$helper_rc"
  exit 19
fi
if [ "\${1:-}" = "$REPO_ROOT/scripts/install-config.mjs" ] &&
   { [ -n "\${JHW_TEST_LINK_RACE_OPERATION:-}" ] || [ -n "\${JHW_TEST_CAPTURE_MODE:-}" ] ||
     [ -n "\${JHW_TEST_ROUND5_MODE:-}" ] || [ -n "\${JHW_TEST_LAUNCHER_RACE_MODE:-}" ]; }; then
  exec "$REAL_NODE" --require "$RACE_PRELOAD" "\$@"
fi
exec "$REAL_NODE" "\$@"
EOF
chmod +x "$FAKE_BIN/node"
cat >"$FAKE_BIN/rm" <<EOF
#!/bin/sh
launcher="\${HOME}/.local/bin/jhw-control-hook"
case "\${JHW_TEST_LAUNCHER_RACE_MODE:-}" in
  uninstall-regular|uninstall-symlink|uninstall-same-target|rollback-regular|rollback-winner)
    for argument in "\$@"; do
      if [ "\$argument" = "\$launcher" ] && [ ! -e "\${HOME}/launcher-shell-race-hit" ]; then
        ln -P -- "\$launcher" "\${HOME}/launcher-original-inode-held" || exit 96
        "$REAL_RM" -- "\$launcher" || exit 96
        case "\${JHW_TEST_LAUNCHER_RACE_MODE}" in
          *-symlink)
            printf '%s' 'foreign-launcher-target-bytes' >"\${HOME}/foreign-launcher-target"
            ln -s -- "\${HOME}/foreign-launcher-target" "\$launcher" || exit 96
            ;;
          *-same-target)
            ln -s -- "$REPO_ROOT/scripts/jhw-control-hook" "\$launcher" || exit 96
            ;;
          *)
            printf '%s' "foreign-launcher-regular-\${JHW_TEST_LAUNCHER_RACE_MODE}" >"\$launcher"
            chmod 0640 "\$launcher" || exit 96
            ;;
        esac
        if [ -L "\$launcher" ]; then
          kind=symlink
          target="\$(readlink -- "\$launcher")"
        else
          kind=file
          target=''
        fi
        identity="\$(stat -c '%a|%d|%i' "\$launcher")" || exit 96
        printf '%s|%s|%s' "\$kind" "\$identity" "\$target" >"\${HOME}/launcher-replacement.identity"
        printf '%s' 'yes' >"\${HOME}/launcher-shell-race-hit"
      fi
    done
    ;;
esac
exec "$REAL_RM" "\$@"
EOF
chmod +x "$FAKE_BIN/rm"
trap 'rm -rf -- "$ROOT"' EXIT

run_install() {
  local home="$1"
  shift
  if [ "${1:-}" != "--uninstall" ]; then
    provision_valid_control_host "$home"
  fi
  HOME="$home" PATH="$FAKE_BIN:$PATH" \
    JHW_INSTALL_CODEX_LOG="$home/codex.log" \
    JHW_REGISTRY_DIR="$home/registry" \
    JHW_WORKTREE_ROOT="$home/worktrees" \
    JHW_CONTROL_STATE_DIR="$home/state" \
    JHW_BUILD_HOST="fixture-host" \
    JHW_GITHUB_OWNER="fixture-owner" \
    JHW_PROJECT_NUMBER="1" \
    JHW_REGISTRY_REPOSITORY="fixture-owner/registry" \
    JHW_PREFLIGHT_PROJECT_ITEM_ID="PVTI_fixture" \
    JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER="1" \
    JHW_GUARD_MODE="${JHW_TEST_GUARD_MODE:-enforce}" \
    JHW_TEST_NPM_LOG="$home/npm.log" \
    JHW_TEST_DIAGNOSTIC_OUTPUT="${JHW_TEST_DIAGNOSTIC_OUTPUT:-}" \
    JHW_TEST_DIAGNOSTIC_EXIT="${JHW_TEST_DIAGNOSTIC_EXIT:-78}" \
    JHW_TEST_ROLLBACK_FAIL="${JHW_TEST_ROLLBACK_FAIL:-0}" \
    JHW_TEST_ROLLBACK_AFTER_MUTATION_FAIL="${JHW_TEST_ROLLBACK_AFTER_MUTATION_FAIL:-0}" \
    JHW_TEST_CONCURRENT_HOOKS="${JHW_TEST_CONCURRENT_HOOKS:-}" \
    JHW_TEST_CONCURRENT_MODE="${JHW_TEST_CONCURRENT_MODE:-0644}" \
    JHW_TEST_LINK_RACE_OPERATION="${JHW_TEST_LINK_RACE_OPERATION:-}" \
    JHW_TEST_LINK_RACE_BYTES="${JHW_TEST_LINK_RACE_BYTES:-}" \
    JHW_TEST_LINK_RACE_MODE="${JHW_TEST_LINK_RACE_MODE:-0622}" \
    JHW_TEST_CAPTURE_MODE="${JHW_TEST_CAPTURE_MODE:-}" \
    JHW_TEST_ROUND5_MODE="${JHW_TEST_ROUND5_MODE:-}" \
    JHW_TEST_LAUNCHER_RACE_MODE="${JHW_TEST_LAUNCHER_RACE_MODE:-}" \
    JHW_TEST_SUBSTITUTE_TARGET="${JHW_TEST_SUBSTITUTE_TARGET:-}" \
    bash "$INSTALL" "$@" >"$home/install.log" 2>&1
}

run_default_install() {
  local home="$1"
  local -a explicit_guard=()
  provision_valid_control_host "$home"
  if [ -n "${JHW_TEST_DEFAULT_GUARD_MODE:-}" ]; then
    explicit_guard=("JHW_GUARD_MODE=$JHW_TEST_DEFAULT_GUARD_MODE")
  fi
  env \
    -u JHW_REGISTRY_DIR -u JHW_REGISTRY_REMOTE -u JHW_REGISTRY_BRANCH \
    -u JHW_WORKTREE_ROOT -u JHW_CONTROL_STATE_DIR -u JHW_BUILD_HOST \
    -u JHW_GITHUB_OWNER -u JHW_PROJECT_NUMBER -u JHW_REGISTRY_REPOSITORY \
    -u JHW_PREFLIGHT_PROJECT_ITEM_ID -u JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER \
    -u JHW_GUARD_MODE -u JHW_GUARD_ALLOW_OBSERVE \
    "${explicit_guard[@]}" \
    HOME="$home" PATH="$FAKE_BIN:$PATH" JHW_INSTALL_CODEX_LOG="$home/codex.log" \
    bash "$INSTALL" >"$home/install.log" 2>&1
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

assert_exact_owned_hook_groups() {
  local hooks_file="$1" home="$2"
  node - "$hooks_file" "$home" <<'EOF'
const fs = require("node:fs");
const [hooksFile] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
  const expected = {
    hooks: [{
      type: "command",
      command: `"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${event}`,
      timeout: 12,
    }],
  };
  const groups = document.hooks?.[event];
  if (!Array.isArray(groups) || JSON.stringify(groups[0]) !== JSON.stringify(expected)) {
    console.error(`missing exact first ${event} group`);
    process.exit(1);
  }
}

EOF
}

write_owned_hooks_fixture() {
  local hooks_file="$1" home="$2" include_owned="$3"
  node - "$hooks_file" "$home" "$include_owned" <<'EOF'
const fs = require("node:fs");
const [file, , includeOwned] = process.argv.slice(2);
const hooks = {
  SessionStart: [{ hooks: [{ type: "command", command: "/foreign/session", timeout: 4 }] }],
};
if (includeOwned === "yes") {
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
    hooks[event] = [{
      hooks: [{
        type: "command",
        command: `"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${event}`,
        timeout: 12,
      }],
    }];
  }
}
fs.writeFileSync(file, JSON.stringify({ foreign: "preserve", hooks }));
EOF
}

assert_no_hook_transaction_evidence() {
  local home="$1"
  [ -z "$(find "$home/.codex" -maxdepth 1 -mindepth 1 \
    \( -name '.hooks.json.jhw-rollback.*' -o -name '.hooks.json.jhw-published.*' -o \
       -name '.hooks.json.jhw-txn.*' \))" ] || {
    echo "confirmed transaction left private hook evidence" >&2
    return 1
  }
}

find_hook_transaction() {
  local home="$1"
  find "$home/.codex" -maxdepth 1 -mindepth 1 -type d -name '.hooks.json.jhw-txn.*'
}

find_hook_link_transaction() {
  local home="$1"
  [ -d "$home/.local/bin" ] || return 0
  find "$home/.local/bin" -maxdepth 1 -mindepth 1 -type d -name '.jhw-control-hook-link-txn.*'
}

assert_no_hook_link_transaction_evidence() {
  local home="$1"
  [ -z "$(find_hook_link_transaction "$home")" ] || {
    echo "confirmed launcher transaction left private evidence" >&2
    return 1
  }
}

assert_launcher_matches_recorded_identity() {
  local launcher="$1" record="$2"
  [ -f "$record" ] || {
    echo "missing independently recorded launcher identity: $record" >&2
    return 1
  }
  node - "$launcher" "$record" <<'EOF'
const fs = require("node:fs");
const [launcher, record] = process.argv.slice(2);
const [kind, mode, dev, ino, target] = fs.readFileSync(record, "utf8").split("|");
let info;
try { info = fs.lstatSync(launcher); } catch { process.exit(1); }
const actualKind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" :
  info.isDirectory() ? "directory" : info.isFIFO() ? "fifo" : "nonregular";
if (actualKind !== kind || (info.mode & 0o777).toString(8) !== mode ||
    Number(info.dev) !== Number(dev) || Number(info.ino) !== Number(ino)) process.exit(1);
if ((info.isSymbolicLink() ? fs.readlinkSync(launcher) : "") !== target) process.exit(1);
EOF
}

assert_private_hook_transaction() {
  local home="$1" original_kind="$2" original_mode="$3" candidate_mode="${4:-}" require_published="${5:-yes}"
  local expected_stage="${6:-concurrent|ambiguous}" transaction
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ "$(printf '%s\n' "$transaction" | wc -l)" -eq 1 ] || {
    echo "expected exactly one hook transaction directory" >&2
    return 1
  }
  [ "$(stat -c '%a' "$transaction")" = "700" ] || return 1
  for evidence in manifest.json; do
    [ -f "$transaction/$evidence" ] && [ ! -L "$transaction/$evidence" ] &&
      [ "$(stat -c '%a' "$transaction/$evidence")" = "600" ] || {
        echo "missing private transaction evidence: $evidence" >&2
        return 1
      }
  done
  if [ "$require_published" = "yes" ]; then
    [ -f "$transaction/published" ] && [ ! -L "$transaction/published" ] &&
      [ "$(stat -c '%a' "$transaction/published")" = "600" ] || return 1
  fi
  if [ "$original_kind" = "file" ]; then
    [ -f "$transaction/original" ] && [ "$(stat -c '%a' "$transaction/original")" = "600" ] || return 1
  else
    [ -f "$transaction/original-absent" ] && [ "$(stat -c '%a' "$transaction/original-absent")" = "600" ] || return 1
  fi
  if [ -n "$candidate_mode" ]; then
    [ -f "$transaction/candidate" ] && [ "$(stat -c '%a' "$transaction/candidate")" = "600" ] || return 1
  fi
  node - "$transaction/manifest.json" "$original_kind" "$original_mode" "$candidate_mode" "$require_published" "$expected_stage" <<'EOF'
const fs = require("node:fs");
const [file, originalKind, originalMode, candidateMode, requirePublished, expectedStage] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
if (manifest.version !== 2 || manifest.original?.kind !== originalKind) process.exit(1);
if ((manifest.original?.mode ?? "") !== originalMode) process.exit(1);
if (originalKind === "file" &&
    (!Number.isSafeInteger(manifest.original?.dev) || !Number.isSafeInteger(manifest.original?.ino))) process.exit(1);
if (requirePublished === "yes" && (!manifest.published || typeof manifest.published.mode !== "string")) process.exit(1);
if (candidateMode && manifest.candidate?.mode !== candidateMode) process.exit(1);
if (!(new RegExp(expectedStage)).test(manifest.stage)) process.exit(1);
EOF
  grep -qF "$transaction" "$home/install.log" || {
    echo "operator guidance omitted transaction path" >&2
    return 1
  }
}

test_registration_capture_publish_race_never_clobbers_winner() {
  local scenario home hooks winner original_kind original_mode capture_mode transaction
  for scenario in existing missing; do
    home="$ROOT/register-link-race-$scenario-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$scenario" = "existing" ]; then
      printf '%s' '{ "hooks" : { "SessionStart" : [{"hooks":[{"type":"command","command":"/foreign/original","timeout":4.00}]}] }, "n" : 1.20e+2 }' >"$hooks"
      chmod 0640 "$hooks"
      original_kind="file"
      original_mode="624"
      capture_mode="0624"
    else
      original_kind="missing"
      original_mode=""
      capture_mode=""
    fi
    winner="registration-race-winner-$scenario"

    if JHW_TEST_LINK_RACE_OPERATION=register JHW_TEST_LINK_RACE_BYTES="$winner" \
        JHW_TEST_LINK_RACE_MODE=0622 JHW_TEST_CAPTURE_MODE="$capture_mode" run_install "$home"; then
      echo "$scenario registration link race unexpectedly completed" >&2
      return 1
    fi
    assert_file_text "$hooks" "$winner"
    [ "$(stat -c '%a' "$hooks")" = "622" ] || return 1
    [ -f "$home/link-race-hit" ] || {
      echo "$scenario registration did not reach exclusive activation" >&2
      return 1
    }
    if [ "$scenario" = "existing" ]; then
      [ -f "$home/capture-mode-hit" ] || return 1
    fi
    [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
    assert_private_hook_transaction "$home" "$original_kind" "$original_mode"
    transaction="$(find_hook_transaction "$home")"
    if [ "$scenario" = "existing" ]; then
      grep -qF '"mode":"624"' "$transaction/manifest.json" || return 1
    fi
    ! grep -qF '설치 완료!' "$home/install.log" || return 1
  done
}

test_rollback_capture_restore_race_never_clobbers_winner() {
  local scenario home hooks winner original_kind original_mode candidate_mode
  for scenario in existing missing; do
    home="$ROOT/rollback-link-race-$scenario-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$scenario" = "existing" ]; then
      printf '%s' '{ "hooks" : { "SessionStart" : [{"hooks":[{"type":"command","command":"/foreign/original","timeout":4.00}]}] }, "n" : 1.20e+2 }' >"$hooks"
      chmod 0640 "$hooks"
      original_kind="file"
      original_mode="640"
      candidate_mode="640"
    else
      original_kind="missing"
      original_mode=""
      candidate_mode="644"
    fi
    winner="rollback-race-winner-$scenario"

    if [ "$scenario" = "missing" ]; then
      if JHW_TEST_LINK_RACE_OPERATION=rollback JHW_TEST_LINK_RACE_BYTES="$winner" \
          JHW_TEST_LINK_RACE_MODE=0622 JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' \
          JHW_TEST_DIAGNOSTIC_EXIT=78 JHW_TEST_CONCURRENT_HOOKS='rollback-candidate-state' \
          JHW_TEST_CONCURRENT_MODE=0644 run_install "$home"; then
        echo "missing rollback link race unexpectedly completed" >&2
        return 1
      fi
    else
      if JHW_TEST_LINK_RACE_OPERATION=rollback JHW_TEST_LINK_RACE_BYTES="$winner" \
          JHW_TEST_LINK_RACE_MODE=0622 JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' \
          JHW_TEST_DIAGNOSTIC_EXIT=78 run_install "$home"; then
        echo "existing rollback link race unexpectedly completed" >&2
        return 1
      fi
    fi
    assert_file_text "$hooks" "$winner"
    [ "$(stat -c '%a' "$hooks")" = "622" ] || return 1
    [ -f "$home/link-race-hit" ] || {
      echo "$scenario rollback did not reach exclusive restoration" >&2
      return 1
    }
    [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
    assert_private_hook_transaction "$home" "$original_kind" "$original_mode" "$candidate_mode"
    ! grep -qF '설치 완료!' "$home/install.log" || return 1
  done
}

test_parse_failure_restore_race_preserves_winner_and_backup() {
  local home="$ROOT/parse-restore-link-race-home" hooks raw backup transaction
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  raw='{"hooks":{"PreToolUse":["private-original"],'
  printf '%s' "$raw" >"$hooks"
  chmod 0640 "$hooks"

  if JHW_TEST_LINK_RACE_OPERATION=register JHW_TEST_LINK_RACE_BYTES='parse-race-winner' \
      JHW_TEST_LINK_RACE_MODE=0622 run_install "$home"; then
    echo "parse restore race unexpectedly completed" >&2
    return 1
  fi
  assert_file_text "$hooks" 'parse-race-winner'
  [ "$(stat -c '%a' "$hooks")" = "622" ] || return 1
  [ -f "$home/link-race-hit" ] || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
  assert_private_hook_transaction "$home" file 640 "" no
  transaction="$(find_hook_transaction "$home")"
  assert_file_text "$transaction/original" "$raw"
  backup="$(find "$home/.codex" -maxdepth 1 -type f -name 'hooks.json.bak.*')"
  [ -n "$backup" ] && [ "$(stat -c '%a' "$backup")" = "600" ] || return 1
  assert_file_text "$backup" "$raw"
}

test_fresh_install_creates_both_control_links_and_exact_hooks() {
  local home="$ROOT/fresh-control-hooks-home"
  make_tui_roots "$home"

  if ! run_install "$home"; then
    cat "$home/install.log" >&2
    return 1
  fi

  [ -L "$home/.local/bin/jhw-control" ] || { echo "jhw-control link missing" >&2; return 1; }
  [ "$(readlink -f -- "$home/.local/bin/jhw-control")" = "$REPO_ROOT/mcp-server/dist/control/cli.js" ] || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || { echo "jhw-control-hook link missing" >&2; return 1; }
  [ "$(readlink -f -- "$home/.local/bin/jhw-control-hook")" = "$REPO_ROOT/scripts/jhw-control-hook" ] || return 1
  assert_exact_owned_hook_groups "$home/.codex/hooks.json" "$home"
  assert_no_hook_transaction_evidence "$home"
}

test_install_orders_guard_transaction_and_runs_public_preflight() {
  local home="$ROOT/guard-order-home" control hook skills mcp registered preflight complete
  make_tui_roots "$home"

  run_install "$home"

  control="$(grep -nF "$home/.local/bin/jhw-control →" "$home/install.log" | cut -d: -f1)"
  hook="$(grep -nF "$home/.local/bin/jhw-control-hook →" "$home/install.log" | cut -d: -f1)"
  skills="$(grep -nF '[4/6] 스킬 심링크' "$home/install.log" | cut -d: -f1)"
  mcp="$(grep -nF '[5/6] MCP 서버 등록' "$home/install.log" | cut -d: -f1)"
  registered="$(grep -nF 'Codex: Guard hook 그룹 등록' "$home/install.log" | cut -d: -f1)"
  preflight="$(grep -nF '"command":"guard preflight"' "$home/install.log" | cut -d: -f1)"
  complete="$(grep -nF '설치 완료!' "$home/install.log" | cut -d: -f1)"
  [ -n "$control" ] && [ -n "$hook" ] && [ -n "$skills" ] && [ -n "$mcp" ] &&
    [ -n "$registered" ] && [ -n "$preflight" ] && [ -n "$complete" ] || {
      echo "installer did not expose the complete Guard transaction" >&2
      return 1
    }
  [ "$control" -lt "$skills" ] && [ "$hook" -lt "$skills" ] &&
    [ "$skills" -lt "$mcp" ] && [ "$mcp" -lt "$registered" ] &&
    [ "$registered" -lt "$preflight" ] && [ "$preflight" -lt "$complete" ] || {
      echo "installer Guard transaction is out of order" >&2
      return 1
    }
  grep -q '^app-server --stdio$' "$home/codex.log" || {
    echo "installer did not invoke the public Codex runtime inspector" >&2
    return 1
  }
  grep -q 'Codex /hooks' "$home/install.log" || return 1
  grep -q 'NO-GO' "$home/install.log" || {
    echo "expected fail-closed Guard preflight result was hidden" >&2
    return 1
  }
}

test_install_aborts_on_guard_diagnostic_execution_failure() {
  local home="$ROOT/guard-diagnostic-failure-home"
  make_tui_roots "$home"

  if JHW_TEST_GUARD_MODE="invalid-mode" run_install "$home"; then
    echo "installer ignored a Guard diagnostic execution failure" >&2
    cat "$home/install.log" >&2
    return 1
  fi
  ! grep -qF '설치 완료!' "$home/install.log" || {
    echo "diagnostic execution failure emitted completion" >&2
    return 1
  }
  [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || {
    echo "diagnostic execution failure left a newly installed hook launcher" >&2
    return 1
  }
  [ ! -e "$home/.codex/hooks.json" ] || {
    echo "diagnostic execution failure left orphan hook groups" >&2
    return 1
  }
  assert_no_hook_transaction_evidence "$home"
}

test_install_rejects_malformed_diagnostic_and_rolls_back_hooks() {
  local home="$ROOT/malformed-diagnostic-home"
  make_tui_roots "$home"

  if JHW_TEST_DIAGNOSTIC_OUTPUT='not-json-private-marker' JHW_TEST_DIAGNOSTIC_EXIT=78 run_install "$home"; then
    echo "installer accepted malformed Guard diagnostic output" >&2
    return 1
  fi
  [ ! -e "$home/.codex/hooks.json" ] || {
    echo "malformed diagnostic left orphan hook groups" >&2
    return 1
  }
  [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
  ! grep -qF 'not-json-private-marker' "$home/install.log" || {
    echo "malformed Guard diagnostic bytes leaked into installer output" >&2
    return 1
  }
}

test_install_requires_complete_guard_diagnostic_schema() {
  local scenario home output rc
  for scenario in success-envelope no-go-envelope missing-installed-axes; do
    home="$ROOT/guard-diagnostic-schema-$scenario-home"
    make_tui_roots "$home"
    rc=78
    case "$scenario" in
      success-envelope)
        rc=0
        output='{"command":"guard preflight","result":{"private_marker":"success-envelope-private-marker"}}'
        ;;
      no-go-envelope)
        output='{"command":"guard preflight","result":{"status":"NO-GO","code":"GUARD_UNAVAILABLE","private_marker":"no-go-envelope-private-marker"}}'
        ;;
      missing-installed-axes)
        output='{"command":"guard preflight","result":{"status":"NO-GO","code":"GUARD_UNAVAILABLE","diagnostics":{"protocol_version":1,"runtime_mode":"enforce","request_state":{"safety":"not_initialized","counts":{"PENDING":0,"APPROVED":0,"CONSUMED":0,"COMPLETED":0,"FAILED":0,"EXPIRED":0,"total":0}},"digest_key":{"safety":"not_initialized"},"registry_claims":{"availability":"available"},"adapter_coverage":{"claude":{"prompt_origin":"missing","pre_tool_block":"missing","post_tool_correlation":"missing","execution_recheck":"pending","enforced":false},"codex":{"prompt_origin":"missing","pre_tool_block":"missing","post_tool_correlation":"missing","execution_recheck":"pending","enforced":false},"gemini":{"prompt_origin":"unsupported","pre_tool_block":"unsupported","post_tool_correlation":"unsupported","execution_recheck":"pending","enforced":false},"opencode":{"prompt_origin":"unsupported","pre_tool_block":"unsupported","post_tool_correlation":"unsupported","execution_recheck":"pending","enforced":false}}}}}'
        ;;
    esac

    if JHW_TEST_DIAGNOSTIC_OUTPUT="$output" JHW_TEST_DIAGNOSTIC_EXIT="$rc" run_install "$home"; then
      echo "installer accepted incomplete Guard diagnostic: $scenario" >&2
      return 1
    fi
    [ ! -e "$home/.codex/hooks.json" ] || return 1
    [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || return 1
    ! grep -qF '설치 완료!' "$home/install.log" || return 1
    ! grep -qF 'private-marker' "$home/install.log" || {
      echo "unvalidated Guard diagnostic bytes leaked into installer output: $scenario" >&2
      return 1
    }
  done
}

test_preflight_failure_restores_exact_prior_hook_state() {
  local scenario home hooks before
  for scenario in foreign preexisting-owned; do
    home="$ROOT/rollback-$scenario-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$scenario" = "foreign" ]; then
      printf '%s' '{ "hooks" : { "SessionStart" : [{"hooks":[{"type":"command","command":"/foreign/keep","timeout":4.00}]}] }, "n" : 1.20e+2 }' >"$hooks"
    else
      mkdir -p "$home/.local/bin"
      ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$home/.local/bin/jhw-control-hook"
      node - "$hooks" "$home" <<'EOF'
const fs = require("node:fs");
const [file, home] = process.argv.slice(2);
fs.writeFileSync(file, `{ "hooks" : { "UserPromptSubmit" : [{"hooks":[{"type":"command","command":${JSON.stringify(`${home}/.local/bin/jhw-control-hook --adapter codex --event UserPromptSubmit`)},"timeout":12}]}], "SessionStart" : [{"hooks":[{"type":"command","command":"/foreign/keep","timeout":4}]}] } }`);
EOF
    fi
    chmod 0640 "$hooks"
    before="$(sha256sum "$hooks")"

    if JHW_TEST_GUARD_MODE="invalid-mode" run_install "$home"; then
      echo "$scenario preflight failure unexpectedly completed" >&2
      return 1
    fi
    [ "$(sha256sum "$hooks")" = "$before" ] || {
      echo "$scenario preflight failure did not restore exact hook bytes" >&2
      return 1
    }
    [ "$(stat -c '%a' "$hooks")" = "640" ] || return 1
    assert_no_hook_transaction_evidence "$home"
    if [ "$scenario" = "foreign" ]; then
      [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || return 1
    else
      [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
      [ "$(readlink -f -- "$home/.local/bin/jhw-control-hook")" = "$REPO_ROOT/scripts/jhw-control-hook" ] || return 1
    fi
  done
}

test_default_unprovisioned_install_removes_owned_guard_hooks_and_preserves_foreign_hooks() {
  local home="$ROOT/default-unprovisioned-home" hooks expected
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  expected="$home/hooks.expected.json"
  write_owned_hooks_fixture "$hooks" "$home" yes
  chmod 0640 "$hooks"
  write_owned_hooks_fixture "$expected" "$home" no

  run_default_install "$home"

  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
  [ "$(readlink -f -- "$home/.local/bin/jhw-control-hook")" = "$REPO_ROOT/scripts/jhw-control-hook" ] || return 1
  if ! cmp -s -- "$expected" "$hooks"; then
    echo "default unprovisioned install left owned Guard hooks active or changed foreign hooks" >&2
    diff -u -- "$expected" "$hooks" >&2 || true
    return 1
  fi
  [ "$(stat -c '%a' "$hooks")" = "640" ] || return 1
  assert_no_hook_transaction_evidence "$home"
  grep -q '"code":"INVALID_CONFIG"' "$home/install.log" || {
    echo "default install did not reach the public Guard diagnostic" >&2
    return 1
  }
  grep -qF 'UNPROTECTED' "$home/install.log" || return 1
  grep -qF 'Project Control' "$home/install.log" || return 1
  grep -qF '설치 완료!' "$home/install.log" || return 1
  if grep -Eiq '"enforced":true|Guard[^[:alnum:]]+(protected|enforced)|보호 완료' "$home/install.log"; then
    echo "default unprovisioned install claimed protection" >&2
    return 1
  fi
}

test_no_coordinates_with_explicit_invalid_guard_mode_aborts() {
  local home="$ROOT/default-invalid-guard-home"
  make_tui_roots "$home"

  if JHW_TEST_DEFAULT_GUARD_MODE="invalid-mode" run_default_install "$home"; then
    echo "explicit invalid Guard mode was misclassified as unprovisioned" >&2
    return 1
  fi
  ! grep -qF 'UNPROTECTED' "$home/install.log" || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
  [ ! -e "$home/.codex/hooks.json" ] || return 1
  [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || return 1
}

test_rollback_failure_preserves_launcher_and_private_recovery_snapshot() {
  local scenario home hooks original_kind original_mode transaction
  for scenario in file missing; do
    home="$ROOT/rollback-handler-failure-$scenario-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$scenario" = "file" ]; then
      printf '%s' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/foreign/keep","timeout":4}]}]}}' >"$hooks"
      chmod 0640 "$hooks"
      original_kind="file"
      original_mode="640"
    else
      original_kind="missing"
      original_mode=""
    fi

    if JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
        JHW_TEST_ROLLBACK_FAIL=1 run_install "$home"; then
      echo "injected $scenario hook rollback failure unexpectedly completed" >&2
      return 1
    fi
    [ -L "$home/.local/bin/jhw-control-hook" ] || {
      echo "$scenario rollback failure removed the launcher while changed groups remained" >&2
      return 1
    }
    assert_private_hook_transaction "$home" "$original_kind" "$original_mode" "" yes '^activated$'
    transaction="$(find_hook_transaction "$home")"
    grep -qF "$transaction" "$home/install.log" || return 1
    grep -qF 'current path를 단정하지 않습니다' "$home/install.log" || return 1
    ! grep -qF '변경된 hook config' "$home/install.log" || return 1
    ! grep -qF '새 hooks.json과 launcher를 함께 보존' "$home/install.log" || return 1
    ! grep -qF '설치 완료!' "$home/install.log" || return 1
  done
}

test_rollback_capture_preserves_concurrent_hook_changes() {
  local scenario home hooks original original_kind original_mode transaction published_mode concurrent
  concurrent='{ "hooks" : { "SessionStart" : [{"hooks":[{"type":"command","command":"/concurrent/private-marker","timeout":8.00}]}] }, "generation" : 9.10e+1 }'
  for scenario in file missing; do
    home="$ROOT/rollback-cas-$scenario-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$scenario" = "file" ]; then
      printf '%s' '{ "hooks" : { "SessionStart" : [{"hooks":[{"type":"command","command":"/foreign/original","timeout":4.00}]}] }, "generation" : 1.20e+1 }' >"$hooks"
      chmod 0640 "$hooks"
      original="$home/original-hooks.witness"
      cp -- "$hooks" "$original"
      original_kind="file"
      original_mode="640"
    else
      original_kind="missing"
      original_mode=""
    fi

    if JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
        JHW_TEST_CONCURRENT_HOOKS="$concurrent" JHW_TEST_CONCURRENT_MODE=0644 run_install "$home"; then
      echo "$scenario concurrent-hook install unexpectedly completed" >&2
      return 1
    fi

    assert_file_text "$hooks" "$concurrent"
    [ "$(stat -c '%a' "$hooks")" = "644" ] || {
      echo "$scenario concurrent hook mode was overwritten" >&2
      return 1
    }
    [ -L "$home/.local/bin/jhw-control-hook" ] || {
      echo "$scenario rollback mismatch removed the repository launcher" >&2
      return 1
    }
    assert_private_hook_transaction "$home" "$original_kind" "$original_mode" 644 yes '^rollback-mismatch-republished$'
    transaction="$(find_hook_transaction "$home")"
    cmp -s -- "$transaction/published" "$home/published-hooks.witness" || {
      echo "$scenario published-state evidence is not byte-exact" >&2
      return 1
    }
    published_mode="$(cat -- "$home/published-hooks.mode")"
    node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(m.published.mode!==process.argv[2]) process.exit(1)' \
      "$transaction/manifest.json" "$published_mode" || return 1
    grep -qF "$transaction" "$home/install.log" || {
      echo "$scenario CAS guidance omitted the published-state evidence path" >&2
      return 1
    }
    grep -qF 'concurrent/ambiguous' "$home/install.log" || {
      echo "$scenario rollback mismatch guidance was hidden" >&2
      return 1
    }
    if [ "$scenario" = "file" ]; then
      cmp -s -- "$transaction/original" "$original" || return 1
    fi
    ! grep -qF '설치 완료!' "$home/install.log" || return 1
  done
}

test_rollback_same_bytes_new_inode_is_not_owned_publication() {
  local home hooks original transaction
  local published_identity replacement_identity
  home="$ROOT/rollback-same-bytes-new-inode-home"
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  original="$home/original-hooks.witness"
  printf '%s' '{ "hooks" : { "SessionStart" : [{"hooks":[{"type":"command","command":"/foreign/original","timeout":4.00}]}] }, "generation" : 1.20e+1 }' >"$hooks"
  chmod 0640 "$hooks"
  cp -- "$hooks" "$original"

  if JHW_TEST_ROUND5_MODE=rollback-same-bytes-new-inode \
      JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
      run_install "$home"; then
    echo "same-bytes replacement inode was mistaken for the owned publication" >&2
    return 1
  fi

  [ -f "$home/published-hooks.identity" ] && [ -f "$home/replacement-hooks.identity" ] || {
    echo "rollback test did not record both publication identities" >&2
    return 1
  }
  published_identity="$(tr -d '\n' <"$home/published-hooks.identity")"
  replacement_identity="$(tr -d '\n' <"$home/replacement-hooks.identity")"
  [ -n "$published_identity" ] && [ -n "$replacement_identity" ] &&
    [ "$published_identity" != "$replacement_identity" ] || {
      echo "same-bytes fixture did not replace the publication inode" >&2
      return 1
    }
  [ -f "$hooks" ] && [ "$hooks" -ef "$home/replacement-hooks.inode-witness" ] || {
    echo "rollback clobbered the independently anchored replacement inode" >&2
    return 1
  }
  [ "$(stat -c '%a' "$hooks")" = "640" ] || return 1
  cmp -s -- "$hooks" "$home/published-hooks.witness" || {
    echo "replacement fixture did not retain the exact published bytes" >&2
    return 1
  }
  ! cmp -s -- "$hooks" "$original" || {
    echo "stale original hooks were restored over the replacement inode" >&2
    return 1
  }

  assert_private_hook_transaction "$home" file 640 640 yes '^rollback-mismatch-republished$'
  transaction="$(find_hook_transaction "$home")"
  [ -f "$transaction/candidate-live" ] &&
    [ "$transaction/candidate-live" -ef "$home/replacement-hooks.inode-witness" ] || {
      echo "rollback did not preserve the replacement inode as candidate evidence" >&2
      return 1
    }
  [ ! "$hooks" -ef "$transaction/captured-live" ] || {
    echo "rollback republished the stale captured original inode" >&2
    return 1
  }
  cmp -s -- "$transaction/published" "$hooks" || return 1
  cmp -s -- "$transaction/candidate" "$hooks" || return 1
  node - "$transaction/manifest.json" "$published_identity" "$replacement_identity" <<'EOF'
const fs = require("node:fs");
const [file, publishedIdentity, replacementIdentity] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const parseIdentity = (value) => value.split(":").map(Number);
const [publishedDev, publishedIno] = parseIdentity(publishedIdentity);
const [replacementDev, replacementIno] = parseIdentity(replacementIdentity);
if (manifest.stage !== "rollback-mismatch-republished") process.exit(1);
if (manifest.published?.kind !== "file" || manifest.published?.mode !== "640") process.exit(1);
if (manifest.candidate?.kind !== "file" || manifest.candidate?.mode !== "640") process.exit(1);
if (manifest.published.dev !== publishedDev || manifest.published.ino !== publishedIno) process.exit(1);
if (manifest.candidate.dev !== replacementDev || manifest.candidate.ino !== replacementIno) process.exit(1);
if (manifest.published.dev === manifest.candidate.dev && manifest.published.ino === manifest.candidate.ino) process.exit(1);
EOF
  [ -L "$home/.local/bin/jhw-control-hook" ] || {
    echo "rollback mismatch removed the recovery launcher" >&2
    return 1
  }
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_launcher_uninstall_races_preserve_replacements() {
  local scenario home launcher expected_target transaction
  for scenario in regular symlink same-target; do
    home="$ROOT/launcher-remove-$scenario-home"
    make_tui_roots "$home"
    mkdir -p "$home/.local/bin"
    launcher="$home/.local/bin/jhw-control-hook"
    ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$launcher"

    if ! JHW_TEST_LAUNCHER_RACE_MODE="uninstall-$scenario" run_install "$home" --uninstall; then
      echo "$scenario launcher uninstall race did not preserve a recoverable foreign result" >&2
      sed -n '1,200p' "$home/install.log" >&2
      transaction="$(find_hook_link_transaction "$home")"
      [ ! -f "$transaction/manifest.json" ] || sed -n '1,80p' "$transaction/manifest.json" >&2
      return 1
    fi
    assert_launcher_matches_recorded_identity "$launcher" "$home/launcher-replacement.identity"
    case "$scenario" in
      regular) assert_file_text "$launcher" "foreign-launcher-regular-uninstall-regular" ;;
      symlink)
        expected_target="$home/foreign-launcher-target"
        [ -L "$launcher" ] && [ "$(readlink -- "$launcher")" = "$expected_target" ] || return 1
        assert_file_text "$expected_target" "foreign-launcher-target-bytes"
        ;;
      same-target)
        [ -L "$launcher" ] &&
          [ "$(readlink -- "$launcher")" = "$REPO_ROOT/scripts/jhw-control-hook" ] || return 1
        ;;
    esac
    assert_no_hook_link_transaction_evidence "$home"
    ! grep -qF "$launcher 심링크 제거" "$home/install.log" || {
      echo "$scenario replacement was falsely reported as the removed owned launcher" >&2
      return 1
    }
  done
}

test_launcher_failed_install_rollback_races_are_no_clobber() {
  local scenario home launcher transaction metadata
  for scenario in regular winner; do
    home="$ROOT/launcher-rollback-$scenario-home"
    make_tui_roots "$home"
    launcher="$home/.local/bin/jhw-control-hook"

    if JHW_TEST_LAUNCHER_RACE_MODE="rollback-$scenario" \
        JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
        run_install "$home"; then
      echo "$scenario launcher rollback race unexpectedly completed" >&2
      return 1
    fi
    ! grep -qF '설치 완료!' "$home/install.log" || return 1

    if [ "$scenario" = "regular" ]; then
      assert_launcher_matches_recorded_identity "$launcher" "$home/launcher-replacement.identity"
      assert_file_text "$launcher" "foreign-launcher-regular-rollback-regular"
      assert_no_hook_link_transaction_evidence "$home"
      continue
    fi

    assert_launcher_matches_recorded_identity "$launcher" "$home/launcher-winner.identity"
    assert_file_text "$launcher" "foreign-launcher-winner"
    transaction="$(find_hook_link_transaction "$home")"
    [ -n "$transaction" ] && [ -f "$transaction/captured-link" ] || {
      echo "launcher winner race did not preserve the captured replacement evidence" >&2
      return 1
    }
    assert_launcher_matches_recorded_identity "$transaction/captured-link" \
      "$home/launcher-replacement.identity"
    assert_file_text "$transaction/captured-link" "foreign-launcher-regular-rollback-winner"
    metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
      inspect-control-hook-link-transaction "$launcher" "$REPO_ROOT/scripts/jhw-control-hook" \
      "$REPO_ROOT" "$transaction")" || return 1
    node -e 'const m=JSON.parse(process.argv[1]); if(m.stage!=="manual-recovery-required") process.exit(1)' "$metadata"
    grep -qF "$transaction/captured-link" "$home/install.log" || return 1
    grep -qF 'manual recovery required' "$home/install.log" || return 1
    ! grep -qF '제거 완료!' "$home/install.log" || return 1
  done
}

test_launcher_transaction_hard_exits_leave_inspectable_evidence() {
  local mode home launcher transaction metadata expected_stage expect_captured first_log
  for mode in capture-hard-exit delete-hard-exit; do
    home="$ROOT/launcher-$mode-home"
    make_tui_roots "$home"
    mkdir -p "$home/.local/bin"
    launcher="$home/.local/bin/jhw-control-hook"
    ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$launcher"

    if JHW_TEST_LAUNCHER_RACE_MODE="$mode" run_install "$home" --uninstall; then
      echo "$mode launcher interruption unexpectedly completed" >&2
      return 1
    fi
    [ -f "$home/launcher-${mode%-hard-exit}-stage-durable" ] || {
      echo "$mode did not reach its durably synced transaction boundary" >&2
      return 1
    }
    transaction="$(find_hook_link_transaction "$home")"
    [ -n "$transaction" ] && [ "$(stat -c '%a' "$transaction")" = "700" ] || return 1
    expected_stage="captured"
    expect_captured=yes
    if [ "$mode" = "delete-hard-exit" ]; then
      expected_stage="delete-intent"
      expect_captured=no
    fi
    metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
      inspect-control-hook-link-transaction "$launcher" "$REPO_ROOT/scripts/jhw-control-hook" \
      "$REPO_ROOT" "$transaction")" || return 1
    node - "$transaction/manifest.json" "$metadata" "$expected_stage" "$expect_captured" \
      "$REPO_ROOT/scripts/jhw-control-hook" "$transaction/captured-link" <<'EOF'
const fs = require("node:fs");
const [file, metadata, expectedStage, expectCaptured, expectedTarget, capturedPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const output = JSON.parse(metadata);
if (manifest.version !== 1 || manifest.live !== "jhw-control-hook" ||
    manifest.expectedTarget !== expectedTarget || manifest.stage !== expectedStage || output.stage !== expectedStage) process.exit(1);
if (manifest.observed?.kind !== "symlink" || manifest.observedTarget !== expectedTarget ||
    manifest.captured?.kind !== "symlink" || manifest.capturedTarget !== expectedTarget) process.exit(1);
if (!manifest.artifacts?.includes("captured-link") || !manifest.identities?.["captured-link"]) process.exit(1);
let captured;
try { captured = fs.lstatSync(capturedPath); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (expectCaptured === "yes") {
  if (!captured?.isSymbolicLink() || Number(captured.dev) !== manifest.captured.dev ||
      Number(captured.ino) !== manifest.captured.ino || fs.readlinkSync(capturedPath) !== expectedTarget) process.exit(1);
  if (manifest.deleteIntent !== undefined) process.exit(1);
} else if (captured || manifest.deleteIntent !== "captured-link") {
  process.exit(1);
}
EOF
    grep -qF "$transaction" "$home/install.log" || return 1
    ! grep -qF '제거 완료!' "$home/install.log" || return 1

    first_log="$home/first-uninstall.log"
    cp -- "$home/install.log" "$first_log"
    if run_install "$home" --uninstall; then
      echo "$mode stale launcher transaction did not block the next uninstall" >&2
      return 1
    fi
    grep -qF "$transaction" "$home/install.log" || return 1
    ! grep -qF '제거 완료!' "$home/install.log" || return 1
    [ -f "$first_log" ] || return 1
  done
}

test_stale_hook_link_transactions_block_install_and_uninstall() {
  local action home stale count
  for action in install uninstall; do
    home="$ROOT/stale-hook-link-$action-home"
    make_tui_roots "$home"
    mkdir -p "$home/.local/bin"
    stale="$home/.local/bin/.jhw-control-hook-link-txn.stale"
    mkdir "$stale"
    chmod 0700 "$stale"
    printf '%s' 'stale-launcher-secret-marker' >"$stale/private-evidence"

    if [ "$action" = "install" ]; then
      if run_install "$home"; then
        echo "install accepted stale hook launcher transaction evidence" >&2
        return 1
      fi
    elif run_install "$home" --uninstall; then
      echo "uninstall accepted stale hook launcher transaction evidence" >&2
      return 1
    fi
    count="$(find "$home/.local/bin" -maxdepth 1 -mindepth 1 -type d \
      -name '.jhw-control-hook-link-txn.*' | wc -l)"
    [ "$count" -eq 1 ] || {
      echo "$action created another launcher transaction beside abandoned evidence" >&2
      return 1
    }
    grep -qF "$stale" "$home/install.log" || return 1
    ! grep -qF 'stale-launcher-secret-marker' "$home/install.log" || return 1
    ! grep -Eq '설치 완료!|제거 완료!' "$home/install.log" || return 1
  done
}

test_rollback_after_mutation_failure_retains_truthful_private_evidence() {
  local scenario home hooks original original_kind original_mode candidate_mode transaction
  for scenario in file missing; do
    home="$ROOT/rollback-after-mutation-$scenario-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$scenario" = "file" ]; then
      printf '%s' '{ "hooks" : { "SessionStart" : [{"hooks":[{"type":"command","command":"/foreign/original","timeout":4.00}]}] }, "generation" : 1.20e+1 }' >"$hooks"
      chmod 0640 "$hooks"
      original="$home/original-hooks.witness"
      cp -- "$hooks" "$original"
      original_kind="file"
      original_mode="640"
      candidate_mode="640"
    else
      original_kind="missing"
      original_mode=""
      candidate_mode="600"
    fi

    if JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
        JHW_TEST_ROLLBACK_AFTER_MUTATION_FAIL=1 run_install "$home"; then
      echo "$scenario after-mutation rollback failure unexpectedly completed" >&2
      return 1
    fi

    [ -L "$home/.local/bin/jhw-control-hook" ] || {
      echo "$scenario unconfirmed rollback removed the launcher" >&2
      return 1
    }
    assert_private_hook_transaction "$home" "$original_kind" "$original_mode" "$candidate_mode" yes '^rollback-restored$'
    transaction="$(find_hook_transaction "$home")"
    if [ "$scenario" = "file" ]; then
      cmp -s -- "$transaction/original" "$original" || return 1
    fi
    grep -qF 'current path를 단정하지 않습니다' "$home/install.log" || {
      echo "$scenario after-mutation failure did not report an unconfirmed outcome" >&2
      return 1
    }
    grep -qF "$transaction" "$home/install.log" || return 1
    if grep -qF '변경된 hook config' "$home/install.log" || grep -qF '새 hooks.json과 launcher를 함께 보존' "$home/install.log"; then
      echo "$scenario unconfirmed outcome made a false current-config claim" >&2
      return 1
    fi
    ! grep -qF '설치 완료!' "$home/install.log" || return 1
  done
}

test_nested_duplicate_hook_keys_fail_closed_without_uninstall_deletion() {
  local variant home hooks raw before backup
  for variant in group-hooks handler-command; do
    home="$ROOT/nested-duplicate-$variant-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$variant" = "group-hooks" ]; then
      raw="{\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"/foreign/keep\",\"timeout\":4}],\"hooks\":[{\"type\":\"command\",\"command\":\"$home/.local/bin/jhw-control-hook --adapter codex --event PreToolUse\",\"timeout\":12}]}]}}"
    else
      raw="{\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"/foreign/keep\",\"command\":\"$home/.local/bin/jhw-control-hook --adapter codex --event PreToolUse\",\"timeout\":12}]}]}}"
    fi
    printf '%s' "$raw" >"$hooks"
    chmod 0640 "$hooks"
    before="$(sha256sum "$hooks")"

    if run_install "$home"; then
      echo "$variant duplicate-key config was accepted for registration" >&2
      return 1
    fi
    [ "$(sha256sum "$hooks")" = "$before" ] || return 1
    [ "$(stat -c '%a' "$hooks")" = "640" ] || return 1
    backup="$(find "$home/.codex" -maxdepth 1 -type f -name 'hooks.json.bak.*')"
    [ -n "$backup" ] && [ "$(stat -c '%a' "$backup")" = "600" ] || return 1
    assert_file_text "$backup" "$raw"

    if run_install "$home" --uninstall; then
      echo "$variant duplicate-key uninstall did not fail closed" >&2
      return 1
    fi
    [ "$(sha256sum "$hooks")" = "$before" ] || {
      echo "$variant duplicate-key foreign group was deleted during uninstall" >&2
      return 1
    }
    [ "$(stat -c '%a' "$hooks")" = "640" ] || return 1
  done
}

test_canonical_hook_command_and_legacy_ownership() {
  local home hooks legacy_home legacy_hooks duplicate_home duplicate_hooks before

  home="$ROOT/canonical-hook-command-home"
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  run_install "$home"
  node - "$hooks" "$home" <<'EOF'
const fs = require("node:fs");
const [file, home] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const document = JSON.parse(text);
for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
  const expectedCommand = `"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${event}`;
  const expected = { hooks: [{ type: "command", command: expectedCommand, timeout: 12 }] };
  const groups = document.hooks?.[event];
  if (!Array.isArray(groups) || JSON.stringify(groups[0]) !== JSON.stringify(expected)) {
    console.error(`canonical ${event} hook is not the first executor`);
    process.exit(1);
  }
  if (groups.filter((group) => JSON.stringify(group) === JSON.stringify(expected)).length !== 1) process.exit(1);
}
if (text.includes(`${home}/.local/bin/jhw-control-hook`)) {
  console.error("hooks.json captured the install-time HOME path");
  process.exit(1);
}
EOF

  run_install "$home" --uninstall
  node - "$hooks" <<'EOF'
const fs = require("node:fs");
const document = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
  if (document.hooks?.[event] !== undefined) process.exit(1);
}
EOF

  legacy_home="$ROOT/legacy-hook-uninstall-home"
  make_tui_roots "$legacy_home"
  legacy_hooks="$legacy_home/.codex/hooks.json"
  node - "$legacy_hooks" "$legacy_home" <<'EOF'
const fs = require("node:fs");
const [file, home] = process.argv.slice(2);
const hooks = {};
for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
  const command = `${home}/.local/bin/jhw-control-hook --adapter codex --event ${event}`;
  const group = (candidate, timeout = 12) => ({ hooks: [{ type: "command", command: candidate, timeout }] });
  hooks[event] = [
    group(command),
    group(command.replace(" --adapter", "  --adapter")),
    group(`env JHW_WRAPPER=1 ${command}`),
    group(command, 13),
    group(`/opt/foreign/jhw-control-hook --adapter codex --event ${event}`),
  ];
}
fs.writeFileSync(file, `${JSON.stringify({ hooks })}\n`);
EOF
  run_install "$legacy_home" --uninstall
  node - "$legacy_hooks" "$legacy_home" <<'EOF'
const fs = require("node:fs");
const [file, home] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(file, "utf8"));
const text = fs.readFileSync(file, "utf8");
for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
  const command = `${home}/.local/bin/jhw-control-hook --adapter codex --event ${event}`;
  const group = (candidate, timeout = 12) => ({ hooks: [{ type: "command", command: candidate, timeout }] });
  const expected = [
    group(command.replace(" --adapter", "  --adapter")),
    group(`env JHW_WRAPPER=1 ${command}`),
    group(command, 13),
    group(`/opt/foreign/jhw-control-hook --adapter codex --event ${event}`),
  ];
  const groups = document.hooks?.[event];
  if (!Array.isArray(groups) || JSON.stringify(groups) !== JSON.stringify(expected)) {
    console.error(`near-match ${event} hook was claimed during legacy uninstall`);
    process.exit(1);
  }
  for (const marker of expected.map((candidate) => JSON.stringify(candidate))) {
    if (text.split(marker).length !== 2) {
      console.error(`near-match ${event} lexical bytes changed during legacy uninstall`);
      process.exit(1);
    }
  }
}
EOF

  duplicate_home="$ROOT/duplicate-canonical-legacy-home"
  make_tui_roots "$duplicate_home"
  duplicate_hooks="$duplicate_home/.codex/hooks.json"
  node - "$duplicate_hooks" "$duplicate_home" <<'EOF'
const fs = require("node:fs");
const [file, home] = process.argv.slice(2);
const event = "PreToolUse";
const group = (command) => ({ hooks: [{ type: "command", command, timeout: 12 }] });
fs.writeFileSync(file, `${JSON.stringify({ hooks: { [event]: [
  group(`"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${event}`),
  group(`${home}/.local/bin/jhw-control-hook --adapter codex --event ${event}`),
] } }, null, 2)}\n`);
EOF
  chmod 0640 "$duplicate_hooks"
  before="$(sha256sum "$duplicate_hooks")"
  if run_install "$duplicate_home"; then
    echo "canonical/legacy duplicate ownership was accepted" >&2
    return 1
  fi
  [ "$(sha256sum "$duplicate_hooks")" = "$before" ] || return 1
  if run_install "$duplicate_home" --uninstall; then
    echo "canonical/legacy duplicate ownership was deleted during uninstall" >&2
    return 1
  fi
  [ "$(sha256sum "$duplicate_hooks")" = "$before" ] || return 1
}

test_guard_first_migration_preserves_foreign_lexical_order() {
  local home hooks first_hash
  home="$ROOT/guard-first-order-home"
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  node - "$hooks" "$home" <<'EOF'
const fs = require("node:fs");
const [file, home] = process.argv.slice(2);
const legacy = (event) => JSON.stringify({ hooks: [{
  type: "command",
  command: `${home}/.local/bin/jhw-control-hook --adapter codex --event ${event}`,
  timeout: 12,
}] });
const text = `{
 "version" : 7.00,
 "hooks" : {
  "UserPromptSubmit" : [
   {"matcher":"\\u0066oreign-user-a","hooks":[{"type":"command","command":"/foreign/user-a","timeout":4.00}]},
   ${legacy("UserPromptSubmit")},
   {"matcher":"foreign-user-b","hooks":[{"type":"command","command":"/foreign/user-b","timeout":5.0e+0}]} ],
  "PreToolUse" : [
   {"matcher":"Bash","hooks":[{"type":"command","command":"/foreign/pre-a","timeout":6.000}]},
   ${legacy("PreToolUse")},
   {"matcher":"Edit","hooks":[{"type":"command","command":"/foreign/pre-b","timeout":7.00}]} ],
  "PostToolUse" : [ ${legacy("PostToolUse")},
   {"hooks":[{"type":"command","command":"/foreign/post-a","timeout":8.0e0}]} ]
 },
 "tail" : {"escaped":"\\u0070reserve","number":1.2300e+2}
}
`;
fs.writeFileSync(file, text);
EOF

  run_install "$home"
  node - "$hooks" "$home" <<'EOF'
const fs = require("node:fs");
const [file, home] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const document = JSON.parse(text);
const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse"];
for (const event of events) {
  const canonical = `"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${event}`;
  const legacy = `${home}/.local/bin/jhw-control-hook --adapter codex --event ${event}`;
  const groups = document.hooks?.[event];
  if (!Array.isArray(groups) || groups[0]?.hooks?.[0]?.command !== canonical) {
    console.error(`Guard is not first for ${event}`);
    process.exit(1);
  }
  const commands = groups.flatMap((group) => group.hooks ?? []).map((handler) => handler.command);
  if (commands.filter((command) => command === canonical).length !== 1 || commands.includes(legacy)) process.exit(1);
}
const markers = [
  '{"matcher":"\\u0066oreign-user-a","hooks":[{"type":"command","command":"/foreign/user-a","timeout":4.00}]}',
  '{"matcher":"foreign-user-b","hooks":[{"type":"command","command":"/foreign/user-b","timeout":5.0e+0}]}',
  '{"matcher":"Bash","hooks":[{"type":"command","command":"/foreign/pre-a","timeout":6.000}]}',
  '{"matcher":"Edit","hooks":[{"type":"command","command":"/foreign/pre-b","timeout":7.00}]}',
  '{"hooks":[{"type":"command","command":"/foreign/post-a","timeout":8.0e0}]}',
];
for (const marker of markers) {
  if (text.split(marker).length !== 2) {
    console.error(`foreign lexical group changed: ${marker}`);
    process.exit(1);
  }
}
for (const [before, after] of [[markers[0], markers[1]], [markers[2], markers[3]]]) {
  if (text.indexOf(before) >= text.indexOf(after)) process.exit(1);
}
if (!text.includes('"tail" : {"escaped":"\\u0070reserve","number":1.2300e+2}')) process.exit(1);
EOF
  first_hash="$(sha256sum "$hooks")"

  run_install "$home"
  [ "$(sha256sum "$hooks")" = "$first_hash" ] || {
    echo "canonical first hook registration was not byte-idempotent" >&2
    return 1
  }

  run_install "$home" --uninstall
  node - "$hooks" <<'EOF'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const document = JSON.parse(text);
const expected = {
  UserPromptSubmit: ["/foreign/user-a", "/foreign/user-b"],
  PreToolUse: ["/foreign/pre-a", "/foreign/pre-b"],
  PostToolUse: ["/foreign/post-a"],
};
for (const [event, commands] of Object.entries(expected)) {
  const actual = document.hooks[event].flatMap((group) => group.hooks).map((handler) => handler.command);
  if (JSON.stringify(actual) !== JSON.stringify(commands)) process.exit(1);
}
if (text.includes('"$HOME/.local/bin/jhw-control-hook"') || !text.includes('"number":1.2300e+2')) process.exit(1);
EOF
}

test_hook_registration_preserves_foreign_groups_and_is_idempotent() {
  local home="$ROOT/foreign-hook-order-home" hooks original before_foreign expected first_hash original_hash
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  cat >"$hooks" <<'EOF'
{
 "version" : 7.00,
 "hooks" : {
  "SessionStart" : [ {"hooks":[{"type":"command","command":"/foreign/session","timeout":4.0e0}]} ],
  "UserPromptSubmit" : [
   {"matcher":"\u0066oreign-prompt","hooks":[{"type":"command","command":"/foreign/prompt","timeout":9.00}],"foreign_order":"\u0066irst"}  ],
  "PreToolUse" : [ {"matcher":"Bash","hooks":[{"type":"command","command":"/foreign/pre-first","timeout":5}]},
   {"matcher":"Edit","hooks":[{"type":"command","command":"/foreign/pre-second","timeout":6.0e+0}]}   ],
  "PostToolUse" : [ {"hooks":[{"type":"command","command":"/foreign/post","timeout":7.000}]} ]
 },
 "tail" : {"escaped":"\u0070reserve","number":1.2300e+2}
}
EOF
  before_foreign="$(cat -- "$hooks")"
  original_hash="$(sha256sum "$hooks")"
  original="$home/hooks.original"
  cp -- "$hooks" "$original"

  run_install "$home"
  assert_exact_owned_hook_groups "$hooks" "$home"
  expected="$(node - "$home" "$original" <<'EOF'
const fs = require("node:fs");
const [, original] = process.argv.slice(2);
let text = fs.readFileSync(original, "utf8");
const insertions = [
  ["UserPromptSubmit", '{"matcher":"\\u0066oreign-prompt","hooks":[{"type":"command","command":"/foreign/prompt","timeout":9.00}],"foreign_order":"\\u0066irst"}'],
  ["PreToolUse", '{"matcher":"Bash","hooks":[{"type":"command","command":"/foreign/pre-first","timeout":5}]}'],
  ["PostToolUse", '{"hooks":[{"type":"command","command":"/foreign/post","timeout":7.000}]}'],
];
for (const [event, needle] of insertions) {
  const group = { hooks: [{
    type: "command",
    command: `"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${event}`,
    timeout: 12,
  }] };
  if (text.split(needle).length !== 2) process.exit(1);
  text = text.replace(needle, `${JSON.stringify(group)},${needle}`);
}
process.stdout.write(text);
EOF
)"
  [ "$(cat -- "$hooks")" = "$expected" ] || {
    echo "foreign hook lexical bytes changed outside exact inserted spans" >&2
    diff -u <(printf '%s' "$expected") <(cat -- "$hooks") >&2 || true
    return 1
  }
  first_hash="$(sha256sum "$hooks")"

  run_install "$home"
  [ "$(sha256sum "$hooks")" = "$first_hash" ] || {
    echo "idempotent hook registration changed hooks.json bytes" >&2
    return 1
  }

  run_install "$home" --uninstall
  [ "$(sha256sum "$hooks")" = "$original_hash" ] || {
    echo "exact hook uninstall did not restore original foreign lexical bytes" >&2
    return 1
  }
}

test_control_hook_collision_fails_closed() {
  local kind home target outside before outside_before
  for kind in file symlink indirect dotdot; do
    home="$ROOT/control-hook-$kind-collision-home"
    make_tui_roots "$home"
    mkdir -p "$home/.local/bin"
    target="$home/.local/bin/jhw-control-hook"
    case "$kind" in
      file)
        printf 'foreign-hook-file' >"$target"
        before="$(sha256sum "$target")"
        ;;
      symlink)
        outside="$home/foreign-launcher-target"
        printf 'foreign-hook-symlink-target' >"$outside"
        ln -s "$outside" "$target"
        before="$(readlink -- "$target")"
        ;;
      indirect)
        outside="$home/indirect-launcher-hop"
        ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$outside"
        outside_before="$(readlink -- "$outside")"
        ln -s "$outside" "$target"
        before="$(readlink -- "$target")"
        ;;
      dotdot)
        ln -s "$REPO_ROOT/scripts/../scripts/jhw-control-hook" "$target"
        before="$(readlink -- "$target")"
        ;;
    esac

    if run_install "$home"; then
      echo "external jhw-control-hook $kind collision did not abort" >&2
      return 1
    fi
    if [ "$kind" = "file" ]; then
      [ ! -L "$target" ] && [ "$(sha256sum "$target")" = "$before" ] || return 1
    else
      [ -L "$target" ] && [ "$(readlink -- "$target")" = "$before" ] || return 1
      if [ "$kind" = "symlink" ]; then
        assert_file_text "$outside" "foreign-hook-symlink-target"
      elif [ "$kind" = "indirect" ]; then
        [ -L "$outside" ] && [ "$(readlink -- "$outside")" = "$outside_before" ] || return 1
      fi
    fi
  done
}

test_uninstall_removes_only_exact_owned_hook_artifacts() {
  local home="$ROOT/uninstall-exact-hook-home" hooks
  make_tui_roots "$home"
  mkdir -p "$home/.local/bin"
  ln -s "$REPO_ROOT/mcp-server/dist/control/cli.js" "$home/.local/bin/jhw-control"
  ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$home/.local/bin/jhw-control-hook"
  hooks="$home/.codex/hooks.json"
  node - "$hooks" "$home" <<'EOF'
const fs = require("node:fs");
const [hooksFile, home] = process.argv.slice(2);
const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse"];
const document = { hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{
  type: "command",
  command: `${home}/.local/bin/jhw-control-hook --adapter codex --event ${event}`,
  timeout: 12,
}] }]])) };
document.hooks.PreToolUse.push(
  { hooks: [{ type: "command", command: "/foreign/other-command", timeout: 12 }] },
  { hooks: [{ type: "command", command: `${home}/.local/bin/jhw-control-hook --adapter codex --event PreToolUse`, timeout: 13 }] },
  {
    hooks: [
      { type: "command", command: `${home}/.local/bin/jhw-control-hook --adapter codex --event PreToolUse`, timeout: 12 },
      { type: "command", command: "/foreign/second-handler", timeout: 12 },
    ],
  },
  { matcher: "Bash", hooks: [{ type: "command", command: `${home}/.local/bin/jhw-control-hook --adapter codex --event PreToolUse`, timeout: 12 }] },
);
fs.writeFileSync(hooksFile, `${JSON.stringify(document, null, 2)}\n`);
EOF

  run_install "$home" --uninstall

  [ ! -e "$home/.local/bin/jhw-control" ] && [ ! -L "$home/.local/bin/jhw-control" ] || {
    echo "owned jhw-control link survived uninstall" >&2
    return 1
  }
  [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || {
    echo "owned jhw-control-hook link survived uninstall" >&2
    return 1
  }
  node - "$hooks" "$home" <<'EOF'
const fs = require("node:fs");
const [hooksFile, home] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
if (document.hooks.UserPromptSubmit !== undefined || document.hooks.PostToolUse !== undefined) process.exit(1);
const groups = document.hooks.PreToolUse;
if (!Array.isArray(groups) || groups.length !== 4) process.exit(1);
const commands = groups.flatMap((group) => group.hooks.map((hook) => hook.command));
for (const command of ["/foreign/other-command", "/foreign/second-handler"]) {
  if (!commands.includes(command)) process.exit(1);
}
if (!groups.some((group) => group.hooks.length === 1 && group.hooks[0].timeout === 13)) process.exit(1);
if (!groups.some((group) => group.matcher === "Bash")) process.exit(1);
if (!commands.includes(`${home}/.local/bin/jhw-control-hook --adapter codex --event PreToolUse`)) process.exit(1);
EOF
}

test_malformed_hooks_fail_closed_with_private_backup() {
  local variant home hooks raw before backup_count backup rc failed
  for variant in malformed non-object empty; do
    home="$ROOT/$variant-hooks-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$variant" = "malformed" ]; then
      raw='{"hooks":{"PreToolUse":["private-secret-marker"],'
    elif [ "$variant" = "non-object" ]; then
      raw='["private-secret-marker"]'
    else
      raw=''
    fi
    printf '%s' "$raw" >"$hooks"
    chmod 0640 "$hooks"
    before="$(sha256sum "$hooks")"

    if run_install "$home"; then
      rc=0
    else
      rc=$?
    fi
    failed=0
    if [ "$rc" -eq 0 ]; then
      echo "$variant hooks JSON did not fail closed" >&2
      failed=1
    fi
    if [ -e "$home/.local/bin/jhw-control-hook" ] || [ -L "$home/.local/bin/jhw-control-hook" ]; then
      echo "$variant hooks failure left a newly installed hook link" >&2
      failed=1
    fi
    if grep -Eiq '설치 완료|Guard[^[:alnum:]]*(protected|enforced)|보호 상태' "$home/install.log"; then
      echo "$variant hooks failure emitted a protected/success claim" >&2
      failed=1
    fi
    [ "$failed" -eq 0 ] || return 1
    [ "$(sha256sum "$hooks")" = "$before" ] || { echo "$variant hooks JSON was partially replaced" >&2; return 1; }
    [ "$(stat -c '%a' "$hooks")" = "640" ] || return 1
    backup_count="$(find "$home/.codex" -maxdepth 1 -type f -name 'hooks.json.bak.*' | wc -l)"
    [ "$backup_count" -eq 1 ] || { echo "$variant hooks JSON did not create one private backup" >&2; return 1; }
    backup="$(find "$home/.codex" -maxdepth 1 -type f -name 'hooks.json.bak.*')"
    assert_file_text "$backup" "$raw"
    [ "$(stat -c '%a' "$backup")" = "600" ] || { echo "$variant hooks backup is not private" >&2; return 1; }
    [ "$(find "$home/.codex" -maxdepth 1 -type f -name '.*.tmp' -print -quit)" = "" ] || return 1
  done
}

test_failed_hook_registration_preserves_preexisting_owned_hook_link() {
  local home="$ROOT/preexisting-owned-hook-link-home" hooks rc
  make_tui_roots "$home"
  mkdir -p "$home/.local/bin"
  ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$home/.local/bin/jhw-control-hook"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"hooks":{"PreToolUse":[' >"$hooks"

  if run_install "$home"; then rc=0; else rc=$?; fi

  [ "$rc" -ne 0 ] || { echo "preexisting-link malformed hooks install did not fail" >&2; return 1; }
  [ -L "$home/.local/bin/jhw-control-hook" ] || {
    echo "failed registration removed a preexisting owned hook link" >&2
    return 1
  }
  [ "$(readlink -f -- "$home/.local/bin/jhw-control-hook")" = "$REPO_ROOT/scripts/jhw-control-hook" ] || return 1
  if grep -Eiq '설치 완료|Guard[^[:alnum:]]*(protected|enforced)|보호 상태' "$home/install.log"; then
    echo "failed registration with preexisting link emitted a protected/success claim" >&2
    return 1
  fi
}

test_hooks_config_symlink_and_nonregular_fail_closed() {
  local kind home hooks outside rc
  for kind in symlink directory; do
    home="$ROOT/hooks-$kind-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$kind" = "symlink" ]; then
      outside="$ROOT/hooks-symlink-external.json"
      printf '%s' '{"hooks":{},"foreign":"preserve"}' >"$outside"
      ln -s "$outside" "$hooks"
    else
      mkdir "$hooks"
      printf 'foreign-directory-marker' >"$hooks/marker"
    fi

    if run_install "$home"; then rc=0; else rc=$?; fi

    [ "$rc" -ne 0 ] || { echo "hooks.json $kind did not fail closed" >&2; return 1; }
    [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || {
      echo "hooks.json $kind failure left a newly installed hook link" >&2
      return 1
    }
    if [ "$kind" = "symlink" ]; then
      [ -L "$hooks" ] || return 1
      assert_file_text "$outside" '{"hooks":{},"foreign":"preserve"}'
    else
      [ -d "$hooks" ] || return 1
      assert_file_text "$hooks/marker" "foreign-directory-marker"
    fi
    if grep -Eiq '설치 완료|Guard[^[:alnum:]]*(protected|enforced)|보호 상태' "$home/install.log"; then
      echo "hooks.json $kind failure emitted a protected/success claim" >&2
      return 1
    fi
  done
}

test_new_hooks_file_is_private() {
  local home="$ROOT/private-hooks-home"
  make_tui_roots "$home"

  run_install "$home"

  [ -f "$home/.codex/hooks.json" ] || {
    echo "new hooks.json was not created" >&2
    return 1
  }
  [ "$(stat -c '%a' "$home/.codex/hooks.json")" = "600" ] || {
    echo "new hooks.json mode is not 0600" >&2
    return 1
  }
}

test_unsupported_tuis_receive_no_guard_wiring() {
  local home="$ROOT/unsupported-tuis-home"
  make_tui_roots "$home"

  run_install "$home"

  node - "$home/.gemini/settings.json" "$home/.config/opencode/opencode.json" <<'EOF'
const fs = require("node:fs");
for (const file of process.argv.slice(2)) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  if (JSON.stringify(document).includes("jhw-control-hook")) process.exit(1);
}
EOF
  [ ! -e "$home/.gemini/hooks.json" ] && [ ! -e "$home/.config/opencode/hooks.json" ] || {
    echo "unsupported TUI received Guard hook wiring" >&2
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
  local home="$ROOT/npm-failure-home" npm_log="$ROOT/npm-failure-home/npm.log"
  mkdir -p "$home"
  provision_valid_control_host "$home"
  if HOME="$home" PATH="$FAKE_BIN:$PATH" JHW_TEST_NPM_FAIL=1 JHW_TEST_NPM_LOG="$npm_log" \
      bash "$INSTALL" >"$home/install.log" 2>&1; then
    echo "npm pipeline failure was masked" >&2
    return 1
  fi
  [ "$(cat -- "$npm_log")" = "ci --silent" ] || {
    echo "failing installer did not stop at its exact npm ci invocation" >&2
    return 1
  }
  [ ! -e "$home/.local/bin/jhw-control" ] && [ ! -L "$home/.local/bin/jhw-control" ] || return 1
  [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || return 1
}

test_installer_uses_lockfile_exact_npm_ci() {
  local home="$ROOT/npm-ci-home" npm_log="$ROOT/npm-ci-home/npm.log"
  make_tui_roots "$home"

  run_install "$home"

  [ "$(sed -n '1p' "$npm_log")" = "ci --silent" ] || {
    echo "installer did not begin with the exact lockfile-only npm ci invocation" >&2
    return 1
  }
  [ "$(grep -c '^ci --silent$' "$npm_log")" -eq 1 ] || return 1
  ! grep -qE '^install([[:space:]]|$)' "$npm_log" || {
    echo "installer invoked mutating npm install" >&2
    return 1
  }
  grep -qF 'run build' "$npm_log" || return 1
}

test_current_v4_control_host_contract_allows_activation() {
  local home="$ROOT/current-v4-control-host-home"
  make_tui_roots "$home"

  if ! run_install "$home"; then
    echo "current jhw-control-host v4 contract was rejected" >&2
    cat "$home/install.log" >&2
    return 1
  fi

  [ -L "$home/.local/bin/jhw-control" ] || return 1
  [ -L "$home/.claude/commands/jhw" ] || return 1
  [ -L "$home/.codex/skills/jhw-task" ] || return 1
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
v3|{"commands":["unlock","preflight","portfolio status","task start","task finish"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":3}
unsafe-policy|{"commands":["unlock","preflight","portfolio status","task start","task child-start","task contract","task completion-ready","task promote","task status","task handoff","task finish","task recover","task assert-owner"],"credential_policy":"environment-fallback","name":"jhw-control-host","version":4}
missing-command|{"commands":["unlock","preflight","portfolio status","task start","task child-start","task contract","task completion-ready","task promote","task status","task handoff","task finish","task recover"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":4}
extra-command|{"commands":["unlock","preflight","portfolio status","task start","task child-start","task contract","task completion-ready","task promote","task status","task handoff","task finish","task recover","task assert-owner","task unexpected"],"credential_policy":"secure-store-only","name":"jhw-control-host","version":4}
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

test_invalid_utf8_hooks_backup_and_restore_are_byte_exact() {
  local home="$ROOT/invalid-utf8-hooks-home" hooks witness backup
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  node - "$hooks" <<'EOF'
const fs = require("node:fs");
const file = process.argv[2];
fs.writeFileSync(file, Buffer.concat([
  Buffer.from('{"foreign":"replacement-parseable-'),
  Buffer.from([0xc3, 0x28]),
  Buffer.from('-tail"}'),
]));
EOF
  chmod 0640 "$hooks"
  witness="$home/invalid-utf8.witness"
  cp -- "$hooks" "$witness"

  if run_install "$home"; then
    echo "invalid UTF-8 hook bytes were normalized into an installable JSON document" >&2
    return 1
  fi
  cmp -s -- "$hooks" "$witness" || {
    echo "invalid UTF-8 live hook bytes were not restored exactly" >&2
    return 1
  }
  [ "$(stat -c '%a' "$hooks")" = "640" ] || return 1
  backup="$(find "$home/.codex" -maxdepth 1 -type f -name 'hooks.json.bak.*')"
  [ -n "$backup" ] && [ "$(printf '%s\n' "$backup" | wc -l)" -eq 1 ] || {
    echo "invalid UTF-8 hook bytes did not create one malformed backup" >&2
    return 1
  }
  [ "$(stat -c '%a' "$backup")" = "600" ] && cmp -s -- "$backup" "$witness" || {
    echo "malformed backup was not byte-exact and private" >&2
    return 1
  }
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_capture_intent_is_durable_before_rename() {
  local home="$ROOT/capture-intent-home" hooks
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"foreign":"capture-intent"}' >"$hooks"
  chmod 0640 "$hooks"
  if ! JHW_TEST_ROUND5_MODE=capture-intent-verify run_install "$home"; then
    echo "registration removed the live path before a durable capture-intent stage" >&2
    return 1
  fi
  assert_file_text "$home/capture-intent-observed" "capture-intent"
}

test_observed_existing_capture_enoent_is_not_missing() {
  local home="$ROOT/capture-existing-enoent-home" hooks transaction
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"foreign":"observed-existing"}' >"$hooks"
  chmod 0640 "$hooks"
  if JHW_TEST_ROUND5_MODE=capture-enoent run_install "$home"; then
    echo "an observed existing hooks path that vanished at capture was reclassified as originally missing" >&2
    return 1
  fi
  [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || return 1
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] || {
    echo "capture ENOENT did not preserve transaction evidence" >&2
    return 1
  }
  [ -L "$home/.local/bin/jhw-control-hook" ] || {
    echo "ambiguous capture ENOENT removed the launcher" >&2
    return 1
  }
  grep -Eiq 'concurrent|ambiguous' "$home/install.log" || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_post_rename_capture_error_is_reconciled_from_intent() {
  local home="$ROOT/post-rename-capture-error-home" hooks witness transaction metadata
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{ "foreign" : "post-rename", "n" : 1.20e+2 }' >"$hooks"
  chmod 0640 "$hooks"
  witness="$home/post-rename.witness"
  cp -- "$hooks" "$witness"

  if JHW_TEST_ROUND5_MODE=post-rename-error run_install "$home"; then
    echo "injected post-rename/pre-manifest error unexpectedly completed" >&2
    return 1
  fi
  [ -f "$home/capture-after-rename-hit" ] || return 1
  cmp -s -- "$hooks" "$witness" || {
    echo "capture-intent reconcile did not exclusively recover the captured bytes" >&2
    return 1
  }
  [ "$(stat -c '%a' "$hooks")" = "640" ] || return 1
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -e "$transaction/captured-live" ] || {
    echo "post-rename capture evidence was not retained at its exact intent path" >&2
    return 1
  }
  [ "$(stat -c '%d:%i' "$hooks")" = "$(stat -c '%d:%i' "$transaction/captured-live")" ] || {
    echo "manifest claimed capture recovery without an exclusive same-object restore" >&2
    return 1
  }
  metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction")" || {
      echo "stage-aware inspector rejected the single exact intent capture artifact" >&2
      return 1
    }
  node - "$transaction/manifest.json" "$metadata" <<'EOF'
const fs = require("node:fs");
const [file, metadata] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const output = JSON.parse(metadata);
const state = manifest.original;
if (manifest.stage !== "capture-recovered" || output.stage !== "capture-recovered") process.exit(1);
if (!state || state.kind !== "file" || state.mode !== "640") process.exit(1);
if (!Number.isSafeInteger(state.dev) || state.dev < 0 || !Number.isSafeInteger(state.ino) || state.ino <= 0) process.exit(1);
EOF
  grep -qF 'capture-recovered' "$home/install.log" || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_capture_intent_reconcile_rejects_any_extra_artifact() {
  local home="$ROOT/capture-intent-extra-home" hooks transaction
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"foreign":"intent-extra"}' >"$hooks"
  chmod 0640 "$hooks"
  if JHW_TEST_ROUND5_MODE=post-rename-extra-error run_install "$home"; then
    echo "capture intent with an unexpected artifact was accepted" >&2
    return 1
  fi
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -f "$transaction/unexpected-intent-artifact" ] || return 1
  [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || {
    echo "ambiguous intent evidence was falsely called restored" >&2
    return 1
  }
  if ! node - "$transaction/manifest.json" <<'EOF'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (manifest.stage !== "capture-intent") process.exit(1);
EOF
  then
    echo "post-rename error overwrote the durable capture-intent instead of reconciling it stage-aware" >&2
    return 1
  fi
  ! grep -qF 'capture-intent contains an unexpected artifact' "$home/install.log" || return 1
  grep -qF "$transaction" "$home/install.log" || return 1
  grep -qF 'transaction metadata를 안전하게 확인할 수 없습니다' "$home/install.log" || return 1
  grep -qF 'live hooks path 상태는 확인되지 않았습니다' "$home/install.log" || return 1
  ! grep -qF 'private-unexpected-marker' "$home/install.log" || return 1
  ! grep -Eiq 'capture-(recovered|restored)' "$home/install.log" || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
}

test_raced_nonregular_capture_is_no_follow_or_manual_recovery() {
  local requested="${1:-}" kind home hooks outside transaction
  for kind in ${requested:-symlink fifo directory}; do
    home="$ROOT/raced-$kind-capture-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    printf '%s' '{"foreign":"initial-regular"}' >"$hooks"
    chmod 0640 "$hooks"
    outside="$home/outside-symlink-target"
    printf '%s' 'outside-private-target' >"$outside"
    chmod 0644 "$outside"

    if JHW_TEST_ROUND5_MODE="substitute-$kind" JHW_TEST_SUBSTITUTE_TARGET="$outside" run_install "$home"; then
      echo "$kind capture substitution unexpectedly completed" >&2
      return 1
    fi
    case "$kind" in
      symlink)
        [ -L "$hooks" ] && [ "$(readlink -- "$hooks")" = "$outside" ] || {
          echo "captured symlink was not restored as the symlink itself" >&2
          return 1
        }
        assert_file_text "$outside" "outside-private-target"
        [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || {
          echo "captured symlink recovery left transaction/launcher state unfinalized" >&2
          return 1
        }
        ;;
      fifo)
        [ -p "$hooks" ] && [ "$(stat -c '%a' "$hooks")" = "620" ] || {
          echo "captured FIFO was not restored no-follow with its exact mode" >&2
          return 1
        }
        [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || {
          echo "captured FIFO recovery left transaction/launcher state unfinalized" >&2
          return 1
        }
        ;;
      directory)
        transaction="$(find_hook_transaction "$home")"
        [ -n "$transaction" ] && [ -d "$transaction/captured-live" ] || {
          echo "captured directory subtree was not preserved at the exact transaction path" >&2
          return 1
        }
        assert_file_text "$transaction/captured-live/foreign-subtree-marker" "directory-subtree"
        [ "$(stat -c '%a' "$transaction/captured-live")" = "750" ] || return 1
        [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
        grep -qF 'manual recovery required' "$home/install.log" || {
          echo "captured directory was preserved but not classified as manual recovery" >&2
          return 1
        }
        grep -qF "preserved subtree: $transaction/captured-live" "$home/install.log" || return 1
        grep -qF 'live hooks path is unknown or absent' "$home/install.log" || return 1
        ! grep -Eiq 'directory.*restored|restored.*directory' "$home/install.log" || return 1
        ;;
    esac
    ! grep -qF '설치 완료!' "$home/install.log" || return 1
  done
}

test_capture_manual_hard_exit_is_stage_routed() {
  local home="$ROOT/capture-manual-hard-exit-home" hooks transaction metadata
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"foreign":"register-race-source"}' >"$hooks"
  chmod 0640 "$hooks"

  if JHW_TEST_ROUND5_MODE=capture-manual-hard-exit run_install "$home"; then
    echo "register hard exit after durable manual stage unexpectedly completed" >&2
    return 1
  fi
  [ -f "$home/capture-manual-stage-durable" ] || {
    echo "register test did not reach a durably synced manual stage" >&2
    cat "$home/install.log" >&2
    return 1
  }
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -d "$transaction/captured-live" ] || return 1
  assert_file_text "$transaction/captured-live/foreign-subtree-marker" "captured-register-subtree"
  [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || return 1
  metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction")" || return 1
  node -e 'const m=JSON.parse(process.argv[1]); if(m.stage!=="manual-recovery-required") process.exit(1)' "$metadata"
  grep -qF 'manual recovery required' "$home/install.log" || return 1
  grep -qF "preserved subtree: $transaction/captured-live" "$home/install.log" || return 1
  grep -qF 'live hooks path is unknown or absent; it was not restored' "$home/install.log" || return 1
  grep -qF "$transaction" "$home/install.log" || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
  ! grep -qF 'capture/publish가 concurrent 또는 ambiguous' "$home/install.log" || return 1
  ! grep -qF 'current path와 repository hook launcher를 보존합니다.' "$home/install.log" || return 1
  ! grep -qF 'private-register-helper-stderr-marker' "$home/install.log" || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_unregister_manual_hard_exit_is_stage_routed() {
  local home="$ROOT/unregister-manual-hard-exit-home" hooks transaction metadata
  make_tui_roots "$home"
  mkdir -p "$home/.local/bin"
  ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$home/.local/bin/jhw-control-hook"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"foreign":"unregister-race-source"}' >"$hooks"
  chmod 0640 "$hooks"

  if JHW_TEST_ROUND5_MODE=unregister-manual-hard-exit run_install "$home" --uninstall; then
    echo "unregister hard exit after durable manual stage unexpectedly completed" >&2
    return 1
  fi
  [ -f "$home/unregister-manual-stage-durable" ] || {
    echo "unregister test did not reach a durably synced manual stage" >&2
    cat "$home/install.log" >&2
    return 1
  }
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -d "$transaction/captured-live" ] || return 1
  assert_file_text "$transaction/captured-live/foreign-subtree-marker" "captured-unregister-subtree"
  [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || return 1
  metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction")" || return 1
  node -e 'const m=JSON.parse(process.argv[1]); if(m.stage!=="manual-recovery-required") process.exit(1)' "$metadata"
  grep -qF 'manual recovery required' "$home/install.log" || return 1
  grep -qF "preserved subtree: $transaction/captured-live" "$home/install.log" || return 1
  grep -qF 'live hooks path is unknown or absent; it was not restored' "$home/install.log" || return 1
  grep -qF "$transaction" "$home/install.log" || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
  ! grep -qF 'Codex hook uninstall은 concurrent/ambiguous 상태입니다' "$home/install.log" || return 1
  ! grep -qF 'jhw-control-hook 심링크 제거' "$home/install.log" || return 1
  ! grep -qF 'private-unregister-helper-stderr-marker' "$home/install.log" || return 1
  ! grep -qF '제거 완료!' "$home/install.log" || return 1
}

test_rollback_capture_intent_reconciles_candidate_or_reports_exact_subtree() {
  local requested="${1:-}" scenario home hooks transaction metadata expected_stage expected_kind expected_mode
  for scenario in ${requested:-file symlink fifo directory}; do
    home="$ROOT/rollback-intent-$scenario-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    printf '%s' '{ "hooks" : { "SessionStart" : [{"hooks":[{"type":"command","command":"/foreign/original","timeout":4.00}]}] }, "generation" : 1.20e+1 }' >"$hooks"
    chmod 0640 "$hooks"

    if JHW_TEST_ROUND5_MODE="rollback-intent-$scenario" \
        JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
        run_install "$home"; then
      echo "$scenario rollback capture-intent interruption unexpectedly completed" >&2
      return 1
    fi
    assert_file_text "$home/rollback-capture-intent-observed" "rollback-capture-intent"
    [ -f "$home/rollback-after-rename-hit" ] || {
      echo "$scenario rollback did not reach the post-rename/pre-manifest window" >&2
      return 1
    }
    transaction="$(find_hook_transaction "$home")"
    [ -n "$transaction" ] || return 1
    [ -L "$home/.local/bin/jhw-control-hook" ] || {
      echo "$scenario rollback intent failure removed the recovery launcher" >&2
      return 1
    }

    expected_stage="manual-recovery-required"
    [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || {
      echo "$scenario interrupted rollback recovery republished a mutable pathname candidate" >&2
      return 1
    }
    if [ "$scenario" = "file" ]; then
      expected_kind="file"
      expected_mode="640"
      [ -f "$transaction/candidate-live" ] || {
        echo "rollback intent did not preserve the candidate file for manual recovery" >&2
        return 1
      }
      [ "$(stat -c '%a' "$transaction/candidate-live")" = "640" ] || return 1
      assert_exact_owned_hook_groups "$transaction/candidate-live" "$home"
      grep -qF "preserved recovery object: $transaction/candidate-live" "$home/install.log" || return 1
    elif [ "$scenario" = "symlink" ]; then
      expected_kind="symlink"
      expected_mode="777"
      [ -L "$transaction/candidate-live" ] || {
        echo "rollback intent did not preserve the candidate symlink for manual recovery" >&2
        return 1
      }
      [ "$(readlink -- "$transaction/candidate-live")" = "$home/rollback-symlink-target" ] || return 1
      [ -d "$home/rollback-symlink-target" ] || return 1
      assert_file_text "$home/rollback-symlink-target/external-target-marker" "must-remain-external"
      grep -qF "preserved recovery object: $transaction/candidate-live" "$home/install.log" || {
        echo "manual rollback guidance followed the candidate symlink directory target" >&2
        return 1
      }
      ! grep -qF "preserved subtree: $transaction/candidate-live" "$home/install.log" || return 1
    elif [ "$scenario" = "fifo" ]; then
      expected_kind="fifo"
      expected_mode="620"
      [ -p "$transaction/candidate-live" ] || {
        echo "rollback intent did not preserve the candidate FIFO for manual recovery" >&2
        return 1
      }
      [ "$(stat -c '%a' "$transaction/candidate-live")" = "620" ] || return 1
      grep -qF "preserved recovery object: $transaction/candidate-live" "$home/install.log" || return 1
    else
      expected_kind="directory"
      expected_mode="750"
      [ -d "$transaction/candidate-live" ] || {
        echo "rollback directory subtree was not preserved at candidate-live" >&2
        return 1
      }
      assert_file_text "$transaction/candidate-live/foreign-subtree-marker" "rollback-directory-subtree"
      [ "$(stat -c '%a' "$transaction/candidate-live")" = "750" ] || return 1
      grep -qF "preserved subtree: $transaction/candidate-live" "$home/install.log" || return 1
    fi
    grep -qF 'manual recovery required' "$home/install.log" || return 1
    grep -qF 'live hooks path is unknown or absent; it was not restored' "$home/install.log" || return 1
    ! grep -qF 'rollback-capture-recovered' "$home/install.log" || return 1

    metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
      inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
      "$REPO_ROOT" "$transaction")" || {
        echo "$scenario rollback intent evidence was not inspectable" >&2
        return 1
      }
    node - "$transaction/manifest.json" "$metadata" "$expected_stage" "$expected_kind" "$expected_mode" <<'EOF'
const fs = require("node:fs");
const [file, metadata, expectedStage, expectedKind, expectedMode] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const output = JSON.parse(metadata);
if (manifest.stage !== expectedStage || output.stage !== expectedStage) process.exit(1);
if (!manifest.artifacts.includes("candidate-live")) process.exit(1);
const identity = manifest.identities?.["candidate-live"];
if (!identity || identity.kind !== expectedKind || identity.mode !== expectedMode) process.exit(1);
if (!manifest.candidate || JSON.stringify(manifest.candidate) !== JSON.stringify(identity)) process.exit(1);
EOF
    grep -qF "$transaction/candidate-live" "$home/install.log" || {
      echo "$scenario rollback guidance omitted the exact candidate-live recovery path" >&2
      return 1
    }
    grep -qF "$expected_stage" "$home/install.log" || return 1
    ! grep -qF '설치 완료!' "$home/install.log" || return 1
  done
}

test_rollback_recovery_syncs_rename_parents_before_candidate_claim() {
  local home="$ROOT/rollback-wave2-fsync-order-home" hooks transaction sequence
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/foreign/original","timeout":4}]}]}}' >"$hooks"
  chmod 0640 "$hooks"

  if JHW_TEST_ROUND5_MODE=rollback-wave2-fsync-order \
      JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
      run_install "$home"; then
    echo "rollback parent-fsync ordering interruption unexpectedly completed" >&2
    return 1
  fi
  transaction="$(find_hook_transaction "$home")"
  sequence="$home/rollback-recovery-sequence"
  [ -f "$sequence" ] || {
    echo "rollback recovery emitted no durability sequence" >&2
    return 1
  }
  node - "$sequence" <<'EOF'
const fs = require("node:fs");
const entries = fs.readFileSync(process.argv[2], "utf8").trim().split("\n");
const live = entries.indexOf("live-parent-fsync");
const transaction = entries.indexOf("transaction-parent-fsync");
const claim = entries.indexOf("candidate-manifest-write");
if (live < 0 || transaction <= live || claim <= transaction) {
  console.error(`candidate claim preceded durable rename parents: ${entries.join(",")}`);
  process.exit(1);
}
EOF
  [ -n "$transaction" ] && [ -d "$transaction/candidate-live" ] || return 1
  [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || {
    echo "ordered interrupted recovery republished or fabricated a live hooks path" >&2
    return 1
  }
  node - "$transaction/manifest.json" <<'EOF'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (manifest.stage !== "manual-recovery-required" || manifest.candidate?.kind !== "directory") process.exit(1);
EOF
  grep -qF "$transaction/candidate-live" "$home/install.log" || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_rollback_recovery_parent_fsync_failure_retains_intent() {
  local home="$ROOT/rollback-wave2-fsync-failure-home" hooks transaction metadata
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/foreign/original","timeout":4}]}]}}' >"$hooks"
  chmod 0640 "$hooks"

  if JHW_TEST_ROUND5_MODE=rollback-wave2-fsync-failure \
      JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
      run_install "$home"; then
    echo "rollback live-parent fsync failure unexpectedly completed" >&2
    return 1
  fi
  [ -f "$home/rollback-live-parent-fsync-failure-hit" ] || {
    echo "post-rename recovery did not fsync the live parent" >&2
    return 1
  }
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -d "$transaction/candidate-live" ] || return 1
  [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || {
    echo "parent-fsync failure republished or fabricated a live hooks path" >&2
    return 1
  }
  metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction")" || {
      echo "parent-fsync failure destroyed inspectable rollback intent evidence" >&2
      return 1
    }
  node - "$transaction/manifest.json" "$metadata" <<'EOF'
const fs = require("node:fs");
const [file, metadata] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const output = JSON.parse(metadata);
if (manifest.stage !== "rollback-capture-intent" || output.stage !== "rollback-capture-intent") process.exit(1);
if (manifest.candidate !== undefined || manifest.artifacts.includes("candidate-live")) process.exit(1);
EOF
  grep -qF "$transaction/candidate-live" "$home/install.log" || {
    echo "validated rollback intent omitted its exact candidate recovery path" >&2
    return 1
  }
  grep -qF 'live hooks path is unknown or absent; it was not restored' "$home/install.log" || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
  ! grep -qF 'rollback-capture-recovered' "$home/install.log" || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_rollback_incomplete_intent_symlink_to_directory_reports_object() {
  local home="$ROOT/rollback-wave3-symlink-dir-intent-home" hooks transaction metadata
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/foreign/original","timeout":4}]}]}}' >"$hooks"
  chmod 0640 "$hooks"

  if JHW_TEST_ROUND5_MODE=rollback-wave3-symlink-dir-fsync-failure \
      JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
      run_install "$home"; then
    echo "symlink-directory rollback intent interruption unexpectedly completed" >&2
    return 1
  fi
  [ -f "$home/rollback-live-parent-fsync-failure-hit" ] || return 1
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -L "$transaction/candidate-live" ] || return 1
  [ "$(readlink -- "$transaction/candidate-live")" = "$home/rollback-symlink-target" ] || return 1
  assert_file_text "$home/rollback-symlink-target/external-target-marker" "must-remain-external"
  [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || return 1
  metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction")" || return 1
  node -e 'const m=JSON.parse(process.argv[1]); if(m.stage!=="rollback-capture-intent") process.exit(1)' "$metadata"
  grep -qF "preserved recovery object: $transaction/candidate-live" "$home/install.log" || {
    echo "incomplete rollback guidance followed the candidate symlink directory target" >&2
    return 1
  }
  ! grep -qF "preserved subtree: $transaction/candidate-live" "$home/install.log" || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_rollback_recovery_never_publishes_substituted_candidate_path() {
  local home="$ROOT/rollback-wave2-substitute-link-home" hooks transaction metadata
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/foreign/original","timeout":4}]}]}}' >"$hooks"
  chmod 0640 "$hooks"

  if JHW_TEST_ROUND5_MODE=rollback-wave2-substitute-link \
      JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
      run_install "$home"; then
    echo "rollback candidate substitution unexpectedly completed" >&2
    return 1
  fi
  [ ! -e "$home/rollback-candidate-link-substitution-hit" ] || {
    echo "interrupted rollback attempted pathname publication after candidate binding" >&2
    return 1
  }
  [ ! -e "$hooks" ] && [ ! -L "$hooks" ] || {
    echo "a recovery candidate was published into the live path" >&2
    return 1
  }
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -f "$transaction/candidate-live" ] || return 1
  cmp -s -- "$transaction/candidate-live" "$home/rollback-candidate-original-witness" || {
    echo "manual recovery candidate changed before operator inspection" >&2
    return 1
  }
  metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction")" || return 1
  node -e 'const m=JSON.parse(process.argv[1]); if(m.stage!=="manual-recovery-required") process.exit(1)' "$metadata"
  grep -qF "$transaction/candidate-live" "$home/install.log" || return 1
  ! grep -qF 'rollback-capture-recovered' "$home/install.log" || return 1
}

test_rollback_manual_stage_hard_exit_still_reports_exact_candidate() {
  local home="$ROOT/rollback-wave2-manual-hard-exit-home" hooks transaction metadata
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  printf '%s' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/foreign/original","timeout":4}]}]}}' >"$hooks"
  chmod 0640 "$hooks"

  if JHW_TEST_ROUND5_MODE=rollback-wave2-manual-hard-exit \
      JHW_TEST_DIAGNOSTIC_OUTPUT='malformed-diagnostic' JHW_TEST_DIAGNOSTIC_EXIT=78 \
      run_install "$home"; then
    echo "hard exit after manual rollback stage unexpectedly completed" >&2
    return 1
  fi
  [ -f "$home/rollback-manual-stage-durable" ] || {
    echo "test did not reach a durably synced manual rollback stage" >&2
    return 1
  }
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -d "$transaction/candidate-live" ] || return 1
  metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction")" || return 1
  node -e 'const m=JSON.parse(process.argv[1]); if(m.stage!=="manual-recovery-required") process.exit(1)' "$metadata"
  grep -qF 'manual recovery required' "$home/install.log" || {
    echo "hard-exit manual stage was routed by helper rc instead of durable stage" >&2
    return 1
  }
  grep -qF "preserved subtree: $transaction/candidate-live" "$home/install.log" || {
    echo "hard-exit recovery guidance depended on the helper return code" >&2
    return 1
  }
  grep -qF 'live hooks path is unknown or absent; it was not restored' "$home/install.log" || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_activation_detach_intent_survives_ready_unlink_crash() {
  local home="$ROOT/activation-detach-intent-home" hooks transaction metadata
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"

  if JHW_TEST_ROUND5_MODE=activation-detach-intent run_install "$home"; then
    echo "activation ready-unlink crash unexpectedly completed" >&2
    return 1
  fi
  [ -f "$home/activation-ready-unlinked" ] || {
    echo "activation test did not reach the post-unlink crash window" >&2
    return 1
  }
  assert_file_text "$home/activation-detach-stage-observed" "activation-detach-intent"
  [ -f "$hooks" ] && [ "$(stat -c '%a' "$hooks")" = "600" ] || {
    echo "durably linked live hooks state did not survive activation interruption" >&2
    return 1
  }
  assert_exact_owned_hook_groups "$hooks" "$home"
  transaction="$(find_hook_transaction "$home")"
  [ -n "$transaction" ] && [ -f "$transaction/published" ] && [ ! -e "$transaction/published-ready" ] || {
    echo "activation interruption did not retain the expected private evidence shape" >&2
    return 1
  }
  cmp -s -- "$hooks" "$transaction/published" || {
    echo "live activation bytes differ from the retained published evidence" >&2
    return 1
  }
  [ -L "$home/.local/bin/jhw-control-hook" ] || {
    echo "activation intent interruption removed the launcher" >&2
    return 1
  }

  metadata="$(HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    inspect-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction")" || {
      echo "activation detach intent rejected its sole journaled missing artifact" >&2
      return 1
    }
  node - "$transaction/manifest.json" "$metadata" "$hooks" <<'EOF'
const fs = require("node:fs");
const [file, metadata, hooksFile] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const output = JSON.parse(metadata);
if (manifest.stage !== "activation-detach-intent" || output.stage !== "activation-detach-intent") process.exit(1);
if (manifest.deleteIntent !== "published-ready" || manifest.activationTo !== "activated") process.exit(1);
if (!manifest.artifacts.includes("published-ready") || !manifest.identities?.["published-ready"]) process.exit(1);
const live = fs.lstatSync(hooksFile);
const expected = manifest.published;
const mode = (live.mode & 0o777).toString(8);
if (!expected || !live.isFile() || mode !== expected.mode || Number(live.dev) !== expected.dev || Number(live.ino) !== expected.ino) {
  process.exit(1);
}
EOF
  grep -qF "$transaction" "$home/install.log" || return 1
  grep -qF 'activation-detach-intent' "$home/install.log" || return 1
  ! grep -qF 'Codex: Guard hook 그룹 등록' "$home/install.log" || return 1
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_finalize_partial_retry_tracks_identity_and_only_delete_intent_may_be_missing() {
  local requested="${1:-}" scenario home transaction manifest delete_intent victim outside
  for scenario in ${requested:-retry substitution}; do
    home="$ROOT/finalize-partial-$scenario-home"
    make_tui_roots "$home"
    if JHW_TEST_ROUND5_MODE=finalize-partial run_install "$home"; then
      echo "$scenario partial finalize unexpectedly completed" >&2
      return 1
    fi
    [ -f "$home/finalize-partial-hit" ] || return 1
    transaction="$(find_hook_transaction "$home")"
    [ -n "$transaction" ] || return 1
    manifest="$transaction/manifest.json"
    delete_intent="$(node - "$manifest" "$transaction" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [file, directory] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
if (manifest.stage !== "finalize-intent" || typeof manifest.deleteIntent !== "string") process.exit(1);
if (!manifest.identities || typeof manifest.identities !== "object") process.exit(1);
for (const name of manifest.artifacts) {
  const identity = manifest.identities[name];
  if (!identity || typeof identity.kind !== "string" || typeof identity.mode !== "string" ||
      !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)) process.exit(1);
}
const missing = manifest.artifacts.filter((name) => {
  try { fs.lstatSync(path.join(directory, name)); return false; } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
});
if (missing.length !== 1 || missing[0] !== manifest.deleteIntent) process.exit(1);
process.stdout.write(manifest.deleteIntent);
EOF
)" || {
      echo "partial finalize did not durably identify the sole permitted missing artifact" >&2
      return 1
    }
    [ "$delete_intent" = "$(cat -- "$home/finalize-partial-hit")" ] || return 1

    if [ "$scenario" = "retry" ]; then
      HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
        finalize-codex-hooks-transaction "$home/.codex/hooks.json" \
        "$REPO_ROOT/mcp-server/dist/index.js" "$REPO_ROOT" "$transaction" activated || {
          echo "finalize did not resume idempotently from its exact deleteIntent" >&2
          return 1
        }
      [ ! -e "$transaction" ] || return 1
    else
      victim="$(node - "$manifest" "$transaction" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [file, directory] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const victim = manifest.artifacts.find((name) => name !== manifest.deleteIntent && fs.existsSync(path.join(directory, name)));
if (!victim) process.exit(1);
process.stdout.write(victim);
EOF
)"
      outside="$home/finalize-foreign-substitution"
      printf '%s' 'do-not-delete' >"$outside"
      rm -- "$transaction/$victim"
      ln -s "$outside" "$transaction/$victim"
      if HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
          finalize-codex-hooks-transaction "$home/.codex/hooks.json" \
          "$REPO_ROOT/mcp-server/dist/index.js" "$REPO_ROOT" "$transaction" activated; then
        echo "finalize accepted an unexpected artifact identity substitution" >&2
        return 1
      fi
      [ -L "$transaction/$victim" ] && assert_file_text "$outside" "do-not-delete"
    fi
  done
}

test_finalize_rejects_same_shape_artifact_identity_substitution() {
  local home="$ROOT/finalize-identity-substitution-home" hooks transaction artifact
  make_tui_roots "$home"
  hooks="$home/.codex/hooks.json"
  transaction="$home/.codex/.hooks.json.jhw-txn.identity"
  mkdir "$transaction"
  chmod 0700 "$transaction"
  HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
    register-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
    "$REPO_ROOT" "$transaction" || return 1
  artifact="$transaction/published"
  [ -f "$artifact" ] || return 1
  ln "$artifact" "$home/original-published-identity-held"
  rm -- "$artifact"
  printf '%s' 'same-shape-foreign-artifact' >"$artifact"
  chmod 0600 "$artifact"
  if HOME="$home" PATH="$FAKE_BIN:$PATH" node "$REPO_ROOT/scripts/install-config.mjs" \
      finalize-codex-hooks-transaction "$hooks" "$REPO_ROOT/mcp-server/dist/index.js" \
      "$REPO_ROOT" "$transaction" activated; then
    echo "finalize deleted a same-shape artifact whose recorded identity had changed" >&2
    return 1
  fi
  assert_file_text "$artifact" "same-shape-foreign-artifact"
}

test_post_rmdir_fsync_failure_is_truthful_and_retains_launcher() {
  local home="$ROOT/finalize-post-rmdir-home"
  make_tui_roots "$home"
  if JHW_TEST_ROUND5_MODE=finalize-post-rmdir-fsync run_install "$home"; then
    echo "post-rmdir parent fsync failure unexpectedly completed" >&2
    return 1
  fi
  [ -f "$home/finalize-rmdir-hit" ] || return 1
  [ -z "$(find_hook_transaction "$home")" ] || return 1
  [ -L "$home/.local/bin/jhw-control-hook" ] || {
    echo "rc7 cleanup uncertainty removed the launcher" >&2
    return 1
  }
  grep -qF 'transaction evidence was removed; parent-directory durability is unconfirmed' "$home/install.log" || {
    echo "post-rmdir fsync failure did not report removed evidence truthfully" >&2
    return 1
  }
  ! grep -qF 'private hook transaction evidence:' "$home/install.log" || {
    echo "post-rmdir fsync failure falsely claimed transaction evidence was preserved" >&2
    return 1
  }
  ! grep -qF '설치 완료!' "$home/install.log" || return 1
}

test_uninstall_changed_and_unchanged_are_no_clobber_transactions() {
  local requested="${1:-}" scenario home hooks winner transaction
  for scenario in ${requested:-changed unchanged}; do
    home="$ROOT/uninstall-link-race-$scenario-home"
    make_tui_roots "$home"
    hooks="$home/.codex/hooks.json"
    if [ "$scenario" = "changed" ]; then
      write_owned_hooks_fixture "$hooks" "$home" yes
    else
      write_owned_hooks_fixture "$hooks" "$home" no
    fi
    chmod 0640 "$hooks"
    mkdir -p "$home/.local/bin"
    ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$home/.local/bin/jhw-control-hook"
    winner="uninstall-$scenario-concurrent-winner"

    if JHW_TEST_LINK_RACE_OPERATION=unregister JHW_TEST_LINK_RACE_BYTES="$winner" \
        JHW_TEST_LINK_RACE_MODE=0622 run_install "$home" --uninstall; then
      echo "$scenario uninstall link race unexpectedly completed" >&2
      return 1
    fi
    assert_file_text "$hooks" "$winner"
    [ "$(stat -c '%a' "$hooks")" = "622" ] || return 1
    [ -f "$home/link-race-hit" ] || {
      echo "$scenario uninstall did not use the shared exclusive transaction engine" >&2
      return 1
    }
    [ -L "$home/.local/bin/jhw-control-hook" ] || {
      echo "$scenario uninstall conflict removed the launcher" >&2
      return 1
    }
    transaction="$(find_hook_transaction "$home")"
    [ -n "$transaction" ] || return 1
    grep -qF "$transaction" "$home/install.log" || return 1
    ! grep -qF '제거 완료!' "$home/install.log" || return 1
  done
}

test_stale_hook_transactions_block_install_and_uninstall() {
  local requested="${1:-}" action home stale before count
  for action in ${requested:-install uninstall}; do
    home="$ROOT/stale-transaction-$action-home"
    make_tui_roots "$home"
    stale="$home/.codex/.hooks.json.jhw-txn.abandoned"
    mkdir "$stale"
    chmod 0700 "$stale"
    printf '%s' '{"private":"stale-secret-marker"}' >"$stale/manifest.json"
    chmod 0600 "$stale/manifest.json"
    before="$(sha256sum "$stale/manifest.json")"
    if [ "$action" = "uninstall" ]; then
      mkdir -p "$home/.local/bin"
      ln -s "$REPO_ROOT/scripts/jhw-control-hook" "$home/.local/bin/jhw-control-hook"
      if run_install "$home" --uninstall; then
        echo "uninstall ignored abandoned hook transaction evidence" >&2
        return 1
      fi
      [ -L "$home/.local/bin/jhw-control-hook" ] || return 1
    else
      if run_install "$home"; then
        echo "install allocated over abandoned hook transaction evidence" >&2
        return 1
      fi
      [ ! -e "$home/.local/bin/jhw-control-hook" ] && [ ! -L "$home/.local/bin/jhw-control-hook" ] || return 1
    fi
    [ "$(sha256sum "$stale/manifest.json")" = "$before" ] || return 1
    count="$(find "$home/.codex" -maxdepth 1 -mindepth 1 -type d -name '.hooks.json.jhw-txn.*' | wc -l)"
    [ "$count" -eq 1 ] || {
      echo "$action created another transaction beside abandoned evidence" >&2
      return 1
    }
    grep -qF "$stale" "$home/install.log" || return 1
    ! grep -qF 'stale-secret-marker' "$home/install.log" || return 1
  done
}

case "${JHW_INSTALL_TEST_ONLY:-all}" in
  all) ;;
  host-v4) test_current_v4_control_host_contract_allows_activation; exit ;;
  host-invalid) test_non_v4_control_host_contract_fails_before_activation; exit ;;
  npm-ci) test_installer_uses_lockfile_exact_npm_ci; exit ;;
  fresh-hooks) test_fresh_install_creates_both_control_links_and_exact_hooks; exit ;;
  install-preflight) test_install_orders_guard_transaction_and_runs_public_preflight; exit ;;
  diagnostic-failure) test_install_aborts_on_guard_diagnostic_execution_failure; exit ;;
  malformed-diagnostic) test_install_rejects_malformed_diagnostic_and_rolls_back_hooks; exit ;;
  diagnostic-schema) test_install_requires_complete_guard_diagnostic_schema; exit ;;
  rollback-hooks) test_preflight_failure_restores_exact_prior_hook_state; exit ;;
  default-unprovisioned) test_default_unprovisioned_install_removes_owned_guard_hooks_and_preserves_foreign_hooks; exit ;;
  invalid-default-guard) test_no_coordinates_with_explicit_invalid_guard_mode_aborts; exit ;;
  rollback-failure) test_rollback_failure_preserves_launcher_and_private_recovery_snapshot; exit ;;
  rollback-cas) test_rollback_capture_preserves_concurrent_hook_changes; exit ;;
  rollback-same-bytes-new-inode) test_rollback_same_bytes_new_inode_is_not_owned_publication; exit ;;
  launcher-remove-race) test_launcher_uninstall_races_preserve_replacements; exit ;;
  launcher-rollback-race) test_launcher_failed_install_rollback_races_are_no_clobber; exit ;;
  launcher-capture-hard-exit) test_launcher_transaction_hard_exits_leave_inspectable_evidence; exit ;;
  stale-hook-link-transaction) test_stale_hook_link_transactions_block_install_and_uninstall; exit ;;
  rollback-after-mutation) test_rollback_after_mutation_failure_retains_truthful_private_evidence; exit ;;
  register-link-race) test_registration_capture_publish_race_never_clobbers_winner; exit ;;
  rollback-link-race) test_rollback_capture_restore_race_never_clobbers_winner; exit ;;
  parse-link-race) test_parse_failure_restore_race_preserves_winner_and_backup; exit ;;
  invalid-utf8-hooks) test_invalid_utf8_hooks_backup_and_restore_are_byte_exact; exit ;;
  capture-intent) test_capture_intent_is_durable_before_rename; exit ;;
  capture-enoent) test_observed_existing_capture_enoent_is_not_missing; exit ;;
  capture-reconcile) test_post_rename_capture_error_is_reconciled_from_intent; exit ;;
  capture-intent-extra) test_capture_intent_reconcile_rejects_any_extra_artifact; exit ;;
  capture-nonregular) test_raced_nonregular_capture_is_no_follow_or_manual_recovery; exit ;;
  capture-symlink) test_raced_nonregular_capture_is_no_follow_or_manual_recovery symlink; exit ;;
  capture-fifo) test_raced_nonregular_capture_is_no_follow_or_manual_recovery fifo; exit ;;
  capture-directory) test_raced_nonregular_capture_is_no_follow_or_manual_recovery directory; exit ;;
  capture-manual-hard-exit) test_capture_manual_hard_exit_is_stage_routed; exit ;;
  unregister-manual-hard-exit) test_unregister_manual_hard_exit_is_stage_routed; exit ;;
  rollback-intent-reconcile) test_rollback_capture_intent_reconciles_candidate_or_reports_exact_subtree; exit ;;
  rollback-intent-file) test_rollback_capture_intent_reconciles_candidate_or_reports_exact_subtree file; exit ;;
  rollback-intent-symlink) test_rollback_capture_intent_reconciles_candidate_or_reports_exact_subtree symlink; exit ;;
  rollback-intent-fifo) test_rollback_capture_intent_reconciles_candidate_or_reports_exact_subtree fifo; exit ;;
  rollback-intent-directory) test_rollback_capture_intent_reconciles_candidate_or_reports_exact_subtree directory; exit ;;
  rollback-recovery-fsync-order) test_rollback_recovery_syncs_rename_parents_before_candidate_claim; exit ;;
  rollback-recovery-fsync-failure) test_rollback_recovery_parent_fsync_failure_retains_intent; exit ;;
  rollback-symlink-dir-intent) test_rollback_incomplete_intent_symlink_to_directory_reports_object; exit ;;
  rollback-recovery-substitution) test_rollback_recovery_never_publishes_substituted_candidate_path; exit ;;
  rollback-manual-hard-exit) test_rollback_manual_stage_hard_exit_still_reports_exact_candidate; exit ;;
  activation-detach-intent) test_activation_detach_intent_survives_ready_unlink_crash; exit ;;
  finalize-partial) test_finalize_partial_retry_tracks_identity_and_only_delete_intent_may_be_missing retry; exit ;;
  finalize-identity) test_finalize_rejects_same_shape_artifact_identity_substitution; exit ;;
  finalize-rc7) test_post_rmdir_fsync_failure_is_truthful_and_retains_launcher; exit ;;
  uninstall-link-race) test_uninstall_changed_and_unchanged_are_no_clobber_transactions; exit ;;
  uninstall-changed-race) test_uninstall_changed_and_unchanged_are_no_clobber_transactions changed; exit ;;
  uninstall-unchanged-race) test_uninstall_changed_and_unchanged_are_no_clobber_transactions unchanged; exit ;;
  stale-hook-transaction) test_stale_hook_transactions_block_install_and_uninstall; exit ;;
  stale-install) test_stale_hook_transactions_block_install_and_uninstall install; exit ;;
  stale-uninstall) test_stale_hook_transactions_block_install_and_uninstall uninstall; exit ;;
  nested-ambiguity) test_nested_duplicate_hook_keys_fail_closed_without_uninstall_deletion; exit ;;
  canonical-hook-command) test_canonical_hook_command_and_legacy_ownership; exit ;;
  guard-first-order) test_guard_first_migration_preserves_foreign_lexical_order; exit ;;
  preserve-idempotent) test_hook_registration_preserves_foreign_groups_and_is_idempotent; exit ;;
  hook-collision) test_control_hook_collision_fails_closed; exit ;;
  uninstall-hooks) test_uninstall_removes_only_exact_owned_hook_artifacts; exit ;;
  malformed-hooks) test_malformed_hooks_fail_closed_with_private_backup; exit ;;
  preexisting-hook-link) test_failed_hook_registration_preserves_preexisting_owned_hook_link; exit ;;
  unsafe-hooks-path) test_hooks_config_symlink_and_nonregular_fail_closed; exit ;;
  private-hooks) test_new_hooks_file_is_private; exit ;;
  unsupported-tuis) test_unsupported_tuis_receive_no_guard_wiring; exit ;;
  *) echo "unknown JHW_INSTALL_TEST_ONLY selection" >&2; exit 2 ;;
esac

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
test_current_v4_control_host_contract_allows_activation
test_missing_control_host_fails_before_activation
test_non_v4_control_host_contract_fails_before_activation
test_installer_uses_lockfile_exact_npm_ci
test_empty_uninstall_creates_nothing
test_owned_round_trip
test_fresh_install_creates_both_control_links_and_exact_hooks
test_install_orders_guard_transaction_and_runs_public_preflight
test_install_aborts_on_guard_diagnostic_execution_failure
test_install_rejects_malformed_diagnostic_and_rolls_back_hooks
test_install_requires_complete_guard_diagnostic_schema
test_preflight_failure_restores_exact_prior_hook_state
test_default_unprovisioned_install_removes_owned_guard_hooks_and_preserves_foreign_hooks
test_no_coordinates_with_explicit_invalid_guard_mode_aborts
test_rollback_failure_preserves_launcher_and_private_recovery_snapshot
test_rollback_capture_preserves_concurrent_hook_changes
test_rollback_same_bytes_new_inode_is_not_owned_publication
test_launcher_uninstall_races_preserve_replacements
test_launcher_failed_install_rollback_races_are_no_clobber
test_launcher_transaction_hard_exits_leave_inspectable_evidence
test_stale_hook_link_transactions_block_install_and_uninstall
test_rollback_after_mutation_failure_retains_truthful_private_evidence
test_registration_capture_publish_race_never_clobbers_winner
test_rollback_capture_restore_race_never_clobbers_winner
test_parse_failure_restore_race_preserves_winner_and_backup
test_invalid_utf8_hooks_backup_and_restore_are_byte_exact
test_capture_intent_is_durable_before_rename
test_observed_existing_capture_enoent_is_not_missing
test_post_rename_capture_error_is_reconciled_from_intent
test_capture_intent_reconcile_rejects_any_extra_artifact
test_raced_nonregular_capture_is_no_follow_or_manual_recovery
test_capture_manual_hard_exit_is_stage_routed
test_unregister_manual_hard_exit_is_stage_routed
test_rollback_capture_intent_reconciles_candidate_or_reports_exact_subtree
test_rollback_recovery_syncs_rename_parents_before_candidate_claim
test_rollback_recovery_parent_fsync_failure_retains_intent
test_rollback_incomplete_intent_symlink_to_directory_reports_object
test_rollback_recovery_never_publishes_substituted_candidate_path
test_rollback_manual_stage_hard_exit_still_reports_exact_candidate
test_activation_detach_intent_survives_ready_unlink_crash
test_finalize_partial_retry_tracks_identity_and_only_delete_intent_may_be_missing
test_finalize_rejects_same_shape_artifact_identity_substitution
test_post_rmdir_fsync_failure_is_truthful_and_retains_launcher
test_uninstall_changed_and_unchanged_are_no_clobber_transactions
test_stale_hook_transactions_block_install_and_uninstall
test_nested_duplicate_hook_keys_fail_closed_without_uninstall_deletion
test_canonical_hook_command_and_legacy_ownership
test_guard_first_migration_preserves_foreign_lexical_order
test_hook_registration_preserves_foreign_groups_and_is_idempotent
test_control_hook_collision_fails_closed
test_uninstall_removes_only_exact_owned_hook_artifacts
test_malformed_hooks_fail_closed_with_private_backup
test_failed_hook_registration_preserves_preexisting_owned_hook_link
test_hooks_config_symlink_and_nonregular_fail_closed
test_new_hooks_file_is_private
test_unsupported_tuis_receive_no_guard_wiring
node "$REPO_ROOT/scripts/test-task-skill-contract.mjs"
echo "installer safety: ok"
