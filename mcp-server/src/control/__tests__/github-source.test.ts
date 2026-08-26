import { describe, expect, it, vi } from "vitest";

import { ControlError } from "../errors.js";
import { GitHubSourceService, type TaskCoordinateInput } from "../github-source.js";
import type { RepositoryRecord } from "../schemas.js";
import { createSensitiveDataPolicy } from "../sensitive-data.js";

const checkout = "/fixture/private-source/wlan";
const repository: RepositoryRecord = { id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan" };
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

if (false) {
  const acceptCoordinates = (_coordinates: TaskCoordinateInput): void => undefined;
  acceptCoordinates({ project_id: "prj-wlan", repo_id: "repo-wlan" });
  acceptCoordinates({ resolve_from_checkout: true });
  // @ts-expect-error mixed resolved and explicit coordinates are forbidden
  acceptCoordinates({ resolve_from_checkout: true, project_id: "prj-wlan", repo_id: "repo-wlan" });
  // @ts-expect-error false is not a supported resolver discriminant
  acceptCoordinates({ resolve_from_checkout: false, project_id: "prj-wlan", repo_id: "repo-wlan" });
  // @ts-expect-error one coordinate mode is required
  acceptCoordinates({});
  // @ts-expect-error explicit mode requires both Project and Repository coordinates
  acceptCoordinates({ project_id: "prj-wlan" });
  // @ts-expect-error explicit mode requires both Project and Repository coordinates
  acceptCoordinates({ repo_id: "repo-wlan" });
}

function fixture(overrides: {
  remote?: string;
  pushRemote?: string;
  checkoutRoot?: string;
  private?: boolean;
  fullName?: string;
  nodeId?: string;
  repository?: RepositoryRecord;
  issueState?: "open" | "closed";
  finalFenceError?: string;
} = {}) {
  const repositoryRecord = overrides.repository ?? repository;
  const pinnedRepositoryLookup = vi.fn();
  const catalog = {
    registerRepository: vi.fn(async (input) => ({ repository: { id: input.repo_id, github_node_id: input.github_node_id, slug: input.slug }, created: true })),
    getRepository: vi.fn(async () => repository),
    async withPinnedRepositoryByGitHubNode<T>(
      githubNodeId: string,
      use: (record: RepositoryRecord) => Promise<T>,
    ): Promise<T> {
      pinnedRepositoryLookup(githubNodeId);
      const result = await use(repositoryRecord);
      if (overrides.finalFenceError) {
        throw new ControlError(overrides.finalFenceError, "injected final fence refusal");
      }
      return result;
    },
    getTask: vi.fn(async () => formal),
    getTaskSourceRevision: vi.fn(async () => formal.issue_revision),
    registerFormalTask: vi.fn(async (input) => {
      const { alias, ...coordinates } = input;
      return { task: { ...formal, ...coordinates, aliases: [alias] }, created: true };
    }),
    registerTemporaryTask: vi.fn(),
    promoteTemporaryTask: vi.fn(),
  };
  const projects = {
    requireProjectRepository: vi.fn(async () => undefined),
    resolveUniqueProjectForRepository: vi.fn(async () => ({
      project_id: "prj-wlan",
      source_revision: "2026-08-26T00:00:00Z",
    })),
  };
  const runner = {
    run: vi.fn(async (_command: string, args: string[]) => ({
      command: "git", args,
      stdout: args[0] === "rev-parse"
        ? `${overrides.checkoutRoot ?? checkout}\n`
        : args.includes("--push")
          ? (overrides.pushRemote ?? overrides.remote ?? "git@github.com:jhw7500/wlan.git\n")
          : (overrides.remote ?? "git@github.com:jhw7500/wlan.git\n"),
      stderr: "", exitCode: 0,
    })),
    runGh: vi.fn(async (args: string[]) => ({
      command: "gh", args,
      stdout: args[1]?.startsWith("repos/") && !args[1].includes("/issues/")
        ? `${JSON.stringify({ node_id: overrides.nodeId ?? "R_wlan", full_name: overrides.fullName ?? "jhw7500/wlan", private: overrides.private ?? true })}\n`
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
  return {
    service: new GitHubSourceService({ runner, catalog, projects }),
    catalog,
    pinnedRepositoryLookup,
    projects,
    runner,
  };
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
    ["push remote mismatch", { pushRemote: "git@github.com:jhw7500/other.git\n" }, "CHECKOUT_REMOTE_MISMATCH"],
    ["ambiguous origin", { remote: "git@github.com:jhw7500/wlan.git\ngit@github.com:jhw7500/wlan.git\n" }, "AMBIGUOUS_CHECKOUT_ORIGIN"],
  ])("rejects %s before Catalog mutation", async (_label, overrides, code) => {
    const { service, catalog } = fixture(overrides);
    await expect(service.registerRepository({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", repository_path: checkout,
    })).rejects.toMatchObject({ code });
    expect(catalog.registerRepository).not.toHaveBeenCalled();
  });

  it("registers a public repository only with the explicit opt-in and persists it", async () => {
    const { service, catalog } = fixture({ private: false });

    await expect(service.registerRepository({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", repository_path: checkout, allow_public: true,
    })).resolves.toMatchObject({ created: true });

    expect(catalog.registerRepository).toHaveBeenCalledWith({
      repo_id: "repo-wlan", slug: "jhw7500/wlan", github_node_id: "R_wlan", allow_public: true,
    });
  });

  it("keeps the private requirement for task context on records without the opt-in", async () => {
    const { service, catalog } = fixture({ private: false });

    const error = await service.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      repository_path: checkout,
      alias: "wlan:tmp-20260819-01-optin",
      goal: "document the opt-in boundary",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/control"],
    }).catch((cause) => cause);

    expect(error).toMatchObject({ code: "REPOSITORY_NOT_PRIVATE" });
    expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
  });

  it("allows task context on a public repository whose record carries the opt-in", async () => {
    const { service, catalog } = fixture({ private: false });
    catalog.getRepository.mockResolvedValue({
      id: "repo-wlan", github_node_id: "R_wlan", slug: "jhw7500/wlan", allow_public: true,
    });

    await service.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      repository_path: checkout,
      alias: "wlan:tmp-20260819-02-optin",
      goal: "document the opt-in boundary",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/control"],
    });

    expect(catalog.registerTemporaryTask).toHaveBeenCalled();
  });

  it("verifies the Registry repository with no tolerance for the public opt-in", async () => {
    const { service } = fixture({ private: false });

    await expect(service.verifyPrivateRepository("jhw7500/wlan")).rejects.toMatchObject({
      code: "REPOSITORY_NOT_PRIVATE",
    });
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

  it("derives formal Task coordinates from the checkout inside one pinned Repository lookup", async () => {
    const { service, catalog, pinnedRepositoryLookup, projects } = fixture();

    await service.registerFormalTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      issue_url: "https://github.com/jhw7500/wlan/issues/7",
    });

    expect(pinnedRepositoryLookup).toHaveBeenCalledTimes(1);
    expect(pinnedRepositoryLookup).toHaveBeenCalledWith("R_wlan");
    expect(projects.resolveUniqueProjectForRepository).toHaveBeenCalledTimes(1);
    expect(projects.resolveUniqueProjectForRepository).toHaveBeenCalledWith("repo-wlan");
    expect(projects.requireProjectRepository).not.toHaveBeenCalled();
    expect(catalog.registerFormalTask).toHaveBeenCalledWith(expect.objectContaining({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
    }));
  });

  it("derives temporary Task coordinates from the checkout without membership revalidation", async () => {
    const { service, catalog, pinnedRepositoryLookup, projects } = fixture();

    await service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-01-resolved",
      goal: "verify checkout resolution",
      done_conditions: ["resolved source tests pass"],
      expected_scope: ["src/control"],
    });

    expect(pinnedRepositoryLookup).toHaveBeenCalledTimes(1);
    expect(projects.resolveUniqueProjectForRepository).toHaveBeenCalledWith("repo-wlan");
    expect(projects.requireProjectRepository).not.toHaveBeenCalled();
    expect(catalog.registerTemporaryTask).toHaveBeenCalledWith({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260826-01-resolved",
      goal: "verify checkout resolution",
      done_conditions: ["resolved source tests pass"],
      expected_scope: ["src/control"],
    });
  });

  for (const kind of ["formal", "temporary"] as const) {
    it.each([
      ["mixed resolved and explicit coordinates", {
        resolve_from_checkout: true,
        project_id: "prj-forged",
        repo_id: "repo-forged",
      }],
      ["a false resolver discriminant", {
        resolve_from_checkout: false,
        project_id: "prj-wlan",
        repo_id: "repo-wlan",
      }],
      ["no coordinates", {}],
      ["a missing Repository coordinate", { project_id: "prj-wlan" }],
      ["a missing Project coordinate", { repo_id: "repo-wlan" }],
    ])(`rejects %s at the ${kind} runtime coordinate boundary`, async (_label, coordinates) => {
      const { service, catalog, pinnedRepositoryLookup, projects, runner } = fixture();

      const operation = kind === "formal"
        ? service.registerFormalTask({
          ...coordinates,
          repository_path: checkout,
          issue_url: "https://github.com/jhw7500/wlan/issues/7",
        } as never)
        : service.registerTemporaryTask({
          ...coordinates,
          repository_path: checkout,
          alias: "wlan:tmp-20260826-13-invalid-coordinates",
          goal: "verify exact runtime coordinates",
          done_conditions: ["ambiguous coordinates rejected"],
          expected_scope: ["src/control"],
        } as never);

      await expect(operation).rejects.toMatchObject({ code: "INVALID_TASK_SCOPE" });
      expect(catalog.getRepository).not.toHaveBeenCalled();
      expect(pinnedRepositoryLookup).not.toHaveBeenCalled();
      expect(projects.requireProjectRepository).not.toHaveBeenCalled();
      expect(projects.resolveUniqueProjectForRepository).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
      expect(runner.runGh).not.toHaveBeenCalled();
      expect(catalog.registerFormalTask).not.toHaveBeenCalled();
      expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
    });
  }

  it.each(["formal", "temporary"] as const)(
    "does not mutate %s Task registration when unique Project resolution fails",
    async (kind) => {
      const { service, catalog, projects } = fixture();
      projects.resolveUniqueProjectForRepository.mockRejectedValueOnce(
        new ControlError("PROJECT_REPOSITORY_AMBIGUOUS", "injected ambiguous association"),
      );

      const operation = kind === "formal"
        ? service.registerFormalTask({
          resolve_from_checkout: true,
          repository_path: checkout,
          issue_url: "https://github.com/jhw7500/wlan/issues/7",
        })
        : service.registerTemporaryTask({
          resolve_from_checkout: true,
          repository_path: checkout,
          alias: "wlan:tmp-20260826-02-project-error",
          goal: "verify no mutation",
          done_conditions: ["resolver fails closed"],
          expected_scope: ["src/control"],
        });

      await expect(operation).rejects.toMatchObject({ code: "PROJECT_REPOSITORY_AMBIGUOUS" });
      expect(catalog.registerFormalTask).not.toHaveBeenCalled();
      expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
    },
  );

  it.each(["formal", "temporary"] as const)(
    "does not mutate %s Task registration when the pinned final fence fails",
    async (kind) => {
      const { service, catalog } = fixture({ finalFenceError: "REGISTRY_MOVED_DURING_READ" });

      const operation = kind === "formal"
        ? service.registerFormalTask({
          resolve_from_checkout: true,
          repository_path: checkout,
          issue_url: "https://github.com/jhw7500/wlan/issues/7",
        })
        : service.registerTemporaryTask({
          resolve_from_checkout: true,
          repository_path: checkout,
          alias: "wlan:tmp-20260826-03-fence-error",
          goal: "verify final fence",
          done_conditions: ["final fence fails closed"],
          expected_scope: ["src/control"],
        });

      await expect(operation).rejects.toMatchObject({ code: "REGISTRY_MOVED_DURING_READ" });
      expect(catalog.registerFormalTask).not.toHaveBeenCalled();
      expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-root checkout before resolved Catalog lookup or mutation", async () => {
    const { service, catalog, pinnedRepositoryLookup, projects } = fixture({ checkoutRoot: "/fixture/private-source" });

    await expect(service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-04-root",
      goal: "verify exact root",
      done_conditions: ["nested path rejected"],
      expected_scope: ["src/control"],
    })).rejects.toMatchObject({ code: "CHECKOUT_ROOT_MISMATCH" });

    expect(pinnedRepositoryLookup).not.toHaveBeenCalled();
    expect(projects.resolveUniqueProjectForRepository).not.toHaveBeenCalled();
    expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
  });

  it.each([
    ["multiple fetch URLs", { remote: "git@github.com:jhw7500/wlan.git\nhttps://github.com/jhw7500/wlan.git\n" }],
    ["multiple push URLs", { pushRemote: "git@github.com:jhw7500/wlan.git\nhttps://github.com/jhw7500/wlan.git\n" }],
  ])("rejects %s before resolved Catalog lookup", async (_label, overrides) => {
    const { service, catalog, pinnedRepositoryLookup } = fixture(overrides);

    await expect(service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-05-cardinality",
      goal: "verify origin cardinality",
      done_conditions: ["ambiguous origin rejected"],
      expected_scope: ["src/control"],
    })).rejects.toMatchObject({ code: "AMBIGUOUS_CHECKOUT_ORIGIN" });

    expect(pinnedRepositoryLookup).not.toHaveBeenCalled();
    expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
  });

  it("accepts HTTPS fetch with an equivalent SSH push URL", async () => {
    const { service, catalog } = fixture({
      remote: "https://github.com/jhw7500/wlan.git\n",
      pushRemote: "git@github.com:jhw7500/wlan.git\n",
    });

    await service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-06-mixed-remotes",
      goal: "verify mixed transport identity",
      done_conditions: ["temporary Task registered"],
      expected_scope: ["src/control"],
    });

    expect(catalog.registerTemporaryTask).toHaveBeenCalled();
  });

  it("accepts case-only slug differences across checkout, GitHub, and Registry", async () => {
    const { service, catalog } = fixture({
      remote: "https://github.com/JHW7500/WLAN.git\n",
      pushRemote: "git@github.com:jhw7500/wlan.git\n",
      fullName: "Jhw7500/Wlan",
    });

    await service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-07-case",
      goal: "verify case-insensitive identity",
      done_conditions: ["temporary Task registered"],
      expected_scope: ["src/control"],
    });

    expect(catalog.registerTemporaryTask).toHaveBeenCalled();
  });

  it("accepts a canonical .github Repository name", async () => {
    const dotGithub: RepositoryRecord = {
      id: "repo-dot-github",
      github_node_id: "R_dot_github",
      slug: "jhw7500/.github",
    };
    const { service, catalog } = fixture({
      repository: dotGithub,
      remote: "https://github.com/jhw7500/.github.git\n",
      pushRemote: "git@github.com:jhw7500/.github.git\n",
      fullName: "jhw7500/.github",
      nodeId: "R_dot_github",
    });

    await service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "dot-github:tmp-20260826-01",
      goal: "verify dotted Repository names",
      done_conditions: ["temporary Task registered"],
      expected_scope: ["src/control"],
    });

    expect(catalog.registerTemporaryTask).toHaveBeenCalledWith(expect.objectContaining({ repo_id: "repo-dot-github" }));
  });

  it.each([
    ["live node mismatch", { nodeId: "R_other" }, "REPOSITORY_IDENTITY_MISMATCH"],
    ["live rename mismatch", { fullName: "jhw7500/renamed" }, "REPOSITORY_IDENTITY_MISMATCH"],
  ])("rejects %s before resolved Task mutation", async (_label, overrides, code) => {
    const { service, catalog, projects } = fixture(overrides);

    await expect(service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-08-identity",
      goal: "verify live identity",
      done_conditions: ["identity mismatch rejected"],
      expected_scope: ["src/control"],
    })).rejects.toMatchObject({ code });

    expect(projects.resolveUniqueProjectForRepository).not.toHaveBeenCalled();
    expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
  });

  it("accepts private resolved repositories by default", async () => {
    const { service, catalog } = fixture({ private: true });

    await service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-09-private",
      goal: "verify private policy",
      done_conditions: ["temporary Task registered"],
      expected_scope: ["src/control"],
    });

    expect(catalog.registerTemporaryTask).toHaveBeenCalled();
  });

  it("rejects public resolved repositories without persisted opt-in", async () => {
    const { service, catalog, projects } = fixture({ private: false });

    await expect(service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-10-public-denied",
      goal: "verify public policy",
      done_conditions: ["missing opt-in rejected"],
      expected_scope: ["src/control"],
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_PRIVATE" });

    expect(projects.resolveUniqueProjectForRepository).not.toHaveBeenCalled();
    expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
  });

  it("accepts public resolved repositories only with persisted opt-in", async () => {
    const { service, catalog } = fixture({
      private: false,
      repository: { ...repository, allow_public: true },
    });

    await service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-11-public-optin",
      goal: "verify public opt-in",
      done_conditions: ["temporary Task registered"],
      expected_scope: ["src/control"],
    });

    expect(catalog.registerTemporaryTask).toHaveBeenCalled();
  });

  it("rejects protected live Repository responses before pinned lookup or mutation", async () => {
    const secret = "unmistakably-fake-resolved-source-token";
    const { catalog, pinnedRepositoryLookup, projects, runner } = fixture();
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

    const error = await service.registerTemporaryTask({
      resolve_from_checkout: true,
      repository_path: checkout,
      alias: "wlan:tmp-20260826-12-protected",
      goal: "verify protected response rejection",
      done_conditions: ["protected response rejected"],
      expected_scope: ["src/control"],
    }).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(pinnedRepositoryLookup).not.toHaveBeenCalled();
    expect(catalog.registerTemporaryTask).not.toHaveBeenCalled();
  });

  it("rejects an unsafe Issue number before any checkout or GitHub request", async () => {
    const { service, catalog, projects, runner } = fixture();

    await expect(service.registerFormalTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      repository_path: checkout,
      issue_url: `https://github.com/jhw7500/wlan/issues/${"9".repeat(400)}`,
    })).rejects.toMatchObject({ code: "INVALID_ISSUE_URL" });

    expect(catalog.getRepository).not.toHaveBeenCalled();
    expect(catalog.registerFormalTask).not.toHaveBeenCalled();
    expect(projects.requireProjectRepository).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(runner.runGh).not.toHaveBeenCalled();
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

  it("selects the exact verified formal alias instead of a preserved temporary lookalike", async () => {
    const { service, catalog } = fixture();
    catalog.registerFormalTask.mockResolvedValueOnce({
      task: { ...formal, aliases: ["evil/repository#7", "wlan:temporary", "jhw7500/wlan#7"] },
      created: false,
    });

    await expect(service.prepareExistingTask({ task_id: formal.id, repository_path: checkout }))
      .resolves.toMatchObject({ alias: "jhw7500/wlan#7" });
  });

  it("refuses a closed formal Issue before existing Task ownership is created", async () => {
    const { service, catalog } = fixture({ issueState: "closed" });

    await expect(service.prepareExistingTask({ task_id: formal.id, repository_path: checkout })).rejects.toMatchObject({
      code: "TASK_COMPLETED",
    });

    expect(catalog.registerFormalTask).not.toHaveBeenCalled();
  });
});
