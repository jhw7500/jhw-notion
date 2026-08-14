import { link, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Catalog } from "../catalog.js";
import { sourceIndexKey } from "../ids.js";
import { ProcessRunner } from "../process.js";
import { RegistryGit } from "../registry-git.js";
import { commitFile, configFor, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

const fixtures: RegistryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function catalogFixture(): Promise<{ fixture: RegistryFixture; catalog: Catalog }> {
  const fixture = await makeRegistryFixture();
  fixtures.push(fixture);
  const config = configFor(fixture.registryDir);
  return {
    fixture,
    catalog: new Catalog(config, new RegistryGit(config, new ProcessRunner())),
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
});

describe("Catalog Registry integrity and public input boundaries", () => {
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
});
