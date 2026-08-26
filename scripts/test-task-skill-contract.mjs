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
    expected: /--project prj-portfolio --repo-id repo-portfolio --repo-path /,
    routeFields: /--issue-url https:\/\/github\.com\/example\/consumer\/issues\/74/,
  },
  {
    name: "temporary",
    expected: /--project prj-portfolio --repo-id repo-portfolio --repo-path /,
    routeFields: /--temp-alias temporary-verified --goal verified-goal/,
  },
  { name: "resume", expected: /--task tsk-018f1234-5678-7abc-8def-0123456789ab --repo-path /, routeFields: /--task tsk-018f1234-5678-7abc-8def-0123456789ab/ },
];

const switchRoute = {
  name: "switch",
  expected: /--project prj-target --repo-id repo-target --repo-path /,
  routeFields: /--issue-url https:\/\/github\.com\/example\/target\/issues\/74/,
};

const validPortfolio = {
  command: "portfolio status",
  result: {
    page_id: "page-1",
    items: [{
      project_id: "prj-portfolio",
      title: "Portfolio project",
      repo_ids: ["repo-portfolio"],
    }],
    repositories: [{ repo_id: "repo-portfolio", slug: "example/consumer", allow_public: false }],
    truncated: false,
    total_items: 1,
  },
};

function portfolioItem(projectId, repoIds) {
  return {
    ...validPortfolio.result.items[0],
    project_id: projectId,
    repo_ids: repoIds,
  };
}

function portfolioPage({
  pageId = "page-1",
  items = validPortfolio.result.items,
  repositories = validPortfolio.result.repositories,
  truncated = false,
  totalItems = items.length,
  nextPageId,
} = {}) {
  return JSON.stringify({
    command: "portfolio status",
    result: {
      ...validPortfolio.result,
      page_id: pageId,
      items,
      repositories,
      truncated,
      total_items: totalItems,
      ...(nextPageId === undefined ? {} : { next_page_id: nextPageId }),
    },
  });
}

function contractBlock(markdown, name) {
  const match = markdown.match(
    new RegExp(`<!-- task-start-contract: ${name}:begin -->\\n` +
      "```bash\\n([\\s\\S]*?)```\\n" +
      `<!-- task-start-contract: ${name}:end -->`),
  );
  assert.ok(match, `task skill must expose executable ${name} Task-start contract`);
  return match[1];
}

function materialize(command, {
  owner = "example",
  repo = "consumer",
  targetCheckoutRoot = "/checkout/target",
} = {}) {
  return command
    .replaceAll("<verified-project-id>", "prj-placeholder")
    .replaceAll("<verified-repo-id>", "repo-placeholder")
    .replaceAll("<absolute-checkout-root>", "/checkout/verified")
    .replaceAll("<absolute-target-checkout-root>", targetCheckoutRoot)
    .replaceAll("<owner>", owner)
    .replaceAll("<repo>", repo)
    .replaceAll("<number>", "74")
    .replaceAll("<alias>", "temporary-verified")
    .replaceAll("<temp-alias>", "temporary-verified")
    .replaceAll("<goal>", "verified-goal")
    .replaceAll("<condition>", "verified-condition")
    .replaceAll("<scope>", "verified-scope")
    .replaceAll("<tsk-id>", taskId)
    .replaceAll("<claim-id>", claimId)
    .replaceAll("<validation>", "verified-validation")
    .replaceAll("<session-id>", "session-verified");
}

async function createCheckout(root, name, {
  originUrl,
  fetchUrls = originUrl === undefined || originUrl === null ? [] : [originUrl],
  pushUrls = originUrl === undefined || originUrl === null ? [] : [originUrl],
} = {}) {
  const checkout = join(root, name);
  await mkdir(checkout, { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: checkout });
  if (fetchUrls.length > 0) {
    await execFileAsync("git", ["remote", "add", "origin", fetchUrls[0]], { cwd: checkout });
    for (const url of fetchUrls.slice(1)) {
      await execFileAsync("git", ["remote", "set-url", "--add", "origin", url], { cwd: checkout });
    }
    for (const url of pushUrls) {
      await execFileAsync("git", ["remote", "set-url", "--add", "--push", "origin", url], { cwd: checkout });
    }
  }
  return checkout;
}

