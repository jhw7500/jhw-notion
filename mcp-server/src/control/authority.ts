import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsync, openSync, readSync } from "node:fs";
import { open, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

import { ControlError } from "./errors.js";
import { openSecureStateDirectory, type SecureStateDirectory } from "./journal.js";
import { AuthorityRecordSchema, type AuthorityRecord } from "./schemas.js";
import type { DatabaseName } from "../config.js";
import { CONTROL_TOOL_VERSION } from "./version.js";
import { ProcessRunner } from "./process.js";

const CACHE_SCHEMA = z.object({
  authority_epoch: z.number().int().positive().safe(),
  mode: z.enum(["legacy", "registry"]),
}).strict();
const CACHE_FILE = "authority-cache.json";
const LOCK_FILE = "authority-cache.lock";
const temporaryCacheOpenFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
const lockOpenFlags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
const cacheReadOpenFlags = constants.O_RDONLY | constants.O_NONBLOCK;
const centralDirectoryOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_NAMESPACE_DEPTH = 4096;
const AUTHORITY_LOCK_TIMEOUT_MS = 5_000;
const CENTRAL_AUTHORITY_PATH = "governance/authority.yaml";
const MAX_CENTRAL_AUTHORITY_BYTES = 4_096;

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

/** Exact live policy for Phase 1A; later epochs/modes require an approved phase change. */
export function assertPhase1ACommittedLegacy(
  central: AuthorityRecord,
  decision: AuthorityDecision,
): void {
  if (
    central.authority_epoch !== 1 ||
    central.mode !== "legacy" ||
    central.cutover_at !== null ||
    decision.authority_epoch !== 1 ||
    decision.mode !== "legacy" ||
    decision.source !== "central"
  ) {
    throw new ControlError(
      "AUTHORITY_POLICY_NOT_LEGACY",
      "Phase 1A requires committed legacy authority epoch 1 with no cutover",
    );
  }
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
  /** Deterministic helper-process boundary injection for tests. */
  lockRuntime?: AuthorityLockRuntime;
  lockTimeoutMs?: number;
}

export interface AuthorityLockChild {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  kill?(signal?: NodeJS.Signals | number): unknown;
}

export interface AuthorityLockRuntime {
  spawn(
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "ignore", "ignore", number] },
  ): AuthorityLockChild;
}

const productionAuthorityLockRuntime: AuthorityLockRuntime = {
  spawn: (command, args, options) => spawn(command, args, options),
};

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
    : "Route Project state through `jhw-control project register`/`project update` and the Project workflow.";
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
    file = await directory.openFile(fileName, cacheReadOpenFlags);
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

    published = await directory.openFile(fileName, cacheReadOpenFlags);
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

