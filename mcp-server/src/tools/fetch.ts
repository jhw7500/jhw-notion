import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BlockObjectResponse, PartialBlockObjectResponse } from "@notionhq/client";
import { z } from "zod";
import { getNotionClient } from "../notion-client.js";
import { callNotion } from "../notion/api.js";
import { normalizePageId } from "../notion/page-id.js";

const DEFAULT_MAX_CHARACTERS = 100_000;
const MAX_BLOCKS = 10_000;

interface FetchedBlock {
  block: NotionBlock;
  children: FetchedBlock[];
}

type NotionBlock = BlockObjectResponse | PartialBlockObjectResponse;

type TraversalTruncation =
  | { reason: "max_blocks"; blockId: string; depth: number }
  | { reason: "pagination_cursor_missing"; blockId: string; depth: number }
  | { reason: "pagination_cursor_repeated"; blockId: string; depth: number }
  | { reason: "partial_block"; blockId: string; depth: number }
  | {
      reason: "unsupported_block";
      blockId: string;
      depth: number;
      blockType: string;
    };

type CharacterTruncation = { reason: "max_characters"; atCharacter: number };
type FetchTruncation = TraversalTruncation | CharacterTruncation;

interface TraversalState {
  blocksRead: number;
  truncation: TraversalTruncation | null;
}

const FetchInput = z.object({
  pageId: z.string().min(1).describe("Notion page UUID 또는 page URL"),
  maxCharacters: z
    .number()
    .int()
    .min(1)
    .max(200_000)
    .optional()
    .describe("반환할 본문 최대 문자 수 (기본 100000)"),
});

function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item: any) => item?.plain_text ?? item?.text?.content ?? item?.equation?.expression ?? "")
    .join("");
}

function isFullBlock(block: NotionBlock): block is BlockObjectResponse {
  return "type" in block;
}

function titleOf(page: any): string {
  const titleProperty = Object.values(page?.properties ?? {}).find(
    (property: any) => property?.type === "title" || Array.isArray(property?.title)
  ) as any;
  return richText(titleProperty?.title) || "(제목 없음)";
}

