import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PilotJournal } from "../journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event() {
  return {
    command: "portfolio status",
    started_at: "2026-08-13T00:00:00.000Z",
    finished_at: "2026-08-13T00:00:01.000Z",
    elapsed_ms: 1000,
    ok: true,
    payload_bytes: 32,
  };
}

describe("PilotJournal", () => {
  it("creates a private state directory and journal file", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");

    await new PilotJournal(stateDir).append(event());

    expect((await lstat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(stateDir, "pilot-journal.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("rejects a symbolic-link state directory ancestor without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const external = join(root, "external");
    const stateLink = join(root, "state-link");
    await mkdir(external, { mode: 0o755 });
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "outside", "utf8");
    await chmod(sentinel, 0o644);
    await symlink(external, stateLink);

    await expect(new PilotJournal(join(stateLink, "configured-state")).append(event())).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });

    expect(await readFile(sentinel, "utf8")).toBe("outside");
    expect((await lstat(sentinel)).mode & 0o777).toBe(0o644);
    await expect(lstat(join(external, "configured-state", "pilot-journal.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a final journal symlink without touching its external target", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const external = join(root, "external-journal.jsonl");
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(external, "outside", "utf8");
    await chmod(external, 0o644);
    await symlink(external, join(stateDir, "pilot-journal.jsonl"));

    await expect(new PilotJournal(stateDir).append(event())).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });

    expect(await readFile(external, "utf8")).toBe("outside");
    expect((await lstat(external)).mode & 0o777).toBe(0o644);
  });
});
