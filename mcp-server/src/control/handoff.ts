import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { ControlError } from "./errors.js";
import type { RegistryRecordStore } from "./codec.js";

export const MAX_HANDOFF_BYTES = 12 * 1024;

const canonicalTaskId = /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalClaimId = /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface HandoffInput {
  task_id: string;
  source_task_revision: string;
  claim_id: string;
  generated_at: string;
  progress?: string | readonly string[];
  git_state?: string | readonly string[];
  validation?: string | readonly string[];
  failures?: string | readonly string[];
  next_step?: string | readonly string[];
  related_adr_and_evidence?: string | readonly string[];
}

interface HandoffSection {
  title: string;
  value: string | readonly string[] | undefined;
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function literalText(value: string | readonly string[] | undefined): string {
  const joined = typeof value === "string" ? value : value?.join("\n");
  const normalized = joined?.replace(/\r\n?|\n/g, "\n").trim() || "None recorded.";
  // Four leading spaces make every payload line literal Markdown code. This
  // neutralizes ATX/setext headings, fences, HTML, and CR-derived newlines.
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

/** Truncates at a JavaScript code point boundary, never in the middle of UTF-8. */
export function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0 || !value) return "";
  let used = 0;
  let result = "";
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (used + bytes > maximumBytes) break;
    result += codePoint;
    used += bytes;
  }
  return result;
}

function headerValue(value: string): string {
  return truncateUtf8(oneLine(value) || "unknown", 512);
}

/**
 * Builds a self-contained progress note.  Header metadata and exactly the six
 * permitted sections are retained even when caller-provided progress is huge.
 */
export function buildHandoff(input: HandoffInput): string {
  const header = [
    `# Handoff: ${headerValue(input.task_id)}`,
    `source_task_id: ${headerValue(input.task_id)}`,
    `source_task_revision: ${headerValue(input.source_task_revision)}`,
    `claim_id: ${headerValue(input.claim_id)}`,
    `generated_at: ${headerValue(input.generated_at)}`,
    "",
  ].join("\n");
  const sections: HandoffSection[] = [
    { title: "Progress Since Last Checkpoint", value: input.progress },
    { title: "Git State", value: input.git_state },
    { title: "Validation Performed", value: input.validation },
    { title: "Failures and Uncertainty", value: input.failures },
    { title: "Session-Local Next Step", value: input.next_step },
    { title: "Related ADR and Evidence", value: input.related_adr_and_evidence },
  ];

  // Account for every structural newline (including separators between sections)
  // before allocating dynamic bytes, so all six sections can be full at once.
  const reserved = Buffer.byteLength(
    `${header}\n${sections.map((section) => `## ${section.title}\n\n`).join("\n")}`,
    "utf8",
  );
  const perSection = Math.max(0, Math.floor((MAX_HANDOFF_BYTES - reserved) / sections.length));
  const body = sections.map((section) => {
    const bounded = truncateUtf8(literalText(section.value), perSection);
    return `## ${section.title}\n${bounded}\n`;
  }).join("\n");
  return `${header}\n${body}`;
}

export interface HandoffMetadata {
  task_id: string;
  source_task_revision: string;
  claim_id: string;
  generated_at: string;
}

const handoffSectionTitles = [
  "Progress Since Last Checkpoint",
  "Git State",
  "Validation Performed",
  "Failures and Uncertainty",
  "Session-Local Next Step",
  "Related ADR and Evidence",
] as const;

export type HandoffSectionTitle = typeof handoffSectionTitles[number];

