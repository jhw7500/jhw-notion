import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAuthorityService, createDefaultAuthorityService, loadAuthorityPolicy } from "../authority.js";
import type { AuthorityRecord } from "../schemas.js";

const roots: string[] = [];

async function temporaryCache(): Promise<{ root: string; cachePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "jhw-authority-"));
  roots.push(root);
  return { root, cachePath: join(root, "authority-cache.json") };
}

function authority(authority_epoch: number, mode: "legacy" | "registry"): AuthorityRecord {
  return {
    authority_epoch,
    mode,
    cutover_at: mode === "registry" ? "2026-08-20T00:00:00Z" : null,
    minimum_tool_version: mode === "registry" ? "1.1.0" : "1.0.0",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Notion authority service", () => {
  it("allows legacy mode but rejects Projects and Decision writes in registry mode", async () => {
    const { cachePath } = await temporaryCache();
    let central = authority(1, "legacy");
    const service = createAuthorityService({ readCentral: async () => central, cachePath, writesDisabled: false });

    await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).resolves.toBeUndefined();
    central = authority(2, "registry");
    await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "AUTHORITY_MOVED",
    });
    await expect(service.assertNotionWriteAllowed("decisionLog", "jhw_record")).rejects.toMatchObject({
      code: "AUTHORITY_MOVED",
    });
    await expect(service.assertNotionWriteAllowed("knowledgeBase", "jhw_record")).resolves.toBeUndefined();
  });

  it("rejects a lower central epoch and fails closed when cached registry authority is unavailable", async () => {
    const { cachePath } = await temporaryCache();
    await writeFile(cachePath, JSON.stringify({ authority_epoch: 4, mode: "registry" }));
    let central: AuthorityRecord | null = authority(3, "legacy");
    const service = createAuthorityService({ readCentral: async () => central, cachePath, writesDisabled: false });

    await expect(service.load()).rejects.toMatchObject({ code: "AUTHORITY_EPOCH_ROLLBACK" });
    central = null;
    await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
  });

  it("fails closed when a previously observed central authority becomes unavailable before cutover", async () => {
    const { cachePath } = await temporaryCache();
    await writeFile(cachePath, JSON.stringify({ authority_epoch: 3, mode: "legacy" }));
    const service = createAuthorityService({ readCentral: async () => null, cachePath, writesDisabled: false });

    await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
  });

  it("keeps explicitly allowed Notion databases available during a central outage", async () => {
    const { cachePath } = await temporaryCache();
    await writeFile(cachePath, JSON.stringify({ authority_epoch: 4, mode: "registry" }));
    const service = createAuthorityService({ readCentral: async () => null, cachePath, writesDisabled: false });

    await expect(service.assertNotionWriteAllowed("knowledgeBase", "jhw_record")).resolves.toBeUndefined();
    await expect(service.assertNotionWriteAllowed("preferences", "jhw_record")).resolves.toBeUndefined();
    await expect(service.assertNotionWriteAllowed("references", "jhw_record")).resolves.toBeUndefined();
  });

  it("allows the same epoch to advance from legacy to registry but never reverse it", async () => {
    const { cachePath } = await temporaryCache();
    await writeFile(cachePath, JSON.stringify({ authority_epoch: 3, mode: "legacy" }));
    const service = createAuthorityService({
      readCentral: async () => authority(3, "registry"),
      cachePath,
      writesDisabled: false,
    });

    await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "AUTHORITY_MOVED",
    });
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ authority_epoch: 3, mode: "registry" });
  });

  it("permits backward-compatible legacy writes only before any central record or cache exists", async () => {
    const { cachePath } = await temporaryCache();
    const service = createAuthorityService({ readCentral: async () => null, cachePath, writesDisabled: false });

    await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).resolves.toBeUndefined();
    await expect(readFile(cachePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never treats a higher legacy epoch as a reverse cutover after registry was observed", async () => {
    const { cachePath } = await temporaryCache();
    await writeFile(cachePath, JSON.stringify({ authority_epoch: 4, mode: "registry" }));
    const service = createAuthorityService({
      readCentral: async () => authority(5, "legacy"),
      cachePath,
      writesDisabled: false,
    });

    await expect(service.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "AUTHORITY_EPOCH_ROLLBACK",
    });
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ authority_epoch: 4, mode: "registry" });
  });

  it("serializes observations so a delayed stale caller cannot overwrite a newer epoch", async () => {
    const { cachePath } = await temporaryCache();
    let staleReadStarted!: () => void;
    let releaseStale!: () => void;
    const started = new Promise<void>((resolve) => { staleReadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseStale = resolve; });
    const stale = createAuthorityService({
      cachePath,
      writesDisabled: false,
      readCentral: async () => {
        staleReadStarted();
        await release;
        return authority(1, "legacy");
      },
    });
    const fresh = createAuthorityService({
      cachePath,
      writesDisabled: false,
      readCentral: async () => authority(2, "registry"),
    });

    const staleLoad = stale.load();
    await started;
    const freshLoad = fresh.load();
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseStale();
    await Promise.all([staleLoad, freshLoad]);

    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ authority_epoch: 2, mode: "registry" });
  });

  it("keeps the cache write on the descriptor-anchored state directory after an ancestor swap", async () => {
    const { root } = await temporaryCache();
    const originalParent = join(root, "original-parent");
    const stateDir = join(originalParent, "state");
    const cachePath = join(stateDir, "authority-cache.json");
    const movedParent = join(root, "moved-parent");
    const externalState = join(root, "external-state");
    await mkdir(stateDir, { recursive: true });
    await mkdir(externalState);
    const service = createAuthorityService({
      cachePath,
      writesDisabled: false,
      readCentral: async () => {
        await rename(originalParent, movedParent);
        await mkdir(originalParent);
        await rename(externalState, stateDir);
        return authority(2, "registry");
      },
    });

    await expect(service.load()).resolves.toMatchObject({ authority_epoch: 2, mode: "registry" });
    expect(JSON.parse(await readFile(join(movedParent, "state", "authority-cache.json"), "utf8"))).toEqual({
      authority_epoch: 2,
      mode: "registry",
    });
    await expect(readFile(cachePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symbolic cache without reading or replacing its target", async () => {
    const { root, cachePath } = await temporaryCache();
    const external = join(root, "external.json");
    await writeFile(external, JSON.stringify({ authority_epoch: 8, mode: "legacy" }));
    await symlink(external, cachePath);
    const service = createAuthorityService({
      readCentral: async () => authority(9, "registry"),
      cachePath,
      writesDisabled: false,
    });

    await expect(service.load()).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    expect(JSON.parse(await readFile(external, "utf8"))).toEqual({ authority_epoch: 8, mode: "legacy" });
  });

  it("rejects a hard-linked cache without mutating the other link", async () => {
    const { root, cachePath } = await temporaryCache();
    const external = join(root, "external-hardlink.json");
    await writeFile(external, JSON.stringify({ authority_epoch: 8, mode: "legacy" }));
    const { link } = await import("node:fs/promises");
    await link(external, cachePath);
    const service = createAuthorityService({
      readCentral: async () => authority(9, "registry"),
      cachePath,
      writesDisabled: false,
    });

    await expect(service.load()).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    expect(JSON.parse(await readFile(external, "utf8"))).toEqual({ authority_epoch: 8, mode: "legacy" });
  });

  it("rejects a hard-linked lock without chmodding the other link", async () => {
    const { root, cachePath } = await temporaryCache();
    const external = join(root, "external-lock");
    await writeFile(external, "outside");
    await chmod(external, 0o644);
    const { link } = await import("node:fs/promises");
    await link(external, join(root, "authority-cache.lock"));
    const service = createAuthorityService({
      readCentral: async () => authority(9, "registry"),
      cachePath,
      writesDisabled: false,
    });

    await expect(service.load()).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    expect((await lstat(external)).mode & 0o777).toBe(0o644);
    expect(await readFile(external, "utf8")).toBe("outside");
  });

  it("emits stable structured routing text and lets local configuration only disable more writes", async () => {
    const { cachePath } = await temporaryCache();
    const registry = createAuthorityService({
      readCentral: async () => authority(1, "registry"),
      cachePath,
      writesDisabled: false,
    });

    const moved = await registry.assertNotionWriteAllowed("projects", "jhw_start").catch((error: unknown) => error);
    expect(moved).toMatchObject({ code: "AUTHORITY_MOVED" });
    expect(JSON.parse((moved as Error).message)).toMatchObject({
      code: "AUTHORITY_MOVED",
      operation: "jhw_start",
      route: expect.stringContaining("jhw-control project register"),
    });

    const disabled = createAuthorityService({
      readCentral: async () => authority(2, "legacy"),
      cachePath: join((await temporaryCache()).root, "authority-cache.json"),
      writesDisabled: true,
    });
    await expect(disabled.assertNotionWriteAllowed("knowledgeBase", "jhw_record")).rejects.toMatchObject({
      code: "NOTION_WRITES_DISABLED",
    });
  });

  it("observes registry authority even while local writes are disabled", async () => {
    const { cachePath } = await temporaryCache();
    const disabled = createAuthorityService({
      readCentral: async () => authority(4, "registry"),
      cachePath,
      writesDisabled: true,
    });

    await expect(disabled.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "NOTION_WRITES_DISABLED",
    });
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ authority_epoch: 4, mode: "registry" });

    const staleAfterFreeze = createAuthorityService({
      readCentral: async () => authority(3, "legacy"),
      cachePath,
      writesDisabled: false,
    });
    await expect(staleAfterFreeze.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "AUTHORITY_EPOCH_ROLLBACK",
    });
  });

  it("preserves fail-closed authority errors ahead of the local kill-switch", async () => {
    const { cachePath } = await temporaryCache();
    await writeFile(cachePath, JSON.stringify({ authority_epoch: 5, mode: "registry" }));
    const disabledDuringOutage = createAuthorityService({
      readCentral: async () => null,
      cachePath,
      writesDisabled: true,
    });

    await expect(disabledDuringOutage.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
  });

  it("treats writes-disabled as an exact opt-in rather than accepting truthy variants", async () => {
    const { root } = await temporaryCache();
    await expect(createDefaultAuthorityService({
      HOME: root,
      JHW_CONTROL_STATE_DIR: join(root, "state"),
      JHW_NOTION_WRITES_DISABLED: "TRUE",
    }).assertNotionWriteAllowed("knowledgeBase", "jhw_record")).resolves.toBeUndefined();
  });

  it("reads JSON-subset authority.yaml without creating or chmodding Registry content", async () => {
    const { root } = await temporaryCache();
    const registryDir = join(root, "registry");
    const governanceDir = join(registryDir, "governance");
    const stateDir = join(root, "state");
    await mkdir(governanceDir, { recursive: true });
    await chmod(governanceDir, 0o755);
    await writeFile(join(governanceDir, "authority.yaml"), `${JSON.stringify(authority(7, "registry"), null, 2)}\n`);

    await expect(loadAuthorityPolicy({
      HOME: root,
      JHW_REGISTRY_DIR: registryDir,
      JHW_CONTROL_STATE_DIR: stateDir,
    })).resolves.toMatchObject({ authority_epoch: 7, mode: "registry" });

    expect((await lstat(governanceDir)).mode & 0o777).toBe(0o755);
    expect(JSON.parse(await readFile(join(stateDir, "authority-cache.json"), "utf8"))).toEqual({
      authority_epoch: 7,
      mode: "registry",
    });
  });

  it("fails closed on malformed or symbolic central authority records without exposing their contents", async () => {
    const { root } = await temporaryCache();
    const registryDir = join(root, "registry");
    const governanceDir = join(registryDir, "governance");
    await mkdir(governanceDir, { recursive: true });
    const authorityPath = join(governanceDir, "authority.yaml");
    await writeFile(authorityPath, "not-json: true\n");
    const malformed = createDefaultAuthorityService({
      HOME: root,
      JHW_REGISTRY_DIR: registryDir,
      JHW_CONTROL_STATE_DIR: join(root, "malformed-state"),
    });

    const malformedError = await malformed.assertNotionWriteAllowed("projects", "jhw_start").catch((error) => error);
    expect(malformedError).toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    expect((malformedError as Error).message).not.toContain("not-json");

    await rm(authorityPath);
    const external = join(root, "external-authority.json");
    await writeFile(external, JSON.stringify(authority(9, "legacy")));
    await symlink(external, authorityPath);
    const symbolic = createDefaultAuthorityService({
      HOME: root,
      JHW_REGISTRY_DIR: registryDir,
      JHW_CONTROL_STATE_DIR: join(root, "symbolic-state"),
    });
    await expect(symbolic.assertNotionWriteAllowed("projects", "jhw_start")).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
  });
});
