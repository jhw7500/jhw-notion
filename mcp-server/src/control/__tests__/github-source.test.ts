import { describe, expect, it, vi } from "vitest";

import { GitHubSourceService } from "../github-source.js";
import { createSensitiveDataPolicy } from "../sensitive-data.js";

const checkout = "/fixture/private-source/wlan";
const repository = { id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" };
const formal = {
  id: "tsk-0198aabb-ccdd-7eef-8abc-0123456789ab",
  kind: "formal" as const,
  project_id: "prj-wlan",
  repo_id: "repo-wlan",
  aliases: ["jhw7500/wlan#7"],
  issue_node_id: "I_wlan_7",
  issue_revision: "2026-08-14T00:00:00Z",
  issue_url: "https://github.com/jhw7500/wlan/issues/7",
};

function fixture(overrides: { remote?: string; private?: boolean; fullName?: string; issueState?: "open" | "closed" } = {}) {
  const catalog = {
    registerRepository: vi.fn(async (input) => ({ repository: { id: input.repo_id, github_node_id: input.github_node_id, slug: input.slug }, created: true })),
    getRepository: vi.fn(async () => repository),
    getTask: vi.fn(async () => formal),
    getTaskSourceRevision: vi.fn(async () => formal.issue_revision),
    registerFormalTask: vi.fn(async (input) => {
      const { alias, ...coordinates } = input;
      return { task: { ...formal, ...coordinates, aliases: [alias] }, created: true };
    }),
    registerTemporaryTask: vi.fn(),
    promoteTemporaryTask: vi.fn(),
  };
  const projects = { requireProjectRepository: vi.fn(async () => undefined) };
  const runner = {
    run: vi.fn(async (_command: string, args: string[]) => ({
      command: "git", args,
      stdout: args[0] === "rev-parse" ? `${checkout}\n` : (overrides.remote ?? "git@github.com:jhw7500/wlan.git\n"),
      stderr: "", exitCode: 0,
    })),
    runGh: vi.fn(async (args: string[]) => ({
      command: "gh", args,
      stdout: args[1] === "repos/jhw7500/wlan"
        ? `${JSON.stringify({ node_id: "R_wlan", full_name: overrides.fullName ?? "jhw7500/wlan", private: overrides.private ?? true })}\n`
        : `${JSON.stringify({
          node_id: "I_wlan_7",
          number: 7,
          html_url: "https://github.com/jhw7500/wlan/issues/7",
          updated_at: "2026-08-14T00:00:00Z",
          state: overrides.issueState ?? "open",
        })}\n`,
      stderr: "", exitCode: 0,
    })),
  };
  return { service: new GitHubSourceService({ runner, catalog, projects }), catalog, projects, runner };
}

describe("GitHubSourceService", () => {
  it("rejects the per-call checkout path before direct temporary Catalog mutation", async () => {
    const { service, catalog, projects, runner } = fixture();

    const error = await service.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      repository_path: checkout,
      alias: "wlan:tmp-20260814-01-path",
      goal: `do not persist ${checkout}`,
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/control"],
    }).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(checkout);
    expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
    expect(projects.requireProjectRepository).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects protected GitHub responses before Catalog mutation", async () => {
    const secret = "unmistakably-fake-source-token";
    const { catalog, projects, runner } = fixture();
    runner.runGh.mockResolvedValueOnce({
      command: "gh", args: [], stderr: "", exitCode: 0,
      stdout: `${JSON.stringify({ node_id: secret, full_name: "jhw7500/wlan", private: true })}\n`,
    });
    const service = new GitHubSourceService({
      runner,
      catalog,
      projects,
      sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    });

    const error = await service.registerRepository({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", repository_path: checkout,
    }).catch((cause) => cause);
    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(catalog.registerRepository).not.toHaveBeenCalled();
  });

  it("rejects checkout-path API data and overlong node IDs before Catalog mutation", async () => {
    const pathResponse = fixture();
    pathResponse.runner.runGh.mockResolvedValueOnce({
      command: "gh", args: [], stderr: "", exitCode: 0,
      stdout: `${JSON.stringify({ node_id: checkout, full_name: "jhw7500/wlan", private: true })}\n`,
    });
    await expect(pathResponse.service.registerRepository({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", repository_path: checkout,
    })).rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(pathResponse.catalog.registerRepository).not.toHaveBeenCalled();

    const overlong = fixture();
    overlong.runner.runGh.mockResolvedValueOnce({
      command: "gh", args: [], stderr: "", exitCode: 0,
      stdout: `${JSON.stringify({ node_id: `R_${"x".repeat(200)}`, full_name: "jhw7500/wlan", private: true })}\n`,
    });
    await expect(overlong.service.registerRepository({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", repository_path: checkout,
    })).rejects.toMatchObject({ code: "INVALID_REPOSITORY_RESPONSE" });
    expect(overlong.catalog.registerRepository).not.toHaveBeenCalled();
  });

  it("derives the private Repository node ID after binding the exact checkout origin", async () => {
    const { service, catalog } = fixture();

    await expect(service.registerRepository({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", repository_path: checkout,
    })).resolves.toMatchObject({ repository: { github_node_id: "R_wlan", slug: "jhw7500/wlan" } });

    expect(catalog.registerRepository).toHaveBeenCalledWith({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", github_node_id: "R_wlan",
    });
  });

  it.each([
    ["public repository", { private: false }, "REPOSITORY_NOT_PRIVATE"],
    ["API slug mismatch", { fullName: "jhw7500/other" }, "REPOSITORY_IDENTITY_MISMATCH"],
    ["remote mismatch", { remote: "git@github.com:jhw7500/other.git\n" }, "CHECKOUT_REMOTE_MISMATCH"],
    ["ambiguous origin", { remote: "git@github.com:jhw7500/wlan.git\ngit@github.com:jhw7500/wlan.git\n" }, "AMBIGUOUS_CHECKOUT_ORIGIN"],
  ])("rejects %s before Catalog mutation", async (_label, overrides, code) => {
    const { service, catalog } = fixture(overrides);
    await expect(service.registerRepository({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", repository_path: checkout,
    })).rejects.toMatchObject({ code });
    expect(catalog.registerRepository).not.toHaveBeenCalled();
  });

  it("derives formal Issue coordinates and alias after Project/Repository/checkout verification", async () => {
    const { service, catalog, projects } = fixture();

    await service.registerFormalTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      repository_path: checkout,
      issue_url: "https://github.com/jhw7500/wlan/issues/7",
    });

    expect(projects.requireProjectRepository).toHaveBeenCalledWith("prj-wlan", "repo-wlan");
    expect(catalog.registerFormalTask).toHaveBeenCalledWith({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      issue_node_id: "I_wlan_7",
      issue_revision: "2026-08-14T00:00:00Z",
      issue_url: "https://github.com/jhw7500/wlan/issues/7",
      alias: "jhw7500/wlan#7",
    });
  });

  it("rejects caller compatibility coordinates that disagree with the verified Issue", async () => {
    const { service, catalog } = fixture();

    await expect(service.registerFormalTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", repository_path: checkout,
      issue_url: "https://github.com/jhw7500/wlan/issues/7", expected_issue_node_id: "I_forged",
    })).rejects.toMatchObject({ code: "ISSUE_IDENTITY_MISMATCH" });
    expect(catalog.registerFormalTask).not.toHaveBeenCalled();
  });

  it("validates an existing canonical Task before it can be claimed", async () => {
    const { service, projects } = fixture();

    await expect(service.prepareExistingTask({ task_id: formal.id, repository_path: checkout })).resolves.toEqual({
      task: formal,
      alias: "jhw7500/wlan#7",
      source_task_revision: "2026-08-14T00:00:00Z",
    });
    expect(projects.requireProjectRepository).toHaveBeenCalledWith("prj-wlan", "repo-wlan");
  });

  it("refuses a closed formal Issue before existing Task ownership is created", async () => {
    const { service, catalog } = fixture({ issueState: "closed" });

    await expect(service.prepareExistingTask({ task_id: formal.id, repository_path: checkout })).rejects.toMatchObject({
      code: "TASK_COMPLETED",
    });

    expect(catalog.registerFormalTask).not.toHaveBeenCalled();
  });
});
