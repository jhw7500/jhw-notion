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
const repoAgents = await readFile(join(root, "AGENTS.md"), "utf8");
assert.match(skill, /^## 언어$/m);
assert.match(skill, /제목의 결과문\(`type\(scope\): ` 뒤\)과 필드 내용은 한국어로 쓴다\./);
assert.match(skill, /`type`·`scope`·필드 제목·트레일러·명령·경로·식별자·오류 코드와 도구가 읽는 고정 문구\(`Not run:`, `Closes #N` 같은 닫기 키워드, `review-fix round N`\)는 원문 그대로 둔다\./);
assert.match(skill, /origin이 `github\.com\/jhw7500\/\*`인 저장소에서는 저장소와 작성 도구\(Claude Code·Codex 등\)에 관계없이 같고, 그 밖의 저장소에서는 그 저장소의 언어 관례를 따른다\./);
assert.match(skill, /jhw7500 아래의 fork로 외부 upstream 저장소에 기여하는 커밋은 origin과 관계없이 그 upstream 저장소의 언어 관례를 따른다\./);
const languageExample = skill.match(/## 언어[\s\S]*?```text\n([\s\S]*?)```\n/);
assert.ok(languageExample, "the 언어 section must show one filled example");
assert.match(languageExample[1], /^[a-z]+\([a-z-]+\): [^\n]*[가-힣][^\n]*\n\n ### Contract version\nv1\n/);
assert.equal(languageExample[1].split("\n", 1)[0].length <= 72, true);
assert.doesNotMatch(repoAgents, /관례는 영문 `type\(scope\): 결과`다\./);
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
assert.match(template, /^<type\(scope\): 72자 이내의 결과 중심 제목>$/m);

const values = [
  "feat(commit): 직접 커밋에도 변경 증거를 남긴다",
  "Issue와 PR 증거를 Git 이력에서 다시 찾을 수 있어야 한다.",
  "지원하는 모든 TUI에 커밋 작성 스킬 하나를 추가한다.",
  "node scripts/test-commit-skill-contract.mjs: 통과.",
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
