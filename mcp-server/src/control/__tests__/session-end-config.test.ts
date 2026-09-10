import { chmod, link, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadControlConfig } from "../config.js";
import { runProductionHookAdapter } from "../hook-adapter.js";
import { createProductionSessionEndRecorder } from "../session-end.js";
import { ActiveClaimSchema, TaskRecordSchema } from "../schemas.js";
import { workContractDigest } from "../work-contract.js";
import { WorktreeManager, worktreePlan } from "../worktree.js";
import { commitFile, git, makeRegistryFixture, type RegistryFixture } from "./helpers.js";

const fixtures: RegistryFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture() {
  const registry = await makeRegistryFixture();
  fixtures.push(registry);
  const home = registry.root;
  const file = join(home, ".config/jhw-control/control.env");
  const coordinates = {
    JHW_REGISTRY_DIR: registry.registryDir,
    JHW_REGISTRY_REMOTE: "origin",
    JHW_REGISTRY_BRANCH: "main",
    JHW_WORKTREE_ROOT: join(home, "worktrees"),
    JHW_CONTROL_STATE_DIR: join(home, "state"),
    JHW_BUILD_HOST: "fixture-host",
    JHW_GITHUB_OWNER: "fixture-owner",
    JHW_PROJECT_NUMBER: "1",
    JHW_REGISTRY_REPOSITORY: "fixture-owner/registry",
    JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_fixture",
    JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
  };
  const text = Object.entries(coordinates).map(([key, value]) => `${key}=${value}\n`).join("");
  await mkdir(join(home, ".config/jhw-control"), { recursive: true });
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  const environment = { HOME: home, PATH: process.env.PATH };
  const event = {
    protocol_version: 1,
    adapter: "codex",
    event: "session_end",
    session_id: "fixture-session",
    cwd: home,
  };
  return { ...registry, file, coordinates, text, environment, event };
}

