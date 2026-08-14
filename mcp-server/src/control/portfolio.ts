import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";

import { ControlError } from "./errors.js";
import { openSecureStateDirectory, type SecureStateDirectory } from "./journal.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import {
  type ProjectRecordLink,
  type RegisterProjectInput,
  ProjectSnapshotSourceSchema,
  type ProjectSnapshotItem,
  type ProjectSnapshotSource as ValidProjectSnapshotSource,
} from "./schemas.js";

export type ProjectSnapshotSource = ValidProjectSnapshotSource;

const MAX_PAYLOAD_BYTES = 12 * 1024;
const MAX_PAGE_ITEMS = 20;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const createFileFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
const readFileFlags = constants.O_RDONLY | constants.O_NOFOLLOW;

export interface ProjectSnapshotReader {
  readAll(): Promise<ProjectSnapshotSource>;
  registerProject?(input: RegisterProjectInput): Promise<ProjectRecordLink>;
}

export interface BoundedPayload {
  page_id: string;
  markdown: string;
  items: ProjectSnapshotItem[];
  truncated: boolean;
  total_items: number;
  next_page_id?: string;
}

export interface SnapshotExportResult {
  jsonPath: string;
  markdownPath: string;
  checksum: string;
}

export interface PortfolioServiceOptions {
  projectClient: ProjectSnapshotReader;
  stateDir: string;
  now?: () => Date;
  sensitiveData?: SensitiveDataPolicy;
  /** Test-only synchronization point after writes and before disk validation. */
  beforeSnapshotValidation?(snapshotDirectory: string): Promise<void> | void;
  /** Test-only observation after the snapshots-directory parent sync. */
  afterSnapshotsParentSync?(): Promise<void> | void;
  /** Test-only replacement for deterministic parent-sync fault injection. */
  syncSnapshotsParent?(state: SecureStateDirectory): Promise<void> | void;
}

interface DirectoryAnchor {
  handle: FileHandle;
  fd: number;
}

function parseSource(raw: unknown): ProjectSnapshotSource {
  const parsed = ProjectSnapshotSourceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ControlError("INVALID_PROJECT_SOURCE", "GitHub Project source failed strict validation", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function markdownCell(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f|]/g, (character) => character === "|" ? "\\|" : " ");
}

function renderMarkdown(items: readonly ProjectSnapshotItem[], pageId: string, total: number, nextPageId?: string): string {
  const rows = items.map((item) => [
    item.project_id,
    item.title,
    item.fields.status,
    item.fields.priority,
    item.fields.health,
    item.fields.next_action,
    item.fields.last_reviewed,
    item.stale ? "STALE" : "",
  ].map(markdownCell).join(" | "));
  return [
    "# Portfolio",
    "",
    `Page: ${pageId} · Total: ${total}`,
    "",
    "Project ID | Title | Status | Priority | Health | Next Action | Last Reviewed | Warning",
    "--- | --- | --- | --- | --- | --- | --- | ---",
    ...rows,
    "",
    ...(nextPageId ? [`Next Page: ${nextPageId}`, ""] : []),
  ].join("\n");
}

function serializedCliBytes(payload: BoundedPayload): number {
  return Buffer.byteLength(`${JSON.stringify({ command: "portfolio status", result: payload })}\n`, "utf8");
}

function pageName(index: number): string {
  return `page-${index + 1}`;
}

