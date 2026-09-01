#!/usr/bin/env node
// Consumer contract for canonical /jhw:pr review rounds and /jhw:ship alias.
// The canonical Markdown exposes executable Bash helpers; a stateful fake gh
// verifies trigger/current-round boundaries without touching GitHub.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPr = join(repoRoot, "skills", "claude", "pr.md");
const shipAlias = join(repoRoot, "skills", "claude", "ship.md");
const agentsPath = join(repoRoot, "skills", "claude", "AGENTS.md");
const readmePath = join(repoRoot, "README.md");
const codexPrSkill = join(repoRoot, "skills", "codex", "jhw-pr", "SKILL.md");
const codexPrReference = join(repoRoot, "skills", "codex", "jhw-pr", "references", "pr.md");
const codexShipSkill = join(repoRoot, "skills", "codex", "jhw-ship", "SKILL.md");
const currentHead = "a".repeat(40);
const oldHead = "b".repeat(40);
const roundStartedAt = "2026-08-29T00:00:00Z";
const requestCreatedAt = "2026-08-29T00:01:00Z";
const startEpoch = Date.parse(roundStartedAt) / 1000;
const requestEpoch = Date.parse(requestCreatedAt) / 1000;
const requestMarker = `<!-- jhw-pr:codex-review round=2 head=${currentHead} -->`;
const requestBody = `@codex review\n\n${requestMarker}`;
const legacyRequestMarker = `<!-- jhw-ship:codex-review round=2 head=${currentHead} -->`;
const legacyRequestBody = `@codex review\n\n${legacyRequestMarker}`;
const oldLegacyRequestMarker = `<!-- jhw-ship:codex-review round=2 head=${oldHead} -->`;
const oldLegacyRequestBody = `@codex review\n\n${oldLegacyRequestMarker}`;
const otherRoundRequestBody = `@codex review\n\n<!-- jhw-pr:codex-review round=7 head=${currentHead} -->`;
const genericCodexMarker = `<!-- jhw-pr:review-request reviewer=codex head=${currentHead} -->`;
const genericCodexBody = `@codex review\n\n${genericCodexMarker}`;
const oldGenericCodexMarker = `<!-- jhw-pr:review-request reviewer=codex head=${oldHead} -->`;
const oldGenericCodexBody = `@codex review\n\n${oldGenericCodexMarker}`;
const genericGeminiMarker = `<!-- jhw-pr:review-request reviewer=gemini-assist head=${currentHead} -->`;
const genericGeminiBody = `/gemini review\n\n${genericGeminiMarker}`;

function contractBlock(markdown) {
  const match = markdown.match(
    /<!-- pr-round-contract: trigger-and-scope:begin -->\n```bash\n([\s\S]*?)```\n<!-- pr-round-contract: trigger-and-scope:end -->/,
  );
  assert.ok(match, "pr skill must expose an executable auto-fix round contract");
  return match[1];
}

function policyContractBlock(markdown) {
  const match = markdown.match(
    /<!-- pr-review-mode-contract:begin -->\n```bash\n([\s\S]*?)```\n<!-- pr-review-mode-contract:end -->/,
  );
  assert.ok(match, "pr skill must expose an executable review-mode contract");
  return match[1];
}

const fakeGhSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.FAKE_GH_STATE;
const logPath = process.env.FAKE_GH_LOG;
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, JSON.stringify(argv) + "\n");

function save() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function rows(values) {
  if (values.length > 0) process.stdout.write(values.join("\n") + "\n");
}

function isBlocking(item) {
  if (typeof item.blocking === "boolean") return item.blocking;
  const queryIndex = argv.indexOf("--jq");
  const query = queryIndex >= 0 ? argv[queryIndex + 1] : "";
  return typeof item.severity === "string" && query.includes(item.severity.toUpperCase());
}

function optionValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (argv[0] === "repo" && argv[1] === "view") {
  process.stdout.write((state.viewerPermission || "READ") + "\n");
  process.exit(0);
}

if (argv[0] === "label" && argv[1] === "list") {
  rows(state.repoLabels || []);
  process.exit(0);
}

if (argv[0] === "label" && argv[1] === "create") {
  const name = argv[2];
  if (state.failLabelCreate) process.exit(1);
  if (!state.repoLabels.includes(name)) state.repoLabels.push(name);
  save();
  process.exit(0);
}

if (argv[0] === "pr" && argv[1] === "create") {
  if (!argv.includes("--draft") || state.failPrCreate) process.exit(1);
  state.prExists = true;
  state.prDraft = state.forceReadyOnCreate ? false : true;
  state.prHead = state.remoteBranchHead;
  state.prBase = optionValue("--base");
  save();
  process.stdout.write(state.prUrl + "\n");
  process.exit(0);
}

if (argv[0] === "pr" && argv[1] === "view") {
  if (!state.prExists) process.exit(1);
  const fields = optionValue("--json") || "";
  const query = optionValue("--jq") || optionValue("-q") || "";
  if (query === ".number") process.stdout.write(String(state.prNumber) + "\n");
  else if (query === ".headRefOid") process.stdout.write(state.prHead + "\n");
  else if (query === ".baseRefName") process.stdout.write(state.prBase + "\n");
  else if (query === ".isDraft") process.stdout.write(String(state.prDraft) + "\n");
  else if (query.includes(".labels")) rows(state.prLabels || []);
  else {
    const payload = {};
    if (fields.includes("number")) payload.number = state.prNumber;
    if (fields.includes("headRefOid")) payload.headRefOid = state.prHead;
    if (fields.includes("baseRefName")) payload.baseRefName = state.prBase;
    if (fields.includes("isDraft")) payload.isDraft = state.prDraft;
    if (fields.includes("labels")) payload.labels = (state.prLabels || []).map((name) => ({ name }));
    process.stdout.write(JSON.stringify(payload) + "\n");
  }
  process.exit(0);
}

if (argv[0] === "pr" && argv[1] === "edit") {
  if (!state.prExists || state.failPrEdit) process.exit(1);
  if (argv.includes("--base")) {
    if (state.failBaseEdit) process.exit(1);
    if (!state.freezeBase) state.prBase = optionValue("--base");
  }
  if (!state.freezeLabels) {
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === "--remove-label") {
        state.prLabels = state.prLabels.filter((name) => name !== argv[index + 1]);
      }
      if (argv[index] === "--add-label" && !state.prLabels.includes(argv[index + 1])) {
        state.prLabels.push(argv[index + 1]);
      }
    }
  }
  save();
  process.exit(0);
}

if (argv[0] === "pr" && argv[1] === "ready") {
  if (!state.prExists || state.failPrReady) process.exit(1);
  state.prDraft = false;
  save();
  process.exit(0);
}

if (argv[0] === "pr" && argv[1] === "checks") {
  if (!state.prExists) process.exit(1);
  if (state.headAfterRequiredChecks) {
    state.prHead = state.headAfterRequiredChecks;
    save();
  }
  if (state.baseAfterRequiredChecks) {
    state.prBase = state.baseAfterRequiredChecks;
    save();
  }
  if (state.requiredChecksMessage) process.stderr.write(state.requiredChecksMessage);
  process.exit(state.requiredChecksExit || 0);
}

if (argv[0] === "pr" && argv[1] === "merge") {
  if (!state.prExists) process.exit(1);
  if (state.headBeforeMerge) state.prHead = state.headBeforeMerge;
  const expectedHead = optionValue("--match-head-commit");
  const strategies = ["--merge", "--squash", "--rebase"].filter((flag) => argv.includes(flag));
  if (expectedHead !== state.prHead || strategies.length !== 1 || !argv.includes("--delete-branch")) {
    save();
    process.exit(1);
  }
  state.prMerged = true;
  save();
  process.exit(0);
}

if (argv[0] === "workflow" && argv[1] === "view") {
  const workflow = argv[2];
  if (state.failWorkflowView || !state.workflowStates?.[workflow]) process.exit(1);
  process.stdout.write(state.workflowStates[workflow] + "\n");
  process.exit(0);
}

if (argv[0] === "workflow" && argv[1] === "run") {
  const workflow = argv[2];
  if (state.failWorkflowDispatch || state.workflowStates?.[workflow] !== "active") process.exit(1);
  state.dispatchedWorkflows.push({ workflow, args: argv.slice(3) });
  save();
  process.exit(0);
}

if (argv[0] !== "api" || !argv[1]) process.exit(2);
const endpoint = argv[1];
if ((state.failEndpoints || []).some((part) => endpoint.includes(part))) process.exit(1);

