#!/usr/bin/env node
// skills/claude/*.md (정본) → skills/codex/jhw-<cmd>/ (생성물) 동기화.
//
//   node scripts/sync-codex-skills.mjs           생성/갱신
//   node scripts/sync-codex-skills.mjs --check   드리프트만 검사 (CI/커밋 전, 쓰기 없음)
//
// Codex는 $CODEX_HOME/skills(= ~/.codex/skills)의 스킬 디렉토리를 자동 발견한다.
// (~/.codex/commands/*.toml은 스캔하지 않아 이전 TOML 미러는 폐기했다.)
//
// 각 스킬은 SKILL.md(생성물) + references/<cmd>.md(정본 심링크)로 구성한다.
// references를 심링크로 두면 정본을 고치는 순간 반영되므로 본문이 낡을 수 없다.
// 정본은 언제나 skills/claude/*.md — 생성물을 직접 수정하지 말 것.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "skills", "claude");
const OUT_DIR = join(ROOT, "skills", "codex");

// 스킬이 아닌 문서는 변환하지 않는다.
const EXCLUDED = new Set(["AGENTS.md"]);

// references/<cmd>.md → skills/claude/<cmd>.md (상대 경로 심링크)
const REF_TARGET = (cmd) => join("..", "..", "..", "claude", `${cmd}.md`);

const checkOnly = process.argv.includes("--check");

function extractDescription(md, file) {
  // Windows 체크아웃(autocrlf)에서도 파싱되도록 CRLF를 허용한다.
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) {
    throw new Error(`${file}: frontmatter(---)가 없습니다`);
  }
  const line = fm[1].split(/\r?\n/).find((l) => l.startsWith("description:"));
  if (!line) {
    throw new Error(`${file}: frontmatter에 description이 없습니다`);
  }
  const value = line.slice("description:".length).trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

function renderSkill(md, cmd, file) {
  const summary = extractDescription(md, file);
  // description은 YAML 단일 행 — 콜론·따옴표가 섞여도 깨지지 않도록 JSON 인용.
  const description = JSON.stringify(
    `${summary} Use when the user invokes \`/jhw:${cmd}\`, \`$jhw-${cmd}\`, or asks to run the JHW ${cmd} command.`,
  );

  return `---
name: jhw-${cmd}
description: ${description}
---

# jhw-${cmd}

Run the JHW \`${cmd}\` command workflow.

## Workflow

1. Read \`references/${cmd}.md\` — 정본 절차서다(심링크이므로 항상 최신).
2. Follow that file's procedure, arguments, approval points, and safety rules.
3. Preserve the command file's Korean user-facing wording where practical.
4. If the referenced command requires a JHW MCP tool that is unavailable in the
   current session, report the missing tool plainly instead of inventing results.

## Invocation

Use \`$jhw-${cmd}\`. If the user writes \`/jhw:${cmd}\`, treat it as a request to use this skill.
`;
}

function readIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function symlinkTargetOf(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return readlinkSync(path);
  } catch {
    return null;
  }
}

const sources = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".md") && !EXCLUDED.has(f))
  .sort();

if (sources.length === 0) {
  console.error(`정본이 없습니다: ${SRC_DIR}`);
  process.exit(1);
}

const drifted = [];
const expected = new Set();

for (const file of sources) {
  const cmd = file.replace(/\.md$/, "");
  const dir = join(OUT_DIR, `jhw-${cmd}`);
  const skillPath = join(dir, "SKILL.md");
  const refPath = join(dir, "references", `${cmd}.md`);
  expected.add(`jhw-${cmd}`);

  const md = readFileSync(join(SRC_DIR, file), "utf8");
  const skill = renderSkill(md, cmd, file);

  if (readIfExists(skillPath) !== skill) {
    drifted.push(`jhw-${cmd}/SKILL.md`);
    if (!checkOnly) {
      mkdirSync(join(dir, "references"), { recursive: true });
      writeFileSync(skillPath, skill);
    }
  }

  if (symlinkTargetOf(refPath) !== REF_TARGET(cmd)) {
    drifted.push(`jhw-${cmd}/references/${cmd}.md`);
    if (!checkOnly) {
      mkdirSync(join(dir, "references"), { recursive: true });
      rmSync(refPath, { force: true });
      symlinkSync(REF_TARGET(cmd), refPath);
    }
  }
}

// 정본이 사라진 스킬은 남겨두면 삭제된 커맨드가 계속 노출된다.
let orphans = [];
try {
  orphans = readdirSync(OUT_DIR)
    .filter((f) => f.startsWith("jhw-") && !expected.has(f))
    .sort();
} catch {
  mkdirSync(OUT_DIR, { recursive: true });
}

if (!checkOnly) {
  for (const orphan of orphans) rmSync(join(OUT_DIR, orphan), { recursive: true, force: true });
}

const total = drifted.length + orphans.length;

if (checkOnly) {
  if (total === 0) {
    console.log(`✅ skills/codex 동기화 상태 (정본 ${sources.length}개)`);
    process.exit(0);
  }
  console.error("❌ skills/codex가 skills/claude와 어긋났습니다:");
  for (const f of drifted) console.error(`   갱신 필요: ${f}`);
  for (const f of orphans) console.error(`   정본 없음(삭제 대상): ${f}`);
  console.error("\n   node scripts/sync-codex-skills.mjs 를 실행한 뒤 커밋하세요.");
  process.exit(1);
}

if (total === 0) {
  console.log(`✅ 이미 최신 (정본 ${sources.length}개)`);
} else {
  for (const f of drifted) console.log(`   생성/갱신: ${f}`);
  for (const f of orphans) console.log(`   삭제: ${f}`);
  console.log(`✅ 동기화 완료 (정본 ${sources.length}개, 변경 ${total}개)`);
}
