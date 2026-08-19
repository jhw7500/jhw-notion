import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { z } from "zod";

import { ControlError } from "./errors.js";

const STATE_FILE = "project-registrations.json";
const STATE_VERSION = 1;
const MAX_TRACKED_PROJECTS = 256;

const coordinate = z.string().min(1).max(256).refine((value) => Buffer.byteLength(value, "utf8") <= 256);

const RegistrationHintSchema = z.object({
  project_id: coordinate,
  item_id: coordinate.optional(),
  source_node_id: coordinate.optional(),
}).strict();

const RegistrationHintStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  records: z.record(coordinate, RegistrationHintSchema),
}).strict();

/**
 * What this host knows about one Project Record it created. Without coordinates
 * it means a run was about to create the DraftIssue; with them it names the
 * DraftIssue that run created, whether or not that run went on to finish.
 */
export type RegistrationHint = z.infer<typeof RegistrationHintSchema>;
type RegistrationHintState = z.infer<typeof RegistrationHintStateSchema>;

export interface RegistrationHintLookup {
  /**
   * False until this host has recorded anything. A missing entry only means "no
   * record was created" once the store exists to have recorded one.
   */
  initialized: boolean;
  hint?: RegistrationHint;
}

/**
 * Remembers every Project Record this host has created, so a later run can find
 * one the Project has not made visible yet. Every method may fail: the caller
 * treats this as a hint, never as authority.
 */
export interface RegistrationHintPort {
  /** What this host knows about one Project ID. */
  read(projectId: string): Promise<RegistrationHintLookup>;
  /**
   * Publishes one hint durably. Entries are never removed on success: a record
   * that exists is exactly what a later registration needs to be told about.
   */
  record(hint: RegistrationHint): Promise<void>;
  /**
   * Establishes the store from a complete read of the Project. Until that has
   * happened a missing entry cannot mean "this host never created it", because
   * every record older than the store predates everything it could record.
   */
  seed(hints: readonly RegistrationHint[]): Promise<void>;
}

export interface RegistrationHintStoreHooks {
  beforeSave?(): Promise<void> | void;
  afterPublish?(path: string): Promise<void> | void;
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function unsafeStatePath(detail: Record<string, unknown> = {}): ControlError {
  return new ControlError("UNSAFE_STATE_PATH", "Registration hint state path is not a private regular file", detail);
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
 * A durable, host-local record of every Project Record this host created. It
 * lives beside the pilot journal under the same private state directory, but
 * unlike the journal it is read on the control path, so it is published through
 * a temporary file and a rename rather than appended.
 *
 * `record` is a read-modify-write over the whole file and is not atomic against
 * a concurrent one. Callers must already hold the host-global mutation lock —
 * every lifecycle command that reaches this store does — because a lost entry
 * is exactly what would let the next run skip its absence window.
 */
export class RegistrationHintStore implements RegistrationHintPort {
  constructor(
    private readonly stateDir: string,
    private readonly hooks: RegistrationHintStoreHooks = {},
  ) {}

  async read(projectId: string): Promise<RegistrationHintLookup> {
    const state = await this.load();
    if (!state) return { initialized: false };
    const hint = state.records[projectId];
    return hint === undefined ? { initialized: true } : { initialized: true, hint };
  }

  async record(hint: RegistrationHint): Promise<void> {
    await this.merge([hint]);
  }

  async seed(hints: readonly RegistrationHint[]): Promise<void> {
    // Publishing even an empty seed matters: it is what makes a later missing
    // entry mean "not on the board when this store was established".
    await this.merge(hints);
  }

  private async merge(hints: readonly RegistrationHint[]): Promise<void> {
    const entries: RegistrationHint[] = [];
    for (const hint of hints) {
      const parsed = RegistrationHintSchema.safeParse(hint);
      if (!parsed.success) {
        throw new ControlError("INVALID_REGISTRATION_HINT", "Registration hint is not a bounded coordinate set");
      }
      entries.push(parsed.data);
    }
    const state = await this.load();
    const records = { ...state?.records };
    for (const entry of entries) records[entry.project_id] = entry;
    // Entries are kept for the life of the record they name, so the bound is a
    // ceiling on projects this host has registered or tried to, not on
    // concurrent work. Refusing past it leaves the absence window in place.
    if (Object.keys(records).length > MAX_TRACKED_PROJECTS) {
      throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint state tracks too many projects");
    }
    await this.save({ version: STATE_VERSION, records });
  }

  /** The stored state, or undefined when this host has never written one. */
  private async load(): Promise<RegistrationHintState | undefined> {
    const statePath = await this.statePath();
    try {
      const entry = await lstat(statePath);
      if (entry.isSymbolicLink() || !entry.isFile()) throw unsafeStatePath({ path: statePath });
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(statePath, "utf8"));
    } catch (cause) {
      throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint state could not be parsed", {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return parseState(raw);
  }

  private async save(state: RegistrationHintState): Promise<void> {
    await this.hooks.beforeSave?.();
    const statePath = await this.statePath();
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const temporary = join(this.stateDir, `.project-registrations.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      // The hint only helps a run that starts after this one died, so it has to
      // reach the disk before the create it describes, not merely the cache.
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, statePath);
      await this.hooks.afterPublish?.(statePath);
      await this.syncDirectory();
    } catch (cause) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
  }

  private async syncDirectory(): Promise<void> {
    let directory: Awaited<ReturnType<typeof open>> | undefined;
    try {
      directory = await open(this.stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.sync();
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }

  private async statePath(): Promise<string> {
    if (!isAbsolute(this.stateDir)) throw unsafeStatePath({ state_dir: this.stateDir });
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const entry = await lstat(this.stateDir);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw unsafeStatePath({ state_dir: this.stateDir });
    await chmod(this.stateDir, 0o700);
    const root = await realpath(this.stateDir);
    const path = join(root, STATE_FILE);
    if (!isWithin(root, path)) throw unsafeStatePath({ root, path });
    return path;
  }
}
