#!/usr/bin/env node
// Consumer contract for the canonical /jhw:issue review-aware creation flow.
// The embedded Bash contract runs against a stateful fake gh only.

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
const canonicalIssue = join(repoRoot, "skills", "claude", "issue.md");
const installSafetyPath = join(repoRoot, "scripts", "test-install-safety.sh");
const agentsPath = join(repoRoot, "skills", "claude", "AGENTS.md");
const readmePath = join(repoRoot, "README.md");
const codexIssueSkill = join(repoRoot, "skills", "codex", "jhw-issue", "SKILL.md");
const codexIssueReference = join(repoRoot, "skills", "codex", "jhw-issue", "references", "issue.md");
const issueCreatedAt = "2026-09-01T00:00:00Z";
const requestCreatedAt = "2026-09-01T00:01:00Z";

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
  else if (query === ".createdAt") process.stdout.write(state.issueCreatedAt + "\n");
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

const commentMatch = endpoint.match(/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments\?per_page=100$/);
if (commentMatch) {
  const issueNumber = Number(commentMatch[1]);
  const comments = issueNumber === state.issueNumber ? state.issueComments : state.canaryComments;
  if (argv.includes("POST")) {
    if (issueNumber !== state.issueNumber || state.failCommentPost) process.exit(1);
    const fieldIndex = argv.indexOf("-f");
    const bodyArg = fieldIndex >= 0 ? argv[fieldIndex + 1] : "";
    const body = bodyArg.startsWith("body=") ? bodyArg.slice(5) : "";
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
  if (query.includes("{id, actor:.user.login")) {
    process.stdout.write(JSON.stringify(comments.map((item) => ({
      id: item.id,
      actor: item.actor,
      created_at: item.createdAt,
      body: item.body,
      url: item.url || "",
    }))) + "\n");
    process.exit(0);
  }
  if (query.includes("[.user.login, .created_at, .html_url]")) {
    rows(comments.map((item) => [item.actor, item.createdAt, item.url || ""].join("\t")));
    process.exit(0);
  }
  const actor = query.match(/\.user\.login == "([^"]+)"/)?.[1];
  const markers = [...query.matchAll(/contains\("([^"]+)"\)/g)].map((match) => match[1]);
  const matching = comments.filter((item) =>
    (!actor || item.actor === actor) &&
    (markers.length === 0 || markers.some((marker) => item.body.includes(marker))));
  rows(matching.map((item) => String(item.id) + "\t" + item.createdAt));
  process.exit(0);
}

if (/\/issues\/comments\/\d+\/reactions\?per_page=100$/.test(endpoint)) {
  const query = optionValue("--jq", "-q") || "";
  if (!query.includes("{actor:.user.login")) process.exit(2);
  process.stdout.write(JSON.stringify(state.commentReactions.map((item) => ({
    actor: item.actor,
    content: item.content,
    created_at: item.createdAt,
    url: item.url || "",
  }))) + "\n");
  process.exit(0);
}

if (endpoint === "repos/example/repo/actions/runs?per_page=100") {
  const query = optionValue("--jq", "-q") || "";
  if (!query.includes("{id, name:.name")) process.exit(2);
  process.stdout.write(JSON.stringify(state.runs.map((item) => ({
    id: item.id,
    name: item.name,
    event: item.event,
    status: item.status,
    conclusion: item.conclusion,
    created_at: item.createdAt,
    url: item.url || "",
  }))) + "\n");
  process.exit(0);
}

process.stderr.write("unexpected fake gh command: " + argv.join(" ") + "\n");
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
    issueCreatedAt,
    requestCreatedAt,
    issueComments: [],
    canaryComments: [],
    commentReactions: [],
    runs: [],
    mutations: [],
    nextCommentId: 1001,
    failEndpoints: [],
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
  assert.ok(existsSync(codexIssueSkill));
  assert.ok(lstatSync(codexIssueReference).isSymbolicLink());
  const contract = `${createContractBlock(issueText)}\n${waitContractBlock(issueText)}`;

  const tempRoot = await mkdtemp(join(tmpdir(), "jhw-issue-contract-"));
  const fakeGh = join(tempRoot, "gh");
  const contractPath = join(tempRoot, "contract.bash");
  const statePath = join(tempRoot, "gh-state.json");
  const logPath = join(tempRoot, "gh-log.jsonl");
  const summaryStatePath = join(tempRoot, "jhw-issue.summary.state");
  const fixtureRoot = join(tempRoot, "repo");
  const workflowDir = join(fixtureRoot, ".github", "workflows");
  const configPath = join(fixtureRoot, ".github", "workflow-config.yml");

  await writeFile(fakeGh, fakeGhSource);
  await chmod(fakeGh, 0o755);
  await writeFile(contractPath, contract);

  async function setRepoFixture({ claude = false, gemini = false, config = "" } = {}) {
    await rm(join(fixtureRoot, ".github"), { recursive: true, force: true });
    await mkdir(workflowDir, { recursive: true });
    if (claude) await writeFile(join(workflowDir, "claude.yml"), "name: Claude\n");
    if (gemini) await writeFile(join(workflowDir, "gemini-dispatch.yml"), "name: Gemini\n");
    if (config !== null) await writeFile(configPath, config);
  }

  async function runIssue(state, commands, overrides = {}) {
    await writeFile(statePath, JSON.stringify(state, null, 2));
    await writeFile(logPath, "");
    const env = {
      ...process.env,
      PATH: `${tempRoot}:${process.env.PATH}`,
      FAKE_GH_STATE: statePath,
      FAKE_GH_LOG: logPath,
      REPO_NWO: "example/repo",
      JHW_ISSUE_REPO_ROOT: fixtureRoot,
      JHW_ISSUE_CONFIG_PATH: configPath,
      JHW_ISSUE_TIMEOUT_MIN: "20",
      JHW_ISSUE_CODEX_CANARY_URL: "",
      JHW_ISSUE_STATE_DIR: tempRoot,
      JHW_ISSUE_STATE_FILE: summaryStatePath,
      ...overrides,
    };
    const script = `source ${JSON.stringify(contractPath)}\n${commands}`;
    const result = await execFileAsync("bash", ["-c", script], { env, maxBuffer: 1024 * 1024 });
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
    const codexOnly = await runIssue(
      issueState({
        labels: ["review:request", "review:skip"],
        canaryComments: [canaryRequest, canaryResponse],
      }),
      `jhw_issue_create 'Codex review' 'Body text' request 20`,
      { JHW_ISSUE_CODEX_CANARY_URL: canaryUrl },
    );
    assert.equal(codexOnly.state.issueComments.length, 1);
    assert.equal(
      codexOnly.state.issueComments[0].body,
      "@codex 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.\n<!-- jhw-issue:review-request reviewer=codex -->",
    );

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
          `export JHW_ISSUE_SIGNAL_JSON="$(jhw_issue_collect_signals 99 1001 '${issueCreatedAt}')"`,
          `jhw_issue_classify_reviewer ${reviewer} ${nowEpoch} ${triggerDeadline} ${reviewDeadline} || exit $?`,
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
        }],
      }),
      "claude",
      triggerDeadline - 1,
    );
    assert.equal(failedRun.stdout.split("\n")[0], "FAILED");
    assert.match(failedRun.stdout, /actions\/runs\/501/);

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

    console.log("issue skill contract: ok");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
