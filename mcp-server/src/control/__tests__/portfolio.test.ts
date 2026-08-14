import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PortfolioService, type ProjectSnapshotSource } from "../portfolio.js";
import { createSensitiveDataPolicy } from "../sensitive-data.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function item(index: number) {
  return {
    project_item_id: `PVTI_${index}`,
    source_node_id: `I_${index}`,
    project_id: `prj-project-${index}`,
    title: `Project ${index}`,
    objective: `Objective ${index}`,
    repo_ids: ["repo-control"],
    fields: {
      status: "active" as const,
      priority: "P2" as const,
      health: "on-track" as const,
      next_action: "wait:fixture",
      last_reviewed: "2026-08-13",
    },
    stale: false,
  };
}

function source(count = 23): ProjectSnapshotSource {
  return {
    project_node_id: "PVT_project",
    source_revision: "2026-08-13T00:00:00Z",
    field_definitions: [
      { id: "PVTF_status", name: "Status", data_type: "SINGLE_SELECT", options: [{ id: "status-active", name: "active" }] },
      { id: "PVTF_priority", name: "Priority", data_type: "SINGLE_SELECT", options: [{ id: "priority-P2", name: "P2" }] },
      { id: "PVTF_health", name: "Health", data_type: "SINGLE_SELECT", options: [{ id: "health-on-track", name: "on-track" }] },
      { id: "PVTF_next", name: "Next Action", data_type: "TEXT" },
      { id: "PVTF_reviewed", name: "Last Reviewed", data_type: "DATE" },
    ],
    items: Array.from({ length: count }, (_, index) => item(index + 1)),
    total_count: count,
  };
}

