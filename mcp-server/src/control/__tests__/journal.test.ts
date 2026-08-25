import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendBoundedJournalLine, PilotJournal } from "../journal.js";
import { createSensitiveDataPolicy } from "../sensitive-data.js";

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
  it("rejects protected event content before opening the journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const secret = "unmistakably-fake-journal-token";
    const journal = new PilotJournal(stateDir, {}, createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }));

    const error = await journal.append({ ...event(), bypass_reason: `because ${secret}` }).catch((cause) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a filesystem root rather than chmodding a shared ancestor", async () => {
    await expect(new PilotJournal("/").append(event())).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });
  });

  it("creates a private state directory and journal file", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");

    await new PilotJournal(stateDir).append(event());

    expect((await lstat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(stateDir, "pilot-journal.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("preserves legacy Pilot journal mode repair for an existing plain file", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const journalPath = join(stateDir, "pilot-journal.jsonl");
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(journalPath, `${JSON.stringify(event())}\n`, { mode: 0o600 });
    await chmod(journalPath, 0o644);

    await new PilotJournal(stateDir).append(event());

    expect((await lstat(journalPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(journalPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("keeps the legacy 4096-byte default while allowing a finite caller-specific journal bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-bound-"));
    roots.push(root);
    const defaultState = join(root, "default-state");
    const widerState = join(root, "wider-state");
    const oversizedForLegacy = { value: "x".repeat(5_000) };
    const labels = { tooLarge: "too large", incomplete: "incomplete", failed: "failed" };
    const policy = createSensitiveDataPolicy({});

    await expect(appendBoundedJournalLine(
      defaultState,
      {},
      policy,
      "default.jsonl",
      oversizedForLegacy,
      labels,
    )).rejects.toMatchObject({ code: "JOURNAL_EVENT_TOO_LARGE" });
    await expect(appendBoundedJournalLine(
      widerState,
      {},
      policy,
      "wider.jsonl",
      oversizedForLegacy,
      labels,
      { maximumLineBytes: 8 * 1_024 },
    )).resolves.toBeUndefined();
    await expect(appendBoundedJournalLine(
      join(root, "above-state"),
      {},
      policy,
      "above.jsonl",
      { value: "x".repeat(8 * 1_024) },
      labels,
      { maximumLineBytes: 8 * 1_024 },
    )).rejects.toMatchObject({ code: "JOURNAL_EVENT_TOO_LARGE" });

    await expect(lstat(defaultState)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(widerState, "wider.jsonl"), "utf8")))
      .toEqual(oversizedForLegacy);
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

  it("rejects a hard-linked journal before chmod, append, or sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const external = join(root, "external-journal.jsonl");
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(external, "outside\n", "utf8");
    await chmod(external, 0o644);
    await link(external, join(stateDir, "pilot-journal.jsonl"));
    let synced = false;

    await expect(new PilotJournal(stateDir, {
      afterJournalSync: () => { synced = true; },
    }).append(event())).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });

    expect(await readFile(external, "utf8")).toBe("outside\n");
    expect((await lstat(external)).mode & 0o777).toBe(0o644);
    expect(synced).toBe(false);
  });

  it("rejects a FIFO journal without blocking before its type check", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    await mkdir(stateDir, { mode: 0o700 });
    execFileSync("mkfifo", [join(stateDir, "pilot-journal.jsonl")]);

    await expect(new PilotJournal(stateDir).append(event())).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });
  });

  it("reports the journal durable only after data and directory sync complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    let synced = false;

    await new PilotJournal(stateDir, {
      afterJournalSync: () => { synced = true; },
    }).append(event());

    expect(synced).toBe(true);
    expect(JSON.parse(await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8"))).toMatchObject(event());
  });

  it("rejects the append when the journal file sync fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    let reportedDurable = false;

    await expect(new PilotJournal(stateDir, {
      syncJournalFile: async () => { throw new Error("injected file sync failure"); },
      afterJournalSync: () => { reportedDurable = true; },
    }).append(event())).rejects.toMatchObject({ code: "JOURNAL_WRITE_FAILED" });

    expect(reportedDurable).toBe(false);
    expect(JSON.parse(await readFile(join(stateDir, "pilot-journal.jsonl"), "utf8"))).toMatchObject(event());
  });

  it("keeps the journal on the opened state-directory inode after an ancestor swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-journal-"));
    roots.push(root);
    const originalParent = join(root, "original-parent");
    const stateDir = join(originalParent, "state");
    const movedParent = join(root, "moved-parent");
    const externalParent = join(root, "external-parent");
    await mkdir(stateDir, { recursive: true });
    await mkdir(externalParent);

    await new PilotJournal(stateDir, {
      afterDirectoryOpen: async () => {
        await rename(originalParent, movedParent);
        await mkdir(originalParent);
        await rename(externalParent, join(originalParent, "state"));
      },
    }).append(event());

    expect(JSON.parse(await readFile(join(movedParent, "state", "pilot-journal.jsonl"), "utf8"))).toMatchObject({ command: "portfolio status" });
    await expect(lstat(join(originalParent, "state", "pilot-journal.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