if (endpoint === "user") {
  process.stdout.write(state.actor + "\n");
  process.exit(0);
}

if (endpoint === "repos/example/repo/branches/main") {
  if (optionValue("--jq")) process.exit(2);
  process.stdout.write(JSON.stringify(state.branchMetadata) + "\n");
  process.exit(0);
}

if (endpoint === "repos/example/repo/rules/branches/main?per_page=100") {
  if (!argv.includes("--paginate") || !argv.includes("--slurp") || optionValue("--jq")) process.exit(2);
  process.stdout.write(JSON.stringify([state.effectiveRules]) + "\n");
  process.exit(0);
}

const workflowStateMatch = endpoint.match(/^repos\/example\/repo\/actions\/workflows\/([^/?]+)$/);
if (workflowStateMatch) {
  const workflow = decodeURIComponent(workflowStateMatch[1]);
  if (state.failWorkflowView || !state.workflowStates?.[workflow]) process.exit(1);
  process.stdout.write(state.workflowStates[workflow] + "\n");
  process.exit(0);
}

if (endpoint === "repos/example/repo/issues/comments?per_page=100") {
  if (!argv.includes("--paginate") || argv.includes("--slurp")) process.exit(2);
  const query = optionValue("--jq") || "";
  if (!query.includes("@base64")) process.exit(2);
  const actor = query.match(/\.user\.login == "([^"]+)"/)?.[1];
  rows((state.appComments || [])
    .filter((item) => !actor || item.actor === actor)
    .map((item) => Buffer.from(JSON.stringify({
      actor: item.actor,
      body: item.body,
      url: item.url,
    })).toString("base64")));
  process.exit(0);
}

if (/\/issues\/\d+\/comments\?per_page=100$/.test(endpoint)) {
  if (argv.includes("POST")) {
    if (state.failPost) process.exit(1);
    const fieldIndex = argv.indexOf("-f");
    const bodyArg = fieldIndex >= 0 ? argv[fieldIndex + 1] : "";
    const body = bodyArg.startsWith("body=") ? bodyArg.slice(5) : "";
    const comment = {
      id: state.nextId++,
      actor: state.actor,
      createdAt: state.postCreatedAt,
      body,
    };
    state.issueComments.push(comment);
    save();
    process.stdout.write(String(comment.id) + "\t" + comment.createdAt + "\n");
    process.exit(0);
  }
  const queryIndex = argv.indexOf("--jq");
  const query = queryIndex >= 0 ? argv[queryIndex + 1] : "";
  const actor = query.match(/\.user\.login == "([^"]+)"/)?.[1];
  const markers = [...query.matchAll(/contains\("([^"]+)"\)/g)].map((match) => match[1]);
  const testPatterns = [...query.matchAll(/test\("([^"]+)"\)/g)]
    .map((match) => new RegExp(match[1]));
  const matching = state.issueComments.filter((item) =>
    (!actor || item.actor === actor) &&
    (markers.length + testPatterns.length === 0 ||
      markers.some((marker) => item.body.includes(marker)) ||
      testPatterns.some((pattern) => pattern.test(item.body))));
  rows(matching.map((item) => String(item.id) + "\t" + item.createdAt));
  process.exit(0);
}

if (/\/issues\/comments\/\d+\/reactions\?per_page=100$/.test(endpoint)) {
  rows(state.commentReactions.map((item) => [item.actor, item.content, item.createdAt].join("\t")));
  process.exit(0);
}

if (/\/issues\/\d+\/reactions\?per_page=100$/.test(endpoint)) {
  rows(state.issueReactions.map((item) => [item.actor, item.content, item.createdAt].join("\t")));
  process.exit(0);
}

if (/\/pulls\/\d+\/reviews\?per_page=100$/.test(endpoint)) {
  rows(state.reviews.map((item) => [item.actor, item.commitId, item.submittedAt, isBlocking(item) ? "true" : "false"].join("\t")));
  process.exit(0);
}

if (/\/pulls\/\d+\/comments\?per_page=100$/.test(endpoint)) {
  rows(state.pullComments.map((item) => [item.actor, item.commitId, item.originalCommitId, item.createdAt, isBlocking(item) ? "true" : "false"].join("\t")));
  process.exit(0);
}

if (endpoint.includes("/actions/runs?")) {
  const queryIndex = argv.indexOf("--jq");
  const query = queryIndex >= 0 ? argv[queryIndex + 1] : "";
  rows(state.runs.map((item) => {
    const fields = [item.id, item.attempt, item.name, item.head, item.createdAt, item.status, item.conclusion];
    if (query.includes(".event")) fields.push(item.event || "push");
    return fields.join("\t");
  }));
  process.exit(0);
}

process.stderr.write("unexpected fake gh endpoint: " + endpoint + "\n");
process.exit(2);
`;

const fakeGitSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.FAKE_GH_STATE;
const logPath = process.env.FAKE_GH_LOG;
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, JSON.stringify(["git", ...argv]) + "\n");

if (argv[0] === "rev-parse" && argv[1] === "HEAD") {
  process.stdout.write(state.localHead + "\n");
  process.exit(0);
}

if (argv[0] === "check-ref-format" && argv[1] === "--branch") {
  const branch = argv[2] || "";
  const valid = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes("..") && !branch.includes("//") && !branch.includes("@{") &&
    !branch.endsWith("/") && !branch.endsWith(".") && !branch.endsWith(".lock");
  if (valid) process.stdout.write(branch + "\n");
  process.exit(valid ? 0 : 1);
}

if (argv[0] === "push") {
  if (state.failPush) process.exit(1);
  state.remoteBranchHead = state.localHead;
  if (state.prExists && state.pushUpdatesPrHead !== false) state.prHead = state.localHead;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}

process.stderr.write("unexpected fake git command: " + argv.join(" ") + "\n");
process.exit(2);
`;

const fakeDateSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "+%s") {
  process.stdout.write(fs.readFileSync(process.env.FAKE_DATE_EPOCH_FILE, "utf8").trim() + "\n");
  process.exit(0);
}

if (process.env.FAKE_DATE_BSD_ONLY !== "1" && argv.length === 4 && argv[0] === "-u" && argv[1] === "-d" && argv[3] === "+%s") {
  const epoch = Date.parse(argv[2]) / 1000;
  if (Number.isInteger(epoch)) {
    process.stdout.write(String(epoch) + "\n");
    process.exit(0);
  }
}

if (argv.length === 6 && argv[0] === "-j" && argv[1] === "-u" && argv[2] === "-f" && argv[3] === "%Y-%m-%dT%H:%M:%SZ" && argv[5] === "+%s") {
  const epoch = Date.parse(argv[4]) / 1000;
  if (Number.isInteger(epoch)) {
    process.stdout.write(String(epoch) + "\n");
    process.exit(0);
  }
}