function indent(text: string, depth: number): string {
  const prefix = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function tableCell(value: unknown): string {
  return richText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function tableRow(block: NotionBlock): string {
  if (!isFullBlock(block) || block.type !== "table_row") return "";
  const cells = block.table_row.cells;
  return `| ${cells.map(tableCell).join(" | ")} |`;
}

function mediaUrl(value: any): string {
  if (value?.type === "external") return value.external?.url ?? "";
  if (value?.type === "file") return value.file?.url ?? "";
  return value?.external?.url ?? value?.file?.url ?? "";
}

function codeFence(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

function renderOwnBlock(block: NotionBlock): string {
  if (!isFullBlock(block)) return `[Partial Notion block: ${block.id}]`;
  const type = block.type;
  const value = (block as any)[type] ?? {};
  const text = richText(value.rich_text);

  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "heading_4":
      return `#### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${value.checked ? "x" : " "}] ${text}`;
    case "toggle":
      return `- ${text}`;
    case "quote":
      return text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "callout": {
      const icon = value.icon?.type === "emoji" ? `${value.icon.emoji} ` : "";
      return `> ${icon}${text}`;
    }
    case "code": {
      const fence = codeFence(text);
      const language = value.language && value.language !== "plain text" ? value.language : "";
      return `${fence}${language}\n${text}\n${fence}`;
    }
    case "divider":
      return "---";
    case "equation":
      return `$$${value.expression ?? ""}$$`;
    case "bookmark":
    case "link_preview":
    case "embed": {
      const caption = richText(value.caption);
      const url = value.url ?? "";
      return caption ? `[${caption}](${url})` : url;
    }
    case "image":
    case "video":
    case "audio":
    case "file":
    case "pdf": {
      const caption = richText(value.caption) || type;
      const url = mediaUrl(value);
      return type === "image" ? `![${caption}](${url})` : `[${caption}](${url})`;
    }
    case "child_page":
      return `## ${value.title ?? "(제목 없음)"}`;
    case "child_database":
      return `## ${value.title ?? "(제목 없음)"}`;
    case "table_row":
      return tableRow(block);
    case "unsupported":
      return `[Unsupported Notion block: ${value.block_type ?? "unknown"}]`;
    default:
      return text;
  }
}

function renderBlock(node: FetchedBlock, depth: number): string {
  if (isFullBlock(node.block) && node.block.type === "table") {
    const rows = node.children
      .filter(
        (child) => isFullBlock(child.block) && child.block.type === "table_row"
      )
      .map((child) => tableRow(child.block));
    if (rows.length > 0) {
      const width = Math.max(1, node.block.table.table_width);
      const delimiter = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
      if (node.block.table.has_column_header) {
        rows.splice(1, 0, delimiter);
      } else {
        const emptyHeader = `| ${Array.from({ length: width }, () => "").join(" | ")} |`;
        rows.unshift(emptyHeader, delimiter);
      }
    }
    return rows.map((row) => indent(row, depth)).join("\n");
  }

  const parts: string[] = [];
  const own = renderOwnBlock(node.block);
  if (own) parts.push(indent(own, depth));
  const children = renderBlocks(node.children, depth + 1);
  if (children) parts.push(children);
  return parts.join("\n");
}

function renderBlocks(nodes: FetchedBlock[], depth = 0): string {
  return nodes
    .map((node) => renderBlock(node, depth))
    .filter(Boolean)
    .join("\n");
}

async function fetchChildren(
  notion: ReturnType<typeof getNotionClient>,
  blockId: string,
  depth: number,
  state: TraversalState
): Promise<FetchedBlock[]> {
  const fetched: FetchedBlock[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (!state.truncation) {
    const response = await callNotion(
      () =>
        notion.blocks.children.list({
          block_id: blockId,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      { operation: "fetch.blocks.children.list" }
    );

    const blocks = response.results;
    for (const block of blocks) {
      if (state.blocksRead >= MAX_BLOCKS) {
        state.truncation = { reason: "max_blocks", blockId, depth };
        break;
      }

      state.blocksRead += 1;
      if (!isFullBlock(block)) {
        fetched.push({ block, children: [] });
        state.truncation = { reason: "partial_block", blockId: block.id, depth };
        break;
      }
      if (block.type === "unsupported") {
        fetched.push({ block, children: [] });
        state.truncation = {
          reason: "unsupported_block",
          blockId: block.id,
          depth,
          blockType: block.unsupported.block_type,
        };
        break;
      }

      const children = block.has_children
        ? await fetchChildren(notion, block.id, depth + 1, state)
        : [];
      fetched.push({ block, children });
      if (state.truncation) break;
    }

    if (state.truncation || !response.has_more) break;
    if (!response.next_cursor) {
      state.truncation = { reason: "pagination_cursor_missing", blockId, depth };
      break;
    }
    if (seenCursors.has(response.next_cursor)) {
      state.truncation = { reason: "pagination_cursor_repeated", blockId, depth };
      break;
    }
    seenCursors.add(response.next_cursor);
    cursor = response.next_cursor;
  }

  return fetched;
}

export function registerFetch(server: McpServer) {
  server.tool(
    "jhw_fetch",
    "Notion 페이지의 전체 본문을 구조가 보존된 Markdown으로 읽기 전용 조회",
    FetchInput.shape,
    async ({ pageId, maxCharacters }) => {
      const normalizedPageId = normalizePageId(pageId);
      const notion = getNotionClient();
      const page: any = await callNotion(
        () => notion.pages.retrieve({ page_id: normalizedPageId }),
        { operation: "fetch.page.retrieve" }
      );
      const limit = maxCharacters ?? DEFAULT_MAX_CHARACTERS;
      const state: TraversalState = { blocksRead: 0, truncation: null };
      const blocks = await fetchChildren(notion, normalizedPageId, 0, state);
      const completeMarkdown = renderBlocks(blocks);
      const overCharacterLimit = completeMarkdown.length > limit;
      const markdown = overCharacterLimit ? completeMarkdown.slice(0, limit) : completeMarkdown;
      const characterTruncation: CharacterTruncation | null = overCharacterLimit
        ? { reason: "max_characters", atCharacter: limit }
        : null;
      const truncations: FetchTruncation[] = [state.truncation, characterTruncation].filter(
        (value): value is FetchTruncation => value !== null
      );
      const truncation = truncations[0] ?? null;
      const payload = {
        pageId: normalizedPageId,
        url: page.url ?? `https://www.notion.so/${normalizedPageId.replace(/-/g, "")}`,
        title: titleOf(page),
        markdown,
        truncated: truncations.length > 0,
        truncation,
        truncations,
        metadata: {
          blocksRead: state.blocksRead,
          characters: markdown.length,
          maxCharacters: limit,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  );
}
