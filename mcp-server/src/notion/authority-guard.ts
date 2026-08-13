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

const MAX_PARENT_DEPTH = 16;

function targetResolutionUnavailable(): ControlError {
  const payload = {
    code: "AUTHORITY_UNAVAILABLE",
    operation: "authority.resolve_target",
    db: "page",
    route: "Retry only after the Notion target authority can be resolved; do not bypass the guard.",
  };
  return new ControlError(payload.code, JSON.stringify(payload), payload);
}

function pageKey(pageId: string): string {
  const trimmed = pageId.trim();
  return normalizeId(trimmed) ?? trimmed.toLowerCase();
}

export async function resolveTargetDatabase(
  pageId: string,
  notion: Pick<Client, "pages">,
): Promise<DatabaseName | "page"> {
  let currentPageId = pageId.trim();
  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const key = pageKey(currentPageId);
    if (!key || visited.has(key)) throw targetResolutionUnavailable();
    visited.add(key);

    let page: unknown;
    try {
      page = await notion.pages.retrieve({ page_id: currentPageId });
    } catch {
      throw targetResolutionUnavailable();
    }
    const parent = (page as { parent?: unknown } | null)?.parent;
    if (typeof parent !== "object" || parent === null) throw targetResolutionUnavailable();
    const typed = parent as {
      type?: unknown;
      database_id?: unknown;
      data_source_id?: unknown;
      page_id?: unknown;
      workspace?: unknown;
    };

    if (typed.type === "database_id" || typed.type === "data_source_id") {
      const databaseId = normalizeId(typed.database_id);
      if (databaseId) {
        const database = databaseIds.get(databaseId);
        if (database) return database;
      }
      const dataSourceId = normalizeId(typed.data_source_id);
      if (dataSourceId) {
        const database = dataSourceIds.get(dataSourceId);
        if (database) return database;
      }
      if (databaseId || dataSourceId) return "page";
      throw targetResolutionUnavailable();
    }

    if (typed.type === "workspace" && typed.workspace === true) return "page";
    if (typed.type !== "page_id") throw targetResolutionUnavailable();
    const parentPageId = typeof typed.page_id === "string" ? typed.page_id.trim() : "";
    if (!normalizeId(parentPageId)) throw targetResolutionUnavailable();
    currentPageId = parentPageId;
  }
  throw targetResolutionUnavailable();
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
