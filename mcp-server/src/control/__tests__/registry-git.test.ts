import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ControlError } from "../errors.js";
import { MAX_HANDOFF_BYTES } from "../handoff.js";
import { MAX_REGISTRY_RECORD_BYTES, RegistryRecordStore } from "../codec.js";
import { ProcessRunner, type RawProcessRunOptions } from "../process.js";
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

  it("proves remote equality without changing FETCH_HEAD, refs, index, or root mode", async () => {
    const { registryDir } = await fixture();
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());
    const fetchHead = await readFile(join(registryDir, ".git", "FETCH_HEAD")).catch(() => Buffer.alloc(0));
    const refs = await git(registryDir, "show-ref");
    const index = await stat(join(registryDir, ".git", "index"));
    const root = await stat(registryDir);

    await expect(registry.assertReadyReadOnly()).resolves.toMatch(/^[0-9a-f]{40,64}$/);

    expect(await readFile(join(registryDir, ".git", "FETCH_HEAD")).catch(() => Buffer.alloc(0))).toEqual(fetchHead);
    expect(await git(registryDir, "show-ref")).toBe(refs);
    const afterIndex = await stat(join(registryDir, ".git", "index"));
    expect({ size: afterIndex.size, mtimeMs: afterIndex.mtimeMs }).toEqual({ size: index.size, mtimeMs: index.mtimeMs });
    expect((await stat(registryDir)).mode & 0o777).toBe(root.mode & 0o777);
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

  it("rejects a committed-tree read when the final fence sees Registry HEAD move", async () => {
    const { registryDir } = await fixture();
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.withCommittedTree(["repositories"], async () => {
      await commitFile(registryDir, "repositories/repo-new.yaml", "{}\n");
      await registry.assertCommittedViewCurrent();
    })).rejects.toMatchObject({ code: "REGISTRY_MOVED_DURING_READ" });
  });

  it("maps a final fence HEAD inspection failure to Registry corruption", async () => {
    const { registryDir } = await fixture();
    const runner = new ProcessRunner();
    let headInspections = 0;
    const registry = fixtureRegistryGit(configFor(registryDir), {
      run: async (command, args, options) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD" && ++headInspections === 2) {
          throw new Error("injected final HEAD inspection failure");
        }
        return runner.run(command, args, options);
      },
      runRaw: runner.runRaw.bind(runner),
    });

    await expect(registry.withCommittedTree(["repositories"], () => registry.assertCommittedViewCurrent()))
      .rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("rejects the final fence when no committed-tree scope is active", async () => {
    const { registryDir } = await fixture();
    const registry = fixtureRegistryGit(configFor(registryDir), new ProcessRunner());

    await expect(registry.assertCommittedViewCurrent()).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
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

  it("asks Git once for a blob it has already read", async () => {
    const { registryDir } = await fixture();
    // Content no other test commits, so its object cannot already be held.
    const content = `{"n":"${randomUUID()}"}\n`;
    await commitFile(registryDir, "tasks/once.json", content);
    const runner = new ProcessRunner();
    const raw: string[][] = [];
    const counting: ProcessRunnerLike = {
      run: runner.run.bind(runner),
      runRaw: async (command, args, options, maximumBytes) => {
        raw.push(args);
        return runner.runRaw(command, args, options, maximumBytes);
      },
    };
    const registry = fixtureRegistryGit(configFor(registryDir), counting);

    const first = await registry.readHeadRegularBlob("tasks/once.json");
    first.fill(0);
    const second = await registry.readHeadRegularBlob("tasks/once.json");
    // Another instance in the same process shares what the first one read.
    const third = await fixtureRegistryGit(configFor(registryDir), counting).readHeadRegularBlob("tasks/once.json");

    expect(second.toString("utf8")).toBe(content);
    expect(third.toString("utf8")).toBe(content);
    expect(raw.filter((args) => args[0] === "cat-file")).toHaveLength(1);
  });

  it("does not remember a blob read that failed", async () => {
    const { registryDir } = await fixture();
    const objectId = "d".repeat(40);
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "ls-tree") {
        return { command: "git", args, stdout: `100644 blob ${objectId}       8\thandoffs/retry.md\0`, stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const runRaw = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(Buffer.from("# Retry\n", "utf8"));
    const registry = fixtureRegistryGit(configFor(registryDir), { run, runRaw });

    await expect(registry.readHeadRegularBlob("handoffs/retry.md")).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    await expect(registry.readHeadRegularFile("handoffs/retry.md")).resolves.toBe("# Retry\n");
    await expect(registry.readHeadRegularFile("handoffs/retry.md")).resolves.toBe("# Retry\n");
    expect(runRaw).toHaveBeenCalledTimes(2);
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

async function commitFiles(registryDir: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(registryDir, path)), { recursive: true });
    await writeFile(join(registryDir, path), bytes);
  }
  await git(registryDir, "add", "--", ...files.keys());
  await git(registryDir, "commit", "-m", "Records");
}

/**
 * Records no other test commits, so none of their objects is remembered yet.
 * Every third one carries bytes shaped like a batch header, a NUL and no final
 * newline, which a reader trusting content over the declared size would misread.
 */
function uniqueRecords(directory: string, count: number): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    files.set(`${directory}/r${index}.yaml`, index % 3 === 0
      ? Buffer.concat([
        Buffer.from(`${id}\n${"0".repeat(40)} blob 3\nabc\n`, "utf8"),
        Buffer.from([0x00, 0x0a, 0xff]),
        Buffer.from(id, "utf8"),
      ])
      : Buffer.from(`{"n":"${id}"}\n`, "utf8"));
  }
  return files;
}

