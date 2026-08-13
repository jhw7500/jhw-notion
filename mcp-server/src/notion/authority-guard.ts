import type { Client } from "@notionhq/client";

import type { DatabaseName } from "../config.js";
import { createDefaultAuthorityService, type AuthorityService } from "../control/authority.js";
import { ControlError } from "../control/errors.js";
import { DATABASE_SCHEMAS } from "../schema.js";

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("-", "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null;
}

const databaseIds = new Map<string, DatabaseName>();
const dataSourceIds = new Map<string, DatabaseName>();
for (const [name, schema] of Object.entries(DATABASE_SCHEMAS)) {
  const db = normalizeId(schema.id);
  const dataSource = normalizeId(schema.dataSourceId);
  if (db) databaseIds.set(db, name as DatabaseName);
  if (dataSource) dataSourceIds.set(dataSource, name as DatabaseName);
}

export async function resolveTargetDatabase(
  pageId: string,
  notion: Pick<Client, "pages">,
): Promise<DatabaseName | "page"> {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const parent = (page as { parent?: { database_id?: unknown; data_source_id?: unknown } }).parent;
  const databaseId = normalizeId(parent?.database_id);
  if (databaseId) {
    const database = databaseIds.get(databaseId);
    if (database) return database;
  }
  const dataSourceId = normalizeId(parent?.data_source_id);
  if (dataSourceId) return dataSourceIds.get(dataSourceId) ?? "page";
  return "page";
}

export type NotionAuthorityGuard = Pick<AuthorityService, "assertNotionWriteAllowed">;
export type NotionWriteTarget = DatabaseName | "page";

export function assertNotionWriteAllowed(db: DatabaseName, operation: string): Promise<void> {
  return createDefaultAuthorityService().assertNotionWriteAllowed(db, operation);
}

export const defaultNotionAuthorityGuard: NotionAuthorityGuard = { assertNotionWriteAllowed };

export async function assertTargetWriteAllowed(
  authority: NotionAuthorityGuard,
  target: NotionWriteTarget,
  operation: string,
): Promise<void> {
  if (target === "page") {
    try {
      // Authority mode intentionally allows unknown pages. The allowed DB is
      // only a compatibility probe for the independent local write kill-switch.
      await authority.assertNotionWriteAllowed("knowledgeBase", operation);
    } catch (cause) {
      if (cause instanceof ControlError && cause.code === "NOTION_WRITES_DISABLED") {
        const payload = { code: cause.code, operation, db: "page", route: routeFor("page", cause.code) };
        throw new ControlError(cause.code, JSON.stringify(payload), payload);
      }
      throw cause;
    }
    return;
  }
  await authority.assertNotionWriteAllowed(target, operation);
}

const authorityCodes = new Set([
  "AUTHORITY_MOVED",
  "AUTHORITY_UNAVAILABLE",
  "AUTHORITY_EPOCH_ROLLBACK",
  "NOTION_WRITES_DISABLED",
]);

function routeFor(db: NotionWriteTarget, code: string): string {
  if (db === "decisionLog") return "Route formal decisions to a Git ADR.";
  if (db === "projects") {
    return "Route Project state through `jhw-control project register` and the Project workflow.";
  }
  if (code === "NOTION_WRITES_DISABLED") return "Use the owning workflow or ask the operator to re-enable Notion writes.";
  return "Retry only after the central authority policy is available; do not bypass the guard.";
}

export function authorityMcpError(
  cause: unknown,
  db: NotionWriteTarget,
  operation: string,
): { isError: true; content: [{ type: "text"; text: string }] } | null {
  if (!(cause instanceof ControlError) || !authorityCodes.has(cause.code)) return null;
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({ code: cause.code, operation, db, route: routeFor(db, cause.code) }),
    }],
  };
}
