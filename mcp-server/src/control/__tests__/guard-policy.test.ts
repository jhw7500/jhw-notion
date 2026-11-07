import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadControlConfig } from "../config.js";
import { resolveGuardEnvironment } from "../guard-policy.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(withPolicy = true) {
  const home = await mkdtemp(join(tmpdir(), "jhw-guard-policy-"));
  roots.push(home);
  const directory = join(home, ".config/jhw-control");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const coordinates = {
    JHW_REGISTRY_DIR: join(home, "registry"), JHW_REGISTRY_REMOTE: "origin",
    JHW_REGISTRY_BRANCH: "main", JHW_WORKTREE_ROOT: join(home, "worktrees"),
    JHW_CONTROL_STATE_DIR: join(home, "state"), JHW_BUILD_HOST: "fixture-host",
    JHW_GITHUB_OWNER: "fixture-owner", JHW_PROJECT_NUMBER: "1",
    JHW_REGISTRY_REPOSITORY: "fixture-owner/registry",
    JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_fixture", JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
  };
  const file = join(directory, "control.env");
  const bytes = Object.entries(coordinates).map(([key, value]) => `${key}=${value}\n`).join("");
  await writeFile(file, bytes, { mode: 0o600 });
  const policy = join(directory, "guard-policy.json");
  if (withPolicy) await writeFile(policy, '{"version":1,"mode":"observe"}\n', { mode: 0o600 });
  return { home, directory, file, bytes, policy, coordinates, environment: { HOME: home } };
}

describe("Guard private observe policy", () => {
  it("resolves all file coordinates for a no-env Guard and leaves ordinary CLI env-only", async () => {
    // Break caught: a fresh TUI still fails every Guard call without JHW_* env.
    const f = await fixture();
    const before = await readdir(f.home);
    const result = resolveGuardEnvironment(f.environment);
    expect(result.source).toBe("private-policy");
    expect(result.mode).toBe("observe");
    expect(result.environment).toMatchObject({
      ...f.coordinates, JHW_GUARD_MODE: "observe", JHW_GUARD_ALLOW_OBSERVE: "true",
    });
    expect(loadControlConfig(result.environment)).toMatchObject({ buildHost: "fixture-host", guardMode: "observe" });
    expect(() => loadControlConfig(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(f.environment).toEqual({ HOME: f.home });
    expect(await readdir(f.home)).toEqual(before);
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  });

  it("does not opt in merely because a private control.env exists", async () => {
    const f = await fixture(false);
    expect(() => resolveGuardEnvironment(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(await readdir(f.directory)).toEqual(["control.env"]);
  });

  it("uses a complete ambient source without reading an unused coordinate file", async () => {
    const f = await fixture();
    await rm(f.file);
    await symlink(join(f.home, "absent"), f.file);
    const result = resolveGuardEnvironment({ ...f.environment, ...f.coordinates });
    expect(result.mode).toBe("observe");
    expect(loadControlConfig(result.environment).registryDir).toBe(f.coordinates.JHW_REGISTRY_DIR);
  });

  it("preserves the existing env-only enforce mode when no private policy is installed", async () => {
    const f = await fixture(false);
    const result = resolveGuardEnvironment({ ...f.environment, ...f.coordinates });
    expect(result.source).toBe("environment");
    expect(result.mode).toBe("enforce");
  });

  it.each([".config", ".config/jhw-control"])("keeps env-only enforcement when absent policy has a writable %s parent", async (component) => {
    const f = await fixture(false);
    await chmod(join(f.home, component), 0o775);
    const before = await readdir(f.directory);
    const result = resolveGuardEnvironment({ ...f.environment, ...f.coordinates });
    expect(result.source).toBe("environment");
    expect(result.mode).toBe("enforce");
    expect(await readdir(f.directory)).toEqual(before);
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  });

  it.each(["JHW_REGISTRY_DIR", "JHW_REGISTRY_REMOTE", "JHW_CONTROL_STATE_DIR"] as const)(
    "does not repair partial ambient %s with file coordinates", async (key) => {
      const f = await fixture();
      expect(() => resolveGuardEnvironment({ ...f.environment, [key]: f.coordinates[key] }))
        .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    },
  );

  it("rejects an explicit enforce env that conflicts with the host observe policy", async () => {
    const f = await fixture();
    expect(() => resolveGuardEnvironment({ ...f.environment, ...f.coordinates, JHW_GUARD_MODE: "enforce" }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it("accepts whitespace and property order without permitting duplicate keys", async () => {
    const f = await fixture();
    await writeFile(f.policy, '{\n  "mode": "observe",\n  "version": 1\n}\n');
    expect(resolveGuardEnvironment(f.environment).mode).toBe("observe");
  });

  it.each([
    '{"version":1,"mode":"observe","mode":"observe"}',
    '{"version":1,"version":1,"mode":"observe"}',
    '{"version":1,"mode":"observe","m\\u006fde":"observe"}',
    '{"version":1,"mode":"enforce"}',
    '{"version":2,"mode":"observe"}',
    '{"version":1,"mode":"observe","NOTION_API_KEY":"fake-secret"}',
    '[{"version":1,"mode":"observe"}]',
  ])("rejects an unsupported or ambiguous policy without exposing its contents: %s", async (bytes) => {
    const f = await fixture();
    await writeFile(f.policy, bytes);
    try {
      resolveGuardEnvironment(f.environment);
      expect.fail("unsafe policy was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_CONFIG" });
      expect(String(error)).not.toContain(f.home);
      expect(String(error)).not.toContain("fake-secret");
    }
  });

  it.each([0o644, 0o640, 0o400, 0o4600])("rejects policy mode %s", async (mode) => {
    const f = await fixture();
    await chmod(f.policy, mode);
    expect(() => resolveGuardEnvironment(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it.each(["symlink", "hardlink", "directory"])("rejects a policy %s", async (kind) => {
    const f = await fixture();
    const original = join(f.home, "preserved-policy");
    await rename(f.policy, original);
    if (kind === "symlink") await symlink(original, f.policy);
    else if (kind === "hardlink") await link(original, f.policy);
    else await mkdir(f.policy);
    expect(() => resolveGuardEnvironment(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(await readFile(original, "utf8")).toBe('{"version":1,"mode":"observe"}\n');
  });

  it.each([".config", ".config/jhw-control"])("rejects redirected %s parents", async (component) => {
    const f = await fixture();
    const from = join(f.home, component);
    const to = join(f.home, "relocated");
    await rename(from, to);
    await symlink(to, from);
    expect(() => resolveGuardEnvironment(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it.each([".config", ".config/jhw-control"])("rejects writable %s policy parents", async (component) => {
    const f = await fixture();
    await chmod(join(f.home, component), 0o775);
    expect(() => resolveGuardEnvironment(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it.each([Buffer.from([0xff]), Buffer.alloc(4097, 0x20)])("rejects invalid UTF-8 or an oversized policy", async (bytes) => {
    const f = await fixture();
    await writeFile(f.policy, bytes);
    expect(() => resolveGuardEnvironment(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it.each(["JHW_BUILD_HOST=$(touch unsafe)", "NOTION_API_KEY=fake-secret", "JHW_BUILD_HOST=other-host"])(
    "rejects shell, credential, or duplicate coordinate data: %s", async (line) => {
      const f = await fixture();
      await writeFile(f.file, f.bytes + line + "\n");
      expect(() => resolveGuardEnvironment(f.environment)).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
      expect(await readdir(f.home)).not.toContain("unsafe");
    },
  );
});
