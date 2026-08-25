import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GuardJournal,
  GuardJournalEventSchema,
  type GuardJournalEvent,
} from "../guard-journal.js";
import { createSensitiveDataPolicy } from "../sensitive-data.js";

const roots: string[] = [];
const SECRET = "unmistakably-fake-guard-journal-token";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(overrides: Partial<GuardJournalEvent> = {}): GuardJournalEvent {
  return {
    protocol_version: 1,
    origin_adapter: "codex",
    evaluation_stage: "hook",
    event: "requested",
    task_id: "tsk-018f21e0-7b2c-7a00-8000-000000000001",
    claim_id: "clm-018f21e0-7b2c-7a00-8000-000000000002",
    session_id: "codex-task-scope-guard",
    request_id: "req-018f21e0-7b2c-7a00-8000-000000000003",
    operation_digest: "1".repeat(64),
    requirements: [{
      capability: "repo.modify",
      resource: { kind: "repository", id: "repo-jhw-notion" },
    }],
    occurred_at: "2026-08-25T01:00:00.000Z",
    requested_at: "2026-08-25T01:00:00.000Z",
    approval_expires_at: "2026-08-25T01:10:00.000Z",
    ...overrides,
  };
}

describe("GuardJournal", () => {
  it.each(["decision", "requested", "approved", "consumed", "completed", "failed", "expired"] as const)(
    "accepts the closed %s event vocabulary",
    (name) => {
      expect(GuardJournalEventSchema.safeParse(event({ event: name })).success).toBe(true);
    },
  );

  it("rejects unknown fields, events, decision codes, and unregistered reasons", () => {
    expect(GuardJournalEventSchema.safeParse({ ...event(), raw_command: "git push origin HEAD" }).success).toBe(false);
    expect(GuardJournalEventSchema.safeParse({ ...event(), event: "retried" }).success).toBe(false);
    expect(GuardJournalEventSchema.safeParse({ ...event(), decision_code: "INVENTED" }).success).toBe(false);
    expect(GuardJournalEventSchema.safeParse({ ...event(), error_reason: "invented_reason" }).success).toBe(false);
  });

  it("rejects noncanonical or duplicate requirement lists", () => {
    const commitRequirement = {
      capability: "git.commit" as const,
      resource: { kind: "repository" as const, id: "repo-jhw-notion" },
    };
    const modifyRequirement = {
      capability: "repo.modify" as const,
      resource: { kind: "repository" as const, id: "repo-jhw-notion" },
    };

    expect(GuardJournalEventSchema.safeParse(event({
      requirements: [modifyRequirement, commitRequirement],
    })).success).toBe(false);
    expect(GuardJournalEventSchema.safeParse(event({
      requirements: [commitRequirement, commitRequirement],
    })).success).toBe(false);
  });

  it("writes only the validated bounded row through the hardened append", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const journal = new GuardJournal(stateDir);

    await journal.append(event());

    const path = join(stateDir, "guard-journal.jsonl");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(event());
  });

  it.each([
    ["raw command", { raw_command: "git push origin HEAD" }],
    ["raw prompt", { prompt: "/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000003" }],
    ["script", { script: "#!/bin/sh\nprintenv" }],
    ["environment", { environment: { FAKE_API_TOKEN: SECRET } }],
    ["absolute cwd", { cwd: "/srv/private/worktree" }],
  ])("rejects %s fields before opening the journal", async (_label, forbidden) => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const journal = new GuardJournal(
      stateDir,
      {},
      createSensitiveDataPolicy({ FAKE_API_TOKEN: SECRET }, ["/srv/private/worktree"]),
    );

    await expect(journal.append({ ...event(), ...forbidden } as GuardJournalEvent))
      .rejects.toMatchObject({ code: "GUARD_JOURNAL_UNAVAILABLE" });
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an absolute path hidden in an otherwise bounded coordinate", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");

    await expect(new GuardJournal(stateDir).append(event({ session_id: "session /srv/private/worktree" })))
      .rejects.toMatchObject({ code: "GUARD_JOURNAL_UNAVAILABLE" });
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inherits symlink and one-link protection from the shared journal append", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-journal-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const external = join(root, "external-journal");
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(external, "outside\n", { mode: 0o600 });
    await symlink(external, join(stateDir, "guard-journal.jsonl"));

    await expect(new GuardJournal(stateDir).append(event())).rejects.toMatchObject({
      code: "GUARD_JOURNAL_UNAVAILABLE",
    });
    expect(await readFile(external, "utf8")).toBe("outside\n");

    await unlinkForRetry(join(stateDir, "guard-journal.jsonl"));
    await link(external, join(stateDir, "guard-journal.jsonl"));
    await expect(new GuardJournal(stateDir).append(event())).rejects.toMatchObject({
      code: "GUARD_JOURNAL_UNAVAILABLE",
    });
    expect(await readFile(external, "utf8")).toBe("outside\n");
  });
});

async function unlinkForRetry(path: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  await unlink(path);
}
