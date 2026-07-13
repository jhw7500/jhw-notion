#!/usr/bin/env node
// skills/claude/*.md (정본) → skills/codex/jhw/*.toml (생성물) 동기화.
//
//   node scripts/sync-codex-skills.mjs           생성/갱신
//   node scripts/sync-codex-skills.mjs --check   드리프트만 검사 (CI/커밋 전, 쓰기 없음)
//
// TOML은 Codex의 커스텀 커맨드 형식(~/.codex/commands/jhw/)이다.
// 정본은 언제나 skills/claude/*.md — TOML을 직접 수정하지 말 것.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "skills", "claude");
const OUT_DIR = join(ROOT, "skills", "codex", "jhw");

// 스킬이 아닌 문서는 변환하지 않는다.
const EXCLUDED = new Set(["AGENTS.md"]);

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

function renderToml(md, file) {
  // 본문은 multiline *literal* string(''')로 감싼다. basic string(""")은 \n, \", \\ 를
  // 이스케이프로 재해석해서 마크다운 안의 jq/셸 예제를 조용히 망가뜨린다.
  if (md.includes("'''")) {
    throw new Error(`${file}: 본문에 '''가 있어 TOML 리터럴 문자열을 깨뜨립니다`);
  }
  // description은 단일 행 basic string — JSON.stringify의 이스케이프 규칙과 호환된다.
  const description = JSON.stringify(extractDescription(md, file));
  return `description = ${description}\n\nprompt = '''\n${md}\n'''\n`;
}

function readIfExists(path) {
  try {
    return readFileSync(path, "utf8");
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

mkdirSync(OUT_DIR, { recursive: true });

const written = [];
const expected = new Set();

for (const file of sources) {
  const md = readFileSync(join(SRC_DIR, file), "utf8");
  const toml = renderToml(md, file);
  const outName = file.replace(/\.md$/, ".toml");
  const outPath = join(OUT_DIR, outName);
  expected.add(outName);

  if (readIfExists(outPath) === toml) continue;

  written.push(outName);
  if (!checkOnly) writeFileSync(outPath, toml);
}

// 정본이 사라진 TOML은 남겨두면 삭제된 스킬이 계속 노출된다.
const orphans = readdirSync(OUT_DIR)
  .filter((f) => f.endsWith(".toml") && !expected.has(f))
  .sort();

if (!checkOnly) {
  for (const orphan of orphans) unlinkSync(join(OUT_DIR, orphan));
}

const drifted = written.length + orphans.length;

if (checkOnly) {
  if (drifted === 0) {
    console.log(`✅ skills/codex/jhw 동기화 상태 (정본 ${sources.length}개)`);
    process.exit(0);
  }
  console.error("❌ skills/codex/jhw가 skills/claude와 어긋났습니다:");
  for (const f of written) console.error(`   갱신 필요: ${f}`);
  for (const f of orphans) console.error(`   정본 없음(삭제 대상): ${f}`);
  console.error("\n   node scripts/sync-codex-skills.mjs 를 실행한 뒤 커밋하세요.");
  process.exit(1);
}

if (drifted === 0) {
  console.log(`✅ 이미 최신 (정본 ${sources.length}개)`);
} else {
  for (const f of written) console.log(`   생성/갱신: ${f}`);
  for (const f of orphans) console.log(`   삭제: ${f}`);
  console.log(`✅ 동기화 완료 (정본 ${sources.length}개, 변경 ${drifted}개)`);
}
