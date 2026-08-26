#!/usr/bin/env node
// Consumer contracts for the canonical /jhw:task start gate. These execute
// each route through a strict fake installed launcher instead of matching prose.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalTask = join(repoRoot, "skills", "claude", "task.md");
const codexReference = join(repoRoot, "skills", "codex", "jhw-task", "references", "task.md");
const taskId = "tsk-018f1234-5678-7abc-8def-0123456789ab";
const claimId = "clm-018f1234-5678-7abc-8def-0123456789ac";
const worktreeRef = "wt-0123456789ab-created";
const issueUrl = "https://github.com/example/consumer/issues/74";
const sessionValue = "session verified $(printf session-expanded)";
const tempAlias = "temporary alias $(printf alias-expanded)";
const tempGoal = "goal with spaces $(printf goal-expanded)";
const doneValues = [
  "first done condition $(printf done-one-expanded)",
  "second done condition with spaces",
];
const scopeValues = [
  "skills/claude/task.md $(printf scope-one-expanded)",
  "scripts/test task contract.mjs",
];
const validationValue = "verified-validation $(printf validation-expanded)";
const outcomeValue = "verified-result $(printf outcome-expanded)";
const progressValue = "verified-progress $(printf progress-expanded)";
const failuresValue = "verified-failures $(printf failures-expanded)";
const nextStepValue = "verified-next-step $(printf next-step-expanded)";
const relatedEvidenceValue = "verified-evidence $(printf evidence-expanded)";
const exactReportingRule = "`task start` 성공 시 launcher result에서 오직 `task_id`, `claim_id`, `branch`, `worktree_ref` 네 필드만 사용자에게 보고하고 다른 result 필드는 보고하거나 출력하지 않는다.";
const exactSwitchRule = "finish는 절대 반복하지 않는다. 이후 start는 별도 사용자 승인을 받고 해당 error의 결과 해석 규칙이 허용할 때만 새로 실행하며, `REGISTRY_MOVED_DURING_READ`는 자동 retry나 explicit-mode fallback을 허용하지 않는다.";
const startedTaskEnvelope = {
  command: "task start",
  result: {
    task_id: taskId,
    claim_id: claimId,
    branch: "task/0123456789ab-created",
    worktree_ref: worktreeRef,
    project_id: "prj-resolved-extra",
    repo_id: "repo-resolved-extra",
  },
};
const readyPreflightEnvelope = {
  command: "preflight",
  result: {
    status: "ready",
    checks: {
      credentials: "ok",
      authority: "ok",
      notion_guard: "ok",
      project: "ok",
      registry_repository: "ok",
      registry_issue: "ok",
      registry_git: "ok",
    },
  },
};
const finishedTaskEnvelope = {
  command: "task finish",
  result: {
    task_id: taskId,
    claim_id: claimId,
    status: "completed",
    released_at: "2026-08-26T00:00:00.000Z",
    worktree_removed: false,
  },
};
const routes = [{ name: "formal" }, { name: "temporary" }, { name: "resume" }];

function contractBlock(markdown, name) {
  const match = markdown.match(
    new RegExp(`<!-- task-start-contract: ${name}:begin -->\\n` +
      "```bash\\n([\\s\\S]*?)```\\n" +
      `<!-- task-start-contract: ${name}:end -->`),
  );
  assert.ok(match, `task skill must expose executable ${name} Task-start contract`);
  return match[1];
}

function lifecycleContractBlock(markdown, name) {
  const match = markdown.match(
    new RegExp(`<!-- task-lifecycle-contract: ${name}:begin -->\\n` +
      "```bash\\n([\\s\\S]*?)```\\n" +
      `<!-- task-lifecycle-contract: ${name}:end -->`),
  );
  assert.ok(match, `task skill must expose executable ${name} Task-lifecycle contract`);
  return match[1];
}

