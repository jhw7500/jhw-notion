#!/usr/bin/env node
// Consumer contract for canonical /jhw:pr review rounds and /jhw:ship alias.
// The canonical Markdown exposes executable Bash helpers; a stateful fake gh
// verifies trigger/current-round boundaries without touching GitHub.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const workflowNames = {
  "claude-code-review.yml": "Claude Code Review",
  "gemini-auto-review.yml": "Gemini Auto PR Review",
  "opencode-auto-review.yml": "OpenCode Auto PR Review",
};
const dispatchContract = "on:\n  workflow_dispatch:\n    inputs:\n      pr_number:\n      force_review:\n";
const fullReviewWorkflowContract = [
  "name: Review",
  "",
  "on:",
  "  pull_request:",
  "    types: [opened, synchronize, ready_for_review]",
  "  workflow_dispatch:",
  "    inputs:",
  "      pr_number:",
  "      force_review:",
  "",
].join("\n");

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

function collectorContractBlock(markdown) {
  const match = markdown.match(/\n(collect\(\) \{[\s\S]*?\n\})\ncollect\n/);
  assert.ok(match, "pr skill must expose one executable signal collector");
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

function reviewBody(item) {
  if (typeof item.body === "string") return item.body;
  if (typeof item.severity === "string") return item.severity + " finding";
  return item.blocking === true ? "P1 finding" : "Review completed.";
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
  const hasMetadata = argv.includes("--fill") || argv.includes("--fill-first") ||
    argv.includes("--fill-verbose") || (argv.includes("--title") && argv.includes("--body"));
  if (!argv.includes("--draft") || !hasMetadata || state.failPrCreate) process.exit(1);
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
  const metadata = {
    state: state.workflowStates[workflow],
    path: ".github/workflows/" + workflow,
    name: ${JSON.stringify(workflowNames)}[workflow],
    ...(state.workflowMetadata?.[workflow] || {}),
  };
  const jq = optionValue("--jq");
  if (jq !== undefined) {
    if (jq !== ".state") process.exit(2);
    process.stdout.write(String(metadata.state) + "\n");
  } else {
    process.stdout.write(JSON.stringify(metadata) + "\n");
  }
  process.exit(0);
}

const workflowContentMatch = endpoint.match(/^repos\/example\/repo\/contents\/\.github\/workflows\/([^/?]+)$/);
if (workflowContentMatch) {
  const workflow = decodeURIComponent(workflowContentMatch[1]);
  const content = state.remoteWorkflowContents?.[workflow];
  if (typeof content !== "string") process.exit(1);
  process.stdout.write(JSON.stringify({
    type: "file",
    path: ".github/workflows/" + workflow,
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
  }) + "\n");
  process.exit(0);
}

if (endpoint === "graphql") {
  if (!optionValue("-f") && !optionValue("-F")) process.exit(2);
  rows([
    ...(state.appReviews || []).map((item) => ({
      kind: "review",
      actor: item.actor.endsWith("[bot]") ? item.actor : item.actor + "[bot]",
      body: item.body,
      url: item.url,
    })),
    ...(state.appPrReactions || []).map((item) => ({
      kind: "reaction",
      actor: item.actor.endsWith("[bot]") ? item.actor : item.actor + "[bot]",
      content: item.content,
      url: item.url,
    })),
  ].map((item) => Buffer.from(JSON.stringify(item)).toString("base64")));
  process.exit(0);
}

if (endpoint === "repos/example/repo/issues/comments?per_page=100") {
  if (!argv.includes("--paginate") || argv.includes("--slurp")) process.exit(2);
  const query = optionValue("--jq") || "";
  if (query.includes("@tsv")) {
    if (!query.includes("head=[0-9a-f]{40}")) process.exit(2);
    const marker = query.includes("reviewer=gemini-assist")
      ? /<!-- jhw-pr:review-request reviewer=gemini-assist head=[0-9a-f]{40} -->/
      : /<!-- jhw-(?:pr:review-request reviewer=codex|(?:pr|ship):codex-review(?: round=[1-9][0-9]*)?) head=[0-9a-f]{40} -->/;
    rows((state.appRequestComments || [])
      .filter((item) => marker.test(item.body || ""))
      .map((item) => [item.id, item.url].join("\t")));
    process.exit(0);
  }
  if (!query.includes("@base64")) process.exit(2);
  const actors = [...query.matchAll(/\.user\.login == "([^"]+)"/g)].map((match) => match[1]);
  rows((state.appComments || [])
    .filter((item) => actors.length === 0 || actors.includes(item.actor))
    .map((item) => Buffer.from(JSON.stringify({
      kind: "comment",
      actor: item.actor,
      body: item.body,
      url: item.url,
    })).toString("base64")));
  process.exit(0);
}

if (endpoint === "repos/example/repo/pulls/comments?per_page=100") {
  if (!argv.includes("--paginate") || argv.includes("--slurp")) process.exit(2);
  const query = optionValue("--jq") || "";
  if (!query.includes("@base64")) process.exit(2);
  const actors = [...query.matchAll(/\.user\.login == "([^"]+)"/g)].map((match) => match[1]);
  rows((state.appPullComments || [])
    .filter((item) => actors.length === 0 || actors.includes(item.actor))
    .map((item) => Buffer.from(JSON.stringify({
      kind: "inline",
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
  const commentId = endpoint.match(/\/issues\/comments\/(\d+)\/reactions/)?.[1];
  const query = optionValue("--jq") || "";
  if (query.includes("@base64")) {
    rows((state.appCanaryReactions?.[commentId] || []).map((item) => Buffer.from(JSON.stringify({
      kind: "reaction",
      actor: item.actor,
      content: item.content,
    })).toString("base64")));
    process.exit(0);
  }
  if (!(optionValue("--jq") || "").includes("(.id | tostring)")) process.exit(2);
  rows(state.commentReactions.map((item, index) => [
    item.actor,
    item.id || 7000 + index,
    item.content,
    item.createdAt,
  ].join("\t")));
  process.exit(0);
}

if (/\/issues\/\d+\/reactions\?per_page=100$/.test(endpoint)) {
  if (!(optionValue("--jq") || "").includes("(.id | tostring)")) process.exit(2);
  rows(state.issueReactions.map((item, index) => [
    item.actor,
    item.id || 8000 + index,
    item.content,
    item.createdAt,
  ].join("\t")));
  process.exit(0);
}

if (/\/pulls\/\d+\/reviews\?per_page=100$/.test(endpoint)) {
  const query = optionValue("--jq") || "";
  if (!query.includes("@base64") || !query.includes("(.id | tostring)")) process.exit(2);
  rows(state.reviews.map((item, index) => [
    item.actor,
    item.id || 5000 + index,
    item.commitId,
    item.submittedAt,
    item.state || "COMMENTED",
    typeof item.bodyBase64 === "string" ? item.bodyBase64 : Buffer.from(reviewBody(item)).toString("base64"),
  ].join("\t")));
  process.exit(0);
}

if (/\/pulls\/\d+\/comments\?per_page=100$/.test(endpoint)) {
  const query = optionValue("--jq") || "";
  if (!query.includes("@base64") || !query.includes("(.id | tostring)")) process.exit(2);
  rows(state.pullComments.map((item, index) => [
    item.actor,
    item.id || 6000 + index,
    item.reviewId || 0,
    item.commitId,
    item.originalCommitId,
    item.createdAt,
    typeof item.bodyBase64 === "string" ? item.bodyBase64 : Buffer.from(reviewBody(item)).toString("base64"),
  ].join("\t")));
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
    appPullComments: [],
    appRequestComments: [],
    appCanaryReactions: {},
    appReviews: [],
    appPrReactions: [],
    remoteWorkflowContents: {
      "claude-code-review.yml": fullReviewWorkflowContract,
      "gemini-auto-review.yml": fullReviewWorkflowContract,
    },
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
  assert.match(
    aliasText,
    /Codex[\s\S]*\$jhw-pr[\s\S]*references\/pr\.md/,
    "Codex ship alias must resolve the canonical PR skill reference explicitly",
  );
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
  assert.match(
    prText,
    /jhw_pr_merge_reviewed_head "\$PR" "\$ROUND_HEAD" <merge\|squash\|rebase> "\$EFFECTIVE_REVIEW_POLICY" "\$\{ROUND_REVIEW_STATUSES\[@\]\}"/,
    "the documented merge path must pass effective policy and non-vacuous reviewer statuses",
  );
  assert.match(prText, /jhw_pr_prepare_review_plan "\$mode"/,
    "reviewer capability planning must run before PR policy mutation");
  assert.match(prText, /jhw_pr_request_eligible_apps "\$ROUND_HEAD"/,
    "the executable review flow must request only its preflighted App plan");
  assert.doesNotMatch(prText, /gh workflow view .*--json state/,
    "workflow state detection must not depend on unsupported gh workflow --json flags");
  const collectText = collectorContractBlock(prText);
  for (const endpoint of [
    'pulls/$PR/reviews?per_page=100',
    'pulls/$PR/comments?per_page=100',
    'issues/$PR/comments?per_page=100',
    'issues/$PR/reactions?per_page=100',
    'issues/comments/$SHIP_CODEX_REQUEST_COMMENT_ID/reactions?per_page=100',
    'actions/runs?head_sha=$SHA&per_page=100',
  ]) {
    assert.ok(collectText.includes(endpoint),
      `the signal collector must request a full page before paginating ${endpoint}`);
  }
  assert.equal((collectText.match(/--paginate/g) || []).length, 7,
    "every list request in the signal collector must paginate");
  assert.doesNotMatch(collectText, /\.\[0:200\]/,
    "review bodies must remain complete until terminal classification");
  assert.ok((collectText.match(/\| @base64/g) || []).length >= 3,
    "App review and comment bodies must use a lossless line-safe projection");
  assert.doesNotMatch(prText, /\/tmp\/jhw-pr-signals\.\$PR/,
    "full review bodies must not be written through a predictable shared-temp path");
  assert.match(prText, /ship_signal_file_prepare \|\| return/,
    "the polling loop must allocate a private signal snapshot");
  assert.match(prText, /ship_signal_cleanup_install/,
    "the private signal snapshot must have invocation-wide cleanup");
  assert.match(agentsText, /\| `pr\.md` \|/);
  assert.match(agentsText, /ship\.md.*deprecated/i);
  assert.match(readmeText, /\/jhw:pr --review/);
  assert.match(readmeText, /\/jhw:pr --no-review/);
  assert.match(readmeText, /\/jhw:pr --review --auto-fix/);
  assert.match(readmeText, /\/jhw:ship.*\/jhw:pr/);
    assert.match(readmeText, /생략.*review-on/);
    assert.match(readmeText, /mutation 전에.*workflow.*App canary/);
    assert.match(readmeText, /active 상태·고정 파일 경로·Actions 표시 이름/);
  assert.match(readmeText, /UNAVAILABLE.*mention하지 않는다/);
  assert.ok(existsSync(codexPrSkill), "generated Codex jhw-pr skill must exist");
  assert.ok(lstatSync(codexPrReference).isSymbolicLink(),
    "generated Codex jhw-pr reference must be a relative symlink");
  assert.match(await readFile(codexShipSkill, "utf8"), /deprecated/i);
  const contract = `${contractBlock(prText)}\n${policyContractBlock(prText)}\n${collectorContractBlock(prText)}`;
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

    const partialSignalCollection = await runResult(
      baseState({ failEndpoints: ["/pulls/42/comments"] }),
      "collect >/dev/null",
      { SHA: currentHead },
    );
    assert.notEqual(partialSignalCollection.code, 0,
      "one failed list endpoint must fail the whole signal snapshot");
    assert.equal(
      partialSignalCollection.log.some((args) => args[0] === "api" && args[1]?.includes("/actions/runs?")),
      false,
      "collection must stop rather than mask a partial snapshot with a later successful endpoint",
    );

    const privateSignal = await run(
      baseState(),
      "ship_signal_file_prepare || exit $?\nprintf '%s\\n' \"$SHIP_SIGNAL_FILE\"",
      { TMPDIR: tempRoot },
    );
    const privateSignalPath = privateSignal.stdout.trim();
    assert.equal(dirname(privateSignalPath), tempRoot);
    assert.match(privateSignalPath.split("/").at(-1), /^jhw-pr-signals\.[A-Za-z0-9]+$/);
    const privateSignalStat = lstatSync(privateSignalPath);
    assert.equal(privateSignalStat.isFile(), true);
    assert.equal(privateSignalStat.isSymbolicLink(), false);
    assert.equal(privateSignalStat.mode & 0o777, 0o600,
      "signal snapshots must be owner-readable and owner-writable only");
    await rm(privateSignalPath);

    const nounsetPrivateSignal = await run(
      baseState(),
      [
        "set -u",
        "ship_signal_file_prepare || exit $?",
        'printf "%s\\n" "$SHIP_SIGNAL_FILE"',
        'ship_signal_file_cleanup "$SHIP_SIGNAL_FILE" "$SHIP_SIGNAL_DIR" || exit $?',
      ].join("\n"),
      { TMPDIR: tempRoot },
    );
    assert.equal(existsSync(nounsetPrivateSignal.stdout.trim()), false,
      "signal-file preparation and cleanup must remain safe under caller nounset mode");

    const realSignalDir = join(tempRoot, "signal-real");
    const linkedSignalDir = join(tempRoot, "signal-link");
    await mkdir(realSignalDir);
    await mkdir(join(realSignalDir, "child"));
    await symlink(realSignalDir, linkedSignalDir, "dir");
    for (const configuredTmpDir of [
      linkedSignalDir,
      `${linkedSignalDir}/`,
      `${linkedSignalDir}//`,
      `${linkedSignalDir}///`,
      `${linkedSignalDir}/.`,
      `${linkedSignalDir}/child/..`,
      `${linkedSignalDir}/child/../`,
      `${linkedSignalDir}/child/../.`,
    ]) {
      const symlinkTempDir = await runResult(
        baseState(),
        "ship_signal_file_prepare",
        { TMPDIR: configuredTmpDir },
      );
      assert.notEqual(symlinkTempDir.code, 0,
        `an explicitly configured symlink TMPDIR must be rejected before snapshot creation: ${configuredTmpDir}`);
    }

    const systemAliasPolicy = await run(
      baseState(),
      [
        'ship_signal_dirs_match "/tmp" "/private/tmp" Darwin || exit $?',
        'ship_signal_dirs_match "/var/folders/ab/T" "/private/var/folders/ab/T" Darwin || exit $?',
        'ship_signal_dirs_match "/var/tmp" "/var/tmp" Linux || exit $?',
        'if ship_signal_dirs_match "/tmp/user-link" "/private/tmp/real-target" Darwin; then exit 1; fi',
        'if ship_signal_dirs_match "/var/folders/ab/T" "/private/var/folders/other/T" Darwin; then exit 1; fi',
        'if ship_signal_dirs_match "/var/folders/ab/T" "/private/var/folders/ab/T" Linux; then exit 1; fi',
        "printf 'trusted-system-alias-only\\n'",
      ].join("\n"),
    );
    assert.equal(systemAliasPolicy.stdout, "trusted-system-alias-only\n",
      "only exact macOS /tmp and /var physical aliases may bypass logical-path equality");

    const trappedSignal = await runResult(
      baseState(),
      [
        "ship_signal_file_prepare || exit $?",
        "ship_signal_cleanup_install",
        'printf "%s\\n" "$SHIP_SIGNAL_FILE"',
        "exit 7",
      ].join("\n"),
      { TMPDIR: tempRoot },
    );
    assert.equal(trappedSignal.code, 7);
    assert.equal(existsSync(trappedSignal.stdout.trim()), false,
      "the invocation-wide EXIT trap must remove the private signal snapshot");

    const callerExitMarker = join(tempRoot, "caller-exit-status");
    const chainedExit = await runResult(
      baseState(),
      [
        "trap 'printf \"%s\\n\" \"$?\" > \"$CALLER_EXIT_MARKER\"' EXIT",
        "ship_signal_file_prepare || exit $?",
        "ship_signal_cleanup_install || exit $?",
        'printf "%s\\n" "$SHIP_SIGNAL_FILE"',
        "exit 7",
      ].join("\n"),
      { TMPDIR: tempRoot, CALLER_EXIT_MARKER: callerExitMarker },
    );
    assert.equal(chainedExit.code, 7);
    assert.equal(existsSync(chainedExit.stdout.trim()), false);
    assert.equal(await readFile(callerExitMarker, "utf8"), "7\n",
      "the invocation cleanup must chain the caller EXIT trap with its original status");

    const restoredCallerTraps = await run(
      baseState(),
      [
        "trap ':' EXIT",
        "trap ':' HUP",
        "trap ':' INT",
        "trap ':' TERM",
        'before_exit="$(trap -p EXIT)"',
        'before_hup="$(trap -p HUP)"',
        'before_int="$(trap -p INT)"',
        'before_term="$(trap -p TERM)"',
        "ship_signal_file_prepare || exit $?",
        "ship_signal_cleanup_install || exit $?",
        "ship_signal_cleanup_finish || exit $?",
        '[[ "$(trap -p EXIT)" == "$before_exit" ]] || exit 1',
        '[[ "$(trap -p HUP)" == "$before_hup" ]] || exit 1',
        '[[ "$(trap -p INT)" == "$before_int" ]] || exit 1',
        '[[ "$(trap -p TERM)" == "$before_term" ]] || exit 1',
        "trap - EXIT HUP INT TERM",
        "printf 'restored\\n'",
      ].join("\n"),
      { TMPDIR: tempRoot },
    );
    assert.equal(restoredCallerTraps.stdout, "restored\n",
      "snapshot cleanup must restore every caller-owned trap");

    for (const [signal, expectedCode] of [["HUP", 129], ["INT", 130], ["TERM", 143]]) {
      const signaledSnapshot = await runResult(
        baseState(),
        [
          "ship_signal_file_prepare || exit $?",
          'printf "%s\\n" "$SHIP_SIGNAL_FILE"',
          "ship_signal_cleanup_install || exit $?",
          `kill -${signal} "$$"`,
          "exit 99",
        ].join("\n"),
        { TMPDIR: tempRoot },
      );
      assert.equal(signaledSnapshot.code, expectedCode,
        `${signal} must retain its conventional non-success exit status`);
      assert.equal(existsSync(signaledSnapshot.stdout.trim()), false,
        `${signal} must remove the private signal snapshot`);
    }

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

    const reviewSurfaceCanaries = await run(
      baseState({
        appComments: [],
        appPullComments: [{
          actor: "chatgpt-codex-connector[bot]",
          body: "[P2] Review comment delivered.",
          url: "https://github.com/example/repo/pull/88#discussion_r123",
        }],
        appReviews: [{
          actor: "gemini-code-assist",
          body: "Gemini review completed without blocking findings.",
          url: "https://github.com/example/repo/pull/88#pullrequestreview-456",
        }],
      }),
      "jhw_pr_discover_app_reviewers",
    );
    assert.equal(reviewSurfaceCanaries.stdout, "codex\ngemini-assist\n",
      "inline comments and PR reviews are valid same-repository App canary surfaces");

    const codexReviewOnlyCanary = await run(
      baseState({
        appComments: [],
        appReviews: [{
          actor: "chatgpt-codex-connector",
          body: "Codex review completed with suggestions.",
          url: "https://github.com/example/repo/pull/89#pullrequestreview-457",
        }],
      }),
      "jhw_pr_repo_has_app_canary codex",
    );
    assert.equal(codexReviewOnlyCanary.stdout.trim(), "chatgpt-codex-connector[bot]",
      "GraphQL Bot identities must normalize to the REST identity used by round polling");

    const cleanPrReactionCanary = await run(
      baseState({
        appComments: [],
        appPrReactions: [{
          actor: "chatgpt-codex-connector",
          content: "+1",
          url: "https://github.com/example/repo/pull/90",
        }],
      }),
      "jhw_pr_repo_has_app_canary codex",
    );
    assert.equal(cleanPrReactionCanary.stdout.trim(), "chatgpt-codex-connector[bot]",
      "a clean reaction on a recent PR is a normal Codex capability surface");

    const cleanReactionCanary = await run(
      baseState({
        appComments: [],
        appRequestComments: [{
          id: 7001,
          url: "https://github.com/example/repo/pull/88#issuecomment-7001",
          body: genericCodexBody,
        }],
        appCanaryReactions: {
          7001: [{ actor: "chatgpt-codex-connector[bot]", content: "+1" }],
        },
      }),
      "jhw_pr_repo_has_app_canary codex",
    );
    assert.equal(cleanReactionCanary.stdout.trim(), "chatgpt-codex-connector[bot]",
      "a clean reaction on a prior head-scoped request must prove Codex capability");

    const unscopedReactionCanary = await runResult(
      baseState({
        appComments: [],
        appRequestComments: [{
          id: 7002,
          url: "https://github.com/example/repo/pull/88#issuecomment-7002",
          body: "@codex review\n\n<!-- jhw-pr:review-request reviewer=codex -->",
        }],
        appCanaryReactions: {
          7002: [{ actor: "chatgpt-codex-connector[bot]", content: "+1" }],
        },
      }),
      "jhw_pr_repo_has_app_canary codex",
    );
    assert.notEqual(unscopedReactionCanary.code, 0,
      "a reaction without a valid head-scoped request marker cannot prove capability");

    const unbracketedCodex = await run(
      baseState({
        appComments: [{
          actor: "chatgpt-codex-connector",
          body: "Codex review completed without blockers.",
          url: "https://github.com/example/repo/pull/88#issuecomment-3",
        }],
        commentReactions: [{
          actor: "chatgpt-codex-connector",
          content: "+1",
          createdAt: requestCreatedAt,
        }],
      }),
      [
        "jhw_pr_prepare_review_plan request",
        `jhw_pr_request_eligible_apps ${currentHead} "$JHW_PR_ELIGIBLE_APPS"`,
        "ship_codex_signal_status",
        "printf 'eligible=%s\\nactor=%s\\nship=%s\\nstatus=%s\\n' \"$JHW_PR_ELIGIBLE_APPS\" \"$JHW_PR_CODEX_APP_ACTOR\" \"$SHIP_CODEX_LOGIN\" \"$SHIP_CODEX_REVIEW_STATUS\"",
      ].join("\n"),
    );
    assert.match(unbracketedCodex.stdout, /^eligible=codex$/m,
      "the unbracketed Codex App identity must be eligible when it is the unique canary actor");
    assert.match(unbracketedCodex.stdout, /^actor=chatgpt-codex-connector$/m);
    assert.match(unbracketedCodex.stdout, /^ship=chatgpt-codex-connector$/m,
      "the canary-proven actor must be propagated into current-round signal matching");
    assert.match(unbracketedCodex.stdout, /^status=CLEAN$/m);

    const wrongSpellingAfterPin = await run(
      baseState({
        appComments: [{
          actor: "chatgpt-codex-connector",
          body: "Codex review completed without blockers.",
          url: "https://github.com/example/repo/pull/88#issuecomment-3",
        }],
        commentReactions: [{
          actor: "chatgpt-codex-connector[bot]",
          content: "+1",
          createdAt: requestCreatedAt,
        }],
      }),
      [
        "jhw_pr_prepare_review_plan request",
        `jhw_pr_request_eligible_apps ${currentHead} "$JHW_PR_ELIGIBLE_APPS"`,
        "ship_codex_signal_status",
        "printf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      ].join("\n"),
    );
    assert.equal(wrongSpellingAfterPin.stdout.trim(), "PENDING",
      "a different accepted Codex spelling cannot replace the uniquely proven canary actor");

    const ambiguousCodexActors = await run(
      baseState({
        appComments: [
          {
            actor: "chatgpt-codex-connector",
            body: "Codex review completed.",
            url: "https://github.com/example/repo/pull/87#issuecomment-1",
          },
          {
            actor: "chatgpt-codex-connector[bot]",
            body: "Codex review completed.",
            url: "https://github.com/example/repo/pull/88#issuecomment-2",
          },
        ],
      }),
      "jhw_pr_prepare_review_plan request\nprintf 'eligible=%s\\nactor=%s\\n' \"$JHW_PR_ELIGIBLE_APPS\" \"$JHW_PR_CODEX_APP_ACTOR\"",
    );
    assert.doesNotMatch(ambiguousCodexActors.stdout, /^eligible=.*codex/m,
      "ambiguous Codex canary identities must not be guessed");
    assert.match(ambiguousCodexActors.stdout, /^actor=$/m);

    const failedCodexCanary = await run(
      baseState({
        appComments: [
          {
            actor: "chatgpt-codex-connector[bot]",
            body: "Connector failed to start the review.",
            url: "https://github.com/example/repo/pull/88#issuecomment-4",
          },
          {
            actor: "gemini-code-assist[bot]",
            body: "Gemini review completed.",
            url: "https://github.com/example/repo/pull/88#issuecomment-5",
          },
        ],
      }),
      "jhw_pr_prepare_review_plan request\nprintf '%s\\n' \"$JHW_PR_ELIGIBLE_APPS\"",
    );
    assert.equal(failedCodexCanary.stdout.trim(), "gemini-assist",
      "a canary comment reporting connector failure cannot prove Codex capability");

    const failedGeminiCanary = await run(
      baseState({
        appComments: [
          {
            actor: "chatgpt-codex-connector[bot]",
            body: "Codex review completed without blockers.",
            url: "https://github.com/example/repo/pull/88#issuecomment-4",
          },
          {
            actor: "gemini-code-assist[bot]",
            body: "Unable to review because usage limits were reached.",
            url: "https://github.com/example/repo/pull/88#issuecomment-5",
          },
        ],
      }),
      "jhw_pr_prepare_review_plan request\nprintf '%s\\n' \"$JHW_PR_ELIGIBLE_APPS\"",
    );
    assert.equal(failedGeminiCanary.stdout.trim(), "codex",
      "a Gemini canary reporting review failure cannot prove App capability");

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

    const missingRemoteAutoEvent = await run(
      baseState({
        remoteWorkflowContents: {
          "claude-code-review.yml": dispatchContract,
          "gemini-auto-review.yml": fullReviewWorkflowContract,
        },
      }),
      [
        "jhw_pr_prepare_review_plan auto",
        "printf 'available=%s\\nunavailable=%s\\n' \"$JHW_PR_AVAILABLE_WORKFLOWS\" \"$JHW_PR_UNAVAILABLE_WORKFLOWS\"",
      ].join("\n"),
    );
    const autoAvailable = missingRemoteAutoEvent.stdout.slice(
      0,
      missingRemoteAutoEvent.stdout.indexOf("unavailable="),
    );
    assert.doesNotMatch(autoAvailable, /claude-code-review\.yml/,
      "an auto workflow without a default-branch pull_request contract cannot be available");
    assert.match(
      missingRemoteAutoEvent.stdout,
      /claude-code-review\.yml\tworkflow_event_contract_unsupported/,
    );

    const incompleteRemoteAutoActions = await run(
      baseState({
        remoteWorkflowContents: {
          "claude-code-review.yml": fullReviewWorkflowContract.replace(
            "types: [opened, synchronize, ready_for_review]",
            "types: [opened]",
          ),
          "gemini-auto-review.yml": fullReviewWorkflowContract,
        },
      }),
      [
        "jhw_pr_prepare_review_plan auto",
        "printf 'available=%s\\nunavailable=%s\\n' \"$JHW_PR_AVAILABLE_WORKFLOWS\" \"$JHW_PR_UNAVAILABLE_WORKFLOWS\"",
      ].join("\n"),
    );
    assert.match(
      incompleteRemoteAutoActions.stdout,
      /claude-code-review\.yml\tworkflow_event_contract_unsupported/,
      "auto workflows must cover opened, synchronize, and ready_for_review",
    );

    const implicitPullRequestContracts = [
      ["scalar", "name: Review\n\non: pull_request\n"],
      ["flow list", "name: Review\n\non: [pull_request]\n"],
      ["empty block", "name: Review\n\non:\n  pull_request:\n"],
      ["empty map", "name: Review\n\non:\n  pull_request: {}\n"],
    ];
    for (const [shape, content] of implicitPullRequestContracts) {
      const implicitContract = await run(
        baseState({
          remoteWorkflowContents: {
            "claude-code-review.yml": content,
            "gemini-auto-review.yml": fullReviewWorkflowContract,
          },
        }),
        [
          "jhw_pr_prepare_review_plan auto",
          "printf 'available=%s\\nunavailable=%s\\n' \"$JHW_PR_AVAILABLE_WORKFLOWS\" \"$JHW_PR_UNAVAILABLE_WORKFLOWS\"",
        ].join("\n"),
      );
      assert.match(
        implicitContract.stdout,
        /claude-code-review\.yml\tworkflow_event_contract_unsupported/,
        `${shape} pull_request uses GitHub default activities and cannot prove ready_for_review`,
      );
    }

    for (const quote of ['"', "'"]) {
      const duplicateOnContract = await run(
        baseState({
          remoteWorkflowContents: {
            "claude-code-review.yml": `${fullReviewWorkflowContract}${quote}on${quote}: push\n`,
            "gemini-auto-review.yml": fullReviewWorkflowContract,
          },
        }),
        [
          "jhw_pr_prepare_review_plan auto",
          "printf 'available=%s\\nunavailable=%s\\n' \"$JHW_PR_AVAILABLE_WORKFLOWS\" \"$JHW_PR_UNAVAILABLE_WORKFLOWS\"",
        ].join("\n"),
      );
      assert.match(
        duplicateOnContract.stdout,
        /claude-code-review\.yml\tworkflow_event_contract_unsupported/,
        `${quote}on${quote} must not bypass duplicate top-level event detection`,
      );
    }

    const workflowMetadataDrift = [
      ["name", { name: "Renamed Review" }],
      ["path", { path: ".github/workflows/renamed-review.yml" }],
    ];
    for (const [field, metadata] of workflowMetadataDrift) {
      const mismatchedWorkflow = await run(
        baseState({
          workflowMetadata: { "claude-code-review.yml": metadata },
        }),
        [
          "jhw_pr_prepare_review_plan request",
          "printf 'available=%s\\nunavailable=%s\\n' \"$JHW_PR_AVAILABLE_WORKFLOWS\" \"$JHW_PR_UNAVAILABLE_WORKFLOWS\"",
        ].join("\n"),
      );
      assert.match(
        mismatchedWorkflow.stdout,
        /claude-code-review\.yml\tworkflow_identity_mismatch/,
        `remote workflow ${field} drift must fail before review-policy mutation`,
      );
    }

    const missingRemoteDispatchInput = await run(
      baseState({
        remoteWorkflowContents: {
          "claude-code-review.yml": fullReviewWorkflowContract.replace("      force_review:\n", ""),
          "gemini-auto-review.yml": fullReviewWorkflowContract,
        },
      }),
      [
        "jhw_pr_prepare_review_plan request",
        "printf 'available=%s\\nunavailable=%s\\n' \"$JHW_PR_AVAILABLE_WORKFLOWS\" \"$JHW_PR_UNAVAILABLE_WORKFLOWS\"",
      ].join("\n"),
    );
    assert.match(
      missingRemoteDispatchInput.stdout,
      /claude-code-review\.yml\tworkflow_event_contract_unsupported/,
      "manual workflow dispatch must be supported by the default-branch contract",
    );

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
    assert.equal(newPr.log.some((args) => createDraft(args) && args.includes("--fill")), true,
      "new PR creation must supply noninteractive title/body metadata");
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

    const priorRoundSameHeadWorkflow = await run(
      baseState({
        runs: [
          {
            id: 9306,
            attempt: 1,
            name: "Claude Code Review",
            head: currentHead,
            createdAt: "2026-08-28T23:59:59Z",
            status: "completed",
            conclusion: "success",
            event: "workflow_dispatch",
          },
        ],
      }),
      [
        `jhw_pr_dispatch_same_head claude-code-review.yml 'Claude Code Review' ${currentHead}`,
        "printf '%s,%s\n' \"$JHW_PR_WORKFLOW_REQUEST_STATUS\" \"$JHW_PR_WORKFLOW_RUN_ID\"",
      ].join("\n"),
    );
    assert.equal(priorRoundSameHeadWorkflow.stdout.trim(), "DISPATCHED,");
    assert.equal(priorRoundSameHeadWorkflow.log.filter(isWorkflowDispatch).length, 1,
      "a same-head workflow run from an earlier round must not suppress the current dispatch");

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

    const renamedWorkflow = await run(
      baseState({
        workflowMetadata: { "claude-code-review.yml": { name: "Renamed Review" } },
      }),
      [
        `jhw_pr_dispatch_same_head claude-code-review.yml 'Claude Code Review' ${currentHead}`,
        "printf '%s,%s\n' \"$JHW_PR_WORKFLOW_REQUEST_STATUS\" \"$JHW_PR_WORKFLOW_REQUEST_REASON\"",
      ].join("\n"),
    );
    assert.equal(renamedWorkflow.stdout.trim(), "UNAVAILABLE,workflow_identity_mismatch");
    assert.equal(renamedWorkflow.log.filter(isWorkflowDispatch).length, 0,
      "a renamed workflow must not be dispatched under a stale run name");

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

    const emptyReviewMerge = await runResult(
      baseState({ prHead: currentHead }),
      `jhw_pr_merge_reviewed_head 42 ${currentHead} merge request`,
    );
    assert.notEqual(emptyReviewMerge.code, 0,
      "explicit review must not merge when no reviewer reached CLEAN");
    assert.equal(emptyReviewMerge.state.prMerged, false);

    const noEligibleReviewMerge = await runResult(
      baseState({
        prHead: currentHead,
        workflowStates: {
          "claude-code-review.yml": "disabled_manually",
          "gemini-auto-review.yml": "disabled_manually",
          "opencode-auto-review.yml": "disabled_manually",
        },
        appComments: [],
        appPullComments: [],
        appRequestComments: [],
        appReviews: [],
        appPrReactions: [],
      }),
      [
        "jhw_pr_prepare_review_plan request",
        "printf 'available=%s\\neligible=%s\\n' \"$JHW_PR_AVAILABLE_WORKFLOWS\" \"$JHW_PR_ELIGIBLE_APPS\"",
        `jhw_pr_merge_reviewed_head 42 ${currentHead} merge request`,
      ].join("\n"),
    );
    assert.notEqual(noEligibleReviewMerge.code, 0);
    assert.match(noEligibleReviewMerge.stdout, /^available=$/m);
    assert.match(noEligibleReviewMerge.stdout, /^eligible=$/m);
    assert.equal(noEligibleReviewMerge.state.prMerged, false,
      "an all-unavailable preflight must not become a vacuous CLEAN merge");
    assert.equal(
      noEligibleReviewMerge.log.some((args) => args[0] === "pr" && args[1] === "merge"),
      false,
    );

    const nonCleanReviewMerge = await runResult(
      baseState({ prHead: currentHead }),
      `jhw_pr_merge_reviewed_head 42 ${currentHead} merge request CLEAN UNAVAILABLE`,
    );
    assert.notEqual(nonCleanReviewMerge.code, 0,
      "every planned reviewer status must be CLEAN before merge");
    assert.equal(nonCleanReviewMerge.state.prMerged, false);

    const autoDisabledMerge = await runResult(
      baseState({ prHead: currentHead }),
      `jhw_pr_merge_reviewed_head 42 ${currentHead} merge auto=false`,
    );
    assert.notEqual(autoDisabledMerge.code, 0,
      "auto=false must require an explicit --no-review exemption before merge");
    assert.equal(autoDisabledMerge.state.prMerged, false);

    const atomicMerge = await run(
      baseState({ prHead: currentHead }),
      `jhw_pr_merge_reviewed_head 42 ${currentHead} merge request CLEAN CLEAN`,
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
      `jhw_pr_merge_reviewed_head 42 ${currentHead} merge request CLEAN`,
    );
    assert.notEqual(mergeRace.code, 0,
      "a remote head change immediately before merge must reject the merge atomically");
    assert.equal(mergeRace.state.prMerged, false);

    const explicitSkipMerge = await run(
      baseState({ prHead: currentHead }),
      `jhw_pr_merge_reviewed_head 42 ${currentHead} merge skip`,
    );
    assert.equal(explicitSkipMerge.state.prMerged, true,
      "explicit --no-review remains the sole zero-review merge exemption");

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

    const parseableMalformedRequestTimestamp = await run(
      baseState({
        issueComments: [{
          id: 16,
          actor: "jhw7500",
          createdAt: "1970-01-01",
          body: requestBody,
        }],
      }),
      "ship_codex_trigger\nprintf '%s,%s\\n' \"$SHIP_CODEX_TRIGGER_STATUS\" \"$SHIP_CODEX_TRIGGER_REASON\"",
    );
    assert.equal(parseableMalformedRequestTimestamp.stdout.trim(), "TRIGGER_FAILED,invalid_request_timestamp",
      "a parseable non-RFC3339 request timestamp must fail before signal collection");

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

    const sameSecondUnscopedReaction = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        issueReactions: [{
          id: 8201,
          actor: "chatgpt-codex-connector[bot]",
          content: "+1",
          createdAt: requestCreatedAt,
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      { SHIP_NOW_EPOCH: String(requestEpoch + 300) },
    );
    assert.equal(sameSecondUnscopedReaction.stdout.trim(), "PENDING",
      "a PR-root reaction from the request timestamp second is not request-scoped and must remain pending");

    const laterUnscopedReaction = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        issueReactions: [{
          id: 8202,
          actor: "chatgpt-codex-connector[bot]",
          content: "+1",
          createdAt: "2026-08-29T00:02:01Z",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(laterUnscopedReaction.stdout.trim(), "CLEAN",
      "a PR-root reaction from a strictly later timestamp second remains valid");

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

    for (const [surface, artifacts] of [
      ["review", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Unable to review this pull request because the usage limit was reached.",
        }],
      }],
      ["inline comment", {
        pullComments: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "2026-08-29T00:03:00Z",
          body: "The connector failed to review this change.",
        }],
      }],
      ["direct cannot-review response", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Cannot review this pull request because the provider is unavailable.",
        }],
      }],
      ["environment-creation response", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Codex could not create an environment for this review.",
        }],
      }],
      ["passive provider failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review could not be completed because the provider is unavailable.",
        }],
      }],
      ["standalone failed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review failed.",
        }],
      }],
      ["standalone unavailable status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review unavailable.",
        }],
      }],
      ["standalone not-performed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review not performed.",
        }],
      }],
      ["passive not-performed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "The review was not performed.",
        }],
      }],
      ["plural-actor failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "We were unable to review this pull request because the provider is unavailable.",
        }],
      }],
      ["present-perfect failed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "The review has failed.",
        }],
      }],
      ["qualified passive not-performed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "The review was not performed in this run.",
        }],
      }],
      ["present-perfect not-performed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review has not been performed.",
        }],
      }],
      ["contracted not-performed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "This review hasn't been performed.",
        }],
      }],
      ["numbered pull-request target failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Could not review PR #101 because the provider is unavailable.",
        }],
      }],
      ["environment-qualified unavailable status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review unavailable in this environment.",
        }],
      }],
      ["no-review passive status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "No review was performed.",
        }],
      }],
      ["not-able actor failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "We were not able to review this pull request.",
        }],
      }],
      ["indefinite-article passive status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "A review was not performed.",
        }],
      }],
      ["not-completed passive status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "The review was not completed.",
        }],
      }],
      ["present-perfect not-completed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "The review has not been completed.",
        }],
      }],
      ["comma-qualified failed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review failed, so no findings are available.",
        }],
      }],
      ["bare connector unavailable status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Connector unavailable.",
        }],
      }],
      ["connector-error unavailable status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Connector error: unavailable.",
        }],
      }],
      ["connector-error quota status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Connector error: quota exceeded.",
        }],
      }],
      ["retry-qualified failed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review failed, please retry.",
        }],
      }],
      ["retry-qualified connector status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Connector unavailable; retry later.",
        }],
      }],
      ["comma-before-cause failed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review failed, because the provider is unavailable.",
        }],
      }],
      ["semicolon-retry failed status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review failed; please retry later.",
        }],
      }],
      ["semicolon-quota action failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Unable to review this PR; quota reached.",
        }],
      }],
      ["semicolon-retry connector failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Connector unavailable; please retry.",
        }],
      }],
      ["processing-review connector failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "The connector returned an error while processing the review.",
        }],
      }],
      ["review-start connector failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "The connector returned an error before the review could start.",
        }],
      }],
      ["review-setup connector failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Connector errored during review setup.",
        }],
      }],
      ["contracted-actor usage-limit failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "You've reached your usage limit.",
        }],
      }],
      ["contracted-actor quota failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "We've hit the quota.",
        }],
      }],
      ["environment-creation failure status", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Environment creation failed.",
        }],
      }],
      ["articleless environment-creation failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Failed to create environment.",
        }],
      }],
      ["definite-article environment-creation failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Could not create the environment.",
        }],
      }],
      ["emphasized review failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "**Review failed**.",
        }],
      }],
      ["emphasized inline failure", {
        pullComments: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "2026-08-29T00:03:00Z",
          body: "- **Unable to review this PR**.",
        }],
      }],
      ["triple-emphasized review failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "***Review failed***.",
        }],
      }],
      ["emphasized sentence with retry failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "**Review failed.** Please retry later.",
        }],
      }],
      ["emphasized status with external retry failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "**Review failed**, please retry later.",
        }],
      }],
      ["nested-quote emphasized failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "> - **Review failed**.",
        }],
      }],
      ["underscored emphasized action failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "__Unable to review this PR.__ Please retry later.",
        }],
      }],
      ["smart-apostrophe passive failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "This review hasn’t been performed.",
        }],
      }],
      ["smart-apostrophe actor failure", {
        pullComments: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "2026-08-29T00:03:00Z",
          body: "We couldn’t review this PR because the provider is unavailable.",
        }],
      }],
      ["task-list emphasized review failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "- [x] **Review failed**.",
        }],
      }],
      ["nested numbered task-list action failure", {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "> 1. [x] __Unable to review this PR__.",
        }],
      }],
      ["unchecked task-list unavailable failure", {
        pullComments: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "2026-08-29T00:03:00Z",
          body: "- [ ] Review unavailable.",
        }],
      }],
      ...[
        "I'm unable to review this PR because the provider is unavailable.",
        "I’m unable to review this PR because the provider is unavailable.",
        "We're unable to review this PR because the connector failed.",
        "We’re unable to review this PR because the connector failed.",
        "I've failed to review this PR because the usage limit was reached.",
        "I’ve failed to review this PR because the usage limit was reached.",
        "We aren't able to review this PR because the provider is unavailable.",
        "We aren’t able to review this PR because the provider is unavailable.",
        "I haven't been able to review this PR because the provider is unavailable.",
        "I haven’t been able to review this PR because the provider is unavailable.",
        "We haven't been able to review this PR because the connector failed.",
        "We haven’t been able to review this PR because the connector failed.",
        "I hadn't been able to review this PR because the usage limit was reached.",
        "I hadn’t been able to review this PR because the usage limit was reached.",
        "I haven't yet been able to review this PR because the provider is unavailable.",
        "We haven’t yet been able to review this PR because the connector failed.",
        "I haven't been able to review this PR yet because the provider is unavailable.",
        "We haven’t been able to review this PR yet due to the connector being unavailable.",
      ].map((body, index) => [`actor-contraction failure ${index + 1}`, {
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body,
        }],
      }]),
    ]) {
      const failedArtifact = await run(
        baseState({
          issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
          ...artifacts,
        }),
        [
          "ship_codex_trigger",
          "ship_codex_signal_status",
          "printf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
        ].join("\n"),
      );
      assert.equal(failedArtifact.stdout.trim(), "FAILED,reviewer_response_failed",
        `a current-head Codex ${surface} that reports provider failure must fail closed`);
    }

    for (const body of [
      "No usage limits were encountered. No P1 findings.",
      "The connector-unavailable error path is correctly tested. No P1 findings.",
      "Review completed without connector errors. No P1 findings.",
      "The connector failed test now passes. No P1 findings.",
      "Unable to review handling is tested. No P1 findings.",
      "The connector failed to review path is covered. No P1 findings.",
      "We verified the case where Codex failed to review this PR is handled safely. No P1 findings.",
      "We verified behavior when Codex hit the usage limit. No P1 findings.",
      "Connector error: review fallback is covered. No P1 findings.",
      "Connector error: failed test is now covered. No P1 findings.",
      "Review failed: regression handling is now covered. No P1 findings.",
      "Connector unavailable: fallback handling is now covered. No P1 findings.",
      "The connector returned an error before review testing, and that case now passes. No P1 findings.",
      "The connector returned an error because the test exercises that branch; the current review is clean. No P1 findings.",
      "**Review failed.** This is the regression fixture; the current review completed successfully. No P1 findings.",
    ]) {
      const discussedFailureTerm = await run(
        baseState({
          issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
          reviews: [{
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            body,
          }],
        }),
        "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      );
      assert.equal(discussedFailureTerm.stdout.trim(), "CLEAN",
        `ordinary successful review prose must not look like a provider failure: ${body}`);
    }

    const olderFailureNewerClean = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [
          {
            id: 5202,
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:04:00Z",
            body: "No P1 findings.",
          },
          {
            id: 5201,
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            body: "Review failed, please retry.",
          },
        ],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
    );
    assert.equal(olderFailureNewerClean.stdout.trim(), "CLEAN,",
      "a newer successful current-head review must supersede an older transient provider failure");

    const olderFailureNewerPositive = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          id: 5203,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review failed, please retry.",
        }],
        commentReactions: [{
          id: 7201,
          actor: "chatgpt-codex-connector[bot]",
          content: "+1",
          createdAt: "2026-08-29T00:04:00Z",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
    );
    assert.equal(olderFailureNewerPositive.stdout.trim(), "CLEAN,",
      "a newer request-scoped positive reaction must supersede an older transient provider failure");

    const olderCleanNewerFailure = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [
          {
            id: 5204,
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            body: "No P1 findings.",
          },
          {
            id: 5205,
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:04:00Z",
            body: "Review failed, please retry.",
          },
        ],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
    );
    assert.equal(olderCleanNewerFailure.stdout.trim(), "FAILED,reviewer_response_failed",
      "a newer provider failure must supersede an older successful review");

    const sameEndpointSameSecond = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [
          {
            id: 5212,
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            body: "No P1 findings.",
          },
          {
            id: 5211,
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            body: "Review failed, please retry.",
          },
        ],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
    );
    assert.equal(sameEndpointSameSecond.stdout.trim(), "CLEAN,",
      "same-endpoint, same-second responses must use the safe numeric id as a deterministic tiebreaker");

    const crossEndpointSameSecond = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          id: 5213,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review failed, please retry.",
        }],
        commentReactions: [{
          id: 7202,
          actor: "chatgpt-codex-connector[bot]",
          content: "+1",
          createdAt: "2026-08-29T00:03:00Z",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
    );
    assert.equal(crossEndpointSameSecond.stdout.trim(), "FAILED,signal_order_ambiguous",
      "conflicting cross-endpoint signals in the same timestamp second must fail closed");

    for (const [label, reviewBodyText, reviewAt, eyesAt, expected] of [
      ["newer eyes after clean", "No P1 findings.", "2026-08-29T00:03:00Z", "2026-08-29T00:04:00Z", "CLEAN,"],
      ["newer eyes after failure", "Review failed, please retry.", "2026-08-29T00:03:00Z", "2026-08-29T00:04:00Z", "FAILED,reviewer_response_failed"],
      ["same-second eyes and clean", "No P1 findings.", "2026-08-29T00:03:00Z", "2026-08-29T00:03:00Z", "CLEAN,"],
      ["older eyes before clean", "No P1 findings.", "2026-08-29T00:04:00Z", "2026-08-29T00:03:00Z", "CLEAN,"],
    ]) {
      const acknowledgmentCannotOverrideTerminal = await run(
        baseState({
          issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
          reviews: [{
            id: 5220,
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: reviewAt,
            body: reviewBodyText,
          }],
          commentReactions: [{
            id: 7220,
            actor: "chatgpt-codex-connector[bot]",
            content: "eyes",
            createdAt: eyesAt,
          }],
        }),
        "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
      );
      assert.equal(acknowledgmentCannotOverrideTerminal.stdout.trim(), expected,
        `a non-terminal eyes acknowledgment must not override terminal review evidence: ${label}`);
    }

    for (const [label, artifacts] of [
      ["review id", {
        reviews: [{
          id: "invalid-id",
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "Review failed, please retry.",
        }],
      }],
      ["review timestamp", {
        reviews: [{
          id: 5231,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "not-a-timestamp",
          body: "Review failed, please retry.",
        }],
      }],
      ["parseable non-RFC3339 review timestamp", {
        reviews: [{
          id: 5232,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "1970-01-01",
          body: "Review failed, please retry.",
        }],
      }],
      ["inline-comment timestamp", {
        pullComments: [{
          id: 6231,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "not-a-timestamp",
          body: "Review failed, please retry.",
        }],
      }],
      ["issue-reaction timestamp", {
        issueReactions: [{
          id: 8231,
          actor: "chatgpt-codex-connector[bot]",
          content: "-1",
          createdAt: "not-a-timestamp",
        }],
      }],
    ]) {
      const malformedSignalWithNewerClean = await run(
        baseState({
          issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
          commentReactions: [{
            id: 7231,
            actor: "chatgpt-codex-connector[bot]",
            content: "+1",
            createdAt: "2026-08-29T00:04:00Z",
          }],
          ...artifacts,
        }),
        "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
      );
      assert.equal(malformedSignalWithNewerClean.stdout.trim(), "FAILED,signal_contract_invalid",
        `malformed in-scope ${label} metadata must fail closed even when a newer clean signal exists`);
    }

    const negatedPriorityReview = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "No P1 findings.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(negatedPriorityReview.stdout.trim(), "CLEAN",
      "an explicitly negated Codex priority must not become a blocker");

    const negatedPriorityInline = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        pullComments: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "2026-08-29T00:03:00Z",
          body: "No P0/P1 issues.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(negatedPriorityInline.stdout.trim(), "CLEAN",
      "negated priority lists in inline comments must remain non-blocking");

    const negatedSeverityReview = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "No [HIGH] or P1 issues.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(negatedSeverityReview.stdout.trim(), "CLEAN",
      "a negated mixed severity/priority list must remain non-blocking");

    const correctedNegations = [
      "No P1 findings is incorrect.",
      "The earlier claim “No P1 findings” is false.",
      "It is not true that there are no P1 blockers.",
      "No P1 issues, except the migration can lose data.",
    ];
    for (const body of correctedNegations) {
      const correctedNegation = await run(
        baseState({
          issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
          reviews: [{
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            body,
          }],
        }),
        "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      );
      assert.equal(correctedNegation.stdout.trim(), "FEEDBACK",
        `a corrected or qualified negation must preserve its blocker: ${body}`);
    }

    const adjacentCorrections = [
      "No P1 findings. Correction: that statement is false.",
      "No P1 findings.\nThis conclusion is incorrect.",
      "No P1 findings. However, one blocking data-loss issue remains.",
      "No P1 findings. Correction: one issue remains.",
      "No P1 findings. However, an authentication bypass remains.",
      "No P1 findings. Except one race remains.",
      "No P1 findings. **Correction:** one issue remains.",
      "No P1 findings. **However,** an authentication bypass remains.",
      "No P1 findings. _Correction:_ one race remains.",
      "No P1 findings. **Correction**: one issue remains.",
      "No P1 findings. *However*: an authentication bypass remains.",
      "No P1 findings. _Correction: one race remains._",
      "No P1 findings. *However, an authentication bypass remains.*",
      "No P1 findings. **Correction: one issue remains**.",
    ];
    for (const body of adjacentCorrections) {
      const adjacentCorrection = await run(
        baseState({
          issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
          reviews: [{
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            body,
          }],
        }),
        "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      );
      assert.equal(adjacentCorrection.stdout.trim(), "FEEDBACK",
        `an adjacent correction must revoke the clean sentence: ${body}`);
    }

    const lowerPriorityQualification = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "No P1 findings. However, only P2 suggestions remain.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(lowerPriorityQualification.stdout.trim(), "CLEAN",
      "an explicit lower-priority qualification must not revoke a valid P1 clean sentence");

    const emphasizedLowerPriorityQualification = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "No P1 findings. **However,** only P2 suggestions remain.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(emphasizedLowerPriorityQualification.stdout.trim(), "CLEAN",
      "Markdown emphasis must not change a lower-priority-only qualification");

    const italicCleanSentence = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "_No P1 findings._",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(italicCleanSentence.stdout.trim(), "CLEAN",
      "single-emphasis around an explicit clean sentence must not create a blocker");

    const italicCleanSentenceWithOuterPunctuation = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "_No P1 findings_.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(italicCleanSentenceWithOuterPunctuation.stdout.trim(), "CLEAN",
      "punctuation outside single emphasis must remain part of the clean sentence");

    const shouldFixP3Qualification = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "No P2 findings. However, only P3 suggestions remain.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      { SHIP_BLOCK_ON: "should-fix" },
    );
    assert.equal(shouldFixP3Qualification.stdout.trim(), "CLEAN",
      "the should-fix threshold may retain an explicit P3-only qualification");

    const neutralQuotedExample = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "A P2 parser note may use `No P1 findings` as a non-actionable example.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(neutralQuotedExample.stdout.trim(), "CLEAN",
      "a negated priority quoted only as inline-code documentation must not become a blocker");

    const correctedInlineCodeNegations = [
      "Correction: `No P1 findings`; one issue remains.",
      "Correction: `No P1 findings` was the old assessment; one issue remains.",
      "However, `No P1 findings`; an authentication bypass remains.",
      "The prior output was `No P1 findings`. Correction: one issue remains.",
    ];
    for (const body of correctedInlineCodeNegations) {
      const correctedInlineCode = await run(
        baseState({
          issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
          reviews: [{
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            body,
          }],
        }),
        "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
      );
      assert.equal(correctedInlineCode.stdout.trim(), "FEEDBACK",
        `a correction must preserve its inline-code priority evidence: ${body}`);
    }

    const inlineCodeWithLowerPriorityQualification = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "The prior output was `No P1 findings`. However, only P2 suggestions remain.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(inlineCodeWithLowerPriorityQualification.stdout.trim(), "CLEAN",
      "an adjacent lower-priority-only qualification must keep inline-code documentation non-blocking");

    const negatedThenAffirmative = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          body: "No P1 findings, but P0 data-loss behavior remains.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(negatedThenAffirmative.stdout.trim(), "FEEDBACK",
      "a negated label must not hide a separate affirmative blocker");

    for (const [shape, bodyBase64] of [["invalid base64", "%%%"], ["invalid UTF-8", "/w=="]]) {
      const malformedReviewBody = await run(
        baseState({
          issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
          reviews: [{
            actor: "chatgpt-codex-connector[bot]",
            commitId: currentHead,
            submittedAt: "2026-08-29T00:03:00Z",
            bodyBase64,
          }],
        }),
        [
          "ship_codex_trigger",
          "ship_codex_signal_status",
          "printf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
        ].join("\n"),
      );
      assert.equal(malformedReviewBody.stdout.trim(), "FAILED,signal_contract_invalid",
        `${shape} review bodies must fail closed`);
    }

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

    const dismissedBlockingReview = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          id: 5101,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          state: "DISMISSED",
          blocking: true,
        }],
        pullComments: [{
          reviewId: 5101,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "2026-08-29T00:03:01Z",
          blocking: true,
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(dismissedBlockingReview.stdout.trim(), "CLEAN",
      "a dismissed current-head review and its linked inline findings are no longer open blockers");

    const dismissedFailureReview = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          id: 5103,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          state: "DISMISSED",
          body: "Unable to review because usage limits were reached.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
    );
    assert.equal(dismissedFailureReview.stdout.trim(), "FAILED,reviewer_response_failed",
      "dismissing a provider-failure artifact must not turn it into a successful response");

    const dismissedLinkedFailure = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          id: 5104,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          state: "DISMISSED",
          body: "Review completed.",
        }],
        pullComments: [{
          reviewId: 5104,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "2026-08-29T00:03:01Z",
          body: "Unable to review because usage limits were reached.",
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s,%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\" \"$SHIP_CODEX_REVIEW_REASON\"",
    );
    assert.equal(dismissedLinkedFailure.stdout.trim(), "FAILED,reviewer_response_failed",
      "dismissing a review must suppress linked findings, not linked provider-failure evidence");

    const activeLinkedInline = await run(
      baseState({
        issueComments: [{ id: 9002, actor: "jhw7500", createdAt: requestCreatedAt, body: requestBody }],
        reviews: [{
          id: 5102,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          submittedAt: "2026-08-29T00:03:00Z",
          state: "COMMENTED",
          blocking: false,
        }],
        pullComments: [{
          reviewId: 5102,
          actor: "chatgpt-codex-connector[bot]",
          commitId: currentHead,
          originalCommitId: currentHead,
          createdAt: "2026-08-29T00:03:01Z",
          blocking: true,
        }],
      }),
      "ship_codex_trigger\nship_codex_signal_status\nprintf '%s\\n' \"$SHIP_CODEX_REVIEW_STATUS\"",
    );
    assert.equal(activeLinkedInline.stdout.trim(), "FEEDBACK",
      "an inline finding linked to an active review must remain blocking");

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
