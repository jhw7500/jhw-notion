import { randomUUID } from "node:crypto";
import { constants } from "node:fs";

import { z } from "zod";

import { ControlError } from "./errors.js";
import { openSecureStateDirectory, type SecureStateDirectory } from "./journal.js";

const STATE_FILE = "project-registrations.json";
const STATE_VERSION = 1;
const MAX_TRACKED_PROJECTS = 256;
// The ceiling above bounds what this store writes; this bounds what it will
// read back, so a file already grown past it by some other hand is refused
// rather than loaded. A file that grows between the stat and the read is not
// covered, which needs a writer inside this trust boundary to arrange.
const MAX_STATE_BYTES = 1024 * 1024;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const createFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const coordinate = z.string().min(1).max(256).refine((value) => Buffer.byteLength(value, "utf8") <= 256);

const RegistrationHintSchema = z.object({
  project_id: coordinate,
  item_id: coordinate,
  source_node_id: coordinate,
}).strict();

const RegistrationHintStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  records: z.record(coordinate, RegistrationHintSchema),
}).strict();

/** Where one Project Record this host created can be read directly. */
export type RegistrationHint = z.infer<typeof RegistrationHintSchema>;
type RegistrationHintState = z.infer<typeof RegistrationHintStateSchema>;

/**
 * Remembers the DraftIssue a registration created, so a retry that runs while
 * the Project has not made it visible yet can read it by ID instead of waiting
 * for it to appear in a listing. Nothing here decides anything: a registration
 * that cannot read or write this store behaves exactly as it did without one.
 */
export interface RegistrationHintPort {
  /** The recorded coordinates for one Project ID, if this host has any. */
  read(projectId: string): Promise<RegistrationHint | undefined>;
  /** Records where a Project Record was created. */
  record(hint: RegistrationHint): Promise<void>;
}

export interface RegistrationHintStoreHooks {
  beforeSave?(): Promise<void> | void;
  afterPublish?(path: string): Promise<void> | void;
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function unsafeStatePath(): ControlError {
  return new ControlError("UNSAFE_STATE_PATH", "Registration hint state path is not a private regular file");
}

function parseState(raw: unknown): RegistrationHintState {
  const parsed = RegistrationHintStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint state failed strict validation");
  }
  for (const [projectId, hint] of Object.entries(parsed.data.records)) {
    if (hint.project_id !== projectId) {
      throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint is filed under another Project ID");
    }
  }
  return parsed.data;
}

/**
 * A durable, host-local index of Project Records this host created. It lives
 * beside the pilot journal under the same private state directory, but unlike
 * the journal it is read on the control path, so it is published through a
 * temporary file and a rename rather than appended.
 *
 * `record` is a read-modify-write over the whole file and is not atomic against
 * a concurrent one. Callers hold the host-global mutation lock — every
 * lifecycle command that reaches this store does — so a lost entry would only
 * cost a later registration its shortcut, never its correctness.
 */
export class RegistrationHintStore implements RegistrationHintPort {
  constructor(
    private readonly stateDir: string,
    private readonly hooks: RegistrationHintStoreHooks = {},
  ) {}

  async read(projectId: string): Promise<RegistrationHint | undefined> {
    return this.withDirectory(async (directory) => (await this.load(directory))?.records[projectId]);
  }

  async record(hint: RegistrationHint): Promise<void> {
    const parsed = RegistrationHintSchema.safeParse(hint);
    if (!parsed.success) {
      throw new ControlError("INVALID_REGISTRATION_HINT", "Registration hint is not a bounded coordinate set");
    }
    await this.withDirectory(async (directory) => {
      const state = await this.load(directory);
      const records = { ...state?.records, [parsed.data.project_id]: parsed.data };
      // Entries are kept for the life of the record they name, so the bound is
      // a ceiling on projects this host has registered rather than on
      // concurrent work. Refusing past it costs a later retry its shortcut and
      // nothing else.
      if (Object.keys(records).length > MAX_TRACKED_PROJECTS) {
        throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint state tracks too many projects");
      }
      await this.save(directory, { version: STATE_VERSION, records });
    });
  }

  /** The stored state, or undefined when this host has never written one. */
  private async load(directory: SecureStateDirectory): Promise<RegistrationHintState | undefined> {
    let file;
    try {
      file = await directory.openFile(STATE_FILE, readFlags);
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw unsafeStatePath();
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw unsafeStatePath();
      if (info.size > MAX_STATE_BYTES) {
        throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint state is larger than this store writes");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await file.readFile("utf8"));
      } catch (cause) {
        throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint state could not be parsed", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      return parseState(raw);
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  private async save(directory: SecureStateDirectory, state: RegistrationHintState): Promise<void> {
    await this.hooks.beforeSave?.();
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const temporary = `.project-registrations.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<SecureStateDirectory["openFile"]>> | undefined;
    try {
      handle = await directory.openFile(temporary, createFlags, 0o600);
      // O_EXCL fixes the mode at creation, but umask can still clear bits from
      // it, so the mode is asserted rather than requested.
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      // The entry only helps a run that starts after this one died, so it has
      // to reach the disk rather than merely the cache.
      await handle.sync();
      await handle.close();
      handle = undefined;
      await directory.renameWithin(temporary, STATE_FILE);
      await this.hooks.afterPublish?.(directory.path);
      await directory.sync();
    } catch (cause) {
      if (handle) await handle.close().catch(() => undefined);
      await directory.unlinkWithin(temporary).catch(() => undefined);
      throw cause;
    }
  }

  /**
   * Every operation runs against one descriptor rather than re-resolving the
   * configured directory, so a read and the write that follows it cannot land
   * in two different directories.
   */
  private async withDirectory<T>(operation: (directory: SecureStateDirectory) => Promise<T>): Promise<T> {
    const directory = await openSecureStateDirectory(this.stateDir);
    try {
      return await operation(directory);
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
}
