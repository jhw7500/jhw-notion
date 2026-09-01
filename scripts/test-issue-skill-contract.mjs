#!/usr/bin/env node
// Consumer contract for the canonical /jhw:issue review-aware creation flow.
// The embedded Bash contract runs against a stateful fake gh only.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalIssue = join(repoRoot, "skills", "claude", "issue.md");
const installSafetyPath = join(repoRoot, "scripts", "test-install-safety.sh");
const agentsPath = join(repoRoot, "skills", "claude", "AGENTS.md");
const readmePath = join(repoRoot, "README.md");
const codexIssueSkill = join(repoRoot, "skills", "codex", "jhw-issue", "SKILL.md");
const codexIssueReference = join(repoRoot, "skills", "codex", "jhw-issue", "references", "issue.md");
const claudeWorkflowPath = join(repoRoot, ".github", "workflows", "claude.yml");
const geminiWorkflowPath = join(repoRoot, ".github", "workflows", "gemini-dispatch.yml");
const requestScopedRunName = "run-name: jhw-review-comment-${{ github.event.comment.id || github.run_id }}";
const issueCreatedAt = "2026-09-01T00:00:00Z";
const requestCreatedAt = "2026-09-01T00:01:00Z";
const requestEpoch = Date.parse(requestCreatedAt) / 1000;

function createContractBlock(markdown) {
  const match = markdown.match(
    /<!-- issue-review-create-contract:begin -->\n```bash\n([\s\S]*?)```\n<!-- issue-review-create-contract:end -->/,
  );
  assert.ok(match, "issue skill must expose an executable review-create contract");
  return match[1];
}

function waitContractBlock(markdown) {
  const match = markdown.match(
    /<!-- issue-review-wait-contract:begin -->\n```bash\n([\s\S]*?)```\n<!-- issue-review-wait-contract:end -->/,
  );
  assert.ok(match, "issue skill must expose an executable review-wait contract");
  return match[1];
}

const fakeGhSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.FAKE_GH_STATE;
const logPath = process.env.FAKE_GH_LOG;
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(logPath, JSON.stringify(argv) + "\n");

if (argv.includes("--slurp") && (argv.includes("--jq") || argv.includes("--template"))) {
  process.exit(1);
}

function save() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function rows(values) {
  if (values.length > 0) process.stdout.write(values.join("\n") + "\n");
}

function optionValue(...names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index >= 0) return argv[index + 1];
  }
  return undefined;
}

if (argv[0] === "repo" && argv[1] === "view") {
  const query = optionValue("--jq", "-q") || "";
  if (query === ".viewerPermission") process.stdout.write(state.viewerPermission + "\n");
  else if (query === ".nameWithOwner") process.stdout.write(state.repo + "\n");
  else process.exit(2);
  process.exit(0);
}

if (argv[0] === "label" && argv[1] === "list") {
  rows(state.labels);
  process.exit(0);
}

if (argv[0] === "label" && argv[1] === "create") {
  if (state.failLabelCreate) process.exit(1);
  const name = argv[2];
  if (!state.labels.includes(name)) state.labels.push(name);
  state.mutations.push("label:create:" + name);
  save();
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "create") {
  if (state.failIssueCreate) process.exit(1);
  state.issueExists = true;
  state.issueTitle = optionValue("--title") || "";
  state.issueBody = optionValue("--body") || "";
  state.issueLabels = [];
  state.mutations.push("issue:create");
  save();
  process.stdout.write(state.issueUrl + "\n");
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "view") {
  if (!state.issueExists) process.exit(1);
  const query = optionValue("--jq", "-q") || "";
  if (query === ".number") process.stdout.write(String(state.issueNumber) + "\n");
  else if (query === ".url") process.stdout.write(state.issueUrl + "\n");
  else if (query === ".createdAt") {
    if (state.failIssueCreatedAtRead) process.exit(1);
    process.stdout.write(state.issueCreatedAt + "\n");
  }
  else if (query === ".title") process.stdout.write(state.issueTitle + "\n");
  else if (query.includes(".labels")) rows(state.issueLabels);
  else process.exit(2);
  process.exit(0);
}

if (argv[0] === "issue" && argv[1] === "edit") {
  if (!state.issueExists || state.failIssueEdit) process.exit(1);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--remove-label") {
      state.issueLabels = state.issueLabels.filter((name) => name !== argv[index + 1]);
    }
    if (argv[index] === "--add-label" && !state.issueLabels.includes(argv[index + 1])) {
      state.issueLabels.push(argv[index + 1]);
    }
  }
  state.mutations.push("issue:edit");
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

const workflowMatch = endpoint.match(/^repos\/example\/repo\/actions\/workflows\/([^/?]+)$/);
if (workflowMatch) {
  const workflow = decodeURIComponent(workflowMatch[1]);
  const stateValue = state.workflowStates?.[workflow];
  if (!stateValue) process.exit(1);
  process.stdout.write(JSON.stringify({
    state: stateValue,
    path: ".github/workflows/" + workflow,
    name: workflow === "claude.yml" ? "Claude Code" : "Gemini Dispatch",
  }) + "\n");
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

const commentMatch = endpoint.match(/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments\?per_page=100$/);
if (commentMatch) {
  const issueNumber = Number(commentMatch[1]);
  const comments = issueNumber === state.issueNumber ? state.issueComments : state.canaryComments;
  const commentPages = issueNumber === state.issueNumber && state.issueCommentPages
    ? state.issueCommentPages
    : [comments];
  const allComments = commentPages.flat();
  if (argv.includes("POST")) {
    if (issueNumber !== state.issueNumber || state.failCommentPost) process.exit(1);
    const fieldIndex = argv.indexOf("-f");
    const bodyArg = fieldIndex >= 0 ? argv[fieldIndex + 1] : "";
    const body = bodyArg.startsWith("body=") ? bodyArg.slice(5) : "";
    const requestedReviewer = body.match(/jhw-issue:review-request reviewer=([a-z-]+)/)?.[1] || "";
    if ((state.failCommentReviewers || []).includes(requestedReviewer)) process.exit(1);
    const comment = {
      id: state.nextCommentId++,
      actor: state.actor,
      createdAt: state.requestCreatedAt,
      body,
      url: state.issueUrl + "#issuecomment-" + state.nextCommentId,
    };
    state.issueComments.push(comment);
    state.mutations.push("comment:post");
    save();
    process.stdout.write(String(comment.id) + "\t" + comment.createdAt + "\n");
    process.exit(0);
  }

  const query = optionValue("--jq", "-q") || "";
  if (argv.includes("--slurp") && query === "") {
    process.stdout.write(JSON.stringify(commentPages.map((page) => page.map((item) => ({
      id: item.id,
      user: {
        login: item.actor,
        type: item.actorType || (item.actor.endsWith("[bot]") ? "Bot" : "User"),
      },
      created_at: item.createdAt,
      body: item.body,
      html_url: item.url || "",
    })))) + "\n");
    process.exit(0);
  }
  if (query.includes("actor:.user.login")) {
    const mapComment = (item) => ({
      id: item.id,
      actor: item.actor,
      actor_type: item.actorType || (item.actor.endsWith("[bot]") ? "Bot" : "User"),
      created_at: item.createdAt,
      body: item.body,
      url: item.url || "",
    });
    if (argv.includes("--slurp")) {
      process.stdout.write(JSON.stringify(allComments.map(mapComment)) + "\n");
    } else {
      rows(commentPages.map((page) => JSON.stringify(page.map(mapComment))));
    }
    process.exit(0);
  }
  if (query.includes("[.id, .user.login, .created_at, .html_url") && query.includes("test(")) {
    const failurePattern = /usage limits?|quota[^\n]*(?:reached|hit|exceeded|exhausted)|(?:provider|environment)[^\n]*(?:unavailable|failed|errored)|create an environment|unable to review|cannot review|failed to (?:start|review)|connector[^\n]*(?:fail|error|unavailable|reject)/i;
    rows(allComments.map((item) => [
      item.id,
      item.actor,
      item.createdAt,
      item.url || "",
      failurePattern.test(item.body || "") ? "false" : "true",
    ].join("\t")));
    process.exit(0);
  }
  if (query.includes("[.id, .user.login, .created_at, .html_url]")) {
    rows(allComments.map((item) => [item.id, item.actor, item.createdAt, item.url || ""].join("\t")));
    process.exit(0);
  }
  if (query.includes("[.user.login, .created_at, .html_url]")) {
    rows(allComments.map((item) => [item.actor, item.createdAt, item.url || ""].join("\t")));
    process.exit(0);
  }
  const actor = query.match(/\.user\.login == "([^"]+)"/)?.[1];
  const markers = [...query.matchAll(/contains\("([^"]+)"\)/g)].map((match) => match[1]);
  const matching = allComments.filter((item) =>
    (!actor || item.actor === actor) &&
    (markers.length === 0 || markers.some((marker) => item.body.includes(marker))));
  rows(matching.map((item) => String(item.id) + "\t" + item.createdAt));
  process.exit(0);
}

if (/\/issues\/comments\/\d+\/reactions\?per_page=100$/.test(endpoint)) {
  const query = optionValue("--jq", "-q") || "";
  if (argv.includes("--slurp") && query === "") {
    process.stdout.write(JSON.stringify([state.commentReactions.map((item) => ({
      user: {
        login: item.actor,
        type: item.actorType || (item.actor.endsWith("[bot]") ? "Bot" : "User"),
      },
      content: item.content,
      created_at: item.createdAt,
      html_url: item.url || "",
    }))]) + "\n");
    process.exit(0);
  }
  if (!query.includes("{actor:.user.login")) process.exit(2);
  process.stdout.write(JSON.stringify(state.commentReactions.map((item) => ({
    actor: item.actor,
    content: item.content,
    created_at: item.createdAt,
    url: item.url || "",
  }))) + "\n");
  process.exit(0);
}

if (endpoint === "repos/example/repo/actions/runs") {
  const query = optionValue("--jq", "-q") || "";
  const fields = argv.reduce((values, value, index) => {
    if (value === "-f" || value === "-F") values.push(argv[index + 1]);
    return values;
  }, []);
  if (!argv.includes("--method") || optionValue("--method") !== "GET" ||
      !fields.includes("per_page=100") || !fields.includes("event=issue_comment") ||
      !fields.includes("actor=" + state.actor) ||
      !fields.includes("created=>=" + state.issueCreatedAt)) process.exit(2);
  if (argv.includes("--slurp") && query === "") {
    process.stdout.write(JSON.stringify([{ workflow_runs: state.runs.map((item) => ({
      id: item.id,
      name: item.name,
      event: item.event,
      status: item.status,
      conclusion: item.conclusion,
      created_at: item.createdAt,
      html_url: item.url || "",
      display_title: item.displayTitle || "",
      actor: { login: item.actor || "" },
      triggering_actor: { login: item.triggeringActor || "" },
    })) }]) + "\n");
    process.exit(0);
  }
  if (!query.includes("{id, name:.name")) process.exit(2);
  process.stdout.write(JSON.stringify(state.runs.map((item) => ({
    id: item.id,
    name: item.name,
    event: item.event,
    status: item.status,
    conclusion: item.conclusion,
    created_at: item.createdAt,
    url: item.url || "",
    display_title: item.displayTitle || "",
    actor: item.actor || "",
    triggering_actor: item.triggeringActor || "",
  }))) + "\n");
  process.exit(0);
}

process.stderr.write("unexpected fake gh command: " + argv.join(" ") + "\n");
process.exit(2);
`;

const fakeDateSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.length === 3 && process.argv[2] === "+%s") {
  process.stdout.write(fs.readFileSync(process.env.FAKE_DATE_EPOCH_FILE, "utf8").trim() + "\n");
  process.exit(0);
}
process.exit(1);
`;

const fakeSleepSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const value = process.argv[2] || "";
if (!/^[1-9][0-9]*$/.test(value)) process.exit(1);
const seconds = Number(value);
const current = Number(fs.readFileSync(process.env.FAKE_DATE_EPOCH_FILE, "utf8").trim());
fs.writeFileSync(process.env.FAKE_DATE_EPOCH_FILE, String(current + seconds));
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(["sleep", value]) + "\n");
`;

const fakeGitSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(["git", ...argv]) + "\n");
if (argv[0] === "rev-parse" && argv[1] === "--show-toplevel") {
  process.stdout.write(process.env.FAKE_GIT_TOPLEVEL + "\n");
  process.exit(0);
}
process.exit(2);
`;

