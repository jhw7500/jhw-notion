#!/usr/bin/env node
// Check the authored commit template and Git's treatment of its Markdown headings.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = await readFile(join(root, "skills/claude/commit.md"), "utf8");
const readme = await readFile(join(root, "README.md"), "utf8");
const agents = await readFile(join(root, "skills/COMMANDS.md"), "utf8");
const generated = await readFile(join(root, "skills/codex/jhw-commit/SKILL.md"), "utf8");
const reference = join(root, "skills/codex/jhw-commit/references/commit.md");

assert.match(skill, /^description: .+/m);
assert.match(skill, /Change Evidence Contract v1/);
assert.match(skill, /0d97a63891ba4473a3a189eae643f8059b76eb56/);
assert.match(skill, /직접 커밋.*Issue/);
assert.match(skill, /--cleanup=verbatim/);
assert.match(skill, /Not run: <구체적 사유>/);
assert.match(skill, /실제로 실행하고 출력을 읽은/);
assert.match(readme, /\/jhw:commit/);
assert.match(readme, /DEPLOY_WIRING_TOPOLOGY_CHANGED/);
assert.match(agents, /\| `commit\.md` \|/);
assert.match(generated, /references\/commit\.md/);
assert.equal((await lstat(reference)).isSymbolicLink(), true);

const match = skill.match(
  /<!-- change-evidence-commit-template:begin -->\n```text\n([\s\S]*?)```\n<!-- change-evidence-commit-template:end -->/,
);
assert.ok(match, "the source skill must contain one commit template");
const template = match[1];
assert.deepEqual(
  [...template.matchAll(/^ (### .+)$/gm)].map((item) => item[1]),
  ["### Contract version", "### Why", "### Changes", "### Validation", "### References"],
);
assert.equal((template.match(/^### /gm) ?? []).length, 0, "heading indentation protects edited Git messages");
assert.match(template, /^v1$/m);

const values = [
  "Preserve change evidence in direct commits",
  "The Issue and PR evidence must remain recoverable from Git history.",
  "Add one commit authoring skill for every supported TUI.",
  "node scripts/test-commit-skill-contract.mjs: passed.",
  "https://github.com/jhw7500/jhw-notion/issues/165",
];
let index = 0;
const message = template.replace(/<[^>\n]+>/g, () => values[index++]);
assert.equal(index, values.length, "all template instructions must be replaced");
assert.equal(message.split("\n", 1)[0].length <= 72, true);
assert.match(message, /^- https:\/\/github\.com\/jhw7500\/jhw-notion\/issues\/165$/m);

const directory = await mkdtemp(join(tmpdir(), "jhw-commit-contract-"));
try {
  const file = join(directory, "message.txt");
  await writeFile(file, message, { mode: 0o600 });
  await exec("git", ["init", "-q", directory]);
  await exec("git", ["-C", directory, "-c", "user.name=Contract Test", "-c", "user.email=contract@example.invalid", "commit", "--quiet", "--allow-empty", "--cleanup=verbatim", "--file", file]);
  const { stdout } = await exec("git", ["-C", directory, "log", "-1", "--format=%B"]);
  assert.equal(stdout, `${message}\n`, "Git must preserve the evidence headings and body exactly");
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("commit skill contract: ok");
