import { expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryRecordSchema } from "../schemas.js";
import { readRecord, writeRecord } from "../codec.js";

it("round-trips deterministic JSON-subset YAML with a trailing newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "jhw-codec-"));
  const file = join(root, "repositories", "repo-a.yaml");
  const value = { id: "repo-a", github_node_id: "R_1", slug: "jhw/a" };
  await writeRecord(file, value);
  expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
  expect(await readRecord(file, RepositoryRecordSchema)).toEqual(value);
});
