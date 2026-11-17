import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
