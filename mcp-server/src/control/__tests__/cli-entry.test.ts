import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const paths: string[] = [];
const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("jhw-control installed entry", () => {
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

  it("routes a marker-bearing mutation through the locked internal entrypoint", async () => {
    await execFile("npm", ["run", "build"], { cwd: mcpRoot, encoding: "utf8" });
    const root = await mkdtemp(join(tmpdir(), "jhw-control-bin-"));
    paths.push(root);
    const installedBin = join(root, "jhw-control");
    const stateDir = join(root, "state");
    await symlink(join(mcpRoot, "dist", "control", "cli.js"), installedBin);
    const sha = "a".repeat(40);
    const failure = await execFile(installedBin, ["project", "register", "--project", "prj-control", "--base-sha", sha], {
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
        JHW_CONTROL_STATE_DIR: stateDir,
        JHW_CONTROL_LOCK_HELD: "1",
        GH_PROJECT_TOKEN: "entry-project-token",
      },
    }).catch((cause: unknown) => cause as { code: number; stdout: string; stderr: string });

    expect(failure).toMatchObject({ code: 78, stdout: "" });
    expect(JSON.parse(failure.stderr)).toEqual({ error: { code: "PORTFOLIO_UNAVAILABLE" } });
    expect(failure.stderr).not.toContain("entry-project-token");
    expect((await lstat(join(stateDir, "registry.lock"))).isFile()).toBe(true);
    const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");
    expect(journal).not.toContain("entry-project-token");
    expect(JSON.parse(journal)).toMatchObject({ command: "project register", error_code: "PORTFOLIO_UNAVAILABLE" });
  });
});
