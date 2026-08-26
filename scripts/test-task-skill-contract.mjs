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

const routes = [
  {
    name: "formal",
    expected: /--project prj-portfolio --repo-id repo-portfolio --repo-path /,
    routeFields: /--issue-url https:\/\/github\.com\/example\/consumer\/issues\/74/,
  },
  {
    name: "temporary",
    expected: /--project prj-portfolio --repo-id repo-portfolio --repo-path /,
    routeFields: /--temp-alias temporary-verified --goal verified-goal/,
  },
  { name: "resume", expected: /--task tsk-verified --repo-path /, routeFields: /--task tsk-verified/ },
];

const validPortfolio = {
  result: {
    page_id: "page-1",
    markdown: "# Portfolio\n",
    items: [{
      project_id: "prj-portfolio",
      title: "Portfolio project",
      objective: "Test coordinate provenance",
      repo_ids: ["repo-portfolio"],
      fields: {
        status: "active",
        priority: "P1",
        health: "on-track",
        next_action: "test",
        last_reviewed: "2026-08-26",
      },
      stale: false,
    }],
    repositories: [{ repo_id: "repo-portfolio", slug: "example/consumer", allow_public: false }],
    truncated: false,
    total_items: 1,
  },
};

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
    .replaceAll("<verified-project-id>", "prj-placeholder")
    .replaceAll("<verified-repo-id>", "repo-placeholder")
    .replaceAll("<absolute-checkout-root>", "/checkout/verified")
    .replaceAll("<expected-repository-slug>", "example/consumer")
    .replaceAll("<owner>", "example")
    .replaceAll("<repo>", "consumer")
    .replaceAll("<number>", "74")
    .replaceAll("<alias>", "temporary-verified")
    .replaceAll("<temp-alias>", "temporary-verified")
    .replaceAll("<goal>", "verified-goal")
    .replaceAll("<condition>", "verified-condition")
    .replaceAll("<scope>", "verified-scope")
    .replaceAll("<tsk-id>", "tsk-verified")
    .replaceAll("<session-id>", "session-verified");
}

async function runWorkflow(markdown, route, {
  preflightExit = 0,
  portfolioExit = 0,
  portfolioPayload = JSON.stringify(validPortfolio),
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-skill-contract-"));
  try {
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    const log = join(root, "launcher.log");
    const launcher = join(bin, "jhw-control-host");
    await mkdir(bin, { recursive: true });
    await writeFile(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$JHW_TASK_CONTRACT_LOG\"\nif [ \"$1\" = preflight ]; then exit \"$JHW_TASK_CONTRACT_PREFLIGHT_EXIT\"; fi\nif [ \"$1 $2\" = \"portfolio status\" ]; then printf '%s\\n' \"$JHW_TASK_CONTRACT_PORTFOLIO\"; exit \"$JHW_TASK_CONTRACT_PORTFOLIO_EXIT\"; fi\nif [ \"$1 $2\" = \"task start\" ]; then printf '%s\\n' '{\"task_id\":\"tsk-created\",\"claim_id\":\"clm-created\",\"branch\":\"task/created\",\"worktree_ref\":\"wt-created\"}'; fi\n`,
      { mode: 0o755 },
    );
    const command = `${contractBlock(markdown, "gate")}\n${contractBlock(markdown, route.name)}`;
    const result = await execFileAsync("bash", ["-c", materialize(command)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        JHW_TASK_CONTRACT_LOG: log,
        JHW_TASK_CONTRACT_PREFLIGHT_EXIT: String(preflightExit),
        JHW_TASK_CONTRACT_PORTFOLIO_EXIT: String(portfolioExit),
        JHW_TASK_CONTRACT_PORTFOLIO: portfolioPayload,
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

function commandName(call) {
  return call.split(" ").slice(0, 2).join(" ");
}

async function assertConsumerContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  for (const route of routes) {
    const success = await runWorkflow(markdown, route);
    assert.equal(success.exitCode, 0, `${label} ${route.name}: ready gates must permit Task start`);
    assert.deepEqual(success.calls.map(commandName), ["preflight", "portfolio status", "task start"],
      `${label} ${route.name}: must run exactly one route-specific start after both gates`);
    assert.equal(success.calls.filter((call) => commandName(call) === "task start").length, 1,
      `${label} ${route.name}: must not create a duplicate Claim`);
    assert.match(success.calls[2], route.expected,
      `${label} ${route.name}: must forward verified coordinates from portfolio output`);
    assert.ok(success.calls[2].includes(`--repo-path ${repoRoot}`),
      `${label} ${route.name}: must derive the absolute checkout root from the current Git checkout`);
    assert.match(success.calls[2], route.routeFields,
      `${label} ${route.name}: must forward its own registration fields`);
    assert.deepEqual(JSON.parse(success.stdout), {
      task_id: "tsk-created",
      claim_id: "clm-created",
      branch: "task/created",
      worktree_ref: "wt-created",
    }, `${label} ${route.name}: must preserve returned immutable identifiers for reporting`);
  }

  const preflightFailure = await runWorkflow(markdown, routes[0], { preflightExit: 78 });
  assert.equal(preflightFailure.exitCode, 78, `${label}: failed preflight must propagate its status`);
  assert.deepEqual(preflightFailure.calls, ["preflight"],
    `${label}: failed preflight must stop before coordinate lookup or Task mutation`);

  const coordinateFailure = await runWorkflow(markdown, routes[0], { portfolioExit: 75 });
  assert.equal(coordinateFailure.exitCode, 75, `${label}: failed coordinate gate must propagate its status`);
  assert.deepEqual(coordinateFailure.calls, ["preflight", "portfolio status"],
    `${label}: failed coordinate gate must stop before Task mutation`);

  const invalidPortfolios = [
    "not-json",
    JSON.stringify({ result: { items: [], repositories: [] } }),
    JSON.stringify({ result: { repositories: validPortfolio.result.repositories } }),
    JSON.stringify({ result: { items: validPortfolio.result.items, repositories: [{ repo_id: "repo-portfolio", slug: "other/repo" }] } }),
    JSON.stringify({ result: { items: [{ project_id: "prj-one", repo_ids: ["repo-portfolio"] }, { project_id: "prj-two", repo_ids: ["repo-portfolio"] }], repositories: validPortfolio.result.repositories } }),
  ];
  for (const portfolioPayload of invalidPortfolios) {
    const invalid = await runWorkflow(markdown, routes[0], { portfolioPayload });
    assert.notEqual(invalid.exitCode, 0, `${label}: invalid portfolio data must fail closed`);
    assert.deepEqual(invalid.calls, ["preflight", "portfolio status"],
      `${label}: invalid portfolio data must prevent Task mutation`);
  }
}

async function main() {
  await assertConsumerContract("Claude canonical consumer", canonicalTask);
  assert.equal(await realpath(codexReference), await realpath(canonicalTask),
    "Codex task reference must resolve to the canonical Claude task skill");
  await assertConsumerContract("Codex generated reference consumer", codexReference);
  console.log("task skill consumer contracts: ok");
}

await main();
