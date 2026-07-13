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
  // Windows 체크아웃(autocrlf)의 CRLF와 BOM을 허용한다.
  const fm = md.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) {
    throw new Error(`${file}: frontmatter(---)가 없습니다`);
  }
  const line = fm[1].split(/\r?\n/).find((l) => l.startsWith("description:"));
  if (!line) {
    throw new Error(`${file}: frontmatter에 description이 없습니다`);
  }
  const value = line.slice("description:".length).trim();

  // 블록 스칼라(| > 및 |- >2 같은 지시자)는 값이 다음 줄부터다. 여기서 잡지 않으면
  // '|' 한 글자가 조용히 description으로 실린다.
  if (/^[|>][-+0-9]*$/.test(value)) {
    throw new Error(
      `${file}: description에 YAML 블록 스칼라(${value})는 쓸 수 없습니다. 한 줄로 쓰세요.`,
    );
  }

  // YAML 인용 문자열의 이스케이프는 풀지 않는다. 조용히 백슬래시를 남기느니
  // 처리할 수 없다고 크게 실패한다(본문의 ''' 가드와 같은 원칙).
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    if (/[\\"]/.test(inner)) {
      throw new Error(
        `${file}: description의 이스케이프·내부 따옴표를 처리할 수 없습니다. ` +
          `따옴표 없는 형태로 쓰세요 → ${value}`,
      );
    }
    return inner;
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    if (inner.includes("'")) {
      throw new Error(
        `${file}: description의 작은따옴표 이스케이프('')를 처리할 수 없습니다 → ${value}`,
      );
    }
    return inner;
  }

  // 인용하지 않은 스칼라는 따옴표가 섞여 있어도 그대로가 값이다.
  return value;
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
      rmSync(refPath, { force: true, recursive: true });   // 디렉토리가 자리를 차지한 경우까지
      symlinkSync(REF_TARGET(cmd), refPath);
    }
  }
}

// 정본이 사라진 스킬은 남겨두면 삭제된 커맨드가 계속 노출된다.
// 스킬 디렉토리 자체뿐 아니라 그 안에 남은 잔재(이름이 바뀐 references 등)까지 걷어낸다.
let orphans = [];
try {
  orphans = readdirSync(OUT_DIR)
    .filter((f) => f.startsWith("jhw-") && !expected.has(f))
    .sort();
} catch {
  mkdirSync(OUT_DIR, { recursive: true });
}

const readdirSafe = (path) => {
  try {
    return readdirSync(path);
  } catch {
    return [];   // 아직 생성 전 — SKILL.md/references 쪽 drift로 이미 보고된다.
  }
};

for (const name of expected) {
  const cmd = name.slice("jhw-".length);
  const dir = join(OUT_DIR, name);
  const allowed = new Set(["SKILL.md", "references"]);

  for (const entry of readdirSafe(dir)) {
    if (!allowed.has(entry)) orphans.push(`${name}/${entry}`);
  }
  for (const entry of readdirSafe(join(dir, "references"))) {
    if (entry !== `${cmd}.md`) orphans.push(`${name}/references/${entry}`);
  }
}
orphans.sort();

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