function materialize(command) {
  return command
    .replaceAll("<owner>", "example")
    .replaceAll("<repo>", "consumer")
    .replaceAll("<number>", "74")
    .replaceAll("<alias>", tempAlias)
    .replaceAll("<temp-alias>", tempAlias)
    .replaceAll("<goal>", tempGoal)
    .replaceAll("<condition-1>", doneValues[0])
    .replaceAll("<condition-2>", doneValues[1])
    .replaceAll("<scope-1>", scopeValues[0])
    .replaceAll("<scope-2>", scopeValues[1])
    .replaceAll("<condition>", doneValues[0])
    .replaceAll("<scope>", scopeValues[0])
    .replaceAll("<tsk-id>", taskId)
    .replaceAll("<claim-id>", claimId)
    .replaceAll("<validation>", validationValue)
    .replaceAll("<result>", outcomeValue)
    .replaceAll("<progress>", progressValue)
    .replaceAll("<failures>", failuresValue)
    .replaceAll("<next-step>", nextStepValue)
    .replaceAll("<related-adr-and-evidence>", relatedEvidenceValue)
    .replaceAll("<session-id>", sessionValue);
}

function materializeLifecycle(command, { status, checkoutRoot = "" }) {
  return materialize(command)
    .replaceAll("<finish-status>", status)
    .replaceAll("<absolute-target-checkout-root>", checkoutRoot);
}

function expectedStartArgs(route, checkoutRoot) {
  if (route === "formal") {
    return [
      "task", "start", "--resolve-from-checkout", "true", "--repo-path", checkoutRoot,
      "--issue-url", issueUrl, "--session", sessionValue,
    ];
  }
  if (route === "temporary") {
    return [
      "task", "start", "--resolve-from-checkout", "true", "--repo-path", checkoutRoot,
      "--temp-alias", tempAlias, "--goal", tempGoal,
      "--done", doneValues[0], "--done", doneValues[1],
      "--scope", scopeValues[0], "--scope", scopeValues[1],
      "--session", sessionValue,
    ];
  }
  return ["task", "start", "--task", taskId, "--repo-path", checkoutRoot, "--session", sessionValue];
}

function expectedFinishArgs(status) {
  const base = ["task", "finish", "--task", taskId, "--claim", claimId, "--status", status];
  if (status === "completed") {
    return [...base, "--outcome", outcomeValue, "--validation", validationValue];
  }
  if (status === "handoff") {
    return [
      ...base, "--validation", validationValue,
      "--progress", progressValue,
      "--failures", failuresValue,
      "--next-step", nextStepValue,
      "--related-adr-and-evidence", relatedEvidenceValue,
    ];
  }
  return [...base, "--validation", validationValue];
}

const fakeLauncherSource = String.raw`#!/usr/bin/node
const { appendFileSync } = require("fs");
const argv = process.argv.slice(2);
appendFileSync(process.env.JHW_TASK_CONTRACT_LOG, JSON.stringify(argv) + "\n");
if (JSON.stringify(argv) === JSON.stringify(["preflight"])) {
  const exit = Number(process.env.JHW_TASK_CONTRACT_PREFLIGHT_EXIT);
  if (exit !== 0) process.exit(exit);
  process.stdout.write(process.env.JHW_TASK_CONTRACT_PREFLIGHT_PAYLOAD + "\n");
  process.exit(0);
}
if (argv[0] === "task" && argv[1] === "start") {
  const validStarts = JSON.parse(process.env.JHW_TASK_CONTRACT_VALID_STARTS);
  if (!validStarts.some((expected) => JSON.stringify(argv) === JSON.stringify(expected))) {
    process.stderr.write(JSON.stringify({ error: { code: "INVALID_TEST_ARGV" } }) + "\n");
    process.exit(64);
  }
  const error = process.env.JHW_TASK_CONTRACT_TASK_START_ERROR;
  if (error) {
    process.stderr.write(JSON.stringify({ error: { code: error } }) + "\n");
    process.exit(1);
  }
  const exit = Number(process.env.JHW_TASK_CONTRACT_TASK_START_EXIT);
  if (exit !== 0) {
    process.stderr.write(JSON.stringify({ error: { code: "TASK_START_TEST_FAILURE" } }) + "\n");
    process.exit(exit);
  }
  process.stdout.write(process.env.JHW_TASK_CONTRACT_TASK_START_PAYLOAD + "\n");
  process.exit(0);
}
if (argv[0] === "task" && argv[1] === "finish") {
  const validFinishes = JSON.parse(process.env.JHW_TASK_CONTRACT_VALID_FINISHES);
  if (!validFinishes.some((expected) => JSON.stringify(argv) === JSON.stringify(expected))) {
    process.stderr.write(JSON.stringify({ error: { code: "INVALID_TEST_ARGV" } }) + "\n");
    process.exit(64);
  }
  const exit = Number(process.env.JHW_TASK_CONTRACT_FINISH_EXIT);
  if (exit !== 0) {
    process.stderr.write(JSON.stringify({ error: { code: "FINISH_TEST_FAILURE" } }) + "\n");
    process.exit(exit);
  }
  const payload = JSON.parse(process.env.JHW_TASK_CONTRACT_FINISH_PAYLOAD);
  payload.result.status = argv[argv.indexOf("--status") + 1];
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(0);
}
process.exit(64);
`;

