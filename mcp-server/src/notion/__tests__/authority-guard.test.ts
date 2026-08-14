import { describe, expect, it, vi } from "vitest";

import { NOTION_CONFIG } from "../../config.js";
import { DATABASE_SCHEMAS } from "../../schema.js";
import {
  assertTargetWriteAllowed,
  resolveTargetDatabase,
  verifyConfiguredNotionAuthorityRoutes,
} from "../authority-guard.js";

const TARGET = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";

function notionReturning(parent: unknown) {
  return {
    pages: {
      retrieve: vi.fn(async ({ page_id }: { page_id: string }) => ({ id: page_id, object: "page", parent })),
    },
  };
}

describe("Notion authority target resolution", () => {
  it("proves every configured protected and allowed route through the production resolver without writes", async () => {
    const databases = {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({
        object: "database",
        id: database_id,
        parent: { type: "workspace", workspace: true },
      })),
    };
    const dataSources = {
      retrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => {
        const schema = Object.values(DATABASE_SCHEMAS).find(
          (candidate) => candidate.dataSourceId.replaceAll("-", "") === data_source_id.replaceAll("-", ""),
        );
        if (!schema) throw new Error("unexpected data source");
        return {
          object: "data_source",
          id: data_source_id,
          parent: { type: "database_id", database_id: schema.id },
          database_parent: { type: "workspace", workspace: true },
        };
      }),
    };

    await verifyConfiguredNotionAuthorityRoutes({
      pages: { retrieve: vi.fn() },
      databases,
      dataSources,
    } as any);

    expect(databases.retrieve).toHaveBeenCalledTimes(Object.keys(DATABASE_SCHEMAS).length * 2);
    expect(dataSources.retrieve).toHaveBeenCalledTimes(Object.keys(DATABASE_SCHEMAS).length);
  });

  it("fails the preflight route proof when an allowed data source resolves to a protected database", async () => {
    const notion = {
      pages: { retrieve: vi.fn() },
      databases: {
        retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({
          object: "database", id: database_id, parent: { type: "workspace", workspace: true },
        })),
      },
      dataSources: {
        retrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
          object: "data_source",
          id: data_source_id,
          parent: {
            type: "database_id",
            database_id: data_source_id.replaceAll("-", "") === DATABASE_SCHEMAS.knowledgeBase.dataSourceId.replaceAll("-", "")
              ? DATABASE_SCHEMAS.projects.id
              : Object.values(DATABASE_SCHEMAS).find(
                (candidate) => candidate.dataSourceId.replaceAll("-", "") === data_source_id.replaceAll("-", ""),
              )?.id,
          },
          database_parent: { type: "workspace", workspace: true },
        })),
      },
    };

    await expect(verifyConfiguredNotionAuthorityRoutes(notion as any)).rejects.toMatchObject({
      code: "NOTION_GUARD_INDETERMINATE",
    });
  });

  it("maps normalized database_id parents to configured databases", async () => {
    const compactUpper = NOTION_CONFIG.databases.projects.replaceAll("-", "").toUpperCase();
    const notion = notionReturning({ type: "database_id", database_id: compactUpper });

    await expect(resolveTargetDatabase("page-id", notion as any)).resolves.toBe("projects");
    expect(notion.pages.retrieve).toHaveBeenCalledWith({ page_id: "page-id" });
  });

  it("maps current data_source_id parents only with the required containing database_id", async () => {
    const withDatabase = notionReturning({
      type: "data_source_id",
      data_source_id: DATABASE_SCHEMAS.decisionLog.dataSourceId,
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
    const matchingKnownIds = notionReturning({
      type: "database_id",
      database_id: NOTION_CONFIG.databases.projects,
      data_source_id: DATABASE_SCHEMAS.projects.dataSourceId,
    });

    await expect(resolveTargetDatabase("decision", withDatabase as any)).resolves.toBe("decisionLog");
    await expect(resolveTargetDatabase("knowledge", dataSourceOnly as any)).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
    await expect(resolveTargetDatabase("stale-database", staleDatabaseShape as any)).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
    await expect(resolveTargetDatabase("matching-known", matchingKnownIds as any)).resolves.toBe("projects");
  });

  it("rejects a data source whose database_parent conflicts with the retrieved containing database", async () => {
    const unknownDataSource = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const notion = {
      pages: {
        retrieve: vi.fn(async ({ page_id }: { page_id: string }) => ({
          object: "page",
          id: page_id,
          parent: {
            type: "data_source_id",
            data_source_id: unknownDataSource,
            database_id: NOTION_CONFIG.databases.knowledgeBase,
          },
        })),
      },
      dataSources: {
        retrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
          object: "data_source",
          id: data_source_id,
          parent: { type: "database_id", database_id: NOTION_CONFIG.databases.knowledgeBase },
          database_parent: { type: "workspace", workspace: true },
        })),
      },
      databases: {
        retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({
          object: "database",
          id: database_id,
          parent: { type: "page_id", page_id: PARENT },
        })),
      },
    };

    await expect(resolveTargetDatabase(TARGET, notion as any)).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
  });

  it("fails preflight route proof when database_parent conflicts with the containing database", async () => {
    const notion = {
      pages: { retrieve: vi.fn() },
      databases: {
        retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({
          object: "database",
          id: database_id,
          parent: { type: "page_id", page_id: PARENT },
        })),
      },
      dataSources: {
        retrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
          object: "data_source",
          id: data_source_id,
          parent: {
            type: "database_id",
            database_id: Object.values(DATABASE_SCHEMAS).find(
              (candidate) => candidate.dataSourceId.replaceAll("-", "") === data_source_id.replaceAll("-", ""),
            )?.id,
          },
          database_parent: { type: "workspace", workspace: true },
        })),
      },
    };

    await expect(verifyConfiguredNotionAuthorityRoutes(notion as any)).rejects.toMatchObject({
      code: "NOTION_GUARD_INDETERMINATE",
    });
  });

  it.each([
    [
      "database parent with conflicting data source",
      {
        type: "database_id",
        database_id: NOTION_CONFIG.databases.projects,
        data_source_id: DATABASE_SCHEMAS.decisionLog.dataSourceId,
      },
    ],
    [
      "data-source parent with conflicting database",
      {
        type: "data_source_id",
        database_id: NOTION_CONFIG.databases.decisionLog,
        data_source_id: DATABASE_SCHEMAS.projects.dataSourceId,
      },
    ],
  ])("fails closed for known ID conflicts: %s", async (_case, parent) => {
    await expect(resolveTargetDatabase(TARGET, notionReturning(parent) as any)).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE",
    });
  });

  it("fails closed for unresolved database/data-source parents and allows only a real workspace root", async () => {
    await expect(
      resolveTargetDatabase("unknown", notionReturning({ type: "database_id", database_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) as any),
    ).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    await expect(
      resolveTargetDatabase("root", notionReturning({ type: "workspace", workspace: true }) as any),
    ).resolves.toBe("page");
    await expect(resolveTargetDatabase("unknown-pair", notionReturning({
      type: "data_source_id",
      database_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      data_source_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }) as any)).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
  });

  it("retrieves unknown database and data-source ancestry to protected and allowed configured roots", async () => {
    const unknownDatabase = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const unknownDataSource = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const notion = {
      pages: {
        retrieve: vi.fn(async ({ page_id }: { page_id: string }) => ({
          object: "page", id: page_id, parent: { type: "database_id", database_id: unknownDatabase },
        })),
      },
      databases: {
        retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({
          object: "database", id: database_id,
          parent: { type: "database_id", database_id: NOTION_CONFIG.databases.projects },
        })),
      },
      dataSources: { retrieve: vi.fn() },
    };
    await expect(resolveTargetDatabase(TARGET, notion as any)).resolves.toBe("projects");
    expect(notion.databases.retrieve).toHaveBeenCalledWith({ database_id: unknownDatabase.replaceAll("-", "") });

    const allowed = {
      pages: {
        retrieve: vi.fn(async ({ page_id }: { page_id: string }) => ({
          object: "page",
          id: page_id,
          parent: {
            type: "data_source_id",
            data_source_id: unknownDataSource,
            database_id: NOTION_CONFIG.databases.knowledgeBase,
          },
        })),
      },
      databases: {
        retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({
          object: "database",
          id: database_id,
          parent: { type: "workspace", workspace: true },
        })),
      },
      dataSources: {
        retrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
          object: "data_source", id: data_source_id,
          parent: { type: "database_id", database_id: NOTION_CONFIG.databases.knowledgeBase },
          database_parent: { type: "workspace", workspace: true },
        })),
      },
    };
    await expect(resolveTargetDatabase(TARGET, allowed as any)).resolves.toBe("knowledgeBase");
    expect(allowed.dataSources.retrieve).toHaveBeenCalledWith({ data_source_id: unknownDataSource.replaceAll("-", "") });
  });

  it("fails closed on database/data-source cycles, malformed full objects, and unavailable APIs", async () => {
    const unknownDatabase = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const base = {
      pages: { retrieve: vi.fn(async () => ({ object: "page", id: TARGET, parent: { type: "database_id", database_id: unknownDatabase } })) },
      dataSources: { retrieve: vi.fn() },
    };
    await expect(resolveTargetDatabase(TARGET, {
      ...base,
      databases: { retrieve: vi.fn(async () => ({ object: "database", id: unknownDatabase, parent: { type: "database_id", database_id: unknownDatabase } })) },
    } as any)).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    await expect(resolveTargetDatabase(TARGET, {
      ...base,
      databases: { retrieve: vi.fn(async () => ({ object: "database", id: "wrong", parent: { type: "workspace", workspace: true } })) },
    } as any)).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    await expect(resolveTargetDatabase(TARGET, base as any)).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
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
