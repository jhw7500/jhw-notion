import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { ControlError } from "./errors.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";

const MAX_JOURNAL_LINE_BYTES = 4096;
const JOURNAL_FILE = "pilot-journal.jsonl";
const directoryOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const journalOpenFlags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY |
  constants.O_NOFOLLOW | constants.O_NONBLOCK;

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

/** Test-only synchronization point after the state directory has an FD anchor. */
export interface SecureStateDirectoryHooks {
  afterDirectoryOpen?(directory: SecureStateDirectory): Promise<void> | void;
  syncJournalFile?(file: FileHandle): Promise<void> | void;
  syncJournalDirectory?(directory: SecureStateDirectory): Promise<void> | void;
  afterJournalSync?(): Promise<void> | void;
}

export interface SecureStateDirectory {
  readonly path: string;
  readonly fd: number;
  openFile(name: string, flags: number, mode?: number): Promise<FileHandle>;
  sync(): Promise<void>;
  close(): Promise<void>;
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

function safeStateFileName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
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

class AnchoredStateDirectory implements SecureStateDirectory {
  constructor(readonly path: string, private readonly handle: FileHandle) {}

  get fd(): number {
    return this.handle.fd;
  }

  async openFile(name: string, flags: number, mode?: number): Promise<FileHandle> {
    if (!safeStateFileName(name)) throw unsafeStatePath();
    // The descriptor-backed path retains the directory inode even if a hostile
    // concurrent actor renames a validated ancestor after the open below.
    return open(`/proc/self/fd/${this.handle.fd}/${name}`, flags | constants.O_NOFOLLOW, mode);
  }

  async sync(): Promise<void> {
    await this.handle.sync();
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

/**
 * Validates every configured component and returns a retained, non-following
 * descriptor for the final state directory. Consumers must open child files
 * through this descriptor rather than re-resolving the configured path.
 */
export async function openSecureStateDirectory(
  stateDir: string,
  hooks: SecureStateDirectoryHooks = {},
): Promise<SecureStateDirectory> {
  if (!isAbsolute(stateDir)) throw unsafeStatePath();
  const root = parse(resolve(stateDir)).root;
  const target = resolve(stateDir);
  // Never treat a filesystem root as application-owned state: enforcing 0700
  // on it would alter a shared ancestor rather than a configured state dir.
  if (target === root) throw unsafeStatePath();
  const components = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    await secureDirectoryAt(current);
  }
  if (!isWithin(target, join(target, JOURNAL_FILE))) throw unsafeStatePath();

  let handle: FileHandle;
  try {
    handle = await open(target, directoryOpenFlags);
  } catch {
    throw unsafeStatePath();
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw unsafeStatePath();
    await handle.chmod(0o700);
    const directory = new AnchoredStateDirectory(target, handle);
    await hooks.afterDirectoryOpen?.(directory);
    return directory;
  } catch (cause) {
    await handle.close();
    if (cause instanceof ControlError) throw cause;
    throw unsafeStatePath();
  }
}

/**
 * A narrow append-only pilot journal. Events deliberately hold only stable
 * command metadata, never argument values or host-local paths.
 */
export class PilotJournal implements JournalPort {
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(
    private readonly stateDir: string,
    private readonly secureDirectoryHooks: SecureStateDirectoryHooks = {},
    sensitiveData?: SensitiveDataPolicy,
  ) {
    this.sensitiveData = sensitiveData ?? createSensitiveDataPolicy(process.env, [stateDir]);
  }

  async append(event: JournalEvent): Promise<void> {
    this.sensitiveData.assertSafe(event);
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_JOURNAL_LINE_BYTES) {
      throw new ControlError("JOURNAL_EVENT_TOO_LARGE", "Pilot journal event exceeds the atomic append boundary");
    }

    let directory: SecureStateDirectory | undefined;
    try {
      directory = await openSecureStateDirectory(this.stateDir, this.secureDirectoryHooks);
      const file = await directory.openFile(JOURNAL_FILE, journalOpenFlags, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) throw unsafeStatePath();
        await file.chmod(0o600);
        // One bounded write on an O_APPEND descriptor preserves a complete
        // event line across concurrently finishing read-only invocations.
        const bytes = Buffer.from(line, "utf8");
        const written = await file.write(bytes);
        if (written.bytesWritten !== bytes.length) {
          throw new ControlError("JOURNAL_WRITE_FAILED", "Pilot journal append was incomplete");
        }
        // The journal remains derived data, but once append resolves its line
        // and a newly-created namespace entry have crossed the durability gate.
        if (this.secureDirectoryHooks.syncJournalFile) {
          await this.secureDirectoryHooks.syncJournalFile(file);
        } else {
          // Full sync, rather than datasync, also covers the enforced 0600 mode.
          await file.sync();
        }
        if (this.secureDirectoryHooks.syncJournalDirectory) {
          await this.secureDirectoryHooks.syncJournalDirectory(directory);
        } else {
          await directory.sync();
        }
        await this.secureDirectoryHooks.afterJournalSync?.();
      } finally {
        await file.close();
      }
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      if (typeof cause === "object" && cause !== null && "code" in cause &&
        (cause.code === "ELOOP" || cause.code === "ENOTDIR" || cause.code === "ENXIO")) {
        throw unsafeStatePath();
      }
      throw new ControlError("JOURNAL_WRITE_FAILED", "Unable to append the pilot journal");
    } finally {
      await directory?.close();
    }
  }
}
