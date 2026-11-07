import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const editor = path.join(repositoryRoot, "scripts/install-config.mjs");
const mcpEntry = path.join(repositoryRoot, "mcp-server/dist/index.js");
const canonicalPolicy = '{"version":1,"mode":"observe"}\n';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jhw-guard-policy-wiring-"));
  const home = path.join(root, "home");
  const directory = path.join(home, ".config/jhw-control");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.chmodSync(path.join(home, ".config"), 0o700);
  fs.chmodSync(directory, 0o700);
  return {
    root,
    home,
    policy: path.join(directory, "guard-policy.json"),
    transaction: path.join(directory, ".guard-policy.json.jhw-txn.test"),
  };
}

function run(f, operation, transition, { transaction = false, create = false } = {}) {
  if (create) fs.mkdirSync(f.transaction, { mode: 0o700 });
  return spawnSync(process.execPath, [
    editor,
    operation,
    f.policy,
    mcpEntry,
    repositoryRoot,
    transaction ? f.transaction : "",
    transition,
  ], { env: { ...process.env, HOME: f.home }, encoding: "utf8" });
}

function nodeWrapper(f, { racePolicy = false, failPolicyRollbackFsync = false } = {}) {
  const directory = path.join(f.root, "bin");
  const wrapper = path.join(directory, "node");
  const log = path.join(f.root, "config-operations.log");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(wrapper, `#!/bin/bash
if [ "$1" = ${JSON.stringify(editor)} ]; then
  printf '%s\\n' "$2" >>${JSON.stringify(log)}
  if [ "$2" = register-guard-policy-transaction ] && [ "\${JHW_POLICY_RACE:-0}" = 1 ]; then
    printf '%s' '{"version":1,"mode":"observe"}' >${JSON.stringify(f.policy)}
    chmod 0644 ${JSON.stringify(f.policy)}
  fi
fi
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o700 });
  let preload;
  if (failPolicyRollbackFsync) {
    preload = path.join(f.root, "policy-fsync-failure.cjs");
    fs.writeFileSync(preload, `
const fs = require("node:fs");
if (process.argv[2] === "rollback-guard-policy-transaction") {
  fs.fsyncSync = () => { throw new Error("injected policy rollback fsync failure"); };
}
`, { mode: 0o600 });
  }
  return { directory, log, racePolicy, preload };
}

function runWiring(f, script, wrapper) {
  return spawnSync("/bin/bash", ["-c", `
set -euo pipefail
SCRIPT_DIR="$1"
source "$1/scripts/install-wiring.sh"
initialize_wiring_directories
trap rollback_install_transaction_on_exit EXIT
${script}
trap - EXIT
`, "guard-policy-test", repositoryRoot], {
    env: {
      ...process.env,
      HOME: f.home,
      ...(wrapper ? {
        PATH: `${wrapper.directory}:${process.env.PATH}`,
        JHW_POLICY_RACE: wrapper.racePolicy ? "1" : "0",
        ...(wrapper.preload ? { NODE_OPTIONS: `--require=${wrapper.preload}` } : {}),
      } : {}),
    },
    encoding: "utf8",
  });
}

test("read-only policy planning distinguishes the exact current state without mutation", () => {
  const f = fixture();
  const before = fs.readdirSync(path.dirname(f.policy));
  const absent = run(f, "check-guard-policy", "absent:observe");
  assert.equal(absent.status, 0, absent.stderr);
  assert.deepEqual(fs.readdirSync(path.dirname(f.policy)), before);

  fs.writeFileSync(f.policy, canonicalPolicy, { mode: 0o600 });
  const observe = run(f, "check-guard-policy", "observe:observe");
  assert.equal(observe.status, 0, observe.stderr);
  const wrongCurrent = run(f, "check-guard-policy", "absent:observe");
  assert.equal(wrongCurrent.status, 4);
});

test("policy transaction publishes canonical observe bytes and rollback restores absence", () => {
  const f = fixture();
  const registered = run(f, "register-guard-policy-transaction", "absent:observe", { transaction: true, create: true });
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(fs.readFileSync(f.policy, "utf8"), canonicalPolicy);
  assert.equal(fs.statSync(f.policy).mode & 0o777, 0o600);

  const inspected = run(f, "inspect-guard-policy-transaction", "absent:observe", { transaction: true });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).stage, "activated");

  const rolledBack = run(f, "rollback-guard-policy-transaction", "absent:observe", { transaction: true });
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(fs.existsSync(f.policy), false);
  const finalized = run(f, "finalize-guard-policy-transaction", "rollback-restored", { transaction: true });
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(fs.existsSync(f.transaction), false);
});

test("unsafe existing policy is preserved byte-for-byte and rejected before publication", () => {
  const f = fixture();
  fs.writeFileSync(f.policy, canonicalPolicy, { mode: 0o644 });
  const before = fs.readFileSync(f.policy);
  const result = run(f, "register-guard-policy-transaction", "observe:observe", { transaction: true, create: true });
  assert.equal(result.status, 4, result.stderr);
  assert.deepEqual(fs.readFileSync(f.policy), before);
  assert.equal(fs.statSync(f.policy).mode & 0o777, 0o644);
});

test("successful policy finalize removes only its private evidence", () => {
  const f = fixture();
  assert.equal(run(f, "register-guard-policy-transaction", "absent:observe", { transaction: true, create: true }).status, 0);
  const finalized = run(f, "finalize-guard-policy-transaction", "activated", { transaction: true });
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(fs.existsSync(f.transaction), false);
  assert.equal(fs.readFileSync(f.policy, "utf8"), canonicalPolicy);
});

test("policy transaction refuses a manifest relabeled from another operation", () => {
  const f = fixture();
  assert.equal(run(f, "register-guard-policy-transaction", "absent:observe", { transaction: true, create: true }).status, 0);
  const manifestPath = path.join(f.transaction, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.operation = "register";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  assert.equal(run(f, "inspect-guard-policy-transaction", "absent:observe", { transaction: true }).status, 1);
  assert.equal(fs.readFileSync(f.policy, "utf8"), canonicalPolicy);
});

test("policy operations reject unsupported transitions and symlinked private parents", () => {
  const invalid = fixture();
  assert.equal(run(invalid, "check-guard-policy", "absent:enforce").status, 4);

  const linked = fixture();
  const real = path.join(linked.root, "real-control");
  fs.mkdirSync(real, { mode: 0o700 });
  fs.rmdirSync(path.dirname(linked.policy));
  fs.symlinkSync(real, path.dirname(linked.policy));
  assert.equal(run(linked, "check-guard-policy", "absent:observe").status, 0);
  assert.equal(run(linked, "register-guard-policy-transaction", "absent:observe", {
    transaction: true,
    create: true,
  }).status, 1);
  assert.equal(fs.existsSync(linked.policy), false);
});

test("wiring coordinator activates both full hook groups before policy and finalizes all evidence", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.home, ".claude"), { mode: 0o700 });
  fs.mkdirSync(path.join(f.home, ".codex"), { mode: 0o700 });
  const wrapper = nodeWrapper(f);
  const result = runWiring(f, `
begin_guard_observe_transition absent
finalize_wiring
`, wrapper);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(f.policy, "utf8"), canonicalPolicy);
  for (const file of [path.join(f.home, ".claude/settings.json"), path.join(f.home, ".codex/hooks.json")]) {
    const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionEnd", "UserPromptSubmit"]);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(f.policy)).filter((name) => name.includes("jhw-txn")), []);
  assert.deepEqual(fs.readdirSync(path.join(f.home, ".claude")).filter((name) => name.includes("jhw-txn")), []);
  assert.deepEqual(fs.readdirSync(path.join(f.home, ".codex")).filter((name) => name.includes("jhw-txn")), []);
  const operations = fs.readFileSync(wrapper.log, "utf8").trim().split("\n");
  assert.ok(operations.indexOf("register-claude-hooks-transaction") < operations.indexOf("register-codex-hooks-transaction"));
  assert.ok(operations.indexOf("register-codex-hooks-transaction") < operations.indexOf("register-guard-policy-transaction"));
});

test("policy publication race rolls both hook configs back without overwriting the raced policy", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.home, ".claude"), { mode: 0o700 });
  fs.mkdirSync(path.join(f.home, ".codex"), { mode: 0o700 });
  const claude = path.join(f.home, ".claude/settings.json");
  const codex = path.join(f.home, ".codex/hooks.json");
  fs.writeFileSync(claude, "{ }\n", { mode: 0o640 });
  fs.writeFileSync(codex, "{ }\n", { mode: 0o640 });
  const wrapper = nodeWrapper(f, { racePolicy: true });
  const result = runWiring(f, "begin_guard_observe_transition absent", wrapper);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(claude, "utf8"), "{ }\n");
  assert.equal(fs.readFileSync(codex, "utf8"), "{ }\n");
  assert.equal(fs.statSync(claude).mode & 0o777, 0o640);
  assert.equal(fs.statSync(codex).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(f.policy, "utf8"), '{"version":1,"mode":"observe"}');
  assert.equal(fs.statSync(f.policy).mode & 0o777, 0o644);
  for (const directory of [path.dirname(f.policy), path.dirname(claude), path.dirname(codex)]) {
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes("jhw-txn")), []);
  }
});

test("shared hook scope uses live private policy without environment coordinates", () => {
  const missing = fixture();
  fs.rmSync(path.join(missing.home, ".config"), { recursive: true });
  const sessionOnly = runWiring(missing, 'resolve_guard_hook_scope; printf "%s\\n" "$GUARD_HOOK_SCOPE"');
  assert.equal(sessionOnly.status, 0, sessionOnly.stderr);
  assert.equal(sessionOnly.stdout.trim(), "session-end-only");

  const observed = fixture();
  fs.writeFileSync(observed.policy, canonicalPolicy, { mode: 0o600 });
  const all = runWiring(observed, 'resolve_guard_hook_scope; printf "%s\\n" "$GUARD_HOOK_SCOPE"');
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.stdout.trim(), "all");

  const unsafe = fixture();
  fs.writeFileSync(unsafe.policy, canonicalPolicy, { mode: 0o644 });
  const rejected = runWiring(unsafe, "resolve_guard_hook_scope");
  assert.notEqual(rejected.status, 0);
});

test("sidecar recovery loads only an exact validated policy transaction context", () => {
  const f = fixture();
  assert.equal(run(f, "register-guard-policy-transaction", "absent:observe", { transaction: true, create: true }).status, 0);
  const loaded = runWiring(f, `
load_guard_policy_transaction_context ${JSON.stringify(f.policy)} ${JSON.stringify(f.transaction)} absent:observe activated
printf '%s\\n' "$GUARD_POLICY_TRANSACTION_STAGE"
`);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout.trim(), "activated");

  const manifestPath = path.join(f.transaction, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.stage = "finalize-intent";
  manifest.finalizeFrom = "activated";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const resumedFinalize = runWiring(f, `
load_guard_policy_transaction_context ${JSON.stringify(f.policy)} ${JSON.stringify(f.transaction)} absent:observe activated
printf '%s|%s\\n' "$GUARD_POLICY_TRANSACTION_STAGE" "$GUARD_POLICY_TRANSACTION_FINALIZE_FROM"
`);
  assert.equal(resumedFinalize.status, 0, resumedFinalize.stderr);
  assert.equal(resumedFinalize.stdout.trim(), "finalize-intent|activated");
  const rejectedPhysicalStage = runWiring(f, `
load_guard_policy_transaction_context ${JSON.stringify(f.policy)} ${JSON.stringify(f.transaction)} absent:observe finalize-intent
`);
  assert.notEqual(rejectedPhysicalStage.status, 0);

  const wrong = path.join(f.root, ".guard-policy.json.jhw-txn.wrong");
  fs.mkdirSync(wrong, { mode: 0o700 });
  const rejected = runWiring(f, `
load_guard_policy_transaction_context ${JSON.stringify(f.policy)} ${JSON.stringify(wrong)} absent:observe activated
`);
  assert.notEqual(rejected.status, 0);
  assert.equal(fs.readFileSync(f.policy, "utf8"), canonicalPolicy);
});

test("explicit live observe policy never degrades an INVALID_CONFIG preflight into unprotected session-only", () => {
  const absent = fixture();
  const allowed = runWiring(absent, `
is_unprovisioned_control_diagnostic '{"error":{"code":"INVALID_CONFIG"}}' 78
`);
  assert.equal(allowed.status, 0, allowed.stderr);

  const observed = fixture();
  fs.writeFileSync(observed.policy, canonicalPolicy, { mode: 0o600 });
  const rejected = runWiring(observed, `
is_unprovisioned_control_diagnostic '{"error":{"code":"INVALID_CONFIG"}}' 78
`);
  assert.notEqual(rejected.status, 0);
});

test("observe transition plans both full hook targets before any transaction mutation", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.home, ".claude"), { mode: 0o700 });
  fs.mkdirSync(path.join(f.home, ".codex"), { mode: 0o700 });
  const malformed = path.join(f.home, ".claude/settings.json");
  fs.writeFileSync(malformed, "{", { mode: 0o600 });
  const wrapper = nodeWrapper(f);
  const result = runWiring(f, "begin_guard_observe_transition absent", wrapper);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(malformed, "utf8"), "{");
  assert.equal(fs.existsSync(path.join(f.home, ".codex/hooks.json")), false);
  const operations = fs.readFileSync(wrapper.log, "utf8").trim().split("\n");
  assert.ok(operations.includes("check-claude-hooks"));
  assert.equal(operations.some((name) => name.startsWith("register-")), false);
});

test("candidate policy target rejects missing, symlinked, and writable parents before hook registration", () => {
  for (const kind of ["missing", "symlink", "writable"]) {
    const f = fixture();
    fs.mkdirSync(path.join(f.home, ".claude"), { mode: 0o700 });
    fs.mkdirSync(path.join(f.home, ".codex"), { mode: 0o700 });
    if (kind === "missing") fs.rmSync(path.join(f.home, ".config"), { recursive: true });
    if (kind === "symlink") {
      const target = path.join(f.root, "foreign-control");
      fs.mkdirSync(target, { mode: 0o700 });
      fs.rmdirSync(path.dirname(f.policy));
      fs.symlinkSync(target, path.dirname(f.policy));
    }
    if (kind === "writable") fs.chmodSync(path.dirname(f.policy), 0o770);
    const wrapper = nodeWrapper(f);
    const result = runWiring(f, "begin_guard_observe_transition absent", wrapper);
    assert.notEqual(result.status, 0, kind);
    const operations = fs.existsSync(wrapper.log) ? fs.readFileSync(wrapper.log, "utf8").trim().split("\n") : [];
    assert.equal(operations.some((name) => name.startsWith("register-")), false, kind);
  }
});

test("installer rejects special permission bits and a foreign private namespace owner", () => {
  const special = fixture();
  fs.writeFileSync(special.policy, canonicalPolicy, { mode: 0o600 });
  fs.chmodSync(special.policy, 0o4600);
  assert.equal(run(special, "check-guard-policy", "observe:observe").status, 4);

  const foreign = fixture();
  fs.writeFileSync(foreign.policy, canonicalPolicy, { mode: 0o600 });
  const preload = path.join(foreign.root, "foreign-owner.cjs");
  fs.writeFileSync(preload, `
const fs = require("node:fs");
const real = fs.lstatSync.bind(fs);
fs.lstatSync = (file, ...args) => {
  const info = real(file, ...args);
  if (String(file) === ${JSON.stringify(path.join(foreign.home, ".config"))}) {
    return new Proxy(info, { get(target, property) { return property === "uid" ? target.uid + 1 : target[property]; } });
  }
  return info;
};
`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [editor, "check-guard-policy", foreign.policy, mcpEntry,
    repositoryRoot, "", "observe:observe"], {
    env: { ...process.env, HOME: foreign.home, NODE_OPTIONS: `--require=${preload}` },
  });
  assert.equal(result.status, 1);
});

function assertFullHooks(file) {
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).hooks).sort(),
    ["PostToolUse", "PreToolUse", "SessionEnd", "UserPromptSubmit"]);
}

test("same-bytes new-inode policy rollback failure preserves full hooks and all three recovery objects", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.home, ".claude"), { mode: 0o700 });
  fs.mkdirSync(path.join(f.home, ".codex"), { mode: 0o700 });
  const result = runWiring(f, `
begin_guard_observe_transition absent
node -e 'const fs=require("node:fs"); const file=process.argv[1]; const bytes=fs.readFileSync(file); const next=file+".new"; fs.writeFileSync(next,bytes,{mode:0o600}); fs.renameSync(next,file)' "$HOME/.config/jhw-control/guard-policy.json"
set +e
rollback_install_transaction
rollback_rc=$?
set -e
printf 'rollback_rc=%s\\n' "$rollback_rc"
trap - EXIT
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rollback_rc=1/);
  assertFullHooks(path.join(f.home, ".claude/settings.json"));
  assertFullHooks(path.join(f.home, ".codex/hooks.json"));
  assert.equal(fs.readdirSync(path.join(f.home, ".claude")).filter((name) => name.includes("jhw-txn")).length, 1);
  assert.equal(fs.readdirSync(path.join(f.home, ".codex")).filter((name) => name.includes("jhw-txn")).length, 1);
  assert.equal(fs.readdirSync(path.dirname(f.policy)).filter((name) => name.includes("jhw-txn")).length, 1);
});

