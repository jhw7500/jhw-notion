import { describe, expect, it } from "vitest";

import type { ControlConfig } from "../config.js";
import { ControlError } from "../errors.js";
import { PreflightService, type PreflightProjectPort, type PreflightRunner } from "../preflight.js";

function config(): ControlConfig {
  return {
    registryDir: "/srv/registry",
    registryRemote: "git@github.com:owner/registry.git",
    registryBranch: "main",
    worktreeRoot: "/srv/worktrees",
    buildHost: "build-host",
    githubOwner: "owner",
    projectNumber: 7,
    registryRepository: "owner/registry",
    preflightProjectItemId: "PVTI_trial",
    preflightRegistryIssueNumber: 9,
    stateDir: "/srv/state",
  };
}

class QueuedRunner implements PreflightRunner {
  readonly ghCalls: Array<{ args: string[]; credential: "project" | "repo" }> = [];
  readonly calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  private readonly ghResponses: Array<{ stdout: string }> = [];

  enqueueGh(...responses: Array<{ stdout: string }>): void {
    this.ghResponses.push(...responses);
  }

  async runGh(args: string[], credential: "project" | "repo") {
    this.ghCalls.push({ args, credential });
    const response = this.ghResponses.shift();
    if (!response) throw new Error("Queued preflight gh response exhausted");
    return { command: "gh", args, stdout: response.stdout, stderr: "", exitCode: 0 as const };
  }

  async run(command: string, args: string[], options?: { cwd?: string }) {
    this.calls.push({ command, args, cwd: options?.cwd });
    return { command, args, stdout: "", stderr: "", exitCode: 0 as const };
  }
}

function projectPort(overrides: Partial<PreflightProjectPort> = {}): PreflightProjectPort {
  return {
    verifyFields: async () => undefined,
    addPreflightItem: async () => "PVTI_trial",
    verifyItemContentId: async () => "I_fixture",
    readLastReviewed: async () => "2026-08-12",
    writeLastReviewed: async () => undefined,
    clearLastReviewed: async () => undefined,
    ...overrides,
  };
}

function service(input: {
  environment?: NodeJS.ProcessEnv;
  runner?: QueuedRunner;
  project?: PreflightProjectPort;
  remoteUrl?: string;
}) {
  const runner = input.runner ?? new QueuedRunner();
  runner.enqueueGh(
    { stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n" },
    { stdout: `${JSON.stringify({ node_id: "I_fixture", title: "trial", body: "unchanged", labels: [{ name: "trial" }] })}\n` },
    { stdout: `${JSON.stringify({ node_id: "I_fixture", title: "trial", body: "unchanged", labels: [{ name: "trial" }] })}\n` },
  );
  return {
    runner,
    preflight: new PreflightService({
      config: config(),
      environment: input.environment ?? { GH_PROJECT_TOKEN: "project-secret", GH_REPO_TOKEN: "repo-secret" },
      runner,
      project: input.project ?? projectPort(),
      remoteUrl: async () => input.remoteUrl ?? "git@github.com:owner/registry.git",
      today: () => "2026-08-13",
    }),
  };
}

describe("PreflightService", () => {
  it.each([
    [{ GH_PROJECT_TOKEN: "same", GH_REPO_TOKEN: "same" }, "CREDENTIALS_NOT_SEPARATE"],
    [{ GH_PROJECT_TOKEN: "only" }, "MISSING_CREDENTIAL"],
  ])("requires two distinct credentials without including them in errors", async (environment, code) => {
    const { preflight } = service({ environment });

    const error = await preflight.run().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain("same");
    expect(JSON.stringify(error)).not.toContain("only");
  });

  it("requires exact classic PAT project scope and rejects repo scope", async () => {
    const runner = new QueuedRunner();
    runner.enqueueGh({ stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project, repo\r\n\r\n{}\n" });
    const { preflight } = service({ runner });

    await expect(preflight.run()).rejects.toMatchObject({ code: "PROJECT_TOKEN_HAS_REPO_SCOPE" });
  });

  it("restores Last Reviewed in finally when the write probe fails", async () => {
    const writes: string[] = [];
    const project = projectPort({
      writeLastReviewed: async (_itemId, date) => {
        writes.push(date);
        if (date === "2026-08-13") throw new ControlError("COMMAND_FAILED", "private content inaccessible");
      },
    });
    const { preflight } = service({ project });

    await expect(preflight.run()).rejects.toMatchObject({ code: "PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE" });
    expect(writes).toEqual(["2026-08-13", "2026-08-12"]);
  });

  it("fails closed when the project-only credential sees no immutable content ID", async () => {
    const { preflight } = service({ project: projectPort({ verifyItemContentId: async () => undefined }) });

    await expect(preflight.run()).rejects.toMatchObject({ code: "PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE" });
  });

  it("proves issue read/unchanged write and SSH fetch/non-mutating dry-run push", async () => {
    const { preflight, runner } = service({});

    const result = await preflight.run();

    expect(result).toEqual({
      status: "ready",
      checks: { credentials: "ok", project: "ok", registry_issue: "ok", registry_git: "ok" },
    });
    expect(runner.ghCalls.map((call) => call.credential)).toEqual(["project", "repo", "repo"]);
    expect(runner.ghCalls[1]?.args).toEqual([
      "api", "repos/owner/registry/issues/9",
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2026-03-10",
    ]);
    expect(runner.ghCalls[2]?.args).toEqual([
      "api", "--method", "PATCH", "repos/owner/registry/issues/9",
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2026-03-10",
      "--raw-field", "body=unchanged",
    ]);
    expect(runner.calls).toEqual([
      { command: "git", args: ["fetch", "git@github.com:owner/registry.git", "main"], cwd: "/srv/registry" },
      { command: "git", args: ["push", "--dry-run", "git@github.com:owner/registry.git", "HEAD:main"], cwd: "/srv/registry" },
    ]);
  });

  it("rejects a non-SSH Registry remote without invoking Git", async () => {
    const { preflight, runner } = service({ remoteUrl: "https://github.com/owner/registry.git" });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REGISTRY_REMOTE_NOT_SSH" });
    expect(runner.calls).toEqual([]);
  });
});
