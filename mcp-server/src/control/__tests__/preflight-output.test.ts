import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { format } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commitFile, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

vi.mock("../../env.js", () => ({
  loadNotionEnv: () => { throw new Error("Host credential fallback is forbidden in this fixture"); },
}));

const fixtures: RegistryFixture[] = [];
const notionToken = "synthetic-preflight-notion-token";

beforeEach(() => { vi.resetModules(); });

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function dependenciesForNotionProbe() {
  const { createCliDependencies, runCli } = await import("../cli.js");
  const { ProcessRunner } = await import("../process.js");
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  await commitFile(fixture.registryDir, "governance/authority.yaml", JSON.stringify({
    authority_epoch: 1, mode: "legacy", cutover_at: null, minimum_tool_version: "1.0.0",
  }));
  await git(fixture.registryDir, "push", "origin", "main");
  const stateDir = join(fixture.root, "state");
  const environment = {
    HOME: fixture.root,
    PATH: process.env.PATH,
    JHW_REGISTRY_DIR: fixture.registryDir,
    JHW_WORKTREE_ROOT: join(fixture.root, "worktrees"),
    JHW_CONTROL_STATE_DIR: stateDir,
    JHW_BUILD_HOST: "test-host",
    JHW_GITHUB_OWNER: "owner",
    JHW_PROJECT_NUMBER: "1",
    JHW_REGISTRY_REPOSITORY: "owner/registry",
    JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
    JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
    GH_PROJECT_TOKEN: "synthetic-preflight-project-token",
    GH_REPO_TOKEN: "synthetic-preflight-repo-token",
    NOTION_API_KEY: notionToken,
  };
  // Git fetches remain real, but target only the fixture's local bare remote.
  const run = ProcessRunner.prototype.run;
  vi.spyOn(ProcessRunner.prototype, "run").mockImplementation(function (this: InstanceType<typeof ProcessRunner>, command, args, options) {
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      return Promise.resolve({ command, args, stdout: "git@github.com:owner/registry.git\n", stderr: "", exitCode: 0 });
    }
    return run.call(this, command, args, options);
  });
  const githubRequests: string[][] = [];
  vi.spyOn(ProcessRunner.prototype, "runGh").mockImplementation(async (args, credential) => {
    githubRequests.push(args);
    if (credential === "project" && args[0] === "api" && args.includes("/user")) {
      return { command: "gh", args, stdout: "HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n", stderr: "", exitCode: 0 };
    }
    if (credential === "repo" && args.join(" ") === "api repos/owner/registry") {
      return { command: "gh", args, stdout: JSON.stringify({ node_id: "R_fixture", full_name: "owner/registry", private: true }), stderr: "", exitCode: 0 };
    }
    throw new Error("Unexpected GitHub request; no real API calls are allowed");
  });
  return { dependencies: createCliDependencies(environment), runCli, stateDir, githubRequests };
}

describe("preflight Notion output boundary", () => {
  it.each([
    [401, "unauthorized"],
    [403, "restricted_resource"],
    [404, "object_not_found"],
  ])("keeps SDK warnings for HTTP %i out of the stable error JSON and journal", async (status, code) => {
    vi.stubEnv("NOTION_API_KEY", notionToken);
    const warningChunks: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => { warningChunks.push(format(...args) + "\n"); });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      object: "error", status, code,
      message: `Synthetic server echo: ${notionToken} /private/fixture`,
      request_id: "synthetic-request-id",
    }), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const { dependencies, runCli, stateDir, githubRequests } = await dependenciesForNotionProbe();

    const result = await runCli(["preflight"], dependencies);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(githubRequests).toHaveLength(2);
    expect(result.exitCode).toBe(78);
    expect(result.stdout).toBe("");
    // This is the complete stream the host sees, including the SDK's logger.
    expect(warningChunks.join("") + result.stderr).toBe('{"error":{"code":"NOTION_GUARD_INDETERMINATE"}}\n');
    const journal = await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8");
    expect(JSON.parse(journal)).toMatchObject({ command: "preflight", ok: false, error_code: "NOTION_GUARD_INDETERMINATE" });
    expect(result.stderr + journal).not.toContain(notionToken);
    expect(result.stderr + journal).not.toContain("/private/fixture");
    expect(result.stderr + journal).not.toContain("synthetic-request-id");
  });

  it("does not fall back to ambient credentials when the host Notion credential is missing", async () => {
    vi.stubEnv("NOTION_API_KEY", "synthetic-ambient-token");
    const fetch = vi.fn(async () => { throw new Error("No unauthenticated request is allowed"); });
    vi.stubGlobal("fetch", fetch);
    const { dependencies, runCli } = await dependenciesForNotionProbe();
    delete dependencies.env.NOTION_API_KEY;

    const result = await runCli(["preflight"], dependencies);

    expect(result).toEqual({ exitCode: 78, stdout: "", stderr: '{"error":{"code":"MISSING_CREDENTIAL"}}\n' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the injected host credential without requiring the MCP singleton's environment", async () => {
    vi.stubEnv("NOTION_API_KEY", undefined);
    const authorization: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_url: unknown, options: RequestInit) => {
      authorization.push(new Headers(options.headers).get("authorization"));
      return new Response(JSON.stringify({ object: "error", status: 401, code: "unauthorized", message: "Synthetic rejection" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    });
    const { dependencies, runCli } = await dependenciesForNotionProbe();

    const result = await runCli(["preflight"], dependencies);

    expect(authorization).toEqual([`Bearer ${notionToken}`]);
    expect(result).toEqual({ exitCode: 78, stdout: "", stderr: '{"error":{"code":"NOTION_GUARD_INDETERMINATE"}}\n' });
  });

  it("preserves the MCP client's default request logging", async () => {
    vi.stubEnv("NOTION_API_KEY", notionToken);
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(format(...args)); });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      object: "error", status: 404, code: "object_not_found", message: "Synthetic MCP rejection",
    }), { status: 404, headers: { "content-type": "application/json" } }));
    const { getNotionClient } = await import("../../notion-client.js");

    await expect(getNotionClient().databases.retrieve({ database_id: "00000000-0000-4000-8000-000000000001" }))
      .rejects.toMatchObject({ code: "object_not_found" });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("request fail");
  });
});
