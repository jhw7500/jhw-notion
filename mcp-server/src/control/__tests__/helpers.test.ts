import { afterEach, describe, expect, it } from "vitest";

import { commitFile, configFor, git, makeRegistryFixture } from "./helpers.js";

const fixtures: Awaited<ReturnType<typeof makeRegistryFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("control test helpers", () => {
  it("creates two clones of a bare registry remote with deterministic commit identity", async () => {
    const fixture = await makeRegistryFixture();
    fixtures.push(fixture);

    await commitFile(fixture.registryDir, "registry.json", '{"version":1}\n');
    await git(fixture.registryDir, "push", "origin", "main");
    await git(fixture.otherCloneDir, "pull", "--ff-only");

    expect(await git(fixture.otherCloneDir, "show", "HEAD:registry.json")).toBe('{"version":1}\n');
    expect((await git(fixture.registryDir, "log", "-1", "--format=%an <%ae>")).trim()).toBe(
      "Phase1A Test <phase1a@example.invalid>",
    );
    expect(configFor(fixture.registryDir).registryDir).toBe(fixture.registryDir);
  });
});