function boundedPages(items: readonly ProjectSnapshotItem[]): BoundedPayload[] {
  const pages: BoundedPayload[] = [];
  let offset = 0;
  while (offset < items.length || pages.length === 0) {
    const index = pages.length;
    const selected: ProjectSnapshotItem[] = [];
    while (offset + selected.length < items.length && selected.length < MAX_PAGE_ITEMS) {
      const candidateItems = [...selected, items[offset + selected.length] as ProjectSnapshotItem];
      const hasMore = offset + candidateItems.length < items.length;
      const candidate: BoundedPayload = {
        page_id: pageName(index),
        markdown: renderMarkdown(candidateItems, pageName(index), items.length, hasMore ? pageName(index + 1) : undefined),
        items: candidateItems,
        truncated: hasMore,
        total_items: items.length,
        ...(hasMore ? { next_page_id: pageName(index + 1) } : {}),
      };
      if (Buffer.byteLength(candidate.markdown, "utf8") > MAX_PAYLOAD_BYTES || serializedCliBytes(candidate) > MAX_PAYLOAD_BYTES) {
        if (selected.length === 0) {
          throw new ControlError("PORTFOLIO_ITEM_TOO_LARGE", "One portfolio item exceeds the bounded payload limit", {
            project_id: candidateItems[0]?.project_id,
          });
        }
        break;
      }
      selected.push(candidateItems[candidateItems.length - 1] as ProjectSnapshotItem);
    }

    const hasMore = offset + selected.length < items.length;
    const payload: BoundedPayload = {
      page_id: pageName(index),
      markdown: renderMarkdown(selected, pageName(index), items.length, hasMore ? pageName(index + 1) : undefined),
      items: selected,
      truncated: hasMore,
      total_items: items.length,
      ...(hasMore ? { next_page_id: pageName(index + 1) } : {}),
    };
    if (serializedCliBytes(payload) > MAX_PAYLOAD_BYTES) {
      throw new ControlError("PORTFOLIO_PAYLOAD_TOO_LARGE", "Portfolio payload exceeds its serialized byte boundary");
    }
    pages.push(payload);
    offset += selected.length;
    if (items.length === 0) break;
  }
  return pages;
}

function markdownPages(items: readonly ProjectSnapshotItem[]): string[] {
  const pages: string[] = [];
  let offset = 0;
  while (offset < items.length || pages.length === 0) {
    const selected: ProjectSnapshotItem[] = [];
    while (offset + selected.length < items.length && selected.length < MAX_PAGE_ITEMS) {
      const candidate = [...selected, items[offset + selected.length] as ProjectSnapshotItem];
      const hasMore = offset + candidate.length < items.length;
      const rendered = renderMarkdown(
        candidate,
        pageName(pages.length),
        items.length,
        hasMore ? pageName(pages.length + 1) : undefined,
      );
      if (Buffer.byteLength(rendered, "utf8") > MAX_PAYLOAD_BYTES) {
        if (selected.length === 0) {
          throw new ControlError("PORTFOLIO_ITEM_TOO_LARGE", "One portfolio markdown item exceeds the byte boundary");
        }
        break;
      }
      selected.push(candidate[candidate.length - 1] as ProjectSnapshotItem);
    }
    const hasMore = offset + selected.length < items.length;
    pages.push(renderMarkdown(
      selected,
      pageName(pages.length),
      items.length,
      hasMore ? pageName(pages.length + 1) : undefined,
    ));
    offset += selected.length;
    if (items.length === 0) break;
  }
  return pages;
}

function safeGeneratedDirectory(date: Date): { generatedAt: string; directoryName: string } {
  if (!Number.isFinite(date.getTime())) throw new ControlError("INVALID_CLOCK", "Snapshot clock returned an invalid date");
  const generatedAt = date.toISOString();
  return { generatedAt, directoryName: generatedAt.replaceAll(":", "-") };
}

async function openDirectoryAt(parentFd: number, name: string, create: boolean): Promise<DirectoryAnchor> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new ControlError("UNSAFE_SNAPSHOT_PATH", "Unsafe snapshot directory name");
  const path = `/proc/self/fd/${parentFd}/${name}`;
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (cause) {
      if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause;
    }
  }
  let handle: FileHandle;
  try {
    handle = await open(path, directoryFlags);
    const info = await handle.stat();
    if (!info.isDirectory()) throw new Error("not a directory");
    await handle.chmod(0o700);
  } catch {
    throw new ControlError("UNSAFE_SNAPSHOT_PATH", "Snapshot path is not a private regular directory");
  }
  return { handle, fd: handle.fd };
}