function acquireLock(file: FileHandle, hooks: AuthorityCacheHooks = {}): Promise<void> {
  const deadline = hooks.lockTimeoutMs ?? AUTHORITY_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(deadline) || deadline <= 0 || deadline > 60_000) {
    return Promise.reject(authorityUnavailable());
  }
  return new Promise((resolve, reject) => {
    let child: AuthorityLockChild;
    try {
      child = (hooks.lockRuntime ?? productionAuthorityLockRuntime).spawn("flock", ["-x", "-n", "3"], {
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
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => settle(() => {
      try { child.kill?.("SIGKILL"); } catch { /* stable failure below */ }
      reject(authorityUnavailable());
    }), deadline);
    child.once("error", () => settle(() => reject(authorityUnavailable())));
    child.once("close", (status) => settle(() => status === 0 ? resolve() : reject(authorityUnavailable())));
  });
}

async function withCacheLock<T>(
  cachePath: string,
  hooks: AuthorityCacheHooks | undefined,
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
    await acquireLock(lock, hooks);
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
      return withCacheLock(options.cachePath, options.cacheHooks, async (directory, fileName) => {
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
    const runner = new ProcessRunner({ ...process.env, ...env });
    const cwd = `/proc/self/fd/${registry.fd}`;
    const rootBytes = await runner.runRaw("git", ["rev-parse", "--show-toplevel"], { cwd }, 4_096);
    const observedRoot = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rootBytes).trim();
    if (!isAbsolute(observedRoot) || /[\u0000-\u001f\u007f]/u.test(observedRoot)) throw authorityUnavailable();
    const [configuredInfo, rootInfo] = await Promise.all([registry.stat(), stat(observedRoot)]);
    if (
      !configuredInfo.isDirectory() ||
      !rootInfo.isDirectory() ||
      configuredInfo.dev !== rootInfo.dev ||
      configuredInfo.ino !== rootInfo.ino
    ) throw authorityUnavailable();
    const selected = await runner.runRaw(
      "git",
      ["ls-tree", "-z", "HEAD", "--", CENTRAL_AUTHORITY_PATH],
      { cwd },
      256,
    );
    if (selected.length === 0 || selected.at(-1) !== 0) throw authorityUnavailable();
    const selection = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(selected);
    const rows = selection.slice(0, -1).split("\0");
    if (rows.length !== 1 || !rows[0]) throw authorityUnavailable();
    const tab = rows[0].indexOf("\t");
    const [mode, type, objectId] = tab >= 0 ? rows[0].slice(0, tab).split(" ") : [];
    const path = tab >= 0 ? rows[0].slice(tab + 1) : "";
    if (
      (mode !== "100644" && mode !== "100755") ||
      type !== "blob" ||
      !/^[0-9a-f]{40,64}$/.test(objectId ?? "") ||
      path !== CENTRAL_AUTHORITY_PATH
    ) throw authorityUnavailable();
    const sizeBytes = await runner.runRaw("git", ["cat-file", "-s", objectId as string], { cwd }, 32);
    const sizeText = new TextDecoder("utf-8", { fatal: true }).decode(sizeBytes);
    if (!/^(?:0|[1-9][0-9]*)\n?$/.test(sizeText)) throw authorityUnavailable();
    const size = Number.parseInt(sizeText, 10);
    if (!Number.isSafeInteger(size) || size > MAX_CENTRAL_AUTHORITY_BYTES) throw authorityUnavailable();
    const bytes = await runner.runRaw(
      "git",
      ["cat-file", "blob", objectId as string],
      { cwd },
      MAX_CENTRAL_AUTHORITY_BYTES,
    );
    if (bytes.length !== size) throw authorityUnavailable();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    const result = AuthorityRecordSchema.safeParse(parsed);
    if (!result.success) throw authorityUnavailable();
    return result.data;
  } catch (cause) {
    if (cause instanceof ControlError && cause.code === "AUTHORITY_UNAVAILABLE") throw cause;
    throw authorityUnavailable();
  } finally {
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

const CONTROL_ENVIRONMENT_COMPONENTS = [".config", "jhw-control"];
const CONTROL_ENVIRONMENT_NAME = "control.env";
const CONTROL_ENVIRONMENT_MAX_BYTES = 64 * 1024;
const controlEnvironmentLine = /^(?:export[ \t]+)?JHW_REGISTRY_DIR=(.*)$/;

// The operator file is walked component by component (no symlinked parents),
// must be a regular single-link private file owned by this user, and is read
// non-blocking so a FIFO cannot stall the guard. Its text is parsed as
// literal KEY=VALUE lines and never shell-evaluated, and only the registry
// coordinate is taken — the cache location and every other knob stay derived
// from the process environment, so the file cannot relocate the epoch
// rollback evidence or leak a credential line.
function controlEnvironmentRegistryDir(home: string): string | null {
  let directory: number;
  try {
    directory = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch {
    return null;
  }
  let file: number;
  try {
    for (const component of CONTROL_ENVIRONMENT_COMPONENTS) {
      const next = openSync(`/proc/self/fd/${directory}/${component}`, centralDirectoryOpenFlags);
      closeSync(directory);
      directory = next;
    }
    file = openSync(
      `/proc/self/fd/${directory}/${CONTROL_ENVIRONMENT_NAME}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  } finally {
    closeSync(directory);
  }
  try {
    const info = fstatSync(file);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    ) {
      return null;
    }
    const buffer = Buffer.alloc(CONTROL_ENVIRONMENT_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(file, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
    }
    if (total > CONTROL_ENVIRONMENT_MAX_BYTES) return null;
    let selected: string | null = null;
    for (const raw of buffer.subarray(0, total).toString("utf8").split("\n")) {
      const match = controlEnvironmentLine.exec(raw.trim());
      if (!match) continue;
      let value = (match[1] as string).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      // The last assignment wins, matching what sourcing the file in a shell
      // would leave in the environment.
      if (value) selected = value;
    }
    return selected;
  } catch {
    return null;
  } finally {
    closeSync(file);
  }
}

// A guard process launched without the operator environment (a TUI-spawned
// MCP server) would otherwise fail closed against its own host cache even
// while the committed authority is legacy. A present-but-blank registry
// coordinate counts as absent; any non-blank explicit env always wins.
function withControlEnvironmentFallback(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.JHW_REGISTRY_DIR?.trim()) return env;
  const home = env.HOME?.trim() || homedir();
  const registryDir = controlEnvironmentRegistryDir(home);
  if (!registryDir) return env;
  return { ...env, JHW_REGISTRY_DIR: registryDir };
}

export function createDefaultAuthorityService(env: NodeJS.ProcessEnv = process.env): AuthorityService {
  const resolved = withControlEnvironmentFallback(env);
  const home = env.HOME?.trim() || homedir();
  const stateDir = env.JHW_CONTROL_STATE_DIR?.trim() || join(home, ".local/state/jhw-control");
  return createAuthorityService({
    readCentral: () => readCentralFromEnvironment(resolved),
    cachePath: join(stateDir, CACHE_FILE),
    writesDisabled: strictWritesDisabled(env),
  });
}