async function runWorkflow(markdown, route, {
  preflightExit = 0,
  portfolioExit = 0,
  portfolioPayload = JSON.stringify(validPortfolio),
  portfolioPages,
  taskStartExit = 0,
  finishExit = 0,
  originUrl = "https://github.com/example/consumer.git",
  originFetchUrls,
  originPushUrls,
  targetOriginUrl,
  materializeValues,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-task-skill-contract-"));
  try {
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    const controlBin = join(root, "bin");
    const log = join(root, "launcher.log");
    const launcher = join(bin, "jhw-control-host");
    const control = join(controlBin, "jhw-control");
    const checkoutRoot = await createCheckout(root, "checkout", {
      originUrl,
      fetchUrls: originFetchUrls,
      pushUrls: originPushUrls,
    });
    const targetCheckoutRoot = targetOriginUrl
      ? await createCheckout(root, "target-checkout", { originUrl: targetOriginUrl })
      : undefined;
    await mkdir(bin, { recursive: true });
    await mkdir(controlBin, { recursive: true });
    await writeFile(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$JHW_TASK_CONTRACT_LOG\"\nif [ \"$1\" = preflight ]; then if [ \"$JHW_TASK_CONTRACT_PREFLIGHT_EXIT\" -ne 0 ]; then exit \"$JHW_TASK_CONTRACT_PREFLIGHT_EXIT\"; fi; printf '%s\\n' \"$JHW_TASK_CONTRACT_PREFLIGHT_PAYLOAD\"; exit 0; fi\nif [ \"$1 $2\" = \"portfolio status\" ]; then page=page-1; if [ \"\${3:-}\" = --page ]; then page=\"\${4:-}\"; fi; node -e 'const pages=JSON.parse(process.env.JHW_TASK_CONTRACT_PORTFOLIO_PAGES); const page=process.argv[1]; if (!(page in pages)) process.exit(76); process.stdout.write(pages[page]);' \"$page\" || exit $?; exit \"$JHW_TASK_CONTRACT_PORTFOLIO_EXIT\"; fi\nif [ \"$1 $2\" = \"task start\" ]; then printf '%s\\n' \"$JHW_TASK_CONTRACT_TASK_START_PAYLOAD\"; exit \"$JHW_TASK_CONTRACT_TASK_START_EXIT\"; fi\n`,
      { mode: 0o755 },
    );
    await writeFile(
      control,
      `#!/bin/sh\nprintf 'control %s\\n' \"$*\" >> \"$JHW_TASK_CONTRACT_LOG\"\nif [ \"$1 $2\" = \"task finish\" ]; then exit \"$JHW_TASK_CONTRACT_FINISH_EXIT\"; fi\n`,
      { mode: 0o755 },
    );
    const command = `${contractBlock(markdown, "gate")}\n${contractBlock(markdown, route.name)}`;
    const result = await execFileAsync("bash", ["-c", materialize(command, {
      targetCheckoutRoot,
      ...materializeValues,
    })], {
      cwd: checkoutRoot,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${controlBin}:${process.env.PATH}`,
        JHW_TASK_CONTRACT_LOG: log,
        JHW_TASK_CONTRACT_PREFLIGHT_EXIT: String(preflightExit),
        JHW_TASK_CONTRACT_PREFLIGHT_PAYLOAD: JSON.stringify(readyPreflightEnvelope),
        JHW_TASK_CONTRACT_PORTFOLIO_EXIT: String(portfolioExit),
        JHW_TASK_CONTRACT_TASK_START_EXIT: String(taskStartExit),
        JHW_TASK_CONTRACT_TASK_START_PAYLOAD: JSON.stringify(startedTaskEnvelope),
        JHW_TASK_CONTRACT_FINISH_EXIT: String(finishExit),
        JHW_TASK_CONTRACT_PORTFOLIO_PAGES: JSON.stringify(portfolioPages ?? { "page-1": portfolioPayload }),
      },
    }).then(
      ({ stdout }) => ({ exitCode: 0, stdout }),
      (error) => ({ exitCode: error.code, stdout: error.stdout ?? "" }),
    );
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
    return { ...result, calls, checkoutRoot, targetCheckoutRoot };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertPaginationConsumerContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  const targetRepository = validPortfolio.result.repositories[0];
  const otherRepository = { repo_id: "repo-other", slug: "example/other", allow_public: false };
  const laterPageSuccess = await runWorkflow(markdown, routes[0], {
    portfolioPages: {
      "page-1": portfolioPage({
        items: [portfolioItem("prj-other", ["repo-other"])],
        repositories: [targetRepository, otherRepository],
        truncated: true,
        totalItems: 2,
        nextPageId: "page-2",
      }),
      "page-2": portfolioPage({
        pageId: "page-2",
        items: [portfolioItem("prj-portfolio", ["repo-portfolio"])],
        repositories: [targetRepository, otherRepository],
        totalItems: 2,
      }),
    },
  });
  assert.equal(laterPageSuccess.exitCode, 0, `${label}: later-page association must start`);
  assert.deepEqual(laterPageSuccess.calls.map(commandName), [
    "preflight", "portfolio status", "portfolio status", "task start",
  ], `${label}: later-page association must traverse before one start`);
  assert.match(laterPageSuccess.calls[2], /--page page-2/,
    `${label}: later-page association must request the returned next page`);

  const invalidPageSets = [
    {
      name: "later-page ambiguity",
      pages: {
        "page-1": portfolioPage({ truncated: true, totalItems: 2, nextPageId: "page-2" }),
        "page-2": portfolioPage({ pageId: "page-2", items: [portfolioItem("prj-second", ["repo-portfolio"])], totalItems: 2 }),
      },
    },
    {
      name: "malformed later page",
      pages: {
        "page-1": portfolioPage({ truncated: true, totalItems: 2, nextPageId: "page-2" }),
        "page-2": JSON.stringify({ result: { page_id: "page-2" } }),
      },
    },
    {
      name: "page cycle",
      pages: {
        "page-1": portfolioPage({ truncated: true, totalItems: 2, nextPageId: "page-2" }),
        "page-2": portfolioPage({ pageId: "page-2", truncated: true, totalItems: 2, nextPageId: "page-1" }),
      },
    },
    {
      name: "page bound",
      pages: {
        "page-1": portfolioPage({ truncated: true, totalItems: 1, nextPageId: "page-2" }),
        "page-2": portfolioPage({ pageId: "page-2", totalItems: 1 }),
      },
    },
    {
      name: "inconsistent repeated repository",
      pages: {
        "page-1": portfolioPage({ truncated: true, totalItems: 2, nextPageId: "page-2" }),
        "page-2": portfolioPage({ pageId: "page-2", items: [portfolioItem("prj-other", ["repo-other"])], repositories: [{ ...targetRepository, slug: "example/changed" }], totalItems: 2 }),
      },
    },
  ];
  for (const { name, pages } of invalidPageSets) {
    const invalid = await runWorkflow(markdown, routes[0], { portfolioPages: pages });
    assert.notEqual(invalid.exitCode, 0, `${label}: ${name} must fail closed`);
    assert.equal(invalid.calls.filter((call) => commandName(call) === "task start").length, 0,
      `${label}: ${name} must prevent Task mutation`);
  }
}

async function assertCrossRepositorySwitchContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  const targetRepository = { repo_id: "repo-target", slug: "example/target", allow_public: false };
  const targetPortfolio = portfolioPage({
    items: [portfolioItem("prj-target", ["repo-target"])],
    repositories: [targetRepository],
    totalItems: 1,
  });
  const switchValues = { owner: "example", repo: "target" };
  const successful = await runWorkflow(markdown, switchRoute, {
    targetOriginUrl: "https://github.com/example/target.git",
    portfolioPayload: targetPortfolio,
    materializeValues: switchValues,
  });
  assert.equal(successful.exitCode, 0, `${label}: verified cross-repository switch must start`);
  assert.deepEqual(successful.calls.map(commandName), [
    "preflight", "portfolio status", "control task", "task start",
  ], `${label}: switch must validate target before exactly one finish and one start`);
  assert.equal(successful.calls.filter((call) => commandName(call) === "control task").length, 1,
    `${label}: switch must finish the current Task exactly once`);
  assert.equal(successful.calls.filter((call) => commandName(call) === "task start").length, 1,
    `${label}: switch must start the target Task exactly once`);
  assert.ok(successful.calls.at(-1).includes(`--repo-path ${successful.targetCheckoutRoot}`),
    `${label}: switch must retain the verified target checkout after finish`);
  assert.ok(!successful.calls.at(-1).includes(`--repo-path ${successful.checkoutRoot}`),
    `${label}: switch must never reuse the current checkout for the target start`);

  const targetGateFailure = await runWorkflow(markdown, switchRoute, {
    targetOriginUrl: "https://github.com/example/target.git",
    portfolioPayload: JSON.stringify(validPortfolio),
    materializeValues: switchValues,
  });
  assert.notEqual(targetGateFailure.exitCode, 0, `${label}: an unregistered target must fail closed`);
  assert.equal(targetGateFailure.calls.filter((call) => commandName(call) === "control task").length, 0,
    `${label}: target-gate failure must not finish the current Task`);
  assert.equal(targetGateFailure.calls.filter((call) => commandName(call) === "task start").length, 0,
    `${label}: target-gate failure must not start a Task`);

  const postFinishStartFailure = await runWorkflow(markdown, switchRoute, {
    targetOriginUrl: "https://github.com/example/target.git",
    portfolioPayload: targetPortfolio,
    materializeValues: switchValues,
    taskStartExit: 73,
  });
  assert.equal(postFinishStartFailure.exitCode, 73,
    `${label}: target start failure must propagate after the already-successful finish`);
  assert.equal(postFinishStartFailure.calls.filter((call) => commandName(call) === "control task").length, 1,
    `${label}: post-finish start failure must not repeat finish`);
  assert.equal(postFinishStartFailure.calls.filter((call) => commandName(call) === "task start").length, 1,
    `${label}: post-finish start failure must attempt only one target start`);
}

async function assertRemoteProvenanceContract(label, taskPath) {
  const markdown = await readFile(taskPath, "utf8");
  const remoteRepository = {
    repo_id: "repo-remote",
    slug: "example/remote-provenance",
    allow_public: false,
  };
  const remotePortfolio = portfolioPage({
    items: [portfolioItem("prj-remote", ["repo-remote"])],
    repositories: [remoteRepository],
    totalItems: 1,
  });
  const validOrigin = "git@github.com:example/remote-provenance.git";
  for (const route of routes.filter(({ name }) => name === "temporary" || name === "resume")) {
    const derived = await runWorkflow(markdown, route, {
      originUrl: validOrigin,
      portfolioPayload: remotePortfolio,
    });
    assert.equal(derived.exitCode, 0,
      `${label} ${route.name}: unique matching GitHub origin must derive the expected slug`);
    assert.equal(derived.calls.filter((call) => commandName(call) === "task start").length, 1,
      `${label} ${route.name}: derived slug must permit exactly one start`);
    if (route.name === "temporary") {
      assert.match(derived.calls.at(-1), /--project prj-remote --repo-id repo-remote/,
        `${label} temporary: start must forward coordinates bound to the derived remote slug`);
    }

    const invalidOrigins = [
      { name: "missing origin", originUrl: null },
      {
        name: "multiple origin fetch URLs",
        originUrl: validOrigin,
        originFetchUrls: [validOrigin, "git@github.com:example/another.git"],
        originPushUrls: [validOrigin],
      },
      {
        name: "mismatched origin fetch/push URLs",
        originUrl: validOrigin,
        originPushUrls: ["git@github.com:example/another.git"],
      },
      { name: "non-GitHub origin", originUrl: "https://gitlab.com/example/remote-provenance.git" },
    ];
    for (const { name, ...origin } of invalidOrigins) {
      const invalid = await runWorkflow(markdown, route, {
        ...origin,
        portfolioPayload: remotePortfolio,
      });
      assert.notEqual(invalid.exitCode, 0,
        `${label} ${route.name}: ${name} must fail closed`);
      assert.deepEqual(invalid.calls, ["preflight"],
        `${label} ${route.name}: ${name} must stop before portfolio lookup or Task mutation`);
    }
  }
}

function assertLauncherV2Fixtures() {
  assert.deepEqual(Object.keys(readyPreflightEnvelope), ["command", "result"],
    "fake preflight must use the launcher v2 envelope");
  assert.equal(readyPreflightEnvelope.command, "preflight",
    "fake preflight must name its launcher command");
  assert.deepEqual(Object.keys(validPortfolio), ["command", "result"],
    "fake portfolio must use the launcher v2 envelope");
  assert.equal(validPortfolio.command, "portfolio status",
    "fake portfolio must name its launcher command");
  assert.deepEqual(Object.keys(startedTaskEnvelope), ["command", "result"],
    "fake Task start must use the launcher v2 envelope");
  assert.equal(startedTaskEnvelope.command, "task start",
    "fake Task start must name its launcher command");
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
    assert.ok(success.calls[2].includes(`--repo-path ${success.checkoutRoot}`),
      `${label} ${route.name}: must derive the absolute checkout root from the current Git checkout`);
    assert.match(success.calls[2], route.routeFields,
      `${label} ${route.name}: must forward its own registration fields`);
    assert.deepEqual(JSON.parse(success.stdout), startedTaskEnvelope,
      `${label} ${route.name}: must preserve the launcher v2 immutable identifier envelope`);
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
    JSON.stringify({ command: "portfolio export", result: validPortfolio.result }),
    JSON.stringify({ command: "portfolio status", result: { repositories: validPortfolio.result.repositories } }),
    portfolioPage({ items: [], repositories: [], totalItems: 0 }),
    portfolioPage({ repositories: [{ repo_id: "repo-portfolio", slug: "other/repo", allow_public: false }] }),
    portfolioPage({
      items: [
        portfolioItem("prj-one", ["repo-portfolio"]),
        portfolioItem("prj-two", ["repo-portfolio"]),
      ],
      totalItems: 2,
    }),
  ];
  for (const portfolioPayload of invalidPortfolios) {
    const invalid = await runWorkflow(markdown, routes[0], { portfolioPayload });
    assert.notEqual(invalid.exitCode, 0, `${label}: invalid portfolio data must fail closed`);
    assert.deepEqual(invalid.calls, ["preflight", "portfolio status"],
      `${label}: invalid portfolio data must prevent Task mutation`);
  }
}

async function main() {
  assertLauncherV2Fixtures();
  await assertConsumerContract("Claude canonical consumer", canonicalTask);
  await assertPaginationConsumerContract("Claude canonical consumer", canonicalTask);
  await assertCrossRepositorySwitchContract("Claude canonical consumer", canonicalTask);
  await assertRemoteProvenanceContract("Claude canonical consumer", canonicalTask);
  assert.equal(await realpath(codexReference), await realpath(canonicalTask),
    "Codex task reference must resolve to the canonical Claude task skill");
  await assertConsumerContract("Codex generated reference consumer", codexReference);
  await assertPaginationConsumerContract("Codex generated reference consumer", codexReference);
  await assertCrossRepositorySwitchContract("Codex generated reference consumer", codexReference);
  await assertRemoteProvenanceContract("Codex generated reference consumer", codexReference);
  console.log("task skill consumer contracts: ok");
}

await main();
