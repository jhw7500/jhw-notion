#!/usr/bin/env node
// Consumer contract for canonical /jhw:review --control guidance and its Codex mirror.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalReview = join(repoRoot, "skills", "claude", "review.md");
const codexSkill = join(repoRoot, "skills", "codex", "jhw-review", "SKILL.md");
const codexReference = join(repoRoot, "skills", "codex", "jhw-review", "references", "review.md");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const runbook = readFileSync(join(repoRoot, "docs", "project-control", "phase1a-runbook.md"), "utf8");
const review = readFileSync(canonicalReview, "utf8");
const failures = [];

for (const [label, source] of [["README", readme], ["runbook", runbook]]) {
  for (const marker of [
    "--resolve-from-checkout true",
    "none",
    "unique",
    "ambiguous",
    "session_id",
    "contract v4",
  ]) {
    if (!source.includes(marker)) failures.push(`${label} missing marker: ${marker}`);
  }
}

function initialFrontmatter(markdown, label) {
  const match = markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    failures.push(`missing initial YAML frontmatter: ${label}`);
    return new Map();
  }
  return new Map(match[1].split(/\r?\n/).flatMap((line) => {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    return field ? [[field[1], field[2]]] : [];
  }));
}

const canonicalFrontmatter = initialFrontmatter(review, "canonical review");
if (canonicalFrontmatter.get("description")?.includes("--control") !== true) {
  failures.push("canonical review frontmatter description must mention --control");
}
if (canonicalFrontmatter.get("argument-hint") !== '"[--match] [--control]"') {
  failures.push("canonical review frontmatter argument-hint must be [--match] [--control]");
}

const required = [
  "[--match] [--control]",
  "task status",
  "--resolve-from-checkout true",
  "--origin-adapter",
  "--session",
  "Notion Projects DB",
  "Project Control 후속 제안 — GitHub Project 기반",
  "match=none",
  "unique/current",
  "unique/mismatch",
  "unique/unverifiable",
  "match=ambiguous",
  "소급 Task 생성",
  "REGISTRY_MOVED_DURING_READ",
];
for (const marker of required) {
  if (!review.includes(marker)) failures.push(`missing review contract marker: ${marker}`);
}

