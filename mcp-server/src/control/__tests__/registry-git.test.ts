import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlError } from "../errors.js";
import { ProcessRunner } from "../process.js";
import { RegistryGit, type ProcessRunnerLike, type RegistryMutationResult } from "../registry-git.js";
import { commitFile, configFor, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

const fixtures: RegistryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<RegistryFixture> {
  const created = await makeRegistryFixture();
  fixtures.push(created);
  return created;
}

function mutation(paths: string[]): RegistryMutationResult {
  return { paths };
}

function runnerThatRejectsPush(stderr: string): ProcessRunnerLike {
  const responses = [
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "base\n", stderr: "", exitCode: 0 },
    { stdout: "base\n", stderr: "", exitCode: 0 },
    { stdout: "?? record.yaml\n", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "local\n", stderr: "", exitCode: 0 },
  ];
  return {
    async run() {
      const response = responses.shift();
      if (response) return { command: "git", args: [], ...response };
      throw new ControlError("COMMAND_FAILED", "Command failed", { stderr });
    },
  };
}

describe("RegistryGit", () => {
  it("rejects a dirty checkout before fetching or mutating", async () => {
    const { registryDir } = await fixture();
    await writeFile(join(registryDir, "governance.json"), "{}\n", "utf8");
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("test", async () => mutation([]))).rejects.toMatchObject({
      code: "REGISTRY_DIRTY",
    });
  });

  it("rejects remote divergence without rebase or force", async () => {
    const { registryDir, otherCloneDir } = await fixture();
    await commitFile(otherCloneDir, "governance/other.json", "{}\n");
    await git(otherCloneDir, "push", "origin", "main");
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("test", async () => mutation([]))).rejects.toMatchObject({
      code: "REMOTE_DIVERGED",
    });
    expect(await git(registryDir, "status", "--porcelain")).toBe("");
  });

  it("creates one commit, pushes fast-forward, refetches, and verifies remote HEAD", async () => {
    const { registryDir } = await fixture();
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    const result = await registry.transact("registry test mutation", async () => {
      const path = "governance/record.json";
      await mkdir(join(registryDir, "governance"), { recursive: true });
      await writeFile(join(registryDir, path), "{}\n", "utf8");
      return mutation([path]);
    });

    expect(result.changed).toBe(true);
    expect(result.commit).toBe((await git(registryDir, "rev-parse", "HEAD")).trim());
    expect(await git(registryDir, "rev-parse", "HEAD")).toBe(await git(registryDir, "rev-parse", "origin/main"));
    expect(await readFile(join(registryDir, "governance/record.json"), "utf8")).toBe("{}\n");
    expect(await git(registryDir, "log", "--oneline", "-1")).toContain("registry test mutation");
  });

  it("returns the current commit without creating one when a mutation reports no paths", async () => {
    const { registryDir } = await fixture();
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());
    const head = (await git(registryDir, "rev-parse", "HEAD")).trim();

    await expect(registry.transact("idempotent", async () => mutation([]))).resolves.toEqual({
      commit: head,
      changed: false,
    });
    expect((await git(registryDir, "rev-parse", "HEAD")).trim()).toBe(head);
  });

  it("preserves a non-divergence push failure", async () => {
    const { registryDir } = await fixture();
    const registry = new RegistryGit(
      configFor(registryDir),
      runnerThatRejectsPush("remote: permission denied to update this repository"),
    );

    await expect(registry.transact("transport failure", async () => mutation(["record.yaml"]))).rejects.toMatchObject({
      code: "COMMAND_FAILED",
    });
  });

  it("preserves a protected-branch push rejection that is not non-fast-forward", async () => {
    const { registryDir } = await fixture();
    const registry = new RegistryGit(
      configFor(registryDir),
      runnerThatRejectsPush(
        "! [remote rejected] HEAD -> main (pre-receive hook declined)\nerror: failed to push some refs",
      ),
    );

    await expect(registry.transact("protected branch", async () => mutation(["record.yaml"]))).rejects.toMatchObject({
      code: "COMMAND_FAILED",
    });
  });

  it("maps a rejected non-fast-forward push to REMOTE_DIVERGED without retrying", async () => {
    const { registryDir, otherCloneDir } = await fixture();
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("racing mutation", async () => {
      const path = "governance/racing.json";
      await mkdir(join(registryDir, "governance"), { recursive: true });
      await writeFile(join(registryDir, path), "{}\n", "utf8");
      await commitFile(otherCloneDir, "governance/concurrent.json", "{}\n");
      await git(otherCloneDir, "push", "origin", "main");
      return mutation([path]);
    })).rejects.toMatchObject({ code: "REMOTE_DIVERGED" });

    expect((await git(otherCloneDir, "rev-parse", "HEAD")).trim()).toBe(
      (await git(otherCloneDir, "ls-remote", "origin", "refs/heads/main")).split("\t")[0],
    );
  });

  it("rejects a changed mutation that returns no stage paths", async () => {
    const { registryDir } = await fixture();
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("missing paths", async () => {
      await mkdir(join(registryDir, "governance"), { recursive: true });
      await writeFile(join(registryDir, "governance/unreported.json"), "{}\n", "utf8");
      return mutation([]);
    })).rejects.toMatchObject({ code: "MUTATION_PATH_MISMATCH" });
  });

  it("rejects a mutation that changes paths it did not explicitly return for staging", async () => {
    const { registryDir } = await fixture();
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("partial paths", async () => {
      await mkdir(join(registryDir, "governance"), { recursive: true });
      await writeFile(join(registryDir, "governance/staged.json"), "{}\n", "utf8");
      await writeFile(join(registryDir, "governance/unrelated.json"), "{}\n", "utf8");
      return mutation(["governance/staged.json"]);
    })).rejects.toMatchObject({ code: "MUTATION_PATH_MISMATCH" });
  });

  it("reads an exact regular file from the current HEAD tree", async () => {
    const { registryDir } = await fixture();
    await commitFile(registryDir, "handoffs/regular.md", "# Durable handoff\n");
    await git(registryDir, "push", "origin", "main");
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.assertHeadRegularFile("handoffs/regular.md")).resolves.toBeUndefined();
  });

  it("reads exact committed Handoff bytes from HEAD rather than the mutable checkout", async () => {
    const { registryDir } = await fixture();
    await commitFile(registryDir, "handoffs/regular.md", "# Durable handoff\nfirst\n");
    await git(registryDir, "push", "origin", "main");
    await writeFile(join(registryDir, "handoffs", "regular.md"), "mutable checkout\n", "utf8");
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.readHeadRegularFile("handoffs/regular.md")).resolves.toBe("# Durable handoff\nfirst\n");
  });

  it("rejects a regular file absent from HEAD rather than trusting the working tree", async () => {
    const { registryDir } = await fixture();
    await writeFile(join(registryDir, "handoffs-untracked.md"), "not committed\n", "utf8");
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.assertHeadRegularFile("handoffs-untracked.md")).rejects.toMatchObject({
      code: "HANDOFF_MISSING",
    });
  });

  it("rejects a committed symlink even when it targets a regular external file", async () => {
    const created = await fixture();
    const target = join(created.root, "external-handoff.md");
    await writeFile(target, "# External\n", "utf8");
    await symlink(target, join(created.registryDir, "handoff-link.md"));
    await git(created.registryDir, "add", "--", "handoff-link.md");
    await git(created.registryDir, "commit", "-m", "Add handoff symlink");
    await git(created.registryDir, "push", "origin", "main");
    const registry = new RegistryGit(configFor(created.registryDir), new ProcessRunner());

    await expect(registry.assertHeadRegularFile("handoff-link.md")).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
    });
  });

  it("maps HEAD inspection command failures without exposing captured command output", async () => {
    const { registryDir } = await fixture();
    const registry = new RegistryGit(configFor(registryDir), {
      async run() {
        throw new ControlError("COMMAND_FAILED", "command failed", {
          stdout: "sensitive command output",
          stderr: "sensitive command output",
        });
      },
    });

    const error = await registry.assertHeadRegularFile("handoffs/missing.md").catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(JSON.stringify(error)).not.toContain("sensitive command output");
  });

  it("rejects absolute and parent-traversal stage paths", async () => {
    const { registryDir } = await fixture();
    const registry = new RegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("unsafe", async () => mutation(["../outside.yaml"]))).rejects.toMatchObject({
      code: "INVALID_MUTATION_PATH",
    });
  });
});
