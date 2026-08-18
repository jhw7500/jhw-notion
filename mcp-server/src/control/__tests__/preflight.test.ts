import { describe, expect, it } from "vitest";

import type { ControlConfig } from "../config.js";
import { ControlError } from "../errors.js";
import { PreflightService, type PreflightProjectPort, type PreflightRunner } from "../preflight.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "../sensitive-data.js";

const PREFLIGHT_ISSUE = {
  node_id: "I_fixture",
  number: 9,
  html_url: "https://github.com/owner/registry/issues/9",
  title: "trial",
  body: "unchanged",
  labels: [{ name: "trial", color: "ededed" }],
};

function config(): ControlConfig {
  return {
    registryDir: "/srv/registry",
    registryRemote: "origin",
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
  let lastReviewed: string | undefined = "2026-08-12";
  return {
    verifyFields: async () => undefined,
    verifyPreflightItem: async () => undefined,
    readLastReviewed: async () => lastReviewed,
    writeLastReviewed: async (_itemId, date) => { lastReviewed = date; },
    clearLastReviewed: async () => { lastReviewed = undefined; },
    ...overrides,
  };
}

function service(input: {
  environment?: NodeJS.ProcessEnv;
  runner?: QueuedRunner;
  project?: PreflightProjectPort;
  remoteUrl?: string;
  pushRemoteUrl?: string;
  registryRoot?: string;
  authority?: { observeCommittedLegacy(): Promise<void> };
  notion?: { verifyReadOnlyRoutes(): Promise<void> };
  repository?: { verifyPrivateRepository(slug: string): Promise<void> };
  registry?: { assertReady(): Promise<void> };
  sensitiveData?: SensitiveDataPolicy;
}) {
  const runner = input.runner ?? new QueuedRunner();
  runner.enqueueGh(
    { stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n" },
    { stdout: `${JSON.stringify(PREFLIGHT_ISSUE)}\n` },
    { stdout: `${JSON.stringify(PREFLIGHT_ISSUE)}\n` },
  );
  return {
    runner,
    preflight: new PreflightService({
      config: config(),
      environment: input.environment ?? { GH_PROJECT_TOKEN: "project-secret", GH_REPO_TOKEN: "repo-secret" },
      runner,
      project: input.project ?? projectPort(),
      authority: input.authority ?? { observeCommittedLegacy: async () => undefined },
      notion: input.notion ?? { verifyReadOnlyRoutes: async () => undefined },
      repository: input.repository ?? { verifyPrivateRepository: async () => undefined },
      registry: input.registry ?? { assertReady: async () => undefined },
      sensitiveData: input.sensitiveData,
      remoteUrl: async () => input.remoteUrl ?? "git@github.com:owner/registry.git",
      pushRemoteUrl: async () => input.pushRemoteUrl ?? input.remoteUrl ?? "git@github.com:owner/registry.git",
      registryRoot: async () => input.registryRoot ?? config().registryDir,
      today: () => "2026-08-13",
    }),
  };
}

describe("PreflightService", () => {
  it("requires the exact Registry readiness authority port", () => {
    expect(() => new PreflightService({
      config: config(),
      environment: { GH_PROJECT_TOKEN: "project-secret", GH_REPO_TOKEN: "repo-secret" },
      runner: new QueuedRunner(),
      project: projectPort(),
      authority: { observeCommittedLegacy: async () => undefined },
      notion: { verifyReadOnlyRoutes: async () => undefined },
      repository: { verifyPrivateRepository: async () => undefined },
    } as any)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it("rejects protected Registry Issue content before an unchanged write or Project mutation", async () => {
    const secret = "unmistakably-fake-preflight-token";
    const runner = new QueuedRunner();
    runner.enqueueGh(
      { stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n" },
      { stdout: `${JSON.stringify({ ...PREFLIGHT_ISSUE, body: `contains ${secret}` })}\n` },
    );
    let projectCalls = 0;
    const project = projectPort({
      verifyFields: async () => { projectCalls += 1; },
      verifyPreflightItem: async () => { projectCalls += 1; },
    });
    const { preflight } = service({
      runner,
      project,
      sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    });

    const error = await preflight.run().catch((cause) => cause);
    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(projectCalls).toBe(0);
    expect(runner.ghCalls).toHaveLength(2);
  });

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

  it.each(["read:user", "admin:org", "workflow", "delete_repo", "gist", "user"])(
    "rejects unexpected classic Project PAT scope %s",
    async (extraScope) => {
    const runner = new QueuedRunner();
    runner.enqueueGh({ stdout: `HTTP/2.0 200 OK\r\nx-oauth-scopes: project, ${extraScope}\r\n\r\n{}\n` });
    const { preflight } = service({ runner });

    await expect(preflight.run()).rejects.toMatchObject({ code: "PROJECT_SCOPE_NOT_EXACT" });
    },
  );

  it.each([
    ["authority", "AUTHORITY_UNAVAILABLE"],
    ["notion", "NOTION_GUARD_INDETERMINATE"],
    ["repository", "REPOSITORY_NOT_PRIVATE"],
  ] as const)("fails before every Project/Issue mutation when %s prerequisite is unavailable", async (failed, code) => {
    const project = projectPort({
      verifyPreflightItem: async () => { throw new Error("must not read Project fixture"); },
      writeLastReviewed: async () => { throw new Error("must not mutate"); },
      clearLastReviewed: async () => { throw new Error("must not mutate"); },
    });
    const reject = async () => { throw new ControlError(code, "safe prerequisite failure"); };
    const { preflight } = service({
      project,
      ...(failed === "authority" ? { authority: { observeCommittedLegacy: reject } } : {}),
      ...(failed === "notion" ? { notion: { verifyReadOnlyRoutes: reject } } : {}),
      ...(failed === "repository" ? { repository: { verifyPrivateRepository: reject } } : {}),
    });

    await expect(preflight.run()).rejects.toMatchObject({ code });
  });

  it.each([
    ["an ignored Registry path", "REGISTRY_DIRTY"],
    ["an assume-unchanged Registry index", "REGISTRY_INDEX_UNSAFE"],
  ])("rejects %s through the shared readiness proof before trial mutation", async (_label, code) => {
    let projectCalls = 0;
    const project = projectPort({ verifyPreflightItem: async () => { projectCalls += 1; } });
    const registry = { assertReady: async () => { throw new ControlError(code, "safe readiness failure"); } };
    const { preflight, runner } = service({ project, registry });

    await expect(preflight.run()).rejects.toMatchObject({ code });
    expect(projectCalls).toBe(0);
    expect(runner.ghCalls).toHaveLength(1);
  });

  it("requires committed legacy authority, read-only Notion guard routes, and a private Registry repository", async () => {
    const calls: string[] = [];
    const { preflight } = service({
      authority: { observeCommittedLegacy: async () => { calls.push("authority"); } },
      notion: { verifyReadOnlyRoutes: async () => { calls.push("notion"); } },
      repository: { verifyPrivateRepository: async (slug) => { calls.push(`repository:${slug}`); } },
    });

    const result = await preflight.run();

    expect(calls).toEqual(["repository:owner/registry", "authority", "notion"]);
    expect(result.checks).toMatchObject({ authority: "ok", notion_guard: "ok", registry_repository: "ok" });
  });

  it("rejects a preflight fixture that is also labeled as a Project Record", async () => {
    const runner = new QueuedRunner();
    runner.enqueueGh(
      { stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n" },
      { stdout: `${JSON.stringify({
        ...PREFLIGHT_ISSUE,
        labels: [{ name: "trial" }, { name: "project-record" }],
      })}\n` },
    );
    const { preflight } = service({ runner });

    await expect(preflight.run()).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_ISSUE" });
    expect(runner.ghCalls).toHaveLength(2);
  });

  it("rejects an unchanged-write response that no longer proves the trial-only label boundary", async () => {
    const runner = new QueuedRunner();
    runner.enqueueGh(
      { stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n" },
      { stdout: `${JSON.stringify(PREFLIGHT_ISSUE)}\n` },
      { stdout: `${JSON.stringify({
        ...PREFLIGHT_ISSUE,
        labels: [{ name: "trial", color: "ededed" }, { name: "project-record", color: "ffffff" }],
      })}\n` },
    );
    const { preflight } = service({ runner });

    await expect(preflight.run()).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_ISSUE" });
    expect(runner.ghCalls).toHaveLength(3);
    expect(runner.calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
  });

  it.each([
    ["wrong issue number", { number: 10 }],
    ["wrong issue URL", { html_url: "https://github.com/owner/other/issues/9" }],
  ])("rejects %s before Project or Issue mutation", async (_label, override) => {
    const runner = new QueuedRunner();
    runner.enqueueGh(
      { stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n" },
      { stdout: `${JSON.stringify({ ...PREFLIGHT_ISSUE, ...override })}\n` },
    );
    let projectCalls = 0;
    const project = projectPort({ verifyPreflightItem: async () => { projectCalls += 1; } });

    await expect(service({ runner, project }).preflight.run()).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_ISSUE" });
    expect(projectCalls).toBe(0);
    expect(runner.ghCalls).toHaveLength(2);
  });

  it("rejects a REST label whose required name is blank", async () => {
    const runner = new QueuedRunner();
    runner.enqueueGh(
      { stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n" },
      { stdout: `${JSON.stringify({
        ...PREFLIGHT_ISSUE,
        labels: [{ name: "trial", color: "ededed" }, { name: "", color: "ffffff" }],
      })}\n` },
      { stdout: `${JSON.stringify(PREFLIGHT_ISSUE)}\n` },
    );
    const { preflight } = service({ runner });

    await expect(preflight.run()).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_ISSUE" });
    expect(runner.ghCalls).toHaveLength(2);
  });

  it("restores Last Reviewed in finally when the write probe fails", async () => {
    const writes: string[] = [];
    const project = projectPort({
      writeLastReviewed: async (_itemId, date) => {
        writes.push(date);
        if (date === "2026-08-13") throw new ControlError("COMMAND_FAILED", "command failed", {
          stderr: "GraphQL: Resource not accessible by personal access token",
        });
      },
    });
    const { preflight } = service({ project });

    await expect(preflight.run()).rejects.toMatchObject({ code: "COMMAND_FAILED" });
    expect(writes).toEqual(["2026-08-13", "2026-08-12"]);
  });

  it.each(["missing", "wrong-content"])("fails closed when the configured DraftIssue fixture is %s", async (_label) => {
    let writeCalls = 0;
    const { preflight } = service({ project: projectPort({
      verifyPreflightItem: async () => { throw new ControlError("INVALID_PREFLIGHT_ITEM", "invalid fixed DraftIssue"); },
      writeLastReviewed: async () => { writeCalls += 1; },
    }) });

    await expect(preflight.run()).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_ITEM" });
    expect(writeCalls).toBe(0);
  });

  it("preserves Project transport failures instead of misclassifying them as scope", async () => {
    const project = projectPort({
      verifyPreflightItem: async () => { throw new ControlError("COMMAND_TIMEOUT", "bounded transport timeout"); },
    });

    await expect(service({ project }).preflight.run()).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  });

  it("rejects a no-op Last Reviewed probe after reading the field back", async () => {
    const writes: string[] = [];
    const project = projectPort({
      readLastReviewed: async () => "2026-08-12",
      writeLastReviewed: async (_itemId, date) => { writes.push(date); },
    });

    await expect(service({ project }).preflight.run()).rejects.toMatchObject({ code: "PREFLIGHT_PROJECT_INTEGRITY" });
    expect(writes).toEqual(["2026-08-13", "2026-08-12"]);
  });

  it("rejects a no-op restore after reading the original field back", async () => {
    let current = "2026-08-12";
    const project = projectPort({
      readLastReviewed: async () => current,
      writeLastReviewed: async (_itemId, date) => {
        if (date !== "2026-08-12") current = date;
      },
    });

    await expect(service({ project }).preflight.run()).rejects.toMatchObject({ code: "PREFLIGHT_RESTORE_FAILED" });
  });

  it("proves issue read/unchanged write and SSH fetch/non-mutating dry-run push", async () => {
    const { preflight, runner } = service({});

    const result = await preflight.run();

    expect(result).toEqual({
      status: "ready",
      checks: {
        credentials: "ok", authority: "ok", notion_guard: "ok", project: "ok",
        registry_repository: "ok", registry_issue: "ok", registry_git: "ok",
      },
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
      { command: "git", args: ["status", "--porcelain=v1", "--untracked-files=all"], cwd: "/srv/registry" },
      { command: "git", args: ["fetch", "origin", "main"], cwd: "/srv/registry" },
      { command: "git", args: ["rev-parse", "HEAD"], cwd: "/srv/registry" },
      { command: "git", args: ["rev-parse", "origin/main"], cwd: "/srv/registry" },
      { command: "git", args: ["push", "--dry-run", "origin", "HEAD:main"], cwd: "/srv/registry" },
    ]);
  });

  it("rejects a non-SSH Registry remote without invoking Git", async () => {
    const { preflight, runner } = service({ remoteUrl: "https://github.com/owner/registry.git" });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REGISTRY_REMOTE_NOT_SSH" });
    expect(runner.calls).toEqual([]);
  });

  it("rejects an SSH Registry remote for a different canonical repository", async () => {
    const project = projectPort({
      verifyPreflightItem: async () => { throw new Error("must not read Project fixture"); },
      writeLastReviewed: async () => { throw new Error("must not mutate"); },
    });
    const { preflight, runner } = service({ remoteUrl: "git@github.com:owner/other.git", project });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REGISTRY_REMOTE_MISMATCH" });
    expect(runner.calls).toEqual([]);
  });

  it("does not observe or persist authority before Registry identity is proven", async () => {
    let authorityCalls = 0;
    const { preflight } = service({
      remoteUrl: "git@github.com:owner/other.git",
      authority: { observeCommittedLegacy: async () => { authorityCalls += 1; } },
    });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REGISTRY_REMOTE_MISMATCH" });
    expect(authorityCalls).toBe(0);
  });

  it("rejects a different effective Registry push URL before trial mutations", async () => {
    let projectCalls = 0;
    const project = projectPort({ verifyPreflightItem: async () => { projectCalls += 1; } });
    const { preflight, runner } = service({
      pushRemoteUrl: "git@github.com:owner/other.git",
      project,
    });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REGISTRY_REMOTE_MISMATCH" });
    expect(projectCalls).toBe(0);
    expect(runner.ghCalls).toHaveLength(1);
  });

  it("rejects a Registry subdirectory before trial mutations", async () => {
    let projectCalls = 0;
    const project = projectPort({ verifyPreflightItem: async () => { projectCalls += 1; } });
    const { preflight, runner } = service({
      registryRoot: "/srv/registry-parent",
      project,
    });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REGISTRY_ROOT_MISMATCH" });
    expect(projectCalls).toBe(0);
    expect(runner.ghCalls).toHaveLength(1);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a dirty Registry checkout before trial mutations", async () => {
    const runner = new QueuedRunner();
    const run = runner.run.bind(runner);
    runner.run = async (command, args, options) => args[0] === "status"
      ? { command, args, stdout: "?? repositories/untracked.yaml\n", stderr: "", exitCode: 0 }
      : run(command, args, options);
    let projectCalls = 0;
    const project = projectPort({ verifyPreflightItem: async () => { projectCalls += 1; } });
    const { preflight } = service({ runner, project });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REGISTRY_DIRTY" });
    expect(projectCalls).toBe(0);
    expect(runner.ghCalls).toHaveLength(1);
  });

  it("rejects a locally ahead Registry checkout before trial mutations", async () => {
    const runner = new QueuedRunner();
    const run = runner.run.bind(runner);
    runner.run = async (command, args, options) => args[0] === "rev-parse"
      ? {
        command,
        args,
        stdout: args[1] === "HEAD" ? `${"a".repeat(40)}\n` : `${"b".repeat(40)}\n`,
        stderr: "",
        exitCode: 0,
      }
      : run(command, args, options);
    let projectCalls = 0;
    const project = projectPort({ verifyPreflightItem: async () => { projectCalls += 1; } });
    const { preflight } = service({ runner, project });

    await expect(preflight.run()).rejects.toMatchObject({ code: "REMOTE_DIVERGED" });
    expect(projectCalls).toBe(0);
    expect(runner.ghCalls).toHaveLength(1);
  });
});
