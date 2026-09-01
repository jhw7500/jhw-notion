#!/usr/bin/env node
// Cross-TUI contract for deprecated aliases. A generated Codex alias owns only
// its alias reference, so its canonical document must route Codex explicitly to
// the replacement skill instead of naming a nonexistent sibling reference.

import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aliases = new Map([
  ["record", "save"],
  ["note", "save"],
  ["delete", "save"],
  ["search", "recall"],
  ["context", "recall"],
  ["history", "recall"],
  ["start", "project"],
  ["close", "project"],
  ["ship", "pr"],
]);

for (const [alias, target] of aliases) {
  const canonicalAlias = join(repoRoot, "skills", "claude", `${alias}.md`);
  const aliasSkillDir = join(repoRoot, "skills", "codex", `jhw-${alias}`);
  const aliasReferenceDir = join(aliasSkillDir, "references");
  const aliasReference = join(aliasReferenceDir, `${alias}.md`);
  const targetSkill = join(repoRoot, "skills", "codex", `jhw-${target}`, "SKILL.md");
  const targetReference = join(
    repoRoot,
    "skills",
    "codex",
    `jhw-${target}`,
    "references",
    `${target}.md`,
  );
  const markdown = readFileSync(canonicalAlias, "utf8");

  assert.ok(
    markdown.includes(
      `Codex에서는 \`$jhw-${target}\` 스킬을 사용해 그 스킬의 \`references/${target}.md\`를 읽는다.`,
    ),
    `${alias}: Codex must route through the replacement skill and its owned reference`,
  );
  assert.ok(
    markdown.includes(
      `Claude Code·Gemini CLI·OpenCode에서는 같은 canonical 디렉터리의 \`${target}.md\`를 읽는다.`,
    ),
    `${alias}: shared-TUI routing must resolve the canonical replacement document`,
  );

  assert.deepEqual(
    readdirSync(aliasReferenceDir).sort(),
    [`${alias}.md`],
    `${alias}: generated aliases must not depend on an extra copied reference`,
  );
  assert.equal(lstatSync(aliasReference).isSymbolicLink(), true, `${alias}: alias reference must be a symlink`);
  assert.equal(
    resolve(aliasReferenceDir, readlinkSync(aliasReference)),
    canonicalAlias,
    `${alias}: alias reference must resolve to its canonical document`,
  );
  assert.equal(existsSync(targetSkill), true, `${alias}: replacement Codex skill must exist`);
  assert.equal(existsSync(targetReference), true, `${alias}: replacement Codex reference must exist`);
  assert.equal(
    lstatSync(targetReference).isSymbolicLink(),
    true,
    `${alias}: replacement reference must be a symlink`,
  );
  assert.equal(
    resolve(dirname(targetReference), readlinkSync(targetReference)),
    join(repoRoot, "skills", "claude", `${target}.md`),
    `${alias}: replacement reference must resolve to the canonical target`,
  );
}

console.log(`skill alias contract: PASS (${aliases.size} aliases)`);