async function writeNewFile(directoryFd: number, name: string, contents: string): Promise<void> {
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.current\.[0-9a-f-]+\.tmp)$/.test(name)) {
    throw new ControlError("UNSAFE_SNAPSHOT_PATH", "Unsafe snapshot file name");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(`/proc/self/fd/${directoryFd}/${name}`, createFileFlags, 0o600);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (cause) {
    if (cause instanceof ControlError) throw cause;
    throw new ControlError("SNAPSHOT_WRITE_FAILED", "Unable to write a private snapshot component");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readVerifiedFile(directoryFd: number, name: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new ControlError("SNAPSHOT_VALIDATION_FAILED", "Snapshot component name is unsafe");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(`/proc/self/fd/${directoryFd}/${name}`, readFileFlags);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error("invalid type or mode");
    return await handle.readFile("utf8");
  } catch {
    throw new ControlError("SNAPSHOT_VALIDATION_FAILED", "Snapshot component failed descriptor-relative verification");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(directory: DirectoryAnchor): Promise<void> {
  try {
    await directory.handle.sync();
  } catch {
    throw new ControlError("SNAPSHOT_SYNC_FAILED", "Unable to durably sync the snapshot namespace");
  }
}

async function verifyWrittenSnapshot(
  snapshot: DirectoryAnchor,
  expectedJson: string,
  expectedPages: readonly string[],
  expectedChecksum: string,
): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(`/proc/self/fd/${snapshot.fd}`)).sort();
  } catch {
    throw new ControlError("SNAPSHOT_VALIDATION_FAILED", "Unable to enumerate written snapshot components");
  }
  const expectedNames = [
    "portfolio.json",
    ...expectedPages.map((_, index) => index === 0 ? "portfolio.md" : `portfolio.page-${index + 1}.md`),
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new ControlError("SNAPSHOT_VALIDATION_FAILED", "Snapshot page set does not match the expected export");
  }

  const actualJson = await readVerifiedFile(snapshot.fd, "portfolio.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(actualJson);
  } catch {
    throw new ControlError("SNAPSHOT_VALIDATION_FAILED", "On-disk portfolio JSON is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ControlError("SNAPSHOT_VALIDATION_FAILED", "On-disk portfolio JSON is not an object");
  }
  const disk = parsed as Record<string, unknown>;
  const { checksum, ...withoutChecksum } = disk;
  if (
    checksum !== expectedChecksum ||
    createHash("sha256").update(JSON.stringify(withoutChecksum)).digest("hex") !== expectedChecksum ||
    actualJson !== expectedJson ||
    !ProjectSnapshotSourceSchema.safeParse({
      project_node_id: disk.project_node_id,
      source_revision: disk.source_revision,
      field_definitions: disk.field_definitions,
      items: disk.items,
      total_count: disk.total_count,
    }).success
  ) {
    throw new ControlError("SNAPSHOT_VALIDATION_FAILED", "On-disk portfolio JSON checksum or schema is invalid");
  }
  for (const [index, expected] of expectedPages.entries()) {
    const name = index === 0 ? "portfolio.md" : `portfolio.page-${index + 1}.md`;
    if (await readVerifiedFile(snapshot.fd, name) !== expected) {
      throw new ControlError("SNAPSHOT_VALIDATION_FAILED", "On-disk portfolio page differs from the generated snapshot");
    }
  }
}

async function updateCurrentPointer(snapshotsFd: number, directoryName: string): Promise<void> {
  const temporary = `.current.${randomUUID()}.tmp`;
  try {
    await writeNewFile(snapshotsFd, temporary, `${directoryName}\n`);
    await rename(`/proc/self/fd/${snapshotsFd}/${temporary}`, `/proc/self/fd/${snapshotsFd}/current`);
    if (await readVerifiedFile(snapshotsFd, "current") !== `${directoryName}\n`) throw new Error("pointer mismatch");
  } catch (cause) {
    await unlink(`/proc/self/fd/${snapshotsFd}/${temporary}`).catch(() => undefined);
    if (cause instanceof ControlError) throw cause;
    throw new ControlError("SNAPSHOT_POINTER_FAILED", "Unable to advance the current snapshot pointer");
  }
}

/** Bounded live portfolio reader and one-way private snapshot exporter. */
export class PortfolioService {
  private readonly now: () => Date;
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(private readonly options: PortfolioServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.sensitiveData = options.sensitiveData ?? createSensitiveDataPolicy(process.env, [options.stateDir]);
  }

  async status(projectId?: string, pageId?: string): Promise<BoundedPayload> {
    const source = parseSource(await this.options.projectClient.readAll());
    this.sensitiveData.assertSafe(source);
    const items = projectId ? source.items.filter((item) => item.project_id === projectId) : source.items;
    const pages = boundedPages(items);
    const requested = pageId ?? "page-1";
    if (!/^page-[1-9][0-9]*$/.test(requested)) {
      throw new ControlError("INVALID_PAGE_ID", "Portfolio page ID is invalid");
    }
    const page = pages.find((candidate) => candidate.page_id === requested);
    if (!page) throw new ControlError("INVALID_PAGE_ID", "Portfolio page ID does not exist");
    return page;
  }

  async registerProject(input: RegisterProjectInput): Promise<ProjectRecordLink> {
    this.sensitiveData.assertSafe(input);
    if (!this.options.projectClient.registerProject) {
      throw new ControlError("PROJECT_REGISTRATION_UNAVAILABLE", "Project snapshot reader does not support registration");
    }
    return this.options.projectClient.registerProject(input);
  }

  async exportSnapshot(): Promise<SnapshotExportResult> {
    const source = parseSource(await this.options.projectClient.readAll());
    this.sensitiveData.assertSafe(source);
    const { generatedAt, directoryName } = safeGeneratedDirectory(this.now());
    const payloadWithoutChecksum = {
      schema_version: 1,
      generated_at: generatedAt,
      project_node_id: source.project_node_id,
      source_revision: source.source_revision,
      field_definitions: source.field_definitions,
      items: source.items,
      total_count: source.total_count,
    };
    const checksum = createHash("sha256").update(JSON.stringify(payloadWithoutChecksum)).digest("hex");
    const json = `${JSON.stringify({ ...payloadWithoutChecksum, checksum })}\n`;
    const pages = markdownPages(source.items);
    this.sensitiveData.assertSafe([json, pages]);

    let state: SecureStateDirectory | undefined;
    let snapshots: DirectoryAnchor | undefined;
    let snapshot: DirectoryAnchor | undefined;
    try {
      state = await openSecureStateDirectory(this.options.stateDir);
      snapshots = await openDirectoryAt(state.fd, "snapshots", true);
      // Repeat the parent sync on reuse: if a prior first-creation sync failed,
      // the empty namespace remains and EEXIST cannot prove it was durable.
      try {
        if (this.options.syncSnapshotsParent) await this.options.syncSnapshotsParent(state);
        else await state.sync();
      } catch {
        throw new ControlError("SNAPSHOT_SYNC_FAILED", "Unable to durably sync the snapshots parent namespace");
      }
      await this.options.afterSnapshotsParentSync?.();
      snapshot = await openDirectoryAt(snapshots.fd, directoryName, true);
      await writeNewFile(snapshot.fd, "portfolio.json", json);
      for (const [index, markdown] of pages.entries()) {
        await writeNewFile(snapshot.fd, index === 0 ? "portfolio.md" : `portfolio.page-${index + 1}.md`, markdown);
      }
      await this.options.beforeSnapshotValidation?.(`/proc/self/fd/${snapshot.fd}`);
      await verifyWrittenSnapshot(snapshot, json, pages, checksum);
      await syncDirectory(snapshot);
      await updateCurrentPointer(snapshots.fd, directoryName);
      await syncDirectory(snapshots);
    } finally {
      await snapshot?.handle.close().catch(() => undefined);
      await snapshots?.handle.close().catch(() => undefined);
      await state?.close().catch(() => undefined);
    }

    return {
      jsonPath: `${directoryName}/portfolio.json`,
      markdownPath: `${directoryName}/portfolio.md`,
      checksum,
    };
  }
}
