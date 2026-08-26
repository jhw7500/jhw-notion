import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ControlError } from "../errors.js";
import { MAX_HANDOFF_BYTES } from "../handoff.js";
import { RegistryRecordStore } from "../codec.js";
import { ProcessRunner } from "../process.js";
import { RegistryGit, type ProcessRunnerLike, type RegistryMutationResult } from "../registry-git.js";
import { createSensitiveDataPolicy } from "../sensitive-data.js";
import { commitFile, configFor, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

const fixtures: RegistryFixture[] = [];
const RecordShape = z.object({ n: z.string() });

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

function fixtureRegistryGit(
  config: ReturnType<typeof configFor>,
  runner: ProcessRunnerLike,
  sensitiveData?: ReturnType<typeof createSensitiveDataPolicy>,
): RegistryGit {
  return new RegistryGit(config, runner, sensitiveData, async () => undefined);
}

function runnerThatRejectsPush(stderr: string): ProcessRunnerLike {
  let revisionCalls = 0;
  let statusCalls = 0;
  return {
    async run(_command, args) {
      if (args[0] === "push") throw new ControlError("COMMAND_FAILED", "Command failed", { stderr });
      const stdout = args[0] === "rev-parse" ? (++revisionCalls <= 2 ? "base\n" : "local\n") : "";
      return { command: "git", args, stdout, stderr: "", exitCode: 0 };
    },
    async runRaw(_command, args) {
      if (args[0] === "ls-files") return Buffer.from("H README.md\0", "utf8");
      if (args[0] === "status") {
        statusCalls += 1;
        return Buffer.from(statusCalls === 1 ? "" : statusCalls === 2 ? "?? record.yaml\0" : "A  record.yaml\0", "utf8");
      }
      if (args[0] === "diff") return Buffer.from("record.yaml\0", "utf8");
      throw new Error(`unexpected raw Git command: ${args.join(" ")}`);
    },
  };
}

describe("RegistryGit", () => {
  it("rejects a foreign effective push URL before Registry mutation", async () => {
    const { registryDir } = await fixture();
    const mutate = vi.fn(async () => mutation([]));
    const run = vi.fn(async (_command: string, args: string[]) => ({
      command: "git",
      args,
      stdout: args[0] === "rev-parse"
        ? `${registryDir}\n`
        : args.includes("--push")
          ? "git@github.com:jhw7500/other.git\n"
          : "git@github.com:jhw7500/project-registry.git\n",
      stderr: "",
      exitCode: 0,
    }));
    const registry = new RegistryGit(configFor(registryDir), { run });

    await expect(registry.transact("must-not-mutate", mutate)).rejects.toMatchObject({
      code: "REGISTRY_REMOTE_MISMATCH",
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects a Registry subdirectory before mutation", async () => {
    const { registryDir } = await fixture();
    const nestedRegistryDir = join(registryDir, "nested");
    await mkdir(nestedRegistryDir);
    const mutate = vi.fn(async () => mutation([]));
    const registry = new RegistryGit(configFor(nestedRegistryDir), new ProcessRunner());

    await expect(registry.transact("must-not-mutate", mutate)).rejects.toMatchObject({
      code: "REGISTRY_ROOT_MISMATCH",
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects a dirty checkout before fetching or mutating", async () => {
    const { registryDir } = await fixture();
    await writeFile(join(registryDir, "governance.json"), "{}\n", "utf8");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("test", async () => mutation([]))).rejects.toMatchObject({
      code: "REGISTRY_DIRTY",
    });
  });

  it("rejects remote divergence without rebase or force", async () => {
    const { registryDir, otherCloneDir } = await fixture();
    await commitFile(otherCloneDir, "governance/other.json", "{}\n");
    await git(otherCloneDir, "push", "origin", "main");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("test", async () => mutation([]))).rejects.toMatchObject({
      code: "REMOTE_DIVERGED",
    });
    expect(await git(registryDir, "status", "--porcelain")).toBe("");
  });

  it("creates one commit, pushes fast-forward, refetches, and verifies remote HEAD", async () => {
    const { registryDir } = await fixture();
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

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
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());
    const head = (await git(registryDir, "rev-parse", "HEAD")).trim();

    await expect(registry.transact("idempotent", async () => mutation([]))).resolves.toEqual({
      commit: head,
      changed: false,
    });
    expect((await git(registryDir, "rev-parse", "HEAD")).trim()).toBe(head);
  });

  it.each([
    ["tracked assume-unchanged", ["--assume-unchanged"]],
    ["tracked skip-worktree", ["--skip-worktree"]],
  ])("rejects %s index state before mutation", async (_label, indexArgs) => {
    const { registryDir } = await fixture();
    await commitFile(registryDir, "governance/indexed.json", "{}\n");
    await git(registryDir, "push", "origin", "main");
    await git(registryDir, "update-index", ...indexArgs, "--", "governance/indexed.json");
    const mutate = vi.fn(async () => mutation([]));
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("must-not-mutate", mutate)).rejects.toMatchObject({
      code: "REGISTRY_INDEX_UNSAFE",
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    ["a tracked .gitignore", ".gitignore"],
    ["the local info exclude", ".git/info/exclude"],
  ])("force-stages a declared canonical path hidden by %s", async (_label, ignoreFile) => {
    const { registryDir } = await fixture();
    const ignoredPath = "governance/ignored.json";
    if (ignoreFile === ".gitignore") {
      await commitFile(registryDir, ignoreFile, `${ignoredPath}\n`);
      await git(registryDir, "push", "origin", "main");
    } else {
      await writeFile(join(registryDir, ignoreFile), `${ignoredPath}\n`, "utf8");
    }
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    const result = await registry.transact("commit declared ignored record", async () => {
      await mkdir(join(registryDir, "governance"), { recursive: true });
      await writeFile(join(registryDir, ignoredPath), "{\"committed\":true}\n", "utf8");
      return mutation([ignoredPath]);
    });

    expect(result.changed).toBe(true);
    expect(await git(registryDir, "show", `HEAD:${ignoredPath}`)).toBe("{\"committed\":true}\n");
    expect(await git(registryDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("rejects an ignored unreported mutation before commit or push", async () => {
    const { registryDir } = await fixture();
    await commitFile(registryDir, ".gitignore", "governance/hidden.json\n");
    await git(registryDir, "push", "origin", "main");
    const initialHead = (await git(registryDir, "rev-parse", "HEAD")).trim();
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("partial mutation", async () => {
      await mkdir(join(registryDir, "governance"), { recursive: true });
      await writeFile(join(registryDir, "governance/reported.json"), "{}\n", "utf8");
      await writeFile(join(registryDir, "governance/hidden.json"), "{}\n", "utf8");
      return mutation(["governance/reported.json"]);
    })).rejects.toMatchObject({ code: "MUTATION_PATH_MISMATCH" });

    expect((await git(registryDir, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect((await git(registryDir, "rev-parse", "origin/main")).trim()).toBe(initialHead);
  });

  it("preserves a non-divergence push failure", async () => {
    const { registryDir } = await fixture();
    const registry = fixtureRegistryGit(
      configFor(registryDir),
      runnerThatRejectsPush("remote: permission denied to update this repository"),
    );

    await expect(registry.transact("transport failure", async () => mutation(["record.yaml"]))).rejects.toMatchObject({
      code: "COMMAND_FAILED",
    });
  });

  it("preserves a protected-branch push rejection that is not non-fast-forward", async () => {
    const { registryDir } = await fixture();
    const registry = fixtureRegistryGit(
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
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

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
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("missing paths", async () => {
      await mkdir(join(registryDir, "governance"), { recursive: true });
      await writeFile(join(registryDir, "governance/unreported.json"), "{}\n", "utf8");
      return mutation([]);
    })).rejects.toMatchObject({ code: "MUTATION_PATH_MISMATCH" });
  });

  it("rejects a mutation that changes paths it did not explicitly return for staging", async () => {
    const { registryDir } = await fixture();
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

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
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.assertHeadRegularFile("handoffs/regular.md")).resolves.toBeUndefined();
  });

  it("exposes the exact regular HEAD blob object ID for immutable Task revisions", async () => {
    const { registryDir } = await fixture();
    await commitFile(registryDir, "tasks/revision.yaml", "{}\n");
    await git(registryDir, "push", "origin", "main");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());
    const expected = (await git(registryDir, "rev-parse", "HEAD:tasks/revision.yaml")).trim();

    await expect(registry.headRegularBlobObjectId("tasks/revision.yaml")).resolves.toBe(expected);
  });

  it.each([
    "tasks/../governance/authority.yaml",
    "tasks//record.yaml",
    "tasks\\record.yaml",
    "./tasks/record.yaml",
  ])("rejects noncanonical Registry authority path %s before Git", async (path) => {
    const { registryDir } = await fixture();
    const run = vi.fn();
    const registry = fixtureRegistryGit(configFor(registryDir), { run });

    await expect(registry.headRegularBlobObjectId(path)).rejects.toMatchObject({ code: "INVALID_REGISTRY_PATH" });
    expect(run).not.toHaveBeenCalled();
  });

  it("lists only direct regular HEAD tree entries with exact kinds", async () => {
    const { registryDir } = await fixture();
    await commitFile(registryDir, "claims/history/2026/task.yaml", "{}\n");
    await commitFile(registryDir, "claims/active.yaml", "{}\n");
    await git(registryDir, "push", "origin", "main");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.listHeadDirectoryEntries("claims", 10)).resolves.toEqual([
      { name: "active.yaml", kind: "file" },
      { name: "history", kind: "directory" },
    ]);
    await expect(registry.listHeadDirectoryEntries("missing", 10)).resolves.toEqual([]);
  });

  it("uses bounded raw capture and rejects an unterminated HEAD tree enumeration", async () => {
    const { registryDir } = await fixture();
    const treeId = "a".repeat(40);
    const run = vi.fn();
    const runRaw = vi.fn()
      .mockResolvedValueOnce(Buffer.from(`040000 tree ${treeId}\tclaims\0`, "utf8"))
      .mockResolvedValueOnce(Buffer.from(`100644 blob ${"b".repeat(40)}\tactive.yaml`, "utf8"));
    const registry = fixtureRegistryGit(configFor(registryDir), { run, runRaw });

    await expect(registry.listHeadDirectoryEntries("claims", 10)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(run).not.toHaveBeenCalled();
    expect(runRaw).toHaveBeenCalledTimes(2);
  });

  it("reads exact committed Handoff bytes from HEAD rather than the mutable checkout", async () => {
    const { registryDir } = await fixture();
    await commitFile(registryDir, "handoffs/regular.md", "# Durable handoff\nfirst\n");
    await git(registryDir, "push", "origin", "main");
    await writeFile(join(registryDir, "handoffs", "regular.md"), "mutable checkout\n", "utf8");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.readHeadRegularFile("handoffs/regular.md")).resolves.toBe("# Durable handoff\nfirst\n");
  });

  it("rejects a committed secret-valued substring before restoring blob text", async () => {
    const { registryDir } = await fixture();
    const secret = "registry-secret-value";
    await commitFile(registryDir, "handoffs/secret.md", `# Handoff\n${secret}\n`);
    await git(registryDir, "push", "origin", "main");
    const registry = fixtureRegistryGit(
      configFor(registryDir),
      new ProcessRunner({ HIDDEN_TOKEN: secret }),
      createSensitiveDataPolicy({ HIDDEN_TOKEN: secret }),
    );

    const error = await registry.readHeadRegularFile("handoffs/secret.md").catch((cause) => cause);
    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("rejects invalid UTF-8 committed blob bytes without exposing them", async () => {
    const { registryDir } = await fixture();
    const path = join(registryDir, "handoffs", "invalid.md");
    await mkdir(join(registryDir, "handoffs"), { recursive: true });
    await writeFile(path, Buffer.from([0xc3, 0x28]));
    await git(registryDir, "add", "--", "handoffs/invalid.md");
    await git(registryDir, "commit", "-m", "Invalid blob");
    await git(registryDir, "push", "origin", "main");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    const error = await registry.readHeadRegularFile("handoffs/invalid.md").catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(JSON.stringify(error)).not.toContain("c3");
  });

  it("rejects a committed Handoff blob larger than 12 KiB", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "handoffs"), { recursive: true });
    await writeFile(join(registryDir, "handoffs", "large.md"), Buffer.alloc(MAX_HANDOFF_BYTES + 1, "x"));
    await git(registryDir, "add", "--", "handoffs/large.md");
    await git(registryDir, "commit", "-m", "Large blob");
    await git(registryDir, "push", "origin", "main");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.readHeadRegularFile("handoffs/large.md")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("answers reads inside a held subtree from one listing", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    for (const name of ["one", "two", "three"]) {
      await writeFile(join(registryDir, "tasks", `${name}.json`), `{"n":"${name}"}\n`, "utf8");
    }
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "Tasks");
    const calls: string[][] = [];
    const runner = new ProcessRunner();
    const registry = fixtureRegistryGit(configFor(registryDir), {
      run: async (command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]) => {
        calls.push(args);
        return runner.run(command, args, options);
      },
      runRaw: runner.runRaw.bind(runner),
    } as unknown as ProcessRunnerLike);

    const seen = await registry.withCommittedTree(["tasks"], async () => [
      await registry.headRegularBlobObjectId("tasks/one.json"),
      await registry.headRegularBlobObjectId("tasks/two.json"),
      await registry.headRegularBlobObjectId("tasks/three.json"),
    ]);

    expect(new Set(seen).size).toBe(3);
    // One recursive listing answered all three, and no path was asked for
    // individually.
    expect(calls.filter((args) => args[0] === "ls-tree" && args[1] === "-r")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "ls-tree" && args[1] === "-l")).toHaveLength(0);
  });

  it("agrees with a single lookup about the same record", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "Tasks");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    const alone = await registry.headRegularBlobObjectId("tasks/one.json");
    const held = await registry.withCommittedTree(["tasks"], () => registry.headRegularBlobObjectId("tasks/one.json"));

    expect(held).toBe(alone);
  });

  it("still asks individually for a path the held listing does not cover", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await writeFile(join(registryDir, "outside.json"), `{"n":"outside"}\n`, "utf8");
    await mkdir(join(registryDir, "tasks-other"), { recursive: true });
    await writeFile(join(registryDir, "tasks-other", "x.json"), `{"n":"x"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks", "outside.json", "tasks-other");
    await git(registryDir, "commit", "-m", "Both");
    const calls: string[][] = [];
    const runner = new ProcessRunner();
    const registry = fixtureRegistryGit(configFor(registryDir), {
      run: async (command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]) => {
        calls.push(args);
        return runner.run(command, args, options);
      },
      runRaw: runner.runRaw.bind(runner),
    } as unknown as ProcessRunnerLike);

    // A listing that does not cover a path cannot say it is absent, so the
    // scope must not answer for one.
    await registry.withCommittedTree(["tasks"], async () => {
      await registry.headRegularBlobObjectId("outside.json");
      // A sibling whose name merely starts with the scoped directory is not in
      // it, so the boundary has to test the separator and not just the prefix.
      await registry.headRegularBlobObjectId("tasks-other/x.json");
    });

    expect(calls.filter((args) => args[0] === "ls-tree" && args[1] === "-l")).toHaveLength(2);
  });

  // Read-only commands reach these audits without the mutation lock, so a
  // commit can land while a scope is open. Pinning the commit is what keeps a
  // record the directory still lists from reading as absent.
  it("reads one commit for the life of the scope", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "First");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());
    const pinned = await registry.headRegularBlobObjectId("tasks/one.json");

    const seen = await registry.withCommittedTree(["tasks"], async () => {
      await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"changed"}\n`, "utf8");
      await writeFile(join(registryDir, "tasks", "two.json"), `{"n":"two"}\n`, "utf8");
      await git(registryDir, "add", "--", "tasks");
      await git(registryDir, "commit", "-m", "Moved underneath");
      return {
        entry: await registry.headRegularBlobObjectId("tasks/one.json"),
        listed: await registry.listHeadDirectoryEntries("tasks", 100),
      };
    });

    expect(seen.entry).toBe(pinned);
    // The listing has to name the same commit the entries came from. Reading it
    // at HEAD would show two.json, which the held entries cannot resolve — the
    // audit would then call a record the directory lists a missing one.
    expect(seen.listed.map((entry) => entry.name)).toEqual(["one.json"]);
    expect(await registry.headRegularBlobObjectId("tasks/one.json")).not.toBe(pinned);
    expect(await registry.headRegularBlobObjectId("tasks/two.json")).toMatch(/^[0-9a-f]{40,64}$/);
  });

  // Pinning freezes the committed side but not the checkout, so once HEAD
  // moves the two stop agreeing. That is this read being stale, and calling it
  // corruption would send an operator after a Registry that is fine.
  it("reports a moved HEAD as a stale read rather than a damaged Registry", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "First");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());
    const records = new RegistryRecordStore(registryDir, registry, createSensitiveDataPolicy({}));

    const outcome = await registry.withCommittedTree(["tasks"], async () => {
      await writeFile(join(registryDir, "tasks", "two.json"), `{"n":"two"}\n`, "utf8");
      await git(registryDir, "add", "--", "tasks");
      await git(registryDir, "commit", "-m", "Landed underneath");
      return records.listDirectoryEntries("tasks", 100).catch((cause: unknown) => cause);
    });

    expect(outcome).toMatchObject({ code: "REGISTRY_MOVED_DURING_READ" });
  });

  it("propagates a later HEAD-resolution failure instead of reporting a fresh committed view", async () => {
    const { registryDir } = await fixture();
    const runner = new ProcessRunner();
    let headCalls = 0;
    const registry = fixtureRegistryGit(configFor(registryDir), {
      run: async (command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD" && ++headCalls > 1) {
          throw new ControlError("COMMAND_FAILED", "injected later HEAD failure");
        }
        return runner.run(command, args, options);
      },
      runRaw: runner.runRaw.bind(runner),
    });

    await expect(registry.withCommittedTree(["tasks"], () => registry.committedViewIsStale()))
      .rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(headCalls).toBe(2);
  });

  // The record comparison has the same skew as the directory one and needs its
  // own guard: removing only this branch left the whole suite green.
  it("reports a moved HEAD as stale when a record disagrees, not just a directory", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "First");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());
    const records = new RegistryRecordStore(registryDir, registry, createSensitiveDataPolicy({}));

    const outcome = await registry.withCommittedTree(["tasks"], async () => {
      await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"changed"}\n`, "utf8");
      await git(registryDir, "add", "--", "tasks");
      await git(registryDir, "commit", "-m", "Landed underneath");
      return records.readOptionalJson("tasks/one.json", RecordShape).catch((cause: unknown) => cause);
    });

    expect(outcome).toMatchObject({ code: "REGISTRY_MOVED_DURING_READ" });
  });

  // A scope is published before the commit it will read is resolved, so a read
  // arriving in that window must be refused rather than handed an empty
  // revision — and the scope has to work normally once it resolves.
  it("refuses a read that arrives before the scope has resolved its commit", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "Tasks");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    const scoped = registry.withCommittedTree(["tasks"], () => registry.headRegularBlobObjectId("tasks/one.json"));
    const during = await registry.headRegularBlobObjectId("tasks/one.json").catch((cause: unknown) => cause);
    const inside = await scoped;

    // Both assertions carry weight: the first catches a revision that is empty,
    // the second a scope that quietly falls back to HEAD and answers anyway.
    expect(during).toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(inside).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("forgets a subtree listing that failed so the scope can read it again", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "Tasks");
    let failNext = true;
    const runner = new ProcessRunner();
    const registry = fixtureRegistryGit(configFor(registryDir), {
      run: async (command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]) => {
        if (failNext && args[0] === "ls-tree" && args[1] === "-r") {
          failNext = false;
          throw new ControlError("COMMAND_FAILED", "injected listing failure");
        }
        return runner.run(command, args, options);
      },
      runRaw: runner.runRaw.bind(runner),
    } as unknown as ProcessRunnerLike);

    const outcome = await registry.withCommittedTree(["tasks"], async () => {
      const first = await registry.headRegularBlobObjectId("tasks/one.json").catch((cause: unknown) => cause);
      // One transient failure must not decide every later read of the
      // directory for the rest of the scope.
      return { first, second: await registry.headRegularBlobObjectId("tasks/one.json") };
    });

    expect(outcome.first).toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(outcome.second).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("holds one scope for concurrent callers and releases it once", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "Tasks");
    const calls: string[][] = [];
    const runner = new ProcessRunner();
    const registry = fixtureRegistryGit(configFor(registryDir), {
      run: async (command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]) => {
        calls.push(args);
        return runner.run(command, args, options);
      },
      runRaw: runner.runRaw.bind(runner),
    } as unknown as ProcessRunnerLike);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = registry.withCommittedTree(["tasks"], async () => {
      await gate;
      return registry.headRegularBlobObjectId("tasks/one.json");
    });
    const second = registry.withCommittedTree(["tasks"], () => registry.headRegularBlobObjectId("tasks/one.json"));
    await second;
    release();
    await first;

    // One listing served both, and the first caller's scope survived the
    // second one leaving it.
    expect(calls.filter((args) => args[0] === "ls-tree" && args[1] === "-r")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "ls-tree" && args[1] === "-l")).toHaveLength(0);
  });

  it("reports a record missing from the held subtree as missing", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "Tasks");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.withCommittedTree(["tasks"], () => registry.headRegularBlobObjectId("tasks/absent.json")))
      .rejects.toMatchObject({ code: "HANDOFF_MISSING" });
  });

  // The gate that a batched listing could most easily lose: git records a
  // symlink as a blob, and only the mode tells them apart.
  it("refuses a subtree that holds a committed symlink", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await symlink("/etc/passwd", join(registryDir, "tasks", "link.json"));
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "Tasks with a symlink");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.withCommittedTree(["tasks"], () => registry.headRegularBlobObjectId("tasks/one.json")))
      .rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("releases the held subtree when the work inside it throws", async () => {
    const { registryDir } = await fixture();
    await mkdir(join(registryDir, "tasks"), { recursive: true });
    await writeFile(join(registryDir, "tasks", "one.json"), `{"n":"one"}\n`, "utf8");
    await git(registryDir, "add", "--", "tasks");
    await git(registryDir, "commit", "-m", "Tasks");
    const calls: string[][] = [];
    const runner = new ProcessRunner();
    const registry = fixtureRegistryGit(configFor(registryDir), {
      run: async (command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]) => {
        calls.push(args);
        return runner.run(command, args, options);
      },
      runRaw: runner.runRaw.bind(runner),
    } as unknown as ProcessRunnerLike);

    await expect(registry.withCommittedTree(["tasks"], async () => {
      throw new Error("work failed");
    })).rejects.toThrow("work failed");
    await registry.headRegularBlobObjectId("tasks/one.json");

    // Back to asking per path, rather than answering from a listing that
    // outlived the call that took it.
    expect(calls.filter((args) => args[0] === "ls-tree" && args[1] === "-l")).toHaveLength(1);
  });

  it("preflights an oversized proven blob without invoking the raw content command", async () => {
    const { registryDir } = await fixture();
    const objectId = "a".repeat(40);
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "ls-tree") {
        return {
          command: "git",
          args,
          stdout: `100644 blob ${objectId} ${MAX_HANDOFF_BYTES + 1}\thandoffs/large.md\0`,
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const runRaw = vi.fn();
    const registry = fixtureRegistryGit(configFor(registryDir), { run, runRaw });

    await expect(registry.readHeadRegularFile("handoffs/large.md")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    // The size arrives with the rest of the entry, so nothing else is asked.
    expect(run).toHaveBeenCalledExactlyOnceWith("git", ["ls-tree", "-l", "-z", "HEAD", "--", "handoffs/large.md"], { cwd: registryDir });
    expect(runRaw).not.toHaveBeenCalled();
  });

  it("rejects an invalid preflight size without invoking content for the proven OID", async () => {
    const { registryDir } = await fixture();
    const objectId = "b".repeat(40);
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "ls-tree") {
        return {
          command: "git",
          args,
          stdout: `100644 blob ${objectId}     BAD\thandoffs/invalid-size.md\0`,
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const runRaw = vi.fn();
    const registry = fixtureRegistryGit(configFor(registryDir), { run, runRaw });

    // Asserted on the blob reader rather than the text reader: the latter maps
    // anything that escapes into the same code, so it would keep passing with
    // the size format guard deleted and BigInt throwing instead.
    await expect(registry.readHeadRegularBlob("handoffs/invalid-size.md"))
      .rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "git",
      ["ls-tree", "-l", "-z", "HEAD", "--", "handoffs/invalid-size.md"],
      { cwd: registryDir },
    );
    expect(runRaw).not.toHaveBeenCalled();
  });

  it("reads content only with the exact OID that passed size preflight", async () => {
    const { registryDir } = await fixture();
    const objectId = "c".repeat(40);
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "ls-tree") {
        // git right-aligns the size in a seven-wide field.
        return { command: "git", args, stdout: `100644 blob ${objectId}       8\thandoffs/exact.md\0`, stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const runRaw = vi.fn(async () => Buffer.from("# Exact\n", "utf8"));
    const registry = fixtureRegistryGit(configFor(registryDir), { run, runRaw });

    await expect(registry.readHeadRegularFile("handoffs/exact.md")).resolves.toBe("# Exact\n");
    expect(runRaw).toHaveBeenCalledWith(
      "git",
      ["cat-file", "blob", objectId],
      { cwd: registryDir },
      MAX_HANDOFF_BYTES,
    );
  });

  it("round-trips exact Unicode blob bytes", async () => {
    const { registryDir } = await fixture();
    const content = "# Handoff\n😀 한글\n";
    await commitFile(registryDir, "handoffs/unicode.md", content);
    await git(registryDir, "push", "origin", "main");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    const restored = await registry.readHeadRegularFile("handoffs/unicode.md");
    expect(Buffer.from(restored, "utf8")).toEqual(Buffer.from(content, "utf8"));
  });

  it("rejects a regular file absent from HEAD rather than trusting the working tree", async () => {
    const { registryDir } = await fixture();
    await writeFile(join(registryDir, "handoffs-untracked.md"), "not committed\n", "utf8");
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

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
    const registry = fixtureRegistryGit(configFor(created.registryDir), new ProcessRunner());

    await expect(registry.assertHeadRegularFile("handoff-link.md")).rejects.toMatchObject({
      code: "REGISTRY_CORRUPT",
    });
  });

  it("maps HEAD inspection command failures without exposing captured command output", async () => {
    const { registryDir } = await fixture();
    const registry = fixtureRegistryGit(configFor(registryDir), {
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
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.transact("unsafe", async () => mutation(["../outside.yaml"]))).rejects.toMatchObject({
      code: "INVALID_MUTATION_PATH",
    });
  });
});
