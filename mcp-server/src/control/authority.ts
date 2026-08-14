import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, fsync } from "node:fs";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import { ControlError } from "./errors.js";
import { openSecureStateDirectory, type SecureStateDirectory } from "./journal.js";
import { AuthorityRecordSchema, type AuthorityRecord } from "./schemas.js";
import type { DatabaseName } from "../config.js";
import { CONTROL_TOOL_VERSION } from "./version.js";

const CACHE_SCHEMA = AuthorityRecordSchema.pick({ authority_epoch: true, mode: true });
const CACHE_FILE = "authority-cache.json";
const LOCK_FILE = "authority-cache.lock";
const temporaryCacheOpenFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
const lockOpenFlags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
const centralOpenFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
const centralDirectoryOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_NAMESPACE_DEPTH = 4096;

export interface AuthorityDecision {
  authority_epoch: number;
  mode: "legacy" | "registry";
  source: "central" | "compatibility";
}

interface AuthorityCache {
  authority_epoch: number;
  mode: "legacy" | "registry";
}

export interface AuthorityService {
  load(): Promise<AuthorityDecision>;
  assertNotionWriteAllowed(db: DatabaseName, operation: string): Promise<void>;
}

export interface CreateAuthorityServiceOptions {
  readCentral(): Promise<AuthorityRecord | null>;
  cachePath: string;
  writesDisabled: boolean;
  toolVersion?: string;
  /** Deterministic durability/failure hooks for tests; omitted in production. */
  cacheHooks?: AuthorityCacheHooks;
}

export interface AuthorityCacheHooks {
  afterTemporaryFileSync?(): Promise<void> | void;
  rename?(source: string, destination: string): Promise<void>;
  afterRename?(): Promise<void> | void;
  syncDirectory?(directoryFd: number): Promise<void>;
  afterDirectorySync?(directoryFd: number): Promise<void> | void;
}

function structuredError(
  code: string,
  operation: string,
  db: string,
  route: string,
): ControlError {
  const payload = { code, operation, db, route };
  return new ControlError(code, JSON.stringify(payload), payload);
}

function authorityUnavailable(operation = "authority.load", db = "unknown"): ControlError {
  return structuredError(
    "AUTHORITY_UNAVAILABLE",
    operation,
    db,
    "Retry only after the central Registry authority record is available; do not write protected Notion state.",
  );
}

function epochRollback(operation = "authority.load", db = "unknown"): ControlError {
  return structuredError(
    "AUTHORITY_EPOCH_ROLLBACK",
    operation,
    db,
    "Fix the Registry authority epoch; reverse cutover requires an approved reconciliation workflow.",
  );
}

function moved(operation: string, db: string): ControlError {
  const route = db === "decisionLog"
    ? "Route formal decisions to a Git ADR."
    : "Route Project state through `jhw-control project register` and the Project workflow.";
  return structuredError("AUTHORITY_MOVED", operation, db, route);
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function safeCacheLocation(cachePath: string): { stateDir: string; fileName: string } {
  if (!isAbsolute(cachePath) || basename(cachePath) !== CACHE_FILE) throw authorityUnavailable();
  return { stateDir: dirname(cachePath), fileName: CACHE_FILE };
}

function readJson<T>(text: string, parse: (value: unknown) => T): T {
  return parse(JSON.parse(text));
}

async function readCache(directory: SecureStateDirectory, fileName: string): Promise<AuthorityCache | null> {
  let file: FileHandle | undefined;
  try {
    file = await directory.openFile(fileName, constants.O_RDONLY);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw authorityUnavailable();
    return readJson(await file.readFile("utf8"), (value) => {
      const result = CACHE_SCHEMA.safeParse(value);
      if (!result.success) throw authorityUnavailable();
      return result.data;
    });
  } catch (cause) {
    if (isNotFound(cause)) return null;
    if (cause instanceof ControlError) throw cause;
    throw authorityUnavailable();
  } finally {
    await file?.close();
  }
}

function descriptorPath(directory: SecureStateDirectory, name: string): string {
  return `/proc/self/fd/${directory.fd}/${name}`;
}

function syncDirectoryFd(directoryFd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsync(directoryFd, (error) => error ? reject(error) : resolve());
  });
}

