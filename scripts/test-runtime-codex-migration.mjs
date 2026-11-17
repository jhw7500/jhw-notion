import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readRuntimeJournalV2 } from "./runtime-prune.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const editor = path.join(repositoryRoot, "scripts", "install-config.mjs");
const entry = path.join(repositoryRoot, "mcp-server", "dist", "index.js");
const binding = "JHW_RUNTIME_SESSION_BINDING";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jhw-codex-migration-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "config.toml");
  return { root, config };
}

function run(operation, config, { adoptFrom, stamp = "20261117000000" } = {}) {
  return spawnSync(process.execPath, [editor, operation, config, entry, repositoryRoot, stamp], {
    encoding: "utf8",
    env: adoptFrom ? { ...process.env, JHW_ADOPT_FROM: adoptFrom } : process.env,
  });
}

function writeConfig(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function transactionFixture(t) {
  const current = fixture(t);
  const evidence = path.join(current.root, ".jhw-runtime/v2/journals/d-00000000000000000000000000000000");
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  fs.chmodSync(evidence, 0o700);
  const source = `[mcp_servers.jhw-notion]\ncommand = "node"\nargs = ${JSON.stringify([entry])}\nstartup_timeout_sec = 60.0\n`;
  writeConfig(current.config, source);
  const args = [editor, "migrate-codex-binding-transaction", current.config, entry, repositoryRoot,
    "r-0000000000000000000000000000000000000000-0000000000000000000000000000000000000000000000000000000000000000", evidence];
  return { ...current, evidence, source, args };
}

function startTransaction(current) {
  return spawn(process.execPath, current.args, { stdio: ["ignore", "ignore", "ignore", "ipc"] });
}

async function waitUntilStopped(child) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try { if (/^State:\s+T/m.test(fs.readFileSync(`/proc/${child.pid}/status`, "utf8"))) return; }
    catch { throw new Error("transaction exited before checkpoint stop"); }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("transaction checkpoint did not stop");
}

function stopAtPhase(child, phase) {
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => reject(new Error(`transaction exited before ${phase}: ${code ?? signal}`));
    child.once("exit", onExit);
    child.on("message", async (message) => {
      await waitUntilStopped(child);
      if (message?.phase === phase) { child.off("exit", onExit); resolve(message); }
      else process.kill(child.pid, "SIGCONT");
    });
  });
}

function journal(current) {
  try {
    const header = JSON.parse(fs.readFileSync(path.join(current.evidence, "state.json"), "utf8"));
    return header.control ? JSON.parse(fs.readFileSync(path.join(current.evidence, header.control.name, "state.json"), "utf8")) : header;
  }
  catch { return null; }
}

function quarantinePath(current) {
  const capture = journal(current)?.captures?.source;
  return capture ? path.join(current.evidence, capture.name, "object") : path.join(current.evidence, "quarantine");
}

function parseJournal(current) {
  return readRuntimeJournalV2({ repositoryRoot: current.root, journalDirectory: current.evidence }).state;
}

function sectionBody(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === header || trimmed.startsWith(`${header} #`);
  });
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("[")) end += 1;
  return lines.slice(start + 1, end).join("\n");
}

function parseGeneratedEnvironment(text, parentEnvironment) {
  const parent = sectionBody(text, "[mcp_servers.jhw-notion]");
  const envLine = /^\s*env_vars\s*=\s*(\[[^\n]*\])\s*(?:#.*)?$/m.exec(parent);
  assert.ok(envLine, "generated Codex entry must contain env_vars");
  const envVars = JSON.parse(envLine[1]);
  const childEnvironment = Object.fromEntries(
    envVars.filter((name) => parentEnvironment[name] !== undefined)
      .map((name) => [name, parentEnvironment[name]]),
  );
  const child = sectionBody(text, "[mcp_servers.jhw-notion.env]");
  for (const line of child.split("\n")) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line);
    if (assignment) childEnvironment[assignment[1]] = JSON.parse(assignment[2]);
  }
  return { envVars, childEnvironment };
}

