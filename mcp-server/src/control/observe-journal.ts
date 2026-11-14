import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { z } from "zod";

import { ControlError } from "./errors.js";
import type { SecureStateDirectory, SecureStateDirectoryHooks } from "./journal.js";
import { createObserveJournalLock, type MutationLock } from "./process.js";

const OBSERVE_JOURNAL_FILE = "guard-observe-journal.v1.jsonl";
const MAX_OBSERVE_LINE_BYTES = 8 * 1024;
const MAX_OBSERVE_READ_BYTES = 8 * 1024 * 1024;
const MAX_OBSERVE_READ_LINES = 8 * 1024;
// Rotate at half the hard bounds. A file this code leaves behind holds at most
// that much, so an older release that still fails at the hard bound has the
// other half as headroom before it gets there.
const ROTATE_OBSERVE_ROWS = MAX_OBSERVE_READ_LINES / 2;
const ROTATE_OBSERVE_BYTES = MAX_OBSERVE_READ_BYTES / 2;
const createFlags = constants.O_CREAT | constants.O_EXCL | constants.O_APPEND |
  constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const existingFlags = constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const identityFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function unavailable(message: string): ControlError {
  return new ControlError("JOURNAL_WRITE_FAILED", message);
}

function isAlreadyExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function archiveName(): string {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  return `guard-observe-journal.v1.${stamp}-${randomUUID()}.jsonl`;
}

export class ObserveJournal<Row> {
  readonly #stateDir: string;
  readonly #schema: z.ZodType<Row, z.ZodTypeDef, unknown>;
  readonly #hooks: SecureStateDirectoryHooks;
  readonly #lock: MutationLock;

  constructor(
    stateDir: string,
    schema: z.ZodType<Row, z.ZodTypeDef, unknown>,
    hooks: SecureStateDirectoryHooks = {},
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.#stateDir = resolve(stateDir);
    this.#schema = schema;
    this.#hooks = hooks;
    this.#lock = createObserveJournalLock(this.#stateDir, environment, hooks);
  }

  async append(input: Row): Promise<void> {
    const row = this.#schema.parse(input);
    const encoded = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
    if (encoded.byteLength > MAX_OBSERVE_LINE_BYTES) {
      throw unavailable("Guard observation journal row exceeds its bounded frame");
    }
    await this.#lock.runInStateDirectory((directory) => this.#appendLocked(directory, encoded));
  }

  async #appendLocked(directory: SecureStateDirectory, encoded: Buffer): Promise<void> {
    let file: FileHandle | undefined;
    try {
      let before: BigIntStats;
      let existing: { bytes: Buffer; rows: number };
      for (let rotated = false; ; rotated = true) {
        try {
          file = await directory.openFile(OBSERVE_JOURNAL_FILE, createFlags, 0o600);
        } catch (cause) {
          if (!isAlreadyExists(cause)) throw cause;
          file = await directory.openFile(OBSERVE_JOURNAL_FILE, existingFlags);
        }

        before = await file.stat({ bigint: true });
        this.#assertPrivateFile(before);
        // Validate before any bound decision: a file that fails validation is never moved.
        existing = await this.#readAndValidate(file, Number(before.size));
        const needsRotation = existing.rows >= ROTATE_OBSERVE_ROWS
          || before.size + BigInt(encoded.byteLength) > BigInt(ROTATE_OBSERVE_BYTES);
        if (!needsRotation || rotated) break;

        await this.#assertCurrentPathIdentity(directory, before);
        await file.close();
        file = undefined;
        await directory.renameWithin(OBSERVE_JOURNAL_FILE, archiveName());
        if (this.#hooks.syncJournalDirectory) await this.#hooks.syncJournalDirectory(directory);
        else await directory.sync();
      }
      if (before.size + BigInt(encoded.byteLength) > BigInt(MAX_OBSERVE_READ_BYTES)) {
        throw unavailable("Guard observation journal exceeds its bounded stream size");
      }
      if (existing.rows >= MAX_OBSERVE_READ_LINES) {
        throw unavailable("Guard observation journal exceeds its bounded row count");
      }

      const written = await file.write(encoded);
      if (written.bytesWritten !== encoded.byteLength) {
        throw unavailable("Guard observation journal append was incomplete");
      }
      if (this.#hooks.syncJournalFile) await this.#hooks.syncJournalFile(file);
      else await file.sync();
      if (this.#hooks.syncJournalDirectory) await this.#hooks.syncJournalDirectory(directory);
      else await directory.sync();
      await this.#hooks.afterJournalSync?.();

      const after = await file.stat({ bigint: true });
      this.#assertPrivateFile(after);
      if (
        after.dev !== before.dev
        || after.ino !== before.ino
        || after.uid !== before.uid
        || after.gid !== before.gid
        || after.size !== before.size + BigInt(encoded.byteLength)
        || after.mtimeNs < before.mtimeNs
        || after.ctimeNs < before.ctimeNs
      ) {
        throw unavailable("Guard observation journal identity changed during append");
      }
      await this.#assertCurrentPathIdentity(directory, after);
      const complete = await this.#readAndValidate(file, Number(after.size));
      if (complete.rows !== existing.rows + 1 || !complete.bytes.subarray(Number(before.size)).equals(encoded)) {
        throw unavailable("Guard observation journal did not publish one exact independent row");
      }
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw unavailable("Unable to publish the Guard observation journal row");
    } finally {
      await file?.close();
    }
  }

  async #readAndValidate(file: FileHandle, size: number): Promise<{ bytes: Buffer; rows: number }> {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBSERVE_READ_BYTES) {
      throw unavailable("Guard observation journal size is outside its bound");
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await file.read(bytes, offset, size - offset, offset);
      if (result.bytesRead <= 0) throw unavailable("Guard observation journal read was incomplete");
      offset += result.bytesRead;
    }
    if (bytes.length === 0) return { bytes, rows: 0 };
    if (bytes.at(-1) !== 0x0a) throw unavailable("Guard observation journal has an incomplete tail");

    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unavailable("Guard observation journal is not valid UTF-8");
    }
    const lines = decoded.slice(0, -1).split("\n");
    if (lines.length > MAX_OBSERVE_READ_LINES) {
      throw unavailable("Guard observation journal exceeds its bounded row count");
    }
    for (const line of lines) {
      if (line.length === 0 || Buffer.byteLength(`${line}\n`, "utf8") > MAX_OBSERVE_LINE_BYTES) {
        throw unavailable("Guard observation journal contains an invalid frame");
      }
      try {
        this.#schema.parse(JSON.parse(line));
      } catch {
        throw unavailable("Guard observation journal contains an invalid row");
      }
    }
    return { bytes, rows: lines.length };
  }

  #assertPrivateFile(info: BigIntStats): void {
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
    if (
      currentUid === undefined
      || !info.isFile()
      || info.nlink !== 1n
      || info.uid !== currentUid
      || (info.mode & 0o7777n) !== 0o600n
    ) {
      throw unavailable("Guard observation journal is not a current-user private file");
    }
  }

  async #assertCurrentPathIdentity(
    directory: SecureStateDirectory,
    retained: BigIntStats,
  ): Promise<void> {
    const current = await directory.openFile(OBSERVE_JOURNAL_FILE, identityFlags);
    try {
      const info = await current.stat({ bigint: true });
      this.#assertPrivateFile(info);
      if (!sameStableFile(retained, info)) {
        throw unavailable("Guard observation journal path metadata changed during append");
      }
    } finally {
      await current.close();
    }
  }
}
