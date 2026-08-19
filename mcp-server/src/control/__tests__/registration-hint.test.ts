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

const other = {
  project_id: "prj-other",
  item_id: "PVTI_other",
  source_node_id: "DI_other",
};

describe("RegistrationHintStore", () => {
  it("reports nothing for a state directory that has never been written", async () => {
    await expect(new RegistrationHintStore(await stateDir()).read("prj-example")).resolves.toBeUndefined();
  });

  it("round-trips one hint", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await store.record(hint);

    await expect(store.read("prj-example")).resolves.toEqual(hint);
    await expect(store.read("prj-missing")).resolves.toBeUndefined();
  });

  // The entry outlives the registration that wrote it: what it answers is
  // "where is this record", which stays true long after that run finished.
  it("keeps an entry across later registrations of other projects", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await store.record(hint);
    await store.record(other);

    await expect(store.read("prj-example")).resolves.toEqual(hint);
    await expect(store.read("prj-other")).resolves.toEqual(other);
  });

  it("replaces the coordinates recorded for a project it already tracks", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await store.record(hint);
    await store.record({ ...hint, item_id: "PVTI_recreated", source_node_id: "DI_recreated" });

    await expect(store.read("prj-example")).resolves.toEqual({
      project_id: "prj-example",
      item_id: "PVTI_recreated",
      source_node_id: "DI_recreated",
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

  // Failing the read is what keeps a damaged file from being read as "no record
  // was created here"; the caller then waits exactly as it would have without.
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

  it("rejects an unbounded or incomplete coordinate rather than persisting it", async () => {
    const store = new RegistrationHintStore(await stateDir());

    await expect(store.record({ ...hint, project_id: "x".repeat(257) }))
      .rejects.toMatchObject({ code: "INVALID_REGISTRATION_HINT" });
    await expect(store.record({ project_id: "prj-example" } as never))
      .rejects.toMatchObject({ code: "INVALID_REGISTRATION_HINT" });
  });

  it("refuses to track more projects than its ceiling", async () => {
    const directory = await stateDir();
    const store = new RegistrationHintStore(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const records = Object.fromEntries(
      Array.from({ length: 256 }, (_unused, index) => [
        `prj-${index}`,
        { project_id: `prj-${index}`, item_id: `PVTI_${index}`, source_node_id: `DI_${index}` },
      ]),
    );
    await writeFile(
      join(directory, "project-registrations.json"),
      `${JSON.stringify({ version: 1, records })}\n`,
      "utf8",
    );

    // Refusing costs a later retry its shortcut, never a registration.
    await expect(store.record(hint)).rejects.toMatchObject({ code: "INVALID_REGISTRATION_HINT_STATE" });
    // Re-recording a project already tracked stays within the bound.
    await expect(store.record({ project_id: "prj-0", item_id: "PVTI_0", source_node_id: "DI_0" }))
      .resolves.toBeUndefined();
  });

  it("writes deterministic JSON that another reader can parse", async () => {
    const directory = await stateDir();

    await new RegistrationHintStore(directory).record(hint);

    const raw = await readFile(join(directory, "project-registrations.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ version: 1, records: { "prj-example": hint } });
  });
});