type BatchAnswer = (
  runner: ProcessRunner,
  command: string,
  args: string[],
  options: RawProcessRunOptions | undefined,
  maximumBytes: number,
) => Promise<Buffer>;

/** A real runner that records every call and can answer the batch some other way. */
function recordingRunner(answerBatch?: BatchAnswer) {
  const runner = new ProcessRunner();
  const raw: { args: string[]; options?: RawProcessRunOptions; maximumBytes: number }[] = [];
  const listings: string[][] = [];
  const recording: ProcessRunnerLike = {
    run: async (command, args, options) => {
      if (args[0] === "ls-tree" && args[1] === "-r") listings.push(args);
      return runner.run(command, args, options);
    },
    runRaw: async (command, args, options, maximumBytes) => {
      raw.push({ args, options, maximumBytes });
      return answerBatch && args[0] === "cat-file" && args[1] === "--batch"
        ? answerBatch(runner, command, args, options, maximumBytes)
        : runner.runRaw(command, args, options, maximumBytes);
    },
  };
  return {
    recording,
    listings,
    batches: () => raw.filter(({ args }) => args[0] === "cat-file" && args[1] === "--batch"),
    singles: () => raw.filter(({ args }) => args[0] === "cat-file" && args[1] === "blob"),
  };
}

interface BatchEntry {
  header: string;
  body?: Buffer;
}

function splitBatch(output: Buffer): BatchEntry[] {
  const entries: BatchEntry[] = [];
  for (let cursor = 0; cursor < output.length;) {
    const newline = output.indexOf(0x0a, cursor);
    const header = output.subarray(cursor, newline).toString("utf8");
    const size = Number(header.split(" ")[2]);
    entries.push({ header, body: output.subarray(newline + 1, newline + 1 + size) });
    cursor = newline + 1 + size + 1;
  }
  return entries;
}

function joinBatch(entries: readonly BatchEntry[]): Buffer {
  return Buffer.concat(entries.flatMap(({ header, body }) => body === undefined
    ? [Buffer.from(`${header}\n`, "utf8")]
    : [Buffer.from(`${header}\n`, "utf8"), body, Buffer.from("\n", "utf8")]));
}

function rewriteHeader(entry: BatchEntry, rewrite: (objectId: string, type: string, size: number) => string): void {
  const [objectId, type, size] = entry.header.split(" ");
  entry.header = rewrite(objectId as string, type as string, Number(size));
}