describe("PortfolioService", () => {
  it("rejects protected source fields before output or snapshot persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-portfolio-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const secret = "unmistakably-fake-portfolio-token";
    const protectedSource = source(1);
    protectedSource.items[0] = { ...protectedSource.items[0]!, objective: `contains ${secret}` };
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => protectedSource },
      stateDir,
      sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    });

    const statusError = await portfolio.status().catch((cause) => cause);
    expect(statusError).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(statusError)).not.toContain(secret);
    await expect(portfolio.exportSnapshot()).rejects.toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("caps portfolio markdown and CLI-safe payload at 12 KiB or 20 items and emits page IDs", async () => {
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => source() },
      stateDir: "/unused",
      now: () => new Date("2026-08-13T00:00:00Z"),
    });

    const output = await portfolio.status(undefined, undefined);

    expect(Buffer.byteLength(output.markdown)).toBeLessThanOrEqual(12 * 1024);
    expect(output.items).toHaveLength(20);
    expect(output).toMatchObject({ truncated: true, total_items: 23, next_page_id: "page-2" });
    expect(Buffer.byteLength(`${JSON.stringify({ command: "portfolio status", result: output })}\n`)).toBeLessThanOrEqual(12 * 1024);
    expect(output.items[0]).toEqual(expect.objectContaining({ project_id: "prj-project-1", project_item_id: "PVTI_1", source_node_id: "I_1" }));
  });

  it("filters by project before paging and rejects unknown page IDs", async () => {
    const portfolio = new PortfolioService({ projectClient: { readAll: async () => source() }, stateDir: "/unused" });

    const one = await portfolio.status("prj-project-21", undefined);
    expect(one.items.map((entry) => entry.project_id)).toEqual(["prj-project-21"]);
    await expect(portfolio.status(undefined, "page-99")).rejects.toMatchObject({ code: "INVALID_PAGE_ID" });
  });

  it("paginates before the serialized CLI envelope exceeds the byte cap", async () => {
    const large = source();
    large.items = large.items.map((entry) => ({ ...entry, objective: "x".repeat(1_000) }));
    const portfolio = new PortfolioService({ projectClient: { readAll: async () => large }, stateDir: "/unused" });

    const first = await portfolio.status();

    expect(first.items.length).toBeLessThan(20);
    expect(first.next_page_id).toBe("page-2");
    expect(Buffer.byteLength(`${JSON.stringify({ command: "portfolio status", result: first })}\n`)).toBeLessThanOrEqual(12 * 1024);
  });

  it("fails closed when a project source contains non-allowlisted data", async () => {
    const invalid = source(1) as ProjectSnapshotSource & { token?: string };
    invalid.token = "must-not-enter-output";
    const portfolio = new PortfolioService({ projectClient: { readAll: async () => invalid }, stateDir: "/unused" });

    await expect(portfolio.status()).rejects.toMatchObject({ code: "INVALID_PROJECT_SOURCE" });
  });

  it("writes a private deterministic snapshot and advances a relative current pointer only after validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-portfolio-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => source() },
      stateDir,
      now: () => new Date("2026-08-13T12:34:56.000Z"),
    });

    const exported = await portfolio.exportSnapshot();
    const generatedAt = "2026-08-13T12-34-56.000Z";
    const snapshotDir = join(stateDir, "snapshots", generatedAt);
    const parsed = JSON.parse(await readFile(join(snapshotDir, "portfolio.json"), "utf8"));
    const { checksum, ...withoutChecksum } = parsed;

    expect(exported).toEqual({
      jsonPath: `${generatedAt}/portfolio.json`,
      markdownPath: `${generatedAt}/portfolio.md`,
      checksum,
    });
    expect(checksum).toBe(createHash("sha256").update(JSON.stringify(withoutChecksum)).digest("hex"));
    expect(await readFile(join(stateDir, "snapshots", "current"), "utf8")).toBe(`${generatedAt}\n`);
    expect((await lstat(snapshotDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(snapshotDir, "portfolio.json"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(snapshotDir, "portfolio.md"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(snapshotDir, "portfolio.page-2.md"))).isFile()).toBe(true);
    expect(await readFile(join(snapshotDir, "portfolio.md"), "utf8")).toContain("Next Page: page-2");
    expect(parsed).toMatchObject({ schema_version: 1, total_count: 23, project_node_id: "PVT_project" });
  });

  it("atomically replaces a symbolic current pointer without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-portfolio-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const snapshots = join(stateDir, "snapshots");
    const external = join(root, "external-current");
    await mkdir(snapshots, { recursive: true });
    await writeFile(external, "outside\n", "utf8");
    await symlink(external, join(snapshots, "current"));
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => source(1) },
      stateDir,
      now: () => new Date("2026-08-13T12:34:56.000Z"),
    });

    await expect(portfolio.exportSnapshot()).resolves.toMatchObject({ checksum: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await readFile(external, "utf8")).toBe("outside\n");
    expect((await lstat(join(snapshots, "current"))).isFile()).toBe(true);
    expect(await readFile(join(snapshots, "current"), "utf8")).toBe("2026-08-13T12-34-56.000Z\n");
  });

  it("reopens actual artifacts and refuses promotion after portfolio JSON is tampered", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-portfolio-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => source(1) },
      stateDir,
      now: () => new Date("2026-08-13T12:34:56.000Z"),
      beforeSnapshotValidation: async (snapshotDirectory) => {
        await writeFile(join(snapshotDirectory, "portfolio.json"), "{}\n", "utf8");
      },
    });

    await expect(portfolio.exportSnapshot()).rejects.toMatchObject({ code: "SNAPSHOT_VALIDATION_FAILED" });
    await expect(lstat(join(stateDir, "snapshots", "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recomputes the checksum from the actual on-disk portfolio JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-portfolio-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => source(1) },
      stateDir,
      now: () => new Date("2026-08-13T12:34:56.000Z"),
      beforeSnapshotValidation: async (snapshotDirectory) => {
        const path = join(snapshotDirectory, "portfolio.json");
        const payload = JSON.parse(await readFile(path, "utf8")) as { items: Array<{ objective: string }> };
        payload.items[0]!.objective = "tampered after write";
        await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");
      },
    });

    await expect(portfolio.exportSnapshot()).rejects.toMatchObject({ code: "SNAPSHOT_VALIDATION_FAILED" });
    await expect(lstat(join(stateDir, "snapshots", "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reopens and verifies actual on-disk Markdown page content", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-portfolio-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => source(1) },
      stateDir,
      now: () => new Date("2026-08-13T12:34:56.000Z"),
      beforeSnapshotValidation: async (snapshotDirectory) => {
        await writeFile(join(snapshotDirectory, "portfolio.md"), "tampered after write\n", "utf8");
      },
    });

    await expect(portfolio.exportSnapshot()).rejects.toMatchObject({ code: "SNAPSHOT_VALIDATION_FAILED" });
    await expect(lstat(join(stateDir, "snapshots", "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies the exact on-disk page set and content before current promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-portfolio-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const portfolio = new PortfolioService({
      projectClient: { readAll: async () => source(23) },
      stateDir,
      now: () => new Date("2026-08-13T12:34:56.000Z"),
      beforeSnapshotValidation: async (snapshotDirectory) => {
        await writeFile(join(snapshotDirectory, "portfolio.page-3.md"), "unexpected\n", "utf8");
      },
    });

    await expect(portfolio.exportSnapshot()).rejects.toMatchObject({ code: "SNAPSHOT_VALIDATION_FAILED" });
    await expect(lstat(join(stateDir, "snapshots", "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
