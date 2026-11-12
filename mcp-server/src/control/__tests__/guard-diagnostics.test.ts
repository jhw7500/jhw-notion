import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendGuardHookDiagnostic,
  GUARD_HOOK_DIAGNOSTICS_FILE,
  type GuardDiagnosticRow,
} from "../guard-diagnostics.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDir(create = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jhw-guard-diagnostics-"));
  roots.push(root);
  const dir = join(root, "state");
  if (create) await mkdir(dir, { mode: 0o700 });
  return dir;
}

const row = (overrides: Partial<GuardDiagnosticRow> = {}): GuardDiagnosticRow => ({
  adapter: "codex", event: "PreToolUse", mode: "observe", kind: "unrecorded_allow", code: "GUARD_UNAVAILABLE", ...overrides,
});

describe("Guard hook diagnostics", () => {
  it("does not create an uninitialized state directory or any file", async () => {
    const dir = await stateDir(false);
    await appendGuardHookDiagnostic(dir, row());
    await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(dir, ".."))).resolves.toEqual([]);
  });

  it("appends one small private row with fixed vocabulary and no lock file", async () => {
    const dir = await stateDir();
    await appendGuardHookDiagnostic(dir, row({ kind: "deadline", elapsed_ms: 6500 }));
    await appendGuardHookDiagnostic(dir, row());
    const raw = await readFile(join(dir, GUARD_HOOK_DIAGNOSTICS_FILE), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(Buffer.byteLength(`${line}\n`, "utf8")).toBeLessThanOrEqual(1024);
    expect(JSON.parse(lines[0]!)).toEqual({
      v: 1, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u), adapter: "codex", event: "PreToolUse",
      mode: "observe", kind: "deadline", code: "GUARD_UNAVAILABLE", elapsed_ms: 6500,
    });
    expect((await stat(join(dir, GUARD_HOOK_DIAGNOSTICS_FILE))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([GUARD_HOOK_DIAGNOSTICS_FILE]);
  });

  it("stops latency rows at 512 KiB and every kind at 1 MiB", async () => {
    const dir = await stateDir();
    const file = join(dir, GUARD_HOOK_DIAGNOSTICS_FILE);
    await writeFile(file, "x".repeat(512 * 1024), { mode: 0o600 });
    await appendGuardHookDiagnostic(dir, row({ kind: "latency", elapsed_ms: 4000 }));
    expect((await stat(file)).size).toBe(512 * 1024);
    await appendGuardHookDiagnostic(dir, row({ kind: "deadline", elapsed_ms: 6500 }));
    expect((await stat(file)).size).toBeGreaterThan(512 * 1024);
    await writeFile(file, "x".repeat(1024 * 1024), { mode: 0o600 });
    await appendGuardHookDiagnostic(dir, row({ kind: "deadline", elapsed_ms: 6500 }));
    expect((await stat(file)).size).toBe(1024 * 1024);
  });

  it("swallows an unsafe existing file or state directory", async () => {
    const dir = await stateDir();
    const file = join(dir, GUARD_HOOK_DIAGNOSTICS_FILE);
    await writeFile(file, "", { mode: 0o644 });
    await expect(appendGuardHookDiagnostic(dir, row())).resolves.toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("");

    const root = await mkdtemp(join(tmpdir(), "jhw-guard-diagnostics-link-"));
    roots.push(root);
    await mkdir(join(root, "target"), { mode: 0o700 });
    await symlink(join(root, "target"), join(root, "state"));
    await expect(appendGuardHookDiagnostic(join(root, "state"), row())).resolves.toBeUndefined();
    expect(await readdir(join(root, "target"))).toEqual([]);
  });
});
