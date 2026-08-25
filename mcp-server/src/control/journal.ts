import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { ControlError } from "./errors.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";

const MAX_JOURNAL_LINE_BYTES = 4096;
const MAX_CONFIGURABLE_JOURNAL_LINE_BYTES = 64 * 1024;
const JOURNAL_FILE = "pilot-journal.jsonl";
const directoryOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const journalBaseOpenFlags = constants.O_APPEND | constants.O_WRONLY |
  constants.O_NOFOLLOW | constants.O_NONBLOCK;
const journalOpenFlags = journalBaseOpenFlags | constants.O_CREAT;
const strictJournalCreateFlags = journalBaseOpenFlags | constants.O_CREAT | constants.O_EXCL;

export interface JournalEvent {
  command: string;
  task_id?: string;
  claim_id?: string;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  ok: boolean;
  error_code?: string;
  error_reason?: string;
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
  /**
   * Publishes one child name over another within this directory. A state file
   * that is replaced rather than appended needs this to stay anchored too:
   * resolving either side through the configured path again would reopen the
   * window the descriptor exists to close.
   */
  renameWithin(from: string, to: string): Promise<void>;
  /** Removes one child name, for abandoning a temporary that never published. */
  unlinkWithin(name: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type SecureStateDirectoryInspection =
  | { status: "not_initialized" }
  | { status: "ready"; directory: SecureStateDirectory };

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isAlreadyExists(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
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

async function secureDirectoryAt(path: string): Promise<boolean> {
  let info;
  let created = false;
  try {
    info = await lstat(path);
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (mkdirCause) {
      if (!isNotFound(mkdirCause) && !(typeof mkdirCause === "object" && mkdirCause !== null && "code" in mkdirCause && mkdirCause.code === "EEXIST")) {
        throw mkdirCause;
      }
    }
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeStatePath();
  return created;
}

async function existingDirectoryAt(path: string): Promise<"ready" | "not_initialized"> {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) return "not_initialized";
    throw unsafeStatePath();
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeStatePath();
  return "ready";
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
    return open(this.child(name), flags | constants.O_NOFOLLOW, mode);
  }

  async renameWithin(from: string, to: string): Promise<void> {
    if (!safeStateFileName(from) || !safeStateFileName(to)) throw unsafeStatePath();
    await rename(this.child(from), this.child(to));
  }

  async unlinkWithin(name: string): Promise<void> {
    if (!safeStateFileName(name)) throw unsafeStatePath();
    await unlink(this.child(name));
  }

  async sync(): Promise<void> {
    await this.handle.sync();
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private child(name: string): string {
    return `/proc/self/fd/${this.handle.fd}/${name}`;
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
  options: { strictExistingMode?: boolean } = {},
): Promise<SecureStateDirectory> {
  if (!isAbsolute(stateDir)) throw unsafeStatePath();
  const root = parse(resolve(stateDir)).root;
  const target = resolve(stateDir);
  // Never treat a filesystem root as application-owned state: enforcing 0700
  // on it would alter a shared ancestor rather than a configured state dir.
  if (target === root) throw unsafeStatePath();
  const components = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  let targetCreated = false;
  for (const component of components) {
    current = join(current, component);
    const created = await secureDirectoryAt(current);
    if (current === target) targetCreated = created;
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
    if (options.strictExistingMode && !targetCreated) {
      if ((info.mode & 0o777) !== 0o700) throw unsafeStatePath();
    } else {
      await handle.chmod(0o700);
    }
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
 * Strict diagnostic counterpart to `openSecureStateDirectory`. It opens an
 * already-initialized private directory through the same retained descriptor,
 * but never creates a component, chmods it, acquires a lock, or rewrites state.
 * Missing state is a safe bootstrap condition; an existing unsafe path is not.
 */
export async function inspectSecureStateDirectory(
  stateDir: string,
  hooks: SecureStateDirectoryHooks = {},
): Promise<SecureStateDirectoryInspection> {
  if (!isAbsolute(stateDir)) throw unsafeStatePath();
  const root = parse(resolve(stateDir)).root;
  const target = resolve(stateDir);
  if (target === root) throw unsafeStatePath();
  const components = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    if (await existingDirectoryAt(current) === "not_initialized") {
      return { status: "not_initialized" };
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(target, directoryOpenFlags);
  } catch (cause) {
    if (isNotFound(cause)) return { status: "not_initialized" };
    throw unsafeStatePath();
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw unsafeStatePath();
    const directory = new AnchoredStateDirectory(target, handle);
    await hooks.afterDirectoryOpen?.(directory);
    return { status: "ready", directory };
  } catch (cause) {
    await handle.close().catch(() => undefined);
    if (cause instanceof ControlError) throw cause;
    throw unsafeStatePath();
  }
}

export interface JournalLineLabels {
  tooLarge: string;
  incomplete: string;
  failed: string;
}

export interface BoundedJournalAppendOptions {
  maximumLineBytes?: number;
  strictExistingStateDirectory?: boolean;
  strictExistingFileMode?: boolean;
}

/**
 * The one bounded, hardened append used by every journal stream. Streams
 * differ only in file name and message labels; the safety mechanics — line
 * bound, O_APPEND|O_NOFOLLOW, single-link 0600 enforcement, complete-write
 * check, sync cascade, and unsafe-path errno mapping — live here once so a
 * future hardening fix cannot silently apply to one stream and not another.
 */
export async function appendBoundedJournalLine(
  stateDir: string,
  hooks: SecureStateDirectoryHooks,
  sensitiveData: SensitiveDataPolicy,
  fileName: string,
  event: unknown,
  labels: JournalLineLabels,
  options: BoundedJournalAppendOptions = {},
): Promise<void> {
  sensitiveData.assertSafe(event);
  const line = `${JSON.stringify(event)}\n`;
  const maximumLineBytes = options.maximumLineBytes ?? MAX_JOURNAL_LINE_BYTES;
  if (
    !Number.isSafeInteger(maximumLineBytes)
    || maximumLineBytes <= 0
    || maximumLineBytes > MAX_CONFIGURABLE_JOURNAL_LINE_BYTES
    || Buffer.byteLength(line, "utf8") > maximumLineBytes
  ) {
    throw new ControlError("JOURNAL_EVENT_TOO_LARGE", labels.tooLarge);
  }

  let directory: SecureStateDirectory | undefined;
  try {
    directory = await openSecureStateDirectory(
      stateDir,
      hooks,
      { strictExistingMode: options.strictExistingStateDirectory },
    );
    let created = false;
    let file: FileHandle;
    if (options.strictExistingFileMode) {
      try {
        file = await directory.openFile(fileName, strictJournalCreateFlags, 0o600);
        created = true;
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause;
        file = await directory.openFile(fileName, journalBaseOpenFlags);
      }
    } else {
      file = await directory.openFile(fileName, journalOpenFlags, 0o600);
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw unsafeStatePath();
      if (options.strictExistingFileMode && !created) {
        if ((info.mode & 0o777) !== 0o600) throw unsafeStatePath();
      } else {
        await file.chmod(0o600);
      }
      // One bounded write on an O_APPEND descriptor preserves a complete
      // event line across concurrently finishing read-only invocations.
      const bytes = Buffer.from(line, "utf8");
      const written = await file.write(bytes);
      if (written.bytesWritten !== bytes.length) {
        throw new ControlError("JOURNAL_WRITE_FAILED", labels.incomplete);
      }
      // The journal remains derived data, but once append resolves its line
      // and a newly-created namespace entry have crossed the durability gate.
      if (hooks.syncJournalFile) {
        await hooks.syncJournalFile(file);
      } else {
        // Full sync, rather than datasync, also covers the enforced 0600 mode.
        await file.sync();
      }
      if (hooks.syncJournalDirectory) {
        await hooks.syncJournalDirectory(directory);
      } else {
        await directory.sync();
      }
      await hooks.afterJournalSync?.();
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (cause instanceof ControlError) throw cause;
    if (typeof cause === "object" && cause !== null && "code" in cause &&
      (cause.code === "ELOOP" || cause.code === "ENOTDIR" || cause.code === "ENXIO")) {
      throw unsafeStatePath();
    }
    throw new ControlError("JOURNAL_WRITE_FAILED", labels.failed);
  } finally {
    await directory?.close();
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
    await appendBoundedJournalLine(this.stateDir, this.secureDirectoryHooks, this.sensitiveData, JOURNAL_FILE, event, {
      tooLarge: "Pilot journal event exceeds the atomic append boundary",
      incomplete: "Pilot journal append was incomplete",
      failed: "Unable to append the pilot journal",
    });
  }
}