process.exit(1);
`;

function baseState(overrides = {}) {
  return {
    actor: "jhw7500",
    viewerPermission: "WRITE",
    repoLabels: ["review:request", "review:skip"],
    prLabels: [],
    prExists: true,
    prNumber: 42,
    prUrl: "https://github.com/example/repo/pull/42",
    prDraft: false,
    prMerged: false,
    localHead: currentHead,
    remoteBranchHead: oldHead,
    prHead: oldHead,
    prBase: "main",
    pushUpdatesPrHead: true,
    nextId: 9002,
    postCreatedAt: requestCreatedAt,
    issueComments: [],
    reviews: [],
    pullComments: [],
    issueReactions: [],
    commentReactions: [],
    runs: [],
    workflowStates: {
      "claude-code-review.yml": "active",
      "gemini-auto-review.yml": "active",
      "opencode-auto-review.yml": "active",
    },
    dispatchedWorkflows: [],
    requiredChecksExit: 0,
    branchMetadata: {
      protected: false,
      protection: {
        enabled: false,
        required_status_checks: {
          enforcement_level: "off",
          contexts: [],
          checks: [],
        },
      },
    },
    effectiveRules: [],
    appComments: [
      {
        actor: "chatgpt-codex-connector[bot]",
        body: "Codex Review: Didn't find any major issues.",
        url: "https://github.com/example/repo/pull/25#issuecomment-1",
      },
      {
        actor: "gemini-code-assist[bot]",
        body: "Gemini review completed.",
        url: "https://github.com/example/repo/pull/4#issuecomment-2",
      },
    ],
    failEndpoints: [],
    failPost: false,
    ...overrides,
  };
}

async function main() {
  const prText = await readFile(canonicalPr, "utf8");
  const aliasText = await readFile(shipAlias, "utf8");
  const agentsText = await readFile(agentsPath, "utf8");
  const readmeText = await readFile(readmePath, "utf8");
  assert.match(prText, /^# \/jhw:pr — PR 생성/m);
  assert.match(prText, /<!-- jhw-pr:review-request reviewer=\$\{reviewer\} head=\$\{head\} -->/);
  assert.match(prText, /jhw-\(pr\|ship\):codex-review round=/);
  assert.match(aliasText, /deprecated/i);
  assert.match(aliasText, /\/jhw:pr/);
  assert.doesNotMatch(aliasText, /pr-round-contract: trigger-and-scope:begin/);
  assert.match(prText, /\| Effective command policy \| Managed workflows \| Apps \| AI wait \|/);
  assert.doesNotMatch(prText, /기본 (?:\*\*)?3(?:라운드|\b)/);
  assert.doesNotMatch(prText, /최초 PR 라운드는 기존 자동 트리거/);
  assert.match(prText, /jhw_pr_request_app_review codex "\$head"/);
  assert.match(prText, /jhw_pr_request_app_review gemini-assist "\$head"/);
  assert.match(prText, /jhw_pr_dispatch_same_head claude-code-review\.yml 'Claude Code Review' "\$head"/);
  assert.match(prText, /jhw_pr_dispatch_same_head gemini-auto-review\.yml 'Gemini Auto PR Review' "\$head"/);
  assert.match(prText, /jhw_pr_dispatch_same_head opencode-auto-review\.yml 'OpenCode Auto PR Review' "\$head"/);
  assert.match(prText, /jhw_pr_wait_required_checks "\$PR" "\$ROUND_HEAD"/);
  assert.match(prText, /gh pr merge .*--match-head-commit/);
  assert.match(prText, /jhw_pr_prepare_review_plan "\$mode"/,
    "reviewer capability planning must run before PR policy mutation");
  assert.match(prText, /jhw_pr_request_eligible_apps "\$ROUND_HEAD"/,
    "the executable review flow must request only its preflighted App plan");
  assert.doesNotMatch(prText, /gh workflow view .*--json state/,
    "workflow state detection must not depend on unsupported gh workflow --json flags");
  assert.match(agentsText, /\| `pr\.md` \|/);
  assert.match(agentsText, /ship\.md.*deprecated/i);
  assert.match(readmeText, /\/jhw:pr --review/);
  assert.match(readmeText, /\/jhw:pr --no-review/);
  assert.match(readmeText, /\/jhw:pr --review --auto-fix/);
  assert.match(readmeText, /\/jhw:ship.*\/jhw:pr/);
  assert.match(readmeText, /생략.*review-on/);
  assert.match(readmeText, /mutation 전에.*workflow.*App canary/);
  assert.match(readmeText, /UNAVAILABLE.*mention하지 않는다/);
  assert.ok(existsSync(codexPrSkill), "generated Codex jhw-pr skill must exist");
  assert.ok(lstatSync(codexPrReference).isSymbolicLink(),
    "generated Codex jhw-pr reference must be a relative symlink");
  assert.match(await readFile(codexShipSkill, "utf8"), /deprecated/i);
  const contract = `${contractBlock(prText)}\n${policyContractBlock(prText)}`;
  const tempRoot = await mkdtemp(join(tmpdir(), "jhw-pr-contract-"));
  const fakeGh = join(tempRoot, "gh");
  const fakeGit = join(tempRoot, "git");
  const fakeDate = join(tempRoot, "date");
  const contractPath = join(tempRoot, "contract.bash");
  const configPath = join(tempRoot, "workflow-config.yml");
  const fixtureRoot = join(tempRoot, "repo");
  const fixtureWorkflowDir = join(fixtureRoot, ".github", "workflows");
  const fixtureConfigPath = join(fixtureRoot, ".github", "workflow-config.yml");
  const geminiConfigPath = join(fixtureRoot, ".gemini", "config.yaml");
  const statePath = join(tempRoot, "gh-state.json");
  const logPath = join(tempRoot, "gh-log.jsonl");
  const roundStatePath = join(tempRoot, "round.state");
  const nowEpochPath = join(tempRoot, "now-epoch");

  await writeFile(fakeGh, fakeGhSource);
  await chmod(fakeGh, 0o755);
  await writeFile(fakeGit, fakeGitSource);
  await chmod(fakeGit, 0o755);
  await writeFile(fakeDate, fakeDateSource);
  await chmod(fakeDate, 0o755);
  await writeFile(contractPath, contract);
  await mkdir(fixtureWorkflowDir, { recursive: true });
  await mkdir(dirname(geminiConfigPath), { recursive: true });
  const dispatchContract = "on:\n  workflow_dispatch:\n    inputs:\n      pr_number:\n      force_review:\n";
  await writeFile(join(fixtureWorkflowDir, "claude-code-review.yml"), dispatchContract);
  await writeFile(join(fixtureWorkflowDir, "gemini-auto-review.yml"), dispatchContract);
  const enabledReviewConfig = [
    "review:",
    "  auto: true",
    "workflows:",
    "  claude-code-review:",
    "    enabled: true",
    "  gemini-auto-review:",
    "    enabled: true",
    "",
  ].join("\n");
  await writeFile(fixtureConfigPath, enabledReviewConfig);
  await writeFile(geminiConfigPath, "code_review:\n  pull_request_opened:\n    code_review: false\n");

  async function run(state, commands, overrides = {}) {
    const { FAKE_DATE_INITIAL_EPOCH = startEpoch + 60, ...envOverrides } = overrides;
    await writeFile(statePath, JSON.stringify(state, null, 2));
    await writeFile(logPath, "");
    await writeFile(nowEpochPath, String(FAKE_DATE_INITIAL_EPOCH));
    await rm(roundStatePath, { force: true });
    const env = {
      ...process.env,
      PATH: `${tempRoot}:${process.env.PATH}`,
      FAKE_GH_STATE: statePath,
      FAKE_GH_LOG: logPath,
      FAKE_DATE_EPOCH_FILE: nowEpochPath,
      REPO_NWO: "example/repo",
      PR: "42",
      ROUND: "2",
      ROUND_HEAD: currentHead,
      ROUND_STARTED_AT: roundStartedAt,
      ROUND_PUSHED_AT: roundStartedAt,
      SHIP_ROUND_STATE_FILE: roundStatePath,
      SHIP_NOW_EPOCH: String(startEpoch + 60),
      JHW_PR_REPO_ROOT: fixtureRoot,
      JHW_PR_CONFIG_PATH: fixtureConfigPath,
      ...envOverrides,
    };
    const script = `source ${JSON.stringify(contractPath)}\n${commands}`;
    const result = await execFileAsync("bash", ["-c", script], { env, maxBuffer: 1024 * 1024 });
    return {
      ...result,
      state: JSON.parse(await readFile(statePath, "utf8")),
      log: (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
      roundState: await readFile(roundStatePath, "utf8").catch(() => ""),
    };
  }

  async function runResult(state, commands, overrides = {}) {
    try {
      return { code: 0, ...(await run(state, commands, overrides)) };
    } catch (error) {
      return {
        code: Number.isInteger(error.code) ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        state: JSON.parse(await readFile(statePath, "utf8")),
        log: (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
      };
    }
  }

  try {
    const requestMode = await run(baseState(), "jhw_pr_review_mode_from_args --review");
    const skipMode = await run(baseState(), "jhw_pr_review_mode_from_args --no-review");
    const autoMode = await run(baseState(), "jhw_pr_review_mode_from_args --merge --target");
    const conflictMode = await runResult(
      baseState(),
      "jhw_pr_review_mode_from_args --review --no-review",
    );
    assert.equal(requestMode.stdout.trim(), "request");
    assert.equal(skipMode.stdout.trim(), "skip");
    assert.equal(autoMode.stdout.trim(), "auto");
    assert.notEqual(conflictMode.code, 0);
    assert.equal(conflictMode.log.length, 0,
      "conflicting review options must fail before any gh or git command");

    assert.equal((await run(baseState(), "jhw_pr_merge_ai_policy_from_args --no-review --merge")).stdout.trim(), "skip");
    assert.equal((await run(baseState(), "jhw_pr_merge_ai_policy_from_args --review --merge")).stdout.trim(), "request");
    assert.equal((await run(baseState(), "jhw_pr_merge_ai_policy_from_args --merge")).stdout.trim(), "auto");
    assert.equal((await run(baseState(), "jhw_pr_merge_ai_policy_from_args --no-review")).stdout.trim(), "no-merge");
    assert.equal(
      (await run(baseState(), "jhw_pr_skip_merge_receipt")).stdout.trim(),
      "AI review: explicitly skipped (--no-review; review:skip)",
    );

    assert.equal((await run(baseState(), "jhw_pr_max_rounds_from_args")).stdout.trim(), "5");
    assert.equal((await run(baseState(), "jhw_pr_max_rounds_from_args --auto-fix --max-rounds 7")).stdout.trim(), "7");
    assert.notEqual((await runResult(baseState(), "jhw_pr_max_rounds_from_args --max-rounds 0")).code, 0);

    await writeFile(configPath, "review:\n  auto: true\n");
    assert.equal((await run(baseState(), `jhw_pr_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "true");
    await writeFile(configPath, "review:\n  auto: false\n");
    assert.equal((await run(baseState(), `jhw_pr_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "false");
    await writeFile(configPath, "workflows: {}\n");
    assert.equal((await run(baseState(), `jhw_pr_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "true");
    await writeFile(configPath, "review:\n  auto: yes\n");
    assert.notEqual((await runResult(baseState(), `jhw_pr_global_auto_enabled ${JSON.stringify(configPath)}`)).code, 0);

    const isGitPush = (args) => args[0] === "git" && args[1] === "push";
    const isGh = (args, group, command) => args[0] === group && args[1] === command;
    const hasOption = (args, name, value) => {
      const index = args.indexOf(name);
      return index >= 0 && args[index + 1] === value;
    };
    const callIndex = (log, predicate, start = 0) => {
      const relative = log.slice(start).findIndex(predicate);
      return relative < 0 ? -1 : start + relative;
    };
    const requireBefore = (log, first, second, message) => {
      const firstIndex = callIndex(log, first);
      const secondIndex = callIndex(log, second);
      assert.ok(firstIndex >= 0, `${message}: first call missing`);
      assert.ok(secondIndex >= 0, `${message}: second call missing`);
      assert.ok(firstIndex < secondIndex, message);
    };
    const mutationCalls = (log) => log.filter((args) =>
      isGitPush(args) ||
      isGh(args, "label", "create") ||
      (args[0] === "pr" && ["create", "edit", "ready", "merge"].includes(args[1])) ||
      (args[0] === "api" && args.includes("POST")));

    const readOnly = await runResult(
      baseState({ viewerPermission: "READ", prExists: false }),
      "jhw_pr_apply_new_pr_policy request",
    );
    assert.notEqual(readOnly.code, 0);
    assert.deepEqual(mutationCalls(readOnly.log), []);

    await run(baseState(), "jhw_pr_gemini_manual_review_configured");
    await run(baseState(), "jhw_pr_repo_has_app_canary gemini-assist");
    const eligibleApps = await run(
      baseState(),
      "jhw_pr_discover_app_reviewers",
    );
    assert.equal(eligibleApps.stdout, "codex\ngemini-assist\n");

    const noEligibleApps = await run(
      baseState({ appComments: [] }),
      [
        "apps=\"$(jhw_pr_discover_app_reviewers)\"",
        `jhw_pr_request_eligible_apps ${currentHead} "$apps"`,
      ].join("\n"),
    );
    assert.equal(noEligibleApps.log.filter((args) => args.includes("POST")).length, 0,
      "an App without same-repository capability evidence must not be mentioned");

    const aggregateAppCoordinates = await run(
      baseState({
        commentReactions: [{
          actor: "chatgpt-codex-connector[bot]",
          content: "+1",
          createdAt: requestCreatedAt,
        }],
      }),
      [
        "apps=$'codex\\ngemini-assist'",
        `jhw_pr_request_eligible_apps ${currentHead} "$apps"`,
        "ship_codex_signal_status",
        "printf 'generic=%s\\n' \"$JHW_PR_APP_REQUEST_COMMENT_ID\"",
        "printf 'codex=%s,%s,%s,%s\\n' \"$SHIP_CODEX_REQUEST_COMMENT_ID\" \"$SHIP_CODEX_REQUESTED_AT\" \"$SHIP_CODEX_TARGET_HEAD\" \"$SHIP_CODEX_REVIEW_STATUS\"",
        "printf 'records=%s\\n' \"$JHW_PR_APP_REQUEST_RESULTS\"",
      ].join("\n"),
    );
    assert.match(aggregateAppCoordinates.stdout, /generic=9003/,
      "the generic App result may point at the last requested reviewer");
    assert.match(
      aggregateAppCoordinates.stdout,
      new RegExp(`codex=9002,${requestCreatedAt},${currentHead},CLEAN`),
      "Codex polling must retain its own coordinates after Gemini overwrites the generic result",
    );
    assert.match(
      aggregateAppCoordinates.stdout,
      new RegExp(`records=codex\\tSTARTED\\t-\\t9002\\t${requestCreatedAt}\\ttrue\\t${currentHead}`),
      "the aggregate must preserve every App request's polling coordinates",
    );
    assert.match(
      aggregateAppCoordinates.stdout,
      new RegExp(`gemini-assist\\tSTARTED\\t-\\t9003\\t${requestCreatedAt}\\ttrue\\t${currentHead}`),
    );
    assert.match(aggregateAppCoordinates.roundState, /request_comment_id=9002/,
      "the durable Codex round state must be written before another App request runs");

    await writeFile(
      join(fixtureWorkflowDir, "claude-code-review.yml"),
      "on:\n  workflow_dispatch:\n    inputs:\n      pr_number:\n",
    );
    const staleWorkflowContract = await runResult(
      baseState({ repoLabels: [], prExists: false }),
      "jhw_pr_apply_new_pr_policy request",
    );
    await writeFile(join(fixtureWorkflowDir, "claude-code-review.yml"), dispatchContract);
    assert.notEqual(staleWorkflowContract.code, 0);
    assert.deepEqual(mutationCalls(staleWorkflowContract.log), [],
      "an unsupported force_review contract must stop before labels, push, or PR creation");

    await writeFile(fixtureConfigPath, enabledReviewConfig.replace(
      "  claude-code-review:\n    enabled: true",
      "  claude-code-review:\n    enabled: false",
    ));
    const disabledByConfig = await run(
      baseState(),
      [
        "jhw_pr_prepare_review_plan request",
        "printf 'available=%s\\nunavailable=%s\\n' \"$JHW_PR_AVAILABLE_WORKFLOWS\" \"$JHW_PR_UNAVAILABLE_WORKFLOWS\"",
      ].join("\n"),
    );
    await writeFile(fixtureConfigPath, enabledReviewConfig);
    assert.doesNotMatch(
      disabledByConfig.stdout.slice(0, disabledByConfig.stdout.indexOf("unavailable=")),
      /claude-code-review\.yml/,
    );
    assert.match(disabledByConfig.stdout, /claude-code-review\.yml\tworkflow_config_disabled/);

    const newPr = await run(
      baseState({
        repoLabels: [],
        prLabels: ["review:skip"],
        prExists: false,
      }),
      "jhw_pr_apply_new_pr_policy request",
    );
    const requestLabelCreate = (args) => isGh(args, "label", "create") && args[2] === "review:request";
    const skipLabelCreate = (args) => isGh(args, "label", "create") && args[2] === "review:skip";
    const createDraft = (args) => isGh(args, "pr", "create") && args.includes("--draft");
    const removeSkip = (args) => isGh(args, "pr", "edit") && hasOption(args, "--remove-label", "review:skip");
    const addRequest = (args) => isGh(args, "pr", "edit") && hasOption(args, "--add-label", "review:request");
    const ready = (args) => isGh(args, "pr", "ready");
    requireBefore(newPr.log, requestLabelCreate, isGitPush, "request label definition must precede push");
    requireBefore(newPr.log, skipLabelCreate, isGitPush, "skip label definition must precede push");
    requireBefore(newPr.log, isGitPush, createDraft, "new PR push must precede draft creation");
    requireBefore(newPr.log, createDraft, removeSkip, "draft creation must precede policy reconciliation");
    requireBefore(newPr.log, removeSkip, addRequest, "opposite label must be removed before request label is added");
    requireBefore(newPr.log, addRequest, ready, "verified request policy must precede ready transition");
    assert.deepEqual(newPr.state.prLabels, ["review:request"]);
    assert.equal(newPr.state.prHead, currentHead);
    assert.equal(newPr.state.prDraft, false);

    const newPrWithBase = await run(
      baseState({ prExists: false }),
      "jhw_pr_apply_new_pr_policy auto",
      { JHW_PR_BASE: "release/v2" },
    );
    assert.equal(newPrWithBase.state.prBase, "release/v2",
      "new PR creation must retain the explicitly requested base");
    assert.equal(newPrWithBase.log.some((args) =>
      isGh(args, "pr", "create") && hasOption(args, "--base", "release/v2")), true);

    const invalidBase = await runResult(
      baseState({ repoLabels: [], prExists: false }),
      "jhw_pr_apply_new_pr_policy auto",
      { JHW_PR_BASE: "../release" },
    );
    assert.notEqual(invalidBase.code, 0);
    assert.deepEqual(mutationCalls(invalidBase.log), [],
      "an invalid base must fail before labels, push, or PR creation");

    const existingPr = await run(
      baseState({ prLabels: ["review:request"] }),
      `jhw_pr_apply_existing_pr_policy skip ${currentHead}`,
    );
    const removeRequest = (args) => isGh(args, "pr", "edit") && hasOption(args, "--remove-label", "review:request");
    const addSkip = (args) => isGh(args, "pr", "edit") && hasOption(args, "--add-label", "review:skip");
    requireBefore(existingPr.log, removeRequest, addSkip, "request label must be removed before skip is added");
    requireBefore(existingPr.log, addSkip, isGitPush, "skip policy must be applied before synchronize push");
    assert.deepEqual(existingPr.state.prLabels, ["review:skip"]);
    assert.equal(existingPr.state.prHead, currentHead);

    const existingPrWithDifferentBase = await run(
      baseState({ prLabels: ["review:request"], prBase: "main" }),
      `jhw_pr_apply_existing_pr_policy skip ${currentHead}`,
      { JHW_PR_BASE: "release/v2" },
    );
    const editBase = (args) => isGh(args, "pr", "edit") && hasOption(args, "--base", "release/v2");
    requireBefore(existingPrWithDifferentBase.log, editBase, removeRequest,
      "an existing PR base must be reconciled before review-triggering label changes");
    requireBefore(existingPrWithDifferentBase.log, editBase, isGitPush,
      "an existing PR base must be reconciled before synchronize");
    assert.equal(existingPrWithDifferentBase.state.prBase, "release/v2",
      "--base must apply to an already-open PR");

    const frozenBase = await runResult(
      baseState({ prLabels: ["review:request"], prBase: "main", freezeBase: true }),
      `jhw_pr_apply_existing_pr_policy skip ${currentHead}`,
      { JHW_PR_BASE: "release/v2" },
    );
    assert.notEqual(frozenBase.code, 0);
    assert.deepEqual(frozenBase.state.prLabels, ["review:request"],
      "failed base read-back must stop before review policy mutation");
    assert.equal(frozenBase.log.some(isGitPush), false,
      "failed base read-back must stop before synchronize");

    const sameHeadExistingPr = await run(
      baseState({
        prLabels: ["review:skip"],
        prHead: currentHead,
        remoteBranchHead: currentHead,
      }),
      `jhw_pr_apply_existing_pr_policy request ${currentHead}`,
    );
    assert.deepEqual(sameHeadExistingPr.state.prLabels, ["review:request"]);
    assert.equal(sameHeadExistingPr.log.filter(isGitPush).length, 0,
      "an unchanged existing PR head must reconcile policy without a synchronize push");
    assert.equal(sameHeadExistingPr.log.some((args) =>
      isGh(args, "pr", "edit") && args.includes("--base")), false,
    "an already-correct base must not receive a redundant edit");

    const autoExisting = await run(
      baseState({ prLabels: ["review:request", "review:skip"] }),
      `jhw_pr_apply_existing_pr_policy auto ${currentHead}`,
    );
    const autoRemoveRequest = callIndex(autoExisting.log, removeRequest);
    const autoRemoveSkip = callIndex(autoExisting.log, removeSkip, autoRemoveRequest + 1);
    const autoPush = callIndex(autoExisting.log, isGitPush);
    assert.ok(autoRemoveRequest >= 0 && autoRemoveSkip > autoRemoveRequest && autoPush > autoRemoveSkip,
      "auto mode must remove both overrides before push");
    assert.deepEqual(autoExisting.state.prLabels, []);

    const autoNoLabels = await run(
      baseState({ prLabels: [] }),
      `jhw_pr_apply_existing_pr_policy auto ${currentHead}`,
    );
    assert.deepEqual(autoNoLabels.state.prLabels, [],
      "auto mode must succeed when neither override label is present");

    const autoRequestOnly = await run(
      baseState({ prLabels: ["review:request"] }),
      `jhw_pr_apply_existing_pr_policy auto ${currentHead}`,
    );
    assert.deepEqual(autoRequestOnly.state.prLabels, [],
      "auto mode must remove a lone request override without returning grep status 1");

    const frozenPolicy = await runResult(
      baseState({ prLabels: ["review:skip"], freezeLabels: true }),
      `jhw_pr_apply_existing_pr_policy request ${currentHead}`,
    );
    assert.notEqual(frozenPolicy.code, 0);
    assert.equal(frozenPolicy.log.some(isGitPush), false,
      "failed remote policy verification must stop before existing-PR push");

    const staleHead = await runResult(
      baseState({ prLabels: ["review:request"], pushUpdatesPrHead: false }),
      `jhw_pr_apply_existing_pr_policy request ${currentHead}`,
    );
    assert.notEqual(staleHead.code, 0);
    assert.equal(staleHead.log.filter(isGitPush).length, 1);

    const unexpectedlyReady = await runResult(
      baseState({ prExists: false, forceReadyOnCreate: true }),
      "jhw_pr_apply_new_pr_policy skip",
    );
    assert.notEqual(unexpectedlyReady.code, 0);
    assert.equal(unexpectedlyReady.log.some(ready), false,
      "a PR that is already ready must fail verification instead of issuing another ready mutation");

    const countPosts = (result) => result.log.filter((args) => args.includes("POST")).length;
    const currentCodexRequest = {
      id: 9101,
      actor: "jhw7500",
      createdAt: requestCreatedAt,
      body: genericCodexBody,
    };
    const codexRequest = await run(
      baseState(),
      `jhw_pr_request_app_review codex ${currentHead}`,
    );
    const geminiRequest = await run(
      baseState(),
      `jhw_pr_request_app_review gemini-assist ${currentHead}`,
    );
    const codexResume = await run(
      baseState({ issueComments: [currentCodexRequest] }),
      `jhw_pr_request_app_review codex ${currentHead}`,
    );
    const codexOldHead = await run(
      baseState({
        issueComments: [{ ...currentCodexRequest, id: 9103, body: oldGenericCodexBody }],
      }),
      `jhw_pr_request_app_review codex ${currentHead}`,
    );
    const codexDuplicate = await runResult(
      baseState({
        issueComments: [currentCodexRequest, { ...currentCodexRequest, id: 9102 }],
      }),
      `jhw_pr_request_app_review codex ${currentHead}`,
    );
    const unsupportedApp = await runResult(
      baseState(),
      `jhw_pr_request_app_review unknown-reviewer ${currentHead}`,
    );
    assert.equal(countPosts(codexRequest), 1);
    assert.equal(countPosts(geminiRequest), 1);
    assert.equal(countPosts(codexResume), 0);
    assert.equal(countPosts(codexOldHead), 1);
    assert.notEqual(codexDuplicate.code, 0);
    assert.match(codexDuplicate.stderr, /TRIGGER_FAILED/);
    assert.notEqual(unsupportedApp.code, 0);
    assert.equal(countPosts(unsupportedApp), 0);
    assert.equal(codexRequest.state.issueComments.at(-1).body, genericCodexBody);
    assert.equal(geminiRequest.state.issueComments.at(-1).body, genericGeminiBody);

    const codexPrimaryCompatibility = await run(
      baseState({
        issueComments: [
          { id: 9201, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody },
        ],
      }),
      `jhw_pr_request_app_review codex ${currentHead}`,
    );
    const codexLegacyCompatibility = await run(
      baseState({
        issueComments: [
          { id: 9202, actor: "jhw7500", createdAt: requestCreatedAt, body: legacyRequestBody },
        ],
      }),
      `jhw_pr_request_app_review codex ${currentHead}`,
    );
    const codexOtherRoundCompatibility = await run(
      baseState({
        issueComments: [
          { id: 9204, actor: "jhw7500", createdAt: requestCreatedAt, body: otherRoundRequestBody },
        ],
      }),
      `jhw_pr_request_app_review codex ${currentHead}`,
    );
    const codexMixedCompatibilityDuplicate = await runResult(
      baseState({
        issueComments: [
          currentCodexRequest,
          { id: 9203, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody },
        ],
      }),
      `jhw_pr_request_app_review codex ${currentHead}`,
    );
    assert.equal(countPosts(codexPrimaryCompatibility), 0,
      "one actor-owned canonical round marker for the current head must be reused");
    assert.equal(countPosts(codexLegacyCompatibility), 0,
      "one actor-owned legacy ship marker for the current head must be reused");
    assert.equal(countPosts(codexOtherRoundCompatibility), 0,
      "a canonical Codex round marker for the current head must be reused regardless of round number");
    assert.notEqual(codexMixedCompatibilityDuplicate.code, 0);
    assert.match(codexMixedCompatibilityDuplicate.stderr, /TRIGGER_FAILED/);
    assert.equal(countPosts(codexMixedCompatibilityDuplicate), 0);

    const isWorkflowDispatch = (args) => args[0] === "workflow" && args[1] === "run";
    const sameHeadWorkflow = await run(
      baseState({
        runs: [
          {
            id: 9301,
            attempt: 1,
            name: "Claude Code Review",
            head: currentHead,
            createdAt: requestCreatedAt,
            status: "queued",
            conclusion: "null",
            event: "workflow_dispatch",
          },
        ],
      }),
      [
        `jhw_pr_dispatch_same_head claude-code-review.yml 'Claude Code Review' ${currentHead}`,
        "printf '%s,%s\n' \"$JHW_PR_WORKFLOW_REQUEST_STATUS\" \"$JHW_PR_WORKFLOW_RUN_ID\"",
      ].join("\n"),
    );
    assert.equal(sameHeadWorkflow.stdout.trim(), "REUSED,9301");
    assert.equal(sameHeadWorkflow.log.filter(isWorkflowDispatch).length, 0);

    const exactDispatch = await run(
      baseState({
        runs: [
          {
            id: 9302,
            attempt: 1,
            name: "Gemini Auto PR Review",
            head: currentHead,
            createdAt: requestCreatedAt,
            status: "completed",
            conclusion: "success",
            event: "push",
          },
          {
            id: 9303,
            attempt: 1,
            name: "Gemini Auto PR Review",
            head: oldHead,
            createdAt: requestCreatedAt,
            status: "in_progress",
            conclusion: "null",
            event: "workflow_dispatch",
          },
        ],
      }),
      [
        `jhw_pr_dispatch_same_head gemini-auto-review.yml 'Gemini Auto PR Review' ${currentHead}`,
        "printf '%s\n' \"$JHW_PR_WORKFLOW_REQUEST_STATUS\"",
      ].join("\n"),
    );
    assert.equal(exactDispatch.stdout.trim(), "DISPATCHED");
    assert.deepEqual(
      exactDispatch.log.filter(isWorkflowDispatch),
      [[
        "workflow", "run", "gemini-auto-review.yml", "--repo", "example/repo",
        "-f", "pr_number=42", "-f", "force_review=true",
      ]],
    );

    const openCodeDispatch = await run(
      baseState(),
      `jhw_pr_dispatch_same_head opencode-auto-review.yml 'OpenCode Auto PR Review' ${currentHead}`,
    );
    assert.deepEqual(
      openCodeDispatch.log.filter(isWorkflowDispatch),
      [[
        "workflow", "run", "opencode-auto-review.yml", "--repo", "example/repo",
        "-f", "pr_number=42", "-f", "force_review=true",
      ]],
    );

    const ambiguousWorkflow = await runResult(
      baseState({
        runs: [9304, 9305].map((id) => ({
          id,
          attempt: 1,
          name: "Claude Code Review",
          head: currentHead,
          createdAt: requestCreatedAt,
          status: "in_progress",
          conclusion: "null",
          event: "workflow_dispatch",
        })),
      }),
      `jhw_pr_dispatch_same_head claude-code-review.yml 'Claude Code Review' ${currentHead}`,
    );
    assert.notEqual(ambiguousWorkflow.code, 0);
    assert.match(ambiguousWorkflow.stderr, /TRIGGER_FAILED/);
    assert.equal(ambiguousWorkflow.log.filter(isWorkflowDispatch).length, 0);

    const unavailableWorkflow = await run(
      baseState({ workflowStates: {} }),
      [
        `jhw_pr_dispatch_same_head claude-code-review.yml 'Claude Code Review' ${currentHead}`,
        "printf '%s,%s\n' \"$JHW_PR_WORKFLOW_REQUEST_STATUS\" \"$JHW_PR_WORKFLOW_REQUEST_REASON\"",
      ].join("\n"),
    );
    assert.equal(unavailableWorkflow.stdout.trim(), "UNAVAILABLE,workflow_unavailable");
    assert.equal(unavailableWorkflow.log.filter(isWorkflowDispatch).length, 0);

    const disabledWorkflow = await run(
      baseState({ workflowStates: { "claude-code-review.yml": "disabled_manually" } }),
      [
        `jhw_pr_dispatch_same_head claude-code-review.yml 'Claude Code Review' ${currentHead}`,
        "printf '%s,%s\n' \"$JHW_PR_WORKFLOW_REQUEST_STATUS\" \"$JHW_PR_WORKFLOW_REQUEST_REASON\"",
      ].join("\n"),
    );
    assert.equal(disabledWorkflow.stdout.trim(), "UNAVAILABLE,workflow_disabled");
    assert.equal(disabledWorkflow.log.filter(isWorkflowDispatch).length, 0);

    const requiredChecks = await run(
      baseState({ prHead: currentHead }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.deepEqual(
      requiredChecks.log.filter((args) => args[0] === "pr" && args[1] === "checks"),
      [["pr", "checks", "42", "--repo", "example/repo", "--required", "--watch", "--interval", "10"]],
    );
    const requiredChecksFailed = await runResult(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "required check failed\n",
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(requiredChecksFailed.code, 1);
    const noRequiredChecks = await run(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(noRequiredChecks.state.prHead, currentHead,
      "authoritative classic/ruleset metadata proving an empty policy must satisfy the gate");
    assert.deepEqual(
      noRequiredChecks.log
        .filter((args) => args[0] === "api")
        .map((args) => args[1]),
      [
        "repos/example/repo/branches/main",
        "repos/example/repo/rules/branches/main?per_page=100",
      ],
      "the CLI diagnostic alone must not stand in for required-check policy metadata",
    );

    const requiredCheckRegistrationGap = await runResult(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        branchMetadata: {
          protected: true,
          protection: {
            enabled: true,
            required_status_checks: {
              enforcement_level: "non_admins",
              contexts: ["ci/test"],
              checks: [{ context: "ci/test", app_id: 17 }],
            },
          },
        },
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(requiredCheckRegistrationGap.code, 1,
      "a configured required check that has not registered yet must fail closed");

    const requiredCheckMetadataUnavailable = await runResult(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        failEndpoints: ["/branches/main"],
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(requiredCheckMetadataUnavailable.code, 1,
      "unavailable protection metadata must fail closed");

    const requiredCheckRulesetPresent = await runResult(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        effectiveRules: [{
          type: "required_status_checks",
          ruleset_source_type: "Repository",
          ruleset_source: "example/repo",
          ruleset_id: 42,
          parameters: {
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: "ci/ruleset", integration_id: 17 }],
            strict_required_status_checks_policy: true,
          },
        }],
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(requiredCheckRulesetPresent.code, 1,
      "an effective ruleset-required status check must fail closed before it reports");

    const requiredWorkflowRulesetPresent = await runResult(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        effectiveRules: [{
          type: "workflows",
          ruleset_source_type: "Organization",
          ruleset_source: "example",
          ruleset_id: 43,
          parameters: {
            do_not_enforce_on_create: false,
            workflows: [{ path: ".github/workflows/policy.yml", repository_id: 99 }],
          },
        }],
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(requiredWorkflowRulesetPresent.code, 1,
      "an effective required-workflow rule must fail closed before it reports");

    const reviewOnlyProtection = await run(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        branchMetadata: {
          protected: true,
          protection: {
            enabled: true,
            required_status_checks: {
              enforcement_level: "off",
              contexts: [],
              checks: [],
            },
          },
        },
        effectiveRules: [{
          type: "pull_request",
          ruleset_source_type: "Repository",
          ruleset_source: "example/repo",
          ruleset_id: 44,
          parameters: { required_approving_review_count: 1 },
        }],
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(reviewOnlyProtection.state.prHead, currentHead,
      "review-only classic/ruleset protection must not invent a required status check");

    const nonCiEffectiveRules = await run(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        effectiveRules: [
          {
            type: "commit_message_pattern",
            ruleset_source_type: "Repository",
            ruleset_source: "example/repo",
            ruleset_id: 45,
            parameters: { operator: "starts_with", pattern: "feat:" },
          },
          {
            type: "required_signatures",
            ruleset_source_type: "Organization",
            ruleset_source: "example",
            ruleset_id: 46,
          },
        ],
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(nonCiEffectiveRules.state.prHead, currentHead,
      "effective non-CI rules must not block an authoritatively empty status-check gate");

    const malformedClassicMetadata = await runResult(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        branchMetadata: {
          protected: false,
          protection: {
            enabled: false,
            required_status_checks: { enforcement_level: "off", contexts: [] },
          },
        },
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(malformedClassicMetadata.code, 1,
      "malformed classic status-check metadata must fail closed");

    const malformedEffectiveRules = await runResult(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        effectiveRules: [{ type: "required_status_checks", parameters: {} }],
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(malformedEffectiveRules.code, 1,
      "malformed effective rule metadata must fail closed");

    const effectiveRuleMetadataUnavailable = await runResult(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
        failEndpoints: ["/rules/branches/main"],
      }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(effectiveRuleMetadataUnavailable.code, 1,
      "unavailable effective-rule metadata must fail closed");

    const noRequiredChecksStrictMode = await run(
      baseState({
        prHead: currentHead,
        requiredChecksExit: 1,
        requiredChecksMessage: "no required checks reported on the 'task/example' branch\n",
      }),
      [
        "set -e",
        `jhw_pr_wait_required_checks 42 ${currentHead}`,
        "printf 'strict-ok\\n'",
      ].join("\n"),
    );
    assert.equal(noRequiredChecksStrictMode.stdout, "strict-ok\n",
      "the expected gh status 1 path must remain inspectable under set -e");
    const changedDuringChecks = await runResult(
      baseState({ prHead: currentHead, headAfterRequiredChecks: oldHead }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(changedDuringChecks.code, 3,
      "a head change during required checks must invalidate all collected results");
    const baseChangedDuringChecks = await runResult(
      baseState({ prHead: currentHead, baseAfterRequiredChecks: "release" }),
      `jhw_pr_wait_required_checks 42 ${currentHead}`,
    );
    assert.equal(baseChangedDuringChecks.code, 3,
      "a base change during required checks must invalidate the policy scope");

    const atomicMerge = await run(
      baseState({ prHead: currentHead }),
      `jhw_pr_merge_reviewed_head 42 ${currentHead} merge`,
    );
    assert.equal(atomicMerge.state.prMerged, true);
    assert.deepEqual(
      atomicMerge.log.filter((args) => args[0] === "pr" && args[1] === "merge"),
      [[
        "pr", "merge", "42", "--repo", "example/repo", "--match-head-commit", currentHead,
        "--merge", "--delete-branch",
      ]],
    );

    const mergeRace = await runResult(
      baseState({ prHead: currentHead, headBeforeMerge: oldHead }),
      `jhw_pr_merge_reviewed_head 42 ${currentHead} merge`,
    );
    assert.notEqual(mergeRace.code, 0,
      "a remote head change immediately before merge must reject the merge atomically");
    assert.equal(mergeRace.state.prMerged, false);

    const skipWaitPlan = await run(baseState(), "jhw_pr_mode_wait_plan skip true");
    assert.equal(
      skipWaitPlan.stdout,
      "required-checks\ntarget-if-requested\nverify-current-head\nverify-mergeability\n",
    );
    assert.equal(countPosts(skipWaitPlan), 0);
    assert.equal(skipWaitPlan.log.filter(isWorkflowDispatch).length, 0);
    assert.doesNotMatch(skipWaitPlan.stdout, /ai-wait/);
    assert.equal(
      (await run(baseState(), "jhw_pr_mode_wait_plan request false")).stdout,
      "managed-workflows\napps\nai-wait\nrequired-checks\ntarget-if-requested\nverify-current-head\nverify-mergeability\n",
    );
    assert.equal(
      (await run(baseState(), "jhw_pr_mode_wait_plan auto true")).stdout,
      "event-workflows\napps\nai-wait\nrequired-checks\ntarget-if-requested\nverify-current-head\nverify-mergeability\n",
    );
    assert.equal(
      (await run(baseState(), "jhw_pr_mode_wait_plan auto false")).stdout,
      skipWaitPlan.stdout,
    );

    assert.equal(
      (await run(baseState(), `jhw_pr_reviewed_receipt ${currentHead}`)).stdout.trim(),
      `- Reviewed: ${currentHead}`,
    );
    assert.notEqual((await runResult(baseState(), "jhw_pr_reviewed_receipt HEAD")).code, 0);

    const idempotent = await run(
      baseState({
        issueComments: [
          { id: 55, actor: "jhw7500", createdAt: requestCreatedAt, body: "unrelated comment" },
        ],
      }),
      [
        "ship_codex_trigger",
        "printf 'first=%s,%s,%s,%s\\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_REQUEST_COMMENT_ID\" \"$SHIP_CODEX_REQUESTED_AT\" \"$SHIP_CODEX_REQUEST_CREATED\"",
        "ship_codex_trigger",
        "printf 'second=%s,%s,%s,%s\\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_REQUEST_COMMENT_ID\" \"$SHIP_CODEX_TARGET_HEAD\" \"$SHIP_CODEX_REQUEST_CREATED\"",
      ].join("\n"),
    );
    assert.match(idempotent.stdout, new RegExp(`first=STARTED,9002,${requestCreatedAt},true`));
    assert.match(idempotent.stdout, new RegExp(`second=STARTED,9002,${currentHead},false`));
    assert.equal(idempotent.log.filter((args) => args.includes("POST")).length, 1,
      "a round/head must create exactly one Codex request");
    assert.equal(
      idempotent.state.issueComments.find((item) => item.id === 9002).body,
      genericCodexBody,
      "auto-fix rounds must create the same canonical head-scoped Codex request as the first round",
    );
    assert.match(idempotent.roundState, /request_comment_id=9002/);
    assert.match(idempotent.roundState, new RegExp(`requested_at=${requestCreatedAt}`));
    assert.match(idempotent.roundState, new RegExp(`target_head=${currentHead}`));

    const failedPost = await run(
      baseState({ failPost: true }),
      "ship_codex_trigger\nprintf '%s,%s\\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_TRIGGER_REASON\"",
    );
    assert.equal(failedPost.stdout.trim(), "TRIGGER_FAILED,request_post_failed");

    const duplicate = await run(
      baseState({
        issueComments: [
          { id: 10, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody },
          { id: 11, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody },
        ],
      }),
      "ship_codex_trigger\nprintf '%s,%s\\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_TRIGGER_REASON\"",
    );
    assert.equal(duplicate.stdout.trim(), "TRIGGER_FAILED,duplicate_request_marker");
    assert.equal(duplicate.log.filter((args) => args.includes("POST")).length, 0);

    const legacyCurrentHead = await run(
      baseState({
        issueComments: [
          { id: 12, actor: "jhw7500", createdAt: requestCreatedAt, body: legacyRequestBody },
        ],
      }),
      "ship_codex_trigger\nprintf '%s,%s\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_REQUEST_COMMENT_ID\"",
    );
    assert.equal(legacyCurrentHead.stdout.trim(), "STARTED,12");
    assert.equal(legacyCurrentHead.log.filter((args) => args.includes("POST")).length, 0,
      "one actor-owned legacy marker for the current head must be reused");

    const legacyOldHead = await run(
      baseState({
        issueComments: [
          { id: 13, actor: "jhw7500", createdAt: requestCreatedAt, body: oldLegacyRequestBody },
        ],
      }),
      "ship_codex_trigger",
    );
    assert.equal(legacyOldHead.log.filter((args) => args.includes("POST")).length, 1,
      "a legacy marker for an old head must not suppress the current request");

    const mixedDuplicate = await run(
      baseState({
        issueComments: [
          { id: 14, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody },
          { id: 15, actor: "jhw7500", createdAt: requestCreatedAt, body: legacyRequestBody },
        ],
      }),
      "ship_codex_trigger\nprintf '%s,%s\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_TRIGGER_REASON\"",
    );
    assert.equal(mixedDuplicate.stdout.trim(), "TRIGGER_FAILED,duplicate_request_marker");
    assert.equal(mixedDuplicate.log.filter((args) => args.includes("POST")).length, 0);

    const bashThreeCompatible = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
      }),
      [
        "enable -n mapfile",
        "ship_codex_trigger",
        "printf '%s,%s\\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_REQUEST_COMMENT_ID\"",
      ].join("\n"),
    );
    assert.equal(bashThreeCompatible.stdout.trim(), "STARTED,9002",
      "the trigger contract must run without Bash 4 mapfile support");
    assert.equal(bashThreeCompatible.log.filter((args) => args.includes("POST")).length, 0,
      "a Bash 3-compatible retry must reuse the existing marker without posting a duplicate");

    const bsdTimestamp = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
      }),
      "ship_codex_trigger\nprintf '%s,%s\\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_REQUEST_COMMENT_ID\"",
      { FAKE_DATE_BSD_ONLY: "1" },
    );
    assert.equal(bsdTimestamp.stdout.trim(), "STARTED,9002",
      "GitHub timestamps must parse with the BSD date available on macOS");

    const workflowStarted = await run(
      baseState({
        runs: [
          { id: 1, attempt: 1, name: "Claude Code Review", head: oldHead, createdAt: "2026-08-29T00:02:00Z", status: "in_progress", conclusion: "null" },
          { id: 2, attempt: 1, name: "Claude Code Review", head: currentHead, createdAt: "2026-08-28T23:59:00Z", status: "completed", conclusion: "success" },
          { id: 3, attempt: 2, name: "Claude Code Review", head: currentHead, createdAt: "2026-08-29T00:02:00Z", status: "in_progress", conclusion: "null" },
        ],
      }),
      "ship_workflow_trigger 'Claude Code Review'\nprintf '%s,%s\\n' \"$SHIP_WORKFLOW_TRIGGER_STATUS\" \"$SHIP_WORKFLOW_RUN_ID\"",
      { SHIP_NOW_EPOCH: String(startEpoch + 180) },
    );
    assert.equal(workflowStarted.stdout.trim(), "STARTED,3");

    const workflowPending = await run(
      baseState(),
      "ship_workflow_trigger 'Gemini Auto PR Review'\nprintf '%s\\n' \"$SHIP_WORKFLOW_TRIGGER_STATUS\"",
      { SHIP_NOW_EPOCH: String(startEpoch + 179) },
    );
    assert.equal(workflowPending.stdout.trim(), "PENDING");

    const workflowMissing = await run(
      baseState(),
      "ship_workflow_trigger 'Gemini Auto PR Review'\nprintf '%s,%s\\n' \"$SHIP_WORKFLOW_TRIGGER_STATUS\" \"$SHIP_WORKFLOW_TRIGGER_REASON\"",
      { SHIP_NOW_EPOCH: String(startEpoch + 180) },
    );
    assert.equal(workflowMissing.stdout.trim(), "TRIGGER_FAILED,current_head_run_missing");

    const slowPushCompletedAt = "2026-08-29T00:04:00Z";
    const slowPushEpoch = Date.parse(slowPushCompletedAt) / 1000;
    const workflowAfterSlowPush = await run(
      baseState(),
      "ship_workflow_trigger 'Gemini Auto PR Review'\nprintf '%s\\n' \"$SHIP_WORKFLOW_TRIGGER_STATUS\"",
      {
        ROUND_PUSHED_AT: slowPushCompletedAt,
        SHIP_NOW_EPOCH: String(slowPushEpoch + 179),
      },
    );
    assert.equal(workflowAfterSlowPush.stdout.trim(), "PENDING",
      "workflow grace must start after a successful push, not at the pre-push filter timestamp");

    const workflowClockAdvances = await run(
      baseState(),
      [
        "ship_workflow_trigger 'Gemini Auto PR Review'",
        "printf 'first=%s\\n' \"$SHIP_WORKFLOW_TRIGGER_STATUS\"",
        `printf '%s\\n' '${startEpoch + 180}' > \"$FAKE_DATE_EPOCH_FILE\"`,
        "ship_workflow_trigger 'Gemini Auto PR Review'",
        "printf 'second=%s,%s\\n' \"$SHIP_WORKFLOW_TRIGGER_STATUS\" \"$SHIP_WORKFLOW_TRIGGER_REASON\"",
      ].join("\n"),
      { SHIP_NOW_EPOCH: "", FAKE_DATE_INITIAL_EPOCH: startEpoch + 179 },
    );
    assert.equal(
      workflowClockAdvances.stdout,
      "first=PENDING\nsecond=TRIGGER_FAILED,current_head_run_missing\n",
      "each poll must refresh the current clock before evaluating the trigger deadline",
    );

    const workflowLookupFailed = await run(
      baseState({ failEndpoints: ["/actions/runs?"] }),
      "ship_workflow_trigger 'Claude Code Review'\nprintf '%s,%s\\n' \"$SHIP_WORKFLOW_TRIGGER_STATUS\" \"$SHIP_WORKFLOW_TRIGGER_REASON\"",
    );
    assert.equal(workflowLookupFailed.stdout.trim(), "TRIGGER_FAILED,run_lookup_failed");

    const oldSignals = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [
          { actor: "chatgpt-codex-connector[bot]", commitId: oldHead, submittedAt: "2026-08-29T00:03:00Z", blocking: true },
        ],
        pullComments: [
          { actor: "chatgpt-codex-connector[bot]", commitId: currentHead, originalCommitId: oldHead, createdAt: "2026-08-29T00:04:00Z", blocking: true },
        ],
        issueReactions: [
          { actor: "chatgpt-codex-connector[bot]", content: "+1", createdAt: "2026-08-29T00:00:30Z" },
        ],
        commentReactions: [
          { actor: "chatgpt-codex-connector[bot]", content: "eyes", createdAt: "2026-08-29T00:02:00Z" },
        ],
      }),
      [
        "ship_codex_trigger",
        "ship_codex_signal_status",
        "printf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      ].join("\n"),
      { SHIP_NOW_EPOCH: String(requestEpoch + 300) },
    );
    assert.equal(oldSignals.stdout.trim(), "PENDING",
      "old-head review, remapped inline comment, and pre-request +1 must not terminate the round");

    const currentReview = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [
          { actor: "chatgpt-codex-connector[bot]", commitId: currentHead, submittedAt: "2026-08-29T00:03:00Z", blocking: false },
        ],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(currentReview.stdout.trim(), "CLEAN");

    const currentBlockingReview = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [
          { actor: "chatgpt-codex-connector[bot]", commitId: currentHead, submittedAt: "2026-08-29T00:03:00Z", blocking: true },
        ],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(currentBlockingReview.stdout.trim(), "FEEDBACK");

    const currentP0Review = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [
          { actor: "chatgpt-codex-connector[bot]", commitId: currentHead, submittedAt: "2026-08-29T00:03:00Z", severity: "P0" },
        ],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(currentP0Review.stdout.trim(), "FEEDBACK",
      "the default must-fix threshold must block both P0 and P1 findings");

    const currentP2Inline = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        pullComments: [
          { actor: "chatgpt-codex-connector[bot]", commitId: currentHead, originalCommitId: currentHead, createdAt: "2026-08-29T00:03:00Z", severity: "P2" },
        ],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      { SHIP_BLOCK_ON: "should-fix" },
    );
    assert.equal(currentP2Inline.stdout.trim(), "FEEDBACK",
      "the should-fix threshold must include P2 inline findings");

    const currentReaction = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        commentReactions: [
          { actor: "chatgpt-codex-connector[bot]", content: "+1", createdAt: "2026-08-29T00:02:00Z" },
        ],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(currentReaction.stdout.trim(), "CLEAN");

    const timedOut = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_TIMEOUT_MIN\"",
      { SHIP_NOW_EPOCH: String(requestEpoch + 20 * 60) },
    );
    assert.equal(timedOut.stdout.trim(), "TIMEOUT,20");

    const pushGate = await run(
      baseState(),
      [
        "if ship_auto_fix_push_ready CLEAN PENDING FEEDBACK; then echo unsafe; else echo blocked; fi",
        "if ship_auto_fix_push_ready CLEAN FEEDBACK; then echo ready; else echo wrong; fi",
        "if ship_auto_fix_push_ready CLEAN TRIGGER_FAILED FEEDBACK; then echo unsafe; else echo failed-blocked; fi",
      ].join("\n"),
    );
    assert.equal(pushGate.stdout, "blocked\nready\nfailed-blocked\n");

    console.log("pr skill contract: ok");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