async function writeCache(
  directory: SecureStateDirectory,
  fileName: string,
  cache: AuthorityCache,
  hooks: AuthorityCacheHooks = {},
): Promise<void> {
  const expected = `${JSON.stringify(cache)}\n`;
  const temporaryName = `.${fileName}.${randomUUID()}.tmp`;
  let temporary: FileHandle | undefined;
  let published: FileHandle | undefined;
  try {
    temporary = await directory.openFile(temporaryName, temporaryCacheOpenFlags, 0o600);
    let info = await temporary.stat();
    if (!info.isFile() || info.nlink !== 1) throw authorityUnavailable();
    await temporary.chmod(0o600);
    info = await temporary.stat();
    if ((info.mode & 0o777) !== 0o600) throw authorityUnavailable();
    await temporary.writeFile(expected, "utf8");
    await temporary.sync();
    await hooks.afterTemporaryFileSync?.();
    await temporary.close();
    temporary = undefined;

    await (hooks.rename ?? rename)(descriptorPath(directory, temporaryName), descriptorPath(directory, fileName));
    await hooks.afterRename?.();

    published = await directory.openFile(fileName, constants.O_RDONLY);
    const publishedInfo = await published.stat();
    if (!publishedInfo.isFile() || publishedInfo.nlink !== 1 || (publishedInfo.mode & 0o777) !== 0o600) {
      throw authorityUnavailable();
    }
    if (await published.readFile("utf8") !== expected) throw authorityUnavailable();
    await published.close();
    published = undefined;
  } catch (cause) {
    if (cause instanceof ControlError) throw cause;
    throw authorityUnavailable();
  } finally {
    await temporary?.close().catch(() => undefined);
    await published?.close().catch(() => undefined);
    await unlink(descriptorPath(directory, temporaryName)).catch(() => undefined);
  }
}

async function syncCacheNamespace(
  directory: SecureStateDirectory,
  hooks: AuthorityCacheHooks = {},
): Promise<void> {
  let current: FileHandle | undefined;
  let parent: FileHandle | undefined;
  let retired: FileHandle | undefined;
  const visited = new Set<string>();
  let reachedRoot = false;
  try {
    current = await open(descriptorPath(directory, "."), centralDirectoryOpenFlags);
    for (let depth = 0; depth < MAX_NAMESPACE_DEPTH; depth += 1) {
      const currentInfo = await current.stat();
      if (!currentInfo.isDirectory()) throw authorityUnavailable();
      const key = `${currentInfo.dev}:${currentInfo.ino}`;
      if (visited.has(key)) throw authorityUnavailable();
      visited.add(key);

      await (hooks.syncDirectory ?? syncDirectoryFd)(current.fd);
      await hooks.afterDirectorySync?.(current.fd);

      parent = await open(`/proc/self/fd/${current.fd}/..`, centralDirectoryOpenFlags);
      const parentInfo = await parent.stat();
      if (!parentInfo.isDirectory()) throw authorityUnavailable();
      if (parentInfo.dev === currentInfo.dev && parentInfo.ino === currentInfo.ino) {
        await parent.close();
        parent = undefined;
        reachedRoot = true;
        break;
      }

      retired = current;
      current = parent;
      parent = undefined;
      await retired.close();
      retired = undefined;
    }
    if (!reachedRoot) throw authorityUnavailable();
    await current.close();
    current = undefined;
  } catch (cause) {
    if (cause instanceof ControlError) throw cause;
    throw authorityUnavailable();
  } finally {
    await parent?.close().catch(() => undefined);
    await retired?.close().catch(() => undefined);
    await current?.close().catch(() => undefined);
  }
}

function acquireLock(file: FileHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("flock", ["-x", "3"], {
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "ignore", file.fd],
      });
    } catch {
      reject(authorityUnavailable());
      return;
    }
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once("error", () => settle(() => reject(authorityUnavailable())));
    child.once("close", (status) => settle(() => status === 0 ? resolve() : reject(authorityUnavailable())));
  });
}

async function withCacheLock<T>(
  cachePath: string,
  callback: (directory: SecureStateDirectory, fileName: string) => Promise<T>,
): Promise<T> {
  const { stateDir, fileName } = safeCacheLocation(cachePath);
  let directory: SecureStateDirectory | undefined;
  let lock: FileHandle | undefined;
  try {
    directory = await openSecureStateDirectory(stateDir);
    lock = await directory.openFile(LOCK_FILE, lockOpenFlags, 0o600);
    const lockInfo = await lock.stat();
    if (!lockInfo.isFile() || lockInfo.nlink !== 1) throw authorityUnavailable();
    await lock.chmod(0o600);
    await acquireLock(lock);
    return await callback(directory, fileName);
  } catch (cause) {
    if (cause instanceof ControlError && (cause.code.startsWith("AUTHORITY_") || cause.code === "TOOL_VERSION_TOO_OLD")) throw cause;
    throw authorityUnavailable();
  } finally {
    await lock?.close();
    await directory?.close();
  }
}

function validateCentral(value: AuthorityRecord | null): AuthorityRecord | null {
  if (value === null) return null;
  const result = AuthorityRecordSchema.safeParse(value);
  if (!result.success) throw authorityUnavailable();
  return result.data;
}

function semver(value: string): [number, number, number] | undefined {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts as [number, number, number] : undefined;
}

function enforceMinimumToolVersion(central: AuthorityRecord, actualVersion: string): void {
  const minimum = semver(central.minimum_tool_version);
  const actual = semver(actualVersion);
  if (!minimum || !actual) throw authorityUnavailable();
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] as number) > (minimum[index] as number)) return;
    if ((actual[index] as number) < (minimum[index] as number)) {
      throw new ControlError("TOOL_VERSION_TOO_OLD", "Control tool does not satisfy central authority minimum version");
    }
  }
}