const fakeRawControlBashEnv = String.raw`jhw-control() {
  printf '%s\n' "$*" >> "$JHW_TASK_CONTRACT_RAW_LOG"
  return 97
}
export -f jhw-control
`;

async function createCheckout(root) {
  const checkout = join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: checkout });
  return checkout;
}

async function installFakeLauncher(root) {
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  const launcher = join(bin, "jhw-control-host");
  await mkdir(bin, { recursive: true });
  await writeFile(launcher, fakeLauncherSource, { mode: 0o755 });
  return { home, launcher };
}

async function installFakeRawControl(root) {
  const bashEnv = join(root, "fake-raw-control.bash");
  await writeFile(bashEnv, fakeRawControlBashEnv);
  return bashEnv;
}

function launcherEnv({
  home,
  log,
  rawLog,
  bashEnv,
  checkoutRoot,
  preflightExit = 0,
  taskStartExit = 0,
  taskStartError = "",
  finishExit = 0,
}) {
  return {
    HOME: home,
    PATH: "/usr/bin:/bin",
    BASH_ENV: bashEnv,
    JHW_TASK_CONTRACT_LOG: log,
    JHW_TASK_CONTRACT_RAW_LOG: rawLog,
    JHW_TASK_CONTRACT_PREFLIGHT_EXIT: String(preflightExit),
    JHW_TASK_CONTRACT_PREFLIGHT_PAYLOAD: JSON.stringify(readyPreflightEnvelope),
    JHW_TASK_CONTRACT_TASK_START_EXIT: String(taskStartExit),
    JHW_TASK_CONTRACT_TASK_START_ERROR: taskStartError,
    JHW_TASK_CONTRACT_TASK_START_PAYLOAD: JSON.stringify(startedTaskEnvelope),
    JHW_TASK_CONTRACT_VALID_STARTS: JSON.stringify(routes.map(({ name }) => expectedStartArgs(name, checkoutRoot))),
    JHW_TASK_CONTRACT_FINISH_EXIT: String(finishExit),
    JHW_TASK_CONTRACT_FINISH_PAYLOAD: JSON.stringify(finishedTaskEnvelope),
    JHW_TASK_CONTRACT_VALID_FINISHES: JSON.stringify([
      expectedFinishArgs("completed"),
      expectedFinishArgs("handoff"),
      expectedFinishArgs("abandoned"),
    ]),
  };
}

