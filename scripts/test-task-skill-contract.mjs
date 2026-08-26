#!/usr/bin/env node
// Consumer contracts for the canonical /jhw:task start gate. These execute
// each route through a fake installed launcher rather than matching prose.

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
const startedTaskEnvelope = {
  command: "task start",
  result: {
    task_id: taskId,
    claim_id: claimId,
    branch: "task/0123456789ab-created",
    worktree_ref: worktreeRef,
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

const routes = [
  {
    name: "formal",
    routeFields: /--issue-url https:\/\/github\.com\/example\/consumer\/issues\/74/,
  },
  {
    name: "temporary",
    routeFields: /--temp-alias temporary-verified --goal verified-goal/,
  },
  {
    name: "resume",
    routeFields: new RegExp(`--task ${taskId}`),
  },
];

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
    .replaceAll("<alias>", "temporary-verified")
    .replaceAll("<temp-alias>", "temporary-verified")
    .replaceAll("<goal>", "verified-goal")
    .replaceAll("<condition>", "verified-condition")
    .replaceAll("<scope>", "verified-scope")
    .replaceAll("<tsk-id>", taskId)
    .replaceAll("<session-id>", "session-verified");
}

async function createCheckout(root) {
  const checkout = join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: checkout });
  return checkout;
}

async function runWorkflow(markdown, route, {
  preflightExit = 0,
  taskStartExit = 0,
  taskStartError = "",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-skill-contract-"));
  try {
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    const log = join(root, "launcher.log");
    const launcher = join(bin, "jhw-control-host");
    const checkoutRoot = await createCheckout(root);
    await mkdir(bin, { recursive: true });
    await writeFile(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$JHW_TASK_CONTRACT_LOG"\nif [ "$1" = preflight ]; then if [ "$JHW_TASK_CONTRACT_PREFLIGHT_EXIT" -ne 0 ]; then exit "$JHW_TASK_CONTRACT_PREFLIGHT_EXIT"; fi; printf '%s\\n' "$JHW_TASK_CONTRACT_PREFLIGHT_PAYLOAD"; exit 0; fi\nif [ "$1 $2" = "task start" ]; then\n  if [ -n "$JHW_TASK_CONTRACT_TASK_START_ERROR" ]; then\n    printf '{"error":{"code":"%s"}}\\n' "$JHW_TASK_CONTRACT_TASK_START_ERROR" >&2\n    exit 1\n  fi\n  printf '%s\\n' "$JHW_TASK_CONTRACT_TASK_START_PAYLOAD"\n  exit "$JHW_TASK_CONTRACT_TASK_START_EXIT"\nfi\nexit 64\n`,
      { mode: 0o755 },
    );
    const command = `${contractBlock(markdown, "gate")}\n${contractBlock(markdown, route.name)}`;
    const result = await execFileAsync("bash", ["-c", materialize(command)], {
      cwd: checkoutRoot,
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        JHW_TASK_CONTRACT_LOG: log,
        JHW_TASK_CONTRACT_PREFLIGHT_EXIT: String(preflightExit),
        JHW_TASK_CONTRACT_PREFLIGHT_PAYLOAD: JSON.stringify(readyPreflightEnvelope),
        JHW_TASK_CONTRACT_TASK_START_EXIT: String(taskStartExit),
        JHW_TASK_CONTRACT_TASK_START_ERROR: taskStartError,
        JHW_TASK_CONTRACT_TASK_START_PAYLOAD: JSON.stringify(startedTaskEnvelope),
      },
    }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (error) => ({
        exitCode: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
    return { ...result, calls, checkoutRoot };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function commandName(call) {
  return call.split(" ").slice(0, 2).join(" ");
}

function assertLauncherV3Fixtures() {
  assert.deepEqual(Object.keys(readyPreflightEnvelope), ["command", "result"],
    "fake preflight must use the launcher v3 envelope");
  assert.equal(readyPreflightEnvelope.command, "preflight",
    "fake preflight must name its launcher command");
  assert.deepEqual(Object.keys(startedTaskEnvelope), ["command", "result"],
    "fake Task start must use the launcher v3 envelope");
  assert.equal(startedTaskEnvelope.command, "task start",
    "fake Task start must name its launcher command");
  assert.deepEqual(Object.keys(startedTaskEnvelope.result), [
    "task_id", "claim_id", "branch", "worktree_ref",
  ], "fake start result must expose only the documented immutable output fields");
  assert.match(startedTaskEnvelope.result.task_id,
    /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "fake Task identifier must be a canonical UUID-v7 logical Task ID");
  assert.match(startedTaskEnvelope.result.claim_id,
    /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "fake Claim identifier must be a canonical UUID-v7 logical Claim ID");
  assert.match(startedTaskEnvelope.result.worktree_ref, /^wt-[a-z0-9][a-z0-9-]{1,120}$/,
    "fake worktree reference must be a canonical logical worktree ID");
  assert.equal(startedTaskEnvelope.result.branch,
    `task/${startedTaskEnvelope.result.worktree_ref.slice(3)}`,
    "fake branch/worktree coordinates must be producer-compatible");
}

function assertStaticStartContract(label, markdown) {
  for (const removed of [
    "portfolio_state",
    "bind_portfolio_coordinates",
    "verified_checkout_slug",
  ]) {
    assert.doesNotMatch(markdown, new RegExp(removed),
      `${label}: client-side portfolio binding implementation must be deleted`);
  }
  assert.doesNotMatch(markdown, /jhw-control-host" portfolio status/,
    `${label}: launcher portfolio pagination must be deleted`);
  assert.doesNotMatch(markdown, /(^|[^-])jhw-control task start/m,
    `${label}: Task start must never bypass the installed launcher`);
  assert.doesNotMatch(markdown, /rtk git/,
    `${label}: the runtime contract must work without RTK on PATH`);

  assert.match(markdown,
    /PROJECT_REPOSITORY_NOT_FOUND[^\n]*올바른 Project Record에 Repository를 등록/,
    `${label}: not-found must require registration in the correct Project Record`);
  assert.match(markdown,
    /PROJECT_REPOSITORY_AMBIGUOUS[^\n]*Project association을 하나로 줄/,
    `${label}: ambiguity must require reducing the association to one`);
  assert.match(markdown,
    /PROJECT_REPOSITORY_NOT_FOUND[^\n]*PROJECT_REPOSITORY_AMBIGUOUS[^\n]*추측[^\n]*임의 선택[^\n]*자동 재시도[^\n]*explicit mode fallback[^\n]*금지/,
    `${label}: association failures must forbid guessing, arbitrary choice, retry, and fallback`);
  assert.match(markdown,
    /resolver `task start`\/`task finish`[^\n]*REGISTRY_MOVED_DURING_READ[^\n]*자동 재실행 없이 멈추고 보고/,
    `${label}: resolver mutation movement must stop without automatic retry`);
  assert.match(markdown,
    /수동 재실행[^\n]*`status`[^\n]*`handoff`[^\n]*`assert-owner`[^\n]*`recover --action status`[^\n]*읽기 전용 명령에만 제한/,
    `${label}: manual movement retry must be limited to four read-only commands`);
}

async function assertConsumerContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  assertStaticStartContract(label, markdown);

  for (const route of routes) {
    const success = await runWorkflow(markdown, route);
    assert.equal(success.exitCode, 0, `${label} ${route.name}: ready preflight must permit Task start`);
    assert.deepEqual(success.calls.map(commandName), ["preflight", "task start"],
      `${label} ${route.name}: must execute one preflight and one start`);
    assert.equal(success.calls.filter((call) => commandName(call) === "task start").length, 1,
      `${label} ${route.name}: must not create a duplicate Claim`);
    assert.ok(success.calls[1].includes(`--repo-path ${success.checkoutRoot}`),
      `${label} ${route.name}: must derive the absolute checkout root from Git`);
    assert.match(success.calls[1], route.routeFields,
      `${label} ${route.name}: must forward its own source fields`);
    assert.doesNotMatch(success.calls[1], /portfolio status|--project|--repo-id/,
      `${label} ${route.name}: must not use client-resolved Project/Repository coordinates`);
    if (route.name === "resume") {
      assert.doesNotMatch(success.calls[1], /--resolve-from-checkout/,
        `${label} resume: existing Task must use --task without resolver registration`);
    } else {
      assert.match(success.calls[1], /task start --resolve-from-checkout true/,
        `${label} ${route.name}: new Task must use checkout resolution`);
    }
    assert.deepEqual(JSON.parse(success.stdout), startedTaskEnvelope,
      `${label} ${route.name}: must preserve the exact immutable identifier envelope`);
  }

  const preflightFailure = await runWorkflow(markdown, routes[0], { preflightExit: 78 });
  assert.equal(preflightFailure.exitCode, 78, `${label}: failed preflight must propagate its status`);
  assert.deepEqual(preflightFailure.calls.map(commandName), ["preflight"],
    `${label}: failed preflight must stop before Task mutation`);

  for (const code of ["PROJECT_REPOSITORY_NOT_FOUND", "PROJECT_REPOSITORY_AMBIGUOUS"]) {
    const failed = await runWorkflow(markdown, routes[0], { taskStartError: code });
    assert.equal(failed.exitCode, 1);
    assert.deepEqual(failed.calls.map(commandName), ["preflight", "task start"]);
    assert.deepEqual(JSON.parse(failed.stderr), { error: { code } });
    assert.equal(failed.calls.filter((call) => commandName(call) === "task start").length, 1);
    assert.doesNotMatch(failed.calls.join("\n"), /portfolio status|--project|--repo-id/);
  }

  const moved = await runWorkflow(markdown, routes[0], {
    taskStartError: "REGISTRY_MOVED_DURING_READ",
  });
  assert.equal(moved.exitCode, 1);
  assert.deepEqual(moved.calls.map(commandName), ["preflight", "task start"]);
  assert.deepEqual(JSON.parse(moved.stderr), {
    error: { code: "REGISTRY_MOVED_DURING_READ" },
  });
  assert.equal(moved.calls.filter((call) => commandName(call) === "task start").length, 1);
  assert.doesNotMatch(moved.calls.join("\n"), /portfolio status|--project|--repo-id/);
}

async function main() {
  assertLauncherV3Fixtures();
  await assertConsumerContract("Claude canonical consumer", canonicalTask);
  assert.equal(await realpath(codexReference), await realpath(canonicalTask),
    "Codex task reference must resolve to the canonical Claude task skill");
  await assertConsumerContract("Codex generated reference consumer", codexReference);
  console.log("task skill consumer contracts: ok");
}

await main();