function assertLauncherReceivesBinding(text, { userEnvironment = true } = {}) {
  const parentToken = "fixture-parent-binding";
  const { envVars, childEnvironment } = parseGeneratedEnvironment(text, {
    JHW_RUNTIME_SESSION_BINDING: parentToken,
    NOTION_API_KEY: "fixture-parent-key",
    UNLISTED_SECRET: "must-not-pass",
  });
  const launcher = spawnSync(process.execPath, ["-e", `
    process.stdout.write(JSON.stringify({
      binding: process.env.JHW_RUNTIME_SESSION_BINDING,
      notion: process.env.NOTION_API_KEY,
      version: process.env.NOTION_VERSION,
      unlisted: process.env.UNLISTED_SECRET,
    }));
  `], { encoding: "utf8", env: childEnvironment });
  assert.equal(launcher.status, 0, launcher.stderr);
  assert.equal(envVars.filter((name) => name === binding).length, 1);
  assert.equal(childEnvironment.JHW_RUNTIME_SESSION_BINDING, parentToken);
  assert.deepEqual(JSON.parse(launcher.stdout), userEnvironment ? {
    binding: parentToken,
    notion: "fixture-parent-key",
    version: "2022-06-28",
  } : { binding: parentToken });
}

test("codex generated whitelist preserves binding and user environment", (t) => {
  const fresh = fixture(t);
  writeConfig(fresh.config, 'model = "fixture"\n# unrelated comment\n');
  const freshResult = run("register-codex", fresh.config);
  assert.equal(freshResult.status, 0, freshResult.stderr);
  const freshText = fs.readFileSync(fresh.config, "utf8");
  assertLauncherReceivesBinding(freshText, { userEnvironment: false });
  assert.match(freshText, /^model = "fixture"\n# unrelated comment\n/m);

  const owned = fixture(t);
  const unrelatedTomlBefore = 'model = "fixture"\n# keep these bytes\n\n';
  writeConfig(owned.config, `${unrelatedTomlBefore}[mcp_servers.jhw-notion]\ncommand = "node"\nargs = ${JSON.stringify([entry])}\nstartup_timeout_sec = 60.0\n# keep env comment\nenv_vars = ["NOTION_API_KEY"]\n\n[mcp_servers.jhw-notion.env]\nNOTION_VERSION = "2022-06-28"\n`);
  const ownedResult = run("register-codex", owned.config);
  assert.equal(ownedResult.status, 0, ownedResult.stderr);
  const ownedText = fs.readFileSync(owned.config, "utf8");
  assert.equal(ownedText.slice(0, unrelatedTomlBefore.length), unrelatedTomlBefore);
  assert.match(ownedText, /# keep env comment/);
  assertLauncherReceivesBinding(ownedText);

  const adopted = fixture(t);
  const adoptRoot = path.join(adopted.root, "legacy");
  const legacyEntry = path.join(adoptRoot, "mcp-server", "dist", "index.js");
  fs.mkdirSync(path.dirname(legacyEntry), { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacyEntry, "legacy", { mode: 0o600 });
  const beforeSection = 'model = "fixture"\n# unrelated before bytes\n\n';
  const afterSection = '\n[unrelated.after]\nkeep = "exact" # unrelated after bytes\n';
  writeConfig(adopted.config, `${beforeSection}[mcp_servers.jhw-notion]\n  command   =   "node"   # keep command comment\n  args = ${JSON.stringify([legacyEntry])} # keep args comment\n startup_timeout_sec = 17.0 # keep timeout comment\n env_vars = ["NOTION_API_KEY"] # keep whitelist comment\n\n[mcp_servers.jhw-notion.env] # keep child header comment\nNOTION_VERSION = "2022-06-28" # keep child value comment\n${afterSection}`);
  const adoptedResult = run("register-codex", adopted.config, { adoptFrom: adoptRoot });
  assert.equal(adoptedResult.status, 0, adoptedResult.stderr);
  const adoptedText = fs.readFileSync(adopted.config, "utf8");
  assert.equal(adoptedText, `${beforeSection}[mcp_servers.jhw-notion]\n  command   =   "node"   # keep command comment\n  args = ${JSON.stringify([entry])} # keep args comment\n startup_timeout_sec = 60.0 # keep timeout comment\n env_vars = ["NOTION_API_KEY","${binding}"] # keep whitelist comment\n\n[mcp_servers.jhw-notion.env] # keep child header comment\nNOTION_VERSION = "2022-06-28" # keep child value comment\n${afterSection}`);
  assertLauncherReceivesBinding(adoptedText);
});

test("codex binding preflight rejects ambiguous or unsafe environment without mutation", (t) => {
  const variants = [
    ['env_vars = ["NOTION_API_KEY"]\nenv_vars = ["OTHER"]\n', "duplicate env_vars assignment"],
    ['env_vars = ["NOTION_API_KEY", "NOTION_API_KEY"]\n', "duplicate whitelist name"],
    ['env_vars = ["NODE_OPTIONS"]\n', "loader whitelist name"],
    ['env_vars = ["NOTION_API_KEY"]\n\n[mcp_servers.jhw-notion.env]\nNOTION_API_KEY = "duplicate"\n', "duplicate parent and child key"],
    ['\n[mcp_servers.jhw-notion.env]\nNOTION_VERSION = "one"\nNOTION_VERSION = "two"\n', "duplicate child key"],
    [`\n[mcp_servers.jhw-notion.env]\n${binding} = "duplicate"\n`, "binding in child table"],
    ['startup_timeout_sec = 30.0\n', "duplicate startup timeout key"],
    ['\n[mcp_servers.jhw-notion.env]\nNOTION_VERSION = "unterminated\n', "malformed child value"],
  ];
  const accepted = [];
  for (const [environment, label] of variants) {
    const current = fixture(t);
    const before = `[mcp_servers.jhw-notion]\ncommand = "node"\nargs = ${JSON.stringify([entry])}\nstartup_timeout_sec = 60.0\n${environment}`;
    writeConfig(current.config, before);
    const result = run("check-codex-binding-migration", current.config);
    if (result.status === 0) accepted.push(label);
    assert.equal(fs.readFileSync(current.config, "utf8"), before, label);
  }
  assert.deepEqual(accepted, []);
});

test("codex binding capability is read-only and strict verification is opt-in", (t) => {
  const current = fixture(t);
  writeConfig(current.config, `[mcp_servers.jhw-notion]\ncommand = "node"\nargs = ${JSON.stringify([entry])}\nstartup_timeout_sec = 60.0\n`);
  const before = fs.statSync(current.config, { bigint: true });
  const legacy = run("verify-codex", current.config);
  assert.equal(legacy.status, 0, legacy.stderr);
  const strictBefore = run("verify-codex-binding", current.config);
  assert.notEqual(strictBefore.status, 0);
  const capability = run("check-codex-binding-migration", current.config);
  assert.equal(capability.status, 0, capability.stderr);
  assert.deepEqual(JSON.parse(capability.stdout), {
    version: 1,
    capabilities: ["codex-binding-migration-v1"],
  });
  const after = fs.statSync(current.config, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
});

test("codex binding registration is byte-identical on retry and uninstall reports only user environment", (t) => {
  const defaultOnly = fixture(t);
  writeConfig(defaultOnly.config, "");
  assert.equal(run("register-codex", defaultOnly.config).status, 0);
  const before = fs.statSync(defaultOnly.config, { bigint: true });
  const backupsBefore = fs.readdirSync(defaultOnly.root).filter((name) => name.includes(".bak."));
  const retry = run("register-codex", defaultOnly.config);
  assert.equal(retry.status, 3, retry.stderr);
  const after = fs.statSync(defaultOnly.config, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(fs.readdirSync(defaultOnly.root).filter((name) => name.includes(".bak.")), backupsBefore);
  const defaultOnlyUninstall = run("unregister-codex", defaultOnly.config);
  assert.equal(defaultOnlyUninstall.status, 0, defaultOnlyUninstall.stderr);
  const defaultEnvDropped = defaultOnlyUninstall.stdout.trim() ? ["codex"] : [];
  assert.deepEqual(defaultEnvDropped, []);

  const user = fixture(t);
  writeConfig(user.config, `[mcp_servers.jhw-notion]\ncommand = "node"\nargs = ${JSON.stringify([entry])}\nstartup_timeout_sec = 60.0\nenv_vars = ["NOTION_API_KEY", "${binding}"]\n`);
  const userUninstall = run("unregister-codex", user.config);
  assert.equal(userUninstall.status, 0, userUninstall.stderr);
  const userEnvDropped = userUninstall.stdout.trim() ? ["codex"] : [];
  assert.equal(userEnvDropped.includes("codex"), true);
});

test("owned Codex registration with binding preserves the complete block bytes", (t) => {
  const current = fixture(t);
  const source = `[mcp_servers.jhw-notion]\ncommand = "node" # keep command comment\nargs = ${JSON.stringify([entry])} # keep args comment\nstartup_timeout_sec=45.0 # keep timeout formatting\n# keep binding comment\nenv_vars = ["${binding}"] # keep whitelist comment\n`;
  writeConfig(current.config, source);
  const before = fs.statSync(current.config, { bigint: true });
  const backupsBefore = fs.readdirSync(current.root).filter((name) => name.includes(".bak."));
  const result = run("register-codex", current.config);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(fs.readFileSync(current.config, "utf8"), source);
  const after = fs.statSync(current.config, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(fs.readdirSync(current.root).filter((name) => name.includes(".bak.")), backupsBefore);
});

test("codex migration never replaces a foreign reoccupied path", async (t) => {
  const current = transactionFixture(t);
  const marker = path.join(current.root, "unrelated"); writeConfig(marker, "unchanged\n");
  const markerBefore = fs.statSync(marker, { bigint: true });
  const child = startTransaction(current);
  await stopAtPhase(child, "quarantined");
  const foreignText = 'model = "foreign-reoccupied"\n';
  writeConfig(current.config, foreignText);
  process.kill(child.pid, "SIGCONT");
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.equal(fs.readFileSync(current.config, "utf8"), foreignText);
  assert.equal(fs.existsSync(quarantinePath(current)), true);
  assert.equal(journal(current).status, "pending");
  const markerAfter = fs.statSync(marker, { bigint: true });
  assert.equal(fs.readFileSync(marker, "utf8"), "unchanged\n");
  assert.deepEqual({ ino: markerAfter.ino, mtimeNs: markerAfter.mtimeNs }, { ino: markerBefore.ino, mtimeNs: markerBefore.mtimeNs });
});

test("codex migration preserves a source replacement after validation", async (t) => {
  const current = transactionFixture(t);const child = startTransaction(current);await stopAtPhase(child, "prepared");
  const foreignText = 'model = "replacement-after-validation"\n';const replacement = path.join(current.root, "replacement");writeConfig(replacement, foreignText);fs.renameSync(replacement, current.config);
  process.kill(child.pid, "SIGCONT");const [code] = await once(child, "exit");assert.notEqual(code, 0);
  assert.equal(fs.readFileSync(current.config, "utf8"), foreignText);assert.equal(journal(current).status, "pending");
});

test("codex migration preserves a symlink reoccupation", async (t) => {
  const current = transactionFixture(t);const child = startTransaction(current);await stopAtPhase(child, "quarantined");
  fs.symlinkSync("foreign-target", current.config);process.kill(child.pid, "SIGCONT");const [code] = await once(child, "exit");assert.notEqual(code, 0);
  assert.equal(fs.readlinkSync(current.config), "foreign-target");assert.equal(journal(current).status, "pending");
});

test("codex migration preserves writes through an old fd", async (t) => {
  const current = transactionFixture(t);
  const oldFd = fs.openSync(current.config, "r+");
  try {
    const child = startTransaction(current);
    await stopAtPhase(child, "quarantined");
    const changed = Buffer.from(current.source.replace("60.0", "61.0"));
    fs.ftruncateSync(oldFd, 0); fs.writeSync(oldFd, changed, 0, changed.length, 0); fs.fsyncSync(oldFd);
    process.kill(child.pid, "SIGCONT");
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
    assert.equal(fs.readFileSync(quarantinePath(current), "utf8"), changed.toString());
    assert.equal(fs.readFileSync(current.config, "utf8"), changed.toString());
    assert.equal(journal(current).status, "pending");
  } finally { fs.closeSync(oldFd); }
});

for (const phase of ["quarantine_intent", "quarantined", "publish_intent", "published", "verified"]) {
  test(`codex migration recovers after ${phase} crash`, async (t) => {
    const current = transactionFixture(t);
    const child = startTransaction(current);
    await stopAtPhase(child, phase);
    process.kill(child.pid, "SIGKILL");
    await once(child, "exit");
    const recovery = spawnSync(process.execPath, current.args, { stdio: "ignore" });
    if (["quarantine_intent", "quarantined", "publish_intent"].includes(phase)) {
      assert.equal(recovery.status, 8);assert.equal(journal(current).status, "complete");assert.match(journal(current).outcome,/^(unchanged|restored-before)$/);
      assert.equal(fs.readFileSync(current.config,"utf8"),current.source);assert.equal(fs.existsSync(quarantinePath(current)),false);assert.equal(fs.existsSync(path.join(current.evidence,"after")),false);
      const nextEvidence=path.join(current.root,`d-${"1".repeat(32)}`);fs.mkdirSync(nextEvidence,{mode:0o700});const nextArgs=[...current.args.slice(0,-1),nextEvidence];
      assert.equal(spawnSync(process.execPath,nextArgs,{stdio:"ignore"}).status,0);assert.equal(run("verify-codex-binding",current.config).status,0);
    } else {
      assert.equal(recovery.status, 0);assert.equal(journal(current).status, "complete");assert.equal(run("verify-codex-binding", current.config).status, 0);
    }
  });
}

for (const target of ["quarantine", "after"]) {
  test(`codex migration preserves foreign ${target} evidence at mutation boundary`, async (t) => {
    const current = transactionFixture(t);
    const child = startTransaction(current);
    await stopAtPhase(child, target === "quarantine" ? "quarantine_intent" : "published");
    const file = target === "quarantine" ? quarantinePath(current) : path.join(current.evidence, "after");
    const replacement = path.join(current.root, "foreign-evidence");
    writeConfig(replacement, "foreign evidence must survive\n");
    const heldFd = fs.openSync(replacement, "r");
    t.after(() => fs.closeSync(heldFd));
    const identity = fs.fstatSync(heldFd, { bigint: true });
    fs.renameSync(replacement, file);
    process.kill(child.pid, "SIGCONT");
    const [code] = await once(child, "exit");
    const found = [];
    const scan = (directory) => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(directory, item.name);
      if (item.isDirectory()) scan(name);
      else if (item.isFile() && fs.statSync(name, { bigint: true }).ino === identity.ino) found.push(name);
    } };
    scan(current.root);
    assert.equal(found.length, 1, "foreign inode must remain in the fixture");
    assert.equal(fs.readFileSync(found[0], "utf8"), "foreign evidence must survive\n");
    assert.notEqual(code, 0);
    assert.equal(journal(current).status, "pending");
  });
}

test("complete codex migration history survives normal live edits and replacements", (t) => {
  const current = transactionFixture(t);
  assert.equal(spawnSync(process.execPath, current.args, { stdio: "ignore" }).status, 0);
  assert.equal(parseJournal(current).status, "complete");
  fs.appendFileSync(current.config, "# normal user edit\n");
  assert.equal(parseJournal(current).status, "complete");
  fs.unlinkSync(current.config);
  fs.symlinkSync("user-owned-target", current.config);
  assert.equal(parseJournal(current).status, "complete");
});

for (const phase of ["restore_intent", "restore_linked", "quarantine_retire_intent", "quarantine_retired", "temp_capture_intent", "temp_captured", "temp_retire_intent", "temp_retired", "verified"]) {
  test(`codex before restoration resumes at ${phase} syscall boundary`, async (t) => {
    const current = transactionFixture(t);
    const original = startTransaction(current);
    await stopAtPhase(original, "quarantined");
    process.kill(original.pid, "SIGKILL"); await once(original, "exit");
    const restore = startTransaction(current);
    await stopAtPhase(restore, phase);
    assert.equal(parseJournal(current).status, "pending");
    process.kill(restore.pid, "SIGKILL"); await once(restore, "exit");
    const retry = spawnSync(process.execPath, current.args, { stdio: "ignore" });
    assert.equal(retry.status, 8);
    assert.equal(fs.readFileSync(current.config, "utf8"), current.source);
    assert.equal(fs.statSync(current.config).nlink, 1);
    assert.equal(parseJournal(current).outcome, "restored-before");
    fs.appendFileSync(current.config, "# edited after restore\n");
    assert.equal(parseJournal(current).status, "complete");
  });
}

for (const phase of ["quarantine_moved", "publish_linked", "temp_capture_intent", "temp_captured", "temp_retire_intent", "temp_retired"]) {
  test(`codex publication resumes at ${phase} syscall boundary`, async (t) => {
    const current = transactionFixture(t); const child = startTransaction(current);
    await stopAtPhase(child, phase);
    assert.equal(parseJournal(current).status, "pending");
    process.kill(child.pid, "SIGKILL"); await once(child, "exit");
    const retry = spawnSync(process.execPath, current.args, { stdio: "ignore" });
    const restored = phase === "quarantine_moved";
    assert.equal(retry.status, restored ? 8 : 0);
    assert.equal(parseJournal(current).outcome, restored ? "restored-before" : "migrated");
    assert.equal(fs.statSync(current.config).nlink, 1);
  });
}

test("codex capture reservation collision preserves the existing directory", async (t) => {
  const current = transactionFixture(t); const child = startTransaction(current);
  const reservation = await stopAtPhase(child, "capture_reserve_intent");
  const directory = path.join(current.evidence, reservation.name);
  fs.mkdirSync(directory, { mode: 0o700 });
  writeConfig(path.join(directory, "foreign"), "reserved by another writer\n");
  const before = fs.statSync(directory, { bigint: true });
  process.kill(child.pid, "SIGCONT"); const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.equal(fs.statSync(directory, { bigint: true }).ino, before.ino);
  assert.equal(fs.readFileSync(path.join(directory, "foreign"), "utf8"), "reserved by another writer\n");
  assert.equal(fs.readFileSync(current.config, "utf8"), current.source);
});

for (const damage of ["identity", "unknown-child"]) {
  test(`codex capture ${damage} is preserved on resume`, async (t) => {
    const current = transactionFixture(t); const child = startTransaction(current);
    await stopAtPhase(child, "quarantined");
    process.kill(child.pid, "SIGKILL"); await once(child, "exit");
    const directory = path.dirname(quarantinePath(current));
    const old = `${directory}-original`;
    if (damage === "identity") {
      fs.renameSync(directory, old); fs.mkdirSync(directory, { mode: 0o700 });
    }
    const marker = path.join(directory, "foreign"); writeConfig(marker, "unknown child survives\n");
    assert.throws(() => parseJournal(current), { code: "DEPLOY_PRUNE_BLOCKED" });
    assert.notEqual(spawnSync(process.execPath, current.args, { stdio: "ignore" }).status, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), "unknown child survives\n");
    assert.equal(fs.readFileSync(path.join(damage === "identity" ? old : directory, "object"), "utf8"), current.source);
  });
}

test("codex journal header replacement is never overwritten by a checkpoint", async (t) => {
  const current = transactionFixture(t); const child = startTransaction(current);
  await stopAtPhase(child, "published");
  const replacement = path.join(current.root, "foreign-header"); writeConfig(replacement, "foreign header\n");
  const held = fs.openSync(replacement, "r"); t.after(() => fs.closeSync(held));
  const before = fs.fstatSync(held, { bigint: true });
  const header = path.join(current.evidence, "state.json"); fs.renameSync(replacement, header);
  process.kill(child.pid, "SIGCONT"); const [code] = await once(child, "exit");
  assert.notEqual(code, 0); assert.equal(fs.statSync(header, { bigint: true }).ino, before.ino);
  assert.equal(fs.readFileSync(header, "utf8"), "foreign header\n");
});

test("restored codex history stays valid after a later successful migration", async (t) => {
  const current = transactionFixture(t); const child = startTransaction(current);
  await stopAtPhase(child, "quarantined"); process.kill(child.pid, "SIGKILL"); await once(child, "exit");
  assert.equal(spawnSync(process.execPath, current.args, { stdio: "ignore" }).status, 8);
  const nextEvidence = path.join(path.dirname(current.evidence), `d-${"2".repeat(32)}`);
  fs.mkdirSync(nextEvidence, { mode: 0o700 });
  assert.equal(spawnSync(process.execPath, [...current.args.slice(0, -1), nextEvidence], { stdio: "ignore" }).status, 0);
  assert.equal(parseJournal(current).outcome, "restored-before");
  assert.equal(parseJournal({ ...current, evidence: nextEvidence }).outcome, "migrated");
});

test("unproven codex restoration links remain pending without deletion", async (t) => {
  const current = transactionFixture(t); const child = startTransaction(current);
  await stopAtPhase(child, "quarantined"); process.kill(child.pid, "SIGKILL"); await once(child, "exit");
  fs.linkSync(quarantinePath(current), current.config);
  assert.throws(() => parseJournal(current), { code: "DEPLOY_PRUNE_BLOCKED" });
  assert.notEqual(spawnSync(process.execPath, current.args, { stdio: "ignore" }).status, 0);
  assert.equal(fs.statSync(current.config).nlink, 2);
  assert.equal(fs.readFileSync(quarantinePath(current), "utf8"), current.source);
});
