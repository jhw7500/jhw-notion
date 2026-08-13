import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import type { ControlConfig } from "../config.js";
import { sanitizedChildEnvironment } from "../process.js";

const execFile = promisify(execFileCallback);
const TEST_NAME = "Phase1A Test";
const TEST_EMAIL = "phase1a@example.invalid";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...sanitizedChildEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

export async function commitFile(cwd: string, path: string, content: string): Promise<void> {
  const target = join(cwd, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  await git(cwd, "add", "--", path);
  await git(cwd, "commit", "-m", `Update ${path}`);
}

export interface RegistryFixture {
  root: string;
  tempDir: string;
  remoteDir: string;
  registryDir: string;
  registryCloneDir: string;
  otherCloneDir: string;
  cleanup: () => Promise<void>;
}

async function configureCommitIdentity(cwd: string): Promise<void> {
  await git(cwd, "config", "user.name", TEST_NAME);
  await git(cwd, "config", "user.email", TEST_EMAIL);
}

/** Creates a bare remote and two independent clones for registry concurrency tests. */
export async function makeRegistryFixture(): Promise<RegistryFixture> {
  const root = await mkdtemp(join(tmpdir(), "jhw-control-"));
  const remoteDir = join(root, "registry.git");
  const registryDir = join(root, "registry");
  const otherCloneDir = join(root, "other-registry");

  await git(root, "init", "--bare", "--initial-branch=main", remoteDir);
  await git(root, "clone", remoteDir, registryDir);
  await configureCommitIdentity(registryDir);
  await commitFile(registryDir, "README.md", "# Test registry\n");
  await git(registryDir, "push", "-u", "origin", "main");
  await git(root, "clone", remoteDir, otherCloneDir);
  await configureCommitIdentity(otherCloneDir);

  return {
    root,
    tempDir: root,
    remoteDir,
    registryDir,
    registryCloneDir: registryDir,
    otherCloneDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function configFor(registryDir: string): ControlConfig {
  return {
    registryDir,
    registryRemote: "origin",
    registryBranch: "main",
    worktreeRoot: join(dirname(registryDir), "worktrees"),
    buildHost: "cantopsbuildserver",
    githubOwner: "jhw7500",
    projectNumber: 7,
    registryRepository: "jhw7500/project-registry",
    preflightProjectItemId: "PVTI_trial",
    preflightRegistryIssueNumber: 1,
    stateDir: join(dirname(registryDir), "state"),
  };
}
