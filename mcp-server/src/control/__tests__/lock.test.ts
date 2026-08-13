import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runUnderMutationLock } from "../process.js";
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

function child(status: number | null, stdout = "", stderr = "") {
  const process = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.stdin.once("finish", () => queueMicrotask(() => {
    if (stdout) process.stdout.end(stdout);
    else process.stdout.end();
    if (stderr) process.stderr.end(stderr);
    else process.stderr.end();
    process.emit("close", status);
  }));
  return process;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mutation lock boundary", () => {
  it("does not trust a caller lock marker and puts credentials only in the stdin envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const seen: { args?: string[]; env?: NodeJS.ProcessEnv; stdin?: string } = {};
    const fake = child(75);
    fake.stdin.on("data", (chunk: Buffer) => { seen.stdin = `${seen.stdin ?? ""}${chunk.toString("utf8")}`; });
    const spawn = vi.fn((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      seen.args = args;
      seen.env = options.env;
      return fake;
    });

    const result = await runUnderMutationLock(
      ["task", "start"],
      configFor(join(root, "state")),
      { PATH: process.env.PATH, JHW_CONTROL_LOCK_HELD: "1", GH_PROJECT_TOKEN: "project-token", GH_REPO_TOKEN: "repo-token" },
      { spawn },
      "/private/locked-cli.js",
    );

    expect(result.exitCode).toBe(75);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "LOCK_CONTENDED" } });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(seen.args?.join(" ")).not.toContain("project-token");
    expect(seen.args?.join(" ")).not.toContain("repo-token");
    expect(seen.env).not.toHaveProperty("GH_PROJECT_TOKEN");
    expect(seen.env).not.toHaveProperty("GH_REPO_TOKEN");
    expect(seen.env).not.toHaveProperty("JHW_CONTROL_LOCK_HELD");
    expect(JSON.parse(seen.stdin ?? "")).toEqual({ GH_PROJECT_TOKEN: "project-token", GH_REPO_TOKEN: "repo-token" });
    const journal = await readFile(join(root, "state", "pilot-journal.jsonl"), "utf8");
    expect(JSON.parse(journal)).toMatchObject({ command: "task start", ok: false, error_code: "LOCK_CONTENDED" });
  });

  it("returns stable JSON and a journal event when flock cannot spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);

    const result = await runUnderMutationLock(
      ["task", "start"],
      configFor(join(root, "state")),
      { PATH: process.env.PATH },
      { spawn: () => { throw new Error("flock missing"); } },
      "/private/locked-cli.js",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "LOCK_SPAWN_FAILED" } });
    const journal = await readFile(join(root, "state", "pilot-journal.jsonl"), "utf8");
    expect(JSON.parse(journal)).toMatchObject({ command: "task start", ok: false, error_code: "LOCK_SPAWN_FAILED" });
  });

  it("does not wait for stdio closure after an asynchronous flock spawn error", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const failed = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
    failed.stdin = new PassThrough();
    failed.stdout = new PassThrough();
    failed.stderr = new PassThrough();
    failed.stdin.once("finish", () => queueMicrotask(() => failed.emit("error", new Error("flock missing"))));

    const result = await runUnderMutationLock(
      ["task", "start"],
      configFor(join(root, "state")),
      { PATH: process.env.PATH },
      { spawn: () => failed },
      "/private/locked-cli.js",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "LOCK_SPAWN_FAILED" } });
  });

  it("delivers a selected credential through stdin to the locked gh-only execution path", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-lock-"));
    roots.push(root);
    const bin = join(root, "bin");
    await rm(bin, { recursive: true, force: true });
    await (await import("node:fs/promises")).mkdir(bin);
    const observedArgs = join(root, "flock-args.txt");
    const observedEnv = join(root, "flock-env.txt");
    const lockedEntry = join(root, "locked-probe.mjs");
    await writeFile(join(bin, "flock"), `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(observedArgs)}
env > ${JSON.stringify(observedEnv)}
while [ "$1" = "-n" ]; do shift; done
if [ "$1" = "-E" ]; then shift 2; fi
shift
exec "$@"
`, "utf8");
    await writeFile(join(bin, "gh"), "#!/bin/sh\n[ \"$GH_TOKEN\" = \"project-token\" ] && printf credential-seen\n", "utf8");
    await chmod(join(bin, "flock"), 0o755);
    await chmod(join(bin, "gh"), 0o755);
    await writeFile(lockedEntry, `
import { spawnSync } from "node:child_process";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (process.env.GH_PROJECT_TOKEN || process.env.GH_REPO_TOKEN) process.exit(9);
const gh = spawnSync("gh", [], { encoding: "utf8", env: { ...process.env, GH_TOKEN: envelope.GH_PROJECT_TOKEN } });
if (gh.status !== 0) process.exit(8);
process.stdout.write(JSON.stringify({ command: "probe", result: { credential_path: gh.stdout } }) + "\\n");
`, "utf8");

    const result = await runUnderMutationLock(
      ["task", "start"],
      configFor(join(root, "state")),
      { PATH: `${bin}:${process.env.PATH}`, GH_PROJECT_TOKEN: "project-token", GH_REPO_TOKEN: "repo-token" },
      undefined,
      lockedEntry,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ result: { credential_path: "credential-seen" } });
    expect(await readFile(observedArgs, "utf8")).not.toContain("project-token");
    expect(await readFile(observedArgs, "utf8")).not.toContain("repo-token");
    expect(await readFile(observedEnv, "utf8")).not.toContain("GH_PROJECT_TOKEN=project-token");
    expect(await readFile(observedEnv, "utf8")).not.toContain("GH_REPO_TOKEN=repo-token");
  });
});
