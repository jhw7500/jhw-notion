#!/usr/bin/env node
// Consumer contracts for the canonical /jhw:task start gate. These execute
// each route through a strict fake installed launcher instead of matching prose.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalTask = join(repoRoot, "skills", "claude", "task.md");
const codexReference = join(repoRoot, "skills", "codex", "jhw-task", "references", "task.md");
const currentTaskId = "tsk-018f1234-5678-7abc-8def-0123456789ab";
const targetTaskId = "tsk-028f1234-5678-7abc-8def-0123456789ab";
const currentClaimId = "clm-018f1234-5678-7abc-8def-0123456789ac";
const startedClaimId = "clm-028f1234-5678-7abc-8def-0123456789ac";
const worktreeRef = "wt-0123456789ab-created";
const issueUrl = "https://github.com/example/consumer/issues/74";
const originAdapter = "codex";
const sessionValue = "session verified $(printf session-expanded)";
const tempAlias = "temporary alias $(printf alias-expanded)";
const tempGoal = "goal with spaces $(printf goal-expanded)";
const doneValues = [
  "first done condition $(printf done-one-expanded)",
  "second done condition with spaces",
  "third done condition with 'single quotes' and `printf done-three-expanded`",
];
const scopeValues = [
  "skills/claude/task.md $(printf scope-one-expanded)",
  "scripts/test task contract.mjs",
  "third scope with 'single quotes' and `printf scope-three-expanded`",
];
const validationValues = [
  "verified-validation $(printf validation-expanded)",
  "second validation `printf validation-backtick-expanded`",
];
const outcomeValue = "verified-result $(printf outcome-expanded)";
const progressValue = "verified-progress $(printf progress-expanded)";
const failuresValue = "verified-failures $(printf failures-expanded)";
const nextStepValue = "verified-next-step $(printf next-step-expanded)";
const relatedEvidenceValue = "verified-evidence $(printf evidence-expanded)";
const sourceRevisionValue = "source revision $(printf source-expanded)";
const activeWorkMinutesValue = "17.5";
const adversarialCheckoutName =
  "target checkout $(touch sentinel-dollar) `touch sentinel-backtick` 'single' \"double\" \\backslash";
