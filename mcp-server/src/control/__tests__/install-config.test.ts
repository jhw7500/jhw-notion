import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const editor = join(repositoryRoot, "scripts", "install-config.mjs");
const mcpEntry = join(repositoryRoot, "mcp-server", "dist", "index.js");
const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runEditor(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [editor, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("install-config Claude hook transactions", () => {
  it("registers exact Claude hook groups first while preserving foreign settings and file mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-claude-hook-config-"));
    roots.push(root);
    const claudeDir = join(root, ".claude");
    const settings = join(claudeDir, "settings.json");
    const transaction = join(claudeDir, ".settings.json.jhw-txn.test");
    const foreign = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "foreign-hook", timeout: 9 }],
    };
    const original = `{"theme":"dark", "hooks":{"PreToolUse":[${JSON.stringify(foreign)}]}, "foreignTail":{"keep":"exact spacing"}}\n`;
    await mkdir(transaction, { recursive: true, mode: 0o700 });
    await chmod(transaction, 0o700);
    await writeFile(settings, original, { mode: 0o600 });

    const result = runEditor([
      "register-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
      "all",
    ]);

    expect(result.status).toBe(0);
    const bytes = await readFile(settings, "utf8");
    const parsed = JSON.parse(bytes);
    for (const event of events) {
      expect(parsed.hooks[event][0]).toEqual({
        hooks: [{
          type: "command",
          command: `"$HOME/.local/bin/jhw-control-hook" --adapter claude --event ${event}`,
          timeout: event === "SessionEnd" ? 3 : 12,
        }],
      });
    }
    expect(parsed.hooks.PreToolUse[1]).toEqual(foreign);
    expect(bytes).toContain('"theme":"dark"');
    expect(bytes).toContain('"foreignTail":{"keep":"exact spacing"}');
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
  });

  it("keeps Claude reinstall byte-stable and uninstall removes only exact owned groups", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-claude-hook-config-"));
    roots.push(root);
    const claudeDir = join(root, ".claude");
    const settings = join(claudeDir, "settings.json");
    const foreign = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "foreign-hook", timeout: 9 }],
    };
    await mkdir(claudeDir, { recursive: true, mode: 0o700 });
    await writeFile(settings, `{"theme":"dark","hooks":{"PreToolUse":[${JSON.stringify(foreign)}]}}\n`, { mode: 0o600 });

    const transaction = async (name: string) => {
      const directory = join(claudeDir, `.settings.json.jhw-txn.${name}`);
      await mkdir(directory, { mode: 0o700 });
      return directory;
    };
    const invoke = (operation: string, directory: string, evidence?: string) => runEditor([
      operation,
      settings,
      mcpEntry,
      repositoryRoot,
      directory,
      ...(evidence === undefined ? [] : [evidence]),
    ]);

    const first = await transaction("first");
    expect(invoke("register-claude-hooks-transaction", first, "all").status).toBe(0);
    expect(JSON.parse(invoke("inspect-claude-hooks-transaction", first).stdout).stage).toBe("activated");
    const registered = await readFile(settings, "utf8");
    expect(invoke("finalize-claude-hooks-transaction", first, "activated").status).toBe(0);

    const second = await transaction("second");
    expect(invoke("register-claude-hooks-transaction", second, "all").status).toBe(3);
    expect(JSON.parse(invoke("inspect-claude-hooks-transaction", second).stdout).stage).toBe("unchanged-restored");
    expect(invoke("finalize-claude-hooks-transaction", second, "unchanged-restored").status).toBe(0);
    expect(await readFile(settings, "utf8")).toBe(registered);

    const third = await transaction("third");
    expect(invoke("unregister-claude-hooks-transaction", third).status).toBe(0);
    expect(JSON.parse(invoke("inspect-claude-hooks-transaction", third).stdout).stage).toBe("activated");
    expect(invoke("finalize-claude-hooks-transaction", third, "activated").status).toBe(0);

    const remaining = JSON.parse(await readFile(settings, "utf8"));
    expect(remaining.theme).toBe("dark");
    expect(remaining.hooks).toEqual({ PreToolUse: [foreign] });
  });

  it.each([
    ["malformed JSON", '{"hooks":{"PreToolUse":['],
    ["duplicate JSON keys", '{"hooks":{"PreToolUse":[],"PreToolUse":[]}}'],
    ["duplicate owned groups", JSON.stringify({
      hooks: {
        PreToolUse: [0, 1].map(() => ({
          hooks: [{
            type: "command",
            command: '"$HOME/.local/bin/jhw-control-hook" --adapter claude --event PreToolUse',
            timeout: 12,
          }],
        })),
      },
    })],
  ])("fails closed on %s and preserves exact Claude settings evidence", async (_label, original) => {
    const root = await mkdtemp(join(tmpdir(), "jhw-claude-hook-config-"));
    roots.push(root);
    const claudeDir = join(root, ".claude");
    const settings = join(claudeDir, "settings.json");
    const transaction = join(claudeDir, ".settings.json.jhw-txn.hostile");
    await mkdir(transaction, { recursive: true, mode: 0o700 });
    await chmod(transaction, 0o700);
    await writeFile(settings, original, { mode: 0o640 });

    const result = runEditor([
      "register-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
      "all",
    ]);

    expect(result.status).toBe(4);
    expect(JSON.parse(runEditor([
      "inspect-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
    ]).stdout).stage).toBe("foreign-restored");
    expect(await readFile(settings, "utf8")).toBe(original);
    expect((await stat(settings)).mode & 0o777).toBe(0o640);
    const backups = (await readdir(claudeDir)).filter((name) => name.startsWith("settings.json.bak."));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(claudeDir, backups[0]!), "utf8")).toBe(original);
    expect((await stat(join(claudeDir, backups[0]!))).mode & 0o777).toBe(0o600);
    expect(runEditor([
      "finalize-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
      "foreign-restored",
    ]).status).toBe(0);
  });

  it("does not follow or replace a Claude settings symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-claude-hook-config-"));
    roots.push(root);
    const claudeDir = join(root, ".claude");
    const settings = join(claudeDir, "settings.json");
    const external = join(root, "external-settings.json");
    const transaction = join(claudeDir, ".settings.json.jhw-txn.symlink");
    const original = '{"hooks":{},"foreign":"preserve"}\n';
    await mkdir(transaction, { recursive: true, mode: 0o700 });
    await chmod(transaction, 0o700);
    await writeFile(external, original, { mode: 0o600 });
    await symlink(external, settings);

    const result = runEditor([
      "register-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
      "all",
    ]);

    expect(result.status).toBe(4);
    expect(JSON.parse(runEditor([
      "inspect-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
    ]).stdout).stage).toBe("foreign-untouched");
    expect((await lstat(settings)).isSymbolicLink()).toBe(true);
    expect(await readFile(external, "utf8")).toBe(original);
    expect(runEditor([
      "finalize-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
      "foreign-untouched",
    ]).status).toBe(0);
  });

  it("does not traverse a symlinked Claude config parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-claude-hook-config-"));
    roots.push(root);
    const external = join(root, "external-claude");
    const claudeDir = join(root, ".claude");
    const settings = join(claudeDir, "settings.json");
    const transaction = join(claudeDir, ".settings.json.jhw-txn.parent-symlink");
    await mkdir(external, { mode: 0o700 });
    await symlink(external, claudeDir);
    await mkdir(transaction, { mode: 0o700 });

    const result = runEditor([
      "register-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
      "all",
    ]);

    expect(result.status).toBe(1);
    await expect(lstat(join(external, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(external, ".settings.json.jhw-txn.parent-symlink"))).toEqual([]);
  });

  it("keeps a Claude transaction on its opened parent when the path is swapped", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-claude-hook-config-"));
    roots.push(root);
    const claudeDir = join(root, ".claude");
    const movedClaudeDir = join(root, ".claude-moved");
    const external = join(root, "external-claude");
    const settings = join(claudeDir, "settings.json");
    const transaction = join(claudeDir, ".settings.json.jhw-txn.parent-race");
    const preload = join(root, "swap-parent.cjs");
    await mkdir(transaction, { recursive: true, mode: 0o700 });
    await mkdir(external, { mode: 0o700 });
    await writeFile(settings, '{"foreign":"original"}\n', { mode: 0o600 });
    await writeFile(join(external, "preserve"), "external-marker", { mode: 0o600 });
    await writeFile(preload, `
const fs = require("node:fs");
const path = require("node:path");
const rename = fs.renameSync.bind(fs);
let injected = false;
fs.renameSync = (source, destination) => {
  if (!injected && path.basename(source) === "settings.json" && path.basename(destination) === "captured-live") {
    injected = true;
    rename(process.env.JHW_TEST_LOGICAL_PARENT, process.env.JHW_TEST_MOVED_PARENT);
    fs.symlinkSync(process.env.JHW_TEST_EXTERNAL_PARENT, process.env.JHW_TEST_LOGICAL_PARENT);
  }
  return rename(source, destination);
};
`, { mode: 0o600 });

    const result = runEditor([
      "register-claude-hooks-transaction",
      settings,
      mcpEntry,
      repositoryRoot,
      transaction,
      "all",
    ], {
      NODE_OPTIONS: `--require=${preload}`,
      JHW_TEST_LOGICAL_PARENT: claudeDir,
      JHW_TEST_MOVED_PARENT: movedClaudeDir,
      JHW_TEST_EXTERNAL_PARENT: external,
    });

    expect(result.status).toBe(0);
    expect((await lstat(claudeDir)).isSymbolicLink()).toBe(true);
    expect(await readdir(external)).toEqual(["preserve"]);
    expect(await readFile(join(external, "preserve"), "utf8")).toBe("external-marker");
    const installed = JSON.parse(await readFile(join(movedClaudeDir, "settings.json"), "utf8"));
    expect(installed.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--adapter claude");
  });
});