test("policy rollback fsync failure preserves the coordinated live target and all recovery evidence", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.home, ".claude"), { mode: 0o700 });
  fs.mkdirSync(path.join(f.home, ".codex"), { mode: 0o700 });
  const wrapper = nodeWrapper(f, { failPolicyRollbackFsync: true });
  const result = runWiring(f, `
begin_guard_observe_transition absent
set +e
rollback_install_transaction
rollback_rc=$?
set -e
printf 'rollback_rc=%s\\n' "$rollback_rc"
trap - EXIT
`, wrapper);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rollback_rc=1/);
  assertFullHooks(path.join(f.home, ".claude/settings.json"));
  assertFullHooks(path.join(f.home, ".codex/hooks.json"));
  assert.equal(fs.readdirSync(path.join(f.home, ".claude")).filter((name) => name.includes("jhw-txn")).length, 1);
  assert.equal(fs.readdirSync(path.join(f.home, ".codex")).filter((name) => name.includes("jhw-txn")).length, 1);
  assert.equal(fs.readdirSync(path.dirname(f.policy)).filter((name) => name.includes("jhw-txn")).length, 1);
});

test("successful coordinated rollback restores all three originals before finalizing evidence", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.home, ".claude"), { mode: 0o700 });
  fs.mkdirSync(path.join(f.home, ".codex"), { mode: 0o700 });
  const result = runWiring(f, `
begin_guard_observe_transition absent
rollback_install_transaction
trap - EXIT
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.policy), false);
  assert.equal(fs.existsSync(path.join(f.home, ".claude/settings.json")), false);
  assert.equal(fs.existsSync(path.join(f.home, ".codex/hooks.json")), false);
  for (const directory of [path.dirname(f.policy), path.join(f.home, ".claude"), path.join(f.home, ".codex")]) {
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes("jhw-txn")), []);
  }
});
