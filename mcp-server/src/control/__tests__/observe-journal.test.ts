import { execFile as execFileCallback } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ObserveJournal } from "../observe-journal.js";

const roots: string[] = [];
const RowSchema = z.object({ sequence: z.number().int().nonnegative() }).strict();
const execFile = promisify(execFileCallback);
const mcpRoot = fileURLToPath(new URL("../../../", import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; stateDir: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "jhw-observe-journal-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const path = join(stateDir, "guard-observe-journal.v1.jsonl");
  return { root, stateDir, path };
}

describe("ObserveJournal", () => {
  it("blocks the next writer after an incomplete prior row without changing the poison bytes", async () => {
    const { stateDir, path } = await fixture();
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(path, '{"sequence":', { mode: 0o600 });
    const before = await readFile(path);

    await expect(new ObserveJournal(stateDir, RowSchema).append({ sequence: 2 }))
      .rejects.toMatchObject({ code: "JOURNAL_WRITE_FAILED" });

    expect(await readFile(path)).toEqual(before);
  });

  it("rejects invalid UTF-8, non-schema rows, and a missing final newline without changing bytes", async () => {
    for (const bytes of [
      Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
      Buffer.from('{"unexpected":true}\n', "utf8"),
      Buffer.from('{"sequence":1}', "utf8"),
    ]) {
      const { stateDir, path } = await fixture();
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(path, bytes, { mode: 0o600 });

      await expect(new ObserveJournal(stateDir, RowSchema).append({ sequence: 2 }))
        .rejects.toMatchObject({ code: "JOURNAL_WRITE_FAILED" });
      expect(await readFile(path)).toEqual(bytes);
    }
  });

  it("leaves independently parseable schema-valid rows after sequential appends", async () => {
    const { stateDir, path } = await fixture();
    const journal = new ObserveJournal(stateDir, RowSchema);

    await journal.append({ sequence: 1 });
    await journal.append({ sequence: 2 });

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => RowSchema.parse(JSON.parse(line)))).toEqual([
      { sequence: 1 },
      { sequence: 2 },
    ]);
  });

  it("serializes two independent writer processes into schema-valid rows", async () => {
    const { stateDir, path } = await fixture();
    const run = (sequence: number, mode = "normal") => execFile(
      join(mcpRoot, "node_modules/.bin/vitest"),
      ["run", "src/control/__tests__/observe-journal-process.test.ts", "--pool=forks"],
      {
        cwd: mcpRoot,
        env: {
          ...process.env,
          OBSERVE_PROCESS_STATE_DIR: stateDir,
          OBSERVE_PROCESS_MODE: mode,
          OBSERVE_PROCESS_SEQUENCE: String(sequence),
        },
      },
    );

    await Promise.all([run(1), run(2)]);
    const rows = (await readFile(path, "utf8")).trimEnd().split("\n")
      .map((line) => RowSchema.parse(JSON.parse(line)));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sequence).sort()).toEqual([1, 2]);

    const poisoned = await fixture();
    const runPoisoned = (sequence: number, mode: string) => execFile(
      join(mcpRoot, "node_modules/.bin/vitest"),
      ["run", "src/control/__tests__/observe-journal-process.test.ts", "--pool=forks"],
      {
        cwd: mcpRoot,
        env: {
          ...process.env,
          OBSERVE_PROCESS_STATE_DIR: poisoned.stateDir,
          OBSERVE_PROCESS_MODE: mode,
          OBSERVE_PROCESS_SEQUENCE: String(sequence),
        },
      },
    );
    await runPoisoned(1, "short");
    const prefix = await readFile(poisoned.path);
    await runPoisoned(2, "blocked");
    expect(await readFile(poisoned.path)).toEqual(prefix);
  });

  it("detects a path replacement after sync while preserving both inode contents", async () => {
    const { stateDir, path } = await fixture();
    const retained = `${path}.retained`;
    const journal = new ObserveJournal(stateDir, RowSchema, {
      afterJournalSync: async () => {
        await rename(path, retained);
        await writeFile(path, "", { mode: 0o600 });
      },
    });

    await expect(journal.append({ sequence: 1 })).rejects.toMatchObject({ code: "JOURNAL_WRITE_FAILED" });
    expect(await readFile(retained, "utf8")).toBe('{"sequence":1}\n');
    expect(await readFile(path, "utf8")).toBe("");
  });

  it("rejects publication when an ancestor rename detaches the retained state directory from its canonical path", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-observe-ancestor-"));
    roots.push(root);
    const parent = join(root, "canonical");
    const moved = join(root, "moved");
    const stateDir = join(parent, "state");
    const canonicalJournal = join(stateDir, "guard-observe-journal.v1.jsonl");
    const movedJournal = join(moved, "state", "guard-observe-journal.v1.jsonl");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const journal = new ObserveJournal(stateDir, RowSchema, {
      afterDirectoryOpen: async () => {
        await rename(parent, moved);
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
      },
    });

    await expect(journal.append({ sequence: 1 })).rejects.toBeDefined();
    await expect(lstat(canonicalJournal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(movedJournal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-sticky group/world-writable ancestor before appending", async () => {
    const { root, stateDir, path } = await fixture();
    await chmod(root, 0o777);

    await expect(new ObserveJournal(stateDir, RowSchema).append({ sequence: 1 })).rejects.toBeDefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects post-sync journal path metadata that disagrees with the retained FD", async () => {
    const { stateDir, path } = await fixture();
    let synced = false;
    let journalOpens = 0;
    const journal = new ObserveJournal(stateDir, RowSchema, {
      afterJournalSync: () => { synced = true; },
      afterDirectoryOpen(directory) {
        const openFile = directory.openFile.bind(directory);
        directory.openFile = async (name, flags, mode) => {
          const file = await openFile(name, flags, mode);
          if (name === "guard-observe-journal.v1.jsonl" && ++journalOpens > 1) {
            const stat = file.stat.bind(file);
            Object.defineProperty(file, "stat", {
              configurable: true,
              value: async (options?: { bigint?: boolean }) => {
                if (!options?.bigint) return stat();
                const info = await stat({ bigint: true });
                return synced ? { ...info, isFile: () => true, ctimeNs: info.ctimeNs + 1n } : info;
              },
            });
          }
          return file;
        };
      },
    });

    await expect(journal.append({ sequence: 1 })).rejects.toMatchObject({ code: "JOURNAL_WRITE_FAILED" });
    expect(await readFile(path, "utf8")).toBe('{"sequence":1}\n');
  });

  it("rejects post-acquire lock path metadata that disagrees with the retained FD", async () => {
    const { stateDir, path } = await fixture();
    let lockOpens = 0;
    const journal = new ObserveJournal(stateDir, RowSchema, {
      afterDirectoryOpen(directory) {
        const openFile = directory.openFile.bind(directory);
        directory.openFile = async (name, flags, mode) => {
          const file = await openFile(name, flags, mode);
          if (name === "guard-observe-journal.lock" && ++lockOpens > 1) {
            const stat = file.stat.bind(file);
            Object.defineProperty(file, "stat", {
              configurable: true,
              value: async (options?: { bigint?: boolean }) => {
                if (!options?.bigint) return stat();
                const info = await stat({ bigint: true });
                return { ...info, isFile: () => true, mtimeNs: info.mtimeNs + 1n };
              },
            });
          }
          return file;
        };
      },
    });

    await expect(journal.append({ sequence: 1 })).rejects.toBeDefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects lock metadata changed after the journal sync and before returning", async () => {
    const { stateDir, path } = await fixture();
    const lockPath = join(stateDir, "guard-observe-journal.lock");
    const journal = new ObserveJournal(stateDir, RowSchema, {
      afterJournalSync: async () => { await chmod(lockPath, 0o640); },
    });

    await expect(journal.append({ sequence: 1 })).rejects.toBeDefined();
    expect(await readFile(path, "utf8")).toBe('{"sequence":1}\n');
  });

  it("enforces the bounded row count before writing and preserves all bytes", async () => {
    const { stateDir, path } = await fixture();
    await mkdir(stateDir, { mode: 0o700 });
    const bytes = Buffer.from(Array.from({ length: 8 * 1024 }, (_, sequence) =>
      JSON.stringify({ sequence })).join("\n") + "\n", "utf8");
    await writeFile(path, bytes, { mode: 0o600 });

    await expect(new ObserveJournal(stateDir, RowSchema).append({ sequence: 9_000 }))
      .rejects.toMatchObject({ code: "JOURNAL_WRITE_FAILED" });
    expect(await readFile(path)).toEqual(bytes);
  });

  it("rejects unsafe observe files and lock files without touching their targets", async () => {
    for (const leaf of ["guard-observe-journal.v1.jsonl", "guard-observe-journal.lock"]) {
      for (const kind of ["symlink", "hardlink"] as const) {
        const { root, stateDir, path } = await fixture();
        await mkdir(stateDir, { mode: 0o700 });
        const external = join(root, `${leaf}-${kind}`);
        await writeFile(external, "outside", { mode: 0o600 });
        const target = join(stateDir, leaf);
        if (kind === "symlink") await symlink(external, target);
        else await link(external, target);

        await expect(new ObserveJournal(stateDir, RowSchema).append({ sequence: 1 })).rejects.toBeDefined();
        expect(await readFile(external, "utf8")).toBe("outside");
        if (leaf !== "guard-observe-journal.v1.jsonl") {
          await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    }
  });

  it("rejects special mode bits on the state directory, lock, and journal", async () => {
    for (const leaf of [undefined, "guard-observe-journal.lock", "guard-observe-journal.v1.jsonl"] as const) {
      const { stateDir, path } = await fixture();
      await mkdir(stateDir, { mode: 0o700 });
      if (leaf) await writeFile(join(stateDir, leaf), "", { mode: 0o600 });
      await chmod(leaf ? join(stateDir, leaf) : stateDir, leaf ? 0o4600 : 0o4700);

      await expect(new ObserveJournal(stateDir, RowSchema).append({ sequence: 1 })).rejects.toBeDefined();
      if (leaf !== "guard-observe-journal.v1.jsonl") {
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  it("rejects a state namespace that is not owned by the current UID", async () => {
    const { stateDir, path } = await fixture();
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    try {
      await expect(new ObserveJournal(stateDir, RowSchema).append({ sequence: 1 })).rejects.toBeDefined();
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      getuid.mockRestore();
    }
  });

  it.each(["guard-observe-journal.lock", "guard-observe-journal.v1.jsonl"])(
    "rejects a foreign-owned %s descriptor before publication",
    async (foreignLeaf) => {
      const { stateDir, path } = await fixture();
      const journal = new ObserveJournal(stateDir, RowSchema, {
        afterDirectoryOpen(directory) {
          const openFile = directory.openFile.bind(directory);
          directory.openFile = async (name, flags, mode) => {
            const file = await openFile(name, flags, mode);
            if (name === foreignLeaf) {
              const stat = file.stat.bind(file);
              Object.defineProperty(file, "stat", {
                configurable: true,
                value: async (options?: { bigint?: boolean }) => {
                  const info = await stat(options as never);
                  return {
                    ...info,
                    isFile: () => true,
                    uid: typeof info.uid === "bigint" ? info.uid + 1n : info.uid + 1,
                  };
                },
              });
            }
            return file;
          };
        },
      });

      await expect(journal.append({ sequence: 1 })).rejects.toBeDefined();
      if (foreignLeaf.endsWith("lock")) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(path, "utf8")).toBe("");
    },
  );

  it("preserves a fully written row when fsync fails and blocks the next writer on valid framing", async () => {
    const { stateDir, path } = await fixture();
    const journal = new ObserveJournal(stateDir, RowSchema, {
      syncJournalFile: async () => { throw new Error("fsync failed"); },
    });

    await expect(journal.append({ sequence: 1 })).rejects.toMatchObject({ code: "JOURNAL_WRITE_FAILED" });
    expect(await readFile(path, "utf8")).toBe('{"sequence":1}\n');
    await expect(new ObserveJournal(stateDir, RowSchema).append({ sequence: 2 })).resolves.toBeUndefined();
  });
});
