#!/usr/bin/env node
// Claude Code, Gemini CLI and OpenCode link their jhw command directory to
// skills/claude as a whole (scripts/install-wiring.sh), so every Markdown file
// there is exposed as a /jhw:<name> command. Only skill documents with a
// frontmatter description belong in it; repository docs live elsewhere.
// The scripts directory holds only the fixed non-Markdown executable assets.

import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandDir = join(repoRoot, "skills", "claude");
const entries = readdirSync(commandDir).sort();
const runnerNames = ["issue-contract.sh", "task-finish.sh"];
let skillCount = 0;

assert.ok(entries.length > 0, "skills/claude must contain skill documents");
for (const name of entries) {
  const path = join(commandDir, name);
  if (name === "scripts") {
    assert.ok(lstatSync(path).isDirectory(), "scripts: contract assets must be a real directory");
    assert.deepEqual(readdirSync(path).sort(), runnerNames,
      "scripts: only the two executable contracts belong in the command asset directory");
    for (const runner of runnerNames) {
      const info = lstatSync(join(path, runner));
      assert.ok(info.isFile(), `${runner}: contract asset must be a regular file`);
      assert.equal(info.mode & 0o7777, 0o755, `${runner}: contract asset must have trusted executable mode`);
    }
    continue;
  }
  assert.ok(lstatSync(path).isFile(), `${name}: every entry must be a regular file`);
  assert.ok(name.endsWith(".md"), `${name}: every entry must be a Markdown skill document`);
  const lines = readFileSync(path, "utf8").split("\n");
  assert.equal(lines[0], "---", `${name}: skill must open with frontmatter`);
  const end = lines.indexOf("---", 1);
  assert.ok(end > 0, `${name}: frontmatter must be closed`);
  assert.ok(
    lines.slice(1, end).some((line) => /^description:\s*\S/.test(line)),
    `${name}: frontmatter must declare a description`,
  );
  skillCount += 1;
}

assert.ok(skillCount > 0, "skills/claude must contain skill documents");
console.log(`claude command dir contract: PASS (${skillCount} skills; ${runnerNames.length} runner assets)`);
