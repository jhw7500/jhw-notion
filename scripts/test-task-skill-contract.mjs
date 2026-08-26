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
    .replaceAll("<session-id>", sessionValue);
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
  process.stdout.write(process.env.JHW_TASK_CONTRACT_TASK_START_PAYLOAD + "\n");
  process.exit(Number(process.env.JHW_TASK_CONTRACT_TASK_START_EXIT));
}
process.exit(64);
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

function launcherEnv({ home, log, checkoutRoot, preflightExit = 0, taskStartExit = 0, taskStartError = "" }) {
  return {
    HOME: home,
    PATH: "/usr/bin:/bin",
    JHW_TASK_CONTRACT_LOG: log,
    JHW_TASK_CONTRACT_PREFLIGHT_EXIT: String(preflightExit),
    JHW_TASK_CONTRACT_PREFLIGHT_PAYLOAD: JSON.stringify(readyPreflightEnvelope),
    JHW_TASK_CONTRACT_TASK_START_EXIT: String(taskStartExit),
    JHW_TASK_CONTRACT_TASK_START_ERROR: taskStartError,
    JHW_TASK_CONTRACT_TASK_START_PAYLOAD: JSON.stringify(startedTaskEnvelope),
    JHW_TASK_CONTRACT_VALID_STARTS: JSON.stringify(routes.map(({ name }) => expectedStartArgs(name, checkoutRoot))),
  };
}

async function runWorkflow(markdown, route, {
  preflightExit = 0,
  taskStartExit = 0,
  taskStartError = "",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-skill-contract-"));
  try {
    const log = join(root, "launcher.log");
    const checkoutRoot = await createCheckout(root);
    const { home } = await installFakeLauncher(root);
    const command = `${contractBlock(markdown, "gate")}\n${contractBlock(markdown, route.name)}`;
    const result = await execFileAsync("bash", ["-c", materialize(command)], {
      cwd: checkoutRoot,
      env: launcherEnv({ home, log, checkoutRoot, preflightExit, taskStartExit, taskStartError }),
    }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (error) => ({ exitCode: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
    );
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    return { ...result, calls, checkoutRoot };
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
    const checkoutRoot = "/checkout/oracle";
    const { home, launcher } = await installFakeLauncher(root);
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
        env: launcherEnv({ home, log, checkoutRoot }),
      }).then(
        () => ({ exitCode: 0, stderr: "" }),
        (error) => ({ exitCode: error.code, stderr: error.stderr ?? "" }),
      );
      assert.equal(result.exitCode, 64,
        `strict fake launcher must reject invalid argv: ${JSON.stringify(argv)}; stderr=${result.stderr}`);
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

async function assertConsumerContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  for (const route of routes) {
    const success = await runWorkflow(markdown, route);
    assert.equal(success.exitCode, 0, `${label} ${route.name}: complete route argv must pass`);
    assert.deepEqual(success.calls, [["preflight"], expectedStartArgs(route.name, success.checkoutRoot)],
      `${label} ${route.name}: argv boundaries and complete route flags must be exact`);
    assert.equal(success.calls.filter((call) => commandName(call) === "task start").length, 1);
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
