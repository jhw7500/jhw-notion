import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManagedNotionClient,
  verifyManagedNotionPreflight,
} from "../notion/managed-relay.js";

const relayName = "__JHW_MANAGED_NOTION_RELAY__";
const pageId = "00000000-0000-4000-8000-000000000001";
const dataSourceId = "00000000-0000-4000-8000-000000000002";

function installRelay(
  implementation: (request: unknown) => Promise<unknown>,
): void {
  Object.defineProperty(globalThis, relayName, {
    value: implementation,
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, relayName);
  vi.restoreAllMocks();
});

describe("managed Notion read relay", () => {
  it("maps the six supported SDK reads to closed structured operations", async () => {
    const requests: unknown[] = [];
    installRelay(async (request) => {
      requests.push(request);
      return { status: 200, body: { object: "list", results: [], has_more: false, next_cursor: null } };
    });
    const notion = createManagedNotionClient();

    await notion.search({ query: "fixture", page_size: 10 });
    await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter_properties: ["title"],
      filter: { property: "status", select: { equals: "open" } },
      start_cursor: "cursor",
      page_size: 25,
    });
    await notion.pages.retrieve({ page_id: pageId });
    await notion.databases.retrieve({ database_id: pageId });
    await notion.dataSources.retrieve({ data_source_id: dataSourceId });
    await notion.blocks.children.list({ block_id: pageId, start_cursor: "next", page_size: 50 });

    expect(requests).toEqual([
      { operation: "search", parameters: { query: "fixture", page_size: 10 } },
      {
        operation: "queryDataSource",
        id: dataSourceId,
        parameters: {
          filter: { property: "status", select: { equals: "open" } },
          start_cursor: "cursor",
          page_size: 25,
          filter_properties: ["title"],
        },
      },
      { operation: "retrievePage", id: pageId },
      { operation: "retrieveDatabase", id: pageId },
      { operation: "retrieveDataSource", id: dataSourceId },
      {
        operation: "listBlockChildren",
        id: pageId,
        parameters: { start_cursor: "next", page_size: 50 },
      },
    ]);
  });

  it("rejects SDK writes and unsupported query routes before calling the relay", async () => {
    const relay = vi.fn(async () => ({ status: 200, body: {} }));
    installRelay(relay);
    const notion = createManagedNotionClient();

    await expect(notion.pages.create({
      parent: { page_id: pageId },
      properties: {},
    })).rejects.toThrow("NOTION_MANAGED_READ_ONLY");
    await expect(notion.pages.retrieve({
      page_id: pageId,
      filter_properties: ["title"],
    })).rejects.toThrow("NOTION_MANAGED_READ_ONLY");
    await expect(notion.request({
      path: `blocks/${pageId}/children`,
      method: "get",
      query: { start_cursor: ["one", "two"] },
    })).rejects.toThrow("NOTION_MANAGED_READ_ONLY");

    expect(relay).not.toHaveBeenCalled();
  });

  it("fails closed when the managed global is present with an invalid value", () => {
    Object.defineProperty(globalThis, relayName, { value: "invalid", configurable: true });

    expect(() => createManagedNotionClient()).toThrow("NOTION_MANAGED_UNAVAILABLE");
  });

  it("accepts only exact relay response envelopes", async () => {
    installRelay(async () => ({ status: 200, body: {}, extra: true }));
    const notion = createManagedNotionClient();

    await expect(notion.pages.retrieve({ page_id: pageId }))
      .rejects.toThrow("NOTION_MANAGED_UNAVAILABLE");
  });

  it("replaces relay exceptions with the bounded unavailable error", async () => {
    installRelay(async () => { throw new Error("private relay detail"); });
    const notion = createManagedNotionClient();

    await expect(notion.pages.retrieve({ page_id: pageId }))
      .rejects.toThrow(/^NOTION_MANAGED_UNAVAILABLE$/u);
  });

  it("sends configured routes through the dedicated preflight operation", async () => {
    const requests: unknown[] = [];
    installRelay(async (request) => {
      requests.push(request);
      return { status: 200, body: { ok: true } };
    });

    await verifyManagedNotionPreflight([
      { databaseId: pageId, dataSourceId },
    ]);

    expect(requests).toEqual([{
      operation: "preflight",
      routes: [{ databaseId: pageId, dataSourceId }],
    }]);
  });
});