function section(title) {
  const match = review.match(new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=^## |\\Z)`, "m"));
  if (!match) {
    failures.push(`missing review contract section: ${title}`);
    return "";
  }
  return match[1];
}

const control = section("--control — Project Control 후속 제안 \\(옵트인\\)");
const approvals = section("승인 분리");

const requiredMatrixRows = [
  ["Project/Repository 미등록 + 반복·다중 세션 작업", "Project/Repository 등록 또는 control 없이 진행", "자동 등록, 임의 ID 생성"],
  ["미래·미착수 backlog", "GitHub Issue 생성 또는 보류", "Task 선점, Temporary Task 자동 생성"],
  ["즉시 착수 + `match=none` + 등록 repository", "Formal Issue Task / Temporary Task / Task 없음 선택", "무승인 `task start`"],
  ["완료 증거 + `unique/current` active Claim", "completion-ready와 completed finish 제안", "증거 생성, 자동 finish"],
  ["진행 중 + `unique/current` active Claim", "현재 Task 유지 또는 명시적 handoff 제안", "불필요한 새 Task 생성"],
  ["`unique/mismatch` 또는 `unique/unverifiable`", "exact status/handoff/recovery 확인 제안", "현재 owner 취급, 자동 takeover/force-end"],
  ["`match=ambiguous`", "후보 정합성 조사와 recovery status 제안", "후보 선택, 좌표 추측"],
  ["완료된 Task + GitHub Issue open", "Issue close를 별도 제안", "Task finish 승인으로 Issue까지 닫기"],
  ["Project metadata stale", "Project update를 별도 제안", "Task/Issue 승인과 묶어 update"],
  ["이미 완료된 작업 + active Task 없음", "Issue close·Project update 등 남은 tracker 작업만 제안", "소급 Task 생성"],
  ["control lookup unavailable", "stable diagnostic과 수동 확인 제안", "cached/session 기억으로 owner 판정"],
];
const matrixRows = control.split(/\r?\n/).flatMap((line) => {
  const cells = line.trim().split("|");
  if (cells.length !== 5 || cells[0] !== "" || cells[4] !== "") return [];
  const normalized = cells.slice(1, -1).map((cell) => cell.trim().replaceAll(/\s+/g, " "));
  if (normalized.every((cell) => /^-+$/.test(cell))) return [];
  return [normalized];
});
for (const row of requiredMatrixRows) {
  const normalized = row.map((cell) => cell.replaceAll(/\s+/g, " "));
  if (!matrixRows.some((actual) => actual.length === normalized.length &&
      actual.every((cell, index) => cell === normalized[index]))) {
    failures.push(`missing control suggestion matrix row: ${row[0]}`);
  }
}

const expectedReadCommand = [
  'REPOSITORY_PATH="$(git rev-parse --show-toplevel)" || exit $?',
  'test -n "$REPOSITORY_PATH" || exit 1',
  '"$HOME/.local/bin/jhw-control-host" task status \\\n  --resolve-from-checkout true --repo-path "$REPOSITORY_PATH" \\\n  --origin-adapter \'<claude|codex|gemini|opencode>\' --session \'<session-id>\'',
].join("\n");
if (!control.includes(expectedReadCommand)) {
  failures.push("missing exact read-only current-context status command");
}

for (const [label, expected] of [
  ["default review preservation", /`--control`이 없으면[^\n]*현재 review 본문을 그대로 실행/],
  ["flag-triggered output recipe", /`--control`이 있을 때만[^\n]*순서로 출력한다/],
  ["explicit approval slots", /승인 slot: `Notion 저장` \| `Project Control Project` \| `Project Control Task` \| `GitHub Issue`/],
  ["no automatic preflight", /preflight[^\n]*자동 실행하지 않는다/],
  ["stable missing configuration diagnostics", /credential\/config 오류[^\n]*stable code만 표시/],
  ["registry movement stop", /REGISTRY_MOVED_DURING_READ[^\n]*자동 retry하지 않는다/],
  ["incomplete reads blocked", /pagination[^\n]*GitHub read[^\n]*불완전[^\n]*blocked/],
  ["no automatic mutations", /자동 start, finish, handoff, takeover, force-end, retry, 소급 Task 생성 금지/],
]) {
  if (!expected.test(control)) failures.push(`missing control safety rule: ${label}`);
}

if (!/기존 `OK`, `전체 저장`, 번호 조정은 Notion 저장 후보에만 적용/.test(approvals)) {
  failures.push("missing control safety rule: Notion-only OK boundary");
}

for (const [label, expected] of [
  ["Project approval route", /Project\/Repository 등록·갱신[^\n]*`\/jhw:project`/],
  ["Task approval route", /Task start, completion-ready, finish, handoff, recovery[^\n]*`\/jhw:task`/],
  ["Issue approval route", /GitHub Issue 생성·닫기[^\n]*별도 GitHub mutation 제안과 승인/],
  ["cross-authority isolation", /한 authority의 승인은 다른 authority에 전파되지 않는다/],
]) {
  if (!expected.test(approvals)) failures.push(`missing authority-separated approval: ${label}`);
}

try {
  if (!lstatSync(codexReference).isSymbolicLink()) {
    failures.push("Codex review reference must be a symlink");
  } else if (realpathSync(codexReference) !== realpathSync(canonicalReview)) {
    failures.push("Codex review reference must resolve exactly to canonical review.md");
  }
} catch (error) {
  failures.push(`cannot verify Codex review reference: ${error.code ?? error.message}`);
}

try {
  const generated = readFileSync(codexSkill, "utf8");
  const generatedFrontmatter = initialFrontmatter(generated, "generated Codex review SKILL.md");
  if (generatedFrontmatter.get("description")?.includes("--control") !== true) {
    failures.push("generated Codex SKILL.md description must mention --control after sync");
  }
} catch (error) {
  failures.push(`cannot read generated Codex review SKILL.md: ${error.code ?? error.message}`);
}

if (failures.length > 0) {
  console.error(`review skill contract failed (${failures.length} violation(s)):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("review skill contract: ok");
}
