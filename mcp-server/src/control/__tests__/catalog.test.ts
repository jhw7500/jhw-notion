import { link, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Catalog } from "../catalog.js";
import { sourceIndexKey } from "../ids.js";
import { ProcessRunner } from "../process.js";
import { RegistryGit } from "../registry-git.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "../sensitive-data.js";
import {
  commitFile,
  configFor,
  emptyTaskContractIntent,
  git,
  isolatedRegistryGit,
  makeRegistryFixture,
  type RegistryFixture,
} from "./helpers.js";

const fixtures: RegistryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function catalogFixture(
  sensitiveData?: SensitiveDataPolicy,
  adaptLegacyCallers = true,
): Promise<{ fixture: RegistryFixture; catalog: Catalog }> {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const config = configFor(fixture.registryDir);
  const rawCatalog = new Catalog(config, isolatedRegistryGit(config, new ProcessRunner()), sensitiveData);
  const catalog = adaptLegacyCallers
    ? new Proxy(rawCatalog, {
      get(target, property, receiver) {
        if (property === "registerFormalTask" || property === "registerTemporaryTask") {
          return (input: Record<string, unknown>) => Reflect.apply(target[property], target, [{ ...emptyTaskContractIntent(), ...input }]);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
    : rawCatalog;
  return {
    fixture,
    catalog,
  };
}

const repositoryInput = {
  repo_id: "repo-wlan",
  github_node_id: "R_kwDOExample",
  slug: "jhw7500/wlan",
};

const issueInput = {
  project_id: "prj-wlan",
  repo_id: "repo-wlan",
  issue_node_id: "I_kwDOExample",
  issue_revision: "2026-08-13T00:00:00Z",
  issue_url: "https://github.com/jhw7500/wlan/issues/1",
  alias: "jhw7500/wlan#1",
};

describe("Catalog", () => {
  it("rejects protected content before a Task record or commit is created", async () => {
    const secret = "unmistakably-fake-catalog-token";
    const { catalog, fixture } = await catalogFixture(createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }));
    await catalog.registerRepository(repositoryInput);
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");

    const error = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260813-01-fix",
      goal: `do not persist ${secret}`,
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/roaming.ts"],
    }).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(await readdir(join(fixture.registryDir, "tasks")).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    })).toEqual([]);
  });

  it("scans raw Catalog keys before strict-schema diagnostics", async () => {
    const secret = "unmistakably-fake-catalog-key-token";
    const { catalog, fixture } = await catalogFixture(createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }));
    await catalog.registerRepository(repositoryInput);
    const before = await git(fixture.registryDir, "rev-parse", "HEAD");
    const input = {
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:raw-key",
      goal: "safe", done_conditions: ["safe"], expected_scope: ["src/control"],
      [secret]: true,
    };

    const error = await catalog.registerTemporaryTask(input as never).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(await git(fixture.registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("enforces protected-content policy inside the shared Registry store", async () => {
    const secret = "unmistakably-fake-store-token";
    const { catalog, fixture } = await catalogFixture(createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }));

    await expect(catalog.records.writeJson("scratch/protected.yaml", { value: secret }))
      .rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    await expect(readFile(join(fixture.registryDir, "scratch", "protected.yaml"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects protected restored Repository content during reverse-index audit", async () => {
    const secret = "unmistakably-fake-repository-token";
    const { catalog, fixture } = await catalogFixture(createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }));
    const registered = await catalog.registerRepository(repositoryInput);
    await commitFile(fixture.registryDir, `repositories/${registered.repository.id}.yaml`, `${JSON.stringify({
      ...registered.repository, slug: `owner/${secret}`,
    })}\n`);
    await git(fixture.registryDir, "push", "origin", "main");
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: registered.repository.id, alias: "wlan:protected-repository",
      goal: "safe", done_conditions: ["safe"], expected_scope: ["src/control"],
    })).rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
  });

  it("rejects protected raw bytes hidden behind a duplicate JSON key", async () => {
    const secret = "unmistakably-fake-overwritten-node-token";
    const { catalog, fixture } = await catalogFixture(createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }));
    await catalog.registerRepository(repositoryInput);
    const path = `repositories/${repositoryInput.repo_id}.yaml`;
    await commitFile(fixture.registryDir, path, [
      "{",
      `  \"id\": \"${repositoryInput.repo_id}\",`,
      `  \"github_node_id\": \"${secret}\",`,
      `  \"github_node_id\": \"${repositoryInput.github_node_id}\",`,
      `  \"slug\": \"${repositoryInput.slug}\"`,
      "}",
      "",
    ].join("\n"));
    await git(fixture.registryDir, "push", "origin", "main");

    await expect(catalog.getRepository(repositoryInput.repo_id)).rejects.toMatchObject({
      code: "SENSITIVE_DATA_REJECTED",
    });
  });

  it("rejects restored noncanonical Repository slugs and formal aliases for another Issue number", async () => {
    const { catalog, fixture } = await catalogFixture();
    const repository = (await catalog.registerRepository(repositoryInput)).repository;
    const formal = (await catalog.registerFormalTask(issueInput)).task;

    await commitFile(fixture.registryDir, `repositories/${repository.id}.yaml`, `${JSON.stringify({
      ...repository, slug: "not-a-slug",
    })}\n`);
    await git(fixture.registryDir, "push", "origin", "main");
    await expect(catalog.getRepository(repository.id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

    await commitFile(fixture.registryDir, `repositories/${repository.id}.yaml`, `${JSON.stringify(repository)}\n`);
    await commitFile(fixture.registryDir, `tasks/${formal.id}.yaml`, `${JSON.stringify({
      ...formal, aliases: ["evil/repository#2", ...formal.aliases],
    })}\n`);
    await git(fixture.registryDir, "push", "origin", "main");
    await expect(catalog.getTask(formal.id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("binds formal Issue URL and alias coordinates to the referenced Repository slug", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();
    const foreignSource = {
      ...issueInput,
      issue_url: "https://github.com/other-owner/other-repository/issues/1",
      alias: "other-owner/other-repository#1",
    };

    await expect(catalog.registerFormalTask(foreignSource)).rejects.toMatchObject({
      code: "ISSUE_REPOSITORY_MISMATCH",
    });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);

    const formal = (await catalog.registerFormalTask(issueInput)).task;
    await commitFile(fixture.registryDir, `tasks/${formal.id}.yaml`, `${JSON.stringify({
      ...formal,
      issue_url: foreignSource.issue_url,
      aliases: [foreignSource.alias],
    })}\n`);
    await git(fixture.registryDir, "push", "origin", "main");
    await expect(catalog.getTask(formal.id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("registers a Repository and its GitHub source index in one transaction", async () => {
    const { catalog, fixture } = await catalogFixture();

    const result = await catalog.registerRepository(repositoryInput);
    const sourcePath = join(
      fixture.registryDir,
      "repositories/by-source/github",
      `${sourceIndexKey(repositoryInput.github_node_id)}.yaml`,
    );

    expect(result).toEqual({
      repository: { id: "repo-wlan", github_node_id: "R_kwDOExample", slug: "jhw7500/wlan" },
      created: true,
    });
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual({ repo_id: "repo-wlan" });
  });

  it("maps one Repository node ID to one repo_id without restricting Project references", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);

    await expect(catalog.registerRepository({ ...repositoryInput, repo_id: "repo-other" })).rejects.toMatchObject({
      code: "SOURCE_ALREADY_MAPPED",
    });
    await expect(catalog.registerRepository(repositoryInput)).resolves.toMatchObject({
      created: false,
      repository: { id: "repo-wlan" },
    });
  });

  it("updates only a verified same-node Repository slug rename", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);

    await expect(catalog.registerRepository({ ...repositoryInput, slug: "jhw7500/wlan-renamed" })).resolves.toEqual({
      created: false,
      repository: {
        id: repositoryInput.repo_id,
        github_node_id: repositoryInput.github_node_id,
        slug: "jhw7500/wlan-renamed",
      },
    });
    await expect(catalog.getRepository(repositoryInput.repo_id)).resolves.toMatchObject({ slug: "jhw7500/wlan-renamed" });
  });

  it("atomically migrates dependent formal Task locators on a verified same-node Repository rename", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const temporaryAlias = "wlan:pre-rename-work";
    const temporary = await catalog.registerTemporaryTask({
      project_id: issueInput.project_id,
      repo_id: issueInput.repo_id,
      alias: temporaryAlias,
      goal: "preserve the existing alias across a verified rename",
      done_conditions: ["rename remains resumable"],
      expected_scope: ["src/control"],
    });
    const formal = { task: await catalog.promoteTemporaryTask(temporary.id, issueInput) };
    const renamedSlug = "jhw7500/wlan-renamed";
    const renamedIssue = {
      ...issueInput,
      issue_url: `https://github.com/${renamedSlug}/issues/1`,
      alias: `${renamedSlug}#1`,
    };

    await expect(catalog.registerRepository({
      ...repositoryInput,
      slug: renamedSlug,
    })).resolves.toMatchObject({ repository: { slug: renamedSlug }, created: false });

    await expect(catalog.getTask(formal.task.id)).resolves.toMatchObject({
      id: formal.task.id,
      repo_id: repositoryInput.repo_id,
      issue_node_id: issueInput.issue_node_id,
      issue_url: renamedIssue.issue_url,
      aliases: [renamedIssue.alias, temporaryAlias, issueInput.alias],
    });
    await expect(catalog.registerFormalTask(renamedIssue)).resolves.toMatchObject({
      task: {
        id: formal.task.id,
        issue_url: renamedIssue.issue_url,
        aliases: [renamedIssue.alias, temporaryAlias, issueInput.alias],
      },
      created: false,
    });
  });

  it("fails a same-node Repository rename before mutation when its target alias belongs to another Task", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const formal = await catalog.registerFormalTask(issueInput);
    const renamedSlug = "jhw7500/wlan-renamed";
    await catalog.registerTemporaryTask({
      project_id: issueInput.project_id,
      repo_id: issueInput.repo_id,
      alias: `${renamedSlug}#1`,
      goal: "reserve the target alias",
      done_conditions: ["rename fails closed"],
      expected_scope: ["src/control"],
    });
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.registerRepository({ ...repositoryInput, slug: renamedSlug }))
      .rejects.toMatchObject({ code: "TASK_ALIAS_CONFLICT" });

    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
    await expect(catalog.getRepository(repositoryInput.repo_id)).resolves.toMatchObject({ slug: repositoryInput.slug });
    await expect(catalog.getTask(formal.task.id)).resolves.toMatchObject({ aliases: [issueInput.alias] });
  });

  it("requires a canonical Repository record before creating any Task", async () => {
    const { catalog } = await catalogFixture();

    await expect(catalog.registerFormalTask(issueInput)).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    await expect(catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260813-01-fix",
      goal: "fix roaming regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/roaming.ts"],
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
  });

  it("rejects immutable formal adoption drift and explicitly advances only its verified revision", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const first = await catalog.registerFormalTask(issueInput);

    await expect(catalog.registerFormalTask({ ...issueInput, project_id: "prj-other" })).rejects.toMatchObject({
      code: "FORMAL_TASK_SOURCE_MISMATCH",
    });
    await expect(catalog.registerFormalTask({ ...issueInput, issue_url: "https://github.com/jhw7500/wlan/issues/2" })).rejects.toMatchObject({
      code: "FORMAL_TASK_SOURCE_MISMATCH",
    });
    await expect(catalog.registerFormalTask({ ...issueInput, issue_revision: "2026-08-14T00:00:00Z" })).resolves.toMatchObject({
      created: false,
      task: { id: first.task.id, issue_revision: "2026-08-14T00:00:00Z" },
    });
  });

  it("makes a bounded temporary alias idempotent and rejects conflicting reuse", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const input = {
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260813-01-fix",
      goal: "fix roaming regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/roaming.ts"],
    };
    const first = await catalog.registerTemporaryTask(input);

    await expect(catalog.registerTemporaryTask(input)).resolves.toEqual(first);
    await expect(catalog.registerTemporaryTask({ ...input, goal: "different work" })).rejects.toMatchObject({
      code: "TEMPORARY_ALIAS_CONFLICT",
    });
  });

  it("never lets a formal Issue alias identify a different temporary Task", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    await catalog.registerTemporaryTask({
      project_id: issueInput.project_id,
      repo_id: issueInput.repo_id,
      alias: issueInput.alias,
      goal: "temporary collision",
      done_conditions: ["collision rejected"],
      expected_scope: ["src/control"],
    });
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.registerFormalTask(issueInput)).rejects.toMatchObject({ code: "TASK_ALIAS_CONFLICT" });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
  });

  it("derives a new temporary Task lifecycle as active instead of accepting a caller state", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.registerTemporaryTask({
      project_id: issueInput.project_id,
      repo_id: issueInput.repo_id,
      alias: "wlan:caller-lifecycle",
      goal: "must begin active",
      done_conditions: ["caller state rejected"],
      expected_scope: ["src/control"],
      lifecycle: "completed",
    } as any)).rejects.toMatchObject({ code: "INVALID_TEMPORARY_TASK" });

    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
  });

  it("exposes a narrowly validated canonical Repository lookup", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);

    await expect(catalog.getRepository("repo-wlan")).resolves.toEqual({
      id: "repo-wlan",
      github_node_id: "R_kwDOExample",
      slug: "jhw7500/wlan",
    });
    await expect(catalog.getRepository("repo-missing")).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    await expect(catalog.getRepository("../escape")).rejects.toMatchObject({ code: "INVALID_REPOSITORY_ID" });
  });

  it("rejects a malformed repo_id before resolving a Registry path", async () => {
    const { catalog, fixture } = await catalogFixture();
    await commitFile(
      fixture.registryDir,
      "escaped.yaml",
      `${JSON.stringify({ id: "repo-wlan", github_node_id: repositoryInput.github_node_id, slug: repositoryInput.slug })}\n`,
    );
    await git(fixture.registryDir, "push", "origin", "main");

    await expect(catalog.registerRepository({ ...repositoryInput, repo_id: "../escaped" })).rejects.toMatchObject({
      code: "INVALID_REPOSITORY",
    });
    expect(await git(fixture.registryDir, "ls-tree", "-r", "--name-only", "HEAD", "repositories/by-source/github")).toBe("");
  });

  it("adopts the existing Task ID for an already indexed Issue", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const a = await catalog.registerFormalTask(issueInput);
    const b = await catalog.registerFormalTask(issueInput);

    expect(b.task.id).toBe(a.task.id);
    expect(b.created).toBe(false);
  });

  it("keeps formal Task records limited to source identity and aliases", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const { task } = await catalog.registerFormalTask(issueInput);

    const record = JSON.parse(await readFile(join(fixture.registryDir, "tasks", `${task.id}.yaml`), "utf8"));
    expect(record).toEqual({
      id: task.id,
      kind: "formal",
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      aliases: ["jhw7500/wlan#1"],
      issue_node_id: "I_kwDOExample",
      issue_revision: "2026-08-13T00:00:00Z",
      issue_url: "https://github.com/jhw7500/wlan/issues/1",
      task_role: "standalone",
      work_contract: { version: 1, task_id: task.id, grants: [], dependencies: [] },
    });
  });

  it("creates a temporary Task with mutable-work lifecycle fields", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const task = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260813-01-fix",
      goal: "fix roaming regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/roaming.ts"],
    });

    expect(task).toMatchObject({
      kind: "temporary",
      aliases: ["wlan:tmp-20260813-01-fix"],
      goal: "fix roaming regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/roaming.ts"],
      lifecycle: "active",
    });
  });

  it("round-trips records above the Handoff cap and rejects over-bound records before mutation", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const task = await catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:large-record",
      goal: "x".repeat(13 * 1024), done_conditions: ["bounded"], expected_scope: ["src/control"],
    });
    await expect(catalog.getTask(task.id)).resolves.toEqual(task);
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:oversized-record",
      goal: "x".repeat(70 * 1024), done_conditions: ["bounded"], expected_scope: ["src/control"],
    })).rejects.toMatchObject({ code: "INVALID_TEMPORARY_TASK" });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
    expect((await git(fixture.registryDir, "rev-parse", "origin/main")).trim()).toBe(before);
    expect(await git(fixture.registryDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("refuses promotion when the Issue maps to another Task", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const temp = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260813-01-fix",
      goal: "fix roaming regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/roaming.ts"],
    });
    await catalog.registerFormalTask(issueInput);

    await expect(catalog.promoteTemporaryTask(temp.id, issueInput)).rejects.toMatchObject({
      code: "SOURCE_ALREADY_MAPPED",
    });
    await expect(catalog.getTask(temp.id)).resolves.toEqual(temp);
  });

  it("promotes a temporary Task and source index together, preserving its prior alias", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const temp = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260813-01-fix",
      goal: "fix roaming regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/roaming.ts"],
    });

    const promoted = await catalog.promoteTemporaryTask(temp.id, issueInput);
    const sourcePath = join(
      fixture.registryDir,
      "tasks/by-source/github",
      `${sourceIndexKey(issueInput.issue_node_id)}.yaml`,
    );

    expect(promoted).toEqual({
      id: temp.id,
      kind: "formal",
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      aliases: ["wlan:tmp-20260813-01-fix", "jhw7500/wlan#1"],
      issue_node_id: "I_kwDOExample",
      issue_revision: "2026-08-13T00:00:00Z",
      issue_url: "https://github.com/jhw7500/wlan/issues/1",
      task_role: "standalone",
      work_contract: { version: 1, task_id: temp.id, grants: [], dependencies: [] },
    });
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual({ task_id: temp.id });
    await expect(catalog.promoteTemporaryTask(temp.id, issueInput)).resolves.toEqual(promoted);

    await expect(catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260813-01-fix",
      goal: "different canonical work",
      done_conditions: ["new test"],
      expected_scope: ["src/new.ts"],
    })).rejects.toMatchObject({ code: "TEMPORARY_ALIAS_CONFLICT" });
  });

  it("refuses promotion when the verified formal alias belongs to another Task", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    await catalog.registerTemporaryTask({
      project_id: issueInput.project_id,
      repo_id: issueInput.repo_id,
      alias: issueInput.alias,
      goal: "alias owner",
      done_conditions: ["stay distinct"],
      expected_scope: ["src/owner"],
    });
    const target = await catalog.registerTemporaryTask({
      project_id: issueInput.project_id,
      repo_id: issueInput.repo_id,
      alias: "wlan:promotion-target",
      goal: "promotion target",
      done_conditions: ["promotion checked"],
      expected_scope: ["src/target"],
    });
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.promoteTemporaryTask(target.id, issueInput)).rejects.toMatchObject({
      code: "TASK_ALIAS_CONFLICT",
    });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
  });

  it("applies formal immutable-coordinate and monotonic-revision rules on promotion retry", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    await catalog.registerRepository({ repo_id: "repo-other", github_node_id: "R_other", slug: "jhw7500/other" });
    const temp = await catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:tmp-20260813-01-fix",
      goal: "fix roaming regression", done_conditions: ["targeted test passes"], expected_scope: ["src/roaming.ts"],
    });
    await catalog.promoteTemporaryTask(temp.id, issueInput);

    for (const drift of [
      { project_id: "prj-other" },
      { repo_id: "repo-other" },
      { issue_url: "https://github.com/jhw7500/wlan/issues/2" },
    ]) {
      await expect(catalog.promoteTemporaryTask(temp.id, { ...issueInput, ...drift })).rejects.toMatchObject({
        code: "FORMAL_TASK_SOURCE_MISMATCH",
      });
    }
    await expect(catalog.promoteTemporaryTask(temp.id, {
      ...issueInput, issue_revision: "2026-08-12T00:00:00Z",
    })).rejects.toMatchObject({ code: "STALE_SOURCE_REVISION" });

    await expect(catalog.promoteTemporaryTask(temp.id, {
      ...issueInput,
      issue_revision: "2026-08-14T00:00:00Z",
    })).resolves.toMatchObject({
      id: temp.id,
      issue_revision: "2026-08-14T00:00:00Z",
      aliases: ["wlan:tmp-20260813-01-fix", "jhw7500/wlan#1"],
    });
  });
});