describe("SessionEnd private host configuration", () => {
  it("reads the private coordinate file when the hook inherits no coordinates", async () => {
    // Break caught: production composition still requires ambient JHW_* variables.
    const f = await fixture();
    const recorder = createProductionSessionEndRecorder(f.environment);
    await expect(recorder.record(f.event)).resolves.toEqual({ status: "NO_MATCH" });
    expect(await readFile(f.file, "utf8")).toBe(f.text);
    expect(await readdir(f.root)).not.toContain("state");
    // Guard/CLI configuration must not silently acquire the same fallback.
    expect(() => loadControlConfig(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it("keeps a complete ambient configuration authoritative without opening the file", async () => {
    const f = await fixture();
    await rm(f.file);
    await symlink(join(f.root, "missing"), f.file);
    await expect(createProductionSessionEndRecorder({ ...f.environment, ...f.coordinates }).record(f.event))
      .resolves.toEqual({ status: "NO_MATCH" });
  });

  it("accepts data-only export/CRLF syntax at the byte boundary", async () => {
    const f = await fixture();
    const exported = f.text.split("\n").filter(Boolean).map((line) => `export\t${line}\r\n`).join("");
    await writeFile(f.file, exported + "#".repeat(16 * 1024 - Buffer.byteLength(exported)));
    await expect(createProductionSessionEndRecorder(f.environment).record(f.event))
      .resolves.toEqual({ status: "NO_MATCH" });
  });

  it("records a real native SessionEnd through file configuration without lifecycle writes", async () => {
    // Break caught: config is loaded but the production hook never reaches the journal,
    // or the evidence composition changes Task, Claim, mapping, or Guard authority state.
    const f = await fixture();
    const taskId = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
    const claimId = "clm-018f21e0-7b2c-7a00-8000-000000000002";
    const alias = "control:tmp-20260910-01-session-end";
    const plan = worktreePlan(taskId, alias);
    const contract = { version: 1 as const, task_id: taskId, grants: [], dependencies: [] };
    const task = TaskRecordSchema.parse({
      id: taskId, project_id: "prj-control", repo_id: "repo-control", aliases: [alias],
      kind: "temporary", goal: "Record termination evidence", done_conditions: ["Evidence recorded"],
      expected_scope: ["SessionEnd"], lifecycle: "active", work_contract: contract,
    });
    const claim = ActiveClaimSchema.parse({
      task_id: taskId, task_alias: alias, project_id: task.project_id, repo_id: task.repo_id,
      claim_id: claimId, origin_adapter: "codex", session_id: "fixture-session", host: "fixture-host",
      ...plan, source_task_revision: "fixture-revision", started_at: "2026-09-10T12:00:00.000Z",
      work_contract: contract, work_contract_digest: workContractDigest(contract),
    });
    await commitFile(f.registryDir, `tasks/${taskId}.yaml`, JSON.stringify(task));
    await commitFile(f.registryDir, `claims/active/${taskId}.yaml`, JSON.stringify(claim));
    const config = loadControlConfig(f.coordinates);
    const worktree = await new WorktreeManager(config).createOrReuse(claim, f.registryDir);
    await writeFile(join(worktree.path, "changed.txt"), "private filename evidence must not escape\n");
    const mappingFile = join(config.stateDir, "worktrees.json");
    const beforeMapping = await readFile(mappingFile);
    const beforeHead = await git(f.registryDir, "rev-parse", "HEAD");
    const beforeStateNames = await readdir(config.stateDir);
    const result = await runProductionHookAdapter(
      ["--adapter", "codex", "--event", "SessionEnd"],
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "fixture-session", cwd: worktree.path,
        transcript_path: null, reason: "other" }),
      f.environment,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "{}\n", stderr: "" });
    const journalBytes = await readFile(join(config.stateDir, "guard-journal.jsonl"), "utf8");
    const journal = journalBytes.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ event: "session-ended", task_id: taskId, claim_id: claimId,
      origin_adapter: "codex", dirty: true, ahead: 0, behind: 0, head_sha: beforeHead.trim() });
    expect(journalBytes).not.toContain("fixture-session");
    expect(journalBytes).not.toContain(f.root);
    expect(journalBytes).not.toContain("changed.txt");
    expect(await readFile(mappingFile)).toEqual(beforeMapping);
    expect(await git(f.registryDir, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await git(f.registryDir, "status", "--porcelain")).toBe("");
    expect((await readdir(config.stateDir)).filter((name) => !beforeStateNames.includes(name)))
      .toEqual(["guard-journal.jsonl"]);
  });

  it.each(["JHW_REGISTRY_DIR", "JHW_REGISTRY_REMOTE", "JHW_CONTROL_STATE_DIR"] as const)(
    "does not mix a partial ambient %s with a different file source",
    async (key) => {
      const f = await fixture();
      expect(() => createProductionSessionEndRecorder({ ...f.environment, [key]: f.coordinates[key] }))
        .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    },
  );

  it.each([0o644, 0o640, 0o400, 0o4600])("rejects non-0600 mode %s", async (mode) => {
    const f = await fixture();
    await chmod(f.file, mode);
    expect(() => createProductionSessionEndRecorder(f.environment))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it.each(["symlink", "hardlink", "directory", "missing"])("rejects a %s config", async (kind) => {
    const f = await fixture();
    if (kind === "hardlink") {
      await link(f.file, join(f.root, "second-link"));
    } else {
      await rm(f.file);
      if (kind === "directory") await mkdir(f.file);
      if (kind === "symlink") {
        const target = join(f.root, "real-config");
        await writeFile(target, f.text, { mode: 0o600 });
        await symlink(target, f.file);
      }
    }
    expect(() => createProductionSessionEndRecorder(f.environment))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it("rejects another owner's file", async () => {
    const f = await fixture();
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => createProductionSessionEndRecorder(f.environment))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it.each([
    ["unknown credential", "NOTION_API_KEY=private-marker\n"],
    ["duplicate", "JHW_BUILD_HOST=another-host\n"],
    ["shell expansion", "JHW_BUILD_HOST=$(touch sentinel)\n"],
    ["NUL comment", "# invalid\0comment\n"],
    ["invalid UTF-8", Buffer.from([0xff])],
    ["oversize", "#".repeat(16 * 1024)],
  ])("rejects %s without leaking bytes or creating state", async (name, suffix) => {
    const f = await fixture();
    const bytes = name === "shell expansion"
      ? Buffer.from(f.text.replace("JHW_BUILD_HOST=fixture-host\n", suffix as string))
      : Buffer.concat([Buffer.from(f.text), Buffer.from(suffix)]);
    await writeFile(f.file, bytes);
    expect(() => createProductionSessionEndRecorder(f.environment))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    const result = await runProductionHookAdapter(
      ["--adapter", "codex", "--event", "SessionEnd"],
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "fixture-session", cwd: f.root, transcript_path: null, reason: "other" }),
      f.environment,
    );
    // The core reports only a stable advisory; the public launcher renders {}.
    expect(result).toEqual({ exitCode: 0, stdout: '{"systemMessage":"GUARD_UNAVAILABLE"}\n', stderr: "" });
    expect(await readdir(f.root)).not.toContain("state");
    expect(await readdir(f.root)).not.toContain("sentinel");
  });

  it("requires the complete non-secret file contract and validates its coordinates", async () => {
    const f = await fixture();
    for (const invalid of [
      f.text.replace("JHW_REGISTRY_REMOTE=origin\n", ""),
      f.text.replace("JHW_PROJECT_NUMBER=1", "JHW_PROJECT_NUMBER=zero"),
      f.text.replace("JHW_BUILD_HOST=fixture-host", "JHW_BUILD_HOST= fixture-host"),
      f.text.replace("JHW_BUILD_HOST=fixture-host", "JHW_BUILD_HOST=\"fixture-host\""),
    ]) {
      await writeFile(f.file, invalid);
      expect(() => createProductionSessionEndRecorder(f.environment))
        .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    }
  });
});
