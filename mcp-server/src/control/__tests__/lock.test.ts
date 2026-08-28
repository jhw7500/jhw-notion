import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGuardMutationLockAuthorityForTesting,
  MutationLock,
  ProcessRunner,
  runWithGuardMutationLockAuthority,
  type MutationLockRuntime,
} from "../process.js";
import type { ControlConfig } from "../config.js";

const execFile = promisify(execFileCallback);
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
    registryRepository: "owner/registry",
    preflightProjectItemId: "PVTI_trial",
    preflightRegistryIssueNumber: 1,
    stateDir,
    guardMode: "enforce",
  };
}

function completedAcquisition(status: number, error = false) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  queueMicrotask(() => {
    if (error) child.emit("error", new Error("flock unavailable"));
    else child.emit("close", status);
  });
  return child;
}

async function contender(lockPath: string): Promise<{ code: number | undefined }> {
  return execFile("flock", ["-n", "-E", "75", lockPath, "/bin/sh", "-c", "exit 0"], { encoding: "utf8" })
    .then(() => ({ code: 0 }))
    .catch((cause: unknown) => ({ code: (cause as { code?: number }).code }));
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("callback mutation lock", () => {
  it("keeps the verified run path independent of an instance override of the Guard directory callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const runtime: MutationLockRuntime = { spawn: vi.fn(() => completedAcquisition(0)) };
    const lock = new MutationLock(configFor(join(root, "state")), {}, runtime);
    (lock as unknown as { runInStateDirectory: (callback: () => Promise<string>) => Promise<string> })
      .runInStateDirectory = vi.fn(async () => "forged");
    const callback = vi.fn(async () => "authoritative");

    await expect(lock.run(callback)).resolves.toBe("authoritative");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
  });

  it("runs the callback only after one credential-free acquisition and ignores a caller marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const seen: { args?: string[]; env?: NodeJS.ProcessEnv; stdio?: unknown } = {};
    const runtime: MutationLockRuntime = {
      spawn: vi.fn((_command, args, options) => {
        seen.args = args;
        seen.env = options.env;
        seen.stdio = options.stdio;
        return completedAcquisition(0);
      }),
    };

    const value = await new MutationLock(
      configFor(join(root, "state")),
      { PATH: process.env.PATH, JHW_CONTROL_LOCK_HELD: "1", GH_PROJECT_TOKEN: "project-token", GH_REPO_TOKEN: "repo-token" },
      runtime,
    ).run(async () => "original-process-credential-retained");

    expect(value).toBe("original-process-credential-retained");
    expect((runtime.spawn as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(seen.args).toEqual(["-n", "-E", "75", "3"]);
    expect(seen.stdio).toEqual(["ignore", "ignore", "ignore", expect.any(Number)]);
    expect(seen.env).not.toHaveProperty("GH_PROJECT_TOKEN");
    expect(seen.env).not.toHaveProperty("GH_REPO_TOKEN");
    expect(seen.env).not.toHaveProperty("JHW_CONTROL_LOCK_HELD");
  });

  it("keeps the Registry writer bounded wait separate from the Guard five-second override", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const seen: string[][] = [];
    const runtime: MutationLockRuntime = {
      spawn: (_command, args) => {
        seen.push([...args]);
        return completedAcquisition(0);
      },
    };
    const lock = new MutationLock(configFor(join(root, "state")), {}, runtime, {}, {
      waitSeconds: 30,
      contendedReason: "registry_state_lock",
    });
    const authority = createGuardMutationLockAuthorityForTesting(lock);

    await lock.run(async () => undefined, { command: "preflight" });
    await runWithGuardMutationLockAuthority(authority, async () => undefined);

    expect(seen).toEqual([
      ["-w", "30", "-E", "75", "3"],
      ["-w", "5", "-E", "75", "3"],
    ]);
  });

  it("does not invoke the callback on contention, nonzero acquisition, spawn, or child error", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const callback = vi.fn(async () => "must-not-run");
    const contended = new MutationLock(configFor(join(root, "contended")), {}, { spawn: () => completedAcquisition(75) });
    const nonzero = new MutationLock(configFor(join(root, "nonzero")), {}, { spawn: () => completedAcquisition(1) });
    const spawnFailure = new MutationLock(configFor(join(root, "spawn")), {}, { spawn: () => { throw new Error("missing"); } });
    const childError = new MutationLock(configFor(join(root, "child-error")), {}, { spawn: () => completedAcquisition(1, true) });

    await expect(contended.run(callback)).rejects.toMatchObject({ code: "LOCK_CONTENDED" });
    await expect(nonzero.run(callback)).rejects.toMatchObject({ code: "LOCK_ACQUIRE_FAILED" });
    await expect(spawnFailure.run(callback)).rejects.toMatchObject({ code: "LOCK_SPAWN_FAILED" });
    await expect(childError.run(callback)).rejects.toMatchObject({ code: "LOCK_SPAWN_FAILED" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("bounds a lock helper that never emits error or close", async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
      roots.push(root);
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      const callback = vi.fn(async () => "must-not-run");
      const spawned = deferred();
      const pending = new MutationLock(
        configFor(join(root, "state")),
        {},
        { spawn: () => { spawned.resolve(); return child; } },
      ).run(callback);

      await spawned.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).rejects.toMatchObject({ code: "LOCK_ACQUIRE_TIMEOUT" });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(callback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a real flock after its acquisition process exits until the pending callback returns", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const acquiredExited = deferred();
    let acquisitionStatus: number | null = null;
    const runtime: MutationLockRuntime = {
      spawn: (command, args, options) => {
        const child = spawnChild(command, args, options);
        child.once("close", (status) => {
          acquisitionStatus = status;
          acquiredExited.resolve();
        });
        return child;
      },
    };
    const callbackEntered = deferred();
    const releaseCallback = deferred();
    const lock = new MutationLock(configFor(stateDir), {}, runtime);
    const running = lock.run(async () => {
      callbackEntered.resolve();
      await releaseCallback.promise;
      expect((await contender(join(stateDir, "registry.lock"))).code).toBe(75);
    });

    await callbackEntered.promise;
    await acquiredExited.promise;
    expect(acquisitionStatus).toBe(0);
    expect((await contender(join(stateDir, "registry.lock"))).code).toBe(75);
    releaseCallback.resolve();
    await running;
    expect((await contender(join(stateDir, "registry.lock"))).code).toBe(0);
  });

  it("returns bounded holder diagnostics across projects after a real wait timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const holderEntered = deferred();
    const releaseHolder = deferred();
    const holder = new MutationLock(configFor(stateDir));
    const otherProjectConfig = { ...configFor(stateDir), registryDir: "/srv/other-registry" };
    const waiting = new MutationLock(otherProjectConfig, process.env, undefined, {}, {
      waitSeconds: 1,
      contendedReason: "registry_state_lock",
    });
    const waitingCallback = vi.fn(async () => undefined);
    const held = holder.run(async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
    }, { command: "preflight" });
    await holderEntered.promise;

    try {
      await expect(waiting.run(waitingCallback, { command: "task start" })).rejects.toMatchObject({
        code: "LOCK_CONTENDED",
        details: {
          reason: "registry_state_lock",
          lock_holder: {
            command: "preflight",
            acquired_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            elapsed_ms: expect.any(Number),
            pid_state: "alive",
          },
        },
      });
      expect(waitingCallback).not.toHaveBeenCalled();
    } finally {
      releaseHolder.resolve();
      await held;
    }
  });

  it("recovers after a holder is killed without deleting registry.lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const lockPath = join(stateDir, "registry.lock");
    await mkdir(stateDir);
    const holder = spawnChild(
      "/usr/bin/flock",
      ["--no-fork", lockPath, "/bin/sh", "-c", "printf ready; exec sleep 30"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const ready = new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout?.once("data", () => resolve());
      holder.once("close", (status) => {
        if (status !== null && status !== 0) reject(new Error(`holder exited before readiness: ${status}`));
      });
    });

    try {
      await ready;
      expect((await contender(lockPath)).code).toBe(75);
      const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
      holder.kill("SIGKILL");
      await closed;

      await expect(new MutationLock(configFor(stateDir)).run(async () => "acquired", {
        command: "preflight",
      })).resolves.toBe("acquired");
      expect((await lstat(lockPath)).isFile()).toBe(true);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });

  it("releases the inherited lock FD after a callback error", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const lock = new MutationLock(configFor(stateDir));

    await expect(lock.run(async () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");

    expect((await contender(join(stateDir, "registry.lock"))).code).toBe(0);
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
        return completedAcquisition(0);
      }),
    };

    const output = await new MutationLock(configFor(join(root, "state")), environment, runtime).run(async () =>
      (await new ProcessRunner(environment).runGh([], "project")).stdout,
    );

    expect(output).toBe("credential-seen");
    expect(seen.env).not.toHaveProperty("GH_PROJECT_TOKEN");
    expect(seen.env).not.toHaveProperty("GH_REPO_TOKEN");
  });

  it("preserves legacy Registry lock mode repair for an existing plain file", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const lockPath = join(stateDir, "registry.lock");
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(lockPath, "", { mode: 0o600 });
    await chmod(lockPath, 0o644);
    const runtime: MutationLockRuntime = { spawn: vi.fn(() => completedAcquisition(0)) };

    await new MutationLock(configFor(stateDir), {}, runtime).run(async () => undefined);

    expect((await lstat(lockPath)).mode & 0o777).toBe(0o600);
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
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
    const lock = new MutationLock(configFor(stateDir), {}, { spawn: () => completedAcquisition(0) }, {
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

  it("rejects a hard-linked registry lock before chmod or flock acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const external = join(root, "external-lock");
    await mkdir(stateDir);
    await writeFile(external, "outside", "utf8");
    await chmod(external, 0o644);
    await link(external, join(stateDir, "registry.lock"));
    const spawn = vi.fn();

    await expect(new MutationLock(configFor(stateDir), {}, { spawn }).run(async () => undefined)).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });

    expect(await readFile(external, "utf8")).toBe("outside");
    expect((await lstat(external)).mode & 0o777).toBe(0o644);
    expect(spawn).not.toHaveBeenCalled();
  });
});