/** Parses only the fixed metadata header of a previously committed Handoff. */
export function parseHandoffMetadata(content: string): HandoffMetadata {
  const lines = content.split("\n");
  const title = lines[0]?.match(/^# Handoff: (.+)$/);
  const task = lines[1]?.match(/^source_task_id: (.+)$/);
  const revision = lines[2]?.match(/^source_task_revision: (.+)$/);
  const claim = lines[3]?.match(/^claim_id: (.+)$/);
  const generated = lines[4]?.match(/^generated_at: (.+)$/);
  if (!title || !task || !revision || !claim || !generated || title[1] !== task[1]) {
    throw new ControlError("INVALID_HANDOFF_EVIDENCE", "Committed Handoff has an invalid metadata header");
  }
  return {
    task_id: task[1],
    source_task_revision: revision[1],
    claim_id: claim[1],
    generated_at: generated[1],
  };
}

/** Reads literal payloads from the fixed six-section Handoff structure. */
export function parseHandoffSections(content: string): Record<HandoffSectionTitle, string> {
  const sections = {} as Record<HandoffSectionTitle, string>;
  let cursor = content.indexOf("\n## ");
  if (cursor < 0) throw new ControlError("INVALID_HANDOFF_EVIDENCE", "Committed Handoff has no section body");
  for (let index = 0; index < handoffSectionTitles.length; index += 1) {
    const title = handoffSectionTitles[index];
    const marker = `\n## ${title}\n`;
    if (!content.startsWith(marker, cursor)) {
      throw new ControlError("INVALID_HANDOFF_EVIDENCE", "Committed Handoff section order is invalid", { title });
    }
    const payloadStart = cursor + marker.length;
    const next = index + 1 < handoffSectionTitles.length
      ? content.indexOf(`\n## ${handoffSectionTitles[index + 1]}\n`, payloadStart)
      : content.length;
    if (next < 0) {
      throw new ControlError("INVALID_HANDOFF_EVIDENCE", "Committed Handoff section is missing", { title });
    }
    const payload = content.slice(payloadStart, next).replace(/\n$/, "");
    const lines = payload.split("\n");
    if (lines.some((line) => !line.startsWith("    "))) {
      throw new ControlError("INVALID_HANDOFF_EVIDENCE", "Committed Handoff section is not literal text", { title });
    }
    sections[title] = lines.map((line) => line.slice(4)).join("\n");
    cursor = next;
  }
  return sections;
}

export function canonicalHandoffPath(taskId: string, claimId: string): string {
  if (!canonicalTaskId.test(taskId) || !canonicalClaimId.test(claimId)) {
    throw new ControlError("INVALID_HANDOFF_PATH", "Handoff paths require canonical Task and Claim IDs", {
      task_id: taskId,
      claim_id: claimId,
    });
  }
  return `handoffs/${taskId}/${claimId}.md`;
}

async function rootDirectory(path: string, code: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new ControlError(code, "Controlled root path must be absolute", { path });
  }
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (cause) {
    throw new ControlError(code, "Controlled root path is missing", {
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ControlError(code, "Controlled root path must be a non-symbolic directory", { path });
  }
  return realpath(path);
}

async function containedDirectory(root: string, component: string, code: string): Promise<string> {
  if (!component || component === "." || component === ".." || component.includes("/") || component.includes("\\")) {
    throw new ControlError(code, "Unsafe controlled path component", { component });
  }
  const candidate = join(root, component);
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (cause) {
    if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause;
  }
  const entry = await lstat(candidate);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ControlError(code, "Controlled path contains a symbolic link or non-directory", { candidate });
  }
  const resolved = await realpath(candidate);
  if (!isWithin(root, resolved)) {
    throw new ControlError(code, "Controlled path escapes its root", { root, candidate, resolved });
  }
  await chmod(candidate, 0o700);
  return resolved;
}

async function writeRegularFile(path: string, content: string, code: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new ControlError(code, "Controlled file path is not a regular file", { path });
    }
  } catch (cause) {
    if (cause instanceof ControlError) throw cause;
    if (!isNotFound(cause)) throw cause;
  }

  const temporary = join(join(path, ".."), `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (cause) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

/** Writes the host-local Handoff without following a `.ai` or file symlink. */
export async function writeWorktreeHandoff(worktreePath: string, content: string): Promise<string> {
  const worktreeRoot = await rootDirectory(worktreePath, "UNSAFE_WORKTREE_PATH");
  const aiDirectory = await containedDirectory(worktreeRoot, ".ai", "UNSAFE_HANDOFF_PATH");
  const handoffPath = join(aiDirectory, "handoff.md");
  await writeRegularFile(handoffPath, content, "UNSAFE_HANDOFF_PATH");
  return handoffPath;
}

/**
 * Writes a Claim-scoped Registry copy.  An existing copy is immutable: a retry
 * may reuse byte-identical evidence but cannot overwrite operator-recovery data.
 */
export async function writeRegistryHandoff(
  records: RegistryRecordStore,
  taskId: string,
  claimId: string,
  content: string,
  committed?: string,
): Promise<{ path: string; changed: boolean }> {
  const relativePath = canonicalHandoffPath(taskId, claimId);
  if (committed !== undefined) {
    if (committed === content) return { path: relativePath, changed: false };
    throw new ControlError("HANDOFF_EXISTS", "Registry Handoff already exists with different durable evidence", {
      path: relativePath,
    });
  }
  await records.assertAbsent(relativePath);
  await records.writeText(relativePath, content);
  return { path: relativePath, changed: true };
}
