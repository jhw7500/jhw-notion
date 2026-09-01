#!/usr/bin/env node
// Consumer contract for canonical /jhw:pr review rounds and /jhw:ship alias.
// The canonical Markdown exposes executable Bash helpers; a stateful fake gh
// verifies trigger/current-round boundaries without touching GitHub.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPr = join(repoRoot, "skills", "claude", "pr.md");
const shipAlias = join(repoRoot, "skills", "claude", "ship.md");
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

function contractBlock(markdown) {
  const match = markdown.match(
    /<!-- pr-round-contract: trigger-and-scope:begin -->\n```bash\n([\s\S]*?)```\n<!-- pr-round-contract: trigger-and-scope:end -->/,
  );
  assert.ok(match, "pr skill must expose an executable auto-fix round contract");
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

if (argv[0] !== "api" || !argv[1]) process.exit(2);
const endpoint = argv[1];
if ((state.failEndpoints || []).some((part) => endpoint.includes(part))) process.exit(1);

if (endpoint === "user") {
  process.stdout.write(state.actor + "\n");
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
  const matching = state.issueComments.filter((item) =>
    (!actor || item.actor === actor) &&
    (markers.length === 0 || markers.some((marker) => item.body.includes(marker))));
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
  rows(state.runs.map((item) => [item.id, item.attempt, item.name, item.head, item.createdAt, item.status, item.conclusion].join("\t")));
  process.exit(0);
}

process.stderr.write("unexpected fake gh endpoint: " + endpoint + "\n");
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
    nextId: 9002,
    postCreatedAt: requestCreatedAt,
    issueComments: [],
    reviews: [],
    pullComments: [],
    issueReactions: [],
    commentReactions: [],
    runs: [],
    failEndpoints: [],
    failPost: false,
    ...overrides,
  };
}

async function main() {
  const prText = await readFile(canonicalPr, "utf8");
  const aliasText = await readFile(shipAlias, "utf8");
  assert.match(prText, /^# \/jhw:pr — PR 생성/m);
  assert.match(prText, /<!-- jhw-pr:codex-review round=/);
  assert.match(aliasText, /deprecated/i);
  assert.match(aliasText, /\/jhw:pr/);
  assert.doesNotMatch(aliasText, /pr-round-contract: trigger-and-scope:begin/);
  const contract = contractBlock(prText);
  const tempRoot = await mkdtemp(join(tmpdir(), "jhw-pr-contract-"));
  const fakeGh = join(tempRoot, "gh");
  const fakeDate = join(tempRoot, "date");
  const contractPath = join(tempRoot, "contract.bash");
  const statePath = join(tempRoot, "gh-state.json");
  const logPath = join(tempRoot, "gh-log.jsonl");
  const roundStatePath = join(tempRoot, "round.state");
  const nowEpochPath = join(tempRoot, "now-epoch");

  await writeFile(fakeGh, fakeGhSource);
  await chmod(fakeGh, 0o755);
  await writeFile(fakeDate, fakeDateSource);
  await chmod(fakeDate, 0o755);
  await writeFile(contractPath, contract);

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

  try {
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
    assert.match(idempotent.state.issueComments.find((item) => item.id === 9002).body,
      /^@codex review\n\n<!-- jhw-pr:codex-review round=2 head=[a-f0-9]{40} -->$/);
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
