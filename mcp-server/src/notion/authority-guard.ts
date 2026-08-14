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
type AuthorityNode = { kind: "page" | "database" | "data_source"; id: string; expectedDatabaseId?: string };

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

async function resolveAuthorityNode(
  initial: AuthorityNode,
  notion: Pick<Client, "pages" | "databases" | "dataSources">,
): Promise<DatabaseName | "page"> {
  let current = initial;
  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const key = `${current.kind}:${pageKey(current.id)}`;
    if (!key || visited.has(key)) throw targetResolutionUnavailable();
    visited.add(key);

    let object: unknown;
    try {
      object = current.kind === "page"
        ? await notion.pages.retrieve({ page_id: current.id })
        : current.kind === "database"
          ? await notion.databases.retrieve({ database_id: current.id })
          : await notion.dataSources.retrieve({ data_source_id: current.id });
    } catch {
      throw targetResolutionUnavailable();
    }
    if (typeof object !== "object" || object === null) throw targetResolutionUnavailable();
    const record = object as { id?: unknown; object?: unknown; parent?: unknown; database_parent?: unknown };
    if (typeof record.id !== "string" || pageKey(record.id) !== pageKey(current.id)) throw targetResolutionUnavailable();
    if (record.object !== undefined && record.object !== current.kind) throw targetResolutionUnavailable();
    if (current.kind === "data_source") {
      const databaseParent = record.database_parent as {
        type?: unknown;
        database_id?: unknown;
        page_id?: unknown;
        workspace?: unknown;
      } | undefined;
      if (!databaseParent || (
        !(databaseParent.type === "database_id" && normalizeId(databaseParent.database_id)) &&
        !(databaseParent.type === "page_id" && normalizeId(databaseParent.page_id)) &&
        !(databaseParent.type === "workspace" && databaseParent.workspace === true)
      )) throw targetResolutionUnavailable();
    }
    const parent = record.parent;
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
      const dataSourceId = normalizeId(typed.data_source_id);
      if (typed.type === "database_id" && !databaseId) throw targetResolutionUnavailable();
      if (typed.type === "data_source_id" && !dataSourceId) throw targetResolutionUnavailable();
      const database = databaseId ? databaseIds.get(databaseId) : undefined;
      const dataSourceDatabase = dataSourceId ? dataSourceIds.get(dataSourceId) : undefined;
      if (database && dataSourceDatabase && database !== dataSourceDatabase) throw targetResolutionUnavailable();

      if (current.kind === "data_source" && current.expectedDatabaseId && databaseId && current.expectedDatabaseId !== databaseId) {
        throw targetResolutionUnavailable();
      }
      if (typed.type === "database_id") {
        if (dataSourceId && !dataSourceDatabase) {
          current = { kind: "data_source", id: dataSourceId, ...(databaseId ? { expectedDatabaseId: databaseId } : {}) };
          continue;
        }
        if (database) return database;
        if (dataSourceDatabase) throw targetResolutionUnavailable();
        current = { kind: "database", id: databaseId as string };
        continue;
      }

      if (dataSourceDatabase) {
        if (databaseId && !database) throw targetResolutionUnavailable();
        return dataSourceDatabase;
      }
      current = { kind: "data_source", id: dataSourceId as string, ...(databaseId ? { expectedDatabaseId: databaseId } : {}) };
      continue;
    }

    if (typed.type === "workspace" && typed.workspace === true) return "page";
    if (typed.type !== "page_id") throw targetResolutionUnavailable();
    const parentPageId = typeof typed.page_id === "string" ? typed.page_id.trim() : "";
    if (!normalizeId(parentPageId)) throw targetResolutionUnavailable();
    current = { kind: "page", id: parentPageId };
  }
  throw targetResolutionUnavailable();
}

export async function resolveTargetDatabase(
  pageId: string,
  notion: Pick<Client, "pages" | "databases" | "dataSources">,
): Promise<DatabaseName | "page"> {
  return resolveAuthorityNode({ kind: "page", id: pageId.trim() }, notion);
}

function notionGuardIndeterminate(): ControlError {
  return new ControlError(
    "NOTION_GUARD_INDETERMINATE",
    "Notion authority routing proof is unavailable",
  );
}

/**
 * Exercises the same ancestry resolver used by append/delete against every
 * configured data source. Database coordinates are independently retrieved so
 * both halves of the configured Notion route are proven read-only.
 */
export async function verifyConfiguredNotionAuthorityRoutes(
  notion: Pick<Client, "pages" | "databases" | "dataSources">,
): Promise<void> {
  try {
    for (const [name, schema] of Object.entries(DATABASE_SCHEMAS)) {
      const database = await notion.databases.retrieve({ database_id: schema.id });
      const record = database as { id?: unknown; object?: unknown };
      if (
        record.object !== "database" ||
        normalizeId(record.id) !== normalizeId(schema.id)
      ) throw notionGuardIndeterminate();

      const resolved = await resolveAuthorityNode(
        { kind: "data_source", id: schema.dataSourceId },
        notion,
      );
      if (resolved !== name) throw notionGuardIndeterminate();
    }
  } catch {
    throw notionGuardIndeterminate();
  }
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
