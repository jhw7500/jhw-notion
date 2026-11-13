import { execFile as execFileCallback, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { writeStream } from "../cli.js";
import { buildHandoff } from "../handoff.js";

const execFile = promisify(execFileCallback);
const paths: string[] = [];
const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("jhw-control installed entry", () => {
  it("awaits backpressured near-limit output through the final write callback", async () => {
    const payload = "x".repeat(12 * 1024 - 1) + "\n";
    let release: (() => void) | undefined;
    let received = "";
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        received += chunk.toString();
        release = callback;
      },
    });
    let settled = false;

    const pending = writeStream(stream, payload).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(received).toBe(payload);
    release?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("removes stale deleted control outputs before compiling", async () => {
    const stale = join(mcpRoot, "dist", "control", "locked-cli.js");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "stale", "utf8");

    await execFile("npm", ["run", "build"], { cwd: mcpRoot, encoding: "utf8" });

    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes JSON help through an npm-bin-style symlink", async () => {
    await execFile("npm", ["run", "build"], { cwd: mcpRoot, encoding: "utf8" });
    const root = await mkdtemp(join(tmpdir(), "jhw-control-bin-"));
    paths.push(root);
    // Match npm's installed-bin shape rather than only exercising an arbitrary
    // direct symlink. Node resolves the shebang through this link in exactly
    // the same way an npm consumer invokes `node_modules/.bin/jhw-control`.
    const npmBin = join(root, "node_modules", ".bin");
    await mkdir(npmBin, { recursive: true });
    const installedBin = join(npmBin, "jhw-control");
    await symlink(join(mcpRoot, "dist", "control", "cli.js"), installedBin);

    const { stdout, stderr } = await execFile(installedBin, ["--help"], {
      cwd: mcpRoot,
      encoding: "utf8",
      env: { ...process.env, GH_PROJECT_TOKEN: "entry-token" },
    });

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      command: "help",
      result: { commands: expect.arrayContaining(["task start", "portfolio export", "preflight"]) },
    });
    expect(stdout).not.toContain("entry-token");
  });

  it("flushes bounded near-cap Handoff output through an installed-bin symlink", async () => {
    await execFile("npm", ["run", "build"], { cwd: mcpRoot, encoding: "utf8" });
    const root = await mkdtemp(join(tmpdir(), "jhw-control-bin-"));
    paths.push(root);
    const registry = join(root, "registry");
    const stateDir = join(root, "state");
    const worktrees = join(root, "worktrees");
    const npmBin = join(root, "node_modules", ".bin");
    await Promise.all([mkdir(registry), mkdir(stateDir), mkdir(worktrees), mkdir(npmBin, { recursive: true })]);
    await execFile("git", ["init", "--initial-branch=main"], { cwd: registry });
    await execFile("git", ["config", "user.name", "Phase1A Test"], { cwd: registry });
    await execFile("git", ["config", "user.email", "phase1a@example.invalid"], { cwd: registry });
    const taskId = "tsk-0198aabb-ccdd-7eef-8abc-0123456789ab";
    const claimId = "clm-0198aabb-ccdd-7eef-8abc-0123456789ab";
    const alias = "control:entry-near-cap";
    const revision = "revision-1";
    const handoffPath = `handoffs/${taskId}/${claimId}.md`;
    const escapeHeavy = "\\".repeat(32 * 1024);
    const handoff = buildHandoff({
      task_id: taskId,
      claim_id: claimId,
      source_task_revision: revision,
      generated_at: "2026-08-13T00:01:00.000Z",
      progress: escapeHeavy,
      git_state: escapeHeavy,
      validation: escapeHeavy,
      failures: escapeHeavy,
      next_step: escapeHeavy,
      related_adr_and_evidence: escapeHeavy,
    });
    const files: Record<string, unknown> = {
      [`tasks/${taskId}.yaml`]: {
        id: taskId, kind: "temporary", project_id: "prj-control", repo_id: "repo-control",
        aliases: [alias], goal: "installed output gate", done_conditions: ["bounded"],
        expected_scope: ["src/control"], lifecycle: "handoff",
      },
      [`claims/history/2026/${taskId}/${claimId}.yaml`]: {
        task_id: taskId, task_alias: alias, project_id: "prj-control", repo_id: "repo-control",
        claim_id: claimId, session_id: "entry-session", host: "build-host",
        branch: "task/entry-near-cap", worktree_ref: "wt-entry-near-cap",
        source_task_revision: revision, started_at: "2026-08-13T00:00:00.000Z",
        released_at: "2026-08-13T00:01:00.000Z", status: "handoff", handoff_path: handoffPath,
      },
    };
    for (const [relative, value] of Object.entries(files)) {
      const target = join(registry, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }
    await mkdir(dirname(join(registry, handoffPath)), { recursive: true });
    await writeFile(join(registry, handoffPath), handoff, "utf8");
    await execFile("git", ["add", "--", "."], { cwd: registry });
    await execFile("git", ["commit", "-m", "Seed bounded Handoff fixture"], { cwd: registry });

    const installedBin = join(npmBin, "jhw-control");
    await symlink(join(mcpRoot, "dist", "control", "cli.js"), installedBin);
    const { stdout, stderr } = await execFile(installedBin, ["task", "handoff", "--task", taskId, "--claim", claimId], {
      cwd: mcpRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        JHW_REGISTRY_DIR: registry,
        JHW_WORKTREE_ROOT: worktrees,
        JHW_BUILD_HOST: "build-host",
        JHW_GITHUB_OWNER: "owner",
        JHW_PROJECT_NUMBER: "1",
        JHW_REGISTRY_REPOSITORY: "owner/registry",
        JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
        JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
        JHW_CONTROL_STATE_DIR: stateDir,
      },
    });

    expect(stderr).toBe("");
    expect(Buffer.byteLength(stdout, "utf8")).toBeGreaterThan(10 * 1024);
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(JSON.parse(stdout)).toMatchObject({
      command: "task handoff",
      result: { task_id: taskId, claim_id: claimId, truncated: true },
    });
  });

  it("does not let a marker-bearing installed bin bypass the callback lock", async () => {
    await execFile("npm", ["run", "build"], { cwd: mcpRoot, encoding: "utf8" });
    const root = await mkdtemp(join(tmpdir(), "jhw-control-bin-"));
    paths.push(root);
    const npmBin = join(root, "node_modules", ".bin");
    await mkdir(npmBin, { recursive: true });
    const installedBin = join(npmBin, "jhw-control");
    const stateDir = join(root, "state");
    await mkdir(join(root, "registry"));
    await mkdir(join(root, "worktrees"));
    await symlink(join(mcpRoot, "dist", "control", "cli.js"), installedBin);
    const failure = await execFile(installedBin, [
      "project", "register",
      "--project", "prj-control",
      "--title", "Control Trial",
      "--objective", "Prove callback locking",
      "--repo-id", "repo-control",
      "--status", "proposed",
      "--priority", "P2",
      "--health", "unknown",
      "--next-action", "wait:fixture",
      "--last-reviewed", "2026-08-13",
    ], {
      cwd: mcpRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        JHW_REGISTRY_DIR: join(root, "registry"),
        JHW_WORKTREE_ROOT: join(root, "worktrees"),
        JHW_BUILD_HOST: "build-host",
        JHW_GITHUB_OWNER: "owner",
        JHW_PROJECT_NUMBER: "1",
        JHW_REGISTRY_REPOSITORY: "owner/registry",
        JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
        JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
        JHW_CONTROL_STATE_DIR: stateDir,
        JHW_CONTROL_LOCK_HELD: "1",
        GH_PROJECT_TOKEN: "entry-project-token",
        GH_REPO_TOKEN: "entry-repo-token",
      },
    }).catch((cause: unknown) => cause as { code: number; stdout: string; stderr: string });

    expect(failure).toMatchObject({ code: 1, stdout: "" });
    expect(JSON.parse(failure.stderr)).toEqual({ error: { code: "REGISTRY_CORRUPT" } });
    expect(failure.stderr).not.toContain("entry-project-token");
    expect(failure.stderr).not.toContain("entry-repo-token");
    expect((await lstat(join(stateDir, "registry.lock"))).isFile()).toBe(true);
    const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");
    expect(journal).not.toContain("entry-project-token");
    expect(journal).not.toContain("entry-repo-token");
    expect(JSON.parse(journal)).toMatchObject({ command: "project register", error_code: "REGISTRY_CORRUPT" });
  });

  it("exits promptly after a fast observe hook decision and writes no deadline row", async () => {
    // Built here, in this file, because the tests above rebuild the shared dist.
    await execFile("npm", ["run", "build"], { cwd: mcpRoot, encoding: "utf8" });
    const home = await mkdtemp(join(tmpdir(), "jhw-hook-timer-"));
    paths.push(home);
    const environment = { HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const registry = join(home, "registry");
    const repository = join(home, "repository");
    for (const directory of [registry, repository]) {
      await mkdir(directory, { mode: 0o700 });
      await execFile("/usr/bin/git", ["init", "--initial-branch=main"], { cwd: directory, env: environment });
      await writeFile(join(directory, "README.md"), "fixture\n");
      await execFile("/usr/bin/git", ["add", "README.md"], { cwd: directory, env: environment });
      await execFile("/usr/bin/git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], {
        cwd: directory, env: environment,
      });
    }
    const config = join(home, ".config", "jhw-control");
    const stateDir = join(home, "state");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(join(config, "control.env"), Object.entries({
      JHW_REGISTRY_DIR: registry, JHW_REGISTRY_REMOTE: "origin", JHW_REGISTRY_BRANCH: "main",
      JHW_WORKTREE_ROOT: join(home, "worktrees"), JHW_CONTROL_STATE_DIR: stateDir, JHW_BUILD_HOST: "fixture-host",
      JHW_GITHUB_OWNER: "fixture-owner", JHW_PROJECT_NUMBER: "1", JHW_REGISTRY_REPOSITORY: "fixture-owner/registry",
      JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_fixture", JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
    }).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
    await writeFile(join(config, "guard-policy.json"), '{"version":1,"mode":"observe"}\n', { mode: 0o600 });
    const input = JSON.stringify({
      session_id: "timer-session", cwd: repository, hook_event_name: "PreToolUse", model: "fixture-model",
      permission_mode: "default", transcript_path: null, turn_id: "fixture-turn",
      tool_name: "Read", tool_input: { file_path: "README.md" }, tool_use_id: "fixture-read",
    });

    const started = performance.now();
    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveOutcome, reject) => {
      const child = spawn(process.execPath, [join(mcpRoot, "dist", "control", "hook-adapter.js"), "--adapter", "codex", "--event", "PreToolUse"], {
        env: environment, stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolveOutcome({ code, stdout, stderr }));
      child.stdin.end(input);
    });
    const elapsed = performance.now() - started;

    expect(outcome).toEqual({ code: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}\n', stderr: "" });
    // A deadline timer that stayed armed or ref'd would keep the process alive for 6.5 s.
    expect(elapsed).toBeLessThan(3_000);
    const diagnostics = await readFile(join(stateDir, "guard-hook-diagnostics.v1.jsonl"), "utf8").catch(() => "");
    expect(diagnostics).not.toContain('"kind":"deadline"');
  });
});
