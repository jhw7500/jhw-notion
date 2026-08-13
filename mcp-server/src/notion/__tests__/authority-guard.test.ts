import { describe, expect, it, vi } from "vitest";

import { NOTION_CONFIG } from "../../config.js";
import { DATABASE_SCHEMAS } from "../../schema.js";
import { assertTargetWriteAllowed, resolveTargetDatabase } from "../authority-guard.js";

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
      resolveTargetDatabase("unknown", notionReturning({ type: "database_id", database_id: "unknown" }) as any),
    ).resolves.toBe("page");
    await expect(
      resolveTargetDatabase("child", notionReturning({ type: "page_id", page_id: "parent" }) as any),
    ).resolves.toBe("page");
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
