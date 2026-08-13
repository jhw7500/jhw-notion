import { describe, expect, it, vi } from "vitest";

import { NOTION_CONFIG } from "../../config.js";
import { DATABASE_SCHEMAS } from "../../schema.js";
import { assertTargetWriteAllowed, resolveTargetDatabase } from "../authority-guard.js";

const TARGET = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";

function notionReturning(parent: unknown) {
  return {
    pages: {
      retrieve: vi.fn().mockResolvedValue({ id: "page", object: "page", parent }),
    },
  };
}

describe("Notion authority target resolution", () => {
  it("maps normalized database_id parents to configured databases", async () => {
    const compactUpper = NOTION_CONFIG.databases.projects.replaceAll("-", "").toUpperCase();
    const notion = notionReturning({ type: "database_id", database_id: compactUpper });

    await expect(resolveTargetDatabase("page-id", notion as any)).resolves.toBe("projects");
    expect(notion.pages.retrieve).toHaveBeenCalledWith({ page_id: "page-id" });
  });

  it("maps current data_source_id parents with or without database_id", async () => {
    const withDatabase = notionReturning({
      type: "data_source_id",
      data_source_id: "unrelated",
      database_id: NOTION_CONFIG.databases.decisionLog,
    });
    const dataSourceOnly = notionReturning({
      type: "data_source_id",
      data_source_id: DATABASE_SCHEMAS.knowledgeBase.dataSourceId.replaceAll("-", ""),
    });
    const staleDatabaseShape = notionReturning({
      type: "data_source_id",
      database_id: "00000000-0000-0000-0000-000000000000",
      data_source_id: DATABASE_SCHEMAS.knowledgeBase.dataSourceId,
    });

    await expect(resolveTargetDatabase("decision", withDatabase as any)).resolves.toBe("decisionLog");
    await expect(resolveTargetDatabase("knowledge", dataSourceOnly as any)).resolves.toBe("knowledgeBase");
    await expect(resolveTargetDatabase("stale-database", staleDatabaseShape as any)).resolves.toBe("knowledgeBase");
  });

  it("returns page for an unknown or non-database parent", async () => {
    await expect(
      resolveTargetDatabase("unknown", notionReturning({ type: "database_id", database_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) as any),
    ).resolves.toBe("page");
    await expect(
      resolveTargetDatabase("root", notionReturning({ type: "workspace", workspace: true }) as any),
    ).resolves.toBe("page");
  });

  it("walks page ancestors to the owning configured database", async () => {
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) => {
      if (page_id === TARGET) return { id: TARGET, parent: { type: "page_id", page_id: PARENT } };
      if (page_id === PARENT) {
        return { id: PARENT, parent: { type: "database_id", database_id: NOTION_CONFIG.databases.projects } };
      }
      throw new Error("unexpected page");
    });

    await expect(resolveTargetDatabase(TARGET, { pages: { retrieve } } as any)).resolves.toBe("projects");
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("allows a descendant of an allowed Knowledge Base record", async () => {
    const retrieve = vi.fn(async ({ page_id }: { page_id: string }) => page_id === TARGET
      ? { id: TARGET, parent: { type: "page_id", page_id: PARENT } }
      : { id: PARENT, parent: { type: "database_id", database_id: NOTION_CONFIG.databases.knowledgeBase } });

    await expect(resolveTargetDatabase(TARGET, { pages: { retrieve } } as any)).resolves.toBe("knowledgeBase");
  });

  it("fails closed on ancestor cycles, malformed parents, depth exhaustion, and retrieve errors", async () => {
    const cycle = vi.fn(async ({ page_id }: { page_id: string }) => ({
      id: page_id,
      parent: { type: "page_id", page_id: page_id === TARGET ? PARENT : TARGET },
    }));
    const malformed = notionReturning({ type: "page_id", page_id: "not-a-uuid" });
    const ids = Array.from({ length: 64 }, (_, index) => `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const deep = vi.fn(async ({ page_id }: { page_id: string }) => {
      const index = ids.indexOf(page_id);
      return { id: page_id, parent: { type: "page_id", page_id: ids[index + 1] ?? ids.at(-1) } };
    });
    const unavailable = vi.fn().mockRejectedValue(new Error("host-sensitive retrieve failure"));

    await expect(resolveTargetDatabase(TARGET, { pages: { retrieve: cycle } } as any)).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
    await expect(resolveTargetDatabase(TARGET, malformed as any)).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
    await expect(resolveTargetDatabase(ids[0], { pages: { retrieve: deep } } as any)).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
    const retrieveError = await resolveTargetDatabase(TARGET, { pages: { retrieve: unavailable } } as any)
      .catch((cause) => cause);
    expect(retrieveError).toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    expect((retrieveError as Error).message).not.toContain("host-sensitive");
  });

  it("still runs local write policy for an unknown page scope", async () => {
    const guard = { assertNotionWriteAllowed: vi.fn(async () => undefined) };

    await assertTargetWriteAllowed(guard, "page", "jhw_append");

    expect(guard.assertNotionWriteAllowed).toHaveBeenCalledWith("knowledgeBase", "jhw_append");
  });

  it("reports page truthfully when the local kill-switch rejects unknown scope", async () => {
    const guard = {
      assertNotionWriteAllowed: vi.fn(async () => {
        const payload = { code: "NOTION_WRITES_DISABLED", operation: "jhw_append", db: "knowledgeBase", route: "disabled" };
        const { ControlError } = await import("../../control/errors.js");
        throw new ControlError(payload.code, JSON.stringify(payload), payload);
      }),
    };

    const error = await assertTargetWriteAllowed(guard, "page", "jhw_append").catch((cause) => cause);

    expect(JSON.parse((error as Error).message)).toMatchObject({ code: "NOTION_WRITES_DISABLED", db: "page" });
  });
});
