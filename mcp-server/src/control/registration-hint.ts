import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { z } from "zod";

import { ControlError } from "./errors.js";

const STATE_FILE = "project-registrations.json";
const STATE_VERSION = 1;
const MAX_PENDING_PROJECTS = 64;

const coordinate = z.string().min(1).max(256).refine((value) => Buffer.byteLength(value, "utf8") <= 256);

const RegistrationHintSchema = z.object({
  project_id: coordinate,
  item_id: coordinate.optional(),
  source_node_id: coordinate.optional(),
}).strict();

const RegistrationHintStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  pending: z.record(coordinate, RegistrationHintSchema),
}).strict();

/**
 * What one interrupted registration left behind. A hint without coordinates
 * means a run was about to create the DraftIssue; a hint with them means it
 * created one and may not have finished writing its fields.
 */
export type RegistrationHint = z.infer<typeof RegistrationHintSchema>;
type RegistrationHintState = z.infer<typeof RegistrationHintStateSchema>;

/**
 * Remembers the coordinates a registration is about to create, so a later run
 * can find that DraftIssue instead of waiting for it to become visible. Every
 * method may fail: the caller treats this as a hint, never as authority.
 */
export interface RegistrationHintPort {
  /** The pending hint for one Project ID, or undefined when none is recorded. */
  read(projectId: string): Promise<RegistrationHint | undefined>;
  /** Publishes one hint durably before the irreversible step it describes. */
  record(hint: RegistrationHint): Promise<void>;
  /** Drops the hint for one Project ID once its registration has settled. */
  clear(projectId: string): Promise<void>;
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
  for (const [projectId, hint] of Object.entries(parsed.data.pending)) {
    if (hint.project_id !== projectId) {
      throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint is filed under another Project ID");
    }
  }
  return parsed.data;
}

/**
 * A durable, host-local record of registrations that reached their create step.
 * It lives beside the pilot journal under the same private state directory, but
 * unlike the journal it is read on the control path, so it is published through
 * a temporary file and a rename rather than appended.
 */
export class RegistrationHintStore implements RegistrationHintPort {
  constructor(
    private readonly stateDir: string,
    private readonly hooks: RegistrationHintStoreHooks = {},
  ) {}

  async read(projectId: string): Promise<RegistrationHint | undefined> {
    return (await this.load()).pending[projectId];
  }

  async record(hint: RegistrationHint): Promise<void> {
    const parsed = RegistrationHintSchema.safeParse(hint);
    if (!parsed.success) {
      throw new ControlError("INVALID_REGISTRATION_HINT", "Registration hint is not a bounded coordinate set");
    }
    const state = await this.load();
    const pending = { ...state.pending, [parsed.data.project_id]: parsed.data };
    // An unbounded pending set would mean hints are never being cleared, which
    // is a state-directory fault rather than something to keep growing through.
    if (Object.keys(pending).length > MAX_PENDING_PROJECTS) {
      throw new ControlError("INVALID_REGISTRATION_HINT_STATE", "Registration hint state holds too many pending projects");
    }
    await this.save({ version: STATE_VERSION, pending });
  }

  async clear(projectId: string): Promise<void> {
    const state = await this.load();
    if (!(projectId in state.pending)) return;
    const pending = { ...state.pending };
    delete pending[projectId];
    await this.save({ version: STATE_VERSION, pending });
  }

  private async load(): Promise<RegistrationHintState> {
    const statePath = await this.statePath();
    try {
      const entry = await lstat(statePath);
      if (entry.isSymbolicLink() || !entry.isFile()) throw unsafeStatePath({ path: statePath });
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      // No file is the ordinary first-registration state, not a fault.
      if (isNotFound(cause)) return { version: STATE_VERSION, pending: {} };
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
