import { readFile } from "node:fs/promises";
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
    const a = await catalog.registerFormalTask(issueInput);
    const b = await catalog.registerFormalTask(issueInput);

    expect(b.task.id).toBe(a.task.id);
    expect(b.created).toBe(false);
  });

  it("keeps formal Task records limited to source identity and aliases", async () => {
    const { catalog, fixture } = await catalogFixture();
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
  });
});
