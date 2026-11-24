import { Client } from "@notionhq/client";
import type { SupportedFetch, SupportedRequestInit, SupportedResponse } from "@notionhq/client/build/src/fetch-types.js";

const RELAY_NAME = "__JHW_MANAGED_NOTION_RELAY__";
const NOTION_ORIGIN = "https://api.notion.com";
const ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

type ManagedRelay = (request: unknown) => Promise<unknown>;
type RelayEnvelope = { status: number; body: Record<string, unknown> };

declare global {
  // The protected managed loader defines this as a non-writable own property.
  // A present invalid value is still a managed invocation and must fail closed.
  // eslint-disable-next-line no-var
  var __JHW_MANAGED_NOTION_RELAY__: unknown;
}

function failure(code: "NOTION_MANAGED_READ_ONLY" | "NOTION_MANAGED_UNAVAILABLE"): Error {
  const error = new Error(code);
  Object.assign(error, { code });
  return error;
}

export function hasManagedNotionRelay(): boolean {
  return RELAY_NAME in globalThis;
}

function relay(): ManagedRelay {
  const candidate = globalThis.__JHW_MANAGED_NOTION_RELAY__;
  if (!hasManagedNotionRelay() || typeof candidate !== "function") {
    throw failure("NOTION_MANAGED_UNAVAILABLE");
  }
  return candidate as ManagedRelay;
}

function exactObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function subset(
  value: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> | null {
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  return value;
}

function jsonBody(init: SupportedRequestInit | undefined): Record<string, unknown> | null {
  if (init?.body === undefined) return {};
  if (typeof init.body !== "string") return null;
  try {
    const value: unknown = JSON.parse(init.body);
    return exactObject(value) ? value : null;
  } catch {
    return null;
  }
}

function validId(value: string): boolean {
  return ID.test(value);
}

function onlyQuery(
  url: URL,
  allowed: readonly string[],
  options: { arrays?: readonly string[]; integers?: readonly string[] } = {},
): Record<string, unknown> | null {
  const parameters: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.includes(key)) return null;
    const values = url.searchParams.getAll(key);
    if (options.integers?.includes(key)) {
      if (values.length !== 1 || !/^[1-9][0-9]*$/u.test(values[0] as string)) return null;
      parameters[key] = Number(values[0]);
    } else {
      if (values.length !== 1 && !options.arrays?.includes(key)) return null;
      parameters[key] = options.arrays?.includes(key) ? values : values[0];
    }
  }
  return parameters;
}

function requestFor(urlValue: string, init?: SupportedRequestInit): unknown {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw failure("NOTION_MANAGED_READ_ONLY");
  }
  if (
    url.origin !== NOTION_ORIGIN ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/v1/") ||
    url.hash
  ) {
    throw failure("NOTION_MANAGED_READ_ONLY");
  }
  const path = url.pathname.slice(4);
  const method = init?.method?.toUpperCase() ?? "GET";
  const body = jsonBody(init);
  if (body === null) throw failure("NOTION_MANAGED_READ_ONLY");

  if (method === "POST" && path === "search" && !url.search) {
    const parameters = subset(body, ["sort", "query", "start_cursor", "page_size", "filter"]);
    if (parameters) return { operation: "search", parameters };
  }

  let match = /^data_sources\/([^/]+)\/query$/u.exec(path);
  if (method === "POST" && match && validId(match[1] as string)) {
    const parameters = subset(body, [
      "archived", "sorts", "filter", "start_cursor", "page_size", "in_trash", "result_type",
    ]);
    const query = onlyQuery(url, ["filter_properties"], { arrays: ["filter_properties"] });
    if (parameters && query) {
      return {
        operation: "queryDataSource",
        id: match[1],
        parameters: { ...parameters, ...query },
      };
    }
  }

  if (method === "GET" && Object.keys(body).length === 0 && !url.search) {
    match = /^pages\/([^/]+)$/u.exec(path);
    if (match && validId(match[1] as string)) return { operation: "retrievePage", id: match[1] };
    match = /^databases\/([^/]+)$/u.exec(path);
    if (match && validId(match[1] as string)) return { operation: "retrieveDatabase", id: match[1] };
    match = /^data_sources\/([^/]+)$/u.exec(path);
    if (match && validId(match[1] as string)) return { operation: "retrieveDataSource", id: match[1] };
  }

  match = /^blocks\/([^/]+)\/children$/u.exec(path);
  if (method === "GET" && match && validId(match[1] as string) && Object.keys(body).length === 0) {
    const parameters = onlyQuery(url, ["start_cursor", "page_size"], { integers: ["page_size"] });
    if (parameters) return { operation: "listBlockChildren", id: match[1], parameters };
  }
  throw failure("NOTION_MANAGED_READ_ONLY");
}

async function relayFetch(url: string, init?: SupportedRequestInit): Promise<SupportedResponse> {
  const request = requestFor(url, init);
  let response: unknown;
  try {
    response = await relay()(request);
  } catch {
    throw failure("NOTION_MANAGED_UNAVAILABLE");
  }
  if (
    !exactObject(response) ||
    Object.keys(response).length !== 2 ||
    !Number.isInteger(response.status) ||
    (response.status as number) < 100 ||
    (response.status as number) > 599 ||
    !exactObject(response.body)
  ) {
    throw failure("NOTION_MANAGED_UNAVAILABLE");
  }
  const envelope = response as RelayEnvelope;
  return {
    ok: envelope.status >= 200 && envelope.status < 300,
    status: envelope.status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(envelope.body),
  };
}

export function createManagedNotionClient(options: { logger?: () => void } = {}): Client {
  relay();
  return new Client({
    fetch: relayFetch as SupportedFetch,
    retry: false,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

export async function verifyManagedNotionPreflight(
  routes: ReadonlyArray<{ databaseId: string; dataSourceId: string }>,
): Promise<void> {
  if (!routes.length || routes.some(({ databaseId, dataSourceId }) => !validId(databaseId) || !validId(dataSourceId))) {
    throw failure("NOTION_MANAGED_UNAVAILABLE");
  }
  let response: unknown;
  try {
    response = await relay()({ operation: "preflight", routes });
  } catch {
    throw failure("NOTION_MANAGED_UNAVAILABLE");
  }
  if (
    !exactObject(response) ||
    Object.keys(response).length !== 2 ||
    response.status !== 200 ||
    !exactObject(response.body) ||
    Object.keys(response.body).length !== 1 ||
    response.body.ok !== true
  ) {
    throw failure("NOTION_MANAGED_UNAVAILABLE");
  }
}