function issueState(overrides = {}) {
  return {
    actor: "jhw7500",
    repo: "example/repo",
    viewerPermission: "WRITE",
    labels: [],
    issueExists: false,
    issueLabels: [],
    issueNumber: 99,
    issueUrl: "https://github.com/example/repo/issues/99",
    issueTitle: "Review this",
    issueCreatedAt,
    requestCreatedAt,
    issueComments: [],
    canaryComments: [],
    commentReactions: [],
    runs: [],
    workflowStates: {
      "claude.yml": "active",
      "gemini-dispatch.yml": "active",
    },
    remoteWorkflowContents: {
      "claude.yml": `name: Claude Code\n${requestScopedRunName}\n\non:\n  issue_comment:\n    types: [created]\n`,
      "gemini-dispatch.yml": `name: Gemini Dispatch\n${requestScopedRunName}\n\non:\n  issue_comment:\n    types: [created]\n`,
    },
    mutations: [],
    nextCommentId: 1001,
    failEndpoints: [],
    failCommentReviewers: [],
    ...overrides,
  };
}

async function main() {
  const issueText = await readFile(canonicalIssue, "utf8");
  const installSafetyText = await readFile(installSafetyPath, "utf8");
  const agentsText = await readFile(agentsPath, "utf8");
  const readmeText = await readFile(readmePath, "utf8");
  assert.match(issueText, /^description: "GitHub 이슈 생성 · --review 지원 리뷰어 요청·대기·요약 · --no-review 리뷰 생략 · --timeout 대기한도"/m);
  assert.match(issueText, /^argument-hint: "\[title\/body\] \[--review\|--no-review\] \[--timeout <min>\]"/m);
  assert.match(
    installSafetyText,
    /test-pr-skill-contract\.mjs"\nnode "\$REPO_ROOT\/scripts\/test-issue-skill-contract\.mjs"/,
  );
  assert.match(agentsText, /\| `issue\.md` \|/);
  assert.match(readmeText, /\/jhw:issue .*--review.*--timeout 20/);
  assert.match(readmeText, /\/jhw:issue .*--no-review/);
  assert.match(readmeText, /\/jhw:issue <내용>\s+— 저장소 review\.auto를 따름/);
  assert.match(readmeText, /Codex.*동일 저장소.*canary/);
  assert.match(readmeText, /Gemini Assist.*OpenCode.*PR-only/);
  assert.match(readmeText, /Issue를 수정·닫기.*구현/);
  assert.match(issueText, /gemini\) command='@gemini-cli /,
    "standalone Issue requests must use the pinned Gemini dispatcher command");
  assert.doesNotMatch(issueText, /gemini\) command='@gemini /,
    "the unsupported @gemini command must not be emitted");
  assert.match(issueText, /workflow_name='Claude Code'/);
  assert.match(issueText, /workflow_name='Gemini Dispatch'/);
  assert.match(issueText, /jhw_issue_execute\(\)/,
    "the public Issue command must connect creation to bounded review waiting");
  assert.doesNotMatch(issueText, /JHW_ISSUE_(?:COMMENT|REACTION|RUN)_PAGES_JSON=/,
    "raw paginated payloads must not cross the exec environment boundary");
  assert.doesNotMatch(issueText, /JHW_ISSUE_SIGNAL_JSON/,
    "the compact signal snapshot must not cross the exec environment boundary");
  assert.ok(existsSync(codexIssueSkill));
  assert.ok(lstatSync(codexIssueReference).isSymbolicLink());
  for (const workflowPath of [claudeWorkflowPath, geminiWorkflowPath]) {
    const workflowText = await readFile(workflowPath, "utf8");
    assert.equal(
      workflowText.split(/\r?\n/).filter((line) => line === requestScopedRunName).length,
      1,
      `${workflowPath}: Issue-comment runs must expose the triggering comment ID in display_title`,
    );
  }
  const contract = `${createContractBlock(issueText)}\n${waitContractBlock(issueText)}`;

  const tempRoot = await mkdtemp(join(tmpdir(), "jhw-issue-contract-"));
  const fakeGh = join(tempRoot, "gh");
  const fakeDate = join(tempRoot, "date");
  const fakeSleep = join(tempRoot, "sleep");
  const fakeGit = join(tempRoot, "git");
  const contractPath = join(tempRoot, "contract.bash");
  const statePath = join(tempRoot, "gh-state.json");
  const logPath = join(tempRoot, "gh-log.jsonl");
  const summaryStatePath = join(tempRoot, "jhw-issue.summary.state");
  const nowEpochPath = join(tempRoot, "now-epoch");
  const fixtureRoot = join(tempRoot, "repo");
  const fixtureNestedDir = join(fixtureRoot, "nested", "cwd");
  const workflowDir = join(fixtureRoot, ".github", "workflows");
  const configPath = join(fixtureRoot, ".github", "workflow-config.yml");

  await writeFile(fakeGh, fakeGhSource);
  await chmod(fakeGh, 0o755);
  await writeFile(fakeDate, fakeDateSource);
  await chmod(fakeDate, 0o755);
  await writeFile(fakeSleep, fakeSleepSource);
  await chmod(fakeSleep, 0o755);
  await writeFile(fakeGit, fakeGitSource);
  await chmod(fakeGit, 0o755);
  await writeFile(contractPath, contract);

  async function setRepoFixture({ claude = false, gemini = false, config = "" } = {}) {
    await rm(join(fixtureRoot, ".github"), { recursive: true, force: true });
    await mkdir(workflowDir, { recursive: true });
    await mkdir(fixtureNestedDir, { recursive: true });
    if (claude) await writeFile(join(workflowDir, "claude.yml"), "name: Claude\n");
    if (gemini) await writeFile(join(workflowDir, "gemini-dispatch.yml"), "name: Gemini\n");
    if (config !== null) await writeFile(configPath, config);
  }

  async function runIssue(state, commands, overrides = {}) {
    const {
      FAKE_DATE_INITIAL_EPOCH = requestEpoch,
      JHW_TEST_CWD,
      ...envOverrides
    } = overrides;
    await writeFile(statePath, JSON.stringify(state, null, 2));
    await writeFile(logPath, "");
    await writeFile(nowEpochPath, String(FAKE_DATE_INITIAL_EPOCH));
    const env = {
      ...process.env,
      PATH: `${tempRoot}:${process.env.PATH}`,
      FAKE_GH_STATE: statePath,
      FAKE_GH_LOG: logPath,
      FAKE_DATE_EPOCH_FILE: nowEpochPath,
      FAKE_GIT_TOPLEVEL: fixtureRoot,
      REPO_NWO: "example/repo",
      JHW_ISSUE_REPO_ROOT: fixtureRoot,
      JHW_ISSUE_CONFIG_PATH: configPath,
      JHW_ISSUE_TIMEOUT_MIN: "20",
      JHW_ISSUE_CODEX_CANARY_URL: "",
      JHW_ISSUE_STATE_DIR: tempRoot,
      JHW_ISSUE_STATE_FILE: summaryStatePath,
      ...envOverrides,
    };
    const script = `source ${JSON.stringify(contractPath)}\n${commands}`;
    const result = await execFileAsync("bash", ["-c", script], {
      env,
      cwd: JHW_TEST_CWD,
      maxBuffer: 1024 * 1024,
    });
    return {
      code: 0,
      ...result,
      state: JSON.parse(await readFile(statePath, "utf8")),
      log: (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
    };
  }

  async function runIssueResult(state, commands, overrides = {}) {
    try {
      return await runIssue(state, commands, overrides);
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
    assert.equal((await runIssue(issueState(), "jhw_issue_review_mode_from_args --review")).stdout.trim(), "request");
    assert.equal((await runIssue(issueState(), "jhw_issue_review_mode_from_args --no-review")).stdout.trim(), "skip");
    assert.equal((await runIssue(issueState(), "jhw_issue_review_mode_from_args")).stdout.trim(), "auto");
    const conflict = await runIssueResult(
      issueState(),
      "jhw_issue_review_mode_from_args --review --no-review",
    );
    assert.notEqual(conflict.code, 0);
    assert.deepEqual(conflict.state.mutations, []);

    assert.notEqual((await runIssueResult(issueState(), "jhw_issue_validate_timeout 0")).code, 0);
    assert.notEqual((await runIssueResult(issueState(), "jhw_issue_validate_timeout 1.5")).code, 0);
    assert.equal((await runIssue(issueState(), "jhw_issue_validate_timeout 20")).stdout.trim(), "20");

    await setRepoFixture({ config: "review:\n  auto: true\n" });
    assert.equal((await runIssue(issueState(), `jhw_issue_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "true");
    await setRepoFixture({ config: "review:\n  auto: false\n" });
    assert.equal((await runIssue(issueState(), `jhw_issue_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "false");
    await setRepoFixture({ config: "workflows: {}\n" });
    assert.equal((await runIssue(issueState(), `jhw_issue_global_auto_enabled ${JSON.stringify(configPath)}`)).stdout.trim(), "true");
    await setRepoFixture({ config: "review:\n  auto: yes\n" });
    assert.notEqual((await runIssueResult(issueState(), `jhw_issue_global_auto_enabled ${JSON.stringify(configPath)}`)).code, 0);

    await setRepoFixture({ config: "review:\n  auto: true\nworkflows: {}\n" });
    const noEligible = await runIssueResult(
      issueState(),
      `jhw_issue_create 'A title' 'A body' request 20`,
    );
    assert.notEqual(noEligible.code, 0);
    assert.deepEqual(noEligible.state.mutations, [
      "label:create:review:request",
      "label:create:review:skip",
    ], "fixed label definitions may be ensured, but explicit review must stop before Issue creation");
    assert.equal(noEligible.log.some((args) => args[0] === "issue" && args[1] === "create"), false);

    await setRepoFixture({
      claude: true,
      gemini: true,
      config: [
        "review:",
        "  auto: true",
        "workflows:",
        "  claude:",
        "    enabled: true",
        "  gemini-dispatch:",
        "    enabled: true",
        "",
      ].join("\n"),
    });
    const reviewed = await runIssue(
      issueState(),
      `jhw_issue_create 'Review this' 'Body text' request 20`,
    );
    assert.equal(reviewed.stdout.trim(), "https://github.com/example/repo/issues/99");
    assert.deepEqual(reviewed.state.issueLabels, ["review:request"]);
    assert.deepEqual(
      reviewed.state.issueComments.map((item) => item.body),
      [
        "@claude 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=claude -->",
        "@gemini-cli 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=gemini -->",
      ],
    );
    assert.deepEqual(reviewed.state.mutations, [
      "label:create:review:request",
      "label:create:review:skip",
      "issue:create",
      "issue:edit",
      "comment:post",
      "comment:post",
    ]);

    const metadataFailure = await runIssueResult(
      issueState({ failIssueCreatedAtRead: true }),
      `jhw_issue_create 'Review this' 'Body text' request 20`,
    );
    assert.notEqual(metadataFailure.code, 0);
    assert.equal(
      metadataFailure.stdout.split("\n")[0],
      "https://github.com/example/repo/issues/99",
      "a created Issue URL must be emitted before fallible metadata reads",
    );
    assert.equal(metadataFailure.state.issueExists, true);
    assert.equal(metadataFailure.state.mutations.includes("issue:edit"), false,
      "metadata failure after creation must not mutate the Issue further");

    await setRepoFixture({ config: "review:\n  auto: false\nworkflows: {}\n" });
    const skipped = await runIssue(
      issueState({ labels: ["review:request", "review:skip"] }),
      `jhw_issue_create 'Skip review' 'Body text' skip 20`,
    );
    assert.deepEqual(skipped.state.issueLabels, ["review:skip"]);
    assert.equal(skipped.state.issueComments.length, 0);

    const autoDisabled = await runIssue(
      issueState({ labels: ["review:request", "review:skip"] }),
      `jhw_issue_create 'Auto disabled' 'Body text' auto 20`,
    );
    assert.deepEqual(autoDisabled.state.issueLabels, []);
    assert.equal(autoDisabled.state.issueComments.length, 0);

    const autoNoLabels = await runIssue(
      issueState({ labels: ["review:request", "review:skip"] }),
      `jhw_issue_create 'Auto no labels' 'Body text' auto 20`,
    );
    assert.deepEqual(autoNoLabels.state.issueLabels, [],
      "auto mode must succeed when the new Issue has no override labels");

    await setRepoFixture({
      claude: true,
      config: "review:\n  auto: true\nworkflows:\n  claude:\n    enabled: true\n",
    });
    const oneEligible = await runIssue(
      issueState({ labels: ["review:request", "review:skip"] }),
      `jhw_issue_create 'One reviewer' 'Body text' request 20`,
    );
    assert.equal(oneEligible.state.issueComments.length, 1,
      "one eligible reviewer must allow creation even when other reviewers are unavailable");
    assert.match(oneEligible.state.issueComments[0].body, /reviewer=claude/);

    await setRepoFixture({
      claude: true,
      gemini: true,
      config: [
        "review:",
        "  auto: false",
        "workflows:",
        "  claude:",
        "    enabled: true",
        "  gemini-dispatch:",
        "    enabled: true",
        "",
      ].join("\n"),
    });
    const nestedDiscovery = await runIssue(
      issueState(),
      [
        "unset JHW_ISSUE_REPO_ROOT JHW_ISSUE_CONFIG_PATH",
        "printf 'root=%s\\n' \"$(jhw_issue_repo_root)\"",
        "printf 'auto=%s\\n' \"$(jhw_issue_global_auto_enabled)\"",
        "printf 'explicit-auto=%s\\n' \"$(jhw_issue_global_auto_enabled \"$(jhw_issue_repo_root)/.github/workflow-config.yml\")\"",
        "jhw_issue_discover_reviewers request true ''",
      ].join("\n"),
      { JHW_TEST_CWD: fixtureNestedDir },
    );
    assert.equal(
      nestedDiscovery.stdout,
      `root=${fixtureRoot}\nauto=false\nexplicit-auto=false\nclaude\ngemini\n`,
      "Issue workflow discovery must resolve files from the Git top-level when invoked below it");
    assert.ok(nestedDiscovery.log.some((args) =>
      args[0] === "git" && args[1] === "rev-parse" && args[2] === "--show-toplevel"));

    await setRepoFixture({ config: "review:\n  auto: true\nworkflows: {}\n" });
    const canaryUrl = "https://github.com/example/repo/issues/77";
    const canaryRequest = {
      id: 7001,
      actor: "jhw7500",
      createdAt: "2026-09-01T00:00:00Z",
      body: "@codex 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=codex -->",
      url: `${canaryUrl}#issuecomment-7001`,
    };
    const canaryResponse = {
      id: 7002,
      actor: "chatgpt-codex-connector[bot]",
      createdAt: "2026-09-01T00:01:00Z",
      body: "Reviewed requirements.",
      url: `${canaryUrl}#issuecomment-7002`,
    };
    const codexDiscovery = await runIssue(
      issueState({ canaryComments: [canaryRequest, canaryResponse] }),
      "jhw_issue_discover_reviewers request true",
      { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
    );
    assert.equal(codexDiscovery.stdout.trim(), "codex");
    const bracketedCanaryIdentity = await runIssue(
      issueState({ canaryComments: [canaryRequest, canaryResponse] }),
      `jhw_issue_codex_canary_eligible '${canaryUrl}'`,
    );
    assert.equal(bracketedCanaryIdentity.stdout.trim(), "chatgpt-codex-connector[bot]",
      "successful canary proof must return the unique actor identity it authenticated");
    const sameSecondCanaryIdentity = await runIssue(
      issueState({
        canaryComments: [
          canaryRequest,
          { ...canaryResponse, createdAt: canaryRequest.createdAt },
        ],
      }),
      `jhw_issue_codex_canary_eligible '${canaryUrl}'`,
    );
    assert.equal(sameSecondCanaryIdentity.stdout.trim(), "chatgpt-codex-connector[bot]",
      "a later comment ID must prove ordering when GitHub timestamps share one second");
    const nonLaterSameSecondCanary = await runIssueResult(
      issueState({
        canaryComments: [
          canaryRequest,
          { ...canaryResponse, id: 7000, createdAt: canaryRequest.createdAt },
        ],
      }),
      `jhw_issue_codex_canary_eligible '${canaryUrl}'`,
    );
    assert.notEqual(nonLaterSameSecondCanary.code, 0,
      "a same-second comment without a later ID cannot prove request ordering");
    const codexOnly = await runIssue(
      issueState({
        labels: ["review:request", "review:skip"],
        canaryComments: [canaryRequest, canaryResponse],
      }),
      [
        `jhw_issue_create 'Codex review' 'Body text' request 20`,
        "printf 'expected=%s\\n' \"$JHW_ISSUE_EXPECTED_CODEX_BOT\"",
      ].join("\n"),
      { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
    );
    assert.equal(codexOnly.state.issueComments.length, 1);
    assert.equal(
      codexOnly.state.issueComments[0].body,
      "@codex 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=codex -->",
    );
    assert.match(codexOnly.stdout, /expected=chatgpt-codex-connector\[bot\]/,
      "Issue creation must propagate the canary-proven actor into later classification");

    const unbracketedCanaryResponse = {
      ...canaryResponse,
      actor: "chatgpt-codex-connector",
    };
    const unbracketedCodexOnly = await runIssue(
      issueState({
        labels: ["review:request", "review:skip"],
        canaryComments: [canaryRequest, unbracketedCanaryResponse],
      }),
      [
        `jhw_issue_create 'Unbracketed Codex review' 'Body text' request 20`,
        "printf 'expected=%s\\n' \"$JHW_ISSUE_EXPECTED_CODEX_BOT\"",
      ].join("\n"),
      { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
    );
    assert.match(unbracketedCodexOnly.stdout, /expected=chatgpt-codex-connector$/m,
      "the exact unbracketed canary actor must not be replaced by a fixed default");

    const wrongRepoCanary = await runIssue(
      issueState({ canaryComments: [canaryRequest, canaryResponse] }),
      "jhw_issue_discover_reviewers request true",
      { JHW_ISSUE_CODEX_CANARY_URL: "https://github.com/other/repo/issues/77" },
    );
    assert.equal(wrongRepoCanary.stdout.trim(), "");
    const wrongActorCanary = await runIssue(
      issueState({
        canaryComments: [{ ...canaryRequest, actor: "someone-else" }, canaryResponse],
      }),
      "jhw_issue_discover_reviewers request true",
      { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
    );
    assert.equal(wrongActorCanary.stdout.trim(), "");
    const oldResponseCanary = await runIssue(
      issueState({
        canaryComments: [
          canaryRequest,
          { ...canaryResponse, createdAt: "2026-08-31T23:59:00Z" },
        ],
      }),
      "jhw_issue_discover_reviewers request true",
      { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
    );
    assert.equal(oldResponseCanary.stdout.trim(), "");
    const ambiguousCanary = await runIssue(
      issueState({
        canaryComments: [
          canaryRequest,
          canaryResponse,
          { ...canaryResponse, id: 7003, actor: "chatgpt-codex-connector" },
        ],
      }),
      "jhw_issue_discover_reviewers request true",
      { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
    );
    assert.equal(ambiguousCanary.stdout.trim(), "");
    const malformedTimestampCanary = await runIssue(
      issueState({
        canaryComments: [canaryRequest, { ...canaryResponse, createdAt: "not-a-time" }],
      }),
      "jhw_issue_discover_reviewers request true",
      { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
    );
    assert.equal(malformedTimestampCanary.stdout.trim(), "",
      "malformed timestamps cannot prove that a Codex response followed the request");
    for (const body of [
      "Unable to review because usage limits were reached.",
      "Quota exceeded.",
      "Provider unavailable.",
    ]) {
      const failedResponseCanary = await runIssue(
        issueState({
          canaryComments: [canaryRequest, { ...canaryResponse, body }],
        }),
        "jhw_issue_discover_reviewers request true",
        { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
      );
      assert.equal(failedResponseCanary.stdout.trim(), "",
        `a canary response that reports review failure (${body}) cannot prove Codex capability`);
    }

    await setRepoFixture({
      claude: true,
      config: "review:\n  auto: true\nworkflows:\n  claude:\n    enabled: true\n",
    });
    const remotelyDisabledWorkflow = await runIssue(
      issueState({ workflowStates: { "claude.yml": "disabled_manually" } }),
      "jhw_issue_discover_reviewers request true",
    );
    assert.equal(remotelyDisabledWorkflow.stdout.trim(), "",
      "a locally present workflow disabled on GitHub cannot be eligible");
    const remoteContractMismatch = await runIssue(
      issueState({
        remoteWorkflowContents: {
          "claude.yml": "name: Claude Code\n\non:\n  pull_request:\n    types: [opened]\n",
        },
      }),
      "jhw_issue_discover_reviewers request true",
    );
    assert.equal(remoteContractMismatch.stdout.trim(), "",
      "the default-branch workflow must expose an issue_comment event contract");
    const remoteRunNameMismatch = await runIssue(
      issueState({
        remoteWorkflowContents: {
          "claude.yml": "name: Claude Code\n\non:\n  issue_comment:\n    types: [created]\n",
        },
      }),
      "jhw_issue_discover_reviewers request true",
    );
    assert.equal(remoteRunNameMismatch.stdout.trim(), "",
      "a workflow without a request-comment run-name coordinate cannot be eligible");
    const remoteActionMismatch = await runIssue(
      issueState({
        remoteWorkflowContents: {
          "claude.yml": "name: Claude Code\n\non:\n  issue_comment:\n    types: [edited]\n",
        },
      }),
      "jhw_issue_discover_reviewers request true",
    );
    assert.equal(remoteActionMismatch.stdout.trim(), "",
      "an issue_comment workflow restricted away from created cannot receive a mention request");
    const quotedActionMismatch = await runIssue(
      issueState({
        remoteWorkflowContents: {
          "claude.yml": "name: Claude Code\n\non:\n  issue_comment:\n    \"types\": [edited]\n",
        },
      }),
      "jhw_issue_discover_reviewers request true",
    );
    assert.equal(quotedActionMismatch.stdout.trim(), "",
      "a quoted types key restricted away from created cannot receive a mention request");
    const quotedInlineActionMismatch = await runIssue(
      issueState({
        remoteWorkflowContents: {
          "claude.yml": "name: Claude Code\n\non:\n  issue_comment: {\"types\": [edited]}\n",
        },
      }),
      "jhw_issue_discover_reviewers request true",
    );
    assert.equal(quotedInlineActionMismatch.stdout.trim(), "",
      "a quoted inline types key restricted away from created cannot receive a mention request");
    const nestedIssueCommentKey = await runIssue(
      issueState({
        remoteWorkflowContents: {
          "claude.yml": [
            "name: Claude Code",
            "",
            "on:",
            "  workflow_dispatch:",
            "    inputs:",
            "      issue_comment:",
            "        description: not an event",
            "",
          ].join("\n"),
        },
      }),
      "jhw_issue_discover_reviewers request true",
    );
    assert.equal(nestedIssueCommentKey.stdout.trim(), "",
      "a nested issue_comment key is not a direct event under on");

    const existingMarker = {
      id: 1001,
      actor: "jhw7500",
      createdAt: requestCreatedAt,
      body: "@claude 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=claude -->",
      url: "https://github.com/example/repo/issues/99#issuecomment-1001",
    };
    const reused = await runIssue(
      issueState({ issueExists: true, issueComments: [existingMarker] }),
      "jhw_issue_request_reviewer 99 claude",
    );
    assert.equal(reused.state.mutations.length, 0);
    assert.equal(reused.stdout.trim(), "1001");
    const duplicate = await runIssueResult(
      issueState({ issueExists: true, issueComments: [existingMarker, { ...existingMarker, id: 1002 }] }),
      "jhw_issue_request_reviewer 99 claude",
    );
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.stderr, /FAILED/);
    assert.deepEqual(duplicate.state.mutations, []);

    const postFailure = await runIssueResult(
      issueState({ issueExists: true, failCommentPost: true }),
      "jhw_issue_request_reviewer 99 claude",
    );
    assert.notEqual(postFailure.code, 0);
    assert.equal(postFailure.state.mutations.some((item) => item.startsWith("issue:")), false,
      "a reviewer request failure must not edit, close, delete, or patch the Issue");

    const triggerDeadline = 1788221100;
    const reviewDeadline = 1788222000;
    const requestComment = {
      id: 1001,
      actor: "jhw7500",
      createdAt: requestCreatedAt,
      body: "@claude 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=claude -->",
      url: "https://github.com/example/repo/issues/99#issuecomment-1001",
    };
    const expectedBot = "claude-review[bot]";
    const acknowledgment = {
      actor: expectedBot,
      content: "eyes",
      createdAt: "2026-09-01T00:01:30Z",
      url: requestComment.url,
    };
    const response = (body, overrides = {}) => ({
      id: 1002,
      actor: expectedBot,
      createdAt: "2026-09-01T00:02:00Z",
      body,
      url: "https://github.com/example/repo/issues/99#issuecomment-1002",
      ...overrides,
    });

    async function classify(state, reviewer, nowEpoch, overrides = {}) {
      return runIssue(
        state,
        [
          `signal_file="$(jhw_issue_create_signal_file)" || exit $?`,
          `jhw_issue_collect_signals 99 1001 '${issueCreatedAt}' "$signal_file" || exit $?`,
          `jhw_issue_classify_reviewer ${reviewer} ${nowEpoch} ${triggerDeadline} ${reviewDeadline} "$signal_file"`,
          "classify_status=$?",
          `jhw_issue_cleanup_signal_file "$signal_file" || exit $?`,
          `(( classify_status == 0 )) || exit "$classify_status"`,
          "printf 'meta=%s|%s\\n' \"$JHW_ISSUE_REVIEW_RESPONSE\" \"$JHW_ISSUE_REVIEW_DIAGNOSTIC\"",
        ].join("\n"),
        { JHW_ISSUE_EXPECTED_CLAUDE_BOT: expectedBot, ...overrides },
      );
    }

    const clean = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("Requirements look complete; no blockers found.")],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(clean.stdout.split("\n")[0], "CLEAN");
    assert.match(clean.stdout, /issuecomment-1002/);

    const negatedRiskFindings = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("No missing requirements or implementation risks.")],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(negatedRiskFindings.stdout.split("\n")[0], "CLEAN",
      "explicitly negated requirement and risk findings must remain CLEAN");

    const negatedSeverityFindings = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("No [HIGH] issues.")],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(negatedSeverityFindings.stdout.split("\n")[0], "CLEAN",
      "an explicitly negated blocking severity must remain CLEAN");

    const sameSecondClean = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("No blockers found.", { createdAt: requestCreatedAt }),
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(sameSecondClean.stdout.split("\n")[0], "CLEAN",
      "a reviewer comment with a later ID in the request second must be accepted");

    const sameSecondRunResponse = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response([
            "**Claude finished @jhw7500's task** —— [View job](https://github.com/example/repo/actions/runs/500)",
            "",
            "No blockers found.",
          ].join("\n"), { createdAt: "2026-09-01T00:02:00Z" }),
        ],
        runs: [{
          id: 500,
          name: "Claude Code",
          event: "issue_comment",
          status: "completed",
          conclusion: "success",
          createdAt: "2026-09-01T00:02:00Z",
          url: "https://github.com/example/repo/actions/runs/500",
          displayTitle: "jhw-review-comment-1001",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(sameSecondRunResponse.stdout.split("\n")[0], "CLEAN",
      "a fast reviewer response that names its workflow run must be accepted in the same timestamp second");

    const inProgressRunResponse = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response([
            "**Claude finished @jhw7500's task** —— [View job](https://github.com/example/repo/actions/runs/500)",
            "",
            "No blockers found.",
          ].join("\n"), { createdAt: "2026-09-01T00:02:00Z" }),
        ],
        runs: [{
          id: 500,
          name: "Claude Code",
          event: "issue_comment",
          status: "in_progress",
          conclusion: "null",
          createdAt: "2026-09-01T00:02:00Z",
          url: "https://github.com/example/repo/actions/runs/500",
          displayTitle: "jhw-review-comment-1001",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(inProgressRunResponse.stdout.split("\n")[0], "PENDING",
      "a run-linked verdict must not become terminal before its selected workflow run completes");
    assert.match(inProgressRunResponse.stdout, /workflow_in_progress/);

    const sameSecondUncorrelatedResponse = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("No blockers found.", { createdAt: "2026-09-01T00:02:00Z" }),
        ],
        runs: [{
          id: 500,
          name: "Claude Code",
          event: "issue_comment",
          status: "in_progress",
          conclusion: "null",
          createdAt: "2026-09-01T00:02:00Z",
          url: "https://github.com/example/repo/actions/runs/500",
          displayTitle: "jhw-review-comment-1001",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(sameSecondUncorrelatedResponse.stdout.split("\n")[0], "PENDING",
      "a same-second response without the latest run coordinate must remain uncorrelated");

    for (const malformedSuffix of [
      "0",
      "abc",
      "/attempts/1",
      "?check_suite_focus=true",
      ".evil.example",
    ]) {
      const malformedSameSecondReference = await classify(
        issueState({
          issueExists: true,
          issueComments: [
            requestComment,
            response([
              `**Claude finished @jhw7500's task** —— [View job](https://github.com/example/repo/actions/runs/500${malformedSuffix})`,
              "",
              "No blockers found.",
            ].join("\n"), { createdAt: "2026-09-01T00:02:00Z" }),
          ],
          runs: [{
            id: 500,
            name: "Claude Code",
            event: "issue_comment",
            status: "in_progress",
            conclusion: "null",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/500",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          }],
        }),
        "claude",
        triggerDeadline - 1,
      );
      assert.equal(malformedSameSecondReference.stdout.split("\n")[0], "PENDING",
        `a malformed latest-run URL suffix (${malformedSuffix}) must not correlate a same-second response`);
    }

    for (const malformedReference of [
      "xhttps://github.com/example/repo/actions/runs/500",
      "prefix-https://github.com/example/repo/actions/runs/500)",
      "https://evil.example/?next=https://github.com/example/repo/actions/runs/500",
    ]) {
      const malformedSameSecondReference = await classify(
        issueState({
          issueExists: true,
          issueComments: [
            requestComment,
            response([
              `**Claude finished @jhw7500's task** —— ${malformedReference}`,
              "",
              "No blockers found.",
            ].join("\n"), { createdAt: "2026-09-01T00:02:00Z" }),
          ],
          runs: [{
            id: 500,
            name: "Claude Code",
            event: "issue_comment",
            status: "in_progress",
            conclusion: "null",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/500",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          }],
        }),
        "claude",
        triggerDeadline - 1,
      );
      assert.equal(malformedSameSecondReference.stdout.split("\n")[0], "PENDING",
        `a malformed latest-run URL prefix (${malformedReference}) must not correlate a same-second response`);
    }

    const preRetrySameSecondResponse = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response([
            "**Claude finished @jhw7500's task** —— [View job](https://github.com/example/repo/actions/runs/499)",
            "",
            "No blockers found.",
          ].join("\n"), { createdAt: "2026-09-01T00:02:00Z" }),
        ],
        runs: [
          {
            id: 499,
            name: "Claude Code",
            event: "issue_comment",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-09-01T00:01:59Z",
            url: "https://github.com/example/repo/actions/runs/499",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
          {
            id: 500,
            name: "Claude Code",
            event: "issue_comment",
            status: "in_progress",
            conclusion: "null",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/500",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(preRetrySameSecondResponse.stdout.split("\n")[0], "PENDING",
      "an earlier run response must not become terminal for a same-second retry");

    const sameSecondEarlierComment = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("No blockers found.", { id: 1000, createdAt: requestCreatedAt }),
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(sameSecondEarlierComment.stdout.split("\n")[0], "PENDING",
      "a same-second comment without a later ID must remain excluded");

    const sameSecondReaction = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment],
        commentReactions: [{ ...acknowledgment, createdAt: requestCreatedAt }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(sameSecondReaction.stdout.split("\n")[0], "PENDING");
    assert.match(sameSecondReaction.stdout, /acknowledged/,
      "a reaction scoped to the request comment is valid in the request second");

    const feedback = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("[HIGH] Missing requirement: define authentication failure behavior.")],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(feedback.stdout.split("\n")[0], "FEEDBACK");
    assert.match(feedback.stdout, /actionable_feedback/);

    const negatedSeverityWithFinding = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("No [HIGH] issues, but [CRITICAL] authentication behavior is undefined."),
        ],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(negatedSeverityWithFinding.stdout.split("\n")[0], "FEEDBACK",
      "a negated severity phrase must not hide a separate affirmative finding");

    const unclassifiedSubstantive = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("Authentication behavior is underspecified; add failure cases."),
        ],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(unclassifiedSubstantive.stdout.split("\n")[0], "FEEDBACK",
      "unmatched substantive reviewer prose must not be inferred CLEAN");
    assert.match(unclassifiedSubstantive.stdout, /unclassified_substantive_response/);

    const negatedCleanPhrase = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("This is not ready for implementation.")],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(negatedCleanPhrase.stdout.split("\n")[0], "FEEDBACK",
      "a negated clean phrase must not satisfy the CLEAN verdict");

    const cleanThenCorrection = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("No blockers found."),
          response("Authentication behavior is underspecified; add failure cases.", {
            id: 1003,
            createdAt: "2026-09-01T00:03:00Z",
            url: "https://github.com/example/repo/issues/99#issuecomment-1003",
          }),
        ],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(cleanThenCorrection.stdout.split("\n")[0], "FEEDBACK",
      "the newest substantive response must supersede an older CLEAN response");
    assert.match(cleanThenCorrection.stdout, /issuecomment-1003/);

    const mixedCleanAndConcern = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("No blockers found.\nAuthentication behavior is underspecified; add failure cases."),
        ],
        commentReactions: [acknowledgment],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(mixedCleanAndConcern.stdout.split("\n")[0], "FEEDBACK",
      "an exact clean line cannot override additional unclassified substantive content");

    const failedRun = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment],
        runs: [{
          id: 501,
          name: "Claude Code",
          event: "issue_comment",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-09-01T00:02:00Z",
          url: "https://github.com/example/repo/actions/runs/501",
          displayTitle: "jhw-review-comment-1001",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(failedRun.stdout.split("\n")[0], "FAILED");
    assert.match(failedRun.stdout, /actions\/runs\/501/);

    const requestScopedRun = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment],
        runs: [
          {
            id: 508,
            name: "Claude Code",
            event: "issue_comment",
            status: "in_progress",
            conclusion: "null",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/508",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
          {
            id: 509,
            name: "Claude Code",
            event: "issue_comment",
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-09-01T00:03:00Z",
            url: "https://github.com/example/repo/actions/runs/509",
            displayTitle: "jhw-review-comment-1002",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(requestScopedRun.stdout.split("\n")[0], "PENDING");
    assert.match(requestScopedRun.stdout, /\|acknowledged/,
      "only the workflow run named with this reviewer request comment may acknowledge it");
    assert.doesNotMatch(requestScopedRun.stdout, /actions\/runs\/509/);

    const laterUncorrelatedRunResponse = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("No blockers found.", {
            id: 1004,
            createdAt: "2026-09-01T00:04:00Z",
            url: "https://github.com/example/repo/issues/99#issuecomment-1004",
          }),
        ],
        runs: [
          {
            id: 508,
            name: "Claude Code",
            event: "issue_comment",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/508",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
          {
            id: 509,
            name: "Claude Code",
            event: "issue_comment",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-09-01T00:03:00Z",
            url: "https://github.com/example/repo/actions/runs/509",
            displayTitle: "jhw-review-comment-1002",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(laterUncorrelatedRunResponse.stdout.split("\n")[0], "PENDING",
      "a later bot verdict without the selected run URL must remain uncorrelated");
    assert.doesNotMatch(laterUncorrelatedRunResponse.stdout, /issuecomment-1004/);

    const laterCorrelatedRunResponse = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response([
            "**Claude finished @jhw7500's task** —— [View job](https://github.com/example/repo/actions/runs/508)",
            "",
            "No blockers found.",
          ].join("\n"), {
            id: 1004,
            createdAt: "2026-09-01T00:04:00Z",
            url: "https://github.com/example/repo/issues/99#issuecomment-1004",
          }),
        ],
        runs: [{
          id: 508,
          name: "Claude Code",
          event: "issue_comment",
          status: "completed",
          conclusion: "success",
          createdAt: "2026-09-01T00:02:00Z",
          url: "https://github.com/example/repo/actions/runs/508",
          displayTitle: "jhw-review-comment-1001",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(laterCorrelatedRunResponse.stdout.split("\n")[0], "CLEAN",
      "a later bot verdict that names the selected run must remain eligible");
    assert.match(laterCorrelatedRunResponse.stdout, /issuecomment-1004/);

    const supersededFailedRun = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("Claude encountered an error while reviewing."),
          response([
            "**Claude finished @jhw7500's task** —— [View job](https://github.com/example/repo/actions/runs/505)",
            "",
            "Requirements look complete; no blockers found.",
          ].join("\n"), {
            id: 1004,
            createdAt: "2026-09-01T00:04:00Z",
            url: "https://github.com/example/repo/issues/99#issuecomment-1004",
          }),
        ],
        runs: [
          {
            id: 504,
            name: "Claude Code",
            event: "issue_comment",
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/504",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
          {
            id: 505,
            name: "Claude Code",
            event: "issue_comment",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/505",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(supersededFailedRun.stdout.split("\n")[0], "CLEAN",
      "a higher-ID successful retry must supersede an older same-second failed workflow run");
    assert.match(supersededFailedRun.stdout, /issuecomment-1004/);

    const retryAwaitingResponse = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("Claude encountered an error while reviewing.")],
        runs: [
          {
            id: 506,
            name: "Claude Code",
            event: "issue_comment",
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/506",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
          {
            id: 507,
            name: "Claude Code",
            event: "issue_comment",
            status: "in_progress",
            conclusion: "null",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/507",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          },
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(retryAwaitingResponse.stdout.split("\n")[0], "PENDING",
      "a higher-ID same-second retry must keep an uncorrelated error pending");
    assert.match(retryAwaitingResponse.stdout, /acknowledged/);

    const sameSecondFailedRun = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment],
        runs: [{
          id: 503,
          name: "Claude Code",
          event: "issue_comment",
          status: "completed",
          conclusion: "failure",
          createdAt: requestCreatedAt,
          url: "https://github.com/example/repo/actions/runs/503",
          displayTitle: "jhw-review-comment-1001",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(sameSecondFailedRun.stdout.split("\n")[0], "FAILED",
      "an exact request-comment coordinate makes a same-second workflow run causal");
    assert.match(sameSecondFailedRun.stdout, /https:\/\/github\.com\/example\/repo\/actions\/runs\/503/);

    await assert.rejects(
      classify(
        issueState({
          issueExists: true,
          issueComments: [requestComment],
          runs: [{
            id: "9007199254740993",
            name: "Claude Code",
            event: "issue_comment",
            status: "in_progress",
            conclusion: "null",
            createdAt: "2026-09-01T00:02:00Z",
            url: "https://github.com/example/repo/actions/runs/unsafe",
            displayTitle: "jhw-review-comment-1001",
            actor: "jhw7500",
            triggeringActor: "jhw7500",
          }],
        }),
        "claude",
        triggerDeadline - 1,
      ),
      (error) => {
        assert.match(error.stderr, /invalid workflow run id/);
        return true;
      },
      "an unsafe workflow run ID must fail closed before same-second ordering",
    );

    const unrelatedFailedRun = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment],
        runs: [{
          id: 502,
          name: "Claude Code",
          event: "issue_comment",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-09-01T00:02:00Z",
          url: "https://github.com/example/repo/actions/runs/502",
          displayTitle: "jhw-review-comment-9999",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(unrelatedFailedRun.stdout.split("\n")[0], "PENDING",
      "a same-named workflow run for another Issue must not affect this request");

    const rejected = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("Unable to review: connector rejected the request.")],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(rejected.stdout.split("\n")[0], "FAILED");
    assert.match(rejected.stdout, /connector_rejected/);

    for (const body of ["Usage limit reached.", "Quota exceeded.", "Provider unavailable."]) {
      const quotaFailure = await classify(
        issueState({
          issueExists: true,
          issueComments: [requestComment, response(body)],
        }),
        "claude",
        triggerDeadline - 1,
      );
      assert.equal(quotaFailure.stdout.split("\n")[0], "FAILED",
        `a provider response (${body}) must be classified as reviewer failure`);
      assert.match(quotaFailure.stdout, /connector_rejected/);
    }

    const quotaRequirementFeedback = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("[HIGH] Define expected behavior when an account quota is exceeded."),
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(quotaRequirementFeedback.stdout.split("\n")[0], "FEEDBACK",
      "implementation feedback about quota behavior must not become a provider failure");

    const staleRejectedReaction = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("Requirements look complete; no blockers found.", {
            id: 1004,
            createdAt: "2026-09-01T00:04:00Z",
            url: "https://github.com/example/repo/issues/99#issuecomment-1004",
          }),
        ],
        commentReactions: [{
          actor: expectedBot,
          content: "confused",
          createdAt: "2026-09-01T00:02:00Z",
          url: requestComment.url,
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(staleRejectedReaction.stdout.split("\n")[0], "CLEAN",
      "a later substantive response must supersede an older rejection reaction");

    const latestRejectedReaction = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("Requirements look complete; no blockers found.")],
        commentReactions: [{
          actor: expectedBot,
          content: "confused",
          createdAt: "2026-09-01T00:03:00Z",
          url: requestComment.url,
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(latestRejectedReaction.stdout.split("\n")[0], "FAILED",
      "a rejection reaction newer than the latest response must remain terminal");
    assert.match(latestRejectedReaction.stdout, /connector_rejected/);

    const sameSecondRejectedReaction = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("Requirements look complete; no blockers found.", {
            id: 1004,
            createdAt: "2026-09-01T00:03:00Z",
            url: "https://github.com/example/repo/issues/99#issuecomment-1004",
          }),
        ],
        commentReactions: [{
          actor: expectedBot,
          content: "confused",
          createdAt: "2026-09-01T00:03:00Z",
          url: requestComment.url,
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(sameSecondRejectedReaction.stdout.split("\n")[0], "PENDING",
      "same-second cross-type terminal signals must remain pending without ordering proof");
    assert.match(sameSecondRejectedReaction.stdout, /ambiguous_same_second_signal/);

    const unacknowledged = await classify(
      issueState({ issueExists: true, issueComments: [requestComment] }),
      "claude",
      triggerDeadline + 1,
    );
    assert.equal(unacknowledged.stdout.split("\n")[0], "FAILED");
    assert.match(unacknowledged.stdout, /trigger_unacknowledged/);

    const timedOut = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment],
        commentReactions: [acknowledgment],
      }),
      "claude",
      reviewDeadline + 1,
    );
    assert.equal(timedOut.stdout.split("\n")[0], "TIMEOUT");
    assert.match(timedOut.stdout, /review_timeout/);

    const unavailable = await classify(
      issueState({ issueExists: true, issueComments: [requestComment] }),
      "claude",
      triggerDeadline - 1,
      { JHW_ISSUE_REVIEWER_ELIGIBLE: "false" },
    );
    assert.equal(unavailable.stdout.split("\n")[0], "UNAVAILABLE");

    const oldOrWrong = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("[HIGH] old", { createdAt: "2026-08-31T23:59:00Z" }),
          response("[HIGH] wrong actor", { id: 1003, actor: "other-bot" }),
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(oldOrWrong.stdout.split("\n")[0], "PENDING");

    const realClaudeSignature = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response("**Claude finished @jhw7500's task in 1m** —— [View job](https://github.com/example/repo/actions/runs/700)\n\nNo blocking findings.", {
            actor: "claude[bot]",
          }),
        ],
      }),
      "claude",
      triggerDeadline - 1,
      { JHW_ISSUE_EXPECTED_CLAUDE_BOT: "" },
    );
    assert.equal(realClaudeSignature.stdout.split("\n")[0], "CLEAN",
      "Claude bot identity must be derived from the pinned caller's signed response shape");

    const geminiRequestComment = {
      ...requestComment,
      body: "@gemini-cli 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=gemini -->",
    };
    const geminiAck = response("## 🤖 Gemini CLI (명령어 기반)\n\nHi @jhw7500, I've received your request, and I'm working on it now!", {
      id: 1101,
      actor: "custom-gemini-app[bot]",
      createdAt: "2026-09-01T00:01:30Z",
    });
    const geminiFinal = response("The requirements are complete; no blockers found.", {
      id: 1102,
      actor: "custom-gemini-app[bot]",
    });
    const dynamicGemini = await classify(
      issueState({
        issueExists: true,
        issueComments: [geminiRequestComment, geminiAck, geminiFinal],
      }),
      "gemini",
      triggerDeadline - 1,
      { JHW_ISSUE_EXPECTED_GEMINI_BOT: "" },
    );
    assert.equal(dynamicGemini.stdout.split("\n")[0], "CLEAN",
      "Gemini response identity must be pinned to the bot that emitted the exact dispatcher acknowledgment");

    const wrongGeminiActor = await classify(
      issueState({
        issueExists: true,
        issueComments: [geminiRequestComment, geminiAck, { ...geminiFinal, actor: "other-bot[bot]" }],
      }),
      "gemini",
      triggerDeadline - 1,
      { JHW_ISSUE_EXPECTED_GEMINI_BOT: "" },
    );
    assert.equal(wrongGeminiActor.stdout.split("\n")[0], "PENDING",
      "a different bot cannot satisfy a Gemini request after actor pinning");

    const codexRequestComment = {
      ...requestComment,
      body: "@codex 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=codex -->",
    };
    const unbracketedCodexFinal = response("Requirements are complete; no blockers found.", {
      actor: "chatgpt-codex-connector",
      actorType: "Bot",
    });
    const dynamicCodex = await classify(
      issueState({
        issueExists: true,
        issueComments: [codexRequestComment, unbracketedCodexFinal],
      }),
      "codex",
      triggerDeadline - 1,
      { JHW_ISSUE_EXPECTED_CODEX_BOT: "chatgpt-codex-connector" },
    );
    assert.equal(dynamicCodex.stdout.split("\n")[0], "CLEAN",
      "Codex classification must use the exact actor identity authenticated by the canary");

    const wrongCodexActor = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          codexRequestComment,
          { ...unbracketedCodexFinal, actor: "chatgpt-codex-connector[bot]" },
        ],
      }),
      "codex",
      triggerDeadline - 1,
      { JHW_ISSUE_EXPECTED_CODEX_BOT: "chatgpt-codex-connector" },
    );
    assert.equal(wrongCodexActor.stdout.split("\n")[0], "PENDING",
      "a different accepted Codex spelling cannot replace the uniquely proven canary actor");

    const secondPageResponse = response("Requirements are complete; no blocking risks.");
    const paginated = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, secondPageResponse],
        issueCommentPages: [[requestComment], [secondPageResponse]],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(paginated.stdout.split("\n")[0], "CLEAN",
      "paginated comment arrays must be flattened before JSON parsing");

    const largeRunHistory = await classify(
      issueState({
        issueExists: true,
        issueComments: [requestComment, response("No blocking findings.")],
        runs: Array.from({ length: 900 }, (_, index) => ({
          id: 3000 + index,
          name: "Claude Code",
          event: "issue_comment",
          status: "completed",
          conclusion: "success",
          createdAt: "2026-09-01T00:02:00Z",
          url: `https://github.com/example/repo/actions/runs/${3000 + index}`,
          displayTitle: `Other Issue ${index}`,
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        })),
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(largeRunHistory.stdout.split("\n")[0], "CLEAN",
      "large filtered run history must be streamed without environment-size failure");

    const largeRelevantComment = await classify(
      issueState({
        issueExists: true,
        issueComments: [
          requestComment,
          response(`${" \n".repeat(150000)}No blocking findings.`),
        ],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(largeRelevantComment.stdout.split("\n")[0], "CLEAN",
      "a large relevant reviewer response must be classified without an environment-size failure");

    await setRepoFixture({
      claude: true,
      gemini: true,
      config: [
        "review:",
        "  auto: true",
        "workflows:",
        "  claude:",
        "    enabled: true",
        "  gemini-dispatch:",
        "    enabled: true",
        "",
      ].join("\n"),
    });
    const interruptedCleanup = await runIssueResult(
      issueState(),
      [
        `JHW_ISSUE_STATE_FILE="$(jhw_issue_create_state_file)" || exit $?`,
        `JHW_ISSUE_ACTIVE_SIGNAL_FILE="$(jhw_issue_create_signal_file)" || exit $?`,
        "export JHW_ISSUE_STATE_FILE JHW_ISSUE_ACTIVE_SIGNAL_FILE",
        "jhw_issue_install_execution_cleanup || exit $?",
        `kill -TERM "$$"`,
        "exit 99",
      ].join("\n"),
      { JHW_ISSUE_STATE_FILE: "" },
    );
    assert.equal(interruptedCleanup.code, 143,
      "TERM must preserve a non-success status after private-file cleanup");
    assert.equal((await readdir(tempRoot)).some((name) => /^jhw-issue\.signal\..*\.json$/.test(name)), false,
      "TERM must remove the active private signal snapshot");
    assert.equal((await readdir(tempRoot)).some((name) => /^jhw-issue\..*\.state$/.test(name)), false,
      "TERM must remove the private summary state alongside the active snapshot");

    const restoredCallerTraps = await runIssueResult(
      issueState(),
      [
        "trap ':' EXIT",
        "trap ':' HUP",
        "trap ':' INT",
        "trap ':' TERM",
        'before_exit="$(trap -p EXIT)"',
        'before_hup="$(trap -p HUP)"',
        'before_int="$(trap -p INT)"',
        'before_term="$(trap -p TERM)"',
        "if jhw_issue_execute 'Review this' 'Body text' skip 20 >/dev/null; then status=0; else status=$?; fi",
        '[[ "$(trap -p EXIT)" == "$before_exit" ]] || exit 21',
        '[[ "$(trap -p HUP)" == "$before_hup" ]] || exit 22',
        '[[ "$(trap -p INT)" == "$before_int" ]] || exit 23',
        '[[ "$(trap -p TERM)" == "$before_term" ]] || exit 24',
        "trap - EXIT HUP INT TERM",
        "printf 'status=%s\\n' \"$status\"",
      ].join("\n"),
      { JHW_ISSUE_STATE_FILE: "" },
    );
    assert.equal(restoredCallerTraps.code, 0,
      "Issue execution must restore every caller-owned trap");
    assert.equal(restoredCallerTraps.stdout, "status=0\n");

    const corruptPollRecovery = await runIssueResult(
      issueState(),
      [
        "jhw_issue_poll_once() { printf '{' > \"$1\"; return 1; }",
        "jhw_issue_execute 'Review this' 'Body text' request 20",
        "status=$?",
        "if [[ -n \"${JHW_ISSUE_STATE_FILE:-}\" && ( -e \"$JHW_ISSUE_STATE_FILE\" || -L \"$JHW_ISSUE_STATE_FILE\" ) ]]; then echo state=present; else echo state=gone; fi",
        "if [[ -n \"$(trap -p EXIT HUP INT TERM)\" ]]; then echo traps=present; else echo traps=clear; fi",
        "exit \"$status\"",
      ].join("\n"),
      {
        JHW_ISSUE_STATE_FILE: "",
        JHW_ISSUE_EXPECTED_CLAUDE_BOT: "claude-review[bot]",
        JHW_ISSUE_EXPECTED_GEMINI_BOT: "gemini-review[bot]",
      },
    );
    assert.equal(corruptPollRecovery.code, 1,
      "a corrupt private summary must keep the execution failed");
    assert.match(corruptPollRecovery.stdout, /^state=gone$/m,
      "poll recovery failure must still remove the private summary state before returning");
    assert.match(corruptPollRecovery.stdout, /^traps=clear$/m,
      "poll recovery failure must clear the execution-owned signal traps before returning");

    const invalidPollingInterval = await runIssueResult(
      issueState(),
      `jhw_issue_execute 'Review this' 'Body text' request 20`,
      {
        JHW_ISSUE_POLL_SECONDS: "0",
        JHW_ISSUE_STATE_FILE: "",
      },
    );
    assert.equal(invalidPollingInterval.code, 2);
    assert.equal(invalidPollingInterval.stdout, "",
      "an invalid polling interval must fail before printing a created Issue URL");
    assert.deepEqual(invalidPollingInterval.state.mutations, [],
      "an invalid polling interval must fail before every GitHub mutation");
    assert.equal((await readdir(tempRoot)).some((name) => /^jhw-issue\..*\.state$/.test(name)), false,
      "invalid polling input must not leave private execution state");
    assert.equal((await readdir(tempRoot)).some((name) => /^jhw-issue\.signal\..*\.json$/.test(name)), false,
      "invalid polling input must not leave a private signal snapshot");

    const overflowingPollingInterval = await runIssueResult(
      issueState(),
      `jhw_issue_execute 'Review this' 'Body text' request 1`,
      {
        JHW_ISSUE_POLL_SECONDS: "18446744073709551617",
        JHW_ISSUE_STATE_FILE: "",
      },
    );
    assert.equal(overflowingPollingInterval.code, 2);
    assert.equal(overflowingPollingInterval.stdout, "",
      "an overflowing polling interval must fail before printing a created Issue URL");
    assert.deepEqual(overflowingPollingInterval.state.mutations, [],
      "an overflowing polling interval must fail before every GitHub mutation");
    assert.equal((await readdir(tempRoot)).some((name) => /^jhw-issue\..*\.state$/.test(name)), false,
      "overflowing polling input must not leave private execution state");
    assert.equal((await readdir(tempRoot)).some((name) => /^jhw-issue\.signal\..*\.json$/.test(name)), false,
      "overflowing polling input must not leave a private signal snapshot");

    const executeResponses = [
      response("No blocking requirements gaps.", { id: 2001, actor: "claude-review[bot]" }),
      response("The proposal is complete and ready for implementation.", { id: 2002, actor: "gemini-review[bot]" }),
    ];
    const executed = await runIssue(
      issueState({ issueComments: executeResponses }),
      `jhw_issue_execute 'Review this' 'Body text' request 20`,
      {
        JHW_ISSUE_STATE_FILE: "",
        JHW_ISSUE_EXPECTED_CLAUDE_BOT: "claude-review[bot]",
        JHW_ISSUE_EXPECTED_GEMINI_BOT: "gemini-review[bot]",
      },
    );
    assert.equal(executed.stdout.split("\n")[0], "https://github.com/example/repo/issues/99",
      "the preserved Issue URL must be printed before review results");
    assert.match(executed.stdout, /^Requested reviewers: claude, gemini$/m);
    assert.match(executed.stdout, /^claude \| CLEAN \|/m);
    assert.match(executed.stdout, /^gemini \| CLEAN \|/m);
    assert.match(executed.stdout, /^codex \| UNAVAILABLE \|/m);
    assert.equal((await readdir(tempRoot)).some((name) => /^jhw-issue\..*\.state$/.test(name)), false,
      "terminal execution must remove only its private state file");

    const partial = await runIssue(
      issueState({
        issueComments: [response("No blocking requirements gaps.", {
          id: 2101,
          actor: "claude-review[bot]",
        })],
        failCommentReviewers: ["gemini"],
      }),
      `jhw_issue_execute 'Review this' 'Body text' request 20`,
      {
        JHW_ISSUE_STATE_FILE: "",
        JHW_ISSUE_EXPECTED_CLAUDE_BOT: "claude-review[bot]",
        JHW_ISSUE_EXPECTED_GEMINI_BOT: "gemini-review[bot]",
      },
    );
    assert.equal(partial.stdout.split("\n")[0], "https://github.com/example/repo/issues/99");
    assert.match(partial.stdout, /^claude \| CLEAN \|/m);
    assert.match(partial.stdout, /^gemini \| FAILED \| - \| request_failed$/m);
    assert.equal(partial.state.issueExists, true);
    assert.equal(partial.state.mutations.filter((item) => item === "comment:post").length, 1,
      "one reviewer request failure must not block another eligible reviewer");
    assert.equal(partial.state.mutations.filter((item) => item === "issue:edit").length, 1,
      "review failure must not edit the Issue beyond creation-time policy reconciliation");

    await setRepoFixture({
      claude: true,
      config: "review:\n  auto: true\nworkflows:\n  claude:\n    enabled: true\n",
    });
    const timedExecution = await runIssue(
      issueState({
        runs: [{
          id: 601,
          name: "Claude Code",
          event: "issue_comment",
          status: "in_progress",
          conclusion: "null",
          createdAt: "2026-09-01T00:01:30Z",
          url: "https://github.com/example/repo/actions/runs/601",
          displayTitle: "jhw-review-comment-1001",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      `jhw_issue_execute 'Review this' 'Body text' request 1`,
      {
        JHW_ISSUE_STATE_FILE: "",
        JHW_ISSUE_EXPECTED_CLAUDE_BOT: "claude-review[bot]",
      },
    );
    assert.match(timedExecution.stdout, /^claude \| TIMEOUT \| .* \| review_timeout$/m);
    assert.equal(timedExecution.log.filter((args) => args[0] === "sleep").length, 1,
      "the bounded loop must poll once after a single 60-second interval");

    const strictTimedExecution = await runIssue(
      issueState({
        runs: [{
          id: 602,
          name: "Claude Code",
          event: "issue_comment",
          status: "in_progress",
          conclusion: "null",
          createdAt: "2026-09-01T00:01:30Z",
          url: "https://github.com/example/repo/actions/runs/602",
          displayTitle: "jhw-review-comment-1001",
          actor: "jhw7500",
          triggeringActor: "jhw7500",
        }],
      }),
      [
        "set -e",
        "jhw_issue_execute 'Review this' 'Body text' request 1",
        "printf 'strict-poll-complete\\n'",
      ].join("\n"),
      {
        JHW_ISSUE_STATE_FILE: "",
        JHW_ISSUE_EXPECTED_CLAUDE_BOT: "claude-review[bot]",
      },
    );
    assert.match(strictTimedExecution.stdout, /^claude \| TIMEOUT \| .* \| review_timeout$/m,
      "strict-shell execution must complete the bounded PENDING poll");
    assert.match(strictTimedExecution.stdout, /^strict-poll-complete$/m);
    assert.equal(strictTimedExecution.log.filter((args) => args[0] === "sleep").length, 1,
      "strict-shell execution must not exit on the expected PENDING poll status");

    assert.equal(
      (await runIssue(issueState(), "jhw_issue_highest_disposition CLEAN FEEDBACK")).stdout.trim(),
      "FEEDBACK",
    );
    assert.equal(
      (await runIssue(issueState(), "jhw_issue_highest_disposition CLEAN TIMEOUT")).stdout.trim(),
      "TIMEOUT",
    );
    assert.equal(
      (await runIssue(issueState(), "jhw_issue_highest_disposition FEEDBACK FAILED")).stdout.trim(),
      "FAILED",
    );

    await writeFile(summaryStatePath, JSON.stringify({
      requested: ["claude", "gemini"],
      unavailable: ["codex"],
      results: [
        {
          reviewer: "claude",
          status: "CLEAN",
          response: "https://github.com/example/repo/issues/99#issuecomment-1002",
          diagnostic: "substantive_response",
        },
        {
          reviewer: "gemini",
          status: "TIMEOUT",
          response: "https://github.com/example/repo/issues/99#issuecomment-1003",
          diagnostic: "review_timeout",
        },
        {
          reviewer: "codex",
          status: "UNAVAILABLE",
          response: "",
          diagnostic: "preflight_unavailable",
        },
      ],
    }, null, 2), { mode: 0o600 });
    const summary = await runIssue(
      issueState({ issueExists: true }),
      [
        `jhw_issue_render_summary 'https://github.com/example/repo/issues/99' ${JSON.stringify(summaryStatePath)}`,
        `jhw_issue_cleanup_state_file ${JSON.stringify(summaryStatePath)}`,
      ].join("\n"),
    );
    assert.match(summary.stdout, /^Issue URL: https:\/\/github\.com\/example\/repo\/issues\/99$/m);
    assert.match(summary.stdout, /^Requested reviewers: claude, gemini$/m);
    assert.match(summary.stdout, /^Unavailable reviewers: codex$/m);
    assert.match(summary.stdout, /^Reviewer \| Status \| Response \| Diagnostic$/m);
    assert.match(summary.stdout, /^gemini \| TIMEOUT \| .*issuecomment-1003 \| review_timeout$/m);
    assert.match(summary.stdout, /^Highest disposition: TIMEOUT$/m);
    assert.deepEqual(summary.state.mutations, []);
    assert.equal(summary.log.length, 0, "rendering and cleanup must not call GitHub");
    await assert.rejects(readFile(summaryStatePath, "utf8"), { code: "ENOENT" });

    await setRepoFixture({ config: "review:\n  auto: true\n" });
    const noReviewerExecution = await runIssue(
      issueState(),
      `jhw_issue_execute 'Review this' 'Body text' auto 20`,
      { JHW_ISSUE_STATE_FILE: "" },
    );
    assert.equal(noReviewerExecution.stdout.split("\n")[0],
      "https://github.com/example/repo/issues/99");
    assert.match(noReviewerExecution.stdout, /^Requested reviewers: none$/m);
    assert.match(noReviewerExecution.stdout, /^Unavailable reviewers: claude, gemini, codex$/m);
    assert.match(noReviewerExecution.stdout, /^Highest disposition: UNAVAILABLE$/m,
      "a run with no requested reviewer must not report CLEAN");
    assert.equal(noReviewerExecution.state.mutations.filter((item) => item === "comment:post").length, 0,
      "auto mode must not mention an unavailable reviewer");
    assert.equal(noReviewerExecution.log.filter((args) => args[0] === "sleep").length, 0,
      "auto mode with no requested reviewer must finish without polling");
    assert.equal((await readdir(tempRoot)).some((name) => /^jhw-issue\..*\.state$/.test(name)), false,
      "no-reviewer execution must remove its private summary state");

    await setRepoFixture({ config: "review:\n  auto: false\n" });
    for (const [mode, title] of [["skip", "Skip review"], ["auto", "Auto disabled"]]) {
      const intentionallyUnreviewed = await runIssue(
        issueState(),
        `jhw_issue_execute '${title}' 'Body text' ${mode} 20`,
        { JHW_ISSUE_STATE_FILE: "" },
      );
      assert.match(intentionallyUnreviewed.stdout, /^Requested reviewers: none$/m);
      assert.match(intentionallyUnreviewed.stdout, /^Unavailable reviewers: none$/m);
      assert.match(intentionallyUnreviewed.stdout, /^Highest disposition: CLEAN$/m,
        `${mode} mode must preserve the intentional no-review disposition`);
      assert.equal(intentionallyUnreviewed.state.issueComments.length, 0);
      assert.equal(intentionallyUnreviewed.log.filter((args) => args[0] === "sleep").length, 0);
    }

    console.log("issue skill contract: ok");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
