import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import type { ZodType } from "zod";

import { ControlError } from "./errors.js";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
const temporaryFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

export interface RegistryHeadPort {
  assertHeadRegularFile(relativePath: string): Promise<void>;
}

export interface RecordIdentity {
  field: string;
  value: string;
}

export interface RegistryDirectoryEntry {
  name: string;
  kind: "file" | "directory";
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function descriptorPath(directory: FileHandle, name: string): string {
  return `/proc/self/fd/${directory.fd}/${name}`;
}

function safeRelativePath(value: string): string[] {
  if (!value || value.includes("\0") || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new ControlError("INVALID_REGISTRY_PATH", "Registry record path must be a safe relative path");
  }
  const normalized = normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`) || normalized !== value) {
    throw new ControlError("INVALID_REGISTRY_PATH", "Registry record path must be canonical and traversal-free");
  }
  const components = value.split("/");
  if (components.some((component) => !component || component === "." || component === ".." || component.includes("\\"))) {
    throw new ControlError("INVALID_REGISTRY_PATH", "Registry record path contains an unsafe component");
  }
  return components;
}

function corrupt(message: string, relativePath?: string): ControlError {
  return new ControlError("REGISTRY_CORRUPT", message, relativePath ? { relativePath } : {});
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

/**
 * Descriptor-relative Registry record I/O. Each operation resolves the absolute
 * configured root once, walks every component with O_NOFOLLOW, and retains the
 * resulting directory descriptors until the operation is complete.
 */
export class RegistryRecordStore {
  constructor(
    private readonly configuredRoot: string,
    private readonly head: RegistryHeadPort,
  ) {}

  async readJson<T>(relativePath: string, schema: ZodType<T>, identity?: RecordIdentity): Promise<T> {
    const value = await this.readOptionalJson(relativePath, schema, identity);
    if (value === undefined) throw corrupt("Required Registry record is missing", relativePath);
    return value;
  }

  async readOptionalJson<T>(relativePath: string, schema: ZodType<T>, identity?: RecordIdentity): Promise<T | undefined> {
    const components = safeRelativePath(relativePath);
    let root: FileHandle | undefined;
    let parent: FileHandle | undefined;
    let file: FileHandle | undefined;
    try {
      root = await this.openRoot();
      parent = await this.openParent(root, components.slice(0, -1), false);
      if (!parent) return undefined;
      try {
        file = await open(descriptorPath(parent, components.at(-1) as string), readFlags);
      } catch (cause) {
        if (isNotFound(cause)) return undefined;
        throw corrupt("Registry record leaf is symbolic or not a regular file", relativePath);
      }
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) {
        throw corrupt("Registry record leaf must be a single-link regular file", relativePath);
      }
      await this.head.assertHeadRegularFile(relativePath).catch((cause) => {
        if (cause instanceof ControlError && cause.code === "HANDOFF_MISSING") {
          throw corrupt("Existing Registry record is not a regular HEAD blob", relativePath);
        }
        throw cause;
      });
      let raw: unknown;
      try {
        raw = JSON.parse(await file.readFile("utf8"));
      } catch {
        throw corrupt("Registry record is not valid JSON-subset YAML", relativePath);
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw corrupt("Registry record failed schema validation", relativePath);
      if (identity) {
        const record = parsed.data as Record<string, unknown>;
        if (record[identity.field] !== identity.value) {
          throw corrupt("Registry record path and embedded identity disagree", relativePath);
        }
      }
      return parsed.data;
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw corrupt("Registry record could not be read safely", relativePath);
    } finally {
      await closeQuietly(file);
      if (parent !== root) await closeQuietly(parent);
      await closeQuietly(root);
    }
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Lists only direct regular-file names under a descriptor-retained directory. */
  async listRegularFileNames(relativeDirectory: string, maximumEntries: number): Promise<string[]> {
    return (await this.listDirectoryEntries(relativeDirectory, maximumEntries))
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.name);
  }

  async listDirectoryEntries(relativeDirectory: string, maximumEntries: number): Promise<RegistryDirectoryEntry[]> {
    const components = safeRelativePath(relativeDirectory);
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new ControlError("INVALID_REGISTRY_BOUND", "Registry listing requires a positive deterministic bound");
    }
    let root: FileHandle | undefined;
    let directory: FileHandle | undefined;
    try {
      root = await this.openRoot();
      directory = await this.openParent(root, components, false);
      if (!directory) return [];
      const entries = await readdir(descriptorPath(directory, "."), { withFileTypes: true });
      if (entries.length > maximumEntries) throw corrupt("Registry directory exceeds its deterministic bound", relativeDirectory);
      const output: RegistryDirectoryEntry[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isFile()) {
          throw corrupt("Registry directory contains a non-regular entry", relativeDirectory);
        }
        output.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" });
      }
      return output.sort((left, right) => left.name.localeCompare(right.name));
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw corrupt("Registry directory could not be listed safely", relativeDirectory);
    } finally {
      if (directory !== root) await closeQuietly(directory);
      await closeQuietly(root);
    }
  }

  /** Proves that both the checkout leaf and the exact HEAD entry are regular files. */
  async assertCommittedRegularFile(relativePath: string): Promise<void> {
    const components = safeRelativePath(relativePath);
    let root: FileHandle | undefined;
    let parent: FileHandle | undefined;
    let file: FileHandle | undefined;
    try {
      // Consult HEAD first so a missing/untracked required pointer retains the
      // stable HANDOFF_MISSING result instead of being mistaken for corruption.
      await this.head.assertHeadRegularFile(relativePath);
      root = await this.openRoot();
      parent = await this.openParent(root, components.slice(0, -1), false);
      if (!parent) throw corrupt("Committed Registry file is missing", relativePath);
      try {
        file = await open(descriptorPath(parent, components.at(-1) as string), readFlags);
      } catch {
        throw corrupt("Committed Registry file leaf is unavailable or symbolic", relativePath);
      }
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) {
        throw corrupt("Committed Registry file must be a single-link regular file", relativePath);
      }
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw corrupt("Committed Registry file could not be verified safely", relativePath);
    } finally {
      await closeQuietly(file);
      if (parent !== root) await closeQuietly(parent);
      await closeQuietly(root);
    }
  }

  /** Fails closed when an exclusive destination already exists in any form. */
  async assertAbsent(relativePath: string): Promise<void> {
    const components = safeRelativePath(relativePath);
    let root: FileHandle | undefined;
    let parent: FileHandle | undefined;
    let file: FileHandle | undefined;
    try {
      root = await this.openRoot();
      parent = await this.openParent(root, components.slice(0, -1), false);
      if (!parent) return;
      try {
        file = await open(descriptorPath(parent, components.at(-1) as string), readFlags);
      } catch (cause) {
        if (isNotFound(cause)) return;
        throw corrupt("Registry destination exists in an unsafe form", relativePath);
      }
      throw corrupt("Registry destination already exists", relativePath);
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw corrupt("Registry destination could not be inspected safely", relativePath);
    } finally {
      await closeQuietly(file);
      if (parent !== root) await closeQuietly(parent);
      await closeQuietly(root);
    }
  }

  /** Removes an existing committed record without resolving the leaf pathname again. */
  async remove(relativePath: string): Promise<void> {
    const components = safeRelativePath(relativePath);
    const leaf = components.at(-1) as string;
    let root: FileHandle | undefined;
    let parent: FileHandle | undefined;
    let file: FileHandle | undefined;
    try {
      root = await this.openRoot();
      parent = await this.openParent(root, components.slice(0, -1), false);
      if (!parent) throw corrupt("Registry record to remove is missing", relativePath);
      file = await open(descriptorPath(parent, leaf), readFlags).catch(() => {
        throw corrupt("Registry record to remove is unavailable or symbolic", relativePath);
      });
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1) {
        throw corrupt("Registry record to remove must be a single-link regular file", relativePath);
      }
      await this.head.assertHeadRegularFile(relativePath).catch(() => {
        throw corrupt("Registry record to remove is not a regular HEAD blob", relativePath);
      });
      await unlink(descriptorPath(parent, leaf));
      await parent.sync();
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw corrupt("Registry record could not be removed safely", relativePath);
    } finally {
      await closeQuietly(file);
      if (parent !== root) await closeQuietly(parent);
      await closeQuietly(root);
    }
  }

  async writeText(relativePath: string, contents: string): Promise<void> {
    const components = safeRelativePath(relativePath);
    const leaf = components.at(-1) as string;
    const temporaryName = `.${leaf}.${randomUUID()}.tmp`;
    let root: FileHandle | undefined;
    let parent: FileHandle | undefined;
    let existing: FileHandle | undefined;
    let temporary: FileHandle | undefined;
    let published: FileHandle | undefined;
    try {
      root = await this.openRoot();
      parent = await this.openParent(root, components.slice(0, -1), true);
      if (!parent) throw corrupt("Registry record parent could not be created", relativePath);

      try {
        existing = await open(descriptorPath(parent, leaf), readFlags);
        const info = await existing.stat();
        if (!info.isFile() || info.nlink !== 1) {
          throw corrupt("Registry record leaf must be a single-link regular file", relativePath);
        }
        await this.head.assertHeadRegularFile(relativePath);
      } catch (cause) {
        if (!isNotFound(cause)) throw cause;
      } finally {
        await closeQuietly(existing);
        existing = undefined;
      }

      temporary = await open(descriptorPath(parent, temporaryName), temporaryFlags, 0o600);
      let info = await temporary.stat();
      if (!info.isFile() || info.nlink !== 1) throw corrupt("Registry temporary file is unsafe", relativePath);
      await temporary.chmod(0o600);
      await temporary.writeFile(contents, "utf8");
      await temporary.sync();
      await temporary.close();
      temporary = undefined;

      await rename(descriptorPath(parent, temporaryName), descriptorPath(parent, leaf));
      published = await open(descriptorPath(parent, leaf), readFlags);
      info = await published.stat();
      if (!info.isFile() || info.nlink !== 1 || await published.readFile("utf8") !== contents) {
        throw corrupt("Published Registry record failed final verification", relativePath);
      }
      await published.close();
      published = undefined;
      await parent.sync();
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw corrupt("Registry record could not be written safely", relativePath);
    } finally {
      await closeQuietly(existing);
      await closeQuietly(temporary);
      await closeQuietly(published);
      if (parent) await unlink(descriptorPath(parent, temporaryName)).catch(() => undefined);
      if (parent !== root) await closeQuietly(parent);
      await closeQuietly(root);
    }
  }

  private async openRoot(): Promise<FileHandle> {
    if (!isAbsolute(this.configuredRoot)) {
      throw new ControlError("UNSAFE_REGISTRY_PATH", "Registry root must be absolute");
    }
    const target = resolve(this.configuredRoot);
    const filesystemRoot = parse(target).root;
    let current: FileHandle | undefined;
    try {
      current = await open(filesystemRoot, directoryFlags);
      for (const component of relative(filesystemRoot, target).split(sep).filter(Boolean)) {
        const next = await open(descriptorPath(current, component), directoryFlags);
        const info = await next.stat();
        if (!info.isDirectory()) {
          await next.close();
          throw corrupt("Registry root contains a non-directory component");
        }
        await current.close();
        current = next;
      }
      if (!(await current.stat()).isDirectory()) throw corrupt("Registry root is not a directory");
      return current;
    } catch (cause) {
      await closeQuietly(current);
      if (cause instanceof ControlError) throw cause;
      throw corrupt("Registry root contains a symbolic or unavailable component");
    }
  }

  private async openParent(root: FileHandle, components: readonly string[], create: boolean): Promise<FileHandle | undefined> {
    let current = root;
    for (const component of components) {
      let next: FileHandle;
      try {
        next = await open(descriptorPath(current, component), directoryFlags);
      } catch (cause) {
        if (!isNotFound(cause)) throw corrupt("Registry path contains a symbolic or non-directory ancestor");
        if (!create) {
          if (current !== root) await current.close();
          return undefined;
        }
        try {
          await mkdir(descriptorPath(current, component), { mode: 0o700 });
          await current.sync();
          next = await open(descriptorPath(current, component), directoryFlags);
        } catch {
          throw corrupt("Registry directory could not be created safely");
        }
      }
      const info = await next.stat();
      if (!info.isDirectory()) {
        await next.close();
        throw corrupt("Registry path contains a non-directory ancestor");
      }
      if (current !== root) await current.close();
      current = next;
    }
    return current;
  }
}

// Legacy path helpers remain temporarily for non-Registry callers while the
// claim/Handoff slices are moved onto RegistryRecordStore under their own REDs.
export async function readRecord<T>(path: string, schema: ZodType<T>): Promise<T> {
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    const result = schema.safeParse(parsed);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ControlError("INVALID_RECORD", `Invalid Registry record: ${path}`, { path, cause: message });
  }
}

export async function writeRecord(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