const exactReportingRule = "`task start` 성공 시 launcher result에서 오직 `task_id`, `claim_id`, `branch`, `worktree_ref` 네 필드만 사용자에게 보고하고 다른 result 필드는 보고하거나 출력하지 않는다.";
const exactSwitchRule = "finish는 절대 반복하지 않는다. 이후 start는 별도 사용자 승인을 받고 해당 error의 결과 해석 규칙이 허용할 때만 새로 실행하며, `REGISTRY_MOVED_DURING_READ`는 자동 retry나 explicit-mode fallback을 허용하지 않는다.";
const startedTaskEnvelope = {
  command: "task start",
  result: {
    task_id: targetTaskId,
    claim_id: startedClaimId,
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
    task_id: currentTaskId,
    claim_id: currentClaimId,
    status: "completed",
    released_at: "2026-08-26T00:00:00.000Z",
    worktree_removed: false,
  },
};
const inactiveDiscoveryEnvelope = {
  command: "task recover",
  result: {
    kind: "resolved",
    task_id: targetTaskId,
    state: "inactive",
    handoff: { available: false },
  },
};
const activeDiscoveryEnvelope = {
  command: "task recover",
  result: {
    kind: "resolved",
    task_id: targetTaskId,
    state: "active",
    claim: {
      task_id: targetTaskId,
      claim_id: startedClaimId,
      host: "build-host",
      branch: "task/0123456789ab-created",
      worktree_ref: worktreeRef,
      started_at: "2026-08-26T00:00:00.000Z",
    },
    recovery: {
      process_exists: false,
      worktree_mapped: true,
      dirty: false,
      ahead: 0,
    },
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

function optionalLifecycleContractBlock(markdown, name) {
  const match = markdown.match(
    new RegExp(`<!-- task-lifecycle-contract: ${name}:begin -->\\n` +
      "```bash\\n([\\s\\S]*?)```\\n" +
      `<!-- task-lifecycle-contract: ${name}:end -->`),
  );
  return match?.[1];
}

function reportContractBlock(markdown) {
  const match = markdown.match(
    /<!-- task-report-contract: start-success:begin -->\n```javascript\n([\s\S]*?)```\n<!-- task-report-contract: start-success:end -->/,
  );
  assert.ok(match, "task skill must expose executable exact four-field start reporting recipe");
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
    .replaceAll("<tsk-id>", targetTaskId)
    .replaceAll("<result>", outcomeValue)
    .replaceAll("<progress>", progressValue)
    .replaceAll("<failures>", failuresValue)
    .replaceAll("<next-step>", nextStepValue)
    .replaceAll("<related-adr-and-evidence>", relatedEvidenceValue)
    .replaceAll("<claude|codex|gemini|opencode>", originAdapter)
    .replaceAll("<session-id>", sessionValue);
}

function materializeLegacyLifecycle(command, { status, checkoutRoot = "", finishInput }) {
  return command
    .replaceAll("<owner>", "example")
    .replaceAll("<repo>", "consumer")
    .replaceAll("<number>", "74")
    .replaceAll("<temp-alias>", tempAlias)
    .replaceAll("<goal>", tempGoal)
    .replaceAll("<condition-1>", doneValues[0])
    .replaceAll("<condition-2>", doneValues[1])
    .replaceAll("<scope-1>", scopeValues[0])
    .replaceAll("<scope-2>", scopeValues[1])
    .replaceAll("<tsk-id>", currentTaskId)
    .replaceAll("<claim-id>", currentClaimId)
    .replaceAll("<validation>", finishInput.validations[0] ?? "")
    .replaceAll("<result>", finishInput.outcome)
    .replaceAll("<progress>", finishInput.progress)
    .replaceAll("<failures>", finishInput.failures)
    .replaceAll("<next-step>", finishInput.nextStep)
    .replaceAll("<related-adr-and-evidence>", finishInput.relatedEvidence)
    .replaceAll("<session-id>", sessionValue)
    .replaceAll("<finish-status>", status)
    .replaceAll("<absolute-target-checkout-root>", checkoutRoot);
}

function expectedStartArgs(route, checkoutRoot) {
  if (route === "formal") {
    return [
      "task", "start", "--resolve-from-checkout", "true", "--repo-path", checkoutRoot,
      "--issue-url", issueUrl, "--origin-adapter", originAdapter, "--session", sessionValue,
    ];
  }
  if (route === "temporary") {
    const args = [
      "task", "start", "--resolve-from-checkout", "true", "--repo-path", checkoutRoot,
      "--temp-alias", tempAlias, "--goal", tempGoal,
    ];
    for (const done of doneValues) args.push("--done", done);
    for (const scope of scopeValues) args.push("--scope", scope);
    args.push("--origin-adapter", originAdapter, "--session", sessionValue);
    return args;
  }
  return [
    "task", "start", "--task", targetTaskId, "--repo-path", checkoutRoot,
    "--origin-adapter", originAdapter, "--session", sessionValue,
  ];
}

function expectedRecoveryDiscoveryArgs(checkoutRoot) {
  return [
    "task", "recover", "--action", "status",
    "--resolve-from-checkout", "true", "--repo-path", checkoutRoot,
    "--issue-url", issueUrl,
  ];
}

function makeFinishInput(status, overrides = {}) {
  return {
    status,
    outcome: status === "completed" ? outcomeValue : "",
    sourceRevision: "",
    activeWorkMinutes: "",
    progress: "",
    failures: "",
    nextStep: "",
    relatedEvidence: "",
    validations: [validationValues[0]],
    ...overrides,
  };
}

function expectedFinishArgs(input) {
  const base = [
    "task", "finish", "--task", currentTaskId, "--claim", currentClaimId,
    "--status", input.status,
  ];
  if (input.status === "completed") {
    base.push("--outcome", input.outcome);
  }
  if (input.status === "handoff") {
    if (input.progress) base.push("--progress", input.progress);
    if (input.failures) base.push("--failures", input.failures);
    if (input.nextStep) base.push("--next-step", input.nextStep);
    if (input.relatedEvidence) base.push("--related-adr-and-evidence", input.relatedEvidence);
  }
  if (input.status === "handoff" && input.sourceRevision) {
    base.push("--source-task-revision", input.sourceRevision);
  }
  if (input.activeWorkMinutes) base.push("--active-work-minutes", input.activeWorkMinutes);
  for (const validation of input.validations) base.push("--validation", validation);
  return base;
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
if (argv[0] === "task" && argv[1] === "recover") {
  const expected = JSON.parse(process.env.JHW_TASK_CONTRACT_VALID_RECOVERY);
  if (JSON.stringify(argv) !== JSON.stringify(expected)) {
    process.stderr.write(JSON.stringify({ error: { code: "INVALID_TEST_ARGV" } }) + "\n");
    process.exit(64);
  }
  process.stdout.write(process.env.JHW_TASK_CONTRACT_RECOVERY_PAYLOAD + "\n");
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

async function createCheckout(root, name = "checkout") {
  const checkout = join(root, name);
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
  finishInput = makeFinishInput("handoff"),
  targetCheckout = checkoutRoot,
  recoveryPayload = inactiveDiscoveryEnvelope,
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
    JHW_TASK_CONTRACT_VALID_FINISHES: JSON.stringify([expectedFinishArgs(finishInput)]),
    JHW_TASK_CONTRACT_VALID_RECOVERY: JSON.stringify(expectedRecoveryDiscoveryArgs(checkoutRoot)),
    JHW_TASK_CONTRACT_RECOVERY_PAYLOAD: JSON.stringify(recoveryPayload),
    JHW_FINISH_STATUS: finishInput.status,
    JHW_CURRENT_TASK_ID: currentTaskId,
    JHW_CURRENT_CLAIM_ID: currentClaimId,
    JHW_FINISH_OUTCOME: finishInput.outcome,
    JHW_SOURCE_TASK_REVISION: finishInput.sourceRevision,
    JHW_ACTIVE_WORK_MINUTES: finishInput.activeWorkMinutes,
    JHW_HANDOFF_PROGRESS: finishInput.progress,
    JHW_HANDOFF_FAILURES: finishInput.failures,
    JHW_HANDOFF_NEXT_STEP: finishInput.nextStep,
    JHW_HANDOFF_RELATED_EVIDENCE: finishInput.relatedEvidence,
    JHW_TARGET_CHECKOUT: targetCheckout,
    JHW_TARGET_TASK_ID: targetTaskId,
    JHW_TARGET_ISSUE_URL: issueUrl,
    JHW_ORIGIN_ADAPTER: originAdapter,
    JHW_SESSION_VALUE: sessionValue,
    JHW_TEMP_ALIAS: tempAlias,
    JHW_TEMP_GOAL: tempGoal,
    JHW_DONE_COUNT: String(doneValues.length),
    JHW_SCOPE_COUNT: String(scopeValues.length),
    ...Object.fromEntries(doneValues.map((value, index) => [`JHW_DONE_${index + 1}`, value])),
    ...Object.fromEntries(scopeValues.map((value, index) => [`JHW_SCOPE_${index + 1}`, value])),
  };
}

async function runRecoveryDiscovery(markdown, recoveryPayload = inactiveDiscoveryEnvelope) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-recovery-discovery-contract-"));
  try {
    const log = join(root, "launcher.log");
    const rawLog = join(root, "raw-control.log");
    const checkoutRoot = await createCheckout(root);
    const { home } = await installFakeLauncher(root);
    const bashEnv = await installFakeRawControl(root);
    const command = `${contractBlock(markdown, "gate")}\n${lifecycleContractBlock(markdown, "recovery-discovery")}`;
    const result = await execFileAsync("bash", ["-c", command], {
      cwd: checkoutRoot,
      env: launcherEnv({ home, log, rawLog, bashEnv, checkoutRoot, recoveryPayload }),
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

async function pathExists(path) {
  return access(path).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function composedFinishCommand(markdown) {
  return optionalLifecycleContractBlock(markdown, "finish") ??
    lifecycleContractBlock(markdown, "finish-standalone");
}

function composedSwitchCommand(markdown, target, legacyValues) {
  const finish = optionalLifecycleContractBlock(markdown, "finish");
  const targetRoot = optionalLifecycleContractBlock(markdown, "switch-target-root");
  const start = optionalLifecycleContractBlock(markdown, `switch-${target}-start`);
  if (finish && targetRoot && start) return `${targetRoot}\n${finish}\n${start}`;
  return materializeLegacyLifecycle(
    lifecycleContractBlock(markdown, `switch-${target}`),
    legacyValues,
  );
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
  envOverrides = {},
  omittedEnv = [],
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-skill-contract-"));
  try {
    const log = join(root, "launcher.log");
    const rawLog = join(root, "raw-control.log");
    const checkoutRoot = await createCheckout(root);
    const { home } = await installFakeLauncher(root);
    const bashEnv = await installFakeRawControl(root);
    const command = `${contractBlock(markdown, "gate")}\n${contractBlock(markdown, route.name)}`;
    const env = {
      ...launcherEnv({
        home, log, rawLog, bashEnv, checkoutRoot, preflightExit, taskStartExit, taskStartError,
      }),
      ...envOverrides,
    };
    for (const key of omittedEnv) delete env[key];
    const result = await execFileAsync("bash", ["-c", materialize(command)], {
      cwd: checkoutRoot,
      env,
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

async function runStartReportingRecipe(markdown) {
  const result = await execFileAsync(process.execPath, ["-e", reportContractBlock(markdown)], {
    env: {
      PATH: "/usr/bin:/bin",
      JHW_TASK_START_ENVELOPE: JSON.stringify(startedTaskEnvelope),
    },
  });
  return JSON.parse(result.stdout);
}

async function runFinishWorkflow(markdown, { finishInput, finishExit = 0 }) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-finish-contract-"));
  try {
    const log = join(root, "launcher.log");
    const rawLog = join(root, "raw-control.log");
    const checkoutRoot = await createCheckout(root);
    const { home } = await installFakeLauncher(root);
    const bashEnv = await installFakeRawControl(root);
    const canonical = optionalLifecycleContractBlock(markdown, "finish");
    const command = canonical ?? materializeLegacyLifecycle(
      lifecycleContractBlock(markdown, "finish-standalone"),
      { status: finishInput.status, finishInput },
    );
    const result = await execFileAsync("bash", ["-c", command, "task-finish-contract", ...finishInput.validations], {
      cwd: checkoutRoot,
      env: launcherEnv({ home, log, rawLog, bashEnv, checkoutRoot, finishExit, finishInput }),
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
  adversarialTargetRoot = false,
  finishInput = makeFinishInput(status),
}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-switch-contract-"));
  try {
    const log = join(root, "launcher.log");
    const rawLog = join(root, "raw-control.log");
    const checkoutRoot = await createCheckout(
      root,
      adversarialTargetRoot ? adversarialCheckoutName : "checkout",
    );
    const { home } = await installFakeLauncher(root);
    const bashEnv = await installFakeRawControl(root);
    const targetValue = invalidTargetRoot ? "relative-target" : checkoutRoot;
    const command = composedSwitchCommand(markdown, target, {
      status,
      checkoutRoot: targetValue,
      finishInput,
    });
    const result = await execFileAsync(
      "bash",
      ["-c", command, "task-switch-contract", ...finishInput.validations],
      {
      cwd: root,
      env: launcherEnv({
        home,
        log,
        rawLog,
        bashEnv,
        checkoutRoot,
        finishExit,
        taskStartExit,
        taskStartError,
        finishInput,
        targetCheckout: targetValue,
      }),
      },
    ).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (error) => ({ exitCode: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
    );
    return {
      ...result,
      calls: await readCalls(log),
      rawCalls: await readRawCalls(rawLog),
      checkoutRoot,
      sentinelExecuted: await Promise.all([
        pathExists(join(root, "sentinel-dollar")),
        pathExists(join(root, "sentinel-backtick")),
      ]).then((values) => values.some(Boolean)),
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
      [...validFormal, "--task", targetTaskId],
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
    const validRecovery = expectedRecoveryDiscoveryArgs(checkoutRoot);
    const invalidRecoveries = [
      [...validRecovery, "--expect", currentClaimId],
      [...validRecovery, "--session", sessionValue],
      validRecovery.filter((value) => value !== issueUrl),
      validRecovery.map((value) => value === "status" ? "takeover" : value),
    ];
    for (const argv of invalidRecoveries) {
      const result = await execFileAsync(launcher, argv, {
        env: launcherEnv({ home, log, rawLog, bashEnv, checkoutRoot }),
      }).then(
        () => ({ exitCode: 0, stderr: "" }),
        (error) => ({ exitCode: error.code, stderr: error.stderr ?? "" }),
      );
      assert.equal(result.exitCode, 64,
        `strict fake launcher must reject invalid recovery argv: ${JSON.stringify(argv)}; stderr=${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stderr), { error: { code: "INVALID_TEST_ARGV" } });
    }
    const completedInput = makeFinishInput("completed");
    const handoffInput = makeFinishInput("handoff");
    const validCompleted = expectedFinishArgs(completedInput);
    const invalidFinishes = [
      { argv: validCompleted.slice(0, -2), input: completedInput },
      { argv: validCompleted.filter((value) => value !== outcomeValue), input: completedInput },
      { argv: [...validCompleted, "--progress", progressValue], input: completedInput },
      { argv: [...expectedFinishArgs(handoffInput), "--outcome", outcomeValue], input: handoffInput },
      {
        argv: [
          "task", "finish", "--task", currentTaskId, "--claim", currentClaimId,
          "--status", "completed", "--outcome", outcomeValue,
          "--source-task-revision", sourceRevisionValue,
          "--validation", validationValues[0],
        ],
        input: completedInput,
      },
      {
        argv: [
          "task", "finish", "--task", currentTaskId, "--claim", currentClaimId,
          "--status", "abandoned", "--source-task-revision", sourceRevisionValue,
          "--validation", validationValues[0],
        ],
        input: makeFinishInput("abandoned"),
      },
    ];
    for (const { argv, input } of invalidFinishes) {
      const result = await execFileAsync(launcher, argv, {
        env: launcherEnv({ home, log, rawLog, bashEnv, checkoutRoot, finishInput: input }),
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
  assert.notEqual(currentTaskId, targetTaskId,
    "strict oracle must distinguish the released Task from the resumed target Task");
  assert.notEqual(currentClaimId, startedClaimId,
    "strict oracle must distinguish the released Claim from the new Claim");
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

const hostOnlyLifecycleCounts = new Map([
  ["child-start", 1],
  ["contract", 2],
  ["completion-ready", 1],
  ["promote", 1],
  ["status", 1],
  ["handoff", 1],
  ["recover", 5],
  ["assert-owner", 1],
]);

const recoveryInterpretationRules = [
  "`inactive`: 반환된 canonical `task_id`를 기존 Task 재개 block의 `--task`에 사용하고 registration field는 보내지 않는다.",
  "`active`: `task_id`, `claim_id`, `host`, `branch`, `worktree_ref`, `started_at` 여섯 Claim 좌표와 recovery observations만 보여주고, 별도 승인 전에는 멈춘다.",
  "`handoff.available: false`: exact latest generation에는 Handoff가 없다는 뜻이다.",
  "`process_exists: false`: recovery observation일 뿐 stale 판정이 아니다.",
  "takeover 성공 후에는 반환된 새 `claim_id`만 사용해 `task status`를 확인한다.",
  "`TASK_CONTRACT_MISMATCH`: checkout recovery discovery로 canonical Task를 찾고 formal registration을 반복하지 않는다.",
  "`TASK_ALREADY_CLAIMED`: 반환된 exact Claim 좌표를 recovery status로 확인하고 자동 takeover하지 않는다.",
];

function assertStaticRecoveryDiscoveryContract(label, markdown) {
  const block = lifecycleContractBlock(markdown, "recovery-discovery");
  const exactBlock = [
    '"$HOME/.local/bin/jhw-control-host" task recover \\',
    "  --action status \\",
    "  --resolve-from-checkout true \\",
    '  --repo-path "$REPOSITORY_PATH" \\',
    '  --issue-url "$JHW_TARGET_ISSUE_URL"',
  ].join("\n");
  assert.equal(block.trimEnd(), exactBlock,
    `${label}: recovery discovery argv must remain exact`);
  for (const rule of recoveryInterpretationRules) {
    assert.ok(markdown.includes(rule), `${label}: missing recovery rule: ${rule}`);
  }
}

async function assertRecoveryDiscoveryConsumerContract(label, markdown) {
  const inactive = await runRecoveryDiscovery(markdown, inactiveDiscoveryEnvelope);
  assert.equal(inactive.exitCode, 0);
  assert.deepEqual(inactive.calls, [
    ["preflight"],
    expectedRecoveryDiscoveryArgs(inactive.checkoutRoot),
  ]);
  assert.deepEqual(inactive.rawCalls, []);
  const inactiveResult = JSON.parse(inactive.stdout).result;
  assert.equal(inactiveResult.state, "inactive");
  assert.equal(inactiveResult.task_id, targetTaskId);
  assert.deepEqual(inactiveResult.handoff, { available: false });

  const resumed = await runWorkflow(markdown, { name: "resume" });
  assert.equal(resumed.exitCode, 0);
  assert.deepEqual(resumed.calls, [
    ["preflight"],
    expectedStartArgs("resume", resumed.checkoutRoot),
  ]);
  assert.equal(resumed.calls[1][3], inactiveResult.task_id,
    `${label}: inactive discovery must feed its returned Task ID to resume`);
  assert.doesNotMatch(resumed.calls[1].join(" "),
    /--resolve-from-checkout|--issue-url|--project|--repo-id|--grant|--depends/,
    `${label}: inactive resume must not repeat registration fields`);

  const active = await runRecoveryDiscovery(markdown, activeDiscoveryEnvelope);
  assert.equal(active.exitCode, 0);
  assert.deepEqual(active.calls, [
    ["preflight"],
    expectedRecoveryDiscoveryArgs(active.checkoutRoot),
  ]);
  assert.deepEqual(active.rawCalls, []);
  assert.equal(active.calls.some((call) => call.includes("takeover")), false,
    `${label}: active discovery must never auto-takeover`);
  const activeResult = JSON.parse(active.stdout).result;
  assert.equal(activeResult.state, "active");
  assert.deepEqual(Object.keys(activeResult.claim), [
    "task_id", "claim_id", "host", "branch", "worktree_ref", "started_at",
  ]);
  assert.equal(activeResult.recovery.process_exists, false,
    `${label}: process absence remains an observation, not a stale verdict`);

  for (const code of ["TASK_CONTRACT_MISMATCH", "TASK_ALREADY_CLAIMED"]) {
    const failedStart = await runWorkflow(markdown, { name: "formal" }, { taskStartError: code });
    assert.equal(failedStart.exitCode, 1);
    assert.deepEqual(failedStart.calls.map(commandName), ["preflight", "task start"]);
    const discovered = await runRecoveryDiscovery(markdown, activeDiscoveryEnvelope);
    assert.deepEqual(discovered.calls.map(commandName), ["preflight", "task recover"]);
    assert.equal(discovered.calls.some((call) => call.includes("takeover")), false);
  }
}

function assertHostOnlyLifecycleContract(label, markdown) {
  assert.doesNotMatch(markdown, /(^|[^-])jhw-control task(?:\s|$)/m,
    `${label}: raw Task lifecycle invocation must not remain`);
  for (const [subcommand, expectedCount] of hostOnlyLifecycleCounts) {
    const absoluteInvocation = new RegExp(
      `^"\\$HOME/\\.local/bin/jhw-control-host" task ${subcommand}(?: \\\\| |$)`,
      "gm",
    );
    assert.equal(markdown.match(absoluteInvocation)?.length ?? 0, expectedCount,
      `${label}: ${subcommand} must use the absolute host exactly ${expectedCount} time(s)`);
  }
}

function assertStaticFinishContract(label, markdown) {
  const lifecycleBlocks = [
    lifecycleContractBlock(markdown, "finish"),
    lifecycleContractBlock(markdown, "switch-target-root"),
    lifecycleContractBlock(markdown, "switch-formal-start"),
    lifecycleContractBlock(markdown, "switch-temporary-start"),
    lifecycleContractBlock(markdown, "switch-resume-start"),
  ];
  for (const block of lifecycleBlocks) {
    assert.doesNotMatch(block, /(^|[^-])jhw-control task finish/m,
      `${label}: releases must never call raw jhw-control`);
    assert.doesNotMatch(block, /jhw-control-host" preflight|portfolio status|\.env|source [^\n]*/,
      `${label}: lifecycle blocks rely only on launcher hidden preflight`);
  }
  assert.equal(markdown.match(/finish_args=\(task finish/g)?.length, 1,
    `${label}: task finish argv builder must have one canonical executable source`);
  assert.equal(markdown.match(/jhw-control-host" "\$\{finish_args\[@\]\}"/g)?.length, 1,
    `${label}: absolute host finish invocation must have one canonical executable source`);
  assert.equal(markdown.match(/case "\$finish_status" in/g)?.length, 1,
    `${label}: status dispatch must exist only in the canonical finish block`);
  for (const removedMarker of ["finish-standalone", "switch-formal", "switch-temporary", "switch-resume"]) {
    assert.doesNotMatch(markdown, new RegExp(`task-lifecycle-contract: ${removedMarker}:begin`),
      `${label}: copied lifecycle block ${removedMarker} must stay removed`);
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

async function assertReviewFixes(label, markdown) {
  const checks = [
    {
      name: "Handoff-only fields stop before completed/abandoned launcher calls",
      run: async () => {
        const handoffOnlyOverrides = [
          { sourceRevision: sourceRevisionValue },
          { progress: progressValue },
          { failures: failuresValue },
          { nextStep: nextStepValue },
          { relatedEvidence: relatedEvidenceValue },
        ];
        const cases = ["completed", "abandoned"].flatMap((status) =>
          handoffOnlyOverrides.map((overrides) => ({ status, overrides })));
        const results = await Promise.allSettled(cases.map(async ({ status, overrides }) => {
          const finishInput = makeFinishInput(status, overrides);
          const result = await runFinishWorkflow(markdown, { finishInput });
          assert.notEqual(result.exitCode, 0,
            `${status} must reject Handoff-only fields before finish`);
          assert.deepEqual(result.calls, [],
            `${status} must not send Handoff-only fields to the launcher`);
          assert.deepEqual(result.rawCalls, []);
        }));
        const failures = results.flatMap((result, index) => result.status === "rejected"
          ? [`${cases[index].status}/${Object.keys(cases[index].overrides)[0]}: ${result.reason.message}`]
          : []);
        assert.deepEqual(failures, [], failures.join("\n"));
      },
    },
    {
      name: "minimal and optional/repeated Handoff argv",
      run: async () => {
        for (const finishInput of [
          makeFinishInput("handoff"),
          makeFinishInput("handoff", { progress: progressValue }),
          makeFinishInput("handoff", { failures: failuresValue }),
          makeFinishInput("handoff", { nextStep: nextStepValue }),
          makeFinishInput("handoff", { relatedEvidence: relatedEvidenceValue }),
          makeFinishInput("handoff", { validations: validationValues }),
          makeFinishInput("handoff", { sourceRevision: sourceRevisionValue }),
          makeFinishInput("handoff", { activeWorkMinutes: activeWorkMinutesValue }),
          makeFinishInput("handoff", {
            progress: progressValue,
            failures: failuresValue,
            nextStep: nextStepValue,
            relatedEvidence: relatedEvidenceValue,
            sourceRevision: sourceRevisionValue,
            activeWorkMinutes: activeWorkMinutesValue,
            validations: validationValues,
          }),
        ]) {
          const result = await runFinishWorkflow(markdown, { finishInput });
          assert.equal(result.exitCode, 0);
          assert.deepEqual(result.calls, [expectedFinishArgs(finishInput)]);
          assert.deepEqual(result.rawCalls, []);
        }
      },
    },
    {
      name: "distinct current and resumed target Task IDs",
      run: async () => {
        const finishInput = makeFinishInput("completed");
        const result = await runSwitchWorkflow(markdown, {
          status: "completed", target: "resume", finishInput,
        });
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.calls, [
          expectedFinishArgs(finishInput),
          expectedStartArgs("resume", result.checkoutRoot),
        ]);
        assert.equal(result.calls[0][3], currentTaskId);
        assert.equal(result.calls[1][3], targetTaskId);
        assert.notEqual(result.calls[0][3], result.calls[1][3]);
      },
    },
    {
      name: "adversarial target checkout argv boundary",
      run: async () => {
        const finishInput = makeFinishInput("handoff");
        const result = await runSwitchWorkflow(markdown, {
          status: "handoff",
          target: "formal",
          finishInput,
          adversarialTargetRoot: true,
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.sentinelExecuted, false, "target root text must never execute shell substitutions");
        assert.deepEqual(result.calls[1], expectedStartArgs("formal", result.checkoutRoot),
          "adversarial target root must remain one exact --repo-path argv value");
      },
    },
    {
      name: "single-source composed finish contract",
      run: async () => assertStaticFinishContract(label, markdown),
    },
  ];
  const results = await Promise.allSettled(checks.map(({ run }) => run()));
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`${checks[index].name}: ${result.reason?.message ?? result.reason}`]
    : []);
  assert.deepEqual(failures, [], `${label}: review-fix contract failures:\n${failures.join("\n")}`);
}

async function assertFinishConsumerContract(label, markdown) {
  await assertReviewFixes(label, markdown);

  for (const status of ["completed", "handoff", "abandoned"]) {
    const finishInput = makeFinishInput(status);
    const result = await runFinishWorkflow(markdown, { finishInput });
    assert.equal(result.exitCode, 0, `${label} standalone ${status}: finish argv must pass`);
    assert.deepEqual(result.calls, [expectedFinishArgs(finishInput)]);
    assert.deepEqual(result.rawCalls, [], `${label} standalone ${status}: raw control must not run`);
  }

  const switchCases = [
    { status: "completed", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
    { status: "completed", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
    { status: "completed", target: "resume", start: new RegExp(`--task ${targetTaskId}`) },
    { status: "handoff", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
    { status: "handoff", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
    { status: "handoff", target: "resume", start: new RegExp(`--task ${targetTaskId}`) },
    { status: "abandoned", target: "formal", start: /--resolve-from-checkout true.*--issue-url/ },
    { status: "abandoned", target: "temporary", start: /--resolve-from-checkout true.*--temp-alias/ },
    { status: "abandoned", target: "resume", start: new RegExp(`--task ${targetTaskId}`) },
  ];

  for (const testCase of switchCases) {
    const finishInput = makeFinishInput(testCase.status);
    const result = await runSwitchWorkflow(markdown, { ...testCase, finishInput });
    assert.equal(result.exitCode, 0, `${label} switch ${testCase.status}/${testCase.target}: route must pass`);
    assert.deepEqual(result.calls.map(commandName), ["task finish", "task start"]);
    assert.deepEqual(result.rawCalls, [], `${label} switch must not invoke raw control`);
    assert.match(result.calls[0].join(" "), new RegExp(`--status ${testCase.status}`));
    assert.match(result.calls[0].join(" "), /--validation verified-validation/);
    assert.equal(result.calls[0].includes("--outcome"), testCase.status === "completed");
    assert.match(result.calls[1].join(" "), testCase.start);
    if (testCase.target === "resume") {
      assert.doesNotMatch(result.calls[1].join(" "), /--resolve-from-checkout|--project|--repo-id/);
    } else {
      assert.doesNotMatch(result.calls[1].join(" "), /--project|--repo-id/);
    }
    assert.deepEqual(result.calls[0], expectedFinishArgs(finishInput));
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
}

async function assertRepeatableTemporaryInputs(taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  const cases = [
    {
      name: "direct Temporary start forwards every done and scope",
      run: async () => {
        const result = await runWorkflow(markdown, { name: "temporary" });
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.calls[1], expectedStartArgs("temporary", result.checkoutRoot));
      },
    },
    {
      name: "switch Temporary start forwards every done and scope",
      run: async () => {
        const finishInput = makeFinishInput("completed");
        const result = await runSwitchWorkflow(markdown, {
          status: "completed",
          target: "temporary",
          finishInput,
        });
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.calls[1], expectedStartArgs("temporary", result.checkoutRoot));
      },
    },
  ];
  const results = await Promise.allSettled(cases.map(({ run }) => run()));
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`${cases[index].name}: ${result.reason?.message ?? result.reason}`]
    : []);
  assert.deepEqual(failures, [], `repeatable Temporary input failures:\n${failures.join("\n")}`);
}

async function assertInvalidRepeatableTemporaryInputs(taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  const cases = [
    { name: "zero done count", envOverrides: { JHW_DONE_COUNT: "0" } },
    { name: "non-decimal scope count", envOverrides: { JHW_SCOPE_COUNT: "3x" } },
    { name: "missing numbered done value", omittedEnv: ["JHW_DONE_2"] },
    { name: "empty numbered scope value", envOverrides: { JHW_SCOPE_2: "" } },
  ];
  for (const testCase of cases) {
    const result = await runWorkflow(markdown, { name: "temporary" }, testCase);
    assert.notEqual(result.exitCode, 0, `${testCase.name}: invalid repeatable input must fail`);
    assert.deepEqual(result.calls, [["preflight"]],
      `${testCase.name}: invalid repeatable input must fail before task start`);
    assert.deepEqual(result.rawCalls, []);
  }
}

async function assertConsumerContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  assertStaticRecoveryDiscoveryContract(label, markdown);
  assertHostOnlyLifecycleContract(label, markdown);
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
  await assertRecoveryDiscoveryConsumerContract(label, markdown);
  await assertFinishConsumerContract(label, markdown);
  assert.deepEqual(await runStartReportingRecipe(markdown), {
    task_id: targetTaskId,
    claim_id: startedClaimId,
    branch: startedTaskEnvelope.result.branch,
    worktree_ref: worktreeRef,
  }, `${label}: executable reporting recipe must project exactly four fields and discard producer extras`);
}

async function main() {
  assertLauncherV3Fixtures();
  await assertStrictLauncherOracle();
  await assertRepeatableTemporaryInputs(canonicalTask);
  await assertInvalidRepeatableTemporaryInputs(canonicalTask);
  await assertConsumerContract("Claude canonical consumer", canonicalTask);
  assert.equal(await realpath(codexReference), await realpath(canonicalTask),
    "Codex task reference must resolve to the canonical Claude task skill");
  await assertConsumerContract("Codex generated reference consumer", codexReference);
  console.log("task skill consumer contracts: ok");
}

await main();