/** Fake committed objects, for byte budgets too large to commit for real. */
function fakeCommittedObjects(directories: Readonly<Record<string, { count: number; size: number }>>) {
  const commit = randomBytes(20).toString("hex");
  const objects = new Map<string, Buffer>();
  const rows = new Map<string, string>();
  for (const [directory, { count, size }] of Object.entries(directories)) {
    // Fake objects may share bytes; only their names have to differ.
    const bytes = Buffer.alloc(size, directory);
    for (let index = 0; index < count; index += 1) {
      const objectId = randomBytes(20).toString("hex");
      const path = `${directory}/r${index}.yaml`;
      objects.set(objectId, bytes);
      rows.set(path, `100644 blob ${objectId} ${size}\t${path}`);
    }
  }
  const raw: string[][] = [];
  const runner: ProcessRunnerLike = {
    async run(_command, args) {
      const path = args.at(-1) as string;
      const stdout = args[0] === "rev-parse"
        ? `${commit}\n`
        : args[0] === "ls-tree" && args[1] === "-r"
          ? [...rows].filter(([listed]) => listed.startsWith(`${path}/`)).map(([, row]) => `${row}\0`).join("")
          : args[0] === "ls-tree" ? `${rows.get(path)}\0` : undefined;
      if (stdout === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
      return { command: "git", args, stdout, stderr: "", exitCode: 0 };
    },
    async runRaw(_command, args, options) {
      raw.push(args);
      if (args[0] === "cat-file" && args[1] === "--batch") {
        return Buffer.concat((options?.input?.toString("utf8") ?? "").split("\n").filter(Boolean).flatMap((objectId) => {
          const bytes = objects.get(objectId) as Buffer;
          return [Buffer.from(`${objectId} blob ${bytes.length}\n`, "utf8"), bytes, Buffer.from("\n", "utf8")];
        }));
      }
      if (args[0] === "cat-file" && args[1] === "blob") return objects.get(args[2] as string) as Buffer;
      throw new Error(`unexpected raw command: ${args.join(" ")}`);
    },
  };
  return {
    runner,
    paths: (directory: string) => [...rows.keys()].filter((path) => path.startsWith(`${directory}/`)),
    counts: () => ({
      batches: raw.filter((args) => args[1] === "--batch").length,
      singles: raw.filter((args) => args[1] === "blob").length,
    }),
    forget: () => { raw.length = 0; },
  };
}

describe("RegistryGit committed blob prefetch", () => {
  it.each(["one after another", "all at once"] as const)(
    "reads a scoped directory with one cat-file --batch when its records are read %s",
    async (order) => {
      const { registryDir } = await fixture();
      const files = uniqueRecords("tasks", 24);
      files.set("tasks/empty.yaml", Buffer.alloc(0));
      await commitFiles(registryDir, files);
      const { recording, batches, singles } = recordingRunner();
      const registry = fixtureRegistryGit(configFor(registryDir), recording);
      const paths = [...files.keys()];

      const read = await registry.withCommittedTree(["tasks"], async () => {
        if (order === "all at once") return Promise.all(paths.map((path) => registry.readHeadRegularBlob(path)));
        const bytes: Buffer[] = [];
        for (const path of paths) bytes.push(await registry.readHeadRegularBlob(path));
        return bytes;
      });

      expect(read).toEqual(paths.map((path) => files.get(path)));
      expect(batches()).toHaveLength(1);
      expect(singles()).toHaveLength(0);
    },
  );

  it.each<[string, (entries: BatchEntry[]) => Buffer]>([
    ["another object ID", (entries) => {
      rewriteHeader(entries[0] as BatchEntry, (objectId, type, size) =>
        `${objectId.startsWith("0") ? "1" : "0"}${objectId.slice(1)} ${type} ${size}`);
      return joinBatch(entries);
    }],
    ["another size", (entries) => {
      rewriteHeader(entries[0] as BatchEntry, (objectId, type, size) => `${objectId} ${type} ${size + 1}`);
      return joinBatch(entries);
    }],
    ["another type", (entries) => {
      rewriteHeader(entries[0] as BatchEntry, (objectId, _type, size) => `${objectId} tree ${size}`);
      return joinBatch(entries);
    }],
    ["a missing object", (entries) => {
      const last = entries.at(-1) as BatchEntry;
      entries[entries.length - 1] = { header: `${last.header.split(" ")[0]} missing` };
      return joinBatch(entries);
    }],
    ["answers out of order", (entries) => joinBatch([entries[1] as BatchEntry, entries[0] as BatchEntry, ...entries.slice(2)])],
    ["trailing bytes", (entries) => Buffer.concat([joinBatch(entries), Buffer.from("x", "utf8")])],
    ["a truncated answer", (entries) => joinBatch(entries).subarray(0, -1)],
    ["a lost separator", (entries) => {
      const output = joinBatch(entries);
      output[output.length - 1] = 0x20;
      return output;
    }],
    ["nothing at all", () => Buffer.alloc(0)],
  ])("reads one blob at a time, unchanged, when the batch answer has %s", async (_label, mangle) => {
    const { registryDir } = await fixture();
    const files = uniqueRecords("tasks", 6);
    await commitFiles(registryDir, files);
    const { recording, listings, batches, singles } = recordingRunner(async (runner, command, args, options, maximumBytes) =>
      mangle(splitBatch(await runner.runRaw(command, args, options, maximumBytes))));
    const registry = fixtureRegistryGit(configFor(registryDir), recording);
    const paths = [...files.keys()];

    const read = await registry.withCommittedTree(["tasks"], async () => {
      const bytes: Buffer[] = [];
      for (const path of paths) bytes.push(await registry.readHeadRegularBlob(path));
      return bytes;
    });

    expect(read).toEqual(paths.map((path) => files.get(path)));
    // Nothing from the rejected answer was remembered, so every record was
    // asked for on its own; the batch was not retried, nor the listing redone.
    expect(batches()).toHaveLength(1);
    expect(singles()).toHaveLength(paths.length);
    expect(listings).toHaveLength(1);
  });

  it.each<[string, BatchAnswer]>([
    ["cannot start", (runner, _command, args, options, maximumBytes) =>
      runner.runRaw("/nonexistent/jhw-batch-git", args, options, maximumBytes)],
    ["exits nonzero", (runner, command, args, options, maximumBytes) =>
      runner.runRaw(command, [...args, "--no-such-option"], options, maximumBytes)],
    ["times out", (runner, _command, _args, options, maximumBytes) =>
      runner.runRaw(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { ...options, timeoutMs: 25 }, maximumBytes)],
    ["outgrows its exact output bound", (runner, command, args, options, maximumBytes) =>
      runner.runRaw(command, args, options, maximumBytes - 1)],
    ["throws outside the runner contract", async () => {
      throw new Error("injected batch failure");
    }],
  ])("reads one blob at a time, without calling the Registry corrupt, when the batch %s", async (_label, answer) => {
    const { registryDir } = await fixture();
    const files = uniqueRecords("tasks", 6);
    await commitFiles(registryDir, files);
    const { recording, listings, batches, singles } = recordingRunner(answer);
    const registry = fixtureRegistryGit(configFor(registryDir), recording);
    const paths = [...files.keys()];

    const read = await registry.withCommittedTree(["tasks"], async () => {
      const bytes: Buffer[] = [];
      for (const path of paths) bytes.push(await registry.readHeadRegularBlob(path));
      return bytes;
    });

    expect(read).toEqual(paths.map((path) => files.get(path)));
    expect(batches()).toHaveLength(1);
    expect(singles()).toHaveLength(paths.length);
    expect(listings).toHaveLength(1);
  });

  it("leaves records over the Registry record limit out of the batch and still refuses them", async () => {
    const { registryDir } = await fixture();
    const files = uniqueRecords("tasks", 2);
    // Over the Handoff limit but within the record limit: batched, yet still
    // refused to a Handoff read by the size gate in front of the memo.
    files.set("tasks/medium.yaml", Buffer.alloc(MAX_HANDOFF_BYTES + 8 * 1024, randomUUID()));
    files.set("tasks/large.yaml", Buffer.alloc(MAX_REGISTRY_RECORD_BYTES + 1, randomUUID()));
    await commitFiles(registryDir, files);
    const objectIds = new Map<string, string>();
    for (const path of files.keys()) objectIds.set(path, (await git(registryDir, "rev-parse", `HEAD:${path}`)).trim());
    const { recording, batches, singles } = recordingRunner();
    const registry = fixtureRegistryGit(configFor(registryDir), recording);

    const outcome = await registry.withCommittedTree(["tasks"], async () => ({
      small: await registry.readHeadRegularBlob("tasks/r0.yaml"),
      medium: await registry.readHeadRegularBlob("tasks/medium.yaml"),
      mediumAsHandoff: await registry.readHeadRegularFile("tasks/medium.yaml").catch((cause: unknown) => cause),
      large: await registry.readHeadRegularBlob("tasks/large.yaml").catch((cause: unknown) => cause),
    }));

    expect(outcome.small).toEqual(files.get("tasks/r0.yaml"));
    expect(outcome.medium).toEqual(files.get("tasks/medium.yaml"));
    expect(outcome.mediumAsHandoff).toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(outcome.large).toMatchObject({ code: "REGISTRY_CORRUPT" });
    const batched = [...files.keys()].filter((path) => path !== "tasks/large.yaml");
    expect(batches()).toHaveLength(1);
    const [batch] = batches();
    expect(batch?.options?.input?.toString("utf8").split("\n").filter(Boolean).sort())
      .toEqual(batched.map((path) => objectIds.get(path)).sort());
    // Bounded to exactly the answer it asked for.
    expect(batch?.maximumBytes).toBe(batched.reduce((bytes, path) => {
      const size = (files.get(path) as Buffer).length;
      return bytes + Buffer.byteLength(`${objectIds.get(path)} blob ${size}\n`, "utf8") + size + 1;
    }, 0));
    expect(singles()).toHaveLength(0);
  });

  // The memo holds 32 MiB, so 279 such records fit in half of it and 280 do not.
  it.each([[279, 1, 0], [280, 0, 1]])(
    "batches a directory of %i 60,000-byte records only while it fits in half the memo",
    async (count, batches, singles) => {
      const fake = fakeCommittedObjects({ tasks: { count, size: 60_000 } });
      const registry = fixtureRegistryGit(configFor("/fixture/registry"), fake.runner);

      await registry.withCommittedTree(["tasks"], () => registry.readHeadRegularBlob(fake.paths("tasks")[0] as string));

      expect(fake.counts()).toEqual({ batches, singles });
    },
  );

  it("clears the memo once before a batch that would overflow it and keeps that whole batch", async () => {
    // A fresh module starts with an empty memo, so the arithmetic is exact: two
    // 16.2 MB directories fit within 32 MiB together, and a third batch does not.
    vi.resetModules();
    const fresh = await import("../registry-git.js");
    const fake = fakeCommittedObjects({
      tasks: { count: 270, size: 60_000 },
      repositories: { count: 270, size: 60_000 },
      "claims/active": { count: 30, size: 60_000 },
    });
    const registry = new fresh.RegistryGit(configFor("/fixture/registry"), fake.runner, undefined, async () => undefined);

    await registry.withCommittedTree(["tasks", "repositories", "claims/active"], async () => {
      await registry.readHeadRegularBlob(fake.paths("tasks")[0] as string);
      await registry.readHeadRegularBlob(fake.paths("repositories")[0] as string);
      // Still remembered: the second batch fit without a clear.
      await registry.readHeadRegularBlob(fake.paths("tasks")[1] as string);
      for (const path of fake.paths("claims/active")) await registry.readHeadRegularBlob(path);
    });
    // Every record of the last batch survived the clear that batch caused.
    expect(fake.counts()).toEqual({ batches: 3, singles: 0 });

    // And that clear did happen: what the first batch remembered is gone.
    fake.forget();
    await registry.readHeadRegularBlob(fake.paths("tasks")[2] as string);
    expect(fake.counts()).toEqual({ batches: 0, singles: 1 });
  });
});
