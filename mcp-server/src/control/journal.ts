import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { ControlError } from "./errors.js";

const MAX_JOURNAL_LINE_BYTES = 4096;
const JOURNAL_FILE = "pilot-journal.jsonl";
const directoryOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const journalOpenFlags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;

export interface JournalEvent {
  command: string;
  task_id?: string;
  claim_id?: string;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  ok: boolean;
  error_code?: string;
  bypass_reason?: string;
  payload_bytes: number;
  active_work_minutes?: number;
}

export interface JournalPort {
  append(event: JournalEvent): Promise<void>;
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function unsafeStatePath(): ControlError {
  return new ControlError("UNSAFE_STATE_PATH", "Control state directory is not a private non-symbolic directory");
}

async function secureDirectoryAt(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (mkdirCause) {
      if (!isNotFound(mkdirCause) && !(typeof mkdirCause === "object" && mkdirCause !== null && "code" in mkdirCause && mkdirCause.code === "EEXIST")) {
        throw mkdirCause;
      }
    }
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeStatePath();
}

/**
 * Creates only missing configured state-directory components and rejects every
 * symbolic or non-directory component before obtaining a non-following final
 * directory descriptor. The descriptor is chmodded, never a potentially raced
 * path string.
 */
export async function ensureSecureStateDirectory(stateDir: string): Promise<string> {
  if (!isAbsolute(stateDir)) throw unsafeStatePath();
  const root = parse(resolve(stateDir)).root;
  const target = resolve(stateDir);
  const components = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    await secureDirectoryAt(current);
  }
  if (!isWithin(target, join(target, JOURNAL_FILE))) throw unsafeStatePath();

  let directory;
  try {
    directory = await open(target, directoryOpenFlags);
  } catch {
    throw unsafeStatePath();
  }
  try {
    const info = await directory.stat();
    if (!info.isDirectory()) throw unsafeStatePath();
    await directory.chmod(0o700);
  } catch (cause) {
    if (cause instanceof ControlError) throw cause;
    throw unsafeStatePath();
  } finally {
    await directory.close();
  }
  return target;
}

/**
 * A narrow append-only pilot journal. Events deliberately hold only stable
 * command metadata, never argument values or host-local paths.
 */
export class PilotJournal implements JournalPort {
  constructor(private readonly stateDir: string) {}

  async append(event: JournalEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_JOURNAL_LINE_BYTES) {
      throw new ControlError("JOURNAL_EVENT_TOO_LARGE", "Pilot journal event exceeds the atomic append boundary");
    }

    let stateDir: string;
    try {
      stateDir = await ensureSecureStateDirectory(this.stateDir);
      const journalPath = join(stateDir, JOURNAL_FILE);
      if (!isWithin(stateDir, journalPath)) throw unsafeStatePath();
      try {
        const existing = await lstat(journalPath);
        if (existing.isSymbolicLink() || !existing.isFile()) throw unsafeStatePath();
      } catch (cause) {
        if (!isNotFound(cause)) throw cause;
      }

      const file = await open(journalPath, journalOpenFlags, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile()) throw unsafeStatePath();
        await file.chmod(0o600);
        // One bounded write on an O_APPEND descriptor preserves a complete
        // event line across concurrently finishing read-only invocations.
        await file.write(Buffer.from(line, "utf8"));
      } finally {
        await file.close();
      }
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      if (typeof cause === "object" && cause !== null && "code" in cause && (cause.code === "ELOOP" || cause.code === "ENOTDIR")) {
        throw unsafeStatePath();
      }
      throw new ControlError("JOURNAL_WRITE_FAILED", "Unable to append the pilot journal");
    }
  }
}