async function readCalls(path) {
  const content = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return content.trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function readRawCalls(path) {
  const content = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return content.trim().split("\n").filter(Boolean);
}

async function runWorkflow(markdown, route, {
  preflightExit = 0,
  taskStartExit = 0,
  taskStartError = "",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-skill-contract-"));
  try {
    const log = join(root, "launcher.log");
    const rawLog = join(root, "raw-control.log");
    const checkoutRoot = await createCheckout(root);
    const { home } = await installFakeLauncher(root);
    const bashEnv = await installFakeRawControl(root);
    const command = `${contractBlock(markdown, "gate")}\n${contractBlock(markdown, route.name)}`;
    const result = await execFileAsync("bash", ["-c", materialize(command)], {
      cwd: checkoutRoot,
      env: launcherEnv({
        home, log, rawLog, bashEnv, checkoutRoot, preflightExit, taskStartExit, taskStartError,
      }),
    }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (error) => ({ exitCode: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
    );
    const calls = await readCalls(log);
    const rawCalls = await readRawCalls(rawLog);
    return { ...result, calls, rawCalls, checkoutRoot };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runFinishWorkflow(markdown, { status, finishExit = 0 }) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-finish-contract-"));
  try {
    const log = join(root, "launcher.log");
    const rawLog = join(root, "raw-control.log");
    const checkoutRoot = await createCheckout(root);
    const { home } = await installFakeLauncher(root);
    const bashEnv = await installFakeRawControl(root);
    const command = materializeLifecycle(lifecycleContractBlock(markdown, "finish-standalone"), { status });
    const result = await execFileAsync("bash", ["-c", command], {
      cwd: checkoutRoot,
      env: launcherEnv({ home, log, rawLog, bashEnv, checkoutRoot, finishExit }),
    }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (error) => ({ exitCode: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
    );
    return {
      ...result,
      calls: await readCalls(log),
      rawCalls: await readRawCalls(rawLog),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runSwitchWorkflow(markdown, {
  status,
  target,
  finishExit = 0,
  taskStartExit = 0,
  taskStartError = "",
  invalidTargetRoot = false,
}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-switch-contract-"));
  try {
    const log = join(root, "launcher.log");
    const rawLog = join(root, "raw-control.log");
    const checkoutRoot = await createCheckout(root);
    const { home } = await installFakeLauncher(root);
    const bashEnv = await installFakeRawControl(root);
    const targetValue = invalidTargetRoot ? "relative-target" : checkoutRoot;
    const command = materializeLifecycle(lifecycleContractBlock(markdown, `switch-${target}`), {
      status,
      checkoutRoot: targetValue,
    });
    const result = await execFileAsync("bash", ["-c", command], {
      cwd: root,
      env: launcherEnv({
        home, log, rawLog, bashEnv, checkoutRoot, finishExit, taskStartExit, taskStartError,
      }),
    }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (error) => ({ exitCode: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
    );
    return {
      ...result,
      calls: await readCalls(log),
      rawCalls: await readRawCalls(rawLog),
      checkoutRoot,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function commandName(call) {
  return call.slice(0, 2).join(" ");
}

async function assertStrictLauncherOracle() {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-launcher-oracle-"));
  try {
    const log = join(root, "launcher.log");
    const rawLog = join(root, "raw-control.log");
    const checkoutRoot = "/checkout/oracle";
    const { home, launcher } = await installFakeLauncher(root);
    const bashEnv = await installFakeRawControl(root);
    const validFormal = expectedStartArgs("formal", checkoutRoot);
    const validTemporary = expectedStartArgs("temporary", checkoutRoot);
    const validResume = expectedStartArgs("resume", checkoutRoot);
    const invalidStarts = [
      validFormal.slice(0, -2),
      [...validFormal, "--task", taskId],
      [...validFormal, "--project", "prj-forbidden", "--repo-id", "repo-forbidden"],
      validTemporary.filter((value, index) => !([10, 11, 12, 13].includes(index))),
      [...validTemporary, "--issue-url", issueUrl],
      [...validResume, "--resolve-from-checkout", "true"],
      [...validTemporary, "[--done", "condition", "...]"],
    ];
    for (const argv of invalidStarts) {
      const result = await execFileAsync(launcher, argv, {
        env: launcherEnv({ home, log, rawLog, bashEnv, checkoutRoot }),
      }).then(
        () => ({ exitCode: 0, stderr: "" }),
        (error) => ({ exitCode: error.code, stderr: error.stderr ?? "" }),
      );
      assert.equal(result.exitCode, 64,
        `strict fake launcher must reject invalid argv: ${JSON.stringify(argv)}; stderr=${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stderr), { error: { code: "INVALID_TEST_ARGV" } });
    }
    const validCompleted = expectedFinishArgs("completed");
    const invalidFinishes = [
      validCompleted.slice(0, -2),
      validCompleted.filter((value) => value !== outcomeValue),
      [...validCompleted, "--progress", progressValue],
      [...expectedFinishArgs("handoff"), "--outcome", outcomeValue],
    ];
    for (const argv of invalidFinishes) {
      const result = await execFileAsync(launcher, argv, {
        env: launcherEnv({ home, log, rawLog, bashEnv, checkoutRoot }),
      }).then(
        () => ({ exitCode: 0, stderr: "" }),
        (error) => ({ exitCode: error.code, stderr: error.stderr ?? "" }),
      );
      assert.equal(result.exitCode, 64,
        `strict fake launcher must reject invalid finish argv: ${JSON.stringify(argv)}; stderr=${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stderr), { error: { code: "INVALID_TEST_ARGV" } });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertLauncherV3Fixtures() {
  assert.equal(readyPreflightEnvelope.command, "preflight");
  assert.equal(startedTaskEnvelope.command, "task start");
  assert.deepEqual(Object.keys(startedTaskEnvelope.result), [
    "task_id", "claim_id", "branch", "worktree_ref", "project_id", "repo_id",
  ], "producer fixture must contain extra safe fields so reporting is not fixture-tautological");
  assert.match(startedTaskEnvelope.result.task_id,
    /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(startedTaskEnvelope.result.claim_id,
    /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(startedTaskEnvelope.result.worktree_ref, /^wt-[a-z0-9][a-z0-9-]{1,120}$/);
  assert.equal(startedTaskEnvelope.result.branch, `task/${startedTaskEnvelope.result.worktree_ref.slice(3)}`);
  assert.equal(finishedTaskEnvelope.command, "task finish");
  assert.deepEqual(Object.keys(finishedTaskEnvelope.result), [
    "task_id", "claim_id", "status", "released_at", "worktree_removed",
  ]);
}

function assertStaticStartContract(label, markdown) {
  for (const removed of ["portfolio_state", "bind_portfolio_coordinates", "verified_checkout_slug"]) {
    assert.doesNotMatch(markdown, new RegExp(removed), `${label}: client portfolio binding must stay deleted`);
  }
  assert.doesNotMatch(markdown, /jhw-control-host" portfolio status/);
  assert.doesNotMatch(markdown, /(^|[^-])jhw-control task start/m);
  assert.doesNotMatch(markdown, /rtk git/);
  assert.ok(markdown.includes(exactReportingRule), `${label}: exact four-field reporting rule is required`);
  assert.ok(markdown.includes(exactSwitchRule), `${label}: exact separately-authorized switch-start rule is required`);
  assert.doesNotMatch(markdown, /start 재시도는 finish를 반복하지 않고 start만 다시 실행한다/);
  assert.match(markdown, /PROJECT_REPOSITORY_NOT_FOUND[^\n]*올바른 Project Record에 Repository를 등록/);
  assert.match(markdown, /PROJECT_REPOSITORY_AMBIGUOUS[^\n]*Project association을 하나로 줄/);
  assert.match(markdown,
    /PROJECT_REPOSITORY_NOT_FOUND[^\n]*PROJECT_REPOSITORY_AMBIGUOUS[^\n]*추측[^\n]*임의 선택[^\n]*자동 재시도[^\n]*explicit mode fallback[^\n]*금지/);
  assert.match(markdown,
    /resolver `task start`\/`task finish`[^\n]*REGISTRY_MOVED_DURING_READ[^\n]*자동 재실행 없이 멈추고 보고/);
  assert.match(markdown,
    /수동 재실행[^\n]*`status`[^\n]*`handoff`[^\n]*`assert-owner`[^\n]*`recover --action status`[^\n]*읽기 전용 명령에만 제한/);
}

function assertStaticFinishContract(label, markdown) {
  const lifecycleBlocks = [
    lifecycleContractBlock(markdown, "finish-standalone"),
    lifecycleContractBlock(markdown, "switch-formal"),
    lifecycleContractBlock(markdown, "switch-temporary"),
    lifecycleContractBlock(markdown, "switch-resume"),
  ];
  for (const block of lifecycleBlocks) {
    assert.doesNotMatch(block, /(^|[^-])jhw-control task finish/m,
      `${label}: releases must never call raw jhw-control`);
    assert.doesNotMatch(block, /jhw-control-host" preflight|portfolio status|\.env|source [^\n]*/,
      `${label}: lifecycle blocks rely only on launcher hidden preflight`);
  }
  assert.doesNotMatch(markdown, /(^|[^-])jhw-control task finish/m);
  assert.match(markdown, /이전 Claim은 이미 release/,
    `${label}: partial completion must report the already-released prior Claim`);
  assert.match(markdown, /rollback[^\n]*(?:하지 않|금지)|되돌리지 않는다/,
    `${label}: partial completion must not promise rollback`);
  assert.match(markdown, /target[^\n]*(?:PROJECT_REPOSITORY_NOT_FOUND|미등록)[^\n]*release 뒤|release[^\n]*(?:PROJECT_REPOSITORY_NOT_FOUND|미등록)/i,
    `${label}: target association errors after release must be explicit`);

  for (const literal of [
    "HANDOFF_RETRY_CONFLICT",
    "invalid_git_state_line",
    "duplicate_git_state_key",
    "unexpected_git_state_key",
    "missing_git_state_key",
    "invalid_git_state_count",
    "missing_git_identity",
    "invalid_dirty_digest",
    "legacy_dirty_evidence_ambiguous",
    "git_identity_changed",
    "dirty_delta_changed",
    "handoff_metadata_mismatch",
    "retry_fields_changed",
    "WORKTREE_DIRTY",
    "handoff_copy_not_plain_file",
    "INVALID_WORKTREE_INSPECTION",
    "duplicate_dirty_files",
  ]) assert.match(markdown, new RegExp(literal), `${label}: missing finish recovery literal ${literal}`);
  assert.match(markdown, /커밋된 Handoff가 정본/);
  assert.match(markdown, /자동 overwrite나 finish 재실행을 하지 않는다/);

  assert.match(markdown,
    /invalid_git_state_line[^\n]*duplicate_git_state_key[^\n]*unexpected_git_state_key[^\n]*missing_git_state_key[^\n]*invalid_git_state_count[^\n]*missing_git_identity[^\n]*invalid_dirty_digest[^\n]*(?:손상|복구|수정)/,
    `${label}: malformed committed Git-state evidence needs its own recovery action`);
  assert.match(markdown,
    /legacy_dirty_evidence_ambiguous[^\n]*(?:새 Handoff|새로 생성)/,
    `${label}: legacy evidence needs its own recovery action`);
  assert.match(markdown,
    /git_identity_changed[^\n]*dirty_delta_changed[^\n]*(?:되돌|새 Claim)/,
    `${label}: moved Git evidence needs its own recovery action`);
  assert.match(markdown,
    /handoff_metadata_mismatch[^\n]*retry_fields_changed[^\n]*(?:커밋된 필드|같은 필드)/,
    `${label}: retry field mismatches need their own recovery action`);
  assert.match(markdown,
    /WORKTREE_DIRTY[^\n]*handoff_copy_not_plain_file[^\n]*(?:멈|복구|regular file)/,
    `${label}: malformed local Handoff copy needs its own recovery action`);
  assert.match(markdown,
    /INVALID_WORKTREE_INSPECTION[^\n]*duplicate_dirty_files[^\n]*(?:멈|재실행|Git status)/,
    `${label}: duplicate inspection entries need their own recovery action`);
}

async function assertFinishConsumerContract(label, markdown) {
  for (const status of ["completed", "handoff", "abandoned"]) {
    const result = await runFinishWorkflow(markdown, { status });
    assert.equal(result.exitCode, 0, `${label} standalone ${status}: finish argv must pass`);
    assert.deepEqual(result.calls, [expectedFinishArgs(status)]);
    assert.deepEqual(result.rawCalls, [], `${label} standalone ${status}: raw control must not run`);
  }

  const switchCases = [
    { status: "completed", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
    { status: "completed", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
    { status: "completed", target: "resume", start: new RegExp(`--task ${taskId}`) },
    { status: "handoff", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
    { status: "handoff", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
    { status: "handoff", target: "resume", start: new RegExp(`--task ${taskId}`) },
    { status: "abandoned", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
    { status: "abandoned", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
    { status: "abandoned", target: "resume", start: new RegExp(`--task ${taskId}`) },
  ];

  for (const testCase of switchCases) {
    const result = await runSwitchWorkflow(markdown, testCase);
    assert.equal(result.exitCode, 0, `${label} switch ${testCase.status}/${testCase.target}: route must pass`);
    assert.deepEqual(result.calls.map(commandName), ["task finish", "task start"]);
    assert.deepEqual(result.rawCalls, [], `${label} switch must not invoke raw control`);
    assert.match(result.calls[0].join(" "), new RegExp(`--status ${testCase.status}`));
    assert.match(result.calls[0].join(" "), /--validation verified-validation/);
    assert.equal(result.calls[0].includes("--outcome"), testCase.status === "completed");
    if (testCase.status === "handoff") assert.match(result.calls[0].join(" "), /--progress verified-progress/);
    assert.match(result.calls[1].join(" "), testCase.start);
    if (testCase.target === "resume") {
      assert.doesNotMatch(result.calls[1].join(" "), /--resolve-from-checkout|--project|--repo-id/);
    } else {
      assert.doesNotMatch(result.calls[1].join(" "), /--project|--repo-id/);
    }
    assert.deepEqual(result.calls[0], expectedFinishArgs(testCase.status));
    assert.deepEqual(result.calls[1], expectedStartArgs(testCase.target, result.checkoutRoot));
  }

  const invalidTarget = await runSwitchWorkflow(markdown, {
    status: "handoff", target: "formal", invalidTargetRoot: true,
  });
  assert.notEqual(invalidTarget.exitCode, 0);
  assert.deepEqual(invalidTarget.calls, [], `${label}: target root rejection precedes lifecycle calls`);
  assert.deepEqual(invalidTarget.rawCalls, []);

  const finishFailure = await runSwitchWorkflow(markdown, {
    status: "handoff", target: "formal", finishExit: 23,
  });
  assert.equal(finishFailure.exitCode, 23);
  assert.deepEqual(finishFailure.calls.map(commandName), ["task finish"]);
  assert.deepEqual(finishFailure.rawCalls, []);

  const startFailure = await runSwitchWorkflow(markdown, {
    status: "completed", target: "temporary", taskStartExit: 24,
  });
  assert.equal(startFailure.exitCode, 24);
  assert.deepEqual(startFailure.calls.map(commandName), ["task finish", "task start"]);
  assert.equal(startFailure.calls.filter((call) => commandName(call) === "task finish").length, 1,
    `${label}: partial completion must not refinish`);
  assert.deepEqual(startFailure.rawCalls, []);

  for (const code of ["PROJECT_REPOSITORY_NOT_FOUND", "PROJECT_REPOSITORY_AMBIGUOUS"]) {
    const associationFailure = await runSwitchWorkflow(markdown, {
      status: "abandoned", target: "formal", taskStartError: code,
    });
    assert.equal(associationFailure.exitCode, 1);
    assert.deepEqual(associationFailure.calls.map(commandName), ["task finish", "task start"]);
    assert.deepEqual(JSON.parse(associationFailure.stderr), { error: { code } });
    assert.equal(associationFailure.calls.filter((call) => commandName(call) === "task finish").length, 1);
  }

  assertStaticFinishContract(label, markdown);
}

async function assertConsumerContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  for (const route of routes) {
    const success = await runWorkflow(markdown, route);
    assert.equal(success.exitCode, 0, `${label} ${route.name}: complete route argv must pass`);
    assert.deepEqual(success.calls, [["preflight"], expectedStartArgs(route.name, success.checkoutRoot)],
      `${label} ${route.name}: argv boundaries and complete route flags must be exact`);
    assert.equal(success.calls.filter((call) => commandName(call) === "task start").length, 1);
    assert.deepEqual(success.rawCalls, []);
    assert.deepEqual(JSON.parse(success.stdout), startedTaskEnvelope,
      `${label} ${route.name}: producer extras must reach the reporting boundary`);
  }
  assertStaticStartContract(label, markdown);

  const preflightFailure = await runWorkflow(markdown, routes[0], { preflightExit: 78 });
  assert.equal(preflightFailure.exitCode, 78);
  assert.deepEqual(preflightFailure.calls, [["preflight"]]);

  for (const code of ["PROJECT_REPOSITORY_NOT_FOUND", "PROJECT_REPOSITORY_AMBIGUOUS"]) {
    const failed = await runWorkflow(markdown, routes[0], { taskStartError: code });
    assert.equal(failed.exitCode, 1);
    assert.deepEqual(failed.calls, [["preflight"], expectedStartArgs("formal", failed.checkoutRoot)]);
    assert.deepEqual(JSON.parse(failed.stderr), { error: { code } });
    assert.doesNotMatch(failed.calls.flat().join("\n"), /portfolio status|--project|--repo-id/);
  }

  const moved = await runWorkflow(markdown, routes[0], { taskStartError: "REGISTRY_MOVED_DURING_READ" });
  assert.equal(moved.exitCode, 1);
  assert.deepEqual(moved.calls, [["preflight"], expectedStartArgs("formal", moved.checkoutRoot)]);
  assert.deepEqual(JSON.parse(moved.stderr), { error: { code: "REGISTRY_MOVED_DURING_READ" } });
  assert.doesNotMatch(moved.calls.flat().join("\n"), /portfolio status|--project|--repo-id/);
  await assertFinishConsumerContract(label, markdown);
}

async function main() {
  assertLauncherV3Fixtures();
  await assertStrictLauncherOracle();
  await assertConsumerContract("Claude canonical consumer", canonicalTask);
  assert.equal(await realpath(codexReference), await realpath(canonicalTask),
    "Codex task reference must resolve to the canonical Claude task skill");
  await assertConsumerContract("Codex generated reference consumer", codexReference);
  console.log("task skill consumer contracts: ok");
}

await main();
