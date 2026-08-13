import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MutationLock, ProcessRunner, type MutationLockRuntime } from "../process.js";
import type { ControlConfig } from "../config.js";

const roots: string[] = [];

function configFor(stateDir: string): ControlConfig {
  return {
    registryDir: "/srv/registry",
    registryRemote: "origin",
    registryBranch: "main",
    worktreeRoot: "/srv/worktrees",
    buildHost: "build-host",
    githubOwner: "owner",
    projectNumber: 1,
    stateDir,
  };
}

function holder(options: { ready?: string; status?: number; error?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  queueMicrotask(() => {
    if (options.error) {
      child.emit("error", new Error("flock missing"));
      return;
    }
    if (options.ready !== undefined) child.stdout.write(options.ready);
    if (options.status !== undefined) {
      child.stdout.end();
      child.emit("close", options.status);
    }
  });
  child.stdin.once("finish", () => queueMicrotask(() => {
    child.stdout.end();
    child.emit("close", 0);
  }));
  return child;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("callback mutation lock", () => {
  it("runs the callback under one credential-free holder and ignores a caller marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const seen: { args?: string[]; env?: NodeJS.ProcessEnv; stdin?: string } = {};
    const runtime: MutationLockRuntime = {
      spawn: vi.fn((_command, args, options) => {
        seen.args = args;
        seen.env = options.env;
        const child = holder({ ready: "READY\n" });
        child.stdin.on("data", (chunk: Buffer) => { seen.stdin = `${seen.stdin ?? ""}${chunk}`; });
        return child;
      }),
    };

    const value = await new MutationLock(
      configFor(join(root, "state")),
      { PATH: process.env.PATH, JHW_CONTROL_LOCK_HELD: "1", GH_PROJECT_TOKEN: "project-token", GH_REPO_TOKEN: "repo-token" },
      runtime,
    ).run(async () => "original-process-credential-retained");

    expect(value).toBe("original-process-credential-retained");
    expect((runtime.spawn as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(seen.args).toEqual(["-n", "-E", "75", "/proc/self/fd/3", "/bin/sh", "-c", "printf 'READY\\n'; cat >/dev/null"]);
    expect(seen.env).not.toHaveProperty("GH_PROJECT_TOKEN");
    expect(seen.env).not.toHaveProperty("GH_REPO_TOKEN");
    expect(seen.env).not.toHaveProperty("JHW_CONTROL_LOCK_HELD");
    expect(seen.stdin ?? "").toBe("");
  });

  it("maps immediate contention before READY to LOCK_CONTENDED", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const lock = new MutationLock(configFor(join(root, "state")), {}, { spawn: () => holder({ status: 75 }) });

    await expect(lock.run(async () => "must-not-run")).rejects.toMatchObject({ code: "LOCK_CONTENDED" });
  });

  it("maps spawn and malformed READY failures before invoking the callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const spawn = new MutationLock(configFor(join(root, "state")), {}, { spawn: () => { throw new Error("missing"); } });
    const badReady = new MutationLock(configFor(join(root, "state-two")), {}, { spawn: () => holder({ ready: "NOPE\n", status: 1 }) });

    await expect(spawn.run(async () => "must-not-run")).rejects.toMatchObject({ code: "LOCK_SPAWN_FAILED" });
    await expect(badReady.run(async () => "must-not-run")).rejects.toMatchObject({ code: "LOCK_READY_FAILED" });
  });

  it("retains the selected credential only in the original ProcessRunner gh path", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    const gh = join(bin, "gh");
    await writeFile(gh, "#!/bin/sh\n[ \"$GH_TOKEN\" = \"project-token\" ] && printf credential-seen\n", "utf8");
    await chmod(gh, 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH}`, GH_PROJECT_TOKEN: "project-token", GH_REPO_TOKEN: "repo-token" };
    const seen: { env?: NodeJS.ProcessEnv } = {};
    const runtime: MutationLockRuntime = {
      spawn: vi.fn((_command, _args, options) => {
        seen.env = options.env;
        return holder({ ready: "READY\n" });
      }),
    };

    const output = await new MutationLock(configFor(join(root, "state")), environment, runtime).run(async () =>
      (await new ProcessRunner(environment).runGh([], "project")).stdout,
    );

    expect(output).toBe("credential-seen");
    expect(seen.env).not.toHaveProperty("GH_PROJECT_TOKEN");
    expect(seen.env).not.toHaveProperty("GH_REPO_TOKEN");
  });

  it("keeps registry.lock on the opened state-directory inode after an ancestor swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const originalParent = join(root, "original-parent");
    const stateDir = join(originalParent, "state");
    const movedParent = join(root, "moved-parent");
    const externalParent = join(root, "external-parent");
    await mkdir(stateDir, { recursive: true });
    await mkdir(externalParent);
    const lock = new MutationLock(configFor(stateDir), {}, { spawn: () => holder({ ready: "READY\n" }) }, {
      afterDirectoryOpen: async () => {
        await rename(originalParent, movedParent);
        await mkdir(originalParent);
        await rename(externalParent, join(originalParent, "state"));
      },
    });

    await lock.run(async () => undefined);

    expect((await lstat(join(movedParent, "state", "registry.lock"))).isFile()).toBe(true);
    await expect(lstat(join(originalParent, "state", "registry.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a final registry lock symlink without touching its external target", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const external = join(root, "external-lock");
    await mkdir(stateDir);
    await writeFile(external, "outside", "utf8");
    await chmod(external, 0o644);
    await symlink(external, join(stateDir, "registry.lock"));
    const spawn = vi.fn();

    await expect(new MutationLock(configFor(stateDir), {}, { spawn }).run(async () => undefined)).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });

    expect(await readFile(external, "utf8")).toBe("outside");
    expect((await lstat(external)).mode & 0o777).toBe(0o644);
    expect(spawn).not.toHaveBeenCalled();
  });
});
