#!/usr/bin/env node
// Consumer contracts for the canonical /jhw:task start gate.  These exercise
// the runnable command block through a fake installed launcher rather than
// treating its prose as an API.

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

function taskStartGate(markdown) {
  const match = markdown.match(
    /<!-- task-start-contract: begin -->\n```bash\n([\s\S]*?)```\n<!-- task-start-contract: end -->/,
  );
  assert.ok(match, "task skill must expose a runnable Task-start authorization gate");
  return match[1];
}

function materialize(command) {
  return command
    .replaceAll("<verified-project-id>", "prj-verified")
    .replaceAll("<verified-repo-id>", "repo-verified")
    .replaceAll("<absolute-checkout-root>", "/checkout/verified")
    .replaceAll("<owner>", "example")
    .replaceAll("<repo>", "consumer")
    .replaceAll("<number>", "74")
    .replaceAll("<session-id>", "session-verified");
}

async function runWorkflow(markdown, preflightExit, portfolioExit = 0) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-skill-contract-"));
  try {
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    const log = join(root, "launcher.log");
    const launcher = join(bin, "jhw-control-host");
    await mkdir(bin, { recursive: true });
    await writeFile(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$JHW_TASK_CONTRACT_LOG\"\nif [ \"$1\" = preflight ]; then exit \"$JHW_TASK_CONTRACT_PREFLIGHT_EXIT\"; fi\nif [ \"$1 $2\" = \"portfolio status\" ]; then exit \"$JHW_TASK_CONTRACT_PORTFOLIO_EXIT\"; fi\nif [ \"$1 $2\" = \"task start\" ]; then printf '%s\\n' '{\"task_id\":\"tsk-verified\",\"claim_id\":\"clm-verified\",\"branch\":\"task/verified\",\"worktree_ref\":\"wt-verified\"}'; fi\n`,
      { mode: 0o755 },
    );

    const result = await execFileAsync("bash", ["-c", materialize(taskStartGate(markdown))], {
      env: {
        ...process.env,
        HOME: home,
        JHW_TASK_CONTRACT_LOG: log,
        JHW_TASK_CONTRACT_PREFLIGHT_EXIT: String(preflightExit),
        JHW_TASK_CONTRACT_PORTFOLIO_EXIT: String(portfolioExit),
      },
    }).then(
      ({ stdout }) => ({ exitCode: 0, stdout }),
      (error) => ({ exitCode: error.code, stdout: error.stdout ?? "" }),
    );
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
    return { ...result, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertConsumerContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");

  const success = await runWorkflow(markdown, 0);
  assert.equal(success.exitCode, 0, `${label}: ready preflight must permit Task start`);
  assert.deepEqual(success.calls.map((call) => call.split(" ").slice(0, 2).join(" ")), [
    "preflight",
    "portfolio status",
    "task start",
  ], `${label}: launcher must run preflight, coordinate verification, then Task start`);
  assert.deepEqual(JSON.parse(success.stdout), {
    task_id: "tsk-verified",
    claim_id: "clm-verified",
    branch: "task/verified",
    worktree_ref: "wt-verified",
  }, `${label}: successful start must preserve returned immutable identifiers for reporting`);

  const failed = await runWorkflow(markdown, 78);
  assert.equal(failed.exitCode, 78, `${label}: failed preflight must propagate its nonzero status`);
  assert.deepEqual(failed.calls, ["preflight"],
    `${label}: preflight failure must stop before coordinate lookup or Task mutation`);

  const coordinateFailure = await runWorkflow(markdown, 0, 75);
  assert.equal(coordinateFailure.exitCode, 75,
    `${label}: failed coordinate verification must propagate its nonzero status`);
  assert.deepEqual(coordinateFailure.calls, ["preflight", "portfolio status"],
    `${label}: failed coordinate verification must stop before Task mutation`);
}

async function main() {
  await assertConsumerContract("Claude canonical consumer", canonicalTask);

  assert.equal(await realpath(codexReference), await realpath(canonicalTask),
    "Codex task reference must resolve to the canonical Claude task skill");
  await assertConsumerContract("Codex generated reference consumer", codexReference);

  console.log("task skill consumer contracts: ok");
}

await main();