export function createAuthorityService(options: CreateAuthorityServiceOptions): AuthorityService {
  return {
    async load(): Promise<AuthorityDecision> {
      return withCacheLock(options.cachePath, async (directory, fileName) => {
        const cache = await readCache(directory, fileName);
        let central: AuthorityRecord | null;
        try {
          central = validateCentral(await options.readCentral());
        } catch (cause) {
          if (cause instanceof ControlError) throw cause;
          throw authorityUnavailable();
        }

        if (!central) {
          if (cache) throw authorityUnavailable();
          return { authority_epoch: 0, mode: "legacy", source: "compatibility" };
        }
        enforceMinimumToolVersion(central, options.toolVersion ?? CONTROL_TOOL_VERSION);
        if (cache && central.authority_epoch < cache.authority_epoch) throw epochRollback();
        if (cache?.mode === "registry" && central.mode !== "registry") throw epochRollback();

        const next: AuthorityCache = {
          authority_epoch: central.authority_epoch,
          mode: central.mode,
        };
        if (!cache || cache.authority_epoch !== next.authority_epoch || cache.mode !== next.mode) {
          await writeCache(directory, fileName, next, options.cacheHooks);
        }
        await syncCacheNamespace(directory, options.cacheHooks);
        return { ...next, source: "central" };
      });
    },

    async assertNotionWriteAllowed(db: DatabaseName, operation: string): Promise<void> {
      const protectedDatabase = db === "projects" || db === "decisionLog";
      if (options.writesDisabled) {
        await this.load();
        throw structuredError(
          "NOTION_WRITES_DISABLED",
          operation,
          db,
          "Local policy disables Notion writes; use the owning workflow or ask the operator to re-enable writes.",
        );
      }
      if (!protectedDatabase) return;
      const decision = await this.load();
      if (decision.mode === "registry") {
        throw moved(operation, db);
      }
    },
  };
}

function strictWritesDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.JHW_NOTION_WRITES_DISABLED === "true";
}

async function readCentralFromEnvironment(env: NodeJS.ProcessEnv): Promise<AuthorityRecord | null> {
  const registryDir = env.JHW_REGISTRY_DIR?.trim();
  if (!registryDir) return null;
  if (!isAbsolute(registryDir)) throw authorityUnavailable();
  let registry: FileHandle | undefined;
  let governance: FileHandle | undefined;
  let file: FileHandle | undefined;
  try {
    const target = resolve(registryDir);
    const root = parse(target).root;
    let current: FileHandle | undefined;
    try {
      current = await open(root, centralDirectoryOpenFlags);
      for (const component of relative(root, target).split(sep).filter(Boolean)) {
        const next = await open(`/proc/self/fd/${current.fd}/${component}`, centralDirectoryOpenFlags);
        if (!(await next.stat()).isDirectory()) {
          await next.close();
          throw authorityUnavailable();
        }
        await current.close();
        current = next;
      }
      registry = current;
    } catch {
      await current?.close().catch(() => undefined);
      throw authorityUnavailable();
    }
    try {
      governance = await open(`/proc/self/fd/${registry.fd}/governance`, centralDirectoryOpenFlags);
      if (!(await governance.stat()).isDirectory()) throw authorityUnavailable();
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw authorityUnavailable();
    }
    try {
      file = await open(`/proc/self/fd/${governance.fd}/authority.yaml`, centralOpenFlags);
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw authorityUnavailable();
    }
    const fileInfo = await file.stat();
    if (!fileInfo.isFile() || fileInfo.nlink !== 1) throw authorityUnavailable();
    const parsed: unknown = JSON.parse(await file.readFile("utf8"));
    const result = AuthorityRecordSchema.safeParse(parsed);
    if (!result.success) throw authorityUnavailable();
    return result.data;
  } catch (cause) {
    if (cause instanceof ControlError && cause.code === "AUTHORITY_UNAVAILABLE") throw cause;
    throw authorityUnavailable();
  } finally {
    await file?.close();
    await governance?.close();
    await registry?.close();
  }
}

export function loadAuthorityPolicy(env: NodeJS.ProcessEnv = process.env): Promise<AuthorityDecision> {
  const home = env.HOME?.trim() || homedir();
  const stateDir = env.JHW_CONTROL_STATE_DIR?.trim() || join(home, ".local/state/jhw-control");
  return createAuthorityService({
    readCentral: () => readCentralFromEnvironment(env),
    cachePath: join(stateDir, CACHE_FILE),
    writesDisabled: strictWritesDisabled(env),
  }).load();
}

export function createDefaultAuthorityService(env: NodeJS.ProcessEnv = process.env): AuthorityService {
  const home = env.HOME?.trim() || homedir();
  const stateDir = env.JHW_CONTROL_STATE_DIR?.trim() || join(home, ".local/state/jhw-control");
  return createAuthorityService({
    readCentral: () => readCentralFromEnvironment(env),
    cachePath: join(stateDir, CACHE_FILE),
    writesDisabled: strictWritesDisabled(env),
  });
}
