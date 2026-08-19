import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RegistrationHintStore } from "../registration-hint.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jhw-registration-hint-"));
  roots.push(root);
  return join(root, "state");
}

const hint = {
  project_id: "prj-example",
  item_id: "PVTI_created",
  source_node_id: "DI_created",
};

describe("RegistrationHintStore", () => {
  // "no entry" only means "this host created nothing" once the store exists.
  // Before that it cannot speak for records that predate it.
  it("reports an unwritten store as uninitialized rather than empty", async () => {
    await expect(new RegistrationHintStore(await stateDir()).read("prj-example"))
      .resolves.toEqual({ initialized: false });
  });

  it("separates a project it has never seen from a store it has never written", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await store.record({ project_id: "prj-other" });

    await expect(store.read("prj-example")).resolves.toEqual({ initialized: true });
  });

  it("round-trips one hint", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await store.record(hint);

    await expect(store.read("prj-example")).resolves.toEqual({ initialized: true, hint });
  });

  it("keeps an intent that has no coordinates yet distinguishable from no intent", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await store.record({ project_id: "prj-example" });

    await expect(store.read("prj-example")).resolves.toEqual({
      initialized: true,
      hint: { project_id: "prj-example" },
    });
  });

  it("upgrades an intent to coordinates without disturbing another project", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await store.record({ project_id: "prj-other" });
    await store.record({ project_id: "prj-example" });
    await store.record(hint);

    await expect(store.read("prj-example")).resolves.toEqual({ initialized: true, hint });
    await expect(store.read("prj-other")).resolves.toEqual({
      initialized: true,
      hint: { project_id: "prj-other" },
    });
  });

  it("publishes a private state file and leaves no temporary behind", async () => {
    const directory = await stateDir();

    await new RegistrationHintStore(directory).record(hint);

    const published = await lstat(join(directory, "project-registrations.json"));
    expect(published.isFile()).toBe(true);
    expect(published.mode & 0o777).toBe(0o600);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual(["project-registrations.json"]);
  });

  it("removes its temporary file when publishing fails", async () => {
    const directory = await stateDir();
    const store = new RegistrationHintStore(directory, {
      afterPublish: () => { throw new Error("publish interrupted"); },
    });

    await expect(store.record(hint)).rejects.toThrow("publish interrupted");
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // A hint is only ever a shortcut, so its reader has to be able to tell "no
  // registration is in flight" from "this store cannot answer".
  it("fails the read instead of reporting absence when the state is unparseable", async () => {
    const directory = await stateDir();
    const store = new RegistrationHintStore(directory);
    await store.record(hint);
    await writeFile(join(directory, "project-registrations.json"), "{not json", "utf8");

    await expect(store.read("prj-example")).rejects.toMatchObject({ code: "INVALID_REGISTRATION_HINT_STATE" });
  });

  it("fails the read when a hint is filed under another Project ID", async () => {
    const directory = await stateDir();
    const store = new RegistrationHintStore(directory);
    await store.record(hint);
    await writeFile(
      join(directory, "project-registrations.json"),
      `${JSON.stringify({ version: 1, records: { "prj-example": { ...hint, project_id: "prj-other" } } })}\n`,
      "utf8",
    );

    await expect(store.read("prj-example")).rejects.toMatchObject({ code: "INVALID_REGISTRATION_HINT_STATE" });
  });

  it("refuses a state file that is not a private regular file", async () => {
    const directory = await stateDir();
    const store = new RegistrationHintStore(directory);
    await store.record(hint);
    const statePath = join(directory, "project-registrations.json");
    await rm(statePath);
    await symlink(join(directory, "elsewhere.json"), statePath);

    await expect(store.read("prj-example")).rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });
  });

  it("refuses a relative state directory", async () => {
    await expect(new RegistrationHintStore("relative/state").read("prj-example"))
      .rejects.toMatchObject({ code: "UNSAFE_STATE_PATH" });
  });

  it("rejects an unbounded coordinate rather than persisting it", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await expect(store.record({ project_id: "x".repeat(257) }))
      .rejects.toMatchObject({ code: "INVALID_REGISTRATION_HINT" });
  });

  it("refuses to track more projects than its ceiling", async () => {
    const directory = await stateDir();
    const store = new RegistrationHintStore(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const records = Object.fromEntries(
      Array.from({ length: 256 }, (_unused, index) => [`prj-${index}`, { project_id: `prj-${index}` }]),
    );
    await writeFile(
      join(directory, "project-registrations.json"),
      `${JSON.stringify({ version: 1, records })}\n`,
      "utf8",
    );

    // Refusing costs the next registration its absence window, never its record.
    await expect(store.record(hint)).rejects.toMatchObject({ code: "INVALID_REGISTRATION_HINT_STATE" });
    // Re-recording a project already tracked stays within the bound.
    await expect(store.record({ project_id: "prj-0", item_id: "PVTI_0" })).resolves.toBeUndefined();
  });

  // A settled registration keeps its entry: dropping it would make "no entry"
  // mean both "never created" and "created and verified".
  it("keeps a settled entry so a later registration can still resolve it", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await store.record({ project_id: "prj-example" });
    await store.record(hint);

    await expect(store.read("prj-example")).resolves.toEqual({ initialized: true, hint });
  });

  it("writes deterministic JSON that another reader can parse", async () => {
    const directory = await stateDir();

    await new RegistrationHintStore(directory).record(hint);

    const raw = await readFile(join(directory, "project-registrations.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ version: 1, records: { "prj-example": hint } });
  });
});