describe("Catalog Registry integrity and public input boundaries", () => {
  it("rejects valid-looking dirty working bytes instead of trusting them over HEAD", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const path = join(fixture.registryDir, "repositories", `${repositoryInput.repo_id}.yaml`);
    await writeFile(path, `${JSON.stringify({
      id: repositoryInput.repo_id,
      github_node_id: repositoryInput.github_node_id,
      slug: "jhw7500/forged",
    })}\n`, "utf8");

    await expect(catalog.getRepository(repositoryInput.repo_id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await git(fixture.registryDir, "show", `HEAD:repositories/${repositoryInput.repo_id}.yaml`)).toContain(repositoryInput.slug);
  });

  it("rejects a FIFO record leaf without blocking in descriptor open", async () => {
    const { catalog, fixture } = await catalogFixture();
    await mkdir(join(fixture.registryDir, "tasks"), { recursive: true });
    await new ProcessRunner().run("mkfifo", [join(fixture.registryDir, "tasks", "fifo.yaml")]);

    await expect(catalog.records.assertAbsent("tasks/fifo.yaml")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("refuses a committed repositories ancestor symlink before touching its outside target", async () => {
    const { catalog, fixture } = await catalogFixture();
    const outside = join(fixture.root, "outside-repositories");
    const sentinel = join(outside, "sentinel.txt");
    await mkdir(outside);
    await writeFile(sentinel, "outside-sentinel\n", "utf8");
    await symlink(outside, join(fixture.registryDir, "repositories"));
    await git(fixture.registryDir, "add", "--", "repositories");
    await git(fixture.registryDir, "commit", "-m", "Add hostile repositories symlink");
    await git(fixture.registryDir, "push", "origin", "main");
    const beforeHead = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();
    const beforeRemote = (await git(fixture.registryDir, "rev-parse", "origin/main")).trim();

    await expect(catalog.registerRepository(repositoryInput)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

    expect(await readFile(sentinel, "utf8")).toBe("outside-sentinel\n");
    expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(beforeHead);
    expect((await git(fixture.registryDir, "rev-parse", "origin/main")).trim()).toBe(beforeRemote);
    expect(await git(fixture.registryDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("refuses a committed Repository leaf symlink even when its outside bytes parse", async () => {
    const { catalog, fixture } = await catalogFixture();
    const outside = join(fixture.root, "outside-repository.yaml");
    await writeFile(outside, `${JSON.stringify({
      id: repositoryInput.repo_id,
      github_node_id: repositoryInput.github_node_id,
      slug: repositoryInput.slug,
    }, null, 2)}\n`, "utf8");
    await mkdir(join(fixture.registryDir, "repositories"));
    await symlink(outside, join(fixture.registryDir, "repositories", `${repositoryInput.repo_id}.yaml`));
    await git(fixture.registryDir, "add", "--", "repositories");
    await git(fixture.registryDir, "commit", "-m", "Add hostile Repository leaf symlink");
    await git(fixture.registryDir, "push", "origin", "main");
    const before = await readFile(outside, "utf8");

    await expect(catalog.registerRepository(repositoryInput)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

    expect(await readFile(outside, "utf8")).toBe(before);
    expect(await git(fixture.registryDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("refuses a multi-link Repository record before trusting canonical identity", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const record = join(fixture.registryDir, "repositories", `${repositoryInput.repo_id}.yaml`);
    const outside = join(fixture.root, "repository-hardlink.yaml");
    await unlink(outside).catch(() => undefined);
    await link(record, outside);
    const beforeHead = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.getRepository(repositoryInput.repo_id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });

    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(beforeHead);
    expect(await git(fixture.registryDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("fails closed when a Repository source index points to a record for another GitHub node", async () => {
    const { catalog, fixture } = await catalogFixture();
    const sourcePath = `repositories/by-source/github/${sourceIndexKey(repositoryInput.github_node_id)}.yaml`;
    await commitFile(
      fixture.registryDir,
      "repositories/repo-wlan.yaml",
      `${JSON.stringify({ id: "repo-wlan", github_node_id: "R_kwDOOther", slug: repositoryInput.slug })}\n`,
    );
    await commitFile(fixture.registryDir, sourcePath, `${JSON.stringify({ repo_id: "repo-wlan" })}\n`);
    await git(fixture.registryDir, "push", "origin", "main");

    await expect(catalog.registerRepository(repositoryInput)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
      details: expect.objectContaining({ sourceIndexPath: sourcePath }),
    });
  });

  it("fails closed when a Repository source index points to a missing record", async () => {
    const { catalog, fixture } = await catalogFixture();
    const sourcePath = `repositories/by-source/github/${sourceIndexKey(repositoryInput.github_node_id)}.yaml`;
    await commitFile(fixture.registryDir, sourcePath, `${JSON.stringify({ repo_id: "repo-missing" })}\n`);
    await git(fixture.registryDir, "push", "origin", "main");

    await expect(catalog.registerRepository(repositoryInput)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
      details: expect.objectContaining({ expectedRecordId: "repo-missing" }),
    });
  });

  it("fails closed when a Repository source index record path and embedded ID differ", async () => {
    const { catalog, fixture } = await catalogFixture();
    const sourcePath = `repositories/by-source/github/${sourceIndexKey(repositoryInput.github_node_id)}.yaml`;
    await commitFile(
      fixture.registryDir,
      "repositories/repo-wlan.yaml",
      `${JSON.stringify({ id: "repo-other", github_node_id: repositoryInput.github_node_id, slug: repositoryInput.slug })}\n`,
    );
    await commitFile(fixture.registryDir, sourcePath, `${JSON.stringify({ repo_id: "repo-wlan" })}\n`);
    await git(fixture.registryDir, "push", "origin", "main");

    await expect(catalog.registerRepository(repositoryInput)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
      details: expect.objectContaining({ expectedRecordId: "repo-wlan" }),
    });
  });

  it("fails closed when a formal Task source index points to another Issue node", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const taskId = "tsk-0181f8f0-0000-7000-8000-000000000001";
    await commitFile(
      fixture.registryDir,
      `tasks/${taskId}.yaml`,
      `${JSON.stringify({
        id: taskId,
        kind: "formal",
        project_id: issueInput.project_id,
        repo_id: issueInput.repo_id,
        aliases: [issueInput.alias],
        issue_node_id: "I_kwDOOther",
        issue_revision: issueInput.issue_revision,
        issue_url: issueInput.issue_url,
      })}\n`,
    );
    await commitFile(
      fixture.registryDir,
      `tasks/by-source/github/${sourceIndexKey(issueInput.issue_node_id)}.yaml`,
      `${JSON.stringify({ task_id: taskId })}\n`,
    );
    await git(fixture.registryDir, "push", "origin", "main");

    await expect(catalog.registerFormalTask(issueInput)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
      details: expect.objectContaining({ sourceIndexPath: expect.stringContaining("tasks/by-source/github/") }),
    });
  });

  it("validates repository, formal, and temporary public inputs before existing-index paths", async () => {
    const { catalog } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    await catalog.registerFormalTask(issueInput);

    await expect(catalog.registerRepository({ ...repositoryInput, slug: "" })).rejects.toMatchObject({
      code: "INVALID_REPOSITORY",
    });
    await expect(catalog.registerRepository({ ...repositoryInput, github_node_id: "" })).rejects.toMatchObject({
      code: "INVALID_REPOSITORY",
    });
    await expect(catalog.registerFormalTask({ ...issueInput, issue_revision: "" })).rejects.toMatchObject({
      code: "INVALID_FORMAL_TASK",
    });
    await expect(catalog.registerFormalTask({ ...issueInput, issue_url: "not-a-url" })).rejects.toMatchObject({
      code: "INVALID_FORMAL_TASK",
    });
    await expect(catalog.registerFormalTask({ ...issueInput, alias: "" })).rejects.toMatchObject({
      code: "INVALID_FORMAL_TASK",
    });
    await expect(catalog.registerFormalTask({ ...issueInput, repo_id: "bad" })).rejects.toMatchObject({
      code: "INVALID_FORMAL_TASK",
    });
    await expect(catalog.registerFormalTask({ ...issueInput, issue_node_id: "" })).rejects.toMatchObject({
      code: "INVALID_FORMAL_TASK",
    });
    await expect(catalog.registerTemporaryTask({
      project_id: "bad",
      repo_id: "repo-wlan",
      alias: "",
      goal: "",
      done_conditions: [],
      expected_scope: [],
    })).rejects.toMatchObject({ code: "INVALID_TEMPORARY_TASK" });
  });

  it("rejects an overlong source node ID before any primary record or index mutation", async () => {
    const { catalog, fixture } = await catalogFixture();
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.registerRepository({
      ...repositoryInput,
      github_node_id: `R_${"x".repeat(200)}`,
    })).rejects.toMatchObject({ code: "INVALID_REPOSITORY" });

    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
    expect((await git(fixture.registryDir, "rev-parse", "origin/main")).trim()).toBe(before);
    expect(await git(fixture.registryDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("rejects canonical Repository and formal Task records whose reverse source index is missing", async () => {
    const repositoryCase = await catalogFixture();
    await repositoryCase.catalog.registerRepository(repositoryInput);
    const repositoryIndex = `repositories/by-source/github/${sourceIndexKey(repositoryInput.github_node_id)}.yaml`;
    await git(repositoryCase.fixture.registryDir, "rm", "--", repositoryIndex);
    await git(repositoryCase.fixture.registryDir, "commit", "-m", "Remove Repository source index");
    await git(repositoryCase.fixture.registryDir, "push", "origin", "main");
    const repositoryHead = (await git(repositoryCase.fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(repositoryCase.catalog.registerRepository({
      ...repositoryInput,
      repo_id: "repo-other",
    })).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect((await git(repositoryCase.fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(repositoryHead);

    const taskCase = await catalogFixture();
    await taskCase.catalog.registerRepository(repositoryInput);
    await taskCase.catalog.registerFormalTask(issueInput);
    const taskIndex = `tasks/by-source/github/${sourceIndexKey(issueInput.issue_node_id)}.yaml`;
    await git(taskCase.fixture.registryDir, "rm", "--", taskIndex);
    await git(taskCase.fixture.registryDir, "commit", "-m", "Remove Task source index");
    await git(taskCase.fixture.registryDir, "push", "origin", "main");
    const taskHead = (await git(taskCase.fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(taskCase.catalog.registerFormalTask(issueInput)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect((await git(taskCase.fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(taskHead);
  });

  it("fails closed when promotion reads a Task record whose path and embedded ID differ", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const temp = await catalog.registerTemporaryTask({
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      alias: "wlan:tmp-20260813-01-fix",
      goal: "fix roaming regression",
      done_conditions: ["targeted test passes"],
      expected_scope: ["src/roaming.ts"],
    });
    const otherTaskId = "tsk-0181f8f0-0000-7000-8000-000000000002";
    await commitFile(
      fixture.registryDir,
      `tasks/${temp.id}.yaml`,
      `${JSON.stringify({ ...temp, id: otherTaskId })}\n`,
    );
    await git(fixture.registryDir, "push", "origin", "main");

    await expect(catalog.promoteTemporaryTask(temp.id, issueInput)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
      details: expect.objectContaining({ expectedRecordId: temp.id }),
    });
  });

  it("fails closed when restored Task records duplicate a canonical alias", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const first = await catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:first",
      goal: "first", done_conditions: ["first"], expected_scope: ["src/first"],
    });
    const second = await catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:second",
      goal: "second", done_conditions: ["second"], expected_scope: ["src/second"],
    });
    await commitFile(
      fixture.registryDir,
      `tasks/${second.id}.yaml`,
      `${JSON.stringify({ ...second, aliases: [first.aliases[0]] })}\n`,
    );
    await git(fixture.registryDir, "push", "origin", "main");

    await expect(catalog.getTask(first.id)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("rejects promotion of a completed temporary Task", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository(repositoryInput);
    const temp = await catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:promotion-eligibility",
      goal: "eligible only without authority conflict", done_conditions: ["checked"], expected_scope: ["src/control"],
    });
    await commitFile(
      fixture.registryDir,
      `tasks/${temp.id}.yaml`,
      `${JSON.stringify({ ...temp, lifecycle: "completed" })}\n`,
    );
    await git(fixture.registryDir, "push", "origin", "main");
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.promoteTemporaryTask(temp.id, issueInput)).rejects.toMatchObject({ code: "TASK_COMPLETED" });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
  });

  it("lists Repository records sorted by ID for portfolio derivation", async () => {
    const { catalog } = await catalogFixture();
    await expect(catalog.listRepositories()).resolves.toEqual([]);

    await catalog.registerRepository({ ...repositoryInput, allow_public: true });
    await catalog.registerRepository({ repo_id: "repo-alpha", github_node_id: "R_alpha", slug: "jhw7500/alpha" });

    const listed = await catalog.listRepositories();
    expect(listed.map((repository) => repository.id)).toEqual(["repo-alpha", "repo-wlan"]);
    expect(listed[1]).toMatchObject({ slug: "jhw7500/wlan", allow_public: true });
    expect(listed[0]?.allow_public).toBeUndefined();
  });

  it("persists the public opt-in on the record and drops it on re-register without the flag", async () => {
    const { catalog } = await catalogFixture();

    await catalog.registerRepository({ ...repositoryInput, allow_public: true });
    await expect(catalog.getRepository("repo-wlan")).resolves.toMatchObject({ allow_public: true });

    const second = await catalog.registerRepository(repositoryInput);
    expect(second.created).toBe(false);
    const cleared = await catalog.getRepository("repo-wlan");
    expect(cleared.allow_public).toBeUndefined();
  });

  it("commits the Registry when re-registration only toggles the public opt-in", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository({ ...repositoryInput, allow_public: true });
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    const cleared = await catalog.registerRepository(repositoryInput);
    expect(cleared.created).toBe(false);
    const after = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();
    expect(after).not.toBe(before);

    const idempotent = await catalog.registerRepository(repositoryInput);
    expect(idempotent.created).toBe(false);
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(after);
  });

  it("applies a rename and a public opt-in change as one Registry commit", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository({ ...repositoryInput, allow_public: true });
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    const combined = await catalog.registerRepository({ ...repositoryInput, slug: "jhw7500/wlan-renamed" });
    expect(combined.created).toBe(false);
    expect(combined.repository.slug).toBe("jhw7500/wlan-renamed");
    expect(combined.repository.allow_public).toBeUndefined();

    const record = await catalog.getRepository("repo-wlan");
    expect(record.slug).toBe("jhw7500/wlan-renamed");
    expect(record.allow_public).toBeUndefined();
    const after = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();
    expect(after).not.toBe(before);
    expect((await git(fixture.registryDir, "rev-parse", "HEAD~1")).trim()).toBe(before);
  });

  it("fails closed instead of toggling the opt-in when the record has no source index", async () => {
    const { catalog, fixture } = await catalogFixture();
    await catalog.registerRepository({ ...repositoryInput, allow_public: true });
    const sourcePath = `repositories/by-source/github/${sourceIndexKey(repositoryInput.github_node_id)}.yaml`;
    await git(fixture.registryDir, "rm", "--quiet", "--", sourcePath);
    await git(fixture.registryDir, "commit", "-m", `Remove ${sourcePath}`);
    await git(fixture.registryDir, "push", "origin", "main");
    const before = (await git(fixture.registryDir, "rev-parse", "HEAD")).trim();

    await expect(catalog.registerRepository(repositoryInput)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
      details: expect.objectContaining({ repo_id: "repo-wlan" }),
    });
    expect((await git(fixture.registryDir, "rev-parse", "HEAD")).trim()).toBe(before);
  });
});

describe("Catalog Task contracts and one-level child topology", () => {
  const repositoryGrant = {
    capability: "repo.modify" as const,
    resource: { kind: "repository" as const, id: "repo-wlan" },
    coordination: "exclusive" as const,
  };
  const notionGrant = {
    capability: "notion.mutate" as const,
    resource: { kind: "notion_database" as const, id: "projects" as const },
    coordination: "shared" as const,
  };
  const contractIntent = { grants: [repositoryGrant], dependencies: [] };

  async function registerParent(catalog: Catalog) {
    await catalog.registerRepository(repositoryInput);
    return (await catalog.registerFormalTask({
      ...issueInput,
      ...contractIntent,
      task_role: "parent",
    })).task;
  }

  it("requires explicit contract intent and stores new formal and temporary Tasks as standalone", async () => {
    const { catalog } = await catalogFixture(undefined, false);
    await catalog.registerRepository(repositoryInput);

    await expect(catalog.registerFormalTask(issueInput)).rejects.toMatchObject({ code: "TASK_CONTRACT_REQUIRED" });
    await expect(catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:no-contract",
      goal: "missing contract", done_conditions: ["rejected"], expected_scope: ["src/control"],
    })).rejects.toMatchObject({ code: "TASK_CONTRACT_REQUIRED" });

    const formal = (await catalog.registerFormalTask({ ...issueInput, ...contractIntent })).task;
    const temporary = await catalog.registerTemporaryTask({
      project_id: "prj-wlan", repo_id: "repo-wlan", alias: "wlan:contracted",
      goal: "bounded work", done_conditions: ["done"], expected_scope: ["src/control"],
      ...contractIntent,
    });

    expect(formal).toMatchObject({ task_role: "standalone", work_contract: { version: 1, task_id: formal.id, ...contractIntent } });
    expect(temporary).toMatchObject({ task_role: "standalone", work_contract: { version: 1, task_id: temporary.id, ...contractIntent } });
  });

  it("creates a child from a formal parent without a source index or inherited grants", async () => {
    const { catalog, fixture } = await catalogFixture(undefined, false);
    const parent = await registerParent(catalog);
    const child = await catalog.registerChildTask({
      parent_task_id: parent.id,
      alias: "wlan:child-contract-tests",
      required_for_parent: true,
      goal: "implement contract tests",
      done_conditions: ["tests pass"],
      grants: [notionGrant],
      dependencies: [{ task_id: parent.id, relation: "observes" }],
    });

    expect(child).toEqual({
      id: child.id,
      kind: "child",
      parent_task_id: parent.id,
      required_for_parent: true,
      project_id: parent.project_id,
      repo_id: parent.repo_id,
      aliases: ["wlan:child-contract-tests"],
      goal: "implement contract tests",
      done_conditions: ["tests pass"],
      lifecycle: "active",
      work_contract: {
        version: 1,
        task_id: child.id,
        grants: [notionGrant],
        dependencies: [{ task_id: parent.id, relation: "observes" }],
      },
    });
    expect(child.work_contract.grants).not.toContainEqual(repositoryGrant);
    expect((await catalog.listChildren(parent.id)).map((task) => task.id)).toEqual([child.id]);
    expect(await git(fixture.registryDir, "ls-tree", "-r", "--name-only", "HEAD", "tasks/by-source/github"))
      .not.toContain(child.id);
    await expect(catalog.getTask(child.id)).resolves.toEqual(child);
    await expect(catalog.configureInactiveTask({
      task_id: child.id,
      task_role: "standalone",
      work_contract: child.work_contract,
    })).rejects.toMatchObject({ code: "TASK_CHILD_ROLE_IMMUTABLE" });
  });

  it("rejects children of children and unknown or self dependencies", async () => {
    const { catalog } = await catalogFixture(undefined, false);
    const parent = await registerParent(catalog);
    const child = await catalog.registerChildTask({
      parent_task_id: parent.id, alias: "wlan:first-child", required_for_parent: true,
      goal: "first child", done_conditions: ["done"], grants: [], dependencies: [],
    });

    await expect(catalog.registerChildTask({
      parent_task_id: child.id, alias: "wlan:grandchild", required_for_parent: true,
      goal: "too deep", done_conditions: ["rejected"], grants: [], dependencies: [],
    })).rejects.toMatchObject({ code: "TASK_CHILD_DEPTH_EXCEEDED" });
    await expect(catalog.registerChildTask({
      parent_task_id: parent.id, alias: "wlan:unknown-dependency", required_for_parent: true,
      goal: "unknown dependency", done_conditions: ["rejected"], grants: [],
      dependencies: [{ task_id: "tsk-0181f8f0-0000-7000-8000-000000000002", relation: "blocked_by" }],
    })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("configures a legacy inactive Task while preserving source fields and refuses active Claims", async () => {
    const { catalog, fixture } = await catalogFixture(undefined, false);
    const parent = await registerParent(catalog);
    const legacy = { ...parent } as Record<string, unknown>;
    delete legacy.task_role;
    delete legacy.work_contract;
    await commitFile(fixture.registryDir, `tasks/${parent.id}.yaml`, `${JSON.stringify(legacy)}\n`);
    await git(fixture.registryDir, "push", "origin", "main");
    const sourcePath = `tasks/by-source/github/${sourceIndexKey(issueInput.issue_node_id)}.yaml`;
    const sourceIndexBefore = await readFile(join(fixture.registryDir, sourcePath), "utf8");

    await expect(catalog.getTask(parent.id)).resolves.toEqual(legacy);
    const configured = await catalog.configureInactiveTask({
      task_id: parent.id,
      task_role: "parent",
      work_contract: { version: 1, task_id: parent.id, ...contractIntent },
    });
    expect(configured).toEqual({ ...legacy, task_role: "parent", work_contract: { version: 1, task_id: parent.id, ...contractIntent } });
    expect(await readFile(join(fixture.registryDir, sourcePath), "utf8")).toBe(sourceIndexBefore);

    const legacyTemporaryId = "tsk-0181f8f0-0000-7000-8000-000000000005";
    const legacyTemporary = {
      id: legacyTemporaryId,
      kind: "temporary",
      project_id: "prj-wlan",
      repo_id: "repo-wlan",
      aliases: ["wlan:legacy-temporary"],
      goal: "preserve legacy temporary work",
      done_conditions: ["configured"],
      expected_scope: ["src/legacy"],
      lifecycle: "handoff",
    };
    await commitFile(fixture.registryDir, `tasks/${legacyTemporaryId}.yaml`, `${JSON.stringify(legacyTemporary)}\n`);
    await git(fixture.registryDir, "push", "origin", "main");
    await expect(catalog.getTask(legacyTemporaryId)).resolves.toEqual(legacyTemporary);
    await expect(catalog.configureInactiveTask({
      task_id: legacyTemporaryId,
      task_role: "standalone",
      work_contract: { version: 1, task_id: legacyTemporaryId, grants: [], dependencies: [] },
    })).resolves.toEqual({
      ...legacyTemporary,
      task_role: "standalone",
      work_contract: { version: 1, task_id: legacyTemporaryId, grants: [], dependencies: [] },
    });
    await expect(catalog.configureInactiveTask({
      task_id: legacyTemporaryId,
      task_role: "parent",
      work_contract: { version: 1, task_id: legacyTemporaryId, grants: [], dependencies: [] },
    })).rejects.toMatchObject({ code: "TASK_PARENT_FORMAL_REQUIRED" });

    await commitFile(fixture.registryDir, `claims/active/${parent.id}.yaml`, "{}\n");
    await git(fixture.registryDir, "push", "origin", "main");
    await expect(catalog.configureInactiveTask({
      task_id: parent.id,
      task_role: "standalone",
      work_contract: { version: 1, task_id: parent.id, grants: [], dependencies: [] },
    })).rejects.toMatchObject({ code: "TASK_CONTRACT_ACTIVE" });
  });
});
